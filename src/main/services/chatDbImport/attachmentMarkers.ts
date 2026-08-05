/**
 * Candidate-DB attachment availability marker mutation (LOCK-UI-2/3/4/5/6).
 *
 * Before the candidate is sealed, the orchestrator marks EVERY imported
 * file/image block that references a reference-degraded file as unavailable
 * by persisting the import-only marker into the block overflow
 * (`l2AttachmentUnavailable`, a namespaced TOP-LEVEL overflow key, see
 * {@link attachmentAvailability}).
 *
 * The mutation is:
 * - Transactional (LOCK-UI-4): one SQLite transaction; ANY failure rolls
 *   back every write and rejects candidate finalization (the orchestrator
 *   routes the failure into the error/discard lifecycle). No live mutation.
 * - Reference-scoped (LOCK-UI-2): only blocks with a committed
 *   `file_references` row whose `file_id` is in the degraded set are marked.
 *   Healthy files, skipped unreferenced orphan payloads, and degraded-but-
 *   unreferenced catalog files mark nothing.
 * - Non-destructive (LOCK-UI-3): only the marker key is added to the block
 *   `extra` JSON. Columns, `file_references` rows, display metadata, and
 *   every other overflow key are preserved byte-for-byte.
 * - Deterministic + idempotent (LOCK-UI-6): re-running is a no-op (blocks
 *   already carrying the marker are skipped); the same degraded file across
 *   multiple blocks marks ALL of its blocks (LOCK-UI-4).
 * - Privacy-safe (LOCK-UI-5): the return value is aggregate counts ONLY.
 *   Never logs/returns/throws file IDs, block IDs, paths, names, or content.
 *
 * Main-only module. Never expose over IPC/preload/renderer.
 */

import { markBlockAttachmentUnavailable } from '@main/services/chatDb/attachmentAvailability'
import type Database from 'better-sqlite3'

/** Aggregate-only result of {@link markUnavailableAttachmentBlocks}. */
export interface AttachmentMarkerResult {
  /** Number of message_blocks whose `extra` was actually changed. */
  readonly markedBlockCount: number
  /**
   * Number of UNIQUE degraded file ids actually PROCESSED — i.e. the ids that
   * passed the string-validity filter and drove the reference lookups
   * (aggregate — never the ids themselves). Duplicate ids are de-duplicated
   * deterministically before batching, so each id is counted once.
   * Non-string/empty ids are excluded from the count because they were never
   * processed.
   */
  readonly degradedFileIdCount: number
}

/** Per-batch IN-clause bound to SQLite's compiled-variable limit (999). */
const IN_BATCH_SIZE = 500

/** Fail-closed, content-free error for candidate DB anomalies (LOCK-UI-3). */
export class AttachmentMarkerError extends Error {
  constructor(context: string) {
    super(`Attachment availability marker failed during ${context} (fail closed).`)
    this.name = 'AttachmentMarkerError'
  }
}

/**
 * Mark every imported file/image block referencing one of the degraded file
 * ids as unavailable. Runs as ONE SQLite transaction; a throw rolls back all
 * writes. Idempotent: blocks already marked are skipped.
 *
 * @param sqlite           Raw better-sqlite3 handle of the candidate DB
 *                         (CandidateDbResource.getSqlite()).
 * @param degradedFileIds  Privacy-internal reference-degraded file ids from
 *                         the attachment plane (Main-only, never IPC).
 * @returns Aggregate-only marked/degraded counts.
 * @throws {AttachmentMarkerError} on any candidate DB anomaly (fail closed).
 */
export function markUnavailableAttachmentBlocks(
  sqlite: unknown,
  degradedFileIds: readonly string[]
): AttachmentMarkerResult {
  const db = sqlite as Database.Database
  if (db === null || typeof db !== 'object' || typeof (db as { prepare?: unknown }).prepare !== 'function') {
    throw new AttachmentMarkerError('handle validation')
  }
  // LOCK-UI-5: keep only safe strings, then de-duplicate deterministically
  // (first-seen order) so each id drives exactly one reference lookup and the
  // aggregate degraded count is UNIQUE safe ids — raw ids never leave here.
  const safeIds = [...new Set(degradedFileIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (safeIds.length === 0) {
    return { markedBlockCount: 0, degradedFileIdCount: safeIds.length }
  }

  const updateExtra = db.prepare(`UPDATE message_blocks SET extra = ? WHERE id = ?`)

  // LOCK-UI-4: one transaction — a throw rolls back every marker write and
  // rejects candidate finalization (the caller routes it into the error
  // lifecycle). No live mutation is possible.
  const run = db.transaction(() => {
    let marked = 0
    for (let offset = 0; offset < safeIds.length; offset += IN_BATCH_SIZE) {
      const batch = safeIds.slice(offset, offset + IN_BATCH_SIZE)
      // F-1: prepare the SELECT per batch so the IN-clause placeholder count
      // EXACTLY matches the bound values — no binding mismatch — and each
      // statement stays well under SQLite's compiled-variable limit (999).
      const selectBatch = db.prepare(
        `SELECT DISTINCT b.id AS id, b.extra AS extra
           FROM message_blocks b
           JOIN file_references fr ON fr.block_id = b.id
          WHERE fr.file_id IN (${batch.map(() => '?').join(', ')})`
      )
      const rows = selectBatch.all(...batch) as Array<{ id: string; extra: string | null }>
      for (const row of rows) {
        const overflow = decodeExtra(row.extra)
        let next: Record<string, unknown>
        try {
          next = markBlockAttachmentUnavailable(overflow)
        } catch {
          // LOCK-UI-3: a non-object `metadata` cannot be merged without
          // destroying the original metadata — fail closed, roll back all.
          throw new AttachmentMarkerError('metadata merge')
        }
        if (next === overflow) {
          continue // already marked — idempotent no-op
        }
        updateExtra.run(encodeExtra(next), row.id)
        marked += 1
      }
    }
    return marked
  })

  return { markedBlockCount: run(), degradedFileIdCount: safeIds.length }
}

/**
 * Decode a message_blocks `extra` column to an overflow object.
 * `null`/empty/`{}` normalize to `{}`. Malformed JSON throws a content-free
 * AttachmentMarkerError (LOCK-UI-3: no raw value in the message).
 */
function decodeExtra(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === '' || raw === '{}') {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new AttachmentMarkerError('extra JSON decode')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AttachmentMarkerError('extra shape validation')
  }
  return parsed as Record<string, unknown>
}

/**
 * Encode the merged overflow back into the `extra` column using the same
 * normalization as the persistence codec (empty object → SQL NULL).
 * Throws a content-free AttachmentMarkerError on serialization failure.
 */
function encodeExtra(overflow: Record<string, unknown>): string | null {
  if (Object.keys(overflow).length === 0) {
    return null
  }
  try {
    return JSON.stringify(overflow)
  } catch {
    throw new AttachmentMarkerError('extra JSON encode')
  }
}
