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
 * Source-read accounting (LOCK-4211A).
 *
 * Describes the source entities that were *actually paged* out of the source
 * IndexedDB during the read phase. Every field is a count of source records
 * streamed for that table — nothing more. It deliberately does NOT claim:
 * - embedded message counts (messages are not a paged source table), or
 * - target file-reference counts (those belong to {@link CandidateImportStats}).
 *
 * All counts are safe, non-negative integers.
 */
export interface SourceReadStats {
  /** Source `topics` records paged. */
  topicRecordCount: number
  /** Source `message_blocks` records paged. */
  blockRecordCount: number
  /** Source `topic_segments` records paged. */
  segmentRecordCount: number
  /** Source `files` records paged (source file rows, not target references). */
  sourceFileRecordCount: number
}

/**
 * Candidate construction accounting (LOCK-4211B).
 *
 * Describes what the downstream candidate builder produced for the import
 * target. These are *target* counts, distinct from the source-read counts in
 * {@link SourceReadStats}.
 *
 * All `*Count` and `pageCount` fields are safe, non-negative integers.
 * `elapsedMs` is a non-negative finite number (fractional values allowed to
 * accommodate high-resolution timers).
 */
export interface CandidateImportStats {
  /** Topics written to the candidate. */
  topicCount: number
  /** Messages reconstructed into the candidate. */
  messageCount: number
  /** Message blocks written to the candidate. */
  blockCount: number
  /** Topic segments written to the candidate. */
  segmentCount: number
  /** Segment membership links written to the candidate. */
  segmentMembershipCount: number
  /** File references written to the candidate. */
  fileReferenceCount: number
  /** Number of source pages consumed while building the candidate. */
  pageCount: number
  /** Wall-clock duration of candidate construction, in milliseconds. */
  elapsedMs: number
}

/**
 * Candidate-ready result (LOCK-4211C).
 *
 * Minimal shared contract the downstream Main code needs to hand a completed
 * candidate back for later integration. It identifies the session and the
 * candidate, and carries the {@link CandidateImportStats}.
 *
 * It deliberately exposes NO filesystem paths and NO SQL — those remain
 * internal to Main. If a future phase requires the renderer to know a path,
 * that must be added via an explicit, reviewed contract change, not here.
 */
export interface CandidateReadyResult {
  /** Import session identifier (UUIDv4), matching the envelope `sessionId`. */
  sessionId: string
  /** Opaque candidate identifier assigned by Main. Not a path. */
  candidateId: string
  /** Candidate construction accounting. */
  stats: CandidateImportStats
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
