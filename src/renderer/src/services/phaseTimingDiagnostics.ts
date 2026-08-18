import {
  appendPhaseRecord,
  ECHO_REQUIRED_PHASE_STAGES,
  PHASE_ATTR_MAX_RECORDS,
  PHASE_ATTR_RENDERER_STATE_KEY,
  phaseAttrBuildValue,
  type PhasePath,
  type PhaseRecord,
  type PhaseStage,
  type PhaseState,
  resetPhaseState as resetSharedPhaseState,
  resolvePhaseAttrGate,
  TOPIC_REQUIRED_PHASE_STAGES
} from '@shared/diagnostics/phaseAttr'

export { ECHO_REQUIRED_PHASE_STAGES, TOPIC_REQUIRED_PHASE_STAGES }
export type { PhasePath, PhaseRecord, PhaseStage, PhaseState }

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

const enabled = resolvePhaseAttrGate(phaseAttrBuildValue())

function state(): PhaseState {
  const globalAny = globalThis as Record<string, unknown>
  const existing = globalAny[PHASE_ATTR_RENDERER_STATE_KEY] as PhaseState | undefined
  if (existing && Array.isArray(existing.records)) return existing
  const next: PhaseState = { enabled, records: [], overflowed: false }
  globalAny[PHASE_ATTR_RENDERER_STATE_KEY] = next
  return next
}

export function isPhaseAttrEnabled(): boolean {
  return enabled
}

export function setActivePhaseCorrelation(correlationId: string, path: PhasePath): void {
  if (!enabled) return
  const current = state()
  current.activeCorrelationId = correlationId
  current.activePath = path
  current.activeStartedAt = performance.now()
  current.endpointRecorded = false
}

export function snapshotActivePhaseCorrelation(): FrozenPhaseSnapshot | undefined {
  if (!enabled) return undefined
  const current = state()
  if (!current.activeCorrelationId || !current.activePath) return undefined
  const correlationId = current.activeCorrelationId
  const path = current.activePath
  // Deep-copy the records to produce a truly detached snapshot. Subsequent
  // live mutations (new records, active-correlation close) never enter the
  // captured sample.
  const frozenRecords: PhaseRecord[] = current.records.map((r) => ({
    correlationId: r.correlationId,
    path: r.path,
    stage: r.stage,
    clock: r.clock,
    durationMs: r.durationMs
  }))
  return {
    correlationId,
    path,
    state: {
      enabled: current.enabled,
      records: frozenRecords,
      overflowed: current.overflowed
    }
  }
}

export function closeActivePhaseCorrelation(): void {
  if (!enabled) return
  const current = state()
  delete current.activeCorrelationId
  delete current.activePath
  delete current.activeStartedAt
  delete current.endpointRecorded
}

/** @deprecated Use closeActivePhaseCorrelation() */
export function clearActivePhaseCorrelation(): void {
  closeActivePhaseCorrelation()
}

export function markPhaseActionStart(): void {
  if (!enabled) return
  const current = state()
  if (current.activeCorrelationId && current.activePath) current.activeStartedAt = performance.now()
}

export function currentPhaseCorrelation(): { correlationId: string; path: PhasePath } | undefined {
  if (!enabled) return undefined
  const current = state()
  if (!current.activeCorrelationId || !current.activePath) return undefined
  return { correlationId: current.activeCorrelationId, path: current.activePath }
}

export function recordPhaseDuration(stage: PhaseStage, startedAt: number, path?: PhasePath): void {
  if (!enabled) return
  const current = state()
  const correlationId = current.activeCorrelationId
  const activePath = path ?? current.activePath
  if (!correlationId || !activePath) return
  const durationMs = performance.now() - startedAt
  if (!Number.isFinite(durationMs) || durationMs < 0) return
  const record: PhaseRecord = { correlationId, path: activePath, stage, clock: 'renderer', durationMs }
  appendPhaseRecord(current, record)
}

export function recordPhaseDurationForCorrelation(
  correlationId: string | undefined,
  path: PhasePath | undefined,
  stage: PhaseStage,
  durationMs: number
): void {
  if (!enabled || !correlationId || !path || !Number.isFinite(durationMs) || durationMs < 0) return
  const current = state()
  // No write-time dedup: truly singular stages are rejected at validation
  // time (LOCK-2A-009), and repeatable render/context/window/group stages
  // must be recorded with full multiplicity for sum+count aggregation.
  appendPhaseRecord(current, { correlationId, path, stage, clock: 'renderer', durationMs })
}

export function recordPhaseDurationOnceForCorrelation(
  correlationId: string | undefined,
  path: PhasePath | undefined,
  stage: PhaseStage,
  durationMs: number
): void {
  if (!enabled || !correlationId || !path) return
  recordPhaseDurationForCorrelation(correlationId, path, stage, durationMs)
}

export function recordPhaseEndpoint(stage: PhaseStage): void {
  if (!enabled) return
  const current = state()
  if (!current.activeStartedAt) return
  if (current.endpointRecorded) return
  current.endpointRecorded = true
  recordPhaseDurationForCorrelation(
    current.activeCorrelationId,
    current.activePath,
    stage,
    performance.now() - current.activeStartedAt
  )
}

export function resetPhaseRendererState(): void {
  if (!enabled) return
  const current = state()
  resetSharedPhaseState(current)
}

export function readPhaseRendererState(): PhaseState {
  return state()
}

export function installPhaseTestSeam(): void {
  if (!enabled) return
  const globalAny = globalThis as Record<string, unknown>
  globalAny.__perfPhaseAttrSetActive = (correlationId: string, path: PhasePath) =>
    setActivePhaseCorrelation(correlationId, path)
  globalAny.__perfPhaseAttrClearActive = () => closeActivePhaseCorrelation()
  globalAny.__perfPhaseAttrSnapshot = () => snapshotActivePhaseCorrelation()
  globalAny.__perfPhaseAttrClose = () => closeActivePhaseCorrelation()
  globalAny.__perfPhaseAttrMarkAction = () => markPhaseActionStart()
  globalAny.__perfPhaseAttrReset = () => resetPhaseRendererState()
  globalAny.__perfPhaseAttrRead = () => readPhaseRendererState()
}

;(globalThis as Record<string, unknown>)[PHASE_ATTR_RENDERER_STATE_KEY] = {
  enabled,
  records: [],
  overflowed: false
} satisfies PhaseState
installPhaseTestSeam()

export { PHASE_ATTR_MAX_RECORDS }
