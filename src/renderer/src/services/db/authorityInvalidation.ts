/**
 * Authority-mutation acknowledgment consumption (minimal slice).
 *
 * Consumed exactly once per successful Main ack, AFTER the typed IPC success
 * and BEFORE any local route-currency / loaded / projection guard. A Main
 * failure (structured rejection or transport error) never reaches these
 * helpers — `unwrap` throws first, so nothing is invalidated.
 *
 * `scope: 'all'` is a conservative coarse signal: every accepted route
 * closure may be stale (cross-branch/reference effects are not precisely
 * scoped), so the renderer drops cached closures and requires a fresh
 * authoritative read. It never deletes data and is not a proof of a true
 * change. Unknown/malformed effects still bump conservatively (never a
 * silent no-op success); the caller keeps its own publication fail-closed
 * guard separately.
 */

import { bumpAndInvalidateAll } from '@renderer/services/contextClosure'
import type { AppendMessageResponse, ContextInvalidationEffect, UpdateMessageAndBlocksResponse } from '@shared/chatDb'

/**
 * Local shape check for the conservative invalidation effect.
 * Closed-set: exactly `{ scope: 'all' }`.
 */
export function isAuthorityInvalidationEffect(value: unknown): value is ContextInvalidationEffect {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length !== 1 || keys[0] !== 'scope') return false
  return rec.scope === 'all'
}

/**
 * Consume one successful append ack's invalidation effect.
 * Always bumps conservatively on a success ack; returns true only when the
 * effect itself is well-formed. Never throws: a helper failure still bumps
 * to avoid serving stale closures.
 */
export function consumeAppendAckInvalidation(ack: AppendMessageResponse | null | undefined): boolean {
  try {
    if (!ack || typeof ack !== 'object') return false
    const valid = isAuthorityInvalidationEffect((ack as unknown as Record<string, unknown>).contextInvalidation)
    try {
      bumpAndInvalidateAll()
    } catch {
      // best-effort; generation already advanced or notify failed
    }
    return valid
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
 * Same conservative semantics as the append path. The ordinary terminal
 * execution calls this AFTER `recordTerminalPersisted` and BEFORE any
 * projection dispatch, so the closure read witness is always initiated after
 * the terminal token.
 */
export function consumeUpdateAckInvalidation(response: UpdateMessageAndBlocksResponse | null | undefined): boolean {
  try {
    if (!response || typeof response !== 'object') return false
    const valid = isAuthorityInvalidationEffect((response as unknown as Record<string, unknown>).contextInvalidation)
    try {
      bumpAndInvalidateAll()
    } catch {
      // best-effort
    }
    return valid
  } catch {
    try {
      bumpAndInvalidateAll()
    } catch {
      // never break the write path
    }
    return false
  }
}
