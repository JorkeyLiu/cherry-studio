import {
  type StartupRecord,
  type StartupStage,
  VALID_STARTUP_STAGES
} from '../../../packages/shared/diagnostics/startupStage'

export type StartupStateSnapshot = {
  enabled: boolean
  records: StartupRecord[]
  overflowed: boolean
  epochAnchorMs: number
  perfAnchorMs: number
}

export function validateStartupRecords(state: StartupStateSnapshot): string[] {
  const problems: string[] = []
  if (!state.enabled && state.records.length > 0) problems.push('disabled state must have zero records')
  if (state.overflowed) problems.push('overflowed')
  const seen = new Set<string>()
  for (const [i, r] of state.records.entries()) {
    if (!VALID_STARTUP_STAGES.has(r.stage as StartupStage)) problems.push(`record[${i}] invalid stage ${r.stage}`)
    if (seen.has(r.stage)) problems.push(`duplicate stage ${r.stage}`)
    seen.add(r.stage)
    if (!Number.isFinite(r.durationMs) || r.durationMs < 0) problems.push(`record[${i}] duration invalid`)
    if (!Number.isFinite(r.epochMs) || r.epochMs < 0 || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0)
      problems.push(`record[${i}] epoch invalid`)
    if (r.elapsedMs < 0) problems.push(`record[${i}] elapsed negative`)
    if (r.epochMs < 0) problems.push(`record[${i}] epochMs negative`)
    if (r.reason !== undefined && (r.reason.length === 0 || r.reason.length > 64))
      problems.push(`record[${i}] reason length invalid`)
    if (r.reason && (r.reason.includes('/') || r.reason.includes('\\')))
      problems.push(`record[${i}] reason contains path`)
  }
  return problems
}

export function epochComparable(main: StartupStateSnapshot, renderer: StartupStateSnapshot): boolean {
  // Both anchors should be within a reasonable window (startup within seconds)
  if (!main.enabled || !renderer.enabled) return false
  const diff = Math.abs(main.epochAnchorMs - renderer.epochAnchorMs)
  // Comparable epoch timeline: anchors within 60s wall-clock
  return diff < 60_000
}
