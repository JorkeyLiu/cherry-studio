/**
 * Delete → undo → redo with the shared batch insertion acknowledgment.
 *
 * Real Redux store + real UndoService + real `requireMutableForActiveRoute`
 * guard (never mocked): ordinary delete commits via the semantic path, undo
 * restores through `insertMessageGroups` with the Main canonical ack, and the
 * batch installs rows+capability atomically so the redo precheck passes
 * without any permission bypass. Previously the restore used
 * `insertMessageAtIndex` (no capability) and redo was denied before Main.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { newMessagesActions, selectIsMessageMutable } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete } from '@renderer/store/residentRegistry'
import { pushUndoAction } from '@renderer/store/undoStack'
import type { DeleteUndoAction } from '@renderer/types/editMode'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesWithDependents: vi.fn(),
    insertMessageGroups: vi.fn(),
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
  dbService: {
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents,
    insertMessageGroups: mocks.insertMessageGroups,
    updateFileCount: vi.fn()
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))
vi.mock('@renderer/services/anchorService', () => ({
  transferAnchorsWithAuthorityGroupKeys: mocks.transferAnchorsWithAuthorityGroupKeys,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: vi.fn(),
  deleteSegmentsBySnapshots: vi.fn(async () => {}),
  restoreSegmentsAfterUndo: vi.fn(async () => {}),
  restoreTargetSegments: vi.fn(async () => {}),
  syncSegmentsAfterMessageDeletion: vi.fn(async () => {})
}))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

function makeWindowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  return {
    messages: ids.map((id) => ({
      id,
      topicId,
      role: 'user',
      blocks: []
    })) as unknown as FetchMessagesWindowResponse['messages'],
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

describe('delete → undo → redo with batch insertion ack (real store, real guards)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('undo installs capability so redoDelete passes the original precheck', async () => {
    const topicId = 't-ack-redo'
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(bumpGeneration(topicId))
    const gen = (store.getState() as any).residentRegistry.entries[topicId].applicabilityGeneration
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation: gen,
        windowResponse: makeWindowResponse(topicId, ['u1', 'a1']),
        segments: [],
        route: null
      })
    )

    // Authority delete response for roots [u1] (Main expands to [u1, a1]).
    const deleteResponse = {
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
            { message: { id: 'u1', topicId, role: 'user', blocks: [] }, blocks: [] },
            { message: { id: 'a1', topicId, role: 'assistant', askId: 'u1', blocks: [] }, blocks: [] }
          ],
          positionIndex: 0,
          anchorMessageId: null
        }
      ],
      segmentSnapshots: []
    }
    mocks.deleteMessagesWithDependents.mockResolvedValue(deleteResponse)
    // Batch restore ack: canonical wires + Main capability for the inserted run.
    mocks.insertMessageGroups.mockImplementation(
      async (ackTopicId: string, _groups: unknown, branchId?: string | null) => ({
        affectedFileIds: [],
        remainingReferenceCounts: {},
        topicId: ackTopicId,
        branchId: branchId ?? null,
        insertedMessages: [
          { id: 'u1', topicId, role: 'user', blocks: [] },
          { id: 'a1', topicId, role: 'assistant', askId: 'u1', blocks: [] }
        ],
        insertedBlocks: [],
        insertedMessageIds: ['u1', 'a1'],
        mutableMessageIds: ['u1', 'a1'],
        groups: [{ insertedMessageIds: ['u1', 'a1'], beforeMessageId: null, nextMessageId: null }]
      })
    )

    const { executeDeleteMessagesWithDependents } = await import('@renderer/store/thunk/messageThunk')
    const { response, undoParts } = await executeDeleteMessagesWithDependents(
      store.dispatch as any,
      store.getState as any,
      topicId,
      ['u1']
    )
    expect(response.deletedMessageIds).toEqual(['u1', 'a1'])
    expect(undoParts.groupAnchors).toHaveLength(1)
    // Delete cleared the loaded projection.
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual([])

    // Push the ordinary delete undo action (as deleteSelectedMessages does).
    const deleteAction: DeleteUndoAction = {
      id: 'undo-ack-redo-1',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: topicId,
      rootMessageIds: ['u1'],
      insertedMessageIds: ['u1', 'a1'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: undoParts.groupAnchors,
      segmentSnapshots: undoParts.segmentSnapshots
    }
    store.dispatch(pushUndoAction(deleteAction))

    const { executeUndo, executeRedo } = await import('../UndoService')
    const undone = await executeUndo(store.dispatch as any, store.getState as any)
    expect(undone?.type).toBe('delete')
    // Undo restored rows AND installed Main capability atomically.
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual(['u1', 'a1'])
    const stateAfterUndo = store.getState() as any
    expect(
      selectIsMessageMutable(
        { messages: stateAfterUndo.messages, residentRegistry: stateAfterUndo.residentRegistry } as never,
        topicId,
        'u1',
        null
      )
    ).toBe(true)
    expect(
      selectIsMessageMutable(
        { messages: stateAfterUndo.messages, residentRegistry: stateAfterUndo.residentRegistry } as never,
        topicId,
        'a1',
        null
      )
    ).toBe(true)

    // Redo re-deletes through the ORIGINAL guard (no bypass): exactly one Main call.
    mocks.deleteMessagesWithDependents.mockClear()
    mocks.deleteMessagesWithDependents.mockResolvedValue(deleteResponse)
    const redone = await executeRedo(store.dispatch as any, store.getState as any)
    expect(redone?.type).toBe('delete')
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledWith(topicId, ['u1'], null)
    expect((store.getState() as any).messages.messageIdsByTopic[topicId]).toEqual([])
    expect(newMessagesActions).toBeTruthy()
  })
})
