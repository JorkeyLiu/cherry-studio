/**
 * JSON codec for the chat database extra columns.
 *
 * Design rules:
 * - Deterministic round-trip for serializable values.
 * - null/undefined → SQL NULL (returns null).
 * - Empty object {} → SQL NULL (normalised).
 * - Ordered arrays preserved.
 * - Unknown keys preserved as-is.
 * - Non-serializable values (circular refs, BigInt) cause descriptive errors.
 * - Invalid JSON errors include entity/table/id for debugging.
 *
 * Overflow patch semantics:
 * - OVERFLOW_REMOVE sentinel: marks a key for deletion from overflow.
 * - mergeOverflow(current, delta, options?): transactional merge helper.
 *   Repositories MUST use this instead of replacing extra wholesale.
 */

/**
 * Sentinel value for removing a key from overflow during a patch merge.
 * Use as the value in a patch delta: `{ keyToRemove: OVERFLOW_REMOVE }`.
 */
export const OVERFLOW_REMOVE: unique symbol = Symbol('OVERFLOW_REMOVE')

/**
 * Sentinel value for clearing ALL overflow keys during a patch merge.
 * Use as the value of the `overflow` key in a patch:
 *   { overflow: OVERFLOW_CLEAR }
 * or for complete clear with new keys:
 *   { overflow: OVERFLOW_CLEAR, ... newKeys }
 * The mapper sets `clearOverflow: true` in RowPatchResult.
 */
export const OVERFLOW_CLEAR: unique symbol = Symbol('OVERFLOW_CLEAR')

/**
 * Options for mergeOverflow.
 */
export interface MergeOverflowOptions {
  /** If true, clear all existing overflow before applying the delta. */
  clear?: boolean
}

/**
 * Transactional overflow merge for safe partial updates.
 *
 * Contract:
 * - Keys absent from delta are preserved from current (unchanged).
 * - Keys in delta with value `undefined` are skipped (no-op).
 * - Keys in delta with value `OVERFLOW_REMOVE` are removed.
 * - Keys in delta with any other value are set/overwritten.
 * - If options.clear is true, start from an empty object.
 * - Returns a new object; does not mutate current or delta.
 *
 * @param current  Current overflow decoded from the extra column.
 * @param delta    Patch keys to apply. Use OVERFLOW_REMOVE to delete.
 * @param options  { clear?: boolean } — if true, discard current first.
 * @returns        New overflow object (empty object normalised to {}).
 */
export function mergeOverflow(
  current: Record<string, unknown>,
  delta: Record<string, unknown>,
  options?: MergeOverflowOptions
): Record<string, unknown> {
  const base = options?.clear ? {} : { ...current }
  const result: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(delta)) {
    if (value === undefined) {
      // Skip — no-op for undefined patch values
      continue
    }
    if (value === OVERFLOW_REMOVE) {
      // Remove the key
      delete result[key]
    } else {
      // Set/overwrite
      result[key] = value
    }
  }

  return result
}

/**
 * Encode a value to a JSON string for storage in SQLite's TEXT column.
 *
 * @param value  The value to encode.
 * @returns      JSON string, or null if the value is null/undefined/empty-object.
 * @throws       {Error} If the value contains non-serializable content
 *               (circular references, BigInt, etc.).
 */
export function encodeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null

  // Normalise empty objects to SQL NULL
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return null
  }

  try {
    return JSON.stringify(value)
  } catch (error) {
    throw new Error(`Failed to encode JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Decode a JSON string from a SQLite TEXT column.
 *
 * @param raw      The raw string from the database.
 * @param context  Descriptive context for error messages.
 * @returns        Parsed value, or null if raw is null/undefined/empty/'{}'.
 * @throws         {Error} With entity/table/id context if JSON is invalid.
 */
export function decodeJson<T = Record<string, unknown>>(
  raw: string | null | undefined,
  context: { entity: string; table: string; id: string }
): T | null {
  if (raw === null || raw === undefined || raw === '') return null

  // Normalised empty-object → null
  if (raw === '{}') return null

  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${context.table}.${context.entity} (id=${context.id}): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Raw value (first 200 chars): ${raw.slice(0, 200)}`
    )
  }
}

/**
 * Reconstruct a renderer-compatible object from a domain DTO.
 *
 * Guarantee: explicit relational columns ALWAYS win over same-named
 * overflow keys. Overflow is spread first, then columns on top.
 *
 * Usage:
 *   const plain = reconstruct(domainData)
 *
 * For tool blocks where object content lives in overflow.content but
 * the column content is null, pass an explicit override:
 *   const plain = reconstruct(block,
 *     block.type === 'tool' && block.content === null
 *       ? { content: block.overflow.content }
 *       : undefined
 *   )
 *
 * @param domain    Domain DTO with overflow field.
 * @param overrides Optional keys applied AFTER columns (highest precedence).
 * @returns         Plain object without the overflow key, columns authoritative.
 */
export function reconstruct<D extends { overflow: Record<string, unknown> }>(
  domain: D,
  overrides?: Record<string, unknown>
): Omit<D, 'overflow'> {
  const { overflow, ...columns } = domain
  // Overflow first, columns on top, then explicit overrides.
  // This ensures: overrides > columns > overflow (stale same-named keys lose).
  return { ...overflow, ...columns, ...overrides } as Omit<D, 'overflow'>
}

/**
 * Block-specific reconstruction helper.
 *
 * For tool blocks where the structured object content lives in
 * overflow.content (the column content is null), this helper
 * automatically restores the object content while keeping all
 * relational promoted fields (status, createdAt, etc.) authoritative.
 *
 * For non-tool blocks, this is equivalent to reconstruct(block).
 *
 * @param block  Any domain DTO with type, content, and overflow fields.
 * @returns      Plain object without overflow, with tool content restored.
 */
export function reconstructBlock<
  D extends { type: string | null; content: string | null; overflow: Record<string, unknown> }
>(block: D): Omit<D, 'overflow'> {
  const overrides: Record<string, unknown> | undefined =
    block.type === 'tool' && block.content === null && block.overflow.content !== undefined
      ? { content: block.overflow.content }
      : undefined
  return reconstruct(block, overrides)
}
