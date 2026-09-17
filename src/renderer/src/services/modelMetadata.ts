import { loggerService } from '@logger'
import type { Model, Provider } from '@renderer/types'
import {
  isSafeMetadataKey,
  type ModelMetadataSnapshot,
  type NormalizedModelMetadata,
  parseModelMetadataSnapshot
} from '@shared/modelMetadata'

import { resolveExactProvider, setExactProviderResolver } from './exactProviderResolver'

const logger = loggerService.withContext('ModelMetadata')

/** Official OpenAI API base: the only OpenAI-compatible host that maps to `openai`. */
export const OPENAI_OFFICIAL_API_URL = 'https://api.openai.com/v1'

let snapshot: ModelMetadataSnapshot | null = null
let initPromise: Promise<ModelMetadataSnapshot | null> | null = null

/**
 * Runtime provider resolver for external attribution (dependency-injected).
 *
 * `config/models` capability modules must stay pure and lightweight: they
 * never import AssistantService or the store/data-source chain (that edge
 * created a deterministic collection-time TDZ through
 * store/assistants → SqliteMessageDataSource). The exact store lookup is
 * registered once from the renderer boot seam (init.ts); tests register
 * fakes.
 *
 * Attribution still requires an exact `model.provider` id match: the result
 * is verified at this boundary, so even a sloppy resolver cannot cause
 * cross-provider attribution, and there is never a silent default-provider
 * fallback. Backed by the shared exact-provider registry so vision/websearch
 * predicates and metadata attribution share one contract.
 */
export type MetadataProviderResolver = (model: Model | undefined | null) => Provider | null | undefined

export function setMetadataProviderResolver(resolver: MetadataProviderResolver | null): void {
  if (!resolver) {
    setExactProviderResolver(null)
    return
  }
  setExactProviderResolver((model) => {
    try {
      return resolver(model) ?? null
    } catch {
      return null
    }
  })
}

/**
 * Exact owning-provider lookup without any store import. An explicit
 * provider (including explicit null = known absent) wins; otherwise the
 * registered resolver is consulted and its result is accepted only when its
 * id equals the model's own provider id. Never throws.
 */
export function resolveProviderForMetadata(
  model: Model | undefined | null,
  explicit?: Provider | null
): Provider | null {
  if (explicit !== undefined) return explicit
  return resolveExactProvider(model)
}

/**
 * Normalize an API base URL for exact comparison: trim, lowercase
 * scheme+host, strip trailing slashes. URLs carrying username, password,
 * query, or hash refuse to match (return ''): dropping those parts would
 * conflate distinct endpoints (e.g. a `?api_key=` variant with the plain
 * base). Unparseable values with query/hash markers are refused the same
 * way. Never throws.
 */
export function normalizeApiUrl(url: string | undefined | null): string {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return ''
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}`
  } catch {
    if (trimmed.includes('?') || trimmed.includes('#')) return ''
    return trimmed.replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * Map a configured provider to its models.dev source id.
 *
 * - `anthropic` protocol -> `anthropic` source.
 * - `gemini` protocol -> `google` source (never `google-vertex`).
 * - OpenAI official host -> `openai` source.
 * - Any other connection -> exact normalized API URL match against the
 *   snapshot providers' `api`; only when exactly one provider matches.
 *   Zero or multiple matches -> unknown (null). A miss never falls back to
 *   another source.
 */
export function resolveMetadataSource(
  provider: Provider | undefined | null,
  current: ModelMetadataSnapshot | null = snapshot
): string | null {
  if (!provider || !current) return null
  if (provider.type === 'anthropic') return 'anthropic'
  if (provider.type === 'gemini') return 'google'
  if (provider.type === 'openai' || provider.type === 'openai-response') {
    if (normalizeApiUrl(provider.apiHost) === normalizeApiUrl(OPENAI_OFFICIAL_API_URL)) {
      return 'openai'
    }
  }
  const target = normalizeApiUrl(provider.apiHost)
  if (!target) return null
  const providers = current.providers
  if (!providers || typeof providers !== 'object') return null
  const matches = Object.entries(providers).filter(([, entry]) => {
    if (!entry || typeof entry !== 'object') return false
    if (!entry.api || entry.api.trim().length === 0) return false
    return normalizeApiUrl(entry.api) === target
  })
  return matches.length === 1 ? matches[0][0] : null
}

/**
 * Exact trimmed model-id lookup inside one source only. Case-sensitive, no
 * lowercasing, no suffix handling — a miss returns undefined (unknown).
 * Unsafe dictionary keys and malformed in-memory shapes are rejected without
 * throwing, so a corrupt snapshot can never confuse capability predicates.
 */
export function lookupModelMetadata(
  sourceId: string | null | undefined,
  modelId: string | undefined | null,
  current: ModelMetadataSnapshot | null = snapshot
): NormalizedModelMetadata | undefined {
  if (!current || typeof current !== 'object' || !sourceId || modelId == null) return undefined
  if (!isSafeMetadataKey(sourceId)) return undefined
  const key = modelId.trim()
  if (!key || !isSafeMetadataKey(key)) return undefined
  const providers = current.providers
  if (!providers || typeof providers !== 'object') return undefined
  const source = (providers as Record<string, unknown>)[sourceId]
  if (!source || typeof source !== 'object') return undefined
  const models = (source as { models?: unknown }).models
  if (!models || typeof models !== 'object') return undefined
  const entry = (models as Record<string, unknown>)[key]
  if (!entry || typeof entry !== 'object') return undefined
  return entry as NormalizedModelMetadata
}

/** Convenience: source mapping + exact lookup for a model/provider pair. */
export function resolveModelMetadata(
  model: Model | undefined | null,
  provider?: Provider | null,
  current: ModelMetadataSnapshot | null = snapshot
): NormalizedModelMetadata | undefined {
  if (!model) return undefined
  return lookupModelMetadata(resolveMetadataSource(provider ?? null, current), model.id, current)
}

/**
 * Initialize the in-memory registry during normal store boot. Never throws
 * and never blocks readiness: failures (missing preload surface, IPC errors,
 * malformed snapshots) leave the registry empty, which every consumer treats
 * as unknown. The snapshot is stored in memory only — never in Redux.
 */
export function initModelMetadataRegistry(): Promise<ModelMetadataSnapshot | null> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const surface = window.api?.modelMetadata
      if (!surface || typeof surface.getSnapshot !== 'function') {
        return null
      }
      const received: unknown = await surface.getSnapshot()
      // The snapshot crosses IPC: validate with the shared schema. Malformed
      // data becomes null/unknown and can never throw in capability
      // predicates. Stored in memory only — never in Redux.
      const parsed = parseModelMetadataSnapshot(received)
      if (parsed) {
        snapshot = parsed
        return snapshot
      }
      return null
    } catch (error) {
      logger.warn('model metadata init failed; registry stays unknown', error as Error)
      return null
    }
  })()
  return initPromise
}

/** Synchronous in-memory read after init. Null until/unless loaded. */
export function getModelMetadataSnapshot(): ModelMetadataSnapshot | null {
  return snapshot
}

export function isModelMetadataReady(): boolean {
  return snapshot !== null
}

/** Manually refresh the in-memory snapshot (best-effort, never throws). */
export async function refreshModelMetadataRegistry(): Promise<ModelMetadataSnapshot | null> {
  try {
    const surface = window.api?.modelMetadata
    if (!surface || typeof surface.refresh !== 'function') return snapshot
    await surface.refresh()
    initPromise = null
    return await initModelMetadataRegistry()
  } catch (error) {
    logger.warn('model metadata refresh failed; keeping current snapshot', error as Error)
    return snapshot
  }
}

/** Test-only seam: install a snapshot without IPC. */
export function setModelMetadataSnapshotForTests(next: ModelMetadataSnapshot | null): void {
  snapshot = next
  initPromise = null
}
