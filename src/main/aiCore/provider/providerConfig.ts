import { isAnthropicProvider, isGeminiProvider } from '@shared/aiCore/provider/utils'
import { formatApiHost, isWithTrailingSharp } from '@shared/utils'
import type { Provider } from '@types'

type HostFormatter = {
  match: (provider: Provider) => boolean
  format: (provider: Provider, appendApiVersion: boolean) => string | Promise<string>
}

/**
 * Format and normalize the API host URL for a provider (slice 3).
 * Approved protocols only: Anthropic (dual-field sync) and Gemini (v1beta);
 * all other approved OpenAI-compatible entries use the generic formatter.
 * No brand-id or retired-protocol formatters in the active path.
 *
 * @param provider - The provider whose API host is to be formatted.
 * @returns A new provider instance with the formatted API host.
 */
export async function formatProviderApiHost(provider: Provider): Promise<Provider> {
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
    ? await formatter.format(formatted, appendApiVersion)
    : formatApiHost(formatted.apiHost, appendApiVersion)

  return formatted
}
