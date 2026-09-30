import type { Message } from '@renderer/types/newMessage'

import { MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT, type MessageWindow } from './messageWindow'

/**
 * Route overlap visible incremental rebase (pure planning, no DOM, no React).
 *
 * Shared materializer for divider + top route switches: when the stable
 * anchor is resident in the current window AND in the authoritative target
 * route projection, the current resident shared messages through the anchor
 * stay mounted (same React keys, same order, same object identities) while
 * only the outgoing foreign suffix leaves and the target exclusive suffix
 * mounts. The container never empties and never hides.
 *
 * Fork-aligned route semantics (no identical window heads required): partial
 * around windows legitimately start at different heads (e.g. current display
 * `[m0..m15, branchSuffix]` vs target around-window `[m5..m29]` with anchor
 * `m15` resident in both). The preserved chain is the current resident prefix
 * through the anchor — it may begin earlier than the target around-window —
 * and it is verified continuous against the authoritative full target route
 * projection (the windowed `fetchMessagesWindow` response order): every
 * preserved position overlapping the response must match exactly, the anchor
 * must sit at the same relative offset in all three lists, the outgoing
 * post-anchor suffix must be fully foreign to the response, and the appended
 * post-anchor suffix must come from the target window in authoritative order
 * and be fully foreign to the current window. Soundness rests on branch
 * construction: pre-anchor trunk is route-shared, so a continuous
 * overlap-verified chain through the anchor is the target route's trunk.
 *
 * Fail-closed contract (any violation → null, caller takes the existing
 * hidden path unchanged): missing anchor, disjoint/malformed lists, unstable
 * (empty/duplicate) IDs, interleaved order, outgoing suffix present in the
 * target projection, incoming suffix present in the current window, target
 * window not a subsequence of the response, or empty incoming suffix.
 *
 * Capability semantics: the built union keeps the preserved current side's
 * older boundary and the target side's newer boundary (`hasMoreBefore` from
 * current, `hasMoreAfter` from target) — truthful because the union's older
 * edge IS the preserved current edge and its newer edge IS the target window
 * edge. Any other existing capability semantics ride unchanged through the
 * standard window constructors. No second route/window truth is created here:
 * the caller still commits via the single `RouteViewportController` entry and
 * the single viewport reducer.
 */

export interface RouteVisibleRebasePlan {
  /** Preserved current-resident prefix through the anchor, oldest-first (stays mounted). */
  sharedPrefixIds: string[]
  /** Outgoing foreign suffix, oldest-first (unmounts). */
  outgoingIds: string[]
  /** Target exclusive suffix from the target window, oldest-first in authoritative order (mounts). */
  incomingIds: string[]
  /** Next resident order, oldest-first (preserved prefix + incoming suffix). */
  nextOldestFirst: string[]
  /** Index of the anchor inside the union (equals its index in the current list). */
  anchorIndex: number
  /** Older boundary from the preserved current side. */
  hasMoreBefore: boolean
  /** Newer boundary from the target side. */
  hasMoreAfter: boolean
}

export interface RouteVisibleRebaseInput {
  /** Current window display IDs, oldest-first (derived from displayMessages). */
  currentIdsOldestFirst: readonly string[]
  /**
   * Authoritative full target route projection, oldest-first (the windowed
   * `fetchMessagesWindow` response order — the complete authority the
   * renderer holds for the target route, as opposed to the display subset).
   */
  targetResponseIdsOldestFirst: readonly string[]
  /** Target display window IDs, oldest-first (the render subset to append from). */
  targetWindowIdsOldestFirst: readonly string[]
  /** Stable anchor message ID shared by both routes (fork anchor or saved top anchor). */
  anchorId: string
  /** Older boundary of the preserved current side. */
  currentHasMoreBefore: boolean
  /** Newer boundary of the target side. */
  targetHasMoreAfter: boolean
}

const isStableId = (id: unknown): id is string => typeof id === 'string' && id.length > 0

const hasDuplicates = (ids: readonly string[]): boolean => new Set(ids).size !== ids.length

/**
 * Pure eligibility + planning. Returns null on ANY violation (fail closed).
 */
export const planRouteVisibleRebase = (input: RouteVisibleRebaseInput): RouteVisibleRebasePlan | null => {
  const { currentIdsOldestFirst, targetResponseIdsOldestFirst, targetWindowIdsOldestFirst, anchorId } = input
  if (!isStableId(anchorId)) return null
  if (
    !Array.isArray(currentIdsOldestFirst) ||
    !Array.isArray(targetResponseIdsOldestFirst) ||
    !Array.isArray(targetWindowIdsOldestFirst)
  ) {
    return null
  }
  if (
    currentIdsOldestFirst.length === 0 ||
    targetResponseIdsOldestFirst.length === 0 ||
    targetWindowIdsOldestFirst.length === 0
  ) {
    return null
  }
  if (typeof input.currentHasMoreBefore !== 'boolean' || typeof input.targetHasMoreAfter !== 'boolean') return null
  if (
    !currentIdsOldestFirst.every(isStableId) ||
    !targetResponseIdsOldestFirst.every(isStableId) ||
    !targetWindowIdsOldestFirst.every(isStableId)
  ) {
    return null
  }
  if (
    hasDuplicates(currentIdsOldestFirst) ||
    hasDuplicates(targetResponseIdsOldestFirst) ||
    hasDuplicates(targetWindowIdsOldestFirst)
  ) {
    return null
  }

  const current = [...currentIdsOldestFirst]
  const response = [...targetResponseIdsOldestFirst]
  const targetWindow = [...targetWindowIdsOldestFirst]
  const cAnchor = current.indexOf(anchorId)
  const rAnchor = response.indexOf(anchorId)
  const wAnchor = targetWindow.indexOf(anchorId)
  if (cAnchor < 0 || rAnchor < 0 || wAnchor < 0) return null

  // The target window must be an order-preserving subsequence of the
  // authoritative response (malformed windows fail closed).
  const responseIndexById = new Map<string, number>()
  for (let i = 0; i < response.length; i++) {
    if (!responseIndexById.has(response[i])) responseIndexById.set(response[i], i)
  }
  let prevResponseIndex = -1
  for (const id of targetWindow) {
    const ri = responseIndexById.get(id)
    if (ri === undefined || ri <= prevResponseIndex) return null
    prevResponseIndex = ri
  }

  // Overlap agreement: every preserved position overlapping the response must
  // match exactly (continuous chain, no interleave). Positions older than the
  // response head are preserved resident (the union may begin earlier).
  for (let i = 0; i <= cAnchor; i++) {
    const j = rAnchor - (cAnchor - i)
    if (j < 0) continue
    if (current[i] !== response[j]) return null
  }

  // Outgoing post-anchor suffix must be fully foreign to the target projection.
  const responseSet = new Set(response)
  const outgoingIds = current.slice(cAnchor + 1)
  for (const id of outgoingIds) {
    if (responseSet.has(id)) return null
  }

  // Incoming post-anchor suffix comes from the target window in authoritative
  // order and must be fully foreign to the current window.
  const currentSet = new Set(current)
  const incomingIds = targetWindow.slice(wAnchor + 1)
  if (incomingIds.length === 0) return null
  for (const id of incomingIds) {
    if (currentSet.has(id)) return null
  }

  const sharedPrefixIds = current.slice(0, cAnchor + 1)
  return {
    sharedPrefixIds,
    outgoingIds,
    incomingIds,
    nextOldestFirst: [...sharedPrefixIds, ...incomingIds],
    anchorIndex: cAnchor,
    hasMoreBefore: input.currentHasMoreBefore,
    hasMoreAfter: input.targetHasMoreAfter
  }
}

/**
 * Top-only eligibility: the saved anchor must lie in the shared resident
 * segment AND in this topic's loaded projection (not merely elsewhere in
 * Redux). No clamp to nearby/end/bottom: a missing anchor fails closed to the
 * existing hidden atomic restore. `loadedIds` is the current topic's loaded
 * projection ID set.
 */
export const planTopVisibleRebase = (
  input: RouteVisibleRebaseInput & { loadedIds: ReadonlySet<string> }
): RouteVisibleRebasePlan | null => {
  if (!input.loadedIds.has(input.anchorId)) return null
  return planRouteVisibleRebase(input)
}

/**
 * Fail-closed union gate (pure, no DOM, no React).
 *
 * The built visible window must represent every planned ID exactly before the
 * visible apply: no bounded-viewport trim, no duplicates/missing IDs, group
 * count/capacity consistent, and hasMore flags truthful to the plan. Any
 * mismatch returns false so the caller skips the visible path and runs the
 * existing hidden atomic path unchanged. Capacity/trim truth comes from the
 * exported `messageWindow` calibration + the window's own
 * `boundedViewportObservability` — never a hardcoded second cap.
 */
export const isRouteVisibleUnionExact = (args: {
  plan: RouteVisibleRebasePlan
  unionOldestFirst: readonly Message[]
  unionNewestFirst: readonly Message[]
  unionWindow: MessageWindow
  unionModelGroupCount: number
}): boolean => {
  const { plan, unionOldestFirst, unionNewestFirst, unionWindow, unionModelGroupCount } = args
  if (!plan || !Array.isArray(plan.nextOldestFirst) || plan.nextOldestFirst.length === 0) return false
  if (!Array.isArray(unionOldestFirst) || !Array.isArray(unionNewestFirst)) return false
  const unionIdsOldestFirst = unionOldestFirst.map((m) => m?.id)
  const displayOldestFirst = [...(unionWindow.displayMessages ?? [])].reverse().map((m) => m?.id)
  if (
    unionNewestFirst.length !== plan.nextOldestFirst.length ||
    unionIdsOldestFirst.length !== plan.nextOldestFirst.length ||
    displayOldestFirst.length !== plan.nextOldestFirst.length
  ) {
    return false
  }
  for (let i = 0; i < plan.nextOldestFirst.length; i++) {
    if (unionIdsOldestFirst[i] !== plan.nextOldestFirst[i]) return false
    if (displayOldestFirst[i] !== plan.nextOldestFirst[i]) return false
  }
  if (new Set(displayOldestFirst).size !== displayOldestFirst.length) return false
  const obs = unionWindow.boundedViewportObservability
  if (obs?.didTrim === true) return false
  if (obs && obs.calibrationDefault !== MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT) return false
  if ((obs?.boundedCapacity ?? 0) > MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT) return false
  if (unionWindow.groupCount !== unionWindow.displayGroups.length) return false
  if (unionWindow.displayGroups.length !== unionModelGroupCount) return false
  if (unionWindow.groupCapacity < unionWindow.groupCount) return false
  if (unionWindow.groupCapacity > MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT) return false
  if (unionWindow.hasMoreOlder !== plan.hasMoreBefore) return false
  if (unionWindow.hasMoreNewer !== plan.hasMoreAfter) return false
  return true
}

/**
 * Build the next display message list reusing existing resident objects for
 * the preserved prefix where possible (same stable ID → same reference, so
 * React keeps the mounted DOM nodes). The appended suffix objects come from
 * the authoritative target list. Order is exactly the planned union order
 * (oldest-first input → newest-first output to match
 * `MessageWindow.displayMessages`).
 *
 * Pure, no store access. Falls back to target objects when a preserved ID has
 * no resident instance (still same React key, still mounted).
 */
export const buildRouteVisibleMessages = (
  currentNewestFirst: readonly Message[],
  targetOldestFirst: readonly Message[],
  plan: RouteVisibleRebasePlan
): Message[] => {
  const residentById = new Map<string, Message>()
  for (const m of currentNewestFirst) {
    if (m && typeof m.id === 'string' && !residentById.has(m.id)) residentById.set(m.id, m)
  }
  const targetById = new Map<string, Message>()
  for (const m of targetOldestFirst) {
    if (m && typeof m.id === 'string' && !targetById.has(m.id)) targetById.set(m.id, m)
  }
  const sharedSet = new Set(plan.sharedPrefixIds)
  const nextOldestFirst: Message[] = []
  for (const id of plan.nextOldestFirst) {
    const reused = residentById.get(id)
    if (reused && sharedSet.has(id)) {
      nextOldestFirst.push(reused)
      continue
    }
    const authoritative = targetById.get(id)
    if (authoritative) {
      nextOldestFirst.push(authoritative)
      continue
    }
    // Fail-closed at the object layer should never happen when the plan was
    // built from these same ID lists; keep the resident when available.
    if (reused) nextOldestFirst.push(reused)
  }
  // displayMessages order is newest-first.
  return nextOldestFirst.toReversed()
}
