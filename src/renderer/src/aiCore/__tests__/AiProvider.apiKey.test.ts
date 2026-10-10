import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@cherrystudio/ai-core', () => ({
  createExecutor: vi.fn()
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getEnableDeveloperMode: vi.fn(() => false)
}))

vi.mock('@renderer/services/db/sendTimingDiagnostics', () => ({
  logColdPathDiagnostic: vi.fn()
}))

vi.mock('@renderer/services/SpanManagerService', () => ({
  addSpan: vi.fn(),
  endSpan: vi.fn()
}))

vi.mock('@renderer/utils', () => ({
  getLowerBaseModelName: (id: string) => id.toLowerCase()
}))

vi.mock('../plugins/PluginBuilder', () => ({
  buildPlugins: vi.fn(() => [])
}))

vi.mock('../provider/providerConfig', () => ({
  adaptProvider: vi.fn(),
  getActualProvider: vi.fn(),
  providerToAiSdkConfig: vi.fn()
}))

vi.mock('../services/listModels', () => ({
  listModels: vi.fn()
}))

vi.mock('../chunk/AiSdkToChunkAdapter', () => ({
  default: vi.fn()
}))

import { createExecutor } from '@cherrystudio/ai-core'

import AiProvider from '../AiProvider'
import { adaptProvider, providerToAiSdkConfig } from '../provider/providerConfig'

const mockCreateExecutor = vi.mocked(createExecutor)
const mockAdaptProvider = vi.mocked(adaptProvider)
const mockProviderToAiSdkConfig = vi.mocked(providerToAiSdkConfig)

const makeProvider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'my-claude-relay',
    name: 'My Claude Relay',
    type: 'anthropic',
    apiKey: 'relay-key',
    apiHost: 'https://relay.example.com',
    models: [],
    isSystem: false,
    ...overrides
  }) as Provider

const makeModel = (providerId: string): Model =>
  ({ id: 'claude-sonnet-4-5', name: 'Claude Sonnet', provider: providerId }) as Model

const setupExecutor = () => {
  const streamText = vi.fn().mockResolvedValue({
    consumeStream: vi.fn().mockResolvedValue(undefined),
    text: 'hello',
    totalUsage: { inputTokens: 1, outputTokens: 1 }
  })
  mockCreateExecutor.mockResolvedValue({ streamText } as never)
  return streamText
}

describe('AiProvider Anthropic standard API key behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAdaptProvider.mockImplementation(({ provider }) => provider)
    mockProviderToAiSdkConfig.mockReturnValue({
      providerId: 'anthropic',
      providerSettings: {},
      endpoint: ''
    } as never)
  })

  it('preserves the caller system message untouched for an anthropic-protocol connection', async () => {
    const provider = makeProvider()
    const model = makeModel(provider.id)
    const streamText = setupExecutor()

    const ai = new AiProvider(model, provider)
    const result = await ai.completions(
      model.id,
      { messages: [{ role: 'user', content: 'hi' }], system: 'orig-system' } as never,
      { assistant: { id: 'a' }, callType: 'test' } as never
    )

    expect(result.getText()).toBe('hello')
    const sentParams = streamText.mock.calls[0][0]
    // No injected system message: the ordinary system prompt passes through.
    expect(sentParams.system).toBe('orig-system')
    expect(sentParams.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('preserves the caller system message for a legacy oauth-marked connection', async () => {
    const provider = makeProvider({ authType: 'oauth' } as never)
    const model = makeModel(provider.id)
    const streamText = setupExecutor()

    const ai = new AiProvider(model, provider)
    await ai.completions(
      model.id,
      { messages: [{ role: 'user', content: 'hi' }], system: 'orig-system' } as never,
      { assistant: { id: 'a' }, callType: 'test' } as never
    )

    const sentParams = streamText.mock.calls[0][0]
    expect(sentParams.system).toBe('orig-system')
    expect(sentParams.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('AiProvider outbound session boundary (common executor seam)', () => {
  const SESSION = 'x-opencode-session'
  const GO_HOST = 'https://opencode.ai/zen/go/v1'

  beforeEach(() => {
    vi.clearAllMocks()
    mockAdaptProvider.mockImplementation(({ provider }) => provider)
    mockProviderToAiSdkConfig.mockReturnValue({
      providerId: 'openai-compatible',
      providerSettings: {},
      endpoint: ''
    } as never)
  })

  function goProvider(extra?: Record<string, string>): Provider {
    return makeProvider({
      id: 'opencode-go',
      name: 'OpenCode Go',
      type: 'openai',
      apiHost: GO_HOST,
      apiKey: 'k',
      extra_headers: extra
    } as never)
  }

  function sessionOf(sent: any): string | undefined {
    const headers = sent?.headers as Record<string, string | undefined> | undefined
    if (!headers) return undefined
    const key = Object.keys(headers).find((k) => k.toLowerCase() === SESSION)
    return key ? headers[key] : undefined
  }

  it('applies the same topic identity across chat/summary/note/generate/check shapes', async () => {
    const provider = goProvider()
    const model = makeModel(provider.id)
    // Distinct prompt/tools/cancel shapes per helper, same stable topic.
    const shapes = [
      { messages: [{ role: 'user', content: 'chat' }], system: 's' },
      { system: 'title-prompt', prompt: 'conversation-json' },
      { system: 'note-prompt', prompt: 'note-content' },
      { system: 'gen-prompt', prompt: 'gen-content' },
      { system: 'test', prompt: 'hi' }
    ]
    const callTypes = ['chat', 'summary', 'summary', 'generate', 'check']
    for (let i = 0; i < shapes.length; i++) {
      const streamText = setupExecutor()
      const ai = new AiProvider(model, provider)
      await ai.completions(
        model.id,
        shapes[i] as never,
        {
          assistant: { id: 'a' },
          callType: callTypes[i],
          topicId: 'topic-stable-1'
        } as never
      )
      expect(sessionOf(streamText.mock.calls[0][0])).toBe('topic-stable-1')
    }
  })

  it('mints a request-local opaque identity for topicless calls, constant within the invocation', async () => {
    const provider = goProvider()
    const model = makeModel(provider.id)
    const streamText = setupExecutor()
    const ai = new AiProvider(model, provider)
    const abort = new AbortController()
    await ai.completions(
      model.id,
      { prompt: 'hi', abortSignal: abort.signal, headers: { 'x-custom': 'keep' } } as never,
      { assistant: { id: 'a' }, callType: 'generate' } as never
    )
    const sent = streamText.mock.calls[0][0]
    const value = sessionOf(sent)
    expect(value).toBeTruthy()
    expect(value).not.toBe('topic-stable-1')
    // Unrelated headers preserved, abort signal preserved.
    expect(sent.headers?.['x-custom']).toBe('keep')
    expect(sent.abortSignal).toBe(abort.signal)
    // Opaque: no topic/persisted shape assumed, just non-empty.
    expect(typeof value).toBe('string')
  })

  it('sends nothing on Zen/non-Go endpoints and honors Go variants', async () => {
    const model = makeModel('x')
    for (const apiHost of ['https://opencode.ai/zen/v1', 'https://api.deepseek.com/v1', 'https://example.com/v1']) {
      const streamText = setupExecutor()
      const provider = makeProvider({ id: 'p', apiHost } as never)
      const ai = new AiProvider({ ...model, provider: 'p' } as Model, provider)
      await ai.completions(
        model.id,
        { prompt: 'hi' } as never,
        {
          assistant: { id: 'a' },
          callType: 'chat',
          topicId: 'topic-1'
        } as never
      )
      expect(sessionOf(streamText.mock.calls[0][0])).toBeUndefined()
    }
    for (const apiHost of [
      'https://opencode.ai/zen/go/v1',
      'https://opencode.ai/zen/go/',
      'HTTPS://OPENCODE.AI/ZEN/GO/V1',
      'https://opencode.ai/zen/go/v1/responses#'
    ]) {
      const streamText = setupExecutor()
      const provider = makeProvider({ id: 'p', apiHost } as never)
      const ai = new AiProvider({ ...model, provider: 'p' } as Model, provider)
      await ai.completions(
        model.id,
        { prompt: 'hi' } as never,
        {
          assistant: { id: 'a' },
          callType: 'chat',
          topicId: 'topic-1'
        } as never
      )
      expect(sessionOf(streamText.mock.calls[0][0])).toBe('topic-1')
    }
  })

  it('explicit per-request headers win case-insensitively; provider extra wins over automatic', async () => {
    const model = makeModel('x')
    // Explicit wins.
    {
      const streamText = setupExecutor()
      const ai = new AiProvider(model, goProvider())
      await ai.completions(
        model.id,
        { prompt: 'hi', headers: { 'X-OpenCode-Session': 'caller-mixed' } } as never,
        { assistant: { id: 'a' }, callType: 'chat', topicId: 'topic-1' } as never
      )
      const sent = streamText.mock.calls[0][0]
      expect(sent.headers?.['X-OpenCode-Session']).toBe('caller-mixed')
      expect(sent.headers?.[SESSION]).toBeUndefined()
    }
    // Provider extra wins over automatic (no per-request duplicate).
    {
      const streamText = setupExecutor()
      const ai = new AiProvider(model, goProvider({ [SESSION]: 'provider-extra' }))
      await ai.completions(
        model.id,
        { prompt: 'hi' } as never,
        {
          assistant: { id: 'a' },
          callType: 'chat',
          topicId: 'topic-1'
        } as never
      )
      expect(sessionOf(streamText.mock.calls[0][0])).toBeUndefined()
    }
  })

  it('passes the session policy to embedding and image boundaries', async () => {
    const embed = vi.fn().mockResolvedValue({ embeddings: [[1, 2]] })
    const generateImage = vi.fn().mockResolvedValue({ images: [] })
    mockCreateExecutor.mockResolvedValue({ streamText: vi.fn(), embedMany: embed, generateImage } as never)
    const provider = goProvider()
    const model = makeModel(provider.id)

    const ai = new AiProvider(model, provider)
    await ai.getEmbeddingDimensions(model)
    expect(embed).toHaveBeenCalledTimes(1)
    expect(sessionOf(embed.mock.calls[0][0])).toBeTruthy()

    await ai.generateImage({ model: model.id, prompt: 'p', imageSize: '1024x1024', batchSize: 1 } as never)
    expect(generateImage).toHaveBeenCalledTimes(1)
    expect(sessionOf(generateImage.mock.calls[0][0])).toBeTruthy()
    // Distinct protocol bodies are not conflated: image keeps its own shape.
    expect(generateImage.mock.calls[0][0]?.prompt).toBe('p')
  })
})
