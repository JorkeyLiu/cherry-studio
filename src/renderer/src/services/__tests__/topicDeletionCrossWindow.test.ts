import {
  clearAllLatestWindowCompleteness,
  getLatestWindowCompleteness,
  setLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import {
  clearAllContextClosureCache,
  getCachedContextClosure,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import {
  getDeletionGeneration,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'
import store from '@renderer/store'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeClosure(topicId: string): FetchContextClosureResponse {
  return {
    messages: [{ id: 'u1', role: 'user' } as any],
    blocks: [],
    closure: {
      completeness: 'context-closure',
      topicId,
      anchorGroupKey: 'u1',
      firstMessageId: 'u1',
      lastMessageId: 'u1',
      returnedCount: 1,
      totalTurnCount: 1,
      selectedTurnCount: 1,
      boundaryMessageId: null
    }
  }
}

describe('topicDeletion cross-window event', () => {
  let trigger: (e: unknown) => void
  const mockOnTopicDeleted = vi.fn((cb: (e: unknown) => void) => {
    trigger = cb
    return vi.fn()
  })

  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
    clearAllLatestWindowCompleteness()
    resetAllClosureStateForTests()
    clearAllContextClosureCache()
    // reset store topic
    const state = store.getState()
    for (const tid of Object.keys(state.messages.messageIdsByTopic)) {
      const mids = state.messages.messageIdsByTopic[tid]
      if (mids?.length) store.dispatch(newMessagesActions.removeMessages({ topicId: tid, messageIds: mids }))
    }
    const blockIds = Object.keys(store.getState().messageBlocks.entities)
    if (blockIds.length) store.dispatch(removeManyBlocks(blockIds))
    vi.clearAllMocks()
    // install mock api
    ;(globalThis as unknown as { window: unknown }).window = globalThis as unknown as Window & typeof globalThis
    const w = globalThis as unknown as { api: unknown }
    w.api = { chatDb: { onTopicDeleted: mockOnTopicDeleted } }
  })

  it('event with authoritative ids invalidates resident projections in receiving window', async () => {
    const t = 't-cross-1'
    const msg = { id: 'm-cross', topicId: t, role: 'user', blocks: ['b-cross'] } as any
    const blk = { id: 'b-cross', messageId: 'm-cross', type: 'main_text', content: 'c' } as any
    store.dispatch(newMessagesActions.messagesReceived({ topicId: t, messages: [msg] }))
    store.dispatch(upsertManyBlocks([blk]))
    setLatestWindowCompleteness(t, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(t, makeClosure(t), 'fp')
    // subscribe
    const { subscribeTopicDeletionEvents } = await import('@renderer/services/topicDeletionSubscription')
    subscribeTopicDeletionEvents()
    expect(mockOnTopicDeleted).toHaveBeenCalled()
    // trigger event as if from Main broadcast (other window's deletion)
    trigger({ deletedTopicIds: [t] })
    expect(getDeletionGeneration(t)).toBe(1)
    expect(getLatestWindowCompleteness(t)).toBeUndefined()
    expect(getCachedContextClosure(t)).toBeNull()
    const state = store.getState()
    expect(state.messages.entities['m-cross']).toBeUndefined()
    expect(state.messageBlocks.entities['b-cross']).toBeUndefined()
  })

  it('invalid event payload is discarded', async () => {
    const { subscribeTopicDeletionEvents } = await import('@renderer/services/topicDeletionSubscription')
    subscribeTopicDeletionEvents()
    const t = 't-cross-invalid'
    setLatestWindowCompleteness(t, { hasMoreBefore: true, hasMoreAfter: false })
    trigger({ deletedTopicIds: [''] } as unknown)
    // should not invalidate
    expect(getDeletionGeneration(t)).toBe(0)
    expect(getLatestWindowCompleteness(t)).toBeDefined()
  })
})
