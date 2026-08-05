/**
 * Live Dexie files catalog rollback snapshot — durable one-retained
 * snapshot gate (Phase 2 L2 promotion, LOCK-PROMO-3/5/7).
 *
 * The live files catalog lives in the renderer's IndexedDB (Dexie), so its
 * snapshot is captured through the minimal typed preload/renderer boundary
 * (see catalogApplyIpc.ts): the renderer reads the live `files` table,
 * canonicalizes the rows, and returns them; THIS module validates the wire
 * payload — including the re-derived digest BEFORE any publish (audit F3:
 * a count-consistent but wrong sha256 is rejected pre-write, never after a
 * rename has clobbered the previous retained snapshot) — writes it durably
 * at the fixed owned name {@link FILES_CATALOG_SNAPSHOT_FILENAME} (atomic
 * temp + rename + fsync), and verifies the read-back bytes (self-consistent
 * aggregate receipt).
 *
 * Privacy bound (LOCK-PROMO-12): the SNAPSHOT FILE is a retained rollback
 * artifact — it may carry the canonical rows needed for byte-identical
 * restore. The JOURNAL only ever carries the aggregate count + digest.
 *
 * Audit F6 (LOCK-ART-5): every row's `name` must be the canonical flat
 * physical filename (a single safe ASCII component — nested/traversal/
 * Unicode names are rejected) and `path`/`origin_name` must not smuggle NUL,
 * backslash, or dot-dot traversal into the retained artifact.
 *
 * Audit F1..F4 bridge closure (LOCK-BRIDGE-2): capture/restore path
 * symmetry — every retained row must be restorable through the renderer
 * restore boundary. `name` must be EXACTLY `id + ext` and `path` must be an
 * absolute filesystem path (no scheme) whose basename equals `name`; the
 * renderer capture boundary normalizes prior-target paths to this canonical
 * shape, and this wire validation rejects any relative/URL/empty/basename-
 * mismatched path so foreign/source roots never persist.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import type * as NodeCrypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import type { FilesCatalogSnapshotRow, FilesCatalogSnapshotV1 } from '@shared/chatImport/types'
import { filesCatalogHashInput } from '@shared/chatImport/types'

import { computeCatalogReceipt } from './artifactReceipts'
import { FILES_CATALOG_SNAPSHOT_FILENAME, FILES_CATALOG_SNAPSHOT_STAGING_FILENAME } from './journal'
import { fsyncDirectory, safeErrorCode } from './readonlyDbValidation'

const logger = loggerService.withContext('chatDbImportCatalogSnapshot')

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve the retained catalog snapshot path from a controlled data root. */
export function resolveCatalogSnapshotPath(dataRoot: string = DATA_PATH): string {
  return path.resolve(path.join(dataRoot, FILES_CATALOG_SNAPSHOT_FILENAME))
}

/** Resolve the catalog snapshot staging path from a data root. */
export function resolveCatalogSnapshotStagingPath(dataRoot: string = DATA_PATH): string {
  return path.resolve(path.join(dataRoot, FILES_CATALOG_SNAPSHOT_STAGING_FILENAME))
}

// ---------------------------------------------------------------------------
// Wire validation (pure)
// ---------------------------------------------------------------------------

/** True when `value` is a well-formed normalized catalog row. */
export function isValidCatalogSnapshotRow(value: unknown): value is FilesCatalogSnapshotRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 256) return false
  if (typeof r.name !== 'string' || r.name.length > 512) return false
  if (typeof r.origin_name !== 'string' || r.origin_name.length > 2048) return false
  if (typeof r.path !== 'string' || r.path.length > 4096) return false
  if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) return false
  if (typeof r.ext !== 'string' || r.ext.length > 64) return false
  if (r.type !== null && typeof r.type !== 'string') return false
  if (r.created_at !== null && typeof r.created_at !== 'string') return false
  if (typeof r.count !== 'number' || !Number.isSafeInteger(r.count) || r.count < 0) return false
  // LOCK-ART-5 (audit F6): canonical row shape. `name` is the canonical
  // physical filename — a single safe flat ASCII component (a nested /
  // traversal / Unicode / over-length name could never be a byte-identical
  // restore target or a files-parity match). `path` and `origin_name` must
  // not smuggle traversal (NUL / dot-dot / backslash) into the retained
  // artifact.
  if (!isCanonicalRowName(r.name)) return false
  if (!isSafeStoredPath(r.path)) return false
  if (r.origin_name.includes('\x00')) return false
  // LOCK-BRIDGE-2: capture/restore symmetry — the canonical physical
  // filename is EXACTLY `id + ext` (the renderer restore boundary rejects
  // anything else before mutating), and the stored `path` must be a path the
  // renderer restore boundary accepts: an absolute filesystem path (no
  // scheme / leading host) whose basename equals `name`. Relative
  // candidate-relative paths, `file://` URLs, empty paths, and basename
  // mismatches are source/foreign roots and must never persist in the
  // retained snapshot.
  if (r.name !== `${r.id}${r.ext}`) return false
  if (!isRestorableStoredPath(r.path, r.name)) return false
  return true
}

/**
 * LOCK-ART-5 (audit F6): a canonical flat row name — the same safe single
 * ASCII component contract the Files parity and snapshot manifest enforce.
 */
function isCanonicalRowName(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false
  if (name.includes('/') || name.includes('\\') || name.includes('\x00')) return false
  if (name === '.' || name === '..' || name.includes('..')) return false
  return /^[A-Za-z0-9._-]+$/.test(name)
}

/**
 * LOCK-ART-5 (audit F6): a safe stored path — no NUL, no backslash (Windows
 * absolute forms), no dot-dot traversal segment. Absolute POSIX paths (the
 * app's own storage paths) remain permitted: they are real live rows, not
 * source escapes.
 */
function isSafeStoredPath(p: string): boolean {
  if (p.includes('\x00') || p.includes('\\')) return false
  for (const segment of p.split('/')) {
    if (segment === '..') return false
  }
  return true
}

/**
 * LOCK-BRIDGE-2: a stored path the renderer restore boundary will accept —
 * an ABSOLUTE filesystem path (leading `/`, no `scheme://` host form, no
 * NUL/traversal) whose basename equals the canonical physical filename.
 * This mirrors the renderer `normalizeRestoreRows` contract so a retained
 * snapshot row is ALWAYS restorable; foreign/source roots never persist.
 */
function isRestorableStoredPath(p: string, name: string): boolean {
  if (!isSafeStoredPath(p)) return false
  if (!p.startsWith('/')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return false
  const slash = p.lastIndexOf('/')
  const basename = slash === -1 ? p : p.slice(slash + 1)
  return basename === name
}

/** True when `value` is a well-formed snapshot wire payload. */
export function isValidCatalogSnapshotWire(value: unknown): value is FilesCatalogSnapshotV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (r.version !== 1) return false
  if (typeof r.capturedAt !== 'string') return false
  if (!Array.isArray(r.rows)) return false
  // LOCK-ART-5: rows are a Dexie-primary-key set — a duplicate id can never
  // restore byte/field-identically (replace-all would collapse the pair),
  // so the wire payload is rejected outright.
  const seenIds = new Set<string>()
  for (const row of r.rows) {
    if (!isValidCatalogSnapshotRow(row)) return false
    if (seenIds.has(row.id)) return false
    seenIds.add(row.id)
  }
  const integrity = r.integrity as Record<string, unknown> | null | undefined
  if (integrity === null || typeof integrity !== 'object') return false
  if (typeof integrity.count !== 'number' || !Number.isSafeInteger(integrity.count) || integrity.count < 0) {
    return false
  }
  if (typeof integrity.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(integrity.sha256)) return false
  if (integrity.count !== r.rows.length) return false
  // Audit F3: verify the recorded digest against the re-derived receipt HERE,
  // BEFORE any publish — a count-consistent but wrong sha256 must never reach
  // the retained path (validate-before-publish, never after a rename that has
  // already clobbered the previous retained snapshot).
  const receipt = computeCatalogReceipt(r.rows as FilesCatalogSnapshotRow[])
  if (receipt.sha256 !== integrity.sha256) return false
  return true
}

/** Build a verified snapshot wire payload from canonical rows. */
export function buildCatalogSnapshotWire(
  rows: readonly FilesCatalogSnapshotRow[],
  capturedAt: string = new Date().toISOString()
): FilesCatalogSnapshotV1 {
  const receipt = computeCatalogReceipt(rows)
  return Object.freeze({
    version: 1,
    capturedAt,
    rows: Object.freeze([...rows]),
    integrity: receipt
  })
}

// ---------------------------------------------------------------------------
// Durable write + read-back
// ---------------------------------------------------------------------------

/** Bounded catalog snapshot failure codes. */
export type CatalogSnapshotFailureCode =
  | 'PAYLOAD_INVALID'
  | 'WRITE_FAILED'
  | 'DURABILITY_FAILED'
  | 'READBACK_INVALID'
  | 'DIRECTORY_SYNC_FAILED'

/** Result of {@link writeCatalogSnapshotDurable}. Never throws. */
export type CatalogSnapshotWriteResult =
  | { readonly ok: true; readonly snapshotPath: string }
  | { readonly ok: false; readonly code: CatalogSnapshotFailureCode; readonly safeCode: string | null }

/**
 * Durably write + read-back-verify the retained catalog snapshot (atomic
 * temp + rename + fsync + parent-dir fsync). The previously retained
 * snapshot is untouched on every pre-rename failure.
 */
export function writeCatalogSnapshotDurable(
  payload: FilesCatalogSnapshotV1,
  dataRoot: string = DATA_PATH
): CatalogSnapshotWriteResult {
  if (!isValidCatalogSnapshotWire(payload)) {
    return { ok: false, code: 'PAYLOAD_INVALID', safeCode: 'SCHEMA_REJECTED' }
  }
  const snapshotPath = resolveCatalogSnapshotPath(dataRoot)
  const stagingPath = resolveCatalogSnapshotStagingPath(dataRoot)
  let encoded: string
  try {
    encoded = JSON.stringify({
      version: payload.version,
      capturedAt: payload.capturedAt,
      rows: payload.rows,
      integrity: payload.integrity
    })
  } catch (error) {
    return { ok: false, code: 'WRITE_FAILED', safeCode: safeErrorCode(error) }
  }
  try {
    const fd = fs.openSync(stagingPath, 'w', 0o600)
    try {
      fs.writeFileSync(fd, encoded, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(stagingPath, snapshotPath)
  } catch (error) {
    try {
      fs.rmSync(stagingPath, { force: true })
    } catch {
      // best-effort
    }
    return { ok: false, code: 'WRITE_FAILED', safeCode: safeErrorCode(error) }
  }
  try {
    fsyncDirectory(dataRoot)
  } catch (error) {
    return { ok: false, code: 'DIRECTORY_SYNC_FAILED', safeCode: safeErrorCode(error) }
  }
  const readBack = readAndValidateCatalogSnapshot(dataRoot)
  // Audit F3: confirm the read-back digest (count AND sha256) matches the
  // payload — a divergence after rename is a bounded READBACK_INVALID.
  if (
    readBack === null ||
    readBack.integrity.count !== payload.integrity.count ||
    readBack.integrity.sha256 !== payload.integrity.sha256
  ) {
    return { ok: false, code: 'READBACK_INVALID', safeCode: 'MANIFEST_UNREADABLE' }
  }
  logger.info(`Catalog rollback snapshot retained and confirmed (rows=${payload.rows.length})`)
  return { ok: true, snapshotPath }
}

// ---------------------------------------------------------------------------
// Read + probe
// ---------------------------------------------------------------------------

/** Read + strictly validate the retained catalog snapshot. Null on ANY failure. */
export function readAndValidateCatalogSnapshot(dataRoot: string = DATA_PATH): FilesCatalogSnapshotV1 | null {
  const snapshotPath = resolveCatalogSnapshotPath(dataRoot)
  let raw: string
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isValidCatalogSnapshotWire(parsed)) return null
  const snapshot = parsed
  // Re-derive the digest — a tampered/partial snapshot is rejected.
  const receipt = computeCatalogReceipt(snapshot.rows)
  if (receipt.count !== snapshot.integrity.count || receipt.sha256 !== snapshot.integrity.sha256) {
    return null
  }
  return Object.freeze({
    version: 1,
    capturedAt: snapshot.capturedAt,
    rows: Object.freeze([...snapshot.rows]),
    integrity: Object.freeze({ count: receipt.count, sha256: receipt.sha256 })
  })
}

/** Probe status of the retained catalog snapshot. */
export type CatalogSnapshotProbeResult =
  | { readonly status: 'missing' }
  | { readonly status: 'present-unverified'; readonly detail: string | null }
  | { readonly status: 'present-verified' }

/** Probe + fully verify the retained catalog snapshot. Never throws. */
export function probeRetainedCatalogSnapshot(dataRoot: string = DATA_PATH): CatalogSnapshotProbeResult {
  const snapshotPath = resolveCatalogSnapshotPath(dataRoot)
  // lstat-based presence (audit F2/F4): a BROKEN symlink at the retained
  // snapshot path is PRESENT tamper (NOT_A_FILE), never 'missing'; a working
  // symlink is never followed into a valid-looking snapshot elsewhere.
  try {
    fs.lstatSync(snapshotPath)
  } catch (error) {
    if (safeErrorCode(error) === 'ENOENT') {
      return { status: 'missing' }
    }
    return { status: 'present-unverified', detail: 'VERIFY_FAILED' }
  }
  try {
    if (!fs.lstatSync(snapshotPath).isFile()) {
      return { status: 'present-unverified', detail: 'NOT_A_FILE' }
    }
    const snapshot = readAndValidateCatalogSnapshot(dataRoot)
    if (snapshot === null) {
      return { status: 'present-unverified', detail: 'SNAPSHOT_INVALID' }
    }
    return { status: 'present-verified' }
  } catch {
    return { status: 'present-unverified', detail: 'VERIFY_FAILED' }
  }
}

/** Canonical digest hex over rows (shared format with the renderer). */
export function catalogDigestHex(rows: readonly FilesCatalogSnapshotRow[]): string {
  const crypto = require('node:crypto') as typeof NodeCrypto
  return crypto.createHash('sha256').update(filesCatalogHashInput(rows)).digest('hex')
}
