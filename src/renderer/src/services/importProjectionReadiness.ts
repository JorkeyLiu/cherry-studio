/**
 * Renderer boot readiness primitive for the one-shot L2 navigation
 * projection (LOCK-PROD-6, LOCK-001, LOCK-PROJECTION).
 *
 * The confirmed post-import startup race: the persistStore callback
 * fire-and-forgets `applyPendingImportProjection` while PersistGate releases
 * the ordinary chat tree immediately, so stale redux-persist navigation can
 * mount Home/useActiveTopic and call Main `fetchMessages` (topic priming)
 * BEFORE the pending import projection replaces/flushes/acks the imported
 * navigation — reinserting a stale pre-import topic into SQLite (LOCK-001).
 *
 * This primitive gates the ordinary chat tree: it settles to `ready` ONLY
 * when `applyPendingImportProjection` successfully returns `true` (applied
 * + durably flushed) or `false` (verified no-pending) WITHOUT an API
 * failure. On failure it settles to `failed` — the tree stays gated, the
 * pending row stays unacked for next-startup retry (LOCK-PROJECTION: never
 * mount the ordinary chat tree with stale state), and no infinite retry is
 * attempted.
 *
 * The module is deliberately tiny and dependency-free (only @logger) so it
 * carries no import cycle with `@renderer/store` and can be imported by both
 * the store (which settles it) and the App gate (which subscribes).
 */

import { loggerService } from '@logger'

const logger = loggerService.withContext('ImportProjectionReadiness')

export type ImportProjectionReadinessState = 'pending' | 'ready' | 'failed'

let state: ImportProjectionReadinessState = 'pending'
const listeners = new Set<() => void>()

/** True only after the projection has safely settled (applied or no-pending). */
export function isImportProjectionReady(): boolean {
  return state === 'ready'
}

/** Raw state — tests distinguish `pending` (still applying) from `failed`. */
export function getImportProjectionReadinessState(): ImportProjectionReadinessState {
  return state
}

/** Subscribe to settlement; returns an unsubscribe function. */
export function subscribeImportProjectionReadiness(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Settle the readiness exactly once — the first call wins, later calls are
 * no-ops (a failure after a successful settle never re-gates an opened tree,
 * and a late "ready" after a failure never opens a gated tree).
 */
export function settleImportProjectionReadiness(next: Exclude<ImportProjectionReadinessState, 'pending'>): void {
  if (state !== 'pending') {
    return
  }
  state = next
  for (const listener of [...listeners]) {
    listener()
  }
}

/**
 * Test-only: reset to `pending` so each test controls its own settle path.
 * Listeners persist; a fresh settle re-notifies them.
 */
export function resetImportProjectionReadiness(): void {
  state = 'pending'
}

/** Dependencies injected by the store (post-rehydrate), not imported. */
export interface ImportProjectionBootDeps {
  /**
   * The one-shot projection apply (`applyPendingImportProjection` with
   * injected dispatch/flush). Resolves `true` when a projection was applied
   * and durably flushed, `false` when none was pending; rejects on API
   * failure (the pending row is retained for next-startup retry).
   */
  apply: () => Promise<boolean>
  /**
   * Main-process `ReduxStoreReady` notification. MUST run only after the
   * readiness has settled successfully.
   */
  notifyMain: () => void
}

/**
 * LOCK-PROJECTION boot wiring: apply → settle → notify.
 *
 * The ordinary chat tree stays gated and Main is NOT notified until the
 * apply either applied the projection (`true`) or verified none is pending
 * (`false`). On apply failure the pending row stays unacked, readiness
 * settles `failed` (tree stays gated), and the error is logged — the next
 * startup retries. A `notifyMain` failure is a side-channel only: the
 * projection has already settled, so the tree still opens.
 *
 * Never throws — the caller fire-and-forgets with `.catch` as a defensive
 * guard only.
 */
export async function runImportProjectionBoot(deps: ImportProjectionBootDeps): Promise<'ready' | 'failed'> {
  let applied: boolean
  try {
    applied = await deps.apply()
  } catch (error) {
    logger.error('Failed to apply pending import navigation projection (retained for retry):', error as Error)
    settleImportProjectionReadiness('failed')
    return 'failed'
  }

  settleImportProjectionReadiness('ready')
  try {
    deps.notifyMain()
  } catch (error) {
    // Side-channel only: the projection settled, so the tree opens regardless.
    logger.warn('ReduxStoreReady notification failed (projection already settled):', error as Error)
  }
  logger.info(`Import navigation projection readiness settled (applied=${applied})`)
  return 'ready'
}
