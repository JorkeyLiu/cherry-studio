import type { Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import * as providerUtils from '../provider'

const makeProvider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'custom',
    type: 'openai',
    name: 'Custom',
    apiKey: 'key',
    apiHost: 'https://api.example.com',
    models: [],
    ...overrides
  }) as unknown as Provider

/**
 * Source-boundary guard for the active-runtime debranding slice.
 *
 * Outside `store/migrate.ts`, `store/migrations/history/**`, and tests, no
 * active request/capability behavior may branch on provider brand id. This
 * file pins the module shape (dead brand helpers/constants are gone) and the
 * behavioral invariance (same type/model/options with different ids yields
 * the same result). Historical `SystemProviderIds` type definitions remain in
 * `types/provider.ts` for migration-history imports only (subsequent slice
 * removes them).
 */
describe('active-runtime brand boundary', () => {
  it('exposes no dead brand-keyed helpers or allowlists', () => {
    const mod = providerUtils as unknown as Record<string, unknown>
    for (const key of [
      'isNewApiProvider',
      'isAIGatewayProvider',
      'isAwsBedrockProvider',
      'isSupportAPIVersionProvider',
      'NOT_SUPPORT_API_KEY_PROVIDERS',
      'NOT_SUPPORT_API_KEY_PROVIDER_TYPES',
      'isPerplexityProvider'
    ]) {
      expect(mod[key], key).toBeUndefined()
    }
  })

  it('keeps protocol helpers while capability helpers ignore brand ids', () => {
    expect(typeof providerUtils.isOpenAICompatibleProvider).toBe('function')
    expect(typeof providerUtils.isAnthropicSupportedProvider).toBe('function')

    const ids = ['openai', 'groq', 'deepseek', 'qiniu', 'ovms', 'brand-free']
    expect(new Set(ids.map((id) => providerUtils.isSupportArrayContentProvider(makeProvider({ id })))).size).toBe(1)
    expect(new Set(ids.map((id) => providerUtils.isSupportStreamOptionsProvider(makeProvider({ id })))).size).toBe(1)
    expect(new Set(ids.map((id) => providerUtils.isSupportEnableThinkingProvider(makeProvider({ id })))).size).toBe(1)
    expect(new Set(ids.map((id) => providerUtils.isSupportVerbosityProvider(makeProvider({ id })))).size).toBe(1)
    expect(
      new Set(
        ids.map((id) =>
          providerUtils.isSupportDeveloperRoleProvider(
            makeProvider({ id, apiOptions: { isSupportDeveloperRole: true } })
          )
        )
      ).size
    ).toBe(1)
    expect(
      new Set(
        ids.map((id) =>
          providerUtils.isSupportServiceTierProvider(makeProvider({ id, apiOptions: { isSupportServiceTier: true } }))
        )
      ).size
    ).toBe(1)
  })

  it('routes Gemini websearch by protocol only', () => {
    expect(providerUtils.isGeminiWebSearchProvider(makeProvider({ id: 'whatever', type: 'gemini' }))).toBe(true)
    expect(providerUtils.isGeminiWebSearchProvider(makeProvider({ id: 'gemini', type: 'openai' }))).toBe(false)
  })
})
