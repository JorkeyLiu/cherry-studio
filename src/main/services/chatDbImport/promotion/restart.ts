/**
 * Post-promotion restart strategy (LOCK-PROD-7).
 *
 * Packaged mode retains the reliable `app.relaunch()` exact-once behavior
 * (see ./relaunch.ts — unchanged). Development/E2E non-packaged mode must
 * NOT call `app.relaunch()` into a dead Vite server; instead it uses a
 * testable in-process renderer reload/recreation path that runs ONLY after
 * SQLite is reopened/verified and the one-shot navigation projection is
 * ready. No process manager and no Vite ownership subsystem.
 *
 * The in-process reload is idempotent and recoverable: a failure to reload
 * leaves the app running with the already-installed chat.db and the pending
 * projection row — the next startup (or a manual reload) applies it.
 *
 * LOCK-FR3: the reload is exact-once PER RECOVERY (per executor), not per
 * process. Each recovery executor owns one {@link InProcessReloadGuard}; a
 * later independent recovery in the same process creates its own guard and
 * may request its own reload. Duplicate/stale settlement from the SAME
 * recovery stays idempotent through its own guard. The old process-global
 * consumed flag is retained only as the default for direct callers/tests —
 * production always passes a per-recovery guard, so a second import is never
 * blocked.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import { loggerService } from '@logger'

const logger = loggerService.withContext('chatDbImportPromotionRestart')

// ---------------------------------------------------------------------------
// Restart mode
// ---------------------------------------------------------------------------

/**
 * Closed discriminated union for the post-promotion restart strategy.
 * - `relaunch`          — packaged mode: app.relaunch() + app.exit(0) (exact
 *                         existing behavior, ./relaunch.ts).
 * - `in-process-reload` — non-packaged mode: reload/recreate the main
 *                         renderer in-process; the process never exits.
 */
export type RestartMode = 'relaunch' | 'in-process-reload'

/**
 * Resolve the restart mode from the Electron `app` surface.
 * Packaged → `relaunch`; anything else (dev, Playwright E2E `electron .`)
 * → `in-process-reload` (LOCK-PROD-7).
 */
export function resolveRestartMode(app: { isPackaged: boolean }): RestartMode {
  return app.isPackaged ? 'relaunch' : 'in-process-reload'
}

// ---------------------------------------------------------------------------
// In-process reload primitive
// ---------------------------------------------------------------------------

/** Narrow webContents surface needed for the in-process reload. */
export interface ReloadableWebContents {
  isDestroyed(): boolean
  reload(): void
}

/** Injectable Electron app surface for mode resolution (test seam). */
export interface RestartAppSurface {
  isPackaged: boolean
}

/**
 * Per-recovery exact-once reload guard (LOCK-FR3).
 *
 * One guard per recovery/executor: a single recovery may request the
 * in-process renderer reload at most once; a LATER independent recovery
 * (a second import in the same process) creates its own guard and may
 * reload again. The guard is consumed even when the reload is a bounded
 * no-op (missing/destroyed/throwing target), so duplicate/stale settlement
 * from the same recovery never triggers a second reload.
 */
export interface InProcessReloadGuard {
  /** Atomically consume the guard. Returns false when already consumed. */
  tryConsume(): boolean
}

/** Create a fresh per-recovery exact-once reload guard. */
export function createInProcessReloadGuard(): InProcessReloadGuard {
  let consumed = false
  return {
    tryConsume() {
      if (consumed) return false
      consumed = true
      return true
    }
  }
}

/**
 * Reload the main renderer in-process (non-packaged path, LOCK-PROD-7).
 * Requires SQLite reopened/verified + one-shot projection ready — the
 * recovery executor only calls this after those preconditions hold.
 *
 * Exact-once per recovery (LOCK-FR3): when a `guard` is supplied, the first
 * call consumes it and triggers the reload; subsequent calls with the same
 * guard no-op. Without a guard, the module-level fallback guard applies
 * (direct callers/tests only — production always passes a per-recovery
 * guard). A missing/destroyed webContents is a bounded no-op (recoverable —
 * the pending projection row retries on next startup). A throwing `reload()`
 * is likewise a bounded no-op: the app keeps running with the
 * already-installed chat.db and the pending projection retries on the next
 * startup. Never rejects.
 */
export function reloadMainRenderer(
  webContents: ReloadableWebContents | null | undefined,
  ownerId: string,
  guard: InProcessReloadGuard = moduleReloadGuard
): { ok: true; reloaded: boolean } {
  if (!guard.tryConsume()) {
    logger.info(`In-process renderer reload already requested (owner: ${ownerId}) — exact-once guard`)
    return { ok: true, reloaded: false }
  }

  if (!webContents || webContents.isDestroyed()) {
    logger.warn(
      `In-process renderer reload refused: main window unavailable ` +
        `(owner: ${ownerId}) — pending projection retained for next startup`
    )
    return { ok: true, reloaded: false }
  }

  try {
    logger.info(`Requesting in-process main renderer reload (owner: ${ownerId})`)
    webContents.reload()
    return { ok: true, reloaded: true }
  } catch (error) {
    logger.warn(
      `In-process renderer reload failed (owner: ${ownerId}) — ` + `pending projection retained for next startup`,
      error as Error
    )
    return { ok: true, reloaded: false }
  }
}

/**
 * Module-level fallback exact-once guard. Production never consumes it (the
 * recovery executor always passes a per-recovery guard, LOCK-FR3); it is the
 * default for direct callers and the test seam. Reset only by tests.
 */
let reloadConsumed = false
const moduleReloadGuard: InProcessReloadGuard = {
  tryConsume() {
    if (reloadConsumed) return false
    reloadConsumed = true
    return true
  }
}

/**
 * Test-only: reset the module-level fallback guard so each test starts
 * clean. Never call from production.
 */
export function resetInProcessReloadGuardForTests(): void {
  reloadConsumed = false
}

// ---------------------------------------------------------------------------
// Main renderer webContents registration (importControlIpc → recovery)
// ---------------------------------------------------------------------------

/**
 * The main renderer webContents used for the in-process reload. Registered
 * by the import control layer when the main window is available; the
 * startup recovery gate runs BEFORE window creation, so the default (null)
 * makes the reload a bounded no-op there (startup simply proceeds and the
 * fresh renderer applies the projection).
 */
let mainRendererWebContents: ReloadableWebContents | null = null

/** Register the main renderer webContents (idempotent; null clears). */
export function registerMainRendererWebContents(webContents: ReloadableWebContents | null): void {
  mainRendererWebContents = webContents
}

/** Current registered main renderer webContents, or null. */
export function getMainRendererWebContents(): ReloadableWebContents | null {
  return mainRendererWebContents
}

/** Test-only: reset the registered webContents. */
export function resetMainRendererWebContentsForTests(): void {
  mainRendererWebContents = null
}
