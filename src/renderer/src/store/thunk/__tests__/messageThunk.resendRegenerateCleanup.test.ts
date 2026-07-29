/**
 * resendMessageThunk / regenerateAssistantResponseThunk — Phase 5.3 blocker fixes.
 *
 * LOCK-001: ordinary resend/regenerate must NOT call cleanupMultipleBlocks.
 * File cleanup is handled exclusively by consumeFileCleanupResult. Redux block
 * removal uses cancelThrottledBlockUpdate + removeManyBlocks directly.
 */

import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resetMessagesForResend: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    cleanupMultipleBlocks: vi.fn(),
    removeManyBlocks: vi.fn((p: unknown) => ({ type: 'removeManyBlocks', p })),
    selectMessagesForTopic: vi.fn(),
    dispatch: vi.fn()
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
    resetMessagesForResend: mocks.resetMessagesForResend
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/thunk/messageThunk', async () => {
  const actual = await vi.importActual('../messageThunk')
  return {
    ...actual,
    cleanupMultipleBlocks: mocks.cleanupMultipleBlocks
  }
})

vi.mock('@renderer/utils/agentSession', () => ({
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:'),
  extractAgentSessionIdFromTopicId: (id: string) => id.replace('agent-session:', '')
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn()
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
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    blocks: ['block-1', 'block-2'],
    askId: 'user-msg-1',
    model: { id: 'model-1' } as any,
    modelId: 'model-1',
    ...overrides
  }) as unknown as Message

const createUserMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'user-msg-1',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    blocks: ['user-block-1'],
    ...overrides
  }) as unknown as Message

const emptyCleanup = { affectedFileIds: [], remainingReferenceCounts: {} as Record<string, number> }

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
  }
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    addMessage: vi.fn((p: unknown) => ({ type: 'addMessage', p })),
    updateMessage: vi.fn((p: unknown) => ({ type: 'updateMessage', p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'setTopicLoading', p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'setTopicFulfilled', p }))
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

describe('resendMessageThunk — no legacy double cleanup (LOCK-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: {
        entities: {},
        messageIdsByTopic: {}
      }
    }
  })

  it('does NOT call cleanupMultipleBlocks after consumeFileCleanupResult', { timeout: 60_000 }, async () => {
    const userMsg = createUserMessage()
    const asstMsg = createMessage()

    storeState.messages.entities = {
      'user-msg-1': userMsg,
      'msg-1': asstMsg
    }
    storeState.messages.messageIdsByTopic = {
      'topic-1': ['user-msg-1', 'msg-1']
    }
    mocks.selectMessagesForTopic.mockReturnValue([userMsg, asstMsg])
    mocks.resetMessagesForResend.mockResolvedValue(emptyCleanup)

    const { resendMessageThunk } = await import('../messageThunk')
    const dispatch = vi.fn()

    await resendMessageThunk('topic-1', userMsg, { id: 'assistant-1', model: { id: 'm1' } } as any)(
      dispatch,
      () => storeState as any
    )

    // cleanupMultipleBlocks must NOT be called in the ordinary path
    expect(mocks.cleanupMultipleBlocks).not.toHaveBeenCalled()
    // consumeFileCleanupResult called exactly once
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledExactlyOnceWith(emptyCleanup)
  })

  it('Redux removeManyBlocks is dispatched for old blocks', { timeout: 60_000 }, async () => {
    const userMsg = createUserMessage()
    const asstMsg = createMessage({ blocks: ['old-block-1', 'old-block-2'] })

    storeState.messages.entities = {
      'user-msg-1': userMsg,
      'msg-1': asstMsg
    }
    storeState.messages.messageIdsByTopic = {
      'topic-1': ['user-msg-1', 'msg-1']
    }
    mocks.selectMessagesForTopic.mockReturnValue([asstMsg])
    mocks.resetMessagesForResend.mockResolvedValue(emptyCleanup)

    const { resendMessageThunk } = await import('../messageThunk')
    const dispatch = vi.fn()

    await resendMessageThunk('topic-1', userMsg, { id: 'assistant-1', model: { id: 'm1' } } as any)(
      dispatch,
      () => storeState as any
    )

    // removeManyBlocks should be called for old blocks
    expect(mocks.removeManyBlocks).toHaveBeenCalledWith(['old-block-1', 'old-block-2'])
  })
})

describe('regenerateAssistantResponseThunk — no legacy double cleanup (LOCK-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: {
        entities: {},
        messageIdsByTopic: {}
      }
    }
  })

  it('does NOT call cleanupMultipleBlocks after consumeFileCleanupResult', { timeout: 60_000 }, async () => {
    const asstMsg = createMessage({ id: 'asst-1', blocks: ['block-1', 'block-2'] })

    storeState.messages.entities = {
      'asst-1': asstMsg
    }
    storeState.messages.messageIdsByTopic = {
      'topic-1': ['asst-1']
    }
    mocks.resetMessagesForResend.mockResolvedValue(emptyCleanup)

    const { regenerateAssistantResponseThunk } = await import('../messageThunk')
    const dispatch = vi.fn()

    await regenerateAssistantResponseThunk('topic-1', asstMsg, { id: 'assistant-1', model: { id: 'm1' } } as any)(
      dispatch,
      () => storeState as any
    )

    // cleanupMultipleBlocks must NOT be called in the ordinary path
    expect(mocks.cleanupMultipleBlocks).not.toHaveBeenCalled()
  })
})
