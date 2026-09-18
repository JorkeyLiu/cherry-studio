import type { AnthropicProviderOptions } from '@ai-sdk/anthropic'
import type { GoogleGenerativeAIProviderOptions } from '@ai-sdk/google'
import type { OpenAIResponsesProviderOptions } from '@ai-sdk/openai'
import type OpenAI from '@cherrystudio/openai'
import { loggerService } from '@logger'
import { DEFAULT_MAX_TOKENS } from '@renderer/config/constant'
import {
  findTokenLimit,
  GEMINI_FLASH_MODEL_REGEX,
  getModelSupportedReasoningEffortOptions,
  isClaude46SeriesModel,
  isDeepSeekHybridInferenceModel,
  isDeepSeekV4PlusModel,
  isDoubaoSeed18Model,
  isDoubaoSeedAfter251015,
  isDoubaoThinkingAutoModel,
  isGemini3ThinkingTokenModel,
  isGrok4FastReasoningModel,
  isHostedGemma4ThinkingModel,
  isMiniMaxReasoningModel,
  isOpenAIDeepResearchModel,
  isOpenAIModel,
  isQwenReasoningModel,
  isReasoningModel,
  isSupportAdaptiveThinkingClaudeModel,
  isSupportedReasoningEffortModel,
  isSupportedReasoningEffortOpenAIModel,
  isSupportedThinkingTokenClaudeModel,
  isSupportedThinkingTokenDoubaoModel,
  isSupportedThinkingTokenGeminiModel,
  isSupportedThinkingTokenHunyuanModel,
  isSupportedThinkingTokenKimiModel,
  isSupportedThinkingTokenMiMoModel,
  isSupportedThinkingTokenModel,
  isSupportedThinkingTokenZhipuModel,
  isSupportNoneReasoningEffortModel,
  resolveExternalReasoningSupport
} from '@renderer/config/models'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import { getAssistantSettings, getProviderByModel } from '@renderer/services/AssistantService'
import type { Assistant, Model, ReasoningEffortOption } from '@renderer/types'
import { EFFORT_RATIO } from '@renderer/types'
import type { OpenAIReasoningEffort, OpenAIReasoningSummary } from '@renderer/types/aiCoreTypes'
import { getLowerBaseModelName } from '@renderer/utils'

const logger = loggerService.withContext('reasoning')

type ReasoningEffortOptionalParams = {
  thinking?: { type: 'disabled' | 'enabled' | 'auto'; budget_tokens?: number }
  reasoning?: { max_tokens?: number; exclude?: boolean; effort?: string; enabled?: boolean } | OpenAI.Reasoning
  // Generic OpenAI-compatible emits only this camelCase key (AI SDK
  // openai-compatible accepts `reasoningEffort` and overwrites snake_case
  // `reasoning_effort` to undefined). Persisted/user `reasoning_effort`
  // settings and custom-parameter conversion stay snake_case; see options.ts.
  reasoningEffort?: OpenAIReasoningEffort
  // Add any other potential reasoning-related keys here if they exist
}

// The function is only for generic provider. May extract some logics to independent provider
export function getReasoningEffort(assistant: Assistant, model: Model): ReasoningEffortOptionalParams {
  const provider = getProviderByModel(model)
  if (!provider) {
    // Unconfigured model/provider: fail explicitly before any provider/API
    // invocation.
    throw new Error('Model provider is not configured')
  }
  const modelId = getLowerBaseModelName(model.id)

  if (!isReasoningModel(model)) {
    return {}
  }

  // MiniMax models: always enable thinking to ensure <think> tags in response
  // This must be before the reasoningEffort check because MiniMax needs thinking
  // to be explicitly enabled regardless of the user's reasoning effort setting
  if (isMiniMaxReasoningModel(model)) {
    const reasoningEffort = assistant?.settings?.reasoning_effort
    if (reasoningEffort === 'none') {
      return { thinking: { type: 'disabled' } }
    }
    return { thinking: { type: 'enabled' } }
  }

  if (isOpenAIDeepResearchModel(model)) {
    // Generic emits AI-SDK-supported camelCase only; snake_case is overwritten
    // to undefined by the openai-compatible provider.
    return {
      reasoningEffort: 'medium'
    }
  }
  const reasoningEffort = assistant?.settings?.reasoning_effort

  // reasoningEffort is not set, no extra reasoning setting
  // Generally, for every model which supports reasoning control, the reasoning effort won't be undefined.
  // It's for some reasoning models that don't support reasoning control, such as deepseek reasoner.
  if (!reasoningEffort || reasoningEffort === 'default') {
    return {}
  }

  // Handle 'none' reasoningEffort. It's explicitly off.
  // Debranded: capability follows the model family only. Only generic
  // protocol-standard shapes are emitted (`thinking`, `reasoningEffort`,
  // `reasoning`); vendor private keys (`enable_thinking`,
  // `chat_template_kwargs`, vendor-specific `extra_body`) are never derived
  // from names/providers. Provider ids are opaque join keys.
  // Capability-driven: each known family emits its explicit off-shape.
  // External-only reasoning (exact metadata, no heuristic family) uses the
  // generic disable shape. Unknown models fall through to {} so basic
  // requests are never blocked.
  if (reasoningEffort === 'none') {
    // Models with an explicit none-effort level (GPT-5.x sub-versions,
    // Mistral Small): use the generic effort shape.
    if (isSupportNoneReasoningEffortModel(model) || modelId.includes('mistral-small-2603')) {
      return { reasoningEffort: 'none' }
    }

    // Thinking-token families (Qwen, Doubao, Zhipu, MiMo, Kimi, Hunyuan,
    // Gemini, Claude, DeepSeek V4+/hybrid, MiniMax handled above): generic
    // disable shape.
    if (
      isSupportedThinkingTokenModel(model) ||
      isDeepSeekV4PlusModel(model) ||
      isDeepSeekHybridInferenceModel(model) ||
      isQwenReasoningModel(model) ||
      isSupportedThinkingTokenHunyuanModel(model)
    ) {
      return { thinking: { type: 'disabled' } }
    }

    // Effort families that publish a none level: generic effort shape;
    // otherwise the generic disable representation.
    if (isSupportedReasoningEffortModel(model)) {
      const supportedOptions = getModelSupportedReasoningEffortOptions(model)?.filter((option) => option !== 'default')
      if (supportedOptions?.includes('none')) {
        return { reasoningEffort: 'none' }
      }
      return { reasoning: { enabled: false, exclude: true } }
    }

    // External-only resolved `none` (exact metadata override with no
    // heuristic family): generic disable shape, the least-assumptive
    // protocol-standard representation.
    if (resolveExternalReasoningSupport(model) === true) {
      return { thinking: { type: 'disabled' } }
    }

    logger.warn(`Model ${model.id} doesn't match any disable reasoning behavior. Fallback to empty reasoning param.`)
    return {}
  }

  // Positive effort path. Debranded: model family/name heuristics and
  // external reasoning metadata only. No brand-id branches.
  // Generic OpenAI-compatible
  // emits only generic shapes (`thinking`, `reasoningEffort`, `reasoning`);
  // snake_case `reasoning_effort` is never emitted here (AI SDK
  // openai-compatible overwrites it to undefined) — user custom
  // `reasoning_effort` params still convert via options.ts. Vendor private
  // keys are never derived from names/providers. Unknown models without
  // metadata fall through to {} so basic requests are never blocked.
  // Capability-driven (not UI-list vetoed): the absence of explicit effort
  // metadata never invalidates existing protocol-supported thinking
  // controls. Only families with a closed level set reject unlisted levels
  // with {} (never a silent change to an unrelated level, never a
  // `supported[0]` guess). UI/normalization already restrict visible
  // options to sendable ones via the single resolver.
  const effortRatio = EFFORT_RATIO[reasoningEffort]
  const tokenLimit = findTokenLimit(modelId)
  let budgetTokens: number | undefined
  if (tokenLimit) {
    budgetTokens = Math.floor((tokenLimit.max - tokenLimit.min) * effortRatio + tokenLimit.min)
  }

  // Grok 4 Fast toggle-only: the lane emits only on/off. `auto` is the
  // resolved on-level; effort levels are not sendable here (guarded above).
  if (isGrok4FastReasoningModel(model)) {
    if (reasoningEffort !== 'auto') return {}
    return {
      reasoning: {
        enabled: true
      }
    }
  }

  // DeepSeek V4+ models support reasoningEffort: "high" | "max" alongside thinking control
  // UI uses "xhigh" (displayed as Max) which maps to API's "max".
  // Generic emits AI-SDK-supported camelCase only. Only resolved levels emit.
  if (isDeepSeekV4PlusModel(model)) {
    if (reasoningEffort !== 'high' && reasoningEffort !== 'xhigh') return {}
    return {
      thinking: { type: 'enabled' as const },
      reasoningEffort: reasoningEffort === 'xhigh' ? ('max' as OpenAIReasoningEffort) : 'high'
    }
  }

  // DeepSeek hybrid inference models (v3.1+): generic enabled shape.
  // Former per-brand switches (dashscope/new-api/hunyuan/doubao/deepseek/
  // aihubmix/sophnet/ppio/dmxapi/openrouter/together) collapsed: provider ids
  // are opaque join keys, so every connection uses the least-assumptive
  // generic representation.
  if (isDeepSeekHybridInferenceModel(model)) {
    return {
      thinking: {
        type: 'enabled' // auto is invalid
      }
    }
  }

  // Qwen reasoning families: generic enabled shape. Former
  // enable_thinking/chat_template_kwargs vendor keys removed.
  if (isQwenReasoningModel(model)) {
    return {
      thinking: { type: 'enabled' as const }
    }
  }

  // Hunyuan thinking family: generic enabled shape.
  if (isSupportedThinkingTokenHunyuanModel(model)) {
    return {
      thinking: { type: 'enabled' as const }
    }
  }

  // Grok models/Perplexity models/OpenAI models, use reasoningEffort.
  // Closed level set: unlisted selections emit {} (never supported[0]).
  if (isSupportedReasoningEffortModel(model)) {
    const supportedOptions = getModelSupportedReasoningEffortOptions(model)?.filter((option) => option !== 'default')
    if (supportedOptions?.includes(reasoningEffort)) {
      return {
        reasoningEffort
      }
    }
    return {}
  }

  // Mistral Small models use reasoningEffort with 'none' | 'high'.
  // `none` is handled above; only resolved `high` emits here.
  if (modelId.includes('mistral-small-2603')) {
    if (reasoningEffort !== 'high') return {}
    return { reasoningEffort: 'high' }
  }

  // gemini series, openai compatible api: generic effort shape.
  // Former vendor-specific extra_body.google.thinking_config removed; every
  // Gemini thinking family uses the protocol-standard representation.
  // https://ai.google.dev/gemini-api/docs/gemini-3?thinking=high#openai_compatibility
  if (isSupportedThinkingTokenGeminiModel(model)) {
    return {
      reasoningEffort
    }
  }

  // Claude models, openai compatible api
  if (isSupportedThinkingTokenClaudeModel(model)) {
    const maxTokens = assistant.settings?.maxTokens
    return {
      thinking: {
        type: 'enabled',
        budget_tokens: budgetTokens
          ? Math.floor(Math.max(1024, Math.min(budgetTokens, (maxTokens || DEFAULT_MAX_TOKENS) * effortRatio)))
          : undefined
      }
    }
  }

  // Use thinking, doubao, zhipu, etc.
  if (isSupportedThinkingTokenDoubaoModel(model)) {
    if (isDoubaoSeedAfter251015(model) || isDoubaoSeed18Model(model)) {
      return { reasoningEffort }
    }
    if (reasoningEffort === 'high') {
      return { thinking: { type: 'enabled' } }
    }
    if (reasoningEffort === 'auto' && isDoubaoThinkingAutoModel(model)) {
      return { thinking: { type: 'auto' } }
    }
    // 其他情况不带 thinking 字段
    return {}
  }
  if (isSupportedThinkingTokenZhipuModel(model)) {
    return { thinking: { type: 'enabled' } }
  }

  if (isSupportedThinkingTokenMiMoModel(model) || isSupportedThinkingTokenKimiModel(model)) {
    return {
      thinking: { type: 'enabled' }
    }
  }

  // External-only resolved controls with no heuristic family: emit the
  // least-assumptive generic shapes. Toggle `auto` maps to enabled (the
  // lane's explicit on-shape); named effort levels map to generic
  // `reasoningEffort`. Budget-only external resolves to fixed (`default`
  // only) and never reaches an emit here. No budget-as-effort invention.
  // Truly unknown models (no external reasoning, no heuristic family)
  // return {} so basic requests are never blocked.
  if (resolveExternalReasoningSupport(model) === true) {
    if (reasoningEffort === 'auto') {
      return { thinking: { type: 'enabled' as const } }
    }
    return { reasoningEffort }
  }

  // Default case: no special thinking settings
  return {}
}

/**
 * Get OpenAI reasoning parameters
 * Extracted from OpenAIResponseAPIClient and OpenAIAPIClient logic
 * For official OpenAI provider only
 */
export function getOpenAIReasoningParams(
  assistant: Assistant,
  model: Model
): Pick<OpenAIResponsesProviderOptions, 'reasoningEffort' | 'reasoningSummary'> {
  if (!isReasoningModel(model)) {
    return {}
  }

  let reasoningEffort = assistant?.settings?.reasoning_effort

  if (!reasoningEffort || reasoningEffort === 'default') {
    return {}
  }

  // Deep-research models expose only `medium` on this lane; `auto`
  // (toggle-on) maps to the lane's explicit default on-level. These are the
  // lane's protocol-supported shapes, not a silent level change: UI offers
  // only sendable controls via the single resolver.
  if (isOpenAIDeepResearchModel(model) || reasoningEffort === 'auto') {
    reasoningEffort = 'medium'
  }

  // 非OpenAI模型，但是Provider类型是responses/azure openai的情况
  if (!isOpenAIModel(model)) {
    return {
      reasoningEffort
    }
  }

  const openAI = getStoreSetting('openAI')
  const summaryText = openAI.summaryText

  let reasoningSummary: OpenAIReasoningSummary = undefined

  if (model.id.includes('o1-pro')) {
    reasoningSummary = undefined
  } else {
    reasoningSummary = summaryText
  }

  // OpenAI 推理参数
  if (isSupportedReasoningEffortOpenAIModel(model)) {
    return {
      reasoningEffort,
      reasoningSummary
    }
  }

  return {}
}

// Conservative fallback token limit for models not in THINKING_TOKEN_MAP.
const FALLBACK_TOKEN_LIMIT = { min: 1024, max: 16384 }

function computeBudgetTokens(
  tokenLimit: { min: number; max: number },
  effortRatio: number,
  maxTokens?: number
): number {
  const budget = Math.floor((tokenLimit.max - tokenLimit.min) * effortRatio + tokenLimit.min)
  const capped = maxTokens !== undefined ? Math.min(budget, maxTokens) : budget
  return Math.max(1024, capped)
}

export function getThinkingBudget(
  maxTokens: number | undefined,
  reasoningEffort: string | undefined,
  modelId: string
): number | undefined {
  if (reasoningEffort === undefined || reasoningEffort === 'none') {
    return undefined
  }

  const tokenLimit = findTokenLimit(modelId)
  if (!tokenLimit) {
    return undefined
  }

  return computeBudgetTokens(tokenLimit, EFFORT_RATIO[reasoningEffort], maxTokens)
}

// Compute a fallback budgetTokens using a conservative token limit when
// findTokenLimit() cannot determine the model's actual limit. This ensures
// { type: 'enabled' } always carries a valid budget, which is required by
// the Claude Agent SDK and the Anthropic Messages API.
function getFallbackBudgetTokens(reasoningEffort: string | undefined): number {
  const effortRatio = EFFORT_RATIO[reasoningEffort ?? 'high'] ?? EFFORT_RATIO.high
  return computeBudgetTokens(FALLBACK_TOKEN_LIMIT, effortRatio)
}

/**
 * Get Anthropic reasoning parameters.
 * Extracted from AnthropicAPIClient logic.
 *
 * Returns different parameter shapes depending on the model:
 * - **Claude Opus 4.7+**: `{ thinking: { type: 'adaptive', display: 'summarized' }, effort?: 'low' | 'medium' | 'high' | 'xhigh' }`
 *   Uses the new adaptive thinking API with effort-based control.
 * - **Claude 4.6**: `{ thinking: { type: 'adaptive' }, effort: 'low' | 'medium' | 'high' | 'max' }`
 *   Uses the new adaptive thinking API with effort-based control.
 * - **Other Claude models** (4.0, 4.1, 4.5, etc.): `{ thinking: { type: 'enabled', budgetTokens: number } }`
 *   Uses the classic thinking API with explicit token budget.
 * - **Non-Anthropic models served via the Claude-compatible endpoint** (Kimi, MiniMax,
 *   DeepSeek V4+, etc.): `{ thinking: { type: 'enabled', budgetTokens: number }, sendReasoning: true, effort? }`
 *   `sendReasoning: true` ensures reasoning output is streamed back to the UI.
 *   `effort` is only added for DeepSeek V4+ (`high` | `xhigh` → `high` | `max`).
 */
export function getAnthropicReasoningParams(
  assistant: Assistant,
  model: Model
): {
  thinking?: AnthropicProviderOptions['thinking']
  effort?: AnthropicProviderOptions['effort']
  sendReasoning?: AnthropicProviderOptions['sendReasoning']
} {
  if (!isReasoningModel(model)) {
    return {}
  }

  const reasoningEffort = assistant?.settings?.reasoning_effort

  if (!reasoningEffort || reasoningEffort === 'default') {
    return {}
  }

  if (reasoningEffort === 'none') {
    return {
      thinking: {
        type: 'disabled'
      }
    }
  }

  // Claude reasoning parameters
  if (isSupportedThinkingTokenClaudeModel(model)) {
    // Claude Opus 4.7+: adaptive thinking + native 'xhigh' effort.
    // Also requires thinking.display: 'summarized' — API defaults to 'omitted'
    // (no reasoning text in response), which would break Cherry's thinking UI.
    // `minimal`/`auto` are not native Claude effort levels: adaptive is
    // emitted without effort so callers fall back to API defaults (never a
    // silent map to `low`).
    if (isSupportAdaptiveThinkingClaudeModel(model)) {
      const effort47Map = {
        default: undefined,
        auto: undefined,
        minimal: undefined,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh'
      } as const satisfies Record<Exclude<ReasoningEffortOption, 'none'>, AnthropicProviderOptions['effort']>
      const effort = effort47Map[reasoningEffort]
      const thinking = { type: 'adaptive', display: 'summarized' } as const
      return effort ? { thinking, effort } : { thinking }
    }

    // Claude 4.6 uses adaptive thinking + effort parameters.
    // `minimal` is not a native Claude effort level: adaptive is emitted
    // without effort (API default), never silently mapped to `low`.
    if (isClaude46SeriesModel(model)) {
      // Claude 4.6 supports: low, medium, high, max
      // (xhigh displays as Max and maps to max).
      const effortMap = {
        default: undefined,
        auto: undefined,
        minimal: undefined,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'max'
      } as const satisfies Record<Exclude<ReasoningEffortOption, 'none'>, AnthropicProviderOptions['effort']>
      const effort = effortMap[reasoningEffort]
      return effort ? { thinking: { type: 'adaptive' }, effort } : { thinking: { type: 'adaptive' } }
    }

    // Other Claude models continue using enabled + budgetTokens
    const { maxTokens } = getAssistantSettings(assistant)
    const budgetTokens = getThinkingBudget(maxTokens, reasoningEffort, model.id)

    return {
      thinking: {
        type: 'enabled',
        budgetTokens: budgetTokens ?? getFallbackBudgetTokens(reasoningEffort)
      }
    }
  } else {
    // 其他使用claude端點的模型，比如Kimi,Minimax等等
    const { maxTokens } = getAssistantSettings(assistant)
    const budgetTokens = getThinkingBudget(maxTokens, reasoningEffort, model.id)
    const params: Partial<ReturnType<typeof getAnthropicReasoningParams>> = {
      thinking: {
        type: 'enabled',
        budgetTokens: budgetTokens ?? getFallbackBudgetTokens(reasoningEffort)
      },
      sendReasoning: true
    }
    // https://api-docs.deepseek.com/guides/thinking_mode
    // DeepSeek V4+ exposes only 'high' and 'xhigh' as user-facing effort levels
    // (see MODEL_SUPPORTED_REASONING_EFFORT.deepseek_v4); default/none are already
    // short-circuited earlier in this function. The explicit map avoids silently
    // downgrading future levels (low/medium/auto) to 'high' — unmapped values are
    // simply omitted so callers fall back to API defaults instead.
    if (isDeepSeekV4PlusModel(model)) {
      const deepSeekV4EffortMap = {
        high: 'high',
        xhigh: 'max'
      } as const
      const effort = deepSeekV4EffortMap[reasoningEffort as keyof typeof deepSeekV4EffortMap]
      if (effort) {
        params.effort = effort
      }
    }
    // Always include budgetTokens to prevent Claude Agent SDK from converting
    // { type: 'enabled' } into '--thinking adaptive', which non-Anthropic
    // upstream providers do not support (they only accept 'enabled'/'disabled').
    return params
  }
}

type GoogleThinkingLevel = NonNullable<GoogleGenerativeAIProviderOptions['thinkingConfig']>['thinkingLevel']

function mapToGeminiThinkingLevel(reasoningEffort: ReasoningEffortOption): GoogleThinkingLevel {
  switch (reasoningEffort) {
    case 'auto':
    case 'default':
      return undefined
    case 'none':
      return 'minimal'
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
      return 'high'
    default:
      // Enforce all possible values are handled
      reasoningEffort satisfies never
      return undefined
  }
}

/**
 * 获取 Gemini 推理参数
 * 从 GeminiAPIClient 中提取的逻辑
 * 注意：Gemini/GCP 端点所使用的 thinkingBudget 等参数应该按照驼峰命名法传递
 * 而在 Google 官方提供的 OpenAI 兼容端点中则使用蛇形命名法 thinking_budget
 */
export function getGeminiReasoningParams(
  assistant: Assistant,
  model: Model
): Pick<GoogleGenerativeAIProviderOptions, 'thinkingConfig'> {
  if (!isReasoningModel(model)) {
    return {}
  }

  const reasoningEffort = assistant?.settings?.reasoning_effort

  if (!reasoningEffort || reasoningEffort === 'default') {
    return {}
  }

  // Capability-driven: the Gemini native lane requires a Gemini-family
  // heuristic or exact external reasoning metadata; otherwise no explicit
  // emit shape exists here (protocol filtering mirrors the resolver).
  // Within the lane, every requested level maps through the protocol's
  // thinking-level/budget shapes — absence of explicit effort metadata
  // never invalidates these controls.
  const isGeminiFamily = isSupportedThinkingTokenGeminiModel(model)
  const hasExternalReasoning = resolveExternalReasoningSupport(model) === true
  if (!isGeminiFamily && !hasExternalReasoning) {
    return {}
  }

  let thinkingLevel: GoogleThinkingLevel | null = null
  const includeThoughts = reasoningEffort !== 'none'

  if (isHostedGemma4ThinkingModel(model)) {
    // Hosted Gemma 4 does not expose a distinct hard-off mode on the Gemini API.
    // We only surface minimal/high in the UI and collapse legacy or unexpected
    // `none` inputs to `minimal` for compatibility.
    const isHighThinking = reasoningEffort === 'high' || reasoningEffort === 'xhigh'
    thinkingLevel = isHighThinking ? 'high' : 'minimal'

    return {
      thinkingConfig: {
        includeThoughts: isHighThinking,
        thinkingLevel
      }
    }
  }

  // https://ai.google.dev/gemini-api/docs/gemini-3?thinking=high#new_api_features_in_gemini_3
  if (isGemini3ThinkingTokenModel(model)) {
    thinkingLevel = mapToGeminiThinkingLevel(reasoningEffort)
    if (thinkingLevel === 'minimal' && getLowerBaseModelName(model.id).includes('pro')) {
      thinkingLevel = 'low'
    }
  }

  if (thinkingLevel !== null) {
    // Gemini 3 branch. thinkingLevel can be undefined (auto) or a specific level.
    return {
      thinkingConfig: {
        includeThoughts,
        thinkingLevel
      }
    }
  } else {
    // Old models
    const effortRatio = EFFORT_RATIO[reasoningEffort]

    if (reasoningEffort === 'auto') {
      return {
        thinkingConfig: {
          includeThoughts,
          thinkingBudget: -1
        }
      }
    }

    if (reasoningEffort === 'none') {
      return {
        thinkingConfig: {
          includeThoughts,
          ...(GEMINI_FLASH_MODEL_REGEX.test(model.id) ? { thinkingBudget: 0 } : {})
        }
      }
    }

    const { min, max } = findTokenLimit(model.id) || { min: 0, max: 0 }
    const budget = Math.floor((max - min) * effortRatio + min)

    return {
      thinkingConfig: {
        includeThoughts,
        ...(budget > 0 ? { thinkingBudget: budget } : {})
      }
    }
  }
}

/**
 * 获取自定义参数
 * 从 assistant 设置中提取自定义参数
 */
export function getCustomParameters(assistant: Assistant): Record<string, any> {
  return (
    assistant?.settings?.customParameters?.reduce((acc, param) => {
      if (!param.name?.trim()) {
        return acc
      }
      // Parse JSON type parameters
      // Related: src/renderer/src/pages/settings/AssistantSettings/AssistantModelSettings.tsx:133-148
      // The UI stores JSON type params as strings (e.g., '{"key":"value"}')
      // This function parses them into objects before sending to the API
      if (param.type === 'json') {
        const value = param.value as string
        if (value === 'undefined') {
          return { ...acc, [param.name]: undefined }
        }
        try {
          return { ...acc, [param.name]: JSON.parse(value) }
        } catch {
          return { ...acc, [param.name]: value }
        }
      }
      return {
        ...acc,
        [param.name]: param.value
      }
    }, {}) || {}
  )
}

/**
 * Get reasoning tag name based on model ID
 * Used for extractReasoningMiddleware configuration
 */
export function getReasoningTagName(modelId: string | undefined): string {
  const tagName = {
    reasoning: 'reasoning',
    think: 'think',
    thought: 'thought',
    seedThink: 'seed:think'
  }

  if (modelId?.includes('gpt-oss')) return tagName.reasoning
  if (modelId?.includes('gemini')) return tagName.thought
  if (modelId?.includes('seed-oss-36b')) return tagName.seedThink
  return tagName.think
}
