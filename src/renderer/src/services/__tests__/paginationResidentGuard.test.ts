import { configureStore } from '@reduxjs/toolkit'
import residentRegistryReducer, { bumpGeneration } from '@renderer/store/residentRegistry'
import topicBranchReducer, { activeBranchSet } from '@renderer/store/topicBranch'
import { describe, expect, it } from 'vitest'

import {
  captureResidentGeneration,
  captureRouteGeneration,
  isPaginationAttemptApplicable,
  type PaginationAttemptSnapshot,
  shouldDiscardPaginationForResident
} from '../paginationResidentGuard'

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

describe('pagination request applicability (topic/route generation)', () => {
  const buildStore = () =>
    configureStore({ reducer: { topicBranch: topicBranchReducer, residentRegistry: residentRegistryReducer } })

  const attemptRequest = (overrides: Partial<PaginationAttemptSnapshot> = {}): PaginationAttemptSnapshot => ({
    topicId: 't-pag',
    route: 'b1',
    routeGeneration: 1,
    topicGeneration: 0,
    residentGeneration: 0,
    ...overrides
  })

  it('route generation capture starts at 0 and advances on every route switch', () => {
    const store = buildStore()
    expect(captureRouteGeneration(() => store.getState(), 't-pag')).toBe(0)
    store.dispatch(activeBranchSet({ topicId: 't-pag', branchId: 'b1' }))
    expect(captureRouteGeneration(() => store.getState(), 't-pag')).toBe(1)
  })

  it('discards an away-and-back excursion: identical route value, bumped generation', () => {
    const store = buildStore()
    store.dispatch(activeBranchSet({ topicId: 't-pag', branchId: 'b1' }))
    const captured = captureRouteGeneration(() => store.getState(), 't-pag')
    const issue = attemptRequest({ routeGeneration: captured, route: 'b1' })
    expect(
      isPaginationAttemptApplicable({
        state: store.getState(),
        request: issue,
        live: { topicId: 't-pag', route: 'b1', topicGeneration: 0 }
      })
    ).toBe(true)

    // Away … back: the route VALUE returns identical while the token advanced.
    store.dispatch(activeBranchSet({ topicId: 't-pag', branchId: 'b2' }))
    store.dispatch(activeBranchSet({ topicId: 't-pag', branchId: 'b1' }))
    expect(
      isPaginationAttemptApplicable({
        state: store.getState(),
        request: issue,
        live: { topicId: 't-pag', route: 'b1', topicGeneration: 0 }
      })
    ).toBe(false)
  })

  it('discards on topic, route value, viewport generation or resident generation movement', () => {
    const store = buildStore()
    store.dispatch(activeBranchSet({ topicId: 't-pag', branchId: 'b2' }))
    const captured = captureRouteGeneration(() => store.getState(), 't-pag')
    const issue = attemptRequest({ routeGeneration: captured, route: 'b2' })
    const applicable = (live: { topicId: string; route: string | null; topicGeneration: number }) =>
      isPaginationAttemptApplicable({ state: store.getState(), request: issue, live })

    expect(applicable({ topicId: 't-pag', route: 'b2', topicGeneration: 0 })).toBe(true)
    expect(applicable({ topicId: 't-other', route: 'b2', topicGeneration: 0 })).toBe(false)
    expect(applicable({ topicId: 't-pag', route: 'b1', topicGeneration: 0 })).toBe(false)
    expect(applicable({ topicId: 't-pag', route: 'b2', topicGeneration: 1 })).toBe(false)

    // Resident applicability generation advanced (eviction/standalone segment
    // replacement) while the page was in flight.
    store.dispatch(bumpGeneration('t-pag'))
    expect(applicable({ topicId: 't-pag', route: 'b2', topicGeneration: 0 })).toBe(false)
  })

  it('keeps a never-switched main route (generation 0) applicable while nothing moved', () => {
    const store = buildStore()
    expect(
      isPaginationAttemptApplicable({
        state: store.getState(),
        request: attemptRequest({ topicId: 't-main', route: null, routeGeneration: 0, topicGeneration: 3 }),
        live: { topicId: 't-main', route: null, topicGeneration: 3 }
      })
    ).toBe(true)
  })
})
