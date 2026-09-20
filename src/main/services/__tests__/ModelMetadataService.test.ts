import { IpcChannel } from '@shared/IpcChannel'
import { MODEL_METADATA_REFRESH_INTERVAL_MS } from '@shared/modelMetadata'
import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ModelMetadataService, registerModelMetadataIpc } from '../ModelMetadataService'

const RAW_CANONICAL_FIXTURE = {
  'moonshotai/kimi-k3': {
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: false,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1048576, output: 131072 }
  },
  'legacy-unknown': { id: 'legacy-unknown', name: 'Legacy' }
}

const RAW_PROVIDER_SOURCES_FIXTURE = {
  anthropic: { id: 'anthropic', name: 'Anthropic' },
  openai: { id: 'openai', name: 'OpenAI', api: 'https://api.openai.com/v1' }
}

function mockResponse(overrides: {
  status?: number
  ok?: boolean
  headers?: Record<string, string>
  text?: string | (() => Promise<string>)
}): Response {
  const headers = overrides.headers ?? { 'content-type': 'application/json' }
  return {
    status: overrides.status ?? 200,
    ok: overrides.ok ?? true,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    text: async () => (typeof overrides.text === 'function' ? overrides.text() : (overrides.text ?? ''))
  } as unknown as Response
}

function makeService(overrides: ConstructorParameters<typeof ModelMetadataService>[0] = {}) {
  const fetchFn = vi.fn()
  const readCacheFile = vi.fn()
  const writeCacheFileAtomic = vi.fn()
  const service = new ModelMetadataService({
    fetchFn: fetchFn as unknown as typeof fetch,
    readCacheFile,
    writeCacheFileAtomic,
    cacheFilePath: '/cache/model-metadata/models-dev-models.json',
    now: () => 1_000_000,
    ...overrides
  })
  return { service, fetchFn, readCacheFile, writeCacheFileAtomic }
}

function diskEnvelope(snapshot: unknown, etag?: string) {
  return JSON.stringify({
    version: 3,
    fetchedAt: 500_000,
    ...(etag ? { etag } : {}),
    snapshot
  })
}

function diskSnapshot() {
  return {
    source: 'models.dev',
    fetchedAt: 500_000,
    etag: '"v1"',
    models: {
      'moonshotai/kimi-k3': {
        id: 'moonshotai/kimi-k3',
        modalities: { input: ['text'], output: ['text'] }
      }
    },
    providers: {
      anthropic: { api: '', name: 'Anthropic' }
    }
  }
}

function mockBothSuccess(fetchFn: ReturnType<typeof vi.fn>, etag?: string) {
  fetchFn.mockImplementation((url: string) =>
    Promise.resolve(
      mockResponse({
        headers: etag ? { 'content-type': 'application/json', etag } : { 'content-type': 'application/json' },
        text:
          String(url).endsWith('/models.json') || String(url).includes('models.json')
            ? JSON.stringify(RAW_CANONICAL_FIXTURE)
            : JSON.stringify(RAW_PROVIDER_SOURCES_FIXTURE)
      })
    )
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ModelMetadataService refresh', () => {
  it('fetches canonical models.json + provider list and persists the v3 envelope', async () => {
    const { service, fetchFn, writeCacheFileAtomic } = makeService()
    mockBothSuccess(fetchFn)

    const result = await service.refresh({ force: true })

    expect(result).toEqual({ ok: true, fetchedAt: 1_000_000 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(String(fetchFn.mock.calls[0][0])).toContain('models.json')
    const snapshot = service.getSnapshot()!
    // Canonical model facts: validated booleans, no proxy-only fields.
    expect(snapshot.models['moonshotai/kimi-k3']).toMatchObject({
      id: 'moonshotai/kimi-k3',
      attachment: true,
      toolCall: true,
      reasoning: true,
      temperature: false,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limits: { context: 1048576, output: 131072 }
    })
    expect('pricing' in snapshot.models['moonshotai/kimi-k3']).toBe(false)
    // absent optional fields stay unknown, not false
    const legacy = snapshot.models['legacy-unknown']
    expect(legacy.attachment).toBeUndefined()
    expect(legacy.toolCall).toBeUndefined()
    expect(legacy.reasoning).toBeUndefined()
    // Provider-source list carries api + name only (connection logos) when no serving effort.
    expect(snapshot.providers).toEqual({
      anthropic: { api: '', name: 'Anthropic' },
      openai: { api: 'https://api.openai.com/v1', name: 'OpenAI' }
    })

    expect(writeCacheFileAtomic).toHaveBeenCalledTimes(1)
    const [filePath, data] = writeCacheFileAtomic.mock.calls[0]
    expect(filePath).toBe('/cache/model-metadata/models-dev-models.json')
    const envelope = JSON.parse(data)
    expect(envelope.version).toBe(3)
    expect(envelope.snapshot.source).toBe('models.dev')
    expect(envelope.snapshot.models['moonshotai/kimi-k3'].id).toBe('moonshotai/kimi-k3')
  })

  it('retains last-known-good memory/disk snapshot when the canonical fetch fails', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot()))
    await service.ensureLoaded()
    expect(service.getSnapshot()?.models['moonshotai/kimi-k3']).toBeDefined()

    fetchFn.mockRejectedValue(new Error('boom'))
    const result = await service.refresh({ force: true })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network-error')
    // prior snapshot retained in memory
    expect(service.getSnapshot()?.models['moonshotai/kimi-k3']).toBeDefined()
  })

  it('keeps the prior provider list when the provider-list fetch fails (models still succeed)', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot()))
    await service.ensureLoaded()

    fetchFn.mockImplementation((url: string) => {
      if (String(url).includes('models.json')) {
        return Promise.resolve(mockResponse({ text: JSON.stringify(RAW_CANONICAL_FIXTURE) }))
      }
      return Promise.reject(new Error('provider list down'))
    })
    const result = await service.refresh({ force: true })

    // Canonical model facts succeed; the prior provider list is retained.
    expect(result).toEqual({ ok: true, fetchedAt: 1_000_000 })
    expect(service.getSnapshot()?.models['moonshotai/kimi-k3']).toBeDefined()
    expect(service.getSnapshot()?.providers).toEqual({ anthropic: { api: '', name: 'Anthropic' } })
  })

  it('rejects oversize responses via content-length and via body size', async () => {
    const { service, fetchFn } = makeService()
    fetchFn.mockResolvedValue(
      mockResponse({ headers: { 'content-type': 'application/json', 'content-length': '999999999' }, text: '{}' })
    )
    expect((await service.refresh({ force: true })).reason).toBe('response-too-large')
    expect(service.getSnapshot()).toBeNull()

    fetchFn.mockResolvedValue(mockResponse({ text: 'x'.repeat(11 * 1024 * 1024) }))
    expect((await service.refresh({ force: true })).reason).toBe('response-too-large')
  })

  it('enforces the body cap in UTF-8 bytes, not JS string length', async () => {
    const { service, fetchFn } = makeService({ maxBytes: 10 })
    // 6 chars but 12 UTF-8 bytes: string length passes, byte length must fail
    fetchFn.mockResolvedValue(mockResponse({ text: 'é'.repeat(6) }))
    expect((await service.refresh({ force: true })).reason).toBe('response-too-large')
    expect(service.getSnapshot()).toBeNull()

    // an ASCII body within the byte cap proceeds to JSON parsing
    fetchFn.mockResolvedValue(mockResponse({ text: '[]' }))
    expect((await service.refresh({ force: true })).reason).toBe('schema-mismatch')
  })

  it('rejects unexpected content-type, http errors, invalid json, and schema mismatch', async () => {
    const { service, fetchFn } = makeService()

    fetchFn.mockResolvedValue(mockResponse({ headers: { 'content-type': 'text/html' }, text: '<html>' }))
    expect((await service.refresh({ force: true })).reason).toBe('unexpected-content-type')

    fetchFn.mockResolvedValue(mockResponse({ status: 500, ok: false, text: 'err' }))
    expect((await service.refresh({ force: true })).reason).toBe('http-error')

    fetchFn.mockResolvedValue(mockResponse({ text: 'not json{' }))
    expect((await service.refresh({ force: true })).reason).toBe('invalid-json')

    // valid JSON but no usable canonical models: retain prior (null) instead of persisting emptiness
    fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify({}) }))
    expect((await service.refresh({ force: true })).reason).toBe('schema-mismatch')
    expect(service.getSnapshot()).toBeNull()
  })

  it('keeps memory snapshot when the atomic cache write fails', async () => {
    const { service, fetchFn, writeCacheFileAtomic } = makeService()
    mockBothSuccess(fetchFn)
    writeCacheFileAtomic.mockRejectedValue(new Error('disk full'))

    const result = await service.refresh({ force: true })
    expect(result.ok).toBe(true)
    expect(service.getSnapshot()).not.toBeNull()
  })

  it('honors ETag 304 by advancing staleness without replacing the snapshot', async () => {
    const { service, fetchFn, readCacheFile, writeCacheFileAtomic } = makeService()
    readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot(), '"v1"'))
    await service.ensureLoaded()
    const before = service.getSnapshot()!

    fetchFn.mockResolvedValue(mockResponse({ status: 304, ok: false, text: '' }))
    const result = await service.refresh({ force: true })
    expect(result).toEqual({ ok: true, fetchedAt: 1_000_000, notModified: true })
    // revalidation sent the stored ETag on the canonical fetch
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ headers: { 'If-None-Match': '"v1"' } })
    expect(service.getSnapshot()?.models).toEqual(before.models)
    expect(service.getSnapshot()?.fetchedAt).toBe(1_000_000)
    expect(writeCacheFileAtomic).toHaveBeenCalledTimes(1)
  })

  it('skips refresh within 24h unless forced', async () => {
    const { service, fetchFn } = makeService()
    mockBothSuccess(fetchFn)
    await service.refresh({ force: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)

    const fresh = await service.refresh()
    expect(fresh).toEqual({ ok: true, fetchedAt: 1_000_000, reason: 'fresh-cache' })
    expect(fetchFn).toHaveBeenCalledTimes(2)

    await service.refresh({ force: true })
    expect(fetchFn).toHaveBeenCalledTimes(4)
  })

  it('treats snapshots older than 24h as stale', () => {
    const { service } = makeService({ now: () => 500_000 + MODEL_METADATA_REFRESH_INTERVAL_MS + 1 })
    expect(service.shouldRefresh()).toBe(true)
  })
})

describe('ModelMetadataService loading semantics', () => {
  it('loads last-known-good from disk once; corrupt cache stays empty without throwing', async () => {
    const { service, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot()))
    await service.ensureLoaded()
    await service.ensureLoaded()
    expect(readCacheFile).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()?.source).toBe('models.dev')

    const broken = makeService()
    broken.readCacheFile.mockResolvedValue('{{{not json')
    await expect(broken.service.ensureLoaded()).resolves.toBeNull()
    expect(broken.service.getSnapshot()).toBeNull()
  })

  it('rejects cache envelopes with a non-current version (v1/v2 caches)', async () => {
    const { service, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(JSON.stringify({ version: 1, fetchedAt: 1, snapshot: diskSnapshot() }))
    await expect(service.ensureLoaded()).resolves.toBeNull()
    expect(service.getSnapshot()).toBeNull()
    const { service: service2, readCacheFile: readCacheFile2 } = makeService()
    readCacheFile2.mockResolvedValue(JSON.stringify({ version: 2, fetchedAt: 1, snapshot: diskSnapshot() }))
    await expect(service2.ensureLoaded()).resolves.toBeNull()
    expect(service2.getSnapshot()).toBeNull()
  })

  it('getSnapshotWithStaleRefresh returns memory immediately and refreshes stale data in background', async () => {
    // seeded snapshot is stale (now is past fetchedAt + 24h)
    const stale = makeService({ now: () => 500_000 + MODEL_METADATA_REFRESH_INTERVAL_MS + 1 })
    stale.readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot()))
    mockBothSuccess(stale.fetchFn)
    await stale.service.ensureLoaded()

    const immediate = stale.service.getSnapshotWithStaleRefresh()
    expect(immediate?.models['moonshotai/kimi-k3']).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stale.fetchFn).toHaveBeenCalled()
  })

  it('returns null quickly when nothing is loaded and kicks off load+refresh', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot()))
    mockBothSuccess(fetchFn)

    expect(service.getSnapshotWithStaleRefresh()).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // disk loaded in background; snapshot available without blocking the caller
    expect(service.getSnapshot()).not.toBeNull()
  })
})

describe('ModelMetadataService status machine', () => {
  it('is loading before the first load completes', () => {
    const { service } = makeService()
    expect(service.getStatus()).toEqual({ kind: 'loading', snapshot: null })
  })

  it('converges loading -> ready on the first success without a restart', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockRejectedValue(new Error('no cache'))
    await service.ensureLoaded()
    expect(service.getStatus().kind).toBe('loading')

    mockBothSuccess(fetchFn)
    await service.refresh({ force: true })
    const ready = service.getStatus()
    expect(ready.kind).toBe('ready')
    expect(ready.snapshot?.source).toBe('models.dev')
    expect(ready.snapshot?.models['moonshotai/kimi-k3']).toBeDefined()
    expect(ready.reason).toBeUndefined()
  })

  it('converges loading -> unavailable on a completed failure without a snapshot', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockRejectedValue(new Error('no cache'))
    await service.ensureLoaded()
    expect(service.getStatus().kind).toBe('loading')

    fetchFn.mockRejectedValue(new Error('boom'))
    await service.refresh({ force: true })
    expect(service.getStatus()).toEqual({ kind: 'unavailable', snapshot: null, reason: 'network-error' })
  })

  it('is ready after a successful refresh and stays ready across a later failure', async () => {
    const { service, fetchFn } = makeService()
    mockBothSuccess(fetchFn)
    await service.refresh({ force: true })
    const ready = service.getStatus()
    expect(ready.kind).toBe('ready')
    expect(ready.snapshot?.source).toBe('models.dev')
    expect(ready.reason).toBeUndefined()

    fetchFn.mockRejectedValue(new Error('boom'))
    const failed = await service.refresh({ force: true })
    expect(failed.ok).toBe(false)
    // the failed refresh retains last-known-good: still ready, no reason leak
    const stillReady = service.getStatus()
    expect(stillReady.kind).toBe('ready')
    expect(stillReady.snapshot?.source).toBe('models.dev')
    expect(stillReady.reason).toBeUndefined()
  })

  it('is unavailable with a sanitized reason when the round completes without a snapshot', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockRejectedValue(new Error('no cache'))
    await service.ensureLoaded()
    fetchFn.mockRejectedValue(new Error('boom'))
    await service.refresh({ force: true })
    expect(service.getStatus()).toEqual({ kind: 'unavailable', snapshot: null, reason: 'network-error' })
  })

  it('recovers from unavailable to ready on the next success', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockRejectedValue(new Error('no cache'))
    await service.ensureLoaded()
    fetchFn.mockRejectedValue(new Error('boom'))
    await service.refresh({ force: true })
    expect(service.getStatus().kind).toBe('unavailable')

    mockBothSuccess(fetchFn)
    await service.refresh({ force: true })
    const recovered = service.getStatus()
    expect(recovered.kind).toBe('ready')
    expect(recovered.snapshot).not.toBeNull()
    expect(recovered.reason).toBeUndefined()
  })
})

describe('registerModelMetadataIpc', () => {
  it('registers the snapshot, refresh, and status channels in Main house style', () => {
    const { service } = makeService()
    registerModelMetadataIpc(service)
    expect(ipcMain.handle).toHaveBeenCalledWith(IpcChannel.ModelMetadata_GetSnapshot, expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith(IpcChannel.ModelMetadata_Refresh, expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith(IpcChannel.ModelMetadata_GetStatus, expect.any(Function))
    expect(IpcChannel.ModelMetadata_GetSnapshot).toBe('model-metadata:get-snapshot')
    expect(IpcChannel.ModelMetadata_Refresh).toBe('model-metadata:refresh')
    expect(IpcChannel.ModelMetadata_GetStatus).toBe('model-metadata:get-status')
  })
})
