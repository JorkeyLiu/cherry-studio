import type { TopicBranchWire } from '@renderer/services/db/types'
import type { Message } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { HistoryReferenceMeta } from '@shared/chatDb'
import type { ReactNode } from 'react'

import { takenChildAtAnchor } from './BranchDividers'
import { groupForkChildrenByParent, resolveForkPlacement } from './forkPlacement'
import { deriveTurnAskId, type FlowNode } from './messageEditSelectionLayout'
import { deriveStableGroupId, type RenderLayer } from './messageRenderLayers'
import type { MessageViewportProjectedGroup } from './messageViewportProjection'

/**
 * Production mounted message-flow builder (extracted verbatim from
 * `MessagesContent.renderMessageSegments`).
 *
 * The builder owns the exact production mapping — group iteration order
 * (newest→oldest under column-reverse), fork-divider placement (DOM-before
 * the anchor group), context-divider placement (DOM-after the anchor group),
 * stable group identity, turn askIds, selection flags, and layer identity —
 * while the React pixels (message body, fork row, context row) are supplied
 * by the caller through narrow render injectors. `Messages.tsx` passes the
 * real injectors; tests pass lightweight probes that preserve the identity
 * attributes, so executing this builder (not a re-implementation) plus
 * `renderEditFlowNodes` proves the real production flow wiring.
 */

/** One fork divider resolved against the current display window. */
export interface ForkDividerPlacement {
  /** Stable relation identity (the branch anchor), never a message target. */
  anchorMessageId: string
  /** Parent route of the fork's children (null = main route). */
  parentBranchId: string | null
  /** Direct child branches of this fork (flat peer set, deterministic order). */
  children: TopicBranchWire[]
  /**
   * `'message'`: the divider renders under `boundaryMessageId`, the last
   * inherited message Main reports. `'head'`: the fork inherits nothing, so it
   * renders at the history head of `parentBranchId`.
   */
  placement: 'message' | 'head'
  /** Resident message the divider renders under (null for a head boundary). */
  boundaryMessageId: string | null
}

/**
 * Resolve the fork dividers of one display window from the Main-authoritative
 * inheritance boundary of each branch.
 *
 * A branch and its fork divider are an inheritance relation, so the divider is
 * NOT conditioned on prefix rows existing:
 * - `'message'` boundary → place only while that message is resident. An older
 *   page that is not loaded yet keeps the divider offscreen; pagination never
 *   promotes it to the head.
 * - `'head'` boundary → the branch inherits nothing, so its fork sits at the
 *   absolute history head of its own parent route. The head is a relation
 *   position, not a row: it renders at the visual beginning of the flow, which
 *   is authoritative only while the window provably reaches the true history
 *   head (`historyHeadLoaded`, from the window's authoritative
 *   `hasMoreBefore === false`). While an older page is unloaded the head is
 *   offscreen and NO head divider is emitted — the first loaded row is never
 *   used to guess it.
 * - The head fork belongs to every route the relation actually addresses: the
 *   parent route itself (`activeBranchId === parentBranchId`) and any route
 *   descending through one of the fork's direct children (`activeRoutePath`),
 *   so selecting such a child keeps the head control reachable to switch back.
 *   An unrelated route (a fork elsewhere in the tree) never shows it.
 * - Unknown boundary (a wire captured before the fact existed) → fall back to
 *   the anchor row being resident, exactly the pre-existing placement. Never
 *   the head: absence of the fact is not evidence of an empty prefix.
 */
export function resolveForkDividers(input: {
  displayMessageIds: ReadonlySet<string>
  childrenByAnchor: ReadonlyMap<string, readonly TopicBranchWire[]>
  activeBranchId: string | null
  /** Root-first active route chain (branch ids). Absent = `activeBranchId` only. */
  activeRoutePath?: readonly string[]
  /**
   * The displayed window provably contains the true history head (Main
   * reported no older page for this route). Absent/false = unknown → no head.
   */
  historyHeadLoaded?: boolean
}): ForkDividerPlacement[] {
  const out: ForkDividerPlacement[] = []
  // Branch ids of the viewed route: the active branch plus its ancestors.
  const routeBranchIds = new Set<string>(input.activeRoutePath ?? [])
  if (input.activeBranchId !== null) routeBranchIds.add(input.activeBranchId)
  for (const [anchorMessageId, children] of input.childrenByAnchor) {
    for (const group of groupForkChildrenByParent(children)) {
      const { placement, boundaryMessageId } = resolveForkPlacement(group.children, anchorMessageId)
      const base = { anchorMessageId, parentBranchId: group.parentBranchId, children: group.children }
      if (placement === 'head') {
        // Two independent facts must both hold: the fork relation addresses
        // the viewed route, and the viewed window reaches the true head.
        const relationOnRoute =
          group.parentBranchId === input.activeBranchId || group.children.some((c) => routeBranchIds.has(c.id))
        if (relationOnRoute && input.historyHeadLoaded === true) {
          out.push({ ...base, placement: 'head', boundaryMessageId: null })
        }
        continue
      }
      if (boundaryMessageId !== null && input.displayMessageIds.has(boundaryMessageId)) {
        out.push({ ...base, placement: 'message', boundaryMessageId })
      }
    }
  }
  return out.sort(
    (a, b) =>
      (a.children[0]?.createdAt ?? '').localeCompare(b.children[0]?.createdAt ?? '') ||
      a.anchorMessageId.localeCompare(b.anchorMessageId) ||
      (a.parentBranchId ?? '').localeCompare(b.parentBranchId ?? '')
  )
}

/**
 * Context window boundary: find the legacy projected group key where the
 * boundary message renders. The legacy key is retained for context-divider
 * semantics while stable entity-derived keys are used for React
 * reconciliation. Returns null when there is no boundary message or it is
 * not in the current display window (no divider shown).
 */
export function resolveContextDividerGroupKey(
  groupedMessages: readonly MessageViewportProjectedGroup[],
  contextBoundaryMessageId: string | null
): string | null {
  if (!contextBoundaryMessageId) return null
  for (const [key, groupMessages] of groupedMessages) {
    if (groupMessages.some((m) => m.id === contextBoundaryMessageId)) {
      return key
    }
  }
  // Boundary message not in the current display window — don't show a divider
  return null
}

/**
 * History-reference divider placement (stable, non-arbitrary). The divider
 * marks the boundary between the read-only foreign prefix and the target-owned
 * writable suffix.
 *
 * Priority:
 * 1. `status: 'missing'` → the prefix is absent, so the divider marks where the
 *    reference would begin: the loaded beginning (top).
 * 2. `boundaryMessageId` resident in the projected groups → place directly
 *    after that group (the authoritative Main-reported boundary).
 * 3. Boundary outside the loaded window → derive the transition from the
 *    loaded ownership order, never a guessed boundary. The foreign readonly
 *    prefix precedes the target-owned suffix in oldest→newest order, so the
 *    divider belongs after the LAST foreign-owned group — the first
 *    foreign-owned group encountered scanning newest→oldest. Foreign/target
 *    ownership is compared against `targetTopicId` (never a single
 *    `sourceTopicId`): recursive references keep their own canonical
 *    grand-source topicIds, so a `sourceTopicId` scan would miss them.
 *
 *    The fallback is admitted ONLY when a real foreign→target-owned transition
 *    is demonstrable in the loaded window: the immediately newer neighbor of
 *    that foreign group must be target-owned. When the loaded window contains
 *    foreign groups but NO target-owned successor the boundary is offscreen
 *    (the window is a slice of the readonly prefix alone), so the divider is
 *    DEFERRED (null) until the boundary is loaded — never misplaced inside the
 *    prefix. A window with no foreign message at all keeps the
 *    missing/no-prefix beginning placement.
 */
export interface ReferenceBoundary {
  groupKey: string | null
  placement: 'after-boundary' | 'beginning'
}

export function resolveReferenceBoundary(
  groupedMessages: readonly MessageViewportProjectedGroup[],
  reference:
    | { sourceTopicId: string; status: 'available' | 'missing'; boundaryMessageId: string | null }
    | null
    | undefined,
  targetTopicId: string
): ReferenceBoundary | null {
  if (!reference) return null
  if (reference.status === 'missing') {
    return { groupKey: null, placement: 'beginning' }
  }
  if (reference.boundaryMessageId) {
    for (const [key, groupMessages] of groupedMessages) {
      if (groupMessages.some((m) => m.id === reference.boundaryMessageId)) {
        return { groupKey: key, placement: 'after-boundary' }
      }
    }
  }
  // Boundary not resident: walk the loaded window newest→oldest. The first
  // (newest) group holding a foreign-owned message is the newest loaded
  // foreign group. It is the true prefix/suffix boundary only if the group
  // immediately newer than it (already visited) is target-owned — a
  // demonstrable foreign→owned transition. Otherwise the suffix is offscreen
  // and the divider is deferred rather than misplaced inside the prefix.
  let newerGroupIsTargetOwned = false
  for (const [key, groupMessages] of groupedMessages) {
    if (groupMessages.some((m) => isForeignOwnedMessage(m, targetTopicId))) {
      return newerGroupIsTargetOwned ? { groupKey: key, placement: 'after-boundary' } : null
    }
    newerGroupIsTargetOwned = groupMessages.some((m) => isTargetOwnedMessage(m, targetTopicId))
  }
  // No foreign-owned message is loaded: the whole loaded window is the
  // target's own content. Missing/no-prefix beginning placement stays independent.
  return { groupKey: null, placement: 'beginning' }
}

/**
 * One history-reference divider resolved against the current display window:
 * the read-only foreign history of one relation layer ends here, and everything
 * newer belongs to the next (nearer) layer or to the target's own writable
 * suffix.
 */
export interface ReferenceDividerPlacement {
  /** Stable unique relation identity (the relation target topic). */
  boundaryKey: string
  /** Relation metadata this divider renders and navigates (a chain layer). */
  reference: HistoryReferenceMeta
  /** Topic that owns this relation; the divider's stable layer identity. */
  targetTopicId: string
  /** Projected group this divider is placed after; null for 'beginning'. */
  groupKey: string | null
  /** `after-boundary`: directly below the layer's last materialized message. */
  placement: 'after-boundary' | 'beginning'
}

/**
 * Stable unique divider identity: a topic owns at most one reference relation,
 * so the relation target is its identity (same-endpoint relations of different
 * layers stay distinct keyed siblings).
 */
export function referenceDividerKey(targetTopicId: string): string {
  return `history-reference-boundary:${targetTopicId}`
}

/**
 * Resolve every history-reference divider of the rendered target: one per
 * materialized relation layer (nearest first), each at its OWN boundary.
 *
 * Layer 0 (the topic's own relation) keeps the established single-boundary
 * semantics: resident boundary group, the demonstrated foreign→owned
 * transition fallback, and the beginning placement for a missing source.
 * Deeper layers are placed only on their own Main-reported boundary message;
 * while that message is not loaded the divider is DEFERRED (never promoted to
 * the head), so an upstream boundary is never shown where it does not belong.
 * A deeper layer whose boundary is not materialized is not reported by Main at
 * all, so a downstream endpoint never fabricates upstream history.
 */
export function resolveReferenceDividers(
  groupedMessages: readonly MessageViewportProjectedGroup[],
  reference: HistoryReferenceMeta | null | undefined,
  targetTopicId: string
): ReferenceDividerPlacement[] {
  if (!reference) return []
  const layers = reference.layers && reference.layers.length > 0 ? reference.layers : null
  if (!layers) {
    const boundary = resolveReferenceBoundary(groupedMessages, reference, targetTopicId)
    if (!boundary) return []
    return [
      {
        boundaryKey: referenceDividerKey(targetTopicId),
        reference,
        targetTopicId,
        groupKey: boundary.groupKey,
        placement: boundary.placement
      }
    ]
  }
  const placements: ReferenceDividerPlacement[] = []
  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index]
    if (index === 0) {
      const boundary = resolveReferenceBoundary(groupedMessages, layer, targetTopicId)
      if (!boundary) continue
      placements.push({
        boundaryKey: referenceDividerKey(layer.targetTopicId),
        reference: layer,
        targetTopicId: layer.targetTopicId,
        groupKey: boundary.groupKey,
        placement: boundary.placement
      })
      continue
    }
    if (layer.status !== 'available' || !layer.boundaryMessageId) continue
    let groupKey: string | null = null
    for (const [key, groupMessages] of groupedMessages) {
      if (groupMessages.some((m) => m.id === layer.boundaryMessageId)) {
        groupKey = key
        break
      }
    }
    if (groupKey === null) continue // Boundary outside the loaded window: deferred.
    placements.push({
      boundaryKey: referenceDividerKey(layer.targetTopicId),
      reference: layer,
      targetTopicId: layer.targetTopicId,
      groupKey,
      placement: 'after-boundary'
    })
  }
  return placements
}

/**
 * A projected message is part of the read-only foreign prefix when it carries
 * an explicit topicId that is not the rendered target topic. Messages without a
 * canonical topicId never count as foreign (fail-closed, never misplace).
 */
function isForeignOwnedMessage(message: Message, targetTopicId: string): boolean {
  return typeof message.topicId === 'string' && message.topicId.length > 0 && message.topicId !== targetTopicId
}

/**
 * A projected message is target-owned (the writable suffix) when its canonical
 * topicId is exactly the rendered target topic. Explicit positive ownership
 * only: an unowned/blank topicId never counts (fail-closed — the fallback then
 * defers instead of placing a divider on an unprovable transition).
 */
function isTargetOwnedMessage(message: Message, targetTopicId: string): boolean {
  return message.topicId === targetTopicId
}

/** Resolved per-group topic-segment flags feeding the body injector. */
export interface MessageFlowBodyArgs {
  kind: string
  stableGroupId: string
  layerRunId: string
  segment: TopicSegment | undefined
  isFirst: boolean
  isLast: boolean
  /**
   * This body is the DOM-first node of the composed flow, i.e. the visually
   * bottom-most body under the column-reverse render order — nothing (no fork
   * or reference divider) is placed below it. That is the position the
   * route-tail fold slot may occupy; it is derived from the stable flow order,
   * never from scroll position or a measured/unmounted DOM node.
   */
  flowBottom: boolean
  groupMessages: (Message & { index: number })[]
}

/** Resolved per-fork placement feeding the fork-boundary injector. */
export interface MessageFlowForkArgs {
  anchorMessageId: string
  taken: TopicBranchWire | undefined
  children: TopicBranchWire[]
  parentBranchId: string | null
  parentLabel: string
  boundaryKey: string
  /** `'head'` for a fork whose branch inherits nothing (no message anchor). */
  placement: 'message' | 'head'
}

export interface BuildMessageFlowNodesInput {
  layerRuns: readonly RenderLayer[]
  contextDividerGroupKey: string | null
  /** Fork dividers resolved for this display window (see resolveForkDividers). */
  forkDividers: readonly ForkDividerPlacement[]
  branchPath: readonly TopicBranchWire[]
  branches: readonly { id: string; name?: string | null }[]
  topicDisplayName: string
  isMessageInSegment: (messageId: string) => TopicSegment | undefined
  isMessageFirstInSegment: (messageId: string) => TopicSegment | undefined
  isMessageLastInSegment: (messageId: string) => TopicSegment | undefined
  renderBody: (args: MessageFlowBodyArgs) => ReactNode
  renderForkBoundary: (args: MessageFlowForkArgs) => ReactNode
  renderContextBoundary: (legacyKey: string) => ReactNode
  /**
   * History-reference divider placements for this display window, nearest
   * relation layer first (empty/absent = not a reference target).
   */
  referenceDividers?: readonly ReferenceDividerPlacement[]
  renderReferenceDivider?: (placement: ReferenceDividerPlacement) => ReactNode
}

/**
 * Build the mounted message flow in newest→oldest render order: turn bodies
 * and independent boundary nodes as siblings. Turn runs are grouped
 * downstream in renderEditFlowNodes with boundary flush, so a boundary
 * always splits turns (even same askId) and stays outside turn click
 * capture — liveness stays on the child body nodes.
 */
export function buildMessageFlowNodes(input: BuildMessageFlowNodesInput): FlowNode[] {
  const {
    layerRuns,
    contextDividerGroupKey,
    referenceDividers,
    forkDividers,
    branchPath,
    branches,
    topicDisplayName,
    isMessageInSegment,
    isMessageFirstInSegment,
    isMessageLastInSegment,
    renderBody,
    renderForkBoundary,
    renderContextBoundary,
    renderReferenceDivider
  } = input
  const nodes: FlowNode[] = []
  const forkParentLabel = (parentBranchId: string | null): string =>
    parentBranchId === null ? topicDisplayName : (branches.find((b) => b.id === parentBranchId)?.name ?? parentBranchId)
  const forkBoundaryKey = (anchorMessageId: string, parentBranchId: string | null): string =>
    `branch-fork-${anchorMessageId}-${parentBranchId ?? 'main'}`

  // LOCK-S3.3-FIX-003: no outer React key whose identity changes with layer
  // membership/composition. Groups/selection blocks are stable entity-derived
  // siblings so overlapping history DOM survives live updates, live→history
  // transitions, and viewport expansion. Layer kind/run identity is exposed
  // only via data-* on existing elements (LOCK-S3.3-FIX-004).
  for (const layer of layerRuns) {
    for (const seg of layer.segments) {
      const kind = seg.isLive ? 'live' : 'history'
      for (const [legacyKey, groupMessages] of seg.items) {
        const firstMsg = groupMessages[0]
        const segment = firstMsg ? isMessageInSegment(firstMsg.id) : undefined
        const isFirst = firstMsg ? !!isMessageFirstInSegment(firstMsg.id) : false
        const lastMsg = groupMessages[groupMessages.length - 1]
        const isLast = lastMsg ? !!isMessageLastInSegment(lastMsg.id) : false
        const stableGroupId = deriveStableGroupId(groupMessages as readonly Message[])
        // A group whose authority membership is entirely presentation-hidden
        // (folded) paints no message row at rest. Its run therefore contributes
        // zero flow height even though the motion wrapper stays mounted to own
        // the exit/enter animation — the cascade below must see the collapsed
        // run, not the (always present) wrapper.
        const collapsedWhole =
          segment?.folded === true &&
          segment.messageIds.length > 0 &&
          groupMessages.every((message) => segment.messageIds.includes((message as Message).id))
        // Fork-divider placement (DOM order is newest→oldest under
        // column-reverse): the divider renders BEFORE the anchor group
        // (visually directly below the anchor). One divider per
        // (anchor, parent-route) fork: taken forks (the viewed route
        // passes through a child here) render the selected branch name
        // as the switcher; untaken forks render the branch-count form
        // whose menu includes the current route plus children. Placement is
        // the resolved inheritance boundary, so a divider sits where the
        // inheritance actually ends rather than on a fixed anchor row.
        const groupIdSet = new Set(groupMessages.map((m) => (m as Message).id))
        const dividersHere = forkDividers.filter(
          (d) => d.placement === 'message' && d.boundaryMessageId !== null && groupIdSet.has(d.boundaryMessageId)
        )
        // Fork boundaries are independent siblings placed DOM-before the
        // anchor body (visually directly below the anchor under
        // column-reverse). They carry no turn click/hover behavior.
        for (const divider of dividersHere) {
          const boundaryKey = forkBoundaryKey(divider.anchorMessageId, divider.parentBranchId)
          nodes.push({
            kind: 'boundary',
            entry: {
              boundaryKey,
              boundaryKind: 'fork',
              node: renderForkBoundary({
                anchorMessageId: divider.anchorMessageId,
                taken: takenChildAtAnchor(branchPath, divider.anchorMessageId, divider.children),
                children: divider.children,
                parentBranchId: divider.parentBranchId,
                parentLabel: forkParentLabel(divider.parentBranchId),
                boundaryKey,
                placement: 'message'
              })
            }
          })
        }
        // History-reference dividers: one per materialized relation layer,
        // placed DOM-before the boundary group so each renders visually
        // directly below its OWN layer's last message (the same placement
        // family as a fork divider). Placement order (nearest layer first)
        // keeps the nearest divider adjacent to the target-owned suffix when
        // layers share a boundary message. Missing/absent boundaries are
        // handled once at the beginning after the loop.
        for (const divider of referenceDividers ?? []) {
          if (divider.placement !== 'after-boundary' || legacyKey !== divider.groupKey) continue
          nodes.push({
            kind: 'boundary',
            entry: {
              boundaryKey: divider.boundaryKey,
              boundaryKind: 'reference',
              node: renderReferenceDivider?.(divider)
            }
          })
        }
        const bodyNode = renderBody({
          kind,
          stableGroupId,
          layerRunId: layer.stableLayerId,
          segment,
          isFirst,
          isLast,
          // `nodes` is built in render order (newest→oldest under
          // column-reverse), so an empty list means no boundary node has been
          // placed below this body: it IS the flow bottom.
          flowBottom: nodes.length === 0,
          groupMessages: groupMessages as (Message & { index: number })[]
        })
        nodes.push({
          kind: 'turn',
          entry: {
            groupKey: stableGroupId,
            turnAskId: deriveTurnAskId(groupMessages as readonly Message[]),
            selected: seg.selected,
            segmentId: seg.stableSegmentId,
            segmentIsLive: seg.isLive,
            kind,
            layerRunId: layer.stableLayerId,
            segment,
            segmentIsFirst: isFirst,
            segmentIsLast: isLast,
            zeroFlow: collapsedWhole,
            bodyNode
          }
        })
        // Context boundary is an independent sibling placed
        // DOM-after the anchor body (preserving the legacy visual
        // placement exactly). The legacy projected key is retained for
        // divider semantics; reconciliation uses stableGroupId above.
        if (legacyKey === contextDividerGroupKey) {
          nodes.push({
            kind: 'boundary',
            entry: {
              boundaryKey: `context-boundary:${legacyKey}`,
              boundaryKind: 'context',
              node: renderContextBoundary(legacyKey)
            }
          })
        }
      }
    }
  }

  // Head fork boundaries: a fork whose branch inherits nothing sits at the
  // history head of its parent route — the relation exists independently of
  // any prefix row, so the divider is shown even when no message carries it.
  // Appended in newest→oldest DOM order so it renders at the visual beginning,
  // below the reference divider when both mark that same head.
  for (const divider of forkDividers) {
    if (divider.placement !== 'head') continue
    const boundaryKey = forkBoundaryKey(divider.anchorMessageId, divider.parentBranchId)
    nodes.push({
      kind: 'boundary',
      entry: {
        boundaryKey,
        boundaryKind: 'fork',
        node: renderForkBoundary({
          anchorMessageId: divider.anchorMessageId,
          taken: takenChildAtAnchor(branchPath, divider.anchorMessageId, divider.children),
          children: divider.children,
          parentBranchId: divider.parentBranchId,
          parentLabel: forkParentLabel(divider.parentBranchId),
          boundaryKey,
          placement: 'head'
        })
      }
    })
  }

  // Beginning placement: a missing reference (the prefix is absent) marks the
  // top of the target's own content. Appended last in newest→oldest DOM order
  // so it renders at the visual beginning.
  for (const divider of referenceDividers ?? []) {
    if (divider.placement !== 'beginning') continue
    nodes.push({
      kind: 'boundary',
      entry: {
        boundaryKey: divider.boundaryKey,
        boundaryKind: 'reference',
        node: renderReferenceDivider?.(divider)
      }
    })
  }

  return nodes
}
