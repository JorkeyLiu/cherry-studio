/**
 * clearTopicMessagesThunk — Phase 5.3 blocker fix (LOCK-001).
 *
 * LOCK-001: For both agent and ordinary topics, await primary message
 * clear AND clearTopicSegmentsFromDB BEFORE any Redux message/block/segment
 * mutation.  If segment DB write fails, Redux remains unchanged.
 *
 * LOCK-002: If segment listing/deletion fails, Redux remains unchanged.
 * Preserve already committed backend behaviour; do not invent rollback
 * across SQLite and agent Dexie.
 *
 * LOCK-003: No other changes.
 */

import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    clearMessages: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    clearTopicMessages: vi.fn(),
    clearTopicMessagesAction: vi.fn((p: unknown) => ({ type: 'clearTopicMessages', p })),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'removeManyBlocks', p })),
    clearSegmentsForTopic: vi.fn((p: unknown) => ({ type: 'clearSegmentsForTopic', p })),
    clearTopicSegmentsFromDB: vi.fn()
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

vi.mock('@renderer/utils/agentSession', () => ({
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:'),
  extractAgentSessionIdFromTopicId: (id: string) => id.replace('agent-session:', '')
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    clearMessages: mocks.clearMessages,
    clearTopicWithSegments: vi.fn()
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult,
  restoreOrdinaryTopic: vi.fn(),
  softDeleteOrdinaryTopic: vi.fn()
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: {
    clearTopicMessages: mocks.clearTopicMessages
  }
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  clearTopicSegmentsFromDB: mocks.clearTopicSegmentsFromDB
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    clearTopicMessages: mocks.clearTopicMessagesAction
  }
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: mocks.removeManyBlocks
}))

vi.mock('@renderer/store/topicSegment', () => ({
  clearSegmentsForTopic: mocks.clearSegmentsForTopic
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn()
}))

vi.mock('@renderer/services/anchorService', () => ({
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
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

// --- Helpers --------------------------------------------------------------

const createUserMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'msg-1',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks: ['block-1', 'block-2'],
    ...overrides
  }) as unknown as Message

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

// --- Tests ----------------------------------------------------------------

describe('clearTopicMessagesThunk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: {
        entities: {},
        messageIdsByTopic: {}
      }
    }
  })

  describe('agent topic (LOCK-001): routes through TopicManager.clearTopicMessages', () => {
    it('calls TopicManager.clearTopicMessages instead of clearMessagesFromDB', async () => {
      const agentTopicId = 'agent-session:s-1'
      const agentMsg = createUserMessage({ id: 'agent-msg-1', topicId: agentTopicId })
      storeState.messages.messageIdsByTopic = { [agentTopicId]: ['agent-msg-1'] }
      storeState.messages.entities = { 'agent-msg-1': agentMsg }

      mocks.clearTopicMessages.mockResolvedValue(undefined)

      const { clearTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await clearTopicMessagesThunk(agentTopicId)(dispatch, () => storeState as any)

      // TopicManager.clearTopicMessages called, NOT dbService.clearMessages
      expect(mocks.clearTopicMessages).toHaveBeenCalledTimes(1)
      expect(mocks.clearTopicMessages).toHaveBeenCalledWith(agentTopicId)
      expect(mocks.clearMessages).not.toHaveBeenCalled()
    })

    it('Redux mutations happen AFTER both TopicManager.clearTopicMessages and segment persistence', async () => {
      const agentTopicId = 'agent-session:s-2'
      const agentMsg1 = createUserMessage({ id: 'agent-msg-1', topicId: agentTopicId, blocks: ['block-1'] })
      const agentMsg2 = createUserMessage({ id: 'agent-msg-2', topicId: agentTopicId, blocks: ['block-2', 'block-3'] })
      storeState.messages.messageIdsByTopic = { [agentTopicId]: ['agent-msg-1', 'agent-msg-2'] }
      storeState.messages.entities = { 'agent-msg-1': agentMsg1, 'agent-msg-2': agentMsg2 }

      mocks.clearTopicMessages.mockResolvedValue(undefined)
      mocks.clearTopicSegmentsFromDB.mockResolvedValue(undefined)

      const { clearTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await clearTopicMessagesThunk(agentTopicId)(dispatch, () => storeState as any)

      // Both DB calls happened
      expect(mocks.clearTopicMessages).toHaveBeenCalledTimes(1)
      expect(mocks.clearTopicSegmentsFromDB).toHaveBeenCalledTimes(1)
      expect(mocks.clearTopicSegmentsFromDB).toHaveBeenCalledWith(agentTopicId)

      // All three Redux actions dispatched
      expect(dispatch).toHaveBeenCalledTimes(3)

      // Ordering: message clear DB < segment DB < first dispatch
      expect(mocks.clearTopicMessages.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.clearTopicSegmentsFromDB.mock.invocationCallOrder[0]
      )
      expect(mocks.clearTopicSegmentsFromDB.mock.invocationCallOrder[0]).toBeLessThan(
        dispatch.mock.invocationCallOrder[0]
      )

      // Redux actions dispatched with correct payloads
      expect(mocks.clearTopicMessagesAction).toHaveBeenCalledWith(agentTopicId)
      expect(mocks.removeManyBlocks).toHaveBeenCalledWith(['block-1', 'block-2', 'block-3'])
      expect(mocks.clearSegmentsForTopic).toHaveBeenCalledWith(agentTopicId)
    })

    it('segment DB failure leaves Redux unchanged (LOCK-001/002 segment isolation)', async () => {
      const agentTopicId = 'agent-session:s-seg-fail'
      const agentMsg = createUserMessage({ id: 'agent-msg-1', topicId: agentTopicId, blocks: ['block-1'] })
      storeState.messages.messageIdsByTopic = { [agentTopicId]: ['agent-msg-1'] }
      storeState.messages.entities = { 'agent-msg-1': agentMsg }

      mocks.clearTopicMessages.mockResolvedValue(undefined)
      mocks.clearTopicSegmentsFromDB.mockRejectedValue(new Error('Segment list failed'))

      const { clearTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await clearTopicMessagesThunk(agentTopicId)(dispatch, () => storeState as any)

      // Message clear completed, segment clear was attempted
      expect(mocks.clearTopicMessages).toHaveBeenCalledTimes(1)
      expect(mocks.clearTopicSegmentsFromDB).toHaveBeenCalledTimes(1)

      // Redux should NOT be mutated when segment persistence fails
      expect(dispatch).not.toHaveBeenCalled()
      expect(mocks.clearTopicMessagesAction).not.toHaveBeenCalled()
      expect(mocks.removeManyBlocks).not.toHaveBeenCalled()
      expect(mocks.clearSegmentsForTopic).not.toHaveBeenCalled()
    })

    it('DB failure leaves Redux unchanged (LOCK-001 failure isolation)', async () => {
      const agentTopicId = 'agent-session:s-fail'
      const agentMsg = createUserMessage({ id: 'agent-msg-1', topicId: agentTopicId })
      storeState.messages.messageIdsByTopic = { [agentTopicId]: ['agent-msg-1'] }
      storeState.messages.entities = { 'agent-msg-1': agentMsg }

      mocks.clearTopicMessages.mockRejectedValue(new Error('Dexie transaction failed'))

      const { clearTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await clearTopicMessagesThunk(agentTopicId)(dispatch, () => storeState as any)

      // Redux should NOT be mutated on failure
      expect(dispatch).not.toHaveBeenCalled()
      expect(mocks.clearTopicMessages).toHaveBeenCalledTimes(1)
    })
  })

  describe('ordinary topic (LOCK-002): keeps SQLite clearMessagesFromDB path', () => {
    it('calls dbService.clearMessages for ordinary topics', async () => {
      const ordinaryTopicId = 'topic-ordinary'
      const msg = createUserMessage({ id: 'msg-1', topicId: ordinaryTopicId })
      storeState.messages.messageIdsByTopic = { [ordinaryTopicId]: ['msg-1'] }
      storeState.messages.entities = { 'msg-1': msg }

      mocks.clearMessages.mockResolvedValue(emptyCleanup)

      const { clearTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await clearTopicMessagesThunk(ordinaryTopicId)(dispatch, () => storeState as any)

      // Ordinary path uses dbService.clearMessages, NOT TopicManager
      expect(mocks.clearMessages).toHaveBeenCalledTimes(1)
      expect(mocks.clearMessages).toHaveBeenCalledWith(ordinaryTopicId)
      expect(mocks.clearTopicMessages).not.toHaveBeenCalled()
    })

    it('Redux mutations happen after both SQLite commit and segment persistence', async () => {
      const ordinaryTopicId = 'topic-ordinary-2'
      const msg = createUserMessage({ id: 'msg-1', topicId: ordinaryTopicId, blocks: ['block-1'] })
      storeState.messages.messageIdsByTopic = { [ordinaryTopicId]: ['msg-1'] }
      storeState.messages.entities = { 'msg-1': msg }

      mocks.clearMessages.mockResolvedValue(emptyCleanup)
      mocks.clearTopicSegmentsFromDB.mockResolvedValue(undefined)

      const { clearTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await clearTopicMessagesThunk(ordinaryTopicId)(dispatch, () => storeState as any)

      // Both DB calls happened
      expect(mocks.clearMessages).toHaveBeenCalledTimes(1)
      expect(mocks.clearTopicSegmentsFromDB).toHaveBeenCalledTimes(1)
      expect(mocks.clearTopicSegmentsFromDB).toHaveBeenCalledWith(ordinaryTopicId)

      // All three Redux actions dispatched
      expect(dispatch).toHaveBeenCalledTimes(3)

      // Ordering: message clear DB < segment DB < first dispatch
      expect(mocks.clearMessages.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.clearTopicSegmentsFromDB.mock.invocationCallOrder[0]
      )
      expect(mocks.clearTopicSegmentsFromDB.mock.invocationCallOrder[0]).toBeLessThan(
        dispatch.mock.invocationCallOrder[0]
      )

      // Redux actions dispatched with correct payloads
      expect(mocks.clearTopicMessagesAction).toHaveBeenCalledWith(ordinaryTopicId)
      expect(mocks.removeManyBlocks).toHaveBeenCalledWith(['block-1'])
      expect(mocks.clearSegmentsForTopic).toHaveBeenCalledWith(ordinaryTopicId)
    })

    it('segment DB failure leaves Redux unchanged (LOCK-002 segment isolation)', async () => {
      const ordinaryTopicId = 'topic-seg-fail'
      const msg = createUserMessage({ id: 'msg-1', topicId: ordinaryTopicId, blocks: ['block-1'] })
      storeState.messages.messageIdsByTopic = { [ordinaryTopicId]: ['msg-1'] }
      storeState.messages.entities = { 'msg-1': msg }

      mocks.clearMessages.mockResolvedValue(emptyCleanup)
      mocks.clearTopicSegmentsFromDB.mockRejectedValue(new Error('Segment delete failed'))

      const { clearTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await clearTopicMessagesThunk(ordinaryTopicId)(dispatch, () => storeState as any)

      // Message clear completed, segment clear was attempted
      expect(mocks.clearMessages).toHaveBeenCalledTimes(1)
      expect(mocks.clearTopicSegmentsFromDB).toHaveBeenCalledTimes(1)

      // Redux should NOT be mutated when segment persistence fails
      expect(dispatch).not.toHaveBeenCalled()
      expect(mocks.clearTopicMessagesAction).not.toHaveBeenCalled()
      expect(mocks.removeManyBlocks).not.toHaveBeenCalled()
      expect(mocks.clearSegmentsForTopic).not.toHaveBeenCalled()
    })

    it('DB failure leaves Redux unchanged', async () => {
      const ordinaryTopicId = 'topic-fail'
      const msg = createUserMessage({ id: 'msg-1', topicId: ordinaryTopicId })
      storeState.messages.messageIdsByTopic = { [ordinaryTopicId]: ['msg-1'] }
      storeState.messages.entities = { 'msg-1': msg }

      mocks.clearMessages.mockRejectedValue(new Error('SQLite failure'))

      const { clearTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()

      await clearTopicMessagesThunk(ordinaryTopicId)(dispatch, () => storeState as any)

      // Redux should NOT be mutated on failure
      expect(dispatch).not.toHaveBeenCalled()
      expect(mocks.clearMessages).toHaveBeenCalledTimes(1)
    })
  })
})
