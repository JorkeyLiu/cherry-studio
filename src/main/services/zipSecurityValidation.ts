/**
 * Shared ZIP entry validation for restore extraction paths.
 *
 * Validates every entry in a ZIP before extraction to prevent:
 * - zip-slip (path traversal via ../)
 * - Absolute path entries
 * - NUL bytes or ambiguous separators in entry names
 * - Symlink or device/special entries
 * - Encrypted entries
 * - Canonical containment violations (resolved path escapes destDir)
 *
 * LOCK-6012: Treat every local/provider ZIP and entry name as untrusted.
 * No extraction or downloaded temporary file may escape an operation-owned root.
 *
 * Reused by BackupManager restore and chatDbImport zipIntake.
 */

import path from 'node:path'

import type StreamZip from 'node-stream-zip'

// ---------------------------------------------------------------------------
// LOCK-6025: ZIP resource limits
//
// Bounds for ZIP entry count, per-entry uncompressed size, and total
// uncompressed size. These prevent zip-bomb denial-of-service attacks
// while allowing realistic full-app backup archives.
//
// Rationale:
// - Entry count: A full Cherry Studio backup (IndexedDB, Local Storage,
//   Data with chat.db + knowledge notes) typically has 100-1000 entries.
//   100,000 is generous enough for edge cases while preventing zip bombs
//   that use millions of tiny entries.
// - Per-entry size: chat.db can grow to several GB for heavy users (up to
//   10 GiB). The per-entry limit equals the total limit so that any single
//   entry (including a multi-GiB chat.db) is permitted up to the archive
//   total ceiling.
// - Total size: Full app backup with large DB, knowledge base, and files
//   should rarely exceed 10 GB uncompressed. This prevents zip bombs that
//   decompress to petabytes.
// - Duplicate entries: ZIP central-directory entries with the same name
//   indicate either corruption or an intentional zip bomb variant.
//   Duplicates are rejected; the raw CEN count (via entriesCount) is used
//   for entry-count enforcement to prevent undercounting via the name-keyed
//   entries() map.
// ---------------------------------------------------------------------------

/** Maximum number of entries allowed in a restore ZIP. */
export const MAX_ZIP_ENTRY_COUNT = 100_000

/**
 * Maximum uncompressed size per entry in bytes (10 GiB).
 * Equal to the total limit so that any single entry (e.g., a multi-GiB
 * chat.db) is accepted up to the archive total ceiling.
 */
export const MAX_ZIP_ENTRY_UNCOMPRESSED_SIZE = 10 * 1024 * 1024 * 1024

/** Maximum total uncompressed size across all entries in bytes (10 GB). */
export const MAX_ZIP_TOTAL_UNCOMPRESSED_SIZE = 10 * 1024 * 1024 * 1024

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZipEntryValidationResult {
  /** Number of entries validated. */
  entryCount: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate all entries in a ZIP for containment safety before extraction.
 *
 * Checks performed (in order):
 *   1. Reject absolute path entries (e.g., "/etc/passwd")
 *   2. Reject entries with ".." components (e.g., "../../etc/passwd")
 *   3. Reject entries containing NUL bytes (\x00)
 *   4. Reject entries with ambiguous separators (backslash on any platform)
 *   5. Reject symlink or special (device/pipe/socket) entries
 *   6. Reject encrypted entries (bit 0 of general purpose flag)
 *   7. Cross-platform canonical containment: path.resolve(destDir, entry) must
 *      stay within destDir (with trailing separator)
 *
 * LOCK-6013: Each restore uses a unique clean extraction workspace; abandoned
 * roots are cleaned with bounded recovery/cleanup and cannot influence later
 * restore classification.
 *
 * @param zip       Opened StreamZip.async instance (caller manages close).
 * @param destDir   The extraction destination directory (must be absolute).
 * @returns         Entry count for informational purposes.
 * @throws          Error with descriptive message on any validation failure.
 */
export async function validateRestoreZipEntries(
  zip: StreamZip.StreamZipAsync,
  destDir: string
): Promise<ZipEntryValidationResult> {
  const entries = await zip.entries()
  const entryList = Object.values(entries)

  // LOCK-6025: Use the raw central-directory entry count from node-stream-zip
  // (via entriesCount) rather than the name-keyed Object.values().length.
  // node-stream-zip's entries() returns a Record<string, ZipEntry> keyed by
  // entry name, which collapses duplicate CEN entries with the same name.
  // The raw entriesCount preserves the actual number of central-directory
  // records, preventing undercounting of duplicate entries.
  const rawEntryCount = await zip.entriesCount
  const dedupedCount = entryList.length

  // LOCK-6025: Reject ZIPs with duplicate central-directory entries.
  // Duplicate names indicate either corruption or a zip bomb variant
  // designed to undercount via the name-keyed entries() map.
  if (rawEntryCount > dedupedCount) {
    throw new Error(
      `[zip-security] ZIP has ${rawEntryCount} raw central-directory entries but only ${dedupedCount} unique names. ` +
        'LOCK-6025: Duplicate central-directory entries detected — possible corruption or zip bomb.'
    )
  }

  // LOCK-6025: Enforce entry count limit using the raw CEN count
  if (rawEntryCount > MAX_ZIP_ENTRY_COUNT) {
    throw new Error(
      `[zip-security] ZIP contains ${rawEntryCount} entries, exceeding limit of ${MAX_ZIP_ENTRY_COUNT}. ` +
        'LOCK-6025: Excessive entry count may indicate a zip bomb.'
    )
  }

  const resolvedDest = path.resolve(destDir) + path.sep
  let totalUncompressedSize = 0

  for (const entry of entryList) {
    const name = entry.name

    // 1. Reject absolute paths
    if (path.isAbsolute(name)) {
      throw new Error(
        `[zip-security] ZIP entry has an absolute path: "${name}". ` +
          'LOCK-6012: Every entry name is untrusted and must be relative.'
      )
    }

    // 2. Reject ".." traversal components
    //    Split on both / and \ to catch all platforms
    const segments = name.split(/[/\\]/)
    if (segments.includes('..')) {
      throw new Error(
        `[zip-security] ZIP entry contains ".." traversal component: "${name}". ` +
          'LOCK-6012: Path traversal is not permitted.'
      )
    }

    // 3. Reject NUL bytes (can cause truncation in C-based path handling)
    if (name.includes('\x00')) {
      throw new Error(
        `[zip-security] ZIP entry contains NUL byte: "${name}". ` + 'NUL bytes can cause path truncation attacks.'
      )
    }

    // 4. Reject backslash separators (ambiguous on Windows, indicator of cross-platform attack)
    if (name.includes('\\')) {
      throw new Error(
        `[zip-security] ZIP entry contains backslash separator: "${name}". ` +
          'Ambiguous path separators are not permitted.'
      )
    }

    // 5. Reject symlink or special entries (device, pipe, socket)
    //    node-stream-zip exposes external file attributes via entry.attr (uint32,
    //    from the CENATX field). The Unix file mode is in the upper 16 bits:
    //    unixMode = (attr >> 16) & 0o177777. We check the file-type bits
    //    regardless of host system for defense-in-depth.
    const entryAny = entry as { attr?: number; size?: number }
    if (entryAny.attr !== undefined) {
      const unixMode = (entryAny.attr >> 16) & 0o177777
      const fileTypeBits = unixMode & 0o170000
      // 0o120000 = symlink, 0o060000 = block device, 0o020000 = char device,
      // 0o010000 = named pipe (FIFO), 0o140000 = socket
      const SYM = 0o120000
      const BLK = 0o060000
      const CHR = 0o020000
      const FIFO = 0o010000
      const SOCK = 0o140000
      if (
        fileTypeBits === SYM ||
        fileTypeBits === BLK ||
        fileTypeBits === CHR ||
        fileTypeBits === FIFO ||
        fileTypeBits === SOCK
      ) {
        throw new Error(
          `[zip-security] ZIP entry is a symlink or special file (mode 0o${unixMode.toString(8)}): "${name}". ` +
            'Only regular files and directories are permitted.'
        )
      }
    }

    // 6. Reject encrypted entries (node-stream-zip provides typed `encrypted` flag)
    if (entry.encrypted) {
      throw new Error(
        `[zip-security] ZIP entry is encrypted: "${name}". ` +
          'Encrypted entries are not supported in restore archives.'
      )
    }

    // 7. Canonical containment check (LOCK-6012)
    //    After normalizing, the resolved path MUST start with the destDir prefix.
    //    This catches subtle attacks like entry name "Data\..\..\..\etc\passwd"
    //    which normalizes to an absolute path outside destDir.
    if (!entry.isDirectory) {
      const resolved = path.resolve(destDir, name)
      if (!resolved.startsWith(resolvedDest)) {
        throw new Error(
          `[zip-security] ZIP entry resolves outside destination: "${name}" → "${resolved}". ` +
            `LOCK-6012: Must resolve within "${destDir}".`
        )
      }
    }

    // LOCK-6025: Track uncompressed size for per-entry and total limits.
    // node-stream-zip provides `size` (uncompressed) on each entry.
    const uncompressedSize = entryAny.size ?? 0
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_SIZE) {
      throw new Error(
        `[zip-security] ZIP entry "${name}" has uncompressed size ${uncompressedSize} bytes, ` +
          `exceeding per-entry limit of ${MAX_ZIP_ENTRY_UNCOMPRESSED_SIZE} bytes. ` +
          'LOCK-6025: Entry too large — possible zip bomb.'
      )
    }

    // LOCK-6025: Safe integer overflow check before aggregation.
    // Number.MAX_SAFE_INTEGER is 2^53 - 1, well above 10 GiB, but we check
    // for defense-in-depth against malformed size fields.
    if (!Number.isFinite(uncompressedSize) || !Number.isInteger(uncompressedSize)) {
      throw new Error(
        `[zip-security] ZIP entry "${name}" has non-finite or non-integer uncompressed size: ${uncompressedSize}. ` +
          'LOCK-6025: Invalid size field — possible corrupted ZIP.'
      )
    }

    const newTotal = totalUncompressedSize + uncompressedSize
    if (!Number.isFinite(newTotal) || newTotal > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `[zip-security] ZIP total uncompressed size would overflow safe integer range after adding entry "${name}" ` +
          `(${totalUncompressedSize} + ${uncompressedSize}). ` +
          'LOCK-6025: Aggregate size overflow — possible corrupted ZIP.'
      )
    }
    totalUncompressedSize = newTotal
  }

  // LOCK-6025: Enforce total uncompressed size limit after iterating
  if (totalUncompressedSize > MAX_ZIP_TOTAL_UNCOMPRESSED_SIZE) {
    throw new Error(
      `[zip-security] ZIP total uncompressed size is ${totalUncompressedSize} bytes, ` +
        `exceeding limit of ${MAX_ZIP_TOTAL_UNCOMPRESSED_SIZE} bytes. ` +
        'LOCK-6025: Total size too large — possible zip bomb.'
    )
  }

  return { entryCount: rawEntryCount }
}

/**
 * Sanitize a provider-controlled filename for safe use as a local temp basename.
 *
 * LOCK-6012: Provider-controlled filenames (from WebDAV/S3 config) must never
 * be used directly in path.join() for local file writes. This function:
 *   - Extracts only the basename (strips directory components)
 *   - Rejects absolute paths
 *   - Strips or replaces dangerous characters
 *   - Returns a safe, unique basename suitable for path.join(ownedRoot, ...)
 *
 * @param rawFilename  Provider-controlled filename (may contain traversal).
 * @param ownedRoot    The operation-owned directory (for error context only).
 * @returns            Safe basename suitable for use with ownedRoot.
 * @throws             Error if the filename is completely unusable.
 */
export function sanitizeProviderFilename(rawFilename: string, ownedRoot: string): string {
  // Extract basename (strips any directory components)
  let basename = path.basename(rawFilename)

  // Remove NUL bytes
  // oxlint-disable-next-line no-control-regex -- Intentional: sanitizing NUL bytes from filenames
  basename = basename.replace(/\x00/g, '')

  // Replace path separators that survived basename extraction
  basename = basename.replace(/[/\\]/g, '_')

  // Collapse any remaining ".." sequences — on POSIX, path.basename() does not
  // treat backslash as a separator, so a Windows traversal like
  // "..\\..\\windows\\system32\\config\\sam" becomes ".._.._windows_..." after
  // the separator replacement above.  Replace ".." with "__" so no traversal
  // component survives as a substring in the final basename.
  basename = basename.replace(/\.\./g, '__')

  // Remove characters that are problematic across platforms
  // oxlint-disable-next-line no-control-regex -- Intentional: sanitizing control chars (U+0000-U+001F) from filenames
  basename = basename.replace(/[<>:"|?*\x00-\x1f]/g, '_')

  // Trim leading/trailing dots and spaces (Windows reserved)
  basename = basename.replace(/^[.\s]+|[.\s]+$/g, '')

  // Fallback if everything was stripped
  if (!basename || basename.length === 0) {
    basename = `restore-${Date.now()}`
  }

  // Enforce reasonable length
  if (basename.length > 200) {
    basename = basename.slice(0, 200)
  }

  // Final containment check: must be a single path segment
  if (basename.includes('/') || basename.includes('\\') || basename === '..' || basename === '.') {
    throw new Error(
      `[zip-security] Provider filename cannot be safely sanitized: "${rawFilename}". ` +
        `Owned root: "${ownedRoot}". Use a generated filename instead.`
    )
  }

  return basename
}
