import { getAssistantSettings } from '@renderer/services/AssistantService'
import {
  buildContextTurns,
  type ContextTurn,
  resolveAnchorTurnIndex,
  turnsToMessages
} from '@renderer/services/contextTurnService'
import { isResolvableAnchor, resolveDefaultAnchorIndex } from '@renderer/services/contextWindowService'
import type { BlockOverlay } from '@renderer/services/requestBlockOverlay'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import {
  filterAdjacentUserMessaegs,
  filterEmptyMessages,
  filterErrorOnlyMessagesWithRelated,
  filterLastAssistantMessage,
  filterUsefulMessages,
  filterUserRoleStartMessages
} from '@renderer/utils/messageUtils/filters'
import type { FetchContextClosureResponse } from '@shared/chatDb'

/**
 * The single unified pipeline for computing all context-related information
 * when no authoritative closure is available (bounded fallback).
 *
 * This function is the sole source of truth for fallback derivation:
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
 * There is exactly ONE context window model: stable anchor-to-topic-end
 * (`docs/adr/context-window.md`).
 *   - A valid persisted anchor (`settings.contextWindowAnchor[topicId]`) fixes
 *     the window start; the window then grows as the topic grows.
 *   - With no (valid) persisted anchor — an empty topic, an uninitialized
 *     topic, or an invalid legacy anchor — the start falls back to the
 *     default-derived position from the assistant's default `contextCount`
 *     via `resolveDefaultAnchorIndex`. This fallback is a safety projection
 *     only for uninitialized/invalid states; it is NOT an ongoing sliding
 *     policy. First establishment and compatibility repair persist a real
 *     anchor at this position so the fallback does not drive steady-state
 *     behavior.
 *
 * Anchor semantics: every non-empty resolved context window
 * has exactly one anchor — the canonical group key of the start turn
 * (`anchorGroupKey = allTurns[startIndex].key`). Empty windows (no assistant or
 * no turns) have `anchorGroupKey === null`. The persisted anchor, first
 * establishment, re-anchor, and deletion transfer are all mechanisms that
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
 *   4-9. Message-level model/token filters — implemented ONCE in
 *        {@link filterContextMessages} and shared with the authoritative
 *        closure projection and request preparation (that helper's doc lists
 *        the exact filter order and the single trailing-assistant divergence)
 *
 * N+2 compensation is removed: selection is by whole turns, so post-selection
 * model filters (steps 4–7) cannot create partial turn boundaries that would
 * need message-level compensation. The model may receive fewer messages than
 * the expanded turn count, but this is expected — model filters remove invalid
 * messages within the selected product window.
 *
 * This is a pure function — it reads store state for block lookups but makes no mutations.
 */
export type ContextInfo = {
  uiMessages: Message[]
  tokenEstimationMessages: Message[]
  boundaryMessageId: string | null
  contextCount: { current: number; max: number | null }
  /** Canonical resolved anchor: the start turn's group key, or null for an
   *  empty/undefined window. Sole expression of the effective window start. */
  anchorGroupKey: string | null
  /**
   * Authority-pending marker (UI only): true when a persisted route anchor
   * exists but no fresh authoritative closure is available yet (initial fetch
   * or pending branch switch). Consumers must NOT substitute viewport-derived
   * counts/anchor/boundary in this state — use existing optional/loading
   * rendering (hide TokenCount, no divider) rather than misleading partial
   * counts. False/undefined means the result is authoritative (closure) or
   * the legitimate empty/no-anchor fallback. Request paths keep their
   * explicitly allowed availability fallback separately and never set this.
   */
  isAuthoritativePending?: boolean
}

/**
 * The single message-level filter pipeline shared by every context consumer.
 *
 * Input boundary: `anchorClippedMessages` is ALREADY the authoritative
 * anchor-to-trigger message slice in authority order. This pipeline never
 * groups turns, never resolves the anchor, and never selects a window — that is
 * decided once upstream:
 *   - bounded fallback (`computeContextInfo`): the turns of the resolved anchor
 *     window expanded back to messages;
 *   - authoritative closure (`deriveContextInfoFromClosure`): the Main
 *     anchor-to-end closure;
 *   - request preparation (`ConversationService`): the validated Main closure
 *     clipped through the triggering user.
 *
 * One shared prefix, then the two consumers:
 *   prefix       filterUsefulMessages -> filterErrorOnlyMessagesWithRelated
 *   model-facing prefix -> filterLastAssistantMessage -> filterAdjacentUserMessaegs
 *                -> filterEmptyMessages -> filterUserRoleStartMessages
 *   token        prefix -> filterAdjacentUserMessaegs -> filterEmptyMessages
 *                -> filterUserRoleStartMessages
 *
 * The only divergence is trailing-assistant removal on the model branch (a
 * request must not end on an assistant message, while token estimation keeps
 * it). Ordering is preserved: adjacent-user collapsing runs after that removal
 * on the model branch, so a user pair exposed by dropping the trailing
 * assistant is still collapsed.
 */
export function filterContextMessages(
  anchorClippedMessages: Message[],
  overlay?: BlockOverlay
): { uiMessages: Message[]; tokenEstimationMessages: Message[] } {
  const modelCandidates = toModelCandidates(anchorClippedMessages, overlay)
  return {
    uiMessages: toUiMessages(modelCandidates, overlay),
    tokenEstimationMessages: toTokenEstimationMessages(modelCandidates, overlay)
  }
}

/**
 * Model-facing messages of the shared pipeline. Request preparation consumes
 * only this half, so it never builds the token-estimation list it would
 * discard.
 */
export function filterContextUiMessages(anchorClippedMessages: Message[], overlay?: BlockOverlay): Message[] {
  return toUiMessages(toModelCandidates(anchorClippedMessages, overlay), overlay)
}

/** Shared prefix: retry dedup inside assistant groups, then error-only pairs. */
function toModelCandidates(anchorClippedMessages: Message[], overlay?: BlockOverlay): Message[] {
  return filterErrorOnlyMessagesWithRelated(filterUsefulMessages(anchorClippedMessages), overlay)
}

/** Model-facing branch: drops the trailing assistant before final cleanup. */
function toUiMessages(modelCandidates: Message[], overlay?: BlockOverlay): Message[] {
  const withoutTrailingAssistant = filterLastAssistantMessage(modelCandidates)
  const withoutAdjacentUsers = filterAdjacentUserMessaegs(withoutTrailingAssistant)
  return filterUserRoleStartMessages(filterEmptyMessages(withoutAdjacentUsers, overlay))
}

/** Token-estimation branch: retains the trailing assistant. */
function toTokenEstimationMessages(modelCandidates: Message[], overlay?: BlockOverlay): Message[] {
  const withoutAdjacentUsers = filterAdjacentUserMessaegs(modelCandidates)
  return filterUserRoleStartMessages(filterEmptyMessages(withoutAdjacentUsers, overlay))
}

export function computeContextInfo(
  messages: Message[],
  assistant: Assistant | undefined,
  topicId?: string,
  overlay?: BlockOverlay,
  branchId?: string | null
): ContextInfo {
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
  // contextCount: the assistant default/initial/reset window size (turn count).
  // null means unlimited. Changing it never moves an existing anchor (CW-1).
  const contextCount = settings.contextCount

  // --- Step 1: Build turns from all topic messages ---
  const allTurns = buildContextTurns(messages)
  const totalTurns = allTurns.length

  // --- Step 2: Turn selection (single stable anchor-to-end mode) ---
  // A valid persisted anchor fixes the window start; the window grows as the
  // topic grows. Without a valid anchor (empty/uninitialized/invalid legacy
  // state) the start falls back to the default-derived position — a safety
  // projection, never an ongoing sliding policy.
  let startIndex: number
  const routeKey = topicId
    ? typeof branchId === 'string' && branchId.length > 0
      ? `${topicId}:${branchId}`
      : topicId
    : undefined
  const persistedAnchor = topicId && routeKey ? settings.contextWindowAnchor?.[routeKey] : undefined
  if (isResolvableAnchor(persistedAnchor, allTurns)) {
    startIndex = resolveAnchorTurnIndex(allTurns, persistedAnchor.groupKey)
  } else {
    startIndex = resolveDefaultAnchorIndex(allTurns, contextCount)
  }

  const selectedRealTurns: readonly ContextTurn[] = startIndex < 0 ? [] : allTurns.slice(startIndex)

  // Boundary divider: first message of the first selected turn, only when
  // older turns exist before the window start.
  const boundaryMessageId = startIndex > 0 && selectedRealTurns.length > 0 ? selectedRealTurns[0].messages[0].id : null

  // Anchor: the canonical group key of the start turn. Empty
  // windows have no anchor. The persisted anchor, first establishment,
  // re-anchor, and deletion transfer all resolve to this same key; the anchor
  // is the single expression of the effective window start.
  const anchorGroupKey = startIndex >= 0 ? allTurns[startIndex].key : null

  // contextCount: current selected turns / total turns in the
  // topic. Drafts are never in the turn list, so they are excluded from both x
  // and y.
  const currentCount = selectedRealTurns.length
  const maxCount = totalTurns

  // --- Step 3: Expand selected real turns to Message[] ---
  const expandedMessages = turnsToMessages(selectedRealTurns)

  // --- Steps 4-9: The one shared message-level model/token filter pipeline ---
  const { uiMessages, tokenEstimationMessages } = filterContextMessages(expandedMessages, overlay)

  return {
    uiMessages,
    tokenEstimationMessages,
    boundaryMessageId,
    contextCount: { current: currentCount, max: maxCount },
    anchorGroupKey
  }
}

/**
 * Derive context info from an authoritative validated closure (LOCK-001/003).
 *
 * The closure is the authoritative anchor-to-newest slice from Main (SQLite).
 * Metadata (anchorGroupKey, boundaryMessageId, contextCount) is taken directly
 * from closure.closure — which was derived from the complete authority-ordered
 * turn set and resolved anchor — never recomputed from bounded renderer state.
 * Message filtering (model/token/UI) is applied to closure.messages using the
 * same filter pipeline as the fallback, so the working set stays bounded while
 * the counts remain full-topic.
 *
 * Callers must ensure the closure has passed isValidContextClosureResponse /
 * getFreshValidatedClosure; this helper does not revalidate counts, it
 * projects them.
 */

/**
 * Minimal shared projection boundary used by Chat and order-sensitive tests.
 *
 * Authority-only UI projection: a fresh authoritative closure projects
 * full-route counts/metadata (viewport-independent). When no fresh closure
 * is available but a persisted route anchor exists, returns an
 * authority-pending result (persisted anchor, no divider, empty lists,
 * `isAuthoritativePending: true`) — callers must NOT substitute
 * viewport-derived counts/anchor/boundary in this state. Only when no
 * persisted anchor exists (empty route / uninitialized legacy) does the
 * bounded fallback derive from loaded viewport messages. No timing, no
 * diagnostics, no side effects — Chat wraps this with phase-timing only.
 * Extracted so the TokenCount re-anchor committed-render regression
 * constrains the exact product semantics. Actual provider requests never
 * consume the pending marker or the bounded fallback as authority: they read
 * the caller-local Main closure directly (ConversationService) and fail
 * closed on read failure. Only usage-estimate paths (baseCallbacks) retain
 * their explicitly allowed estimate fallback.
 */
export function resolveSharedContextInfo(
  topicMessages: Message[],
  assistant: Assistant | undefined,
  topicId: string,
  freshClosure: FetchContextClosureResponse | null,
  branchId?: string | null
): ContextInfo {
  if (freshClosure) {
    return { ...deriveContextInfoFromClosure(freshClosure), isAuthoritativePending: false }
  }
  const routeKey = typeof branchId === 'string' && branchId.length > 0 ? `${topicId}:${branchId}` : topicId
  const persisted =
    assistant !== undefined
      ? (getAssistantSettings(assistant).contextWindowAnchor?.[routeKey] as
          | { kind: string; groupKey: string }
          | undefined)
      : undefined
  const persistedKey = persisted?.kind === 'active' ? persisted.groupKey : null
  if (persistedKey) {
    return {
      uiMessages: [],
      tokenEstimationMessages: [],
      boundaryMessageId: null,
      contextCount: { current: 0, max: null },
      anchorGroupKey: persistedKey,
      isAuthoritativePending: true
    }
  }
  return {
    ...computeContextInfo(topicMessages, assistant, topicId, undefined, branchId ?? null),
    isAuthoritativePending: false
  }
}

export function deriveContextInfoFromClosure(closure: FetchContextClosureResponse): ContextInfo {
  // Closure messages are already the authoritative anchor-to-end slice, so only
  // the shared message-level pipeline applies — no turn grouping, no anchor
  // resolution. No overlay is passed (unchanged): this projection keeps
  // resolving blocks from the store rather than from closure blocks.
  const { uiMessages, tokenEstimationMessages } = filterContextMessages(closure.messages as unknown as Message[])

  return {
    uiMessages,
    tokenEstimationMessages,
    boundaryMessageId: closure.closure.boundaryMessageId,
    contextCount: { current: closure.closure.selectedTurnCount, max: closure.closure.totalTurnCount },
    anchorGroupKey: closure.closure.anchorGroupKey,
    isAuthoritativePending: false
  }
}
