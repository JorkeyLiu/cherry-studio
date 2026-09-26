/**
 * Focused tests: summary / topic-name / generate helper paths must use exact
 * provider resolution. A stale model (its provider is gone or belongs to
 * another entry) fails explicitly before any provider/API access instead of
 * silently substituting the default provider. Unknown manually added model
 * ids with a valid exact provider still proceed with basic behavior.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type * as ConfigModelsModule from '@renderer/config/models'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reducer = combineReducers({ messageBlocks: messageBlocksSlice.reducer })
const createMockStore = () => configureStore({ reducer, middleware: (gdm) => gdm({ serializableCheck: false }) })
let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: unknown) => mockStore.dispatch(action as never)
  }
}))
vi.mock('@renderer/store/mcp', () => ({ hubMCPServer: { id: 'hub' } }))
vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@renderer/config/models', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModelsModule>()
  return {
    ...actual,
    isDedicatedImageGenerationModel: vi.fn(() => false),
    isEmbeddingModel: vi.fn(() => false),
    isFunctionCallingModel: vi.fn(() => false)
  }
})
vi.mock('@renderer/hooks/useSettings', () => ({ getStoreSetting: vi.fn(() => '') }))

const { assistantMocks, completionsMock } = vi.hoisted(() => ({
  assistantMocks: {
    createEphemeralAssistant: vi.fn((init: unknown) => ({
      id: 'ephemeral-test',
      topics: [],
      messages: [],
      settings: {},
      ...(init as object)
    })),
    getDefaultModel: vi.fn(),
    getProviderByModel: vi.fn(),
    getQuickModel: vi.fn()
  },
  completionsMock: vi.fn()
}))

vi.mock('@renderer/services/AssistantService', () => assistantMocks)
vi.mock('@renderer/utils/prompt', () => ({
  containsSupportedVariables: () => false,
  replacePromptVariables: vi.fn()
}))
vi.mock('@renderer/utils/analytics', () => ({ trackTokenUsage: vi.fn() }))
vi.mock('@renderer/utils/provider', () => ({
  NOT_SUPPORT_API_KEY_PROVIDER_TYPES: [],
  NOT_SUPPORT_API_KEY_PROVIDERS: []
}))
vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: () => ({ providerOptions: {}, standardParams: {} })
}))
vi.mock('@renderer/aiCore', () => ({
  AiProvider: class {
    getActualProvider() {
      return 'test-provider'
    }
    async completions() {
      return completionsMock()
    }
  }
}))

import { fetchGenerate, fetchMessagesSummary, fetchNoteSummary } from '../ApiService'

const exactProvider: any = { id: 'p1', apiKey: 'k1' }
const otherProvider: any = { id: 'other', apiKey: 'k2' }
const staleModel: any = { id: 'stale-model', name: 'stale', provider: 'deleted-provider' }
const unknownModel: any = { id: 'my-renamed-unknown-1', name: 'custom', provider: 'p1' }

beforeEach(() => {
  mockStore = createMockStore()
  vi.clearAllMocks()
  assistantMocks.createEphemeralAssistant.mockImplementation((init: unknown) => ({
    id: 'ephemeral-test',
    topics: [],
    messages: [],
    settings: {},
    ...(init as object)
  }))
  completionsMock.mockResolvedValue({ getText: () => 'Title', usage: undefined })
})

describe('fetchMessagesSummary — exact provider resolution', () => {
  const messages: any[] = [{ id: 'm1', topicId: 't1', role: 'user', blocks: [] }]

  it('fails explicitly without API access for a stale quickModel', async () => {
    assistantMocks.getQuickModel.mockReturnValue(staleModel)
    assistantMocks.getProviderByModel.mockReturnValue(otherProvider)

    const result = await fetchMessagesSummary({ messages })

    expect(result).toEqual({ text: null, error: 'message.error.enter.model' })
    expect(completionsMock).not.toHaveBeenCalled()
  })

  it('proceeds for an unknown model id with a valid exact provider', async () => {
    assistantMocks.getQuickModel.mockReturnValue(unknownModel)
    assistantMocks.getProviderByModel.mockReturnValue(exactProvider)

    const result = await fetchMessagesSummary({ messages })

    expect(result.text).toBe('Title')
    expect(completionsMock).toHaveBeenCalledOnce()
  })
})

describe('fetchNoteSummary — exact provider resolution', () => {
  it('returns null without API access for a stale model', async () => {
    assistantMocks.getQuickModel.mockReturnValue(staleModel)
    assistantMocks.getProviderByModel.mockReturnValue(otherProvider)

    const result = await fetchNoteSummary({ content: 'hello' })

    expect(result).toBeNull()
    expect(completionsMock).not.toHaveBeenCalled()
  })

  it('proceeds for an unknown model id with a valid exact provider', async () => {
    assistantMocks.getQuickModel.mockReturnValue(unknownModel)
    assistantMocks.getProviderByModel.mockReturnValue(exactProvider)

    const result = await fetchNoteSummary({ content: 'hello' })

    expect(result).toBe('Title')
    expect(completionsMock).toHaveBeenCalledOnce()
  })
})

describe('fetchGenerate — exact provider resolution', () => {
  it('returns empty without API access for a stale model', async () => {
    assistantMocks.getProviderByModel.mockReturnValue(otherProvider)

    const result = await fetchGenerate({ prompt: 'p', content: 'c', model: staleModel })

    expect(result).toBe('')
    expect(completionsMock).not.toHaveBeenCalled()
  })

  it('proceeds for an unknown model id with a valid exact provider', async () => {
    assistantMocks.getProviderByModel.mockReturnValue(exactProvider)

    const result = await fetchGenerate({ prompt: 'p', content: 'c', model: unknownModel })

    expect(result).toBe('Title')
    expect(completionsMock).toHaveBeenCalledOnce()
  })
})
