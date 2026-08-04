/**
 * Typed error classes for the ChatImport pipeline.
 *
 * Design:
 * - Each error class maps to a specific failure mode.
 * - Messages are sanitised — no file paths leak to UI.
 * - ChatImportZipError carries a machine-readable `code` for programmatic handling.
 * - ChatImportCancelledError is used for user-initiated cancellation (not a failure).
 */

// ---------------------------------------------------------------------------
// Platform gate
// ---------------------------------------------------------------------------

/**
 * Thrown when startImport() is called on an unsupported platform.
 * Phase 4.1 only supports macOS (A-9).
 */
export class ChatImportUnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(
      `Chat import is not supported on "${platform}". ` +
        'Currently only macOS is supported. Windows/Linux support will be added in a future phase.'
    )
    this.name = 'ChatImportUnsupportedPlatformError'
  }
}

// ---------------------------------------------------------------------------
// ZIP errors
// ---------------------------------------------------------------------------

export type ChatImportZipErrorCode =
  | 'ENCRYPTED'
  | 'TOO_LARGE'
  | 'TOO_MANY_ENTRIES'
  | 'SINGLE_ENTRY_TOO_LARGE'
  | 'TOTAL_UNCOMPRESSED_TOO_LARGE'
  | 'PATH_TRAVERSAL'
  | 'NO_INDEXED_DB'
  | 'EXTRACT_FAILED'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'DUPLICATE_ENTRIES'
  | 'INVALID_ENTRY_SIZE'
  | 'UNSUPPORTED_ORIGIN'
  | 'AMBIGUOUS_ORIGIN'
  | 'PACKAGED_DEV_ORIGIN'
  // LOCK-PROD-9: selective-extraction selected-byte limits. The legacy
  // SINGLE_ENTRY_TOO_LARGE / TOTAL_UNCOMPRESSED_TOO_LARGE codes remain for
  // backward compatibility with existing tests/callers.
  | 'SELECTED_ENTRY_TOO_LARGE'
  | 'SELECTED_TOO_LARGE'
  | 'SELECTED_RATIO_TOO_HIGH'
  // LOCK-Z2: container-level rejection of symlink / special-mode entries
  // detected from the external-file-attribute mode bits.
  | 'UNSUPPORTED_ENTRY_TYPE'
  // LOCK-FZ1: actual extracted-byte enforcement. node-stream-zip skips its
  // EntryVerifyStream for data-descriptor (flag bit 3) entries, so extraction
  // aborts when written bytes exceed the claimed central size (or the
  // single-entry / cumulative caps) and requires the final byte count to
  // equal the validated central uncompressed size exactly.
  | 'SELECTED_EXTRACT_OVERFLOW'
  | 'SELECTED_ENTRY_SIZE_MISMATCH'
  // LOCK-FZ2: distinct entry names that normalize to the same extraction
  // destination (a/b vs a//b vs a/./b) are rejected before extraction.
  | 'DUPLICATE_EXTRACTION_TARGET'

/**
 * Thrown during ZIP intake validation or extraction.
 * `code` identifies the specific validation layer that rejected the ZIP.
 */
export class ChatImportZipError extends Error {
  public readonly code: ChatImportZipErrorCode

  constructor(code: ChatImportZipErrorCode, detail: string) {
    // Sanitise: never include raw paths in the message
    super(`ZIP validation failed (${code}): ${detail}`)
    this.name = 'ChatImportZipError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Session errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a state-machine violation occurs (e.g. trying to read
 * before discovery, or starting a second concurrent import).
 */
export class ChatImportSessionError extends Error {
  constructor(detail: string) {
    super(`Import session error: ${detail}`)
    this.name = 'ChatImportSessionError'
  }
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Thrown (or used as a signal) when the user cancels an import.
 * This is NOT a failure — it's a controlled termination.
 */
export class ChatImportCancelledError extends Error {
  constructor(sessionId: string) {
    super(`Import cancelled for session ${sessionId}`)
    this.name = 'ChatImportCancelledError'
  }
}

// ---------------------------------------------------------------------------
// Navigation projection errors (LOCK-PROD-6)
// ---------------------------------------------------------------------------

export type ChatImportProjectionErrorCode = 'ENCODE_FAILED' | 'DECODE_FAILED' | 'APPLY_REJECTED'

/**
 * Thrown when the L2 navigation projection cannot be encoded/decoded or
 * applied. Messages are sanitised — never raw paths or payload contents.
 */
export class ChatImportProjectionError extends Error {
  public readonly code: ChatImportProjectionErrorCode

  constructor(code: ChatImportProjectionErrorCode, detail: string) {
    super(`Navigation projection error (${code}): ${detail}`)
    this.name = 'ChatImportProjectionError'
    this.code = code
  }
}
