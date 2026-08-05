/**
 * Files↔catalog parity verification (LOCK-PROMO-9).
 *
 * Proves that a Files directory exactly matches a candidate catalog: every
 * catalog row's payload exists at `Files/<name>` with the recorded physical
 * size AND streaming SHA-256, and no payload exists beyond the catalog
 * (degraded attachments are intentionally absent — their rows were excluded
 * from the catalog, so absence is NOT a verification failure).
 *
 * The derived aggregate receipt (count/totalBytes/sha256 over the canonical
 * sorted records) is the forward-verification truth the recovery executor
 * compares against the journal receipts.
 *
 * Pure-ish module: reads files from disk, never mutates anything.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { computeFilesReceipt, type FilesReceiptEntry } from './artifactReceipts'
import type { PromotionJournalFilesReceipt } from './journal'

/** Bounded parity failure codes. */
export type FilesParityFailureCode =
  | 'CATALOG_INVALID'
  | 'PAYLOAD_MISSING'
  | 'PAYLOAD_SIZE_MISMATCH'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'PAYLOAD_NOT_A_FILE'
  | 'EXTRA_PAYLOAD'
  | 'FILES_DIR_MISSING'
  | 'NON_REGULAR_ENTRY'

/** Result of {@link verifyFilesDirAgainstCatalog}. Never throws. */
export type FilesParityResult =
  | { readonly ok: true; readonly receipt: PromotionJournalFilesReceipt; readonly count: number }
  | { readonly ok: false; readonly code: FilesParityFailureCode }

/** Hash one file streaming (bounded memory). */
function hashFile(filePath: string): { sha256: string; size: number } {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  let size = 0
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let read = 0
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read))
      size += read
    }
  } finally {
    fs.closeSync(fd)
  }
  return { sha256: hash.digest('hex'), size }
}

/** Derive the files receipt from candidate catalog rows. */
export function filesReceiptFromCatalogEntries(entries: readonly FilesReceiptEntry[]): PromotionJournalFilesReceipt {
  return computeFilesReceipt(entries)
}

/**
 * Verify `filesDir` matches the given catalog rows exactly (row→filename→
 * size→SHA-256 parity + no extra payloads). When the catalog has zero rows,
 * a missing/empty Files dir is valid (`count 0`).
 *
 * LOCK-ART-4: the target directory is a flat canonical set of regular
 * files — a symlink, subdirectory, or any other non-regular entry is
 * REJECTED (never silently skipped), and catalog rows with duplicate or
 * case-fold-colliding names are rejected as catalog corruption. Never
 * throws (any I/O race resolves to a bounded code).
 *
 * Audit F2: the Files-root presence gate is lstat-based — a BROKEN SYMLINK
 * at the Files root is PRESENT tamper (FILES_DIR_MISSING), never certified
 * as an absent/empty generation.
 */
export function verifyFilesDirAgainstCatalog(
  filesDir: string,
  rows: readonly { name: string; size: number; sha256: string }[]
): FilesParityResult {
  // lstat-based presence (audit F2): a BROKEN symlink at the Files root is
  // PRESENT tamper — it is verified as a non-directory (FILES_DIR_MISSING),
  // never certified as an absent/empty generation.
  let dirExists = false
  try {
    fs.lstatSync(filesDir)
    dirExists = true
  } catch {
    dirExists = false
  }
  if (!dirExists && rows.length > 0) {
    return { ok: false, code: 'FILES_DIR_MISSING' }
  }
  if (dirExists) {
    let stat: fs.Stats
    try {
      // lstat: a symlink at the target dir itself is not a directory.
      stat = fs.lstatSync(filesDir)
    } catch {
      return { ok: false, code: 'FILES_DIR_MISSING' }
    }
    if (!stat.isDirectory()) {
      return { ok: false, code: 'FILES_DIR_MISSING' }
    }
  }

  // LOCK-ART-4: reject duplicate names and case-fold collisions in the
  // catalog rows (pure check — independent of the filesystem).
  const seenNames = new Set<string>()
  const seenLower = new Set<string>()
  for (const row of rows) {
    if (!/^[A-Za-z0-9._-]+$/.test(row.name) || row.name.includes('..')) {
      return { ok: false, code: 'CATALOG_INVALID' }
    }
    const lower = row.name.toLowerCase()
    if (seenNames.has(row.name) || seenLower.has(lower)) {
      return { ok: false, code: 'CATALOG_INVALID' }
    }
    seenNames.add(row.name)
    seenLower.add(lower)
  }

  const entries: FilesReceiptEntry[] = []
  const onDiskNames = new Set<string>()
  if (dirExists) {
    let names: string[]
    try {
      names = fs.readdirSync(filesDir)
    } catch {
      return { ok: false, code: 'FILES_DIR_MISSING' }
    }
    for (const name of names) {
      const fullPath = path.join(filesDir, name)
      let stat: fs.Stats
      try {
        // lstat: symlinks and non-regular entries must be rejected, not
        // followed or skipped (LOCK-ART-4).
        stat = fs.lstatSync(fullPath)
      } catch {
        return { ok: false, code: 'FILES_DIR_MISSING' }
      }
      if (!stat.isFile()) {
        return { ok: false, code: 'NON_REGULAR_ENTRY' }
      }
      onDiskNames.add(name)
    }
  }

  for (const row of rows) {
    if (!onDiskNames.has(row.name)) {
      return { ok: false, code: 'PAYLOAD_MISSING' }
    }
    const fullPath = path.join(filesDir, row.name)
    const hashed = hashFile(fullPath)
    if (hashed.size !== row.size) {
      return { ok: false, code: 'PAYLOAD_SIZE_MISMATCH' }
    }
    if (hashed.sha256 !== row.sha256) {
      return { ok: false, code: 'PAYLOAD_HASH_MISMATCH' }
    }
    entries.push({ name: row.name, size: row.size, sha256: row.sha256 })
  }

  // No payload beyond the catalog (LOCK-FIX-5 skipped payloads are never
  // extracted, so an extra file is a tamper/corruption signal).
  if (onDiskNames.size !== rows.length) {
    return { ok: false, code: 'EXTRA_PAYLOAD' }
  }

  return { ok: true, receipt: computeFilesReceipt(entries), count: rows.length }
}
