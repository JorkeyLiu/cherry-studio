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
  /** Perform the actual branch creation for the resolved endpoint. */
  createBranch: (branchEndpoint: number) => Promise<boolean>
  /** Invoked only after createBranch resolves true. */
  onSuccess: () => void
  /** Invoked when createBranch resolves false. */
  onFailure: () => void
  /** Invoked when messageId does not match any message. */
  onMessageNotFound: () => void
}

/**
 * Orchestrate branch creation from a source message ID.
 *
 * Guarantees that onSuccess runs only after the async branch operation has
 * actually completed successfully — never before, and never on failure or on
 * an unresolvable message ID.
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
