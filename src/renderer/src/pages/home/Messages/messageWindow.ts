import type { Message } from '@renderer/types/newMessage'

import {
  createMessageViewportGroupModel,
  type MessageViewportGroup,
  type MessageViewportGroupModel
} from './messageGroups'

/**
 * Renderer-local bounded viewport capacity calibration default (Phase 4 B-06).
 * Disposable projection bound; not a product threshold and requires calibration.
 * Reversible: only affects viewport projection, authoritative Redux entities and Main SQLite unchanged.
 */
export const MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT = 200

/** Alias preserving B-06 calibration naming for external reference. */
export const MESSAGE_WINDOW_BOUNDED_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT =
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT

export interface MessageGroupRange {
  /** Inclusive index of the visually oldest group in chronological source order. */
  oldestGroupIndex: number
  /** Inclusive index of the visually newest group in chronological source order. */
  newestGroupIndex: number
}

export interface MessageWindow {
  range: MessageGroupRange | null
  /** Whether reconciliation follows newly appended groups or retains this range. */
  edge: 'latest' | 'fixed'
  /** Messages in newest-to-oldest order, as consumed by the column-reverse view. */
  displayMessages: Message[]
  /** Sliced visual groups in chronological order, pre-computed from the range.
   *  Consumed directly by MessagesContent to avoid redundant group-model regrouping. */
  displayGroups: MessageViewportGroup[]
  groupCapacity: number
  groupCount: number
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  oldestMessageId?: string
  newestMessageId?: string
  /** Authoritative completeness from validated Main window, retained for pagination. */
  authoritativeHasMoreBefore?: boolean
  authoritativeHasMoreAfter?: boolean
  /**
   * Renderer-local bounded viewport observability (B-06 calibration, disposable).
   * Lightweight metadata for testing/observability without logging subsystem.
   */
  boundedViewportObservability?: {
    /** B-06 calibration default capacity (not a product threshold). */
    calibrationDefault: number
    /** Effective bounded capacity applied (capped at calibration default). */
    boundedCapacity: number
    /** Whether the last construction/expansion trimmed opposite edge to stay bounded. */
    didTrim: boolean
    /** Number of groups trimmed from opposite edge (0 when not trimmed). */
    trimmedGroups: number
    /** Edge that was trimmed, if any. */
    trimmedEdge: 'older' | 'newer' | null
  }
}

const createWindowFromRange = (
  model: MessageViewportGroupModel,
  range: MessageGroupRange | null,
  groupCapacity: number,
  edge: MessageWindow['edge'],
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean },
  observability?: MessageWindow['boundedViewportObservability']
): MessageWindow => {
  const boundedCapacity = Math.min(Math.max(0, groupCapacity), MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT)
  const calibrationDefault = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  const buildObservability = (
    didTrim: boolean,
    trimmedGroups: number,
    trimmedEdge: 'older' | 'newer' | null
  ): MessageWindow['boundedViewportObservability'] => ({
    calibrationDefault,
    boundedCapacity,
    didTrim,
    trimmedGroups,
    trimmedEdge
  })

  if (!range || model.groups.length === 0) {
    return {
      range: null,
      edge,
      displayMessages: [],
      displayGroups: [],
      groupCapacity: boundedCapacity,
      groupCount: 0,
      hasMoreOlder: authoritative?.hasMoreBefore ?? false,
      hasMoreNewer: authoritative?.hasMoreAfter ?? false,
      authoritativeHasMoreBefore: authoritative?.hasMoreBefore,
      authoritativeHasMoreAfter: authoritative?.hasMoreAfter,
      boundedViewportObservability: observability ?? buildObservability(false, 0, null)
    }
  }

  const oldestGroupIndex = Math.max(0, range.oldestGroupIndex)
  const newestGroupIndex = Math.min(model.groups.length - 1, range.newestGroupIndex)
  if (oldestGroupIndex > newestGroupIndex)
    return createWindowFromRange(model, null, boundedCapacity, edge, authoritative, observability)

  const groups = model.groups.slice(oldestGroupIndex, newestGroupIndex + 1)
  const chronologicalMessages = groups.flatMap((group) => group.messages)

  // Authoritative-defined precedence when no bounded trim occurred: explicit false is preserved.
  // When bounded trimming creates a traversable local edge, derived true may surface only on the trimmed edge.
  const derivedHasMoreOlder = oldestGroupIndex > 0
  const derivedHasMoreNewer = newestGroupIndex < model.groups.length - 1
  const hasMoreOlder = (() => {
    if (authoritative?.hasMoreBefore === true) return true
    if (authoritative?.hasMoreBefore === false) {
      return observability?.didTrim === true && observability?.trimmedEdge === 'older' && derivedHasMoreOlder
        ? true
        : false
    }
    return derivedHasMoreOlder
  })()
  const hasMoreNewer = (() => {
    if (authoritative?.hasMoreAfter === true) return true
    if (authoritative?.hasMoreAfter === false) {
      return observability?.didTrim === true && observability?.trimmedEdge === 'newer' && derivedHasMoreNewer
        ? true
        : false
    }
    return derivedHasMoreNewer
  })()

  return {
    range: { oldestGroupIndex, newestGroupIndex },
    edge,
    displayMessages: chronologicalMessages.toReversed(),
    displayGroups: groups,
    groupCapacity: boundedCapacity,
    groupCount: groups.length,
    hasMoreOlder,
    hasMoreNewer,
    oldestMessageId: chronologicalMessages[0]?.id,
    newestMessageId: chronologicalMessages.at(-1)?.id,
    authoritativeHasMoreBefore: authoritative?.hasMoreBefore,
    authoritativeHasMoreAfter: authoritative?.hasMoreAfter,
    boundedViewportObservability: observability ?? buildObservability(false, 0, null)
  }
}

export const createLatestMessageWindow = (
  messages: Message[],
  groupCapacity: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const rawCapacity = Math.max(0, groupCapacity)
  const boundedCapacity = Math.min(rawCapacity, MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT)
  if (boundedCapacity === 0 || model.groups.length === 0)
    return createWindowFromRange(model, null, boundedCapacity, 'latest', authoritative)

  return createWindowFromRange(
    model,
    {
      oldestGroupIndex: Math.max(0, model.groups.length - boundedCapacity),
      newestGroupIndex: model.groups.length - 1
    },
    boundedCapacity,
    'latest',
    authoritative
  )
}

/**
 * Creates a window anchored at the oldest groups in the topic.
 * Used by the unified 'top' navigation intent.
 */
export const createOldestMessageWindow = (
  messages: Message[],
  groupCapacity: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const rawCapacity = Math.max(0, groupCapacity)
  const boundedCapacity = Math.min(rawCapacity, MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT)
  if (boundedCapacity === 0 || model.groups.length === 0)
    return createWindowFromRange(model, null, boundedCapacity, 'fixed', authoritative)

  return createWindowFromRange(
    model,
    {
      oldestGroupIndex: 0,
      newestGroupIndex: Math.min(model.groups.length - 1, boundedCapacity - 1)
    },
    boundedCapacity,
    'fixed',
    authoritative
  )
}

/**
 * Creates a target window with visual quotas on either side. If one edge lacks
 * groups, the unused quota is filled from the opposite edge.
 */
export const createTargetMessageWindow = (
  messages: Message[],
  targetMessageId: string,
  visuallyOlderGroupCount: number,
  visuallyNewerGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const rawCapacity = Math.max(0, visuallyOlderGroupCount) + 1 + Math.max(0, visuallyNewerGroupCount)
  const boundedCapacity = Math.min(rawCapacity, MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT)
  // When raw capacity exceeds bound, newer-first deterministic reduction while preserving anchor.
  let effectiveOlder = Math.max(0, visuallyOlderGroupCount)
  let effectiveNewer = Math.max(0, visuallyNewerGroupCount)
  if (rawCapacity > boundedCapacity) {
    // Deterministic: trim newer first, then older, to keep anchor visible.
    const excess = rawCapacity - boundedCapacity
    const trimNewer = Math.min(effectiveNewer, excess)
    effectiveNewer -= trimNewer
    const remaining = excess - trimNewer
    effectiveOlder = Math.max(0, effectiveOlder - remaining)
  }
  const targetGroup = model.messageIdToGroup.get(targetMessageId)
  if (!targetGroup) return createWindowFromRange(model, null, boundedCapacity, 'fixed', authoritative)

  const targetGroupIndex = model.groups.indexOf(targetGroup)
  let oldestGroupIndex = Math.max(0, targetGroupIndex - effectiveOlder)
  let newestGroupIndex = Math.min(model.groups.length - 1, targetGroupIndex + effectiveNewer)
  let missingCount = boundedCapacity - (newestGroupIndex - oldestGroupIndex + 1)

  if (missingCount > 0) {
    const availableOlder = oldestGroupIndex
    const addedOlder = Math.min(availableOlder, missingCount)
    oldestGroupIndex -= addedOlder
    missingCount -= addedOlder
    newestGroupIndex = Math.min(model.groups.length - 1, newestGroupIndex + missingCount)
  }

  return createWindowFromRange(model, { oldestGroupIndex, newestGroupIndex }, boundedCapacity, 'fixed', authoritative)
}

const getRangeFromDisplayMessages = (model: MessageViewportGroupModel, displayMessages: Message[]) => {
  const groupIndexes = displayMessages.flatMap((message) => {
    const group = model.messageIdToGroup.get(message.id)
    return group ? [model.groups.indexOf(group)] : []
  })
  if (groupIndexes.length === 0) return null

  return {
    oldestGroupIndex: Math.min(...groupIndexes),
    newestGroupIndex: Math.max(...groupIndexes)
  }
}

export const expandMessageWindowOlder = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const currentRange = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!currentRange) {
    const fallbackAuth = {
      hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
      hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
    }
    const cleanAuth =
      fallbackAuth.hasMoreBefore === undefined && fallbackAuth.hasMoreAfter === undefined ? undefined : fallbackAuth
    return createLatestMessageWindow(messages, additionalGroupCount, cleanAuth)
  }

  const addedCount = Math.max(0, additionalGroupCount)
  const effectiveAuth = {
    hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
    hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
  }
  const cleanAuth =
    effectiveAuth.hasMoreBefore === undefined && effectiveAuth.hasMoreAfter === undefined ? undefined : effectiveAuth
  const calibrationDefault = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  const desiredOldest = Math.max(0, currentRange.oldestGroupIndex - addedCount)
  const provisionalOldest = desiredOldest
  const provisionalNewest = currentRange.newestGroupIndex
  const provisionalCount = provisionalNewest - provisionalOldest + 1
  if (provisionalCount > calibrationDefault) {
    const trimmedGroups = provisionalCount - calibrationDefault
    const boundedNewest = provisionalNewest - trimmedGroups
    const boundedCapacity = calibrationDefault
    const observability: MessageWindow['boundedViewportObservability'] = {
      calibrationDefault,
      boundedCapacity,
      didTrim: true,
      trimmedGroups,
      trimmedEdge: 'newer'
    }
    return createWindowFromRange(
      model,
      { oldestGroupIndex: provisionalOldest, newestGroupIndex: boundedNewest },
      boundedCapacity,
      currentWindow.edge,
      cleanAuth,
      observability
    )
  }
  const boundedCapacity = Math.min(
    currentWindow.groupCapacity + addedCount,
    MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  )
  const observability: MessageWindow['boundedViewportObservability'] = {
    calibrationDefault,
    boundedCapacity,
    didTrim: false,
    trimmedGroups: 0,
    trimmedEdge: null
  }
  return createWindowFromRange(
    model,
    { ...currentRange, oldestGroupIndex: desiredOldest },
    boundedCapacity,
    currentWindow.edge,
    cleanAuth,
    observability
  )
}

export const expandMessageWindowNewer = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const currentRange = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!currentRange) {
    const fallbackAuth = {
      hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
      hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
    }
    const cleanAuth =
      fallbackAuth.hasMoreBefore === undefined && fallbackAuth.hasMoreAfter === undefined ? undefined : fallbackAuth
    return createLatestMessageWindow(messages, additionalGroupCount, cleanAuth)
  }

  const addedCount = Math.max(0, additionalGroupCount)
  const effectiveAuth = {
    hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
    hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
  }
  const cleanAuth =
    effectiveAuth.hasMoreBefore === undefined && effectiveAuth.hasMoreAfter === undefined ? undefined : effectiveAuth
  const calibrationDefault = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  const desiredNewest = Math.min(model.groups.length - 1, currentRange.newestGroupIndex + addedCount)
  const provisionalOldest = currentRange.oldestGroupIndex
  const provisionalNewest = desiredNewest
  const provisionalCount = provisionalNewest - provisionalOldest + 1
  if (provisionalCount > calibrationDefault) {
    const trimmedGroups = provisionalCount - calibrationDefault
    const boundedOldest = provisionalOldest + trimmedGroups
    const boundedCapacity = calibrationDefault
    const observability: MessageWindow['boundedViewportObservability'] = {
      calibrationDefault,
      boundedCapacity,
      didTrim: true,
      trimmedGroups,
      trimmedEdge: 'older'
    }
    return createWindowFromRange(
      model,
      { oldestGroupIndex: boundedOldest, newestGroupIndex: provisionalNewest },
      boundedCapacity,
      currentWindow.edge,
      cleanAuth,
      observability
    )
  }
  const boundedCapacity = Math.min(
    currentWindow.groupCapacity + addedCount,
    MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  )
  const observability: MessageWindow['boundedViewportObservability'] = {
    calibrationDefault,
    boundedCapacity,
    didTrim: false,
    trimmedGroups: 0,
    trimmedEdge: null
  }
  return createWindowFromRange(
    model,
    {
      ...currentRange,
      newestGroupIndex: desiredNewest
    },
    boundedCapacity,
    currentWindow.edge,
    cleanAuth,
    observability
  )
}

/** Refreshes a historical range, or follows the latest edge, at the same group capacity. */
export const reconcileMessageWindow = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow
): MessageWindow => {
  const rawCapacity = currentWindow.groupCapacity
  const capacity = Math.min(rawCapacity, MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT)
  const auth =
    currentWindow.authoritativeHasMoreBefore !== undefined || currentWindow.authoritativeHasMoreAfter !== undefined
      ? {
          hasMoreBefore: currentWindow.authoritativeHasMoreBefore,
          hasMoreAfter: currentWindow.authoritativeHasMoreAfter
        }
      : undefined
  const cleanAuth = auth?.hasMoreBefore === undefined && auth?.hasMoreAfter === undefined ? undefined : auth
  if (currentWindow.edge === 'latest') {
    return createLatestMessageWindow(messages, capacity, cleanAuth)
  }

  const model = createMessageViewportGroupModel(messages)
  const retainedIndexes = currentWindow.displayMessages.flatMap((message) => {
    const group = model.messageIdToGroup.get(message.id)
    return group ? [model.groups.indexOf(group)] : []
  })
  if (retainedIndexes.length === 0) {
    const previousModel = createMessageViewportGroupModel(previousMessages)
    const previousRange = currentWindow.range
    if (!previousRange || previousModel.groups.length === 0) {
      return createWindowFromRange(model, null, capacity, 'fixed', cleanAuth)
    }
    // Clamp previous range to bounded capacity deterministically (trim newer edge if needed).
    let boundedRange = previousRange
    const rangeCount = previousRange.newestGroupIndex - previousRange.oldestGroupIndex + 1
    if (rangeCount > capacity) {
      const trimmedGroups = rangeCount - capacity
      boundedRange = {
        oldestGroupIndex: previousRange.oldestGroupIndex,
        newestGroupIndex: previousRange.newestGroupIndex - trimmedGroups
      }
      const observability: MessageWindow['boundedViewportObservability'] = {
        calibrationDefault: MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
        boundedCapacity: capacity,
        didTrim: true,
        trimmedGroups,
        trimmedEdge: 'newer'
      }
      return createWindowFromRange(model, boundedRange, capacity, 'fixed', cleanAuth, observability)
    }
    return createWindowFromRange(model, boundedRange, capacity, 'fixed', cleanAuth)
  }

  let oldestGroupIndex = Math.min(...retainedIndexes)
  let newestGroupIndex = Math.max(...retainedIndexes)
  let didTrim = false
  let trimmedGroups = 0
  let trimmedEdge: 'older' | 'newer' | null = null
  if (newestGroupIndex - oldestGroupIndex + 1 > capacity) {
    const excess = newestGroupIndex - oldestGroupIndex + 1 - capacity
    oldestGroupIndex = newestGroupIndex - capacity + 1
    didTrim = true
    trimmedGroups = excess
    trimmedEdge = 'older'
  }
  const missingCount = Math.max(0, capacity - (newestGroupIndex - oldestGroupIndex + 1))
  const addedNewer = Math.min(model.groups.length - 1 - newestGroupIndex, missingCount)
  newestGroupIndex += addedNewer
  oldestGroupIndex = Math.max(0, oldestGroupIndex - (missingCount - addedNewer))

  const observability: MessageWindow['boundedViewportObservability'] =
    didTrim || trimmedGroups > 0
      ? {
          calibrationDefault: MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
          boundedCapacity: capacity,
          didTrim,
          trimmedGroups,
          trimmedEdge
        }
      : undefined

  return createWindowFromRange(
    model,
    { oldestGroupIndex, newestGroupIndex },
    capacity,
    'fixed',
    cleanAuth,
    observability
  )
}

// --- S6.1 helpers transplanted from Messages.tsx (single production implementation) ---

/**
 * Canonical disjoint authoritative window union by stable ID with deterministic sort.
 * Deduplicates by stable `id`, preserves all resident tail entries, adds any new
 * incoming entries, and sorts deterministically: ascending `sortOrder` when present,
 * tie-broken by lexicographic `id`, otherwise lexicographic `id` only.
 * Used by R-04 search-hit navigation when the anchor is not resident.
 */
export function unionWindowMessages(existing: Message[], incoming: Message[]): Message[] {
  const existingIds = new Set(existing.map((m) => m.id))
  const newIncoming = incoming.filter((m) => !existingIds.has(m.id))
  if (newIncoming.length === 0) return existing
  const combined = [...existing, ...newIncoming]
  const hasSortOrder = combined.some((m) => typeof (m as any).sortOrder === 'number')
  if (hasSortOrder) {
    return combined.slice().sort((a: any, b: any) => {
      const sa = typeof a.sortOrder === 'number' ? a.sortOrder : Number.MAX_SAFE_INTEGER
      const sb = typeof b.sortOrder === 'number' ? b.sortOrder : Number.MAX_SAFE_INTEGER
      if (sa !== sb) return sa - sb
      return a.id.localeCompare(b.id)
    })
  }
  return combined.slice().sort((a, b) => a.id.localeCompare(b.id))
}

export function mergeWindowIntoTopic(existing: Message[], incoming: Message[], anchorId: string): Message[] {
  const existingIds = new Set(existing.map((m) => m.id))
  const newIds = incoming.filter((m) => !existingIds.has(m.id))
  if (newIds.length === 0) return existing

  const anchorIdxExisting = existing.findIndex((m) => m.id === anchorId)
  const anchorIdxIncoming = incoming.findIndex((m) => m.id === anchorId)
  if (anchorIdxIncoming === -1) return existing

  const beforeIncoming = incoming.slice(0, anchorIdxIncoming).filter((m) => !existingIds.has(m.id))
  const afterIncoming = incoming.slice(anchorIdxIncoming + 1).filter((m) => !existingIds.has(m.id))

  if (anchorIdxExisting === -1) {
    return [...beforeIncoming, ...existing, ...afterIncoming]
  }

  const result = [...existing]
  result.splice(anchorIdxExisting, 0, ...beforeIncoming)
  const newAnchorPos = result.findIndex((m) => m.id === anchorId)
  result.splice(newAnchorPos + 1, 0, ...afterIncoming)
  return result
}

export function clampWindowCount(n: number): number {
  return Math.min(100, Math.max(1, Math.floor(n) || 1))
}

/**
 * Conservative route-window rebase (pure, production path).
 *
 * Safety contract (no persistence-architecture extension):
 * - The Main `fetchMessagesWindow` response is the ONLY authority for the
 *   target route. `nextIds` is ALWAYS exactly the target window's stable-ID
 *   order (oldest-first) — never a union with pre-window old IDs.
 * - Only the old contiguous prefix that is positionally identical to the
 *   window's own head (`commonPrefixLen`) counts as "proven shared and
 *   retained". It is observability only: those IDs are already inside the
 *   window, so retention never extends resident coverage beyond the window.
 * - Pre-window old IDs (older than the window's first ID) are NEVER retained:
 *   the window protocol cannot prove they still belong to the target route
 *   (they may be the old route's exclusive history). Middle-start windows,
 *   disjoint routes, and trimmed prefixes therefore degrade to pure target
 *   window replacement. Old exclusive suffixes always leave via `removedIds`.
 * - Sort order is always the valid (target) route order — the window order.
 * - Because resident coverage == window coverage exactly, the response's
 *   `hasMoreBefore/After` stays exact for the resident projection: no boundary
 *   adjustment is needed and `response.hasMoreBefore === false` can never
 *   combine with an extra retained prefix into a wrong boundary.
 *
 * No store access, no mutation. The reducer publishes `nextIds` atomically
 * (single commit, no blank/mixed frame) via `rebaseRouteWindow`.
 */
export function diffRouteRebase(
  oldIds: readonly string[],
  windowMessages: readonly { id: string }[]
): {
  commonPrefixLen: number
  removedIds: string[]
  addedIds: string[]
  nextIds: string[]
} {
  const nextIds = windowMessages.map((m) => m.id)
  const nextSet = new Set(nextIds)
  let commonPrefixLen = 0
  const maxPrefix = Math.min(oldIds.length, nextIds.length)
  while (commonPrefixLen < maxPrefix && oldIds[commonPrefixLen] === nextIds[commonPrefixLen]) {
    commonPrefixLen++
  }
  const removedIds = oldIds.filter((id) => !nextSet.has(id))
  const oldSet = new Set(oldIds)
  const addedIds = nextIds.filter((id) => !oldSet.has(id))
  return { commonPrefixLen, removedIds, addedIds, nextIds }
}

/**
 * Production rebase entry: old resident IDs + authoritative target window →
 * atomic publish plan with boundary metadata.
 *
 * `windowMeta` is the validated response window's completeness flags. Because
 * `nextIds` is exactly the window (see `diffRouteRebase` contract), the
 * returned `hasMoreBefore/After` are exactly `windowMeta`'s values — provably
 * consistent with actual resident coverage. `degraded` is true when no
 * positional shared prefix could be proven (disjoint / middle-start window):
 * the caller still publishes `nextIds` (safe replacement), it only signals
 * that no shared head was retained.
 */
export function rebaseRouteWindow(
  oldIds: readonly string[],
  windowMessages: readonly { id: string }[],
  windowMeta: { hasMoreBefore: boolean; hasMoreAfter: boolean }
): {
  commonPrefixLen: number
  removedIds: string[]
  addedIds: string[]
  nextIds: string[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  degraded: boolean
} {
  const diff = diffRouteRebase(oldIds, windowMessages)
  return {
    ...diff,
    hasMoreBefore: windowMeta.hasMoreBefore,
    hasMoreAfter: windowMeta.hasMoreAfter,
    degraded: diff.commonPrefixLen === 0 && oldIds.length > 0 && diff.nextIds.length > 0
  }
}

/**
 * Loaded-route state (renderer-local projection request currency, no
 * persistence) — NOT rendered/displayed truth.
 *
 * Rendered/displayed route truth lives SOLELY in `RouteViewportController`
 * (rendered provenance + displayed route + epoch). This marker only answers
 * "did the projection loader already issue a request for this route" so
 * route effects skip duplicate loads; it never decides what the DOM shows,
 * never gates snapshots, and never competes with the controller.
 *
 * Type-safe replacement for the former magic `branchId` marker string: the
 * load-failed signal is an explicit `loadFailed` boolean on a tagged object,
 * never a string that could collide with a real route key (`null` = main,
 * non-empty = branch id). `route` always holds a real route key; `loadFailed`
 * only says the last windowed load for that route failed twice and must be
 * retried instead of trusted.
 */
export type RouteKey = string | null

export interface LoadedRouteState {
  route: RouteKey
  loadFailed: boolean
}

/** Initial loaded-route state for the current active route (not failed). */
export function initLoadedRouteState(route: RouteKey): LoadedRouteState {
  return { route, loadFailed: false }
}

/** Claim that `route` is now the loaded projection (clears any failed flag). */
export function claimLoadedRoute(route: RouteKey): LoadedRouteState {
  return { route, loadFailed: false }
}

/** Mark `route` as double-failed: keeps the real route key, sets the flag. */
export function markLoadedRouteFailed(route: RouteKey): LoadedRouteState {
  return { route, loadFailed: true }
}

/**
 * Whether the loaded projection can be trusted for `activeRoute`: true only
 * when the routes match AND the last load did not fail. A failed state is
 * never current even when its `route` equals the active route, so the next
 * route effect (or route/topic switch) reloads instead of trusting an empty
 * projection that was never loaded.
 */
export function isLoadedRouteCurrent(state: LoadedRouteState, activeRoute: RouteKey): boolean {
  return !state.loadFailed && state.route === activeRoute
}

export interface DividerDoubleFailureSnapshot {
  prevRoute: RouteKey
  targetRoute: RouteKey
  startTopicId: string
  currentTopicId: string
  currentRoute: RouteKey
}

/**
 * Divider double-failure decision (pure, production path).
 *
 * The fork-anchor `around` read and the `latest` fallback both failed. Roll
 * back to `prevRoute` ONLY while still on the failed target (same topic and
 * the live route still equals the target). If the user already moved on
 * (topic changed or route changed), do nothing so a stale rollback can never
 * clobber the user's current route.
 */
export function decideDividerDoubleFailureRecovery(snapshot: DividerDoubleFailureSnapshot): {
  shouldRollback: boolean
  rollbackTo: RouteKey
} {
  const stillOnTarget =
    snapshot.currentTopicId === snapshot.startTopicId && snapshot.currentRoute === snapshot.targetRoute
  if (!stillOnTarget) return { shouldRollback: false, rollbackTo: snapshot.prevRoute }
  return { shouldRollback: true, rollbackTo: snapshot.prevRoute }
}

export interface ExternalDoubleFailureSnapshot {
  targetRoute: RouteKey
  startTopicId: string
  currentTopicId: string
  currentRoute: RouteKey
}

/**
 * Top/外部 route double-failure decision (pure, production path).
 *
 * The active route is external truth and cannot roll back, so the caller
 * clears the target projection/viewport and marks the loaded route failed
 * (retryable) — ONLY while still on the failed target. If the user already
 * moved on, do nothing. The failed marker is built via
 * `markLoadedRouteFailed` (tagged boolean, never a magic branch id).
 */
export function decideExternalDoubleFailureRecovery(snapshot: ExternalDoubleFailureSnapshot): {
  shouldClear: boolean
} {
  const stillOnTarget =
    snapshot.currentTopicId === snapshot.startTopicId && snapshot.currentRoute === snapshot.targetRoute
  return { shouldClear: stillOnTarget }
}

export type RouteWindowSavedPosition = {
  scrollTop: number
  anchorId: string | null
  /** Canonical route saved ROW anchor; legacy `anchorId` is the fallback. */
  messageId?: string | null
  intraRowOffset?: number | null
  rawScrollTop?: number
  isAtBottom: boolean
} | null

/**
 * Canonical saved anchor: `messageId` wins, legacy `anchorId` fills when the
 * canonical field is absent/empty. Empty string never selects an around read.
 */
export function canonicalSavedAnchorId(saved: RouteWindowSavedPosition): string | null {
  if (!saved) return null
  const canonical = typeof saved.messageId === 'string' && saved.messageId.length > 0 ? saved.messageId : null
  if (canonical) return canonical
  return typeof saved.anchorId === 'string' && saved.anchorId.length > 0 ? saved.anchorId : null
}

/**
 * Top-selector window choice (pure, production path): which windowed read the
 * NEW route needs from its own saved browsing position.
 * - valid canonical anchor (`messageId`, legacy `anchorId` fallback) → around it,
 *   even when `isAtBottom` is true: the exact messageId + intra-row offset is
 *   the route-local stable viewport (VIEWPORT-5) and outranks bottom vicinity.
 * - otherwise (`null`/anchorless snapshot) → latest; `isAtBottom` only selects
 *   here (bottom vicinity; caller restores bottom naturally).
 * - otherwise → latest (deterministic tail + route-local default below).
 * Never reads the OLD route's snapshot; never overwrites any snapshot here.
 * An around read that fails typed NOT_FOUND means the saved snapshot is
 * invalid for this route (deleted/out-of-route): the caller must take the
 * explicit route-local terminal default and may replace the stale snapshot
 * only after that default is placed/stable. Transport/load failure or
 * supersession must fail visible and preserve the prior snapshot (never a
 * fallback commit).
 */
export function chooseRouteWindowRequest(
  saved: RouteWindowSavedPosition
): { kind: 'latest' } | { kind: 'around'; anchorMessageId: string } {
  const anchor = canonicalSavedAnchorId(saved)
  if (anchor) {
    return { kind: 'around', anchorMessageId: anchor }
  }
  return { kind: 'latest' }
}

const TOP_RESTORE_NOT_FOUND_CODES = new Set(['NOT_FOUND', 'ERR_NOT_FOUND', 'TOPIC_NOT_FOUND'])

/**
 * Structural typed-NOT_FOUND check for around-window failures (code family,
 * never message matching): invalid saved snapshot for this route
 * (deleted/out-of-route). Any other rejection is environmental/transport and
 * must preserve the prior snapshot.
 */
export function isTopRestoreNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && TOP_RESTORE_NOT_FOUND_CODES.has(code)
}

export interface TopRestoreAnchorDecision {
  /** Resident route anchor to restore, or null for the terminal/default path. */
  routeSavedRowAnchor: string | null
  /** True only for the invalid-snapshot terminal default (may replace stale). */
  snapshotInvalidForRoute: boolean
  /** True when the caller must fail visible and preserve the snapshot. */
  mustFailVisible: boolean
}

/**
 * Pure top-restore anchor decision: valid saved anchors never degrade to
 * vicinity/tail/raw. Only the invalid-snapshot (NOT_FOUND) and no-snapshot
 * paths take the deterministic route-local default (`null` anchor → tail).
 */
export function decideTopRestoreAnchor(input: {
  canonicalAnchor: string | null
  snapshotInvalidForRoute: boolean
  loadedIds: ReadonlySet<string>
}): TopRestoreAnchorDecision {
  if (input.snapshotInvalidForRoute || !input.canonicalAnchor) {
    return { routeSavedRowAnchor: null, snapshotInvalidForRoute: input.snapshotInvalidForRoute, mustFailVisible: false }
  }
  if (input.loadedIds.has(input.canonicalAnchor)) {
    return { routeSavedRowAnchor: input.canonicalAnchor, snapshotInvalidForRoute: false, mustFailVisible: false }
  }
  return { routeSavedRowAnchor: null, snapshotInvalidForRoute: false, mustFailVisible: true }
}

/**
 * Pure stable-commit gate: a valid requested anchor commits only when it is
 * covered/resident (projection + connected DOM) — quiet/alignment is owned by
 * the caller's stabilizer. Terminal defaults, anchorless bottom restores, and
 * anchorless defaults carry no anchor requirement. `isAtBottom` never waives a
 * valid requested anchor: exact messageId + intra-row offset outranks bottom
 * vicinity (VIEWPORT-5).
 */
export function isTopStableCommittable(input: {
  isAtBottom: boolean
  snapshotInvalidForRoute: boolean
  requestedAnchor: string | null
  projectionContains: boolean
  domConnected: boolean
}): boolean {
  if (input.snapshotInvalidForRoute) return true
  if (!input.requestedAnchor) return true
  return input.projectionContains && input.domConnected
}

/**
 * Pure top first-position plan (route-local stable viewport, VIEWPORT-5):
 * a resolved saved-row anchor always selects `message` with the saved
 * intra-row offset — even when `isAtBottom` is true. `isAtBottom` selects
 * `bottom` only when no anchor is available; invalid snapshots
 * (typed NOT_FOUND: deleted/out-of-route) take the deterministic
 * route-local default `bottom` on the latest window — stale anchor, raw
 * scrollTop, and `isAtBottom` values are ignored; anchorless raw scrollTop
 * is a same-route local fallback only; anchorless no-snapshot takes the
 * deterministic route-local default `bottom` (never outgoing geometry,
 * never `none` for the invalid path).
 */
export function chooseTopFirstPositionPlan(input: {
  saved: RouteWindowSavedPosition
  snapshotInvalidForRoute: boolean
  routeSavedRowAnchor: string | null
}):
  | { kind: 'bottom' }
  | { kind: 'none' }
  | { kind: 'message'; messageId: string; wantOffset: number | null; fallbackScrollTop: null }
  | { kind: 'scrollTop'; scrollTop: number } {
  if (input.snapshotInvalidForRoute) return { kind: 'bottom' }
  if (input.routeSavedRowAnchor) {
    const wantOffset =
      typeof input.saved?.intraRowOffset === 'number' && Number.isFinite(input.saved.intraRowOffset)
        ? input.saved.intraRowOffset
        : null
    return { kind: 'message', messageId: input.routeSavedRowAnchor, wantOffset, fallbackScrollTop: null }
  }
  if (input.saved?.isAtBottom) return { kind: 'bottom' }
  const canonicalAnchor = canonicalSavedAnchorId(input.saved)
  const sameRouteScrollTop =
    input.saved && typeof input.saved.scrollTop === 'number' && Number.isFinite(input.saved.scrollTop)
      ? input.saved.scrollTop
      : null
  if (!canonicalAnchor && sameRouteScrollTop !== null) return { kind: 'scrollTop', scrollTop: sameRouteScrollTop }
  return { kind: 'bottom' }
}

/**
 * Route viewport rebuild (pure, production path): viewport window for the
 * rebased loaded projection with atomic empty-route clearing.
 *
 * - Empty `loaded` (empty target route) → empty fixed window carrying the
 *   authoritative flags (empty routes report hasMore false/false). The caller
 *   applies it via `window/apply`, atomically clearing the viewport so no old
 *   route residual survives. Returns `{ window, empty: true }`.
 * - Non-empty → window around the first available anchor candidate
 *   (fork anchor → visual anchor → vicinity → tail), else the loaded tail.
 *   Never a bottom jump: the anchor list is ordered by stability, tail is the
 *   last resort. Returns `{ window, empty: false }`, or `{ window: null }`
 *   when no anchor resolves (caller keeps the current viewport).
 */
export function buildRouteViewport(
  loaded: readonly Message[],
  anchorCandidates: readonly (string | null | undefined)[],
  authoritative: { hasMoreBefore: boolean; hasMoreAfter: boolean } | undefined,
  visuallyOlderGroupCount: number,
  visuallyNewerGroupCount: number
): { window: MessageWindow | null; empty: boolean } {
  if (loaded.length === 0) {
    const emptyWindow = createLatestMessageWindow([], 1, {
      hasMoreBefore: authoritative?.hasMoreBefore ?? false,
      hasMoreAfter: authoritative?.hasMoreAfter ?? false
    })
    return { window: emptyWindow, empty: true }
  }
  const loadedIds = new Set(loaded.map((m) => m.id))
  const anchor =
    anchorCandidates.find((id): id is string => typeof id === 'string' && loadedIds.has(id)) ??
    loaded[loaded.length - 1]?.id ??
    null
  if (!anchor) return { window: null, empty: false }
  const targetWindow = createTargetMessageWindow(
    [...loaded],
    anchor,
    visuallyOlderGroupCount,
    visuallyNewerGroupCount,
    authoritative
  )
  return { window: targetWindow, empty: false }
}

// Authoritative latest-window completeness store (renderer-only, per-topic.
// Populated by loadTopicMessagesThunk after validated latest response;
// consumed by Messages bootstrap to retain hasMoreBefore/hasMoreAfter.)
const latestWindowCompletenessByTopic = new Map<string, { hasMoreBefore: boolean; hasMoreAfter: boolean }>()

export function setLatestWindowCompleteness(
  topicId: string,
  completeness: { hasMoreBefore: boolean; hasMoreAfter: boolean }
): void {
  const prev = latestWindowCompletenessByTopic.get(topicId)
  if (prev && prev.hasMoreBefore === completeness.hasMoreBefore && prev.hasMoreAfter === completeness.hasMoreAfter) {
    return
  }
  latestWindowCompletenessByTopic.set(topicId, {
    hasMoreBefore: completeness.hasMoreBefore,
    hasMoreAfter: completeness.hasMoreAfter
  })
}

export function getLatestWindowCompleteness(
  topicId: string
): { hasMoreBefore: boolean; hasMoreAfter: boolean } | undefined {
  return latestWindowCompletenessByTopic.get(topicId)
}

export function clearLatestWindowCompleteness(topicId: string): void {
  latestWindowCompletenessByTopic.delete(topicId)
}

export function clearAllLatestWindowCompleteness(): void {
  latestWindowCompletenessByTopic.clear()
}
