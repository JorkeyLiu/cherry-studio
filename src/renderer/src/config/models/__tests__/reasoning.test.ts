import type { Model } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isEmbeddingModel, isRerankModel } from '../embedding'
import { isOpenAIReasoningModel, isSupportedReasoningEffortOpenAIModel } from '../openai'
import {
  findTokenLimit,
  isClaude4SeriesModel,
  isClaude45ReasoningModel,
  isClaudeReasoningModel,
  isDeepSeekHybridInferenceModel,
  isDeepSeekV4PlusModel,
  isDoubaoSeedAfter251015,
  isDoubaoThinkingAutoModel,
  isFixedReasoningModel,
  isGeminiReasoningModel,
  isGrok4FastReasoningModel,
  isHunyuanReasoningModel,
  isInterleavedThinkingModel,
  isKimiReasoningModel,
  isLingReasoningModel,
  isMiniMaxReasoningModel,
  isPerplexityReasoningModel,
  isQwenAlwaysThinkModel,
  isReasoningModel,
  isStepReasoningModel,
  isSupportedReasoningEffortGrokModel,
  isSupportedReasoningEffortModel,
  isSupportedReasoningEffortPerplexityModel,
  isSupportedThinkingTokenDoubaoModel,
  isSupportedThinkingTokenGeminiModel,
  isSupportedThinkingTokenKimiModel,
  isSupportedThinkingTokenMiMoModel,
  isSupportedThinkingTokenModel,
  isSupportedThinkingTokenQwenModel,
  isSupportedThinkingTokenZhipuModel,
  isZhipuReasoningModel
} from '../reasoning'
import { isGemini3ThinkingTokenModel } from '../utils'
import { isTextToImageModel } from '../vision'

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      llm: {
        settings: {}
      }
    })
  }
}))

// FIXME: Idk why it's imported. Maybe circular dependency somewhere
vi.mock('@renderer/services/AssistantService.ts', () => ({
  getDefaultAssistant: () => {
    return {
      id: 'default',
      name: 'default',
      emoji: '😀',
      prompt: '',
      topics: [],
      messages: [],
      type: 'assistant',
      settings: {}
    }
  }
}))

vi.mock('../embedding', () => ({
  isEmbeddingModel: vi.fn(),
  isRerankModel: vi.fn()
}))

vi.mock('../vision', () => ({
  isTextToImageModel: vi.fn(),
  isPureGenerateImageModel: vi.fn(),
  isModernGenerateImageModel: vi.fn()
}))

describe('Doubao Models', () => {
  describe('isDoubaoThinkingAutoModel', () => {
    it('should return false for invalid models', () => {
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-seed-1-6-251015',
          name: 'doubao-seed-1-6-251015',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-seed-1-6-lite-251015',
          name: 'doubao-seed-1-6-lite-251015',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-seed-1-6-thinking-250715',
          name: 'doubao-seed-1-6-thinking-250715',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-seed-1-6-flash',
          name: 'doubao-seed-1-6-flash',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-seed-1-6-thinking',
          name: 'doubao-seed-1-6-thinking',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })

    it('should return true for valid models', () => {
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-seed-1-6-250615',
          name: 'doubao-seed-1-6-250615',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isDoubaoThinkingAutoModel({
          id: 'Doubao-Seed-1.6',
          name: 'Doubao-Seed-1.6',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-1-5-thinking-pro-m',
          name: 'doubao-1-5-thinking-pro-m',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-seed-1.6-lite',
          name: 'doubao-seed-1.6-lite',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isDoubaoThinkingAutoModel({
          id: 'doubao-1-5-thinking-pro-m-12345',
          name: 'doubao-1-5-thinking-pro-m-12345',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })
  })

  describe('isDoubaoSeedAfter251015', () => {
    it('should return true for models matching the pattern', () => {
      expect(
        isDoubaoSeedAfter251015({
          id: 'doubao-seed-1-6-251015',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isDoubaoSeedAfter251015({
          id: 'doubao-seed-1-6-lite-251015',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return false for models not matching the pattern', () => {
      expect(
        isDoubaoSeedAfter251015({
          id: 'doubao-seed-1-6-250615',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isDoubaoSeedAfter251015({
          id: 'Doubao-Seed-1.6',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isDoubaoSeedAfter251015({
          id: 'doubao-1-5-thinking-pro-m',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isDoubaoSeedAfter251015({
          id: 'doubao-seed-1-6-lite-251016',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })
  })
})

describe('Doubao Thinking Support', () => {
  it('detects thinking token support by id or name', () => {
    expect(isSupportedThinkingTokenDoubaoModel(createModel({ id: 'doubao-seed-1.6-flash' }))).toBe(true)
    expect(
      isSupportedThinkingTokenDoubaoModel(createModel({ id: 'custom', name: 'Doubao-1-5-Thinking-Pro-M-Extra' }))
    ).toBe(true)
    expect(isSupportedThinkingTokenDoubaoModel(undefined)).toBe(false)
    expect(isSupportedThinkingTokenDoubaoModel(createModel({ id: 'doubao-standard' }))).toBe(false)
  })
})

const createModel = (overrides: Partial<Model> = {}): Model => ({
  id: 'test-model',
  name: 'Test Model',
  provider: 'openai',
  group: 'Test',
  ...overrides
})

const embeddingMock = vi.mocked(isEmbeddingModel)
const rerankMock = vi.mocked(isRerankModel)
const textToImageMock = vi.mocked(isTextToImageModel)

beforeEach(() => {
  embeddingMock.mockReturnValue(false)
  rerankMock.mockReturnValue(false)
  textToImageMock.mockReturnValue(false)
})
describe('Ling Models', () => {
  describe('isLingReasoningModel', () => {
    it('should return false for ling variants', () => {
      expect(
        isLingReasoningModel({
          id: 'ling-1t',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isLingReasoningModel({
          id: 'ling-flash-2.0',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isLingReasoningModel({
          id: 'ling-mini-2.0',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })

    it('should return true for ring variants', () => {
      expect(
        isLingReasoningModel({
          id: 'ring-1t',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isLingReasoningModel({
          id: 'ring-flash-2.0',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isLingReasoningModel({
          id: 'ring-mini-2.0',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })
  })
})

describe('Claude & regional providers', () => {
  it('identifies claude 4.5 variants', () => {
    expect(isClaude45ReasoningModel(createModel({ id: 'claude-sonnet-4.5-preview' }))).toBe(true)
    expect(isClaude4SeriesModel(createModel({ id: 'claude-sonnet-4-5@20250929' }))).toBe(true)
    expect(isClaude45ReasoningModel(createModel({ id: 'claude-3-sonnet' }))).toBe(false)
  })

  it('identifies claude 4 variants', () => {
    expect(isClaude4SeriesModel(createModel({ id: 'claude-opus-4' }))).toBe(true)
    expect(isClaude4SeriesModel(createModel({ id: 'claude-sonnet-4@20250514' }))).toBe(true)
    expect(isClaude4SeriesModel(createModel({ id: 'anthropic.claude-sonnet-4-20250514-v1:0' }))).toBe(true)
    expect(isClaude4SeriesModel(createModel({ id: 'claude-4.2-sonnet-variant' }))).toBe(false)
    expect(isClaude4SeriesModel(createModel({ id: 'claude-3-haiku' }))).toBe(false)
  })

  it('detects general claude reasoning support', () => {
    expect(isClaudeReasoningModel(createModel({ id: 'claude-3.7-sonnet' }))).toBe(true)
    expect(isClaudeReasoningModel(createModel({ id: 'claude-3-haiku' }))).toBe(false)
  })

  it('covers hunyuan reasoning heuristics', () => {
    expect(isHunyuanReasoningModel(createModel({ id: 'hunyuan-a13b', provider: 'hunyuan' }))).toBe(true)
    expect(isHunyuanReasoningModel(createModel({ id: 'hunyuan-lite', provider: 'hunyuan' }))).toBe(false)
  })

  it('covers perplexity reasoning detectors', () => {
    expect(isPerplexityReasoningModel(createModel({ id: 'sonar-deep-research', provider: 'perplexity' }))).toBe(true)
    expect(isSupportedReasoningEffortPerplexityModel(createModel({ id: 'sonar-deep-research' }))).toBe(true)
    expect(isPerplexityReasoningModel(createModel({ id: 'sonar-lite' }))).toBe(false)
  })

  it('covers zhipu/minimax/step specific classifiers', () => {
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.5' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.6-pro' }))).toBe(true)
    expect(isZhipuReasoningModel(createModel({ id: 'glm-z1' }))).toBe(true)
    expect(isStepReasoningModel(createModel({ id: 'step-r1-v-mini' }))).toBe(true)
    expect(isMiniMaxReasoningModel(createModel({ id: 'minimax-m2-pro' }))).toBe(true)
    expect(isMiniMaxReasoningModel(createModel({ id: 'minimax-m2.7' }))).toBe(true)
    expect(isMiniMaxReasoningModel(createModel({ id: 'minimax-m2.7-highspeed' }))).toBe(true)
    expect(isMiniMaxReasoningModel(createModel({ id: 'minimax-m3' }))).toBe(true)
  })
})

describe('DeepSeek & Thinking Tokens', () => {
  it('detects deepseek hybrid inference patterns and allowed providers', () => {
    expect(
      isDeepSeekHybridInferenceModel(
        createModel({
          id: 'deepseek-v3.1-alpha',
          provider: 'openrouter'
        })
      )
    ).toBe(true)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v2' }))).toBe(false)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v3.2' }))).toBe(true)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'agent/deepseek-v3.2' }))).toBe(true)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-chat' }))).toBe(true)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v3.2-speciale' }))).toBe(false)

    const allowed = createModel({ id: 'deepseek-v3.1', provider: 'doubao' })
    expect(isSupportedThinkingTokenModel(allowed)).toBe(true)

    const anyProvider = createModel({ id: 'deepseek-v3.1', provider: 'unknown' })
    expect(isSupportedThinkingTokenModel(anyProvider)).toBe(true)
  })

  it('tests various prefix patterns for isDeepSeekHybridInferenceModel', () => {
    // Test with custom prefixes
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'custom-deepseek-v3.2' }))).toBe(true)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'prefix-deepseek-v3.1' }))).toBe(true)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'agent/deepseek-v3.2' }))).toBe(true)

    // Test that speciale is properly excluded
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'custom-deepseek-v3.2-speciale' }))).toBe(false)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'agent/deepseek-v3.2-speciale' }))).toBe(false)

    // Test basic deepseek-chat
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-chat' }))).toBe(true)

    // Test version variations
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v3.1.2' }))).toBe(true)
    expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v3-1' }))).toBe(true)
  })

  it('supports Gemini thinking models while filtering image variants', () => {
    expect(isSupportedThinkingTokenModel(createModel({ id: 'gemini-2.5-flash-latest' }))).toBe(true)
    expect(isSupportedThinkingTokenModel(createModel({ id: 'gemini-2.5-flash-image' }))).toBe(false)
  })
})

describe('DeepSeek V4+ Models', () => {
  describe('isDeepSeekV4PlusModel', () => {
    it('matches V4 model IDs with and without suffixes', () => {
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v4' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v4-flash' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v4-pro' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v4.1' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v4-pro-preview' }))).toBe(true)
    })

    it('matches future V5+ and double-digit versions via wildcard regex', () => {
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v5' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v5-flash' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v9-pro' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v10' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v42-ultra' }))).toBe(true)
    })

    it('matches prefixed model IDs from aggregators and agent routes', () => {
      expect(isDeepSeekV4PlusModel(createModel({ id: 'custom-deepseek-v4' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'prefix-deepseek-v4-flash' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'agent/deepseek-v4-pro' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'accounts/fireworks/models/deepseek-v4-pro' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek/deepseek-v4-flash:deepseek' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek/deepseek-v4-pro:fireworks' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek/deepseek-v4-pro:deepseek:together' }))).toBe(true)
    })

    it('is case insensitive', () => {
      expect(isDeepSeekV4PlusModel(createModel({ id: 'DeepSeek-V4' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'DEEPSEEK-V4-FLASH' }))).toBe(true)
    })

    it('falls back to model name when id does not match', () => {
      expect(isDeepSeekV4PlusModel(createModel({ id: 'custom-id', name: 'deepseek-v4-pro' }))).toBe(true)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'custom-id', name: 'DeepSeek-V5' }))).toBe(true)
    })

    it('rejects V3 and older versions', () => {
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v3' }))).toBe(false)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v3.1' }))).toBe(false)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v3.2' }))).toBe(false)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v2' }))).toBe(false)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-v1' }))).toBe(false)
    })

    it('rejects unrelated model IDs', () => {
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-chat' }))).toBe(false)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'deepseek-reasoner' }))).toBe(false)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'gpt-4' }))).toBe(false)
      expect(isDeepSeekV4PlusModel(createModel({ id: 'claude-v4' }))).toBe(false)
      expect(isDeepSeekV4PlusModel(createModel({ id: '' }))).toBe(false)
    })
  })

  describe('isDeepSeekHybridInferenceModel integration', () => {
    it('includes V4+ models via delegation to isDeepSeekV4PlusModel', () => {
      expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v4' }))).toBe(true)
      expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v4-flash' }))).toBe(true)
      expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v4-pro' }))).toBe(true)
      expect(isDeepSeekHybridInferenceModel(createModel({ id: 'deepseek-v5-xxx' }))).toBe(true)
      expect(isDeepSeekHybridInferenceModel(createModel({ id: 'accounts/fireworks/models/deepseek-v4-pro' }))).toBe(
        true
      )
    })
  })
})

describe('Qwen & Gemini thinking coverage', () => {
  it.each([
    'qwen-plus',
    'qwen-plus-2025-07-14',
    'qwen-plus-2025-09-11',
    'qwen-turbo',
    'qwen-turbo-2025-04-28',
    'qwen-flash',
    'qwen3-8b',
    'qwen3-72b',
    'qwen3.5-plus',
    'qwen3.5-plus-2026-02-15',
    'qwen3.5-397b-a17b'
  ])('supports thinking tokens for %s', (id) => {
    expect(isSupportedThinkingTokenQwenModel(createModel({ id }))).toBe(true)
  })

  it.each(['qwen3-thinking', 'qwen3-instruct', 'qwen3-vl-thinking', 'qwen3.5-thinking', 'qwen3.5-instruct'])(
    'blocks thinking tokens for %s',
    (id) => {
      expect(isSupportedThinkingTokenQwenModel(createModel({ id }))).toBe(false)
    }
  )

  it('supports thinking tokens for qwen3-max, qwen3-max-preview and qwen3-max-2026-01-23', () => {
    expect(isSupportedThinkingTokenQwenModel(createModel({ id: 'qwen3-max' }))).toBe(true)
    expect(isSupportedThinkingTokenQwenModel(createModel({ id: 'qwen3-max-preview' }))).toBe(true)
    expect(isSupportedThinkingTokenQwenModel(createModel({ id: 'qwen3-max-2026-01-23' }))).toBe(true)
  })

  it('supports thinking tokens for qwen3.5 series models', () => {
    expect(isSupportedThinkingTokenQwenModel(createModel({ id: 'qwen3.5-plus' }))).toBe(true)
    expect(isSupportedThinkingTokenQwenModel(createModel({ id: 'qwen3.5-plus-2026-02-15' }))).toBe(true)
    expect(isSupportedThinkingTokenQwenModel(createModel({ id: 'qwen3.5-397b-a17b' }))).toBe(true)
  })

  it.each(['qwen3-thinking', 'qwen3-vl-235b-thinking'])('always thinks for %s', (id) => {
    expect(isQwenAlwaysThinkModel(createModel({ id }))).toBe(true)
  })

  it.each(['gemini-2.5-flash-latest', 'gemini-pro-latest', 'gemini-flash-lite-latest'])(
    'Gemini supports thinking tokens for %s',
    (id) => {
      expect(isSupportedThinkingTokenGeminiModel(createModel({ id }))).toBe(true)
    }
  )

  it.each(['gemini-2.5-flash-image', 'gemini-2.0-tts', 'custom-model'])('Gemini excludes %s', (id) => {
    expect(isSupportedThinkingTokenGeminiModel(createModel({ id }))).toBe(false)
  })
})

describe('GPT-5.1 Series Models', () => {
  describe('isSupportedReasoningEffortOpenAIModel', () => {
    it('should support GPT-5.1 reasoning models', () => {
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.1' }))).toBe(true)
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.1-preview' }))).toBe(true)
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.1-codex' }))).toBe(true)
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.1-codex-mini' }))).toBe(true)
    })

    it('should not support GPT-5.1 chat models', () => {
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.1-chat' }))).toBe(false)
    })

    it('should support future GPT-5.x sub-version models', () => {
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.4' }))).toBe(true)
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.4-mini' }))).toBe(true)
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.9' }))).toBe(true)
    })

    it('should not support future GPT-5.x chat models', () => {
      expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.4-chat' }))).toBe(false)
    })
  })

  describe('isOpenAIReasoningModel', () => {
    it('should recognize GPT-5.1 series as reasoning models', () => {
      expect(isOpenAIReasoningModel(createModel({ id: 'gpt-5.1' }))).toBe(true)
      expect(isOpenAIReasoningModel(createModel({ id: 'gpt-5.1-preview' }))).toBe(true)
      expect(isOpenAIReasoningModel(createModel({ id: 'gpt-5.1-codex' }))).toBe(true)
      expect(isOpenAIReasoningModel(createModel({ id: 'gpt-5.1-codex-mini' }))).toBe(true)
    })
  })

  describe('isReasoningModel', () => {
    it('should classify GPT-5.1 models as reasoning models', () => {
      expect(isReasoningModel(createModel({ id: 'gpt-5.1' }))).toBe(true)
      expect(isReasoningModel(createModel({ id: 'gpt-5.1-preview' }))).toBe(true)
      expect(isReasoningModel(createModel({ id: 'gpt-5.1-mini' }))).toBe(true)
      expect(isReasoningModel(createModel({ id: 'gpt-5.1-codex' }))).toBe(true)
      expect(isReasoningModel(createModel({ id: 'gpt-5.1-codex-mini' }))).toBe(true)
    })

    it('should not classify GPT-5.1 chat models as reasoning models', () => {
      expect(isReasoningModel(createModel({ id: 'gpt-5.1-chat' }))).toBe(false)
    })
  })
})

describe('Reasoning effort helpers', () => {
  it('evaluates OpenAI-specific reasoning toggles', () => {
    expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'o3-mini' }))).toBe(true)
    expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'o1-mini' }))).toBe(false)
    expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-oss-reasoning' }))).toBe(true)
    expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5-chat' }))).toBe(false)
    expect(isSupportedReasoningEffortOpenAIModel(createModel({ id: 'gpt-5.1' }))).toBe(true)
  })

  it('detects OpenAI reasoning models even when not supported by effort helper', () => {
    expect(isOpenAIReasoningModel(createModel({ id: 'o1-preview' }))).toBe(true)
    expect(isOpenAIReasoningModel(createModel({ id: 'custom-model' }))).toBe(false)
  })

  it('aggregates other reasoning effort families', () => {
    expect(isSupportedReasoningEffortModel(createModel({ id: 'o3' }))).toBe(true)
    expect(isSupportedReasoningEffortModel(createModel({ id: 'grok-3-mini' }))).toBe(true)
    expect(isSupportedReasoningEffortModel(createModel({ id: 'grok-4.3' }))).toBe(true)
    expect(isSupportedReasoningEffortModel(createModel({ id: 'sonar-deep-research', provider: 'perplexity' }))).toBe(
      true
    )
    expect(isSupportedReasoningEffortModel(createModel({ id: 'gpt-4o' }))).toBe(false)
  })

  it('flags grok specific helpers correctly', () => {
    expect(isSupportedReasoningEffortGrokModel(createModel({ id: 'grok-3-mini' }))).toBe(true)
    expect(isSupportedReasoningEffortGrokModel(createModel({ id: 'grok-4.3' }))).toBe(true)
    expect(
      isSupportedReasoningEffortGrokModel(createModel({ id: 'grok-4-fast-openrouter', provider: 'openrouter' }))
    ).toBe(true)
    expect(isSupportedReasoningEffortGrokModel(createModel({ id: 'grok-4' }))).toBe(false)

    expect(isGrok4FastReasoningModel(createModel({ id: 'grok-4-fast' }))).toBe(true)
    expect(isGrok4FastReasoningModel(createModel({ id: 'grok-4-fast-non-reasoning' }))).toBe(false)
  })
})

describe('isReasoningModel', () => {
  it('returns false for embedding/rerank/text-to-image models', () => {
    embeddingMock.mockReturnValueOnce(true)
    expect(isReasoningModel(createModel())).toBe(false)

    embeddingMock.mockReturnValue(false)
    rerankMock.mockReturnValueOnce(true)
    expect(isReasoningModel(createModel())).toBe(false)

    rerankMock.mockReturnValue(false)
    textToImageMock.mockReturnValueOnce(true)
    expect(isReasoningModel(createModel())).toBe(false)
  })

  it('respects manual overrides', () => {
    const forced = createModel({
      capabilities: [{ type: 'reasoning', isUserSelected: true }]
    })
    expect(isReasoningModel(forced)).toBe(true)

    const disabled = createModel({
      capabilities: [{ type: 'reasoning', isUserSelected: false }]
    })
    expect(isReasoningModel(disabled)).toBe(false)
  })

  it('handles doubao-specific and generic matches', () => {
    const doubao = createModel({
      id: 'doubao-seed-1-6-thinking',
      provider: 'doubao',
      name: 'doubao-seed-1-6-thinking'
    })
    expect(isReasoningModel(doubao)).toBe(true)

    const magistral = createModel({ id: 'magistral-reasoning' })
    expect(isReasoningModel(magistral)).toBe(true)
  })

  it('identifies fixed reasoning models (now always false after metadata-driven removal)', () => {
    const models = [
      'deepseek-reasoner',
      'o1-preview',
      'o1-mini',
      'qwq-32b-preview',
      'step-3-minimax',
      'generic-reasoning-model',
      'some-random-model-thinking',
      'some-random-model-think',
      'deepseek-v3.2-speciale'
    ]

    models.forEach((id) => {
      const model = createModel({ id })
      expect(isFixedReasoningModel(model), `Model ${id} should be fixed false`).toBe(false)
    })
  })

  // Regression test for mistral-small-2603 reasoning support
  it('should return true for mistral-small-2603', () => {
    expect(isReasoningModel(createModel({ id: 'mistral-small-2603' }))).toBe(true)
  })

  it('should return true for grok-build-0.1', () => {
    expect(isReasoningModel(createModel({ id: 'grok-build-0.1' }))).toBe(true)
  })

  it('excludes non-fixed reasoning models from isFixedReasoningModel', () => {
    // Models that support thinking tokens or reasoning effort should NOT be fixed reasoning models
    const nonFixedModels = [
      { id: 'deepseek-v3.2', provider: 'deepseek' }, // Supports thinking tokens
      { id: 'deepseek-chat', provider: 'deepseek' }, // Supports thinking tokens
      { id: 'claude-3-opus-20240229', provider: 'anthropic' }, // Supports thinking tokens via extended_thinking
      { id: 'gpt-4o', provider: 'openai' }, // Not a reasoning model at all
      { id: 'gpt-4', provider: 'openai' } // Not a reasoning model at all
    ]

    nonFixedModels.forEach(({ id, provider }) => {
      const model = createModel({ id, provider })
      expect(isFixedReasoningModel(model), `Model ${id} should NOT be fixed reasoning`).toBe(false)
    })
  })
})

describe('Gemini Models', () => {
  describe('isSupportedThinkingTokenGeminiModel', () => {
    it('should return true for gemini 2.5 models', () => {
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-2.5-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-2.5-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-2.5-flash-latest',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-2.5-pro-latest',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini latest models', () => {
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-flash-latest',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-pro-latest',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-flash-lite-latest',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini 3 models', () => {
      // Preview versions
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-pro-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-flash-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'google/gemini-3-pro-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      // Future stable versions
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'google/gemini-3-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'google/gemini-3-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      // Version with date suffixes
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-flash-preview-09-2025',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-pro-preview-09-2025',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-flash-exp-1234',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      // Version with decimals
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3.0-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3.5-pro-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini-3-pro-image models only', () => {
      // Only gemini-3-pro-image models should return true
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-pro-image-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-pro-image',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return false for other gemini-3 image models', () => {
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3.0-flash-image-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3.5-pro-image-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })

    it('should return false for gemini-2.x image models', () => {
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-2.5-flash-image-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-2.0-pro-image-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })

    it('should return false for image and tts models', () => {
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-2.5-flash-image',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-2.5-flash-preview-tts',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-flash-tts',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-flash-preview-tts',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-3-pro-tts',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })

    it('should return false for older gemini models', () => {
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-1.5-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-1.5-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isSupportedThinkingTokenGeminiModel({
          id: 'gemini-1.0-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })

    it('should return true for hosted gemma 4 models on Gemini provider', () => {
      expect(isSupportedThinkingTokenGeminiModel(createModel({ id: 'gemma-4-31b-it', provider: 'gemini' }))).toBe(true)
      expect(
        isSupportedThinkingTokenGeminiModel(createModel({ id: 'google/gemma-4-e2b-it', provider: 'gemini' }))
      ).toBe(true)
    })

    it('should detect hosted gemma 4 ids by model id on any connection (no provider gate)', () => {
      expect(isSupportedThinkingTokenGeminiModel(createModel({ id: 'gemma-4-31b-it', provider: 'openrouter' }))).toBe(
        true
      )
      expect(isSupportedThinkingTokenGeminiModel(createModel({ id: 'gemma4:31b' }))).toBe(false)
      expect(isSupportedThinkingTokenGeminiModel(createModel({ id: 'gemma4:e2b' }))).toBe(false)
    })
  })

  describe('isGeminiReasoningModel', () => {
    it('should return true for gemini thinking models', () => {
      expect(
        isGeminiReasoningModel({
          id: 'gemini-2.0-flash-thinking',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isGeminiReasoningModel({
          id: 'gemini-thinking-exp',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for supported thinking token gemini models', () => {
      expect(
        isGeminiReasoningModel({
          id: 'gemini-2.5-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isGeminiReasoningModel({
          id: 'gemini-2.5-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
    })

    it('should return true for gemini-3 models', () => {
      // Preview versions
      expect(
        isGeminiReasoningModel({
          id: 'gemini-3-pro-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isGeminiReasoningModel({
          id: 'google/gemini-3-pro-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      // Future stable versions
      expect(
        isGeminiReasoningModel({
          id: 'gemini-3-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isGeminiReasoningModel({
          id: 'gemini-3-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isGeminiReasoningModel({
          id: 'google/gemini-3-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isGeminiReasoningModel({
          id: 'google/gemini-3-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      // Version with decimals
      expect(
        isGeminiReasoningModel({
          id: 'gemini-3.0-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isGeminiReasoningModel({
          id: 'gemini-3.5-pro-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      // Image models
      expect(
        isGeminiReasoningModel({
          id: 'gemini-3-pro-image-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(true)
      expect(
        isGeminiReasoningModel({
          id: 'gemini-3.5-flash-image-preview',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })

    it('should return false for older gemini models without thinking', () => {
      expect(
        isGeminiReasoningModel({
          id: 'gemini-1.5-flash',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
      expect(
        isGeminiReasoningModel({
          id: 'gemini-1.5-pro',
          name: '',
          provider: '',
          group: ''
        })
      ).toBe(false)
    })

    it('should return false for undefined model', () => {
      expect(isGeminiReasoningModel(undefined)).toBe(false)
    })
  })
})

describe('findTokenLimit', () => {
  describe('General token limit lookup', () => {
    it.each([
      ['gemini-2.5-flash-lite-latest', { min: 512, max: 24576 }],
      ['qwen-plus-2025-07-14', { min: 0, max: 38912 }]
    ])('returns configured min/max pairs for %s', (id, expected) => {
      expect(findTokenLimit(id)).toEqual(expected)
    })

    it('returns undefined when regex misses', () => {
      expect(findTokenLimit('unknown-model')).toBeUndefined()
    })
  })

  const cases: Array<{ modelId: string; expected: { min: number; max: number } }> = [
    { modelId: 'gemini-2.5-flash-lite-exp', expected: { min: 512, max: 24_576 } },
    { modelId: 'gemini-1.5-flash', expected: { min: 0, max: 24_576 } },
    { modelId: 'gemini-1.5-pro-001', expected: { min: 128, max: 32_768 } },
    { modelId: 'qwen3-235b-a22b-thinking-2507', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen3-30b-a3b-thinking-2507', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen3-vl-235b-a22b-thinking', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen3-vl-30b-a3b-thinking', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen-plus-2025-07-14', expected: { min: 0, max: 38_912 } },
    { modelId: 'qwen-plus-2025-04-28', expected: { min: 0, max: 38_912 } },
    { modelId: 'qwen3-1.7b', expected: { min: 0, max: 30_720 } },
    { modelId: 'qwen3-0.6b', expected: { min: 0, max: 30_720 } },
    { modelId: 'qwen-plus-ultra', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen-turbo-pro', expected: { min: 0, max: 38_912 } },
    { modelId: 'qwen-flash-lite', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen3-7b', expected: { min: 1_024, max: 38_912 } },
    // qwen3-max series (reasoning models, equivalent to qwen-plus for thinking budget)
    { modelId: 'qwen3-max', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen3-max-2026-01-23', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen3-max-preview', expected: { min: 0, max: 81_920 } },
    // qwen3.5 series (max thinking budget: 81920)
    { modelId: 'qwen3.5-plus', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen3.5-plus-2026-02-15', expected: { min: 0, max: 81_920 } },
    { modelId: 'qwen3.5-397b-a17b', expected: { min: 0, max: 81_920 } },
    { modelId: 'Baichuan-M2', expected: { min: 0, max: 30_000 } },
    { modelId: 'baichuan-m2', expected: { min: 0, max: 30_000 } },
    { modelId: 'Baichuan-M3', expected: { min: 0, max: 30_000 } },
    { modelId: 'baichuan-m3', expected: { min: 0, max: 30_000 } }
  ]

  it.each(cases)('returns correct limits for $modelId', ({ modelId, expected }) => {
    expect(findTokenLimit(modelId)).toEqual(expected)
  })

  it('returns undefined for unknown models', () => {
    expect(findTokenLimit('unknown-model')).toBeUndefined()
  })

  describe('Claude models', () => {
    describe('Claude 3.7 Sonnet models', () => {
      it.each([
        'claude-3.7-sonnet',
        'claude-3-7-sonnet',
        'claude-3.7-sonnet-latest',
        'claude-3-7-sonnet-latest',
        'claude-3.7-sonnet-20250201',
        'claude-3-7-sonnet-20250201',
        // Official Claude API IDs
        'claude-3-7-sonnet-20250219',
        // AWS Bedrock format
        'anthropic.claude-3-7-sonnet-20250219-v1:0',
        // GCP Vertex AI format
        'claude-3-7-sonnet@20250219'
      ])('should return { min: 1024, max: 64000 } for %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 64_000 })
      })

      it.each(['CLAUDE-3.7-SONNET', 'Claude-3-7-Sonnet-Latest'])('should be case insensitive for %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 64_000 })
      })
    })

    describe('Claude 4.0 series models', () => {
      it.each([
        'claude-sonnet-4',
        'claude-sonnet-4.0',
        'claude-sonnet-4-0',
        'claude-sonnet-4-preview',
        'claude-sonnet-4.0-preview',
        'claude-sonnet-4-20250101',
        // Official Claude API IDs
        'claude-sonnet-4-20250514',
        // AWS Bedrock format
        'anthropic.claude-sonnet-4-20250514-v1:0',
        // GCP Vertex AI format
        'claude-sonnet-4@20250514'
      ])('should return { min: 1024, max: 64000 } for Sonnet variant %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 64_000 })
      })

      it.each([
        'claude-opus-4',
        'claude-opus-4.0',
        'claude-opus-4-0',
        'claude-opus-4-preview',
        'claude-opus-4.0-preview',
        'claude-opus-4-20250101',
        // Official Claude API IDs
        'claude-opus-4-20250514',
        // AWS Bedrock format
        'anthropic.claude-opus-4-20250514-v1:0',
        // GCP Vertex AI format
        'claude-opus-4@20250514'
      ])('should return { min: 1024, max: 32000 } for Opus variant %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 32_000 })
      })

      it.each(['CLAUDE-SONNET-4', 'Claude-Opus-4-Preview'])('should be case insensitive for %s', (modelId) => {
        const expectedSonnet = { min: 1024, max: 64_000 }
        const expectedOpus = { min: 1024, max: 32_000 }
        const result = findTokenLimit(modelId)
        expect(result).toBeDefined()
        expect([expectedSonnet, expectedOpus]).toContainEqual(result)
      })
    })

    describe('Claude Opus 4.1 models', () => {
      it.each([
        'claude-opus-4.1',
        'claude-opus-4-1',
        'claude-opus-4.1-preview',
        'claude-opus-4-1-preview',
        'claude-opus-4.1-20250120',
        'claude-opus-4-1-20250120',
        // Official Claude API IDs
        'claude-opus-4-1-20250805',
        // AWS Bedrock format
        'anthropic.claude-opus-4-1-20250805-v1:0',
        // GCP Vertex AI format
        'claude-opus-4-1@20250805'
      ])('should return { min: 1024, max: 32000 } for %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 32_000 })
      })

      it.each(['CLAUDE-OPUS-4.1', 'Claude-Opus-4-1-Preview'])('should be case insensitive for %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 32_000 })
      })
    })

    describe('Claude 4.5 series models (Haiku, Sonnet, Opus)', () => {
      it.each([
        'claude-haiku-4.5',
        'claude-haiku-4-5',
        'claude-haiku-4.5-preview',
        'claude-haiku-4-5-preview',
        'claude-haiku-4.5-20250929',
        'claude-haiku-4-5-20250929',
        // Official Claude API IDs
        'claude-haiku-4-5-20251001',
        // AWS Bedrock format
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        // GCP Vertex AI format
        'claude-haiku-4-5@20251001'
      ])('should return { min: 1024, max: 64000 } for Haiku variant %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 64_000 })
      })

      it.each([
        'claude-sonnet-4.5',
        'claude-sonnet-4-5',
        'claude-sonnet-4.5-preview',
        'claude-sonnet-4-5-preview',
        'claude-sonnet-4.5-20250929',
        'claude-sonnet-4-5-20250929',
        // Official Claude API IDs
        'claude-sonnet-4-5-20250929',
        // AWS Bedrock format
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        // GCP Vertex AI format
        'claude-sonnet-4-5@20250929'
      ])('should return { min: 1024, max: 64000 } for Sonnet variant %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 64_000 })
      })

      it.each([
        'claude-opus-4.5',
        'claude-opus-4-5',
        'claude-opus-4.5-preview',
        'claude-opus-4-5-preview',
        'claude-opus-4.5-20250929',
        'claude-opus-4-5-20250929',
        // Official Claude API IDs
        'claude-opus-4-5-20251101',
        // AWS Bedrock format
        'anthropic.claude-opus-4-5-20251101-v1:0',
        // GCP Vertex AI format
        'claude-opus-4-5@20251101'
      ])('should return { min: 1024, max: 64000 } for Opus variant %s', (modelId) => {
        expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 64_000 })
      })

      it.each(['CLAUDE-HAIKU-4.5', 'Claude-Sonnet-4-5-Preview', 'CLAUDE-OPUS-4.5-20250929'])(
        'should be case insensitive for %s',
        (modelId) => {
          expect(findTokenLimit(modelId)).toEqual({ min: 1024, max: 64_000 })
        }
      )
    })

    describe('Claude models that should NOT match', () => {
      it.each([
        'claude-3-opus',
        'claude-3-sonnet',
        'claude-3-haiku',
        'claude-3.5-sonnet',
        'claude-3-5-sonnet',
        'claude-2.1',
        'claude-instant',
        'claude-haiku-4',
        'claude-haiku-4.0',
        'claude-haiku-4-0',
        'claude-opus-4.2',
        'claude-opus-4-2',
        'claude-sonnet-4.2',
        'claude-sonnet-4-2',
        // Old Haiku models (no Extended thinking support)
        'claude-3-5-haiku-20241022',
        'claude-3-5-haiku-latest',
        'anthropic.claude-3-5-haiku-20241022-v1:0',
        'claude-3-5-haiku@20241022',
        'claude-3-haiku-20240307',
        'anthropic.claude-3-haiku-20240307-v1:0',
        'claude-3-haiku@20240307'
      ])('should return undefined for older/unsupported model %s', (modelId) => {
        expect(findTokenLimit(modelId)).toBeUndefined()
      })
    })

    describe('Edge cases', () => {
      it('should handle models with custom suffixes', () => {
        expect(findTokenLimit('claude-3.7-sonnet-custom-variant')).toEqual({ min: 1024, max: 64_000 })
        expect(findTokenLimit('claude-opus-4.1-custom')).toEqual({ min: 1024, max: 32_000 })
        expect(findTokenLimit('claude-sonnet-4.5-custom-variant')).toEqual({ min: 1024, max: 64_000 })
      })

      it('should NOT match non-existent Claude 4.1 variants (only Opus 4.1 exists)', () => {
        // Claude Sonnet 4.1 and Haiku 4.1 do not exist
        expect(findTokenLimit('claude-sonnet-4.1')).toBeUndefined()
        expect(findTokenLimit('claude-haiku-4.1')).toBeUndefined()
      })

      it('should not match partial model names', () => {
        expect(findTokenLimit('claude-3.7')).toBeUndefined()
        expect(findTokenLimit('claude-opus')).toBeUndefined()
        expect(findTokenLimit('claude-4.5')).toBeUndefined()
      })
    })
  })
})

describe('isGemini3ThinkingTokenModel', () => {
  it('should return true for Gemini 3 non-image models', () => {
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3-flash',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3-pro',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3-pro-preview',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'google/gemini-3-flash',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3.0-flash',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3.5-pro-preview',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-flash-latest',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-pro-latest',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
  })

  it('should return false for Gemini 3 image models', () => {
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3-flash-image',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3-pro-image-preview',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3.0-flash-image-preview',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-3.5-pro-image-preview',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
  })

  it('should return false for non-Gemini 3 models', () => {
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-2.5-flash',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gemini-1.5-pro',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'gpt-4',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'claude-3-opus',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
  })

  it('should handle case insensitivity', () => {
    expect(
      isGemini3ThinkingTokenModel({
        id: 'Gemini-3-Flash',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'GEMINI-3-PRO',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(true)
    expect(
      isGemini3ThinkingTokenModel({
        id: 'Gemini-3-Pro-Image',
        name: '',
        provider: '',
        group: ''
      })
    ).toBe(false)
  })
})

describe('isInterleavedThinkingModel', () => {
  describe('MiniMax models', () => {
    it('should return true for minimax-m2', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2' }))).toBe(true)
    })

    it('should return true for minimax-m2.1', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2.1' }))).toBe(true)
    })

    it('should return true for minimax-m2 with suffixes', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2-pro' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2-preview' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2-lite' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2-ultra-lite' }))).toBe(true)
    })

    it('should return true for minimax-m2.x with suffixes', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2.1-pro' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2.2-preview' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m2.5-lite' }))).toBe(true)
    })

    it('should return false for non-m2 minimax models', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m1' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-m3' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'minimax-pro' }))).toBe(false)
    })

    it('should handle case insensitivity', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'MiniMax-M2' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'MINIMAX-M2.1' }))).toBe(true)
    })
  })

  describe('MiMo models', () => {
    it('should support thinking control for V2.5 models only on chat models', () => {
      expect(isSupportedThinkingTokenMiMoModel(createModel({ id: 'mimo-v2.5' }))).toBe(true)
      expect(isSupportedThinkingTokenMiMoModel(createModel({ id: 'mimo-v2.5-pro' }))).toBe(true)
      expect(isSupportedThinkingTokenMiMoModel(createModel({ id: 'mimo-v2.5-tts' }))).toBe(false)
      expect(isSupportedThinkingTokenMiMoModel(createModel({ id: 'mimo-v2.5-tts-voiceclone' }))).toBe(false)
    })

    it('should return true for mimo-v2-flash', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'mimo-v2-flash' }))).toBe(true)
    })

    it('should return false for other mimo models', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'mimo-v1-flash' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'mimo-v2' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'mimo-v2-pro' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'mimo-flash' }))).toBe(false)
    })

    it('should handle case insensitivity', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'MiMo-V2-Flash' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'MIMO-V2-FLASH' }))).toBe(true)
    })
  })

  describe('Zhipu GLM models', () => {
    it('should return true for glm-4.5', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.5' }))).toBe(true)
    })

    it('should return true for glm-4.6', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.6' }))).toBe(true)
    })

    it('should return true for glm-4.7 and higher versions', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.7' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.8' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.9' }))).toBe(true)
    })

    it('should return true for glm-4.x with suffixes', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.5-pro' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.6-preview' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.7-lite' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4.8-ultra' }))).toBe(true)
    })

    it('should return false for glm-4 without decimal version', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-4-pro' }))).toBe(false)
    })

    it('should return false for other glm models', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-3.5' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-zero-preview' }))).toBe(false)
    })

    it('should handle case insensitivity', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'GLM-4.5' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'Glm-4.6-Pro' }))).toBe(true)
    })

    it('should return true for glm-5', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-5' }))).toBe(true)
    })

    it('should return true for glm-5 with suffixes', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-5-pro' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-5-lite' }))).toBe(true)
    })

    it('should return true for glm-5.x versions (future versions maintain same behavior)', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-5.0' }))).toBe(true)
      expect(isInterleavedThinkingModel(createModel({ id: 'glm-5.1' }))).toBe(true)
    })
  })

  describe('Kimi models', () => {
    it('should return true for kimi-k2-thinking', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2-thinking' }))).toBe(true)
    })

    it('should return true for kimi-k2-thinking-turbo', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2-thinking-turbo' }))).toBe(true)
    })

    it('should return true for kimi-k2.5', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2.5' }))).toBe(true)
    })

    it('should return true for kimi-k2.6', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2.6' }))).toBe(true)
    })

    it('should return true for kimi-k2.6 variants', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2.6-preview' }))).toBe(true)
    })

    it('should return false for other kimi models', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2-preview' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2-turbo' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'kimi-k2-0905-Preview' }))).toBe(false)
    })
  })

  describe('Non-matching models', () => {
    it('should return false for unrelated models', () => {
      expect(isInterleavedThinkingModel(createModel({ id: 'gpt-4' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'claude-3-opus' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'gemini-pro' }))).toBe(false)
      expect(isInterleavedThinkingModel(createModel({ id: 'deepseek-v3' }))).toBe(false)
    })
  })
})

describe('Claude Models', () => {
  describe('findTokenLimit for Claude 4.6', () => {
    it('should return 128K max tokens for Opus 4.6 models', () => {
      expect(findTokenLimit('claude-opus-4-6')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('claude-opus-4.6')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('anthropic.claude-opus-4-6-v1')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('claude-opus-4-6@20251201')).toEqual({ min: 1024, max: 128_000 })
    })

    it('should return 64K max tokens for Sonnet 4.6 models', () => {
      expect(findTokenLimit('claude-sonnet-4-6')).toEqual({ min: 1024, max: 64_000 })
      expect(findTokenLimit('claude-sonnet-4.6')).toEqual({ min: 1024, max: 64_000 })
      expect(findTokenLimit('anthropic.claude-sonnet-4-6')).toEqual({ min: 1024, max: 64_000 })
    })

    it('should distinguish Opus 4.6 from other Claude models', () => {
      // Opus 4.5 should have 64K
      expect(findTokenLimit('claude-opus-4-5')).toEqual({ min: 1024, max: 64_000 })
      // Opus 4.0 should have 32K
      expect(findTokenLimit('claude-opus-4')).toEqual({ min: 1024, max: 32_000 })
      // Opus 4.1 should have 32K
      expect(findTokenLimit('claude-opus-4-1')).toEqual({ min: 1024, max: 32_000 })
    })
  })

  describe('Claude Opus 4.7+ token limits', () => {
    it('returns 128K max tokens for Opus 4.7+ models', () => {
      expect(findTokenLimit('claude-opus-4-7')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('claude-opus-4.7')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('anthropic.claude-opus-4-7-v1')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('claude-opus-4-7@20260401')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('claude-opus-4-8')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('anthropic.claude-opus-4-8-v1:0')).toEqual({ min: 1024, max: 128_000 })
      expect(findTokenLimit('claude-opus-4-10')).toEqual({ min: 1024, max: 128_000 })
    })
  })
})

describe('Kimi Models', () => {
  describe('isKimiReasoningModel', () => {
    describe('should return true for Kimi reasoning models', () => {
      it('should recognize kimi-k2-thinking', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2-thinking' }))).toBe(true)
      })

      it('should recognize kimi-k2-thinking-turbo', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2-thinking-turbo' }))).toBe(true)
      })

      it('should recognize kimi-k2.5', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2.5' }))).toBe(true)
      })

      it('should recognize kimi-k2.6', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2.6' }))).toBe(true)
      })

      it('should recognize future K2.x and K3+ variants', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2.7' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k3' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k3.5' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k4' }))).toBe(true)
      })

      it('should handle model IDs with slashes', () => {
        expect(isKimiReasoningModel(createModel({ id: 'moonshot/kimi-k2-thinking' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'moonshot/kimi-k2.5' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'moonshot/kimi-k2.6' }))).toBe(true)
      })

      it('should handle case insensitivity', () => {
        expect(isKimiReasoningModel(createModel({ id: 'KIMI-K2-THINKING' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'Kimi-K2.5' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'Kimi-K2.6' }))).toBe(true)
      })
    })

    describe('should return false for non-reasoning models', () => {
      it('should reject kimi-chat', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-chat' }))).toBe(false)
      })

      it('should reject kimi-k1', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k1' }))).toBe(false)
      })

      it('should reject kimi-k2 (without thinking suffix)', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2' }))).toBe(false)
      })

      it('should reject other Kimi models', () => {
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2-preview' }))).toBe(false)
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2-turbo' }))).toBe(false)
      })

      it('should reject models from other providers', () => {
        expect(isKimiReasoningModel(createModel({ id: 'gpt-4' }))).toBe(false)
        expect(isKimiReasoningModel(createModel({ id: 'claude-3-opus' }))).toBe(false)
        expect(isKimiReasoningModel(createModel({ id: 'deepseek-chat' }))).toBe(false)
      })
    })

    describe('edge cases', () => {
      it('should return false for undefined', () => {
        expect(isKimiReasoningModel(undefined)).toBe(false)
      })

      it('should handle model IDs with paths', () => {
        expect(isKimiReasoningModel(createModel({ id: 'providers/kimi-k2-thinking' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'openrouter/kimi-k2.5' }))).toBe(true)
      })

      it('should correctly match model name variants', () => {
        // kimi-k2-thinking but not kimi-k2-thinking-something
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2-thinking' }))).toBe(true)
        expect(isKimiReasoningModel(createModel({ id: 'kimi-k2-thinking-extra' }))).toBe(false)
      })
    })
  })

  describe('isSupportedThinkingTokenKimiModel', () => {
    describe('should return true for Kimi models with thinking token support', () => {
      it('should recognize kimi-k2.5', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k2.5' }))).toBe(true)
      })

      it('should recognize kimi-k2.6', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k2.6' }))).toBe(true)
      })

      it('should recognize future K2.x and K3+ variants', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k2.7' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k3' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k3.5' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k4' }))).toBe(true)
      })

      it('should handle model IDs with provider prefixes', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'moonshot/kimi-k2.5' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'openrouter/kimi-k2.5' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'moonshot/kimi-k2.6' }))).toBe(true)
      })

      it('should handle case insensitivity', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'KIMI-K2.5' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'Kimi-K2.5' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'KIMI-K2.6' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'Kimi-K2.6' }))).toBe(true)
      })
    })

    describe('should return false for Kimi models without thinking token support', () => {
      it('should reject kimi-k2-thinking', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k2-thinking' }))).toBe(false)
      })

      it('should reject kimi-k2-thinking-turbo', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k2-thinking-turbo' }))).toBe(false)
      })

      it('should reject other Kimi models', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-chat' }))).toBe(false)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k1' }))).toBe(false)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k2' }))).toBe(false)
      })

      it('should reject models from other providers', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'gpt-4' }))).toBe(false)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'claude-3-opus' }))).toBe(false)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'deepseek-chat' }))).toBe(false)
      })
    })

    describe('edge cases', () => {
      it('should handle model IDs with paths', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'providers/kimi-k2.5' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'api/kimi-k2.5-preview' }))).toBe(true)
      })

      it('should match models containing kimi-k2.5', () => {
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k2.5-preview' }))).toBe(true)
        expect(isSupportedThinkingTokenKimiModel(createModel({ id: 'kimi-k2.5-turbo' }))).toBe(true)
      })
    })
  })
})

describe('isSupportedThinkingTokenZhipuModel', () => {
  it('matches GLM-5 series (with or without hyphen)', () => {
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm5' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-5' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-5-plus' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'GLM-5-Pro' }))).toBe(true)
  })

  it('matches GLM-4.5 / 4.6 / 4.7 series', () => {
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.5' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.6' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.7' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.6-pro' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.5-flash' }))).toBe(true)
  })

  it('rejects GLM-4 base and GLM-Z1 models', () => {
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4' }))).toBe(false)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4-plus' }))).toBe(false)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.0' }))).toBe(false)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-4.3' }))).toBe(false)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-z1' }))).toBe(false)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'glm-z1-plus' }))).toBe(false)
  })

  it('rejects unrelated model IDs', () => {
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'gpt-4o' }))).toBe(false)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'claude-3.5-sonnet' }))).toBe(false)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'deepseek-v3' }))).toBe(false)
  })

  it('handles provider-prefixed model IDs', () => {
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'accounts/fireworks/models/glm-4p7' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'accounts/fireworks/models/glm-4p5' }))).toBe(true)
    expect(isSupportedThinkingTokenZhipuModel(createModel({ id: 'zhipu/glm-4.6' }))).toBe(true)
  })
})
