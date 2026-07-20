/**
 * Structured error mapping for ChatDb IPC.
 *
 * Maps domain errors (validation, identity, FK, conflict, storage)
 * to stable shared error codes with retryable semantics.
 *
 * Error classification strategy (ordered by specificity):
 * 1. Typed aggregate errors (ChatDbValidationError, etc.) — highest priority.
 * 2. SQLite structured code inspection (error.code property):
 *    - SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT_PRIMARYKEY → CONFLICT
 *    - SQLITE_CONSTRAINT_FOREIGNKEY → FOREIGN_KEY
 *    - SQLITE_BUSY / SQLITE_LOCKED → BUSY (retryable)
 *    - SQLITE_CONSTRAINT_* (remaining) → FOREIGN_KEY
 * 3. Message-substring fallback for non-SQLite errors (legacy/assertion).
 * 4. Unknown → STORAGE_ERROR (non-retryable).
 *
 * Security: never leak SQL, file paths, stack traces, or full payloads
 * over the wire or into structured log messages. Only context IDs,
 * error codes, and sanitized messages are logged.
 */

import { loggerService } from '@logger'
import {
  type ChatDbFailure,
  type ChatDbResult,
  ERR_BUSY,
  ERR_CONFLICT,
  ERR_FOREIGN_KEY,
  ERR_IDENTITY_VIOLATION,
  ERR_NOT_FOUND,
  ERR_STORAGE,
  ERR_UNAVAILABLE,
  ERR_VALIDATION,
  fail,
  ok
} from '@shared/chatDb'

const logger = loggerService.withContext('ChatDbErrors')

// ---------------------------------------------------------------------------
// Typed aggregate errors — Main-local, thrown by controlled code
// ---------------------------------------------------------------------------

/**
 * Request payload failed aggregate-level validation.
 * Maps to ERR_VALIDATION (non-retryable).
 */
export class ChatDbValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatDbValidationError'
  }
}

/**
 * Target entity not found.
 * Maps to ERR_NOT_FOUND (non-retryable).
 */
export class ChatDbNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatDbNotFoundError'
  }
}

/**
 * Identity/reparenting violation.
 * Maps to ERR_IDENTITY_VIOLATION (non-retryable).
 */
export class ChatDbIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatDbIdentityError'
  }
}

/**
 * Duplicate ID / conflict.
 * Maps to ERR_CONFLICT (non-retryable).
 */
export class ChatDbConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatDbConflictError'
  }
}

/**
 * Database unavailable (not initialised / repair).
 * Maps to ERR_UNAVAILABLE (non-retryable).
 */
export class ChatDbUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatDbUnavailableError'
  }
}

/**
 * Foreign-key constraint violation.
 * Maps to ERR_FOREIGN_KEY (non-retryable).
 */
export class ChatDbForeignKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatDbForeignKeyError'
  }
}

// ---------------------------------------------------------------------------
// SQLite structured code inspection
// ---------------------------------------------------------------------------

/** SQLite result codes (partial — those relevant to ChatDb). */
const SQLITE_CONSTRAINT_UNIQUE = 'SQLITE_CONSTRAINT_UNIQUE'
const SQLITE_CONSTRAINT_PRIMARYKEY = 'SQLITE_CONSTRAINT_PRIMARYKEY'
const SQLITE_CONSTRAINT_FOREIGNKEY = 'SQLITE_CONSTRAINT_FOREIGNKEY'
const SQLITE_BUSY = 'SQLITE_BUSY'
const SQLITE_LOCKED = 'SQLITE_LOCKED'
const SQLITE_CONSTRAINT_PREFIX = 'SQLITE_CONSTRAINT'

interface SqliteError {
  code?: string
  message?: string
}

/**
 * Inspect a better-sqlite3 error's structured `code` property.
 * Returns a mapped error code + retryable flag, or null if not a SQLite error.
 *
 * Checks realistic prefixes/variants:
 * - SQLITE_CONSTRAINT_UNIQUE, SQLITE_CONSTRAINT_PRIMARYKEY → CONFLICT
 * - SQLITE_CONSTRAINT_FOREIGNKEY → FOREIGN_KEY
 * - SQLITE_BUSY, SQLITE_LOCKED → BUSY (retryable)
 * - SQLITE_CONSTRAINT_* (other) → FOREIGN_KEY
 */
function classifySqliteCode(error: SqliteError): { code: string; retryable: boolean } | null {
  const code = error.code
  if (!code || typeof code !== 'string') return null

  if (code === SQLITE_CONSTRAINT_UNIQUE || code === SQLITE_CONSTRAINT_PRIMARYKEY) {
    return { code: ERR_CONFLICT, retryable: false }
  }
  if (code === SQLITE_CONSTRAINT_FOREIGNKEY) {
    return { code: ERR_FOREIGN_KEY, retryable: false }
  }
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) {
    return { code: ERR_BUSY, retryable: true }
  }
  if (code.startsWith(SQLITE_CONSTRAINT_PREFIX)) {
    return { code: ERR_FOREIGN_KEY, retryable: false }
  }

  return null
}

// ---------------------------------------------------------------------------
// Message-substring classification (legacy fallback)
// ---------------------------------------------------------------------------

/**
 * Check if an error is a "not found" style error from repository assertions.
 */
function isNotFoundError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return msg.includes('does not exist') || msg.includes('not found') || msg.includes('does not belong')
}

/**
 * Check if an error is an identity/reparenting violation.
 */
function isIdentityViolation(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return msg.includes('cannot change identity field') || msg.includes('cannot reparent')
}

/**
 * Check if an error is a duplicate ID conflict (bulk insert).
 *
 * Note: "abort due to constraint" is NOT included here because SQLite
 * uses that prefix for FK violations too. An unstructured FK message
 * like "abort due to constraint: FOREIGN KEY ..." must not be
 * classified as a conflict. Structured SQLITE_CONSTRAINT_* codes
 * (Priority 2) catch the real constraint type; this substring
 * fallback only handles the unique/duplicate keyword patterns.
 */
function isConflictError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return msg.includes('unique') || msg.includes('duplicate')
}

/**
 * Check if an error is a foreign key violation.
 */
function isForeignKeyError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return msg.includes('foreign key') || msg.includes('constraint failed')
}

/**
 * Check if an error is a sort_order violation.
 */
function isSortOrderViolation(error: Error): boolean {
  return error.message.toLowerCase().includes('cannot change sortorder')
}

/**
 * Sanitize an error message for logging/wire transport.
 * Strips potential SQL statements, file paths, and stack traces.
 */
function sanitizeMessage(msg: string): string {
  // Truncate excessively long messages
  if (msg.length > 500) {
    msg = msg.slice(0, 500) + '…'
  }
  // Strip common SQL/path patterns
  msg = msg.replace(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/gi, '[SQL]')
  msg = msg.replace(/(?:\/[\w.-]+){3,}/g, '[path]')
  msg = msg.replace(/at\s+\S+\s+\(.*:\d+:\d+\)/g, '[stack]')
  return msg
}

// ---------------------------------------------------------------------------
// Main error mapper
// ---------------------------------------------------------------------------

/**
 * Map a thrown error to a ChatDbResult failure with stable error codes.
 * Never throws — always returns a result.
 *
 * Classification priority:
 * 1. Typed aggregate errors (ChatDbValidationError, etc.)
 * 2. SQLite structured code inspection (error.code)
 * 3. Message-substring fallback
 * 4. Unknown → STORAGE_ERROR (non-retryable)
 *
 * @param error    The caught error.
 * @param context  Context string for logging (e.g. command name, IDs).
 * @returns        ChatDbResult failure with structured error.
 */
export function mapErrorToResult(error: unknown, context: string): ChatDbFailure {
  if (error instanceof Error) {
    // --- Priority 1: Typed aggregate errors ---
    if (error instanceof ChatDbValidationError) {
      logger.warn(`[${context}] Validation error: ${sanitizeMessage(error.message)}`)
      return fail(ERR_VALIDATION, error.message, false)
    }

    if (error instanceof ChatDbNotFoundError) {
      logger.warn(`[${context}] Not found: ${sanitizeMessage(error.message)}`)
      return fail(ERR_NOT_FOUND, error.message, false)
    }

    if (error instanceof ChatDbIdentityError) {
      logger.warn(`[${context}] Identity violation: ${sanitizeMessage(error.message)}`)
      return fail(ERR_IDENTITY_VIOLATION, error.message, false)
    }

    if (error instanceof ChatDbConflictError) {
      logger.warn(`[${context}] Conflict: ${sanitizeMessage(error.message)}`)
      return fail(ERR_CONFLICT, error.message, false)
    }

    if (error instanceof ChatDbUnavailableError) {
      logger.warn(`[${context}] DB unavailable: ${sanitizeMessage(error.message)}`)
      return fail(ERR_UNAVAILABLE, 'Database is not available', false)
    }

    if (error instanceof ChatDbForeignKeyError) {
      logger.warn(`[${context}] FK violation: ${sanitizeMessage(error.message)}`)
      return fail(ERR_FOREIGN_KEY, error.message, false)
    }

    // --- Priority 2: SQLite structured code inspection ---
    const sqliteResult = classifySqliteCode(error as SqliteError)
    if (sqliteResult) {
      const safeMsg = sanitizeMessage(error.message)
      if (sqliteResult.retryable) {
        logger.warn(`[${context}] SQLite ${sqliteResult.code}: ${safeMsg}`)
      } else {
        logger.warn(`[${context}] SQLite constraint ${sqliteResult.code}: ${safeMsg}`)
      }
      return fail(
        sqliteResult.code,
        sqliteResult.code === ERR_BUSY ? 'Database is busy, please retry' : sanitizeMessage(error.message),
        sqliteResult.retryable
      )
    }

    // --- Priority 2.5: Shared ValidationError (from validation.ts) ---
    if (error.name === 'ValidationError') {
      logger.warn(`[${context}] Validation error: ${sanitizeMessage(error.message)}`)
      return fail(ERR_VALIDATION, error.message, false)
    }

    // --- Priority 2.5: DB unavailable (message-substring) ---
    if (error.message.includes('not been initialised') || error.message.includes('repair-required')) {
      logger.warn(`[${context}] DB unavailable: ${sanitizeMessage(error.message)}`)
      return fail(ERR_UNAVAILABLE, 'Database is not available', false)
    }

    // --- Priority 3: Message-substring fallback ---
    // Identity/reparenting violations
    if (isIdentityViolation(error)) {
      logger.warn(`[${context}] Identity violation: ${sanitizeMessage(error.message)}`)
      return fail(ERR_IDENTITY_VIOLATION, error.message, false)
    }

    // Sort order violations (use identity violation code)
    if (isSortOrderViolation(error)) {
      logger.warn(`[${context}] Sort order violation: ${sanitizeMessage(error.message)}`)
      return fail(ERR_IDENTITY_VIOLATION, error.message, false)
    }

    // Not found (topic, message, block)
    if (isNotFoundError(error)) {
      logger.warn(`[${context}] Not found: ${sanitizeMessage(error.message)}`)
      return fail(ERR_NOT_FOUND, error.message, false)
    }

    // Duplicate ID / conflict (must precede FK — "UNIQUE constraint failed"
    // contains "constraint failed" which overlaps with FK detection)
    if (isConflictError(error)) {
      logger.warn(`[${context}] Conflict: ${sanitizeMessage(error.message)}`)
      return fail(ERR_CONFLICT, error.message, false)
    }

    // Foreign key violations
    if (isForeignKeyError(error)) {
      logger.warn(`[${context}] FK violation: ${sanitizeMessage(error.message)}`)
      return fail(ERR_FOREIGN_KEY, error.message, false)
    }

    // SQLite busy/locked (message fallback for providers that don't set code)
    if (
      error.message.includes(SQLITE_BUSY) ||
      error.message.includes(SQLITE_LOCKED) ||
      error.message.includes('busy')
    ) {
      logger.warn(`[${context}] DB busy: ${sanitizeMessage(error.message)}`)
      return fail(ERR_BUSY, 'Database is busy, please retry', true)
    }

    // --- Priority 4: Generic storage error (non-retryable) ---
    logger.error(`[${context}] Storage error: ${sanitizeMessage(error.message)}`)
    return fail(ERR_STORAGE, 'An unexpected storage error occurred', false)
  }

  // Non-Error thrown values — always non-retryable storage error
  logger.error(`[${context}] Unknown error type: ${typeof error}`)
  return fail(ERR_STORAGE, 'An unexpected error occurred', false)
}

/**
 * Wrap an operation in a try/catch and return ChatDbResult.
 * Convenience for IPC handlers.
 *
 * @param operation  The async or sync operation to execute.
 * @param context    Context string for error logging.
 * @returns          ChatDbResult with the operation's value or mapped error.
 */
export function wrapResult<T>(operation: () => T, context: string): ChatDbResult<T> {
  try {
    const value = operation()
    return ok(value)
  } catch (error) {
    return mapErrorToResult(error, context)
  }
}

/**
 * Create a valid ERR_STORAGE failure envelope for internal programming errors.
 * Used when aggregate constructs an invalid result that must not cross IPC.
 */
export function internalStorageFailure(context: string, reason: string): ChatDbFailure {
  logger.error(`[${context}] Internal programming error: ${sanitizeMessage(reason)}`)
  return fail(ERR_STORAGE, 'An internal error occurred', false)
}

// ---------------------------------------------------------------------------
// Result validation
// ---------------------------------------------------------------------------

/**
 * Validate a constructed ChatDbResult before returning across IPC.
 * Ensures the envelope is well-formed. Logs warnings for malformed results.
 *
 * @param result   The result to validate.
 * @param channel  The command channel for logging context.
 * @returns        true if valid, false if malformed.
 */
export function validateConstructedResult(result: ChatDbResult<unknown>, channel: string): boolean {
  if (result === null || result === undefined || typeof result !== 'object') {
    logger.warn(`[${channel}] Result is not an object`)
    return false
  }
  if (result.ok === true) {
    // Success: value is present (may be null for void commands)
    if (!('value' in result)) {
      logger.warn(`[${channel}] Success result missing "value" field`)
      return false
    }
    return true
  } else if (result.ok === false) {
    // Failure: error fields present and well-formed
    if (!result.error || typeof result.error.code !== 'string' || result.error.code.length === 0) {
      logger.warn(`[${channel}] Failure result has malformed error`)
      return false
    }
    if (typeof result.error.message !== 'string' || result.error.message.length === 0) {
      logger.warn(`[${channel}] Failure result error.message is malformed`)
      return false
    }
    if (typeof result.error.retryable !== 'boolean') {
      logger.warn(`[${channel}] Failure result error.retryable is not boolean`)
      return false
    }
    return true
  } else {
    logger.warn(`[${channel}] Result "ok" is not boolean`)
    return false
  }
}
