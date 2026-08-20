/**
 * S3.3 Mounted layers integration — verifies that MessagesContent's
 * history/live-tail layering preserves stable entity-derived keys,
 * does not duplicate or omit messages, preserves exact newest-first order,
 * does not remount historical nodes when a live tail transitions to history
 * or when viewport expands, and does not introduce extra scroll wrappers.
 *
 * Uses the production messageRenderLayers helpers and real
 * projectMessageViewportGroups, but mounts a lightweight harness that
 * mimics the corrected production render (flat siblings, data-* attrs,
 * no outer keyed layer Fragment).
 */
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import { useEffect, useMemo } from 'react'
import { describe, expect, it } from 'vitest'

import { buildRenderLayers, buildRenderSegments, deriveStableGroupId } from '../messageRenderLayers'
import { projectMessageViewportGroups } from '../messageViewportProjection'
import { createLatestMessageWindow } from '../messageWindow'

const message = (
  id: string,
  role: Message['role'] = 'user',
  askId?: string,
  status?: AssistantMessageStatus
): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: status ?? (role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS),
  blocks: []
})

const processing = (id: string, askId?: string) => message(id, 'assistant', askId, AssistantMessageStatus.PROCESSING)

let mountCounts = new Map<string, number>()

function GroupProbe({
  stableId,
  legacyKey,
  layerKind,
  layerRunId
}: {
  stableId: string
  legacyKey: string
  layerKind: string
  layerRunId: string
}) {
  useEffect(() => {
    mountCounts.set(stableId, (mountCounts.get(stableId) ?? 0) + 1)
  }, [stableId])
  return (
    <div
      data-testid={`group-${stableId}`}
      data-legacy-key={legacyKey}
      data-stable-id={stableId}
      data-layer-kind={layerKind}
      data-layer-run-id={layerRunId}
    />
  )
}

function SegmentProbe({ stableId, selected }: { stableId: string; selected: boolean }) {
  return <div data-testid={`segment-${stableId}`} data-selected={String(selected)} data-stable-segment-id={stableId} />
}

function LayersHarness({
  groupedMessages,
  isEditMode = false,
  selectedGroupIds = []
}: {
  groupedMessages: ReturnType<typeof projectMessageViewportGroups>
  isEditMode?: boolean
  selectedGroupIds?: string[]
}) {
  const segments = useMemo(
    () => buildRenderSegments(groupedMessages, isEditMode, selectedGroupIds),
    [groupedMessages, isEditMode, selectedGroupIds]
  )
  const layers = useMemo(() => buildRenderLayers(segments), [segments])
  const segmentToLayer = useMemo(() => {
    const map = new Map<string, (typeof layers)[number]>()
    for (const layer of layers) for (const seg of layer.segments) map.set(seg.stableSegmentId, layer)
    return map
  }, [layers])

  return (
    <div data-testid="layers-root">
      {segments.flatMap((seg) => {
        const layer = segmentToLayer.get(seg.stableSegmentId)!
        const kind = seg.isLive ? 'live' : 'history'
        const content = seg.items.map(([legacyKey, msgs]) => {
          const stableGroupId = deriveStableGroupId(msgs as readonly Message[])
          return (
            <GroupProbe
              key={stableGroupId}
              stableId={stableGroupId}
              legacyKey={legacyKey}
              layerKind={kind}
              layerRunId={layer.stableLayerId}
            />
          )
        })
        if (seg.selected) {
          return [
            <div
              key={seg.stableSegmentId}
              data-testid={`sel-${seg.stableSegmentId}`}
              data-layer-kind={kind}
              data-stable-segment-id={seg.stableSegmentId}
              data-layer-run-id={layer.stableLayerId}
              style={{ display: 'contents' }}>
              {content}
            </div>,
            <SegmentProbe
              key={`segprobe-${seg.stableSegmentId}`}
              stableId={seg.stableSegmentId}
              selected={seg.selected}
            />
          ]
        }
        return [
          ...content,
          <SegmentProbe
            key={`segprobe-${seg.stableSegmentId}`}
            stableId={seg.stableSegmentId}
            selected={seg.selected}
          />
        ]
      })}
    </div>
  )
}

describe('S3.3 Mounted layers — Messages render layering', () => {
  it('preserves exact newest-first order and exposes simultaneous history/live without extra host duplication', () => {
    mountCounts = new Map()
    const msgs: Message[] = [
      message('u0'),
      message('a0', 'assistant', 'ask0'),
      processing('a1', 'ask1'),
      message('u1'),
      processing('a2', 'ask2')
    ]
    const win = createLatestMessageWindow(msgs, 10)
    const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)

    const { container } = render(<LayersHarness groupedMessages={grouped} />)

    const groupElements = Array.from(container.querySelectorAll('[data-testid^="group-"]'))
    expect(groupElements.length).toBe(grouped.length)
    const renderedStableIds = groupElements.map((el) => el.getAttribute('data-stable-id'))
    const expectedStableIds = grouped.map(([, m]) => deriveStableGroupId(m as readonly Message[]))
    // Exact order, not sorted
    expect(renderedStableIds).toEqual(expectedStableIds)

    // No duplicate stable ids
    expect(new Set(renderedStableIds).size).toBe(renderedStableIds.length)

    // Single host, no extra #messages wrapper, layers via data attributes
    expect(container.querySelectorAll('[data-testid="layers-root"]').length).toBe(1)
    // Must have both kinds simultaneously
    const kinds = new Set(
      Array.from(container.querySelectorAll('[data-layer-kind]')).map((el) => el.getAttribute('data-layer-kind'))
    )
    expect(kinds.has('history')).toBe(true)
    expect(kinds.has('live')).toBe(true)
    // Verify alternating: collect group kinds in DOM order, ensure no duplicate/missing flat
    const groupKinds = groupElements.map((el) => el.getAttribute('data-layer-kind'))
    expect(groupKinds.length).toBe(grouped.length)
    // Each group kind must match its segment liveness
    const segments = buildRenderSegments(grouped, false, [])
    const groupKindsExpected = segments.flatMap((seg) => seg.items.map(() => (seg.isLive ? 'live' : 'history')))
    expect(groupKinds).toEqual(groupKindsExpected)
  })

  it('produces no duplicate or missing messages across layers with exact order', () => {
    mountCounts = new Map()
    const msgs: Message[] = [
      message('u0'),
      message('a0', 'assistant', 'ask0'),
      message('a1', 'assistant', 'ask0'),
      processing('a2', 'ask1'),
      message('u1')
    ]
    const win = createLatestMessageWindow(msgs, 10)
    const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
    const { container } = render(<LayersHarness groupedMessages={grouped} />)
    const groupElements = Array.from(container.querySelectorAll('[data-testid^="group-"]'))
    // Extract ids by decoding length-prefixed group ids: "1:a0" -> need to parse? Instead verify via stable id equality in order
    const renderedStableIds = groupElements.map((el) => el.getAttribute('data-stable-id'))
    const expectedStableIds = grouped.map(([, m]) => deriveStableGroupId(m as readonly Message[]))
    expect(renderedStableIds).toEqual(expectedStableIds)
    // Cross-check flat message ids in exact order via grouped
    const flatIdsFromGroups = grouped.flatMap(([, m]) => m.map((x) => x.id))
    const segments = buildRenderSegments(grouped, false, [])
    const flatIdsFromSegments = segments.flatMap((s) => s.items.flatMap(([, m]) => m.map((x) => x.id)))
    expect(flatIdsFromSegments).toEqual(flatIdsFromGroups)
    expect(new Set(flatIdsFromSegments).size).toBe(flatIdsFromSegments.length)
  })

  it('keeps selection segments atomic at history/live boundary and classifies mixed segment live', () => {
    mountCounts = new Map()
    const u0 = message('u0')
    const hist = message('hist', 'assistant', 'ask-hist')
    const live = processing('live', 'ask-live')
    const msgs: Message[] = [u0, hist, live]
    const win = createLatestMessageWindow(msgs, 10)
    const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
    const askHist = (grouped.find(([, m]) => m.some((x) => x.id === 'hist'))?.[1][0] as Message | undefined)?.askId
    const askLive = (grouped.find(([, m]) => m.some((x) => x.id === 'live'))?.[1][0] as Message | undefined)?.askId
    expect(askHist).toBe('ask-hist')
    expect(askLive).toBe('ask-live')

    const { container } = render(
      <LayersHarness groupedMessages={grouped} isEditMode selectedGroupIds={[askHist!, askLive!]} />
    )
    const segments = buildRenderSegments(grouped, true, [askHist!, askLive!])
    // Must have a selected atomic segment containing both hist and live
    const mixed = segments.find(
      (s) =>
        s.selected &&
        s.items.some(([, m]) => m.some((x) => x.id === 'hist')) &&
        s.items.some(([, m]) => m.some((x) => x.id === 'live'))
    )
    expect(mixed).toBeDefined()
    expect(mixed!.selected).toBe(true)
    expect(mixed!.isLive).toBe(true)
    expect(mixed!.items.length).toBe(2)

    // DOM must have one selected wrapper with live kind
    const selWrappers = container.querySelectorAll('[data-testid^="sel-"]')
    expect(selWrappers.length).toBe(1)
    expect(selWrappers[0].getAttribute('data-layer-kind')).toBe('live')
    // Its stable id must match helper
    expect(selWrappers[0].getAttribute('data-stable-segment-id')).toBe(mixed!.stableSegmentId)

    // Verify stable segment id unchanged on rerender with same selection (deterministic)
    const prevIds = segments.map((s) => s.stableSegmentId)
    const nextSegments = buildRenderSegments(grouped, true, [askHist!, askLive!])
    expect(nextSegments.map((s) => s.stableSegmentId)).toEqual(prevIds)
  })

  it('live-to-history transition does not remount historical nodes (stable entity-derived group keys)', async () => {
    mountCounts = new Map()
    const hist = message('hist', 'assistant', 'ask-hist')
    const live = processing('live', 'ask-live')
    const u0 = message('u0')
    const msgsBefore: Message[] = [u0, hist, live]
    const winBefore = createLatestMessageWindow(msgsBefore, 10)
    const groupedBefore = projectMessageViewportGroups(winBefore.displayMessages, winBefore.displayGroups)

    const { container, rerender } = render(<LayersHarness groupedMessages={groupedBefore} />)

    const histStable = deriveStableGroupId(
      groupedBefore.find(([, m]) => m.some((x) => x.id === 'hist'))![1] as readonly Message[]
    )
    const histElBefore = container.querySelector(`[data-testid="group-${histStable}"]`)
    expect(histElBefore).not.toBeNull()

    // Capture mount count before transition
    const mountBefore = mountCounts.get(histStable)
    expect(mountBefore).toBe(1)

    const liveSuccess = { ...live, status: AssistantMessageStatus.SUCCESS } as Message
    const msgsAfter: Message[] = [u0, hist, liveSuccess]
    const winAfter = createLatestMessageWindow(msgsAfter, 10)
    const groupedAfter = projectMessageViewportGroups(winAfter.displayMessages, winAfter.displayGroups)

    rerender(<LayersHarness groupedMessages={groupedAfter} />)

    const histElAfter = container.querySelector(`[data-testid="group-${histStable}"]`)
    expect(histElAfter).not.toBeNull()
    expect(histElAfter!.getAttribute('data-stable-id')).toBe(histStable)
    // DOM node identity preserved (React reused via stable key, no remount)
    expect(histElAfter).toBe(histElBefore)
    // Mount count for hist must not have increased (no remount)
    expect(mountCounts.get(histStable)).toBe(1)

    const liveStableBefore = deriveStableGroupId(
      groupedBefore.find(([, m]) => m.some((x) => x.id === 'live'))![1] as readonly Message[]
    )
    const liveStableAfter = deriveStableGroupId(
      groupedAfter.find(([, m]) => m.some((x) => x.id === 'live'))![1] as readonly Message[]
    )
    expect(liveStableBefore).toBe(liveStableAfter)
    // Live group's kind transitions, but its stable id unchanged
    const liveElAfter = container.querySelector(`[data-testid="group-${liveStableAfter}"]`)
    expect(liveElAfter).not.toBeNull()
    expect(liveElAfter!.getAttribute('data-layer-kind')).toBe('history')
  })

  it('viewport expansion preserves overlapping history DOM and does not remount', () => {
    mountCounts = new Map()
    const msgs: Message[] = [
      message('u0'),
      message('a0', 'assistant', 'ask0'),
      message('u1'),
      processing('a1', 'ask1'),
      message('u2')
    ]
    const winSmall = createLatestMessageWindow(msgs, 2)
    const groupedSmall = projectMessageViewportGroups(winSmall.displayMessages, winSmall.displayGroups)
    const { container, rerender } = render(<LayersHarness groupedMessages={groupedSmall} />)

    const smallGroupIds = groupedSmall.map(([, m]) => deriveStableGroupId(m as readonly Message[]))
    const smallElements = new Map<string, Element>()
    for (const gid of smallGroupIds) {
      const el = container.querySelector(`[data-testid="group-${gid}"]`)
      expect(el).not.toBeNull()
      smallElements.set(gid, el!)
      expect(mountCounts.get(gid)).toBe(1)
    }

    const winLarge = createLatestMessageWindow(msgs, 10)
    const groupedLarge = projectMessageViewportGroups(winLarge.displayMessages, winLarge.displayGroups)
    rerender(<LayersHarness groupedMessages={groupedLarge} />)

    // Overlapping groups must retain same DOM nodes and not remount
    for (const gid of smallGroupIds) {
      const elAfter = container.querySelector(`[data-testid="group-${gid}"]`)
      expect(elAfter).not.toBeNull()
      expect(elAfter).toBe(smallElements.get(gid))
      expect(mountCounts.get(gid)).toBe(1)
    }
    // Large should have additional groups
    const largeGroupIds = groupedLarge.map(([, m]) => deriveStableGroupId(m as readonly Message[]))
    expect(largeGroupIds.length).toBeGreaterThan(smallGroupIds.length)
    for (const gid of smallGroupIds) expect(largeGroupIds).toContain(gid)
  })

  it('stable group keys derive from message ids, not viewport index or length, and are collision-safe', () => {
    mountCounts = new Map()
    const msgs: Message[] = [message('u0'), processing('a0', 'ask0'), message('u1')]
    const win = createLatestMessageWindow(msgs, 10)
    const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
    const { container } = render(<LayersHarness groupedMessages={grouped} />)
    const groupElements = Array.from(container.querySelectorAll('[data-testid^="group-"]'))
    for (const el of groupElements) {
      const stableId = el.getAttribute('data-stable-id')!
      // Must be length-prefixed, not bare index
      expect(stableId).toMatch(/\d+:.+/)
      expect(stableId).not.toContain('undefined')
      const containsRealId = msgs.some((m) => stableId.includes(m.id))
      expect(containsRealId).toBe(true)
    }
    // Collision safety: ids with delimiters produce distinct keys
    const gA = [message('a:b')]
    const gB = [message('a'), message('b')]
    expect(deriveStableGroupId(gA)).not.toBe(deriveStableGroupId(gB as unknown as Message[]))
  })

  it('empty input renders no groups', () => {
    mountCounts = new Map()
    const win = createLatestMessageWindow([], 10)
    const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
    expect(grouped.length).toBe(0)
    const { container } = render(<LayersHarness groupedMessages={grouped} />)
    expect(container.querySelectorAll('[data-testid^="group-"]').length).toBe(0)
    expect(container.querySelectorAll('[data-testid^="sel-"]').length).toBe(0)
  })
})
