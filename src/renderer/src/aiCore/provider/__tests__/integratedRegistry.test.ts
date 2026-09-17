import type { Provider } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import { getAiSdkProviderId } from '../factory'

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

vi.mock('@renderer/store/settings', () => ({
  default: {},
  settingsSlice: {
    name: 'settings',
    reducer: vi.fn(),
    actions: {}
  }
}))

// Mock the provider configs
vi.mock('../providerConfigs', () => ({
  initializeNewProviders: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

function createTestProvider(id: string, type: string, apiHost = 'https://api.example.com'): Provider {
  return {
    id,
    type,
    name: `Test ${id}`,
    apiKey: 'test-key',
    apiHost,
    models: []
  } as unknown as Provider
}

describe('Integrated Provider Registry (slice 3: protocol-based, no brand-id selection)', () => {
  describe('Approved protocol mapping', () => {
    it('maps openai-response to approved OpenAI Responses', () => {
      const provider = createTestProvider('openai', 'openai-response', 'https://api.openai.com/v1')
      expect(getAiSdkProviderId(provider)).toBe('openai')
    })

    it('maps openai official host to openai-chat', () => {
      const provider = createTestProvider('my-openai', 'openai', 'https://api.openai.com/v1')
      expect(getAiSdkProviderId(provider)).toBe('openai-chat')
    })

    it('maps anthropic type to Anthropic', () => {
      const provider = createTestProvider('my-anthropic', 'anthropic')
      expect(getAiSdkProviderId(provider)).toBe('anthropic')
    })

    it('maps gemini type to Google', () => {
      const provider = createTestProvider('my-gemini', 'gemini')
      expect(getAiSdkProviderId(provider)).toBe('google')
    })
  })

  describe('No brand-id selection', () => {
    it.each(['groq', 'openrouter', 'deepseek', 'together', 'silicon'])(
      'brand id %s with type openai uses generic OpenAI-compatible',
      (brandId) => {
        const provider = createTestProvider(brandId, 'openai', `https://${brandId}.example.com/v1`)
        expect(getAiSdkProviderId(provider)).toBe('openai-compatible')
      }
    )

    it('unknown model ids remain requestable via generic OpenAI-compatible (factory does not reject)', () => {
      const provider = createTestProvider('my-openai', 'openai', 'https://my.example.com/v1')
      // Factory resolution succeeds; unknown model id handling is in providerConfig (generic fallback).
      expect(getAiSdkProviderId(provider)).toBe('openai-compatible')
    })

    it('falls back to generic OpenAI-compatible for unknown types (no silent brand fallback)', () => {
      const provider = createTestProvider('unknown-provider', 'unknown-type' as any)
      expect(getAiSdkProviderId(provider)).toBe('openai-compatible')
    })
  })
})
