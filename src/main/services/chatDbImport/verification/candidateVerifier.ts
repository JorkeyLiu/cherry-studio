/**
 * Candidate verifier — readonly sealed-candidate verification across the
 * 14 documented dimensions (Phase 4.3.2, LOCK-4301/4302/4303/4304/4305,
 * LOCK-SP-1..4/6).
 *
 * Given a sealed candidate dbPath and a finalized SourceVerificationManifest,
 * this module reopens the candidate strictly readonly, reconstructs
 * target-equivalent domain records through the existing Drizzle/domain
 * mappers, compares the complete source evidence (IDs, counts, full record
 * digests, orders, relations, file refs, segments/memberships, structured
 * model/tool JSON, overflow), runs both SQLite PRAGMAs, performs
 * deterministic repository-level sample reads through the existing
 * application read path (ChatDbAggregateService + repositories) bound to
 * the candidate, and verifies the derived FTS/normalized search projection
 * (LOCK-SP-2..4).
 *
 * Guarantees:
 * - LOCK-4301: full source-vs-target verification. Every comparison uses
 *   manifest evidence; target-only checks never substitute.
 * - LOCK-4302: target rows are framed by the SAME shared `entityFraming`
 *   implementation used to build the manifest — field lists exist once.
 * - LOCK-4303: explicit cancellable/closable lifecycle. The readonly
 *   SQLite handle always closes in `finally`; AbortSignal and `close()`
 *   are honored at bounded checkpoint/yield boundaries.
 * - LOCK-4304: exactly one result per documented dimension plus bounded
 *   safe diagnostics (IDs, field paths, counts/orders, digests only —
 *   never raw chat content, raw overflow, SQL, fs paths, stack traces).
 *   Expected verification failures return a report; unexpected open/query
 *   errors are sanitized into the report's `fatal` field.
 * - LOCK-4305: readonly only. Never initializes ChatDbService, runs
 *   migrations, writes the candidate, touches the live DB, promotes,
 *   snapshots, relaunches, or changes shared/preload/renderer APIs.
 * - LOCK-SP-1: dimension ⑭ `search_projection` is appended AFTER the
 *   existing 13 dimensions; their names/order/semantics are unchanged.
 * - LOCK-SP-2: the search projection check is full, readonly and
 *   deterministic: exact sqlite_master object inventory (normalized table,
 *   message_id index, FTS table, three sync triggers — names from the
 *   migration constants, LOCK-FTS-2), canonical-predicate vs normalized vs
 *   FTS count parity, normalized.message_id vs canonical block.message_id,
 *   normalized_content vs shared normalizeSearchText(canonical content)
 *   computed JS-side (LOCK-SP-6), and EXACT FTS↔normalized multiset parity
 *   (no probabilistic hashing): both projections are streamed in the same
 *   deterministic order and merged row-by-row with the injective
 *   length-prefixed key (length(block_id), block_id,
 *   length(normalized_content), normalized_content) — duplicates and NUL
 *   bytes are preserved, and the merge compares actual bytes, so it is
 *   injective rather than collision-prone.
 * - LOCK-SP-3: FTS parity is exact and scalable — bounded chunked scans
 *   with an explicit finite chunk budget, cursor-index buffering (no O(n)
 *   shift queue), and a single SQLite temp-sort stream on the FTS side to
 *   obtain the shared deterministic order without quadratic keyset
 *   re-scans. O(chunk) JS memory plus SQLite's bounded external sort; abort
 *   checkpoints are honored on every chunk. Diagnostics carry fixed codes,
 *   counts, schema object names and allowed entity IDs only — never
 *   content, paths, or SQL.
 * - LOCK-SP-4: a fixed synthetic MATCH token proves FTS MATCH executes;
 *   it is not required to match source content.
 *
 * Main-only. Never expose over IPC/preload/renderer.
 */

import fs from 'node:fs'

import { ChatDbAggregateService } from '@main/services/chatDb/ChatDbAggregateService'
import {
  fileReferenceFromRow,
  messageBlockFromRow,
  messageFromRow,
  topicFromRow,
  topicSegmentFromRow
} from '@main/services/chatDb/domain/mappers'
import type {
  FileReferenceRow,
  MessageBlockRow,
  MessageRow,
  TopicRow,
  TopicSegmentMessageRow,
  TopicSegmentRow
} from '@main/services/chatDb/domain/types'
import {
  FTS_SMOKE_TOKEN,
  MESSAGE_BLOCKS_FTS_TABLE,
  MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER,
  MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER,
  MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX,
  MESSAGE_BLOCKS_NORMALIZED_TABLE,
  MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER
} from '@main/services/chatDb/migration'
import { createRepositories } from '@main/services/chatDb/repository/factory'
import * as schema from '@main/services/chatDb/schema'
import { normalizeSearchText } from '@shared/searchTextNormalization'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { canonicalDigest, CanonicalizationError } from './canonicalJson'
import { digestBlock, digestFileReference, digestMessage, digestSegment, digestTopic } from './entityFraming'
import type { ProjectionRow } from './searchProjectionCompare'
import { compareProjectionRows } from './searchProjectionCompare'
import type { ManifestEntitySection, SourceVerificationManifest } from './sourceManifest'
import type {
  CandidateVerificationReport,
  VerificationDiagnostic,
  VerificationDiagnosticInput,
  VerificationDimension,
  VerificationDimensionResult,
  VerificationFatal
} from './verificationContracts'
import { createDiagnostic, createFatal, VERIFICATION_DIMENSIONS } from './verificationContracts'

// ---------------------------------------------------------------------------
// Options / lifecycle types
// ---------------------------------------------------------------------------

export interface CandidateVerifierOptions {
  /** Absolute path to the sealed candidate chat.db. Never echoed in output. */
  dbPath: string
  /** Finalized source verification manifest (LOCK-4301). */
  manifest: SourceVerificationManifest
  /** Cooperative cancellation, honored at checkpoint boundaries (LOCK-4303). */
  signal?: AbortSignal
  /**
   * Rows per query chunk. Bounded to [1, MAX_SEARCH_PROJECTION_CHUNK_SIZE]
   * before any allocation (LOCK-SP-3): non-finite (NaN/±Infinity) and
   * non-positive (zero/negative) values normalize to the default (500);
   * values above the fixed maximum clamp to it. Production default 500.
   */
  chunkSize?: number
  /** Diagnostics kept per dimension before truncation (default 25, min 1). */
  maxDiagnosticsPerDimension?: number
  /** Topics/segments sampled for repository reads (default 5, min 1). */
  sampleCount?: number
  /**
   * Test-only hook invoked at every checkpoint boundary BEFORE the abort
   * check, making abort timing deterministic in tests.
   */
  onCheckpoint?: () => void
}

/** Verifier lifecycle state (LOCK-4303). */
export type CandidateVerifierState = 'created' | 'running' | 'done' | 'closed'

// ---------------------------------------------------------------------------
// Internal sentinels
// ---------------------------------------------------------------------------

/** Internal: thrown at a checkpoint when the run is aborted/closed. */
class VerifierAborted extends Error {
  constructor() {
    super('candidate verification aborted')
    this.name = 'VerifierAborted'
  }
}

/** Internal: open-phase failure carrying only a safe machine code. */
class CandidateOpenFailure extends Error {
  readonly safeCode: string
  constructor(safeCode: string) {
    super('candidate open failed')
    this.name = 'CandidateOpenFailure'
    this.safeCode = safeCode
  }
}

/** Extract a safe machine code from an unknown error (no messages/paths). */
function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code)) return code
    if (error instanceof Error && error.name.length > 0) return error.name
  }
  return 'UNKNOWN'
}

// ---------------------------------------------------------------------------
// Dimension collector — bounded diagnostics with truncation metadata
// ---------------------------------------------------------------------------

class DimensionCollector {
  private readonly diagnostics: VerificationDiagnostic[] = []
  private truncated = 0
  private checked = 0
  private failed = false
  private completed = false

  constructor(
    readonly dimension: VerificationDimension,
    private readonly cap: number
  ) {}

  /** Count one comparison. */
  check(): void {
    this.checked += 1
  }

  /** Record one mismatch (bounded by the per-dimension cap). */
  fail(input: Omit<VerificationDiagnosticInput, 'dimension'>): void {
    this.failed = true
    if (this.diagnostics.length < this.cap) {
      this.diagnostics.push(createDiagnostic({ dimension: this.dimension, ...input }))
    } else {
      this.truncated += 1
    }
  }

  /** Mark the dimension as fully evaluated. */
  complete(): void {
    this.completed = true
  }

  toResult(): VerificationDimensionResult {
    return Object.freeze({
      dimension: this.dimension,
      status: this.completed ? (this.failed ? ('fail' as const) : ('pass' as const)) : ('skipped' as const),
      checkedCount: this.checked,
      diagnostics: Object.freeze([...this.diagnostics]),
      truncatedDiagnosticCount: this.truncated
    })
  }
}

type CollectorMap = Record<VerificationDimension, DimensionCollector>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default rows per query chunk (production default, unchanged).
 */
const DEFAULT_CHUNK_SIZE = 500

/**
 * Fixed finite upper bound for the verifier chunk size (LOCK-SP-3).
 *
 * Every chunked scan — the entity keyset scans (scanById/scanMemberships),
 * the canonical↔normalized projection scans and the exact FTS↔normalized
 * parity stream — buffers O(chunkSize) rows at a time (plus one bounded
 * SQLite temp sort on the FTS side), so the chunk size MUST be a finite
 * positive integer. Direct/future callers passing Infinity, NaN, negatives,
 * zero, or values above this bound (e.g. Number.MAX_SAFE_INTEGER) normalize
 * conservatively to the fixed default or this fixed maximum — no unbounded
 * allocation is possible. Production callers pass nothing and keep the
 * default (500).
 */
export const MAX_SEARCH_PROJECTION_CHUNK_SIZE = 5000

const DEFAULT_DIAGNOSTIC_CAP = 25
const DEFAULT_SAMPLE_COUNT = 5

const TOPIC_COLUMNS = 'id, assistant_id, name, created_at, updated_at, deleted_at, extra'
const MESSAGE_COLUMNS =
  'id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra'
const BLOCK_COLUMNS = 'id, message_id, type, content, status, created_at, updated_at, sort_order, extra'
const SEGMENT_COLUMNS = 'id, topic_id, name, created_at, updated_at, sort_order, extra'
const FILE_REFERENCE_COLUMNS = 'id, block_id, file_id, file_name, file_path, file_type, count, extra'

// ---------------------------------------------------------------------------
// Chunk size normalization (LOCK-SP-3)
// ---------------------------------------------------------------------------

/**
 * Normalize a caller-supplied chunk size to a finite integer within
 * [1, MAX_SEARCH_PROJECTION_CHUNK_SIZE] BEFORE any cursor/buffer
 * allocation, so every chunked scan stays O(chunk) bounded:
 *
 * - undefined (production)                 → DEFAULT_CHUNK_SIZE (unchanged)
 * - NaN / ±Infinity (non-finite)           → DEFAULT_CHUNK_SIZE
 * - ≤ 0 (zero/negative — invalid LIMIT)    → DEFAULT_CHUNK_SIZE
 * - finite > MAX_SEARCH_PROJECTION_CHUNK_SIZE → MAX_SEARCH_PROJECTION_CHUNK_SIZE
 * - finite within bounds (incl. 0 < v < 1) → floor(value) clamped to ≥ 1
 */
export function normalizeChunkSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CHUNK_SIZE
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CHUNK_SIZE
  return Math.min(Math.max(Math.floor(value), 1), MAX_SEARCH_PROJECTION_CHUNK_SIZE)
}

// ---------------------------------------------------------------------------
// CandidateVerifier
// ---------------------------------------------------------------------------

/**
 * One verification run over one sealed candidate. Exact-once `run()`;
 * `close()` is idempotent and acts as cooperative cancellation when a run
 * is in flight (LOCK-4303).
 */
export class CandidateVerifier {
  private readonly dbPath: string
  private readonly manifest: SourceVerificationManifest
  private readonly signal: AbortSignal | undefined
  private readonly chunkSize: number
  private readonly diagnosticCap: number
  private readonly sampleCount: number
  private readonly onCheckpoint: (() => void) | undefined

  private sqlite: Database.Database | null = null
  private state: CandidateVerifierState = 'created'
  private closeRequested = false

  constructor(options: CandidateVerifierOptions) {
    this.dbPath = options.dbPath
    this.manifest = options.manifest
    this.signal = options.signal
    this.chunkSize = normalizeChunkSize(options.chunkSize)
    this.diagnosticCap = Math.max(1, Math.floor(options.maxDiagnosticsPerDimension ?? DEFAULT_DIAGNOSTIC_CAP))
    this.sampleCount = Math.max(1, Math.floor(options.sampleCount ?? DEFAULT_SAMPLE_COUNT))
    this.onCheckpoint = options.onCheckpoint
  }

  /** Current lifecycle state (LOCK-4303). */
  getState(): CandidateVerifierState {
    return this.state
  }

  /**
   * Close the verifier. Idempotent. When a run is in flight this acts as
   * cooperative cancellation: the readonly handle is closed immediately
   * and the run stops at its next checkpoint (LOCK-4303).
   */
  close(): void {
    this.closeRequested = true
    this.closeHandle()
    if (this.state !== 'running') {
      this.state = 'closed'
    }
  }

  /**
   * Run verification exactly once. Never throws for verification
   * failures, aborts, or sanitized unexpected errors — always resolves to
   * a report with exactly one result per documented dimension.
   *
   * @throws {Error} only for lifecycle misuse (second run / run after close).
   */
  async run(): Promise<CandidateVerificationReport> {
    if (this.state !== 'created' || this.closeRequested) {
      throw new Error(`CandidateVerifier.run() is exact-once (state: ${this.state}).`)
    }
    this.state = 'running'

    const collectors = Object.fromEntries(
      VERIFICATION_DIMENSIONS.map((d) => [d, new DimensionCollector(d, this.diagnosticCap)])
    ) as CollectorMap

    let fatal: VerificationFatal | null = null
    let aborted = false

    try {
      await this.checkpoint()
      this.openReadonly()
      await this.verifyEntities(collectors)
      await this.checkpoint()
      this.runIntegrityCheck(collectors)
      await this.checkpoint()
      this.runForeignKeyCheck(collectors)
      await this.checkpoint()
      await this.runSampleReads(collectors)
      await this.checkpoint()
      await this.runSearchProjectionCheck(collectors)
    } catch (error) {
      if (error instanceof VerifierAborted) {
        aborted = true
      } else if (error instanceof CandidateOpenFailure) {
        fatal = createFatal('CANDIDATE_OPEN_FAILED', error.safeCode)
      } else if (error instanceof CanonicalizationError) {
        fatal = createFatal('CANDIDATE_QUERY_FAILED', error.name, error.path)
      } else {
        fatal = createFatal('CANDIDATE_QUERY_FAILED', safeErrorCode(error))
      }
    } finally {
      // The readonly handle closes on every outcome (LOCK-4303).
      this.closeHandle()
      this.state = this.closeRequested ? 'closed' : 'done'
    }

    const dimensions = Object.freeze(VERIFICATION_DIMENSIONS.map((d) => collectors[d].toResult()))
    const failed = fatal !== null || dimensions.some((r) => r.status !== 'pass')
    return Object.freeze({
      status: aborted ? ('aborted' as const) : failed ? ('fail' as const) : ('pass' as const),
      dimensions,
      fatal
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle internals
  // -------------------------------------------------------------------------

  private closeHandle(): void {
    if (this.sqlite !== null) {
      try {
        this.sqlite.close()
      } catch {
        // Handle already closed / closing race — the handle is discarded
        // either way and no further statements can run on it.
      }
      this.sqlite = null
    }
  }

  /**
   * Bounded checkpoint/yield boundary (LOCK-4303): invoke the test hook,
   * observe abort/close, then yield to the event loop.
   */
  private async checkpoint(): Promise<void> {
    this.onCheckpoint?.()
    if (this.closeRequested || this.signal?.aborted === true) {
      throw new VerifierAborted()
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  private requireHandle(): Database.Database {
    if (this.sqlite === null) {
      // Externally closed mid-run — surfaces as cooperative cancellation.
      throw new VerifierAborted()
    }
    return this.sqlite
  }

  /**
   * Validate the candidate path and open it strictly readonly
   * (LOCK-4305). Failures carry only safe machine codes — never the path.
   */
  private openReadonly(): void {
    let usable = typeof this.dbPath === 'string' && this.dbPath.length > 0
    if (usable) {
      try {
        usable = fs.statSync(this.dbPath).isFile()
      } catch {
        usable = false
      }
    }
    if (!usable) {
      throw new CandidateOpenFailure('CANDIDATE_DB_NOT_A_FILE')
    }
    try {
      this.sqlite = new Database(this.dbPath, { readonly: true, fileMustExist: true })
    } catch (error) {
      throw new CandidateOpenFailure(safeErrorCode(error))
    }
  }

  // -------------------------------------------------------------------------
  // Chunked readonly scans (deterministic keyset pagination)
  // -------------------------------------------------------------------------

  private async scanById(
    table: 'topics' | 'messages' | 'message_blocks' | 'topic_segments' | 'file_references',
    columns: string,
    handler: (row: Record<string, unknown>) => void
  ): Promise<void> {
    const sqlite = this.requireHandle()
    const first = sqlite.prepare(`SELECT ${columns} FROM ${table} ORDER BY id LIMIT ?`)
    const next = sqlite.prepare(`SELECT ${columns} FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`)
    let lastId: string | null = null
    for (;;) {
      await this.checkpoint()
      const rows = (lastId === null ? first.all(this.chunkSize) : next.all(lastId, this.chunkSize)) as Record<
        string,
        unknown
      >[]
      for (const row of rows) handler(row)
      if (rows.length < this.chunkSize) return
      lastId = rows[rows.length - 1].id as string
    }
  }

  private async scanMemberships(handler: (row: TopicSegmentMessageRow) => void): Promise<void> {
    const sqlite = this.requireHandle()
    const base = 'SELECT segment_id, message_id, sort_order FROM topic_segment_messages'
    const order = 'ORDER BY segment_id, sort_order, message_id'
    const first = sqlite.prepare(`${base} ${order} LIMIT ?`)
    const next = sqlite.prepare(`${base} WHERE (segment_id, sort_order, message_id) > (?, ?, ?) ${order} LIMIT ?`)
    let last: TopicSegmentMessageRow | null = null
    for (;;) {
      await this.checkpoint()
      const rows = (
        last === null
          ? first.all(this.chunkSize)
          : next.all(last.segment_id, last.sort_order, last.message_id, this.chunkSize)
      ) as TopicSegmentMessageRow[]
      for (const row of rows) handler(row)
      if (rows.length < this.chunkSize) return
      last = rows[rows.length - 1]
    }
  }

  // -------------------------------------------------------------------------
  // Dimensions ①–⑩ — full source-vs-target entity comparison (LOCK-4301)
  // -------------------------------------------------------------------------

  private async verifyEntities(c: CollectorMap): Promise<void> {
    const manifest = this.manifest

    const topicIds = new Set<string>()
    const messageIds = new Set<string>()
    const blockIds = new Set<string>()
    const segmentIds = new Set<string>()
    const messageTopicById = new Map<string, string>()
    const segmentTopicById = new Map<string, string>()

    // --- ① topics -----------------------------------------------------------
    await this.scanById('topics', TOPIC_COLUMNS, (row) => {
      const data = topicFromRow(row as unknown as TopicRow)
      topicIds.add(data.id)
      c.id_sets.check()
      const ev = manifest.topics.entries[data.id]
      if (ev === undefined) {
        c.id_sets.fail(unexpectedEntity('topics', data.id))
        return
      }
      const d = digestTopic(data)
      compareRecordDigest(c, 'topics', data.id, ev.digest, d.record)
      compareOverflowDigest(c, 'topics', data.id, ev.overflowDigest, d.overflow)
    })
    this.finishEntitySection(c, 'topics', manifest.topics, topicIds)

    // --- ② messages ----------------------------------------------------------
    await this.scanById('messages', MESSAGE_COLUMNS, (row) => {
      const data = messageFromRow(row as unknown as MessageRow)
      messageIds.add(data.id)
      messageTopicById.set(data.id, data.topicId)
      c.fk_references.check()
      if (!topicIds.has(data.topicId)) {
        c.fk_references.fail(fkBroken('messages', data.id, 'topicId', data.topicId))
      }
      c.id_sets.check()
      const ev = manifest.messages.entries[data.id]
      if (ev === undefined) {
        c.id_sets.fail(unexpectedEntity('messages', data.id))
        return
      }
      const d = digestMessage(data)
      compareRecordDigest(c, 'messages', data.id, ev.digest, d.record)
      compareOverflowDigest(c, 'messages', data.id, ev.overflowDigest, d.overflow)
      c.structured_json.check()
      if (d.structuredModel !== ev.structuredModelDigest) {
        c.structured_json.fail({
          entity: 'messages',
          entityId: data.id,
          fieldPath: 'overflow.model',
          expected: ev.structuredModelDigest,
          actual: d.structuredModel,
          code: 'STRUCTURED_JSON_MISMATCH'
        })
      }
      c.order.check()
      if (data.sortOrder !== ev.sortOrder) {
        c.order.fail({
          entity: 'messages',
          entityId: data.id,
          fieldPath: 'sortOrder',
          expected: ev.sortOrder,
          actual: data.sortOrder,
          code: 'ORDER_MISMATCH'
        })
      }
      c.relations.check()
      if (data.topicId !== ev.topicId) {
        c.relations.fail({
          entity: 'messages',
          entityId: data.id,
          fieldPath: 'topicId',
          expected: ev.topicId,
          actual: data.topicId,
          code: 'RELATION_MISMATCH'
        })
      }
    })
    this.finishEntitySection(c, 'messages', manifest.messages, messageIds)

    // --- ③ message_blocks ----------------------------------------------------
    await this.scanById('message_blocks', BLOCK_COLUMNS, (row) => {
      const data = messageBlockFromRow(row as unknown as MessageBlockRow)
      blockIds.add(data.id)
      c.fk_references.check()
      if (!messageIds.has(data.messageId)) {
        c.fk_references.fail(fkBroken('message_blocks', data.id, 'messageId', data.messageId))
      }
      c.id_sets.check()
      const ev = manifest.blocks.entries[data.id]
      if (ev === undefined) {
        c.id_sets.fail(unexpectedEntity('message_blocks', data.id))
        return
      }
      const d = digestBlock(data)
      compareRecordDigest(c, 'message_blocks', data.id, ev.digest, d.record)
      compareOverflowDigest(c, 'message_blocks', data.id, ev.overflowDigest, d.overflow)
      c.structured_json.check()
      if (d.structuredContent !== ev.structuredContentDigest) {
        c.structured_json.fail({
          entity: 'message_blocks',
          entityId: data.id,
          fieldPath: 'overflow.content',
          expected: ev.structuredContentDigest,
          actual: d.structuredContent,
          code: 'STRUCTURED_JSON_MISMATCH'
        })
      }
      c.order.check()
      if (data.sortOrder !== ev.sortOrder) {
        c.order.fail({
          entity: 'message_blocks',
          entityId: data.id,
          fieldPath: 'sortOrder',
          expected: ev.sortOrder,
          actual: data.sortOrder,
          code: 'ORDER_MISMATCH'
        })
      }
      c.relations.check()
      if (data.messageId !== ev.messageId) {
        c.relations.fail({
          entity: 'message_blocks',
          entityId: data.id,
          fieldPath: 'messageId',
          expected: ev.messageId,
          actual: data.messageId,
          code: 'RELATION_MISMATCH'
        })
      }
    })
    this.finishEntitySection(c, 'message_blocks', manifest.blocks, blockIds)

    // --- ④ file_references ---------------------------------------------------
    const fileRefIds = new Set<string>()
    await this.scanById('file_references', FILE_REFERENCE_COLUMNS, (row) => {
      const data = fileReferenceFromRow(row as unknown as FileReferenceRow)
      fileRefIds.add(data.id)
      c.fk_references.check()
      if (!blockIds.has(data.blockId)) {
        c.fk_references.fail(fkBroken('file_references', data.id, 'blockId', data.blockId))
      }
      c.id_sets.check()
      const ev = manifest.fileReferences.entries[data.id]
      if (ev === undefined) {
        c.id_sets.fail(unexpectedEntity('file_references', data.id))
        c.file_references.check()
        c.file_references.fail(unexpectedEntity('file_references', data.id))
        return
      }
      const d = digestFileReference(data)
      compareRecordDigest(c, 'file_references', data.id, ev.digest, d.record)
      compareOverflowDigest(c, 'file_references', data.id, ev.overflowDigest, d.overflow)
      // ⑦ snapshot integrity: ownership + full snapshot digest.
      c.file_references.check()
      if (data.blockId !== ev.blockId) {
        c.file_references.fail({
          entity: 'file_references',
          entityId: data.id,
          fieldPath: 'blockId',
          expected: ev.blockId,
          actual: data.blockId,
          code: 'RELATION_MISMATCH'
        })
      } else if (d.record !== ev.digest) {
        c.file_references.fail({
          entity: 'file_references',
          entityId: data.id,
          fieldPath: null,
          expected: ev.digest,
          actual: d.record,
          code: 'FIELD_DIGEST_MISMATCH'
        })
      }
    })
    // Missing file references also fail the snapshot dimension (⑦).
    for (const id of Object.keys(manifest.fileReferences.entries)) {
      if (!fileRefIds.has(id)) {
        c.file_references.check()
        c.file_references.fail(missingEntity('file_references', id))
      }
    }
    this.finishEntitySection(c, 'file_references', manifest.fileReferences, fileRefIds)

    // --- ⑤ topic_segments ----------------------------------------------------
    await this.scanById('topic_segments', SEGMENT_COLUMNS, (row) => {
      const data = topicSegmentFromRow(row as unknown as TopicSegmentRow)
      segmentIds.add(data.id)
      segmentTopicById.set(data.id, data.topicId)
      c.fk_references.check()
      if (!topicIds.has(data.topicId)) {
        c.fk_references.fail(fkBroken('topic_segments', data.id, 'topicId', data.topicId))
      }
      c.id_sets.check()
      const ev = manifest.segments.entries[data.id]
      if (ev === undefined) {
        c.id_sets.fail(unexpectedEntity('topic_segments', data.id))
        return
      }
      const d = digestSegment(data)
      compareRecordDigest(c, 'topic_segments', data.id, ev.digest, d.record)
      compareOverflowDigest(c, 'topic_segments', data.id, ev.overflowDigest, d.overflow)
      c.relations.check()
      if (data.topicId !== ev.topicId) {
        c.relations.fail({
          entity: 'topic_segments',
          entityId: data.id,
          fieldPath: 'topicId',
          expected: ev.topicId,
          actual: data.topicId,
          code: 'RELATION_MISMATCH'
        })
      }
    })
    this.finishEntitySection(c, 'topic_segments', manifest.segments, segmentIds)

    // --- ⑥ topic_segment_messages -------------------------------------------
    const targetMembership = new Map<string, string[]>()
    let membershipRowCount = 0
    await this.scanMemberships((row) => {
      membershipRowCount += 1
      c.fk_references.check()
      if (!segmentIds.has(row.segment_id)) {
        c.fk_references.fail(fkBroken('topic_segment_messages', row.segment_id, 'segmentId', row.segment_id))
      }
      c.fk_references.check()
      if (!messageIds.has(row.message_id)) {
        c.fk_references.fail(fkBroken('topic_segment_messages', row.segment_id, 'messageId', row.message_id))
      }
      // segment→message topic consistency (⑥).
      c.relations.check()
      const segTopic = segmentTopicById.get(row.segment_id) ?? null
      const msgTopic = messageTopicById.get(row.message_id) ?? null
      if (segTopic === null || msgTopic === null || segTopic !== msgTopic) {
        c.relations.fail({
          entity: 'topic_segment_messages',
          entityId: row.segment_id,
          fieldPath: 'messageId',
          expected: segTopic,
          actual: msgTopic,
          code: 'RELATION_MISMATCH'
        })
      }
      const list = targetMembership.get(row.segment_id)
      if (list === undefined) {
        targetMembership.set(row.segment_id, [row.message_id])
      } else {
        list.push(row.message_id)
      }
    })

    // ⑧ segment/membership completeness: exact per-segment ordered ID arrays.
    const segmentKeys = new Set<string>([...Object.keys(manifest.memberships.bySegment), ...targetMembership.keys()])
    for (const segmentId of segmentKeys) {
      c.segments.check()
      const expected = manifest.memberships.bySegment[segmentId] ?? []
      const actual = targetMembership.get(segmentId) ?? []
      if (!stringArraysEqual(expected, actual)) {
        c.segments.fail({
          entity: 'topic_segment_messages',
          entityId: segmentId,
          fieldPath: 'messageIds',
          expected: canonicalDigest([...expected]),
          actual: canonicalDigest(actual),
          code: 'MEMBERSHIP_MISMATCH'
        })
      }
    }
    c.table_counts.check()
    if (membershipRowCount !== manifest.memberships.rowCount) {
      c.table_counts.fail({
        entity: 'topic_segment_messages',
        entityId: null,
        fieldPath: null,
        expected: manifest.memberships.rowCount,
        actual: membershipRowCount,
        code: 'COUNT_MISMATCH'
      })
    }

    // Entity phase fully evaluated → dimensions ①–⑩ are decided.
    for (const dimension of [
      'id_sets',
      'table_counts',
      'field_digests',
      'order',
      'fk_references',
      'relations',
      'file_references',
      'segments',
      'structured_json',
      'overflow'
    ] as const) {
      c[dimension].complete()
    }
  }

  /** Missing-ID + per-table count comparison against one manifest section. */
  private finishEntitySection(
    c: CollectorMap,
    entity: string,
    section: ManifestEntitySection<unknown>,
    seen: Set<string>
  ): void {
    for (const id of Object.keys(section.entries)) {
      if (!seen.has(id)) {
        c.id_sets.check()
        c.id_sets.fail(missingEntity(entity, id))
      }
    }
    c.table_counts.check()
    if (seen.size !== section.count) {
      c.table_counts.fail({
        entity,
        entityId: null,
        fieldPath: null,
        expected: section.count,
        actual: seen.size,
        code: 'COUNT_MISMATCH'
      })
    }
  }

  // -------------------------------------------------------------------------
  // Dimensions ⑪/⑫ — SQLite PRAGMA checks
  // -------------------------------------------------------------------------

  private runIntegrityCheck(c: CollectorMap): void {
    const rows = this.requireHandle().pragma('integrity_check') as Record<string, unknown>[]
    c.integrity_check.check()
    const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok'
    if (!ok) {
      // Raw integrity_check text may reference internal structures — only
      // the finding count is reported (LOCK-4304).
      c.integrity_check.fail({
        entity: 'candidate_db',
        entityId: null,
        fieldPath: null,
        expected: 'ok',
        actual: rows.length,
        code: 'INTEGRITY_CHECK_FAILED'
      })
    }
    c.integrity_check.complete()
  }

  private runForeignKeyCheck(c: CollectorMap): void {
    const rows = this.requireHandle().pragma('foreign_key_check') as Array<{
      table?: unknown
      rowid?: unknown
      parent?: unknown
    }>
    c.foreign_key_check.check()
    for (const row of rows) {
      c.foreign_key_check.fail({
        entity: typeof row.table === 'string' ? row.table : 'unknown_table',
        entityId: row.rowid === null || row.rowid === undefined ? null : String(row.rowid),
        fieldPath: null,
        expected: typeof row.parent === 'string' ? row.parent : null,
        actual: null,
        code: 'FOREIGN_KEY_CHECK_VIOLATION'
      })
    }
    c.foreign_key_check.complete()
  }

  // -------------------------------------------------------------------------
  // Dimension ⑬ — deterministic repository-level sample reads
  // -------------------------------------------------------------------------

  private async runSampleReads(c: CollectorMap): Promise<void> {
    const sqlite = this.requireHandle()
    const db = drizzle(sqlite, { schema })
    const aggregate = new ChatDbAggregateService(db)
    const repositories = createRepositories(db)
    const manifest = this.manifest

    const expectedMessagesByTopic = buildExpectedMessageOrder(manifest)
    const expectedBlocksByMessage = buildExpectedBlockOrder(manifest)

    // Deterministic sample: evenly spaced IDs over the sorted manifest set.
    const sampledTopics = sampleEvenly(Object.keys(manifest.topics.entries).sort(), this.sampleCount)
    for (const topicId of sampledTopics) {
      await this.checkpoint()
      c.sample_reads.check()
      let result: ReturnType<ChatDbAggregateService['getRawTopic']>
      try {
        result = aggregate.getRawTopic(topicId)
      } catch (error) {
        c.sample_reads.fail(sampleReadFailed('topics', topicId, safeErrorCode(error)))
        continue
      }
      if (!result.ok) {
        c.sample_reads.fail(sampleReadFailed('topics', topicId, result.error.code))
        continue
      }
      if (result.value === null) {
        c.sample_reads.fail({
          entity: 'topics',
          entityId: topicId,
          fieldPath: null,
          expected: 'found',
          actual: null,
          code: 'SAMPLE_READ_MISMATCH'
        })
        continue
      }
      const actualMessageIds = result.value.messages.map((m) => m.id as string)
      const expectedMessageIds = expectedMessagesByTopic.get(topicId) ?? []
      if (!stringArraysEqual(expectedMessageIds, actualMessageIds)) {
        c.sample_reads.fail({
          entity: 'topics',
          entityId: topicId,
          fieldPath: 'messages',
          expected: canonicalDigest(expectedMessageIds),
          actual: canonicalDigest(actualMessageIds),
          code: 'SAMPLE_READ_MISMATCH'
        })
        continue
      }
      for (const message of result.value.messages) {
        const messageId = message.id as string
        const actualBlockIds = Array.isArray(message.blocks) ? (message.blocks as string[]) : []
        const expectedBlockIds = expectedBlocksByMessage.get(messageId) ?? []
        c.sample_reads.check()
        if (!stringArraysEqual(expectedBlockIds, actualBlockIds)) {
          c.sample_reads.fail({
            entity: 'messages',
            entityId: messageId,
            fieldPath: 'blocks',
            expected: canonicalDigest(expectedBlockIds),
            actual: canonicalDigest(actualBlockIds),
            code: 'SAMPLE_READ_MISMATCH'
          })
        }
      }
    }

    // Segment membership sample through the existing repository read path.
    const sampledSegments = sampleEvenly(Object.keys(manifest.memberships.bySegment).sort(), this.sampleCount)
    for (const segmentId of sampledSegments) {
      await this.checkpoint()
      c.sample_reads.check()
      let actualIds: string[]
      try {
        actualIds = repositories.segments.getMessageIds(segmentId)
      } catch (error) {
        c.sample_reads.fail(sampleReadFailed('topic_segments', segmentId, safeErrorCode(error)))
        continue
      }
      const expectedIds = manifest.memberships.bySegment[segmentId] ?? []
      if (!stringArraysEqual(expectedIds, actualIds)) {
        c.sample_reads.fail({
          entity: 'topic_segments',
          entityId: segmentId,
          fieldPath: 'messageIds',
          expected: canonicalDigest([...expectedIds]),
          actual: canonicalDigest(actualIds),
          code: 'SAMPLE_READ_MISMATCH'
        })
      }
    }

    c.sample_reads.complete()
  }

  // -------------------------------------------------------------------------
  // Dimension ⑭ — derived FTS/normalized search projection (LOCK-SP-1..4)
  // -------------------------------------------------------------------------

  /**
   * Required migration-003 derived objects (LOCK-FTS-2 single source: names
   * come from the migration constants, never duplicated strings).
   */
  private readonly SEARCH_PROJECTION_OBJECTS: ReadonlyArray<{
    readonly name: string
    readonly type: 'table' | 'index' | 'trigger'
  }> = [
    { name: MESSAGE_BLOCKS_NORMALIZED_TABLE, type: 'table' },
    { name: MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX, type: 'index' },
    { name: MESSAGE_BLOCKS_FTS_TABLE, type: 'table' },
    { name: MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER, type: 'trigger' },
    { name: MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER, type: 'trigger' },
    { name: MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER, type: 'trigger' }
  ]

  /**
   * LOCK-SP-2/3/4: full readonly, deterministic check of the derived search
   * projection:
   *   1. exact sqlite_master object inventory (table/index/FTS/3 triggers);
   *   2. count parity: canonical predicate vs normalized vs FTS;
   *   3. canonical↔normalized merge scan: message_id parity + normalized
   *      content parity vs JS-side `normalizeSearchText(canonical content)`
   *      (LOCK-SP-6 — no function registration, no DB writes);
   *   4. EXACT FTS↔normalized multiset parity: both projections streamed in
   *      the same deterministic order and merged row-by-row with the
   *      injective length-prefixed key (length(block_id), block_id,
   *      length(normalized_content), normalized_content) — no hashing, so
   *      duplicates, NUL bytes and prefix-framing collisions are detected
   *      exactly (LOCK-SP-2); bounded chunked scans (O(chunk) memory, cursor
   *      index buffering, one bounded SQLite temp sort on the FTS side —
   *      LOCK-SP-3);
   *   5. LOCK-SP-4: fixed synthetic MATCH smoke proving FTS MATCH executes.
   *
   * Every chunk boundary honors the abort/close checkpoint (LOCK-4303).
   * Unexpected query errors inside this dimension (e.g. a corrupted FTS that
   * throws on MATCH) are recorded as one bounded READ_FAILED/SMOKE_FAILED
   * diagnostic and stop the remaining sub-checks — the derived-object
   * corruption is an expected verification failure class, never a fatal.
   * Diagnostics carry fixed codes, counts, schema object names, and allowed
   * entity IDs only (LOCK-SP-3, LOCK-PRIV).
   */
  private async runSearchProjectionCheck(c: CollectorMap): Promise<void> {
    const sqlite = this.requireHandle()
    try {
      // ---- 1. Object inventory (sqlite_master) ---------------------------
      const objects = this.SEARCH_PROJECTION_OBJECTS
      const placeholders = objects.map(() => '?').join(',')
      const master = new Map(
        (
          sqlite
            .prepare(`SELECT name, type FROM sqlite_master WHERE name IN (${placeholders})`)
            .all(...objects.map((o) => o.name)) as Array<{ name: string; type: string }>
        ).map((r) => [r.name, r.type])
      )
      for (const obj of objects) {
        c.search_projection.check()
        if (master.get(obj.name) !== obj.type) {
          c.search_projection.fail({
            entity: 'sqlite_master',
            entityId: null,
            fieldPath: null,
            expected: obj.name,
            actual: master.get(obj.name) ?? null,
            code: 'SEARCH_PROJECTION_OBJECT_MISSING'
          })
        }
      }

      // ---- 2. Count parity ------------------------------------------------
      const countOf = (sql: string): number => {
        const row = sqlite.prepare(sql).get() as { n: unknown }
        return typeof row.n === 'number' ? row.n : -1
      }
      const canonicalCount = countOf(
        `SELECT COUNT(*) AS n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL`
      )
      const normalizedCount = countOf(`SELECT COUNT(*) AS n FROM message_blocks_normalized`)
      const ftsCount = countOf(`SELECT COUNT(*) AS n FROM message_blocks_fts`)
      c.search_projection.check()
      if (canonicalCount !== normalizedCount) {
        c.search_projection.fail({
          entity: MESSAGE_BLOCKS_NORMALIZED_TABLE,
          entityId: null,
          fieldPath: null,
          expected: canonicalCount,
          actual: normalizedCount,
          code: 'SEARCH_PROJECTION_COUNT_MISMATCH'
        })
      }
      c.search_projection.check()
      if (canonicalCount !== ftsCount) {
        c.search_projection.fail({
          entity: MESSAGE_BLOCKS_FTS_TABLE,
          entityId: null,
          fieldPath: null,
          expected: canonicalCount,
          actual: ftsCount,
          code: 'SEARCH_PROJECTION_COUNT_MISMATCH'
        })
      }

      // ---- 3. Canonical↔normalized merge scan (message_id + content
      //      parity, LOCK-SP-6) --------------------------------------------
      const canonicalCursor = this.scanProjectionRows(
        sqlite,
        'message_blocks',
        `id, message_id, content`,
        'id',
        `WHERE type = 'main_text' AND content IS NOT NULL`
      )
      const normalizedCursor = this.scanProjectionRows(
        sqlite,
        MESSAGE_BLOCKS_NORMALIZED_TABLE,
        'block_id, message_id, normalized_content',
        'block_id',
        ''
      )
      let canon = await canonicalCursor.next()
      let norm = await normalizedCursor.next()
      while (canon !== null) {
        while (norm !== null && norm.block_id < canon.id) {
          c.search_projection.check()
          c.search_projection.fail({
            entity: MESSAGE_BLOCKS_NORMALIZED_TABLE,
            entityId: norm.block_id,
            fieldPath: null,
            expected: 'canonical-source-row',
            actual: null,
            code: 'SEARCH_PROJECTION_ROW_UNEXPECTED'
          })
          norm = await normalizedCursor.next()
        }
        if (norm !== null && norm.block_id === canon.id) {
          c.search_projection.check()
          if (norm.message_id !== canon.message_id) {
            c.search_projection.fail({
              entity: MESSAGE_BLOCKS_NORMALIZED_TABLE,
              entityId: canon.id,
              fieldPath: 'message_id',
              expected: canon.message_id,
              actual: norm.message_id,
              code: 'SEARCH_PROJECTION_MESSAGE_ID_MISMATCH'
            })
          }
          c.search_projection.check()
          if (norm.normalized_content !== normalizeSearchText(String(canon.content))) {
            // No content-derived evidence (LOCK-SP-3): fixed tokens only.
            c.search_projection.fail({
              entity: MESSAGE_BLOCKS_NORMALIZED_TABLE,
              entityId: canon.id,
              fieldPath: 'normalized_content',
              expected: 'match',
              actual: 'differ',
              code: 'SEARCH_PROJECTION_CONTENT_MISMATCH'
            })
          }
          norm = await normalizedCursor.next()
        } else {
          c.search_projection.check()
          c.search_projection.fail({
            entity: MESSAGE_BLOCKS_NORMALIZED_TABLE,
            entityId: canon.id,
            fieldPath: null,
            expected: 'projection-row',
            actual: null,
            code: 'SEARCH_PROJECTION_ROW_MISSING'
          })
        }
        canon = await canonicalCursor.next()
      }
      while (norm !== null) {
        c.search_projection.check()
        c.search_projection.fail({
          entity: MESSAGE_BLOCKS_NORMALIZED_TABLE,
          entityId: norm.block_id,
          fieldPath: null,
          expected: 'canonical-source-row',
          actual: null,
          code: 'SEARCH_PROJECTION_ROW_UNEXPECTED'
        })
        norm = await normalizedCursor.next()
      }

      // ---- 4. Exact FTS↔normalized multiset parity (LOCK-SP-2/3) ----------
      // Both projections are streamed in the SAME deterministic order
      // (block_id, normalized_content under SQLite BINARY collation) and
      // merged row-by-row with the injective length-prefixed key. The
      // normalized side is scanned by its block_id primary key (index
      // keyset, O(log n + chunk) per chunk); the FTS side is streamed from a
      // single ORDER BY statement (one bounded SQLite temp sort — external
      // sort, never a quadratic keyset re-scan) via a bounded chunk buffer
      // with cursor indexing. Duplicates and NUL bytes survive because
      // equality compares actual row bytes, never a hash.
      const normalizedParityCursor = this.scanNormalizedProjectionRows(sqlite)
      const ftsParityCursor = this.scanFtsProjectionRows(sqlite)
      let projNorm = await normalizedParityCursor.next()
      let projFts = await ftsParityCursor.next()
      let normalizedMergeRows = 0
      let ftsMergeRows = 0
      let parityFailed = false
      while (projNorm !== null || projFts !== null) {
        // Const locals so control-flow analysis can narrow each row. The
        // loop condition guarantees at least one side is non-null, so inside
        // each null branch the other side is non-null.
        const normRow = projNorm
        const ftsRow = projFts
        if (normRow === null) {
          // FTS row has no normalized counterpart (extra in FTS).
          const extraFts = ftsRow as ProjectionRow
          c.search_projection.check()
          c.search_projection.fail({
            entity: MESSAGE_BLOCKS_FTS_TABLE,
            entityId: extraFts.block_id,
            fieldPath: null,
            expected: 'normalized-row',
            actual: null,
            code: 'SEARCH_PROJECTION_ROW_UNEXPECTED'
          })
          parityFailed = true
          ftsMergeRows += 1
          projFts = await ftsParityCursor.next()
          continue
        }
        if (ftsRow === null) {
          // Normalized row has no FTS counterpart (missing from FTS).
          c.search_projection.check()
          c.search_projection.fail({
            entity: MESSAGE_BLOCKS_NORMALIZED_TABLE,
            entityId: normRow.block_id,
            fieldPath: null,
            expected: 'fts-row',
            actual: null,
            code: 'SEARCH_PROJECTION_ROW_MISSING'
          })
          parityFailed = true
          normalizedMergeRows += 1
          projNorm = await normalizedParityCursor.next()
          continue
        }
        const cmp = compareProjectionRows(normRow, ftsRow)
        if (cmp === 0) {
          c.search_projection.check()
          normalizedMergeRows += 1
          ftsMergeRows += 1
          projNorm = await normalizedParityCursor.next()
          projFts = await ftsParityCursor.next()
        } else if (cmp < 0) {
          c.search_projection.check()
          c.search_projection.fail({
            entity: MESSAGE_BLOCKS_NORMALIZED_TABLE,
            entityId: normRow.block_id,
            fieldPath: null,
            expected: 'fts-row',
            actual: null,
            code: 'SEARCH_PROJECTION_ROW_MISSING'
          })
          parityFailed = true
          normalizedMergeRows += 1
          projNorm = await normalizedParityCursor.next()
        } else {
          c.search_projection.check()
          c.search_projection.fail({
            entity: MESSAGE_BLOCKS_FTS_TABLE,
            entityId: ftsRow.block_id,
            fieldPath: null,
            expected: 'normalized-row',
            actual: null,
            code: 'SEARCH_PROJECTION_ROW_UNEXPECTED'
          })
          parityFailed = true
          ftsMergeRows += 1
          projFts = await ftsParityCursor.next()
        }
      }
      // Exact multiset count parity from the merge itself (belt-and-suspenders
      // with the COUNT(*) checks above; duplicates change no total).
      c.search_projection.check()
      if (normalizedMergeRows !== ftsMergeRows) {
        c.search_projection.fail({
          entity: MESSAGE_BLOCKS_FTS_TABLE,
          entityId: null,
          fieldPath: null,
          expected: normalizedMergeRows,
          actual: ftsMergeRows,
          code: 'SEARCH_PROJECTION_COUNT_MISMATCH'
        })
        parityFailed = true
      }
      // Aggregate parity evidence: fixed counts only (LOCK-SP-3/LOCK-PRIV).
      if (parityFailed) {
        c.search_projection.check()
        c.search_projection.fail({
          entity: MESSAGE_BLOCKS_FTS_TABLE,
          entityId: null,
          fieldPath: null,
          expected: normalizedMergeRows,
          actual: ftsMergeRows,
          code: 'SEARCH_PROJECTION_FTS_MISMATCH'
        })
      }

      // ---- 5. Fixed synthetic MATCH smoke (LOCK-SP-4) ---------------------
      c.search_projection.check()
      try {
        const rows = sqlite
          .prepare(`SELECT block_id FROM ${MESSAGE_BLOCKS_FTS_TABLE} WHERE ${MESSAGE_BLOCKS_FTS_TABLE} MATCH ?`)
          .all(FTS_SMOKE_TOKEN)
        if (!Array.isArray(rows)) {
          c.search_projection.fail({
            entity: MESSAGE_BLOCKS_FTS_TABLE,
            entityId: null,
            fieldPath: null,
            expected: 'MATCH-executed',
            actual: null,
            code: 'SEARCH_PROJECTION_SMOKE_FAILED'
          })
        }
      } catch (error) {
        // LOCK-SP-3: fixed code + safe machine code only. A cooperative
        // abort/close is NOT a projection failure — rethrow so the run
        // settles as 'aborted' (LOCK-4303).
        if (error instanceof VerifierAborted) throw error
        c.search_projection.fail({
          entity: MESSAGE_BLOCKS_FTS_TABLE,
          entityId: null,
          fieldPath: null,
          expected: 'MATCH-executed',
          actual: safeErrorCode(error),
          code: 'SEARCH_PROJECTION_SMOKE_FAILED'
        })
      }
    } catch (error) {
      if (error instanceof VerifierAborted) throw error
      // Bounded single diagnostic for unexpected errors inside the derived
      // projection (fixed code + safe machine code only, LOCK-SP-3/LOCK-PRIV).
      c.search_projection.check()
      c.search_projection.fail({
        entity: 'candidate_db',
        entityId: null,
        fieldPath: null,
        expected: 'ok',
        actual: safeErrorCode(error),
        code: 'SEARCH_PROJECTION_READ_FAILED'
      })
    }
    c.search_projection.complete()
  }

  /**
   * Bounded chunked keyset cursor over one ordered id column (LOCK-SP-3):
   * O(chunkSize) rows in memory at a time, one abort checkpoint per chunk,
   * deterministic keyset pagination (never rowid-dependent), and O(1)
   * buffered reads via a cursor index (no `Array.prototype.shift` — no
   * O(n) queue behavior). Once exhausted it stays exhausted (no repeat
   * queries).
   */
  private scanProjectionRows(
    sqlite: Database.Database,
    table: string,
    columns: string,
    orderColumn: string,
    whereClause: string
  ): { next: () => Promise<Record<string, string> | null> } {
    const where = whereClause.length > 0 ? `${whereClause} AND ` : 'WHERE '
    const first = sqlite.prepare(`SELECT ${columns} FROM ${table} ${whereClause} ORDER BY ${orderColumn} LIMIT ?`)
    const next = sqlite.prepare(
      `SELECT ${columns} FROM ${table} ${where}${orderColumn} > ? ORDER BY ${orderColumn} LIMIT ?`
    )
    let buffer: Record<string, string>[] = []
    let bufferIndex = 0
    let lastKey: string | null = null
    let exhausted = false
    return {
      next: async () => {
        if (bufferIndex >= buffer.length) {
          if (exhausted) return null
          await this.checkpoint()
          buffer =
            (lastKey === null
              ? (first.all(this.chunkSize) as Record<string, string>[])
              : (next.all(lastKey, this.chunkSize) as Record<string, string>[])) ?? []
          bufferIndex = 0
          if (buffer.length === 0) {
            exhausted = true
            return null
          }
          lastKey = buffer[buffer.length - 1][orderColumn]
        }
        const row = buffer[bufferIndex]
        bufferIndex += 1
        return row
      }
    }
  }

  /**
   * Bounded chunked keyset cursor over the normalized projection's PRIMARY
   * KEY (block_id, LOCK-SP-3): index-backed keyset pagination
   * (O(log n + chunk) per chunk — never quadratic), O(chunkSize) rows in
   * memory, cursor-index buffering, one abort checkpoint per chunk. The
   * normalized table's block_id primary key makes `ORDER BY block_id` the
   * SAME order as the FTS stream's `ORDER BY block_id, normalized_content`.
   */
  private scanNormalizedProjectionRows(sqlite: Database.Database): {
    next: () => Promise<ProjectionRow | null>
  } {
    const first = sqlite.prepare(
      `SELECT rowid, block_id, normalized_content FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} ORDER BY block_id LIMIT ?`
    )
    const next = sqlite.prepare(
      `SELECT rowid, block_id, normalized_content FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} WHERE block_id > ? ORDER BY block_id LIMIT ?`
    )
    let buffer: ProjectionRow[] = []
    let bufferIndex = 0
    let lastBlockId: string | null = null
    let exhausted = false
    return {
      next: async () => {
        if (bufferIndex >= buffer.length) {
          if (exhausted) return null
          await this.checkpoint()
          buffer =
            (lastBlockId === null
              ? (first.all(this.chunkSize) as ProjectionRow[])
              : (next.all(lastBlockId, this.chunkSize) as ProjectionRow[])) ?? []
          bufferIndex = 0
          if (buffer.length === 0) {
            exhausted = true
            return null
          }
          lastBlockId = buffer[buffer.length - 1].block_id
        }
        const row = buffer[bufferIndex]
        bufferIndex += 1
        return row
      }
    }
  }

  /**
   * Bounded chunked cursor over the FTS5 virtual table in the SAME
   * deterministic order as the normalized stream (LOCK-SP-2/3). FTS5 has no
   * usable index on the UNINDEXED block_id column, so a single ORDER BY
   * statement is streamed row-by-row via `iterate()`; SQLite performs one
   * bounded external sort (temp b-tree — the spec-permitted external/temp
   * sort; never a quadratic keyset re-scan). Rows are consumed in bounded
   * chunks with cursor-index buffering and one abort checkpoint per chunk.
   */
  private scanFtsProjectionRows(sqlite: Database.Database): {
    next: () => Promise<ProjectionRow | null>
  } {
    const statement = sqlite.prepare(
      `SELECT rowid, block_id, normalized_content FROM ${MESSAGE_BLOCKS_FTS_TABLE} ORDER BY block_id, normalized_content, rowid`
    )
    const iterator = statement.iterate() as IterableIterator<ProjectionRow>
    let buffer: ProjectionRow[] = []
    let bufferIndex = 0
    let exhausted = false
    return {
      next: async () => {
        if (bufferIndex >= buffer.length) {
          if (exhausted) return null
          await this.checkpoint()
          const chunk: ProjectionRow[] = []
          for (let i = 0; i < this.chunkSize; i++) {
            const step = iterator.next()
            if (step.done === true) {
              exhausted = true
              break
            }
            chunk.push(step.value)
          }
          buffer = chunk
          bufferIndex = 0
          if (buffer.length === 0) return null
        }
        const row = buffer[bufferIndex]
        bufferIndex += 1
        return row
      }
    }
  }
}

/** Create a verifier bound to a sealed candidate dbPath + manifest. */
export function createCandidateVerifier(options: CandidateVerifierOptions): CandidateVerifier {
  return new CandidateVerifier(options)
}

// ---------------------------------------------------------------------------
// Diagnostic input helpers (safe structured fields only)
// ---------------------------------------------------------------------------

function unexpectedEntity(entity: string, id: string): Omit<VerificationDiagnosticInput, 'dimension'> {
  return { entity, entityId: id, fieldPath: null, expected: null, actual: id, code: 'UNEXPECTED_ENTITY' }
}

function missingEntity(entity: string, id: string): Omit<VerificationDiagnosticInput, 'dimension'> {
  return { entity, entityId: id, fieldPath: null, expected: id, actual: null, code: 'MISSING_ENTITY' }
}

function fkBroken(
  entity: string,
  id: string,
  fieldPath: string,
  referencedId: string
): Omit<VerificationDiagnosticInput, 'dimension'> {
  return { entity, entityId: id, fieldPath, expected: referencedId, actual: null, code: 'FK_REFERENCE_BROKEN' }
}

function sampleReadFailed(
  entity: string,
  id: string,
  errorCode: string
): Omit<VerificationDiagnosticInput, 'dimension'> {
  return { entity, entityId: id, fieldPath: null, expected: 'ok', actual: errorCode, code: 'SAMPLE_READ_FAILED' }
}

function compareRecordDigest(c: CollectorMap, entity: string, id: string, expected: string, actual: string): void {
  c.field_digests.check()
  if (actual !== expected) {
    c.field_digests.fail({
      entity,
      entityId: id,
      fieldPath: null,
      expected,
      actual,
      code: 'FIELD_DIGEST_MISMATCH'
    })
  }
}

function compareOverflowDigest(c: CollectorMap, entity: string, id: string, expected: string, actual: string): void {
  c.overflow.check()
  if (actual !== expected) {
    c.overflow.fail({
      entity,
      entityId: id,
      fieldPath: 'overflow',
      expected,
      actual,
      code: 'OVERFLOW_DIGEST_MISMATCH'
    })
  }
}

// ---------------------------------------------------------------------------
// Deterministic sampling + expected-order helpers
// ---------------------------------------------------------------------------

function sampleEvenly(sortedIds: readonly string[], count: number): string[] {
  if (sortedIds.length <= count) return [...sortedIds]
  const sampled: string[] = []
  for (let i = 0; i < count; i++) {
    sampled.push(sortedIds[Math.floor((i * sortedIds.length) / count)])
  }
  return sampled
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function buildExpectedMessageOrder(manifest: SourceVerificationManifest): Map<string, string[]> {
  const byTopic = new Map<string, Array<{ id: string; sortOrder: number }>>()
  for (const [id, ev] of Object.entries(manifest.messages.entries)) {
    const list = byTopic.get(ev.topicId)
    if (list === undefined) {
      byTopic.set(ev.topicId, [{ id, sortOrder: ev.sortOrder }])
    } else {
      list.push({ id, sortOrder: ev.sortOrder })
    }
  }
  const ordered = new Map<string, string[]>()
  for (const [topicId, entries] of byTopic) {
    entries.sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id < b.id ? -1 : 1))
    ordered.set(
      topicId,
      entries.map((e) => e.id)
    )
  }
  return ordered
}

function buildExpectedBlockOrder(manifest: SourceVerificationManifest): Map<string, string[]> {
  const byMessage = new Map<string, Array<{ id: string; sortOrder: number }>>()
  for (const [id, ev] of Object.entries(manifest.blocks.entries)) {
    const list = byMessage.get(ev.messageId)
    if (list === undefined) {
      byMessage.set(ev.messageId, [{ id, sortOrder: ev.sortOrder }])
    } else {
      list.push({ id, sortOrder: ev.sortOrder })
    }
  }
  const ordered = new Map<string, string[]>()
  for (const [messageId, entries] of byMessage) {
    entries.sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id < b.id ? -1 : 1))
    ordered.set(
      messageId,
      entries.map((e) => e.id)
    )
  }
  return ordered
}
