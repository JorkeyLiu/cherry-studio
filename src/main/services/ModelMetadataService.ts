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
  MODEL_METADATA_PROVIDER_SOURCES_ENDPOINT,
  MODEL_METADATA_REFRESH_INTERVAL_MS,
  type ModelMetadataRefreshReason,
  type ModelMetadataRefreshResult,
  type ModelMetadataSnapshot,
  type ModelMetadataStatus,
  normalizeCanonicalModelsPayload,
  type NormalizedProviderSource,
  normalizeProviderSourcesPayload,
  parseModelMetadataCache,
  toModelMetadataStatus
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
  /** UTF-8 byte cap per fetched body (default MODEL_METADATA_MAX_BYTES). */
  maxBytes?: number
}

async function defaultReadCacheFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8')
}

async function defaultWriteCacheFileAtomic(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeWithLock(filePath, data, { atomic: true })
}

type FetchJsonOutcome =
  | { status: 'ok'; body: unknown; etag?: string }
  | { status: 'not-modified' }
  | { status: 'failure'; reason: ModelMetadataRefreshReason; detail?: string }

/**
 * Main-owned models.dev metadata service (enrichment only).
 *
 * - Canonical model facts come from `models.json` (flat canonical id ->
 *   model map); the snapshot carries them in `snapshot.models`.
 * - `snapshot.providers` is the minimal provider-source list from `api.json`
 *   (`api` + `name` only, no model facts) and exists solely for
 *   connection-logo attribution. Model metadata and model logos never read
 *   it. A provider-list failure is best-effort: the prior list is retained
 *   (or stays empty) while canonical model facts still succeed.
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
  private lastFailureReason: ModelMetadataRefreshReason | undefined = undefined
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
   * Reactive registry status for the models.dev enrichment surface.
   *
   * - `loading`: no snapshot yet and a disk read/fetch is still in progress
   *   (including before the first load completes).
   * - `ready`: a snapshot is available; a failed refresh stays ready.
   * - `unavailable`: no snapshot and the last read/fetch round completed
   *   with a sanitized failure reason. Never exposes raw responses or paths.
   */
  getStatus(): ModelMetadataStatus {
    return toModelMetadataStatus({
      snapshot: this.snapshot,
      inFlight: this.inFlight !== null || !this.diskLoaded,
      failureReason: this.lastFailureReason
    })
  }

  /**
   * Best-effort one-time disk load of the last-known-good envelope. Never
   * throws; a missing/corrupt cache simply leaves the memory snapshot empty.
   * v1 (api.json-shaped) caches are rejected by the v2 envelope literal.
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
    if (reason && reason !== 'fresh-cache' && reason !== 'not-modified') {
      this.lastFailureReason = reason
    }
    return { ok: false, reason }
  }

  /**
   * Single bounded JSON fetch with sanitized failure reasons. Never throws;
   * the body is parsed but not normalized — callers validate the shape.
   */
  private async fetchJson(url: string, etag?: string): Promise<FetchJsonOutcome> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), MODEL_METADATA_FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.deps.fetchFn(
        url,
        etag
          ? { headers: { Accept: 'application/json', 'If-None-Match': etag }, signal: controller.signal }
          : { headers: { Accept: 'application/json' }, signal: controller.signal }
      )
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const reason = name === 'AbortError' ? 'timeout' : 'network-error'
      return { status: 'failure', reason }
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 304) {
      return { status: 'not-modified' }
    }

    if (!response.ok) {
      return { status: 'failure', reason: 'http-error', detail: `status ${response.status}` }
    }

    const contentType = response.headers?.get?.('content-type') ?? ''
    if (!contentType.toLowerCase().includes('json')) {
      return { status: 'failure', reason: 'unexpected-content-type' }
    }

    const contentLength = Number(response.headers?.get?.('content-length') ?? NaN)
    if (Number.isFinite(contentLength) && contentLength > this.deps.maxBytes) {
      return { status: 'failure', reason: 'response-too-large' }
    }

    let text: string
    try {
      text = await response.text()
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      return { status: 'failure', reason: name === 'AbortError' ? 'timeout' : 'network-error' }
    }
    // Enforced in UTF-8 bytes: multi-byte bodies can otherwise exceed the cap
    // while staying under it in JS string (UTF-16 unit) length.
    if (Buffer.byteLength(text, 'utf8') > this.deps.maxBytes) {
      return { status: 'failure', reason: 'response-too-large' }
    }

    try {
      const body: unknown = JSON.parse(text)
      const responseEtag = response.headers?.get?.('etag') ?? undefined
      return responseEtag !== undefined ? { status: 'ok', body, etag: responseEtag } : { status: 'ok', body }
    } catch {
      return { status: 'failure', reason: 'invalid-json' }
    }
  }

  private async doRefresh(): Promise<ModelMetadataRefreshResult> {
    const fetchedAt = this.deps.now()
    const etag = this.snapshot?.etag
    const modelsOutcome = await this.fetchJson(MODEL_METADATA_ENDPOINT, etag)

    if (modelsOutcome.status === 'not-modified') {
      // ETag revalidated: the snapshot is still current; advance its
      // timestamp so the 24h staleness check does not refetch in a loop.
      if (this.snapshot) {
        this.snapshot = { ...this.snapshot, fetchedAt }
        this.lastFailureReason = undefined
        await this.persistBestEffort()
        return { ok: true, fetchedAt, notModified: true }
      }
      return this.fail('http-error', 'unexpected 304 without snapshot')
    }

    if (modelsOutcome.status === 'failure') {
      return this.fail(modelsOutcome.reason, modelsOutcome.detail)
    }

    const canonical = normalizeCanonicalModelsPayload(modelsOutcome.body)
    if (!canonical || Object.keys(canonical).length === 0) {
      // An empty canonical map carries no enrichment value; retaining the
      // prior last-known-good is strictly safer than persisting emptiness.
      return this.fail('schema-mismatch')
    }

    // Provider-source list (connection logos only) is best-effort: a failure
    // retains the prior list (or stays empty) while canonical model facts
    // still succeed. Model metadata and model logos never read this list.
    let providers: Record<string, NormalizedProviderSource> = this.snapshot?.providers ?? {}
    const providersOutcome = await this.fetchJson(MODEL_METADATA_PROVIDER_SOURCES_ENDPOINT)
    if (providersOutcome.status === 'ok') {
      const normalized = normalizeProviderSourcesPayload(providersOutcome.body)
      if (normalized) {
        providers = normalized
      } else {
        logger.warn('model metadata provider list failed validation; retaining prior list')
      }
    } else if (providersOutcome.status === 'failure') {
      logger.warn(`model metadata provider list refresh failed: ${providersOutcome.reason}; retaining prior list`)
    }
    // A 304 for the unconditioned provider list cannot occur (no ETag sent).

    this.snapshot = {
      source: 'models.dev',
      fetchedAt,
      ...(modelsOutcome.etag !== undefined ? { etag: modelsOutcome.etag } : {}),
      models: canonical,
      providers
    }
    this.lastFailureReason = undefined
    await this.persistBestEffort()
    logger.info('model metadata refreshed', { models: Object.keys(canonical).length })
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
 * in the background; `refresh` forces a manual refresh; `getStatus` returns
 * the reactive loading/ready/unavailable status. All resolve sanitized
 * payloads only — never raw responses or filesystem paths.
 */
export function registerModelMetadataIpc(service: ModelMetadataService = modelMetadataService): void {
  ipcMain.handle(IpcChannel.ModelMetadata_GetSnapshot, () => service.getSnapshotWithStaleRefresh())
  ipcMain.handle(IpcChannel.ModelMetadata_Refresh, () => service.refresh({ force: true }))
  ipcMain.handle(IpcChannel.ModelMetadata_GetStatus, () => service.getStatus())
}
