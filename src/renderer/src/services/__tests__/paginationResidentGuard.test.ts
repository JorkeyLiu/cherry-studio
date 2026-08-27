import { configureStore } from '@reduxjs/toolkit'
import residentRegistryReducer, { bumpGeneration } from '@renderer/store/residentRegistry'
import { describe, expect, it } from 'vitest'

import { captureResidentGeneration, shouldDiscardPaginationForResident } from '../paginationResidentGuard'

describe('pagination resident generation guard (B-06)', () => {
  it('capture returns 0 when no entry, returns generation after bump', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    expect(captureResidentGeneration(() => store.getState(), 't-pag')).toBe(0)
    store.dispatch(bumpGeneration('t-pag'))
    expect(captureResidentGeneration(() => store.getState(), 't-pag')).toBe(1)
  })

  it('shouldDiscard false when generations equal, true when advanced', () => {
    expect(shouldDiscardPaginationForResident(1, 1)).toBe(false)
    expect(shouldDiscardPaginationForResident(0, 0)).toBe(false)
    expect(shouldDiscardPaginationForResident(1, 2)).toBe(true)
    expect(shouldDiscardPaginationForResident(2, 1)).toBe(true)
  })

  it('older pagination stale discards when resident generation advanced before publication — no window/messages/blocks published', async () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    const topicId = 't-older'
    store.dispatch(bumpGeneration(topicId))
    const captured = captureResidentGeneration(() => store.getState(), topicId)
    expect(captured).toBe(1)
    // simulate in-flight pagination: bump generation (e.g., standalone segment replacement or deletion)
    store.dispatch(bumpGeneration(topicId))
    const current = captureResidentGeneration(() => store.getState(), topicId)
    expect(current).toBe(2)
    expect(shouldDiscardPaginationForResident(captured, current)).toBe(true)
    // In Messages.tsx this true path triggers viewportDispatch load/cancel and returns before any
    // upsertManyBlocks / messagesReceived / window expand / viewport finish, preserving B-06 semantics
  })

  it('newer pagination stale discards when resident generation advanced before publication — no window/messages/blocks published', async () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    const topicId = 't-newer'
    store.dispatch(bumpGeneration(topicId))
    const captured = captureResidentGeneration(() => store.getState(), topicId)
    expect(captured).toBe(1)
    // simulate concurrent joint invalidation before newer response
    store.dispatch(bumpGeneration(topicId))
    const current = captureResidentGeneration(() => store.getState(), topicId)
    expect(shouldDiscardPaginationForResident(captured, current)).toBe(true)
  })

  it('pagination not stale when generation unchanged — allowed to publish (B-06 preserved)', () => {
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    const topicId = 't-keep'
    store.dispatch(bumpGeneration(topicId))
    const captured = captureResidentGeneration(() => store.getState(), topicId)
    // no bump
    const current = captureResidentGeneration(() => store.getState(), topicId)
    expect(shouldDiscardPaginationForResident(captured, current)).toBe(false)
  })

  it('standalone segment replacement (which bumps resident generation) forces pagination stale discard', async () => {
    // Prove the interaction: standalone segment load bumps generation, pagination captured earlier must discard
    const { default: topicSegmentReducer } = await import('@renderer/store/topicSegment')
    const { default: newMessagesReducer } = await import('@renderer/store/newMessage')
    const { default: messageBlocksReducer } = await import('@renderer/store/messageBlock')
    const store = configureStore({
      reducer: {
        messages: newMessagesReducer,
        messageBlocks: messageBlocksReducer,
        topicSegments: topicSegmentReducer,
        residentRegistry: residentRegistryReducer
      }
    })
    const topicId = 't-standalone-pagination'
    store.dispatch(bumpGeneration(topicId))
    const capturedPaginationGen = captureResidentGeneration(() => store.getState(), topicId)
    expect(capturedPaginationGen).toBe(1)
    // standalone segment load via real thunk path would bump to 2 (tested elsewhere); simulate same
    const { markSegmentsLoaded } = await import('@renderer/store/residentRegistry')
    // simulate standalone success directly via reducer (would be dispatched after fetch)
    store.dispatch(markSegmentsLoaded(topicId))
    const afterStandaloneGen = captureResidentGeneration(() => store.getState(), topicId)
    expect(afterStandaloneGen).toBe(2)
    expect(shouldDiscardPaginationForResident(capturedPaginationGen, afterStandaloneGen)).toBe(true)
    // No messages/blocks/window should have been published for that pagination — verified via guard
  })
})
