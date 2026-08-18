/** Strict adapters for the opt-in phase-2A runtime diagnostics. */
import {
  ECHO_REQUIRED_PHASE_STAGES,
  PHASE_ATTR_ENV,
  type PhasePath,
  type PhaseRecord,
  type PhaseStage,
  type PhaseState,
  resolvePhaseAttrGate,
  TOPIC_REQUIRED_PHASE_STAGES,
  VALID_CLOSED_STAGES
} from '../../../packages/shared/diagnostics/phaseAttr'

export { ECHO_REQUIRED_PHASE_STAGES, PHASE_ATTR_ENV, TOPIC_REQUIRED_PHASE_STAGES, VALID_CLOSED_STAGES }
export type { PhasePath, PhaseRecord, PhaseStage, PhaseState }

/** Closed union of all allowed phase stages across all paths, as an array. */
export const VALID_CLOSED_STAGES_ARRAY: readonly PhaseStage[] = [
  ...ECHO_REQUIRED_PHASE_STAGES,
  ...TOPIC_REQUIRED_PHASE_STAGES,
  'echo.mainAppend'
] as const

export function phaseAttrEnabled(): boolean {
  return resolvePhaseAttrGate(process.env[PHASE_ATTR_ENV])
}

export function sampleCorrelationId(specPrefix: string, sampleIndex: number): string {
  return `${specPrefix}-sample-${sampleIndex}`
}

/**
 * A detached, frozen snapshot of the phase correlation state captured at
 * the DOM endpoint. The records array is a deep copy; subsequent live
 * mutations to the renderer state cannot affect the snapshot. This type
 * is the ONLY source of truth for spec-level phase metric derivation —
 * no live fallback is permitted.
 */
export interface FrozenPhaseSnapshot {
  readonly correlationId: string
  readonly path: PhasePath
  readonly state: Readonly<{
    enabled: boolean
    records: readonly PhaseRecord[]
    overflowed: boolean
  }>
}

/**
 * Validate a single-clock phase record set. Order validation is opt-in via
 * `causalOrder` — when omitted, no ordering constraint is enforced
 * (LOCK-2A-009: React render/layout/passive-effect ordering is not globally
 * enforceable). Render stages may appear multiple times when listed in
 * `multiplicityStages` (LOCK-2A-009: bounded nonzero multiplicity for render
 * spans).
 */
export function validatePhaseRecordSet(
  state: { readonly records: readonly PhaseRecord[]; readonly overflowed: boolean } | undefined,
  options: {
    correlationId: string
    path: PhasePath
    requiredStages: readonly string[]
    requiredStageGroups?: readonly (readonly string[])[]
    optionalStages?: readonly string[]
    expectedClock: 'renderer' | 'main'
    causalOrder?: readonly string[]
    multiplicityStages?: readonly string[]
  }
): string[] {
  const problems: string[] = []
  if (!state) return ['diagnostic state retrieval failed']
  if (state.overflowed) problems.push('phase ring buffer overflowed')
  const allowed = new Set([
    ...options.requiredStages,
    ...(options.requiredStageGroups ?? []).flat(),
    ...(options.optionalStages ?? []),
    ...(options.causalOrder ?? [])
  ])
  const multiplicityAllowed = new Set(options.multiplicityStages ?? [])
  const seen = new Map<string, number>()
  for (const [index, record] of state.records.entries()) {
    if (record.correlationId !== options.correlationId) problems.push(`record[${index}] correlation mismatch`)
    if (record.path !== options.path) problems.push(`record[${index}] path mismatch`)
    // Independent closed-union enforcement: reject any stage outside the
    // shared VALID_CLOSED_STAGES regardless of caller-provided allowed
    // lists. This prevents caller-provided required/optional lists from
    // whitelisting arbitrary labels that are not in the shared contract.
    if (!VALID_CLOSED_STAGES.has(record.stage as PhaseStage)) {
      problems.push(`record[${index}] stage '${record.stage}' not in closed union`)
    }
    if (!allowed.has(record.stage)) problems.push(`record[${index}] invalid stage '${record.stage}'`)
    if (record.clock !== options.expectedClock) problems.push(`record[${index}] invalid clock`)
    if (!Number.isFinite(record.durationMs) || record.durationMs < 0) {
      problems.push(`record[${index}] duration invalid`)
    }
    // LOCK-2A-009: multiplicityStages stages may appear multiple times;
    // all other stages must be strictly singular.
    if (!multiplicityAllowed.has(record.stage)) {
      if (seen.has(record.stage)) problems.push(`duplicate stage '${record.stage}'`)
    }
    seen.set(record.stage, index)
  }
  for (const stage of options.requiredStages) {
    if (!seen.has(stage)) problems.push(`missing required stage '${stage}'`)
  }
  for (const group of options.requiredStageGroups ?? []) {
    if (!group.some((stage) => seen.has(stage))) problems.push(`missing required stage group '${group.join('|')}'`)
  }
  // Causal order: only validate when causalOrder is explicitly provided.
  if (options.causalOrder) {
    let last = -1
    for (const stage of options.causalOrder) {
      const position = seen.get(stage)
      if (position === undefined) continue
      if (position <= last) problems.push(`invalid causal order at '${stage}'`)
      last = position
    }
  }
  return problems
}

export function validatePhaseSample(
  rendererState: { readonly records: readonly PhaseRecord[]; readonly overflowed: boolean } | undefined,
  mainState: { readonly records: readonly PhaseRecord[]; readonly overflowed: boolean } | undefined,
  options: {
    correlationId: string
    path: PhasePath
    rendererRequiredStages: readonly string[]
    rendererRequiredStageGroups?: readonly (readonly string[])[]
    rendererCausalOrder?: readonly string[]
    rendererMultiplicityStages?: readonly string[]
    mainRequiredStages?: readonly string[]
    mainMultiplicityStages?: readonly string[]
  }
): string[] {
  return [
    ...validatePhaseRecordSet(rendererState, {
      correlationId: options.correlationId,
      path: options.path,
      requiredStages: options.rendererRequiredStages,
      requiredStageGroups: options.rendererRequiredStageGroups,
      causalOrder: options.rendererCausalOrder,
      multiplicityStages: options.rendererMultiplicityStages,
      expectedClock: 'renderer'
    }),
    ...(options.mainRequiredStages
      ? validatePhaseRecordSet(mainState, {
          correlationId: options.correlationId,
          path: options.path,
          requiredStages: options.mainRequiredStages,
          multiplicityStages: options.mainMultiplicityStages,
          expectedClock: 'main'
        })
      : [])
  ]
}

/**
 * Sum the durations of ALL records matching a stage. For truly singular
 * stages this returns the single value; for repeatable stages (render/
 * context/window/group multiplicity) it sums all occurrences — no work
 * is silently lost.
 */
export function phaseDuration(state: { readonly records: readonly PhaseRecord[] }, stage: string): number {
  let sumMs = 0
  let found = false
  for (const record of state.records) {
    if (record.stage === stage) {
      if (!Number.isFinite(record.durationMs) || record.durationMs < 0) {
        throw new Error(`invalid duration for stage '${stage}'`)
      }
      sumMs += record.durationMs
      found = true
    }
  }
  if (!found) throw new Error(`missing phase duration '${stage}'`)
  return sumMs
}

export function phaseDurations(
  state: { readonly records: readonly PhaseRecord[] },
  stages: readonly string[]
): number[] {
  return stages.map((stage) => phaseDuration(state, stage))
}

/**
 * Snapshot the active correlation and close it in one atomic operation.
 * Must be called from the page context (via page.evaluate). Returns a
 * **detached frozen copy** of the phase state at DOM endpoint time —
 * the snapshot function itself deep-copies the records array so that
 * later assistant/reconciliation records never enter the sample. No
 * live fallback is permitted; callers must use the returned snapshot.
 */
export async function snapshotAndClosePhaseCorrelation(page: {
  evaluate: <T>(fn: (...args: any[]) => T, ...args: any[]) => Promise<T>
}): Promise<FrozenPhaseSnapshot | undefined> {
  return page.evaluate(() => {
    const snapshotFn = (globalThis as any).__perfPhaseAttrSnapshot
    const closeFn = (globalThis as any).__perfPhaseAttrClose
    if (typeof snapshotFn !== 'function' || typeof closeFn !== 'function') return undefined
    const snapshot = snapshotFn()
    if (!snapshot) return undefined
    // Close prevents later records from entering the live state. The
    // snapshot already contains a detached deep copy of the records.
    closeFn()
    return snapshot as FrozenPhaseSnapshot
  })
}

/**
 * Aggregate all matching window lifecycle stages from a phase state.
 * Returns per-stage durations (summed across all occurrences of each
 * stage), sum of all matching durations, and count of total matching
 * records. Multiple window stages may fire in one sample (e.g.
 * windowReset + windowApply + windowReconcile), and a stage may appear
 * multiple times — this captures ALL of them and sums durations per
 * stage rather than selecting only the first occurrence.
 */
export function aggregateWindowLifecycleStages(
  state: { readonly records: readonly PhaseRecord[] },
  correlationId: string,
  windowStages: readonly string[]
): { stages: Array<{ stage: string; durationMs: number; count: number }>; totalDurationMs: number; count: number } {
  const stageSums = new Map<string, { durationMs: number; count: number }>()
  let totalDurationMs = 0
  let count = 0
  for (const record of state.records) {
    if (
      record.correlationId === correlationId &&
      windowStages.includes(record.stage) &&
      Number.isFinite(record.durationMs) &&
      record.durationMs >= 0
    ) {
      const existing = stageSums.get(record.stage) ?? { durationMs: 0, count: 0 }
      existing.durationMs += record.durationMs
      existing.count += 1
      stageSums.set(record.stage, existing)
      totalDurationMs += record.durationMs
      count += 1
    }
  }
  const stages = windowStages
    .filter((s) => stageSums.has(s))
    .map((s) => {
      const agg = stageSums.get(s)!
      return { stage: s, durationMs: agg.durationMs, count: agg.count }
    })
  return { stages, totalDurationMs, count }
}

/**
 * Collect and validate all window lifecycle stages from a snapshot state,
 * returning a detailed aggregate for artifact emission. Used by both echo
 * and topic collectors to ensure consistent multi-stage handling.
 */
export function collectWindowLifecycleAggregate(
  state: { readonly records: readonly PhaseRecord[] },
  correlationId: string,
  windowStages: readonly string[]
): {
  totalDurationMs: number
  count: number
  stages: Array<{ stage: string; durationMs: number; count: number }>
  totalRecordedStages: number
  totalRecordedDurationMs: number
} {
  const window = aggregateWindowLifecycleStages(state, correlationId, windowStages)
  let totalRecordedStages = 0
  let totalRecordedDurationMs = 0
  for (const record of state.records) {
    if (record.correlationId === correlationId && Number.isFinite(record.durationMs) && record.durationMs >= 0) {
      totalRecordedStages += 1
      totalRecordedDurationMs += record.durationMs
    }
  }
  return {
    totalDurationMs: window.totalDurationMs,
    count: window.count,
    stages: window.stages,
    totalRecordedStages,
    totalRecordedDurationMs
  }
}

// ---------------------------------------------------------------------------
// Pure phase metric derivation (extracted from spec collectEchoPhase /
// collectTopicPhase so tests can invoke the exact functions used by specs).
// ---------------------------------------------------------------------------

/** Metric IDs shared by both echo and topic phase metric derivation. */
export const ECHO_PHASE_METRIC_PREFIXES = {
  userAction: 'phase.span.userAction',
  renderComputation: 'phase.span.renderComputation',
  windowLifecycle: 'phase.span.windowLifecycle',
  windowLifecycleStageCount: 'phase.windowLifecycleStageCount',
  domEndpoint: 'phase.endpoint.domEndpoint',
  totalSpan: 'phase.span.total',
  samples: 'phase.samples'
} as const

export const TOPIC_PHASE_METRIC_PREFIXES = {
  renderComputation: '.phase.span.renderComputation',
  windowLifecycle: '.phase.span.windowLifecycle',
  windowLifecycleStageCount: '.phase.windowLifecycleStageCount',
  domEndpoint: '.phase.endpoint.domEndpoint',
  totalSpan: '.phase.span.total',
  samples: '.phase.samples'
} as const

/** Echo required stages for validation (excludes window stages which are a group). */
export const ECHO_VALIDATION_REQUIRED_STAGES: readonly PhaseStage[] = [
  'echo.userAppendIpc',
  'echo.userDispatch',
  'echo.sharedContextInfo',
  'echo.visibleGroupModel',
  'echo.domEndpoint'
]

/**
 * Echo stages allowed to appear multiple times per sample (LOCK-2A-009).
 * React render/layout may invoke the shared context computation or the
 * visible-group-model projection more than once per sample (bounded nonzero
 * multiplicity). All other echo stages are strictly singular.
 */
export const ECHO_MULTIPLICITY_STAGES: readonly PhaseStage[] = [
  'echo.sharedContextInfo',
  'echo.visibleGroupModel',
  'echo.windowCreate',
  'echo.windowReconcile'
]

/** Echo window lifecycle stages (required as a group — at least one must be present). */
export const ECHO_WINDOW_STAGES: readonly PhaseStage[] = ['echo.windowCreate', 'echo.windowReconcile']

/** Topic required stages for validation (excludes window stages which are a group). */
export const TOPIC_VALIDATION_REQUIRED_STAGES: readonly PhaseStage[] = [
  'topic.messagesMount',
  'topic.contextInfo',
  'topic.visibleGroupModel',
  'topic.domEndpoint'
]

/**
 * Topic stages allowed to appear multiple times per sample (LOCK-2A-009).
 * React render/layout may invoke context-info, visible-group-model, or
 * window lifecycle function spans more than once per sample (bounded
 * nonzero multiplicity). All other topic stages are strictly singular.
 */
export const TOPIC_MULTIPLICITY_STAGES: readonly PhaseStage[] = [
  'topic.contextInfo',
  'topic.visibleGroupModel',
  'topic.windowReset',
  'topic.windowApply',
  'topic.windowReconcile'
]

/** Topic window lifecycle stages (required as a group — at least one must be present). */
export const TOPIC_WINDOW_STAGES: readonly PhaseStage[] = [
  'topic.windowReset',
  'topic.windowApply',
  'topic.windowReconcile'
]

/**
 * Pure echo phase metric derivation — the exact logic used by the perf103
 * spec's `collectEchoPhase`. Extracted so tests can invoke it directly
 * without page/electronApp interaction.
 *
 * Returns metric values for one sample. Caller must validate the snapshot
 * state before calling (use `validatePhaseSample` with the same stages).
 */
export function deriveEchoPhaseMetrics(
  state: { readonly records: readonly PhaseRecord[] },
  correlationId: string
): {
  userActionSpanMs: number
  renderComputationSpanMs: number
  windowLifecycleSpanMs: number
  windowLifecycleStageCount: number
  domEndpointMs: number
  totalSpanMs: number
} {
  const domEndpointDuration = phaseDuration(state, 'echo.domEndpoint')
  const userActionSum = phaseDuration(state, 'echo.userAppendIpc') + phaseDuration(state, 'echo.userDispatch')
  const renderCompSum = phaseDuration(state, 'echo.sharedContextInfo') + phaseDuration(state, 'echo.visibleGroupModel')
  const windowAgg = aggregateWindowLifecycleStages(state, correlationId, ECHO_WINDOW_STAGES)
  const totalSpan = userActionSum + renderCompSum + windowAgg.totalDurationMs + domEndpointDuration
  return {
    userActionSpanMs: userActionSum,
    renderComputationSpanMs: renderCompSum,
    windowLifecycleSpanMs: windowAgg.totalDurationMs,
    windowLifecycleStageCount: windowAgg.count,
    domEndpointMs: domEndpointDuration,
    totalSpanMs: totalSpan
  }
}

/**
 * Pure topic phase metric derivation — the exact logic used by the perf101
 * spec's `collectTopicPhase`. Extracted so tests can invoke it directly
 * without page/electronApp interaction.
 *
 * Returns metric values for one sample. Caller must validate the snapshot
 * state before calling (use `validatePhaseSample` with the same stages).
 */
export function deriveTopicPhaseMetrics(
  state: { readonly records: readonly PhaseRecord[] },
  correlationId: string,
  path: 'topic-cache-miss' | 'topic-cache-hit'
): {
  renderComputationSpanMs: number
  windowLifecycleSpanMs: number
  windowLifecycleStageCount: number
  domEndpointMs: number
  totalSpanMs: number
} {
  const domEndpointDuration = phaseDuration(state, 'topic.domEndpoint')
  const renderCompSum =
    phaseDuration(state, 'topic.messagesMount') +
    phaseDuration(state, 'topic.contextInfo') +
    phaseDuration(state, 'topic.visibleGroupModel')
  const windowAgg = aggregateWindowLifecycleStages(state, correlationId, TOPIC_WINDOW_STAGES)
  const totalSpan = renderCompSum + windowAgg.totalDurationMs + domEndpointDuration
  return {
    renderComputationSpanMs: renderCompSum,
    windowLifecycleSpanMs: windowAgg.totalDurationMs,
    windowLifecycleStageCount: windowAgg.count,
    domEndpointMs: domEndpointDuration,
    totalSpanMs: totalSpan
  }
}

/**
 * Validate a frozen echo phase snapshot against the shared closed union
 * and required stage contracts. Returns an empty array when valid.
 * This is the exact validation logic used by the perf103 spec.
 */
export function validateEchoPhaseSnapshot(
  snapshot: FrozenPhaseSnapshot,
  mainState: { readonly records: readonly PhaseRecord[]; readonly overflowed: boolean } | undefined
): string[] {
  return validatePhaseSample(snapshot.state, mainState, {
    correlationId: snapshot.correlationId,
    path: snapshot.path,
    rendererRequiredStages: ECHO_VALIDATION_REQUIRED_STAGES,
    rendererRequiredStageGroups: [ECHO_WINDOW_STAGES],
    rendererCausalOrder: ['echo.userAppendIpc', 'echo.userDispatch', 'echo.domEndpoint'],
    rendererMultiplicityStages: ECHO_MULTIPLICITY_STAGES,
    mainRequiredStages: ['echo.mainAppend']
  })
}

/**
 * Validate a frozen topic phase snapshot against the shared closed union
 * and required stage contracts. Returns an empty array when valid.
 * This is the exact validation logic used by the perf101 spec.
 */
export function validateTopicPhaseSnapshot(
  snapshot: FrozenPhaseSnapshot,
  path: 'topic-cache-miss' | 'topic-cache-hit'
): string[] {
  return validatePhaseSample(snapshot.state, undefined, {
    correlationId: snapshot.correlationId,
    path,
    rendererRequiredStages: TOPIC_VALIDATION_REQUIRED_STAGES,
    rendererRequiredStageGroups: [TOPIC_WINDOW_STAGES],
    rendererMultiplicityStages: TOPIC_MULTIPLICITY_STAGES
  })
}

/**
 * Validate that a sample count matches the expected exact count. Used by
 * artifact builders to enforce exact-count gates (LOCK-2A-011). Throws
 * when the count does not match; caller is responsible for only calling
 * when the builder is enabled (phase attribution active).
 */
export function assertExactPhaseSampleCount(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} phase sample count mismatch: expected ${expected}, got ${actual}`)
  }
}

/**
 * Validate that a phase record's stage is in the closed union. Used by
 * read-time validation helpers independent of caller-provided lists.
 */
export function isStageInClosedUnion(stage: string): stage is PhaseStage {
  return VALID_CLOSED_STAGES.has(stage as PhaseStage)
}
