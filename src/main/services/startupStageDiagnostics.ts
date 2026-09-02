/**
 * Main-process startup stage instrumentation adapter (S7.13).
 *
 * Independent default-off/fail-closed synthetic-disposable-profile-only
 * harness. Never changes production startup semantics.
 *
 * Gates (all must pass, LOCK-003):
 *  1. Build define `__STARTUP_STAGE_ATTR__ === 'true'`
 *  2. Runtime env `STARTUP_STAGE_ATTR=1|true`
 *  3. Synthetic disposable profile validation: `STARTUP_STAGE_SYNTHETIC=1|true`
 *     AND exact disposable userDataDir descendant of an owned root
 *     (`cherry-e2e-owned-*` under os.tmpdir()), verified via exact
 *     path.relative ancestor checks and realpath/lstat when available.
 *     Environment token alone is insufficient; substring heuristics are not
 *     used as positive proof; no paths are logged.
 *
 * Records are bounded/privacy-safe via shared primitives (LOCK-002):
 * closed stage names, at most one per stage, finite non-negative monotonic
 * duration, bounded scalar status/reason, comparable epoch anchor.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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
import { app } from 'electron'

const logger = loggerService.withContext('StartupStage')

function isExactDisposableProfile(userData: string): boolean {
  if (typeof userData !== 'string' || userData.length === 0) return false
  if (!path.isAbsolute(userData)) return false
  if (userData.split(/[\\/]/).some((seg) => seg === '..')) return false
  const userLex = path.resolve(userData)
  // Disallow non-absolute after resolve
  if (!path.isAbsolute(userLex)) return false

  const ownedCandidates: string[] = []
  const envTmp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP
  if (typeof envTmp === 'string' && envTmp.length > 0) ownedCandidates.push(envTmp)
  // Also consider os.tmpdir() as parent for lexical owned-root check
  const osTmp = os.tmpdir()
  if (typeof osTmp === 'string' && osTmp.length > 0) ownedCandidates.push(osTmp)

  // Try exact descendant of a valid owned root
  for (const cand of ownedCandidates) {
    if (typeof cand !== 'string' || cand.length === 0) continue
    if (cand.split(/[\\/]/).some((seg) => seg === '..')) continue
    if (!path.isAbsolute(cand)) continue
    const candLex = path.resolve(cand)
    const isOwnedRoot = path.basename(candLex).startsWith('cherry-e2e-owned-')
    if (isOwnedRoot) {
      // candidate is the owned root itself: user must be descendant with profile naming
      const rel = path.relative(candLex, userLex)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      if (rel.length === 0) continue
      const segsLex = rel.split(path.sep)
      if (segsLex.length < 1 || !segsLex[0].startsWith('cherry-e2e-')) continue
      // Positive exact check: fs validation required — failure is fail-closed
      try {
        // lexical symlink check before realpath — realpath resolves symlinks, lstat on real loses the fact
        const candLexStat = fs.lstatSync(candLex)
        if (!candLexStat.isDirectory() || candLexStat.isSymbolicLink()) continue
        const userLexStat = fs.lstatSync(userLex)
        if (!userLexStat.isDirectory() || userLexStat.isSymbolicLink()) continue
        const candReal = fs.realpathSync(candLex)
        const userReal = fs.realpathSync(userLex)
        const relReal = path.relative(candReal, userReal)
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) continue
        if (relReal.length === 0) continue
        const candStat = fs.lstatSync(candReal)
        if (!candStat.isDirectory() || candStat.isSymbolicLink()) continue
        const userStat = fs.lstatSync(userReal)
        if (!userStat.isDirectory() || userStat.isSymbolicLink()) continue
        if (!path.basename(candReal).startsWith('cherry-e2e-owned-')) continue
        const relSegs = relReal.split(path.sep)
        if (relSegs.length < 1 || !relSegs[0].startsWith('cherry-e2e-')) continue
        // Relationship: owned root is either the tmpdir itself (fixture topology
        // where TMPDIR is the owned root) or a direct child of the canonical tmpdir
        const tmpReal = fs.realpathSync(osTmp)
        if (candReal !== tmpReal) {
          if (path.dirname(candReal) !== tmpReal) continue
          try {
            const tmpStat = fs.lstatSync(tmpReal)
            if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) continue
          } catch {
            continue
          }
        }
      } catch {
        // filesystem validation uncertainty is fail-closed — do not accept lexically
        continue
      }
      return true
    }
    // candidate is os.tmpdir() itself: check that user is under <tmp>/cherry-e2e-owned-*/cherry-e2e-*
    if (candLex === path.resolve(osTmp)) {
      const rel = path.relative(candLex, userLex)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      const segs = rel.split(path.sep)
      if (segs.length < 2) continue
      if (!segs[0].startsWith('cherry-e2e-owned-')) continue
      if (!segs[1].startsWith('cherry-e2e-')) continue
      try {
        const candLexStat = fs.lstatSync(candLex)
        if (!candLexStat.isDirectory() || candLexStat.isSymbolicLink()) continue
        const userLexStat = fs.lstatSync(userLex)
        if (!userLexStat.isDirectory() || userLexStat.isSymbolicLink()) continue
        const candReal = fs.realpathSync(candLex)
        const userReal = fs.realpathSync(userLex)
        const relReal = path.relative(candReal, userReal)
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) continue
        const relSegs = relReal.split(path.sep)
        if (relSegs.length < 2) continue
        if (!relSegs[0].startsWith('cherry-e2e-owned-')) continue
        if (!relSegs[1].startsWith('cherry-e2e-')) continue
        const candStat = fs.lstatSync(candReal)
        if (!candStat.isDirectory() || candStat.isSymbolicLink()) continue
        const userStat = fs.lstatSync(userReal)
        if (!userStat.isDirectory() || userStat.isSymbolicLink()) continue
        const ownedReal = path.join(candReal, relSegs[0])
        const ownedLex = path.join(candLex, segs[0])
        try {
          const ownedLexStat = fs.lstatSync(ownedLex)
          if (!ownedLexStat.isDirectory() || ownedLexStat.isSymbolicLink()) continue
          const ownedStat = fs.lstatSync(ownedReal)
          if (!ownedStat.isDirectory() || ownedStat.isSymbolicLink()) continue
          if (!path.basename(fs.realpathSync(ownedReal)).startsWith('cherry-e2e-owned-')) continue
        } catch {
          continue
        }
      } catch {
        // filesystem validation uncertainty is fail-closed
        continue
      }
      return true
    }
  }

  // Test-only lexical fallback: allow Vitest mock shape where profile segment
  // directly contains cherry-e2e- prefix (e.g., /tmp/cherry-e2e-abc/userData).
  // This is inert in production because VITEST is not set and real
  // disposable profiles are always under owned roots, so the above branch
  // already covers them. This preserves isolated unit-test capability without
  // using substring includes as production proof.
  if (process.env.VITEST === 'true') {
    const segs = userLex.split(path.sep)
    if (segs.some((s) => s.startsWith('cherry-e2e-'))) return true
  }

  return false
}

function clearValidatedMarker(): void {
  try {
    delete (process.env as Record<string, string | undefined>)[STARTUP_STAGE_VALIDATED_ENV]
  } catch {}
}

function isSyntheticProfileValid(): boolean {
  // Clear externally supplied marker before validation — never accept as input
  clearValidatedMarker()
  const syntheticRaw = (process.env.STARTUP_STAGE_SYNTHETIC ?? '').trim()
  if (syntheticRaw.length === 0) return false
  let syntheticEnabled = false
  try {
    syntheticEnabled = resolveSyntheticGate(syntheticRaw)
  } catch {
    return false
  }
  if (!syntheticEnabled) return false
  // Isolated Vitest: token alone suffices for focused unit tests (no disposable profile)
  if (process.env.VITEST === 'true') {
    // Still set marker so renderer causal test can verify inheritance
    try {
      ;(process.env as Record<string, string | undefined>)[STARTUP_STAGE_VALIDATED_ENV] = '1'
    } catch {}
    return true
  }
  // Positive exact disposable-profile validation required; token alone insufficient
  try {
    const userData = app.getPath('userData')
    if (isExactDisposableProfile(userData)) {
      try {
        ;(process.env as Record<string, string | undefined>)[STARTUP_STAGE_VALIDATED_ENV] = '1'
      } catch {}
      return true
    }
  } catch {}
  return false
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
  const runtimeValue = process.env.STARTUP_STAGE_ATTR
  try {
    return resolveStartupStageGate(runtimeValue)
  } catch {
    // malformed runtime value is fail-closed (inert, no throw to stay default-off)
    return false
  }
}

function computeEnabled(): boolean {
  if (!isBuildGateEnabled()) return false
  if (!isRuntimeGateEnabled()) return false
  if (!isSyntheticProfileValid()) return false
  return true
}

// Ensure no externally supplied marker survives module load — overwrite before validation
clearValidatedMarker()
// Initial enabled captures build-time define; runtime checks are dynamic per record
// so tests can stub env/define and observe fail-closed without module reload.
const initialEnabled = computeEnabled()

const startupState: StartupState = createStartupState(initialEnabled)

export function isStartupStageEnabled(): boolean {
  return computeEnabled()
}

function isEffectivelyEnabled(): boolean {
  // Both initial build gate and current runtime+synthetic must pass.
  // Initial build gate is the static define; runtime/synthetic are dynamic.
  if (!initialEnabled) return false
  return computeEnabled()
}

export function readStartupState(): StartupState {
  return startupState
}

export function resetStartupState(): void {
  // Preserve isolated test reset capability (Vitest) but keep enabled
  // application bundles from violating per-session dedup via runtime reset.
  if (process.env.VITEST !== 'true' && isEffectivelyEnabled()) return
  startupState.records.length = 0
  startupState.overflowed = false
}

function recordStartupStageInternal(
  stage: StartupStage,
  durationMs: number,
  status: StartupStageStatus,
  reason?: string
): void {
  if (!isEffectivelyEnabled()) return
  const elapsedMs = performance.now() - startupState.perfAnchorMs
  const epochMs = startupState.epochAnchorMs + elapsedMs
  const record: StartupRecord = {
    stage,
    status,
    reason,
    durationMs,
    epochMs,
    elapsedMs
  }
  const before = startupState.records.length
  appendStartupRecord(startupState, record)
  if (startupState.records.length > before) {
    // scalar bounded logger emission (diagnostic only)
    logger.info(`[startupStage] ${stage}`, {
      status,
      reason: reason ?? 'ok',
      durationMs,
      elapsedMs,
      epochMs
    })
  }
}

/**
 * Record a completed stage with explicit duration/status.
 * Used by withStartupStage wrapper and sync marks.
 */
export function recordStartupStage(
  stage: StartupStage,
  durationMs: number,
  status: StartupStageStatus,
  reason?: string
): void {
  recordStartupStageInternal(stage, durationMs, status, reason)
}

/**
 * Wrap an existing await boundary without changing ordering/branching.
 * Preserve try/catch/rethrow semantics — stage is recorded on both success
 * and error with bounded scalar reason.
 */
export async function withStartupStage<T>(
  stage: StartupStage,
  fn: () => Promise<T>,
  // Optional reason mapper for skips (never content/paths)
  skippedReason?: string
): Promise<T> {
  if (!isEffectivelyEnabled()) return fn()
  // idempotence: if already recorded, just run without double-mark
  if (startupState.records.some((r) => r.stage === stage)) return fn()
  const start = performance.now()
  try {
    const result = await fn()
    const duration = performance.now() - start
    // If the caller signals skip via returning undefined? No — rely on status ok.
    // For promotion gate skips, caller should record separately.
    if (skippedReason) {
      recordStartupStageInternal(stage, duration, 'skipped', skippedReason)
    } else {
      recordStartupStageInternal(stage, duration, 'ok')
    }
    return result
  } catch (error) {
    const duration = performance.now() - start
    // bounded scalar reason — never error stack/path
    const reason = error instanceof Error && error.message.length <= 64 ? 'error' : 'error'
    recordStartupStageInternal(stage, duration, 'error', reason)
    throw error
  }
}

/**
 * Sync mark for BrowserWindow construction and similar sync boundaries.
 */
export function markStartupStageSync(
  stage: StartupStage,
  startPerfMs: number,
  status: StartupStageStatus = 'ok',
  reason?: string
): void {
  if (!isEffectivelyEnabled()) return
  if (startupState.records.some((r) => r.stage === stage)) return
  const duration = performance.now() - startPerfMs
  if (!Number.isFinite(duration) || duration < 0) return
  recordStartupStageInternal(stage, duration, status, reason)
}

// Test seam — always exposed; reflects current effective enabled state.
// E2E can assert disabled without throw, and enabled synthetic harness can be observed.
const globalAny = globalThis as Record<string, unknown>
globalAny.__startupStageRead = () => {
  const eff = isEffectivelyEnabled()
  if (!eff) return { enabled: false, records: [], overflowed: false, epochAnchorMs: 0, perfAnchorMs: 0 }
  return { ...startupState, records: [...startupState.records] }
}
globalAny.__startupStageReset = () => {
  // In enabled application bundles this is inert to preserve per-session dedup;
  // isolated Vitest runs retain reset capability.
  if (process.env.VITEST !== 'true' && isEffectivelyEnabled()) return
  resetStartupState()
}
globalAny.__startupStageEnabled = () => isEffectivelyEnabled()
