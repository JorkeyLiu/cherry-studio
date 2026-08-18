import { describe, expect, it } from 'vitest'

import {
  aggregateSpanDurations,
  appendPhaseRecord,
  ECHO_REQUIRED_PHASE_STAGES,
  PHASE_ATTR_MAX_RECORDS,
  type PhaseStage,
  type PhaseState,
  resetPhaseState,
  resolvePhaseAttrGate,
  TOPIC_REQUIRED_PHASE_STAGES,
  VALID_CLOSED_STAGES,
  validatePhaseRecords
} from '../phaseAttr'

const record = (stage: PhaseStage) => ({
  correlationId: 'c1' as const,
  path: 'echo' as const,
  stage,
  clock: 'renderer' as const,
  durationMs: 1
})

function createState(): PhaseState {
  return { enabled: true, records: [], overflowed: false, activeCorrelationId: 'c1', activePath: 'echo' }
}

describe('phase diagnostics shared primitives', () => {
  it('is disabled for empty input and rejects malformed values', () => {
    expect(resolvePhaseAttrGate(undefined)).toBe(false)
    expect(resolvePhaseAttrGate('')).toBe(false)
    expect(resolvePhaseAttrGate('true')).toBe(true)
    expect(() => resolvePhaseAttrGate('0')).toThrow(/PERF_PHASE_ATTR/)
  })

  it('keeps a bounded ring and marks overflow', () => {
    const state = createState()
    for (let index = 0; index < PHASE_ATTR_MAX_RECORDS + 1; index++)
      appendPhaseRecord(state, record('echo.userDispatch'))
    expect(state.records).toHaveLength(PHASE_ATTR_MAX_RECORDS)
    expect(state.overflowed).toBe(true)
  })

  it('clears records, overflow, and active correlation', () => {
    const state = createState()
    appendPhaseRecord(state, record('echo.userDispatch'))
    state.overflowed = true
    resetPhaseState(state)
    expect(state.records).toEqual([])
    expect(state.overflowed).toBe(false)
    expect(state.activeCorrelationId).toBeUndefined()
  })

  it('rejects invalid labels, clock, and correlation without enforcing global order', () => {
    const state = createState()
    state.records.push({ ...record('echo.domEndpoint'), clock: 'main' })
    expect(
      validatePhaseRecords(state, {
        correlationId: 'c1',
        path: 'echo',
        requiredStages: ['echo.userDispatch', 'echo.domEndpoint'],
        expectedClock: 'renderer'
      }).join('\n')
    ).toMatch(/missing required stage|invalid clock|invalid stage/)
  })

  it('validates causal order only when explicitly provided', () => {
    // Stages in reverse order — no causalOrder => no order error
    const state = createState()
    state.records.push(record('echo.domEndpoint'))
    state.records.push(record('echo.userDispatch'))
    const noOrder = validatePhaseRecords(state, {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.userDispatch', 'echo.domEndpoint'],
      expectedClock: 'renderer'
    })
    expect(noOrder.some((p) => p.includes('order'))).toBe(false)

    // With causalOrder that is violated => order error
    const withOrder = validatePhaseRecords(state, {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.userDispatch', 'echo.domEndpoint'],
      expectedClock: 'renderer',
      causalOrder: ['echo.userDispatch', 'echo.domEndpoint']
    })
    expect(withOrder.some((p) => p.includes('causal order'))).toBe(true)
  })

  it('multiplicityStages allows render spans to appear multiple times', () => {
    const state = createState()
    state.records.push(record('echo.visibleGroupModel'))
    state.records.push(record('echo.visibleGroupModel'))
    // Without multiplicityStages: duplicate is rejected
    const noMulti = validatePhaseRecords(state, {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.visibleGroupModel'],
      expectedClock: 'renderer'
    })
    expect(noMulti.some((p) => p.includes('duplicate'))).toBe(true)

    // With multiplicityStages: duplicate is allowed
    const withMulti = validatePhaseRecords(state, {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.visibleGroupModel'],
      expectedClock: 'renderer',
      multiplicityStages: ['echo.visibleGroupModel']
    })
    expect(withMulti.some((p) => p.includes('duplicate'))).toBe(false)
  })

  it('truly singular stages still rejected on duplicate even with multiplicityStages', () => {
    const state = createState()
    state.records.push(record('echo.domEndpoint'))
    state.records.push(record('echo.domEndpoint'))
    const problems = validatePhaseRecords(state, {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.domEndpoint'],
      expectedClock: 'renderer',
      multiplicityStages: ['echo.visibleGroupModel']
    })
    expect(problems.some((p) => p.includes("duplicate stage 'echo.domEndpoint'"))).toBe(true)
  })

  it('echo required stages do not include topic.activation', () => {
    expect(ECHO_REQUIRED_PHASE_STAGES).not.toContain('topic.activation')
  })

  it('topic required stages do not include topic.activation', () => {
    expect(TOPIC_REQUIRED_PHASE_STAGES).not.toContain('topic.activation')
  })

  it('write-time closed stage enforcement rejects unknown stages', () => {
    const state = createState()
    appendPhaseRecord(state, record('echo.userDispatch'))
    // Cast invalid labels at the test boundary to verify runtime rejection
    // without weakening production closed typing.
    appendPhaseRecord(state, record('topic.activation' as PhaseStage)) // not in closed union
    appendPhaseRecord(state, record('unknown.stage' as PhaseStage))
    // Only the valid stage was recorded; invalid stages were silently rejected.
    expect(state.records).toHaveLength(1)
    expect(state.records[0].stage).toBe('echo.userDispatch')
  })

  it('VALID_CLOSED_STAGES contains all echo and topic required stages', () => {
    for (const stage of ECHO_REQUIRED_PHASE_STAGES) {
      expect(VALID_CLOSED_STAGES.has(stage), `VALID_CLOSED_STAGES must contain ${stage}`).toBe(true)
    }
    for (const stage of TOPIC_REQUIRED_PHASE_STAGES) {
      expect(VALID_CLOSED_STAGES.has(stage), `VALID_CLOSED_STAGES must contain ${stage}`).toBe(true)
    }
  })

  it('VALID_CLOSED_STAGES contains the main-clock echo.mainAppend stage', () => {
    expect(VALID_CLOSED_STAGES.has('echo.mainAppend')).toBe(true)
  })

  it('PhaseStage type is derived from the closed union', () => {
    // This is a compile-time check — if PhaseStage is correct, these
    // assignments will compile. At runtime we verify the type exists.
    const echoStage: PhaseStage = 'echo.userDispatch'
    const topicStage: PhaseStage = 'topic.domEndpoint'
    const mainStage: PhaseStage = 'echo.mainAppend'
    expect(echoStage).toBeTruthy()
    expect(topicStage).toBeTruthy()
    expect(mainStage).toBeTruthy()
  })

  it('independent closed-union enforcement rejects stages outside the union even when caller allows them', () => {
    const state = createState()
    // Manually push a record with an invalid stage (bypasses write-time enforcement)
    state.records.push({
      correlationId: 'c1',
      path: 'echo',
      stage: 'echo.customStage' as PhaseStage,
      clock: 'renderer',
      durationMs: 1
    })
    const problems = validatePhaseRecords(state, {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.userDispatch', 'echo.customStage' as PhaseStage],
      expectedClock: 'renderer'
    })
    expect(problems.some((p) => p.includes('not in closed union'))).toBe(true)
  })
})

describe('span aggregation helpers', () => {
  it('aggregates present stages into sum and count', () => {
    const state = createState()
    state.records.push({ ...record('echo.sharedContextInfo'), durationMs: 10 })
    state.records.push({ ...record('echo.visibleGroupModel'), durationMs: 5 })
    state.records.push({ ...record('echo.userDispatch'), durationMs: 3 })
    const result = aggregateSpanDurations(state, 'c1', [
      'echo.sharedContextInfo',
      'echo.visibleGroupModel',
      'echo.userDispatch'
    ])
    expect(result.sumMs).toBe(18)
    expect(result.count).toBe(3)
  })

  it('skips missing stages without error', () => {
    const state = createState()
    state.records.push({ ...record('echo.sharedContextInfo'), durationMs: 10 })
    const result = aggregateSpanDurations(state, 'c1', [
      'echo.sharedContextInfo',
      'echo.visibleGroupModel',
      'echo.userDispatch'
    ])
    expect(result.sumMs).toBe(10)
    expect(result.count).toBe(1)
  })

  it('returns zero sum and count for empty records', () => {
    const state = createState()
    const result = aggregateSpanDurations(state, 'c1', ['echo.sharedContextInfo'])
    expect(result.sumMs).toBe(0)
    expect(result.count).toBe(0)
  })
})
