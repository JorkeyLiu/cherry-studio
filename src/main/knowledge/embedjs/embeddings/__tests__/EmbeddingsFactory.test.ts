import type { ApiClient } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ollamaEmbeddingsMock, openAiEmbeddingsMock, voyageEmbeddingsMock } = vi.hoisted(() => ({
  ollamaEmbeddingsMock: vi.fn(),
  openAiEmbeddingsMock: vi.fn(),
  voyageEmbeddingsMock: vi.fn()
}))

vi.mock('@cherrystudio/embedjs-ollama', () => ({
  OllamaEmbeddings: ollamaEmbeddingsMock
}))

vi.mock('@cherrystudio/embedjs-openai', () => ({
  OpenAiEmbeddings: openAiEmbeddingsMock
}))

vi.mock('../VoyageEmbeddings', () => ({
  VoyageEmbeddings: voyageEmbeddingsMock
}))

const createEmbedApiClient = (overrides: Partial<ApiClient>): ApiClient => ({
  apiKey: 'test-key',
  apiVersion: '',
  baseURL: 'https://example.com/v1',
  model: 'text-embedding-3-small',
  provider: 'openai',
  ...overrides
})

describe('EmbeddingsFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes custom model names through without passing dimensions to OpenAI-compatible embeddings', async () => {
    const { default: EmbeddingsFactory } = await import('../EmbeddingsFactory')

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        model: 'baai/bge-m3(free)'
      })
    })

    expect(openAiEmbeddingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'baai/bge-m3(free)',
        apiKey: 'test-key',
        batchSize: 10,
        configuration: expect.objectContaining({
          baseURL: 'https://api.example.com/v1'
        })
      })
    )
    expect(openAiEmbeddingsMock.mock.calls[0][0]).not.toHaveProperty('dimensions')
  })

  it('keeps configured dimensions local without passing them to official OpenAI embeddings', async () => {
    const { default: Embeddings } = await import('../Embeddings')

    const embeddings = new Embeddings({
      embedApiClient: createEmbedApiClient({
        provider: 'openai',
        model: 'text-embedding-3-small'
      }),
      dimensions: 768
    })

    expect(openAiEmbeddingsMock.mock.calls[0][0]).not.toHaveProperty('dimensions')
    await expect(embeddings.getDimensions()).resolves.toBe(768)
  })

  it('does not pass dimensions to Ollama or Voyage SDK constructors', async () => {
    const { default: EmbeddingsFactory } = await import('../EmbeddingsFactory')

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'ollama',
        baseURL: 'http://localhost:11434/api',
        model: 'nomic-embed-text'
      })
    })
    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'voyageai',
        model: 'voyage-3'
      })
    })

    expect(ollamaEmbeddingsMock.mock.calls[0][0]).toEqual({
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434'
    })
    expect(voyageEmbeddingsMock.mock.calls[0][0]).toEqual({
      modelName: 'voyage-3',
      apiKey: 'test-key',
      batchSize: 8
    })
  })

  it('forwards provider custom headers to the OpenAI SDK configuration without touching auth', async () => {
    const { default: EmbeddingsFactory } = await import('../EmbeddingsFactory')

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'openai',
        baseURL: 'https://api.example.com/v1',
        model: 'text-embedding-3-small',
        extra_headers: { 'X-Custom': 'custom-value' }
      })
    })

    const arg = openAiEmbeddingsMock.mock.calls[0][0]
    expect(arg.configuration.defaultHeaders).toMatchObject({ 'X-Custom': 'custom-value' })
    // Auth stays in its own credential field, never moved into headers.
    expect(arg.apiKey).toBe('test-key')
    expect(arg.configuration.defaultHeaders.Authorization).toBeUndefined()
  })

  it('mints a topicless opaque Go session on the OpenAI path without user/model content', async () => {
    const { default: EmbeddingsFactory } = await import('../EmbeddingsFactory')

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'openai',
        baseURL: 'https://opencode.ai/zen/go/v1',
        model: 'wire-embed-model'
      })
    })

    const headers = openAiEmbeddingsMock.mock.calls[0][0].configuration.defaultHeaders
    const value: string = headers?.['x-opencode-session'] ?? ''
    expect(value).toBeTruthy()
    expect(value).not.toContain('wire-embed-model')
    expect(value).not.toContain('openai')
  })

  it('uses the provided generateId for the automatic Go identity', async () => {
    const { default: EmbeddingsFactory } = await import('../EmbeddingsFactory')

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'openai',
        baseURL: 'https://opencode.ai/zen/go/v1',
        model: 'm'
      }),
      generateId: () => 'deterministic-req-1'
    })

    const headers = openAiEmbeddingsMock.mock.calls[0][0].configuration.defaultHeaders
    expect(headers?.['x-opencode-session']).toBe('deterministic-req-1')
  })
  it('lets a provider extra session win over the automatic Go identity (no duplicate)', async () => {
    const { default: EmbeddingsFactory } = await import('../EmbeddingsFactory')

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'openai',
        baseURL: 'https://opencode.ai/zen/go/v1',
        model: 'm',
        extra_headers: { 'x-opencode-session': 'provider-extra' }
      })
    })

    const headers = openAiEmbeddingsMock.mock.calls[0][0].configuration.defaultHeaders
    expect(headers?.['x-opencode-session']).toBe('provider-extra')
  })

  it('sends no session header on non-Go endpoints while preserving custom headers', async () => {
    const { default: EmbeddingsFactory } = await import('../EmbeddingsFactory')

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'openai',
        baseURL: 'https://api.deepseek.com/v1',
        model: 'm',
        extra_headers: { 'X-Custom': 'keep' }
      })
    })

    const headers = openAiEmbeddingsMock.mock.calls[0][0].configuration.defaultHeaders
    expect(headers?.['x-opencode-session']).toBeUndefined()
    expect(headers?.['X-Custom']).toBe('keep')
  })

  it('forwards custom headers to Ollama and Voyage client options', async () => {
    const { default: EmbeddingsFactory } = await import('../EmbeddingsFactory')

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'ollama',
        baseURL: 'http://localhost:11434/api',
        model: 'nomic-embed-text',
        extra_headers: { 'X-Custom': 'ollama-keep' }
      })
    })
    expect(ollamaEmbeddingsMock.mock.calls[0][0]).toMatchObject({
      model: 'nomic-embed-text',
      headers: { 'X-Custom': 'ollama-keep' }
    })

    EmbeddingsFactory.create({
      embedApiClient: createEmbedApiClient({
        provider: 'voyageai',
        model: 'voyage-3',
        extra_headers: { 'X-Custom': 'voyage-keep' }
      })
    })
    expect(voyageEmbeddingsMock.mock.calls[0][0]).toMatchObject({
      headers: { 'X-Custom': 'voyage-keep' }
    })
  })
})

describe('Embeddings request-local Go identity', () => {
  const GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  interface FakeSdkInstance {
    config: any
    embedQuery: ReturnType<typeof vi.fn>
    embedDocuments: ReturnType<typeof vi.fn>
    getDimensions: ReturnType<typeof vi.fn>
    init: ReturnType<typeof vi.fn>
  }

  function installSdkInstances(): FakeSdkInstance[] {
    const instances: FakeSdkInstance[] = []
    openAiEmbeddingsMock.mockImplementation((config: any) => {
      const instance: FakeSdkInstance = {
        config,
        embedQuery: vi.fn(async () => [0.1, 0.2]),
        embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
        getDimensions: vi.fn(async () => 2),
        init: vi.fn(async () => {})
      }
      instances.push(instance)
      return instance
    })
    return instances
  }

  function sessionOf(instance: FakeSdkInstance): string | undefined {
    return instance.config?.configuration?.defaultHeaders?.['x-opencode-session']
  }

  it('builds one fresh SDK per top-level call on the Go automatic identity (no cross-request reuse)', async () => {
    const { default: Embeddings } = await import('../Embeddings')
    const instances = installSdkInstances()
    const ids = ['req-1', 'req-2', 'req-3']
    let next = 0

    const embeddings = new Embeddings({
      embedApiClient: createEmbedApiClient({ provider: 'openai', baseURL: GO_BASE_URL, model: 'm' }),
      generateId: () => ids[next++]
    })
    // Request-local identity: nothing constructed (and no session minted)
    // at wrapper creation — the cached session reuse is gone.
    expect(openAiEmbeddingsMock).not.toHaveBeenCalled()

    await embeddings.embedQuery('a')
    await embeddings.embedQuery('b')
    await embeddings.embedDocuments(['c', 'd'])

    expect(openAiEmbeddingsMock).toHaveBeenCalledTimes(3)
    expect(instances.map(sessionOf)).toEqual(ids)
    // One instance per invocation: each invocation used exactly its own SDK
    // once, so batches/retries inside an invocation share that one identity.
    for (const instance of instances) {
      expect(instance.embedQuery.mock.calls.length + instance.embedDocuments.mock.calls.length).toBe(1)
    }
  })

  it('retains the cached singleton for non-Go endpoints across calls', async () => {
    const { default: Embeddings } = await import('../Embeddings')
    const instances = installSdkInstances()

    const embeddings = new Embeddings({
      embedApiClient: createEmbedApiClient({
        provider: 'openai',
        baseURL: 'https://api.deepseek.com/v1',
        model: 'm',
        extra_headers: { 'X-Custom': 'keep' }
      })
    })
    expect(openAiEmbeddingsMock).toHaveBeenCalledTimes(1)

    await embeddings.embedQuery('a')
    await embeddings.embedDocuments(['b'])

    expect(openAiEmbeddingsMock).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(1)
    expect(instances[0].embedQuery).toHaveBeenCalledTimes(1)
    expect(instances[0].embedDocuments).toHaveBeenCalledTimes(1)
    expect(sessionOf(instances[0])).toBeUndefined()
    expect(instances[0].config.configuration.defaultHeaders).toMatchObject({ 'X-Custom': 'keep' })
  })

  it('retains the cached singleton when a defined provider session wins on Go', async () => {
    const { default: Embeddings } = await import('../Embeddings')
    const instances = installSdkInstances()

    const embeddings = new Embeddings({
      embedApiClient: createEmbedApiClient({
        provider: 'openai',
        baseURL: GO_BASE_URL,
        model: 'm',
        extra_headers: { 'x-opencode-session': 'provider-extra' }
      })
    })
    expect(openAiEmbeddingsMock).toHaveBeenCalledTimes(1)
    expect(sessionOf(instances[0])).toBe('provider-extra')

    await embeddings.embedQuery('a')
    await embeddings.embedQuery('b')

    expect(openAiEmbeddingsMock).toHaveBeenCalledTimes(1)
    expect(instances[0].embedQuery).toHaveBeenCalledTimes(2)
  })
})
