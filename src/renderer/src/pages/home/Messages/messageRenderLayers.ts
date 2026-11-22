import type { Message } from '@renderer/types/newMessage'

import {
  buildSegmentMembershipIndex,
  deriveStableGroupId as deriveStableGroupIdCanonical,
  deriveStableSegmentIdFromGroupIds,
  isGroupLive as isGroupLiveCanonical,
  mergeRowsIntoSegments,
  mergeSegmentsIntoLayers as mergeSegmentsIntoLayersCanonical,
  resolvePlannedGroups
} from './messageRenderPlan'
import type { MessageViewportProjectedGroup } from './messageViewportProjection'

export type RenderLayerKind = 'history' | 'live'

export interface RenderSegment {
  selected: boolean
  items: MessageViewportProjectedGroup[]
  stableSegmentId: string
  isLive: boolean
}

export interface RenderLayer {
  kind: RenderLayerKind
  segments: RenderSegment[]
  stableLayerId: string
}

/**
 * Compatibility re-exports: the canonical derivations live in
 * `messageRenderPlan` (single production assembly). These names are retained
 * because `MessageGroup` consumes `deriveStableGroupId` and existing builder
 * tests pin the value contracts.
 */
export const deriveStableGroupId = deriveStableGroupIdCanonical
export const isGroupLive = isGroupLiveCanonical

export const deriveStableSegmentId = (items: readonly MessageViewportProjectedGroup[]): string => {
  if (items.length === 0) return 'seg:empty'
  const groupIds = items.map(([, msgs]) => deriveStableGroupId(msgs as readonly Pick<Message, 'id'>[]))
  // Length-prefix each group id to keep segment encoding collision-safe even when
  // original ids contain '|' or ':'
  return deriveStableSegmentIdFromGroupIds(groupIds)
}

export const buildRenderSegments = (
  groupedMessages: readonly MessageViewportProjectedGroup[],
  isEditMode: boolean,
  selectedGroupIds: readonly string[]
): RenderSegment[] => {
  // Thin delegate: minimal rows (segment ownership unused here) into the
  // canonical merge. No second segment/layer assembly exists.
  const rows = resolvePlannedGroups({
    groupedMessages,
    isEditMode,
    selectedGroupIds,
    segmentIndex: buildSegmentMembershipIndex([]),
    targetTopicId: ''
  })
  return mergeRowsIntoSegments(rows)
}

export const buildRenderLayers = (segments: readonly RenderSegment[]): RenderLayer[] => {
  // Thin delegate into the canonical layer merge (default oldest-group derivation).
  return mergeSegmentsIntoLayersCanonical(segments)
}

export const buildRenderLayersFromSegments = (
  groupedMessages: readonly MessageViewportProjectedGroup[],
  isEditMode: boolean,
  selectedGroupIds: readonly string[]
): { segments: RenderSegment[]; layers: RenderLayer[] } => {
  const segments = buildRenderSegments(groupedMessages, isEditMode, selectedGroupIds)
  const layers = buildRenderLayers(segments)
  return { segments, layers }
}
