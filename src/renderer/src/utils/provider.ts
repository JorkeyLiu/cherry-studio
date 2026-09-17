import type { Provider, ProviderType } from '@renderer/types'

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

/**
 * Whether message content as array type is supported. Only for OpenAI Chat Completions API.
 * Pure per-connection opt-out: `apiOptions.isNotSupportArrayContent !== true`
 * (default permissive). Provider brand ids never participate.
 */
export const isSupportArrayContentProvider = (provider: Provider) => {
  return provider.apiOptions?.isNotSupportArrayContent !== true
}

/**
 * Whether the provider supports developer as message role. Only for OpenAI API.
 * Pure explicit opt-in: `apiOptions.isSupportDeveloperRole === true`.
 */
export const isSupportDeveloperRoleProvider = (provider: Provider) => {
  return provider.apiOptions?.isSupportDeveloperRole === true
}

/**
 * Whether the provider supports the stream_options parameter. Only for OpenAI API.
 * Pure opt-out: `isNotSupportStreamOptions !== true`.
 */
export const isSupportStreamOptionsProvider = (provider: Provider) => {
  return provider.apiOptions?.isNotSupportStreamOptions !== true
}

/**
 * Whether the provider supports the enable_thinking parameter for Qwen3 etc.
 * Only for OpenAI Chat Completions API. Pure opt-out:
 * `isNotSupportEnableThinking !== true`.
 */
export const isSupportEnableThinkingProvider = (provider: Provider) => {
  return provider.apiOptions?.isNotSupportEnableThinking !== true
}

/**
 * Whether the provider supports the service_tier setting.
 * Pure opt-in: `isSupportServiceTier === true`.
 */
export const isSupportServiceTierProvider = (provider: Provider) => {
  return provider.apiOptions?.isSupportServiceTier === true
}

/**
 * Determines whether the provider supports the verbosity option.
 * Pure opt-out: `isNotSupportVerbosity !== true` (model resolver still
 * decides model-side support).
 * @param provider - The provider to check
 * @returns true if the provider supports verbosity, false otherwise
 */
export const isSupportVerbosityProvider = (provider: Provider) => {
  return provider.apiOptions?.isNotSupportVerbosity !== true
}

const SUPPORT_URL_CONTEXT_PROVIDER_TYPES = ['gemini', 'anthropic'] as const satisfies ProviderType[]

export const isSupportUrlContextProvider = (provider: Provider) => {
  return SUPPORT_URL_CONTEXT_PROVIDER_TYPES.some((type) => type === provider.type)
}

/** Gemini native websearch follows protocol only: `type === 'gemini'`. */
export const isGeminiWebSearchProvider = (provider: Provider) => {
  return provider.type === 'gemini'
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

// Re-export approved protocol helpers from shared, plus legacy history-only
// type-based helpers (isAzure/isOllama/isVertex) for migration/test
// compatibility. Active request config must not use the legacy ones.
// Note: isPerplexityProvider (brand-id based) was removed; no active consumer
// remains. isNewApiProvider/isAIGatewayProvider/isAwsBedrockProvider and the
// API-version/API-key brand allowlists were removed with it (no active
// consumer; API-key requirement is protocol-neutral via
// `apiOptions.requiresApiKey`).
export {
  isAnthropicProvider,
  isAzureOpenAIProvider,
  isGeminiProvider,
  isOllamaProvider,
  isVertexProvider
} from '@shared/aiCore/provider/utils'

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
