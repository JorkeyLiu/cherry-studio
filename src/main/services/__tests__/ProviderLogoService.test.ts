import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderLogoService, registerProviderLogoIpc } from '../ProviderLogoService'

const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2v20"/></svg>'
const UNSAFE_SVG = '<svg><script>alert(1)</script></svg>'

function mockResponse(overrides: {
  status?: number
  ok?: boolean
  headers?: Record<string, string>
  text?: string | (() => Promise<string>)
}): Response {
  const headers = overrides.headers ?? { 'content-type': 'image/svg+xml' }
  return {
    status: overrides.status ?? 200,
    ok: overrides.ok ?? true,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    text: async () => (typeof overrides.text === 'function' ? overrides.text() : (overrides.text ?? ''))
  } as unknown as Response
}

function makeService(overrides: ConstructorParameters<typeof ProviderLogoService>[0] = {}) {
  const fetchFn = vi.fn()
  const readCacheFile = vi.fn()
  const writeCacheFileAtomic = vi.fn()
  const service = new ProviderLogoService({
    fetchFn: fetchFn as unknown as typeof fetch,
    readCacheFile,
    writeCacheFileAtomic,
    cacheFilePath: '/cache/provider-logos/models-dev-logos.json',
    now: () => 1_000_000,
    ...overrides
  })
  return { service, fetchFn, readCacheFile, writeCacheFileAtomic }
}

function diskEnvelope(logos: Record<string, { svg: string; fetchedAt: number; etag?: string }>) {
  return JSON.stringify({ version: 1, fetchedAt: 500_000, logos })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ProviderLogoService admission', () => {
  it('refuses unsafe source strings without fetching', async () => {
    const { service, fetchFn } = makeService()
    for (const source of ['../anthropic', '__proto__', 'My Connection', '', 'OPENAI']) {
      expect(await service.getLogo(source)).toBeNull()
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('gates unknown sources on the exact metadata source list', async () => {
    const { service, fetchFn } = makeService({ getKnownSources: () => ['anthropic'] })
    fetchFn.mockResolvedValue(mockResponse({ text: SAFE_SVG }))
    // unknown local id is format-safe but absent from known sources: no fetch
    expect(await service.getLogo('conn-1', { force: true })).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
    // exact source fetches the official logo URL only
    const result = await service.getLogo('anthropic', { force: true })
    expect(result?.svg).toBe(SAFE_SVG)
    expect(fetchFn.mock.calls[0][0]).toBe('https://models.dev/logos/anthropic.svg')
  })

  it('returns cached last-known-good when the gate is closed and nothing is cached', async () => {
    const { service, fetchFn } = makeService({ getKnownSources: () => null })
    fetchFn.mockResolvedValue(mockResponse({ text: SAFE_SVG }))
    expect(await service.getLogo('anthropic', { force: true })).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('ProviderLogoService caching/304/LKG', () => {
  it('caches a fetched logo atomically and reuses fresh cache without refetch', async () => {
    const { service, fetchFn, writeCacheFileAtomic } = makeService()
    fetchFn.mockResolvedValue(
      mockResponse({ text: SAFE_SVG, headers: { 'content-type': 'image/svg+xml', etag: '"v1"' } })
    )
    const first = await service.getLogo('anthropic', { force: true })
    expect(first?.svg).toBe(SAFE_SVG)
    expect(writeCacheFileAtomic).toHaveBeenCalledTimes(1)

    const second = await service.getLogo('anthropic')
    expect(second?.svg).toBe(SAFE_SVG)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('honors ETag 304 by advancing staleness without replacing the svg', async () => {
    const { service, fetchFn, readCacheFile, writeCacheFileAtomic } = makeService({
      now: () => 1_000_000 + 8 * 24 * 60 * 60 * 1000
    })
    readCacheFile.mockResolvedValue(diskEnvelope({ anthropic: { svg: SAFE_SVG, fetchedAt: 500_000, etag: '"v1"' } }))
    await service.ensureLoaded()
    fetchFn.mockResolvedValue(mockResponse({ status: 304, ok: false, text: '' }))
    const result = await service.getLogo('anthropic', { force: true })
    expect(result?.svg).toBe(SAFE_SVG)
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ headers: { 'If-None-Match': '"v1"' } })
    expect(writeCacheFileAtomic).toHaveBeenCalled()
  })

  it('retains last-known-good when the fetch fails', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(diskEnvelope({ anthropic: { svg: SAFE_SVG, fetchedAt: 500_000 } }))
    await service.ensureLoaded()
    fetchFn.mockRejectedValue(new Error('boom'))
    const result = await service.getLogo('anthropic', { force: true })
    expect(result?.svg).toBe(SAFE_SVG)
  })

  it('keeps memory when the atomic cache write fails', async () => {
    const { service, fetchFn, writeCacheFileAtomic } = makeService()
    fetchFn.mockResolvedValue(mockResponse({ text: SAFE_SVG }))
    writeCacheFileAtomic.mockRejectedValue(new Error('disk full'))
    const result = await service.getLogo('anthropic', { force: true })
    expect(result?.svg).toBe(SAFE_SVG)
  })
})

describe('ProviderLogoService unsafe rejection', () => {
  it('rejects non-svg, oversize, and unsafe svg bodies', async () => {
    const { service, fetchFn } = makeService()
    fetchFn.mockResolvedValue(mockResponse({ headers: { 'content-type': 'application/json' }, text: '{}' }))
    expect(await service.getLogo('anthropic', { force: true })).toBeNull()

    fetchFn.mockResolvedValue(
      mockResponse({ headers: { 'content-type': 'image/svg+xml', 'content-length': '999999999' }, text: SAFE_SVG })
    )
    expect(await service.getLogo('anthropic', { force: true })).toBeNull()

    fetchFn.mockResolvedValue(mockResponse({ text: UNSAFE_SVG }))
    expect(await service.getLogo('anthropic', { force: true })).toBeNull()
    expect(service.getCachedLogo('anthropic')).toBeNull()
  })

  it('enforces the byte cap in UTF-8 bytes', async () => {
    const { service, fetchFn } = makeService({ maxBytes: 10 })
    fetchFn.mockResolvedValue(mockResponse({ text: 'é'.repeat(6) }))
    expect(await service.getLogo('anthropic', { force: true })).toBeNull()
  })

  it('treats timeouts as enhancement-only failures', async () => {
    const { service, fetchFn } = makeService()
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    fetchFn.mockRejectedValue(abortError)
    expect(await service.getLogo('anthropic', { force: true })).toBeNull()
  })
})

describe('registerProviderLogoIpc', () => {
  it('registers exactly the logo channels in Main house style', () => {
    const { service } = makeService()
    registerProviderLogoIpc(service)
    expect(ipcMain.handle).toHaveBeenCalledWith(IpcChannel.ProviderLogo_GetLogo, expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith(IpcChannel.ProviderLogo_GetLogos, expect.any(Function))
    expect(IpcChannel.ProviderLogo_GetLogo).toBe('provider-logo:get-logo')
    expect(IpcChannel.ProviderLogo_GetLogos).toBe('provider-logo:get-logos')
  })
})
