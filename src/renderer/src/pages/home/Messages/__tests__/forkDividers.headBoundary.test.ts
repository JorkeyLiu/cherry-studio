import type { TopicBranchWire } from '@renderer/services/db/types'
import type { Message } from '@renderer/types/newMessage'
import { UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { resolveForkDividers } from '../messageFlowNodes'
import {
  createLatestMessageWindow,
  derivePaginationWindow,
  isHistoryHeadLoaded,
  type MessageWindow
} from '../messageWindow'

const branch = (over: Partial<TopicBranchWire> & { id: string; anchorMessageId: string }): TopicBranchWire => ({
  topicId: 't1',
  parentBranchId: null,
  name: null,
  createdAt: null,
  updatedAt: null,
  ...over
})

describe('resolveForkDividers — inheritance boundary placement', () => {
  it('places a non-empty boundary on the resident last inherited message', () => {
    const children = new Map([
      [
        'm-anchor',
        [
          branch({
            id: 'b1',
            anchorMessageId: 'm-anchor',
            inheritedBoundary: { kind: 'message', messageId: 'm-anchor' }
          })
        ]
      ]
    ])
    const out = resolveForkDividers({
      displayMessageIds: new Set(['m-anchor']),
      childrenByAnchor: children,
      activeBranchId: null
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ placement: 'message', boundaryMessageId: 'm-anchor', parentBranchId: null })
  })

  it('keeps an unloaded non-empty boundary offscreen instead of promoting it to the head', () => {
    const children = new Map([
      [
        'm-anchor',
        [
          branch({
            id: 'b1',
            anchorMessageId: 'm-anchor',
            inheritedBoundary: { kind: 'message', messageId: 'm-anchor' }
          })
        ]
      ]
    ])
    // Older page not loaded: the anchor row is not resident. Not a head fork.
    const out = resolveForkDividers({
      displayMessageIds: new Set(['m-newest']),
      childrenByAnchor: children,
      activeBranchId: null
    })
    expect(out).toEqual([])
  })

  it('places a head boundary on its parent route with no resident prefix row', () => {
    const children = new Map([
      [
        'm-deleted',
        [
          branch({
            id: 'b1',
            anchorMessageId: 'm-deleted',
            inheritedBoundary: { kind: 'head', messageId: null }
          })
        ]
      ]
    ])
    const out = resolveForkDividers({
      displayMessageIds: new Set(['m-after-fork']),
      childrenByAnchor: children,
      activeBranchId: null,
      historyHeadLoaded: true
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      placement: 'head',
      boundaryMessageId: null,
      anchorMessageId: 'm-deleted',
      parentBranchId: null
    })
  })

  it('keeps a head boundary offscreen on an unrelated route (no descent through the fork)', () => {
    const children = new Map([
      [
        'm-deleted',
        [branch({ id: 'b1', anchorMessageId: 'm-deleted', inheritedBoundary: { kind: 'head', messageId: null } })]
      ]
    ])
    // A branch elsewhere in the topic: the relation does not address this route.
    const out = resolveForkDividers({
      displayMessageIds: new Set(['m-elsewhere']),
      childrenByAnchor: children,
      activeBranchId: 'b-unrelated',
      activeRoutePath: ['b-unrelated'],
      historyHeadLoaded: true
    })
    expect(out).toEqual([])
  })

  it('places the head boundary on the fork direct child route so the parent stays reachable', () => {
    const children = new Map([
      [
        'm-deleted',
        [branch({ id: 'b1', anchorMessageId: 'm-deleted', inheritedBoundary: { kind: 'head', messageId: null } })]
      ]
    ])
    // Viewing the child that inherits nothing: its own history may be empty, but
    // the head fork must stay visible to switch back to the parent route.
    for (const displayMessageIds of [new Set<string>(), new Set(['m-child-own'])]) {
      const out = resolveForkDividers({
        displayMessageIds,
        childrenByAnchor: children,
        activeBranchId: 'b1',
        activeRoutePath: ['b1'],
        historyHeadLoaded: true
      })
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({
        placement: 'head',
        boundaryMessageId: null,
        anchorMessageId: 'm-deleted',
        parentBranchId: null
      })
      expect(out[0].children.map((c) => c.id)).toEqual(['b1'])
    }
  })

  it('places the head boundary on a route descending through the fork direct child', () => {
    const children = new Map([
      [
        'm-deleted',
        [branch({ id: 'b1', anchorMessageId: 'm-deleted', inheritedBoundary: { kind: 'head', messageId: null } })]
      ]
    ])
    const out = resolveForkDividers({
      displayMessageIds: new Set(['m-grandchild-own']),
      childrenByAnchor: children,
      activeBranchId: 'b1-child',
      activeRoutePath: ['b1', 'b1-child'],
      historyHeadLoaded: true
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ placement: 'head', parentBranchId: null })
  })

  it('never places a head boundary while the older page is unloaded or the edge fact is unknown', () => {
    const children = new Map([
      [
        'm-deleted',
        [branch({ id: 'b1', anchorMessageId: 'm-deleted', inheritedBoundary: { kind: 'head', messageId: null } })]
      ]
    ])
    // Loaded window is only the newest suffix: the real head is offscreen, so
    // pagination never pins the divider to the viewport top.
    expect(
      resolveForkDividers({
        displayMessageIds: new Set(['m-newest']),
        childrenByAnchor: children,
        activeBranchId: null,
        historyHeadLoaded: false
      })
    ).toEqual([])
    // Unknown edge fact is not evidence of an empty prefix.
    expect(
      resolveForkDividers({
        displayMessageIds: new Set(['m-newest']),
        childrenByAnchor: children,
        activeBranchId: null
      })
    ).toEqual([])
  })

  it('falls back to the resident anchor row when the boundary fact is absent (never the head)', () => {
    const children = new Map([['m-anchor', [branch({ id: 'b1', anchorMessageId: 'm-anchor' })]]])
    const anchored = resolveForkDividers({
      displayMessageIds: new Set(['m-anchor']),
      childrenByAnchor: children,
      activeBranchId: null
    })
    expect(anchored).toHaveLength(1)
    expect(anchored[0]).toMatchObject({ placement: 'message', boundaryMessageId: 'm-anchor' })
    expect(
      resolveForkDividers({ displayMessageIds: new Set(), childrenByAnchor: children, activeBranchId: null })
    ).toEqual([])
  })

  it('keeps every sibling at one head under a single divider identity', () => {
    const children = new Map([
      [
        'm-deleted',
        [
          branch({ id: 'b1', anchorMessageId: 'm-deleted', inheritedBoundary: { kind: 'head', messageId: null } }),
          branch({
            id: 'b2',
            anchorMessageId: 'm-deleted',
            createdAt: '2024-01-01T00:00:00.000Z',
            inheritedBoundary: { kind: 'head', messageId: null }
          })
        ]
      ]
    ])
    const out = resolveForkDividers({
      displayMessageIds: new Set(),
      childrenByAnchor: children,
      activeBranchId: null,
      historyHeadLoaded: true
    })
    expect(out).toHaveLength(1)
    expect(out[0].children.map((c) => c.id)).toEqual(['b1', 'b2'])
  })
})

describe('head fork placement reads the displayed history head, not Main alone', () => {
  const message = (id: string): Message => ({
    id,
    role: 'user',
    assistantId: 'assistant',
    topicId: 't1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: []
  })
  const loaded = Array.from({ length: 14 }, (_, i) => message(`m${i < 10 ? `0${i}` : i}`))
  const capacity = 10
  const exhausted = { hasMoreBefore: false, hasMoreAfter: false }
  const children = new Map([
    [
      'm-deleted',
      [branch({ id: 'b1', anchorMessageId: 'm-deleted', inheritedBoundary: { kind: 'head', messageId: null } })]
    ]
  ])
  const headPlacements = (window: MessageWindow) =>
    resolveForkDividers({
      displayMessageIds: new Set(window.displayMessages.map((m) => m.id)),
      childrenByAnchor: children,
      activeBranchId: null,
      historyHeadLoaded: isHistoryHeadLoaded(window)
    })

  it('keeps the head fork offscreen while resident older groups are still browsable', () => {
    // Main reports no older page, but the display shows only the newest 10 of 14
    // resident groups: the true history head is one local page away.
    const tail = createLatestMessageWindow(loaded, capacity, exhausted)
    expect(tail.hasMoreOlder).toBe(true)
    expect(headPlacements(tail)).toEqual([])
  })

  it('places the head fork once the display actually reaches the history head', () => {
    const tail = createLatestMessageWindow(loaded, capacity, exhausted)
    const outcome = derivePaginationWindow({
      direction: 'older',
      messages: loaded,
      currentWindow: tail,
      additionalGroupCount: capacity,
      responseWindow: exhausted
    })
    expect(outcome.status).toBe('accepted')
    if (outcome.status !== 'accepted') throw new Error('unreachable')

    expect(outcome.window.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 13 })
    const placements = headPlacements(outcome.window)
    expect(placements).toHaveLength(1)
    expect(placements[0]).toMatchObject({ placement: 'head', boundaryMessageId: null, anchorMessageId: 'm-deleted' })
  })
})
