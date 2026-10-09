import type { Provider } from '@types'
import { describe, expect, it, vi } from 'vitest'

const mockAnthropicInstance = { _opts: {} as Record<string, any> }

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(opts: any) {
      mockAnthropicInstance._opts = opts
    }
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

const { getSdkClient } = await import('../index')

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'test-provider',
    type: 'anthropic',
    name: 'Test',
    apiKey: 'sk-test',
    apiHost: 'https://api.example.com/v1',
    models: [],
    enabled: true,
    ...overrides
  } as Provider
}

describe('getSdkClient', () => {
  describe('baseURL should strip trailing API version', () => {
    it('strips /v1 from apiHost for anthropic provider type', () => {
      const provider = makeProvider({ type: 'anthropic', apiHost: 'https://api.example.com/v1' })
      getSdkClient(provider)
      expect(mockAnthropicInstance._opts.baseURL).toBe('https://api.example.com')
    })

    it('strips /v1 from apiHost for non-anthropic provider type using apiHost fallback', () => {
      const provider = makeProvider({ type: 'openai' as any, apiHost: 'https://gateway.example.com/v1' })
      getSdkClient(provider)
      expect(mockAnthropicInstance._opts.baseURL).toBe('https://gateway.example.com')
    })

    it('strips /v1 from anthropicApiHost for non-anthropic provider type', () => {
      const provider = makeProvider({
        type: 'openai' as any,
        apiHost: 'https://openai.example.com/v1',
        anthropicApiHost: 'https://anthropic.example.com/v1'
      })
      getSdkClient(provider)
      expect(mockAnthropicInstance._opts.baseURL).toBe('https://anthropic.example.com')
    })

    it('handles apiHost without trailing version', () => {
      const provider = makeProvider({ type: 'anthropic', apiHost: 'https://api.anthropic.com' })
      getSdkClient(provider)
      expect(mockAnthropicInstance._opts.baseURL).toBe('https://api.anthropic.com')
    })

    it('strips /v2beta from apiHost', () => {
      const provider = makeProvider({ type: 'anthropic', apiHost: 'https://api.example.com/v2beta' })
      getSdkClient(provider)
      expect(mockAnthropicInstance._opts.baseURL).toBe('https://api.example.com')
    })

    it('preserves path segments before trailing version', () => {
      const provider = makeProvider({ type: 'anthropic', apiHost: 'https://gateway.example.com/api/anthropic/v1' })
      getSdkClient(provider)
      expect(mockAnthropicInstance._opts.baseURL).toBe('https://gateway.example.com/api/anthropic')
    })
  })

  describe('standard API-key authentication against the configured host', () => {
    it('sends the stored key with the configured host and no bearer token or fixed official baseURL', () => {
      const provider = makeProvider({
        type: 'anthropic',
        apiHost: 'https://relay.example.com/v1',
        apiKey: 'sk-relay-key'
      })
      getSdkClient(provider)
      expect(mockAnthropicInstance._opts.baseURL).toBe('https://relay.example.com')
      expect(mockAnthropicInstance._opts.apiKey).toBe('sk-relay-key')
      expect(mockAnthropicInstance._opts.authToken).toBe('sk-relay-key')
      expect(mockAnthropicInstance._opts.defaultHeaders?.Authorization).toBeUndefined()
    })

    it('treats a legacy oauth-marked connection as an ordinary API connection', () => {
      const provider = makeProvider({
        type: 'anthropic',
        apiHost: 'https://relay.example.com/v1',
        apiKey: 'sk-stored-key',
        authType: 'oauth'
      } as never)
      getSdkClient(provider)
      expect(mockAnthropicInstance._opts.baseURL).toBe('https://relay.example.com')
      expect(mockAnthropicInstance._opts.apiKey).toBe('sk-stored-key')
    })

    it('merges caller extra headers and provider extra_headers without CLI identity headers', () => {
      const provider = makeProvider({
        type: 'anthropic',
        apiHost: 'https://relay.example.com',
        apiKey: 'sk-relay-key',
        extra_headers: { 'x-custom': 'custom-value' }
      } as never)
      getSdkClient(provider, { 'x-caller': 'caller-value' })
      expect(mockAnthropicInstance._opts.defaultHeaders?.['x-custom']).toBe('custom-value')
      expect(mockAnthropicInstance._opts.defaultHeaders?.['x-app']).toBeUndefined()
      expect(mockAnthropicInstance._opts.defaultHeaders?.['user-agent']).toBeUndefined()
    })
  })
})
