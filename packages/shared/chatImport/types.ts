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

// ---------------------------------------------------------------------------
// L2 Cherry Studio ZIP import control (Phase 6.3)
// ---------------------------------------------------------------------------

/**
 * Platform support result for the L2 import control IPC.
 */
export interface CherryImportPlatformSupport {
  /** True if the current platform supports import (macOS only). */
  supported: boolean
  /** The current process.platform value. */
  platform: string
}

/**
 * L2 import state — semantic superset of the Phase 4 ImportState,
 * mapped for renderer consumption. No filesystem paths.
 */
export type CherryImportUIState =
  | 'idle'
  | 'intake'
  | 'discovering'
  | 'reading'
  | 'candidate-ready'
  | 'verifying'
  | 'verified-candidate'
  | 'verification-failed'
  | 'promoting'
  | 'finalizing'
  | 'promoted'
  | 'promotion-failed'
  | 'cancelled'
  | 'error'

/**
 * Status event emitted from Main → renderer when the L2 import
 * state changes. Carries no filesystem paths or SQL.
 */
export interface CherryImportStatusEvent {
  /** Import session identifier. */
  sessionId: string
  /** Current UI-mapped import state. */
  state: CherryImportUIState
  /** Sanitised error message for terminal failure states. */
  error?: string
  /** Candidate construction stats (available after candidate-ready). */
  stats?: CandidateImportStats
}

// ---------------------------------------------------------------------------
// Shared typed IPC command results (LOCK-6005)
// ---------------------------------------------------------------------------

/**
 * Bounded start command result crossing the IPC boundary.
 * Typed — not an anonymous object literal.
 */
export interface CherryImportStartResult {
  /** Whether the start command succeeded. */
  readonly ok: boolean
  /** Sanitised error message (never raw error.message). */
  readonly error?: string
  /** Session identifier — present only on success. */
  readonly sessionId?: string
}

/**
 * Bounded cancel command result crossing the IPC boundary.
 * Typed — not an anonymous object literal.
 */
export interface CherryImportCancelResult {
  /** Whether the cancel command succeeded. */
  readonly ok: boolean
  /** Sanitised error message (never raw error.message). */
  readonly error?: string
}

// ---------------------------------------------------------------------------
// L2 navigation projection (LOCK-PROD-2/3/4/6)
// ---------------------------------------------------------------------------

/**
 * Source Local Storage (`persist:cherry-studio`) payload reported by the
 * import renderer. The raw redux-persist string is sent verbatim to Main —
 * parsing/validation is a Main-side concern (LOCK-PROD-2).
 */
export interface ChatImportProjectionPayload {
  /** The raw `persist:cherry-studio` localStorage string (may be null). */
  readonly persist: string | null
}

/**
 * One assistant in the versioned minimal navigation projection.
 * Carries ONLY source navigation metadata (LOCK-PROD-2) — never assistant
 * behavior configuration (prompts/settings/models are not imported).
 */
export interface ProjectionAssistant {
  /** Source assistant id. Must be unique within the projection (LOCK-PROD-5). */
  readonly id: string
  /** Source assistant display name. */
  readonly name: string
  /** Source assistant emoji, when present. */
  readonly emoji: string | null
  /** Position in the source assistant list (source order). */
  readonly order: number
}

/**
 * One topic in the versioned minimal navigation projection. LS metadata is
 * authoritative for these fields ONLY; topic existence/messages/blocks/
 * segments/files/deletedAt remain authoritative in IndexedDB/SQLite
 * (LOCK-PROD-2/3).
 */
export interface ProjectionTopic {
  /** Topic id — must exist in the imported IndexedDB topics (LOCK-PROD-3). */
  readonly id: string
  /** Owning assistant id (container assistant is authoritative for grouping). */
  readonly assistantId: string
  /** Source topic display name. */
  readonly name: string
  /** Source created-at ISO string, or null when unknown (LOCK-PROD-4). */
  readonly createdAt: string | null
  /** Source updated-at ISO string, or null when unknown (LOCK-PROD-4). */
  readonly updatedAt: string | null
  /**
   * Deleted-at ISO string, or null when active. ALWAYS resolved to the
   * IndexedDB/SQLite value (LOCK-PROD-3: LS may not override deleted state).
   */
  readonly deletedAt: string | null
  /** Source pinned state. */
  readonly pinned: boolean
  /** Source isNameManuallyEdited state. */
  readonly isNameManuallyEdited: boolean
  /** Position within the source assistant's topics list (source order). */
  readonly order: number
}

/**
 * One IndexedDB-only topic surfaced under the reserved "Recovered
 * conversations" shell assistant (LOCK-PROD-4).
 *
 * IndexedDB owns existence and deletedAt (LOCK-FP2): the recovered payload
 * carries ONLY {id, deletedAt} — no source metadata (names, timestamps,
 * assistant ownership) is ever inferred. Active recovered topics (deletedAt
 * null) surface as visible navigation under the shell; deleted recovered
 * topics are NEVER resurrected as active navigation — the product pattern
 * excludes soft-deleted topics from Redux entirely (trash semantics are
 * DB-backed by the imported SQLite/Dexie rows that carry the authoritative
 * deletedAt).
 */
export interface ProjectionRecoveredTopic {
  /** Topic id — must exist in the imported IndexedDB topics (LOCK-PROD-3). */
  readonly id: string
  /** IndexedDB-authoritative deletedAt; null when the topic is active. */
  readonly deletedAt: string | null
}

/**
 * Reserved shell assistant id for IndexedDB-only "Recovered conversations"
 * topics (LOCK-PROD-4). Imported source assistant ids must never collide
 * with it (LOCK-PROD-5). Shared between Main (projection validation) and
 * renderer (projection apply).
 */
export const RECOVERED_SHELL_ASSISTANT_ID = 'import-recovered-conversations'

/**
 * Versioned one-shot navigation projection. Travels atomically with the
 * candidate `chat.db` (stored under a versioned `migration_state` key) and
 * is applied idempotently by the renderer after Redux rehydration
 * (LOCK-PROD-6).
 */
export interface ImportNavigationProjection {
  /** Projection schema version. */
  readonly version: 1
  /** Source redux-persist version observed (diagnostic only). */
  readonly sourcePersistVersion: number | null
  /** Imported assistant shells, in source order (LOCK-PROD-2/5). */
  readonly assistants: ProjectionAssistant[]
  /** Imported topics joined against IndexedDB, grouped by assistantId. */
  readonly topics: ProjectionTopic[]
  /**
   * IndexedDB-only topics with no Local Storage metadata (LOCK-PROD-4).
   * Each entry carries the IndexedDB-authoritative deletedAt (LOCK-FP2):
   * active recovered topics surface under the localized "Recovered
   * conversations" shell assistant; deleted recovered topics are retained
   * in the payload so the renderer can honor the deleted state and never
   * resurrect them as active navigation.
   */
  readonly recoveredTopicIds: ProjectionRecoveredTopic[]
}

/**
 * Result of the renderer → Main one-shot projection read. Returns the
 * pending projection or a no-op result when none is pending (LOCK-PROD-6).
 */
export type CherryImportGetProjectionResult =
  | { readonly ok: true; readonly projection: ImportNavigationProjection }
  | { readonly ok: true; readonly projection: null }
  | { readonly ok: false; readonly error: string }

/**
 * Result of the renderer → Main durable projection acknowledgment. The ack
 * clears the one-shot payload from the live SQLite `migration_state` after
 * the renderer has applied it and flushed redux-persist (LOCK-PROD-6).
 */
export interface CherryImportAckProjectionResult {
  readonly ok: boolean
  readonly error?: string
}

// ---------------------------------------------------------------------------
// L2 files catalog snapshot + catalog apply boundary (Phase 2, LOCK-PROMO-5)
// ---------------------------------------------------------------------------

/**
 * One normalized Dexie `files` row captured from the LIVE catalog (or
 * restored into it). JSON-only — no Electron/Node/renderer imports. `type`
 * and `created_at` are nullable so both live rows and candidate rows map
 * onto the same wire shape.
 */
export interface FilesCatalogSnapshotRow {
  /** Dexie files primary key. */
  readonly id: string
  /** Canonical physical filename `<id><ext>`. */
  readonly name: string
  /** Source display name (origin_name ?? name ?? canonical name). */
  readonly origin_name: string
  /** Stored path value (the app recomputes it from id/ext at read time). */
  readonly path: string
  /** Physical payload size in bytes. */
  readonly size: number
  /** Source extension incl. dot ('' when absent). */
  readonly ext: string
  /** Source file type or null. */
  readonly type: string | null
  /** Source created-at ISO string or null. */
  readonly created_at: string | null
  /** Rebuilt reference count. */
  readonly count: number
}

/**
 * Durable live-catalog rollback snapshot payload (LOCK-PROMO-3). Written by
 * Main at the fixed owned name; the renderer captures the rows and Main
 * persists + verifies the bytes. `integrity` is the aggregate receipt.
 */
export interface FilesCatalogSnapshotV1 {
  readonly version: 1
  readonly capturedAt: string
  readonly rows: readonly FilesCatalogSnapshotRow[]
  readonly integrity: {
    readonly count: number
    /** SHA-256 hex of {@link filesCatalogHashInput}(rows). */
    readonly sha256: string
  }
}

/**
 * Canonical digest input over catalog rows (sorted by id). Both Main
 * (node:crypto) and renderer (Web Crypto) hash EXACTLY this string so the
 * aggregate receipts agree across the boundary.
 */
export function filesCatalogHashInput(rows: readonly FilesCatalogSnapshotRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let out = ''
  for (const row of sorted) {
    out += `${row.id}\0${row.name}\0${row.size}\0${row.count}\n`
  }
  return out
}

/** Kinds of renderer catalog requests Main can send (LOCK-PROMO-5/7). */
export type CatalogRecoveryRequestKind =
  /** Read the live Dexie files table and return canonical rows + digest. */
  | 'capture-snapshot'
  /** Single-transaction replace-all with candidate catalog rows. */
  | 'apply-candidate'
  /** Single-transaction replace-all restoring old snapshot rows. */
  | 'restore-snapshot'
  /** Read-only facts (count + digest) of the CURRENT files table. */
  | 'query-facts'

/** One main → renderer catalog request. */
export interface CatalogRecoveryRequest {
  readonly requestId: string
  readonly kind: CatalogRecoveryRequestKind
  /**
   * Current canonical target files root (e.g. `<userData>/Data/Files`) for
   * apply-candidate and restore-snapshot. The renderer rewrites every row
   * `path` to `<filesPath>/<id><ext>` (LOCK-CAT-4). Provided by Main because
   * the recovery-only renderer has no `getAppInfo` IPC during startup.
   */
  readonly filesPath?: string
  /** For apply-candidate: the candidate catalog rows (name/size/etc). */
  readonly catalogRows?: readonly FilesCatalogSnapshotRow[]
  /** For apply-candidate: expected aggregate receipt (candidate generation). */
  readonly expected?: { readonly count: number; readonly sha256: string }
  /** For restore-snapshot: the snapshot to restore (rows + integrity). */
  readonly snapshot?: FilesCatalogSnapshotV1
}

/** Aggregate facts returned by the renderer after a Dexie operation. */
export interface CatalogRecoveryFacts {
  readonly count: number
  /** SHA-256 hex over {@link filesCatalogHashInput}(current rows). */
  readonly sha256: string
}

/** One renderer → main catalog response. */
export type CatalogRecoveryResponse =
  | {
      readonly ok: true
      readonly requestId: string
      /** Canonical rows (capture-snapshot only). */
      readonly rows?: readonly FilesCatalogSnapshotRow[]
      /** Facts AFTER the requested operation (apply/restore/query/capture). */
      readonly facts?: CatalogRecoveryFacts
    }
  | {
      readonly ok: false
      readonly requestId: string
      /** Bounded machine-readable failure code (never raw messages/paths). */
      readonly code: string
    }

/** Result of a Main-driven catalog boundary operation. */
export type CatalogApplyOutcome =
  | { readonly ok: true; readonly facts: CatalogRecoveryFacts }
  | { readonly ok: false; readonly code: string }

/**
 * Result of the renderer → Main catalog ready signal (LOCK-BRIDGE-1).
 * The recovery renderer invokes the ready channel ONLY after its catalog
 * request handler is installed; Main awaits it (bounded) before sending any
 * catalog request. `accepted: false` covers stale/duplicate/post-dispose
 * signals — the awaiting Main falls back to its own bounded ready timeout.
 */
export interface CatalogRecoveryReadyResult {
  readonly accepted: boolean
}

/** Startup recovery signal for the catalog handoff (LOCK-PROMO-7). */
export interface CatalogStartupRecoverySignal {
  /** True when the app must boot into the recovery-only surface. */
  readonly catalogRecoveryRequired: boolean
  /** The pending operation the recovery surface must perform. */
  readonly action: 'apply-candidate' | 'restore-snapshot' | null
  /** The v2 journal phase that blocked ordinary startup. */
  readonly phase: string | null
}
