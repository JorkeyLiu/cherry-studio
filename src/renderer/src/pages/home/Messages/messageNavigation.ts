import type { Message } from '@renderer/types/newMessage'

import { maxScrollTop, readScrollMetrics } from './flowScrollGeometry'
import { createMessageViewportGroupModel } from './messageGroups'
import type { MessageViewportNavigationSource, MessageViewportNavigationToken } from './messageViewportReducer'
import type { MessageViewportState } from './messageViewportReducer'
import { applyWindowTransition, type MessageWindow } from './messageWindow'
// ---------------------------------------------------------------------------
// Prepare / execute stage contract
// ---------------------------------------------------------------------------

/**
 * Dependencies for the PREPARE stage of message navigation.
 *
 * Strict subset of the full transaction dependencies: everything up to the
 * target projection commit (resolve → window commit → settle → visibility
 * gate), and nothing that moves the viewport. No `beginProgrammaticScroll`,
 * no `scroll`, no `finish` — a prepare entry can never write scroll geometry
 * and never adopts a controller viewport. The caller closes the navigation
 * token (`cancel`); the projection (committed window) survives the close.
 */
export interface MessageNavigationPrepareDeps {
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
  cancel: (token: MessageViewportNavigationToken) => void
}

/**
 * Terminal status of the prepare stage. `prepared` means the target
 * projection is committed and visible-gated (window applied, DOM settled);
 * the viewport itself is untouched — positioning stays with the caller's
 * existing first-placement path on the SAME epoch. `not-found` and
 * `cancelled` carry the legacy transaction meaning.
 */
export type MessageNavigationPrepareStatus = 'prepared' | 'not-found' | 'cancelled'

export interface PreparedMessageNavigation {
  status: 'prepared'
  token: MessageViewportNavigationToken
  resolved: ResolvedMessageNavigation
}

export type MessageNavigationPrepareResult =
  | PreparedMessageNavigation
  | { status: 'not-found' }
  | { status: 'cancelled' }

/**
 * Prepare-stage outcome with its close bookkeeping. `closed` is true exactly
 * where the legacy full transaction closed the navigation token on that exit,
 * so the refactored full path below keeps byte-identical close behavior while
 * the dedicated prepare entry closes every remaining exit itself.
 */
interface PrepareStageOutcome {
  result: MessageNavigationPrepareResult
  closed: boolean
}

export const NAVIGATION_VISUALLY_OLDER_GROUPS = 10
export const NAVIGATION_VISUALLY_NEWER_GROUPS = 19

export type MessageNavigationAlignment = 'start' | 'center' | 'end'

/**
 * Resolves a navigation result to the concrete scroll target for the
 * normal-flow container (`#messages`: `scrollTop` 0 is the oldest/top edge and
 * `scrollHeight - clientHeight` is the newest/bottom edge).
 * Returns `{ top: number }` for programmatic scrollTo calls, or `null` for
 * message-level targets that require element lookup + arithmetic placement.
 *
 * 'top' uses 0 (the natural resting position of the oldest edge).
 * 'bottom' uses the container's live scroll travel, so the browser clamps to
 * the actual maximum instead of a guessed height.
 */
export interface FlowScrollContainer {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  scrollTo(options: { top: number }): void
}

/** Largest reachable `scrollTop` of a container (0 when unmeasurable). */
const scrollTravelOf = (container: FlowScrollContainer | null | undefined): number => {
  if (!container) return 0
  try {
    return maxScrollTop(readScrollMetrics(container))
  } catch {
    return 0
  }
}

/** Clamp an arbitrary target into the container's real `[0, travel]` range. */
const clampFlowScrollTop = (desired: number, container: FlowScrollContainer | null | undefined): number => {
  if (!Number.isFinite(desired)) return 0
  return Math.min(scrollTravelOf(container), Math.max(0, desired))
}

export const resolveFlowScrollTarget = (
  resolved: ResolvedMessageNavigation,
  container: FlowScrollContainer | null | undefined
): { top: number } | null => {
  if (resolved.kind === 'bottom' || resolved.kind === 'send-bottom') return { top: scrollTravelOf(container) }
  if (resolved.kind === 'top') return { top: 0 }
  if (resolved.kind === 'scrollTop') return { top: clampFlowScrollTop(resolved.scrollTop, container) }
  // 'message' kind requires DOM element lookup; handled separately by the caller.
  return null
}

/**
 * Pure geometry for positioning a message row inside the normal-flow
 * container.
 *
 * `elementTopWithinContainer` is the row's content offset
 * (`elRect.top - containerRect.top + container.scrollTop`); `maxScrollTop` is
 * the clamped newest edge (`scrollHeight - clientHeight`, `>= 0`). Returns the
 * finite clamped `scrollTo` top for the requested alignment, or `null` when any
 * input is non-finite (fail-closed: caller skips the write).
 *
 * Native `scrollIntoView({ block: 'start' })` does move this container, but the
 * explicit arithmetic below stays the single scroll arbiter: one write whose
 * alignment, clamp and outcome the navigation transaction can verify.
 */
export const computeFlowMessageScrollTop = (args: {
  elementTopWithinContainer: number
  containerClientHeight: number
  elementHeight: number
  alignment: MessageNavigationAlignment
  maxScrollTop: number
}): number | null => {
  const { elementTopWithinContainer, containerClientHeight, elementHeight, alignment, maxScrollTop } = args
  for (const value of [elementTopWithinContainer, containerClientHeight, elementHeight, maxScrollTop]) {
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
  const upper = Math.max(0, maxScrollTop)
  return Math.min(upper, Math.max(0, desired))
}

/**
 * Pure geometry for a saved-offset restore inside the normal-flow container.
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
  maxScrollTop: number
}): number | null => {
  const { elementTopWithinContainer, restoreOffset, maxScrollTop } = args
  if (typeof restoreOffset !== 'number' || !Number.isFinite(restoreOffset)) return null
  if (!Number.isFinite(elementTopWithinContainer) || !Number.isFinite(maxScrollTop)) return null
  const desired = elementTopWithinContainer - restoreOffset
  if (!Number.isFinite(desired)) return null
  const upper = Math.max(0, maxScrollTop)
  return Math.min(upper, Math.max(0, desired))
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
 * Where a search hit should put the viewport, in the same normal-flow
 * container convention as {@link computeFlowMessageScrollTop}
 * (`scrollTop` 0 is the oldest/top edge; the newest/bottom edge is
 * `scrollHeight - clientHeight`).
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
  maxScrollTop: number
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
    maxScrollTop,
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
    maxScrollTop,
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

  // Normal flow keeps the plain content relation `viewportOffset =
  // contentOffset - scrollTop` (raising `scrollTop` still moves content up, so
  // only the sign RANGE changed, never the relation). Centring the hit inside the
  // band therefore is: contentOffset + height/2 - bandCentre, clamped into the
  // container's real `[0, maxScrollTop]` range.
  const contentOffset = matchTopOffset + currentScrollTop
  const bandCentre = band.top + band.height / 2
  const desired = contentOffset + matchHeight / 2 - bandCentre
  if (!Number.isFinite(desired)) return null
  const upper = Math.max(0, maxScrollTop)
  const top = Math.min(upper, Math.max(0, desired))
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
 * Applies the concrete scroll for a resolved navigation intent in the
 * normal-flow container.
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
export const applyFlowScroll = (
  resolved: ResolvedMessageNavigation,
  container: FlowScrollContainer | null | undefined,
  scrollElementIntoView: (
    targetId: string,
    alignment: MessageNavigationAlignment
  ) => MessageNavigationScrollOutcome | void
): MessageNavigationScrollOutcome => {
  const scrollTarget = resolveFlowScrollTarget(resolved, container)
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
  | {
      kind: 'send-bottom'
      source: MessageViewportNavigationSource
    }
  | { kind: 'top'; source: MessageViewportNavigationSource }
  | { kind: 'scrollTop'; scrollTop: number; source: 'restore' }
export type ResolvedMessageNavigation =
  | { kind: 'message'; targetId: string; alignment: MessageNavigationAlignment; restoreOffset?: number | null }
  | { kind: 'bottom' }
  | { kind: 'send-bottom' }
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
  scrollTop?: number
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
  /**
   * Window-read busy for the bootstrap topic. Generation busy must not gate
   * bootstrap: a background generation must not block navigation/readiness.
   * Read-busy only — callers pass the window-read predicate, never generation.
   */
  isTopicReadBusy: boolean
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
  const { phase, topicId, pending, savedPosition, savedRestoreHandled, isTopicReadBusy } = input

  if (isTopicReadBusy) return { action: 'wait' }
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
  if (intent.kind === 'send-bottom') return { kind: 'send-bottom' }
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
// Fold-marker grounding (message-level fold, marker-only navigation)
// ---------------------------------------------------------------------------
/**
 * Collapsed-root contract a fold block provides for navigation grounding:
 * the collapsed root carries `data-folded-message-ids` listing the hidden
 * member message ids it stands in for (space-separated tokens, JSON array
 * also accepted). Navigation queries `[data-folded-message-ids]`, parses the
 * value and checks `includes(id)`.
 * Current render wrapper members come from the layout's own flow entries;
 * this DOM attribute is only the mounted marker identity, never a membership
 * authority.
 */
export const FOLDED_MARKER_IDS_ATTR = 'data-folded-message-ids'
export const FOLDED_MARKER_SELECTOR = `[${FOLDED_MARKER_IDS_ATTR}]`
/**
 * Parse one `data-folded-message-ids` value into its hidden member ids.
 * Accepts the collapsed root's space-separated token list (the
 * `data-folded-group-ids` sibling convention) as well as a JSON string
 * array, so marker grounding stays independent of the block's serializer.
 * Returns the id list, or `null` when the value carries no usable id
 * (fail-closed: the caller treats it as no marker).
 */
export const parseFoldedMessageIdsAttr = (value: string | null | undefined): string[] | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  const text = value.trim()
  if (text.length === 0) return null
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (!Array.isArray(parsed)) return null
      const out: string[] = []
      for (const entry of parsed) {
        if (typeof entry !== 'string' || entry.length === 0) return null
        out.push(entry)
      }
      return out.length > 0 ? out : null
    } catch {
      return null
    }
  }
  const tokens = text.split(/\s+/).filter((token) => token.length > 0)
  return tokens.length > 0 ? tokens : null
}
/**
 * Locate the mounted collapsed marker that stands in for `messageId`.
 * Scans `container` (defaults to `document`) for `[data-folded-message-ids]`,
 * parses each value with {@link parseFoldedMessageIdsAttr} and returns the
 * first connected element whose list includes the id — or `null` when no
 * marker is mounted. Pure DOM read, no state writes, never expands.
 */
export const findFoldedMarkerElement = (
  messageId: string,
  container?: Pick<Document | HTMLElement, 'querySelectorAll'> | null
): HTMLElement | null => {
  if (!messageId) return null
  try {
    const root = container ?? (typeof document !== 'undefined' ? document : null)
    if (!root) return null
    const nodes = root.querySelectorAll(FOLDED_MARKER_SELECTOR)
    for (const node of Array.from(nodes)) {
      if (!(node instanceof HTMLElement)) continue
      if (!node.isConnected) continue
      const ids = parseFoldedMessageIdsAttr(node.getAttribute(FOLDED_MARKER_IDS_ATTR))
      if (ids && ids.includes(messageId)) return node
    }
  } catch {
    return null
  }
  return null
}
/**
 * Whether a collapsed marker for `messageId` is currently mounted. A mounted
 * marker is a settled navigation target in its own right: focus navigation
 * positions the marker and settles, never faking `not-found`/`cancelled` and
 * never taking a parallel scroll owner.
 */
export const isFoldMarkerMounted = (
  messageId: string,
  container?: Pick<Document | HTMLElement, 'querySelectorAll'> | null
): boolean => findFoldedMarkerElement(messageId, container) !== null

export const chooseNavigationWindow = (
  messages: Message[],
  currentWindow: MessageWindow | null,
  resolved: ResolvedMessageNavigation,
  latestGroupCount: number
): MessageWindow | null => {
  // Navigation quotas (older 10 / newer 19) stay distinct from the initial
  // budget, page size and request clamp; construction goes through the
  // single window-transition entry (same mechanism, no parallel logic).
  // Send-to-bottom keeps the send's bottom intent (physical scroll still goes
  // to the bottom edge) but must NOT reset the window to the initial budget
  // the way an explicit go-latest does: the CURRENT range is extended to the
  // real tail with the loaded oldest pinned (hard cap is the only trim).
  if (resolved.kind === 'send-bottom') {
    if (!currentWindow) {
      // No committed range to preserve: same initial-budget latest an
      // explicit bottom would build. Fail-closed under it stays here.
      const outcome = applyWindowTransition({ kind: 'latest', messages, budget: latestGroupCount })
      return outcome.kind === 'window' ? outcome.window : null
    }
    const outcome = applyWindowTransition({ kind: 'append', messages, currentWindow })
    return outcome.kind === 'reconciled' ? outcome.window : null
  }
  if (resolved.kind === 'bottom') {
    const outcome = applyWindowTransition({ kind: 'latest', messages, budget: latestGroupCount })
    return outcome.kind === 'window' ? outcome.window : null
  }
  if (resolved.kind === 'top') {
    const outcome = applyWindowTransition({ kind: 'top', messages, budget: latestGroupCount })
    return outcome.kind === 'window' ? outcome.window : null
  }
  if (resolved.kind === 'scrollTop') {
    if (currentWindow) return null
    const outcome = applyWindowTransition({ kind: 'latest', messages, budget: latestGroupCount })
    return outcome.kind === 'window' ? outcome.window : null
  }
  if (currentWindow?.displayMessages.some((message) => message.id === resolved.targetId)) return null

  const outcome = applyWindowTransition({
    kind: 'target',
    messages,
    targetId: resolved.targetId,
    older: NAVIGATION_VISUALLY_OLDER_GROUPS,
    newer: NAVIGATION_VISUALLY_NEWER_GROUPS
  })
  return outcome.kind === 'window' ? outcome.window : null
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
export interface PendingNavigationOwner extends PendingNavigateIdentity {
  source: 'bootstrap' | 'event'
}

/** Exact target identity; topic-only matching must never join two different targets. */
export const isSamePendingNavigateTarget = (left: PendingNavigateIdentity, right: PendingNavigateIdentity): boolean =>
  left.topicId === right.topicId && left.messageId === right.messageId

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
  /** Join an exact target already owned by bootstrap or an earlier event. */
  isPendingInFlight?: (pending: PendingNavigateIdentity) => boolean
  /** Claim event ownership synchronously before navigate starts. */
  onStart?: (target: PendingNavigateIdentity) => void
  /** Release only the ownership claimed by this invocation. */
  onEnd?: (consumedPending: boolean, result: MessageNavigationResult | null) => void
}

/** Result returned by {@link handlePendingNavigateEvent}. */
export interface PendingEventResult {
  result: MessageNavigationResult
  /** 'pending' when exact-matched, 'event' otherwise, 'pending-in-flight' when joined. */
  source: 'pending' | 'event' | 'pending-in-flight'
}

/**
 * Coordinates NAVIGATE_TO_MESSAGE event handling with pending identity matching.
 *
 * Decision logic (single implementation — no duplicate in tests):
 *   1. Read the current pending; check exact match on both topicId AND messageId.
 *   2. If matched and already owned by the same exact target → join without navigating.
 *   3. Otherwise claim event ownership, then navigate with source='pending' or 'event'.
 *   4. If matched AND result !== 'cancelled' → compare-and-clear the pending, call onDone.
 *   5. Release only this invocation's claim; cancelled/failed navigation preserves pending.
 */
export const handlePendingNavigateEvent = async (
  topicId: string,
  messageId: string,
  deps: PendingEventDeps
): Promise<PendingEventResult> => {
  const pending = deps.getPending()
  const isPendingMatch = pending !== null && isSamePendingNavigateTarget(pending, { topicId, messageId })
  const source: 'pending' | 'event' = isPendingMatch ? 'pending' : 'event'
  if (isPendingMatch && pending && deps.isPendingInFlight?.(pending)) {
    return { result: 'cancelled', source: 'pending-in-flight' }
  }

  let claimed = false
  let consumedPending = false
  let result: MessageNavigationResult | null = null
  try {
    deps.onStart?.({ topicId, messageId })
    claimed = true
    result = await deps.navigate({
      kind: 'message',
      targetId: messageId,
      source
    })
    if (isPendingMatch && pending && result !== 'cancelled') {
      if (deps.clearPending(pending)) {
        consumedPending = true
        deps.onDone()
      }
    }
    return { result, source }
  } finally {
    if (claimed) deps.onEnd?.(consumedPending, result)
  }
}

// ---------------------------------------------------------------------------
// Transaction runner
// ---------------------------------------------------------------------------

/**
 * Shared PREPARE stage: target resolution → window commit → settle →
 * visibility gate. Ends with the target projection committed and gated; the
 * navigation token stays open so the full transaction can continue into the
 * execute stage below. Never scrolls, never adopts a controller viewport, so
 * an owned (fetch-hold) session stays owned throughout.
 *
 * Close bookkeeping (`closed`) mirrors the legacy full-transaction close
 * behavior exactly: true only where the historical code closed the token
 * (unresolvable intent, ungateable target). Every other exit leaves the token
 * open for the caller: the full transaction continues into execute, and the
 * dedicated prepare entry closes it (the committed projection survives the
 * close).
 */
const runPrepareStages = async (
  intent: MessageNavigationIntent,
  token: MessageViewportNavigationToken,
  dependencies: MessageNavigationPrepareDeps
): Promise<PrepareStageOutcome> => {
  const requestedTarget = intent.kind === 'message' ? intent.targetId : null
  const alignment = 'alignment' in intent ? (intent.alignment ?? 'start') : 'start'

  if (!(await dependencies.begin(token, requestedTarget, intent.source, alignment))) {
    return { result: { status: 'cancelled' }, closed: false }
  }
  if (!dependencies.isCurrent(token)) return { result: { status: 'cancelled' }, closed: false }

  dependencies.cancelLoadsAndTimers()
  const resolved = dependencies.resolve(intent)
  if (!resolved) {
    dependencies.cancel(token)
    return { result: { status: 'not-found' }, closed: true }
  }

  const window = dependencies.prepareWindow(resolved)
  if (window && !(await dependencies.applyWindow(token, window))) {
    return { result: { status: 'cancelled' }, closed: false }
  }
  if (!dependencies.isCurrent(token)) return { result: { status: 'cancelled' }, closed: false }
  dependencies.cancelLoadsAndTimers()

  await dependencies.settleDom()
  if (!dependencies.isCurrent(token)) return { result: { status: 'cancelled' }, closed: false }

  if (resolved.kind === 'message') {
    const status = dependencies.getTargetStatus(resolved.targetId)
    if (status === 'hidden') {
      await dependencies.revealTarget(resolved.targetId)
      if (!dependencies.isCurrent(token)) return { result: { status: 'cancelled' }, closed: false }
      await dependencies.settleDom()
      if (!dependencies.isCurrent(token)) return { result: { status: 'cancelled' }, closed: false }
    }
    if (dependencies.getTargetStatus(resolved.targetId) !== 'visible') {
      dependencies.cancel(token)
      return { result: { status: 'not-found' }, closed: true }
    }
  }

  return { result: { status: 'prepared', token, resolved }, closed: false }
}

/**
 * Dedicated PREPARE entry for owned bootstrap restores (topic-mount pending +
 * saved restore).
 *
 * Explicit stage contract, never an execution: runs ONLY the shared prepare
 * stage above (resolve → window commit → settle → visibility gate; target
 * loading stays the caller's own shared stage) and closes the navigation
 * token on EVERY exit — `prepared` included — so no idle waiter hangs and no
 * programmatic scroll token is left behind. The committed projection survives
 * the close; positioning stays with the caller's existing first-placement
 * path on the SAME controller epoch (no release, no re-acquire, no second
 * scroller, no owner relaxation).
 *
 * Throwing dependencies fail closed: the token is cancelled and `cancelled`
 * is returned, never a permanently hidden transition.
 */
export const prepareMessageNavigationTarget = async (
  intent: MessageNavigationIntent,
  dependencies: MessageNavigationPrepareDeps
): Promise<MessageNavigationPrepareResult> => {
  const token: MessageViewportNavigationToken = {}
  let outcome: PrepareStageOutcome
  try {
    outcome = await runPrepareStages(intent, token, dependencies)
  } catch {
    try {
      dependencies.cancel(token)
    } catch {
      // fail-closed: the terminal status below is the contract
    }
    return { status: 'cancelled' }
  }
  if (!outcome.closed) {
    try {
      dependencies.cancel(token)
    } catch {
      // fail-closed: the projection commit above stands regardless
    }
  }
  return outcome.result
}

/**
 * Runs every message/restoration navigation through one last-navigation-wins
 * transaction: the shared prepare stage above, then the execute stage
 * (programmatic scroll → settle → finish). The execute stage is the ONLY
 * viewport mover and the ONLY controller adopter; prepare-only callers never
 * enter it.
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

  if (dependencies.resident === true) {
    const requestedTarget = intent.kind === 'message' ? intent.targetId : null
    const alignment = 'alignment' in intent ? (intent.alignment ?? 'start') : 'start'
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

  const outcome = await runPrepareStages(intent, token, dependencies)
  if (outcome.result.status !== 'prepared') {
    if (outcome.closed) dependencies.cancel(token)
    return outcome.result.status
  }
  const resolved = outcome.result.resolved

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
