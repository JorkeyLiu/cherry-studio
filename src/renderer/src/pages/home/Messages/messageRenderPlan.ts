import type { Message } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { isMessageProcessing } from '@renderer/utils/messageUtils/is'
import type { HistoryReferenceMeta } from '@shared/chatDb'

import type { ReferenceDividerPlacement } from './messageFlowNodes'
import type { RenderLayer, RenderLayerKind, RenderSegment } from './messageRenderLayers'
import type { MessageViewportProjectedGroup } from './messageViewportProjection'

/**
 * Sixth-slice render plan: the single production assembly for
 * groupedMessages → segments → layers → flow inputs.
 *
 * One local, per-build derivation (no cross-update module cache, no global
 * state, no stored old entities) precomputes, each exactly once per group:
 * group identity (`stableGroupId`), message id → group position
 * (first-write-wins), segment membership/first/last attribution, and the
 * selected/live/segment/layer tags. Segment/layer merging, the context
 * divider key, and the reference divider placements are resolved from those
 * precomputed rows — the flow builder consumes them without re-deriving
 * identities, without per-group `segments.find` scans, and without
 * per-layer scans over already-indexed group ids.
 *
 * Canonical value contracts (unchanged from the previous per-site logic):
 * length-prefixed id encoding, selection atomicity (contiguous selected
 * segments never split on live/history; unselected segments split on
 * liveness), layer runs merged by kind with oldest-group-derived ids, legacy
 * keys kept for divider semantics only, reference priority
 * (missing → beginning > resident boundary → after-boundary > demonstrable
 * foreign→owned transition → after-boundary (layer 0 only) > deferred >
 * no-foreign → beginning; deeper layers resident-only).
 */

const encodeIdPart = (id: string): string => `${id.length}:${id}`

export const deriveStableGroupId = (messages: readonly Pick<Message, 'id'>[]): string => {
  if (messages.length === 0) return 'group:empty'
  return messages.map((m) => encodeIdPart(m.id)).join('|')
}

export const deriveStableSegmentIdFromGroupIds = (stableGroupIds: readonly string[]): string => {
  if (stableGroupIds.length === 0) return 'seg:empty'
  // Length-prefix each group id to keep segment encoding collision-safe even when
  // original ids contain '|' or ':' — identical values to the legacy derivation.
  return `seg:${stableGroupIds.map((gid) => encodeIdPart(gid)).join('|')}`
}

export const isGroupLive = (messages: readonly Pick<Message, 'id' | 'status'>[]): boolean => {
  return messages.some((m) => isMessageProcessing(m as Message))
}

export const referenceDividerKey = (targetTopicId: string): string => {
  return `history-reference-boundary:${targetTopicId}`
}

const isForeignOwnedMessage = (message: Message, targetTopicId: string): boolean => {
  return typeof message.topicId === 'string' && message.topicId.length > 0 && message.topicId !== targetTopicId
}

const isTargetOwnedMessage = (message: Message, targetTopicId: string): boolean => {
  return message.topicId === targetTopicId
}

export interface SegmentMembershipIndex {
  byMessageId: ReadonlyMap<string, TopicSegment>
  byFirstMessageId: ReadonlyMap<string, TopicSegment>
  byLastMessageId: ReadonlyMap<string, TopicSegment>
}

/**
 * Single-pass segment attribution indexes over the entity-order snapshot
 * (`segmentsForTopic`, never the sortOrder catalog). Every map is
 * first-write-wins so lookups preserve the legacy `Array.find` first-match
 * semantics; membership/first/last are independent maps because the three
 * queries may disagree or overlap.
 */
export const buildSegmentMembershipIndex = (segmentsForTopic: readonly TopicSegment[]): SegmentMembershipIndex => {
  const byMessageId = new Map<string, TopicSegment>()
  const byFirstMessageId = new Map<string, TopicSegment>()
  const byLastMessageId = new Map<string, TopicSegment>()
  for (const seg of segmentsForTopic) {
    const ids = seg.messageIds
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (!byMessageId.has(id)) byMessageId.set(id, seg)
    }
    const first = seg.firstMessageId
    if (typeof first === 'string' && first.length > 0 && !byFirstMessageId.has(first)) {
      byFirstMessageId.set(first, seg)
    }
    const last = seg.lastMessageId
    if (typeof last === 'string' && last.length > 0 && !byLastMessageId.has(last)) {
      byLastMessageId.set(last, seg)
    }
  }
  return { byMessageId, byFirstMessageId, byLastMessageId }
}

export interface PlannedGroup {
  entry: MessageViewportProjectedGroup
  legacyKey: string
  stableGroupId: string
  live: boolean
  selected: boolean
  /** Membership attribution of the group's FIRST message (legacy flow contract). */
  bodySegment: TopicSegment | undefined
  bodyFirstSegment: TopicSegment | undefined
  bodyLastSegment: TopicSegment | undefined
  hasForeign: boolean
  hasTargetOwned: boolean
  isFolded: boolean
}

export interface GroupRowInput {
  groupedMessages: readonly MessageViewportProjectedGroup[]
  isEditMode: boolean
  selectedGroupIds: readonly string[]
  segmentIndex: SegmentMembershipIndex
  targetTopicId: string
  deriveGroupId?: (messages: readonly Pick<Message, 'id'>[]) => string
}

/**
 * One linear pass over groups (newest-first order preserved): identity, live,
 * selection, segment attribution, ownership flags, and fold state. Identity
 * is derived exactly once per group through the injectable (default canonical)
 * derivation so tests can budget it.
 */
export const resolvePlannedGroups = (input: GroupRowInput): PlannedGroup[] => {
  const derive = input.deriveGroupId ?? deriveStableGroupId
  const rows: PlannedGroup[] = new Array(input.groupedMessages.length)
  for (let gi = 0; gi < input.groupedMessages.length; gi++) {
    const entry = input.groupedMessages[gi]
    const legacyKey = entry[0]
    const groupMessages = entry[1]
    const stableGroupId = derive(groupMessages as readonly Pick<Message, 'id'>[])
    const live = isGroupLive(groupMessages as readonly Pick<Message, 'id' | 'status'>[])
    const first = groupMessages[0] as Message | undefined
    const last = groupMessages.length > 0 ? (groupMessages[groupMessages.length - 1] as Message) : undefined
    const groupAskId = first?.askId ?? first?.id ?? ''
    const selected = input.isEditMode && input.selectedGroupIds.includes(groupAskId)
    const firstId = first?.id
    const lastId = last?.id
    const bodySegment = typeof firstId === 'string' ? input.segmentIndex.byMessageId.get(firstId) : undefined
    const bodyFirstSegment = typeof firstId === 'string' ? input.segmentIndex.byFirstMessageId.get(firstId) : undefined
    const bodyLastSegment = typeof lastId === 'string' ? input.segmentIndex.byLastMessageId.get(lastId) : undefined
    let hasForeign = false
    let hasTargetOwned = false
    for (let mi = 0; mi < groupMessages.length; mi++) {
      const m = groupMessages[mi] as Message
      if (!hasForeign && isForeignOwnedMessage(m, input.targetTopicId)) hasForeign = true
      if (!hasTargetOwned && isTargetOwnedMessage(m, input.targetTopicId)) hasTargetOwned = true
      if (hasForeign && hasTargetOwned) break
    }
    rows[gi] = {
      entry,
      legacyKey,
      stableGroupId,
      live,
      selected,
      bodySegment,
      bodyFirstSegment,
      bodyLastSegment,
      hasForeign,
      hasTargetOwned,
      isFolded: groupMessages.length > 0 && groupMessages.every((m) => (m as Message).folded === true)
    }
  }
  return rows
}

/**
 * Message id → group position (newest-first group index), first-write-wins:
 * the first (newest) group holding an id wins, matching the legacy first-hit
 * scan. Unknown ids stay absent.
 */
export const buildMessageIdToGroupIndex = (
  groupedMessages: readonly MessageViewportProjectedGroup[]
): Map<string, number> => {
  const index = new Map<string, number>()
  for (let gi = 0; gi < groupedMessages.length; gi++) {
    const messages = groupedMessages[gi][1]
    for (let mi = 0; mi < messages.length; mi++) {
      const id = (messages[mi] as Message).id
      if (!index.has(id)) index.set(id, gi)
    }
  }
  return index
}

/** Canonical segment merge over precomputed rows (single linear pass). */
export const mergeRowsIntoSegments = (rows: readonly PlannedGroup[]): RenderSegment[] => {
  if (rows.length === 0) return []
  const segments: RenderSegment[] = []
  for (const row of rows) {
    const lastSeg = segments[segments.length - 1]
    if (lastSeg && lastSeg.selected === row.selected) {
      if (row.selected) {
        // Selected contiguous edit segments remain atomic across live/history boundary
        lastSeg.items.push(row.entry)
        lastSeg.isLive = lastSeg.isLive || row.live
      } else {
        // Unselected (including normal non-edit mode): split whenever liveness changes
        if (lastSeg.isLive === row.live) {
          lastSeg.items.push(row.entry)
        } else {
          segments.push({ selected: row.selected, items: [row.entry], stableSegmentId: '', isLive: row.live })
        }
      }
    } else {
      segments.push({ selected: row.selected, items: [row.entry], stableSegmentId: '', isLive: row.live })
    }
  }
  const rowByEntry = new Map<object, PlannedGroup>()
  for (const row of rows) rowByEntry.set(row.entry as object, row)
  for (const seg of segments) {
    const ids = new Array<string>(seg.items.length)
    for (let i = 0; i < seg.items.length; i++) {
      ids[i] = rowByEntry.get(seg.items[i] as object)?.stableGroupId ?? deriveStableGroupId(seg.items[i][1])
    }
    seg.stableSegmentId = deriveStableSegmentIdFromGroupIds(ids)
  }
  return segments
}

export const deriveLayerIdFromOldestStableId = (stableOldestGroupId: string): string => `layer:${stableOldestGroupId}`

/**
 * Canonical layer merge over segments (single linear pass). The oldest
 * group's stable id is resolved by the caller so the plan path reuses the
 * precomputed identity (no second derivation); the default derives it for
 * standalone callers. Layer identity stays entity-derived only (oldest
 * group's ids, no kind prefix), so a live→history transition that keeps the
 * same oldest group preserves the key — production render does not key on
 * layer anymore.
 */
export const mergeSegmentsIntoLayers = (
  segments: readonly RenderSegment[],
  resolveOldestStableId: (entry: MessageViewportProjectedGroup) => string = (entry) =>
    deriveStableGroupId(entry[1] as readonly Pick<Message, 'id'>[])
): RenderLayer[] => {
  if (segments.length === 0) return []
  const runs: RenderLayer[] = []
  for (const seg of segments) {
    const kind: RenderLayerKind = seg.isLive ? 'live' : 'history'
    const last = runs[runs.length - 1]
    if (last && last.kind === kind) {
      last.segments.push(seg)
    } else {
      runs.push({ kind, segments: [seg], stableLayerId: '' })
    }
  }
  for (const run of runs) {
    const lastSegment = run.segments[run.segments.length - 1]
    const oldestEntry = lastSegment.items[lastSegment.items.length - 1]
    run.stableLayerId =
      oldestEntry !== undefined ? deriveLayerIdFromOldestStableId(resolveOldestStableId(oldestEntry)) : `layer:empty`
  }
  return runs
}

export interface ReferenceBoundaryInput {
  reference:
    | { sourceTopicId: string; status: 'available' | 'missing'; boundaryMessageId: string | null }
    | null
    | undefined
}

export interface ResolvedReferenceBoundary {
  groupKey: string | null
  placement: 'after-boundary' | 'beginning'
}

/**
 * Canonical single-boundary resolution from precomputed rows: resident
 * boundary via the message→group index, otherwise the demonstrable
 * foreign→owned transition walking newest→oldest (layer-0 semantics).
 */
export const resolvePlannedReferenceBoundary = (
  rows: readonly PlannedGroup[],
  messageIdToGroupIndex: ReadonlyMap<string, number>,
  reference: ReferenceBoundaryInput['reference']
): ResolvedReferenceBoundary | null => {
  if (!reference) return null
  if (reference.status === 'missing') {
    return { groupKey: null, placement: 'beginning' }
  }
  if (reference.boundaryMessageId) {
    const gi = messageIdToGroupIndex.get(reference.boundaryMessageId)
    if (gi !== undefined) {
      return { groupKey: rows[gi].legacyKey, placement: 'after-boundary' }
    }
  }
  // Boundary not resident: walk the loaded window newest→oldest. The first
  // (newest) group holding a foreign-owned message is the newest loaded
  // foreign group. It is the true prefix/suffix boundary only if the group
  // immediately newer than it (already visited) is target-owned — a
  // demonstrable foreign→owned transition. Otherwise the suffix is offscreen
  // and the divider is deferred rather than misplaced inside the prefix.
  let newerGroupIsTargetOwned = false
  for (const row of rows) {
    if (row.hasForeign) {
      return newerGroupIsTargetOwned ? { groupKey: row.legacyKey, placement: 'after-boundary' } : null
    }
    newerGroupIsTargetOwned = row.hasTargetOwned
  }
  // No foreign-owned message is loaded: the whole loaded window is the
  // target's own content. Missing/no-prefix beginning placement stays independent.
  return { groupKey: null, placement: 'beginning' }
}

/**
 * Canonical layered reference resolution: layer 0 keeps the established
 * single-boundary semantics (resident boundary, demonstrated transition
 * fallback, missing beginning); deeper layers resolve only on their own
 * Main-reported resident boundary, otherwise deferred.
 */
export const resolvePlannedReferenceDividers = (
  rows: readonly PlannedGroup[],
  messageIdToGroupIndex: ReadonlyMap<string, number>,
  reference: HistoryReferenceMeta | null | undefined,
  targetTopicId: string
): ReferenceDividerPlacement[] => {
  if (!reference) return []
  const layers = reference.layers && reference.layers.length > 0 ? reference.layers : null
  if (!layers) {
    const boundary = resolvePlannedReferenceBoundary(rows, messageIdToGroupIndex, reference)
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
      const boundary = resolvePlannedReferenceBoundary(rows, messageIdToGroupIndex, layer)
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
    const gi = messageIdToGroupIndex.get(layer.boundaryMessageId)
    if (gi === undefined) continue // Boundary outside the loaded window: deferred.
    placements.push({
      boundaryKey: referenceDividerKey(layer.targetTopicId),
      reference: layer,
      targetTopicId: layer.targetTopicId,
      groupKey: rows[gi].legacyKey,
      placement: 'after-boundary'
    })
  }
  return placements
}

export interface MessageRenderPlanInput {
  groupedMessages: readonly MessageViewportProjectedGroup[]
  isEditMode: boolean
  selectedGroupIds: readonly string[]
  segmentsForTopic: readonly TopicSegment[]
  contextBoundaryMessageId: string | null
  reference: HistoryReferenceMeta | null | undefined
  targetTopicId: string
  deriveGroupId?: (messages: readonly Pick<Message, 'id'>[]) => string
}

export interface MessageRenderPlan {
  rows: PlannedGroup[]
  rowByEntry: ReadonlyMap<object, PlannedGroup>
  segments: RenderSegment[]
  layers: RenderLayer[]
  messageIdToGroupIndex: ReadonlyMap<string, number>
  contextDividerGroupKey: string | null
  referenceDividers: ReferenceDividerPlacement[]
}

/**
 * The single production render assembly: a few linear passes, no compensation
 * chain. Group rows (identity/live/selection/segment/ownership/fold) →
 * message id index (same pass order, first-write-wins) → segment merge →
 * layer merge → context key via index → reference placements via index +
 * precomputed fallback transition.
 */
export const buildMessageRenderPlan = (input: MessageRenderPlanInput): MessageRenderPlan => {
  const segmentIndex = buildSegmentMembershipIndex(input.segmentsForTopic)
  const rows = resolvePlannedGroups({
    groupedMessages: input.groupedMessages,
    isEditMode: input.isEditMode,
    selectedGroupIds: input.selectedGroupIds,
    segmentIndex,
    targetTopicId: input.targetTopicId,
    deriveGroupId: input.deriveGroupId
  })
  const messageIdToGroupIndex = buildMessageIdToGroupIndex(input.groupedMessages)
  const segments = mergeRowsIntoSegments(rows)
  const rowByEntry = new Map<object, PlannedGroup>()
  for (const row of rows) rowByEntry.set(row.entry as object, row)
  const layers = mergeSegmentsIntoLayers(
    segments,
    (entry) => rowByEntry.get(entry as object)?.stableGroupId ?? deriveStableGroupId(entry[1])
  )
  let contextDividerGroupKey: string | null = null
  if (input.contextBoundaryMessageId) {
    const gi = messageIdToGroupIndex.get(input.contextBoundaryMessageId)
    contextDividerGroupKey = gi !== undefined ? rows[gi].legacyKey : null
  }
  const referenceDividers = resolvePlannedReferenceDividers(
    rows,
    messageIdToGroupIndex,
    input.reference,
    input.targetTopicId
  )
  return {
    rows,
    rowByEntry,
    segments,
    layers,
    messageIdToGroupIndex,
    contextDividerGroupKey,
    referenceDividers
  }
}
