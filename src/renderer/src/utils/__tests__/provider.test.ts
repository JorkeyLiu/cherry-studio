import { type Provider } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import {
  getAnthropicSupportedProviders,
  getClaudeSupportedProviders,
  isAnthropicProvider,
  isAnthropicSupportedProvider,
  isAzureOpenAIProvider,
  isGeminiProvider,
  isGeminiWebSearchProvider,
  isOpenAICompatibleProvider,
  isOpenAIProvider,
  isSupportArrayContentProvider,
  isSupportDeveloperRoleProvider,
  isSupportEnableThinkingProvider,
  isSupportServiceTierProvider,
  isSupportStreamOptionsProvider,
  isSupportUrlContextProvider,
  isSupportVerbosityProvider
} from '../provider'

vi.mock('@renderer/store/settings', () => ({
  default: (state = { settings: {} }) => state
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

const createProvider = (overrides: Omit<Partial<Provider>, 'type'> & { type?: string } = {}): Provider =>
  ({
    id: 'custom',
    type: 'openai',
    name: 'Custom Provider',
    apiKey: 'key',
    apiHost: 'https://api.example.com',
    models: [],
    ...overrides
  }) as unknown as Provider

describe('provider utils (debranded: apiOptions/type semantics only)', () => {
  it('treats every connection as an ordinary connection (no built-in brand lists)', () => {
    // Anthropic support follows protocol + stored host only: a plain
    // openai-type entry without an Anthropic host is not Claude-capable,
    // even when its id matches a historical brand.
    expect(isAnthropicSupportedProvider(createProvider({ id: 'deepseek' }))).toBe(false)
    expect(getClaudeSupportedProviders([createProvider({ id: 'stepfun' })])).toHaveLength(0)
    // An explicit stored Anthropic host opts the same connection in.
    expect(
      isAnthropicSupportedProvider(createProvider({ id: 'stepfun', anthropicApiHost: 'https://anthropic.local' }))
    ).toBe(true)
  })

  it('filters Claude supported providers by protocol and stored host only', () => {
    const providers = [
      createProvider({ id: 'anthropic-official', type: 'anthropic' }),
      createProvider({ id: 'custom-host', anthropicApiHost: 'https://anthropic.local' }),
      createProvider({ id: 'aihubmix' }),
      createProvider({ id: 'other' })
    ]

    // Historical brand ids without an Anthropic protocol/host are excluded.
    expect(getClaudeSupportedProviders(providers)).toEqual(providers.slice(0, 2))
  })

  it('filters Anthropic supported providers', () => {
    const providers = [
      createProvider({ id: 'anthropic-official', type: 'anthropic' }),
      createProvider({ id: 'custom-host', anthropicApiHost: 'https://anthropic.local' }),
      createProvider({ id: 'aihubmix' }),
      createProvider({ id: 'other' })
    ]

    expect(getAnthropicSupportedProviders(providers)).toEqual(providers.slice(0, 2))
  })

  it('checks Anthropic supported provider', () => {
    expect(isAnthropicSupportedProvider(createProvider({ id: 'anthropic-official', type: 'anthropic' }))).toBe(true)
    expect(
      isAnthropicSupportedProvider(createProvider({ id: 'custom-host', anthropicApiHost: 'https://anthropic.local' }))
    ).toBe(true)
    expect(isAnthropicSupportedProvider(createProvider({ id: 'aihubmix' }))).toBe(false)
    expect(isAnthropicSupportedProvider(createProvider({ id: 'other' }))).toBe(false)
  })

  it('evaluates message array content support as pure opt-out', () => {
    expect(isSupportArrayContentProvider(createProvider())).toBe(true)
    expect(isSupportArrayContentProvider(createProvider({ apiOptions: { isNotSupportArrayContent: true } }))).toBe(
      false
    )
    // Former brand denylist (deepseek/baichuan/minimax/...) removed: same
    // options with different ids yield the same result.
    expect(isSupportArrayContentProvider(createProvider({ id: 'deepseek' }))).toBe(true)
    expect(isSupportArrayContentProvider(createProvider({ id: 'deepseek' }))).toBe(
      isSupportArrayContentProvider(createProvider({ id: 'unbranded-custom' }))
    )
  })

  it('evaluates developer role support as pure opt-in', () => {
    expect(isSupportDeveloperRoleProvider(createProvider({ apiOptions: { isSupportDeveloperRole: true } }))).toBe(true)
    // No implicit brand allowlist: unset defaults to false for every id.
    expect(isSupportDeveloperRoleProvider(createProvider())).toBe(false)
    expect(isSupportDeveloperRoleProvider(createProvider({ id: 'openai', isSystem: true } as any))).toBe(false)
    expect(isSupportDeveloperRoleProvider(createProvider({ id: 'poe', isSystem: true } as any))).toBe(false)
  })

  it('checks stream options support as pure opt-out', () => {
    expect(isSupportStreamOptionsProvider(createProvider())).toBe(true)
    expect(isSupportStreamOptionsProvider(createProvider({ apiOptions: { isNotSupportStreamOptions: true } }))).toBe(
      false
    )
    // Former mistral brand exclusion removed.
    expect(isSupportStreamOptionsProvider(createProvider({ id: 'mistral', isSystem: true } as any))).toBe(true)
  })

  it('checks enable thinking support as pure opt-out', () => {
    expect(isSupportEnableThinkingProvider(createProvider())).toBe(true)
    expect(isSupportEnableThinkingProvider(createProvider({ apiOptions: { isNotSupportEnableThinking: true } }))).toBe(
      false
    )
    // Former ollama/lmstudio/nvidia/gpustack brand exclusions removed.
    expect(isSupportEnableThinkingProvider(createProvider({ id: 'nvidia', isSystem: true } as any))).toBe(true)
  })

  it('determines service tier support as pure opt-in', () => {
    expect(isSupportServiceTierProvider(createProvider({ apiOptions: { isSupportServiceTier: true } }))).toBe(true)
    // No implicit brand allowlist: unset defaults to false for every id,
    // including historical openai/groq brands.
    expect(isSupportServiceTierProvider(createProvider())).toBe(false)
    expect(isSupportServiceTierProvider(createProvider({ id: 'openai', isSystem: true } as any))).toBe(false)
    expect(isSupportServiceTierProvider(createProvider({ id: 'groq', isSystem: true } as any))).toBe(false)
    expect(isSupportServiceTierProvider(createProvider({ id: 'github', isSystem: true } as any))).toBe(false)
  })

  it('determines verbosity support as pure opt-out', () => {
    // Custom providers with explicit flag
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: { isNotSupportVerbosity: false } }))).toBe(true)
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: { isNotSupportVerbosity: true } }))).toBe(false)

    // Providers without apiOptions support by default, regardless of brand.
    expect(isSupportVerbosityProvider(createProvider())).toBe(true)
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: {} }))).toBe(true)
    expect(isSupportVerbosityProvider(createProvider({ id: 'openai', isSystem: true } as any))).toBe(true)
    // Former groq brand exclusion removed: opt-out option decides.
    expect(isSupportVerbosityProvider(createProvider({ id: 'groq', isSystem: true } as any))).toBe(true)

    // apiOptions can disable verbosity for any provider
    expect(
      isSupportVerbosityProvider(createProvider({ id: 'openai', apiOptions: { isNotSupportVerbosity: true } }))
    ).toBe(false)
  })

  it('proves no brand-id behavioral difference across helpers', () => {
    const ids = ['openai', 'groq', 'deepseek', 'mistral', 'poe', 'nvidia', 'unbranded-custom']
    const opts = { apiOptions: { isSupportServiceTier: true } } as Partial<Provider>
    const results = ids.map((id) => isSupportServiceTierProvider(createProvider({ ...opts, id })))
    expect(new Set(results).size).toBe(1)
  })

  it('detects URL context capable providers', () => {
    expect(isSupportUrlContextProvider(createProvider({ type: 'gemini' }))).toBe(true)
    expect(isSupportUrlContextProvider(createProvider())).toBe(false)
  })

  it('identifies Gemini web search providers by protocol only', () => {
    expect(isGeminiWebSearchProvider(createProvider({ id: 'anything', type: 'gemini' }))).toBe(true)
    expect(isGeminiWebSearchProvider(createProvider({ id: 'gemini', type: 'openai' }))).toBe(false)
    expect(isGeminiWebSearchProvider(createProvider())).toBe(false)
  })

  it('recognizes OpenAI compatible providers (generic openai only)', () => {
    expect(isOpenAICompatibleProvider(createProvider({ type: 'openai' }))).toBe(true)
    // Retired foldable types no longer count as active compatible (folded to openai by 222).
    expect(isOpenAICompatibleProvider(createProvider({ type: 'new-api' }))).toBe(false)
    expect(isOpenAICompatibleProvider(createProvider({ type: 'mistral' }))).toBe(false)
    expect(isOpenAICompatibleProvider(createProvider({ type: 'anthropic' }))).toBe(false)
  })

  it('narrows Azure OpenAI providers (history-only legacy check)', () => {
    const azureProvider = {
      ...createProvider({ type: 'azure-openai' }),
      apiVersion: '2024-06-01'
    } as unknown as Provider
    expect(isAzureOpenAIProvider(azureProvider)).toBe(true)
    expect(isAzureOpenAIProvider(createProvider())).toBe(false)
  })

  it('checks provider type helpers', () => {
    expect(isOpenAIProvider(createProvider({ type: 'openai-response' }))).toBe(true)
    expect(isOpenAIProvider(createProvider())).toBe(false)

    expect(isAnthropicProvider(createProvider({ type: 'anthropic' }))).toBe(true)
    expect(isGeminiProvider(createProvider({ type: 'gemini' }))).toBe(true)
  })

  describe('ProviderType schema (active protocols only)', () => {
    it('accepts exactly the four approved protocols', async () => {
      const { ACTIVE_PROVIDER_TYPES, isActiveProviderType, ProviderTypeSchema } = await import(
        '@renderer/types/provider'
      )

      expect([...ACTIVE_PROVIDER_TYPES].sort()).toEqual(['anthropic', 'gemini', 'openai', 'openai-response'])
      for (const type of ['openai', 'openai-response', 'anthropic', 'gemini']) {
        expect(ProviderTypeSchema.safeParse(type).success).toBe(true)
        expect(isActiveProviderType(type)).toBe(true)
      }
    })

    it('rejects every retired foldable and removed protocol', async () => {
      const { isActiveProviderType, ProviderTypeSchema } = await import('@renderer/types/provider')

      for (const type of [
        'ollama',
        'new-api',
        'mistral',
        'azure-openai',
        'vertexai',
        'vertex-anthropic',
        'aws-bedrock',
        'gateway',
        'copilot',
        'some-future-protocol',
        ''
      ]) {
        expect(ProviderTypeSchema.safeParse(type).success).toBe(false)
        expect(isActiveProviderType(type)).toBe(false)
      }
    })
  })
})
