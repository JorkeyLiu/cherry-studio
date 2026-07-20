/**
 * Runtime JSON wire validation for ChatDb IPC payloads.
 *
 * Validates that values are JSON-safe before crossing the IPC boundary.
 *
 * Rules:
 * - Allowed: null, boolean, string, finite number, arrays, plain objects.
 * - Rejected: undefined, bigint, symbol, function, NaN/Infinity, Date,
 *   Map, Set, Buffer, TypedArrays, class instances, sparse arrays,
 *   cyclic values.
 * - Bounded nesting: max depth 20 levels.
 * - Top-level request objects reject unknown properties.
 * - Extension metadata (overflow/extra) must be explicit JsonObject.
 *
 * No dependencies on Electron, Node, Drizzle, or SQLite.
 */

import type { JsonObject } from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed nesting depth for JSON values. */
export const MAX_DEPTH = 20

/** Maximum allowed string length (1 MiB). Prevents accidental payload bloat. */
export const MAX_STRING_LENGTH = 1_048_576

/** Maximum allowed array length. */
export const MAX_ARRAY_LENGTH = 100_000

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

/**
 * Thrown when a value fails JSON wire validation.
 */
export class ValidationError extends Error {
  constructor(
    public readonly path: string,
    message: string
  ) {
    super(`Validation error at '${path}': ${message}`)
    this.name = 'ValidationError'
  }
}

// ---------------------------------------------------------------------------
// Core validators
// ---------------------------------------------------------------------------

/**
 * Validate that a value is JSON-safe (JsonValue).
 *
 * @param value   The value to validate.
 * @param path    Dot-separated path for error messages.
 * @param depth   Current nesting depth.
 * @throws {ValidationError} If the value is not JSON-safe.
 */
export function validateJsonValue(value: unknown, path = 'root', depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new ValidationError(path, `Nesting depth exceeds maximum (${MAX_DEPTH})`)
  }

  if (value === undefined) {
    throw new ValidationError(path, 'undefined is not a valid JSON value')
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      throw new ValidationError(path, `String length ${value.length} exceeds maximum (${MAX_STRING_LENGTH})`)
    }
    return
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(path, `Non-finite number: ${value}`)
    }
    return
  }

  if (typeof value === 'bigint') {
    throw new ValidationError(path, 'bigint is not a valid JSON value')
  }

  if (typeof value === 'symbol') {
    throw new ValidationError(path, 'symbol is not a valid JSON value')
  }

  if (typeof value === 'function') {
    throw new ValidationError(path, 'function is not a valid JSON value')
  }

  if (value instanceof Date) {
    throw new ValidationError(path, 'Date is not a valid JSON value (use ISO string)')
  }

  if (value instanceof Map || value instanceof WeakMap) {
    throw new ValidationError(path, 'Map is not a valid JSON value')
  }

  if (value instanceof Set || value instanceof WeakSet) {
    throw new ValidationError(path, 'Set is not a valid JSON value')
  }

  if (value instanceof RegExp) {
    throw new ValidationError(path, 'RegExp is not a valid JSON value')
  }

  if (value instanceof Error) {
    throw new ValidationError(path, 'Error is not a valid JSON value')
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new ValidationError(path, 'TypedArray/Buffer is not a valid JSON value')
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      throw new ValidationError(path, `Array length ${value.length} exceeds maximum (${MAX_ARRAY_LENGTH})`)
    }
    for (let i = 0; i < value.length; i++) {
      // Detect sparse arrays: if the index does not exist as own property,
      // it is a hole. JSON.stringify converts holes to null, so we reject.
      if (!(i in value)) {
        throw new ValidationError(`${path}[${i}]`, 'Sparse arrays are not allowed')
      }
      validateJsonValue(value[i], `${path}[${i}]`, depth + 1)
    }
    return
  }

  if (typeof value === 'object') {
    // Plain object check: constructor is Object or null prototype
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(path, `Non-plain object (constructor: ${proto?.constructor?.name ?? 'unknown'})`)
    }
    const keys = Object.keys(value as Record<string, unknown>)
    for (const key of keys) {
      validateJsonValue((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)
    }
    return
  }

  throw new ValidationError(path, `Unexpected type: ${typeof value}`)
}

/**
 * Validate a top-level request object.
 *
 * Enforces:
 * - Must be a plain object (not array, not null).
 * - All values must be JSON-safe.
 * - Rejects unknown properties if `allowedKeys` is provided.
 *
 * @param value        The request payload to validate.
 * @param allowedKeys  If provided, reject keys not in this set.
 * @throws {ValidationError} If validation fails.
 */
export function validateRequest(value: unknown, allowedKeys?: ReadonlySet<string>): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('request', 'Request must be a plain object')
  }

  validateJsonValue(value, 'request')

  if (allowedKeys) {
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) {
        throw new ValidationError(`request.${key}`, `Unknown property '${key}'`)
      }
    }
  }
}

/**
 * Validate that a value is a JsonObject (plain object with JSON-safe values).
 *
 * @param value  The value to validate.
 * @param path   Dot-separated path for error messages.
 * @throws {ValidationError} If the value is not a JsonObject.
 */
export function validateJsonObject(value: unknown, path = 'root'): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(path, 'Expected a plain object')
  }
  validateJsonValue(value, path)
}

/**
 * Validate that a value is a non-empty string.
 *
 * @param value  The value to validate.
 * @param path   Dot-separated path for error messages.
 * @throws {ValidationError} If the value is not a non-empty string.
 */
export function validateNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== 'string') {
    throw new ValidationError(path, `Expected a string, got ${typeof value}`)
  }
  if (value.length === 0) {
    throw new ValidationError(path, 'String must not be empty')
  }
}

/**
 * Validate that a value is an array of non-empty strings.
 *
 * @param value  The value to validate.
 * @param path   Dot-separated path for error messages.
 * @throws {ValidationError} If the value is not an array of non-empty strings.
 */
export function validateStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new ValidationError(path, `Expected an array, got ${typeof value}`)
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || (value[i] as string).length === 0) {
      throw new ValidationError(`${path}[${i}]`, 'Expected a non-empty string')
    }
  }
}

/**
 * Validate that a value is a plain object array (JsonObject[]).
 *
 * @param value  The value to validate.
 * @param path   Dot-separated path for error messages.
 * @throws {ValidationError} If the value is not a JsonObject array.
 */
export function validateJsonObjectArray(value: unknown, path: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(path, `Expected an array, got ${typeof value}`)
  }
  for (let i = 0; i < value.length; i++) {
    validateJsonObject(value[i], `${path}[${i}]`)
  }
  return value as JsonObject[]
}

/**
 * Validate that a value is a finite non-negative integer (for insertIndex).
 *
 * @param value  The value to validate.
 * @param path   Dot-separated path for error messages.
 * @throws {ValidationError} If the value is not a valid index.
 */
export function validateIndex(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(path, `Expected a non-negative integer, got ${JSON.stringify(value)}`)
  }
}

/**
 * Validate that a JsonObject contains a string `id` field.
 *
 * @param obj   The object to check.
 * @param path  Dot-separated path for error messages.
 * @throws {ValidationError} If `id` is missing or not a non-empty string.
 */
export function validateIdField(obj: JsonObject, path: string): void {
  const id = obj.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new ValidationError(`${path}.id`, 'Required field "id" must be a non-empty string')
  }
}

/**
 * Validate that a JsonObject contains a string `messageId` field.
 * Used for full block objects that must reference their parent message.
 *
 * @param obj   The object to check.
 * @param path  Dot-separated path for error messages.
 * @throws {ValidationError} If `messageId` is missing or not a non-empty string.
 */
export function validateMessageIdField(obj: JsonObject, path: string): void {
  const messageId = obj.messageId
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new ValidationError(`${path}.messageId`, 'Required field "messageId" must be a non-empty string')
  }
}

// ---------------------------------------------------------------------------
// Result envelope validation
// ---------------------------------------------------------------------------

/** Allowed keys in a ChatDb success envelope. */
const SUCCESS_ENVELOPE_KEYS: ReadonlySet<string> = new Set(['ok', 'value'])

/** Allowed keys in a ChatDb failure envelope. */
const FAILURE_ENVELOPE_KEYS: ReadonlySet<string> = new Set(['ok', 'error'])

/** Allowed keys in a ChatDbError object. */
const ERROR_KEYS: ReadonlySet<string> = new Set(['code', 'message', 'retryable', 'details'])

/**
 * Validate a ChatDb result envelope structure.
 *
 * Enforces:
 * - Must be a plain object.
 * - `ok` field must be boolean.
 * - Success (`ok: true`): must have `value` (any JSON-safe value including null),
 *   no `error` field, no unknown keys.
 * - Failure (`ok: false`): must have `error` with non-empty `code` (string),
 *   non-empty `message` (string), boolean `retryable`, optional JSON `details`,
 *   no `value` field, no unknown keys.
 *
 * @param value    The raw result to validate.
 * @param channel  The command channel (for error messages).
 * @throws {ValidationError} If the envelope is malformed.
 */
export function validateResultEnvelope(value: unknown, channel: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('result', `[${channel}] Result must be a plain object`)
  }

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)

  if (!('ok' in obj)) {
    throw new ValidationError('result.ok', `[${channel}] Result must have "ok" field`)
  }

  if (typeof obj.ok !== 'boolean') {
    throw new ValidationError('result.ok', `[${channel}] "ok" must be a boolean, got ${typeof obj.ok}`)
  }

  if (obj.ok === true) {
    // Success envelope: ok + value, no unknown keys
    for (const key of keys) {
      if (!SUCCESS_ENVELOPE_KEYS.has(key)) {
        throw new ValidationError(`result.${key}`, `[${channel}] Unknown key in success result: "${key}"`)
      }
    }
    if (!('value' in obj)) {
      throw new ValidationError('result.value', `[${channel}] Success result must have "value" field`)
    }
    // Value must be JSON-safe (including null)
    validateJsonValue(obj.value, 'result.value')
  } else {
    // Failure envelope: ok + error, no unknown keys
    for (const key of keys) {
      if (!FAILURE_ENVELOPE_KEYS.has(key)) {
        throw new ValidationError(`result.${key}`, `[${channel}] Unknown key in failure result: "${key}"`)
      }
    }
    if (!('error' in obj)) {
      throw new ValidationError('result.error', `[${channel}] Failure result must have "error" field`)
    }
    validateChatDbError(obj.error, channel)
  }
}

/**
 * Validate a ChatDbError structure.
 *
 * @param error    The error object to validate.
 * @param channel  The command channel (for error messages).
 * @throws {ValidationError} If the error is malformed.
 */
function validateChatDbError(error: unknown, channel: string): void {
  if (error === null || typeof error !== 'object' || Array.isArray(error)) {
    throw new ValidationError('result.error', `[${channel}] Error must be a plain object`)
  }

  const err = error as Record<string, unknown>

  for (const key of Object.keys(err)) {
    if (!ERROR_KEYS.has(key)) {
      throw new ValidationError(`result.error.${key}`, `[${channel}] Unknown key in error: "${key}"`)
    }
  }

  if (typeof err.code !== 'string' || err.code.length === 0) {
    throw new ValidationError('result.error.code', `[${channel}] Error "code" must be a non-empty string`)
  }

  if (typeof err.message !== 'string' || err.message.length === 0) {
    throw new ValidationError('result.error.message', `[${channel}] Error "message" must be a non-empty string`)
  }

  if (typeof err.retryable !== 'boolean') {
    throw new ValidationError(
      'result.error.retryable',
      `[${channel}] Error "retryable" must be a boolean, got ${typeof err.retryable}`
    )
  }

  if ('details' in err && err.details !== undefined) {
    validateJsonObject(err.details, 'result.error.details')
  }
}
