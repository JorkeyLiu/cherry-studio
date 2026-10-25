/**
 * Bounded renderer click-to-pause streaming follow (pure predicates only).
 *
 * Approved UX: during active assistant reply generation on the DISPLAYED
 * topic/route, ANY primary mouse press inside the message viewport
 * (`#messages`) stops automatic following WITHOUT repositioning visible text
 * and WITHOUT stopping generation. No prior scroll is required.
 *
 * Message controls (buttons, links, answer tabs, code/media toolbars,
 * editors, media) keep their normal native action AND pause: the pause is a
 * container-level press observation only — never preventDefault,
 * stopPropagation, inert, or rewritten link behavior. Presses on the topbar
 * or inputbar (outside `#messages`) never reach this gate and never pause.
 *
 * This module owns ONLY the event predicate and the active-stream
 * predicate. It performs no DOM writes, no scrolling, no selection changes,
 * no store subscriptions, and no persistence. The imperative adoption lives
 * in `Messages.tsx` (`attemptStreamingPause`) and reuses the shared
 * single-writer `userTakeover` path, so ownership/provenance semantics never
 * diverge from the scroll path.
 *
 * Predicate rules (all must hold for a pause press):
 * - primary mouse only: `button === 0`, and a known non-mouse `pointerType`
 *   (touch/pen) never qualifies. An absent `pointerType` (older dispatch)
 *   does not disqualify a `button === 0` press.
 * - inside the viewport: the caller attaches the handler to `#messages`, so
 *   containment is structural (only presses bubbling from inside the
 *   viewport reach the handler). There is no child-target selector: every
 *   bubbled press target qualifies.
 * - active stream on the displayed route: an assistant message with an active
 *   assistant-level status (`pending`/`processing`/`searching`; messages
 *   carry no streaming enum) or a member block with block-level `streaming`
 *   status. Callers bind the displayed route's message list locally and read
 *   block status at event time (no per-token store subscription).
 */

export interface PointerDownLike {
  button?: unknown
  pointerType?: unknown
}

/** Primary mouse press only: `button === 0` and never a known non-mouse pointer. */
export const isPrimaryMousePointerDown = (event: PointerDownLike | null | undefined): boolean => {
  if (!event || typeof event !== 'object') return false
  if ((event as { button?: unknown }).button !== 0) return false
  const pointerType = (event as { pointerType?: unknown }).pointerType
  if (typeof pointerType === 'string' && pointerType.length > 0 && pointerType !== 'mouse') return false
  return true
}

/**
 * Combined press gate: ANY primary mouse press bubbled from inside
 * `#messages` pauses (containment is structural — the caller owns the
 * viewport wiring, so no child-target selector exists here). Fail-closed on
 * a missing event. Native control actions are untouched: this predicate
 * never prevents, stops, or rewrites them.
 */
export const shouldPauseStreamingOnPrimaryMouseDown = (event: PointerDownLike | null | undefined): boolean =>
  isPrimaryMousePointerDown(event)

export interface StreamingPauseMessageLike {
  role?: unknown
  status?: unknown
  blocks?: unknown
}

/** Active assistant-level reply statuses (messages carry no streaming enum). */
export const isActiveAssistantReplyStatus = (status: unknown): boolean =>
  status === 'pending' || status === 'processing' || status === 'searching'

/**
 * True when the given (caller-scoped, displayed-route) message list contains
 * an active assistant reply: an assistant message with an active
 * assistant-level status, or an assistant message owning a block whose
 * block-level status is `streaming`. Non-assistant messages never qualify,
 * so generation on any other route/topic cannot trigger a pause here.
 */
export const hasActiveStreamingReply = (
  displayMessages: ReadonlyArray<StreamingPauseMessageLike> | null | undefined,
  getBlockStatus?: (blockId: string) => unknown
): boolean => {
  if (!Array.isArray(displayMessages)) return false
  for (const message of displayMessages) {
    if (!message || typeof message !== 'object') continue
    if ((message as StreamingPauseMessageLike).role !== 'assistant') continue
    if (isActiveAssistantReplyStatus((message as StreamingPauseMessageLike).status)) return true
    const blocks = (message as StreamingPauseMessageLike).blocks
    if (Array.isArray(blocks) && typeof getBlockStatus === 'function') {
      for (const blockId of blocks) {
        if (typeof blockId !== 'string' || blockId.length === 0) continue
        let blockStatus: unknown
        try {
          blockStatus = getBlockStatus(blockId)
        } catch {
          continue
        }
        if (blockStatus === 'streaming') return true
      }
    }
  }
  return false
}
