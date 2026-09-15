import type { AppDispatch, RootState } from '@renderer/store'
import type { CutPasteUndoAction, DeleteUndoAction, PasteUndoAction } from '@renderer/types/editMode'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertMessageGroups: vi.fn(),
    deleteMessagesFromDB: vi.fn(),
    deleteMessagesWithDependents: vi.fn(),
    saveMessageAndBlocksToDB: vi.fn(),
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
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
}))

vi.mock('@renderer/store/topicSegment', () => ({
  replaceSegmentsForTopic: mocks.replaceSegmentsForTopic
}))

let storeState: RootState

vi.mock('@renderer/store', () => ({
  default: { dispatch: vi.fn(), getState: () => storeState }
}))

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

describe('UndoService stable restore (insert-message-groups)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      undoStack: { undoStack: [], redoStack: [] },
      messages: { entities: {}, messageIdsByTopic: { 'topic-1': ['survivor'] } },
      messageBlocks: { entities: {} }
    } as unknown as RootState
    mocks.insertMessageGroups.mockResolvedValue(emptyCleanup)
    mocks.selectLoadedMessagesForTopic.mockImplementation((() => [{ id: 'survivor' } as Message]) as any)
  })

  it('undoDelete sends ONE atomic stable call with before/tail intents and no per-message saves', async () => {
    const g1Msg = makeMessage('g1m')
    const g2Msg = makeMessage('g2m')
    const action: DeleteUndoAction = {
      id: 'undo-del-1',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      rootMessageIds: ['g1m'],
      insertedMessageIds: ['g1m', 'g2m'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [
        {
          messages: [g1Msg],
          blocks: [],
          positionIndex: 5,
          anchorMessageId: 'survivor',
          loadedMessageIds: ['g1m']
        },
        {
          messages: [g2Msg],
          blocks: [],
          positionIndex: 9,
          anchorMessageId: null,
          loadedMessageIds: ['g2m']
        }
      ],
      segmentSnapshots: []
    }
    storeState.undoStack = { undoStack: [action], redoStack: [] }
    const { executeUndo } = await import('../UndoService')
    await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith('topic-1', [
      {
        entries: [{ message: g1Msg, blocks: [] }],
        intent: { kind: 'before-message', messageId: 'survivor' }
      },
      {
        entries: [{ message: g2Msg, blocks: [] }],
        intent: { kind: 'topic-tail' }
      }
    ])
    expect(mocks.saveMessageAndBlocksToDB).not.toHaveBeenCalled()
    // Bounded projection: both visible groups inserted (tail appends, anchor inserts).
    expect(mocks.newMessagesActions.insertMessageAtIndex).toHaveBeenCalledTimes(2)
  })

  it('undoDelete restores FULL group to DB but projects only the loaded intersection to Redux', async () => {
    const m1 = makeMessage('m1')
    const m2 = makeMessage('m2')
    const m3 = makeMessage('m3')
    const b1 = { id: 'b1', messageId: 'm1' } as unknown as MessageBlock
    const b2 = { id: 'b2', messageId: 'm2' } as unknown as MessageBlock
    const b3 = { id: 'b3', messageId: 'm3' } as unknown as MessageBlock
    const action: DeleteUndoAction = {
      id: 'undo-del-partial',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      rootMessageIds: ['m1'],
      insertedMessageIds: ['m1', 'm2', 'm3'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [
        {
          messages: [m1, m2, m3],
          blocks: [b1, b2, b3],
          positionIndex: 0,
          anchorMessageId: 'survivor',
          // m2 was outside the loaded projection before delete.
          loadedMessageIds: ['m1', 'm3']
        }
      ],
      segmentSnapshots: []
    }
    storeState.undoStack = { undoStack: [action], redoStack: [] }
    const { executeUndo } = await import('../UndoService')
    await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    // DB keeps full authority: all three entries in one atomic call.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    const [, groups] = mocks.insertMessageGroups.mock.calls[0] as unknown as [
      string,
      Array<{ entries: Array<{ message: Message }> }>
    ]
    expect(groups).toHaveLength(1)
    expect(groups[0].entries.map((e) => e.message.id)).toEqual(['m1', 'm2', 'm3'])
    // Redux projects only the loaded subset, preserving authority order.
    expect(mocks.newMessagesActions.insertMessageAtIndex).toHaveBeenCalledTimes(2)
    expect(mocks.newMessagesActions.insertMessageAtIndex).toHaveBeenNthCalledWith(1, {
      topicId: 'topic-1',
      message: m1,
      index: 0
    })
    expect(mocks.newMessagesActions.insertMessageAtIndex).toHaveBeenNthCalledWith(2, {
      topicId: 'topic-1',
      message: m3,
      index: 1
    })
    expect(mocks.upsertManyBlocks).toHaveBeenCalledTimes(1)
    expect(mocks.upsertManyBlocks).toHaveBeenCalledWith([b1, b3])
  })

  it('undoDelete with topic-tail empty intersection still restores DB but injects nothing to Redux', async () => {
    const tailMsg = makeMessage('tail-m')
    const tailBlock = { id: 'tail-b', messageId: 'tail-m' } as unknown as MessageBlock
    const action: DeleteUndoAction = {
      id: 'undo-del-tail-empty',
      type: 'delete',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      rootMessageIds: ['tail-m'],
      insertedMessageIds: ['tail-m'],
      pastedMessagesSnapshot: [],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      groupAnchors: [
        {
          messages: [tailMsg],
          blocks: [tailBlock],
          positionIndex: 9,
          anchorMessageId: null,
          loadedMessageIds: []
        }
      ],
      segmentSnapshots: []
    }
    storeState.undoStack = { undoStack: [action], redoStack: [] }
    const { executeUndo } = await import('../UndoService')
    await executeUndo(vi.fn() as unknown as AppDispatch, () => storeState)

    // DB still gets the full authority restore even though Redux gets nothing.
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    const [, groups] = mocks.insertMessageGroups.mock.calls[0] as unknown as [
      string,
      Array<{ entries: Array<{ message: Message }> }>
    ]
    expect(groups[0].entries.map((e) => e.message.id)).toEqual(['tail-m'])
    expect(mocks.newMessagesActions.insertMessageAtIndex).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
  })

  it('redoPaste uses the stored stable intent (never a numeric index)', async () => {
    const msg = makeMessage('pasted-1')
    const block = { id: 'b-1', messageId: 'pasted-1' } as unknown as MessageBlock
    const action: PasteUndoAction = {
      id: 'redo-paste-1',
      type: 'paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['pasted-1'],
      pastedMessagesSnapshot: [msg],
      pastedBlocksSnapshot: [block],
      fileReferenceDeltas: [],
      targetAnchorMessageId: 'after-anchor',
      targetInsertPositionIndex: 99,
      targetInsertIntent: { kind: 'after-group-tail', messageId: 'orig-target' },
      targetSegmentSnapshots: []
    }
    storeState.undoStack = { undoStack: [], redoStack: [action] }
    mocks.selectLoadedMessagesForTopic.mockImplementation((() => [{ id: 'orig-target' } as Message]) as any)
    const { executeRedo } = await import('../UndoService')
    await executeRedo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    const [, groups] = mocks.insertMessageGroups.mock.calls[0] as unknown as [string, Array<{ intent: unknown }>]
    expect(groups[0].intent).toEqual({ kind: 'after-group-tail', messageId: 'orig-target' })
    expect(mocks.saveMessageAndBlocksToDB).not.toHaveBeenCalled()
  })

  it('redoPaste non-contiguous same-answer group projects after the last loaded assistant (Main parity)', async () => {
    const user = { ...makeMessage('u0'), role: 'user', askId: undefined } as unknown as Message
    const a1 = { ...makeMessage('a1'), role: 'assistant', askId: 'u0' } as unknown as Message
    const mid = { ...makeMessage('mid'), role: 'user', askId: undefined } as unknown as Message
    const a2 = { ...makeMessage('a2'), role: 'assistant', askId: 'u0' } as unknown as Message
    const loaded = [user, a1, mid, a2]
    const pasted = makeMessage('pasted-1')
    const action: PasteUndoAction = {
      id: 'redo-paste-noncontig',
      type: 'paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['pasted-1'],
      pastedMessagesSnapshot: [pasted],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      targetAnchorMessageId: null,
      targetInsertPositionIndex: 99,
      targetInsertIntent: { kind: 'after-group-tail', messageId: 'u0' },
      targetSegmentSnapshots: []
    }
    storeState.undoStack = { undoStack: [], redoStack: [action] }
    mocks.selectLoadedMessagesForTopic.mockImplementation((() => loaded) as any)
    const { executeRedo } = await import('../UndoService')
    await executeRedo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    const [, groups] = mocks.insertMessageGroups.mock.calls[0] as unknown as [string, Array<{ intent: unknown }>]
    expect(groups[0].intent).toEqual({ kind: 'after-group-tail', messageId: 'u0' })
    // Bounded local projection matches Main intent: insert at loaded index 4 (after a2).
    expect(mocks.newMessagesActions.insertMessageAtIndex).toHaveBeenCalledTimes(1)
    expect(mocks.newMessagesActions.insertMessageAtIndex).toHaveBeenCalledWith({
      topicId: 'topic-1',
      message: pasted,
      index: 4
    })
  })

  it('redoCutPaste uses the stored stable intent for the target re-insert', async () => {
    const msg = makeMessage('pasted-1')
    const action: CutPasteUndoAction = {
      id: 'redo-cut-1',
      type: 'cut_paste',
      timestamp: Date.now(),
      targetTopicId: 'topic-1',
      insertedMessageIds: ['pasted-1'],
      pastedMessagesSnapshot: [msg],
      pastedBlocksSnapshot: [],
      fileReferenceDeltas: [],
      sourceTopicId: 'source-1',
      sourceGroupAnchors: [],
      sourceSegmentSnapshots: [],
      targetSegmentSnapshots: [],
      targetAnchorMessageId: 'after-anchor',
      targetInsertPositionIndex: 77,
      targetInsertIntent: { kind: 'topic-tail' }
    }
    storeState.undoStack = { undoStack: [], redoStack: [action] }
    mocks.selectLoadedMessagesForTopic.mockImplementation((() => [] as Message[]) as any)
    const { executeRedo } = await import('../UndoService')
    await executeRedo(vi.fn() as unknown as AppDispatch, () => storeState)

    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    const [, groups] = mocks.insertMessageGroups.mock.calls[0] as unknown as [string, Array<{ intent: unknown }>]
    expect(groups[0].intent).toEqual({ kind: 'topic-tail' })
    expect(mocks.saveMessageAndBlocksToDB).not.toHaveBeenCalled()
  })
})
