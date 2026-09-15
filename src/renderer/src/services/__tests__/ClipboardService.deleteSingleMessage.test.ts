/**
 * ClipboardService.deleteSingleMessage / deleteSelectedMessages — unified
 * semantic delete tests.
 *
 * Both paths call the unified `executeDeleteMessagesWithDependents` helper
 * with stable root IDs only (single ID / selected group IDs — never a
 * loaded-projection expansion), converge projection inside the helper, and
 * push a `DeleteUndoAction` built from the authority snapshot
 * (`rootMessageIds` + expanded `insertedMessageIds` + authority
 * groupAnchors/segmentSnapshots/file deltas).
 * DB failure leaves Redux untouched and pushes no undo.
 */

import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    executeDeleteMessagesWithDependents: vi.fn(),
    deleteMessagesFromDB: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    selectLoadedMessagesForTopic: vi.fn(),
    removeMessages: vi.fn((p: unknown) => ({ type: 'removeMessages', p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'removeManyBlocks', p })),
    pushUndoAction: vi.fn((p: unknown) => ({ type: 'pushUndoAction', p })),
    updateFileCount: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  deleteMessagesFromDB: mocks.deleteMessagesFromDB,
  executeDeleteMessagesWithDependents: mocks.executeDeleteMessagesWithDependents,
  saveMessageAndBlocksToDB: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    updateFileCount: mocks.updateFileCount
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/clipboard', () => ({
  clearClipboard: () => ({ type: 'clearClipboard' }),
  setClipboard: () => ({ type: 'setClipboard' })
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: { removeMessages: mocks.removeMessages },
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: mocks.removeManyBlocks,
  upsertManyBlocks: vi.fn()
}))

vi.mock('@renderer/store/undoStack', () => ({
  pushUndoAction: mocks.pushUndoAction
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  collectSegmentSnapshots: vi.fn(() => []),
  collectWholeSelectedSegmentsForClipboard: vi.fn(() => []),
  syncSegmentsAfterMessageDeletion: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@renderer/store/topicSegment', () => ({
  addSegment: vi.fn()
}))

// ── Helpers ────────────────────────────────────────────────────────────────

const createUserMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'msg-1',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: ['block-1'],
    askId: undefined,
    ...overrides
  }) as unknown as Message

const createTextBlock = (overrides: Partial<MessageBlock> = {}): MessageBlock =>
  ({
    id: 'block-1',
    messageId: 'msg-1',
    type: MessageBlockType.MAIN_TEXT,
    content: 'hello',
    ...overrides
  }) as unknown as MessageBlock

const semanticResult = (overrides: Record<string, unknown> = {}) => ({
  response: {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    deletedMessageIds: ['msg-1'],
    deletedBlockIds: ['block-1'],
    previousUserMessageIds: ['msg-1'],
    remainingUserMessageIds: [] as string[],
    segments: [],
    restoreGroups: [
      { entries: [{ message: { id: 'msg-1' }, blocks: [{ id: 'block-1' }] }], positionIndex: 0, anchorMessageId: null }
    ],
    segmentSnapshots: [],
    ...overrides
  },
  undoParts: {
    groupAnchors: [
      {
        messages: [{ id: 'msg-1' }],
        blocks: [{ id: 'block-1', messageId: 'msg-1' }],
        positionIndex: 0,
        anchorMessageId: null,
        loadedMessageIds: ['msg-1']
      }
    ],
    segmentSnapshots: [],
    fileReferenceDeltas: []
  }
})

// ── Store mock ─────────────────────────────────────────────────────────────

interface StoreState {
  messages: {
    entities: Record<string, Message>
    messageIdsByTopic: Record<string, string[]>
  }
  messageBlocks: {
    entities: Record<string, MessageBlock>
  }
}

let storeState: StoreState

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  },
  useAppDispatch: () => vi.fn()
}))

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ClipboardService.deleteSingleMessage (semantic)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} }
    }
  })

  it('calls the unified helper with the single stable root and pushes authority undo', async () => {
    const userMsg = createUserMessage()
    const block = createTextBlock()
    storeState.messages.entities = { 'msg-1': userMsg }
    storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }
    storeState.messageBlocks.entities = { 'block-1': block }
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue(semanticResult())

    const { deleteSingleMessage } = await import('../ClipboardService')
    const dispatch = vi.fn() as any

    await deleteSingleMessage(dispatch, () => storeState as any, 'topic-1', userMsg)

    // Stable root only — no loaded cascade derivation.
    expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(
      dispatch,
      expect.any(Function),
      'topic-1',
      ['msg-1']
    )
    expect(mocks.selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    // Undo carries original roots + expanded IDs + authority snapshots.
    expect(mocks.pushUndoAction).toHaveBeenCalledTimes(1)
    const undoAction = mocks.pushUndoAction.mock.calls[0][0] as any
    expect(undoAction.type).toBe('delete')
    expect(undoAction.targetTopicId).toBe('topic-1')
    expect(undoAction.rootMessageIds).toEqual(['msg-1'])
    expect(undoAction.insertedMessageIds).toEqual(['msg-1'])
    expect(undoAction.groupAnchors).toHaveLength(1)
    // Bounded projection: the thunk-supplied loaded intersection travels into the undo action.
    expect(undoAction.groupAnchors[0].loadedMessageIds).toEqual(['msg-1'])
  })

  it('DB failure pushes no undo and leaves Redux untouched', async () => {
    const userMsg = createUserMessage()
    storeState.messages.entities = { 'msg-1': userMsg }
    storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }
    mocks.executeDeleteMessagesWithDependents.mockRejectedValue(new Error('SQLITE_FAILURE'))

    const { deleteSingleMessage } = await import('../ClipboardService')
    const dispatch = vi.fn() as any

    await deleteSingleMessage(dispatch, () => storeState as any, 'topic-1', userMsg)

    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'removeMessages' }))
  })

  it('missing entity is a no-op without touching the helper', async () => {
    const { deleteSingleMessage } = await import('../ClipboardService')
    const dispatch = vi.fn() as any

    await deleteSingleMessage(dispatch, () => storeState as any, 'topic-1', createUserMessage())

    expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })
})

describe('ClipboardService.deleteSelectedMessages (semantic multi)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} }
    }
  })

  it('passes selected group IDs as stable roots (never loaded-expanded IDs)', async () => {
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue(
      semanticResult({ deletedMessageIds: ['u1', 'a1', 'u2'] })
    )

    const { deleteSelectedMessages } = await import('../ClipboardService')
    const dispatch = vi.fn() as any

    const count = await deleteSelectedMessages(dispatch, () => storeState as any, 'topic-1', ['u1', 'u2'])

    expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledExactlyOnceWith(
      dispatch,
      expect.any(Function),
      'topic-1',
      ['u1', 'u2']
    )
    expect(mocks.selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(count).toBe(3)
    const undoAction = mocks.pushUndoAction.mock.calls[0][0] as any
    expect(undoAction.rootMessageIds).toEqual(['u1', 'u2'])
    expect(undoAction.insertedMessageIds).toEqual(['u1', 'a1', 'u2'])
    expect(undoAction.groupAnchors[0].loadedMessageIds).toEqual(['msg-1'])
  })

  it('empty selection is a no-op without touching the helper', async () => {
    const { deleteSelectedMessages } = await import('../ClipboardService')
    const dispatch = vi.fn() as any

    const count = await deleteSelectedMessages(dispatch, () => storeState as any, 'topic-1', [])

    expect(count).toBe(0)
    expect(mocks.executeDeleteMessagesWithDependents).not.toHaveBeenCalled()
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })

  it('DB failure returns 0 with no undo', async () => {
    mocks.executeDeleteMessagesWithDependents.mockRejectedValue(new Error('SQLITE_FAILURE'))

    const { deleteSelectedMessages } = await import('../ClipboardService')
    const dispatch = vi.fn() as any

    const count = await deleteSelectedMessages(dispatch, () => storeState as any, 'topic-1', ['u1'])

    expect(count).toBe(0)
    expect(mocks.pushUndoAction).not.toHaveBeenCalled()
  })

  it('menu/hook path ends at the semantic command (deleteMessageWithUndo)', async () => {
    // The menu path (useMessageOperations.deleteMessageWithUndo) delegates to
    // ClipboardService.deleteSingleMessage, which must end at the unified
    // semantic helper — assert the delegation chain, not the dialog.
    mocks.executeDeleteMessagesWithDependents.mockResolvedValue(semanticResult())
    const userMsg = createUserMessage()
    storeState.messages.entities = { 'msg-1': userMsg }

    const { deleteSingleMessage } = await import('../ClipboardService')
    const dispatch = vi.fn() as any
    await deleteSingleMessage(dispatch, () => storeState as any, 'topic-1', userMsg)

    expect(mocks.executeDeleteMessagesWithDependents).toHaveBeenCalledTimes(1)
    expect(mocks.pushUndoAction).toHaveBeenCalledTimes(1)
  })
})
