import type { Model, Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { resolveExactProvider, setExactProviderResolver } from '../exactProviderResolver'

const makeProvider = (id: string, type: Provider['type'] = 'openai'): Provider =>
  ({ id, type, name: id, apiKey: '', apiHost: '', models: [] }) as Provider

const makeModel = (id: string, provider: string): Model => ({ id, name: id, provider, group: provider }) as Model

describe('exactProviderResolver — cycle-free synchronous exact match', () => {
  it('returns null without a registered resolver (never a silent fallback)', () => {
    setExactProviderResolver(null)
    expect(resolveExactProvider(makeModel('m', 'a'))).toBeNull()
    expect(resolveExactProvider(undefined)).toBeNull()
    expect(resolveExactProvider(null)).toBeNull()
    expect(resolveExactProvider(makeModel('m', ''))).toBeNull()
  })

  it('accepts only resolver results whose id equals the model provider', () => {
    const provider = makeProvider('a', 'anthropic')
    setExactProviderResolver((model) => (model?.provider === 'a' ? provider : undefined))
    try {
      expect(resolveExactProvider(makeModel('m', 'a'))).toBe(provider)
      expect(resolveExactProvider(makeModel('m', 'deleted'))).toBeNull()
    } finally {
      setExactProviderResolver(null)
    }
  })

  it('rejects mismatched ids and throwing resolvers as null without throwing', () => {
    const provider = makeProvider('a', 'anthropic')
    setExactProviderResolver(() => ({ ...provider, id: 'default-other' }) as Provider)
    try {
      expect(resolveExactProvider(makeModel('m', 'a'))).toBeNull()
    } finally {
      setExactProviderResolver(null)
    }

    setExactProviderResolver(() => {
      throw new Error('store down')
    })
    try {
      expect(resolveExactProvider(makeModel('m', 'a'))).toBeNull()
    } finally {
      setExactProviderResolver(null)
    }
  })
})
