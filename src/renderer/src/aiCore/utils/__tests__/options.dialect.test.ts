import type { Assistant, Model, Provider } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import { buildProviderOptions } from '../options'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    })
  }
}))

vi.mock('@renderer/store/settings', () => ({
  default: (state = { settings: {} }) => state
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: vi.fn((key) => {
    if (key === 'openAI') return { summaryText: 'auto', verbosity: undefined } as any
    return {} as any
  })
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: vi.fn(() => ({ id: 'default', name: 'Default', settings: {} })),
  getAssistantSettings: vi.fn((a) => ({
    maxTokens: a?.settings?.maxTokens || 4096,
    reasoning_effort: a?.settings?.reasoning_effort
  })),
  getProviderByModel: vi.fn()
}))

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: vi.fn(() => undefined)
}))

vi.mock('@renderer/config/models', async (importOriginal) => {
  const actual: any = await importOriginal()
  return {
    ...actual,
    isQwenMTModel: () => false
  }
})

vi.mock('../../provider/factory', async () => {
  const actual: any = await vi.importActual('../../provider/factory')
  return { getAiSdkProviderId: actual.getAiSdkProviderId }
})

function providerWithHost(apiHost: string, id = 'custom'): Provider {
  return {
    id,
    name: id,
    type: 'openai' as const,
    apiKey: 'k',
    apiHost,
    models: []
  } as unknown as Provider
}
const assistantWith = (effort: string): Assistant =>
  ({
    id: 'a',
    name: 'A',
    settings: { reasoning_effort: effort }
  }) as unknown as Assistant
const modelWith = (id: string, provider: string): Model => ({ id, name: id, provider }) as Model

describe('buildProviderOptions dialect contract — openai-compatible bucket shape', () => {
  it('unknown host arbitrary model none => openai-compatible reasoningEffort none single field', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    const provider = providerWithHost('https://unknown.example.com/v1', 'custom')
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    const assistant = assistantWith('none')
    const model = modelWith('grok-3-mini', 'custom')
    const result = buildProviderOptions(assistant, model, provider, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(result.providerOptions['openai-compatible']).toMatchObject({ reasoningEffort: 'none' })
    expect(result.providerOptions['openai-compatible']).not.toHaveProperty('thinking')
    expect(result.providerOptions['openai-compatible']).not.toHaveProperty('enable_thinking')
  })

  it('DeepSeek model on unknown host -> same default dialect (orthogonal)', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    const provider = providerWithHost('https://unknown.example.com/v1', 'custom')
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    const assistant = assistantWith('none')
    const model = modelWith('deepseek-v4', 'custom')
    const result = buildProviderOptions(assistant, model, provider, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(result.providerOptions['openai-compatible']).toMatchObject({ reasoningEffort: 'none' })
    expect(result.providerOptions['openai-compatible']).not.toHaveProperty('enable_thinking')
  })

  it('DeepSeek official api.deepseek.com none -> still default single field (no dual)', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    const provider = providerWithHost('https://api.deepseek.com', 'deepseek')
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    const assistant = assistantWith('none')
    const model = modelWith('deepseek-v4', 'deepseek')
    const result = buildProviderOptions(assistant, model, provider, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(result.providerOptions['openai-compatible']).toMatchObject({ reasoningEffort: 'none' })
    expect(result.providerOptions['openai-compatible']).not.toHaveProperty('thinking')
    expect(result.providerOptions['openai-compatible']).not.toHaveProperty('enable_thinking')
  })

  it('SiliconFlow arbitrary model none => enable_thinking:false', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    const provider = providerWithHost('https://api.siliconflow.cn/v1', 'silicon')
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    const assistant = assistantWith('none')
    const model = modelWith('grok-3-mini', 'silicon')
    const result = buildProviderOptions(assistant, model, provider, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(result.providerOptions['openai-compatible']).toMatchObject({ enable_thinking: false })
    expect(result.providerOptions['openai-compatible']).not.toHaveProperty('thinking')
    expect(result.providerOptions['openai-compatible']).not.toHaveProperty('reasoningEffort')
  })

  it('DashScope arbitrary model none => enable_thinking:false', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    const provider = providerWithHost('https://dashscope.aliyuncs.com/compatible-mode/v1', 'dashscope')
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    const assistant = assistantWith('none')
    const model = modelWith('deepseek-v3.2', 'dashscope')
    const result = buildProviderOptions(assistant, model, provider, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(result.providerOptions['openai-compatible']).toMatchObject({ enable_thinking: false })
    expect(result.providerOptions['openai-compatible']).not.toHaveProperty('thinking')
  })

  it('default dialect high/xhigh/auto mappings (single field)', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    const provider = providerWithHost('https://unknown.example.com/v1', 'custom')
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    for (const [eff, expected] of [
      ['high', 'high'],
      ['xhigh', 'max'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['auto', 'auto'],
      ['minimal', 'minimal']
    ] as const) {
      const assistant = assistantWith(eff)
      const model = modelWith('any-model', 'custom')
      const result = buildProviderOptions(assistant, model, provider, {
        enableReasoning: true,
        enableWebSearch: false,
        enableGenerateImage: false
      })
      expect(result.providerOptions['openai-compatible']).toMatchObject({ reasoningEffort: expected })
      expect(result.providerOptions['openai-compatible']).not.toHaveProperty('enable_thinking')
      expect(result.providerOptions['openai-compatible']).not.toHaveProperty('thinking')
    }
  })

  it('enable_thinking dialect high/xhigh mappings (dual field, no thinking)', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    const provider = providerWithHost('https://api.siliconflow.cn/v1', 'silicon')
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    const high = buildProviderOptions(assistantWith('high'), modelWith('any', 'silicon'), provider, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(high.providerOptions['openai-compatible']).toMatchObject({
      enable_thinking: true,
      reasoningEffort: 'high'
    })
    expect(high.providerOptions['openai-compatible']).not.toHaveProperty('thinking')
    const xhigh = buildProviderOptions(assistantWith('xhigh'), modelWith('any', 'silicon'), provider, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(xhigh.providerOptions['openai-compatible']).toMatchObject({
      enable_thinking: true,
      reasoningEffort: 'max'
    })
    const dash = providerWithHost('https://dashscope.aliyuncs.com/compatible-mode/v1', 'dashscope')
    vi.mocked(getProviderByModel).mockReturnValue(dash)
    const auto = buildProviderOptions(assistantWith('auto'), modelWith('any', 'dashscope'), dash, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(auto.providerOptions['openai-compatible']).toMatchObject({
      enable_thinking: true,
      reasoningEffort: 'auto'
    })
  })

  it('spoof/query/invalid fallback to default dialect in options shape', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    for (const host of [
      'https://proxy.example.com/?target=api.siliconflow.cn',
      'https://siliconflow.cn.example.com/v1',
      'https://dashscope.aliyuncs.com.example.com/v1',
      'not a url'
    ]) {
      const provider = providerWithHost(host, 'custom')
      vi.mocked(getProviderByModel).mockReturnValue(provider)
      const result = buildProviderOptions(assistantWith('none'), modelWith('deepseek-v4', 'custom'), provider, {
        enableReasoning: true,
        enableWebSearch: false,
        enableGenerateImage: false
      })
      expect(result.providerOptions['openai-compatible']).toMatchObject({ reasoningEffort: 'none' })
      expect(result.providerOptions['openai-compatible']).not.toHaveProperty('enable_thinking')
    }
  })

  it('ordinary model on SiliconFlow -> enable_thinking (orthogonal proof)', async () => {
    const { getProviderByModel } = await import('@renderer/services/AssistantService')
    const provider = providerWithHost('https://api.siliconflow.cn/v1', 'silicon')
    vi.mocked(getProviderByModel).mockReturnValue(provider)
    const result = buildProviderOptions(assistantWith('low'), modelWith('grok-3-mini', 'silicon'), provider, {
      enableReasoning: true,
      enableWebSearch: false,
      enableGenerateImage: false
    })
    expect(result.providerOptions['openai-compatible']).toMatchObject({
      enable_thinking: true,
      reasoningEffort: 'low'
    })
  })
})
