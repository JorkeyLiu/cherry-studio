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
  // LOCK-FIX-3: Unicode/case-fold target conflicts. Distinct entry names
  // that normalize to the same canonical target under macOS's default
  // case-insensitive filesystem (case folding + NFC normalization) would
  // silently overwrite each other during extraction — rejected fail-closed
  // in the central-directory pass, before anything is materialized.
  | 'CASE_FOLD_TARGET_CONFLICT'
  // LOCK-FIX-3: bounded Data/Files payload budget (LOCK-FIX-7). The
  // Data/Files subtree gets its own single-entry and cumulative
  // uncompressed quotas, justified against the 1.39 GiB real-backup
  // inventory class, and is rejected BEFORE extraction (quota/bomb class).
  | 'FILES_ENTRY_TOO_LARGE'
  | 'FILES_QUOTA_EXCEEDED'
  // LOCK-FIX-3: disk preflight failure. The bounded resource model requires
  // the extraction target filesystem to have headroom for the validated
  // uncompressed bytes before anything is materialized.
  | 'DISK_PREFLIGHT_FAILED'
  // LOCK-FIX-3: ambiguous payload per file ID. Two distinct ZIP entries
  // under Data/Files/ resolve to the same canonical `<id><ext>` payload for
  // one catalog file — the source is inconsistent, so the archive is
  // rejected atomically (never guess which payload is authoritative).
  | 'AMBIGUOUS_PAYLOAD'

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
// Attachment plane errors (LOCK-FIX-3 fatal classes, LOCK-FIX-4 degraded)
// ---------------------------------------------------------------------------

export type ChatImportAttachmentErrorCode =
  // Fatal: two Data/Files entries resolve to one catalog file id+ext.
  | 'AMBIGUOUS_PAYLOAD'
  // Fatal: an ACTUAL streamed payload exceeded the hard single-entry /
  // cumulative Files caps (bomb/quota class — the archive is untrustworthy).
  | 'FILES_PAYLOAD_OVERFLOW'
  // Fatal: a candidate artifact verification/seal step failed (extracted
  // payload missing/mismatched after write, or the catalog cannot be
  // durably sealed/read back). The candidate state is unrecoverable.
  | 'CANDIDATE_STATE_UNRECOVERABLE'
  // Fatal: the catalog handoff could not be written/renamed durably.
  | 'CATALOG_WRITE_FAILED'
  // Fatal: the source ZIP could not be reopened/read for payload extraction
  // (missing/moved/unreadable source archive) — the candidate cannot be
  // completed.
  | 'FILES_EXTRACTION_FAILED'
  // Fatal: a hard-budget violation encountered during streaming that must
  // reject the archive atomically (distinct from per-payload degradations).
  | 'FILES_BUDGET_VIOLATION'
  // Fatal-class cancellation signal raised by the attachment plane when the
  // session was cancelled mid-extraction (cleanup is owned by the caller).
  | 'CANCELLED'

/**
 * Thrown by the attachment plane for archive/session FATAL classes
 * (LOCK-FIX-3). Per-payload degradation (LOCK-FIX-4) never throws — it is
 * aggregated count-only. Messages are sanitized: never source paths,
 * filenames, user content, or raw file IDs.
 */
export class ChatImportAttachmentError extends Error {
  public readonly code: ChatImportAttachmentErrorCode

  constructor(code: ChatImportAttachmentErrorCode, detail: string) {
    super(`Attachment import failed (${code}): ${detail}`)
    this.name = 'ChatImportAttachmentError'
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
