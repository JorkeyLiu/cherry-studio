/**
 * @fileoverview Shared Anthropic AI client utilities for Cherry Studio
 *
 * This module provides a function for creating Anthropic SDK clients with
 * standard API-key authentication against the connection's configured host.
 *
 * This shared module can be used by both main and renderer processes.
 */

import Anthropic from '@anthropic-ai/sdk'
import { loggerService } from '@logger'
import { withoutTrailingApiVersion } from '@shared/utils/api'
import type { Provider } from '@types'

const logger = loggerService.withContext('anthropic-sdk')

/**
 * Creates and configures an Anthropic SDK client based on the provider configuration.
 *
 * Uses standard API-key authentication against the connection's configured
 * host (`apiHost`, or `anthropicApiHost` for non-Anthropic protocol entries
 * with an explicit Anthropic-compatible host).
 *
 * @param provider - The provider configuration containing the API key and host
 * @param extraHeaders - Optional extra headers merged over the defaults
 * @returns An initialized Anthropic client
 *
 * @example
 * ```typescript
 * const client = getSdkClient({
 *   apiKey: 'your-api-key',
 *   apiHost: 'https://api.anthropic.com'
 * });
 * ```
 */
export function getSdkClient(provider: Provider, extraHeaders?: Record<string, string | string[]>): Anthropic {
  const rawBaseURL =
    provider.type === 'anthropic'
      ? provider.apiHost
      : (provider.anthropicApiHost && provider.anthropicApiHost.trim()) || provider.apiHost
  const baseURL = withoutTrailingApiVersion(rawBaseURL)

  logger.debug('Anthropic API baseURL', { baseURL, providerId: provider.id })

  return new Anthropic({
    apiKey: provider.apiKey,
    authToken: provider.apiKey,
    baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      'anthropic-beta': 'output-128k-2025-02-19',
      ...provider.extra_headers,
      ...extraHeaders
    }
  })
}
