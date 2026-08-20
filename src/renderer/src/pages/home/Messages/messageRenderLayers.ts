import type { Message } from '@renderer/types/newMessage'
import { isMessageProcessing } from '@renderer/utils/messageUtils/is'

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

const encodeIdPart = (id: string): string => `${id.length}:${id}`

export const deriveStableGroupId = (messages: readonly Pick<Message, 'id'>[]): string => {
  if (messages.length === 0) return 'group:empty'
  return messages.map((m) => encodeIdPart(m.id)).join('|')
}

export const deriveStableSegmentId = (items: readonly MessageViewportProjectedGroup[]): string => {
  if (items.length === 0) return 'seg:empty'
  const groupIds = items.map(([, msgs]) => deriveStableGroupId(msgs as readonly Pick<Message, 'id'>[]))
  // Length-prefix each group id to keep segment encoding collision-safe even when
  // original ids contain '|' or ':'
  return `seg:${groupIds.map((gid) => encodeIdPart(gid)).join('|')}`
}

export const isGroupLive = (messages: readonly Pick<Message, 'id' | 'status'>[]): boolean => {
  return messages.some((m) => isMessageProcessing(m as Message))
}

const deriveStableLayerId = (_kind: RenderLayerKind, segments: RenderSegment[]): string => {
  if (segments.length === 0) return `layer:empty`
  const lastSegment = segments[segments.length - 1]
  const lastItems = lastSegment.items
  const oldestGroup = lastItems[lastItems.length - 1]
  if (!oldestGroup) return `layer:empty`
  const oldestMessages = oldestGroup[1] as readonly Message[]
  const stableOldest = deriveStableGroupId(oldestMessages)
  // Entity-derived only (oldest group's ids), without kind prefix variation beyond stableOldest,
  // so a live→history transition that keeps the same oldest group preserves the layer key
  // if we were to use it — but production render does not key on layer anymore.
  return `layer:${stableOldest}`
}

export const buildRenderSegments = (
  groupedMessages: readonly MessageViewportProjectedGroup[],
  isEditMode: boolean,
  selectedGroupIds: readonly string[]
): RenderSegment[] => {
  if (groupedMessages.length === 0) return []
  const segments: RenderSegment[] = []

  for (const entry of groupedMessages) {
    const groupMessages = entry[1] as readonly (Message & { index: number })[]
    const first = groupMessages[0] as Message | undefined
    const groupAskId = first?.askId ?? first?.id ?? ''
    const selected = isEditMode && selectedGroupIds.includes(groupAskId)
    const groupLive = isGroupLive(groupMessages as readonly Message[])

    const lastSeg = segments[segments.length - 1]
    if (lastSeg && lastSeg.selected === selected) {
      if (selected) {
        // Selected contiguous edit segments remain atomic across live/history boundary
        lastSeg.items.push(entry)
        lastSeg.isLive = lastSeg.isLive || groupLive
      } else {
        // Unselected (including normal non-edit mode): split whenever liveness changes
        if (lastSeg.isLive === groupLive) {
          lastSeg.items.push(entry)
        } else {
          segments.push({ selected, items: [entry], stableSegmentId: '', isLive: groupLive })
        }
      }
    } else {
      segments.push({ selected, items: [entry], stableSegmentId: '', isLive: groupLive })
    }
  }

  for (const seg of segments) {
    seg.stableSegmentId = deriveStableSegmentId(seg.items)
  }

  return segments
}

export const buildRenderLayers = (segments: readonly RenderSegment[]): RenderLayer[] => {
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
    run.stableLayerId = deriveStableLayerId(run.kind, run.segments)
  }

  return runs
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
