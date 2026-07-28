import db from '@renderer/databases'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}))

vi.mock('@renderer/databases', () => ({
  default: {
    transaction: vi.fn(),
    topics: {
      update: vi.fn()
    }
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn()
  }
}))

// Mock the direct assistants import so the test does not load the heavy
// assistants -> useTopic -> messageThunk module graph. The mock mirrors the
// real Redux Toolkit action creator shape used by reorderMessageGroupThunk.
vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: (payload: { topicId: string }) => ({
    type: 'assistants/updateTopicUpdatedAt',
    payload
  })
}))

vi.mock('@renderer/services/db/DbService', () => ({
  DbService: {
    getInstance: () => ({})
  },
  dbService: {}
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (key: string) => key
  },
  t: (key: string) => key
}))

const createMessage = (overrides: Partial<Message>): Message => ({
  id: 'message-id',
  role: 'assistant',
  assistantId: 'assistant-id',
  topicId: 'topic-id',
  createdAt: '2026-05-08T00:00:00.000Z',
  status: AssistantMessageStatus.SUCCESS,
  blocks: [],
  ...overrides
})

describe('buildReorderedMessageGroup', () => {
  it('replaces only the original assistant group slots and preserves message objects', async () => {
    const { buildReorderedMessageGroup } = await import('../messageGroupReorder')
    const userMessage = createMessage({ id: 'user-message', role: 'user', askId: undefined })
    const firstAssistantMessage = createMessage({ id: 'assistant-1', askId: 'ask-1', useful: true })
    const secondAssistantMessage = createMessage({ id: 'assistant-2', askId: 'ask-1', foldSelected: true })
    const nextAssistantMessage = createMessage({ id: 'assistant-3', askId: 'ask-2' })

    const reorderedMessages = buildReorderedMessageGroup(
      [userMessage, firstAssistantMessage, secondAssistantMessage, nextAssistantMessage],
      ['assistant-2', 'assistant-1']
    )

    expect(reorderedMessages).toEqual([
      userMessage,
      secondAssistantMessage,
      firstAssistantMessage,
      nextAssistantMessage
    ])
    expect(firstAssistantMessage.useful).toBe(true)
    expect(secondAssistantMessage.foldSelected).toBe(true)
  })

  it('rejects ids that are not a permutation of one assistant group', async () => {
    const { buildReorderedMessageGroup } = await import('../messageGroupReorder')
    const firstAssistantMessage = createMessage({ id: 'assistant-1', askId: 'ask-1' })
    const secondAssistantMessage = createMessage({ id: 'assistant-2', askId: 'ask-2' })

    const reorderedMessages = buildReorderedMessageGroup(
      [firstAssistantMessage, secondAssistantMessage],
      ['assistant-2', 'assistant-1']
    )

    expect(reorderedMessages).toBeUndefined()
  })

  it('rejects duplicate ids', async () => {
    const { buildReorderedMessageGroup } = await import('../messageGroupReorder')
    const firstAssistantMessage = createMessage({ id: 'assistant-1', askId: 'ask-1' })
    const secondAssistantMessage = createMessage({ id: 'assistant-2', askId: 'ask-1' })

    const reorderedMessages = buildReorderedMessageGroup(
      [firstAssistantMessage, secondAssistantMessage],
      ['assistant-1', 'assistant-1']
    )

    expect(reorderedMessages).toBeUndefined()
  })
})

describe('reorderMessageGroupThunk', () => {
  beforeEach(() => {
    ;(db.transaction as any).mockImplementation(
      async (_mode: string, _table: unknown, callback: () => Promise<void>) => {
        await callback()
        return { timeout: vi.fn() }
      }
    )
    vi.mocked(db.topics.update).mockResolvedValue(1)
  })

  it('persists reordered messages, dispatches updates, and preserves message fields by identity', async () => {
    const { reorderMessageGroupThunk } = await import('../messageGroupReorder')
    const topicId = 'topic-id'
    const firstAssistantMessage = createMessage({ id: 'assistant-1', askId: 'ask-1', useful: true })
    const secondAssistantMessage = createMessage({ id: 'assistant-2', askId: 'ask-1', foldSelected: true })
    const messages = [firstAssistantMessage, secondAssistantMessage]
    const reorderedMessages = [secondAssistantMessage, firstAssistantMessage]
    const dispatch = vi.fn()
    const getState = vi.fn(() => ({
      messages: {
        entities: {
          [firstAssistantMessage.id]: firstAssistantMessage,
          [secondAssistantMessage.id]: secondAssistantMessage
        },
        ids: [firstAssistantMessage.id, secondAssistantMessage.id],
        messageIdsByTopic: {
          [topicId]: messages.map((message) => message.id)
        }
      }
    })) as () => any

    await reorderMessageGroupThunk(
      topicId,
      reorderedMessages.map((message) => message.id)
    )(dispatch, getState)

    expect(db.topics.update).toHaveBeenCalledWith(topicId, { messages: reorderedMessages })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'newMessages/messagesReceived',
        payload: { topicId, messages: reorderedMessages }
      })
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistants/updateTopicUpdatedAt',
        payload: { topicId }
      })
    )
    expect(reorderedMessages[0]).toBe(secondAssistantMessage)
    expect(reorderedMessages[1]).toBe(firstAssistantMessage)
    expect(reorderedMessages[0].foldSelected).toBe(true)
    expect(reorderedMessages[1].useful).toBe(true)
  })
})
