/**
 * Focused regression for a turn whose triggering message has nothing sendable
 * (every attachment it carries is provably unavailable on this device).
 *
 * Request preparation reports that outcome as `nothingSendable` instead of
 * throwing, and the request boundary must end the operation silently:
 * - no provider request is created (no AiProvider, no completion, no knowledge
 *   prompt injection);
 * - no chunk is emitted at all, in particular no ERROR chunk — an ERROR chunk is
 *   what renders the inline failed answer;
 * - the top notice already emitted during preparation stays the whole
 *   user-visible result.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prepareMock, aiProviderCtor, injectKnowledgeMock } = vi.hoisted(() => ({
  prepareMock: vi.fn(),
  aiProviderCtor: vi.fn(),
  injectKnowledgeMock: vi.fn()
}))

const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: unknown) => mockStore.dispatch(action as never)
  }
}))

vi.mock('@renderer/store/mcp', () => ({
  hubMCPServer: { id: 'hub', type: 'builtin', name: 'hub', baseUrl: '' }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/config/models', () => ({
  isDedicatedImageGenerationModel: vi.fn(() => false),
  isEmbeddingModel: vi.fn(() => false),
  isFunctionCallingModel: vi.fn(() => false)
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: vi.fn()
}))

vi.mock('@renderer/aiCore/prepareParams', () => ({
  buildStreamTextParams: vi.fn()
}))

vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: vi.fn()
}))

vi.mock('@renderer/aiCore', () => ({
  AiProvider: class MockAiProvider {
    constructor(...args: unknown[]) {
      aiProviderCtor(...args)
    }
    completions = vi.fn()
    getActualProvider = () => ({})
  }
}))

vi.mock('@renderer/services/AssistantService', () => ({
  createEphemeralAssistant: vi.fn(),
  getDefaultModel: vi.fn(() => ({ id: 'm', provider: 'p', name: 'm', group: 'g' })),
  getProviderByModel: vi.fn(() => ({ id: 'p', type: 'openai' })),
  getQuickModel: vi.fn()
}))

vi.mock('@renderer/services/ConversationService', () => ({
  ConversationService: { prepareMessagesForModel: prepareMock }
}))

vi.mock('@renderer/services/KnowledgeService', () => ({
  injectUserMessageWithKnowledgeSearchPrompt: injectKnowledgeMock
}))

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: vi.fn()
}))

import { transformMessagesAndFetch } from '../ApiService'

const assistant = {
  id: 'asst-1',
  prompt: '',
  model: { id: 'm', provider: 'p', name: 'm', group: 'g' },
  settings: { streamOutput: true }
} as unknown as Assistant

function request() {
  return {
    messages: [] as never[],
    assistant,
    blockManager: {} as never,
    assistantMsgId: 'asst-msg-1',
    callbacks: {},
    topicId: 't-1',
    branchId: null,
    options: {}
  }
}

beforeEach(() => {
  mockStore = createMockStore()
  vi.clearAllMocks()
})

describe('transformMessagesAndFetch — nothing sendable for the trigger', () => {
  it('ends silently: no chunk (no ERROR), no provider request, no prompt injection', async () => {
    prepareMock.mockResolvedValue({ modelMessages: [], uiMessages: [], nothingSendable: true })
    const onChunkReceived = vi.fn()

    await transformMessagesAndFetch(request() as never, onChunkReceived)

    // No ERROR chunk and no LLM_RESPONSE_CREATED: nothing reaches the assistant
    // message, so no failed/inline answer block can be produced.
    expect(onChunkReceived).not.toHaveBeenCalled()
    // No provider work of any kind started.
    expect(aiProviderCtor).not.toHaveBeenCalled()
    expect(injectKnowledgeMock).not.toHaveBeenCalled()
  })

  it('a sendable request still reaches the provider path (unchanged behavior)', async () => {
    prepareMock.mockResolvedValue({
      modelMessages: [{ role: 'user', content: 'hi' }],
      uiMessages: [],
      nothingSendable: false
    })
    const onChunkReceived = vi.fn()

    // The provider path itself is mocked out above; the assertion is only that
    // the boundary is not short-circuited for a sendable request.
    await transformMessagesAndFetch(request() as never, onChunkReceived).catch(() => undefined)

    expect(injectKnowledgeMock).toHaveBeenCalledTimes(1)
  })
})
