import { UNLIMITED_CONTEXT_COUNT } from '@renderer/config/constant'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import {
  filterAdjacentUserMessaegs,
  filterAfterContextClearMessages,
  filterErrorOnlyMessagesWithRelated,
  filterLastAssistantMessage,
  filterUsefulMessages
} from '@renderer/utils/messageUtils/filters'
import { resolveAnchorMessageId } from '@renderer/utils/messageUtils/resolveAnchor'
import { takeRight } from 'lodash'

/**
 * Pre-filters messages through the same pipeline as ConversationService.filterMessagesPipeline
 * (steps 1-5), returning the result used for boundary computation.
 *
 * The full pipeline is:
 *   1. filterAfterContextClearMessages
 *   2. filterUsefulMessages
 *   3. filterErrorOnlyMessagesWithRelated
 *   4. filterLastAssistantMessage
 *   5. filterAdjacentUserMessaegs
 *   6. takeRight(contextCount + 2) or fixed-anchor slice  ← boundary lives here
 *   7-9. additional cleanup (not relevant for boundary)
 */
export const preFilterForBoundary = (messages: Message[]): Message[] => {
  return filterAdjacentUserMessaegs(
    filterLastAssistantMessage(
      filterErrorOnlyMessagesWithRelated(filterUsefulMessages(filterAfterContextClearMessages(messages)))
    )
  )
}

/**
 * Computes the context boundary message ID using the full chronological topic
 * messages and the same filtering pipeline as ConversationService.
 *
 * Returns the message ID at the start of the context window, or null when:
 *   - contextCount is unlimited
 *   - all messages fit within the context window (no boundary)
 *   - fixed mode: anchor message not found (deleted or never set)
 *   - fixed mode: anchor is the first pre-filtered message (all messages in context)
 *
 * This is a pure helper (reads store for filter selectors but makes no mutations).
 *
 * @param messages - Full chronological topic messages (oldest first)
 * @param assistant - The assistant whose settings define the context window
 * @param topicId - The current topic ID (for fixed-window anchor lookup)
 */
export const computeContextBoundaryMessageId = (
  messages: Message[],
  assistant: Assistant | undefined,
  topicId: string
): string | null => {
  if (!assistant) return null
  const settings = getAssistantSettings(assistant)

  // Unlimited context: no boundary
  if (settings.contextCount >= UNLIMITED_CONTEXT_COUNT) return null

  const preFiltered = preFilterForBoundary(messages)
  if (preFiltered.length === 0) return null

  if (settings.contextWindowMode === 'fixed') {
    const anchorMessageId = settings.fixedWindowAnchor?.[topicId]
    if (anchorMessageId) {
      const resolvedAnchorId = resolveAnchorMessageId(preFiltered, anchorMessageId)
      if (resolvedAnchorId) {
        const resolvedIndex = preFiltered.findIndex((m) => m.id === resolvedAnchorId)
        // No boundary needed if resolved anchor is the first message (all in context)
        if (resolvedIndex === 0) return null
        return resolvedAnchorId
      }
      // No messages at all — no boundary
      return null
    }
    // No anchor set — fall through to sliding mode
  }

  // Sliding mode: the boundary is the first message kept by takeRight(preFiltered, contextCount + 2).
  // This matches ConversationService.filterMessagesPipeline step 6 exactly.
  const contextCount = settings.contextCount
  const limited = takeRight(preFiltered, contextCount + 2)

  // All messages fit inside the context window → no boundary
  if (limited.length >= preFiltered.length) return null

  return limited[0]?.id ?? null
}
