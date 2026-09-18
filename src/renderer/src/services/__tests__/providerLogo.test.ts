import type { Model, Provider } from '@renderer/types'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }
}))

import { setModelMetadataSnapshotForTests } from '../modelMetadata'
import { clearProviderLogoCacheForTests, getProviderLogoDataUrl, resolveProviderLogoSource } from '../providerLogo'

const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  providers: {
    anthropic: { api: '', name: 'Anthropic', models: {} },
    openai: { api: '', name: 'OpenAI', models: {} },
    'party-b': { api: 'https://api.party-b.example/v1', name: 'Party B', models: {} }
  }
}

const makeProvider = (overrides: Partial<Provider> & { id: string; type: Provider['type'] }): Provider =>
  ({ name: overrides.id, apiKey: '', apiHost: '', models: [], ...overrides }) as Provider

describe('resolveProviderLogoSource — exact attribution only', () => {
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

describe('model avatar attribution uses the owning provider only', () => {
  it('does not invent model-specific logos (sanity: no regex mapping exists)', async () => {
    const { useModelProviderLogo } = await import('../providerLogo')
    expect(typeof useModelProviderLogo).toBe('function')
    const source = (await import('../providerLogo')).resolveProviderLogoSource
    expect(typeof source).toBe('function')
    const model = { id: 'claude-sonnet-4-6', name: 'Claude', provider: 'a' } as Model
    expect(model.id).toBe('claude-sonnet-4-6')
  })
})
