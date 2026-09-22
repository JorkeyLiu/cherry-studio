/**
 * Natural-boundary delete thunk — paired follow-up meta and resident preservation.
 *
 * Proves:
 *  - executeDeleteMessagesWithDependents dispatches replaceSegmentsForTopic with
 *    meta.isDeletePairedFollowUp:true (narrowly named paired exemption)
 *  - Full authority segments are consumed
 *  - Resident remains resident, loaded becomes N-1 not []
 *  - Standalone replace still invalidates (separate store test, but thunk re-uses same slice)
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesWithDependents: vi.fn(),
    consumeFileCleanupResult: vi.fn(async () => {}),
    transferAnchorsWithAuthorityGroupKeys: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: { deleteMessagesWithDependents: mocks.deleteMessagesWithDependents }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))
vi.mock('@renderer/services/anchorService', () => ({
  transferAnchorsWithAuthorityGroupKeys: mocks.transferAnchorsWithAuthorityGroupKeys,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({ loadTopicSegmentsThunk: vi.fn() }))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

function makeWindowResponse(topicId: string, messages: Array<{ id: string }>): FetchMessagesWindowResponse {
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: messages[0]?.id ?? null,
      lastMessageId: messages[messages.length - 1]?.id ?? null,
      returnedCount: messages.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}
function makeSegment(id: string, topicId: string, mids: string[]): any {
  return {
    id,
    topicId,
    name: 'Seg',
    messageIds: mids,
    color: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortOrder: 0,
    firstMessageId: mids[0] ?? null,
    lastMessageId: mids[mids.length - 1] ?? null,
    messageCount: mids.length
  }
}
describe('delete thunk — narrow paired follow-up retains residency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('executeDeleteMessagesWithDependents dispatches paired replace with isDeletePairedFollowUp and retains resident, N-1, authority segments', async () => {
    const topicId = 't-thunk-semantic'
    // Real store with resident
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    const wr = makeWindowResponse(topicId, [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] as any)
    const segBefore = makeSegment('seg-1', topicId, ['m1', 'm2', 'm3'])
    store.dispatch(publishResidentComplete({ topicId, generation: gen, windowResponse: wr, segments: [segBefore] }))
    expect((store.getState() as any).residentRegistry.entries[topicId].residentTopic).toBe(true)
    // Need actual message entities for dispatch check: publishResidentComplete already inserted via extraReducer
    // Ensure messages are present
    const beforeIds = (store.getState() as any).messages.messageIdsByTopic[topicId]
    expect(beforeIds).toEqual(['m1', 'm2', 'm3'])

    const authoritySegments = [makeSegment('seg-1', topicId, ['m1', 'm3'])]
    const response = {
      affectedFileIds: [],
      remainingReferenceCounts: {},
      deletedMessageIds: ['m2'],
      deletedBlockIds: ['b2'],
      previousUserMessageIds: ['m1'],
      remainingUserMessageIds: ['m1', 'm3'],
      segments: authoritySegments,
      restoreGroups: [],
      segmentSnapshots: []
    }
    mocks.deleteMessagesWithDependents.mockResolvedValue(response)

    const { executeDeleteMessagesWithDependents } = await import('../messageThunk')

    const result = await executeDeleteMessagesWithDependents(store.dispatch, store.getState as any, topicId, ['m2'])

    // Thunk returned authority-derived undo parts
    expect(result.response).toBe(response)
    // Verify dispatch sequence via store state: resident retained, N-1, segments authority
    const after = store.getState() as any
    expect(after.residentRegistry.entries[topicId].residentTopic).toBe(true)
    expect(after.residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen)
    expect(after.messages.messageIdsByTopic[topicId]).toEqual(['m1', 'm3'])
    expect(after.messages.messageIdsByTopic[topicId].length).toBe(2)
    // Authority segments consumed
    expect(after.topicSegments.segments.entities['seg-1'].messageIds).toEqual(['m1', 'm3'])
    // Anchors called with authority group keys
    expect(mocks.transferAnchorsWithAuthorityGroupKeys).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      topicId,
      ['m1'],
      ['m1', 'm3']
    )

    // Additionally prove the dispatched replaceSegmentsForTopic action carried the narrow meta
    // Do isolated dispatch capture with mock dispatch
    const dispatchCaptures: any[] = []
    const captureDispatch = (a: any) => {
      dispatchCaptures.push(a)
      return store.dispatch(a)
    }
    // Reset store to same initial for capture
    const store2 = configureStore({ reducer: rootReducer })
    store2.dispatch(bumpGeneration(topicId))
    const gen2 = (store2.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    const wr2 = makeWindowResponse(topicId, [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] as any)
    store2.dispatch(publishResidentComplete({ topicId, generation: gen2, windowResponse: wr2, segments: [segBefore] }))
    mocks.deleteMessagesWithDependents.mockResolvedValueOnce(response)
    await executeDeleteMessagesWithDependents(captureDispatch as any, store2.getState as any, topicId, ['m2'])
    const replaceAction = dispatchCaptures.find((a) => a?.type === 'topicSegments/replaceSegmentsForTopic')
    expect(replaceAction).toBeDefined()
    expect(replaceAction.meta?.isDeletePairedFollowUp).toBe(true)
    // Must not have fromSync (originating window)
    expect(replaceAction.meta?.fromSync).toBeFalsy()
  })

  it('standalone replace without paired flag still invalidates (thunk slice sanity)', async () => {
    const topicId = 't-thunk-standalone'
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    const wr = makeWindowResponse(topicId, [{ id: 'm1' }] as any)
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: wr,
        segments: [makeSegment('seg-1', topicId, ['m1'])]
      })
    )
    const { replaceSegmentsForTopic } = await import('@renderer/store/topicSegment')
    store.dispatch(replaceSegmentsForTopic({ topicId, segments: [makeSegment('seg-1', topicId, ['m1', 'm2'])] }) as any)
    const after = store.getState() as any
    expect(after.residentRegistry.entries[topicId].residentTopic).toBe(false)
    expect(after.residentRegistry.entries[topicId].applicabilityGeneration).toBe(gen + 1)
  })
})
