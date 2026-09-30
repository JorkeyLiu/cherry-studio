import type { Message } from '@renderer/types/newMessage'

import type { MessageWindow } from './messageWindow'
import {
  buildRouteVisibleMessages,
  isRouteVisibleUnionExact,
  planRouteVisibleRebase,
  type RouteVisibleRebasePlan
} from './routeOverlapRebase'

/**
 * Divider-only visible incremental rebase (pure planning, no DOM, no React).
 *
 * Thin fork-named wrapper over the shared route-overlap materializer
 * (`routeOverlapRebase`): the preserved chain is the current resident prefix
 * through the fork, verified continuous against the authoritative target
 * route projection. See that module for the full fail-closed contract and
 * capability semantics. No second route/window truth is created here: the
 * caller still commits via the single `RouteViewportController` entry and the
 * single viewport reducer.
 */

export interface DividerVisibleRebasePlan {
  /** Preserved current-resident prefix through the fork, oldest-first (stays mounted). */
  sharedPrefixIds: string[]
  /** Outgoing foreign suffix, oldest-first (unmounts). */
  outgoingIds: string[]
  /** Target exclusive suffix from the target window, oldest-first in authoritative order (mounts). */
  incomingIds: string[]
  /** Next resident order, oldest-first (preserved prefix + incoming suffix). */
  nextOldestFirst: string[]
  /** Index of the fork anchor inside the union (equals its index in the current list). */
  forkIndex: number
  /** Older boundary from the preserved current side. */
  hasMoreBefore: boolean
  /** Newer boundary from the target side. */
  hasMoreAfter: boolean
}

export interface DividerVisibleRebaseInput {
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
  /** Fork anchor message ID (stable ID shared by both routes). */
  forkAnchorId: string
  /** Older boundary of the preserved current side. */
  currentHasMoreBefore: boolean
  /** Newer boundary of the target side. */
  targetHasMoreAfter: boolean
}

const toSharedPlan = (plan: RouteVisibleRebasePlan): DividerVisibleRebasePlan => ({
  sharedPrefixIds: plan.sharedPrefixIds,
  outgoingIds: plan.outgoingIds,
  incomingIds: plan.incomingIds,
  nextOldestFirst: plan.nextOldestFirst,
  forkIndex: plan.anchorIndex,
  hasMoreBefore: plan.hasMoreBefore,
  hasMoreAfter: plan.hasMoreAfter
})

/**
 * Pure eligibility + planning. Returns null on ANY violation (fail closed).
 */
export const planDividerVisibleRebase = (input: DividerVisibleRebaseInput): DividerVisibleRebasePlan | null => {
  const shared = planRouteVisibleRebase({
    currentIdsOldestFirst: input.currentIdsOldestFirst,
    targetResponseIdsOldestFirst: input.targetResponseIdsOldestFirst,
    targetWindowIdsOldestFirst: input.targetWindowIdsOldestFirst,
    anchorId: input.forkAnchorId,
    currentHasMoreBefore: input.currentHasMoreBefore,
    targetHasMoreAfter: input.targetHasMoreAfter
  })
  if (!shared) return null
  return toSharedPlan(shared)
}

/**
 * Fail-closed union gate (pure, no DOM, no React).
 *
 * The built visible window must represent every planned ID exactly before the
 * visible apply: no bounded-viewport trim, no duplicates/missing IDs, group
 * count/capacity consistent, and hasMore flags truthful to the plan. Any
 * mismatch returns false so the caller skips the visible path and runs the
 * existing hidden `commitRouteWindowAtomic` unchanged. Capacity/trim truth
 * comes from the exported `messageWindow` calibration + the window's own
 * `boundedViewportObservability` — never a hardcoded second cap.
 */
export const isDividerVisibleUnionExact = (args: {
  plan: DividerVisibleRebasePlan
  unionOldestFirst: readonly Message[]
  unionNewestFirst: readonly Message[]
  unionWindow: MessageWindow
  unionModelGroupCount: number
}): boolean => {
  return isRouteVisibleUnionExact({
    plan: {
      sharedPrefixIds: args.plan.sharedPrefixIds,
      outgoingIds: args.plan.outgoingIds,
      incomingIds: args.plan.incomingIds,
      nextOldestFirst: args.plan.nextOldestFirst,
      anchorIndex: args.plan.forkIndex,
      hasMoreBefore: args.plan.hasMoreBefore,
      hasMoreAfter: args.plan.hasMoreAfter
    },
    unionOldestFirst: args.unionOldestFirst,
    unionNewestFirst: args.unionNewestFirst,
    unionWindow: args.unionWindow,
    unionModelGroupCount: args.unionModelGroupCount
  })
}

/**
 * Visible-pending identity carried from the synchronous visible commit to the
 * layout alignment step (stable IDs + captured offsets only, never geometry).
 */
export interface DividerVisiblePending {
  ownerEpoch: number
  topicId: string
  routeId: string | null
  dividerKey: string
  anchorMessageId: string
  parentOfDivider: string | null
  sharedMessageId: string | null
  sharedOffset: number | null
  wantOffset: number
}

/**
 * Existing hidden divider-search progress shape (mirrors the Messages owner
 * record; defined here so the visible→search conversion is unit-testable
 * without importing the component).
 */
export interface DividerRestoreSearchProgress {
  ownerEpoch: number
  topicId: string
  routeId: string | null
  dividerKey: string
  anchorMessageId: string
  parentOfDivider: string | null
  sharedMessageId: string | null
  sharedOffset: number | null
  wantOffset: number | null
  pagesDriven: number
  lastLoadFailed: boolean
  drivenWindowKey: string | null
}

/**
 * Pure visible→search conversion for the post-apply lost-residency fallback.
 * Returns the hidden-search progress the existing coordinator owns from here
 * (restore-owned pagination from window/hasMoreOlder/anchor-residency state),
 * or null when the pending identity cannot seed a search (fail closed — the
 * caller terminates visible with no commit instead). Never commits, never
 * writes geometry: the search aligns + quiets + commits only after the
 * requested identity is resident.
 */
export const buildDividerSearchProgressFromVisible = (
  pending: DividerVisiblePending
): DividerRestoreSearchProgress | null => {
  if (!pending || typeof pending.dividerKey !== 'string' || pending.dividerKey.length === 0) return null
  if (typeof pending.anchorMessageId !== 'string' || pending.anchorMessageId.length === 0) return null
  if (typeof pending.ownerEpoch !== 'number' || !Number.isFinite(pending.ownerEpoch)) return null
  if (typeof pending.topicId !== 'string' || pending.topicId.length === 0) return null
  if (typeof pending.wantOffset !== 'number' || !Number.isFinite(pending.wantOffset)) return null
  return {
    ownerEpoch: pending.ownerEpoch,
    topicId: pending.topicId,
    routeId: pending.routeId,
    dividerKey: pending.dividerKey,
    anchorMessageId: pending.anchorMessageId,
    parentOfDivider: pending.parentOfDivider,
    sharedMessageId: pending.sharedMessageId,
    sharedOffset: pending.sharedOffset,
    wantOffset: pending.wantOffset,
    pagesDriven: 0,
    lastLoadFailed: false,
    drivenWindowKey: null
  }
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
export const buildDividerVisibleMessages = (
  currentNewestFirst: readonly Message[],
  targetOldestFirst: readonly Message[],
  plan: DividerVisibleRebasePlan
): Message[] => {
  return buildRouteVisibleMessages(currentNewestFirst, targetOldestFirst, {
    sharedPrefixIds: plan.sharedPrefixIds,
    outgoingIds: plan.outgoingIds,
    incomingIds: plan.incomingIds,
    nextOldestFirst: plan.nextOldestFirst,
    anchorIndex: plan.forkIndex,
    hasMoreBefore: plan.hasMoreBefore,
    hasMoreAfter: plan.hasMoreAfter
  })
}
