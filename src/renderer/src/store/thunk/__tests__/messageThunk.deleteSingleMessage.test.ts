/**
 * deleteSingleMessageThunk — Phase 5.3 blocker fixes.
 *
 * LOCK-001: single deletion commits DB first, consumes FileCleanupResult
 * exactly once, then mutates Redux. Failures leave Redux/files unchanged.
 */

import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesWithSegments: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    removeMessages: vi.fn((p: unknown) => ({ type: 'removeMessages', p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'removeManyBlocks', p })),
    transferAnchorsAfterDeletion: vi.fn(),
    buildGroupList: vi.fn(() => []),
    selectMessagesForTopic: vi.fn(),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', p }))
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

vi.mock('@renderer/services/db', () => ({
  dbService: {
    deleteMessagesWithSegments: mocks.deleteMessagesWithSegments,
    resetMessagesForResend: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    updateMessage: vi.fn(),
    fetchMessages: vi.fn(),
    listBlocksByFile: vi.fn(),
    deleteBlocks: vi.fn()
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult,
  restoreOrdinaryTopic: vi.fn(),
  softDeleteOrdinaryTopic: vi.fn()
}))

vi.mock('@renderer/services/anchorService', () => ({
  buildGroupList: mocks.buildGroupList,
  transferAnchorsAfterDeletion: mocks.transferAnchorsAfterDeletion
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: vi.fn()
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: vi.fn() }),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  addAbortController: vi.fn()
}))

vi.mock('swr', () => ({
  mutate: vi.fn()
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (k: string) => k
  },
  t: (k: string) => k
}))

// --- Helpers --------------------------------------------------------------

const createMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'msg-1',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: UserMessageStatus.SUCCESS,
    blocks: ['block-1', 'block-2'],
    askId: undefined,
    ...overrides
  }) as unknown as Message

const createAssistantMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'asst-1',
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    blocks: ['block-3'],
    askId: 'msg-1',
    ...overrides
  }) as unknown as Message

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

// --- Store mock setup ----------------------------------------------------

interface StoreState {
  messages: {
    entities: Record<string, Message>
    messageIdsByTopic: Record<string, string[]>
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

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    removeMessages: mocks.removeMessages
  },
  selectMessagesForTopic: mocks.selectMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: mocks.removeManyBlocks,
  updateOneBlock: vi.fn(),
  upsertManyBlocks: vi.fn(),
  upsertOneBlock: vi.fn()
}))

// --- Tests ----------------------------------------------------------------

describe('deleteSingleMessageThunk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: {
        entities: {},
        messageIdsByTopic: {}
      }
    }
  })

  describe('ordinary topic (LOCK-001): DB commit first, consume cleanup once, then Redux', () => {
    it('commits to DB before Redux, consumes FileCleanupResult exactly once', { timeout: 60_000 }, async () => {
      const userMsg = createMessage()
      const asstMsg = createAssistantMessage()

      storeState.messages.entities = {
        'msg-1': userMsg,
        'asst-1': asstMsg
      }
      storeState.messages.messageIdsByTopic = {
        'topic-1': ['msg-1', 'asst-1']
      }
      mocks.selectMessagesForTopic.mockReturnValue([userMsg, asstMsg])
      mocks.buildGroupList.mockReturnValue([])
      mocks.deleteMessagesWithSegments.mockResolvedValue(emptyCleanup)

      const { deleteSingleMessageThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await deleteSingleMessageThunk('topic-1', 'msg-1')(dispatch, () => storeState as any)

      // DB commit FIRST
      expect(mocks.deleteMessagesWithSegments).toHaveBeenCalledExactlyOnceWith('topic-1', ['msg-1', 'asst-1'])
      // consumeFileCleanupResult called exactly once
      expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(emptyCleanup)
    })

    it('Redux mutations happen AFTER successful DB commit', { timeout: 60_000 }, async () => {
      const userMsg = createMessage()
      storeState.messages.entities = { 'msg-1': userMsg }
      storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }
      mocks.selectMessagesForTopic.mockReturnValue([userMsg])
      mocks.buildGroupList.mockReturnValue([])

      const dbCalled = vi.fn()
      const cleanupCalled = vi.fn()
      const reduxCalled = vi.fn()
      mocks.deleteMessagesWithSegments.mockImplementation(async () => {
        dbCalled()
        return emptyCleanup
      })
      mocks.consumeFileCleanupResult.mockImplementation(async () => {
        cleanupCalled()
      })

      const { deleteSingleMessageThunk } = await import('../messageThunk')
      const dispatch = vi.fn().mockImplementation(() => {
        reduxCalled()
      })

      await deleteSingleMessageThunk('topic-1', 'msg-1')(dispatch, () => storeState as any)

      // Verify ordering: db called before cleanup, cleanup called before any redux
      expect(dbCalled).toHaveBeenCalled()
      expect(cleanupCalled).toHaveBeenCalled()
      expect(reduxCalled).toHaveBeenCalled()
      // DB is synchronous mock, cleanup is awaited, redux happens after
      expect(dbCalled.mock.invocationCallOrder[0]).toBeLessThan(cleanupCalled.mock.invocationCallOrder[0])
      expect(cleanupCalled.mock.invocationCallOrder[0]).toBeLessThan(reduxCalled.mock.invocationCallOrder[0])
    })

    it('DB failure leaves Redux unchanged', { timeout: 60_000 }, async () => {
      const userMsg = createMessage()
      storeState.messages.entities = { 'msg-1': userMsg }
      storeState.messages.messageIdsByTopic = { 'topic-1': ['msg-1'] }
      mocks.selectMessagesForTopic.mockReturnValue([userMsg])
      mocks.buildGroupList.mockReturnValue([])
      mocks.deleteMessagesWithSegments.mockRejectedValue(new Error('SQLITE_FAILURE'))

      const { deleteSingleMessageThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await deleteSingleMessageThunk('topic-1', 'msg-1')(dispatch, () => storeState as any)

      // Redux should NOT be mutated on failure
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'removeMessages' }))
      expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    })
  })
})
