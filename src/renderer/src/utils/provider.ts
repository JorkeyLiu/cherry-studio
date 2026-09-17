import type { ProviderType } from '@renderer/types'
import { isSystemProvider, type Provider, type SystemProviderId, SystemProviderIds } from '@renderer/types'

/**
 * Custom-connection product: Claude/Agent-capable connections are determined
 * only by protocol (`anthropic` type) and per-connection stored
 * `anthropicApiHost`. No built-in brand id list is consulted.
 */
export const getClaudeSupportedProviders = (providers: Provider[]) => {
  return providers.filter(isAnthropicSupportedProvider)
}

export const getAnthropicSupportedProviders = (providers: Provider[]) => {
  return providers.filter(isAnthropicSupportedProvider)
}

export const isAnthropicSupportedProvider = (provider: Provider) => {
  return provider.type === 'anthropic' || !!provider.anthropicApiHost
}

const NOT_SUPPORT_ARRAY_CONTENT_PROVIDERS = [
  'deepseek',
  'baichuan',
  'minimax',
  'xirang',
  'poe',
  'cephalon'
] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 message 的 content 为数组类型。 Only for OpenAI Chat Completions API.
 */
export const isSupportArrayContentProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportArrayContent !== true &&
    !NOT_SUPPORT_ARRAY_CONTENT_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const NOT_SUPPORT_DEVELOPER_ROLE_PROVIDERS = ['poe', 'qiniu'] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 developer 作为 message role。 Only for OpenAI API.
 */
export const isSupportDeveloperRoleProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isSupportDeveloperRole === true ||
    (isSystemProvider(provider) && !NOT_SUPPORT_DEVELOPER_ROLE_PROVIDERS.some((pid) => pid === provider.id))
  )
}

const NOT_SUPPORT_STREAM_OPTIONS_PROVIDERS = ['mistral'] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持 stream_options 参数。Only for OpenAI API.
 */
export const isSupportStreamOptionsProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportStreamOptions !== true &&
    !NOT_SUPPORT_STREAM_OPTIONS_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDER = [
  'ollama',
  'lmstudio',
  'nvidia',
  'gpustack'
] as const satisfies SystemProviderId[]

/**
 * 判断提供商是否支持使用 enable_thinking 参数来控制 Qwen3 等模型的思考。 Only for OpenAI Chat Completions API.
 */
export const isSupportEnableThinkingProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportEnableThinking !== true &&
    !NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDER.some((pid) => pid === provider.id)
  )
}

const SUPPORT_SERVICE_TIER_PROVIDERS = [SystemProviderIds.openai, SystemProviderIds.groq]

/**
 * 判断提供商是否支持 service_tier 设置
 */
export const isSupportServiceTierProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isSupportServiceTier === true ||
    (isSystemProvider(provider) && SUPPORT_SERVICE_TIER_PROVIDERS.some((pid) => pid === provider.id))
  )
}

const NOT_SUPPORT_VERBOSITY_PROVIDERS = ['groq'] as const satisfies SystemProviderId[]

/**
 * Determines whether the provider supports the verbosity option.
 * Only applies to system providers that are not in the exclusion list.
 * @param provider - The provider to check
 * @returns true if the provider supports verbosity, false otherwise
 */
export const isSupportVerbosityProvider = (provider: Provider) => {
  return (
    provider.apiOptions?.isNotSupportVerbosity !== true &&
    !NOT_SUPPORT_VERBOSITY_PROVIDERS.some((pid) => pid === provider.id)
  )
}

const SUPPORT_URL_CONTEXT_PROVIDER_TYPES = ['gemini', 'anthropic'] as const satisfies ProviderType[]

export const isSupportUrlContextProvider = (provider: Provider) => {
  return SUPPORT_URL_CONTEXT_PROVIDER_TYPES.some((type) => type === provider.type)
}

const SUPPORT_GEMINI_NATIVE_WEB_SEARCH_PROVIDERS = ['gemini'] as const satisfies SystemProviderId[]

/** 判断是否是使用 Gemini 原生搜索工具的 provider. 目前假设只有官方 API 使用原生工具 */
export const isGeminiWebSearchProvider = (provider: Provider) => {
  return SUPPORT_GEMINI_NATIVE_WEB_SEARCH_PROVIDERS.some((id) => id === provider.id)
}

// History-only legacy protocol checks (retired in slice 3). Active request
// config must not use these; they exist only so migration history and old
// tests remain importable without making retired values active.
export const isNewApiProvider = (provider: Provider) => {
  return ['new-api', 'aionly'].includes(provider.id) || (provider as unknown as { type: string }).type === 'new-api'
}

/**
 * Active OpenAI-compatible check: generic `openai` protocol only.
 * `openai-response` (Responses API) has its own branch; `anthropic`/`gemini`
 * are separate protocols.
 */
export function isOpenAICompatibleProvider(provider: Provider): boolean {
  return provider.type === 'openai'
}

export function isOpenAIProvider(provider: Provider): boolean {
  return provider.type === 'openai-response'
}

export function isAwsBedrockProvider(provider: Provider): boolean {
  return (provider as unknown as { type: string }).type === 'aws-bedrock'
}

// Re-export approved protocol helpers from shared, plus legacy history-only
// helpers (isAzure/isOllama/isVertex/isPerplexity) for migration/test
// compatibility. Active request config must not use the legacy ones.
export {
  isAnthropicProvider,
  isAzureOpenAIProvider,
  isGeminiProvider,
  isOllamaProvider,
  isPerplexityProvider,
  isVertexProvider
} from '@shared/aiCore/provider/utils'

export function isAIGatewayProvider(provider: Provider): boolean {
  return (provider as unknown as { type: string }).type === 'gateway'
}

const NOT_SUPPORT_API_VERSION_PROVIDERS = ['github', 'copilot', 'perplexity'] as const satisfies SystemProviderId[]

export const isSupportAPIVersionProvider = (provider: Provider) => {
  if (isSystemProvider(provider)) {
    return !NOT_SUPPORT_API_VERSION_PROVIDERS.some((pid) => pid === provider.id)
  }
  return provider.apiOptions?.isNotSupportAPIVersion !== false
}

export const NOT_SUPPORT_API_KEY_PROVIDERS: readonly SystemProviderId[] = [
  'ollama',
  'lmstudio',
  'vertexai',
  'aws-bedrock',
  'copilot'
]

export const NOT_SUPPORT_API_KEY_PROVIDER_TYPES: readonly ProviderType[] = []

/**
 * Protocol-neutral per-connection API-key requirement.
 * Returns `true` unless the connection explicitly opts out via
 * `apiOptions.requiresApiKey === false`. Unset defaults to requiring a key.
 * OAuth (`authType === 'oauth'`) is handled by callers as a no-key path
 * where applicable; this helper reports only the explicit option.
 */
export function isApiKeyRequired(provider: Provider): boolean {
  return provider.apiOptions?.requiresApiKey !== false
}

// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration
// Custom-connection product: prompt-cache support follows protocol and the
// per-connection stored Anthropic host, never a built-in brand id list.
export const isSupportAnthropicPromptCacheProvider = (provider: Provider) => {
  return provider.type === 'anthropic' || !!provider.anthropicApiHost
}
