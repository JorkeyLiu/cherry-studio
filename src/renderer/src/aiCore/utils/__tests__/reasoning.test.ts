/**
 * reasoning.ts Unit Tests
 * Tests for reasoning parameter generation utilities
 */

import { getStoreSetting } from '@renderer/hooks/useSettings'
import type { SettingsState } from '@renderer/store/settings'
import type { Assistant, Model } from '@renderer/types'
import { SystemProviderIds } from '@renderer/types'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getAnthropicReasoningParams,
  getCustomParameters,
  getGeminiReasoningParams,
  getOpenAIReasoningParams,
  getReasoningEffort,
  getThinkingBudget
} from '../reasoning'

function defaultGetStoreSetting<K extends keyof SettingsState>(key: K): SettingsState[K] {
  if (key === 'openAI') {
    return {
      summaryText: 'auto',
      verbosity: 'medium'
    } as SettingsState[K]
  }
  return undefined as SettingsState[K]
}

// Mock dependencies
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

vi.mock('@renderer/utils/provider', () => ({
  isSupportEnableThinkingProvider: vi.fn((provider) => {
    return [SystemProviderIds.dashscope, SystemProviderIds.silicon].includes(provider.id)
  })
}))

vi.mock('@renderer/config/models', async (importOriginal) => {
  const actual: any = await importOriginal()
  return {
    ...actual,
    isReasoningModel: vi.fn(() => false),
    isOpenAIDeepResearchModel: vi.fn(() => false),
    isOpenAIModel: vi.fn(() => false),
    isSupportedReasoningEffortOpenAIModel: vi.fn(() => false),
    isSupportedThinkingTokenQwenModel: vi.fn(() => false),
    isQwenReasoningModel: vi.fn(() => false),
    isSupportedThinkingTokenClaudeModel: vi.fn(() => false),
    isSupportedThinkingTokenGeminiModel: vi.fn(() => false),
    isSupportedThinkingTokenDoubaoModel: vi.fn(() => false),
    isSupportedThinkingTokenZhipuModel: vi.fn(() => false),
    isSupportedThinkingTokenMiMoModel: vi.fn(() => false),
    isSupportedThinkingTokenKimiModel: vi.fn(() => false),
    isSupportedReasoningEffortModel: vi.fn(() => false),
    isDeepSeekHybridInferenceModel: vi.fn(() => false),
    isDeepSeekV4PlusModel: vi.fn(() => false),
    isSupportedReasoningEffortGrokModel: vi.fn(() => false),
    getThinkModelType: vi.fn(() => 'default'),
    isDoubaoSeedAfter251015: vi.fn(() => false),
    isDoubaoThinkingAutoModel: vi.fn(() => false),
    isGrok4FastReasoningModel: vi.fn(() => false),
    isGrokReasoningModel: vi.fn(() => false),
    isOpenAIReasoningModel: vi.fn(() => false),
    isQwenAlwaysThinkModel: vi.fn(() => false),
    isHostedGemma4ThinkingModel: vi.fn(() => false),
    isSupportedThinkingTokenHunyuanModel: vi.fn(() => false),
    isSupportedThinkingTokenModel: vi.fn(() => false),
    isMiniMaxReasoningModel: vi.fn(() => false),
    isSupportNoneReasoningEffortModel: vi.fn(() => false),
    getModelSupportedReasoningEffortOptions: vi.fn(() => undefined),
    isGPT51SeriesModel: vi.fn(() => false),
    isGemini3ThinkingTokenModel: vi.fn(() => false),
    findTokenLimit: vi.fn(actual.findTokenLimit)
  }
})

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: vi.fn(defaultGetStoreSetting)
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: vi.fn((assistant) => ({
    maxTokens: assistant?.settings?.maxTokens || 4096,
    reasoning_effort: assistant?.settings?.reasoning_effort
  })),
  getProviderByModel: vi.fn((model) => ({
    id: model.provider,
    name: 'Test Provider'
  })),
  getDefaultAssistant: vi.fn(() => ({
    id: 'default',
    name: 'Default Assistant',
    settings: {}
  }))
}))

const ensureWindowApi = () => {
  const globalWindow = window as any
  globalWindow.api = globalWindow.api || {}
  globalWindow.api.getAppInfo = globalWindow.api.getAppInfo || vi.fn(async () => ({ notesPath: '' }))
}

ensureWindowApi()

describe('reasoning utils', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('getReasoningEffort (debranded: model family + user controls only)', () => {
    const makeModel = (overrides: Partial<Model> = {}): Model =>
      ({
        id: 'qwen3-max-123',
        name: 'Qwen3 Max',
        provider: 'custom-a',
        ...overrides
      }) as Model

    const makeAssistant = (reasoning_effort?: any): Assistant =>
      ({
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort }
      }) as Assistant

    it('should return empty object for non-reasoning model', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(false)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      expect(getReasoningEffort(makeAssistant('high'), makeModel())).toEqual({})
    })

    it('should return {} when reasoning effort is unset or default', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      expect(getReasoningEffort(makeAssistant(undefined), makeModel())).toEqual({})
      expect(getReasoningEffort(makeAssistant('default'), makeModel())).toEqual({})
    })

    it('should throw when the owning provider entry is missing (never silently substitute)', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue(null as any)

      expect(() => getReasoningEffort(makeAssistant('high'), makeModel())).toThrow('Model provider is not configured')
    })

    it('should yield identical results for different provider ids with same type/model/options', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isQwenReasoningModel).mockReturnValue(true)
      vi.mocked(models.isSupportedThinkingTokenModel).mockReturnValue(true)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')

      const assistant = makeAssistant('high')
      const results: any[] = []
      for (const pid of ['dashscope', 'silicon', 'nvidia', 'openrouter', 'custom-a', 'custom-b']) {
        vi.mocked(gpm).mockReturnValue({ id: pid, name: pid, type: 'openai' } as any)
        results.push(getReasoningEffort(assistant, makeModel({ provider: pid })))
      }
      for (const r of results.slice(1)) {
        expect(r).toEqual(results[0])
      }
      expect(results[0]).toEqual({ thinking: { type: 'enabled' } })
      expect(results[0]).not.toHaveProperty('enable_thinking')
      expect(results[0]).not.toHaveProperty('chat_template_kwargs')
      expect(results[0]).not.toHaveProperty('extra_body')
    })

    it('should disable thinking generically when effort is none (no vendor keys)', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isQwenReasoningModel).mockReturnValue(true)
      vi.mocked(models.isSupportedThinkingTokenModel).mockReturnValue(true)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      expect(getReasoningEffort(makeAssistant('none'), makeModel())).toEqual({ thinking: { type: 'disabled' } })
    })

    it('should use generic reasoningEffort none for none-capable effort models', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isSupportNoneReasoningEffortModel).mockReturnValue(true)
      vi.mocked(models.isSupportedThinkingTokenModel).mockReturnValue(false)
      vi.mocked(models.isDeepSeekV4PlusModel).mockReturnValue(false)
      vi.mocked(models.isDeepSeekHybridInferenceModel).mockReturnValue(false)
      vi.mocked(models.isQwenReasoningModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenHunyuanModel).mockReturnValue(false)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      expect(getReasoningEffort(makeAssistant('none'), makeModel({ id: 'gpt-5.1' }))).toEqual({
        reasoningEffort: 'none'
      })
    })

    it('should enable DeepSeek hybrid generically on any connection', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isDeepSeekHybridInferenceModel).mockReturnValue(true)
      vi.mocked(models.isDeepSeekV4PlusModel).mockReturnValue(false)
      vi.mocked(models.isGrok4FastReasoningModel).mockReturnValue(false)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')

      const assistant = makeAssistant('high')
      vi.mocked(gpm).mockReturnValue({ id: 'brand-a', name: 'A', type: 'openai' } as any)
      const ra = getReasoningEffort(assistant, makeModel({ id: 'deepseek-chat', provider: 'brand-a' }))
      vi.mocked(gpm).mockReturnValue({ id: 'brand-b', name: 'B', type: 'openai' } as any)
      const rb = getReasoningEffort(assistant, makeModel({ id: 'deepseek-chat', provider: 'brand-b' }))
      expect(ra).toEqual({ thinking: { type: 'enabled' } })
      expect(rb).toEqual(ra)
    })

    it('should use generic reasoningEffort for effort families with supported-option fallback', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isDeepSeekV4PlusModel).mockReturnValue(false)
      vi.mocked(models.isDeepSeekHybridInferenceModel).mockReturnValue(false)
      vi.mocked(models.isQwenReasoningModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenHunyuanModel).mockReturnValue(false)
      vi.mocked(models.isGrok4FastReasoningModel).mockReturnValue(false)
      vi.mocked(models.isSupportedReasoningEffortModel).mockReturnValue(true)
      vi.mocked(models.getModelSupportedReasoningEffortOptions).mockReturnValue(['default', 'low', 'medium', 'high'])
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      expect(getReasoningEffort(makeAssistant('medium'), makeModel({ id: 'grok-3-mini' }))).toEqual({
        reasoningEffort: 'medium'
      })
      // Unsupported selection falls back to the first supported value, never a vendor key.
      expect(getReasoningEffort(makeAssistant('xhigh' as any), makeModel({ id: 'grok-3-mini' }))).toEqual({
        reasoningEffort: 'low'
      })
    })

    it('should use generic reasoningEffort for Gemini thinking families (no extra_body)', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isDeepSeekV4PlusModel).mockReturnValue(false)
      vi.mocked(models.isDeepSeekHybridInferenceModel).mockReturnValue(false)
      vi.mocked(models.isQwenReasoningModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenHunyuanModel).mockReturnValue(false)
      vi.mocked(models.isGrok4FastReasoningModel).mockReturnValue(false)
      vi.mocked(models.isSupportedReasoningEffortModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      const result = getReasoningEffort(makeAssistant('high'), makeModel({ id: 'gemini-2.5-flash' }))
      expect(result).toEqual({ reasoningEffort: 'high' })
      expect(result).not.toHaveProperty('extra_body')
    })

    it('should keep unknown models requestable (empty params, never throws when provider exists)', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isDeepSeekV4PlusModel).mockReturnValue(false)
      vi.mocked(models.isDeepSeekHybridInferenceModel).mockReturnValue(false)
      vi.mocked(models.isQwenReasoningModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenHunyuanModel).mockReturnValue(false)
      vi.mocked(models.isGrok4FastReasoningModel).mockReturnValue(false)
      vi.mocked(models.isSupportedReasoningEffortModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenGeminiModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenClaudeModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenDoubaoModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenZhipuModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenMiMoModel).mockReturnValue(false)
      vi.mocked(models.isSupportedThinkingTokenKimiModel).mockReturnValue(false)
      vi.mocked(models.isMiniMaxReasoningModel).mockReturnValue(false)
      vi.mocked(models.isOpenAIDeepResearchModel).mockReturnValue(false)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      expect(getReasoningEffort(makeAssistant('high'), makeModel({ id: 'some-unknown-model-xyz' }))).toEqual({})
    })

    it('should never emit vendor private keys from the generic path', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isQwenReasoningModel).mockReturnValue(true)
      vi.mocked(models.isSupportedThinkingTokenModel).mockReturnValue(true)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      for (const effort of ['low', 'medium', 'high', 'none'] as const) {
        const result: any = getReasoningEffort(makeAssistant(effort), makeModel())
        expect(result).not.toHaveProperty('enable_thinking')
        expect(result).not.toHaveProperty('chat_template_kwargs')
        expect(result).not.toHaveProperty('extra_body')
        expect(result).not.toHaveProperty('disable_reasoning')
        expect(result).not.toHaveProperty('thinking_budget')
        expect(result).not.toHaveProperty('incremental_output')
      }
    })

    it('should emit camelCase reasoningEffort for deep-research models (never snake_case)', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isOpenAIDeepResearchModel).mockReturnValue(true)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      const result: any = getReasoningEffort(
        makeAssistant('high'),
        makeModel({ id: 'o3-deep-research', provider: 'custom-a' })
      )
      expect(result).toEqual({ reasoningEffort: 'medium' })
      expect(result).not.toHaveProperty('reasoning_effort')
    })

    it('should emit camelCase reasoningEffort for DeepSeek V4+ models (never snake_case)', async () => {
      const models = await import('@renderer/config/models')
      vi.mocked(models.isReasoningModel).mockReturnValue(true)
      vi.mocked(models.isOpenAIDeepResearchModel).mockReturnValue(false)
      vi.mocked(models.isDeepSeekV4PlusModel).mockReturnValue(true)
      vi.mocked(models.isDeepSeekHybridInferenceModel).mockReturnValue(false)
      vi.mocked(models.isGrok4FastReasoningModel).mockReturnValue(false)
      const { getProviderByModel: gpm } = await import('@renderer/services/AssistantService')
      vi.mocked(gpm).mockReturnValue({ id: 'custom-a', name: 'A', type: 'openai' } as any)

      const high: any = getReasoningEffort(
        makeAssistant('high'),
        makeModel({ id: 'deepseek-v4', provider: 'custom-a' })
      )
      expect(high).toEqual({ thinking: { type: 'enabled' }, reasoningEffort: 'high' })
      expect(high).not.toHaveProperty('reasoning_effort')

      const xhigh: any = getReasoningEffort(
        makeAssistant('xhigh' as any),
        makeModel({ id: 'deepseek-v4', provider: 'custom-a' })
      )
      expect(xhigh).toEqual({ thinking: { type: 'enabled' }, reasoningEffort: 'max' })
      expect(xhigh).not.toHaveProperty('reasoning_effort')
    })
  })

  describe('getOpenAIReasoningParams', () => {
    it('should return empty object for non-reasoning model', async () => {
      const model: Model = {
        id: 'gpt-4',
        name: 'GPT-4',
        provider: SystemProviderIds.openai
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {}
      } as Assistant

      const result = getOpenAIReasoningParams(assistant, model)
      expect(result).toEqual({})
    })

    it('should return empty when no reasoning effort set', async () => {
      const model: Model = {
        id: 'o1-preview',
        name: 'O1 Preview',
        provider: SystemProviderIds.openai
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {}
      } as Assistant

      const result = getOpenAIReasoningParams(assistant, model)
      expect(result).toEqual({})
    })

    it('should return reasoning effort for OpenAI models', async () => {
      const { isReasoningModel, isOpenAIModel, isSupportedReasoningEffortOpenAIModel } = await import(
        '@renderer/config/models'
      )

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isOpenAIModel).mockReturnValue(true)
      vi.mocked(isSupportedReasoningEffortOpenAIModel).mockReturnValue(true)

      const model: Model = {
        id: 'gpt-5.1',
        name: 'GPT 5.1',
        provider: SystemProviderIds.openai
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'high'
        }
      } as Assistant

      const result = getOpenAIReasoningParams(assistant, model)
      expect(result).toEqual({
        reasoningEffort: 'high',
        reasoningSummary: 'auto'
      })
    })

    it('should include reasoning summary when not o1-pro', async () => {
      const { isReasoningModel, isOpenAIModel, isSupportedReasoningEffortOpenAIModel } = await import(
        '@renderer/config/models'
      )

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isOpenAIModel).mockReturnValue(true)
      vi.mocked(isSupportedReasoningEffortOpenAIModel).mockReturnValue(true)

      const model: Model = {
        id: 'gpt-5',
        provider: SystemProviderIds.openai
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'medium'
        }
      } as Assistant

      const result = getOpenAIReasoningParams(assistant, model)
      expect(result).toEqual({
        reasoningEffort: 'medium',
        reasoningSummary: 'auto'
      })
    })

    it('should not include reasoning summary for o1-pro', async () => {
      const { isReasoningModel, isOpenAIDeepResearchModel, isSupportedReasoningEffortOpenAIModel } = await import(
        '@renderer/config/models'
      )

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isOpenAIDeepResearchModel).mockReturnValue(false)
      vi.mocked(isSupportedReasoningEffortOpenAIModel).mockReturnValue(true)
      vi.mocked(getStoreSetting).mockReturnValue({ summaryText: 'off' } as any)

      const model: Model = {
        id: 'o1-pro',
        name: 'O1 Pro',
        provider: SystemProviderIds.openai
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'high'
        }
      } as Assistant

      const result = getOpenAIReasoningParams(assistant, model)
      expect(result).toEqual({
        reasoningEffort: 'high',
        reasoningSummary: undefined
      })
    })

    it('should force medium effort for deep research models', async () => {
      const { isReasoningModel, isOpenAIModel, isOpenAIDeepResearchModel, isSupportedReasoningEffortOpenAIModel } =
        await import('@renderer/config/models')
      const { getStoreSetting } = await import('@renderer/hooks/useSettings')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isOpenAIModel).mockReturnValue(true)
      vi.mocked(isOpenAIDeepResearchModel).mockReturnValue(true)
      vi.mocked(isSupportedReasoningEffortOpenAIModel).mockReturnValue(true)
      vi.mocked(getStoreSetting).mockReturnValue({ summaryText: 'off' } as any)

      const model: Model = {
        id: 'o3-deep-research',
        name: 'O3 Mini',
        provider: SystemProviderIds.openai
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'high'
        }
      } as Assistant

      const result = getOpenAIReasoningParams(assistant, model)
      expect(result).toEqual({
        reasoningEffort: 'medium',
        reasoningSummary: 'off'
      })
    })
  })

  describe('getAnthropicReasoningParams', () => {
    it('should return empty for non-reasoning model', async () => {
      const { isReasoningModel } = await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(false)

      const model: Model = {
        id: 'claude-3-5-sonnet',
        name: 'Claude 3.5 Sonnet',
        provider: SystemProviderIds.anthropic
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {}
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({})
    })

    it('should return disabled thinking when reasoning effort is none', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel } = await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(false)

      const model: Model = {
        id: 'claude-3-7-sonnet',
        name: 'Claude 3.7 Sonnet',
        provider: SystemProviderIds.anthropic
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'none'
        }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: {
          type: 'disabled'
        }
      })
    })

    it('should return enabled thinking with budget for Claude models', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel } = await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(true)

      const model: Model = {
        id: 'claude-3-7-sonnet',
        name: 'Claude 3.7 Sonnet',
        provider: SystemProviderIds.anthropic
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'medium',
          maxTokens: 4096
        }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: {
          type: 'enabled',
          budgetTokens: 4096
        }
      })
    })

    it.each([
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }
    ])(
      'should use adaptive thinking with native xhigh effort and summarized display for $name',
      async ({ id, name }) => {
        const { isReasoningModel, isSupportedThinkingTokenClaudeModel } = await import('@renderer/config/models')

        vi.mocked(isReasoningModel).mockReturnValue(true)
        vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(true)

        const model: Model = {
          id,
          name,
          provider: SystemProviderIds.anthropic
        } as Model

        const assistant: Assistant = {
          id: 'test',
          name: 'Test',
          settings: { reasoning_effort: 'xhigh' }
        } as Assistant

        const result = getAnthropicReasoningParams(assistant, model)
        expect(result).toEqual({
          thinking: { type: 'adaptive', display: 'summarized' },
          effort: 'xhigh'
        })
      }
    )

    it('should use adaptive thinking for future Claude Opus 4 minor versions by default', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel } = await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(true)

      const model: Model = {
        id: 'claude-opus-4-10',
        name: 'Claude Opus 4.10',
        provider: SystemProviderIds.anthropic
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'low' }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'low'
      })
    })

    it('should use adaptive thinking with summarized display even without explicit effort for Claude Opus 4.7', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel } = await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(true)

      const model: Model = {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        provider: SystemProviderIds.anthropic
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'auto' }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' }
      })
    })

    it('should use fallback budgetTokens when findTokenLimit returns undefined for Claude model', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel, findTokenLimit } = await import(
        '@renderer/config/models'
      )

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(true)
      vi.mocked(findTokenLimit).mockReturnValue(undefined)

      const model: Model = {
        id: 'claude-unknown-model',
        name: 'Claude Unknown',
        provider: SystemProviderIds.anthropic
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'high',
          maxTokens: 8192
        }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: {
          type: 'enabled',
          budgetTokens: expect.any(Number)
        }
      })
      // budgetTokens must be present and >= 1024 (the minimum enforced by computeBudgetTokens)
      const thinking = result.thinking as { type: 'enabled'; budgetTokens?: number }
      expect(thinking.budgetTokens).toBeGreaterThanOrEqual(1024)
    })

    it('should use fallback budgetTokens for non-Claude model on Anthropic endpoint when token limit is unknown', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel, findTokenLimit } = await import(
        '@renderer/config/models'
      )

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(false)
      vi.mocked(findTokenLimit).mockReturnValue(undefined)

      const model: Model = {
        id: 'kimi-reasoning-model',
        name: 'Kimi Reasoning',
        provider: 'custom-provider'
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'medium',
          maxTokens: 4096
        }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      // Non-Claude models on Anthropic endpoint should also get fallback budgetTokens
      expect(result).toEqual({
        thinking: {
          type: 'enabled',
          budgetTokens: expect.any(Number)
        },
        sendReasoning: true
      })
      const thinking = result.thinking as { type: 'enabled'; budgetTokens?: number }
      expect(thinking.budgetTokens).toBeGreaterThanOrEqual(1024)
    })

    it('should produce different fallback budgetTokens for different effort levels', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel, findTokenLimit } = await import(
        '@renderer/config/models'
      )

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(true)
      vi.mocked(findTokenLimit).mockReturnValue(undefined)

      const model: Model = {
        id: 'claude-unknown-model',
        name: 'Claude Unknown',
        provider: SystemProviderIds.anthropic
      } as Model

      const lowAssistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'low', maxTokens: 4096 }
      } as Assistant

      const highAssistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'high', maxTokens: 4096 }
      } as Assistant

      const lowResult = getAnthropicReasoningParams(lowAssistant, model)
      const highResult = getAnthropicReasoningParams(highAssistant, model)

      // Higher effort should produce higher or equal budgetTokens
      const lowThinking = lowResult.thinking as { type: 'enabled'; budgetTokens?: number }
      const highThinking = highResult.thinking as { type: 'enabled'; budgetTokens?: number }
      expect(highThinking.budgetTokens).toBeGreaterThanOrEqual(lowThinking.budgetTokens!)
    })

    it('should map DeepSeek V4+ xhigh effort to max on the Claude endpoint', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel, isDeepSeekV4PlusModel, findTokenLimit } =
        await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(false)
      vi.mocked(isDeepSeekV4PlusModel).mockReturnValue(true)
      vi.mocked(findTokenLimit).mockReturnValue(undefined)

      const model: Model = {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        provider: 'deepseek'
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'xhigh', maxTokens: 4096 }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: { type: 'enabled', budgetTokens: expect.any(Number) },
        sendReasoning: true,
        effort: 'max'
      })
    })

    it('should map DeepSeek V4+ high effort to high on the Claude endpoint', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel, isDeepSeekV4PlusModel, findTokenLimit } =
        await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(false)
      vi.mocked(isDeepSeekV4PlusModel).mockReturnValue(true)
      vi.mocked(findTokenLimit).mockReturnValue(undefined)

      const model: Model = {
        id: 'deepseek-v4',
        name: 'DeepSeek V4',
        provider: 'deepseek'
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'high', maxTokens: 4096 }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: { type: 'enabled', budgetTokens: expect.any(Number) },
        sendReasoning: true,
        effort: 'high'
      })
    })

    it('should not add effort for DeepSeek V4+ when effort is outside the documented set', async () => {
      // Guard against silent downgrade: if MODEL_SUPPORTED_REASONING_EFFORT.deepseek_v4 ever gains
      // new levels (low/medium/auto), the explicit effortMap must be extended — otherwise effort
      // is omitted here rather than being silently mapped to 'high'.
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel, isDeepSeekV4PlusModel, findTokenLimit } =
        await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(false)
      vi.mocked(isDeepSeekV4PlusModel).mockReturnValue(true)
      vi.mocked(findTokenLimit).mockReturnValue(undefined)

      const model: Model = {
        id: 'deepseek-v4',
        name: 'DeepSeek V4',
        provider: 'deepseek'
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'medium', maxTokens: 4096 }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: { type: 'enabled', budgetTokens: expect.any(Number) },
        sendReasoning: true
      })
      expect(result).not.toHaveProperty('effort')
    })

    it('should not add effort for non-DeepSeek models on the Claude endpoint', async () => {
      const { isReasoningModel, isSupportedThinkingTokenClaudeModel, isDeepSeekV4PlusModel, findTokenLimit } =
        await import('@renderer/config/models')

      vi.mocked(isReasoningModel).mockReturnValue(true)
      vi.mocked(isSupportedThinkingTokenClaudeModel).mockReturnValue(false)
      vi.mocked(isDeepSeekV4PlusModel).mockReturnValue(false)
      vi.mocked(findTokenLimit).mockReturnValue(undefined)

      const model: Model = {
        id: 'kimi-k2-reasoning',
        name: 'Kimi K2 Reasoning',
        provider: 'custom-provider'
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'xhigh', maxTokens: 4096 }
      } as Assistant

      const result = getAnthropicReasoningParams(assistant, model)
      expect(result).toEqual({
        thinking: { type: 'enabled', budgetTokens: expect.any(Number) },
        sendReasoning: true
      })
      expect(result).not.toHaveProperty('effort')
    })
  })

  describe('getGeminiReasoningParams', () => {
    // Use beforeAll to avoid per-test dynamic imports while keeping compatibility
    // with the async vi.mock factory (static imports of the mocked module break other tests)
    let mockModels: any

    beforeAll(async () => {
      mockModels = await import('@renderer/config/models')
    })

    it('should return empty for non-reasoning model', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(false)

      const model: Model = {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {}
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({})
    })

    it('should return empty when isReasoningModel is true but not a Gemini thinking model', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(false)

      const model: Model = {
        id: 'some-reasoning-model',
        name: 'Some Model',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'high' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({})
    })

    it('should return empty when reasoning effort is not set', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {}
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({})
    })

    it('should return empty when reasoning effort is default', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'default' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({})
    })

    it('should disable thinking for Flash models when reasoning effort is none', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'none'
        }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: false,
          thinkingBudget: 0
        }
      })
    })

    it('should disable thinking for non-Flash models when reasoning effort is none (no thinkingBudget)', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'none'
        }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: false
        }
      })
    })

    it('should include thinkingLevel for Gemini 3 model with none effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isGemini3ThinkingTokenModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'none' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: 'minimal'
        }
      })
    })

    it('should return thinkingLevel for Gemini 3 model with low effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isGemini3ThinkingTokenModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'low' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'low'
        }
      })
    })

    it('should return thinkingLevel medium for Gemini 3 model with medium effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isGemini3ThinkingTokenModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'medium' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'medium'
        }
      })
    })

    it('should return thinkingLevel high for Gemini 3 model with high effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isGemini3ThinkingTokenModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'high' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'high'
        }
      })
    })

    it('should return thinkingLevel high for Gemini 3 model with xhigh effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isGemini3ThinkingTokenModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'xhigh' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'high'
        }
      })
    })

    it('should use undefined thinkingLevel for Gemini 3 model with auto effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isGemini3ThinkingTokenModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'auto' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      // auto maps to undefined thinkingLevel (let API decide), stays in Gemini 3 branch
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: undefined
        }
      })
    })

    it('should return thinkingLevel minimal for Gemini 3 model with minimal effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isGemini3ThinkingTokenModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'minimal' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'minimal'
        }
      })
    })

    it('should map hosted Gemma 4 minimal effort to minimal thinkingLevel without thoughts', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isHostedGemma4ThinkingModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemma-4-31b-it',
        name: 'Gemma 4 31B',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'minimal' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: 'minimal'
        }
      })
    })

    it('should map hosted Gemma 4 high effort to high thinkingLevel with thoughts', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.isHostedGemma4ThinkingModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemma-4-31b-it',
        name: 'Gemma 4 31B',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'high' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'high'
        }
      })
    })

    it('should enable thinking with budget for reasoning effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'medium'
        }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          thinkingBudget: expect.any(Number),
          includeThoughts: true
        }
      })
    })

    it('should compute thinkingBudget for old models with xhigh effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'xhigh' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      // EFFORT_RATIO['xhigh'] = 0.9, which is NOT > 1, so it should compute a budget
      expect(result).toEqual({
        thinkingConfig: {
          thinkingBudget: expect.any(Number),
          includeThoughts: true
        }
      })
    })

    it('should return thinkingBudget -1 for old models with auto effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)

      const model: Model = {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          reasoning_effort: 'auto'
        }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1
        }
      })
    })

    it('should omit thinkingBudget for old models when no token limit is found', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.findTokenLimit).mockReturnValue(undefined)

      const model: Model = {
        id: 'gemini-2.5-pro-unknown',
        name: 'Gemini 2.5 Pro Unknown',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'medium' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      // budget = Math.floor((0 - 0) * 0.5 + 0) = 0, so no thinkingBudget
      expect(result).toEqual({
        thinkingConfig: {
          includeThoughts: true
        }
      })
    })

    it('should calculate correct thinkingBudget for low effort', () => {
      vi.mocked(mockModels.isReasoningModel).mockReturnValue(true)
      vi.mocked(mockModels.isSupportedThinkingTokenGeminiModel).mockReturnValue(true)
      vi.mocked(mockModels.findTokenLimit).mockReturnValue({ min: 1024, max: 32768 })

      const model: Model = {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: SystemProviderIds.gemini
      } as Model

      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: { reasoning_effort: 'low' }
      } as Assistant

      const result = getGeminiReasoningParams(assistant, model)
      // EFFORT_RATIO['low'] = 0.05
      // budget = Math.floor((32768 - 1024) * 0.05 + 1024) = Math.floor(1587.2 + 1024) = 2611
      expect(result).toEqual({
        thinkingConfig: {
          thinkingBudget: 2611,
          includeThoughts: true
        }
      })
    })
  })

  describe('getCustomParameters', () => {
    it('should return empty object when no custom parameters', async () => {
      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {}
      } as Assistant

      const result = getCustomParameters(assistant)
      expect(result).toEqual({})
    })

    it('should return custom parameters as key-value pairs', async () => {
      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          customParameters: [
            { name: 'param1', value: 'value1', type: 'string' },
            { name: 'param2', value: 123, type: 'number' }
          ]
        }
      } as Assistant

      const result = getCustomParameters(assistant)
      expect(result).toEqual({
        param1: 'value1',
        param2: 123
      })
    })

    it('should parse JSON type parameters', async () => {
      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          customParameters: [{ name: 'config', value: '{"key": "value"}', type: 'json' }]
        }
      } as Assistant

      const result = getCustomParameters(assistant)
      expect(result).toEqual({
        config: { key: 'value' }
      })
    })

    it('should handle invalid JSON gracefully', async () => {
      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          customParameters: [{ name: 'invalid', value: '{invalid json', type: 'json' }]
        }
      } as Assistant

      const result = getCustomParameters(assistant)
      expect(result).toEqual({
        invalid: '{invalid json'
      })
    })

    it('should handle undefined JSON value', async () => {
      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          customParameters: [{ name: 'undef', value: 'undefined', type: 'json' }]
        }
      } as Assistant

      const result = getCustomParameters(assistant)
      expect(result).toEqual({
        undef: undefined
      })
    })

    it('should skip parameters with empty names', async () => {
      const assistant: Assistant = {
        id: 'test',
        name: 'Test',
        settings: {
          customParameters: [
            { name: '', value: 'value1', type: 'string' },
            { name: '  ', value: 'value2', type: 'string' },
            { name: 'valid', value: 'value3', type: 'string' }
          ]
        }
      } as Assistant

      const result = getCustomParameters(assistant)
      expect(result).toEqual({
        valid: 'value3'
      })
    })
  })

  describe('getThinkingBudget', () => {
    it('should return undefined when reasoningEffort is undefined', async () => {
      const result = getThinkingBudget(4096, undefined, 'claude-3-7-sonnet')
      expect(result).toBeUndefined()
    })

    it('should return undefined when reasoningEffort is none', async () => {
      const result = getThinkingBudget(4096, 'none', 'claude-3-7-sonnet')
      expect(result).toBeUndefined()
    })

    it('should return undefined when tokenLimit is not found', async () => {
      const { findTokenLimit } = await import('@renderer/config/models')
      vi.mocked(findTokenLimit).mockReturnValue(undefined)

      const result = getThinkingBudget(4096, 'medium', 'unknown-model')
      expect(result).toBeUndefined()
    })

    it('should calculate budget correctly when maxTokens is provided', async () => {
      const { findTokenLimit } = await import('@renderer/config/models')
      vi.mocked(findTokenLimit).mockReturnValue({ min: 1024, max: 32768 })

      const result = getThinkingBudget(4096, 'medium', 'claude-3-7-sonnet')
      // EFFORT_RATIO['medium'] = 0.5
      // budget = Math.floor((32768 - 1024) * 0.5 + 1024)
      // = Math.floor(31744 * 0.5 + 1024) = Math.floor(15872 + 1024) = 16896
      // budgetTokens = Math.min(16896, 4096) = 4096
      // result = Math.max(1024, 4096) = 4096
      expect(result).toBe(4096)
    })

    it('should use tokenLimit.max when maxTokens is undefined', async () => {
      const { findTokenLimit } = await import('@renderer/config/models')
      vi.mocked(findTokenLimit).mockReturnValue({ min: 1024, max: 32768 })

      const result = getThinkingBudget(undefined, 'medium', 'claude-3-7-sonnet')
      // When maxTokens is undefined, budget is not constrained by maxTokens
      // EFFORT_RATIO['medium'] = 0.5
      // budget = Math.floor((32768 - 1024) * 0.5 + 1024)
      // = Math.floor(31744 * 0.5 + 1024) = Math.floor(15872 + 1024) = 16896
      // result = Math.max(1024, 16896) = 16896
      expect(result).toBe(16896)
    })

    it('should enforce minimum budget of 1024', async () => {
      const { findTokenLimit } = await import('@renderer/config/models')
      vi.mocked(findTokenLimit).mockReturnValue({ min: 100, max: 1000 })

      const result = getThinkingBudget(500, 'low', 'claude-3-7-sonnet')
      // EFFORT_RATIO['low'] = 0.05
      // budget = Math.floor((1000 - 100) * 0.05 + 100)
      // = Math.floor(900 * 0.05 + 100) = Math.floor(45 + 100) = 145
      // budgetTokens = Math.min(145, 500) = 145
      // result = Math.max(1024, 145) = 1024
      expect(result).toBe(1024)
    })

    it('should respect effort ratio for high reasoning effort', async () => {
      const { findTokenLimit } = await import('@renderer/config/models')
      vi.mocked(findTokenLimit).mockReturnValue({ min: 1024, max: 32768 })

      const result = getThinkingBudget(8192, 'high', 'claude-3-7-sonnet')
      // EFFORT_RATIO['high'] = 0.8
      // budget = Math.floor((32768 - 1024) * 0.8 + 1024)
      // = Math.floor(31744 * 0.8 + 1024) = Math.floor(25395.2 + 1024) = 26419
      // budgetTokens = Math.min(26419, 8192) = 8192
      // result = Math.max(1024, 8192) = 8192
      expect(result).toBe(8192)
    })

    it('should use full token limit when maxTokens is undefined and reasoning effort is high', async () => {
      const { findTokenLimit } = await import('@renderer/config/models')
      vi.mocked(findTokenLimit).mockReturnValue({ min: 1024, max: 32768 })

      const result = getThinkingBudget(undefined, 'high', 'claude-3-7-sonnet')
      // When maxTokens is undefined, budget is not constrained by maxTokens
      // EFFORT_RATIO['high'] = 0.8
      // budget = Math.floor((32768 - 1024) * 0.8 + 1024)
      // = Math.floor(31744 * 0.8 + 1024) = Math.floor(25395.2 + 1024) = 26419
      // result = Math.max(1024, 26419) = 26419
      expect(result).toBe(26419)
    })
  })
})
