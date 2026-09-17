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
    authType: 'oauth',
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

describe('AiProvider Anthropic OAuth protocol gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAdaptProvider.mockImplementation(({ provider }) => provider)
    mockProviderToAiSdkConfig.mockReturnValue({
      providerId: 'anthropic',
      providerSettings: {},
      endpoint: ''
    } as never)
  })

  it('injects the Claude Code system message for a custom-id Anthropic OAuth provider', async () => {
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
    // OAuth path clears the plain system prompt and prefixes Claude Code messages.
    expect(sentParams.system).toBeUndefined()
    expect(sentParams.messages.length).toBeGreaterThan(1)
    expect(sentParams.messages[0]).toMatchObject({ role: 'system' })
    expect(sentParams.messages[sentParams.messages.length - 1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('keeps the official-id OAuth behavior (regression)', async () => {
    const provider = makeProvider({ id: 'anthropic', name: 'Anthropic', isSystem: true })
    const model = makeModel(provider.id)
    const streamText = setupExecutor()

    const ai = new AiProvider(model, provider)
    await ai.completions(
      model.id,
      { messages: [{ role: 'user', content: 'hi' }], system: 'orig-system' } as never,
      { assistant: { id: 'a' }, callType: 'test' } as never
    )

    const sentParams = streamText.mock.calls[0][0]
    expect(sentParams.system).toBeUndefined()
    expect(sentParams.messages.length).toBeGreaterThan(1)
  })

  it('does not inject the Claude Code message for a custom-id Anthropic provider without oauth mode', async () => {
    const provider = makeProvider({ authType: undefined })
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
