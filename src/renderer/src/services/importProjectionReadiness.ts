/**
 * Renderer boot readiness primitives for the one-shot L2 navigation
 * projection (LOCK-PROD-6, LOCK-001, LOCK-PROJECTION) and the Redux
 * rehydration notification (LOCK-003).
 *
 * The confirmed post-import startup race: the persistStore callback
 * fire-and-forgets `applyPendingImportProjection` while PersistGate releases
 * the ordinary chat tree immediately, so stale redux-persist navigation can
 * mount Home/useActiveTopic and call Main `fetchMessages` (topic priming)
 * BEFORE the pending import projection replaces/flushes/acks the imported
 * navigation — reinserting a stale pre-import topic into SQLite (LOCK-001).
 *
 * `ImportProjectionReadiness` gates the ordinary chat tree: it settles to
 * `ready` ONLY when `applyPendingImportProjection` successfully returns
 * `true` (applied + durably flushed) or `false` (verified no-pending)
 * WITHOUT an API failure. On failure it settles to `failed` — the tree stays
 * gated, the pending row stays unacked for next-startup retry
 * (LOCK-PROJECTION: never mount the ordinary chat tree with stale state),
 * and no infinite retry is attempted.
 *
 * `ReduxStoreReady` is deliberately NOT coupled to the projection (LOCK-003):
 * the rehydrated store is safely selectable right after persistStore
 * rehydration, and Main's startup config reads only consume config slices
 * (settings/llm). The notification fires immediately in the rehydration
 * callback via `runReduxStoreBoot`, independently of projection outcome;
 * the projection continues to gate the ordinary chat tree on its own.
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
let storedApply: (() => Promise<boolean>) | null = null

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
  // S7.13: renderer.importProjectionReady milestone — gate-ready boundary.
  // Idempotent per startup, fail-closed, synthetic-only via diagnostics gate.
  // Dynamic import avoids cycle; if diagnostics not enabled the call is inert.
  if (next === 'ready') {
    void import('./startupStageDiagnostics')
      .then(({ markStartupMilestone }) => {
        try {
          markStartupMilestone('renderer.importProjectionReady')
        } catch {}
      })
      .catch(() => {})
  }
}

/**
 * Test-only: reset to `pending` so each test controls its own settle path.
 * Listeners persist; a fresh settle re-notifies them. Clears the captured
 * apply so retry without a fresh boot is a no-op.
 */
export function resetImportProjectionReadiness(): void {
  state = 'pending'
  storedApply = null
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
}

/**
 * LOCK-PROJECTION boot wiring: apply → settle.
 *
 * The ordinary chat tree stays gated until the apply either applied the
 * projection (`true`) or verified none is pending (`false`). On apply
 * failure the pending row stays unacked, readiness settles `failed` (tree
 * stays gated), and the error is logged — the next startup retries. The
 * ReduxStoreReady notification is NOT part of this flow (LOCK-003): it is
 * sent by `runReduxStoreBoot` at rehydration, before this boot runs.
 *
 * Never throws — the caller fire-and-forgets with `.catch` as a defensive
 * guard only.
 */
export async function runImportProjectionBoot(deps: ImportProjectionBootDeps): Promise<'ready' | 'failed'> {
  storedApply = deps.apply
  let applied: boolean
  try {
    applied = await deps.apply()
  } catch (error) {
    logger.error('Failed to apply pending import navigation projection (retained for retry):', error as Error)
    settleImportProjectionReadiness('failed')
    return 'failed'
  }

  settleImportProjectionReadiness('ready')
  logger.info(`Import navigation projection readiness settled (applied=${applied})`)
  return 'ready'
}

/** Dependencies injected by the store (post-rehydrate), not imported. */
export interface ReduxStoreBootDeps {
  /**
   * Main-process `ReduxStoreReady` notification. Fired immediately at
   * rehydration, independently of the projection outcome (LOCK-003). The
   * call is fire-and-forget in the store; a synchronous throw here is a
   * logged side-channel only.
   */
  notifyMain: () => void
  /** One-shot projection apply — same contract as `ImportProjectionBootDeps.apply`. */
  apply: () => Promise<boolean>
}

/**
 * LOCK-003 store boot wiring: notify Main → projection boot.
 *
 * Runs in the persistStore rehydration callback. The rehydrated store is
 * safely selectable the moment rehydration completes, so Main is notified
 * IMMEDIATELY — before and independently of the projection apply — then the
 * projection boot runs to gate the ordinary chat tree (LOCK-PROJECTION).
 * Main consumers read config slices only (settings/llm); the projection
 * affects navigation/assistants and stays gated by `ImportProjectionReadiness`.
 *
 * Never throws — a notification failure is a logged side-channel and the
 * projection boot still runs.
 */
export async function runReduxStoreBoot(deps: ReduxStoreBootDeps): Promise<'ready' | 'failed'> {
  storedApply = deps.apply
  try {
    deps.notifyMain()
  } catch (error) {
    // Side-channel only: the store is still selectable; the projection boot
    // runs regardless.
    logger.warn('ReduxStoreReady notification failed (store still selectable):', error as Error)
  }
  return runImportProjectionBoot({ apply: deps.apply })
}

/**
 * Retry the one-shot L2 navigation projection after a previous failure
 * (S7.2 renderer-local recovery).
 *
 * Only valid from `failed` — transitions `failed` → `pending` so the gate
 * shows the localized loading state again, then reruns the captured
 * `applyPendingImportProjection` path (dispatch → flush → ack). A successful
 * retry settles `ready` and opens the ordinary tree; a failed retry re-settles
 * `failed` and the tree stays gated. Pending/ready retries are no-ops.
 * Never acknowledges a failed projection before a successful flush — that
 * ordering is enforced by `applyPendingImportProjection` itself.
 */
export async function retryImportProjectionReadiness(): Promise<'ready' | 'failed' | 'noop'> {
  if (state !== 'failed') {
    return 'noop'
  }
  if (!storedApply) {
    logger.warn('Import projection retry requested without captured apply — cannot retry')
    return 'failed'
  }
  // failed -> pending so the gate shows loading again during the retry
  state = 'pending'
  for (const listener of [...listeners]) {
    listener()
  }
  return runImportProjectionBoot({ apply: storedApply })
}
