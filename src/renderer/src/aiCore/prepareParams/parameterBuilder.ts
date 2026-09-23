/**
 * 参数构建模块
 * 构建AI SDK的流式和非流式参数
 */

import { combineHeaders } from '@ai-sdk/provider-utils'
import type { WebSearchPluginConfig } from '@cherrystudio/ai-core/built-in/plugins'
import { extensionRegistry } from '@cherrystudio/ai-core/provider'
import { loggerService } from '@logger'
import { MAX_TOOL_CALLS, MIN_TOOL_CALLS } from '@renderer/config/constant'
import { isFixedReasoningModel } from '@renderer/config/models/reasoning'
import { isAnthropicModel, isGeminiModel } from '@renderer/config/models/utils'
import { isGenerateImageModel, isPureGenerateImageModel } from '@renderer/config/models/vision'
import { getHubModeSystemPrompt } from '@renderer/config/prompts-code-mode'
import { DEFAULT_ASSISTANT_SETTINGS } from '@renderer/services/assistantDefaults'
import store from '@renderer/store'
import type { CherryWebSearchConfig } from '@renderer/store/websearch'
import { type Assistant, getEffectiveMcpMode, type MCPTool, type Provider } from '@renderer/types'
import type { StreamTextParams } from '@renderer/types/aiCoreTypes'
import { IdleTimeoutController, type IdleTimeoutHandle } from '@renderer/utils/IdleTimeoutController'
import { replacePromptVariables } from '@renderer/utils/prompt'
import { isSupportUrlContextProvider } from '@renderer/utils/provider'
import { DEFAULT_TIMEOUT } from '@shared/config/constant'
import type { ModelMessage } from 'ai'
import { stepCountIs } from 'ai'

import { getAiSdkProviderId } from '../provider/factory'
import type { ProviderCapabilities } from '../types'
import { setupToolsConfig } from '../utils/mcp'
import { buildProviderOptions } from '../utils/options'
import { buildProviderBuiltinWebSearchConfig } from '../utils/websearch'
import { webSearchEndpointError } from './attachmentErrors'
import {
  addAnthropicHeaders,
  buildOpencodeSessionHeader,
  hasHeader,
  isOpenCodeGoEndpoint,
  OPENCODE_SESSION_HEADER
} from './header'
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
    mcpTools?: MCPTool[]
    allowedTools?: string[]
    webSearchProviderId?: string
    webSearchConfig?: CherryWebSearchConfig
    // Stable per-conversation identity (topicId). The generic request layer
    // emits `x-opencode-session` only when the request actually targets the
    // official OpenCode Go endpoint (see isOpenCodeGoEndpoint).
    topicId?: string
    requestOptions?: {
      signal?: AbortSignal
      timeout?: number
      headers?: Record<string, string | undefined>
    }
  }
): Promise<{
  params: StreamTextParams
  modelId: string
  capabilities: ProviderCapabilities
  webSearchPluginConfig?: WebSearchPluginConfig
  idleTimeout: IdleTimeoutHandle
}> {
  const { mcpTools, requestOptions = {} } = options
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
  const aiSdkProviderId = getAiSdkProviderId(provider)

  // Unit B: user-intent lazy execution. Reasoning is enabled whenever the user
  // has an explicit setting (`default` still means no override; lanes emit {}
  // for it). Fixed-reasoning protocol facts still enable the path. No model
  // name/metadata veto.
  const enableReasoning = assistant.settings?.reasoning_effort !== undefined || isFixedReasoningModel(model)

  // Unit B: built-in web search is gated by the current provider's explicit
  // search adapter only (openai/openai-chat/anthropic/google toolFactories),
  // never by model names/metadata. Generic OpenAI-compatible has no search
  // adapter and never claims built-in search (no fabricated fields). External
  // RAG (webSearchProviderId) stays distinct. Ordinary-chat path only.
  const hasExternalSearch = !!options.webSearchProviderId
  const hasBuiltinSearchAdapter = ['openai', 'openai-chat', 'anthropic', 'google'].includes(aiSdkProviderId)
  const enableWebSearch = !hasExternalSearch && !!assistant.enableWebSearch && hasBuiltinSearchAdapter
  if (!hasExternalSearch && assistant.enableWebSearch && !hasBuiltinSearchAdapter) {
    throw webSearchEndpointError(aiSdkProviderId)
  }

  // Validate provider and model support to prevent stale state from triggering urlContext
  const enableUrlContext = !!(
    assistant.enableUrlContext &&
    isSupportUrlContextProvider(provider) &&
    !isPureGenerateImageModel(model) &&
    (isGeminiModel(model) || isAnthropicModel(model))
  )

  const enableGenerateImage = !!(isGenerateImageModel(model) && assistant.enableGenerateImage)

  const tools = setupToolsConfig(mcpTools, options.allowedTools)

  // 构建真正的 providerOptions
  const webSearchConfig: CherryWebSearchConfig = {
    maxResults: store.getState().websearch.maxResults,
    excludeDomains: store.getState().websearch.excludeDomains,
    searchWithTime: store.getState().websearch.searchWithTime
  }

  const { providerOptions, standardParams } = buildProviderOptions(assistant, model, provider, {
    enableReasoning,
    enableWebSearch,
    enableGenerateImage
  })

  // Web search + URL context 的工具注入由 plugin 系统处理：
  // - webSearchPlugin: 根据 provider 的 toolFactories.webSearch 自动注入
  // - urlContextPlugin: 根据 provider 的 toolFactories.urlContext 自动注入
  // parameterBuilder 只构建 config，传给 plugin
  // Built-in web search resolves through the registered AI SDK provider id.
  // Retired gateway/vertex model-id routing is gone: unknown protocols fall
  // back to generic OpenAI-compatible, which carries no built-in search.
  let webSearchPluginConfig: WebSearchPluginConfig | undefined = undefined
  if (enableWebSearch) {
    if (extensionRegistry.has(aiSdkProviderId)) {
      webSearchPluginConfig = buildProviderBuiltinWebSearchConfig(aiSdkProviderId, webSearchConfig, model)
    }
  }

  let headers = inputHeaders

  // Stable per-conversation gateway identity, OpenCode Go only
  // (`x-opencode-session`, 400 MissingSessionID when absent). Endpoint-based:
  // only requests actually targeting the official Go endpoint
  // (`https://opencode.ai/zen/go/v1/*`, see isOpenCodeGoEndpoint) carry it —
  // ordinary Zen (`/zen/v1`), DeepSeek direct, and other OpenAI-compatible
  // endpoints never do, regardless of model brand. Stability: same topicId
  // yields the identical value across retries/continuations; blank/missing
  // topicId sends nothing (translate, check, generate, and listModels must not
  // fabricate an identity). Only the topic id is used, never
  // userId/messageId/traceId. An explicit caller header of the same name (any
  // case) wins over the derived default; header merge order follows the
  // project combineHeaders style (later wins).
  const sessionHeader = buildOpencodeSessionHeader(options.topicId)
  if (sessionHeader && isOpenCodeGoEndpoint(provider.apiHost) && !hasHeader(headers, OPENCODE_SESSION_HEADER)) {
    headers = combineHeaders(sessionHeader, headers)
  }

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

  if (tools) {
    params.tools = tools
  }

  let systemPrompt = assistant.prompt ? await replacePromptVariables(assistant.prompt, model.name) : ''

  if (getEffectiveMcpMode(assistant) === 'auto') {
    const autoModePrompt = getHubModeSystemPrompt()
    if (autoModePrompt) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${autoModePrompt}` : autoModePrompt
    }
  }

  if (systemPrompt) {
    params.system = systemPrompt
  }

  logger.debug('params', params)

  return {
    params,
    modelId: model.id,
    capabilities: { enableReasoning, enableWebSearch, enableGenerateImage, enableUrlContext },
    webSearchPluginConfig,
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
    mcpTools?: MCPTool[]
    allowedTools?: string[]
    enableTools?: boolean
  } = {}
): Promise<any> {
  // 复用流式参数的构建逻辑
  return await buildStreamTextParams(messages, assistant, provider, options)
}
