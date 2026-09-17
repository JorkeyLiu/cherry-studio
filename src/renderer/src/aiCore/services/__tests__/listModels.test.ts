/**
 * listModels protocol-selection tests (slice 3).
 *
 * Active selection is protocol-driven only: `gemini` and generic
 * OpenAI-compatible (`openai` / `openai-response`). `anthropic` has no
 * supported generic listing (explicit manual model addition). No brand-id
 * fetcher selection exists in the active path — these tests prove selection
 * follows `provider.type` alone: unknown/retired types return [] even when
 * the brand id is a well-known one, and arbitrary brand ids work when the
 * protocol is approved.
 */
import type { Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetFromApi = vi.fn()

vi.mock('@ai-sdk/provider-utils', () => ({
  createJsonResponseHandler: vi.fn(() => 'json-handler'),
  createJsonErrorResponseHandler: vi.fn(() => 'error-handler'),
  getFromApi: (...args: unknown[]) => mockGetFromApi(...args),
  zodSchema: vi.fn((s: unknown) => s)
}))

vi.mock('@renderer/utils', () => ({
  formatApiHost: (host: string) => host?.replace(/\/$/, ''),
  getDefaultGroupName: (id: string) => id.toLowerCase().split('/')[0],
  withoutTrailingSlash: (s: string) => s?.replace(/\/$/, '')
}))

vi.mock('@shared/utils', () => ({
  defaultAppHeaders: () => ({ 'X-App': 'CherryChat' })
}))

const { listModels } = await import('../listModels')
const { OllamaTagsResponseSchema } = await import('../schemas')

// === Fixtures (captured real responses, protocol-shaped) ===

// From https://api.deepseek.com/v1/models (OpenAI-compatible /models shape)
const REAL_DEEPSEEK = {
  object: 'list',
  data: [
    { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' }
  ]
}

// From https://generativelanguage.googleapis.com/v1beta/models (Gemini shape)
const REAL_GEMINI = {
  models: [
    {
      name: 'models/gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      description: 'Stable version of Gemini 2.5 Flash.'
    },
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      description: 'Stable release of Gemini 2.5 Pro.'
    }
  ]
}

// === Helpers ===

function makeProvider(overrides: Partial<Provider> & { id: string }): Provider {
  return {
    name: overrides.id,
    type: 'openai',
    apiKey: 'sk-test',
    apiHost: 'https://api.example.com/v1',
    models: [],
    isSystem: true,
    enabled: true,
    ...overrides
  } as Provider
}

function assertValidModels(models: { id: string; name: string; provider: string; group: string }[]) {
  expect(models.length).toBeGreaterThan(0)
  for (const m of models) {
    expect(m.id).toBeTruthy()
    expect(typeof m.id).toBe('string')
    expect(m.id).toBe(m.id.trim())
    expect(m.name).toBeTruthy()
    expect(typeof m.provider).toBe('string')
    expect(typeof m.group).toBe('string')
  }
}

// === Tests ===

beforeEach(() => {
  mockGetFromApi.mockReset()
})

describe('listModels protocol selection', () => {
  describe('OpenAI-compatible protocol (type openai)', () => {
    it('lists models through <apiHost>/models for an arbitrary brand id', async () => {
      mockGetFromApi.mockResolvedValue({ value: REAL_DEEPSEEK })
      const models = await listModels(makeProvider({ id: 'my-custom-brand', type: 'openai' }))

      expect(mockGetFromApi).toHaveBeenCalledTimes(1)
      const [request] = mockGetFromApi.mock.calls[0]
      expect(request.url).toBe('https://api.example.com/v1/models')
      assertValidModels(models)
      expect(models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
      // Owning provider id is stamped on every model, group falls back to it for bare ids.
      expect(models[0].provider).toBe('my-custom-brand')
      expect(models[0].owned_by).toBe('deepseek')
    })

    it('selects the same fetcher for a well-known brand id with the approved protocol', async () => {
      mockGetFromApi.mockResolvedValue({ value: REAL_DEEPSEEK })
      const models = await listModels(makeProvider({ id: 'deepseek', type: 'openai' }))

      expect(mockGetFromApi).toHaveBeenCalledTimes(1)
      assertValidModels(models)
    })

    it('dedupes blank and repeated ids', async () => {
      mockGetFromApi.mockResolvedValue({
        value: {
          data: [
            { id: 'deepseek-chat', object: 'model' },
            { id: 'deepseek-chat', object: 'model' },
            { id: '   ', object: 'model' },
            { id: 'deepseek-reasoner', object: 'model' }
          ]
        }
      })
      const models = await listModels(makeProvider({ id: 'brand', type: 'openai' }))
      expect(models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    })
  })

  describe('OpenAI Responses variant (type openai-response)', () => {
    it('uses the same OpenAI-compatible /models endpoint', async () => {
      mockGetFromApi.mockResolvedValue({ value: REAL_DEEPSEEK })
      const models = await listModels(
        makeProvider({ id: 'official-openai', type: 'openai-response', apiHost: 'https://api.openai.com/v1' })
      )

      expect(mockGetFromApi).toHaveBeenCalledTimes(1)
      const [request] = mockGetFromApi.mock.calls[0]
      expect(request.url).toBe('https://api.openai.com/v1/models')
      assertValidModels(models)
    })
  })

  describe('Gemini protocol (type gemini)', () => {
    it('strips models/ prefix and uses displayName from the v1beta endpoint', async () => {
      mockGetFromApi.mockResolvedValue({ value: REAL_GEMINI })
      const models = await listModels(
        makeProvider({ id: 'gemini-clone-brand', type: 'gemini', apiHost: 'https://generativelanguage.googleapis.com' })
      )

      expect(mockGetFromApi).toHaveBeenCalledTimes(1)
      const [request] = mockGetFromApi.mock.calls[0]
      expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=sk-test')
      assertValidModels(models)
      for (const m of models) {
        expect(m.id).not.toMatch(/^models\//)
      }
      expect(models[0]).toMatchObject({
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        provider: 'gemini-clone-brand'
      })
    })

    it('normalizes a trailing /v1 apiHost before appending v1beta', async () => {
      mockGetFromApi.mockResolvedValue({ value: REAL_GEMINI })
      await listModels(
        makeProvider({
          id: 'g',
          type: 'gemini',
          apiHost: 'https://generativelanguage.googleapis.com/v1/'
        })
      )
      const [request] = mockGetFromApi.mock.calls[0]
      expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=sk-test')
    })
  })

  describe('no brand-id selection', () => {
    it('a well-known brand id with a retired protocol performs no request', async () => {
      const models = await listModels(
        makeProvider({ id: 'openai', type: 'azure-openai' as unknown as Provider['type'] })
      )

      expect(models).toEqual([])
      expect(mockGetFromApi).not.toHaveBeenCalled()
    })

    it.each([
      ['vertexai', 'vertexai'],
      ['gateway', 'gateway'],
      ['aws-bedrock', 'aws-bedrock'],
      ['azure-openai', 'azure-openai'],
      ['ollama (folded, not listable)', 'ollama'],
      ['new-api (folded, not listable)', 'new-api'],
      ['mistral (folded, not listable)', 'mistral'],
      ['copilot', 'copilot'],
      ['unknown future type', 'some-future-protocol']
    ])('retired/unknown protocol %s returns [] without a request', async (_label, type) => {
      const models = await listModels(makeProvider({ id: 'brand', type: type as unknown as Provider['type'] }))
      expect(models).toEqual([])
      expect(mockGetFromApi).not.toHaveBeenCalled()
    })

    it('anthropic has no generic listing and performs no request', async () => {
      const models = await listModels(makeProvider({ id: 'anthropic', type: 'anthropic' }))
      expect(models).toEqual([])
      expect(mockGetFromApi).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('returns [] on network error', async () => {
      mockGetFromApi.mockRejectedValue(new Error('ECONNREFUSED'))
      const models = await listModels(makeProvider({ id: 'openai', type: 'openai' }))
      expect(models).toEqual([])
    })
  })

  describe('retained response schemas', () => {
    it('accepts null families in Ollama tags schema', () => {
      const parsed = OllamaTagsResponseSchema.parse({
        models: [
          {
            name: 'glm-5:cloud',
            model: 'glm-5:cloud',
            details: {
              parent_model: '',
              format: '',
              family: '',
              families: null,
              parameter_size: '',
              quantization_level: ''
            }
          }
        ]
      })

      expect(parsed.models[0].details?.families).toBeUndefined()
    })
  })
})
