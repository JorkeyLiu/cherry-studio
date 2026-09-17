import { hasProviderConfig, type StringKeys } from '@cherrystudio/ai-core/provider'
import type { AppProviderId, AppProviderSettingsMap } from '@renderer/aiCore/types'
import { getProviderByModel } from '@renderer/services/AssistantService'
import store from '@renderer/store'
import { type Model, type Provider } from '@renderer/types'
import { formatApiHost, isWithTrailingSharp, routeToEndpoint } from '@renderer/utils/api'
import { assertProviderMatchesModel } from '@renderer/utils/noModelError'
import { isAnthropicProvider, isGeminiProvider, isSupportStreamOptionsProvider } from '@renderer/utils/provider'
import { defaultAppHeaders } from '@shared/utils'
import { cloneDeep } from 'lodash'

import type { ProviderConfig } from '../types'
import { getAiSdkProviderId } from './factory'

// === Types ===

interface BaseConfig {
  baseURL: string
  apiKey: string
}

interface BuilderContext {
  actualProvider: Provider
  model: Model
  baseConfig: BaseConfig
  endpoint?: string
  aiSdkProviderId: AppProviderId
}

// === Host Formatting ===

type HostFormatter = {
  match: (provider: Provider) => boolean
  format: (provider: Provider, appendApiVersion: boolean) => string
}

// WARNING: if any changes are made here, please sync it to src/main/aiCore/provider/providerConfig.ts:formatProviderApiHost
export function formatProviderApiHost(provider: Provider): Provider {
  const formatted = { ...provider }
  const appendApiVersion = !isWithTrailingSharp(provider.apiHost)

  if (formatted.anthropicApiHost) {
    formatted.anthropicApiHost = formatApiHost(formatted.anthropicApiHost, appendApiVersion)
  }

  // Anthropic is special: uses anthropicApiHost as source and syncs both fields
  if (isAnthropicProvider(provider)) {
    const baseHost = formatted.anthropicApiHost || formatted.apiHost
    formatted.apiHost = formatApiHost(baseHost, appendApiVersion)
    if (!formatted.anthropicApiHost) {
      formatted.anthropicApiHost = formatted.apiHost
    }
    return formatted
  }

  const formatters: HostFormatter[] = [
    { match: isGeminiProvider, format: (p, av) => formatApiHost(p.apiHost, av, 'v1beta') }
  ]

  const formatter = formatters.find((f) => f.match(provider))
  formatted.apiHost = formatter
    ? formatter.format(formatted, appendApiVersion)
    : formatApiHost(formatted.apiHost, appendApiVersion)

  return formatted
}

// === SDK Config Building ===

type ConfigBuilderEntry = {
  match: (provider: Provider, aiSdkProviderId: AppProviderId) => boolean
  build: (ctx: BuilderContext) => ProviderConfig | Promise<ProviderConfig>
}

export function providerToAiSdkConfig(
  actualProvider: Provider,
  model: Model
): ProviderConfig | Promise<ProviderConfig> {
  const aiSdkProviderId = getAiSdkProviderId(actualProvider)
  const { baseURL, endpoint } = routeToEndpoint(actualProvider.apiHost)

  const ctx: BuilderContext = {
    actualProvider,
    model,
    baseConfig: { baseURL, apiKey: actualProvider.apiKey },
    endpoint,
    aiSdkProviderId
  }

  const builders: ConfigBuilderEntry[] = [
    // Anthropic OAuth is retained because Anthropic is an approved protocol.
    // Matched by protocol/type + oauth mode, never by brand/provider.id.
    { match: (p) => p.type === 'anthropic' && p.authType === 'oauth', build: buildAnthropicConfig }
  ]

  const builder = builders.find((b) => b.match(actualProvider, aiSdkProviderId))
  if (builder) {
    return builder.build(ctx)
  }

  // SDK-supported provider → generic config; otherwise → openai-compatible fallback.
  // Generic OpenAI-compatible preserves custom base URL/headers/API key/models;
  // unknown manually mapped model ids remain requestable through the owning entry.
  if (hasProviderConfig(aiSdkProviderId) && aiSdkProviderId !== 'openai-compatible') {
    return buildGenericProviderConfig(ctx)
  }
  return buildOpenAICompatibleConfig(ctx)
}

// === Public API ===

export function getActualProvider(model: Model): Provider {
  const provider = getProviderByModel(model)
  // Never silently substitute another (e.g. default) provider when the
  // model's own provider is gone: the stale model fails explicitly before
  // any provider/API invocation, same as the ApiService boundary. Catalog or
  // external model metadata presence is not consulted — manually configured
  // or renamed model ids resolve with basic protocol behavior as long as
  // their owning provider entry exists.
  assertProviderMatchesModel(model, provider)
  return adaptProvider({ provider, model })
}

export function adaptProvider({ provider }: { provider: Provider; model?: Model }): Provider {
  return formatProviderApiHost(cloneDeep(provider))
}

export function isModernSdkSupported(provider: Provider): boolean {
  return hasProviderConfig(getAiSdkProviderId(provider))
}

// === Config Builders ===

function buildCommonOptions(ctx: BuilderContext) {
  const options: Record<string, any> = {
    headers: {
      ...defaultAppHeaders(),
      ...ctx.actualProvider.extra_headers
    }
  }
  if (ctx.aiSdkProviderId === 'openai') {
    options.headers['X-Api-Key'] = ctx.baseConfig.apiKey
  }
  return options
}

async function buildAnthropicConfig(ctx: BuilderContext): Promise<ProviderConfig<'anthropic'>> {
  const oauthToken: string = await window.api.anthropic_oauth.getAccessToken()

  return {
    providerId: 'anthropic',
    endpoint: ctx.endpoint,
    providerSettings: {
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: '',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Authorization: `Bearer ${oauthToken}`
      }
    }
  }
}

function buildOpenAICompatibleConfig(ctx: BuilderContext): ProviderConfig<'openai-compatible'> {
  const commonOptions = buildCommonOptions(ctx)
  const includeUsage = isSupportStreamOptionsProvider(ctx.actualProvider)
    ? store.getState().settings.openAI?.streamOptions?.includeUsage
    : undefined

  return {
    providerId: 'openai-compatible',
    endpoint: ctx.endpoint,
    providerSettings: { ...ctx.baseConfig, ...commonOptions, name: ctx.actualProvider.id, includeUsage }
  }
}

function buildGenericProviderConfig(ctx: BuilderContext): ProviderConfig {
  const commonOptions = buildCommonOptions(ctx)

  return {
    providerId: ctx.aiSdkProviderId as StringKeys<AppProviderSettingsMap>,
    endpoint: ctx.endpoint,
    providerSettings: { ...ctx.baseConfig, ...commonOptions }
  }
}
