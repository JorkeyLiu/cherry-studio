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
    saveMessageAndBlocksToDB: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    updateFileCount: vi.fn(),
    upsertManyBlocks: vi.fn(),
    removeManyBlocks: vi.fn(),
    newMessagesActions: { removeMessages: vi.fn(), insertMessageAtIndex: vi.fn() },
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
    updateFileCount: mocks.updateFileCount
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: mocks.deleteMessagesFromDB,
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
    it('consumeFileCleanupResult called exactly once, no updateFileCount', async () => {
      const msg1 = makeMessage('msg-1', ['blk-1'])
      storeState.messages.entities = { 'msg-1': msg1 }

      const action: DeleteUndoAction = {
        id: 'redo-del-1',
        type: 'delete',
        timestamp: Date.now(),
        targetTopicId: 'topic-1',
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

      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(emptyCleanup)
      expect(mocks.updateFileCount).not.toHaveBeenCalled()
    })

    it('consumeFileCleanupResult called with file cleanup for file-bearing messages', async () => {
      const fileBlock = makeFileBlock('blk-1', 'file-1')
      const msg1 = makeMessage('msg-1', ['blk-1'])
      storeState.messages.entities = { 'msg-1': msg1 }
      storeState.messageBlocks.entities = { 'blk-1': fileBlock }

      mocks.deleteMessagesFromDB.mockResolvedValue(cleanupWithFiles)

      const action: DeleteUndoAction = {
        id: 'redo-del-2',
        type: 'delete',
        timestamp: Date.now(),
        targetTopicId: 'topic-1',
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

      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(cleanupWithFiles)
      expect(mocks.updateFileCount).not.toHaveBeenCalled()
    })
  })

  describe('redoCutPaste', () => {
    it('source deletion consumes cleanup once, no updateFileCount for source blocks', async () => {
      const srcMsg = makeMessage('src-msg-1', ['src-blk-1'])
      storeState.messages.entities = { 'src-msg-1': srcMsg }

      mocks.deleteMessagesFromDB.mockResolvedValue(cleanupWithFiles)

      const sourceAnchor = {
        messages: [srcMsg],
        blocks: [makeFileBlock('src-blk-1', 'file-1')],
        positionIndex: 0,
        anchorMessageId: null
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

      // Source deletion consumed cleanup exactly once
      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(cleanupWithFiles)

      // No separate updateFileCount for source blocks
      expect(mocks.updateFileCount).not.toHaveBeenCalled()
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
