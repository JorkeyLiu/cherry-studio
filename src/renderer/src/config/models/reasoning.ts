import type { Model, Provider, ReasoningEffortOption } from '@renderer/types'
import { getLowerBaseModelName, isUserSelectedModelType } from '@renderer/utils'

import { isEmbeddingModel, isRerankModel } from './embedding'
import {
  resolveCapabilityWithOverride,
  resolveExternalReasoningSupport,
  resolveServingReasoningEffort
} from './modelMetadata'
import { isOpenAIReasoningModel, isSupportedReasoningEffortOpenAIModel } from './openai'
import { isKimi25OrNewerModel, withModelIdAndNameAsId } from './utils'
import { isTextToImageModel } from './vision'

// Reasoning models
export const REASONING_REGEX =
  /^(?!.*-non-reasoning\b)(o\d+(?:-[\w-]+)?|.*\b(?:reasoning|reasoner|thinking|think)\b.*|.*-[rR]\d+.*|.*\bqwq(?:-[\w-]+)?\b.*|.*\bhunyuan-t1(?:-[\w-]+)?\b.*|.*\bglm-zero-preview\b.*|.*\bgrok-(?:3-mini|4|4-fast|build)(?:-[\w-]+)?\b.*)$/i

// Provider/model-family protocol mapping for request encoding is retained
// below (isSupported* helpers). UI whitelist tables and think-model-type
// mapping have been removed: UI options are now metadata-driven only.

/**
 * Single effective reasoning-options resolver (metadata-driven, UI only).
 *
 * Priority:
 * - explicit user override `false` -> undefined (user disabled)
 * - canonical `reasoning` === false -> ['default','none']
 * - otherwise (true or unknown): if provider-specific serving metadata has
 *   `effort.values` -> ['default','none', ...normalized values (`max` -> `xhigh`)]
 *   else generic fallback ['default','none','low','medium','high']
 *
 * `none` and `default` are product options, never sourced solely from
 * serving data. Provider-specific `reasoning_options` never merge into
 * canonical capabilities; serving lookup uses exact provider->source mapping
 * and exact trimmed model-id match. Request layer stays lazy and never gates
 * on these options.
 */
export function getResolvedReasoningOptions(
  model: Model | undefined | null,
  provider?: Provider | null
): ReasoningEffortOption[] | undefined {
  if (!model) return undefined
  const override = isUserSelectedModelType(model, 'reasoning')
  if (override === false) return undefined
  const buildFromServing = (): ReasoningEffortOption[] | undefined => {
    const serving = resolveServingReasoningEffort(model, provider === undefined ? undefined : provider)
    if (serving && serving.length > 0) {
      const result: ReasoningEffortOption[] = ['default', 'none']
      const seen = new Set<string>(['default', 'none'])
      for (const v of serving) {
        const mapped = v === 'max' ? 'xhigh' : v
        if (!seen.has(mapped)) {
          seen.add(mapped)
          result.push(mapped as ReasoningEffortOption)
        }
      }
      return result
    }
    return undefined
  }
  if (override === true) {
    return buildFromServing() ?? (['default', 'none', 'low', 'medium', 'high'] as ReasoningEffortOption[])
  }
  const external = resolveExternalReasoningSupport(model, provider === undefined ? undefined : provider)
  if (external === false) {
    return ['default', 'none']
  }
  const servingOpts = buildFromServing()
  if (servingOpts) return servingOpts
  return ['default', 'none', 'low', 'medium', 'high']
}

export const getModelSupportedReasoningEffortOptions = (
  model: Model | undefined | null,
  provider?: Provider | null
): ReasoningEffortOption[] | undefined => {
  if (!model) return undefined
  if (provider === undefined) return getResolvedReasoningOptions(model)
  return getResolvedReasoningOptions(model, provider)
}

function _isSupportedThinkingTokenModel(model: Model): boolean {
  return (
    isSupportedThinkingTokenGeminiModel(model) ||
    isSupportedThinkingTokenQwenModel(model) ||
    isSupportedThinkingTokenClaudeModel(model) ||
    isSupportedThinkingTokenDoubaoModel(model) ||
    isSupportedThinkingTokenHunyuanModel(model) ||
    isSupportedThinkingTokenZhipuModel(model) ||
    isSupportedThinkingTokenMiMoModel(model) ||
    isSupportedThinkingTokenKimiModel(model) ||
    isSupportedThinkingTokenDeepSeekModel(model)
  )
}

/** 用于判断是否支持控制思考，但不一定以reasoning_effort的方式 */
// TODO: rename it
export function isSupportedThinkingTokenModel(model?: Model): boolean {
  if (!model) return false
  const { idResult, nameResult } = withModelIdAndNameAsId(model, _isSupportedThinkingTokenModel)
  return idResult || nameResult
}

// TODO: it should be merged in isSupportedThinkingTokenModel
export function isSupportedReasoningEffortModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  return (
    isSupportedReasoningEffortOpenAIModel(model) ||
    isSupportedReasoningEffortGrokModel(model) ||
    isSupportedReasoningEffortPerplexityModel(model) ||
    isMistralReasoningModel(model)
  )
}

export function isSupportedReasoningEffortGrokModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  if (isGrok43Model(model)) {
    return true
  }

  const modelId = getLowerBaseModelName(model.id)
  if (modelId.includes('grok-3-mini')) {
    return true
  }

  if (modelId.includes('grok-4-fast') && !modelId.includes('non-reasoning')) {
    return true
  }

  return false
}

// Mistral Small models with adjustable reasoning (mistral-small-2603+)
// Note: magistral-* models reason natively and do NOT accept reasoning_effort parameter
export function isMistralReasoningModel(model?: Model): boolean {
  if (!model) return false
  const modelId = getLowerBaseModelName(model.id)
  return modelId.includes('mistral-small-2603')
}

/**
 * Checks if the model is Grok 4 Fast reasoning version
 * Explicitly excludes non-reasoning variants (models with 'non-reasoning' in their ID)
 *
 * Note: XAI official uses different model IDs for reasoning vs non-reasoning
 * Third-party providers like OpenRouter expose a single ID with reasoning parameters, while first-party providers require separate IDs. Only the OpenRouter variant supports toggling.
 *
 * @param model - The model to check
 * @returns true if the model is a reasoning-enabled Grok 4 Fast model
 */
export function isGrok4FastReasoningModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)
  return modelId.includes('grok-4-fast') && !modelId.includes('non-reasoning')
}

/**
 * Checks if the model is Grok 4.3
 * Explicitly excludes non-reasoning variants (models with 'non-reasoning' in their ID)
 *
 * grok-4.3 is the first xAI model to natively support reasoning_effort with 4 levels:
 * none, low, medium, high
 */
export function isGrok43Model(model?: Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)
  return modelId.includes('grok-4.3') && !modelId.includes('non-reasoning')
}

export function isGrokReasoningModel(model?: Model): boolean {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id)
  if (
    isSupportedReasoningEffortGrokModel(model) ||
    (modelId.includes('grok-4') && !modelId.includes('non-reasoning')) ||
    modelId.includes('grok-build')
  ) {
    return true
  }

  return false
}

export function isGeminiReasoningModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id)
  if (modelId.startsWith('gemini') && modelId.includes('thinking')) {
    return true
  }

  if (isSupportedThinkingTokenGeminiModel(model)) {
    return true
  }

  return false
}

// Gemini 支持思考模式的模型正则
export const GEMINI_THINKING_MODEL_REGEX =
  /gemini-(?:2\.5.*(?:-latest)?|3(?:\.\d+)?-(?:flash|pro)(?:-preview)?|flash-latest|pro-latest|flash-lite-latest)(?:-[\w-]+)*$/i

export const isHostedGemma4ThinkingModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id, '/')
  return modelId.startsWith('gemma-4-')
}

export const isSupportedThinkingTokenGeminiModel = (model: Model): boolean => {
  const modelId = getLowerBaseModelName(model.id, '/')
  if (isHostedGemma4ThinkingModel(model)) {
    return true
  }

  if (GEMINI_THINKING_MODEL_REGEX.test(modelId)) {
    // ref: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-pro-image
    if (modelId.includes('gemini-3-pro-image')) {
      return true
    }
    if (modelId.includes('image') || modelId.includes('tts')) {
      return false
    }
    return true
  } else {
    return false
  }
}

/** 是否为Qwen推理模型 */
export function isQwenReasoningModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id, '/')

  if (modelId.startsWith('qwen3')) {
    if (modelId.includes('thinking')) {
      return true
    }
  }

  if (isSupportedThinkingTokenQwenModel(model)) {
    return true
  }

  if (modelId.includes('qwq') || modelId.includes('qvq')) {
    return true
  }

  return false
}

/** Whether it is a Qwen3 or Qwen3.5 reasoning model that supports thinking control */
export function isSupportedThinkingTokenQwenModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id, '/')

  // Filter specific qwen3 variants
  if (
    ['coder', 'asr', 'tts', 'reranker', 'embedding', 'instruct', 'thinking'].some((field) => modelId.includes(field))
  ) {
    return false
  }

  // qwen 3.5~3.9 series models, all support
  if (/^qwen3\.[5-9]/.test(modelId)) {
    return true
  }

  // dashscope variants, including max, plus, flash
  // instruct/thinking variant already filtered
  // https://help.aliyun.com/zh/model-studio/deep-thinking
  // https://bailian.console.aliyun.com/cn-beijing/?spm=5176.29619931.J_AHgvE-XDhTWrtotIBlDQQ.13.74cd521cKLGUN4&tab=doc#/doc/?type=model&url=2840914
  // Known limitations:
  //    In the global deployment environment, qwen-max still points to the non-reasoning snapshot from 2025-09-23,
  //    whereas in mainland China, qwen-max has been updated to the latest 2026-01-23 snapshot, which supports reasoning control. - 2026-03-05
  const MAX_REGEX = /^(?:qwen3-max(?!-2025-09-23)|qwen-max-latest)(?:-|$)/i
  const PLUS_REGEX = /^qwen(?:3\.[5-9])?-plus(?:-|$)/i
  const FLASH_REGEX = /^qwen(?:3\.[5-9])?-flash(?:-|$)/i
  const TURBO_REGEX = /^qwen(?:3\.[5-9])?-turbo(?:-|$)/i
  // open-weight qwen3 models with numeric size (e.g. qwen3-8b, qwen3-72b)
  const QWEN3_OPEN_REGEX = /^qwen3-\d/i

  return (
    MAX_REGEX.test(modelId) ||
    PLUS_REGEX.test(modelId) ||
    FLASH_REGEX.test(modelId) ||
    TURBO_REGEX.test(modelId) ||
    QWEN3_OPEN_REGEX.test(modelId)
  )
}

/** 是否为不支持思考控制的Qwen推理模型 */
export function isQwenAlwaysThinkModel(model?: Model): boolean {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  // 包括 qwen3 开头的 thinking 模型和 qwen3-vl 的 thinking 模型
  return (
    (modelId.startsWith('qwen3') && modelId.includes('thinking')) ||
    (modelId.includes('qwen3-vl') && modelId.includes('thinking'))
  )
}

// Doubao 支持思考模式的模型正则
export const DOUBAO_THINKING_MODEL_REGEX =
  /doubao-(?:1[.-]5-thinking-vision-pro|1[.-]5-thinking-pro-m|seed-1[.-][68](?:-flash)?(?!-(?:thinking)(?:-|$))|seed-code(?:-preview)?(?:-\d+)?|seed-2[.-]0(?:-[\w-]+)?)(?:-[\w-]+)*/i

// 支持 auto 的 Doubao 模型 doubao-seed-1.6-xxx doubao-seed-1-6-xxx  doubao-1-5-thinking-pro-m-xxx
// Auto thinking is no longer supported after version 251015, see https://console.volcengine.com/ark/region:ark+cn-beijing/model/detail?Id=doubao-seed-1-6
export const DOUBAO_THINKING_AUTO_MODEL_REGEX =
  /doubao-(1-5-thinking-pro-m|seed-1[.-]6)(?!-(?:flash|thinking)(?:-|$))(?:-lite)?(?!-251015)(?:-\d+)?$/i

export function isDoubaoThinkingAutoModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id)
  return DOUBAO_THINKING_AUTO_MODEL_REGEX.test(modelId) || DOUBAO_THINKING_AUTO_MODEL_REGEX.test(model.name)
}

export function isDoubaoSeedAfter251015(model: Model): boolean {
  const pattern = /doubao-seed-1-6-(?:lite-)?251015|doubao-seed-2[.-]0/i
  return pattern.test(model.id) || pattern.test(model.name)
}

export function isDoubaoSeed18Model(model: Model): boolean {
  const pattern = /doubao-seed-1[.-]8(?:-[\w-]+)?/i
  return pattern.test(model.id) || pattern.test(model.name)
}

export function isSupportedThinkingTokenDoubaoModel(model?: Model): boolean {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id, '/')

  return DOUBAO_THINKING_MODEL_REGEX.test(modelId) || DOUBAO_THINKING_MODEL_REGEX.test(model.name)
}

export function isClaude45ReasoningModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id, '/')
  const regex = /claude-(sonnet|opus|haiku)-4(-|.)5(?:-[\w-]+)?$/i
  return regex.test(modelId)
}

export function isClaude4SeriesModel(model: Model): boolean {
  const modelId = getLowerBaseModelName(model.id, '/')
  // Supports various formats including:
  // - Direct API: claude-sonnet-4, claude-opus-4-20250514
  // - GCP Vertex AI: claude-sonnet-4@20250514
  // - AWS Bedrock: anthropic.claude-sonnet-4-20250514-v1:0
  const regex = /claude-(sonnet|opus|haiku)-4(?:[.-]\d+)?(?:[@\-:][\w\-:]+)?$/i
  return regex.test(modelId)
}

export function isClaudeReasoningModel(model?: Model): boolean {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  return (
    modelId.includes('claude-3-7-sonnet') ||
    modelId.includes('claude-3.7-sonnet') ||
    modelId.includes('claude-sonnet-4') ||
    modelId.includes('claude-opus-4') ||
    modelId.includes('claude-haiku-4')
  )
}

export const isSupportedThinkingTokenClaudeModel = isClaudeReasoningModel

export const isSupportedThinkingTokenHunyuanModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  return modelId.includes('hunyuan-a13b')
}

export const isHunyuanReasoningModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')

  return isSupportedThinkingTokenHunyuanModel(model) || modelId.includes('hunyuan-t1')
}

export const isPerplexityReasoningModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }

  const modelId = getLowerBaseModelName(model.id, '/')
  return (
    isSupportedReasoningEffortPerplexityModel(model) ||
    (modelId.includes('reasoning') && !modelId.includes('non-reasoning'))
  )
}

export const isSupportedReasoningEffortPerplexityModel = (model: Model): boolean => {
  const modelId = getLowerBaseModelName(model.id, '/')
  return modelId.includes('sonar-deep-research')
}

/**
 * Checks whether a Zhipu model supports thinking token control.
 *
 * Matches model IDs containing:
 * - `glm5` or `glm-5` (GLM-5 series)
 * - `glm-4.5`, `glm-4.6`, `glm-4.7` (GLM-4.x advanced series)
 *
 * Note: GLM-Z1 reasoning models are NOT included here — they are covered
 * by {@link isZhipuReasoningModel} instead.
 */
export const isSupportedThinkingTokenZhipuModel = (model: Model): boolean => {
  const modelId = getLowerBaseModelName(model.id, '/')
  return /glm-?5|glm-4\.[567]/.test(modelId)
}

export const isSupportedThinkingTokenMiMoModel = (model: Model): boolean => {
  const modelId = getLowerBaseModelName(model.id, '/')
  return ['mimo-v2-flash', 'mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2.5', 'mimo-v2.5-pro'].includes(modelId)
}

/**
 * Detects whether a Kimi model supports thinking control
 *
 * This function identifies Kimi models that support thinking token control.
 * Currently only supports Kimi K2.5 / K2.6 and their variants.
 *
 * @param model - The model object to check
 * @returns true if the model supports thinking control, false otherwise
 */
const _isSupportedThinkingTokenKimiModel = (model: Model): boolean => {
  return isKimi25OrNewerModel(model)
}

export const isSupportedThinkingTokenKimiModel = (model: Model): boolean => {
  const { idResult, nameResult } = withModelIdAndNameAsId(model, _isSupportedThinkingTokenKimiModel)
  return idResult || nameResult
}

/**
 * Matches DeepSeek V4+ models (e.g., deepseek-v4-flash, deepseek-v4-pro, deepseek-v5-xxx).
 * V4+ models default to thinking enabled and support reasoning_effort: "high" | "max".
 */
export const isDeepSeekV4PlusModel = (model: Model) => {
  const { idResult, nameResult } = withModelIdAndNameAsId(model, (model) => {
    // Ignore routed provider suffix chains like :deepseek or :deepseek:together.
    const modelId = getLowerBaseModelName(model.id).split(':', 1)[0]
    // Match deepseek-v{N} where N >= 4, with any optional suffix
    return /(\w+-)?deepseek-v([4-9]|\d{2,})([.-]\w+)*$/.test(modelId)
  })
  return idResult || nameResult
}

export const isDeepSeekHybridInferenceModel = (model: Model) => {
  const { idResult, nameResult } = withModelIdAndNameAsId(model, (model) => {
    const modelId = getLowerBaseModelName(model.id)
    // openrouter: deepseek/deepseek-chat-v3.1 不知道会不会有其他provider仿照ds官方分出一个同id的作为非思考模式的模型，这里有风险
    // 这里假定所有deepseek-chat都是deepseek-v3.2
    // Matches: "deepseek-v3" followed by ".digit" or "-digit".
    // Optionally, this can be followed by ".alphanumeric_sequence" or "-alphanumeric_sequence"
    // until the end of the string.
    // Examples: deepseek-v3.1, deepseek-v3-1, deepseek-v3.1.2, deepseek-v3.1-alpha
    // Does NOT match: deepseek-v3.123 (missing separator after '1'), deepseek-v3.x (x isn't a digit)
    // TODO: move to utils and add test cases
    return (
      /(\w+-)?deepseek-v3(?:\.\d|-\d)(?:(\.|-)(?!speciale$)\w+)?$/.test(modelId) ||
      modelId.includes('deepseek-chat-v3.1') ||
      modelId.includes('deepseek-chat')
    )
  })
  return idResult || nameResult || isDeepSeekV4PlusModel(model)
}

export const isLingReasoningModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  return ['ring-1t', 'ring-mini', 'ring-flash'].some((id) => modelId.includes(id))
}

export const isSupportedThinkingTokenDeepSeekModel = isDeepSeekHybridInferenceModel

export const isZhipuReasoningModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  return isSupportedThinkingTokenZhipuModel(model) || modelId.includes('glm-z1')
}

export const isMiMoReasoningModel = isSupportedThinkingTokenMiMoModel

export const isStepReasoningModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  return modelId.includes('step-3') || modelId.includes('step-r1-v-mini')
}

export const isMiniMaxReasoningModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')
  return (['minimax-m1', 'minimax-m2', 'minimax-m2.1', 'minimax-m2.5', 'minimax-m2.7', 'minimax-m3'] as const).some(
    (id) => modelId.includes(id)
  )
}

export const isBaichuanReasoningModel = (model?: Model): boolean => {
  if (!model) {
    return false
  }
  const modelId = getLowerBaseModelName(model.id, '/')

  // Baichuan-M2 和 Baichuan-M3 是推理模型
  return modelId === 'baichuan-m2' || modelId === 'baichuan-m3'
}

/**
 * Check if the model is a Kimi reasoning model
 *
 * This function identifies Moonshot AI's Kimi series reasoning models.
 * Currently should only support:
 * - Kimi K2 Thinking and its variants (including -turbo suffix)
 * - Kimi K2.5+ (K2.5, K2.6, ...) and K3+ (K3, K3.x, K4, ...)
 *
 * @param model - The model object to check, can be undefined
 * @returns true if it's a Kimi reasoning model, false otherwise
 */
const _isKimiReasoningModel = (model: Model): boolean => {
  const modelId = getLowerBaseModelName(model.id, '/')
  // Match kimi-k2-thinking, kimi-k2-thinking-turbo, or kimi-k2.5+ / kimi-k3+
  return /^kimi-k2-thinking(?:-turbo)?$|^kimi-k(?:2\.[5-9]\d*|[3-9]\d*)(?:[.-]\w+)*$/.test(modelId)
}

export function isKimiReasoningModel(model?: Model): boolean {
  if (!model) {
    return false
  }
  const { idResult, nameResult } = withModelIdAndNameAsId(model, _isKimiReasoningModel)
  return idResult || nameResult
}

export function isReasoningModel(model?: Model): boolean {
  if (!model || isEmbeddingModel(model) || isRerankModel(model) || isTextToImageModel(model)) {
    return false
  }

  if (isUserSelectedModelType(model, 'reasoning') !== undefined) {
    return isUserSelectedModelType(model, 'reasoning')!
  }

  // Optional models.dev enrichment: validated external `reasoning` outranks
  // the legacy name heuristic; unknown stays permissive (falls through below).
  const externalReasoning = resolveCapabilityWithOverride(model, 'reasoning', resolveExternalReasoningSupport(model))
  if (externalReasoning !== undefined) {
    return externalReasoning
  }

  const modelId = getLowerBaseModelName(model.id)

  if (modelId.includes('doubao') || (model.name && getLowerBaseModelName(model.name).includes('doubao'))) {
    return (
      REASONING_REGEX.test(modelId) ||
      REASONING_REGEX.test(model.name) ||
      isSupportedThinkingTokenDoubaoModel(model) ||
      isDeepSeekHybridInferenceModel(model) ||
      false
    )
  }

  if (
    isClaudeReasoningModel(model) ||
    isOpenAIReasoningModel(model) ||
    isGeminiReasoningModel(model) ||
    isQwenReasoningModel(model) ||
    isGrokReasoningModel(model) ||
    isHunyuanReasoningModel(model) ||
    isPerplexityReasoningModel(model) ||
    isZhipuReasoningModel(model) ||
    isStepReasoningModel(model) ||
    isDeepSeekHybridInferenceModel(model) ||
    isLingReasoningModel(model) ||
    isMiniMaxReasoningModel(model) ||
    isMiMoReasoningModel(model) ||
    isBaichuanReasoningModel(model) ||
    isKimiReasoningModel(model) ||
    modelId.includes('magistral') ||
    modelId.includes('mistral-small-2603') ||
    modelId.includes('pangu-pro-moe') ||
    modelId.includes('seed-oss') ||
    modelId.includes('deepseek-v3.2-speciale') ||
    modelId.includes('gemma-4') ||
    modelId.includes('gemma4')
  ) {
    return true
  }

  return REASONING_REGEX.test(modelId) || false
}

const THINKING_TOKEN_MAP: Record<string, { min: number; max: number }> = {
  // Gemini models
  'gemini-2\\.5-flash-lite.*$': { min: 512, max: 24576 },
  'gemini-.*-flash.*$': { min: 0, max: 24576 },
  'gemini-.*-pro.*$': { min: 128, max: 32768 },

  // Qwen models
  // qwen-plus-x 系列自 qwen-plus-2025-07-28 后模型最长思维链变为 81_920, qwen-plus 模型于 2025.9.16 同步变更
  'qwen3-235b-a22b-thinking-2507$': { min: 0, max: 81_920 },
  'qwen3-30b-a3b-thinking-2507$': { min: 0, max: 81_920 },
  'qwen3-vl-235b-a22b-thinking$': { min: 0, max: 81_920 },
  'qwen3-vl-30b-a3b-thinking$': { min: 0, max: 81_920 },
  'qwen-plus-2025-07-14$': { min: 0, max: 38_912 },
  'qwen-plus-2025-04-28$': { min: 0, max: 38_912 },
  'qwen3-1\\.7b$': { min: 0, max: 30_720 },
  'qwen3-0\\.6b$': { min: 0, max: 30_720 },
  'qwen-plus.*$': { min: 0, max: 81_920 },
  'qwen-turbo.*$': { min: 0, max: 38_912 },
  'qwen-flash.*$': { min: 0, max: 81_920 },
  // qwen3-max series (reasoning models, equivalent to qwen-plus for thinking budget)
  'qwen3-max(-.*)?$': { min: 0, max: 81_920 },
  // Qwen3.5+ series (max thinking budget: 81920)
  '^qwen3\\.[5-9]': { min: 0, max: 81_920 },
  'qwen3-(?!max).*$': { min: 1024, max: 38_912 },

  // Claude models (supports AWS Bedrock 'anthropic.' prefix, GCP Vertex AI '@' separator, and '-v1:0' suffix)
  // Opus 4.7+ supports 128K output tokens. Uses adaptive thinking (no budgetTokens sent),
  // but the limit entry is still consulted for the Poe / openai-compatible fallback paths.
  '(?:anthropic\\.)?claude-opus-4[.-](?:[7-9]|[1-9]\\d)(?:[@\\-:][\\w\\-:]+)?$': { min: 1024, max: 128_000 },
  // Opus 4.6 supports 128K output tokens
  '(?:anthropic\\.)?claude-opus-4[.-]6(?:[@\\-:][\\w\\-:]+)?$': { min: 1024, max: 128_000 },
  // Sonnet 4.6, and Haiku is assumed to be also 64k
  '(?:anthropic\\.)?claude-(:?sonnet|haiku)-4[.-]6.*(?:-v\\d+:\\d+)?$': { min: 1024, max: 64_000 },
  // 4.5 series
  '(?:anthropic\\.)?claude-(:?haiku|sonnet|opus)-4[.-]5.*(?:-v\\d+:\\d+)?$': { min: 1024, max: 64_000 },
  // Opus 4.1
  '(?:anthropic\\.)?claude-opus-4[.-]1.*(?:-v\\d+:\\d+)?$': { min: 1024, max: 32_000 },
  // 4.0 series
  '(?:anthropic\\.)?claude-sonnet-4(?:[.-]0)?(?:[@-](?:\\d{4,}|[a-z][\\w-]*))?(?:-v\\d+:\\d+)?$': {
    min: 1024,
    max: 64_000
  },
  '(?:anthropic\\.)?claude-opus-4(?:[.-]0)?(?:[@-](?:\\d{4,}|[a-z][\\w-]*))?(?:-v\\d+:\\d+)?$': {
    min: 1024,
    max: 32_000
  },
  // 3.7
  '(?:anthropic\\.)?claude-3[.-]7.*sonnet.*(?:-v\\d+:\\d+)?$': { min: 1024, max: 64_000 },

  // Baichuan models
  'baichuan-m2$': { min: 0, max: 30_000 },
  'baichuan-m3$': { min: 0, max: 30_000 },

  // Gemma 4 models (GenAI: gemma-4-*, Ollama: gemma4:*)
  'gemma-?4[:-]?e[24]b': { min: 1024, max: 8192 },
  'gemma-?4[:-]?26b': { min: 1024, max: 30720 },
  'gemma-?4[:-]?31b': { min: 1024, max: 30720 }
}

export const findTokenLimit = (modelId: string): { min: number; max: number } | undefined => {
  for (const [pattern, limits] of Object.entries(THINKING_TOKEN_MAP)) {
    if (new RegExp(pattern, 'i').test(modelId)) {
      return limits
    }
  }
  return undefined
}

/**
 * Fixed reasoning UI has been removed: provider-specific serving metadata
 * drives the strength menu and `default`/`none` are always product options.
 * This helper is kept for backward compatibility for non-UI callers but
 * always returns false. Request encoding retains its own provider/model-family
 * protocol mapping elsewhere.
 */
export const isFixedReasoningModel = (_model: Model | undefined | null, _provider?: Provider | null): boolean => false

// https://platform.minimaxi.com/docs/guides/text-m2-function-call#openai-sdk
// https://docs.z.ai/guides/capabilities/thinking-mode
// https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model#%E5%A4%9A%E6%AD%A5%E5%B7%A5%E5%85%B7%E8%B0%83%E7%94%A8
/** @deprecated No longer used. */
const INTERLEAVED_THINKING_MODEL_REGEX =
  /minimax-m2(.(\d+))?(?:-[\w-]+)?|mimo-v2-flash|glm-5(?:.\d+)?(?:-[\w-]+)?|glm-4.(\d+)(?:-[\w-]+)?|kimi-k2-thinking?|kimi-k2\.[56](?:-[\w-]+)?$/i

/**
 * Determines whether the given model supports interleaved thinking.
 *
 * @deprecated No longer used.
 * @param model - The model object to check.
 * @returns `true` if the model's ID matches the interleaved thinking model pattern; otherwise, `false`.
 */
export const isInterleavedThinkingModel = (model: Model) => {
  const modelId = getLowerBaseModelName(model.id)
  return INTERLEAVED_THINKING_MODEL_REGEX.test(modelId)
}
