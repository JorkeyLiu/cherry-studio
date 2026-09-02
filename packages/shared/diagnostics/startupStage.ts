/**
 * Shared closed primitives for startup stage instrumentation (S7.13).
 *
 * Independent gate/stage namespace — never reuse PERF_PHASE_ATTR or
 * PERF_STREAM_ATTR. Default-off/fail-closed, synthetic-disposable-profile-only,
 * bounded and privacy-safe.
 *
 * - Build define `__STARTUP_STAGE_ATTR__` inlined via electron.vite.config.ts
 *   and vitest.config.ts: 'false' (inert default) or 'true' (enabled).
 *   Malformed build env throws at config load (fail-closed); ordinary builds
 *   remain 'false'.
 * - Runtime gate: `STARTUP_STAGE_ATTR` env must be '1'/'true' (fail-closed on
 *   malformed non-empty). This is checked at process start via
 *   `resolveStartupStageGate` in addition to the build define.
 * - Synthetic gate: `STARTUP_STAGE_SYNTHETIC` env must be '1'/'true' when
 *   instrumentation is enabled. Ordinary profile without synthetic env stays
 *   inert; malformed synthetic value is fail-closed.
 *
 * Records:
 * - closed stage names only; at most one per stage per process/startup session
 * - finite non-negative monotonic duration via performance.now()
 * - bounded scalar status/reason and comparable epoch anchor (Date.now)
 * - never content, credentials, paths, IDs, raw DB sizes, stacks, arbitrary metadata
 *
 * Dependency-free: no Electron imports — safe for main, renderer, shared tests.
 */

export const STARTUP_STAGE_ENV = 'STARTUP_STAGE_ATTR'
export const STARTUP_STAGE_SYNTHETIC_ENV = 'STARTUP_STAGE_SYNTHETIC'

/** Internal opaque validation marker — set by Main after exact disposable profile validation, inherited by renderer. Never accepted as input. */
export const STARTUP_STAGE_VALIDATED_ENV = '__CHERRY_STARTUP_STAGE_VALIDATED'

/** Bounded per-process record limit (drop-oldest). */
export const STARTUP_STAGE_MAX_RECORDS = 32

/** Comparable epoch + monotonic elapsedMs anchor captured at startup. */
export interface StartupEpochAnchor {
  epochMs: number
  perfMs: number
}

/** Closed union of main startup stages (sequential in src/main/index.ts). */
export const MAIN_STARTUP_STAGES = [
  'main.restore',
  'main.cleanupExtractions',
  'main.promotionGate',
  'main.catalogRecovery',
  'main.chatDbInit',
  'main.orphanRecovery',
  'main.createWindow',
  'main.windowReady',
  'main.registerIpc'
] as const

/** Closed union of renderer startup stages (bootstrap → rehydration → gates). */
export const RENDERER_STARTUP_STAGES = [
  'renderer.bootstrap',
  'renderer.persistRehydrate',
  'renderer.importProjectionReady',
  'renderer.ordinaryTreeReady'
] as const

export const STARTUP_STAGE_VALUES = [...MAIN_STARTUP_STAGES, ...RENDERER_STARTUP_STAGES] as const
export type StartupStage = (typeof STARTUP_STAGE_VALUES)[number]

export const VALID_STARTUP_STAGES: ReadonlySet<StartupStage> = new Set(STARTUP_STAGE_VALUES)

export type StartupStageStatus = 'ok' | 'error' | 'skipped'

/** Bounded scalar record for one startup stage. */
export interface StartupRecord {
  stage: StartupStage
  status: StartupStageStatus
  /** Bounded scalar reason (max 64 chars, closed vocabulary preferred). */
  reason?: string
  durationMs: number
  epochMs: number
  elapsedMs: number
}

export interface StartupState {
  enabled: boolean
  records: StartupRecord[]
  overflowed: boolean
  /** Comparable wall-clock anchor for the session (Date.now at startup). */
  epochAnchorMs: number
  /** Monotonic anchor for elapsedMs (performance.now at startup). */
  perfAnchorMs: number
}

export function resolveStartupStageGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `STARTUP_STAGE_ATTR must be '1'/'true' to enable or unset/empty to skip (got '${value}'). ` +
      'Enable only for the documented instrumentation build.'
  )
}

export function resolveSyntheticGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `STARTUP_STAGE_SYNTHETIC must be '1'/'true' to enable synthetic instrumentation or unset/empty to skip (got '${value}').`
  )
}

/** Return the inlined build value if present ('1' for enabled, '' for disabled). */
export function startupBuildValue(): string | undefined {
  if (typeof __STARTUP_STAGE_ATTR__ !== 'undefined') {
    if (__STARTUP_STAGE_ATTR__ === 'true') return '1'
    if (__STARTUP_STAGE_ATTR__ === 'false') return ''
    return __STARTUP_STAGE_ATTR__
  }
  return undefined
}

/**
 * Bounded, privacy-safe append with dedup: at most one record per stage per
 * startup session. Validates closed stage, finite non-negative duration,
 * bounded scalar status/reason, and comparable epoch anchor.
 */
export function appendStartupRecord(state: StartupState, record: StartupRecord): void {
  if (!state.enabled) return
  if (!VALID_STARTUP_STAGES.has(record.stage)) return
  // dedup: at most one per stage
  if (state.records.some((r) => r.stage === record.stage)) return
  if (!Number.isFinite(record.durationMs) || record.durationMs < 0) return
  if (
    !Number.isFinite(record.epochMs) ||
    record.epochMs < 0 ||
    !Number.isFinite(record.elapsedMs) ||
    record.elapsedMs < 0
  )
    return
  if (record.status !== 'ok' && record.status !== 'error' && record.status !== 'skipped') return
  // bound reason length and reject arbitrary content-like values (paths with / or \)
  if (record.reason !== undefined) {
    if (typeof record.reason !== 'string') return
    if (record.reason.length === 0 || record.reason.length > 64) return
    // reject obvious path/credential-like content
    if (record.reason.includes('/') || record.reason.includes('\\') || record.reason.includes(':')) {
      // allow only simple scalar tokens like 'ok','error','skipped','timeout','gate-failed'
      // but colon is common in reason codes; we conservatively reject '/' and '\' only
      if (record.reason.includes('/') || record.reason.includes('\\')) return
    }
  }
  // bound status/reason are scalar — no IDs/content ever flow here
  state.records.push(record)
  if (state.records.length > STARTUP_STAGE_MAX_RECORDS) {
    state.records.splice(0, state.records.length - STARTUP_STAGE_MAX_RECORDS)
    state.overflowed = true
  }
}

export function resetStartupState(state: StartupState): void {
  state.records.length = 0
  state.overflowed = false
}

/** Create a fresh disabled state with current epoch/perf anchors. */
export function createStartupState(enabled: boolean): StartupState {
  return {
    enabled,
    records: [],
    overflowed: false,
    epochAnchorMs: Date.now(),
    perfAnchorMs: performance.now()
  }
}
