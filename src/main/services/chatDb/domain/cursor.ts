/**
 * Page/cursor primitives for repository pagination.
 *
 * Design:
 * - Cursor is an opaque base64url-encoded JSON payload containing a
 *   stable ordering tuple (sortOrder, id) plus version/type metadata.
 * - Direction controls sort order for the query.
 * - PageResult includes a nextCursor for forward pagination.
 * - Repositories enforce cursor encoding/decoding.
 * - Limits are validated: positive finite integer, clamped to MAX_LIMIT.
 *
 * Typed cursors:
 * - Each cursor carries a kind (`k`) discriminator: 'numeric-order' or 'topic-timestamp'.
 * - Repository decoders MUST use the kind-specific decode function and reject cross-use.
 * - Generic encodeCursor/decodeCursor are kept for backward compatibility but
 *   repositories should migrate to typed APIs.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size when caller omits limit. */
export const DEFAULT_LIMIT = 20

/** Maximum allowed page size. Larger values are clamped to this. */
export const MAX_LIMIT = 100

/** Discriminated cursor kinds. */
export type CursorKind = 'numeric-order' | 'topic-timestamp'

// ---------------------------------------------------------------------------
// Cursor payload schema (internal, opaque to callers)
// ---------------------------------------------------------------------------

interface CursorPayload {
  /** Schema version. Bump for breaking changes. */
  v: 1
  /** Cursor type discriminator. */
  t: 'keyset'
  /** Sort key: integer sort_order or ISO timestamp string. */
  so: number | string
  /** id value of the boundary row. */
  id: string
  /** Cursor kind discriminator (new in Phase 2). */
  k?: CursorKind
}

// ---------------------------------------------------------------------------
// PageCursor / PageResult types
// ---------------------------------------------------------------------------

/** Request a page of results. */
export interface PageCursor {
  /**
   * Opaque cursor value from a previous PageResult.nextCursor.
   * Omit for the first page. Must NOT be constructed manually —
   * always use the value returned by encodeCursor().
   */
  cursor?: string
  /**
   * Maximum number of items to return.
   * Validated: must be a positive finite integer.
   * Clamped to MAX_LIMIT (100). Defaults to DEFAULT_LIMIT (20) if omitted.
   */
  limit: number
  /** Sort direction for the query. */
  direction: 'asc' | 'desc'
}

/** Result of a paginated query. */
export interface PageResult<T> {
  /** Items in this page. */
  items: T[]
  /**
   * Cursor for the next page. Undefined when no more items exist.
   * Always use this value as-is for the next PageCursor.cursor —
   * do not construct cursors manually.
   */
  nextCursor?: string
  /** True if there are items beyond this page. */
  hasMore: boolean
}

// ---------------------------------------------------------------------------
// Encoding / Decoding
// ---------------------------------------------------------------------------

/**
 * Encode a (sortKey, id) pair into an opaque cursor string.
 *
 * @param sortOrder  The sort key of the last item in the current page.
 *                   Must be a finite integer (sort_order) or a non-empty
 *                   string (ISO timestamp for createdAt-based ordering).
 * @param id       The id of the last item in the current page.
 *                 Must be a non-empty string.
 * @returns        Opaque base64url-encoded cursor string.
 * @throws         {Error} If sortOrder is invalid or id is empty.
 */
export function encodeCursor(sortOrder: number | string, id: string): string {
  if (typeof sortOrder === 'number') {
    if (!Number.isFinite(sortOrder)) {
      throw new Error(`Invalid cursor sortOrder: ${JSON.stringify(sortOrder)}. Must be a finite number.`)
    }
    if (!Number.isInteger(sortOrder)) {
      throw new Error(`Invalid cursor sortOrder: ${sortOrder}. Must be an integer (no fractional part).`)
    }
  } else if (typeof sortOrder === 'string') {
    if (sortOrder.length === 0) {
      throw new Error('Invalid cursor sortOrder: empty string.')
    }
  } else {
    throw new Error(`Invalid cursor sortOrder: ${JSON.stringify(sortOrder)}. Must be a number or non-empty string.`)
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Invalid cursor id: ${JSON.stringify(id)}. Must be a non-empty string.`)
  }
  const payload: CursorPayload = { v: 1, t: 'keyset', so: sortOrder, id }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/**
 * Decode an opaque cursor string back to (sortOrder, id).
 *
 * Validates:
 * - Valid base64url + JSON parse.
 * - Schema version is 1.
 * - Type discriminator is 'keyset'.
 * - sortOrder is a finite integer or non-empty string.
 * - id is a non-empty string.
 *
 * @param cursor  Opaque cursor string from encodeCursor().
 * @returns       { sortOrder, id } tuple where sortOrder is a number or string.
 * @throws        {Error} If cursor is malformed or validation fails.
 */
export function decodeCursor(cursor: string): { sortOrder: number | string; id: string } {
  let json: string
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf-8')
  } catch {
    throw new Error('Malformed cursor: invalid base64url encoding')
  }

  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    throw new Error('Malformed cursor: invalid JSON payload')
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Malformed cursor: payload is not an object')
  }

  const p = payload as Record<string, unknown>

  if (p.v !== 1) {
    throw new Error(`Malformed cursor: unsupported version ${JSON.stringify(p.v)}`)
  }

  if (p.t !== 'keyset') {
    throw new Error(`Malformed cursor: unsupported type ${JSON.stringify(p.t)}`)
  }

  if (typeof p.so === 'number') {
    if (!Number.isFinite(p.so)) {
      throw new Error('Malformed cursor: sortOrder must be a finite number')
    }
    if (!Number.isInteger(p.so)) {
      throw new Error('Malformed cursor: sortOrder must be an integer (no fractional part)')
    }
  } else if (typeof p.so === 'string') {
    if (p.so.length === 0) {
      throw new Error('Malformed cursor: sortOrder must be a non-empty string')
    }
  } else {
    throw new Error('Malformed cursor: sortOrder must be a number or non-empty string')
  }

  if (typeof p.id !== 'string' || p.id.length === 0) {
    throw new Error('Malformed cursor: id must be a non-empty string')
  }

  return { sortOrder: p.so, id: p.id }
}

// ---------------------------------------------------------------------------
// Typed cursor encode/decode — Phase 2: discriminated kinds
// ---------------------------------------------------------------------------

/**
 * Encode a numeric-order cursor (sort_order is integer).
 * Used by messages and segments pagination.
 */
export function encodeNumericOrderCursor(sortOrder: number, id: string): string {
  if (!Number.isFinite(sortOrder) || !Number.isInteger(sortOrder)) {
    throw new Error(`Invalid numeric cursor sortOrder: ${sortOrder}. Must be a finite integer.`)
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Invalid cursor id: ${JSON.stringify(id)}. Must be a non-empty string.`)
  }
  const payload: CursorPayload = { v: 1, t: 'keyset', so: sortOrder, id, k: 'numeric-order' }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/**
 * Encode a topic-timestamp cursor (sort key is ISO timestamp string).
 * Used by topics pagination (createdAt, id).
 * Empty string is the sentinel for legacy null createdAt.
 */
export function encodeTopicTimestampCursor(timestamp: string, id: string): string {
  if (typeof timestamp !== 'string') {
    throw new Error(`Invalid timestamp cursor: ${JSON.stringify(timestamp)}. Must be a string.`)
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Invalid cursor id: ${JSON.stringify(id)}. Must be a non-empty string.`)
  }
  const payload: CursorPayload = { v: 1, t: 'keyset', so: timestamp, id, k: 'topic-timestamp' }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/**
 * Decode a numeric-order cursor. Rejects topic-timestamp cursors.
 * Returns sortOrder as a finite integer and id.
 */
export function decodeNumericOrderCursor(cursor: string): { sortOrder: number; id: string } {
  const decoded = decodeCursor(cursor)
  // Re-parse to check kind — decodeCursor already validated structure
  const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as CursorPayload
  if (payload.k !== 'numeric-order') {
    throw new Error(`Cursor kind mismatch: expected 'numeric-order', got '${payload.k ?? 'undefined'}'`)
  }
  if (typeof decoded.sortOrder !== 'number') {
    throw new Error('Numeric cursor sortOrder must be a number')
  }
  return { sortOrder: decoded.sortOrder, id: decoded.id }
}

/**
 * Decode a topic-timestamp cursor. Rejects numeric-order cursors.
 * Returns sortOrder as a string (ISO timestamp or empty sentinel) and id.
 * Empty string sortOrder is valid for legacy null createdAt.
 */
export function decodeTopicTimestampCursor(cursor: string): { sortOrder: string; id: string } {
  let json: string
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf-8')
  } catch {
    throw new Error('Malformed cursor: invalid base64url encoding')
  }

  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    throw new Error('Malformed cursor: invalid JSON payload')
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Malformed cursor: payload is not an object')
  }

  const p = payload as Record<string, unknown>

  if (p.v !== 1) {
    throw new Error(`Malformed cursor: unsupported version ${JSON.stringify(p.v)}`)
  }
  if (p.t !== 'keyset') {
    throw new Error(`Malformed cursor: unsupported type ${JSON.stringify(p.t)}`)
  }
  if (p.k !== 'topic-timestamp') {
    throw new Error(`Cursor kind mismatch: expected 'topic-timestamp', got '${p.k ?? 'undefined'}'`)
  }
  // Allow empty string as sentinel for legacy null createdAt
  if (typeof p.so !== 'string') {
    throw new Error('Malformed cursor: timestamp sortOrder must be a string')
  }
  if (typeof p.id !== 'string' || p.id.length === 0) {
    throw new Error('Malformed cursor: id must be a non-empty string')
  }

  return { sortOrder: p.so, id: p.id }
}

// ---------------------------------------------------------------------------
// Limit validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalise a page limit value.
 *
 * Rules:
 * - undefined/null → DEFAULT_LIMIT (20).
 * - Must be a positive finite integer.
 * - Fractional values (e.g. 10.5) are rejected.
 * - Values > MAX_LIMIT (100) are clamped.
 * - Values < 1 throw.
 *
 * @param limit  Raw limit value from caller.
 * @returns      Validated, clamped integer.
 * @throws       {Error} If limit is not a valid positive integer.
 */
export function validateLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT

  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new Error(`Invalid limit: ${JSON.stringify(limit)}. Must be a positive finite number.`)
  }

  if (!Number.isInteger(limit)) {
    throw new Error(`Invalid limit: ${limit}. Must be an integer (no fractional part).`)
  }

  if (limit < 1) {
    throw new Error(`Invalid limit: ${limit}. Must be >= 1.`)
  }

  return Math.min(limit, MAX_LIMIT)
}

/**
 * Patch semantics for partial entity updates.
 *
 * - Present key with a value: update the field.
 * - Present key with explicit null: clear the field (set to SQL NULL).
 * - Absent key (undefined): leave the field unchanged.
 *
 * The `id` field is always required to identify the target row.
 */
export type EntityPatch<T> = { id: string } & {
  [K in keyof Omit<T, 'id'>]?: T[K] | null
}

/**
 * Options for clear / delete operations.
 */
export interface ClearOptions {
  /** If true, permanently delete (hard delete). Otherwise soft-delete if supported. */
  hard?: boolean
}
