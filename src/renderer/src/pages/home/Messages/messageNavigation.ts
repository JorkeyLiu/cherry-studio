import type { Message } from '@renderer/types/newMessage'

import { createMessageViewportGroupModel } from './messageGroups'
import type { MessageViewportNavigationSource, MessageViewportNavigationToken } from './messageViewportReducer'
import type { MessageViewportState } from './messageViewportReducer'
import {
  createLatestMessageWindow,
  createOldestMessageWindow,
  createTargetMessageWindow,
  type MessageWindow
} from './messageWindow'

export const NAVIGATION_VISUALLY_OLDER_GROUPS = 10
export const NAVIGATION_VISUALLY_NEWER_GROUPS = 19

export type MessageNavigationAlignment = 'start' | 'center' | 'end'

/**
 * Resolves a navigation result to the concrete scroll target for a column-reverse container.
 * Returns `{ top: number }` for programmatic scrollTo calls, or `null` for message-level
 * targets that require element lookup + scrollIntoView.
 *
 * In a column-reverse layout:
 *   - scrollTop ≈ 0 is the bottom (newest messages)
 *   - Negative scrollTop scrolls toward the visual top (oldest messages)
 *
 * 'top' uses -scrollHeight so the browser clamps to the actual minimum scrollTop.
 * 'bottom' uses 0 (the natural resting position).
 */
export const resolveColumnReverseScrollTarget = (
  resolved: ResolvedMessageNavigation,
  scrollHeight: number
): { top: number } | null => {
  if (resolved.kind === 'bottom') return { top: 0 }
  if (resolved.kind === 'top') return { top: -scrollHeight }
  if (resolved.kind === 'scrollTop') return { top: resolved.scrollTop }
  // 'message' kind requires DOM element lookup; handled separately by the caller.
  return null
}

/**
 * Minimal container interface for column-reverse scroll operations.
 * Satisfied by the real scroll container element (scrollHeight + scrollTo).
 */
export interface ColumnReverseScrollContainer {
  readonly scrollHeight: number
  scrollTo(options: { top: number }): void
}

/**
 * Applies the concrete scroll for a resolved navigation intent in a column-reverse container.
 *
 * - top/bottom/scrollTop: delegates to `container.scrollTo`.
 * - message: delegates to the `scrollElementIntoView` callback (DOM element lookup).
 *
 * This is the single call-site for navigation scroll execution — Messages.tsx's
 * transaction `scroll` callback calls this rather than duplicating the switch.
 */
export const applyColumnReverseScroll = (
  resolved: ResolvedMessageNavigation,
  container: ColumnReverseScrollContainer | null | undefined,
  scrollElementIntoView: (targetId: string, alignment: MessageNavigationAlignment) => void
): void => {
  const scrollTarget = resolveColumnReverseScrollTarget(resolved, container?.scrollHeight ?? 0)
  if (scrollTarget) {
    container?.scrollTo(scrollTarget)
  } else if (resolved.kind === 'message') {
    scrollElementIntoView(resolved.targetId, resolved.alignment)
  }
}

export type MessageNavigationIntent =
  | {
      kind: 'message'
      targetId: string
      source: MessageViewportNavigationSource
      alignment?: MessageNavigationAlignment
    }
  | {
      kind: 'group'
      groupId: string
      source: 'group'
      alignment?: MessageNavigationAlignment
    }
  | { kind: 'bottom'; source: MessageViewportNavigationSource }
  | { kind: 'top'; source: MessageViewportNavigationSource }
  | { kind: 'scrollTop'; scrollTop: number; source: 'restore' }

export type ResolvedMessageNavigation =
  | { kind: 'message'; targetId: string; alignment: MessageNavigationAlignment }
  | { kind: 'bottom' }
  | { kind: 'top' }
  | { kind: 'scrollTop'; scrollTop: number }

export type MessageNavigationResult = 'success' | 'not-found' | 'cancelled'

/**
 * Determines whether a successful navigation result should trigger scroll position
 * persistence. Returns true only for 'success' — callers use this to decide
 * whether to persist after any navigation transaction.
 *
 * Callers that must NOT persist (SEND_MESSAGE, NEW_CONTEXT) simply skip this
 * check entirely by using `navigate()` directly without persistence.
 */
export const shouldPersistNavigationResult = (result: MessageNavigationResult): boolean => result === 'success'

export const canHandleUserViewportScroll = (state: Pick<MessageViewportState, 'navigation' | 'scrollMode'>): boolean =>
  state.navigation.phase === 'idle' && state.scrollMode === 'user'

/**
 * Saved scroll position snapshot persisted by useScrollPosition.
 * Mirrors the internal SavedScrollPosition type from that hook.
 */
export interface SavedScrollPositionSnapshot {
  scrollTop: number
  anchorId: string | null
  isAtBottom: boolean
}

export type BootstrapPhase = 'idle' | 'pending-in-flight' | 'done'

export interface BootstrapDecisionInput {
  phase: BootstrapPhase
  isTopicLoading: boolean
  topicId: string
  pending: { messageId: string; topicId: string } | null
  savedPosition: SavedScrollPositionSnapshot | null
  savedRestoreHandled: boolean
}

export type BootstrapDecision =
  | { action: 'wait' }
  | { action: 'pending'; intent: MessageNavigationIntent }
  | { action: 'restore'; intent: MessageNavigationIntent }
  | { action: 'done' }

/**
 * Pure decision function for topic-mount navigation bootstrap.
 * Priority: matching pending > saved restore > default (latest).
 * Returns the action the caller should take.
 */
export const resolveBootstrapDecision = (input: BootstrapDecisionInput): BootstrapDecision => {
  const { phase, isTopicLoading, topicId, pending, savedPosition, savedRestoreHandled } = input

  if (isTopicLoading) return { action: 'wait' }
  if (phase === 'done') return { action: 'done' }
  if (phase === 'pending-in-flight') return { action: 'wait' }

  // Priority 1: matching pending
  if (pending && pending.topicId === topicId) {
    return { action: 'pending', intent: { kind: 'message', targetId: pending.messageId, source: 'pending' } }
  }

  // Priority 2: saved restore (only when no matching pending exists)
  if (!savedRestoreHandled && savedPosition) {
    const intent: MessageNavigationIntent | null = savedPosition.isAtBottom
      ? { kind: 'bottom', source: 'restore' }
      : savedPosition.anchorId
        ? { kind: 'message', targetId: savedPosition.anchorId, source: 'restore' }
        : savedPosition.scrollTop !== undefined
          ? { kind: 'scrollTop', scrollTop: savedPosition.scrollTop, source: 'restore' }
          : null

    if (intent) return { action: 'restore', intent }
  }

  // Priority 3: default — handled by window reconciliation effect
  return { action: 'done' }
}

/**
 * Given the full chronological message sequence, a baseline user message ID,
 * and a direction, resolve the adjacent user message.
 *
 * Returns the target user message ID, or `null` when the baseline is already
 * at the true topic boundary (first/last user message in the full sequence).
 *
 * Used by Messages→ChatNavigation to navigate beyond the rendered viewport window.
 * Pure function — no DOM, no side-effects.
 */
export const resolveAdjacentUserMessage = (
  messages: Message[],
  currentMessageId: string,
  direction: 'newer' | 'older'
): string | null => {
  const currentIndex = messages.findIndex((m) => m.id === currentMessageId)
  if (currentIndex === -1) return null

  if (direction === 'newer') {
    for (let i = currentIndex + 1; i < messages.length; i++) {
      if (messages[i].role === 'user' && messages[i].type !== 'clear') {
        return messages[i].id
      }
    }
  } else {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].type !== 'clear') {
        return messages[i].id
      }
    }
  }
  return null
}

export const resolveMessageNavigation = (
  messages: Message[],
  intent: MessageNavigationIntent
): ResolvedMessageNavigation | null => {
  if (intent.kind === 'bottom') return { kind: 'bottom' }
  if (intent.kind === 'top') return { kind: 'top' }
  if (intent.kind === 'scrollTop') return { kind: 'scrollTop', scrollTop: intent.scrollTop }

  if (intent.kind === 'message') {
    return messages.some((message) => message.id === intent.targetId)
      ? { kind: 'message', targetId: intent.targetId, alignment: intent.alignment ?? 'start' }
      : null
  }

  const model = createMessageViewportGroupModel(messages)
  const group = model.groups.find(
    (candidate) =>
      candidate.key === intent.groupId || candidate.messages.some((message) => message.id === intent.groupId)
  )
  const target = group?.messages[0]
  return target ? { kind: 'message', targetId: target.id, alignment: intent.alignment ?? 'start' } : null
}

export const chooseNavigationWindow = (
  messages: Message[],
  currentWindow: MessageWindow | null,
  resolved: ResolvedMessageNavigation,
  latestGroupCount: number
): MessageWindow | null => {
  if (resolved.kind === 'bottom') return createLatestMessageWindow(messages, latestGroupCount)
  if (resolved.kind === 'top') return createOldestMessageWindow(messages, latestGroupCount)
  if (resolved.kind === 'scrollTop') return currentWindow ? null : createLatestMessageWindow(messages, latestGroupCount)
  if (currentWindow?.displayMessages.some((message) => message.id === resolved.targetId)) return null

  return createTargetMessageWindow(
    messages,
    resolved.targetId,
    NAVIGATION_VISUALLY_OLDER_GROUPS,
    NAVIGATION_VISUALLY_NEWER_GROUPS
  )
}

interface MessageNavigationTransactionDependencies {
  begin: (
    token: MessageViewportNavigationToken,
    targetId: string | null,
    source: MessageViewportNavigationSource,
    alignment: MessageNavigationAlignment
  ) => Promise<boolean>
  isCurrent: (token: MessageViewportNavigationToken) => boolean
  cancelLoadsAndTimers: () => void
  resolve: (intent: MessageNavigationIntent) => ResolvedMessageNavigation | null
  prepareWindow: (resolved: ResolvedMessageNavigation) => MessageWindow | null
  applyWindow: (token: MessageViewportNavigationToken, window: MessageWindow) => Promise<boolean>
  getTargetStatus: (targetId: string) => 'visible' | 'hidden' | 'missing'
  revealTarget: (targetId: string) => Promise<void>
  settleDom: () => Promise<void>
  beginProgrammaticScroll: (token: MessageViewportNavigationToken) => Promise<boolean>
  scroll: (resolved: ResolvedMessageNavigation) => void
  finish: (token: MessageViewportNavigationToken) => void
  cancel: (token: MessageViewportNavigationToken) => void
}

// ---------------------------------------------------------------------------
// Pending event coordination
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a pending navigate identity.
 * Matches the PendingNavigate type in MessagesService.
 */
export interface PendingNavigateIdentity {
  messageId: string
  topicId: string
}

/** Dependencies accepted by {@link handlePendingNavigateEvent} for testability. */
export interface PendingEventDeps {
  /** Read the current pending navigate (e.g. MessagesService.getPendingNavigate). */
  getPending: () => PendingNavigateIdentity | null
  /** Compare-and-clear a pending by expected identity. */
  clearPending: (expected: PendingNavigateIdentity) => boolean
  /** Execute the navigation transaction. */
  navigate: (intent: MessageNavigationIntent) => Promise<MessageNavigationResult>
  /** Called after a matched pending is successfully consumed. */
  onDone: () => void
}

/** Result returned by {@link handlePendingNavigateEvent}. */
export interface PendingEventResult {
  result: MessageNavigationResult
  /** 'pending' when the event matched the current pending identity exactly, 'event' otherwise. */
  source: 'pending' | 'event'
}

/**
 * Coordinates NAVIGATE_TO_MESSAGE event handling with pending identity matching.
 *
 * Decision logic (single implementation — no duplicate in tests):
 *   1. Read the current pending; check exact match on both topicId AND messageId.
 *   2. If matched → source='pending'; otherwise → source='event'.
 *   3. Navigate with the chosen source.
 *   4. If matched AND result !== 'cancelled' → compare-and-clear the pending, call onDone.
 *   5. If cancelled → preserve the pending (no clear, no onDone).
 */
export const handlePendingNavigateEvent = async (
  topicId: string,
  messageId: string,
  deps: PendingEventDeps
): Promise<PendingEventResult> => {
  const pending = deps.getPending()
  const isPendingMatch = pending !== null && pending.topicId === topicId && pending.messageId === messageId
  const source: 'pending' | 'event' = isPendingMatch ? 'pending' : 'event'
  const result = await deps.navigate({
    kind: 'message',
    targetId: messageId,
    source
  })
  if (isPendingMatch && pending && result !== 'cancelled') {
    if (deps.clearPending(pending)) {
      deps.onDone()
    }
  }
  return { result, source }
}

// ---------------------------------------------------------------------------
// Transaction runner
// ---------------------------------------------------------------------------

/** Runs every message/restoration navigation through one last-navigation-wins transaction. */
export const runMessageNavigationTransaction = async (
  intent: MessageNavigationIntent,
  dependencies: MessageNavigationTransactionDependencies
): Promise<MessageNavigationResult> => {
  const token: MessageViewportNavigationToken = {}
  const requestedTarget = intent.kind === 'message' ? intent.targetId : null
  const alignment = 'alignment' in intent ? (intent.alignment ?? 'start') : 'start'

  if (!(await dependencies.begin(token, requestedTarget, intent.source, alignment))) return 'cancelled'
  if (!dependencies.isCurrent(token)) return 'cancelled'

  dependencies.cancelLoadsAndTimers()
  const resolved = dependencies.resolve(intent)
  if (!resolved) {
    dependencies.cancel(token)
    return 'not-found'
  }

  const window = dependencies.prepareWindow(resolved)
  if (window && !(await dependencies.applyWindow(token, window))) return 'cancelled'
  if (!dependencies.isCurrent(token)) return 'cancelled'
  dependencies.cancelLoadsAndTimers()

  await dependencies.settleDom()
  if (!dependencies.isCurrent(token)) return 'cancelled'

  if (resolved.kind === 'message') {
    const status = dependencies.getTargetStatus(resolved.targetId)
    if (status === 'hidden') {
      await dependencies.revealTarget(resolved.targetId)
      if (!dependencies.isCurrent(token)) return 'cancelled'
      await dependencies.settleDom()
      if (!dependencies.isCurrent(token)) return 'cancelled'
    }
    if (dependencies.getTargetStatus(resolved.targetId) !== 'visible') {
      dependencies.cancel(token)
      return 'not-found'
    }
  }

  if (!(await dependencies.beginProgrammaticScroll(token))) return 'cancelled'
  if (!dependencies.isCurrent(token)) return 'cancelled'
  dependencies.scroll(resolved)
  await dependencies.settleDom()
  if (!dependencies.isCurrent(token)) return 'cancelled'
  dependencies.finish(token)
  return 'success'
}
