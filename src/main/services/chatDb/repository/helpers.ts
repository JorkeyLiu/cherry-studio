/**
 * Shared helpers for repository implementations.
 *
 * Provides Drizzle-compatible insert helpers, ordering utilities,
 * pagination validation, and result types.
 *
 * Phase 2: central ordered-list algorithm + sortOrder patch rejection.
 */

import { asc, eq } from 'drizzle-orm'

import { decodeJson, encodeJson } from '../domain/codec'
import { applyOverflowPatch, type RowPatchResult } from '../domain/mappers'

// ---------------------------------------------------------------------------
// Drizzle result → Domain DTO converter
// ---------------------------------------------------------------------------

/**
 * Convert a Drizzle query result (camelCase keys) to a domain DTO.
 *
 * Drizzle ORM returns query results with camelCase column names matching
 * the schema definition (e.g., `topicId`, `sortOrder`). The domain DTOs
 * also use camelCase. This function:
 * 1. Decodes the `extra` JSON column → overflow object
 * 2. Copies all camelCase columns from the result (authoritative)
 * 3. Merges overflow as default values (columns win)
 * 4. Attaches the overflow field for round-trip preservation
 *
 * @param result     Drizzle query result (camelCase keys + `extra`)
 * @param tableName  Table name for error context
 * @param entityId   Entity ID for error context
 * @returns          Domain DTO with overflow field
 */
export function fromDrizzleResult<T extends { overflow: Record<string, unknown> }>(
  result: any,
  tableName: string,
  entityId: string
): T {
  const extra =
    decodeJson<Record<string, unknown>>(result.extra as string | null, {
      entity: entityId,
      table: tableName,
      id: entityId
    }) ?? {}

  // Start with overflow as base, then overlay columns (columns are authoritative)
  const domain: Record<string, unknown> = { ...extra }
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'extra') {
      domain[key] = value
    }
  }
  domain.overflow = extra
  return domain as unknown as T
}

// ---------------------------------------------------------------------------
// Drizzle-compatible insert helper
// ---------------------------------------------------------------------------

/**
 * Convert a domain DTO to a Drizzle-compatible insert object.
 *
 * The domain DTOs use camelCase keys which match the Drizzle schema
 * column names. This function:
 * 1. Extracts the `overflow` field and encodes it as `extra` JSON
 * 2. Returns all other fields unchanged (camelCase → Drizzle)
 * 3. Skips undefined values so database defaults can take effect
 *
 * @param data  Domain DTO with `overflow` field
 * @returns     Object with camelCase keys + `extra` column, no undefined values
 */
export function toInsertValues(data: any): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(data)) {
    if (key === 'overflow') continue
    if (value === undefined) continue
    result[key] = value
  }

  // Encode overflow → extra
  const overflow = data.overflow
  if (overflow && typeof overflow === 'object' && !Array.isArray(overflow)) {
    result.extra = encodeJson(Object.keys(overflow).length > 0 ? overflow : null)
  } else if (overflow === undefined || overflow === null) {
    result.extra = null
  }

  return result
}

/**
 * Convert a domain DTO patch to Drizzle-compatible update values.
 *
 * Uses the mapper's RowPatchResult to produce:
 * - `columns`: camelCase column values to SET (from mapper's snake_case → need conversion)
 * - Handles overflow via applyOverflowPatch
 *
 * @param currentExtra  Current extra column value from DB
 * @param patch         RowPatchResult from mapper
 * @param columnMap     Map from snake_case row key to camelCase Drizzle key
 * @returns             Object with camelCase keys ready for db.update().set()
 */
export function toUpdateValues(
  currentExtra: string | null,
  patch: RowPatchResult<any>,
  columnMap: Record<string, string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  // Convert snake_case column keys to camelCase
  for (const [key, value] of Object.entries(patch.columns)) {
    const camelKey = columnMap[key] ?? key
    result[camelKey] = value
  }

  // Apply overflow patch
  const newExtra = applyOverflowPatch(currentExtra, patch)
  result.extra = newExtra

  return result
}

/**
 * Build a column map from a field mapping array.
 * Maps snake_case → camelCase for Drizzle update operations.
 *
 * @param fields  Array of [camelCase, snake_case] pairs from mapper
 * @returns       Map from snake_case → camelCase
 */
export function buildColumnMap(fields: ReadonlyArray<[string, string]>): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [camel, snake] of fields) {
    map[snake] = camel
  }
  return map
}

// ---------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------

/**
 * Identity fields that must not be changed by ordinary update/patch methods.
 * Repositories should reject or strip these from patches.
 */
export const IDENTITY_FIELDS: Record<string, ReadonlySet<string>> = {
  topics: new Set(['id']),
  messages: new Set(['id', 'topicId']),
  messageBlocks: new Set(['id', 'messageId']),
  topicSegments: new Set(['id', 'topicId']),
  fileReferences: new Set(['id', 'blockId', 'fileId'])
}

/**
 * Validate that a patch does not attempt to change identity fields.
 * Throws if any identity field is present with a different value.
 *
 * @param patch       The incoming patch object.
 * @param entity      The entity type name (key of IDENTITY_FIELDS).
 * @param currentValues  Current values of identity fields on the existing row.
 */
export function assertNoIdentityChange(
  patch: Record<string, unknown>,
  entity: string,
  currentValues: Record<string, unknown>
): void {
  const fields = IDENTITY_FIELDS[entity]
  if (!fields) return
  for (const field of fields) {
    if (field in patch && patch[field] !== undefined && patch[field] !== currentValues[field]) {
      throw new Error(`Cannot change identity field "${field}" on ${entity}`)
    }
  }
}

/**
 * Clamp an insertion index to the valid range [0, count].
 * Rejects non-finite, non-integer, and negative values.
 *
 * @param index  Raw insertion index from caller.
 * @param count  Current number of siblings (determines upper bound).
 * @returns      Clamped index in [0, count].
 * @throws       {Error} If index is not a valid non-negative finite integer.
 */
export function clampIndex(index: unknown, count: number): number {
  if (typeof index !== 'number' || !Number.isFinite(index)) {
    throw new Error(`Invalid index: ${JSON.stringify(index)}. Must be a finite number.`)
  }
  if (!Number.isInteger(index)) {
    throw new Error(`Invalid index: ${index}. Must be an integer.`)
  }
  if (index < 0) {
    throw new Error(`Invalid index: ${index}. Must be >= 0.`)
  }
  return Math.min(index, count)
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AffectedCount {
  affected: number
}

export type GetResult<T> = { found: true; data: T } | { found: false; data: undefined }

export function notFound(): GetResult<never> {
  return { found: false, data: undefined }
}

export function found<T>(data: T): GetResult<T> {
  return { found: true, data }
}

// ---------------------------------------------------------------------------
// Limit validation
// ---------------------------------------------------------------------------

export function validatePageLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return 20
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new Error(`Invalid limit: ${JSON.stringify(limit)}. Must be a positive finite number.`)
  }
  if (!Number.isInteger(limit)) {
    throw new Error(`Invalid limit: ${limit}. Must be an integer (no fractional part).`)
  }
  if (limit < 1) {
    throw new Error(`Invalid limit: ${limit}. Must be >= 1.`)
  }
  return Math.min(limit, 100)
}

// ---------------------------------------------------------------------------
// Overflow patch application (convenience re-export)
// ---------------------------------------------------------------------------

export function applyPatch(currentExtra: string | null, patch: RowPatchResult<any>): string | null {
  return applyOverflowPatch(currentExtra, patch)
}

// ---------------------------------------------------------------------------
// Phase 2: Central ordered-list algorithm
//
// loadOrderedIds → assignDenseOrders is the canonical pattern for all
// positional mutations. Repositories load siblings, apply mutations to
// the ID array, then assign dense 0..n-1 orders.
// ---------------------------------------------------------------------------

/**
 * Load all sibling IDs in deterministic order (sort_order ASC, id ASC).
 * Must be called inside a transaction.
 */
export function loadOrderedIds(tx: any, table: any, parentCol: any, parentId: string): string[] {
  return tx
    .select({ id: table.id })
    .from(table)
    .where(eq(parentCol, parentId))
    .orderBy(asc(table.sortOrder), asc(table.id))
    .all()
    .map((r: any) => r.id as string)
}

/**
 * Assign dense 0..n-1 sort_order values to the given IDs.
 * Must be called inside a transaction.
 */
export function assignDenseOrders(tx: any, table: any, ids: string[]): void {
  for (let i = 0; i < ids.length; i++) {
    tx.update(table).set({ sortOrder: i }).where(eq(table.id, ids[i])).run()
  }
}

/**
 * Insert an ID at a specific index in an ordered ID list.
 * Returns a new array; does not mutate the input.
 */
export function insertAtId(ids: string[], id: string, index: number): string[] {
  const clamped = clampIndex(index, ids.length)
  const result = [...ids]
  result.splice(clamped, 0, id)
  return result
}

/**
 * Remove an ID from an ordered ID list.
 * Returns a new array; does not mutate the input.
 * Throws if the ID is not found.
 */
export function removeId(ids: string[], id: string): string[] {
  const idx = ids.indexOf(id)
  if (idx === -1) throw new Error(`ID ${id} not found in list`)
  const result = [...ids]
  result.splice(idx, 1)
  return result
}

/**
 * Move an existing ID to a new position in the list.
 * Returns a new array; does not mutate the input.
 * Throws if the ID is not found.
 */
export function moveId(ids: string[], id: string, toIndex: number): string[] {
  const fromIdx = ids.indexOf(id)
  if (fromIdx === -1) throw new Error(`ID ${id} not found in list`)
  const clamped = clampIndex(toIndex, ids.length - 1)
  const result = [...ids]
  result.splice(fromIdx, 1)
  result.splice(clamped, 0, id)
  return result
}

/**
 * Reject sortOrder changes in ordinary patches.
 * sortOrder must be changed only via insertAt/upsertAt/append/replaceOrder.
 */
export function assertNoSortOrderChange(patch: Record<string, unknown>): void {
  if ('sortOrder' in patch && patch.sortOrder !== undefined) {
    throw new Error('Cannot change sortOrder via update — use insertAt/upsertAt/replaceOrder instead')
  }
}
