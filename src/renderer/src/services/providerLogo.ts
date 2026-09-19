import { loggerService } from '@logger'
import type { Model, Provider } from '@renderer/types'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { isSafeLogoSourceId, toProviderLogoDataUrl } from '@shared/providerLogo'
import { useEffect, useState } from 'react'

import { resolveExactProvider } from './exactProviderResolver'
import { getModelMetadataSnapshot, resolveCanonicalModelLogoSource, resolveMetadataSource } from './modelMetadata'

const logger = loggerService.withContext('ProviderLogo')

const dataUrlCache = new Map<string, string>()
const pendingCache = new Map<string, Promise<string | null>>()

/**
 * Exact models.dev source for a connection, reusing the existing
 * `resolveMetadataSource` admission contract. Null means unknown — the caller
 * must fall back to the deterministic initial and must never turn a local
 * provider id/name into a logo URL key.
 */
export function resolveProviderLogoSource(
  provider: Provider | undefined | null,
  current: ModelMetadataSnapshot | null = getModelMetadataSnapshot()
): string | null {
  try {
    const source = resolveMetadataSource(provider, current)
    return source && isSafeLogoSourceId(source) ? source : null
  } catch {
    return null
  }
}

/** Test-only seam: clear the renderer memory cache. */
export function clearProviderLogoCacheForTests(): void {
  dataUrlCache.clear()
  pendingCache.clear()
}

function toCachedDataUrl(source: string, svg: string): string {
  const dataUrl = toProviderLogoDataUrl(svg)
  dataUrlCache.set(source, dataUrl)
  return dataUrl
}

/**
 * Best-effort single-logo read through typed IPC. Never throws and never
 * fetches models.dev directly: Main owns fetching/validation/caching.
 * Null means unknown — fall back to the deterministic initial.
 */
export function getProviderLogoDataUrl(source: string | null | undefined): Promise<string | null> {
  if (!source || !isSafeLogoSourceId(source)) return Promise.resolve(null)
  const cached = dataUrlCache.get(source)
  if (cached) return Promise.resolve(cached)
  const pending = pendingCache.get(source)
  if (pending) return pending
  const task = (async () => {
    try {
      const surface = window.api?.providerLogo
      if (!surface || typeof surface.getLogo !== 'function') return null
      const result: unknown = await surface.getLogo(source)
      if (!result || typeof result !== 'object') return null
      const svg = (result as { svg?: unknown }).svg
      if (typeof svg !== 'string' || svg.length === 0) return null
      return toCachedDataUrl(source, svg)
    } catch (error) {
      logger.warn('provider logo lookup failed; falling back to initial', error as Error)
      return null
    } finally {
      pendingCache.delete(source)
    }
  })()
  pendingCache.set(source, task)
  return task
}

/**
 * Best-effort batch read through typed IPC. Never throws; unknown sources
 * are simply absent from the returned map.
 */
export async function getProviderLogoDataUrls(sources: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(sources)].filter(isSafeLogoSourceId)
  if (unique.length === 0) return {}
  const missing = unique.filter((s) => !dataUrlCache.has(s) && !pendingCache.has(s))
  if (missing.length > 0) {
    try {
      const surface = window.api?.providerLogo
      if (surface && typeof surface.getLogos === 'function') {
        const received: unknown = await surface.getLogos(missing)
        if (received && typeof received === 'object') {
          for (const [source, svg] of Object.entries(received as Record<string, unknown>)) {
            if (!isSafeLogoSourceId(source) || typeof svg !== 'string' || svg.length === 0) continue
            toCachedDataUrl(source, svg)
          }
        }
      } else {
        await Promise.all(missing.map((s) => getProviderLogoDataUrl(s)))
      }
    } catch (error) {
      logger.warn('provider logo batch lookup failed; falling back to initials', error as Error)
    }
  }
  const out: Record<string, string> = {}
  for (const source of unique) {
    const cached = dataUrlCache.get(source)
    if (cached) out[source] = cached
  }
  return out
}

/** React hook: exact cached models.dev logo data URL for a connection, else null. */
export function useProviderModelsDevLogo(provider: Provider | undefined | null): string | null {
  const source = resolveProviderLogoSource(provider)
  const [logo, setLogo] = useState<string | null>(() => (source ? (dataUrlCache.get(source) ?? null) : null))
  useEffect(() => {
    if (!source) {
      setLogo(null)
      return
    }
    let cancelled = false
    void getProviderLogoDataUrl(source).then((dataUrl) => {
      if (!cancelled) setLogo(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [source])
  return logo
}

/**
 * React hook: owning provider's exact cached models.dev logo for a model,
 * else null. Resolution is exact `model.provider` id match only with no
 * default fallback; model-specific logos are never invented.
 *
 * Used ONLY for connection/provider UI (provider settings rows, provider
 * avatars): the logo reflects the configured proxy connection's resolved
 * provider source. Model UI uses `useCanonicalModelLogo` instead.
 */
export function useModelProviderLogo(model: Model | undefined | null, explicit?: Provider | null): string | null {
  let provider: Provider | null = null
  try {
    if (explicit !== undefined) {
      provider = explicit
    } else {
      provider = resolveExactProvider(model)
    }
  } catch {
    provider = null
  }
  return useProviderModelsDevLogo(provider)
}

/**
 * Canonical lab (model-brand logo key) for a model, resolved from the
 * canonical `models.json` entry — independent of the serving proxy
 * connection. Null means unknown/ambiguous: the caller must use the generic
 * model fallback, never the proxy connection logo. Never throws.
 */
export function resolveCanonicalModelLogo(
  model: Model | undefined | null,
  current: ModelMetadataSnapshot | null = getModelMetadataSnapshot()
): string | null {
  try {
    return resolveCanonicalModelLogoSource(model, current)
  } catch {
    return null
  }
}

/**
 * React hook: canonical model's lab/brand logo for model UI, else null.
 * The logo follows canonical resolution (`moonshotai` for `kimi-k3` no
 * matter which proxy serves it); unknown/ambiguous resolution yields null
 * (generic fallback), never the proxy logo. Connection UI keeps
 * `useProviderModelsDevLogo` / `useModelProviderLogo`.
 */
export function useCanonicalModelLogo(model: Model | undefined | null): string | null {
  const source = resolveCanonicalModelLogo(model)
  const [logo, setLogo] = useState<string | null>(() => (source ? (dataUrlCache.get(source) ?? null) : null))
  useEffect(() => {
    if (!source) {
      setLogo(null)
      return
    }
    let cancelled = false
    void getProviderLogoDataUrl(source).then((dataUrl) => {
      if (!cancelled) setLogo(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [source])
  return logo
}
