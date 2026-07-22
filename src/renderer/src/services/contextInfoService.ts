import { MAX_CONTEXT_COUNT, UNLIMITED_CONTEXT_COUNT } from '@renderer/config/constant'
import { resolveAnchorSliceStart } from '@renderer/services/anchorService'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import type { Assistant, ContextWindowMode, TopicAnchor } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import {
  filterAdjacentUserMessaegs,
  filterAfterContextClearMessages,
  filterEmptyMessages,
  filterErrorOnlyMessagesWithRelated,
  filterLastAssistantMessage,
  filterUsefulMessages,
  filterUserRoleStartMessages
} from '@renderer/utils/messageUtils/filters'
import { takeRight } from 'lodash'

/**
 * The single unified pipeline for computing all context-related information.
 *
 * This function is the sole source of truth for:
 *   - Which messages the model actually receives (uiMessages)
 *   - Where the context window boundary divider should render (boundaryMessageId)
 *   - What TokenCount displays (contextCount)
 *
 * The filtering steps are identical to ConversationService.filterMessagesPipeline:
 *   1. filterAfterContextClearMessages
 *   2. filterUsefulMessages
 *   3. filterErrorOnlyMessagesWithRelated
 *   4. filterLastAssistantMessage
 *   5. filterAdjacentUserMessaegs
 *   6. Context limiting (takeRight or fixed-anchor slice)
 *   7. filterAfterContextClearMessages (second pass)
 *   8. filterEmptyMessages
 *   9. filterUserRoleStartMessages
 *
 * This is a pure function — it reads store state for block lookups but makes no mutations.
 */
export function computeContextInfo(
  messages: Message[],
  assistant: Assistant | undefined,
  topicId?: string
): { uiMessages: Message[]; boundaryMessageId: string | null; contextCount: { current: number; max: number } } {
  if (!assistant) {
    return { uiMessages: [], boundaryMessageId: null, contextCount: { current: 0, max: 0 } }
  }

  const settings = getAssistantSettings(assistant)
  const settingContextCount = settings.contextCount
  const actualContextCount = settingContextCount === MAX_CONTEXT_COUNT ? UNLIMITED_CONTEXT_COUNT : settingContextCount

  // Compute effective mode (same formula as ConversationService.prepareMessagesForModel)
  const topicMode = topicId ? settings.topicContextWindowMode?.[topicId] : undefined
  const effectiveMode: ContextWindowMode =
    settings.contextWindowMode === 'fixed' ? (topicMode ?? settings.contextWindowMode) : 'sliding'

  const anchor: TopicAnchor | undefined = topicId ? settings.fixedWindowAnchor?.[topicId] : undefined

  // --- Steps 1-5: Pre-filter (identical to filterMessagesPipeline) ---
  const messagesAfterContextClear = filterAfterContextClearMessages(messages)
  const usefulMessages = filterUsefulMessages(messagesAfterContextClear)
  const withoutErrorOnlyPairs = filterErrorOnlyMessagesWithRelated(usefulMessages)
  const withoutTrailingAssistant = filterLastAssistantMessage(withoutErrorOnlyPairs)
  const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)

  // --- Step 6: Context limiting (identical to filterMessagesPipeline) ---
  let limitedByContext: Message[]
  let boundaryMessageId: string | null = null

  if (effectiveMode === 'fixed') {
    if (anchor?.kind === 'active') {
      const sliceStart = resolveAnchorSliceStart(withoutAdjacentUsers, anchor.groupKey)
      if (sliceStart >= 0) {
        limitedByContext = withoutAdjacentUsers.slice(sliceStart)
        // Boundary: the anchor group start message (only if it's not the very first message)
        if (sliceStart > 0) {
          boundaryMessageId = withoutAdjacentUsers[sliceStart].id
        }
      } else {
        // Group was filtered out — fallback to full set, no boundary
        limitedByContext = withoutAdjacentUsers
      }
    } else {
      // anchor undefined or legacy data → full set, no boundary
      limitedByContext = withoutAdjacentUsers
    }
  } else {
    // Sliding mode: keep the last contextCount + 2 messages
    if (actualContextCount >= UNLIMITED_CONTEXT_COUNT) {
      limitedByContext = withoutAdjacentUsers
    } else {
      limitedByContext = takeRight(withoutAdjacentUsers, actualContextCount + 2)
      // Boundary: first message kept by takeRight (only if trimming occurred)
      if (limitedByContext.length < withoutAdjacentUsers.length) {
        boundaryMessageId = limitedByContext[0]?.id ?? null
      }
    }
  }

  // --- Steps 7-9: Post-filter cleanup (identical to filterMessagesPipeline) ---
  const contextClearFiltered = filterAfterContextClearMessages(limitedByContext)
  const nonEmptyMessages = filterEmptyMessages(contextClearFiltered)
  const uiMessages = filterUserRoleStartMessages(nonEmptyMessages)

  return {
    uiMessages,
    boundaryMessageId,
    contextCount: { current: uiMessages.length, max: settingContextCount }
  }
}
