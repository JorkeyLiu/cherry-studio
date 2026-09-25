/**
 * UndoService branch-route correctness — migration 016 (`messages.branch_id`).
 *
 * redoDelete must re-delete in the topic's active route and undoPaste must
 * remove pasted copies in the topic's active route (null = main route).
 * Main-route behavior is unchanged: the null route owner is passed through.
 */

import type { AppDispatch, RootState } from '@renderer/store'
import type { DeleteUndoAction, PasteUndoAction } from '@renderer/types/editMode'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesFromDB: vi.fn(),
    executeDeleteMessagesWithDependents: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    replaceSegmentsForTopic: vi.fn((p: unknown) => ({ type: 'replaceSegmentsForTopic', p })),
    consumeFileCleanupResult: vi.fn(),
    upsertManyBlocks: vi.fn(),
    removeManyBlocks: vi.fn(),
    newMessagesActions: {
      removeMessages: vi.fn(),
      insertMessageAtIndex: vi.fn()
    },
    selectLoadedMessagesForTopic: vi.fn(() => []),
    prepareUndo: vi.fn(() => ({ type: 'prepareUndo' })),
    prepareRedo: vi.fn(() => ({ type: 'prepareRedo' })),
    restoreSegmentsAfterUndo: vi.fn(),
    syncSegmentsAfterMessageDeletion: vi.fn(),
    deleteSegmentsBySnapshots: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: mocks.deleteMessagesFromDB,
  executeDeleteMessagesWithDependents: mocks.executeDeleteMessagesWithDependents
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  deleteSegmentsBySnapshots: mocks.deleteSegmentsBySnapshots,
  restoreSegmentsAfterUndo: mocks.restoreSegmentsAfterUndo,
  restoreTargetSegments: vi.fn(),
  syncSegmentsAfterMessageDeletion: mocks.syncSegmentsAfterMessageDeletion
}))

vi.mock('@renderer/store/undoStack', () => ({
  prepareUndo: mocks.prepareUndo,
  prepareRedo: mocks.prepareRedo
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: mocks.upsertManyBlocks,
  removeManyBlocks: mocks.removeManyBlocks
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: mocks.newMessagesActions,
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
}))

vi.mock('@renderer/store/topicSegment', () => ({
  replaceSegmentsForTopic: mocks.replaceSegmentsForTopic
}))

// ── Store state ────────────────────────────────────────────────────────────

let storeState: RootState

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  }
}))

// ── Helpers ────────────────────────────────────────────────────────────────

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

const semanticRedoResponse = {
  ...emptyCleanup,
  deletedMessageIds: ['u1'],
  deletedBlockIds: ['blk-1'],
  previousUserMessageIds: ['u1'],
  remainingUserMessageIds: [] as string[],
  segments: [],
  restoreGroups: [],
  segmentSnapshots: []
}

function stateWithRoute(topicId: string, branchId: string | null): RootState {
  return {
    undoStack: { undoStack: [], redoStack: [] },
    messages: { entities: {} },
    messageBlocks: { entities: {} },
    topicBranch: {
      branchesByTopic: {},
      activeBranchIdByTopic: branchId === null ? {} : { [topicId]: branchId },
      routeGenerationByTopic: {}
    }
  } as unknown as RootState
}

function makeMessage(id: string): Message {
  return {
    id,
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    blocks: []
  } as unknown as Message
}

function deleteAction(): DeleteUndoAction {
  return {
    id: 'redo-del-branch',
    type: 'delete',
    timestamp: Date.now(),
    targetTopicId: 'topic-1',
    rootMessageIds: ['u1'],
    insertedMessageIds: ['u1'],
    pastedMessagesSnapshot: [],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: [],
    groupAnchors: [],
    segmentSnapshots: []
  }
}

function pasteAction(): PasteUndoAction {
  return {
    id: 'undo-paste-branch',
    type: 'paste',
    timestamp: Date.now(),
    targetTopicId: 'topic-1',
    insertedMessageIds: ['p1'],
    pastedMessagesSnapshot: [makeMessage('p1')],
    pastedBlocksSnapshot: [],
    fileReferenceDeltas: [],
    targetAnchorMessageId: null,
    targetInsertPositionIndex: 0,
    targetSegmentSnapshots: []
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('UndoService branch route (016)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)
    mocks.deleteMessagesWithDependents.mockResolvedValue(semanticRedoResponse)
    mocks.syncSegmentsAfterMessageDeletion.mockResolvedValue(undefined)
    mocks.restoreSegmentsAfterUndo.mockResolvedValue(undefined)
    mocks.deleteSegmentsBySnapshots.mockResolvedValue(undefined)
  })

  it('redoDelete re-deletes in the active branch route', async () => {
    storeState = stateWithRoute('topic-1', 'branch-7')
    storeState.undoStack = { undoStack: [], redoStack: [deleteAction()] }

    const { executeRedo } = await import('../UndoService')
    const result = await executeRedo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result?.type).toBe('delete')
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith('topic-1', ['u1'], 'branch-7')
  })

  it('redoDelete passes the null route on the main route (unchanged)', async () => {
    storeState = stateWithRoute('topic-1', null)
    storeState.undoStack = { undoStack: [], redoStack: [deleteAction()] }

    const { executeRedo } = await import('../UndoService')
    const result = await executeRedo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result?.type).toBe('delete')
    expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith('topic-1', ['u1'], null)
  })

  it('undoPaste removes pasted copies in the active branch route', async () => {
    storeState = stateWithRoute('topic-1', 'branch-7')
    storeState.messages.entities = { p1: makeMessage('p1') } as unknown as Record<string, Message>
    storeState.undoStack = { undoStack: [pasteAction()], redoStack: [] }

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result?.type).toBe('paste')
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['p1'], 'branch-7')
  })

  it('undoPaste passes the null route on the main route (unchanged)', async () => {
    storeState = stateWithRoute('topic-1', null)
    storeState.messages.entities = { p1: makeMessage('p1') } as unknown as Record<string, Message>
    storeState.undoStack = { undoStack: [pasteAction()], redoStack: [] }

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result?.type).toBe('paste')
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['p1'], null)
  })
})
