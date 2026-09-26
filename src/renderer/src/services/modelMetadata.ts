import { loggerService } from '@logger'
import type { Model, Provider } from '@renderer/types'
import {
  asSafeMetadataFailureReason,
  isSafeMetadataKey,
  type ModelMetadataRefreshReason,
  type ModelMetadataSnapshot,
  type ModelMetadataStatus,
  type NormalizedModelMetadata,
  type NormalizedProviderServingModel,
  parseModelMetadataSnapshot,
  parseModelMetadataStatus,
  resolveCanonicalModel,
  resolveProviderServingModel
} from '@shared/modelMetadata'
import { isSafeLogoSourceId } from '@shared/providerLogo'

import { resolveExactProvider, setExactProviderResolver } from './exactProviderResolver'

const logger = loggerService.withContext('ModelMetadata')

/** Official OpenAI API base: the only OpenAI-compatible host that maps to `openai`. */
export const OPENAI_OFFICIAL_API_URL = 'https://api.openai.com/v1'

let snapshot: ModelMetadataSnapshot | null = null
let initPromise: Promise<ModelMetadataSnapshot | null> | null = null

/**
 * Reactive registry status for `useSyncExternalStore` subscribers (e.g. an
 * open Edit Model popup re-rendering when the async init completes).
 *
 * The status reference is stable: `getModelMetadataStatusSnapshot` returns
 * the same object until the next transition, so subscribers never spin.
 * Every init/refresh terminal path replaces the reference and notifies.
 */
let statusRef: ModelMetadataStatus = { kind: 'loading', snapshot: null }
const statusListeners = new Set<() => void>()

function setStatus(next: ModelMetadataStatus): void {
  statusRef = next
  for (const listener of [...statusListeners]) {
    try {
      listener()
    } catch {
      // A throwing subscriber must never break the remaining notifications.
    }
  }
}

function setStatusFromSnapshot(next: ModelMetadataSnapshot | null, failureReason?: ModelMetadataRefreshReason): void {
  if (next) {
    snapshot = next
    setStatus({ kind: 'ready', snapshot: next })
    return
  }
  const reason = asSafeMetadataFailureReason(failureReason)
  if (reason) {
    setStatus({ kind: 'unavailable', snapshot: null, reason })
  } else {
    setStatus({ kind: 'loading', snapshot: null })
  }
}

/** Subscribe to registry status transitions. Returns an unsubscribe fn. */
export function subscribeModelMetadataStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** Stable status reference for `useSyncExternalStore`. Never a fresh object. */
export function getModelMetadataStatusSnapshot(): ModelMetadataStatus {
  return statusRef
}

/** Current registry status (same stable reference as the subscriber read). */
export function getModelMetadataStatus(): ModelMetadataStatus {
  return statusRef
}

/**
 * Runtime provider resolver for request-lane attribution (dependency-injected).
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
 * predicates and request-lane resolution share one contract.
 *
 * Model capability facts themselves never use this resolver: they resolve by
 * canonical model id only (see `resolveCanonicalModelEntry`).
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
 * Map a configured connection to its models.dev provider-source id for
 * CONNECTION logos only.
 *
 * - `anthropic` protocol -> `anthropic` source.
 * - `gemini` protocol -> `google` source (never `google-vertex`).
 * - OpenAI official host -> `openai` source.
 * - Any other connection -> exact normalized API URL match against the
 *   snapshot provider-source list's `api`; only when exactly one source
 *   matches. Zero or multiple matches -> unknown (null). A miss never falls
 *   back to another source.
 *
 * Model capability facts and model logos never use this function.
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
 * Canonical model entry for a user/proxy model id, independent of the
 * serving connection. Resolution follows the shared canonical matching
 * contract (exact id -> unique basename -> unique case-fold, fail closed);
 * identity never uses the API URL, `group`, editable `name`, provider brand
 * id, or `owned_by`. Returns undefined when unknown or ambiguous. Never
 * throws.
 */
export function resolveCanonicalModelEntry(
  modelId: string | undefined | null,
  current: ModelMetadataSnapshot | null = snapshot
): NormalizedModelMetadata | undefined {
  return resolveCanonicalModel(modelId, current)?.entry
}

/**
 * Provider-specific serving metadata record for a model, resolved through
 * the exact owning provider -> source-id mapping. Exact trimmed model-id
 * match only (case-sensitive, no basename/case-fold). Provider-specific
 * records are enrichment only and never merged into canonical capabilities;
 * they never overwrite canonical fields. Returns undefined when unknown or
 * when the connection is explicitly absent. Never throws.
 */
export function resolveServingModelForModel(
  model: Model | undefined | null,
  explicitProvider?: Provider | null,
  current: ModelMetadataSnapshot | null = snapshot
): NormalizedProviderServingModel | undefined {
  try {
    if (!model || typeof model.id !== 'string') return undefined
    const snapshotToUse = current ?? snapshot
    const provider = explicitProvider !== undefined ? explicitProvider : resolveProviderForMetadata(model)
    if (!provider) return undefined
    const sourceId = resolveMetadataSource(provider, snapshotToUse)
    if (!sourceId) return undefined
    return resolveProviderServingModel(sourceId, model.id, snapshotToUse)
  } catch {
    return undefined
  }
}

/**
 * Provider-specific serving effort values for a model, resolved through the
 * exact owning provider -> source-id mapping. Exact trimmed model-id match
 * only, no basename/case-fold. Provider-specific records never merge into
 * canonical capabilities. Returns undefined when unknown or when the
 * connection is explicitly absent. Never throws.
 */
export function resolveServingEffortForModel(
  model: Model | undefined | null,
  explicitProvider?: Provider | null,
  current: ModelMetadataSnapshot | null = snapshot
): string[] | undefined {
  return resolveServingModelForModel(model, explicitProvider, current)?.effort
}

/**
 * Canonical lab (model-brand logo key) for a user/proxy model id. Returns
 * the canonical id prefix (e.g. `moonshotai` for `moonshotai/kimi-k3`) only
 * when canonical resolution succeeds and the lab is a safe logo key;
 * otherwise null — the caller must use the generic model fallback, never
 * the proxy connection logo. Never throws.
 */
export function resolveCanonicalModelLogoSource(
  model: Model | undefined | null,
  current: ModelMetadataSnapshot | null = snapshot
): string | null {
  try {
    if (!model || typeof model.id !== 'string') return null
    const lab = resolveCanonicalModel(model.id, current)?.lab
    if (!lab || !isSafeLogoSourceId(lab)) return null
    if (!isSafeMetadataKey(lab)) return null
    return lab
  } catch {
    return null
  }
}

/**
 * Initialize the in-memory registry during normal store boot. Never throws
 * and never blocks readiness: failures (missing preload surface, IPC errors,
 * malformed snapshots) leave the registry empty, which every consumer treats
 * as unknown. The snapshot is stored in memory only — never in Redux.
 *
 * Status transitions (all notified to `useSyncExternalStore` subscribers, so
 * an open Edit Model popup re-renders when the async round completes):
 * - Main-reported `ready`/`unavailable` are adopted as-is (single source of
 *   truth; reasons stay sanitized).
 * - Main-reported `loading` with an empty snapshot read means this one-shot
 *   read caught Main still loading: converge with one bounded, awaited
 *   refresh + re-read round (existing `refresh` path, no polling, no push
 *   subsystem) to `ready` or `unavailable`. A failed convergence keeps
 *   last-known-good when present, else `unavailable`.
 * - Compat path (no `getStatus` surface): a parsed snapshot is ready; a
 *   malformed payload is a completed validation failure (unavailable); a
 *   null read with no snapshot is a completed empty round (unavailable).
 * - IPC throws with no snapshot are completed failures (unavailable).
 * - An existing snapshot is never demoted: refresh failures stay ready.
 */
export function initModelMetadataRegistry(): Promise<ModelMetadataSnapshot | null> {
  if (initPromise) return initPromise
  if (!snapshot) {
    setStatus({ kind: 'loading', snapshot: null })
  }
  initPromise = (async () => {
    try {
      const surface = window.api?.modelMetadata
      if (!surface || typeof surface.getSnapshot !== 'function') {
        if (!snapshot) setStatus({ kind: 'loading', snapshot: null })
        return snapshot
      }
      // Prefer the reactive Main status when the surface exposes it; the
      // shared parser keeps the IPC boundary defensive.
      let mainInFlight = false
      if (typeof surface.getStatus === 'function') {
        try {
          const reported: unknown = await surface.getStatus()
          const parsedStatus = parseModelMetadataStatus(reported)
          if (parsedStatus) {
            if (parsedStatus.snapshot) {
              setStatusFromSnapshot(parsedStatus.snapshot)
              return snapshot
            }
            if (parsedStatus.kind === 'unavailable' && !snapshot) {
              setStatus(parsedStatus)
              return null
            }
            mainInFlight = parsedStatus.kind === 'loading'
          }
        } catch {
          // Fall through to the compatible snapshot read below.
        }
      }
      const received: unknown = await surface.getSnapshot()
      // The snapshot crosses IPC: validate with the shared schema. Malformed
      // data becomes null/unknown and can never throw in capability
      // predicates. Stored in memory only — never in Redux.
      const parsed = parseModelMetadataSnapshot(received)
      if (parsed) {
        setStatusFromSnapshot(parsed)
        return snapshot
      }
      if (snapshot) return snapshot
      if (received !== null && received !== undefined) {
        setStatus({ kind: 'unavailable', snapshot: null, reason: 'schema-mismatch' })
        return null
      }
      if (mainInFlight) {
        // This one-shot read caught Main still loading with no snapshot:
        // converge with a single bounded, awaited refresh + re-read round.
        // No polling, no push subsystem; still never throws and never gates
        // app readiness (callers treat the registry as enhancement-only).
        return await convergeAfterMainLoading(surface)
      }
      setStatus({ kind: 'unavailable', snapshot: null, reason: 'network-error' })
      return null
    } catch (error) {
      logger.warn('model metadata init failed; registry stays unknown', error as Error)
      if (!snapshot) setStatus({ kind: 'unavailable', snapshot: null, reason: 'network-error' })
      return snapshot
    }
  })()
  return initPromise
}

/**
 * Bounded convergence after catching Main still loading: one awaited
 * `refresh` (existing path) plus one re-read of status/snapshot, then a
 * terminal `ready` or `unavailable`. Never throws; never demotes an existing
 * snapshot.
 */
async function convergeAfterMainLoading(surface: {
  refresh?: unknown
  getStatus?: unknown
  getSnapshot: unknown
}): Promise<ModelMetadataSnapshot | null> {
  try {
    if (typeof surface.refresh === 'function') {
      try {
        await (surface.refresh as () => Promise<unknown>)()
      } catch (error) {
        logger.warn('model metadata convergence refresh failed; re-reading once', error as Error)
      }
    }
    if (typeof surface.getStatus === 'function') {
      try {
        const reread: unknown = await (surface.getStatus as () => Promise<unknown>)()
        const parsedStatus = parseModelMetadataStatus(reread)
        if (parsedStatus?.snapshot) {
          setStatusFromSnapshot(parsedStatus.snapshot)
          return snapshot
        }
        if (parsedStatus?.kind === 'unavailable' && !snapshot) {
          setStatus(parsedStatus)
          return null
        }
      } catch {
        // Fall through to the single snapshot re-read below.
      }
    }
    try {
      const reread: unknown = await (surface.getSnapshot as () => Promise<unknown>)()
      const parsed = parseModelMetadataSnapshot(reread)
      if (parsed) {
        setStatusFromSnapshot(parsed)
        return snapshot
      }
      if (reread !== null && reread !== undefined) {
        if (!snapshot) setStatus({ kind: 'unavailable', snapshot: null, reason: 'schema-mismatch' })
        return snapshot
      }
    } catch (error) {
      logger.warn('model metadata convergence re-read failed', error as Error)
    }
  } catch (error) {
    logger.warn('model metadata convergence failed; registry stays unknown', error as Error)
  }
  // Converged: still empty after the bounded round — unavailable, never
  // permanently loading. An existing snapshot is never demoted.
  if (!snapshot) setStatus({ kind: 'unavailable', snapshot: null, reason: 'network-error' })
  return snapshot
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
    // A failed refresh never demotes an existing snapshot: ready persists.
    // Without any snapshot the completed failure is unavailable.
    if (!snapshot) setStatus({ kind: 'unavailable', snapshot: null, reason: 'network-error' })
    return snapshot
  }
}

/**
 * Bounded post-proxy recovery for a cold first-load failure.
 *
 * On a fresh cache the nonblocking boot fetch in `init.ts` can run before
 * Main applies the renderer proxy config, so the first Main fetch fails and
 * the registry settles `unavailable` with a null snapshot. Call this once
 * the `App_Proxy` promise resolves: it awaits the previous init/convergence
 * round to completion (never joining a stale pre-proxy Main in-flight as the
 * retry itself), then does exactly one `refresh` when — and only when — the
 * completed round left no snapshot. A cached-ready snapshot never forces a
 * refresh; a still-loading round never spins. Best-effort and never throws,
 * so startup stays nonblocking and last-known-good is preserved.
 */
export async function retryModelMetadataAfterProxyApplied(): Promise<ModelMetadataSnapshot | null> {
  try {
    try {
      await initModelMetadataRegistry()
    } catch {
      // init never throws; defensive only.
    }
    if (snapshot) return snapshot
    const current = getModelMetadataStatus()
    if (current.snapshot) return current.snapshot
    if (current.kind === 'ready' || current.kind === 'loading') return snapshot
    return await refreshModelMetadataRegistry()
  } catch (error) {
    logger.warn('model metadata post-proxy retry failed; registry stays unknown', error as Error)
    return snapshot
  }
}

/** Test-only seam: install a snapshot without IPC. */
export function setModelMetadataSnapshotForTests(next: ModelMetadataSnapshot | null): void {
  snapshot = next
  initPromise = null
  setStatusFromSnapshot(next)
}

/** Test-only seam: install an explicit status without IPC. */
export function setModelMetadataStatusForTests(next: ModelMetadataStatus): void {
  snapshot = next.snapshot
  initPromise = null
  setStatus(next.kind === 'ready' && !next.snapshot ? { kind: 'loading', snapshot: null } : next)
}
