import { DEFAULT_CONTEXTCOUNT, MAX_CONTEXT_COUNT, UNLIMITED_CONTEXT_COUNT } from '@renderer/config/constant'
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
): { uiMessages: Message[]; boundaryMessageId: string | null; contextCount: { current: number; max: number | null } } {
  if (!assistant) {
    return { uiMessages: [], boundaryMessageId: null, contextCount: { current: 0, max: null } }
  }

  // Read raw contextCount before getAssistantSettings transforms MAX_CONTEXT_COUNT → UNLIMITED_CONTEXT_COUNT.
  // This raw value is what the UI displays as the window capacity.
  // When rawContextCount === MAX_CONTEXT_COUNT (100), the persisted sentinel means "unlimited";
  // downstream max uses null to represent unlimited so MaxContextCount renders ∞.
  const rawContextCount = assistant.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT
  // Hoisted predicate: true when stored sentinel (100) means unlimited.
  const isUnlimited = rawContextCount >= MAX_CONTEXT_COUNT

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

  // Sliding display source: messages visible in the viewport after context-clear semantics
  // but BEFORE filters that remove still-visible messages (steps 2-5: useful, error-only,
  // trailing assistant, adjacent users). This is the source of truth for sliding
  // current/boundary display accounting. It intentionally differs from the model source
  // (steps 2-5 output / withoutAdjacentUsers) which feeds the N+2 model pipeline.
  const slidingDisplaySource = messagesAfterContextClear

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
    // Sliding mode: keep the last contextCount + 2 messages for the model pipeline.
    // The +2 compensates for post-limit filters (steps 7–9) that may remove up to 2 messages.
    if (actualContextCount >= UNLIMITED_CONTEXT_COUNT) {
      limitedByContext = withoutAdjacentUsers
    } else {
      limitedByContext = takeRight(withoutAdjacentUsers, actualContextCount + 2)
    }

    // Display boundary: marks the start of the N-message display window (not N+2 model window).
    // Derived from slidingDisplaySource (post-context-clear, pre-model-filters) so boundary
    // and contextCount.current represent the same viewport-visible window.
    if (!isUnlimited && rawContextCount < slidingDisplaySource.length) {
      const displaySlice = takeRight(slidingDisplaySource, rawContextCount)
      boundaryMessageId = displaySlice[0]?.id ?? null
    }
  }

  // --- Steps 7-9: Post-filter cleanup (identical to filterMessagesPipeline) ---
  const contextClearFiltered = filterAfterContextClearMessages(limitedByContext)
  const nonEmptyMessages = filterEmptyMessages(contextClearFiltered)
  const uiMessages = filterUserRoleStartMessages(nonEmptyMessages)

  // --- Compute contextCount for UI display ---
  // Canonical unit: MESSAGES. current = message count in the display window,
  // max = configured capacity (null = unlimited).
  //
  // Named collections:
  //   slidingDisplaySource  — step 1 output (post-context-clear, display accounting source)
  //   withoutAdjacentUsers  — steps 1-5 output (model source, pre-limit)
  //   limitedByContext      — step 6 output (model window, uses N+2 for sliding)
  //   uiMessages            — steps 7-9 output (post-limit, model receives this)
  //
  // Sliding current/boundary derive from slidingDisplaySource (post-context-clear,
  // pre-model-filters) so they match the viewport-visible window.
  // Fixed current counts raw chronological messages from anchor.
  // max is null when stored semantics mean unlimited (sentinel 100) or mode is fixed.
  let currentCount: number
  let maxCount: number | null

  if (effectiveMode === 'fixed') {
    // Fixed mode: anchored window, no numeric capacity limit → max = null (unlimited)
    maxCount = null
    if (anchor?.kind === 'active') {
      // Count RAW chronological messages from anchored Q&A group top through raw tail,
      // including the final assistant that filterLastAssistantMessage (step 4) removes.
      // Do NOT derive count from limitedByContext or any model-filter collection.
      const rawSliceStart = resolveAnchorSliceStart(messages, anchor.groupKey)
      currentCount = rawSliceStart >= 0 ? messages.length - rawSliceStart : 0
    } else {
      // Fixed + undefined/missing anchor: window not established (new topic, etc.)
      currentCount = 0
    }
  } else {
    // Sliding mode: current = min(display source size, configured capacity N).
    // Boundary and current represent the same N-message display window;
    // the model pipeline's N+2 compensation is separate.
    if (isUnlimited) {
      currentCount = slidingDisplaySource.length
      maxCount = null
    } else {
      currentCount = Math.min(slidingDisplaySource.length, rawContextCount)
      maxCount = rawContextCount
    }
  }

  return {
    uiMessages,
    boundaryMessageId,
    contextCount: { current: currentCount, max: maxCount }
  }
}
