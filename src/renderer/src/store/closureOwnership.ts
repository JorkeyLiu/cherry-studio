/**
 * Closure-invalidation topic ownership metadata (Task A).
 *
 * Production `messageBlocks/*` content-mutation dispatches carry explicit,
 * trustworthy topic ownership in `action.meta.closureTopicIds` (stable
 * topicId/topicIds already known at the creation site; see `withClosureTopics`).
 * The `closureInvalidationMiddleware` (store/index.ts) consumes ONLY this
 * explicit metadata — never Redux-entity/projection lookups:
 *
 * - one/many unique non-empty topicIds -> `bumpAndInvalidate` each topic
 * - absent/invalid/empty -> `bumpAndInvalidateAll` (deliberate global fallback)
 *
 * Reducer payload semantics are untouched (reducers ignore `meta`).
 * Ownership metadata merges with (never replaces) existing `meta`
 * (e.g. `fromSync`), so StoreSync propagation keeps both.
 *
 * This contract lives in its own module — separate from the messageBlocks
 * slice — so production code can import the helper without going through the
 * slice module (whose action creators are widely mocked in tests).
 */

/** Explicit topic ownership for closure invalidation, carried in `action.meta`. */
export const CLOSURE_TOPIC_IDS_META_KEY = 'closureTopicIds' as const

/**
 * Explicit read-only hydration marker for closure invalidation, carried in
 * `action.meta.closureReadOnly`.
 *
 * Authoritative Main window reads (latest/around/load-more) publish their
 * response blocks/messages into Redux as a read-only projection. Those
 * publications must NOT bump the semantic closure generation: the full-route
 * authoritative closure is independent of the currently loaded viewport.
 * Only genuine semantic mutations (append/edit/delete, branch-parent
 * butterfly, block content writes) invalidate.
 *
 * Safe default: absent/false means mutate (invalidate). Only explicitly
 * marked read-only publications opt out. Unknown actions without the marker
 * keep today's invalidating behavior.
 */
export const CLOSURE_READ_ONLY_META_KEY = 'closureReadOnly' as const
/**
 * Explicit streaming content-mirror marker for closure invalidation, carried
 * in `action.meta.closureContentMirror`.
 *
 * ONLY the per-execution `StreamWriteScheduler` trusted mirror path sets this
 * marker (throttled existing-block Redux mirror). It never means read-only:
 * the reducer still applies the content update so store/UI filter/token stay
 * real-time. The middleware decides exemption centrally via
 * `isExemptContentMirrorAction` — unmarked/unknown actions always invalidate.
 */
export const CLOSURE_CONTENT_MIRROR_META_KEY = 'closureContentMirror' as const

/**
 * Explicit authority-handled marker for closure invalidation, carried in
 * `action.meta.closureInvalidationHandled`.
 *
 * Renderer-internal projection state only — never Main authority. Set ONLY on
 * dispatches that are provably emitted AFTER the current ack's
 * `consume*AckInvalidation` already bumped (same-ack projection convergence:
 * the singular/plural append-ack commits and their same-ack block upserts,
 * and terminal success-final projection commits after the terminal ack).
 * It is NOT a read of hydration (`closureReadOnly` stays the read path) and
 * it never exempts an action whose ack did not actually succeed. Unmarked or
 * unknown actions keep the safe fail-closed inference.
 */
export const CLOSURE_AUTHORITY_HANDLED_META_KEY = 'closureInvalidationHandled' as const

/**
 * Block fields that provably cannot affect Main closure structure metadata
 * (counts/boundary/folded/route/anchor). Any other key (id/messageId/type and
 * everything else) fails closed to structural invalidation. `status` is
 * further gated to non-terminal values below; terminal SUCCESS/ERROR always
 * invalidates even with the marker. `type` transitions are never exempt.
 */
export const CONTENT_MIRROR_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'content',
  'status',
  'thinking_millsec',
  'citationReferences'
])

const CONTENT_MIRROR_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['success', 'error'])

/** Single topic, many topics, or unknown (null/undefined/empty -> global fallback). */
export type ClosureTopicOwnership = string | readonly string[] | null | undefined

function normalizeClosureTopicIds(topics: ClosureTopicOwnership | readonly unknown[]): string[] {
  const raw: readonly unknown[] = Array.isArray(topics)
    ? (topics as readonly unknown[])
    : topics === null || topics === undefined
      ? []
      : [topics]
  const unique: string[] = []
  const seen = new Set<string>()
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  return unique
}

/**
 * Attach explicit closure-invalidation topic ownership to a messageBlocks
 * action. Always sets `meta.closureTopicIds` (possibly empty = explicit
 * unknown -> global fallback) while preserving existing `meta` fields.
 * Tolerates a missing action (e.g. mocked creators returning undefined in
 * tests) by producing a meta-only action instead of throwing; production
 * creators always return real actions.
 */
export function withClosureTopics<T>(action: T, topics: ClosureTopicOwnership): T {
  const base = (action ?? {}) as Record<string, any>
  return {
    ...base,
    meta: { ...base.meta, [CLOSURE_TOPIC_IDS_META_KEY]: normalizeClosureTopicIds(topics) }
  } as T
}

/**
 * Read explicit closure-invalidation ownership from an action.
 * Returns the unique non-empty topicIds, or null when ownership is
 * absent/invalid/empty (caller must fall back to global invalidation).
 * Never inspects Redux state or projections.
 */
export function getClosureTopicIds(action: unknown): string[] | null {
  const raw = (action as { meta?: Record<string, unknown> } | null | undefined)?.meta?.[CLOSURE_TOPIC_IDS_META_KEY]
  if (!Array.isArray(raw)) return null
  const ids = normalizeClosureTopicIds(raw)
  return ids.length > 0 ? ids : null
}

/**
 * Attach the explicit read-only hydration marker to an action.
 * Preserves existing `meta` (including closureTopicIds/fromSync).
 * Tolerates a missing action the same way `withClosureTopics` does.
 */
export function markClosureReadOnly<T>(action: T): T {
  const base = (action ?? {}) as Record<string, any>
  return {
    ...base,
    meta: { ...base.meta, [CLOSURE_READ_ONLY_META_KEY]: true }
  } as T
}

/**
 * Whether an action is an explicitly marked authoritative read-only
 * hydration/publication. Absent/invalid marker means mutate (safe default).
 */
export function isClosureReadOnly(action: unknown): boolean {
  return (action as { meta?: Record<string, unknown> } | null | undefined)?.meta?.[CLOSURE_READ_ONLY_META_KEY] === true
}

/**
 * Attach the explicit streaming content-mirror marker to a trusted
 * `StreamWriteScheduler` mirror action. Preserves existing `meta`.
 */
export function markClosureContentMirror<T>(action: T): T {
  const base = (action ?? {}) as Record<string, any>
  return {
    ...base,
    meta: { ...base.meta, [CLOSURE_CONTENT_MIRROR_META_KEY]: true }
  } as T
}

/**
 * Whether an action carries the trusted streaming content-mirror marker.
 * Absent/invalid means not a content mirror (safe default: invalidate).
 * A content mirror is never read-only: both markers set still exempts only
 * via the content path (read-only already exempts, but the mirror stays a
 * closure-freshness no-op — it updates the ordinary projection without
 * invalidating structure).
 */
export function isClosureContentMirror(action: unknown): boolean {
  return (
    (action as { meta?: Record<string, unknown> } | null | undefined)?.meta?.[CLOSURE_CONTENT_MIRROR_META_KEY] === true
  )
}

/**
 * Centralized content-mirror exemption predicate (single owner of the rule).
 *
 * Exempt ONLY when ALL hold (otherwise fail closed to structural invalidation):
 * - action type is exactly `messageBlocks/updateOneBlock` (existing-block
 *   patch; upsert/remove/new-block/type-transition/terminal paths never exempt)
 * - trusted content-mirror marker present
 * - explicit non-empty topic ownership present (unmarked/unknown still globals)
 * - payload `changes` keys are a non-empty subset of CONTENT_MIRROR_ALLOWED_KEYS
 *   (any `type`/`id`/`messageId`/unknown key rejects; `type` transitions never exempt)
 * - `status`, when present, is non-terminal (terminal SUCCESS/ERROR rejects)
 *
 * Never inspects Redux state. Reducer semantics untouched.
 */
export function isExemptContentMirrorAction(action: unknown): boolean {
  const typed = action as { type?: unknown; payload?: unknown } | null | undefined
  if (!typed || typed.type !== 'messageBlocks/updateOneBlock') return false
  if (!isClosureContentMirror(action)) return false
  if (getClosureTopicIds(action) === null) return false
  const changes = (typed.payload as { changes?: unknown } | null | undefined)?.changes
  if (!changes || typeof changes !== 'object') return false
  const keys = Object.keys(changes as Record<string, unknown>)
  if (keys.length === 0) return false
  for (const key of keys) {
    if (!CONTENT_MIRROR_ALLOWED_KEYS.has(key)) return false
  }
  const status = (changes as Record<string, unknown>).status
  if (status !== undefined) {
    if (typeof status !== 'string') return false
    if (CONTENT_MIRROR_TERMINAL_STATUSES.has(status)) return false
  }
  return true
}

/**
 * Attach the explicit authority-handled marker to a same-ack projection action.
 * Preserves existing `meta`. Tolerates a missing action the same way
 * `withClosureTopics` does. Call ONLY on dispatches provably emitted after
 * the current ack's consume helper already bumped.
 */
export function withAuthorityHandled<T>(action: T): T {
  const base = (action ?? {}) as Record<string, any>
  return {
    ...base,
    meta: { ...base.meta, [CLOSURE_AUTHORITY_HANDLED_META_KEY]: true }
  } as T
}

/**
 * Whether an action carries the explicit authority-handled marker.
 * Absent/invalid means not handled (safe default: infer/invalidate).
 * The middleware additionally gates on the action family, so a stray marker
 * on an unrelated family never exempts.
 */
export function isAuthorityHandled(action: unknown): boolean {
  return (
    (action as { meta?: Record<string, unknown> } | null | undefined)?.meta?.[CLOSURE_AUTHORITY_HANDLED_META_KEY] ===
    true
  )
}

/**
 * Action families whose same-ack projection convergence may carry the
 * authority-handled marker. Only these types are eligible for the dedup exit;
 * any other marked type fails closed to the existing inference. This keeps
 * streaming intermediate mirrors, loading markers, resident/retention
 * lifecycle, and unlisted `newMessages/*` mutations on the safe default.
 */
export const AUTHORITY_HANDLED_ACTION_TYPES: ReadonlySet<string> = new Set([
  'newMessages/applyAppendAcknowledgment',
  'newMessages/applyAppendAcknowledgments',
  'newMessages/updateMessage',
  'newMessages/updateManyMessages',
  'messageBlocks/upsertManyBlocks',
  'messageBlocks/upsertOneBlock',
  'messageBlocks/removeManyBlocks',
  'messageBlocks/updateOneBlock'
])
