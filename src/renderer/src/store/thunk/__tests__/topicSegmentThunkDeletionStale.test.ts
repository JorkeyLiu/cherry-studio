/**
 * Focused regression test for final deletion audit blocker 2:
 * stale segment response discarded after deletion generation advances.
 */

import {
  captureDeletionGeneration,
  invalidateTopicsDeletion,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'
import { clearSegmentsForTopic, loadSegments, replaceSegmentsForTopic } from '@renderer/store/topicSegment'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockListSegments } = vi.hoisted(() => ({
  mockListSegments: vi.fn()
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    listSegments: mockListSegments
  }
}))

// Use real topicDeletionInvalidation (generation bump) and real thunk logic via dynamic import
// to ensure the generation capture/check is exercised.

describe('loadTopicSegmentsThunk stale discard', () => {
  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
    mockListSegments.mockReset()
    vi.clearAllMocks()
  })

  it('stale segment response is discarded after deletion generation advances', async () => {
    const topicId = 't-stale-segments'
    const segments = [
      {
        id: 'seg-1',
        topicId,
        name: 'Old',
        messageIds: ['m1'],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]

    let resolveList: (v: typeof segments) => void
    const pending = new Promise<typeof segments>((resolve) => {
      resolveList = resolve
    })
    mockListSegments.mockReturnValue(pending)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')

    const dispatch = vi.fn()
    // Kick off thunk but do not await yet — captureDeletionGeneration happens synchronously at start
    const promise = (loadTopicSegmentsThunk as any)(topicId)(dispatch, () => ({}) as any, undefined)

    // No eager clear before paired payload is valid — dispatch should not have cleared yet
    await Promise.resolve()
    expect(dispatch).not.toHaveBeenCalledWith(clearSegmentsForTopic(topicId))
    expect(mockListSegments).toHaveBeenCalledWith(topicId)
    // Only fetch so far, no replace yet
    const callsBefore = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === replaceSegmentsForTopic.type).length
    expect(callsBefore).toBe(0)

    // Capture should have been taken before fetch; now bump generation to simulate hard deletion
    const genBefore = captureDeletionGeneration(topicId)
    expect(genBefore).toBe(0)
    invalidateTopicsDeletion([topicId])
    expect(captureDeletionGeneration(topicId)).toBe(1)

    // Resolve the stale fetch
    resolveList!(segments as any)
    await promise

    // replaceSegmentsForTopic must NOT have been dispatched because generation advanced
    const replaceCalls = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaceCalls.length).toBe(0)
    // also no legacy loadSegments
    const loadCalls = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === loadSegments.type)
    expect(loadCalls.length).toBe(0)
  })

  it('non-stale load dispatches loadSegments with fresh data', async () => {
    const topicId = 't-fresh-segments'
    const segments = [
      {
        id: 'seg-2',
        topicId,
        name: 'Fresh',
        messageIds: ['m2'],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    mockListSegments.mockResolvedValue(segments as any)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')
    const dispatch = vi.fn()
    await (loadTopicSegmentsThunk as any)(topicId)(dispatch, () => ({}) as any, undefined)

    // Atomic replacement — single replaceSegmentsForTopic dispatch after fetch, no eager clear
    const replaceCalls = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaceCalls.length).toBe(1)
    expect(replaceCalls[0][0].payload.segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'seg-2', topicId })])
    )
    expect(replaceCalls[0][0].payload.topicId).toBe(topicId)
    // legacy clear/load not used
    expect(dispatch).not.toHaveBeenCalledWith(clearSegmentsForTopic(topicId))
  })

  it('stale check is per-topic: other topic generation does not discard', async () => {
    const topicId = 't-per-topic-a'
    const otherTopic = 't-per-topic-b'
    const segments = [
      {
        id: 'seg-3',
        topicId,
        name: 'PerTopic',
        messageIds: [],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    let resolveList: (v: typeof segments) => void
    const pending = new Promise<typeof segments>((resolve) => {
      resolveList = resolve
    })
    mockListSegments.mockReturnValue(pending)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')
    const dispatch = vi.fn()
    const promise = (loadTopicSegmentsThunk as any)(topicId)(dispatch, () => ({}) as any, undefined)
    await Promise.resolve()

    // Bump generation for OTHER topic only
    invalidateTopicsDeletion([otherTopic])
    expect(captureDeletionGeneration(topicId)).toBe(0)
    expect(captureDeletionGeneration(otherTopic)).toBe(1)

    resolveList!(segments as any)
    await promise

    // Should still dispatch because topicId's generation did not advance
    const replaceCalls = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaceCalls.length).toBe(1)
  })

  it('concurrent standalone segment loads: only latest publishes, stale token discarded before publication (just-before-publication check)', async () => {
    const topicId = 't-concurrent-segments'
    const segmentsA = [
      {
        id: 'seg-a',
        topicId,
        name: 'A',
        messageIds: [],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    const segmentsB = [
      {
        id: 'seg-b',
        topicId,
        name: 'B',
        messageIds: [],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    let resolveA: (v: typeof segmentsA) => void
    let resolveB: (v: typeof segmentsB) => void
    const pendingA = new Promise<typeof segmentsA>((res) => {
      resolveA = res
    })
    const pendingB = new Promise<typeof segmentsB>((res) => {
      resolveB = res
    })
    mockListSegments.mockReturnValueOnce(pendingA).mockReturnValueOnce(pendingB)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')
    const dispatchA = vi.fn()
    const dispatchB = vi.fn()
    // Both start with same generation and deletion gen 0
    const pA = (loadTopicSegmentsThunk as any)(topicId)(
      dispatchA,
      () => ({ residentRegistry: { entries: {} } }) as any,
      undefined
    )
    const pB = (loadTopicSegmentsThunk as any)(topicId)(
      dispatchB,
      () => ({ residentRegistry: { entries: {} } }) as any,
      undefined
    )
    await Promise.resolve()
    await Promise.resolve()

    // Resolve B first (newer token) — should publish
    resolveB!(segmentsB as any)
    await pB
    const replaceB = dispatchB.mock.calls.filter((c: any[]) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaceB.length).toBe(1)
    expect(replaceB[0][0].payload.segments[0].id).toBe('seg-b')

    // Now resolve A (stale token) — must be discarded just-before-publication, even though deletionGen unchanged
    resolveA!(segmentsA as any)
    await pA
    const replaceA = dispatchA.mock.calls.filter((c: any[]) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaceA.length).toBe(0)
  })

  it('standalone segment load does not establish or preserve false joint residency (LOCK-302)', async () => {
    const topicId = 't-residency-standalone'
    const segments = [
      {
        id: 'seg-standalone',
        topicId,
        name: 'Solo',
        messageIds: [],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    mockListSegments.mockResolvedValue(segments as any)
    const { default: residentRegistryReducer, bumpGeneration } = await import('@renderer/store/residentRegistry')
    const { configureStore } = await import('@reduxjs/toolkit')
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    // bump to gen 1 with chatData false
    store.dispatch(bumpGeneration(topicId))
    const genBefore = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    expect(genBefore).toBe(1)
    expect((store.getState() as any).residentRegistry.entries[topicId].residentTopic).toBe(false)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')
    // standalone load at same generation must set segments true, keep non-resident,
    // and advance generation so the previous joint claim cannot cache-hit
    await (loadTopicSegmentsThunk as any)(topicId)(store.dispatch as any, store.getState as any, undefined)
    const entry = (store.getState() as any).residentRegistry.entries[topicId]
    expect(entry.segments).toBe(true)
    expect(entry.residentTopic).toBe(false)
    expect(entry.chatData).toBe(false)
    expect(entry.applicabilityGeneration).toBe(2)
  })

  it('standalone segment load discards when resident applicabilityGeneration advances before publication', async () => {
    const topicId = 't-gen-stale-segment'
    const segments = [
      {
        id: 'seg-gen',
        topicId,
        name: 'Gen',
        messageIds: [],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    let resolveList: (v: typeof segments) => void
    const pending = new Promise<typeof segments>((res) => {
      resolveList = res
    })
    mockListSegments.mockReturnValue(pending as any)

    const { default: residentRegistryReducer, bumpGeneration } = await import('@renderer/store/residentRegistry')
    const { configureStore } = await import('@reduxjs/toolkit')
    const store = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    store.dispatch(bumpGeneration(topicId))
    const capturedGen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    expect(capturedGen).toBe(1)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')
    // Use dynamic getState that reflects store after bump
    const dispatchSpy = vi.fn((a: any) => store.dispatch(a))
    const getStateSpy = () => store.getState() as any
    const promise = (loadTopicSegmentsThunk as any)(topicId)(dispatchSpy as any, getStateSpy as any, undefined)
    await Promise.resolve()
    // bump generation before resolve (simulating concurrent joint bump)
    store.dispatch(bumpGeneration(topicId))
    expect((store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration).toBe(2)
    resolveList!(segments as any)
    await promise
    // Should be discarded due to generation mismatch — no replace dispatched beyond the spy's resident bumps
    const replaceCalls = dispatchSpy.mock.calls.filter((c: any[]) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaceCalls.length).toBe(0)
  })

  it('BLOCKER: standalone segment replacement invalidates prior joint residency, blocks cache-hit until next joint republish', async () => {
    const topicId = 't-blocker-standalone'
    const segStandalone = {
      id: 'seg-standalone-blocker',
      topicId,
      name: 'SoloBlocker',
      messageIds: [],
      color: undefined,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    mockListSegments.mockResolvedValue([segStandalone] as any)

    const {
      default: residentRegistryReducer,
      bumpGeneration,
      publishResidentComplete,
      shouldDiscardJointPublish,
      JOINT_PUBLISH_COMPLETE
    } = await import('@renderer/store/residentRegistry')
    const { default: newMessagesReducer } = await import('@renderer/store/newMessage')
    const { default: messageBlocksReducer } = await import('@renderer/store/messageBlock')
    const { default: topicSegmentReducer } = await import('@renderer/store/topicSegment')
    const { combineReducers, configureStore } = await import('@reduxjs/toolkit')
    const { setLatestWindowCompleteness } = await import('@renderer/pages/home/Messages/messageWindow')

    const appReducerLocal = combineReducers({
      messages: newMessagesReducer,
      messageBlocks: messageBlocksReducer,
      topicSegments: topicSegmentReducer,
      residentRegistry: residentRegistryReducer
    })
    const rootReducerLocal: typeof appReducerLocal = (state, action: any) => {
      if (action?.type === JOINT_PUBLISH_COMPLETE) {
        if (shouldDiscardJointPublish(state, action.payload)) return state as any
        try {
          const wr = action.payload?.windowResponse
          const tid = action.payload?.topicId as string
          if (wr?.window)
            setLatestWindowCompleteness(tid, {
              hasMoreBefore: !!wr.window.hasMoreBefore,
              hasMoreAfter: !!wr.window.hasMoreAfter
            })
        } catch {}
      }
      return appReducerLocal(state, action)
    }
    const store = configureStore({ reducer: rootReducerLocal })

    // Establish joint residency via real publishResidentComplete path (same as production)
    store.dispatch(bumpGeneration(topicId))
    const gen1 = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
    expect(gen1).toBe(1)
    const windowResponse: any = {
      messages: [{ id: 'm-joint-1', topicId, role: 'user', blocks: [] }] as any,
      blocks: [] as any,
      window: {
        topicId,
        kind: 'latest',
        completeness: 'window',
        anchorMessageId: null,
        requested: { limit: 10 },
        firstMessageId: 'm-joint-1',
        lastMessageId: 'm-joint-1',
        returnedCount: 1,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    }
    const jointSegments: any[] = [
      {
        id: 'seg-joint-1',
        topicId,
        name: 'Joint',
        messageIds: [],
        color: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
    store.dispatch(publishResidentComplete({ topicId, generation: gen1, windowResponse, segments: jointSegments }))
    const entryJoint = (store.getState() as any).residentRegistry.entries[topicId]
    expect(entryJoint.residentTopic).toBe(true)
    expect(entryJoint.chatData).toBe(true)
    expect(entryJoint.segments).toBe(true)
    expect(entryJoint.applicabilityGeneration).toBe(1)
    // cache-hit would succeed here (resident true, has index)
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['m-joint-1'])

    // Standalone segment replacement via real thunk path — must invalidate joint claim and bump generation
    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')
    await (loadTopicSegmentsThunk as any)(topicId)(store.dispatch as any, store.getState as any, undefined)

    const entryAfterStandalone = (store.getState() as any).residentRegistry.entries[topicId]
    expect(entryAfterStandalone.residentTopic).toBe(false)
    expect(entryAfterStandalone.chatData).toBe(false)
    expect(entryAfterStandalone.segments).toBe(true)
    expect(entryAfterStandalone.applicabilityGeneration).toBe(2)
    // segments projection updated to standalone value, but messages projection unchanged
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(['seg-standalone-blocker'])
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['m-joint-1'])
    // cache-hit must now be MISS — loadTopicMessagesThunk would not hit because resident false
    // prove by checking guard directly
    const isHit = !!entryAfterStandalone.residentTopic && entryAfterStandalone.chatData && entryAfterStandalone.segments
    expect(isHit).toBe(false)

    // stale joint publish at old generation must be discarded (no overwrite, no residency restore)
    const staleWindow: any = {
      messages: [{ id: 'm-stale', topicId, role: 'user', blocks: [] }] as any,
      blocks: [] as any,
      window: {
        topicId,
        kind: 'latest',
        completeness: 'window',
        anchorMessageId: null,
        requested: { limit: 10 },
        firstMessageId: 'm-stale',
        lastMessageId: 'm-stale',
        returnedCount: 1,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    }
    const beforeMessages = structuredClone((store.getState() as any).messages.messageIdsByTopic[topicId])
    const beforeSegments = structuredClone((store.getState() as any).topicSegments.segmentsByTopic[topicId])
    store.dispatch(
      publishResidentComplete({ topicId, generation: gen1, windowResponse: staleWindow, segments: jointSegments })
    )
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(beforeMessages)
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(beforeSegments)
    expect((store.getState() as any).residentRegistry.entries[topicId].residentTopic).toBe(false)
    expect((store.getState() as any).messages.entities['m-stale']).toBeUndefined()

    // Next paired joint at current generation restores residency and allows cache-hit
    const gen2 = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration as number
    expect(gen2).toBe(2)
    const windowResponse2: any = {
      messages: [{ id: 'm-joint-2', topicId, role: 'user', blocks: [] }] as any,
      blocks: [] as any,
      window: {
        topicId,
        kind: 'latest',
        completeness: 'window',
        anchorMessageId: null,
        requested: { limit: 10 },
        firstMessageId: 'm-joint-2',
        lastMessageId: 'm-joint-2',
        returnedCount: 1,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    }
    const jointSegments2: any[] = [
      {
        id: 'seg-joint-2',
        topicId,
        name: 'Joint2',
        messageIds: [],
        color: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
    store.dispatch(
      publishResidentComplete({ topicId, generation: gen2, windowResponse: windowResponse2, segments: jointSegments2 })
    )
    const entryRestored = (store.getState() as any).residentRegistry.entries[topicId]
    expect(entryRestored.residentTopic).toBe(true)
    expect(entryRestored.chatData).toBe(true)
    expect(entryRestored.segments).toBe(true)
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['m-joint-2'])
    expect((store.getState() as any).topicSegments.segmentsByTopic[topicId]).toEqual(['seg-joint-2'])
  })
})
