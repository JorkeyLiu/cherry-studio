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
  filterBlockPayload,
  filterMessagePayload,
  filterTopicPayload,
  isStableBlockStatus,
  isStableMessageStatus,
  isUnsupportedBlockForSync,
  SYNC_BLOCK_PATCH_FIELDS,
  SYNC_MESSAGE_PATCH_FIELDS,
  SYNC_TOPIC_PATCH_FIELDS,
  validateSyncPayloadAllowlist
} from '@shared/sync'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { decodeJson } from '../chatDb/domain/codec'
import * as schema from '../chatDb/schema'
import { parseStrictCursor } from './SyncService'
import { parseSyncChannelKeyValue, parseSyncOperationIdShape, parseSyncTombstoneValue } from './syncTombstoneCodec'

/** Provisional non-wire kind marker for the local baseline candidate. */
export const LOCAL_SYNC_BASELINE_KIND = 'local_sync_baseline_candidate'
/** Provisional non-wire schema version of the candidate envelope. */
export const LOCAL_SYNC_BASELINE_SCHEMA_VERSION = 'local-sync-baseline-v1'
/** Version of the provisional syncable-data inventory covered here. */
export const LOCAL_SYNC_BASELINE_INVENTORY_VERSION = 'topic-message-stable-block-v1'
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

export interface LocalSyncBaselineEntity {
  entityType: 'topic' | 'message' | 'message_block'
  entityId: string
  /** Full allowlisted current state for the emitted entity. */
  payload: Record<string, unknown>
  /** Representable entity clock; null when the entity is unversioned. */
  entityClock: LocalSyncBaselineEntityClock | null
  /** Only fields admitted by the exact allowlist for this entity, sorted by field. */
  fieldClocks: LocalSyncBaselineFieldClock[]
}

export interface LocalSyncBaselineTombstone {
  entityType: 'topic' | 'message' | 'message_block'
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

export interface LocalSyncBaselineManifest {
  schemaVersion: string
  inventoryVersion: string
  scope: string
  entityCounts: { topic: number; message: number; message_block: number; total: number }
  tombstoneCount: number
  unversionedEntityCount: number
  unversionedFieldCount: number
  excludedTransientMessages: number
  excludedTransientBlocks: number
  excludedUnsupportedBlocks: number
  orphanSuppressedChildren: number
  aggregateIncompleteParents: number
  pendingOutboxCount: number
  observationBinding: 'bound' | 'unbound'
  completenessState: LocalSyncBaselineCompletenessState
  completenessReasons: string[]
  /** SHA-256 hex digest over the canonical candidate content excluding this value. */
  digest: string
}

export interface LocalSyncBaselineCandidate {
  kind: string
  schemaVersion: string
  inventoryVersion: string
  /** Deterministic order: topic, message, message_block, then lexical entity ID. */
  entities: LocalSyncBaselineEntity[]
  /** Deterministic order: topic, message, message_block, then lexical entity ID. */
  tombstones: LocalSyncBaselineTombstone[]
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
const CURSOR_STATE_KEY = 'cursor'
const CHANNEL_STATE_KEY = 'sync:channelKey'

const ENTITY_TYPE_PRIORITY: Record<LocalSyncBaselineEntity['entityType'], number> = {
  topic: 0,
  message: 1,
  message_block: 2
}

// Field-clock allowlists mirror the SyncService clocked sets exactly:
// identity/immutable relation fields are never clocked; sortOrder is clocked
// for messages/blocks (old-full-payload convergence) but never for topics.
const FIELD_CLOCK_ALLOW: Record<LocalSyncBaselineEntity['entityType'], ReadonlySet<string>> = {
  topic: new Set<string>(SYNC_TOPIC_PATCH_FIELDS as readonly string[]),
  message: new Set<string>([...(SYNC_MESSAGE_PATCH_FIELDS as readonly string[]), 'sortOrder']),
  message_block: new Set<string>([...(SYNC_BLOCK_PATCH_FIELDS as readonly string[]), 'sortOrder'])
}

/**
 * Shared field-clock allowlist for baseline capture and bounded apply.
 * Identity/immutable relation fields are never clocked.
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
    entities: candidate.entities,
    tombstones: candidate.tombstones,
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
  // Canonical operation-ID shape (non-empty, colon-free, at most 256 chars)
  // enforced fail-closed: malformed version metadata is never downgraded to
  // partial and never serialized. Context carries only entity type/id.
  let operationId: string
  try {
    operationId = parseSyncOperationIdShape(row.operationId)
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
  const filtered = filterTopicPayload(raw)
  if (!filtered) fail(`baseline topic payload filter rejected entity ${data.id}`)
  const allowErr = validateSyncPayloadAllowlist({ entityType: 'topic', payload: filtered })
  if (allowErr) fail(`baseline topic payload not allowlisted for ${data.id}: ${allowErr}`)
  return filtered
}

function buildMessagePayload(data: {
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
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
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
  const filtered = filterMessagePayload(raw)
  if (!filtered) fail(`baseline message payload filter rejected entity ${data.id}`)
  const allowErr = validateSyncPayloadAllowlist({ entityType: 'message', payload: filtered })
  if (allowErr) fail(`baseline message payload not allowlisted for ${data.id}: ${allowErr}`)
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
  sortOrder: number
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id: data.id,
    messageId: data.messageId,
    type: data.type,
    content: data.content,
    status: data.status,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    sortOrder: data.sortOrder
  }
  const filtered = filterBlockPayload(raw)
  if (!filtered) fail(`baseline block payload filter rejected entity ${data.id}`)
  const allowErr = validateSyncPayloadAllowlist({ entityType: 'message_block', payload: filtered })
  if (allowErr) fail(`baseline block payload not allowlisted for ${data.id}: ${allowErr}`)
  return filtered
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

function buildBaselineCandidate(tx: BaselineTx): LocalSyncBaselineCandidate {
  // Materialize every input inside the single read transaction.
  const topicRows = tx.select().from(schema.topics).all()
  const messageRows = tx.select().from(schema.messages).all()
  const blockRows = tx.select().from(schema.messageBlocks).all()
  const syncStateRows = tx.select().from(schema.syncState).all()
  const entityClockRows = tx.select().from(schema.syncEntityClock).all()
  const fieldClockRows = tx.select().from(schema.syncFieldClock).all()
  const pendingOutboxCount = tx.select({ id: schema.syncOutbox.id }).from(schema.syncOutbox).all().length

  const entityClockByKey = new Map<string, LocalSyncBaselineEntityClock>()
  for (const row of entityClockRows) {
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
    const allow = (FIELD_CLOCK_ALLOW as Record<string, ReadonlySet<string>>)[row.entityType]
    if (!allow || !allow.has(row.field)) continue
    if (typeof row.timestamp !== 'number' || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0) {
      fail(`baseline malformed field clock timestamp for ${row.entityType}/${row.entityId}/${row.field}`)
    }
    try {
      parseSyncOperationIdShape(row.operationId)
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

  // Topics: full current state (soft-deleted rows stay; hard-deleted rows are
  // gone and covered by tombstones below).
  const entities: LocalSyncBaselineEntity[] = []
  const emittedTopicIds = new Set<string>()
  for (const row of topicRows) {
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
  // was not emitted (no placeholders).
  let excludedTransientMessages = 0
  let orphanSuppressed = 0
  const emittedMessageIds = new Set<string>()
  const nonEmittedMessageByTopic = new Map<string, number>()
  const registerNonEmittedMessage = (topicId: string): void => {
    nonEmittedMessageByTopic.set(topicId, (nonEmittedMessageByTopic.get(topicId) ?? 0) + 1)
  }
  for (const row of messageRows) {
    const overflow = decodeOverflow(row.extra, 'messages', row.id)
    void overflow
    if (!isStableMessageStatus(row.status)) {
      excludedTransientMessages += 1
      registerNonEmittedMessage(row.topicId)
      continue
    }
    if (!emittedTopicIds.has(row.topicId)) {
      orphanSuppressed += 1
      registerNonEmittedMessage(row.topicId)
      continue
    }
    const payload = buildMessagePayload({
      id: row.id,
      topicId: row.topicId,
      role: row.role,
      content: row.content,
      status: row.status,
      askId: row.askId,
      model: row.model,
      modelId: row.modelId,
      assistantId: row.assistantId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sortOrder: row.sortOrder
    })
    const key = `message:${row.id}`
    entities.push({
      entityType: 'message',
      entityId: row.id,
      payload,
      entityClock: entityClockByKey.get(key) ?? null,
      fieldClocks: (fieldClocksByKey.get(key) ?? []).slice().sort((a, b) => compareLexical(a.field, b.field))
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
  for (const row of blockRows) {
    const overflow = decodeOverflow(row.extra, 'message_blocks', row.id)
    if (!isStableBlockStatus(row.status)) {
      excludedTransientBlocks += 1
      registerNonEmittedBlock(row.messageId)
      continue
    }
    if (isUnsupportedBlockForSync({ type: row.type, overflow })) {
      excludedUnsupportedBlocks += 1
      registerNonEmittedBlock(row.messageId)
      continue
    }
    if (!emittedMessageIds.has(row.messageId)) {
      orphanSuppressed += 1
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
      sortOrder: row.sortOrder
    })
    const key = `message_block:${row.id}`
    entities.push({
      entityType: 'message_block',
      entityId: row.id,
      payload,
      entityClock: entityClockByKey.get(key) ?? null,
      fieldClocks: (fieldClocksByKey.get(key) ?? []).slice().sort((a, b) => compareLexical(a.field, b.field))
    })
  }

  entities.sort((a, b) => {
    const priority = ENTITY_TYPE_PRIORITY[a.entityType] - ENTITY_TYPE_PRIORITY[b.entityType]
    if (priority !== 0) return priority
    return compareLexical(a.entityId, b.entityId)
  })

  // Tombstones: only valid known tombstone:<entityType>:<entityId> records.
  // Malformed known tombstones fail closed. Live entities and tombstones are
  // included independently; absence is never interpreted as deletion.
  const tombstones: LocalSyncBaselineTombstone[] = []
  for (const row of syncStateRows) {
    const key = row.key
    if (!key.startsWith('tombstone:')) continue
    let entityType: LocalSyncBaselineEntity['entityType'] | null = null
    let entityId = ''
    if (key.startsWith(TOMBSTONE_TOPIC_PREFIX)) {
      entityType = 'topic'
      entityId = key.slice(TOMBSTONE_TOPIC_PREFIX.length)
    } else if (key.startsWith(TOMBSTONE_BLOCK_PREFIX)) {
      entityType = 'message_block'
      entityId = key.slice(TOMBSTONE_BLOCK_PREFIX.length)
    } else if (key.startsWith(TOMBSTONE_MESSAGE_PREFIX)) {
      entityType = 'message'
      entityId = key.slice(TOMBSTONE_MESSAGE_PREFIX.length)
    } else {
      fail(`baseline malformed tombstone key ${JSON.stringify(key).slice(0, 80)}`)
    }
    if (!entityType || entityId.length === 0) {
      fail(`baseline malformed tombstone key ${JSON.stringify(key).slice(0, 80)}`)
    }
    if (row.value === null || row.value === undefined) {
      fail(`baseline malformed tombstone value for ${entityType}/${entityId}: missing`)
    }
    let parsed: { timestamp: number; operationId: string | null }
    try {
      const result = parseSyncTombstoneValue(row.value)
      if (!result) fail(`baseline malformed tombstone value for ${entityType}/${entityId}: missing`)
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

  // Provisional local watermark observation: current channel key and strict
  // cursor observed only. Either absent means unbound (never a SYNC-DATA-007
  // no-gap watermark claim). Present-but-malformed state fails closed.
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

  // Completeness: symbolic, deterministic, sorted reasons.
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
  if (unversionedEntityCount > 0) reasons.add('unversioned-entity')
  // Sufficient per-field version metadata: every clocked payload field must
  // carry a field clock, and every field clock must correspond to a present
  // payload field. A `complete` candidate must be fully versioned at
  // both entity and field granularity so bounded apply never infers causality
  // from row `updatedAt` or capture time. Extra clocks for absent fields also
  // mark partial so `complete` implies exact apply acceptance.
  let unversionedFieldCount = 0
  for (const entity of entities) {
    const allow = FIELD_CLOCK_ALLOW[entity.entityType]
    const present = new Set(entity.fieldClocks.map((entry) => entry.field))
    for (const key of Object.keys(entity.payload)) {
      if (allow.has(key) && !present.has(key)) unversionedFieldCount += 1
    }
    for (const field of present) {
      if (!Object.prototype.hasOwnProperty.call(entity.payload, field)) unversionedFieldCount += 1
    }
  }
  if (unversionedFieldCount > 0) reasons.add('unversioned-field')
  if (pendingOutboxCount > 0) reasons.add('pending-outbox')
  // An emitted aggregate with any non-emitted child row is incomplete.
  let aggregateIncompleteParents = 0
  for (const entity of entities) {
    if (entity.entityType === 'topic' && (nonEmittedMessageByTopic.get(entity.entityId) ?? 0) > 0) {
      aggregateIncompleteParents += 1
    }
    if (entity.entityType === 'message' && (nonEmittedBlockByMessage.get(entity.entityId) ?? 0) > 0) {
      aggregateIncompleteParents += 1
    }
  }
  if (aggregateIncompleteParents > 0) reasons.add('aggregate-incomplete-child-excluded')
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

  const manifestWithoutDigest = {
    schemaVersion: LOCAL_SYNC_BASELINE_SCHEMA_VERSION,
    inventoryVersion: LOCAL_SYNC_BASELINE_INVENTORY_VERSION,
    scope: LOCAL_SYNC_BASELINE_SCOPE,
    entityCounts,
    tombstoneCount: tombstones.length,
    unversionedEntityCount,
    unversionedFieldCount,
    excludedTransientMessages,
    excludedTransientBlocks,
    excludedUnsupportedBlocks,
    orphanSuppressedChildren: orphanSuppressed,
    aggregateIncompleteParents,
    pendingOutboxCount,
    observationBinding,
    completenessState: state,
    completenessReasons: sortedReasons
  }
  const unsigned = {
    kind: LOCAL_SYNC_BASELINE_KIND,
    schemaVersion: LOCAL_SYNC_BASELINE_SCHEMA_VERSION,
    inventoryVersion: LOCAL_SYNC_BASELINE_INVENTORY_VERSION,
    entities,
    tombstones,
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
