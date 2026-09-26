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
 * - SURVIVES apply/ensure failure and renderer restart (localStorage is
 *   per-profile durable storage).
 * - CLEARED only after (a) a pending import was successfully applied (the
 *   imported navigation supersedes the initial Redux topics — no ensure), or
 *   (b) verified-no-pending AND every current initial topic was successfully
 *   ensured create-only. Never cleared on unknown/read/apply/ensure failure.
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

/** Clear the pending marker after a successful finalize (applied or ensured). */
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
  /**
   * The one-shot projection outcome: `true` when a pending import was
   * applied, `false` only on verified no-pending. Unknown/failure never
   * reaches the finalizer (the caller settles `failed` first).
   */
  applied: boolean
  /** Current initial-topic projection to ensure (injected; no store import). */
  collectTargets: () => FreshTopicTarget[]
  /** Create-only ensure of one topic (injected; partial ensures are safe). */
  ensureTopic: (target: FreshTopicTarget) => Promise<void>
}

export type FreshBootstrapFinalizeResult = 'import-applied' | 'ensured' | 'not-pending'

/**
 * Finalize a fresh-chat bootstrap after the projection outcome is known.
 *
 * - `applied === true` → the imported navigation supersedes the initial
 *   Redux topics: clear the marker WITHOUT ensuring, return
 *   `'import-applied'`.
 * - `applied === false` + marker pending → ensure every current target
 *   create-only (Main-side ensure never overwrites an existing binding, so
 *   partial ensures and retries are safe), then clear the marker, return
 *   `'ensured'`. A rejection propagates with the marker RETAINED for
 *   next-boot/retry.
 * - marker absent → return `'not-pending'` without touching anything (an
 *   existing profile never ensures/recreates missing topics).
 */
export async function finalizeFreshChatBootstrap(
  deps: FreshBootstrapFinalizeDeps
): Promise<FreshBootstrapFinalizeResult> {
  if (deps.applied) {
    clearFreshBootstrapPending()
    return 'import-applied'
  }
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
