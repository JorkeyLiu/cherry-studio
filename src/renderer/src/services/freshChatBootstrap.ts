/**
 * Fresh-chat bootstrap marker (fresh-profile initial-topic ensure across
 * failed boots and relaunches).
 *
 * Problem: the ephemeral `persist:cherry-studio` absence snapshot only
 * describes the current boot. If the fresh-boot ensure fails (or the renderer
 * restarts before it completes), the next boot sees a persisted profile and
 * would never retry — leaving a fresh Redux initial topic without its Main
 * SQLite row (NOT_FOUND reads from HomePage).
 *
 * Marker lifecycle (deliberately narrow):
 * - SET synchronously during store module evaluation when the
 *   `persist:cherry-studio` compatibility key is absent — i.e. before
 *   redux-persist can write for this boot. Stored OUTSIDE the Redux persist
 *   payload (plain localStorage key) so it is independent of persist writes.
 * - SURVIVES ensure failure and renderer restart (localStorage is
 *   per-profile durable storage).
 * - CLEARED only after every current initial topic was successfully ensured
 *   create-only. Never cleared on read/ensure failure.
 * - ABSENT on an existing profile means never ensure/recreate topics.
 *
 * The module is dependency-free (no store/SQLite/i18n imports) so both the
 * store (which marks + finalizes) and focused tests can use it without
 * import cycles. All storage access is fail-closed: inaccessibility reads as
 * "existing profile, nothing pending" (never ensure).
 */

export const PERSIST_COMPAT_KEY = 'persist:cherry-studio'

/** Durable fresh-bootstrap pending marker, outside the Redux persist payload. */
export const FRESH_CHAT_BOOTSTRAP_PENDING_KEY = 'cherry-chat:fresh-bootstrap-pending'

function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function safeRemoveItem(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  } catch {
    // fail-closed: a stale marker retains pending (retry), never a false clear
  }
}

/** True when the Redux compatibility persist payload exists for this profile. */
export function readPersistedProfileExists(): boolean {
  return safeGetItem(PERSIST_COMPAT_KEY) !== null
}

/** True when a fresh-chat bootstrap is still pending for this profile. */
export function isFreshBootstrapPending(): boolean {
  return safeGetItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY) !== null
}

/**
 * Mark a fresh-chat bootstrap pending when this boot starts from a truly
 * fresh persisted profile (persist key absent). Must run synchronously during
 * store module evaluation — before redux-persist can write for this boot.
 * Idempotent: an already-pending marker stays pending. Never marks when a
 * persisted profile exists. Returns whether a bootstrap is pending after.
 */
export function markFreshBootstrapPendingIfFreshProfile(): boolean {
  if (isFreshBootstrapPending()) return true
  if (readPersistedProfileExists()) return false
  safeSetItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY, 'pending')
  return isFreshBootstrapPending()
}

/** Clear the pending marker after a successful finalize. */
export function clearFreshBootstrapPending(): void {
  safeRemoveItem(FRESH_CHAT_BOOTSTRAP_PENDING_KEY)
}

export interface FreshTopicTarget {
  id: string
  assistantId: string
  name?: string | null
}

/**
 * Collect create-only ensure targets from the current assistants projection.
 * Only well-formed topics (non-empty string id) qualify; anything else is
 * skipped rather than ensured. Pure — no store access (the caller injects
 * the projection) so the finalize decision stays directly testable.
 */
export function collectFreshTopicTargets(
  assistants: ReadonlyArray<{ id: string; topics?: unknown }>
): FreshTopicTarget[] {
  const targets: FreshTopicTarget[] = []
  for (const assistant of assistants) {
    if (!assistant || typeof assistant.id !== 'string' || assistant.id.length === 0) continue
    const topics = Array.isArray(assistant.topics) ? (assistant.topics as Array<unknown>) : []
    for (const topic of topics) {
      if (!topic || typeof topic !== 'object') continue
      const { id, name } = topic as { id?: unknown; name?: unknown }
      if (typeof id !== 'string' || id.length === 0) continue
      targets.push({ id, assistantId: assistant.id, name: typeof name === 'string' ? name : null })
    }
  }
  return targets
}

export interface FreshBootstrapFinalizeDeps {
  /** Current initial-topic projection to ensure (injected; no store import). */
  collectTargets: () => FreshTopicTarget[]
  /** Create-only ensure of one topic (injected; partial ensures are safe). */
  ensureTopic: (target: FreshTopicTarget) => Promise<void>
}

export type FreshBootstrapFinalizeResult = 'ensured' | 'not-pending'

/**
 * Finalize a fresh-chat bootstrap.
 *
 * - marker pending → ensure every current target create-only (Main-side
 *   ensure never overwrites an existing binding, so partial ensures and
 *   retries are safe), then clear the marker, return `'ensured'`. A rejection
 *   propagates with the marker RETAINED for next-boot/retry.
 * - marker absent → return `'not-pending'` without touching anything (an
 *   existing profile never ensures/recreates missing topics).
 */
export async function finalizeFreshChatBootstrap(
  deps: FreshBootstrapFinalizeDeps
): Promise<FreshBootstrapFinalizeResult> {
  if (!isFreshBootstrapPending()) {
    return 'not-pending'
  }
  const targets = deps.collectTargets()
  for (const target of targets) {
    await deps.ensureTopic(target)
  }
  clearFreshBootstrapPending()
  return 'ensured'
}

export type FreshChatBootstrapReadinessState = 'ready' | 'pending' | 'failed'

let finalizer: (() => Promise<FreshBootstrapFinalizeResult>) | null = null
let bootstrapPromise: Promise<FreshBootstrapFinalizeResult> | null = null
let readinessState: FreshChatBootstrapReadinessState | null = null
const readinessListeners = new Set<() => void>()

function setFreshBootstrapReadinessState(state: FreshChatBootstrapReadinessState): void {
  if (readinessState === state) return
  readinessState = state
  for (const listener of readinessListeners) listener()
}

/**
 * Register the store-backed finalizer once. The readiness singleton owns the
 * only in-session bootstrap promise; startup and UI retry share it.
 */
export function configureFreshChatBootstrapFinalizer(nextFinalizer: () => Promise<FreshBootstrapFinalizeResult>): void {
  finalizer = nextFinalizer
}

/** The durable marker is authoritative; failure is the only non-ready pending state. */
export function getFreshChatBootstrapReadinessState(): FreshChatBootstrapReadinessState {
  if (!isFreshBootstrapPending()) return 'ready'
  return readinessState === 'failed' ? 'failed' : 'pending'
}

export function subscribeFreshChatBootstrapReadiness(listener: () => void): () => void {
  readinessListeners.add(listener)
  return () => readinessListeners.delete(listener)
}

/**
 * Start bootstrap after Redux rehydration, or retry it from the readiness UI.
 * Existing profiles settle immediately without invoking the finalizer. While
 * pending, all callers receive the same promise; a failure retains the marker
 * and a later call starts a new create-only attempt.
 */
export function runFreshChatBootstrap(): Promise<FreshBootstrapFinalizeResult> {
  if (bootstrapPromise) return bootstrapPromise
  if (!isFreshBootstrapPending()) {
    setFreshBootstrapReadinessState('ready')
    return Promise.resolve('not-pending')
  }
  if (!finalizer) {
    const error = new Error('Fresh-chat bootstrap finalizer is not configured')
    setFreshBootstrapReadinessState('failed')
    return Promise.reject(error)
  }

  const activeFinalizer = finalizer
  const promise = Promise.resolve()
    .then(activeFinalizer)
    .then(
      (result) => {
        setFreshBootstrapReadinessState('ready')
        return result
      },
      (error: unknown) => {
        setFreshBootstrapReadinessState('failed')
        throw error
      }
    )
    .finally(() => {
      if (bootstrapPromise === promise) bootstrapPromise = null
    })

  bootstrapPromise = promise
  setFreshBootstrapReadinessState('pending')
  return promise
}
