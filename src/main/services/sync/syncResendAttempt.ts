/**
 * Local-only resend attempt intent persistence (SYNC-DATA-055 intent slice).
 *
 * The reset transaction persists one intent row per resend message carrying
 * the attempt identity plus topic/message/askId, the reset timestamp, and
 * the removed old stable block IDs — never content, credentials, or paths.
 * A new reset for the same message deterministically supersedes the prior
 * row (message_id PK upsert). The intent survives restart (plain SQLite
 * row, cleared only by message/topic deletion or a superseding reset).
 *
 * This slice is lifecycle + persistence only: nothing here emits outbox
 * intent, fabricates error/final stable state, or rides the wire. The
 * `message_stable_replace` issuer that consumes the intent is a later unit.
 * While an intent is active, streaming/checkpoint/finalization writes for
 * the covered message stay local-only (callers suppress sync capture) and
 * a supplied non-matching attempt id fails closed before any write.
 *
 * Table/column names are deferred implementation projection (not ADR-locked);
 * only the future emitted op wire spelling is locked (SYNC-DATA-050).
 */
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../chatDb/schema'

export const RESEND_ATTEMPT_MIGRATION_KEY = '014_sync_resend_attempt'

/** Max safe integer bound shared with the other sync clock tables. */
const MAX_SAFE = 9007199254740991

export interface ResendAttemptIntent {
  messageId: string
  attemptId: string
  topicId: string
  askId: string | null
  resetTimestamp: number
  removedBlockIds: string[]
}

export interface StoredResendAttempt {
  messageId: string
  attemptId: string
  topicId: string
  askId: string | null
  resetTimestamp: number
  removedBlockIdsJson: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isAttemptId(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 256 && !v.includes(':') && !/[\uD800-\uDFFF]/.test(v)
}

/**
 * Strict intent validation (fail-closed): identity shape only, never content.
 * Throws on any malformed field so the enclosing aggregate transaction rolls
 * back instead of persisting a partial intent.
 */
export function validateResendAttemptIntent(intent: ResendAttemptIntent): void {
  if (!isNonEmptyString(intent.messageId)) throw new Error('resend attempt intent requires non-empty messageId')
  if (!isAttemptId(intent.attemptId)) throw new Error('resend attempt intent requires colon-free attemptId 1..256')
  if (!isNonEmptyString(intent.topicId)) throw new Error('resend attempt intent requires non-empty topicId')
  if (intent.askId !== null && !isNonEmptyString(intent.askId)) {
    throw new Error('resend attempt intent askId must be null or non-empty')
  }
  if (!Number.isSafeInteger(intent.resetTimestamp) || intent.resetTimestamp < 0 || intent.resetTimestamp > MAX_SAFE) {
    throw new Error('resend attempt intent requires safe-nonnegative resetTimestamp')
  }
  if (!Array.isArray(intent.removedBlockIds)) throw new Error('resend attempt intent requires removedBlockIds array')
  const seen = new Set<string>()
  for (const bid of intent.removedBlockIds) {
    if (!isNonEmptyString(bid)) throw new Error('resend attempt intent removedBlockIds must be non-empty strings')
    if (seen.has(bid)) throw new Error(`resend attempt intent duplicate removed block id "${bid}"`)
    seen.add(bid)
  }
}

function isNoSuchTableError(e: unknown, table: string): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return new RegExp(`no such table:\\s*${table}`, 'i').test(msg)
}

/**
 * Read one intent row. Returns null when no intent exists AND when the table
 * is proven absent (pre-014 database: migration_state exists but lacks the
 * key). Any other failure — including a missing migration_state table —
 * throws fail-closed instead of fabricating absence.
 */
export function getResendAttemptInTx(
  tx: BetterSQLite3Database<typeof schema>,
  messageId: string
): StoredResendAttempt | null {
  try {
    const row = tx
      .select()
      .from(schema.syncResendAttempt)
      .where(eq(schema.syncResendAttempt.messageId, messageId))
      .get()
    if (!row) return null
    return {
      messageId: row.messageId,
      attemptId: row.attemptId,
      topicId: row.topicId,
      askId: row.askId,
      resetTimestamp: row.resetTimestamp,
      removedBlockIdsJson: row.removedBlockIdsJson
    }
  } catch (e) {
    if (!isNoSuchTableError(e, 'sync_resend_attempt')) throw e
    // Proven pre-migration only: migration_state exists and lacks the key.
    const applied = tx
      .select()
      .from(schema.migrationState)
      .where(eq(schema.migrationState.key, RESEND_ATTEMPT_MIGRATION_KEY))
      .get()
    if (!applied) return null
    throw e instanceof Error ? e : new Error(String(e))
  }
}

/**
 * Persist (insert or deterministically supersede) one intent row in the
 * caller's transaction. Strict validation first; a throw rolls back the
 * enclosing reset transaction. Never touches outbox, clocks, or frames.
 */
export function persistResendAttemptInTx(tx: BetterSQLite3Database<typeof schema>, intent: ResendAttemptIntent): void {
  validateResendAttemptIntent(intent)
  const removedJson = JSON.stringify(intent.removedBlockIds)
  tx.insert(schema.syncResendAttempt)
    .values({
      messageId: intent.messageId,
      attemptId: intent.attemptId,
      topicId: intent.topicId,
      askId: intent.askId,
      resetTimestamp: intent.resetTimestamp,
      removedBlockIdsJson: removedJson
    })
    .onConflictDoUpdate({
      target: schema.syncResendAttempt.messageId,
      set: {
        attemptId: intent.attemptId,
        topicId: intent.topicId,
        askId: intent.askId,
        resetTimestamp: intent.resetTimestamp,
        removedBlockIdsJson: removedJson
      }
    })
    .run()
}

/**
 * Parse the stored removed-ids JSON with fail-closed semantics (malformed
 * JSON or non-string entries throw; the caller rolls back).
 */
export function parseRemovedBlockIds(stored: StoredResendAttempt): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stored.removedBlockIdsJson)
  } catch (e) {
    throw new Error(`resend attempt intent for ${stored.messageId} has malformed removedBlockIdsJson`)
  }
  if (!Array.isArray(parsed)) throw new Error(`resend attempt intent for ${stored.messageId} removed ids not an array`)
  for (const bid of parsed) {
    if (!isNonEmptyString(bid)) throw new Error(`resend attempt intent for ${stored.messageId} has bad removed id`)
  }
  return parsed as string[]
}

/**
 * Clear intent rows for deleted messages in the caller's transaction.
 * Tolerates a proven pre-014 database (no-op); anything else throws.
 */
export function clearResendAttemptsInTx(tx: BetterSQLite3Database<typeof schema>, messageIds: string[]): void {
  const ids = [...new Set(messageIds.filter((id) => isNonEmptyString(id)))]
  if (ids.length === 0) return
  try {
    for (const id of ids) {
      tx.delete(schema.syncResendAttempt).where(eq(schema.syncResendAttempt.messageId, id)).run()
    }
  } catch (e) {
    if (!isNoSuchTableError(e, 'sync_resend_attempt')) throw e
    const applied = tx
      .select()
      .from(schema.migrationState)
      .where(eq(schema.migrationState.key, RESEND_ATTEMPT_MIGRATION_KEY))
      .get()
    if (!applied) return
    throw e instanceof Error ? e : new Error(String(e))
  }
}

/**
 * Clear intent rows for a wiped topic in the caller's transaction.
 * Tolerates a proven pre-014 database (no-op); anything else throws.
 */
export function clearResendAttemptsForTopicInTx(tx: BetterSQLite3Database<typeof schema>, topicId: string): void {
  if (!isNonEmptyString(topicId)) return
  try {
    tx.delete(schema.syncResendAttempt).where(eq(schema.syncResendAttempt.topicId, topicId)).run()
  } catch (e) {
    if (!isNoSuchTableError(e, 'sync_resend_attempt')) throw e
    const applied = tx
      .select()
      .from(schema.migrationState)
      .where(eq(schema.migrationState.key, RESEND_ATTEMPT_MIGRATION_KEY))
      .get()
    if (!applied) return
    throw e instanceof Error ? e : new Error(String(e))
  }
}
