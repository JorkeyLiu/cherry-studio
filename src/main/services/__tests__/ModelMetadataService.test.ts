import { IpcChannel } from '@shared/IpcChannel'
import { MODEL_METADATA_REFRESH_INTERVAL_MS } from '@shared/modelMetadata'
import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ModelMetadataService, registerModelMetadataIpc } from '../ModelMetadataService'

const RAW_FIXTURE = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        attachment: false,
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }],
        tool_call: true,
        temperature: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 128000 },
        cost: { input: 3, output: 15, cache_read: 0.3 }
      },
      'legacy-unknown': { id: 'legacy-unknown', name: 'Legacy' }
    }
  }
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
    cacheFilePath: '/cache/model-metadata/models-dev.json',
    now: () => 1_000_000,
    ...overrides
  })
  return { service, fetchFn, readCacheFile, writeCacheFileAtomic }
}

function diskEnvelope(snapshot: unknown, etag?: string) {
  return JSON.stringify({
    version: 1,
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
    providers: {
      anthropic: { api: '', name: 'Anthropic', models: { 'known-cached': { id: 'known-cached' } } }
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ModelMetadataService refresh', () => {
  it('normalizes upstream payload (absent vs false, reasoning controls) and persists atomically', async () => {
    const { service, fetchFn, writeCacheFileAtomic } = makeService()
    fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify(RAW_FIXTURE) }))

    const result = await service.refresh({ force: true })

    expect(result).toEqual({ ok: true, fetchedAt: 1_000_000 })
    const snapshot = service.getSnapshot()!
    expect(snapshot.providers['anthropic'].models['claude-sonnet-4-6']).toMatchObject({
      id: 'claude-sonnet-4-6',
      attachment: false,
      toolCall: true,
      reasoning: true,
      temperature: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoningControls: { toggle: true, budget: true },
      limits: { context: 1000000, output: 128000 },
      pricing: { input: 3, output: 15, cacheRead: 0.3 }
    })
    // absent optional fields stay unknown, not false
    const legacy = snapshot.providers['anthropic'].models['legacy-unknown']
    expect(legacy.attachment).toBeUndefined()
    expect(legacy.toolCall).toBeUndefined()
    expect(legacy.reasoning).toBeUndefined()

    expect(writeCacheFileAtomic).toHaveBeenCalledTimes(1)
    const [filePath, data] = writeCacheFileAtomic.mock.calls[0]
    expect(filePath).toBe('/cache/model-metadata/models-dev.json')
    const envelope = JSON.parse(data)
    expect(envelope.version).toBe(1)
    expect(envelope.snapshot.source).toBe('models.dev')
    expect(envelope.snapshot.providers['anthropic'].models['claude-sonnet-4-6'].id).toBe('claude-sonnet-4-6')
  })

  it('retains last-known-good memory/disk snapshot when fetch fails', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot()))
    await service.ensureLoaded()
    expect(service.getSnapshot()?.providers['anthropic'].models['known-cached']).toBeDefined()

    fetchFn.mockRejectedValue(new Error('boom'))
    const result = await service.refresh({ force: true })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network-error')
    // prior snapshot retained in memory
    expect(service.getSnapshot()?.providers['anthropic'].models['known-cached']).toBeDefined()
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
    fetchFn.mockResolvedValue(mockResponse({ text: '{"a":{}}' }))
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

    // valid JSON but no usable providers: retain prior (null) instead of persisting emptiness
    fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify({}) }))
    expect((await service.refresh({ force: true })).reason).toBe('schema-mismatch')
    expect(service.getSnapshot()).toBeNull()
  })

  it('keeps memory snapshot when the atomic cache write fails', async () => {
    const { service, fetchFn, writeCacheFileAtomic } = makeService()
    fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify(RAW_FIXTURE) }))
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
    // revalidation sent the stored ETag
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ headers: { 'If-None-Match': '"v1"' } })
    expect(service.getSnapshot()?.providers).toEqual(before.providers)
    expect(service.getSnapshot()?.fetchedAt).toBe(1_000_000)
    expect(writeCacheFileAtomic).toHaveBeenCalledTimes(1)
  })

  it('skips refresh within 24h unless forced', async () => {
    const { service, fetchFn } = makeService()
    fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify(RAW_FIXTURE) }))
    await service.refresh({ force: true })
    expect(fetchFn).toHaveBeenCalledTimes(1)

    const fresh = await service.refresh()
    expect(fresh).toEqual({ ok: true, fetchedAt: 1_000_000, reason: 'fresh-cache' })
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await service.refresh({ force: true })
    expect(fetchFn).toHaveBeenCalledTimes(2)
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

  it('rejects cache envelopes with a non-current version', async () => {
    const { service, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(JSON.stringify({ version: 2, fetchedAt: 1, snapshot: diskSnapshot() }))
    await expect(service.ensureLoaded()).resolves.toBeNull()
    expect(service.getSnapshot()).toBeNull()
  })

  it('getSnapshotWithStaleRefresh returns memory immediately and refreshes stale data in background', async () => {
    // seeded snapshot is stale (now is past fetchedAt + 24h)
    const stale = makeService({ now: () => 500_000 + MODEL_METADATA_REFRESH_INTERVAL_MS + 1 })
    stale.readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot()))
    stale.fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify(RAW_FIXTURE) }))
    await stale.service.ensureLoaded()

    const immediate = stale.service.getSnapshotWithStaleRefresh()
    expect(immediate?.providers['anthropic'].models['known-cached']).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stale.fetchFn).toHaveBeenCalledTimes(1)
  })

  it('returns null quickly when nothing is loaded and kicks off load+refresh', async () => {
    const { service, fetchFn, readCacheFile } = makeService()
    readCacheFile.mockResolvedValue(diskEnvelope(diskSnapshot()))
    fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify(RAW_FIXTURE) }))

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

  it('is ready after a successful refresh and stays ready across a later failure', async () => {
    const { service, fetchFn } = makeService()
    fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify(RAW_FIXTURE) }))
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

    fetchFn.mockResolvedValue(mockResponse({ text: JSON.stringify(RAW_FIXTURE) }))
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
