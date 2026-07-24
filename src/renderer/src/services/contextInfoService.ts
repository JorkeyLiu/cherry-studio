import { DEFAULT_CONTEXTCOUNT } from '@renderer/config/constant'
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
 * Sentinel value passed as `previewDraft` when the caller knows a nonblank
 * draft exists but does not need to transmit the real text. Must be
 * non-whitespace so that `computeContextInfo`'s `.trim()` check passes.
 *
 * Defined here (rather than at the call-site) so that integration tests can
 * exercise the exact value without coupling to component internals.
 */
export const PREVIEW_DRAFT_SENTINEL = 'preview' as const

/**
 * The single unified pipeline for computing all context-related information.
 *
 * This function is the sole source of truth for:
 *   - Which messages the model actually receives (uiMessages)
 *   - Which messages the token estimator uses (tokenEstimationMessages — retains trailing assistant)
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
 * Preview draft (LOCK-004):
 *   When `options.previewDraft` is a nonblank string, a virtual user turn is
 *   appended to the turn list before turn selection. This makes a full sliding
 *   window eject the oldest real turn to accommodate the pending message.
 *   The virtual turn is NOT included in output message arrays — draft tokens
 *   are added exactly once by the caller (Inputbar). The virtual turn does
 *   affect contextCount.current to reflect the post-send state.
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
  topicId?: string,
  options?: { previewDraft?: string }
): {
  uiMessages: Message[]
  tokenEstimationMessages: Message[]
  boundaryMessageId: string | null
  contextCount: { current: number; max: number | null }
} {
  if (!assistant) {
    return {
      uiMessages: [],
      tokenEstimationMessages: [],
      boundaryMessageId: null,
      contextCount: { current: 0, max: null }
    }
  }

  // Read raw contextCount before getAssistantSettings normalizes it.
  // This raw value is what the UI displays as the window capacity.
  // null means unlimited; finite numeric values are turn counts.
  const rawContextCount =
    assistant.settings?.contextCount === undefined ? DEFAULT_CONTEXTCOUNT : assistant.settings.contextCount
  // Hoisted predicate: null means unlimited.
  const isUnlimited = rawContextCount === null

  const settings = getAssistantSettings(assistant)

  // Compute effective mode (same formula as ConversationService.prepareMessagesForModel)
  const topicMode = topicId ? settings.topicContextWindowMode?.[topicId] : undefined
  const effectiveMode: ContextWindowMode =
    settings.contextWindowMode === 'fixed' ? (topicMode ?? settings.contextWindowMode) : 'sliding'

  const anchor: TopicAnchor | undefined = topicId ? settings.fixedWindowAnchor?.[topicId] : undefined

  // --- Step 1: Build turns from post-context-clear messages ---
  const allTurns = buildContextTurns(messages)

  // --- Preview draft: virtual turn affects turn selection only (LOCK-004) ---
  // A nonblank pending draft occupies a turn slot so that a full sliding window
  // ejects the oldest real turn. The virtual turn is never expanded to output
  // messages — draft content tokens are added exactly once by the caller.
  const hasDraftPreview = !!(options?.previewDraft && options.previewDraft.trim())

  // --- Step 2: Turn selection ---
  let selectedRealTurns: readonly ContextTurn[]
  let boundaryMessageId: string | null = null
  let currentCount: number
  let maxCount: number | null

  if (effectiveMode === 'fixed') {
    if (anchor?.kind === 'active') {
      const anchorIndex = resolveAnchorTurnIndex(allTurns, anchor.groupKey)
      if (anchorIndex >= 0) {
        selectedRealTurns = allTurns.slice(anchorIndex)
        if (anchorIndex > 0) {
          boundaryMessageId = selectedRealTurns[0].messages[0].id
        }
        currentCount = selectedRealTurns.length + (hasDraftPreview ? 1 : 0)
      } else {
        selectedRealTurns = allTurns
        currentCount = hasDraftPreview ? 1 : 0
      }
    } else {
      // No anchor (undefined or legacy data) — display shows 0 regardless of draft,
      // model gets all turns so ConversationService receives full filtered history.
      selectedRealTurns = allTurns
      currentCount = 0
    }
    maxCount = null
  } else {
    // Sliding mode: select the last N turns (N = rawContextCount).
    if (isUnlimited) {
      selectedRealTurns = allTurns
      currentCount = allTurns.length + (hasDraftPreview ? 1 : 0)
      maxCount = null
    } else {
      const n = rawContextCount
      // Total turn count includes the virtual draft turn when previewing.
      const totalTurns = allTurns.length + (hasDraftPreview ? 1 : 0)
      if (totalTurns <= n) {
        // All real turns fit alongside the virtual draft turn.
        selectedRealTurns = allTurns
        currentCount = totalTurns
      } else {
        // At capacity: the virtual draft turn occupies one slot, so keep n-1 real turns.
        const realTurnsToKeep = hasDraftPreview ? n - 1 : n
        selectedRealTurns = allTurns.slice(Math.max(0, allTurns.length - realTurnsToKeep))
        currentCount = n
      }
      maxCount = rawContextCount
      // Boundary: first message of the first selected real turn, only when older turns exist.
      if (allTurns.length > selectedRealTurns.length && selectedRealTurns.length > 0) {
        boundaryMessageId = selectedRealTurns[0].messages[0].id
      }
    }
  }

  // --- Step 3: Expand selected real turns to Message[] ---
  // The virtual draft turn is never expanded — draft tokens are added by the caller.
  const expandedMessages = turnsToMessages(selectedRealTurns)

  // --- Steps 4-7: Model filters ---
  const usefulMessages = filterUsefulMessages(expandedMessages)
  const withoutErrorOnlyPairs = filterErrorOnlyMessagesWithRelated(usefulMessages)

  // uiMessages: model-facing — trailing assistant removed
  const withoutTrailingAssistant = filterLastAssistantMessage(withoutErrorOnlyPairs)
  const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)

  // --- Steps 8-10: Post-filter cleanup ---
  const contextClearFiltered = filterAfterContextClearMessages(withoutAdjacentUsers)
  const nonEmptyMessages = filterEmptyMessages(contextClearFiltered)
  const uiMessages = filterUserRoleStartMessages(nonEmptyMessages)

  // tokenEstimationMessages: retains trailing assistant for token estimation.
  const tokenWithoutAdjacentUsers = filterAdjacentUserMessaegs(withoutErrorOnlyPairs)
  const tokenContextClearFiltered = filterAfterContextClearMessages(tokenWithoutAdjacentUsers)
  const tokenNonEmptyMessages = filterEmptyMessages(tokenContextClearFiltered)
  const tokenEstimationMessages = filterUserRoleStartMessages(tokenNonEmptyMessages)

  return {
    uiMessages,
    tokenEstimationMessages,
    boundaryMessageId,
    contextCount: { current: currentCount, max: maxCount }
  }
}
