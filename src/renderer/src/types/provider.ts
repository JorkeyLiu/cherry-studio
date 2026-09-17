import type OpenAI from '@cherrystudio/openai'
import type { Model } from '@types'
import * as z from 'zod'

import type { OpenAIVerbosity } from './aiCoreTypes'

export const ProviderTypeSchema = z.enum(['openai', 'openai-response', 'anthropic', 'gemini'])

export type ProviderType = z.infer<typeof ProviderTypeSchema>

/**
 * Approved active provider protocols (slice 3 contract).
 * `openai` is generic OpenAI-compatible, `openai-response` is the OpenAI
 * Responses-API variant, plus `anthropic` and `gemini`.
 */
export const ACTIVE_PROVIDER_TYPES = [
  'openai',
  'openai-response',
  'anthropic',
  'gemini'
] as const satisfies readonly ProviderType[]

export type ActiveProviderType = (typeof ACTIVE_PROVIDER_TYPES)[number]

export function isActiveProviderType(type: string): type is ActiveProviderType {
  return (ACTIVE_PROVIDER_TYPES as readonly string[]).includes(type)
}

// undefined is treated as supported, enabled by default
export type ProviderApiOptions = {
  /**
   * Protocol-neutral per-connection API-key requirement.
   * When `false`, the connection may be used without an API key
   * (e.g. local servers such as Ollama). When `true` or unset,
   * an API key is required. Default behavior when unset is `true`.
   */
  requiresApiKey?: boolean
  /** Whether message content of array type is not supported */
  isNotSupportArrayContent?: boolean
  /** Whether the stream_options parameter is not supported */
  isNotSupportStreamOptions?: boolean
  /**
   * @deprecated
   * Whether message role 'developer' is not supported */
  isNotSupportDeveloperRole?: boolean
  /* Whether message role 'developer' is supported */
  isSupportDeveloperRole?: boolean
  /**
   * @deprecated
   * Whether the service_tier parameter is not supported. Only for OpenAI Models. */
  isNotSupportServiceTier?: boolean
  /* Whether the service_tier parameter is supported. Only for OpenAI Models. */
  isSupportServiceTier?: boolean
  /** Whether the enable_thinking parameter is not supported */
  isNotSupportEnableThinking?: boolean
  /** Whether verbosity is not supported. For OpenAI API (completions & responses). */
  isNotSupportVerbosity?: boolean
}

// scale is not well supported now. It even lacks of docs
// We take undefined as same as default, and null as same as explicitly off.
// It controls whether the response contains the serviceTier field or not, so undefined and null should be separated.
export type OpenAIServiceTier = Exclude<OpenAI.Responses.ResponseCreateParams['service_tier'], 'scale'>

export const OpenAIServiceTiers = {
  auto: 'auto',
  default: 'default',
  flex: 'flex',
  priority: 'priority'
} as const satisfies Record<NonNullable<OpenAIServiceTier>, OpenAIServiceTier>

export function isOpenAIServiceTier(tier: string | null | undefined): tier is OpenAIServiceTier {
  return tier === null || tier === undefined || Object.hasOwn(OpenAIServiceTiers, tier)
}

// https://console.groq.com/docs/api-reference#responses
// null is not used.
export type GroqServiceTier = 'auto' | 'on_demand' | 'flex' | undefined | null

export const GroqServiceTiers = {
  auto: 'auto',
  on_demand: 'on_demand',
  flex: 'flex'
} as const satisfies Record<string, GroqServiceTier>

export function isGroqServiceTier(tier: string | undefined | null): tier is GroqServiceTier {
  return tier === null || tier === undefined || Object.hasOwn(GroqServiceTiers, tier)
}

export type ServiceTier = OpenAIServiceTier | GroqServiceTier

export type AnthropicCacheControlSettings = {
  tokenThreshold: number
  cacheSystemMessage: boolean
  cacheLastNMessages: number
}

export function isServiceTier(tier: string | null | undefined): tier is ServiceTier {
  return isGroqServiceTier(tier) || isOpenAIServiceTier(tier)
}

export type Provider = {
  id: string
  type: ProviderType
  name: string
  apiKey: string
  apiHost: string
  anthropicApiHost?: string
  isAnthropicModel?: (m: Model) => boolean
  apiVersion?: string
  models: Model[]
  enabled?: boolean
  /**
   * Inert persisted compatibility field. Historical backups and migration
   * replay may carry it; active runtime assigns it no behavior and must not
   * branch on it. Brand identity definitions (`SystemProviderId`,
   * `SystemProviderIds`, `isSystemProvider*`) live only in
   * `store/migrations/history/brandIds.ts` for migration replay.
   */
  isSystem?: boolean
  isAuthed?: boolean
  rateLimit?: number

  // API options
  apiOptions?: ProviderApiOptions
  serviceTier?: ServiceTier
  verbosity?: OpenAIVerbosity

  /** @deprecated */
  isNotSupportArrayContent?: boolean
  /** @deprecated */
  isNotSupportStreamOptions?: boolean
  /** @deprecated */
  isNotSupportDeveloperRole?: boolean
  /** @deprecated */
  isNotSupportServiceTier?: boolean

  authType?: 'apiKey' | 'oauth'
  isVertex?: boolean
  notes?: string
  extra_headers?: Record<string, string>

  // Anthropic prompt caching settings
  anthropicCacheControl?: AnthropicCacheControlSettings
}
