import type { KnowledgeBase } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    t: (key: string) => key
  }
})

vi.mock('@renderer/services/AssistantService', () => ({
  getProviderByModel: vi.fn(),
  getDefaultTopic: vi.fn((assistantId: string) => ({ id: 'default-topic', assistantId })),
  DEFAULT_ASSISTANT_SETTINGS: {},
  getAssistantSettings: vi.fn(() => ({})),
  getDefaultModel: vi.fn(() => undefined)
}))

vi.mock('@renderer/store', () => {
  const mockGetState = vi.fn()
  return {
    default: { getState: mockGetState },
    __mockGetState: mockGetState
  }
})

import { getProviderByModel } from '@renderer/services/AssistantService'

import { getKnowledgeBaseParams, searchKnowledgeBase } from '../KnowledgeService'

const { __mockGetState: mockGetState } = vi.mocked(await import('@renderer/store')) as unknown as {
  __mockGetState: ReturnType<typeof vi.fn>
}

const mockGetProviderByModel = vi.mocked(getProviderByModel)

const embeddingProvider = {
  id: 'emb-provider',
  name: 'Emb Provider',
  type: 'openai',
  apiKey: 'emb-key',
  apiHost: 'https://emb.example.com/v1',
  models: [],
  isSystem: false
}

const rerankProvider = {
  id: 'rerank-provider',
  name: 'Rerank Provider',
  type: 'openai',
  apiKey: 'rerank-key',
  apiHost: 'https://rerank.example.com/v1',
  models: [],
  isSystem: false
}

const embeddingModel = { id: 'emb-1', name: 'emb-1', provider: 'emb-provider' }
const rerankModel = { id: 're-1', name: 're-1', provider: 'rerank-provider' }

const makeBase = (overrides: Partial<KnowledgeBase> = {}): KnowledgeBase =>
  ({
    id: 'b1',
    name: 'B1',
    model: embeddingModel,
    rerankModel,
    items: [],
    created_at: 0,
    updated_at: 0,
    version: 1,
    ...overrides
  }) as KnowledgeBase

describe('KnowledgeService explicit-unconfigured embedding model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetState.mockReturnValue({ preprocess: { providers: [] }, settings: {} })
    mockGetProviderByModel.mockImplementation(((model: { provider?: string } | undefined) => {
      if (!model) return undefined
      if (model.provider === 'emb-provider') return embeddingProvider
      if (model.provider === 'rerank-provider') return rerankProvider
      return undefined
    }) as typeof getProviderByModel)
    ;(window as any).keyv = { get: vi.fn(), set: vi.fn() }
  })

  it('getKnowledgeBaseParams throws the localized embedding-model failure when model is cleared (migration 222)', () => {
    const base = makeBase({ model: undefined })

    expect(() => getKnowledgeBaseParams(base)).toThrow('knowledge.embedding_model_required')
  })

  it('getKnowledgeBaseParams never reaches provider lookup for an unconfigured model', () => {
    const base = makeBase({ model: undefined })

    expect(() => getKnowledgeBaseParams(base)).toThrow()
    expect(mockGetProviderByModel).not.toHaveBeenCalled()
  })

  it('searchKnowledgeBase rejects with the same failure before any model/provider access', async () => {
    const base = makeBase({ model: undefined })

    await expect(searchKnowledgeBase('query', base)).rejects.toThrow('knowledge.embedding_model_required')
    expect(mockGetProviderByModel).not.toHaveBeenCalled()
  })

  it('still builds params for a configured base (regression)', () => {
    const params = getKnowledgeBaseParams(makeBase())

    expect(params.embedApiClient.model).toBe('emb-1')
    expect(params.embedApiClient.provider).toBe('emb-provider')
    expect(params.embedApiClient.baseURL).toBe('https://emb.example.com/v1')
    expect(params.rerankApiClient?.model).toBe('re-1')
  })
})
