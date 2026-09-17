import type * as ExactProviderResolverModule from '@renderer/services/exactProviderResolver'
import { resolveExactProvider } from '@renderer/services/exactProviderResolver'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const providerMock = vi.mocked(resolveExactProvider)

vi.mock('@renderer/services/exactProviderResolver', () => ({
  resolveExactProvider: vi.fn(),
  setExactProviderResolver: vi.fn()
}))

const isEmbeddingModel = vi.hoisted(() => vi.fn())
const isRerankModel = vi.hoisted(() => vi.fn())
vi.mock('../embedding', () => ({
  isEmbeddingModel: (...args: any[]) => isEmbeddingModel(...args),
  isRerankModel: (...args: any[]) => isRerankModel(...args)
}))

const isPureGenerateImageModel = vi.hoisted(() => vi.fn())
const isTextToImageModel = vi.hoisted(() => vi.fn())
const isGenerateImageModel = vi.hoisted(() => vi.fn())
vi.mock('../vision', () => ({
  isPureGenerateImageModel: (...args: any[]) => isPureGenerateImageModel(...args),
  isTextToImageModel: (...args: any[]) => isTextToImageModel(...args),
  isGenerateImageModel: (...args: any[]) => isGenerateImageModel(...args),
  isModernGenerateImageModel: vi.fn()
}))

const providerMocks = vi.hoisted(() => ({
  isGeminiProvider: vi.fn(),
  isNewApiProvider: vi.fn(),
  isOpenAICompatibleProvider: vi.fn(),
  isOpenAIProvider: vi.fn(),
  isVertexProvider: vi.fn(),
  isAwsBedrockProvider: vi.fn(),
  isAzureOpenAIProvider: vi.fn()
}))

vi.mock('@renderer/utils/provider', () => providerMocks)

vi.mock('@renderer/hooks/useStore', () => ({
  getStoreProviders: vi.fn(() => [])
}))

vi.mock('@renderer/store', () => ({
  __esModule: true,
  default: {
    getState: () => ({
      llm: { providers: [] },
      settings: {}
    })
  },
  useAppDispatch: vi.fn(),
  useAppSelector: vi.fn()
}))

vi.mock('@renderer/store/settings', () => {
  const noop = vi.fn()
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'initialState') {
          return {}
        }
        return noop
      }
    }
  )
})

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: vi.fn(() => ({})),
  useNavbarPosition: vi.fn(() => ({ navbarPosition: 'left' })),
  useMessageStyle: vi.fn(() => ({ isBubbleStyle: false })),
  getStoreSetting: vi.fn()
}))

import type { Model, Provider } from '@renderer/types'
import { SystemProviderIds } from '@renderer/types'

import { isOpenAIDeepResearchModel } from '../openai'
import {
  GEMINI_SEARCH_REGEX,
  isHunyuanSearchModel,
  isMandatoryWebSearchModel,
  isOpenAIWebSearchChatCompletionOnlyModel,
  isOpenAIWebSearchModel,
  isOpenRouterBuiltInWebSearchModel,
  isWebSearchModel
} from '../websearch'

const createModel = (overrides: Partial<Model> = {}): Model => ({
  id: 'gpt-4o',
  name: 'gpt-4o',
  provider: 'openai',
  group: 'OpenAI',
  ...overrides
})

const createProvider = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'openai',
  type: 'openai',
  name: 'OpenAI',
  apiKey: '',
  apiHost: '',
  models: [],
  ...overrides
})

const resetMocks = () => {
  providerMock.mockReturnValue(createProvider())
  isEmbeddingModel.mockReturnValue(false)
  isRerankModel.mockReturnValue(false)
  isPureGenerateImageModel.mockReturnValue(false)
  isTextToImageModel.mockReturnValue(false)
  providerMocks.isGeminiProvider.mockReturnValue(false)
  providerMocks.isNewApiProvider.mockReturnValue(false)
  providerMocks.isOpenAICompatibleProvider.mockReturnValue(false)
  providerMocks.isOpenAIProvider.mockReturnValue(false)
}

describe('websearch helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMocks()
  })

  describe('isOpenAIDeepResearchModel', () => {
    it('detects deep research ids by model id only (no provider gate)', () => {
      expect(isOpenAIDeepResearchModel(createModel({ id: 'openai/deep-research-preview' }))).toBe(true)
      expect(isOpenAIDeepResearchModel(createModel({ provider: 'openai', id: 'gpt-4o' }))).toBe(false)
      // Debranded: same model id on any connection yields the same result.
      expect(isOpenAIDeepResearchModel(createModel({ provider: 'openrouter', id: 'deep-research' }))).toBe(true)
      expect(isOpenAIDeepResearchModel(createModel({ provider: 'custom-x', id: 'deep-research' }))).toBe(true)
    })
  })

  describe('isWebSearchModel', () => {
    it('returns false for embedding/rerank/image models', () => {
      isEmbeddingModel.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel())).toBe(false)

      resetMocks()
      isRerankModel.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel())).toBe(false)

      resetMocks()
      isTextToImageModel.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel())).toBe(false)
    })

    it('honors user overrides', () => {
      const enabled = createModel({ capabilities: [{ type: 'web_search', isUserSelected: true }] })
      expect(isWebSearchModel(enabled)).toBe(true)

      const disabled = createModel({ capabilities: [{ type: 'web_search', isUserSelected: false }] })
      expect(isWebSearchModel(disabled)).toBe(false)
    })

    it('returns false when provider lookup fails', () => {
      providerMock.mockReturnValueOnce(null)
      expect(isWebSearchModel(createModel())).toBe(false)
    })

    it('uses exact provider only: mismatch, unregistered, and throw degrade to unknown', async () => {
      const actual = await vi.importActual<typeof ExactProviderResolverModule>(
        '@renderer/services/exactProviderResolver'
      )
      providerMock.mockImplementation((model) => actual.resolveExactProvider(model))
      try {
        actual.setExactProviderResolver(() => ({ id: 'other', type: 'openai' }) as unknown as Provider)
        // Sloppy resolver result (different id) is rejected -> unknown -> false.
        expect(isWebSearchModel(createModel({ id: 'sonar-pro', provider: 'perplexity' }))).toBe(false)
        expect(isMandatoryWebSearchModel(createModel({ id: 'sonar-pro', provider: 'perplexity' }))).toBe(false)
        actual.setExactProviderResolver(null)
        expect(isWebSearchModel(createModel({ id: 'sonar-pro', provider: 'perplexity' }))).toBe(false)
        actual.setExactProviderResolver(() => {
          throw new Error('store down')
        })
        expect(isWebSearchModel(createModel({ id: 'sonar-pro', provider: 'perplexity' }))).toBe(false)
        expect(isOpenRouterBuiltInWebSearchModel(createModel({ id: 'sonar-pro', provider: 'perplexity' }))).toBe(false)
      } finally {
        actual.setExactProviderResolver(null)
        providerMock.mockReset()
        providerMock.mockReturnValue(createProvider())
      }
    })

    it('handles Anthropic providers on unsupported platforms', () => {
      providerMock.mockReturnValueOnce(createProvider({ id: SystemProviderIds['aws-bedrock'] }))
      const model = createModel({ id: 'claude-2-sonnet' })
      expect(isWebSearchModel(model)).toBe(false)
    })

    it('returns true for first-party Anthropic provider', () => {
      providerMock.mockReturnValueOnce(createProvider({ id: 'anthropic' }))
      const model = createModel({ id: 'claude-3.5-sonnet-latest', provider: 'anthropic' })
      expect(isWebSearchModel(model)).toBe(true)
    })

    it('detects OpenAI preview search models only when supported', () => {
      providerMocks.isOpenAIProvider.mockReturnValue(true)
      const model = createModel({ id: 'gpt-4o-search-preview' })
      expect(isWebSearchModel(model)).toBe(true)

      const nonSearch = createModel({ id: 'gpt-4o-image' })
      expect(isWebSearchModel(nonSearch)).toBe(false)
    })

    it('supports sonar families by model id on non-generic connections (no brand gate)', () => {
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-a' }))
      expect(isWebSearchModel(createModel({ id: 'sonar-deep-research' }))).toBe(true)
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-b' }))
      expect(isWebSearchModel(createModel({ id: 'sonar-pro' }))).toBe(true)
    })

    it('excludes sonar families on generic connections (no safe standard emitter)', () => {
      for (const id of ['sonar-pro', 'sonar-deep-research', 'sonar-reasoning']) {
        providerMock.mockReturnValueOnce(createProvider({ id: 'custom-generic', type: 'openai' }))
        providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
        expect(isWebSearchModel(createModel({ id }))).toBe(false)
      }
    })

    it('handles only the web_search_options family on generic compatible connections', () => {
      // Gemini-search-regex ids have no generic emitter: false on generic.
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-a', type: 'openai' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel({ id: 'gemini-2.5-pro-preview' }))).toBe(false)

      // Chat-completion-only family keeps the standard web_search_options emitter.
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-b', type: 'openai' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      const openaiSearch = createModel({ id: 'gpt-4o-search-preview' })
      expect(isWebSearchModel(openaiSearch)).toBe(true)

      // Broad OpenAI-search ids (gpt-4o/o3/gpt-5) have no generic emitter.
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-c', type: 'openai' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel({ id: 'gpt-4o' }))).toBe(false)

      // qwen/hunyuan vendor-private families have no generic emitter.
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-d', type: 'openai' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel({ id: 'qwen-max-latest' }))).toBe(false)
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-e', type: 'openai' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel({ id: 'hunyuan-pro' }))).toBe(false)
    })

    it('supports OpenAI-compatible or folded new-api providers only for the web_search_options family', () => {
      const model = createModel({ id: 'gemini-2.5-flash-lite-latest' })
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      expect(isWebSearchModel(model)).toBe(false)

      resetMocks()
      // Slice 3: folded new-api entries are generic `openai` protocol, so the
      // retired isNewApiProvider branch is gone — coverage routes through the
      // OpenAI-compatible branch instead of the retired helper.
      providerMock.mockReturnValueOnce(createProvider({ id: 'new-api', type: 'openai' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel({ id: 'gpt-4o-search-preview' }))).toBe(true)
    })

    it('honors explicit user web_search override on generic connections', () => {
      // User override returns before provider lookup: no provider mocks
      // needed (setting Once mocks here would leak into later tests).
      const enabled = createModel({
        id: 'sonar-pro',
        capabilities: [{ type: 'web_search', isUserSelected: true }]
      })
      expect(isWebSearchModel(enabled)).toBe(true)
    })

    it('falls back to Gemini/Vertex provider regex matching', () => {
      providerMock.mockReturnValueOnce(createProvider({ id: SystemProviderIds.vertexai }))
      providerMocks.isGeminiProvider.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel({ id: 'gemini-2.0-flash-latest' }))).toBe(true)
    })

    it('evaluates hunyuan/qwen model-id families on non-generic connections (no brand gate)', () => {
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-a' }))
      expect(isWebSearchModel(createModel({ id: 'hunyuan-pro' }))).toBe(true)
      expect(isWebSearchModel(createModel({ id: 'hunyuan-lite', provider: 'hunyuan' }))).toBe(false)

      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-b' }))
      expect(isWebSearchModel(createModel({ id: 'qwen-max-latest' }))).toBe(true)

      // Former openrouter brand fallback removed: generic models without a
      // search-capable model id are not searchable.
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-c' }))
      expect(isWebSearchModel(createModel())).toBe(false)

      // Former grok brand fallback removed: grok-2 has no generic search heuristic.
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-d', type: 'openai-response' }))
      providerMocks.isOpenAIProvider.mockReturnValueOnce(true)
      expect(isWebSearchModel(createModel({ id: 'grok-2' }))).toBe(false)

      // zhipu/glm ids have no built-in search heuristic.
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-e' }))
      expect(isWebSearchModel(createModel({ id: 'glm-4-air' }))).toBe(false)
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-e' }))
      expect(isWebSearchModel(createModel({ id: 'glm-5' }))).toBe(false)
    })

    it('proves no brand-id behavioral difference for websearch capability', () => {
      const ids = ['perplexity', 'openrouter', 'aihubmix', 'hunyuan', 'dashscope', 'custom-x']
      for (const modelId of ['sonar-pro', 'qwen-max-latest', 'gpt-4o', 'glm-5']) {
        const results = ids.map((pid) => {
          providerMock.mockReturnValueOnce(createProvider({ id: pid }))
          // Reset protocol mocks to default false for a level field.
          providerMocks.isOpenAIProvider.mockReturnValue(false)
          providerMocks.isOpenAICompatibleProvider.mockReturnValue(false)
          providerMocks.isGeminiProvider.mockReturnValue(false)
          return isWebSearchModel(createModel({ id: modelId }))
        })
        expect(new Set(results).size).toBe(1)
      }
    })
  })

  describe('isMandatoryWebSearchModel', () => {
    it('requires sonar ids by model id on non-generic connections (no brand gate)', () => {
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-a' }))
      expect(isMandatoryWebSearchModel(createModel({ id: 'sonar-pro' }))).toBe(true)

      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-b' }))
      expect(isMandatoryWebSearchModel(createModel({ id: 'sonar-reasoning' }))).toBe(true)

      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-c' }))
      expect(isMandatoryWebSearchModel(createModel({ id: 'gpt-4o-search-preview' }))).toBe(false)
    })

    it('never forces mandatory built-in on generic connections (no safe emitter)', () => {
      for (const id of ['sonar-pro', 'sonar-reasoning', 'sonar-deep-research']) {
        providerMock.mockReturnValueOnce(createProvider({ id: 'custom-generic', type: 'openai' }))
        providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
        expect(isMandatoryWebSearchModel(createModel({ id }))).toBe(false)
      }
    })

    it.each([
      ['custom-a', 'non-sonar'],
      ['custom-b', 'gpt-4o-search-preview']
    ])('returns false for %s connection when id is %s', (providerId, modelId) => {
      providerMock.mockReturnValueOnce(createProvider({ id: providerId }))
      expect(isMandatoryWebSearchModel(createModel({ id: modelId }))).toBe(false)
    })
  })

  describe('isOpenRouterBuiltInWebSearchModel', () => {
    it('checks for sonar ids or OpenAI chat-completion-only variants by model id', () => {
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-a' }))
      expect(isOpenRouterBuiltInWebSearchModel(createModel({ id: 'sonar-reasoning' }))).toBe(true)

      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-b' }))
      expect(isOpenRouterBuiltInWebSearchModel(createModel({ id: 'gpt-4o-search-preview' }))).toBe(true)

      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-c' }))
      expect(isOpenRouterBuiltInWebSearchModel(createModel({ id: 'gpt-4o' }))).toBe(false)
    })

    it('allows only the web_search_options family on generic connections', () => {
      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-generic', type: 'openai' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      expect(isOpenRouterBuiltInWebSearchModel(createModel({ id: 'gpt-4o-search-preview' }))).toBe(true)

      providerMock.mockReturnValueOnce(createProvider({ id: 'custom-generic', type: 'openai' }))
      providerMocks.isOpenAICompatibleProvider.mockReturnValueOnce(true)
      expect(isOpenRouterBuiltInWebSearchModel(createModel({ id: 'sonar-pro' }))).toBe(false)
    })
  })

  describe('OpenAI web search helpers', () => {
    it('detects chat completion only variants and openai search ids', () => {
      expect(isOpenAIWebSearchChatCompletionOnlyModel(createModel({ id: 'gpt-4o-search-preview' }))).toBe(true)
      expect(isOpenAIWebSearchChatCompletionOnlyModel(createModel({ id: 'gpt-4o-mini-search-preview' }))).toBe(true)
      expect(isOpenAIWebSearchChatCompletionOnlyModel(createModel({ id: 'gpt-4o' }))).toBe(false)

      expect(isOpenAIWebSearchModel(createModel({ id: 'gpt-4.1-turbo' }))).toBe(true)
      expect(isOpenAIWebSearchModel(createModel({ id: 'gpt-4o-image' }))).toBe(false)
      expect(isOpenAIWebSearchModel(createModel({ id: 'gpt-5.1-chat' }))).toBe(false)
      expect(isOpenAIWebSearchModel(createModel({ id: 'o3-mini' }))).toBe(true)
    })

    it.each(['gpt-4.1-preview', 'gpt-4o-2024-05-13', 'o4-mini', 'gpt-5-explorer'])(
      'treats %s as an OpenAI web search model',
      (id) => {
        expect(isOpenAIWebSearchModel(createModel({ id }))).toBe(true)
      }
    )

    it.each(['gpt-4o-image-preview', 'gpt-4.1-nano', 'gpt-5.1-chat', 'gpt-image-1'])(
      'excludes %s from OpenAI web search',
      (id) => {
        expect(isOpenAIWebSearchModel(createModel({ id }))).toBe(false)
      }
    )

    it.each(['gpt-4o-search-preview', 'gpt-4o-mini-search-preview'])('flags %s as chat-completion-only', (id) => {
      expect(isOpenAIWebSearchChatCompletionOnlyModel(createModel({ id }))).toBe(true)
    })
  })

  describe('isHunyuanSearchModel', () => {
    it('identifies hunyuan model ids except lite (no provider gate)', () => {
      expect(isHunyuanSearchModel(createModel({ id: 'hunyuan-pro', provider: 'custom-a' }))).toBe(true)
      expect(isHunyuanSearchModel(createModel({ id: 'hunyuan-lite', provider: 'custom-a' }))).toBe(false)
      expect(isHunyuanSearchModel(createModel())).toBe(false)
    })

    it.each(['hunyuan-standard', 'hunyuan-advanced'])('accepts %s', (suffix) => {
      expect(isHunyuanSearchModel(createModel({ id: suffix, provider: 'custom-a' }))).toBe(true)
    })
  })

  describe('model-id family coverage (no brand gates)', () => {
    it.each(['qwen-turbo', 'qwen-max-0919', 'qwen3-max', 'qwen-plus-2024', 'qwq-32b'])(
      'treats %s as searchable on non-generic connections',
      (id) => {
        providerMock.mockReturnValue(createProvider({ id: 'custom-a' }))
        expect(isWebSearchModel(createModel({ id }))).toBe(true)
      }
    )

    it.each(['qwen-1.5-chat', 'custom-model'])('ignores %s', (id) => {
      providerMock.mockReturnValue(createProvider({ id: 'custom-a' }))
      expect(isWebSearchModel(createModel({ id }))).toBe(false)
    })

    it.each(['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'])(
      'supports sonar model id %s on non-generic connections',
      (id) => {
        providerMock.mockReturnValue(createProvider({ id: 'custom-a' }))
        expect(isWebSearchModel(createModel({ id }))).toBe(true)
      }
    )

    it.each([
      'gemini-2.0-flash-latest',
      'gemini-2.5-flash-lite-latest',
      'gemini-flash-lite-latest',
      'gemini-pro-latest'
    ])('Gemini provider supports %s', (id) => {
      providerMock.mockReturnValue(createProvider({ id: SystemProviderIds.vertexai }))
      providerMocks.isGeminiProvider.mockReturnValue(true)
      expect(isWebSearchModel(createModel({ id }))).toBe(true)
    })
  })

  describe('Gemini Search Models', () => {
    describe('GEMINI_SEARCH_REGEX', () => {
      it('should match gemini 2.x models', () => {
        expect(GEMINI_SEARCH_REGEX.test('gemini-2.0-flash')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-2.0-pro')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-2.5-flash')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-2.5-pro')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-2.5-flash-latest')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-2.5-pro-latest')).toBe(true)
      })

      it('should match gemini latest models', () => {
        expect(GEMINI_SEARCH_REGEX.test('gemini-flash-latest')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-pro-latest')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-flash-lite-latest')).toBe(true)
      })

      it('should match gemini 3 models', () => {
        // Preview versions
        expect(GEMINI_SEARCH_REGEX.test('gemini-3-pro-preview')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-3-flash-preview')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-3-pro-image-preview')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-3-flash-image-preview')).toBe(true)
        // Future stable versions
        expect(GEMINI_SEARCH_REGEX.test('gemini-3-flash')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-3-pro')).toBe(true)
        // Version with decimals
        expect(GEMINI_SEARCH_REGEX.test('gemini-3.0-flash')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-3.0-pro')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-3.5-flash-preview')).toBe(true)
        expect(GEMINI_SEARCH_REGEX.test('gemini-3.5-pro-image-preview')).toBe(true)
      })

      it('should not match gemini 2.x image-preview models', () => {
        expect(GEMINI_SEARCH_REGEX.test('gemini-2.5-flash-image-preview')).toBe(false)
        expect(GEMINI_SEARCH_REGEX.test('gemini-2.0-pro-image-preview')).toBe(false)
      })

      it('should not match older gemini models', () => {
        expect(GEMINI_SEARCH_REGEX.test('gemini-1.5-flash')).toBe(false)
        expect(GEMINI_SEARCH_REGEX.test('gemini-1.5-pro')).toBe(false)
        expect(GEMINI_SEARCH_REGEX.test('gemini-1.0-pro')).toBe(false)
      })
    })
  })
})
