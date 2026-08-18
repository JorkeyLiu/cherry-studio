/**
 * Shared primitives for the opt-in phase-2A runtime measurements.
 *
 * This module deliberately contains no Electron or renderer imports.  The
 * renderer and Main adapters publish their own bounded state objects, while
 * the closed record contract and validation remain shared.
 */

export const PHASE_ATTR_ENV = 'PERF_PHASE_ATTR'
export const PHASE_ATTR_MAX_RECORDS = 512

export const PHASE_ATTR_RENDERER_STATE_KEY = '__perfPhaseAttrRendererV1__'
export const PHASE_ATTR_MAIN_STATE_KEY = '__perfPhaseAttrMainV1__'

export type PhasePath = 'echo' | 'topic-cache-miss' | 'topic-cache-hit'
export type PhaseClock = 'renderer' | 'main'

export const ECHO_REQUIRED_PHASE_STAGES = [
  'echo.userAppendIpc',
  'echo.userDispatch',
  'echo.sharedContextInfo',
  'echo.windowCreate',
  'echo.windowReconcile',
  'echo.visibleGroupModel',
  'echo.domEndpoint'
] as const

export const TOPIC_REQUIRED_PHASE_STAGES = [
  'topic.messagesMount',
  'topic.windowReset',
  'topic.windowApply',
  'topic.windowReconcile',
  'topic.contextInfo',
  'topic.visibleGroupModel',
  'topic.domEndpoint'
] as const

/**
 * Closed union of all allowed phase stage labels. Defined from the literal
 * arrays so adding a stage to either required-phase-stages array
 * automatically extends the union. PhaseRecord.stage is typed as this
 * union; any value outside it is a type error at write time and is
 * rejected by appendPhaseRecord at runtime.
 */
export type PhaseStage =
  | (typeof ECHO_REQUIRED_PHASE_STAGES)[number]
  | (typeof TOPIC_REQUIRED_PHASE_STAGES)[number]
  | 'echo.mainAppend'

export interface PhaseRecord {
  correlationId: string
  path: PhasePath
  stage: PhaseStage
  clock: PhaseClock
  durationMs: number
}

export interface PhaseState {
  enabled: boolean
  records: PhaseRecord[]
  overflowed: boolean
  activeCorrelationId?: string
  activePath?: PhasePath
  activeStartedAt?: number
  /** One-shot guard: set when the endpoint stage has been recorded for
   *  the current active correlation. Prevents duplicate endpoint writes
   *  (LOCK-2A-009: singular stages must appear exactly once). Cleared
   *  when a new correlation starts. */
  endpointRecorded?: boolean
}

/**
 * Closed union of all allowed phase stages across all paths. Used for
 * write-time enforcement in appendPhaseRecord and read-time validation
 * in validatePhaseRecords. Any stage not in this set is silently
 * rejected at write time (preventing contamination) and rejected at
 * validation time.
 */
export const VALID_CLOSED_STAGES: ReadonlySet<PhaseStage> = new Set<PhaseStage>([
  ...ECHO_REQUIRED_PHASE_STAGES,
  ...TOPIC_REQUIRED_PHASE_STAGES,
  // Main-clock stages (recorded on the main process clock, validated
  // through the mainState in validatePhaseSample).
  'echo.mainAppend'
])

export function resolvePhaseAttrGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `PERF_PHASE_ATTR must be '1'/'true' to enable or unset/empty to skip (got '${value}'). ` +
      'Enable only through the documented measurement build/run.'
  )
}

export function appendPhaseRecord(state: PhaseState, record: PhaseRecord): void {
  if (!state.enabled) return
  // Write-time closed stage enforcement: silently reject any stage not
  // in the closed union. This prevents invalid stages (like
  // topic.activation) from entering the sample and contaminating
  // downstream validation. The stage was always rejected at validation
  // time; this makes the rejection earlier and cheaper.
  if (!VALID_CLOSED_STAGES.has(record.stage)) return
  state.records.push(record)
  if (state.records.length > PHASE_ATTR_MAX_RECORDS) {
    state.records.splice(0, state.records.length - PHASE_ATTR_MAX_RECORDS)
    state.overflowed = true
  }
}

export function resetPhaseState(state: PhaseState): void {
  state.records.length = 0
  state.overflowed = false
  delete state.activeCorrelationId
  delete state.activePath
  delete state.activeStartedAt
  delete state.endpointRecorded
}

export interface PhaseValidationOptions {
  correlationId: string
  path: PhasePath
  requiredStages: readonly string[]
  requiredStageGroups?: readonly (readonly string[])[]
  optionalStages?: readonly string[]
  expectedClock?: PhaseClock
  /**
   * Optional causal ordering constraint. Only stages listed here are
   * order-validated, and only when both adjacent stages are present.
   * Omitting this field disables all order validation (LOCK-2A-009):
   * React render/layout/passive-effect ordering is not globally
   * enforceable; only explicit causal constraints proven by code are
   * validated here.
   */
  causalOrder?: readonly string[]
  /**
   * Optional stages allowed to appear multiple times (LOCK-2A-009).
   * React render/layout may invoke a function span more than once per
   * sample (bounded nonzero multiplicity). All stages NOT in this list
   * remain strictly singular — duplicate detection is enforced for them.
   * Omitting this field keeps ALL stages strictly singular (backward
   * compatible default).
   */
  multiplicityStages?: readonly string[]
}

/** Strict fail-closed validation for one retrieved sample. */
export function validatePhaseRecords(
  state: { readonly records: readonly PhaseRecord[]; readonly overflowed: boolean },
  options: PhaseValidationOptions
): string[] {
  const problems: string[] = []
  if (state.overflowed) problems.push('phase ring buffer overflowed')

  const allowed = new Set([
    ...options.requiredStages,
    ...(options.requiredStageGroups ?? []).flat(),
    ...(options.optionalStages ?? []),
    ...(options.causalOrder ?? [])
  ])
  const multiplicityAllowed = new Set(options.multiplicityStages ?? [])
  const positions = new Map<string, number>()
  for (let index = 0; index < state.records.length; index++) {
    const record = state.records[index]
    if (record.correlationId !== options.correlationId) problems.push(`record[${index}] correlation mismatch`)
    if (record.path !== options.path) problems.push(`record[${index}] path mismatch`)
    // Independent closed-union enforcement: reject any stage outside the
    // shared VALID_CLOSED_STAGES regardless of caller-provided allowed
    // lists. This prevents caller-provided required/optional lists from
    // whitelisting arbitrary labels that are not in the shared contract.
    if (!VALID_CLOSED_STAGES.has(record.stage)) {
      problems.push(`record[${index}] stage '${record.stage}' not in closed union`)
    }
    if (!allowed.has(record.stage)) problems.push(`record[${index}] invalid stage '${record.stage}'`)
    if (record.clock !== (options.expectedClock ?? 'renderer')) problems.push(`record[${index}] invalid clock`)
    if (!Number.isFinite(record.durationMs) || record.durationMs < 0) {
      problems.push(`record[${index}] duration must be finite and >= 0`)
    }
    // LOCK-2A-009: multiplicityStages stages may appear multiple times;
    // all other stages must be strictly singular.
    if (!multiplicityAllowed.has(record.stage)) {
      if (positions.has(record.stage)) problems.push(`duplicate stage '${record.stage}'`)
    }
    positions.set(record.stage, index)
  }

  for (const stage of options.requiredStages) {
    if (!positions.has(stage)) problems.push(`missing required stage '${stage}'`)
  }
  for (const group of options.requiredStageGroups ?? []) {
    if (!group.some((stage) => positions.has(stage))) {
      problems.push(`missing one stage from required group '${group.join('|')}'`)
    }
  }
  // Causal order validation: only validate when causalOrder is explicitly
  // provided. Each consecutive pair in causalOrder must appear in order
  // when both are present. Stages not in the records are skipped (no
  // requirement to have all causal stages present — only that WHEN two
  // adjacent causal stages are both present, they must be in order).
  if (options.causalOrder) {
    let previous = -1
    for (const stage of options.causalOrder) {
      const position = positions.get(stage)
      if (position === undefined) continue
      if (position <= previous) problems.push(`invalid causal order at '${stage}'`)
      previous = position
    }
  }
  return problems
}

export function phaseAttrBuildValue(): string | undefined {
  if (typeof __PERF_PHASE_ATTR__ !== 'undefined') {
    if (__PERF_PHASE_ATTR__ === 'true') return '1'
    if (__PERF_PHASE_ATTR__ === 'false') return ''
    return __PERF_PHASE_ATTR__
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Span aggregation helpers (LOCK-2A-008)
// ---------------------------------------------------------------------------
// Phase metrics are explicit function-span aggregates, not derived endpoint
// intervals. These helpers compute honest sum/count from direct per-stage
// durations so that no interval is derived unless both endpoints are directly
// captured on the same clock.

export interface SpanAggregate {
  /** Sum of durations across the selected stages for this sample. */
  sumMs: number
  /** Number of stages contributing to the sum. */
  count: number
}

/**
 * Aggregate selected stage durations from a phase state into a single
 * honest span aggregate (sum + count). For stages that appear multiple
 * times (render/context/window/group multiplicity), ALL matching records
 * are summed and counted. Missing stages contribute 0 to the sum and
 * are not counted.
 */
export function aggregateSpanDurations(
  state: { readonly records: readonly PhaseRecord[] },
  correlationId: string,
  stages: readonly string[]
): SpanAggregate {
  let sumMs = 0
  let count = 0
  for (const stage of stages) {
    for (const record of state.records) {
      if (record.correlationId === correlationId && record.stage === stage) {
        if (Number.isFinite(record.durationMs) && record.durationMs >= 0) {
          sumMs += record.durationMs
          count += 1
        }
      }
    }
  }
  return { sumMs, count }
}
