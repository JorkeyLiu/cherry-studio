import type { AnthropicProviderOptions } from '@ai-sdk/anthropic'
import type { GoogleGenerativeAIProviderOptions } from '@ai-sdk/google'
import type { OpenAIResponsesProviderOptions } from '@ai-sdk/openai'
import type OpenAI from '@cherrystudio/openai'
import {
  findTokenLimit,
  GEMINI_FLASH_MODEL_REGEX,
  isGemini3ThinkingTokenModel,
  isHostedGemma4ThinkingModel,
  isOpenAIDeepResearchModel,
  isOpenAIModel,
  isSupportedReasoningEffortOpenAIModel
} from '@renderer/config/models'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Assistant, Model, ReasoningEffortOption } from '@renderer/types'
import { EFFORT_RATIO } from '@renderer/types'
import type { OpenAIReasoningEffort, OpenAIReasoningSummary } from '@renderer/types/aiCoreTypes'
import { getLowerBaseModelName } from '@renderer/utils'

function reasoningNotEncodable(model: Model, reasoningEffort: string, detail: string): Error {
  return new Error(`Reasoning effort "${reasoningEffort}" cannot be encoded for model "${model.id}": ${detail}`)
}

type ReasoningEffortOptionalParams = {
  thinking?: { type: 'disabled' | 'enabled' | 'auto'; budget_tokens?: number }
  reasoning?: { max_tokens?: number; exclude?: boolean; effort?: string; enabled?: boolean } | OpenAI.Reasoning
  // Generic OpenAI-compatible emits only this camelCase key (AI SDK
  // openai-compatible accepts `reasoningEffort` and overwrites snake_case
  // `reasoning_effort` to undefined). Persisted/user `reasoning_effort`
  // settings and custom-parameter conversion stay snake_case; see options.ts.
  reasoningEffort?: OpenAIReasoningEffort
  // Vendor toggle for the enable-thinking dialect (SiliconFlow / DashScope
  // compatible-mode). Emitted only via apiHost dialect matching, never via
  // model-name heuristics. Default dialect never emits this key.
  enable_thinking?: boolean
  // Add any other potential reasoning-related keys here if they exist
}

// ---------------------------------------------------------------------------
// OpenAI-compatible API dialect — single explicit shape per dialect, model-
// name orthogonal. Two dialects currently:
//   - 'default'        : { reasoningEffort } (xhigh -> max, lazy server support)
//   - 'enable_thinking': { enable_thinking, reasoningEffort } for SiliconFlow /
//                        DashScope compatible-mode hosts.
// Host matching is exact hostname or subdomain (siliconflow.cn,
// dashscope.aliyuncs.com), extracted via URL hostname only — query/path
// substring or suffix-spoof never triggers. Invalid / empty apiHost falls
// back to 'default'. No model-name routing; no mixing of thinking object.
// ---------------------------------------------------------------------------
export type OpenAICompatibleDialect = 'default' | 'enable_thinking'

function getApiHostname(apiHost?: string): string | null {
  if (!apiHost) return null
  const trimmed = apiHost.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    const host = url.hostname.trim().toLowerCase()
    return host || null
  } catch {
    return null
  }
}

function isSiliconFlowDialectHost(provider: { apiHost?: string }): boolean {
  const hostname = getApiHostname(provider.apiHost)
  if (!hostname) return false
  return hostname === 'siliconflow.cn' || hostname.endsWith('.siliconflow.cn')
}

function isDashScopeDialectHost(provider: { apiHost?: string }): boolean {
  const hostname = getApiHostname(provider.apiHost)
  if (!hostname) return false
  return hostname === 'dashscope.aliyuncs.com' || hostname.endsWith('.dashscope.aliyuncs.com')
}

export function resolveOpenAICompatibleDialect(provider: { apiHost?: string }): OpenAICompatibleDialect {
  if (isSiliconFlowDialectHost(provider) || isDashScopeDialectHost(provider)) {
    return 'enable_thinking'
  }
  return 'default'
}

function mapEffortForWire(effort: string): OpenAIReasoningEffort {
  // Protocol-required max mapping: UI xhigh -> wire 'max'
  if (effort === 'xhigh') return 'max' as OpenAIReasoningEffort
  return effort as OpenAIReasoningEffort
}

export function encodeReasoningEffortForDialect(
  dialect: OpenAICompatibleDialect,
  effort: string
): ReasoningEffortOptionalParams {
  if (!effort || effort === 'default') return {}
  if (effort === 'none') {
    if (dialect === 'enable_thinking') return { enable_thinking: false }
    return { reasoningEffort: 'none' }
  }
  const mapped = mapEffortForWire(effort)
  if (dialect === 'enable_thinking') {
    return { enable_thinking: true, reasoningEffort: mapped }
  }
  return { reasoningEffort: mapped }
}

// The function is only for the generic OpenAI-compatible lane. It
// now encodes via the API dialect (hostname → single shape), model-name
// orthogonal. No per-family or per-model branching, no mixing of multiple
// close shapes. Server support is lazy: the wire shape is always emitted,
// upstream decides. `default` means no override. Anthropic/Gemini/OpenAI
// official lanes have their own independent builders and are untouched.
export function getReasoningEffort(assistant: Assistant, model: Model): ReasoningEffortOptionalParams {
  const provider = getProviderByModel(model)
  if (!provider) {
    throw new Error('Model provider is not configured')
  }
  const reasoningEffort = assistant?.settings?.reasoning_effort
  if (!reasoningEffort || reasoningEffort === 'default') {
    return {}
  }
  const dialect = resolveOpenAICompatibleDialect(provider)
  return encodeReasoningEffortForDialect(dialect, reasoningEffort)
}

/**
 * Get OpenAI reasoning parameters
 * Extracted from OpenAIResponseAPIClient and OpenAIAPIClient logic
 * For official OpenAI provider only
 *
 * Unit B: no model-capability veto. `default` means no override; any concrete
 * user level is forwarded so the adapter/upstream decides (never silently
 * dropped because a model name is unknown).
 */
export function getOpenAIReasoningParams(
  assistant: Assistant,
  model: Model
): Pick<OpenAIResponsesProviderOptions, 'reasoningEffort' | 'reasoningSummary'> {
  let reasoningEffort = assistant?.settings?.reasoning_effort

  if (!reasoningEffort || reasoningEffort === 'default') {
    return {}
  }

  // Deep-research lane exposes only `medium`. Any other explicit level
  // (including `auto` toggle-on) cannot be encoded here and throws instead
  // of silently replacing the user's choice with `medium`.
  if (isOpenAIDeepResearchModel(model)) {
    if (reasoningEffort !== 'medium') {
      throw reasoningNotEncodable(model, reasoningEffort, 'the OpenAI deep-research lane only encodes "medium"')
    }
    reasoningEffort = 'medium'
  } else if (reasoningEffort === 'auto') {
    throw reasoningNotEncodable(model, reasoningEffort, 'the OpenAI lane has no auto effort level')
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

  // OpenAI 推理参数（协议可编码即发送；未知模型名不 veto 用户选择）
  if (isSupportedReasoningEffortOpenAIModel(model)) {
    return {
      reasoningEffort,
      reasoningSummary
    }
  }

  // Unit B fallback: forward the explicit user level on the OpenAI lane so
  // upstream decides (existing APICallError chain surfaces rejection).
  return {
    reasoningEffort
  }
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
// Exported for the generic thinking-format plugin, which reuses the same
// candidate when converting an adaptive request back to enabled.
export function getFallbackBudgetTokens(reasoningEffort: string | undefined): number {
  const effortRatio = EFFORT_RATIO[reasoningEffort ?? 'high'] ?? EFFORT_RATIO.high
  return computeBudgetTokens(FALLBACK_TOKEN_LIMIT, effortRatio)
}

/**
 * Get Anthropic reasoning parameters.
 *
 * Identity-independent: the Anthropic protocol shape depends ONLY on the
 * user's reasoning_effort, never on a model name/brand/family/version.
 * The new default is adaptive thinking; the legacy enabled+budget shape is
 * only produced by the format-negotiation fallback after a precise
 * adaptive rejection (see anthropicThinkingFormatPlugin).
 *
 * - default/undefined -> {} (no override)
 * - none -> { thinking: { type: 'disabled' } }
 * - low/medium/high/xhigh -> { thinking: { type: 'adaptive' }, effort: <native> }
 * - auto -> { thinking: { type: 'adaptive' } } (no effort)
 * - minimal has no Anthropic value: throw explicitly rather than guessing low.
 */
export function getAnthropicReasoningParams(assistant: Assistant): {
  thinking?: AnthropicProviderOptions['thinking']
  effort?: AnthropicProviderOptions['effort']
} {
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

  if (reasoningEffort === 'minimal') {
    throw new Error(
      `Reasoning effort "minimal" cannot be encoded for Anthropic: Anthropic adaptive thinking has no minimal level`
    )
  }

  if (reasoningEffort === 'auto') {
    return { thinking: { type: 'adaptive' } }
  }

  if (
    reasoningEffort === 'low' ||
    reasoningEffort === 'medium' ||
    reasoningEffort === 'high' ||
    reasoningEffort === 'xhigh'
  ) {
    return { thinking: { type: 'adaptive' }, effort: reasoningEffort }
  }

  return {}
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
 *
 * Unit B: no model-capability veto. `default` means no override; concrete user
 * levels are encoded with the lane's protocol shapes (unknown model names are
 * never a reason to drop them).
 */
export function getGeminiReasoningParams(
  assistant: Assistant,
  model: Model
): Pick<GoogleGenerativeAIProviderOptions, 'thinkingConfig'> {
  const reasoningEffort = assistant?.settings?.reasoning_effort

  if (!reasoningEffort || reasoningEffort === 'default') {
    return {}
  }

  // Unit B: the Gemini native lane speaks thinkingConfig; an explicit user
  // level is encoded with the protocol shapes below (Gemini 3 level path when
  // applicable, otherwise the budget path). Model-name mismatch never drops it.
  let thinkingLevel: GoogleThinkingLevel | null = null
  const includeThoughts = reasoningEffort !== 'none'

  if (isHostedGemma4ThinkingModel(model)) {
    // Hosted Gemma 4 only encodes `minimal`/`high` (`xhigh` maps to `high`
    // as the protocol-required max representation). Any other explicit level
    // cannot be encoded here and throws instead of collapsing.
    if (reasoningEffort === 'high' || reasoningEffort === 'xhigh') {
      return {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'high'
        }
      }
    }
    if (reasoningEffort === 'minimal') {
      return {
        thinkingConfig: {
          includeThoughts: false,
          thinkingLevel: 'minimal'
        }
      }
    }
    throw reasoningNotEncodable(model, reasoningEffort, 'the hosted Gemma 4 lane only encodes "minimal"/"high"')
  }

  // https://ai.google.dev/gemini-api/docs/gemini-3?thinking=high#new_api_features_in_gemini_3
  if (isGemini3ThinkingTokenModel(model)) {
    thinkingLevel = mapToGeminiThinkingLevel(reasoningEffort)
    // Gemini 3 Pro has no `minimal` level: throw instead of silently
    // replacing it with `low`. `xhigh` -> `high` above is the retained
    // protocol-required max mapping.
    if (thinkingLevel === 'minimal' && getLowerBaseModelName(model.id).includes('pro')) {
      throw reasoningNotEncodable(model, reasoningEffort, 'Gemini 3 Pro has no minimal thinking level')
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
