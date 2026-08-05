/**
 * Attachment plane — L2 attachment compatibility (Phase 1, LOCK-FIX-1..9).
 *
 * Converts the source Data/Files payloads + the source Dexie `files` catalog
 * rows + the committed candidate file references into SEALED candidate
 * artifacts:
 *
 *   1. candidate Files directory — canonical `Files/<id><ext>` payloads
 *      (LOCK-FIX-2/6), streamed from the ZIP with bounded streaming and a
 *      streaming SHA-256 (LOCK-FIX-7 — never whole-file buffered);
 *   2. durable candidate catalog handoff — `files-catalog.json` in the
 *      candidate directory (LOCK-FIX-2), carrying normalized rows for the
 *      future promotion phase to populate the Dexie files table
 *      (LOCK-FIX-1: the Dexie catalog stays canonical — no SQL files table);
 *   3. degraded attachment manifest/statistics — aggregate count-only
 *      degraded/skipped classification (LOCK-FIX-4/5), never per-file
 *      identities in logs.
 *
 * Classification (LOCK-FIX-4/5):
 * - HEALTHY (canonical, LOCK-FIX-5): catalog row + exactly one consistent
 *   payload → catalog row + payload written.
 * - DEGRADED (count-only, no catalog row, no fake file, references
 *   preserved): missingPayload, missingCatalogRow, metadataMismatch,
 *   payloadReadFailure, lostContent, invalidTargetName, duplicateCatalogRow.
 * - SKIPPED: ZIP payloads matching no catalog row (payloadWithoutCatalog).
 * - FATAL (LOCK-FIX-3, atomic): ambiguous payload per file id, hard-budget
 *   overflow during streaming, catalog seal failure, unrecoverable candidate
 *   state, source archive unreadable, cancellation.
 *
 * Invariants:
 * - The source ZIP is never mutated (LOCK-FIX-8). All artifacts live under
 *   the owned candidate directory, so candidate discard removes them exactly
 *   (LOCK-FIX-9: cancellation before promotion cleans precisely).
 * - Source absolute paths are NEVER retained in the catalog handoff
 *   (LOCK-FIX-6); `path` is the candidate-relative `Files/<id><ext>`.
 * - Physical payload size + streaming SHA-256 are the physical authority
 *   (LOCK-FIX-6). A present source size that differs is a metadata
 *   disagreement (degrade); an absent/invalid source size is "no claim"
 *   (physical wins).
 * - Logs and the manifest carry only aggregate counts and application
 *   artifacts required for handoff — never source paths, filenames, user
 *   content, or raw file IDs (LOCK-FIX-8).
 * - The catalog handoff is written atomically (temp + rename) and validated
 *   on read-back; every healthy row's payload is re-stated after write
 *   (fail closed → CANDIDATE_STATE_UNRECOVERABLE).
 *
 * LOCK-CORR-1..4 (Phase 1 audit corrections):
 * - LOCK-CORR-1: cancellation/disposal is rechecked immediately before the
 *   durable catalog publication and (in index.ts) after attachment finalize
 *   before candidate seal/ready — a cancelled/disposed session can never
 *   transition to candidate-ready or recreate owned paths.
 * - LOCK-CORR-2: the streaming CRC-32 of the uncompressed bytes is computed
 *   incrementally (zlib.crc32 — never whole-file buffering) and compared
 *   with the central-directory CRC for EVERY payload, including
 *   data-descriptor (bit 3) entries whose form the real backup writer
 *   (archiver) produces and for which node-stream-zip skips its own
 *   verification. A mismatch is a per-reference payloadReadFailure degrade
 *   when the archive remains safely readable.
 * - LOCK-CORR-3: the ZIP is reopened and its central directory parsed ONCE
 *   per finalize; the shared handle + entry map serve every payload and the
 *   handle is closed exactly once in finally (abort-aware).
 * - LOCK-CORR-4: entry-not-found during stream open/read is a payload-level
 *   degrade; archive open / CEN / global parser failure remains fatal.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

import { loggerService } from '@logger'
import StreamZip from 'node-stream-zip'

import { ChatImportAttachmentError } from './errors'
import type { SourceFileRow } from './importDataPlane'
import {
  assertDiskSpaceAvailable,
  FILES_PAYLOAD_PREFIX,
  type FilesInventory,
  MAX_FILES_PAYLOAD_SINGLE_ENTRY_BYTES,
  MAX_FILES_PAYLOAD_TOTAL_UNCOMPRESSED_BYTES,
  sanitizeEntryNameForMessage
} from './zipIntake'

const logger = loggerService.withContext('chatDbImport')

// ---------------------------------------------------------------------------
// Durable catalog handoff (LOCK-FIX-2/6)
// ---------------------------------------------------------------------------

/** Filename of the durable candidate catalog handoff inside the candidate dir. */
export const FILES_CATALOG_FILENAME = 'files-catalog.json'

/** Catalog handoff schema version. Bump on breaking format changes. */
export const FILES_CATALOG_VERSION = 1 as const

/**
 * One normalized catalog row in the handoff. `path` is ALWAYS the
 * candidate-relative `Files/<id><ext>` — the source absolute path is never
 * retained (LOCK-FIX-6). `size` and `sha256` are the physical authority.
 */
export interface CandidateFileCatalogRow {
  /** Source file id (Dexie files primary key). */
  readonly id: string
  /** Canonical physical filename `id + ext` (LOCK-FIX-6). */
  readonly name: string
  /** Source display name (origin_name ?? name ?? canonical name). */
  readonly origin_name: string
  /** Physical payload size in bytes (physical authority). */
  readonly size: number
  /** Streaming SHA-256 hex of the payload (physical authority). */
  readonly sha256: string
  /** Source extension incl. dot ('' when absent) — target is Files/<id><ext>. */
  readonly ext: string
  /** Source file type (image/video/...) or null. */
  readonly type: string | null
  /** Source created-at ISO string or null. */
  readonly created_at: string | null
  /**
   * Rebuilt reference count (LOCK-FIX-6: FileManager semantics). Every
   * healthy row carries at least 1 — unreferenced rows normalize their
   * target count so startup orphan cleanup (count <= 0) never removes them.
   */
  readonly count: number
  /** Candidate-relative target path: `Files/<id><ext>`. */
  readonly path: string
}

/** Durable catalog handoff payload (LOCK-FIX-2). */
export interface CandidateFilesCatalog {
  readonly version: typeof FILES_CATALOG_VERSION
  readonly sessionId: string
  readonly createdAt: string
  readonly rows: CandidateFileCatalogRow[]
  readonly referenced: { readonly referencedFileIdCount: number }
  readonly degraded: Readonly<Record<DegradeCategory, number>>
  readonly skipped: Readonly<Record<SkippedCategory, number>>
}

// ---------------------------------------------------------------------------
// Classification types (LOCK-FIX-4/5)
// ---------------------------------------------------------------------------

/** Per-file degraded categories (LOCK-FIX-4 + LOCK-FIX-6/defensive). */
export type DegradeCategory =
  | 'missingPayload'
  | 'missingCatalogRow'
  | 'metadataMismatch'
  | 'payloadReadFailure'
  | 'lostContent'
  | 'invalidTargetName'
  | 'duplicateCatalogRow'

/** Per-payload skipped categories (LOCK-FIX-5). */
export type SkippedCategory = 'payloadWithoutCatalog'

/** Aggregated attachment plane stats (count-only, LOCK-FIX-4/8). */
export interface AttachmentPlaneStats {
  /** Source catalog rows reconciled (count of captured source `files` rows). */
  readonly catalogRowCount: number
  /** Healthy files: catalog row + consistent payload → row + payload written. */
  readonly healthyFileCount: number
  /** Payload bytes streamed into the candidate Files dir. */
  readonly extractedBytes: number
  /** Distinct fileIds referenced by the committed candidate references. */
  readonly referencedFileIdCount: number
  /** Degraded files (no catalog row, no fake file — count-only). */
  readonly degraded: Readonly<Record<DegradeCategory, number>>
  /** Skipped ZIP payloads. */
  readonly skipped: Readonly<Record<SkippedCategory, number>>
}

function emptyDegraded(): Record<DegradeCategory, number> {
  return {
    missingPayload: 0,
    missingCatalogRow: 0,
    metadataMismatch: 0,
    payloadReadFailure: 0,
    lostContent: 0,
    invalidTargetName: 0,
    duplicateCatalogRow: 0
  }
}

function emptySkipped(): Record<SkippedCategory, number> {
  return { payloadWithoutCatalog: 0 }
}

/** Known degraded categories (read-back validation of the handoff). */
const DEGRADE_CATEGORIES: ReadonlySet<string> = new Set([
  'missingPayload',
  'missingCatalogRow',
  'metadataMismatch',
  'payloadReadFailure',
  'lostContent',
  'invalidTargetName',
  'duplicateCatalogRow'
])

/** Known skipped categories (read-back validation of the handoff). */
const SKIPPED_CATEGORIES: ReadonlySet<string> = new Set(['payloadWithoutCatalog'])

/**
 * LOCK-CORR-3: the source ZIP is reopened and its central directory parsed
 * EXACTLY ONCE per finalize, then the shared handle + entry map serve every
 * payload. The handle is closed exactly once in the finalize finally block.
 */
interface PayloadArchive {
  readonly zip: StreamZip.StreamZipAsync
  /** Central-directory entries keyed by entry name (from the one CEN parse). */
  readonly entries: Record<string, StreamZip.ZipEntry>
}

// ---------------------------------------------------------------------------
// Errors — internal per-payload stream classification
// ---------------------------------------------------------------------------

/** Kind of a per-payload streaming outcome that is NOT a clean success. */
type PayloadFailureKind =
  | 'overflow' // exceeded hard caps → FATAL (quota/bomb)
  | 'sizeMismatch' // written ≠ claimed, within caps → degrade payloadReadFailure
  | 'truncated' // stream ended short of claimed → degrade lostContent
  | 'read' // stream/CRC error → degrade payloadReadFailure

/** Internal per-payload stream failure (never escapes finalize()). */
class PayloadStreamFailure extends Error {
  readonly kind: PayloadFailureKind
  readonly written: number

  constructor(kind: PayloadFailureKind, written: number, detail: string) {
    super(detail)
    this.name = 'PayloadStreamFailure'
    this.kind = kind
    this.written = written
  }
}

// ---------------------------------------------------------------------------
// AttachmentPlaneLike (LOCK-O8 injectable surface)
// ---------------------------------------------------------------------------

export interface AttachmentFinalizeOptions {
  /** Validated source `files` rows (from the finalized data plane). */
  readonly sourceFileRows: readonly SourceFileRow[]
  /** fileId → reference multiplicity over committed candidate references. */
  readonly referenceCounts: ReadonlyArray<readonly [string, number]>
  /**
   * Cooperative cancellation probe, checked between payloads. When true the
   * finalize aborts with a CANCELLED attachment error — the caller owns
   * cleanup (candidate discard removes every candidate artifact, LOCK-FIX-9).
   */
  readonly shouldAbort?: () => boolean
}

/** Narrow attachment-plane surface owned by the session (LOCK-O8). */
export interface AttachmentPlaneLike {
  /**
   * Reconcile catalog/refs/payloads, extract payloads with bounded streaming
   * + SHA-256, write + verify the sealed catalog handoff, and return
   * count-only aggregate stats. Exactly once; throws
   * {@link ChatImportAttachmentError} on fatal classes.
   */
  finalize(options: AttachmentFinalizeOptions): Promise<AttachmentPlaneStats>
  /** Sealed catalog handoff retained after a successful finalize(). */
  getCatalog(): CandidateFilesCatalog | null
  /** Count-only stats retained after a successful finalize(). */
  getStats(): AttachmentPlaneStats | null
  /**
   * LOCK-UI-2/5: privacy-internal reference-degraded file ID set retained
   * after a successful finalize(). Main-only — NEVER over IPC, NEVER in the
   * catalog handoff/journal/public status, NEVER in logs. The orchestrator
   * uses it to mark every imported file/image block referencing those ids
   * unavailable BEFORE the candidate seals (LOCK-UI-4). Only
   * reference-degraded categories are included: missingPayload,
   * missingCatalogRow, metadataMismatch, payloadReadFailure, lostContent,
   * invalidTargetName. Healthy files, skipped unreferenced orphan payloads,
   * and duplicate-catalog rows (first row wins → file stays healthy) are
   * excluded. Snapshot, no aliasing.
   *
   * @throws {ChatImportAttachmentError} code CANDIDATE_STATE_UNRECOVERABLE
   *         when called before a successful finalize().
   */
  getDegradedFileIds(): readonly string[]
}

// ---------------------------------------------------------------------------
// Options / factory
// ---------------------------------------------------------------------------

export interface AttachmentPlaneOptions {
  /** Import session identifier. */
  readonly sessionId: string
  /** Absolute path of the source ZIP (Main-internal; never logged). */
  readonly zipPath: string
  /** Central-directory Data/Files inventory from the intake pass. */
  readonly filesInventory: FilesInventory
  /** Candidate-scoped Files directory (created by finalize). */
  readonly candidateFilesDir: string
  /** Durable catalog handoff path (inside the candidate directory). */
  readonly catalogPath: string
  /** Injectable clock for catalog createdAt (tests). */
  readonly now?: () => number
  /**
   * LOCK-FIX-7: bounded resource caps (production defaults from zipIntake,
   * justified against the 1.39 GiB real-backup class). Injectable ONLY for
   * tests so the hard-cap overflow path can be proven without streaming
   * gigabytes.
   */
  readonly singleEntryCapBytes?: number
  readonly cumulativeCapBytes?: number
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

interface FilesInventoryEntry {
  entryName: string
  size: number
}

// ---------------------------------------------------------------------------
// AttachmentPlane
// ---------------------------------------------------------------------------

export class AttachmentPlane implements AttachmentPlaneLike {
  private readonly sessionId: string
  private readonly zipPath: string
  private readonly filesInventory: FilesInventory
  private readonly candidateFilesDir: string
  private readonly catalogPath: string
  private readonly now: () => number
  private readonly singleEntryCapBytes: number
  private readonly cumulativeCapBytes: number
  private catalog: CandidateFilesCatalog | null = null
  private stats: AttachmentPlaneStats | null = null
  /**
   * LOCK-UI-2/5: privacy-internal reference-degraded file ids retained
   * after a successful finalize(). Main-only — never IPC/catalog/log.
   */
  private degradedFileIds: ReadonlySet<string> | null = null

  constructor(options: AttachmentPlaneOptions) {
    this.sessionId = options.sessionId
    this.zipPath = options.zipPath
    this.filesInventory = options.filesInventory
    this.candidateFilesDir = options.candidateFilesDir
    this.catalogPath = options.catalogPath
    this.now = options.now ?? Date.now
    this.singleEntryCapBytes = options.singleEntryCapBytes ?? MAX_FILES_PAYLOAD_SINGLE_ENTRY_BYTES
    this.cumulativeCapBytes = options.cumulativeCapBytes ?? MAX_FILES_PAYLOAD_TOTAL_UNCOMPRESSED_BYTES
  }

  getCatalog(): CandidateFilesCatalog | null {
    return this.catalog
  }

  getStats(): AttachmentPlaneStats | null {
    return this.stats
  }

  getDegradedFileIds(): readonly string[] {
    if (this.degradedFileIds === null) {
      throw new ChatImportAttachmentError(
        'CANDIDATE_STATE_UNRECOVERABLE',
        'attachment plane degraded file ids accessed before finalize'
      )
    }
    return Array.from(this.degradedFileIds)
  }

  async finalize(options: AttachmentFinalizeOptions): Promise<AttachmentPlaneStats> {
    if (this.stats !== null) {
      throw new ChatImportAttachmentError('CANDIDATE_STATE_UNRECOVERABLE', 'attachment plane finalized more than once')
    }
    const shouldAbort = options.shouldAbort ?? (() => false)

    // LOCK-FIX-3: disk preflight for the candidate Files filesystem before
    // anything is materialized (bounded resource model).
    fs.mkdirSync(this.candidateFilesDir, { recursive: true })
    assertDiskSpaceAvailable(this.candidateFilesDir, this.filesInventory.totalUncompressedBytes)

    // Deterministic inventory index: basename → entries (LOCK-FIX-3
    // ambiguous-payload detection; LOCK-FIX-5 payload-without-catalog).
    const byBasename = new Map<string, FilesInventoryEntry[]>()
    for (const entry of this.filesInventory.entries) {
      const base = payloadBasename(entry.entryName)
      let list = byBasename.get(base)
      if (!list) {
        list = []
        byBasename.set(base, list)
      }
      list.push(entry)
    }
    const cumulativeCap = this.cumulativeCapBytes

    // LOCK-CORR-3: the source ZIP is reopened and its central directory is
    // parsed EXACTLY ONCE per finalize — the shared handle + entry map serve
    // every payload (F4), and the handle is closed exactly once in the
    // finally block below. The open is lazy (first payload that needs it) so
    // a finalize with zero extractable payloads never touches the archive.
    let archive: PayloadArchive | null = null

    try {
      const referenceMultiplicity = new Map<string, number>()
      for (const [id, count] of options.referenceCounts) {
        referenceMultiplicity.set(id, count)
      }

      const degraded = emptyDegraded()
      const skipped = emptySkipped()
      const rows: CandidateFileCatalogRow[] = []
      const seenCatalogIds = new Set<string>()
      const matchedBasenames = new Set<string>()
      let extractedBytes = 0
      // LOCK-UI-2/5: privacy-internal reference-degraded file ids (Main-only,
      // never IPC/catalog/log). Duplicate catalog rows are EXCLUDED — the
      // first row wins, so the file stays healthy (LOCK-UI-2: healthy files
      // never mark unavailable).
      const degradedFileIds = new Set<string>()
      const catalogIds = new Set<string>(options.sourceFileRows.map((row) => row.id))
      for (const [id] of options.referenceCounts) {
        // LOCK-FIX-4: referenced catalog row missing — degrade count-only.
        // The block/file_reference metadata is preserved by the data plane
        // (never touched here); no catalog row and no fake file are created.
        if (!catalogIds.has(id)) {
          degraded.missingCatalogRow += 1
          degradedFileIds.add(id)
        }
      }

      // Reconcile every catalog row deterministically (LOCK-FIX-5: no guessing).
      for (const row of options.sourceFileRows) {
        if (shouldAbort()) {
          throw new ChatImportAttachmentError('CANCELLED', 'attachment extraction aborted by cancellation')
        }
        if (seenCatalogIds.has(row.id)) {
          // Defensive (the source Dexie files table keys on id, so legitimate
          // sources cannot repeat): first row wins, duplicate is count-only.
          degraded.duplicateCatalogRow += 1
          continue
        }
        seenCatalogIds.add(row.id)

        const targetBasename = `${row.id}${row.ext ?? ''}`
        if (!isSafeTargetComponent(targetBasename)) {
          // LOCK-FIX-6: never build a filesystem path from an unsafe id/ext.
          degraded.invalidTargetName += 1
          degradedFileIds.add(row.id)
          continue
        }
        // id must be a safe component; a present ext must be safe UNLESS it is
        // the legitimate empty extension (no-extension files).
        if (!isSafeTargetComponent(row.id) || (row.ext !== null && row.ext !== '' && !isSafeTargetComponent(row.ext))) {
          degraded.invalidTargetName += 1
          degradedFileIds.add(row.id)
          continue
        }

        const candidates = byBasename.get(targetBasename) ?? []
        if (candidates.length === 0) {
          // LOCK-FIX-4/5: catalog without payload — skip/count (referenced or not).
          degraded.missingPayload += 1
          degradedFileIds.add(row.id)
          continue
        }
        matchedBasenames.add(targetBasename)
        if (candidates.length > 1) {
          // LOCK-FIX-3: ambiguous payload per file ID — atomic reject, never guess.
          throw new ChatImportAttachmentError(
            'AMBIGUOUS_PAYLOAD',
            `Multiple ZIP payload entries resolve to one catalog file ` +
              `"${sanitizeEntryNameForMessage(candidates[0].entryName)}" (LOCK-FIX-3)`
          )
        }

        const candidate = candidates[0]
        const claimedSize = candidate.size
        const targetName = targetBasename
        const targetPath = path.join(this.candidateFilesDir, targetName)

        // LOCK-FIX-7: bounded streaming extraction + streaming SHA-256. A
        // per-payload failure degrades (LOCK-FIX-4) when the archive parser can
        // safely continue; a hard-cap overflow is a quota/bomb FATAL (LOCK-FIX-3).
        let written = 0
        let sha256 = ''
        try {
          // LOCK-CORR-3: open the shared archive on the first payload that
          // needs it (F4 — no per-payload reopen/CEN parse). Archive open /
          // CEN parse failures are FATAL (FILES_EXTRACTION_FAILED); the
          // per-entry stream/read failures below are payload-level degrades
          // (LOCK-CORR-4).
          archive ??= await this.openPayloadArchive()
          const entry = archive.entries[candidate.entryName]
          const result = await this.streamPayload(
            archive,
            candidate.entryName,
            entry,
            targetPath,
            claimedSize,
            extractedBytes,
            this.singleEntryCapBytes,
            cumulativeCap
          )
          written = result.written
          sha256 = result.sha256
        } catch (error) {
          removeFileBestEffort(targetPath)
          if (error instanceof PayloadStreamFailure) {
            if (error.kind === 'overflow') {
              throw new ChatImportAttachmentError(
                'FILES_PAYLOAD_OVERFLOW',
                `A Data/Files payload exceeded the hard single-entry/cumulative cap during streaming ` +
                  `(written ${error.written} bytes) — archive rejected atomically (LOCK-FIX-3)`
              )
            }
            if (error.kind === 'truncated') {
              degraded.lostContent += 1
              degradedFileIds.add(row.id)
              continue
            }
            degraded.payloadReadFailure += 1
            degradedFileIds.add(row.id)
            continue
          }
          if (error instanceof ChatImportAttachmentError) {
            throw error
          }
          // Unexpected stream/fs error on one payload — degrade when the
          // archive parser can safely continue (LOCK-FIX-4).
          degraded.payloadReadFailure += 1
          degradedFileIds.add(row.id)
          continue
        }

        // LOCK-FIX-6: physical payload size is the physical authority. A
        // PRESENT source size that differs is a metadata disagreement
        // (LOCK-FIX-4) — no catalog row, no fake file, count-only. Absent/
        // invalid source size means "no claim" — physical wins (healthy).
        if (row.size !== null && row.size !== written) {
          removeFileBestEffort(targetPath)
          degraded.metadataMismatch += 1
          degradedFileIds.add(row.id)
          continue
        }

        extractedBytes += written
        const referenceCount = referenceMultiplicity.get(row.id) ?? 0
        // Every healthy row carries a target count >= 1: the reference
        // multiplicity dominates when > 0; otherwise the source count is
        // preserved when valid and floored at 1 (see normalizeTargetCount).
        const count = normalizeTargetCount(referenceCount, row.count)
        rows.push({
          id: row.id,
          name: targetName,
          origin_name: row.origin_name ?? row.name ?? targetName,
          size: written,
          sha256,
          ext: row.ext ?? '',
          type: row.type,
          created_at: row.created_at,
          count,
          path: `Files/${targetName}`
        })
      }

      // LOCK-FIX-5: ZIP payloads matching no catalog row are skipped/counted
      // (they are never extracted — payload without catalog/ref skips).
      for (const [basename, list] of byBasename) {
        if (basename === '' || matchedBasenames.has(basename)) continue
        skipped.payloadWithoutCatalog += list.length
      }

      // LOCK-FIX-6: rebuild counts under existing FileManager semantics —
      // every healthy row already carries its rebuilt/normalized count above
      // (always >= 1 so unreferenced imports survive startup orphan cleanup).

      const stats: AttachmentPlaneStats = {
        catalogRowCount: options.sourceFileRows.length,
        healthyFileCount: rows.length,
        extractedBytes,
        referencedFileIdCount: referenceMultiplicity.size,
        degraded: Object.freeze({ ...degraded }),
        skipped: Object.freeze({ ...skipped })
      }

      // LOCK-FIX-2: durable catalog handoff — atomic write + read-back
      // validation (fail closed → unrecoverable candidate state).
      const catalog: CandidateFilesCatalog = {
        version: FILES_CATALOG_VERSION,
        sessionId: this.sessionId,
        createdAt: new Date(this.now()).toISOString(),
        rows,
        referenced: { referencedFileIdCount: referenceMultiplicity.size },
        degraded,
        skipped
      }
      // LOCK-CORR-1: cancellation/disposal must be rechecked immediately
      // before the durable catalog is published. A cancelled/disposed
      // session must NEVER re-create owned paths (the atomic write would
      // recreate the candidate directory under a discarded candidate) —
      // abort CANCELLED before any durable publication.
      if (shouldAbort()) {
        throw new ChatImportAttachmentError('CANCELLED', 'attachment publication aborted by cancellation')
      }
      this.writeCatalogDurable(catalog)

      // Seal/verify artifacts (LOCK-FIX-2/3): every healthy payload must exist
      // on disk at the recorded physical size; the catalog must read back
      // valid. Fail closed — a mismatch is an unrecoverable candidate state.
      for (const row of rows) {
        if (shouldAbort()) {
          throw new ChatImportAttachmentError('CANCELLED', 'attachment seal aborted by cancellation')
        }
        const payloadPath = path.join(this.candidateFilesDir, row.name)
        let stat: fs.Stats
        try {
          stat = fs.statSync(payloadPath)
        } catch {
          throw new ChatImportAttachmentError(
            'CANDIDATE_STATE_UNRECOVERABLE',
            'extracted payload missing after write (fail closed)'
          )
        }
        if (!stat.isFile() || stat.size !== row.size) {
          throw new ChatImportAttachmentError(
            'CANDIDATE_STATE_UNRECOVERABLE',
            'extracted payload size mismatch after write (fail closed)'
          )
        }
      }
      const readBack = readAndValidateCatalog(this.catalogPath)
      if (readBack === null || readBack.sessionId !== this.sessionId || readBack.rows.length !== rows.length) {
        throw new ChatImportAttachmentError(
          'CANDIDATE_STATE_UNRECOVERABLE',
          'catalog handoff failed read-back validation (fail closed)'
        )
      }

      this.catalog = catalog
      this.stats = stats
      // LOCK-UI-5: the privacy-internal degraded file id set is retained
      // Main-only for the pre-seal marker mutation — never IPC/catalog/log.
      this.degradedFileIds = new Set(degradedFileIds)

      // LOCK-FIX-4/8: exactly ONE aggregate count-only info line. Never
      // per-file, never ids/names/paths/content.
      const degradedTotal = Object.values(degraded).reduce((a, b) => a + b, 0)
      logger.info(
        `Session ${this.sessionId}: attachment plane finalized — healthy=${rows.length}, ` +
          `degraded=${degradedTotal}, skipped=${skipped.payloadWithoutCatalog}, ` +
          `referenced=${referenceMultiplicity.size}, extractedBytes=${extractedBytes}`
      )
      return stats
    } finally {
      // LOCK-CORR-3: close the shared archive exactly once — on success AND
      // on every failure path (including cancellation).
      if (archive) {
        try {
          await archive.zip.close()
        } catch {
          // Best-effort close on the failure path; the source ZIP is never
          // mutated (LOCK-FIX-8) and the fd leak is bounded by one handle.
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals — one shared archive per finalize (LOCK-CORR-3), bounded
  // streaming + SHA-256 (LOCK-FIX-7) + CRC-32 verification (LOCK-CORR-2)
  // -------------------------------------------------------------------------

  /**
   * LOCK-CORR-3: reopen the source ZIP exactly once per finalize and parse
   * its central directory once. The returned shared handle + entry map serve
   * every payload and are closed exactly once by the caller (finalize's
   * finally block).
   *
   * Archive-level failures — the ZIP cannot be opened or its central
   * directory cannot be parsed — are FATAL (FILES_EXTRACTION_FAILED,
   * LOCK-CORR-4): the candidate cannot be completed without a readable
   * archive.
   */
  private async openPayloadArchive(): Promise<PayloadArchive> {
    let zip: StreamZip.StreamZipAsync | null = null
    try {
      // The intake pass closed the ZIP; payload extraction reopens it
      // read-only (LOCK-FIX-8: the source archive is never mutated).
      zip = new StreamZip.async({ file: this.zipPath })
      const entries = await zip.entries()
      return { zip, entries }
    } catch (error) {
      if (zip) {
        try {
          await zip.close()
        } catch {
          // Best-effort close on the failure path.
        }
      }
      throw new ChatImportAttachmentError(
        'FILES_EXTRACTION_FAILED',
        'source archive could not be read for payload extraction'
      )
    }
  }

  /**
   * Stream one payload entry from the SHARED archive (LOCK-CORR-3) into the
   * candidate Files dir through a counting guard transform that updates the
   * streaming SHA-256 (LOCK-FIX-7), enforces the hard caps, and computes the
   * streaming CRC-32 (LOCK-CORR-2):
   * - single-entry cap + remaining cumulative budget on ACTUAL bytes →
   *   FATAL (overflow); and
   * - exact claimed-size match (within caps) → per-payload degrade; and
   * - streamed CRC-32 vs the CENTRAL-DIRECTORY CRC for EVERY payload —
   *   including data-descriptor (bit 3) entries, whose form the real backup
   *   writer (archiver) produces and for which node-stream-zip skips its own
   *   CRC verification → per-payload payloadReadFailure degrade.
   *
   * Never buffers the payload (LOCK-FIX-7). On any failure the partial
   * target file is removed by the caller.
   *
   * @throws {PayloadStreamFailure} overflow | sizeMismatch | truncated | read
   *   (entry absent from the reopened CEN, per-entry stream-open/read error,
   *   or CRC mismatch — all payload-level degrades, LOCK-CORR-2/4).
   */
  private async streamPayload(
    archive: PayloadArchive,
    entryName: string,
    entry: StreamZip.ZipEntry | undefined,
    targetPath: string,
    claimedSize: number,
    cumulativeExtractedBytes: number,
    singleEntryCap: number,
    cumulativeCap: number
  ): Promise<{ written: number; sha256: string }> {
    const safeName = sanitizeEntryNameForMessage(entryName)
    // LOCK-CORR-4: an entry that disappeared between the intake inventory
    // and the reopened central directory is a payload-level degrade — the
    // archive remains safely readable and the parser can continue with
    // other entries. Never fatal.
    if (!entry) {
      throw new PayloadStreamFailure('read', 0, `payload entry absent on reopen: ${safeName}`)
    }
    // LOCK-CORR-2: the expected CRC is the central-directory CRC of this
    // entry (an unsigned 32-bit value).
    const expectedCrc = entry.crc >>> 0
    // LOCK-FIX-7: the remaining cumulative budget is enforced on ACTUAL
    // streamed bytes (defense-in-depth on top of the central-directory
    // quota validated by the intake pass).
    const remainingBudget = cumulativeCap - cumulativeExtractedBytes
    const hash = crypto.createHash('sha256')
    let crc = 0
    let written = 0
    let failure: PayloadStreamFailure | null = null

    const guard = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
        if (failure) {
          callback(failure)
          return
        }
        const next = written + chunk.length
        if (next > singleEntryCap || next > remainingBudget) {
          failure = new PayloadStreamFailure('overflow', next, `payload exceeded hard caps: ${safeName}`)
          callback(failure)
          return
        }
        if (next > claimedSize) {
          failure = new PayloadStreamFailure('sizeMismatch', next, `payload exceeded claimed size: ${safeName}`)
          callback(failure)
          return
        }
        hash.update(chunk)
        // LOCK-CORR-2: incremental CRC-32 over the streamed UNCOMPRESSED
        // bytes (zlib.crc32 continuation — no whole-payload buffering).
        crc = zlib.crc32(chunk, crc)
        written = next
        callback(null, chunk)
      },
      flush(callback: (error?: Error | null) => void) {
        if (written !== claimedSize) {
          failure = new PayloadStreamFailure('truncated', written, `payload shorter than claimed: ${safeName}`)
          callback(failure)
          return
        }
        callback()
      }
    })

    const out = fs.createWriteStream(targetPath)
    let stm: NodeJS.ReadableStream
    try {
      // LOCK-CORR-4: the stream open + read live INSIDE the per-payload
      // guard — any per-entry failure (the entry vanished between the shared
      // CEN map and the stream, a read/CRC error, an fs error) is a
      // payload-level degrade. Only the archive open / CEN parse (handled in
      // openPayloadArchive) is fatal.
      stm = await archive.zip.stream(entryName)
      await pipeline(stm, guard, out)
    } catch (error) {
      if (error instanceof PayloadStreamFailure) throw error
      // Library-level CRC/read error on this entry — the archive parser can
      // safely continue with other entries (LOCK-FIX-4/LOCK-CORR-4 degrade).
      throw new PayloadStreamFailure('read', written, `payload stream error: ${safeName}`)
    }
    // LOCK-CORR-2: node-stream-zip skips its own EntryVerifyStream for
    // data-descriptor (bit 3) entries, so the plane verifies the CRC-32 of
    // the streamed uncompressed bytes against the central directory for
    // EVERY payload. A mismatch is a per-payload payloadReadFailure degrade.
    if (crc >>> 0 !== expectedCrc) {
      throw new PayloadStreamFailure('read', written, `payload CRC mismatch: ${safeName}`)
    }
    return { written, sha256: hash.digest('hex') }
  }

  // -------------------------------------------------------------------------
  // Internals — durable catalog write (LOCK-FIX-2)
  // -------------------------------------------------------------------------

  /**
   * Atomically write + fsync the catalog handoff (temp file → rename) and
   * validate the written bytes by read-back. Fail closed: any write/rename/
   * validation failure throws CATALOG_WRITE_FAILED.
   */
  private writeCatalogDurable(catalog: CandidateFilesCatalog): void {
    let encoded: string
    try {
      encoded = JSON.stringify(catalog)
    } catch (error) {
      logger.error(`Session ${this.sessionId}: catalog encode failed:`, error as Error)
      throw new ChatImportAttachmentError('CATALOG_WRITE_FAILED', 'catalog handoff encoding failed (fail closed)')
    }
    const tmpPath = `${this.catalogPath}.tmp`
    try {
      // The catalog directory (the owned candidate directory) must exist
      // before the temp file is created and before the atomic rename.
      fs.mkdirSync(path.dirname(this.catalogPath), { recursive: true })
      const fd = fs.openSync(tmpPath, 'w')
      try {
        fs.writeFileSync(fd, encoded, 'utf8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmpPath, this.catalogPath)
    } catch (error) {
      logger.error(`Session ${this.sessionId}: catalog handoff write failed:`, error as Error)
      try {
        fs.rmSync(tmpPath, { force: true })
      } catch {
        // Best-effort temp cleanup.
      }
      throw new ChatImportAttachmentError(
        'CATALOG_WRITE_FAILED',
        'catalog handoff could not be written durably (fail closed)'
      )
    }
    if (readAndValidateCatalog(this.catalogPath) === null) {
      throw new ChatImportAttachmentError(
        'CATALOG_WRITE_FAILED',
        'catalog handoff failed validation on write (fail closed)'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/**
 * LOCK-FIX-6 (count normalization for healthy unreferenced rows): the
 * candidate target count is the reference multiplicity when it is > 0;
 * otherwise it is `max(valid source count, 1)` where a valid source count
 * is a non-negative safe integer and absent/invalid/negative source counts
 * default to 1. The result is ALWAYS >= 1 — a healthy imported file with
 * zero message references therefore stays in the target Dexie files catalog
 * / file browser instead of being removed by startup orphan cleanup
 * (OrphanCleanupService removes count <= 0 rows). Only the candidate target
 * catalog is normalized; the source row/count evidence and manifest inputs
 * are preserved untouched.
 */
function normalizeTargetCount(referenceCount: number, sourceCount: number | null): number {
  if (referenceCount > 0) return referenceCount
  const valid = sourceCount !== null && Number.isSafeInteger(sourceCount) && sourceCount >= 0 ? sourceCount : 1
  return Math.max(valid, 1)
}

/** Basename of a `Data/Files/...` entry ('' for a trailing-slash name). */
function payloadBasename(entryName: string): string {
  const rest = entryName.slice(FILES_PAYLOAD_PREFIX.length)
  const slash = rest.lastIndexOf('/')
  return slash === -1 ? rest : rest.slice(slash + 1)
}

/**
 * LOCK-FIX-6: a candidate target component (id or ext) must be a single
 * safe path component — no separators, no traversal, no NUL, no Windows
 * unsafe names. Never build a filesystem path from an unsafe value.
 */
function isSafeTargetComponent(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false
  if (value.includes('/') || value.includes('\\') || value.includes('\x00')) return false
  if (value === '.' || value === '..') return false
  return true
}

/** Remove a partial payload file best-effort (never throws). */
function removeFileBestEffort(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { force: true })
  } catch {
    // Best-effort — candidate dir cleanup owns the rest.
  }
}

/**
 * Read + structurally validate the catalog handoff. Returns null on ANY
 * failure (missing file, parse error, schema violation, unsafe path). Never
 * throws.
 */
export function readAndValidateCatalog(catalogPath: string): CandidateFilesCatalog | null {
  let raw: string
  try {
    raw = fs.readFileSync(catalogPath, 'utf8')
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
  const catalog = parsed as Record<string, unknown>
  if (catalog.version !== FILES_CATALOG_VERSION) return null
  if (typeof catalog.sessionId !== 'string' || catalog.sessionId.length === 0) return null
  if (typeof catalog.createdAt !== 'string') return null
  // Aggregate-shape validation: the referenced/degraded/skipped blocks must
  // be present with non-negative safe-integer counts over ONLY the known
  // categories (LOCK-CORR — strengthened read-back of the handoff).
  if (catalog.referenced === null || typeof catalog.referenced !== 'object' || Array.isArray(catalog.referenced)) {
    return null
  }
  const referencedCount = (catalog.referenced as Record<string, unknown>).referencedFileIdCount
  if (typeof referencedCount !== 'number' || !Number.isSafeInteger(referencedCount) || referencedCount < 0) {
    return null
  }
  if (!isKnownCountRecord(catalog.degraded, DEGRADE_CATEGORIES)) return null
  if (!isKnownCountRecord(catalog.skipped, SKIPPED_CATEGORIES)) return null
  if (!Array.isArray(catalog.rows)) return null
  for (const row of catalog.rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || r.id.length === 0) return null
    if (typeof r.name !== 'string') return null
    if (typeof r.origin_name !== 'string') return null
    if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) return null
    if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) return null
    if (typeof r.ext !== 'string') return null
    if (r.type !== null && typeof r.type !== 'string') return null
    if (r.created_at !== null && typeof r.created_at !== 'string') return null
    if (typeof r.count !== 'number' || !Number.isSafeInteger(r.count) || r.count < 0) return null
    if (typeof r.path !== 'string') return null
    // LOCK-FIX-6: the handoff path must be exactly the canonical
    // `Files/<name>` with a safe single-component name (never a source
    // absolute path, never a traversal).
    if (!r.path.startsWith('Files/')) return null
    const name = r.path.slice('Files/'.length)
    if (name !== r.name || !isSafeTargetComponent(name)) return null
    // LOCK-CORR: the canonical physical filename is exactly `id + ext`
    // (a legitimate empty ext is allowed: `Files/<id>`). A row whose name
    // does not equal `id + ext` is a handoff corruption — reject.
    if (r.name !== `${r.id}${r.ext}`) return null
  }
  return catalog as unknown as CandidateFilesCatalog
}

/**
 * Validate an aggregate count record: a plain object whose values are all
 * non-negative safe integers keyed ONLY by the given known categories.
 * Rejects unknown categories (handoff corruption / schema drift), missing
 * required categories, and any non-count value.
 */
function isKnownCountRecord(value: unknown, categories: ReadonlySet<string>): value is Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== categories.size) return false
  for (const key of keys) {
    if (!categories.has(key)) return false
    const count = record[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return false
  }
  return true
}

/** Create an AttachmentPlane (production factory, LOCK-O8). */
export function createAttachmentPlane(options: AttachmentPlaneOptions): AttachmentPlane {
  return new AttachmentPlane(options)
}
