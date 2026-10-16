/**
 * Staged-cut authority execution — source-side staged provenance proof.
 *
 * Batch insertion now publishes its own Main capability atomically (no
 * projection clear); this suite proves the source side independently by
 * simulating a cleared capability with a legacy `messagesReceived` commit
 * (reducer behavior, not the paste path). The ordinary guarded delete must
 * then reject before Main, while the cut-specific staged helper still
 * addresses Main with the staged route for complete source members (Main
 * stays final owner). Route mismatch and missing provenance fail closed with
 * zero Main calls. Ordinary guards unchanged.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
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

function makeWindowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  return {
    messages: ids.map((id) => ({ id })) as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    mutableMessageIds: [...ids],
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
  } as unknown as FetchMessagesWindowResponse
}

describe('staged-cut authority execution after capability invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ordinary guarded delete rejects after messagesReceived clears capability, staged still addresses Main', async () => {
    const topicId = 't-staged-cut'
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: makeWindowResponse(topicId, ['u1', 'a1', 'a2']),
        segments: []
      })
    )
    // Sanity: ordinary guard passes while capability present.
    expect((store.getState() as any).messages.mutableMessageIdsByTopic[topicId]).toEqual(['u1', 'a1', 'a2'])

    // Simulate a cleared capability with the legacy projection commit
    // (production reducer; the paste path now uses the atomic ack instead).
    const loaded = (store.getState() as any).messages.messageIdsByTopic[topicId].map(
      (id: string) => (store.getState() as any).messages.entities[id]
    )
    const copies = loaded.map((m: any) => ({ ...m, id: `${m.id}-copy` }))
    store.dispatch(newMessagesActions.messagesReceived({ topicId, messages: [...loaded, ...copies] } as any))
    expect((store.getState() as any).messages.mutableMessageIdsByTopic?.[topicId]).toBeUndefined()

    const { executeDeleteMessagesWithDependents, executeStagedCutSourceDelete } = await import('../messageThunk')

    mocks.deleteMessagesWithDependents.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      deletedMessageIds: ['u1', 'a1', 'a2'],
      deletedBlockIds: [],
      previousUserMessageIds: [],
      remainingUserMessageIds: [],
      segments: [],
      restoreGroups: [
        {
          messages: [],
          blocks: [],
          entries: [],
          positionIndex: 0,
          anchorMessageId: null
        }
      ],
      segmentSnapshots: []
    })

    // Ordinary path rerequires projection capability → rejects before Main.
    await expect(
      executeDeleteMessagesWithDependents(store.dispatch, store.getState as any, topicId, ['u1', 'a1', 'a2'])
    ).rejects.toThrow()
    expect(mocks.deleteMessagesWithDependents).not.toHaveBeenCalled()

    // Staged-cut authority uses the captured main route without the guard,
    // with the cut-time source eligibility (live projection is never read).
    const result = await executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
      sourceTopicId: topicId,
      sourceBranchId: null,
      rootIds: ['u1', 'a1', 'a2'],
      sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: ['u1', 'a1', 'a2'] }
    })
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(topicId, ['u1', 'a1', 'a2'], null)
    expect(result.response.deletedMessageIds).toEqual(['u1', 'a1', 'a2'])
  })

  it('staged delete addresses the staged source independent of the live route; missing provenance still fails closed', async () => {
    const topicId = 't-staged-route'
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: makeWindowResponse(topicId, ['u1']),
        segments: []
      })
    )
    const { executeStagedCutSourceDelete } = await import('../messageThunk')

    // Same-topic branch switch: staged branch differs from the live main
    // route, but the helper still addresses Main with the staged route.
    // Main owner guards stay final; no live-route equality refusal.
    mocks.deleteMessagesWithDependents.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      deletedMessageIds: ['u1'],
      deletedBlockIds: [],
      previousUserMessageIds: [],
      remainingUserMessageIds: [],
      segments: [],
      restoreGroups: [
        {
          messages: [],
          blocks: [],
          entries: [],
          positionIndex: 0,
          anchorMessageId: null
        }
      ],
      segmentSnapshots: []
    })
    const result = await executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
      sourceTopicId: topicId,
      sourceBranchId: 'branch-staged',
      rootIds: ['u1'],
      sourceProjection: { sourceTopicId: topicId, sourceBranchId: 'branch-staged', loadedMessageIds: ['u1'] }
    })
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(topicId, ['u1'], 'branch-staged')
    expect(result.response.deletedMessageIds).toEqual(['u1'])

    // Missing legacy provenance still fails closed with zero Main calls.
    mocks.deleteMessagesWithDependents.mockClear()
    await expect(
      executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
        sourceTopicId: topicId,
        sourceBranchId: undefined as unknown as null,
        rootIds: ['u1']
      })
    ).rejects.toThrow('Missing staged source route')
    await expect(
      executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
        sourceTopicId: topicId,
        sourceBranchId: '' as unknown as string,
        rootIds: ['u1']
      })
    ).rejects.toThrow('Invalid staged source route')
    // Missing/mismatched source projection fails closed before any Main call,
    // even when the staged route itself is well-formed.
    await expect(
      executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
        sourceTopicId: topicId,
        sourceBranchId: 'branch-staged',
        rootIds: ['u1']
      })
    ).rejects.toThrow('Missing staged source projection')
    await expect(
      executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
        sourceTopicId: topicId,
        sourceBranchId: 'branch-staged',
        rootIds: ['u1'],
        sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: ['u1'] }
      })
    ).rejects.toThrow('route mismatch')
    await expect(
      executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
        sourceTopicId: topicId,
        sourceBranchId: 'branch-staged',
        rootIds: ['u1'],
        sourceProjection: { sourceTopicId: 'other-topic', sourceBranchId: 'branch-staged', loadedMessageIds: ['u1'] }
      })
    ).rejects.toThrow('topic mismatch')
    expect(mocks.deleteMessagesWithDependents).not.toHaveBeenCalled()
  })

  it('post-commit anchor-transfer throw carries committed response+undoParts (Main called once)', async () => {
    const topicId = 't-staged-postcommit'
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: makeWindowResponse(topicId, ['u1', 'a1']),
        segments: []
      })
    )
    const { executeStagedCutSourceDelete, isDeletePostCommitConvergenceError } = await import('../messageThunk')

    mocks.deleteMessagesWithDependents.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      deletedMessageIds: ['u1', 'a1'],
      deletedBlockIds: [],
      previousUserMessageIds: ['u1'],
      remainingUserMessageIds: [],
      segments: [],
      restoreGroups: [
        {
          entries: [
            { message: { id: 'u1' }, blocks: [] },
            { message: { id: 'a1' }, blocks: [] }
          ],
          positionIndex: 0,
          anchorMessageId: null
        }
      ],
      segmentSnapshots: [
        {
          id: 'seg-src',
          topicId,
          name: 'Src',
          messageIds: ['u1', 'a1'],
          sortOrder: 0,
          firstMessageId: 'u1',
          lastMessageId: 'a1',
          messageCount: 2
        }
      ]
    })
    // Controlled post-commit failure AFTER the Main result (not an atomic
    // helper reject): the anchor transfer throws once.
    mocks.transferAnchorsWithAuthorityGroupKeys.mockImplementationOnce(() => {
      throw new Error('ANCHOR_CONVERGENCE_THROW')
    })

    let caught: unknown = null
    try {
      await executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
        sourceTopicId: topicId,
        sourceBranchId: null,
        rootIds: ['u1', 'a1'],
        sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: ['u1', 'a1'] }
      })
    } catch (error) {
      caught = error
    }
    expect(caught).not.toBeNull()
    expect(isDeletePostCommitConvergenceError(caught)).toBe(true)
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(topicId, ['u1', 'a1'], null)
    if (isDeletePostCommitConvergenceError(caught)) {
      expect(caught.response.deletedMessageIds).toEqual(['u1', 'a1'])
      // Full authority undo payload retained (not lost on convergence failure).
      expect(caught.undoParts.groupAnchors).toHaveLength(1)
      expect(caught.undoParts.groupAnchors[0].messages.map((m) => m.id)).toEqual(['u1', 'a1'])
      expect(caught.undoParts.segmentSnapshots.map((s) => s.id)).toEqual(['seg-src'])
    }
  })
})
