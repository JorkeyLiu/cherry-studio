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
  readonly clientHeight: number
  readonly scrollTop: number
  scrollTo(options: { top: number }): void
}

/**
 * Pure geometry for positioning a message row inside a column-reverse
 * container (`#messages`: scrollTop 0 is the newest bottom, negative values
 * read toward the oldest top).
 *
 * `elementTopWithinContainer` is the row's content offset
 * (`elRect.top - containerRect.top + container.scrollTop`); `minScrollTop`
 * is the clamped oldest edge (`-(scrollHeight - clientHeight)`, `<= 0`).
 * Returns the finite clamped `scrollTo` top for the requested alignment, or
 * `null` when any input is non-finite (fail-closed: caller skips the write).
 *
 * Native `scrollIntoView({ block: 'start' })` is a no-op for resident rows in
 * this layout (verified: unchanged far-negative target offsets, scrollTop
 * pinned at 0), so navigation scrolls the explicit container arithmetically.
 */
export const computeColumnReverseMessageScrollTop = (args: {
  elementTopWithinContainer: number
  containerClientHeight: number
  elementHeight: number
  alignment: MessageNavigationAlignment
  minScrollTop: number
}): number | null => {
  const { elementTopWithinContainer, containerClientHeight, elementHeight, alignment, minScrollTop } = args
  for (const value of [elementTopWithinContainer, containerClientHeight, elementHeight, minScrollTop]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
  }
  const freeSpace = Math.max(0, containerClientHeight - elementHeight)
  const desired =
    alignment === 'center'
      ? elementTopWithinContainer - freeSpace / 2
      : alignment === 'end'
        ? elementTopWithinContainer - freeSpace
        : elementTopWithinContainer
  if (!Number.isFinite(desired)) return null
  const lower = Math.min(0, minScrollTop)
  return Math.max(lower, Math.min(0, desired))
}

/**
 * Pure geometry for a saved-offset restore inside a column-reverse container.
 *
 * `elementTopWithinContainer` is the row's content offset
 * (`elRect.top - containerRect.top + container.scrollTop`, i.e. the scrollTop
 * at which the row would sit at offset 0); `restoreOffset` is the saved
 * stable intra-row offset (row top minus container top, negative above the
 * fold). Returns the finite clamped `scrollTo` top that lands the row exactly
 * at its saved offset, or `null` when the offset is not a finite number
 * (fail-closed: the caller keeps its alignment path).
 */
export const computeRestoreMessageScrollTop = (args: {
  elementTopWithinContainer: number
  restoreOffset: number | null | undefined
  minScrollTop: number
}): number | null => {
  const { elementTopWithinContainer, restoreOffset, minScrollTop } = args
  if (typeof restoreOffset !== 'number' || !Number.isFinite(restoreOffset)) return null
  if (!Number.isFinite(elementTopWithinContainer) || !Number.isFinite(minScrollTop)) return null
  const desired = elementTopWithinContainer - restoreOffset
  if (!Number.isFinite(desired)) return null
  const lower = Math.min(0, minScrollTop)
  return Math.max(lower, Math.min(0, desired))
}

// ---------------------------------------------------------------------------
// Search match landing (Cmd/Ctrl+F)
// ---------------------------------------------------------------------------

/**
 * Minimum readable margin kept between a search hit and the edges of the
 * unobscured reading band (px). A hit already inside the band by at least this
 * margin is "clearly visible" and is not repositioned at all.
 */
export const SEARCH_MATCH_VISIBLE_MARGIN_PX = 24

/**
 * Comfortable gap between a host panel's lower edge and the reading band (px),
 * so a landed hit never touches the panel border.
 */
export const SEARCH_MATCH_READING_PADDING_PX = 16

/**
 * Shortest viewport movement worth animating (px). A shorter move is written
 * instantly: the smooth effect is for a real journey, not for a few pixels.
 */
export const SEARCH_MATCH_ANIMATION_MIN_DISTANCE_PX = 24

/**
 * Positioning descriptor for one chat search hit, handed by the search host to
 * the chat navigation authority.
 *
 * The hit is a text range, not an element: two hits inside one paragraph are
 * the same element but different ranges, so only the range can put the viewport
 * on the exact text. `element` is fallback geometry for a range that no longer
 * measures (a re-render replaced the text node), and `overlay` is the host panel
 * painted over the scroll container (the search bar), whose covered strip is
 * excluded from the landing band.
 */
export interface SearchMatchLanding {
  range: Range | null
  element: HTMLElement | null
  overlay: Element | null
}

/** Vertical band of a scroll container that no host panel covers. */
export interface UnobscuredReadingBand {
  /** Band top edge, as an offset from the container's own top edge. */
  top: number
  height: number
}

/**
 * Derives the unobscured reading band from the measured rectangles of the
 * scroll container and of the panel floating over it — never from a hard-coded
 * header height, so the landing point follows the real layout (panel size,
 * container insets, window size).
 *
 * Only a panel that actually covers the container's top area removes height: a
 * panel sitting entirely above the container hides nothing and leaves the full
 * container as the band. `paddingPx` insets both ends for readability.
 *
 * Returns `null` when no usable band remains (unmeasurable input or a panel
 * covering everything), so the caller degrades explicitly instead of landing on
 * a nonsense coordinate.
 */
export const resolveUnobscuredReadingBand = (args: {
  containerTop: number
  containerHeight: number
  obscurer: { top: number; bottom: number } | null
  paddingPx?: number
}): UnobscuredReadingBand | null => {
  const { containerTop, containerHeight, obscurer, paddingPx = SEARCH_MATCH_READING_PADDING_PX } = args
  if (!Number.isFinite(containerTop) || !Number.isFinite(containerHeight) || containerHeight <= 0) return null
  const containerBottom = containerTop + containerHeight
  let coveredBottom = containerTop
  if (obscurer && Number.isFinite(obscurer.top) && Number.isFinite(obscurer.bottom)) {
    if (obscurer.bottom > containerTop)
      coveredBottom = Math.max(coveredBottom, Math.min(obscurer.bottom, containerBottom))
  }
  const padding = Number.isFinite(paddingPx) ? Math.max(0, paddingPx) : 0
  const top = coveredBottom - containerTop + padding
  const height = containerHeight - (coveredBottom - containerTop) - padding * 2
  if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return null
  return { top, height }
}

/**
 * Result of planning one search-hit landing.
 * - `visible`: leave the viewport alone.
 * - `scroll`: write `top`; `animate` decides smooth vs instant.
 * - `null` (see {@link planSearchMatchScroll}): unmeasurable, skip the write.
 */
export type SearchMatchScrollPlan =
  | { kind: 'visible' }
  | { kind: 'scroll'; top: number; distance: number; animate: boolean }
  | null

/**
 * Where a search hit should put the viewport, in the same column-reverse
 * container convention as {@link computeColumnReverseMessageScrollTop}
 * (`scrollTop` 0 is the newest/bottom edge, older content is negative).
 *
 * Three outcomes, never a silent middle ground:
 * - `visible`: the hit already sits clearly inside the unobscured band, so no
 *   reposition happens (a repeated locate of an already readable hit must not
 *   move the viewport).
 * - `scroll`: the `top` to write, its distance from the current position, and
 *   whether that distance is worth animating. The hit is centred in the
 *   unobscured band, never in the raw container, because the covered strip is
 *   not visible reading area.
 * - `null`: an input is not measurable, so the caller skips the write.
 *
 * `animate` is false for reduced-motion users and for a movement shorter than
 * `animateMinDistancePx`; the decision is part of the plan so it stays a pure,
 * checkable rule instead of a call-site improvisation.
 */
export const planSearchMatchScroll = (args: {
  /** Hit top minus container top, in current viewport coordinates. */
  matchTopOffset: number
  matchHeight: number
  containerClientHeight: number
  currentScrollTop: number
  minScrollTop: number
  band: UnobscuredReadingBand
  reducedMotion?: boolean
  visibleMarginPx?: number
  animateMinDistancePx?: number
}): SearchMatchScrollPlan => {
  const {
    matchTopOffset,
    matchHeight,
    containerClientHeight,
    currentScrollTop,
    minScrollTop,
    band,
    reducedMotion = false,
    visibleMarginPx = SEARCH_MATCH_VISIBLE_MARGIN_PX,
    animateMinDistancePx = SEARCH_MATCH_ANIMATION_MIN_DISTANCE_PX
  } = args
  for (const value of [
    matchTopOffset,
    matchHeight,
    containerClientHeight,
    currentScrollTop,
    minScrollTop,
    band?.top,
    band?.height
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
  }
  if (band.height <= 0 || matchHeight < 0) return null

  // Margins are a readability guard, never an impossibility: a hit taller than
  // the band keeps zero margin and only the plain containment test applies.
  const margin = Math.max(0, Math.min(visibleMarginPx, (band.height - matchHeight) / 2))
  const clearlyVisible =
    matchTopOffset >= band.top + margin && matchTopOffset + matchHeight <= band.top + band.height - margin
  if (clearlyVisible) return { kind: 'visible' }

  // Column-reverse keeps the plain content relation `viewportOffset =
  // contentOffset - scrollTop` (the reverse direction lives in the SIGN of
  // scrollTop), which is why raising `scrollTop` moves content up. Centring the
  // hit inside the band therefore is: contentOffset + height/2 - bandCentre.
  const contentOffset = matchTopOffset + currentScrollTop
  const bandCentre = band.top + band.height / 2
  const desired = contentOffset + matchHeight / 2 - bandCentre
  if (!Number.isFinite(desired)) return null
  const lower = Math.min(0, minScrollTop)
  const top = Math.max(lower, Math.min(0, desired))
  if (!Number.isFinite(top)) return null
  const distance = Math.abs(top - currentScrollTop)
  return { kind: 'scroll', top, distance, animate: !reducedMotion && distance >= animateMinDistancePx }
}
/**
 * Truthful scroll outcome for the existing transaction `scroll` callback.
 * Reuses the navigation result contract — no new lifecycle or state:
 * - `cancelled`: currency/topic/route/epoch/new-interaction/unmounted/
 *   owned/controller-refusal skipped the write (preserve pending).
 * - `not-found`: physical target missing/hidden/unmeasurable (authoritative
 *   missing clears pending).
 * - `success`: actually positioned (top/bottom/scrollTop written, or message
 *   row arithmetically positioned). A clamped already-visible target is still
 *   success — no arbitrary delta is required.
 */
export type MessageNavigationScrollOutcome = MessageNavigationResult

/**
 * Applies the concrete scroll for a resolved navigation intent in a column-reverse container.
 *
 * - top/bottom/scrollTop: delegates to `container.scrollTo`.
 * - message: delegates to the `scrollElementIntoView` callback (DOM element lookup).
 *
 * Returns the truthful outcome so the transaction can cancel without
 * finish/savePosition on skipped writes. A `void` callback return is treated
 * as `success` for focused legacy mocks; production callbacks return explicit
 * outcomes.
 *
 * This is the single call-site for navigation scroll execution — Messages.tsx's
 * transaction `scroll` callback calls this rather than duplicating the switch.
 */
export const applyColumnReverseScroll = (
  resolved: ResolvedMessageNavigation,
  container: ColumnReverseScrollContainer | null | undefined,
  scrollElementIntoView: (
    targetId: string,
    alignment: MessageNavigationAlignment
  ) => MessageNavigationScrollOutcome | void
): MessageNavigationScrollOutcome => {
  const scrollTarget = resolveColumnReverseScrollTarget(resolved, container?.scrollHeight ?? 0)
  if (scrollTarget) {
    if (!container) return 'cancelled'
    try {
      container.scrollTo(scrollTarget)
    } catch {
      return 'cancelled'
    }
    return 'success'
  }
  if (resolved.kind === 'message') {
    const outcome = scrollElementIntoView(resolved.targetId, resolved.alignment)
    if (outcome === 'cancelled' || outcome === 'not-found' || outcome === 'success') return outcome
    return 'success'
  }
  return 'cancelled'
}

export type MessageNavigationIntent =
  | {
      kind: 'message'
      targetId: string
      source: MessageViewportNavigationSource
      alignment?: MessageNavigationAlignment
      /**
       * Saved stable intra-row offset (row top minus container top) carried
       * ONLY by bootstrap restore intents. The transaction scroll lands the
       * row at this offset and skips the write when the pre-paint first
       * placement already holds it — so no second (start-aligned) write can
       * cover the correct position. Explicit navigations never set it.
       */
      restoreOffset?: number | null
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
  | { kind: 'message'; targetId: string; alignment: MessageNavigationAlignment; restoreOffset?: number | null }
  | { kind: 'bottom' }
  | { kind: 'top' }
  | { kind: 'scrollTop'; scrollTop: number }

export type MessageNavigationResult = 'success' | 'not-found' | 'cancelled'

/**
 * Determines whether a successful navigation result should trigger scroll position
 * persistence. Returns true only for 'success' — callers use this to decide
 * whether to persist after any navigation transaction.
 *
 * Callers that must NOT persist (SEND_MESSAGE) simply skip this check entirely
 * by using `navigate()` directly without persistence.
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
  /** Canonical route-saved-row-anchor (alias of anchorId for legacy data). */
  messageId?: string | null
  /** anchorTop - containerTop; null = legacy snapshot without offset. */
  intraRowOffset?: number | null
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
 *
 * Lifecycle responsibility (single transaction recovery): topic-mount
 * restores run as ONE bootstrap transaction — the armed plan carries the
 * saved offset for the pre-paint first placement, and the SAME transaction's
 * scroll below converges on the passed-through `restoreOffset` (skipping its
 * write when first placement already holds it). The transaction never falls
 * back to `start` alignment for a restore with a finite saved offset, so no
 * wrong frame can land after first placement. No new owner or subsystem.
 * Returns the action the caller should take.
 */
export const resolveBootstrapDecision = (input: BootstrapDecisionInput): BootstrapDecision => {
  const { phase, isTopicLoading, topicId, pending, savedPosition, savedRestoreHandled } = input

  if (isTopicLoading) return { action: 'wait' }
  if (phase === 'done') return { action: 'done' }
  if (phase === 'pending-in-flight') return { action: 'wait' }

  // Priority 1: matching pending (explicit navigation, never a restore).
  if (pending && pending.topicId === topicId) {
    return { action: 'pending', intent: { kind: 'message', targetId: pending.messageId, source: 'pending' } }
  }

  // Priority 2: saved restore (only when no matching pending exists).
  // Route-saved-row-anchor: messageId canonical, anchorId legacy alias.
  // The finite saved intra-row offset rides on the intent so the transaction
  // scroll restores the stable offset instead of start-aligning the row.
  if (!savedRestoreHandled && savedPosition) {
    const rowAnchor = savedPosition.messageId ?? savedPosition.anchorId
    const restoreOffset =
      typeof savedPosition.intraRowOffset === 'number' && Number.isFinite(savedPosition.intraRowOffset)
        ? savedPosition.intraRowOffset
        : null
    const intent: MessageNavigationIntent | null = savedPosition.isAtBottom
      ? { kind: 'bottom', source: 'restore' }
      : rowAnchor
        ? { kind: 'message', targetId: rowAnchor, source: 'restore', restoreOffset }
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
 * Used by Messages (stable-ID navigation callbacks) to navigate beyond
 * the rendered viewport window.
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
      if (messages[i].role === 'user') {
        return messages[i].id
      }
    }
  } else {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return messages[i].id
      }
    }
  }
  return null
}

/**
 * Resolves the stable message row id that owns a DOM node inside a chat scroll
 * container.
 *
 * Search matches are text ranges inside a row's content, not the row itself,
 * and the row is the identity the navigation transaction positions and adopts
 * as the route's reading anchor. The walk stops at the container and accepts
 * only a real row: `id="message-<id>"` (group wrappers `message-group-*` and
 * answer-tab strips are never rows).
 *
 * Returns `null` when the node is not inside a navigable row, so the caller
 * keeps its own fallback instead of guessing a target.
 */
export const resolveMessageRowIdForNode = (
  node: Node | null | undefined,
  container: Element | null | undefined
): string | null => {
  if (!node || !container) return null
  const start: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement
  if (!start) return null
  // The node must actually live inside the scroll container: a node outside it
  // is not owned by this container's rows (fail-closed, no guessed target).
  try {
    if (!container.contains(start)) return null
  } catch {
    return null
  }
  let el: Element | null = start
  while (el && el !== container) {
    try {
      const id = el.id ?? ''
      if (typeof id === 'string' && id.startsWith('message-') && !id.startsWith('message-group-')) {
        const messageId = id.slice('message-'.length)
        if (messageId.length > 0) return messageId
      }
    } catch {
      return null
    }
    el = el.parentElement
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
      ? {
          kind: 'message',
          targetId: intent.targetId,
          alignment: intent.alignment ?? 'start',
          restoreOffset:
            typeof intent.restoreOffset === 'number' && Number.isFinite(intent.restoreOffset)
              ? intent.restoreOffset
              : null
        }
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

// ---------------------------------------------------------------------------
// Navigation presentation target (collapsed message groups)
// ---------------------------------------------------------------------------

/**
 * Presentation that physically owns a resolved navigation message identity.
 *
 * A message row is the ordinary case: the stable `message-<id>` element is the
 * geometry and the anchor identity. A member of a COLLAPSED (folded) group has
 * no mounted row at all — the fold removes its bodies from the flow while the
 * group keeps one header label at the seam — so navigation positions the group
 * header and keeps the group folded. The target is therefore resolved once,
 * here, and every status/geometry/anchor read below uses the same answer.
 */
export type MessageNavigationPresentationTarget =
  | { kind: 'message-row'; messageId: string }
  | { kind: 'segment-header'; messageId: string; segmentId: string }

/**
 * Maps a navigation message identity to the presentation that owns it.
 *
 * `foldedSegmentIdForMessage` is the caller's AUTHORITY catalog lookup
 * (message → owning segment, folded segments only). It is injected rather than
 * read from the DOM on purpose: a closing fold keeps its body mounted for the
 * exit motion, and a collapsed group's membership can span runs that are not
 * all mounted, so only the authority catalog can say which messages have no
 * row. DOM-local membership inference is never an identity source.
 *
 * Pure: no DOM, no store, no side effects.
 */
export const resolveNavigationPresentationTarget = (
  messageId: string,
  foldedSegmentIdForMessage: (messageId: string) => string | null | undefined
): MessageNavigationPresentationTarget => {
  let segmentId: string | null | undefined = null
  try {
    segmentId = foldedSegmentIdForMessage(messageId)
  } catch {
    segmentId = null
  }
  if (typeof segmentId === 'string' && segmentId.length > 0) {
    return { kind: 'segment-header', messageId, segmentId }
  }
  return { kind: 'message-row', messageId }
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
  /**
   * `true` may be returned synchronously by a caller that already owns the
   * navigation without an observable commit (resident selection follow); the
   * runner only ever `await`s the value.
   */
  begin: (
    token: MessageViewportNavigationToken,
    targetId: string | null,
    source: MessageViewportNavigationSource,
    alignment: MessageNavigationAlignment
  ) => boolean | Promise<boolean>
  isCurrent: (token: MessageViewportNavigationToken) => boolean
  cancelLoadsAndTimers: () => void
  resolve: (intent: MessageNavigationIntent) => ResolvedMessageNavigation | null
  prepareWindow: (resolved: ResolvedMessageNavigation) => MessageWindow | null
  applyWindow: (token: MessageViewportNavigationToken, window: MessageWindow) => Promise<boolean>
  getTargetStatus: (targetId: string) => 'visible' | 'hidden' | 'missing'
  revealTarget: (targetId: string) => Promise<void>
  settleDom: () => Promise<void>
  /* Same as `begin`: `true` may be reported synchronously (resident follow). */
  beginProgrammaticScroll: (token: MessageViewportNavigationToken) => boolean | Promise<boolean>
  /**
   * Applies the navigation geometry for `resolved`.
   *
   * Usually synchronous. A movement that keeps the viewport in motion after the
   * write (the animated search landing) resolves only when that motion has
   * completed, been interrupted, or been superseded — the runner awaits it, so
   * the navigation state stays `scrolling`, the post-scroll currency recheck and
   * the route anchor/snapshot handoff happen on the settled position, and no
   * adoption can be taken from a pre-animation frame.
   *
   * The `resident` shape writes geometry first and never uses the asynchronous
   * form (its whole point is that nothing stands between input and write).
   */
  scroll: (
    resolved: ResolvedMessageNavigation,
    token: MessageViewportNavigationToken
  ) => MessageNavigationScrollOutcome | void | Promise<MessageNavigationScrollOutcome | void>
  finish: (token: MessageViewportNavigationToken) => void
  cancel: (token: MessageViewportNavigationToken) => void
  /**
   * Resident-follow shape: the resolved endpoint row is already resident and
   * visible, so the geometry write runs first and the navigation state machine
   * is told afterwards (dispatch-only). No commit, frame, timer or reveal is
   * awaited on this path.
   */
  resident?: boolean
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

/**
 * Runs every message/restoration navigation through one last-navigation-wins
 * transaction.
 *
 * `dependencies.resident` selects the resident-follow shape: the caller proved
 * the endpoint row is already resident and visible, so the geometry write is
 * the FIRST thing this transaction does — before any dispatch, commit, frame,
 * timer or reveal. Nothing a repeat key can outrun therefore stands between the
 * input and the scroll write. The navigation state machine is then told about
 * the same navigation (begin + finish/cancel, both dispatch-only) so an older
 * in-flight navigation is still superseded. Currency is unchanged: the
 * caller's `scroll` callback owns the topic/route/epoch/interaction gates and
 * the controller adoption, exactly as in the generic path.
 *
 * The generic path awaits `scroll`, so a write that keeps moving afterwards (the
 * animated search landing) also awaits its own completion here: the navigation
 * stays open through the movement, and finish/supersession are decided on the
 * settled position — the same single transaction, only completion-aware.
 */
export const runMessageNavigationTransaction = async (
  intent: MessageNavigationIntent,
  dependencies: MessageNavigationTransactionDependencies
): Promise<MessageNavigationResult> => {
  const token: MessageViewportNavigationToken = {}
  const requestedTarget = intent.kind === 'message' ? intent.targetId : null
  const alignment = 'alignment' in intent ? (intent.alignment ?? 'start') : 'start'

  if (dependencies.resident === true) {
    const residentResolved = dependencies.resolve(intent)
    if (!residentResolved) {
      dependencies.cancel(token)
      return 'not-found'
    }
    const residentOutcome = dependencies.scroll(residentResolved, token)
    const outcome: MessageNavigationScrollOutcome =
      residentOutcome === 'cancelled' || residentOutcome === 'not-found' ? residentOutcome : 'success'
    // State coherence only: the geometry above is already written.
    void dependencies.begin(token, requestedTarget, intent.source, alignment)
    if (outcome === 'success') {
      dependencies.finish(token)
      return 'success'
    }
    dependencies.cancel(token)
    return outcome
  }

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
  // Awaited: a moving write (animated search landing) keeps the transaction
  // open until the viewport has settled, so currency and the finish below apply
  // to the position the user actually ends on, never to a pre-animation frame.
  const scrollOutcome = await dependencies.scroll(resolved, token)
  if (scrollOutcome === 'cancelled' || scrollOutcome === 'not-found') {
    dependencies.cancel(token)
    return scrollOutcome
  }
  await dependencies.settleDom()
  if (!dependencies.isCurrent(token)) return 'cancelled'
  dependencies.finish(token)
  return 'success'
}
