import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Provider } from '@renderer/types'
import * as activeTypes from '@renderer/types'
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
 * the same result). Built-in/system provider brand identity definitions were
 * removed from the active type layer (`types/provider.ts`): the frozen
 * 62-ID union/map plus `isSystemProviderId`/`isSystemProvider` live only in
 * `store/migrations/history/brandIds.ts` for migration replay, and
 * `Provider.isSystem` remains an inert persisted compatibility field with no
 * active behavior.
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

  it('exports no system-provider brand identity from the active type layer', () => {
    // Runtime/property absence: none of the retired brand values may exist on
    // the active types surface (frozen copies live only in history/brandIds).
    const types = activeTypes as unknown as Record<string, unknown>
    for (const key of [
      'SystemProviderIdSchema',
      'SystemProviderIdList',
      'SystemProviderIds',
      'isSystemProviderId',
      'isSystemProvider',
      'isGroqSystemProvider'
    ]) {
      expect(types[key], key).toBeUndefined()
    }

    // Source-boundary: `types/provider.ts` and `types/index.ts` must not
    // define, export, or re-export any of the retired brand symbols (values
    // or types). Mentions inside comments pointing at the history module are
    // allowed, so only export definitions count as violations. The inert
    // `Provider.isSystem` field is not a brand symbol and never matches.
    const HERE = dirname(fileURLToPath(import.meta.url))
    const activeTypeFiles = [
      join(HERE, '..', '..', 'types', 'provider.ts'),
      join(HERE, '..', '..', 'types', 'index.ts')
    ]
    const brandName =
      '(?:SystemProviderIds?|SystemProviderIdSchema|SystemProviderIdList|SystemProvider|GroqSystemProvider|NotGroqProvider|SystemProviderIdTypeMap|isSystemProviderId?|isGroqSystemProvider)'
    const patterns = [
      // Direct export declarations: export const/type/interface/... <Brand>
      new RegExp(`export\\s+(?:const|let|var|function|class|interface|enum|type)\\s+${brandName}\\b`),
      // export type { <Brand> } (with or without `from '...'`)
      new RegExp(`export\\s+type\\s*\\{[^}]*\\b${brandName}\\b[^}]*\\}`),
      // export { type <Brand> }
      new RegExp(`export\\s*\\{[^}]*\\btype\\s+${brandName}\\b[^}]*\\}`),
      // export { <Brand> } (value or type re-export, with or without `from`)
      new RegExp(`export\\s*\\{[^}]*\\b${brandName}\\b[^}]*\\}`),
      // Star re-export from the history module: export [type] * from '...brandIds...'
      new RegExp(`export\\s*\\*\\s*from\\s*['"][^'"]*brandIds[^'"]*['"]`),
      new RegExp(`export\\s+type\\s*\\*\\s*from\\s*['"][^'"]*brandIds[^'"]*['"]`),
      // Named re-export from the history module: export [type] { ... } from '...brandIds...'
      new RegExp(`export\\s+(?:type\\s*)?\\{[^}]*\\}\\s*from\\s*['"][^'"]*brandIds[^'"]*['"]`)
    ]
    for (const filePath of activeTypeFiles) {
      expect(existsSync(filePath), filePath).toBe(true)
      const source = readFileSync(filePath, 'utf8')
      const code = source
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim()
          return (
            !trimmed.startsWith('*') &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('/*') &&
            !trimmed.startsWith('*/')
          )
        })
        .join('\n')
      for (const pattern of patterns) {
        expect(`${filePath} ${pattern}: ${code.match(pattern)?.[0] ?? 'no match'}`).toBe(
          `${filePath} ${pattern}: no match`
        )
      }
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
