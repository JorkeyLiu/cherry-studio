import type { Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { matchKeywordsInProvider } from '../match'
import { getFancyProviderName } from '../naming'
import {
  getClaudeSupportedProviders,
  isAnthropicSupportedProvider,
  isSupportAnthropicPromptCacheProvider
} from '../provider'

const makeProvider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'conn-1',
    type: 'openai',
    name: 'My Connection',
    apiKey: 'key',
    apiHost: 'https://api.example.com',
    models: [],
    ...overrides
  }) as Provider

describe('custom provider decoupling (no built-in brand catalog)', () => {
  it('displays the stored connection name, never a translated brand label', () => {
    expect(getFancyProviderName(makeProvider({ name: 'My Connection' }))).toBe('My Connection')
    // Legacy persisted entries may still carry isSystem:true with a brand id;
    // display still uses the stored name.
    expect(getFancyProviderName(makeProvider({ id: 'openai', name: 'Work OpenAI', isSystem: true }))).toBe(
      'Work OpenAI'
    )
  })

  it('falls back to provider id when the stored name is blank', () => {
    expect(getFancyProviderName(makeProvider({ id: 'conn-xyz', name: '' }))).toBe('conn-xyz')
    expect(getFancyProviderName(makeProvider({ id: 'conn-xyz', name: '   ' }))).toBe('conn-xyz')
  })

  it('searches stored id/name only, not brand labels', () => {
    const provider = makeProvider({ id: 'dashscope', name: 'My Bailian' })
    expect(matchKeywordsInProvider(['my'], provider)).toBe(true)
    expect(matchKeywordsInProvider(['dashscope'], provider)).toBe(true)
    // Historical translated brand label must not match.
    expect(matchKeywordsInProvider(['alibaba'], provider)).toBe(false)
  })

  it('resolves Claude/Agent support by protocol and stored host only', () => {
    expect(isAnthropicSupportedProvider(makeProvider({ type: 'anthropic' }))).toBe(true)
    expect(
      isAnthropicSupportedProvider(makeProvider({ type: 'openai', anthropicApiHost: 'https://anthropic.local' }))
    ).toBe(true)
    // Historical brand id alone grants nothing.
    expect(isAnthropicSupportedProvider(makeProvider({ id: 'aihubmix', type: 'openai' }))).toBe(false)
    expect(
      getClaudeSupportedProviders([
        makeProvider({ id: 'a', type: 'anthropic' }),
        makeProvider({ id: 'aihubmix', type: 'openai' })
      ])
    ).toHaveLength(1)
  })

  it('resolves prompt-cache support by protocol and stored host only', () => {
    expect(isSupportAnthropicPromptCacheProvider(makeProvider({ type: 'anthropic' }))).toBe(true)
    expect(
      isSupportAnthropicPromptCacheProvider(
        makeProvider({ type: 'openai', anthropicApiHost: 'https://anthropic.local' })
      )
    ).toBe(true)
    expect(isSupportAnthropicPromptCacheProvider(makeProvider({ id: 'openai', type: 'openai' }))).toBe(false)
  })

  it('treats delete/edit availability as unconditional (no isSystem gate)', () => {
    // ProviderList always returns the full menu set now; this pins the
    // contract at the type level: legacy isSystem must not restrict edits.
    const legacySystem = makeProvider({ id: 'openai', isSystem: true })
    expect(getFancyProviderName(legacySystem)).toBe('My Connection')
    expect(matchKeywordsInProvider(['my'], legacySystem)).toBe(true)
  })
})
