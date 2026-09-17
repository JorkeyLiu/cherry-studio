import type { Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { isApiKeyRequired } from '../provider'

const makeProvider = (overrides: Partial<Provider> = {}): Provider =>
  ({
    id: 'conn-1',
    type: 'openai',
    name: 'My Connection',
    apiKey: '',
    apiHost: 'https://api.example.com',
    models: [],
    ...overrides
  }) as Provider

describe('isApiKeyRequired (protocol-neutral per-connection option)', () => {
  it('defaults to requiring a key when unset', () => {
    expect(isApiKeyRequired(makeProvider({}))).toBe(true)
    expect(isApiKeyRequired(makeProvider({ apiOptions: {} }))).toBe(true)
  })

  it('honors explicit false/true for every protocol', () => {
    for (const type of ['openai', 'openai-response', 'anthropic', 'gemini'] as const) {
      expect(isApiKeyRequired(makeProvider({ type, apiOptions: { requiresApiKey: false } }))).toBe(false)
      expect(isApiKeyRequired(makeProvider({ type, apiOptions: { requiresApiKey: true } }))).toBe(true)
      expect(isApiKeyRequired(makeProvider({ type }))).toBe(true)
    }
  })

  it('never consults brand ids', () => {
    expect(isApiKeyRequired(makeProvider({ id: 'ollama', type: 'openai' }))).toBe(true)
    expect(
      isApiKeyRequired(makeProvider({ id: 'ollama', type: 'openai', apiOptions: { requiresApiKey: false } }))
    ).toBe(false)
  })
})
