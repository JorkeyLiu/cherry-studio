import { getAssistantSettings } from '@renderer/services/AssistantService'
import {
  buildContextTurns,
  type ContextTurn,
  resolveAnchorTurnIndex,
  turnsToMessages
} from '@renderer/services/contextTurnService'
import { resolveDefaultAnchorIndex } from '@renderer/services/contextWindowService'
import type { Assistant, ContextStartOverride } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import {
  filterAdjacentUserMessaegs,
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
 *   - Which messages the token estimator uses (tokenEstimationMessages — retains trailing assistant)
 *   - Where the context window boundary divider should render (boundaryMessageId)
 *   - What TokenCount displays (contextCount)
 *   - The single resolved anchor of the context window (anchorGroupKey)
 *
 * Canonical unit: ContextTurn. contextCount, window selection, and boundary
 * all operate on whole turns. The persisted contextCount value is interpreted
 * as a turn count (not a message count).
 *
 * There is exactly ONE context window model: anchor-to-topic-end.
 *   - A valid user context-start override (`settings.contextStartOverride[topicId]`)
 *     fixes the window start; the window then grows as the topic grows.
 *   - With no (valid) override, the start is derived from the assistant's default
 *     `contextCount` via `resolveDefaultAnchorIndex` — finite N selects the
 *     most recent N turns (so full history is never transiently sent), and
 *     null (unlimited) selects the first turn of the topic.
 *
 * Anchor semantics: every non-empty resolved context window
 * has exactly one anchor — the canonical group key of the start turn
 * (`anchorGroupKey = allTurns[startIndex].key`). Empty windows (no assistant or
 * no turns) have `anchorGroupKey === null`. Automatic/default calculation, user
 * override, override deletion, and deletion transfer are all mechanisms that
 * determine this same resolved position; origin is not part of anchor semantics.
 *
 * contextCount result: `current` = selected real turns, `max` =
 * total turns in the topic. Unsent drafts are never part of the turn list, so
 * they are excluded from both numbers automatically.
 *
 * Pipeline ordering:
 *   1. buildContextTurns — groups all topic turns into semantic turns
 *   2. Turn selection — anchor-to-end, or default derivation when no anchor
 *   3. turnsToMessages — expands selected turns to Message[]
 *   4. filterUsefulMessages — deduplicates retries within assistant groups
 *   5. filterErrorOnlyMessagesWithRelated — removes error-only pairs
 *   6. filterLastAssistantMessage — removes trailing assistant message
 *   7. filterAdjacentUserMessaegs — removes adjacent duplicate user messages
 *   8. filterEmptyMessages — removes messages without content blocks
 *   9. filterUserRoleStartMessages — trims leading non-user messages
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
): {
  uiMessages: Message[]
  tokenEstimationMessages: Message[]
  boundaryMessageId: string | null
  contextCount: { current: number; max: number | null }
  /** Canonical resolved anchor: the start turn's group key, or null for an
   *  empty/undefined window. Sole expression of the effective window start. */
  anchorGroupKey: string | null
} {
  if (!assistant) {
    return {
      uiMessages: [],
      tokenEstimationMessages: [],
      boundaryMessageId: null,
      contextCount: { current: 0, max: null },
      anchorGroupKey: null
    }
  }

  const settings = getAssistantSettings(assistant)
  // contextCount: the default initial window size. null means unlimited.
  const contextCount = settings.contextCount

  const override: ContextStartOverride | undefined = topicId ? settings.contextStartOverride?.[topicId] : undefined

  // --- Step 1: Build turns from all topic messages ---
  const allTurns = buildContextTurns(messages)
  const totalTurns = allTurns.length

  // --- Step 2: Turn selection (single anchor-to-end mode) ---
  // A valid user override fixes the window start; the window grows as the
  // topic grows. Without a valid override, the start falls back to
  // the default derivation — finite N selects the most recent N turns,
  // unlimited selects the first turn of the topic.
  let startIndex: number
  if (override?.kind === 'active') {
    const overrideIndex = resolveAnchorTurnIndex(allTurns, override.groupKey)
    startIndex = overrideIndex >= 0 ? overrideIndex : resolveDefaultAnchorIndex(allTurns, contextCount)
  } else {
    startIndex = resolveDefaultAnchorIndex(allTurns, contextCount)
  }

  const selectedRealTurns: readonly ContextTurn[] = startIndex < 0 ? [] : allTurns.slice(startIndex)

  // Boundary divider: first message of the first selected turn, only when
  // older turns exist before the window start.
  const boundaryMessageId = startIndex > 0 && selectedRealTurns.length > 0 ? selectedRealTurns[0].messages[0].id : null

  // Anchor: the canonical group key of the start turn. Empty
  // windows have no anchor. Automatic/default calculation, user override,
  // override deletion, and deletion transfer all resolve to this same key.
  const anchorGroupKey = startIndex >= 0 ? allTurns[startIndex].key : null

  // contextCount: current selected turns / total turns in the
  // topic. Drafts are never in the turn list, so they are excluded from both x
  // and y.
  const currentCount = selectedRealTurns.length
  const maxCount = totalTurns

  // --- Step 3: Expand selected real turns to Message[] ---
  const expandedMessages = turnsToMessages(selectedRealTurns)

  // --- Steps 4-7: Model filters ---
  const usefulMessages = filterUsefulMessages(expandedMessages)
  const withoutErrorOnlyPairs = filterErrorOnlyMessagesWithRelated(usefulMessages)

  // uiMessages: model-facing — trailing assistant removed
  const withoutTrailingAssistant = filterLastAssistantMessage(withoutErrorOnlyPairs)
  const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)

  // --- Steps 8-9: Post-filter cleanup ---
  const nonEmptyMessages = filterEmptyMessages(withoutAdjacentUsers)
  const uiMessages = filterUserRoleStartMessages(nonEmptyMessages)

  // tokenEstimationMessages: retains trailing assistant for token estimation.
  const tokenWithoutAdjacentUsers = filterAdjacentUserMessaegs(withoutErrorOnlyPairs)
  const tokenNonEmptyMessages = filterEmptyMessages(tokenWithoutAdjacentUsers)
  const tokenEstimationMessages = filterUserRoleStartMessages(tokenNonEmptyMessages)

  return {
    uiMessages,
    tokenEstimationMessages,
    boundaryMessageId,
    contextCount: { current: currentCount, max: maxCount },
    anchorGroupKey
  }
}
