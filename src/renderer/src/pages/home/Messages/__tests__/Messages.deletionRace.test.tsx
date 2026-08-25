/**
 * Focused race for Messages viewport before subscription (finding 2).
 * Uses helper-level immediate invocation semantics which Messages subscribes through.
 */
import {
  bumpDeletionGeneration,
  resetAllDeletionGenerationsForTests,
  subscribeDeletionGeneration
} from '@renderer/services/topicDeletionInvalidation'
import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMessageViewportState, messageViewportReducer } from '../messageViewportReducer'
import { createLatestMessageWindow } from '../messageWindow'
import { createViewportCommitWaiter } from '../viewportCommitWaiter'

function makeMessage(id: string, topicId: string): Message {
  return {
    id,
    topicId,
    role: 'user',
    content: id,
    blocks: [],
    createdAt: '2026-01-01T00:00:00.000Z'
  } as unknown as Message
}

beforeEach(() => {
  resetAllDeletionGenerationsForTests()
})

describe('Messages deletion before subscription race (focused)', () => {
  it('subscription immediately invalidates already-deleted topic viewport (synchronous)', () => {
    const topicId = 't-race-deleted'
    // Deletion before subscription
    bumpDeletionGeneration(topicId)

    const messages = [makeMessage('m1', topicId), makeMessage('m2', topicId)]
    const win = createLatestMessageWindow(messages, 10)
    const state = createMessageViewportState(win)
    expect(state.window?.displayMessages.length).toBe(2)

    const cache = new Map<string, unknown>()
    cache.set(topicId, { window: win })
    const waiter = createViewportCommitWaiter<typeof state>()
    const cleared: string[] = []
    const clear = (k: string) => cleared.push(k)
    let recent = state
    // This mirrors Messages useEffect subscription body
    const invalidate = () => {
      cache.delete(topicId)
      clear('loadMoreMessages')
      clear('loadNewerMessages')
      waiter.cancelAll()
      recent = messageViewportReducer(recent, { type: 'topic/reset' })
    }

    // Subscribe after deletion — immediate helper should invoke synchronously
    const unsub = subscribeDeletionGeneration(topicId, () => invalidate())
    expect(cache.has(topicId)).toBe(false)
    expect(recent.window).toBeNull()
    expect(recent.topicGeneration).toBeGreaterThanOrEqual(1)
    expect(cleared).toContain('loadMoreMessages')
    expect(cleared).toContain('loadNewerMessages')
    const genAfterFirst = recent.topicGeneration
    // Idempotent second call: window stays null, generation may advance but not revert
    invalidate()
    expect(recent.window).toBeNull()
    expect(recent.topicGeneration).toBeGreaterThanOrEqual(genAfterFirst)
    unsub()
  })

  it('unrelated topic not invalidated when deleted before subscription for other topic', () => {
    const deleted = 't-deleted-pre'
    const alive = 't-alive'
    bumpDeletionGeneration(deleted)

    const winAlive = createLatestMessageWindow([makeMessage('m1', alive)], 10)
    const stateAlive = createMessageViewportState(winAlive)
    const cache = new Map<string, unknown>()
    cache.set(alive, { window: winAlive })
    cache.set(deleted, { window: winAlive })

    let aliveFired = 0
    const unsubAlive = subscribeDeletionGeneration(alive, () => {
      aliveFired++
    })
    expect(aliveFired).toBe(0)
    expect(cache.has(alive)).toBe(true)
    expect(stateAlive.window).not.toBeNull()

    let deletedFired = 0
    const unsubDeleted = subscribeDeletionGeneration(deleted, () => {
      deletedFired++
    })
    expect(deletedFired).toBe(1)

    unsubAlive()
    unsubDeleted()
    void stateAlive
  })

  it('soft-delete (no bump) before subscription preserves viewport', () => {
    const topicId = 't-soft'
    const win = createLatestMessageWindow([makeMessage('m1', topicId)], 10)
    let state = createMessageViewportState(win)
    const cache = new Map<string, unknown>()
    cache.set(topicId, { window: win })
    let fired = 0
    const unsub = subscribeDeletionGeneration(topicId, () => {
      fired++
      state = messageViewportReducer(state, { type: 'topic/reset' })
    })
    expect(fired).toBe(0)
    expect(state.window).not.toBeNull()
    expect(cache.has(topicId)).toBe(true)
    unsub()
  })
})
