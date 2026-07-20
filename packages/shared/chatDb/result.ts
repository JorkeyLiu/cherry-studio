/**
 * Result envelope constructors and type guards for ChatDb IPC.
 *
 * Design:
 * - ok(value) wraps a value in ChatDbSuccess.
 * - fail(code, message, retryable, details?) creates ChatDbFailure.
 * - Type guards: isSuccess(result), isFailure(result).
 * - Convenience error codes as constants for consistency.
 * - No dependencies on Electron, Node, Drizzle, or SQLite.
 */

import type { ChatDbError, ChatDbFailure, ChatDbResult, ChatDbSuccess, JsonObject } from './types'

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

/** Request payload failed runtime validation. */
export const ERR_VALIDATION = 'VALIDATION_ERROR'

/** The target entity (topic, message, block) was not found. */
export const ERR_NOT_FOUND = 'NOT_FOUND'

/** An attempt was made to change an identity field (id, topicId, messageId). */
export const ERR_IDENTITY_VIOLATION = 'IDENTITY_VIOLATION'

/** A foreign-key constraint was violated (e.g. message references non-existent topic). */
export const ERR_FOREIGN_KEY = 'FOREIGN_KEY_VIOLATION'

/** The underlying storage operation failed unexpectedly. */
export const ERR_STORAGE = 'STORAGE_ERROR'

/** The operation was performed on a topic/message in an invalid state. */
export const ERR_INVALID_STATE = 'INVALID_STATE'

/** A conflict was detected (e.g. duplicate ID in a bulk insert batch). */
export const ERR_CONFLICT = 'CONFLICT_ERROR'

/** The database is unavailable (not initialised or in repair-required state). */
export const ERR_UNAVAILABLE = 'UNAVAILABLE'

/** The database is busy (locked, timeout, or concurrent operation conflict). */
export const ERR_BUSY = 'BUSY_ERROR'

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Create a success result.
 * For void commands, pass `null` as value.
 */
export function ok<T>(value: T): ChatDbSuccess<T> {
  return { ok: true, value }
}

/**
 * Create a failure result.
 */
export function fail(code: string, message: string, retryable = false, details?: JsonObject): ChatDbFailure {
  const error: ChatDbError = { code, message, retryable }
  if (details !== undefined) {
    error.details = details
  }
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Type guard: result is a success.
 */
export function isSuccess<T>(result: ChatDbResult<T>): result is ChatDbSuccess<T> {
  return result.ok === true
}

/**
 * Type guard: result is a failure.
 */
export function isFailure<T>(result: ChatDbResult<T>): result is ChatDbFailure {
  return result.ok === false
}
