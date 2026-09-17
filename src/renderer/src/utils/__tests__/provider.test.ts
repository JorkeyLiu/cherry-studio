import { type Provider, SystemProviderIds } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import {
  getAnthropicSupportedProviders,
  getClaudeSupportedProviders,
  isAIGatewayProvider,
  isAnthropicProvider,
  isAnthropicSupportedProvider,
  isAzureOpenAIProvider,
  isGeminiProvider,
  isGeminiWebSearchProvider,
  isNewApiProvider,
  isOpenAICompatibleProvider,
  isOpenAIProvider,
  isPerplexityProvider,
  isSupportAPIVersionProvider,
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

const createSystemProvider = (overrides: Omit<Partial<Provider>, 'type'> & { type?: string } = {}): Provider =>
  createProvider({
    id: SystemProviderIds.openai,
    isSystem: true,
    ...overrides
  })

describe('provider utils', () => {
  it('treats every connection as an ordinary connection (no built-in brand lists)', () => {
    // Anthropic support follows protocol + stored host only: a plain
    // openai-type entry without an Anthropic host is not Claude-capable,
    // even when its id matches a historical brand.
    expect(isAnthropicSupportedProvider(createSystemProvider({ id: SystemProviderIds.stepfun }))).toBe(false)
    expect(getClaudeSupportedProviders([createSystemProvider({ id: SystemProviderIds.stepfun })])).toHaveLength(0)
    // An explicit stored Anthropic host opts the same connection in.
    expect(
      isAnthropicSupportedProvider(
        createSystemProvider({ id: SystemProviderIds.stepfun, anthropicApiHost: 'https://anthropic.local' })
      )
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

  it('evaluates message array content support', () => {
    expect(isSupportArrayContentProvider(createProvider())).toBe(true)

    expect(isSupportArrayContentProvider(createProvider({ apiOptions: { isNotSupportArrayContent: true } }))).toBe(
      false
    )

    expect(isSupportArrayContentProvider(createSystemProvider({ id: SystemProviderIds.deepseek }))).toBe(false)
  })

  it('evaluates developer role support', () => {
    expect(isSupportDeveloperRoleProvider(createProvider({ apiOptions: { isSupportDeveloperRole: true } }))).toBe(true)
    expect(isSupportDeveloperRoleProvider(createSystemProvider())).toBe(true)
    expect(isSupportDeveloperRoleProvider(createSystemProvider({ id: SystemProviderIds.poe }))).toBe(false)
  })

  it('checks stream options support', () => {
    expect(isSupportStreamOptionsProvider(createProvider())).toBe(true)
    expect(isSupportStreamOptionsProvider(createProvider({ apiOptions: { isNotSupportStreamOptions: true } }))).toBe(
      false
    )
    expect(isSupportStreamOptionsProvider(createSystemProvider({ id: SystemProviderIds.mistral }))).toBe(false)
  })

  it('checks enable thinking support', () => {
    expect(isSupportEnableThinkingProvider(createProvider())).toBe(true)
    expect(isSupportEnableThinkingProvider(createProvider({ apiOptions: { isNotSupportEnableThinking: true } }))).toBe(
      false
    )
    expect(isSupportEnableThinkingProvider(createSystemProvider({ id: SystemProviderIds.nvidia }))).toBe(false)
  })

  it('determines service tier support', () => {
    expect(isSupportServiceTierProvider(createProvider({ apiOptions: { isSupportServiceTier: true } }))).toBe(true)
    expect(isSupportServiceTierProvider(createSystemProvider())).toBe(true)
    expect(isSupportServiceTierProvider(createSystemProvider({ id: SystemProviderIds.github }))).toBe(false)
  })

  it('determines verbosity support', () => {
    // Custom providers with explicit flag
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: { isNotSupportVerbosity: false } }))).toBe(true)
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: { isNotSupportVerbosity: true } }))).toBe(false)

    // Custom providers without apiOptions (should support by default)
    expect(isSupportVerbosityProvider(createProvider())).toBe(true)
    expect(isSupportVerbosityProvider(createProvider({ apiOptions: {} }))).toBe(true)

    // System providers that support verbosity (default behavior)
    expect(isSupportVerbosityProvider(createSystemProvider())).toBe(true)
    expect(isSupportVerbosityProvider(createSystemProvider({ id: SystemProviderIds.openai }))).toBe(true)

    // System providers in the NOT_SUPPORT_VERBOSITY_PROVIDERS list (cannot be overridden by apiOptions)
    expect(isSupportVerbosityProvider(createSystemProvider({ id: SystemProviderIds.groq }))).toBe(false)
    expect(
      isSupportVerbosityProvider(
        createSystemProvider({ id: SystemProviderIds.groq, apiOptions: { isNotSupportVerbosity: false } })
      )
    ).toBe(false)

    // apiOptions can disable verbosity for any provider
    expect(
      isSupportVerbosityProvider(
        createSystemProvider({ id: SystemProviderIds.openai, apiOptions: { isNotSupportVerbosity: true } })
      )
    ).toBe(false)
  })

  it('detects URL context capable providers', () => {
    expect(isSupportUrlContextProvider(createProvider({ type: 'gemini' }))).toBe(true)
    expect(isSupportUrlContextProvider(createProvider())).toBe(false)
  })

  it('identifies Gemini web search providers (slice 3: gemini only, vertex retired)', () => {
    expect(isGeminiWebSearchProvider(createSystemProvider({ id: SystemProviderIds.gemini, type: 'gemini' }))).toBe(true)
    expect(isGeminiWebSearchProvider(createSystemProvider({ id: SystemProviderIds.vertexai, type: 'vertexai' }))).toBe(
      false
    )
    expect(isGeminiWebSearchProvider(createSystemProvider())).toBe(false)
  })

  it('detects New API providers by id or type', () => {
    expect(isNewApiProvider(createProvider({ id: SystemProviderIds['new-api'] }))).toBe(true)
    expect(isNewApiProvider(createProvider({ type: 'new-api' }))).toBe(true)
    expect(isNewApiProvider(createProvider())).toBe(false)
  })

  it('detects specific provider ids', () => {
    expect(isPerplexityProvider(createProvider({ id: SystemProviderIds.perplexity }))).toBe(true)
    expect(isPerplexityProvider(createProvider())).toBe(false)
  })

  it('recognizes OpenAI compatible providers (slice 3: generic openai only)', () => {
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
    expect(isAIGatewayProvider(createProvider({ type: 'gateway' }))).toBe(true)
  })

  it('computes API version support', () => {
    expect(isSupportAPIVersionProvider(createSystemProvider())).toBe(true)
    expect(isSupportAPIVersionProvider(createSystemProvider({ id: SystemProviderIds.github }))).toBe(false)
    expect(isSupportAPIVersionProvider(createProvider())).toBe(true)
    expect(isSupportAPIVersionProvider(createProvider({ apiOptions: { isNotSupportAPIVersion: false } }))).toBe(false)
  })

  describe('ProviderType schema (slice 3: active protocols only)', () => {
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
