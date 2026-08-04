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
// Block-specific validation profile (LOCK-LB-1/2)
// ---------------------------------------------------------------------------
//
// Message-block payloads (import `message_blocks` pages and the
// `fetchMessages` blocks result) may legally contain nested strings above
// the generic 1 MiB cap. A NAMED block-specific profile bounds them
// explicitly WITHOUT widening the generic `MAX_STRING_LENGTH` behavior:
// every other ChatDb contract keeps the generic caps. The profile counts
// all string payload bytes AND object-key UTF-8 bytes deterministically
// (TextEncoder — browser/Main compatible, no Node-only Buffer).

/** Block profile: max UTF-8 bytes per string value (8 MiB). */
export const MAX_BLOCK_STRING_UTF8_BYTES = 8 * 1024 * 1024

/** Block profile: max cumulative UTF-8 bytes per block row (16 MiB). */
export const MAX_BLOCK_ROW_UTF8_BYTES = 16 * 1024 * 1024

/** Block profile: max cumulative UTF-8 bytes per page/result aggregate (64 MiB). */
export const MAX_BLOCK_AGGREGATE_UTF8_BYTES = 64 * 1024 * 1024

/**
 * Resource bounds for a named JSON validation profile.
 *
 * Profile validation keeps the shared JSON-safety rules (depth 20,
 * array length 100 000, and the exact rejection set) while replacing the
 * generic 1 MiB code-unit string cap with explicit UTF-8 byte budgets:
 * - {@link maxStringUtf8Bytes}: per-string cap.
 * - {@link maxRowUtf8Bytes}: cumulative cap for ONE top-level row object.
 * - {@link maxAggregateUtf8Bytes}: cumulative cap across a whole page /
 *   result array (charged by {@link JsonProfileBytes}).
 */
export interface JsonValidationProfile {
  readonly maxStringUtf8Bytes: number
  readonly maxRowUtf8Bytes: number
  readonly maxAggregateUtf8Bytes: number
}

/** The named block-specific profile (LOCK-LB-1). */
export const BLOCK_JSON_PROFILE: JsonValidationProfile = Object.freeze({
  maxStringUtf8Bytes: MAX_BLOCK_STRING_UTF8_BYTES,
  maxRowUtf8Bytes: MAX_BLOCK_ROW_UTF8_BYTES,
  maxAggregateUtf8Bytes: MAX_BLOCK_AGGREGATE_UTF8_BYTES
})

/**
 * Deterministic UTF-8 byte counting (LOCK-LB-2).
 *
 * Uses {@link TextEncoder}, available in both browsers and Node ≥ 11 — no
 * Node-only Buffer in shared code. Lone surrogates encode as U+FFFD (3
 * bytes), matching standard UTF-8 encoding of ill-formed strings.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Mutable byte accountant shared across one profile-validated aggregate
 * (one import page or one fetchMessages result).
 *
 * - {@link rowBytes}: reset to 0 at the START of every top-level row object.
 * - {@link aggregateBytes}: never reset within one aggregate — the page /
 *   result budget includes EVERY row, including rows later skipped
 *   (LOCK-LB-4).
 */
export interface JsonProfileBytes {
  rowBytes: number
  aggregateBytes: number
}

/** Create a fresh profile byte accountant. */
export function createProfileBytes(): JsonProfileBytes {
  return { rowBytes: 0, aggregateBytes: 0 }
}

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
 * Effective limits for one JSON walk. The generic path enforces the legacy
 * code-unit string cap; the block-profile path enforces UTF-8 byte caps and
 * charges the caller-owned accountant. Only the limits relevant to the
 * active path are set, so neither path ever reads the other's behavior.
 */
interface JsonWalkLimits {
  maxDepth: number
  maxArrayLength: number
  /** Generic cap: max code units per string (legacy 1 MiB behavior). */
  maxStringCodeUnits?: number
  /** Block profile: max UTF-8 bytes per string value. */
  maxStringUtf8Bytes?: number
  /** Block profile: max cumulative UTF-8 bytes per row object. */
  maxRowUtf8Bytes?: number
  /** Block profile: max cumulative UTF-8 bytes per aggregate. */
  maxAggregateUtf8Bytes?: number
}

/**
 * Charge UTF-8 bytes toward the profile row + aggregate budgets (LOCK-LB-2).
 * A no-op when the walk is not profile-bounded (`accountant` is null).
 */
function chargeProfileBytes(
  bytes: number,
  path: string,
  limits: JsonWalkLimits,
  accountant: JsonProfileBytes | null
): void {
  if (accountant === null) return
  accountant.rowBytes += bytes
  accountant.aggregateBytes += bytes
  if (limits.maxRowUtf8Bytes !== undefined && accountant.rowBytes > limits.maxRowUtf8Bytes) {
    throw new ValidationError(
      path,
      `Row cumulative UTF-8 size ${accountant.rowBytes} exceeds maximum (${limits.maxRowUtf8Bytes})`
    )
  }
  if (limits.maxAggregateUtf8Bytes !== undefined && accountant.aggregateBytes > limits.maxAggregateUtf8Bytes) {
    throw new ValidationError(
      path,
      `Aggregate UTF-8 size ${accountant.aggregateBytes} exceeds maximum (${limits.maxAggregateUtf8Bytes})`
    )
  }
}

/**
 * Shared JSON-safety walker (LOCK-LB-2).
 *
 * Enforces the exact generic rejection set — undefined, bigint, symbol,
 * function, non-finite numbers, sparse arrays, cycles (via depth), non-plain
 * objects, Date/Map/Set/RegExp/Error/TypedArray, ill-formed inputs — with
 * limits supplied per path. The generic path behaves byte-for-byte like the
 * legacy validator (code-unit string cap); the block-profile path applies
 * the UTF-8 byte budgets and charges the accountant.
 */
function validateJsonValueInternal(
  value: unknown,
  path: string,
  depth: number,
  limits: JsonWalkLimits,
  accountant: JsonProfileBytes | null
): void {
  if (depth > limits.maxDepth) {
    throw new ValidationError(path, `Nesting depth exceeds maximum (${limits.maxDepth})`)
  }

  if (value === undefined) {
    throw new ValidationError(path, 'undefined is not a valid JSON value')
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') {
      if (limits.maxStringCodeUnits !== undefined && value.length > limits.maxStringCodeUnits) {
        throw new ValidationError(path, `String length ${value.length} exceeds maximum (${limits.maxStringCodeUnits})`)
      }
      if (limits.maxStringUtf8Bytes !== undefined) {
        const byteCount = utf8ByteLength(value)
        if (byteCount > limits.maxStringUtf8Bytes) {
          throw new ValidationError(
            path,
            `String length ${byteCount} UTF-8 bytes exceeds maximum (${limits.maxStringUtf8Bytes})`
          )
        }
        chargeProfileBytes(byteCount, path, limits, accountant)
      }
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
    if (value.length > limits.maxArrayLength) {
      throw new ValidationError(path, `Array length ${value.length} exceeds maximum (${limits.maxArrayLength})`)
    }
    for (let i = 0; i < value.length; i++) {
      // Detect sparse arrays: if the index does not exist as own property,
      // it is a hole. JSON.stringify converts holes to null, so we reject.
      if (!(i in value)) {
        throw new ValidationError(`${path}[${i}]`, 'Sparse arrays are not allowed')
      }
      validateJsonValueInternal(value[i], `${path}[${i}]`, depth + 1, limits, accountant)
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
      // LOCK-LB-2: object-key UTF-8 bytes count toward the profile budgets.
      if (limits.maxStringUtf8Bytes !== undefined) {
        chargeProfileBytes(utf8ByteLength(key), `${path}.${key}`, limits, accountant)
      }
      validateJsonValueInternal(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        depth + 1,
        limits,
        accountant
      )
    }
    return
  }

  throw new ValidationError(path, `Unexpected type: ${typeof value}`)
}

/**
 * Validate that a value is JSON-safe (JsonValue).
 *
 * Generic path — EXACTLY the legacy 1 MiB code-unit string cap behavior
 * (LOCK-LB-1); the block-specific profile never widens this.
 *
 * @param value   The value to validate.
 * @param path    Dot-separated path for error messages.
 * @param depth   Current nesting depth.
 * @throws {ValidationError} If the value is not JSON-safe.
 */
export function validateJsonValue(value: unknown, path = 'root', depth = 0): void {
  validateJsonValueInternal(
    value,
    path,
    depth,
    { maxDepth: MAX_DEPTH, maxArrayLength: MAX_ARRAY_LENGTH, maxStringCodeUnits: MAX_STRING_LENGTH },
    null
  )
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
 * Validate that a string is a canonical ISO 8601 / RFC 3339 timestamp.
 *
 * Accepted format: `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, Z suffix, millisecond
 * precision). This ensures lexicographic comparison matches chronological
 * ordering for purge cutoff comparisons.
 *
 * @param value  The string value to validate.
 * @param path   Dot-separated path for error messages.
 * @throws {ValidationError} If the value is not a valid ISO 8601 timestamp.
 */
export function validateIso8601Timestamp(value: unknown, path: string): void {
  if (typeof value !== 'string') {
    throw new ValidationError(path, `Expected a string, got ${typeof value}`)
  }
  // Canonical form: YYYY-MM-DDTHH:mm:ss.sssZ
  // Rejects: missing Z, timezone offsets (+HH:mm), missing milliseconds,
  // non-UTC timezones, and non-ISO formats.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    // LOCK-PRIV-TRASH: static message only — the supplied value is never
    // echoed into validation errors, Main logs, or IPC error responses.
    throw new ValidationError(path, 'Expected canonical ISO 8601 timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)')
  }
  // Verify the date is actually valid
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    // LOCK-PRIV-TRASH: static message only — never interpolate the value.
    throw new ValidationError(path, 'Invalid ISO 8601 timestamp (date out of range)')
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
 * LOCK-LB-7: the top-level array length is capped at {@link MAX_ARRAY_LENGTH}
 * BEFORE element iteration, so an oversized page/result never walks (or
 * allocates per-element error paths for) its elements.
 *
 * @param value  The value to validate.
 * @param path   Dot-separated path for error messages.
 * @throws {ValidationError} If the value is not a JsonObject array.
 */
export function validateJsonObjectArray(value: unknown, path: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(path, `Expected an array, got ${typeof value}`)
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    throw new ValidationError(path, `Array length ${value.length} exceeds maximum (${MAX_ARRAY_LENGTH})`)
  }
  for (let i = 0; i < value.length; i++) {
    validateJsonObject(value[i], `${path}[${i}]`)
  }
  return value as JsonObject[]
}

/**
 * Validate one object with a named JSON profile (block-specific, LOCK-LB-1).
 *
 * Applies the profile's per-string and per-row UTF-8 byte budgets plus the
 * shared JSON-safety rules; the caller-owned {@link JsonProfileBytes}
 * accumulates the aggregate budget across rows of one page/result. The row
 * budget is reset at the start of every call (one top-level row object);
 * the aggregate budget persists across calls (LOCK-LB-4).
 *
 * @param value    The object to validate.
 * @param path     Dot-separated path for error messages.
 * @param profile  The named validation profile (e.g. {@link BLOCK_JSON_PROFILE}).
 * @param bytes    Caller-owned byte accountant (fresh per page/result).
 * @throws {ValidationError} If the object fails profile validation.
 */
export function validateJsonObjectBlock(
  value: unknown,
  path: string,
  profile: JsonValidationProfile,
  bytes: JsonProfileBytes
): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(path, 'Expected a plain object')
  }
  // One row per top-level object — the row budget starts fresh while the
  // aggregate budget keeps accumulating across the whole page/result.
  bytes.rowBytes = 0
  validateJsonValueInternal(
    value,
    path,
    0,
    {
      maxDepth: MAX_DEPTH,
      maxArrayLength: MAX_ARRAY_LENGTH,
      maxStringUtf8Bytes: profile.maxStringUtf8Bytes,
      maxRowUtf8Bytes: profile.maxRowUtf8Bytes,
      maxAggregateUtf8Bytes: profile.maxAggregateUtf8Bytes
    },
    bytes
  )
  return value as JsonObject
}

/**
 * Validate an array of objects with a named JSON profile (LOCK-LB-1).
 *
 * Mirrors {@link validateJsonObjectArray} for the profile path: every
 * element is validated with the profile (per-string + per-row budgets), and
 * the whole array shares one aggregate budget (per-page / per-result cap).
 * When no accountant is supplied a fresh one is created for the call.
 *
 * LOCK-LB-7: the top-level array length is capped at {@link MAX_ARRAY_LENGTH}
 * BEFORE element iteration (and before any aggregate bytes are charged), so
 * an oversized page/result is rejected without walking its elements.
 *
 * @param value    The array to validate.
 * @param path     Dot-separated path for error messages.
 * @param profile  The named validation profile (e.g. {@link BLOCK_JSON_PROFILE}).
 * @param bytes    Optional caller-owned byte accountant.
 * @throws {ValidationError} If any element fails profile validation.
 */
export function validateJsonObjectArrayBlock(
  value: unknown,
  path: string,
  profile: JsonValidationProfile,
  bytes?: JsonProfileBytes
): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(path, `Expected an array, got ${typeof value}`)
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    throw new ValidationError(path, `Array length ${value.length} exceeds maximum (${MAX_ARRAY_LENGTH})`)
  }
  const accountant = bytes ?? createProfileBytes()
  for (let i = 0; i < value.length; i++) {
    validateJsonObjectBlock(value[i], `${path}[${i}]`, profile, accountant)
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
 * Validate that a value is a finite non-negative integer.
 * Alias for validateIndex semantics, used for reference counts
 * and other non-negative integer domains.
 *
 * @param value  The value to validate.
 * @param path   Dot-separated path for error messages.
 * @throws {ValidationError} If the value is not a non-negative integer.
 */
export function validateNonNegativeInteger(value: unknown, path: string): void {
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

/**
 * Validate that a JsonObject does NOT contain any of the specified fields.
 * Used at the shared request boundary to reject identity/reparenting changes
 * in patch payloads (e.g. reject `id`/`topicId` in message patches).
 *
 * @param obj            The patch object to check.
 * @param rejectedFields Fields that must not be present.
 * @param path           Dot-separated path for error messages.
 * @throws {ValidationError} If any rejected field is present.
 */
export function validateNoIdentityFields(obj: JsonObject, rejectedFields: ReadonlySet<string>, path: string): void {
  for (const field of rejectedFields) {
    if (field in obj) {
      throw new ValidationError(
        `${path}.${field}`,
        `Identity/reparenting field "${field}" must not be present in patch`
      )
    }
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
 * Options for {@link validateResultEnvelope}.
 */
export interface ResultEnvelopeValidationOptions {
  /**
   * Skip the generic JSON-safe deep walk of a SUCCESS envelope's value.
   *
   * Used ONLY by commands whose success value contains fields that must be
   * validated with a command-specific profile — e.g. fetchMessages, where
   * `blocks` may legally carry nested strings above the generic 1 MiB cap.
   * The command contract then validates every part of the value itself
   * (generic caps for message objects, block profile for blocks), so no
   * JSON-safety coverage is lost — only the generic walker's string cap is
   * replaced by the command-specific profile.
   */
  readonly skipValueValidation?: boolean
}

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
 * @param options  Optional envelope validation options (LOCK-LB-5).
 * @throws {ValidationError} If the envelope is malformed.
 */
export function validateResultEnvelope(
  value: unknown,
  channel: string,
  options: ResultEnvelopeValidationOptions = {}
): void {
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
    // Value must be JSON-safe (including null). Commands with a
    // command-specific value profile (LOCK-LB-5) opt out here and validate
    // every part of the value in their own contract validator.
    if (!options.skipValueValidation) {
      validateJsonValue(obj.value, 'result.value')
    }
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
