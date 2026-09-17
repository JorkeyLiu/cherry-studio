import { loggerService } from '@logger'
import { type Provider } from '@renderer/types'

import { type AppProviderId, appProviderIds } from '../types'

const logger = loggerService.withContext('ProviderFactory')

/**
 * Protocol-based AI SDK provider resolution (slice 3).
 *
 * Never selects by brand/provider.id: `groq`/`openrouter`/`deepseek` and any
 * other custom id with `type:'openai'` resolve as generic OpenAI-compatible
 * endpoints. Only the official OpenAI host uses the official OpenAI SDK
 * variant; everything else is protocol/type driven.
 *
 * - `openai-response` → approved OpenAI Responses (`openai`)
 * - `openai` + official `api.openai.com` host → `openai-chat`
 * - `openai` otherwise → `openai-compatible` (generic, preserves custom
 *   base URL/headers/API key/models; unknown manually mapped model ids
 *   remain requestable)
 * - `anthropic` → `anthropic`
 * - `gemini` → `google`
 */
export function getAiSdkProviderId(provider: Provider): AppProviderId {
  if (provider.type === 'openai-response') {
    return appProviderIds['openai']
  }

  if (provider.type === 'anthropic') {
    return appProviderIds['anthropic']
  }

  if (provider.type === 'gemini') {
    return appProviderIds['google']
  }

  if (provider.type === 'openai') {
    if (provider.apiHost.includes('api.openai.com')) {
      return appProviderIds['openai-chat']
    }
    return appProviderIds['openai-compatible']
  }

  logger.warn('Unknown provider type, using generic OpenAI-compatible', {
    providerId: provider.id,
    providerType: (provider as { type: string }).type,
    registeredIds: Object.keys(appProviderIds)
  })
  return appProviderIds['openai-compatible']
}
