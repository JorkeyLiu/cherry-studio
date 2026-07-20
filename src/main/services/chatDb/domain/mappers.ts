/**
 * Row ↔ Domain mapping functions for each chat entity.
 *
 * Contract:
 * - `fromRow(row)`: Decodes extra JSON → overflow, maps snake_case columns →
 *   camelCase domain fields. Explicit columns are authoritative (they override
 *   any same-named key in extra).
 * - `toRow(domain)`: Extracts known camelCase fields → snake_case columns,
 *   collects remaining keys → encodeJson → extra column.
 * - `toRowPatch(partial)`: Returns a RowPatchResult with:
 *   - `columns`: relational column values to SET (only specified fields).
 *   - `overflowDelta`: structured overflow patch for mergeOverflow().
 *     Repositories MUST call mergeOverflow(current, delta) and set
 *     columns.extra to the encoded result. Do NOT replace extra wholesale.
 *
 * Reconstruction: use `reconstruct(domainData)` from codec.ts.
 * Columns always win over same-named overflow keys.
 * For tool blocks with object content in overflow, pass overrides:
 *   reconstruct(block, block.type === 'tool' ? { content: block.overflow.content } : undefined)
 *
 * Preserves unknown keys via the overflow field on domain types.
 * Does NOT import @renderer types.
 */

import { decodeJson, encodeJson, mergeOverflow, OVERFLOW_CLEAR } from './codec'
import type {
  EntityPatchInput,
  FileReferenceData,
  FileReferenceRow,
  MessageBlockData,
  MessageBlockRow,
  MessageData,
  MessageRow,
  TopicData,
  TopicRow,
  TopicSegmentData,
  TopicSegmentMessageData,
  TopicSegmentMessageRow,
  TopicSegmentRow
} from './types'

// ============================================================================
// RowPatchResult — structured output from toRowPatch functions
// ============================================================================

/**
 * Structured result from a toRowPatch mapping.
 *
 * Repositories MUST:
 * 1. Use `columns` for the SQL SET clause (only explicitly specified fields).
 * 2. If `clearOverflow` is true, call `mergeOverflow(currentOverflow, overflowDelta ?? {}, { clear: true })`
 *    to produce the new extra value.
 * 3. If `clearOverflow` is false and `overflowDelta` is non-null, call
 *    `mergeOverflow(currentOverflow, overflowDelta)` to produce the new extra value.
 * 4. If `clearOverflow` is false and `overflowDelta` is null, extra is unchanged.
 * 5. Encode the result via encodeJson() and set `columns.extra`.
 * 6. Never replace extra wholesale — always use mergeOverflow.
 *
 * Convenience: use `applyOverflowPatch(currentExtra, patch)` which
 * encapsulates steps 2-5 into a single call.
 */
export interface RowPatchResult<R> {
  /** Relational column values to SET (only explicitly specified fields). */
  columns: Partial<R>
  /**
   * Overflow delta for mergeOverflow(). Null means no overflow change.
   * Keys with value OVERFLOW_REMOVE should be deleted.
   * Keys with value undefined are skipped (no-op).
   */
  overflowDelta: Record<string, unknown> | null
  /**
   * If true, clear ALL existing overflow before applying overflowDelta.
   * Corresponds to mergeOverflow(current, delta, { clear: true }).
   */
  clearOverflow: boolean
}

const TOPIC_FIELDS: ReadonlyArray<[string, string]> = [
  ['id', 'id'],
  ['assistantId', 'assistant_id'],
  ['name', 'name'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['deletedAt', 'deleted_at']
]

const MESSAGE_FIELDS: ReadonlyArray<[string, string]> = [
  ['id', 'id'],
  ['topicId', 'topic_id'],
  ['role', 'role'],
  ['content', 'content'],
  ['status', 'status'],
  ['askId', 'ask_id'],
  ['model', 'model'],
  ['modelId', 'model_id'],
  ['assistantId', 'assistant_id'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['sortOrder', 'sort_order']
]

const MESSAGE_BLOCK_FIELDS: ReadonlyArray<[string, string]> = [
  ['id', 'id'],
  ['messageId', 'message_id'],
  ['type', 'type'],
  ['content', 'content'],
  ['status', 'status'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['sortOrder', 'sort_order']
]

const TOPIC_SEGMENT_FIELDS: ReadonlyArray<[string, string]> = [
  ['id', 'id'],
  ['topicId', 'topic_id'],
  ['name', 'name'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['sortOrder', 'sort_order']
]

const FILE_REFERENCE_FIELDS: ReadonlyArray<[string, string]> = [
  ['id', 'id'],
  ['blockId', 'block_id'],
  ['fileId', 'file_id'],
  ['fileName', 'file_name'],
  ['filePath', 'file_path'],
  ['fileType', 'file_type'],
  ['count', 'count']
]

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generic fromRow: maps row → domain using a field mapping table.
 * Merges explicit column values on top of decoded overflow so that
 * columns are authoritative.
 */
function mapFromRow<D extends { overflow: Record<string, unknown> }>(
  row: Record<string, unknown>,
  fields: ReadonlyArray<[string, string]>,
  tableName: string,
  entityId: string
): D {
  const extra =
    decodeJson(row.extra as string | null, {
      entity: entityId,
      table: tableName,
      id: entityId
    }) ?? {}

  const result: Record<string, unknown> = { ...extra }
  for (const [domainKey, rowKey] of fields) {
    result[domainKey] = row[rowKey]
  }
  result.overflow = extra
  return result as unknown as D
}

/**
 * Generic toRow: maps domain → row using a field mapping table.
 * Collects all non-column keys (except overflow) into the extra JSON.
 */
function mapToRow<D, R extends { extra: string | null }>(data: D, fields: ReadonlyArray<[string, string]>): R {
  const domainKeyToRowKey = new Map(fields)
  const dataRecord = data as Record<string, unknown>

  const row: Record<string, unknown> = {}
  const overflow: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(dataRecord)) {
    if (key === 'overflow') continue // handled separately
    const rowKey = domainKeyToRowKey.get(key)
    if (rowKey) {
      row[rowKey] = value
    } else {
      // Unknown domain key → overflow
      overflow[key] = value
    }
  }

  // If the domain has an explicit overflow field, merge it
  if (dataRecord.overflow && typeof dataRecord.overflow === 'object' && !Array.isArray(dataRecord.overflow)) {
    Object.assign(overflow, dataRecord.overflow)
  }

  row.extra = encodeJson(Object.keys(overflow).length > 0 ? overflow : null)

  return row as unknown as R
}

/**
 * Generic toRowPatch: maps a partial domain object → RowPatchResult.
 * Only fields explicitly present in the patch appear in `columns`.
 * Overflow delta is returned separately for mergeOverflow() — never
 * encoded into extra directly.
 *
 * Semantics:
 * - Present key with value: included in columns (relational) or overflowDelta.
 * - Present key with null: included (clear field to SQL NULL).
 * - Present key with undefined: skipped (no-op).
 * - overflow key with OVERFLOW_CLEAR: sets clearOverflow=true (clear all, then merge delta).
 * - overflow key with object: the object is the overflow delta directly.
 * - OVERFLOW_REMOVE values in overflow delta mark keys for deletion.
 * - Unknown non-field keys (except 'overflow') go into overflowDelta.
 */
function mapToRowPatch<R extends Record<string, unknown>>(
  patch: Record<string, unknown>,
  fields: ReadonlyArray<[string, string]>
): { columns: Partial<R>; overflowDelta: Record<string, unknown> | null; clearOverflow: boolean } {
  const domainKeyToRowKey = new Map(fields)

  const columns: Record<string, unknown> = {}
  let overflowDelta: Record<string, unknown> | null = null
  let clearOverflow = false

  for (const [key, value] of Object.entries(patch)) {
    // Skip undefined values — no-op
    if (value === undefined) continue

    if (key === 'overflow') {
      if (value === OVERFLOW_CLEAR) {
        // Complete clear: discard all existing overflow
        clearOverflow = true
        // overflowDelta may still carry new keys to set after clearing
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // overflow field IS the delta (structured patch for mergeOverflow)
        overflowDelta = value as Record<string, unknown>
      }
      continue
    }

    const rowKey = domainKeyToRowKey.get(key)
    if (rowKey) {
      // Known field → relational column
      columns[rowKey] = value
    } else {
      // Unknown field → overflow delta key
      if (!overflowDelta) overflowDelta = {}
      overflowDelta[key] = value
    }
  }

  return {
    columns: columns as Partial<R>,
    overflowDelta,
    clearOverflow
  }
}

// ============================================================================
// Topic
// ============================================================================

export function topicFromRow(row: TopicRow): TopicData {
  return mapFromRow(row as unknown as Record<string, unknown>, TOPIC_FIELDS, 'topics', row.id)
}

export function topicToRow(data: TopicData): TopicRow {
  return mapToRow(data, TOPIC_FIELDS)
}

export function topicToRowPatch(patch: EntityPatchInput<TopicData>): RowPatchResult<TopicRow> {
  return mapToRowPatch(patch as Record<string, unknown>, TOPIC_FIELDS)
}

// ============================================================================
// Message
// ============================================================================

export function messageFromRow(row: MessageRow): MessageData {
  return mapFromRow(row as unknown as Record<string, unknown>, MESSAGE_FIELDS, 'messages', row.id)
}

export function messageToRow(data: MessageData): MessageRow {
  return mapToRow(data, MESSAGE_FIELDS)
}

export function messageToRowPatch(patch: EntityPatchInput<MessageData>): RowPatchResult<MessageRow> {
  return mapToRowPatch(patch as Record<string, unknown>, MESSAGE_FIELDS)
}

// ============================================================================
// MessageBlock
// ============================================================================

export function messageBlockFromRow(row: MessageBlockRow): MessageBlockData {
  return mapFromRow(row as unknown as Record<string, unknown>, MESSAGE_BLOCK_FIELDS, 'message_blocks', row.id)
}

export function messageBlockToRow(data: MessageBlockData): MessageBlockRow {
  return mapToRow(data, MESSAGE_BLOCK_FIELDS)
}

export function messageBlockToRowPatch(patch: EntityPatchInput<MessageBlockData>): RowPatchResult<MessageBlockRow> {
  return mapToRowPatch(patch as Record<string, unknown>, MESSAGE_BLOCK_FIELDS)
}

// ============================================================================
// TopicSegment
// ============================================================================

export function topicSegmentFromRow(row: TopicSegmentRow): TopicSegmentData {
  return mapFromRow(row as unknown as Record<string, unknown>, TOPIC_SEGMENT_FIELDS, 'topic_segments', row.id)
}

export function topicSegmentToRow(data: TopicSegmentData): TopicSegmentRow {
  return mapToRow(data, TOPIC_SEGMENT_FIELDS)
}

export function topicSegmentToRowPatch(patch: EntityPatchInput<TopicSegmentData>): RowPatchResult<TopicSegmentRow> {
  return mapToRowPatch(patch as Record<string, unknown>, TOPIC_SEGMENT_FIELDS)
}

// ============================================================================
// TopicSegmentMessage
// ============================================================================

export function topicSegmentMessageFromRow(row: TopicSegmentMessageRow): TopicSegmentMessageData {
  return {
    segmentId: row.segment_id,
    messageId: row.message_id,
    sortOrder: row.sort_order
  }
}

export function topicSegmentMessageToRow(data: TopicSegmentMessageData): TopicSegmentMessageRow {
  return {
    segment_id: data.segmentId,
    message_id: data.messageId,
    sort_order: data.sortOrder
  }
}

// ============================================================================
// FileReference
// ============================================================================

export function fileReferenceFromRow(row: FileReferenceRow): FileReferenceData {
  return mapFromRow(row as unknown as Record<string, unknown>, FILE_REFERENCE_FIELDS, 'file_references', row.id)
}

export function fileReferenceToRow(data: FileReferenceData): FileReferenceRow {
  return mapToRow(data, FILE_REFERENCE_FIELDS)
}

export function fileReferenceToRowPatch(patch: EntityPatchInput<FileReferenceData>): RowPatchResult<FileReferenceRow> {
  return mapToRowPatch(patch as Record<string, unknown>, FILE_REFERENCE_FIELDS)
}

// ============================================================================
// applyOverflowPatch — single-call helper for repositories
// ============================================================================

const OVERFLOW_CONTEXT = { entity: 'overflow', table: 'mappers', id: 'applyOverflowPatch' }

/**
 * Apply a RowPatchResult's overflow changes to the current extra column value.
 *
 * This is the single entry-point for repositories to convert a mapper's
 * RowPatchResult into a new extra column value. It encapsulates:
 *   - Decode current extra → overflow object
 *   - Apply clearOverflow flag (if true, discard current before merge)
 *   - Apply overflowDelta via mergeOverflow()
 *   - Encode result back to JSON string (or null for empty)
 *
 * Usage in a repository:
 *   const patch = topicToRowPatch({ name: 'New', overflow: OVERFLOW_CLEAR })
 *   const newExtra = applyOverflowPatch(currentRow.extra, patch)
 *   db.update(topics).set({ ...patch.columns, extra: newExtra }).where(...)
 *
 * @param currentExtra  Current extra column value from the database (string | null).
 * @param patch         Result from a toRowPatch() mapper call.
 * @returns             New extra column value ready for SQL SET.
 */
export function applyOverflowPatch<R>(currentExtra: string | null, patch: RowPatchResult<R>): string | null {
  if (!patch.clearOverflow && patch.overflowDelta === null) {
    // No overflow change — preserve current extra as-is
    return currentExtra
  }

  const current = decodeJson<Record<string, unknown>>(currentExtra, OVERFLOW_CONTEXT) ?? {}
  const merged = patch.clearOverflow
    ? mergeOverflow(current, patch.overflowDelta ?? {}, { clear: true })
    : patch.overflowDelta
      ? mergeOverflow(current, patch.overflowDelta)
      : current

  return encodeJson(Object.keys(merged).length > 0 ? merged : null)
}
