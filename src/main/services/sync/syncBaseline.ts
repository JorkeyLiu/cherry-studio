/**
 * Deterministic Main-only local logical baseline candidate capture.
 *
 * Provisional, internal, non-wire artifact: from one SQLite-consistent read of
 * Main chat authority, produce a deterministic, versioned, allowlisted logical
 * baseline candidate for the currently supported sync subset (topics, stable
 * messages, stable supported message blocks, plus representable tombstones and
 * entity/field version metadata).
 *
 * This artifact is a future bootstrap input only. It is NOT a convergence
 * claim, NOT a relay payload, and NOT a physical DB snapshot. `complete`
 * below means complete only within this provisional subset (see
 * `LocalSyncBaselineCompleteness`).
 *
 * Non-goals (never in this module): relay endpoints/schema, IPC/preload/shared
 * wire types, renderer/UI, pairing, cursor mutation, outbox mutation/ack,
 * apply behavior, migrations, snapshot installation. Capture is strictly
 * read-only: one synchronous Drizzle/better-sqlite3 read transaction, no
 * writes. The candidate carries no generated timestamp, random ID, device ID,
 * path, or credential.
 */

import { createHash } from 'node:crypto'

import {
  applyTopicSyncDefaults,
  filterBlockPayload,
  filterBranchPayload,
  filterMessagePayload,
  filterTopicPayload,
  isStableBlockStatus,
  isStableMessageStatus,
  isUnsupportedBlockForSync,
  SYNC_BLOCK_PATCH_FIELDS,
  SYNC_BRANCH_PATCH_FIELDS,
  SYNC_MESSAGE_PATCH_FIELDS,
  SYNC_TOPIC_PATCH_FIELDS,
  validateSyncPayloadAllowlist
} from '@shared/sync'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { decodeJson } from '../chatDb/domain/codec'
import * as schema from '../chatDb/schema'
import {
  compareDeletionClock,
  evaluateEffectiveOrder,
  isValidUnicodeScalarString,
  ORDER_FRAME_VERSION as LOCAL_ORDER_FRAME_VERSION,
  sortFramesDeterministically,
  validateFrameRowStrict,
  validateOrdinaryIdStrict
} from './syncFrameEvaluation'
import { parseStrictCursor } from './SyncService'
import { parseSyncChannelKeyValue, parseSyncOperationIdShape, parseSyncTombstoneValue } from './syncTombstoneCodec'

/** Provisional non-wire kind marker for the local baseline candidate. */
export const LOCAL_SYNC_BASELINE_KIND = 'local_sync_baseline_candidate'
/** Provisional non-wire schema version of the candidate envelope. */
export const LOCAL_SYNC_BASELINE_SCHEMA_VERSION = 'local-sync-baseline-v1'
/** Version of the provisional syncable-data inventory covered here. Frame-aware. */
export const LOCAL_SYNC_BASELINE_INVENTORY_VERSION = 'topic-message-stable-block-order-v1'
/** Local order-frame version constant. */
export const LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION = LOCAL_ORDER_FRAME_VERSION
/** Provisional non-wire scope of the candidate envelope. */
export const LOCAL_SYNC_BASELINE_SCOPE =
  'topics + stable messages + stable supported message blocks + representable tombstones + entity/field version metadata (provisional subset only; not complete-product sync)'

export class SyncBaselineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncBaselineError'
  }
}

/**
 * Completeness within the provisional subset ONLY (`complete` never claims
 * complete-product sync: structured content, attachments, segments, ordering
 * beyond sortOrder, FTS, file references, credentials, and device-local state
 * stay outside this inventory by design).
 *
 * - `complete`: every check below is satisfied within the provisional subset.
 * - `partial`: bound observation but some exclusion/unversioned/pending reason holds.
 * - `unbound`: the provisional local watermark observation is absent
 *   (channel key and/or strict cursor missing); never implies a SYNC-DATA-007
 *   no-gap watermark. Malformed known channel/cursor state throws fail-closed
 *   instead of reporting a state.
 */
export type LocalSyncBaselineCompletenessState = 'complete' | 'partial' | 'unbound'

export interface LocalSyncBaselineEntityClock {
  timestamp: number
  operationId: string
}

export interface LocalSyncBaselineFieldClock {
  field: string
  timestamp: number
  operationId: string
}

export interface LocalSyncBaselineParentMembershipClock {
  parentId: string
  timestamp: number
  operationId: string
}

export interface LocalSyncBaselineEntity {
  entityType: 'topic' | 'message' | 'message_block' | 'topic_branch' | 'file_asset'
  entityId: string
  /** Full allowlisted current state for the emitted entity (sortOrder excluded per SYNC-DATA-038). */
  payload: Record<string, unknown>
  /** Representable entity clock; null when the entity is unversioned. */
  entityClock: LocalSyncBaselineEntityClock | null
  /** Only fields admitted by the exact allowlist for this entity, sorted by field (sortOrder excluded). */
  fieldClocks: LocalSyncBaselineFieldClock[]
  /** Parent-membership clock for message/message_block; null when unversioned, absent for topic. */
  parentMembershipClock?: LocalSyncBaselineParentMembershipClock | null
}

export interface LocalSyncBaselineTombstone {
  entityType: 'topic' | 'message' | 'message_block' | 'topic_branch' | 'file_asset'
  entityId: string
  timestamp: number
  operationId: string | null
  /** Representable entity clock when one survives; null otherwise (never invented). */
  entityClock: LocalSyncBaselineEntityClock | null
}

export interface LocalSyncBaselineCompleteness {
  state: LocalSyncBaselineCompletenessState
  /** Symbolic, deterministic (sorted, unique) incompleteness reasons. */
  reasons: string[]
}

export interface LocalSyncBaselineOrderFrame {
  frameVersion: typeof LOCAL_ORDER_FRAME_VERSION
  kind: 'topicMessage' | 'messageBlock' | 'branchSuffix'
  parentId: string
  orderedChildIds: string[]
  frameClock: LocalSyncBaselineEntityClock
}

export interface LocalSyncBaselineManifest {
  schemaVersion: string
  inventoryVersion: string
  orderFrameVersion: string
  scope: string
  entityCounts: { topic: number; message: number; message_block: number; total: number }
  tombstoneCount: number
  unversionedEntityCount: number
  unversionedFieldCount: number
  unversionedMembershipCount: number
  excludedTransientMessages: number
  excludedTransientBlocks: number
  excludedUnsupportedBlocks: number
  orphanSuppressedChildren: number
  aggregateIncompleteParents: number
  frameCounts: { topicMessage: number; messageBlock: number }
  missingOrderFrameCount: number
  incompleteOrderFrameCount: number
  pendingOutboxCount: number
  observationBinding: 'bound' | 'unbound'
  completenessState: LocalSyncBaselineCompletenessState
  completenessReasons: string[]
  /** SHA-256 hex digest over the canonical candidate content excluding this value. */
  digest: string
}

export interface LocalSyncBaselineReplacementRegister {
  messageId: string
  timestamp: number
  operationId: string
  activeBlockIds: string[]
}

export interface LocalSyncBaselineFileAsset {
  entityId: string
  payload: Record<string, unknown>
  entityClock: LocalSyncBaselineEntityClock | null
  fieldClocks: LocalSyncBaselineFieldClock[]
}

export interface LocalSyncBaselineCandidate {
  kind: string
  schemaVersion: string
  inventoryVersion: string
  orderFrameVersion: string
  /** Deterministic order: topic, message, message_block, then lexical entity ID. */
  entities: LocalSyncBaselineEntity[]
  /** Deterministic order: topic, message, message_block, then lexical entity ID. */
  tombstones: LocalSyncBaselineTombstone[]
  /** Deterministic order: kind rank then parentId UTF-8 lex. */
  orderFrames: LocalSyncBaselineOrderFrame[]
  /**
   * Full current winning stable-replace registers read in the same SQLite
   * snapshot (SYNC-DATA-056 baseline v2 input). Carried as-is; the existing
   * completeness gate keeps sole authority over coverage insufficiency — no
   * guessed rules are added here. Sorted by messageId lexical (wire projection
   * re-sorts to UTF-8 byte lex). Empty when no row exists or the table is absent.
   */
  replacementRegisters: LocalSyncBaselineReplacementRegister[]
  /** File asset inventory in same snapshot (V5). Sorted lexical. */
  fileAssets: LocalSyncBaselineFileAsset[]
  /** Pending attachment intent/job counts truthful diagnostics */
  pendingAttachmentCount: number
  /**
   * Provisional local watermark OBSERVATION (current channel key), not an
   * authoritative reserved watermark. Null when unbound.
   */
  observedLocalChannelKey: string | null
  /**
   * Provisional local watermark OBSERVATION (current strict cursor), not an
   * authoritative reserved watermark. Null when unbound.
   */
  observedLocalCursor: number | null
  observationBinding: 'bound' | 'unbound'
  /** Pending outbox COUNT only; outbox payloads are never serialized here. */
  pendingOutboxCount: number
  completeness: LocalSyncBaselineCompleteness
  manifest: LocalSyncBaselineManifest
}

const TOMBSTONE_TOPIC_PREFIX = 'tombstone:topic:'
const TOMBSTONE_MESSAGE_PREFIX = 'tombstone:message:'
const TOMBSTONE_BLOCK_PREFIX = 'tombstone:message_block:'
const TOMBSTONE_BRANCH_PREFIX = 'tombstone:topic_branch:'
const CURSOR_STATE_KEY = 'cursor'
const CHANNEL_STATE_KEY = 'sync:channelKey'

const ENTITY_TYPE_PRIORITY: Record<LocalSyncBaselineEntity['entityType'], number> = {
  topic: 0,
  topic_branch: 1,
  file_asset: 2,
  message: 3,
  message_block: 4
}

// Field-clock allowlists: identity/immutable relation fields never clocked; sortOrder
// is intentionally excluded per SYNC-DATA-038 (wire truth is parent order frames).
const FIELD_CLOCK_ALLOW: Record<LocalSyncBaselineEntity['entityType'], ReadonlySet<string>> = {
  topic: new Set<string>(SYNC_TOPIC_PATCH_FIELDS as readonly string[]),
  message: new Set<string>(SYNC_MESSAGE_PATCH_FIELDS as readonly string[]),
  message_block: new Set<string>(SYNC_BLOCK_PATCH_FIELDS as readonly string[]),
  topic_branch: new Set<string>(SYNC_BRANCH_PATCH_FIELDS as readonly string[]),
  file_asset: new Set<string>(['mimeType', 'originalName', 'createdAt'] as const as readonly string[])
}

/**
 * Shared field-clock allowlist for baseline capture and bounded apply.
 * Identity/immutable relation fields are never clocked. sortOrder excluded.
 */
export const BASELINE_FIELD_CLOCK_ALLOW: Record<
  LocalSyncBaselineEntity['entityType'],
  ReadonlySet<string>
> = FIELD_CLOCK_ALLOW

function fail(message: string, cause?: unknown): never {
  throw new SyncBaselineError(message, cause === undefined ? undefined : { cause })
}

/** Lexical code-unit comparison (locale-independent, deterministic). */
function compareLexical(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Sync-specific recursively sorted compact JSON canonicalizer. Object keys are
 * sorted by UTF-16 code units; arrays preserve order. Throws fail-closed on
 * non-finite numbers and non-JSON values so the digest can never silently
 * cover an unrepresentable value.
 */
export function canonicalizeSyncJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`baseline canonicalizer rejected non-finite number ${String(value)}`)
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalizeSyncJson(entry)).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(compareLexical)
    const parts: string[] = []
    for (const key of keys) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry === undefined) fail(`baseline canonicalizer rejected undefined value for key ${key}`)
      parts.push(`${JSON.stringify(key)}:${canonicalizeSyncJson(entry)}`)
    }
    return `{${parts.join(',')}}`
  }
  fail(`baseline canonicalizer rejected unsupported JSON value of type ${typeof value}`)
}

function sha256HexUtf8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Recompute the SHA-256 manifest digest over canonical semantic content
 * (candidate minus `manifest.digest`). Shared by capture and bounded apply
 * so tamper validation cannot drift.
 */
export function computeLocalSyncBaselineDigest(candidate: LocalSyncBaselineCandidate): string {
  const manifestWithoutDigest = { ...(candidate.manifest as unknown as Record<string, unknown>) }
  delete manifestWithoutDigest.digest
  const unsigned = {
    kind: candidate.kind,
    schemaVersion: candidate.schemaVersion,
    inventoryVersion: candidate.inventoryVersion,
    orderFrameVersion: candidate.orderFrameVersion,
    entities: candidate.entities,
    tombstones: candidate.tombstones,
    orderFrames: candidate.orderFrames,
    replacementRegisters: (candidate as { replacementRegisters?: unknown }).replacementRegisters ?? [],
    fileAssets: (candidate as { fileAssets?: unknown }).fileAssets ?? [],
    pendingAttachmentCount: (candidate as { pendingAttachmentCount?: unknown }).pendingAttachmentCount ?? 0,
    observedLocalChannelKey: candidate.observedLocalChannelKey,
    observedLocalCursor: candidate.observedLocalCursor,
    observationBinding: candidate.observationBinding,
    pendingOutboxCount: candidate.pendingOutboxCount,
    completeness: candidate.completeness,
    manifest: manifestWithoutDigest
  }
  return sha256HexUtf8(canonicalizeSyncJson(unsigned))
}

/** True when the manifest digest matches recomputed canonical content. */
export function verifyLocalSyncBaselineDigest(candidate: LocalSyncBaselineCandidate): boolean {
  if (!candidate || typeof candidate !== 'object') return false
  const manifest = (candidate as { manifest?: { digest?: unknown } }).manifest
  if (!manifest || typeof manifest.digest !== 'string') return false
  try {
    return computeLocalSyncBaselineDigest(candidate) === manifest.digest
  } catch {
    return false
  }
}

function parseEntityClockRow(
  row: { timestamp: unknown; operationId: unknown },
  context: string
): LocalSyncBaselineEntityClock {
  if (typeof row.timestamp !== 'number' || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0) {
    fail(`baseline malformed entity clock timestamp for ${context}`)
  }
  let operationId: string
  try {
    operationId = parseSyncOperationIdShape(row.operationId)
    if (!isValidUnicodeScalarString(operationId)) {
      throw new Error(`malformed operationId unicode scalar for ${context}`)
    }
  } catch (e) {
    fail(`baseline malformed entity clock operationId for ${context}: ${e instanceof Error ? e.message : String(e)}`, e)
  }
  return { timestamp: row.timestamp, operationId }
}

function buildTopicPayload(data: {
  id: string
  assistantId: string | null
  name: string | null
  createdAt: string | null
  updatedAt: string | null
  deletedAt: string | null
  overflow: Record<string, unknown>
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: data.id,
    name: data.name,
    assistantId: data.assistantId,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    deletedAt: data.deletedAt
  }
  for (const key of ['pinned', 'prompt', 'isNameManuallyEdited'] as const) {
    if (Object.prototype.hasOwnProperty.call(data.overflow ?? {}, key)) {
      const value = data.overflow[key]
      if (value !== undefined) raw[key] = value
    }
  }
  // Canonical absent defaults (shared helper, same as capture path):
  // pinned=false, prompt=null, isNameManuallyEdited=false. Explicit values
  // including null are preserved, never overwritten.
  applyTopicSyncDefaults(raw)
  const filtered = filterTopicPayload(raw)
  if (!filtered) fail(`baseline topic payload filter rejected entity ${data.id}`)
  const allowErr = validateSyncPayloadAllowlist({ entityType: 'topic', payload: filtered })
  if (allowErr) fail(`baseline topic payload not allowlisted for ${data.id}: ${allowErr}`)
  return filtered
}

function buildMessagePayload(data: {
  id: string
  topicId: string
  branchId: string | null
  role: string | null
  content: string | null
  status: string | null
  askId: string | null
  model: string | null
  modelId: string | null
  assistantId: string | null
  createdAt: string | null
  updatedAt: string | null
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: data.id,
    topicId: data.topicId,
    // Immutable owner route (null = main). Never a synthetic composite key;
    // membership parent binds branchId for branch rows, topicId for main.
    branchId: data.branchId,
    role: data.role,
    content: data.content,
    status: data.status,
    askId: data.askId,
    model: data.model,
    modelId: data.modelId,
    assistantId: data.assistantId,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  }
  const filtered = filterMessagePayload(raw)
  if (!filtered) fail(`baseline message payload filter rejected entity ${data.id}`)
  const allowErr = validateSyncPayloadAllowlist({ entityType: 'message', payload: filtered })
  if (allowErr) fail(`baseline message payload not allowlisted for ${data.id}: ${allowErr}`)
  // Ensure sortOrder never leaks into baseline payload
  if (Object.prototype.hasOwnProperty.call(filtered, 'sortOrder')) {
    fail(`baseline message payload must not contain sortOrder for ${data.id}`)
  }
  return filtered
}

function buildBranchPayload(data: {
  id: string
  topicId: string
  parentBranchId: string | null
  anchorMessageId: string
  name: string | null
  createdAt: string | null
  updatedAt: string | null
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: data.id,
    topicId: data.topicId,
    parentBranchId: data.parentBranchId,
    anchorMessageId: data.anchorMessageId,
    name: data.name,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  }
  const filtered = filterBranchPayload(raw)
  if (!filtered) fail(`baseline branch payload filter rejected entity ${data.id}`)
  const allowErr = validateSyncPayloadAllowlist({ entityType: 'topic_branch', payload: filtered })
  if (allowErr) fail(`baseline branch payload not allowlisted for ${data.id}: ${allowErr}`)
  return filtered
}

function buildBlockPayload(data: {
  id: string
  messageId: string
  type: string | null
  content: string | null
  status: string | null
  createdAt: string | null
  updatedAt: string | null
  assetIds: string[]
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: data.id,
    messageId: data.messageId,
    type: data.type,
    content: data.content,
    status: data.status,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    assetIds: [...data.assetIds]
  }
  const filtered = filterBlockPayload(raw)
  if (!filtered) fail(`baseline block payload filter rejected entity ${data.id}`)
  const allowErr = validateSyncPayloadAllowlist({ entityType: 'message_block', payload: filtered })
  if (allowErr) fail(`baseline block payload not allowlisted for ${data.id}: ${allowErr}`)
  if (Object.prototype.hasOwnProperty.call(filtered, 'sortOrder')) {
    fail(`baseline block payload must not contain sortOrder for ${data.id}`)
  }
  return filtered
}

function buildFileAssetPayload(data: {
  id: string
  sha256: string
  byteLength: number
  extension: string
  mimeType: string
  originalName: string
  createdAt: string
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: data.id,
    sha256: data.sha256,
    byteLength: data.byteLength,
    extension: data.extension,
    mimeType: data.mimeType,
    originalName: data.originalName,
    createdAt: data.createdAt
  }
  // FileAsset payload is strictly validated via attachments validator outside;
  // here we just ensure allowlist shape (no extra keys) via filtered check later.
  return raw
}

function decodeOverflow(extra: string | null, table: string, id: string): Record<string, unknown> {
  try {
    return decodeJson<Record<string, unknown>>(extra, { entity: id, table, id }) ?? {}
  } catch (e) {
    fail(`baseline unreadable overflow for ${table}/${id}: ${e instanceof Error ? e.message : String(e)}`, e)
  }
}

type BaselineTx = BetterSQLite3Database<typeof schema>

/**
 * Capture the deterministic local logical baseline candidate from one
 * SQLite-consistent read transaction. Strictly read-only: no writes to chat
 * rows, outbox, applied, clocks, tombstones, cursor, or pairing state.
 *
 * Throws SyncBaselineError fail-closed on malformed known tombstone or
 * channel/cursor metadata, unreadable rows, or unrepresentable values.
 */
export function captureLocalSyncBaselineCandidate(db: BaselineTx): LocalSyncBaselineCandidate {
  return db.transaction((tx) => buildBaselineCandidate(tx as BaselineTx))
}

/**
 * Caller-owned transaction helper: build the candidate from an already-opened
 * transaction. The caller holds the single consistent SQLite snapshot covering
 * chat + binding + cursor + outbox + frames + replacement registers. Pure
 * outside the Tx is done by the caller (wire projection). Exposed for
 * publishBaseline V4 atomics and for future V5 attachment sections (same style:
 * V5 will add its own reader in the same Tx). Legacy wrapper above stays.
 */
export function buildBaselineCandidateInTx(tx: BaselineTx): LocalSyncBaselineCandidate {
  return buildBaselineCandidate(tx)
}

function buildBaselineCandidate(tx: BaselineTx): LocalSyncBaselineCandidate {
  // Materialize every input inside the single read transaction.
  const topicRows = tx.select().from(schema.topics).all()
  const messageRows = tx.select().from(schema.messages).all()
  const blockRows = tx.select().from(schema.messageBlocks).all()
  const syncStateRows = tx.select().from(schema.syncState).all()
  const entityClockRows = tx.select().from(schema.syncEntityClock).all()
  const fieldClockRows = tx.select().from(schema.syncFieldClock).all()
  const membershipRows = tx.select().from(schema.syncMembershipClock).all()
  // Frame snapshot in same read transaction
  let frameRows: (typeof schema.syncParentOrderFrame.$inferSelect)[] = []
  try {
    frameRows = tx.select().from(schema.syncParentOrderFrame).all()
  } catch (e) {
    // Pre-010 table missing is truthful partial, not throw for candidate capture?
    // However spec says existing pre-010 local states with missing frames capture as partial, not fabricated.
    // A missing table should be treated as zero frames, not throw, but validation will handle missing counts.
    // Only fail-closed if table exists but read fails unexpectedly.
    const msg = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(msg)) {
      frameRows = []
    } else {
      throw e
    }
  }
  // Stable-replace registers in the same snapshot (SYNC-DATA-056): full set,
  // carried as-is for baseline v2. Missing table (pre-013) means zero rows.
  // Malformed rows fail closed; no guessing, no backfill.
  let replacementRegisters: LocalSyncBaselineReplacementRegister[] = []
  try {
    const registerRows = tx.select().from(schema.syncStableReplaceRegister).all()
    const seenRegisterIds = new Set<string>()
    for (const row of registerRows) {
      const messageId = (row as { messageId?: unknown }).messageId
      const timestamp = (row as { timestamp?: unknown }).timestamp
      const operationId = (row as { operationId?: unknown }).operationId
      const activeJson = (row as { activeBlockIdsJson?: unknown }).activeBlockIdsJson
      try {
        validateOrdinaryIdStrict(messageId, `register/${String(messageId)}`)
      } catch (e) {
        fail(`baseline malformed replacement register id: ${e instanceof Error ? e.message : String(e)}`, e)
      }
      if (seenRegisterIds.has(messageId as string)) fail(`baseline duplicate replacement register ${String(messageId)}`)
      seenRegisterIds.add(messageId as string)
      if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
        fail(`baseline malformed replacement register timestamp for ${String(messageId)}`)
      }
      try {
        const parsedOp = parseSyncOperationIdShape(operationId)
        if (!isValidUnicodeScalarString(parsedOp)) throw new Error('malformed operationId unicode scalar')
      } catch (e) {
        fail(
          `baseline malformed replacement register operationId for ${String(messageId)}: ${e instanceof Error ? e.message : String(e)}`,
          e
        )
      }
      if (typeof activeJson !== 'string')
        fail(`baseline malformed replacement register blocks for ${String(messageId)}`)
      let active: unknown
      try {
        active = JSON.parse(activeJson)
      } catch (e) {
        fail(`baseline malformed replacement register blocks JSON for ${String(messageId)}`, e)
      }
      if (!Array.isArray(active)) fail(`baseline malformed replacement register blocks for ${String(messageId)}`)
      const activeIds: string[] = []
      const seenActive = new Set<string>()
      for (const bid of active as unknown[]) {
        try {
          validateOrdinaryIdStrict(bid, `register/${String(messageId)}/block`)
        } catch (e) {
          fail(`baseline malformed replacement register block id: ${e instanceof Error ? e.message : String(e)}`, e)
        }
        if (seenActive.has(bid as string))
          fail(`baseline duplicate replacement register block for ${String(messageId)}`)
        seenActive.add(bid as string)
        activeIds.push(bid as string)
      }
      replacementRegisters.push({
        messageId: messageId as string,
        timestamp: timestamp,
        operationId: operationId as string,
        activeBlockIds: activeIds
      })
    }
    replacementRegisters.sort((a, b) => compareLexical(a.messageId, b.messageId))
  } catch (e) {
    if (e instanceof SyncBaselineError) throw e
    const msg = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(msg)) {
      replacementRegisters = []
    } else {
      throw e
    }
  }
  const pendingOutboxCount = tx.select({ id: schema.syncOutbox.id }).from(schema.syncOutbox).all().length

  // True-branch full sync (baseline wire v3): branch-owned messages/blocks
  // are inventory members (message carries immutable branchId owner;
  // membership binds branchId for branch rows, topicId for main rows).
  // Proven branch ownership is resolved here for child stripping and block
  // owner inheritance below. Unknown ownership (pre-016 rows without the
  // column) stays main-route so existing fail-closed validation applies.
  let branchRows: Array<{
    id: string
    topicId: string
    parentBranchId: string | null
    anchorMessageId: string
    name: string | null
    createdAt: string | null
    updatedAt: string | null
  }> = []
  try {
    branchRows = tx
      .select({
        id: schema.topicBranches.id,
        topicId: schema.topicBranches.topicId,
        parentBranchId: schema.topicBranches.parentBranchId,
        anchorMessageId: schema.topicBranches.anchorMessageId,
        name: schema.topicBranches.name,
        createdAt: schema.topicBranches.createdAt,
        updatedAt: schema.topicBranches.updatedAt
      })
      .from(schema.topicBranches)
      .all()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(msg)) {
      branchRows = []
    } else {
      throw e
    }
  }
  const branchMessageIds = new Set<string>()
  const messageBranchById = new Map<string, boolean>()
  for (const row of messageRows) {
    if (typeof row.id !== 'string') continue
    const branchId = (row as { branchId?: unknown }).branchId
    const owned = typeof branchId === 'string' && branchId.length > 0
    messageBranchById.set(row.id, owned)
    if (owned) branchMessageIds.add(row.id)
  }
  const messageOwnerBranchById = new Map<string, string | null>()
  for (const row of messageRows) {
    if (typeof row.id !== 'string') continue
    const branchId = (row as { branchId?: unknown }).branchId
    messageOwnerBranchById.set(row.id, typeof branchId === 'string' && branchId.length > 0 ? branchId : null)
  }
  const localBranchIdSet = new Set<string>()
  for (const b of branchRows) {
    if (typeof b.id === 'string') localBranchIdSet.add(b.id)
  }
  // V5: file asset inventory in same snapshot (rows + fileReferences + pending capture/jobs)
  let fileAssetRows: Array<{
    id: string
    sha256: string
    byteLength: number
    extension: string
    mimeType: string
    originalName: string
    createdAt: string
  }> = []
  try {
    fileAssetRows = tx
      .select({
        id: schema.syncFileAsset.id,
        sha256: schema.syncFileAsset.sha256,
        byteLength: schema.syncFileAsset.byteLength,
        extension: schema.syncFileAsset.extension,
        mimeType: schema.syncFileAsset.mimeType,
        originalName: schema.syncFileAsset.originalName,
        createdAt: schema.syncFileAsset.createdAt
      })
      .from(schema.syncFileAsset)
      .all() as typeof fileAssetRows
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(msg)) fileAssetRows = []
    else throw e
  }
  let fileReferenceRows: Array<{ blockId: string; fileId: string }> = []
  try {
    fileReferenceRows = tx
      .select({ blockId: schema.fileReferences.blockId, fileId: schema.fileReferences.fileId })
      .from(schema.fileReferences)
      .all() as typeof fileReferenceRows
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(msg)) fileReferenceRows = []
    else throw e
  }
  const fileRefsByBlock = new Map<string, string[]>()
  for (const r of fileReferenceRows) {
    const list = fileRefsByBlock.get(r.blockId) ?? []
    list.push(r.fileId)
    fileRefsByBlock.set(r.blockId, list)
  }
  for (const [k, v] of fileRefsByBlock) {
    const uniq = [...new Set(v)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    fileRefsByBlock.set(k, uniq)
  }
  let captureIntentRows: Array<{ blockId: string; fileId: string }> = []
  try {
    captureIntentRows = tx.select().from(schema.syncAttachmentCaptureIntent).all() as typeof captureIntentRows
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(msg)) captureIntentRows = []
    else throw e
  }
  let attachmentJobRows: Array<{ assetId: string; state: string }> = []
  try {
    attachmentJobRows = tx.select().from(schema.syncAttachmentJob).all() as unknown as typeof attachmentJobRows
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(msg)) attachmentJobRows = []
    else throw e
  }
  const pendingAttachmentIntentCount = captureIntentRows.length
  const pendingAttachmentJobCount = attachmentJobRows.filter((j) => j.state !== 'completed').length
  const pendingAttachmentCount = pendingAttachmentIntentCount + pendingAttachmentJobCount
  if (branchMessageIds.size > 0) {
    const isBranchMessage = (id: string): boolean => messageBranchById.get(id) ?? false
    // Strip branch-owned children from stored topicMessage frames so a
    // stale frame can never place branch rows in main order: topicMessage
    // frames are main-owned only (branchSuffix carries owned suffixes).
    frameRows = frameRows.map((row) => {
      if ((row as { kind?: unknown }).kind !== 'topicMessage') return row
      const raw = (row as unknown as { orderedChildIdsJson?: unknown }).orderedChildIdsJson
      if (typeof raw !== 'string') return row
      let ids: unknown
      try {
        ids = JSON.parse(raw)
      } catch {
        return row
      }
      if (!Array.isArray(ids)) return row
      const stripped = ids.filter((id) => typeof id !== 'string' || !isBranchMessage(id))
      if (stripped.length === ids.length) return row
      return { ...row, orderedChildIdsJson: JSON.stringify(stripped) }
    })
  }

  const entityClockByKey = new Map<string, LocalSyncBaselineEntityClock>()
  for (const row of entityClockRows) {
    try {
      validateOrdinaryIdStrict(row.entityId, `${row.entityType}/${String(row.entityId)}`)
    } catch (e) {
      fail(
        `baseline malformed entity clock id for ${row.entityType}/${String(row.entityId)}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    const key = `${row.entityType}:${row.entityId}`
    if (entityClockByKey.has(key)) continue
    entityClockByKey.set(
      key,
      parseEntityClockRow(
        { timestamp: row.timestamp, operationId: row.operationId },
        `${row.entityType}/${row.entityId}`
      )
    )
  }
  const fieldClocksByKey = new Map<string, LocalSyncBaselineFieldClock[]>()
  for (const row of fieldClockRows) {
    try {
      validateOrdinaryIdStrict(row.entityId, `${row.entityType}/${String(row.entityId)} fieldClock`)
    } catch (e) {
      fail(
        `baseline malformed field clock id for ${row.entityType}/${String(row.entityId)}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    const allow = (FIELD_CLOCK_ALLOW as Record<string, ReadonlySet<string>>)[row.entityType]
    if (!allow || !allow.has(row.field)) continue
    // Ignore legacy sortOrder clocks: do not treat as new wire field
    if (row.field === 'sortOrder') continue
    if (typeof row.timestamp !== 'number' || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0) {
      fail(`baseline malformed field clock timestamp for ${row.entityType}/${row.entityId}/${row.field}`)
    }
    try {
      const parsedOp = parseSyncOperationIdShape(row.operationId)
      if (!isValidUnicodeScalarString(parsedOp)) {
        throw new Error(`malformed operationId unicode scalar for ${row.entityType}/${row.entityId}/${row.field}`)
      }
    } catch (e) {
      fail(
        `baseline malformed field clock operationId for ${row.entityType}/${row.entityId}/${row.field}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    const key = `${row.entityType}:${row.entityId}`
    const list = fieldClocksByKey.get(key) ?? []
    if (list.some((entry) => entry.field === row.field)) continue
    list.push({ field: row.field, timestamp: row.timestamp, operationId: row.operationId })
    fieldClocksByKey.set(key, list)
  }

  // Membership clocks: validate row type/id/parent/timestamp/operationId fail-closed.
  const membershipByKey = new Map<string, { parentId: string; timestamp: number; operationId: string }>()
  for (const row of membershipRows) {
    const childType = (row as unknown as { childEntityType: unknown }).childEntityType
    const childId = (row as unknown as { childEntityId: unknown }).childEntityId
    const parentId = (row as unknown as { parentId: unknown }).parentId
    const timestamp = (row as unknown as { timestamp: unknown }).timestamp
    const operationId = (row as unknown as { operationId: unknown }).operationId
    if (childType !== 'message' && childType !== 'message_block') {
      fail(`baseline malformed membership child type ${String(childType)} for ${String(childId)}`)
    }
    if (typeof childId !== 'string' || childId.length === 0 || !isValidUnicodeScalarString(childId)) {
      fail(`baseline malformed membership child id for ${String(childType)}/${String(childId)}`)
    }
    if (typeof parentId !== 'string' || parentId.length === 0 || !isValidUnicodeScalarString(parentId)) {
      fail(`baseline malformed membership parent for ${childType}/${childId}`)
    }
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      fail(`baseline malformed membership timestamp for ${childType}/${childId}`)
    }
    try {
      const parsedOp = parseSyncOperationIdShape(operationId)
      if (!isValidUnicodeScalarString(parsedOp)) {
        throw new Error(`malformed operationId unicode scalar for ${childType}/${childId}`)
      }
    } catch (e) {
      fail(
        `baseline malformed membership operationId for ${childType}/${childId}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    const key = `${childType}:${childId}`
    if (membershipByKey.has(key)) fail(`baseline duplicate membership for ${key}`)
    membershipByKey.set(key, { parentId: parentId, timestamp: timestamp, operationId: operationId as string })
  }

  // Topics: full current state (soft-deleted rows stay; hard-deleted rows are
  // gone and covered by tombstones below).
  const entities: LocalSyncBaselineEntity[] = []
  const emittedTopicIds = new Set<string>()
  for (const row of topicRows) {
    try {
      validateOrdinaryIdStrict(row.id, `topic/${String(row.id)}`)
    } catch (e) {
      fail(`baseline malformed topic id for ${String(row.id)}: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    const overflow = decodeOverflow(row.extra, 'topics', row.id)
    const payload = buildTopicPayload({
      id: row.id,
      assistantId: row.assistantId,
      name: row.name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      overflow
    })
    const key = `topic:${row.id}`
    entities.push({
      entityType: 'topic',
      entityId: row.id,
      payload,
      entityClock: entityClockByKey.get(key) ?? null,
      fieldClocks: (fieldClocksByKey.get(key) ?? []).slice().sort((a, b) => compareLexical(a.field, b.field))
    })
    emittedTopicIds.add(row.id)
  }

  // Messages: stable checkpoints only; never emit a child whose parent topic
  // was not emitted (no placeholders). Branch-owned rows are inventory
  // members with branchId owner (membership binds the branch id).
  let excludedTransientMessages = 0
  let orphanSuppressed = 0
  const emittedMessageIds = new Set<string>()
  const nonEmittedMessageByTopic = new Map<string, number>()
  const registerNonEmittedMessage = (topicId: string): void => {
    nonEmittedMessageByTopic.set(topicId, (nonEmittedMessageByTopic.get(topicId) ?? 0) + 1)
  }
  // Non-emitted branch-owned messages count toward their owning branch (not
  // the topic): topicMessage frames are main-owned only.
  const nonEmittedSuffixByBranch = new Map<string, number>()
  const registerNonEmittedSuffixMessage = (branchId: string): void => {
    nonEmittedSuffixByBranch.set(branchId, (nonEmittedSuffixByBranch.get(branchId) ?? 0) + 1)
  }
  // Track which messageIds are transient/excluded for frame orphan handling
  const transientMessageIds = new Set<string>()
  const orphanMessageIds = new Set<string>()
  for (const row of messageRows) {
    try {
      validateOrdinaryIdStrict(row.id, `message/${String(row.id)}`)
      validateOrdinaryIdStrict(row.topicId, `message/${String(row.id)} topicId`)
    } catch (e) {
      fail(`baseline malformed message id for ${String(row.id)}: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    const overflow = decodeOverflow(row.extra, 'messages', row.id)
    void overflow
    const rowOwnerBranch = messageOwnerBranchById.get(row.id) ?? null
    if (!isStableMessageStatus(row.status)) {
      excludedTransientMessages += 1
      transientMessageIds.add(row.id)
      if (rowOwnerBranch !== null) registerNonEmittedSuffixMessage(rowOwnerBranch)
      else registerNonEmittedMessage(row.topicId)
      continue
    }
    if (!emittedTopicIds.has(row.topicId)) {
      orphanSuppressed += 1
      orphanMessageIds.add(row.id)
      if (rowOwnerBranch !== null) registerNonEmittedSuffixMessage(rowOwnerBranch)
      else registerNonEmittedMessage(row.topicId)
      continue
    }
    // Owner branch must exist locally (FK-equivalent fail-closed): a branch
    // message without its branch row is corrupt and never emits a dangling
    // owner.
    if (rowOwnerBranch !== null && !localBranchIdSet.has(rowOwnerBranch)) {
      fail(`baseline orphan message ${row.id} branch ${rowOwnerBranch} missing`)
    }
    const payload = buildMessagePayload({
      id: row.id,
      topicId: row.topicId,
      branchId: messageOwnerBranchById.get(row.id) ?? null,
      role: row.role,
      content: row.content,
      status: row.status,
      askId: row.askId,
      model: row.model,
      modelId: row.modelId,
      assistantId: row.assistantId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    })
    const key = `message:${row.id}`
    const membership = membershipByKey.get(key)
    // Membership binds the owner: branch id for branch-owned rows, topic id
    // for main-route rows. topicId stays the immutable logical topic.
    const expectedMembershipParent = messageOwnerBranchById.get(row.id) ?? row.topicId
    if (membership && membership.parentId !== expectedMembershipParent) {
      fail(
        `baseline membership parent mismatch for message/${row.id}: membership parent ${membership.parentId} vs actual ${expectedMembershipParent}`
      )
    }
    const parentMembershipClock = membership
      ? { parentId: membership.parentId, timestamp: membership.timestamp, operationId: membership.operationId }
      : null
    entities.push({
      entityType: 'message',
      entityId: row.id,
      payload,
      entityClock: entityClockByKey.get(key) ?? null,
      fieldClocks: (fieldClocksByKey.get(key) ?? []).slice().sort((a, b) => compareLexical(a.field, b.field)),
      parentMembershipClock
    })
    emittedMessageIds.add(row.id)
  }

  // Blocks: stable + supported checkpoints only; never emit partial/null
  // shells for transient or unsupported rows, and never emit a child whose
  // parent message was not emitted (no placeholders).
  let excludedTransientBlocks = 0
  let excludedUnsupportedBlocks = 0
  const nonEmittedBlockByMessage = new Map<string, number>()
  const registerNonEmittedBlock = (messageId: string): void => {
    nonEmittedBlockByMessage.set(messageId, (nonEmittedBlockByMessage.get(messageId) ?? 0) + 1)
  }
  const transientBlockIds = new Set<string>()
  const unsupportedBlockIds = new Set<string>()
  const orphanBlockIds = new Set<string>()
  for (const row of blockRows) {
    try {
      validateOrdinaryIdStrict(row.id, `message_block/${String(row.id)}`)
      validateOrdinaryIdStrict(row.messageId, `message_block/${String(row.id)} messageId`)
    } catch (e) {
      fail(`baseline malformed block id for ${String(row.id)}: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    const overflow = decodeOverflow(row.extra, 'message_blocks', row.id)
    if (!isStableBlockStatus(row.status)) {
      excludedTransientBlocks += 1
      transientBlockIds.add(row.id)
      registerNonEmittedBlock(row.messageId)
      continue
    }
    if (isUnsupportedBlockForSync({ type: row.type, overflow })) {
      excludedUnsupportedBlocks += 1
      unsupportedBlockIds.add(row.id)
      registerNonEmittedBlock(row.messageId)
      continue
    }
    if (!emittedMessageIds.has(row.messageId)) {
      orphanSuppressed += 1
      orphanBlockIds.add(row.id)
      registerNonEmittedBlock(row.messageId)
      continue
    }
    const typeCanon = typeof row.type === 'string' ? row.type.trim().toLowerCase() : ''
    const isMedia = typeCanon === 'file' || typeCanon === 'image' || typeCanon === 'video'
    const assetIds = isMedia ? (fileRefsByBlock.get(row.id) ?? []) : []
    // V5: media blocks must carry non-empty assetIds
    if (isMedia && assetIds.length === 0) {
      excludedUnsupportedBlocks += 1
      unsupportedBlockIds.add(row.id)
      registerNonEmittedBlock(row.messageId)
      continue
    }
    const payload = buildBlockPayload({
      id: row.id,
      messageId: row.messageId,
      type: row.type,
      content: row.content,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      assetIds
    })
    const key = `message_block:${row.id}`
    const membership = membershipByKey.get(key)
    if (membership && membership.parentId !== row.messageId) {
      fail(
        `baseline membership parent mismatch for message_block/${row.id}: membership parent ${membership.parentId} vs actual ${row.messageId}`
      )
    }
    const parentMembershipClock = membership
      ? { parentId: membership.parentId, timestamp: membership.timestamp, operationId: membership.operationId }
      : null
    entities.push({
      entityType: 'message_block',
      entityId: row.id,
      payload,
      entityClock: entityClockByKey.get(key) ?? null,
      fieldClocks: (fieldClocksByKey.get(key) ?? []).slice().sort((a, b) => compareLexical(a.field, b.field)),
      parentMembershipClock
    })
  }

  // Branches: every branch row is inventory (identity + mutable state).
  // Anchor liveness is NOT a capture gate (BRANCH-5 keeps metadata while
  // the route resolves fail-closed); malformed ids fail closed below.
  const emittedBranchIds = new Set<string>()
  const branchById = new Map<string, (typeof branchRows)[number]>()
  for (const row of branchRows) {
    try {
      validateOrdinaryIdStrict(row.id, `branch/${String(row.id)}`)
      validateOrdinaryIdStrict(row.topicId, `branch/${String(row.id)} topicId`)
      if (row.parentBranchId !== null) {
        validateOrdinaryIdStrict(row.parentBranchId, `branch/${String(row.id)} parentBranchId`)
      }
      validateOrdinaryIdStrict(row.anchorMessageId, `branch/${String(row.id)} anchorMessageId`)
    } catch (e) {
      fail(`baseline malformed branch id for ${String(row.id)}: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    if (branchById.has(row.id)) fail(`baseline duplicate branch ${String(row.id)}`)
    branchById.set(row.id, row)
    if (!emittedTopicIds.has(row.topicId)) {
      orphanSuppressed += 1
      continue
    }
    const payload = buildBranchPayload({
      id: row.id,
      topicId: row.topicId,
      parentBranchId: row.parentBranchId,
      anchorMessageId: row.anchorMessageId,
      name: row.name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    })
    const key = `topic_branch:${row.id}`
    entities.push({
      entityType: 'topic_branch',
      entityId: row.id,
      payload,
      entityClock: entityClockByKey.get(key) ?? null,
      fieldClocks: (fieldClocksByKey.get(key) ?? []).slice().sort((a, b) => compareLexical(a.field, b.field))
    })
    emittedBranchIds.add(row.id)
  }

  // File assets: every sync_file_asset row is inventory (immutable id/sha/size/ext + mutable fields)
  const fileAssets: LocalSyncBaselineFileAsset[] = []
  const emittedFileAssetIds = new Set<string>()
  for (const row of fileAssetRows) {
    try {
      validateOrdinaryIdStrict(row.id, `file_asset/${String(row.id)}`)
    } catch (e) {
      fail(`baseline malformed file asset id for ${String(row.id)}: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    if (typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)) {
      fail(`baseline malformed file asset sha256 for ${String(row.id)}`)
    }
    if (typeof row.byteLength !== 'number' || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0) {
      fail(`baseline malformed file asset byteLength for ${String(row.id)}`)
    }
    if (typeof row.extension !== 'string' || !/^\.[a-z0-9]+$/.test(row.extension)) {
      fail(`baseline malformed file asset extension for ${String(row.id)}`)
    }
    if (typeof row.mimeType !== 'string' || row.mimeType.length === 0) {
      fail(`baseline malformed file asset mimeType for ${String(row.id)}`)
    }
    if (typeof row.originalName !== 'string' || row.originalName.length === 0) {
      fail(`baseline malformed file asset originalName for ${String(row.id)}`)
    }
    if (typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) {
      fail(`baseline malformed file asset createdAt for ${String(row.id)}`)
    }
    const payload = buildFileAssetPayload({
      id: row.id,
      sha256: row.sha256,
      byteLength: row.byteLength,
      extension: row.extension,
      mimeType: row.mimeType,
      originalName: row.originalName,
      createdAt: row.createdAt
    })
    const key = `file_asset:${row.id}`
    fileAssets.push({
      entityId: row.id,
      payload,
      entityClock: entityClockByKey.get(key) ?? null,
      fieldClocks: (fieldClocksByKey.get(key) ?? []).slice().sort((a, b) => compareLexical(a.field, b.field))
    })
    emittedFileAssetIds.add(row.id)
  }

  fileAssets.sort((a, b) => compareLexical(a.entityId, b.entityId))

  entities.sort((a, b) => {
    const priority = ENTITY_TYPE_PRIORITY[a.entityType] - ENTITY_TYPE_PRIORITY[b.entityType]
    if (priority !== 0) return priority
    return compareLexical(a.entityId, b.entityId)
  })

  // Tombstones: only valid known tombstone:<entityType>:<entityId> records.
  const tombstones: LocalSyncBaselineTombstone[] = []
  for (const row of syncStateRows) {
    const key = row.key as unknown
    if (typeof key !== 'string') fail(`baseline malformed tombstone key ${JSON.stringify(String(key)).slice(0, 80)}`)
    if (!key.startsWith('tombstone:')) continue
    let entityType: LocalSyncBaselineEntity['entityType'] | null = null
    let entityId = ''
    if (key.startsWith(TOMBSTONE_TOPIC_PREFIX)) {
      entityType = 'topic'
      entityId = key.slice(TOMBSTONE_TOPIC_PREFIX.length)
    } else if (key.startsWith(TOMBSTONE_BRANCH_PREFIX)) {
      entityType = 'topic_branch'
      entityId = key.slice(TOMBSTONE_BRANCH_PREFIX.length)
    } else if (key.startsWith(TOMBSTONE_BLOCK_PREFIX)) {
      entityType = 'message_block'
      entityId = key.slice(TOMBSTONE_BLOCK_PREFIX.length)
    } else if (key.startsWith(TOMBSTONE_MESSAGE_PREFIX)) {
      entityType = 'message'
      entityId = key.slice(TOMBSTONE_MESSAGE_PREFIX.length)
    } else if (key.startsWith('tombstone:file_asset:')) {
      entityType = 'file_asset'
      entityId = key.slice('tombstone:file_asset:'.length)
    } else {
      fail(`baseline malformed tombstone key ${JSON.stringify(key).slice(0, 80)}`)
    }
    if (!entityType || entityId.length === 0 || !isValidUnicodeScalarString(entityId)) {
      fail(`baseline malformed tombstone key ${JSON.stringify(key).slice(0, 80)}`)
    }
    if (row.value === null || row.value === undefined) {
      fail(`baseline malformed tombstone value for ${entityType}/${entityId}: missing`)
    }
    let parsed: { timestamp: number; operationId: string | null }
    try {
      const result = parseSyncTombstoneValue(row.value)
      if (!result) fail(`baseline malformed tombstone value for ${entityType}/${entityId}: missing`)
      if (result.operationId !== null && !isValidUnicodeScalarString(result.operationId)) {
        throw new Error(`malformed tombstone operationId unicode scalar for ${entityType}/${entityId}`)
      }
      parsed = result
    } catch (e) {
      if (e instanceof SyncBaselineError) throw e
      fail(
        `baseline malformed tombstone value for ${entityType}/${entityId}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    const clockKey = `${entityType}:${entityId}`
    tombstones.push({
      entityType,
      entityId,
      timestamp: (parsed as { timestamp: number; operationId: string | null }).timestamp,
      operationId: (parsed as { timestamp: number; operationId: string | null }).operationId,
      entityClock: entityClockByKey.get(clockKey) ?? null
    })
  }
  tombstones.sort((a, b) => {
    const priority = ENTITY_TYPE_PRIORITY[a.entityType] - ENTITY_TYPE_PRIORITY[b.entityType]
    if (priority !== 0) return priority
    return compareLexical(a.entityId, b.entityId)
  })

  // Membership orphan / retained / excluded handling
  {
    const messageById = new Map<string, (typeof messageRows)[number]>()
    for (const row of messageRows) messageById.set(row.id, row)
    const blockById = new Map<string, (typeof blockRows)[number]>()
    for (const row of blockRows) blockById.set(row.id, row)
    const emittedKeys = new Set<string>(entities.map((e) => `${e.entityType}:${e.entityId}`))
    const tombstoneKeys = new Set<string>(tombstones.map((t) => `${t.entityType}:${t.entityId}`))
    for (const [key, membership] of membershipByKey) {
      if (emittedKeys.has(key)) continue
      let childType: 'message' | 'message_block'
      let childId: string
      if (key.startsWith('message_block:')) {
        childType = 'message_block'
        childId = key.slice('message_block:'.length)
      } else if (key.startsWith('message:')) {
        childType = 'message'
        childId = key.slice('message:'.length)
      } else {
        fail(`baseline malformed membership key ${JSON.stringify(key).slice(0, 80)}`)
      }
      let businessRow: { parentId: string } | null = null
      let isExcludedTransientOrUnsupported = false
      if (childType === 'message') {
        const row = messageById.get(childId)
        if (row) {
          const owner = messageOwnerBranchById.get(childId) ?? row.topicId
          businessRow = { parentId: owner }
          if (!isStableMessageStatus(row.status)) isExcludedTransientOrUnsupported = true
          else if (!emittedTopicIds.has(row.topicId)) isExcludedTransientOrUnsupported = true
        }
      } else {
        const row = blockById.get(childId)
        if (row) {
          businessRow = { parentId: row.messageId }
          if (!isStableBlockStatus(row.status)) isExcludedTransientOrUnsupported = true
          else {
            let overflow: Record<string, unknown> = {}
            try {
              overflow = decodeOverflow(row.extra, 'message_blocks', row.id)
            } catch {}
            if (isUnsupportedBlockForSync({ type: row.type, overflow })) isExcludedTransientOrUnsupported = true
            else if (!emittedMessageIds.has(row.messageId)) isExcludedTransientOrUnsupported = true
          }
        }
      }
      if (businessRow) {
        if (businessRow.parentId !== membership.parentId) {
          fail(
            `baseline membership parent mismatch for ${childType}/${childId}: membership parent ${membership.parentId} vs actual ${businessRow.parentId}`
          )
        }
        if (isExcludedTransientOrUnsupported) {
          continue
        }
        if (tombstoneKeys.has(key)) continue
        fail(
          `baseline orphan membership for ${key} with no tombstone: retained membership for live stable child that was not emitted`
        )
      } else {
        if (tombstoneKeys.has(key)) continue
        fail(`baseline orphan membership for ${key} with no business row or tombstone`)
      }
    }
  }

  // Determine suppressed live entities (tombstone wins) for frame full-set
  const suppressedLiveForFrame = new Set<string>()
  const tombByKeyForSuppression = new Map<string, LocalSyncBaselineTombstone>()
  for (const t of tombstones) tombByKeyForSuppression.set(`${t.entityType}:${t.entityId}`, t)
  for (const e of entities) {
    const key = `${e.entityType}:${e.entityId}`
    const tomb = tombByKeyForSuppression.get(key)
    if (!tomb || !e.entityClock) continue
    const liveTs = e.entityClock.timestamp
    const liveOp = e.entityClock.operationId
    let suppressed = false
    if (tomb.operationId === null) {
      suppressed = liveTs <= tomb.timestamp
    } else {
      if (liveTs !== tomb.timestamp) suppressed = liveTs < tomb.timestamp
      else
        suppressed =
          compareDeletionClock(
            { timestamp: tomb.timestamp, operationId: tomb.operationId },
            { timestamp: liveTs, operationId: liveOp }
          ) >= 0
    }
    if (suppressed) suppressedLiveForFrame.add(key)
  }

  // -------------------------------------------------------------------------
  // Frame capture in same read snapshot
  // -------------------------------------------------------------------------
  const tombstoneKeysSet = new Set<string>(tombstones.map((t) => `${t.entityType}:${t.entityId}`))
  // Build maps for quick membership lookup
  const messageByIdAll = new Map<string, (typeof messageRows)[number]>()
  for (const r of messageRows) messageByIdAll.set(r.id, r)
  const blockByIdAll = new Map<string, (typeof blockRows)[number]>()
  for (const r of blockRows) blockByIdAll.set(r.id, r)
  const branchIdSetAll = new Set<string>()
  for (const r of branchRows) {
    if (typeof r.id === 'string') branchIdSetAll.add(r.id)
  }
  const branchByIdAllHas = (id: string): boolean => branchIdSetAll.has(id)
  // Live children maps for frame evaluation.
  // topicMessage frames are main-owned only: only branchId-null messages
  // join the per-topic map. Branch-owned messages join the per-branch
  // suffix map keyed by their owning branch id.
  const messagesByTopic = new Map<string, Map<string, { timestamp: number; operationId: string }>>()
  const suffixByBranch = new Map<string, Map<string, { timestamp: number; operationId: string }>>()
  for (const e of entities) {
    if (e.entityType === 'message') {
      if (suppressedLiveForFrame.has(`message:${e.entityId}`)) continue
      const pm = e.parentMembershipClock as { timestamp: number; operationId: string } | null | undefined
      if (!pm) continue // unversioned, but still need map for evaluation? We'll keep map only for versioned; unversioned will be handled via counts
      const ownerBranch = (e.payload.branchId as string | null | undefined) ?? null
      if (ownerBranch !== null) {
        let m = suffixByBranch.get(ownerBranch)
        if (!m) {
          m = new Map()
          suffixByBranch.set(ownerBranch, m)
        }
        m.set(e.entityId, { timestamp: pm.timestamp, operationId: pm.operationId })
      } else {
        const topicId = e.payload.topicId as string
        let m = messagesByTopic.get(topicId)
        if (!m) {
          m = new Map()
          messagesByTopic.set(topicId, m)
        }
        m.set(e.entityId, { timestamp: pm.timestamp, operationId: pm.operationId })
      }
    }
  }
  const blocksByMessage = new Map<string, Map<string, { timestamp: number; operationId: string }>>()
  for (const e of entities) {
    if (e.entityType === 'message_block') {
      if (suppressedLiveForFrame.has(`message_block:${e.entityId}`)) continue
      const messageId = e.payload.messageId as string
      const pm = e.parentMembershipClock as { timestamp: number; operationId: string } | null | undefined
      if (!pm) continue
      let m = blocksByMessage.get(messageId)
      if (!m) {
        m = new Map()
        blocksByMessage.set(messageId, m)
      }
      m.set(e.entityId, { timestamp: pm.timestamp, operationId: pm.operationId })
    }
  }

  // Validate frame rows centrally (strict kind/version/JSON/ID/clock)
  const frameByKey = new Map<
    string,
    {
      orderedChildIds: string[]
      timestamp: number
      operationId: string
      frameVersion: string
      kind: string
      parentId: string
    }
  >()
  for (const row of frameRows) {
    let validated: {
      kind: 'topicMessage' | 'messageBlock' | 'branchSuffix'
      parentId: string
      orderedChildIds: string[]
      timestamp: number
      operationId: string
    }
    try {
      validated = validateFrameRowStrict(
        {
          kind: (row as unknown as { kind: unknown }).kind,
          parentId: (row as unknown as { parentId: unknown }).parentId,
          frameVersion: (row as unknown as { frameVersion: unknown }).frameVersion,
          orderedChildIdsJson: (row as unknown as { orderedChildIdsJson: unknown }).orderedChildIdsJson,
          timestamp: (row as unknown as { timestamp: unknown }).timestamp,
          operationId: (row as unknown as { operationId: unknown }).operationId
        },
        `frame/${String((row as unknown as { parentId: unknown }).parentId)}`
      )
    } catch (e) {
      if (e instanceof SyncBaselineError) throw e
      fail(
        `baseline malformed frame for parent ${String((row as unknown as { parentId: unknown }).parentId)}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    const key = `${validated.kind}:${validated.parentId}`
    if (frameByKey.has(key)) fail(`baseline duplicate frame for ${key}`)
    frameByKey.set(key, {
      orderedChildIds: validated.orderedChildIds,
      timestamp: validated.timestamp,
      operationId: validated.operationId,
      frameVersion: LOCAL_ORDER_FRAME_VERSION,
      kind: validated.kind,
      parentId: validated.parentId
    })
  }

  // Kind-specific parent validation + retained/excluded/orphan handling
  const retainedOmittedFrames: typeof frameByKey = new Map()
  for (const [key, frame] of frameByKey) {
    const kind = frame.kind as 'topicMessage' | 'messageBlock' | 'branchSuffix'
    const parentId = frame.parentId
    // Strict kind-specific parent existence check before tombstone logic
    const existsAsTopic = topicRows.some((r) => r.id === parentId)
    const existsAsMessage = messageByIdAll.has(parentId)
    const existsAsBlock = blockByIdAll.has(parentId)
    const existsAsBranch = branchByIdAllHas(parentId)
    if (kind === 'topicMessage') {
      if (existsAsMessage || existsAsBlock || existsAsBranch) {
        fail(
          `baseline wrong-kind frame parent for topicMessage/${parentId}: known parent is ${existsAsMessage ? 'message' : existsAsBlock ? 'message_block' : 'branch'}`
        )
      }
    } else if (kind === 'branchSuffix') {
      if (existsAsTopic || existsAsMessage || existsAsBlock) {
        fail(
          `baseline wrong-kind frame parent for branchSuffix/${parentId}: known parent is ${existsAsTopic ? 'topic' : existsAsMessage ? 'message' : 'message_block'}`
        )
      }
    } else {
      if (existsAsTopic || existsAsBlock || existsAsBranch) {
        // messageBlock parent must be a message; block, topic, or branch is wrong kind
        if (existsAsTopic) fail(`baseline wrong-kind frame parent for messageBlock/${parentId}: known parent is topic`)
        if (existsAsBlock)
          fail(`baseline wrong-kind frame parent for messageBlock/${parentId}: known parent is message_block`)
        if (existsAsBranch)
          fail(`baseline wrong-kind frame parent for messageBlock/${parentId}: known parent is branch`)
      }
    }
    const isTopicParent = kind === 'topicMessage'
    const isBranchParent = kind === 'branchSuffix'
    const isLiveRaw = isTopicParent
      ? emittedTopicIds.has(parentId)
      : isBranchParent
        ? emittedBranchIds.has(parentId)
        : emittedMessageIds.has(parentId)
    const isSuppressed = isTopicParent
      ? suppressedLiveForFrame.has(`topic:${parentId}`)
      : isBranchParent
        ? suppressedLiveForFrame.has(`topic_branch:${parentId}`)
        : suppressedLiveForFrame.has(`message:${parentId}`)
    const isLiveEmitted = isLiveRaw && !isSuppressed
    if (isLiveEmitted) continue
    const hasTombstone = isTopicParent
      ? tombstoneKeysSet.has(`topic:${parentId}`)
      : isBranchParent
        ? tombstoneKeysSet.has(`topic_branch:${parentId}`)
        : tombstoneKeysSet.has(`message:${parentId}`)
    if (hasTombstone) {
      retainedOmittedFrames.set(key, frame)
      continue
    }
    if (!isTopicParent && !isBranchParent) {
      const msgRow = messageByIdAll.get(parentId)
      if (msgRow) {
        if (transientMessageIds.has(parentId) || orphanMessageIds.has(parentId)) {
          retainedOmittedFrames.set(key, frame)
          continue
        }
      }
    }
    if (!existsAsTopic && !existsAsMessage && !existsAsBlock && !existsAsBranch) {
      fail(`baseline orphan frame for ${kind}/${parentId} with no business row or tombstone`)
    }
    // Current non-emitted transient/excluded parent frames may be omitted under truthful existing diagnostics
    if (existsAsTopic || existsAsMessage || existsAsBranch) {
      // If parent exists but is not emitted and not tombstoned, it must be an excluded transient/unsupported/orphan-suppressed parent already counted in diagnostics; omit truthfully
      const isExcluded = isTopicParent
        ? false
        : isBranchParent
          ? orphanMessageIds.has(parentId)
          : transientMessageIds.has(parentId) || orphanMessageIds.has(parentId) || unsupportedBlockIds.has(parentId)
      if (isExcluded || orphanMessageIds.has(parentId) || orphanBlockIds.has(parentId)) {
        retainedOmittedFrames.set(key, frame)
        continue
      }
      // Otherwise, orphan-suppressed stable parent that still has a frame is unexpected; treat as omitted only if already excluded, else fail as wrong retained
      // For safety, omit without missing count if parent is not live emitted but exists as stable non-emitted (already orphan suppressed)
      retainedOmittedFrames.set(key, frame)
      continue
    }
    retainedOmittedFrames.set(key, frame)
  }
  for (const k of retainedOmittedFrames.keys()) frameByKey.delete(k)

  // For each remaining frame, validate parent mismatch/invalid child relationships where knowable
  // This will be handled in evaluation's childParentLookup; but we also check that frame parent actually matches live children mapping existence
  // If frame's orderedChildIds contains a child whose membership parentId differs, we will throw during evaluation.

  // Now evaluate each required parent's frame: produce effective frames or mark missing/incomplete
  const outputFrames: LocalSyncBaselineOrderFrame[] = []
  let missingOrderFrameCount = 0
  let incompleteOrderFrameCount = 0
  const frameDiagnosticReasons = new Set<string>()

  // Helper to get childParentLookup for a given parent
  const makeLookup = (
    kind: 'topicMessage' | 'messageBlock' | 'branchSuffix',
    _parentId: string
  ): ((cid: string) => { parentId: string | null; exists: boolean } | null) => {
    return (cid: string) => {
      if (kind === 'topicMessage') {
        const row = messageByIdAll.get(cid)
        if (!row) {
          // Check if block? Actually message children are messages, so check message table
          // Unknown child -> no existence
          const existsAsBlock = blockByIdAll.has(cid)
          if (existsAsBlock) return { parentId: blockByIdAll.get(cid)!.messageId, exists: true }
          if (branchByIdAllHas(cid)) return { parentId: null, exists: true }
          return { parentId: null, exists: false }
        }
        const mem = membershipByKey.get(`message:${cid}`)
        if (mem) return { parentId: mem.parentId, exists: true }
        return { parentId: row.topicId, exists: true }
      } else if (kind === 'branchSuffix') {
        const row = messageByIdAll.get(cid)
        if (!row) {
          if (branchByIdAllHas(cid)) return { parentId: null, exists: true }
          return { parentId: null, exists: false }
        }
        const mem = membershipByKey.get(`message:${cid}`)
        if (mem) return { parentId: mem.parentId, exists: true }
        return { parentId: messageOwnerBranchById.get(cid) ?? row.topicId, exists: true }
      } else {
        const row = blockByIdAll.get(cid)
        if (!row) {
          const existsAsMsg = messageByIdAll.has(cid)
          if (existsAsMsg) return { parentId: messageByIdAll.get(cid)!.topicId, exists: true }
          if (branchByIdAllHas(cid)) return { parentId: null, exists: true }
          return { parentId: null, exists: false }
        }
        const mem = membershipByKey.get(`message_block:${cid}`)
        if (mem) return { parentId: mem.parentId, exists: true }
        return { parentId: row.messageId, exists: true }
      }
    }
  }

  // Unversioned children make affected frame non-complete/unevaluable (A1)
  const unversionedMessageByTopicCount = new Map<string, number>()
  const unversionedBlockByMessageCount = new Map<string, number>()
  const unversionedSuffixByBranchCount = new Map<string, number>()
  for (const e of entities) {
    if (e.entityType === 'message' && !e.parentMembershipClock) {
      const ownerBranch = (e.payload.branchId as string | null | undefined) ?? null
      if (ownerBranch !== null) {
        unversionedSuffixByBranchCount.set(ownerBranch, (unversionedSuffixByBranchCount.get(ownerBranch) ?? 0) + 1)
      } else {
        const tid = e.payload.topicId as string
        unversionedMessageByTopicCount.set(tid, (unversionedMessageByTopicCount.get(tid) ?? 0) + 1)
      }
    }
    if (e.entityType === 'message_block' && !e.parentMembershipClock) {
      const mid = e.payload.messageId as string
      unversionedBlockByMessageCount.set(mid, (unversionedBlockByMessageCount.get(mid) ?? 0) + 1)
    }
  }

  // For each emitted live topic (skip suppressed tombstoned)
  for (const topicId of emittedTopicIds) {
    if (suppressedLiveForFrame.has(`topic:${topicId}`)) continue
    const key = `topicMessage:${topicId}`
    const liveMap = messagesByTopic.get(topicId) ?? new Map()
    const rawFrame = frameByKey.get(key)
    const hasUnversionedChild = (unversionedMessageByTopicCount.get(topicId) ?? 0) > 0
    if (!rawFrame) {
      missingOrderFrameCount += 1
      frameDiagnosticReasons.add('missing-order-frame')
      // Missing frame with unversioned child still counts as missing; incomplete also implied but missing is the exact diagnostic
      continue
    }
    let result: ReturnType<typeof evaluateEffectiveOrder>
    try {
      result = evaluateEffectiveOrder({
        kind: 'topicMessage',
        parentId: topicId,
        orderedChildIds: rawFrame.orderedChildIds,
        frameClock: { timestamp: rawFrame.timestamp, operationId: rawFrame.operationId },
        liveChildren: liveMap,
        childParentLookup: makeLookup('topicMessage', topicId)
      })
    } catch (e) {
      fail(
        `baseline frame parent mismatch for topicMessage/${topicId}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    let isIncomplete = result.incomplete
    // A1: unversioned live child makes frame incomplete/unevaluable even if versioned subset was complete
    if (hasUnversionedChild) isIncomplete = true
    if (isIncomplete) {
      incompleteOrderFrameCount += 1
      frameDiagnosticReasons.add('incomplete-order-frame')
    }
    const effectiveIds = result.effective
    outputFrames.push({
      frameVersion: LOCAL_ORDER_FRAME_VERSION,
      kind: 'topicMessage',
      parentId: topicId,
      orderedChildIds: effectiveIds,
      frameClock: { timestamp: rawFrame.timestamp, operationId: rawFrame.operationId }
    })
    frameByKey.delete(key)
  }

  for (const messageId of emittedMessageIds) {
    if (suppressedLiveForFrame.has(`message:${messageId}`)) continue
    const key = `messageBlock:${messageId}`
    const liveMap = blocksByMessage.get(messageId) ?? new Map()
    const rawFrame = frameByKey.get(key)
    const hasUnversionedChild = (unversionedBlockByMessageCount.get(messageId) ?? 0) > 0
    if (!rawFrame) {
      missingOrderFrameCount += 1
      frameDiagnosticReasons.add('missing-order-frame')
      continue
    }
    let result: ReturnType<typeof evaluateEffectiveOrder>
    try {
      result = evaluateEffectiveOrder({
        kind: 'messageBlock',
        parentId: messageId,
        orderedChildIds: rawFrame.orderedChildIds,
        frameClock: { timestamp: rawFrame.timestamp, operationId: rawFrame.operationId },
        liveChildren: liveMap,
        childParentLookup: makeLookup('messageBlock', messageId)
      })
    } catch (e) {
      fail(
        `baseline frame parent mismatch for messageBlock/${messageId}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    let isIncomplete = result.incomplete
    if (hasUnversionedChild) isIncomplete = true
    if (isIncomplete) {
      incompleteOrderFrameCount += 1
      frameDiagnosticReasons.add('incomplete-order-frame')
    }
    outputFrames.push({
      frameVersion: LOCAL_ORDER_FRAME_VERSION,
      kind: 'messageBlock',
      parentId: messageId,
      orderedChildIds: result.effective,
      frameClock: { timestamp: rawFrame.timestamp, operationId: rawFrame.operationId }
    })
    frameByKey.delete(key)
  }

  // For each emitted live branch (skip suppressed tombstoned): exactly one
  // branchSuffix frame, empty [] when the branch owns no live children.
  for (const branchId of emittedBranchIds) {
    if (suppressedLiveForFrame.has(`topic_branch:${branchId}`)) continue
    const key = `branchSuffix:${branchId}`
    const liveMap = suffixByBranch.get(branchId) ?? new Map()
    const rawFrame = frameByKey.get(key)
    const hasUnversionedChild = (unversionedSuffixByBranchCount.get(branchId) ?? 0) > 0
    if (!rawFrame) {
      missingOrderFrameCount += 1
      frameDiagnosticReasons.add('missing-order-frame')
      continue
    }
    let result: ReturnType<typeof evaluateEffectiveOrder>
    try {
      result = evaluateEffectiveOrder({
        kind: 'branchSuffix',
        parentId: branchId,
        orderedChildIds: rawFrame.orderedChildIds,
        frameClock: { timestamp: rawFrame.timestamp, operationId: rawFrame.operationId },
        liveChildren: liveMap,
        childParentLookup: makeLookup('branchSuffix', branchId)
      })
    } catch (e) {
      fail(
        `baseline frame parent mismatch for branchSuffix/${branchId}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    let isIncomplete = result.incomplete
    if (hasUnversionedChild) isIncomplete = true
    if (isIncomplete) {
      incompleteOrderFrameCount += 1
      frameDiagnosticReasons.add('incomplete-order-frame')
    }
    outputFrames.push({
      frameVersion: LOCAL_ORDER_FRAME_VERSION,
      kind: 'branchSuffix',
      parentId: branchId,
      orderedChildIds: result.effective,
      frameClock: { timestamp: rawFrame.timestamp, operationId: rawFrame.operationId }
    })
    frameByKey.delete(key)
  }

  // Sort frames deterministically
  const sortedFrames = sortFramesDeterministically(
    outputFrames as Array<{ kind: 'topicMessage' | 'messageBlock' | 'branchSuffix'; parentId: string }>
  ) as LocalSyncBaselineOrderFrame[]

  // Provisional local watermark observation
  const channelRow = syncStateRows.find((row) => row.key === CHANNEL_STATE_KEY)
  const cursorRow = syncStateRows.find((row) => row.key === CURSOR_STATE_KEY)
  let observedLocalChannelKey: string | null = null
  let observedLocalCursor: number | null = null
  if (channelRow) {
    try {
      observedLocalChannelKey = parseSyncChannelKeyValue(channelRow.value)
    } catch (e) {
      fail(`baseline malformed observed channel key: ${e instanceof Error ? e.message : String(e)}`, e)
    }
  }
  if (cursorRow) {
    if (cursorRow.value === null || cursorRow.value === undefined) {
      fail('baseline malformed observed cursor: missing value')
    }
    try {
      observedLocalCursor = parseStrictCursor(cursorRow.value)
    } catch (e) {
      fail(`baseline malformed observed cursor: ${e instanceof Error ? e.message : String(e)}`, e)
    }
  }
  const observationBinding: 'bound' | 'unbound' =
    observedLocalChannelKey !== null && observedLocalCursor !== null ? 'bound' : 'unbound'

  // Completeness
  const reasons = new Set<string>()
  if (observationBinding === 'unbound') reasons.add('observed-watermark-unbound')
  if (excludedTransientMessages > 0) reasons.add('transient-message-excluded')
  if (excludedTransientBlocks > 0) reasons.add('transient-block-excluded')
  if (excludedUnsupportedBlocks > 0) reasons.add('unsupported-block-excluded')
  if (orphanSuppressed > 0) reasons.add('orphan-child-suppressed')
  let unversionedEntityCount = 0
  for (const entity of entities) {
    if (!entity.entityClock) unversionedEntityCount += 1
  }
  for (const fa of fileAssets) {
    if (!fa.entityClock) unversionedEntityCount += 1
  }
  if (unversionedEntityCount > 0) reasons.add('unversioned-entity')
  let unversionedFieldCount = 0
  for (const entity of entities) {
    const allow = FIELD_CLOCK_ALLOW[entity.entityType]
    const present = new Set(entity.fieldClocks.map((entry) => entry.field))
    for (const key of Object.keys(entity.payload)) {
      if (allow.has(key) && !present.has(key)) {
        if (key === 'assetIds') continue
        unversionedFieldCount += 1
      }
    }
    for (const field of present) {
      if (!Object.prototype.hasOwnProperty.call(entity.payload, field)) unversionedFieldCount += 1
    }
  }
  for (const fa of fileAssets) {
    const allow = FIELD_CLOCK_ALLOW['file_asset' as const]
    const present = new Set(fa.fieldClocks.map((entry) => entry.field))
    for (const key of Object.keys(fa.payload)) {
      if (allow.has(key) && !present.has(key)) unversionedFieldCount += 1
    }
    for (const field of present) {
      if (!Object.prototype.hasOwnProperty.call(fa.payload, field)) unversionedFieldCount += 1
    }
  }
  if (unversionedFieldCount > 0) reasons.add('unversioned-field')
  let unversionedMembershipCount = 0
  for (const entity of entities) {
    // Topics/branches/file_assets carry no membership; only messages/blocks bind membership.
    if (entity.entityType !== 'topic' && entity.entityType !== 'topic_branch' && entity.entityType !== 'file_asset') {
      const pm = (entity as { parentMembershipClock?: { timestamp: number; operationId: string } | null })
        .parentMembershipClock
      if (!pm) unversionedMembershipCount += 1
    }
  }
  if (unversionedMembershipCount > 0) reasons.add('unversioned-membership')
  if (pendingOutboxCount > 0) reasons.add('pending-outbox')
  if (pendingAttachmentCount > 0) reasons.add('pending-attachment')
  let aggregateIncompleteParents = 0
  for (const entity of entities) {
    if (entity.entityType === 'topic' && (nonEmittedMessageByTopic.get(entity.entityId) ?? 0) > 0) {
      aggregateIncompleteParents += 1
    }
    if (entity.entityType === 'message' && (nonEmittedBlockByMessage.get(entity.entityId) ?? 0) > 0) {
      aggregateIncompleteParents += 1
    }
    if (entity.entityType === 'topic_branch' && (nonEmittedSuffixByBranch.get(entity.entityId) ?? 0) > 0) {
      aggregateIncompleteParents += 1
    }
  }
  if (aggregateIncompleteParents > 0) reasons.add('aggregate-incomplete-child-excluded')
  if (missingOrderFrameCount > 0) reasons.add('missing-order-frame')
  if (incompleteOrderFrameCount > 0) reasons.add('incomplete-order-frame')
  for (const r of frameDiagnosticReasons) reasons.add(r)
  const sortedReasons = [...reasons].sort(compareLexical)
  const state: LocalSyncBaselineCompletenessState =
    observationBinding === 'unbound' ? 'unbound' : sortedReasons.length > 0 ? 'partial' : 'complete'
  const completeness: LocalSyncBaselineCompleteness = { state, reasons: sortedReasons }

  const entityCounts = {
    topic: entities.filter((entity) => entity.entityType === 'topic').length,
    message: entities.filter((entity) => entity.entityType === 'message').length,
    message_block: entities.filter((entity) => entity.entityType === 'message_block').length,
    total: entities.length
  }

  const frameCounts = {
    topicMessage: sortedFrames.filter((f) => f.kind === 'topicMessage').length,
    messageBlock: sortedFrames.filter((f) => f.kind === 'messageBlock').length
  }

  const manifestWithoutDigest = {
    schemaVersion: LOCAL_SYNC_BASELINE_SCHEMA_VERSION,
    inventoryVersion: LOCAL_SYNC_BASELINE_INVENTORY_VERSION,
    orderFrameVersion: LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION,
    scope: LOCAL_SYNC_BASELINE_SCOPE,
    entityCounts,
    tombstoneCount: tombstones.length,
    unversionedEntityCount,
    unversionedFieldCount,
    unversionedMembershipCount,
    excludedTransientMessages,
    excludedTransientBlocks,
    excludedUnsupportedBlocks,
    orphanSuppressedChildren: orphanSuppressed,
    aggregateIncompleteParents,
    frameCounts,
    missingOrderFrameCount,
    incompleteOrderFrameCount,
    pendingOutboxCount,
    observationBinding,
    completenessState: state,
    completenessReasons: sortedReasons
  }
  const unsigned = {
    kind: LOCAL_SYNC_BASELINE_KIND,
    schemaVersion: LOCAL_SYNC_BASELINE_SCHEMA_VERSION,
    inventoryVersion: LOCAL_SYNC_BASELINE_INVENTORY_VERSION,
    orderFrameVersion: LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION,
    entities,
    tombstones,
    orderFrames: sortedFrames,
    replacementRegisters,
    fileAssets,
    pendingAttachmentCount,
    observedLocalChannelKey,
    observedLocalCursor,
    observationBinding,
    pendingOutboxCount,
    completeness,
    manifest: manifestWithoutDigest
  }
  const digest = sha256HexUtf8(canonicalizeSyncJson(unsigned))
  return { ...unsigned, manifest: { ...manifestWithoutDigest, digest } }
}
