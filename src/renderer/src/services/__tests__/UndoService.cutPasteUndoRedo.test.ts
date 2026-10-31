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
    executeStagedCutSourceDelete: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    fetchTopicBranchesThunk: vi.fn(),
    updateFileCount: vi.fn(),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/removeManyBlocks', payload: p })),
    newMessagesActions: {
      removeMessages: vi.fn((p: unknown) => ({ type: 'newMessages/removeMessages', payload: p })),
      insertMessageAtIndex: vi.fn((p: unknown) => ({ type: 'newMessages/insertMessageAtIndex', payload: p })),
      applyInsertedMessageGroups: vi.fn((p: unknown) => ({
        type: 'newMessages/applyInsertedMessageGroups',
        payload: p
      }))
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
  executeDeleteMessagesWithDependents: mocks.executeDeleteMessagesWithDependents,
  executeStagedCutSourceDelete: mocks.executeStagedCutSourceDelete,
  fetchTopicBranchesThunk: mocks.fetchTopicBranchesThunk
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

function ackFromGroups(
  topicId: string,
  groups: Array<{ entries: Array<{ message: { id: string } }> }>,
  branchId: string | null = null
) {
  const flatIds = groups.flatMap((g) => g.entries.map((e) => e.message.id))
  return {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    topicId,
    branchId,
    insertedMessages: flatIds.map((id) => ({ id })),
    insertedBlocks: [],
    insertedMessageIds: flatIds,
    mutableMessageIds: [...flatIds],
    groups: groups.map((g) => ({
      insertedMessageIds: g.entries.map((e) => e.message.id),
      beforeMessageId: null,
      nextMessageId: null
    }))
  }
}

function mockInsertAckDefault() {
  mocks.insertMessageGroups.mockImplementation(
    async (topicId: string, groups: Array<{ entries: Array<{ message: { id: string } }> }>, branchId?: string | null) =>
      ackFromGroups(topicId, groups, branchId ?? null)
  )
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

describe('UndoService cut-paste undo/redo (same-topic hazard + semantic redo)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      undoStack: { undoStack: [], redoStack: [] },
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} }
    } as unknown as RootState
    mockInsertAckDefault()
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue({
      response: { deletedMessageIds: [] },
      undoParts: { groupAnchors: [], segmentSnapshots: [], fileReferenceDeltas: [] }
    })
    mocks.executeStagedCutSourceDelete.mockResolvedValue({
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
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: null, loadedMessageIds: ['src-u', 'src-a'] },
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
    mocks.insertMessageGroups.mockImplementation(
      async (
        topicId: string,
        groups: Array<{ entries: Array<{ message: { id: string } }> }>,
        branchId?: string | null
      ) => {
        callOrder.push('source-restore')
        return ackFromGroups(topicId, groups, branchId ?? null)
      }
    )
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
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: null, loadedMessageIds: ['src-u'] },
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

  it('redo uses the staged authority helper with stable member roots (outside-loaded member) and no legacy delete', async () => {
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
      sourceBranchId: null,
      targetBranchId: null,
      sourceRootIds: ['u1', 'a1', 'a2'],
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: null, loadedMessageIds: ['u1', 'a1', 'a2'] },
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
    // Staged-cut authority helper with the stored route and complete member
    // roots in authority order (outside-loaded a2 included).
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-1',
        sourceBranchId: null,
        rootIds: ['u1', 'a1', 'a2'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-1', sourceBranchId: null })
      })
    )
    expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
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

  it('staged cut undo works after projection mutable IDs are cleared (no capability rerequire)', async () => {
    const srcU = makeMessage('src-u')
    const copy1 = makeMessage('paste-copy-1')
    const action: CutPasteUndoAction = {
      id: 'undo-staged-route',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['paste-copy-1'],
      pastedMessagesSnapshot: [copy1],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceBranchId: null,
      targetBranchId: null,
      sourceRootIds: ['src-u'],
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: null, loadedMessageIds: ['src-u'] },
      sourceGroupAnchors: [
        {
          messages: [srcU],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          loadedMessageIds: []
        }
      ],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    }
    // Projection capability cleared (messagesReceived without capability):
    // no mutable set, but the staged routes still match main (null).
    storeState.messages.entities = { 'paste-copy-1': copy1 } as unknown as Record<string, Message>
    storeState.messages.messageIdsByTopic = { 'topic-1': ['paste-copy-1'] }
    ;(storeState.messages as unknown as Record<string, unknown>).mutableMessageIdsByTopic = {}
    ;(storeState.messages as unknown as Record<string, unknown>).mutableRouteByTopic = {}
    storeState.undoStack = { undoStack: [action], redoStack: [] }

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['paste-copy-1'], null)
  })

  it('staged cut undo uses staged routes independent of the live route (branch switch completes)', async () => {
    // Same-topic branch switch after paste: staged source branch differs from
    // the live route, but undo still restores the staged source and removes
    // the staged target copies with explicit addresses. No live-route refusal.
    const srcU = makeMessage('src-u')
    const copy1 = makeMessage('paste-copy-1')
    const action: CutPasteUndoAction = {
      id: 'undo-staged-branch-switch',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['paste-copy-1'],
      pastedMessagesSnapshot: [copy1],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceBranchId: 'branch-staged',
      targetBranchId: null,
      sourceRootIds: ['src-u'],
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: 'branch-staged', loadedMessageIds: ['src-u'] },
      sourceGroupAnchors: [
        {
          messages: [srcU],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          loadedMessageIds: ['src-u']
        }
      ],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    }
    storeState.messages.entities = { 'paste-copy-1': copy1 } as unknown as Record<string, Message>
    storeState.messages.messageIdsByTopic = { 'topic-1': ['paste-copy-1'] }
    storeState.undoStack = { undoStack: [action], redoStack: [] }

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    // Source restore addressed the staged source branch explicitly.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups.mock.calls[0][0]).toBe('topic-1')
    expect(mocks.insertMessageGroups.mock.calls[0][2]).toBe('branch-staged')
    // Pasted-copy removal addressed the staged target (main) explicitly.
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['paste-copy-1'], null)
  })

  it('staged cut redo uses staged routes independent of the live route (branch switch completes)', async () => {
    const pasted = makeMessage('pasted-1')
    const action: CutPasteUndoAction = {
      id: 'redo-staged-branch-switch',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['pasted-1'],
      pastedMessagesSnapshot: [pasted],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceBranchId: 'branch-staged',
      targetBranchId: null,
      sourceRootIds: ['src-u'],
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: 'branch-staged', loadedMessageIds: ['src-u'] },
      sourceGroupAnchors: [
        {
          messages: [makeMessage('src-u')],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          loadedMessageIds: []
        }
      ],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0,
      targetInsertIntent: { kind: 'topic-tail' }
    }
    storeState.undoStack = { undoStack: [], redoStack: [action] }

    const { executeRedo } = await import('../UndoService')
    const result = await executeRedo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-1',
        sourceBranchId: 'branch-staged',
        rootIds: ['src-u'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-1', sourceBranchId: 'branch-staged' })
      })
    )
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
  })

  it('cut_paste undo sync keeps the pinned target route when live switches mid-cleanup', async () => {
    const srcU = makeMessage('src-u')
    srcU.topicId = 'topic-2'
    const copy1 = makeMessage('paste-copy-1')
    copy1.topicId = 'topic-1'
    const action: CutPasteUndoAction = {
      id: 'undo-pinned-route',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['paste-copy-1'],
      pastedMessagesSnapshot: [copy1],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-2',
      sourceBranchId: 'branch-src',
      targetBranchId: 'branch-orig',
      sourceRootIds: ['src-u'],
      sourceProjection: { sourceTopicId: 'topic-2', sourceBranchId: 'branch-src', loadedMessageIds: ['src-u'] },
      sourceGroupAnchors: [
        {
          messages: [srcU],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          loadedMessageIds: ['src-u']
        }
      ],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    }
    ;(storeState as unknown as Record<string, unknown>).topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: { 'topic-1': 'branch-orig', 'topic-2': 'branch-src' },
      routeGenerationByTopic: {}
    }
    storeState.messages.entities = { 'paste-copy-1': copy1 } as unknown as Record<string, Message>
    storeState.messages.messageIdsByTopic = { 'topic-1': ['paste-copy-1'] }
    storeState.undoStack = { undoStack: [action], redoStack: [] }
    mocks.deleteMessagesFromDB.mockImplementation(async () => {
      ;(
        storeState as unknown as Record<string, { activeBranchIdByTopic: Record<string, string> }>
      ).topicBranch.activeBranchIdByTopic['topic-1'] = 'branch-new'
      return emptyCleanup
    })

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    // Target copy removal stays on the pinned original route.
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['paste-copy-1'], 'branch-orig')
    expect(mocks.syncSegmentsAfterMessageDeletion).toHaveBeenCalledTimes(1)
    expect(mocks.syncSegmentsAfterMessageDeletion.mock.calls[0][2]).toBe('topic-1')
    expect(mocks.syncSegmentsAfterMessageDeletion.mock.calls[0][4]).toBe('branch-orig')
    for (const call of mocks.syncSegmentsAfterMessageDeletion.mock.calls) {
      expect(call[4]).not.toBe('branch-new')
      expect(call[2]).not.toBe('topic-2')
    }
  })

  it('staged cut undo threads the staged source route into segment restore while live differs (sibling + main)', async () => {
    // Same-topic fully selected segment: cut staged on branch-staged, pasted
    // to main, then the live route switched to branch-live. Undo must restore
    // source segments addressed at the staged source — never the live route.
    const srcU = makeMessage('src-u')
    const copy1 = makeMessage('paste-copy-1')
    const sourceSeg = { id: 'seg-src', topicId: 'topic-1', name: 'Src', messageIds: ['src-u'] }
    const targetSeg = { id: 'seg-tgt', topicId: 'topic-1', name: 'Tgt', messageIds: ['paste-copy-1'] }
    const action: CutPasteUndoAction = {
      id: 'undo-staged-segments',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['paste-copy-1'],
      pastedMessagesSnapshot: [copy1],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceBranchId: 'branch-staged',
      targetBranchId: null,
      sourceRootIds: ['src-u'],
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: 'branch-staged', loadedMessageIds: ['src-u'] },
      sourceGroupAnchors: [
        {
          messages: [srcU],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          loadedMessageIds: ['src-u']
        }
      ],
      sourceSegmentSnapshots: [sourceSeg as any],
      targetSegmentSnapshots: [targetSeg as any],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    }
    ;(storeState as unknown as Record<string, unknown>).topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: { 'topic-1': 'branch-live' },
      routeGenerationByTopic: {}
    }
    storeState.messages.entities = { 'paste-copy-1': copy1 } as unknown as Record<string, Message>
    storeState.messages.messageIdsByTopic = { 'topic-1': ['paste-copy-1'] }
    storeState.undoStack = { undoStack: [action], redoStack: [] }

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    // Message phase still addressed at the staged routes.
    expect(mocks.insertMessageGroups.mock.calls[0][2]).toBe('branch-staged')
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['paste-copy-1'], null)
    // Segment phase: source restore pinned to the staged source route.
    expect(mocks.restoreSegmentsAfterUndo).toHaveBeenCalledTimes(1)
    expect(mocks.restoreSegmentsAfterUndo.mock.calls[0][2]).toEqual([sourceSeg])
    expect(mocks.restoreSegmentsAfterUndo.mock.calls[0][3]).toBe('branch-staged')
    // Target cleanup pinned to the staged target (main), never live.
    // Third arg threads the caller store for fenced convergence reads.
    expect(mocks.deleteSegmentsBySnapshots).toHaveBeenCalledTimes(1)
    expect(mocks.deleteSegmentsBySnapshots.mock.calls[0][1]).toEqual([targetSeg])
    expect(mocks.syncSegmentsAfterMessageDeletion.mock.calls[0][4]).toBe(null)
    for (const call of mocks.syncSegmentsAfterMessageDeletion.mock.calls) {
      expect(call[4]).not.toBe('branch-live')
    }
  })

  it('staged cut undo with explicit main source pins null into segment restore (sibling target)', async () => {
    const srcU = makeMessage('src-u')
    const copy1 = makeMessage('paste-copy-1')
    const sourceSeg = { id: 'seg-src', topicId: 'topic-1', name: 'Src', messageIds: ['src-u'] }
    const action: CutPasteUndoAction = {
      id: 'undo-main-source-segments',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['paste-copy-1'],
      pastedMessagesSnapshot: [copy1],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceBranchId: null,
      targetBranchId: 'branch-sib',
      sourceRootIds: ['src-u'],
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: null, loadedMessageIds: ['src-u'] },
      sourceGroupAnchors: [
        {
          messages: [srcU],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          loadedMessageIds: ['src-u']
        }
      ],
      sourceSegmentSnapshots: [sourceSeg as any],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    }
    ;(storeState as unknown as Record<string, unknown>).topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: { 'topic-1': 'branch-live' },
      routeGenerationByTopic: {}
    }
    storeState.messages.entities = { 'paste-copy-1': copy1 } as unknown as Record<string, Message>
    storeState.messages.messageIdsByTopic = { 'topic-1': ['paste-copy-1'] }
    storeState.undoStack = { undoStack: [action], redoStack: [] }

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    // Explicit main (null) is a pinned address, not an omission.
    expect(mocks.restoreSegmentsAfterUndo).toHaveBeenCalledTimes(1)
    expect(mocks.restoreSegmentsAfterUndo.mock.calls[0][3]).toBe(null)
    expect(mocks.deleteMessagesFromDB).toHaveBeenCalledExactlyOnceWith('topic-1', ['paste-copy-1'], 'branch-sib')
  })

  it('staged cut redo threads the staged target route into target segment restore while live differs', async () => {
    const pasted = makeMessage('pasted-1')
    const targetSeg = {
      id: 'seg-tgt',
      topicId: 'topic-1',
      name: 'Tgt',
      messageIds: ['pasted-1'],
      color: 'color-seg-tgt',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    const action: CutPasteUndoAction = {
      id: 'redo-staged-target-segments',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['pasted-1'],
      pastedMessagesSnapshot: [pasted],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceBranchId: 'branch-src',
      targetBranchId: 'branch-tgt',
      sourceRootIds: ['src-u'],
      sourceProjection: { sourceTopicId: 'topic-1', sourceBranchId: 'branch-src', loadedMessageIds: ['src-u'] },
      sourceGroupAnchors: [
        {
          messages: [makeMessage('src-u')],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          loadedMessageIds: []
        }
      ],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [targetSeg as any],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0,
      targetInsertIntent: { kind: 'topic-tail' }
    }
    ;(storeState as unknown as Record<string, unknown>).topicBranch = {
      branchesByTopic: {},
      activeBranchIdByTopic: { 'topic-1': 'branch-live' },
      routeGenerationByTopic: {}
    }
    storeState.undoStack = { undoStack: [], redoStack: [action] }

    const { executeRedo } = await import('../UndoService')
    const result = await executeRedo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    expect(mocks.executeStagedCutSourceDelete).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        sourceTopicId: 'topic-1',
        sourceBranchId: 'branch-src',
        rootIds: ['src-u'],
        sourceProjection: expect.objectContaining({ sourceTopicId: 'topic-1', sourceBranchId: 'branch-src' })
      })
    )
    // Target re-insert and segment restore both pinned to the staged target.
    expect(mocks.insertMessageGroups.mock.calls[0][2]).toBe('branch-tgt')
    expect(mocks.restoreTargetSegments).toHaveBeenCalledTimes(1)
    expect(mocks.restoreTargetSegments.mock.calls[0][1]).toEqual([targetSeg])
    expect(mocks.restoreTargetSegments.mock.calls[0][2]).toBe('branch-tgt')
  })

  it('legacy cut_paste undo without staged routes omits the segment route (live-route behavior)', async () => {
    const srcU = makeMessage('src-u')
    const copy1 = makeMessage('paste-copy-1')
    const sourceSeg = { id: 'seg-src', topicId: 'topic-1', name: 'Src', messageIds: ['src-u'] }
    const action = {
      id: 'undo-legacy-segments',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['paste-copy-1'],
      pastedMessagesSnapshot: [copy1],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-1',
      sourceGroupAnchors: [
        {
          messages: [srcU],
          blocks: [],
          positionIndex: 0,
          anchorMessageId: null,
          loadedMessageIds: ['src-u']
        }
      ],
      sourceSegmentSnapshots: [sourceSeg],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    } as unknown as CutPasteUndoAction
    storeState.messages.entities = { 'paste-copy-1': copy1 } as unknown as Record<string, Message>
    storeState.messages.messageIdsByTopic = { 'topic-1': ['paste-copy-1'] }
    storeState.undoStack = { undoStack: [action], redoStack: [] }

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    expect(mocks.restoreSegmentsAfterUndo).toHaveBeenCalledTimes(1)
    // Omitted (undefined) preserves the legacy live-route path in the helper.
    expect(mocks.restoreSegmentsAfterUndo.mock.calls[0][3]).toBe(undefined)
  })

  it('cut_paste undo re-reads every topic catalog its own commands changed', async () => {
    const srcU = makeMessage('src-u')
    const copy1 = makeMessage('copy-1')
    const action = {
      id: 'undo-catalog-topics',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-tgt',
      insertedMessageIds: ['copy-1'],
      pastedMessagesSnapshot: [copy1],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'topic-src',
      sourceBranchId: null,
      targetBranchId: null,
      sourceRootIds: ['src-u'],
      sourceProjection: { sourceTopicId: 'topic-src', sourceBranchId: null, loadedMessageIds: ['src-u'] },
      sourceGroupAnchors: [
        { messages: [srcU], blocks: [], positionIndex: 0, anchorMessageId: null, loadedMessageIds: ['src-u'] }
      ],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      // The source delete moved a boundary, so the restore reverts it and the
      // source catalog is re-read in the same undo.
      sourceBoundarySnapshots: [
        { kind: 'branch', id: 'branch-src', anchorMessageId: 'src-u', expectedAnchorMessageId: null }
      ],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 0
    } as unknown as CutPasteUndoAction
    storeState.undoStack = { undoStack: [action], redoStack: [] }

    const readTopics: string[] = []
    mocks.fetchTopicBranchesThunk.mockImplementation((topicId: string) => {
      readTopics.push(topicId)
      return { type: 'topicBranch/fetch' }
    })

    const { executeUndo } = await import('../UndoService')
    const result = await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(result).not.toBeNull()
    // Source restore (boundary reverted) then target copy removal (a Main
    // delete that maintains its own boundaries without reporting them): both
    // directly affected topics are re-read, and no other topic is touched.
    expect(readTopics).toEqual(['topic-src', 'topic-tgt'])
  })
})
