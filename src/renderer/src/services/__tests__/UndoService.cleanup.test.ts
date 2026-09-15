/**
 * UndoService cleanup invariants — Phase 5.3 transaction-before-cleanup tests.
 *
 * LOCK-P5.3-1: undoPaste / redoDelete / redoCutPaste must consume
 * consumeFileCleanupResult exactly once for each destructive DB deletion,
 * and must NOT call dbService.updateFileCount separately. A second
 * updateFileCount would double-decrement Dexie files.count.
 *
 * LOCK-001: DB commit (deleteMessagesFromDB) must complete before
 * consumeFileCleanupResult is called.
 */

import type { AppDispatch, RootState } from '@renderer/store'
import type { CutPasteUndoAction, DeleteUndoAction, PasteUndoAction } from '@renderer/types/editMode'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesFromDB: vi.fn(),
    executeDeleteMessagesWithDependents: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    replaceSegmentsForTopic: vi.fn((p: unknown) => ({ type: 'replaceSegmentsForTopic', p })),
    saveMessageAndBlocksToDB: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    updateFileCount: vi.fn(),
    upsertManyBlocks: vi.fn(),
    removeManyBlocks: vi.fn(),
    newMessagesActions: {
      removeMessages: vi.fn(),
      insertMessageAtIndex: vi.fn(),
      updateManyMessages: vi.fn(),
      updateMessage: vi.fn()
    },
    selectMessagesForTopic: vi.fn(() => []),
    prepareUndo: vi.fn(() => ({ type: 'prepareUndo' })),
    prepareRedo: vi.fn(() => ({ type: 'prepareRedo' })),
    restoreGroupsByAnchors: vi.fn(),
    restoreSegmentsAfterUndo: vi.fn(),
    restoreTargetSegments: vi.fn(),
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
    updateFileCount: mocks.updateFileCount,
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: mocks.deleteMessagesFromDB,
  executeDeleteMessagesWithDependents: mocks.executeDeleteMessagesWithDependents,
  saveMessageAndBlocksToDB: mocks.saveMessageAndBlocksToDB
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  deleteSegmentsBySnapshots: mocks.deleteSegmentsBySnapshots,
  restoreSegmentsAfterUndo: mocks.restoreSegmentsAfterUndo,
  restoreTargetSegments: mocks.restoreTargetSegments,
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
  selectMessagesForTopic: mocks.selectMessagesForTopic
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

const cleanupWithFiles = {
  affectedFileIds: ['file-1', 'file-2'],
  remainingReferenceCounts: { 'file-1': 0, 'file-2': 0 } as Record<string, number>
}

function makeMessage(id: string, blocks: string[]): Message {
  return {
    id,
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    blocks
  } as Message
}

function makeFileBlock(id: string, fileId: string): MessageBlock {
  return {
    id,
    messageId: 'msg-1',
    type: MessageBlockType.FILE,
    content: '',
    file: { id: fileId, name: `${fileId}.pdf` }
  } as unknown as MessageBlock
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('UndoService cleanup invariants (LOCK-P5.3-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      undoStack: { undoStack: [], redoStack: [] },
      messages: { entities: {} },
      messageBlocks: { entities: {} }
    } as unknown as RootState
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)
    mocks.syncSegmentsAfterMessageDeletion.mockResolvedValue(undefined)
    mocks.restoreSegmentsAfterUndo.mockResolvedValue(undefined)
    mocks.restoreTargetSegments.mockResolvedValue(undefined)
    mocks.deleteSegmentsBySnapshots.mockResolvedValue(undefined)
  })

  describe('undoPaste', () => {
    it('consumeFileCleanupResult called exactly once, no updateFileCount (LOCK-P5.3-1)', async () => {
      const msg1 = makeMessage('msg-1', ['blk-1'])
      const msg2 = makeMessage('msg-2', ['blk-2'])
      storeState.messages.entities = { 'msg-1': msg1, 'msg-2': msg2 }

      const action: PasteUndoAction = {
        id: 'undo-1',
        type: 'paste',
        timestamp: Date.now(),
        targetTopicId: 'topic-1',
        insertedMessageIds: ['msg-1', 'msg-2'],
        pastedMessagesSnapshot: [msg1, msg2],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        targetAnchorMessageId: null,
        targetInsertPositionIndex: 0,
        targetSegmentSnapshots: []
      }

      const { executeUndo } = await import('../UndoService')
      const dispatch = vi.fn() as unknown as AppDispatch

      // Push action onto undo stack
      storeState.undoStack = { undoStack: [action], redoStack: [] }

      await executeUndo(dispatch, () => storeState)

      // consumeFileCleanupResult called exactly once with the DB result
      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(emptyCleanup)

      // CRITICAL: no separate updateFileCount — cleanup already handles file refs
      expect(mocks.updateFileCount).not.toHaveBeenCalled()
    })
  })

  describe('redoDelete', () => {
    const semanticRedoResponse = {
      affectedFileIds: [],
      remainingReferenceCounts: {} as Record<string, number>,
      deletedMessageIds: ['msg-1'],
      deletedBlockIds: ['blk-1'],
      previousUserMessageIds: ['msg-1'],
      remainingUserMessageIds: [] as string[],
      segments: [],
      restoreGroups: [
        { entries: [{ message: { id: 'msg-1' }, blocks: [{ id: 'blk-1' }] }], positionIndex: 0, anchorMessageId: null }
      ],
      segmentSnapshots: []
    }

    it('re-issues the original root IDs via the semantic command (never expanded IDs as intent)', async () => {
      const msg1 = makeMessage('msg-1', ['blk-1'])
      storeState.messages.entities = { 'msg-1': msg1 }
      mocks.deleteMessagesWithDependents.mockResolvedValue(semanticRedoResponse)

      const action: DeleteUndoAction = {
        id: 'redo-del-1',
        type: 'delete',
        timestamp: Date.now(),
        targetTopicId: 'topic-1',
        rootMessageIds: ['u1'],
        insertedMessageIds: ['u1', 'a1'],
        pastedMessagesSnapshot: [],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        groupAnchors: [],
        segmentSnapshots: []
      }

      const { executeRedo } = await import('../UndoService')
      const dispatch = vi.fn() as unknown as AppDispatch

      storeState.undoStack = { undoStack: [], redoStack: [action] }

      await executeRedo(dispatch, () => storeState)

      expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith('topic-1', ['u1'])
      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(semanticRedoResponse)
      expect(mocks.updateFileCount).not.toHaveBeenCalled()
    })

    it('falls back to expanded IDs for legacy actions and converges segments from the response', async () => {
      const msg1 = makeMessage('msg-1', ['blk-1'])
      storeState.messages.entities = { 'msg-1': msg1 }
      mocks.deleteMessagesWithDependents.mockResolvedValue(semanticRedoResponse)

      const action: DeleteUndoAction = {
        id: 'redo-del-legacy',
        type: 'delete',
        timestamp: Date.now(),
        targetTopicId: 'topic-1',
        rootMessageIds: [],
        insertedMessageIds: ['msg-1'],
        pastedMessagesSnapshot: [],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        groupAnchors: [],
        segmentSnapshots: []
      }

      const { executeRedo } = await import('../UndoService')
      const dispatch = vi.fn() as unknown as AppDispatch

      storeState.undoStack = { undoStack: [], redoStack: [action] }

      await executeRedo(dispatch, () => storeState)

      expect(mocks.deleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith('topic-1', ['msg-1'])
      // Authority convergence: exact expanded removal + full segment replace, no loaded segment sync.
      expect(mocks.newMessagesActions.removeMessages).toHaveBeenCalledWith({
        topicId: 'topic-1',
        messageIds: ['msg-1']
      })
      expect(mocks.removeManyBlocks).toHaveBeenCalledWith(['blk-1'])
      expect(mocks.replaceSegmentsForTopic).toHaveBeenCalledTimes(1)
      expect(mocks.syncSegmentsAfterMessageDeletion).not.toHaveBeenCalled()
    })

    it('consumeFileCleanupResult called with file cleanup for file-bearing messages', async () => {
      const fileBlock = makeFileBlock('blk-1', 'file-1')
      const msg1 = makeMessage('msg-1', ['blk-1'])
      storeState.messages.entities = { 'msg-1': msg1 }
      storeState.messageBlocks.entities = { 'blk-1': fileBlock }

      const responseWithFiles = { ...semanticRedoResponse, ...cleanupWithFiles }
      mocks.deleteMessagesWithDependents.mockResolvedValue(responseWithFiles)

      const action: DeleteUndoAction = {
        id: 'redo-del-2',
        type: 'delete',
        timestamp: Date.now(),
        targetTopicId: 'topic-1',
        rootMessageIds: ['msg-1'],
        insertedMessageIds: ['msg-1'],
        pastedMessagesSnapshot: [],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [{ fileId: 'file-1', delta: 1 }],
        groupAnchors: [],
        segmentSnapshots: []
      }

      const { executeRedo } = await import('../UndoService')
      const dispatch = vi.fn() as unknown as AppDispatch

      storeState.undoStack = { undoStack: [], redoStack: [action] }

      await executeRedo(dispatch, () => storeState)

      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(responseWithFiles)
      expect(mocks.updateFileCount).not.toHaveBeenCalled()
    })

    it('DB failure yields no cleanup consume and returns null', async () => {
      mocks.deleteMessagesWithDependents.mockRejectedValue(new Error('SQLITE_FAILURE'))

      const action: DeleteUndoAction = {
        id: 'redo-del-fail',
        type: 'delete',
        timestamp: Date.now(),
        targetTopicId: 'topic-1',
        rootMessageIds: ['msg-1'],
        insertedMessageIds: ['msg-1'],
        pastedMessagesSnapshot: [],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        groupAnchors: [],
        segmentSnapshots: []
      }

      const { executeRedo } = await import('../UndoService')
      const dispatch = vi.fn() as unknown as AppDispatch

      storeState.undoStack = { undoStack: [], redoStack: [action] }

      const result = await executeRedo(dispatch, () => storeState)

      expect(result).toBeNull()
      expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    })
  })

  describe('redoCutPaste', () => {
    it('source re-delete uses the semantic plural helper with stored member roots (no legacy plain delete)', async () => {
      const srcMsg = makeMessage('src-msg-1', ['src-blk-1'])
      storeState.messages.entities = { 'src-msg-1': srcMsg }

      mocks.executeDeleteMessagesWithDependents.mockResolvedValue({
        response: { deletedMessageIds: ['src-msg-1'] },
        undoParts: { groupAnchors: [], segmentSnapshots: [], fileReferenceDeltas: [] }
      })

      const sourceAnchor = {
        messages: [srcMsg],
        blocks: [{ ...makeFileBlock('src-blk-1', 'file-1'), messageId: 'src-msg-1' }],
        positionIndex: 0,
        anchorMessageId: null,
        loadedMessageIds: ['src-msg-1']
      }

      const action: CutPasteUndoAction = {
        id: 'redo-cut-1',
        type: 'cut_paste',
        timestamp: Date.now(),
        targetTopicId: 'target-topic',
        insertedMessageIds: [],
        pastedMessagesSnapshot: [],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [{ fileId: 'file-1', delta: 1 }],
        sourceTopicId: 'source-topic',
        sourceRootIds: ['src-msg-1'],
        sourceGroupAnchors: [sourceAnchor],
        sourceSegmentSnapshots: [],
        targetSegmentSnapshots: [],
        targetAnchorMessageId: null,
        targetInsertPositionIndex: 0
      }

      const { executeRedo } = await import('../UndoService')
      const dispatch = vi.fn() as unknown as AppDispatch

      storeState.undoStack = { undoStack: [], redoStack: [action] }

      await executeRedo(dispatch, () => storeState)

      // Semantic helper owns cleanup/convergence/anchor transfer.
      expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(
        dispatch,
        expect.any(Function),
        'source-topic',
        ['src-msg-1']
      )
      // No legacy plain-delete protocol for the source.
      expect(mocks.deleteMessagesFromDB).not.toHaveBeenCalled()
      expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
      expect(mocks.syncSegmentsAfterMessageDeletion).not.toHaveBeenCalled()
      expect(mocks.removeManyBlocks).not.toHaveBeenCalled()

      // No separate updateFileCount for source blocks
      expect(mocks.updateFileCount).not.toHaveBeenCalled()
    })

    it('legacy action without sourceRootIds fails closed (no DB mutation, redo returns null)', async () => {
      const srcMsg = makeMessage('src-msg-1', ['src-blk-1'])
      storeState.messages.entities = { 'src-msg-1': srcMsg }

      const sourceAnchor = {
        messages: [srcMsg],
        blocks: [],
        positionIndex: 0,
        anchorMessageId: null,
        loadedMessageIds: ['src-msg-1']
      }

      const legacyAction: CutPasteUndoAction = {
        id: 'redo-cut-legacy',
        type: 'cut_paste',
        timestamp: Date.now(),
        targetTopicId: 'target-topic',
        insertedMessageIds: [],
        pastedMessagesSnapshot: [],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        sourceTopicId: 'source-topic',
        sourceGroupAnchors: [sourceAnchor],
        sourceSegmentSnapshots: [],
        targetSegmentSnapshots: [],
        targetAnchorMessageId: null,
        targetInsertPositionIndex: 0
      }
      // No sourceRootIds: legacy in-memory action.

      const { executeRedo } = await import('../UndoService')
      const dispatch = vi.fn() as unknown as AppDispatch

      storeState.undoStack = { undoStack: [], redoStack: [legacyAction] }

      const result = await executeRedo(dispatch, () => storeState)

      expect(result).toBeNull()
      expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
      expect(mocks.deleteMessagesFromDB).not.toHaveBeenCalled()
    })
  })

  describe('ordering invariant', () => {
    it('undoPaste: DB commit before consumeFileCleanupResult', async () => {
      const msg1 = makeMessage('msg-1', ['blk-1'])
      storeState.messages.entities = { 'msg-1': msg1 }

      const callOrder: string[] = []
      mocks.deleteMessagesFromDB.mockImplementation(async () => {
        callOrder.push('db')
        return emptyCleanup
      })
      mocks.consumeFileCleanupResult.mockImplementation(async () => {
        callOrder.push('cleanup')
      })

      const action: PasteUndoAction = {
        id: 'undo-ord-1',
        type: 'paste',
        timestamp: Date.now(),
        targetTopicId: 'topic-1',
        insertedMessageIds: ['msg-1'],
        pastedMessagesSnapshot: [msg1],
        pastedBlocksSnapshot: [],
        fileReferenceDeltas: [],
        targetAnchorMessageId: null,
        targetInsertPositionIndex: 0,
        targetSegmentSnapshots: []
      }

      const { executeUndo } = await import('../UndoService')
      const dispatch = vi.fn() as unknown as AppDispatch

      storeState.undoStack = { undoStack: [action], redoStack: [] }

      await executeUndo(dispatch, () => storeState)

      // DB must complete before cleanup
      expect(callOrder).toEqual(['db', 'cleanup'])
    })
  })
})
