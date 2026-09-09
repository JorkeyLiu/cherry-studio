import { describe, expect, it } from 'vitest'

import {
  aggregateWindowLifecycleStages,
  assertExactPhaseSampleCount,
  collectWindowLifecycleAggregate,
  deriveEchoPhaseMetrics,
  deriveTopicPhaseMetrics,
  ECHO_MULTIPLICITY_STAGES,
  ECHO_REQUIRED_PHASE_STAGES,
  ECHO_WINDOW_STAGES,
  ECHO_VALIDATION_REQUIRED_STAGES,
  isStageInClosedUnion,
  phaseAttrEnabled,
  phaseDuration,
  phaseDurations,
  type PhaseRecord,
  type PhaseState,
  type PhaseStage,
  sampleCorrelationId,
  TOPIC_MULTIPLICITY_STAGES,
  TOPIC_REQUIRED_PHASE_STAGES,
  TOPIC_WINDOW_STAGES,
  TOPIC_VALIDATION_REQUIRED_STAGES,
  type FrozenPhaseSnapshot,
  validateEchoPhaseSnapshot,
  validatePhaseRecordSet,
  validatePhaseSample,
  validateTopicPhaseSnapshot,
  VALID_CLOSED_STAGES,
  VALID_CLOSED_STAGES_ARRAY
} from './perfPhaseAttribution'

function state(records: PhaseRecord[], overflowed = false): PhaseState {
  return { enabled: true, records, overflowed }
}

function record(stage: PhaseStage, correlationId = 'c1', path: PhaseRecord['path'] = 'echo'): PhaseRecord {
  return { correlationId, path, stage, clock: 'renderer', durationMs: 1 }
}

function frozenSnapshot(
  correlationId: string,
  path: PhaseRecord['path'],
  records: PhaseRecord[],
  overflowed = false
): FrozenPhaseSnapshot {
  return {
    correlationId,
    path,
    state: { enabled: true, records: [...records], overflowed }
  }
}

describe('phaseAttrEnabled', () => {
  it('is default-off', () => {
    const previous = process.env.PERF_PHASE_ATTR
    delete process.env.PERF_PHASE_ATTR
    try {
      expect(phaseAttrEnabled()).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.PERF_PHASE_ATTR
      else process.env.PERF_PHASE_ATTR = previous
    }
  })

  it('accepts only the enabled values', () => {
    const previous = process.env.PERF_PHASE_ATTR
    try {
      process.env.PERF_PHASE_ATTR = 'true'
      expect(phaseAttrEnabled()).toBe(true)
      process.env.PERF_PHASE_ATTR = '0'
      expect(() => phaseAttrEnabled()).toThrow(/PERF_PHASE_ATTR/)
    } finally {
      if (previous === undefined) delete process.env.PERF_PHASE_ATTR
      else process.env.PERF_PHASE_ATTR = previous
    }
  })
})

describe('strict phase record adapters', () => {
  it('accepts an exact ordered sample', () => {
    const records = ECHO_REQUIRED_PHASE_STAGES.map((stage) => record(stage))
    expect(
      validatePhaseRecordSet(state(records), {
        correlationId: 'c1',
        path: 'echo',
        requiredStages: ECHO_REQUIRED_PHASE_STAGES,
        expectedClock: 'renderer'
      })
    ).toEqual([])
  })

  it('rejects missing, duplicate, unknown, mismatched, and invalid records', () => {
    const records: PhaseRecord[] = [
      record(ECHO_REQUIRED_PHASE_STAGES[0]),
      record(ECHO_REQUIRED_PHASE_STAGES[0]),
      record('unknown' as PhaseStage),
      { ...record(ECHO_REQUIRED_PHASE_STAGES[1]), correlationId: 'wrong' },
      { ...record(ECHO_REQUIRED_PHASE_STAGES[2]), durationMs: Number.NaN }
    ]
    const problems = validatePhaseRecordSet(state(records), {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ECHO_REQUIRED_PHASE_STAGES,
      expectedClock: 'renderer'
    })
    expect(problems.join('\n')).toMatch(/missing required stage/)
    expect(problems.join('\n')).toMatch(/duplicate stage/)
    expect(problems.join('\n')).toMatch(/not in closed union/)
    expect(problems.join('\n')).toMatch(/correlation mismatch/)
    expect(problems.join('\n')).toMatch(/duration invalid/)
  })

  it('rejects overflow and main/renderer clock mismatches', () => {
    const problems = validatePhaseSample(
      state(
        ECHO_REQUIRED_PHASE_STAGES.map((stage) => record(stage)),
        true
      ),
      state([record('echo.mainAppend')]),
      {
        correlationId: 'c1',
        path: 'echo',
        rendererRequiredStages: ECHO_REQUIRED_PHASE_STAGES,
        mainRequiredStages: ['echo.mainAppend']
      }
    )
    expect(problems).toContain('phase ring buffer overflowed')
    expect(problems).toContain('record[0] invalid clock')
  })

  it('supports optional stage groups without allowing unknown stages', () => {
    const records = TOPIC_REQUIRED_PHASE_STAGES.map((stage) => record(stage, 'c1', 'topic-cache-hit'))
    expect(
      validatePhaseRecordSet(state(records), {
        correlationId: 'c1',
        path: 'topic-cache-hit',
        requiredStages: TOPIC_REQUIRED_PHASE_STAGES,
        requiredStageGroups: [['topic.windowApply', 'topic.windowReconcile']],
        expectedClock: 'renderer'
      })
    ).toEqual([])
  })

  it('accepts the prehydrated cache-hit path without a fetch-only proxy stage', () => {
    const stages = [...TOPIC_REQUIRED_PHASE_STAGES]
    const records = stages.map((stage) => record(stage, 'c1', 'topic-cache-hit'))
    expect(
      validatePhaseSample(state(records), undefined, {
        correlationId: 'c1',
        path: 'topic-cache-hit',
        rendererRequiredStages: stages
      })
    ).toEqual([])
  })

  it('fails closed when a page/electronApp retrieval is unavailable', () => {
    expect(
      validatePhaseSample(undefined, undefined, {
        correlationId: 'c1',
        path: 'echo',
        rendererRequiredStages: ECHO_REQUIRED_PHASE_STAGES
      }).join('\n')
    ).toMatch(/diagnostic state retrieval failed/)
  })

  it('does not enforce global order — React render multiplicity accepted', () => {
    const records = [
      record('echo.userAppendIpc'),
      record('echo.userDispatch'),
      record('echo.domEndpoint'),
      record('echo.visibleGroupModel'),
      record('echo.sharedContextInfo'),
      record('echo.windowCreate')
    ]
    const problems = validatePhaseRecordSet(state(records), {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ECHO_REQUIRED_PHASE_STAGES,
      expectedClock: 'renderer'
    })
    expect(problems.some((p) => p.includes('order'))).toBe(false)
  })

  it('validates causal order only when explicitly provided', () => {
    const records = [record('echo.domEndpoint'), record('echo.userDispatch')]
    const noOrder = validatePhaseRecordSet(state(records), {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.userDispatch', 'echo.domEndpoint'],
      expectedClock: 'renderer'
    })
    expect(noOrder.some((p) => p.includes('order'))).toBe(false)

    const withOrder = validatePhaseRecordSet(state(records), {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.userDispatch', 'echo.domEndpoint'],
      expectedClock: 'renderer',
      causalOrder: ['echo.userDispatch', 'echo.domEndpoint']
    })
    expect(withOrder.some((p) => p.includes('causal order'))).toBe(true)
  })
})

describe('phase adapters', () => {
  it('reads exact stage durations in record order', () => {
    const records = ECHO_REQUIRED_PHASE_STAGES.map((stage, index) => ({
      ...record(stage),
      durationMs: index + 1
    }))
    expect(phaseDuration({ records }, ECHO_REQUIRED_PHASE_STAGES[2])).toBe(3)
    expect(phaseDurations({ records }, ECHO_REQUIRED_PHASE_STAGES.slice(0, 2))).toEqual([1, 2])
  })

  it('uses opaque deterministic sample correlation ids', () => {
    expect(sampleCorrelationId('p103', 2)).toBe('p103-sample-2')
    expect(sampleCorrelationId('p103', 2)).not.toContain('message')
  })
})

describe('real adapter derivation behavior', () => {
  it('echo required stages are a closed set — no topic.activation', () => {
    expect(ECHO_REQUIRED_PHASE_STAGES).toContain('echo.domEndpoint')
    expect(ECHO_REQUIRED_PHASE_STAGES).not.toContain('topic.activation')
  })

  it('topic required stages are a closed set — no topic.activation', () => {
    expect(TOPIC_REQUIRED_PHASE_STAGES).toContain('topic.domEndpoint')
    expect(TOPIC_REQUIRED_PHASE_STAGES).not.toContain('topic.activation')
  })

  it('post-endpoint records are rejected by stage validation', () => {
    const records = [
      ...ECHO_REQUIRED_PHASE_STAGES.map((stage) => record(stage)),
      record('echo.postEndpointWork' as PhaseStage)
    ]
    const problems = validatePhaseRecordSet(state(records), {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ECHO_REQUIRED_PHASE_STAGES,
      expectedClock: 'renderer'
    })
    expect(problems.some((p) => p.includes('not in closed union'))).toBe(true)
  })

  it('cache-miss and cache-hit use separate path validation', () => {
    const missRecords = TOPIC_REQUIRED_PHASE_STAGES.map((stage) => record(stage, 'c1', 'topic-cache-miss'))
    const hitRecords = TOPIC_REQUIRED_PHASE_STAGES.map((stage) => record(stage, 'c2', 'topic-cache-hit'))

    const missProblems = validatePhaseRecordSet(state(missRecords), {
      correlationId: 'c1',
      path: 'topic-cache-miss',
      requiredStages: TOPIC_REQUIRED_PHASE_STAGES,
      expectedClock: 'renderer'
    })
    expect(missProblems).toEqual([])

    const mixedProblems = validatePhaseRecordSet(state(hitRecords), {
      correlationId: 'c1',
      path: 'topic-cache-miss',
      requiredStages: TOPIC_REQUIRED_PHASE_STAGES,
      expectedClock: 'renderer'
    })
    expect(mixedProblems.some((p) => p.includes('path mismatch'))).toBe(true)
  })

  it('exact per-path sample counts enforced by correlation ID scoping', () => {
    const sample0 = TOPIC_REQUIRED_PHASE_STAGES.map((stage) =>
      record(stage, 'p101ch-miss-sample-0', 'topic-cache-miss')
    )
    const sample1 = TOPIC_REQUIRED_PHASE_STAGES.map((stage) =>
      record(stage, 'p101ch-miss-sample-1', 'topic-cache-miss')
    )

    const combinedProblems = validatePhaseRecordSet(state([...sample0, ...sample1]), {
      correlationId: 'p101ch-miss-sample-0',
      path: 'topic-cache-miss',
      requiredStages: TOPIC_REQUIRED_PHASE_STAGES,
      expectedClock: 'renderer'
    })
    expect(combinedProblems.some((p) => p.includes('correlation mismatch'))).toBe(true)

    const p0 = validatePhaseRecordSet(state(sample0), {
      correlationId: 'p101ch-miss-sample-0',
      path: 'topic-cache-miss',
      requiredStages: TOPIC_REQUIRED_PHASE_STAGES,
      expectedClock: 'renderer'
    })
    expect(p0).toEqual([])

    const p1 = validatePhaseRecordSet(state(sample1), {
      correlationId: 'p101ch-miss-sample-1',
      path: 'topic-cache-miss',
      requiredStages: TOPIC_REQUIRED_PHASE_STAGES,
      expectedClock: 'renderer'
    })
    expect(p1).toEqual([])
  })

  it('render-stage multiplicity accepted with multiplicityStages option', () => {
    const records = [
      record('echo.userAppendIpc'),
      record('echo.userDispatch'),
      record('echo.visibleGroupModel'),
      record('echo.visibleGroupModel')
    ]
    const problems = validatePhaseRecordSet(state(records), {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.userAppendIpc', 'echo.userDispatch', 'echo.visibleGroupModel'],
      expectedClock: 'renderer',
      multiplicityStages: ['echo.visibleGroupModel']
    })
    expect(problems.some((p) => p.includes('duplicate'))).toBe(false)
  })

  it('truly singular stages still rejected on duplicate', () => {
    const records = [record('echo.domEndpoint'), record('echo.domEndpoint')]
    const problems = validatePhaseRecordSet(state(records), {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.domEndpoint'],
      expectedClock: 'renderer',
      multiplicityStages: ['echo.visibleGroupModel']
    })
    expect(problems.some((p) => p.includes("duplicate stage 'echo.domEndpoint'"))).toBe(true)
  })
})

describe('window lifecycle multi-stage aggregation', () => {
  it('aggregates all matching window lifecycle stages', () => {
    const records = [
      record('topic.messagesMount', 'c1', 'topic-cache-miss'),
      record('topic.windowReset', 'c1', 'topic-cache-miss'),
      record('topic.windowApply', 'c1', 'topic-cache-miss'),
      record('topic.windowReconcile', 'c1', 'topic-cache-miss'),
      record('topic.contextInfo', 'c1', 'topic-cache-miss'),
      record('topic.visibleGroupModel', 'c1', 'topic-cache-miss'),
      record('topic.domEndpoint', 'c1', 'topic-cache-miss')
    ]
    records[1].durationMs = 2
    records[2].durationMs = 3
    records[3].durationMs = 4

    const windowStages = ['topic.windowReset', 'topic.windowApply', 'topic.windowReconcile']
    const result = aggregateWindowLifecycleStages(state(records), 'c1', windowStages)
    expect(result.count).toBe(3)
    expect(result.totalDurationMs).toBe(9)
    expect(result.stages).toHaveLength(3)
    expect(result.stages.map((s) => s.stage)).toEqual([
      'topic.windowReset',
      'topic.windowApply',
      'topic.windowReconcile'
    ])
    // Each stage appears once — count is 1 per stage
    for (const s of result.stages) {
      expect(s.count).toBe(1)
    }
  })

  it('returns zero for no matching window stages', () => {
    const records = [record('topic.messagesMount', 'c1', 'topic-cache-miss')]
    const windowStages = ['topic.windowReset', 'topic.windowApply', 'topic.windowReconcile']
    const result = aggregateWindowLifecycleStages(state(records), 'c1', windowStages)
    expect(result.count).toBe(0)
    expect(result.totalDurationMs).toBe(0)
    expect(result.stages).toHaveLength(0)
  })

  it('handles partial window stages (only some present)', () => {
    const records = [
      record('topic.windowReset', 'c1', 'topic-cache-miss'),
      record('topic.windowReconcile', 'c1', 'topic-cache-miss')
    ]
    records[0].durationMs = 5
    records[1].durationMs = 7
    const windowStages = ['topic.windowReset', 'topic.windowApply', 'topic.windowReconcile']
    const result = aggregateWindowLifecycleStages(state(records), 'c1', windowStages)
    expect(result.count).toBe(2)
    expect(result.totalDurationMs).toBe(12)
  })

  it('handles echo window stages (windowCreate + windowReconcile)', () => {
    const records = [record('echo.windowCreate', 'c1', 'echo'), record('echo.windowReconcile', 'c1', 'echo')]
    records[0].durationMs = 10
    records[1].durationMs = 8
    const windowStages = ['echo.windowCreate', 'echo.windowReconcile']
    const result = aggregateWindowLifecycleStages(state(records), 'c1', windowStages)
    expect(result.count).toBe(2)
    expect(result.totalDurationMs).toBe(18)
  })

  it('sums all occurrences of the same stage (repeated same-stage records)', () => {
    const records = [
      { ...record('echo.windowCreate', 'c1', 'echo'), durationMs: 3 },
      { ...record('echo.windowCreate', 'c1', 'echo'), durationMs: 5 },
      { ...record('echo.windowReconcile', 'c1', 'echo'), durationMs: 7 }
    ]
    const result = aggregateWindowLifecycleStages(state(records), 'c1', ['echo.windowCreate', 'echo.windowReconcile'])
    expect(result.count).toBe(3) // 2 windowCreate + 1 windowReconcile
    expect(result.totalDurationMs).toBe(15) // 3 + 5 + 7
    const windowCreate = result.stages.find((s) => s.stage === 'echo.windowCreate')!
    expect(windowCreate.durationMs).toBe(8) // 3 + 5 summed
    expect(windowCreate.count).toBe(2)
    const windowReconcile = result.stages.find((s) => s.stage === 'echo.windowReconcile')!
    expect(windowReconcile.durationMs).toBe(7)
    expect(windowReconcile.count).toBe(1)
  })
})

describe('collectWindowLifecycleAggregate', () => {
  it('returns detailed aggregate with total recorded stages', () => {
    const records = [
      record('topic.messagesMount', 'c1', 'topic-cache-miss'),
      record('topic.windowApply', 'c1', 'topic-cache-miss'),
      record('topic.contextInfo', 'c1', 'topic-cache-miss'),
      record('topic.visibleGroupModel', 'c1', 'topic-cache-miss'),
      record('topic.domEndpoint', 'c1', 'topic-cache-miss')
    ]
    records[0].durationMs = 10
    records[1].durationMs = 5
    records[2].durationMs = 8
    records[3].durationMs = 3
    records[4].durationMs = 15

    const windowStages = ['topic.windowReset', 'topic.windowApply', 'topic.windowReconcile']
    const result = collectWindowLifecycleAggregate(state(records), 'c1', windowStages)
    expect(result.count).toBe(1)
    expect(result.totalDurationMs).toBe(5)
    expect(result.totalRecordedStages).toBe(5)
    expect(result.totalRecordedDurationMs).toBe(41)
  })
})

describe('VALID_CLOSED_STAGES', () => {
  it('contains all echo and topic required stages', () => {
    for (const stage of ECHO_REQUIRED_PHASE_STAGES) {
      expect(VALID_CLOSED_STAGES.has(stage), `should contain ${stage}`).toBe(true)
    }
    for (const stage of TOPIC_REQUIRED_PHASE_STAGES) {
      expect(VALID_CLOSED_STAGES.has(stage), `should contain ${stage}`).toBe(true)
    }
  })

  it('contains echo.mainAppend', () => {
    expect(VALID_CLOSED_STAGES.has('echo.mainAppend')).toBe(true)
  })

  it('does not contain topic.activation', () => {
    expect((VALID_CLOSED_STAGES as Set<string>).has('topic.activation')).toBe(false)
  })

  it('VALID_CLOSED_STAGES_ARRAY matches VALID_CLOSED_STAGES set', () => {
    expect(VALID_CLOSED_STAGES_ARRAY.length).toBe(VALID_CLOSED_STAGES.size)
    for (const stage of VALID_CLOSED_STAGES_ARRAY) {
      expect(VALID_CLOSED_STAGES.has(stage)).toBe(true)
    }
  })
})

describe('PhaseStage type and closed-union enforcement', () => {
  it('PhaseStage is assignable from all required stages', () => {
    const echoStage: PhaseStage = 'echo.userDispatch'
    const topicStage: PhaseStage = 'topic.domEndpoint'
    const mainStage: PhaseStage = 'echo.mainAppend'
    expect(echoStage).toBeTruthy()
    expect(topicStage).toBeTruthy()
    expect(mainStage).toBeTruthy()
  })

  it('isStageInClosedUnion accepts valid stages', () => {
    expect(isStageInClosedUnion('echo.userDispatch')).toBe(true)
    expect(isStageInClosedUnion('topic.domEndpoint')).toBe(true)
    expect(isStageInClosedUnion('echo.mainAppend')).toBe(true)
  })

  it('isStageInClosedUnion rejects invalid stages', () => {
    expect(isStageInClosedUnion('topic.activation')).toBe(false)
    expect(isStageInClosedUnion('unknown.stage')).toBe(false)
    expect(isStageInClosedUnion('echo.postEndpointWork')).toBe(false)
  })

  it('independent closed-union validation rejects stages outside the union even when caller allows them', () => {
    const records: PhaseRecord[] = [
      record('echo.userDispatch'),
      { ...record('echo.userDispatch'), stage: 'echo.customStage' as PhaseStage }
    ]
    // Caller's requiredStages includes echo.customStage — but the
    // independent closed-union check should still reject it.
    const problems = validatePhaseRecordSet(state(records), {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.userDispatch', 'echo.customStage' as PhaseStage],
      expectedClock: 'renderer'
    })
    expect(problems.some((p) => p.includes('not in closed union'))).toBe(true)
  })
})

describe('FrozenPhaseSnapshot', () => {
  it('snapshot is detached from live state mutations', () => {
    const liveRecords: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 }
    ]
    const snapshot = frozenSnapshot('c1', 'echo', liveRecords)
    // Mutate the live records after snapshot
    liveRecords.push({
      correlationId: 'c1',
      path: 'echo',
      stage: 'echo.domEndpoint',
      clock: 'renderer',
      durationMs: 2
    })
    // Snapshot should not be affected
    expect(snapshot.state.records).toHaveLength(1)
    expect(snapshot.state.records[0]!.stage).toBe('echo.userDispatch')
  })

  it('frozen snapshot state is read-only', () => {
    const snapshot = frozenSnapshot('c1', 'echo', [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 }
    ])
    // The readonly type prevents direct mutation at compile time
    expect(snapshot.state.records).toHaveLength(1)
    expect(snapshot.correlationId).toBe('c1')
    expect(snapshot.path).toBe('echo')
  })

  it('post-endpoint records do not enter the frozen sample', () => {
    // Simulate: records before close = [userDispatch, domEndpoint]
    // Records after close (assistant work) = [assistantRender]
    const preCloseRecords: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 2 }
    ]
    const snapshot = frozenSnapshot('c1', 'echo', preCloseRecords)
    // Validation should pass — only pre-close records are in the snapshot
    const problems = validatePhaseRecordSet(snapshot.state, {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ['echo.userDispatch', 'echo.domEndpoint'],
      expectedClock: 'renderer'
    })
    expect(problems).toEqual([])
  })
})

describe('exact-count gates (LOCK-2A-011)', () => {
  it('assertExactPhaseSampleCount passes when counts match', () => {
    expect(() => assertExactPhaseSampleCount(20, 20, 'echo')).not.toThrow()
  })

  it('assertExactPhaseSampleCount throws when counts mismatch', () => {
    expect(() => assertExactPhaseSampleCount(18, 20, 'echo')).toThrow(
      /echo phase sample count mismatch: expected 20, got 18/
    )
  })

  it('assertExactPhaseSampleCount throws for zero when expected is nonzero', () => {
    expect(() => assertExactPhaseSampleCount(0, 20, 'cache-miss')).toThrow(
      /cache-miss phase sample count mismatch: expected 20, got 0/
    )
  })
})

describe('deriveEchoPhaseMetrics', () => {
  it('derives all metric values from snapshot records', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userAppendIpc', clock: 'renderer', durationMs: 3 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 5 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.sharedContextInfo', clock: 'renderer', durationMs: 9 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.windowCreate', clock: 'renderer', durationMs: 4 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 6 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 10 }
    ]
    const metrics = deriveEchoPhaseMetrics(state(records), 'c1')
    expect(metrics.userActionSpanMs).toBe(8) // 3 + 5
    expect(metrics.renderComputationSpanMs).toBe(15) // 9 + 6
    expect(metrics.windowLifecycleSpanMs).toBe(4) // windowCreate=4
    expect(metrics.windowLifecycleStageCount).toBe(1)
    expect(metrics.domEndpointMs).toBe(10)
    expect(metrics.totalSpanMs).toBe(37) // 8 + 15 + 4 + 10
  })

  it('handles no window lifecycle stages', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userAppendIpc', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 2 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.sharedContextInfo', clock: 'renderer', durationMs: 7 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 5 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 6 }
    ]
    const metrics = deriveEchoPhaseMetrics(state(records), 'c1')
    expect(metrics.windowLifecycleSpanMs).toBe(0)
    expect(metrics.windowLifecycleStageCount).toBe(0)
    expect(metrics.totalSpanMs).toBe(21) // 1+2+7+5+6
  })
})

describe('deriveTopicPhaseMetrics', () => {
  it('derives all metric values from snapshot records', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.messagesMount', clock: 'renderer', durationMs: 4 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.windowReset', clock: 'renderer', durationMs: 2 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.windowApply', clock: 'renderer', durationMs: 3 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.contextInfo', clock: 'renderer', durationMs: 5 },
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.visibleGroupModel',
        clock: 'renderer',
        durationMs: 6
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.domEndpoint', clock: 'renderer', durationMs: 8 }
    ]
    const metrics = deriveTopicPhaseMetrics(state(records), 'c1', 'topic-cache-miss')
    expect(metrics.renderComputationSpanMs).toBe(15) // 4 + 5 + 6
    expect(metrics.windowLifecycleSpanMs).toBe(5) // 2 + 3
    expect(metrics.windowLifecycleStageCount).toBe(2)
    expect(metrics.domEndpointMs).toBe(8)
    expect(metrics.totalSpanMs).toBe(28) // 15 + 5 + 8
  })
})

describe('validateEchoPhaseSnapshot', () => {
  it('passes for a complete echo snapshot', () => {
    // ECHO_VALIDATION_REQUIRED_STAGES excludes window stages; window stages
    // are a required group (at least one must be present).
    const records: PhaseRecord[] = ECHO_VALIDATION_REQUIRED_STAGES.map((stage) => ({
      correlationId: 'c1',
      path: 'echo' as const,
      stage,
      clock: 'renderer' as const,
      durationMs: 1
    }))
    // Add one window stage (required as a group — at least one must be present)
    records.push({
      correlationId: 'c1',
      path: 'echo',
      stage: 'echo.windowCreate',
      clock: 'renderer',
      durationMs: 1
    })
    // Add main state
    const mainState: PhaseState = {
      enabled: true,
      records: [{ correlationId: 'c1', path: 'echo', stage: 'echo.mainAppend', clock: 'main', durationMs: 1 }],
      overflowed: false
    }
    const snapshot = frozenSnapshot('c1', 'echo', records)
    const problems = validateEchoPhaseSnapshot(snapshot, mainState)
    expect(problems).toEqual([])
  })

  it('rejects snapshot with missing required stage', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 }
    ]
    const snapshot = frozenSnapshot('c1', 'echo', records)
    const problems = validateEchoPhaseSnapshot(snapshot, undefined)
    expect(problems.some((p) => p.includes('missing required stage'))).toBe(true)
  })
})

describe('validateTopicPhaseSnapshot', () => {
  it('passes for a complete topic snapshot', () => {
    // TOPIC_VALIDATION_REQUIRED_STAGES excludes window stages; window stages
    // are a required group (at least one must be present).
    const records: PhaseRecord[] = TOPIC_VALIDATION_REQUIRED_STAGES.map((stage) => ({
      correlationId: 'c1',
      path: 'topic-cache-miss' as const,
      stage,
      clock: 'renderer' as const,
      durationMs: 1
    }))
    // Add one window stage (required as a group — at least one must be present)
    records.push({
      correlationId: 'c1',
      path: 'topic-cache-miss',
      stage: 'topic.windowApply',
      clock: 'renderer',
      durationMs: 1
    })
    const snapshot = frozenSnapshot('c1', 'topic-cache-miss', records)
    const problems = validateTopicPhaseSnapshot(snapshot, 'topic-cache-miss')
    expect(problems).toEqual([])
  })
})

describe('phaseDuration sums all matching records (multiplicity)', () => {
  it('sums multiple records of the same stage', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 3 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 5 }
    ]
    expect(phaseDuration({ records }, 'echo.visibleGroupModel')).toBe(8)
  })

  it('returns single value for singular stage', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 10 }
    ]
    expect(phaseDuration({ records }, 'echo.domEndpoint')).toBe(10)
  })

  it('throws for missing stage', () => {
    const records: PhaseRecord[] = []
    expect(() => phaseDuration({ records }, 'echo.domEndpoint')).toThrow(/missing phase duration/)
  })

  it('throws for invalid duration in any matching record', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 3 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: NaN }
    ]
    expect(() => phaseDuration({ records }, 'echo.visibleGroupModel')).toThrow(/invalid duration/)
  })
})

describe('disabled path contract (no accumulators, no metrics)', () => {
  it('phaseAttrEnabled returns false in default test env', () => {
    // The e2e-utils test runs without PERF_PHASE_ATTR=1, so disabled is correct
    expect(phaseAttrEnabled()).toBe(false)
  })

  it('assertExactPhaseSampleCount rejects zero when expected is nonzero', () => {
    expect(() => assertExactPhaseSampleCount(0, 20, 'echo')).toThrow(
      /echo phase sample count mismatch: expected 20, got 0/
    )
  })

  it('assertExactPhaseSampleCount passes when both are zero', () => {
    expect(() => assertExactPhaseSampleCount(0, 0, 'echo')).not.toThrow()
  })
})

describe('enabled exact-count gate (LOCK-2A-011)', () => {
  it('derives correct metrics from a multiplicity sample', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userAppendIpc', clock: 'renderer', durationMs: 2 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 3 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.sharedContextInfo', clock: 'renderer', durationMs: 5 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 5 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 3 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.windowCreate', clock: 'renderer', durationMs: 6 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 8 }
    ]
    const metrics = deriveEchoPhaseMetrics(state(records), 'c1')
    // userAction: 2 + 3 = 5
    expect(metrics.userActionSpanMs).toBe(5)
    // renderComp: 5 + (5 + 3) = 13 (visibleGroupModel summed)
    expect(metrics.renderComputationSpanMs).toBe(13)
    // windowLifecycle: 6
    expect(metrics.windowLifecycleSpanMs).toBe(6)
    expect(metrics.windowLifecycleStageCount).toBe(1)
    // domEndpoint: 8
    expect(metrics.domEndpointMs).toBe(8)
    // totalSpan: 5 + 13 + 6 + 8 = 32
    expect(metrics.totalSpanMs).toBe(32)
  })
})

describe('echo multiplicity stage sets', () => {
  it('ECHO_MULTIPLICITY_STAGES contains sharedContextInfo, visibleGroupModel, and window stages', () => {
    expect(ECHO_MULTIPLICITY_STAGES).toContain('echo.sharedContextInfo')
    expect(ECHO_MULTIPLICITY_STAGES).toContain('echo.visibleGroupModel')
    expect(ECHO_MULTIPLICITY_STAGES).toContain('echo.windowCreate')
    expect(ECHO_MULTIPLICITY_STAGES).toContain('echo.windowReconcile')
  })

  it('ECHO_MULTIPLICITY_STAGES does NOT contain singular stages', () => {
    expect(ECHO_MULTIPLICITY_STAGES).not.toContain('echo.userAppendIpc')
    expect(ECHO_MULTIPLICITY_STAGES).not.toContain('echo.userDispatch')
    expect(ECHO_MULTIPLICITY_STAGES).not.toContain('echo.domEndpoint')
    expect(ECHO_MULTIPLICITY_STAGES).not.toContain('echo.mainAppend')
  })

  it('echo.sharedContextInfo is the single echo context stage in the closed union and multiplicity set', () => {
    // Positive single-stage coverage: exactly one echo context stage exists.
    const echoMultiplicityContextStages = ECHO_MULTIPLICITY_STAGES.filter((stage) => stage.includes('ContextInfo'))
    expect(echoMultiplicityContextStages).toEqual(['echo.sharedContextInfo'])
    const closedUnionContextStages = [...VALID_CLOSED_STAGES].filter((stage) => stage.includes('ContextInfo'))
    expect(closedUnionContextStages).toEqual(['echo.sharedContextInfo'])
  })

  it('validateEchoPhaseSnapshot accepts duplicate sharedContextInfo and visibleGroupModel', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userAppendIpc', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.sharedContextInfo', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.sharedContextInfo', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.windowCreate', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 1 }
    ]
    const mainState: PhaseState = {
      enabled: true,
      records: [{ correlationId: 'c1', path: 'echo', stage: 'echo.mainAppend', clock: 'main', durationMs: 1 }],
      overflowed: false
    }
    const snapshot = frozenSnapshot('c1', 'echo', records)
    const problems = validateEchoPhaseSnapshot(snapshot, mainState)
    expect(problems.some((p) => p.includes('duplicate'))).toBe(false)
  })

  it('validateEchoPhaseSnapshot rejects duplicate domEndpoint (singular)', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userAppendIpc', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.sharedContextInfo', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.windowCreate', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 1 }
    ]
    const snapshot = frozenSnapshot('c1', 'echo', records)
    const problems = validateEchoPhaseSnapshot(snapshot, undefined)
    expect(problems.some((p) => p.includes("duplicate stage 'echo.domEndpoint'"))).toBe(true)
  })

  it('validateEchoPhaseSnapshot rejects duplicate userDispatch (singular)', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userAppendIpc', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.sharedContextInfo', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.windowCreate', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 1 }
    ]
    const snapshot = frozenSnapshot('c1', 'echo', records)
    const problems = validateEchoPhaseSnapshot(snapshot, undefined)
    expect(problems.some((p) => p.includes("duplicate stage 'echo.userDispatch'"))).toBe(true)
  })
})

describe('topic multiplicity stage sets', () => {
  it('TOPIC_MULTIPLICITY_STAGES contains contextInfo, visibleGroupModel, and window stages', () => {
    expect(TOPIC_MULTIPLICITY_STAGES).toContain('topic.contextInfo')
    expect(TOPIC_MULTIPLICITY_STAGES).toContain('topic.visibleGroupModel')
    expect(TOPIC_MULTIPLICITY_STAGES).toContain('topic.windowReset')
    expect(TOPIC_MULTIPLICITY_STAGES).toContain('topic.windowApply')
    expect(TOPIC_MULTIPLICITY_STAGES).toContain('topic.windowReconcile')
  })

  it('TOPIC_MULTIPLICITY_STAGES does NOT contain singular stages', () => {
    expect(TOPIC_MULTIPLICITY_STAGES).not.toContain('topic.messagesMount')
    expect(TOPIC_MULTIPLICITY_STAGES).not.toContain('topic.domEndpoint')
  })

  it('validateTopicPhaseSnapshot accepts duplicate contextInfo and window stages', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.messagesMount', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.contextInfo', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.contextInfo', clock: 'renderer', durationMs: 1 },
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.visibleGroupModel',
        clock: 'renderer',
        durationMs: 1
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.windowReset', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.windowApply', clock: 'renderer', durationMs: 1 },
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.windowReconcile',
        clock: 'renderer',
        durationMs: 1
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.domEndpoint', clock: 'renderer', durationMs: 1 }
    ]
    const snapshot = frozenSnapshot('c1', 'topic-cache-miss', records)
    const problems = validateTopicPhaseSnapshot(snapshot, 'topic-cache-miss')
    expect(problems.some((p) => p.includes('duplicate'))).toBe(false)
  })

  it('validateTopicPhaseSnapshot rejects duplicate messagesMount (singular)', () => {
    const records: PhaseRecord[] = [
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.messagesMount', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.messagesMount', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.contextInfo', clock: 'renderer', durationMs: 1 },
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.visibleGroupModel',
        clock: 'renderer',
        durationMs: 1
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.windowApply', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.domEndpoint', clock: 'renderer', durationMs: 1 }
    ]
    const snapshot = frozenSnapshot('c1', 'topic-cache-miss', records)
    const problems = validateTopicPhaseSnapshot(snapshot, 'topic-cache-miss')
    expect(problems.some((p) => p.includes("duplicate stage 'topic.messagesMount'"))).toBe(true)
  })
})

describe('messagesMount one-shot guard (PERF-101)', () => {
  it('validatePhaseRecordSet accepts a single messagesMount from a one-shot guard', () => {
    const records: PhaseRecord[] = [
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.messagesMount',
        clock: 'renderer',
        durationMs: 42
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.contextInfo', clock: 'renderer', durationMs: 1 },
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.visibleGroupModel',
        clock: 'renderer',
        durationMs: 1
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.windowApply', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.domEndpoint', clock: 'renderer', durationMs: 1 }
    ]
    const problems = validatePhaseRecordSet(
      { records, overflowed: false },
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        requiredStages: TOPIC_VALIDATION_REQUIRED_STAGES,
        requiredStageGroups: [TOPIC_WINDOW_STAGES],
        multiplicityStages: TOPIC_MULTIPLICITY_STAGES,
        expectedClock: 'renderer'
      }
    )
    expect(problems).toEqual([])
  })

  it('derives correct renderComputationSpanMs when messagesMount appears exactly once', () => {
    const records: PhaseRecord[] = [
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.messagesMount',
        clock: 'renderer',
        durationMs: 10
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.contextInfo', clock: 'renderer', durationMs: 5 },
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.visibleGroupModel',
        clock: 'renderer',
        durationMs: 3
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.windowApply', clock: 'renderer', durationMs: 2 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.domEndpoint', clock: 'renderer', durationMs: 1 }
    ]
    const metrics = deriveTopicPhaseMetrics({ records }, 'c1', 'topic-cache-miss')
    // renderComputationSpanMs = messagesMount(10) + contextInfo(5) + visibleGroupModel(3) = 18
    expect(metrics.renderComputationSpanMs).toBe(18)
    expect(metrics.domEndpointMs).toBe(1)
    expect(metrics.totalSpanMs).toBe(18 + 2 + 1)
  })
})

describe('readonly detached snapshot adapter typing (PERF-103)', () => {
  it('validatePhaseRecordSet accepts a FrozenPhaseSnapshot state (readonly records)', () => {
    const snapshot: FrozenPhaseSnapshot = frozenSnapshot('c1', 'echo', [
      { correlationId: 'c1', path: 'echo', stage: 'echo.userAppendIpc', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.userDispatch', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.sharedContextInfo', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.visibleGroupModel', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.windowCreate', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'echo', stage: 'echo.domEndpoint', clock: 'renderer', durationMs: 1 }
    ])
    // Pass the frozen snapshot's state directly — the readonly records array
    // must be accepted by the validator without a type error.
    const problems = validatePhaseRecordSet(snapshot.state, {
      correlationId: 'c1',
      path: 'echo',
      requiredStages: ECHO_VALIDATION_REQUIRED_STAGES,
      requiredStageGroups: [ECHO_WINDOW_STAGES],
      multiplicityStages: ECHO_MULTIPLICITY_STAGES,
      expectedClock: 'renderer'
    })
    expect(problems).toEqual([])
  })

  it('deriveTopicPhaseMetrics accepts a FrozenPhaseSnapshot state (readonly records)', () => {
    const snapshot: FrozenPhaseSnapshot = frozenSnapshot('c1', 'topic-cache-miss', [
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.messagesMount', clock: 'renderer', durationMs: 4 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.contextInfo', clock: 'renderer', durationMs: 1 },
      {
        correlationId: 'c1',
        path: 'topic-cache-miss',
        stage: 'topic.visibleGroupModel',
        clock: 'renderer',
        durationMs: 1
      },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.windowApply', clock: 'renderer', durationMs: 1 },
      { correlationId: 'c1', path: 'topic-cache-miss', stage: 'topic.domEndpoint', clock: 'renderer', durationMs: 1 }
    ])
    // Pass the frozen snapshot's state directly — readonly records must work.
    const metrics = deriveTopicPhaseMetrics(snapshot.state, 'c1', 'topic-cache-miss')
    expect(metrics.renderComputationSpanMs).toBe(6) // 4 + 1 + 1
    expect(metrics.windowLifecycleSpanMs).toBe(1)
    expect(metrics.domEndpointMs).toBe(1)
  })
})
