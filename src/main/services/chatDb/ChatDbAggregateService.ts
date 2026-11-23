/**
 * ChatDbAggregateService — implements the complete typed ChatDb command
 * surface (the `ChatDb_*` IPC channels map 1:1 onto its capabilities).
 *
 * Combines the five repositories (topics, messages, blocks,
 * topic_segments, file_references) into a single service that the IPC
 * handlers delegate to.
 *
 * Transaction strategy:
 * - Compound commands create repositories from tx inside root db.transaction().
 * - All repositories in a compound mutation are tx-bound (not root-bound).
 * - Existing nested repository transactions use Drizzle savepoints.
 * - All synchronous work stays within better-sqlite3 transactions; no await.
 * - No per-call SQLite→Dexie fallback.
 * - No implicit init. DB must be initialised before calling any command.
 *
 * SQLite (Data/chat.db) is authoritative for ordinary chat.
 * updateFileCount(s) stays in Dexie/FileManager; not called here.
 */

import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import type {
  AppendDiagnostics,
  AppendMessageResponse,
  BranchCreateSnapshot,
  BranchDeleteSnapshot,
  BranchHistoryBlockRow,
  BranchHistoryFileReferenceRow,
  BranchHistoryMessageRow,
  BranchHistoryRow,
  BranchHistorySegmentRow,
  BranchHistorySegmentStateRow,
  BranchInheritedBoundary,
  BranchMoveSnapshot,
  BranchOperationDirection,
  BranchOperationSnapshot,
  BranchRenameSnapshot,
  ClipboardTreeIdMapRow,
  ClipboardTreeInsertedRows,
  ClipboardTreePayload,
  ClipboardTreePlacement,
  ClipboardTreeProjectionRun,
  ClipboardTreeRouteProjection,
  ClipboardTreeSnapshot,
  ClipboardTreeSourceRemoval,
  CreateReferencedTopicResponse,
  DeleteClipboardTreeRequest,
  DeleteClipboardTreeResponse,
  DeleteMessagesWithDependentsResponse,
  DeleteMessagesWithDependentsRestoreGroup,
  EmptyTrashTopicsResponse,
  ExportTopicDataRequest,
  ExportTopicDataResponse,
  FetchAnswerGroupRequest,
  FetchAnswerGroupResponse,
  FetchClipboardGroupsRequest,
  FetchClipboardGroupsResponse,
  FetchClipboardTreeBranchOwnedRequest,
  FetchClipboardTreeRequest,
  FetchClipboardTreeResponse,
  FetchContextClosureRequest,
  FetchContextClosureResponse,
  FetchMessagesWindowRequest,
  FetchMessagesWindowResponse,
  FetchTopicActivityRequest,
  FetchTopicActivityResponse,
  FetchTopicMessageTimesEntry,
  FetchTopicMessageTimesRequest,
  FetchTopicMessageTimesResponse,
  FetchTopicNamingContextRequest,
  FetchTopicNamingContextResponse,
  FetchWholeTopicSnapshotRequest,
  FetchWholeTopicSnapshotResponse,
  FileCleanupResult,
  FileReferenceWire,
  HardDeleteTopicResponse,
  HistoryReferenceChainLayer,
  HistoryReferenceMeta,
  ImportTopicDataRequest,
  ImportTopicDataResponse,
  InheritanceBoundaryRestoreResult,
  InheritanceBoundarySnapshot,
  InsertMessageGroupsResponse,
  InsertMessagesAfterAnchorResponse,
  JsonObject,
  JsonValue,
  MessageBlockEntry,
  MoveContextAnchorInheritanceInput,
  MoveSourceContextAnchorTransfer,
  PasteClipboardTreeRequest,
  PasteClipboardTreeResponse,
  PurgeExpiredTopicsResponse,
  ReorderAnswerGroupResponse,
  ReplayBranchOperationResponse,
  ReplayClipboardTreeRequest,
  ReplayClipboardTreeResponse,
  ResendAttemptMapping,
  ResetAssistantTopicsResponse,
  ResetMessagesForResendResponse,
  ResolveContextClosureRequest,
  ResolveContextClosureResult,
  SegmentWire,
  SelectAnswerMessageResponse,
  SelectUsefulAnswerResponse,
  SemanticModelSnapshot,
  SemanticResendResponse,
  SetTurnFoldsResponse,
  StreamWriteDiagnostics,
  TopicBranchWire,
  TopicReferenceWire,
  TopicWire
} from '@shared/chatDb'
import type { UpdateMessageResult, UpdateMessageUsageResult, UpdateMessageUsageSource } from '@shared/chatDb'
import type { ChatDbResult } from '@shared/chatDb'
import type { SearchMessagesRequest, SearchMessagesResponse } from '@shared/chatDb'
import type {
  DeleteSegmentRequest,
  ReplaceSegmentMembershipRequest,
  UpdateSegmentMetadataRequest,
  UpsertSegmentRequest
} from '@shared/chatDb'
import { elapsedMs, MAX_APPEND_DIAGNOSTIC_LOGS } from '@shared/diagnostics/sendTiming'
import { isStableBlockStatus, isStableMessageStatus, isUnsupportedBlockForSync } from '@shared/sync'
import { applyTopicSyncDefaults } from '@shared/sync'
import type Database from 'better-sqlite3'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { logMainDiagnostic } from '../diagnostics'
import { spanCacheService } from '../SpanCacheService'
import {
  clearResendAttemptsForTopicInTx,
  clearResendAttemptsInTx,
  getResendAttemptInTx,
  persistResendAttemptInTx,
  type StoredResendAttempt
} from '../sync/syncResendAttempt'
import { SyncFrameError, syncService, type SyncTxExecutor } from '../sync/SyncService'
import { OVERFLOW_REMOVE } from './domain/codec'
import type {
  EntityPatchInput,
  FileReferenceData,
  MessageBlockData,
  MessageData,
  TopicBranchData,
  TopicData,
  TopicReferenceData,
  TopicSegmentData
} from './domain/types'
import { ChatDbConflictError, ChatDbNotFoundError, ChatDbValidationError, wrapResult } from './errors'
import { MAX_BRANCH_DEPTH } from './repository'
import type { ChatDbRepositories } from './repository/factory'
import { createRepositories } from './repository/factory'
import { isOwnedByRoute } from './repository/helpers'
import { createImportWriter } from './repository/ImportWriter'
import { SearchRepository } from './repository/SearchRepository'
import * as schema from './schema'
import {
  buildTopicDataExport,
  planTopicDataImport,
  type TopicDataHistoryPrefixInput,
  validateTopicDataImport
} from './topicDataExchange'
import { computeTrashRetentionDecision, parseStrictCanonicalIsoMs } from './trashRetention'
import {
  blocksToWire,
  buildFileCleanupResult,
  collectAffectedFileIds,
  fileReferenceToWire,
  messagesToWire,
  messageToWire,
  projectFileReferences,
  reconstructMessageBlockRelations,
  segmentToWire,
  topicToWireFull,
  wireToBlock,
  wireToBlockPatch,
  wireToMessage,
  wireToMessagePatch
} from './wireAdapters'

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type FetchMessagesResult = { messages: JsonObject[]; blocks: JsonObject[] }
export type FetchMessagesWindowResult = FetchMessagesWindowResponse
export type FetchAnswerGroupResult = FetchAnswerGroupResponse
export type FetchClipboardGroupsResult = FetchClipboardGroupsResponse
export type FetchClipboardTreeResult = FetchClipboardTreeResponse
export type PasteClipboardTreeResult = PasteClipboardTreeResponse
export type ReplayClipboardTreeResult = ReplayClipboardTreeResponse

/**
 * One included child branch of a clipboard closure, with the depth measured
 * from the source route (1 = direct child).
 */
interface ClipboardTreeClosureBranch {
  data: TopicBranchData
  depth: number
}

/** One fully-contained topic segment of a clipboard closure. */
interface ClipboardTreeClosureSegment {
  data: TopicSegmentData
  memberIds: string[]
}

/**
 * Main-derived clipboard closure: the selected complete groups of the source
 * active route (roots) plus every included child-branch subtree's OWNED rows.
 *
 * `ownedByBranch` follows `branches` order (breadth-first, parents before
 * children) so a restore can insert rows parent-first. `segments` contains only
 * segments whose complete membership is inside `capturedMessages`.
 */
interface ClipboardTreeClosure {
  topicId: string
  branchId: string | null
  resolvedGroups: Array<{ groupId: string; rows: MessageData[] }>
  rootRows: MessageData[]
  ownedRootMessageIds: string[]
  inheritedRootMessageIds: string[]
  branches: ClipboardTreeClosureBranch[]
  ownedByBranch: Array<{ branchId: string; rows: MessageData[] }>
  capturedMessages: MessageData[]
  capturedMessageIds: Set<string>
  segments: ClipboardTreeClosureSegment[]
}

/**
 * Fully-remapped target insert plan shared by the paste and the redo replay:
 * every row already carries its generated ID, target owner, and target order,
 * so ONE insert implementation writes both paths identically.
 */
interface ClipboardTreeInsertPlan {
  targetTopicId: string
  targetRoute: string | null
  placement: ClipboardTreePlacement
  rootRows: MessageData[]
  rootWires: Map<string, JsonObject>
  branches: Array<{ branch: TopicBranchData; rows: MessageData[]; wires: Map<string, JsonObject> }>
  blocks: MessageBlockData[]
  segments: Array<{ row: TopicSegmentData; memberIds: string[] }>
}
export type FetchContextClosureResult = FetchContextClosureResponse
export type FetchWholeTopicSnapshotResult = FetchWholeTopicSnapshotResponse
export type FetchTopicNamingContextResult = FetchTopicNamingContextResponse
export type FetchTopicActivityResult = FetchTopicActivityResponse
export type GetRawTopicResult = { id: string; messages: JsonObject[] } | null

/**
 * Maximum cross-topic reference recursion depth (cycle/depth guard). A chain
 * deeper than this (or a cycle) resolves as 'missing' — the foreign prefix is
 * omitted rather than looping or failing the read.
 */
const MAX_REFERENCE_DEPTH = 32

/**
 * Narrow a clipboard-tree request to its branch-owned capture shape.
 *
 * The discriminant is the exact `capture` field: the selection shape carries
 * `groupIds` instead, so the two capture kinds can never be mixed.
 */
function isBranchOwnedClipboardTreeRequest(
  request: FetchClipboardTreeRequest
): request is FetchClipboardTreeBranchOwnedRequest {
  return (request as { capture?: unknown }).capture === 'branch-owned'
}

/** Result of resolving the foreign reference base of a topic. */
type ReferenceBaseResolution = {
  /** Foreign prefix messages (canonical source rows), empty when none/missing. */
  messages: MessageData[]
  /** The relation row, or null when the topic is not a reference target. */
  reference: TopicReferenceData | null
  status: 'none' | 'available' | 'missing'
}

/**
 * One reference relation materialized inside a resolved foreign prefix.
 *
 * `depth` 0 is the resolved topic's own relation; deeper entries are the
 * relations of its live source route's own read-only history. `boundaryMessageId`
 * is the last message this relation contributes to the flattened prefix, so a
 * divider can be placed truthfully per layer. Accumulated only for available
 * (materialized) relations; a missing relation contributes no layer.
 */
type ReferenceChainPlan = {
  /** Topic that owns the relation (one relation per target topic). */
  targetTopicId: string
  sourceTopicId: string
  sourceBranchId: TopicReferenceData['sourceBranchId']
  anchorMessageId: string
  sourceName: string | null
  boundaryMessageId: string
  depth: number
}

/**
 * Optional provenance accumulator threaded through reference-base resolution.
 * When supplied, it is flagged whenever ANY reference segment in the resolved
 * source chain is missing — including a nested reference deeper than the
 * immediate one (e.g. the immediate source resolves but its own referenced
 * history is gone). Ordinary reads omit it and keep immediate-status-only
 * semantics; the standalone export uses it to disclose an incomplete prefix.
 */
type ReferenceChainMissingFlag = { missing: boolean }

/**
 * Optional addressed route context for block commands. The block channel has
 * no inherent topic context; when the caller knows the addressed route it may
 * carry `topicId`/`branchId` so Main enforces parent ownership against that
 * route (cross-topic foreign prefixes fail closed). Absent = legacy behavior
 * (route resolved from the committed parent row).
 */
export interface BlockRouteContext {
  resendAttemptId?: string
  topicId?: string
  branchId?: string | null
}

// ---------------------------------------------------------------------------
// Conditional usage-estimate source (optional display metadata)
// ---------------------------------------------------------------------------

/**
 * The estimate source of one user prompt, derived from its blocks: the MAIN_TEXT
 * contents and the FILE/IMAGE attachment IDs the local estimator consumes.
 *
 * Both arrays are canonicalized (empty entries dropped, sorted) so the renderer
 * snapshot and the authority rows compare as multisets: block order is a rendering
 * detail and never changes the token total.
 */
function usageSourceOfBlocks(blocks: MessageBlockData[]): UpdateMessageUsageSource {
  const textContents: string[] = []
  const fileIds: string[] = []
  for (const block of blocks) {
    if (block.type === 'main_text') {
      const content = block.content ?? ''
      if (content.length > 0) textContents.push(content)
      continue
    }
    if (block.type !== 'file' && block.type !== 'image') continue
    const fileId = attachmentIdOfBlock(block)
    if (fileId) fileIds.push(fileId)
  }
  return { textContents: textContents.sort(), fileIds: fileIds.sort() }
}

/**
 * Attachment ID of a FILE/IMAGE block row. The renderer persists its
 * `FileMetadata` object at `overflow.file` (with a `fileId` fallback) — the same
 * shape the read adapters resolve, read here without re-deriving metadata.
 */
function attachmentIdOfBlock(block: MessageBlockData): string | null {
  const overflowFile = block.overflow?.file
  if (overflowFile && typeof overflowFile === 'object' && !Array.isArray(overflowFile)) {
    const file = overflowFile as Record<string, unknown>
    const id = file.id ?? file.fileId
    if (typeof id === 'string' && id.length > 0) return id
  }
  const directId = block.overflow?.fileId ?? block.overflow?.file_id
  return typeof directId === 'string' && directId.length > 0 ? directId : null
}

/** Multiset equality of two canonicalized estimate sources. */
function sameUsageSource(a: UpdateMessageUsageSource, b: UpdateMessageUsageSource): boolean {
  if (a.textContents.length !== b.textContents.length) return false
  if (a.fileIds.length !== b.fileIds.length) return false
  for (let i = 0; i < a.textContents.length; i++) {
    if (a.textContents[i] !== b.textContents[i]) return false
  }
  for (let i = 0; i < a.fileIds.length; i++) {
    if (a.fileIds[i] !== b.fileIds[i]) return false
  }
  return true
}

/**
 * Real-instant epoch milliseconds of one message `createdAt`.
 *
 * Mirrors the SQLite normalizer used by the batched per-topic maximum
 * (`cast(round((julianday(created_at) - 2440587.5) * 86400000) as integer)`):
 * an explicit zone (`Z` or `±HH:MM`/`±HHMM`) is honored, and a value with a
 * time component but no zone is read as **UTC** (SQLite's behavior; JS would
 * otherwise read it as local time and diverge by the machine offset).
 * Non-strings, empty values and unparseable values return `null` and simply
 * contribute nothing — no instant is ever fabricated.
 */
function messageCreatedAtMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '') return null
  const hasTimeComponent = /[T ]\d{2}:\d{2}/.test(raw)
  const hasZone = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(raw)
  const candidate = hasTimeComponent && !hasZone ? `${raw.replace(' ', 'T')}Z` : raw
  const parsed = Date.parse(candidate)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Canonical context-window turn derivation over one route's ordered messages.
 *
 * A `system` or `user` message starts a turn keyed by its own ID; an assistant
 * joins the turn named by its `askId`; an assistant whose `askId` names no
 * current turn starts a turn keyed by that `askId` (or by its own ID when
 * `askId` is absent). Ignored roles are skipped. Turn keys are stable message
 * IDs, so the same derivation serves the pre-move source route, the
 * post-move destination route, and index-preserving inheritance between them.
 */
type ContextAnchorTurn = { key: string; messages: MessageData[] }

function buildContextAnchorTurns(rows: MessageData[]): ContextAnchorTurn[] {
  const turns: ContextAnchorTurn[] = []
  let currentKey: string | null = null
  for (const msg of rows) {
    const askId = (msg as unknown as { askId: string | null }).askId
    if (msg.role === 'system' || msg.role === 'user') {
      currentKey = msg.id
      turns.push({ key: currentKey, messages: [msg] })
    } else if (msg.role === 'assistant') {
      if (askId && askId === currentKey) {
        turns[turns.length - 1].messages.push(msg)
      } else {
        currentKey = askId ? askId : msg.id
        turns.push({ key: currentKey, messages: [msg] })
      }
    }
  }
  return turns
}

/**
 * Canonical 3-step group-key match inside one turn list: the user message's
 * own ID, then the assistant `askId` owner, then any non-user message ID.
 * Returns -1 when the key names no turn.
 */
function resolveContextAnchorTurnIndex(turns: ContextAnchorTurn[], groupKey: string): number {
  let idx = turns.findIndex((t) => t.messages.some((m) => m.role === 'user' && m.id === groupKey))
  if (idx !== -1) return idx
  idx = turns.findIndex((t) =>
    t.messages.some((m) => m.role === 'assistant' && (m as unknown as { askId: string | null }).askId === groupKey)
  )
  if (idx !== -1) return idx
  return turns.findIndex((t) => t.messages.some((m) => m.role !== 'user' && m.id === groupKey))
}

/**
 * Default window start index (never a clamp): `null` => the first turn,
 * finite N => `max(0, total - max(1, floor(N)))` — the same position a
 * TokenCount re-anchor uses.
 */
function resolveContextAnchorDefaultIndex(total: number, contextCount: number | null | undefined): number {
  if (total <= 0) return -1
  if (contextCount === null || contextCount === undefined) return 0
  const n = Math.max(1, Math.floor(contextCount))
  return Math.max(0, total - n)
}
/**
 * Project one branch domain row onto the replayable history row shape.
 *
 * History rows are the persisted authority columns plus decoded overflow, so a
 * replay can restore a branch verbatim (identity, ancestry, anchor, metadata)
 * without a journal, a schema change, or a generic write capability.
 */
function toBranchHistoryRow(branch: TopicBranchData): BranchHistoryRow {
  return {
    id: branch.id,
    parentBranchId: branch.parentBranchId ?? null,
    anchorMessageId: branch.anchorMessageId,
    name: branch.name ?? null,
    createdAt: branch.createdAt ?? null,
    updatedAt: branch.updatedAt ?? null,
    // Domain overflow is decoded JSON by construction (decodeJson); the wire
    // contract types it as a JSON object because it round-trips over IPC.
    overflow: (branch.overflow ?? {}) as JsonObject
  }
}

/**
 * Project a persisted message row onto the replay row shape.
 *
 * The repository mapper decodes `messages.extra` into `overflow` and also
 * spreads those same keys inline, so a raw row carries both real columns and
 * arbitrary extra keys. Picking the known columns keeps a history snapshot
 * canonical — the wire contract validates that exact field set, and the restore
 * writes real columns only, with extra keys round-tripping inside `overflow`.
 */
function toMessageHistoryRow(message: MessageData): BranchHistoryMessageRow {
  return {
    id: message.id,
    topicId: message.topicId,
    branchId: message.branchId ?? null,
    role: message.role ?? null,
    content: message.content ?? null,
    status: message.status ?? null,
    askId: message.askId ?? null,
    model: message.model ?? null,
    modelId: message.modelId ?? null,
    assistantId: message.assistantId ?? null,
    createdAt: message.createdAt ?? null,
    updatedAt: message.updatedAt ?? null,
    sortOrder: message.sortOrder,
    overflow: (message.overflow ?? {}) as JsonObject
  }
}

/** Project a persisted block row onto the replay row shape (same rationale). */
function toBlockHistoryRow(block: MessageBlockData): BranchHistoryBlockRow {
  return {
    id: block.id,
    messageId: block.messageId,
    type: block.type ?? null,
    content: block.content ?? null,
    status: block.status ?? null,
    createdAt: block.createdAt ?? null,
    updatedAt: block.updatedAt ?? null,
    sortOrder: block.sortOrder,
    overflow: (block.overflow ?? {}) as JsonObject
  }
}

/** Project a persisted file-reference row onto the replay row shape. */
function toFileReferenceHistoryRow(reference: FileReferenceData): BranchHistoryFileReferenceRow {
  return {
    id: reference.id,
    blockId: reference.blockId,
    fileId: reference.fileId,
    fileName: reference.fileName ?? null,
    filePath: reference.filePath ?? null,
    fileType: reference.fileType ?? null,
    count: reference.count ?? null,
    overflow: (reference.overflow ?? {}) as JsonObject
  }
}

/**
 * Deterministic JSON used by the clipboard-tree compare-and-set guards.
 *
 * Object keys are sorted recursively so two representations of the same stored
 * row (a captured wire DTO and a row read back from SQLite) compare equal
 * regardless of key insertion order.
 */
function clipboardStableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => clipboardStableJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${clipboardStableJson(record[key])}`).join(',')}}`
}
/** Row identities a branch replay wrote (removed or restored). */
type ReplayBranchRows = {
  branchIds: string[]
  messageIds: string[]
}

/** Ordered-owner executor used for the few writes no repository exposes (owner/segment order). */
type RawRowExecutor = {
  update: (table: unknown) => {
    set: (values: unknown) => { where: (cond: unknown) => { run: () => void } }
  }
}

// ---------------------------------------------------------------------------
// ChatDbAggregateService
// ---------------------------------------------------------------------------

export class ChatDbAggregateService {
  constructor(
    private db: BetterSQLite3Database<typeof schema>,
    private sqlite?: Database.Database
  ) {}

  /**
   * Create repositories bound to the root database.
   * Only for read-only or single-statement commands.
   */
  private repos(): ChatDbRepositories {
    return createRepositories(this.db)
  }

  // =========================================================================
  // Transaction-bound sync capture (LOCK-PERSONAL-005/006/010)
  //
  // Supported stable mutations enqueue their sync intent INSIDE the same
  // aggregate Drizzle transaction via SyncService tx-bound helpers (no nested
  // BEGIN). A throw rolls back the enclosing mutation — a committed row
  // without durable outbox intent is impossible. Updates carry only
  // intentional changed allowlisted fields + identity/immutable relation
  // fields (never sortOrder); creates carry the full allowlisted set.
  // After a successful commit the caller wakes automation via notifyEnqueued.
  // =========================================================================

  // =========================================================================
  // Publisher-barrier quiescence gate (SYNC-DATA-026)
  //
  // While SyncService holds the publish barrier, every public aggregate
  // mutation fails here — inside wrapResult so callers observe a truthful
  // failure envelope — before any SQLite transaction opens. Chat rows and
  // outbox intent therefore cannot commit under the barrier (the enclosing
  // aggregate transaction never starts; tx-owned capture is never reached).
  // Remote pull/apply internal writes never enter the aggregate. Supported
  // tx-owned methods reach this gate through syncCtx(); all other mutating
  // methods call it explicitly at entry. Reads never call it.
  // =========================================================================

  /**
   * Capture context acquired OUTSIDE the aggregate tx (deviceId setup is
   * idempotent). Fail-closed (LOCK-PERSONAL-006): when capture is enabled, an
   * infrastructure failure acquiring the context throws (rolls back the
   * enclosing mutation) instead of silently skipping capture (no silent loss).
   * Disabled capture returns null (no intent). Callers record a durable
   * visible capture failure outside the rolled-back tx before propagating.
   *
   * Publisher-barrier quiescence (SYNC-DATA-026) is enforced first: a held
   * barrier throws SyncPublishBarrierError before any transaction opens.
   */
  private syncCtx(channel = 'chatDb'): { deviceId: string; ts: number } | null {
    syncService.throwIfPublishBarrierHeld(channel)
    let enabled = false
    try {
      enabled = syncService.isCaptureEnabled()
    } catch (e) {
      // Cannot prove disabled: fail closed with a durable record, then throw.
      // A capture-error persistence failure (SyncCaptureError) preserves the
      // original message and propagates instead of being swallowed.
      try {
        syncService.recordCaptureFailure(channel, e)
      } catch (secondary) {
        throw secondary instanceof Error ? secondary : new Error(String(secondary))
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
    if (!enabled) return null
    try {
      // Fail closed (LOCK-PERSONAL-001/006): getDeviceId throws on any
      // infrastructure failure (except proven pre-005 compatibility), so an
      // enabled mutation cannot commit without durable device identity.
      return { deviceId: syncService.getDeviceId(), ts: Date.now() }
    } catch (e) {
      try {
        syncService.recordCaptureFailure(channel, e)
      } catch (secondary) {
        throw secondary instanceof Error ? secondary : new Error(String(secondary))
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** True for domain rejections that must never become capture failures. */
  private isDomainRejection(e: unknown): boolean {
    const name = e instanceof Error ? e.constructor.name : ''
    return (
      name === 'ChatDbConflictError' ||
      name === 'ChatDbNotFoundError' ||
      name === 'ChatDbValidationError' ||
      (e instanceof Error && /belongs to topic|cannot reparent|Duplicate block ID/.test(e.message))
    )
  }

  // =========================================================================
  // Local-only resend attempt intent guards (SYNC-DATA-055 intent slice)
  //
  // While an intent is active for a message, writes for that message stay
  // local-only: sync capture (outbox + frame ops) is suppressed in-tx and a
  // supplied non-matching attempt id fails closed. The optional
  // `resendAttemptId` carrier is Main-internal only in this slice — the
  // renderer/preload/IPC contracts are untouched, so legacy callers pass
  // nothing and proceed locally with suppression (full attempt propagation
  // is deferred to the issuer unit). Ordinary messages without an intent
  // are completely unaffected.
  // =========================================================================

  /**
   * Normalize the optional Main-internal attempt carrier. Returns the
   * supplied id when it is a non-empty string, otherwise undefined (legacy
   * caller without attempt identity — allowed locally, sync-suppressed).
   */
  private resendAttemptOf(options?: { resendAttemptId?: string }): string | undefined {
    const v = options?.resendAttemptId
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }

  /**
   * Fail closed on a stale attempt BEFORE any SQLite write transaction
   * opens. Reads intent rows with root-bound reads only (no write tx).
   * Throws ChatDbConflictError when a supplied attempt id does not match
   * the stored intent for any covered message, and when a supplied attempt
   * arrives with no intent but a winning stable-replace register proves the
   * attempt was already consumed (post-issuance duplicate — no second op).
   * Legacy calls without an attempt id pass here and are sync-suppressed
   * inside the tx.
   */
  private assertResendAttemptPreTx(messageIds: string[], attemptId?: string): void {
    const ids = [...new Set(messageIds.filter((id) => typeof id === 'string' && id.length > 0))]
    if (ids.length === 0) return
    for (const mid of ids) {
      let stored: StoredResendAttempt | null
      try {
        stored = getResendAttemptInTx(this.db as unknown as SyncTxExecutor, mid)
      } catch {
        // Intent infrastructure unreadable: fail closed — a write that
        // cannot prove it is not stale must not commit.
        throw new ChatDbConflictError(`resend attempt guard unreadable for message ${mid}`)
      }
      if (stored) {
        if (attemptId !== undefined && attemptId !== stored.attemptId) {
          throw new ChatDbConflictError(`resend attempt mismatch for message ${mid}: stale attempt`)
        }
        continue
      }
      if (attemptId === undefined) continue
      // No intent but a supplied attempt: a winning register proves this
      // attempt was already consumed by the issuer — stale duplicate, fail
      // closed with no second op. Otherwise tolerate (bogus attempt on a
      // never-resend message stays an ordinary write).
      try {
        const reg = (this.db as unknown as BetterSQLite3Database<typeof schema>)
          .select()
          .from(schema.syncStableReplaceRegister)
          .where(eq(schema.syncStableReplaceRegister.messageId, mid))
          .get()
        if (reg) {
          throw new ChatDbConflictError(`resend attempt consumed for message ${mid}: stale attempt`)
        }
      } catch (e) {
        if (e instanceof ChatDbConflictError) throw e
        if (e instanceof Error && /no such table/i.test(e.message)) continue
        throw new ChatDbConflictError(`resend attempt guard unreadable for message ${mid}`)
      }
    }
  }

  /**
   * Authoritative in-tx attempt check. Throws ChatDbConflictError (rolls
   * back the enclosing mutation) on a stale supplied attempt — including a
   * post-issuance duplicate proven by the winning register. Returns true
   * when an intent covers the message (caller must suppress ordinary sync
   * capture; the success-final paths may then try the stable_replace
   * issuer, all other covered paths stay local-only).
   */
  private checkResendAttemptInTx(stx: SyncTxExecutor, messageId: string, attemptId?: string): boolean {
    const stored = getResendAttemptInTx(stx, messageId)
    if (stored) {
      if (attemptId !== undefined && attemptId !== stored.attemptId) {
        throw new ChatDbConflictError(`resend attempt mismatch for message ${messageId}: stale attempt`)
      }
      return true
    }
    if (attemptId === undefined) return false
    let reg: unknown = null
    try {
      reg = (stx as unknown as BetterSQLite3Database<typeof schema>)
        .select()
        .from(schema.syncStableReplaceRegister)
        .where(eq(schema.syncStableReplaceRegister.messageId, messageId))
        .get()
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return false
      throw e instanceof Error ? e : new Error(String(e))
    }
    if (reg) {
      throw new ChatDbConflictError(`resend attempt consumed for message ${messageId}: stale attempt`)
    }
    return false
  }

  /**
   * Best-effort pre-tx parent resolution for block payloads: authoritative
   * message ids for existing blocks plus wire-declared parents for creates.
   * In-tx checks remain authoritative; this only enables the fail-closed
   * guard before the write transaction opens.
   */
  private blockParentIdsPreTx(blocksJson: JsonObject[]): string[] {
    const ids: string[] = []
    if (blocksJson.length === 0) return ids
    let repos: ChatDbRepositories | null = null
    try {
      repos = this.repos()
    } catch {
      return ids
    }
    for (const raw of blocksJson) {
      if (!raw || typeof raw !== 'object') continue
      const rec = raw as Record<string, unknown>
      const bid = rec.id
      const wireParent = rec.messageId
      if (typeof wireParent === 'string' && wireParent.length > 0) ids.push(wireParent)
      if (typeof bid !== 'string' || bid.length === 0 || !repos) continue
      try {
        const found = repos.blocks.getById(bid)
        if (found.found) ids.push(found.data.messageId)
      } catch {
        // Best effort only — the in-tx check decides authoritatively.
      }
    }
    return ids
  }

  /**
   * Durable capture-failure record OUTSIDE a rolled-back aggregate tx
   * (LOCK-PERSONAL-006/009): the chat mutation is already rolled back (no
   * chat change committed); the sync_state failure write runs on the live
   * connection outside that tx so it survives. Never throws. Skips domain
   * rejections (foreign/no-op validation) which are not capture failures.
   */
  private recordSyncTxFailure(channel: string, ctx: { deviceId: string; ts: number } | null, e: unknown): void {
    if (!ctx) return
    if (this.isDomainRejection(e)) return
    // Outside the rolled-back tx so the record survives. A persistence
    // failure (SyncCaptureError, already carrying the original message) is
    // logged and propagated — never swallowed — while the caller still throws
    // so the rolled-back mutation never appears committed.
    try {
      syncService.recordCaptureFailure(channel, e)
    } catch (secondary) {
      const detail = secondary instanceof Error ? secondary.message : String(secondary)
      loggerService
        .withContext('ChatDbAggregate')
        .error(`[recordSyncTxFailure] ${channel} persistence failed: ${detail}`)
      throw secondary instanceof Error ? secondary : new Error(String(secondary))
    }
  }

  private syncTopicPayload(data: TopicData): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      id: data.id,
      name: data.name,
      assistantId: data.assistantId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      deletedAt: data.deletedAt
    }
    for (const k of ['pinned', 'prompt', 'isNameManuallyEdited'] as const) {
      if (Object.prototype.hasOwnProperty.call(data.overflow ?? {}, k)) {
        const v = data.overflow[k]
        if (v !== undefined) payload[k] = v
      }
    }
    // Canonical absent defaults (shared helper): pinned=false, prompt=null,
    // isNameManuallyEdited=false. Explicit values including null preserved.
    return applyTopicSyncDefaults(payload)
  }

  private syncMessagePayloadFull(data: MessageData): Record<string, unknown> {
    return {
      id: data.id,
      topicId: data.topicId,
      role: data.role,
      content: data.content,
      status: data.status,
      askId: data.askId,
      model: data.model,
      modelId: data.modelId,
      assistantId: data.assistantId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      sortOrder: data.sortOrder
    }
  }

  private syncBlockPayloadFull(data: MessageBlockData): Record<string, unknown> {
    return {
      id: data.id,
      messageId: data.messageId,
      type: data.type,
      content: data.content,
      status: data.status,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      sortOrder: data.sortOrder
    }
  }

  /** Intentional message patch → sync field patch (allowlisted only, never identity/sortOrder). */
  private syncMessagePatchPayload(
    topicId: string,
    messageId: string,
    patch: Record<string, unknown>
  ): Record<string, unknown> | null {
    const allow = new Set([
      'role',
      'content',
      'status',
      'askId',
      'model',
      'modelId',
      'assistantId',
      'createdAt',
      'updatedAt'
    ])
    const out: Record<string, unknown> = { id: messageId, topicId }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'overflow' || k === 'id' || k === 'topicId' || k === 'sortOrder') continue
      if (!allow.has(k)) continue
      if (v !== undefined) out[k] = v
    }
    return Object.keys(out).length > 2 ? out : null
  }

  /** Intentional block patch → sync field patch (allowlisted only, never identity/sortOrder). */
  private syncBlockPatchPayload(
    messageId: string,
    blockId: string,
    patch: Record<string, unknown>
  ): Record<string, unknown> | null {
    const allow = new Set(['type', 'content', 'status', 'createdAt', 'updatedAt'])
    const out: Record<string, unknown> = { id: blockId, messageId }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'overflow' || k === 'id' || k === 'messageId' || k === 'sortOrder') continue
      if (!allow.has(k)) continue
      if (v !== undefined) out[k] = v
    }
    return Object.keys(out).length > 2 ? out : null
  }

  /**
   * Direct parent closure inside the aggregate tx (bounded to the direct
   * chain block→message→topic). Untracked but locally present parents are
   * captured first with strictly earlier timestamps. Throws fail-closed when
   * a required parent row is missing (rolls back the mutation).
   */
  private ensureTopicClosureInTx(tx: SyncTxExecutor, topicId: string, childTs: number, deviceId: string): void {
    if (syncService.isTrackedEntityInTx(tx, 'topic', topicId)) return
    const repos = createRepositories(tx as unknown as BetterSQLite3Database<typeof schema>)
    const found = repos.topics.getById(topicId)
    if (!found.found) throw new Error(`sync closure: topic ${topicId} missing in transaction`)
    syncService.enqueueUpsertInTx(
      tx,
      'topic',
      topicId,
      this.syncTopicPayload(found.data),
      Math.max(0, childTs - 2),
      deviceId
    )
  }

  private ensureMessageClosureInTx(tx: SyncTxExecutor, messageId: string, childTs: number, deviceId: string): void {
    const repos = createRepositories(tx as unknown as BetterSQLite3Database<typeof schema>)
    const mrow = repos.messages.getById(messageId)
    if (!mrow.found) throw new Error(`sync closure: message ${messageId} missing in transaction`)
    const topicId = mrow.data.topicId
    if (!topicId) throw new Error(`sync closure: message ${messageId} has no topic`)
    this.ensureTopicClosureInTx(tx, topicId, childTs, deviceId)
    if (syncService.isTrackedEntityInTx(tx, 'message', messageId)) return
    // Stable-checkpoint gate (LOCK-PERSONAL-004): a transient assistant
    // parent (streaming/pending/processing/searching) must never be emitted
    // through child closure. Fail closed — the enclosing mutation rolls back
    // with a durable capture failure and is deferred until the parent reaches
    // a stable checkpoint; the transient row itself is never synced and the
    // child emits nothing (no cursor poisoning: no outbox row is written).
    const full = repos.messages.getById(messageId)
    if (!full.found) throw new Error(`sync closure: message ${messageId} missing in transaction`)
    if (!isStableMessageStatus(full.data.status)) {
      throw new Error(`sync closure: parent message ${messageId} transient (${String(full.data.status)}), defer`)
    }
    // Closure emits a snapshot for field-clock sync only; it must never
    // fabricate a parent-membership clock for a pre-existing untracked parent.
    // Membership is minted only by a true first creation in the SAME current
    // transaction (see appendMessage/bulkAddBlocks) or by a transient→stable
    // promotion's own same-tx stable upsert (see mintPromotionMembershipInTx);
    // closure snapshots stay entity-only.
    syncService.enqueueUpsertInTx(
      tx,
      'message',
      messageId,
      this.syncMessagePayloadFull(full.data),
      Math.max(0, childTs - 1),
      deviceId
    )
  }

  private ensureBlockParentClosureInTx(tx: SyncTxExecutor, blockId: string, childTs: number, deviceId: string): void {
    const repos = createRepositories(tx as unknown as BetterSQLite3Database<typeof schema>)
    const brow = repos.blocks.getById(blockId)
    if (!brow.found) throw new Error(`sync closure: block ${blockId} missing in transaction`)
    this.ensureMessageClosureInTx(tx, brow.data.messageId, childTs, deviceId)
  }

  /**
   * Unsupported structured/attachment-bearing block gate (LOCK-PERSONAL-004).
   * A block whose canonical content lives in overflow (or whose type carries
   * binary/structured canonical payload) is not fully representable in the
   * allowlisted sync payload and must never emit a partial null-content
   * shell. Returns true when the block must be skipped for sync (caller
   * records a durable explicit unsupported outcome; no outbox row is
   * written). Ordinary text blocks return false and keep syncing.
   * No-op/foreign rows never reach this predicate (callers handle those as
   * non-errors first).
   */
  private isUnsupportedBlock(data: MessageBlockData): boolean {
    return isUnsupportedBlockForSync({ type: data.type, overflow: data.overflow })
  }

  /**
   * Durable explicit unsupported-block outcome after a successful chat commit
   * (LOCK-PERSONAL-004/006/009): the chat mutation stays committed; no
   * partial outbox row was written; the skip is recorded via the existing
   * capture-error mechanism (sync_state lastCaptureError + lastError) so it
   * cannot disappear silently. Never throws: a persistence failure is logged
   * (fail-closed observable) without rewriting the committed chat result.
   */
  private recordUnsupportedBlocksAfterCommit(channel: string, blockIds: ReadonlyArray<string>): void {
    if (blockIds.length === 0) return
    const ids = [...new Set(blockIds)].slice(0, 5).join(',')
    try {
      syncService.recordCaptureFailure(
        channel,
        new Error(`unsupported block(s) not representable for sync, skipped without partial payload: ${ids}`)
      )
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      loggerService
        .withContext('ChatDbAggregate')
        .error(`[unsupportedBlock] ${channel} capture-error persistence failed: ${detail}`)
    }
  }

  /**
   * Promotion-time membership mint (same-tx first stable checkpoint): when a
   * transient child becomes stable+supported via a trustworthy same-tx stable
   * upsert, that upsert's real {timestamp, operationId} establishes the first
   * membership clock. Same-parent re-promotion (stable→transient→stable)
   * reuses the first tuple without re-minting; different-parent retained
   * metadata fails closed via the existing conflict path (rolls back).
   * Never guesses from createdAt/entityClock/fieldClock/current time.
   */
  private mintPromotionMembershipInTx(
    tx: SyncTxExecutor,
    childEntityType: 'message' | 'message_block',
    childEntityId: string,
    parentId: string,
    timestamp: number,
    operationId: string
  ): void {
    const existing = syncService.getMembershipClockInTx(tx, childEntityType, childEntityId)
    if (!existing) {
      syncService.setMembershipClockInTx(tx, childEntityType, childEntityId, parentId, timestamp, operationId)
      return
    }
    if (existing.parentId !== parentId) {
      // Different-parent retained metadata: fail closed (throws, rolls back).
      syncService.setMembershipClockInTx(tx, childEntityType, childEntityId, parentId, timestamp, operationId)
      return
    }
    // Same-parent re-promotion: reuse the first membership, no re-mint.
  }

  /**
   * Stable-promotion descendant rescan (LOCK-PERSONAL-004): when a transient
   * parent becomes stable, committed stable block descendants that were
   * never tracked join the same stable checkpoint as entity-only evidence.
   * Parent (topic/message) intent is already enqueued by the caller with an
   * earlier timestamp, so per-block +1 offsets preserve parent-before-child
   * order. Only stable + untracked + unexcluded + supported rows enqueue;
   * transient rows never emit; unsupported structured/attachment-bearing rows
   * never emit a partial shell (collected for a durable unsupported outcome).
   * No-backfill boundary (009/SYNC-DATA-035): this rescan never mints
   * parentMembershipClock, except for the narrow promotion-scoped supplement
   * below. Sibling rows stable before the current tx began have no
   * trustworthy creation source in this tx — versioning them with the
   * current rescan op clock would be a guess (not createdAt,
   * entityClock, fieldClock, or current time either). They stay
   * entity-only/unversioned; only explicitly requested blocks (true-create
   * or transient→stable promotion with pre-state evidence, via their own
   * same-tx stable upsert clock) mint membership. A later single
   * messageBlock try-refresh in the same tx therefore invalidates with 0 op
   * while the user mutation succeeds when any included block lacks
   * trustworthy membership. Throws fail-closed (rolls back the promotion) on
   * infrastructure failure. Returns true when at least one descendant was
   * captured.
   *
   * Promotion-scoped supplement: when `mintMissingSuccessMembership` is true
   * (the same atomic tx minted an ordinary transient→success supported block
   * promotion for this parent), ordinary `success` + supported siblings that
   * are missing membership are captured AND versioned with their own same-tx
   * upsert clock via mintPromotionMembershipInTx (existing clocks are never
   * rewritten — insert-if-absent only; different-parent conflicts fail
   * closed). Non-success terminals (error/paused), unsupported/compound
   * rows, and rows that already carry a clock keep the entity-only/skip
   * behavior above. Clone/reset/full-backfill/startup scans never set this
   * flag.
   */
  private captureUntrackedStableBlocksInTx(
    tx: SyncTxExecutor,
    repos: ChatDbRepositories,
    messageId: string,
    baseTs: number,
    deviceId: string,
    excludeIds: ReadonlySet<string>,
    unsupportedIds?: string[],
    mintMissingSuccessMembership = false
  ): boolean {
    const siblings = repos.blocks.listByMessage(messageId)
    let captured = false
    let offset = 0
    for (const b of siblings) {
      if (excludeIds.has(b.id)) continue
      if (!isStableBlockStatus(b.status)) continue
      if (this.isUnsupportedBlock(b)) {
        unsupportedIds?.push(b.id)
        continue
      }
      // Unified promotion supplement: any sibling that already carries a
      // membership clock is never rewritten and emits no extra outbox.
      // Tracked-but-unversioned (entity clock/outbox without membership)
      // stays skipped for ordinary rescan, but joins the supplement when
      // this tx carries an ordinary transient→success supported promotion
      // (same success + supported gate as the block-write supplement).
      if (syncService.getMembershipClockInTx(tx, 'message_block', b.id)) continue
      if (
        syncService.isTrackedEntityInTx(tx, 'message_block', b.id) &&
        (!mintMissingSuccessMembership || b.status !== 'success')
      )
        continue
      // No-backfill: ordinary sibling rescan is entity-only only. Never mint
      // membership from the rescan op clock for rows stable before this tx,
      // unless this tx is a promotion-scoped supplement (see above).
      const ts = Math.max(0, baseTs + offset + 1)
      const opId = syncService.enqueueUpsertInTx(tx, 'message_block', b.id, this.syncBlockPayloadFull(b), ts, deviceId)
      if (
        mintMissingSuccessMembership &&
        b.status === 'success' &&
        !syncService.getMembershipClockInTx(tx, 'message_block', b.id)
      ) {
        this.mintPromotionMembershipInTx(tx, 'message_block', b.id, b.messageId, ts, opId)
      }
      offset += 1
      captured = true
    }
    return captured
  }

  /**
   * Promotion-scoped sibling supplement for block-write transactions that
   * carry no descendant rescan (updateBlocks/updateSingleBlock): when the
   * same atomic tx minted at least one ordinary transient→success supported
   * block promotion under `parentMessageId`, every other ordinary `success`
   * + supported sibling under the same parent that is missing membership is
   * captured (full payload) AND versioned with its own same-tx upsert clock.
   * Existing clocks are never rewritten (insert-if-absent only; a retained
   * different-parent clock fails closed via mintPromotionMembershipInTx and
   * rolls back the tx). Non-success terminals, transient rows, and
   * unsupported/compound rows are skipped without any outbox row. Resend-
   * covered parents stay local-only. Per-sibling +1 offsets off `baseTs`
   * preserve parent-before-child order. Returns the number of supplemented
   * siblings (0 when nothing qualified).
   */
  private backfillMissingSuccessSiblingMembershipInTx(
    tx: SyncTxExecutor,
    repos: ChatDbRepositories,
    parentMessageId: string,
    baseTs: number,
    deviceId: string,
    excludeIds: ReadonlySet<string>
  ): number {
    const siblings = repos.blocks.listByMessage(parentMessageId)
    let supplemented = 0
    for (const b of siblings) {
      if (excludeIds.has(b.id)) continue
      if (b.status !== 'success') continue
      if (this.isUnsupportedBlock(b)) continue
      if (syncService.getMembershipClockInTx(tx, 'message_block', b.id)) continue
      const ts = Math.max(0, baseTs + supplemented + 1)
      const opId = syncService.enqueueUpsertInTx(tx, 'message_block', b.id, this.syncBlockPayloadFull(b), ts, deviceId)
      this.mintPromotionMembershipInTx(tx, 'message_block', b.id, parentMessageId, ts, opId)
      supplemented += 1
    }
    return supplemented
  }

  /**
   * Pre/post diff for full-object block writes: only actually changed
   * allowlisted fields become sync intent (never sortOrder, never identity).
   * Null (pre absent) means create — caller uses the full payload instead.
   */
  private diffBlockPayload(pre: MessageBlockData | null, post: MessageBlockData): Record<string, unknown> | null {
    if (!pre) return this.syncBlockPayloadFull(post)
    const out: Record<string, unknown> = { id: post.id, messageId: post.messageId }
    for (const k of ['type', 'content', 'status', 'createdAt', 'updatedAt'] as const) {
      const a = pre[k] ?? null
      const b = post[k] ?? null
      if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) out[k] = post[k]
    }
    return Object.keys(out).length > 2 ? out : null
  }

  /** Pre/post diff for full-object message writes (same patch-only rule). */
  private diffMessagePayload(pre: MessageData | null, post: MessageData): Record<string, unknown> | null {
    if (!pre) return this.syncMessagePayloadFull(post)
    const out: Record<string, unknown> = { id: post.id, topicId: post.topicId }
    for (const k of [
      'role',
      'content',
      'status',
      'askId',
      'model',
      'modelId',
      'assistantId',
      'createdAt',
      'updatedAt'
    ] as const) {
      const a = pre[k] ?? null
      const b = post[k] ?? null
      if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) out[k] = post[k]
    }
    return Object.keys(out).length > 2 ? out : null
  }

  /**
   * Stable-checkpoint gate for creation paths (LOCK-PERSONAL-004): user
   * messages and independently stable non-assistant creations capture;
   * assistant stubs capture only at stable success/error/paused checkpoints.
   * Transient assistant rows are legitimate skips (no failure, no outbox).
   */
  private shouldCaptureMessageCreate(data: MessageData): boolean {
    if (data.role !== 'assistant') return true
    return isStableMessageStatus(data.status)
  }

  // -------------------------------------------------------------------------
  // Block order helpers — deterministic thinking/main_text ordering
  //
  // Every block persisted/upserted with an authoritative message.blocks order
  // must receive explicit sortOrder matching that array BEFORE repository
  // normalization, so THINKING remains above MAIN_TEXT across DB reloads,
  // variant switching, and deletion/reload. Writes without an authoritative
  // ordered list retain existing behavior.
  // -------------------------------------------------------------------------

  private getAuthoritativeBlockIds(messageJson: JsonObject | null | undefined): string[] | null {
    if (!messageJson || typeof messageJson !== 'object') return null
    const raw = (messageJson as Record<string, unknown>).blocks
    if (!Array.isArray(raw) || raw.length === 0) return null
    const ids: string[] = []
    for (const v of raw) {
      if (typeof v !== 'string' || v.length === 0) return null
      ids.push(v)
    }
    return ids
  }

  private assignAuthoritativeBlockOrder(messageJson: JsonObject | null | undefined, blocks: MessageBlockData[]): void {
    const ids = this.getAuthoritativeBlockIds(messageJson)
    if (!ids) return
    const orderMap = new Map<string, number>()
    ids.forEach((id, idx) => {
      if (!orderMap.has(id)) orderMap.set(id, idx)
    })
    if (orderMap.size === 0) return
    for (const b of blocks) {
      const idx = orderMap.get(b.id)
      if (idx !== undefined) {
        b.sortOrder = idx
      }
    }
  }

  private updateSurvivingBlockOrdersInTx(
    tx: unknown,
    messageId: string,
    authoritativeIds: string[] | null,
    upsertedIds: ReadonlySet<string>,
    deletedIds: ReadonlySet<string>
  ): void {
    if (!authoritativeIds || authoritativeIds.length === 0) return
    const orderMap = new Map<string, number>()
    authoritativeIds.forEach((id, idx) => {
      if (!orderMap.has(id)) orderMap.set(id, idx)
    })
    const dbTx = tx as BetterSQLite3Database<typeof schema>
    for (let idx = 0; idx < authoritativeIds.length; idx++) {
      const id = authoritativeIds[idx]
      if (upsertedIds.has(id)) continue
      if (deletedIds.has(id)) continue
      // Direct Drizzle update ensures the authoritative order survives variant/delete/reload
      // even for blocks not included in the current upsert batch. Missing rows are no-ops.
      dbTx
        .update(schema.messageBlocks)
        .set({ sortOrder: idx })
        .where(and(eq(schema.messageBlocks.id, id), eq(schema.messageBlocks.messageId, messageId)))
        .run()
    }
  }

  // =========================================================================
  // Command implementations
  // =========================================================================

  /**
   * Fetch all messages and blocks for a topic.
   * Returns consistent ordered message/block snapshot.
   * Rebuilds each message.blocks relationally.
   *
   * Pure read (LOCK-PERSONAL-001/006): a missing topic returns empty
   * arrays without creating any topic row, so a read can never leave a
   * hidden local topic without sync intent. Explicit creation stays on
   * ensureTopic (transactional outbox); appendMessage ensures its parent.
   */
  fetchMessages(topicId: string, branchId?: string | null): ChatDbResult<FetchMessagesResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Absent topic → pure read, no implicit mutation.
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          return { messages: [], blocks: [] }
        }

        // Route projection: the main route reads owned rows; a branch route
        // resolves the shared prefix through each anchor plus the owned
        // suffix. Stable IDs preserved; renderer never splices authority.
        const route = this.normalizeBranchId(branchId)
        const messageData = this.resolveRouteMessagesInTx(repos, topicId, route).messages
        const messageIds = messageData.map((m) => m.id)
        const blockDataMap = repos.blocks.listByMessages(messageIds)

        // Flatten all blocks
        const allBlocks: MessageBlockData[] = []
        for (const id of messageIds) {
          const msgBlocks = blockDataMap.get(id) ?? []
          allBlocks.push(...msgBlocks)
        }

        // Convert to wire format
        const wireMessages = messagesToWire(messageData)
        const wireBlocks = blocksToWire(allBlocks)

        // Reconstruct relational message.blocks
        const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)

        return { messages: messagesWithBlocks, blocks: wireBlocks }
      })
    }, `fetchMessages(${topicId})`)
  }

  /**
   * Typed windowed read — R-02 latest / R-03 around (S6.1; group-corrected for viewport).
   *
   * Counting unit for viewport windows is complete rendered/message groups
   * (consecutive assistant messages sharing a non-empty askId form one group;
   * all other messages are singleton groups, matching renderer
   * getMessageGroupSemanticKey / createMessageViewportGroupModel).
   *
   * One authoritative SQLite transaction:
   * - Deterministic order: sort_order ASC, id ASC with id tie-break; all
   *   seeks use the `(sort_order,id)` tuple over the existing
   *   `messages_topic_id_sort_order_idx` — no new index/migration.
   * - True SQL-level bounds: `latest`/`around` never call `listByTopic`.
   *   Tail/neighbor chunk scans (`getLatestByTopic` / `listBefore` /
   *   `listAfter`, 256 rows per chunk) plus at most one single-row
   *   predecessor/successor probe per edge. Total rows read scale with the
   *   returned window plus its pathological group extensions — never the
   *   whole topic. No per-row N+1: groups resolve from bounded chunks.
   * - Complete groups returned (never split a consecutive same-askId assistant run,
   *   even when that run is pathologically large — the run itself is read fully).
   * - Window metadata declares intent, bounds, and hasMore flags; completeness is 'window'.
   * - Missing topic → ERR_NOT_FOUND; missing anchor → ERR_NOT_FOUND; anchor
   *   outside the addressed route's effective sequence (branch-owned ID on
   *   main, or main-exclusive post-fork ID on a descendant branch that does
   *   not reference it) → ERR_NOT_FOUND; empty topic → empty window success.
   * - hasMoreBefore/After derived from group boundaries, not raw message indexes.
   */
  fetchMessagesWindow(request: FetchMessagesWindowRequest): ChatDbResult<FetchMessagesWindowResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }

        // Cross-topic history reference metadata (null for ordinary topics).
        // Resolved once in this same snapshot; drives both the reference-aware
        // route projection (in-memory path) and the response metadata.
        // Cross-topic history reference metadata (null for ordinary topics).
        // Resolved once in this same snapshot from the canonical route
        // structure (point lookups + tuple bounds, no prefix materialization);
        // drives both the bounded window reads and the response metadata.
        const windowBranchId = this.normalizeBranchId(request.branchId)
        const referenceChain: ReferenceChainPlan[] = []
        const windowRouteStruct = this.resolveRouteSegmentsInTx(
          repos,
          request.topicId,
          windowBranchId,
          new Set<string>(),
          0,
          undefined,
          referenceChain
        )
        let referenceMeta: HistoryReferenceMeta | null = windowRouteStruct.reference
          ? {
              sourceTopicId: windowRouteStruct.reference.sourceTopicId,
              sourceBranchId: windowRouteStruct.reference.sourceBranchId,
              anchorMessageId: windowRouteStruct.reference.anchorMessageId,
              sourceName: repos.topics.getById(windowRouteStruct.reference.sourceTopicId).found
                ? (repos.topics.getById(windowRouteStruct.reference.sourceTopicId).data?.name ?? null)
                : null,
              status: windowRouteStruct.status === 'available' ? 'available' : 'missing',
              // Nearest-layer boundary without reading the prefix: the depth-0
              // chain plan carries the same endpoint-or-predecessor boundary
              // the materialized prefix tail used to report.
              boundaryMessageId:
                windowRouteStruct.status === 'available'
                  ? (referenceChain.find((p) => p.depth === 0)?.boundaryMessageId ?? null)
                  : null
            }
          : null

        type WindowMessage = MessageData
        type WindowGroup = { semanticKey: string; start: number; end: number }
        const WINDOW_SCAN_CHUNK = 256
        const keyFor = (m: WindowMessage): string => this.windowGroupKeyOf(m)
        const computeGroups = (msgs: WindowMessage[]): WindowGroup[] =>
          this.computeRouteWindowGroups(msgs) as WindowGroup[]
        const buildWindowResponse = (
          windowMessages: WindowMessage[],
          meta: {
            kind: 'latest' | 'around'
            anchorMessageId: string | null
            requested: { limit?: number; before?: number; after?: number }
            hasMoreBefore: boolean
            hasMoreAfter: boolean
          }
        ): FetchMessagesWindowResponse => {
          const firstMessageId = windowMessages.length > 0 ? windowMessages[0].id : null
          const lastMessageId = windowMessages.length > 0 ? windowMessages[windowMessages.length - 1].id : null
          const ids = windowMessages.map((m) => m.id)
          const blockDataMap = repos.blocks.listByMessages(ids)
          const allBlocks: MessageBlockData[] = []
          for (const id of ids) allBlocks.push(...(blockDataMap.get(id) ?? []))
          const wireMessages = messagesToWire(windowMessages)
          const wireBlocks = blocksToWire(allBlocks)
          const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
          // Mutation capability (BRANCH-9): same-tx consistent view. Owner must
          // equal the requested route AND the row must belong to the addressed
          // topic; a foreign read-only reference prefix (canonical source
          // topicId) is never mutable. Content untouched; metadata only.
          const requestedOwner = this.normalizeBranchId(request.branchId)
          const mutableMessageIds = windowMessages
            .filter((m) => m.topicId === request.topicId && (m.branchId ?? null) === requestedOwner)
            .map((m) => m.id)
          return {
            messages: messagesWithBlocks,
            blocks: wireBlocks,
            mutableMessageIds,
            reference: referenceMeta,
            window: {
              kind: meta.kind,
              completeness: 'window' as const,
              topicId: request.topicId,
              anchorMessageId: meta.anchorMessageId,
              requested: meta.requested,
              firstMessageId,
              lastMessageId,
              returnedCount: windowMessages.length,
              hasMoreBefore: meta.hasMoreBefore,
              hasMoreAfter: meta.hasMoreAfter
            }
          }
        }

        // Branch-route OR reference-target window path: bounded virtual-route
        // scans over the canonical ordered owner segments (same truncation as
        // full materialization, no `listByTopic` full reads). Group semantics,
        // anchor NOT_FOUND, hasMore and metadata contracts match the main
        // bounded path and the previous in-memory windowing. Stable IDs
        // preserved; no renderer splicing.
        if (windowBranchId !== null || referenceMeta !== null) {
          const segments = windowRouteStruct.segments
          if (referenceMeta) {
            // Materialized reference layers for the ADDRESSED route: the
            // resolved source chain (nearest relation first) is clipped at the
            // first layer whose own boundary message is not part of this
            // route's history (segment membership + point lookups, never a
            // full effective read). A downstream endpoint that truncates an
            // upstream layer therefore reports no divider for it (never a
            // fabricated upstream boundary), while a layer whose boundary is
            // simply outside the returned window stays reported so the
            // renderer can defer it until pagination loads it.
            const chain = [...referenceChain].sort((a, b) => a.depth - b.depth)
            const layers: HistoryReferenceChainLayer[] = [
              {
                targetTopicId: request.topicId,
                sourceTopicId: referenceMeta.sourceTopicId,
                sourceBranchId: referenceMeta.sourceBranchId,
                anchorMessageId: referenceMeta.anchorMessageId,
                sourceName: referenceMeta.sourceName,
                status: referenceMeta.status,
                boundaryMessageId: referenceMeta.boundaryMessageId
              }
            ]
            if (referenceMeta.status === 'available') {
              for (const plan of chain) {
                if (plan.depth === 0) continue
                if (!this.isMessageInRouteSegmentsInTx(repos, segments, plan.boundaryMessageId)) break
                layers.push({
                  targetTopicId: plan.targetTopicId,
                  sourceTopicId: plan.sourceTopicId,
                  sourceBranchId: plan.sourceBranchId,
                  anchorMessageId: plan.anchorMessageId,
                  sourceName: plan.sourceName,
                  status: 'available',
                  boundaryMessageId: plan.boundaryMessageId
                })
              }
              // The nearest layer's boundary must be materialized too: when the
              // addressed route truncates the whole foreign prefix, the chain
              // is not reported at all (the top-level relation metadata stays
              // authoritative for the renderer's existing fallback placement).
              if (
                layers.length > 1 &&
                (layers[0].boundaryMessageId === null ||
                  !this.isMessageInRouteSegmentsInTx(repos, segments, layers[0].boundaryMessageId))
              ) {
                layers.length = 0
              }
            }
            if (layers.length > 0) referenceMeta = { ...referenceMeta, layers }
          }
          if (request.kind === 'latest') {
            let acc: WindowMessage[] = []
            let reachedStart = false
            for (;;) {
              let page: WindowMessage[]
              if (acc.length === 0) {
                page = this.readRouteTailBackwardInTx(repos, segments, WINDOW_SCAN_CHUNK)
              } else {
                const head = acc[0]
                const headSegIdx = this.segmentIndexOfOwner(segments, head.topicId, head.branchId ?? null)
                if (headSegIdx === -1)
                  throw new ChatDbNotFoundError(`Anchor message ${head.id} does not belong to topic ${request.topicId}`)
                page = this.readRouteBackwardBeforeInTx(
                  repos,
                  segments,
                  headSegIdx,
                  head.sortOrder,
                  head.id,
                  WINDOW_SCAN_CHUNK
                )
              }
              if (page.length === 0) {
                reachedStart = true
                break
              }
              acc = [...page, ...acc]
              const head = acc[0]
              const headSegIdx = this.segmentIndexOfOwner(segments, head.topicId, head.branchId ?? null)
              if (headSegIdx === -1)
                throw new ChatDbNotFoundError(`Anchor message ${head.id} does not belong to topic ${request.topicId}`)
              const groups = computeGroups(acc)
              if (groups.length > request.limit) break
              if (page.length < WINDOW_SCAN_CHUNK) {
                reachedStart = true
                break
              }
              if (groups.length < request.limit) continue
              const pred = this.effectivePredecessorOfInTx(repos, segments, headSegIdx, head.sortOrder, head.id)
              if (pred === null) {
                reachedStart = true
                break
              }
              if (keyFor(pred) !== groups[0].semanticKey) break
            }
            if (acc.length === 0) {
              return buildWindowResponse([], {
                kind: 'latest',
                anchorMessageId: null,
                requested: { limit: request.limit },
                hasMoreBefore: false,
                hasMoreAfter: false
              })
            }
            const groups = computeGroups(acc)
            const totalGroups = groups.length
            let startGroupIdx: number
            if (request.limit >= totalGroups) startGroupIdx = 0
            else startGroupIdx = totalGroups - request.limit
            const windowMessages = acc.slice(groups[startGroupIdx].start)
            let hasMoreBefore: boolean
            if (startGroupIdx > 0) {
              hasMoreBefore = true
            } else if (reachedStart) {
              hasMoreBefore = false
            } else {
              const head = acc[0]
              const headSegIdx = this.segmentIndexOfOwner(segments, head.topicId, head.branchId ?? null)
              hasMoreBefore =
                headSegIdx !== -1 &&
                this.effectivePredecessorOfInTx(repos, segments, headSegIdx, head.sortOrder, head.id) !== null
            }
            return buildWindowResponse(windowMessages, {
              kind: 'latest',
              anchorMessageId: null,
              requested: { limit: request.limit },
              hasMoreBefore,
              hasMoreAfter: false
            })
          }
          const located = this.locateWindowAnchorInTx(repos, segments, request.anchorMessageId)
          if (located === null) {
            throw new ChatDbNotFoundError(
              `Anchor message ${request.anchorMessageId} does not belong to topic ${request.topicId}`
            )
          }
          const anchorMsg = located.anchor
          const anchorKey = keyFor(anchorMsg)
          let backAcc: WindowMessage[] = []
          let backSegIdx = located.segIdx
          let backCursor = { sortOrder: anchorMsg.sortOrder, id: anchorMsg.id }
          let reachedBackStart = false
          for (;;) {
            const page = this.readRouteBackwardBeforeInTx(
              repos,
              segments,
              backSegIdx,
              backCursor.sortOrder,
              backCursor.id,
              WINDOW_SCAN_CHUNK
            )
            if (page.length === 0) {
              reachedBackStart = true
              break
            }
            backAcc = [...page, ...backAcc]
            const head = backAcc[0]
            const headSegIdx = this.segmentIndexOfOwner(segments, head.topicId, head.branchId ?? null)
            if (headSegIdx === -1)
              throw new ChatDbNotFoundError(`Anchor message ${head.id} does not belong to topic ${request.topicId}`)
            backSegIdx = headSegIdx
            backCursor = { sortOrder: head.sortOrder, id: head.id }
            const backGroups = computeGroups(backAcc)
            const mergedWithAnchor =
              backGroups.length > 0 && backGroups[backGroups.length - 1].semanticKey === anchorKey
            const beyondCount = backGroups.length - (mergedWithAnchor ? 1 : 0)
            if (beyondCount > request.before) break
            if (page.length < WINDOW_SCAN_CHUNK) {
              reachedBackStart = true
              break
            }
            if (beyondCount < request.before) continue
            const pred = this.effectivePredecessorOfInTx(
              repos,
              segments,
              backSegIdx,
              backCursor.sortOrder,
              backCursor.id
            )
            if (pred === null) {
              reachedBackStart = true
              break
            }
            if (keyFor(pred) !== backGroups[0].semanticKey) break
          }
          let fwdAcc: WindowMessage[] = []
          let fwdSegIdx = located.segIdx
          let fwdCursor = { sortOrder: anchorMsg.sortOrder, id: anchorMsg.id }
          let reachedFwdEnd = false
          for (;;) {
            const page = this.readRouteForwardAfterInTx(
              repos,
              segments,
              fwdSegIdx,
              fwdCursor.sortOrder,
              fwdCursor.id,
              WINDOW_SCAN_CHUNK
            )
            if (page.length === 0) {
              reachedFwdEnd = true
              break
            }
            fwdAcc = [...fwdAcc, ...page]
            const tail = fwdAcc[fwdAcc.length - 1]
            const tailSegIdx = this.segmentIndexOfOwner(segments, tail.topicId, tail.branchId ?? null)
            if (tailSegIdx === -1)
              throw new ChatDbNotFoundError(`Anchor message ${tail.id} does not belong to topic ${request.topicId}`)
            fwdSegIdx = tailSegIdx
            fwdCursor = { sortOrder: tail.sortOrder, id: tail.id }
            const fwdGroups = computeGroups(fwdAcc)
            const mergedWithAnchor = fwdGroups.length > 0 && fwdGroups[0].semanticKey === anchorKey
            const beyondCount = fwdGroups.length - (mergedWithAnchor ? 1 : 0)
            if (beyondCount > request.after) break
            if (page.length < WINDOW_SCAN_CHUNK) {
              reachedFwdEnd = true
              break
            }
            if (beyondCount < request.after) continue
            const succ = this.effectiveSuccessorOfInTx(repos, segments, fwdSegIdx, fwdCursor.sortOrder, fwdCursor.id)
            if (succ === null) {
              reachedFwdEnd = true
              break
            }
            if (keyFor(succ) !== fwdGroups[fwdGroups.length - 1].semanticKey) break
          }
          const backGroups = computeGroups(backAcc)
          const backMerged = backGroups.length > 0 && backGroups[backGroups.length - 1].semanticKey === anchorKey
          const backBeyond = backMerged ? backGroups.slice(0, -1) : backGroups
          const backStartGroupIdx = Math.max(0, backBeyond.length - request.before)
          // No beyond group on a side => every row on that side of the anchor
          // belongs to the anchor's own group, so the whole slice must be kept
          // (the anchor group is always returned complete). A non-empty beyond
          // set means the retained frontier group is the first complete
          // beyond-group, never a partial one.
          const backStartMsgIdx = backBeyond.length === 0 ? 0 : backBeyond[backStartGroupIdx].start
          const fwdGroups = computeGroups(fwdAcc)
          const fwdMerged = fwdGroups.length > 0 && fwdGroups[0].semanticKey === anchorKey
          const fwdBeyond = fwdMerged ? fwdGroups.slice(1) : fwdGroups
          const fwdEndGroupIdx = Math.min(fwdBeyond.length - 1, request.after - 1)
          const fwdEndExclusive = fwdBeyond.length === 0 ? fwdAcc.length : fwdBeyond[fwdEndGroupIdx].end + 1
          const windowMessages: WindowMessage[] = [
            ...backAcc.slice(backStartMsgIdx),
            anchorMsg,
            ...fwdAcc.slice(0, fwdEndExclusive)
          ]
          let hasMoreBefore: boolean
          if (backBeyond.length > request.before) {
            hasMoreBefore = true
          } else if (windowMessages.length === 0) {
            hasMoreBefore = false
          } else if (backStartMsgIdx > 0) {
            hasMoreBefore = true
          } else if (backAcc.length === 0) {
            hasMoreBefore =
              this.effectivePredecessorOfInTx(repos, segments, located.segIdx, anchorMsg.sortOrder, anchorMsg.id) !==
              null
          } else if (reachedBackStart) {
            hasMoreBefore = false
          } else {
            const start = windowMessages[0]
            const startSegIdx = this.segmentIndexOfOwner(segments, start.topicId, start.branchId ?? null)
            hasMoreBefore =
              startSegIdx !== -1 &&
              this.effectivePredecessorOfInTx(repos, segments, startSegIdx, start.sortOrder, start.id) !== null
          }
          let hasMoreAfter: boolean
          if (fwdBeyond.length > request.after) {
            hasMoreAfter = true
          } else if (windowMessages.length === 0) {
            hasMoreAfter = false
          } else if (fwdEndExclusive < fwdAcc.length) {
            hasMoreAfter = true
          } else if (fwdAcc.length === 0) {
            hasMoreAfter =
              this.effectiveSuccessorOfInTx(repos, segments, located.segIdx, anchorMsg.sortOrder, anchorMsg.id) !== null
          } else if (reachedFwdEnd) {
            hasMoreAfter = false
          } else {
            const end = windowMessages[windowMessages.length - 1]
            const endSegIdx = this.segmentIndexOfOwner(segments, end.topicId, end.branchId ?? null)
            hasMoreAfter =
              endSegIdx !== -1 &&
              this.effectiveSuccessorOfInTx(repos, segments, endSegIdx, end.sortOrder, end.id) !== null
          }
          return buildWindowResponse(windowMessages, {
            kind: 'around',
            anchorMessageId: request.anchorMessageId,
            requested: { before: request.before, after: request.after },
            hasMoreBefore,
            hasMoreAfter
          })
        }

        if (request.kind === 'latest') {
          // Tail chunk scan: accumulate DESC chunks until the last `limit`
          // complete groups are provably complete (oldest retained group
          // start is interior, or a predecessor probe proves the boundary).
          let acc: WindowMessage[] = []
          let cursor: { sortOrder: number; id: string } | null = null
          let reachedStart = false
          for (;;) {
            const page =
              cursor === null
                ? repos.messages.getLatestByTopic(request.topicId, WINDOW_SCAN_CHUNK)
                : repos.messages.listBefore(request.topicId, cursor.sortOrder, cursor.id, WINDOW_SCAN_CHUNK)
            if (page.length === 0) {
              reachedStart = true
              break
            }
            acc = [...page, ...acc]
            const head = acc[0]
            cursor = { sortOrder: head.sortOrder, id: head.id }
            const groups = computeGroups(acc)
            if (groups.length > request.limit) break
            if (page.length < WINDOW_SCAN_CHUNK) {
              reachedStart = true
              break
            }
            if (groups.length < request.limit) continue
            // groups.length === limit: oldest group is complete only when
            // the row before it differs (or nothing is before it).
            const pred = repos.messages.findPredecessor(request.topicId, cursor.sortOrder, cursor.id)
            if (pred === null) {
              reachedStart = true
              break
            }
            if (keyFor(pred) !== groups[0].semanticKey) break
            // Oldest group truncated — scan further back.
          }
          if (acc.length === 0) {
            return buildWindowResponse([], {
              kind: 'latest',
              anchorMessageId: null,
              requested: { limit: request.limit },
              hasMoreBefore: false,
              hasMoreAfter: false
            })
          }
          const groups = computeGroups(acc)
          const totalGroups = groups.length
          let startGroupIdx: number
          let endGroupIdx: number
          if (request.limit >= totalGroups) {
            startGroupIdx = 0
            endGroupIdx = totalGroups - 1
          } else {
            startGroupIdx = totalGroups - request.limit
            endGroupIdx = totalGroups - 1
          }
          const windowMessages = acc.slice(groups[startGroupIdx].start, groups[endGroupIdx].end + 1)
          let hasMoreBefore: boolean
          if (startGroupIdx > 0) {
            hasMoreBefore = true
          } else if (reachedStart) {
            hasMoreBefore = false
          } else {
            const head = acc[0]
            hasMoreBefore = repos.messages.findPredecessor(request.topicId, head.sortOrder, head.id) !== null
          }
          return buildWindowResponse(windowMessages, {
            kind: 'latest',
            anchorMessageId: null,
            requested: { limit: request.limit },
            hasMoreBefore,
            hasMoreAfter: false
          })
        } else {
          // Around: stable-ID anchor, then bounded backward/forward chunk
          // scans. Rows sharing the anchor's assistant askId key on either
          // side extend the anchor group itself (never counted toward
          // before/after); beyond that, complete adjacent groups are counted.
          const anchor = repos.messages.getInTopic(request.anchorMessageId, request.topicId)
          if (!anchor.found) {
            throw new ChatDbNotFoundError(
              `Anchor message ${request.anchorMessageId} does not belong to topic ${request.topicId}`
            )
          }
          // Main-route ownership symmetry (branch path validates against the
          // effective sequence via findIndex): a branch-owned suffix ID must
          // fail when addressing main, otherwise a mixed main window would be
          // admitted. Main effective membership is owner equality (branchId
          // null); any branch-owned row is out-of-route here.
          if ((anchor.data.branchId ?? null) !== null) {
            throw new ChatDbNotFoundError(
              `Anchor message ${request.anchorMessageId} does not belong to the main route of topic ${request.topicId}`
            )
          }
          const anchorMsg = anchor.data
          const anchorKey = keyFor(anchorMsg)

          // Backward scan (exclusive of anchor).
          let backAcc: WindowMessage[] = []
          let backCursor = { sortOrder: anchorMsg.sortOrder, id: anchorMsg.id }
          let reachedBackStart = false
          for (;;) {
            const page = repos.messages.listBefore(
              request.topicId,
              backCursor.sortOrder,
              backCursor.id,
              WINDOW_SCAN_CHUNK
            )
            if (page.length === 0) {
              reachedBackStart = true
              break
            }
            backAcc = [...page, ...backAcc]
            const head = backAcc[0]
            backCursor = { sortOrder: head.sortOrder, id: head.id }
            const backGroups = computeGroups(backAcc)
            const mergedWithAnchor =
              backGroups.length > 0 && backGroups[backGroups.length - 1].semanticKey === anchorKey
            const beyondCount = backGroups.length - (mergedWithAnchor ? 1 : 0)
            if (beyondCount > request.before) break
            if (page.length < WINDOW_SCAN_CHUNK) {
              reachedBackStart = true
              break
            }
            if (beyondCount < request.before) continue
            const pred = repos.messages.findPredecessor(request.topicId, backCursor.sortOrder, backCursor.id)
            if (pred === null) {
              reachedBackStart = true
              break
            }
            if (keyFor(pred) !== backGroups[0].semanticKey) break
          }

          // Forward scan (exclusive of anchor).
          let fwdAcc: WindowMessage[] = []
          let fwdCursor = { sortOrder: anchorMsg.sortOrder, id: anchorMsg.id }
          let reachedFwdEnd = false
          for (;;) {
            const page = repos.messages.listAfter(request.topicId, fwdCursor.sortOrder, fwdCursor.id, WINDOW_SCAN_CHUNK)
            if (page.length === 0) {
              reachedFwdEnd = true
              break
            }
            fwdAcc = [...fwdAcc, ...page]
            const tail = fwdAcc[fwdAcc.length - 1]
            fwdCursor = { sortOrder: tail.sortOrder, id: tail.id }
            const fwdGroups = computeGroups(fwdAcc)
            const mergedWithAnchor = fwdGroups.length > 0 && fwdGroups[0].semanticKey === anchorKey
            const beyondCount = fwdGroups.length - (mergedWithAnchor ? 1 : 0)
            if (beyondCount > request.after) break
            if (page.length < WINDOW_SCAN_CHUNK) {
              reachedFwdEnd = true
              break
            }
            if (beyondCount < request.after) continue
            const succ = repos.messages.findSuccessor(request.topicId, fwdCursor.sortOrder, fwdCursor.id)
            if (succ === null) {
              reachedFwdEnd = true
              break
            }
            if (keyFor(succ) !== fwdGroups[fwdGroups.length - 1].semanticKey) break
          }

          // Assemble: anchor group (prefix + anchor + suffix) plus the
          // nearest `before`/`after` complete beyond-groups.
          const backGroups = computeGroups(backAcc)
          const backMerged = backGroups.length > 0 && backGroups[backGroups.length - 1].semanticKey === anchorKey
          const backBeyond = backMerged ? backGroups.slice(0, -1) : backGroups
          const backStartGroupIdx = Math.max(0, backBeyond.length - request.before)
          const backStartMsgIdx = backBeyond.length === 0 ? 0 : backBeyond[backStartGroupIdx].start

          const fwdGroups = computeGroups(fwdAcc)
          const fwdMerged = fwdGroups.length > 0 && fwdGroups[0].semanticKey === anchorKey
          const fwdBeyond = fwdMerged ? fwdGroups.slice(1) : fwdGroups
          const fwdEndGroupIdx = Math.min(fwdBeyond.length - 1, request.after - 1)
          const fwdEndExclusive = fwdBeyond.length === 0 ? fwdAcc.length : fwdBeyond[fwdEndGroupIdx].end + 1

          const windowMessages: WindowMessage[] = [
            ...backAcc.slice(backStartMsgIdx),
            anchorMsg,
            ...fwdAcc.slice(0, fwdEndExclusive)
          ]

          let hasMoreBefore: boolean
          if (backBeyond.length > request.before) {
            hasMoreBefore = true
          } else if (windowMessages.length === 0) {
            hasMoreBefore = false
          } else if (backStartMsgIdx > 0) {
            hasMoreBefore = true
          } else if (backAcc.length === 0) {
            hasMoreBefore = repos.messages.findPredecessor(request.topicId, anchorMsg.sortOrder, anchorMsg.id) !== null
          } else if (reachedBackStart) {
            hasMoreBefore = false
          } else {
            const start = windowMessages[0]
            hasMoreBefore = repos.messages.findPredecessor(request.topicId, start.sortOrder, start.id) !== null
          }

          let hasMoreAfter: boolean
          if (fwdBeyond.length > request.after) {
            hasMoreAfter = true
          } else if (windowMessages.length === 0) {
            hasMoreAfter = false
          } else if (fwdEndExclusive < fwdAcc.length) {
            hasMoreAfter = true
          } else if (fwdAcc.length === 0) {
            hasMoreAfter = repos.messages.findSuccessor(request.topicId, anchorMsg.sortOrder, anchorMsg.id) !== null
          } else if (reachedFwdEnd) {
            hasMoreAfter = false
          } else {
            const end = windowMessages[windowMessages.length - 1]
            hasMoreAfter = repos.messages.findSuccessor(request.topicId, end.sortOrder, end.id) !== null
          }

          return buildWindowResponse(windowMessages, {
            kind: 'around',
            anchorMessageId: request.anchorMessageId,
            requested: { before: request.before, after: request.after },
            hasMoreBefore,
            hasMoreAfter
          })
        }
      })
    }, `fetchMessagesWindow(${request.topicId}, ${request.kind})`)
  }

  /**
   * S6.2b R-05: authoritative answer-group READ.
   *
   * One authoritative SQLite transaction:
   * - Validates topic exists, anchor belongs to topic, anchor role is
   *   assistant with non-empty askId — all fail as NOT_FOUND (no actionable group).
   * - Resolves complete group: all same-topic assistant messages with equal
   *   askId in deterministic sort_order ASC, id ASC.
   * - True-branch topics resolve against the branch's effective route
   *   (shared prefix through the fork anchor plus the branch-owned suffix,
   *   stable IDs), so inherited anchors and askId groups spanning the fork
   *   boundary stay actionable; ordinary topics keep the topic-bound path.
   * - Returns completeness:'answer-group', echoes topicId/anchorMessageId,
   *   includes askId and ordered messageIds. No mutation, no size/cursor fields.
   */
  fetchAnswerGroup(request: FetchAnswerGroupRequest): ChatDbResult<FetchAnswerGroupResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        const groupBranchId = this.normalizeBranchId(request.branchId)
        const allMessages = this.resolveRouteMessagesInTx(repos, request.topicId, groupBranchId).messages
        const anchor = allMessages.find((m) => m.id === request.anchorMessageId)
        if (!anchor) {
          throw new ChatDbNotFoundError(
            `Anchor message ${request.anchorMessageId} does not belong to topic ${request.topicId}`
          )
        }
        const askId = anchor.askId
        if (anchor.role !== 'assistant' || typeof askId !== 'string' || askId.length === 0) {
          throw new ChatDbNotFoundError(`Anchor message ${request.anchorMessageId} has no actionable answer group`)
        }
        const groupIds = allMessages.filter((m) => m.role === 'assistant' && m.askId === askId).map((m) => m.id)
        if (!groupIds.includes(request.anchorMessageId)) {
          throw new ChatDbNotFoundError(`Anchor message ${request.anchorMessageId} has no actionable answer group`)
        }
        if (groupIds.length === 0) {
          throw new ChatDbNotFoundError(`Anchor message ${request.anchorMessageId} has no actionable answer group`)
        }
        return {
          completeness: 'answer-group' as const,
          topicId: request.topicId,
          anchorMessageId: request.anchorMessageId,
          askId,
          messageIds: groupIds
        }
      })
    }, `fetchAnswerGroup(${request.topicId}, ${request.anchorMessageId})`)
  }

  /**
   * S6.3 R-06: authoritative context closure READ (anchorGroupKey through newest).
   *
   * One authoritative SQLite transaction:
   * - Validates topic exists; missing topic → NOT_FOUND.
   * - Builds context turns deterministically from authority order
   *   (sort_order ASC, id ASC) with renderer-equivalent semantics:
   *   user starts a turn keyed by user id; consecutive assistant messages
   *   with matching non-empty askId join; assistant without askId or with
   *   non-matching askId and system messages are singleton turns; nullable/
   *   unknown roles are ignored for turn construction (matches renderer
   *   buildContextTurns which only groups system/user/assistant).
   * - Resolves anchorGroupKey using context-turn semantics in deterministic
   *   authority order: first user message id match, otherwise assistant
   *   non-empty askId match, otherwise non-user message id match.
   *   Unresolved anchor → NOT_FOUND. Main never writes/repairs the anchor.
   * - Returns rows from the first message of the resolved turn through the
   *   newest row, ordered sort_order ASC, id ASC, with complete message/block
   *   relations. No viewport cap, no hasMore, completeness is 'context-closure'.
   */
  fetchContextClosure(request: FetchContextClosureRequest): ChatDbResult<FetchContextClosureResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        const routeBranchId = this.normalizeBranchId(request.branchId)
        const allMessages = this.resolveRouteMessagesInTx(repos, request.topicId, routeBranchId).messages
        // Build context turns deterministically in authority order.
        type ContextTurn = { key: string; messages: MessageData[] }
        const turns: ContextTurn[] = []
        let currentTurnKey: string | null = null
        for (const msg of allMessages) {
          const role = msg.role
          const askId = (msg as unknown as { askId: string | null }).askId
          if (role === 'system') {
            currentTurnKey = msg.id
            turns.push({ key: currentTurnKey, messages: [msg] })
          } else if (role === 'user') {
            currentTurnKey = msg.id
            turns.push({ key: currentTurnKey, messages: [msg] })
          } else if (role === 'assistant') {
            if (askId && askId === currentTurnKey) {
              // Consecutive assistant with askId matching current turn → join
              turns[turns.length - 1].messages.push(msg)
            } else {
              if (askId) {
                currentTurnKey = askId
              } else {
                currentTurnKey = msg.id
              }
              turns.push({ key: currentTurnKey, messages: [msg] })
            }
          } else {
            // Nullable/unknown persisted role (null, '', 'tool', 'generic', etc.):
            // ignored for turn construction. Matches renderer buildContextTurns which
            // only groups system/user/assistant and silently drops other roles.
            // Policy is local and explicit: no turn, no currentTurnKey advance.
            // The raw message remains in authority-ordered closure slice but does
            // not affect context-turn semantics or anchor resolution.
            continue
          }
        }

        // Resolve anchorGroupKey using context-turn semantics in deterministic authority order.
        const anchorKey = request.anchorGroupKey
        let anchorTurnIdx = -1
        // 1. Prefer user message id match (canonical user-initiated turn)
        anchorTurnIdx = turns.findIndex((t) => t.messages.some((m) => m.role === 'user' && m.id === anchorKey))
        if (anchorTurnIdx === -1) {
          // 2. Fall back to assistant non-empty askId match (orphan or legacy askId anchor)
          anchorTurnIdx = turns.findIndex((t) =>
            t.messages.some((m) => m.role === 'assistant' && m.askId === anchorKey)
          )
        }
        if (anchorTurnIdx === -1) {
          // 3. Fall back to non-user message id match (orphan assistant own-id or standalone system)
          anchorTurnIdx = turns.findIndex((t) => t.messages.some((m) => m.role !== 'user' && m.id === anchorKey))
        }
        if (anchorTurnIdx === -1) {
          throw new ChatDbNotFoundError(`Anchor groupKey ${anchorKey} does not belong to topic ${request.topicId}`)
        }

        const anchorTurn = turns[anchorTurnIdx]
        const anchorStartId = anchorTurn.messages[0].id
        const anchorStartIdx = allMessages.findIndex((m) => m.id === anchorStartId)
        if (anchorStartIdx === -1) {
          throw new ChatDbNotFoundError(`Anchor groupKey ${anchorKey} does not belong to topic ${request.topicId}`)
        }

        const closureMessages = allMessages.slice(anchorStartIdx)
        const closureIds = closureMessages.map((m) => m.id)
        const blockMap = repos.blocks.listByMessages(closureIds)
        const allBlocks: MessageBlockData[] = []
        for (const id of closureIds) {
          allBlocks.push(...(blockMap.get(id) ?? []))
        }
        const wireMessages = messagesToWire(closureMessages)
        const wireBlocks = blocksToWire(allBlocks)
        const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)

        const firstMessageId = closureMessages.length > 0 ? closureMessages[0].id : null
        const lastMessageId = closureMessages.length > 0 ? closureMessages[closureMessages.length - 1].id : null
        // Authoritative counts and boundary come from the same complete turn
        // set and the same resolved anchor as the message slice above.
        //
        // Folded (collapsed) groups are the one participation exception: their
        // rows keep authority order, membership and boundaries, but they no
        // longer take part in the request context. Both closure producers
        // derive counts from the same helper, so the actual request, the token
        // estimation list, the context count and the boundary divider share
        // exactly one definition. Folding never moves the window start: the
        // anchor is resolved above, before participation is applied, and the
        // raw window slice is preserved for the client.
        const foldedMemberIds = this.resolveFoldedMemberMessageIdsInTx(repos, request.topicId, routeBranchId)
        const { totalTurnCount, selectedTurnCount, boundaryMessageId } = this.deriveParticipatingClosureCounts(
          turns,
          anchorTurnIdx,
          foldedMemberIds
        )

        return {
          messages: messagesWithBlocks,
          blocks: wireBlocks,
          closure: {
            completeness: 'context-closure' as const,
            topicId: request.topicId,
            anchorGroupKey: request.anchorGroupKey,
            firstMessageId,
            lastMessageId,
            returnedCount: closureMessages.length,
            totalTurnCount,
            selectedTurnCount,
            boundaryMessageId,
            // Authority folded membership of the read topic, for the request
            // filter — never a renderer projection.
            foldedMessageIds: Array.from(foldedMemberIds)
          }
        }
      })
    }, `fetchContextClosure(${request.topicId}, ${request.anchorGroupKey})`)
  }

  /**
   * Authority context-closure resolver (additive; preserves fetch-context-closure).
   *
   * One authoritative SQLite transaction builds full ordered context turns,
   * resolves `intent`, and returns the same-snapshot closure. Main never
   * persists renderer settings; the caller persists `resolvedAnchorGroupKey`
   * (removing the key when null for an existing empty target).
   *
   * - establish(contextCount, currentAnchor): preserves a valid current anchor,
   *   repairs a ghost/missing anchor to the default position.
   * - reanchor-default(contextCount, currentAnchor): always resolves to default.
   * - move(messageId|groupKey, currentAnchor): messageId resolves to the
   *   message's own user / assistant askId-or-own / system turn (ignored roles
   *   reject as validation); groupKey uses the canonical 3-step anchor match.
   *   Missing message/target is NOT_FOUND.
   * - inherit(sourceTopicId, sourceAnchor, contextCount, current target anchor):
   *   valid source index inside the target maps to the target by index
   *   (clone remaps fresh UUID/askId IDs, index preserved); missing/invalid
   *   source or an index outside the target falls back to the target
   *   default at CURRENT contextCount (null => first, same position as a
   *   TokenCount click), never clamped to last. Empty target stays null.
   *   Missing source/target topic is NOT_FOUND.
   *
   * Existing empty target succeeds with null anchor and zero counts; missing
   * topic is NOT_FOUND. Default selection: last-N-participating-turns of the
   * effective route (null => first participating turn); all-folded/empty keep
   * the existing degenerate positions.
   *
   * With `detail: 'anchor'` (every intent) Main returns the metadata-only
   * anchor response via point lookups + bounded scans: no listByTopic, no
   * blocks, no messages/blocks/closure construction.
   */
  resolveContextClosure(request: ResolveContextClosureRequest): ChatDbResult<ResolveContextClosureResult> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        // Metadata-only anchor reads (detail:'anchor', every intent):
        // explicit authority reads with point lookups + bounded tuple scans.
        // Never calls listByTopic, never touches blocks, never builds wire closure.
        if (request.detail === 'anchor') {
          const currentKey: string | null =
            typeof request.currentAnchorGroupKey === 'string' ? request.currentAnchorGroupKey : null
          type AnchorTurn = { key: string; messages: MessageData[] }
          const buildAnchorTurns = (rows: MessageData[]): AnchorTurn[] => {
            const turns: AnchorTurn[] = []
            let cur: string | null = null
            for (const msg of rows) {
              const role = msg.role
              const askId = (msg as unknown as { askId: string | null }).askId
              if (role === 'system') {
                cur = msg.id
                turns.push({ key: cur, messages: [msg] })
              } else if (role === 'user') {
                cur = msg.id
                turns.push({ key: cur, messages: [msg] })
              } else if (role === 'assistant') {
                if (askId && askId === cur) {
                  turns[turns.length - 1].messages.push(msg)
                } else {
                  cur = askId ? askId : msg.id
                  turns.push({ key: cur, messages: [msg] })
                }
              } else {
                continue
              }
            }
            return turns
          }
          const resolveAnchorIndexOf = (turns: AnchorTurn[], groupKey: string): number => {
            let idx = turns.findIndex((t) => t.messages.some((m) => m.role === 'user' && m.id === groupKey))
            if (idx !== -1) return idx
            idx = turns.findIndex((t) =>
              t.messages.some(
                (m) => m.role === 'assistant' && (m as unknown as { askId: string | null }).askId === groupKey
              )
            )
            if (idx !== -1) return idx
            idx = turns.findIndex((t) => t.messages.some((m) => m.role !== 'user' && m.id === groupKey))
            return idx
          }
          // Branch routes resolve `detail:'anchor'` against the route's
          // effective messages (shared prefix through each anchor plus the
          // branch-owned suffix, stable IDs) in memory. A cross-topic history
          // reference target's MAIN route has the same problem: its effective
          // history begins with a LIVE foreign prefix that the bounded scans
          // (which only observe target-owned rows) cannot see, so establish/
          // reanchor-default/move/inherit would diverge from the full closure
          // path. The bounded-scan fast path below only observes main-route
          // rows, so a fresh branch with an empty own suffix (or a reference
          // target's foreign prefix) would report a null anchor. Non-reference
          // ordinary topics keep the bounded scans below untouched.
          const anchorRouteBranchId = this.normalizeBranchId(request.branchId)
          const anchorNeedsEffectiveRoute =
            anchorRouteBranchId !== null ||
            this.topicHasReferenceInTx(tx as unknown as BetterSQLite3Database<typeof schema>, request.topicId)
          if (anchorNeedsEffectiveRoute) {
            const effectiveForAnchor = this.resolveRouteMessagesInTx(
              repos,
              request.topicId,
              anchorRouteBranchId
            ).messages
            const anchorTurns = buildAnchorTurns(effectiveForAnchor)
            // Default selection over the addressed effective route: the last N
            // participating turns, anchored at the first of those turns. The
            // folded membership expands the same in-memory route rows once.
            const anchorFoldedMemberIds = this.expandFoldedTurns(effectiveForAnchor)
            const resolveEffectiveDefault = (
              contextCount: number | null | undefined,
              cur: string | null
            ): { resolvedAnchorGroupKey: string | null; changed: boolean } => {
              if (anchorTurns.length === 0) {
                return { resolvedAnchorGroupKey: null, changed: cur !== null }
              }
              const idx = this.resolveDefaultParticipatingIndex(anchorTurns, anchorFoldedMemberIds, contextCount)
              const resolved = anchorTurns[Math.max(0, idx)].key
              return { resolvedAnchorGroupKey: resolved, changed: resolved !== cur }
            }
            if (request.intent === 'establish') {
              if (anchorTurns.length === 0) {
                return { resolvedAnchorGroupKey: null, changed: currentKey !== null }
              }
              if (currentKey !== null) {
                const idx = resolveAnchorIndexOf(anchorTurns, currentKey)
                if (idx !== -1) {
                  const resolved = anchorTurns[idx].key
                  return { resolvedAnchorGroupKey: resolved, changed: resolved !== currentKey }
                }
              }
              return resolveEffectiveDefault(request.contextCount ?? null, currentKey)
            }
            if (request.intent === 'reanchor-default') {
              return resolveEffectiveDefault(request.contextCount ?? null, currentKey)
            }
            if (request.intent === 'move') {
              if (typeof request.messageId === 'string') {
                const target = effectiveForAnchor.find((m) => m.id === request.messageId)
                if (!target) {
                  throw new ChatDbNotFoundError(
                    `Message ${request.messageId} does not belong to topic ${request.topicId}`
                  )
                }
                const role = target.role
                if (role !== 'user' && role !== 'assistant' && role !== 'system') {
                  throw new ChatDbValidationError(
                    `Message ${request.messageId} has an ignored role and cannot anchor a context turn`
                  )
                }
                const resolved = role === 'assistant' ? (target.askId ? target.askId : target.id) : target.id
                return { resolvedAnchorGroupKey: resolved, changed: resolved !== currentKey }
              }
              if (typeof request.groupKey === 'string') {
                const idx = resolveAnchorIndexOf(anchorTurns, request.groupKey)
                if (idx === -1) {
                  throw new ChatDbNotFoundError(
                    `Anchor groupKey ${request.groupKey} does not belong to topic ${request.topicId}`
                  )
                }
                const resolved = anchorTurns[idx].key
                return { resolvedAnchorGroupKey: resolved, changed: resolved !== currentKey }
              }
              throw new ChatDbValidationError('move requires messageId or groupKey')
            }
            // inherit: valid source index inside the target maps to the target
            // by index (clone remaps IDs, index preserved); missing/invalid
            // source or an index outside the target falls back to the target
            // default at CURRENT contextCount. Both sides use effective routes.
            if (typeof request.sourceTopicId !== 'string' || request.sourceTopicId.length === 0) {
              throw new ChatDbValidationError('inherit requires sourceTopicId')
            }
            const anchorSourceId = request.sourceTopicId
            const anchorSourceTopic = repos.topics.getById(anchorSourceId)
            if (!anchorSourceTopic.found) {
              throw new ChatDbNotFoundError(`Topic ${anchorSourceId} does not exist`)
            }
            const sourceEffective = this.resolveRouteMessagesInTx(
              repos,
              anchorSourceId,
              this.normalizeBranchId(request.sourceBranchId)
            ).messages
            const sourceTurns = buildAnchorTurns(sourceEffective)
            const anchorSourceKey =
              typeof request.sourceAnchorGroupKey === 'string' ? request.sourceAnchorGroupKey : null
            const sourceIdx = anchorSourceKey !== null ? resolveAnchorIndexOf(sourceTurns, anchorSourceKey) : -1
            if (sourceIdx !== -1 && sourceIdx < anchorTurns.length) {
              const resolved = anchorTurns[sourceIdx].key
              return { resolvedAnchorGroupKey: resolved, changed: resolved !== currentKey }
            }
            return resolveEffectiveDefault(request.contextCount ?? null, currentKey)
          }
          // Authority default position via bounded scans only (message-row
          // metadata, never blocks): null => first participating turn (head
          // scan); finite N => first of the last N participating turns (tail
          // expansion). Folded whole turns are skipped with the same
          // participation policy as the closure counts. Never listByTopic.
          const resolveDefaultAnchor = (
            topicId: string,
            contextCount: number | null | undefined,
            cur: string | null
          ): { resolvedAnchorGroupKey: string | null; changed: boolean } => {
            const first = repos.messages.getFirstByTopic(topicId)
            if (!first) {
              return { resolvedAnchorGroupKey: null, changed: cur !== null }
            }
            if (contextCount === null || contextCount === undefined) {
              const HEAD_CHUNK = 64
              let acc: MessageData[] = [first]
              for (;;) {
                const headTurns = buildAnchorTurns(acc)
                const headFoldedIds = this.expandFoldedTurns(acc)
                const headIdx = headTurns.findIndex((t) => this.turnParticipatesInContext(t, headFoldedIds))
                if (headIdx !== -1) {
                  // A turn holding a non-folded member stays participating as
                  // later rows arrive, and every earlier turn is fully loaded
                  // already, so the first participating turn of the head
                  // prefix is already exact.
                  return {
                    resolvedAnchorGroupKey: headTurns[headIdx].key,
                    changed: headTurns[headIdx].key !== cur
                  }
                }
                const tail = acc[acc.length - 1]
                const page = repos.messages.listAfter(topicId, tail.sortOrder, tail.id, HEAD_CHUNK)
                if (page.length === 0) {
                  // Degenerate all-folded (or turn-less) history: keep the raw
                  // first-turn position instead of inventing a null anchor.
                  if (headTurns.length === 0) {
                    return { resolvedAnchorGroupKey: null, changed: cur !== null }
                  }
                  return { resolvedAnchorGroupKey: headTurns[0].key, changed: headTurns[0].key !== cur }
                }
                acc = [...acc, ...page]
              }
            }
            const n = Math.max(1, Math.floor(contextCount))
            const TAIL_CHUNK = 128
            let acc: MessageData[] = repos.messages.getLatestByTopic(topicId, TAIL_CHUNK)
            if (acc.length === 0) {
              return { resolvedAnchorGroupKey: null, changed: cur !== null }
            }
            let reachedStart = acc.length < TAIL_CHUNK
            for (;;) {
              const tailTurns = buildAnchorTurns(acc)
              if (tailTurns.length === 0) {
                if (reachedStart) {
                  return { resolvedAnchorGroupKey: null, changed: cur !== null }
                }
              } else if (reachedStart) {
                // Complete history: one unified participating selection; the
                // all-folded degenerate falls back to the raw tail position.
                const tailFoldedIds = this.expandFoldedTurns(acc)
                const idx = this.resolveDefaultParticipatingIndex(tailTurns, tailFoldedIds, contextCount)
                const resolved = tailTurns[Math.max(0, idx)].key
                return { resolvedAnchorGroupKey: resolved, changed: resolved !== cur }
              } else {
                // Suffix-only view: the head-most turn may still miss its
                // earlier rows, so it stays out of the participating count
                // until the start is reached. Suffix turn keys are stable.
                const suffix = tailTurns.slice(1)
                const suffixFoldedIds = this.expandFoldedTurns(acc)
                let need = n
                let suffixAnchor = -1
                for (let i = suffix.length - 1; i >= 0 && need > 0; i--) {
                  if (this.turnParticipatesInContext(suffix[i], suffixFoldedIds)) {
                    suffixAnchor = i
                    need--
                  }
                }
                if (need === 0) {
                  const resolved = suffix[suffixAnchor].key
                  return { resolvedAnchorGroupKey: resolved, changed: resolved !== cur }
                }
              }
              const head = acc[0]
              const page = repos.messages.listBefore(topicId, head.sortOrder, head.id, TAIL_CHUNK)
              if (page.length === 0) {
                reachedStart = true
                continue
              }
              if (page.length < TAIL_CHUNK) reachedStart = true
              acc = [...page, ...acc]
            }
          }
          if (request.intent === 'establish') {
            // Empty-message fast path (no turn can exist).
            const firstRow = repos.messages.getFirstByTopic(request.topicId)
            if (!firstRow) {
              return { resolvedAnchorGroupKey: null, changed: currentKey !== null }
            }
            // Preserve a valid existing anchor regardless of contextCount.
            // Canonical 3-step match parity with the closure path: a user id
            // or an askId with assistants is already canonical; an assistant
            // own-id with a non-empty askId normalizes to that askId turn key
            // (changed:true); solo assistants / system stay own-id.
            if (currentKey !== null) {
              const inTopic = repos.messages.getInTopic(currentKey, request.topicId)
              if (inTopic.found && inTopic.data.role === 'user') {
                return { resolvedAnchorGroupKey: currentKey, changed: false }
              }
              if (repos.messages.hasAssistantWithAskId(request.topicId, currentKey)) {
                return { resolvedAnchorGroupKey: currentKey, changed: false }
              }
              if (inTopic.found && inTopic.data.role === 'assistant') {
                const askId = (inTopic.data as unknown as { askId: string | null }).askId
                if (askId) {
                  return { resolvedAnchorGroupKey: askId, changed: askId !== currentKey }
                }
                return { resolvedAnchorGroupKey: currentKey, changed: false }
              }
              if (inTopic.found && inTopic.data.role === 'system') {
                return { resolvedAnchorGroupKey: currentKey, changed: false }
              }
            }
            return resolveDefaultAnchor(request.topicId, request.contextCount ?? null, currentKey)
          }
          if (request.intent === 'reanchor-default') {
            return resolveDefaultAnchor(request.topicId, request.contextCount ?? null, currentKey)
          }
          if (request.intent === 'move') {
            // Point lookups only: no listByTopic, no blocks. Same authority
            // turn-key derivation as the closure path (assistant askId-or-own;
            // groupKey canonical 3-step match with own-id askId resolution).
            if (typeof request.messageId === 'string') {
              const target = repos.messages.getInTopic(request.messageId, request.topicId)
              if (!target.found) {
                throw new ChatDbNotFoundError(
                  `Message ${request.messageId} does not belong to topic ${request.topicId}`
                )
              }
              const role = target.data.role
              if (role !== 'user' && role !== 'assistant' && role !== 'system') {
                throw new ChatDbValidationError(
                  `Message ${request.messageId} has an ignored role and cannot anchor a context turn`
                )
              }
              const resolved =
                role === 'assistant' ? (target.data.askId ? target.data.askId : target.data.id) : target.data.id
              return { resolvedAnchorGroupKey: resolved, changed: resolved !== currentKey }
            }
            if (typeof request.groupKey === 'string') {
              const g = request.groupKey
              const inTopic = repos.messages.getInTopic(g, request.topicId)
              if (inTopic.found && inTopic.data.role === 'user') {
                return { resolvedAnchorGroupKey: g, changed: g !== currentKey }
              }
              if (repos.messages.hasAssistantWithAskId(request.topicId, g)) {
                return { resolvedAnchorGroupKey: g, changed: g !== currentKey }
              }
              if (inTopic.found && (inTopic.data.role === 'assistant' || inTopic.data.role === 'system')) {
                const resolved =
                  inTopic.data.role === 'assistant'
                    ? inTopic.data.askId
                      ? inTopic.data.askId
                      : inTopic.data.id
                    : inTopic.data.id
                return { resolvedAnchorGroupKey: resolved, changed: resolved !== currentKey }
              }
              throw new ChatDbNotFoundError(`Anchor groupKey ${g} does not belong to topic ${request.topicId}`)
            }
            throw new ChatDbValidationError('move requires messageId or groupKey')
          }
          // inherit: valid source index inside the target maps to the target by
          // index; missing/invalid source or an index outside the target falls
          // back to the target default at CURRENT contextCount (null => first,
          // same position as a TokenCount click), never clamped to last.
          // Bounded forward scans only — no listByTopic, no blocks.
          // A pathological single turn may expand across chunks, but the topic
          // is never materialized wholesale via listByTopic.
          if (typeof request.sourceTopicId !== 'string' || request.sourceTopicId.length === 0) {
            throw new ChatDbValidationError('inherit requires sourceTopicId')
          }
          const sourceId = request.sourceTopicId
          const sourceTopic = repos.topics.getById(sourceId)
          if (!sourceTopic.found) {
            throw new ChatDbNotFoundError(`Topic ${sourceId} does not exist`)
          }
          const sourceKey = typeof request.sourceAnchorGroupKey === 'string' ? request.sourceAnchorGroupKey : null
          const findSourceIndex = (srcTopicId: string, key: string): number => {
            const HEAD_CHUNK = 64
            const first = repos.messages.getFirstByTopic(srcTopicId)
            if (!first) return -1
            let acc: MessageData[] = [first]
            for (;;) {
              const turns = buildAnchorTurns(acc)
              const idx = resolveAnchorIndexOf(turns, key)
              if (idx !== -1) return idx
              const tail = acc[acc.length - 1]
              const page = repos.messages.listAfter(srcTopicId, tail.sortOrder, tail.id, HEAD_CHUNK)
              if (page.length === 0) return -1
              acc = [...acc, ...page]
            }
          }
          const findTargetKeyAtIndex = (dstTopicId: string, targetIdx: number): string | null => {
            const HEAD_CHUNK = 64
            const first = repos.messages.getFirstByTopic(dstTopicId)
            if (!first) return null
            let acc: MessageData[] = [first]
            for (;;) {
              const turns = buildAnchorTurns(acc)
              // Turn keys are fixed at turn start; a trailing turn may gain
              // messages from the next chunk but its key and index are stable.
              if (turns.length > targetIdx) return turns[targetIdx].key
              const tail = acc[acc.length - 1]
              const page = repos.messages.listAfter(dstTopicId, tail.sortOrder, tail.id, HEAD_CHUNK)
              if (page.length === 0) {
                // Index outside the target (or empty target): no clamp.
                // Caller falls back to the CURRENT-contextCount default.
                return null
              }
              acc = [...acc, ...page]
            }
          }
          const sourceIdx = sourceKey !== null ? findSourceIndex(sourceId, sourceKey) : -1
          if (sourceIdx !== -1) {
            const targetKey = findTargetKeyAtIndex(request.topicId, sourceIdx)
            if (targetKey !== null) {
              return { resolvedAnchorGroupKey: targetKey, changed: targetKey !== currentKey }
            }
            // Outside the target (or empty target): default at CURRENT
            // contextCount; empty resolves null via the default path.
          }
          return resolveDefaultAnchor(request.topicId, request.contextCount ?? null, currentKey)
        }
        type AuthorityTurn = { key: string; messages: MessageData[] }
        const buildTurns = (rows: MessageData[]): AuthorityTurn[] => {
          const turns: AuthorityTurn[] = []
          let currentKey: string | null = null
          for (const msg of rows) {
            const role = msg.role
            const askId = (msg as unknown as { askId: string | null }).askId
            if (role === 'system') {
              currentKey = msg.id
              turns.push({ key: currentKey, messages: [msg] })
            } else if (role === 'user') {
              currentKey = msg.id
              turns.push({ key: currentKey, messages: [msg] })
            } else if (role === 'assistant') {
              if (askId && askId === currentKey) {
                turns[turns.length - 1].messages.push(msg)
              } else {
                currentKey = askId ? askId : msg.id
                turns.push({ key: currentKey, messages: [msg] })
              }
            } else {
              continue
            }
          }
          return turns
        }
        const resolveAnchorIndex = (turns: AuthorityTurn[], groupKey: string): number => {
          let idx = turns.findIndex((t) => t.messages.some((m) => m.role === 'user' && m.id === groupKey))
          if (idx !== -1) return idx
          idx = turns.findIndex((t) =>
            t.messages.some(
              (m) => m.role === 'assistant' && (m as unknown as { askId: string | null }).askId === groupKey
            )
          )
          if (idx !== -1) return idx
          idx = turns.findIndex((t) => t.messages.some((m) => m.role !== 'user' && m.id === groupKey))
          return idx
        }
        const closureBranchId = this.normalizeBranchId(request.branchId)
        const resolveEffectiveForClosure = (tid: string, bid: string | null): MessageData[] =>
          this.resolveRouteMessagesInTx(repos, tid, bid).messages
        const allMessages = resolveEffectiveForClosure(request.topicId, closureBranchId)
        const turns = buildTurns(allMessages)
        const total = turns.length
        // Participation membership of the addressed effective route, expanded
        // to whole turns once and shared by the default selection below and
        // by the counts/divider: one route, one expansion, no second scan.
        const closureFoldedMemberIds = this.expandFoldedTurns(allMessages)
        const resolveDefaultParticipating = (contextCount: number | null | undefined): number =>
          this.resolveDefaultParticipatingIndex(turns, closureFoldedMemberIds, contextCount)
        const currentKey: string | null =
          typeof request.currentAnchorGroupKey === 'string' ? request.currentAnchorGroupKey : null

        if (total === 0) {
          const changed = currentKey !== null
          return {
            messages: [],
            blocks: [],
            closure: {
              completeness: 'context-closure' as const,
              topicId: request.topicId,
              anchorGroupKey: null,
              firstMessageId: null,
              lastMessageId: null,
              returnedCount: 0,
              totalTurnCount: 0,
              selectedTurnCount: 0,
              boundaryMessageId: null,
              // Empty target: no context turns, so no folded participation
              // either (the renderer may still hold segment rows with folded
              // members, but none of them is a context turn here).
              foldedMessageIds: []
            },
            resolvedAnchorGroupKey: null,
            changed
          }
        }

        let resolvedIdx = -1
        if (request.intent === 'establish') {
          const currentIdx = currentKey !== null ? resolveAnchorIndex(turns, currentKey) : -1
          resolvedIdx = currentIdx !== -1 ? currentIdx : resolveDefaultParticipating(request.contextCount ?? null)
        } else if (request.intent === 'reanchor-default') {
          resolvedIdx = resolveDefaultParticipating(request.contextCount ?? null)
        } else if (request.intent === 'move') {
          if (typeof request.messageId === 'string') {
            const target = allMessages.find((m) => m.id === request.messageId)
            if (!target) {
              throw new ChatDbNotFoundError(`Message ${request.messageId} does not belong to topic ${request.topicId}`)
            }
            if (target.role !== 'user' && target.role !== 'assistant' && target.role !== 'system') {
              throw new ChatDbValidationError(
                `Message ${request.messageId} has an ignored role and cannot anchor a context turn`
              )
            }
            const ownIdx = turns.findIndex((t) => t.messages.some((m) => m.id === target.id))
            if (ownIdx === -1) {
              throw new ChatDbValidationError(
                `Message ${request.messageId} has an ignored role and cannot anchor a context turn`
              )
            }
            resolvedIdx = ownIdx
          } else if (typeof request.groupKey === 'string') {
            resolvedIdx = resolveAnchorIndex(turns, request.groupKey)
            if (resolvedIdx === -1) {
              throw new ChatDbNotFoundError(
                `Anchor groupKey ${request.groupKey} does not belong to topic ${request.topicId}`
              )
            }
          } else {
            throw new ChatDbValidationError('move requires messageId or groupKey')
          }
        } else {
          // inherit
          const sourceId = request.sourceTopicId as string
          const sourceTopic = repos.topics.getById(sourceId)
          if (!sourceTopic.found) {
            throw new ChatDbNotFoundError(`Topic ${sourceId} does not exist`)
          }
          const sourceMessages = resolveEffectiveForClosure(sourceId, this.normalizeBranchId(request.sourceBranchId))
          const sourceTurns = buildTurns(sourceMessages)
          const sourceKey = typeof request.sourceAnchorGroupKey === 'string' ? request.sourceAnchorGroupKey : null
          const sourceIdx = sourceKey !== null ? resolveAnchorIndex(sourceTurns, sourceKey) : -1
          if (sourceIdx !== -1 && sourceIdx < total) {
            resolvedIdx = sourceIdx
          } else {
            resolvedIdx = resolveDefaultParticipating(request.contextCount ?? null)
          }
        }

        if (resolvedIdx < 0 || resolvedIdx >= total) {
          throw new ChatDbNotFoundError(`Unable to resolve context anchor for topic ${request.topicId}`)
        }
        const resolvedKey = turns[resolvedIdx].key
        const anchorStartId = turns[resolvedIdx].messages[0].id
        const anchorStartIdx = allMessages.findIndex((m) => m.id === anchorStartId)
        if (anchorStartIdx === -1) {
          throw new ChatDbNotFoundError(`Anchor groupKey ${resolvedKey} does not belong to topic ${request.topicId}`)
        }
        const closureMessages = allMessages.slice(anchorStartIdx)
        const closureIds = closureMessages.map((m) => m.id)
        const blockMap = repos.blocks.listByMessages(closureIds)
        const allBlocks: MessageBlockData[] = []
        for (const id of closureIds) {
          allBlocks.push(...(blockMap.get(id) ?? []))
        }
        const wireMessages = messagesToWire(closureMessages)
        const wireBlocks = blocksToWire(allBlocks)
        const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
        const firstMessageId = closureMessages.length > 0 ? closureMessages[0].id : null
        const lastMessageId = closureMessages.length > 0 ? closureMessages[closureMessages.length - 1].id : null
        // Same participation definition as fetchContextClosure: counts and
        // divider derive from the shared helper against the same turn set, so
        // a fold toggle can never make the two producers diverge. The folded
        // membership is the one already shared with the default selection
        // above (same route rows, single expansion). The raw anchor/window
        // slice above is untouched.
        const foldedMemberIds = closureFoldedMemberIds
        const { totalTurnCount, selectedTurnCount, boundaryMessageId } = this.deriveParticipatingClosureCounts(
          turns,
          resolvedIdx,
          foldedMemberIds
        )
        return {
          messages: messagesWithBlocks,
          blocks: wireBlocks,
          closure: {
            completeness: 'context-closure' as const,
            topicId: request.topicId,
            anchorGroupKey: resolvedKey,
            firstMessageId,
            lastMessageId,
            returnedCount: closureMessages.length,
            totalTurnCount,
            selectedTurnCount,
            boundaryMessageId,
            // Same authority folded membership the request filter consumes.
            foldedMessageIds: Array.from(foldedMemberIds)
          },
          resolvedAnchorGroupKey: resolvedKey,
          changed: resolvedKey !== currentKey
        }
      })
    }, `resolveContextClosure(${request.topicId}, ${request.intent})`)
  }

  /**
   * One-shot whole-topic snapshot READ for topic exports / knowledge.
   *
   * One authoritative SQLite transaction:
   * - Validates topic exists; missing topic → NOT_FOUND (consistent with
   *   other explicit reads; never an ambiguous empty success).
   * - Returns the full ordered topic (authority sort_order ASC, id ASC via
   *   listByTopic) with complete message/block relations. No viewport cap,
   *   no hasMore, completeness is 'whole-topic'.
   * - Empty topic (exists, no messages) → empty success with null bounds.
   * - Pure read: never creates/mutates rows, never logs content.
   */
  fetchWholeTopicSnapshot(request: FetchWholeTopicSnapshotRequest): ChatDbResult<FetchWholeTopicSnapshotResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        // Effective route for the addressed route (main route reads owned
        // rows; a branch route resolves the shared prefix through each
        // anchor plus the owned suffix). Stable IDs, deterministic order.
        const snapshotRoute = this.normalizeBranchId(request.branchId)
        const allMessages = this.resolveRouteMessagesInTx(repos, request.topicId, snapshotRoute).messages
        const messageIds = allMessages.map((m) => m.id)
        const blockDataMap = repos.blocks.listByMessages(messageIds)
        const allBlocks: MessageBlockData[] = []
        for (const id of messageIds) {
          allBlocks.push(...(blockDataMap.get(id) ?? []))
        }
        const wireMessages = messagesToWire(allMessages)
        const wireBlocks = blocksToWire(allBlocks)
        const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
        const firstMessageId = allMessages.length > 0 ? allMessages[0].id : null
        const lastMessageId = allMessages.length > 0 ? allMessages[allMessages.length - 1].id : null
        // Authority folded membership of the read topic: the pre-anchor
        // request path filters against this list instead of the renderer
        // segment catalog, which may be unloaded or stale.
        const foldedMemberIds = this.resolveFoldedMemberMessageIdsInTx(repos, request.topicId, snapshotRoute)
        return {
          messages: messagesWithBlocks,
          blocks: wireBlocks,
          snapshot: {
            completeness: 'whole-topic' as const,
            topicId: request.topicId,
            firstMessageId,
            lastMessageId,
            returnedCount: allMessages.length,
            foldedMessageIds: Array.from(foldedMemberIds)
          }
        }
      })
    }, `fetchWholeTopicSnapshot(${request.topicId})`)
  }

  /**
   * Standalone JSON export READ — snapshot ONE ENTIRE logical topic.
   *
   * One authoritative SQLite transaction:
   * - Validates the topic exists; missing topic → NOT_FOUND.
   * - Reads ALL owned rows across ALL branches (main + every nested/sibling
   *   branch via listAllByTopic — never one effective route, never the
   *   renderer loaded projection), with complete block relations, the full
   *   branch catalog, segments plus ordered memberships, and file-reference
   *   index rows. When the topic is itself a reference target, the referenced
   *   history's effective prefix is MATERIALIZED as target-MAIN-owned snapshot
   *   rows (recursive references and source branch rows flattened, exactly
   *   once, ahead of the topic's own main rows) so the export is standalone —
   *   never a live external relation. A missing source is recorded explicitly
   *   (provenance `historySnapshot.status = 'missing'`), never faked complete.
   * - Builds the versioned payload via the shared exchange serializers, so
   *   wire values never contradict stored rows. Identity/scope columns,
   *   attachment payloads, the file catalog, and credentials are excluded.
   * - Empty topic (exists, no messages) → valid payload with empty arrays.
   * - Pure read: never creates/mutates rows (source rows and any persisted
   *   reference relation are untouched), never logs content.
   */
  exportTopicData(request: ExportTopicDataRequest): ChatDbResult<ExportTopicDataResponse> {
    return wrapResult(() => {
      if (!request || typeof request.topicId !== 'string' || request.topicId.length === 0) {
        throw new ChatDbValidationError('topicId must be a non-empty string')
      }
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        const messages = repos.messages.listAllByTopic(request.topicId)
        const messageIds = messages.map((m) => m.id)
        const blockDataMap = repos.blocks.listByMessages(messageIds)
        const branches = repos.branches.listByTopic(request.topicId)
        const segments = repos.segments.listByTopic(request.topicId).map((segment) => ({
          segment,
          messageIds: repos.segments.getMessageIds(segment.id)
        }))
        const fileReferences = repos.fileRefs.listByMessages(messageIds)
        // Materialize the referenced-history prefix (recursive, cycle-guarded)
        // so the export is standalone: the foreign effective prefix becomes
        // target-MAIN-owned snapshot rows exactly once, ahead of the topic's
        // own main rows. A missing source is flagged, never faked complete.
        // Ordinary topics are not reference targets → no prefix/provenance.
        // Provenance is export-scoped closure status: when any nested
        // reference-history segment in the source chain is missing, the
        // snapshot is `missing` even though the immediate source and its
        // surviving rows resolve (`chainMissing`); surviving prefix rows are
        // still carried. Ordinary runtime reads keep immediate-status semantics.
        const chainMissing: ReferenceChainMissingFlag = { missing: false }
        const base = this.resolveReferenceBaseInTx(repos, request.topicId, new Set<string>(), 0, chainMissing)
        let historyPrefix: TopicDataHistoryPrefixInput | null = null
        if (base.reference) {
          const prefixMessages = base.status === 'available' ? base.messages : []
          const prefixIds = prefixMessages.map((m) => m.id)
          historyPrefix = {
            status: base.status === 'available' && !chainMissing.missing ? 'materialized' : 'missing',
            messages: prefixMessages,
            blocksByMessage: repos.blocks.listByMessages(prefixIds),
            fileReferences: repos.fileRefs.listByMessages(prefixIds)
          }
        }
        return {
          payload: buildTopicDataExport({
            topic: topic.data,
            messages,
            blocksByMessage: blockDataMap,
            branches,
            segments,
            fileReferences,
            historyPrefix,
            exportedAt: new Date().toISOString()
          })
        }
      })
    }, `exportTopicData(${request?.topicId})`)
  }

  /**
   * Standalone JSON import WRITE — create a new topic from an untrusted
   * payload under the target assistant.
   *
   * - Deep-validates the payload (format marker, schema version, unique
   *   IDs, referential links, branch parent cycles, anchor owner
   *   relationships) BEFORE any write; unsupported versions and every
   *   structural defect fail with zero rows written.
   * - One atomic transaction inserts the new topic (rebound to the target
   *   assistant), fresh-ID messages (assistant rebound, askId remapped),
   *   blocks, branches (parents/anchors remapped), segments plus ordered
   *   memberships, and file references (attachment identities preserved,
   *   catalog untouched). Dangling branch anchors preserve missing-anchor
   *   state without repair.
   * - No dedup/merge/overwrite: every call mints a new topic id, so
   *   repeated imports intentionally duplicate.
   * - A materialized referenced-history prefix arrives as ordinary
   *   main-owned rows and is imported as fresh target-owned rows: the new
   *   topic is fully independent and writable, with no live reference
   *   relation and no foreign read-only permission. No relation is created,
   *   and deleting the original source never affects the imported topic.
   * - Sync intent mirrors the cross-topic clone path for main-route rows
   *   (branch-owned rows stay local-only, per BRANCH-10).
   */
  importTopicData(request: ImportTopicDataRequest): ChatDbResult<ImportTopicDataResponse> {
    return wrapResult(() => {
      if (!request || typeof request.assistantId !== 'string' || request.assistantId.length === 0) {
        throw new ChatDbValidationError('assistantId must be a non-empty string')
      }
      const validated = validateTopicDataImport(request.payload)
      const plan = planTopicDataImport(validated, request.assistantId, new Date().toISOString())
      const ctx = this.syncCtxForTopic('importTopicData', plan.topic.id)
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      let result: ImportTopicDataResponse
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const writer = createImportWriter(tx as BetterSQLite3Database<typeof schema>)

          writer.insertTopics([plan.topic])
          writer.insertBranches(plan.branches)
          writer.insertMessages(plan.messages)
          writer.insertBlocks(plan.blocks)
          writer.insertSegments(plan.segments)
          for (const membership of plan.memberships) {
            writer.insertSegmentMembership(membership.segmentId, membership.messageIds)
          }
          writer.insertFileReferences(plan.fileReferences)

          // NOTE: no history-reference relation is recreated. A referenced
          // topic's prefix arrives fully materialized as ordinary main-owned
          // rows in the payload, so the imported topic is independent,
          // target-owned, and fully writable — with no live relationship and
          // no foreign read-only permission.

          // Transaction-bound sync intent (same atomic boundary as the
          // cross-topic clone): fresh main-route messages/blocks enqueue
          // full-state upserts with true-create-only membership;
          // branch-owned rows emit nothing (local-only); transient /
          // unsupported rows emit nothing so frames invalidate truthfully.
          if (ctx) {
            let tsOffset = 0
            const nextTs = (): number => ctx.ts + tsOffset++
            const created = repos.topics.getById(plan.topic.id)
            if (!created.found) throw new Error(`importTopicData topic ${plan.topic.id} missing after insert`)
            syncService.enqueueUpsertInTx(
              stx,
              'topic',
              plan.topic.id,
              this.syncTopicPayload(created.data),
              Math.max(0, ctx.ts - 2),
              ctx.deviceId
            )
            syncNotify = true
            let hasNewInclusion = false
            for (const m of plan.messages) {
              if (m.branchId !== null) continue
              const postRow = repos.messages.getById(m.id)
              if (!postRow.found) throw new Error(`importTopicData message ${m.id} missing in transaction`)
              if (!isStableMessageStatus(postRow.data.status)) continue
              hasNewInclusion = true
              if (!this.shouldCaptureMessageCreate(postRow.data)) continue
              const opTs = nextTs()
              this.ensureTopicClosureInTx(stx, plan.topic.id, opTs, ctx.deviceId)
              const full = this.syncMessagePayloadFull(postRow.data)
              delete full.sortOrder
              const opId = syncService.enqueueUpsertInTx(stx, 'message', m.id, full, opTs, ctx.deviceId)
              syncService.setMembershipClockInTx(stx, 'message', m.id, postRow.data.topicId, opTs, opId)
              syncNotify = true
            }
            for (const blk of plan.blocks) {
              const postBlk = repos.blocks.getById(blk.id)
              if (!postBlk.found) throw new Error(`importTopicData block ${blk.id} missing in transaction`)
              const parentMsg = repos.messages.getById(postBlk.data.messageId)
              if (!parentMsg.found || !isStableMessageStatus(parentMsg.data.status)) continue
              if ((parentMsg.data.branchId ?? null) !== null) continue
              if (!isStableBlockStatus(postBlk.data.status)) continue
              if (this.isUnsupportedBlock(postBlk.data)) {
                unsupportedBlockIds.push(blk.id)
                continue
              }
              const opTs = nextTs()
              this.ensureBlockParentClosureInTx(stx, blk.id, opTs, ctx.deviceId)
              const full = this.syncBlockPayloadFull(postBlk.data)
              delete full.sortOrder
              const opId = syncService.enqueueUpsertInTx(stx, 'message_block', blk.id, full, opTs, ctx.deviceId)
              syncService.setMembershipClockInTx(stx, 'message_block', blk.id, postBlk.data.messageId, opTs, opId)
              syncNotify = true
            }
            if (hasNewInclusion) {
              if (
                syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, plan.topic.id, ctx.deviceId) === 'refreshed'
              ) {
                syncNotify = true
              }
            }
            for (const m of plan.messages) {
              if (m.branchId !== null) continue
              const postMsg = repos.messages.getById(m.id)
              if (!postMsg.found) continue
              if (!isStableMessageStatus(postMsg.data.status)) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', m.id)
                continue
              }
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, m.id, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          } else {
            // Capture disabled: preserve existing truthful invalidation, no ops.
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', plan.topic.id)
            {
              const mids = new Set<string>()
              for (const blk of plan.blocks) mids.add(blk.messageId)
              for (const mid of mids) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
              }
            }
          }

          const created = repos.topics.getById(plan.topic.id)
          if (!created.found) throw new Error(`importTopicData topic ${plan.topic.id} missing in transaction`)
          return {
            topic: topicToWireFull(created.data) as unknown as TopicWire,
            messageCount: plan.messages.length,
            blockCount: plan.blocks.length,
            branchCount: plan.branches.length,
            segmentCount: plan.segments.length,
            fileReferenceCount: plan.fileReferences.length
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('importTopicData', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('importTopicData', unsupportedBlockIds)
      return result
    }, `importTopicData(assistant=${request?.assistantId})`)
  }

  /**
   * Group-scoped clipboard READ for copy/cut (selected groups only).
   *
   * One authoritative SQLite transaction resolves every requested stable
   * clipboard group key with bounded topicId + id/askId reads in authority
   * order (sort_order ASC, id ASC) — never listByTopic, never a whole-topic
   * snapshot. Canonical `getMessageGroups` equivalence:
   * - user id keys its user row + all same-topic assistants with askId equal
   *   to that id (authority order);
   * - otherwise a non-empty askId with same-topic assistants keys the orphan
   *   assistant group (authority order);
   * - otherwise a system row id keys its singleton group.
   * Any other key (unknown id, tool/generic/assistant-without-askId message
   * id, or an id from another topic) forms no selectable clipboard group and
   * is filtered (skipped). Missing topic is NOT_FOUND; zero resolved groups
   * succeeds with empty arrays so the caller publishes nothing. Blocks come
   * from listByMessages over exactly the selected message IDs, and groups
   * return in authority order with positionIndex = first message sort_order
   * (paste sorts by positionIndex, so document order is preserved).
   */
  fetchClipboardGroups(request: FetchClipboardGroupsRequest): ChatDbResult<FetchClipboardGroupsResponse> {
    return wrapResult(
      () => {
        return this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const topic = repos.topics.getById(request.topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
          }

          const seen = new Set<string>()
          const requested: string[] = []
          for (const gid of request.groupIds ?? []) {
            if (typeof gid !== 'string' || gid.length === 0) {
              throw new ChatDbValidationError('groupIds must be a non-empty array of stable group keys')
            }
            if (seen.has(gid)) {
              throw new ChatDbValidationError('Duplicate groupId in the clipboard-groups request')
            }
            seen.add(gid)
            requested.push(gid)
          }
          if (requested.length === 0) {
            throw new ChatDbValidationError('groupIds must be a non-empty array of stable group keys')
          }
          type ResolvedGroup = { groupId: string; rows: MessageData[] }
          const resolved: ResolvedGroup[] = []
          // Branch-route clipboard path: resolve groups from the effective
          // route (shared prefix through each anchor + owned suffix,
          // deterministic order) instead of topic-bound rows, so inherited
          // groups copy from the branch view. Main routes keep the
          // topic-bound path below (already main-route scoped).
          const clipboardBranchId = this.normalizeBranchId(request.branchId)
          if (clipboardBranchId !== null) {
            const effectiveForClipboard = this.resolveRouteMessagesInTx(
              repos,
              request.topicId,
              clipboardBranchId
            ).messages
            const byId = new Map(effectiveForClipboard.map((m) => [m.id, m]))
            const assistantsByAskId = new Map<string, MessageData[]>()
            for (const m of effectiveForClipboard) {
              const askId = (m as unknown as { askId: string | null }).askId
              if (m.role === 'assistant' && typeof askId === 'string' && askId.length > 0) {
                const list = assistantsByAskId.get(askId) ?? []
                list.push(m)
                assistantsByAskId.set(askId, list)
              }
            }
            for (const gid of requested) {
              const row = byId.get(gid)
              if (row && row.role === 'user') {
                resolved.push({ groupId: gid, rows: [row, ...(assistantsByAskId.get(gid) ?? [])] })
                continue
              }
              const assistants = assistantsByAskId.get(gid) ?? []
              if (assistants.length > 0) {
                resolved.push({ groupId: gid, rows: [...assistants] })
                continue
              }
              if (row && row.role === 'system') {
                resolved.push({ groupId: gid, rows: [row] })
              }
            }
            resolved.sort((a, b) => {
              const ar = a.rows[0]
              const br = b.rows[0]
              if (ar.sortOrder !== br.sortOrder) return ar.sortOrder - br.sortOrder
              return ar.id < br.id ? -1 : ar.id > br.id ? 1 : 0
            })
            const orderedRows = resolved.flatMap((g) => g.rows)
            const orderedIds = orderedRows.map((r) => r.id)
            const blockMap = repos.blocks.listByMessages(orderedIds)
            const allBlocks: MessageBlockData[] = []
            for (const id of orderedIds) {
              allBlocks.push(...(blockMap.get(id) ?? []))
            }
            const wireMessages = messagesToWire(orderedRows)
            const wireBlocks = blocksToWire(allBlocks)
            const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
            const groups = resolved.map((g) => ({
              groupId: g.groupId,
              messageIds: g.rows.map((r) => r.id),
              positionIndex: g.rows[0].sortOrder
            }))
            const firstMessageId = orderedRows.length > 0 ? orderedRows[0].id : null
            const lastMessageId = orderedRows.length > 0 ? orderedRows[orderedRows.length - 1].id : null
            return {
              messages: messagesWithBlocks,
              blocks: wireBlocks,
              groups,
              clipboard: {
                completeness: 'clipboard-groups' as const,
                topicId: request.topicId,
                requestedCount: requested.length,
                returnedCount: groups.length,
                returnedMessageCount: orderedRows.length,
                firstMessageId,
                lastMessageId
              }
            }
          }
          for (const gid of requested) {
            // Step 1: user row keys its group (user + same-askId assistants).
            const inTopic = repos.messages.getInTopic(gid, request.topicId)
            if (inTopic.found && inTopic.data.role === 'user') {
              const assistants = repos.messages.listAssistantsByAskId(request.topicId, gid)
              resolved.push({ groupId: gid, rows: [inTopic.data, ...assistants] })
              continue
            }
            // Step 2: non-empty askId with same-topic assistants keys the
            // (possibly orphan) assistant group.
            const assistants = repos.messages.listAssistantsByAskId(request.topicId, gid)
            if (assistants.length > 0) {
              resolved.push({ groupId: gid, rows: assistants })
              continue
            }
            // Step 3: system row keys its singleton group.
            if (inTopic.found && inTopic.data.role === 'system') {
              resolved.push({ groupId: gid, rows: [inTopic.data] })
              continue
            }
            // Anything else forms no selectable clipboard group: skip (missing,
            // cross-topic, tool/generic/assistant-without-askId message id).
          }
          // Authority order across groups by first-row (sort_order, id).
          resolved.sort((a, b) => {
            const ar = a.rows[0]
            const br = b.rows[0]
            if (ar.sortOrder !== br.sortOrder) return ar.sortOrder - br.sortOrder
            return ar.id < br.id ? -1 : ar.id > br.id ? 1 : 0
          })
          const orderedRows = resolved.flatMap((g) => g.rows)
          const orderedIds = orderedRows.map((r) => r.id)
          const blockMap = repos.blocks.listByMessages(orderedIds)
          const allBlocks: MessageBlockData[] = []
          for (const id of orderedIds) {
            allBlocks.push(...(blockMap.get(id) ?? []))
          }
          const wireMessages = messagesToWire(orderedRows)
          const wireBlocks = blocksToWire(allBlocks)
          const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
          const groups = resolved.map((g) => ({
            groupId: g.groupId,
            messageIds: g.rows.map((r) => r.id),
            positionIndex: g.rows[0].sortOrder
          }))
          const firstMessageId = orderedRows.length > 0 ? orderedRows[0].id : null
          const lastMessageId = orderedRows.length > 0 ? orderedRows[orderedRows.length - 1].id : null
          return {
            messages: messagesWithBlocks,
            blocks: wireBlocks,
            groups,
            clipboard: {
              completeness: 'clipboard-groups' as const,
              topicId: request.topicId,
              requestedCount: requested.length,
              returnedCount: groups.length,
              returnedMessageCount: orderedRows.length,
              firstMessageId,
              lastMessageId
            }
          }
        })
      },
      `fetchClipboardGroups(${request.topicId}, ${request.groupIds?.length ?? 0} groups)`
    )
  }
  /**
   * Bounded authority READ of one clipboard closure (opt-in "include child
   * branches").
   *
   * ONE Main SQLite transaction resolves the requested stable group keys on
   * the source ACTIVE route (shared prefix + owned suffix), then includes
   * every direct child branch of that route whose anchor is one of the
   * selected root messages, each with its complete subtree and ONLY the rows
   * those branches own. Unrelated ancestors, sibling branches and shared
   * prefixes are never pulled in: a descendant contributes its own rows and
   * never re-materializes an ancestor prefix.
   *
   * Complete rows are read from SQLite (never the loaded window). An
   * unresolvable group key, a branch whose anchor is outside the captured
   * closure, or a depth overflow fails closed with zero payload — a tree
   * payload never silently drops a selected branch or its content.
   *
   * `clipboard.ownedRootMessageIds` are the roots `cut` may delete;
   * `clipboard.inheritedRootMessageIds` are copy-only roots read through the
   * route (cutting them fails closed because Main never deletes rows it does
   * not own).
   */
  fetchClipboardTree(request: FetchClipboardTreeRequest): ChatDbResult<FetchClipboardTreeResponse> {
    const branchOwned = isBranchOwnedClipboardTreeRequest(request)
    const requestedGroupIds = branchOwned ? [] : Array.isArray(request.groupIds) ? request.groupIds : []
    return wrapResult(
      () => {
        return this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const topic = repos.topics.getById(request.topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
          }
          const sourceBranchId = this.normalizeBranchId(request.branchId)
          if (sourceBranchId !== null) {
            this.requireBranchInTx(repos, request.topicId, sourceBranchId)
          }
          const closure = branchOwned
            ? this.deriveBranchOwnedClipboardTreeClosureInTx(repos, request.topicId, sourceBranchId)
            : this.deriveClipboardTreeClosureInTx(repos, request.topicId, sourceBranchId, requestedGroupIds)
          const capturedIds = closure.capturedMessages.map((row) => row.id)
          const blockMap = repos.blocks.listByMessages(capturedIds)
          const capturedBlocks: MessageBlockData[] = []
          for (const id of capturedIds) {
            capturedBlocks.push(...(blockMap.get(id) ?? []))
          }
          const wireBlocks = blocksToWire(capturedBlocks)
          const wireMessages = reconstructMessageBlockRelations(messagesToWire(closure.capturedMessages), wireBlocks)
          const roots = closure.resolvedGroups.map((group) => ({
            groupId: group.groupId,
            messageIds: group.rows.map((row) => row.id),
            positionIndex: group.rows[0].sortOrder
          }))
          const branches = closure.branches.map((entry) => ({
            sourceBranchId: entry.data.id,
            parentSourceBranchId: entry.data.parentBranchId ?? null,
            anchorMessageId: entry.data.anchorMessageId,
            name: entry.data.name ?? null,
            depth: entry.depth,
            overflow: (entry.data.overflow ?? {}) as JsonObject
          }))
          const segments = closure.segments.map((entry) => ({
            sourceSegmentId: entry.data.id,
            name: entry.data.name ?? null,
            sortOrder: entry.data.sortOrder,
            headerMessageId: entry.data.headerMessageId ?? null,
            memberIds: entry.memberIds,
            overflow: (entry.data.overflow ?? {}) as JsonObject
          }))
          const firstMessageId = capturedIds.length > 0 ? capturedIds[0] : null
          const lastMessageId = capturedIds.length > 0 ? capturedIds[capturedIds.length - 1] : null
          return {
            tree: {
              source: { topicId: request.topicId, branchId: sourceBranchId },
              roots,
              messages: wireMessages,
              blocks: wireBlocks,
              branches,
              segments
            },
            clipboard: {
              completeness: 'clipboard-tree' as const,
              topicId: request.topicId,
              branchId: sourceBranchId,
              // One trunk for a branch-owned capture; the selected stable keys
              // for a selection capture.
              requestedCount: branchOwned ? 1 : requestedGroupIds.length,
              returnedCount: roots.length,
              returnedMessageCount: capturedIds.length,
              returnedBranchCount: branches.length,
              returnedSegmentCount: segments.length,
              ownedRootMessageIds: closure.ownedRootMessageIds,
              inheritedRootMessageIds: closure.inheritedRootMessageIds,
              firstMessageId,
              lastMessageId
            }
          }
        })
      },
      `fetchClipboardTree(${request.topicId}, ${branchOwned ? 'branch-owned' : `${requestedGroupIds.length} groups`})`
    )
  }

  /**
   * Resolve stable clipboard group keys against ONE effective route.
   *
   * Canonical `getMessageGroups` equivalence (identical to the group-scoped
   * read): a user id keys its user row plus every assistant with that askId, a
   * non-empty askId keys its (possibly orphan) assistant group, a system id
   * keys its singleton group. Unlike the legacy read this fails closed: a key
   * that forms no group would silently lose content from a tree payload.
   */
  private resolveClipboardGroupRowsInTx(
    routeMessages: MessageData[],
    groupIds: string[]
  ): Array<{ groupId: string; rows: MessageData[] }> {
    const byId = new Map<string, MessageData>()
    const assistantsByAskId = new Map<string, MessageData[]>()
    for (const message of routeMessages) {
      byId.set(message.id, message)
      const askId = message.askId
      if (message.role === 'assistant' && typeof askId === 'string' && askId.length > 0) {
        const list = assistantsByAskId.get(askId) ?? []
        list.push(message)
        assistantsByAskId.set(askId, list)
      }
    }
    const routeIndex = new Map(routeMessages.map((message, index) => [message.id, index]))
    const resolved: Array<{ groupId: string; rows: MessageData[] }> = []
    const seen = new Set<string>()
    for (const groupId of groupIds) {
      if (typeof groupId !== 'string' || groupId.length === 0) {
        throw new ChatDbValidationError('groupIds must be a non-empty array of stable group keys')
      }
      if (seen.has(groupId)) {
        throw new ChatDbValidationError('Duplicate groupId in the clipboard-tree request')
      }
      seen.add(groupId)
      const row = byId.get(groupId)
      if (row && row.role === 'user') {
        resolved.push({ groupId, rows: [row, ...(assistantsByAskId.get(groupId) ?? [])] })
        continue
      }
      const assistants = assistantsByAskId.get(groupId) ?? []
      if (assistants.length > 0) {
        resolved.push({ groupId, rows: [...assistants] })
        continue
      }
      if (row && row.role === 'system') {
        resolved.push({ groupId, rows: [row] })
        continue
      }
      throw new ChatDbValidationError(
        `Group ${groupId} does not belong to the addressed source route (unknown key or non-selectable role)`
      )
    }
    resolved.sort((a, b) => {
      const ai = routeIndex.get(a.rows[0].id) ?? Number.MAX_SAFE_INTEGER
      const bi = routeIndex.get(b.rows[0].id) ?? Number.MAX_SAFE_INTEGER
      if (ai !== bi) return ai - bi
      return a.rows[0].id < b.rows[0].id ? -1 : a.rows[0].id > b.rows[0].id ? 1 : 0
    })
    return resolved
  }

  /**
   * Derive the clipboard closure of the supplied group keys from authority
   * rows only (no renderer state, no loaded-window derivation).
   *
   * Fail-closed invariants, all evaluated before any caller writes:
   * - every requested key resolves to a complete group of the source route;
   * - every included branch's anchor is part of the already-captured closure
   *   (otherwise the mapped anchor could not exist in the target);
   * - the included branch forest stays inside `MAX_BRANCH_DEPTH`.
   */
  private deriveClipboardTreeClosureInTx(
    repos: ChatDbRepositories,
    topicId: string,
    sourceBranchId: string | null,
    groupIds: string[]
  ): ClipboardTreeClosure {
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
      throw new ChatDbValidationError('groupIds must be a non-empty array of stable group keys')
    }
    const routeMessages = this.resolveRouteMessagesInTx(repos, topicId, sourceBranchId).messages
    const routeIndex = new Map(routeMessages.map((message, index) => [message.id, index]))
    const resolvedGroups = this.resolveClipboardGroupRowsInTx(routeMessages, groupIds)
    const rootRows: MessageData[] = []
    const rootIdSet = new Set<string>()
    for (const group of resolvedGroups) {
      for (const row of group.rows) {
        if (rootIdSet.has(row.id)) continue
        rootIdSet.add(row.id)
        rootRows.push(row)
      }
    }
    rootRows.sort((a, b) => (routeIndex.get(a.id) ?? 0) - (routeIndex.get(b.id) ?? 0))
    const ownership = this.splitClipboardTreeRootOwnership(rootRows, topicId, sourceBranchId)
    const capturedMessages: MessageData[] = [...rootRows]
    const capturedMessageIds = new Set<string>(rootIdSet)
    // Branch forest: direct children of the source route whose anchor is one
    // of the selected root messages, then their complete subtrees.
    const forest = this.captureClipboardTreeForestInTx(
      repos,
      topicId,
      sourceBranchId,
      capturedMessages,
      capturedMessageIds,
      (children, sortChildren) => sortChildren(children).filter((branch) => rootIdSet.has(branch.anchorMessageId))
    )
    return {
      topicId,
      branchId: sourceBranchId,
      resolvedGroups,
      rootRows,
      ownedRootMessageIds: ownership.owned,
      inheritedRootMessageIds: ownership.inherited,
      branches: forest.branches,
      ownedByBranch: forest.ownedByBranch,
      capturedMessages,
      capturedMessageIds,
      segments: forest.segments
    }
  }

  /**
   * Branch-owned closure: ONE branch's own rows are the root trunk and every
   * descendant branch contributes only the rows it owns.
   *
   * The branch is addressed explicitly (it may be inactive), so no group has to
   * be selected first and no inherited parent prefix is read: the payload is the
   * complete OWNED subtree of that branch. The source branch's own node is never
   * part of the payload — a paste does not re-create it — while descendant nodes
   * keep their names, parents and anchors.
   *
   * Fail-closed, before any publication:
   * - the branch owns at least one row (an empty trunk is not a copyable tree);
   * - every included descendant anchor is inside the captured rows (a repaired
   *   or dangling anchor pointing at an inherited parent row cannot be preserved
   *   without inventing the prefix that is deliberately not copied);
   * - the included forest stays inside `MAX_BRANCH_DEPTH`.
   */
  private deriveBranchOwnedClipboardTreeClosureInTx(
    repos: ChatDbRepositories,
    topicId: string,
    sourceBranchId: string | null
  ): ClipboardTreeClosure {
    if (sourceBranchId === null) {
      throw new ChatDbValidationError('A branch-owned capture requires an explicit branch route')
    }
    this.requireBranchInTx(repos, topicId, sourceBranchId)
    // Own rows only, in authority order; ownership is topic AND branch.
    const rootRows = repos.messages.listByTopic(topicId, sourceBranchId)
    if (rootRows.length === 0) {
      throw new ChatDbValidationError(`Branch ${sourceBranchId} owns no messages, so there is no branch tree to copy`)
    }
    const capturedMessages: MessageData[] = [...rootRows]
    const capturedMessageIds = new Set<string>(rootRows.map((row) => row.id))
    // The whole owned subtree is included: a descendant is never dropped for
    // being anchored at a row that was not selected, and the shared forest
    // capture below still validates every anchor against the captured rows.
    const forest = this.captureClipboardTreeForestInTx(
      repos,
      topicId,
      sourceBranchId,
      capturedMessages,
      capturedMessageIds,
      (children, sortChildren) => sortChildren(children)
    )
    const ownership = this.splitClipboardTreeRootOwnership(rootRows, topicId, sourceBranchId)
    return {
      topicId,
      branchId: sourceBranchId,
      resolvedGroups: this.groupBranchOwnedClipboardRows(rootRows),
      rootRows,
      ownedRootMessageIds: ownership.owned,
      inheritedRootMessageIds: ownership.inherited,
      branches: forest.branches,
      ownedByBranch: forest.ownedByBranch,
      capturedMessages,
      capturedMessageIds,
      segments: forest.segments
    }
  }

  /**
   * Capture the owned rows of one branch forest, plus every segment whose
   * complete membership is inside the captured rows.
   *
   * Shared policy of both clipboard-tree capture shapes: children are visited
   * breadth-first with parents before children, each branch contributes exactly
   * the rows it OWNS, every included branch's anchor must already be part of the
   * captured closure, and the forest must stay inside `MAX_BRANCH_DEPTH`. The
   * caller only decides WHICH direct children are included.
   */
  private captureClipboardTreeForestInTx(
    repos: ChatDbRepositories,
    topicId: string,
    sourceBranchId: string | null,
    capturedMessages: MessageData[],
    capturedMessageIds: Set<string>,
    selectDirectChildren: (
      children: TopicBranchData[],
      sortChildren: (list: TopicBranchData[]) => TopicBranchData[]
    ) => TopicBranchData[]
  ): Pick<ClipboardTreeClosure, 'branches' | 'ownedByBranch' | 'segments'> {
    const allBranches = repos.branches.listByTopic(topicId)
    const childrenByParent = new Map<string | null, TopicBranchData[]>()
    for (const branch of allBranches) {
      const parent = branch.parentBranchId ?? null
      const list = childrenByParent.get(parent) ?? []
      list.push(branch)
      childrenByParent.set(parent, list)
    }
    // Anchor order is the captured root order, so a forest lists its branches
    // the way they appear on the route; ids break ties deterministically.
    const anchorOrder = new Map(capturedMessages.map((row, index) => [row.id, index]))
    const sortChildren = (list: TopicBranchData[]): TopicBranchData[] =>
      [...list].sort((a, b) => {
        const ai = anchorOrder.get(a.anchorMessageId) ?? Number.MAX_SAFE_INTEGER
        const bi = anchorOrder.get(b.anchorMessageId) ?? Number.MAX_SAFE_INTEGER
        if (ai !== bi) return ai - bi
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
    const branches: ClipboardTreeClosureBranch[] = []
    const ownedByBranch: Array<{ branchId: string; rows: MessageData[] }> = []
    const visit = (queue: Array<{ branch: TopicBranchData; depth: number }>): void => {
      for (const entry of queue) {
        const { branch, depth } = entry
        if (depth > MAX_BRANCH_DEPTH) {
          throw new ChatDbValidationError(
            `Included child branch ${branch.id} exceeds the maximum branch depth (${MAX_BRANCH_DEPTH})`
          )
        }
        if (!capturedMessageIds.has(branch.anchorMessageId)) {
          throw new ChatDbValidationError(
            `Included child branch ${branch.id} anchors at message ${branch.anchorMessageId}, which is outside the captured closure`
          )
        }
        const rows = repos.messages.listByTopic(topicId, branch.id)
        branches.push({ data: branch, depth })
        ownedByBranch.push({ branchId: branch.id, rows })
        for (const row of rows) {
          if (capturedMessageIds.has(row.id)) continue
          capturedMessageIds.add(row.id)
          capturedMessages.push(row)
        }
        visit(sortChildren(childrenByParent.get(branch.id) ?? []).map((child) => ({ branch: child, depth: depth + 1 })))
      }
    }
    visit(
      selectDirectChildren(childrenByParent.get(sourceBranchId) ?? [], sortChildren).map((branch) => ({
        branch,
        depth: 1
      }))
    )
    // Segments: only fully-contained membership (never a partial slice).
    const segments: ClipboardTreeClosureSegment[] = []
    for (const segment of repos.segments.listByTopic(topicId)) {
      const memberIds = repos.segments.getMessageIds(segment.id)
      if (memberIds.length === 0) continue
      if (!memberIds.every((id) => capturedMessageIds.has(id))) continue
      const header = segment.headerMessageId ?? null
      if (header !== null && !memberIds.includes(header)) continue
      segments.push({ data: segment, memberIds })
    }
    return { branches, ownedByBranch, segments }
  }

  /**
   * Split captured root rows into the ones this route OWNS (deletable by a cut)
   * and the ones it merely reads through (copy-only).
   *
   * Owner = the addressing topic AND the addressed route. A cross-topic
   * reference prefix materialized into this route keeps its OWN topicId while
   * carrying `branchId = null`, so a branch-only comparison would report live
   * foreign prefix rows as mutable roots here and hand them to the cut capture
   * even though every write path rejects them. Same owner predicate as
   * `insertMessageGroups`.
   */
  private splitClipboardTreeRootOwnership(
    rootRows: MessageData[],
    topicId: string,
    route: string | null
  ): { owned: string[]; inherited: string[] } {
    const owned: string[] = []
    const inherited: string[] = []
    for (const row of rootRows) {
      if ((row.branchId ?? null) === route && row.topicId === topicId) owned.push(row.id)
      else inherited.push(row.id)
    }
    return { owned, inherited }
  }

  /**
   * Group one branch's OWN rows into clipboard groups (no renderer grouping).
   *
   * A user row keys its own group; an assistant joins the group of the OWN user
   * row its `askId` points at. An assistant whose ask resolves to no own user row
   * (the branch was forked from an inherited question) still belongs to this
   * branch's trunk: it is keyed by a stable own key — the first such answer of
   * that ask, so sibling answers stay together — and keeps its wire `askId`,
   * which the paste plan turns into an orphan assistant group instead of
   * inventing the parent row this capture deliberately does not contain. A
   * system row is its own singleton group.
   */
  private groupBranchOwnedClipboardRows(rows: MessageData[]): Array<{ groupId: string; rows: MessageData[] }> {
    const groups: Array<{ groupId: string; rows: MessageData[] }> = []
    const groupByUserId = new Map<string, { groupId: string; rows: MessageData[] }>()
    const groupByForeignAskId = new Map<string, { groupId: string; rows: MessageData[] }>()
    const addGroup = (groupId: string, row: MessageData): { groupId: string; rows: MessageData[] } => {
      const group = { groupId, rows: [row] }
      groups.push(group)
      return group
    }
    for (const row of rows) {
      if (row.role === 'user') {
        groupByUserId.set(row.id, addGroup(row.id, row))
        continue
      }
      if (row.role === 'assistant') {
        const askId = typeof row.askId === 'string' && row.askId.length > 0 ? row.askId : null
        if (askId !== null) {
          const ownUserGroup = groupByUserId.get(askId)
          if (ownUserGroup) {
            ownUserGroup.rows.push(row)
            continue
          }
          const foreignAskGroup = groupByForeignAskId.get(askId)
          if (foreignAskGroup) {
            foreignAskGroup.rows.push(row)
            continue
          }
          groupByForeignAskId.set(askId, addGroup(row.id, row))
          continue
        }
      }
      // System rows (and a standalone assistant without an ask): a stable
      // singleton group keyed by the row itself.
      addGroup(row.id, row)
    }
    return groups
  }

  /**
   * Resolve the root-run insertion index of a tree paste against ONE explicit
   * target route.
   *
   * Owner-order intent resolution (same semantics as the group insert
   * command): `topic-tail` appends to the route owner's rows; an OWNED anchor
   * uses the answer-group tail (`after-group-tail`) or the exact preceding
   * index (`before-message`); an INHERITED anchor stays read-only except for
   * the single inherited boundary the addressed route may extend. For a branch
   * route that boundary is the branch fork anchor (the run goes to the owner
   * head; `before-message` keeps its legacy owner-tail semantics). For the main
   * route it is the cross-topic reference endpoint — the endpoint row itself,
   * or its resolved group tail for `after-group-tail` — and nothing else: an
   * older foreign prefix row, and any `before-message` on a row this owner does
   * not hold, fails closed before any write, exactly as the ordinary group
   * insertion does. Ownership is topic AND branch; a reference prefix keeps its
   * own topicId while addressing `branchId = null`.
   */
  private resolveClipboardTreeInsertIndexInTx(
    repos: ChatDbRepositories,
    topicId: string,
    route: string | null,
    intent: Record<string, unknown>
  ): { ownerIndex: number; ownerStart: MessageData[] } {
    const resolvedRoute = this.resolveRouteMessagesInTx(repos, topicId, route)
    const routeStart = resolvedRoute.messages
    const forkBoundaryIndex = resolvedRoute.forkBoundaryIndex
    const ownerStart = repos.messages.listByTopic(topicId, route)
    const ownerIndexById = new Map<string, number>()
    for (let i = 0; i < ownerStart.length; i++) ownerIndexById.set(ownerStart[i].id, i)
    const kind = intent?.kind
    if (kind !== 'after-group-tail' && kind !== 'before-message' && kind !== 'topic-tail') {
      throw new ChatDbValidationError('target.intent.kind must be a stable intent kind')
    }
    if (kind === 'topic-tail') return { ownerIndex: ownerStart.length, ownerStart }
    const messageId = intent?.messageId
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new ChatDbValidationError('target.intent.messageId must be a non-empty string')
    }
    const anchor = routeStart.find((message) => message.id === messageId)
    if (!anchor) {
      throw new ChatDbNotFoundError(`Anchor message ${messageId} does not belong to topic ${topicId}`)
    }
    if ((anchor.branchId ?? null) !== route || anchor.topicId !== topicId) {
      // Inherited anchor: read-only through this route except its single
      // boundary. Ownership is topic AND branch — a reference prefix keeps its
      // own topicId while addressing `branchId = null`, so a branch-only
      // comparison would treat a live foreign row as an owned anchor and place
      // the run at an index this owner never resolved.
      if (route === null) {
        // Cross-topic reference fork boundary: only the exact foreign endpoint
        // (the reference anchor, or its resolved group tail for
        // `after-group-tail`) may receive insertions at the START of the
        // target's own suffix. Older prefix rows are read-only, and so is any
        // `before-message` on a row this owner does not hold — ordinary group
        // insertion rejects both rather than inventing a position.
        const ref = repos.topicReferences.getByTarget(topicId)
        let isReferenceFork = ref.found && ref.data.anchorMessageId === messageId
        if (!isReferenceFork && ref.found && kind === 'after-group-tail') {
          const tailPlusOne = this.resolveAfterGroupTailFullIndex(routeStart, anchor)
          isReferenceFork = routeStart[tailPlusOne - 1]?.id === ref.data.anchorMessageId
        }
        if (!isReferenceFork) {
          throw new ChatDbValidationError(
            `Anchor message ${messageId} is not owned by this route and insertion is read-only`
          )
        }
        return { ownerIndex: 0, ownerStart }
      }
      // Branch route: `before-message` keeps its legacy owner-tail semantics.
      if (kind === 'before-message') return { ownerIndex: ownerStart.length, ownerStart }
      const tailPlusOne = this.resolveAfterGroupTailFullIndex(routeStart, anchor)
      const tailIdx = tailPlusOne - 1
      const tailId = routeStart[tailIdx]?.id ?? null
      const forkId = this.requireBranchInTx(repos, topicId, route).anchorMessageId
      if (tailId !== forkId || tailIdx !== forkBoundaryIndex - 1) {
        throw new ChatDbValidationError(
          `Anchor message ${messageId} is an ancestor reference and is read-only through this route`
        )
      }
      return { ownerIndex: 0, ownerStart }
    }
    const ownerIndex =
      kind === 'before-message'
        ? (ownerIndexById.get(messageId) as number)
        : this.resolveAfterGroupTailFullIndex(ownerStart, anchor)
    return { ownerIndex, ownerStart }
  }

  /**
   * Build the fully-remapped target insert plan of one clipboard payload.
   *
   * Every captured row gets an INDEPENDENT fresh ID; `askId`, block references,
   * branch parents/anchors, and segment membership/header all point at the new
   * IDs. Roots land on the chosen target route (the caller's explicit route)
   * and branch-owned rows on their generated branch, so no shared prefix,
   * ancestor or sibling topology is ever re-created.
   */
  private buildClipboardTreePlanFromPayload(
    repos: ChatDbRepositories,
    payload: ClipboardTreePayload,
    targetTopicId: string,
    targetRoute: string | null,
    placement: ClipboardTreePlacement
  ): {
    plan: ClipboardTreeInsertPlan
    idMap: ClipboardTreeIdMapRow[]
    sourceRootMessageIds: string[]
    insertedRootMessageIds: string[]
  } {
    const sourceBranchId = payload.source.branchId ?? null
    const messageWires = payload.messages as unknown as Array<Record<string, unknown>>
    const blockWires = payload.blocks as unknown as Array<Record<string, unknown>>
    const rootIdSet = new Set<string>()
    const sourceRootMessageIds: string[] = []
    for (const root of payload.roots) {
      for (const id of root.messageIds) {
        if (rootIdSet.has(id)) continue
        rootIdSet.add(id)
        sourceRootMessageIds.push(id)
      }
    }
    if (rootIdSet.size === 0) {
      throw new ChatDbValidationError('Clipboard tree payload carries no selected root messages')
    }
    const messageIdMap = new Map<string, string>()
    for (const wire of messageWires) messageIdMap.set(String(wire.id), randomUUID())
    const blockIdMap = new Map<string, string>()
    for (const wire of blockWires) blockIdMap.set(String(wire.id), randomUUID())
    const branchIdMap = new Map<string, string>()
    for (const branch of payload.branches) branchIdMap.set(branch.sourceBranchId, randomUUID())
    const sourceOwnerById = new Map<string, string | null>()
    for (const wire of messageWires) sourceOwnerById.set(String(wire.id), (wire.branchId ?? null) as string | null)
    const targetOwnerFor = (sourceId: string): string | null => {
      if (rootIdSet.has(sourceId)) return targetRoute
      const sourceOwner = sourceOwnerById.get(sourceId) ?? null
      if (sourceOwner === null) {
        throw new ChatDbValidationError(
          `Message ${sourceId} is neither a selected root nor owned by an included branch`
        )
      }
      const mapped = branchIdMap.get(sourceOwner)
      if (mapped === undefined) {
        throw new ChatDbValidationError(
          `Message ${sourceId} is owned by branch ${sourceOwner}, which is not part of the captured branch set`
        )
      }
      return mapped
    }
    const rootRows: MessageData[] = []
    const rootWires = new Map<string, JsonObject>()
    const branchRowsById = new Map<string, MessageData[]>()
    const branchWiresById = new Map<string, Map<string, JsonObject>>()
    for (const branch of payload.branches) {
      const generated = branchIdMap.get(branch.sourceBranchId) as string
      branchRowsById.set(generated, [])
      branchWiresById.set(generated, new Map())
    }
    for (const wire of messageWires) {
      const sourceId = String(wire.id)
      const newId = messageIdMap.get(sourceId) as string
      const ownerTarget = targetOwnerFor(sourceId)
      const wireCopy = { ...wire } as JsonObject
      const declaredBlocks = Array.isArray(wire.blocks) ? (wire.blocks as unknown[]).map((id) => String(id)) : []
      const mappedBlocks = declaredBlocks
        .map((id) => blockIdMap.get(id))
        .filter((id): id is string => typeof id === 'string')
      delete (wireCopy as Record<string, unknown>).blocks
      const row = wireToMessage(wireCopy)
      row.id = newId
      row.topicId = targetTopicId
      row.branchId = ownerTarget
      row.sortOrder = 0
      const sourceAskId = typeof wire.askId === 'string' && wire.askId.length > 0 ? wire.askId : null
      if (row.role === 'assistant' && sourceAskId !== null) {
        // Only a captured target remaps; an ask outside the closure becomes an
        // orphan assistant group instead of a dangling cross-topic reference.
        row.askId = messageIdMap.get(sourceAskId) ?? null
      }
      const wireForOrder = { ...(wireCopy as Record<string, unknown>), blocks: mappedBlocks } as unknown as JsonObject
      if (rootIdSet.has(sourceId) && ownerTarget === targetRoute) {
        rootRows.push(row)
        rootWires.set(newId, wireForOrder)
      } else {
        if (ownerTarget === null) {
          throw new ChatDbValidationError(`Message ${sourceId} has no resolvable target owner`)
        }
        const targetRows = branchRowsById.get(ownerTarget)
        const targetWires = branchWiresById.get(ownerTarget)
        if (!targetRows || !targetWires) {
          throw new ChatDbValidationError(`Message ${sourceId} owns to an unknown branch ${ownerTarget}`)
        }
        targetRows.push(row)
        targetWires.set(newId, wireForOrder)
      }
    }
    const blocksByMessage = new Map<string, MessageBlockData[]>()
    const planBlocks: MessageBlockData[] = []
    for (const wire of blockWires) {
      const sourceBlockId = String(wire.id)
      const newBlockId = blockIdMap.get(sourceBlockId) as string
      const sourceParent = String(wire.messageId)
      const parent = messageIdMap.get(sourceParent)
      if (parent === undefined) {
        throw new ChatDbValidationError(
          `Block ${sourceBlockId} belongs to message ${sourceParent}, which is not part of the captured closure`
        )
      }
      const blockRow = wireToBlock({ ...wire, id: newBlockId, messageId: parent } as unknown as JsonObject)
      blockRow.id = newBlockId
      blockRow.messageId = parent
      planBlocks.push(blockRow)
      const list = blocksByMessage.get(parent) ?? []
      list.push(blockRow)
      blocksByMessage.set(parent, list)
    }
    for (const [messageId, wire] of rootWires) {
      this.assignAuthoritativeBlockOrder(wire, blocksByMessage.get(messageId) ?? [])
    }
    const planBranches: ClipboardTreeInsertPlan['branches'] = []
    for (const branch of payload.branches) {
      const generatedId = branchIdMap.get(branch.sourceBranchId) as string
      const isDirectChild = (branch.parentSourceBranchId ?? null) === sourceBranchId
      let parentBranchId: string | null = targetRoute
      if (!isDirectChild) {
        const mappedParent = branchIdMap.get(branch.parentSourceBranchId as string)
        if (mappedParent === undefined) {
          throw new ChatDbValidationError(
            `Included branch ${branch.sourceBranchId} has parent ${String(branch.parentSourceBranchId)}, which is not part of the captured branch set`
          )
        }
        parentBranchId = mappedParent
      }
      const anchorMessageId = messageIdMap.get(branch.anchorMessageId)
      if (anchorMessageId === undefined) {
        throw new ChatDbValidationError(
          `Included branch ${branch.sourceBranchId} anchors at ${branch.anchorMessageId}, which is not part of the captured closure`
        )
      }
      planBranches.push({
        branch: {
          id: generatedId,
          topicId: targetTopicId,
          parentBranchId,
          anchorMessageId,
          name: branch.name ?? null,
          createdAt: null,
          updatedAt: null,
          overflow: branch.overflow ?? {}
        },
        rows: branchRowsById.get(generatedId) ?? [],
        wires: branchWiresById.get(generatedId) ?? new Map()
      })
    }
    const segmentBase = repos.segments.listByTopic(targetTopicId).length
    const planSegments = payload.segments.map((segment, index) => {
      const generatedId = randomUUID()
      const memberIds = segment.memberIds.map((id) => {
        const mapped = messageIdMap.get(id)
        if (mapped === undefined) {
          throw new ChatDbValidationError(
            `Captured segment ${segment.sourceSegmentId} member ${id} is not part of the captured closure`
          )
        }
        return mapped
      })
      let headerMessageId: string | null = null
      if (segment.headerMessageId !== null) {
        const mappedHeader = messageIdMap.get(segment.headerMessageId)
        if (mappedHeader === undefined) {
          throw new ChatDbValidationError(
            `Captured segment ${segment.sourceSegmentId} header ${segment.headerMessageId} is not part of the captured closure`
          )
        }
        headerMessageId = mappedHeader
      }
      return {
        row: {
          id: generatedId,
          topicId: targetTopicId,
          name: segment.name ?? null,
          createdAt: null,
          updatedAt: null,
          sortOrder: segmentBase + index,
          headerMessageId,
          overflow: segment.overflow ?? {}
        },
        memberIds
      }
    })
    const idMap: ClipboardTreeIdMapRow[] = [
      ...[...messageIdMap].map(([sourceId, targetId]) => ({ kind: 'message' as const, sourceId, targetId })),
      ...[...blockIdMap].map(([sourceId, targetId]) => ({ kind: 'block' as const, sourceId, targetId })),
      ...[...branchIdMap].map(([sourceId, targetId]) => ({ kind: 'branch' as const, sourceId, targetId })),
      ...payload.segments.map((segment, index) => ({
        kind: 'segment' as const,
        sourceId: segment.sourceSegmentId,
        targetId: planSegments[index].row.id
      }))
    ]
    return {
      plan: {
        targetTopicId,
        targetRoute,
        placement,
        rootRows,
        rootWires,
        branches: planBranches,
        blocks: planBlocks,
        segments: planSegments
      },
      idMap,
      sourceRootMessageIds,
      insertedRootMessageIds: rootRows.map((row) => row.id)
    }
  }

  /**
   * Rebuild the same insert plan from a Main-produced snapshot (redo path).
   *
   * The recorded wires already carry the generated IDs and target owners, so a
   * redo re-inserts byte-identical rows: stable IDs, same branch topology, same
   * block order, same segment membership.
   */
  private buildClipboardTreePlanFromSnapshot(snapshot: ClipboardTreeSnapshot): ClipboardTreeInsertPlan {
    const targetTopicId = snapshot.placement.topicId
    const targetRoute = snapshot.placement.branchId ?? null
    const branchIds = new Set(snapshot.inserted.branches.map((branch) => branch.id))
    const messageWires = snapshot.inserted.messages as unknown as Array<Record<string, unknown>>
    const blockWires = snapshot.inserted.blocks as unknown as Array<Record<string, unknown>>
    const rootRows: MessageData[] = []
    const rootWires = new Map<string, JsonObject>()
    const branchRowsById = new Map<string, MessageData[]>()
    const branchWiresById = new Map<string, Map<string, JsonObject>>()
    for (const id of branchIds) {
      branchRowsById.set(id, [])
      branchWiresById.set(id, new Map())
    }
    for (const wire of messageWires) {
      const wireCopy = { ...wire } as JsonObject
      const declaredBlocks = Array.isArray(wire.blocks) ? (wire.blocks as unknown[]).map((id) => String(id)) : []
      delete (wireCopy as Record<string, unknown>).blocks
      const row = wireToMessage(wireCopy)
      row.sortOrder = 0
      const wireForOrder = { ...(wireCopy as Record<string, unknown>), blocks: declaredBlocks } as unknown as JsonObject
      const owner = row.branchId ?? null
      if (owner !== null && branchIds.has(owner)) {
        const targetRows = branchRowsById.get(owner) as MessageData[]
        targetRows.push(row)
        ;(branchWiresById.get(owner) as Map<string, JsonObject>).set(row.id, wireForOrder)
      } else if (owner === targetRoute) {
        rootRows.push(row)
        rootWires.set(row.id, wireForOrder)
      } else {
        throw new ChatDbValidationError(
          `Snapshot message ${row.id} has owner ${String(owner)}, which is neither the placement route nor a recorded branch`
        )
      }
    }
    const blocksByMessage = new Map<string, MessageBlockData[]>()
    const blocks: MessageBlockData[] = []
    for (const wire of blockWires) {
      const row = wireToBlock({ ...wire } as unknown as JsonObject)
      blocks.push(row)
      const list = blocksByMessage.get(row.messageId) ?? []
      list.push(row)
      blocksByMessage.set(row.messageId, list)
    }
    for (const [messageId, wire] of rootWires) {
      this.assignAuthoritativeBlockOrder(wire, blocksByMessage.get(messageId) ?? [])
    }
    for (const wires of branchWiresById.values()) {
      for (const [messageId, wire] of wires) {
        this.assignAuthoritativeBlockOrder(wire, blocksByMessage.get(messageId) ?? [])
      }
    }
    const planBranches: ClipboardTreeInsertPlan['branches'] = snapshot.inserted.branches.map((branch) => ({
      branch: {
        id: branch.id,
        topicId: targetTopicId,
        parentBranchId: branch.parentBranchId ?? null,
        anchorMessageId: branch.anchorMessageId,
        name: branch.name ?? null,
        createdAt: branch.createdAt ?? null,
        updatedAt: branch.updatedAt ?? null,
        overflow: branch.overflow ?? {}
      },
      rows: branchRowsById.get(branch.id) ?? [],
      wires: branchWiresById.get(branch.id) ?? new Map()
    }))
    return {
      targetTopicId,
      targetRoute,
      placement: snapshot.placement,
      rootRows,
      rootWires,
      branches: planBranches,
      blocks,
      segments: snapshot.inserted.segments.map((segment) => ({
        row: {
          id: segment.id,
          topicId: targetTopicId,
          name: segment.name ?? null,
          createdAt: segment.createdAt ?? null,
          updatedAt: segment.updatedAt ?? null,
          sortOrder: segment.sortOrder,
          headerMessageId: segment.headerMessageId ?? null,
          overflow: segment.overflow ?? {}
        },
        memberIds: segment.memberIds
      }))
    }
  }

  /**
   * Reject a captured forest that would be unresolvable under the target route.
   *
   * A captured tree is depth-valid only relative to the route it was cut from:
   * the same two-level closure pasted under a route that already sits 30
   * ancestors deep would create branches whose ancestry `ancestorsOf` can no
   * longer walk, silently truncating route composition. The capacity is
   * `MAX_BRANCH_DEPTH - 1` ancestors for the same reason documented on the
   * re-parent guard in `moveSelectedTurnsToNewBranch`. The check runs before the
   * first write so a rejection leaves the transaction untouched.
   */
  private assertClipboardTreeTargetDepthInTx(
    repos: ChatDbRepositories,
    targetRoute: string | null,
    plan: ClipboardTreeInsertPlan
  ): void {
    if (plan.branches.length === 0) return
    const maxResolvableAncestors = MAX_BRANCH_DEPTH - 1
    const targetAncestors = targetRoute === null ? 0 : repos.branches.ancestorsOf(targetRoute).length
    // Generated branch ids never collide with an existing route, so a parent that
    // is absent from this map is the placement route itself.
    const parentById = new Map<string, string | null>(
      plan.branches.map((entry) => [entry.branch.id, entry.branch.parentBranchId ?? null])
    )
    const depthCache = new Map<string, number>()
    const relativeDepthOf = (branchId: string, seen: Set<string>): number => {
      const cached = depthCache.get(branchId)
      if (cached !== undefined) return cached
      if (seen.has(branchId)) {
        throw new ChatDbValidationError(`Clipboard tree branch ${branchId} has a cyclic parent chain`)
      }
      seen.add(branchId)
      const parent = parentById.get(branchId) ?? null
      const depth = parent !== null && parentById.has(parent) ? relativeDepthOf(parent, seen) + 1 : 1
      seen.delete(branchId)
      depthCache.set(branchId, depth)
      return depth
    }
    for (const entry of plan.branches) {
      const ancestors = targetAncestors + relativeDepthOf(entry.branch.id, new Set())
      if (ancestors > maxResolvableAncestors) {
        throw new ChatDbValidationError(
          `Placing branch ${entry.branch.id} at the target route would exceed the maximum resolvable branch depth (${maxResolvableAncestors} ancestors)`
        )
      }
    }
  }

  /**
   * Write one remapped tree plan into the target topic inside the caller's
   * transaction, reusing the established creation patterns: per-owner ordered
   * message inserts, block upsert + file-reference sync, segment creation with
   * remapped membership/header, and existing sync capture/frame refresh for
   * newly included rows. Branch-owned rows stay local-only because the route
   * context is null for a branch target, and reference-target topics stay
   * local-only through `syncCtxForTopic`.
   */
  private insertClipboardTreePlanInTx(
    repos: ChatDbRepositories,
    stx: SyncTxExecutor,
    ctx: { deviceId: string; ts: number } | null,
    plan: ClipboardTreeInsertPlan
  ): { notify: boolean; unsupportedBlockIds: string[] } {
    // A captured forest is depth-valid only relative to its own source route; the
    // very same tree pasted under a deep target route can still overflow. Reject
    // before the first write of the whole transaction.
    this.assertClipboardTreeTargetDepthInTx(repos, plan.targetRoute, plan)
    for (const entry of plan.branches) {
      repos.branches.create(entry.branch)
    }
    if (plan.rootRows.length > 0) {
      repos.messages.insertManyAt(plan.rootRows, plan.placement.ownerIndex)
    }
    for (const entry of plan.branches) {
      if (entry.rows.length > 0) repos.messages.insertManyAt(entry.rows, 0)
    }
    if (plan.blocks.length > 0) {
      repos.blocks.upsertMany(plan.blocks)
      this.syncFileReferences(repos, plan.blocks)
    }
    if (plan.segments.length > 0) {
      repos.segments.createMany(plan.segments.map((segment) => segment.row))
      for (const segment of plan.segments) {
        if (segment.memberIds.length > 0) repos.segments.addMessages(segment.row.id, segment.memberIds)
        repos.segments.setHeaderMessageId(segment.row.id, segment.row.headerMessageId ?? null)
      }
    }
    const allRows = [...plan.rootRows, ...plan.branches.flatMap((entry) => entry.rows)]
    const unsupportedBlockIds: string[] = []
    let notify = false
    if (ctx) {
      let tsOffset = 0
      const nextTs = (): number => ctx.ts + tsOffset++
      let hasNewInclusion = false
      for (const row of allRows) {
        const post = repos.messages.getById(row.id)
        if (!post.found) throw new Error(`clipboard tree insert message ${row.id} missing in transaction`)
        // Branch-owned rows are local-only: they live on a generated branch and
        // never mint message upsert intent or a membership clock. Only the block
        // frame is marked dirty, mirroring importTopicData's branch skip.
        if ((post.data.branchId ?? null) !== null) {
          syncService.invalidateParentFrameInTx(stx, 'messageBlock', row.id)
          continue
        }
        if (!isStableMessageStatus(post.data.status)) continue
        hasNewInclusion = true
        if (!this.shouldCaptureMessageCreate(post.data)) continue
        const opTs = nextTs()
        this.ensureTopicClosureInTx(stx, plan.targetTopicId, opTs, ctx.deviceId)
        const full = this.syncMessagePayloadFull(post.data)
        delete full.sortOrder
        const opId = syncService.enqueueUpsertInTx(stx, 'message', row.id, full, opTs, ctx.deviceId)
        syncService.setMembershipClockInTx(stx, 'message', row.id, post.data.topicId, opTs, opId)
        notify = true
      }
      for (const block of plan.blocks) {
        const postBlock = repos.blocks.getById(block.id)
        if (!postBlock.found) throw new Error(`clipboard tree insert block ${block.id} missing in transaction`)
        const parent = repos.messages.getById(postBlock.data.messageId)
        if (!parent.found || !isStableMessageStatus(parent.data.status)) continue
        if ((parent.data.branchId ?? null) !== null) {
          syncService.invalidateParentFrameInTx(stx, 'messageBlock', parent.data.id)
          continue
        }
        if (!isStableBlockStatus(postBlock.data.status)) continue
        if (this.isUnsupportedBlock(postBlock.data)) {
          unsupportedBlockIds.push(block.id)
          continue
        }
        const opTs = nextTs()
        this.ensureBlockParentClosureInTx(stx, block.id, opTs, ctx.deviceId)
        const full = this.syncBlockPayloadFull(postBlock.data)
        delete full.sortOrder
        const opId = syncService.enqueueUpsertInTx(stx, 'message_block', block.id, full, opTs, ctx.deviceId)
        syncService.setMembershipClockInTx(stx, 'message_block', block.id, postBlock.data.messageId, opTs, opId)
        notify = true
      }
      if (hasNewInclusion) {
        if (
          syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, plan.targetTopicId, ctx.deviceId) === 'refreshed'
        ) {
          notify = true
        }
      }
      for (const row of allRows) {
        if ((row.branchId ?? null) !== null) {
          syncService.invalidateParentFrameInTx(stx, 'messageBlock', row.id)
          continue
        }
        if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, row.id, ctx.deviceId) === 'refreshed') {
          notify = true
        }
      }
    } else {
      syncService.invalidateParentFrameInTx(stx, 'topicMessage', plan.targetTopicId)
      for (const row of allRows) {
        syncService.invalidateParentFrameInTx(stx, 'messageBlock', row.id)
      }
    }
    return { notify, unsupportedBlockIds }
  }
  /**
   * Capture the complete authority preimage of one cut BEFORE any write.
   *
   * Recorded rows are the captured roots plus the OWNED rows of the included
   * branches, together with the affected owners' complete pre-cut row orders
   * (ids only), the touched segment state, and the affected file ids. Capturing
   * before the target insert keeps the preimage exact even when a cut pastes
   * back into its own topic.
   */
  private captureClipboardTreeSourceRemovalInTx(
    repos: ChatDbRepositories,
    source: { topicId: string; branchId: string | null; branchIds: string[]; ownedMessageIds: string[] }
  ): { removal: ClipboardTreeSourceRemoval; affectedFileIds: string[] } {
    const capturedIds = new Set(source.ownedMessageIds)
    const ownerOrders: ClipboardTreeSourceRemoval['ownerOrders'] = []
    const ownedMessages: MessageData[] = []
    const seenOwned = new Set<string>()
    for (const owner of [source.branchId, ...source.branchIds]) {
      const rows = repos.messages.listByTopic(source.topicId, owner)
      ownerOrders.push({ branchId: owner, orderedIds: rows.map((row) => row.id) })
      for (const row of rows) {
        if (!capturedIds.has(row.id)) continue
        seenOwned.add(row.id)
        ownedMessages.push(row)
      }
    }
    const missing = source.ownedMessageIds.filter((id) => !seenOwned.has(id))
    if (missing.length > 0) {
      throw new ChatDbNotFoundError(
        `Captured source message ${missing[0]} is no longer owned by the source route; the cut cannot be applied`
      )
    }
    const ownedMessageIds = ownedMessages.map((row) => row.id)
    const ownedSet = new Set(ownedMessageIds)
    const blockMap = repos.blocks.listByMessages(ownedMessageIds)
    const ownedBlocks: MessageBlockData[] = []
    for (const id of ownedMessageIds) {
      ownedBlocks.push(...(blockMap.get(id) ?? []))
    }
    const refsBeforeDelete = repos.fileRefs.listByMessages(ownedMessageIds)
    const segmentsBefore = repos.segments.listByTopic(source.topicId)
    const touchedSegments: BranchHistorySegmentRow[] = []
    for (const segment of segmentsBefore) {
      const memberIds = repos.segments.getMessageIds(segment.id)
      if (!memberIds.some((id) => ownedSet.has(id))) continue
      touchedSegments.push({
        id: segment.id,
        name: segment.name ?? null,
        createdAt: segment.createdAt ?? null,
        updatedAt: segment.updatedAt ?? null,
        sortOrder: segment.sortOrder,
        headerMessageId: segment.headerMessageId ?? null,
        overflow: (segment.overflow ?? {}) as JsonObject,
        memberIds
      })
    }
    const removal: ClipboardTreeSourceRemoval = {
      topicId: source.topicId,
      branchId: source.branchId,
      // Included branches are recorded parents-first, so a restore can create
      // ancestry in order.
      branches: source.branchIds.map((id) => {
        const row = repos.branches.getById(id)
        if (!row.found) {
          throw new ChatDbNotFoundError(`Branch ${id} does not exist in topic ${source.topicId}`)
        }
        return toBranchHistoryRow(row.data)
      }),
      messages: ownedMessages.map(toMessageHistoryRow),
      blocks: ownedBlocks.map(toBlockHistoryRow),
      fileReferences: refsBeforeDelete.map(toFileReferenceHistoryRow),
      segments: touchedSegments,
      segmentsAfter: [],
      segmentOrder: segmentsBefore.map((segment) => segment.id),
      ownerOrders,
      boundaries: []
    }
    return { removal, affectedFileIds: collectAffectedFileIds(refsBeforeDelete) }
  }

  /**
   * Apply one captured cut inside the caller's transaction.
   *
   * Deletion reuses the bulk owned-row core (`deleteOwnedMessagesCoreInTx`:
   * segment membership, boundary advance, frames, sync deletes), so a cut
   * removes exactly the captured roots plus the OWNED rows of the included
   * branches — never an unselected dependent, never a cross-route row. The
   * returned removal additionally records the state the delete left behind,
   * which undo still has to find in place.
   */
  private applyClipboardTreeSourceRemovalInTx(
    repos: ChatDbRepositories,
    tx: unknown,
    stx: SyncTxExecutor,
    ctx: { deviceId: string; ts: number } | null,
    removal: ClipboardTreeSourceRemoval
  ): { removal: ClipboardTreeSourceRemoval; notify: boolean } {
    const ownedMessageIds = removal.messages.map((row) => row.id)
    const notifyRef = { value: false }
    const boundaries: InheritanceBoundarySnapshot[] = []
    // Captured child-branch suffixes are local-only: their rows never entered
    // the outbox, so their removal carries no delete intent even when the source
    // route itself is syncable.
    this.deleteOwnedMessagesCoreInTx(
      tx,
      repos,
      stx,
      ctx,
      removal.topicId,
      ownedMessageIds,
      notifyRef,
      boundaries,
      removal.messages.filter((row) => (row.branchId ?? null) !== (removal.branchId ?? null)).map((row) => row.id)
    )
    const segmentsAfter = removal.segments.map((segment): BranchHistorySegmentStateRow => {
      const live = repos.segments.getById(segment.id)
      if (!live.found) {
        return { id: segment.id, exists: false, name: null, sortOrder: null, headerMessageId: null, memberIds: [] }
      }
      return {
        id: segment.id,
        exists: true,
        name: live.data.name ?? null,
        sortOrder: live.data.sortOrder,
        headerMessageId: live.data.headerMessageId ?? null,
        memberIds: repos.segments.getMessageIds(segment.id)
      }
    })
    if (removal.branches.length > 0) {
      repos.branches.deleteSubtreeRows(removal.branches.map((row) => row.id))
    }
    return { removal: { ...removal, boundaries, segmentsAfter }, notify: notifyRef.value }
  }

  /**
   * Restore the source rows a cut removed (undo direction).
   *
   * Every recorded identity must be gone and every touched segment must still
   * hold the state the cut left, so a restore never overwrites live work. Rows
   * come back with their recorded identity, content, blocks, file references and
   * per-owner positions (the recorded pre-cut owner orders), so a restored root
   * returns to its former place instead of landing at the tail.
   */
  private restoreClipboardTreeSourceInTx(
    repos: ChatDbRepositories,
    tx: unknown,
    removal: ClipboardTreeSourceRemoval
  ): { restoredMessageIds: string[]; restoredBranchIds: string[]; affectedFileIds: string[] } {
    const branches = removal.branches ?? []
    const messages = removal.messages ?? []
    const blocks = removal.blocks ?? []
    const fileReferences = removal.fileReferences ?? []
    const segments = removal.segments ?? []
    const segmentsAfter = removal.segmentsAfter ?? []
    const restoredBranchIds = branches.map((row) => row.id)
    const restoredBranchIdSet = new Set(restoredBranchIds)
    for (const row of branches) {
      if (repos.branches.exists(row.id)) {
        throw new ChatDbConflictError(`Branch ${row.id} already exists; the cut can no longer be undone`)
      }
    }
    for (const row of branches) {
      if (
        row.parentBranchId !== null &&
        !restoredBranchIdSet.has(row.parentBranchId) &&
        !repos.branches.exists(row.parentBranchId)
      ) {
        throw new ChatDbConflictError(
          `Parent branch ${row.parentBranchId} of ${row.id} no longer exists; the cut can no longer be undone`
        )
      }
    }
    for (const row of messages) {
      if (repos.messages.getById(row.id).found) {
        throw new ChatDbConflictError(`Message ${row.id} already exists; the cut can no longer be undone`)
      }
    }
    for (const row of blocks) {
      if (repos.blocks.getById(row.id).found) {
        throw new ChatDbConflictError(`Block ${row.id} already exists; the cut can no longer be undone`)
      }
    }
    for (const row of fileReferences) {
      if (repos.fileRefs.getById(row.id).found) {
        throw new ChatDbConflictError(`File reference ${row.id} already exists; the cut can no longer be undone`)
      }
    }
    this.assertSegmentPostDeleteStateInTx(repos, segmentsAfter)
    // 1. Branch rows first: a parent always precedes its children in the
    //    recorded order, so ancestry and anchors re-compose exactly.
    for (const row of branches) {
      repos.branches.create({
        id: row.id,
        topicId: removal.topicId,
        parentBranchId: row.parentBranchId ?? null,
        anchorMessageId: row.anchorMessageId,
        name: row.name ?? null,
        createdAt: row.createdAt ?? null,
        updatedAt: row.updatedAt ?? null,
        overflow: row.overflow ?? {}
      })
    }
    // 2. Owned rows verbatim, then the exact former positions per owner.
    if (messages.length > 0) {
      repos.messages.createMany(messages.map((row) => ({ ...row })))
    }
    const restoredMessageIds = messages.map((row) => row.id)
    const restoredMessageIdSet = new Set(restoredMessageIds)
    for (const owner of removal.ownerOrders ?? []) {
      const recordedIds = owner.orderedIds ?? []
      const recordedSet = new Set(recordedIds)
      const liveIds = repos.messages.listByTopic(removal.topicId, owner.branchId).map((row) => row.id)
      for (const id of liveIds) {
        if (!recordedSet.has(id)) {
          throw new ChatDbConflictError(
            `Route ${owner.branchId ?? 'main'} gained message ${id} after the cut; the cut can no longer be undone`
          )
        }
      }
      const liveSurvivors = liveIds.filter((id) => !restoredMessageIdSet.has(id))
      const recordedSurvivors = recordedIds.filter((id) => !restoredMessageIdSet.has(id))
      if (
        liveSurvivors.length !== recordedSurvivors.length ||
        liveSurvivors.some((id, index) => id !== recordedSurvivors[index])
      ) {
        throw new ChatDbConflictError(
          `Route ${owner.branchId ?? 'main'} changed after the cut; the cut can no longer be undone`
        )
      }
      if (recordedIds.length > 0) {
        repos.messages.replaceOrder(removal.topicId, recordedIds, owner.branchId)
      }
    }
    if (blocks.length > 0) {
      repos.blocks.createMany(blocks.map((row) => ({ ...row })))
    }
    if (fileReferences.length > 0) {
      repos.fileRefs.createMany(fileReferences.map((row) => ({ ...row })))
    }
    // 3. Segments: an emptied segment is re-created, every touched segment gets
    //    its recorded membership and head back, and the catalog order is
    //    re-pinned around the re-created segments.
    for (const segment of segments) {
      if (!repos.segments.getById(segment.id).found) {
        repos.segments.create({
          id: segment.id,
          topicId: removal.topicId,
          name: segment.name ?? null,
          createdAt: segment.createdAt ?? null,
          updatedAt: segment.updatedAt ?? null,
          sortOrder: segment.sortOrder,
          headerMessageId: segment.headerMessageId ?? null,
          overflow: segment.overflow ?? {}
        })
      }
      repos.segments.replaceMessageIds(segment.id, segment.memberIds ?? [])
      repos.segments.setHeaderMessageId(segment.id, segment.headerMessageId ?? null)
    }
    if (segments.length > 0) {
      const liveSegmentIds = repos.segments.listByTopic(removal.topicId).map((row) => row.id)
      const recordedIndex = new Map((removal.segmentOrder ?? []).map((id, index) => [id, index]))
      const orderOf = (id: string): number => recordedIndex.get(id) ?? Number.MAX_SAFE_INTEGER
      const recreatedSegmentIds = segmentsAfter.filter((row) => !row.exists).map((row) => row.id)
      const recreatedSegmentIdSet = new Set(recreatedSegmentIds)
      const orderedSegmentIds = liveSegmentIds.filter((id) => !recreatedSegmentIdSet.has(id))
      for (const id of recreatedSegmentIds) {
        const insertAt = orderedSegmentIds.findIndex((live) => orderOf(live) > orderOf(id))
        orderedSegmentIds.splice(insertAt === -1 ? orderedSegmentIds.length : insertAt, 0, id)
      }
      const changed =
        orderedSegmentIds.length !== liveSegmentIds.length ||
        orderedSegmentIds.some((id, index) => id !== liveSegmentIds[index])
      if (changed) this.assignSegmentOrdersInTx(tx, orderedSegmentIds)
    }
    // 4. Boundaries this cut advanced, compare-and-set against the restored
    //    route only.
    this.restoreInheritanceBoundariesInTx(
      repos,
      removal.topicId,
      removal.boundaries ?? [],
      restoredMessageIdSet,
      removal.branchId
    )
    return {
      restoredMessageIds,
      restoredBranchIds,
      affectedFileIds: collectAffectedFileIds(fileReferences)
    }
  }

  /**
   * Remove exactly the rows a tree paste inserted (undo direction).
   *
   * The guard is a compare-and-set against the recorded snapshot: the recorded
   * branch forest must still hold the recorded parents/anchors/names, no branch
   * may have been created on a pasted row, every owner's row set must still be
   * exactly the recorded one, and message/block/segment content must be
   * unchanged. Anything newer fails closed with zero writes, so an undo never
   * cascades into work the paste did not create.
   */
  private removeClipboardTreeTargetInTx(
    repos: ChatDbRepositories,
    tx: unknown,
    stx: SyncTxExecutor,
    ctx: { deviceId: string; ts: number } | null,
    snapshot: ClipboardTreeSnapshot
  ): { removedMessageIds: string[]; removedBranchIds: string[]; affectedFileIds: string[]; notify: boolean } {
    const placement = snapshot.placement
    const topicId = placement.topicId
    const route = placement.branchId ?? null
    const branchRows = snapshot.inserted.branches ?? []
    const messageWires = snapshot.inserted.messages as unknown as Array<Record<string, unknown>>
    const blockWires = snapshot.inserted.blocks as unknown as Array<Record<string, unknown>>
    const segmentRows = snapshot.inserted.segments ?? []
    const recordedBranchIds = branchRows.map((row) => row.id)
    const recordedBranchIdSet = new Set(recordedBranchIds)
    for (const row of branchRows) {
      const live = repos.branches.getById(row.id)
      if (!live.found) {
        throw new ChatDbConflictError(`Branch ${row.id} no longer exists; the paste can no longer be undone`)
      }
      if (live.data.topicId !== topicId) {
        throw new ChatDbValidationError(`Branch ${row.id} does not belong to topic ${topicId}`)
      }
      if (
        (live.data.parentBranchId ?? null) !== (row.parentBranchId ?? null) ||
        live.data.anchorMessageId !== row.anchorMessageId ||
        (live.data.name ?? null) !== (row.name ?? null)
      ) {
        throw new ChatDbConflictError(`Branch ${row.id} changed after the paste; it can no longer be undone`)
      }
    }
    const recordedMessageIds: string[] = []
    const ownerByMessage = new Map<string, string | null>()
    for (const wire of messageWires) {
      const id = String(wire.id)
      recordedMessageIds.push(id)
      ownerByMessage.set(id, typeof wire.branchId === 'string' ? wire.branchId : null)
    }
    const recordedMessageIdSet = new Set(recordedMessageIds)
    // No branch may have been created on top of pasted rows: deleting them
    // would cascade into work the paste never wrote.
    for (const live of repos.branches.listByTopic(topicId)) {
      if (recordedBranchIdSet.has(live.id)) continue
      const parent = live.parentBranchId ?? null
      if (parent !== null && recordedBranchIdSet.has(parent)) {
        throw new ChatDbConflictError(
          `Branch ${live.id} was created under pasted branch ${parent} after the paste; it can no longer be undone`
        )
      }
      if (parent === route && recordedMessageIdSet.has(live.anchorMessageId)) {
        throw new ChatDbConflictError(
          `Branch ${live.id} was anchored on a pasted message after the paste; it can no longer be undone`
        )
      }
    }
    for (const id of recordedMessageIds) {
      const live = repos.messages.getInTopic(id, topicId)
      if (!live.found) {
        throw new ChatDbConflictError(`Message ${id} no longer exists; the paste can no longer be undone`)
      }
      if ((live.data.branchId ?? null) !== (ownerByMessage.get(id) ?? null)) {
        throw new ChatDbConflictError(`Message ${id} changed owner after the paste; it can no longer be undone`)
      }
      const recordedWire = messageWires.find((wire) => String(wire.id) === id) as Record<string, unknown>
      if (
        this.clipboardTreeMessageFacts(toMessageHistoryRow(live.data)) !==
        this.clipboardTreeWireMessageFacts(recordedWire)
      ) {
        throw new ChatDbConflictError(`Message ${id} changed after the paste; it can no longer be undone`)
      }
    }
    // Owner row sets: the recorded rows are still the complete set of their
    // owner, so no message written after the paste leaves with them.
    //
    // A same-topic cut pasted back into its own source route is the single case
    // where the placement owner legitimately still holds unrelated rows: the
    // survivors the cut left behind. Those are not post-paste additions, and a
    // strict set comparison would make a perfectly valid undo impossible. The
    // relaxation is bounded — the placement-owner check becomes "the recorded
    // rows are present, and the survivors still hold exactly their pre-cut
    // order" — so anything written or reordered after the cut still fails
    // closed. Any other route (including one kept branch of the same topic)
    // keeps the strict comparison.
    const sharedOwnerSurvivors = this.clipboardTreeSharedOwnerSurvivors(snapshot, topicId, route, recordedMessageIdSet)
    for (const owner of [route, ...recordedBranchIds]) {
      const liveIds = repos.messages.listByTopic(topicId, owner).map((row) => row.id)
      const recordedForOwner = recordedMessageIds.filter((id) => (ownerByMessage.get(id) ?? null) === owner)
      if (owner === route) {
        this.assertClipboardTreePlacementScope(snapshot.placement, liveIds, recordedForOwner, sharedOwnerSurvivors)
        continue
      }
      this.assertClipboardTreeSameIdSet(liveIds, recordedForOwner, `the rows of route ${owner ?? 'main'}`)
    }
    const liveBlockMap = repos.blocks.listByMessages(recordedMessageIds)
    const liveBlockIds: string[] = []
    for (const id of recordedMessageIds) {
      for (const block of liveBlockMap.get(id) ?? []) liveBlockIds.push(block.id)
    }
    this.assertClipboardTreeSameIdSet(
      liveBlockIds,
      blockWires.map((wire) => String(wire.id)),
      'the blocks written by the paste'
    )
    for (const wire of blockWires) {
      const live = repos.blocks.getById(String(wire.id))
      if (!live.found) {
        throw new ChatDbConflictError(`Block ${String(wire.id)} no longer exists; the paste can no longer be undone`)
      }
      if (this.clipboardTreeBlockFacts(toBlockHistoryRow(live.data)) !== this.clipboardTreeWireBlockFacts(wire)) {
        throw new ChatDbConflictError(`Block ${String(wire.id)} changed after the paste; it can no longer be undone`)
      }
    }
    for (const row of segmentRows) {
      const live = repos.segments.getById(row.id)
      if (!live.found) {
        throw new ChatDbConflictError(`Segment ${row.id} no longer exists; the paste can no longer be undone`)
      }
      const liveMembers = repos.segments.getMessageIds(row.id)
      const recordedMembers = row.memberIds ?? []
      if (
        (live.data.headerMessageId ?? null) !== (row.headerMessageId ?? null) ||
        (live.data.name ?? null) !== (row.name ?? null) ||
        liveMembers.length !== recordedMembers.length ||
        liveMembers.some((id, index) => id !== recordedMembers[index])
      ) {
        throw new ChatDbConflictError(`Segment ${row.id} changed after the paste; it can no longer be undone`)
      }
    }
    const affectedFileIds = collectAffectedFileIds(repos.fileRefs.listByMessages(recordedMessageIds))
    const notifyRef = { value: false }
    this.deleteOwnedMessagesCoreInTx(
      tx,
      repos,
      stx,
      ctx,
      topicId,
      recordedMessageIds,
      notifyRef,
      undefined,
      recordedMessageIds.filter((id) => {
        const owner = ownerByMessage.get(id) ?? null
        return owner !== null && owner !== route
      })
    )
    if (recordedBranchIds.length > 0) {
      repos.branches.deleteSubtreeRows(recordedBranchIds)
    }
    const recordedSegmentIds = segmentRows.map((row) => row.id)
    if (recordedSegmentIds.length > 0) {
      repos.segments.deleteMany(recordedSegmentIds)
    }
    return {
      removedMessageIds: recordedMessageIds,
      removedBranchIds: recordedBranchIds,
      affectedFileIds,
      notify: notifyRef.value
    }
  }

  /**
   * Rebuild the exact rows one paste wrote (redo preimage / undo guard input).
   *
   * Messages keep their canonical wire shape (generated ids, remapped refs, and
   * their authoritative block id order), so a redo re-inserts byte-identical
   * rows with the same generated IDs.
   */
  private buildClipboardTreeInsertedRowsInTx(
    repos: ChatDbRepositories,
    plan: ClipboardTreeInsertPlan
  ): ClipboardTreeInsertedRows {
    const orderedIds = [
      ...plan.rootRows.map((row) => row.id),
      ...plan.branches.flatMap((entry) => entry.rows.map((row) => row.id))
    ]
    const messages: MessageData[] = []
    for (const id of orderedIds) {
      const live = repos.messages.getById(id)
      if (!live.found) throw new Error(`clipboard tree inserted message ${id} missing in transaction`)
      messages.push(live.data)
    }
    const blocks: MessageBlockData[] = []
    for (const block of plan.blocks) {
      const live = repos.blocks.getById(block.id)
      if (!live.found) throw new Error(`clipboard tree inserted block ${block.id} missing in transaction`)
      blocks.push(live.data)
    }
    const branches: BranchHistoryRow[] = []
    for (const entry of plan.branches) {
      const live = repos.branches.getById(entry.branch.id)
      if (!live.found) throw new Error(`clipboard tree inserted branch ${entry.branch.id} missing in transaction`)
      branches.push(toBranchHistoryRow(live.data))
    }
    const segments: BranchHistorySegmentRow[] = []
    for (const entry of plan.segments) {
      const live = repos.segments.getById(entry.row.id)
      if (!live.found) throw new Error(`clipboard tree inserted segment ${entry.row.id} missing in transaction`)
      segments.push({
        id: live.data.id,
        name: live.data.name ?? null,
        createdAt: live.data.createdAt ?? null,
        updatedAt: live.data.updatedAt ?? null,
        sortOrder: live.data.sortOrder,
        headerMessageId: live.data.headerMessageId ?? null,
        overflow: (live.data.overflow ?? {}) as JsonObject,
        memberIds: repos.segments.getMessageIds(live.data.id)
      })
    }
    return {
      messages: reconstructMessageBlockRelations(messagesToWire(messages), blocksToWire(blocks)),
      blocks: blocksToWire(blocks),
      branches,
      segments
    }
  }

  /**
   * Compare a captured clipboard payload with the topic's CURRENT authority
   * state, before any cut write.
   *
   * The payload is self-contained, so this is the guard that a `cut` never
   * deletes rows the user has since changed: selected groups, included child
   * branches, captured message/block facts, per-message block order, per-owner
   * row order, and fully-contained segment membership must all still match.
   * Any divergence fails closed (CONFLICT) with zero writes.
   */
  private assertClipboardTreePayloadMatchesClosureInTx(
    repos: ChatDbRepositories,
    payload: ClipboardTreePayload,
    closure: ClipboardTreeClosure
  ): void {
    /**
     * Declared as a nested function (not a const arrow) so TypeScript's control
     * flow analysis narrows after every `if (!live) conflict(...)` guard.
     */
    function conflict(detail: string): never {
      throw new ChatDbConflictError(`The captured clipboard tree no longer matches the source topic: ${detail}`)
    }
    if (payload.roots.length !== closure.resolvedGroups.length) {
      conflict('the selected group set changed')
    }
    for (let i = 0; i < payload.roots.length; i++) {
      const capturedRoot = payload.roots[i]
      const liveGroup = closure.resolvedGroups[i]
      if (capturedRoot.groupId !== liveGroup.groupId) {
        conflict(`group ${capturedRoot.groupId} is no longer part of the source route`)
      }
      const liveIds = liveGroup.rows.map((row) => row.id)
      if (
        capturedRoot.messageIds.length !== liveIds.length ||
        capturedRoot.messageIds.some((id, index) => id !== liveIds[index])
      ) {
        conflict(`group ${capturedRoot.groupId} changed`)
      }
    }
    const liveBranchById = new Map(closure.branches.map((entry) => [entry.data.id, entry.data]))
    if (payload.branches.length !== liveBranchById.size) {
      conflict('the included child branches changed')
    }
    for (const branch of payload.branches) {
      const live = liveBranchById.get(branch.sourceBranchId)
      if (!live) {
        conflict(`child branch ${branch.sourceBranchId} is no longer included`)
      }
      if (
        (live.parentBranchId ?? null) !== (branch.parentSourceBranchId ?? null) ||
        live.anchorMessageId !== branch.anchorMessageId ||
        (live.name ?? null) !== (branch.name ?? null)
      ) {
        conflict(`child branch ${branch.sourceBranchId} changed`)
      }
    }
    const liveMessageById = new Map(closure.capturedMessages.map((row) => [row.id, row]))
    if (payload.messages.length !== liveMessageById.size) {
      conflict('the captured message set changed')
    }
    const capturedIds = [...closure.capturedMessageIds]
    const liveBlockMap = repos.blocks.listByMessages(capturedIds)
    const liveBlockById = new Map<string, MessageBlockData>()
    for (const id of capturedIds) {
      for (const block of liveBlockMap.get(id) ?? []) liveBlockById.set(block.id, block)
    }
    if (payload.blocks.length !== liveBlockById.size) {
      conflict('the captured block set changed')
    }
    for (const wire of payload.blocks as unknown as Array<Record<string, unknown>>) {
      const live = liveBlockById.get(String(wire.id))
      if (!live) {
        conflict(`block ${String(wire.id)} is no longer captured`)
      }
      if (this.clipboardTreeBlockFacts(toBlockHistoryRow(live)) !== this.clipboardTreeWireBlockFacts(wire)) {
        conflict(`block ${String(wire.id)} changed`)
      }
    }
    const payloadOrderByOwner = new Map<string, string[]>()
    for (const wire of payload.messages as unknown as Array<Record<string, unknown>>) {
      const id = String(wire.id)
      const live = liveMessageById.get(id)
      if (!live) {
        conflict(`message ${id} is no longer captured`)
      }
      if (this.clipboardTreeMessageFacts(toMessageHistoryRow(live)) !== this.clipboardTreeWireMessageFacts(wire)) {
        conflict(`message ${id} changed`)
      }
      const recordedBlockIds = Array.isArray(wire.blocks)
        ? (wire.blocks as unknown[]).map((value) => String(value))
        : []
      const liveBlockOrder = (liveBlockMap.get(id) ?? []).map((block) => block.id)
      if (
        recordedBlockIds.length !== liveBlockOrder.length ||
        recordedBlockIds.some((blockId, index) => blockId !== liveBlockOrder[index])
      ) {
        conflict(`the blocks of message ${id} changed`)
      }
      const ownerKey = typeof wire.branchId === 'string' ? wire.branchId : ''
      const order = payloadOrderByOwner.get(ownerKey) ?? []
      order.push(id)
      payloadOrderByOwner.set(ownerKey, order)
    }
    const ownerIds: Array<string | null> = [closure.branchId, ...closure.branches.map((entry) => entry.data.id)]
    for (const owner of ownerIds) {
      const liveOrder = repos.messages
        .listByTopic(closure.topicId, owner)
        .map((row) => row.id)
        .filter((id) => closure.capturedMessageIds.has(id))
      const recordedOrder = payloadOrderByOwner.get(owner ?? '') ?? []
      if (liveOrder.length !== recordedOrder.length || liveOrder.some((id, index) => id !== recordedOrder[index])) {
        conflict(`the captured rows of route ${owner ?? 'main'} changed order`)
      }
    }
    const liveSegmentById = new Map(closure.segments.map((entry) => [entry.data.id, entry]))
    if (payload.segments.length !== liveSegmentById.size) {
      conflict('the captured segment set changed')
    }
    for (const segment of payload.segments) {
      const live = liveSegmentById.get(segment.sourceSegmentId)
      if (!live) {
        conflict(`segment ${segment.sourceSegmentId} is no longer captured`)
      }
      if (
        (live.data.headerMessageId ?? null) !== (segment.headerMessageId ?? null) ||
        (live.data.name ?? null) !== (segment.name ?? null)
      ) {
        conflict(`segment ${segment.sourceSegmentId} changed`)
      }
      if (
        live.memberIds.length !== segment.memberIds.length ||
        live.memberIds.some((id, index) => id !== segment.memberIds[index])
      ) {
        conflict(`the membership of segment ${segment.sourceSegmentId} changed`)
      }
    }
  }

  /**
   * Verify the source rows a captured cut removes are still exactly what the
   * snapshot recorded (redo direction), so a replay never deletes rows that were
   * changed or re-created after the operation.
   */
  private assertClipboardTreeSourceRemovalCurrentInTx(
    repos: ChatDbRepositories,
    removal: ClipboardTreeSourceRemoval
  ): void {
    const topic = repos.topics.getById(removal.topicId)
    if (!topic.found) {
      throw new ChatDbNotFoundError(`Topic ${removal.topicId} does not exist`)
    }
    if (topic.data.deletedAt != null) {
      throw new ChatDbValidationError(`Topic ${removal.topicId} is in the trash; the cut can no longer be replayed`)
    }
    const capturedBranchIds = new Set(removal.branches.map((row) => row.id))
    for (const row of removal.branches) {
      const live = repos.branches.getById(row.id)
      if (!live.found) {
        throw new ChatDbConflictError(`Branch ${row.id} is missing; the cut can no longer be replayed`)
      }
      if (
        (live.data.parentBranchId ?? null) !== (row.parentBranchId ?? null) ||
        live.data.anchorMessageId !== row.anchorMessageId ||
        (live.data.name ?? null) !== (row.name ?? null)
      ) {
        throw new ChatDbConflictError(`Branch ${row.id} changed; the cut can no longer be replayed`)
      }
    }
    for (const live of repos.branches.listByTopic(removal.topicId)) {
      if (capturedBranchIds.has(live.id)) continue
      const parent = live.parentBranchId ?? null
      if (parent !== null && capturedBranchIds.has(parent)) {
        throw new ChatDbConflictError(
          `Branch ${live.id} was created under captured branch ${parent}; the cut can no longer be replayed`
        )
      }
    }
    for (const row of removal.messages) {
      const live = repos.messages.getInTopic(row.id, removal.topicId)
      if (!live.found) {
        throw new ChatDbConflictError(`Message ${row.id} is missing; the cut can no longer be replayed`)
      }
      if ((live.data.branchId ?? null) !== (row.branchId ?? null)) {
        throw new ChatDbConflictError(`Message ${row.id} changed owner; the cut can no longer be replayed`)
      }
      if (this.clipboardTreeMessageFacts(toMessageHistoryRow(live.data)) !== this.clipboardTreeMessageFacts(row)) {
        throw new ChatDbConflictError(`Message ${row.id} changed; the cut can no longer be replayed`)
      }
    }
    const liveBlockMap = repos.blocks.listByMessages(removal.messages.map((row) => row.id))
    const liveBlockIds: string[] = []
    for (const row of removal.messages) {
      for (const block of liveBlockMap.get(row.id) ?? []) liveBlockIds.push(block.id)
    }
    this.assertClipboardTreeSameIdSet(
      liveBlockIds,
      removal.blocks.map((row) => row.id),
      'the blocks of the captured rows'
    )
    for (const row of removal.blocks) {
      const live = repos.blocks.getById(row.id)
      if (!live.found) {
        throw new ChatDbConflictError(`Block ${row.id} is missing; the cut can no longer be replayed`)
      }
      if (this.clipboardTreeBlockFacts(toBlockHistoryRow(live.data)) !== this.clipboardTreeBlockFacts(row)) {
        throw new ChatDbConflictError(`Block ${row.id} changed; the cut can no longer be replayed`)
      }
    }
    this.assertClipboardTreeSameIdSet(
      repos.fileRefs.listByMessages(removal.messages.map((row) => row.id)).map((row) => row.id),
      removal.fileReferences.map((row) => row.id),
      'the file references of the captured rows'
    )
    for (const segment of removal.segments) {
      const live = repos.segments.getById(segment.id)
      if (!live.found) {
        throw new ChatDbConflictError(`Segment ${segment.id} is missing; the cut can no longer be replayed`)
      }
      const liveMembers = repos.segments.getMessageIds(segment.id)
      const recordedMembers = segment.memberIds ?? []
      if (
        (live.data.headerMessageId ?? null) !== (segment.headerMessageId ?? null) ||
        (live.data.name ?? null) !== (segment.name ?? null) ||
        liveMembers.length !== recordedMembers.length ||
        liveMembers.some((id, index) => id !== recordedMembers[index])
      ) {
        throw new ChatDbConflictError(`Segment ${segment.id} changed; the cut can no longer be replayed`)
      }
    }
    const capturedMessageIdSet = new Set(removal.messages.map((row) => row.id))
    for (const owner of removal.ownerOrders ?? []) {
      const recordedIds = owner.orderedIds ?? []
      const recordedSet = new Set(recordedIds)
      const liveIds = repos.messages.listByTopic(removal.topicId, owner.branchId).map((row) => row.id)
      for (const id of recordedIds) {
        if (!capturedMessageIdSet.has(id)) continue
        if (!liveIds.includes(id)) {
          throw new ChatDbConflictError(`Message ${id} is missing; the cut can no longer be replayed`)
        }
      }
      const liveSurvivors = liveIds.filter((id) => !capturedMessageIdSet.has(id))
      const recordedSurvivors = recordedIds.filter((id) => !capturedMessageIdSet.has(id) && recordedSet.has(id))
      if (
        liveSurvivors.length !== recordedSurvivors.length ||
        liveSurvivors.some((id, index) => id !== recordedSurvivors[index])
      ) {
        throw new ChatDbConflictError(`Route ${owner.branchId ?? 'main'} changed; the cut can no longer be replayed`)
      }
    }
  }

  /** Reject a redo while any row the paste wrote is still present. */
  private assertClipboardTreeInsertAbsentInTx(repos: ChatDbRepositories, snapshot: ClipboardTreeSnapshot): void {
    for (const wire of snapshot.inserted.messages as unknown as Array<Record<string, unknown>>) {
      if (repos.messages.getById(String(wire.id)).found) {
        throw new ChatDbConflictError(`Message ${String(wire.id)} already exists; the paste can no longer be redone`)
      }
    }
    for (const wire of snapshot.inserted.blocks as unknown as Array<Record<string, unknown>>) {
      if (repos.blocks.getById(String(wire.id)).found) {
        throw new ChatDbConflictError(`Block ${String(wire.id)} already exists; the paste can no longer be redone`)
      }
    }
    for (const row of snapshot.inserted.branches) {
      if (repos.branches.exists(row.id)) {
        throw new ChatDbConflictError(`Branch ${row.id} already exists; the paste can no longer be redone`)
      }
    }
    for (const row of snapshot.inserted.segments) {
      if (repos.segments.getById(row.id).found) {
        throw new ChatDbConflictError(`Segment ${row.id} already exists; the paste can no longer be redone`)
      }
    }
  }

  /**
   * Resolve the redo insertion index from the recorded neighbours.
   *
   * The recorded `prevOwnerMessageId`/`nextOwnerMessageId` still have to be
   * adjacent in the target route's owner order; any later insert in between is
   * newer state and rejects the redo instead of overwriting it.
   *
   * A delete snapshot carries no insert, so there is no index to resolve: the
   * redo guard is the source-removal currency check and the index is vacuous.
   */
  private resolveClipboardTreeReplayIndexInTx(repos: ChatDbRepositories, snapshot: ClipboardTreeSnapshot): number {
    const placement = snapshot.placement
    if (snapshot.mode === 'delete') return 0
    const ownerRows = repos.messages.listByTopic(placement.topicId, placement.branchId ?? null)
    const prev = placement.prevOwnerMessageId ?? null
    const next = placement.nextOwnerMessageId ?? null
    if (prev === null) {
      const first = ownerRows[0]?.id ?? null
      if (first !== next) {
        throw new ChatDbConflictError('The target route changed; the paste can no longer be redone')
      }
      return 0
    }
    const index = ownerRows.findIndex((row) => row.id === prev)
    if (index === -1) {
      throw new ChatDbConflictError('The target route changed; the paste can no longer be redone')
    }
    const actualNext = ownerRows[index + 1]?.id ?? null
    if (actualNext !== next) {
      throw new ChatDbConflictError('The target route changed; the paste can no longer be redone')
    }
    return index + 1
  }

  /**
   * Pre-cut survivor order of the placement owner, or null when the snapshot is
   * not a same-topic cut whose source route is the placement route.
   *
   * Only that case leaves unrelated rows inside the owner the paste wrote into,
   * so `removeClipboardTreeTargetInTx` relaxes its strict owner-set comparison
   * to "recorded rows present + survivors unchanged in order" exactly there.
   */
  private clipboardTreeSharedOwnerSurvivors(
    snapshot: ClipboardTreeSnapshot,
    topicId: string,
    route: string | null,
    recordedMessageIdSet: Set<string>
  ): string[] | null {
    const removal = snapshot.sourceRemoved
    if (removal === null) return null
    if (removal.topicId !== topicId) return null
    if ((removal.branchId ?? null) !== route) return null
    const ownerOrder = removal.ownerOrders.find((entry) => (entry.branchId ?? null) === route)
    if (ownerOrder === undefined) return null
    const captured = new Set(removal.messages.map((row) => row.id))
    return ownerOrder.orderedIds.filter((id) => !captured.has(id) && !recordedMessageIdSet.has(id))
  }

  /**
   * Undo guard for the placement route itself.
   *
   * The placement route is the one owner that legitimately already held rows
   * before the operation — a copy into a populated topic/route, or a cut whose
   * source is a different topic. Requiring the route to contain nothing but the
   * pasted run would make every such undo impossible, while comparing the whole
   * route would reject unrelated later work. The guard is therefore scoped to
   * exactly what the operation wrote: every recorded row is still live, still in
   * the recorded order, still one contiguous run, and still flanked by the
   * recorded neighbours. A later insert between a neighbour and the run, a
   * deletion of a recorded row or a reorder inside the run all break that and
   * fail closed before any write; pre-existing rows outside the run are never
   * required to be unchanged.
   *
   * A same-topic cut pasted back into its own source route additionally holds
   * the survivors the cut left behind, so that case keeps the stricter pre-cut
   * survivor-order comparison supplied by `sharedOwnerSurvivors`.
   */
  private assertClipboardTreePlacementScope(
    placement: ClipboardTreePlacement,
    liveIds: string[],
    recordedForOwner: string[],
    sharedOwnerSurvivors: string[] | null
  ): void {
    const routeLabel = placement.branchId ?? 'main'
    const recordedSet = new Set(recordedForOwner)
    const livePasted = liveIds.filter((id) => recordedSet.has(id))
    this.assertClipboardTreeSameIdSet(livePasted, recordedForOwner, `the rows the paste wrote into route ${routeLabel}`)
    if (sharedOwnerSurvivors !== null) {
      const liveSurvivors = liveIds.filter((id) => !recordedSet.has(id))
      if (
        liveSurvivors.length !== sharedOwnerSurvivors.length ||
        liveSurvivors.some((id, index) => id !== sharedOwnerSurvivors[index])
      ) {
        throw new ChatDbConflictError(`Route ${routeLabel} changed after the cut; it can no longer be undone`)
      }
      return
    }
    const indexes: number[] = []
    for (let index = 0; index < liveIds.length; index++) {
      if (recordedSet.has(liveIds[index])) indexes.push(index)
    }
    const first = indexes[0] ?? -1
    const last = indexes[indexes.length - 1] ?? -1
    const contiguous = indexes.every((index, offset) => index === first + offset)
    const ordered = indexes.every((index, offset) => liveIds[index] === recordedForOwner[offset])
    const actualPrev = first > 0 ? liveIds[first - 1] : null
    const actualNext = last >= 0 && last + 1 < liveIds.length ? liveIds[last + 1] : null
    // The head-side neighbour pins where the run sits, so a newer row written
    // between it and the run is drift. The tail side only pins the run when the
    // paste landed before an existing row: a run at the route tail may be
    // followed by newer rows, which the undo never touches.
    const expectedNext = placement.nextOwnerMessageId ?? null
    if (
      !contiguous ||
      !ordered ||
      actualPrev !== (placement.prevOwnerMessageId ?? null) ||
      (expectedNext !== null && actualNext !== expectedNext)
    ) {
      throw new ChatDbConflictError(`Route ${routeLabel} changed after the paste; it can no longer be undone`)
    }
  }

  private assertClipboardTreeSameIdSet(actual: string[], expected: string[], what: string): void {
    const actualSet = new Set(actual)
    const expectedSet = new Set(expected)
    let same = actualSet.size === expectedSet.size
    if (same) {
      for (const id of expectedSet) {
        if (!actualSet.has(id)) {
          same = false
          break
        }
      }
    }
    if (!same) {
      throw new ChatDbConflictError(`${what} changed since the operation; it can no longer be replayed`)
    }
  }

  private clipboardTreeMessageFacts(row: BranchHistoryMessageRow): string {
    // `sortOrder` is deliberately excluded: an unrelated insert elsewhere in the
    // same route renumbers it without changing the row, and the owner-order
    // guards cover real reordering.
    //
    // The `blocks` key inside `overflow` is the renderer's derived block-id echo
    // (`message.blocks`), never authority: an ordinary group insert persists it
    // into `messages.extra`, while a tree paste writes the relational rows only
    // and never re-emits it, so a raw comparison would report an untouched
    // source row as changed. It is stripped on BOTH sides here (live rows and
    // captured wires both funnel through this one projection) so the facts stay
    // comparable. Real block drift is still guarded — block rows are compared
    // field-by-field, and each message's block ORDER is compared against the
    // live relation separately.
    const overflow: Record<string, unknown> = { ...((row.overflow ?? {}) as Record<string, unknown>) }
    delete overflow.blocks
    return clipboardStableJson({
      id: row.id,
      topicId: row.topicId,
      branchId: row.branchId ?? null,
      role: row.role ?? null,
      content: row.content ?? null,
      status: row.status ?? null,
      askId: row.askId ?? null,
      model: row.model ?? null,
      modelId: row.modelId ?? null,
      assistantId: row.assistantId ?? null,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      overflow
    })
  }

  private clipboardTreeWireMessageFacts(wire: Record<string, unknown>): string {
    const copy = { ...wire }
    delete copy.blocks
    return this.clipboardTreeMessageFacts(toMessageHistoryRow(wireToMessage(copy as JsonObject)))
  }

  private clipboardTreeBlockFacts(row: BranchHistoryBlockRow): string {
    return clipboardStableJson({
      id: row.id,
      messageId: row.messageId,
      type: row.type ?? null,
      content: row.content ?? null,
      status: row.status ?? null,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      overflow: row.overflow ?? {}
    })
  }

  private clipboardTreeWireBlockFacts(wire: Record<string, unknown>): string {
    return this.clipboardTreeBlockFacts(toBlockHistoryRow(wireToBlock({ ...wire } as JsonObject)))
  }

  /**
   * Route-scoped projection delta of ONE run of rows this transaction installed.
   *
   * The wires are the canonical rows already built for the command response (or
   * read back inside the same transaction), so the delta never re-derives row
   * content: `messages`/`blocks` are restricted to the run's own rows, and
   * `mutableMessageIds` is the subset of the run that this route OWNS (a run row
   * owned by another route is visible only through inheritance and is therefore
   * not mutable through `branchId`). A consumer merges the run into the window
   * of that route it already holds; nothing here is a whole-route image.
   */
  private clipboardTreeInsertProjection(args: {
    topicId: string
    branchId: string | null
    runMessageIds: readonly string[]
    beforeMessageId: string | null
    nextMessageId: string | null
    messages: readonly JsonObject[]
    blocks: readonly JsonObject[]
  }): ClipboardTreeRouteProjection | null {
    const runIds: string[] = []
    for (const id of args.runMessageIds) {
      if (typeof id === 'string' && id.length > 0 && !runIds.includes(id)) runIds.push(id)
    }
    if (runIds.length === 0) return null
    const runSet = new Set(runIds)
    const owner = this.normalizeBranchId(args.branchId)
    const messages: JsonObject[] = []
    const mutableMessageIds: string[] = []
    for (const wire of args.messages) {
      const row = wire as Record<string, unknown>
      const id = typeof row.id === 'string' ? row.id : ''
      if (!runSet.has(id)) continue
      messages.push(wire)
      if (this.normalizeBranchId(row.branchId as string | null | undefined) === owner) mutableMessageIds.push(id)
    }
    if (messages.length === 0) return null
    const blocks = args.blocks.filter((wire) => {
      const row = wire as Record<string, unknown>
      return typeof row.messageId === 'string' && runSet.has(row.messageId)
    })
    return {
      topicId: args.topicId,
      branchId: owner,
      removedMessageIds: [],
      insertedRuns: [
        {
          messageIds: runIds,
          beforeMessageId: args.beforeMessageId,
          nextMessageId: args.nextMessageId
        }
      ],
      mutableMessageIds,
      messages,
      blocks
    }
  }

  /**
   * Owner-scoped removal deltas of ONE command: one delta per route that lost
   * rows of its OWN order. Rows of a removed branch belong to that branch, not
   * to the route the cut was captured from, so a consumer displaying a
   * descendant route intersects exactly the rows authority no longer has while
   * its own surviving prefix stays untouched.
   */
  private clipboardTreeRemovalProjections(
    topicId: string,
    rows: ReadonlyArray<{ id: string; branchId?: string | null }>
  ): ClipboardTreeRouteProjection[] {
    const byOwner = new Map<string | null, string[]>()
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id : ''
      if (id.length === 0) continue
      const owner = this.normalizeBranchId(row.branchId ?? null)
      const ids = byOwner.get(owner)
      if (ids) ids.push(id)
      else byOwner.set(owner, [id])
    }
    const projections: ClipboardTreeRouteProjection[] = []
    for (const [branchId, removedMessageIds] of byOwner) {
      projections.push({
        topicId,
        branchId,
        removedMessageIds,
        insertedRuns: [],
        mutableMessageIds: [],
        messages: [],
        blocks: []
      })
    }
    return projections
  }

  /**
   * Restore runs of ONE owner order: every maximal consecutive run of restored
   * ids, with the recorded surviving neighbours it sat between (`null` = that
   * owner's head/tail). The recorded order is the pre-removal authority order,
   * so a consumer holding a window of that owner's route can place the run
   * exactly where authority put it back and never by a numeric index.
   */
  private clipboardTreeRestoreRuns(
    ownerOrders: ReadonlyArray<{ branchId: string | null; orderedIds: string[] }>,
    restoredIds: ReadonlySet<string>
  ): Map<string | null, ClipboardTreeProjectionRun[]> {
    const runsByOwner = new Map<string | null, ClipboardTreeProjectionRun[]>()
    for (const owner of ownerOrders) {
      const ownerKey = this.normalizeBranchId(owner.branchId)
      const ordered = Array.isArray(owner.orderedIds) ? owner.orderedIds : []
      const runs: ClipboardTreeProjectionRun[] = []
      let current: ClipboardTreeProjectionRun | null = null
      for (let index = 0; index < ordered.length; index++) {
        const id = ordered[index]
        if (typeof id === 'string' && restoredIds.has(id)) {
          if (current === null) {
            const previous = index > 0 ? ordered[index - 1] : null
            current = {
              messageIds: [id],
              beforeMessageId: typeof previous === 'string' && previous.length > 0 ? previous : null,
              nextMessageId: null
            }
          } else {
            current.messageIds.push(id)
          }
          continue
        }
        if (current !== null) {
          current.nextMessageId = typeof id === 'string' && id.length > 0 ? id : null
          runs.push(current)
          current = null
        }
      }
      if (current !== null) runs.push(current)
      if (runs.length > 0) runsByOwner.set(ownerKey, runs)
    }
    return runsByOwner
  }

  /**
   * Canonical wires (rows plus their block wires) of exactly these message ids,
   * read back inside the transaction that just restored/inserted them. Used when
   * the delta's rows are not carried by the command's own insert plan (a replay
   * restore), so a consumer never re-derives row content.
   */
  private clipboardTreeWiresInTx(
    repos: ChatDbRepositories,
    messageIds: readonly string[]
  ): { messages: JsonObject[]; blocks: JsonObject[] } {
    const ids: string[] = []
    for (const id of messageIds) {
      if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id)
    }
    if (ids.length === 0) return { messages: [], blocks: [] }
    const byId = new Map(repos.messages.findByIds(ids).map((row) => [row.id, row]))
    const rows: MessageData[] = []
    for (const id of ids) {
      const row = byId.get(id)
      if (row) rows.push(row)
    }
    if (rows.length === 0) return { messages: [], blocks: [] }
    const blocksByMessage = repos.blocks.listByMessages(rows.map((row) => row.id))
    const blockRows: MessageBlockData[] = []
    for (const row of rows) blockRows.push(...(blocksByMessage.get(row.id) ?? []))
    const blockWires = blocksToWire(blockRows)
    return { messages: reconstructMessageBlockRelations(messagesToWire(rows), blockWires), blocks: blockWires }
  }

  /**
   * Paste one captured clipboard tree.
   *
   * ONE root transaction: target insert (roots on the caller's explicit route,
   * each included child branch as a fresh branch whose anchor is the mapped
   * root) plus, for `cut`, the source removal — so a failed insert leaves the
   * source untouched and a stale source leaves the target untouched. Every
   * captured row gets an independent fresh ID; `askId`, block references,
   * branch parents/anchors and segment membership/header all point at the new
   * IDs, and no shared prefix, ancestor or sibling branch is materialized.
   *
   * `cut` fails closed (before any write) when the payload contains an
   * inherited root (Main never deletes rows it does not own), when the source
   * topology/content no longer matches the capture, or when the target route
   * lies inside the removed subtree.
   */
  pasteClipboardTree(request: PasteClipboardTreeRequest): ChatDbResult<PasteClipboardTreeResponse> {
    return wrapResult(() => {
      const payload = request.payload
      const targetTopicId = request.target.topicId
      const targetRoute = this.normalizeBranchId(request.target.branchId)
      const sourceTopicId = payload.source.topicId
      const sourceRoute = this.normalizeBranchId(payload.source.branchId)
      const targetCtx = this.syncCtxForTopic('pasteClipboardTree', targetTopicId, targetRoute)
      const sourceCtx =
        request.mode === 'cut' ? this.syncCtxForTopic('pasteClipboardTree', sourceTopicId, sourceRoute) : null
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      let result: PasteClipboardTreeResponse
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const targetTopic = repos.topics.getById(targetTopicId)
          if (!targetTopic.found) {
            throw new ChatDbNotFoundError(`Topic ${targetTopicId} does not exist`)
          }
          if (targetTopic.data.deletedAt != null) {
            throw new ChatDbValidationError(`Topic ${targetTopicId} is in the trash and cannot receive a pasted tree`)
          }
          if (targetRoute !== null) {
            this.requireBranchInTx(repos, targetTopicId, targetRoute)
          }
          // Source authority state, only for `cut` (a copy is self-contained and
          // pastes exactly what was captured).
          let closure: ClipboardTreeClosure | null = null
          if (request.mode === 'cut') {
            closure = this.deriveClipboardTreeClosureInTx(
              repos,
              sourceTopicId,
              sourceRoute,
              payload.roots.map((root) => root.groupId)
            )
            if (closure.inheritedRootMessageIds.length > 0) {
              throw new ChatDbValidationError(
                `Inherited root message ${closure.inheritedRootMessageIds[0]} is copy-only and cannot be cut`
              )
            }
            this.assertClipboardTreePayloadMatchesClosureInTx(repos, payload, closure)
            if (sourceTopicId === targetTopicId && targetRoute !== null) {
              for (const entry of closure.branches) {
                if (entry.data.id === targetRoute) {
                  throw new ChatDbValidationError(
                    `Target branch ${targetRoute} is part of the cut subtree and cannot receive the paste`
                  )
                }
              }
            }
          }
          // Cut preimage is captured BEFORE the target insert so a same-topic cut
          // still records the pre-operation positions.
          const capturedSource = closure
            ? this.captureClipboardTreeSourceRemovalInTx(repos, {
                topicId: sourceTopicId,
                branchId: sourceRoute,
                branchIds: closure.branches.map((entry) => entry.data.id),
                ownedMessageIds: [
                  ...closure.rootRows.map((row) => row.id),
                  ...closure.ownedByBranch.flatMap((entry) => entry.rows.map((row) => row.id))
                ]
              })
            : null
          const { ownerIndex, ownerStart } = this.resolveClipboardTreeInsertIndexInTx(
            repos,
            targetTopicId,
            targetRoute,
            request.target.intent as unknown as Record<string, unknown>
          )
          const placement: ClipboardTreePlacement = {
            topicId: targetTopicId,
            branchId: targetRoute,
            intent: request.target.intent,
            ownerIndex,
            prevOwnerMessageId: ownerIndex > 0 ? (ownerStart[ownerIndex - 1]?.id ?? null) : null,
            nextOwnerMessageId: ownerStart[ownerIndex]?.id ?? null
          }
          const built = this.buildClipboardTreePlanFromPayload(repos, payload, targetTopicId, targetRoute, placement)
          const insertedOutcome = this.insertClipboardTreePlanInTx(repos, stx, targetCtx, built.plan)
          if (insertedOutcome.notify) syncNotify = true
          unsupportedBlockIds.push(...insertedOutcome.unsupportedBlockIds)
          const inserted = this.buildClipboardTreeInsertedRowsInTx(repos, built.plan)
          let appliedRemoval: ClipboardTreeSourceRemoval | null = null
          let sourceFileIds: string[] = []
          if (capturedSource) {
            const applied = this.applyClipboardTreeSourceRemovalInTx(repos, tx, stx, sourceCtx, capturedSource.removal)
            appliedRemoval = applied.removal
            sourceFileIds = capturedSource.affectedFileIds
            if (applied.notify) syncNotify = true
          }
          // Target route delta: the root run this transaction placed. The wires
          // are the canonical rows of the same commit; ownership decides the
          // route-scoped capability the renderer may publish.
          const targetInsertProjection = this.clipboardTreeInsertProjection({
            topicId: targetTopicId,
            branchId: targetRoute,
            runMessageIds: built.insertedRootMessageIds,
            beforeMessageId: placement.prevOwnerMessageId,
            nextMessageId: placement.nextOwnerMessageId,
            messages: inserted.messages,
            blocks: inserted.blocks
          })
          return {
            ...buildFileCleanupResult(repos, sourceFileIds),
            mode: request.mode,
            targetTopicId,
            targetBranchId: targetRoute,
            sourceTopicId,
            sourceBranchId: sourceRoute,
            insertedMessageIds: [
              ...built.plan.rootRows.map((row) => row.id),
              ...built.plan.branches.flatMap((entry) => entry.rows.map((row) => row.id))
            ],
            insertedRootMessageIds: built.insertedRootMessageIds,
            insertedBranchIds: built.plan.branches.map((entry) => entry.branch.id),
            insertedSegmentIds: built.plan.segments.map((entry) => entry.row.id),
            beforeMessageId: placement.prevOwnerMessageId,
            nextMessageId: placement.nextOwnerMessageId,
            deletedSourceMessageIds: appliedRemoval?.messages.map((row) => row.id) ?? [],
            deletedSourceBranchIds: appliedRemoval?.branches.map((row) => row.id) ?? [],
            idMap: built.idMap,
            // Projection deltas of THIS transaction, per affected route: the
            // target route's placed root run (with Main's own ownership fact as
            // capability) plus every route that lost rows of its own order.
            projections: [
              ...(targetInsertProjection ? [targetInsertProjection] : []),
              ...this.clipboardTreeRemovalProjections(sourceTopicId, appliedRemoval?.messages ?? [])
            ],
            snapshot: {
              kind: 'clipboard-tree',
              mode: request.mode,
              idMap: built.idMap,
              placement,
              inserted,
              sourceRemoved: appliedRemoval
            }
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('pasteClipboardTree', targetCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('pasteClipboardTree', unsupportedBlockIds)
      return result
    }, `pasteClipboardTree(${request.target.topicId}, ${request.payload.roots.length} roots, ${request.mode})`)
  }

  /**
   * Delete the selected owned messages of ONE explicit route together with the
   * branch subtrees anchored on them — the same source scope a tree cut would
   * remove, but with no target insert, no clipboard write and no paste.
   *
   * ONE root transaction: resolve the selection closure, capture the removal
   * preimage, then apply the removal — so any refusal (unknown topic/branch,
   * inherited root, a non-included branch anchored on the doomed rows) leaves
   * zero writes. The delete snapshot (`mode: 'delete'`, empty insert) replays
   * through the existing cut machinery: undo restores the removed rows at
   * their recorded positions, redo removes them again.
   */
  deleteClipboardTree(request: DeleteClipboardTreeRequest): ChatDbResult<DeleteClipboardTreeResponse> {
    return wrapResult(() => {
      const topicId = request.topicId
      const route = this.normalizeBranchId(request.branchId)
      const sourceCtx = this.syncCtxForTopic('deleteClipboardTree', topicId, route)
      let syncNotify = false
      let result: DeleteClipboardTreeResponse
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }
          if (topic.data.deletedAt != null) {
            throw new ChatDbValidationError(`Topic ${topicId} is in the trash and cannot be deleted from`)
          }
          if (route !== null) {
            this.requireBranchInTx(repos, topicId, route)
          }
          const closure = this.deriveClipboardTreeClosureInTx(repos, topicId, route, request.groupIds)
          if (closure.inheritedRootMessageIds.length > 0) {
            throw new ChatDbValidationError(
              `Inherited root message ${closure.inheritedRootMessageIds[0]} is copy-only and cannot be deleted`
            )
          }
          // A branch outside the doomed forest must never lose its anchor: any
          // non-included branch still anchored on a captured row refuses the
          // delete before the first write.
          const includedBranchIds = new Set(closure.branches.map((entry) => entry.data.id))
          for (const branch of repos.branches.listByTopic(topicId)) {
            if (includedBranchIds.has(branch.id)) continue
            if (closure.capturedMessageIds.has(branch.anchorMessageId)) {
              throw new ChatDbValidationError(
                `Branch ${branch.id} anchors on a message this delete would remove; it is outside the deleted subtree`
              )
            }
          }
          const capturedSource = this.captureClipboardTreeSourceRemovalInTx(repos, {
            topicId,
            branchId: route,
            branchIds: closure.branches.map((entry) => entry.data.id),
            ownedMessageIds: [
              ...closure.rootRows.map((row) => row.id),
              ...closure.ownedByBranch.flatMap((entry) => entry.rows.map((row) => row.id))
            ]
          })
          // Placement pins the doomed span inside its own pre-delete owner
          // order: the survivors flanking the removed rows. Undo compares the
          // post-delete route against the recorded survivors; redo of a delete
          // carries no insert so the index is vacuous.
          const ownerOrder = capturedSource.removal.ownerOrders.find((entry) => (entry.branchId ?? null) === route)
          const orderedIds = ownerOrder?.orderedIds ?? []
          const removedIds = new Set(capturedSource.removal.messages.map((row) => row.id))
          let ownerIndex = orderedIds.length
          for (let index = 0; index < orderedIds.length; index++) {
            if (removedIds.has(orderedIds[index])) {
              ownerIndex = index
              break
            }
          }
          let prevOwnerMessageId: string | null = null
          let nextOwnerMessageId: string | null = null
          for (let index = ownerIndex - 1; index >= 0; index--) {
            if (!removedIds.has(orderedIds[index])) {
              prevOwnerMessageId = orderedIds[index]
              break
            }
          }
          for (let index = ownerIndex; index < orderedIds.length; index++) {
            if (!removedIds.has(orderedIds[index])) {
              nextOwnerMessageId = orderedIds[index]
              break
            }
          }
          const placement: ClipboardTreePlacement = {
            topicId,
            branchId: route,
            intent: { kind: 'topic-tail' },
            ownerIndex,
            prevOwnerMessageId,
            nextOwnerMessageId
          }
          const applied = this.applyClipboardTreeSourceRemovalInTx(repos, tx, stx, sourceCtx, capturedSource.removal)
          if (applied.notify) syncNotify = true
          const deletedMessageIds = applied.removal.messages.map((row) => row.id)
          const deletedBranchIds = applied.removal.branches.map((row) => row.id)
          const snapshot: ClipboardTreeSnapshot = {
            kind: 'clipboard-tree',
            mode: 'delete',
            idMap: [],
            placement,
            inserted: { messages: [], blocks: [], branches: [], segments: [] },
            sourceRemoved: applied.removal
          }
          return {
            ...buildFileCleanupResult(repos, capturedSource.affectedFileIds),
            topicId,
            branchId: route,
            deletedMessageIds,
            deletedBranchIds,
            snapshot,
            // Route-scoped removal deltas of THIS transaction, owner-scoped
            // from the removed snapshot rows.
            projections: this.clipboardTreeRemovalProjections(topicId, applied.removal.messages)
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteClipboardTree', sourceCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      return result
    }, `deleteClipboardTree(${request.topicId}, ${request.groupIds.length} groups)`)
  }

  /**
   * Replay one tree copy/cut: ONE undo entry covering both the target insert and
   * (for cut) the source removal.
   *
   * `undo` removes exactly the recorded target rows and restores the recorded
   * source rows; `redo` re-inserts the same generated IDs at the recorded
   * neighbours and removes the source rows again. Both directions compare the
   * CURRENT affected state with the snapshot first and fail closed with zero
   * writes on any divergence, so a newer unrelated edit is never overwritten and
   * an undo never cascades into rows the operation did not create.
   */
  replayClipboardTree(request: ReplayClipboardTreeRequest): ChatDbResult<ReplayClipboardTreeResponse> {
    return wrapResult(() => {
      const snapshot = request.snapshot
      const targetTopicId = snapshot.placement.topicId
      const targetRoute = this.normalizeBranchId(snapshot.placement.branchId)
      const sourceTopicId = snapshot.sourceRemoved?.topicId ?? null
      const sourceRoute = snapshot.sourceRemoved ? this.normalizeBranchId(snapshot.sourceRemoved.branchId) : null
      const targetCtx = this.syncCtxForTopic('replayClipboardTree', targetTopicId, targetRoute)
      const sourceCtx =
        sourceTopicId !== null ? this.syncCtxForTopic('replayClipboardTree', sourceTopicId, sourceRoute) : null
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      let result: ReplayClipboardTreeResponse
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const targetTopic = repos.topics.getById(targetTopicId)
          if (!targetTopic.found) {
            throw new ChatDbNotFoundError(`Topic ${targetTopicId} does not exist`)
          }
          if (request.direction === 'undo') {
            const removed = this.removeClipboardTreeTargetInTx(repos, tx, stx, targetCtx, snapshot)
            if (removed.notify) syncNotify = true
            let restored: { restoredMessageIds: string[]; restoredBranchIds: string[]; affectedFileIds: string[] } = {
              restoredMessageIds: [],
              restoredBranchIds: [],
              affectedFileIds: []
            }
            if (snapshot.sourceRemoved) {
              const sourceTopic = repos.topics.getById(snapshot.sourceRemoved.topicId)
              if (!sourceTopic.found) {
                throw new ChatDbNotFoundError(`Topic ${snapshot.sourceRemoved.topicId} does not exist`)
              }
              restored = this.restoreClipboardTreeSourceInTx(repos, tx, snapshot.sourceRemoved)
            }
            // Projection deltas of THIS transaction: the target rows this undo
            // removed (owner-scoped, from the recorded wires of the same rows)
            // plus, per owner, the runs the restore put back at the recorded
            // positions of that owner's order.
            const undoneIdSet = new Set(removed.removedMessageIds)
            const undoneRows = (snapshot.inserted.messages as unknown as Array<Record<string, unknown>>)
              .map((wire) => ({
                id: typeof wire.id === 'string' ? wire.id : '',
                branchId: (wire.branchId ?? null) as string | null
              }))
              .filter((row) => row.id.length > 0 && undoneIdSet.has(row.id))
            const projections: ClipboardTreeRouteProjection[] = [
              ...this.clipboardTreeRemovalProjections(targetTopicId, undoneRows)
            ]
            if (snapshot.sourceRemoved && restored.restoredMessageIds.length > 0) {
              const restoreWires = this.clipboardTreeWiresInTx(repos, restored.restoredMessageIds)
              const runsByOwner = this.clipboardTreeRestoreRuns(
                snapshot.sourceRemoved.ownerOrders ?? [],
                new Set(restored.restoredMessageIds)
              )
              for (const [owner, runs] of runsByOwner) {
                for (const run of runs) {
                  const projection = this.clipboardTreeInsertProjection({
                    topicId: snapshot.sourceRemoved.topicId,
                    branchId: owner,
                    runMessageIds: run.messageIds,
                    beforeMessageId: run.beforeMessageId,
                    nextMessageId: run.nextMessageId,
                    messages: restoreWires.messages,
                    blocks: restoreWires.blocks
                  })
                  if (projection) projections.push(projection)
                }
              }
            }
            return {
              ...buildFileCleanupResult(repos, [...removed.affectedFileIds, ...restored.affectedFileIds]),
              direction: 'undo' as const,
              mode: snapshot.mode,
              targetTopicId,
              sourceTopicId,
              removedMessageIds: removed.removedMessageIds,
              removedBranchIds: removed.removedBranchIds,
              restoredMessageIds: restored.restoredMessageIds,
              restoredBranchIds: restored.restoredBranchIds,
              projections
            }
          }
          if (targetTopic.data.deletedAt != null) {
            throw new ChatDbValidationError(`Topic ${targetTopicId} is in the trash and cannot receive a pasted tree`)
          }
          if (targetRoute !== null) {
            this.requireBranchInTx(repos, targetTopicId, targetRoute)
          }
          this.assertClipboardTreeInsertAbsentInTx(repos, snapshot)
          const ownerIndex = this.resolveClipboardTreeReplayIndexInTx(repos, snapshot)
          if (snapshot.sourceRemoved) {
            this.assertClipboardTreeSourceRemovalCurrentInTx(repos, snapshot.sourceRemoved)
          }
          const plan = this.buildClipboardTreePlanFromSnapshot(snapshot)
          plan.placement = { ...plan.placement, ownerIndex }
          const insertedOutcome = this.insertClipboardTreePlanInTx(repos, stx, targetCtx, plan)
          if (insertedOutcome.notify) syncNotify = true
          unsupportedBlockIds.push(...insertedOutcome.unsupportedBlockIds)
          let sourceFileIds: string[] = []
          if (snapshot.sourceRemoved) {
            const sourceTopic = repos.topics.getById(snapshot.sourceRemoved.topicId)
            if (!sourceTopic.found) {
              throw new ChatDbNotFoundError(`Topic ${snapshot.sourceRemoved.topicId} does not exist`)
            }
            sourceFileIds = collectAffectedFileIds(
              repos.fileRefs.listByMessages(snapshot.sourceRemoved.messages.map((row) => row.id))
            )
            const applied = this.applyClipboardTreeSourceRemovalInTx(repos, tx, stx, sourceCtx, snapshot.sourceRemoved)
            if (applied.notify) syncNotify = true
          }
          // Projection deltas of THIS transaction: the target route's placed
          // root run (rows read back from the same commit) plus every route the
          // repeated cut removed rows from (owner-scoped from the snapshot rows).
          const redoWires = this.clipboardTreeWiresInTx(
            repos,
            plan.rootRows.map((row) => row.id)
          )
          const redoInsertProjection = this.clipboardTreeInsertProjection({
            topicId: targetTopicId,
            branchId: targetRoute,
            runMessageIds: plan.rootRows.map((row) => row.id),
            beforeMessageId: plan.placement.prevOwnerMessageId,
            nextMessageId: plan.placement.nextOwnerMessageId,
            messages: redoWires.messages,
            blocks: redoWires.blocks
          })
          const projections: ClipboardTreeRouteProjection[] = [
            ...(redoInsertProjection ? [redoInsertProjection] : []),
            ...(snapshot.sourceRemoved
              ? this.clipboardTreeRemovalProjections(snapshot.sourceRemoved.topicId, snapshot.sourceRemoved.messages)
              : [])
          ]
          return {
            ...buildFileCleanupResult(repos, sourceFileIds),
            direction: 'redo' as const,
            mode: snapshot.mode,
            targetTopicId,
            sourceTopicId,
            removedMessageIds: snapshot.sourceRemoved?.messages.map((row) => row.id) ?? [],
            removedBranchIds: snapshot.sourceRemoved?.branches.map((row) => row.id) ?? [],
            restoredMessageIds: [
              ...plan.rootRows.map((row) => row.id),
              ...plan.branches.flatMap((entry) => entry.rows.map((row) => row.id))
            ],
            restoredBranchIds: plan.branches.map((entry) => entry.branch.id),
            projections
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('replayClipboardTree', targetCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('replayClipboardTree', unsupportedBlockIds)
      return result
    }, `replayClipboardTree(${request.direction} ${request.snapshot.mode})`)
  }

  /**
   * Bounded topic naming-context READ for automatic/manual naming.
   *
   * One authoritative SQLite transaction using only bounded queries over the
   * existing topic_id/sort_order authority ordering — count, first row, and
   * latest at most 5 rows — plus blocks for at most 6 deduplicated returned
   * message IDs. Never calls listByTopic/fetchWholeTopicSnapshot.
   * - Missing topic → NOT_FOUND (never an ambiguous empty success).
   * - Existing empty topic → count 0, null first/latest bounds, empty arrays.
   * - First message overlapping the latest window shares one block fetch.
   * - Pure read: never creates/mutates rows, never logs content.
   */
  fetchTopicNamingContext(request: FetchTopicNamingContextRequest): ChatDbResult<FetchTopicNamingContextResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        const namingBranchId = this.normalizeBranchId(request.branchId)
        const messageCount =
          namingBranchId === null
            ? repos.messages.countByTopic(request.topicId)
            : this.resolveRouteMessagesInTx(repos, request.topicId, namingBranchId).messages.length
        // Branch routes name from the effective route (shared prefix through
        // each anchor + owned suffix, stable IDs, deterministic order).
        if (namingBranchId !== null) {
          const effectiveForNaming = this.resolveRouteMessagesInTx(repos, request.topicId, namingBranchId).messages
          const rawFlagForBranch = (topic.data.overflow as Record<string, unknown> | undefined)?.isNameManuallyEdited
          if (effectiveForNaming.length === 0) {
            return {
              topic: {
                id: topic.data.id,
                name: topic.data.name ?? null,
                isNameManuallyEdited: typeof rawFlagForBranch === 'boolean' ? rawFlagForBranch : null
              },
              messageCount: 0,
              firstMessage: null,
              latestMessages: [],
              blocks: [],
              naming: {
                completeness: 'naming-context' as const,
                topicId: request.topicId,
                firstMessageId: null,
                lastMessageId: null,
                returnedLatestCount: 0
              }
            }
          }
          const firstForBranch = effectiveForNaming[0]
          const latestForBranch = effectiveForNaming.slice(-5)
          const returnedIdsForBranch: string[] = []
          const seenIdsForBranch = new Set<string>()
          for (const m of [firstForBranch, ...latestForBranch]) {
            if (!seenIdsForBranch.has(m.id)) {
              seenIdsForBranch.add(m.id)
              returnedIdsForBranch.push(m.id)
            }
          }
          const blockDataMapForBranch = repos.blocks.listByMessages(returnedIdsForBranch)
          const orderedBlocksForBranch: MessageBlockData[] = []
          for (const id of returnedIdsForBranch) {
            orderedBlocksForBranch.push(...(blockDataMapForBranch.get(id) ?? []))
          }
          const wireFirstListForBranch = reconstructMessageBlockRelations(
            messagesToWire([firstForBranch]),
            blocksToWire(blockDataMapForBranch.get(firstForBranch.id) ?? [])
          )
          const wireLatestForBranch = reconstructMessageBlockRelations(
            messagesToWire(latestForBranch),
            blocksToWire(latestForBranch.flatMap((m) => blockDataMapForBranch.get(m.id) ?? []))
          )
          return {
            topic: {
              id: topic.data.id,
              name: topic.data.name ?? null,
              isNameManuallyEdited: typeof rawFlagForBranch === 'boolean' ? rawFlagForBranch : null
            },
            messageCount: effectiveForNaming.length,
            firstMessage: wireFirstListForBranch[0] ?? null,
            latestMessages: wireLatestForBranch,
            blocks: blocksToWire(orderedBlocksForBranch),
            naming: {
              completeness: 'naming-context' as const,
              topicId: request.topicId,
              firstMessageId: firstForBranch.id,
              lastMessageId: latestForBranch[latestForBranch.length - 1].id,
              returnedLatestCount: latestForBranch.length
            }
          }
        }
        if (messageCount === 0) {
          const rawFlag = (topic.data.overflow as Record<string, unknown> | undefined)?.isNameManuallyEdited
          return {
            topic: {
              id: topic.data.id,
              name: topic.data.name ?? null,
              isNameManuallyEdited: typeof rawFlag === 'boolean' ? rawFlag : null
            },
            messageCount: 0,
            firstMessage: null,
            latestMessages: [],
            blocks: [],
            naming: {
              completeness: 'naming-context' as const,
              topicId: request.topicId,
              firstMessageId: null,
              lastMessageId: null,
              returnedLatestCount: 0
            }
          }
        }
        const first = repos.messages.getFirstByTopic(request.topicId)
        const latest = repos.messages.getLatestByTopic(request.topicId, 5)
        if (!first || latest.length === 0) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} has no readable messages`)
        }
        const returnedIds: string[] = []
        const seenIds = new Set<string>()
        const pushId = (id: string): void => {
          if (!seenIds.has(id)) {
            seenIds.add(id)
            returnedIds.push(id)
          }
        }
        pushId(first.id)
        for (const m of latest) pushId(m.id)
        const blockDataMap = repos.blocks.listByMessages(returnedIds)
        const orderedBlocks: MessageBlockData[] = []
        for (const id of returnedIds) {
          orderedBlocks.push(...(blockDataMap.get(id) ?? []))
        }
        const wireFirstList = reconstructMessageBlockRelations(
          messagesToWire([first]),
          blocksToWire(blockDataMap.get(first.id) ?? [])
        )
        const wireLatest = reconstructMessageBlockRelations(
          messagesToWire(latest),
          blocksToWire(latest.flatMap((m) => blockDataMap.get(m.id) ?? []))
        )
        const wireBlocks = blocksToWire(orderedBlocks)
        const rawFlag = (topic.data.overflow as Record<string, unknown> | undefined)?.isNameManuallyEdited
        return {
          topic: {
            id: topic.data.id,
            name: topic.data.name ?? null,
            isNameManuallyEdited: typeof rawFlag === 'boolean' ? rawFlag : null
          },
          messageCount,
          firstMessage: wireFirstList[0] ?? null,
          latestMessages: wireLatest,
          blocks: wireBlocks,
          naming: {
            completeness: 'naming-context' as const,
            topicId: request.topicId,
            firstMessageId: first.id,
            lastMessageId: latest[latest.length - 1].id,
            returnedLatestCount: latest.length
          }
        }
      })
    }, `fetchTopicNamingContext(${request.topicId})`)
  }

  /**
   * Bounded topic activity READ for provider rate-limit checks.
   *
   * One authoritative SQLite transaction using only bounded queries over the
   * existing topic_id/sort_order authority ordering — count plus the latest
   * single row. No messages or blocks cross the wire.
   * - Missing topic → NOT_FOUND (callers treat metadata failure as allow-send).
   * - Existing empty topic → count 0 with null latest id/timestamp.
   * - Pure read: never creates/mutates rows, never logs content.
   */
  fetchTopicActivity(request: FetchTopicActivityRequest): ChatDbResult<FetchTopicActivityResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(request.topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} does not exist`)
        }
        const activityBranchId = this.normalizeBranchId(request.branchId)
        const messageCount =
          activityBranchId === null
            ? repos.messages.countByTopic(request.topicId)
            : this.resolveRouteMessagesInTx(repos, request.topicId, activityBranchId).messages.length
        // Branch routes report activity over the effective route.
        if (activityBranchId !== null) {
          const effectiveForActivity = this.resolveRouteMessagesInTx(repos, request.topicId, activityBranchId).messages
          if (effectiveForActivity.length === 0) {
            return {
              messageCount: 0,
              latestMessageId: null,
              latestMessageCreatedAt: null,
              activity: {
                completeness: 'topic-activity' as const,
                topicId: request.topicId
              }
            }
          }
          const latestRowForBranch = effectiveForActivity[effectiveForActivity.length - 1]
          return {
            messageCount: effectiveForActivity.length,
            latestMessageId: latestRowForBranch.id,
            latestMessageCreatedAt: latestRowForBranch.createdAt ?? null,
            activity: {
              completeness: 'topic-activity' as const,
              topicId: request.topicId
            }
          }
        }
        if (messageCount === 0) {
          return {
            messageCount: 0,
            latestMessageId: null,
            latestMessageCreatedAt: null,
            activity: {
              completeness: 'topic-activity' as const,
              topicId: request.topicId
            }
          }
        }
        const latest = repos.messages.getLatestByTopic(request.topicId, 1)
        const latestRow = latest[0]
        if (!latestRow) {
          throw new ChatDbNotFoundError(`Topic ${request.topicId} has no readable messages`)
        }
        return {
          messageCount,
          latestMessageId: latestRow.id,
          latestMessageCreatedAt: latestRow.createdAt ?? null,
          activity: {
            completeness: 'topic-activity' as const,
            topicId: request.topicId
          }
        }
      })
    }, `fetchTopicActivity(${request.topicId})`)
  }

  /**
   * Batched topic message-time READ (`'topic-activity'` completeness).
   *
   * Returns, per requested topic that still exists, the maximum REAL INSTANT
   * of every message `createdAt` visible in ANY route of that topic:
   *
   * - Every row owned by the topic counts, because each one is visible in at
   *   least the route that owns it (main route or its own branch). Deleting a
   *   branch physically removes its owned rows (FK cascade), so removed
   *   branches contribute nothing.
   * - A reference target additionally sees its live foreign prefix, which is
   *   the source route composed up to the captured endpoint (recursive and
   *   cycle-guarded). The prefix is bounded by the endpoint, so the target
   *   never inherits the source topic's full time span.
   * - Ordering is by instant, never by text or by activity order: the
   *   authority sort tail, `message.updatedAt` and topic timestamps are
   *   ignored, and offsets/seconds-only/fractional imported values compare
   *   correctly.
   * - `null` means no usable message instant exists. Main never fabricates
   *   one; the caller owns its conservative fallback.
   *
   * One SQLite transaction; no messages or blocks cross the wire.
   */
  fetchTopicMessageTimes(request: FetchTopicMessageTimesRequest): ChatDbResult<FetchTopicMessageTimesResponse> {
    return wrapResult(() => {
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topicIds = Array.from(new Set(request.topicIds))
        const ownMaxMs = repos.messages.getMaxCreatedAtMsByTopics(topicIds)
        const entries: FetchTopicMessageTimesEntry[] = []
        for (const topicId of topicIds) {
          const topic = repos.topics.getById(topicId)
          // A topic deleted between the request and this read is omitted, not
          // guessed: the counts below make that explicit to the caller.
          if (!topic.found) continue
          let instantMs = ownMaxMs.get(topicId) ?? null
          const prefix = this.resolveReferenceBaseInTx(repos, topicId, new Set<string>(), 0)
          for (const message of prefix.messages) {
            const messageMs = messageCreatedAtMs(message.createdAt)
            if (messageMs !== null && (instantMs === null || messageMs > instantMs)) {
              instantMs = messageMs
            }
          }
          entries.push({
            topicId,
            latestMessageAt: instantMs === null ? null : new Date(instantMs).toISOString()
          })
        }
        return {
          topics: entries,
          messageTimes: {
            completeness: 'topic-activity' as const,
            requestedTopicCount: topicIds.length,
            returnedTopicCount: entries.length
          }
        }
      })
    }, `fetchTopicMessageTimes(${request.topicIds.length} topics)`)
  }

  /**
   * S6.2c-2: Resolve anchor → group-tail insert index.
   *
   * One authoritative helper for Main:
   * - Ordered authority messages sort_order ASC, id ASC (via listByTopic).
   * - Validates anchor membership; advances past contiguous assistant messages
   *   with same non-empty ask_id as anchor when existing behavior requires
   *   group-tail insertion (anchor role assistant + askId).
   * - Returns resolved insertIndex (anchor-group tail + 1).
   * Factored for reuse + testability; no renderer state.
   */
  private resolveInsertIndexAfterAnchor(orderedMessages: MessageData[], anchor: MessageData): number {
    const anchorIdx = orderedMessages.findIndex((m) => m.id === anchor.id)
    if (anchorIdx === -1) {
      throw new ChatDbNotFoundError(`Anchor message ${anchor.id} does not belong to its topic`)
    }
    let tailIdx = anchorIdx
    const askId = (anchor as any).askId as string | undefined
    if (anchor.role === 'assistant' && typeof askId === 'string' && askId.length > 0) {
      for (let i = anchorIdx + 1; i < orderedMessages.length; i++) {
        const cur = orderedMessages[i]
        if (cur.role === 'assistant' && (cur as any).askId === askId) {
          tailIdx = i
        } else {
          break
        }
      }
    }
    return tailIdx + 1
  }

  /**
   * S6.2c-2: Main-authoritative insert after stable anchor.
   *
   * One atomic Main SQLite transaction:
   * - Validates topic exists, anchor belongs to the addressed effective route.
   * - Owned anchor: group-tail index inside the owner rows (established behavior).
   * - Inherited (ancestor-reference) anchor on a branch route: allowed ONLY
   *   when the anchor ID exactly equals the addressed branch's current fork
   *   boundary (anchorMessageId / parent-reference final answer).
   *   That sole exception inserts durably at the START of the branch owned
   *   suffix (index 0), so the effective order is ancestor prefix through
   *   branch anchor, then new rows, then the previous suffix. Any older
   *   ancestor reference rejects fail-closed (BRANCH-3) with zero writes.
   *   Main-route inherited anchors cannot occur (main has no ancestors);
   *   main inserts keep owned group-tail behavior.
   * - Inserts supplied entries with existing dense-order repository logic
   *   (batch insertManyAt, existing IDs preserve position via patch-only).
   * - Upserts blocks + syncs file references in original entry order.
   * - Fail closed: validation/read/write errors throw typed envelope, no partial publication.
   * - Returns the authoritative insert response: cleanup fields plus canonical
   *   inserted wire, stable neighbor placement, and mutability delta.
   */
  insertMessagesAfterAnchor(
    topicId: string,
    afterMessageId: string,
    entries: Array<{ message: JsonObject; blocks: JsonObject[] }>,
    branchId?: string | null
  ): ChatDbResult<InsertMessagesAfterAnchorResponse> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('insertMessagesAfterAnchor', topicId, route)
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      let result: InsertMessagesAfterAnchorResponse
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Validate topic exists
          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }
          // Validate anchor membership inside the addressed effective route.
          // BRANCH-3 bounded insertion: ancestor references are read-only.
          // The sole fork-boundary exception is an inherited anchor whose ID
          // exactly equals the addressed branch's current fork boundary (anchorMessageId);
          // new rows land at the START of the route owner's suffix (BRANCH-11
          // effective order: prefix through branch anchor, then owned
          // suffix). Ordered authority for owner sequencing is the route
          // owner's rows — ordering never crosses route owners. Older
          // ancestor references reject fail-closed with zero writes.
          const routeMessages = this.resolveRouteMessagesInTx(repos, topicId, route).messages
          const anchorData = routeMessages.find((m) => m.id === afterMessageId)
          if (!anchorData) {
            throw new ChatDbNotFoundError(`Anchor message ${afterMessageId} does not belong to topic ${topicId}`)
          }
          const ownerMessages = repos.messages.listByTopic(topicId, route)
          const anchorOwned = (anchorData.branchId ?? null) === route && anchorData.topicId === topicId
          let resolvedInsertIndex: number
          if (anchorOwned) {
            resolvedInsertIndex = this.resolveInsertIndexAfterAnchor(ownerMessages, anchorData)
          } else {
            if (route === null) {
              // Cross-topic reference fork boundary: the exact foreign endpoint
              // (the reference anchor) may receive insertions at the START of
              // the target's own suffix; older foreign prefix messages stay
              // read-only.
              const ref = repos.topicReferences.getByTarget(topicId)
              if (ref.found && ref.data.anchorMessageId === afterMessageId) {
                resolvedInsertIndex = 0
              } else {
                throw new ChatDbValidationError(
                  `Anchor message ${afterMessageId} is not owned by this route and insertion is read-only`
                )
              }
            } else {
              const addressedBranch = repos.branches.getById(route)
              if (!addressedBranch.found || addressedBranch.data.topicId !== topicId) {
                throw new ChatDbNotFoundError(`Branch ${route} does not exist in topic ${topicId}`)
              }
              if (afterMessageId !== addressedBranch.data.anchorMessageId) {
                throw new ChatDbValidationError(
                  `Anchor message ${afterMessageId} is an ancestor reference and is read-only through this route`
                )
              }
              resolvedInsertIndex = 0
            }
          }

          // BRANCH-4/11: genuinely new suffixes never require existing-group
          // mutability. Reading an ancestor root/group to resolve placement
          // is not a mutation; only rows actually written/deleted/reordered
          // are owner-validated per-target below. Fresh askIds and appends
          // onto inherited groups both land as owned suffix rows.

          // Phase 1 — convert every entry, enforce block ownership, classify new vs existing
          // (DB-existence classification preserved exactly for chat writes).
          const newMessages: MessageData[] = []
          const newMessageIds = new Set<string>()
          const existingPlans: Array<{ id: string; patch: Record<string, unknown> }> = []
          const phase4Plans: Array<{ blocks: MessageBlockData[]; harvest: boolean }> = []
          const allAffectedFileIds: string[] = []
          // Pre-state snapshots for sync diffing (taken before any mutation in this tx).
          const preMessageRows = new Map<string, MessageData>()
          const preBlockRows = new Map<string, MessageBlockData>()
          if (ctx) {
            const seenMsg = new Set<string>()
            for (const entry of entries) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && mid.length > 0 && !seenMsg.has(mid)) {
                seenMsg.add(mid)
                const pre = repos.messages.getById(mid)
                if (pre.found) preMessageRows.set(mid, { ...pre.data, overflow: { ...pre.data.overflow } })
              }
              for (const b of entry.blocks) {
                const bid = (b as Record<string, unknown>).id as string
                if (typeof bid === 'string' && bid.length > 0 && !preBlockRows.has(bid)) {
                  const pre = repos.blocks.getById(bid)
                  if (pre.found) preBlockRows.set(bid, { ...pre.data, overflow: { ...pre.data.overflow } })
                }
              }
            }
          }

          for (const entry of entries) {
            const messageData = wireToMessage(entry.message)
            messageData.topicId = topicId
            messageData.branchId = route
            const blockDataList = entry.blocks.map(wireToBlock)
            for (const block of blockDataList) {
              block.messageId = messageData.id
            }
            this.assignAuthoritativeBlockOrder(entry.message, blockDataList)
            const patch = wireToMessagePatch(entry.message)
            delete patch.id
            delete patch.topicId
            delete patch.branchId
            delete patch.sortOrder

            const existing = repos.messages.getById(messageData.id)
            if (existing.found) {
              if (existing.data.topicId !== topicId) {
                throw new ChatDbConflictError(
                  `Message ${messageData.id} belongs to topic ${existing.data.topicId}, cannot insert into topic ${topicId}`
                )
              }
              // BRANCH-4 owner equality only: patching a read-only ancestor
              // reference through this route rejects (no copy-on-write).
              this.assertMutableMessageInTx(
                repos,
                tx as unknown as BetterSQLite3Database<typeof schema>,
                topicId,
                route,
                messageData.id
              )
              existingPlans.push({ id: messageData.id, patch })
              phase4Plans.push({ blocks: blockDataList, harvest: true })
            } else if (newMessageIds.has(messageData.id)) {
              existingPlans.push({ id: messageData.id, patch })
              phase4Plans.push({ blocks: blockDataList, harvest: true })
            } else {
              newMessageIds.add(messageData.id)
              newMessages.push(messageData)
              phase4Plans.push({ blocks: blockDataList, harvest: false })
            }
          }

          // Phase 2 — batch-insert all new messages at resolved anchor group tail
          if (newMessages.length > 0) {
            repos.messages.insertManyAt(newMessages, resolvedInsertIndex)
          }

          // Phase 3 — metadata patches for existing rows / in-request duplicates
          for (const plan of existingPlans) {
            if (Object.keys(plan.patch).length > 0) {
              repos.messages.update(topicId, plan.id, plan.patch)
            }
          }

          // Phase 4 — harvest prior refs (existing entries only), then upsert blocks + sync file refs in ORIGINAL order
          for (const plan of phase4Plans) {
            if (plan.blocks.length === 0) continue
            if (plan.harvest) {
              for (const block of plan.blocks) {
                const priorRefs = repos.fileRefs.listByBlock(block.id)
                allAffectedFileIds.push(...collectAffectedFileIds(priorRefs))
              }
            }
            repos.blocks.upsertMany(plan.blocks)
            this.syncFileReferences(repos, plan.blocks)
          }

          // Transaction-bound sync intent (same atomic boundary). True-new
          // stable messages/blocks enqueue full-state upserts with membership;
          // existing rows enqueue allowlisted field diffs only with membership
          // preserved (never backfilled); transient/unsupported emit nothing.
          if (ctx) {
            let tsOffset = 0
            const nextTs = (): number => ctx.ts + tsOffset++
            // Distinct message order (first occurrence) for deterministic parent-first timestamps.
            const distinctMids: string[] = []
            const seenMids = new Set<string>()
            for (const entry of entries) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && !seenMids.has(mid)) {
                seenMids.add(mid)
                distinctMids.push(mid)
              }
            }
            let hasNewInclusion = false
            let hasDemotion = false
            for (const mid of distinctMids) {
              const postRow = repos.messages.getById(mid)
              if (!postRow.found) throw new Error(`insertMessagesAfterAnchor message ${mid} missing in transaction`)
              const pre = preMessageRows.get(mid) ?? null
              const isTrueCreate = !pre
              const postStable = isStableMessageStatus(postRow.data.status)
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) hasDemotion = true
              if ((isTrueCreate && postStable) || (pre && !preStable && postStable)) hasNewInclusion = true
              if (!postStable) continue
              if (isTrueCreate) {
                if (!this.shouldCaptureMessageCreate(postRow.data)) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, topicId, opTs, ctx.deviceId)
                const full = this.syncMessagePayloadFull(postRow.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message', mid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message', mid, postRow.data.topicId, opTs, opId)
                syncNotify = true
              } else {
                const diff = this.diffMessagePayload(pre, postRow.data)
                if (!diff) continue
                delete diff.sortOrder
                // Diff carries only allowlisted fields; empty diff means no op.
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, topicId, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message', mid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            // Distinct blocks in original entry order for parent-first timestamps.
            const distinctBids: string[] = []
            const seenBids = new Set<string>()
            for (const plan of phase4Plans) {
              for (const blk of plan.blocks) {
                if (!seenBids.has(blk.id)) {
                  seenBids.add(blk.id)
                  distinctBids.push(blk.id)
                }
              }
            }
            for (const bid of distinctBids) {
              const postBlk = repos.blocks.getById(bid)
              if (!postBlk.found) throw new Error(`insertMessagesAfterAnchor block ${bid} missing in transaction`)
              // Blocks under a transient parent never ride the wire: skip
              // without closure (closure would fail closed). The per-parent
              // frame decision below invalidates the transient parent.
              const parentMsg = repos.messages.getById(postBlk.data.messageId)
              if (!parentMsg.found || !isStableMessageStatus(parentMsg.data.status)) continue
              if (!isStableBlockStatus(postBlk.data.status)) continue
              if (this.isUnsupportedBlock(postBlk.data)) {
                unsupportedBlockIds.push(bid)
                continue
              }
              const pre = preBlockRows.get(bid) ?? null
              if (!pre) {
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                const full = this.syncBlockPayloadFull(postBlk.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message_block', bid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message_block', bid, postBlk.data.messageId, opTs, opId)
                syncNotify = true
              } else {
                if (postBlk.data.messageId !== pre.messageId) continue
                const diff = this.diffBlockPayload(pre, postBlk.data)
                if (!diff) continue
                delete diff.sortOrder
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message_block', bid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            // Local parent order frames — exactly one topicMessage attempt
            // when semantically required plus one per affected block parent
            // where required. Pure stable→stable content patches advance
            // nothing; inclusion/order changes use the existing try helpers
            // (missing/excluded invalidates with 0 op, malformed rolls back).
            if (hasDemotion) {
              syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
              for (const mid of distinctMids) {
                const pre = preMessageRows.get(mid)
                const postRow = repos.messages.getById(mid)
                const preStable = pre ? isStableMessageStatus(pre.status) : false
                const postStable = postRow.found ? isStableMessageStatus(postRow.data.status) : false
                if (pre && preStable && !postStable) {
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                }
              }
            } else if (hasNewInclusion) {
              if (syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
            // Per-parent block frames: newly included parents (even empty)
            // plus any true-create or inclusion-transition block change.
            const affectedParents = new Set<string>()
            for (const mid of distinctMids) affectedParents.add(mid)
            for (const bid of distinctBids) {
              const pre = preBlockRows.get(bid)
              const postBlk = repos.blocks.getById(bid)
              if (pre) affectedParents.add(pre.messageId)
              if (postBlk.found) affectedParents.add(postBlk.data.messageId)
            }
            for (const mid of affectedParents) {
              const postMsg = repos.messages.getById(mid)
              if (!postMsg.found) continue
              const postStable = isStableMessageStatus(postMsg.data.status)
              const pre = preMessageRows.get(mid) ?? null
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) continue // already invalidated above
              if (!postStable) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                continue
              }
              const isNewlyIncludedParent = (!pre && postStable) || (!!pre && !preStable && postStable)
              let needsBlockFrame = isNewlyIncludedParent
              if (!needsBlockFrame) {
                for (const bid of distinctBids) {
                  const bPre = preBlockRows.get(bid)
                  const bPost = repos.blocks.getById(bid)
                  if (!bPost.found) continue
                  // Scope to blocks currently under this parent.
                  if (bPost.data.messageId !== mid && (!bPre || bPre.messageId !== mid)) continue
                  if (!bPre) {
                    needsBlockFrame = true
                    break
                  }
                  // Only blocks that belong to this parent transitionally.
                  if (bPre.messageId !== mid && bPost.data.messageId !== mid) continue
                  const preIncluded = isStableBlockStatus(bPre.status) && !this.isUnsupportedBlock(bPre)
                  const postIncluded = isStableBlockStatus(bPost.data.status) && !this.isUnsupportedBlock(bPost.data)
                  if (bPre.messageId !== bPost.data.messageId) {
                    needsBlockFrame = true
                    break
                  }
                  if (preIncluded !== postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                  // Excluded true-create under this parent must invalidate.
                  if (!postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                }
                // A true-create message with no blocks still needs its empty frame.
                // Covered by isNewlyIncludedParent above.
              }
              if (!needsBlockFrame) continue
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, mid, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          } else {
            // Capture disabled: preserve existing truthful invalidation, no ops.
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
            {
              const affectedMids = new Set<string>()
              for (const plan of phase4Plans) {
                for (const blk of plan.blocks) {
                  affectedMids.add(blk.messageId)
                }
              }
              for (const mid of affectedMids) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
              }
            }
          }

          const uniqueAffectedIds = [...new Set(allAffectedFileIds)].sort()
          const cleanup = buildFileCleanupResult(repos, uniqueAffectedIds)
          // Canonical authoritative insert payload: truly inserted rows only.
          // Patched pre-existing rows keep their durable positions (patch-only
          // above) and are reported separately so the renderer never reorders
          // them as inserts.
          const insertedIds = newMessages.map((m) => m.id)
          // F-1: patched reports DB-pre-existing rows only. An in-request
          // duplicate fresh ID is written as insert-then-patch (established
          // last-writer path above) but its durable identity is inserted, so
          // it must not also appear in patched — otherwise the committed
          // response fails disjoint result validation after the commit.
          const patchedIds = [...new Set(existingPlans.map((p) => p.id).filter((id) => !newMessageIds.has(id)))]
          const durableBlocks = insertedIds.flatMap((mid) => repos.blocks.listByMessage(mid))
          const messagesWithBlocks =
            insertedIds.length > 0
              ? reconstructMessageBlockRelations(messagesToWire(newMessages), blocksToWire(durableBlocks))
              : []
          // Stable neighbor placement in post-insert effective order. Numeric
          // effective indexes never cross the wire; the renderer splices after
          // beforeMessageId (when resident) or before nextMessageId.
          let beforeMessageId: string | null = null
          let nextMessageId: string | null = null
          if (insertedIds.length > 0) {
            const effective = this.resolveRouteMessagesInTx(repos, topicId, route).messages
            const firstIdx = effective.findIndex((m) => m.id === insertedIds[0])
            const lastIdx = effective.findIndex((m) => m.id === insertedIds[insertedIds.length - 1])
            if (firstIdx === -1 || lastIdx === -1 || lastIdx - firstIdx + 1 !== insertedIds.length) {
              throw new Error('insertMessagesAfterAnchor inserted run is not contiguous in effective order')
            }
            beforeMessageId = firstIdx > 0 ? effective[firstIdx - 1].id : null
            nextMessageId = lastIdx + 1 < effective.length ? effective[lastIdx + 1].id : null
          }
          return {
            ...cleanup,
            topicId,
            branchId: route,
            afterMessageId,
            insertedMessages: messagesWithBlocks,
            insertedBlocks: blocksToWire(durableBlocks),
            insertedMessageIds: insertedIds,
            patchedMessageIds: patchedIds,
            beforeMessageId,
            nextMessageId,
            mutableMessageIds: [...insertedIds]
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('insertMessagesAfterAnchor', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('insertMessagesAfterAnchor', unsupportedBlockIds)
      return result
    }, `insertMessagesAfterAnchor(${topicId}, ${afterMessageId}, ${entries.length} entries)`)
  }

  /**
   * Resolve after-group-tail index with full answer-group authority semantics.
   *
   * Deterministic, Main-only, no renderer state:
   * - User anchor: groupKey is the user ID; tail is the last same-topic
   *   assistant whose askId equals the user ID (including non-contiguous
   *   members, consistent with answer-group authority). No match → anchor.
   * - Assistant anchor with non-empty askId: tail is the last same-topic
   *   assistant with equal askId (including non-contiguous members).
   * - Otherwise (assistant without askId, other roles): singleton tail.
   * Returns tail index + 1 against the supplied authority order.
   */
  private resolveAfterGroupTailFullIndex(orderedMessages: MessageData[], anchor: MessageData): number {
    const anchorIdx = orderedMessages.findIndex((m) => m.id === anchor.id)
    if (anchorIdx === -1) {
      throw new ChatDbNotFoundError(`Anchor message ${anchor.id} does not belong to its topic`)
    }
    let groupKey: string | null = null
    if (anchor.role === 'user') {
      groupKey = anchor.id
    } else if (anchor.role === 'assistant') {
      const askId = (anchor as unknown as { askId: string | null }).askId
      if (typeof askId === 'string' && askId.length > 0) {
        groupKey = askId
      }
    }
    if (groupKey === null) return anchorIdx + 1
    let tailIdx = anchorIdx
    for (let i = 0; i < orderedMessages.length; i++) {
      const cur = orderedMessages[i]
      if (cur.role === 'assistant' && (cur as unknown as { askId: string | null }).askId === groupKey) {
        if (i > tailIdx) tailIdx = i
      }
    }
    return tailIdx + 1
  }

  /**
   * Insert message groups with stable intents in one atomic Main transaction.
   *
   * Authority: validates topic exists and every stable anchor belongs to the
   * topic against the transaction-start complete order. Plans all group base
   * indexes against that start order (after-group-tail via full answer-group
   * tail, before-message immediately before the surviving ID, topic-tail at
   * end), then inserts groups sequentially in request order with drift-free
   * offsets so multi-group restores preserve their pre-delete relation.
   * New message/block IDs must be truly new: any same-topic or cross-topic
   * collision fails the whole transaction (no silent patch). Blocks upsert +
   * file-ref sync + sync/frame capture reuse the established paste patterns.
   * Returns the typed batch insertion acknowledgment with exact final
   * committed canonical wires, flat ids, per-group stable placement, and the
   * Main-produced mutability delta (subset of actual inserted IDs).
   */
  insertMessageGroups(
    topicId: string,
    groups: Array<{ entries: Array<{ message: JsonObject; blocks: JsonObject[] }>; intent: JsonObject }>,
    branchId?: string | null,
    boundaryRestores?: InheritanceBoundarySnapshot[]
  ): ChatDbResult<InsertMessageGroupsResponse> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('insertMessageGroups', topicId, route)
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      let result: InsertMessageGroupsResponse
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }

          // Route-owner start order: intent anchors resolve inside the
          // addressed route. Owned anchors plan against the owner's rows —
          // never across owners. An inherited after-group-tail anchor is
          // bounded: only the group containing the addressed branch's final
          // inherited boundary (fork anchor) inserts, at the owner head
          // (first group after the fork, before any existing suffix). Older
          // or missing non-boundary inherited anchors fail closed with zero
          // writes; inherited rows are never moved or modified. Main-route
          // inherited anchors reject (read-only through main).
          const resolvedRoute = this.resolveRouteMessagesInTx(repos, topicId, route)
          const routeStart = resolvedRoute.messages
          const forkBoundaryIndex = resolvedRoute.forkBoundaryIndex
          const ownerStart = repos.messages.listByTopic(topicId, route)
          const ownerIndexById = new Map<string, number>()
          for (let i = 0; i < ownerStart.length; i++) ownerIndexById.set(ownerStart[i].id, i)
          const anchorById = new Map<string, MessageData>()
          for (const m of routeStart) anchorById.set(m.id, m)

          if (!Array.isArray(groups) || groups.length === 0) {
            throw new ChatDbValidationError('groups must be a non-empty array')
          }

          type PlannedGroup = {
            messages: MessageData[]
            blocksPerMessage: MessageBlockData[][]
            flatBlocks: MessageBlockData[]
            baseIndex: number
          }
          const planned: PlannedGroup[] = []
          const seenNewIds = new Set<string>()
          const seenBlockIds = new Set<string>()

          for (let gi = 0; gi < groups.length; gi++) {
            const group = groups[gi] as unknown as {
              entries: Array<{ message: JsonObject; blocks: JsonObject[] }>
              intent: Record<string, unknown>
            }
            const entries = group?.entries
            const intent = group?.intent as unknown as Record<string, unknown>
            if (!Array.isArray(entries) || entries.length === 0) {
              throw new ChatDbValidationError(`groups[${gi}].entries must be a non-empty array`)
            }
            const kind = intent?.kind
            if (kind !== 'after-group-tail' && kind !== 'before-message' && kind !== 'topic-tail') {
              throw new ChatDbValidationError(`groups[${gi}].intent.kind must be a stable intent kind`)
            }

            let baseIndex: number
            if (kind === 'topic-tail') {
              baseIndex = ownerStart.length
            } else {
              const messageId = intent?.messageId
              if (typeof messageId !== 'string' || messageId.length === 0) {
                throw new ChatDbValidationError(`groups[${gi}].intent.messageId must be a non-empty string`)
              }
              const anchor = anchorById.get(messageId)
              if (!anchor) {
                throw new ChatDbNotFoundError(`Anchor message ${messageId} does not belong to topic ${topicId}`)
              }
              if ((anchor.branchId ?? null) !== route || anchor.topicId !== topicId) {
                // Inherited anchor: after-group-tail is bounded to the fork
                // boundary (owner head); before-message keeps legacy owner-tail
                // semantics. The UI selection is a GROUP anchor (stable askId,
                // usually the user id), so exact-ID equality with the branch
                // fork anchor is insufficient: resolve the anchor's group tail
                // in the effective addressed route and require it to be the
                // final inherited boundary (the addressed branch's immutable
                // anchorMessageId).
                if (route === null) {
                  // Cross-topic reference fork boundary: only the exact foreign
                  // endpoint (the reference anchor, or its resolved group tail)
                  // may receive insertions at the START of the target's own
                  // suffix; older foreign prefix messages stay read-only.
                  const ref = repos.topicReferences.getByTarget(topicId)
                  let isReferenceFork = ref.found && ref.data.anchorMessageId === messageId
                  if (!isReferenceFork && ref.found && kind === 'after-group-tail') {
                    const tailPlusOne = this.resolveAfterGroupTailFullIndex(routeStart, anchor)
                    isReferenceFork = routeStart[tailPlusOne - 1]?.id === ref.data.anchorMessageId
                  }
                  if (!isReferenceFork) {
                    throw new ChatDbValidationError(
                      `Anchor message ${messageId} is not owned by this route and insertion is read-only`
                    )
                  }
                  baseIndex = 0
                } else if (kind !== 'after-group-tail') {
                  // before-message restoration keeps legacy semantics (owner
                  // tail) — no expansion or contraction here.
                  baseIndex = ownerStart.length
                } else {
                  const addressedBranch = repos.branches.getById(route)
                  if (!addressedBranch.found || addressedBranch.data.topicId !== topicId) {
                    throw new ChatDbNotFoundError(`Branch ${route} does not exist in topic ${topicId}`)
                  }
                  const forkId = addressedBranch.data.anchorMessageId
                  const effectiveTailPlusOne = this.resolveAfterGroupTailFullIndex(routeStart, anchor)
                  const effectiveTailIdx = effectiveTailPlusOne - 1
                  const tailId = routeStart[effectiveTailIdx]?.id ?? null
                  if (tailId !== forkId || effectiveTailIdx !== forkBoundaryIndex - 1) {
                    throw new ChatDbValidationError(
                      `Anchor message ${messageId} is an ancestor reference and is read-only through this route`
                    )
                  }
                  baseIndex = 0
                }
              } else if (kind === 'before-message') {
                baseIndex = ownerIndexById.get(messageId) as number
              } else {
                baseIndex = this.resolveAfterGroupTailFullIndex(ownerStart, anchor)
              }
            }

            const messages: MessageData[] = []
            const blocksPerMessage: MessageBlockData[][] = []
            const flatBlocks: MessageBlockData[] = []
            for (const entry of entries) {
              const messageData = wireToMessage(entry.message)
              messageData.topicId = topicId
              messageData.branchId = route
              const blockDataList = entry.blocks.map(wireToBlock)
              for (const block of blockDataList) {
                block.messageId = messageData.id
              }
              this.assignAuthoritativeBlockOrder(entry.message, blockDataList)
              const mid = messageData.id
              if (typeof mid !== 'string' || mid.length === 0) {
                throw new ChatDbValidationError(`groups[${gi}] entry message must carry a non-empty id`)
              }
              if (seenNewIds.has(mid)) {
                throw new ChatDbConflictError(`Duplicate new message ID "${mid}" across groups`)
              }
              seenNewIds.add(mid)
              const existing = repos.messages.getById(mid)
              if (existing.found) {
                throw new ChatDbConflictError(
                  `Message ${mid} already exists in topic ${existing.data.topicId}, cannot insert`
                )
              }
              for (const block of blockDataList) {
                if (seenBlockIds.has(block.id)) {
                  throw new ChatDbConflictError(`Duplicate new block ID "${block.id}" across groups`)
                }
                seenBlockIds.add(block.id)
                const existingBlock = repos.blocks.getById(block.id)
                if (existingBlock.found) {
                  throw new ChatDbConflictError(`Block ${block.id} already exists, cannot insert`)
                }
              }
              messages.push(messageData)
              blocksPerMessage.push(blockDataList)
              flatBlocks.push(...blockDataList)
            }
            planned.push({ messages, blocksPerMessage, flatBlocks, baseIndex })
          }

          const preMessageRows = new Map<string, MessageData>()
          const preBlockRows = new Map<string, MessageBlockData>()
          if (ctx) {
            for (const mid of seenNewIds) {
              const pre = repos.messages.getById(mid)
              if (pre.found) preMessageRows.set(mid, { ...pre.data, overflow: { ...pre.data.overflow } })
            }
            for (const bid of seenBlockIds) {
              const pre = repos.blocks.getById(bid)
              if (pre.found) preBlockRows.set(bid, { ...pre.data, overflow: { ...pre.data.overflow } })
            }
          }

          const flatEntriesInOrder: Array<{ message: JsonObject; blocks: JsonObject[] }> = []
          for (const g of groups) {
            const gg = g as unknown as { entries: Array<{ message: JsonObject; blocks: JsonObject[] }> }
            for (const e of gg.entries) flatEntriesInOrder.push(e)
          }

          for (let gi = 0; gi < planned.length; gi++) {
            const plan = planned[gi]
            let adjusted = plan.baseIndex
            for (let j = 0; j < gi; j++) {
              if (planned[j].baseIndex <= plan.baseIndex) {
                adjusted += planned[j].messages.length
              }
            }
            if (plan.messages.length > 0) {
              repos.messages.insertManyAt(plan.messages, adjusted)
            }
          }

          for (const plan of planned) {
            if (plan.flatBlocks.length === 0) continue
            repos.blocks.upsertMany(plan.flatBlocks)
            this.syncFileReferences(repos, plan.flatBlocks)
          }

          if (ctx) {
            let tsOffset = 0
            const nextTs = (): number => ctx.ts + tsOffset++
            const distinctMids: string[] = []
            const seenMids = new Set<string>()
            for (const entry of flatEntriesInOrder) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && !seenMids.has(mid)) {
                seenMids.add(mid)
                distinctMids.push(mid)
              }
            }
            let hasNewInclusion = false
            let hasDemotion = false
            for (const mid of distinctMids) {
              const postRow = repos.messages.getById(mid)
              if (!postRow.found) throw new Error(`insertMessageGroups message ${mid} missing in transaction`)
              const pre = preMessageRows.get(mid) ?? null
              const isTrueCreate = !pre
              const postStable = isStableMessageStatus(postRow.data.status)
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) hasDemotion = true
              if ((isTrueCreate && postStable) || (pre && !preStable && postStable)) hasNewInclusion = true
              if (!postStable) continue
              if (isTrueCreate) {
                if (!this.shouldCaptureMessageCreate(postRow.data)) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, topicId, opTs, ctx.deviceId)
                const full = this.syncMessagePayloadFull(postRow.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message', mid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message', mid, postRow.data.topicId, opTs, opId)
                syncNotify = true
              } else {
                const diff = this.diffMessagePayload(pre, postRow.data)
                if (!diff) continue
                delete diff.sortOrder
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, topicId, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message', mid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            const distinctBids: string[] = []
            const seenBids = new Set<string>()
            for (const plan of planned) {
              for (const blk of plan.flatBlocks) {
                if (!seenBids.has(blk.id)) {
                  seenBids.add(blk.id)
                  distinctBids.push(blk.id)
                }
              }
            }
            for (const bid of distinctBids) {
              const postBlk = repos.blocks.getById(bid)
              if (!postBlk.found) throw new Error(`insertMessageGroups block ${bid} missing in transaction`)
              const parentMsg = repos.messages.getById(postBlk.data.messageId)
              if (!parentMsg.found || !isStableMessageStatus(parentMsg.data.status)) continue
              if (!isStableBlockStatus(postBlk.data.status)) continue
              if (this.isUnsupportedBlock(postBlk.data)) {
                unsupportedBlockIds.push(bid)
                continue
              }
              const pre = preBlockRows.get(bid) ?? null
              if (!pre) {
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                const full = this.syncBlockPayloadFull(postBlk.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message_block', bid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message_block', bid, postBlk.data.messageId, opTs, opId)
                syncNotify = true
              } else {
                if (postBlk.data.messageId !== pre.messageId) continue
                const diff = this.diffBlockPayload(pre, postBlk.data)
                if (!diff) continue
                delete diff.sortOrder
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message_block', bid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            if (hasDemotion) {
              syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
              for (const mid of distinctMids) {
                const pre = preMessageRows.get(mid)
                const postRow = repos.messages.getById(mid)
                const preStable = pre ? isStableMessageStatus(pre.status) : false
                const postStable = postRow.found ? isStableMessageStatus(postRow.data.status) : false
                if (pre && preStable && !postStable) {
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                }
              }
            } else if (hasNewInclusion) {
              if (syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
            const affectedParents = new Set<string>()
            for (const mid of distinctMids) affectedParents.add(mid)
            for (const bid of distinctBids) {
              const pre = preBlockRows.get(bid)
              const postBlk = repos.blocks.getById(bid)
              if (pre) affectedParents.add(pre.messageId)
              if (postBlk.found) affectedParents.add(postBlk.data.messageId)
            }
            for (const mid of affectedParents) {
              const postMsg = repos.messages.getById(mid)
              if (!postMsg.found) continue
              const postStable = isStableMessageStatus(postMsg.data.status)
              const pre = preMessageRows.get(mid) ?? null
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) continue
              if (!postStable) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                continue
              }
              const isNewlyIncludedParent = (!pre && postStable) || (!!pre && !preStable && postStable)
              let needsBlockFrame = isNewlyIncludedParent
              if (!needsBlockFrame) {
                for (const bid of distinctBids) {
                  const bPre = preBlockRows.get(bid)
                  const bPost = repos.blocks.getById(bid)
                  if (!bPost.found) continue
                  if (bPost.data.messageId !== mid && (!bPre || bPre.messageId !== mid)) continue
                  if (!bPre) {
                    needsBlockFrame = true
                    break
                  }
                  if (bPre.messageId !== mid && bPost.data.messageId !== mid) continue
                  const preIncluded = isStableBlockStatus(bPre.status) && !this.isUnsupportedBlock(bPre)
                  const postIncluded = isStableBlockStatus(bPost.data.status) && !this.isUnsupportedBlock(bPost.data)
                  if (bPre.messageId !== bPost.data.messageId) {
                    needsBlockFrame = true
                    break
                  }
                  if (preIncluded !== postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                  if (!postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                }
              }
              if (!needsBlockFrame) continue
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, mid, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          } else {
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
            {
              const affectedMids = new Set<string>()
              for (const plan of planned) {
                for (const blk of plan.flatBlocks) {
                  affectedMids.add(blk.messageId)
                }
              }
              for (const mid of affectedMids) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
              }
            }
          }

          const cleanup = buildFileCleanupResult(repos, [])
          // Canonical authoritative batch acknowledgment: truly inserted rows
          // only (no patch path — collisions fail above). Flat ids follow
          // flat request-group concatenated order; per-group runs carry
          // stable neighbors in post-insert effective order (InsertAfter
          // convention, never numeric order) so multi-group restores preserve
          // their pre-delete relation.
          const flatInsertedMessages = planned.flatMap((p) => p.messages)
          const insertedIds = flatInsertedMessages.map((m) => m.id)
          const durableBlocks = insertedIds.flatMap((mid) => repos.blocks.listByMessage(mid))
          const messagesWithBlocks =
            insertedIds.length > 0
              ? reconstructMessageBlockRelations(messagesToWire(flatInsertedMessages), blocksToWire(durableBlocks))
              : []
          const effective = this.resolveRouteMessagesInTx(repos, topicId, route).messages
          const groupRuns = planned.map((plan) => {
            const gids = plan.messages.map((m) => m.id)
            const firstIdx = effective.findIndex((m) => m.id === gids[0])
            const lastIdx = effective.findIndex((m) => m.id === gids[gids.length - 1])
            if (firstIdx === -1 || lastIdx === -1 || lastIdx - firstIdx + 1 !== gids.length) {
              throw new Error('insertMessageGroups inserted run is not contiguous in effective order')
            }
            for (let k = 0; k < gids.length; k++) {
              if (effective[firstIdx + k].id !== gids[k]) {
                throw new Error('insertMessageGroups inserted run order mismatch in effective order')
              }
            }
            return {
              insertedMessageIds: [...gids],
              beforeMessageId: firstIdx > 0 ? effective[firstIdx - 1].id : null,
              nextMessageId: lastIdx + 1 < effective.length ? effective[lastIdx + 1].id : null
            }
          })
          // Boundary restoration lives in the SAME transaction as the
          // re-inserted messages: a delete that moved a branch anchor or a
          // cross-topic reference endpoint can be undone atomically. Applied
          // only onto relations this delete moved and only while their
          // recorded post-delete value still holds (compare-and-set helper).
          const restoredBoundaries =
            boundaryRestores && boundaryRestores.length > 0
              ? this.restoreInheritanceBoundariesInTx(
                  repos,
                  topicId,
                  boundaryRestores,
                  new Set(insertedIds),
                  this.normalizeBranchId(route)
                )
              : []
          return {
            ...cleanup,
            topicId,
            branchId: route,
            branches: this.listBranchCatalogInTx(repos, topicId),
            insertedMessages: messagesWithBlocks,
            insertedBlocks: blocksToWire(durableBlocks),
            insertedMessageIds: insertedIds,
            mutableMessageIds: [...insertedIds],
            groups: groupRuns,
            boundaryRestores: restoredBoundaries
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('insertMessageGroups', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('insertMessageGroups', unsupportedBlockIds)
      return result
    }, `insertMessageGroups(${topicId}, ${groups.length} groups)`)
  }

  /**
   * Get raw topic with ordered messages and relational block IDs.
   * Returns null if topic does not exist.
   */
  getRawTopic(topicId: string, branchId?: string | null): ChatDbResult<GetRawTopicResult> {
    return wrapResult(() => {
      const repos = this.repos()
      const { topics, messages: msgRepo, blocks } = repos

      const topic = topics.getById(topicId)
      if (!topic.found) return null

      const route = this.normalizeBranchId(branchId)
      // Whole-topic authority read: the MAIN route denotes the topic's
      // effective history, so a cross-topic history-reference target includes
      // its live foreign prefix (canonical source rows, stable IDs; the
      // prefix is omitted when the source route/anchor is unavailable —
      // 'whole-topic' completeness means the complete effective current
      // route, never a partial owned-only read). An explicit branch route
      // keeps the existing owned-rows contract used by Main ownership probes.
      const messageData =
        route === null
          ? this.resolveRouteMessagesInTx(repos, topicId, null).messages
          : msgRepo.listByTopic(topicId, route)
      const messageIds = messageData.map((m) => m.id)
      const blockDataMap = blocks.listByMessages(messageIds)

      const allBlocks: MessageBlockData[] = []
      for (const id of messageIds) {
        allBlocks.push(...(blockDataMap.get(id) ?? []))
      }

      const wireMessages = messagesToWire(messageData)
      const wireBlocks = blocksToWire(allBlocks)
      const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)

      return { id: topicId, messages: messagesWithBlocks }
    }, `getRawTopic(${topicId})`)
  }

  /**
   * Check if a topic exists. Real DB errors become failure, not false.
   */
  topicExists(topicId: string): ChatDbResult<boolean> {
    return wrapResult(() => {
      const { topics } = this.repos()
      return topics.exists(topicId)
    }, `topicExists(${topicId})`)
  }

  /**
   * Ensure a topic exists. Create-only: only sets assistantId on creation.
   * Does not overwrite existing topic's assistantId.
   * Sync intent (create-only full payload) commits atomically in the same tx.
   */
  ensureTopic(topicId: string, assistantId?: string, name?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const ctx = this.syncCtx('ensureTopic')
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          // Create-only gate (LOCK-PERSONAL-005): capture depends on actual
          // pre-mutation row existence, not trackedness. An existing row —
          // even untracked (pre-sync legacy data) — is a no-op: it emits no
          // fresh full snapshot so a stale ensure can never overwrite newer
          // remote field values. Only a row absent before this command is a
          // true creation and emits the create-union payload.
          const existedBefore = repos.topics.getById(topicId).found
          repos.topics.ensure(topicId, assistantId, name)
          if (ctx && !existedBefore) {
            const created = repos.topics.getById(topicId)
            if (!created.found) throw new Error(`ensureTopic ${topicId} missing after ensure`)
            syncService.enqueueUpsertInTx(
              tx as unknown as SyncTxExecutor,
              'topic',
              topicId,
              this.syncTopicPayload(created.data),
              ctx.ts,
              ctx.deviceId
            )
            notify = true
            // New trustworthy topic creation: persist empty topicMessage frame with dedicated truthful clock
            // and enqueue the matching order_frame op reusing that clock (SYNC-DATA-048, same tx).
            // Existing/pre-010 observations must not be backfilled — only when actually newly created/captured here.
            syncService.refreshTopicMessageFrameAndEnqueueInTx(tx as unknown as SyncTxExecutor, topicId, ctx.deviceId)
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('ensureTopic', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `ensureTopic(${topicId})`)
  }

  /**
   * Append a message with blocks to a topic.
   *
   * - Ensures topic exists.
   * - New message at valid insertIndex, else append at end.
   * - Existing message ID preserves current position.
   * - Full supplied blocks are upserted, ordered, and references synced.
   * - Returns a Main-issued typed creation acknowledgment: the normalized
   *   addressed route, the authoritative row identity, and the id delta
   *   limited to actual new owned row(s) created in the same root
   *   transaction (plus the matching capability delta). A failure publishes
   *   nothing.
   *
   * `diagnostics` is optional diagnostic-only correlation metadata
   * (LOCK-004); it never affects persistence semantics. When present, bounded
   * timing logs distinguish wire→domain conversion from the synchronous
   * SQLite transaction (LOCK-001/003).
   */
  appendMessage(
    topicId: string,
    messageJson: JsonObject,
    blocksJson: JsonObject[],
    insertIndex?: number,
    diagnostics?: AppendDiagnostics,
    options?: { resendAttemptId?: string; branchId?: string | null }
  ): ChatDbResult<AppendMessageResponse> {
    const correlationId = diagnostics?.correlationId
    const ordinal = diagnostics?.ordinal
    const isDiagnosedAppend = typeof correlationId === 'string' && correlationId.length > 0
    const t0 = performance.now()
    let convertDurationMs = 0
    let txDurationMs = 0
    let outcomeOk = false

    const result = wrapResult(() => {
      try {
        // Convert wire → domain. Ownership is stamped by Main from the
        // typed route context — wire branchId (if any) is never trusted.
        const route = this.normalizeBranchId(options?.branchId)
        const tConvert = performance.now()
        const messageData = wireToMessage(messageJson)
        messageData.topicId = topicId // Ensure consistency
        messageData.branchId = route
        const blockDataList = blocksJson.map(wireToBlock)

        // Validate block ownership: all blocks must reference this message
        for (const block of blockDataList) {
          block.messageId = messageData.id // Enforce consistency
        }
        // Deterministic block order: assign explicit sortOrder from complete
        // authoritative message.blocks order before repository normalization
        this.assignAuthoritativeBlockOrder(messageJson, blockDataList)
        convertDurationMs = elapsedMs(tConvert)

        const tTx = performance.now()
        const resendAttemptId = this.resendAttemptOf(options)
        // Stale-attempt fail-closed before any SQLite write transaction
        // opens (existing-id overwrites of a resend message).
        this.assertResendAttemptPreTx([messageData.id, ...this.blockParentIdsPreTx(blocksJson)], resendAttemptId)
        const syncCtx = this.syncCtxForTopic('appendMessage', topicId, route)
        let syncNotify = false
        const unsupportedBlockIds: string[] = []
        let txResult: { created: boolean }
        try {
          txResult = this.db.transaction((tx) => {
            const repos = createRepositories(tx)
            const stx = tx as unknown as SyncTxExecutor

            // Resend intent (SYNC-DATA-055): authoritative stale check —
            // mismatch rolls back; a covered message stays local-only below.
            const appendCovered = this.checkResendAttemptInTx(stx, messageData.id, resendAttemptId)

            const trackedTopicBefore = syncCtx ? syncService.isTrackedEntityInTx(stx, 'topic', topicId) : true
            // Ensure topic exists
            repos.topics.ensure(topicId)
            // Natural creation authority guard: the addressed route must be
            // resolvable in the SAME root transaction before any message/block
            // write. Branch appends fail closed on trashed topics and
            // unknown/cross-topic branches via requireBranchInTx; a branch
            // whose fork boundary is missing still resolves (shortened or
            // empty inherited history) so its owned suffix stays writable.
            // Main-route appends
            // preserve existing success semantics on soft-deleted topics
            // (frame maintenance covered by syncParentOrderFrame).
            {
              const topicRow = repos.topics.getById(topicId)
              if (!topicRow.found) {
                throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
              }
              if (route !== null) {
                if (topicRow.data.deletedAt != null) {
                  throw new ChatDbValidationError(`Topic ${topicId} is in trash and cannot accept branch appends`)
                }
                this.requireBranchInTx(repos, topicId, route)
                this.resolveRouteMessagesInTx(repos, topicId, route)
              }
            }

            // Check if message already exists
            const existing = repos.messages.getById(messageData.id)
            const messageExistedBefore = existing.found
            const messagePre = existing.found
              ? ({ ...existing.data, overflow: { ...existing.data.overflow } } as MessageData)
              : null
            // Turn-level fold inheritance: a NEW row that joins an already
            // folded turn (a regenerated/added variant) is born folded, inside
            // this same transaction, so the turn never becomes half-folded.
            // Existing rows keep their stored state (this is not a repair of
            // an explicit write; read expands partial markers instead).
            if (!messageExistedBefore) {
              this.inheritTurnFoldForNewMessageInTx(repos, topicId, messageData)
            }

            if (existing.found) {
              // Authoritative ownership guard (sync F1): an existing message ID
              // owned by another topic or another route must not be mutated
              // and must not emit sync capture. Reject before any
              // message/block processing so the transaction aborts with zero
              // entity mutation; the IPC hook only captures on success, so no
              // outbox capture is emitted.
              if (existing.data.topicId !== topicId) {
                throw new ChatDbConflictError(
                  `Message ${messageData.id} belongs to topic ${existing.data.topicId}, cannot reparent to ${topicId}`
                )
              }
              if ((existing.data.branchId ?? null) !== route) {
                throw new ChatDbValidationError(
                  `Message ${messageData.id} belongs to another route and is immutable through this route`
                )
              }
              // Existing ID: preserve current position (update metadata only)
              const patch = wireToMessagePatch(messageJson)
              delete patch.id
              delete patch.topicId
              delete patch.branchId
              delete patch.sortOrder
              if (Object.keys(patch).length > 0) {
                repos.messages.update(topicId, messageData.id, patch)
              }
            } else {
              // New message: insert at index or append
              if (insertIndex !== undefined) {
                repos.messages.insertAt(messageData, insertIndex)
              } else {
                repos.messages.append(messageData)
              }
            }

            // Pre-state snapshot for existing blocks (field-patch diffing).
            const preBlockRows = new Map<string, MessageBlockData>()
            if (syncCtx && blockDataList.length > 0) {
              for (const block of blockDataList) {
                const pre = repos.blocks.getById(block.id)
                if (pre.found) preBlockRows.set(block.id, { ...pre.data, overflow: { ...pre.data.overflow } })
              }
            }
            // Upsert blocks (preserves existing order for existing blocks)
            if (blockDataList.length > 0) {
              repos.blocks.upsertMany(blockDataList)

              // Sync file references for file/image blocks
              this.syncFileReferences(repos, blockDataList)
            }

            // Transaction-bound sync intent (same atomic boundary). Stable
            // checkpoint gate (LOCK-PERSONAL-004): transient assistant stubs
            // (pending/processing/searching/streaming) are legitimate skips —
            // no outbox, no failure. Unsupported structured/attachment blocks
            // skip without a partial null-content shell (durable unsupported
            // outcome recorded after commit). User messages and stable
            // creations capture; existing IDs emit intentional patches only
            // (LOCK-PERSONAL-005). A throw rolls back the whole append; the
            // outer catch records a durable capture failure outside the tx.
            // Resend intent (SYNC-DATA-055): a covered message stays
            // local-only — the row mutation above commits, no sync intent
            // or frame op is minted here.
            if (appendCovered) return { created: !messageExistedBefore }
            if (syncCtx) {
              const mrow = repos.messages.getById(messageData.id)
              if (!mrow.found) throw new Error(`appendMessage message ${messageData.id} missing in transaction`)
              const messageStable = this.shouldCaptureMessageCreate(mrow.data)
              const postStableForFrameEarly = isStableMessageStatus(mrow.data.status)
              const preStableForFrameEarly =
                messageExistedBefore && messagePre ? isStableMessageStatus(messagePre.status) : false
              if (!messageStable) {
                if (preStableForFrameEarly && !postStableForFrameEarly) {
                  // Stable→transient overwrite exclusion (SYNC-DATA-048
                  // errata): transient status never rides the wire, so the
                  // frame has no member-exclusion authority — invalidate
                  // locally in the same tx with 0 frame op; the user
                  // overwrite still succeeds and the candidate stays
                  // truthful partial.
                  syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageData.id)
                }
                return { created: !messageExistedBefore }
              }
              if (!trackedTopicBefore) {
                const trow = repos.topics.getById(topicId)
                if (!trow.found) throw new Error(`appendMessage topic ${topicId} missing in transaction`)
                syncService.enqueueUpsertInTx(
                  stx,
                  'topic',
                  topicId,
                  this.syncTopicPayload(trow.data),
                  Math.max(0, syncCtx.ts - 2),
                  syncCtx.deviceId
                )
                syncNotify = true
              }
              if (!messageExistedBefore) {
                const opId = syncService.enqueueUpsertInTx(
                  stx,
                  'message',
                  messageData.id,
                  this.syncMessagePayloadFull(mrow.data),
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                syncService.setMembershipClockInTx(stx, 'message', messageData.id, mrow.data.topicId, syncCtx.ts, opId)
                syncNotify = true
              } else {
                const patchPayload = this.diffMessagePayload(messagePre, mrow.data)
                if (patchPayload) {
                  syncService.enqueueUpsertInTx(
                    stx,
                    'message',
                    messageData.id,
                    patchPayload,
                    syncCtx.ts,
                    syncCtx.deviceId
                  )
                  syncNotify = true
                }
              }
              for (let i = 0; i < blockDataList.length; i++) {
                const bid = blockDataList[i].id
                const brow = repos.blocks.getById(bid)
                if (!brow.found) throw new Error(`appendMessage block ${bid} missing in transaction`)
                if (!isStableBlockStatus(brow.data.status)) continue
                if (this.isUnsupportedBlock(brow.data)) {
                  unsupportedBlockIds.push(bid)
                  continue
                }
                const pre = preBlockRows.get(bid) ?? null
                if (!pre) {
                  this.ensureBlockParentClosureInTx(stx, bid, syncCtx.ts + i + 1, syncCtx.deviceId)
                  const opTs = syncCtx.ts + i + 1
                  const opId = syncService.enqueueUpsertInTx(
                    stx,
                    'message_block',
                    bid,
                    this.syncBlockPayloadFull(brow.data),
                    opTs,
                    syncCtx.deviceId
                  )
                  syncService.setMembershipClockInTx(stx, 'message_block', bid, brow.data.messageId, opTs, opId)
                  syncNotify = true
                } else {
                  if (brow.data.messageId !== pre.messageId) continue
                  const blockPatch = this.diffBlockPayload(pre, brow.data)
                  if (!blockPatch) continue
                  this.ensureBlockParentClosureInTx(stx, bid, syncCtx.ts + i + 1, syncCtx.deviceId)
                  syncService.enqueueUpsertInTx(
                    stx,
                    'message_block',
                    bid,
                    blockPatch,
                    syncCtx.ts + i + 1,
                    syncCtx.deviceId
                  )
                  syncNotify = true
                }
              }
              // Local parent order frame (010) — inventory-inclusion gated (task 1).
              // Refresh topicMessage only when message is newly included (true newly created stable message,
              // or actual pre/post excluded→included transition). Existing stable→stable content edits must
              // not advance topic frame and must not strictly require membership. New/included block changes
              // still update only messageBlock as appropriate.
              {
                const postStableForFrame = isStableMessageStatus(mrow.data.status)
                const preStableForFrame =
                  messageExistedBefore && messagePre ? isStableMessageStatus(messagePre.status) : false
                const isNewlyIncludedMsg =
                  (!messageExistedBefore && postStableForFrame) ||
                  (messageExistedBefore && !preStableForFrame && postStableForFrame)
                const isStableToStableMsg = messageExistedBefore && preStableForFrame && postStableForFrame
                if (isNewlyIncludedMsg) {
                  const topicRow = repos.topics.getById(topicId)
                  if (topicRow.found) {
                    if (!messageExistedBefore) {
                      if (syncService.refreshTopicMessageFrameAndEnqueueInTx(stx, topicId, syncCtx.deviceId)) {
                        syncNotify = true
                      }
                    } else {
                      if (
                        syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, syncCtx.deviceId) ===
                        'refreshed'
                      ) {
                        syncNotify = true
                      }
                    }
                  }
                  const parentMsg = repos.messages.getById(messageData.id)
                  if (parentMsg.found && isStableMessageStatus(parentMsg.data.status)) {
                    if (
                      syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageData.id, syncCtx.deviceId) ===
                      'refreshed'
                    ) {
                      syncNotify = true
                    }
                  } else if (parentMsg.found) {
                    syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageData.id)
                  }
                } else if (isStableToStableMsg) {
                  // Stable→stable: do NOT advance topic frame; handle messageBlock only for new/included block changes
                  let hasTrueCreateIncluded = false
                  let hasBlockInclusionTransition = false
                  for (const b of blockDataList) {
                    const pre = preBlockRows.get(b.id) ?? null
                    const postRow = repos.blocks.getById(b.id)
                    if (!postRow.found) continue
                    const postIncluded =
                      isStableBlockStatus(postRow.data.status) && !this.isUnsupportedBlock(postRow.data)
                    if (!pre) {
                      if (postIncluded) hasTrueCreateIncluded = true
                    } else {
                      const preIncluded = isStableBlockStatus(pre.status) && !this.isUnsupportedBlock(pre)
                      if (preIncluded !== postIncluded) hasBlockInclusionTransition = true
                    }
                  }
                  if (hasTrueCreateIncluded && !hasBlockInclusionTransition) {
                    const parentMsg = repos.messages.getById(messageData.id)
                    if (parentMsg.found && isStableMessageStatus(parentMsg.data.status)) {
                      if (
                        syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageData.id, syncCtx.deviceId) ===
                        'refreshed'
                      ) {
                        syncNotify = true
                      }
                    } else if (parentMsg.found) {
                      syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageData.id)
                    }
                  } else if (hasBlockInclusionTransition) {
                    if (
                      syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageData.id, syncCtx.deviceId) ===
                      'refreshed'
                    ) {
                      syncNotify = true
                    }
                  }
                } else if (messageExistedBefore && preStableForFrame && !postStableForFrame) {
                  // Stable→transient overwrite exclusion via appendMessage
                  // (SYNC-DATA-048 errata): transient status never rides the
                  // wire, so no frame op is minted — invalidate locally in
                  // the same tx; the overwrite still succeeds and the
                  // candidate stays truthful partial.
                  syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageData.id)
                }
              }
            }
            return { created: !messageExistedBefore }
          })
        } catch (e) {
          this.recordSyncTxFailure('appendMessage', syncCtx, e)
          throw e
        }
        if (syncNotify) syncService.notifyEnqueued()
        this.recordUnsupportedBlocksAfterCommit('appendMessage', unsupportedBlockIds)
        txDurationMs = elapsedMs(tTx)
        outcomeOk = true
        // Main-issued creation acknowledgment. The created flag is derived
        // inside the same root transaction above (a throw publishes nothing);
        // the addressed route and row identity echo the authoritative stamp.
        const createdMessageIds = txResult.created ? [messageData.id] : []
        return {
          topicId,
          branchId: route,
          messageId: messageData.id,
          createdMessageIds,
          mutableMessageIds: [...createdMessageIds]
        }
      } catch (error) {
        outcomeOk = false
        throw error
      } finally {
        // LOCK-001/003/004: bounded timing logs fire on success AND failure
        // without swallowing or replacing the original error.
        if (isDiagnosedAppend) {
          logMainDiagnostic('main.append.convert', convertDurationMs, MAX_APPEND_DIAGNOSTIC_LOGS, {
            correlationId,
            ordinal,
            ok: outcomeOk
          })
          logMainDiagnostic('main.append.tx', txDurationMs, MAX_APPEND_DIAGNOSTIC_LOGS, {
            correlationId,
            ordinal,
            ok: outcomeOk
          })
          logMainDiagnostic('main.append.aggregate', elapsedMs(t0), MAX_APPEND_DIAGNOSTIC_LOGS, {
            correlationId,
            ordinal,
            ok: outcomeOk,
            blockCount: blocksJson.length
          })
        }
      }
    }, `appendMessage(${topicId}, ${messageJson.id})`)
    return result
  }

  /**
   * Update a message by ID.
   * Missing target: no-op (returns success).
   * Identity/reparenting fields rejected at contract level.
   * Supported stable field patches enqueue sync intent atomically in the
   * same tx (field patch only; transient statuses skip capture, no failure).
   *
   * Optional conditional usage mode (`options.usageCondition`, from the optional
   * user-prompt token estimate): the patch must be exactly `{usage}` and Main
   * decides INSIDE one transaction whether to apply it. It applies only when the
   * target still exists in this topic/route, is a user message, owns no usage
   * yet, and its estimate source (MAIN_TEXT contents + FILE/IMAGE IDs) still
   * equals the renderer snapshot. Everything else is a successful no-op carrying
   * a rejection code, so an estimate that lost the race to an edit/resend/delete
   * can never overwrite newer metadata. `usage` is not a synced field (not in the
   * sync patch allowlist), so the conditional path skips the sync frame/rescan
   * work entirely and emits nothing on rejection or apply.
   */
  updateMessage(
    topicId: string,
    messageId: string,
    updatesJson: JsonObject,
    options?: {
      resendAttemptId?: string
      branchId?: string | null
      usageCondition?: UpdateMessageUsageSource
    }
  ): ChatDbResult<UpdateMessageResult> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(options?.branchId)
      const patch = wireToMessagePatch(updatesJson)
      // Strip identity fields (defense in depth — contract already rejects)
      delete patch.id
      delete patch.topicId
      delete patch.branchId
      delete patch.sortOrder

      const resendAttemptId = this.resendAttemptOf(options)
      // Stale-attempt fail-closed before any SQLite write transaction opens.
      this.assertResendAttemptPreTx([messageId], resendAttemptId)

      if (options?.usageCondition) {
        return this.applyConditionalUsageEstimate(topicId, messageId, patch, route, options.usageCondition)
      }

      const ctx = this.syncCtxForTopic('updateMessage', topicId, route)
      // Empty patch (no mutable keys): no mutation intent; keep read-only.
      if (Object.keys(patch).filter((k) => k !== 'overflow').length === 0 && !patch.overflow) {
        const { messages } = this.repos()
        messages.update(topicId, messageId, patch)
        return null
      }
      let notify = false
      let result: null
      const unsupportedBlockIds: string[] = []
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          // BRANCH-4 owner equality only (missing rows keep existing no-op
          // semantics): a row owned by another topic/route is a read-only
          // reference and rejects; owned rows stay mutable even when
          // referenced by live descendants (no copy-on-write).
          this.assertMutableMessageInTx(
            repos,
            tx as unknown as BetterSQLite3Database<typeof schema>,
            topicId,
            route,
            messageId
          )
          // Resend intent (SYNC-DATA-055): authoritative stale check first —
          // a mismatch (including post-issuance duplicates proven by the
          // register) rolls back before any mutation commits; a covered
          // message stays local-only below unless this success-final write
          // consumes the intent via the stable_replace issuer.
          const resendCovered = this.checkResendAttemptInTx(stx, messageId, resendAttemptId)
          // Pre-state for the final-transition rule: only a transient→stable
          // promotion of a never-tracked row creates full initial state.
          // Pre-sync stable rows keep patch-only semantics (established).
          const preRow = ctx ? repos.messages.getInTopic(messageId, topicId) : null
          const preStable = preRow && preRow.found ? isStableMessageStatus(preRow.data.status) : true
          repos.messages.update(topicId, messageId, patch)
          if (resendCovered) {
            // Normal stable_replace issuer (SYNC-DATA-055 consume): only a
            // success/error/paused-final write with a matching attempt and
            // complete stable-supported post-state emits exactly one op in
            // this tx and clears the intent. Transient/sent/legacy/
            // unsupported/incomplete post-state stays local-only with the
            // intent retained (0 op); any validator/membership/frame/clock
            // error throws and rolls back with the intent retained and no op.
            if (ctx && resendAttemptId !== undefined) {
              const issue = syncService.tryIssueStableReplaceInTx(stx, {
                messageId,
                attemptId: resendAttemptId,
                deviceId: ctx.deviceId
              })
              if (issue.issued) notify = true
            }
            return null
          }
          if (ctx) {
            // Post-state proof inside the same tx: missing/foreign targets are
            // repository no-ops or throws — only capture when the owned row
            // survives with the requested topic. Frame inclusion transitions
            // are evaluated regardless of stable capture outcome.
            const row = repos.messages.getInTopic(messageId, topicId)
            if (!row.found) {
              // Message deleted/missing after patch: no frame maintenance (topic frame handled by delete path)
              return null
            }
            const postStable = isStableMessageStatus(row.data.status)
            // Inclusion transition handling (stable↔transient) with truthful membership gating.
            // Entity-first order (F2): the messageBlock frame decision runs
            // once per parent AFTER message/block entity upsert (entity-only
            // rescan, never membership backfill per 009), so a pre-existing
            // stable block lacking membership try-invalidates with 0 op while
            // the user mutation succeeds (candidate truthful partial).
            if (preStable && !postStable) {
              // Stable→transient exclusion (SYNC-DATA-048 errata): transient
              // status never rides the wire, so the frame has no
              // member-exclusion authority — invalidate locally in the same
              // tx with 0 frame op; the user edit still succeeds and the
              // candidate stays truthful partial. Invalidate messageBlock
              // because the parent is excluded.
              syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageId)
              return null
            }
            const isPromotion = !preStable && postStable
            if (!isPromotion) {
              if (preStable && postStable) {
                // Ordinary stable→stable content edits do not advance frames — skip frame maintenance
              } else {
                // Transient→transient: no frame
                return null
              }
            }
            if (!postStable) return null
            this.ensureTopicClosureInTx(stx, topicId, ctx.ts, ctx.deviceId)
            // Final-transition full state (LOCK-PERSONAL-004/005): a
            // never-tracked row promoted from a transient stub by this very
            // update creates its full initial state; all other cases stay
            // patch-only.
            const tracked = syncService.isTrackedEntityInTx(stx, 'message', messageId)
            if (!tracked && !preStable) {
              // Transient->stable promotion of a never-tracked row: this
              // same-tx stable upsert is the first trustworthy sync operation
              // for the child, so its real clock mints the first membership
              // (same-parent re-promotion reuses, different-parent fails
              // closed; never createdAt/entityClock/fieldClock/current time).
              const msgOpId = syncService.enqueueUpsertInTx(
                stx,
                'message',
                messageId,
                this.syncMessagePayloadFull(row.data),
                ctx.ts,
                ctx.deviceId
              )
              this.mintPromotionMembershipInTx(stx, 'message', messageId, row.data.topicId, ctx.ts, msgOpId)
              notify = true
              // Promotion rescan: stable blocks committed with the transient
              // stub (appendMessage skips all intent while transient) join this
              // stable checkpoint parent-first as entity-only evidence (no
              // membership backfill — pre-existing stable siblings stay
              // unversioned/partial). Explicitly requested blocks mint via
              // their own same-tx upsert clock in updateMessageAndBlocks.
              // Fail closed on error.
              // Unsupported structured/attachment descendants skip without a
              // partial shell (durable outcome recorded after commit).
              if (
                this.captureUntrackedStableBlocksInTx(
                  stx,
                  repos,
                  messageId,
                  ctx.ts,
                  ctx.deviceId,
                  new Set<string>(),
                  unsupportedBlockIds
                )
              ) {
                notify = true
              }
            } else {
              const payload = this.syncMessagePatchPayload(
                topicId,
                messageId,
                patch as unknown as Record<string, unknown>
              )
              if (payload) {
                syncService.enqueueUpsertInTx(stx, 'message', messageId, payload, ctx.ts, ctx.deviceId)
                notify = true
              }
              // Deterministic rescan (LOCK-PERSONAL-004): every stable message
              // capture re-checks all committed stable descendants against
              // tracked/outbox state, even when the parent is already tracked.
              // A prior partial backfill (fallback child failure) can never be
              // silently abandoned — the next stable promotion retries the
              // remainder. Fail closed on infrastructure error.
              if (
                this.captureUntrackedStableBlocksInTx(
                  stx,
                  repos,
                  messageId,
                  ctx.ts,
                  ctx.deviceId,
                  new Set<string>(),
                  unsupportedBlockIds
                )
              ) {
                notify = true
              }
            }
            // Single per-parent frame decision AFTER all entity
            // work (F2): promotion mints at most one topic frame and one
            // messageBlock try-refresh; only complete trustworthy membership
            // yields exactly 1 op, otherwise truthful invalidate with 0 op
            // (ordinary rescan stays entity-only without membership backfill).
            // Stable→stable edits mint nothing.
            if (isPromotion) {
              if (syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId) === 'refreshed') {
                notify = true
              }
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageId, ctx.deviceId) === 'refreshed') {
                notify = true
              }
            }
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('updateMessage', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('updateMessage', unsupportedBlockIds)
      return result
    }, `updateMessage(${topicId}, ${messageId})`)
  }

  /**
   * Conditional usage-only write (optional prompt-token estimate).
   *
   * One Main transaction: ownership/route guard (foreign route and non-owned rows
   * fail closed with the ordinary BRANCH-4 error), then the condition — target
   * present, user row, no usage yet, and the authority estimate source equal to the
   * renderer snapshot — and only then the usage patch. A failed condition returns
   * a rejection code without mutating anything; it never throws and never emits.
   *
   * The patch is exactly `{usage}`: the conditional mode is a display-metadata
   * mode, not a general compare-and-swap. `usage` is not in the sync field
   * allowlist, so this path deliberately bypasses the sync capture machinery —
   * an applied usage write enqueues no operation (identical outcome to the
   * ordinary path for a usage-only patch) and a rejected one can emit nothing.
   */
  private applyConditionalUsageEstimate(
    topicId: string,
    messageId: string,
    patch: EntityPatchInput<MessageData>,
    route: string | null,
    source: UpdateMessageUsageSource
  ): UpdateMessageUsageResult {
    // Defensive mirror of the contract: exactly the usage overflow key.
    const patchKeys = Object.keys(patch).filter((key) => key !== 'overflow')
    const overflowKeys = Object.keys(patch.overflow ?? {})
    if (patchKeys.length > 0 || overflowKeys.length !== 1 || overflowKeys[0] !== 'usage') {
      throw new ChatDbValidationError('Conditional usage mode accepts exactly one "usage" update (defensive check)')
    }
    return this.db.transaction((tx): UpdateMessageUsageResult => {
      const repos = createRepositories(tx)
      const row = repos.messages.getInTopic(messageId, topicId)
      if (!row.found) return { applied: false, rejection: 'target-missing' }
      // Ownership/route guard: a row owned by another route is immutable through
      // this one — fail closed exactly like the ordinary update path.
      this.assertMutableMessageInTx(
        repos,
        tx as unknown as BetterSQLite3Database<typeof schema>,
        topicId,
        route,
        messageId
      )
      if (row.data.role !== 'user') return { applied: false, rejection: 'not-user-message' }
      // Usage already owned (edit / resend / an earlier estimate): never overwrite.
      const existingUsage = (row.data.overflow as Record<string, unknown> | undefined)?.usage
      if (existingUsage !== undefined && existingUsage !== null) {
        return { applied: false, rejection: 'usage-present' }
      }
      const authoritySource = usageSourceOfBlocks(repos.blocks.listByMessage(messageId))
      const requestedSource: UpdateMessageUsageSource = {
        textContents: [...source.textContents].sort(),
        fileIds: [...source.fileIds].sort()
      }
      if (!sameUsageSource(authoritySource, requestedSource)) {
        return { applied: false, rejection: 'source-changed' }
      }
      const applied = repos.messages.update(topicId, messageId, patch)
      if (applied.affected === 0) return { applied: false, rejection: 'target-missing' }
      return { applied: true }
    })
  }

  /**
   * Atomic message patch + full block upserts + references/order.
   * Missing message: follows Dexie-compatible no-op without weakening FK.
   *
   * When blockIdsToDelete is provided:
   * - Each block ID is resolved through its parent message to verify
   *   topic ownership (LOCK-004). Blocks whose parent message does not
   *   belong to the requested topic are rejected atomically.
   * - File references are collected from owned blocks only before cascade.
   * - Returns FileCleanupResult for caller-side post-commit consumption.
   */
  updateMessageAndBlocks(
    topicId: string,
    messageUpdatesJson: JsonObject,
    blocksToUpdateJson: JsonObject[],
    blockIdsToDelete: string[] = [],
    options?: { resendAttemptId?: string; branchId?: string | null }
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(options?.branchId)
      const messageId = messageUpdatesJson.id as string
      const messagePatch = wireToMessagePatch(messageUpdatesJson)
      delete messagePatch.id
      delete messagePatch.topicId
      delete messagePatch.branchId
      delete messagePatch.sortOrder

      const blockDataList = blocksToUpdateJson.map(wireToBlock)
      // Deterministic block order: assign explicit sortOrder from complete
      // authoritative message.blocks order before repository normalization;
      // writes without authoritative ordered list retain behavior.
      this.assignAuthoritativeBlockOrder(messageUpdatesJson, blockDataList)
      const resendAttemptId = this.resendAttemptOf(options)
      // Stale-attempt fail-closed before any SQLite write transaction opens
      // (best-effort delete-parent resolution; authoritative check is in-tx).
      const deleteParentsPreTx: string[] = []
      for (const bid of blockIdsToDelete) {
        try {
          const found = this.repos().blocks.getById(bid)
          if (found.found) deleteParentsPreTx.push(found.data.messageId)
        } catch {
          // Best effort only.
        }
      }
      this.assertResendAttemptPreTx(
        [messageId, ...this.blockParentIdsPreTx(blocksToUpdateJson), ...deleteParentsPreTx],
        resendAttemptId
      )
      const syncCtx = this.syncCtxForTopic('updateMessageAndBlocks', topicId, route)
      let syncNotify = false
      const unsupportedBlockIds: string[] = []

      let txResult: FileCleanupResult
      try {
        txResult = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Resend intent (SYNC-DATA-055): authoritative stale check first —
          // a mismatch rolls back before any mutation commits; a covered
          // message stays local-only (mutations commit, sync suppressed).
          const messageCovered = this.checkResendAttemptInTx(stx, messageId, resendAttemptId)
          // Route immutability: inherited/shared messages and their
          // blocks reject; missing rows keep existing no-op semantics.
          {
            const dbForGuard = tx as unknown as BetterSQLite3Database<typeof schema>
            this.assertMutableMessageInTx(repos, dbForGuard, topicId, route, messageId)
            for (const block of blockDataList) {
              this.assertMutableBlockInTx(repos, dbForGuard, topicId, route, block.id, block.messageId)
            }
            for (const bid of blockIdsToDelete) {
              this.assertMutableBlockInTx(repos, dbForGuard, topicId, route, bid)
            }
          }

          // Check message exists
          const existing = repos.messages.getInTopic(messageId, topicId)
          if (!existing.found) {
            // No-op: follow Dexie-compatible semantics — empty cleanup
            return { affectedFileIds: [], remainingReferenceCounts: {} }
          }

          // Phase 1: Resolve every block through its parent message and verify ownership.
          // Missing blocks follow delete no-op semantics. Existing blocks must belong
          // to the message being updated, not merely to the requested topic.
          let affectedFileIds: string[] = []
          const deletedPreIncluded = new Set<string>()
          if (blockIdsToDelete.length > 0) {
            const ownedBlockIds: string[] = []
            for (const blockId of blockIdsToDelete) {
              const block = repos.blocks.getById(blockId)
              if (!block.found) {
                // Missing block: skip (consistent with no-op semantics)
                continue
              }
              if (block.data.messageId !== messageId) {
                throw new ChatDbConflictError(
                  `Block ${blockId} belongs to message ${block.data.messageId}, cannot delete from message ${messageId}`
                )
              }
              // Resolve block → message → topic ownership
              const msg = repos.messages.getInTopic(block.data.messageId, topicId)
              if (!msg.found) {
                throw new ChatDbConflictError(
                  `Block ${blockId} belongs to message ${block.data.messageId} which is not in topic ${topicId}`
                )
              }
              ownedBlockIds.push(blockId)
            }

            // BEFORE deletion: capture each deletion candidate's actual pre-state inventory inclusion
            // (isStableBlockStatus && !isUnsupportedBlockForSync using parsed overflow fail-closed).
            // Only previously included deletions count as frame membership transitions.
            // Malformed overflow fails closed and rolls back.
            for (const bid of ownedBlockIds) {
              const raw = (tx as unknown as BetterSQLite3Database<typeof schema>)
                .select()
                .from(schema.messageBlocks)
                .where(eq(schema.messageBlocks.id, bid))
                .get() as unknown as
                | { id: string; status: string | null; type: string | null; extra: string | null }
                | undefined
              if (!raw) continue
              let overflow: Record<string, unknown> = {}
              if (raw.extra) {
                try {
                  const parsed = JSON.parse(raw.extra)
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new SyncFrameError(`malformed block extra JSON for ${bid}: not an object`)
                  }
                  overflow = parsed as Record<string, unknown>
                } catch (e) {
                  if (e instanceof SyncFrameError) throw e
                  throw new SyncFrameError(
                    `malformed block extra JSON for ${bid}: ${e instanceof Error ? e.message : String(e)}`
                  )
                }
              }
              const included =
                isStableBlockStatus(raw.status) && !isUnsupportedBlockForSync({ type: raw.type, overflow })
              if (included) deletedPreIncluded.add(bid)
            }

            // Collect affected file IDs from owned blocks only
            if (ownedBlockIds.length > 0) {
              const allRefs: FileReferenceData[] = []
              for (const blockId of ownedBlockIds) {
                const refs = repos.fileRefs.listByBlock(blockId)
                allRefs.push(...refs)
              }
              affectedFileIds = collectAffectedFileIds(allRefs)

              // Delete owned blocks (FK cascade removes file_references)
              repos.blocks.deleteMany(ownedBlockIds)
            }
          }

          // Apply message patch
          if (Object.keys(messagePatch).length > 0) {
            repos.messages.update(topicId, messageId, messagePatch)
          }

          // Upsert blocks (snapshot pre-state for field-patch diffing)
          const preBlockRows = new Map<string, MessageBlockData>()
          if (syncCtx && blockDataList.length > 0) {
            for (const block of blockDataList) {
              const pre = repos.blocks.getById(block.id)
              if (pre.found) preBlockRows.set(block.id, { ...pre.data, overflow: { ...pre.data.overflow } })
            }
          }
          if (blockDataList.length > 0) {
            repos.blocks.upsertMany(blockDataList)

            // Sync file references
            this.syncFileReferences(repos, blockDataList)
          }

          // Deterministic block order for non-upserted survivors (same transaction):
          // ensures supplied authoritative order survives variant/delete/reload.
          // Writes without authoritative ordered list retain behavior.
          {
            const authoritativeIds = this.getAuthoritativeBlockIds(messageUpdatesJson)
            if (authoritativeIds) {
              const upsertedIds = new Set(blockDataList.map((b) => b.id))
              const deletedIds = new Set(blockIdsToDelete)
              this.updateSurvivingBlockOrdersInTx(tx, messageId, authoritativeIds, upsertedIds, deletedIds)
            }
          }

          // Transaction-bound sync intent (same atomic boundary).
          // Resend intent (SYNC-DATA-055): a covered message stays
          // local-only — no entity intent, no deletes, no frames.
          if (syncCtx && !messageCovered) {
            const deletedOwned: string[] = []
            // Re-resolve owned deletes post-state: surviving rows are no-ops.
            for (const blockId of blockIdsToDelete) {
              if (typeof blockId !== 'string' || blockId.length === 0) continue
              const gone = !repos.blocks.getById(blockId).found
              if (gone && syncService.isKnownEntityInTx(stx, 'message_block', blockId)) deletedOwned.push(blockId)
            }
            const mrow = repos.messages.getInTopic(messageId, topicId)
            if (mrow.found) {
              // Final-transition full state: only a transient→stable promotion
              // of a never-tracked message creates full state; pre-sync stable
              // rows keep patch/diff semantics.
              const messageTracked = syncService.isTrackedEntityInTx(stx, 'message', messageId)
              const preMessageStable = isStableMessageStatus(existing.data.status)
              const isPromotion = !messageTracked && !preMessageStable
              const msgPayload = isPromotion
                ? this.syncMessagePayloadFull(mrow.data)
                : this.diffMessagePayload(existing.data, mrow.data)
              if (msgPayload && isStableMessageStatus(mrow.data.status)) {
                this.ensureTopicClosureInTx(stx, topicId, syncCtx.ts, syncCtx.deviceId)
                // Promotion of a never-tracked transient row mints its first
                // membership from this same-tx stable upsert clock
                // (same-parent re-promotion reuses, different-parent fails
                // closed); ordinary stable rows keep patch semantics without
                // backfill.
                const msgOpId = syncService.enqueueUpsertInTx(
                  stx,
                  'message',
                  messageId,
                  msgPayload,
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                if (isPromotion) {
                  this.mintPromotionMembershipInTx(stx, 'message', messageId, mrow.data.topicId, syncCtx.ts, msgOpId)
                }
                syncNotify = true
                // Promotion rescan + deterministic rescan (LOCK-PERSONAL-004):
                // committed stable descendants created with the transient stub
                // (outside this request's block list) join the stable
                // checkpoint parent-first as entity-only evidence, except
                // inside a promotion-scoped supplement: when this same tx
                // carries an ordinary transient→success supported block
                // promotion, ordinary success + supported siblings missing
                // membership are versioned with their own same-tx upsert
                // clock (existing clocks never rewritten). Only explicitly
                // requested blocks (true-create or promotion with pre-state
                // evidence, each via its own same-tx upsert clock below)
                // otherwise mint membership. Every stable message capture
                // rescans all stable descendants against tracked/outbox
                // state, even when the parent is already tracked, so a prior
                // partial rescan is retried instead of silently abandoned.
                // Fail closed on error.
                if (isStableMessageStatus(mrow.data.status)) {
                  const requestedIds = new Set(blockDataList.map((b) => b.id))
                  let ordinaryBlockPromotionInTx = false
                  for (const block of blockDataList) {
                    const preForTrigger = preBlockRows.get(block.id) ?? null
                    if (!preForTrigger || isStableBlockStatus(preForTrigger.status)) continue
                    const postForTrigger = repos.blocks.getById(block.id)
                    if (!postForTrigger.found || postForTrigger.data.messageId !== messageId) continue
                    if (postForTrigger.data.status !== 'success') continue
                    if (this.isUnsupportedBlock(postForTrigger.data)) continue
                    ordinaryBlockPromotionInTx = true
                    break
                  }
                  if (
                    this.captureUntrackedStableBlocksInTx(
                      stx,
                      repos,
                      messageId,
                      syncCtx.ts,
                      syncCtx.deviceId,
                      requestedIds,
                      unsupportedBlockIds,
                      ordinaryBlockPromotionInTx
                    )
                  ) {
                    syncNotify = true
                  }
                }
              }
              for (const block of blockDataList) {
                const brow = repos.blocks.getById(block.id)
                if (!brow.found) continue
                if (brow.data.messageId !== messageId) continue
                if (!isStableBlockStatus(brow.data.status)) continue
                if (this.isUnsupportedBlock(brow.data)) {
                  unsupportedBlockIds.push(block.id)
                  continue
                }
                // Field patch via pre/post diff; a true insert (pre == null) or
                // a transient→stable promotion of a never-tracked row mints
                // its first membership from this same-tx stable upsert clock
                // (same-parent reuse, different-parent fail-closed).
                const pre = preBlockRows.get(block.id) ?? null
                const blockTracked = syncService.isTrackedEntityInTx(stx, 'message_block', block.id)
                const preBlockStable = pre ? isStableBlockStatus(pre.status) : true
                const isTrueCreate = !pre
                const isPromotion = !isTrueCreate && !blockTracked && !preBlockStable
                const patchPayload =
                  isTrueCreate || isPromotion
                    ? this.syncBlockPayloadFull(brow.data)
                    : this.diffBlockPayload(pre, brow.data)
                if (!patchPayload) continue
                this.ensureBlockParentClosureInTx(stx, block.id, syncCtx.ts, syncCtx.deviceId)
                const blkOpId = syncService.enqueueUpsertInTx(
                  stx,
                  'message_block',
                  block.id,
                  patchPayload,
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                if (isTrueCreate) {
                  syncService.setMembershipClockInTx(
                    stx,
                    'message_block',
                    block.id,
                    brow.data.messageId,
                    syncCtx.ts,
                    blkOpId
                  )
                } else if (isPromotion) {
                  this.mintPromotionMembershipInTx(
                    stx,
                    'message_block',
                    block.id,
                    brow.data.messageId,
                    syncCtx.ts,
                    blkOpId
                  )
                }
                syncNotify = true
              }
            }
            for (const bid of deletedOwned) {
              syncService.enqueueDeleteInTx(stx, 'message_block', bid, syncCtx.ts, syncCtx.deviceId)
              syncNotify = true
            }
            // Local parent order frame (010) — single per-parent decision (F1):
            // all message/block entity upsert (explicit true-create plus
            // explicit promotion-time membership mint; sibling rescan stays
            // entity-only except inside a promotion-scoped supplement where
            // missing ordinary success siblings were versioned above) and
            // delete/transition handling above complete first; then at most
            // one messageBlock tryRefresh+enqueue attempt per tx for this
            // parent. Exclusion (stable→transient parent) only invalidates
            // with 0 op and is never overridden by a tail refresh; a
            // non-stable parent never mints. Resend-covered parents
            // (SYNC-DATA-055) stay local-only: no frame work here.
            if (syncCtx && !messageCovered) {
              // Message inclusion transition (stable ↔ transient) handling for topicMessage and messageBlock
              const preMsgStable = isStableMessageStatus(existing.data.status)
              const mrowForFrame = repos.messages.getInTopic(messageId, topicId)
              const postMsgStable = mrowForFrame.found ? isStableMessageStatus(mrowForFrame.data.status) : false
              let messageTransitionHandled = false
              let promotionNeedsBlockFrame = false
              if (preMsgStable && !postMsgStable) {
                // Stable→transient exclusion (SYNC-DATA-048 errata): transient
                // status never rides the wire, so no frame op is minted —
                // invalidate the topic frame locally in the same tx;
                // invalidate messageBlock because the parent is excluded.
                syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageId)
                messageTransitionHandled = true
              } else if (!preMsgStable && postMsgStable) {
                // Transient→stable inclusion (SYNC-DATA-048 extension):
                // topic frame now; messageBlock defers to the single unified
                // decision below so promotion + true-create/inclusion share
                // exactly one attempt (message op precedes frame).
                if (
                  syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, syncCtx.deviceId) === 'refreshed'
                ) {
                  syncNotify = true
                }
                promotionNeedsBlockFrame = true
                messageTransitionHandled = true
              } else if (preMsgStable && postMsgStable) {
                // Stable→stable: ordinary content edits do not advance topic frame
              } else {
                // Transient→transient: no frame
                messageTransitionHandled = true
              }

              // Block inclusion transitions (stable && supported) — collected
              // here, minted once below. Pure included→included content edits
              // mint nothing. Deletion handling uses pre-state inclusion
              // captured before delete (fail-closed on malformed overflow).
              // Only previously included deletions count;
              // transient/unsupported deletes never mint.
              let hasBlockInclusionChange = false
              if (!messageTransitionHandled) {
                if (deletedPreIncluded.size > 0) {
                  hasBlockInclusionChange = true
                }
              } else if (promotionNeedsBlockFrame && deletedPreIncluded.size > 0) {
                // Promotion tx that also deletes previously included blocks:
                // covered by the single promotion frame below (final order).
                promotionNeedsBlockFrame = true
              }
              // Check block upserts for inclusion changes (existing blocks)
              let hasTrueCreateStrict = false
              for (const b of blockDataList) {
                const pre = preBlockRows.get(b.id) ?? null
                if (!pre) {
                  // True create: if post included, candidate for the single refresh below
                  const brow = repos.blocks.getById(b.id)
                  if (brow.found && isStableBlockStatus(brow.data.status) && !this.isUnsupportedBlock(brow.data)) {
                    hasTrueCreateStrict = true
                  }
                  continue
                }
                const preIncluded = isStableBlockStatus(pre.status) && !this.isUnsupportedBlock(pre)
                const postRow = repos.blocks.getById(b.id)
                const postIncluded = postRow.found
                  ? isStableBlockStatus(postRow.data.status) && !this.isUnsupportedBlock(postRow.data)
                  : false
                if (preIncluded !== postIncluded) {
                  hasBlockInclusionChange = true
                }
              }
              // Unified single messageBlock attempt: promotion, true-create,
              // or inclusion transition share exactly one tryRefresh+enqueue.
              // Exclusion paths (transient/unsupported present) invalidate
              // with 0 op via the try helper since transient/unsupported
              // never rides the wire and frames carry no exclusion authority.
              // Stable→transient parent exclusion above never reaches here.
              const needsBlockFrame = promotionNeedsBlockFrame || hasTrueCreateStrict || hasBlockInclusionChange
              if (needsBlockFrame && !messageTransitionHandled) {
                if (
                  syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageId, syncCtx.deviceId) ===
                  'refreshed'
                ) {
                  syncNotify = true
                }
              } else if (needsBlockFrame && promotionNeedsBlockFrame) {
                if (
                  syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, messageId, syncCtx.deviceId) ===
                  'refreshed'
                ) {
                  syncNotify = true
                }
              }
              // Ordinary included→included content edits: no frame advance (do nothing)
            }
          }
          // Normal stable_replace issuer (SYNC-DATA-055 consume) for the
          // atomic message+blocks finalization shape: same success/error/
          // paused gate as updateMessage — only a matching attempt with
          // complete stable-supported post-state emits exactly one op and
          // clears the intent; transient/sent/legacy/unsupported/incomplete
          // stays local-only with the intent retained; any validator/
          // membership/frame/clock error throws and rolls back with no op.
          if (syncCtx && messageCovered && resendAttemptId !== undefined) {
            const issue = syncService.tryIssueStableReplaceInTx(stx, {
              messageId,
              attemptId: resendAttemptId,
              deviceId: syncCtx.deviceId
            })
            if (issue.issued) syncNotify = true
          }
          return buildFileCleanupResult(repos, affectedFileIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('updateMessageAndBlocks', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('updateMessageAndBlocks', unsupportedBlockIds)
      return txResult
    }, `updateMessageAndBlocks(${topicId}, ${messageUpdatesJson.id})`)
  }

  /**
   * Cross-process authority answer selection.
   *
   * ONE root better-sqlite3 transaction resolves AND persists the WHOLE
   * selection from the selected ID alone:
   * 1. Topic must exist; selected must belong to topic, role assistant,
   *    non-empty askId — otherwise NOT_FOUND fail-closed.
   * 2. Resolve the complete group: same-topic assistant messages with equal
   *    askId in listByTopic order (sort_order ASC, id ASC).
   * 3. Persist `foldSelected=true` for selected, `false` for every other
   *    group member atomically; return the authoritative response.
   *
   * No timestamps/content/order changes: `foldSelected` is an existing
   * persisted UI overflow field and the only field touched. It is
   * wire-excluded and changes neither order, membership, nor synced fields:
   * local-only and frame-preserving — any existing `topicMessage` frame and
   * high-water are preserved with zero sync ops, and no missing frame is
   * synthesized.
   */
  selectAnswerMessage(
    topicId: string,
    selectedMessageId: string,
    branchId?: string | null
  ): ChatDbResult<SelectAnswerMessageResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('selectAnswerMessage')
      const route = this.normalizeBranchId(branchId)
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        }
        const routeMessages = this.resolveRouteMessagesInTx(repos, topicId, route).messages
        const selected = routeMessages.find((m) => m.id === selectedMessageId)
        if (!selected) {
          throw new ChatDbNotFoundError(`Message ${selectedMessageId} does not belong to topic ${topicId}`)
        }
        const askId = selected.askId
        if (selected.role !== 'assistant' || typeof askId !== 'string' || askId.length === 0) {
          throw new ChatDbNotFoundError(`Message ${selectedMessageId} has no actionable answer group`)
        }
        const groupIds = routeMessages.filter((m) => m.role === 'assistant' && m.askId === askId).map((m) => m.id)
        if (!groupIds.includes(selectedMessageId) || groupIds.length === 0) {
          throw new ChatDbNotFoundError(`Message ${selectedMessageId} has no actionable answer group`)
        }
        // BRANCH-4/11: the selection flips every actually-written group
        // member atomically, so a group with non-owned members rejects
        // instead of half-flipping (no copy-on-write). Reading the user
        // root never requires mutability.
        {
          const dbForSelectGuard = tx as unknown as BetterSQLite3Database<typeof schema>
          const resolved = this.assertAnswerGroupMutableInTx(
            repos,
            dbForSelectGuard,
            topicId,
            route,
            askId,
            routeMessages
          )
          if (resolved.length !== groupIds.length || !resolved.includes(selectedMessageId)) {
            throw new ChatDbNotFoundError(`Message ${selectedMessageId} has no actionable answer group`)
          }
        }
        for (const id of groupIds) {
          repos.messages.update(topicId, id, { overflow: { foldSelected: id === selectedMessageId } })
        }
        return {
          topicId,
          askId,
          selectedMessageId,
          messageIds: groupIds
        }
      })
    }, `selectAnswerMessage(${topicId})`)
  }

  /**
   * BRANCH-4/11: atomic group-level `useful` selection.
   *
   * The renderer supplies ONLY the toggled message ID; Main resolves the
   * complete answer group (including window-outside members) in the same
   * SQLite transaction, requires every actually-written member owned by
   * the addressed route (no copy-on-write), then persists exactly one
   * `useful=true` atomically: when the target is already the useful member
   * it is cleared (all false), otherwise the target becomes the single
   * useful member and every other member is cleared. No partial write.
   */
  selectUsefulAnswer(
    topicId: string,
    messageId: string,
    branchId?: string | null
  ): ChatDbResult<SelectUsefulAnswerResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('selectUsefulAnswer')
      const route = this.normalizeBranchId(branchId)
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        }
        const routeMessages = this.resolveRouteMessagesInTx(repos, topicId, route).messages
        const target = routeMessages.find((m) => m.id === messageId)
        if (!target) {
          throw new ChatDbNotFoundError(`Message ${messageId} does not belong to topic ${topicId}`)
        }
        const askId = target.askId
        if (target.role !== 'assistant' || typeof askId !== 'string' || askId.length === 0) {
          throw new ChatDbNotFoundError(`Message ${messageId} has no actionable answer group`)
        }
        const dbForUsefulGuard = tx as unknown as BetterSQLite3Database<typeof schema>
        const groupIds = this.assertAnswerGroupMutableInTx(
          repos,
          dbForUsefulGuard,
          topicId,
          route,
          askId,
          routeMessages
        )
        if (!groupIds.includes(messageId)) {
          throw new ChatDbNotFoundError(`Message ${messageId} has no actionable answer group`)
        }
        // Toggle: an already-useful target clears the group; otherwise the
        // target becomes the single useful member. Read current flags from
        // the same transaction snapshot.
        const currentUseful = new Set<string>()
        for (const id of groupIds) {
          const row = repos.messages.getInTopic(id, topicId)
          if (row.found && (row.data as { useful?: unknown }).useful === true) currentUseful.add(id)
        }
        const nextUseful: string | null = currentUseful.size === 1 && currentUseful.has(messageId) ? null : messageId
        for (const id of groupIds) {
          repos.messages.update(topicId, id, { overflow: { useful: id === nextUseful } })
        }
        return {
          topicId,
          askId,
          usefulMessageId: nextUseful,
          messageIds: groupIds
        }
      })
    }, `selectUsefulAnswer(${topicId})`)
  }

  /**
   * Turn-level fold/unfold — one atomic Main transaction.
   *
   * Fold is a TURN-level presentation state that also decides request
   * participation, so the renderer never writes single rows: it names stable
   * group ids (a turn's user message id) and the target state, and Main does
   * the rest in the same SQLite snapshot.
   *
   * 1. Validate the request shape fail-closed: a non-empty, duplicate-free
   *    list of stable group ids and one boolean state. Nothing partial or
   *    positional can be expressed.
   * 2. Resolve the COMPLETE turn membership of every selected group on the
   *    addressed effective route (`groupEffectiveTurnsInTx`), so messages
   *    outside the loaded window resolve exactly like resident ones — the
   *    renderer's projection never decides what a turn contains.
   * 3. Require the whole range to be owned by the addressed route and to sit
   *    at/after the route's fork boundary (shared group-level range guard):
   *    a selection that crosses the fork — including a hole selection whose
   *    endpoints are owned but whose span covers the boundary, and a turn
   *    whose members straddle it — rejects with zero writes.
   * 4. Patch `folded` on EVERY member of every selected turn: `true` writes
   *    the marker, `false` removes the key (an absent key is the unfolded
   *    state, so a `false` value is never persisted).
   *
   * Turn coherence: writing whole turns here, expanding a partially-marked
   * turn on read, and inheriting the fold state on a newly appended variant
   * are one mechanism, so "some rows folded" can never be observed as a
   * Main-side exclusion that disagrees with the renderer's row display.
   *
   * Fold is local-only presentation: membership, order, anchors, boundaries
   * and sync frames are untouched (no sync op is emitted).
   */
  setTurnFolds(
    topicId: string,
    selectedGroupIds: string[],
    folded: boolean,
    branchId?: string | null
  ): ChatDbResult<SetTurnFoldsResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('setTurnFolds')
      const route = this.normalizeBranchId(branchId)
      if (!Array.isArray(selectedGroupIds) || selectedGroupIds.length === 0) {
        throw new ChatDbValidationError('setTurnFolds requires a non-empty selectedGroupIds list')
      }
      const seen = new Set<string>()
      for (const groupId of selectedGroupIds) {
        if (typeof groupId !== 'string' || groupId.length === 0) {
          throw new ChatDbValidationError('setTurnFolds requires non-empty group IDs')
        }
        if (seen.has(groupId)) {
          throw new ChatDbValidationError(`Duplicate group ID ${groupId} in setTurnFolds selection`)
        }
        seen.add(groupId)
      }
      if (typeof folded !== 'boolean') {
        throw new ChatDbValidationError('setTurnFolds requires a boolean folded state')
      }
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        }
        if (route !== null) this.requireBranchInTx(repos, topicId, route)
        const turns = this.groupEffectiveTurnsInTx(this.resolveRouteMessagesInTx(repos, topicId, route).messages)
        const turnByGroupId = new Map<string, { askId: string; messageIds: string[] }>()
        const turnOrder = new Map<string, number>()
        turns.forEach((turn, index) => {
          turnByGroupId.set(turn.askId, turn)
          turnOrder.set(turn.askId, index)
        })
        const selected: Array<{ askId: string; messageIds: string[] }> = []
        for (const groupId of selectedGroupIds) {
          const turn = turnByGroupId.get(groupId)
          if (!turn) {
            throw new ChatDbValidationError(
              `Group ${groupId} does not belong to the addressed route of topic ${topicId}`
            )
          }
          selected.push(turn)
        }
        // Effective-route order keeps the response canonical regardless of the
        // order the renderer listed its selection in.
        selected.sort((a, b) => (turnOrder.get(a.askId) ?? 0) - (turnOrder.get(b.askId) ?? 0))
        const memberIds = selected.flatMap((turn) => turn.messageIds)
        this.assertGroupRangeOwnedInTx(repos, topicId, route, memberIds)
        for (const messageId of memberIds) {
          repos.messages.update(topicId, messageId, {
            overflow: { folded: folded ? true : OVERFLOW_REMOVE }
          })
        }
        return {
          topicId,
          folded,
          turns: selected.map((turn) => ({
            groupId: turn.askId,
            messageIds: [...turn.messageIds],
            folded
          })),
          affectedMessageIds: memberIds
        }
      })
    }, `setTurnFolds(${topicId}, ${selectedGroupIds.length} turns)`)
  }

  /**
   * Delete a single message. Only deletes if owned by the specified topic.
   * Missing/foreign IDs: no-op. Delete intent commits atomically in the
   * same tx (known entities only — unknown ids never emit remotely).
   */
  deleteMessage(topicId: string, messageId: string, branchId?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('deleteMessage', topicId, route)
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          // BRANCH-4 owner equality only: deleting a read-only ancestor
          // reference through another route rejects. Missing rows keep
          // no-op semantics.
          this.assertMutableMessageInTx(
            repos,
            tx as unknown as BetterSQLite3Database<typeof schema>,
            topicId,
            route,
            messageId
          )
          // Verify ownership before delete
          const existing = repos.messages.getInTopic(messageId, topicId)
          if (!existing.found) return null // no-op for missing/foreign IDs
          const known = ctx ? syncService.isKnownEntityInTx(stx, 'message', messageId) : false
          // Branch/reference boundaries move off the deleted row before it is
          // gone (pre-delete ordering supplies the predecessor).
          this.advanceInheritanceBoundariesInTx(repos, topicId, [messageId])
          repos.messages.delete(messageId)
          // Resend intent (SYNC-DATA-055): a deleted message carries no
          // unfinished attempt — clear in the same transaction.
          clearResendAttemptsInTx(stx, [messageId])
          if (ctx && known) {
            syncService.enqueueDeleteInTx(stx, 'message', messageId, ctx.ts, ctx.deviceId)
            notify = true
          }
          // Local parent order frame (SYNC-DATA-048) — strict refresh plus
          // matching order_frame op reusing the winning frameClock (same tx).
          // Soft-deleted topic still requires its topicMessage frame; only absent/hard-deleted has no frame.
          if (ctx) {
            syncService.invalidateParentFrameInTx(stx, 'messageBlock', messageId)
            const topicRow = repos.topics.getById(topicId)
            if (topicRow.found) {
              if (syncService.refreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId)) {
                notify = true
              }
            }
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteMessage', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `deleteMessage(${topicId}, ${messageId})`)
  }

  /**
   * Delete multiple messages. Only deletes messages owned by the specified topic.
   * Missing/foreign IDs: no-op. Delete intents commit atomically in the same tx.
   */
  deleteMessages(topicId: string, messageIds: string[], branchId?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('deleteMessages', topicId, route)
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          // BRANCH-4 owner equality only: non-owned IDs reject instead of
          // being silently skipped; missing IDs keep existing skip semantics.
          {
            const dbForDeleteGuard = tx as unknown as BetterSQLite3Database<typeof schema>
            for (const id of messageIds) {
              this.assertMutableMessageInTx(repos, dbForDeleteGuard, topicId, route, id)
            }
          }
          // Filter to messages actually owned by this route
          const ownedIds: string[] = []
          for (const id of messageIds) {
            const existing = repos.messages.getInTopic(id, topicId)
            if (existing.found && (existing.data.branchId ?? null) === route) ownedIds.push(id)
          }
          const knownIds = ctx ? ownedIds.filter((id) => syncService.isKnownEntityInTx(stx, 'message', id)) : []
          if (ownedIds.length > 0) {
            // Same boundary maintenance as the single-message path (the whole
            // batch leaves together, so predecessors skip every deleted id).
            this.advanceInheritanceBoundariesInTx(repos, topicId, ownedIds)
            repos.messages.deleteMany(ownedIds)
            // Message deletes cascade membership rows away without touching
            // the segment row: repair persisted heads that pointed at a
            // deleted message (same tx, authority rows only). Segments are
            // never dissolved here — that stays with membership writes.
            repos.segments.repairHeadersForDeletedMessages(ownedIds)
            // Resend intent (SYNC-DATA-055): deleted messages carry no
            // unfinished attempt — clear in the same transaction.
            clearResendAttemptsInTx(stx, ownedIds)
          }
          if (ctx) {
            for (const id of knownIds) {
              syncService.enqueueDeleteInTx(stx, 'message', id, ctx.ts, ctx.deviceId)
              notify = true
            }
          }
          // Local parent order frame (SYNC-DATA-048) — strict refresh plus
          // matching order_frame op reusing the winning frameClock (same tx).
          // Soft-deleted topic still requires its topicMessage frame; only absent/hard-deleted has no frame.
          if (ctx && ownedIds.length > 0) {
            for (const did of ownedIds) {
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', did)
            }
            const topicRow = repos.topics.getById(topicId)
            if (topicRow.found) {
              if (syncService.refreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId)) {
                notify = true
              }
            }
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteMessages', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `deleteMessages(${topicId}, ${messageIds.length} ids)`)
  }

  /**
   * Resolve the addressed route context for a block command.
   *
   * When a caller supplies an explicit topic context, the block's parent must
   * be owned by exactly that route — a cross-topic foreign prefix row written
   * through a reference target fails closed. When absent, the route is
   * resolved from the committed parent (topicId/branchId of the row), so
   * canonical source-stream callers keep their existing behavior.
   */
  private blockGuardContext(options?: BlockRouteContext): { topicId: string | null; branchId: string | null } {
    const topicId = typeof options?.topicId === 'string' && options.topicId.length > 0 ? options.topicId : null
    if (topicId === null) return { topicId: null, branchId: null }
    return { topicId, branchId: options?.branchId ?? null }
  }

  /**
   * Upsert blocks. Existing order preserved, new blocks append per input order.
   * No reparent. Reference sync for file/image blocks.
   *
   * Atomicity: block upsert + file-reference replacement in one root transaction.
   * All repositories are tx-bound.
   *
   * `diagnostics` is optional measurement-only correlation metadata
   * (LOCK-STREAM-ATTR-001, PERF-STREAM-ATTR-001); never affects persistence.
   */
  updateBlocks(
    blocksJson: JsonObject[],
    diagnostics?: StreamWriteDiagnostics,
    options?: BlockRouteContext
  ): ChatDbResult<null> {
    void diagnostics
    const result = wrapResult(() => {
      const blockDataList = blocksJson.map(wireToBlock)

      const resendAttemptId = this.resendAttemptOf(options)
      // Stale-attempt fail-closed before any SQLite write transaction opens.
      this.assertResendAttemptPreTx(this.blockParentIdsPreTx(blocksJson), resendAttemptId)
      const guardCtx = this.blockGuardContext(options)
      const blockOwnerRoute = this.resolveBlockOwnerRoute(blocksJson)
      const syncCtx = this.syncCtxForTopic(
        'updateBlocks',
        guardCtx.topicId ?? blockOwnerRoute?.topicId ?? '',
        guardCtx.topicId !== null ? guardCtx.branchId : (blockOwnerRoute?.branchId ?? null)
      )
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      const ordinaryPromotionParents = new Set<string>()
      try {
        this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          // Route immutability: blocks under inherited/shared parents
          // reject (no copy-on-write); missing rows keep existing semantics.
          {
            const dbForBlockGuard = tx as unknown as BetterSQLite3Database<typeof schema>
            for (const block of blockDataList) {
              this.assertMutableBlockInTx(
                repos,
                dbForBlockGuard,
                guardCtx.topicId,
                guardCtx.branchId,
                block.id,
                block.messageId
              )
            }
          }
          // Pre-state snapshot for field-patch diffing (same tx, pre-write).
          const preRows = new Map<string, MessageBlockData>()
          if (syncCtx) {
            for (const block of blockDataList) {
              const pre = repos.blocks.getById(block.id)
              if (pre.found) preRows.set(block.id, { ...pre.data, overflow: { ...pre.data.overflow } })
            }
          }
          repos.blocks.upsertMany(blockDataList)

          // Sync file references within the same transaction
          this.syncFileReferences(repos, blockDataList)

          // Transaction-bound sync intent: creates → full union payload;
          // existing → diff field patch at stable checkpoints only. Only a
          // transient→stable promotion of a never-tracked row creates full
          // state; pre-sync stable rows keep patch semantics. Unsupported
          // structured/attachment rows skip without a partial shell.
          if (syncCtx) {
            for (const block of blockDataList) {
              const post = repos.blocks.getById(block.id)
              if (!post.found) continue
              // F3 fail-closed: branch-owned or owner-unknown blocks never
              // emit sync intent (outbox/membership/frames); the upsert above
              // still commits.
              if (
                this.isBlockSyncSuppressedInTx(
                  repos,
                  tx as unknown as BetterSQLite3Database<typeof schema>,
                  block.id,
                  block.messageId
                )
              ) {
                continue
              }
              if (!isStableBlockStatus(post.data.status)) continue
              if (this.isUnsupportedBlock(post.data)) {
                unsupportedBlockIds.push(block.id)
                continue
              }
              // Resend intent (SYNC-DATA-055): stale attempt throws (rolls
              // back); a covered parent stays local-only. Placed before the
              // parent closure so no covered intent can leak via closure.
              if (this.checkResendAttemptInTx(stx, post.data.messageId, resendAttemptId)) continue
              const pre = preRows.get(block.id) ?? null
              const tracked = syncService.isTrackedEntityInTx(stx, 'message_block', block.id)
              const preStable = pre ? isStableBlockStatus(pre.status) : true
              if (!pre) {
                // True insertion by same tx: trustworthy creation -> membership
                this.ensureBlockParentClosureInTx(stx, block.id, syncCtx.ts, syncCtx.deviceId)
                const opId = syncService.enqueueUpsertInTx(
                  stx,
                  'message_block',
                  block.id,
                  this.syncBlockPayloadFull(post.data),
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                syncService.setMembershipClockInTx(
                  stx,
                  'message_block',
                  block.id,
                  post.data.messageId,
                  syncCtx.ts,
                  opId
                )
                syncNotify = true
                continue
              }
              if (!tracked && !preStable) {
                // Transient->stable promotion of a never-tracked row: this
                // same-tx stable upsert is the first trustworthy sync
                // operation, so its real clock mints the first membership
                // (same-parent reuse, different-parent fail-closed).
                this.ensureBlockParentClosureInTx(stx, block.id, syncCtx.ts, syncCtx.deviceId)
                const promoOpId = syncService.enqueueUpsertInTx(
                  stx,
                  'message_block',
                  block.id,
                  this.syncBlockPayloadFull(post.data),
                  syncCtx.ts,
                  syncCtx.deviceId
                )
                this.mintPromotionMembershipInTx(
                  stx,
                  'message_block',
                  block.id,
                  post.data.messageId,
                  syncCtx.ts,
                  promoOpId
                )
                syncNotify = true
                // Ordinary promotion trigger for the same-tx sibling
                // supplement below (only success + supported qualify).
                if (post.data.status === 'success') {
                  ordinaryPromotionParents.add(post.data.messageId)
                }
                continue
              }
              // Tracked transient→stable re-promotion to ordinary success is
              // also a promotion checkpoint for sibling supplement purposes
              // (own membership is retained/reused); it never mints here.
              if (pre && !preStable && post.data.status === 'success') {
                ordinaryPromotionParents.add(post.data.messageId)
              }
              if (post.data.messageId !== pre.messageId) continue
              const patchPayload = this.diffBlockPayload(pre, post.data)
              if (!patchPayload) continue
              this.ensureBlockParentClosureInTx(stx, block.id, syncCtx.ts, syncCtx.deviceId)
              syncService.enqueueUpsertInTx(stx, 'message_block', block.id, patchPayload, syncCtx.ts, syncCtx.deviceId)
              syncNotify = true
            }
            // Promotion-scoped sibling supplement (same atomic tx): each
            // ordinary promotion parent versions its missing ordinary
            // success + supported siblings so the single frame decision below
            // can complete. Resend-covered parents stay local-only; any
            // conflict/malformed failure rolls back the whole tx.
            if (ordinaryPromotionParents.size > 0) {
              const requestedIds = new Set(blockDataList.map((b) => b.id))
              for (const pid of ordinaryPromotionParents) {
                if (getResendAttemptInTx(stx, pid)) continue
                if (
                  this.backfillMissingSuccessSiblingMembershipInTx(
                    stx,
                    repos,
                    pid,
                    syncCtx.ts,
                    syncCtx.deviceId,
                    requestedIds
                  ) > 0
                ) {
                  syncNotify = true
                }
              }
            }
          }
          // Ordinary messageBlock inclusion paths issue exactly one frame
          // via the try helper (missing membership invalidates with 0 op
          // while the user mutation succeeds; malformed/MAX_SAFE rolls
          // back). Pure included→included content edits mint nothing.
          // Exclusion (stable→transient/supported→unsupported) never mints:
          // transient/unsupported never rides the wire and frames carry no
          // exclusion authority — invalidate only.
          if (syncCtx) {
            const affectedParentsStrict = new Set<string>()
            const affectedParentsHelper = new Set<string>()
            for (const b of blockDataList) {
              const pre = preRows.get(b.id) ?? null
              const postRow = repos.blocks.getById(b.id)
              if (!postRow.found) continue
              // F3 fail-closed: suppressed (branch-owned/unknown) blocks mint
              // no frame intent either.
              if (
                this.isBlockSyncSuppressedInTx(
                  repos,
                  tx as unknown as BetterSQLite3Database<typeof schema>,
                  b.id,
                  b.messageId
                )
              ) {
                continue
              }
              if (!pre) {
                if (isStableBlockStatus(postRow.data.status) && !this.isUnsupportedBlock(postRow.data)) {
                  affectedParentsStrict.add(postRow.data.messageId)
                }
              } else {
                const preIncluded = isStableBlockStatus(pre.status) && !this.isUnsupportedBlock(pre)
                const postIncluded = isStableBlockStatus(postRow.data.status) && !this.isUnsupportedBlock(postRow.data)
                if (preIncluded !== postIncluded) {
                  affectedParentsHelper.add(postRow.data.messageId)
                }
                // Ordinary included→included content edits do not advance — no frame change
              }
            }
            for (const pid of affectedParentsStrict) {
              if (affectedParentsHelper.has(pid)) continue // helper will handle (transition takes precedence)
              // Resend-covered parents (SYNC-DATA-055) stay local-only.
              if (getResendAttemptInTx(stx, pid)) continue
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, pid, syncCtx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
            for (const pid of affectedParentsHelper) {
              // Resend-covered parents (SYNC-DATA-055) stay local-only.
              if (getResendAttemptInTx(stx, pid)) continue
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, pid, syncCtx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('updateBlocks', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('updateBlocks', unsupportedBlockIds)
      return null
    }, `updateBlocks(${blocksJson.length} blocks)`)

    return result
  }

  /**
   * Update a single block by ID.
   * Missing: no-op. Patch only. Merge existing full block before recomputing
   * reference projection.
   *
   * Atomicity: load/merge/update + file-reference delete/create in one root
   * transaction. All repositories are tx-bound.
   *
   * `diagnostics` is optional measurement-only correlation metadata
   * (LOCK-STREAM-ATTR-001, PERF-STREAM-ATTR-001) carried by the renderer to
   * pair this call's records with the renderer-side serialize/IPC records of
   * the same call. It never affects persistence semantics.
   */
  updateSingleBlock(
    blockId: string,
    updatesJson: JsonObject,
    diagnostics?: StreamWriteDiagnostics,
    options?: BlockRouteContext
  ): ChatDbResult<null> {
    void diagnostics
    const result = wrapResult(() => {
      const patch = wireToBlockPatch(updatesJson)
      // Strip identity fields (defense in depth)
      delete patch.id
      delete patch.messageId
      delete patch.sortOrder

      const resendAttemptId = this.resendAttemptOf(options)
      // Stale-attempt fail-closed before any SQLite write transaction opens
      // (best-effort parent resolution; authoritative check is in-tx).
      this.assertResendAttemptPreTx(this.blockParentIdsPreTx([{ id: blockId } as JsonObject]), resendAttemptId)
      const guardCtx = this.blockGuardContext(options)
      const singleOwnerRoute = this.resolveBlockOwnerRouteByIds([blockId])
      const syncCtx = this.syncCtxForTopic(
        'updateSingleBlock',
        guardCtx.topicId ?? singleOwnerRoute?.topicId ?? '',
        guardCtx.topicId !== null ? guardCtx.branchId : (singleOwnerRoute?.branchId ?? null)
      )
      let syncNotify = false
      let singlePromotionTriggered = false
      const unsupportedBlockIds: string[] = []
      try {
        this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          const existing = repos.blocks.getById(blockId)
          if (!existing.found) return // no-op for missing
          // Route immutability: blocks under shared parents reject.
          this.assertMutableBlockInTx(
            repos,
            tx as unknown as BetterSQLite3Database<typeof schema>,
            guardCtx.topicId,
            guardCtx.branchId,
            blockId
          )

          // Apply patch to the existing block to get the merged result
          const merged: Record<string, unknown> = { ...existing.data }
          for (const [key, value] of Object.entries(patch)) {
            if (key !== 'overflow') {
              merged[key] = value
            }
          }
          // Merge overflow
          if (patch.overflow) {
            merged.overflow = { ...existing.data.overflow, ...patch.overflow }
          }

          // Apply the update
          repos.blocks.update(existing.data.messageId, blockId, patch)

          // Recompute file references from merged block (same tx)
          const mergedBlock = merged as unknown as MessageBlockData
          const newRefs = projectFileReferences(mergedBlock)
          const oldRefs = repos.fileRefs.listByBlock(blockId)

          // Replace stale references
          if (oldRefs.length > 0) {
            repos.fileRefs.deleteByBlock(blockId)
          }
          if (newRefs.length > 0) {
            repos.fileRefs.createMany(newRefs)
          }

          // Transaction-bound sync intent: only a transient→stable promotion
          // of a never-tracked block creates full state; otherwise intentional
          // patch keys. Transient skips, never a failure. Unsupported
          // structured/attachment rows skip without a partial shell.
          // Resend intent (SYNC-DATA-055): stale attempt throws (rolls back);
          // a covered parent stays local-only (before parent closure).
          // F3 fail-closed: a branch-owned or owner-unknown block emits no
          // sync intent at all (the patch above still commits).
          const singleSuppressed = syncCtx
            ? this.isBlockSyncSuppressedInTx(
                repos,
                tx as unknown as BetterSQLite3Database<typeof schema>,
                blockId,
                existing.data.messageId
              )
            : false
          if (syncCtx && !singleSuppressed) {
            const post = repos.blocks.getById(blockId)
            if (post.found && !this.checkResendAttemptInTx(stx, post.data.messageId, resendAttemptId)) {
              if (isStableBlockStatus(post.data.status)) {
                if (this.isUnsupportedBlock(post.data)) {
                  unsupportedBlockIds.push(blockId)
                } else {
                  this.ensureBlockParentClosureInTx(stx, blockId, syncCtx.ts, syncCtx.deviceId)
                  const tracked = syncService.isTrackedEntityInTx(stx, 'message_block', blockId)
                  const preStable = isStableBlockStatus(existing.data.status)
                  if (!tracked && !preStable) {
                    // Transient->stable promotion of a never-tracked row: this
                    // same-tx stable upsert mints the first membership from
                    // its real clock (same-parent reuse, different-parent
                    // fail-closed).
                    const promoOpId = syncService.enqueueUpsertInTx(
                      stx,
                      'message_block',
                      blockId,
                      this.syncBlockPayloadFull(post.data),
                      syncCtx.ts,
                      syncCtx.deviceId
                    )
                    this.mintPromotionMembershipInTx(
                      stx,
                      'message_block',
                      blockId,
                      post.data.messageId,
                      syncCtx.ts,
                      promoOpId
                    )
                    syncNotify = true
                    // Ordinary promotion trigger for the same-tx sibling
                    // supplement below (only success + supported qualify).
                    if (post.data.status === 'success') {
                      singlePromotionTriggered = true
                    }
                  } else {
                    // Tracked transient→success re-promotion is also a
                    // promotion checkpoint for sibling supplement purposes.
                    if (!preStable && post.data.status === 'success') {
                      singlePromotionTriggered = true
                    }
                    const payload = this.syncBlockPatchPayload(
                      post.data.messageId,
                      blockId,
                      patch as unknown as Record<string, unknown>
                    )
                    if (payload) {
                      syncService.enqueueUpsertInTx(
                        stx,
                        'message_block',
                        blockId,
                        payload,
                        syncCtx.ts,
                        syncCtx.deviceId
                      )
                      syncNotify = true
                    }
                  }
                }
              }
            }
            // Promotion-scoped sibling supplement (same atomic tx): an
            // ordinary transient→success supported promotion versions the
            // missing ordinary success + supported siblings so the single
            // frame decision below can complete. Resend-covered parents stay
            // local-only; any conflict/malformed failure rolls back the tx.
            if (syncCtx && singlePromotionTriggered) {
              const postForSiblings = repos.blocks.getById(blockId)
              if (postForSiblings.found && !getResendAttemptInTx(stx, postForSiblings.data.messageId)) {
                if (
                  this.backfillMissingSuccessSiblingMembershipInTx(
                    stx,
                    repos,
                    postForSiblings.data.messageId,
                    syncCtx.ts,
                    syncCtx.deviceId,
                    new Set([blockId])
                  ) > 0
                ) {
                  syncNotify = true
                }
              }
            }
          }
          // Ordinary messageBlock inclusion transition issues exactly one
          // frame via the try helper (missing membership invalidates with 0
          // op; exclusion invalidates since transient/unsupported never rides
          // the wire). Ordinary included→included content edits mint nothing.
          // Resend-covered parents (SYNC-DATA-055) stay local-only: no frame
          // work here (a stale attempt would already have thrown above).
          // F3 fail-closed: suppressed blocks mint no frame intent either.
          if (syncCtx && !singleSuppressed && !getResendAttemptInTx(stx, existing.data.messageId)) {
            const postRow2 = repos.blocks.getById(blockId)
            if (postRow2.found) {
              const preIncluded = isStableBlockStatus(existing.data.status) && !this.isUnsupportedBlock(existing.data)
              const postIncluded = isStableBlockStatus(postRow2.data.status) && !this.isUnsupportedBlock(postRow2.data)
              if (preIncluded !== postIncluded) {
                if (
                  syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(
                    stx,
                    postRow2.data.messageId,
                    syncCtx.deviceId
                  ) === 'refreshed'
                ) {
                  syncNotify = true
                }
              }
            } else {
              // block deleted via update? treat as invalidation
              const parentId = existing.data.messageId
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', parentId)
            }
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('updateSingleBlock', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('updateSingleBlock', unsupportedBlockIds)
      return null
    }, `updateSingleBlock(${blockId})`)

    return result
  }

  /**
   * Bulk add blocks (insert-only). Duplicate ID aborts whole batch.
   * Appends in input order. Syncs file references.
   *
   * Atomicity: one root transaction with tx-bound repositories.
   * Duplicate IDs throw ChatDbConflictError (typed).
   */
  bulkAddBlocks(blocksJson: JsonObject[], options?: BlockRouteContext): ChatDbResult<null> {
    return wrapResult(() => {
      const blockDataList = blocksJson.map(wireToBlock)
      const resendAttemptId = this.resendAttemptOf(options)
      // Stale-attempt fail-closed before any SQLite write transaction opens.
      this.assertResendAttemptPreTx(this.blockParentIdsPreTx(blocksJson), resendAttemptId)
      const guardCtx = this.blockGuardContext(options)
      const bulkOwnerRoute = this.resolveBlockOwnerRoute(blocksJson)
      const syncCtx = this.syncCtxForTopic(
        'bulkAddBlocks',
        guardCtx.topicId ?? bulkOwnerRoute?.topicId ?? '',
        guardCtx.topicId !== null ? guardCtx.branchId : (bulkOwnerRoute?.branchId ?? null)
      )
      let syncNotify = false
      const unsupportedBlockIds: string[] = []

      try {
        this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Check for duplicate IDs in the batch
          const seenIds = new Set<string>()
          for (const block of blockDataList) {
            if (seenIds.has(block.id)) {
              throw new ChatDbConflictError(`Duplicate block ID in batch: ${block.id}`)
            }
            seenIds.add(block.id)
          }

          // Route immutability: blocks under inherited/shared parents
          // reject (no copy-on-write); missing parents keep existing behavior.
          {
            const dbForBulkGuard = tx as unknown as BetterSQLite3Database<typeof schema>
            for (const block of blockDataList) {
              this.assertMutableBlockInTx(
                repos,
                dbForBulkGuard,
                guardCtx.topicId,
                guardCtx.branchId,
                block.id,
                block.messageId
              )
            }
          }

          // Insert only (not upsert) — createMany will throw on existing IDs
          repos.blocks.createMany(blockDataList)

          // Sync file references
          this.syncFileReferences(repos, blockDataList)

          // Transaction-bound sync intent: stable creations only
          // (LOCK-PERSONAL-004) with per-block ordering offsets. Transient
          // blocks are legitimate skips; unsupported structured/attachment
          // blocks skip without a partial shell; their stable update later
          // records the same durable unsupported outcome with parent closure.
          if (syncCtx) {
            for (let i = 0; i < blockDataList.length; i++) {
              const bid = blockDataList[i].id
              const childTs = syncCtx.ts + i
              const brow = repos.blocks.getById(bid)
              if (!brow.found) throw new Error(`bulkAddBlocks block ${bid} missing in transaction`)
              // F3 fail-closed: branch-owned or owner-unknown blocks never
              // emit sync intent (outbox/membership/frames); the insert above
              // still commits.
              if (
                this.isBlockSyncSuppressedInTx(
                  repos,
                  tx as unknown as BetterSQLite3Database<typeof schema>,
                  bid,
                  blockDataList[i].messageId
                )
              ) {
                continue
              }
              if (!isStableBlockStatus(brow.data.status)) continue
              if (this.isUnsupportedBlock(brow.data)) {
                unsupportedBlockIds.push(bid)
                continue
              }
              // Resend intent (SYNC-DATA-055): stale attempt throws (rolls
              // back); a covered parent stays local-only (before closure).
              if (this.checkResendAttemptInTx(stx, brow.data.messageId, resendAttemptId)) continue
              this.ensureBlockParentClosureInTx(stx, bid, childTs, syncCtx.deviceId)
              const opId = syncService.enqueueUpsertInTx(
                stx,
                'message_block',
                bid,
                this.syncBlockPayloadFull(brow.data),
                childTs,
                syncCtx.deviceId
              )
              syncService.setMembershipClockInTx(stx, 'message_block', bid, brow.data.messageId, childTs, opId)
              syncNotify = true
            }
          }
          // Ordinary bulk stable-supported creates issue exactly one
          // messageBlock frame per affected stable parent via the try helper
          // (missing membership invalidates with 0 op while the user mutation
          // succeeds; malformed/MAX_SAFE rolls back). Resend-covered parents
          // (SYNC-DATA-055) stay local-only.
          if (syncCtx) {
            const affectedParents = new Set<string>()
            for (const b of blockDataList) {
              const brow = repos.blocks.getById(b.id)
              // F3 fail-closed: suppressed (branch-owned/unknown) blocks mint
              // no frame intent either.
              if (
                this.isBlockSyncSuppressedInTx(
                  repos,
                  tx as unknown as BetterSQLite3Database<typeof schema>,
                  b.id,
                  b.messageId
                )
              ) {
                continue
              }
              if (brow.found && isStableBlockStatus(brow.data.status) && !this.isUnsupportedBlock(brow.data)) {
                affectedParents.add(brow.data.messageId)
              }
            }
            for (const pid of affectedParents) {
              if (getResendAttemptInTx(stx, pid)) continue
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, pid, syncCtx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('bulkAddBlocks', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('bulkAddBlocks', unsupportedBlockIds)

      return null
    }, `bulkAddBlocks(${blocksJson.length} blocks)`)
  }

  /**
   * Delete blocks by IDs. Missing: no-op.
   *
   * Atomicity: one root transaction. FK cascade handles file_references
   * cleanup (file_references.blockId → messageBlocks.id ON DELETE CASCADE).
   * No pre-transaction destructive reference deletes.
   * Normalize affected message block order via repository.
   * Known-entity deletes enqueue intent atomically in the same tx.
   */
  deleteBlocks(blockIds: string[], options?: BlockRouteContext): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const guardCtx = this.blockGuardContext(options)
      const deleteOwnerRoute = this.resolveBlockOwnerRouteByIds(blockIds)
      const syncCtx = this.syncCtxForTopic(
        'deleteBlocks',
        guardCtx.topicId ?? deleteOwnerRoute?.topicId ?? '',
        guardCtx.topicId !== null ? guardCtx.branchId : (deleteOwnerRoute?.branchId ?? null)
      )
      let syncNotify = false
      let result: FileCleanupResult
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const knownIds = syncCtx
            ? blockIds.filter(
                (bid) =>
                  typeof bid === 'string' && bid.length > 0 && syncService.isKnownEntityInTx(stx, 'message_block', bid)
              )
            : []
          // F3 fail-closed: branch-owned (or owner-unprovable) blocks present
          // pre-delete never emit a remote delete and mint no frame intent.
          // Row-missing ids keep the existing known-entity gate (nothing to
          // prove an owner from).
          const suppressedDeleteIds = new Set<string>()
          if (syncCtx) {
            const dbForDeleteGate = tx as unknown as BetterSQLite3Database<typeof schema>
            for (const bid of blockIds) {
              if (typeof bid !== 'string' || bid.length === 0) continue
              const blk = repos.blocks.getById(bid)
              if (!blk.found) continue
              if (this.isBlockSyncSuppressedInTx(repos, dbForDeleteGate, bid, blk.data.messageId)) {
                suppressedDeleteIds.add(bid)
              }
            }
          }
          // Collect affected parent messageIds before deletion, but only when
          // the deleted row was previously inventory-included
          // (stable + supported). Transient/unsupported deletes never mint:
          // they only invalidate via the try helper's excluded check.
          const affectedParentIds = new Set<string>()
          // Route immutability: deleting blocks under shared parents
          // rejects; missing rows keep existing no-op semantics.
          {
            const dbForDeleteBlockGuard = tx as unknown as BetterSQLite3Database<typeof schema>
            for (const bid of blockIds) {
              this.assertMutableBlockInTx(repos, dbForDeleteBlockGuard, guardCtx.topicId, guardCtx.branchId, bid)
            }
          }
          for (const bid of blockIds) {
            if (suppressedDeleteIds.has(bid)) continue
            const blk = repos.blocks.getById(bid)
            if (blk.found && isStableBlockStatus(blk.data.status) && !this.isUnsupportedBlock(blk.data)) {
              affectedParentIds.add(blk.data.messageId)
            }
          }
          const affectedFileIds = collectAffectedFileIds(
            blockIds.flatMap((blockId) => repos.fileRefs.listByBlock(blockId))
          )
          // blocks.deleteMany handles order normalization within its own
          // savepoint transaction. FK cascade removes file_references.
          repos.blocks.deleteMany(blockIds)
          if (syncCtx) {
            for (const bid of knownIds) {
              if (suppressedDeleteIds.has(bid)) continue
              if (repos.blocks.getById(bid).found) continue // surviving row = no-op, never a remote delete
              syncService.enqueueDeleteInTx(stx, 'message_block', bid, syncCtx.ts, syncCtx.deviceId)
              syncNotify = true
            }
          }
          // Ordinary block deletes issue exactly one messageBlock frame per
          // surviving stable parent via the try helper (missing membership
          // invalidates with 0 op; malformed/MAX_SAFE rolls back). Deleted
          // parent or transient parent only invalidates.
          if (syncCtx && affectedParentIds.size > 0) {
            for (const pid of affectedParentIds) {
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, pid, syncCtx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          }
          return buildFileCleanupResult(repos, affectedFileIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteBlocks', syncCtx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      return result
    }, `deleteBlocks(${blockIds.length} blocks)`)
  }

  // =========================================================================
  // Phase 5.1A: Segment commands
  // =========================================================================

  /**
   * List all segments for a topic with ordered messageIds.
   * Each segment's messageIds are reconstructed from topic_segment_messages sort_order.
   *
   * The catalog is topic-level and route-independent: membership stays the
   * complete authoritative membership so it can be cached as authority.
   * Every group always carries its persisted head identity and the owner Main
   * resolves from that head row.
   *
   * `branchId` optionally adds a ROUTE QUALIFICATION without touching the
   * catalog: absent = no qualification (an explicit `null` qualifies the main
   * route). A route-scoped caller must ask for this instead of inferring route
   * membership from its own loaded projection.
   */
  listSegments(topicId: string, branchId?: string | null): ChatDbResult<SegmentWire[]> {
    return wrapResult(() => {
      const repos = this.repos()
      const qualified = branchId !== undefined
      const route = qualified ? this.normalizeBranchId(branchId) : null
      const routeMessageIdsInOrder = qualified
        ? this.resolveRouteMessagesInTx(repos, topicId, route).messages.map((message) => message.id)
        : null
      const routeMessageIds = routeMessageIdsInOrder ? new Set(routeMessageIdsInOrder) : null
      const segments = repos.segments.listByTopic(topicId)
      return segments.map((segment) => {
        const messageIds = repos.segments.getMessageIds(segment.id)
        const header = this.resolveSegmentHeader(repos, segment, messageIds)
        const wire = segmentToWire(segment, messageIds, header)
        if (!routeMessageIds) return wire
        const memberSet = new Set(messageIds)
        return {
          ...wire,
          route: {
            topicId,
            branchId: route,
            headerInRoute: header.headerMessageId !== null && routeMessageIds.has(header.headerMessageId),
            headerOwnedByRoute:
              header.headerMessageId !== null && header.ownerTopicId === topicId && header.ownerBranchId === route,
            // Members on the addressed route in ROUTE-effective order (not
            // catalog order): the window co-commit projection filters this
            // same order and the hook intersects it, so acceptance is
            // byte-identical and a residual group's stable start never moves.
            routeMemberMessageIds: (routeMessageIdsInOrder ?? []).filter((id) => memberSet.has(id))
          }
        }
      })
    }, `listSegments(${topicId})`)
  }

  /**
   * Effective head identity of one group, resolved from authority rows.
   *
   * The persisted `header_message_id` is the group's identity and stays put
   * through every membership change. It is only replaced when the head row
   * itself left the group (removed from membership, or deleted with its
   * message): the head then repairs deterministically to the group's first
   * surviving member in authoritative membership order. A group with no
   * members has no head at all. Nothing here is derived from a renderer
   * window, and a read never writes the repair back.
   *
   * The owner triple is resolved from the head ROW (never from the caller's
   * route), because that is what group metadata authority is compared against.
   */
  private resolveSegmentHeader(
    repos: ChatDbRepositories,
    segment: TopicSegmentData,
    messageIds: string[]
  ): { headerMessageId: string | null; ownerTopicId: string; ownerBranchId: string | null } {
    const persisted = segment.headerMessageId ?? null
    const effective = persisted !== null && messageIds.includes(persisted) ? persisted : (messageIds[0] ?? null)
    const row = effective === null ? null : repos.messages.getById(effective)
    if (effective === null || !row || !row.found) {
      // No resolvable head: either the group has no members (no identity yet)
      // or the resolved member row is gone. Report the group's own topic so the
      // wire stays typed and truthful instead of guessing an owner.
      return { headerMessageId: null, ownerTopicId: segment.topicId, ownerBranchId: null }
    }
    return { headerMessageId: effective, ownerTopicId: row.data.topicId, ownerBranchId: row.data.branchId ?? null }
  }

  /**
   * Group metadata/membership authority: a group belongs to the route that
   * owns its head message (owner equality compares topic id AND branch id).
   * Any other route may read and navigate the group, never rename, delete or
   * re-member it — that is the same non-owner fail-closed rule every other
   * mutation path applies, with zero writes.
   *
   * A group with no resolvable head fails closed too: without a head row
   * there is no owner to compare, so the mutation must never pass by default.
   * Missing groups keep their existing no-op/NOT_FOUND semantics at the call
   * sites, and empty memberships dissolve on the membership-write paths.
   */
  private assertSegmentOwnerInTx(
    repos: ChatDbRepositories,
    segment: TopicSegmentData,
    messageIds: string[],
    branchId: string | null | undefined
  ): void {
    const header = this.resolveSegmentHeader(repos, segment, messageIds)
    const route = this.normalizeBranchId(branchId)
    if (header.headerMessageId === null) {
      throw new ChatDbValidationError(`Message group ${segment.id} has no resolvable head and cannot be changed here`)
    }
    if (!isOwnedByRoute(header.ownerTopicId, header.ownerBranchId, segment.topicId, route)) {
      throw new ChatDbValidationError(`Message group ${segment.id} belongs to another route and cannot be changed here`)
    }
  }

  /**
   * Atomically upsert a segment with metadata and ordered membership.
   * - Creates segment if absent, updates metadata if present.
   * - Replaces message membership atomically in one transaction.
   * - Empty membership deletes the segment per repository semantics.
   */
  upsertSegment(request: UpsertSegmentRequest): ChatDbResult<SegmentWire> {
    const { segmentId, topicId, name, messageIds, color, folded } = request
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('upsertSegment')
      const route = request.branchId
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // Ensure topic exists
        repos.topics.ensure(topicId)

        // Membership authority is the group-level RANGE guard below (owner
        // equality over the addressed route): same-owner spans stay allowed
        // across untaken forks, any foreign/inherited member rejects the whole
        // command with zero writes — no per-row owner loop here.
        this.assertGroupRangeOwnedInTx(repos, topicId, route, messageIds)

        // Build segment data. Color is the only presentation state Main still
        // stores in segment overflow: group-level collapse is retired, so the
        // legacy `folded` key is never persisted here and any stale value is
        // stripped. Referencing the argument is deliberate (a no-op) — it keeps
        // the wire contract and existing call sites intact while this
        // retirement lands.
        void folded
        const overflow: Record<string, unknown> = {}
        if (color !== undefined && color !== null) {
          overflow.color = color
        }
        // The existing-row patch is a merge delta (mergeOverflow), so unrelated
        // overflow keys (foldSelected/useful) are never replaced.
        const overflowDelta: Record<string, unknown> = { ...overflow }
        overflowDelta.folded = OVERFLOW_REMOVE

        const existing = repos.segments.getById(segmentId)
        if (existing.found) {
          // Group metadata AND membership are owned by the route that owns the
          // head message: a non-owner route reads/navigates the group but its
          // rename/re-member rejects here with zero writes.
          this.assertSegmentOwnerInTx(repos, existing.data, repos.segments.getMessageIds(segmentId), route)
          // Update metadata
          const patch: Record<string, unknown> = {}
          if (name !== undefined) patch.name = name
          if (Object.keys(overflowDelta).length > 0) patch.overflow = overflowDelta
          if (Object.keys(patch).length > 0) {
            repos.segments.updateMetadata(segmentId, patch as any)
          }
        } else {
          if (messageIds.length === 0) {
            // New segment with empty membership must not survive: no phantom
            // row. Return the empty authority wire directly (topic ensured).
            const emptyNew = {
              id: segmentId,
              topicId,
              name: name ?? null,
              messageIds: [] as string[],
              // A group that was never created has no head identity.
              headerMessageId: null as string | null,
              ownerTopicId: topicId,
              ownerBranchId: route,
              createdAt: null as string | null,
              updatedAt: null as string | null,
              sortOrder: 0,
              firstMessageId: null as string | null,
              lastMessageId: null as string | null,
              messageCount: 0
            }
            if (typeof color === 'string') {
              return { ...emptyNew, color }
            }
            return emptyNew
          }
          // Deterministic conversation-position placement: insert the new
          // segment according to its authority first message position in the
          // addressed route order; existing segments retain relative order.
          // No global recompute of imported/existing catalog.
          const orderedMessages = this.resolveRouteMessagesInTx(repos, topicId, route).messages
          const positionByMessageId = new Map<string, number>()
          orderedMessages.forEach((m, idx) => positionByMessageId.set(m.id, idx))
          // Same-transaction authority validation: every requested membership
          // id must belong to the complete topic authority order.
          for (const mid of messageIds) {
            if (!positionByMessageId.has(mid)) {
              throw new Error(`Message ${mid} does not belong to topic ${topicId}`)
            }
          }
          const newFirstIdx = positionByMessageId.get(messageIds[0])
          const existingCatalog = repos.segments.listByTopic(topicId)
          let targetIndex = existingCatalog.length
          if (newFirstIdx !== undefined) {
            for (let i = 0; i < existingCatalog.length; i++) {
              const seg = existingCatalog[i]
              const mids = repos.segments.getMessageIds(seg.id)
              const first = mids.length > 0 ? mids[0] : undefined
              const idx = first !== undefined ? positionByMessageId.get(first) : undefined
              const existingIdx = idx ?? Number.POSITIVE_INFINITY
              if (existingIdx > newFirstIdx) {
                targetIndex = i
                break
              }
            }
          }
          // Repository primitive shifts dense catalog atomically; avoids UUID tie order.
          repos.segments.createAtCatalogIndex(
            {
              id: segmentId,
              topicId,
              name: name ?? null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              sortOrder: targetIndex,
              headerMessageId: messageIds[0] ?? null,
              overflow
            },
            targetIndex
          )
        }

        // Replace membership atomically
        repos.segments.replaceMessageIds(segmentId, messageIds)

        // Read back the result
        const segment = repos.segments.getById(segmentId)
        if (!segment.found) {
          // Segment was deleted (empty membership) — return empty wire.
          // Same JSON-safety rule as segmentToWire: omit `color` unless it
          // is a legal string (never `color: undefined`). Authority empty
          // consistency is null/null/0 with a deterministic 0 sortOrder.
          const emptyBase = {
            id: segmentId,
            topicId,
            name: name ?? null,
            messageIds: [] as string[],
            // Empty membership deleted the group, so it has no head anymore.
            headerMessageId: null as string | null,
            ownerTopicId: topicId,
            ownerBranchId: route,
            createdAt: null as string | null,
            updatedAt: null as string | null,
            sortOrder: 0,
            firstMessageId: null as string | null,
            lastMessageId: null as string | null,
            messageCount: 0
          }
          if (typeof color === 'string') {
            return { ...emptyBase, color }
          }
          return emptyBase
        }

        const finalMessageIds = repos.segments.getMessageIds(segmentId)
        return segmentToWire(
          segment.data,
          finalMessageIds,
          this.resolveSegmentHeader(repos, segment.data, finalMessageIds)
        )
      })
    }, `upsertSegment(${segmentId}, ${topicId})`)
  }

  /**
   * Update segment metadata (name, color). No membership change and no
   * collapse state: the group-level `folded` argument is accepted only for wire
   * compatibility and is never persisted — a stale persisted marker is stripped
   * on every write, so a retired group label can never come back.
   *
   * Group metadata authority: the requester route must be the group head's
   * owner (`request.branchId`: null = main route). Another route may read and
   * navigate the group but never rename it; that mutation fails closed with no
   * writes.
   *
   * Missing segment: throws ChatDbNotFoundError → ERR_NOT_FOUND.
   * Returns the updated segment wire.
   */
  updateSegmentMetadata(request: UpdateSegmentMetadataRequest): ChatDbResult<SegmentWire> {
    const { segmentId, name, color, folded, branchId } = request
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('updateSegmentMetadata')
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const existing = repos.segments.getById(segmentId)
        if (!existing.found) {
          throw new ChatDbNotFoundError(`Segment ${segmentId} does not exist`)
        }
        // Group collapse is retired, so `folded` is no longer a context gate;
        // group identity/ownership still is: metadata belongs to the head's
        // owner route. Referencing `folded` is deliberate (a no-op) and keeps
        // the wire contract unchanged.
        void folded
        this.assertSegmentOwnerInTx(repos, existing.data, repos.segments.getMessageIds(segmentId), branchId)

        const patch: Record<string, unknown> = {}
        if (name !== undefined) patch.name = name
        // Overflow is a merge delta (mergeOverflow), so a partial metadata write
        // never replaces unrelated existing overflow keys.
        const overflowDelta: Record<string, unknown> = {}
        if (color !== undefined) overflowDelta.color = color
        // Retired marker: always stripped, never written back as a boolean.
        overflowDelta.folded = OVERFLOW_REMOVE

        if (Object.keys(overflowDelta).length > 0) patch.overflow = overflowDelta
        if (Object.keys(patch).length > 0) {
          repos.segments.updateMetadata(segmentId, patch as any)
        }

        // Read back
        const updated = repos.segments.getById(segmentId)
        if (!updated.found) {
          // Defensive: segment was deleted between getById and updateMetadata
          // within the same operation. Should not happen in practice.
          throw new ChatDbNotFoundError(`Segment ${segmentId} was deleted during update`)
        }
        const messageIds = repos.segments.getMessageIds(segmentId)
        return segmentToWire(updated.data, messageIds, this.resolveSegmentHeader(repos, updated.data, messageIds))
      })
    }, `updateSegmentMetadata(${segmentId})`)
  }

  /**
   * Delete a segment. Missing: no-op.
   *
   * Group metadata authority: only the route that owns the group head may
   * delete the group (`request.branchId`: null = main route). Another route may
   * read and navigate it; its delete fails closed with no writes.
   */
  deleteSegment(request: DeleteSegmentRequest): ChatDbResult<null> {
    const { segmentId, branchId } = request
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('deleteSegment')
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const existing = repos.segments.getById(segmentId)
        if (existing.found) {
          this.assertSegmentOwnerInTx(repos, existing.data, repos.segments.getMessageIds(segmentId), branchId)
          repos.segments.delete(segmentId)
        }
        return null
      })
    }, `deleteSegment(${segmentId})`)
  }

  /**
   * Replace segment message IDs atomically.
   * Empty membership deletes the segment per repository semantics.
   * Returns the updated segment wire, or null if segment was deleted.
   *
   * Two authorities apply, in this order, before any write: the group's
   * existing head owner must be the addressed route (a non-owner route may
   * read and navigate the group but never re-member it), and every requested
   * member must be owned by the addressed route. Membership changes never move
   * the group head; only the head leaving the group repairs it.
   */
  replaceSegmentMembership(request: ReplaceSegmentMembershipRequest): ChatDbResult<SegmentWire | null> {
    const { segmentId, messageIds, branchId } = request
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('replaceSegmentMembership')
      const route = branchId
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const segment = repos.segments.getById(segmentId)
        // Membership authority is the head-owner check plus the group-level
        // RANGE guard (owner equality over the addressed route): same-owner
        // spans stay allowed across untaken forks, any foreign/inherited row
        // rejects with zero writes — no per-row owner loop here. Empty
        // membership keeps its delete semantics below.
        if (segment.found) {
          this.assertSegmentOwnerInTx(repos, segment.data, repos.segments.getMessageIds(segmentId), route)
          this.assertGroupRangeOwnedInTx(repos, segment.data.topicId, route, messageIds)
        }
        repos.segments.replaceMessageIds(segmentId, messageIds)

        const updated = repos.segments.getById(segmentId)
        if (!updated.found) return null

        const finalMessageIds = repos.segments.getMessageIds(segmentId)
        return segmentToWire(
          updated.data,
          finalMessageIds,
          this.resolveSegmentHeader(repos, updated.data, finalMessageIds)
        )
      })
    }, `replaceSegmentMembership(${segmentId})`)
  }

  // =========================================================================
  // Phase 5.1A: Message reorder
  // =========================================================================

  /**
   * Reorder all messages in a topic atomically.
   * Validates exact membership and dense order via repository.
   * Unsupported structural path (010): truthful invalidation inside same transaction — delete stale
   * topicMessage frame rather than leave stale valid-looking state. Do not mint clocks or outbox.
   */
  reorderMessages(topicId: string, messageIds: string[], branchId?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('reorderMessages', topicId, route)
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          // BRANCH-4 owner equality only: every reordered ID must be owned
          // by the addressed route. Owned rows stay reorderable even when
          // referenced by live descendants (butterfly effect).
          {
            const dbForReorderGuard = tx as unknown as BetterSQLite3Database<typeof schema>
            for (const id of messageIds) {
              this.assertMutableMessageInTx(repos, dbForReorderGuard, topicId, route, id)
            }
          }
          repos.messages.replaceOrder(topicId, messageIds, route)
          // Incremental order_frame issuance (SYNC-DATA-048): with complete
          // stored membership, mint/persist the winning frame and enqueue the
          // matching order_frame reusing that clock (same tx). With missing
          // membership, truthfully invalidate without any op and keep the
          // user reorder successful (existing tryRefreshOrInvalidate semantics).
          if (ctx) {
            const outcome = syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(
              tx as unknown as SyncTxExecutor,
              topicId,
              ctx.deviceId
            )
            if (outcome === 'refreshed') notify = true
          } else {
            syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'topicMessage', topicId)
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('reorderMessages', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `reorderMessages(${topicId})`)
  }

  /**
   * Additive semantic answer-group reorder (authority slots permutation).
   *
   * ONE root better-sqlite3 transaction resolves AND persists the reorder
   * from the anchor + desired group order alone:
   * 1. Topic must exist; anchor must belong to topic, role assistant,
   *    non-empty askId — otherwise NOT_FOUND fail-closed.
   * 2. Resolve the complete group: same-topic assistant messages with equal
   *    askId in listByTopic order (sort_order ASC, id ASC).
   * 3. Request orderedMessageIds must be a non-empty exact set/length match
   *    of the complete group with no duplicates and must contain the anchor —
   *    otherwise CONFLICT/NOT_FOUND fail-closed. Identical order is a no-op
   *    success.
   * 4. Permute only the authority slots occupied by the group: locate group
   *    member positions in the complete topic order, place ordered IDs in
   *    sequence, keep every other message in place; persist the complete
   *    topic order via the existing `replaceOrder`.
   * 5. Same-tx topicMessage order-frame refresh/invalidate + notify semantics
   *    as `reorderMessages`. No schema change. Returns the final complete
   *    answer-group order (no content/blocks).
   */
  reorderAnswerGroup(
    topicId: string,
    anchorMessageId: string,
    orderedMessageIds: string[],
    branchId?: string | null
  ): ChatDbResult<ReorderAnswerGroupResponse> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('reorderAnswerGroup', topicId, route)
      let notify = false
      let result: ReorderAnswerGroupResponse
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }
          const allMessages = this.resolveRouteMessagesInTx(repos, topicId, route).messages
          const anchor = allMessages.find((m) => m.id === anchorMessageId)
          if (!anchor) {
            throw new ChatDbNotFoundError(`Message ${anchorMessageId} does not belong to topic ${topicId}`)
          }
          const askId = anchor.askId
          if (anchor.role !== 'assistant' || typeof askId !== 'string' || askId.length === 0) {
            throw new ChatDbNotFoundError(`Message ${anchorMessageId} has no actionable answer group`)
          }
          const groupIds = allMessages.filter((m) => m.role === 'assistant' && m.askId === askId).map((m) => m.id)
          if (groupIds.length === 0 || !groupIds.includes(anchorMessageId)) {
            throw new ChatDbNotFoundError(`Message ${anchorMessageId} has no actionable answer group`)
          }
          if (!Array.isArray(orderedMessageIds) || orderedMessageIds.length === 0) {
            throw new ChatDbConflictError('orderedMessageIds must not be empty')
          }
          const seen = new Set<string>()
          for (const id of orderedMessageIds) {
            if (typeof id !== 'string' || id.length === 0) {
              throw new ChatDbConflictError('orderedMessageIds must contain only non-empty strings')
            }
            if (seen.has(id)) {
              throw new ChatDbConflictError(`Duplicate message ID in orderedMessageIds: ${id}`)
            }
            seen.add(id)
          }
          if (!seen.has(anchorMessageId)) {
            throw new ChatDbNotFoundError(`Anchor ${anchorMessageId} must appear in orderedMessageIds`)
          }
          if (orderedMessageIds.length !== groupIds.length) {
            throw new ChatDbConflictError(
              `Incomplete answer group: expected ${groupIds.length}, got ${orderedMessageIds.length}`
            )
          }
          const groupSet = new Set(groupIds)
          // BRANCH-4/11 owner equality only: answer groups with non-owned
          // members reject (slots cannot permute across route owners
          // without mutating read-only references). Reading the user root
          // never blocks. Slot permutation persists within the addressed
          // route owner's rows only; descendants observe the butterfly
          // effect without constraining the owner.
          const dbForAnswerGuard = tx as unknown as BetterSQLite3Database<typeof schema>
          const resolvedGroup = this.assertAnswerGroupMutableInTx(
            repos,
            dbForAnswerGuard,
            topicId,
            route,
            askId,
            allMessages
          )
          if (resolvedGroup.length !== groupIds.length || !resolvedGroup.every((id) => groupSet.has(id))) {
            throw new ChatDbConflictError('Answer-group slot resolution mismatch')
          }
          for (const id of orderedMessageIds) {
            if (!groupSet.has(id)) {
              // Cross-topic/foreign-sourced IDs surface here: not a group member.
              throw new ChatDbNotFoundError(`Message ${id} does not belong to the answer group`)
            }
            const owned = repos.messages.getInTopic(id, topicId)
            if (!owned.found || (owned.data.branchId ?? null) !== route) {
              throw new ChatDbNotFoundError(`Message ${id} does not belong to topic ${topicId}`)
            }
          }
          const ownerRows = repos.messages.listByTopic(topicId, route)
          const ownerOrder = ownerRows.map((m) => m.id)
          const groupPositions: number[] = []
          for (let i = 0; i < ownerOrder.length; i++) {
            if (groupSet.has(ownerOrder[i])) groupPositions.push(i)
          }
          if (groupPositions.length !== groupIds.length) {
            throw new ChatDbConflictError('Answer-group slot resolution mismatch')
          }
          const nextOwnerOrder = [...ownerOrder]
          for (let i = 0; i < groupPositions.length; i++) {
            nextOwnerOrder[groupPositions[i]] = orderedMessageIds[i]
          }
          repos.messages.replaceOrder(topicId, nextOwnerOrder, route)
          if (ctx) {
            const outcome = syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(
              tx as unknown as SyncTxExecutor,
              topicId,
              ctx.deviceId
            )
            if (outcome === 'refreshed') notify = true
          } else {
            syncService.invalidateParentFrameInTx(tx as unknown as SyncTxExecutor, 'topicMessage', topicId)
          }
          return {
            topicId,
            askId,
            anchorMessageId,
            orderedMessageIds: [...orderedMessageIds]
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('reorderAnswerGroup', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `reorderAnswerGroup(${topicId})`)
  }

  // =========================================================================
  // Phase 5.1A: File reference queries (read-only)
  // =========================================================================

  /**
   * List file references by file ID. Read-only.
   */
  listFileRefsByFile(fileId: string): ChatDbResult<FileReferenceWire[]> {
    return wrapResult(() => {
      const { fileRefs } = this.repos()
      const refs = fileRefs.listByFile(fileId)
      return refs.map(fileReferenceToWire)
    }, `listFileRefsByFile(${fileId})`)
  }

  /**
   * Count file references by file ID. Read-only.
   */
  countFileRefsByFile(fileId: string): ChatDbResult<number> {
    return wrapResult(() => {
      const { fileRefs } = this.repos()
      return fileRefs.countByFile(fileId)
    }, `countFileRefsByFile(${fileId})`)
  }

  /**
   * List blocks associated with a file via file_references. Read-only.
   */
  listBlocksByFile(fileId: string): ChatDbResult<JsonObject[]> {
    return wrapResult(() => {
      const repos = this.repos()
      const blocks = repos.blocks.findByFileId(fileId)
      return blocksToWire(blocks)
    }, `listBlocksByFile(${fileId})`)
  }

  // =========================================================================
  // Phase 5.1B: Topic lifecycle
  // =========================================================================

  /**
   * Update topic metadata. Mutable fields: name (column), pinned/prompt/
   * isNameManuallyEdited (overflow). updatedAt is maintained consistently.
   * Identity fields (id, assistantId, createdAt, deletedAt, messages) are
   * NOT mutable through this path.
   *
   * Optional atomic preimage guards (automatic naming only): when
   * expectedName / expectedIsNameManuallyEdited are defined, the current
   * authority values are compared inside the same transaction; on mismatch
   * the current wire is returned unchanged (graceful no-op, no write, no
   * sync intent, no updatedAt bump). Missing topic still throws NOT_FOUND.
   *
   * Returns ERR_NOT_FOUND if topic does not exist.
   */
  updateTopicMetadata(
    topicId: string,
    name?: string | null,
    pinned?: boolean | null,
    prompt?: string | null,
    isNameManuallyEdited?: boolean | null,
    expectedName?: string | null,
    expectedIsNameManuallyEdited?: boolean | null
  ): ChatDbResult<JsonObject> {
    return wrapResult(() => {
      const ctx = this.syncCtxForTopic('updateTopicMetadata', topicId)
      let notify = false
      let result: JsonObject
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          const existing = repos.topics.getById(topicId)
          if (!existing.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }

          // Bounded atomic preimage guard for automatic naming: compare inside
          // the same transaction; mismatch returns the current wire unchanged.
          if (expectedName !== undefined) {
            const currentName = (existing.data as { name?: string | null }).name ?? null
            const wantName = expectedName ?? null
            if (currentName !== wantName) {
              return topicToWireFull(existing.data)
            }
          }
          if (expectedIsNameManuallyEdited !== undefined) {
            const raw = (existing.data.overflow as Record<string, unknown> | undefined)?.isNameManuallyEdited
            const currentFlag = typeof raw === 'boolean' ? raw : null
            const wantFlag = expectedIsNameManuallyEdited ?? null
            if (currentFlag !== wantFlag) {
              return topicToWireFull(existing.data)
            }
          }

          // Build patch from allowed fields
          const patch: Record<string, unknown> = {}
          if (name !== undefined) patch.name = name
          if (pinned !== undefined) patch.pinned = pinned
          if (prompt !== undefined) patch.prompt = prompt
          if (isNameManuallyEdited !== undefined) patch.isNameManuallyEdited = isNameManuallyEdited

          if (Object.keys(patch).length === 0) {
            // No-op: return current state
            return topicToWireFull(existing.data)
          }

          // Maintain updatedAt consistently
          patch.updatedAt = new Date().toISOString()

          // Split into columns vs overflow
          const domainPatch: Record<string, unknown> = {}
          const overflowDelta: Record<string, unknown> = {}

          if ('name' in patch || 'updatedAt' in patch) {
            if ('name' in patch) domainPatch.name = patch.name
            domainPatch.updatedAt = patch.updatedAt
          }
          if ('pinned' in patch) overflowDelta.pinned = patch.pinned
          if ('prompt' in patch) overflowDelta.prompt = patch.prompt
          if ('isNameManuallyEdited' in patch) overflowDelta.isNameManuallyEdited = patch.isNameManuallyEdited

          // Merge overflow into existing topic
          const mergedOverflow = { ...existing.data.overflow, ...overflowDelta }
          // Remove keys with OVERFLOW_REMOVE sentinel
          for (const [k, v] of Object.entries(overflowDelta)) {
            if (v === undefined) delete mergedOverflow[k]
          }

          repos.topics.updatePatch(topicId, {
            ...domainPatch,
            overflow: mergedOverflow
          } as any)

          // Read back
          const updated = repos.topics.getById(topicId)
          if (!updated.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} was deleted during update`)
          }
          // Transaction-bound sync intent: intentional patch keys only.
          if (ctx) {
            const payload: Record<string, unknown> = { id: topicId }
            for (const k of Object.keys(patch)) {
              if (
                k === 'name' ||
                k === 'pinned' ||
                k === 'prompt' ||
                k === 'isNameManuallyEdited' ||
                k === 'updatedAt'
              ) {
                const v = patch[k]
                if (v !== undefined) payload[k] = v
              }
            }
            syncService.enqueueUpsertInTx(stx, 'topic', topicId, payload, ctx.ts, ctx.deviceId)
            notify = true
          }
          return topicToWireFull(updated.data)
        })
      } catch (e) {
        this.recordSyncTxFailure('updateTopicMetadata', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `updateTopicMetadata(${topicId})`)
  }

  /**
   * Soft-delete one logical topic by setting deletedAt. Topic delete is one
   * logical operation covering all branches/messages by topic cascade —
   * branches never appear in trash independently.
   * Missing topic: no-op (returns success). Intent commits atomically.
   */
  softDeleteTopic(topicId: string, name?: string | null): ChatDbResult<null> {
    return wrapResult(() => {
      const ctx = this.syncCtxForTopic('softDeleteTopic', topicId)
      let notify = false
      let result: null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const before = repos.topics.getById(topicId)
          repos.topics.softDelete(topicId, name)
          if (ctx && before.found) {
            const after = repos.topics.getById(topicId)
            if (after.found && after.data.deletedAt != null) {
              const payload: Record<string, unknown> = { id: topicId, deletedAt: after.data.deletedAt }
              if (name !== undefined) payload.name = after.data.name
              syncService.enqueueUpsertInTx(stx, 'topic', topicId, payload, ctx.ts, ctx.deviceId)
              notify = true
            }
          }
          return null
        })
      } catch (e) {
        this.recordSyncTxFailure('softDeleteTopic', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `softDeleteTopic(${topicId})`)
  }

  /**
   * Atomically restore a soft-deleted logical topic and return the restored
   * wire entity (LOCK-532). One logical restore covers the whole topic
   * (branches included, by cascade — branches never restore independently).
   * Returns null when no soft-deleted row exists for the
   * ID at command time (missing topic, or topic not in trash) — in that
   * case NO mutation occurs. Callers must dispatch only the returned row,
   * never a separately listed snapshot. Intent commits atomically.
   */
  restoreTopic(topicId: string): ChatDbResult<JsonObject | null> {
    return wrapResult(() => {
      const ctx = this.syncCtxForTopic('restoreTopic', topicId)
      let notify = false
      let result: JsonObject | null
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          const existing = repos.topics.getById(topicId)
          if (!existing.found || existing.data.deletedAt == null) {
            // No deleted row was restored — explicit null, no mutation.
            return null
          }

          repos.topics.restore(topicId)

          const restored = repos.topics.getById(topicId)
          if (!restored.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} disappeared during restore`)
          }
          if (ctx) {
            // Explicit null deletedAt is intent to clear (payload-key semantics).
            syncService.enqueueUpsertInTx(stx, 'topic', topicId, { id: topicId, deletedAt: null }, ctx.ts, ctx.deviceId)
            notify = true
          }
          return topicToWireFull(restored.data)
        })
      } catch (e) {
        this.recordSyncTxFailure('restoreTopic', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `restoreTopic(${topicId})`)
  }

  /**
   * List soft-deleted topics with optional assistant filter.
   * DeletedAt descending with deterministic tie-break (id ascending).
   * Returns paginated result.
   */
  listTrashTopics(
    assistantId?: string,
    limit?: number,
    cursor?: string
  ): ChatDbResult<{ items: JsonObject[]; nextCursor?: string; hasMore: boolean }> {
    return wrapResult(() => {
      const { topics } = this.repos()
      const page = topics.listTrashPage(
        { limit: limit ?? 20, direction: 'desc', cursor },
        assistantId ? { assistantId } : undefined
      )
      return {
        items: page.items.map(topicToWireFull),
        // Omit nextCursor entirely on the last page: `undefined` is not a
        // valid JSON wire value and fails result envelope validation.
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
        hasMore: page.hasMore
      }
    }, `listTrashTopics()`)
  }

  /**
   * Hard-delete one logical topic with full FK cascade (messages →
   * blocks → file_references, segments → memberships, branches → owned
   * messages). Topic delete is one logical operation covering all
   * branches/messages by topic cascade. One transaction; file cleanup
   * preserves bytes still referenced by other live rows. Sync tombstone
   * enqueues for the known topic. Returns file cleanup facts.
   *
   * Uses root transaction: collect affected file IDs before cascade,
   * then delete the topic, then compute remaining counts.
   *
   * Missing topic: no-op with empty cleanup result.
   */
  hardDeleteTopic(topicId: string): ChatDbResult<HardDeleteTopicResponse> {
    return wrapResult(() => {
      // LOCK-004: exact deleted topic IDs are collected inside the transaction.
      const deletedTopicIds: string[] = []
      const ctx = this.syncCtxForTopic('hardDeleteTopic', topicId)
      let syncNotify = false
      let cleanup: { affectedFileIds: string[]; remainingReferenceCounts: Record<string, number> }
      try {
        cleanup = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Check topic exists
          const existing = repos.topics.getById(topicId)
          if (!existing.found) {
            return { affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: [] }
          }
          const known = ctx ? syncService.isKnownEntityInTx(stx, 'topic', topicId) : false
          deletedTopicIds.push(topicId)

          // Collect affected file IDs and message IDs before cascade for
          // frame invalidation — across ALL route owners of the topic.
          const messages = repos.messages.listAllByTopic(topicId)
          const messageIds = messages.map((m) => m.id)
          const refsBeforeDelete = repos.fileRefs.listByMessages(messageIds)
          const allAffectedFileIds = collectAffectedFileIds(refsBeforeDelete)

          // Local parent order frame (010): atomically invalidate topicMessage frame plus every messageBlock frame before cascade.
          // Collect message IDs before cascade and invalidate frames inside same transaction, no clock mint.
          for (const mid of messageIds) {
            syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
          }
          syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)

          // FK cascade: topic → messages → blocks → file_references;
          // topic → topic_segments → topic_segment_messages;
          // topic → topic_branches → owned messages (branch_id CASCADE).
          repos.topics.hardDelete(topicId)
          // Resend intent (SYNC-DATA-055): the wiped topic carries no
          // unfinished attempt — clear in the same transaction.
          clearResendAttemptsForTopicInTx(stx, topicId)

          // Transaction-bound sync intent: hard-delete tombstone in the same
          // atomic boundary (known entities only — unknown ids never emit).
          if (ctx && known) {
            syncService.enqueueDeleteInTx(stx, 'topic', topicId, ctx.ts, ctx.deviceId)
            syncNotify = true
          }

          // Compute remaining counts after cascade
          return buildFileCleanupResult(repos, allAffectedFileIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('hardDeleteTopic', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()

      // LOCK-004: clean ordinary-chat traces after the DB commit, using the
      // exact deleted topic IDs. Cleanup failure is logged and non-fatal; it
      // never changes the returned committed result. A failed transaction
      // throws before this point, so post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      return { ...cleanup, deletedTopicIds: [...deletedTopicIds] }
    }, `hardDeleteTopic(${topicId})`)
  }

  /**
   * Purge all soft-deleted topics whose effective retention start is
   * strictly earlier than the cutoff. All eligible topics are purged
   * atomically in one transaction. Returns aggregated file cleanup facts
   * across all purged topics.
   *
   * Per LOCK-5113: the cutoff is generated by the caller. No Main timer.
   *
   * L2 imported-trash retention (LOCK-TRASH-6/7/10):
   * - The effective retention start is max(parsed original deletedAt,
   *   parsed valid `l2TrashRetentionStartedAt` marker) — a fresh importer
   *   baseline gives every L2-imported soft-deleted topic a five-day
   *   recovery window from that baseline, while preserving the source
   *   deletedAt.
   * - Missing markers / L3 legacy data use deletedAt exactly as before.
   * - An invalid marker falls back to deletedAt and is counted; exactly one
   *   count-only loggerService warning is emitted after a successful purge
   *   when the count is > 0 (LOCK-TRASH-7) — never on a failed transaction,
   *   never with IDs/marker values/paths/content.
   * - All keyset pages are drained even when retained rows dominate.
   * - Parsing is fail-safe (LOCK-TRASH-10): a malformed/non-object `extra`
   *   is an invalid-marker fallback (never an abort), an unparseable
   *   deletedAt retains the topic, and an invalid cutoff rejects with the
   *   existing typed validation semantics (ERR_VALIDATION).
   * - LOCK-TRASH-13: the cutoff must be a strict canonical UTC ISO timestamp
   *   with milliseconds (identical to the shared IPC contract); a parseable
   *   but non-canonical value also rejects as ERR_VALIDATION.
   * - LOCK-PRIV-TRASH: the cutoff value never appears in the validation
   *   message, the wrapResult context, or any log — fixed static text only.
   */
  purgeExpiredTopics(cutoffTimestamp: string): ChatDbResult<PurgeExpiredTopicsResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('purgeExpiredTopics')
      // LOCK-TRASH-10/13: the cutoff is caller-generated and shared-validated
      // at the IPC boundary; a fail-safe strict parse here rejects an invalid
      // cutoff with the existing typed validation semantics. LOCK-TRASH-13:
      // the cutoff must be a strict canonical UTC ISO timestamp with
      // milliseconds — identical to the shared IPC contract — so a parseable
      // but non-canonical value (missing `.sssZ`, date-only, offset timezone)
      // also rejects as ERR_VALIDATION. LOCK-PRIV-TRASH: fixed static message
      // and context — the cutoff value NEVER appears in the validation error,
      // the wrapResult context, or any log. Epoch-ms comparison only — never
      // lexical date comparison (LOCK-TRASH-5).
      const cutoffMs = parseStrictCanonicalIsoMs(cutoffTimestamp)
      if (cutoffMs === null) {
        throw new ChatDbValidationError(
          'Invalid purge cutoff: expected a strict canonical UTC ISO timestamp with milliseconds (YYYY-MM-DDTHH:mm:ss.sssZ).'
        )
      }

      // LOCK-TRASH-7: invalid-marker count accumulated transactionally and
      // emitted (exactly one count-only warning) only after a successful
      // purge. A failed transaction rolls back and emits no warning.
      let invalidMarkerCount = 0

      // LOCK-004: exact deleted topic IDs collected inside the transaction.
      const deletedTopicIds: string[] = []

      const cleanup = this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        // List ALL deleted topics, paginating internally (LOCK-TRASH-7: the
        // drain continues past pages where retained rows dominate).
        const allAffectedFileIds: string[] = []
        let cursor: string | undefined
        let hasMore = true

        while (hasMore) {
          // LOCK-TRASH-10: narrow raw retention-page seam — id/deletedAt/extra
          // only, so malformed extra can never abort the purge.
          const page = repos.topics.listTrashRetentionPage({ limit: 100, direction: 'desc', cursor })

          for (const topic of page.items) {
            if (topic.deletedAt === null) continue

            const decision = computeTrashRetentionDecision(topic.deletedAt, topic.extra)
            // Unparseable deletedAt → retained (fail-safe, never hard-delete
            // a row whose age cannot be determined).
            if (decision === null) continue
            if (decision.invalidMarker) invalidMarkerCount += 1
            // Strictly earlier effective start required (LOCK-TRASH-6):
            // equal-to-cutoff rows are retained (matches the documented
            // `deletedAt < cutoff` semantics).
            if (decision.effectiveStartMs >= cutoffMs) continue

            // Collect affected file IDs and descendant frames before cascade
            // — across ALL route owners of the topic (branch-owned rows die
            // by cascade with the topic).
            const messages = repos.messages.listAllByTopic(topic.id)
            const messageIds = messages.map((m) => m.id)
            const refs = repos.fileRefs.listByMessages(messageIds)
            const ids = collectAffectedFileIds(refs)
            allAffectedFileIds.push(...ids)

            deletedTopicIds.push(topic.id)

            // Local frame invalidation (010): atomically invalidate topicMessage and every descendant messageBlock frame, no clock mint.
            // Sync-unaware hard-delete lifecycle path — no outbox.
            const stx = tx as unknown as SyncTxExecutor
            for (const mid of messageIds) {
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
            }
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', topic.id)

            // FK cascade: hard delete
            repos.topics.hardDelete(topic.id)
            // Resend intent (SYNC-DATA-055): the wiped topic carries no
            // unfinished attempt — clear in the same transaction.
            clearResendAttemptsForTopicInTx(stx, topic.id)
          }

          cursor = page.nextCursor
          hasMore = page.hasMore && page.items.length > 0
        }

        // Deduplicate affected file IDs and compute remaining counts
        const uniqueAffectedIds = [...new Set(allAffectedFileIds)]
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })

      // LOCK-004: clean ordinary-chat traces after the DB commit for the exact
      // purged topic IDs. Cleanup failure is logged and non-fatal; it never
      // changes the returned committed result. A failed transaction throws
      // before this point, so post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      // LOCK-TRASH-7: exactly one count-only warning after a successful
      // purge, only when invalid markers were observed. No IDs, marker
      // values, paths, or content.
      if (invalidMarkerCount > 0) {
        loggerService
          .withContext('ChatDbAggregate')
          .warn(
            `Trash purge: ${invalidMarkerCount} imported-topic retention marker(s) were invalid ` +
              'and fell back to deletedAt retention (LOCK-TRASH-7).'
          )
      }

      return { ...cleanup, deletedTopicIds: [...deletedTopicIds] }
    }, `purgeExpiredTopics()`)
  }

  /**
   * Empty an assistant's trash atomically (LOCK-531).
   *
   * ONE root SQLite transaction hard-deletes every topic of the assistant
   * that is still soft-deleted at transaction time (FK cascade: messages →
   * blocks → file_references, segments → memberships) and returns one
   * aggregate FileCleanupResult. Any mid-operation failure rolls back the
   * entire transaction — no partial commit.
   */
  emptyTrashTopics(assistantId: string): ChatDbResult<EmptyTrashTopicsResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('emptyTrashTopics')
      // LOCK-004: exact deleted topic IDs collected inside the transaction.
      const deletedTopicIds: string[] = []

      const cleanup = this.db.transaction((tx) => {
        const repos = createRepositories(tx)

        const allAffectedFileIds: string[] = []
        let cursor: string | undefined
        let hasMore = true

        // Drain the assistant's trash pages inside the transaction. Deleting
        // listed rows is safe with keyset pagination: the next page is
        // selected relative to the cursor tuple, not to row offsets.
        while (hasMore) {
          const page = repos.topics.listTrashPage({ limit: 100, direction: 'desc', cursor }, { assistantId })

          for (const topic of page.items) {
            // Collect affected file IDs and descendant frames before cascade
            // — across ALL route owners of the topic.
            const messages = repos.messages.listAllByTopic(topic.id)
            const messageIds = messages.map((m) => m.id)
            const refs = repos.fileRefs.listByMessages(messageIds)
            allAffectedFileIds.push(...collectAffectedFileIds(refs))

            deletedTopicIds.push(topic.id)

            // Local frame invalidation (010): atomically invalidate topicMessage and every descendant messageBlock frame, no clock mint.
            const stx = tx as unknown as SyncTxExecutor
            for (const mid of messageIds) {
              syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
            }
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', topic.id)

            // FK cascade: hard delete
            repos.topics.hardDelete(topic.id)
            // Resend intent (SYNC-DATA-055): the wiped topic carries no
            // unfinished attempt — clear in the same transaction.
            clearResendAttemptsForTopicInTx(stx, topic.id)
          }

          cursor = page.nextCursor
          hasMore = page.hasMore && page.items.length > 0
        }

        // Deduplicate affected file IDs and compute remaining counts
        const uniqueAffectedIds = [...new Set(allAffectedFileIds)]
        return buildFileCleanupResult(repos, uniqueAffectedIds)
      })

      // LOCK-004: clean ordinary-chat traces after the DB commit for the exact
      // emptied topic IDs. Cleanup failure is logged and non-fatal; it never
      // changes the returned committed result. A failed transaction throws
      // before this point, so post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      return { ...cleanup, deletedTopicIds: [...deletedTopicIds] }
    }, `emptyTrashTopics(${assistantId})`)
  }

  transferTopicOwnership(topicId: string, assistantId: string): ChatDbResult<null> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('transferTopicOwnership')
      this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(topicId)
        if (!topic.found) throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        repos.topics.updatePatch(topicId, { assistantId } as any)
        for (const message of repos.messages.listAllByTopic(topicId)) {
          repos.messages.update(topicId, message.id, { assistantId } as any)
        }
      })
      return null
    }, `transferTopicOwnership(${topicId}, ${assistantId})`)
  }

  resetAssistantTopics(assistantId: string, replacementTopicId: string): ChatDbResult<ResetAssistantTopicsResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('resetAssistantTopics')
      // LOCK-004: exact hard-deleted topic IDs are collected inside the
      // transaction; the replacement topic is excluded from both deletion
      // and trace cleanup.
      const deletedTopicIds: string[] = []
      const result = this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const affectedFileIds: string[] = []
        let activeCursor: string | undefined
        let trashCursor: string | undefined
        let hasMoreActive = true
        let hasMoreTrash = true
        while (hasMoreActive || hasMoreTrash) {
          const activePage = hasMoreActive
            ? repos.topics.listPage({ limit: 100, direction: 'asc', cursor: activeCursor })
            : { items: [], nextCursor: undefined, hasMore: false }
          const trashPage = hasMoreTrash
            ? repos.topics.listTrashPage({ limit: 100, direction: 'asc', cursor: trashCursor })
            : { items: [], nextCursor: undefined, hasMore: false }
          for (const topic of [...activePage.items, ...trashPage.items]) {
            if (topic.assistantId !== assistantId || topic.id === replacementTopicId) continue
            const messageIds = repos.messages.listAllByTopic(topic.id).map((message) => message.id)
            affectedFileIds.push(...collectAffectedFileIds(repos.fileRefs.listByMessages(messageIds)))
            deletedTopicIds.push(topic.id)
            // Local frame invalidation (010): atomically invalidate topicMessage and every descendant messageBlock frame, no clock mint.
            const stx2 = tx as unknown as SyncTxExecutor
            for (const mid of messageIds) {
              syncService.invalidateParentFrameInTx(stx2, 'messageBlock', mid)
            }
            syncService.invalidateParentFrameInTx(stx2, 'topicMessage', topic.id)
            repos.topics.hardDelete(topic.id)
            // Resend intent (SYNC-DATA-055): the wiped topic carries no
            // unfinished attempt — clear in the same transaction.
            clearResendAttemptsForTopicInTx(stx2, topic.id)
          }
          activeCursor = activePage.nextCursor
          trashCursor = trashPage.nextCursor
          hasMoreActive = activePage.hasMore && activePage.items.length > 0
          hasMoreTrash = trashPage.hasMore && trashPage.items.length > 0
        }
        const replacementTopic = repos.topics.ensure(replacementTopicId, assistantId)
        return {
          cleanup: buildFileCleanupResult(repos, [...new Set(affectedFileIds)]),
          replacementTopic: topicToWireFull(replacementTopic) as unknown as TopicWire,
          deletedTopicIds: [...deletedTopicIds]
        }
      })

      // LOCK-004: clean ordinary-chat traces after the DB commit for the exact
      // hard-deleted topic IDs (the replacement topic is excluded). Cleanup
      // failure is logged and non-fatal; it never changes the returned
      // committed result. A failed transaction throws before this point, so
      // post-commit cleanup is never reached.
      this.cleanDeletedTopicTraces(deletedTopicIds)

      return result
    }, `resetAssistantTopics(${assistantId})`)
  }

  // =========================================================================
  // Topic-internal branches — local-only, no prefix cloning (016)
  // =========================================================================
  //
  // `topics` holds only logical sidebar topics. `topic_branches` holds one
  // row per internal branch node: (topic_id, nullable parent_branch_id,
  // anchor_message_id, name). `messages` stays owned by the logical topic_id
  // with nullable branch_id (null = main route). The main route is addressed
  // by `branchId = null` — no fake root row is ever created.
  //
  // An effective route recursively takes each ancestor route only through
  // the child anchor, then appends messages owned by the current branch.
  // Stable message IDs are shared; no prefix cloning.
  //
  // Local-only: branch rows, branch-owned messages/blocks, and branch
  // operations never enter the sync outbox, membership/frame clocks, or the
  // baseline candidate (suppressed within existing sync boundaries — no wire
  // contract change). Main-route rows remain syncable.
  //
  // True-branch authority (BRANCH-1…BRANCH-12, see docs/adr/topic-branches.md):
  // every message has exactly one permanent owner (branch_id, null = main);
  // the current route mutates only rows it owns (owner equality); ancestor
  // rows are read-only references through the effective route (no
  // descendants (butterfly effect); a missing anchor does not block branch
  // access — a resolvable inheritance boundary applies, otherwise inheritance
  // is empty.
  // =========================================================================

  /**
   * Normalize a wire branch ID to a route owner: non-empty string stays,
   * absent/undefined/null/empty becomes null (main route).
   */
  private normalizeBranchId(branchId: string | null | undefined): string | null {
    return typeof branchId === 'string' && branchId.length > 0 ? branchId : null
  }

  /**
   * Turn-level fold participation: the authority message-id set that a fold
   * excludes from requests, token estimation, context counts and the boundary
   * divider.
   *
   * Fold is TURN-level state stored on the message rows the turn contains
   * (`messages.extra.overflow['folded']`). A turn is folded when ANY of its
   * rows carries the marker, and folding it excludes every row of that turn.
   * That single rule keeps the three consumers of this method consistent:
   *
   * - read: a partially marked turn (legacy write, or a variant that joined
   *   before this rule existed) reads as one folded turn, never as a
   *   row-by-row exclusion that disagrees with the renderer's row display;
   * Resolution always comes from the authority rows of the ADDRESSED
   * effective route, never from a loaded/projected window and never from a
   * single topic's owned rows. A reference target's route begins with foreign
   * reference-prefix rows (`row.topicId != topicId`), and those rows carry
   * their own fold markers — reading only the target topic's own rows would
   * silently re-enable context the source (and every route inheriting it) has
   * excluded. Reading the effective route makes the folded membership agree
   * with the same route's branch/reference chain closure, its counts and
   * divider, its request filter and the whole-topic snapshot, because all of
   * them are derived from that one route.
   *
   * The retired group-level marker (`topic_segments.extra.folded`) is
   * deliberately NOT consulted: collapsing a message group is no longer a
   * context mutation, so every member of such a group keeps its original
   * participation. Legacy markers are inert data, cleaned by migration only.
   */
  private resolveFoldedMemberMessageIdsInTx(
    repos: ChatDbRepositories,
    topicId: string,
    branchId: string | null
  ): Set<string> {
    return this.expandFoldedTurns(this.resolveRouteMessagesInTx(repos, topicId, branchId).messages)
  }

  /**
   * Fold key of one message row: the turn it belongs to.
   *
   * A user (or system) row starts its own turn, so its key is its own id; an
   * assistant row belongs to the turn of its `askId` (an orphan answer with a
   * dangling `askId` still forms that turn, mirroring `groupEffectiveTurnsInTx`).
   */
  private turnFoldKeyOf(message: MessageData): string {
    if (message.role === 'assistant' && typeof message.askId === 'string' && message.askId.length > 0) {
      return message.askId
    }
    return message.id
  }

  /**
   * Expand row-level fold markers to whole-turn membership.
   *
   * Idempotent and monotone: if any row of a turn is folded, every row of that
   * turn is in the returned set.
   *
   * A turn is keyed by its OWNER plus its turn key (`askId`, else the row's
   * own id), not by the turn key alone: an effective route can carry rows of
   * several owners (a reference prefix belongs to the source topic, the suffix
   * to the target), so keying by `askId` across owners would let one owner's
   * folded turn pull in, or hide, another owner's row that happens to share
   * that key. Fold markers themselves are global per message row (stable id),
   * so owner scoping never rewrites anything — it only decides which rows form
   * one turn.
   */
  private expandFoldedTurns(rows: MessageData[]): Set<string> {
    const ownerTurnKeyOf = (row: MessageData): string =>
      `${row.topicId}\u0000${row.branchId ?? ''}\u0000${this.turnFoldKeyOf(row)}`
    const foldedTurnKeys = new Set<string>()
    const turnKeyByMessageId = new Map<string, string>()
    for (const row of rows) {
      const key = ownerTurnKeyOf(row)
      turnKeyByMessageId.set(row.id, key)
      if (row.overflow['folded'] === true) foldedTurnKeys.add(key)
    }
    const foldedIds = new Set<string>()
    for (const [messageId, key] of turnKeyByMessageId) {
      if (foldedTurnKeys.has(key)) foldedIds.add(messageId)
    }
    return foldedIds
  }

  /**
   * Turn-level fold inheritance for a NEW message row: when the turn it joins
   * is already folded, the new row is born folded so the turn stays coherent
   * (an added/regenerated variant never silently re-enables excluded context).
   * Rows that start their own turn (user/system) inherit nothing.
   */
  private inheritTurnFoldForNewMessageInTx(repos: ChatDbRepositories, topicId: string, message: MessageData): void {
    const key = this.turnFoldKeyOf(message)
    if (key === message.id) return
    // The source folded marker is resolved from the new row's own effective
    // route — the same complete row set the closures, counts and snapshots
    // read — never from the whole topic. A whole-topic scan would leak a
    // same-key marker from a sibling branch or a foreign referenced prefix
    // into a route that never folded that turn.
    const turnFolded = this.resolveRouteMessagesInTx(repos, topicId, message.branchId ?? null).messages.some(
      (row) => this.turnFoldKeyOf(row) === key && row.overflow['folded'] === true
    )
    if (!turnFolded) return
    message.overflow = { ...message.overflow, folded: true }
  }
  /**
   * Shared group-level RANGE guard: every command that acts on a set of turns
   * or on a message group (create/update message group, multi-turn fold) runs
   * this inside its transaction before any write.
   *
   * Two facts are enforced over the addressed effective route:
   *
   * 1. Route presence — every selected row must resolve on the addressed
   *    route.
   * 2. Ownership — every selected row must be owned by the addressed route:
   *    owner equality compares `topicId` AND `branchId` (BRANCH-4). An
   *    inherited/read-only row (ancestor prefix, cross-topic reference
   *    prefix) rejects instead of being written, so a group-level command can
   *    never mutate another owner's rows.
   *
   * Owner equality is the complete range authority. A fork divider is a
   * presentation fact about where a route splits, not a mutation boundary: a
   * range may span a fork whose child the addressed route never took, and a
   * same-owner selection stays allowed even when a child fork sits inside its
   * span, because every row such a command writes belongs to the addressed
   * route. The guard therefore never consults renderer markers, fork indices
   * or the route's own inherited-prefix index: ownership already rejects any
   * range that starts in, or reaches into, another owner's rows, so those
   * facts would be redundant and could only over-block.
   *
   * Single-message basics (`updateMessage`, `deleteMessage`,
   * `reorderMessages`, `selectAnswerMessage`, `selectUsefulAnswer`) keep their
   * own owner-equality behavior unchanged; only group-level range commands
   * call this.
   *
   * Missing rows and out-of-route ids fail closed with zero writes.
   */
  private assertGroupRangeOwnedInTx(
    repos: ChatDbRepositories,
    topicId: string,
    route: string | null,
    messageIds: string[]
  ): void {
    if (messageIds.length === 0) return
    // One materialization of the addressed effective route serves both facts:
    // presence in the route, then owner equality on the same preloaded rows.
    // No per-row route resolution and no second owned-row query.
    const byId = new Map(
      this.resolveRouteMessagesInTx(repos, topicId, route).messages.map((message) => [message.id, message] as const)
    )
    for (const messageId of messageIds) {
      const row = byId.get(messageId)
      if (!row) {
        throw new ChatDbValidationError(
          `Message ${messageId} does not belong to the addressed route of topic ${topicId}`
        )
      }
      if (!isOwnedByRoute(row.topicId, row.branchId, topicId, route)) {
        throw new ChatDbValidationError(
          `Message ${messageId} is shared with another route and cannot join a group-level change of this route`
        )
      }
    }
  }

  /**
   * Participating-turn counts and window divider, derived once from the same
   * ordered authority turn set both closure producers use.
   *
   * A turn participates when at least one of its rows is not a folded member.
   * `totalTurnCount` / `selectedTurnCount` are expressed in participating turns
   * so the actual request, token estimation, context count and divider share
   * one definition. Folding never moves the window start (`windowStartIdx`
   * comes from the anchor resolved before participation is applied), and when
   * the window clips participating history the divider is the first
   * *participating* message of the window — a hidden folded row can never be
   * the divider.
   */
  private deriveParticipatingClosureCounts(
    turns: ReadonlyArray<{ messages: ReadonlyArray<{ id: string }> }>,
    windowStartIdx: number,
    foldedMemberIds: ReadonlySet<string>
  ): { totalTurnCount: number; selectedTurnCount: number; boundaryMessageId: string | null } {
    const participates = (turn: { messages: ReadonlyArray<{ id: string }> }): boolean =>
      this.turnParticipatesInContext(turn, foldedMemberIds)
    const participatingTotal = turns.filter(participates).length
    const windowTurns = windowStartIdx >= 0 && windowStartIdx < turns.length ? turns.slice(windowStartIdx) : []
    const participatingWindow = windowTurns.filter(participates).length
    // Degenerate shape guard: a window whose every turn is folded still
    // reports a coherent 1/N participation count (the persisted anchor and the
    // request trigger keep the window alive), never 0/0 or selected > total.
    const totalTurnCount = Math.max(1, participatingTotal, participatingWindow)
    const selectedTurnCount = Math.max(1, participatingWindow)
    let boundaryMessageId: string | null = null
    // Boundary: present exactly when the window start clips participating
    // history, i.e. when the window does not begin at the route's first
    // participating turn. Folding alone never introduces a divider.
    if (selectedTurnCount !== totalTurnCount) {
      for (const turn of windowTurns) {
        const firstParticipating = turn.messages.find((message) => !foldedMemberIds.has(message.id))
        if (firstParticipating) {
          boundaryMessageId = firstParticipating.id
          break
        }
      }
    }
    return { totalTurnCount, selectedTurnCount, boundaryMessageId }
  }
  /**
   * One-turn participation predicate shared by every default-position
   * selection and every participating count: a turn participates when at
   * least one of its rows is not a folded member. Fold markers expand to
   * whole turns on read, so a partially marked turn never participates.
   */
  private turnParticipatesInContext(
    turn: { messages: ReadonlyArray<{ id: string }> },
    foldedMemberIds: ReadonlySet<string>
  ): boolean {
    return turn.messages.some((message) => !foldedMemberIds.has(message.id))
  }

  /**
   * Unified default window selection: the last N participating turns of the
   * effective route, anchored at the first of those turns (stable group
   * key). Counts and the request filter share the same participation
   * predicate, so a default start can never land inside excluded history.
   *
   * - Empty route -> -1 (callers keep the empty degenerate: null anchor).
   * - Null/undefined (unlimited) -> first participating turn; an all-folded
   *   route falls back to the raw first turn.
   * - Finite N -> first of the last N participating turns (N<=0 counts as 1,
   *   mirroring the historical floor); fewer than N participating turns
   *   anchor at the first participating one, and an all-folded route falls
   *   back to the raw max(0, total-N) tail position.
   *
   * Only default computation (establish of a missing anchor,
   * reanchor-default, inherit/branch fallbacks) uses this selector. A stored
   * manual anchor is never recomputed when folds toggle.
   */
  private resolveDefaultParticipatingIndex(
    turns: ReadonlyArray<{ key: string; messages: ReadonlyArray<{ id: string }> }>,
    foldedMemberIds: ReadonlySet<string>,
    contextCount: number | null | undefined
  ): number {
    if (turns.length === 0) return -1
    if (contextCount === null || contextCount === undefined) {
      const first = turns.findIndex((turn) => this.turnParticipatesInContext(turn, foldedMemberIds))
      return first !== -1 ? first : 0
    }
    const n = Math.max(1, Math.floor(contextCount))
    let anchor = -1
    let need = n
    for (let i = turns.length - 1; i >= 0 && need > 0; i--) {
      if (this.turnParticipatesInContext(turns[i], foldedMemberIds)) {
        anchor = i
        need--
      }
    }
    if (anchor !== -1) return anchor
    return Math.max(0, turns.length - n)
  }

  /** Domain branch node → wire (exact TopicBranchWire keys, null-preserving). */
  private branchToWire(branch: TopicBranchData, inheritedBoundary: BranchInheritedBoundary): TopicBranchWire {
    return {
      id: branch.id,
      topicId: branch.topicId,
      parentBranchId: branch.parentBranchId,
      anchorMessageId: branch.anchorMessageId,
      inheritedBoundary,
      name: branch.name,
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt
    }
  }

  /**
   * Read-only placement fact for one branch's fork divider, derived from the
   * SAME route composition the message reads use: the parent route composes
   * `messageId` as the last inherited message (the fork anchor while it still
   * composes that route, otherwise the nearest surviving message before it),
   * or the branch inherits nothing at all and its boundary is the parent
   * route's history head. A head boundary carries no message id — nothing is
   * invented for a position no row occupies, so a renderer can place the
   * divider without turning it into a scroll/navigation target.
   */
  private resolveBranchInheritedBoundaryInTx(
    repos: ChatDbRepositories,
    topicId: string,
    parentBranchId: string | null,
    anchorMessageId: string,
    routeCache?: Map<string | null, MessageData[] | null>
  ): BranchInheritedBoundary {
    const key = this.normalizeBranchId(parentBranchId)
    let route = routeCache?.get(key)
    if (route === undefined) {
      try {
        route = this.resolveRouteMessagesGuardedInTx(repos, topicId, key, new Set<string>(), 0)
      } catch (e) {
        // Broken ancestry stays readable with an empty inherited history; the
        // boundary is that empty history's head, never a guessed message.
        if (!(e instanceof ChatDbNotFoundError)) throw e
        route = null
      }
      routeCache?.set(key, route)
    }
    if (route === null) return { kind: 'head', messageId: null }
    if (route.some((m) => m.id === anchorMessageId)) {
      return { kind: 'message', messageId: anchorMessageId }
    }
    const boundaryIdx = this.deriveInheritanceBoundaryInTx(repos, route, anchorMessageId)
    if (boundaryIdx === null) return { kind: 'head', messageId: null }
    return { kind: 'message', messageId: route[boundaryIdx].id }
  }

  /**
   * Require a branch node of this logical topic. Unknown IDs, cross-topic
   * IDs, and (for writes) trashed topics fail closed. Pre-016 databases
   * without the table report no branch (fail open as main route for reads).
   */
  private requireBranchInTx(repos: ChatDbRepositories, topicId: string, branchId: string): TopicBranchData {
    let found: { found: boolean; data?: TopicBranchData }
    try {
      found = repos.branches.getById(branchId)
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) {
        throw new ChatDbNotFoundError(`Branch ${branchId} does not exist in topic ${topicId}`)
      }
      throw e
    }
    if (!found.found || found.data!.topicId !== topicId) {
      throw new ChatDbNotFoundError(`Branch ${branchId} does not exist in topic ${topicId}`)
    }
    return found.data!
  }

  /**
   * Per-route sync context: enforces the publish barrier identically to
   * syncCtx(), then suppresses capture for branch routes (local-only) by
   * returning null. Reference-target topics are likewise local-only: their
   * LIVE foreign prefix is not representable on the wire, so the target topic
   * and its own suffix capture no sync intent (the source topic keeps its
   * normal sync). Ordinary main routes keep the real context.
   */
  private syncCtxForTopic(
    channel: string,
    topicId: string,
    branchId?: string | null
  ): { deviceId: string; ts: number } | null {
    const ctx = this.syncCtx(channel)
    if (!ctx) return null
    if (this.normalizeBranchId(branchId) !== null) return null
    if (topicId && this.topicHasReference(topicId)) return null
    return ctx
  }

  /**
   * Best-effort reference-target probe for pre-tx capture gating (root db).
   * Tolerates a pre-018 database and any infrastructure uncertainty by NOT
   * suppressing (existing capture behavior preserved); the in-tx guard is the
   * authority.
   */
  private topicHasReference(topicId: string): boolean {
    try {
      return this.repos().topicReferences.exists(topicId)
    } catch {
      return false
    }
  }

  /** True when the topic owns at least one branch node (tolerates pre-016). */
  private topicHasBranchesInTx(db: BetterSQLite3Database<typeof schema>, topicId: string): boolean {
    try {
      const row = db
        .select({ id: schema.topicBranches.id })
        .from(schema.topicBranches)
        .where(eq(schema.topicBranches.topicId, topicId))
        .limit(1)
        .get()
      return row !== undefined
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return false
      throw e
    }
  }

  /**
   * Best-effort pre-tx owner-route resolution for block payloads: the single
   * owning (topicId, branchId) route when every resolvable parent agrees,
   * otherwise null (preserve existing capture behavior — the in-tx
   * fail-closed gate decides per block). Used only to suppress sync capture
   * for branch-owned streaming writes; never an authority decision.
   */
  private resolveBlockOwnerRoute(blocksJson: JsonObject[]): { topicId: string; branchId: string | null } | null {
    let repos: ChatDbRepositories | null = null
    try {
      repos = this.repos()
    } catch {
      return null
    }
    const owners = new Set<string>()
    let resolved = 0
    let winner: { topicId: string; branchId: string | null } | null = null
    for (const raw of blocksJson) {
      if (!raw || typeof raw !== 'object') continue
      const rec = raw as Record<string, unknown>
      const parents = new Set<string>()
      const wireParent = rec.messageId
      if (typeof wireParent === 'string' && wireParent.length > 0) parents.add(wireParent)
      const bid = rec.id
      if (typeof bid === 'string' && bid.length > 0 && repos) {
        try {
          const found = repos.blocks.getById(bid)
          if (found.found) parents.add(found.data.messageId)
        } catch {
          // Best effort only.
        }
      }
      for (const mid of parents) {
        try {
          const msg = repos.messages.getById(mid)
          if (msg.found) {
            const branchId = msg.data.branchId ?? null
            owners.add(`${msg.data.topicId} ${branchId ?? ''}`)
            winner = { topicId: msg.data.topicId, branchId }
            resolved++
          }
        } catch {
          // Best effort only.
        }
      }
    }
    if (resolved === 0 || owners.size !== 1) return null
    return winner
  }

  /**
   * Best-effort pre-tx owner-route resolution for block ID lists (deletes).
   * Same single-agreement contract as resolveBlockOwnerRoute.
   */
  private resolveBlockOwnerRouteByIds(blockIds: string[]): { topicId: string; branchId: string | null } | null {
    let repos: ChatDbRepositories | null = null
    try {
      repos = this.repos()
    } catch {
      return null
    }
    const owners = new Set<string>()
    let resolved = 0
    let winner: { topicId: string; branchId: string | null } | null = null
    for (const bid of blockIds) {
      if (typeof bid !== 'string' || bid.length === 0) continue
      try {
        const found = repos.blocks.getById(bid)
        if (!found.found) continue
        const msg = repos.messages.getById(found.data.messageId)
        if (msg.found) {
          const branchId = msg.data.branchId ?? null
          owners.add(`${msg.data.topicId} ${branchId ?? ''}`)
          winner = { topicId: msg.data.topicId, branchId }
          resolved++
        }
      } catch {
        // Best effort only.
      }
    }
    if (resolved === 0 || owners.size !== 1) return null
    return winner
  }

  /**
   * Authoritative in-transaction owner-route resolution for a single block
   * (fail-closed sync gate): the committed block row's parent wins, the
   * wire parent is the fallback for not-yet-written rows. Returns null when
   * the owner cannot be proven in-transaction (pre-first-chunk unknown).
   * Never throws: infrastructure uncertainty resolves to null (suppressed).
   */
  private blockOwnerRouteInTx(
    repos: ChatDbRepositories,
    blockId: string,
    wireMessageId?: string | null
  ): { topicId: string; branchId: string | null } | null {
    let messageId: string | null = null
    try {
      const brow = repos.blocks.getById(blockId)
      if (brow.found) messageId = brow.data.messageId
    } catch {
      return null
    }
    if (!messageId && typeof wireMessageId === 'string' && wireMessageId.length > 0) {
      messageId = wireMessageId
    }
    if (!messageId) return null
    try {
      const mrow = repos.messages.getById(messageId)
      if (!mrow.found) return null
      return { topicId: mrow.data.topicId, branchId: mrow.data.branchId ?? null }
    } catch {
      return null
    }
  }

  /**
   * Fail-closed branch suppression for block sync intent: true when the
   * block's parent message is branch-owned (local-only) or its owner cannot
   * be proven in-transaction (pre-first-chunk unknown). Callers skip sync
   * intent (outbox, membership, frames) for suppressed blocks while the chat
   * mutation itself still commits. Ordinary main-route writes still capture.
   */
  private isBlockSyncSuppressedInTx(
    repos: ChatDbRepositories,
    _db: BetterSQLite3Database<typeof schema>,
    blockId: string,
    wireMessageId?: string | null
  ): boolean {
    const owner = this.blockOwnerRouteInTx(repos, blockId, wireMessageId)
    if (!owner) return true
    return owner.branchId !== null
  }

  /**
   * Direct child branches of one parent route in deterministic order
   * (createdAt ASC, id ASC). `parentBranchId = null` addresses the level-1
   * branches forked from the main route. Tolerates pre-016 databases.
   */
  /**
   * Breadcrumb path for a route: root-first branch nodes from the level-1
   * ancestor down to the addressed branch. [] for the main route.
   * Cycle/depth-guarded (MAX_BRANCH_DEPTH); a repeated node stops the walk.
   */
  private branchPathInTx(repos: ChatDbRepositories, branchId: string | null): TopicBranchData[] {
    if (branchId === null) return []
    try {
      return repos.branches.pathFor(branchId)
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) {
        throw new ChatDbNotFoundError(`Branch ${branchId} does not exist`)
      }
      throw e
    }
  }

  /**
   * True when the topic owns a history-reference relation (is a reference
   * target). Tolerates pre-018 databases. Used to fail cross-topic foreign
   * prefix writes closed (never silently skipped) and to route windowed reads
   * through the reference-aware resolver.
   */
  private topicHasReferenceInTx(db: BetterSQLite3Database<typeof schema>, topicId: string): boolean {
    try {
      const row = db
        .select({ targetTopicId: schema.topicReferences.targetTopicId })
        .from(schema.topicReferences)
        .where(eq(schema.topicReferences.targetTopicId, topicId))
        .limit(1)
        .get()
      return row !== undefined
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return false
      throw e
    }
  }

  /** Domain reference node → wire (exact TopicReferenceWire keys; live source name). */
  private referenceToWire(ref: TopicReferenceData, sourceName: string | null): TopicReferenceWire {
    return {
      targetTopicId: ref.targetTopicId,
      sourceTopicId: ref.sourceTopicId,
      sourceBranchId: ref.sourceBranchId,
      anchorMessageId: ref.anchorMessageId,
      sourceName,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt
    }
  }

  /**
   * Canonical effective-route structure (bounded window foundation).
   *
   * Minimal algorithm: an effective route is an ORDERED list of owner
   * segments `(topicId, branchId)` with per-segment tuple upper bounds. Each
   * owner appears at most once; segment order is route order; rows inside a
   * segment compose in `(sortOrder, id)` ASC. A `null` upper means the full
   * owner suffix; a message id upper means the inherited/reference prefix
   * through that endpoint inclusive. Cross-segment tuples are incomparable —
   * membership is owner equality plus a within-segment tuple compare only.
   *
   * Invariants (single truncation rule, shared by full and window reads):
   * - Structure is decided by point lookups (branch path, reference rows,
   *   anchor/getById rows) plus tuple compares — never by `listByTopic`
   *   full scans. No cross-request cache: segments live for one tx only.
   * - Truncation (`truncateRouteSegmentsToBoundaryInTx`): a live anchor
   *   truncates its owner segment to itself and drops later segments; an
   *   anchor beyond a truncated upper keeps the upper and drops later
   *   segments; a missing anchor row or an anchor whose owner composes no
   *   segment yields no boundary (empty inheritance). Anchor-row deletion
   *   therefore inherits nothing; survival+boundary-advance is owned by the
   *   existing delete maintenance before rows disappear.
   * - Owner segments always start at the owner head, so a surviving anchor
   *   of that owner is never before the segment head; the tuple compare
   *   alone decides membership. Equal/duplicate legacy `sortOrder` ties
   *   compare by `(sortOrder, id)` strictly inside one segment.
   * - Full materialization (`materializeRouteSegmentsInTx`) reads each
   *   segment through the same bounds (full owner, or `listThrough` prefix),
   *   so whole/context/answer-group and window reads share one route
   *   composition. Depth/cycle guards (MAX reference/branch + visited) and
   *   missing-source (gone/trashed/unresolvable/empty-boundary) prefix
   *   omission match the previous resolver semantics; metadata `status`
   *   still reports them.
   */
  private compareRouteTuple(aSort: number, aId: string, bSort: number, bId: string): number {
    if (aSort !== bSort) return aSort < bSort ? -1 : 1
    if (aId === bId) return 0
    return aId < bId ? -1 : 1
  }

  private windowGroupKeyOf(m: MessageData): string {
    const askId = (m as unknown as { askId: string | null }).askId
    if (m.role === 'assistant' && typeof askId === 'string' && askId.length > 0) return `assistant:${askId}`
    return `message:${m.role ?? ''}:${m.id}`
  }

  private computeRouteWindowGroups(msgs: MessageData[]): Array<{ semanticKey: string; start: number; end: number }> {
    if (msgs.length === 0) return []
    const groups: Array<{ semanticKey: string; start: number; end: number }> = []
    let curKey = this.windowGroupKeyOf(msgs[0])
    let curStart = 0
    for (let i = 1; i < msgs.length; i++) {
      const k = this.windowGroupKeyOf(msgs[i])
      if (k === curKey) continue
      groups.push({ semanticKey: curKey, start: curStart, end: i - 1 })
      curKey = k
      curStart = i
    }
    groups.push({ semanticKey: curKey, start: curStart, end: msgs.length - 1 })
    return groups
  }

  /** One ordered owner slice of an effective route (see block doc above). */
  private truncateRouteSegmentsToBoundaryInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    anchorMessageId: string
  ): {
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>
    boundaryMessageId: string
  } | null {
    const anchorRow = repos.messages.getById(anchorMessageId)
    if (!anchorRow.found) return null
    const anchor = anchorRow.data
    const anchorOwnerTopic = anchor.topicId
    const anchorOwnerBranch = anchor.branchId ?? null
    let segIdx = -1
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].topicId === anchorOwnerTopic && (segments[i].branchId ?? null) === anchorOwnerBranch) {
        segIdx = i
        break
      }
    }
    if (segIdx === -1) return null
    const seg = segments[segIdx]
    if (seg.upperMessageId === null) {
      const next = segments.slice(0, segIdx)
      next.push({ topicId: seg.topicId, branchId: seg.branchId, upperMessageId: anchorMessageId })
      return { segments: next, boundaryMessageId: anchorMessageId }
    }
    const upperRow = repos.messages.getById(seg.upperMessageId)
    if (!upperRow.found) return null
    const upper = upperRow.data
    const cmp = this.compareRouteTuple(anchor.sortOrder, anchor.id, upper.sortOrder, upper.id)
    if (cmp <= 0) {
      const next = segments.slice(0, segIdx)
      next.push({ topicId: seg.topicId, branchId: seg.branchId, upperMessageId: anchorMessageId })
      return { segments: next, boundaryMessageId: anchorMessageId }
    }
    return { segments: segments.slice(0, segIdx + 1), boundaryMessageId: seg.upperMessageId }
  }

  private resolveReferenceBaseSegmentsInTx(
    repos: ChatDbRepositories,
    topicId: string,
    visited: Set<string>,
    depth: number,
    chainMissing?: ReferenceChainMissingFlag,
    layersOut?: ReferenceChainPlan[]
  ): {
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>
    reference: TopicReferenceData | null
    status: 'none' | 'available' | 'missing'
  } {
    let refRow: { found: boolean; data?: TopicReferenceData }
    try {
      refRow = repos.topicReferences.getByTarget(topicId)
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message))
        return { segments: [], reference: null, status: 'none' }
      throw e
    }
    if (!refRow.found || !refRow.data) return { segments: [], reference: null, status: 'none' }
    const ref = refRow.data
    if (depth >= MAX_REFERENCE_DEPTH || visited.has(topicId)) {
      if (chainMissing) chainMissing.missing = true
      return { segments: [], reference: ref, status: 'missing' }
    }
    visited.add(topicId)
    try {
      const sourceTopic = repos.topics.getById(ref.sourceTopicId)
      if (!sourceTopic.found || sourceTopic.data.deletedAt != null) {
        if (chainMissing) chainMissing.missing = true
        return { segments: [], reference: ref, status: 'missing' }
      }
      let sourceSegments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>
      try {
        sourceSegments = this.resolveRouteSegmentsInTx(
          repos,
          ref.sourceTopicId,
          this.normalizeBranchId(ref.sourceBranchId),
          visited,
          depth + 1,
          chainMissing,
          layersOut
        ).segments
      } catch (e) {
        if (e instanceof ChatDbNotFoundError) {
          if (chainMissing) chainMissing.missing = true
          return { segments: [], reference: ref, status: 'missing' }
        }
        throw e
      }
      const truncated = this.truncateRouteSegmentsToBoundaryInTx(repos, sourceSegments, ref.anchorMessageId)
      if (truncated === null) {
        if (chainMissing) chainMissing.missing = true
        return { segments: [], reference: ref, status: 'missing' }
      }
      layersOut?.push({
        targetTopicId: topicId,
        sourceTopicId: ref.sourceTopicId,
        sourceBranchId: ref.sourceBranchId,
        anchorMessageId: ref.anchorMessageId,
        sourceName: sourceTopic.data?.name ?? null,
        boundaryMessageId: truncated.boundaryMessageId,
        depth
      })
      return { segments: truncated.segments, reference: ref, status: 'available' }
    } finally {
      visited.delete(topicId)
    }
  }

  private resolveRouteSegmentsInTx(
    repos: ChatDbRepositories,
    topicId: string,
    branchId: string | null,
    visited: Set<string>,
    depth: number,
    chainMissing?: ReferenceChainMissingFlag,
    layersOut?: ReferenceChainPlan[]
  ): {
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>
    reference: TopicReferenceData | null
    status: 'none' | 'available' | 'missing'
  } {
    const base = this.resolveReferenceBaseSegmentsInTx(repos, topicId, visited, depth, chainMissing, layersOut)
    if (depth >= MAX_REFERENCE_DEPTH) {
      if (chainMissing) chainMissing.missing = true
      const owner = this.normalizeBranchId(branchId)
      if (owner === null)
        return {
          segments: [{ topicId, branchId: null, upperMessageId: null }],
          reference: base.reference,
          status: base.status === 'none' ? 'none' : 'missing'
        }
      const path = this.branchPathInTx(repos, owner)
      const leaf = path.length > 0 ? path[path.length - 1] : null
      if (!leaf || leaf.topicId !== topicId)
        throw new ChatDbNotFoundError(`Branch ${owner} does not exist in topic ${topicId}`)
      let effective: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }> = [
        { topicId, branchId: null, upperMessageId: null }
      ]
      for (const node of path) {
        const truncated = this.truncateRouteSegmentsToBoundaryInTx(repos, effective, node.anchorMessageId)
        const inherited = truncated === null ? [] : truncated.segments
        effective = [...inherited, { topicId, branchId: node.id, upperMessageId: null }]
      }
      return { segments: effective, reference: base.reference, status: base.status === 'none' ? 'none' : 'missing' }
    }
    const owner = this.normalizeBranchId(branchId)
    if (owner === null) {
      return {
        segments: [...base.segments, { topicId, branchId: null, upperMessageId: null }],
        reference: base.reference,
        status: base.status
      }
    }
    const path = this.branchPathInTx(repos, owner)
    const leaf = path.length > 0 ? path[path.length - 1] : null
    if (!leaf || leaf.topicId !== topicId)
      throw new ChatDbNotFoundError(`Branch ${owner} does not exist in topic ${topicId}`)
    let effective: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }> = [
      ...base.segments,
      { topicId, branchId: null, upperMessageId: null }
    ]
    for (const node of path) {
      const truncated = this.truncateRouteSegmentsToBoundaryInTx(repos, effective, node.anchorMessageId)
      const inherited = truncated === null ? [] : truncated.segments
      effective = [...inherited, { topicId, branchId: node.id, upperMessageId: null }]
    }
    return { segments: effective, reference: base.reference, status: base.status }
  }

  private materializeRouteSegmentsInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>
  ): MessageData[] {
    const out: MessageData[] = []
    for (const seg of segments) {
      if (seg.upperMessageId === null) {
        out.push(...repos.messages.listByTopic(seg.topicId, seg.branchId))
      } else {
        const upperRow = repos.messages.getById(seg.upperMessageId)
        if (!upperRow.found) continue
        const upper = upperRow.data
        out.push(...repos.messages.listThrough(seg.topicId, upper.sortOrder, upper.id, seg.branchId))
      }
    }
    return out
  }

  private isMessageInRouteSegmentsInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    messageId: string
  ): boolean {
    const row = repos.messages.getById(messageId)
    if (!row.found) return false
    const m = row.data
    for (const seg of segments) {
      if (seg.topicId !== m.topicId || (seg.branchId ?? null) !== (m.branchId ?? null)) continue
      if (seg.upperMessageId === null) return true
      const upperRow = repos.messages.getById(seg.upperMessageId)
      if (!upperRow.found) return false
      const upper = upperRow.data
      return this.compareRouteTuple(m.sortOrder, m.id, upper.sortOrder, upper.id) <= 0
    }
    return false
  }

  /**
   * Bounded virtual-route scans over ordered owner segments.
   *
   * Every helper below reads at most its `limit` rows plus one-row probes
   * (`getById` / `findPredecessor` / `findSuccessor` / head / tail) per
   * touched segment, over the existing owner + order index. Cost scales with
   * route depth/segment count + requested window + one whole pathological
   * group — never with unrelated history length. Empty segments contribute
   * nothing and are skipped by probe, never by full read.
   */
  private routeSegmentTailInTx(
    repos: ChatDbRepositories,
    seg: { topicId: string; branchId: string | null; upperMessageId: string | null }
  ): MessageData | null {
    if (seg.upperMessageId !== null) {
      const upperRow = repos.messages.getById(seg.upperMessageId)
      return upperRow.found ? upperRow.data : null
    }
    const tail = repos.messages.getLatestByTopic(seg.topicId, 1, seg.branchId)
    return tail.length > 0 ? tail[0] : null
  }

  private routeSegmentHeadInTx(
    repos: ChatDbRepositories,
    seg: { topicId: string; branchId: string | null; upperMessageId: string | null }
  ): MessageData | null {
    return repos.messages.getFirstByTopic(seg.topicId, seg.branchId)
  }

  private locateWindowAnchorInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    anchorMessageId: string
  ): { segIdx: number; anchor: MessageData } | null {
    const anchorRow = repos.messages.getById(anchorMessageId)
    if (!anchorRow.found) return null
    const anchor = anchorRow.data
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg.topicId !== anchor.topicId || (seg.branchId ?? null) !== (anchor.branchId ?? null)) continue
      if (seg.upperMessageId === null) return { segIdx: i, anchor }
      const upperRow = repos.messages.getById(seg.upperMessageId)
      if (!upperRow.found) return null
      const upper = upperRow.data
      if (this.compareRouteTuple(anchor.sortOrder, anchor.id, upper.sortOrder, upper.id) <= 0)
        return { segIdx: i, anchor }
      return null
    }
    return null
  }

  private effectivePredecessorOfInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    segIdx: number,
    sortOrder: number,
    id: string
  ): MessageData | null {
    const seg = segments[segIdx]
    const pred = repos.messages.findPredecessor(seg.topicId, sortOrder, id, seg.branchId)
    if (pred !== null) return pred
    for (let j = segIdx - 1; j >= 0; j--) {
      const tail = this.routeSegmentTailInTx(repos, segments[j])
      if (tail !== null) return tail
    }
    return null
  }

  private effectiveSuccessorOfInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    segIdx: number,
    sortOrder: number,
    id: string
  ): MessageData | null {
    const seg = segments[segIdx]
    const succ = repos.messages.findSuccessor(seg.topicId, sortOrder, id, seg.branchId)
    if (succ !== null) {
      if (seg.upperMessageId === null) return succ
      const upperRow = repos.messages.getById(seg.upperMessageId)
      if (upperRow.found) {
        const upper = upperRow.data
        if (this.compareRouteTuple(succ.sortOrder, succ.id, upper.sortOrder, upper.id) <= 0) return succ
      }
    }
    for (let j = segIdx + 1; j < segments.length; j++) {
      const head = this.routeSegmentHeadInTx(repos, segments[j])
      if (head !== null) {
        if (segments[j].upperMessageId === null) return head
        const upperRow = repos.messages.getById(segments[j].upperMessageId as string)
        if (!upperRow.found) continue
        const upper = upperRow.data
        if (this.compareRouteTuple(head.sortOrder, head.id, upper.sortOrder, upper.id) <= 0) return head
      }
    }
    return null
  }

  private segmentIndexOfOwner(
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    topicId: string,
    branchId: string | null
  ): number {
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].topicId === topicId && (segments[i].branchId ?? null) === branchId) return i
    }
    return -1
  }

  private readRouteTailBackwardInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    limit: number
  ): MessageData[] {
    if (limit <= 0 || segments.length === 0) return []
    let remaining = limit
    let out: MessageData[] = []
    for (let j = segments.length - 1; j >= 0 && remaining > 0; j--) {
      const seg = segments[j]
      let page: MessageData[]
      if (seg.upperMessageId === null) {
        page = repos.messages.getLatestByTopic(seg.topicId, remaining, seg.branchId)
      } else {
        const upperRow = repos.messages.getById(seg.upperMessageId)
        if (!upperRow.found) continue
        const upper = upperRow.data
        const before = repos.messages.listBefore(seg.topicId, upper.sortOrder, upper.id, remaining - 1, seg.branchId)
        page = [...before, upper]
      }
      if (page.length === 0) continue
      out = [...page, ...out]
      remaining -= page.length
    }
    return out
  }

  private readRouteBackwardBeforeInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    segIdx: number,
    sortOrder: number,
    id: string,
    limit: number
  ): MessageData[] {
    if (limit <= 0) return []
    let remaining = limit
    let out: MessageData[] = []
    for (let j = segIdx; j >= 0 && remaining > 0; j--) {
      const seg = segments[j]
      let page: MessageData[]
      if (j === segIdx) {
        page = repos.messages.listBefore(seg.topicId, sortOrder, id, remaining, seg.branchId)
      } else if (seg.upperMessageId === null) {
        page = repos.messages.getLatestByTopic(seg.topicId, remaining, seg.branchId)
      } else {
        const upperRow = repos.messages.getById(seg.upperMessageId)
        if (!upperRow.found) continue
        const upper = upperRow.data
        const before = repos.messages.listBefore(seg.topicId, upper.sortOrder, upper.id, remaining - 1, seg.branchId)
        page = [...before, upper]
      }
      if (page.length === 0) continue
      out = [...page, ...out]
      remaining -= page.length
    }
    return out
  }

  private readRouteForwardAfterInTx(
    repos: ChatDbRepositories,
    segments: Array<{ topicId: string; branchId: string | null; upperMessageId: string | null }>,
    segIdx: number,
    sortOrder: number,
    id: string,
    limit: number
  ): MessageData[] {
    if (limit <= 0) return []
    let remaining = limit
    const out: MessageData[] = []
    for (let j = segIdx; j < segments.length && remaining > 0; j++) {
      const seg = segments[j]
      let page: MessageData[]
      if (j === segIdx) {
        page = repos.messages.listAfter(seg.topicId, sortOrder, id, remaining, seg.branchId)
      } else {
        page = repos.messages.listFirst(seg.topicId, remaining, seg.branchId)
      }
      if (seg.upperMessageId !== null) {
        const upperRow = repos.messages.getById(seg.upperMessageId)
        if (!upperRow.found) continue
        const upper = upperRow.data
        const filtered: MessageData[] = []
        for (const m of page) {
          if (this.compareRouteTuple(m.sortOrder, m.id, upper.sortOrder, upper.id) <= 0) filtered.push(m)
          else break
        }
        out.push(...filtered)
        remaining -= filtered.length
        if (filtered.length < page.length) continue
        if (page.length < remaining + filtered.length) continue
        if (remaining <= 0) break
        continue
      }
      out.push(...page)
      remaining -= page.length
      if (page.length === 0) continue
      if (remaining <= 0) break
    }
    return out
  }

  /**
   * Resolve the foreign reference base prefix of a target topic (recursive,
   * cycle/depth-guarded). Returns:
   * - status 'none' when the topic is not a reference target;
   * - status 'missing' when the source topic is gone/trashed, the source
   *   route cannot resolve, no boundary survives for the endpoint, or a
   *   cycle/depth limit is hit — `messages` is then empty (prefix omitted);
   * - status 'available' with the source-route prefix through the boundary
   *   inclusive (canonical source rows; stable IDs; no copy). The boundary is
   *   the captured endpoint while it composes the source route, otherwise the
   *   nearest surviving message before it (same rule as branch inheritance).
   *
   * `chainMissing` (optional) is provenance-only: when supplied it is flagged
   * at EVERY missing reference segment in the resolved source chain, so a
   * caller can distinguish a fully materialized prefix from one whose nested
   * source history is incomplete. Ordinary reads omit it.
   *
   * `layersOut` (optional) accumulates one `ReferenceChainPlan` per
   * materialized relation in the resolved chain, so a windowed read can report
   * the per-layer divider boundaries of a chained reference without re-reading
   * the source chain on the renderer side.
   */
  private resolveReferenceBaseInTx(
    repos: ChatDbRepositories,
    topicId: string,
    visited: Set<string>,
    depth: number,
    chainMissing?: ReferenceChainMissingFlag,
    layersOut?: ReferenceChainPlan[]
  ): ReferenceBaseResolution {
    const base = this.resolveReferenceBaseSegmentsInTx(repos, topicId, visited, depth, chainMissing, layersOut)
    if (base.status !== 'available') return { messages: [], reference: base.reference, status: base.status }
    return {
      messages: this.materializeRouteSegmentsInTx(repos, base.segments),
      reference: base.reference,
      status: base.status
    }
  }

  /**
   * Cycle/depth-guarded effective-route resolution shared by cross-topic
   * reference recursion. The base of any topic is its foreign reference
   * prefix (when it is a reference target) followed by its own main rows;
   * intra-topic branches then compose atop that base through the same
   * anchor-slice algorithm, each through its inheritance boundary. A missing
   * reference source omits the prefix (status is surfaced by the caller-facing
   * metadata) and a branch/reference boundary with no surviving predecessor
   * inherits nothing.
   *
   * `chainMissing` (optional) is threaded into the reference base so a nested
   * missing segment in the source chain is reported to provenance callers.
   * `layersOut` (optional) is threaded the same way for materialized chain
   * layers.
   */
  private resolveRouteMessagesGuardedInTx(
    repos: ChatDbRepositories,
    topicId: string,
    branchId: string | null,
    visited: Set<string>,
    depth: number,
    chainMissing?: ReferenceChainMissingFlag,
    layersOut?: ReferenceChainPlan[]
  ): MessageData[] {
    return this.materializeRouteSegmentsInTx(
      repos,
      this.resolveRouteSegmentsInTx(repos, topicId, branchId, visited, depth, chainMissing, layersOut).segments
    )
  }

  /**
   * Inheritance boundary index for an anchor that no longer composes the
   * parent effective route, or null when the inherited history is empty.
   *
   * The original fork point stays authoritative: only messages composed
   * before it may be inherited, so nothing after it can leak into the child
   * route. While the anchor row itself survives its owner segment still
   * carries the ordering information, so the boundary resolves to the nearest
   * surviving message before the anchor inside that segment — or, when the
   * anchor was the segment's first row, to the message immediately before the
   * segment (the segment's own inherited tail). Once the anchor row is gone no
   * ordering information is left: no predecessor is guessed, and the child
   * route inherits nothing while keeping its own suffix.
   */
  private deriveInheritanceBoundaryInTx(
    repos: ChatDbRepositories,
    effective: MessageData[],
    anchorMessageId: string
  ): number | null {
    const anchorRow = repos.messages.getById(anchorMessageId)
    if (!anchorRow.found) return null
    const anchor = anchorRow.data
    const anchorOwner = anchor.branchId ?? null
    let segmentStart = -1
    let predecessor: number | null = null
    for (let i = 0; i < effective.length; i++) {
      const row = effective[i]
      if (row.topicId !== anchor.topicId || (row.branchId ?? null) !== anchorOwner) continue
      if (segmentStart === -1) segmentStart = i
      const orderedBefore =
        row.sortOrder < anchor.sortOrder || (row.sortOrder === anchor.sortOrder && row.id < anchor.id)
      // Every segment composes in (sort_order, id) order, so nothing later in
      // this segment can precede the anchor.
      if (!orderedBefore) break
      predecessor = i
    }
    if (segmentStart === -1) return null
    if (predecessor !== null) return predecessor
    return segmentStart === 0 ? null : segmentStart - 1
  }

  /**
   * Advance fork/reference boundaries off messages that are about to be
   * deleted — always inside the caller's transaction and BEFORE the rows are
   * gone, so the pre-delete route composition supplies the ordering.
   *
   * Every branch anchored at a deleted message moves its boundary to the
   * nearest surviving message before that anchor on its parent route, which is
   * exactly the history the child inherited through the fork point; a
   * reference endpoint on a deleted message advances the same way on its
   * captured source route. When no survivor precedes the anchor the boundary
   * keeps its anchor id: resolution then has no ordering information and
   * inherits nothing, while the branch/reference and the owned suffix stay
   * accessible and writable. Branch and reference rows are never deleted here
   * and no cascade is introduced. Tolerates pre-016/pre-018 databases.
   */
  private advanceInheritanceBoundariesInTx(
    repos: ChatDbRepositories,
    topicId: string,
    deletedMessageIds: string[],
    boundarySnapshots?: InheritanceBoundarySnapshot[]
  ): void {
    if (deletedMessageIds.length === 0) return
    const deleted = new Set(deletedMessageIds)
    // Boundary BEFORE the anchor, skipping every id leaving in this write.
    const predecessorOf = (route: MessageData[], anchorMessageId: string): string | null => {
      const anchorIdx = route.findIndex((m) => m.id === anchorMessageId)
      const boundaryIdx =
        anchorIdx === -1 ? this.deriveInheritanceBoundaryInTx(repos, route, anchorMessageId) : anchorIdx
      if (boundaryIdx === null) return null
      for (let i = boundaryIdx - 1; i >= 0; i--) {
        if (!deleted.has(route[i].id)) return route[i].id
      }
      return null
    }
    // Routes are resolved BEFORE any boundary moves, so the rewrite order can
    // never change another branch's parent composition.
    const pending: Array<{
      kind: 'branch' | 'reference'
      id: string
      anchorMessageId: string
      previousAnchorMessageId: string
    }> = []
    for (const branch of this.listBranchesTolerantInTx(repos, topicId)) {
      if (!deleted.has(branch.anchorMessageId)) continue
      let parentRoute: MessageData[]
      try {
        parentRoute = this.resolveRouteMessagesGuardedInTx(repos, topicId, branch.parentBranchId, new Set<string>(), 0)
      } catch (e) {
        // Broken ancestry stays readable (it resolves with an empty inherited
        // history) and must never block the owner's delete.
        if (e instanceof ChatDbNotFoundError) continue
        throw e
      }
      const next = predecessorOf(parentRoute, branch.anchorMessageId)
      if (next !== null) {
        pending.push({
          kind: 'branch',
          id: branch.id,
          anchorMessageId: next,
          previousAnchorMessageId: branch.anchorMessageId
        })
      }
    }
    for (const reference of this.listReferencesByAnchorTolerantInTx(repos, deletedMessageIds)) {
      if (!deleted.has(reference.anchorMessageId)) continue
      let sourceRoute: MessageData[]
      try {
        sourceRoute = this.resolveRouteMessagesGuardedInTx(
          repos,
          reference.sourceTopicId,
          this.normalizeBranchId(reference.sourceBranchId),
          new Set<string>(),
          0
        )
      } catch (e) {
        if (e instanceof ChatDbNotFoundError) continue
        throw e
      }
      const next = predecessorOf(sourceRoute, reference.anchorMessageId)
      if (next !== null) {
        pending.push({
          kind: 'reference',
          id: reference.targetTopicId,
          anchorMessageId: next,
          previousAnchorMessageId: reference.anchorMessageId
        })
      }
    }
    for (const item of pending) {
      if (item.kind === 'branch') repos.branches.advanceAnchor(item.id, item.anchorMessageId)
      else repos.topicReferences.advanceAnchor(item.id, item.anchorMessageId)
      // The undo restore pair (pre-delete boundary + the value just written).
      // Reported only for boundaries this write actually moved, in rewrite
      // order, so undo never has to guess which relation changed.
      boundarySnapshots?.push({
        kind: item.kind,
        id: item.id,
        anchorMessageId: item.previousAnchorMessageId,
        expectedAnchorMessageId: item.anchorMessageId
      })
    }
  }

  /**
   * Restore inheritance boundaries a delete moved, inside the caller's
   * transaction.
   *
   * Compare-and-set only, using facts the caller cannot invent: the relation
   * must still exist, its current anchor must still equal the value that
   * delete wrote, and the restore target must be a message this same command
   * actually re-inserted. A relation the user has since deleted is never
   * recreated, and a boundary another operation has since moved keeps the
   * newer value.
   *
   * Route sovereignty is decided by real composition, not by topic equality:
   * the route this command restores onto must be part of the route the
   * relation hangs off — the branch's parent route, or the reference's own
   * source route — through structural composition (parent-branch chain and
   * cross-topic reference source). A nested chain (A owns the row, B references
   * A, C references B through that inherited row) therefore restores the B and
   * C endpoints from A's own undo, while an unrelated topic's undo can never
   * address either relation. Composition is structural only (never boundary
   * anchor values), so the restore order inside this transaction cannot change
   * the answer. No unrelated relation is addressable — there is no generic
   * branch/reference write capability here.
   */
  private restoreInheritanceBoundariesInTx(
    repos: ChatDbRepositories,
    topicId: string,
    restores: InheritanceBoundarySnapshot[],
    insertedIds: Set<string>,
    insertBranchId: string | null
  ): InheritanceBoundaryRestoreResult[] {
    const results: InheritanceBoundaryRestoreResult[] = []
    const insertRoute = { topicId, branchId: insertBranchId }
    for (const item of restores) {
      if (item.kind !== 'branch' && item.kind !== 'reference') {
        throw new ChatDbValidationError(`Unsupported inheritance boundary kind: ${String(item.kind)}`)
      }
      const skipped = (skipReason: 'missing' | 'changed'): void => {
        results.push({
          kind: item.kind,
          id: item.id,
          anchorMessageId: item.anchorMessageId,
          restored: false,
          skipReason
        })
      }
      if (item.kind === 'branch') {
        const current = repos.branches.getById(item.id)
        if (!current.found) {
          skipped('missing')
          continue
        }
        if (current.data.topicId !== topicId) {
          throw new ChatDbValidationError(`Branch ${item.id} does not belong to topic ${topicId}`)
        }
        if (current.data.anchorMessageId !== item.expectedAnchorMessageId || !insertedIds.has(item.anchorMessageId)) {
          skipped('changed')
          continue
        }
        // The branch inherits through its PARENT route: the restored anchor is
        // only a legitimate boundary while this command put it back onto a
        // route that parent route composes.
        if (
          !this.routeComposesRouteInTx(repos, topicId, this.normalizeBranchId(current.data.parentBranchId), insertRoute)
        ) {
          skipped('changed')
          continue
        }
        repos.branches.advanceAnchor(item.id, item.anchorMessageId)
      } else {
        const current = repos.topicReferences.getByTarget(item.id)
        if (!current.found) {
          skipped('missing')
          continue
        }
        if (current.data.anchorMessageId !== item.expectedAnchorMessageId || !insertedIds.has(item.anchorMessageId)) {
          skipped('changed')
          continue
        }
        // The endpoint hangs off the reference's SOURCE route, which may be an
        // ancestor of the topic this command writes to (nested references).
        if (
          !this.routeComposesRouteInTx(
            repos,
            current.data.sourceTopicId,
            this.normalizeBranchId(current.data.sourceBranchId),
            insertRoute
          )
        ) {
          skipped('changed')
          continue
        }
        repos.topicReferences.advanceAnchor(item.id, item.anchorMessageId)
      }
      results.push({ kind: item.kind, id: item.id, anchorMessageId: item.anchorMessageId, restored: true })
    }
    return results
  }

  /**
   * Structural route composition: does the effective route of
   * (`topicId`, `branchId`) compose the given route?
   *
   * Composition is followed through structure only — a branch route composes
   * its parent-branch chain, and a topic route composes its cross-topic
   * reference source route. Boundary anchors are deliberately never read: they
   * are exactly what an inheritance restore rewrites, so a membership test
   * that consulted them would make the outcome depend on restore order.
   * Cycle-safe; a missing branch/reference row simply ends that path.
   */
  private routeComposesRouteInTx(
    repos: ChatDbRepositories,
    topicId: string,
    branchId: string | null,
    target: { topicId: string; branchId: string | null },
    visited: Set<string> = new Set<string>()
  ): boolean {
    const key = `${topicId}\u0000${branchId ?? ''}`
    if (visited.has(key)) return false
    visited.add(key)
    if (topicId === target.topicId && branchId === target.branchId) return true
    if (branchId !== null) {
      const branch = repos.branches.getById(branchId)
      if (branch.found && branch.data.topicId === topicId) {
        if (
          this.routeComposesRouteInTx(
            repos,
            topicId,
            this.normalizeBranchId(branch.data.parentBranchId),
            target,
            visited
          )
        ) {
          return true
        }
      }
    }
    const reference = repos.topicReferences.getByTarget(topicId)
    if (reference.found) {
      return this.routeComposesRouteInTx(
        repos,
        reference.data.sourceTopicId,
        this.normalizeBranchId(reference.data.sourceBranchId),
        target,
        visited
      )
    }
    return false
  }

  /** Branch rows of one topic; empty on pre-016 databases (no table). */
  private listBranchesTolerantInTx(repos: ChatDbRepositories, topicId: string): TopicBranchData[] {
    try {
      return repos.branches.listByTopic(topicId)
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return []
      throw e
    }
  }

  /** Reference relations captured on one of `messageIds`; empty on pre-018 databases. */
  private listReferencesByAnchorTolerantInTx(repos: ChatDbRepositories, messageIds: string[]): TopicReferenceData[] {
    try {
      return repos.topicReferences.listByAnchorMessages(messageIds)
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return []
      throw e
    }
  }

  /**
   * Resolve the effective ordered messages for one route: recursively take
   * each ancestor route only through the child anchor, then append messages
   * owned by the current branch. Deterministic sort_order ASC, id ASC order
   * at every level. Stable message IDs are shared; nothing is cloned.
   *
   * Cross-topic history references extend the base: a reference target's
   * effective route additionally begins with a LIVE read-only prefix of the
   * source route through the reference anchor (canonical source IDs/topicId).
   * The target's own main rows and any intra-topic branches compose atop it.
   *
   * `branchId = null` is the main route (base + owned rows). Every branch
   * composes through its inheritance boundary: the original fork point while
   * it still composes the parent route, otherwise the nearest surviving
   * message before it, otherwise no inherited history at all — the branch and
   * its own rows stay readable and writable in every case, and nothing after
   * the original fork point is ever inherited. A missing/gone reference source
   * omits the prefix (status surfaced by metadata).
   */
  private resolveRouteMessagesInTx(
    repos: ChatDbRepositories,
    topicId: string,
    branchId: string | null
  ): { messages: MessageData[]; forkBoundaryIndex: number } {
    const owner = this.normalizeBranchId(branchId)
    const messages = this.resolveRouteMessagesGuardedInTx(repos, topicId, owner, new Set<string>(), 0)
    // Boundary only needs the owned-row count: the route above already
    // materialized the ancestor/reference prefix plus these same own rows, so
    // a second full materialization of the owner route is pure overhead. The
    // count uses the identical route-owner predicate (branch_id IS NULL for
    // the main route, branch_id = owner otherwise).
    const ownCount = repos.messages.countByTopic(topicId, owner)
    return { messages, forkBoundaryIndex: messages.length - ownCount }
  }

  /**
   * True-branch owner-only mutability guard for message writes (BRANCH-4).
   *
   * - Missing rows keep existing no-op semantics (returns false).
   * - Cross-topic references keep legacy skip semantics (returns false) only
   *   for the pure non-branch case: addressed route is main (null), the
   *   foreign row is main-owned (branchId null), and the addressed topic has
   *   no true branches and no history-reference relation. Bulk paths filter to
   *   owned IDs and silently skip those foreign rows. Any branch lineage —
   *   addressed route non-null, foreign row branch-owned, addressed topic with
   *   branches, or a reference target with a read-only foreign prefix — fails
   *   closed with ChatDbValidationError (same logical-topic non-owner
   *   fail-closed applies across topics; never silently ok).
   * - Same-topic rows owned by another route (inherited/read-only reference)
   *   fail closed: descendant routes never mutate ancestor references and
   *   never copy-on-write.
   * - Owned rows are always mutable through their owner route, even when
   *   referenced by live descendants (butterfly effect, BRANCH-5).
   *
   * Returns true when the caller may proceed.
   */
  private assertMutableMessageInTx(
    repos: ChatDbRepositories,
    db: BetterSQLite3Database<typeof schema>,
    topicId: string,
    branchId: string | null,
    messageId: string
  ): boolean {
    const route = this.normalizeBranchId(branchId)
    const ownerRow = repos.messages.getById(messageId)
    if (!ownerRow.found) return false
    const row = ownerRow.data
    if (row.topicId !== topicId) {
      if (
        route !== null ||
        (row.branchId ?? null) !== null ||
        this.topicHasBranchesInTx(db, topicId) ||
        this.topicHasReferenceInTx(db, topicId)
      ) {
        throw new ChatDbValidationError(
          `Message ${messageId} belongs to topic ${row.topicId} and is immutable through topic ${topicId}`
        )
      }
      return false
    }
    if (!isOwnedByRoute(row.topicId, row.branchId, topicId, route)) {
      throw new ChatDbValidationError(
        `Message ${messageId} is shared with another route and is immutable through this route`
      )
    }
    return true
  }

  /**
   * Missing-tolerant mutability guard for block writes via the parent
   * message. Missing blocks/parents keep existing no-op semantics (returns
   * false). When an explicit route is addressed, the parent must belong to
   * exactly that route; block channels without a topic resolve the route
   * from the committed parent (streaming writes under a branch-owned parent
   * stay mutable through their own route).
   */
  private assertMutableBlockInTx(
    repos: ChatDbRepositories,
    db: BetterSQLite3Database<typeof schema>,
    topicId: string | null,
    branchId: string | null,
    blockId: string,
    wireMessageId?: string
  ): boolean {
    const existing = repos.blocks.getById(blockId)
    const parentId = existing.found ? existing.data.messageId : wireMessageId
    if (!parentId) return false
    const parent = repos.messages.getById(parentId)
    if (!parent.found) return false
    if (topicId !== null) {
      return this.assertMutableMessageInTx(repos, db, topicId, branchId, parentId)
    }
    return this.assertMutableMessageInTx(repos, db, parent.data.topicId, parent.data.branchId ?? null, parentId)
  }

  /**
   * BRANCH-4/11: answer-group mutability guard (shared by selectAnswer,
   * selectUseful, reorder, and join-group append).
   *
   * Resolves the complete answer group for `askId` in the addressed route
   * (assistant members in route order) and requires every actually-written
   * assistant member to be owned by the addressed route (owner equality).
   * Reading an ancestor user root or a group member never requires
   * mutability unless that row is itself written/deleted/reordered. A
   * missing root (orphan group) does not reject on its own.
   *
   * Returns the ordered member IDs. Throws (no partial write) on any
   * non-owned member. Call inside the caller's root transaction.
   */
  private assertAnswerGroupMutableInTx(
    _repos: ChatDbRepositories,
    _db: BetterSQLite3Database<typeof schema>,
    topicId: string,
    route: string | null,
    askId: string,
    routeMessages: MessageData[]
  ): string[] {
    const group = routeMessages.filter((m) => m.role === 'assistant' && m.askId === askId)
    if (group.length === 0) {
      throw new ChatDbNotFoundError(`Answer group ${askId} has no actionable members in topic ${topicId}`)
    }
    // Owner equality runs on the same preloaded route rows the caller already
    // resolved — no second owned-row query per group.
    for (const member of group) {
      if (!isOwnedByRoute(member.topicId, member.branchId, topicId, route)) {
        throw new ChatDbValidationError(
          `Message ${member.id} is shared with another route and its answer group is immutable through this route`
        )
      }
    }
    // BRANCH-4: reading the user root never requires mutability. Only rows
    // actually written/deleted/reordered are validated above.
    return group.map((m) => m.id)
  }

  /**
   * S6.2c-1: Main-authoritative branch by stable message anchor.
   *
   * One atomic Main DB transaction:
   * - validates source topic exists
   * - ensures target (create-only, compat)
   * - validates anchor belongs to source
   * - loads source ordered by sort_order ASC, id ASC (listByTopic)
   * - selects prefix through anchor inclusive
   * - clones messages/blocks with fresh IDs preserving order/content/status/overflow/file refs
   * - remaps askId exactly as renderer branch behavior (to cloned parent when included, otherwise unset)
   * - inserts into target atomically using dense order semantics (appendMany)
   * - returns actual cloned wire messages/blocks for renderer projection, no hidden second read
   *
   * Missing/cross-topic anchor fails explicitly with no target partial writes (transaction rollback).
   * Empty prefix impossible because anchor inclusive.
   */
  branchMessagesToTopic(
    sourceTopicId: string,
    targetTopicId: string,
    anchorMessageId: string,
    assistantId?: string,
    sourceBranchId?: string | null
  ): ChatDbResult<{ messages: JsonObject[]; blocks: JsonObject[] }> {
    return wrapResult(() => {
      const sourceRoute = this.normalizeBranchId(sourceBranchId)
      const ctx = this.syncCtxForTopic('branchMessagesToTopic', targetTopicId)
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      let result: { messages: JsonObject[]; blocks: JsonObject[] }
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Validate source exists
          const srcTopic = repos.topics.getById(sourceTopicId)
          if (!srcTopic.found) {
            throw new ChatDbNotFoundError(`Topic ${sourceTopicId} does not exist`)
          }

          // Ensure target (create-only). A missing target topic is
          // represented only via the existing topic upsert semantics (same
          // payload as ensureTopic/appendMessage closure, same tx, no new
          // semantics): true creation emits the topic upsert parent-first;
          // an existing target emits no topic op.
          const topicExistedBefore = repos.topics.getById(targetTopicId).found
          repos.topics.ensure(targetTopicId, assistantId)

          // Validate anchor belongs to the source ROUTE (sidebar Copy Topic
          // uses the main route; an explicitly used in-chat branch route
          // clones its effective prefix instead).
          const allMessages = this.resolveRouteMessagesInTx(repos, sourceTopicId, sourceRoute).messages
          const anchor = allMessages.find((m) => m.id === anchorMessageId)
          if (!anchor) {
            throw new ChatDbNotFoundError(`Anchor message ${anchorMessageId} does not belong to topic ${sourceTopicId}`)
          }
          const anchorIdx = allMessages.findIndex((m) => m.id === anchorMessageId)
          if (anchorIdx === -1) {
            throw new ChatDbNotFoundError(`Anchor message ${anchorMessageId} does not belong to topic ${sourceTopicId}`)
          }
          const prefixMessages = allMessages.slice(0, anchorIdx + 1)
          const prefixIds = prefixMessages.map((m) => m.id)
          const blockMap = repos.blocks.listByMessages(prefixIds)

          // Fresh ID generation preserving order
          const idMap = new Map<string, string>()
          for (const m of prefixMessages) {
            idMap.set(m.id, randomUUID())
          }

          const newMessages: MessageData[] = []
          const allNewBlocks: MessageBlockData[] = []

          for (const oldMsg of prefixMessages) {
            const newId = idMap.get(oldMsg.id)!
            let newAskId: string | null | undefined
            if (oldMsg.role === 'assistant' && oldMsg.askId) {
              const mapped = idMap.get(oldMsg.askId)
              if (mapped) newAskId = mapped
              else newAskId = null
            } else {
              newAskId = oldMsg.askId ?? null
              // For assistant messages whose askId was unset, keep null; for user messages, askId is null
              if (oldMsg.role === 'assistant' && newAskId === null && oldMsg.askId) {
                // already handled above (outside prefix) -> null
              }
              // For non-assistant, preserve original askId (usually null)
              // But if original had askId and is assistant case already handled
            }

            // Clone message data: shallow copy, replace id/topicId/askId, reset
            // branchId to the target main route, preserve overflow and all
            // columns except sortOrder (appendMany reassigns)
            const cloned: MessageData = {
              ...oldMsg,
              id: newId,
              topicId: targetTopicId,
              branchId: null,
              askId: oldMsg.role === 'assistant' ? newAskId : (oldMsg.askId ?? null)
            }
            // Preserve overflow object reference safety: ensure overflow is cloned
            cloned.overflow = { ...oldMsg.overflow }
            newMessages.push(cloned)

            const oldBlocks = blockMap.get(oldMsg.id) ?? []
            // Preserve block order as stored (already sorted by sort_order ASC, id ASC via listByMessages ordering)
            for (const oldBlk of oldBlocks) {
              const newBlkId = randomUUID()
              const clonedBlk: MessageBlockData = {
                ...oldBlk,
                id: newBlkId,
                messageId: newId,
                overflow: { ...oldBlk.overflow }
              }
              allNewBlocks.push(clonedBlk)
            }
          }

          // Insert atomically using existing dense order semantics
          if (newMessages.length > 0) {
            repos.messages.appendMany(newMessages)
          }
          if (allNewBlocks.length > 0) {
            // Group by new message for deterministic upsert order (original prefix order preserved)
            repos.blocks.upsertMany(allNewBlocks)
            this.syncFileReferences(repos, allNewBlocks)
          }

          // Transaction-bound sync intent (same atomic boundary, reused from
          // pasteMessagesToTopic/insertMessagesAfterAnchor). Every cloned ID
          // is a fresh Main-generated true create: stable cloned
          // messages/blocks enqueue full-state upserts (sortOrder removed,
          // final remapped askId verbatim) with true-create-only membership;
          // transient/unsupported emit nothing (durable unsupported outcome
          // for the latter). Source rows emit nothing and are untouched.
          if (ctx) {
            let tsOffset = 0
            const nextTs = (): number => ctx.ts + tsOffset++
            if (!topicExistedBefore) {
              const created = repos.topics.getById(targetTopicId)
              if (!created.found) throw new Error(`branchMessagesToTopic topic ${targetTopicId} missing after ensure`)
              syncService.enqueueUpsertInTx(
                stx,
                'topic',
                targetTopicId,
                this.syncTopicPayload(created.data),
                Math.max(0, ctx.ts - 2),
                ctx.deviceId
              )
              syncNotify = true
            }
            let hasNewInclusion = false
            for (const m of newMessages) {
              const postRow = repos.messages.getById(m.id)
              if (!postRow.found) throw new Error(`branchMessagesToTopic message ${m.id} missing in transaction`)
              if (!isStableMessageStatus(postRow.data.status)) continue
              hasNewInclusion = true
              if (!this.shouldCaptureMessageCreate(postRow.data)) continue
              const opTs = nextTs()
              this.ensureTopicClosureInTx(stx, targetTopicId, opTs, ctx.deviceId)
              const full = this.syncMessagePayloadFull(postRow.data)
              delete full.sortOrder
              const opId = syncService.enqueueUpsertInTx(stx, 'message', m.id, full, opTs, ctx.deviceId)
              syncService.setMembershipClockInTx(stx, 'message', m.id, postRow.data.topicId, opTs, opId)
              syncNotify = true
            }
            for (const blk of allNewBlocks) {
              const postBlk = repos.blocks.getById(blk.id)
              if (!postBlk.found) throw new Error(`branchMessagesToTopic block ${blk.id} missing in transaction`)
              // Blocks under a transient parent never ride the wire: skip
              // without closure (closure would fail closed). The per-parent
              // frame decision below invalidates the transient parent.
              const parentMsg = repos.messages.getById(postBlk.data.messageId)
              if (!parentMsg.found || !isStableMessageStatus(parentMsg.data.status)) continue
              if (!isStableBlockStatus(postBlk.data.status)) continue
              if (this.isUnsupportedBlock(postBlk.data)) {
                unsupportedBlockIds.push(blk.id)
                continue
              }
              const opTs = nextTs()
              this.ensureBlockParentClosureInTx(stx, blk.id, opTs, ctx.deviceId)
              const full = this.syncBlockPayloadFull(postBlk.data)
              delete full.sortOrder
              const opId = syncService.enqueueUpsertInTx(stx, 'message_block', blk.id, full, opTs, ctx.deviceId)
              syncService.setMembershipClockInTx(stx, 'message_block', blk.id, postBlk.data.messageId, opTs, opId)
              syncNotify = true
            }
            // Local parent order frames — at most one topicMessage attempt
            // plus one per new message parent where semantically required.
            // Missing membership or excluded status invalidates with 0 op
            // (truthful partial); malformed/clock/high-water throws and rolls
            // back the whole branch including the ensured topic.
            if (hasNewInclusion) {
              if (
                syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, targetTopicId, ctx.deviceId) === 'refreshed'
              ) {
                syncNotify = true
              }
            }
            for (const m of newMessages) {
              const postMsg = repos.messages.getById(m.id)
              if (!postMsg.found) continue
              if (!isStableMessageStatus(postMsg.data.status)) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', m.id)
                continue
              }
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, m.id, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          } else {
            // Capture disabled: preserve existing truthful invalidation, no ops.
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', targetTopicId)
            {
              const mids = new Set<string>()
              for (const blk of allNewBlocks) mids.add(blk.messageId)
              for (const mid of mids) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
              }
            }
          }

          // Build wire response for renderer projection (no second read)
          const wireMessages = messagesToWire(newMessages)
          const wireBlocks = blocksToWire(allNewBlocks)
          const messagesWithBlocks = reconstructMessageBlockRelations(wireMessages, wireBlocks)
          return { messages: messagesWithBlocks, blocks: wireBlocks }
        })
      } catch (e) {
        this.recordSyncTxFailure('branchMessagesToTopic', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('branchMessagesToTopic', unsupportedBlockIds)
      return result
    }, `branchMessagesToTopic(${sourceTopicId} -> ${targetTopicId}, anchor=${anchorMessageId})`)
  }

  /**
   * Create one topic-internal branch node (the ONLY true-branch creation
   * method).
   *
   * Local-only, no prefix cloning, no wire capture:
   * - validates the logical topic exists (trash rejects) and the parent
   *   route exists (null = main route, otherwise a branch of this topic);
   * - validates the anchor belongs to the parent route's current effective
   *   route AND is owned by the parent route (BRANCH-7 owner-only anchors:
   *   main parent accepts main-owned messages; non-main parent requires
   *   anchor owner == parentBranchId; any inherited reference — including
   *   the parent's own inherited fork anchor — rejects fail-closed);
   * - inserts exactly one `topic_branches` row with the requested name
   *   (default applied by the renderer; Main stores verbatim);
   * - emits NO sync outbox/frame/membership intent and touches no parent
   *   frames, so the branch stays local-only within existing sync
   *   boundaries (no wire contract change);
   * - returns the created node plus the effective wire (shared prefix +
   *   empty suffix) for the renderer projection — a read projection only,
   *   never stored rows. Creating the branch immediately selects it
   *   renderer-side; no topics are created, sidebar untouched.
   *
   * Parent routes, shared messages, and topic state are untouched.
   */
  createBranch(
    topicId: string,
    parentBranchId: string | null | undefined,
    anchorMessageId: string,
    name?: string
  ): ChatDbResult<{ branch: TopicBranchWire; messages: JsonObject[]; blocks: JsonObject[] }> {
    return wrapResult(
      () => {
        // Publish-barrier quiescence still enforced for branch writes; capture
        // itself is always suppressed (local-only) below.
        syncService.throwIfPublishBarrierHeld('createBranch')
        const parentRoute = this.normalizeBranchId(parentBranchId)
        if (!topicId || !anchorMessageId) {
          throw new ChatDbValidationError('createBranch requires topicId and anchorMessageId')
        }
        const result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }
          if (topic.data.deletedAt != null) {
            throw new ChatDbValidationError(`Topic ${topicId} is in trash and cannot fork a branch`)
          }
          if (parentRoute !== null) {
            this.requireBranchInTx(repos, topicId, parentRoute)
          }
          // Anchor must resolve inside the parent route's effective route AND
          // be owned by the parent route (BRANCH-7). A nested branch therefore
          // always includes the parent branch's owned route through the
          // selected anchor; inherited references never fork.
          const parentEffective = this.resolveRouteMessagesInTx(repos, topicId, parentRoute).messages
          if (!parentEffective.some((m) => m.id === anchorMessageId)) {
            throw new ChatDbNotFoundError(
              `Anchor message ${anchorMessageId} does not belong to the parent route of topic ${topicId}`
            )
          }
          const anchorRow = repos.messages.getById(anchorMessageId)
          if (!anchorRow.found || anchorRow.data.topicId !== topicId) {
            throw new ChatDbNotFoundError(
              `Anchor message ${anchorMessageId} does not belong to the parent route of topic ${topicId}`
            )
          }
          if ((anchorRow.data.branchId ?? null) !== parentRoute) {
            throw new ChatDbValidationError(
              `Anchor message ${anchorMessageId} is not owned by the parent route and cannot fork a child branch`
            )
          }
          const now = new Date().toISOString()
          const created = repos.branches.create({
            id: randomUUID(),
            topicId,
            parentBranchId: parentRoute,
            anchorMessageId,
            name: typeof name === 'string' && name.length > 0 ? name : null,
            createdAt: now,
            updatedAt: now,
            overflow: {}
          })
          // Effective projection for the new route (shared prefix, empty suffix).
          const resolved = this.resolveRouteMessagesInTx(repos, topicId, created.id).messages
          const messageIds = resolved.map((m) => m.id)
          const blockDataMap = repos.blocks.listByMessages(messageIds)
          const allBlocks: MessageBlockData[] = []
          for (const id of messageIds) {
            allBlocks.push(...(blockDataMap.get(id) ?? []))
          }
          const wireMessages = messagesToWire(resolved)
          const wireBlocks = blocksToWire(allBlocks)
          return {
            branch: this.branchToWire(
              created,
              this.resolveBranchInheritedBoundaryInTx(repos, topicId, created.parentBranchId, created.anchorMessageId)
            ),
            messages: reconstructMessageBlockRelations(wireMessages, wireBlocks),
            blocks: wireBlocks
          }
        })
        return result
      },
      `createBranch(${topicId}, parent=${this.normalizeBranchId(parentBranchId) ?? 'main'}, anchor=${anchorMessageId})`
    )
  }

  /**
   * Create a new target topic that references a source route through a
   * precise anchor (Reference/Copy = Reference).
   *
   * One atomic Main transaction:
   * - validates the source topic exists (trash rejects) and the source route
   *   exists (null = main route, otherwise a branch of the source topic);
   * - validates the anchor belongs to the source route's current effective
   *   route;
   * - requires the target topic to be distinct and not already present;
   * - creates the target topic AND the one topic-level reference relation
   *   together (no orphan topic on failure);
   * - stores no messages/blocks/files at all: the target's effective route is
   *   a LIVE stable-ID prefix of the source route (canonical source
   *   IDs/topicId) plus its own empty suffix.
   *
   * Local-only: emits NO sync outbox/frame/membership intent (the foreign
   * prefix is not representable in sync); the source topic's own sync stays
   * untouched.
   */
  createReferencedTopic(
    sourceTopicId: string,
    sourceBranchId: string | null | undefined,
    targetTopicId: string,
    anchorMessageId: string,
    assistantId?: string,
    name?: string
  ): ChatDbResult<CreateReferencedTopicResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('createReferencedTopic')
      const sourceRoute = this.normalizeBranchId(sourceBranchId)
      if (!sourceTopicId || !targetTopicId || !anchorMessageId) {
        throw new ChatDbValidationError(
          'createReferencedTopic requires sourceTopicId, targetTopicId, and anchorMessageId'
        )
      }
      if (sourceTopicId === targetTopicId) {
        throw new ChatDbValidationError('createReferencedTopic requires distinct source and target topics')
      }
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const sourceTopic = repos.topics.getById(sourceTopicId)
        if (!sourceTopic.found) {
          throw new ChatDbNotFoundError(`Topic ${sourceTopicId} does not exist`)
        }
        if (sourceTopic.data.deletedAt != null) {
          throw new ChatDbValidationError(`Topic ${sourceTopicId} is in trash and cannot be referenced`)
        }
        if (sourceRoute !== null) {
          this.requireBranchInTx(repos, sourceTopicId, sourceRoute)
        }
        if (repos.topics.getById(targetTopicId).found) {
          throw new ChatDbValidationError(`Reference target topic ${targetTopicId} already exists`)
        }
        // Validate the anchor against the source effective route (recursive,
        // reference-aware: a nested reference source resolves its own base).
        const sourceEffective = this.resolveRouteMessagesInTx(repos, sourceTopicId, sourceRoute).messages
        if (!sourceEffective.some((m) => m.id === anchorMessageId)) {
          throw new ChatDbNotFoundError(
            `Anchor message ${anchorMessageId} does not belong to the source route of topic ${sourceTopicId}`
          )
        }
        const now = new Date().toISOString()
        // Create target topic + relation atomically. No sync intent: this is
        // a local-only reference relation whose foreign prefix is not
        // representable on the wire; the source topic's sync is untouched.
        const targetName = typeof name === 'string' && name.length > 0 ? name : null
        repos.topics.create({
          id: targetTopicId,
          assistantId: assistantId ?? sourceTopic.data.assistantId ?? null,
          name: targetName,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          overflow: {}
        })
        const created = repos.topicReferences.create({
          targetTopicId,
          sourceTopicId,
          sourceBranchId: sourceRoute,
          anchorMessageId,
          createdAt: now,
          updatedAt: now,
          overflow: {}
        })
        // Effective projection for the new route (live foreign prefix, empty
        // owned suffix).
        const resolved = this.resolveRouteMessagesInTx(repos, targetTopicId, null).messages
        const messageIds = resolved.map((m) => m.id)
        const blockDataMap = repos.blocks.listByMessages(messageIds)
        const allBlocks: MessageBlockData[] = []
        for (const id of messageIds) allBlocks.push(...(blockDataMap.get(id) ?? []))
        const wireMessages = messagesToWire(resolved)
        const wireBlocks = blocksToWire(allBlocks)
        return {
          topicId: targetTopicId,
          reference: this.referenceToWire(created, sourceTopic.data.name ?? null),
          messages: reconstructMessageBlockRelations(wireMessages, wireBlocks),
          blocks: wireBlocks
        }
      })
    }, `createReferencedTopic(${sourceTopicId} -> ${targetTopicId}, anchor=${anchorMessageId})`)
  }

  /**
   * Reference target topic IDs transitively staled by one source topic. Used
   * by the IPC layer to fan out history-reference invalidation to renderers.
   *
   * A reference target's live prefix may itself compose a base reference, so
   * a mutation of the base source also stales transitive dependents
   * (target-of-target). The relation graph is walked bounded by
   * MAX_REFERENCE_DEPTH with a visited guard; the origin and repeats are
   * excluded and the result is deterministic (sorted, unique).
   */
  listReferenceTargets(sourceTopicId: string): ChatDbResult<{ sourceTopicId: string; targetTopicIds: string[] }> {
    return wrapResult(() => {
      const repos = this.repos()
      const seen = new Set<string>()
      let frontier: string[] = [sourceTopicId]
      for (let depth = 0; depth < MAX_REFERENCE_DEPTH && frontier.length > 0; depth++) {
        const next: string[] = []
        for (const topicId of frontier) {
          for (const targetId of repos.topicReferences.listTargetsBySource(topicId)) {
            if (targetId === sourceTopicId || seen.has(targetId)) continue
            seen.add(targetId)
            next.push(targetId)
          }
        }
        frontier = next
      }
      return { sourceTopicId, targetTopicIds: [...seen].sort() }
    }, `listReferenceTargets(${sourceTopicId})`)
  }

  /**
   * Same-transaction branch catalog for semantic acknowledgments: every branch
   * row of the topic plus the inherited boundary Main re-derives from the
   * effective routes inside this transaction. Empty when never branched.
   * Tolerates a pre-016 database without the table (empty catalog, never a
   * throw that would fail the enclosing mutation).
   */
  private listBranchCatalogInTx(repos: ChatDbRepositories, topicId: string): TopicBranchWire[] {
    let rows: TopicBranchData[]
    try {
      rows = repos.branches.listByTopic(topicId)
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return []
      throw e
    }
    const routeCache = new Map<string | null, MessageData[] | null>()
    return rows.map((b) =>
      this.branchToWire(
        b,
        this.resolveBranchInheritedBoundaryInTx(repos, topicId, b.parentBranchId, b.anchorMessageId, routeCache)
      )
    )
  }

  /**
   * List all branch nodes of one logical topic in (createdAt, id) order.
   * Pure read; missing topic fails. Empty when never branched.
   */
  listBranches(topicId: string): ChatDbResult<{ topicId: string; branches: TopicBranchWire[] }> {
    return wrapResult(() => {
      const repos = this.repos()
      const topic = repos.topics.getById(topicId)
      if (!topic.found) {
        throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
      }
      let rows: TopicBranchData[]
      try {
        rows = repos.branches.listByTopic(topicId)
      } catch (e) {
        if (e instanceof Error && /no such table/i.test(e.message)) rows = []
        else throw e
      }
      const routeCache = new Map<string | null, MessageData[] | null>()
      return {
        topicId,
        branches: rows.map((b) =>
          this.branchToWire(
            b,
            this.resolveBranchInheritedBoundaryInTx(repos, topicId, b.parentBranchId, b.anchorMessageId, routeCache)
          )
        )
      }
    }, `listBranches(${topicId})`)
  }

  /**
   * Rename a branch node (name-only; identity columns immutable). Branch
   * names live on the branch row — topic rename stays logical and separate.
   * Local-only: no sync intent. Missing branch fails closed.
   */
  renameBranch(topicId: string, branchId: string, name: string): ChatDbResult<{ branch: TopicBranchWire }> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('renameBranch')
      if (!topicId || !branchId || !name) {
        throw new ChatDbValidationError('renameBranch requires topicId, branchId, and a non-empty name')
      }
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        }
        this.requireBranchInTx(repos, topicId, branchId)
        repos.branches.rename(branchId, name)
        const updated = repos.branches.getById(branchId)
        if (!updated.found) {
          throw new ChatDbNotFoundError(`Branch ${branchId} does not exist in topic ${topicId}`)
        }
        return {
          branch: this.branchToWire(
            updated.data,
            this.resolveBranchInheritedBoundaryInTx(
              repos,
              topicId,
              updated.data.parentBranchId,
              updated.data.anchorMessageId
            )
          )
        }
      })
    }, `renameBranch(${topicId}, ${branchId})`)
  }

  /**
   * Delete one branch subtree: the selected branch, all descendant
   * branches, and ONLY the messages/blocks/file references owned by those
   * branch IDs. Shared prefixes and sibling branches survive. Local-only:
   * no sync intent (branch rows never carried clocks); main-route frames
   * are untouched. After deleting the last branch the topic is
   * indistinguishable from a never-branched topic.
   */
  deleteBranch(
    topicId: string,
    branchId: string
  ): ChatDbResult<{
    affectedFileIds: string[]
    remainingReferenceCounts: Record<string, number>
    deletedBranchIds: string[]
    deletedMessageIds: string[]
    deletedBlockIds: string[]
    historySnapshot: BranchDeleteSnapshot
  }> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('deleteBranch')
      if (!topicId || !branchId) {
        throw new ChatDbValidationError('deleteBranch requires topicId and branchId')
      }
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        }
        return this.deleteBranchSubtreeInTx(repos, topicId, branchId)
      })
    }, `deleteBranch(${topicId}, ${branchId})`)
  }

  /**
   * Deterministic subtree delete inside the caller's transaction.
   *
   * Removes ONLY the rows the deleted branches own and returns the complete
   * pre-delete authority snapshot of what left, so the caller can undo it
   * exactly: branch rows (subtree-root first), owned messages/blocks/file
   * references, the segments this write touched (with their ordered
   * membership) plus the topic segment order, and the inheritance boundaries
   * the delete advanced.
   */
  private deleteBranchSubtreeInTx(
    repos: ChatDbRepositories,
    topicId: string,
    branchId: string
  ): {
    affectedFileIds: string[]
    remainingReferenceCounts: Record<string, number>
    deletedBranchIds: string[]
    deletedMessageIds: string[]
    deletedBlockIds: string[]
    historySnapshot: BranchDeleteSnapshot
  } {
    const root = this.requireBranchInTx(repos, topicId, branchId)
    void root
    const subtreeIds = [branchId, ...repos.branches.collectSubtreeIds(branchId)]
    // Owned rows only (main route + sibling subtrees untouched).
    const ownedMessages = subtreeIds.flatMap((bid) => repos.messages.listByTopic(topicId, bid))
    const ownedMessageIds = ownedMessages.map((m) => m.id)
    const blockMap = repos.blocks.listByMessages(ownedMessageIds)
    const ownedBlockIds: string[] = []
    const ownedBlocks: MessageBlockData[] = []
    for (const id of ownedMessageIds) {
      for (const b of blockMap.get(id) ?? []) {
        ownedBlockIds.push(b.id)
        ownedBlocks.push(b)
      }
    }
    const refsBeforeDelete = repos.fileRefs.listByMessages(ownedMessageIds)
    const affectedFileIds = collectAffectedFileIds(refsBeforeDelete)
    // Pre-delete authority snapshot (authority rows only — no renderer state).
    const deletedMessageSet = new Set(ownedMessageIds)
    const segmentsBefore = repos.segments.listByTopic(topicId)
    const touchedSegments: BranchHistorySegmentRow[] = []
    for (const segment of segmentsBefore) {
      const memberIds = repos.segments.getMessageIds(segment.id)
      if (!memberIds.some((id) => deletedMessageSet.has(id))) continue
      touchedSegments.push({
        id: segment.id,
        name: segment.name ?? null,
        createdAt: segment.createdAt ?? null,
        updatedAt: segment.updatedAt ?? null,
        sortOrder: segment.sortOrder,
        headerMessageId: segment.headerMessageId ?? null,
        overflow: (segment.overflow ?? {}) as JsonObject,
        memberIds
      })
    }
    const historySnapshot: BranchDeleteSnapshot = {
      kind: 'delete',
      rootBranchId: branchId,
      // Subtree-root first: the walk is breadth-first, so a parent always
      // precedes its children and a restore can insert rows in order.
      branches: subtreeIds.map((id) => {
        const row = repos.branches.getById(id)
        if (!row.found) throw new ChatDbNotFoundError(`Branch ${id} does not exist in topic ${topicId}`)
        return toBranchHistoryRow(row.data)
      }),
      messages: ownedMessages.map(toMessageHistoryRow),
      blocks: ownedBlocks.map(toBlockHistoryRow),
      fileReferences: refsBeforeDelete.map(toFileReferenceHistoryRow),
      segments: touchedSegments,
      // Filled in after the deletes below: the state this transaction actually
      // leaves behind, which undo must still find in place.
      segmentsAfter: [],
      segmentOrder: segmentsBefore.map((s) => s.id),
      boundaries: []
    }
    // Delete owned messages (FK cascade removes blocks → file refs;
    // per-owner order normalization keeps surviving owners dense).
    if (ownedMessageIds.length > 0) {
      // Subtree rows leave together: boundaries of any branch/reference
      // anchored here advance to the nearest surviving predecessor before
      // the rows disappear (subtree cascades are unchanged).
      this.advanceInheritanceBoundariesInTx(repos, topicId, ownedMessageIds, historySnapshot.boundaries)
      repos.messages.deleteMany(ownedMessageIds)
    }
    // Bind the post-delete segment state Main just emitted (not a renderer
    // guess): emptied segments are gone, surviving ones keep their normalized
    // membership, head, metadata and catalog position.
    historySnapshot.segmentsAfter = touchedSegments.map((segment): BranchHistorySegmentStateRow => {
      const live = repos.segments.getById(segment.id)
      if (!live.found) {
        return { id: segment.id, exists: false, name: null, sortOrder: null, headerMessageId: null, memberIds: [] }
      }
      return {
        id: segment.id,
        exists: true,
        name: live.data.name ?? null,
        sortOrder: live.data.sortOrder,
        headerMessageId: live.data.headerMessageId ?? null,
        memberIds: repos.segments.getMessageIds(segment.id)
      }
    })
    // Delete the branch rows subtree-root first (self-CASCADE backstop;
    // explicit for determinism and pre-016 tolerance).
    repos.branches.deleteSubtreeRows(subtreeIds)
    const cleanup = buildFileCleanupResult(repos, affectedFileIds)
    return {
      affectedFileIds: cleanup.affectedFileIds,
      remainingReferenceCounts: cleanup.remainingReferenceCounts,
      deletedBranchIds: subtreeIds,
      deletedMessageIds: ownedMessageIds,
      deletedBlockIds: ownedBlockIds,
      historySnapshot
    }
  }

  /**
   * Group an effective route message list into whole turns, mirroring the
   * renderer `getMessageGroups` partition: user rows start a new turn,
   * assistant rows join their askId turn (orphans form their own turn),
   * system rows form their own turn. Other roles are ignored for grouping
   * (never selected through the edit UI).
   */
  private groupEffectiveTurnsInTx(messages: MessageData[]): { askId: string; messageIds: string[] }[] {
    const groups: { askId: string; messageIds: string[] }[] = []
    const byAskId = new Map<string, { askId: string; messageIds: string[] }>()
    for (const m of messages) {
      if (m.role === 'user') {
        const g = { askId: m.id, messageIds: [m.id] }
        groups.push(g)
        byAskId.set(m.id, g)
      } else if (m.role === 'assistant' && m.askId) {
        const existing = byAskId.get(m.askId)
        if (existing) {
          existing.messageIds.push(m.id)
        } else {
          const g = { askId: m.askId, messageIds: [m.id] }
          groups.push(g)
          byAskId.set(m.askId, g)
        }
      } else if (m.role === 'system') {
        const g = { askId: m.id, messageIds: [m.id] }
        groups.push(g)
        byAskId.set(m.id, g)
      }
    }
    return groups
  }

  /**
   * Move selected whole turns to a newly created child branch.
   *
   * Purpose-specific ownership move (the only owner-transfer path besides
   * creation stamping): the selected continuous whole turns change owner
   * from the source route to a newly created child branch. Stable IDs,
   * topic, blocks, file references, askId relations and contents are
   * preserved. The new branch anchors at the immutable preceding message.
   * The generic identity-patch path and any general reparent API stay
   * forbidden; the sole purpose-specific exception is this command's
   * anchor-following re-parent, which writes through
   * `BranchesRepository.setParent`.
   *
   * Anchor-following re-parent: a branch whose anchor message is part of the
   * move loses that anchor's ownership to the new branch, so its ancestry is
   * re-pointed to the new branch with the anchor unchanged. That restores the
   * invariant "anchor is on the parent route and owned by it" and leaves the
   * child's effective route verbatim (only the intermediate ownership moves).
   * Descendants keep their own parent and follow by route composition. Cycle
   * and depth guards run before any write, so a rejected move writes nothing.
   *
   * Atomic in one root transaction: branch row + message owners + per-owner
   * dense orders. Any validation failure rejects with zero writes.
   * Local-only: no sync outbox/membership/frame writes; pre-existing main
   * sync artifacts for moved IDs are deliberately left untouched (caveat,
   * outside claim).
   *
   * Context-window inheritance (optional): when the caller supplies the
   * source route's anchor and the assistant window size, the destination
   * anchor is resolved INSIDE this transaction from the PRE-MOVE source route
   * (index-preserving map, default position when the source anchor is missing
   * or out of the destination's range, no anchor for an empty destination).
   * A post-commit resolution would read the already-mutated source route. The
   * resolved key is returned as a fact only; Main never persists renderer
   * assistant settings.
   */
  moveSelectedTurnsToNewBranch(
    topicId: string,
    sourceBranchId: string | null | undefined,
    selectedGroupIds: string[],
    name?: string,
    expectedSelectedMessageIds?: string[],
    contextAnchorInheritance?: MoveContextAnchorInheritanceInput | null
  ): ChatDbResult<{
    branch: TopicBranchWire
    movedMessageIds: string[]
    anchorMessageId: string
    parentMessages: JsonObject[]
    parentBlocks: JsonObject[]
    messages: JsonObject[]
    blocks: JsonObject[]
    resolvedContextAnchorGroupKey?: string | null
    sourceContextAnchorTransfer?: MoveSourceContextAnchorTransfer
    historySnapshot: BranchMoveSnapshot
  }> {
    return wrapResult(
      () => {
        syncService.throwIfPublishBarrierHeld('moveSelectedTurnsToNewBranch')
        const sourceRoute = this.normalizeBranchId(sourceBranchId)
        if (!topicId || !Array.isArray(selectedGroupIds) || selectedGroupIds.length === 0) {
          throw new ChatDbValidationError('moveSelectedTurnsToNewBranch requires topicId and selectedGroupIds')
        }
        const seen = new Set<string>()
        for (const gid of selectedGroupIds) {
          if (typeof gid !== 'string' || gid.length === 0) {
            throw new ChatDbValidationError('moveSelectedTurnsToNewBranch requires non-empty group IDs')
          }
          if (seen.has(gid)) {
            throw new ChatDbValidationError(`Duplicate group ID ${gid} in moveSelectedTurnsToNewBranch selection`)
          }
          seen.add(gid)
        }
        if (!Array.isArray(expectedSelectedMessageIds) || expectedSelectedMessageIds.length === 0) {
          throw new ChatDbValidationError(
            'moveSelectedTurnsToNewBranch requires expectedSelectedMessageIds (exact display-order message IDs)'
          )
        }
        const expectedSeen = new Set<string>()
        for (const mid of expectedSelectedMessageIds) {
          if (typeof mid !== 'string' || mid.length === 0) {
            throw new ChatDbValidationError('moveSelectedTurnsToNewBranch requires non-empty expected message IDs')
          }
          if (expectedSeen.has(mid)) {
            throw new ChatDbValidationError(
              `Duplicate expected message ID ${mid} in moveSelectedTurnsToNewBranch selection`
            )
          }
          expectedSeen.add(mid)
        }
        const result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }
          if (topic.data.deletedAt != null) {
            throw new ChatDbValidationError(`Topic ${topicId} is in trash and cannot move turns to a branch`)
          }
          if (sourceRoute !== null) {
            this.requireBranchInTx(repos, topicId, sourceRoute)
          }
          const effective = this.resolveRouteMessagesInTx(repos, topicId, sourceRoute).messages
          if (effective.length === 0) {
            throw new ChatDbValidationError(`Topic ${topicId} has no messages in the source route`)
          }
          const turns = this.groupEffectiveTurnsInTx(effective)
          const turnIndexByAskId = new Map<string, number>()
          turns.forEach((t, i) => {
            if (!turnIndexByAskId.has(t.askId)) turnIndexByAskId.set(t.askId, i)
          })
          const selectedIndices: number[] = []
          for (const gid of selectedGroupIds) {
            const idx = turnIndexByAskId.get(gid)
            if (idx === undefined) {
              throw new ChatDbValidationError(`Group ${gid} does not belong to the source route of topic ${topicId}`)
            }
            selectedIndices.push(idx)
          }
          selectedIndices.sort((a, b) => a - b)
          for (let i = 1; i < selectedIndices.length; i++) {
            if (selectedIndices[i] - selectedIndices[i - 1] !== 1) {
              throw new ChatDbValidationError('moveSelectedTurnsToNewBranch requires continuous whole turns')
            }
          }
          const firstTurnIdx = selectedIndices[0]
          const lastTurnIdx = selectedIndices[selectedIndices.length - 1]
          const movedIds: string[] = []
          for (let i = firstTurnIdx; i <= lastTurnIdx; i++) {
            movedIds.push(...turns[i].messageIds)
          }
          const effectiveIds = effective.map((m) => m.id)
          const firstMsgIdx = effectiveIds.indexOf(movedIds[0])
          const lastMsgIdx = effectiveIds.indexOf(movedIds[movedIds.length - 1])
          if (firstMsgIdx === -1 || lastMsgIdx === -1 || lastMsgIdx - firstMsgIdx + 1 !== movedIds.length) {
            throw new ChatDbValidationError('moveSelectedTurnsToNewBranch requires continuous whole turns')
          }
          for (let i = firstMsgIdx; i <= lastMsgIdx; i++) {
            if (effectiveIds[i] !== movedIds[i - firstMsgIdx]) {
              throw new ChatDbValidationError('moveSelectedTurnsToNewBranch requires continuous whole turns')
            }
          }
          if (firstMsgIdx === 0) {
            throw new ChatDbValidationError(
              'moveSelectedTurnsToNewBranch requires a preceding anchor message in the source route'
            )
          }
          // Exact expected-selection guard: the authoritative expansion over
          // the COMPLETE source route must equal the renderer's requested
          // display-order IDs exactly. A cropped/orphan/incomplete turn or
          // changed group contents (unseen rows) fails closed with zero
          // writes — never silently move rows the user did not see.
          // A root-resident check alone cannot prove this (an off-window
          // sibling could still be omitted), so the exact ID/order match is
          // required here, inside the same synchronous root transaction.
          if (expectedSelectedMessageIds.length !== movedIds.length) {
            throw new ChatDbValidationError(
              'moveSelectedTurnsToNewBranch expected selection does not match the source route expansion'
            )
          }
          for (let i = 0; i < movedIds.length; i++) {
            if (expectedSelectedMessageIds[i] !== movedIds[i]) {
              throw new ChatDbValidationError(
                'moveSelectedTurnsToNewBranch expected selection does not match the source route expansion'
              )
            }
          }
          const byId = new Map(effective.map((m) => [m.id, m] as const))
          for (const id of movedIds) {
            const row = byId.get(id)
            if (!row || row.topicId !== topicId) {
              throw new ChatDbNotFoundError(`Message ${id} does not belong to topic ${topicId}`)
            }
            if ((row.branchId ?? null) !== sourceRoute) {
              throw new ChatDbValidationError(
                `Message ${id} is not owned by the source route and cannot move to a new branch`
              )
            }
          }
          const anchorId = effectiveIds[firstMsgIdx - 1]
          const anchorRow = byId.get(anchorId)
          if (!anchorRow || (anchorRow.branchId ?? null) !== sourceRoute) {
            throw new ChatDbValidationError(
              `Preceding anchor ${anchorId} is not owned by the source route and cannot fork a child branch`
            )
          }
          // Anchor-following re-parent (ADR §5.3). A branch whose anchor is part of
          // this move loses that anchor to the new branch. Leaving its parent alone
          // would drop it into the missing-anchor degradation (§4.3) and silently
          // truncate the history it inherited, so re-point it to the new branch with
          // an unchanged anchor: the anchor is then owned by the new branch and still
          // inside that route, which restores the §5.1 invariant and preserves the
          // child's effective route verbatim.
          const movedSet = new Set(movedIds)
          const branchRows = this.listBranchesTolerantInTx(repos, topicId)
          const reparentTargets = branchRows.filter((b) => movedSet.has(b.anchorMessageId))
          if (reparentTargets.length > 0) {
            // Cycle guard: a re-parented branch becomes a child of the new branch,
            // whose own parent is the source route, so it must not sit on that
            // route's ancestry. Moved rows are all source-owned, so this is defensive.
            const forbidden = new Set<string>(
              sourceRoute === null ? [] : [sourceRoute, ...repos.branches.ancestorsOf(sourceRoute).map((b) => b.id)]
            )
            for (const target of reparentTargets) {
              if (forbidden.has(target.id)) {
                throw new ChatDbValidationError(
                  `Branch ${target.id} owns the source route ancestry and cannot be re-parented`
                )
              }
            }
            // Depth guard: re-parenting deepens every node of the target subtree by
            // one ancestor. The real capacity is MAX_BRANCH_DEPTH - 1, not
            // MAX_BRANCH_DEPTH: `ancestorsOf` iterates at most MAX_BRANCH_DEPTH times
            // (`depth < MAX_BRANCH_DEPTH`) and its first iteration visits the branch
            // itself without pushing, so at most MAX_BRANCH_DEPTH - 1 ancestors can
            // ever be returned. A node with MAX_BRANCH_DEPTH ancestors is therefore
            // unresolvable — route composition would silently truncate its root-most
            // ancestor — so the guard sits on MAX_BRANCH_DEPTH - 1. Measured exactly
            // rather than with `ancestorsOf`, which saturates at the very limit it is
            // checked against: the target's own count is exact (it is a direct child
            // of the source route) and the subtree depth comes from a bounded
            // breadth-first descent.
            const maxResolvableAncestors = MAX_BRANCH_DEPTH - 1
            for (const target of reparentTargets) {
              const targetAncestors = repos.branches.ancestorsOf(target.id).length
              let subtreeDepth = 0
              let frontier: string[] = [target.id]
              const visited = new Set<string>([target.id])
              for (let level = 1; level <= MAX_BRANCH_DEPTH + 1 && frontier.length > 0; level++) {
                const next: string[] = []
                for (const id of frontier) {
                  for (const child of repos.branches.listChildrenOf(id)) {
                    if (visited.has(child.id)) continue
                    visited.add(child.id)
                    next.push(child.id)
                  }
                }
                if (next.length > 0) subtreeDepth = level
                frontier = next
              }
              if (targetAncestors + 1 + subtreeDepth > maxResolvableAncestors) {
                throw new ChatDbValidationError(
                  `Re-parenting branch ${target.id} would exceed the maximum resolvable branch depth (${maxResolvableAncestors} ancestors)`
                )
              }
            }
          }
          const segments = repos.segments.listByTopic(topicId)
          for (const seg of segments) {
            const memberIds = repos.segments.getMessageIds(seg.id)
            if (memberIds.length === 0) continue
            let inside = 0
            for (const mid of memberIds) {
              if (movedSet.has(mid)) inside++
            }
            if (inside > 0 && inside < memberIds.length) {
              throw new ChatDbValidationError(
                `Segment ${seg.id} cuts through the move selection and cannot move to a new branch`
              )
            }
          }
          // Replay facts captured BEFORE any write: the complete pre-move
          // source-owner order (undo restores it, redo re-splits it) and the
          // ancestry each anchored child had before it followed its anchor.
          const sourceOrderBefore = effective.filter((m) => (m.branchId ?? null) === sourceRoute).map((m) => m.id)
          const reparentParentBefore = new Map<string, string | null>(
            reparentTargets.map((target) => [target.id, target.parentBranchId ?? null])
          )
          const now = new Date().toISOString()
          const newBranchId = randomUUID()
          const created = repos.branches.create({
            id: newBranchId,
            topicId,
            parentBranchId: sourceRoute,
            anchorMessageId: anchorId,
            name: typeof name === 'string' && name.length > 0 ? name : null,
            createdAt: now,
            updatedAt: now,
            overflow: {}
          })
          const executor = tx as unknown as {
            update: (table: unknown) => {
              set: (values: unknown) => { where: (cond: unknown) => { run: () => void } }
            }
          }
          for (let i = 0; i < movedIds.length; i++) {
            executor
              .update(schema.messages)
              // deno-lint-ignore no-explicit-any
              .set({ branchId: newBranchId, sortOrder: i } as any)
              // deno-lint-ignore no-explicit-any
              .where(eq(schema.messages.id, movedIds[i]) as any)
              .run()
          }
          // Applied in the same root transaction so the branch tree and the message
          // owners can never be observed apart.
          for (const target of reparentTargets) {
            repos.branches.setParent(target.id, newBranchId)
          }
          const remainingSourceIds = effective
            .filter((m) => !movedSet.has(m.id) && (m.branchId ?? null) === sourceRoute)
            .map((m) => m.id)
          // Re-read source owner order defensively, then normalize dense.
          // The in-memory filter above already preserves authority order.
          for (let i = 0; i < remainingSourceIds.length; i++) {
            executor
              .update(schema.messages)
              // deno-lint-ignore no-explicit-any
              .set({ sortOrder: i } as any)
              // deno-lint-ignore no-explicit-any
              .where(eq(schema.messages.id, remainingSourceIds[i]) as any)
              .run()
          }
          const parentEffective = this.resolveRouteMessagesInTx(repos, topicId, sourceRoute).messages
          const childEffective = this.resolveRouteMessagesInTx(repos, topicId, newBranchId).messages
          const parentIds = parentEffective.map((m) => m.id)
          const childIds = childEffective.map((m) => m.id)
          const parentBlockMap = repos.blocks.listByMessages(parentIds)
          const childBlockMap = repos.blocks.listByMessages(childIds)
          const parentBlocks: MessageBlockData[] = []
          for (const id of parentIds) {
            parentBlocks.push(...(parentBlockMap.get(id) ?? []))
          }
          const childBlocks: MessageBlockData[] = []
          for (const id of childIds) {
            childBlocks.push(...(childBlockMap.get(id) ?? []))
          }
          const parentWireMessages = messagesToWire(parentEffective)
          const parentWireBlocks = blocksToWire(parentBlocks)
          const childWireMessages = messagesToWire(childEffective)
          const childWireBlocks = blocksToWire(childBlocks)
          // Context-window inheritance fact (optional): resolved from the
          // PRE-MOVE source route (`effective`, captured before any write) into
          // the destination route (`childEffective`) by index. A post-commit
          // resolution would read the mutated source route and silently fall
          // back to the default window position.
          let resolvedContextAnchorGroupKey: string | null | undefined
          let sourceContextAnchorTransfer: { fromGroupKey: string; toGroupKey: string | null } | undefined
          if (contextAnchorInheritance) {
            const sourceAnchorGroupKey =
              typeof contextAnchorInheritance.sourceAnchorGroupKey === 'string' &&
              contextAnchorInheritance.sourceAnchorGroupKey.length > 0
                ? contextAnchorInheritance.sourceAnchorGroupKey
                : null
            const contextCount =
              typeof contextAnchorInheritance.contextCount === 'number' ? contextAnchorInheritance.contextCount : null
            const sourceTurnsBefore = buildContextAnchorTurns(effective)
            const destinationTurns = buildContextAnchorTurns(childEffective)
            if (destinationTurns.length === 0) {
              // Empty destination route has no anchor (I-1).
              resolvedContextAnchorGroupKey = null
            } else {
              const sourceIdx =
                sourceAnchorGroupKey !== null
                  ? resolveContextAnchorTurnIndex(sourceTurnsBefore, sourceAnchorGroupKey)
                  : -1
              resolvedContextAnchorGroupKey =
                sourceIdx !== -1 && sourceIdx < destinationTurns.length
                  ? // In range: index map only, never a `contextCount` recompute.
                    destinationTurns[sourceIdx].key
                  : // Missing/invalid source anchor or out of range: the CURRENT
                    // `contextCount` default position, never clamped to last.
                    destinationTurns[resolveContextAnchorDefaultIndex(destinationTurns.length, contextCount)].key
            }
            // Source-route anchor repair (context-window governance §9,
            // deterministic delete transfer). Only when the caller supplied an
            // ACTIVE source anchor that the move actually removed from the
            // source route: the anchor turn was part of the selection. A
            // surviving anchor (or a key that names no source turn) produces NO
            // fact — the caller must never rebuild/rewrite the source anchor.
            if (sourceAnchorGroupKey !== null) {
              const sourceTurnsAfter = buildContextAnchorTurns(parentEffective)
              const beforeIdx = resolveContextAnchorTurnIndex(sourceTurnsBefore, sourceAnchorGroupKey)
              const survives = resolveContextAnchorTurnIndex(sourceTurnsAfter, sourceAnchorGroupKey) !== -1
              if (beforeIdx !== -1 && !survives) {
                // Deleted anchor turn: fall to the nearest SURVIVING OLDER turn
                // by stable group identity — scan the PRE-move order backwards
                // from the anchor and pick the first turn that still exists in
                // the post-move source route. Index arithmetic against the
                // post list is wrong: removing a contiguous range compresses
                // it, so `beforeIdx - 1` can run past the end (throw/rollback)
                // or land on a NEWER turn (before=[A..F], anchor E, moved D,E
                // → after=[A,B,C,F]; index 3 would wrongly pick F).
                const survivingAfter = new Set(sourceTurnsAfter.map((t) => t.key))
                let toGroupKey: string | null = null
                for (let i = beforeIdx - 1; i >= 0; i--) {
                  const candidate = sourceTurnsBefore[i].key
                  if (survivingAfter.has(candidate)) {
                    toGroupKey = candidate
                    break
                  }
                }
                // No older surviving turn (deleted first group, or every older
                // turn was moved too): the post-route's first turn; an emptied
                // source route loses its anchor. Never the `contextCount`
                // default — an anchor migration is not a re-anchoring.
                if (toGroupKey === null) {
                  toGroupKey = sourceTurnsAfter.length > 0 ? sourceTurnsAfter[0].key : null
                }
                sourceContextAnchorTransfer = { fromGroupKey: sourceAnchorGroupKey, toGroupKey }
              }
            }
          }
          return {
            branch: this.branchToWire(
              created,
              this.resolveBranchInheritedBoundaryInTx(repos, topicId, created.parentBranchId, created.anchorMessageId)
            ),
            movedMessageIds: [...movedIds],
            anchorMessageId: anchorId,
            parentMessages: reconstructMessageBlockRelations(parentWireMessages, parentWireBlocks),
            parentBlocks: parentWireBlocks,
            messages: reconstructMessageBlockRelations(childWireMessages, childWireBlocks),
            blocks: childWireBlocks,
            ...(contextAnchorInheritance ? { resolvedContextAnchorGroupKey } : {}),
            ...(sourceContextAnchorTransfer ? { sourceContextAnchorTransfer } : {}),
            historySnapshot: {
              kind: 'move' as const,
              branch: toBranchHistoryRow(created),
              sourceBranchId: sourceRoute,
              movedMessageIds: [...movedIds],
              sourceOrderBefore,
              reparented: reparentTargets.map((target) => ({
                branchId: target.id,
                parentBefore: reparentParentBefore.get(target.id) ?? null,
                parentAfter: newBranchId
              }))
            }
          }
        })
        return result
      },
      `moveSelectedTurnsToNewBranch(${topicId}, source=${this.normalizeBranchId(sourceBranchId) ?? 'main'}, groups=${Array.isArray(selectedGroupIds) ? selectedGroupIds.length : 0})`
    )
  }

  /**
   * Replay one recorded branch operation in the requested direction.
   *
   * Main owns every write; the renderer only keeps the in-memory session
   * history. A snapshot is the exact authority payload the original mutation
   * returned, so a replay is a bounded, operation-scoped reversible contract —
   * never a generic write capability. Every direction is guarded against the
   * current authority state inside ONE transaction and fails closed with zero
   * writes when anything it depends on has changed, so concurrent or unrelated
   * edits are never overwritten. Identities, ordering, ownership, ancestry,
   * segments and inheritance boundaries round-trip verbatim: no new IDs, no
   * re-derivation from renderer windows, no schema change.
   */
  replayBranchOperation(
    topicId: string,
    direction: BranchOperationDirection,
    snapshot: BranchOperationSnapshot
  ): ChatDbResult<ReplayBranchOperationResponse> {
    return wrapResult(
      () => {
        syncService.throwIfPublishBarrierHeld('replayBranchOperation')
        if (!topicId) {
          throw new ChatDbValidationError('replayBranchOperation requires topicId')
        }
        if (direction !== 'undo' && direction !== 'redo') {
          throw new ChatDbValidationError(`Unsupported branch replay direction: ${String(direction)}`)
        }
        if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
          throw new ChatDbValidationError('replayBranchOperation requires a branch operation snapshot')
        }
        const kind = snapshot.kind
        return this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }
          let replayed: ReplayBranchRows
          switch (kind) {
            case 'create':
              replayed = this.replayBranchCreateInTx(repos, topicId, direction, snapshot)
              break
            case 'rename':
              replayed = this.replayBranchRenameInTx(repos, topicId, direction, snapshot)
              break
            case 'move':
              replayed = this.replayBranchMoveInTx(repos, tx, topicId, direction, snapshot)
              break
            case 'delete':
              replayed = this.replayBranchDeleteInTx(repos, tx, topicId, direction, snapshot)
              break
            default:
              throw new ChatDbValidationError(
                `Unsupported branch operation kind: ${String((snapshot as { kind?: unknown }).kind)}`
              )
          }
          return {
            topicId,
            kind,
            direction,
            branchIds: replayed.branchIds,
            messageIds: replayed.messageIds
          }
        })
      },
      `replayBranchOperation(${topicId}, ${String(direction)}, ${String(
        (snapshot as { kind?: unknown } | null | undefined)?.kind
      )})`
    )
  }

  /**
   * Owner of one message row.
   *
   * Ownership is identity-class and no repository exposes an owner change, so
   * the replay writes that column directly inside its own transaction. The
   * recorded dense order is always re-applied through
   * `MessagesRepository.replaceOrder` afterwards, never trusted row by row.
   */
  private setMessageOwnerInTx(tx: unknown, messageId: string, branchId: string | null): void {
    const executor = tx as RawRowExecutor
    executor
      .update(schema.messages)
      // deno-lint-ignore no-explicit-any
      .set({ branchId } as any)
      // deno-lint-ignore no-explicit-any
      .where(eq(schema.messages.id, messageId) as any)
      .run()
  }

  /** Re-pin the dense topic segment catalog order exactly as recorded. */
  private assignSegmentOrdersInTx(tx: unknown, orderedIds: string[]): void {
    const executor = tx as RawRowExecutor
    for (let i = 0; i < orderedIds.length; i++) {
      executor
        .update(schema.topicSegments)
        // deno-lint-ignore no-explicit-any
        .set({ sortOrder: i } as any)
        // deno-lint-ignore no-explicit-any
        .where(eq(schema.topicSegments.id, orderedIds[i]) as any)
        .run()
    }
  }

  /** Guard: two ID collections must name exactly the same rows. */
  private assertSameIdSet(actual: string[], expected: string[], what: string): void {
    const actualSet = new Set(actual)
    const expectedSet = new Set(expected)
    let same = actualSet.size === expectedSet.size
    if (same) {
      for (const id of expectedSet) {
        if (!actualSet.has(id)) {
          same = false
          break
        }
      }
    }
    if (!same) {
      throw new ChatDbValidationError(`Branch replay guard failed: ${what} changed since the operation`)
    }
  }

  /**
   * Operation-scoped closure check for a delete snapshot.
   *
   * The wire contract validates field shapes only; this is the authority-side
   * check that the payload is ONE coherent operation over the addressed topic,
   * so the replay command can never write rows outside it: messages owned by a
   * captured subtree branch of this topic, blocks owned by captured messages,
   * file references on captured blocks, and segment membership/heads/order
   * confined to captured rows or live rows of this topic. Every replay variant
   * (undo and redo) runs it before any write, so a malformed relationship fails
   * closed with zero writes instead of inserting a foreign row.
   */
  private assertDeleteSnapshotClosedInTx(
    repos: ChatDbRepositories,
    topicId: string,
    snapshot: BranchDeleteSnapshot
  ): void {
    const branches = snapshot.branches ?? []
    const messages = snapshot.messages ?? []
    const blocks = snapshot.blocks ?? []
    const fileReferences = snapshot.fileReferences ?? []
    const segments = snapshot.segments ?? []
    const segmentsAfter = snapshot.segmentsAfter ?? []
    const capturedBranchIds = new Set<string>()
    for (const row of branches) {
      if (capturedBranchIds.has(row.id)) {
        throw new ChatDbValidationError(`Branch ${row.id} appears twice in the delete snapshot`)
      }
      if (row.id === snapshot.rootBranchId) {
        // The deleted subtree may hang off a surviving parent; it must never be
        // its own ancestor.
        if (row.parentBranchId === row.id) {
          throw new ChatDbValidationError(`Root branch ${row.id} in the delete snapshot is its own parent`)
        }
      } else if (row.parentBranchId === null || !capturedBranchIds.has(row.parentBranchId)) {
        // Rows are subtree-root first, so a non-root row must join the captured
        // tree: a parent outside the set would import a foreign branch.
        throw new ChatDbValidationError(`Branch ${row.id} in the delete snapshot is not part of the captured subtree`)
      }
      capturedBranchIds.add(row.id)
    }
    const capturedMessageIds = new Set<string>()
    for (const row of messages) {
      if (capturedMessageIds.has(row.id)) {
        throw new ChatDbValidationError(`Message ${row.id} appears twice in the delete snapshot`)
      }
      if (row.topicId !== topicId) {
        throw new ChatDbValidationError(`Message ${row.id} in the delete snapshot belongs to another topic`)
      }
      if (row.branchId === null || !capturedBranchIds.has(row.branchId)) {
        throw new ChatDbValidationError(`Message ${row.id} in the delete snapshot is not owned by a deleted branch`)
      }
      capturedMessageIds.add(row.id)
    }
    const capturedBlockIds = new Set<string>()
    for (const row of blocks) {
      if (capturedBlockIds.has(row.id)) {
        throw new ChatDbValidationError(`Block ${row.id} appears twice in the delete snapshot`)
      }
      if (!capturedMessageIds.has(row.messageId)) {
        throw new ChatDbValidationError(
          `Block ${row.id} in the delete snapshot belongs to a message this delete did not remove`
        )
      }
      capturedBlockIds.add(row.id)
    }
    const seenFileReferenceIds = new Set<string>()
    for (const row of fileReferences) {
      if (seenFileReferenceIds.has(row.id)) {
        throw new ChatDbValidationError(`File reference ${row.id} appears twice in the delete snapshot`)
      }
      if (!capturedBlockIds.has(row.blockId)) {
        throw new ChatDbValidationError(
          `File reference ${row.id} in the delete snapshot belongs to a block this delete did not remove`
        )
      }
      seenFileReferenceIds.add(row.id)
    }
    const liveMessageIds = new Set(repos.messages.listAllByTopic(topicId).map((row) => row.id))
    const isTopicMessage = (messageId: string): boolean =>
      capturedMessageIds.has(messageId) || liveMessageIds.has(messageId)
    const capturedSegmentIds = new Set<string>()
    for (const row of segments) {
      if (capturedSegmentIds.has(row.id)) {
        throw new ChatDbValidationError(`Segment ${row.id} appears twice in the delete snapshot`)
      }
      for (const memberId of row.memberIds ?? []) {
        if (!isTopicMessage(memberId)) {
          throw new ChatDbValidationError(
            `Segment ${row.id} in the delete snapshot lists message ${memberId} outside topic ${topicId}`
          )
        }
      }
      if (row.headerMessageId !== null && !isTopicMessage(row.headerMessageId)) {
        throw new ChatDbValidationError(
          `Segment ${row.id} in the delete snapshot heads at message ${row.headerMessageId} outside topic ${topicId}`
        )
      }
      capturedSegmentIds.add(row.id)
    }
    if (segmentsAfter.length !== segments.length) {
      throw new ChatDbValidationError('Delete snapshot must carry the post-delete state of every touched segment')
    }
    for (const row of segmentsAfter) {
      if (!capturedSegmentIds.has(row.id)) {
        throw new ChatDbValidationError(`Post-delete state for segment ${row.id} is not part of the delete snapshot`)
      }
      for (const memberId of row.memberIds ?? []) {
        if (!isTopicMessage(memberId)) {
          throw new ChatDbValidationError(
            `Post-delete segment ${row.id} lists message ${memberId} outside topic ${topicId}`
          )
        }
      }
    }
    const recordedOrder = snapshot.segmentOrder ?? []
    if (new Set(recordedOrder).size !== recordedOrder.length) {
      throw new ChatDbValidationError('Delete snapshot segment order repeats a segment')
    }
    const liveSegmentIds = new Set(repos.segments.listByTopic(topicId).map((row) => row.id))
    for (const id of recordedOrder) {
      if (!capturedSegmentIds.has(id) && !liveSegmentIds.has(id)) {
        throw new ChatDbValidationError(`Segment ${id} in the delete snapshot order is outside topic ${topicId}`)
      }
    }
    for (const boundary of snapshot.boundaries ?? []) {
      if (boundary.kind === 'branch') {
        const branch = repos.branches.getById(boundary.id)
        if (branch.found && branch.data.topicId !== topicId) {
          throw new ChatDbValidationError(
            `Boundary branch ${boundary.id} in the delete snapshot belongs to another topic`
          )
        }
      }
      for (const anchor of [boundary.anchorMessageId, boundary.expectedAnchorMessageId]) {
        if (!isTopicMessage(anchor)) {
          throw new ChatDbValidationError(
            `Boundary ${boundary.kind} ${boundary.id} anchors at message ${anchor} outside topic ${topicId}`
          )
        }
      }
    }
  }

  /**
   * Undo may restore a touched segment's pre-delete membership/head only while
   * the live segment still holds exactly the state the delete left behind.
   *
   * Anything else — a member removed or added, a changed head, name or catalog
   * position, or the segment deleted again — is newer user state: the replay
   * fails closed with zero writes (and stays retryable) instead of overwriting
   * it. Only the segments this delete touched are compared.
   */
  private assertSegmentPostDeleteStateInTx(
    repos: ChatDbRepositories,
    segmentsAfter: BranchHistorySegmentStateRow[]
  ): void {
    for (const row of segmentsAfter) {
      const live = repos.segments.getById(row.id)
      if (!row.exists) {
        if (live.found) {
          throw new ChatDbValidationError(`Segment ${row.id} exists again; the delete can no longer be undone`)
        }
        continue
      }
      if (!live.found) {
        throw new ChatDbValidationError(`Segment ${row.id} no longer exists; the delete can no longer be undone`)
      }
      const recordedMembers = row.memberIds ?? []
      const liveMembers = repos.segments.getMessageIds(row.id)
      const sameMembers =
        liveMembers.length === recordedMembers.length && liveMembers.every((id, i) => id === recordedMembers[i])
      if (
        (live.data.name ?? null) !== row.name ||
        live.data.sortOrder !== row.sortOrder ||
        (live.data.headerMessageId ?? null) !== row.headerMessageId ||
        !sameMembers
      ) {
        throw new ChatDbValidationError(
          `Segment ${row.id} changed after the delete; the delete can no longer be undone`
        )
      }
    }
  }

  /** Replay a branch-creation snapshot (undo removes it, redo re-inserts it). */
  private replayBranchCreateInTx(
    repos: ChatDbRepositories,
    topicId: string,
    direction: BranchOperationDirection,
    snapshot: BranchCreateSnapshot
  ): ReplayBranchRows {
    const target = snapshot.branch
    if (!target?.id || !target.anchorMessageId) {
      throw new ChatDbValidationError('Create snapshot is missing the branch identity')
    }
    const current = repos.branches.getById(target.id)
    if (direction === 'redo') {
      if (current.found) {
        throw new ChatDbValidationError(`Branch ${target.id} already exists; the creation can no longer be redone`)
      }
      if (target.parentBranchId !== null) {
        this.requireBranchInTx(repos, topicId, target.parentBranchId)
      }
      if (!repos.messages.getInTopic(target.anchorMessageId, topicId).found) {
        throw new ChatDbNotFoundError(
          `Anchor message ${target.anchorMessageId} does not exist in topic ${topicId}; the creation can no longer be redone`
        )
      }
      repos.branches.create({
        id: target.id,
        topicId,
        parentBranchId: target.parentBranchId ?? null,
        anchorMessageId: target.anchorMessageId,
        name: target.name ?? null,
        createdAt: target.createdAt ?? null,
        updatedAt: target.updatedAt ?? null,
        overflow: target.overflow ?? {}
      })
      return { branchIds: [target.id], messageIds: [] }
    }
    if (!current.found) {
      throw new ChatDbValidationError(`Branch ${target.id} no longer exists; the creation can no longer be undone`)
    }
    if (current.data.topicId !== topicId) {
      throw new ChatDbValidationError(`Branch ${target.id} does not belong to topic ${topicId}`)
    }
    if (
      (current.data.parentBranchId ?? null) !== (target.parentBranchId ?? null) ||
      current.data.anchorMessageId !== target.anchorMessageId ||
      (current.data.name ?? null) !== (target.name ?? null)
    ) {
      throw new ChatDbValidationError(
        `Branch ${target.id} changed since it was created; the creation can no longer be undone`
      )
    }
    // Only an empty leaf is still "the branch this action created": owned
    // messages or child branches are user work this action never produced.
    if (repos.messages.listByTopic(topicId, target.id).length > 0) {
      throw new ChatDbValidationError(`Branch ${target.id} owns messages; the creation can no longer be undone`)
    }
    if (repos.branches.listChildrenOf(target.id).length > 0) {
      throw new ChatDbValidationError(`Branch ${target.id} has child branches; the creation can no longer be undone`)
    }
    const removed = repos.branches.deleteSubtreeRows([target.id])
    if (removed.affected !== 1) {
      throw new ChatDbValidationError(`Branch ${target.id} could not be removed`)
    }
    return { branchIds: [target.id], messageIds: [] }
  }

  /** Replay a branch-rename snapshot: compare-and-set on the recorded names. */
  private replayBranchRenameInTx(
    repos: ChatDbRepositories,
    topicId: string,
    direction: BranchOperationDirection,
    snapshot: BranchRenameSnapshot
  ): ReplayBranchRows {
    if (!snapshot.branchId) {
      throw new ChatDbValidationError('Rename snapshot is missing the branch identity')
    }
    const current = repos.branches.getById(snapshot.branchId)
    if (!current.found) {
      throw new ChatDbNotFoundError(`Branch ${snapshot.branchId} does not exist in topic ${topicId}`)
    }
    if (current.data.topicId !== topicId) {
      throw new ChatDbValidationError(`Branch ${snapshot.branchId} does not belong to topic ${topicId}`)
    }
    const expected = (direction === 'undo' ? snapshot.afterName : snapshot.beforeName) ?? null
    const next = (direction === 'undo' ? snapshot.beforeName : snapshot.afterName) ?? null
    if ((current.data.name ?? null) !== expected) {
      throw new ChatDbValidationError(
        `Branch ${snapshot.branchId} was renamed again since this rename; the rename can no longer be replayed`
      )
    }
    repos.branches.rename(snapshot.branchId, next)
    return { branchIds: [snapshot.branchId], messageIds: [] }
  }

  /**
   * Replay a move-to-new-branch snapshot.
   *
   * Undo puts the moved rows back where they came from (source ownership and
   * recorded order, anchored children re-parented back, the created branch
   * removed). Redo re-creates the same branch identity, re-splits the source
   * route deterministically and re-points the anchored children. Both
   * directions require the moved set and the source rows to still be exactly
   * what the move left behind.
   */
  private replayBranchMoveInTx(
    repos: ChatDbRepositories,
    tx: unknown,
    topicId: string,
    direction: BranchOperationDirection,
    snapshot: BranchMoveSnapshot
  ): ReplayBranchRows {
    const created = snapshot.branch
    if (!created?.id || !created.anchorMessageId) {
      throw new ChatDbValidationError('Move snapshot is missing the created branch identity')
    }
    const movedMessageIds = snapshot.movedMessageIds ?? []
    if (movedMessageIds.length === 0) {
      throw new ChatDbValidationError('Move snapshot carries no moved messages')
    }
    const sourceBranchId = snapshot.sourceBranchId ?? null
    const movedSet = new Set(movedMessageIds)
    const current = repos.branches.getById(created.id)
    if (direction === 'undo') {
      if (!current.found) {
        throw new ChatDbValidationError(`Branch ${created.id} no longer exists; the move can no longer be undone`)
      }
      if (current.data.topicId !== topicId) {
        throw new ChatDbValidationError(`Branch ${created.id} does not belong to topic ${topicId}`)
      }
      if (
        (current.data.parentBranchId ?? null) !== sourceBranchId ||
        current.data.anchorMessageId !== created.anchorMessageId
      ) {
        throw new ChatDbValidationError(`Branch ${created.id} changed since the move; the move can no longer be undone`)
      }
      if (sourceBranchId !== null) {
        this.requireBranchInTx(repos, topicId, sourceBranchId)
      }
      const ownedNow = repos.messages.listByTopic(topicId, created.id).map((m) => m.id)
      if (ownedNow.length !== movedMessageIds.length || ownedNow.some((id, index) => id !== movedMessageIds[index])) {
        throw new ChatDbValidationError(
          `Branch ${created.id} no longer holds exactly the moved messages; the move can no longer be undone`
        )
      }
      const reparentedIds = new Set((snapshot.reparented ?? []).map((entry) => entry.branchId))
      for (const child of repos.branches.listChildrenOf(created.id)) {
        if (!reparentedIds.has(child.id)) {
          throw new ChatDbValidationError(
            `Branch ${child.id} was created under ${created.id}; the move can no longer be undone`
          )
        }
      }
      for (const entry of snapshot.reparented ?? []) {
        const child = repos.branches.getById(entry.branchId)
        if (!child.found) {
          throw new ChatDbValidationError(`Branch ${entry.branchId} no longer exists; the move can no longer be undone`)
        }
        if ((child.data.parentBranchId ?? null) !== entry.parentAfter) {
          throw new ChatDbValidationError(
            `Branch ${entry.branchId} ancestry changed since the move; the move can no longer be undone`
          )
        }
      }
      for (const id of snapshot.sourceOrderBefore ?? []) {
        const row = repos.messages.getInTopic(id, topicId)
        if (!row.found) {
          throw new ChatDbValidationError(`Message ${id} was deleted since the move; the move can no longer be undone`)
        }
        const owner = row.data.branchId ?? null
        if (owner !== sourceBranchId && owner !== created.id) {
          throw new ChatDbValidationError(
            `Message ${id} changed route owner since the move; the move can no longer be undone`
          )
        }
      }
      // 1. Ownership back to the source route, then the recorded dense order.
      for (const id of movedMessageIds) this.setMessageOwnerInTx(tx, id, sourceBranchId)
      const sourceIdsNow = repos.messages.listByTopic(topicId, sourceBranchId).map((m) => m.id)
      const sourceIdsNowSet = new Set(sourceIdsNow)
      const recordedSourceIds = new Set(snapshot.sourceOrderBefore ?? [])
      // Recorded order first (moved rows return to their old positions), then
      // any row appended to the source route after the move.
      const restoredOrder = [
        ...(snapshot.sourceOrderBefore ?? []).filter((id) => sourceIdsNowSet.has(id)),
        ...sourceIdsNow.filter((id) => !recordedSourceIds.has(id))
      ]
      if (restoredOrder.length !== sourceIdsNow.length) {
        throw new ChatDbValidationError('Source route rows changed since the move; the move can no longer be undone')
      }
      repos.messages.replaceOrder(topicId, restoredOrder, sourceBranchId)
      // 2. Ancestry back to the recorded parents.
      for (const entry of snapshot.reparented ?? []) {
        repos.branches.setParent(entry.branchId, entry.parentBefore ?? null)
      }
      // 3. The created branch row leaves; nothing owns it any more.
      const removed = repos.branches.deleteSubtreeRows([created.id])
      if (removed.affected !== 1) {
        throw new ChatDbValidationError(`Branch ${created.id} could not be removed`)
      }
      return { branchIds: [created.id], messageIds: movedMessageIds }
    }
    if (current.found) {
      throw new ChatDbValidationError(`Branch ${created.id} already exists; the move can no longer be redone`)
    }
    if (sourceBranchId !== null) {
      this.requireBranchInTx(repos, topicId, sourceBranchId)
    }
    const anchor = repos.messages.getInTopic(created.anchorMessageId, topicId)
    if (!anchor.found) {
      throw new ChatDbNotFoundError(
        `Anchor message ${created.anchorMessageId} does not exist in topic ${topicId}; the move can no longer be redone`
      )
    }
    if ((anchor.data.branchId ?? null) !== sourceBranchId) {
      throw new ChatDbValidationError(
        `Anchor message ${created.anchorMessageId} no longer belongs to the source route; the move can no longer be redone`
      )
    }
    const sourceIdsBefore = repos.messages.listByTopic(topicId, sourceBranchId).map((m) => m.id)
    const sourceIdsBeforeSet = new Set(sourceIdsBefore)
    for (const id of [...movedMessageIds, ...(snapshot.sourceOrderBefore ?? [])]) {
      if (!sourceIdsBeforeSet.has(id)) {
        throw new ChatDbValidationError(`Message ${id} is not on the source route; the move can no longer be redone`)
      }
    }
    for (const entry of snapshot.reparented ?? []) {
      const child = repos.branches.getById(entry.branchId)
      if (!child.found) {
        throw new ChatDbValidationError(`Branch ${entry.branchId} no longer exists; the move can no longer be redone`)
      }
      if ((child.data.parentBranchId ?? null) !== (entry.parentBefore ?? null)) {
        throw new ChatDbValidationError(
          `Branch ${entry.branchId} ancestry changed since the move; the move can no longer be redone`
        )
      }
    }
    repos.branches.create({
      id: created.id,
      topicId,
      parentBranchId: sourceBranchId,
      anchorMessageId: created.anchorMessageId,
      name: created.name ?? null,
      createdAt: created.createdAt ?? null,
      updatedAt: created.updatedAt ?? null,
      overflow: created.overflow ?? {}
    })
    for (const id of movedMessageIds) this.setMessageOwnerInTx(tx, id, created.id)
    // The moved rows re-own densely from zero, exactly as the original move
    // left them, so the destination route's per-owner order is never sparse.
    repos.messages.replaceOrder(topicId, movedMessageIds, created.id)
    for (const entry of snapshot.reparented ?? []) {
      repos.branches.setParent(entry.branchId, entry.parentAfter)
    }
    repos.messages.replaceOrder(
      topicId,
      sourceIdsBefore.filter((id) => !movedSet.has(id)),
      sourceBranchId
    )
    return { branchIds: [created.id], messageIds: movedMessageIds }
  }

  /**
   * Replay a subtree-delete snapshot.
   *
   * Undo restores every removed row in one transaction (branch rows
   * subtree-root first, owned messages/blocks/file references verbatim, the
   * touched segments with their ordered membership plus the catalog order, and
   * the inheritance boundaries the delete advanced). Redo re-runs the same
   * deterministic subtree delete, but only while the subtree still holds
   * exactly the rows this snapshot recorded.
   */
  private replayBranchDeleteInTx(
    repos: ChatDbRepositories,
    tx: unknown,
    topicId: string,
    direction: BranchOperationDirection,
    snapshot: BranchDeleteSnapshot
  ): ReplayBranchRows {
    const branches = snapshot.branches ?? []
    if (branches.length === 0 || branches[0]?.id !== snapshot.rootBranchId) {
      throw new ChatDbValidationError('Delete snapshot must carry the deleted branch rows subtree-root first')
    }
    const messages = snapshot.messages ?? []
    const blocks = snapshot.blocks ?? []
    const fileReferences = snapshot.fileReferences ?? []
    const segments = snapshot.segments ?? []
    const segmentsAfter = snapshot.segmentsAfter ?? []
    // Closed-set + ownership check for the whole operation, both directions,
    // before any guard reads or any write happens.
    this.assertDeleteSnapshotClosedInTx(repos, topicId, snapshot)
    if (direction === 'redo') {
      const root = repos.branches.getById(snapshot.rootBranchId)
      if (!root.found) {
        throw new ChatDbNotFoundError(`Branch ${snapshot.rootBranchId} does not exist in topic ${topicId}`)
      }
      if (root.data.topicId !== topicId) {
        throw new ChatDbValidationError(`Branch ${snapshot.rootBranchId} does not belong to topic ${topicId}`)
      }
      const subtreeIds = [snapshot.rootBranchId, ...repos.branches.collectSubtreeIds(snapshot.rootBranchId)]
      this.assertSameIdSet(
        subtreeIds,
        branches.map((row) => row.id),
        'the deleted branch subtree'
      )
      const ownedMessageIds = subtreeIds.flatMap((bid) => repos.messages.listByTopic(topicId, bid)).map((m) => m.id)
      this.assertSameIdSet(
        ownedMessageIds,
        messages.map((row) => row.id),
        'the deleted messages'
      )
      const blockMap = repos.blocks.listByMessages(ownedMessageIds)
      const ownedBlockIds: string[] = []
      for (const id of ownedMessageIds) {
        for (const block of blockMap.get(id) ?? []) ownedBlockIds.push(block.id)
      }
      this.assertSameIdSet(
        ownedBlockIds,
        blocks.map((row) => row.id),
        'the deleted blocks'
      )
      this.assertSameIdSet(
        repos.fileRefs.listByMessages(ownedMessageIds).map((row) => row.id),
        fileReferences.map((row) => row.id),
        'the deleted file references'
      )
      this.deleteBranchSubtreeInTx(repos, topicId, snapshot.rootBranchId)
      return { branchIds: subtreeIds, messageIds: ownedMessageIds }
    }
    // Undo: every row must be gone, so a restore never overwrites live work.
    const restoredBranchIds = branches.map((row) => row.id)
    const restoredBranchIdSet = new Set(restoredBranchIds)
    for (const row of branches) {
      if (repos.branches.exists(row.id)) {
        throw new ChatDbValidationError(`Branch ${row.id} already exists; the delete can no longer be undone`)
      }
    }
    for (const row of branches) {
      if (
        row.parentBranchId !== null &&
        !restoredBranchIdSet.has(row.parentBranchId) &&
        !repos.branches.exists(row.parentBranchId)
      ) {
        throw new ChatDbValidationError(
          `Parent branch ${row.parentBranchId} of ${row.id} no longer exists; the delete can no longer be undone`
        )
      }
    }
    for (const row of messages) {
      if (repos.messages.getById(row.id).found) {
        throw new ChatDbValidationError(`Message ${row.id} already exists; the delete can no longer be undone`)
      }
    }
    for (const row of blocks) {
      if (repos.blocks.getById(row.id).found) {
        throw new ChatDbValidationError(`Block ${row.id} already exists; the delete can no longer be undone`)
      }
    }
    for (const row of fileReferences) {
      if (repos.fileRefs.getById(row.id).found) {
        throw new ChatDbValidationError(`File reference ${row.id} already exists; the delete can no longer be undone`)
      }
    }
    // Touched segments must still hold the state this delete left (nothing for
    // a redo: there the delete has not been re-applied yet).
    this.assertSegmentPostDeleteStateInTx(repos, segmentsAfter)
    // 1. Branch rows, subtree-root first (a parent is always restored before
    //    its children, so ancestry and anchors re-compose exactly as before).
    for (const row of branches) {
      repos.branches.create({
        id: row.id,
        topicId,
        parentBranchId: row.parentBranchId ?? null,
        anchorMessageId: row.anchorMessageId,
        name: row.name ?? null,
        createdAt: row.createdAt ?? null,
        updatedAt: row.updatedAt ?? null,
        overflow: row.overflow ?? {}
      })
    }
    // 2. Owned rows verbatim: recorded dense orders are complete per owner, so
    //    no surviving row can collide with a restored one.
    if (messages.length > 0) {
      repos.messages.createMany(messages.map((row) => ({ ...row })))
    }
    if (blocks.length > 0) {
      repos.blocks.createMany(blocks.map((row) => ({ ...row })))
    }
    if (fileReferences.length > 0) {
      repos.fileRefs.createMany(fileReferences.map((row) => ({ ...row })))
    }
    // 3. Segments: a segment the delete emptied is re-created, every touched
    //    segment gets its recorded membership and head back, and the catalog
    //    order is re-pinned (an emptied segment's removal had renumbered it).
    for (const segment of segments) {
      if (!repos.segments.getById(segment.id).found) {
        repos.segments.create({
          id: segment.id,
          topicId,
          name: segment.name ?? null,
          createdAt: segment.createdAt ?? null,
          updatedAt: segment.updatedAt ?? null,
          sortOrder: segment.sortOrder,
          headerMessageId: segment.headerMessageId ?? null,
          overflow: segment.overflow ?? {}
        })
      }
      repos.segments.replaceMessageIds(segment.id, segment.memberIds ?? [])
      repos.segments.setHeaderMessageId(segment.id, segment.headerMessageId ?? null)
    }
    if (segments.length > 0) {
      // Re-pin the catalog by inserting the segments this delete emptied back
      // into their recorded slots, keeping every live segment in its CURRENT
      // relative order: a concurrent reorder of unrelated segments survives.
      const liveSegmentIds = repos.segments.listByTopic(topicId).map((row) => row.id)
      const recordedIndex = new Map((snapshot.segmentOrder ?? []).map((id, index) => [id, index]))
      const orderOf = (id: string): number => recordedIndex.get(id) ?? Number.MAX_SAFE_INTEGER
      const recreatedSegmentIds = segmentsAfter.filter((row) => !row.exists).map((row) => row.id)
      const recreatedSegmentIdSet = new Set(recreatedSegmentIds)
      const orderedSegmentIds = liveSegmentIds.filter((id) => !recreatedSegmentIdSet.has(id))
      for (const id of recreatedSegmentIds) {
        const insertAt = orderedSegmentIds.findIndex((live) => orderOf(live) > orderOf(id))
        orderedSegmentIds.splice(insertAt === -1 ? orderedSegmentIds.length : insertAt, 0, id)
      }
      const changed =
        orderedSegmentIds.length !== liveSegmentIds.length ||
        orderedSegmentIds.some((id, index) => id !== liveSegmentIds[index])
      if (changed) this.assignSegmentOrdersInTx(tx, orderedSegmentIds)
    }
    // 4. Inheritance boundaries this delete advanced, restored compare-and-set
    //    against the restored route only.
    this.restoreInheritanceBoundariesInTx(
      repos,
      topicId,
      snapshot.boundaries ?? [],
      new Set(messages.map((row) => row.id)),
      snapshot.rootBranchId
    )
    return { branchIds: restoredBranchIds, messageIds: messages.map((row) => row.id) }
  }

  // =========================================================================
  // Phase 5.1B: Compound mutations
  // =========================================================================

  /**
   * Atomically ensure/create a target topic and insert ordered
   * messages+blocks. Each entry is a message with its blocks, appended
   * in array order. File references are synced for all file/image blocks.
   *
   * Rejects any existing message ID that is owned by a different topic.
   *
   * Linear batch semantics (LOCK-002): all NEW messages are converted and
   * classified first, then inserted in ONE `appendMany` batch with a single
   * final dense-order normalization per topic — never one per-message
   * full-topic normalization. Existing (same-topic) entries preserve their
   * position and only receive a metadata patch, exactly as before.
   *
   * Phase-4 block side effects (block upserts + file-reference syncs) run
   * in the ORIGINAL request entry order (audit F1): the new/existing
   * classification never reorders them into new-before-existing, so rare
   * cross-entry block-ID collisions keep the same last-writer as the legacy
   * per-entry loop.
   *
   * Atomicity: one root SQLite transaction (LOCK-001).
   */
  cloneMessagesToTopic(
    targetTopicId: string,
    entries: Array<{ message: JsonObject; blocks: JsonObject[] }>,
    assistantId?: string,
    branchId?: string | null
  ): ChatDbResult<null> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('cloneMessagesToTopic', targetTopicId, route)
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      try {
        this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Ensure target topic exists (create-only). A missing target is
          // represented only via the existing topic upsert semantics (same
          // payload as ensureTopic/appendMessage closure, same tx, no new
          // semantics): true creation emits the topic upsert parent-first;
          // an existing target emits no topic op.
          const topicExistedBefore = repos.topics.getById(targetTopicId).found
          repos.topics.ensure(targetTopicId, assistantId)
          if (ctx && !topicExistedBefore) {
            const created = repos.topics.getById(targetTopicId)
            if (!created.found) throw new Error(`cloneMessagesToTopic topic ${targetTopicId} missing after ensure`)
            syncService.enqueueUpsertInTx(
              stx,
              'topic',
              targetTopicId,
              this.syncTopicPayload(created.data),
              Math.max(0, ctx.ts - 2),
              ctx.deviceId
            )
            syncNotify = true
          }

          // Pre-state snapshots for sync diffing (taken before any mutation
          // in this tx; same pattern as insert/paste).
          const preMessageRows = new Map<string, MessageData>()
          const preBlockRows = new Map<string, MessageBlockData>()
          if (ctx) {
            const seenMsg = new Set<string>()
            for (const entry of entries) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && mid.length > 0 && !seenMsg.has(mid)) {
                seenMsg.add(mid)
                const pre = repos.messages.getById(mid)
                if (pre.found) preMessageRows.set(mid, { ...pre.data, overflow: { ...pre.data.overflow } })
              }
              for (const b of entry.blocks) {
                const bid = (b as Record<string, unknown>).id as string
                if (typeof bid === 'string' && bid.length > 0 && !preBlockRows.has(bid)) {
                  const pre = repos.blocks.getById(bid)
                  if (pre.found) preBlockRows.set(bid, { ...pre.data, overflow: { ...pre.data.overflow } })
                }
              }
            }
          }

          // Phase 1 — convert every entry, enforce block ownership, and
          // classify as new vs existing. Cross-topic ownership and duplicate
          // new IDs are resolved here, before any write, so the first invalid
          // entry aborts the whole transaction exactly as the per-entry loop
          // did (error precedence is unchanged).
          const newMessages: MessageData[] = []
          const newMessageIds = new Set<string>()
          const existingPlans: Array<{
            message: MessageData
            blocks: MessageBlockData[]
            patch: Record<string, unknown>
          }> = []
          // Phase-4 side-effect order (audit F1): every entry's blocks in the
          // ORIGINAL request order. Upserting blocks + syncing file references
          // in `[...newEntryPlans, ...existingPlans]` order would move all NEW
          // entries' block side effects before EXISTING entries', changing the
          // last-writer for rare cross-entry block-ID collisions vs the legacy
          // per-entry loop.
          const phase4Plans: Array<{ message: MessageData; blocks: MessageBlockData[] }> = []

          for (const entry of entries) {
            const messageData = wireToMessage(entry.message)
            messageData.topicId = targetTopicId
            messageData.branchId = route
            const blockDataList = entry.blocks.map(wireToBlock)

            // Enforce block ownership
            for (const block of blockDataList) {
              block.messageId = messageData.id
            }
            this.assignAuthoritativeBlockOrder(entry.message, blockDataList)

            const patch = wireToMessagePatch(entry.message)
            delete patch.id
            delete patch.topicId
            delete patch.branchId
            delete patch.sortOrder

            // Check if message already exists
            const existing = repos.messages.getById(messageData.id)

            if (existing.found) {
              // Reject cross-topic ownership: message must belong to target topic
              if (existing.data.topicId !== targetTopicId) {
                throw new ChatDbConflictError(
                  `Message ${messageData.id} belongs to topic ${existing.data.topicId}, ` +
                    `cannot clone into topic ${targetTopicId}`
                )
              }
              // Route immutability: patching an inherited/shared row rejects.
              this.assertMutableMessageInTx(
                repos,
                tx as unknown as BetterSQLite3Database<typeof schema>,
                targetTopicId,
                route,
                messageData.id
              )
              // Same topic: preserve position, update metadata only
              existingPlans.push({ message: messageData, blocks: blockDataList, patch })
            } else if (newMessageIds.has(messageData.id)) {
              // Duplicate new ID within one request: the first occurrence is
              // inserted; later occurrences follow the established update path.
              existingPlans.push({ message: messageData, blocks: blockDataList, patch })
            } else {
              // New: append at end (batched)
              newMessageIds.add(messageData.id)
              newMessages.push(messageData)
            }
            // Phase 4 runs in original entry order regardless of the
            // new/existing split above (audit F1).
            phase4Plans.push({ message: messageData, blocks: blockDataList })
          }

          // Phase 2 — batch-insert all new messages (single linear normalize).
          if (newMessages.length > 0) {
            repos.messages.appendMany(newMessages)
          }

          // Phase 3 — metadata patches for existing rows and in-request
          // duplicates (applied after the batch insert so duplicate entries
          // patch the just-inserted row, matching the per-entry loop).
          for (const plan of existingPlans) {
            if (Object.keys(plan.patch).length > 0) {
              repos.messages.update(targetTopicId, plan.message.id, plan.patch)
            }
          }

          // Phase 4 — upsert blocks + sync file references for ALL entries in
          // ORIGINAL request order (audit F1: the new/existing classification
          // must not reorder block side effects, so rare cross-entry block-ID
          // collisions keep the legacy per-entry loop's last-writer).
          for (const plan of phase4Plans) {
            if (plan.blocks.length > 0) {
              repos.blocks.upsertMany(plan.blocks)
              this.syncFileReferences(repos, plan.blocks)
            }
          }

          // Transaction-bound sync intent (same atomic boundary, reused from
          // insert/paste/branch true-create enqueue + membership + frame
          // helpers — no new mechanism, no new wire). Ordinary clone contract:
          // fresh-ID `success` messages (shouldCapture gate) plus `success` +
          // supported blocks under a `success` parent enqueue full-state
          // upserts with true-create-only membership; existing rows enqueue
          // allowlisted diffs only with membership preserved (never
          // backfilled); transient / non-success-terminal / unsupported rows
          // emit nothing (durable unsupported outcome for the latter) so the
          // frame helpers below invalidate truthfully instead of faking
          // complete. Source rows are untouched by definition (fresh IDs).
          if (ctx) {
            let tsOffset = 0
            const nextTs = (): number => ctx.ts + tsOffset++
            const distinctMids: string[] = []
            const seenMids = new Set<string>()
            for (const entry of entries) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && !seenMids.has(mid)) {
                seenMids.add(mid)
                distinctMids.push(mid)
              }
            }
            let hasNewInclusion = false
            let hasDemotion = false
            for (const mid of distinctMids) {
              const postRow = repos.messages.getById(mid)
              if (!postRow.found) throw new Error(`cloneMessagesToTopic message ${mid} missing in transaction`)
              const pre = preMessageRows.get(mid) ?? null
              const isTrueCreate = !pre
              const postStable = isStableMessageStatus(postRow.data.status)
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) hasDemotion = true
              // Ordinary clone inclusion: fresh-ID success creates (existing
              // stable→stable patches never advance the topic frame by
              // themselves; stable promotion of an existing row counts).
              const postSuccess = postRow.data.status === 'success'
              const preSuccess = pre ? pre.status === 'success' : false
              if ((isTrueCreate && postSuccess) || (pre && !preSuccess && postSuccess)) hasNewInclusion = true
              if (!postStable) continue
              if (isTrueCreate) {
                // Fresh-ID ordinary clone: success only. Non-success
                // terminals stay local-only (no op, no membership) so the
                // frame decision below stays truthful partial.
                if (!postSuccess) continue
                if (!this.shouldCaptureMessageCreate(postRow.data)) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, targetTopicId, opTs, ctx.deviceId)
                const full = this.syncMessagePayloadFull(postRow.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message', mid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message', mid, postRow.data.topicId, opTs, opId)
                syncNotify = true
              } else {
                const diff = this.diffMessagePayload(pre, postRow.data)
                if (!diff) continue
                delete diff.sortOrder
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, targetTopicId, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message', mid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            const distinctBids: string[] = []
            const seenBids = new Set<string>()
            for (const plan of phase4Plans) {
              for (const blk of plan.blocks) {
                if (!seenBids.has(blk.id)) {
                  seenBids.add(blk.id)
                  distinctBids.push(blk.id)
                }
              }
            }
            for (const bid of distinctBids) {
              const postBlk = repos.blocks.getById(bid)
              if (!postBlk.found) throw new Error(`cloneMessagesToTopic block ${bid} missing in transaction`)
              // Blocks under a non-success parent never ride the ordinary
              // clone wire: skip without closure (closure would fail closed or
              // fabricate a non-ordinary parent). The per-parent frame decision
              // below invalidates that parent.
              const parentMsg = repos.messages.getById(postBlk.data.messageId)
              if (!parentMsg.found || parentMsg.data.status !== 'success') continue
              // Ordinary clone blocks: success + supported only.
              if (postBlk.data.status !== 'success') continue
              if (this.isUnsupportedBlock(postBlk.data)) {
                unsupportedBlockIds.push(bid)
                continue
              }
              const pre = preBlockRows.get(bid) ?? null
              if (!pre) {
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                const full = this.syncBlockPayloadFull(postBlk.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message_block', bid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message_block', bid, postBlk.data.messageId, opTs, opId)
                syncNotify = true
              } else {
                if (postBlk.data.messageId !== pre.messageId) continue
                const diff = this.diffBlockPayload(pre, postBlk.data)
                if (!diff) continue
                delete diff.sortOrder
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message_block', bid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            // Local parent order frames — exactly one topicMessage attempt when
            // semantically required plus one per affected block parent where
            // required. Pure stable→stable content patches advance nothing;
            // inclusion changes use the existing try helpers (missing /
            // excluded invalidates with 0 op, malformed rolls back).
            if (hasDemotion) {
              syncService.invalidateParentFrameInTx(stx, 'topicMessage', targetTopicId)
              for (const mid of distinctMids) {
                const pre = preMessageRows.get(mid)
                const postRow = repos.messages.getById(mid)
                const preStable = pre ? isStableMessageStatus(pre.status) : false
                const postStable = postRow.found ? isStableMessageStatus(postRow.data.status) : false
                if (pre && preStable && !postStable) {
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                }
              }
            } else if (hasNewInclusion) {
              if (
                syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, targetTopicId, ctx.deviceId) === 'refreshed'
              ) {
                syncNotify = true
              }
            }
            const affectedParents = new Set<string>()
            for (const mid of distinctMids) affectedParents.add(mid)
            for (const bid of distinctBids) {
              const pre = preBlockRows.get(bid)
              const postBlk = repos.blocks.getById(bid)
              if (pre) affectedParents.add(pre.messageId)
              if (postBlk.found) affectedParents.add(postBlk.data.messageId)
            }
            for (const mid of affectedParents) {
              const postMsg = repos.messages.getById(mid)
              if (!postMsg.found) continue
              const postSuccess = postMsg.data.status === 'success'
              const pre = preMessageRows.get(mid) ?? null
              const preSuccess = pre ? pre.status === 'success' : false
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              const postStable = isStableMessageStatus(postMsg.data.status)
              if (pre && preStable && !postStable) continue // already invalidated above
              if (!postStable) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                continue
              }
              const isNewlyIncludedParent = (!pre && postSuccess) || (!!pre && !preSuccess && postSuccess)
              let needsBlockFrame = isNewlyIncludedParent
              if (!needsBlockFrame) {
                for (const bid of distinctBids) {
                  const bPre = preBlockRows.get(bid)
                  const bPost = repos.blocks.getById(bid)
                  if (!bPost.found) continue
                  if (bPost.data.messageId !== mid && (!bPre || bPre.messageId !== mid)) continue
                  if (!bPre) {
                    needsBlockFrame = true
                    break
                  }
                  if (bPre.messageId !== bPost.data.messageId) {
                    needsBlockFrame = true
                    break
                  }
                  const preIncluded = bPre.status === 'success' && !this.isUnsupportedBlock(bPre)
                  const postIncluded = bPost.data.status === 'success' && !this.isUnsupportedBlock(bPost.data)
                  if (preIncluded !== postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                  if (!postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                }
              }
              if (!needsBlockFrame) continue
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, mid, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          } else {
            // Capture disabled: preserve existing truthful invalidation, no ops.
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', targetTopicId)
            {
              const mids = new Set<string>()
              for (const plan of phase4Plans) {
                for (const blk of plan.blocks) mids.add(blk.messageId)
              }
              for (const mid of mids) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
              }
            }
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('cloneMessagesToTopic', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('cloneMessagesToTopic', unsupportedBlockIds)

      return null
    }, `cloneMessagesToTopic(${targetTopicId}, ${entries.length} entries)`)
  }

  /**
   * Atomically reset message state for resend and delete designated blocks.
   *
   * - Resolves every block ID through its parent message to verify topic ownership.
   * - Rejects any block ID whose parent message does not belong to request topic.
   * - Deletes owned blocks and resets each message's status, sortOrder, and clears model.
   * - Returns file cleanup facts for deleted blocks.
   *
   * Sync (SYNC-DATA-055 intent slice + issuer slice): in the same
   * transaction, persists one local-only resend attempt intent per reset
   * message (fresh Main-authoritative attempt id, topic/message/askId, reset
   * timestamp, removed old stable block IDs for that message — never
   * content/paths) and returns the per-message attempt mapping in the
   * success response so the resend/regenerate execution can carry the id in
   * its streaming/final DB writes. A new reset deterministically supersedes
   * any prior intent for the same message (PK upsert). The intent emits no
   * outbox, fabricates no error/final state, and is consumed only by the
   * success-final stable_replace issuer (updateMessage /
   * updateMessageAndBlocks).
   *
   * Atomicity: one root SQLite transaction.
   */
  /**
   * Transaction-internal reset core shared by the low-level compat path and
   * the two semantic stable-ID commands.
   *
   * Runs INSIDE the caller's root `db.transaction` — never opens its own
   * transaction and never wraps results. Preserves the exact low-level block
   * ownership, file cleanup, replaceOrder, frame invalidation, and resend
   * attempt persistence semantics.
   */
  private resetMessagesCoreInTx(
    _tx: unknown,
    repos: ChatDbRepositories,
    stx: SyncTxExecutor,
    topicId: string,
    messages: Array<{ message: JsonObject; blocks: JsonObject[] }> | string[],
    blockIdsToDelete: string[],
    branchId?: string | null
  ): { cleanup: FileCleanupResult; attempts: ResendAttemptMapping[]; removedBlockIds: string[] } {
    const route = this.normalizeBranchId(branchId)
    // Phase 1: Resolve every block through its parent message and verify ownership.
    // Reject any block whose parent message is not owned by the addressed
    // route (BRANCH-4 owner equality; missing rows are new suffix appends
    // and proceed; ordinary cross-topic rows keep legacy Conflict semantics
    // below).
    {
      const dbForResetGuard = _tx as BetterSQLite3Database<typeof schema>
      const candidateIds = new Set<string>()
      for (const item of messages) {
        const mid = typeof item === 'string' ? item : ((item as { message: JsonObject }).message?.id as string)
        if (typeof mid === 'string' && mid.length > 0) candidateIds.add(mid)
      }
      for (const bid of blockIdsToDelete) {
        if (typeof bid !== 'string' || bid.length === 0) continue
        const blk = repos.blocks.getById(bid)
        if (blk.found) candidateIds.add(blk.data.messageId)
      }
      for (const mid of candidateIds) {
        this.assertMutableMessageInTx(repos, dbForResetGuard, topicId, route, mid)
      }
    }
    const ownedBlockIds: string[] = []
    if (blockIdsToDelete.length > 0) {
      for (const blockId of blockIdsToDelete) {
        const block = repos.blocks.getById(blockId)
        if (!block.found) {
          throw new ChatDbConflictError(`Block ${blockId} does not exist`)
        }
        // Resolve block → message → route ownership
        const msg = repos.messages.getInTopic(block.data.messageId, topicId)
        if (!msg.found || (msg.data.branchId ?? null) !== route) {
          throw new ChatDbConflictError(
            `Block ${blockId} belongs to message ${block.data.messageId} which is not in topic ${topicId}`
          )
        }
        ownedBlockIds.push(blockId)
      }
    }

    // Capture parent messageIds for frame invalidation before deletion (still present)
    const ownedBlockParentIds = new Set<string>()
    const removedByMessage = new Map<string, string[]>()
    for (const bid of ownedBlockIds) {
      const blk = repos.blocks.getById(bid)
      if (blk.found) {
        ownedBlockParentIds.add(blk.data.messageId)
        const list = removedByMessage.get(blk.data.messageId)
        if (list) list.push(bid)
        else removedByMessage.set(blk.data.messageId, [bid])
      }
    }

    // Phase 2: Collect affected file IDs from owned blocks only
    let affectedFileIds: string[] = []
    if (ownedBlockIds.length > 0) {
      const allRefs: FileReferenceData[] = []
      for (const blockId of ownedBlockIds) {
        const refs = repos.fileRefs.listByBlock(blockId)
        allRefs.push(...refs)
      }
      affectedFileIds = collectAffectedFileIds(allRefs)

      // Delete owned blocks (FK cascade removes file_references)
      repos.blocks.deleteMany(ownedBlockIds)
    }

    // Phase 3: Persist complete reset payloads, preserving existing identity.
    // Ownership is stamped by Main from the route context (wire branchId
    // never trusted); appends land in the route owner's suffix.
    for (const item of messages) {
      const entry = typeof item === 'string' ? { message: { id: item, status: null, blocks: [] }, blocks: [] } : item
      const messageData = wireToMessage(entry.message)
      messageData.topicId = topicId
      messageData.branchId = route
      const blockDataList = entry.blocks.map(wireToBlock)
      for (const block of blockDataList) block.messageId = messageData.id
      const existing = repos.messages.getInTopic(messageData.id, topicId)
      if (!existing.found) {
        repos.messages.append(messageData)
      } else {
        const patch = wireToMessagePatch(entry.message)
        delete patch.id
        delete patch.topicId
        delete patch.branchId
        delete patch.sortOrder
        repos.messages.update(topicId, messageData.id, patch)
      }
      if (blockDataList.length > 0) {
        repos.blocks.upsertMany(blockDataList)
        this.syncFileReferences(repos, blockDataList)
      }
    }

    // Phase 4: Normalize the route owner's orders after changes (never
    // across owners).
    repos.messages.replaceOrder(
      topicId,
      repos.messages.listByTopic(topicId, route).map((m) => m.id),
      route
    )

    // Unsupported structural path (010) — truthful invalidation inside same transaction, no clock mint
    syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
    const resetMsgIds = new Set<string>(ownedBlockParentIds)
    for (const item of messages) {
      const mid = typeof item === 'string' ? item : ((item as { message: JsonObject }).message?.id as string)
      if (typeof mid === 'string' && mid.length > 0) resetMsgIds.add(mid)
    }
    for (const mid of resetMsgIds) {
      syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
    }

    // Local-only resend attempt intent (SYNC-DATA-055 intent slice): one
    // row per reset message in the same transaction. Fresh
    // Main-authoritative attempt id per message; askId from the reset
    // payload when present, otherwise from the surviving row; removed ids
    // are the owned deleted blocks for that message only. Strict
    // validation throws roll back the whole reset. No outbox, no wire.
    // The per-message mapping returns in the success response (strictly
    // closed messageId + attemptId entries) for the resend/regenerate
    // execution context; consumption happens only in the success-final
    // stable_replace issuer.
    const resetTimestamp = Date.now()
    const attempts: ResendAttemptMapping[] = []
    for (const item of messages) {
      const rawMessage = typeof item === 'string' ? null : ((item as { message: JsonObject }).message ?? null)
      const mid = typeof item === 'string' ? item : ((rawMessage as Record<string, unknown> | null)?.id as string)
      if (typeof mid !== 'string' || mid.length === 0) {
        throw new ChatDbConflictError(`resetMessagesForResend message without id in topic ${topicId}`)
      }
      let askId: string | null = null
      const wireAsk = (rawMessage as Record<string, unknown> | null)?.askId
      if (typeof wireAsk === 'string' && wireAsk.length > 0) {
        askId = wireAsk
      } else {
        const surviving = repos.messages.getInTopic(mid, topicId)
        if (surviving.found && typeof surviving.data.askId === 'string' && surviving.data.askId.length > 0) {
          askId = surviving.data.askId
        }
      }
      const attemptId = randomUUID()
      persistResendAttemptInTx(stx, {
        messageId: mid,
        attemptId,
        topicId,
        askId,
        resetTimestamp,
        removedBlockIds: removedByMessage.get(mid) ?? []
      })
      attempts.push({ messageId: mid, attemptId })
    }

    const cleanup = buildFileCleanupResult(repos, affectedFileIds)
    return { cleanup, attempts, removedBlockIds: [...ownedBlockIds] }
  }

  resetMessagesForResend(
    topicId: string,
    messages: Array<{ message: JsonObject; blocks: JsonObject[] }> | string[],
    blockIdsToDelete: string[],
    branchId?: string | null
  ): ChatDbResult<ResetMessagesForResendResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('resetMessagesForResend')
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const stx = tx as unknown as SyncTxExecutor
        const { cleanup, attempts } = this.resetMessagesCoreInTx(
          tx,
          repos,
          stx,
          topicId,
          messages,
          blockIdsToDelete,
          branchId
        )
        return { ...cleanup, attempts }
      })
    }, `resetMessagesForResend(${topicId}, ${messages.length} msgs)`)
  }

  // ---------------------------------------------------------------------------
  // Semantic resend/regenerate — stable-ID commands sharing resetMessagesCoreInTx
  // ---------------------------------------------------------------------------

  private semanticModelId(snapshot: SemanticModelSnapshot): string {
    return snapshot.id
  }

  private isFullSemanticSnapshot(value: unknown): value is SemanticModelSnapshot {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const rec = value as Record<string, unknown>
    return (
      typeof rec.id === 'string' &&
      rec.id.length > 0 &&
      typeof rec.provider === 'string' &&
      rec.provider.length > 0 &&
      typeof rec.name === 'string' &&
      rec.name.length > 0 &&
      typeof rec.group === 'string' &&
      rec.group.length > 0
    )
  }

  private assertFullSemanticSnapshot(value: unknown, path: string): asserts value is SemanticModelSnapshot {
    if (!this.isFullSemanticSnapshot(value)) {
      throw new ChatDbConflictError(`${path} must carry full model snapshot (id/provider/name/group non-empty)`)
    }
  }

  private mentionSnapshotsFromUserWire(userWire: JsonObject): SemanticModelSnapshot[] {
    const raw = (userWire as Record<string, unknown>).mentions
    if (!Array.isArray(raw)) return []
    const out: SemanticModelSnapshot[] = []
    for (const item of raw) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>
        if (typeof rec.id !== 'string' || rec.id.length === 0) continue
        // Authority mentions become execution models verbatim: an id-only
        // (or otherwise partial) mention must fail closed here rather than
        // silently creating a message with an incomplete model.
        this.assertFullSemanticSnapshot(item, 'authority mention')
        out.push(item)
      }
    }
    return out
  }

  private mentionKeyPresent(existingModelWire: unknown, mentionId: string): boolean {
    if (existingModelWire !== null && typeof existingModelWire === 'object' && !Array.isArray(existingModelWire)) {
      const rec = existingModelWire as Record<string, unknown>
      if (typeof rec.id === 'string' && rec.id === mentionId) return true
    }
    if (typeof existingModelWire === 'string' && existingModelWire === mentionId) return true
    return false
  }

  private buildSemanticResetEntry(
    existingWire: JsonObject,
    modelWire: JsonValue | undefined,
    modelId: string | undefined,
    nowIso: string
  ): { message: JsonObject; blocks: JsonObject[] } {
    const rec = existingWire as Record<string, unknown>
    const message: JsonObject = {
      id: rec.id as string,
      topicId: rec.topicId as string,
      role: 'assistant',
      assistantId: rec.assistantId as string,
      askId: rec.askId as string,
      status: 'pending',
      createdAt: rec.createdAt as string,
      updatedAt: nowIso,
      blocks: []
    }
    if (modelWire !== undefined) {
      ;(message as Record<string, unknown>).model = modelWire
    } else if (rec.model !== undefined && rec.model !== null) {
      ;(message as Record<string, unknown>).model = rec.model as JsonValue
    }
    const resolvedModelId = modelId ?? (typeof rec.modelId === 'string' && rec.modelId.length > 0 ? rec.modelId : null)
    if (resolvedModelId !== null && resolvedModelId !== undefined) {
      ;(message as Record<string, unknown>).modelId = resolvedModelId
    }
    return { message, blocks: [] }
  }

  private buildSemanticNewEntry(
    newId: string,
    topicId: string,
    assistantId: string,
    askId: string,
    traceId: string | null,
    modelSnapshot: SemanticModelSnapshot,
    nowIso: string
  ): { message: JsonObject; blocks: JsonObject[] } {
    const message: JsonObject = {
      id: newId,
      topicId,
      role: 'assistant',
      assistantId,
      askId,
      status: 'pending',
      model: { ...(modelSnapshot as Record<string, unknown>) } as JsonObject,
      modelId: this.semanticModelId(modelSnapshot),
      createdAt: nowIso,
      updatedAt: nowIso,
      blocks: []
    }
    if (traceId !== null) {
      ;(message as Record<string, unknown>).traceId = traceId
    }
    return { message, blocks: [] }
  }

  private toSemanticResponse(
    topicId: string,
    branchId: string | null,
    askId: string,
    userWire: JsonObject,
    userBlocksWire: JsonObject[],
    executionMessages: MessageBlockEntry[],
    createdMessageIds: string[],
    core: { cleanup: FileCleanupResult; attempts: ResendAttemptMapping[]; removedBlockIds: string[] }
  ): SemanticResendResponse {
    const created = [...createdMessageIds]
    return {
      affectedFileIds: [...core.cleanup.affectedFileIds],
      remainingReferenceCounts: { ...core.cleanup.remainingReferenceCounts },
      topicId,
      branchId,
      askId,
      userMessage: userWire,
      userBlocks: userBlocksWire,
      executionMessages,
      removedBlockIds: [...core.removedBlockIds],
      createdMessageIds: created,
      mutableMessageIds: [...created],
      attempts: core.attempts.map((a) => ({ messageId: a.messageId, attemptId: a.attemptId }))
    }
  }

  /**
   * Semantic resend: resolve the full assistant answer group from authority
   * and reset/create in one transaction via `resetMessagesCoreInTx`.
   *
   * Model rules mirror the renderer legacy path:
   * - existing=0 + mentions empty: create one currentModel member;
   * - existing=1 + mentions empty: reset that ID overriding to currentModel;
   * - existing>1: reset each preserving its own model/modelId;
   * - mentions non-empty: reset all existing preserving their models, then
   *   create one member per mention id missing from the existing group.
   */
  resendUserMessages(
    topicId: string,
    userMessageId: string,
    assistantId: string,
    currentModel: SemanticModelSnapshot,
    branchId?: string | null
  ): ChatDbResult<SemanticResendResponse> {
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('resendUserMessages')
      // Defense in depth: the IPC contract validates the same shape, but
      // direct callers must also fail closed rather than writing an id-only
      // model into a new/override execution message.
      this.assertFullSemanticSnapshot(currentModel, 'currentModel')
      const route = this.normalizeBranchId(branchId)
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const stx = tx as unknown as SyncTxExecutor
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        }
        const userRow = repos.messages.getInTopic(userMessageId, topicId)
        if (!userRow.found || userRow.data.role !== 'user') {
          throw new ChatDbNotFoundError(`User message ${userMessageId} does not belong to topic ${topicId}`)
        }
        // BRANCH-4/11: reading the ancestor user root never requires
        // mutability. The root must be readable in the addressed effective
        // route; only actually-reset assistant members must be owned below.
        const orderedForUserCheck = this.resolveRouteMessagesInTx(repos, topicId, route).messages
        if (!orderedForUserCheck.some((m) => m.id === userMessageId)) {
          throw new ChatDbNotFoundError(`User message ${userMessageId} does not belong to topic ${topicId}`)
        }
        const userWireBefore = messageToWire(userRow.data)
        const userBlocksBefore = blocksToWire(repos.blocks.listByMessage(userMessageId))
        const userWithBlocks = reconstructMessageBlockRelations([userWireBefore], userBlocksBefore)[0]
        const traceId =
          typeof (userRow.data.overflow.traceId ?? (userWireBefore as Record<string, unknown>).traceId) === 'string'
            ? ((userRow.data.overflow.traceId ?? (userWireBefore as Record<string, unknown>).traceId) as string)
            : null

        const ordered = this.resolveRouteMessagesInTx(repos, topicId, route).messages
        const existing = ordered.filter((m) => m.role === 'assistant' && m.askId === userMessageId)
        // BRANCH-4: every actually-reset assistant must be owned by the
        // addressed route. Inherited members fail closed (no partial write);
        // new members are created owned below via resetMessagesCoreInTx.
        for (const m of existing) {
          if ((m.branchId ?? null) !== route) {
            throw new ChatDbValidationError(
              `Message ${m.id} is shared with another route and is immutable through this route`
            )
          }
        }
        const existingWires = existing.map((m) => messageToWire(m))
        const mentions = this.mentionSnapshotsFromUserWire(userWithBlocks)
        const nowIso = new Date().toISOString()

        const entries: Array<{ message: JsonObject; blocks: JsonObject[] }> = []
        const createdIds: string[] = []
        const blockIdsToDelete: string[] = []
        for (const m of existing) {
          const blks = repos.blocks.listByMessage(m.id)
          for (const b of blks) blockIdsToDelete.push(b.id)
        }

        if (existing.length === 0 && mentions.length === 0) {
          const newId = randomUUID()
          entries.push(
            this.buildSemanticNewEntry(newId, topicId, assistantId, userMessageId, traceId, currentModel, nowIso)
          )
          createdIds.push(newId)
        } else if (existing.length === 1 && mentions.length === 0) {
          entries.push(
            this.buildSemanticResetEntry(
              existingWires[0],
              currentModel as unknown as JsonValue,
              currentModel.id,
              nowIso
            )
          )
        } else if (mentions.length === 0) {
          for (const w of existingWires) {
            entries.push(this.buildSemanticResetEntry(w, undefined, undefined, nowIso))
          }
        } else {
          for (const w of existingWires) {
            entries.push(this.buildSemanticResetEntry(w, undefined, undefined, nowIso))
          }
          const originIds = new Set<string>()
          for (const w of existingWires) {
            const rec = w as Record<string, unknown>
            const rawModel = rec.model
            if (rawModel !== null && typeof rawModel === 'object' && !Array.isArray(rawModel)) {
              const mid = (rawModel as Record<string, unknown>).id
              if (typeof mid === 'string' && mid.length > 0) originIds.add(mid)
            } else if (typeof rawModel === 'string' && rawModel.length > 0) {
              originIds.add(rawModel)
            }
            if (typeof rec.modelId === 'string' && rec.modelId.length > 0) {
              originIds.add(rec.modelId)
            }
          }
          const seenMention = new Set<string>()
          for (const mention of mentions) {
            if (seenMention.has(mention.id)) continue
            seenMention.add(mention.id)
            const present =
              originIds.has(mention.id) ||
              existingWires.some((w) => this.mentionKeyPresent((w as Record<string, unknown>).model, mention.id))
            if (!present) {
              const newId = randomUUID()
              entries.push(
                this.buildSemanticNewEntry(newId, topicId, assistantId, userMessageId, traceId, mention, nowIso)
              )
              createdIds.push(newId)
            }
          }
        }

        const core = this.resetMessagesCoreInTx(tx, repos, stx, topicId, entries, blockIdsToDelete, route)
        const execMessages: MessageBlockEntry[] = []
        for (const e of entries) {
          const mid = (e.message as Record<string, unknown>).id as string
          const row = repos.messages.getInTopic(mid, topicId)
          if (!row.found || (row.data.branchId ?? null) !== route) {
            throw new ChatDbConflictError(`Semantic resend message ${mid} missing after write`)
          }
          const wire = messageToWire(row.data)
          const blks = blocksToWire(repos.blocks.listByMessage(mid))
          const withRel = reconstructMessageBlockRelations([wire], blks)[0]
          execMessages.push({ message: withRel, blocks: [] })
        }
        return this.toSemanticResponse(
          topicId,
          route,
          userMessageId,
          userWithBlocks,
          userBlocksBefore,
          execMessages,
          createdIds,
          core
        )
      })
    }, `resendUserMessages(${topicId}, ${userMessageId})`)
  }

  /**
   * Semantic regenerate: reset only the selected assistant message.
   * Preserves its own model/modelId when `modelId` is truthy (ignores
   * `currentModel`), otherwise overrides to `currentModel`. Missing
   * `currentModel` with no self `modelId` fails closed (typed conflict).
   * Creates no group members.
   */
  regenerateAssistantMessage(
    topicId: string,
    assistantMessageId: string,
    assistantId: string,
    currentModel?: SemanticModelSnapshot,
    branchId?: string | null
  ): ChatDbResult<SemanticResendResponse> {
    void assistantId
    return wrapResult(() => {
      syncService.throwIfPublishBarrierHeld('regenerateAssistantMessage')
      const route = this.normalizeBranchId(branchId)
      return this.db.transaction((tx) => {
        const repos = createRepositories(tx)
        const stx = tx as unknown as SyncTxExecutor
        const topic = repos.topics.getById(topicId)
        if (!topic.found) {
          throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
        }
        const selected = repos.messages.getInTopic(assistantMessageId, topicId)
        if (!selected.found || selected.data.role !== 'assistant' || (selected.data.branchId ?? null) !== route) {
          throw new ChatDbNotFoundError(`Assistant message ${assistantMessageId} does not belong to topic ${topicId}`)
        }
        const askId = selected.data.askId
        if (typeof askId !== 'string' || askId.length === 0) {
          throw new ChatDbNotFoundError(`Assistant message ${assistantMessageId} has no actionable user query`)
        }
        const userRow = repos.messages.getInTopic(askId, topicId)
        if (!userRow.found || userRow.data.role !== 'user') {
          throw new ChatDbNotFoundError(`User message ${askId} does not belong to topic ${topicId}`)
        }
        const userWireBefore = messageToWire(userRow.data)
        const userBlocksBefore = blocksToWire(repos.blocks.listByMessage(askId))
        const userWithBlocks = reconstructMessageBlockRelations([userWireBefore], userBlocksBefore)[0]

        const selectedWire = messageToWire(selected.data)
        const nowIso = new Date().toISOString()
        const hasOwnModelId = typeof selected.data.modelId === 'string' && selected.data.modelId.length > 0
        let entry: { message: JsonObject; blocks: JsonObject[] }
        if (hasOwnModelId) {
          entry = this.buildSemanticResetEntry(selectedWire, undefined, undefined, nowIso)
        } else {
          // Present-but-partial currentModel must fail closed with the same
          // full-snapshot rule as resend; absent with no self modelId also
          // fails (typed conflict, never a forged model).
          this.assertFullSemanticSnapshot(currentModel, 'currentModel')
          entry = this.buildSemanticResetEntry(
            selectedWire,
            currentModel as unknown as JsonValue,
            currentModel.id,
            nowIso
          )
        }
        const blks = repos.blocks.listByMessage(assistantMessageId)
        const blockIdsToDelete = blks.map((b) => b.id)

        const core = this.resetMessagesCoreInTx(tx, repos, stx, topicId, [entry], blockIdsToDelete, route)
        const row = repos.messages.getInTopic(assistantMessageId, topicId)
        if (!row.found || (row.data.branchId ?? null) !== route) {
          throw new ChatDbConflictError(`Semantic regenerate message ${assistantMessageId} missing after write`)
        }
        const wire = messageToWire(row.data)
        const postBlks = blocksToWire(repos.blocks.listByMessage(assistantMessageId))
        const withRel = reconstructMessageBlockRelations([wire], postBlks)[0]
        const execMessages: MessageBlockEntry[] = [{ message: withRel, blocks: [] }]
        return this.toSemanticResponse(topicId, route, askId, userWithBlocks, userBlocksBefore, execMessages, [], core)
      })
    }, `regenerateAssistantMessage(${topicId}, ${assistantMessageId})`)
  }

  /**
   * Delete a batch of messages with segment membership cleanup in the
   * same transaction. Segment memberships are removed; empty segments
   * are deleted per existing repository semantics. Segment membership
   * changes stay local-only (no segment wire fields/ops).
   *
   * Ownership enforcement: only messages owned by the request topic are
   * processed. Foreign/missing IDs are silently skipped (consistent with
   * deleteMessages semantics). File refs are collected from owned IDs
   * only, so foreign IDs never appear in the cleanup result.
   *
   * Sync (SYNC-DATA-048): for each owned/known message actually deleted,
   * enqueue the existing message delete/tombstone intent with the same
   * semantics as deleteMessages; deleted messageBlock parent frames are
   * removed; the surviving topic attempts the existing topicMessage frame
   * refresh+enqueue via the try helper (complete membership: exactly one
   * updated winning frame + one matching order_frame op; missing/
   * unversioned membership: user mutation succeeds, frame invalidated,
   * zero frame op). Malformed/high-water/transactional errors roll back
   * rows, segment memberships, outbox/tombstones/frames together.
   *
   * Returns file cleanup facts for blocks whose file_references cascade.
   *
   * Atomicity: one root SQLite transaction.
   */
  /**
   * Shared transaction-internal message deletion core.
   *
   * Runs INSIDE the caller's root `db.transaction` — never opens its own
   * transaction (no nesting). Performs the exact `deleteMessagesWithSegments`
   * cleanup/frame/sync sequence for the supplied owned IDs: file-ref harvest,
   * segment membership cleanup (empty segments auto-deleted by the
   * repository), message delete + resend-intent clear, sync delete intents,
   * and parent-frame invalidation/refresh. Returns affected file IDs; the
   * caller builds its own response in the same tx.
   */
  private deleteOwnedMessagesCoreInTx(
    _tx: unknown,
    repos: ReturnType<typeof createRepositories>,
    stx: SyncTxExecutor,
    ctx: { deviceId: string; ts: number } | null,
    topicId: string,
    ownedIds: string[],
    notify: { value: boolean },
    boundarySnapshots?: InheritanceBoundarySnapshot[],
    /**
     * Rows that must leave the authority local-only even when the caller holds a
     * sync context: branch-owned suffix rows are never on the wire, so their
     * removal carries no delete intent.
     */
    localOnlyIds?: string[]
  ): string[] {
    const localOnlySet = new Set(localOnlyIds ?? [])
    const knownIds = ctx
      ? ownedIds.filter((id) => !localOnlySet.has(id) && syncService.isKnownEntityInTx(stx, 'message', id))
      : []
    const refs = repos.fileRefs.listByMessages(ownedIds)
    const affectedFileIds = collectAffectedFileIds(refs)
    for (const seg of repos.segments.listByTopic(topicId)) {
      const segMsgIds = repos.segments.getMessageIds(seg.id)
      const toRemove = ownedIds.filter((id) => segMsgIds.includes(id))
      if (toRemove.length > 0) {
        repos.segments.removeMessages(seg.id, toRemove)
      }
    }
    if (ownedIds.length > 0) {
      // Boundary maintenance runs before the rows leave: the branch/reference
      // composition is still the pre-delete one, so the predecessor is exact.
      this.advanceInheritanceBoundariesInTx(repos, topicId, ownedIds, boundarySnapshots)
      repos.messages.deleteMany(ownedIds)
      clearResendAttemptsInTx(stx, ownedIds)
    }
    if (ctx) {
      for (const id of knownIds) {
        syncService.enqueueDeleteInTx(stx, 'message', id, ctx.ts, ctx.deviceId)
        notify.value = true
      }
    }
    if (ownedIds.length > 0) {
      for (const did of ownedIds) {
        syncService.invalidateParentFrameInTx(stx, 'messageBlock', did)
      }
      if (ctx) {
        const topicRow = repos.topics.getById(topicId)
        if (topicRow.found) {
          if (syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId) === 'refreshed') {
            notify.value = true
          }
        } else {
          syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
        }
      } else {
        syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
      }
    }
    return affectedFileIds
  }

  deleteMessagesWithSegments(
    topicId: string,
    messageIds: string[],
    branchId?: string | null
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('deleteMessagesWithSegments', topicId, route)
      let notify = false
      let result: FileCleanupResult
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          const notifyRef = { value: false }

          // BRANCH-4 owner equality only: every requested ID must be owned
          // by the addressed route (missing rows keep no-op via the guard
          // returning false; non-owned rows fail closed with zero partial
          // write). Owned rows stay deletable even when referenced by live
          // descendants (butterfly effect).
          const ownedIds: string[] = []
          for (const id of messageIds) {
            const existing = repos.messages.getInTopic(id, topicId)
            if (existing.found && (existing.data.branchId ?? null) === route) {
              ownedIds.push(id)
            } else {
              const dbForSegFilterGuard = tx as unknown as BetterSQLite3Database<typeof schema>
              this.assertMutableMessageInTx(repos, dbForSegFilterGuard, topicId, route, id)
            }
          }

          const affectedFileIds = this.deleteOwnedMessagesCoreInTx(tx, repos, stx, ctx, topicId, ownedIds, notifyRef)
          notify = notifyRef.value
          return buildFileCleanupResult(repos, affectedFileIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteMessagesWithSegments', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `deleteMessagesWithSegments(${topicId}, ${messageIds.length} msgs)`)
  }

  /**
   * Semantic plural deletion with Main-resolved dependents.
   *
   * ONE root SQLite transaction over stable root IDs:
   * - Request carries non-empty unique stable root IDs (contract-enforced,
   *   re-checked defense-in-depth as CONFLICT). Every root must exist and
   *   belong to the topic — one missing/cross-topic root fails the WHOLE
   *   command closed (NOT_FOUND, full rollback, no partial write).
   * - Expansion per root: role user => that user + every same-topic
   *   `role=assistant && askId===root`; any other role => only itself.
   *   Overlapping expansions dedupe; the expanded set is ordered by the
   *   pre-delete authority order (`sort_order ASC, id ASC`).
   * - BEFORE deleting, capture the complete authority undo snapshot from
   *   authority rows/blocks/segments (never renderer entries): full
   *   message+block wires per deleted message, contiguous restore groups
   *   with surviving anchors, and pre-delete full snapshots of intersecting
   *   segments.
   * - The actual deletion shares the exact bulk cleanup/frame/sync core
   *   (`deleteOwnedMessagesCoreInTx` — no nesting, no copied logic); then
   *   read post-delete user IDs + full segment catalog in the same tx.
   * - Commit-time notify matches the bulk path. Bulk compat
   *   (`deleteMessagesWithSegments`) behavior is unchanged.
   */
  deleteMessagesWithDependents(
    topicId: string,
    messageIds: string[],
    branchId?: string | null
  ): ChatDbResult<DeleteMessagesWithDependentsResponse> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('deleteMessagesWithDependents', topicId, route)
      let notify = false
      let result: DeleteMessagesWithDependentsResponse
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor
          if (!Array.isArray(messageIds) || messageIds.length === 0) {
            throw new ChatDbValidationError('messageIds must be a non-empty array of stable root message IDs')
          }
          const rootSet = new Set<string>(messageIds)
          if (rootSet.size !== messageIds.length) {
            throw new ChatDbConflictError('Duplicate root message IDs in the semantic delete request')
          }
          const topic = repos.topics.getById(topicId)
          if (!topic.found) {
            throw new ChatDbNotFoundError(`Topic ${topicId} does not exist`)
          }
          // Fail-closed ownership: EVERY root must belong to the addressed route.
          const rootRows = new Map<string, MessageData>()
          for (const rootId of messageIds) {
            const existing = repos.messages.getInTopic(rootId, topicId)
            if (!existing.found || (existing.data.branchId ?? null) !== route) {
              throw new ChatDbNotFoundError(`Message ${rootId} does not belong to topic ${topicId}`)
            }
            rootRows.set(rootId, existing.data)
          }
          // Dependent expansion and authority order resolve inside the
          // addressed route (dependents never cross route owners).
          const ordered = this.resolveRouteMessagesInTx(repos, topicId, route).messages
          const previousUserMessageIds = ordered.filter((m) => m.role === 'user').map((m) => m.id)
          // BRANCH-4 owner equality only: user-root expansion over the
          // effective route must not cover non-owned assistants (fail
          // closed, no partial write). Owned victims stay deletable even
          // when referenced by live descendants (butterfly effect).
          {
            const ownedIdSet = new Set(repos.messages.listByTopic(topicId, route).map((m) => m.id))
            for (const rootId of messageIds) {
              const row = rootRows.get(rootId)!
              if (row.role === 'user') {
                for (const m of ordered) {
                  if (m.role === 'assistant' && m.askId === rootId && !ownedIdSet.has(m.id)) {
                    throw new ChatDbValidationError(
                      `Message ${m.id} is shared with another route and the dependent set of ${rootId} is immutable through this route`
                    )
                  }
                }
              }
            }
          }
          // Expand user dependents; dedupe overlapping expansions.
          const ownedSet = new Set<string>()
          for (const rootId of messageIds) {
            const row = rootRows.get(rootId)!
            ownedSet.add(rootId)
            if (row.role === 'user') {
              for (const m of ordered) {
                if (m.role === 'assistant' && m.askId === rootId) ownedSet.add(m.id)
              }
            }
          }
          const ownedIds = ordered.filter((m) => ownedSet.has(m.id)).map((m) => m.id)

          // Authority undo snapshot BEFORE any write: wires, groups, segments.
          const blockMap = repos.blocks.listByMessages(ownedIds)
          const ownedRows = ordered.filter((m) => ownedSet.has(m.id))
          const ownedMsgWires = reconstructMessageBlockRelations(
            messagesToWire(ownedRows),
            blocksToWire(ownedRows.flatMap((r) => blockMap.get(r.id) ?? []))
          )
          const wireByMessageId = new Map<string, JsonObject>()
          for (const w of ownedMsgWires) wireByMessageId.set(w.id as string, w)
          const blocksByMessageId = new Map<string, JsonObject[]>()
          for (const r of ownedRows) {
            blocksByMessageId.set(r.id, blocksToWire(blockMap.get(r.id) ?? []))
          }
          const deletedBlockIds: string[] = []
          for (const oid of ownedIds) {
            for (const b of blockMap.get(oid) ?? []) deletedBlockIds.push(b.id)
          }
          // Pre-delete segment snapshots: full SegmentWire for segments
          // intersecting the expanded deletion set (affected only).
          // Unified via segmentToWire: the adapter itself omits `color`
          // unless it is a legal string, so no per-caller delete workaround.
          const toSafeSegmentWire = (
            seg: {
              id: string
              topicId: string
              name: string | null
              createdAt: string | null
              updatedAt: string | null
              sortOrder: number
              overflow: Record<string, unknown>
            },
            mids: string[],
            header: { headerMessageId: string | null; ownerTopicId: string; ownerBranchId: string | null }
          ): SegmentWire => segmentToWire(seg, mids, header)
          const segmentSnapshots: SegmentWire[] = []
          for (const seg of repos.segments.listByTopic(topicId)) {
            const mids = repos.segments.getMessageIds(seg.id)
            if (mids.some((id) => ownedSet.has(id))) {
              segmentSnapshots.push(toSafeSegmentWire(seg, mids, this.resolveSegmentHeader(repos, seg, mids)))
            }
          }
          // Contiguous restore groups in pre-delete authority order: maximal
          // runs of deleted messages; each anchor is the first surviving
          // message after its run (null at the topic tail); positionIndex is
          // the pre-delete authority index fallback.
          const restoreGroups: DeleteMessagesWithDependentsRestoreGroup[] = []
          {
            const indexById = new Map<string, number>()
            ordered.forEach((m, idx) => indexById.set(m.id, idx))
            let run: MessageData[] = []
            let runStart = -1
            const flushRun = (afterIdx: number): void => {
              if (run.length === 0) return
              let anchorMessageId: string | null = null
              for (let k = afterIdx; k < ordered.length; k++) {
                if (!ownedSet.has(ordered[k].id)) {
                  anchorMessageId = ordered[k].id
                  break
                }
              }
              restoreGroups.push({
                entries: run.map((r) => ({
                  message: wireByMessageId.get(r.id)!,
                  blocks: blocksByMessageId.get(r.id) ?? []
                })),
                positionIndex: runStart,
                anchorMessageId
              })
              run = []
              runStart = -1
            }
            for (let idx = 0; idx < ordered.length; idx++) {
              const m = ordered[idx]
              if (ownedSet.has(m.id)) {
                if (run.length === 0) runStart = idx
                run.push(m)
              } else {
                flushRun(idx)
              }
            }
            flushRun(ordered.length)
          }

          const notifyRef = { value: false }
          // Boundary snapshots stay empty unless this delete actually moves a
          // branch anchor or a cross-topic reference endpoint.
          const boundarySnapshots: InheritanceBoundarySnapshot[] = []
          const affectedFileIds = this.deleteOwnedMessagesCoreInTx(
            tx,
            repos,
            stx,
            ctx,
            topicId,
            ownedIds,
            notifyRef,
            boundarySnapshots
          )
          notify = notifyRef.value
          const remainingOrdered = repos.messages.listByTopic(topicId)
          const remainingUserMessageIds = remainingOrdered.filter((m) => m.role === 'user').map((m) => m.id)
          const segments = repos.segments.listByTopic(topicId).map((seg) => {
            const postMids = repos.segments.getMessageIds(seg.id)
            return toSafeSegmentWire(seg, postMids, this.resolveSegmentHeader(repos, seg, postMids))
          })
          const cleanup = buildFileCleanupResult(repos, affectedFileIds)
          return {
            ...cleanup,
            topicId,
            branchId: route,
            branches: this.listBranchCatalogInTx(repos, topicId),
            deletedMessageIds: ownedIds,
            deletedBlockIds,
            previousUserMessageIds,
            remainingUserMessageIds,
            segments,
            restoreGroups,
            segmentSnapshots,
            boundarySnapshots
          }
        })
      } catch (e) {
        this.recordSyncTxFailure('deleteMessagesWithDependents', ctx, e)
        throw e
      }
      if (notify) syncService.notifyEnqueued()
      return result
    }, `deleteMessagesWithDependents(${topicId}, ${messageIds.length} roots)`)
  }

  /**
   * Atomically insert an ordered batch of messages+blocks at a specified
   * position, preserving dense sort order.
   *
   * Each entry is a message with its blocks. Entries are inserted at
   * insertIndex in array order. Existing messages preserve their position.
   *
   * For existing messages that already have blocks, harvests prior file
   * references before syncFileReferences to produce accurate cleanup facts.
   * Insert-only entries return no cleanup (empty arrays).
   *
   * Rejects any existing message ID that is owned by a different topic.
   *
   * Returns file cleanup facts: affectedFileIds (from prior refs on
   * existing blocks that were replaced) and remainingReferenceCounts.
   *
   * Linear batch semantics (PERF-100 / LOCK-002): all NEW messages are
   * converted and classified first, then inserted in ONE
   * `messages.insertManyAt` batch — one sibling shift-by-count plus at most
   * one dense-order repair per topic — never M per-message `insertAt` calls
   * (M sibling shifts + M full-topic normalizations). Existing (same-topic)
   * entries preserve their position and only receive a metadata patch, and
   * in-request duplicate new IDs resolve exactly as before (first occurrence
   * inserts, later occurrences take the update path), so error precedence
   * and last-writer behavior are unchanged.
   *
   * Phase-4 block side effects (block upserts + file-reference syncs, and
   * the prior-ref harvest for existing-message entries) run in the ORIGINAL
   * request entry order (audit F1): the new/existing classification never
   * reorders them, so rare cross-entry block-ID collisions keep the same
   * last-writer and harvest timing as the legacy per-entry loop.
   *
   * Atomicity: one root SQLite transaction.
   */
  pasteMessagesToTopic(
    topicId: string,
    entries: Array<{ message: JsonObject; blocks: JsonObject[] }>,
    insertIndex?: number,
    branchId?: string | null
  ): ChatDbResult<FileCleanupResult> {
    return wrapResult(() => {
      const route = this.normalizeBranchId(branchId)
      const ctx = this.syncCtxForTopic('pasteMessagesToTopic', topicId, route)
      let syncNotify = false
      const unsupportedBlockIds: string[] = []
      let result: FileCleanupResult
      try {
        result = this.db.transaction((tx) => {
          const repos = createRepositories(tx)
          const stx = tx as unknown as SyncTxExecutor

          // Ensure topic exists (local behavior preserved). A missing target
          // topic is represented only via the existing topic upsert semantics
          // (same payload as ensureTopic/appendMessage closure, same tx, no
          // new semantics): true creation emits the topic upsert; existing
          // untracked topics are covered lazily by per-message closure below.
          const topicExistedBefore = repos.topics.getById(topicId).found
          repos.topics.ensure(topicId)
          if (ctx && !topicExistedBefore) {
            const created = repos.topics.getById(topicId)
            if (!created.found) throw new Error(`pasteMessagesToTopic topic ${topicId} missing after ensure`)
            syncService.enqueueUpsertInTx(
              stx,
              'topic',
              topicId,
              this.syncTopicPayload(created.data),
              Math.max(0, ctx.ts - 2),
              ctx.deviceId
            )
            syncNotify = true
          }

          // Compute the starting insert position within the route owner's
          // rows (append at owner end when absent).
          const resolvedInsertIndex =
            insertIndex !== undefined ? insertIndex : repos.messages.listByTopic(topicId, route).length

          // Phase 1 — convert every entry, enforce block ownership, and
          // classify as new vs existing. Cross-topic ownership and duplicate
          // new IDs are resolved here, before any write, so the first invalid
          // entry aborts the whole transaction exactly as the per-entry loop
          // did (error precedence is unchanged).
          const newMessages: MessageData[] = []
          const newMessageIds = new Set<string>()
          const existingPlans: Array<{ id: string; patch: Record<string, unknown> }> = []
          // Phase-4 side-effect order (audit F1): every entry's blocks in the
          // ORIGINAL request order. `harvest` is true only for entries whose
          // message already existed (or is an in-request duplicate — which the
          // legacy loop observed as "existing" by the time it reached them),
          // matching the legacy loop's prior-ref harvest timing exactly.
          const phase4Plans: Array<{ blocks: MessageBlockData[]; harvest: boolean }> = []
          const allAffectedFileIds: string[] = []
          // Pre-state snapshots for sync diffing (taken before any mutation in this tx).
          const preMessageRows = new Map<string, MessageData>()
          const preBlockRows = new Map<string, MessageBlockData>()
          if (ctx) {
            const seenMsg = new Set<string>()
            for (const entry of entries) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && mid.length > 0 && !seenMsg.has(mid)) {
                seenMsg.add(mid)
                const pre = repos.messages.getById(mid)
                if (pre.found) preMessageRows.set(mid, { ...pre.data, overflow: { ...pre.data.overflow } })
              }
              for (const b of entry.blocks) {
                const bid = (b as Record<string, unknown>).id as string
                if (typeof bid === 'string' && bid.length > 0 && !preBlockRows.has(bid)) {
                  const pre = repos.blocks.getById(bid)
                  if (pre.found) preBlockRows.set(bid, { ...pre.data, overflow: { ...pre.data.overflow } })
                }
              }
            }
          }

          for (const entry of entries) {
            const messageData = wireToMessage(entry.message)
            messageData.topicId = topicId
            messageData.branchId = route
            const blockDataList = entry.blocks.map(wireToBlock)

            // Enforce block ownership
            for (const block of blockDataList) {
              block.messageId = messageData.id
            }
            this.assignAuthoritativeBlockOrder(entry.message, blockDataList)

            const patch = wireToMessagePatch(entry.message)
            delete patch.id
            delete patch.topicId
            delete patch.branchId
            delete patch.sortOrder

            // Check if message already exists
            const existing = repos.messages.getById(messageData.id)

            if (existing.found) {
              // Reject cross-topic ownership
              if (existing.data.topicId !== topicId) {
                throw new ChatDbConflictError(
                  `Message ${messageData.id} belongs to topic ${existing.data.topicId}, ` +
                    `cannot paste into topic ${topicId}`
                )
              }
              // Route immutability: patching an inherited/shared row rejects.
              this.assertMutableMessageInTx(
                repos,
                tx as unknown as BetterSQLite3Database<typeof schema>,
                topicId,
                route,
                messageData.id
              )
              // Existing: preserve position, update metadata only
              existingPlans.push({ id: messageData.id, patch })
              phase4Plans.push({ blocks: blockDataList, harvest: true })
            } else if (newMessageIds.has(messageData.id)) {
              // Duplicate new ID within one request: the first occurrence is
              // inserted; later occurrences follow the established update path
              // (the legacy loop saw the just-inserted row and took the
              // existing branch, including its prior-ref harvest).
              existingPlans.push({ id: messageData.id, patch })
              phase4Plans.push({ blocks: blockDataList, harvest: true })
            } else {
              // New: batch-insert at the resolved index in array order
              newMessageIds.add(messageData.id)
              newMessages.push(messageData)
              phase4Plans.push({ blocks: blockDataList, harvest: false })
            }
          }

          // Phase 2 — batch-insert all new messages (ONE sibling shift-by-count
          // plus at most one dense-order repair; PERF-100).
          if (newMessages.length > 0) {
            repos.messages.insertManyAt(newMessages, resolvedInsertIndex)
          }

          // Phase 3 — metadata patches for existing rows and in-request
          // duplicates (applied after the batch insert so duplicate entries
          // patch the just-inserted row, matching the per-entry loop).
          for (const plan of existingPlans) {
            if (Object.keys(plan.patch).length > 0) {
              repos.messages.update(topicId, plan.id, plan.patch)
            }
          }

          // Phase 4 — harvest prior refs (existing-message entries only), then
          // upsert blocks + sync file references for ALL entries in ORIGINAL
          // request order (audit F1: the new/existing classification must not
          // reorder block side effects, so rare cross-entry block-ID collisions
          // keep the legacy per-entry loop's last-writer and harvest timing).
          for (const plan of phase4Plans) {
            if (plan.blocks.length === 0) continue
            if (plan.harvest) {
              for (const block of plan.blocks) {
                const priorRefs = repos.fileRefs.listByBlock(block.id)
                allAffectedFileIds.push(...collectAffectedFileIds(priorRefs))
              }
            }
            repos.blocks.upsertMany(plan.blocks)
            this.syncFileReferences(repos, plan.blocks)
          }

          // Transaction-bound sync intent (same atomic boundary, reused from
          // insertMessagesAfterAnchor). True-new stable messages/blocks enqueue
          // full-state upserts with membership; existing rows enqueue allowlisted
          // field diffs only with membership preserved (never backfilled);
          // transient/unsupported emit nothing.
          if (ctx) {
            let tsOffset = 0
            const nextTs = (): number => ctx.ts + tsOffset++
            // Distinct message order (first occurrence) for deterministic parent-first timestamps.
            const distinctMids: string[] = []
            const seenMids = new Set<string>()
            for (const entry of entries) {
              const mid = (entry.message as Record<string, unknown>).id as string
              if (typeof mid === 'string' && !seenMids.has(mid)) {
                seenMids.add(mid)
                distinctMids.push(mid)
              }
            }
            let hasNewInclusion = false
            let hasDemotion = false
            for (const mid of distinctMids) {
              const postRow = repos.messages.getById(mid)
              if (!postRow.found) throw new Error(`pasteMessagesToTopic message ${mid} missing in transaction`)
              const pre = preMessageRows.get(mid) ?? null
              const isTrueCreate = !pre
              const postStable = isStableMessageStatus(postRow.data.status)
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) hasDemotion = true
              if ((isTrueCreate && postStable) || (pre && !preStable && postStable)) hasNewInclusion = true
              if (!postStable) continue
              if (isTrueCreate) {
                if (!this.shouldCaptureMessageCreate(postRow.data)) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, topicId, opTs, ctx.deviceId)
                const full = this.syncMessagePayloadFull(postRow.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message', mid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message', mid, postRow.data.topicId, opTs, opId)
                syncNotify = true
              } else {
                const diff = this.diffMessagePayload(pre, postRow.data)
                if (!diff) continue
                delete diff.sortOrder
                // Diff carries only allowlisted fields; empty diff means no op.
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureTopicClosureInTx(stx, topicId, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message', mid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            // Distinct blocks in original entry order for parent-first timestamps.
            const distinctBids: string[] = []
            const seenBids = new Set<string>()
            for (const plan of phase4Plans) {
              for (const blk of plan.blocks) {
                if (!seenBids.has(blk.id)) {
                  seenBids.add(blk.id)
                  distinctBids.push(blk.id)
                }
              }
            }
            for (const bid of distinctBids) {
              const postBlk = repos.blocks.getById(bid)
              if (!postBlk.found) throw new Error(`pasteMessagesToTopic block ${bid} missing in transaction`)
              // Blocks under a transient parent never ride the wire: skip
              // without closure (closure would fail closed). The per-parent
              // frame decision below invalidates the transient parent.
              const parentMsg = repos.messages.getById(postBlk.data.messageId)
              if (!parentMsg.found || !isStableMessageStatus(parentMsg.data.status)) continue
              if (!isStableBlockStatus(postBlk.data.status)) continue
              if (this.isUnsupportedBlock(postBlk.data)) {
                unsupportedBlockIds.push(bid)
                continue
              }
              const pre = preBlockRows.get(bid) ?? null
              if (!pre) {
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                const full = this.syncBlockPayloadFull(postBlk.data)
                delete full.sortOrder
                const opId = syncService.enqueueUpsertInTx(stx, 'message_block', bid, full, opTs, ctx.deviceId)
                syncService.setMembershipClockInTx(stx, 'message_block', bid, postBlk.data.messageId, opTs, opId)
                syncNotify = true
              } else {
                if (postBlk.data.messageId !== pre.messageId) continue
                const diff = this.diffBlockPayload(pre, postBlk.data)
                if (!diff) continue
                delete diff.sortOrder
                if (Object.keys(diff).length <= 2) continue
                const opTs = nextTs()
                this.ensureBlockParentClosureInTx(stx, bid, opTs, ctx.deviceId)
                syncService.enqueueUpsertInTx(stx, 'message_block', bid, diff, opTs, ctx.deviceId)
                syncNotify = true
              }
            }
            // Local parent order frames — exactly one topicMessage attempt when
            // semantically required plus one per affected block parent where
            // required. Pure stable→stable content patches advance nothing;
            // inclusion/order changes use the existing try helpers (missing /
            // excluded invalidates with 0 op, malformed rolls back).
            if (hasDemotion) {
              syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
              for (const mid of distinctMids) {
                const pre = preMessageRows.get(mid)
                const postRow = repos.messages.getById(mid)
                const preStable = pre ? isStableMessageStatus(pre.status) : false
                const postStable = postRow.found ? isStableMessageStatus(postRow.data.status) : false
                if (pre && preStable && !postStable) {
                  syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                }
              }
            } else if (hasNewInclusion) {
              if (syncService.tryRefreshTopicMessageFrameAndEnqueueInTx(stx, topicId, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
            // Per-parent block frames: newly included parents (even empty) plus
            // any true-create or inclusion-transition block change.
            const affectedParents = new Set<string>()
            for (const mid of distinctMids) affectedParents.add(mid)
            for (const bid of distinctBids) {
              const pre = preBlockRows.get(bid)
              const postBlk = repos.blocks.getById(bid)
              if (pre) affectedParents.add(pre.messageId)
              if (postBlk.found) affectedParents.add(postBlk.data.messageId)
            }
            for (const mid of affectedParents) {
              const postMsg = repos.messages.getById(mid)
              if (!postMsg.found) continue
              const postStable = isStableMessageStatus(postMsg.data.status)
              const pre = preMessageRows.get(mid) ?? null
              const preStable = pre ? isStableMessageStatus(pre.status) : false
              if (pre && preStable && !postStable) continue // already invalidated above
              if (!postStable) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
                continue
              }
              const isNewlyIncludedParent = (!pre && postStable) || (!!pre && !preStable && postStable)
              let needsBlockFrame = isNewlyIncludedParent
              if (!needsBlockFrame) {
                for (const bid of distinctBids) {
                  const bPre = preBlockRows.get(bid)
                  const bPost = repos.blocks.getById(bid)
                  if (!bPost.found) continue
                  // Scope to blocks currently under this parent.
                  if (bPost.data.messageId !== mid && (!bPre || bPre.messageId !== mid)) continue
                  if (!bPre) {
                    needsBlockFrame = true
                    break
                  }
                  // Only blocks that belong to this parent transitionally.
                  if (bPre.messageId !== mid && bPost.data.messageId !== mid) continue
                  const preIncluded = isStableBlockStatus(bPre.status) && !this.isUnsupportedBlock(bPre)
                  const postIncluded = isStableBlockStatus(bPost.data.status) && !this.isUnsupportedBlock(bPost.data)
                  if (bPre.messageId !== bPost.data.messageId) {
                    needsBlockFrame = true
                    break
                  }
                  if (preIncluded !== postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                  // Excluded true-create under this parent must invalidate.
                  if (!postIncluded) {
                    needsBlockFrame = true
                    break
                  }
                }
                // A true-create message with no blocks still needs its empty frame.
                // Covered by isNewlyIncludedParent above.
              }
              if (!needsBlockFrame) continue
              if (syncService.tryRefreshMessageBlockFrameAndEnqueueInTx(stx, mid, ctx.deviceId) === 'refreshed') {
                syncNotify = true
              }
            }
          } else {
            // Capture disabled: preserve existing truthful invalidation, no ops.
            syncService.invalidateParentFrameInTx(stx, 'topicMessage', topicId)
            {
              const affectedMids = new Set<string>()
              for (const plan of phase4Plans) {
                for (const blk of plan.blocks) {
                  affectedMids.add(blk.messageId)
                }
              }
              for (const mid of affectedMids) {
                syncService.invalidateParentFrameInTx(stx, 'messageBlock', mid)
              }
            }
          }

          // Deduplicate affected IDs and compute remaining counts
          const uniqueAffectedIds = [...new Set(allAffectedFileIds)].sort()
          return buildFileCleanupResult(repos, uniqueAffectedIds)
        })
      } catch (e) {
        this.recordSyncTxFailure('pasteMessagesToTopic', ctx, e)
        throw e
      }
      if (syncNotify) syncService.notifyEnqueued()
      this.recordUnsupportedBlocksAfterCommit('pasteMessagesToTopic', unsupportedBlockIds)
      return result
    }, `pasteMessagesToTopic(${topicId}, ${entries.length} entries)`)
  }

  // =========================================================================
  // Phase 5.1B-2: Search
  // =========================================================================

  /**
   * Search message blocks using FTS5 normalized projection with exact
   * regex filtering (LOCK-5125).
   *
   * Returns minimal JSON-safe result data (LOCK-5128).
   * Deleted topics are NOT filtered — matching existing behavior.
   */
  searchMessages(request: SearchMessagesRequest): ChatDbResult<SearchMessagesResponse> {
    return wrapResult(
      () => {
        if (!this.sqlite) {
          throw new Error('Search requires raw SQLite handle')
        }
        const searchRepo = new SearchRepository(this.sqlite)
        return searchRepo.search(request)
      },
      `searchMessages(${request.keywords.substring(0, 50)})`
    )
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /**
   * LOCK-004: clean ordinary-chat traces for permanently deleted topics AFTER
   * the DB transaction has committed. Uses the exact deleted topic IDs
   * collected inside the mutation. Each cleanup failure is caught, logged via
   * loggerService, and is non-fatal — it never changes the already-committed
   * result. A failed transaction never reaches this helper: the mutation
   * throws before post-commit cleanup, so this is only ever called after a
   * successful commit. Soft deletes must NOT call this helper.
   */
  private cleanDeletedTopicTraces(deletedTopicIds: string[]): void {
    for (const topicId of deletedTopicIds) {
      try {
        void spanCacheService.cleanTopic(topicId).catch((error: unknown) => {
          loggerService
            .withContext('ChatDbAggregate')
            .error(
              `Trace cleanup failed for permanently deleted topic ${topicId}:`,
              error instanceof Error ? error : new Error(String(error))
            )
        })
      } catch (error) {
        loggerService
          .withContext('ChatDbAggregate')
          .error(
            `Trace cleanup failed for permanently deleted topic ${topicId}:`,
            error instanceof Error ? error : new Error(String(error))
          )
      }
    }
  }

  /**
   * Sync file references for file/image blocks.
   * Replaces stale references for each block with deterministic snapshots.
   * Non-file blocks have zero references (old refs cleared).
   */
  private syncFileReferences(repos: ChatDbRepositories, blocks: MessageBlockData[]): void {
    for (const block of blocks) {
      const newRefs = projectFileReferences(block)
      const oldRefs = repos.fileRefs.listByBlock(block.id)

      // Clear old references for this block
      if (oldRefs.length > 0) {
        repos.fileRefs.deleteByBlock(block.id)
      }

      // Create new references
      if (newRefs.length > 0) {
        repos.fileRefs.createMany(newRefs)
      }
    }
  }
}
