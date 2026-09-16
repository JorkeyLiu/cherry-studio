/**
 * Joint-publish dedup: identical segment follow-up / window completeness are not
 * committed twice; differing catalogs still apply locally without invalidating
 * the originating residency. Real store modules, no mocks.
 */
import { configureStore } from '@reduxjs/toolkit'
import {
  clearAllLatestWindowCompleteness,
  getLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import { rootReducer } from '@renderer/store'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import { replaceSegmentsForTopic } from '@renderer/store/topicSegment'
import { describe, expect, it } from 'vitest'

function makeWindowResponse(topicId: string, ids: string[]) {
  const messages = ids.map((id) => ({ id, topicId, blocks: [] }))
  return {
    messages,
    blocks: [],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as any
}

describe('joint publish dedup', () => {
  it('identical follow-up keeps state reference; differing catalog applies', () => {
    clearAllLatestWindowCompleteness()
    const store = configureStore({ reducer: rootReducer })
    const topicId = 't-dedup'
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
    const wr: any = makeWindowResponse(topicId, ['m-1'])
    const seg: any = {
      id: 'seg-1',
      topicId,
      name: 'Seg',
      messageIds: ['m-1'],
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-1',
      lastMessageId: 'm-1',
      messageCount: 1
    }
    store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse: wr, segments: [seg] }))
    expect(getLatestWindowCompleteness(topicId)).toEqual({ hasMoreBefore: false, hasMoreAfter: false })
    const beforeState = store.getState()
    const beforeIdsRef = (beforeState as any).topicSegments.segmentsByTopic[topicId]
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId, segments: [{ ...seg }] }),
      meta: { isJointFollowUp: true }
    } as any)
    const afterIdentical = store.getState()
    expect(afterIdentical).toBe(beforeState)
    expect((afterIdentical as any).topicSegments.segmentsByTopic[topicId]).toBe(beforeIdsRef)
    const firstCompleteness = getLatestWindowCompleteness(topicId)
    store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse: wr, segments: [{ ...seg }] }))
    expect(getLatestWindowCompleteness(topicId)).toEqual(firstCompleteness)

    const seg2 = { ...seg, id: 'seg-2', messageIds: ['m-1'] }
    store.dispatch({
      ...replaceSegmentsForTopic({ topicId, segments: [seg, seg2] }),
      meta: { isJointFollowUp: true }
    } as any)
    const afterDiff = store.getState() as any
    expect(afterDiff.topicSegments.segmentsByTopic[topicId]).toEqual(['seg-1', 'seg-2'])
    expect(afterDiff.residentRegistry.entries[topicId].residentTopic).toBe(true)
  })

  it('identical window completeness write is a no-op value', () => {
    clearAllLatestWindowCompleteness()
    const store = configureStore({ reducer: rootReducer })
    const topicId = 't-wc'
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
    const wr: any = makeWindowResponse(topicId, ['m-1'])
    store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse: wr, segments: [] }))
    const first = getLatestWindowCompleteness(topicId)
    expect(first).toEqual({ hasMoreBefore: false, hasMoreAfter: false })
    store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse: wr, segments: [] }))
    expect(getLatestWindowCompleteness(topicId)).toEqual(first)
  })
})
