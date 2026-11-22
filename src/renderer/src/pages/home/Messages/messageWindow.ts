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
/** Single capacity policy: the ONLY place that clamps a group count to the */
/** hard viewport bound. All construct/expand/reconcile paths delegate here */
/** so the 200-bound decision lives once; callers keep their own distinct */
/** budgets (initial displayCount=10, pagination page=20, navigation */
/** quotas 10/19, request clamp 1..100) and never merge them into this bound. */
export const clampViewportCapacity = (groupCount: number): number =>
  Math.min(Math.max(0, Math.floor(groupCount) || 0), MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT)

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
  /**
   * Set on a window an ordinary pagination published: this range is that
   * transition's committed browsing target for the loaded projection it was
   * derived from. Reconciliation RETAINS it instead of rebuilding the
   * newest-capacity range (see `reconcileMessageWindow`), so a page the user
   * pulled in is never replaced by a latest-edge reconstruction before the next
   * traversal. Every other construction (latest/oldest/target/navigation)
   * leaves it unset, and a pagination that again reaches the latest groups
   * drops it.
   */
  paginationTarget?: true
  /** Messages in newest-to-oldest data order (the render reverses once for normal flow). */
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

/**
 * Whether the committed display window provably starts at the true history head
 * of its route.
 *
 * Both facts must hold at once: Main reports no older page for the route
 * (`authoritativeHasMoreBefore === false`), and the display has no resident older
 * page left to browse (`hasMoreOlder === false`). A newest-capacity window can
 * omit resident older groups locally, and the head is a relation position, not a
 * row: claiming it while those rows are still reachable would place a head fork
 * above content that actually precedes it. Absent authority is unknown, never a
 * head.
 */
export const isHistoryHeadLoaded = (window: MessageWindow | null | undefined): boolean =>
  window?.authoritativeHasMoreBefore === false && window.hasMoreOlder === false

const createWindowFromRange = (
  model: MessageViewportGroupModel,
  range: MessageGroupRange | null,
  groupCapacity: number,
  edge: MessageWindow['edge'],
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean },
  observability?: MessageWindow['boundedViewportObservability']
): MessageWindow => {
  const boundedCapacity = clampViewportCapacity(groupCapacity)
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

/**
 * Creates a window anchored at the newest groups in the topic.
 *
 * The newest-capacity slice is itself a bounded trim of the loaded projection:
 * when the projection holds more groups than the bounded capacity, the surplus
 * older groups stay resident but outside the display window, so the display can
 * still be traversed locally toward them. That omission is reported through
 * `boundedViewportObservability` exactly like every other bounded trim, which is
 * what keeps the two window facts separate: an authoritative
 * `hasMoreBefore === false` says Main has no older page left to read, it never
 * says the local display has no older resident page left to show.
 */

/**
 * Latest-capacity derivation from an already-built group model. Same
 * construction as `createLatestMessageWindow` minus the model build, so a
 * single derive operation that already resolved the loaded projection never
 * builds a second model for its newest-capacity fallback.
 */
const createLatestWindowFromModel = (
  model: MessageViewportGroupModel,
  groupCapacity: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const rawCapacity = Math.max(0, groupCapacity)
  const boundedCapacity = clampViewportCapacity(rawCapacity)
  if (boundedCapacity === 0 || model.groups.length === 0)
    return createWindowFromRange(model, null, boundedCapacity, 'latest', authoritative)

  const oldestGroupIndex = Math.max(0, model.groups.length - boundedCapacity)
  // Resident groups the newest-capacity slice omits on the older edge (0 when
  // the whole loaded projection fits under the bound).
  const trimmedOlderGroups = oldestGroupIndex
  const observability: MessageWindow['boundedViewportObservability'] | undefined =
    trimmedOlderGroups > 0
      ? {
          calibrationDefault: MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
          boundedCapacity,
          didTrim: true,
          trimmedGroups: trimmedOlderGroups,
          trimmedEdge: 'older'
        }
      : undefined

  return createWindowFromRange(
    model,
    { oldestGroupIndex, newestGroupIndex: model.groups.length - 1 },
    boundedCapacity,
    'latest',
    authoritative,
    observability
  )
}
export const createLatestMessageWindow = (
  messages: Message[],
  groupCapacity: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => createLatestWindowFromModel(createMessageViewportGroupModel(messages), groupCapacity, authoritative)

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
  const boundedCapacity = clampViewportCapacity(rawCapacity)
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
  const boundedCapacity = clampViewportCapacity(rawCapacity)
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
 * Optional constraints for one bounded window derivation.
 *
 * `retainMessageId` is the stable identity the caller must keep resident (the
 * live reading row the stable-anchor keeper holds). Resolution is id-keyed
 * against the SAME model the range is derived from, so an identity that left the
 * projection resolves to `null` and degrades to the unconstrained bounded trim
 * (the caller's existing anchor fallback applies).
 *
 * `atPhysicalBottom` is the caller-measured fact that the scroll container rests
 * exactly at its physical bottom (1px rounding tolerance — never the bottom
 * vicinity threshold and never a snapshot's `isAtBottom`). It is the only
 * follow-intent input a bounded reconcile consumes; see `reconcileMessageWindow`.
 */
export interface MessageWindowExpansionOptions {
  retainMessageId?: string | null
  atPhysicalBottom?: boolean
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

/**
 * Lazy group-model provider shared by ONE bounded pagination derivation.
 * Built on first use only (`??=`), so a guard decline before any
 * over-capacity derivation builds no model at all, and guard plus expansion
 * never build separately. Same single-model pattern as `reconcileInternal`
 * below. Never cached across commits or modules: the closure dies with the
 * derivation, preflight and expansion always read the same messages array,
 * and successive calls with fresh entities always build fresh refs.
 */
type PaginationGroupModelProvider = () => MessageViewportGroupModel

const expandOlderWindowInternal = (
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative: { hasMoreBefore?: boolean; hasMoreAfter?: boolean } | undefined,
  options: MessageWindowExpansionOptions | undefined,
  getGroupModel: PaginationGroupModelProvider
): { window: MessageWindow; paged: boolean } => {
  // The committed rows resolve against the SAME model the guard derived
  // from; an empty display needs no lookup at all (the newest-capacity
  // fallback below reuses the shared provider instead of building again).
  const currentRange =
    currentWindow.displayMessages.length === 0
      ? null
      : getRangeFromDisplayMessages(getGroupModel(), currentWindow.displayMessages)
  if (!currentRange) {
    const fallbackAuth = {
      hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
      hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
    }
    const cleanAuth =
      fallbackAuth.hasMoreBefore === undefined && fallbackAuth.hasMoreAfter === undefined ? undefined : fallbackAuth
    // The committed rows do not resolve in the loaded projection, so the
    // requested older page cannot be produced: this is a newest-capacity
    // rebuild, explicitly NOT a paged range.
    return { window: createLatestWindowFromModel(getGroupModel(), additionalGroupCount, cleanAuth), paged: false }
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
    const retainedIndex = resolveRetainedGroupIndex(getGroupModel(), options)
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
    return {
      window: createWindowFromRange(
        getGroupModel(),
        { oldestGroupIndex: provisionalOldest, newestGroupIndex: boundedNewest },
        boundedCapacity,
        currentWindow.edge,
        cleanAuth,
        observability
      ),
      paged: true
    }
  }
  const boundedCapacity = clampViewportCapacity(currentWindow.groupCapacity + addedCount)
  const observability: MessageWindow['boundedViewportObservability'] = {
    calibrationDefault,
    boundedCapacity,
    didTrim: false,
    trimmedGroups: 0,
    trimmedEdge: null
  }
  return {
    window: createWindowFromRange(
      getGroupModel(),
      { ...currentRange, oldestGroupIndex: desiredOldest },
      boundedCapacity,
      currentWindow.edge,
      cleanAuth,
      observability
    ),
    paged: true
  }
}

const expandOlderWindow = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean },
  options?: MessageWindowExpansionOptions
): { window: MessageWindow; paged: boolean } => {
  let groupModel: MessageViewportGroupModel | null = null
  const getGroupModel = (): MessageViewportGroupModel => (groupModel ??= createMessageViewportGroupModel(messages))
  return expandOlderWindowInternal(currentWindow, additionalGroupCount, authoritative, options, getGroupModel)
}

/**
 * Older-edge expansion: grow the loaded (visually older) edge by one page,
 * bounded by the calibration default with the opposite-edge trim never
 * crossing the retained live row (see `boundedTrimGroups`).
 *
 * The result carries the explicit answer to what the expansion actually
 * produced. `paged: true` means the current window's rows resolved in the
 * loaded projection and this range IS the requested older page. `paged: false`
 * means they did not resolve (route/topic reload, stale in-flight merge), so
 * the fallback rebuilt a newest-capacity range that is NOT the requested page —
 * callers must not treat it as a committed browsing target.
 */
export const expandMessageWindowOlder = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean },
  options?: MessageWindowExpansionOptions
): MessageWindow => expandOlderWindow(messages, currentWindow, additionalGroupCount, authoritative, options).window

const expandMessageWindowNewerInternal = (
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative: { hasMoreBefore?: boolean; hasMoreAfter?: boolean } | undefined,
  options: MessageWindowExpansionOptions | undefined,
  getGroupModel: PaginationGroupModelProvider
): MessageWindow => {
  // Same shared-model discipline as the older direction: the committed rows
  // resolve against the SAME model the guard derived from, and an empty
  // display skips the lookup (the fallback reuses the shared provider).
  const currentRange =
    currentWindow.displayMessages.length === 0
      ? null
      : getRangeFromDisplayMessages(getGroupModel(), currentWindow.displayMessages)
  if (!currentRange) {
    const fallbackAuth = {
      hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
      hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
    }
    const cleanAuth =
      fallbackAuth.hasMoreBefore === undefined && fallbackAuth.hasMoreAfter === undefined ? undefined : fallbackAuth
    return createLatestWindowFromModel(getGroupModel(), additionalGroupCount, cleanAuth)
  }

  const addedCount = Math.max(0, additionalGroupCount)
  const effectiveAuth = {
    hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
    hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
  }
  const cleanAuth =
    effectiveAuth.hasMoreBefore === undefined && effectiveAuth.hasMoreAfter === undefined ? undefined : effectiveAuth
  const calibrationDefault = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  const desiredNewest = Math.min(getGroupModel().groups.length - 1, currentRange.newestGroupIndex + addedCount)
  const provisionalOldest = currentRange.oldestGroupIndex
  const provisionalNewest = desiredNewest
  const provisionalCount = provisionalNewest - provisionalOldest + 1
  if (provisionalCount > calibrationDefault) {
    const requiredTrim = provisionalCount - calibrationDefault
    const retainedIndex = resolveRetainedGroupIndex(getGroupModel(), options)
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
      getGroupModel(),
      { oldestGroupIndex: boundedOldest, newestGroupIndex: provisionalNewest },
      boundedCapacity,
      currentWindow.edge,
      cleanAuth,
      observability
    )
  }
  const boundedCapacity = clampViewportCapacity(currentWindow.groupCapacity + addedCount)
  const observability: MessageWindow['boundedViewportObservability'] = {
    calibrationDefault,
    boundedCapacity,
    didTrim: false,
    trimmedGroups: 0,
    trimmedEdge: null
  }
  return createWindowFromRange(
    getGroupModel(),
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

export const expandMessageWindowNewer = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean },
  options?: MessageWindowExpansionOptions
): MessageWindow => {
  let groupModel: MessageViewportGroupModel | null = null
  const getGroupModel = (): MessageViewportGroupModel => (groupModel ??= createMessageViewportGroupModel(messages))
  return expandMessageWindowNewerInternal(currentWindow, additionalGroupCount, authoritative, options, getGroupModel)
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

/**
 * Standalone-capable guard that resolves against a caller-owned lazy model.
 * `Messages` preflight calls the public wrapper below against the pre-read
 * projection array; it cannot share a post-fetch paginate derivation's model
 * because the two read different arrays (pre-read vs. merged). Within ONE
 * `derivePaginationWindow` call both read the same array, so the derivation
 * below passes its single shared provider here.
 */
const canAdvancePaginationWindowInternal = (
  input: PaginationWindowGuardInput,
  getGroupModel: PaginationGroupModelProvider
): PaginationWindowGuard => {
  const calibrationDefault = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  const added = Math.max(0, input.additionalGroupCount)
  // Under capacity there is no trim at all: nothing can be unmounted.
  if (input.currentWindow.groupCount + added <= calibrationDefault) return { allowed: true }

  const model = getGroupModel()
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

export const canAdvancePaginationWindow = (input: PaginationWindowGuardInput): PaginationWindowGuard => {
  let groupModel: MessageViewportGroupModel | null = null
  const getGroupModel = (): MessageViewportGroupModel =>
    (groupModel ??= createMessageViewportGroupModel(input.messages))
  return canAdvancePaginationWindowInternal(input, getGroupModel)
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
  // ONE lazy group model for the whole operation: the guard and the
  // expansion below resolve against the same messages array, so they share
  // it. Boundedness and retention are decided BEFORE any derivation: a
  // decline produces no window at all, so the caller cannot publish a
  // half-state — and an under-capacity fast path never built a model at all.
  let groupModel: MessageViewportGroupModel | null = null
  const getGroupModel = (): MessageViewportGroupModel =>
    (groupModel ??= createMessageViewportGroupModel(input.messages))
  const guard = canAdvancePaginationWindowInternal(input, getGroupModel)
  if (!guard.allowed) return { status: 'declined', reason: guard.reason }
  const { direction, currentWindow, additionalGroupCount, responseWindow, retainMessageId } = input
  const options: MessageWindowExpansionOptions = { retainMessageId: retainMessageId ?? null }
  // The older expansion reports explicitly whether it produced the requested
  // paged range or fell back to a newest-capacity rebuild (its rows no longer
  // resolved in the loaded projection). Only the former may carry the committed
  // target marker; a rebuilt latest range is not a browsing target and must keep
  // following the latest groups.
  let window: MessageWindow
  let olderPaged = false
  if (direction === 'older') {
    const expansion = expandOlderWindowInternal(
      currentWindow,
      additionalGroupCount,
      { hasMoreBefore: responseWindow.hasMoreBefore, hasMoreAfter: currentWindow.hasMoreNewer },
      options,
      getGroupModel
    )
    window = expansion.window
    olderPaged = expansion.paged
  } else {
    window = expandMessageWindowNewerInternal(
      currentWindow,
      additionalGroupCount,
      { hasMoreBefore: currentWindow.hasMoreOlder, hasMoreAfter: responseWindow.hasMoreAfter },
      options,
      getGroupModel
    )
  }
  // The committed target marker travels with the window it describes:
  // - growing the OLDER edge is browsing history, so the published range stops
  //   following the latest groups and stays the authoritative target for this
  //   loaded projection (see `reconcileMessageWindow`) — but only when the
  //   expansion really produced that page (`olderPaged`);
  // - growing the NEWER edge keeps an existing marker only while the window has
  //   not reached the latest groups again, so a traversal back to the newest
  //   edge restores ordinary latest-following reconciliation.
  const paginationTarget: true | undefined =
    direction === 'older'
      ? olderPaged
        ? true
        : undefined
      : currentWindow.paginationTarget === true && window.hasMoreNewer !== false
        ? true
        : undefined
  return { status: 'accepted', window: paginationTarget === undefined ? window : { ...window, paginationTarget } }
}

/**
 * The range a window published as an ordinary pagination target, resolved in
 * the CURRENT projection. `null` when the window is not such a target, or when
 * the projection no longer contains its rows (route/topic reload, deletion):
 * the caller then falls back to its ordinary derivation.
 */
const resolvePaginationTargetRange = (
  model: MessageViewportGroupModel,
  currentWindow: MessageWindow
): MessageGroupRange | null =>
  currentWindow.paginationTarget === true ? getRangeFromDisplayMessages(model, currentWindow.displayMessages) : null

/**
 * Whether THIS commit appended rows after the resident tail the committed window
 * was showing.
 *
 * Read only from the previous/current loaded projections plus the committed
 * window — no publisher-specific signal, and no order/membership/capability
 * re-derivation:
 *
 * - the previous loaded tail is still resident (so this commit appended rather
 *   than replaced the route/topic) and the current tail is a different row;
 * - the committed window's NEWEST row is that previous tail, i.e. the window was
 *   parked at the resident edge. A window browsing older history keeps its own
 *   newest row and is therefore never pulled forward by an append elsewhere.
 */
const isAppendedTailCommit = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow
): boolean => {
  const previousTailId = previousMessages.at(-1)?.id ?? null
  if (typeof previousTailId !== 'string' || previousTailId.length === 0) return false
  const currentTailId = messages.at(-1)?.id ?? null
  if (typeof currentTailId !== 'string' || currentTailId.length === 0) return false
  if (currentTailId === previousTailId) return false
  if (!messages.some((message) => message.id === previousTailId)) return false
  return (currentWindow.displayMessages[0]?.id ?? null) === previousTailId
}

/**
 * One follow rule shared by the reconcile and by every caller that must act on
 * the SAME decision in the SAME layout phase (the keeper's bottom semantic
 * before the appended rows mount): the commit appended after the resident tail,
 * the caller measured the exact physical bottom, and the retained row (if any)
 * is not evicted by the newest-capacity range.
 */
const resolveAppendedTailFollow = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow,
  retainedIndex: number | null,
  latestOldest: number,
  options?: MessageWindowExpansionOptions
): boolean =>
  options?.atPhysicalBottom === true &&
  isAppendedTailCommit(messages, previousMessages, currentWindow) &&
  (retainedIndex === null || retainedIndex >= latestOldest)

/**
 * Compatibility: the same appended-tail follow predicate the `reconcile`
 * window-transition intent resolves inside its single-model commit
 * (`resolveAppendedTailFollow` — one rule, no duplicate). Production callers
 * use the reconcile outcome's `followsAppendedTail` verdict instead of
 * calling this separately, so the consequence can never disagree with the
 * derivation.
 */
export const followsAppendedTailCommit = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow,
  options?: MessageWindowExpansionOptions
): boolean => {
  if (options?.atPhysicalBottom !== true) return false
  const boundedCapacity = clampViewportCapacity(currentWindow.groupCapacity)
  if (boundedCapacity === 0) return false
  const model = createMessageViewportGroupModel(messages)
  const retainedIndex = resolveRetainedGroupIndex(model, options)
  const latestOldest = Math.max(0, model.groups.length - boundedCapacity)
  return resolveAppendedTailFollow(messages, previousMessages, currentWindow, retainedIndex, latestOldest, options)
}

/**
 * Refreshes a historical range, or follows the latest edge, at the same group
 * capacity.
 *
 * `options.retainMessageId` is the row the shared viewport keeper currently holds
 * (active interaction region owner, else the live reading anchor). A latest-edge
 * reconcile that would slide the newest-capacity range past it keeps it — and the
 * older context already on screen — resident inside the same bounded capacity,
 * span unmounts the held region, its hold fails closed, and the arriving rows
 * displace the view.
 *
 * A window an ordinary pagination published (`paginationTarget`) is exempt from
 * the latest-edge rebuild: its committed range is the authoritative target for
 * the loaded projection it was derived from, so it is retained (bounded on the
 * newer edge) instead of being replaced before the next traversal. A pagination
 * that reaches the latest groups again drops the marker and restores ordinary
 * latest-following.
 *
 * Boundary retention (same commit, no gesture): a parked pure-tail append —
 * previous projection id-prefix-stable, tail grew, displayed newest is the
 * previous tail, no held reading row — retains the displayed oldest boundary
 * and extends to the new tail instead of re-slicing newest-N, so the loaded
 * old end never drifts on append. Capacity grows with the retained range up
 * to the explicit bound; only then does the bounded trim apply (older edge).
 * A held row suppresses the extension (retention below owns it); reading
 * without a held row is untouched geometrically (growth mounts below the fold).
 *
 * Appended-tail follow (same-route authority commit): when the loaded projection
 * gained rows AFTER the tail the committed window was showing — a tree clipboard
 * paste/replay projection publication, a batch insertion acknowledgment — and the
 * viewport rests at its ACTUAL physical bottom, that commit carries follow
 * intent, so the newest-capacity range is derived in the same commit and the
 * appended rows enter the mounted window without a user gesture and without a
 * command-specific scroll. A committed browsing target is superseded then,
 * exactly like a pagination that reached the latest groups again: returning to
 * the bottom outranks a stale local hold. READING is untouched — no physical
 * bottom, a window that was not at the resident tail, or a held row the
 * newest-capacity range would evict all keep today's derivation, so the anchor
 * never jumps. Geometry stays with the shared keeper: this function never
 * scrolls. Following is a mounted-window decision only — the keeper's pin holds
 * the new bottom against its live row anchor, so the caller that owns the commit
 * must resolve `followsAppendedTailCommit` in the same layout phase and suspend a
 * retained row keeper to the bottom semantic BEFORE the rows mount; that is the
 * only way a pre-existing row anchor (the previous tail an older-page pagination
 * left behind) stops outranking the measured bottom.
 */
/**
 * Whether THIS commit purely appended rows at the resident tail (unified,
 * op-agnostic boundary check): the previous projection's ids form a stable
 * prefix of the current projection in order, and the projection grew. No
 * publisher signal is read, and no reorder/replacement can pass: a reorder or
 * a middle insertion breaks the prefix, a replacement breaks the tail, and a
 * same-size content update (same-group streaming) does not grow.
 */
const isPureTailAppend = (messages: Message[], previousMessages: Message[]): boolean => {
  if (messages.length <= previousMessages.length) return false
  for (let index = 0; index < previousMessages.length; index++) {
    if (messages[index]?.id !== previousMessages[index]?.id) return false
  }
  return true
}

/**
 * Unified boundary-retention expansion for a parked latest-edge window.
 *
 * Same-route pure append with the committed window parked at the resident tail
 * retains the displayed oldest boundary and extends to the new tail instead of
 * re-slicing newest-N: the loaded old end stays mounted, the new tail enters in
 * the same commit, and capacity grows with the retained range (bounded by the
 * calibration default). Only when the retained range itself exceeds the bound
 * does the existing bounded trim apply (older edge; the retained index is null
 * here by construction, so the exact trim applies).
 *
 * One rule, no op-type special-casing: anything that is not a parked pure append
 * (reorder, replacement, middle insertion, deletion, an unparked window) returns
 * null and keeps today's derivation. A held reading row also returns null —
 * retention/follow owns it (reading outranks follow), so the anchor can never
 * be disturbed by an extension.
 */
const expandParkedTailWindow = (
  model: MessageViewportGroupModel,
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow,
  capacity: number,
  cleanAuth: { hasMoreBefore?: boolean; hasMoreAfter?: boolean } | undefined
): MessageWindow | null => {
  if (!isPureTailAppend(messages, previousMessages)) return null
  const previousTailId = previousMessages.at(-1)?.id ?? null
  if (typeof previousTailId !== 'string' || previousTailId.length === 0) return null
  // Parked: the displayed newest row is the previous resident tail.
  if ((currentWindow.displayMessages[0]?.id ?? null) !== previousTailId) return null
  const committed = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!committed) return null
  const lastGroupIndex = model.groups.length - 1
  const oldest = committed.oldestGroupIndex
  const count = lastGroupIndex - oldest + 1
  if (count <= 0) return null
  const calibrationDefault = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  if (count <= calibrationDefault) {
    const boundedCapacity = Math.max(capacity, count)
    // Inherited omission (same convention as createLatest): groups before the
    // retained oldest are resident-but-undisplayed, so local older traversal
    // stays available when store authority is exhausted. Without this the
    // expansion would report hasMoreOlder=false and break older traversal.
    const inheritedOmission = oldest > 0
    return createWindowFromRange(
      model,
      { oldestGroupIndex: oldest, newestGroupIndex: lastGroupIndex },
      boundedCapacity,
      'latest',
      cleanAuth,
      {
        calibrationDefault,
        boundedCapacity,
        didTrim: inheritedOmission,
        trimmedGroups: inheritedOmission ? oldest : 0,
        trimmedEdge: inheritedOmission ? 'older' : null
      }
    )
  }
  const requiredTrim = count - calibrationDefault
  const observability: MessageWindow['boundedViewportObservability'] = {
    calibrationDefault,
    boundedCapacity: calibrationDefault,
    didTrim: true,
    trimmedGroups: requiredTrim,
    trimmedEdge: 'older'
  }
  return createWindowFromRange(
    model,
    { oldestGroupIndex: oldest + requiredTrim, newestGroupIndex: lastGroupIndex },
    calibrationDefault,
    'latest',
    cleanAuth,
    observability
  )
}

/**
 * One reconcile commit, decided once: the window to publish plus whether this
 * same commit follows an appended tail (the keeper-suspend signal). Both come
 * from a single group-model pass below — never a separate follow predicate
 * plus a second reconcile derivation.
 */
export interface ReconciledWindowOutcome {
  window: MessageWindow
  /** True exactly when the keeper must suspend its row hold to the bottom semantic. */
  followsAppendedTail: boolean
}

const reconcileInternal = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow,
  options?: MessageWindowExpansionOptions
): ReconciledWindowOutcome => {
  const rawCapacity = currentWindow.groupCapacity
  const capacity = clampViewportCapacity(rawCapacity)
  const auth =
    currentWindow.authoritativeHasMoreBefore !== undefined || currentWindow.authoritativeHasMoreAfter !== undefined
      ? {
          hasMoreBefore: currentWindow.authoritativeHasMoreBefore,
          hasMoreAfter: currentWindow.authoritativeHasMoreAfter
        }
      : undefined
  const cleanAuth = auth?.hasMoreBefore === undefined && auth?.hasMoreAfter === undefined ? undefined : auth
  const boundedCapacity = clampViewportCapacity(capacity)
  // ONE group model per reconcile, built on first use only: both derivations
  // resolve their range against it and a zero-capacity window never needs it.
  let groupModel: MessageViewportGroupModel | null = null
  const getGroupModel = (): MessageViewportGroupModel => (groupModel ??= createMessageViewportGroupModel(messages))
  const model = boundedCapacity === 0 ? null : getGroupModel()
  const retainedIndex = model ? resolveRetainedGroupIndex(model, options) : null
  const latestOldest = model ? Math.max(0, model.groups.length - boundedCapacity) : 0
  // Follow intent is gated by the SAME retention rule as every latest-edge
  // reconcile: a held row inside the newest-capacity range is not evicted by
  // following, so it never vetoes the commit.
  const followAppendedTail = resolveAppendedTailFollow(
    messages,
    previousMessages,
    currentWindow,
    retainedIndex,
    latestOldest,
    options
  )
  // Single-wrap for every return below: the window and the follow decision of
  // THIS commit, resolved from the same model pass above.
  const reconciled = (window: MessageWindow): ReconciledWindowOutcome => ({
    window,
    followsAppendedTail: followAppendedTail
  })
  if (currentWindow.edge === 'latest' || followAppendedTail) {
    // A published ordinary pagination target stays authoritative for the loaded
    // projection it was derived from: rebuilding the newest-capacity range here
    // would slide the window past the page the user just pulled in — dropping
    // it and re-mounting newer rows far below — so the committed range is
    // retained instead, bounded by the same capacity on the NEWER edge, never
    // grown past what it already committed, and never trimmed under the held
    // row.
    const committedTarget = model && !followAppendedTail ? resolvePaginationTargetRange(model, currentWindow) : null
    if (model && committedTarget) {
      const lastGroupIndex = model.groups.length - 1
      const oldest = Math.min(committedTarget.oldestGroupIndex, lastGroupIndex)
      const capacityNewest = oldest + boundedCapacity - 1
      const newestCeiling = retainedIndex !== null && retainedIndex > capacityNewest ? retainedIndex : capacityNewest
      const newest = Math.max(oldest, Math.min(lastGroupIndex, committedTarget.newestGroupIndex, newestCeiling))
      const trimmedGroups = Math.max(0, lastGroupIndex - newest)
      // The trim is reported honestly (newer edge, exact count), so the newer
      // rows still resident in the projection read as locally traversable and
      // the traversal back to the latest edge stays possible.
      const observability: MessageWindow['boundedViewportObservability'] | undefined =
        trimmedGroups > 0
          ? {
              calibrationDefault: MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
              boundedCapacity,
              didTrim: true,
              trimmedGroups,
              trimmedEdge: 'newer'
            }
          : undefined
      return reconciled({
        ...createWindowFromRange(
          model,
          { oldestGroupIndex: oldest, newestGroupIndex: newest },
          boundedCapacity,
          'latest',
          cleanAuth,
          observability
        ),
        paginationTarget: true
      })
    }
    // Boundary retention: a parked pure-tail append retains the displayed oldest
    // boundary and extends to the new tail (capacity grows bounded) instead of
    // re-slicing newest-N. A held reading row suppresses the extension —
    // retention/follow below owns it — and a committed browsing target was
    // already retained above.
    if (model && !committedTarget && retainedIndex === null) {
      const retainedTail = expandParkedTailWindow(model, messages, previousMessages, currentWindow, capacity, cleanAuth)
      if (retainedTail) return reconciled(retainedTail)
    }
    if (!model || retainedIndex === null || retainedIndex >= latestOldest) {
      return reconciled(createLatestMessageWindow(messages, capacity, cleanAuth))
    }
    // Retention: the newest-capacity range would evict the held row. Keep the
    // older context the current window already shows (never less than the held
    // row) and trim the OPPOSITE (newer) edge by exactly the growth, so the
    // mounted region and the content above it stay put while the window stays
    // inside the same bounded capacity. The trim is reported honestly on the
    // newer edge, which then reads as traversable (`hasMoreNewer`).
    const previousRange = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
    const oldest = Math.max(0, Math.min(retainedIndex, previousRange?.oldestGroupIndex ?? retainedIndex))
    const newest = Math.min(model.groups.length - 1, oldest + boundedCapacity - 1)
    const trimmedGroups = Math.max(0, model.groups.length - 1 - newest)
    const observability: MessageWindow['boundedViewportObservability'] = {
      calibrationDefault: MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
      boundedCapacity,
      didTrim: trimmedGroups > 0,
      trimmedGroups,
      trimmedEdge: 'newer'
    }
    return reconciled(
      createWindowFromRange(
        model,
        { oldestGroupIndex: oldest, newestGroupIndex: newest },
        boundedCapacity,
        'latest',
        cleanAuth,
        observability
      )
    )
  }

  const fixedModel = model ?? getGroupModel()
  // Same id-keyed resolution used by every other derived range (one group-index
  // lookup built once) instead of a linear group scan per displayed message.
  const retainedRange = getRangeFromDisplayMessages(fixedModel, currentWindow.displayMessages)
  if (!retainedRange) {
    const previousRange = currentWindow.range
    // The group builder emits at least one group for every message, so an empty
    // group list is exactly an empty previous projection — no need to build the
    // previous model just to read its group count.
    if (!previousRange || previousMessages.length === 0) {
      return reconciled(createWindowFromRange(fixedModel, null, capacity, 'fixed', cleanAuth))
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
      return reconciled(createWindowFromRange(fixedModel, boundedRange, capacity, 'fixed', cleanAuth, observability))
    }
    return reconciled(createWindowFromRange(fixedModel, boundedRange, capacity, 'fixed', cleanAuth))
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
  const addedNewer = Math.min(fixedModel.groups.length - 1 - newestGroupIndex, missingCount)
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

  return reconciled(
    createWindowFromRange(
      fixedModel,
      { oldestGroupIndex, newestGroupIndex },
      capacity,
      'fixed',
      cleanAuth,
      observability
    )
  )
}
/**
 * Compatibility: the pre-unification reconcile entry. Same mechanism as the
 * `reconcile` window-transition intent (delegates to the single-model
 * implementation); production callers use `applyWindowTransition` so the
 * follow decision and the window come from one commit.
 */
export const reconcileMessageWindow = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow,
  options?: MessageWindowExpansionOptions
): MessageWindow => reconcileInternal(messages, previousMessages, currentWindow, options).window

/**
 * Compatibility: single-commit reconcile that also reports follow intent.
 * Same single-model implementation as the `reconcile` intent below.
 */
export const reconcileWindowWithOutcome = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow,
  options?: MessageWindowExpansionOptions
): ReconciledWindowOutcome => reconcileInternal(messages, previousMessages, currentWindow, options)
/**
 * Send-to-bottom tail reveal: extend the CURRENT window's range to the real
 * tail, pinning the loaded oldest boundary. One group model, same primitives
 * as every other derivation (`getRangeFromDisplayMessages`,
 * `clampViewportCapacity`, `createWindowFromRange`, `resolveAppendedTailFollow`
 * — no parallel mechanism, no new window facts).
 *
 * Why this exists next to `reconcile`: an ordinary reconcile retains a
 * published pagination target and re-slices newest-N at the latest edge, so
 * it can leave a freshly sent tail unmounted; and the send navigation used
 * to rebuild the window from the initial budget (explicit go-latest shape),
 * discarding the expanded range. `append` instead keeps the committed oldest
 * row mounted and grows the newest edge to the tail. The ONLY trim is the
 * hard-cap older-edge trim, exactly like the parked-tail expansion.
 *
 * Stable for a send that fires before the append lands (messages unchanged:
 * the range already ends at the tail, so the window is returned as-is) and
 * for one that fires after (the newest edge grows to the new tail). A
 * browsing range in the middle keeps its oldest too — the send still goes to
 * the physical bottom, it just no longer crushes the loaded old end.
 *
 * Follow verdict: the SAME rule as reconcile (`resolveAppendedTailFollow`),
 * with the committed display rows as their own previous edge (newest-first
 * storage reversed to chronological order — an existing window fact, never a
 * new one). It answers "the projection grew past the committed newest and
 * the committed newest is still resident", which is exactly the send's tail
 * case; the keeper suspension itself stays with the send transaction's
 * explicit bottom adoption.
 */
const appendTailWindow = (
  messages: Message[],
  currentWindow: MessageWindow,
  options?: MessageWindowExpansionOptions
): ReconciledWindowOutcome => {
  const model = createMessageViewportGroupModel(messages)
  const auth =
    currentWindow.authoritativeHasMoreBefore !== undefined || currentWindow.authoritativeHasMoreAfter !== undefined
      ? {
          hasMoreBefore: currentWindow.authoritativeHasMoreBefore,
          hasMoreAfter: currentWindow.authoritativeHasMoreAfter
        }
      : undefined
  const cleanAuth = auth?.hasMoreBefore === undefined && auth?.hasMoreAfter === undefined ? undefined : auth
  const capacity = clampViewportCapacity(currentWindow.groupCapacity)
  const fallback = (): ReconciledWindowOutcome => ({
    window: createLatestMessageWindow(messages, capacity, cleanAuth),
    followsAppendedTail: false
  })
  if (model.groups.length === 0 || capacity === 0) return fallback()
  const committed = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!committed) return fallback()
  const lastGroupIndex = model.groups.length - 1
  const oldest = committed.oldestGroupIndex
  const count = lastGroupIndex - oldest + 1
  if (count <= 0) return fallback()
  const hardcap = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
  const retainedIndex = resolveRetainedGroupIndex(model, options)
  // Committed display rows (newest-first) as their own previous edge, in
  // chronological order: the same follow rule, no duplicate predicate.
  const committedChronological = currentWindow.displayMessages.slice().reverse()
  const followAppendedTail = resolveAppendedTailFollow(
    messages,
    committedChronological,
    currentWindow,
    retainedIndex,
    Math.max(0, model.groups.length - Math.max(capacity, Math.min(count, hardcap))),
    options
  )
  if (count <= hardcap) {
    const boundedCapacity = Math.max(capacity, count)
    // Inherited omission (same convention as the parked-tail expansion):
    // groups before the retained oldest are resident-but-undisplayed, so
    // local older traversal stays available.
    const inheritedOmission = oldest > 0
    return {
      window: createWindowFromRange(
        model,
        { oldestGroupIndex: oldest, newestGroupIndex: lastGroupIndex },
        boundedCapacity,
        'latest',
        cleanAuth,
        {
          calibrationDefault: hardcap,
          boundedCapacity,
          didTrim: inheritedOmission,
          trimmedGroups: inheritedOmission ? oldest : 0,
          trimmedEdge: inheritedOmission ? 'older' : null
        }
      ),
      followsAppendedTail: followAppendedTail
    }
  }
  const requiredTrim = count - hardcap
  return {
    window: createWindowFromRange(
      model,
      { oldestGroupIndex: oldest + requiredTrim, newestGroupIndex: lastGroupIndex },
      hardcap,
      'latest',
      cleanAuth,
      {
        calibrationDefault: hardcap,
        boundedCapacity: hardcap,
        didTrim: true,
        trimmedGroups: requiredTrim,
        trimmedEdge: 'older'
      }
    ),
    followsAppendedTail: followAppendedTail
  }
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
/**
 * Unified window transition: the single typed entry for every viewport-window
 * derivation. Each intent delegates to the same pure constructors below (no
 * parallel logic); the legacy named exports stay as thin compatibility
 * delegates of that same mechanism.
 *
 * Boundary vocabulary stays distinct on purpose and is never merged:
 * - `budget` is the INITIAL display budget (Redux `displayCount`, 10 groups).
 *   Only `initial` (first load) and `latest` (explicit go-latest/reset) carry
 *   it. `reconcile` carries no budget: it keeps the CURRENT visible range's
 *   capacity. `append` carries no budget either: it keeps the CURRENT window's
 *   oldest boundary and extends to the real tail — a send-to-bottom never
 *   re-slices the newest-N budget the way an explicit go-latest does.
 * - The hard viewport bound (200 groups) lives only in
 *   `clampViewportCapacity`; pagination page size (20), navigation quotas
 *   (older 10 / newer 19) and the window-request clamp (1..100) live with
 *   their own callers and are passed through untouched.
 * - Group identity comes from the route (never the viewport); authority
 *   flags are carried verbatim, never derived from viewport geometry.
 */
export type WindowTransitionAuthority = { hasMoreBefore?: boolean; hasMoreAfter?: boolean }

export type WindowTransitionIntent =
  | { kind: 'initial'; messages: Message[]; budget: number; authoritative?: WindowTransitionAuthority }
  | { kind: 'latest'; messages: Message[]; budget: number; authoritative?: WindowTransitionAuthority }
  | { kind: 'top'; messages: Message[]; budget: number; authoritative?: WindowTransitionAuthority }
  | {
      kind: 'target'
      messages: Message[]
      targetId: string
      older: number
      newer: number
      authoritative?: WindowTransitionAuthority
    }
  | {
      kind: 'restore'
      loaded: Message[]
      anchors: readonly (string | null | undefined)[]
      older: number
      newer: number
      authoritative?: { hasMoreBefore: boolean; hasMoreAfter: boolean }
    }
  | {
      kind: 'reconcile'
      messages: Message[]
      previousMessages: Message[]
      currentWindow: MessageWindow
      options?: MessageWindowExpansionOptions
    }
  | {
      kind: 'append'
      messages: Message[]
      currentWindow: MessageWindow
      options?: MessageWindowExpansionOptions
    }
  | {
      kind: 'paginate'
      direction: 'older' | 'newer'
      messages: Message[]
      currentWindow: MessageWindow
      additionalGroupCount: number
      responseWindow: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
      retainMessageId?: string | null
    }

export type WindowTransitionOutcome =
  | { kind: 'window'; window: MessageWindow }
  | { kind: 'reconciled'; window: MessageWindow; followsAppendedTail: boolean }
  | { kind: 'paginated'; transition: PaginationWindowTransition }
  | { kind: 'restored'; window: MessageWindow | null; empty: boolean }

/**
 * Single typed entry for every viewport-window derivation. One group model
 * per transition at most; the `reconcile` and `append` branches return the
 * window and its follow decision from the SAME single-model commit (no
 * repeated predicate, no second derivation).
 */
export const applyWindowTransition = (intent: WindowTransitionIntent): WindowTransitionOutcome => {
  switch (intent.kind) {
    case 'initial':
    case 'latest':
      return { kind: 'window', window: createLatestMessageWindow(intent.messages, intent.budget, intent.authoritative) }
    case 'top':
      return { kind: 'window', window: createOldestMessageWindow(intent.messages, intent.budget, intent.authoritative) }
    case 'target':
      return {
        kind: 'window',
        window: createTargetMessageWindow(
          intent.messages,
          intent.targetId,
          intent.older,
          intent.newer,
          intent.authoritative
        )
      }
    case 'restore': {
      const restored = buildRouteViewport(
        intent.loaded,
        intent.anchors,
        intent.authoritative,
        intent.older,
        intent.newer
      )
      return { kind: 'restored', window: restored.window, empty: restored.empty }
    }
    case 'reconcile': {
      const outcome = reconcileInternal(intent.messages, intent.previousMessages, intent.currentWindow, intent.options)
      return { kind: 'reconciled', window: outcome.window, followsAppendedTail: outcome.followsAppendedTail }
    }
    case 'append': {
      const appended = appendTailWindow(intent.messages, intent.currentWindow, intent.options)
      return { kind: 'reconciled', window: appended.window, followsAppendedTail: appended.followsAppendedTail }
    }
    case 'paginate': {
      const transition = derivePaginationWindow({
        direction: intent.direction,
        messages: intent.messages,
        currentWindow: intent.currentWindow,
        additionalGroupCount: intent.additionalGroupCount,
        responseWindow: intent.responseWindow,
        retainMessageId: intent.retainMessageId
      })
      return { kind: 'paginated', transition }
    }
  }
}
