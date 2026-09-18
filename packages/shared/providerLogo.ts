import * as z from 'zod'

import { isSafeMetadataKey } from './modelMetadata'

/**
 * models.dev provider-logo enhancement — shared contracts.
 *
 * Product invariants (never relax without a product decision):
 * - Enhancement only. A missing/invalid logo never blocks requests or
 *   admission: callers fall back to the deterministic initial.
 * - Exact source attribution only. Only a connection that resolves exactly to
 *   a models.dev provider source (via the existing `resolveMetadataSource`
 *   contract) may request `https://models.dev/logos/{source}.svg`. Arbitrary
 *   local `provider.id`/`provider.name` values must never become a logo URL
 *   key — `buildProviderLogoUrl` refuses anything outside the safe source
 *   alphabet, and Main additionally gates on known snapshot sources.
 * - Do not rely on HTTP 404: models.dev serves a default SVG for unknown
 *   ids, so exact attribution is the admission gate, not status codes.
 * - Main owns fetching/validation/caching; the renderer never fetches
 *   models.dev directly.
 */

export const PROVIDER_LOGO_BASE_URL = 'https://models.dev/logos' as const

export const PROVIDER_LOGO_FETCH_TIMEOUT_MS = 10_000

export const PROVIDER_LOGO_MAX_BYTES = 256 * 1024

export const PROVIDER_LOGO_CACHE_VERSION = 1

export const PROVIDER_LOGO_CACHE_REL_PATH = 'provider-logos/models-dev-logos.json'

export const PROVIDER_LOGO_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export const PROVIDER_LOGO_MAX_SOURCES_PER_REQUEST = 50

const LOGO_SOURCE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSafeLogoSourceId(source: unknown): source is string {
  if (typeof source !== 'string') return false
  if (source.length < 1 || source.length > 64) return false
  if (!LOGO_SOURCE_PATTERN.test(source)) return false
  return isSafeMetadataKey(source)
}

export function buildProviderLogoUrl(source: unknown): string | null {
  if (!isSafeLogoSourceId(source)) return null
  return `${PROVIDER_LOGO_BASE_URL}/${source}.svg`
}

export function isSafeProviderSvg(svg: unknown): boolean {
  if (typeof svg !== 'string') return false
  const trimmed = svg.trim()
  if (trimmed.length === 0 || trimmed.length > PROVIDER_LOGO_MAX_BYTES * 4) return false
  const lower = trimmed.toLowerCase()
  if (!/<svg[\s>]/.test(lower)) return false
  if (!/<\/svg\s*>/.test(lower)) return false
  if (lower.includes('<script')) return false
  if (/<\s*(iframe|object|embed|link|meta|foreignobject)\b/.test(lower)) return false
  if (/<\s*image\b/.test(lower)) return false
  if (/<\s*style\b[^>]*>[\s\S]*@import/.test(lower)) return false
  if (/\son[a-z]+\s*=/.test(lower)) return false
  if (/javascript\s*:/.test(lower)) return false
  if (/vbscript\s*:/.test(lower)) return false
  if (/data\s*:\s*text\/html/.test(lower)) return false
  if (/<!entity/.test(lower)) return false
  if (/(href|src|xlink:href)\s*=\s*["']\s*(https?:|data:text\/html|blob:|file:|vbscript:|javascript:)/.test(lower)) {
    return false
  }
  const urlRefs = lower.match(/url\s*\([^)]*\)/g) ?? []
  for (const ref of urlRefs) {
    const inner = ref
      .replace(/^url\s*\(\s*/, '')
      .replace(/\)\s*$/, '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim()
    if (inner.startsWith('#')) continue
    if (inner.startsWith('data:image/')) continue
    if (/^(https?:|blob:|file:|vbscript:|javascript:|data:text\/html)/.test(inner)) return false
    if (inner.startsWith('//')) return false
  }
  return true
}

export function toProviderLogoDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const ProviderLogoEntrySchema = z.looseObject({
  svg: z.string(),
  fetchedAt: z.number(),
  etag: z.string().optional()
})

export type ProviderLogoEntry = z.infer<typeof ProviderLogoEntrySchema>

export const ProviderLogoCacheEnvelopeSchema = z.looseObject({
  version: z.literal(PROVIDER_LOGO_CACHE_VERSION),
  fetchedAt: z.number(),
  logos: z.record(z.string(), ProviderLogoEntrySchema)
})

export type ProviderLogoCacheEnvelope = z.infer<typeof ProviderLogoCacheEnvelopeSchema>

export interface ProviderLogoResult {
  source: string
  svg: string
  fetchedAt: number
  etag?: string
}

export function parseProviderLogoCache(
  data: unknown
): { logos: Record<string, ProviderLogoEntry>; fetchedAt: number } | null {
  const parsed = ProviderLogoCacheEnvelopeSchema.safeParse(data)
  if (!parsed.success) return null
  const logos: Record<string, ProviderLogoEntry> = {}
  for (const [source, entry] of Object.entries(parsed.data.logos ?? {})) {
    if (!isSafeLogoSourceId(source)) continue
    if (!entry || typeof entry.svg !== 'string' || !isSafeProviderSvg(entry.svg)) continue
    if (typeof entry.fetchedAt !== 'number' || !Number.isFinite(entry.fetchedAt)) continue
    logos[source] =
      entry.etag !== undefined
        ? { svg: entry.svg, fetchedAt: entry.fetchedAt, etag: entry.etag }
        : { svg: entry.svg, fetchedAt: entry.fetchedAt }
  }
  return { logos, fetchedAt: parsed.data.fetchedAt }
}
