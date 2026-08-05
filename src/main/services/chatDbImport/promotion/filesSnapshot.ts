/**
 * Live Files directory rollback snapshot — durable one-retained snapshot
 * gate (Phase 2 L2 promotion, LOCK-PROMO-3/4/6).
 *
 * Mirrors the chat.db rollback snapshot contract for the LIVE `Files`
 * directory:
 *
 *   1. create-files-snapshot   — recursive copy of the live `Files`
 *      directory into the fixed staging dir
 *      {@link FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME}, computing a
 *      streaming SHA-256 per file and a verified manifest
 *      (LOCK-PROMO-3: retained BEFORE any live mutation).
 *   2. verify-files-snapshot    — manifest integrity + per-file size/SHA-256
 *      re-verification of the staging copy (a partial copy from a crash is
 *      deterministically caught).
 *   3. publish-files-snapshot   — durable atomic rename staging → retained
 *      {@link FILES_ROLLBACK_SNAPSHOT_DIRNAME} (one-retained ordering) with
 *      parent-directory fsync and retained-existence confirmation.
 *
 *  Empty/missing live Files is a first-class state: the snapshot records
 *  `kind: 'empty'` with zero entries, so a later rollback can restore the
 *  absence (LOCK-PROMO-6/verification: "empty/missing live Files handled").
 *  A BROKEN SYMLINK is PRESENT tamper (audit F2) — it is rejected as a
 *  non-directory, never snapshotted as an empty generation.
 *
 *  Audit F5: an empty retained snapshot is restored as EXACT ABSENCE — the
 *  rollback removes the live/swap-staging/staging owned directories and
 *  leaves the live Files path genuinely absent (ENOENT), never a
 *  present-empty directory. The empty receipt (count 0 / totalBytes 0 /
 *  empty sha256) remains exact for the caller.
 *
 * Audit F1 (LOCK-ART-4): every live filename is validated BEFORE any copy —
 * canonical flat ASCII component shape + no case-fold collisions — so the
 * published manifest can never fail its own flat/duplicate validation.
 *
 * Audit F4: retained-root probes and restores use lstat consistently — a
 * symlinked retained root (broken or working) is tamper, never followed.
 *
 * Failure semantics: any failure leaves the previously retained snapshot
 * byte-for-byte untouched — only the staging dir is cleaned up. The live
 * Files directory is never mutated by this unit.
 *
 * This unit NEVER writes the promotion journal (LOCK-4417 analog); the
 * caller journals `snapshots-ready` only after an `ok: true` result.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'

import { computeFilesReceipt, type FilesReceiptEntry } from './artifactReceipts'
import {
  FILES_PROMOTE_STAGING_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME,
  type PromotionJournalFilesReceipt
} from './journal'
import { fsyncDirectory, safeErrorCode } from './readonlyDbValidation'

const logger = loggerService.withContext('chatDbImportFilesSnapshot')

/** Live Files directory name — always at the Data root. */
export const LIVE_FILES_DIRNAME = 'Files'

/** Manifest filename inside the retained snapshot dir. */
export const FILES_SNAPSHOT_MANIFEST_FILENAME = 'manifest.json'

/** Snapshot manifest schema version. */
export const FILES_SNAPSHOT_MANIFEST_VERSION = 1 as const

/**
 * Fixed transient name for the superseded retained generation during a
 * one-retained replacement. Module-internal: recovery reads the ACTIVE
 * retained name only; this path exists only inside the publish window.
 * Exported so the L3 backup filter can exclude it without string drift.
 */
export const FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME = 'Files.pre-import-backup.old'

// ---------------------------------------------------------------------------
// Wire types — the snapshot manifest (a retained rollback artifact, NOT the
// journal, so per-file entries are allowed; still no source absolute paths).
// ---------------------------------------------------------------------------

/** One file entry in the snapshot manifest. `rel` is Files-root-relative. */
export interface FilesSnapshotManifestEntry {
  /** Files-root-relative path (safe single/multi components, no `..`). */
  readonly rel: string
  /** Physical payload size in bytes. */
  readonly size: number
  /** Streaming SHA-256 hex of the payload. */
  readonly sha256: string
}

/** Durable Files snapshot manifest (self-verifying aggregate evidence). */
export interface FilesSnapshotManifestV1 {
  readonly version: typeof FILES_SNAPSHOT_MANIFEST_VERSION
  readonly capturedAt: string
  /** 'empty' when the live Files dir was missing/empty at capture time. */
  readonly kind: 'empty' | 'populated'
  readonly entries: readonly FilesSnapshotManifestEntry[]
  /** Aggregate receipt derived from the entries (self-verification). */
  readonly integrity: PromotionJournalFilesReceipt
}

/** Result of {@link prepareFilesRollbackSnapshot}. Never throws. */
export type FilesRollbackSnapshotResult =
  | {
      readonly ok: true
      /** Absolute path of the confirmed retained Files snapshot dir. */
      readonly retainedDir: string
      /** Aggregate receipt of the old live Files generation. */
      readonly receipt: PromotionJournalFilesReceipt
      readonly kind: 'empty' | 'populated'
    }
  | {
      readonly ok: false
      readonly code: FilesSnapshotFailureCode
      readonly safeCode: string | null
      /** True when the previously retained snapshot (if any) is untouched. */
      readonly oldRetainedPreserved: boolean
    }

/** Bounded machine-readable Files snapshot failure codes. */
export type FilesSnapshotFailureCode =
  | 'SOURCE_STAT_FAILED'
  | 'STAGING_COPY_FAILED'
  | 'STAGING_VERIFY_FAILED'
  | 'STAGING_DURABILITY_FAILED'
  | 'RETAINED_PUBLISH_FAILED'
  | 'RETAINED_DIRECTORY_SYNC_FAILED'
  | 'RETAINED_CONFIRMATION_FAILED'
  | 'MANIFEST_ENCODE_FAILED'

export interface PrepareFilesSnapshotOptions {
  /** Directory containing the live Files dir (the Data root). */
  dataRoot: string
  /** Test-only hook after the copy+verify, before the publish rename. */
  onBeforePublish?: () => void
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve the live Files directory path from a controlled data root. */
export function resolveLiveFilesDir(dataRoot: string = DATA_PATH): string {
  return path.resolve(path.join(dataRoot, LIVE_FILES_DIRNAME))
}

/** Resolve the retained Files snapshot dir path from a data root. */
export function resolveRetainedFilesSnapshotDir(dataRoot: string = DATA_PATH): string {
  return path.resolve(path.join(dataRoot, FILES_ROLLBACK_SNAPSHOT_DIRNAME))
}

/** Resolve the Files snapshot staging dir path from a data root. */
export function resolveFilesSnapshotStagingDir(dataRoot: string = DATA_PATH): string {
  return path.resolve(path.join(dataRoot, FILES_ROLLBACK_SNAPSHOT_STAGING_DIRNAME))
}

/** Resolve the manifest path inside a snapshot dir. */
export function resolveFilesSnapshotManifestPath(snapshotDir: string): string {
  return path.join(snapshotDir, FILES_SNAPSHOT_MANIFEST_FILENAME)
}

// ---------------------------------------------------------------------------
// Manifest codec (pure)
// ---------------------------------------------------------------------------

/** Encode a manifest to canonical JSON bytes (deterministic key order). */
export function encodeFilesSnapshotManifest(manifest: FilesSnapshotManifestV1): string {
  return JSON.stringify({
    version: manifest.version,
    capturedAt: manifest.capturedAt,
    kind: manifest.kind,
    entries: manifest.entries,
    integrity: manifest.integrity
  })
}

/**
 * Read + strictly validate a snapshot manifest. Returns null on ANY
 * failure (missing file, parse error, schema violation, unsafe rel path,
 * integrity mismatch). Never throws.
 */
export function readAndValidateFilesSnapshotManifest(manifestPath: string): FilesSnapshotManifestV1 | null {
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.version !== FILES_SNAPSHOT_MANIFEST_VERSION) return null
  if (typeof record.capturedAt !== 'string') return null
  if (record.kind !== 'empty' && record.kind !== 'populated') return null
  if (!Array.isArray(record.entries)) return null
  const entries: FilesSnapshotManifestEntry[] = []
  const seenRels = new Set<string>()
  const seenLower = new Set<string>()
  for (const entry of record.entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const e = entry as Record<string, unknown>
    if (typeof e.rel !== 'string' || !isSafeRelPath(e.rel)) return null
    // LOCK-ART-4: the manifest is a flat canonical target set — every rel is
    // exactly ONE filename component (never a nested path).
    if (e.rel.includes('/')) return null
    if (typeof e.size !== 'number' || !Number.isSafeInteger(e.size) || e.size < 0) return null
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return null
    // LOCK-ART-4: the manifest is a flat canonical target set — a duplicate
    // rel (exact or case-fold) is a tamper signal and is rejected.
    const lower = e.rel.toLowerCase()
    if (seenRels.has(e.rel) || seenLower.has(lower)) return null
    seenRels.add(e.rel)
    seenLower.add(lower)
    entries.push({ rel: e.rel, size: e.size, sha256: e.sha256 })
  }
  if (record.kind === 'empty' && entries.length !== 0) return null
  // Integrity re-derivation must match exactly (self-verifying).
  const integrity = computeFilesReceipt(manifestEntriesToReceiptEntries(entries))
  const recorded = record.integrity as Record<string, unknown> | null | undefined
  if (recorded === null || typeof recorded !== 'object') return null
  if (
    recorded.count !== integrity.count ||
    recorded.totalBytes !== integrity.totalBytes ||
    recorded.sha256 !== integrity.sha256
  ) {
    return null
  }
  return Object.freeze({
    version: FILES_SNAPSHOT_MANIFEST_VERSION,
    capturedAt: record.capturedAt,
    kind: record.kind,
    entries: Object.freeze(entries),
    integrity
  })
}

/** True when `rel` is a safe relative path (no traversal, no NUL). */
export function isSafeRelPath(rel: string): boolean {
  if (rel.length === 0 || rel.length > 512) return false
  if (rel.includes('\x00')) return false
  const parts = rel.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return false
    if (part.includes('\\')) return false
  }
  return true
}

/**
 * LOCK-ART-4 (audit F1): a canonical flat Files filename — a single safe
 * ASCII path component (no separators, no traversal, no NUL, no Unicode,
 * bounded length). The live Files contract is a flat canonical target set of
 * `Files/<id><ext>` payloads, so every live filename is validated BEFORE any
 * copy/publish: a non-canonical name would produce a manifest that fails its
 * own validation (the flat/case-fold duplicate gates), i.e. a self-rejected
 * snapshot — a validate-after-publish gap.
 */
export function isCanonicalFlatFilename(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false
  if (name.includes('/') || name.includes('\\') || name.includes('\x00')) return false
  if (name === '.' || name === '..' || name.includes('..')) return false
  return /^[A-Za-z0-9._-]+$/.test(name)
}

/**
 * lstat-based presence (audit F2): an entry is PRESENT when lstat succeeds —
 * a broken symlink is present tamper, never 'missing'. Returns false only
 * for a genuine ENOENT (or a stat error the caller chooses to treat as
 * absent). Never throws.
 */
function lstatPresent(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Copy + hash walk
// ---------------------------------------------------------------------------

/** Stream one file computing SHA-256 + byte size (bounded memory). */
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

/** Copy + hash one file into the staging dir (bounded streaming copy). */
function copyFileWithHash(srcPath: string, destPath: string): FilesSnapshotManifestEntry {
  const hash = crypto.createHash('sha256')
  let srcFd: number | null = null
  let destFd: number | null = null
  try {
    srcFd = fs.openSync(srcPath, 'r')
    // LOCK-ART-6: preserve the source permissions exactly — a umask-restricted
    // plain openSync would silently widen a private source file.
    const srcMode = fs.fstatSync(srcFd).mode & 0o777
    destFd = fs.openSync(destPath, 'w', srcMode)
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let read = 0
    let size = 0
    while ((read = fs.readSync(srcFd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read))
      fs.writeSync(destFd, buffer.subarray(0, read))
      size += read
    }
    fs.chmodSync(destPath, srcMode)
    fs.fsyncSync(destFd)
    return { rel: path.basename(srcPath), size, sha256: hash.digest('hex') }
  } finally {
    // Close only the handles that were actually opened (an open failure must
    // propagate its own error, not a closeSync(undefined) masking throw).
    if (destFd !== null) fs.closeSync(destFd)
    if (srcFd !== null) fs.closeSync(srcFd)
  }
}

/** Map manifest entries to the canonical files-receipt entry shape. */
function manifestEntriesToReceiptEntries(entries: readonly FilesSnapshotManifestEntry[]): readonly FilesReceiptEntry[] {
  return entries.map((entry) => ({ name: entry.rel, size: entry.size, sha256: entry.sha256 }))
}

// ---------------------------------------------------------------------------
// prepareFilesRollbackSnapshot — copy → verify → publish → confirm
// ---------------------------------------------------------------------------

/**
 * Create, verify, and durably publish the ONE retained rollback snapshot of
 * the live Files directory (LOCK-PROMO-3 ordering):
 *
 *   live Files walk → staging copy with streaming SHA-256 + manifest
 *   → per-file size/SHA-256 re-verification → fsync staging
 *   → atomic rename staging → retained → fsync parent → confirm retained.
 *
 * A missing/empty live Files dir is snapshotted as `kind: 'empty'`
 * (zero entries) so rollback can deterministically restore the absence.
 * The previously retained snapshot is replaced ONLY by the atomic rename of
 * an already-verified staging dir; every earlier failure leaves it
 * untouched and cleans up staging.
 */
export function prepareFilesRollbackSnapshot(options: PrepareFilesSnapshotOptions): FilesRollbackSnapshotResult {
  const dataRoot = options.dataRoot
  const liveFilesDir = resolveLiveFilesDir(dataRoot)
  const stagingDir = resolveFilesSnapshotStagingDir(dataRoot)
  const retainedDir = resolveRetainedFilesSnapshotDir(dataRoot)

  // Stale staging from an earlier interrupted attempt is ours to discard.
  fs.rmSync(stagingDir, { recursive: true, force: true })

  const failure = (
    code: FilesSnapshotFailureCode,
    safeCode: string | null,
    oldRetainedPreserved: boolean
  ): FilesRollbackSnapshotResult => {
    logger.warn(`Files rollback snapshot failed (${code}): ${safeCode ?? 'no sub-code'}`)
    fs.rmSync(stagingDir, { recursive: true, force: true })
    return Object.freeze({ ok: false as const, code, safeCode, oldRetainedPreserved })
  }

  // --- Determine the source generation -----------------------------------
  const liveEntries: Array<{ rel: string; absPath: string }> = []
  try {
    // lstat-based presence (audit F2): a BROKEN symlink at the live Files
    // root lstat-succeeds — it is PRESENT tamper (NOT_A_DIRECTORY), never a
    // missing/empty generation.
    let livePresent = false
    try {
      const stat = fs.lstatSync(liveFilesDir)
      livePresent = true
      if (!stat.isDirectory()) {
        return failure('SOURCE_STAT_FAILED', 'NOT_A_DIRECTORY', true)
      }
    } catch (error) {
      if (safeErrorCode(error) !== 'ENOENT') {
        return failure('SOURCE_STAT_FAILED', safeErrorCode(error), true)
      }
    }
    if (livePresent) {
      // Flat contract (LOCK-ART-4): live Files payloads are flat canonical
      // Files/<id><ext> REGULAR files. A symlink, subdirectory, or any other
      // non-regular entry is a tamper/corruption signal and is REJECTED —
      // never silently skipped (a silent skip would misrepresent the
      // rollback authority captured here).
      const names = fs.readdirSync(liveFilesDir)
      // Audit F1: validate every live filename (canonical flat shape) and
      // case-fold collisions BEFORE any copy — the published manifest would
      // otherwise fail its own flat/duplicate validation (self-rejection).
      const seenLower = new Set<string>()
      for (const name of names) {
        if (!isCanonicalFlatFilename(name)) {
          return failure('SOURCE_STAT_FAILED', 'NON_CANONICAL_FILENAME', true)
        }
        const lower = name.toLowerCase()
        if (seenLower.has(lower)) {
          return failure('SOURCE_STAT_FAILED', 'CASE_FOLD_COLLISION', true)
        }
        seenLower.add(lower)
        let s: fs.Stats
        try {
          s = fs.lstatSync(path.join(liveFilesDir, name))
        } catch (error) {
          return failure('SOURCE_STAT_FAILED', safeErrorCode(error), true)
        }
        if (!s.isFile()) {
          return failure('SOURCE_STAT_FAILED', 'NON_REGULAR_ENTRY', true)
        }
        liveEntries.push({ rel: name, absPath: path.join(liveFilesDir, name) })
      }
    }
  } catch (error) {
    return failure('SOURCE_STAT_FAILED', safeErrorCode(error), true)
  }

  const kind: 'empty' | 'populated' = liveEntries.length === 0 ? 'empty' : 'populated'

  try {
    fs.mkdirSync(stagingDir, { recursive: true })
    const copied: FilesSnapshotManifestEntry[] = []
    // --- Step 1: streaming copy + hash -----------------------------------
    for (const entry of liveEntries) {
      let copiedEntry: FilesSnapshotManifestEntry
      try {
        copiedEntry = copyFileWithHash(entry.absPath, path.join(stagingDir, entry.rel))
      } catch (error) {
        return failure('STAGING_COPY_FAILED', safeErrorCode(error), true)
      }
      // Written byte count must equal the source byte count.
      let sourceSize = -1
      try {
        sourceSize = fs.statSync(entry.absPath).size
      } catch (error) {
        return failure('SOURCE_STAT_FAILED', safeErrorCode(error), true)
      }
      if (copiedEntry.size !== sourceSize) {
        return failure('STAGING_COPY_FAILED', 'SOURCE_SIZE_MISMATCH', true)
      }
      copied.push(copiedEntry)
    }

    // --- Step 2: manifest + re-verification (deterministic partial-copy
    //            detection — each copied file is re-hashed). --------------
    const manifest: FilesSnapshotManifestV1 = {
      version: FILES_SNAPSHOT_MANIFEST_VERSION,
      capturedAt: new Date().toISOString(),
      kind,
      entries: copied,
      integrity: computeFilesReceipt(manifestEntriesToReceiptEntries(copied))
    }
    try {
      fs.writeFileSync(resolveFilesSnapshotManifestPath(stagingDir), encodeFilesSnapshotManifest(manifest), 'utf8')
      fs.fsyncSync(fs.openSync(resolveFilesSnapshotManifestPath(stagingDir), 'r'))
    } catch (error) {
      return failure('MANIFEST_ENCODE_FAILED', safeErrorCode(error), true)
    }
    for (const entry of copied) {
      const onDisk = hashFile(path.join(stagingDir, entry.rel))
      if (onDisk.sha256 !== entry.sha256 || onDisk.size !== entry.size) {
        return failure('STAGING_VERIFY_FAILED', 'REHASH_MISMATCH', true)
      }
    }

    // --- Step 3: durable publish (one-retained atomic replacement) --------
    // POSIX rename(2) cannot atomically replace a NON-EMPTY destination
    // directory (ENOTEMPTY/EEXIST), so a plain rename would make a second
    // snapshot (the normal consecutive-import path) permanently fail. The
    // one-retained replacement therefore uses a bounded two-rename sequence
    // that keeps a COMPLETE, verifiable generation at the retained name at
    // every instant:
    //   1. rename(retained → retained.old)   — previous kept aside
    //   2. rename(staging → retained)        — verified new becomes active
    //   3. remove retained.old               — superseded generation
    // A failure at (2) renames the previous generation back so the retained
    // name still holds it (the "old retained untouched" contract).
    const retainedOldDir = path.resolve(path.join(dataRoot, FILES_ROLLBACK_SNAPSHOT_OLD_DIRNAME))
    try {
      options.onBeforePublish?.()
      // lstat-based presence (audit F2): a broken symlink at the retained
      // name is a PRESENT (tampered) previous generation that must be moved
      // aside and replaced — never silently treated as absent.
      if (lstatPresent(retainedDir)) {
        fs.rmSync(retainedOldDir, { recursive: true, force: true })
        fs.renameSync(retainedDir, retainedOldDir)
      }
      try {
        fs.renameSync(stagingDir, retainedDir)
      } catch (error) {
        // Restore the previous generation (best-effort) so the retained name
        // never dangles empty after a failed replacement.
        if (lstatPresent(retainedOldDir) && !lstatPresent(retainedDir)) {
          try {
            fs.renameSync(retainedOldDir, retainedDir)
          } catch {
            // The previous generation remains durable at retainedOldDir.
          }
        }
        throw error
      }
      fs.rmSync(retainedOldDir, { recursive: true, force: true })
    } catch (error) {
      logger.warn('Files rollback snapshot publish failed — old retained snapshot untouched')
      return failure('RETAINED_PUBLISH_FAILED', safeErrorCode(error), true)
    }
    try {
      fsyncDirectory(dataRoot)
    } catch (error) {
      return failure('RETAINED_DIRECTORY_SYNC_FAILED', safeErrorCode(error), false)
    }
    // --- Existence confirmation ------------------------------------------
    try {
      const retainedManifest = readAndValidateFilesSnapshotManifest(resolveFilesSnapshotManifestPath(retainedDir))
      if (retainedManifest === null) {
        return failure('RETAINED_CONFIRMATION_FAILED', 'MANIFEST_UNREADABLE', false)
      }
      if (retainedManifest.kind !== manifest.kind || retainedManifest.entries.length !== manifest.entries.length) {
        return failure('RETAINED_CONFIRMATION_FAILED', 'MANIFEST_DIVERGED', false)
      }
    } catch (error) {
      return failure('RETAINED_CONFIRMATION_FAILED', safeErrorCode(error), false)
    }

    logger.info(`Files rollback snapshot retained and confirmed (${kind}, entries=${manifest.entries.length})`)
    return Object.freeze({
      ok: true as const,
      retainedDir,
      receipt: manifest.integrity,
      kind
    })
  } catch (error) {
    return failure('STAGING_COPY_FAILED', safeErrorCode(error), true)
  }
}

// ---------------------------------------------------------------------------
// Probe — retained snapshot verification (read-only)
// ---------------------------------------------------------------------------

/** Status of the retained Files snapshot. */
export type FilesSnapshotProbeResult =
  | { readonly status: 'missing' }
  | { readonly status: 'present-unverified'; readonly detail: string | null }
  | { readonly status: 'present-verified' }

/**
 * Probe + fully verify the retained Files snapshot: manifest validity, every
 * entry's size + SHA-256 parity on disk, and manifest/entries agreement.
 * Read-only. Never throws.
 */
export function probeRetainedFilesSnapshot(dataRoot: string = DATA_PATH): FilesSnapshotProbeResult {
  const retainedDir = resolveRetainedFilesSnapshotDir(dataRoot)
  // lstat-based presence (audit F2/F4): a BROKEN symlink at the retained
  // root is PRESENT tamper (present-unverified), never 'missing'; a real
  // directory is required — a symlink to a directory is never followed.
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(retainedDir)
  } catch (error) {
    if (safeErrorCode(error) === 'ENOENT') {
      return { status: 'missing' }
    }
    return { status: 'present-unverified', detail: 'VERIFY_FAILED' }
  }
  if (!rootStat.isDirectory()) {
    return { status: 'present-unverified', detail: 'NOT_A_DIRECTORY' }
  }
  try {
    const manifest = readAndValidateFilesSnapshotManifest(resolveFilesSnapshotManifestPath(retainedDir))
    if (manifest === null) {
      return { status: 'present-unverified', detail: 'MANIFEST_INVALID' }
    }
    for (const entry of manifest.entries) {
      // LOCK-ART-4: a retained entry must be a REGULAR file — a symlink or
      // non-regular tamper is never followed or accepted.
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(path.join(retainedDir, entry.rel))
      } catch {
        return { status: 'present-unverified', detail: 'ENTRY_NOT_REGULAR' }
      }
      if (!stat.isFile()) {
        return { status: 'present-unverified', detail: 'ENTRY_NOT_REGULAR' }
      }
      const onDisk = hashFile(path.join(retainedDir, entry.rel))
      if (onDisk.sha256 !== entry.sha256 || onDisk.size !== entry.size) {
        return { status: 'present-unverified', detail: 'ENTRY_PARITY_FAILED' }
      }
    }
    // Defensive: no extra files beyond the manifest (bounded no-residue).
    const diskNames = fs
      .readdirSync(retainedDir)
      .filter((name) => name !== FILES_SNAPSHOT_MANIFEST_FILENAME)
      .sort()
    const manifestNames = manifest.entries.map((e) => e.rel).sort()
    if (JSON.stringify(diskNames) !== JSON.stringify(manifestNames)) {
      return { status: 'present-unverified', detail: 'EXTRA_ENTRIES' }
    }
    return { status: 'present-verified' }
  } catch {
    return { status: 'present-unverified', detail: 'VERIFY_FAILED' }
  }
}

// ---------------------------------------------------------------------------
// Restore — retained snapshot → live Files (snapshot NEVER consumed)
// ---------------------------------------------------------------------------

/**
 * Restore the retained Files snapshot to the live Files path by copying the
 * retained dir to a verified staging dir and atomically swapping it in.
 *
 * Ordering:
 *   1. retained manifest verified.
 *   2. staging copy of the retained snapshot (streaming hash + fsync).
 *   3. staging re-verified (per-file size/SHA-256).
 *   4. rename live Files → swap-staging (atomic removal; skipped when the
 *      live dir is absent).
 *   5. rename staging → live Files (atomic placement).
 *   6. remove the swap-staging dir (the previous live generation — fully
 *      retained by the snapshot, so removal is safe).
 *   7. fsync parent; verify the restored live dir against the manifest.
 *
 * An EMPTY retained snapshot (`kind: 'empty'`, zero entries) is restored as
 * EXACT ABSENCE (audit F5): the live/swap-staging/staging owned directories
 * are removed and the live Files path is left genuinely absent — the old
 * generation had no Files dir, so the restored state must have none. The
 * populated path below never creates a partial live directory.
 *
 * The retained snapshot is NEVER consumed or deleted (LOCK-4434 analog for
 * Files). Any failure retains the journal, the retained snapshot, and all
 * facts. The live Files path is only ever absent or one complete directory
 * (no partial live directories).
 */
export function restoreFilesRollbackSnapshot(dataRoot: string = DATA_PATH): { ok: boolean; code: string | null } {
  const liveFilesDir = resolveLiveFilesDir(dataRoot)
  const retainedDir = resolveRetainedFilesSnapshotDir(dataRoot)
  const stagingDir = resolveFilesSnapshotStagingDir(dataRoot)
  const swapStagingDir = path.resolve(path.join(dataRoot, FILES_PROMOTE_STAGING_DIRNAME))

  const fail = (code: string, safeCode: string | null): { ok: false; code: string } => {
    logger.warn(`Files rollback restore failed (${code}): ${safeCode ?? 'no sub-code'}`)
    fs.rmSync(stagingDir, { recursive: true, force: true })
    return { ok: false, code }
  }

  // 1. Retained manifest verified.
  // Audit F4: the retained root must be a REAL directory (lstat) — a
  // symlinked or otherwise non-directory retained root is tamper and is
  // never followed (reading through a symlink would restore from elsewhere).
  try {
    const rootStat = fs.lstatSync(retainedDir)
    if (!rootStat.isDirectory()) {
      return fail('RETAINED_MANIFEST_FAILED', 'NOT_A_DIRECTORY')
    }
  } catch (error) {
    if (safeErrorCode(error) !== 'ENOENT') {
      return fail('RETAINED_MANIFEST_FAILED', safeErrorCode(error))
    }
    // ENOENT falls through: the missing manifest read below maps to
    // RETAINED_MANIFEST_FAILED.
  }
  let manifest: FilesSnapshotManifestV1 | null
  try {
    manifest = readAndValidateFilesSnapshotManifest(resolveFilesSnapshotManifestPath(retainedDir))
  } catch {
    return fail('RETAINED_MANIFEST_FAILED', null)
  }
  if (manifest === null) {
    return fail('RETAINED_MANIFEST_FAILED', 'MANIFEST_INVALID')
  }

  // --- Empty-generation restore = EXACT ABSENCE restoration (audit F5) ----
  // The old generation had NO Files directory, so the restored live state
  // must have NO Files directory either: the live Files path is left
  // genuinely absent (ENOENT), never a present-empty directory. Every owned
  // directory at the live path, the swap-staging path, or the snapshot
  // staging path is removed. The retained snapshot is NEVER consumed; the
  // empty receipt (count 0 / totalBytes 0 / empty sha256) remains exact for
  // the caller (LOCK-PROMO-6).
  if (manifest.kind === 'empty' && manifest.entries.length === 0) {
    try {
      // Ours to discard: a leftover swap-staging dir, the snapshot staging
      // dir, and the previous live generation (fully retained by the empty
      // snapshot as absence).
      fs.rmSync(swapStagingDir, { recursive: true, force: true })
      fs.rmSync(stagingDir, { recursive: true, force: true })
      // lstat-based presence (audit F2/F4): a broken symlink at the live
      // path is PRESENT and is removed too — absence means genuine ENOENT.
      if (lstatPresent(liveFilesDir)) {
        fs.rmSync(liveFilesDir, { recursive: true, force: true })
      }
      fsyncDirectory(dataRoot)
    } catch (error) {
      return fail('SWAP_FAILED', safeErrorCode(error))
    }
    // Verify: the live Files path is now ABSENT (exact absence, not an
    // empty present directory).
    let livePresent = false
    try {
      fs.lstatSync(liveFilesDir)
      livePresent = true
    } catch (error) {
      if (safeErrorCode(error) !== 'ENOENT') {
        return fail('RESTORED_VERIFY_FAILED', safeErrorCode(error))
      }
    }
    if (livePresent) {
      return fail('RESTORED_VERIFY_FAILED', 'LIVE_MISSING')
    }
    logger.info('Files rollback restore verified (empty old generation — live Files absent)')
    return { ok: true, code: null }
  }

  // 2-3. Verified staging copy.
  fs.rmSync(stagingDir, { recursive: true, force: true })
  try {
    fs.mkdirSync(stagingDir, { recursive: true })
    for (const entry of manifest.entries) {
      const copied = copyFileWithHash(path.join(retainedDir, entry.rel), path.join(stagingDir, entry.rel))
      if (copied.sha256 !== entry.sha256 || copied.size !== entry.size) {
        return fail('STAGING_COPY_FAILED', 'COPY_PARITY_FAILED')
      }
    }
    for (const entry of manifest.entries) {
      const onDisk = hashFile(path.join(stagingDir, entry.rel))
      if (onDisk.sha256 !== entry.sha256 || onDisk.size !== entry.size) {
        return fail('STAGING_VERIFY_FAILED', 'REHASH_MISMATCH')
      }
    }
  } catch (error) {
    return fail('STAGING_COPY_FAILED', safeErrorCode(error))
  }

  // 4-6. Atomic swap.
  try {
    // Remove any stale swap-staging first (ours to discard).
    fs.rmSync(swapStagingDir, { recursive: true, force: true })
    // lstat-based presence (audit F2): a BROKEN symlink at the live path is
    // PRESENT tamper — it is swapped to swap-staging (evidence retained) and
    // replaced by the restored generation, never silently skipped as absent.
    if (lstatPresent(liveFilesDir)) {
      fs.renameSync(liveFilesDir, swapStagingDir)
    }
    fs.renameSync(stagingDir, liveFilesDir)
    fs.rmSync(swapStagingDir, { recursive: true, force: true })
    fsyncDirectory(dataRoot)
  } catch (error) {
    // Post-placement failure: the live dir is either the restored copy or
    // absent; artifacts retained for deterministic retry.
    return fail('SWAP_FAILED', safeErrorCode(error))
  }

  // 7. Verify restored live Files against the manifest.
  try {
    // lstat-based presence (audit F2): a broken symlink at the restored live
    // path is tamper (NON_REGULAR_ENTRY), never a missing/empty generation.
    let livePresent = false
    let liveIsDir = false
    try {
      const s = fs.lstatSync(liveFilesDir)
      livePresent = true
      liveIsDir = s.isDirectory()
    } catch (error) {
      if (safeErrorCode(error) !== 'ENOENT') {
        return fail('RESTORED_VERIFY_FAILED', safeErrorCode(error))
      }
    }
    if (!livePresent) {
      if (manifest.kind === 'empty' && manifest.entries.length === 0) {
        return { ok: true, code: null }
      }
      return fail('RESTORED_VERIFY_FAILED', 'LIVE_MISSING')
    }
    if (!liveIsDir) {
      return fail('RESTORED_VERIFY_FAILED', 'NON_REGULAR_ENTRY')
    }
    const diskNames = fs.readdirSync(liveFilesDir).sort()
    const manifestNames = manifest.entries.map((e) => e.rel).sort()
    if (JSON.stringify(diskNames) !== JSON.stringify(manifestNames)) {
      return fail('RESTORED_VERIFY_FAILED', 'ENTRY_SET_MISMATCH')
    }
    for (const entry of manifest.entries) {
      const entryPath = path.join(liveFilesDir, entry.rel)
      // LOCK-ART-4: the restored live Files is a flat canonical set of
      // regular files — a non-regular restored entry is a tamper signal.
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(entryPath)
      } catch (error) {
        return fail('RESTORED_VERIFY_FAILED', safeErrorCode(error))
      }
      if (!stat.isFile()) {
        return fail('RESTORED_VERIFY_FAILED', 'NON_REGULAR_ENTRY')
      }
      const onDisk = hashFile(entryPath)
      if (onDisk.sha256 !== entry.sha256 || onDisk.size !== entry.size) {
        return fail('RESTORED_VERIFY_FAILED', 'ENTRY_PARITY_FAILED')
      }
    }
  } catch (error) {
    return fail('RESTORED_VERIFY_FAILED', safeErrorCode(error))
  }

  logger.info('Files rollback restore verified (live Files matches the retained snapshot manifest)')
  return { ok: true, code: null }
}

/** Compute the aggregate files receipt from the live Files dir (probe). */
export function computeLiveFilesReceipt(dataRoot: string = DATA_PATH): PromotionJournalFilesReceipt | null {
  const liveFilesDir = resolveLiveFilesDir(dataRoot)
  // lstat-based presence (audit F2): a BROKEN symlink at the live root is
  // PRESENT tamper → null, NEVER the empty receipt (a broken symlink must
  // never certify an empty generation).
  let present = false
  try {
    fs.lstatSync(liveFilesDir)
    present = true
  } catch (error) {
    if (safeErrorCode(error) !== 'ENOENT') {
      return null
    }
  }
  if (!present) {
    return Object.freeze({ count: 0, totalBytes: 0, sha256: crypto.createHash('sha256').digest('hex') })
  }
  try {
    // lstat: a symlinked live Files root is tampering — unverifiable.
    const rootStat = fs.lstatSync(liveFilesDir)
    if (!rootStat.isDirectory()) {
      return null
    }
    const names = fs.readdirSync(liveFilesDir).sort()
    const entries: FilesReceiptEntry[] = []
    for (const name of names) {
      const entryPath = path.join(liveFilesDir, name)
      // LOCK-ART-4: a non-regular live entry makes the generation
      // unverifiable — fail closed instead of silently skipping it.
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(entryPath)
      } catch {
        return null
      }
      if (!stat.isFile()) {
        return null
      }
      const hashed = hashFile(entryPath)
      entries.push({ name, size: hashed.size, sha256: hashed.sha256 })
    }
    return computeFilesReceipt(entries)
  } catch {
    return null
  }
}
