import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import {
  buildProviderLogoUrl,
  isSafeLogoSourceId,
  isSafeProviderSvg,
  parseProviderLogoCache,
  PROVIDER_LOGO_CACHE_REL_PATH,
  PROVIDER_LOGO_CACHE_VERSION,
  PROVIDER_LOGO_FETCH_TIMEOUT_MS,
  PROVIDER_LOGO_MAX_BYTES,
  PROVIDER_LOGO_MAX_SOURCES_PER_REQUEST,
  PROVIDER_LOGO_REFRESH_INTERVAL_MS,
  type ProviderLogoEntry,
  type ProviderLogoResult
} from '@shared/providerLogo'
import { ipcMain } from 'electron'

import { getCacheDir, writeWithLock } from '../utils/file'

const logger = loggerService.withContext('ProviderLogoService')

export interface ProviderLogoServiceDeps {
  fetchFn?: typeof fetch
  readCacheFile?: (filePath: string) => Promise<string>
  writeCacheFileAtomic?: (filePath: string, data: string) => Promise<void>
  cacheFilePath?: string
  now?: () => number
  maxBytes?: number
  fetchTimeoutMs?: number
  getKnownSources?: () => string[] | null
}

async function defaultReadCacheFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8')
}

async function defaultWriteCacheFileAtomic(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeWithLock(filePath, data, { atomic: true })
}

/**
 * Main-owned models.dev provider-logo service (enhancement only).
 *
 * - Only exact models.dev sources are fetchable. The renderer resolves the
 *   source via the existing exact `resolveMetadataSource` contract; Main
 *   refuses unsafe source strings and — when a known-source gate is wired —
 *   refuses sources absent from the last-known-good metadata snapshot. HTTP
 *   status is never the admission gate because models.dev serves a default
 *   SVG for unknown ids.
 * - SVG is required and unsafe constructs are rejected; failures retain the
 *   prior last-known-good entry and never throw to callers.
 */
export class ProviderLogoService {
  private readonly logos = new Map<string, ProviderLogoEntry>()
  private diskLoaded = false
  private readonly inFlight = new Map<string, Promise<ProviderLogoResult | null>>()
  private readonly deps: Required<Omit<ProviderLogoServiceDeps, 'cacheFilePath' | 'getKnownSources'>> & {
    cacheFilePath?: string
    getKnownSources?: () => string[] | null
  }

  constructor(deps: ProviderLogoServiceDeps = {}) {
    this.deps = {
      fetchFn: deps.fetchFn ?? fetch,
      readCacheFile: deps.readCacheFile ?? defaultReadCacheFile,
      writeCacheFileAtomic: deps.writeCacheFileAtomic ?? defaultWriteCacheFileAtomic,
      now: deps.now ?? Date.now,
      maxBytes: deps.maxBytes ?? PROVIDER_LOGO_MAX_BYTES,
      fetchTimeoutMs: deps.fetchTimeoutMs ?? PROVIDER_LOGO_FETCH_TIMEOUT_MS,
      ...(deps.cacheFilePath ? { cacheFilePath: deps.cacheFilePath } : {}),
      ...(deps.getKnownSources ? { getKnownSources: deps.getKnownSources } : {})
    }
  }

  private cacheFilePath(): string {
    return this.deps.cacheFilePath ?? path.join(getCacheDir(), PROVIDER_LOGO_CACHE_REL_PATH)
  }

  getCachedLogo(source: string): ProviderLogoResult | null {
    if (!isSafeLogoSourceId(source)) return null
    const entry = this.logos.get(source)
    if (!entry) return null
    return entry.etag !== undefined
      ? { source, svg: entry.svg, fetchedAt: entry.fetchedAt, etag: entry.etag }
      : { source, svg: entry.svg, fetchedAt: entry.fetchedAt }
  }

  getCachedLogos(sources: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const source of sources.slice(0, PROVIDER_LOGO_MAX_SOURCES_PER_REQUEST)) {
      const cached = this.getCachedLogo(source)
      if (cached) out[source] = cached.svg
    }
    return out
  }

  private isKnownSource(source: string): boolean {
    const gate = this.deps.getKnownSources
    if (!gate) return true
    try {
      const known = gate()
      if (known === null) return false
      return known.includes(source)
    } catch {
      return false
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.diskLoaded) return
    this.diskLoaded = true
    try {
      const raw = await this.deps.readCacheFile(this.cacheFilePath())
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        logger.warn('provider logo cache is not valid JSON; ignoring')
        return
      }
      const cached = parseProviderLogoCache(parsed)
      if (!cached) {
        logger.warn('provider logo cache failed validation; ignoring')
        return
      }
      for (const [source, entry] of Object.entries(cached.logos)) {
        this.logos.set(source, entry)
      }
    } catch (error) {
      logger.debug('provider logo cache unavailable', error as Error)
    }
  }

  shouldRefresh(source: string, now: number = this.deps.now()): boolean {
    const entry = this.logos.get(source)
    if (!entry) return true
    return now - entry.fetchedAt >= PROVIDER_LOGO_REFRESH_INTERVAL_MS
  }

  async getLogo(source: string, options: { force?: boolean } = {}): Promise<ProviderLogoResult | null> {
    if (!isSafeLogoSourceId(source)) return null
    await this.ensureLoaded()
    const cached = this.getCachedLogo(source)
    if (cached && !options.force && !this.shouldRefresh(source)) return cached
    if (!this.isKnownSource(source)) return cached
    const pending = this.inFlight.get(source)
    if (pending) return pending
    const task = this.fetchAndCache(source, cached?.etag)
    this.inFlight.set(source, task)
    try {
      const result = await task
      return result ?? cached
    } finally {
      this.inFlight.delete(source)
    }
  }

  async getLogos(sources: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(sources)].filter(isSafeLogoSourceId).slice(0, PROVIDER_LOGO_MAX_SOURCES_PER_REQUEST)
    await this.ensureLoaded()
    const out: Record<string, string> = {}
    await Promise.all(
      unique.map(async (source) => {
        const result = await this.getLogo(source)
        const svg = result?.svg ?? this.logos.get(source)?.svg
        if (svg) out[source] = svg
      })
    )
    return out
  }

  private async fetchAndCache(source: string, etag?: string): Promise<ProviderLogoResult | null> {
    const url = buildProviderLogoUrl(source)
    if (!url) return null
    const fetchedAt = this.deps.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.deps.fetchTimeoutMs)
    let response: Response
    try {
      response = await this.deps.fetchFn(
        url,
        etag
          ? { headers: { Accept: 'image/svg+xml,image/*,*/*', 'If-None-Match': etag }, signal: controller.signal }
          : { headers: { Accept: 'image/svg+xml,image/*,*/*' }, signal: controller.signal }
      )
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      logger.warn(`provider logo fetch failed: ${name === 'AbortError' ? 'timeout' : 'network-error'}`, {
        reason: name === 'AbortError' ? 'timeout' : 'network-error'
      })
      return null
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 304) {
      const existing = this.logos.get(source)
      if (!existing) {
        logger.warn('provider logo refresh failed: http-error')
        return null
      }
      const refreshed: ProviderLogoEntry =
        existing.etag !== undefined
          ? { svg: existing.svg, fetchedAt, etag: existing.etag }
          : { svg: existing.svg, fetchedAt }
      this.logos.set(source, refreshed)
      await this.persistBestEffort()
      return { source, svg: refreshed.svg, fetchedAt, ...(refreshed.etag ? { etag: refreshed.etag } : {}) }
    }

    if (!response.ok) {
      logger.warn('provider logo refresh failed: http-error', { detail: `status ${response.status}` })
      return null
    }

    const contentType = response.headers?.get?.('content-type') ?? ''
    if (contentType && !/svg|xml|image/i.test(contentType)) {
      logger.warn('provider logo refresh failed: unexpected-content-type')
      return null
    }

    const contentLength = Number(response.headers?.get?.('content-length') ?? NaN)
    if (Number.isFinite(contentLength) && contentLength > this.deps.maxBytes) {
      logger.warn('provider logo refresh failed: response-too-large')
      return null
    }

    let text: string
    try {
      text = await response.text()
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      logger.warn(`provider logo body read failed: ${name === 'AbortError' ? 'timeout' : 'network-error'}`)
      return null
    }
    if (Buffer.byteLength(text, 'utf8') > this.deps.maxBytes) {
      logger.warn('provider logo refresh failed: response-too-large')
      return null
    }
    if (!isSafeProviderSvg(text)) {
      logger.warn('provider logo refresh failed: unsafe-or-invalid-svg')
      return null
    }

    const responseEtag = response.headers?.get?.('etag') ?? undefined
    const entry: ProviderLogoEntry =
      responseEtag !== undefined ? { svg: text, fetchedAt, etag: responseEtag } : { svg: text, fetchedAt }
    this.logos.set(source, entry)
    await this.persistBestEffort()
    return { source, svg: text, fetchedAt, ...(responseEtag ? { etag: responseEtag } : {}) }
  }

  private async persistBestEffort(): Promise<void> {
    try {
      const logos: Record<string, ProviderLogoEntry> = {}
      for (const [source, entry] of this.logos) {
        if (!isSafeLogoSourceId(source) || !isSafeProviderSvg(entry.svg)) continue
        logos[source] = entry
      }
      const envelope = JSON.stringify({
        version: PROVIDER_LOGO_CACHE_VERSION,
        fetchedAt: this.deps.now(),
        logos
      })
      await this.deps.writeCacheFileAtomic(this.cacheFilePath(), envelope)
    } catch (error) {
      logger.warn('provider logo cache write failed; memory snapshot retained', error as Error)
    }
  }
  /** Test/prod seam: install the exact-source admission gate after construction. */
  setKnownSourcesGetter(getter: (() => string[] | null) | null): void {
    if (getter) {
      ;(this.deps as { getKnownSources?: () => string[] | null }).getKnownSources = getter
    } else {
      delete (this.deps as { getKnownSources?: () => string[] | null }).getKnownSources
    }
  }
}

export const providerLogoService = new ProviderLogoService()

export function registerProviderLogoIpc(service: ProviderLogoService = providerLogoService): void {
  ipcMain.handle(IpcChannel.ProviderLogo_GetLogo, async (_event, source: unknown) => {
    if (typeof source !== 'string') return null
    return service.getLogo(source)
  })
  ipcMain.handle(IpcChannel.ProviderLogo_GetLogos, async (_event, sources: unknown) => {
    if (!Array.isArray(sources)) return {}
    const safe = sources
      .filter((s): s is string => typeof s === 'string')
      .slice(0, PROVIDER_LOGO_MAX_SOURCES_PER_REQUEST)
    return service.getLogos(safe)
  })
}
