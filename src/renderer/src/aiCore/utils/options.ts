import { type AnthropicProviderOptions } from '@ai-sdk/anthropic'
import type { GoogleGenerativeAIProviderOptions } from '@ai-sdk/google'
import type { OpenAIResponsesProviderOptions } from '@ai-sdk/openai'
import { loggerService } from '@logger'
import {
  getModelSupportedVerbosity,
  isOpenAIModel,
  isQwenMTModel,
  isReasoningModel,
  isSupportFlexServiceTierModel,
  isSupportVerbosityModel
} from '@renderer/config/models'
import { mapLanguageToQwenMTModel } from '@renderer/config/translate'
import { getStoreSetting } from '@renderer/hooks/useSettings'
import { getProviderById } from '@renderer/services/ProviderService'
import {
  type Assistant,
  isOpenAIServiceTier,
  isTranslateAssistant,
  type Model,
  type OpenAIServiceTier,
  OpenAIServiceTiers,
  type Provider,
  type ServiceTier
} from '@renderer/types'
import { type AiSdkParam, isAiSdkParam, type OpenAIVerbosity } from '@renderer/types/aiCoreTypes'
import { isSupportServiceTierProvider, isSupportVerbosityProvider } from '@renderer/utils/provider'
import type { JSONValue } from 'ai'
import { t } from 'i18next'
import { merge } from 'lodash'

import { getAiSdkProviderId } from '../provider/factory'
import type { ProviderCapabilities } from '../types'
import { buildGeminiGenerateImageParams } from './image'
import {
  getAnthropicReasoningParams,
  getCustomParameters,
  getGeminiReasoningParams,
  getOpenAIReasoningParams,
  getReasoningEffort
} from './reasoning'
import { getWebSearchParams } from './websearch'

const logger = loggerService.withContext('aiCore.utils.options')

function toOpenAIServiceTier(model: Model, serviceTier: ServiceTier): OpenAIServiceTier {
  if (
    !isOpenAIServiceTier(serviceTier) ||
    (serviceTier === OpenAIServiceTiers.flex && !isSupportFlexServiceTierModel(model))
  ) {
    return undefined
  } else {
    return serviceTier
  }
}

// OpenAI-compatible service tier uses one generic/OpenAI shape only, gated by
// the explicit per-connection `apiOptions.isSupportServiceTier` option. No
// provider brand distinction (Groq vs others) participates.
function getServiceTier(model: Model, provider: Provider): OpenAIServiceTier {
  const serviceTierSetting = provider.serviceTier

  if (!isSupportServiceTierProvider(provider) || !isOpenAIModel(model) || !serviceTierSetting) {
    return undefined
  }

  return toOpenAIServiceTier(model, serviceTierSetting)
}

function getVerbosity(model: Model): OpenAIVerbosity {
  const provider = getProviderById(model.provider)
  if (!provider || !isSupportVerbosityModel(model) || !isSupportVerbosityProvider(provider)) {
    return undefined
  }
  const openAI = getStoreSetting('openAI')

  const userVerbosity = openAI.verbosity

  if (userVerbosity) {
    const supportedVerbosity = getModelSupportedVerbosity(model)
    // Use user's verbosity if supported, otherwise use the first supported option
    const verbosity = supportedVerbosity.includes(userVerbosity) ? userVerbosity : supportedVerbosity[0]
    return verbosity
  }
  return undefined
}

/**
 * Extract AI SDK standard parameters from custom parameters
 * These parameters should be passed directly to streamText() instead of providerOptions
 */
export function extractAiSdkStandardParams(customParams: Record<string, any>): {
  standardParams: Partial<Record<AiSdkParam, any>>
  providerParams: Record<string, any>
} {
  const standardParams: Partial<Record<AiSdkParam, any>> = {}
  const providerParams: Record<string, any> = {}

  for (const [key, value] of Object.entries(customParams)) {
    if (isAiSdkParam(key)) {
      standardParams[key] = value
    } else {
      providerParams[key] = value
    }
  }

  return { standardParams, providerParams }
}

/**
 * 构建 AI SDK 的 providerOptions
 * 按 provider 类型分离，保持类型安全
 * 返回格式：{
 *   providerOptions: { 'providerId': providerOptions },
 *   standardParams: { topK, frequencyPenalty, presencePenalty, stopSequences, seed }
 * }
 *
 * Custom parameters are split into two categories:
 * 1. AI SDK standard parameters (topK, frequencyPenalty, etc.) - returned separately to be passed to streamText()
 * 2. Provider-specific parameters - merged into providerOptions
 */
export function buildProviderOptions(
  assistant: Assistant,
  model: Model,
  actualProvider: Provider,
  capabilities: Pick<ProviderCapabilities, 'enableReasoning' | 'enableWebSearch' | 'enableGenerateImage'>
): {
  providerOptions: Record<string, Record<string, JSONValue>>
  standardParams: Partial<Record<AiSdkParam, any>>
} {
  const rawProviderId = getAiSdkProviderId(actualProvider)
  logger.debug('buildProviderOptions', { assistant, model, actualProvider, capabilities, rawProviderId })
  // 构建 provider 特定的选项
  let providerSpecificOptions: Record<string, any> = {}
  const serviceTier = getServiceTier(model, actualProvider)
  const textVerbosity = getVerbosity(model)

  // Build options by AI SDK provider ID. Only approved-protocol buckets are
  // reachable: the factory resolves every other protocol/type (including all
  // retired brand adapters and unknown types) to generic OpenAI-compatible,
  // so no retired brand branch exists here.
  switch (rawProviderId) {
    case 'openai':
    case 'openai-chat':
      providerSpecificOptions = buildOpenAIProviderOptions(assistant, model, capabilities, serviceTier, textVerbosity)
      break
    case 'anthropic':
      providerSpecificOptions = buildAnthropicProviderOptions(assistant, model, capabilities)
      break
    case 'google':
      providerSpecificOptions = buildGeminiProviderOptions(assistant, model, capabilities)
      break
    case 'openai-compatible':
    default:
      // 对于其他 provider，使用通用的构建逻辑
      providerSpecificOptions = buildGenericProviderOptions(rawProviderId, assistant, model, capabilities)
      // Merge serviceTier and textVerbosity
      providerSpecificOptions = {
        ...providerSpecificOptions,
        [rawProviderId]: {
          ...providerSpecificOptions[rawProviderId],
          serviceTier,
          textVerbosity
        }
      }
      break
  }
  logger.debug('Built providerSpecificOptions', { providerSpecificOptions })
  /**
   * Retrieve custom parameters and separate standard parameters from provider-specific parameters.
   */
  const customParams = getCustomParameters(assistant)
  const { standardParams, providerParams } = extractAiSdkStandardParams(customParams)
  logger.debug('Extracted standardParams and providerParams', { standardParams, providerParams })

  /**
   * Get the actual AI SDK provider ID(s) from the already-built providerSpecificOptions.
   * For proxy providers (aihubmix, newapi), this will be the actual SDK provider (e.g., 'google', 'openai', 'anthropic')
   * For regular providers, this will be the provider itself
   */
  const actualAiSdkProviderIds = Object.keys(providerSpecificOptions)
  const primaryAiSdkProviderId = actualAiSdkProviderIds[0] // Use the first one as primary for non-scoped params

  // For openai-compatible providers, auto-convert reasoning_effort (snake_case) to reasoningEffort (camelCase).
  // The AI SDK's openai-compatible provider overwrites reasoning_effort to undefined,
  // but accepts reasoningEffort. See: https://github.com/CherryHQ/cherry-studio/issues/11987
  if (primaryAiSdkProviderId === 'openai-compatible' && 'reasoning_effort' in providerParams) {
    if (!('reasoningEffort' in providerParams)) {
      providerParams.reasoningEffort = providerParams.reasoning_effort
    }
    delete providerParams.reasoning_effort
  }

  /**
   * Merge custom parameters into providerSpecificOptions.
   * Simple logic:
   * 1. If key is in actualAiSdkProviderIds → merge directly (user knows the actual AI SDK provider ID)
   * 2. Otherwise → nest under the primary provider bucket. Brand/routing keys
   *    (e.g. `gateway`) never become top-level buckets.
   *
   * Example:
   * - User writes `google: { opt: 'val' }` → stays as `google: { opt: 'val' }` (case 1)
   * - User writes `gateway: { order: [...] }` → nested as `openai-compatible: { gateway: ... }` (case 2)
   * - User writes `customKey: 'val'` → merged to `google: { customKey: 'val' }` (case 2)
   */
  for (const key of Object.keys(providerParams)) {
    if (actualAiSdkProviderIds.includes(key)) {
      // Case 1: Key is an actual AI SDK provider ID - merge directly
      providerSpecificOptions = {
        ...providerSpecificOptions,
        [key]: {
          ...providerSpecificOptions[key],
          ...providerParams[key]
        }
      }
    } else {
      // Case 2: Regular parameter - nest under the primary provider bucket
      providerSpecificOptions = {
        ...providerSpecificOptions,
        [primaryAiSdkProviderId]: {
          ...providerSpecificOptions[primaryAiSdkProviderId],
          [key]: providerParams[key]
        }
      }
    }
  }
  logger.debug('Final providerSpecificOptions after merging providerParams', { providerSpecificOptions })

  // 返回 AI Core SDK 要求的格式：{ 'providerId': providerOptions } 以及提取的标准参数
  return {
    providerOptions: providerSpecificOptions,
    standardParams
  }
}

/**
 * 构建 OpenAI 特定的 providerOptions
 */
function buildOpenAIProviderOptions(
  assistant: Assistant,
  model: Model,
  capabilities: Pick<ProviderCapabilities, 'enableReasoning' | 'enableWebSearch' | 'enableGenerateImage'>,
  serviceTier: OpenAIServiceTier,
  textVerbosity?: OpenAIVerbosity
): Record<string, OpenAIResponsesProviderOptions> {
  const { enableReasoning } = capabilities
  let providerOptions: OpenAIResponsesProviderOptions = {}
  // OpenAI 推理参数
  if (enableReasoning) {
    const reasoningParams = getOpenAIReasoningParams(assistant, model)
    providerOptions = {
      ...providerOptions,
      ...reasoningParams,
      // TODO: Remove this workaround after migrating to @ai-sdk/open-responses (#13462)
      // Bypass @ai-sdk/openai's model ID allowlist for reasoning detection.
      // Third-party providers often use non-canonical model IDs (e.g., "openai/gpt-5.2")
      // that fail the SDK's startsWith() checks, causing reasoning params to be silently dropped.
      ...(isReasoningModel(model) && { forceReasoning: true })
    }
  }
  const provider = getProviderById(model.provider)

  if (provider && isSupportVerbosityModel(model) && isSupportVerbosityProvider(provider)) {
    const openAI = getStoreSetting<'openAI'>('openAI')
    const userVerbosity = openAI?.verbosity

    if (userVerbosity && ['low', 'medium', 'high'].includes(userVerbosity)) {
      const supportedVerbosity = getModelSupportedVerbosity(model)
      // Use user's verbosity if supported, otherwise use the first supported option
      const verbosity = supportedVerbosity.includes(userVerbosity) ? userVerbosity : supportedVerbosity[0]

      providerOptions = {
        ...providerOptions,
        textVerbosity: verbosity
      }
    }
  }

  // TODO: 支持配置是否在服务端持久化
  providerOptions = {
    ...providerOptions,
    serviceTier,
    textVerbosity,
    store: false
  }

  return {
    openai: providerOptions
  }
}

/**
 * 构建 Anthropic 特定的 providerOptions
 */
function buildAnthropicProviderOptions(
  assistant: Assistant,
  model: Model,
  capabilities: Pick<ProviderCapabilities, 'enableReasoning' | 'enableWebSearch' | 'enableGenerateImage'>
): Record<string, AnthropicProviderOptions> {
  const { enableReasoning } = capabilities
  let providerOptions: AnthropicProviderOptions = {}

  // Anthropic 推理参数
  if (enableReasoning) {
    const reasoningParams = getAnthropicReasoningParams(assistant, model)
    providerOptions = {
      ...providerOptions,
      ...reasoningParams
    }
  }

  return {
    anthropic: {
      ...providerOptions
    }
  }
}

/**
 * 构建 Gemini 特定的 providerOptions
 */
function buildGeminiProviderOptions(
  assistant: Assistant,
  model: Model,
  capabilities: Pick<ProviderCapabilities, 'enableReasoning' | 'enableWebSearch' | 'enableGenerateImage'>
): Record<string, GoogleGenerativeAIProviderOptions> {
  const { enableReasoning, enableGenerateImage } = capabilities
  let providerOptions: GoogleGenerativeAIProviderOptions = {
    safetySettings: [
      {
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_CIVIC_INTEGRITY',
        threshold: 'BLOCK_NONE'
      }
    ]
  }

  // Gemini 推理参数
  if (enableReasoning) {
    const reasoningParams = getGeminiReasoningParams(assistant, model)
    providerOptions = {
      ...providerOptions,
      ...reasoningParams
    }
  }

  if (enableGenerateImage) {
    providerOptions = {
      ...providerOptions,
      ...buildGeminiGenerateImageParams()
    }
  }

  return {
    google: {
      ...providerOptions
    }
  }
}

/**
 * 构建通用的 providerOptions（用于其他 provider）
 */
function buildGenericProviderOptions(
  providerId: string,
  assistant: Assistant,
  model: Model,
  capabilities: Pick<ProviderCapabilities, 'enableReasoning' | 'enableWebSearch' | 'enableGenerateImage'>
): Record<string, any> {
  const { enableWebSearch } = capabilities
  let providerOptions: Record<string, any> = {}

  const reasoningParams = getReasoningEffort(assistant, model)
  logger.debug('reasoningParams', reasoningParams)
  providerOptions = {
    ...providerOptions,
    ...reasoningParams
  }

  if (enableWebSearch) {
    const webSearchParams = getWebSearchParams(model)
    providerOptions = merge({}, providerOptions, webSearchParams)
  }

  // 特殊处理 Qwen MT
  if (isQwenMTModel(model)) {
    if (isTranslateAssistant(assistant)) {
      const targetLanguage = assistant.targetLanguage
      const translationOptions = {
        source_lang: 'auto',
        target_lang: mapLanguageToQwenMTModel(targetLanguage)
      } as const
      if (!translationOptions.target_lang) {
        throw new Error(t('translate.error.not_supported', { language: targetLanguage.value }))
      }
      providerOptions.translation_options = translationOptions
    } else {
      throw new Error(t('translate.error.chat_qwen_mt'))
    }
  }

  return {
    [providerId]: providerOptions
  }
}
