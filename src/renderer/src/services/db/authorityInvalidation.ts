/**
 * Authority-mutation acknowledgment consumption (minimal slice).
 *
 * Consumed exactly once per successful Main ack, AFTER the typed IPC success
 * and BEFORE any local route-currency / loaded / projection guard. A Main
 * failure (structured rejection or transport error) never reaches these
 * helpers — `unwrap` throws first, so nothing is invalidated.
 *
 * Authority acks name the mutated source topic plus its transitive outgoing
 * reference targets. Only those topics' registered closure routes are
 * invalidated; unrelated caches and in-flight reads keep their generation.
 * Unknown/malformed effects still bump globally (never a silent no-op
 * success); the caller keeps its own publication fail-closed guard separately.
 */
import { bumpAndInvalidateAll, bumpAndInvalidateTopics } from '@renderer/services/contextClosure'
import type { AppendMessageResponse, ContextInvalidationEffect, UpdateMessageAndBlocksResponse } from '@shared/chatDb'

/**
 * Local shape check for the topic-scoped invalidation effect.
 * Closed-set: exactly `{ scope: 'topics', topicIds }`, with a non-empty,
 * duplicate-free list of non-empty topic IDs.
 */
export function isAuthorityInvalidationEffect(value: unknown): value is ContextInvalidationEffect {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length !== 2 || !keys.includes('scope') || !keys.includes('topicIds')) return false
  if (rec.scope !== 'topics' || !Array.isArray(rec.topicIds) || rec.topicIds.length === 0) return false
  const seen = new Set<string>()
  for (const id of rec.topicIds) {
    if (typeof id !== 'string' || id.trim().length === 0 || seen.has(id)) return false
    seen.add(id)
  }
  return true
}

function consumeInvalidationEffect(effect: unknown): boolean {
  const valid = isAuthorityInvalidationEffect(effect)
  try {
    if (valid) {
      bumpAndInvalidateTopics(effect.topicIds)
    } else {
      // Unknown ownership is the only global fallback. A well-formed authority
      // ack never takes this path.
      bumpAndInvalidateAll()
    }
  } catch {
    // Best-effort; generation already advanced or notify failed. Never break
    // the write path.
  }
  return valid
}

/**
 * Consume one successful append ack's invalidation effect exactly once.
 * Returns true only when the effect itself is well-formed. A non-ack consumes
 * nothing; `unwrap` prevents Main failures from reaching this helper.
 */
export function consumeAppendAckInvalidation(ack: AppendMessageResponse | null | undefined): boolean {
  try {
    if (!ack || typeof ack !== 'object') return false
    return consumeInvalidationEffect((ack as unknown as Record<string, unknown>).contextInvalidation)
  } catch {
    try {
      bumpAndInvalidateAll()
    } catch {
      // never break the write path
    }
    return false
  }
}

/**
 * Consume one successful update-message-and-blocks ack's invalidation effect.
 * `SqliteMessageDataSource` owns this consumption: exactly once on success,
 * after its optional post-persist hook (where the ordinary terminal execution
 * records `recordTerminalPersisted`) and before any projection dispatch, so the
 * closure read witness is always initiated after the terminal token.
 */
export function consumeUpdateAckInvalidation(response: UpdateMessageAndBlocksResponse | null | undefined): boolean {
  try {
    if (!response || typeof response !== 'object') return false
    return consumeInvalidationEffect((response as unknown as Record<string, unknown>).contextInvalidation)
  } catch {
    try {
      bumpAndInvalidateAll()
    } catch {
      // never break the write path
    }
    return false
  }
}
