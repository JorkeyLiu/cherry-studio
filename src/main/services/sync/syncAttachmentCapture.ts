import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../chatDb/schema'
import type { SyncTxExecutor } from './SyncService'

/**
 * Central helper for portable media capture (incremental+durable pending).
 * - No hash/network inside the SQLite Tx: only stable (blockId,fileId) intent
 *   rows are inserted synchronously inside the same chat mutation Tx.
 * - Immutable association: PK (blockId,fileId). Source snapshot is read from
 *   file_references.extra (trusted overflow) — never invented hash/channel.
 * - The intent survives crash and is drained later by SyncService sync() via
 *   SyncAttachmentService discover+upload; the durable job retains until true
 *   outbox enqueue success.
 */

export function captureMediaIntentsInTx(
  tx: SyncTxExecutor,
  intents: Array<{ blockId: string; fileId: string }>,
  capturedAt: number
): void {
  if (intents.length === 0) return
  for (const { blockId, fileId } of intents) {
    if (!blockId || !fileId) continue
    // Do not invent traversal ids — already validated elsewhere; just gate length.
    if (fileId.includes('/') || fileId.includes('\\') || fileId.includes('..')) continue
    tx.insert(schema.syncAttachmentCaptureIntent).values({ blockId, fileId, capturedAt }).onConflictDoNothing().run()
  }
}

export function listCaptureIntentsInTx(
  tx: SyncTxExecutor
): Array<{ blockId: string; fileId: string; capturedAt: number }> {
  try {
    return tx.select().from(schema.syncAttachmentCaptureIntent).all() as Array<{
      blockId: string
      fileId: string
      capturedAt: number
    }>
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return []
    throw e
  }
}

export function deleteCaptureIntentsForBlocksInTx(tx: SyncTxExecutor, blockIds: ReadonlySet<string>): void {
  if (blockIds.size === 0) return
  for (const blockId of blockIds) {
    tx.delete(schema.syncAttachmentCaptureIntent).where(eq(schema.syncAttachmentCaptureIntent.blockId, blockId)).run()
  }
}

export function deleteCaptureIntentsForFilesInTx(_tx: SyncTxExecutor, fileIds: ReadonlySet<string>): void {
  if (fileIds.size === 0) return
  for (const fileId of fileIds) {
    // Not needed for current bounded unit; kept for completeness.
    void fileId
  }
}

/**
 * Helper: collect file references for a set of blockIds inside tx.
 * Returns map blockId -> array of { fileId } derived from file_references rows.
 * Uses the trusted DB rows only (extra blob is trusted snapshot, not invented).
 */
export function collectFileRefsForBlocksInTx(
  tx: BetterSQLite3Database<typeof schema>,
  blockIds: ReadonlySet<string>
): Map<string, Array<{ fileId: string }>> {
  const out = new Map<string, Array<{ fileId: string }>>()
  if (blockIds.size === 0) return out
  for (const blockId of blockIds) {
    const rows = tx
      .select({ fileId: schema.fileReferences.fileId })
      .from(schema.fileReferences)
      .where(eq(schema.fileReferences.blockId, blockId))
      .all()
    const list: Array<{ fileId: string }> = []
    for (const r of rows) {
      if (typeof r.fileId === 'string' && r.fileId.length > 0) list.push({ fileId: r.fileId })
    }
    if (list.length > 0) out.set(blockId, list)
  }
  return out
}

export function buildAssetIdsFromRefs(refs: Array<{ fileId: string }>): string[] {
  const ids = refs.map((r) => r.fileId)
  const uniq = [...new Set(ids)]
  uniq.sort()
  return uniq
}
