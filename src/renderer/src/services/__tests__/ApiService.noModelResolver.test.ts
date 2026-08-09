/**
 * Focused tests for ApiService.resolveModelAndProvider — the no-model and
 * stale-provider guards that run before any provider/API/network access.
 *
 * Covers:
 * - undefined model slot -> NoModelError
 * - unresolved provider -> NoModelError
 * - stale provider (resolved provider id !== requested model provider id) ->
 *   NoModelError instead of silently using the fallback default provider
 * - matching provider -> resolves model + provider
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Model, Provider } from '@renderer/types'
import { NO_MODEL_ERROR_NAME } from '@renderer/utils/noModelError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  AiProvider: class MockAiProvider {}
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: vi.fn(),
  getDefaultModel: vi.fn(),
  getProviderByModel: vi.fn(),
  getQuickModel: vi.fn()
}))

vi.mock('@renderer/services/ConversationService', () => ({
  ConversationService: { prepareMessagesForModel: vi.fn() }
}))

vi.mock('@renderer/services/KnowledgeService', () => ({
  injectUserMessageWithKnowledgeSearchPrompt: vi.fn()
}))

// `@renderer/utils/analytics` imports the real ProviderService, which drags in
// the real useStore -> config/providers -> config/models chain; mock it so the
// (unused-in-this-test) provider lookups never load that graph.
vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: vi.fn()
}))

import { getProviderByModel } from '@renderer/services/AssistantService'

import { resolveModelAndProvider } from '../ApiService'

const openaiModel = { id: 'gpt-4', name: 'gpt-4', provider: 'openai' } as Model
const openaiProvider = { id: 'openai', name: 'OpenAI' } as Provider
const anthropicProvider = { id: 'anthropic', name: 'Anthropic' } as Provider

beforeEach(() => {
  mockStore = createMockStore()
  vi.clearAllMocks()
})

describe('resolveModelAndProvider — no-model and stale-provider guards', () => {
  it('throws NoModelError when no model is provided', () => {
    expect(() => resolveModelAndProvider(undefined)).toThrowError(
      expect.objectContaining({ name: NO_MODEL_ERROR_NAME })
    )
    expect(getProviderByModel).not.toHaveBeenCalled()
  })

  it('throws NoModelError when the provider cannot be resolved', () => {
    vi.mocked(getProviderByModel).mockReturnValue(undefined)
    expect(() => resolveModelAndProvider(openaiModel)).toThrowError(
      expect.objectContaining({ name: NO_MODEL_ERROR_NAME })
    )
  })

  it('throws NoModelError for a stale provider instead of silently falling back to the default provider', () => {
    // getProviderByModel falls back to the global default provider when the
    // assistant's model provider is gone from the store; the resolver must not
    // silently use that fallback for a stale assistant model.
    vi.mocked(getProviderByModel).mockReturnValue(anthropicProvider)
    expect(() => resolveModelAndProvider(openaiModel)).toThrowError(
      expect.objectContaining({ name: NO_MODEL_ERROR_NAME })
    )
  })

  it('resolves model + provider when the provider belongs to the requested model', () => {
    vi.mocked(getProviderByModel).mockReturnValue(openaiProvider)
    const result = resolveModelAndProvider(openaiModel)
    expect(result).toEqual({ model: openaiModel, provider: openaiProvider })
  })
})
