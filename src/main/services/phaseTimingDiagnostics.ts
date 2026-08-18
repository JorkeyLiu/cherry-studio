import {
  appendPhaseRecord,
  PHASE_ATTR_MAIN_STATE_KEY,
  phaseAttrBuildValue,
  type PhasePath,
  type PhaseRecord,
  type PhaseStage,
  type PhaseState,
  resetPhaseState as resetSharedPhaseState,
  resolvePhaseAttrGate
} from '@shared/diagnostics/phaseAttr'

const enabled = resolvePhaseAttrGate(phaseAttrBuildValue())

function state(): PhaseState {
  const globalAny = globalThis as Record<string, unknown>
  const existing = globalAny[PHASE_ATTR_MAIN_STATE_KEY] as PhaseState | undefined
  if (existing && Array.isArray(existing.records)) return existing
  const next: PhaseState = { enabled, records: [], overflowed: false }
  globalAny[PHASE_ATTR_MAIN_STATE_KEY] = next
  return next
}

export function isPhaseAttrMainEnabled(): boolean {
  return enabled
}

export function recordMainPhaseDuration(
  correlationId: string | undefined,
  path: PhasePath | undefined,
  stage: PhaseStage,
  durationMs: number
): void {
  if (!enabled || !correlationId || !path || !Number.isFinite(durationMs) || durationMs < 0) return
  const record: PhaseRecord = { correlationId, path, stage, clock: 'main', durationMs }
  appendPhaseRecord(state(), record)
}

export function resetPhaseMainState(): void {
  if (!enabled) return
  resetSharedPhaseState(state())
}

export function readPhaseMainState(): PhaseState {
  return state()
}

const globalAny = globalThis as Record<string, unknown>
globalAny.__perfPhaseAttrResetMain = () => resetPhaseMainState()
globalAny.__perfPhaseAttrReadMain = () => readPhaseMainState()
