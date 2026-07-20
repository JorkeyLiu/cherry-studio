/**
 * Main-local persistence DTOs for the chat database.
 *
 * Design rules:
 * - No imports from @renderer. These types are self-contained in Main.
 * - Row types use snake_case matching the SQLite column names exactly.
 * - Domain types use camelCase mirroring the application's naming convention.
 * - Explicit relational columns are authoritative. Extra JSON stores overflow.
 * - Unknown keys are preserved via the `overflow` field on domain types.
 * - sort_order is zero-based dense; repositories enforce density.
 * - file_references use block_id (not message_id); full file metadata in overflow.
 */

import type { OVERFLOW_CLEAR } from './codec'

// ---------------------------------------------------------------------------
// Row DTOs — exact shape returned from SQLite queries (snake_case)
// ---------------------------------------------------------------------------

export interface TopicRow {
  id: string
  assistant_id: string | null
  name: string | null
  created_at: string | null
  updated_at: string | null
  deleted_at: string | null
  extra: string | null
}

export interface MessageRow {
  id: string
  topic_id: string
  role: string | null
  content: string | null
  status: string | null
  ask_id: string | null
  model: string | null
  model_id: string | null
  assistant_id: string | null
  created_at: string | null
  updated_at: string | null
  sort_order: number
  extra: string | null
}

export interface MessageBlockRow {
  id: string
  message_id: string
  type: string | null
  content: string | null
  status: string | null
  created_at: string | null
  updated_at: string | null
  sort_order: number
  extra: string | null
}

export interface TopicSegmentRow {
  id: string
  topic_id: string
  name: string | null
  created_at: string | null
  updated_at: string | null
  sort_order: number
  extra: string | null
}

export interface TopicSegmentMessageRow {
  segment_id: string
  message_id: string
  sort_order: number
}

export interface FileReferenceRow {
  id: string
  block_id: string
  file_id: string
  file_name: string | null
  file_path: string | null
  file_type: string | null
  count: number | null
  extra: string | null
}

// ---------------------------------------------------------------------------
// Domain DTOs — camelCase shape used by repositories and mappers
//
// The `overflow` field contains all non-column keys decoded from the extra
// JSON column. When reconstructing a renderer-compatible object, use:
//   import { reconstruct } from './codec'
//   const plain = reconstruct(domainData)
//
// Columns ALWAYS win over same-named overflow keys.
// For tool blocks where object content lives in overflow.content:
//   const plain = reconstruct(block,
//     block.type === 'tool' && block.content === null
//       ? { content: block.overflow.content }
//       : undefined
//   )
//
// Do NOT use `{ ...domainData, ...domainData.overflow }` — this puts
// overflow last and overwrites authoritative columns with stale values.
// ---------------------------------------------------------------------------

export interface TopicData {
  id: string
  assistantId: string | null
  name: string | null
  createdAt: string | null
  updatedAt: string | null
  deletedAt: string | null
  /** Overflow fields decoded from extra JSON (unknown keys preserved) */
  overflow: Record<string, unknown>
}

export interface MessageData {
  id: string
  topicId: string
  role: string | null
  content: string | null
  status: string | null
  askId: string | null
  model: string | null
  modelId: string | null
  assistantId: string | null
  createdAt: string | null
  updatedAt: string | null
  sortOrder: number
  overflow: Record<string, unknown>
}

export interface MessageBlockData {
  id: string
  messageId: string
  type: string | null
  /** String content only. Object content (e.g. tool results) lives in overflow. */
  content: string | null
  status: string | null
  createdAt: string | null
  updatedAt: string | null
  sortOrder: number
  overflow: Record<string, unknown>
}

export interface TopicSegmentData {
  id: string
  topicId: string
  name: string | null
  createdAt: string | null
  updatedAt: string | null
  sortOrder: number
  overflow: Record<string, unknown>
}

export interface TopicSegmentMessageData {
  segmentId: string
  messageId: string
  sortOrder: number
}

export interface FileReferenceData {
  id: string
  blockId: string
  fileId: string
  fileName: string | null
  filePath: string | null
  fileType: string | null
  count: number | null
  /** Full file metadata snapshot decoded from extra JSON */
  overflow: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Patch input types — typed overflow for mapper APIs
//
// Problem: Partial<EntityData> types overflow as Record<string,unknown> | undefined,
// but callers need to pass OVERFLOW_CLEAR sentinel directly without `as any`.
//
// Solution: EntityPatchInput<T> makes ordinary fields partial but types overflow
// as the full patch union: delta object | OVERFLOW_CLEAR | undefined | null.
// ---------------------------------------------------------------------------

/**
 * Overflow patch value for entity mapper inputs.
 *
 * Supports:
 * - Delta object: partial overflow keys to merge (OVERFLOW_REMOVE marks deletion)
 * - OVERFLOW_CLEAR sentinel: clear all overflow before applying delta
 * - undefined: no overflow change (no-op)
 * - null: included for explicit null semantics (same as undefined no-op in mapper)
 */
export type OverflowPatchValue = Record<string, unknown> | typeof OVERFLOW_CLEAR | undefined | null

/**
 * Patch input type for entity mappers.
 *
 * Keeps all entity fields partial (like Partial<T>) but types `overflow`
 * as OverflowPatchValue to accept OVERFLOW_CLEAR sentinel directly.
 */
export type EntityPatchInput<T extends { overflow: Record<string, unknown> }> = {
  [K in keyof T]?: K extends 'overflow' ? OverflowPatchValue : T[K]
}
