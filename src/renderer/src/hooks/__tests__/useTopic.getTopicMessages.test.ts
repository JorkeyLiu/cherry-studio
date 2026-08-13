/**
 * TopicManager.getTopicMessages regression coverage.
 *
 * The helper feeds topic naming (and export/search/history consumers) its
 * messages. It must return the ordered messages from the canonical
 * SQLite -> typed IPC -> `messages` Redux projection, never from the
 * assistants `topic.messages` field, which the message reducers strip.
 *
 * The mocked load thunk mirrors the real contract: it synchronously populates
 * the `messages` projection before its awaited promise resolves, and the IDs
 * stay in the order loaded from SQLite.
 */

import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TopicManager } from '../useTopic'

// --- Mocks ----------------------------------------------------------------

const { loadTopicMessagesThunkMock, messagesState } = vi.hoisted(() => {
  // SQLite order for each topic. Deliberately not sorted by id/createdAt so the
  // assertion proves the ordered-ID list is authoritative, not incidental order.
  const orderedIdsByTopic: Record<string, string[]> = {
    'topic-1': ['msg-3', 'msg-1', 'msg-2'],
    'topic-2': ['msg-2', 'msg-3']
  }

  const messagesState = {
    entities: {} as Record<string, unknown>,
    messageIdsByTopic: {} as Record<string, string[]>
  }

  return {
    loadTopicMessagesThunkMock: vi.fn((topicId: string) => {
      // Mirror the real thunk: populate the projection synchronously before the
      // awaited promise resolves.
      messagesState.messageIdsByTopic[topicId] = orderedIdsByTopic[topicId] ?? []
      return Promise.resolve()
    }),
    orderedIdsByTopic,
    messagesState
  }
})

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
  dbService: { fetchMessages: vi.fn() }
}))
vi.mock('@renderer/services/db/topicMetadataPersist', () => ({ persistTopicMetadata: vi.fn() }))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/services/ApiService', () => ({ fetchMessagesSummary: vi.fn() }))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: { emit: vi.fn() } }))

// --- Store mock setup ----------------------------------------------------

// The mocked store returns this same object every call, so the projection the
// thunk mock mutates is exactly what `selectMessagesForTopic` reads through
// `store.getState()`.
const storeState = {
  assistants: {
    assistants: [
      {
        id: 'assistant-1',
        topics: [
          { id: 'topic-1', assistantId: 'assistant-1', name: 'Topic 1', messages: [] as Message[] },
          { id: 'topic-2', assistantId: 'assistant-1', name: 'Topic 2', messages: [] as Message[] }
        ]
      }
    ]
  },
  messages: messagesState,
  runtime: { chat: { renamingTopics: [] as string[], newlyRenamedTopics: [] as string[] } }
}

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  }
}))
vi.mock('@renderer/store/assistants', () => ({ updateTopic: vi.fn() }))
vi.mock('@renderer/store/runtime', () => ({ setNewlyRenamedTopics: vi.fn(), setRenamingTopics: vi.fn() }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({ loadTopicMessagesThunk: loadTopicMessagesThunkMock }))
vi.mock('../useAssistant', () => ({ useAssistant: vi.fn() }))
vi.mock('../useSettings', () => ({ getStoreSetting: vi.fn() }))

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
    blocks: ['block-1'],
    askId: undefined,
    ...overrides
  }) as unknown as Message

// --- Tests ----------------------------------------------------------------

describe('TopicManager.getTopicMessages (SQLite -> IPC -> messages projection)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messagesState.messageIdsByTopic = {}
    messagesState.entities = {
      'msg-1': createMessage({ id: 'msg-1' }),
      'msg-2': createMessage({
        id: 'msg-2',
        role: 'assistant',
        status: AssistantMessageStatus.SUCCESS,
        askId: 'msg-1'
      }),
      'msg-3': createMessage({ id: 'msg-3' })
    }
    storeState.assistants.assistants[0].topics[1].messages = []
  })

  it('returns the ordered messages from the messages projection after the load thunk resolves', async () => {
    const messages = await TopicManager.getTopicMessages('topic-1')

    expect(loadTopicMessagesThunkMock).toHaveBeenCalledExactlyOnceWith('topic-1')
    expect(messages.map((m) => m.id)).toEqual(['msg-3', 'msg-1', 'msg-2'])
  })

  it('does not depend on assistants topic.messages, which stays stripped', async () => {
    // If topic.messages ever carried stale content it must still be ignored;
    // the projection readback is the only message source.
    const topic = storeState.assistants.assistants[0].topics.find((t) => t.id === 'topic-2')
    if (!topic) throw new Error('fixture topic-2 missing')
    topic.messages = [{ id: 'stale-msg' } as unknown as Message]

    const messages = await TopicManager.getTopicMessages('topic-2')

    expect(messages.map((m) => m.id)).toEqual(['msg-2', 'msg-3'])
    expect(messages.some((m) => m.id === 'stale-msg')).toBe(false)
  })

  it('preserves missing-topic semantics: returns [] without dispatching the load', async () => {
    const messages = await TopicManager.getTopicMessages('topic-unknown')

    expect(messages).toEqual([])
    expect(loadTopicMessagesThunkMock).not.toHaveBeenCalled()
  })
})
