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
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
} from '../messageWindow'

const CALIBRATION_DEFAULT = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT

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

const users = (count: number): Message[] => Array.from({ length: count }, (_, i) => message(`m${i}`))

const ids = (w: { displayMessages: Message[] }) => w.displayMessages.map(({ id }) => id)

describe('derivePaginationWindow shared group model', () => {
  it('builds one group model for an over-capacity older page shared by guard and expansion', () => {
    const messages = users(400)
    const win = createLatestMessageWindow(messages, CALIBRATION_DEFAULT)
    expect(win.range).toEqual({ oldestGroupIndex: 200, newestGroupIndex: 399 })

    buildCalls.count = 0
    const outcome = derivePaginationWindow({
      direction: 'older',
      messages,
      currentWindow: win,
      additionalGroupCount: 50,
      responseWindow: {}
    })
    expect(outcome.status).toBe('accepted')
    if (outcome.status !== 'accepted') throw new Error('unreachable')

    // The guard and the expansion resolve the same array: one shared model.
    expect(buildCalls.count).toBe(1)
    // Same committed page as the legacy two-model derivation.
    expect(outcome.window.range).toEqual({ oldestGroupIndex: 150, newestGroupIndex: 349 })
    expect(outcome.window.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(outcome.window.paginationTarget).toBe(true)
  })

  it('pages newer at the capacity bound without splitting a same-askId assistant group', () => {
    const messages = users(400)
    for (const i of [240, 241, 242]) messages[i] = message(`m${i}`, 'assistant', 'qa')
    const win = createOldestMessageWindow(messages, CALIBRATION_DEFAULT)
    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 199 })

    const outcome = derivePaginationWindow({
      direction: 'newer',
      messages,
      currentWindow: win,
      additionalGroupCount: 50,
      responseWindow: { hasMoreBefore: false, hasMoreAfter: true }
    })
    expect(outcome.status).toBe('accepted')
    if (outcome.status !== 'accepted') throw new Error('unreachable')
    const paged = outcome.window

    // Opposite-edge (older) trim keeps the window at the bound.
    expect(paged.range).toEqual({ oldestGroupIndex: 50, newestGroupIndex: 249 })
    expect(paged.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(paged.oldestMessageId).toBe('m50')
    expect(paged.newestMessageId).toBe('m251')
    // The trimmed older edge stays locally traversable; the loaded newer edge
    // carries the response authority verbatim.
    expect(paged.hasMoreOlder).toBe(true)
    expect(paged.hasMoreNewer).toBe(true)
    expect(paged.authoritativeHasMoreBefore).toBe(false)
    expect(paged.authoritativeHasMoreAfter).toBe(true)
    // The three consecutive same-askId assistants resolve as one group, intact.
    const qa = paged.displayGroups.find((group) => group.semanticKey === 'assistant:qa')
    expect(qa?.messages.map(({ id }) => id)).toEqual(['m240', 'm241', 'm242'])
    // Route order is never re-sorted: display is newest-first over the slice.
    const chronological = [...messages.slice(50, 240), ...messages.slice(240, 243), ...messages.slice(243, 252)]
    expect(ids(paged)).toEqual(chronological.map(({ id }) => id).toReversed())
  })

  it('keeps the retained reading row resident when a newer page trims the older edge', () => {
    const messages = users(400)
    const win = createOldestMessageWindow(messages, CALIBRATION_DEFAULT)
    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 199 })

    const outcome = derivePaginationWindow({
      direction: 'newer',
      messages,
      currentWindow: win,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm10'
    })
    expect(outcome.status).toBe('accepted')
    if (outcome.status !== 'accepted') throw new Error('unreachable')
    const paged = outcome.window

    // Retention wins over the exact bound: the trim stops at the held row and
    // the window overshoots by the retained growth instead of unmounting it.
    expect(paged.range).toEqual({ oldestGroupIndex: 10, newestGroupIndex: 249 })
    expect(paged.oldestMessageId).toBe('m10')
    expect(ids(paged)).toContain('m10')
    expect(paged.boundedViewportObservability?.trimmedEdge).toBe('older')
    expect(paged.boundedViewportObservability?.trimmedGroups).toBe(10)
    expect(paged.boundedViewportObservability?.retentionClamped).toBe(true)
  })

  it('emits fresh entity refs and regroups when successive calls reuse ids with new entities', () => {
    const v1: Message[] = [message('u1'), message('a1', 'assistant', 'q1'), message('a2', 'assistant', 'q1')]
    const win = createLatestMessageWindow(v1, 10)
    expect(win.groupCount).toBe(2)

    const v2u1 = message('u1')
    const v2a1: Message = {
      ...message('a1', 'assistant', 'q1'),
      status: AssistantMessageStatus.ERROR,
      blocks: ['b9']
    }
    const v2a2: Message = { ...message('a2', 'assistant', 'q2'), blocks: [] }
    const v2: Message[] = [v2u1, v2a1, v2a2]

    const outcome = derivePaginationWindow({
      direction: 'older',
      messages: v2,
      currentWindow: win,
      additionalGroupCount: 5,
      responseWindow: {}
    })
    expect(outcome.status).toBe('accepted')
    if (outcome.status !== 'accepted') throw new Error('unreachable')
    const paged = outcome.window

    // Same ids, new entities: the committed window carries the NEW refs, never
    // a cached previous-call object.
    expect(paged.displayMessages.find((m) => m.id === 'a1')).toBe(v2a1)
    expect(paged.displayMessages.find((m) => m.id === 'a2')).toBe(v2a2)
    expect(paged.displayMessages.find((m) => m.id === 'u1')).toBe(v2u1)
    expect(paged.displayMessages.find((m) => m.id === 'a1')?.status).toBe(AssistantMessageStatus.ERROR)
    expect(paged.displayMessages.find((m) => m.id === 'a1')?.blocks).toEqual(['b9'])
    // The askId change regroups: a1 and a2 no longer share one group.
    expect(paged.groupCount).toBe(3)
    expect(paged.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 2 })
    expect(paged.displayGroups.map((group) => group.messages.map(({ id }) => id))).toEqual([['u1'], ['a1'], ['a2']])
    expect(paged.paginationTarget).toBe(true)
  })

  it('rebuilds a newest-capacity window with preserved authority when the committed rows no longer resolve', () => {
    const emptyCommitted = createLatestMessageWindow([], 10, { hasMoreBefore: true, hasMoreAfter: false })
    expect(emptyCommitted.range).toBeNull()

    const outcome = derivePaginationWindow({
      direction: 'older',
      messages: users(10),
      currentWindow: emptyCommitted,
      additionalGroupCount: 5,
      responseWindow: {}
    })
    expect(outcome.status).toBe('accepted')
    if (outcome.status !== 'accepted') throw new Error('unreachable')
    const rebuilt = outcome.window

    // Not a paged range: newest-capacity rebuild, never a browsing target.
    expect(rebuilt.range).toEqual({ oldestGroupIndex: 5, newestGroupIndex: 9 })
    expect(rebuilt.paginationTarget).toBeUndefined()
    // The committed authority travels with the fallback; route order holds.
    expect(rebuilt.authoritativeHasMoreBefore).toBe(true)
    expect(rebuilt.authoritativeHasMoreAfter).toBe(false)
    expect(rebuilt.hasMoreOlder).toBe(true)
    expect(rebuilt.hasMoreNewer).toBe(false)
    expect(ids(rebuilt)).toEqual(['m9', 'm8', 'm7', 'm6', 'm5'])
  })

  it('declines a retention-conflicting page without touching the committed window', () => {
    const messages = users(400)
    const base = createLatestMessageWindow(messages, CALIBRATION_DEFAULT)

    const first = derivePaginationWindow({
      direction: 'older',
      messages,
      currentWindow: base,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm390'
    })
    expect(first.status).toBe('accepted')
    if (first.status !== 'accepted') throw new Error('unreachable')
    expect(first.window.range).toEqual({ oldestGroupIndex: 150, newestGroupIndex: 390 })
    expect(first.window.hasMoreOlder).toBe(true)
    expect(first.window.hasMoreNewer).toBe(true)

    const committedIds = ids(first.window)
    const second = derivePaginationWindow({
      direction: 'older',
      messages,
      currentWindow: first.window,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm390'
    })
    // The decline publishes nothing: flags and order stay exactly as committed.
    expect(second).toEqual({ status: 'declined', reason: 'retention-exceeds-bound' })
    expect(first.window.range).toEqual({ oldestGroupIndex: 150, newestGroupIndex: 390 })
    expect(ids(first.window)).toEqual(committedIds)
    expect(first.window.hasMoreOlder).toBe(true)
    expect(first.window.hasMoreNewer).toBe(true)
  })
})
