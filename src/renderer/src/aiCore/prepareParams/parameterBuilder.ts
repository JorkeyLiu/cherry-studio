/**
 * 参数构建模块
 * 构建AI SDK的流式和非流式参数
 */

import { combineHeaders } from '@ai-sdk/provider-utils'
import { loggerService } from '@logger'
import { MAX_TOOL_CALLS, MIN_TOOL_CALLS } from '@renderer/config/constant'
import { isFixedReasoningModel } from '@renderer/config/models/reasoning'
import { isAnthropicModel, isGeminiModel } from '@renderer/config/models/utils'
import { isGenerateImageModel, isPureGenerateImageModel } from '@renderer/config/models/vision'
import { DEFAULT_ASSISTANT_SETTINGS } from '@renderer/services/assistantDefaults'
import store from '@renderer/store'
import type { Assistant, Provider } from '@renderer/types'
import type { StreamTextParams } from '@renderer/types/aiCoreTypes'
import { IdleTimeoutController, type IdleTimeoutHandle } from '@renderer/utils/IdleTimeoutController'
import { replacePromptVariables } from '@renderer/utils/prompt'
import { isSupportUrlContextProvider } from '@renderer/utils/provider'
import { DEFAULT_TIMEOUT } from '@shared/config/constant'
import type { ModelMessage } from 'ai'
import { stepCountIs } from 'ai'

import type { ProviderCapabilities } from '../types'
import { buildProviderOptions } from '../utils/options'
import { addAnthropicHeaders } from './header'
import { filterStandardParams, getMaxTokens, getTemperature, getTopP } from './modelParameters'

const logger = loggerService.withContext('parameterBuilder')

/**
 * Validates and clamps maxToolCalls to valid range
 * Falls back to DEFAULT_ASSISTANT_SETTINGS.maxToolCalls if invalid
 * @param value - The maxToolCalls value from settings
 * @returns Validated maxToolCalls value
 */
function validateMaxToolCalls(value: number | undefined): number {
  if (value === undefined || value < MIN_TOOL_CALLS || value > MAX_TOOL_CALLS) {
    return DEFAULT_ASSISTANT_SETTINGS.maxToolCalls
  }
  return value
}

export function getEffectiveMaxToolCalls(settings?: { maxToolCalls?: number; enableMaxToolCalls?: boolean }): number {
  const enableMaxToolCalls = settings?.enableMaxToolCalls ?? DEFAULT_ASSISTANT_SETTINGS.enableMaxToolCalls

  if (!enableMaxToolCalls) {
    return DEFAULT_ASSISTANT_SETTINGS.maxToolCalls
  }

  return validateMaxToolCalls(settings?.maxToolCalls)
}

/**
 * 构建 AI SDK 流式参数
 * 这是主要的参数构建函数，整合所有转换逻辑
 */
export async function buildStreamTextParams(
  sdkMessages: StreamTextParams['messages'] = [],
  assistant: Assistant,
  provider: Provider,
  options: {
    allowedTools?: string[]
    requestOptions?: {
      signal?: AbortSignal
      timeout?: number
      headers?: Record<string, string | undefined>
    }
  } = {}
): Promise<{
  params: StreamTextParams
  modelId: string
  capabilities: ProviderCapabilities
  idleTimeout: IdleTimeoutHandle
}> {
  const { requestOptions = {} } = options
  // No caller currently provides a custom timeout; defaultTimeout (10 min) is the fallback.
  const { signal: externalSignal, timeout = DEFAULT_TIMEOUT, headers: inputHeaders = {} } = requestOptions

  // Use an idle timeout that resets every time a stream chunk is received,
  // instead of a fixed total timeout that starts from the initial request.
  const idleTimeout = new IdleTimeoutController(timeout)
  const signals = [idleTimeout.signal]
  if (externalSignal) {
    signals.push(externalSignal)
  }
  const finalSignal = AbortSignal.any(signals)

  const model = assistant.model || store.getState().llm.defaultModel
  if (!model) {
    // Unconfigured model slot: fail explicitly before any provider/API
    // invocation.
    throw new Error('No model configured')
  }
  // Unit B: user-intent lazy execution. Reasoning is enabled whenever the user
  // has an explicit setting (`default` still means no override; lanes emit {}
  // for it). Fixed-reasoning protocol facts still enable the path. No model
  // name/metadata veto.
  const enableReasoning = assistant.settings?.reasoning_effort !== undefined || isFixedReasoningModel(model)

  // Validate provider and model support to prevent stale state from triggering urlContext
  const enableUrlContext = !!(
    assistant.enableUrlContext &&
    isSupportUrlContextProvider(provider) &&
    !isPureGenerateImageModel(model) &&
    (isGeminiModel(model) || isAnthropicModel(model))
  )

  const enableGenerateImage = !!(isGenerateImageModel(model) && assistant.enableGenerateImage)

  const { providerOptions, standardParams } = buildProviderOptions(assistant, model, provider, {
    enableReasoning,
    enableGenerateImage
  })

  // URL context 的工具注入由 plugin 系统处理：
  // - urlContextPlugin: 根据 provider 的 toolFactories.urlContext 自动注入
  // parameterBuilder 只构建 config，传给 plugin

  let headers = inputHeaders

  // Connection session identity (`x-opencode-session`) is owned exclusively
  // by the AiProvider request boundary (see resolveOutboundRequestHeaders):
  // this builder never injects it and only forwards explicit caller headers
  // plus dialect headers below.

  if (isAnthropicModel(model)) {
    const betaHeaders = addAnthropicHeaders(assistant, model)
    // Only add the anthropic-beta header if there are actual beta headers to include
    if (betaHeaders.length > 0) {
      const newBetaHeaders = { 'anthropic-beta': betaHeaders.join(',') }
      headers = combineHeaders(headers, newBetaHeaders)
    }
  }

  // 构建基础参数
  // Note: standardParams (topK, frequencyPenalty, presencePenalty, stopSequences, seed)
  // are extracted from custom parameters and passed directly to streamText()
  // instead of being placed in providerOptions

  // AI SDK defaults to stepCountIs(1), which would stop after the first tool call.
  // Always pass an explicit cap so native tool use can continue across steps.
  const maxToolCalls = getEffectiveMaxToolCalls(assistant.settings)

  const params: StreamTextParams = {
    messages: sdkMessages,
    maxOutputTokens: getMaxTokens(assistant, model),
    temperature: getTemperature(assistant, model),
    topP: getTopP(assistant, model),
    // Include AI SDK standard params extracted from custom parameters
    // (filtered to drop ones the model rejects, e.g. topK on Claude Opus 4.7+)
    ...filterStandardParams(standardParams, model),
    abortSignal: finalSignal,
    headers,
    providerOptions,
    maxRetries: 0
  }

  params.stopWhen = stepCountIs(maxToolCalls)

  const systemPrompt = assistant.prompt ? await replacePromptVariables(assistant.prompt, model.name) : ''

  if (systemPrompt) {
    params.system = systemPrompt
  }

  logger.debug('params', params)

  return {
    params,
    modelId: model.id,
    capabilities: { enableReasoning, enableGenerateImage, enableUrlContext },
    idleTimeout
  }
}

/**
 * 构建非流式的 generateText 参数
 */
export async function buildGenerateTextParams(
  messages: ModelMessage[],
  assistant: Assistant,
  provider: Provider,
  options: {
    allowedTools?: string[]
    enableTools?: boolean
  } = {}
): Promise<any> {
  // 复用流式参数的构建逻辑
  return await buildStreamTextParams(messages, assistant, provider, options)
}
