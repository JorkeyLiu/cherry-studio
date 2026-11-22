import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

import type * as messageGroupsModule from '../messageGroups'

const { buildCalls } = vi.hoisted(() => ({ buildCalls: { count: 0 } }))

vi.mock('../messageGroups', async (importOriginal) => {
  const actual = await importOriginal<typeof messageGroupsModule>()
  return {
    ...actual,
    createMessageViewportGroupModel: (messages: Message[]) => {
      buildCalls.count += 1
      return actual.createMessageViewportGroupModel(messages)
    }
  }
})

import {
  createLatestMessageWindow,
  createOldestMessageWindow,
  derivePaginationWindow,
  reconcileWindowWithOutcome
} from '../messageWindow'

const message = (id: string, role: Message['role'] = 'user', askId?: string): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

const users = (count: number): Message[] => Array.from({ length: count }, (_, index) => message(`m${index}`))
const ids = (window: { displayMessages: Message[] }) => window.displayMessages.map(({ id }) => id)

describe('reconcile entity-only refresh', () => {
  it('refreshes latest-edge entities with zero group-model builds', () => {
    const v1: Message[] = [message('u1'), message('a1', 'assistant', 'q1'), message('a2', 'assistant', 'q1')]
    const win = createLatestMessageWindow(v1, 10)
    expect(win.groupCount).toBe(2)

    const v2u1: Message = { ...message('u1'), modelId: 'model-b', folded: true }
    const v2a1: Message = {
      ...message('a1', 'assistant', 'q1'),
      status: AssistantMessageStatus.ERROR,
      blocks: ['b9'],
      usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 }
    }
    const v2a2: Message = { ...message('a2', 'assistant', 'q1'), blocks: ['b10'] }
    const v2: Message[] = [v2u1, v2a1, v2a2]

    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    // Same ordered ids with the same grouping identity: no model build at all.
    expect(buildCalls.count).toBe(0)
    expect(outcome.followsAppendedTail).toBe(false)

    const refreshed = outcome.window
    // The committed window carries the NEW refs, including hidden fields.
    expect(refreshed.displayMessages.find((m) => m.id === 'u1')).toBe(v2u1)
    expect(refreshed.displayMessages.find((m) => m.id === 'a1')).toBe(v2a1)
    expect(refreshed.displayMessages.find((m) => m.id === 'a2')).toBe(v2a2)
    expect(refreshed.displayMessages.find((m) => m.id === 'a1')?.status).toBe(AssistantMessageStatus.ERROR)
    expect(refreshed.displayMessages.find((m) => m.id === 'a1')?.blocks).toEqual(['b9'])
    expect(refreshed.displayMessages.find((m) => m.id === 'a1')?.usage?.total_tokens).toBe(10)
    expect(refreshed.displayMessages.find((m) => m.id === 'u1')?.folded).toBe(true)
    // Window coordination facts are preserved, not re-derived.
    expect(refreshed.range).toEqual(win.range)
    expect(refreshed.edge).toBe('latest')
    expect(refreshed.groupCapacity).toBe(win.groupCapacity)
    expect(refreshed.groupCount).toBe(2)
    expect(refreshed.hasMoreOlder).toBe(win.hasMoreOlder)
    expect(refreshed.hasMoreNewer).toBe(win.hasMoreNewer)
    expect(refreshed.authoritativeHasMoreBefore).toBe(win.authoritativeHasMoreBefore)
    expect(refreshed.authoritativeHasMoreAfter).toBe(win.authoritativeHasMoreAfter)
    expect(refreshed.boundedViewportObservability).toEqual(win.boundedViewportObservability)
    expect(refreshed.oldestMessageId).toBe(win.oldestMessageId)
    expect(refreshed.newestMessageId).toBe(win.newestMessageId)
    // Group structure (keys, order, ranges) is unchanged; members are new refs.
    expect(refreshed.displayGroups.map((group) => group.key)).toEqual(win.displayGroups.map((group) => group.key))
    expect(refreshed.displayGroups.map((group) => group.semanticKey)).toEqual(['message:user:u1', 'assistant:q1'])
    expect(refreshed.displayGroups.map((group) => group.range)).toEqual(win.displayGroups.map((group) => group.range))
    expect(refreshed.displayGroups.flatMap((group) => group.messages)).toEqual([v2u1, v2a1, v2a2])
  })

  it('refreshes a fixed-edge historical range without rebuilding', () => {
    const v1 = users(15)
    const win = createOldestMessageWindow(v1, 10)
    expect(win.edge).toBe('fixed')
    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 9 })

    const v2 = v1.map((m, index) => (index === 3 || index === 14 ? { ...m, blocks: [`b${index}`] } : { ...m }))
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    expect(buildCalls.count).toBe(0)
    expect(outcome.followsAppendedTail).toBe(false)

    const refreshed = outcome.window
    expect(refreshed.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 9 })
    expect(refreshed.edge).toBe('fixed')
    // In-window entities are new refs; the out-of-window change stays out.
    expect(ids(refreshed)).toEqual(ids(win))
    expect(refreshed.displayMessages.find((m) => m.id === 'm3')).toBe(v2[3])
    expect(refreshed.displayMessages.find((m) => m.id === 'm3')?.blocks).toEqual(['b3'])
    expect(ids(refreshed)).not.toContain('m14')
  })

  it('takes the full path on append and mounts the new tail', () => {
    const v1 = users(5)
    const win = createLatestMessageWindow(v1, 10)
    const v2 = [...v1.map((m) => ({ ...m })), message('m5')]

    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(ids(outcome.window)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1', 'm0'])
    expect(outcome.window.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 5 })
  })

  it('takes the full path on reorder and follows the new order', () => {
    const v1 = users(4)
    const win = createLatestMessageWindow(v1, 10)
    const v2 = [v1[0], v1[2], v1[1], v1[3]].map((m) => ({ ...m }))

    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(ids(outcome.window)).toEqual(['m3', 'm1', 'm2', 'm0'])
  })

  it('takes the full path on askId change and regroups', () => {
    const v1: Message[] = [message('u1'), message('a1', 'assistant', 'q1'), message('a2', 'assistant', 'q1')]
    const win = createLatestMessageWindow(v1, 10)
    expect(win.groupCount).toBe(2)

    const v2: Message[] = [
      { ...message('u1') },
      { ...message('a1', 'assistant', 'q1'), status: AssistantMessageStatus.ERROR, blocks: ['b9'] },
      { ...message('a2', 'assistant', 'q2') }
    ]
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(outcome.window.groupCount).toBe(3)
    expect(outcome.window.displayGroups.map((group) => group.messages.map(({ id }) => id))).toEqual([
      ['u1'],
      ['a1'],
      ['a2']
    ])
    expect(outcome.window.displayMessages.find((m) => m.id === 'a1')?.status).toBe(AssistantMessageStatus.ERROR)
  })

  it('takes the full path on delete and re-slices the newest capacity', () => {
    const v1 = users(6)
    const win = createLatestMessageWindow(v1, 4)
    expect(win.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 5 })

    const v2 = [v1[0], v1[1], v1[2], v1[4], v1[5]].map((m) => ({ ...m }))
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(ids(outcome.window)).toEqual(['m5', 'm4', 'm2', 'm1'])
  })

  it('takes the full path when a reading row is held, keeping it resident', () => {
    const v1 = users(15)
    const win = createLatestMessageWindow(v1, 10)
    expect(win.range).toEqual({ oldestGroupIndex: 5, newestGroupIndex: 14 })

    const v2 = v1.map((m) => ({ ...m }))
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win, { retainMessageId: 'm2' })
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(ids(outcome.window)).toContain('m2')
  })

  it('takes the full path on a measured physical bottom and reports follow', () => {
    const v1 = users(5)
    const win = createLatestMessageWindow(v1, 10)
    const v2 = [...v1.map((m) => ({ ...m })), message('m5')]

    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win, { atPhysicalBottom: true })
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(outcome.followsAppendedTail).toBe(true)
    expect(ids(outcome.window)[0]).toBe('m5')
  })

  it('takes the full path for a committed pagination target and retains it', () => {
    const v1 = users(30)
    const base = createLatestMessageWindow(v1, 10)
    const paged = derivePaginationWindow({
      direction: 'older',
      messages: v1,
      currentWindow: base,
      additionalGroupCount: 5,
      responseWindow: {}
    })
    expect(paged.status).toBe('accepted')
    if (paged.status !== 'accepted') throw new Error('unreachable')
    expect(paged.window.paginationTarget).toBe(true)

    const v2 = v1.map((m) => ({ ...m, blocks: m.id === 'm20' ? ['b20'] : [] }))
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, paged.window)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(outcome.window.paginationTarget).toBe(true)
    expect(outcome.window.range).toEqual(paged.window.range)
    expect(outcome.window.displayMessages.find((m) => m.id === 'm20')).toBe(v2[20])
  })

  it('takes the full path when committed rows no longer resolve and rebuilds', () => {
    const v1 = users(5)
    const win = createLatestMessageWindow(v1, 10)
    const v2 = users(5).map((m) => ({ ...m, id: `n${m.id}` }))

    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(ids(outcome.window)).toEqual(['nm4', 'nm3', 'nm2', 'nm1', 'nm0'])
  })

  it('re-slices newest-capacity after retention releases instead of keeping the parked range', () => {
    const v1 = users(15)
    const win = createLatestMessageWindow(v1, 10)
    expect(win.range).toEqual({ oldestGroupIndex: 5, newestGroupIndex: 14 })

    // Round 1: a held reading row parks the latest window before the tail.
    buildCalls.count = 0
    const held = reconcileWindowWithOutcome(v1, v1, win, { retainMessageId: 'm2' })
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(held.window.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 11 })
    expect(held.window.hasMoreNewer).toBe(true)

    // Round 2: the hold is released and only entities change (same ids).
    const v2 = v1.map((m) => (m.id === 'm14' ? { ...m, blocks: ['btail'] } : { ...m }))
    buildCalls.count = 0
    const released = reconcileWindowWithOutcome(v2, v1, held.window)
    // The parked range must not survive the release: the full derivation runs.
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(released.followsAppendedTail).toBe(false)
    expect(released.window.range).toEqual({ oldestGroupIndex: 5, newestGroupIndex: 14 })
    expect(released.window.hasMoreNewer).toBe(false)
    expect(released.window.newestMessageId).toBe('m14')
    expect(released.window.displayMessages.find((m) => m.id === 'm14')).toBe(v2[14])
    expect(released.window.displayMessages.find((m) => m.id === 'm14')?.blocks).toEqual(['btail'])
  })

  it('still refreshes a tail latest window with zero builds when authority reports more newer', () => {
    const v1 = users(15)
    const win = createLatestMessageWindow(v1, 10, { hasMoreBefore: false, hasMoreAfter: true })
    expect(win.range).toEqual({ oldestGroupIndex: 5, newestGroupIndex: 14 })
    // At the resident tail, yet the flag reads true from authority — the gate
    // must prove the tail by row identity, never by this flag.
    expect(win.hasMoreNewer).toBe(true)
    expect(win.newestMessageId).toBe('m14')

    const v2 = v1.map((m) => ({ ...m }))
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    expect(buildCalls.count).toBe(0)
    expect(outcome.window.range).toEqual({ oldestGroupIndex: 5, newestGroupIndex: 14 })
    expect(outcome.window.hasMoreNewer).toBe(true)
    expect(outcome.window.authoritativeHasMoreAfter).toBe(true)
    expect(outcome.window.displayMessages.find((m) => m.id === 'm14')).toBe(v2[14])
  })

  it('fills an underfilled fixed range on same-structure entities instead of preserving it', () => {
    // A route-switch residue: the committed fixed range no longer resolves in
    // the new projection, so the full derivation clamps the old indexes
    // ({0,4} of 15 groups) into an underfilled fixed window.
    const routeA = ['a0', 'a1', 'a2', 'a3', 'a4'].map((id) => message(id))
    const winA = createOldestMessageWindow(routeA, 10)
    expect(winA.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 4 })
    const v1 = users(15)
    const residue = reconcileWindowWithOutcome(v1, v1.slice(0, 5), winA)
    expect(residue.window.edge).toBe('fixed')
    expect(residue.window.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 4 })
    expect(residue.window.groupCount).toBe(5)

    // Same-structure entity update: the original fixed derivation fills the
    // under-capacity range toward newer ({0,4} → {0,9}).
    const v2 = v1.map((m) => (m.id === 'm8' ? { ...m, blocks: ['b8'] } : { ...m }))
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, residue.window)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(outcome.window.edge).toBe('fixed')
    expect(outcome.window.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 9 })
    expect(ids(outcome.window)).toEqual(['m9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0'])
    expect(outcome.window.displayMessages.find((m) => m.id === 'm8')?.blocks).toEqual(['b8'])
    expect(outcome.window.displayMessages.find((m) => m.id === 'm8')).toBe(v2[8])
  })

  it('conservatively rebuilds a cover-all small fixed window with identical output', () => {
    // Whole history under capacity: provably stable, but the simple
    // groupCount < capacity gate declines it — extra model builds, no semantic
    // change. This test locks that cost.
    const v1 = users(4)
    const win = createOldestMessageWindow(v1, 10)
    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 3 })

    const v2 = v1.map((m) => ({ ...m, blocks: m.id === 'm1' ? ['b1'] : [] }))
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v2, v1, win)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(outcome.window.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 3 })
    expect(outcome.window.edge).toBe('fixed')
    expect(ids(outcome.window)).toEqual(['m3', 'm2', 'm1', 'm0'])
    expect(outcome.window.displayMessages.find((m) => m.id === 'm1')).toBe(v2[1])
  })

  it('falls back to a newest-capacity rebuild for an empty committed window', () => {
    const empty = createLatestMessageWindow([], 10)
    expect(empty.range).toBeNull()

    const v1 = users(4)
    buildCalls.count = 0
    const outcome = reconcileWindowWithOutcome(v1, [], empty)
    expect(buildCalls.count).toBeGreaterThan(0)
    expect(ids(outcome.window)).toEqual(['m3', 'm2', 'm1', 'm0'])
    expect(outcome.window.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 3 })
  })
})
