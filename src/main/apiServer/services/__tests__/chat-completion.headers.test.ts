import type { Provider } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const capturedClients: Array<Record<string, any>> = []

vi.mock('@cherrystudio/openai', () => ({
  default: class MockOpenAI {
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

vi.mock('../../utils', () => ({
  validateModelId: vi.fn()
}))

import { validateModelId } from '../../utils'
import { ChatCompletionService } from '../chat-completion'

const mockValidateModelId = vi.mocked(validateModelId)

function makeProvider(overrides: Record<string, unknown> = {}): Provider {
  return {
    id: 'conn-1',
    type: 'openai',
    name: 'My Connection',
    apiKey: 'sk-fake-key',
    apiHost: 'https://api.example.com/v1',
    models: [],
    enabled: true,
    ...overrides
  } as unknown as Provider
}

function mockValidProvider(provider: Provider, modelId = 'm1') {
  mockValidateModelId.mockResolvedValue({
    valid: true,
    provider,
    modelId
  } as never)
}

describe('ChatCompletionService shared header policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedClients.length = 0
  })

  it('sends no session header on non-Go endpoints with no fabricated headers object', async () => {
    const provider = makeProvider()
    mockValidProvider(provider)
    const service = new ChatCompletionService()

    const result = await service.resolveProviderContext('conn-1/m1')

    expect(result.ok).toBe(true)
    const opts = capturedClients[capturedClients.length - 1]
    expect(opts.baseURL).toBe('https://api.example.com/v1')
    expect(opts.apiKey).toBe('sk-fake-key')
    expect(opts.defaultHeaders?.['x-opencode-session']).toBeUndefined()
    expect(opts.defaultHeaders).toBeUndefined()
  })

  it('mints a topicless opaque Go session without user/model content', async () => {
    const provider = makeProvider({ apiHost: 'https://opencode.ai/zen/go/v1' })
    mockValidProvider(provider)
    const service = new ChatCompletionService()

    await service.resolveProviderContext('conn-1/m1')

    const opts = capturedClients[capturedClients.length - 1]
    const value: string = opts.defaultHeaders?.['x-opencode-session'] ?? ''
    expect(value).toBeTruthy()
    expect(value).not.toContain('m1')
    expect(value).not.toContain('My Connection')
  })

  it('forwards provider custom headers and lets a provider extra session win', async () => {
    const provider = makeProvider({
      apiHost: 'https://opencode.ai/zen/go/v1',
      extra_headers: { 'X-Custom': 'keep', 'x-opencode-session': 'provider-extra' }
    })
    mockValidProvider(provider)
    const service = new ChatCompletionService()

    await service.resolveProviderContext('conn-1/m1')

    const opts = capturedClients[capturedClients.length - 1]
    expect(opts.defaultHeaders?.['X-Custom']).toBe('keep')
    expect(opts.defaultHeaders?.['x-opencode-session']).toBe('provider-extra')
  })

  it('keeps the provider request body intact (model rewrite only)', async () => {
    const provider = makeProvider()
    mockValidProvider(provider, 'real-model')
    const service = new ChatCompletionService()

    const preparation = await service.prepareRequest(
      { model: 'conn-1/real-model', messages: [{ role: 'user', content: 'hi' }] } as never,
      false
    )

    expect(preparation.status).toBe('ok')
    if (preparation.status === 'ok') {
      expect(preparation.providerRequest).toMatchObject({
        model: 'real-model',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }]
      })
    }
  })
})
