import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/LoggerService', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getProviderByModel: vi.fn(),
  getAssistantSettings: vi.fn(),
  getDefaultAssistant: vi.fn().mockReturnValue({
    id: 'default',
    name: 'Default Assistant',
    prompt: '',
    settings: {}
  })
}))

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: vi.fn()
}))

vi.mock('@renderer/store', () => {
  const mockGetState = vi.fn()
  return {
    default: { getState: mockGetState },
    __mockGetState: mockGetState
  }
})

import type { OpenAICompatibleProviderSettings } from '@ai-sdk/openai-compatible'
import type { ProviderConfig } from '@renderer/aiCore/types'
import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Model, Provider } from '@renderer/types'

import { adaptProvider, formatProviderApiHost, getActualProvider, providerToAiSdkConfig } from '../providerConfig'

const { __mockGetState: mockGetState } = vi.mocked(await import('@renderer/store')) as unknown as {
  __mockGetState: ReturnType<typeof vi.fn>
}

// ==================== Helpers ====================

const createWindowKeyv = () => {
  const store = new Map<string, string>()
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: string) => {
      store.set(key, value)
    }
  }
}

const setupWindowMock = (options?: { withAnthropicOAuth?: boolean }) => {
  const api: { anthropic_oauth?: { getAccessToken: ReturnType<typeof vi.fn> } } = {}
  if (options?.withAnthropicOAuth) {
    api.anthropic_oauth = {
      getAccessToken: vi.fn().mockResolvedValue('mock-oauth-token')
    }
  }

  Object.defineProperty(globalThis, 'window', {
    value: { ...globalThis.window, keyv: createWindowKeyv(), api },
    writable: true,
    configurable: true
  })
}

const setupStoreMock = (overrides?: { includeUsage?: boolean }) => {
  mockGetState.mockReturnValue({
    settings: {
      openAI: {
        streamOptions: {
          includeUsage: overrides?.includeUsage
        }
      }
    }
  })
}

// ==================== Provider Factories ====================

const makeProvider = (overrides: Omit<Partial<Provider>, 'type'> & { id: string; type: string }): Provider =>
  ({
    name: overrides.id,
    apiKey: 'test-key',
    apiHost: 'https://api.example.com',
    models: [],
    isSystem: true,
    ...overrides
  }) as unknown as Provider

const makeModel = (id: string, provider: string, overrides?: Partial<Model>): Model => ({
  id,
  name: id,
  provider,
  group: provider,
  ...overrides
})

// ==================== formatProviderApiHost ====================

describe('formatProviderApiHost (slice 3: protocol-based, no brand-id selection)', () => {
  describe('Anthropic provider (special dual-field sync)', () => {
    it('syncs apiHost from anthropicApiHost when both are set', () => {
      const provider = makeProvider({
        id: 'anthropic',
        type: 'anthropic',
        apiHost: 'https://api.anthropic.com',
        anthropicApiHost: 'https://custom-anthropic.example.com'
      })

      const result = formatProviderApiHost(provider)

      expect(result.anthropicApiHost).toBe('https://custom-anthropic.example.com/v1')
      expect(result.apiHost).toBe('https://custom-anthropic.example.com/v1')
    })

    it('copies apiHost to anthropicApiHost when anthropicApiHost is not set', () => {
      const provider = makeProvider({
        id: 'anthropic',
        type: 'anthropic',
        apiHost: 'https://api.anthropic.com'
      })

      const result = formatProviderApiHost(provider)

      expect(result.apiHost).toBe('https://api.anthropic.com/v1')
      expect(result.anthropicApiHost).toBe('https://api.anthropic.com/v1')
    })
  })

  describe('Gemini provider', () => {
    it('appends v1beta instead of v1', () => {
      const provider = makeProvider({
        id: 'gemini',
        type: 'gemini',
        apiHost: 'https://generativelanguage.googleapis.com'
      })

      const result = formatProviderApiHost(provider)

      expect(result.apiHost).toBe('https://generativelanguage.googleapis.com/v1beta')
    })
  })

  describe('Generic OpenAI-compatible (no brand-id formatters)', () => {
    it.each(['groq', 'openrouter', 'deepseek', 'together', 'silicon'])(
      'brand id %s with type openai uses generic /v1 formatting',
      (brandId) => {
        const provider = makeProvider({
          id: brandId,
          type: 'openai',
          apiHost: 'https://api.example.com'
        })

        const result = formatProviderApiHost(provider)

        expect(result.apiHost).toBe('https://api.example.com/v1')
      }
    )

    it('appends /v1 for generic openai', () => {
      const provider = makeProvider({
        id: 'my-openai',
        type: 'openai',
        apiHost: 'https://api.custom.com'
      })

      expect(formatProviderApiHost(provider).apiHost).toBe('https://api.custom.com/v1')
    })

    it('does not double-append /v1', () => {
      const provider = makeProvider({
        id: 'my-openai',
        type: 'openai',
        apiHost: 'https://api.custom.com/v1'
      })

      expect(formatProviderApiHost(provider).apiHost).toBe('https://api.custom.com/v1')
    })
  })

  describe('does not mutate the original provider', () => {
    it('returns a new object', () => {
      const provider = makeProvider({
        id: 'my-openai',
        type: 'openai',
        apiHost: 'https://api.custom.com'
      })

      const result = formatProviderApiHost(provider)

      expect(result).not.toBe(provider)
      expect(provider.apiHost).toBe('https://api.custom.com')
    })
  })
})

describe('getActualProvider (exact provider-id matching, no silent fallback)', () => {
  it('retrieves provider by model and formats its apiHost', () => {
    const provider = makeProvider({
      id: 'openai',
      type: 'openai',
      apiHost: 'https://api.openai.com'
    })
    vi.mocked(getProviderByModel).mockReturnValue(provider)

    const result = getActualProvider(makeModel('gpt-4', 'openai'))

    expect(result.apiHost).toBe('https://api.openai.com/v1')
    expect(provider.apiHost).toBe('https://api.openai.com')
  })

  it('resolves an unknown manually added model id without catalog/metadata', () => {
    const provider = makeProvider({
      id: 'my-openai',
      type: 'openai',
      apiHost: 'https://my.example.com'
    })
    vi.mocked(getProviderByModel).mockReturnValue(provider)

    const result = getActualProvider(makeModel('my-renamed-unknown-1', 'my-openai'))

    expect(result.id).toBe('my-openai')
    expect(result.apiHost).toBe('https://my.example.com/v1')
  })

  it('rejects a stale provider instead of silently substituting another provider (no network)', () => {
    const other = makeProvider({ id: 'other', type: 'openai', apiHost: 'https://other.example.com' })
    vi.mocked(getProviderByModel).mockReturnValue(other)

    // Throws before any provider/API invocation — no network occurs.
    expect(() => getActualProvider(makeModel('gpt-4', 'openai'))).toThrow()
  })
})

describe('adaptProvider', () => {
  it('deep clones and formats the provider generically', () => {
    const provider = makeProvider({
      id: 'perplexity',
      type: 'openai',
      apiHost: 'https://api.perplexity.ai'
    })

    const result = adaptProvider({ provider })

    // Brand ids with type openai use generic formatting (no brand-specific exemption).
    expect(result.apiHost).toBe('https://api.perplexity.ai/v1')
    expect(result).not.toBe(provider)
  })
})

// ==================== providerToAiSdkConfig ====================

describe('providerToAiSdkConfig (slice 3: protocol-based, no brand builders)', () => {
  beforeEach(() => {
    setupWindowMock({ withAnthropicOAuth: true })
    setupStoreMock()
    vi.clearAllMocks()
  })

  describe('Anthropic OAuth builder (approved, type-based)', () => {
    it('uses OAuth token for anthropic type with oauth mode', async () => {
      const provider = makeProvider({
        id: 'my-anthropic',
        type: 'anthropic',
        apiHost: 'https://api.anthropic.com',
        authType: 'oauth'
      })

      const config = await providerToAiSdkConfig(provider, makeModel('claude-sonnet-4-5', provider.id))

      expect(config.providerId).toBe('anthropic')
    })
  })

  describe('OpenAI-compatible fallback (generic, brand-neutral)', () => {
    it('includes includeUsage when provider supports stream options', async () => {
      setupStoreMock({ includeUsage: true })

      const provider = makeProvider({
        id: 'some-openai-compat',
        type: 'openai',
        apiHost: 'https://api.custom.com/v1'
      })

      const config = (await providerToAiSdkConfig(
        provider,
        makeModel('gpt-4', provider.id)
      )) as ProviderConfig<'openai-compatible'>

      expect(config.providerId).toBe('openai-compatible')
      expect(config.providerSettings.includeUsage).toBe(true)
    })

    it('builds basic openai-compatible config for an unknown manually added model id', async () => {
      const provider = makeProvider({
        id: 'my-openai',
        type: 'openai',
        apiHost: 'https://my.example.com/v1'
      })

      const config = (await providerToAiSdkConfig(
        provider,
        makeModel('my-renamed-unknown-1', provider.id)
      )) as ProviderConfig<'openai-compatible'>

      expect(config.providerId).toBe('openai-compatible')
      expect(config.providerSettings.baseURL).toBe('https://my.example.com/v1')
    })

    it.each(['groq', 'openrouter', 'deepseek'])(
      'brand id %s with type openai uses generic OpenAI-compatible (no brand SDK)',
      async (brandId) => {
        const provider = makeProvider({
          id: brandId,
          type: 'openai',
          apiHost: `https://${brandId}.example.com/v1`
        })

        const config = await providerToAiSdkConfig(provider, makeModel('some-model', provider.id))

        expect(config.providerId).toBe('openai-compatible')
      }
    )

    it('merges extra_headers from provider', async () => {
      const provider = makeProvider({
        id: 'some-openai-compat',
        type: 'openai',
        apiHost: 'https://api.custom.com/v1',
        extra_headers: { 'X-Custom': 'custom-value' }
      })

      const config = (await providerToAiSdkConfig(
        provider,
        makeModel('gpt-4', provider.id)
      )) as ProviderConfig<'openai-compatible'>

      const settings = config.providerSettings
      expect(settings.headers).toBeDefined()
      expect(settings.headers!['X-Custom']).toBe('custom-value')
    })

    it('adds X-Api-Key header for openai-response (approved Responses)', async () => {
      const provider = makeProvider({
        id: 'openai',
        type: 'openai-response',
        apiHost: 'https://api.openai.com/v1',
        apiKey: 'sk-test'
      })

      const config = await providerToAiSdkConfig(provider, makeModel('gpt-4', provider.id))

      const settings = config.providerSettings as OpenAICompatibleProviderSettings
      expect(settings.headers).toBeDefined()
      expect(settings.headers!['X-Api-Key']).toBe('sk-test')
    })
  })

  describe('endpoint extraction', () => {
    it('extracts endpoint from trailing sharp URLs', async () => {
      const provider = makeProvider({
        id: 'some-openai-compat',
        type: 'openai',
        apiHost: 'https://api.custom.com/chat/completions#'
      })

      const config = await providerToAiSdkConfig(provider, makeModel('gpt-4', provider.id))

      expect(config.endpoint).toBe('chat/completions')
    })

    it('returns empty endpoint for normal URLs', async () => {
      const provider = makeProvider({
        id: 'some-openai-compat',
        type: 'openai',
        apiHost: 'https://api.custom.com/v1'
      })

      const config = await providerToAiSdkConfig(provider, makeModel('gpt-4', provider.id))

      expect(config.endpoint).toBe('')
    })
  })
})
