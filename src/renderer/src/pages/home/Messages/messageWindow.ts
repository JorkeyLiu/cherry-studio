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

    /**
     * True when the bounded trim was reduced so the retained live reading row
     * stayed inside the window. The window then exceeds the calibration default
     * by at most the requested growth (it never leaves the provisional range),
     * and `trimmedGroups` reports the trim that actually happened.
     */
    retentionClamped?: boolean
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

/**
 * Group-index lookup built once per derived range. `model.groups.indexOf(group)`
 * is a linear scan, so resolving every displayed message that way costs
 * O(displayed messages × groups) on a long topic. The identity-keyed map
 * resolves each message in O(1) and is built in O(groups); `messageIdToGroup`
 * only ever holds groups from the same `groups` array, so both forms always
 * yield the same index.
 */
const buildGroupIndexes = (model: MessageViewportGroupModel): ReadonlyMap<MessageViewportGroup, number> => {
  const groupIndexes = new Map<MessageViewportGroup, number>()
  model.groups.forEach((group, index) => {
    groupIndexes.set(group, index)
  })
  return groupIndexes
}

const getRangeFromDisplayMessages = (model: MessageViewportGroupModel, displayMessages: Message[]) => {
  // Nothing displayed → no range, and no need to build the lookup at all.
  if (displayMessages.length === 0) return null
  const groupIndexes = buildGroupIndexes(model)
  const displayGroupIndexes = displayMessages.flatMap((message) => {
    const group = model.messageIdToGroup.get(message.id)
    const index = group ? groupIndexes.get(group) : undefined
    return index === undefined ? [] : [index]
  })
  if (displayGroupIndexes.length === 0) return null

  return {
    oldestGroupIndex: Math.min(...displayGroupIndexes),
    newestGroupIndex: Math.max(...displayGroupIndexes)
  }
}

/**
 * Optional constraint for one bounded window expansion: the stable identity the
 * caller must keep resident in the derived window (the live reading row the
 * stable-anchor keeper holds). Resolution is id-keyed against the SAME model the
 * range is derived from, so an identity that left the projection resolves to
 * `null` and degrades to the unconstrained bounded trim (the caller's existing
 * anchor fallback applies).
 */
export interface MessageWindowExpansionOptions {
  retainMessageId?: string | null
}

const resolveRetainedGroupIndex = (
  model: MessageViewportGroupModel,
  options?: MessageWindowExpansionOptions
): number | null => {
  const id = options?.retainMessageId
  if (typeof id !== 'string' || id.length === 0) return null
  const group = model.messageIdToGroup.get(id)
  if (!group) return null
  const index = model.groups.indexOf(group)
  return index >= 0 ? index : null
}

/**
 * Retention limit for one edge-relative trim: how many groups may be trimmed
 * from the trimmed edge while the retained row stays inside the derived window.
 * `null` when nothing inside the PROVISIONAL range needs to stay resident — no
 * retained id, or a retained id already outside the range the trim can affect
 * (it is not in this window either way, so retention must not skip the trim).
 */
const retentionLimitGroups = (
  retainedIndex: number | null,
  provisionalOldest: number,
  provisionalNewest: number,
  edge: 'older' | 'newer'
): number | null => {
  if (retainedIndex === null) return null
  if (retainedIndex < provisionalOldest || retainedIndex > provisionalNewest) return null
  return edge === 'older' ? provisionalNewest - retainedIndex : retainedIndex - provisionalOldest
}

/**
 * Bounded opposite-edge trim that never removes the retained live row.
 *
 * `required` keeps the window exactly at the calibration default; `retentionLimit`
 * is the largest trim that still leaves the retained row resident (already
 * edge-relative, `null` when there is nothing to retain). RETENTION ALWAYS WINS:
 * losing the row would unmount the keeper's live anchor and let the viewport
 * jump, so the trim is reduced instead of the row being dropped.
 *
 * The window this returns is therefore inside the PROVISIONAL range (current
 * window plus this page) but may exceed the calibration default by more than one
 * page when retention and the bound conflict. Boundedness is enforced one layer
 * up by `canAdvancePaginationWindow`, which DECLINES such a transition instead
 * of publishing an over-bound window (see `derivePaginationWindow`).
 */
const boundedTrimGroups = (required: number, retentionLimit: number | null): number =>
  retentionLimit === null ? required : Math.min(required, Math.max(0, retentionLimit))

export const expandMessageWindowOlder = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean },
  options?: MessageWindowExpansionOptions
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
    const requiredTrim = provisionalCount - calibrationDefault
    const retainedIndex = resolveRetainedGroupIndex(model, options)
    // Growing older trims the NEWER edge: the retained live row stays resident
    // while the trim keeps `boundedNewest >= retainedIndex`. Retention wins —
    // the retained row is never trimmed away here; a state where that would
    // exceed the one-page bound is declined before this derivation runs.
    const trimmedGroups = boundedTrimGroups(
      requiredTrim,
      retentionLimitGroups(retainedIndex, provisionalOldest, provisionalNewest, 'older')
    )
    const boundedNewest = provisionalNewest - trimmedGroups
    const boundedCapacity = calibrationDefault
    const observability: MessageWindow['boundedViewportObservability'] = {
      calibrationDefault,
      boundedCapacity,
      didTrim: trimmedGroups > 0,
      trimmedGroups,
      trimmedEdge: 'newer',
      retentionClamped: trimmedGroups < requiredTrim
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
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean },
  options?: MessageWindowExpansionOptions
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
    const requiredTrim = provisionalCount - calibrationDefault
    const retainedIndex = resolveRetainedGroupIndex(model, options)
    // Growing newer trims the OLDER edge: the retained live row stays resident
    // while the trim keeps `boundedOldest <= retainedIndex`. Mirror of the older
    // direction: retention wins identically, and a state where retention cannot
    // fit inside the one-page bound is declined before this derivation runs.
    const trimmedGroups = boundedTrimGroups(
      requiredTrim,
      retentionLimitGroups(retainedIndex, provisionalOldest, provisionalNewest, 'newer')
    )
    const boundedOldest = provisionalOldest + trimmedGroups
    const boundedCapacity = calibrationDefault
    const observability: MessageWindow['boundedViewportObservability'] = {
      calibrationDefault,
      boundedCapacity,
      didTrim: trimmedGroups > 0,
      trimmedGroups,
      trimmedEdge: 'older',
      retentionClamped: trimmedGroups < requiredTrim
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

/**
 * Feasibility of ONE bounded pagination transition (pure, production).
 *
 * The two properties a published window must keep at the same time — the
 * display window stays inside `calibrationDefault + one page`, and the live
 * reading row stays resident — can conflict. When they do, the transition is
 * DECLINED: the projection keeps the window it already has (the user's reading
 * position and DOM stay exactly as they are) instead of publishing a window
 * that would unmount the row being read.
 *
 * This is not a stall in normal browsing: the reading row moves as the user
 * scrolls, so paging becomes feasible again as soon as the row has left the
 * trimmed edge (the accumulated one-page overshoot is reclaimed by that same
 * transition, since the required trim is then affordable).
 *
 * Cheap by construction: no group model is built while the requested page still
 * fits under the cap, which is every window below capacity.
 */
export type PaginationWindowDeclineReason = 'retention-exceeds-bound'

export type PaginationWindowGuard = { allowed: true } | { allowed: false; reason: PaginationWindowDeclineReason }

export interface PaginationWindowGuardInput {
  direction: 'older' | 'newer'
  /** Current resident projection in route order (oldest-first). */
  messages: Message[]
  /** The committed window the page would grow from. */
  currentWindow: MessageWindow
  /** Groups to add on the loaded edge (the requested page size). */
  additionalGroupCount: number
  /** Live reading row that must stay resident (null when none is provable). */
  retainMessageId?: string | null
}

export const canAdvancePaginationWindow = (input: PaginationWindowGuardInput): PaginationWindowGuard => {
  const calibrationDefault = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  const added = Math.max(0, input.additionalGroupCount)
  // Under capacity there is no trim at all: nothing can be unmounted.
  if (input.currentWindow.groupCount + added <= calibrationDefault) return { allowed: true }

  const model = createMessageViewportGroupModel(input.messages)
  const currentRange = getRangeFromDisplayMessages(model, input.currentWindow.displayMessages)
  // No provable current range (a rebuild from scratch follows): the caller's
  // existing fallback owns it, so this guard has no verdict to add.
  if (!currentRange) return { allowed: true }

  const older = input.direction === 'older'
  const provisionalOldest = older ? Math.max(0, currentRange.oldestGroupIndex - added) : currentRange.oldestGroupIndex
  const provisionalNewest = older
    ? currentRange.newestGroupIndex
    : Math.min(model.groups.length - 1, currentRange.newestGroupIndex + added)
  const provisionalCount = provisionalNewest - provisionalOldest + 1
  if (provisionalCount <= calibrationDefault) return { allowed: true }

  // The one-page allowance: the smallest trim that keeps the window inside
  // `calibrationDefault + added`. It can never exceed `added` because the
  // committed window is itself bounded by `calibrationDefault + added`.
  const minimumTrim = Math.max(0, provisionalCount - (calibrationDefault + added))
  if (minimumTrim === 0) return { allowed: true }

  const retainedIndex = resolveRetainedGroupIndex(model, { retainMessageId: input.retainMessageId })
  const retentionLimit = retentionLimitGroups(
    retainedIndex,
    provisionalOldest,
    provisionalNewest,
    older ? 'older' : 'newer'
  )
  // Nothing inside the provisional range needs to stay resident: the exact
  // bounded trim applies.
  if (retentionLimit === null) return { allowed: true }
  // Keeping the row (trim ≤ retentionLimit) and staying bounded
  // (trim ≥ minimumTrim) can only hold together in this interval.
  return retentionLimit >= minimumTrim ? { allowed: true } : { allowed: false, reason: 'retention-exceeds-bound' }
}

/**
 * One ordinary bidirectional pagination window transition (pure, production).
 *
 * Both directions share this single derivation: the accepted merge result and
 * the CURRENT committed window decide the next window, grown on the requested
 * edge by the same group count, with the opposite edge bounded exactly as
 * before. Only the edge-relative authority mapping differs:
 * - the loaded edge takes the validated Main response's own completeness flag
 *   (authoritative `hasMoreBefore` when growing older, `hasMoreAfter` when
 *   growing newer);
 * - the untouched edge keeps the CURRENT window's own traversability, whether
 *   that is authoritative Main truth or the local derived value of a bounded
 *   trim. The distinction stays explicit: `hasMore*` on the derived window is
 *   "can this display still be traversed locally", while
 *   `authoritativeHasMoreBefore/After` carries the Main response verbatim.
 *
 * `retainMessageId` is the live reading row the stable-anchor keeper holds: a
 * bounded trim that would remove it is reduced instead (see `boundedTrimGroups`),
 * so an ACCEPTED commit never unmounts the anchor it must hold. When holding the
 * row and staying bounded cannot both hold, the transition is DECLINED
 * (`canAdvancePaginationWindow`) and the caller must publish nothing at all —
 * the committed projection, its traversability flags and the DOM stay untouched.
 * The result is always derived from route-ordered input and is never re-sorted.
 */
export interface PaginationWindowTransitionInput extends PaginationWindowGuardInput {
  /** Completeness flags of the validated Main response window. */
  responseWindow: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
}

export type PaginationWindowTransition =
  | { status: 'accepted'; window: MessageWindow }
  | { status: 'declined'; reason: PaginationWindowDeclineReason }

export const derivePaginationWindow = (input: PaginationWindowTransitionInput): PaginationWindowTransition => {
  // Boundedness and retention are decided BEFORE any derivation: a decline
  // produces no window at all, so the caller cannot publish a half-state.
  const guard = canAdvancePaginationWindow(input)
  if (!guard.allowed) return { status: 'declined', reason: guard.reason }
  const { direction, messages, currentWindow, additionalGroupCount, responseWindow, retainMessageId } = input
  const options: MessageWindowExpansionOptions = { retainMessageId: retainMessageId ?? null }
  const window =
    direction === 'older'
      ? expandMessageWindowOlder(
          messages,
          currentWindow,
          additionalGroupCount,
          { hasMoreBefore: responseWindow.hasMoreBefore, hasMoreAfter: currentWindow.hasMoreNewer },
          options
        )
      : expandMessageWindowNewer(
          messages,
          currentWindow,
          additionalGroupCount,
          { hasMoreBefore: currentWindow.hasMoreOlder, hasMoreAfter: responseWindow.hasMoreAfter },
          options
        )
  return { status: 'accepted', window }
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
  // Same id-keyed resolution used by every other derived range (one group-index
  // lookup built once) instead of a linear group scan per displayed message.
  const retainedRange = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!retainedRange) {
    const previousRange = currentWindow.range
    // The group builder emits at least one group for every message, so an empty
    // group list is exactly an empty previous projection — no need to build the
    // previous model just to read its group count.
    if (!previousRange || previousMessages.length === 0) {
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

  let oldestGroupIndex = retainedRange.oldestGroupIndex
  let newestGroupIndex = retainedRange.newestGroupIndex
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
 * In-bound navigation union: attach an authoritative `around` window for a
 * target that is NOT resident yet.
 *
 * Route-order contract (same rule as `mergeWindowIntoTopic`): when the window
 * shares at least one resident neighbour, the window's new run is spliced at
 * the shared neighbour that precedes it in window order and the RESIDENT order
 * is preserved verbatim. On a branch route the resident order composes several
 * owners' layers, so a global `sortOrder`/id sort would fabricate an order the
 * authority never published.
 *
 * Only a window that shares NO resident id has no provable route position. That
 * disjoint case is FAIL-CLOSED: no sort, and no concatenation at a guessed end.
 * (`sortOrder` is an owner-local layer index, so sorting by it is exactly the
 * fabrication the route-order contract forbids.) The caller must take the
 * existing authoritative route-window rebase instead — Main's own stable-ID
 * window order replaces the projection — which keeps navigation to the target
 * valid without inventing an order.
 */
export type NavigationWindowUnion = { status: 'merged'; messages: Message[] } | { status: 'disjoint' }

export function unionWindowMessages(existing: Message[], incoming: Message[]): NavigationWindowUnion {
  const existingIds = new Set(existing.map((m) => m.id))
  const newIncoming = incoming.filter((m) => !existingIds.has(m.id))
  if (newIncoming.length === 0) return { status: 'merged', messages: existing }
  const firstShared = incoming.find((m) => existingIds.has(m.id))
  if (firstShared) {
    const spliced = mergeWindowIntoTopic(existing, incoming, firstShared.id)
    if (spliced.status === 'merged') return { status: 'merged', messages: spliced.messages }
  }
  return { status: 'disjoint' }
}

/**
 * Outcome of merging one authoritative `around` window response into the
 * CURRENT resident projection (pure, production decision).
 */
export type WindowMergeOutcome =
  | { status: 'merged'; messages: Message[]; addedIds: string[] }
  | { status: 'anchor-not-in-window' }
  | { status: 'anchor-not-resident' }

/**
 * Merge an authoritative pagination window into the resident route order.
 *
 * Ordering contract (route order only): `existing` is the current resident
 * projection in route order and `incoming` is the authoritative response
 * window in route order (oldest-first). Every window response is a CONTIGUOUS
 * run of the route, so its new ids are placed relative to the resident ids it
 * shares (`existing ∩ incoming`, route order): a new run is emitted
 * immediately after the shared id that precedes it in the window, or
 * immediately before the first shared id when nothing precedes it. Relative
 * order inside every run is the window's own order.
 *
 * The merged list is never re-sorted: on a branch route the resident order
 * composes several owners' layers, so a global `sortOrder` sort would
 * fabricate an order the authority never published.
 *
 * Fail-closed outcomes never guess a concatenation position:
 * - `anchor-not-in-window`: the response does not carry the requested stable
 *   anchor, so it is not a valid around window for this request;
 * - `anchor-not-resident`: the requested anchor is absent from the CURRENT
 *   resident projection (evicted/rebased/replaced while the read was in
 *   flight), so no route-order position is provable. The caller must drop the
 *   page and take its existing reload/rebase path instead of publishing.
 *
 * Deterministic id-keyed dedupe: ids already resident (and repeats inside the
 * window) are skipped, never duplicated.
 */
export function mergeWindowIntoTopic(
  existing: readonly Message[],
  incoming: readonly Message[],
  anchorId: string
): WindowMergeOutcome {
  if (typeof anchorId !== 'string' || anchorId.length === 0) return { status: 'anchor-not-in-window' }
  if (!incoming.some((message) => message.id === anchorId)) return { status: 'anchor-not-in-window' }
  if (!existing.some((message) => message.id === anchorId)) return { status: 'anchor-not-resident' }

  const residentIds = new Set(existing.map((message) => message.id))
  const sharedIds = new Set<string>()
  // New ids grouped by the shared resident id they follow in window order; ids
  // before the first shared id form the head run. Window repeats and resident
  // ids are skipped (deterministic id-keyed dedupe).
  const runsAfter = new Map<string, Message[]>()
  const headRun: Message[] = []
  const added: Message[] = []
  const seen = new Set<string>()
  let pending: Message[] = []
  let lastSharedId: string | null = null

  const flushPending = (): void => {
    if (pending.length === 0) return
    if (lastSharedId === null) {
      headRun.push(...pending)
    } else {
      const run = runsAfter.get(lastSharedId)
      if (run) run.push(...pending)
      else runsAfter.set(lastSharedId, pending)
    }
    pending = []
  }

  for (const message of incoming) {
    if (residentIds.has(message.id)) {
      flushPending()
      sharedIds.add(message.id)
      lastSharedId = message.id
      continue
    }
    if (seen.has(message.id)) continue
    seen.add(message.id)
    added.push(message)
    pending.push(message)
  }
  flushPending()

  // Emit the resident route order, splicing each new run at its shared
  // neighbour (the head run immediately before the first shared id).
  const result: Message[] = []
  let headEmitted = false
  for (const message of existing) {
    if (!headEmitted && sharedIds.has(message.id)) {
      if (headRun.length > 0) result.push(...headRun)
      headEmitted = true
    }
    result.push(message)
    const run = runsAfter.get(message.id)
    if (run) result.push(...run)
  }
  return { status: 'merged', messages: result, addedIds: added.map((message) => message.id) }
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
