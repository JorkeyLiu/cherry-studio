import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import {
  MODEL_METADATA_CACHE_REL_PATH,
  MODEL_METADATA_CACHE_VERSION,
  MODEL_METADATA_ENDPOINT,
  MODEL_METADATA_FETCH_TIMEOUT_MS,
  MODEL_METADATA_MAX_BYTES,
  MODEL_METADATA_REFRESH_INTERVAL_MS,
  type ModelMetadataRefreshResult,
  type ModelMetadataSnapshot,
  normalizeModelMetadataPayload,
  parseModelMetadataCache
} from '@shared/modelMetadata'
import { ipcMain } from 'electron'

import { getCacheDir, writeWithLock } from '../utils/file'

const logger = loggerService.withContext('ModelMetadataService')

export interface ModelMetadataServiceDeps {
  fetchFn?: typeof fetch
  readCacheFile?: (filePath: string) => Promise<string>
  writeCacheFileAtomic?: (filePath: string, data: string) => Promise<void>
  cacheFilePath?: string
  now?: () => number
  /** UTF-8 byte cap for the fetched body (default MODEL_METADATA_MAX_BYTES). */
  maxBytes?: number
}

async function defaultReadCacheFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8')
}

async function defaultWriteCacheFileAtomic(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeWithLock(filePath, data, { atomic: true })
}

/**
 * Main-owned models.dev metadata service (enrichment only).
 *
 * - Cache lives under the existing userData Cache convention and holds the
 *   last-known-good normalized snapshot; it never touches the `llm` store.
 * - Startup and request paths never fail because of this service: refresh
 *   failures retain the prior memory/disk snapshot and are logged with a
 *   sanitized reason (status/reason only — never bodies or file paths).
 * - No recurring timer: staleness is evaluated on access (`refreshIfStale`)
 *   and refreshes run in the background, at most once per 24h.
 */
export class ModelMetadataService {
  private snapshot: ModelMetadataSnapshot | null = null
  private diskLoaded = false
  private inFlight: Promise<ModelMetadataRefreshResult> | null = null
  private readonly deps: Required<Omit<ModelMetadataServiceDeps, 'cacheFilePath'>> & { cacheFilePath?: string }

  constructor(deps: ModelMetadataServiceDeps = {}) {
    this.deps = {
      fetchFn: deps.fetchFn ?? fetch,
      readCacheFile: deps.readCacheFile ?? defaultReadCacheFile,
      writeCacheFileAtomic: deps.writeCacheFileAtomic ?? defaultWriteCacheFileAtomic,
      now: deps.now ?? Date.now,
      maxBytes: deps.maxBytes ?? MODEL_METADATA_MAX_BYTES,
      ...(deps.cacheFilePath ? { cacheFilePath: deps.cacheFilePath } : {})
    }
  }

  private cacheFilePath(): string {
    return this.deps.cacheFilePath ?? path.join(getCacheDir(), MODEL_METADATA_CACHE_REL_PATH)
  }

  /** Synchronous in-memory read. Null when no last-known-good is loaded yet. */
  getSnapshot(): ModelMetadataSnapshot | null {
    return this.snapshot
  }

  /**
   * Best-effort one-time disk load of the last-known-good envelope. Never
   * throws; a missing/corrupt cache simply leaves the memory snapshot empty.
   */
  async ensureLoaded(): Promise<ModelMetadataSnapshot | null> {
    if (this.snapshot || this.diskLoaded) return this.snapshot
    this.diskLoaded = true
    try {
      const raw = await this.deps.readCacheFile(this.cacheFilePath())
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        logger.warn('model metadata cache is not valid JSON; ignoring')
        return null
      }
      const cached = parseModelMetadataCache(parsed)
      if (!cached) {
        logger.warn('model metadata cache failed validation; ignoring')
        return null
      }
      this.snapshot = cached.snapshot
      return this.snapshot
    } catch (error) {
      logger.debug('model metadata cache unavailable', error as Error)
      return null
    }
  }

  /** True when there is no snapshot or the snapshot is older than 24h. */
  shouldRefresh(now: number = this.deps.now()): boolean {
    if (!this.snapshot) return true
    return now - this.snapshot.fetchedAt >= MODEL_METADATA_REFRESH_INTERVAL_MS
  }

  /**
   * Startup hook: load last-known-good, then refresh in the background when
   * stale. Never throws and never blocks startup.
   */
  async init(): Promise<void> {
    try {
      await this.ensureLoaded()
    } catch {
      // ensureLoaded never throws; defensive only.
    }
    void this.refreshIfStale()
  }

  /**
   * Background-safe stale refresh: dedupes concurrent callers, swallows all
   * failures (logged, sanitized), and never rejects.
   */
  async refreshIfStale(): Promise<void> {
    if (!this.shouldRefresh()) return
    try {
      await this.refresh()
    } catch (error) {
      logger.warn('model metadata background refresh failed', error as Error)
    }
  }

  /**
   * Synchronous IPC-facing read: returns the loaded last-known-good
   * immediately and triggers a stale refresh in the background; when nothing
   * is loaded yet it returns null quickly while kicking off the load+refresh.
   * Never exposes raw responses or filesystem paths.
   */
  getSnapshotWithStaleRefresh(): ModelMetadataSnapshot | null {
    const snapshot = this.snapshot
    if (!snapshot && !this.diskLoaded) {
      void this.ensureLoaded().then(() => this.refreshIfStale())
      return null
    }
    void this.refreshIfStale()
    return snapshot
  }

  /**
   * Fetch, validate, normalize, and persist. Concurrent callers share one
   * in-flight refresh. Failure retains the prior memory/disk snapshot and
   * returns/logs a sanitized reason.
   */
  async refresh(options: { force?: boolean } = {}): Promise<ModelMetadataRefreshResult> {
    if (this.inFlight) return this.inFlight
    if (!options.force && !this.shouldRefresh()) {
      return { ok: true, fetchedAt: this.snapshot?.fetchedAt, reason: 'fresh-cache' }
    }
    this.inFlight = this.doRefresh()
    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private fail(reason: ModelMetadataRefreshResult['reason'], detail?: string): ModelMetadataRefreshResult {
    if (detail) {
      logger.warn(`model metadata refresh failed: ${reason}`, { reason, detail })
    } else {
      logger.warn(`model metadata refresh failed: ${reason}`)
    }
    return { ok: false, reason }
  }

  private async doRefresh(): Promise<ModelMetadataRefreshResult> {
    const fetchedAt = this.deps.now()
    const etag = this.snapshot?.etag
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), MODEL_METADATA_FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.deps.fetchFn(
        MODEL_METADATA_ENDPOINT,
        etag
          ? { headers: { Accept: 'application/json', 'If-None-Match': etag }, signal: controller.signal }
          : { headers: { Accept: 'application/json' }, signal: controller.signal }
      )
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      return this.fail(name === 'AbortError' ? 'timeout' : 'network-error')
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 304) {
      // ETag revalidated: the snapshot is still current; advance its
      // timestamp so the 24h staleness check does not refetch in a loop.
      if (this.snapshot) {
        this.snapshot = { ...this.snapshot, fetchedAt }
        await this.persistBestEffort()
        return { ok: true, fetchedAt, notModified: true }
      }
      return this.fail('http-error', 'unexpected 304 without snapshot')
    }

    if (!response.ok) {
      return this.fail('http-error', `status ${response.status}`)
    }

    const contentType = response.headers?.get?.('content-type') ?? ''
    if (!contentType.toLowerCase().includes('json')) {
      return this.fail('unexpected-content-type')
    }

    const contentLength = Number(response.headers?.get?.('content-length') ?? NaN)
    if (Number.isFinite(contentLength) && contentLength > this.deps.maxBytes) {
      return this.fail('response-too-large')
    }

    let text: string
    try {
      text = await response.text()
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      return this.fail(name === 'AbortError' ? 'timeout' : 'network-error')
    }
    // Enforced in UTF-8 bytes: multi-byte bodies can otherwise exceed the cap
    // while staying under it in JS string (UTF-16 unit) length.
    if (Buffer.byteLength(text, 'utf8') > this.deps.maxBytes) {
      return this.fail('response-too-large')
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return this.fail('invalid-json')
    }

    const responseEtag = response.headers?.get?.('etag') ?? undefined
    const snapshot = normalizeModelMetadataPayload(raw, fetchedAt, responseEtag)
    if (!snapshot || Object.keys(snapshot.providers).length === 0) {
      // An empty provider map carries no enrichment value; retaining the
      // prior last-known-good is strictly safer than persisting emptiness.
      return this.fail('schema-mismatch')
    }

    this.snapshot = snapshot
    await this.persistBestEffort()
    logger.info('model metadata refreshed', { providers: Object.keys(snapshot.providers).length })
    return { ok: true, fetchedAt }
  }

  private async persistBestEffort(): Promise<void> {
    if (!this.snapshot) return
    try {
      const envelope = JSON.stringify({
        version: MODEL_METADATA_CACHE_VERSION,
        fetchedAt: this.snapshot.fetchedAt,
        ...(this.snapshot.etag ? { etag: this.snapshot.etag } : {}),
        snapshot: this.snapshot
      })
      await this.deps.writeCacheFileAtomic(this.cacheFilePath(), envelope)
    } catch (error) {
      // Disk persistence is best-effort: memory stays authoritative for this
      // session and the next startup simply refetches.
      logger.warn('model metadata cache write failed; memory snapshot retained', error as Error)
    }
  }
}

export const modelMetadataService = new ModelMetadataService()

/**
 * Main house-style IPC registration (called from central src/main/ipc.ts).
 * `getSnapshot` returns last-known-good immediately and refreshes stale data
 * in the background; `refresh` forces a manual refresh. Both resolve sanitized
 * payloads only — never raw responses or filesystem paths.
 */
export function registerModelMetadataIpc(service: ModelMetadataService = modelMetadataService): void {
  ipcMain.handle(IpcChannel.ModelMetadata_GetSnapshot, () => service.getSnapshotWithStaleRefresh())
  ipcMain.handle(IpcChannel.ModelMetadata_Refresh, () => service.refresh({ force: true }))
}
