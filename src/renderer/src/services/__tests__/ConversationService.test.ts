import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { createErrorBlock, createMainTextBlock, createMessage } from '@renderer/utils/messageUtils/create'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationService } from '../ConversationService'

// Create a lightweight mock store for selectors used in the filtering pipeline
const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () => {
  return configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })
}

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/services/AssistantService', () => {
  const createDefaultTopic = () => ({
    id: 'topic-default',
    assistantId: 'assistant-default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: 'Default Topic',
    messages: [],
    isNameManuallyEdited: false
  })

  const defaultAssistantSettings = { contextCount: 10 }

  const createDefaultAssistant = () => ({
    id: 'assistant-default',
    name: 'Default Assistant',
    emoji: '😀',
    topics: [createDefaultTopic()],
    messages: [],
    type: 'assistant',
    regularPhrases: [],
    settings: defaultAssistantSettings
  })

  return {
    DEFAULT_ASSISTANT_SETTINGS: defaultAssistantSettings,
    getAssistantSettings: () => ({ contextCount: 10, topicContextWindowMode: {} }),
    getDefaultModel: () => ({ id: 'default-model' }),
    getDefaultAssistant: () => createDefaultAssistant(),
    getDefaultTopic: () => createDefaultTopic(),
    getAssistantProvider: () => ({}),
    getProviderByModel: () => ({}),
    getProviderByModelId: () => ({}),
    getAssistantById: () => createDefaultAssistant(),
    getQuickModel: () => null,
    getTranslateModel: () => null,
    getDefaultTranslateAssistant: () => createDefaultAssistant()
  }
})

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: any) => mockStore.dispatch(action)
  }
}))

describe('ConversationService.filterMessagesPipeline', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  it('removes error-only assistant replies together with their user message before trimming trailing assistants', () => {
    const topicId = 'topic-1'
    const assistantId = 'assistant-1'

    const user1Block = createMainTextBlock('user-1', 'First question', { status: MessageBlockStatus.SUCCESS })
    const user1 = createMessage('user', topicId, assistantId, { id: 'user-1', blocks: [user1Block.id] })

    const assistant1Block = createMainTextBlock('assistant-1', 'First answer', {
      status: MessageBlockStatus.SUCCESS
    })
    const assistant1 = createMessage('assistant', topicId, assistantId, {
      id: 'assistant-1',
      askId: 'user-1',
      blocks: [assistant1Block.id]
    })

    const user2Block = createMainTextBlock('user-2', 'Second question', { status: MessageBlockStatus.SUCCESS })
    const user2 = createMessage('user', topicId, assistantId, { id: 'user-2', blocks: [user2Block.id] })

    const errorBlock = createErrorBlock(
      'assistant-2',
      { message: 'Error occurred', name: 'Error', stack: null },
      { status: MessageBlockStatus.ERROR }
    )
    const assistantError = createMessage('assistant', topicId, assistantId, {
      id: 'assistant-2',
      askId: 'user-2',
      blocks: [errorBlock.id]
    })

    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(user1Block))
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(assistant1Block))
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(user2Block))
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(errorBlock))

    const filtered = ConversationService.filterMessagesPipeline(
      [user1, assistant1, user2, assistantError],
      /* contextCount */ 10
    )

    expect(filtered.map((m) => m.id)).toEqual(['user-1'])
    expect(filtered.find((m) => m.id === 'user-2')).toBeUndefined()
  })

  it('preserves context while removing leading assistants and adjacent user duplicates', () => {
    const topicId = 'topic-1'
    const assistantId = 'assistant-1'

    const leadingAssistantBlock = createMainTextBlock('assistant-leading', 'Hi there', {
      status: MessageBlockStatus.SUCCESS
    })
    const leadingAssistant = createMessage('assistant', topicId, assistantId, {
      id: 'assistant-leading',
      blocks: [leadingAssistantBlock.id]
    })

    const user1Block = createMainTextBlock('user-1', 'First question', { status: MessageBlockStatus.SUCCESS })
    const user1 = createMessage('user', topicId, assistantId, { id: 'user-1', blocks: [user1Block.id] })

    const assistant1Block = createMainTextBlock('assistant-1', 'First answer', {
      status: MessageBlockStatus.SUCCESS
    })
    const assistant1 = createMessage('assistant', topicId, assistantId, {
      id: 'assistant-1',
      askId: 'user-1',
      blocks: [assistant1Block.id]
    })

    const user2Block = createMainTextBlock('user-2', 'Draft question', { status: MessageBlockStatus.SUCCESS })
    const user2 = createMessage('user', topicId, assistantId, { id: 'user-2', blocks: [user2Block.id] })

    const user3Block = createMainTextBlock('user-3', 'Final question', { status: MessageBlockStatus.SUCCESS })
    const user3 = createMessage('user', topicId, assistantId, { id: 'user-3', blocks: [user3Block.id] })

    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(leadingAssistantBlock))
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(user1Block))
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(assistant1Block))
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(user2Block))
    mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(user3Block))

    const filtered = ConversationService.filterMessagesPipeline(
      [leadingAssistant, user1, assistant1, user2, user3],
      /* contextCount */ 10
    )

    expect(filtered.map((m) => m.id)).toEqual(['user-1', 'assistant-1', 'user-3'])
    expect(filtered.find((m) => m.id === 'user-2')).toBeUndefined()
    expect(filtered[0].role).toBe('user')
    expect(filtered[filtered.length - 1].role).toBe('user')
  })

  describe('anchor modes (TopicAnchor)', () => {
    // Helper to create a message with a registered text block
    const makeMsg = (id: string, role: 'user' | 'assistant', topicId: string, assistantId: string, askId?: string) => {
      const block = createMainTextBlock(id, `content-${id}`, { status: MessageBlockStatus.SUCCESS })
      mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(block))
      return createMessage(role, topicId, assistantId, {
        id,
        askId,
        blocks: [block.id]
      })
    }

    it('undefined anchor → sliding mode (takeRight)', () => {
      const topicId = 'topic-1'
      const assistantId = 'assistant-1'
      const messages: ReturnType<typeof createMessage>[] = []
      for (let i = 0; i < 20; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        const askId = role === 'assistant' ? `m${i - 1}` : undefined
        messages.push(makeMsg(`m${i}`, role, topicId, assistantId, askId))
      }

      const filtered = ConversationService.filterMessagesPipeline(messages, /* contextCount */ 3, 'sliding', undefined)

      // Sliding: takeRight(preFiltered, 3+2=5) — but after pipeline filters
      expect(filtered.length).toBeLessThanOrEqual(5)
      expect(filtered.length).toBeGreaterThan(0)
    })

    it('undefined anchor + fixed mode → full messages, no truncation', () => {
      const topicId = 'topic-1'
      const assistantId = 'assistant-1'
      const messages: ReturnType<typeof createMessage>[] = []
      for (let i = 0; i < 10; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        const askId = role === 'assistant' ? `m${i - 1}` : undefined
        messages.push(makeMsg(`m${i}`, role, topicId, assistantId, askId))
      }

      const filtered = ConversationService.filterMessagesPipeline(messages, /* contextCount */ 3, 'fixed', undefined)

      // undefined anchor in fixed mode: all messages (after pipeline filters), no truncation
      expect(filtered.length).toBeGreaterThan(0)
    })

    it('active anchor → slice from groupKey user message', () => {
      const topicId = 'topic-1'
      const assistantId = 'assistant-1'

      const user1 = makeMsg('u1', 'user', topicId, assistantId)
      const a1 = makeMsg('a1', 'assistant', topicId, assistantId, 'u1')
      const user2 = makeMsg('u2', 'user', topicId, assistantId)
      const a2 = makeMsg('a2', 'assistant', topicId, assistantId, 'u2')
      const user3 = makeMsg('u3', 'user', topicId, assistantId)
      const a3 = makeMsg('a3', 'assistant', topicId, assistantId, 'u3')

      const filtered = ConversationService.filterMessagesPipeline(
        [user1, a1, user2, a2, user3, a3],
        /* contextCount */ 100,
        'fixed',
        { kind: 'active', groupKey: 'u2' }
      )

      // Should start from u2 and include everything after
      expect(filtered.find((m) => m.id === 'u1')).toBeUndefined()
      expect(filtered.find((m) => m.id === 'u2')).toBeDefined()
    })

    it('active anchor with groupKey at index 0 → all messages', () => {
      const topicId = 'topic-1'
      const assistantId = 'assistant-1'

      const user1 = makeMsg('u1', 'user', topicId, assistantId)
      const a1 = makeMsg('a1', 'assistant', topicId, assistantId, 'u1')
      const user2 = makeMsg('u2', 'user', topicId, assistantId)

      const filtered = ConversationService.filterMessagesPipeline([user1, a1, user2], /* contextCount */ 100, 'fixed', {
        kind: 'active',
        groupKey: 'u1'
      })

      // All messages from u1 onward
      expect(filtered.find((m) => m.id === 'u1')).toBeDefined()
      expect(filtered.find((m) => m.id === 'u2')).toBeDefined()
    })

    it('active anchor with groupKey not found → full messages (fallback)', () => {
      const topicId = 'topic-1'
      const assistantId = 'assistant-1'

      const user1 = makeMsg('u1', 'user', topicId, assistantId)
      const a1 = makeMsg('a1', 'assistant', topicId, assistantId, 'u1')

      const filtered = ConversationService.filterMessagesPipeline([user1, a1], /* contextCount */ 100, 'fixed', {
        kind: 'active',
        groupKey: 'nonexistent'
      })

      // Not found → full messages (fallback)
      expect(filtered.find((m) => m.id === 'u1')).toBeDefined()
    })
  })
})
