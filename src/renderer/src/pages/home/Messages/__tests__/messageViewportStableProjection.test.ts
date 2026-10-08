/**
 * Stable viewport projection isolation — proves the send/append hot path
 * keeps unmodified history referentially stable while every real change
 * invalidates exactly its owner.
 *
 * Covers: append/new-stub stability of old non-latest groups, newest-marker
 * (index 0) hand-off, render-neutral non-zero index shifts, single-message
 * status/blocks/model/fold/useful/branch updates, pure `updatedAt` topic
 * tolerance vs real topic-field invalidation, window-trim eviction with a
 * bounded cache, and latest-route-switch isolation (no cross-route reuse).
 */
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  areProjectedMessagesEqual,
  areTopicsViewportEqual,
  createViewportProjectionCache,
  isSameViewportPosition,
  projectMessageViewportGroups
} from '../messageViewportProjection'
import { createLatestMessageWindow } from '../messageWindow'

const baseMessage = (id: string, role: Message['role'] = 'user', askId?: string): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

const baseTopic = (): Topic => ({
  id: 'topic',
  assistantId: 'assistant',
  name: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
  messages: []
})

const byId = (groups: ReturnType<typeof projectMessageViewportGroups>, id: string) =>
  groups.flatMap(([, msgs]) => msgs).find((m) => m.id === id)!

describe('viewport projection history isolation', () => {
  it('keeps the pure projector behavior unchanged (stability layer adds no semantic drift)', () => {
    const messages = [baseMessage('u0'), baseMessage('a0', 'assistant', 'ask0'), baseMessage('u1')]
    const window = createLatestMessageWindow(messages, 10)
    const cache = createViewportProjectionCache()
    const stable = cache.project(window.displayMessages, window.displayGroups, 'topic::main')
    const pure = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    expect(stable.map(([k]) => k)).toEqual(pure.map(([k]) => k))
    expect(stable.flatMap(([, m]) => m.map((x) => x.id))).toEqual(pure.flatMap(([, m]) => m.map((x) => x.id)))
  })

  it('append keeps old non-latest groups referentially stable and hands off the newest marker', () => {
    const before: Message[] = [
      baseMessage('u0'),
      baseMessage('a0', 'assistant', 'ask0'),
      baseMessage('u1'),
      baseMessage('a1', 'assistant', 'ask1')
    ]
    const winBefore = createLatestMessageWindow(before, 10)
    const cache = createViewportProjectionCache()
    const gBefore = cache.project(winBefore.displayMessages, winBefore.displayGroups, 'topic::main')

    // Append a new user stub + its answer: newest-first order is [u2, a1-group, u1, a0, u0]-ish.
    const after: Message[] = [...before, baseMessage('u2')]
    const winAfter = createLatestMessageWindow(after, 10)
    const gAfter = cache.project(winAfter.displayMessages, winAfter.displayGroups, 'topic::main')

    // New group exists exactly once.
    expect(gAfter.length).toBe(gBefore.length + 1)
    expect(gAfter[0][1].map((m) => m.id)).toEqual(['u2'])
    expect(gAfter[0][1][0].index).toBe(0)

    // Old non-latest groups: same tuple ref, same member wrapper refs, despite
    // every numeric index shifting by the append.
    for (const [key, msgs] of gBefore.slice(1)) {
      const match = gAfter.find(([k]) => k === key)!
      expect(match).toBeDefined()
      expect(match).toBe(gBefore.find(([k]) => k === key))
      expect(match[1].length).toBe(msgs.length)
      msgs.forEach((m, i) => expect(match[1][i]).toBe(m))
    }

    // Former newest (a1, index 0) handed off: wrapper replaced, now non-zero,
    // while its untouched sibling content is identical.
    const oldNewestBefore = byId(gBefore, 'a1')
    const oldNewestAfter = byId(gAfter, 'a1')
    expect(oldNewestBefore.index).toBe(0)
    expect(oldNewestAfter).not.toBe(oldNewestBefore)
    expect(oldNewestAfter.index).not.toBe(0)
    expect({ ...oldNewestAfter, index: 0 }).toEqual({ ...oldNewestBefore, index: 0 })

    // Non-zero index displacement alone never replaces a wrapper. The pure
    // projector reports the true shifted position (3 -> 4), while the stable
    // cache intentionally carries the stale non-zero index — render-neutral,
    // since the only consumer reads the 0-boundary.
    const pureAfter = projectMessageViewportGroups(winAfter.displayMessages, winAfter.displayGroups)
    const shifted = byId(gAfter, 'u0')
    const shiftedBefore = byId(gBefore, 'u0')
    expect(byId(pureAfter, 'u0').index).toBe(shiftedBefore.index + 1)
    expect(shifted).toBe(shiftedBefore)
    expect(shifted.index).not.toBe(0)
    expect(byId(pureAfter, 'u0').index).not.toBe(0)
  })

  it('a single message status update invalidates only its owner group', () => {
    const a0 = baseMessage('a0', 'assistant', 'ask0')
    const before: Message[] = [baseMessage('u0'), a0, baseMessage('u1')]
    const winBefore = createLatestMessageWindow(before, 10)
    const cache = createViewportProjectionCache()
    const gBefore = cache.project(winBefore.displayMessages, winBefore.displayGroups, 'topic::main')

    const updated = { ...a0, status: AssistantMessageStatus.ERROR }
    const after: Message[] = [before[0], updated, before[2]]
    const winAfter = createLatestMessageWindow(after, 10)
    const gAfter = cache.project(winAfter.displayMessages, winAfter.displayGroups, 'topic::main')

    expect(byId(gAfter, 'a0')).not.toBe(byId(gBefore, 'a0'))
    expect(byId(gAfter, 'a0').status).toBe(AssistantMessageStatus.ERROR)
    expect(byId(gAfter, 'u0')).toBe(byId(gBefore, 'u0'))
    expect(byId(gAfter, 'u1')).toBe(byId(gBefore, 'u1'))
    // Owner group tuple replaced, history groups untouched.
    expect(gAfter.find(([k]) => k === gBefore[1][0])).not.toBe(gBefore[1])
    expect(gAfter.find(([k]) => k === gBefore[0][0])).toBe(gBefore[0])
  })

  it.each([
    ['blocks membership', (m: Message) => ({ ...m, blocks: [...m.blocks, 'b-new'] })],
    ['model assignment', (m: Message) => ({ ...m, model: { id: 'm2', provider: 'p' } })],
    ['fold selection', (m: Message) => ({ ...m, foldSelected: true })],
    ['useful flag', (m: Message) => ({ ...m, useful: true })],
    ['branch ownership', (m: Message) => ({ ...m, branchId: 'branch-1' })],
    ['text-carrying usage', (m: Message) => ({ ...m, usage: { input_tokens: 7 } })]
  ])('a single message %s change invalidates only its owner', (_label, mutate) => {
    expect(_label.length).toBeGreaterThan(0)
    const target = baseMessage('a0', 'assistant', 'ask0')
    const before: Message[] = [baseMessage('u0'), target, baseMessage('u1')]
    const winBefore = createLatestMessageWindow(before, 10)
    const cache = createViewportProjectionCache()
    const gBefore = cache.project(winBefore.displayMessages, winBefore.displayGroups, 'topic::main')

    const after: Message[] = [before[0], mutate(target) as Message, before[2]]
    const winAfter = createLatestMessageWindow(after, 10)
    const gAfter = cache.project(winAfter.displayMessages, winAfter.displayGroups, 'topic::main')

    expect(byId(gAfter, 'a0')).not.toBe(byId(gBefore, 'a0'))
    expect(byId(gAfter, 'u0')).toBe(byId(gBefore, 'u0'))
    expect(byId(gAfter, 'u1')).toBe(byId(gBefore, 'u1'))
  })

  it('window trim evicts dropped wrappers and keeps the cache bounded', () => {
    const messages = Array.from({ length: 8 }, (_, i) => baseMessage(`m${i}`))
    const wide = createLatestMessageWindow(messages, 8)
    const cache = createViewportProjectionCache()
    const gWide = cache.project(wide.displayMessages, wide.displayGroups, 'topic::main')
    expect(cache.size()).toBeLessThanOrEqual(wide.displayMessages.length)

    const narrow = createLatestMessageWindow(messages, 3)
    const gNarrow = cache.project(narrow.displayMessages, narrow.displayGroups, 'topic::main')
    expect(gNarrow).toHaveLength(3)
    // Retained (overlapping newest) wrappers survive the trim.
    for (const [, msgs] of gNarrow) {
      for (const m of msgs) {
        expect(byId(gWide, m.id)).toBe(m)
      }
    }
    expect(cache.size()).toBeLessThanOrEqual(narrow.displayMessages.length)
  })

  it('a latest-route switch never reuses the other route projected entities', () => {
    const shared = baseMessage('shared')
    const routeAMessages: Message[] = [shared, baseMessage('a-only')]
    const routeBMessages: Message[] = [shared, baseMessage('b-only-1'), baseMessage('b-only-2')]
    const winA = createLatestMessageWindow(routeAMessages, 10)
    const winB = createLatestMessageWindow(routeBMessages, 10)
    const cache = createViewportProjectionCache()

    const gA = cache.project(winA.displayMessages, winA.displayGroups, 'topic::main')
    const sharedA = byId(gA, 'shared')
    const gB = cache.project(winB.displayMessages, winB.displayGroups, 'topic::branch-1')

    // Fresh wrappers with route-correct indices — never the other route's objects.
    const sharedB = byId(gB, 'shared')
    expect(sharedB).not.toBe(sharedA)
    expect(sharedB.index).toBe(2)
    expect(byId(gB, 'b-only-2').index).toBe(0)
    expect(cache.size()).toBeLessThanOrEqual(winB.displayMessages.length)

    // Switching back re-projects the first route correctly (no stale reuse).
    const gA2 = cache.project(winA.displayMessages, winA.displayGroups, 'topic::main')
    expect(byId(gA2, 'shared')).not.toBe(sharedB)
    expect(byId(gA2, 'a-only').index).toBe(0)
  })

  it('projected message comparison ignores only render-neutral index displacement', () => {
    const base = { ...baseMessage('m'), index: 5 }
    expect(areProjectedMessagesEqual(base, { ...baseMessage('m'), index: 7 })).toBe(true)
    expect(isSameViewportPosition(5, 7)).toBe(true)
    expect(areProjectedMessagesEqual(base, { ...baseMessage('m'), index: 0 })).toBe(false)
    expect(areProjectedMessagesEqual({ ...baseMessage('m'), index: 0 }, { ...baseMessage('m'), index: 2 })).toBe(false)
    // Real field changes always invalidate — never ID-only equality.
    expect(
      areProjectedMessagesEqual(base, { ...base, status: AssistantMessageStatus.ERROR } as Message & { index: number })
    ).toBe(false)
    expect(areProjectedMessagesEqual(base, { ...base, foldSelected: true } as Message & { index: number })).toBe(false)
    expect(areProjectedMessagesEqual(base, { ...base, useful: true } as Message & { index: number })).toBe(false)
    expect(
      areProjectedMessagesEqual(base, { ...base, model: { id: 'x', provider: 'p' } } as Message & { index: number })
    ).toBe(false)
    expect(areProjectedMessagesEqual(base, { ...base, blocks: ['b1'] } as Message & { index: number })).toBe(false)
    expect(areProjectedMessagesEqual(base, { ...baseMessage('other'), index: 5 })).toBe(false)
    // Same ordered block membership is not a content change at this boundary
    // (content commits arrive via per-message child subscriptions).
    const withBlocks = { ...base, blocks: ['b1', 'b2'] }
    expect(areProjectedMessagesEqual(withBlocks, { ...withBlocks, blocks: ['b1', 'b2'] })).toBe(true)
    expect(areProjectedMessagesEqual(withBlocks, { ...withBlocks, blocks: ['b2', 'b1'] })).toBe(false)
  })

  it('topic comparison ignores only the pure updatedAt send bump', () => {
    const topic = baseTopic()
    expect(areTopicsViewportEqual(topic, { ...topic })).toBe(true)
    expect(areTopicsViewportEqual(topic, { ...topic, updatedAt: '2026-07-20T00:00:00.000Z' })).toBe(true)
    // Every other user-visible topic field invalidates.
    expect(areTopicsViewportEqual(topic, { ...topic, name: 'renamed' })).toBe(false)
    expect(areTopicsViewportEqual(topic, { ...topic, prompt: 'p' })).toBe(false)
    expect(areTopicsViewportEqual(topic, { ...topic, pinned: true })).toBe(false)
    expect(areTopicsViewportEqual(topic, { ...topic, assistantId: 'other' })).toBe(false)
    expect(areTopicsViewportEqual(topic, { ...topic, deletedAt: 'x' })).toBe(false)
    // Message carrier: identical entities (re-wrapped carrier) stay stable,
    // any entity replacement invalidates.
    const m = baseMessage('m0')
    const withMessages = { ...topic, messages: [m] }
    expect(areTopicsViewportEqual(withMessages, { ...topic, messages: [m] })).toBe(true)
    expect(areTopicsViewportEqual(withMessages, { ...topic, messages: [{ ...m }] })).toBe(false)
    expect(areTopicsViewportEqual(withMessages, { ...topic, messages: [] })).toBe(false)
  })
})
