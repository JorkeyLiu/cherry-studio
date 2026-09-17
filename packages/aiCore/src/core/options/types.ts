import { type AnthropicProviderOptions } from '@ai-sdk/anthropic'
import { type GoogleGenerativeAIProviderOptions } from '@ai-sdk/google'
import { type OpenAIResponsesProviderOptions } from '@ai-sdk/openai'
import { type SharedV3ProviderMetadata } from '@ai-sdk/provider'

/**
 * Known provider options map for type-safe providerOptions construction.
 * Only approved active protocols are listed; everything else (including all
 * brand gateways) uses generic OpenAI-compatible options as
 * arbitrary Record<string, any>.
 */
type ProviderOptionsMap = {
  openai: OpenAIResponsesProviderOptions
  anthropic: AnthropicProviderOptions
  google: GoogleGenerativeAIProviderOptions
}

/**
 * Type-safe ProviderOptions.
 * Known providers use strict types; unknown providers allow Record<string, any>.
 */
export type TypedProviderOptions = {
  [K in keyof ProviderOptionsMap]?: ProviderOptionsMap[K]
} & {
  [K in string]?: Record<string, any>
} & SharedV3ProviderMetadata
