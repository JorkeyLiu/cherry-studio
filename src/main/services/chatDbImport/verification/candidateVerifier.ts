/**
 * Candidate verifier — readonly sealed-candidate verification across the
 * 13 documented dimensions (Phase 4.3.2, LOCK-4301/4302/4303/4304/4305).
 *
 * Given a sealed candidate dbPath and a finalized SourceVerificationManifest,
 * this module reopens the candidate strictly readonly, reconstructs
 * target-equivalent domain records through the existing Drizzle/domain
 * mappers, compares the complete source evidence (IDs, counts, full record
 * digests, orders, relations, file refs, segments/memberships, structured
 * model/tool JSON, overflow), runs both SQLite PRAGMAs, and performs
 * deterministic repository-level sample reads through the existing
 * application read path (ChatDbAggregateService + repositories) bound to
 * the candidate.
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
import { createRepositories } from '@main/services/chatDb/repository/factory'
import * as schema from '@main/services/chatDb/schema'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { canonicalDigest, CanonicalizationError } from './canonicalJson'
import { digestBlock, digestFileReference, digestMessage, digestSegment, digestTopic } from './entityFraming'
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
  /** Rows per query chunk (default 500, min 1). */
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

const DEFAULT_CHUNK_SIZE = 500
const DEFAULT_DIAGNOSTIC_CAP = 25
const DEFAULT_SAMPLE_COUNT = 5

const TOPIC_COLUMNS = 'id, assistant_id, name, created_at, updated_at, deleted_at, extra'
const MESSAGE_COLUMNS =
  'id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra'
const BLOCK_COLUMNS = 'id, message_id, type, content, status, created_at, updated_at, sort_order, extra'
const SEGMENT_COLUMNS = 'id, topic_id, name, created_at, updated_at, sort_order, extra'
const FILE_REFERENCE_COLUMNS = 'id, block_id, file_id, file_name, file_path, file_type, count, extra'

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
    this.chunkSize = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE))
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
