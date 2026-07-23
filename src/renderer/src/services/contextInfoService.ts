import { DEFAULT_CONTEXTCOUNT, MAX_CONTEXT_COUNT } from '@renderer/config/constant'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import {
  buildContextTurns,
  type ContextTurn,
  resolveAnchorTurnIndex,
  turnsToMessages
} from '@renderer/services/contextTurnService'
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

/**
 * The single unified pipeline for computing all context-related information.
 *
 * This function is the sole source of truth for:
 *   - Which messages the model actually receives (uiMessages)
 *   - Where the context window boundary divider should render (boundaryMessageId)
 *   - What TokenCount displays (contextCount)
 *
 * Canonical unit: ContextTurn. contextCount, window selection, and boundary
 * all operate on whole turns. The persisted contextCount value is reinterpreted
 * as a turn count (not a message count).
 *
 * Pipeline ordering:
 *   1. buildContextTurns — groups post-clear messages into semantic turns
 *      (handles clear filtering + turn construction internally)
 *   2. Turn selection — sliding (last N turns) or fixed (anchor-based)
 *   3. turnsToMessages — expands selected turns to Message[]
 *   4. filterUsefulMessages — deduplicates retries within assistant groups
 *   5. filterErrorOnlyMessagesWithRelated — removes error-only pairs
 *   6. filterLastAssistantMessage — removes trailing assistant message
 *   7. filterAdjacentUserMessaegs — removes adjacent duplicate user messages
 *   8. filterAfterContextClearMessages — safety pass (no-op after turn expansion)
 *   9. filterEmptyMessages — removes messages without content blocks
 *  10. filterUserRoleStartMessages — trims leading non-user messages
 *
 * N+2 compensation is removed: selection is by whole turns, so post-selection
 * model filters (steps 4–7) cannot create partial turn boundaries that would
 * need message-level compensation. The model may receive fewer messages than
 * the expanded turn count, but this is expected — model filters remove invalid
 * messages within the selected product window.
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
  // Persisted numeric values are reinterpreted as turn counts (not message counts).
  const rawContextCount = assistant.settings?.contextCount ?? DEFAULT_CONTEXTCOUNT
  // Hoisted predicate: true when stored sentinel (100) means unlimited.
  const isUnlimited = rawContextCount >= MAX_CONTEXT_COUNT

  const settings = getAssistantSettings(assistant)

  // Compute effective mode (same formula as ConversationService.prepareMessagesForModel)
  const topicMode = topicId ? settings.topicContextWindowMode?.[topicId] : undefined
  const effectiveMode: ContextWindowMode =
    settings.contextWindowMode === 'fixed' ? (topicMode ?? settings.contextWindowMode) : 'sliding'

  const anchor: TopicAnchor | undefined = topicId ? settings.fixedWindowAnchor?.[topicId] : undefined

  // --- Step 1: Build turns from post-context-clear messages ---
  // buildContextTurns handles clear filtering internally (excludes clear messages
  // and everything before the last clear). Turn construction rules:
  //   - user starts a new turn keyed by its own id
  //   - consecutive assistant with matching askId joins the current turn
  //   - adjacent users create separate turns
  //   - orphan/system messages are standalone turns
  const allTurns = buildContextTurns(messages)

  // --- Step 2: Turn selection ---
  let selectedTurns: readonly ContextTurn[]
  let boundaryMessageId: string | null = null
  let currentCount: number
  let maxCount: number | null

  if (effectiveMode === 'fixed') {
    if (anchor?.kind === 'active') {
      // Locate the anchor turn using the pure resolver (preserves old
      // anchorService.resolveAnchorSliceStart semantics: user-id match
      // wins over assistant-askId fallback, -1 when neither exists).
      const anchorIndex = resolveAnchorTurnIndex(allTurns, anchor.groupKey)
      if (anchorIndex >= 0) {
        selectedTurns = allTurns.slice(anchorIndex)
        // Boundary: first message of the anchor turn, only when older turns exist.
        if (anchorIndex > 0) {
          boundaryMessageId = selectedTurns[0].messages[0].id
        }
        currentCount = selectedTurns.length
      } else {
        // Anchor groupKey not found — display shows 0, model gets all turns
        // so ConversationService receives full filtered history (not empty).
        selectedTurns = allTurns
        currentCount = 0
      }
    } else {
      // No anchor (undefined or legacy data) — display shows 0, model gets
      // all turns so ConversationService receives full filtered history.
      selectedTurns = allTurns
      currentCount = 0
    }
    // Fixed mode: no numeric capacity limit → max = null (unlimited)
    maxCount = null
  } else {
    // Sliding mode: select the last N turns (N = rawContextCount).
    if (isUnlimited) {
      selectedTurns = allTurns
      currentCount = allTurns.length
      maxCount = null
    } else {
      const n = rawContextCount
      selectedTurns = allTurns.slice(Math.max(0, allTurns.length - n))
      currentCount = selectedTurns.length
      maxCount = rawContextCount
      // Boundary: first message of the first selected turn, only when older turns exist.
      if (allTurns.length > n && selectedTurns.length > 0) {
        boundaryMessageId = selectedTurns[0].messages[0].id
      }
    }
  }

  // --- Step 3: Expand selected turns to Message[] ---
  const expandedMessages = turnsToMessages(selectedTurns)

  // --- Steps 4-7: Model filters (same relative order as old pipeline steps 2-5) ---
  // These operate on expanded turn messages, NOT on the full pre-selection message list.
  // Turn selection has already happened; these filters refine the model payload.
  const usefulMessages = filterUsefulMessages(expandedMessages)
  const withoutErrorOnlyPairs = filterErrorOnlyMessagesWithRelated(usefulMessages)
  const withoutTrailingAssistant = filterLastAssistantMessage(withoutErrorOnlyPairs)
  const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)

  // --- Steps 8-10: Post-filter cleanup (same relative order as old pipeline steps 7-9) ---
  const contextClearFiltered = filterAfterContextClearMessages(withoutAdjacentUsers)
  const nonEmptyMessages = filterEmptyMessages(contextClearFiltered)
  const uiMessages = filterUserRoleStartMessages(nonEmptyMessages)

  return {
    uiMessages,
    boundaryMessageId,
    contextCount: { current: currentCount, max: maxCount }
  }
}
