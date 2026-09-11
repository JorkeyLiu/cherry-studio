/**
 * Per-(kind, parent_id) winning-frame timestamp high-water (SYNC-DATA-048
 * local implementation invariant, migration 012).
 *
 * Invalidation deletes the winning frame row but must never lower this mark:
 * allocation takes max(high-water, existing frame, included membership
 * clocks)+1 in the same transaction and advances the mark atomically, so a
 * re-mint after invalidation can never reuse an old timestamp with a fresh
 * random operationId (which could otherwise lose LWW remotely to the
 * invalidated winner). Only a max timestamp is stored — no operationId —
 * because local mints always advance strictly +1. Never on wire; never
 * affects candidate completeness/authority.
 *
 * Single unified helper used by every frame-landing path (SyncService local
 * issuance + remote incremental apply via persistParentFrameInTx, and the
 * shared baseline merge core in syncBaselineApply.ts). Standalone module so
 * both consumers share one implementation without import cycles.
 */
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../chatDb/schema'

export const FRAME_HIGH_WATER_MAX_TIMESTAMP = 9007199254740991
export const FRAME_HIGH_WATER_MIGRATION_KEY = '012_sync_frame_high_water'

export type FrameHighWaterKind = 'topicMessage' | 'messageBlock'

/** Transaction executor compatible with the root Drizzle database and tx executors. Never opens its own transaction. */
export type FrameHighWaterExecutor = BetterSQLite3Database<typeof schema>

function isValidKind(kind: string): kind is FrameHighWaterKind {
  return kind === 'topicMessage' || kind === 'messageBlock'
}

function isMissingTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /no such table/i.test(msg)
}

/**
 * Proven pre-migration miss: the high-water table is absent AND
 * migration_state on the same database explicitly proves 012 was never
 * applied (absent row). Any present 012 row, any other failure, or an
 * unreadable migration_state means post-migration damage — fail closed.
 */
function isProvenHighWaterNotApplied(exec: FrameHighWaterExecutor): boolean {
  try {
    const row = exec
      .select()
      .from(schema.migrationState)
      .where(eq(schema.migrationState.key, FRAME_HIGH_WATER_MIGRATION_KEY))
      .get()
    return !row
  } catch {
    return false
  }
}

/**
 * Read the high-water mark for a parent. Returns -1 when no mark exists
 * (never minted/merged for this parent). Throws Error on invalid kind /
 * parentId / malformed stored row. A proven pre-012 database (table absent,
 * migration never applied) reads as -1 to preserve pre-high-water behavior;
 * post-migration damage fails closed.
 */
export function getFrameHighWater(exec: FrameHighWaterExecutor, kind: string, parentId: string): number {
  if (!isValidKind(kind)) throw new Error(`invalid frame high-water kind ${String(kind).slice(0, 40)}`)
  if (typeof parentId !== 'string' || parentId.length === 0) {
    throw new Error(`invalid frame high-water parentId ${String(parentId).slice(0, 40)}`)
  }
  try {
    const row = exec
      .select()
      .from(schema.syncFrameHighWater)
      .where(eq(schema.syncFrameHighWater.kind, kind))
      .all()
      .find((r) => r.parentId === parentId)
    if (!row) return -1
    if (
      !Number.isSafeInteger(row.maxTimestamp) ||
      row.maxTimestamp < 0 ||
      row.maxTimestamp > FRAME_HIGH_WATER_MAX_TIMESTAMP
    ) {
      throw new Error(`malformed frame high-water timestamp for ${kind}/${parentId}`)
    }
    return row.maxTimestamp
  } catch (e) {
    if (isMissingTableError(e) && isProvenHighWaterNotApplied(exec)) return -1
    throw e instanceof Error ? e : new Error(String(e))
  }
}

/**
 * Advance the high-water mark to max(existing, timestamp) in the caller's
 * transaction (single upsert statement — atomic, never an early commit).
 * Throws Error on invalid kind / parentId / timestamp (must be a safe
 * non-negative integer within bounds). Never lowers the mark. A proven
 * pre-012 database skips the write to preserve pre-high-water behavior;
 * post-migration damage fails closed.
 */
export function advanceFrameHighWater(
  exec: FrameHighWaterExecutor,
  kind: string,
  parentId: string,
  timestamp: number
): void {
  if (!isValidKind(kind)) throw new Error(`invalid frame high-water kind ${String(kind).slice(0, 40)}`)
  if (typeof parentId !== 'string' || parentId.length === 0) {
    throw new Error(`invalid frame high-water parentId ${String(parentId).slice(0, 40)}`)
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > FRAME_HIGH_WATER_MAX_TIMESTAMP) {
    throw new Error(`invalid frame high-water timestamp ${String(timestamp).slice(0, 40)}`)
  }
  try {
    exec
      .insert(schema.syncFrameHighWater)
      .values({ kind, parentId, maxTimestamp: timestamp })
      .onConflictDoUpdate({
        target: [schema.syncFrameHighWater.kind, schema.syncFrameHighWater.parentId],
        set: { maxTimestamp: sql`max(${schema.syncFrameHighWater.maxTimestamp}, ${timestamp})` }
      })
      .run()
  } catch (e) {
    if (isMissingTableError(e) && isProvenHighWaterNotApplied(exec)) return
    throw e instanceof Error ? e : new Error(String(e))
  }
}
