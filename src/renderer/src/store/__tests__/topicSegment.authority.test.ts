import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'

import { fingerprintSegmentCatalog, publishResidentComplete, publishSegmentCatalogComplete } from '../residentRegistry'
import { isSegmentFoldableThroughRoute, requireSegmentFoldableThroughRoute } from '../routeAnswerGroup'
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
  it('folded presentation state is publishable and survives catalog convergence', () => {
    const topicId = 't-fold'
    const foldedCatalog = [{ ...seg('seg-1', topicId, 0, ['m1']), folded: true }]
    const expandedCatalog = [{ ...seg('seg-1', topicId, 0, ['m1']), folded: false }]
    // A fold/expand toggle changes the catalog fingerprint, so an identical
    // snapshot guard never discards a legitimate folded-state publication.
    expect(fingerprintSegmentCatalog(foldedCatalog)).not.toBe(fingerprintSegmentCatalog(expandedCatalog))
    expect(fingerprintSegmentCatalog(foldedCatalog)).not.toBe(
      fingerprintSegmentCatalog([seg('seg-1', topicId, 0, ['m1'])])
    )

    const store = setup()
    store.dispatch(
      publishSegmentCatalogComplete({
        topicId,
        generation: 0,
        segments: foldedCatalog,
        messageIds: null,
        route: null,
        baseFingerprint: '',
        routeGeneration: 0
      } as any)
    )
    const entity = (store.getState() as any).topicSegments.segments.entities['seg-1']
    expect(entity.folded).toBe(true)
    expect(entity.messageIds).toEqual(['m1'])
  })
})

/**
 * Fold is a request-context mutation, so it follows the same owner-only
 * capability rule as membership: unknown capability rejects, an inherited
 * (loaded-but-immutable) member rejects, and an unloaded member defers to Main's
 * atomic whole-membership check instead of blocking a valid owner fold.
 */
describe('segment fold route capability', () => {
  const snap = (
    over: Partial<Record<'activeRoute' | 'mutableRoute', string | null>> & {
      mutableIds?: string[]
      loadedIds?: string[]
    }
  ) =>
    ({
      activeRoute: null,
      mutableRoute: null,
      mutableIds: ['m1', 'm2'],
      loadedIds: ['m1', 'm2'],
      ...over
    }) as any

  it('allows an owner-only fold through the active route', () => {
    expect(() => requireSegmentFoldableThroughRoute(snap({}), 't1', ['m1', 'm2'])).not.toThrow()
    expect(isSegmentFoldableThroughRoute(snap({}), 't1', ['m1'])).toBe(true)
    // A window-outside member defers to Main rather than blocking.
    expect(() => requireSegmentFoldableThroughRoute(snap({ loadedIds: ['m1'] }), 't1', ['m1', 'm2'])).not.toThrow()
  })

  it('rejects an unknown capability with zero IPC', () => {
    // Route mismatch (a sibling/inherited route) is unknown through this route.
    expect(() => requireSegmentFoldableThroughRoute(snap({ mutableRoute: 'b1' }), 't1', ['m1'])).toThrow(
      /unknown through this route/
    )
    expect(isSegmentFoldableThroughRoute(snap({ mutableRoute: 'b1' }), 't1', ['m1'])).toBe(false)
    // Capability never published: no mutable member list at all.
    expect(() => requireSegmentFoldableThroughRoute(snap({ mutableIds: undefined }), 't1', ['m1'])).toThrow(
      /unknown through this route/
    )
    expect(isSegmentFoldableThroughRoute(snap({ mutableIds: undefined }), 't1', ['m1'])).toBe(false)
  })

  it('rejects an inherited/read-only loaded member', () => {
    expect(() => requireSegmentFoldableThroughRoute(snap({ mutableIds: ['m1'] }), 't1', ['m1', 'm2'])).toThrow(
      /immutable through this route/
    )
    expect(isSegmentFoldableThroughRoute(snap({ mutableIds: ['m1'] }), 't1', ['m1', 'm2'])).toBe(false)
  })
})
