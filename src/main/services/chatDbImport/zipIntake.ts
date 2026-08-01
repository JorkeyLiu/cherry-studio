/**
 * Secure ZIP extraction for the ChatImport pipeline.
 *
 * Five validation layers enforced BEFORE extraction:
 *   Layer 1: fs.stat — file exists, regular file, size ≤ MAX_ZIP_SIZE_BYTES
 *   Layer 2: enumerate entries — entry count, single entry size, total uncompressed, encrypted flag
 *   Layer 3: zip-slip — path.resolve cross-platform check for every entry
 *   Layer 4: post-extract Chromium IndexedDB structure validation
 *   Layer 5: extraction via zip.extract(null, destDir)
 *
 * Uses node-stream-zip (already in repo deps — BackupManager, DxtService).
 *
 * R-6 (zip-slip): path.resolve cross-platform check BEFORE extraction.
 * R-7 (zip-bomb): layer 2 caps BEFORE extraction.
 * R-8 (encrypted): entry.flags & 1 reject BEFORE extraction.
 * R-11 (LevelDB lock): design uses isolated session root (copy of ZIP data).
 * R-12 (origin-mapping variance): structure validation accepts ANY subdir with .ldb files.
 */

import fs from 'node:fs'
import path from 'node:path'

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

/** Maximum ZIP file size in bytes (500 MB). */
export const MAX_ZIP_SIZE_BYTES = 500 * 1024 * 1024

/** Maximum number of entries in the ZIP. */
export const MAX_ENTRY_COUNT = 10_000

/** Maximum uncompressed size of a single entry (200 MB). */
export const MAX_SINGLE_ENTRY_BYTES = 200 * 1024 * 1024

/** Maximum total uncompressed size across all entries (2 GB). */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024

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
}

/**
 * Securely extract a Cherry Studio ZIP backup into destDir.
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
    // Layer 2: enumerate and validate entries
    const { entryCount, totalUncompressedBytes } = await validateEntries(zip)

    // Layer 3: zip-slip check (before extraction)
    await validateNoZipSlip(zip, destDir)

    // Layer 5: extract
    logger.info(`Extracting ZIP (${entryCount} entries, ${totalUncompressedBytes} bytes uncompressed) to ${destDir}`)
    await zip.extract(null, destDir)
    logger.info('Extraction complete')

    // Layer 4: post-extract IndexedDB structure validation
    const indexedDbDir = validateIndexedDbStructure(destDir)

    return { destDir, indexedDbDir, entryCount, totalUncompressedBytes }
  } finally {
    await zip.close()
  }
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
 * Layer 2: Enumerate entries and validate counts, sizes, and encryption.
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
 * validates entry sizes are finite non-negative safe integers, and
 * performs safe aggregate addition to prevent overflow.
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
    // node-stream-zip provides `size` (uncompressed) on each entry.
    const entryAny = entry as { size?: number }
    const uncompressedSize = entryAny.size ?? 0

    if (!Number.isFinite(uncompressedSize) || !Number.isInteger(uncompressedSize) || uncompressedSize < 0) {
      throw new ChatImportZipError(
        'INVALID_ENTRY_SIZE',
        `Entry "${sanitizeEntryNameForMessage(entry.name)}" has invalid uncompressed size: ${uncompressedSize}. ` +
          'Size must be a finite non-negative integer.'
      )
    }

    // Single entry size check
    if (uncompressedSize > MAX_SINGLE_ENTRY_BYTES) {
      throw new ChatImportZipError(
        'SINGLE_ENTRY_TOO_LARGE',
        `Entry "${sanitizeEntryNameForMessage(entry.name)}" size (${uncompressedSize} bytes) exceeds maximum (${MAX_SINGLE_ENTRY_BYTES} bytes)`
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

    // Encrypted entry check (bit 0 of general purpose bit flag)
    if (entry.flags !== undefined && (entry.flags & 1) !== 0) {
      throw new ChatImportZipError('ENCRYPTED', 'ZIP contains encrypted entries which are not supported')
    }
  }

  if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new ChatImportZipError(
      'TOTAL_UNCOMPRESSED_TOO_LARGE',
      `Total uncompressed size (${totalUncompressedBytes} bytes) exceeds maximum (${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes)`
    )
  }

  return { entryCount: rawEntryCount, totalUncompressedBytes }
}

/**
 * Layer 3: Validate all entry names against zip-slip (path traversal).
 *
 * Cross-platform: uses path.resolve (not POSIX-only) to verify that
 * every resolved path stays within destDir.
 */
export async function validateNoZipSlip(zip: StreamZip.StreamZipAsync, destDir: string): Promise<void> {
  const entries = await zip.entries()
  const resolvedDest = path.resolve(destDir) + path.sep

  for (const entry of Object.values(entries)) {
    const name = entry.name

    // Reject absolute paths
    if (path.isAbsolute(name)) {
      throw new ChatImportZipError('PATH_TRAVERSAL', 'ZIP entry has an absolute path')
    }

    // Reject entries with '..' components
    if (name.includes('..')) {
      throw new ChatImportZipError('PATH_TRAVERSAL', 'ZIP entry contains ".." path component')
    }

    // Cross-platform resolve check
    const resolved = path.resolve(destDir, name)
    if (!resolved.startsWith(resolvedDest) && resolved !== resolvedDest.slice(0, -1)) {
      throw new ChatImportZipError('PATH_TRAVERSAL', 'ZIP entry resolves outside the destination directory')
    }
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
