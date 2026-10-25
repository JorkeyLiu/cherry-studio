import type { TopicBranchWire } from '@renderer/services/db/types'
import type { Message } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { ReactNode } from 'react'

import { takenChildAtAnchor } from './BranchDividers'
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

/** Group one anchor's direct children by their parent route (null = main route). */
export function groupForkChildrenByParent(children: readonly TopicBranchWire[]): {
  parentBranchId: string | null
  children: TopicBranchWire[]
}[] {
  const byParent = new Map<string | null, TopicBranchWire[]>()
  for (const c of children) {
    const key = c.parentBranchId ?? null
    const list = byParent.get(key) ?? []
    list.push(c)
    byParent.set(key, list)
  }
  const out: { parentBranchId: string | null; children: TopicBranchWire[] }[] = []
  for (const [parentBranchId, list] of byParent) {
    list.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
    out.push({ parentBranchId, children: list })
  }
  // Deterministic group order: main-route forks first, then by first child.
  out.sort((a, b) => {
    if ((a.parentBranchId === null) !== (b.parentBranchId === null)) return a.parentBranchId === null ? -1 : 1
    const aid = a.children[0]?.id ?? ''
    const bid = b.children[0]?.id ?? ''
    return aid.localeCompare(bid)
  })
  return out
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
}

export interface BuildMessageFlowNodesInput {
  layerRuns: readonly RenderLayer[]
  contextDividerGroupKey: string | null
  forkAnchorIds: readonly string[]
  childrenByAnchor: ReadonlyMap<string, readonly TopicBranchWire[]>
  branchPath: readonly TopicBranchWire[]
  branches: readonly { id: string; name?: string | null }[]
  topicDisplayName: string
  isMessageInSegment: (messageId: string) => TopicSegment | undefined
  isMessageFirstInSegment: (messageId: string) => TopicSegment | undefined
  isMessageLastInSegment: (messageId: string) => TopicSegment | undefined
  renderBody: (args: MessageFlowBodyArgs) => ReactNode
  renderForkBoundary: (args: MessageFlowForkArgs) => ReactNode
  renderContextBoundary: (legacyKey: string) => ReactNode
  /** History-reference divider placement (absent/null = no reference target). */
  referenceBoundary?: ReferenceBoundary | null
  renderReferenceBoundary?: () => ReactNode
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
    referenceBoundary,
    forkAnchorIds,
    childrenByAnchor,
    branchPath,
    branches,
    topicDisplayName,
    isMessageInSegment,
    isMessageFirstInSegment,
    isMessageLastInSegment,
    renderBody,
    renderForkBoundary,
    renderContextBoundary,
    renderReferenceBoundary
  } = input
  const nodes: FlowNode[] = []

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
        // Fork-divider placement (DOM order is newest→oldest under
        // column-reverse): the divider renders BEFORE the anchor group
        // (visually directly below the anchor). One divider per
        // (anchor, parent-route) fork: taken forks (the viewed route
        // passes through a child here) render the selected branch name
        // as the switcher; untaken forks render the branch-count form
        // whose menu includes the current route plus children.
        const groupIdSet = new Set(groupMessages.map((m) => (m as Message).id))
        const forkAnchorHere = forkAnchorIds.find((id) => groupIdSet.has(id))
        const forkGroupsHere =
          forkAnchorHere !== undefined ? groupForkChildrenByParent(childrenByAnchor.get(forkAnchorHere) ?? []) : []
        const dividerNodes = forkGroupsHere.map((group) => {
          const takenHere = takenChildAtAnchor(branchPath, forkAnchorHere as string, group.children)
          const parentLabel =
            group.parentBranchId === null
              ? topicDisplayName
              : (branches.find((b) => b.id === group.parentBranchId)?.name ?? group.parentBranchId)
          const boundaryKey = `branch-fork-${forkAnchorHere}-${group.parentBranchId ?? 'main'}`
          return { group, takenHere, parentLabel, boundaryKey }
        })
        // Fork boundaries are independent siblings placed DOM-before the
        // anchor body (visually directly below the anchor under
        // column-reverse). They carry no turn click/hover behavior.
        for (const divider of dividerNodes) {
          const anchorMessageId = forkAnchorHere as string
          const boundaryKey = divider.boundaryKey
          nodes.push({
            kind: 'boundary',
            entry: {
              boundaryKey,
              boundaryKind: 'fork',
              node: renderForkBoundary({
                anchorMessageId,
                taken: divider.takenHere,
                children: divider.group.children,
                parentBranchId: divider.group.parentBranchId,
                parentLabel: divider.parentLabel,
                boundaryKey
              })
            }
          })
        }
        // History-reference divider: placed DOM-before the boundary group so it
        // renders visually directly below the last foreign-prefix message (the
        // same placement family as a fork divider). Missing/absent boundary is
        // handled once at the beginning after the loop.
        if (referenceBoundary?.placement === 'after-boundary' && legacyKey === referenceBoundary.groupKey) {
          nodes.push({
            kind: 'boundary',
            entry: {
              boundaryKey: 'history-reference-boundary',
              boundaryKind: 'reference',
              node: renderReferenceBoundary?.()
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

  // Missing reference (or a loaded window with no foreign prefix): the divider
  // marks the beginning (top) of the target's own content. Appended last in
  // newest→oldest DOM order so it renders at the visual beginning.
  if (referenceBoundary?.placement === 'beginning') {
    nodes.push({
      kind: 'boundary',
      entry: {
        boundaryKey: 'history-reference-boundary',
        boundaryKind: 'reference',
        node: renderReferenceBoundary?.()
      }
    })
  }

  return nodes
}
