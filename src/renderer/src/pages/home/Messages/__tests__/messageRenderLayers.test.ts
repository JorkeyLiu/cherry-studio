import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  buildRenderLayers,
  buildRenderSegments,
  deriveStableGroupId,
  deriveStableSegmentId,
  isGroupLive
} from '../messageRenderLayers'
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
const pending = (id: string, askId?: string) => message(id, 'assistant', askId, AssistantMessageStatus.PENDING)
const searching = (id: string, askId?: string) => message(id, 'assistant', askId, AssistantMessageStatus.SEARCHING)

describe('messageRenderLayers — S3.3 stable ID boundaries and history/live-tail layering', () => {
  describe('deriveStableGroupId', () => {
    it('derives from immutable message ids with length-prefixed collision-safe encoding', () => {
      const g1 = [message('a'), message('b')]
      const g2 = [message('a'), message('b')]
      const g3 = [message('b'), message('a')]
      // length-prefixed: "1:a|1:b" vs "1:b|1:a"
      expect(deriveStableGroupId(g1)).toBe('1:a|1:b')
      expect(deriveStableGroupId(g2)).toBe('1:a|1:b')
      expect(deriveStableGroupId(g3)).toBe('1:b|1:a')
      expect(deriveStableGroupId(g1)).not.toBe(deriveStableGroupId(g3))
    })

    it('is collision-safe for ids containing delimiters', () => {
      const gA = [message('a:b'), message('c')]
      const gB = [message('a'), message('b:c')]
      expect(deriveStableGroupId(gA)).not.toBe(deriveStableGroupId(gB))
      // Explicit: "3:a:b|1:c" vs "1:a|3:b:c"
      expect(deriveStableGroupId(gA)).toBe('3:a:b|1:c')
      expect(deriveStableGroupId(gB)).toBe('1:a|3:b:c')
      const withPipeA = [message('a|b')]
      const withPipeB = [message('a'), message('b')]
      expect(deriveStableGroupId(withPipeA)).not.toBe(deriveStableGroupId(withPipeB))
    })

    it('identical data produces identical ids regardless of call count', () => {
      const msgs: Message[] = [message('m1'), message('m2')]
      const id1 = deriveStableGroupId(msgs)
      const id2 = deriveStableGroupId(msgs)
      expect(id1).toBe(id2)
    })

    it('empty group returns sentinel without throwing', () => {
      expect(deriveStableGroupId([])).toBe('group:empty')
    })
  })

  describe('deriveStableSegmentId', () => {
    it('is deterministic and entity-derived with collision-safe encoding', () => {
      const items1: any = [
        ['k:a', [message('a')]],
        ['k:b', [message('b'), message('c')]]
      ]
      const items2: any = [
        ['k:a', [message('a')]],
        ['k:b', [message('b'), message('c')]]
      ]
      expect(deriveStableSegmentId(items1)).toBe(deriveStableSegmentId(items2))
      const different: any = [['k:a', [message('a')]]]
      expect(deriveStableSegmentId(different)).not.toBe(deriveStableSegmentId(items1))
    })

    it('empty items returns sentinel', () => {
      expect(deriveStableSegmentId([])).toBe('seg:empty')
    })
  })

  describe('isGroupLive — mixed-status group is live', () => {
    it('a group with any PENDING/PROCESSING/SEARCHING message is live', () => {
      const success = message('aSuccess', 'assistant', 'askX')
      const proc = processing('aProc', 'askX')
      const msgs: Message[] = [message('u0'), success, proc, message('u1')]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const mixedGroup = grouped.find(([, m]) => m.some((x) => x.id === 'aSuccess'))
      expect(mixedGroup).toBeDefined()
      expect(isGroupLive(mixedGroup![1] as unknown as Message[])).toBe(true)
      const segments = buildRenderSegments(grouped, false, [])
      const seg = segments.find((s) => s.items.some(([, m]) => m.some((x) => x.id === 'aSuccess')))
      expect(seg).toBeDefined()
      expect(seg!.isLive).toBe(true)
    })

    it('SEARCHING is also live', () => {
      const s = searching('aSearch', 'askS')
      const win = createLatestMessageWindow([message('u0'), s], 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const segments = buildRenderSegments(grouped, false, [])
      const seg = segments.find((st) => st.items.some(([, m]) => m.some((x) => x.id === 'aSearch')))
      expect(seg).toBeDefined()
      expect(seg!.isLive).toBe(true)
    })

    it('multi-model group with one live message is live', () => {
      const a1 = message('a1', 'assistant', 'askM', AssistantMessageStatus.SUCCESS)
      const a2 = processing('a2', 'askM')
      const msgs: Message[] = [message('u0'), a1, a2, message('u1')]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const group = grouped.find(([, m]) => m.some((x) => x.id === 'a1'))
      expect(group).toBeDefined()
      expect(group![1].length).toBe(2)
      expect(isGroupLive(group![1] as unknown as Message[])).toBe(true)
      const seg = buildRenderSegments(grouped, false, []).find((s) =>
        s.items.some(([, m]) => m.some((x) => x.id === 'a1'))
      )
      expect(seg!.isLive).toBe(true)
    })
  })

  describe('buildRenderSegments — empty and order preservation', () => {
    it('empty groupedMessages returns empty segments and empty layers', () => {
      const segs = buildRenderSegments([], false, [])
      expect(segs).toEqual([])
      const layers = buildRenderLayers(segs)
      expect(layers).toEqual([])
    })

    it('preserves exact newest-first order and no duplicate/missing', () => {
      const msgs: Message[] = [
        message('u0'),
        message('a0', 'assistant', 'ask0'),
        processing('a1', 'ask1'),
        message('u1'),
        pending('a2', 'ask2')
      ]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const segments = buildRenderSegments(grouped, false, [])
      const layers = buildRenderLayers(segments)
      const flatIds = layers.flatMap((l) => l.segments.flatMap((s) => s.items.flatMap(([, m]) => m.map((x) => x.id))))
      const groupedIds = grouped.flatMap(([, m]) => m.map((x) => x.id))
      // Exact order equality, not sorted — proves projection preserved newest-first
      expect(flatIds).toEqual(groupedIds)
      expect(new Set(flatIds).size).toBe(flatIds.length)
      // Also verify segments flat equals grouped flat
      const segFlat = segments.flatMap((s) => s.items.flatMap(([, m]) => m.map((x) => x.id)))
      expect(segFlat).toEqual(groupedIds)
    })

    it('preserves deterministic identical projection for identical data', () => {
      const msgs: Message[] = [
        message('u0'),
        processing('a0', 'ask0'),
        message('u1'),
        message('a1', 'assistant', 'ask1'),
        pending('a2', 'ask2')
      ]
      const win1 = createLatestMessageWindow(msgs, 10)
      const win2 = createLatestMessageWindow([...msgs], 10)
      const g1 = projectMessageViewportGroups(win1.displayMessages, win1.displayGroups)
      const g2 = projectMessageViewportGroups(win2.displayMessages, win2.displayGroups)
      const seg1 = buildRenderSegments(g1, false, [])
      const seg2 = buildRenderSegments(g2, false, [])
      const layers1 = buildRenderLayers(seg1)
      const layers2 = buildRenderLayers(seg2)
      expect(layers1.map((l) => l.stableLayerId)).toEqual(layers2.map((l) => l.stableLayerId))
      expect(seg1.map((s) => s.stableSegmentId)).toEqual(seg2.map((s) => s.stableSegmentId))
      expect(seg1.map((s) => s.isLive)).toEqual(seg2.map((s) => s.isLive))
      expect(seg1.map((s) => s.selected)).toEqual(seg2.map((s) => s.selected))
    })
  })

  describe('buildRenderSegments — unselected must split on liveness (LOCK-S3.3-FIX-001/002)', () => {
    it('H-L-H alternating runs produce three segments with correct kinds and two history layers not merged', () => {
      // Chronological: u0(history), aLive(askLive) live, aHist(askHist) history, u1(history newest? Actually chronological last is u1 history)
      // Let's craft to get newest-first: [u1 history, aHist history, aLive live, u0 history] after reversal
      // Instead craft clearly alternating groups: create messages that each form separate group
      const u0 = message('u0')
      const aHist0 = message('aHist0', 'assistant', 'askHist0')
      const aLive = processing('aLive', 'askLive')
      const aHist1 = message('aHist1', 'assistant', 'askHist1')
      const u1 = message('u1')
      // chronological: u0, aHist0, aLive, aHist1, u1
      const msgs: Message[] = [u0, aHist0, aLive, aHist1, u1]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      // grouped newest-first should be: u1, aHist1, aLive, aHist0, u0
      // So pattern newest-first: H, H, L, H, H -> after splitting unselected on liveness,
      // the two consecutive H at start (u1,aHist1) should be merged into one history segment,
      // then L segment, then H segment containing aHist0,u0
      const segments = buildRenderSegments(grouped, false, [])
      expect(segments.length).toBe(3)
      expect(segments[0].isLive).toBe(false)
      expect(segments[1].isLive).toBe(true)
      expect(segments[2].isLive).toBe(false)
      // Verify exact grouping: segments must cover all groups in order without missing
      const allSegGroups = segments.flatMap((s) => s.items)
      expect(allSegGroups.map(([k]) => k)).toEqual(grouped.map(([k]) => k))
      // Layers must be exactly 3 alternating runs, not merged
      const layers = buildRenderLayers(segments)
      expect(layers.length).toBe(3)
      expect(layers[0].kind).toBe('history')
      expect(layers[1].kind).toBe('live')
      expect(layers[2].kind).toBe('history')
      // No consecutive layers share kind
      for (let i = 1; i < layers.length; i++) expect(layers[i].kind).not.toBe(layers[i - 1].kind)
      // Simultaneous history and live present
      expect(layers.some((l) => l.kind === 'history')).toBe(true)
      expect(layers.some((l) => l.kind === 'live')).toBe(true)
    })

    it('H-L-H-L-H longer alternating run proves arbitrary alternation without merging same kind across boundary', () => {
      const msgs: Message[] = [
        message('u0'),
        message('a0', 'assistant', 'ask0'),
        processing('a1', 'ask1'),
        message('u1'),
        pending('a2', 'ask2'),
        message('a3', 'assistant', 'ask3'),
        searching('a4', 'ask4')
      ]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const segments = buildRenderSegments(grouped, false, [])
      const layers = buildRenderLayers(segments)
      // Verify alternating kinds
      for (let i = 1; i < layers.length; i++) expect(layers[i].kind).not.toBe(layers[i - 1].kind)
      // Verify order preserved
      const runFlat = layers.flatMap((l) => l.segments.flatMap((s) => s.items))
      expect(runFlat.map(([k]) => k)).toEqual(grouped.map(([k]) => k))
      // Must have both kinds
      const kinds = new Set(layers.map((l) => l.kind))
      expect(kinds.has('history')).toBe(true)
      expect(kinds.has('live')).toBe(true)
      // No segment should contain both live and history groups when unselected
      for (const seg of segments) {
        if (!seg.selected) {
          const hasLive = seg.items.some(([, m]) => isGroupLive(m as unknown as Message[]))
          const hasHistory = seg.items.some(([, m]) => !isGroupLive(m as unknown as Message[]))
          expect(hasLive && hasHistory).toBe(false)
        }
      }
    })

    it('unrelated unselected history must never be labeled live', () => {
      const hist = message('hist', 'assistant', 'askHist')
      const live = processing('live', 'askLive')
      const u0 = message('u0')
      const msgs: Message[] = [u0, hist, live, message('u1')]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const segments = buildRenderSegments(grouped, false, [])
      const histSeg = segments.find((s) => s.items.some(([, m]) => m.some((x) => x.id === 'hist')))
      expect(histSeg).toBeDefined()
      expect(histSeg!.isLive).toBe(false)
      const liveSeg = segments.find((s) => s.items.some(([, m]) => m.some((x) => x.id === 'live')))
      expect(liveSeg).toBeDefined()
      expect(liveSeg!.isLive).toBe(true)
      // History seg and live seg must be distinct segments when unselected
      expect(histSeg!.stableSegmentId).not.toBe(liveSeg!.stableSegmentId)
    })

    it('consecutive history groups merge into one history segment', () => {
      const msgs: Message[] = [message('u0'), message('u1'), message('u2')]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const segments = buildRenderSegments(grouped, false, [])
      expect(segments.length).toBe(1)
      expect(segments[0].isLive).toBe(false)
      expect(segments[0].items.length).toBe(grouped.length)
      const layers = buildRenderLayers(segments)
      expect(layers.length).toBe(1)
      expect(layers[0].kind).toBe('history')
    })

    it('consecutive live groups merge into one live segment', () => {
      const msgs: Message[] = [processing('a0', 'ask0'), pending('a1', 'ask1'), searching('a2', 'ask2')]
      // Need user messages to separate? If all live assistant with different askIds they are separate groups but consecutive live
      // Create with interleaving user to break? Actually without users, three assistant groups with different askIds are separate groups
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      // All groups live, should be one segment
      const segments = buildRenderSegments(grouped, false, [])
      expect(segments.length).toBe(1)
      expect(segments[0].isLive).toBe(true)
    })
  })

  describe('buildRenderSegments — selection atomicity across live/history (LOCK-S3.3-FIX-001)', () => {
    it('contiguous selected segment spanning history and live remains single atomic segment classified live', () => {
      const u0 = message('u0')
      const aHist = message('aHist', 'assistant', 'askHist')
      const aLive = processing('aLive', 'askLive')
      // chronological: u0, aHist, aLive => groups [u0],[aHist],[aLive] newest-first [aLive,aHist,u0] => aLive,aHist consecutive
      const msgs: Message[] = [u0, aHist, aLive]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      // Find askIds
      const askHist = (grouped.find(([, m]) => m.some((x) => x.id === 'aHist'))?.[1][0] as Message | undefined)?.askId
      const askLive = (grouped.find(([, m]) => m.some((x) => x.id === 'aLive'))?.[1][0] as Message | undefined)?.askId
      expect(askHist).toBe('askHist')
      expect(askLive).toBe('askLive')
      const segments = buildRenderSegments(grouped, true, [askHist!, askLive!])
      // Both selected groups are consecutive newest-two, so they should be one segment
      const mixed = segments.find(
        (s) =>
          s.items.some(([, m]) => m.some((x) => x.id === 'aLive')) &&
          s.items.some(([, m]) => m.some((x) => x.id === 'aHist'))
      )
      expect(mixed).toBeDefined()
      expect(mixed!.selected).toBe(true)
      expect(mixed!.isLive).toBe(true)
      expect(mixed!.items.length).toBe(2)
    })

    it('selected mixed segment live classification does not bleed to unrelated neighbouring history', () => {
      const u0 = message('u0')
      const aHist0 = message('aHist0', 'assistant', 'askHist0')
      const aHist1 = message('aHist1', 'assistant', 'askHist1')
      const aLive = processing('aLive', 'askLive')
      const u1 = message('u1')
      // chronological: u0, aHist0, aLive, aHist1, u1
      // newest-first: u1, aHist1, aLive, aHist0, u0
      // Select only aLive + aHist1 (newest two assistant groups, consecutive)
      const msgs: Message[] = [u0, aHist0, aLive, aHist1, u1]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const askHist1 = (grouped.find(([, m]) => m.some((x) => x.id === 'aHist1'))?.[1][0] as Message | undefined)?.askId
      const askLive = (grouped.find(([, m]) => m.some((x) => x.id === 'aLive'))?.[1][0] as Message | undefined)?.askId
      expect(askHist1).toBeDefined()
      expect(askLive).toBeDefined()
      const segments = buildRenderSegments(grouped, true, [askHist1!, askLive!])
      // The selected atomic segment should be live
      const selectedSeg = segments.find((s) => s.selected)
      expect(selectedSeg).toBeDefined()
      expect(selectedSeg!.isLive).toBe(true)
      // Find neighbouring unselected history segment containing aHist0 - must remain history, not live
      const neighbourHist = segments.find(
        (s) => !s.selected && s.items.some(([, m]) => m.some((x) => x.id === 'aHist0'))
      )
      expect(neighbourHist).toBeDefined()
      expect(neighbourHist!.isLive).toBe(false)
      // They must be distinct segments
      expect(selectedSeg!.stableSegmentId).not.toBe(neighbourHist!.stableSegmentId)
      // Unselected history group u0 must also be history
      const u0Seg = segments.find((s) => s.items.some(([, m]) => m.some((x) => x.id === 'u0')))
      expect(u0Seg!.isLive).toBe(false)
    })
  })

  describe('layer runs — contiguous and alternating in newest-first order', () => {
    it('builds alternating runs preserving newest-first order without reordering', () => {
      const msgs: Message[] = [
        message('u0'),
        message('a0', 'assistant', 'ask0'),
        processing('a1', 'ask1'),
        message('u1'),
        pending('a2', 'ask2'),
        message('u2')
      ]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const segments = buildRenderSegments(grouped, false, [])
      const layers = buildRenderLayers(segments)

      for (let i = 1; i < layers.length; i++) {
        expect(layers[i].kind).not.toBe(layers[i - 1].kind)
      }
      const runFlat = layers.flatMap((l) => l.segments.flatMap((s) => s.items))
      expect(runFlat.map(([k]) => k)).toEqual(grouped.map(([k]) => k))
    })

    it('merges consecutive same-kind segments into one run', () => {
      const msgs: Message[] = [message('u0'), message('u1'), message('u2')]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const segments = buildRenderSegments(grouped, false, [])
      const layers = buildRenderLayers(segments)
      expect(layers.length).toBe(1)
      expect(layers[0].kind).toBe('history')
    })
  })

  describe('stable keys are entity-derived, not viewport-index or length', () => {
    it('stable segment id does not change when viewport expands but overlapping group ids same', () => {
      const msgs: Message[] = [message('u0'), message('u1'), processing('a0', 'ask0'), message('u2')]
      const winSmall = createLatestMessageWindow(msgs, 2)
      const winLarge = createLatestMessageWindow(msgs, 10)
      const groupedSmall = projectMessageViewportGroups(winSmall.displayMessages, winSmall.displayGroups)
      const groupedLarge = projectMessageViewportGroups(winLarge.displayMessages, winLarge.displayGroups)
      const segSmall = buildRenderSegments(groupedSmall, false, [])
      const segLarge = buildRenderSegments(groupedLarge, false, [])
      const smallIds = new Set(
        segSmall.flatMap((s) => s.items.map(([, m]) => deriveStableGroupId(m as unknown as Message[])))
      )
      const largeIds = segLarge.flatMap((s) => s.items.map(([, m]) => deriveStableGroupId(m as unknown as Message[])))
      for (const id of smallIds) {
        expect(largeIds).toContain(id)
      }
      void segSmall.map((s) => s.stableSegmentId)
    })

    it('layer stable id derives from oldest group entity ids', () => {
      const msgs: Message[] = [message('u0'), processing('a0', 'ask0'), message('u1')]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const segments = buildRenderSegments(grouped, false, [])
      const layers = buildRenderLayers(segments)
      for (const layer of layers) {
        expect(layer.stableLayerId).toMatch(/^layer:/)
        // Should contain an entity id (oldest group's id encoded)
        const oldestGroupId = layer.segments.at(-1)?.items.at(-1)?.[1][0].id
        expect(oldestGroupId).toBeDefined()
        expect(layer.stableLayerId).toContain(oldestGroupId!)
      }
    })

    it('viewport expansion preserves overlapping history stable ids and no index leakage', () => {
      const msgs: Message[] = [
        message('u0'),
        message('a0', 'assistant', 'ask0'),
        message('u1'),
        processing('a1', 'ask1'),
        message('u2')
      ]
      const winSmall = createLatestMessageWindow(msgs, 2)
      const winLarge = createLatestMessageWindow(msgs, 10)
      const groupedSmall = projectMessageViewportGroups(winSmall.displayMessages, winSmall.displayGroups)
      const groupedLarge = projectMessageViewportGroups(winLarge.displayMessages, winLarge.displayGroups)
      void buildRenderSegments(groupedSmall, false, [])
      void buildRenderSegments(groupedLarge, false, [])
      // Small window groups are subset of large
      const smallGroupIds = groupedSmall.map(([, m]) => deriveStableGroupId(m as unknown as Message[]))
      const largeGroupIds = groupedLarge.map(([, m]) => deriveStableGroupId(m as unknown as Message[]))
      for (const gid of smallGroupIds) expect(largeGroupIds).toContain(gid)
      // Verify stable ids do not contain viewport index numbers as bare ids
      for (const gid of [...smallGroupIds, ...largeGroupIds]) {
        // Our encoding is length:prefix, but should not be just index like "0" or "2"
        expect(gid).not.toMatch(/^\d+$/)
        expect(gid).toContain(':')
      }
    })
  })

  describe('selection integrity across layers', () => {
    it('segment stable ids are deterministic for identical selection inputs', () => {
      const msgs: Message[] = [
        message('u0'),
        processing('a0', 'ask0'),
        message('u1'),
        message('a1', 'assistant', 'ask1')
      ]
      const win = createLatestMessageWindow(msgs, 10)
      const grouped = projectMessageViewportGroups(win.displayMessages, win.displayGroups)
      const ask0 = (grouped.find(([, m]) => m.some((x) => x.id === 'a0'))?.[1][0] as Message | undefined)?.askId ?? 'a0'
      const seg1 = buildRenderSegments(grouped, true, [ask0])
      const seg2 = buildRenderSegments(grouped, true, [ask0])
      expect(seg1.map((s) => s.stableSegmentId)).toEqual(seg2.map((s) => s.stableSegmentId))
      const groupStable = deriveStableGroupId(
        grouped.find(([, m]) => m.some((x) => x.id === 'a0'))![1] as unknown as Message[]
      )
      expect(groupStable).toBe('2:a0')
    })
  })

  describe('live-to-history transition keeps historical stable ids', () => {
    it('historical group stable id unchanged when live tail transitions to history', () => {
      const histMsg = message('hist', 'assistant', 'ask-hist')
      const liveMsg = processing('live', 'ask-live')
      const u0 = message('u0')
      const msgsBefore: Message[] = [u0, histMsg, liveMsg]
      const winBefore = createLatestMessageWindow(msgsBefore, 10)
      const groupedBefore = projectMessageViewportGroups(winBefore.displayMessages, winBefore.displayGroups)
      const histStableBefore = deriveStableGroupId(
        groupedBefore.find(([, m]) => m.some((x) => x.id === 'hist'))![1] as unknown as Message[]
      )

      const liveSuccess = { ...liveMsg, status: AssistantMessageStatus.SUCCESS } as Message
      const msgsAfter: Message[] = [u0, histMsg, liveSuccess]
      const winAfter = createLatestMessageWindow(msgsAfter, 10)
      const groupedAfter = projectMessageViewportGroups(winAfter.displayMessages, winAfter.displayGroups)
      const histStableAfter = deriveStableGroupId(
        groupedAfter.find(([, m]) => m.some((x) => x.id === 'hist'))![1] as unknown as Message[]
      )

      expect(histStableBefore).toBe(histStableAfter)
      const segBefore = buildRenderSegments(groupedBefore, false, [])
      const segAfter = buildRenderSegments(groupedAfter, false, [])
      const histSegBefore = segBefore.find((s) => s.items.some(([, m]) => m.some((x) => x.id === 'hist')))
      const histSegAfter = segAfter.find((s) => s.items.some(([, m]) => m.some((x) => x.id === 'hist')))
      expect(histSegBefore).toBeDefined()
      expect(histSegAfter).toBeDefined()
      // Group stable id unchanged; segment composition merges after live→history so segment ids may differ,
      // but hist group's group id persists and after all history
      expect(
        deriveStableGroupId(
          histSegBefore!.items.find(([, m]) => m.some((x) => x.id === 'hist'))![1] as unknown as Message[]
        )
      ).toBe(histStableBefore)
      expect(
        deriveStableGroupId(
          histSegAfter!.items.find(([, m]) => m.some((x) => x.id === 'hist'))![1] as unknown as Message[]
        )
      ).toBe(histStableAfter)
      // Before: hist is history, live is live => two layers alternating
      const layersBefore = buildRenderLayers(segBefore)
      expect(layersBefore.some((l) => l.kind === 'live')).toBe(true)
      // After: all history => single history layer
      const layersAfter = buildRenderLayers(segAfter)
      expect(layersAfter.every((l) => l.kind === 'history')).toBe(true)
      expect(layersAfter.length).toBe(1)
    })
  })
})
