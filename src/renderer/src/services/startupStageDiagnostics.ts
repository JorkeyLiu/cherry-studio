/**
 * Renderer-process startup stage instrumentation adapter (S7.13, S7.14-E1).
 *
 * Independent default-off/fail-closed synthetic-disposable-profile-only
 * harness. Never changes production startup semantics.
 *
 * Gates (all must pass, LOCK-003):
 *  1. Build define `__STARTUP_STAGE_ATTR__ === 'true'`
 *  2. Runtime env `STARTUP_STAGE_ATTR=1|true` (via window.electron.process.env or process.env)
 *  3. Synthetic disposable profile validation: `STARTUP_STAGE_SYNTHETIC=1|true`
 *     AND lexical owned-root check (TMPDIR/TMP/TEMP contains cherry-e2e-owned-*
 *     or is the owned root). Renderer cannot directly validate userDataDir
 *     without IPC/preload contract; its enablement is considered valid only
 *     when Main has positively validated the exact disposable profile via the
 *     harness-level disposable guarantee. This lexical check is best-effort
 *     without using substring heuristics as positive proof; production
 *     disposable profiles are always under an owned root, so the Main exact
 *     validation is authoritative.
 *
 * Records are bounded/privacy-safe via shared primitives (LOCK-002).
 * Idempotent per stage — retries/re-renders guard against duplicate marks.
 * No Dexie open is forced. S7.13: bootstrap → persistRehydrate →
 * importProjectionReady → ordinaryTreeReady. S7.14-E1 adds renderer.firstData:
 * elapsed from ordinaryTreeReady to the first active-topic fetchMessagesWindow
 * settlement (one-shot, bounded numeric-only, default-off, fail-closed).
 */

import { loggerService } from '@logger'
import {
  appendStartupRecord,
  createStartupState,
  resolveStartupStageGate,
  resolveSyntheticGate,
  STARTUP_STAGE_VALIDATED_ENV,
  startupBuildValue,
  type StartupRecord,
  type StartupStage,
  type StartupStageStatus,
  type StartupState
} from '@shared/diagnostics/startupStage'

const logger = loggerService.withContext('StartupStage')

function getRuntimeEnv(name: string): string | undefined {
  // Prefer window.electron.process.env (Electron renderer), fallback to process.env (vitest/jsdom)
  try {
    const winAny = window as unknown as { electron?: { process?: { env?: Record<string, string> } } }
    const fromElectron = winAny.electron?.process?.env?.[name]
    if (typeof fromElectron === 'string') return fromElectron
  } catch {}
  try {
    const fromProcess = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.[name]
    if (typeof fromProcess === 'string') return fromProcess
  } catch {}
  // Also check process.env directly (vitest defines it)
  try {
    // @ts-ignore
    const direct = process?.env?.[name]
    if (typeof direct === 'string') return direct
  } catch {}
  return undefined
}

function isBuildGateEnabled(): boolean {
  const buildValue = startupBuildValue()
  if (buildValue === undefined) return false
  try {
    return resolveStartupStageGate(buildValue)
  } catch {
    return false
  }
}

function isRuntimeGateEnabled(): boolean {
  const runtimeValue = getRuntimeEnv('STARTUP_STAGE_ATTR')
  try {
    return resolveStartupStageGate(runtimeValue)
  } catch {
    return false
  }
}

function isSyntheticValid(): boolean {
  const syntheticRaw = getRuntimeEnv('STARTUP_STAGE_SYNTHETIC')
  if (syntheticRaw === undefined || syntheticRaw.trim().length === 0) return false
  let syntheticEnabled = false
  try {
    syntheticEnabled = resolveSyntheticGate(syntheticRaw)
  } catch {
    return false
  }
  if (!syntheticEnabled) return false
  // Main-authoritative opaque marker required — never accept synthetic token alone
  const marker = getRuntimeEnv(STARTUP_STAGE_VALIDATED_ENV)
  if (marker !== '1') return false
  // Isolated Vitest: token+marker suffices for focused unit tests (no disposable profile)
  try {
    const vitest = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.VITEST
    if (vitest === 'true') return true
  } catch {}
  // Production/E2E: require lexical owned-root proof (TMPDIR/TMP/TEMP) to tie synthetic token to disposable profile.
  // Renderer cannot directly validate userDataDir without IPC; this checks that the harness launched with an owned root
  // (cherry-e2e-owned-*), which the fixture guarantees is the parent of the disposable profile. Main's exact
  // userData descendant check is authoritative; this prevents token-only enablement without disposable profile.
  const tmpCandidates = [getRuntimeEnv('TMPDIR'), getRuntimeEnv('TMP'), getRuntimeEnv('TEMP')].filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  )
  for (const cand of tmpCandidates) {
    if (cand.split(/[\\/]/).some((seg) => seg === '..')) continue
    // Lexical absolute check: must be absolute path
    const isAbs = cand.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cand)
    if (!isAbs) continue
    // Exact owned-root segment check: path must contain a segment starting with cherry-e2e-owned-
    const segments = cand.split(/[\\/]/)
    if (segments.some((s) => s.startsWith('cherry-e2e-owned-'))) return true
  }
  // If no TMPDIR proves owned root, renderer stays inert (fail-closed). This is the remaining limitation:
  // renderer cannot positively prove userData descendant without IPC; Main's exact validation plus harness
  // disposable guarantee are required. E2E validates Main's exact profile and epochComparable to cover this.
  return false
}

function computeEnabled(): boolean {
  if (!isBuildGateEnabled()) return false
  if (!isRuntimeGateEnabled()) return false
  if (!isSyntheticValid()) return false
  return true
}

const initialEnabled = computeEnabled()

const startupState: StartupState = createStartupState(initialEnabled)

// S7.14-E1: first ordinary window-data settlement attribution — timestamp after
// ordinaryTreeReady, one-shot bounded numeric-only. Fail-closed when no ready.
// Eligibility requires ordinaryTreeReady timestamp and active-topic settlement;
// stale/no-topic/unrelated loads must not be attributed (LOCK-003). Without a
// cross-process active-topic contract, the diagnostic stays fail-closed rather
// than inferring eligibility from arbitrary topic IDs.
let ordinaryTreeReadyPerfMs: number | null = null
let firstDataRecorded = false

export function isStartupStageEnabled(): boolean {
  return computeEnabled()
}

function isEffectivelyEnabled(): boolean {
  if (!initialEnabled) return false
  return computeEnabled()
}

export function readStartupState(): StartupState {
  return startupState
}

export function resetStartupState(): void {
  // Preserve isolated test reset capability (Vitest) but keep enabled
  // application bundles from violating per-session dedup via runtime reset.
  const vitest = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.VITEST
  if (vitest !== 'true' && isEffectivelyEnabled()) return
  startupState.records.length = 0
  startupState.overflowed = false
  ordinaryTreeReadyPerfMs = null
  firstDataRecorded = false
}

function recordInternal(stage: StartupStage, durationMs: number, status: StartupStageStatus, reason?: string): void {
  if (!isEffectivelyEnabled()) return
  const elapsedMs = performance.now() - startupState.perfAnchorMs
  const epochMs = startupState.epochAnchorMs + elapsedMs
  const record: StartupRecord = { stage, status, reason, durationMs, epochMs, elapsedMs }
  const before = startupState.records.length
  appendStartupRecord(startupState, record)
  if (startupState.records.length > before) {
    logger.info(`[startupStage] ${stage}`, {
      status,
      reason: reason ?? 'ok',
      durationMs,
      elapsedMs,
      epochMs
    })
  }
}

export function recordStartupStage(
  stage: StartupStage,
  durationMs: number,
  status: StartupStageStatus = 'ok',
  reason?: string
): void {
  recordInternal(stage, durationMs, status, reason)
}

/**
 * Idempotent mark: record once per stage; subsequent calls are no-ops.
 * Duration is measured from given startPerfMs; if not provided, uses
 * elapsed since anchor (so caller must pass performance.now() captured at
 * boundary start).
 */
export function markStartupStage(
  stage: StartupStage,
  startPerfMs: number,
  status: StartupStageStatus = 'ok',
  reason?: string
): void {
  if (!isEffectivelyEnabled()) return
  if (startupState.records.some((r) => r.stage === stage)) return
  const duration = performance.now() - startPerfMs
  if (!Number.isFinite(duration) || duration < 0) return
  recordInternal(stage, duration, status, reason)
}

/**
 * Guarded helper for React render boundaries: never place non-idempotent marks
 * directly in render; call this from useEffect or callback only once.
 */
export function markStartupStageOnce(
  stage: StartupStage,
  startPerfMs: number,
  status: StartupStageStatus = 'ok',
  reason?: string
): boolean {
  if (!isEffectivelyEnabled()) return false
  if (startupState.records.some((r) => r.stage === stage)) return false
  markStartupStage(stage, startPerfMs, status, reason)
  return true
}

/**
 * Milestone helper when duration should equal elapsed since anchor (e.g.
 * gate-ready boundaries). Records with duration = elapsedMs, keeping both
 * epoch and elapsed aligned on the comparable timeline.
 */
export function markStartupMilestone(stage: StartupStage, status: StartupStageStatus = 'ok', reason?: string): void {
  if (!isEffectivelyEnabled()) return
  if (startupState.records.some((r) => r.stage === stage)) return
  const now = performance.now()
  const elapsed = now - startupState.perfAnchorMs
  if (!Number.isFinite(elapsed) || elapsed < 0) return
  recordInternal(stage, elapsed, status, reason)
  // S7.14-E1: capture timestamp after ordinaryTreeReady for first-data interval.
  // Only once per startup, fail-closed when disabled, numeric-only.
  if (stage === 'renderer.ordinaryTreeReady' && ordinaryTreeReadyPerfMs === null) {
    // Use the same `now` that was used for the milestone to keep interval
    // deterministic and bounded; subsequent settlements compute interval from here.
    ordinaryTreeReadyPerfMs = now
  }
}

/**
 * S7.14-E1: record first active-topic fetchMessagesWindow settlement interval.
 * Elapsed from ordinaryTreeReady timestamp to now; bounded, privacy-safe,
 * one-shot, ordered after ordinaryTreeReady. Fail-closed when no ready or
 * disabled or already recorded.
 */
export function markFirstDataSettlement(status: StartupStageStatus = 'ok', reason?: string): boolean {
  if (!isEffectivelyEnabled()) return false
  if (firstDataRecorded) return false
  if (ordinaryTreeReadyPerfMs === null) return false
  if (startupState.records.some((r) => r.stage === 'renderer.firstData')) return false
  const now = performance.now()
  const interval = now - ordinaryTreeReadyPerfMs
  if (!Number.isFinite(interval) || interval < 0) return false
  const before = startupState.records.length
  recordInternal('renderer.firstData', interval, status, reason)
  if (startupState.records.length > before) {
    firstDataRecorded = true
    return true
  }
  return false
}

/**
 * Whether a first-data settlement could be recorded right now (ordinaryTreeReady
 * has occurred, not yet recorded, diagnostic enabled). Does not check topic
 * eligibility — caller must verify active-topic if needed. Fail-closed.
 */
export function canRecordFirstDataNow(): boolean {
  if (!isEffectivelyEnabled()) return false
  if (firstDataRecorded) return false
  if (ordinaryTreeReadyPerfMs === null) return false
  if (startupState.records.some((r) => r.stage === 'renderer.firstData')) return false
  return true
}

/**
 * S7.14-E1 — consume the one-shot first-data window without recording.
 * Called for the first startup candidate that is ineligible (invalid/missing/
 * cache-hit) so later History/navigation/force loads cannot emit
 * renderer.firstData. Fail-closed when disabled or no ready or already
 * consumed/recorded. Returns true when window was open and is now consumed.
 */
export function consumeFirstDataWindow(): boolean {
  if (!isEffectivelyEnabled()) return false
  if (firstDataRecorded) return false
  if (ordinaryTreeReadyPerfMs === null) return false
  if (startupState.records.some((r) => r.stage === 'renderer.firstData')) return false
  firstDataRecorded = true
  return true
}

/**
 * Whether ordinaryTreeReady has been marked in this session.
 */
export function hasOrdinaryTreeReady(): boolean {
  return ordinaryTreeReadyPerfMs !== null
}

/**
 * Attach one-shot settlement instrumentation to the first active-topic
 * fetchMessagesWindow promise. Preserves all existing promise semantics:
 * does not change error handling, no extra IPC, no content recorded.
 * Settlement (resolve or reject) records renderer.firstData once with
 * bounded numeric-only interval from ordinaryTreeReady.
 * Optional `isStillEligible` is evaluated at settlement time to discard
 * stale/no-topic or topic-moved settlements without attribution. If it
 * returns false, the settlement is ignored (fail-closed).
 */
export function instrumentFirstDataWindow(promise: Promise<unknown>, isStillEligible?: () => boolean): void {
  if (!isEffectivelyEnabled()) return
  if (firstDataRecorded) return
  if (ordinaryTreeReadyPerfMs === null) return
  if (startupState.records.some((r) => r.stage === 'renderer.firstData')) return
  try {
    void promise.then(
      () => {
        try {
          if (isStillEligible && !isStillEligible()) return
          markFirstDataSettlement('ok')
        } catch {}
      },
      () => {
        try {
          if (isStillEligible && !isStillEligible()) return
          markFirstDataSettlement('error')
        } catch {}
      }
    )
  } catch {}
}

// Test seam — always exposed; reflects current effective enabled state.
const globalAny = globalThis as Record<string, unknown>
globalAny.__startupStageRead = () => {
  const eff = isEffectivelyEnabled()
  if (!eff) return { enabled: false, records: [], overflowed: false, epochAnchorMs: 0, perfAnchorMs: 0 }
  return { ...startupState, records: [...startupState.records] }
}
globalAny.__startupStageReset = () => {
  const vitest = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.VITEST
  if (vitest !== 'true' && isEffectivelyEnabled()) return
  resetStartupState()
}
globalAny.__startupStageEnabled = () => isEffectivelyEnabled()
globalAny.__startupStageFirstDataStateForTest = () => ({
  ordinaryTreeReadyPerfMs,
  firstDataRecorded
})

// Export for E2E validation of synthetic gate
export { getRuntimeEnv as _getRuntimeEnvForTest }
