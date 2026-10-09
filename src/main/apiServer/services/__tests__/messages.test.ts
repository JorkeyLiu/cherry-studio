import type { Provider } from '@types'
import { describe, expect, it, vi } from 'vitest'

const capturedClients: Array<Record<string, any>> = []

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(opts: any) {
      capturedClients.push(opts)
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

import { MessagesService } from '../messages'

function makeProvider(overrides: Record<string, unknown> = {}): Provider {
  return {
    id: 'my-anthropic',
    type: 'anthropic',
    name: 'My Anthropic',
    apiKey: 'sk-live-key',
    apiHost: 'https://relay.example.com/v1',
    models: [],
    enabled: true,
    ...overrides
  } as unknown as Provider
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-sonnet-4-5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides
  } as any
}

describe('MessagesService standard API-key client (no OAuth)', () => {
  it('builds the client from the configured host and stored key', async () => {
    const service = new MessagesService()
    const provider = makeProvider()

    await service.getClient(provider)

    const opts = capturedClients[capturedClients.length - 1]
    expect(opts.baseURL).toBe('https://relay.example.com')
    expect(opts.apiKey).toBe('sk-live-key')
    expect(opts.defaultHeaders?.Authorization).toBeUndefined()
  })

  it('treats a legacy oauth-marked provider as an ordinary API connection', async () => {
    const service = new MessagesService()
    const provider = makeProvider({ apiKey: 'sk-stored-key', authType: 'oauth' })

    await service.getClient(provider)

    const opts = capturedClients[capturedClients.length - 1]
    expect(opts.baseURL).toBe('https://relay.example.com')
    expect(opts.apiKey).toBe('sk-stored-key')
  })

  it('preserves the caller system message with no injection', () => {
    const service = new MessagesService()

    for (const provider of [makeProvider(), makeProvider({ authType: 'oauth' })]) {
      const request = service.createAnthropicRequest(makeRequest({ system: 'orig-system' }), provider)
      expect(request.system).toBe('orig-system')
    }
  })

  it('still applies the model override', () => {
    const service = new MessagesService()
    const request = service.createAnthropicRequest(makeRequest(), makeProvider(), 'claude-opus-4-5')
    expect(request.model).toBe('claude-opus-4-5')
  })
})
