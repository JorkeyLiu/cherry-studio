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
