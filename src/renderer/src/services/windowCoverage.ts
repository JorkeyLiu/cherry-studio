import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'

/**
 * Coverage check for S6.1 window reads.
 *
 * Determines whether a cached typed window (`FetchMessagesWindowResponse.window`)
 * fully covers a new window request for the current renderer generation. The
 * check is purely on declared bounds and request equality — it does not infer
 * authority generation; callers must ensure the cached entry belongs to the
 * current generation before calling (generation is applicability-only and is
 * caller-owned).
 *
 * This helper preserves the invariant that a `window` never masquerades as
 * `whole-topic` and that unknown completeness types are never considered covering.
 */
export function isWindowCovering(
  cached: FetchMessagesWindowResponse | null | undefined,
  request: FetchMessagesWindowRequest,
  currentTopicId: string
): boolean {
  if (!cached || !cached.window) return false
  const w = cached.window
  if (w.completeness !== 'window') return false
  if (w.topicId !== request.topicId) return false
  if (w.topicId !== currentTopicId) return false
  if (w.kind !== request.kind) return false

  if (request.kind === 'latest') {
    if (w.kind !== 'latest') return false
    // Fail closed on malformed requested metadata — no fallback to returnedCount.
    const lim = w.requested.limit
    if (typeof lim !== 'number' || !Number.isFinite(lim) || !Number.isInteger(lim) || lim < 1 || lim > 100) return false
    if (lim < request.limit) return false
    return true
  }

  if (request.kind === 'around') {
    if (w.kind !== 'around') return false
    if (w.anchorMessageId !== request.anchorMessageId) return false
    // Fail closed on malformed requested metadata — no fallback to 0.
    const b = w.requested.before
    const a = w.requested.after
    if (typeof b !== 'number' || !Number.isFinite(b) || !Number.isInteger(b) || b < 1 || b > 100) return false
    if (typeof a !== 'number' || !Number.isFinite(a) || !Number.isInteger(a) || a < 1 || a > 100) return false
    if (b < request.before) return false
    if (a < request.after) return false
    // if cached window actually truncated due to topic bounds, it may have fewer
    // than requested before/after but still be complete for that anchor (hasMore indicates truncation)
    // The bounds check above already ensures requested counts were within cached's declared request.
    return true
  }

  return false
}

/**
 * Strict equality helper: does the cached window exactly match the request's declared bounds?
 * Useful for deduplication / single-flight decisions.
 */
export function isExactWindowMatch(
  cached: FetchMessagesWindowResponse | null | undefined,
  request: FetchMessagesWindowRequest
): boolean {
  if (!cached || !cached.window) return false
  const w = cached.window
  if (w.kind !== request.kind) return false
  if (w.topicId !== request.topicId) return false
  if (w.completeness !== 'window') return false
  if (request.kind === 'latest') return w.requested.limit === request.limit
  if (request.kind === 'around') {
    return (
      w.anchorMessageId === request.anchorMessageId &&
      w.requested.before === request.before &&
      w.requested.after === request.after
    )
  }
  return false
}
