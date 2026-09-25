/**
 * UndoService cut-paste undo/redo — same-topic anchor hazard + semantic redo.
 *
 * 1) Same-topic cut-paste undo where the source restore anchor IS an inserted
 *    copy: undo restores the source BEFORE deleting the copies (no data loss).
 *    Proves both phases run in order and history advances.
 * 2) Source-restore failure: paste copies remain (no paste deletion), history
 *    does not advance (executeUndo returns null).
 * 3) Redo cut-paste uses the semantic plural delete helper with stable member
 *    roots (including an outside-loaded member), preserving segment/anchor
 *    side effects via the helper with no legacy plain-delete protocol.
 */

import type { AppDispatch, RootState } from '@renderer/store'
import type { CutPasteUndoAction } from '@renderer/types/editMode'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertMessageGroups: vi.fn(),
    deleteMessagesFromDB: vi.fn(),
    executeDeleteMessagesWithDependents: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    updateFileCount: vi.fn(),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/removeManyBlocks', payload: p })),
    newMessagesActions: {
      removeMessages: vi.fn((p: unknown) => ({ type: 'newMessages/removeMessages', payload: p })),
      insertMessageAtIndex: vi.fn((p: unknown) => ({ type: 'newMessages/insertMessageAtIndex', payload: p }))
    },
    selectLoadedMessagesForTopic: vi.fn(() => []),
    prepareUndo: vi.fn(() => ({ type: 'prepareUndo' })),
    prepareRedo: vi.fn(() => ({ type: 'prepareRedo' })),
    restoreSegmentsAfterUndo: vi.fn().mockResolvedValue(undefined),
    restoreTargetSegments: vi.fn().mockResolvedValue(undefined),
    syncSegmentsAfterMessageDeletion: vi.fn().mockResolvedValue(undefined),
    deleteSegmentsBySnapshots: vi.fn().mockResolvedValue(undefined),
    replaceSegmentsForTopic: vi.fn((p: unknown) => ({ type: 'replaceSegmentsForTopic', p }))
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    insertMessageGroups: mocks.insertMessageGroups,
    updateFileCount: mocks.updateFileCount,
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
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
}))

vi.mock('@renderer/store/topicSegment', () => ({
  replaceSegmentsForTopic: mocks.replaceSegmentsForTopic
}))

vi.mock('@renderer/store', () => ({
  default: { dispatch: vi.fn(), getState: () => storeState }
}))

let storeState: RootState

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

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

describe('UndoService cut-paste undo/redo (same-topic hazard + semantic redo)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      undoStack: { undoStack: [], redoStack: [] },
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} }
    } as unknown as RootState
    mocks.insertMessageGroups.mockResolvedValue(emptyCleanup)
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue({
      response: { deletedMessageIds: [] },
      undoParts: { groupAnchors: [], segmentSnapshots: [], fileReferenceDeltas: [] }
    })
  })

  it('same-topic undo restores the source BEFORE deleting copies whose IDs anchor the restore', async () => {
    // Source group [src-u, src-a] was cut and pasted into the SAME topic.
    // Authority restore anchor references an inserted copy (paste-copy-1),
    // which only exists until the paste-copy deletion runs.
    const srcU = makeMessage('src-u')
    const srcA = { ...makeMessage('src-a'), role: 'assistant', askId: 'src-u' } as unknown as Message
    const copy1 = makeMessage('paste-copy-1')
    const copy2 = makeMessage('paste-copy-2')
    const action: CutPasteUndoAction = {
      id: 'undo-same-topic',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['paste-copy-1', 'paste-copy-2'],
      pastedMessagesSnapshot: [copy1, copy2],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceRootIds: ['src-u', 'src-a'],
      sourceGroupAnchors: [
        {
          messages: [srcU, srcA],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: 'paste-copy-1',
          loadedMessageIds: ['src-u', 'src-a']
        }
      ],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    }
    // Loaded projection holds the anchor copy so the stable restore resolves.
    storeState.messages.entities = {
      'paste-copy-1': copy1,
      'paste-copy-2': copy2
    } as unknown as Record<string, Message>
    storeState.messages.messageIdsByTopic = { 'topic-1': ['paste-copy-1', 'paste-copy-2'] }
    mocks.selectLoadedMessagesForTopic.mockImplementation((() => [
      { id: 'paste-copy-1' },
      { id: 'paste-copy-2' }
    ]) as any)
    storeState.undoStack = { undoStack: [action], redoStack: [] }

    const callOrder: string[] = []
    mocks.insertMessageGroups.mockImplementation(async () => {
      callOrder.push('source-restore')
      return emptyCleanup
    })
    mocks.deleteMessagesFromDB.mockImplementation(async () => {
      callOrder.push('paste-delete')
      return emptyCleanup
    })

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    // Complete success: history advances (action returned).
    expect(result).not.toBeNull()
    expect(result?.type).toBe('cut_paste')
    // Source restore ran FIRST while the anchoring copy still existed.
    expect(callOrder).toEqual(['source-restore', 'paste-delete'])
    // Source restore used the stable anchor referencing the inserted copy.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    const [, groups] = mocks.insertMessageGroups.mock.calls[0] as unknown as [
      string,
      Array<{ intent: { kind: string; messageId?: string } }>
    ]
    expect(groups[0].intent).toEqual({ kind: 'before-message', messageId: 'paste-copy-1' })
    // Paste copies removed afterwards via the exact inserted IDs.
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith(
      'topic-1',
      ['paste-copy-1', 'paste-copy-2'],
      null
    )
  })

  it('source-restore failure leaves paste copies untouched (no data loss, history does not advance)', async () => {
    const srcU = makeMessage('src-u')
    const copy1 = makeMessage('paste-copy-1')
    const action: CutPasteUndoAction = {
      id: 'undo-restore-fail',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['paste-copy-1'],
      pastedMessagesSnapshot: [copy1],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceRootIds: ['src-u'],
      sourceGroupAnchors: [
        {
          messages: [srcU],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: 'paste-copy-1',
          loadedMessageIds: ['src-u']
        }
      ],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    }
    storeState.messages.entities = { 'paste-copy-1': copy1 } as unknown as Record<string, Message>
    storeState.undoStack = { undoStack: [action], redoStack: [] }
    mocks.insertMessageGroups.mockRejectedValue(new Error('SQLITE_RESTORE_FAIL'))

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    // Failure: history does not advance.
    expect(result).toBeNull()
    // Paste copies were never touched after the failed source restore.
    expect(mocks.deleteMessagesFromDB).not.toHaveBeenCalled()
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    expect(mocks.newMessagesActions.removeMessages).not.toHaveBeenCalled()
  })

  it('redo uses the semantic plural helper with stable member roots (outside-loaded member) and no legacy delete', async () => {
    // Source group u1 = [u1, a1, a2] where a2 was outside the loaded
    // projection at paste time. Stable roots carry the complete member set.
    const u1 = makeMessage('u1')
    const a1 = { ...makeMessage('a1'), role: 'assistant', askId: 'u1' } as unknown as Message
    const a2 = { ...makeMessage('a2'), role: 'assistant', askId: 'u1' } as unknown as Message
    const pasted = makeMessage('pasted-1')
    const pastedBlock = { id: 'pb-1', messageId: 'pasted-1' } as unknown as MessageBlock
    const sourceSegment = {
      id: 'seg-src',
      topicId: 'topic-1',
      name: 'Src',
      messageIds: ['u1', 'a1', 'a2']
    }
    const action: CutPasteUndoAction = {
      id: 'redo-semantic',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['pasted-1'],
      pastedMessagesSnapshot: [pasted],
      pastedBlocksSnapshot: [pastedBlock],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceRootIds: ['u1', 'a1', 'a2'],
      sourceGroupAnchors: [
        {
          messages: [u1, a1, a2],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          // a2 was outside-loaded before delete: projection subset only.
          loadedMessageIds: ['u1', 'a1']
        }
      ],
      sourceSegmentSnapshots: [sourceSegment as any],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 99,
      targetInsertIntent: { kind: 'topic-tail' }
    }
    // Loaded projection holds only u1/a1 (a2 outside) — redo must still send
    // the full member roots; the helper (Main) owns expansion/convergence.
    storeState.messages.entities = {
      u1,
      a1,
      pasted
    } as unknown as Record<string, Message>
    storeState.messages.messageIdsByTopic = { 'topic-1': ['u1', 'a1'] }
    storeState.undoStack = { undoStack: [], redoStack: [action] }
    mocks.selectLoadedMessagesForTopic.mockImplementation((() => [{ id: 'u1' }, { id: 'a1' }]) as any)

    const { executeRedo } = await import('../UndoService')
    const result = await executeRedo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    // Same semantic plural helper as the initial cut-paste, with the complete
    // member roots in authority order (outside-loaded a2 included).
    expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      'topic-1',
      ['u1', 'a1', 'a2']
    )
    // No legacy plain-delete authority mutation for the source.
    expect(mocks.deleteMessagesFromDB).not.toHaveBeenCalled()
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    expect(mocks.syncSegmentsAfterMessageDeletion).not.toHaveBeenCalled()
    expect(mocks.removeManyBlocks).not.toHaveBeenCalled()
    // Target re-insert still uses the stored stable intent (never numeric).
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    const [, groups] = mocks.insertMessageGroups.mock.calls[0] as unknown as [string, Array<{ intent: unknown }>]
    expect(groups[0].intent).toEqual({ kind: 'topic-tail' })
  })
})
