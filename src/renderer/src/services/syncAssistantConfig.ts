import { loggerService } from '@logger'
import type { AssistantConfigDelta, AssistantConfigKind, AssistantConfigPayload } from '@shared/sync/assistantConfig'
import { canonicalAssistantConfigKey } from '@shared/sync/assistantConfig'

const logger = loggerService.withContext('SyncAssistantConfig')

export interface AssistantConfigSyncApi {
  commitDelta(delta: AssistantConfigDelta): Promise<{ key: string; version: number }>
  getProjection(
    keys?: string[]
  ): Promise<Array<{ key: string; payload: AssistantConfigPayload; projectionRevision: number; version: number }>>
  ackProjection(key: string, projectionRevision: number): Promise<unknown>
}

function rendererApi(): AssistantConfigSyncApi | null {
  try {
    const api = (window as unknown as { api?: { syncAssistantConfig?: AssistantConfigSyncApi } }).api
      ?.syncAssistantConfig
    return api ?? null
  } catch {
    return null
  }
}

export function buildLocalDelta(input: {
  kind: AssistantConfigKind
  id: string
  mutationId: string
  revision: number
  fields: Partial<AssistantConfigPayload>
  deleted?: boolean
}): AssistantConfigDelta {
  return {
    kind: input.kind,
    id: input.id,
    mutationId: input.mutationId,
    revision: input.revision,
    timestamp: Date.now(),
    fields: input.fields,
    ...(input.deleted !== undefined ? { deleted: input.deleted } : {})
  }
}

/**
 * Drain durable pending ledger after store ready/rehydrate. Retries until
 * Main ack; same mutationId repeats are idempotent (no extra op). Caller
 * passes the persisted pending map + dispatch so this module stays
 * store-shape agnostic.
 */
export async function drainAssistantConfigPending(deps: {
  pending: AssistantConfigDelta[]
  commit?: (delta: AssistantConfigDelta) => Promise<unknown>
  onAcked: (delta: AssistantConfigDelta) => void
  onError?: (delta: AssistantConfigDelta, error: unknown) => void
}): Promise<{ acked: number; retained: number }> {
  const commit = deps.commit ?? ((d) => rendererApi()?.commitDelta(d) ?? Promise.reject(new Error('ipc unavailable')))
  let acked = 0
  for (const delta of deps.pending) {
    try {
      await commit(delta)
      deps.onAcked(delta)
      acked++
    } catch (e) {
      logger.warn(`[AssistantConfig] drain retained ${canonicalAssistantConfigKey(delta.kind, delta.id)}`, e as Error)
      deps.onError?.(delta, e)
    }
  }
  return { acked, retained: deps.pending.length - acked }
}

/**
 * Apply a remote projection batch through the existing renderer store config
 * apply path with meta.fromSync (never re-enqueues/echoes). Validates each
 * payload strictly; unknown/invalid entries are skipped fail-closed.
 * Strict ordering: APPLY -> FLUSH -> ACK per entry. A flush rejection retains
 * the Main projection/pending (no ack) for restart replay.
 */
export async function applyRemoteProjectionBatch(deps: {
  batch: Array<{ key: string; payload: AssistantConfigPayload; projectionRevision: number }>
  applyOne: (payload: AssistantConfigPayload, meta: { fromSync: boolean; projectionRevision: number }) => void
  flush?: () => Promise<unknown>
  ackOne: (key: string, projectionRevision: number) => Promise<unknown> | unknown
}): Promise<{ applied: number; skipped: number }> {
  const { validateAssistantConfigPayload } = await import('@shared/sync/assistantConfig')
  let applied = 0
  let skipped = 0
  for (const entry of deps.batch) {
    const err = validateAssistantConfigPayload(entry.payload)
    if (err) {
      skipped++
      continue
    }
    try {
      deps.applyOne(entry.payload, { fromSync: true, projectionRevision: entry.projectionRevision })
      if (deps.flush) await deps.flush()
      await deps.ackOne(entry.key, entry.projectionRevision)
      applied++
    } catch {
      skipped++
    }
  }
  return { applied, skipped }
}

let projectionListenerStop: (() => void) | null = null

/** Event-driven projection subscription (no polling intervals). */
export function startAssistantConfigSync(deps: {
  applyOne: (payload: AssistantConfigPayload, meta: { fromSync: boolean; projectionRevision: number }) => void
  flush?: () => Promise<unknown>
  ackOne: (key: string, projectionRevision: number) => Promise<unknown> | unknown
}): () => void {
  stopAssistantConfigSync()
  try {
    const sub = (
      window as unknown as { api?: { syncAssistantConfig?: { onProjection(cb: (b: unknown) => void): () => void } } }
    ).api?.syncAssistantConfig?.onProjection?.(async (batch: unknown) => {
      if (!Array.isArray(batch)) return
      await applyRemoteProjectionBatch({
        batch: batch as never,
        applyOne: deps.applyOne,
        flush: deps.flush,
        ackOne: deps.ackOne
      })
    })
    projectionListenerStop = sub ?? null
  } catch (e) {
    logger.warn('[AssistantConfig] projection subscribe failed', e as Error)
  }
  return stopAssistantConfigSync
}

export function stopAssistantConfigSync(): void {
  try {
    projectionListenerStop?.()
  } catch {}
  projectionListenerStop = null
}
