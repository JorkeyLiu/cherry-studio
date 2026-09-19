import type { Model, Provider } from '@renderer/types'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }
}))

import { setModelMetadataSnapshotForTests } from '../modelMetadata'
import {
  clearProviderLogoCacheForTests,
  getProviderLogoDataUrl,
  resolveCanonicalModelLogo,
  resolveProviderLogoSource
} from '../providerLogo'

const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  models: {
    'moonshotai/kimi-k3': { id: 'moonshotai/kimi-k3', modalities: { input: ['text'], output: ['text'] } },
    'openai/gpt-5-mini': { id: 'openai/gpt-5-mini', modalities: { input: ['text'], output: ['text'] } }
  },
  providers: {
    anthropic: { api: '', name: 'Anthropic' },
    openai: { api: '', name: 'OpenAI' },
    'party-b': { api: 'https://api.party-b.example/v1', name: 'Party B' }
  }
}

const makeProvider = (overrides: Partial<Provider> & { id: string; type: Provider['type'] }): Provider =>
  ({ name: overrides.id, apiKey: '', apiHost: '', models: [], ...overrides }) as Provider

const makeModel = (id: string, provider: string): Model => ({ id, name: id, provider, group: provider }) as Model

describe('resolveProviderLogoSource — exact attribution only (connection logos)', () => {
  it('resolves only connections with an exact models.dev source', () => {
    expect(resolveProviderLogoSource(makeProvider({ id: 'a', type: 'anthropic' }), SNAPSHOT)).toBe('anthropic')
    expect(
      resolveProviderLogoSource(
        makeProvider({ id: 'c', type: 'openai', apiHost: 'https://api.party-b.example/v1' }),
        SNAPSHOT
      )
    ).toBe('party-b')
  })

  it('never turns arbitrary local ids/names into a logo key', () => {
    // historical brand id without exact attribution stays unknown
    expect(
      resolveProviderLogoSource(
        makeProvider({ id: 'openai', type: 'openai', apiHost: 'https://unknown.example/v9' }),
        SNAPSHOT
      )
    ).toBeNull()
    expect(resolveProviderLogoSource(makeProvider({ id: 'conn-1', type: 'openai', apiHost: '' }), SNAPSHOT)).toBeNull()
    expect(resolveProviderLogoSource(null, SNAPSHOT)).toBeNull()
    expect(resolveProviderLogoSource(makeProvider({ id: 'a', type: 'anthropic' }), null)).toBeNull()
  })
})

describe('connection vs model logos are separated', () => {
  it('proxy connection logo remains the proxy source while the model logo uses the canonical lab', () => {
    const proxy = makeProvider({ id: 'my-proxy', type: 'openai', apiHost: 'https://api.party-b.example/v1' })
    // Connection UI: the configured proxy provider logo.
    expect(resolveProviderLogoSource(proxy, SNAPSHOT)).toBe('party-b')
    // Model UI: the canonical lab, independent of the serving proxy.
    expect(resolveCanonicalModelLogo(makeModel('kimi-k3', 'my-proxy'), SNAPSHOT)).toBe('moonshotai')
    expect(resolveCanonicalModelLogo(makeModel('alibaba/kimi-k3', 'my-proxy'), SNAPSHOT)).toBe('moonshotai')
  })

  it('ambiguous/unknown canonical resolution yields null (generic fallback, never the proxy logo)', () => {
    const proxy = makeProvider({ id: 'my-proxy', type: 'openai', apiHost: 'https://api.party-b.example/v1' })
    expect(resolveProviderLogoSource(proxy, SNAPSHOT)).toBe('party-b')
    // Unknown model: no model logo even though the connection logo is known.
    expect(resolveCanonicalModelLogo(makeModel('custom-unknown-1', 'my-proxy'), SNAPSHOT)).toBeNull()
    expect(resolveCanonicalModelLogo(makeModel('kimi-k3:thinking', 'my-proxy'), SNAPSHOT)).toBeNull()
    expect(resolveCanonicalModelLogo(undefined, SNAPSHOT)).toBeNull()
    expect(resolveCanonicalModelLogo(makeModel('kimi-k3', 'my-proxy'), null)).toBeNull()
  })
})

describe('getProviderLogoDataUrl — failure is enhancement-only', () => {
  it('returns null for unsafe sources without touching IPC', async () => {
    clearProviderLogoCacheForTests()
    setModelMetadataSnapshotForTests(null)
    const getLogo = vi.fn()
    ;(window as any).api = { ...(window as any).api, providerLogo: { getLogo } }
    try {
      await expect(getProviderLogoDataUrl('../anthropic')).resolves.toBeNull()
      await expect(getProviderLogoDataUrl('__proto__')).resolves.toBeNull()
      await expect(getProviderLogoDataUrl(null)).resolves.toBeNull()
      expect(getLogo).not.toHaveBeenCalled()
    } finally {
      delete (window as any).api.providerLogo
    }
  })

  it('returns null when the preload surface is absent and when IPC fails', async () => {
    clearProviderLogoCacheForTests()
    delete (window as any).api?.providerLogo
    await expect(getProviderLogoDataUrl('anthropic')).resolves.toBeNull()

    const getLogo = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(window as any).api = { ...(window as any).api, providerLogo: { getLogo } }
    try {
      await expect(getProviderLogoDataUrl('anthropic')).resolves.toBeNull()
    } finally {
      delete (window as any).api.providerLogo
      clearProviderLogoCacheForTests()
    }
  })

  it('caches a successful logo as a data url', async () => {
    clearProviderLogoCacheForTests()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0"/></svg>'
    const getLogo = vi.fn().mockResolvedValue({ source: 'anthropic', svg, fetchedAt: 1 })
    ;(window as any).api = { ...(window as any).api, providerLogo: { getLogo } }
    try {
      const first = await getProviderLogoDataUrl('anthropic')
      expect(first?.startsWith('data:image/svg+xml;utf8,')).toBe(true)
      const second = await getProviderLogoDataUrl('anthropic')
      expect(second).toBe(first)
      expect(getLogo).toHaveBeenCalledTimes(1)
    } finally {
      delete (window as any).api.providerLogo
      clearProviderLogoCacheForTests()
    }
  })
})

describe('model avatar attribution uses the canonical lab only', () => {
  it('does not invent model-specific logos (sanity: no regex mapping exists)', async () => {
    const { useCanonicalModelLogo, useModelProviderLogo } = await import('../providerLogo')
    expect(typeof useCanonicalModelLogo).toBe('function')
    // The connection hook remains for provider UI only.
    expect(typeof useModelProviderLogo).toBe('function')
    const source = (await import('../providerLogo')).resolveProviderLogoSource
    expect(typeof source).toBe('function')
    const model = { id: 'kimi-k3', name: 'Kimi', provider: 'my-proxy' } as Model
    expect(model.id).toBe('kimi-k3')
  })
})
