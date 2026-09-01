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
  invalidateTopicsDeletion,
  isDeletionStale,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'
import store from '@renderer/store'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { clearSegmentsForTopic, loadSegments } from '@renderer/store/topicSegment'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeClosure(topicId: string, anchor: string): FetchContextClosureResponse {
  return {
    messages: [{ id: anchor, role: 'user' } as any, { id: 'a1', role: 'assistant', askId: anchor } as any],
    blocks: [],
    closure: {
      completeness: 'context-closure',
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: anchor,
      lastMessageId: 'a1',
      returnedCount: 2,
      totalTurnCount: 1,
      selectedTurnCount: 1,
      boundaryMessageId: null
    }
  }
}

describe('topicDeletion precise resident cleanup', () => {
  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
    clearAllLatestWindowCompleteness()
    resetAllClosureStateForTests()
    clearAllContextClosureCache()
    // clear Redux state for tested topics
    store.dispatch(newMessagesActions.setCurrentTopicId(null))
    // need to reset messages for topics used: we will directly dispatch remove
    // For isolation, clear all known test topics
    const state = store.getState()
    for (const tid of Object.keys(state.messages.messageIdsByTopic)) {
      const mids = state.messages.messageIdsByTopic[tid]
      if (mids?.length) store.dispatch(newMessagesActions.removeMessages({ topicId: tid, messageIds: mids }))
      store.dispatch(newMessagesActions.setTopicLoading({ topicId: tid, loading: false }))
      store.dispatch(newMessagesActions.setTopicFulfilled({ topicId: tid, fulfilled: false }))
      store.dispatch(clearSegmentsForTopic(tid))
    }
    // clear blocks
    const blockState = store.getState().messageBlocks
    const allBlockIds = Object.keys(blockState.entities)
    if (allBlockIds.length) store.dispatch(removeManyBlocks(allBlockIds))
  })

  it('precisely clears message IDs/entities for deleted topic and preserves other topic', () => {
    const tDel = 't-precise-del'
    const tKeep = 't-precise-keep'
    const msgDel1 = { id: 'm-del-1', topicId: tDel, role: 'user', blocks: ['b-del-1'] } as any
    const msgDel2 = { id: 'm-del-2', topicId: tDel, role: 'assistant', askId: 'm-del-1', blocks: ['b-del-2'] } as any
    const msgKeep = { id: 'm-keep-1', topicId: tKeep, role: 'user', blocks: ['b-keep-1'] } as any
    const bDel1 = { id: 'b-del-1', messageId: 'm-del-1', type: 'main_text', content: 'c1' } as any
    const bDel2 = { id: 'b-del-2', messageId: 'm-del-2', type: 'main_text', content: 'c2' } as any
    const bKeep = { id: 'b-keep-1', messageId: 'm-keep-1', type: 'main_text', content: 'keep' } as any
    store.dispatch(newMessagesActions.messagesReceived({ topicId: tDel, messages: [msgDel1, msgDel2] }))
    store.dispatch(newMessagesActions.messagesReceived({ topicId: tKeep, messages: [msgKeep] }))
    store.dispatch(upsertManyBlocks([bDel1, bDel2, bKeep]))
    setLatestWindowCompleteness(tDel, { hasMoreBefore: true, hasMoreAfter: false })
    setLatestWindowCompleteness(tKeep, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(tDel, makeClosure(tDel, 'm-del-1'), 'fp-del')
    store.dispatch(loadSegments([{ id: 'seg-1', topicId: tDel, name: 's1', messageIds: ['m-del-1'] } as any]))
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: tDel, loading: true }))
    store.dispatch(newMessagesActions.setTopicFulfilled({ topicId: tDel, fulfilled: true }))

    invalidateTopicsDeletion([tDel])

    expect(getDeletionGeneration(tDel)).toBe(1)
    expect(getLatestWindowCompleteness(tDel)).toBeUndefined()
    expect(getCachedContextClosure(tDel)).toBeNull()
    const state = store.getState()
    expect(state.messages.messageIdsByTopic[tDel]).toEqual([])
    expect(state.messages.entities['m-del-1']).toBeUndefined()
    expect(state.messages.entities['m-del-2']).toBeUndefined()
    expect(state.messageBlocks.entities['b-del-1']).toBeUndefined()
    expect(state.messageBlocks.entities['b-del-2']).toBeUndefined()
    // preserve other topic
    expect(state.messages.messageIdsByTopic[tKeep]).toEqual(['m-keep-1'])
    expect(state.messageBlocks.entities['b-keep-1']).toBeDefined()
    expect(getLatestWindowCompleteness(tKeep)).toBeDefined()
    // segments cleared
    expect(state.topicSegments.segmentsByTopic[tDel]).toBeUndefined()
    expect(state.messages.loadingByTopic[tDel]).toBe(false)
    expect(state.messages.fulfilledByTopic[tDel]).toBe(false)
  })

  it('exclusive block removal preserves shared block', () => {
    const tDel = 't-excl-del'
    const tKeep = 't-excl-keep'
    const sharedBlockId = 'b-shared'
    const msgDel = { id: 'm-del-shared', topicId: tDel, role: 'user', blocks: [sharedBlockId] } as any
    const msgKeep = { id: 'm-keep-shared', topicId: tKeep, role: 'user', blocks: [sharedBlockId] } as any
    const bShared = { id: sharedBlockId, messageId: 'm-del-shared', type: 'main_text', content: 'shared' } as any
    store.dispatch(newMessagesActions.messagesReceived({ topicId: tDel, messages: [msgDel] }))
    store.dispatch(newMessagesActions.messagesReceived({ topicId: tKeep, messages: [msgKeep] }))
    store.dispatch(upsertManyBlocks([bShared]))
    invalidateTopicsDeletion([tDel])
    const state = store.getState()
    expect(state.messageBlocks.entities[sharedBlockId]).toBeDefined()
  })

  it('cached early-return cannot use deleted projections (generation guard)', async () => {
    const topicId = 't-early-guard'
    const msg = { id: 'm-early', topicId, role: 'user', blocks: [] } as any
    store.dispatch(newMessagesActions.messagesReceived({ topicId, messages: [msg] }))
    store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
    // simulate deletion bumping generation and purging
    invalidateTopicsDeletion([topicId])
    expect(getDeletionGeneration(topicId)).toBe(1)
    // Now loadTopicMessagesThunk should not early-return; it should attempt fetch
    // We mock dbService.fetchMessagesWindow to observe call
    const { loadTopicMessagesThunk } = await import('@renderer/store/thunk/messageThunk')
    const { dbService } = await import('@renderer/services/db')
    const fetchSpy = vi.spyOn(dbService, 'fetchMessagesWindow').mockResolvedValue({
      messages: [],
      blocks: [],
      window: {
        kind: 'latest',
        completeness: 'window',
        topicId,
        requested: { limit: 10 },
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        totalTurnCount: 1,
        selectedTurnCount: 1,
        boundaryMessageId: null,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    } as any)
    const dispatch = store.dispatch as any
    const getState = store.getState.bind(store)
    await loadTopicMessagesThunk(topicId, false)(dispatch, getState)
    expect(fetchSpy).toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('soft-delete preservation: no invalidation when not called', () => {
    const t = 't-soft-precise'
    const msg = { id: 'm-soft', topicId: t, role: 'user', blocks: ['b-soft'] } as any
    const b = { id: 'b-soft', messageId: 'm-soft', type: 'main_text', content: 'c' } as any
    store.dispatch(newMessagesActions.messagesReceived({ topicId: t, messages: [msg] }))
    store.dispatch(upsertManyBlocks([b]))
    setLatestWindowCompleteness(t, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(t, makeClosure(t, 'm-soft'), 'fp')
    // no invalidate
    expect(getDeletionGeneration(t)).toBe(0)
    const state = store.getState()
    expect(state.messages.entities['m-soft']).toBeDefined()
    expect(getLatestWindowCompleteness(t)).toBeDefined()
  })

  it('in-flight generation stale discards', () => {
    const topicId = 't-stale-precise'
    const tok = getDeletionGeneration(topicId)
    // simulate fetch start captures gen 0
    invalidateTopicsDeletion([topicId])
    expect(isDeletionStale(topicId, tok)).toBe(true)
  })
})
