import type { AssistantConfigDelta } from '@shared/sync/assistantConfig'

import {
  ackProjection,
  type AssistantConfigDb,
  commitLocalDelta,
  createMemoryAssistantConfigDb,
  createProjectionBatch,
  createSqliteAssistantConfigDb,
  snapshotForBaseline
} from './syncAssistantConfig'

/**
 * Process-wide mirror holder (no SyncService import => no cycle).
 * Production binds the canonical SQLite adapter at SyncService/IPC init
 * (same chatDB connection, same-Tx mirror+outbox). Tests inject memory/ephemeral
 * DBs via `setAssistantConfigMirrorForTest`. The lazy memory fallback below is
 * test-only: production callers must use `requireAssistantConfigMirror()` which
 * throws (retain pending) when unbound instead of fabricating memory state.
 */
let mirror: AssistantConfigDb | null = null

export function getAssistantConfigMirror(): AssistantConfigDb {
  if (!mirror) mirror = createMemoryAssistantConfigDb()
  return mirror
}

/** True when a mirror DB was explicitly bound/injected (production or test). */
export function isAssistantConfigMirrorBound(): boolean {
  return mirror !== null
}

/**
 * Production bind: canonical SQLite handle (same chatDB connection).
 * Must run before any assistant IPC startup. Never falls back to memory.
 */
export function bindAssistantConfigMirrorToSqlite(handle: {
  prepare(sql: string): {
    get(...p: unknown[]): unknown
    all(...p: unknown[]): unknown[]
    run(...p: unknown[]): unknown
  }
  exec(sql: string): void
  transaction<T>(fn: () => T): () => T
}): AssistantConfigDb {
  const db = createSqliteAssistantConfigDb(handle)
  mirror = db
  return db
}

export function requireAssistantConfigMirror(): AssistantConfigDb {
  if (!mirror) throw new Error('assistant mirror unavailable: retain pending (no memory fallback in production)')
  return mirror
}

export function setAssistantConfigMirrorForTest(db: AssistantConfigDb | null): void {
  mirror = db
}

export function commitAssistantConfigDelta(db: AssistantConfigDb, delta: AssistantConfigDelta, deps: object = {}) {
  return commitLocalDelta(db, delta, deps)
}

export function readAssistantConfigProjection(db: AssistantConfigDb, keys?: string[]) {
  return createProjectionBatch(db, keys)
}

export function ackAssistantConfigProjection(db: AssistantConfigDb, key: string, revision: number) {
  return ackProjection(db, key, revision)
}

export function snapshotAssistantConfig(db: AssistantConfigDb) {
  return snapshotForBaseline(db)
}
