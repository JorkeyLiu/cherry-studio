/**
 * Candidate data plane for the ChatImport pipeline (Phase 4.2).
 *
 * Converts validated Phase 4.1 {@link ReadPageResponse} pages into exact
 * target domain rows and writes each page as one atomic candidate DB
 * transaction through `createImportWriter(tx)`.
 *
 * Responsibilities:
 * - Strict source validation with contextual errors (table, page index, id).
 * - Canonical topic projection (id/messages/deletedAt only — LOCK-D2).
 * - Embedded-message projection with array-index sortOrder (LOCK-D3) and
 *   outer-topic ownership canonicalization (LOCK-OWN-1): a PRESENT valid
 *   non-empty `message.topicId` that differs from the outer `topic.id` is
 *   canonicalized to the outer topic on the projected MessageData. Missing/
 *   empty/wrong-type topicId still reject, and every other ownership/
 *   identity validation (duplicate IDs, block owner, segment membership,
 *   file-reference derivation) stays strict. Normalizations are counted
 *   Main-only and aggregated exactly once by the orchestrator (LOCK-OWN-2)
 *   — never warned per message, never with IDs/content/source values.
 * - Streaming relation indexes: messageId→topicId and
 *   blockId→{messageId, sortOrder, seen} (LOCK-D4).
 * - Block projection with parent-index sortOrder and file-reference
 *   derivation via `projectFileReferences` (LOCK-D5), plus unreachable
 *   orphan canonicalization (LOCK-BLOCK-1): a source `message_blocks` row
 *   is skipped at the projection boundary iff its block id appears in NO
 *   imported message.blocks[] registry AND its claimed `messageId` exists
 *   in NO imported message. Skipped rows produce no target rows, file
 *   references, manifest evidence, writer inserts, or seen markers; they
 *   are counted Main-only and aggregated exactly once by the orchestrator
 *   (LOCK-BLOCK-2) — never warned with IDs/content/source values. A row
 *   claiming an EXISTING message stays a strict OWNERSHIP_MISMATCH, and
 *   duplicate source block ids across all rows/pages (imported and
 *   skipped) still reject via a transactional source-seen registry.
 * - Segment/membership projection with ownership checks (LOCK-D6).
 * - `files` pages as validated count-diagnostics only (LOCK-D7).
 * - One outer transaction per page; all-or-nothing (LOCK-D8).
 * - Stats accounting for committed rows/pages only (LOCK-D9).
 * - finalize() rejection of referenced-but-missing blocks and
 *   non-aliased stats snapshots (LOCK-D10).
 * - Source verification evidence (Phase 4.3.1, LOCK-4301): manifest deltas
 *   staged from the target-equivalent StagedPage projections and committed
 *   only after the page transaction succeeds; the deep-frozen manifest is
 *   exposed Main-only via getSourceVerificationManifest() after finalize().
 *
 * Boundaries (LOCK-D11):
 * - Main-only. Receives an already initialized Drizzle candidate DB.
 * - Does NOT create/seal/discard candidate resources, does NOT touch the
 *   live DB, and does NOT perform IPC/state orchestration or Phase 4.3
 *   integrity verification.
 */

import type {
  FileReferenceData,
  MessageBlockData,
  MessageData,
  TopicData,
  TopicSegmentData
} from '@main/services/chatDb/domain/types'
import { createImportWriter } from '@main/services/chatDb/repository/ImportWriter'
import { projectFileReferences, wireToBlock, wireToMessage } from '@main/services/chatDb/wireAdapters'
import type { JsonObject } from '@shared/chatDb'
import { validateJsonObject, ValidationError } from '@shared/chatDb/validation'
import type { CandidateImportStats, ReadPageResponse, SourceReadStats } from '@shared/chatImport/types'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { SourceVerificationManifest } from './verification/sourceManifest'
import { SourceVerificationManifestBuilder } from './verification/sourceManifest'

// ---------------------------------------------------------------------------
// Entity order contract (LOCK-D1)
// ---------------------------------------------------------------------------

/** Source entities in their mandatory arrival order (LOCK-D1). */
export const IMPORT_ENTITY_ORDER = ['topics', 'message_blocks', 'topic_segments', 'files'] as const

export type ImportEntityName = (typeof IMPORT_ENTITY_ORDER)[number]

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type ImportDataPlaneErrorCode =
  | 'UNKNOWN_TABLE'
  | 'ENTITY_ORDER_VIOLATION'
  | 'INVALID_ROW'
  | 'DUPLICATE_RELATION'
  | 'OWNERSHIP_MISMATCH'
  | 'MISSING_BLOCKS'
  | 'FINALIZED'
  | 'NOT_FINALIZED'

/**
 * Rejection raised by the data plane. Carries a machine-readable code plus
 * table/entity context for diagnostics. Messages contain only source IDs —
 * never filesystem paths.
 */
export class ChatImportDataPlaneError extends Error {
  readonly code: ImportDataPlaneErrorCode
  readonly tableName: string | null
  readonly entityId: string | null

  constructor(code: ImportDataPlaneErrorCode, detail: string, context?: { tableName?: string; entityId?: string }) {
    super(`Import data-plane rejection (${code}): ${detail}`)
    this.name = 'ChatImportDataPlaneError'
    this.code = code
    this.tableName = context?.tableName ?? null
    this.entityId = context?.entityId ?? null
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Main-only normalization accounting (LOCK-OWN-1/2, LOCK-BLOCK-1/2).
 *
 * Counts ONLY — never IDs, names, message content, paths, or source values.
 * `topicIdNormalizationCount` is the number of PRESENT valid non-empty
 * embedded `message.topicId` values that differed from the authoritative
 * outer `topic.id` and were canonicalized during L2 topic/message
 * projection. `unreachableBlockSkipCount` is the number of source
 * `message_blocks` rows skipped at the projection boundary because their
 * block id was referenced by no imported message AND their claimed
 * `messageId` existed in no imported message (LOCK-BLOCK-1). Both use
 * committed-page semantics (LOCK-D9): the aggregate advances only after a
 * page's candidate transaction commits; a rolled-back or rejected page
 * never leaks its delta. Never exposed over IPC/shared types.
 */
export interface DataPlaneNormalizationStats {
  readonly topicIdNormalizationCount: number
  readonly unreachableBlockSkipCount: number
}

/** Bounded per-block index entry (LOCK-D4). Values kept minimal. */
interface BlockOwnerEntry {
  messageId: string
  sortOrder: number
  seen: boolean
}

/** Segment membership staged for the page transaction. */
interface StagedMembership {
  segmentId: string
  messageIds: string[]
}

/**
 * Fully validated/projected page, plus the relation-index deltas that must
 * only be merged into the streaming indexes after a successful commit.
 */
interface StagedPage {
  topics: TopicData[]
  messages: MessageData[]
  blocks: MessageBlockData[]
  fileReferences: FileReferenceData[]
  segments: TopicSegmentData[]
  memberships: StagedMembership[]
  /** Index deltas (merged post-commit only). */
  newTopicIds: string[]
  newMessageTopics: Array<[string, string]>
  newBlockOwners: Array<[string, BlockOwnerEntry]>
  seenBlockIds: string[]
  newSegmentIds: string[]
  membershipRowCount: number
  /**
   * Every source `message_blocks` row id in this page — imported AND
   * skipped orphans (LOCK-BLOCK-1). Merged post-commit into the separate
   * source-seen registry so duplicate source block rows across all
   * pages (including skipped ones) always reject.
   */
  sourceSeenBlockIds: string[]
  /**
   * Canonicalized embedded-message topicId count staged for this page
   * (LOCK-OWN-1). Merged into the aggregate only on commit, exactly like
   * the relation-index deltas (LOCK-D9).
   */
  topicIdNormalizationCount: number
  /**
   * Unreachable orphan `message_blocks` rows skipped at the projection
   * boundary for this page (LOCK-BLOCK-1). Merged into the aggregate only
   * on commit, exactly like the relation-index deltas (LOCK-D9).
   */
  orphanBlockSkipCount: number
}

function emptyStagedPage(): StagedPage {
  return {
    topics: [],
    messages: [],
    blocks: [],
    fileReferences: [],
    segments: [],
    memberships: [],
    newTopicIds: [],
    newMessageTopics: [],
    newBlockOwners: [],
    seenBlockIds: [],
    newSegmentIds: [],
    membershipRowCount: 0,
    sourceSeenBlockIds: [],
    topicIdNormalizationCount: 0,
    orphanBlockSkipCount: 0
  }
}

// ---------------------------------------------------------------------------
// Field sets
// ---------------------------------------------------------------------------

/** Promoted segment columns; everything else except messageIds → overflow (LOCK-D6). */
const SEGMENT_FIELDS = new Set(['id', 'topicId', 'name', 'createdAt', 'updatedAt'])

// ---------------------------------------------------------------------------
// Row-level validation helpers
// ---------------------------------------------------------------------------

interface RowContext {
  tableName: string
  index: number
  entityId?: string
}

function rowLabel(ctx: RowContext): string {
  return ctx.entityId !== undefined
    ? `${ctx.tableName}[${ctx.index}] (id=${ctx.entityId})`
    : `${ctx.tableName}[${ctx.index}]`
}

function invalidRow(ctx: RowContext, detail: string): ChatImportDataPlaneError {
  return new ChatImportDataPlaneError('INVALID_ROW', `${rowLabel(ctx)}: ${detail}`, {
    tableName: ctx.tableName,
    entityId: ctx.entityId
  })
}

/** Require a plain object; reject arrays/null/primitives. */
function requirePlainObject(value: unknown, ctx: RowContext): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRow(ctx, 'expected a plain object')
  }
  return value as JsonObject
}

/** Require a JSON-safe plain object (contextual wrapper over shared validation). */
function requireJsonSafeObject(value: unknown, ctx: RowContext): JsonObject {
  const obj = requirePlainObject(value, ctx)
  try {
    validateJsonObject(obj, rowLabel(ctx))
  } catch (error) {
    if (error instanceof ValidationError) {
      throw invalidRow(ctx, `not JSON-safe: ${error.message}`)
    }
    throw error
  }
  return obj
}

/** Require a non-empty string field. */
function requireNonEmptyString(obj: JsonObject, field: string, ctx: RowContext): string {
  const value = obj[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidRow(ctx, `field '${field}' must be a non-empty string (got ${describeValue(value)})`)
  }
  return value
}

/** Optional string field: missing/null → null; any other non-string rejects. */
function optionalNullableString(obj: JsonObject, field: string, ctx: RowContext): string | null {
  const value = obj[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw invalidRow(ctx, `field '${field}' must be a string or null (got ${describeValue(value)})`)
  }
  return value
}

/** Unique array of non-empty strings. Empty array allowed. */
function requireUniqueStringArray(value: unknown, field: string, ctx: RowContext): string[] {
  if (!Array.isArray(value)) {
    throw invalidRow(ctx, `field '${field}' must be an array (got ${describeValue(value)})`)
  }
  const seen = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (typeof entry !== 'string' || entry.length === 0) {
      throw invalidRow(ctx, `field '${field}'[${i}] must be a non-empty string (got ${describeValue(entry)})`)
    }
    if (seen.has(entry)) {
      throw invalidRow(ctx, `field '${field}' contains duplicate id '${entry}'`)
    }
    seen.add(entry)
  }
  return value as string[]
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// ---------------------------------------------------------------------------
// ChatImportDataPlane
// ---------------------------------------------------------------------------

/**
 * Streaming page-to-candidate converter. One instance per import session.
 *
 * Usage:
 *   const plane = createImportDataPlane(candidateDrizzleDb)
 *   plane.processPage(pageResponse)   // once per ReadPageResponse
 *   ...
 *   const { sourceReadStats, candidateImportStats } = plane.finalize()
 */
export class ChatImportDataPlane {
  private readonly db: BetterSQLite3Database<any>

  // Streaming relation indexes (LOCK-D4). Values kept minimal.
  private readonly topicIds = new Set<string>()
  private readonly messageTopicById = new Map<string, string>()
  private readonly blockOwnerById = new Map<string, BlockOwnerEntry>()
  private readonly segmentIds = new Set<string>()

  /**
   * Source-seen block id registry (LOCK-BLOCK-1). Records EVERY source
   * `message_blocks` row id observed on a COMMITTED page — imported AND
   * skipped orphans — so duplicate source block rows reject across all
   * rows/pages. Transactional like the relation indexes: merged only after
   * a successful page commit, so a failed page never poisons the registry
   * and a retry of the same rows remains valid.
   */
  private readonly sourceSeenBlockIds = new Set<string>()

  /** Highest entity-order position committed/attempted so far (LOCK-D1). */
  private entityCursor = 0
  private finalized = false

  /**
   * Source verification evidence (LOCK-4301). Deltas are staged from the
   * target-equivalent StagedPage projections and committed ONLY after the
   * page's DB transaction succeeds. Frozen snapshot cached at finalize().
   */
  private readonly manifestBuilder = new SourceVerificationManifestBuilder()
  private sourceManifest: SourceVerificationManifest | null = null

  // Stats accumulators — mutated only after successful page commit (LOCK-D9).
  private readonly sourceStats: SourceReadStats = {
    topicRecordCount: 0,
    blockRecordCount: 0,
    segmentRecordCount: 0,
    sourceFileRecordCount: 0
  }
  private readonly candidateStats: CandidateImportStats = {
    topicCount: 0,
    messageCount: 0,
    blockCount: 0,
    segmentCount: 0,
    segmentMembershipCount: 0,
    fileReferenceCount: 0,
    pageCount: 0,
    elapsedMs: 0
  }

  // Main-only normalization accounting (LOCK-OWN-1/2, LOCK-BLOCK-1/2).
  // Mutated ONLY in commitStaged, after a successful page commit (LOCK-D9
  // semantics) — a rejected/rolled-back page never advances the aggregate.
  // The private shape is deliberately mutable; getNormalizationStats()
  // exposes the readonly {@link DataPlaneNormalizationStats} contract.
  private readonly normalizationStats: {
    topicIdNormalizationCount: number
    unreachableBlockSkipCount: number
  } = {
    topicIdNormalizationCount: 0,
    unreachableBlockSkipCount: 0
  }

  /**
   * @param db  Already initialized Drizzle candidate DB (LOCK-D11). The data
   *            plane never initializes, seals, or discards this resource.
   */
  constructor(db: BetterSQLite3Database<any>) {
    this.db = db
  }

  /**
   * Process one ReadPageResponse as one outer candidate DB transaction
   * (LOCK-D8). Validation is performed before any write; database constraint
   * failures inside the transaction roll back every row of the page.
   *
   * Indexes and stats are updated only after the page commits (LOCK-D9).
   *
   * @throws {ChatImportDataPlaneError} on any validation/ownership rejection.
   */
  processPage(response: ReadPageResponse): void {
    if (this.finalized) {
      throw new ChatImportDataPlaneError('FINALIZED', 'processPage called after finalize()')
    }

    const entity = this.resolveEntity(response.tableName)
    const entityIndex = IMPORT_ENTITY_ORDER.indexOf(entity)
    if (entityIndex < this.entityCursor) {
      throw new ChatImportDataPlaneError(
        'ENTITY_ORDER_VIOLATION',
        `page for '${entity}' arrived after '${IMPORT_ENTITY_ORDER[this.entityCursor]}' pages started; ` +
          `expected order: ${IMPORT_ENTITY_ORDER.join(' → ')}`,
        { tableName: response.tableName }
      )
    }

    // Phase 1 — pure validation + projection. No writes happen before this
    // completes, so any rejection leaves the candidate DB untouched.
    const staged = this.projectPage(entity, response.items)

    // Phase 1b — stage the source-evidence delta from the target-equivalent
    // projections (LOCK-4301). Pure: builder state is untouched, so a
    // failing transaction below simply drops the delta.
    const manifestDelta = this.manifestBuilder.stagePageDelta({
      entity,
      topics: staged.topics,
      messages: staged.messages,
      blocks: staged.blocks,
      fileReferences: staged.fileReferences,
      segments: staged.segments,
      memberships: staged.memberships,
      sourceRowCount: response.items.length
    })

    // Phase 2 — one outer transaction per page (LOCK-D8). No nested
    // transactions; the writer runs directly on the provided executor.
    this.db.transaction((tx) => {
      const writer = createImportWriter(tx as BetterSQLite3Database<any>)
      if (staged.topics.length > 0) writer.insertTopics(staged.topics)
      if (staged.messages.length > 0) writer.insertMessages(staged.messages)
      if (staged.blocks.length > 0) writer.insertBlocks(staged.blocks)
      if (staged.fileReferences.length > 0) writer.insertFileReferences(staged.fileReferences)
      if (staged.segments.length > 0) writer.insertSegments(staged.segments)
      for (const membership of staged.memberships) {
        writer.insertSegmentMembership(membership.segmentId, membership.messageIds)
      }
    })

    // Phase 3 — merge index deltas + stats + evidence only after a
    // successful commit (LOCK-D9, LOCK-4301).
    this.commitStaged(entity, staged, response.items.length)
    this.manifestBuilder.commitPageDelta(manifestDelta)
    this.entityCursor = entityIndex
  }

  /**
   * End-of-stream check (LOCK-D10): rejects any block ID referenced by an
   * imported message that was never observed in a `message_blocks` page.
   *
   * Does NOT run Phase 4.3 integrity/hash verification.
   *
   * @returns Non-aliased stats snapshots.
   * @throws {ChatImportDataPlaneError} code MISSING_BLOCKS when references dangle.
   */
  finalize(): { sourceReadStats: SourceReadStats; candidateImportStats: CandidateImportStats } {
    const missing: string[] = []
    for (const [blockId, entry] of this.blockOwnerById) {
      if (!entry.seen) missing.push(blockId)
    }
    if (missing.length > 0) {
      const preview = missing.slice(0, 10).join(', ')
      const suffix = missing.length > 10 ? `, … (${missing.length} total)` : ''
      throw new ChatImportDataPlaneError(
        'MISSING_BLOCKS',
        `${missing.length} referenced block ID(s) never appeared in message_blocks: ${preview}${suffix}`
      )
    }
    this.finalized = true
    // Freeze the source evidence exactly once (LOCK-4301). The builder's
    // own exact-once guard makes double finalization impossible.
    if (this.sourceManifest === null) {
      this.sourceManifest = this.manifestBuilder.finalize()
    }
    return {
      sourceReadStats: this.getSourceReadStats(),
      candidateImportStats: this.getCandidateImportStats()
    }
  }

  /**
   * Deep-frozen source verification manifest (LOCK-4301). Main-only —
   * never expose over IPC. Available only after a successful finalize();
   * repeated calls return the same frozen snapshot.
   *
   * @throws {ChatImportDataPlaneError} code NOT_FINALIZED before finalize().
   */
  getSourceVerificationManifest(): SourceVerificationManifest {
    if (this.sourceManifest === null) {
      throw new ChatImportDataPlaneError(
        'NOT_FINALIZED',
        'getSourceVerificationManifest called before a successful finalize()'
      )
    }
    return this.sourceManifest
  }

  /** Snapshot of source-read accounting. New object per call (no aliasing). */
  getSourceReadStats(): SourceReadStats {
    return { ...this.sourceStats }
  }

  /** Snapshot of candidate construction accounting. New object per call (no aliasing). */
  getCandidateImportStats(): CandidateImportStats {
    return { ...this.candidateStats }
  }

  /**
   * Snapshot of Main-only normalization accounting (LOCK-OWN-1/2,
   * LOCK-BLOCK-1/2). New object per call (no aliasing). Stable after
   * finalize(): no further commits are possible once the plane is
   * finalized, so the counts can no longer change. Main-only — never
   * expose over IPC.
   */
  getNormalizationStats(): DataPlaneNormalizationStats {
    return { ...this.normalizationStats }
  }

  // -------------------------------------------------------------------------
  // Internals — entity resolution + staged commit
  // -------------------------------------------------------------------------

  private resolveEntity(tableName: string): ImportEntityName {
    if ((IMPORT_ENTITY_ORDER as readonly string[]).includes(tableName)) {
      return tableName as ImportEntityName
    }
    throw new ChatImportDataPlaneError(
      'UNKNOWN_TABLE',
      `unknown source table '${tableName}'; expected one of: ${IMPORT_ENTITY_ORDER.join(', ')}`,
      { tableName }
    )
  }

  private commitStaged(entity: ImportEntityName, staged: StagedPage, sourceRowCount: number): void {
    for (const id of staged.newTopicIds) this.topicIds.add(id)
    for (const [messageId, topicId] of staged.newMessageTopics) this.messageTopicById.set(messageId, topicId)
    for (const [blockId, entry] of staged.newBlockOwners) this.blockOwnerById.set(blockId, entry)
    for (const blockId of staged.seenBlockIds) {
      const entry = this.blockOwnerById.get(blockId)
      if (entry) entry.seen = true
    }
    // Source-seen registry (LOCK-BLOCK-1): committed only after the page
    // transaction succeeded, covering imported AND skipped orphan rows.
    for (const blockId of staged.sourceSeenBlockIds) this.sourceSeenBlockIds.add(blockId)
    for (const id of staged.newSegmentIds) this.segmentIds.add(id)

    // Source-read accounting (LOCK-D9): successful source rows per entity.
    switch (entity) {
      case 'topics':
        this.sourceStats.topicRecordCount += sourceRowCount
        break
      case 'message_blocks':
        this.sourceStats.blockRecordCount += sourceRowCount
        break
      case 'topic_segments':
        this.sourceStats.segmentRecordCount += sourceRowCount
        break
      case 'files':
        this.sourceStats.sourceFileRecordCount += sourceRowCount
        break
    }

    // Candidate accounting: committed target rows only (LOCK-D9).
    this.candidateStats.topicCount += staged.topics.length
    this.candidateStats.messageCount += staged.messages.length
    this.candidateStats.blockCount += staged.blocks.length
    this.candidateStats.segmentCount += staged.segments.length
    this.candidateStats.segmentMembershipCount += staged.membershipRowCount
    this.candidateStats.fileReferenceCount += staged.fileReferences.length
    this.candidateStats.pageCount += 1

    // Normalization accounting (LOCK-OWN-1/2, LOCK-BLOCK-1/2): merge the
    // staged deltas only now that the page transaction committed.
    this.normalizationStats.topicIdNormalizationCount += staged.topicIdNormalizationCount
    this.normalizationStats.unreachableBlockSkipCount += staged.orphanBlockSkipCount
  }

  // -------------------------------------------------------------------------
  // Internals — per-entity projection (pure; no DB access)
  // -------------------------------------------------------------------------

  private projectPage(entity: ImportEntityName, items: JsonObject[]): StagedPage {
    switch (entity) {
      case 'topics':
        return this.projectTopicsPage(items)
      case 'message_blocks':
        return this.projectBlocksPage(items)
      case 'topic_segments':
        return this.projectSegmentsPage(items)
      case 'files':
        return this.projectFilesPage(items)
    }
  }

  /**
   * Topics page (LOCK-D2/D3/D4, LOCK-OWN-1/2):
   * - Accept only id/messages/deletedAt; ignore leaked UI topic metadata.
   * - Extract embedded messages; never store `messages` in topics.extra.
   * - Missing topic name/assistant/timestamps remain null.
   * - Each embedded message: strict required fields, JSON-safe shape,
   *   non-empty-string topicId, sortOrder = array index, existing
   *   wireToMessage/overflow semantics preserved (no inference).
   * - A PRESENT valid non-empty `message.topicId` that differs from the
   *   outer `topic.id` is canonicalized to the outer topic on the projected
   *   MessageData and counted (LOCK-OWN-1). Missing/empty/wrong-type still
   *   reject; the raw JsonObject is never mutated.
   * - message.blocks: unique non-empty IDs registered in the block index.
   */
  private projectTopicsPage(items: JsonObject[]): StagedPage {
    const staged = emptyStagedPage()
    const stagedTopicIds = new Set<string>()
    const stagedMessageIds = new Set<string>()
    const stagedBlockIds = new Set<string>()

    for (let i = 0; i < items.length; i++) {
      const ctx: RowContext = { tableName: 'topics', index: i }
      const raw = requirePlainObject(items[i], ctx)
      const topicId = requireNonEmptyString(raw, 'id', ctx)
      ctx.entityId = topicId

      if (this.topicIds.has(topicId) || stagedTopicIds.has(topicId)) {
        throw new ChatImportDataPlaneError('DUPLICATE_RELATION', `${rowLabel(ctx)}: duplicate topic id '${topicId}'`, {
          tableName: 'topics',
          entityId: topicId
        })
      }

      const deletedAt = optionalNullableString(raw, 'deletedAt', ctx)

      // Canonical projection (LOCK-D2): only id/messages/deletedAt are read.
      // Leaked UI metadata (name, assistantId, timestamps, pinned, …) is
      // deliberately ignored — NOT copied to columns and NOT stored in extra.
      staged.topics.push({
        id: topicId,
        assistantId: null,
        name: null,
        createdAt: null,
        updatedAt: null,
        deletedAt,
        overflow: {}
      })
      stagedTopicIds.add(topicId)
      staged.newTopicIds.push(topicId)

      // Embedded messages (LOCK-D3).
      const rawMessages = raw.messages
      if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
        throw invalidRow(ctx, `field 'messages' must be an array (got ${describeValue(rawMessages)})`)
      }
      const messages = (rawMessages ?? []) as unknown[]

      for (let m = 0; m < messages.length; m++) {
        const msgJson = requireJsonSafeObject(messages[m], {
          tableName: 'topics',
          index: i,
          entityId: `${topicId}.messages[${m}]`
        })
        const messageId = requireNonEmptyString(msgJson, 'id', {
          tableName: 'topics',
          index: i,
          entityId: `${topicId}.messages[${m}]`
        })
        const messageCtx: RowContext = {
          tableName: 'topics',
          index: i,
          entityId: `${topicId}.messages[${m}] ${messageId}`
        }
        requireNonEmptyString(msgJson, 'role', messageCtx)
        requireNonEmptyString(msgJson, 'status', messageCtx)
        requireNonEmptyString(msgJson, 'createdAt', messageCtx)
        // LOCK-OWN-1: retain the STRICT non-empty-string requirement for
        // `topicId` — missing/empty/number/null/object still reject as
        // INVALID_ROW. Only a present valid non-empty string that differs
        // from the authoritative outer topic is normalized (never moved to
        // another topic): it is counted and the projected MessageData is
        // canonicalized to the outer topic below.
        const msgTopicId = requireNonEmptyString(msgJson, 'topicId', messageCtx)
        if (msgTopicId !== topicId) {
          staged.topicIdNormalizationCount += 1
        }
        if (this.messageTopicById.has(messageId) || stagedMessageIds.has(messageId)) {
          throw new ChatImportDataPlaneError(
            'DUPLICATE_RELATION',
            `${rowLabel(messageCtx)}: duplicate message id '${messageId}'`,
            { tableName: 'topics', entityId: messageId }
          )
        }

        // Block relationship registration (LOCK-D4).
        const blockIds = requireUniqueStringArray(msgJson.blocks, 'blocks', messageCtx)
        for (let b = 0; b < blockIds.length; b++) {
          const blockId = blockIds[b]
          if (this.blockOwnerById.has(blockId) || stagedBlockIds.has(blockId)) {
            throw new ChatImportDataPlaneError(
              'DUPLICATE_RELATION',
              `${rowLabel(messageCtx)}: block id '${blockId}' is already claimed by another message`,
              { tableName: 'topics', entityId: blockId }
            )
          }
          stagedBlockIds.add(blockId)
          staged.newBlockOwners.push([blockId, { messageId, sortOrder: b, seen: false }])
        }

        // Existing wire semantics preserve structured model and all unknown
        // message JSON (including `blocks`) in overflow (LOCK-D3).
        const messageData: MessageData = wireToMessage(msgJson)
        // LOCK-OWN-1: the authoritative outer topic is ALWAYS projected —
        // a matching value is a no-op, a valid stale value is canonicalized
        // (never the embedded claim). The raw JsonObject is untouched.
        messageData.topicId = topicId // outer Topic containment is authoritative
        messageData.sortOrder = m // array index is authoritative (LOCK-D3)
        staged.messages.push(messageData)
        stagedMessageIds.add(messageId)
        staged.newMessageTopics.push([messageId, topicId])
      }
    }

    return staged
  }

  /**
   * message_blocks page (LOCK-D5, LOCK-BLOCK-1):
   * - Strict required fields; must match the block-index owner.
   * - Duplicate source block id detection takes precedence: after complete
   *   row validation and BEFORE ownership/orphan classification, a block id
   *   already seen on a committed page or staged on this page rejects as
   *   DUPLICATE_RELATION — even a duplicate that would otherwise classify
   *   as an orphan or an ownership mismatch.
   * - Unreachable orphan canonicalization (LOCK-BLOCK-1): a row whose
   *   block id appears in NO imported message.blocks[] registry AND whose
   *   claimed `messageId` exists in NO imported message is SKIPPED at the
   *   source projection boundary — never staged, never written, never
   *   verified. A row claiming an EXISTING message stays OWNERSHIP_MISMATCH.
   * - sortOrder comes ONLY from the parent message.blocks index.
   * - Unknown/tool/content/file JSON preserved through wireToBlock.
   * - Target file references derived ONLY via projectFileReferences(block).
   */
  private projectBlocksPage(items: JsonObject[]): StagedPage {
    const staged = emptyStagedPage()
    const stagedSourceSeen = new Set<string>()

    for (let i = 0; i < items.length; i++) {
      const baseCtx: RowContext = { tableName: 'message_blocks', index: i }
      const raw = requireJsonSafeObject(items[i], baseCtx)
      const blockId = requireNonEmptyString(raw, 'id', baseCtx)
      const ctx: RowContext = { tableName: 'message_blocks', index: i, entityId: blockId }
      const messageId = requireNonEmptyString(raw, 'messageId', ctx)
      requireNonEmptyString(raw, 'type', ctx)
      requireNonEmptyString(raw, 'status', ctx)
      requireNonEmptyString(raw, 'createdAt', ctx)

      // LOCK-BLOCK-1 precedence: the duplicate source block id gate runs
      // after complete row validation and BEFORE ownership/orphan
      // classification. A duplicate row (committed across pages or staged
      // on this page) always rejects as DUPLICATE_RELATION, even when it
      // would otherwise classify as an orphan or ownership mismatch.
      if (this.sourceSeenBlockIds.has(blockId) || stagedSourceSeen.has(blockId)) {
        throw new ChatImportDataPlaneError(
          'DUPLICATE_RELATION',
          `${rowLabel(ctx)}: duplicate message_blocks row for block '${blockId}'`,
          { tableName: 'message_blocks', entityId: blockId }
        )
      }

      const owner = this.blockOwnerById.get(blockId)
      if (!owner) {
        // LOCK-BLOCK-1 classification: skip only when the block id is
        // referenced by NO imported message AND the claimed messageId
        // exists in NO imported message. A row claiming an EXISTING
        // message is not an orphan — it stays a strict OWNERSHIP_MISMATCH.
        if (this.messageTopicById.has(messageId)) {
          throw new ChatImportDataPlaneError(
            'OWNERSHIP_MISMATCH',
            `${rowLabel(ctx)}: block is not referenced by any imported message`,
            { tableName: 'message_blocks', entityId: blockId }
          )
        }
        // Skip: no target rows, no file references, no manifest evidence,
        // no writer insert, no seen marker — aggregate count only.
        stagedSourceSeen.add(blockId)
        staged.sourceSeenBlockIds.push(blockId)
        staged.orphanBlockSkipCount += 1
        continue
      }
      if (owner.messageId !== messageId) {
        throw new ChatImportDataPlaneError(
          'OWNERSHIP_MISMATCH',
          `${rowLabel(ctx)}: block.messageId '${messageId}' does not match index owner '${owner.messageId}'`,
          { tableName: 'message_blocks', entityId: blockId }
        )
      }

      const blockData: MessageBlockData = wireToBlock(raw)
      blockData.sortOrder = owner.sortOrder // parent index only (LOCK-D5)
      staged.blocks.push(blockData)
      stagedSourceSeen.add(blockId)
      staged.sourceSeenBlockIds.push(blockId)
      staged.seenBlockIds.push(blockId)

      // Target file references derived only via the existing projection.
      const refs = projectFileReferences(blockData)
      for (const ref of refs) staged.fileReferences.push(ref)
    }

    return staged
  }

  /**
   * topic_segments page (LOCK-D6):
   * - Strict required fields; unique non-empty-string messageIds (empty OK).
   * - Segment topic and every membership message ownership must match
   *   previously imported topics/messages.
   * - Segment sortOrder is neutral 0; membership sortOrder is array index.
   * - color/unknown fields preserved in segment overflow; messageIds is
   *   relationship data and is NOT stored in overflow.
   */
  private projectSegmentsPage(items: JsonObject[]): StagedPage {
    const staged = emptyStagedPage()
    const stagedSegmentIds = new Set<string>()

    for (let i = 0; i < items.length; i++) {
      const baseCtx: RowContext = { tableName: 'topic_segments', index: i }
      const raw = requireJsonSafeObject(items[i], baseCtx)
      const segmentId = requireNonEmptyString(raw, 'id', baseCtx)
      const ctx: RowContext = { tableName: 'topic_segments', index: i, entityId: segmentId }
      const topicId = requireNonEmptyString(raw, 'topicId', ctx)
      const name = requireNonEmptyString(raw, 'name', ctx)
      const createdAt = requireNonEmptyString(raw, 'createdAt', ctx)
      const updatedAt = requireNonEmptyString(raw, 'updatedAt', ctx)
      const messageIds = requireUniqueStringArray(raw.messageIds, 'messageIds', ctx)

      if (this.segmentIds.has(segmentId) || stagedSegmentIds.has(segmentId)) {
        throw new ChatImportDataPlaneError(
          'DUPLICATE_RELATION',
          `${rowLabel(ctx)}: duplicate segment id '${segmentId}'`,
          { tableName: 'topic_segments', entityId: segmentId }
        )
      }
      if (!this.topicIds.has(topicId)) {
        throw new ChatImportDataPlaneError(
          'OWNERSHIP_MISMATCH',
          `${rowLabel(ctx)}: segment.topicId '${topicId}' does not match any imported topic`,
          { tableName: 'topic_segments', entityId: segmentId }
        )
      }
      for (let m = 0; m < messageIds.length; m++) {
        const owningTopic = this.messageTopicById.get(messageIds[m])
        if (owningTopic === undefined) {
          throw new ChatImportDataPlaneError(
            'OWNERSHIP_MISMATCH',
            `${rowLabel(ctx)}: messageIds[${m}] '${messageIds[m]}' does not match any imported message`,
            { tableName: 'topic_segments', entityId: segmentId }
          )
        }
        if (owningTopic !== topicId) {
          throw new ChatImportDataPlaneError(
            'OWNERSHIP_MISMATCH',
            `${rowLabel(ctx)}: messageIds[${m}] '${messageIds[m]}' belongs to topic '${owningTopic}', ` +
              `not segment topic '${topicId}'`,
            { tableName: 'topic_segments', entityId: segmentId }
          )
        }
      }

      // Overflow: preserve color and every unknown field; exclude promoted
      // columns and the relationship array (LOCK-D6).
      const overflow: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(raw)) {
        if (SEGMENT_FIELDS.has(key) || key === 'messageIds') continue
        overflow[key] = value
      }

      const segmentData: TopicSegmentData = {
        id: segmentId,
        topicId,
        name,
        createdAt,
        updatedAt,
        sortOrder: 0, // neutral — do not infer collection order (LOCK-D6)
        overflow
      }
      staged.segments.push(segmentData)
      stagedSegmentIds.add(segmentId)
      staged.newSegmentIds.push(segmentId)
      staged.memberships.push({ segmentId, messageIds })
      staged.membershipRowCount += messageIds.length
    }

    return staged
  }

  /**
   * files page (LOCK-D7): validated / count-diagnostic only. Inserts no
   * target rows, never influences fileReferenceCount, and retains no
   * source file payloads.
   */
  private projectFilesPage(items: JsonObject[]): StagedPage {
    for (let i = 0; i < items.length; i++) {
      const ctx: RowContext = { tableName: 'files', index: i }
      const raw = requirePlainObject(items[i], ctx)
      requireNonEmptyString(raw, 'id', ctx)
      // Payload intentionally not retained (LOCK-D7).
    }
    return emptyStagedPage()
  }
}

/**
 * Create a data plane bound to an already initialized Drizzle candidate DB.
 *
 * @param db  Candidate database executor (from CandidateDbResource.getDatabase()).
 */
export function createImportDataPlane(db: BetterSQLite3Database<any>): ChatImportDataPlane {
  return new ChatImportDataPlane(db)
}
