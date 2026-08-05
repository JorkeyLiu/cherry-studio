/**
 * Aggregate artifact receipts — pure computation helpers for the v2
 * promotion journal (LOCK-PROMO-9/12).
 *
 * Receipts are aggregate integrity evidence ONLY: counts + canonical
 * SHA-256 digests. They never carry private filenames, paths, content, or
 * raw file IDs in the JOURNAL — the digest input is the canonical record
 * encoding below and only the digest + count + byte totals are journaled.
 *
 * Three artifacts:
 * - db      — SHA-256 + byte size of a chat.db file.
 * - files   — derived from canonical per-file records `{name, size, sha256}`
 *             (the candidate catalog rows or the snapshot manifest entries);
 *             the digest covers the sorted `name\0size\0sha256` records.
 * - catalog — derived from canonical catalog rows `{id, name, size, count}`;
 *             the digest covers the sorted `id\0name\0size\0count` records.
 *
 * The derivations are deterministic: identical input records produce
 * identical digests regardless of input order.
 */

import crypto from 'node:crypto'

import { filesCatalogHashInput } from '@shared/chatImport/types'

import type {
  PromotionArtifactReceipts,
  PromotionJournalCatalogReceipt,
  PromotionJournalDbReceipt,
  PromotionJournalFilesReceipt
} from './journal'

/** Canonical per-file record used for the files receipt. */
export interface FilesReceiptEntry {
  /** Canonical physical filename (`<id><ext>` — a safe single component). */
  readonly name: string
  /** Physical payload size in bytes. */
  readonly size: number
  /** Streaming SHA-256 hex of the payload. */
  readonly sha256: string
}

/** Canonical catalog row record used for the catalog receipt. */
export interface CatalogReceiptRow {
  /** Source file id (Dexie files primary key). */
  readonly id: string
  /** Canonical physical filename. */
  readonly name: string
  /** Physical payload size in bytes. */
  readonly size: number
  /** Rebuilt reference count. */
  readonly count: number
}

/** Compute the aggregate files receipt from canonical per-file records. */
export function computeFilesReceipt(entries: readonly FilesReceiptEntry[]): PromotionJournalFilesReceipt {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const hash = crypto.createHash('sha256')
  let totalBytes = 0
  for (const entry of sorted) {
    hash.update(`${entry.name}\0${entry.size}\0${entry.sha256}\n`)
    totalBytes += entry.size
  }
  return Object.freeze({
    count: sorted.length,
    totalBytes,
    sha256: hash.digest('hex')
  })
}

/** Compute the aggregate catalog receipt from canonical catalog rows. */
export function computeCatalogReceipt(rows: readonly CatalogReceiptRow[]): PromotionJournalCatalogReceipt {
  const hash = crypto.createHash('sha256')
  // The digest input must be EXACTLY filesCatalogHashInput (shared with the
  // renderer boundary) so main/renderer aggregate receipts always agree.
  hash.update(
    filesCatalogHashInput(rows.map((r) => ({ ...r, origin_name: '', path: '', ext: '', type: null, created_at: null })))
  )
  return Object.freeze({
    count: rows.length,
    sha256: hash.digest('hex')
  })
}

/**
 * Compute the aggregate db receipt for a chat.db file. Streams the file to
 * bound memory. Throws on I/O failure (caller maps to a bounded code).
 */
export async function computeDbReceipt(filePath: string): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256')
  let size = 0
  const handle = await import('node:fs/promises').then((fs) => fs.open(filePath, 'r'))
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let read = 0
    while ((read = await handle.read(buffer, 0, buffer.length, null).then((r) => r.bytesRead)) > 0) {
      hash.update(buffer.subarray(0, read))
      size += read
    }
  } finally {
    await handle.close()
  }
  return Object.freeze({ sha256: hash.digest('hex'), size })
}

/** An all-null (not-yet-captured or absent) artifact receipt block. */
export function emptyArtifactReceipts(): PromotionArtifactReceipts {
  return Object.freeze({ db: null, files: null, catalog: null })
}

/** True when every artifact in the block is null (nothing captured). */
export function isAllNullReceipts(receipts: PromotionArtifactReceipts): boolean {
  return receipts.db === null && receipts.files === null && receipts.catalog === null
}

/**
 * Exact candidate-receipt identity of a live chat.db (LOCK-AMB-3).
 *
 * True ONLY after a successful exact size + SHA-256 comparison of the actual
 * live DB receipt against a NON-NULL candidate db receipt. A null candidate
 * receipt (the promotion carried no db — contradictory for a promotion), an
 * unreadable/missing live DB (the caller maps I/O failure onto the boolean
 * path before calling), or any divergence is FALSE — fail closed.
 *
 * This is the generation identity that the coarse `present-verified` probe
 * status cannot provide: BOTH the old and the candidate generations pass
 * SQLite integrity/FK/sample gates, so only the journaled receipt can tell
 * them apart. A rollback-midway crash restores the OLD db while the new
 * Files/catalog are still live — that state must never look like the new
 * generation (LOCK-AMB-4).
 */
export function liveDbReceiptMatchesCandidate(
  actual: { readonly sha256: string; readonly size: number },
  candidate: PromotionJournalDbReceipt | null
): boolean {
  if (candidate === null) return false
  return actual.sha256 === candidate.sha256 && actual.size === candidate.size
}
