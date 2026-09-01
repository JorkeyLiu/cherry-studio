import {
  clearAllLatestWindowCompleteness,
  getLatestWindowCompleteness,
  setLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import {
  clearAllContextClosureCache,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import {
  invalidateTopicsDeletion,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'
import store from '@renderer/store'
import { removeManyBlocks, upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

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

describe('topicDeletion orphan/partial-projection block cleanup', () => {
  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
    clearAllLatestWindowCompleteness()
    resetAllClosureStateForTests()
    clearAllContextClosureCache()
    const state = store.getState()
    for (const tid of Object.keys(state.messages.messageIdsByTopic)) {
      const mids = state.messages.messageIdsByTopic[tid]
      if (mids?.length) store.dispatch(newMessagesActions.removeMessages({ topicId: tid, messageIds: mids }))
      store.dispatch(newMessagesActions.setTopicLoading({ topicId: tid, loading: false }))
      store.dispatch(newMessagesActions.setTopicFulfilled({ topicId: tid, fulfilled: false }))
    }
    const blockIds = Object.keys(store.getState().messageBlocks.entities)
    if (blockIds.length) store.dispatch(removeManyBlocks(blockIds))
  })

  it('removes orphan blocks whose messageId belongs to deleted topic even when message.blocks is incomplete (partial projection), preserves shared', () => {
    const tDel = 't-orphan-del'
    const tKeep = 't-orphan-keep'
    // Deleted topic message's blocks array is incomplete — does not include orphan block id,
    // but orphan block's messageId still points to the deleted topic's resident message.
    // This simulates partial projection where message.blocks is not the full authority list.
    const msgDel = { id: 'm-del-1', topicId: tDel, role: 'user', blocks: ['b-present'] } as any
    const blockPresent = { id: 'b-present', messageId: 'm-del-1', type: 'main_text', content: 'present' } as any
    const blockOrphan = { id: 'b-orphan', messageId: 'm-del-1', type: 'main_text', content: 'orphan' } as any
    const msgKeep = { id: 'm-keep', topicId: tKeep, role: 'user', blocks: ['b-keep'] } as any
    const blockKeep = { id: 'b-keep', messageId: 'm-keep', type: 'main_text', content: 'keep' } as any
    const sharedBlockId = 'b-shared-orphan'
    const blockShared = { id: sharedBlockId, messageId: 'm-del-1', type: 'main_text', content: 'shared' } as any
    const msgKeepShared = { id: 'm-keep-shared', topicId: tKeep, role: 'user', blocks: [sharedBlockId] } as any

    store.dispatch(newMessagesActions.messagesReceived({ topicId: tDel, messages: [msgDel] }))
    store.dispatch(newMessagesActions.messagesReceived({ topicId: tKeep, messages: [msgKeep, msgKeepShared] }))
    store.dispatch(upsertManyBlocks([blockPresent, blockOrphan, blockKeep, blockShared]))
    setLatestWindowCompleteness(tDel, { hasMoreBefore: true, hasMoreAfter: false })
    setLatestWindowCompleteness(tKeep, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(tDel, makeClosure(tDel), 'fp-del')

    expect(store.getState().messageBlocks.entities['b-orphan']).toBeDefined()
    expect(store.getState().messageBlocks.entities['b-present']).toBeDefined()
    expect(store.getState().messageBlocks.entities[sharedBlockId]).toBeDefined()
    expect(store.getState().messageBlocks.entities['b-keep']).toBeDefined()

    invalidateTopicsDeletion([tDel])

    const after = store.getState()
    // Orphan block whose messageId belongs to deleted topic must be removed even though message.blocks was incomplete
    expect(after.messageBlocks.entities['b-orphan']).toBeUndefined()
    expect(after.messageBlocks.entities['b-present']).toBeUndefined()
    // Shared block must be preserved because surviving topic references it via its message's blocks (exclusive check)
    expect(after.messageBlocks.entities[sharedBlockId]).toBeDefined()
    expect(after.messageBlocks.entities['b-keep']).toBeDefined()
    expect(getLatestWindowCompleteness(tDel)).toBeUndefined()
    expect(getLatestWindowCompleteness(tKeep)).toBeDefined()
  })

  it('does not remove blocks for surviving topic when its message projection is partial but block is orphan-referenced via messageId', () => {
    const tDel = 't-del-2'
    const tKeep = 't-keep-2'
    const msgDel = { id: 'm-del-2', topicId: tDel, role: 'user', blocks: ['b-del-2'] } as any
    const blkDel = { id: 'b-del-2', messageId: 'm-del-2', type: 'main_text', content: 'del' } as any
    // Keep topic's message blocks is empty (partial), but orphan block's messageId points to it
    const msgKeep = { id: 'm-keep-2', topicId: tKeep, role: 'user', blocks: [] } as any
    const blkKeepOrphan = {
      id: 'b-keep-orphan',
      messageId: 'm-keep-2',
      type: 'main_text',
      content: 'keep-orphan'
    } as any

    store.dispatch(newMessagesActions.messagesReceived({ topicId: tDel, messages: [msgDel] }))
    store.dispatch(newMessagesActions.messagesReceived({ topicId: tKeep, messages: [msgKeep] }))
    store.dispatch(upsertManyBlocks([blkDel, blkKeepOrphan]))

    invalidateTopicsDeletion([tDel])

    const after = store.getState()
    expect(after.messageBlocks.entities['b-del-2']).toBeUndefined()
    expect(after.messageBlocks.entities['b-keep-orphan']).toBeDefined()
  })
})
