/**
 * ClipboardService.deleteSingleMessage — Phase 5.3 live caller tests.
 *
 * LOCK-001: deletion commits DB first via deleteMessagesFromDB
 * (which uses deleteMessagesWithSegments returning FileCleanupResult),
 * consumes cleanup exactly once post-commit, then mutates Redux/files.
 * DB failure leaves Redux/files unchanged.
 */

import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesFromDB: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    selectMessagesForTopic: vi.fn(),
    buildGroupList: vi.fn(() => []),
    transferAnchorsAfterDeletion: vi.fn(),
    syncSegmentsAfterMessageDeletion: vi.fn().mockResolvedValue(undefined),
    collectSegmentSnapshots: vi.fn(() => []),
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
  selectMessagesForTopic: mocks.selectMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: mocks.removeManyBlocks,
  upsertManyBlocks: vi.fn()
}))

vi.mock('@renderer/store/undoStack', () => ({
  pushUndoAction: mocks.pushUndoAction
}))

vi.mock('@renderer/services/anchorService', () => ({
  buildGroupList: mocks.buildGroupList,
  transferAnchorsAfterDeletion: mocks.transferAnchorsAfterDeletion
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  collectSegmentSnapshots: mocks.collectSegmentSnapshots,
  collectWholeSelectedSegmentsForClipboard: vi.fn(() => []),
  syncSegmentsAfterMessageDeletion: mocks.syncSegmentsAfterMessageDeletion
}))

vi.mock('@renderer/store/topicSegment', () => ({
  addSegment: vi.fn()
}))

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

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

const createFileBlock = (overrides: Partial<MessageBlock> = {}): MessageBlock =>
  ({
    id: 'block-1',
    messageId: 'msg-1',
    type: MessageBlockType.FILE,
    content: '',
    file: { id: 'file-1', name: 'test.pdf' },
    ...overrides
  }) as unknown as MessageBlock

const createTextBlock = (overrides: Partial<MessageBlock> = {}): MessageBlock =>
  ({
    id: 'block-2',
    messageId: 'msg-1',
    type: MessageBlockType.MAIN_TEXT,
    content: 'hello',
    ...overrides
  }) as unknown as MessageBlock

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

describe('ClipboardService.deleteSingleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} }
    }
  })

  it('DB commits first, consumes cleanup once, then Redux (LOCK-001)', async () => {
    const userMsg = createUserMessage()
    const block = createTextBlock()
    storeState.messages.entities = { 'msg-1': userMsg }
    storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }
    storeState.messageBlocks.entities = { 'block-1': block }

    mocks.selectMessagesForTopic.mockReturnValue([userMsg])
    mocks.deleteMessagesFromDB.mockResolvedValue(emptyCleanup)

    const ordering = { db: 0, cleanup: 0, redux: 0, counter: 0 }
    mocks.deleteMessagesFromDB.mockImplementation(async () => {
      ordering.db = ++ordering.counter
      return emptyCleanup
    })
    mocks.consumeFileCleanupResult.mockImplementation(async () => {
      ordering.cleanup = ++ordering.counter
    })
    mocks.removeMessages.mockImplementation((p: unknown) => {
      ordering.redux = ++ordering.counter
      return { type: 'removeMessages', p }
    })

    const { deleteSingleMessage } = await import('../ClipboardService')
    const dispatch = vi.fn((action: unknown) => {
      if ((action as any)?.type === 'removeMessages') ordering.redux = ++ordering.counter
      return action
    }) as any

    await deleteSingleMessage(dispatch, () => storeState as any, 'topic-1', userMsg)

    // DB before cleanup, cleanup before Redux
    expect(ordering.db).toBeLessThan(ordering.cleanup)
    expect(ordering.cleanup).toBeLessThan(ordering.redux)
    // consumeFileCleanupResult called exactly once
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(emptyCleanup)
  })

  it('DB failure leaves Redux/files unchanged', async () => {
    const userMsg = createUserMessage()
    const fileBlock = createFileBlock()
    storeState.messages.entities = { 'msg-1': userMsg }
    storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }
    storeState.messageBlocks.entities = { 'block-1': fileBlock }

    mocks.selectMessagesForTopic.mockReturnValue([userMsg])
    mocks.deleteMessagesFromDB.mockRejectedValue(new Error('SQLITE_FAILURE'))

    const { deleteSingleMessage } = await import('../ClipboardService')
    const dispatch = vi.fn()

    await deleteSingleMessage(dispatch, () => storeState as any, 'topic-1', userMsg)

    // Redux not mutated
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'removeMessages' }))
    // Cleanup not consumed
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
  })

  it('does NOT call dbService.updateFileCount after consumeFileCleanupResult (LOCK-P5.3-1)', async () => {
    // When a message with file/image blocks is deleted, consumeFileCleanupResult
    // already handles physical file cleanup via FileManager.deleteFile. A second
    // dbService.updateFileCount would double-decrement the Dexie files.count.
    const userMsg = createUserMessage({ blocks: ['block-file'] })
    const fileBlock = createFileBlock({ id: 'block-file', messageId: 'msg-1' })
    storeState.messages.entities = { 'msg-1': userMsg }
    storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }
    storeState.messageBlocks.entities = { 'block-file': fileBlock }

    mocks.selectMessagesForTopic.mockReturnValue([userMsg])
    const cleanupWithFile = {
      affectedFileIds: ['file-1'],
      remainingReferenceCounts: { 'file-1': 0 } as Record<string, number>
    }
    mocks.deleteMessagesFromDB.mockResolvedValue(cleanupWithFile)

    const { deleteSingleMessage } = await import('../ClipboardService')
    const dispatch = vi.fn()

    await deleteSingleMessage(dispatch, () => storeState as any, 'topic-1', userMsg)

    // consumeFileCleanupResult called with the cleanup result
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(cleanupWithFile)
    // CRITICAL: dbService.updateFileCount must NOT be called — the file cleanup
    // is already handled by consumeFileCleanupResult → FileManager.deleteFile.
    expect(mocks.updateFileCount).not.toHaveBeenCalled()
  })
})
