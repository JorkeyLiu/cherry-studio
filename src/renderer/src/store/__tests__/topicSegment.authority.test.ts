import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'

import { publishResidentComplete } from '../residentRegistry'
import topicSegmentReducer, { addSegment, loadSegments, replaceSegmentsForTopic } from '../topicSegment'

function seg(id: string, topicId: string, sortOrder: number, messageIds: string[]) {
  return {
    id,
    topicId,
    name: id,
    messageIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder,
    firstMessageId: messageIds.length > 0 ? messageIds[0] : null,
    lastMessageId: messageIds.length > 0 ? messageIds[messageIds.length - 1] : null,
    messageCount: messageIds.length
  } as any
}

function emptySeg(id: string, topicId: string) {
  return {
    id,
    topicId,
    name: id,
    messageIds: [],
    createdAt: null,
    updatedAt: null,
    sortOrder: 0,
    firstMessageId: null,
    lastMessageId: null,
    messageCount: 0
  } as any
}

function setup() {
  return configureStore({ reducer: { topicSegments: topicSegmentReducer } })
}

describe('topicSegment slice authority catalog', () => {
  it('addSegment maintains (sortOrder ASC, id ASC) including equal-sortOrder tie', () => {
    const store = setup()
    const topicId = 't-add'
    store.dispatch(addSegment(seg('seg-b', topicId, 1, ['m2'])))
    store.dispatch(addSegment(seg('seg-a', topicId, 0, ['m1'])))
    store.dispatch(addSegment(seg('seg-c', topicId, 0, ['m0'])))
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(['seg-a', 'seg-c', 'seg-b'])
  })

  it('loadSegments maintains authority order for out-of-order input with tie', () => {
    const store = setup()
    const topicId = 't-load'
    store.dispatch(
      loadSegments([
        seg('seg-b', topicId, 1, ['m2']),
        seg('seg-z', topicId, 0, ['m9']),
        seg('seg-a', topicId, 0, ['m1'])
      ])
    )
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(['seg-a', 'seg-z', 'seg-b'])
  })

  it('replaceSegmentsForTopic sorts authority order and drops empty phantom input', () => {
    const store = setup()
    const topicId = 't-replace'
    store.dispatch(
      replaceSegmentsForTopic({
        topicId,
        segments: [seg('seg-b', topicId, 1, ['m2']), emptySeg('seg-e', topicId), seg('seg-a', topicId, 0, ['m1'])]
      })
    )
    const s = (store.getState() as any).topicSegments
    expect(s.segmentsByTopic[topicId]).toEqual(['seg-a', 'seg-b'])
    expect(s.segments.entities['seg-e']).toBeUndefined()
  })

  it('publishResidentComplete sorts authority order and drops empty phantom input', () => {
    const store = setup()
    const topicId = 't-publish'
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: 1,
        windowResponse: {} as any,
        segments: [seg('seg-b', topicId, 1, ['m2']), emptySeg('seg-e', topicId), seg('seg-a', topicId, 0, ['m1'])]
      } as any)
    )
    const s = (store.getState() as any).topicSegments
    expect(s.segmentsByTopic[topicId]).toEqual(['seg-a', 'seg-b'])
    expect(s.segments.entities['seg-e']).toBeUndefined()
  })

  it('empty upsert/readback never enters Redux; existing same-id entity is removed', () => {
    const store = setup()
    const topicId = 't-phantom'
    store.dispatch(addSegment(seg('seg-1', topicId, 0, ['m1'])))
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(['seg-1'])
    // Empty add with same id removes rather than stores.
    store.dispatch(addSegment(emptySeg('seg-1', topicId)))
    const s = (store.getState() as any).topicSegments
    expect(s.segments.entities['seg-1']).toBeUndefined()
    expect(s.segmentsByTopic[topicId]).toEqual([])
    // Empty load removes a re-added entity.
    store.dispatch(addSegment(seg('seg-1', topicId, 0, ['m1'])))
    store.dispatch(loadSegments([emptySeg('seg-1', topicId)]))
    const s2 = (store.getState() as any).topicSegments
    expect(s2.segments.entities['seg-1']).toBeUndefined()
    expect(s2.segmentsByTopic[topicId]).toEqual([])
  })
})
