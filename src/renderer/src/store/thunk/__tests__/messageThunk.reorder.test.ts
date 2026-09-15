import type { messagesSlice, newMessagesActions } from '@renderer/store/newMessage'
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

const { mocks } = vi.hoisted(() => ({
  mocks: {
    reorderAnswerGroup: vi.fn(),
    reorderMessages: vi.fn().mockResolvedValue(undefined),
    reorderLoadedIdsAction: vi.fn((p: unknown) => ({
      type: 'newMessages/reorderLoadedMessageIdsForTopic',
      payload: p
    })),
    selectLoadedMessagesForTopic: vi.fn()
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    reorderAnswerGroup: mocks.reorderAnswerGroup,
    reorderMessages: mocks.reorderMessages
  }
}))

vi.mock('@renderer/services/db/DbService', () => ({
  DbService: {
    getInstance: () => ({})
  },
  dbService: {
    reorderAnswerGroup: mocks.reorderAnswerGroup,
    reorderMessages: mocks.reorderMessages
  }
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    reorderLoadedMessageIdsForTopic: mocks.reorderLoadedIdsAction,
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p }))
  },
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
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

const topicId = 'topic-id'
const askId = 'ask-1'
const authorityResponse = {
  topicId,
  askId,
  anchorMessageId: 'assistant-2',
  orderedMessageIds: ['assistant-2', 'assistant-1']
}

const makeLoadedState = () => {
  const userMessage = createMessage({ id: 'user-1', role: 'user', askId: undefined })
  const firstAssistantMessage = createMessage({ id: 'assistant-1', askId, useful: true })
  const secondAssistantMessage = createMessage({ id: 'assistant-2', askId, foldSelected: true })
  return {
    userMessage,
    firstAssistantMessage,
    secondAssistantMessage,
    state: {
      messages: {
        entities: {
          'user-1': userMessage,
          'assistant-1': firstAssistantMessage,
          'assistant-2': secondAssistantMessage
        },
        ids: ['user-1', 'assistant-1', 'assistant-2'],
        messageIdsByTopic: {
          [topicId]: ['user-1', 'assistant-1', 'assistant-2']
        }
      }
    } as any
  }
}

describe('reorderMessageGroupThunk — semantic authority reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.reorderAnswerGroup.mockResolvedValue(authorityResponse)
  })

  it('calls ONE semantic DB command with anchor + group order BEFORE any Redux commit', async () => {
    const { reorderMessageGroupThunk } = await import('../messageGroupReorder')
    const { state } = makeLoadedState()
    const dispatch = vi.fn()
    const getState = vi.fn(() => state)
    const callOrder: string[] = []
    mocks.reorderAnswerGroup.mockImplementation(async () => {
      callOrder.push('db-atomic')
      return authorityResponse
    })
    dispatch.mockImplementation((action: unknown) => {
      callOrder.push(`redux-${(action as any).type}`)
      return action
    })

    await reorderMessageGroupThunk(topicId, ['assistant-2', 'assistant-1'])(dispatch, getState)

    expect(mocks.reorderAnswerGroup).toHaveBeenCalledTimes(1)
    expect(mocks.reorderAnswerGroup).toHaveBeenCalledWith(topicId, 'assistant-2', ['assistant-2', 'assistant-1'])
    const dbIdx = callOrder.findIndex((c) => c.startsWith('db-'))
    const reduxIdx = callOrder.findIndex((c) => c.startsWith('redux-'))
    expect(dbIdx).toBeGreaterThanOrEqual(0)
    expect(reduxIdx).toBeGreaterThanOrEqual(0)
    expect(dbIdx).toBeLessThan(reduxIdx)
  })

  it('never reads loaded messages to build a full topic list (no selectLoadedMessagesForTopic)', async () => {
    const { reorderMessageGroupThunk } = await import('../messageGroupReorder')
    const { state } = makeLoadedState()
    const dispatch = vi.fn()

    await reorderMessageGroupThunk(topicId, ['assistant-2', 'assistant-1'])(dispatch, () => state)

    expect(mocks.selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    // The legacy full-list path is gone: no messagesReceived with a partial
    // Messages array masquerading as complete topic content.
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'newMessages/reorderLoadedMessageIdsForTopic' })
    )
  })

  it('dispatches exactly one ids-only action carrying the authority order', async () => {
    const { reorderMessageGroupThunk } = await import('../messageGroupReorder')
    const { state } = makeLoadedState()
    const dispatch = vi.fn()

    await reorderMessageGroupThunk(topicId, ['assistant-2', 'assistant-1'])(dispatch, () => state)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.reorderLoadedIdsAction).toHaveBeenCalledTimes(1)
    expect(mocks.reorderLoadedIdsAction).toHaveBeenCalledWith({
      topicId,
      orderedMessageIds: ['assistant-2', 'assistant-1'],
      groupMessageIds: ['assistant-2', 'assistant-1']
    })
  })

  it('does NOT dispatch updateTopicUpdatedAt itself (data source owns the single timestamp dispatch)', async () => {
    const { reorderMessageGroupThunk } = await import('../messageGroupReorder')
    const { state } = makeLoadedState()
    const dispatch = vi.fn()

    await reorderMessageGroupThunk(topicId, ['assistant-2', 'assistant-1'])(dispatch, () => state)

    expect(dispatch).toHaveBeenCalledTimes(1)
    const action = dispatch.mock.calls[0][0]
    expect(action.type).not.toMatch(/updateTopicUpdatedAt/)
  })

  it('does NOT touch Redux when the DB command fails (no divergent state)', async () => {
    const { reorderMessageGroupThunk } = await import('../messageGroupReorder')
    const { state } = makeLoadedState()
    const dispatch = vi.fn()
    mocks.reorderAnswerGroup.mockRejectedValue(new Error('CONFLICT'))

    await expect(
      reorderMessageGroupThunk(topicId, ['assistant-2', 'assistant-1'])(dispatch, () => state)
    ).rejects.toThrow('CONFLICT')

    expect(dispatch).not.toHaveBeenCalled()
    expect(mocks.reorderLoadedIdsAction).not.toHaveBeenCalled()
  })

  it('fail-closed with zero dispatch when a response member has no loaded entity', async () => {
    const { reorderMessageGroupThunk } = await import('../messageGroupReorder')
    const { state } = makeLoadedState()
    // assistant-2 is in the loaded id list but missing from entities.
    delete (state.messages.entities as Record<string, unknown>)['assistant-2']
    const dispatch = vi.fn()

    await reorderMessageGroupThunk(topicId, ['assistant-2', 'assistant-1'])(dispatch, () => state)

    expect(mocks.reorderAnswerGroup).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
    expect(mocks.reorderLoadedIdsAction).not.toHaveBeenCalled()
  })

  it('no-ops without a DB call on empty group ids', async () => {
    const { reorderMessageGroupThunk } = await import('../messageGroupReorder')
    const { state } = makeLoadedState()
    const dispatch = vi.fn()

    await reorderMessageGroupThunk(topicId, [])(dispatch, () => state)

    expect(mocks.reorderAnswerGroup).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('reorderLoadedMessageIdsForTopic — real reducer projection semantics', () => {
  it('permutes only loaded group slots; outside messages and entities untouched', async () => {
    const actual = (await vi.importActual('@renderer/store/newMessage')) as unknown as {
      messagesSlice: typeof messagesSlice
      newMessagesActions: typeof newMessagesActions
    }
    const userMessage = createMessage({ id: 'user-1', role: 'user', askId: undefined })
    const firstAssistantMessage = createMessage({ id: 'assistant-1', askId, useful: true })
    const secondAssistantMessage = createMessage({ id: 'assistant-2', askId, foldSelected: true })
    const tailUser = createMessage({ id: 'user-2', role: 'user', askId: undefined })
    const preloaded = {
      entities: {
        'user-1': userMessage,
        'assistant-1': firstAssistantMessage,
        'assistant-2': secondAssistantMessage,
        'user-2': tailUser
      },
      ids: ['user-1', 'assistant-1', 'assistant-2', 'user-2'],
      messageIdsByTopic: { [topicId]: ['user-1', 'assistant-1', 'assistant-2', 'user-2'] },
      currentTopicId: topicId,
      loadingByTopic: {},
      fulfilledByTopic: {},
      displayCount: 10
    } as any

    const next = actual.messagesSlice.reducer(
      preloaded,
      actual.newMessagesActions.reorderLoadedMessageIdsForTopic({
        topicId,
        orderedMessageIds: ['assistant-2', 'assistant-1'],
        groupMessageIds: ['assistant-2', 'assistant-1']
      })
    )

    expect(next.messageIdsByTopic[topicId]).toEqual(['user-1', 'assistant-2', 'assistant-1', 'user-2'])
    // Entities preserved by identity — foldSelected/useful objects unchanged.
    expect(next.entities['assistant-1']).toBe(firstAssistantMessage)
    expect(next.entities['assistant-2']).toBe(secondAssistantMessage)
    expect(next.entities['assistant-1'].useful).toBe(true)
    expect(next.entities['assistant-2'].foldSelected).toBe(true)
  })

  it('never injects a window-outside member; only the loaded intersection moves', async () => {
    const actual = (await vi.importActual('@renderer/store/newMessage')) as unknown as {
      messagesSlice: typeof messagesSlice
      newMessagesActions: typeof newMessagesActions
    }
    const tailUser = createMessage({ id: 'user-tail', role: 'user', askId: undefined })
    const g1 = createMessage({ id: 'g-1', askId: 'ask-w' })
    const g2 = createMessage({ id: 'g-2', askId: 'ask-w' })
    // g-3 is window-outside: in the authority group but absent from the projection.
    const preloaded = {
      entities: { 'user-tail': tailUser, 'g-1': g1, 'g-2': g2 },
      ids: ['user-tail', 'g-1', 'g-2'],
      messageIdsByTopic: { [topicId]: ['user-tail', 'g-1', 'g-2'] },
      currentTopicId: topicId,
      loadingByTopic: {},
      fulfilledByTopic: {},
      displayCount: 10
    } as any

    const next = actual.messagesSlice.reducer(
      preloaded,
      actual.newMessagesActions.reorderLoadedMessageIdsForTopic({
        topicId,
        orderedMessageIds: ['g-2', 'g-3', 'g-1'],
        groupMessageIds: ['g-2', 'g-3', 'g-1']
      })
    )

    expect(next.messageIdsByTopic[topicId]).toEqual(['user-tail', 'g-2', 'g-1'])
    expect(next.messageIdsByTopic[topicId]).not.toContain('g-3')
    expect(next.entities['g-3']).toBeUndefined()
  })

  it('fail-closed no-op on slot-count mismatch (group claims a loaded member the order omits)', async () => {
    const actual = (await vi.importActual('@renderer/store/newMessage')) as unknown as {
      messagesSlice: typeof messagesSlice
      newMessagesActions: typeof newMessagesActions
    }
    const g1 = createMessage({ id: 'g-1', askId: 'ask-w' })
    const g2 = createMessage({ id: 'g-2', askId: 'ask-w' })
    const g3 = createMessage({ id: 'g-3', askId: 'ask-w' })
    const preloaded = {
      entities: { 'g-1': g1, 'g-2': g2, 'g-3': g3 },
      ids: ['g-1', 'g-2', 'g-3'],
      messageIdsByTopic: { [topicId]: ['g-1', 'g-2', 'g-3'] },
      currentTopicId: topicId,
      loadingByTopic: {},
      fulfilledByTopic: {},
      displayCount: 10
    } as any

    const next = actual.messagesSlice.reducer(
      preloaded,
      actual.newMessagesActions.reorderLoadedMessageIdsForTopic({
        topicId,
        orderedMessageIds: ['g-2', 'g-1'],
        groupMessageIds: ['g-1', 'g-2', 'g-3']
      })
    )

    expect(next.messageIdsByTopic[topicId]).toEqual(['g-1', 'g-2', 'g-3'])
  })
})
