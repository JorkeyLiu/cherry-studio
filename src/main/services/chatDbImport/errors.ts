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
