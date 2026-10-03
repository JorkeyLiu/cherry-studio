import { loggerService } from '@logger'
import {
  type AssistantConfigDelta,
  type AssistantConfigKind,
  type AssistantConfigPayload,
  canonicalAssistantConfigKey,
  validateAssistantConfigDelta,
  validateAssistantConfigPayload
} from '@shared/sync/assistantConfig'

const logger = loggerService.withContext('SyncAssistantConfig')

/**
 * Bounded assistant-config mirror (bridge unit, no protocol-core integration).
 *
 * Renderer owns local non-secret assistant/defaults authority; this module is
 * a Main-side mirror row store only. Chat authority is untouched.
 *
 * Final 019 migration owns the real DDL through the canonical runner. This
 * file exports static SQL constants for that migration to import (migrations
 * are static SQL; no service import cycle). It never creates schema itself
 * outside tests/ephemeral adapters.
 */

export const ASSISTANT_CONFIG_MIRROR_TABLE = 'sync_assistant_config_mirror'

export const ASSISTANT_CONFIG_MIRROR_DDL = [
  `CREATE TABLE IF NOT EXISTS ${ASSISTANT_CONFIG_MIRROR_TABLE} (`,
  '  key TEXT PRIMARY KEY,',
  '  kind TEXT NOT NULL,',
  '  entity_id TEXT NOT NULL,',
  '  payload_json TEXT NOT NULL,',
  '  version INTEGER NOT NULL,',
  '  local_mutation_id TEXT,',
  '  projection_revision INTEGER NOT NULL DEFAULT 0,',
  '  deleted INTEGER NOT NULL DEFAULT 0,',
  '  updated_at INTEGER NOT NULL',
  ')'
].join('\n')

export interface AssistantConfigMirrorRow {
  key: string
  kind: AssistantConfigKind
  entityId: string
  payloadJson: string
  version: number
  localMutationId: string | null
  projectionRevision: number
  deleted: boolean
  updatedAt: number
}

/** Minimal injected persistence surface (better-sqlite3 or ephemeral test DB). */
export interface AssistantConfigDb {
  getRow(key: string): AssistantConfigMirrorRow | null
  listRows(): AssistantConfigMirrorRow[]
  /** Atomic single-row upsert + optional caller enqueue in one tx. */
  transact<T>(fn: () => T): T
  putRow(row: AssistantConfigMirrorRow): void
  deleteRow(key: string): void
}

export function createMemoryAssistantConfigDb(): AssistantConfigDb {
  const rows = new Map<string, AssistantConfigMirrorRow>()
  return {
    getRow: (key) => rows.get(key) ?? null,
    listRows: () => [...rows.values()],
    transact: (fn) => {
      const snapshot = new Map(rows)
      try {
        return fn()
      } catch (e) {
        rows.clear()
        for (const [k, v] of snapshot) rows.set(k, v)
        throw e
      }
    },
    putRow: (row) => {
      rows.set(row.key, row)
    },
    deleteRow: (key) => {
      rows.delete(key)
    }
  }
}

/** better-sqlite3-backed adapter over an ephemeral/test database handle. */
export function createSqliteAssistantConfigDb(handle: {
  prepare(sql: string): {
    get(...p: unknown[]): unknown
    all(...p: unknown[]): unknown[]
    run(...p: unknown[]): unknown
  }
  exec(sql: string): void
  transaction<T>(fn: () => T): () => T
}): AssistantConfigDb {
  handle.exec(ASSISTANT_CONFIG_MIRROR_DDL)
  const mapRow = (r: Record<string, unknown>): AssistantConfigMirrorRow => ({
    key: String(r.key),
    kind: r.kind as AssistantConfigKind,
    entityId: String(r.entity_id),
    payloadJson: String(r.payload_json),
    version: Number(r.version),
    localMutationId: r.local_mutation_id == null ? null : String(r.local_mutation_id),
    projectionRevision: Number(r.projection_revision),
    deleted: Number(r.deleted) === 1,
    updatedAt: Number(r.updated_at)
  })
  return {
    getRow: (key) => {
      const r = handle.prepare(`SELECT * FROM ${ASSISTANT_CONFIG_MIRROR_TABLE} WHERE key = ?`).get(key) as
        | Record<string, unknown>
        | undefined
      return r ? mapRow(r) : null
    },
    listRows: () => {
      const rs = handle.prepare(`SELECT * FROM ${ASSISTANT_CONFIG_MIRROR_TABLE} ORDER BY key ASC`).all() as Record<
        string,
        unknown
      >[]
      return rs.map(mapRow)
    },
    transact: (fn) => handle.transaction(fn)(),
    putRow: (row) => {
      handle
        .prepare(
          `INSERT INTO ${ASSISTANT_CONFIG_MIRROR_TABLE} (key, kind, entity_id, payload_json, version, local_mutation_id, projection_revision, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, entity_id=excluded.entity_id, payload_json=excluded.payload_json, version=excluded.version, local_mutation_id=excluded.local_mutation_id, projection_revision=excluded.projection_revision, deleted=excluded.deleted, updated_at=excluded.updated_at`
        )
        .run(
          row.key,
          row.kind,
          row.entityId,
          row.payloadJson,
          row.version,
          row.localMutationId,
          row.projectionRevision,
          row.deleted ? 1 : 0,
          row.updatedAt
        )
    },
    deleteRow: (key) => {
      handle.prepare(`DELETE FROM ${ASSISTANT_CONFIG_MIRROR_TABLE} WHERE key = ?`).run(key)
    }
  }
}

export interface AssistantConfigCommitDeps {
  /** Barrier/publish gate (future 019 core provides it). Must throw BEFORE tx. */
  publishGate?: () => void
  /** Caller-injected outbox enqueue (same SQLite tx scope in final wiring). */
  enqueue?: (op: { key: string; mutationId: string; payload: AssistantConfigPayload }) => void
  now?: () => number
}

/**
 * Commit a renderer-local delta: validate -> gate -> single tx
 * (mirror write + caller enqueue). Same mutationId repeats are no-ops.
 */
export function commitLocalDelta(
  db: AssistantConfigDb,
  delta: AssistantConfigDelta,
  deps: AssistantConfigCommitDeps = {}
): { key: string; version: number; acked: boolean; duplicate: boolean } {
  const deltaErr = validateAssistantConfigDelta(delta)
  if (deltaErr) throw new Error(`invalid assistant config delta: ${deltaErr}`)
  // Barrier gate throws BEFORE any SQLite tx.
  deps.publishGate?.()
  const key = canonicalAssistantConfigKey(delta.kind, delta.id)
  const now = deps.now?.() ?? Date.now()
  return db.transact(() => {
    const prev = db.getRow(key)
    if (prev && prev.localMutationId === delta.mutationId) {
      return { key, version: prev.version, acked: true, duplicate: true }
    }
    const prevPayload: AssistantConfigPayload | null = prev ? JSON.parse(prev.payloadJson) : null
    let nextPayload: AssistantConfigPayload
    if (delta.deleted === true) {
      nextPayload = {
        schemaVersion: 1,
        kind: delta.kind,
        id: delta.id,
        deleted: true
      }
    } else {
      const merged: Record<string, unknown> = {
        schemaVersion: 1,
        kind: delta.kind,
        id: delta.id,
        ...(prevPayload && !prevPayload.deleted ? stripMeta(prevPayload) : {}),
        ...(delta.fields as Record<string, unknown>)
      }
      merged.schemaVersion = 1
      merged.kind = delta.kind
      merged.id = delta.id
      nextPayload = merged as unknown as AssistantConfigPayload
    }
    const payloadErr = validateAssistantConfigPayload(nextPayload)
    if (payloadErr) throw new Error(`invalid merged assistant config: ${payloadErr}`)
    const version = (prev?.version ?? 0) + 1
    // Caller enqueue participates in the same tx: throw => full rollback.
    deps.enqueue?.({ key, mutationId: delta.mutationId, payload: nextPayload })
    db.putRow({
      key,
      kind: delta.kind,
      entityId: delta.id,
      payloadJson: JSON.stringify(nextPayload),
      version,
      localMutationId: delta.mutationId,
      projectionRevision: prev?.projectionRevision ?? 0,
      deleted: delta.deleted === true,
      updatedAt: now
    })
    logger.info(`[AssistantConfig] commit ${key} v${version}`)
    return { key, version, acked: true, duplicate: false }
  })
}

function stripMeta(p: AssistantConfigPayload): Record<string, unknown> {
  const { schemaVersion: _s, kind: _k, id: _i, deleted: _d, ...rest } = p as unknown as Record<string, unknown>
  return rest
}

/**
 * Remote merged-config hook (future protocol-core calls this; NOT wired here).
 * Internal writes bypass the local publish gate by design.
 */
export function receiveRemoteMergedConfig(
  db: AssistantConfigDb,
  payload: AssistantConfigPayload,
  revision: number,
  now: number = Date.now()
): { key: string; projectionRevision: number } {
  const err = validateAssistantConfigPayload(payload)
  if (err) throw new Error(`invalid remote assistant config: ${err}`)
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid projection revision')
  const key = canonicalAssistantConfigKey(payload.kind, payload.id)
  return db.transact(() => {
    const prev = db.getRow(key)
    // Monotonic projection guard: stale remote never rewinds the mirror.
    if (prev && revision <= prev.projectionRevision) {
      return { key, projectionRevision: prev.projectionRevision }
    }
    db.putRow({
      key,
      kind: payload.kind,
      entityId: payload.id,
      payloadJson: JSON.stringify(payload),
      version: (prev?.version ?? 0) + 1,
      localMutationId: prev?.localMutationId ?? null,
      projectionRevision: revision,
      deleted: payload.deleted === true,
      updatedAt: now
    })
    return { key, projectionRevision: revision }
  })
}

/** Read batch for renderer projection (toRenderer). */
export function createProjectionBatch(
  db: AssistantConfigDb,
  keys?: string[]
): Array<{ key: string; payload: AssistantConfigPayload; projectionRevision: number; version: number }> {
  const rows = db.listRows().filter((r) => (keys ? keys.includes(r.key) : true))
  return rows.map((r) => ({
    key: r.key,
    payload: JSON.parse(r.payloadJson) as AssistantConfigPayload,
    projectionRevision: r.projectionRevision,
    version: r.version
  }))
}

/**
 * Renderer ack after apply+persist. Strict version: only clears the pending
 * projection marker when versions match; never clears newer; late/duplicate
 * acks are no-ops.
 */
export function ackProjection(
  db: AssistantConfigDb,
  key: string,
  projectionRevision: number
): { cleared: boolean; current: number | null } {
  const prev = db.getRow(key)
  if (!prev) return { cleared: false, current: null }
  if (projectionRevision !== prev.projectionRevision) return { cleared: false, current: prev.projectionRevision }
  // Ack is a durability marker only; mirror row stays (idempotent re-ack safe).
  return { cleared: true, current: prev.projectionRevision }
}

/** Consistent-tx snapshot for future baseline handshake (complete, explicit). */
export function snapshotForBaseline(db: AssistantConfigDb): AssistantConfigPayload[] {
  return db.transact(() => db.listRows().map((r) => JSON.parse(r.payloadJson) as AssistantConfigPayload))
}
