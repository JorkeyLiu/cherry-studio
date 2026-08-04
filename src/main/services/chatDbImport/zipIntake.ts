/**
 * Secure ZIP extraction for the ChatImport pipeline (LOCK-PROD-8/9).
 *
 * Selective extraction — only L2-required Chromium subtrees are materialized:
 *   1. the exact accepted origin IndexedDB LevelDB subtree, plus
 *   2. its matching `.indexeddb.blob` subtree when present, plus
 *   3. the bounded `Local Storage/leveldb` subtree needed for the
 *      navigation projection (LOCK-PROD-2/6).
 *
 * Everything else in the container — `Data/`, images/attachments, `chat.db`,
 * Memory/Knowledge/Agents/Notes/Skills, unrelated origins — is NEVER
 * extracted, while STILL participating in container-level safety validation
 * (path traversal, absolute/drive/backslash/NUL, normalized duplicates,
 * symlink/unsupported mode, encryption).
 *
 *  Validation layers:
 *   Layer 1: fs.stat — file exists, regular file, size ≤ 4 GiB
 *   Layer 2: container-level entry validation — entry count ≤ 10,000,
 *            duplicate CEN detection, safe sizes, symlink/special-mode
 *            rejection, encrypted rejection
 *   Layer 3: zip-slip — path.resolve cross-platform check plus absolute
 *            (POSIX + drive-letter), backslash, NUL and ".." component
 *            rejection for every entry; canonical extraction-target
 *            duplicate rejection (LOCK-FZ2: a/b vs a//b vs a/./b)
 *   Layer 3.5: origin classification from the CENTRAL DIRECTORY + selected
 *            subtree byte limits (cumulative ≤ 768 MiB, single ≤ 128 MiB,
 *            compression ratio ≤ 100) — BEFORE extraction
 *   Layer 5: selective extraction of only the accepted subtrees, with
 *            ACTUAL-byte enforcement (LOCK-FZ1): each selected entry streams
 *            through a counting transform that aborts when written bytes
 *            exceed the claimed central size (or the single/cumulative caps)
 *            and requires the final count to equal the claimed size exactly
 *   Layer 4: post-extract Chromium IndexedDB structure validation
 *
 *  Uses node-stream-zip (already in repo deps — BackupManager, DxtService).
 *
 *  R-6 (zip-slip): path.resolve cross-platform check BEFORE extraction.
 *  R-7 (zip-bomb): layer 2 + 3.5 caps BEFORE extraction.
 *  R-8 (encrypted): entry.flags & 1 reject BEFORE extraction.
 *  R-11 (LevelDB lock): design uses isolated session root (copy of ZIP data).
 *  R-12 (origin-mapping variance): structure validation accepts ANY subdir
 *       with .ldb files; classification accepts exactly the known origins.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { loggerService } from '@logger'
import StreamZip from 'node-stream-zip'

import { ChatImportZipError } from './errors'

const logger = loggerService.withContext('chatDbImport')

// ---------------------------------------------------------------------------
// Exported constants (configurable for tests)
// ---------------------------------------------------------------------------

/**
 * Sanitize a ZIP entry name for inclusion in user-facing error messages.
 * - Strips directory components (basename only).
 * - Truncates to 40 characters.
 * - Replaces with '<redacted>' if the name contains control chars, '/', or '\\'.
 *
 * @param name Raw entry.name from the ZIP.
 * @returns Sanitized name safe for error detail strings.
 */
export function sanitizeEntryNameForMessage(name: string): string {
  // Reject names with control chars (including null bytes) or path separators
  if (/[\x00-\x1f\x7f/\\]/.test(name)) {
    return '<redacted>'
  }
  // Take basename (in case somehow a path-like name got through without separators)
  const base = name.length > 40 ? name.slice(0, 40) + '…' : name
  return base || '<empty>'
}

/**
 * Maximum ZIP file size in bytes (LOCK-PROD-9 container hard cap: 4 GiB).
 * The real Cherry Studio backup class is ~1.39 GiB compressed — comfortably
 * within this bound.
 */
export const MAX_ZIP_SIZE_BYTES = 4 * 1024 * 1024 * 1024

/** Maximum number of central-directory entries in the container. */
export const MAX_ENTRY_COUNT = 10_000

/** Maximum cumulative uncompressed size of SELECTED entries (768 MiB). */
export const MAX_SELECTED_TOTAL_UNCOMPRESSED_BYTES = 768 * 1024 * 1024

/** Maximum uncompressed size of a single SELECTED entry (128 MiB). */
export const MAX_SELECTED_SINGLE_ENTRY_BYTES = 128 * 1024 * 1024

/** Maximum compression ratio (uncompressed / compressed) of a selected entry. */
export const MAX_SELECTED_COMPRESSION_RATIO = 100

// ---------------------------------------------------------------------------
// Origin classification constants
// ---------------------------------------------------------------------------

/** Exact LevelDB directory name for the file:// origin (Chromium mapping). */
export const FILE_ORIGIN_DIR = 'file__0.indexeddb.leveldb'

/** Exact LevelDB directory name for the dev origin (Chromium mapping of http://localhost:5173). */
export const DEV_ORIGIN_DIR = 'http_localhost_5173.indexeddb.leveldb'

/**
 * Discriminated union for the classified origin of an extracted ZIP.
 *
 * - `file`: the ZIP contains only the file-origin LevelDB directory.
 *   Supported in both packaged and unpackaged apps.
 * - `dev`: the ZIP contains only the dev-origin LevelDB directory.
 *   Supported only when `app.isPackaged === false`.
 */
export type OriginClassification =
  | { readonly kind: 'file'; readonly indexedDbDir: string }
  | { readonly kind: 'dev'; readonly indexedDbDir: string }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractResult {
  /** Absolute path to the extraction destination directory. */
  destDir: string
  /** Absolute path to the IndexedDB directory within destDir. */
  indexedDbDir: string
  /** Number of entries in the ZIP. */
  entryCount: number
  /** Total uncompressed size of all entries in bytes. */
  totalUncompressedBytes: number
  /** Classified origin (LOCK-PROD-8: single accepted origin). */
  origin: OriginClassification
  /** Number of entries selected for extraction. */
  selectedEntryCount: number
}

/**
 * Securely extract ONLY the L2-required Chromium subtrees of a Cherry Studio
 * ZIP backup into destDir (LOCK-PROD-8).
 *
 * The caller is responsible for providing and managing the destDir lifecycle
 * (typically via tempWorkspace.createTempWorkspace()).
 *
 * @param zipPath  Absolute path to the ZIP file.
 * @param destDir  Absolute path to the extraction directory (must already exist).
 * @returns Extraction metadata.
 * @throws {ChatImportZipError} If any validation layer rejects the ZIP.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<ExtractResult> {
  // Layer 1: stat check
  await validateFileStat(zipPath)

  // Open ZIP for enumeration
  const zip = new StreamZip.async({ file: zipPath })

  try {
    // Layer 2: enumerate and validate entries (container-level)
    const { entryCount, totalUncompressedBytes } = await validateEntries(zip)

    // Layer 3: zip-slip check (before extraction)
    await validateNoZipSlip(zip, destDir)

    // Layer 3.5: classify the origin from the central directory and validate
    // selected subtree byte limits BEFORE anything is materialized
    // (LOCK-PROD-8/9).
    const selection = await selectExtractionEntries(zip, destDir, appIsPackaged())

    // Layer 5: extract ONLY the selected entries, each to its EXACT path
    // under destDir (LOCK-PROD-8). Parent directories are created
    // explicitly (node-stream-zip's per-file extract does NOT create them);
    // node-stream-zip always writes regular files (symlink entries are
    // rejected in Layer 2, and no symlinks are ever created).
    //
    // LOCK-FZ1: every selected entry is streamed through a counting
    // transform that enforces the ACTUAL written bytes against the
    // validated central uncompressed size (and the single-entry /
    // cumulative caps), because node-stream-zip skips its own
    // EntryVerifyStream for data-descriptor (flag bit 3) entries — the
    // form produced by the real backup writer (archiver).
    logger.info(
      `Selectively extracting ${selection.selectedEntryCount} entry(ies) ` +
        `(${selection.selectedTotalUncompressedBytes} bytes uncompressed) to ${destDir}`
    )
    let extractedTotalBytes = 0
    for (const entry of selection.selectedEntries) {
      const target = path.join(destDir, entry.name)
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const written = await extractEntryBounded(
          zip,
          entry.name,
          target,
          entry.size,
          MAX_SELECTED_SINGLE_ENTRY_BYTES,
          MAX_SELECTED_TOTAL_UNCOMPRESSED_BYTES - extractedTotalBytes
        )
        extractedTotalBytes += written
      } catch (error) {
        // LOCK-FZ1/LOCK-Z5: typed size/bound violations pass through with
        // their sanitized message (no paths). Everything else — including
        // the library's own CRC/size errors and raw fs errors — is
        // wrapped; surfaced messages must never leak source paths. The
        // underlying error usually embeds the full temp target path —
        // redact destDir and the source ZIP path before wrapping.
        if (error instanceof ChatImportZipError) {
          throw error
        }
        const detail = error instanceof Error && error.message ? error.message.split('\n')[0].trim() : 'unknown error'
        const redacted = detail.replaceAll(destDir, '<destDir>').replaceAll(zipPath, '<zipPath>')
        throw new ChatImportZipError(
          'EXTRACT_FAILED',
          `Failed to extract entry "${sanitizeEntryNameForMessage(entry.name)}": ${redacted}`
        )
      }
    }
    logger.info('Selective extraction complete')

    // Layer 4: post-extract IndexedDB structure validation
    const indexedDbDir = validateIndexedDbStructure(destDir)

    return {
      destDir,
      indexedDbDir,
      entryCount,
      totalUncompressedBytes,
      origin: selection.origin,
      selectedEntryCount: selection.selectedEntryCount
    }
  } finally {
    await zip.close()
  }
}

// ---------------------------------------------------------------------------
// LOCK-FZ1 — actual extracted-byte enforcement
// ---------------------------------------------------------------------------

/**
 * Extract a single selected entry with hard bounds on the ACTUAL bytes
 * written (LOCK-FZ1).
 *
 * node-stream-zip skips its EntryVerifyStream for data-descriptor (flag
 * bit 3) entries — the exact form produced by the real backup writer
 * (archiver) — so a crafted entry's inflate output is unbounded relative
 * to the claimed central-directory size. Instead of trusting `zip.extract`
 * blindly, this streams the entry through a counting transform that:
 *
 *   1. aborts as soon as written bytes exceed the claimed central
 *      uncompressed size, the per-entry cap (128 MiB) or the remaining
 *      cumulative cap (768 MiB) — BEFORE the oversized chunk is written,
 *      and
 *   2. requires the final byte count to equal the claimed size exactly.
 *
 * Non-bit-3 entries additionally keep the library's own CRC/size
 * verification upstream of this transform. On any abort/mismatch the
 * partial target file is removed so no oversized or malformed output
 * remains behind (the caller-owned destDir lifecycle still cleans up the
 * rest of the workspace).
 *
 * @returns The number of bytes actually written (=== claimedSize on success).
 * @throws {ChatImportZipError} SELECTED_EXTRACT_OVERFLOW if written bytes
 *   exceed the claimed size / caps during streaming; SELECTED_ENTRY_SIZE_MISMATCH
 *   if the stream ends with a byte count different from the claimed size.
 */
async function extractEntryBounded(
  zip: StreamZip.StreamZipAsync,
  entryName: string,
  target: string,
  claimedSize: number,
  singleEntryCap: number,
  remainingBudget: number
): Promise<number> {
  const safeName = sanitizeEntryNameForMessage(entryName)
  let written = 0
  let guardError: ChatImportZipError | null = null

  // Counting transform: enforces LOCK-FZ1 per-chunk and at stream end.
  // Only ever passes chunks through (never buffers), so memory stays
  // proportional to the stream chunk size (LOCK-FZ3: no huge allocations).
  const guard = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
      if (guardError) {
        callback(guardError)
        return
      }
      const next = written + chunk.length
      if (next > claimedSize || next > singleEntryCap || next > remainingBudget) {
        guardError = new ChatImportZipError(
          'SELECTED_EXTRACT_OVERFLOW',
          `Entry "${safeName}" produced ${next} uncompressed bytes during extraction, exceeding its ` +
            `validated size of ${claimedSize} bytes (LOCK-FZ1)`
        )
        callback(guardError)
        return
      }
      written = next
      callback(null, chunk)
    },
    flush(callback: (error?: Error | null) => void) {
      if (written !== claimedSize) {
        guardError = new ChatImportZipError(
          'SELECTED_ENTRY_SIZE_MISMATCH',
          `Entry "${safeName}" extracted ${written} bytes but the central directory declared ` +
            `${claimedSize} bytes (LOCK-FZ1)`
        )
        callback(guardError)
        return
      }
      callback()
    }
  })

  const stm = await zip.stream(entryName)
  const out = fs.createWriteStream(target)
  try {
    // pipeline destroys every stream in the chain (including the library's
    // entry stream) on error, so no oversized output is ever materialized.
    await pipeline(stm, guard, out)
  } catch (error) {
    // LOCK-FZ1: never leave an oversized/malformed partial file behind.
    try {
      fs.rmSync(target, { force: true })
    } catch {
      // Best-effort cleanup; the caller-owned destDir is removed wholesale
      // by the workspace lifecycle if this ever fails.
    }
    throw error
  }
  return written
}

// ---------------------------------------------------------------------------
// Validation layers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Layer 1: Validate file stat — exists, regular file, size within limit.
 */
export async function validateFileStat(zipPath: string): Promise<void> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(zipPath)
  } catch {
    throw new ChatImportZipError('FILE_NOT_FOUND', 'ZIP file does not exist or is not accessible')
  }

  if (!stat.isFile()) {
    throw new ChatImportZipError('NOT_A_FILE', 'ZIP path is not a regular file')
  }

  if (stat.size > MAX_ZIP_SIZE_BYTES) {
    throw new ChatImportZipError(
      'TOO_LARGE',
      `ZIP file size (${stat.size} bytes) exceeds maximum (${MAX_ZIP_SIZE_BYTES} bytes)`
    )
  }
}

/**
 * Layer 2: Container-level entry validation — counts, safe sizes, duplicates,
 * encryption, symlink/special-mode rejection (LOCK-Z2, LOCK-PROD-9). Byte
 * LIMITS are deliberately NOT enforced here: non-selected entries are
 * excluded from extraction and therefore excluded from selected-byte limits,
 * but they still participate in every safety check below.
 *
 * Returns entryCount and totalUncompressedBytes for the caller.
 *
 * LOCK-6031: Uses the raw central-directory entry count (via entriesCount)
 * rather than the name-keyed Object.values().length. node-stream-zip's
 * entries() returns a Record<string, ZipEntry> keyed by entry name, which
 * collapses duplicate CEN entries with the same name. The raw entriesCount
 * preserves the actual number of central-directory records, preventing
 * undercounting of duplicate entries.
 *
 * LOCK-6031: Rejects ZIPs with duplicate central-directory entry names,
 * validates entry sizes are finite non-negative safe integers, and performs
 * safe aggregate addition to prevent overflow.
 */
export async function validateEntries(
  zip: StreamZip.StreamZipAsync
): Promise<{ entryCount: number; totalUncompressedBytes: number }> {
  const entries = await zip.entries()
  const entryList = Object.values(entries)

  // LOCK-6031: Use the raw central-directory entry count from node-stream-zip
  // (via entriesCount) rather than the name-keyed Object.values().length.
  // node-stream-zip's entries() returns a Record<string, ZipEntry> keyed by
  // entry name, which collapses duplicate CEN entries with the same name.
  // The raw entriesCount preserves the actual number of central-directory
  // records, preventing undercounting of duplicate entries.
  const rawEntryCount = await zip.entriesCount
  const dedupedCount = entryList.length

  // LOCK-6031: Reject ZIPs with duplicate central-directory entries.
  // Duplicate names indicate either corruption or a zip bomb variant
  // designed to undercount via the name-keyed entries() map.
  if (rawEntryCount > dedupedCount) {
    throw new ChatImportZipError(
      'DUPLICATE_ENTRIES',
      `ZIP has ${rawEntryCount} raw central-directory entries but only ${dedupedCount} unique names. ` +
        'Duplicate central-directory entries detected — possible corruption or zip bomb.'
    )
  }

  // LOCK-6031: Enforce entry count limit using the raw CEN count.
  if (rawEntryCount > MAX_ENTRY_COUNT) {
    throw new ChatImportZipError(
      'TOO_MANY_ENTRIES',
      `Entry count (${rawEntryCount}) exceeds maximum (${MAX_ENTRY_COUNT})`
    )
  }

  let totalUncompressedBytes = 0

  for (const entry of entryList) {
    // Skip directories
    if (entry.isDirectory) continue

    // LOCK-6031: Validate entry size is a finite non-negative safe integer.
    // `Number.isSafeInteger` (not just isInteger) rejects ZIP64-sourced sizes
    // above 2^53 that the 64-bit extra fields can express — such a size is
    // beyond what the extraction pipeline can faithfully materialize, so it
    // is rejected fail-closed at the metadata layer.
    const entryAny = entry as { size?: number }
    const uncompressedSize = entryAny.size ?? 0

    if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
      throw new ChatImportZipError(
        'INVALID_ENTRY_SIZE',
        `Entry "${sanitizeEntryNameForMessage(entry.name)}" has invalid uncompressed size: ${uncompressedSize}. ` +
          'Size must be a finite non-negative safe integer.'
      )
    }

    // LOCK-6031: Safe aggregate addition — prevent overflow before accumulation.
    const newTotal = totalUncompressedBytes + uncompressedSize
    if (!Number.isFinite(newTotal) || newTotal > Number.MAX_SAFE_INTEGER) {
      throw new ChatImportZipError(
        'INVALID_ENTRY_SIZE',
        `Total uncompressed size would overflow safe integer range after adding entry "${sanitizeEntryNameForMessage(entry.name)}" ` +
          `(${totalUncompressedBytes} + ${uncompressedSize}). Aggregate size overflow — possible corrupted ZIP.`
      )
    }
    totalUncompressedBytes = newTotal

    // LOCK-Z2: symlink / unsupported file-type detection from the external
    // attributes node-stream-zip exposes as `attr`. The upper 16 bits carry
    // the POSIX mode when a unix-style writer created the entry. Regular
    // files (0x8000) and directories (0x4000) are accepted; a symlink
    // (0xA000) or any other special type (fifo/chr/blk/sock) rejects the
    // container fail-closed. mode 0 means no POSIX mode is present
    // (e.g. Windows-made archives) — treated leniently as a regular file.
    const attr = (entry as { attr?: number }).attr ?? 0
    const fileType = (attr >>> 16) & 0xf000
    if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
      throw new ChatImportZipError(
        'UNSUPPORTED_ENTRY_TYPE',
        `Entry "${sanitizeEntryNameForMessage(entry.name)}" is not a regular file or directory ` +
          `(mode 0x${fileType.toString(16)}). Symlink and special-type entries are not supported.`
      )
    }

    // Encrypted entry check (bit 0 of general purpose bit flag)
    if (entry.flags !== undefined && (entry.flags & 1) !== 0) {
      throw new ChatImportZipError('ENCRYPTED', 'ZIP contains encrypted entries which are not supported')
    }
  }

  return { entryCount: rawEntryCount, totalUncompressedBytes }
}

/**
 * Layer 3: Validate all entry names against zip-slip (path traversal).
 *
 * LOCK-Z2: rejects absolute paths (POSIX and Windows drive-letter forms),
 * backslash path separators, NUL bytes, and ".." path components on every
 * entry BEFORE any extraction. Cross-platform: uses path.resolve (not
 * POSIX-only) to verify that every resolved path stays within destDir.
 *
 * LOCK-FZ2: also rejects duplicate CANONICAL extraction destinations.
 * Distinct entry names can normalize to the same extraction target under
 * path-join semantics — `a/b` vs `a//b` vs `a/./b` all resolve to
 * `destDir/a/b` — so the second entry would silently overwrite the first.
 * The canonical form is computed with path.resolve (the same extraction
 * semantics used to materialize entries) and applies to ALL entries
 * (selected and non-selected), preserving the all-entry duplicate policy.
 * No filesystem probing and no case folding: a stable cross-platform
 * canonical rule exists only for pure path normalization (LOCK-FZ2).
 *
 * Notes:
 * - A backslash is a legal filename character on POSIX, so `..\..\x` would
 *   otherwise slip through path.resolve as a plain (safe) name — reject it
 *   explicitly as a Windows-style separator.
 * - NUL bytes are not rejected by node-stream-zip's own entry-name check and
 *   make fs operations throw non-typed errors — reject them up front.
 */
export async function validateNoZipSlip(zip: StreamZip.StreamZipAsync, destDir: string): Promise<void> {
  const entries = await zip.entries()
  const resolvedDest = path.resolve(destDir) + path.sep
  // LOCK-FZ2: canonical (path-normalized) extraction destinations seen so far.
  const canonicalTargets = new Set<string>()

  for (const entry of Object.values(entries)) {
    const name = entry.name

    // Reject NUL bytes (injection vector; fs ops throw raw errors on them)
    if (name.includes('\x00')) {
      throw new ChatImportZipError('PATH_TRAVERSAL', 'ZIP entry name contains a NUL byte')
    }

    // Reject backslash path separators (Windows-style paths)
    if (name.includes('\\')) {
      throw new ChatImportZipError('PATH_TRAVERSAL', 'ZIP entry contains a backslash path separator')
    }

    // Reject absolute paths — POSIX and Windows drive-letter forms
    if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
      throw new ChatImportZipError('PATH_TRAVERSAL', 'ZIP entry has an absolute path')
    }

    // Reject entries with '..' path components (component check — a name
    // like `file..txt` is a legitimate filename and must not be rejected).
    if (name.split('/').includes('..')) {
      throw new ChatImportZipError('PATH_TRAVERSAL', 'ZIP entry contains ".." path component')
    }

    // Cross-platform resolve check
    const resolved = path.resolve(destDir, name)
    if (!resolved.startsWith(resolvedDest) && resolved !== resolvedDest.slice(0, -1)) {
      throw new ChatImportZipError('PATH_TRAVERSAL', 'ZIP entry resolves outside the destination directory')
    }

    // LOCK-FZ2: canonical-destination duplicate rejection. After the
    // traversal checks above, `resolved` IS the canonical extraction target
    // (path.resolve collapses repeated separators and dot components). Two
    // distinct names that reach the same canonical target would overwrite
    // each other during extraction — reject fail-closed BEFORE extraction.
    if (canonicalTargets.has(resolved)) {
      throw new ChatImportZipError(
        'DUPLICATE_EXTRACTION_TARGET',
        `Multiple ZIP entries resolve to the same extraction destination (collision with entry ` +
          `"${sanitizeEntryNameForMessage(name)}")`
      )
    }
    canonicalTargets.add(resolved)
  }
}

/**
 * Layer 4: Validate the extracted directory contains a Chromium IndexedDB structure.
 *
 * Checks:
 * - destDir/IndexedDB/ exists and is a directory
 * - At least one subdir under IndexedDB/ contains files matching *.ldb
 *
 * Does NOT hardcode `file__0.indexeddb.leveldb` (that was spike's file:// origin
 * observation only). Accepts ANY subdir with .ldb files (R-12).
 */
export function validateIndexedDbStructure(destDir: string): string {
  const indexedDbDir = path.join(destDir, 'IndexedDB')

  let stat: fs.Stats
  try {
    stat = fs.statSync(indexedDbDir)
  } catch {
    throw new ChatImportZipError(
      'NO_INDEXED_DB',
      'ZIP does not contain an IndexedDB directory at the expected location'
    )
  }

  if (!stat.isDirectory()) {
    throw new ChatImportZipError('NO_INDEXED_DB', 'IndexedDB path exists but is not a directory')
  }

  // Find at least one subdir containing .ldb files
  const subdirs = fs.readdirSync(indexedDbDir, { withFileTypes: true }).filter((d) => d.isDirectory())

  for (const subdir of subdirs) {
    const subdirPath = path.join(indexedDbDir, subdir.name)
    try {
      const entries = fs.readdirSync(subdirPath)
      const hasLdb = entries.some((f) => {
        if (!f.endsWith('.ldb')) return false
        // Require regular file (not directory/symlink) — directories with
        // .ldb suffix must not qualify as LevelDB data files.
        try {
          const st = fs.lstatSync(path.join(subdirPath, f))
          return st.isFile()
        } catch {
          return false
        }
      })
      if (hasLdb) {
        logger.info(`Found IndexedDB with LevelDB files in: ${subdir.name}`)
        return indexedDbDir
      }
    } catch {
      // Skip unreadable subdirs
      continue
    }
  }

  throw new ChatImportZipError(
    'NO_INDEXED_DB',
    'IndexedDB directory exists but contains no LevelDB manifest files (.ldb)'
  )
}

/**
 * Enumerate all direct child directories under IndexedDB/ that contain .ldb
 * files. Returns the list of candidate directory names.
 *
 * Structural rule: a directory is a candidate iff it is a direct child of
 * IndexedDB/ AND contains at least one file ending in `.ldb`.
 */
export function enumerateLdbCandidates(indexedDbDir: string): string[] {
  const candidates: string[] = []
  let subdirs: fs.Dirent[]
  try {
    subdirs = fs.readdirSync(indexedDbDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return candidates
  }

  for (const subdir of subdirs) {
    const subdirPath = path.join(indexedDbDir, subdir.name)
    try {
      const entries = fs.readdirSync(subdirPath)
      if (
        entries.some((f) => {
          if (!f.endsWith('.ldb')) return false
          // Require regular file — directories with .ldb suffix must not qualify.
          try {
            const st = fs.lstatSync(path.join(subdirPath, f))
            return st.isFile()
          } catch {
            return false
          }
        })
      ) {
        candidates.push(subdir.name)
      }
    } catch {
      // Skip unreadable subdirs
      continue
    }
  }

  return candidates
}

/**
 * Classify the origin candidates extracted from an IndexedDB ZIP backup.
 *
 * Classification rules (LOCK-DEV-3/4/6):
 * - Exactly one candidate matching FILE_ORIGIN_DIR → `{ kind: 'file' }`
 *   (supported in both packaged and unpackaged).
 * - Exactly one candidate matching DEV_ORIGIN_DIR → `{ kind: 'dev' }`
 *   (supported only when `app.isPackaged === false`).
 * - Multiple .ldb-bearing candidates → AMBIGUOUS_ORIGIN (reject).
 * - Zero .ldb-bearing candidates → NO_INDEXED_DB (reject — caller should
 *   have already caught this via validateIndexedDbStructure).
 * - Single candidate but not a known origin → UNSUPPORTED_ORIGIN (reject).
 *
 * @param indexedDbDir Absolute path to the IndexedDB directory.
 * @param isPackaged  Whether the app is in packaged mode.
 * @returns The classified origin, or throws a structured error.
 * @throws {ChatImportZipError} UNSUPPORTED_ORIGIN | AMBIGUOUS_ORIGIN | PACKAGED_DEV_ORIGIN
 */
export function classifyOriginCandidates(indexedDbDir: string, isPackaged: boolean): OriginClassification {
  const candidates = enumerateLdbCandidates(indexedDbDir)

  if (candidates.length === 0) {
    throw new ChatImportZipError(
      'NO_INDEXED_DB',
      'IndexedDB directory exists but contains no LevelDB manifest files (.ldb)'
    )
  }

  if (candidates.length > 1) {
    const safeNames = candidates.map(sanitizeEntryNameForMessage).join(', ')
    throw new ChatImportZipError(
      'AMBIGUOUS_ORIGIN',
      `IndexedDB contains multiple LevelDB directories (${candidates.length}): [${safeNames}]. ` +
        'ZIP must contain exactly one supported origin.'
    )
  }

  const sole = candidates[0]

  if (sole === FILE_ORIGIN_DIR) {
    return { kind: 'file', indexedDbDir }
  }

  if (sole === DEV_ORIGIN_DIR) {
    if (isPackaged) {
      throw new ChatImportZipError(
        'PACKAGED_DEV_ORIGIN',
        `ZIP contains dev-origin directory "${sanitizeEntryNameForMessage(sole)}" but the app is packaged. ` +
          'Dev-origin imports are only supported in unpackaged development builds.'
      )
    }
    return { kind: 'dev', indexedDbDir }
  }

  throw new ChatImportZipError(
    'UNSUPPORTED_ORIGIN',
    `IndexedDB contains unsupported LevelDB directory "${sanitizeEntryNameForMessage(sole)}". ` +
      `Supported directories: [${FILE_ORIGIN_DIR}, ${DEV_ORIGIN_DIR}] (dev-origin only in unpackaged builds).`
  )
}

// ---------------------------------------------------------------------------
// LOCK-PROD-8/9 — central-directory origin classification + selective limits
// ---------------------------------------------------------------------------

/** Result of {@link selectExtractionEntries}. */
export interface ExtractionSelection {
  /** Classified origin of the accepted IndexedDB subtree. */
  origin: OriginClassification
  /**
   * Selected file entries to materialize (each to its exact path). `size`
   * is the validated central-directory uncompressed size, used by the
   * LOCK-FZ1 actual-byte enforcement during extraction.
   */
  selectedEntries: Array<{ name: string; size: number }>
  /** Number of selected non-directory entries. */
  selectedEntryCount: number
  /** Cumulative uncompressed size of selected entries. */
  selectedTotalUncompressedBytes: number
}

/**
 * Whether the running app is packaged. Lazily reads Electron's `app`; tests
 * override via {@link setAppIsPackagedForTests} so this module stays pure.
 */
export function appIsPackaged(): boolean {
  if (appIsPackagedOverride !== null) return appIsPackagedOverride
  try {
    // Lazy require keeps this module loadable in pure-Node test environments.
    const { app } = require('electron') as { app: { isPackaged: boolean } }
    return app.isPackaged
  } catch {
    return false
  }
}

/** Test override (null = resolve from Electron). Never call from production. */
export function setAppIsPackagedForTests(value: boolean | null): void {
  appIsPackagedOverride = value
}

let appIsPackagedOverride: boolean | null = null

/**
 * Classify the origin from the ZIP CENTRAL DIRECTORY and validate the
 * LOCK-PROD-9 selected-entry bounds BEFORE extraction:
 * - selected cumulative uncompressed ≤ 768 MiB
 * - selected single entry ≤ 128 MiB
 * - selected entry compression ratio ≤ 100
 *
 * Selected entries are exactly:
 *   IndexedDB/<origin>.indexeddb.leveldb/**              (the accepted origin)
 *   IndexedDB/<origin>.indexeddb.blob/**                 (matching blob subtree)
 *   Local Storage/leveldb/**                             (projection data)
 *
 * Everything else (Data/, chat.db, Memory/Knowledge/Agents/Notes/Skills,
 * unrelated origins) is never selected — while container-level safety
 * validation (Layer 2/3) already covered ALL entries (LOCK-PROD-9).
 *
 * @throws {ChatImportZipError} AMBIGUOUS_ORIGIN | UNSUPPORTED_ORIGIN |
 *   PACKAGED_DEV_ORIGIN | NO_INDEXED_DB | SELECTED_TOO_LARGE |
 *   SELECTED_ENTRY_TOO_LARGE | SELECTED_RATIO_TOO_HIGH
 */
export async function selectExtractionEntries(
  zip: StreamZip.StreamZipAsync,
  destDir: string,
  isPackaged: boolean
): Promise<ExtractionSelection> {
  const entries = await zip.entries()
  const entryList = Object.values(entries)

  // ---- LOCK-PROD-8: origin classification from the central directory ----
  // A candidate origin directory is IndexedDB/<name>.indexeddb.leveldb with
  // at least one regular .ldb file entry inside it.
  const originCandidates = new Set<string>()
  for (const entry of entryList) {
    if (entry.isDirectory) continue
    const match = /^IndexedDB\/([^/]+\.indexeddb\.leveldb)\//.exec(entry.name)
    if (!match) continue
    if (entry.name.endsWith('.ldb')) {
      originCandidates.add(match[1])
    }
  }

  if (originCandidates.size === 0) {
    throw new ChatImportZipError(
      'NO_INDEXED_DB',
      'ZIP central directory contains no IndexedDB origin with LevelDB manifest files (.ldb)'
    )
  }

  if (originCandidates.size > 1) {
    const safeNames = Array.from(originCandidates).map(sanitizeEntryNameForMessage).join(', ')
    throw new ChatImportZipError(
      'AMBIGUOUS_ORIGIN',
      `ZIP central directory contains multiple IndexedDB origins (${originCandidates.size}): [${safeNames}]. ` +
        'ZIP must contain exactly one supported origin.'
    )
  }
  const originDir = Array.from(originCandidates)[0]

  if (originDir === FILE_ORIGIN_DIR) {
    // file origin: supported in both modes
  } else if (originDir === DEV_ORIGIN_DIR) {
    if (isPackaged) {
      throw new ChatImportZipError(
        'PACKAGED_DEV_ORIGIN',
        `ZIP contains dev-origin directory "${sanitizeEntryNameForMessage(originDir)}" but the app is packaged. ` +
          'Dev-origin imports are only supported in unpackaged development builds.'
      )
    }
  } else {
    throw new ChatImportZipError(
      'UNSUPPORTED_ORIGIN',
      `ZIP central directory contains unsupported IndexedDB origin "${sanitizeEntryNameForMessage(originDir)}". ` +
        `Supported origins: [${FILE_ORIGIN_DIR}, ${DEV_ORIGIN_DIR}] (dev-origin only in unpackaged builds).`
    )
  }

  // Blob subtree name mirrors the leveldb name (Chromium convention).
  const blobDir = originDir.replace(/\.indexeddb\.leveldb$/, '.indexeddb.blob')
  const originPrefix = `IndexedDB/${originDir}/`
  const blobPrefix = `IndexedDB/${blobDir}/`
  const localStoragePrefix = 'Local Storage/leveldb/'

  // ---- LOCK-PROD-9: selected subtree limits ----
  let selectedEntryCount = 0
  let selectedTotalUncompressedBytes = 0
  const selectedEntries: Array<{ name: string; size: number }> = []
  let originPresent = false
  let blobPresent = false
  let localStoragePresent = false

  for (const entry of entryList) {
    if (entry.isDirectory) continue
    const name = entry.name
    const isSelected =
      name.startsWith(originPrefix) || name.startsWith(blobPrefix) || name.startsWith(localStoragePrefix)
    if (!isSelected) continue

    if (name.startsWith(originPrefix)) originPresent = true
    if (name.startsWith(blobPrefix)) blobPresent = true
    if (name.startsWith(localStoragePrefix)) localStoragePresent = true

    const uncompressedSize = (entry as { size?: number }).size ?? 0

    selectedEntryCount++
    selectedEntries.push({ name, size: uncompressedSize })

    // Selected single entry ≤ 128 MiB.
    if (uncompressedSize > MAX_SELECTED_SINGLE_ENTRY_BYTES) {
      throw new ChatImportZipError(
        'SELECTED_ENTRY_TOO_LARGE',
        `Selected entry "${sanitizeEntryNameForMessage(name)}" size (${uncompressedSize} bytes) exceeds ` +
          `maximum (${MAX_SELECTED_SINGLE_ENTRY_BYTES} bytes)`
      )
    }

    // Selected compression ratio ≤ 100. A zero compressed size with a
    // non-zero uncompressed size is an infinite ratio — reject.
    const compressedSize = (entry as { compressedSize?: number }).compressedSize ?? 0
    if (uncompressedSize > 0) {
      const ratio = compressedSize <= 0 ? Infinity : uncompressedSize / compressedSize
      if (ratio > MAX_SELECTED_COMPRESSION_RATIO) {
        throw new ChatImportZipError(
          'SELECTED_RATIO_TOO_HIGH',
          `Selected entry "${sanitizeEntryNameForMessage(name)}" compression ratio ` +
            `(${Number.isFinite(ratio) ? ratio.toFixed(1) : 'infinite'}) exceeds maximum ` +
            `(${MAX_SELECTED_COMPRESSION_RATIO})`
        )
      }
    }

    // Selected cumulative uncompressed ≤ 768 MiB.
    selectedTotalUncompressedBytes += uncompressedSize
    if (selectedTotalUncompressedBytes > MAX_SELECTED_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ChatImportZipError(
        'SELECTED_TOO_LARGE',
        `Selected uncompressed total (${selectedTotalUncompressedBytes} bytes) exceeds maximum ` +
          `(${MAX_SELECTED_TOTAL_UNCOMPRESSED_BYTES} bytes)`
      )
    }
  }

  if (!originPresent) {
    // Defensive: the origin was classified from the same entries, so this
    // cannot normally happen — a bug guard, not a user path.
    throw new ChatImportZipError('NO_INDEXED_DB', 'Classified origin has no selected entries under it')
  }

  logger.info(
    `Extraction selection: origin=${originDir}, blob=${blobPresent}, ` +
      `localStorage=${localStoragePresent}, selected=${selectedEntryCount} entries, ` +
      `${selectedTotalUncompressedBytes} bytes uncompressed`
  )

  const indexedDbDir = path.join(destDir, 'IndexedDB')
  const origin: OriginClassification =
    originDir === DEV_ORIGIN_DIR ? { kind: 'dev', indexedDbDir } : { kind: 'file', indexedDbDir }

  return { origin, selectedEntries, selectedEntryCount, selectedTotalUncompressedBytes }
}
