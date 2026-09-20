import type { Assistant, Model, Provider } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import { encodeReasoningEffortForDialect, getReasoningEffort, resolveOpenAICompatibleDialect } from '../reasoning'

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

vi.mock('@renderer/store/llm', () => ({
  initialState: {},
  default: (state = { llm: {} }) => state
}))

vi.mock('@renderer/config/constant', () => ({
  DEFAULT_MAX_TOKENS: 4096,
  isMac: false,
  isWin: false,
  TOKENFLUX_HOST: 'mock-host'
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: vi.fn(() => ({ summaryText: 'auto', verbosity: 'medium' }))
}))

const makeProvider = (apiHost: string, id = 'custom'): Provider =>
  ({
    id,
    name: id,
    type: 'openai' as const,
    apiKey: 'k',
    apiHost,
    models: []
  }) as unknown as Provider

const makeModel = (id: string, providerId = 'custom'): Model =>
  ({
    id,
    name: id,
    provider: providerId
  }) as Model

const makeAssistant = (effort: string): Assistant =>
  ({
    id: 'a',
    name: 'A',
    settings: { reasoning_effort: effort }
  }) as unknown as Assistant

async function withProvider(provider: Provider, fn: () => void | Promise<void>) {
  const mod = await import('@renderer/services/AssistantService')
  vi.mocked(mod.getProviderByModel).mockReturnValue(provider)
  await fn()
}

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: vi.fn((a) => ({
    maxTokens: (a as Assistant)?.settings?.maxTokens || 4096,
    reasoning_effort: (a as Assistant)?.settings?.reasoning_effort
  })),
  getProviderByModel: vi.fn(),
  getDefaultAssistant: vi.fn(() => ({ id: 'default', name: 'Default', settings: {} }))
}))

describe('OpenAI-compatible API dialect — encoding & host resolution', () => {
  describe('resolveOpenAICompatibleDialect', () => {
    it('defaults to default for unknown/custom hosts', () => {
      expect(resolveOpenAICompatibleDialect(makeProvider('https://my-proxy.example.com/v1'))).toBe('default')
      expect(resolveOpenAICompatibleDialect(makeProvider('https://api.deepseek.com'))).toBe('default')
      expect(resolveOpenAICompatibleDialect(makeProvider('https://api.openai.com/v1'))).toBe('default')
      expect(resolveOpenAICompatibleDialect(makeProvider('not a url'))).toBe('default')
      expect(resolveOpenAICompatibleDialect(makeProvider(''))).toBe('default')
    })
    it('returns enable_thinking for SiliconFlow exact and subdomains', () => {
      expect(resolveOpenAICompatibleDialect(makeProvider('https://api.siliconflow.cn/v1'))).toBe('enable_thinking')
      expect(resolveOpenAICompatibleDialect(makeProvider('https://siliconflow.cn'))).toBe('enable_thinking')
      expect(resolveOpenAICompatibleDialect(makeProvider('https://foo.api.siliconflow.cn/v1'))).toBe('enable_thinking')
      expect(resolveOpenAICompatibleDialect(makeProvider('api.siliconflow.cn/v1'))).toBe('enable_thinking')
    })
    it('returns enable_thinking for DashScope exact and subdomains', () => {
      expect(resolveOpenAICompatibleDialect(makeProvider('https://dashscope.aliyuncs.com/compatible-mode/v1'))).toBe(
        'enable_thinking'
      )
      expect(resolveOpenAICompatibleDialect(makeProvider('https://sub.dashscope.aliyuncs.com/v1'))).toBe(
        'enable_thinking'
      )
    })
    it('hostname spoof and query-string do NOT trigger enable_thinking', () => {
      expect(resolveOpenAICompatibleDialect(makeProvider('https://proxy.example.com/?target=api.siliconflow.cn'))).toBe(
        'default'
      )
      expect(resolveOpenAICompatibleDialect(makeProvider('https://siliconflow.cn.example.com/v1'))).toBe('default')
      expect(
        resolveOpenAICompatibleDialect(makeProvider('https://proxy.example.com/?target=dashscope.aliyuncs.com'))
      ).toBe('default')
      expect(resolveOpenAICompatibleDialect(makeProvider('https://dashscope.aliyuncs.com.example.com/v1'))).toBe(
        'default'
      )
    })
  })

  describe('encodeReasoningEffortForDialect', () => {
    it('default not sent', () => {
      expect(encodeReasoningEffortForDialect('default', 'default')).toEqual({})
      expect(encodeReasoningEffortForDialect('enable_thinking', 'default')).toEqual({})
    })
    it('none mapping', () => {
      expect(encodeReasoningEffortForDialect('default', 'none')).toEqual({ reasoningEffort: 'none' })
      expect(encodeReasoningEffortForDialect('enable_thinking', 'none')).toEqual({ enable_thinking: false })
    })
    it('positive mappings with xhigh->max', () => {
      expect(encodeReasoningEffortForDialect('default', 'high')).toEqual({ reasoningEffort: 'high' })
      expect(encodeReasoningEffortForDialect('default', 'xhigh')).toEqual({ reasoningEffort: 'max' })
      expect(encodeReasoningEffortForDialect('default', 'low')).toEqual({ reasoningEffort: 'low' })
      expect(encodeReasoningEffortForDialect('default', 'minimal')).toEqual({ reasoningEffort: 'minimal' })
      expect(encodeReasoningEffortForDialect('default', 'medium')).toEqual({ reasoningEffort: 'medium' })
      expect(encodeReasoningEffortForDialect('default', 'auto')).toEqual({ reasoningEffort: 'auto' })
      expect(encodeReasoningEffortForDialect('enable_thinking', 'high')).toEqual({
        enable_thinking: true,
        reasoningEffort: 'high'
      })
      expect(encodeReasoningEffortForDialect('enable_thinking', 'xhigh')).toEqual({
        enable_thinking: true,
        reasoningEffort: 'max'
      })
      expect(encodeReasoningEffortForDialect('enable_thinking', 'auto')).toEqual({
        enable_thinking: true,
        reasoningEffort: 'auto'
      })
      expect(encodeReasoningEffortForDialect('enable_thinking', 'minimal')).toEqual({
        enable_thinking: true,
        reasoningEffort: 'minimal'
      })
    })
    it('never mixes thinking object', () => {
      for (const dialect of ['default', 'enable_thinking'] as const) {
        for (const eff of ['none', 'low', 'medium', 'high', 'xhigh', 'auto'] as const) {
          const res: any = encodeReasoningEffortForDialect(dialect, eff)
          expect(res).not.toHaveProperty('thinking')
        }
      }
    })
  })

  describe('getReasoningEffort — dialect orthogonal to model name', () => {
    it('unknown/custom host arbitrary model none -> reasoningEffort none (single field, no thinking/enable_thinking)', async () => {
      const provider = makeProvider('https://my-proxy.example.com/v1', 'custom')
      await withProvider(provider, () => {
        for (const mid of ['grok-3-mini', 'deepseek-v4', 'qwen3-8b', 'custom-model-xyz', 'gpt-5.1']) {
          const res: any = getReasoningEffort(makeAssistant('none'), makeModel(mid, 'custom'))
          expect(res).toEqual({ reasoningEffort: 'none' })
          expect(res).not.toHaveProperty('thinking')
          expect(res).not.toHaveProperty('enable_thinking')
        }
      })
    })

    it('DeepSeek official api.deepseek.com none same single field (no dual, no enable_thinking)', async () => {
      const provider = makeProvider('https://api.deepseek.com', 'deepseek')
      await withProvider(provider, () => {
        for (const mid of ['deepseek-v4', 'deepseek-reasoner', 'deepseek-v3.2', 'grok-3-mini']) {
          const res: any = getReasoningEffort(makeAssistant('none'), makeModel(mid, 'deepseek'))
          expect(res).toEqual({ reasoningEffort: 'none' })
          expect(res).not.toHaveProperty('thinking')
          expect(res).not.toHaveProperty('enable_thinking')
        }
      })
    })

    it('SiliconFlow arbitrary model none -> enable_thinking:false (orthogonal, e.g., plain models)', async () => {
      const provider = makeProvider('https://api.siliconflow.cn/v1', 'silicon')
      await withProvider(provider, () => {
        for (const mid of ['grok-3-mini', 'deepseek-v4', 'qwen3-8b', 'custom-model']) {
          const res: any = getReasoningEffort(makeAssistant('none'), makeModel(mid, 'silicon'))
          expect(res).toEqual({ enable_thinking: false })
          expect(res).not.toHaveProperty('thinking')
          expect(res).not.toHaveProperty('reasoningEffort')
        }
      })
    })

    it('DashScope arbitrary model none -> enable_thinking:false', async () => {
      const provider = makeProvider('https://dashscope.aliyuncs.com/compatible-mode/v1', 'dashscope')
      await withProvider(provider, () => {
        for (const mid of ['deepseek-v3.2', 'grok-3-mini', 'qwen3-8b']) {
          const res: any = getReasoningEffort(makeAssistant('none'), makeModel(mid, 'dashscope'))
          expect(res).toEqual({ enable_thinking: false })
          expect(res).not.toHaveProperty('thinking')
          expect(res).not.toHaveProperty('reasoningEffort')
        }
      })
    })

    it('default dialect positive efforts map with xhigh->max (no enable_thinking)', async () => {
      const provider = makeProvider('https://unknown.example.com/v1', 'custom')
      await withProvider(provider, () => {
        expect(getReasoningEffort(makeAssistant('high'), makeModel('any-model'))).toEqual({ reasoningEffort: 'high' })
        expect(getReasoningEffort(makeAssistant('xhigh'), makeModel('any-model'))).toEqual({ reasoningEffort: 'max' })
        expect(getReasoningEffort(makeAssistant('auto'), makeModel('any-model'))).toEqual({ reasoningEffort: 'auto' })
        expect(getReasoningEffort(makeAssistant('low'), makeModel('any-model'))).toEqual({ reasoningEffort: 'low' })
        expect(getReasoningEffort(makeAssistant('minimal'), makeModel('any-model'))).toEqual({
          reasoningEffort: 'minimal'
        })
        expect(getReasoningEffort(makeAssistant('medium'), makeModel('any-model'))).toEqual({
          reasoningEffort: 'medium'
        })
        const res: any = getReasoningEffort(makeAssistant('high'), makeModel('deepseek-v4'))
        expect(res).not.toHaveProperty('enable_thinking')
        expect(res).not.toHaveProperty('thinking')
      })
    })

    it('enable_thinking dialect positive efforts -> enable_thinking:true + reasoningEffort', async () => {
      const silicon = makeProvider('https://api.siliconflow.cn/v1', 'silicon')
      await withProvider(silicon, () => {
        expect(getReasoningEffort(makeAssistant('high'), makeModel('grok-3-mini'))).toEqual({
          enable_thinking: true,
          reasoningEffort: 'high'
        })
        expect(getReasoningEffort(makeAssistant('xhigh'), makeModel('grok-3-mini'))).toEqual({
          enable_thinking: true,
          reasoningEffort: 'max'
        })
        expect(getReasoningEffort(makeAssistant('auto'), makeModel('any-model'))).toEqual({
          enable_thinking: true,
          reasoningEffort: 'auto'
        })
      })
      const dash = makeProvider('https://dashscope.aliyuncs.com/compatible-mode/v1', 'dashscope')
      await withProvider(dash, () => {
        expect(getReasoningEffort(makeAssistant('medium'), makeModel('any-model'))).toEqual({
          enable_thinking: true,
          reasoningEffort: 'medium'
        })
        // hybrid-like name still only dialect
        expect(getReasoningEffort(makeAssistant('high'), makeModel('deepseek-v3.2'))).toEqual({
          enable_thinking: true,
          reasoningEffort: 'high'
        })
      })
    })

    it('hostname spoof / query / invalid fallback to default dialect (single reasoningEffort none)', async () => {
      for (const host of [
        'https://proxy.example.com/?target=api.siliconflow.cn',
        'https://siliconflow.cn.example.com/v1',
        'https://proxy.example.com/?target=dashscope.aliyuncs.com',
        'https://dashscope.aliyuncs.com.example.com/v1',
        'not a url',
        'api.siliconflow.cn.example.com/v1'
      ]) {
        const provider = makeProvider(host, 'custom')
        await withProvider(provider, () => {
          const res: any = getReasoningEffort(makeAssistant('none'), makeModel('deepseek-v4'))
          expect(res).toEqual({ reasoningEffort: 'none' })
          expect(res).not.toHaveProperty('enable_thinking')
          expect(res).not.toHaveProperty('thinking')
        })
      }
    })

    it('subdomain still enable_thinking', async () => {
      const p1 = makeProvider('https://foo.api.siliconflow.cn/v1', 'custom')
      await withProvider(p1, () => {
        expect(getReasoningEffort(makeAssistant('none'), makeModel('any'))).toEqual({ enable_thinking: false })
        expect(getReasoningEffort(makeAssistant('high'), makeModel('any'))).toEqual({
          enable_thinking: true,
          reasoningEffort: 'high'
        })
      })
      const p2 = makeProvider('https://sub.dashscope.aliyuncs.com/compatible-mode/v1', 'custom')
      await withProvider(p2, () => {
        expect(getReasoningEffort(makeAssistant('none'), makeModel('any'))).toEqual({ enable_thinking: false })
      })
    })

    it('default dialect no mixing of thinking', async () => {
      const provider = makeProvider('https://unknown.example.com/v1')
      await withProvider(provider, () => {
        for (const eff of ['none', 'low', 'high', 'xhigh', 'auto'] as const) {
          const res: any = getReasoningEffort(makeAssistant(eff), makeModel('any'))
          expect(res).not.toHaveProperty('thinking')
        }
      })
    })

    it('default returns {} (no wire field)', async () => {
      const provider = makeProvider('https://unknown.example.com/v1')
      await withProvider(provider, () => {
        expect(getReasoningEffort(makeAssistant('default'), makeModel('any'))).toEqual({})
        expect(getReasoningEffort(makeAssistant(undefined as any), makeModel('any'))).toEqual({})
      })
      const silicon = makeProvider('https://api.siliconflow.cn/v1')
      await withProvider(silicon, () => {
        expect(getReasoningEffort(makeAssistant('default'), makeModel('any'))).toEqual({})
      })
    })

    it('DeepSeek model on unknown host -> default dialect (orthogonal)', async () => {
      const provider = makeProvider('https://unknown.example.com/v1', 'custom')
      await withProvider(provider, () => {
        const res: any = getReasoningEffort(makeAssistant('high'), makeModel('deepseek-v4'))
        expect(res).toEqual({ reasoningEffort: 'high' })
        expect(res).not.toHaveProperty('enable_thinking')
      })
    })

    it('ordinary model on SiliconFlow -> enable_thinking dialect (orthogonal)', async () => {
      const provider = makeProvider('https://api.siliconflow.cn/v1', 'silicon')
      await withProvider(provider, () => {
        const res: any = getReasoningEffort(makeAssistant('none'), makeModel('grok-3-mini'))
        expect(res).toEqual({ enable_thinking: false })
      })
    })
  })
})
