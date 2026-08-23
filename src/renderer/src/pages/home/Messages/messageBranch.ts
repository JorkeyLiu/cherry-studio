import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Message } from '@renderer/types/newMessage'

export const getBranchEndpoint = (messages: Message[], messageId: string): number | null => {
  const messageIndex = messages.findIndex((message) => message.id === messageId)
  return messageIndex === -1 ? null : messageIndex + 1
}

/**
 * Emit the NEW_BRANCH event.
 *
 * The NEW_BRANCH contract is ID-based: the payload MUST be the source message's
 * string ID. Listeners resolve the branch endpoint via getBranchEndpoint, so
 * emitting anything else (e.g. a numeric message index) silently fails to
 * create a branch.
 */
export const emitNewBranch = async (messageId: string): Promise<void> => {
  await EventEmitter.emit(EVENT_NAMES.NEW_BRANCH, messageId)
}

export interface BranchFromMessageCallbacks {
  /** Perform the actual branch creation for the resolved endpoint. (legacy, window-relative) */
  createBranch: (branchEndpoint: number) => Promise<boolean>
  /** Invoked only after createBranch resolves true. */
  onSuccess: () => void
  /** Invoked when createBranch resolves false. */
  onFailure: () => void
  /** Invoked when messageId does not match any message. */
  onMessageNotFound: () => void
}

export interface BranchFromAnchorCallbacks {
  /** Perform the branch creation for the stable anchor. */
  createBranchByAnchor: (anchorMessageId: string) => Promise<boolean>
  onSuccess: () => void
  onFailure: () => void
  onMessageNotFound: () => void
}

/**
 * Orchestrate branch creation from a source message ID.
 *
 * Guarantees that onSuccess runs only after the async branch operation has
 * actually completed successfully — never before, and never on failure or on
 * an unresolvable message ID.
 *
 * @deprecated Use branchFromAnchorMessage for the primary S6.2c-1 anchor path.
 */
export const branchFromMessage = async (
  messages: Message[],
  messageId: string,
  { createBranch, onSuccess, onFailure, onMessageNotFound }: BranchFromMessageCallbacks
): Promise<boolean> => {
  const branchEndpoint = getBranchEndpoint(messages, messageId)

  if (branchEndpoint === null) {
    onMessageNotFound()
    return false
  }

  let success: boolean

  try {
    success = await createBranch(branchEndpoint)
  } catch {
    // A rejected createBranch promise is a branch failure: route it through the
    // existing failure callback and never let it escape as an unhandled rejection.
    onFailure()
    return false
  }

  if (success) {
    onSuccess()
  } else {
    onFailure()
  }

  return success
}

/**
 * S6.2c-1 primary anchor path: orchestrate branch creation from a stable anchor.
 *
 * No window-relative index/slice — the anchorMessageId is sent directly to Main,
 * which resolves the authoritative prefix. No local projection gating: even if the
 * anchor is outside the current window, the Main authority validates it. Strict
 * no-slice invariant: this path must never compute a numeric index from the
 * projection.
 */
export const branchFromAnchorMessage = async (
  _messages: Message[],
  messageId: string,
  { createBranchByAnchor, onSuccess, onFailure, onMessageNotFound }: BranchFromAnchorCallbacks
): Promise<boolean> => {
  if (!messageId) {
    onMessageNotFound()
    return false
  }

  let success: boolean
  try {
    success = await createBranchByAnchor(messageId)
  } catch {
    onFailure()
    return false
  }

  if (success) {
    onSuccess()
  } else {
    // Main distinguishes NOT_FOUND (missing/cross-topic anchor) from generic failure.
    // Thunk coalesces both to false; route to onFailure for uniform handling.
    // Callers that need NOT_FOUND distinction should catch ChatDbResultError directly.
    onFailure()
  }
  return success
}
