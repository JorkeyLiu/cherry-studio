/**
 * Wire DTO types for the ChatImport IPC layer (Phase 4.1 source-reader).
 *
 * Design rules:
 * - JSON-only types. No Electron, Node, Drizzle, or Renderer imports.
 * - Envelope carries sessionId + phase + version for every cross-IPC message.
 * - DTOs reuse existing Dexie logical shapes — no import-specific DTOs with
 *   parallel field lists (ADR diagnostic rationale).
 * - `items` in ReadPageResponse use JsonObject from chatDb/types.
 * - Version constant: 1 (bump on breaking wire changes).
 */

import type { JsonObject } from '../chatDb/types'

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Versioned envelope wrapping all ChatImport IPC messages. */
export interface ChatImportEnvelope<T> {
  /** Unique session identifier (UUIDv4). */
  sessionId: string
  /** Pipeline phase that produced this message. */
  phase: 'discovery' | 'reading' | 'complete' | 'error'
  /** Wire format version. Currently 1. */
  version: 1
  /** Phase-specific payload. */
  data: T
}

// ---------------------------------------------------------------------------
// Discovery (renderer → main, triggered by main)
// ---------------------------------------------------------------------------

/**
 * Discovery result reported by the import renderer after opening the
 * source IndexedDB. Fields come from `indexedDB.databases()` and the
 * production Dexie open.
 */
export interface DiscoveryResult {
  /** Database name as reported by indexedDB.databases(). */
  databaseName: string
  /** Native IndexedDB version (Dexie logical × 10). */
  nativeVersion: number
  /** Dexie logical version (e.g. 11 for current CherryStudio). */
  logicalVersion: number
  /** Table names discovered after Dexie open. */
  tableNames: string[]
}

// ---------------------------------------------------------------------------
// Read page (main → renderer → main)
// ---------------------------------------------------------------------------

/**
 * Main → renderer: request one page of data from a specific table.
 */
export interface ReadPageRequest {
  /** Dexie table name (e.g. 'topics', 'message_blocks'). */
  tableName: string
  /** Opaque cursor (last-seen ID) or null for the first page. */
  cursor: string | null
  /** Page size (configurable; default DEFAULT_PAGE_SIZE = 500). */
  pageSize: number
}

/**
 * Renderer → main: one page of data items from a specific table.
 * `items` are JsonObject[] matching the Dexie logical shape.
 */
export interface ReadPageResponse {
  /** The table these items belong to. */
  tableName: string
  /** Row data as JsonObject[], conforming to the Dexie entity shape. */
  items: JsonObject[]
  /** Opaque cursor for the next page, or null if this is the last page. */
  cursor: string | null
  /** True if more pages remain. */
  hasMore: boolean
}

// ---------------------------------------------------------------------------
// Source stats (renderer → main, after all pages)
// ---------------------------------------------------------------------------

/**
 * Aggregate row counts reported after the renderer has streamed all pages.
 * Used by Phase 4.2 for verification heuristics.
 */
export interface SourceStats {
  topicCount: number
  messageCount: number
  blockCount: number
  segmentCount: number
  fileRefCount: number
}

// ---------------------------------------------------------------------------
// Error payload (renderer → main)
// ---------------------------------------------------------------------------

/**
 * Structured error reported by the import renderer.
 * Sanitised — no paths or stack traces.
 */
export interface ImportErrorPayload {
  /** Machine-readable error code. */
  code: string
  /** Human-readable message (sanitised). */
  message: string
}
