/**
 * Bounded Main-only local baseline merge/apply engine.
 *
 * Internal only: transactionally unions a validated, fully versioned,
 * internally complete `LocalSyncBaselineCandidate` (see `syncBaseline.ts`)
 * into another Main SQLite chat authority using current
 * timestamp-then-operationId/entity+field clock semantics.
 *
 * Stricter than ordinary operation replay for legacy unversioned collisions:
 * field comparisons use field clocks only (no entity-clock fallback). A
 * differing field without a local field clock fails closed even when a local
 * entity clock exists; equal values may install the incoming field clock as
 * metadata repair. Tombstones targeting live unversioned rows (direct or via
 * cascade) fail closed regardless of strength. Entity clocks still govern
 * entity/tombstone existence comparisons.
 *
 * Non-goals (never in this module): transport, relay, IPC/preload/shared
 * wire, renderer/UI, pairing, cursor/channel mutation, outbox
 * acknowledgement, migrations, conflict-log writes, `sync_applied` writes.
 * Only chat rows, entity/field clocks, and tombstone keys may be written,
 * inside one synchronous SQLite transaction. Absence never deletes; only
 * explicit incoming tombstones can delete. Deletes use direct SQL with the
 * authoritative FK cascade boundary (topic→messages→blocks→file_refs,
 * topic→segments/memberships, message→memberships) plus empty-segment cleanup
 * for message deletes, without sync capture/outbox. No placeholders.
 */

import {
  isStableBlockStatus,
  isStableMessageStatus,
  isUnsupportedBlockForSync,
  validateSyncOperationStrict,
  validateSyncPayloadAllowlist
} from '@shared/sync'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { decodeJson, encodeJson } from '../chatDb/domain/codec'
import * as schema from '../chatDb/schema'
import {
  BASELINE_FIELD_CLOCK_ALLOW,
  computeLocalSyncBaselineDigest,
  LOCAL_SYNC_BASELINE_INVENTORY_VERSION,
  LOCAL_SYNC_BASELINE_KIND,
  LOCAL_SYNC_BASELINE_SCHEMA_VERSION,
  LOCAL_SYNC_BASELINE_SCOPE,
  type LocalSyncBaselineCandidate,
  type LocalSyncBaselineEntity,
  type LocalSyncBaselineTombstone
} from './syncBaseline'
import { parseStrictCursor } from './SyncService'
import {
  formatSyncTombstoneValue,
  parseSyncChannelKeyValue,
  parseSyncOperationIdShape,
  parseSyncTombstoneValue
} from './syncTombstoneCodec'

export class SyncBaselineApplyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncBaselineApplyError'
  }
}

/** Bounded non-sensitive counts/status only. No payload/content/IDs. */
export interface LocalSyncBaselineApplyResult {
  inserted: number
  updated: number
  deleted: number
  suppressed: number
  unchanged: number
}

type BaselineTx = BetterSQLite3Database<typeof schema>
type EntityType = LocalSyncBaselineEntity['entityType']

const ENTITY_PRIORITY: Record<EntityType, number> = { topic: 0, message: 1, message_block: 2 }
const UNSUPPORTED_BLOCK_TYPES: ReadonlySet<string> = new Set(['tool', 'file', 'image', 'video', 'citation'])
const TOMBSTONE_PREFIX: Record<EntityType, string> = {
  topic: 'tombstone:topic:',
  message: 'tombstone:message:',
  message_block: 'tombstone:message_block:'
}

/**
 * Canonical full baseline payload requirements, distinct from patch/upsert
 * validation. Aligned exactly with `captureLocalSyncBaselineCandidate` emit
 * and insertion/update persistence:
 * - topic: 6 required + 3 explicitly optional overflow fields. Absent
 *   optional means canonical null / no overflow entry (never a placeholder).
 * - message: 12 required, always materialized (null allowed except ids/sortOrder).
 * - block: 8 required, always materialized.
 * Required fields must not be removable from a recomputed-digest `complete`
 * candidate. Insert mapping never invents defaults for absent required fields.
 */
const BASELINE_TOPIC_REQUIRED = ['id', 'name', 'assistantId', 'createdAt', 'updatedAt', 'deletedAt'] as const
const BASELINE_TOPIC_OPTIONAL = ['pinned', 'prompt', 'isNameManuallyEdited'] as const
const BASELINE_MESSAGE_REQUIRED = [
  'id',
  'topicId',
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt',
  'sortOrder'
] as const
const BASELINE_BLOCK_REQUIRED = [
  'id',
  'messageId',
  'type',
  'content',
  'status',
  'createdAt',
  'updatedAt',
  'sortOrder'
] as const

function fail(message: string, cause?: unknown): never {
  throw new SyncBaselineApplyError(message, cause === undefined ? undefined : { cause })
}

function compareLexical(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function compareLww(aTs: number, aId: string, bTs: number, bId: string): number {
  if (aTs !== bTs) return aTs < bTs ? -1 : 1
  if (aId === bId) return 0
  return aId < bId ? -1 : 1
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function requireOperationId(value: unknown, context: string): string {
  try {
    return parseSyncOperationIdShape(value)
  } catch (e) {
    fail(`baseline apply malformed operationId for ${context}: ${e instanceof Error ? e.message : String(e)}`, e)
  }
}

function isSuppressedByTombstone(opTs: number, opId: string, tombTs: number, tombOpId: string | null): boolean {
  if (tombOpId === null) return opTs <= tombTs
  if (opTs !== tombTs) return opTs < tombTs
  return opId <= tombOpId
}

function fieldValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  } catch {
    return false
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isBooleanOrNull(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * Full baseline payload shape, distinct from patch/upsert rules. Requires
 * exact canonical presence (no removable required fields), rejects unexpected
 * fields, and enforces nullability/type shapes. Optional topic overflow
 * fields are explicitly optional: absent means canonical null / no overflow
 * entry; present must be correctly typed.
 */
function validateBaselineFullPayload(entityType: EntityType, entityId: string, payload: Record<string, unknown>): void {
  const keys = Object.keys(payload)
  if (entityType === 'topic') {
    const allowed = new Set<string>([...BASELINE_TOPIC_REQUIRED, ...BASELINE_TOPIC_OPTIONAL])
    for (const k of keys) {
      if (!allowed.has(k)) fail(`baseline apply unexpected topic field for ${entityId}: ${k}`)
      if (payload[k] === undefined) fail(`baseline apply undefined topic field for ${entityId}: ${k}`)
    }
    for (const k of BASELINE_TOPIC_REQUIRED) {
      if (!Object.prototype.hasOwnProperty.call(payload, k) || payload[k] === undefined) {
        fail(`baseline apply missing required topic field for ${entityId}: ${k}`)
      }
    }
    if (!isNonEmptyString(payload.id)) fail(`baseline apply invalid topic id for ${entityId}`)
    if (!isStringOrNull(payload.name)) fail(`baseline apply invalid topic name for ${entityId}`)
    if (!isStringOrNull(payload.assistantId)) fail(`baseline apply invalid topic assistantId for ${entityId}`)
    if (!isStringOrNull(payload.createdAt)) fail(`baseline apply invalid topic createdAt for ${entityId}`)
    if (!isStringOrNull(payload.updatedAt)) fail(`baseline apply invalid topic updatedAt for ${entityId}`)
    if (!isStringOrNull(payload.deletedAt)) fail(`baseline apply invalid topic deletedAt for ${entityId}`)
    if (Object.prototype.hasOwnProperty.call(payload, 'pinned') && payload.pinned !== undefined) {
      if (!isBooleanOrNull(payload.pinned)) fail(`baseline apply invalid topic pinned for ${entityId}`)
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'prompt') && payload.prompt !== undefined) {
      if (!isStringOrNull(payload.prompt)) fail(`baseline apply invalid topic prompt for ${entityId}`)
    }
    if (
      Object.prototype.hasOwnProperty.call(payload, 'isNameManuallyEdited') &&
      payload.isNameManuallyEdited !== undefined
    ) {
      if (!isBooleanOrNull(payload.isNameManuallyEdited)) {
        fail(`baseline apply invalid topic isNameManuallyEdited for ${entityId}`)
      }
    }
    return
  }
  if (entityType === 'message') {
    const required = new Set<string>(BASELINE_MESSAGE_REQUIRED)
    if (keys.length !== required.size) {
      fail(`baseline apply message field count mismatch for ${entityId}: expected ${required.size}, got ${keys.length}`)
    }
    for (const k of keys) {
      if (!required.has(k)) fail(`baseline apply unexpected message field for ${entityId}: ${k}`)
      if (payload[k] === undefined) fail(`baseline apply undefined message field for ${entityId}: ${k}`)
    }
    for (const k of BASELINE_MESSAGE_REQUIRED) {
      if (!Object.prototype.hasOwnProperty.call(payload, k)) {
        fail(`baseline apply missing required message field for ${entityId}: ${k}`)
      }
    }
    if (!isNonEmptyString(payload.id)) fail(`baseline apply invalid message id for ${entityId}`)
    if (!isNonEmptyString(payload.topicId)) fail(`baseline apply invalid message topicId for ${entityId}`)
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
      if (!isStringOrNull(payload[k])) fail(`baseline apply invalid message ${k} for ${entityId}`)
    }
    if (!isSafeInteger(payload.sortOrder)) fail(`baseline apply invalid message sortOrder for ${entityId}`)
    return
  }
  const required = new Set<string>(BASELINE_BLOCK_REQUIRED)
  if (keys.length !== required.size) {
    fail(`baseline apply block field count mismatch for ${entityId}: expected ${required.size}, got ${keys.length}`)
  }
  for (const k of keys) {
    if (!required.has(k)) fail(`baseline apply unexpected block field for ${entityId}: ${k}`)
    if (payload[k] === undefined) fail(`baseline apply undefined block field for ${entityId}: ${k}`)
  }
  for (const k of BASELINE_BLOCK_REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(payload, k)) {
      fail(`baseline apply missing required block field for ${entityId}: ${k}`)
    }
  }
  if (!isNonEmptyString(payload.id)) fail(`baseline apply invalid block id for ${entityId}`)
  if (!isNonEmptyString(payload.messageId)) fail(`baseline apply invalid block messageId for ${entityId}`)
  for (const k of ['type', 'content', 'status', 'createdAt', 'updatedAt'] as const) {
    if (!isStringOrNull(payload[k])) fail(`baseline apply invalid block ${k} for ${entityId}`)
  }
  if (!isSafeInteger(payload.sortOrder)) fail(`baseline apply invalid block sortOrder for ${entityId}`)
}

function tombstoneKey(entityType: EntityType, entityId: string): string {
  return `${TOMBSTONE_PREFIX[entityType]}${entityId}`
}

// ---------------------------------------------------------------------------
// Pure candidate validation (no DB writes).
// ---------------------------------------------------------------------------

function validatePureCandidate(candidate: LocalSyncBaselineCandidate): void {
  if (!candidate || typeof candidate !== 'object') fail('baseline apply malformed candidate: not an object')
  if (candidate.kind !== LOCAL_SYNC_BASELINE_KIND) fail('baseline apply kind mismatch')
  if (candidate.schemaVersion !== LOCAL_SYNC_BASELINE_SCHEMA_VERSION) fail('baseline apply schema version mismatch')
  if (candidate.inventoryVersion !== LOCAL_SYNC_BASELINE_INVENTORY_VERSION) {
    fail('baseline apply inventory version mismatch')
  }
  const manifest = candidate.manifest as LocalSyncBaselineCandidate['manifest'] | undefined
  if (!manifest || typeof manifest !== 'object') fail('baseline apply malformed manifest')
  if (manifest.schemaVersion !== LOCAL_SYNC_BASELINE_SCHEMA_VERSION) fail('baseline apply manifest schema mismatch')
  if (manifest.inventoryVersion !== LOCAL_SYNC_BASELINE_INVENTORY_VERSION) {
    fail('baseline apply manifest inventory mismatch')
  }
  if (manifest.scope !== LOCAL_SYNC_BASELINE_SCOPE) fail('baseline apply scope mismatch')
  if (typeof manifest.digest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.digest)) {
    fail('baseline apply malformed digest')
  }
  let recomputed: string
  try {
    recomputed = computeLocalSyncBaselineDigest(candidate)
  } catch (e) {
    fail(`baseline apply digest recompute failed: ${e instanceof Error ? e.message : String(e)}`, e)
  }
  if (recomputed !== manifest.digest) fail('baseline apply digest mismatch (tampered candidate)')

  // Bounded safe path only.
  if (!candidate.completeness || candidate.completeness.state !== 'complete') {
    fail('baseline apply requires complete candidate')
  }
  if (candidate.completeness.reasons.length !== 0) fail('baseline apply requires empty completeness reasons')
  if (candidate.pendingOutboxCount !== 0) fail('baseline apply requires zero pending outbox')
  if (candidate.observationBinding !== 'bound') fail('baseline apply requires bound observation')
  if (candidate.observedLocalChannelKey === null || candidate.observedLocalCursor === null) {
    fail('baseline apply requires bound observed channel+cursor')
  }
  try {
    parseSyncChannelKeyValue(candidate.observedLocalChannelKey)
  } catch (e) {
    fail(`baseline apply malformed observed channel: ${e instanceof Error ? e.message : String(e)}`, e)
  }
  try {
    const cursor =
      typeof candidate.observedLocalCursor === 'number'
        ? parseStrictCursor(candidate.observedLocalCursor)
        : parseStrictCursor(String(candidate.observedLocalCursor))
    void cursor
  } catch (e) {
    fail(`baseline apply malformed observed cursor: ${e instanceof Error ? e.message : String(e)}`, e)
  }
  if (manifest.observationBinding !== 'bound') fail('baseline apply manifest must be bound')
  if (manifest.completenessState !== 'complete') fail('baseline apply manifest must be complete')
  if (manifest.completenessReasons.length !== 0) fail('baseline apply manifest must have empty reasons')
  if (manifest.pendingOutboxCount !== 0) fail('baseline apply manifest must have zero pending outbox')
  if (manifest.unversionedEntityCount !== 0) fail('baseline apply manifest must have zero unversioned entities')
  const unversionedFieldCount = (manifest as { unversionedFieldCount?: unknown }).unversionedFieldCount
  if (unversionedFieldCount !== 0) fail('baseline apply manifest must have zero unversioned fields')
  if (manifest.excludedTransientMessages !== 0) fail('baseline apply manifest must exclude no transient messages')
  if (manifest.excludedTransientBlocks !== 0) fail('baseline apply manifest must exclude no transient blocks')
  if (manifest.excludedUnsupportedBlocks !== 0) fail('baseline apply manifest must exclude no unsupported blocks')
  if (manifest.orphanSuppressedChildren !== 0) fail('baseline apply manifest must suppress no orphans')
  if (manifest.aggregateIncompleteParents !== 0) fail('baseline apply manifest must have no incomplete parents')
  if (!Array.isArray(candidate.entities) || !Array.isArray(candidate.tombstones)) {
    fail('baseline apply malformed entities/tombstones')
  }
  if (manifest.tombstoneCount !== candidate.tombstones.length) fail('baseline apply tombstone count mismatch')
  if (manifest.entityCounts.total !== candidate.entities.length) fail('baseline apply entity count mismatch')
  if (
    manifest.entityCounts.topic !== candidate.entities.filter((e) => e.entityType === 'topic').length ||
    manifest.entityCounts.message !== candidate.entities.filter((e) => e.entityType === 'message').length ||
    manifest.entityCounts.message_block !== candidate.entities.filter((e) => e.entityType === 'message_block').length
  ) {
    fail('baseline apply per-type entity count mismatch')
  }

  // Entity/tombstone structural validation.
  const entityKeys = new Set<string>()
  const topicIds = new Set<string>()
  const messageIds = new Set<string>()
  let lastId = ''
  let lastType: EntityType | null = null
  for (const entity of candidate.entities) {
    if (!entity || typeof entity !== 'object') fail('baseline apply malformed entity')
    if (entity.entityType !== 'topic' && entity.entityType !== 'message' && entity.entityType !== 'message_block') {
      fail(`baseline apply unknown entityType ${String((entity as { entityType?: unknown }).entityType)}`)
    }
    if (typeof entity.entityId !== 'string' || entity.entityId.length === 0) {
      fail('baseline apply malformed entityId')
    }
    const key = `${entity.entityType}:${entity.entityId}`
    if (entityKeys.has(key)) fail(`baseline apply duplicate entity ${entity.entityType}/${entity.entityId}`)
    entityKeys.add(key)
    // Deterministic order: topic, message, block, then lexical id.
    const priority = ENTITY_PRIORITY[entity.entityType]
    if (lastType !== null) {
      const prevPriority = ENTITY_PRIORITY[lastType]
      if (priority < prevPriority || (priority === prevPriority && compareLexical(entity.entityId, lastId) <= 0)) {
        fail('baseline apply entities out of order')
      }
    }
    lastType = entity.entityType
    lastId = entity.entityId
    if (entity.entityType === 'topic') topicIds.add(entity.entityId)
    if (entity.entityType === 'message') messageIds.add(entity.entityId)

    if (!entity.payload || typeof entity.payload !== 'object' || Array.isArray(entity.payload)) {
      fail(`baseline apply malformed payload for ${entity.entityType}/${entity.entityId}`)
    }
    const payload = entity.payload
    if (payload.id !== entity.entityId) fail(`baseline apply payload id mismatch for ${entity.entityId}`)
    const allowErr = validateSyncPayloadAllowlist({ entityType: entity.entityType, payload })
    if (allowErr) fail(`baseline apply payload not allowlisted for ${entity.entityId}: ${allowErr}`)
    validateBaselineFullPayload(entity.entityType, entity.entityId, payload)
    if (entity.entityType === 'message') {
      if (typeof payload.topicId !== 'string' || payload.topicId.length === 0) {
        fail(`baseline apply message missing topicId for ${entity.entityId}`)
      }
      if (!isStableMessageStatus(payload.status)) fail(`baseline apply transient message for ${entity.entityId}`)
    }
    if (entity.entityType === 'message_block') {
      if (typeof payload.messageId !== 'string' || payload.messageId.length === 0) {
        fail(`baseline apply block missing messageId for ${entity.entityId}`)
      }
      if (!isStableBlockStatus(payload.status)) fail(`baseline apply transient block for ${entity.entityId}`)
      const blockType = typeof payload.type === 'string' ? payload.type.toLowerCase() : ''
      if (UNSUPPORTED_BLOCK_TYPES.has(blockType)) {
        fail(`baseline apply unsupported block type for ${entity.entityId}`)
      }
      // Overflow-carried structured content cannot be represented in the
      // allowlisted payload; a text-typed shell with such overflow would have
      // been excluded at capture, so a complete candidate must not carry it.
      // Observable here only via type gate above; content-shape depth stays
      // with capture exclusion + completeness.
      if (isUnsupportedBlockForSync({ type: typeof payload.type === 'string' ? payload.type : null })) {
        fail(`baseline apply unsupported block for ${entity.entityId}`)
      }
    }
    // Type-shape depth: strict operation shape for allowlisted fields.
    if (!entity.entityClock || typeof entity.entityClock !== 'object') {
      fail(`baseline apply missing entity clock for ${entity.entityId}`)
    }
    if (!isValidTimestamp(entity.entityClock.timestamp)) {
      fail(`baseline apply malformed entity clock timestamp for ${entity.entityId}`)
    }
    requireOperationId(entity.entityClock.operationId, `${entity.entityType}/${entity.entityId}`)
    const strictErr = validateSyncOperationStrict({
      id: entity.entityClock.operationId,
      entityType: entity.entityType,
      op: 'upsert',
      entityId: entity.entityId,
      timestamp: entity.entityClock.timestamp,
      deviceId: 'local-baseline-apply',
      payload
    })
    if (strictErr) fail(`baseline apply payload shape rejected for ${entity.entityId}: ${strictErr}`)

    if (!Array.isArray(entity.fieldClocks)) fail(`baseline apply malformed fieldClocks for ${entity.entityId}`)
    const fieldSeen = new Set<string>()
    let lastField = ''
    const allow = BASELINE_FIELD_CLOCK_ALLOW[entity.entityType]
    for (const fc of entity.fieldClocks) {
      if (!fc || typeof fc.field !== 'string') fail(`baseline apply malformed field clock for ${entity.entityId}`)
      if (!allow.has(fc.field)) fail(`baseline apply field clock not allowlisted for ${entity.entityId}/${fc.field}`)
      if (fieldSeen.has(fc.field)) fail(`baseline apply duplicate field clock for ${entity.entityId}/${fc.field}`)
      fieldSeen.add(fc.field)
      if (lastField !== '' && compareLexical(fc.field, lastField) <= 0) {
        fail(`baseline apply fieldClocks out of order for ${entity.entityId}`)
      }
      lastField = fc.field
      if (!isValidTimestamp(fc.timestamp)) {
        fail(`baseline apply malformed field clock timestamp for ${entity.entityId}/${fc.field}`)
      }
      requireOperationId(fc.operationId, `${entity.entityType}/${entity.entityId}/${fc.field}`)
    }
    // Sufficient incoming version metadata: every clocked payload field must
    // carry a field clock, and every field clock must correspond to a present
    // allowlisted payload field. Never infer from updatedAt/capture time.
    // Identity/relation fields (id/topicId/messageId) are excluded: they are
    // covered by the entity version, not field clocks.
    const presentClocked = new Set<string>()
    for (const k of Object.keys(payload)) {
      if (allow.has(k)) presentClocked.add(k)
    }
    for (const k of presentClocked) {
      if (!fieldSeen.has(k)) {
        fail(`baseline apply missing field clock for ${entity.entityId}/${k}`)
      }
    }
    for (const f of fieldSeen) {
      if (!presentClocked.has(f)) {
        fail(`baseline apply field clock without payload field for ${entity.entityId}/${f}`)
      }
    }
  }

  // Parent closure inside the candidate (no placeholders downstream).
  for (const entity of candidate.entities) {
    if (entity.entityType === 'message') {
      const topicId = entity.payload.topicId as string
      if (!topicIds.has(topicId)) fail(`baseline apply orphan message ${entity.entityId} missing topic ${topicId}`)
    }
    if (entity.entityType === 'message_block') {
      const messageId = entity.payload.messageId as string
      if (!messageIds.has(messageId)) {
        fail(`baseline apply orphan block ${entity.entityId} missing message ${messageId}`)
      }
    }
  }

  // Tombstones.
  const tombKeys = new Set<string>()
  let lastTombId = ''
  let lastTombType: EntityType | null = null
  for (const tomb of candidate.tombstones) {
    if (!tomb || typeof tomb !== 'object') fail('baseline apply malformed tombstone')
    if (tomb.entityType !== 'topic' && tomb.entityType !== 'message' && tomb.entityType !== 'message_block') {
      fail('baseline apply unknown tombstone entityType')
    }
    if (typeof tomb.entityId !== 'string' || tomb.entityId.length === 0) fail('baseline apply malformed tombstone id')
    const key = `${tomb.entityType}:${tomb.entityId}`
    if (tombKeys.has(key)) fail(`baseline apply duplicate tombstone ${key}`)
    tombKeys.add(key)
    const priority = ENTITY_PRIORITY[tomb.entityType]
    if (lastTombType !== null) {
      const prev = ENTITY_PRIORITY[lastTombType]
      if (priority < prev || (priority === prev && compareLexical(tomb.entityId, lastTombId) <= 0)) {
        fail('baseline apply tombstones out of order')
      }
    }
    lastTombType = tomb.entityType
    lastTombId = tomb.entityId
    if (!isValidTimestamp(tomb.timestamp)) fail(`baseline apply malformed tombstone timestamp for ${key}`)
    if (tomb.operationId !== null) requireOperationId(tomb.operationId, `tombstone/${key}`)
    if (tomb.entityClock !== null && tomb.entityClock !== undefined) {
      if (typeof tomb.entityClock !== 'object') fail(`baseline apply malformed tombstone clock for ${key}`)
      if (!isValidTimestamp(tomb.entityClock.timestamp)) {
        fail(`baseline apply malformed tombstone clock timestamp for ${key}`)
      }
      requireOperationId(tomb.entityClock.operationId, `tombstone-clock/${key}`)
    }
    // Tombstone value shape must round-trip through the shared codec.
    try {
      const formatted = formatSyncTombstoneValue(tomb.timestamp, tomb.operationId)
      const parsed = parseSyncTombstoneValue(formatted)
      if (!parsed || parsed.timestamp !== tomb.timestamp || parsed.operationId !== tomb.operationId) {
        fail(`baseline apply tombstone codec mismatch for ${key}`)
      }
    } catch (e) {
      fail(`baseline apply malformed tombstone value for ${key}: ${e instanceof Error ? e.message : String(e)}`, e)
    }
  }
}

// ---------------------------------------------------------------------------
// Local row helpers (tx-bound).
// ---------------------------------------------------------------------------

interface LocalClocks {
  entityClockByKey: Map<string, { timestamp: number; operationId: string }>
  fieldClockByKey: Map<string, Map<string, { timestamp: number; operationId: string }>>
  tombstoneByKey: Map<string, { timestamp: number; operationId: string | null; value: string }>
}

function loadLocalClocks(tx: BaselineTx): LocalClocks {
  const entityClockByKey = new Map<string, { timestamp: number; operationId: string }>()
  for (const row of tx.select().from(schema.syncEntityClock).all()) {
    const key = `${row.entityType}:${row.entityId}`
    if (entityClockByKey.has(key)) continue
    if (!isValidTimestamp(row.timestamp)) {
      fail(`baseline apply malformed local entity clock for ${key}`)
    }
    try {
      parseSyncOperationIdShape(row.operationId)
    } catch (e) {
      fail(`baseline apply malformed local entity clock op for ${key}`, e)
    }
    entityClockByKey.set(key, { timestamp: row.timestamp, operationId: row.operationId })
  }
  const fieldClockByKey = new Map<string, Map<string, { timestamp: number; operationId: string }>>()
  for (const row of tx.select().from(schema.syncFieldClock).all()) {
    const key = `${row.entityType}:${row.entityId}`
    let inner = fieldClockByKey.get(key)
    if (!inner) {
      inner = new Map()
      fieldClockByKey.set(key, inner)
    }
    if (inner.has(row.field)) continue
    if (!isValidTimestamp(row.timestamp)) {
      fail(`baseline apply malformed local field clock for ${key}/${row.field}`)
    }
    try {
      parseSyncOperationIdShape(row.operationId)
    } catch (e) {
      fail(`baseline apply malformed local field clock op for ${key}/${row.field}`, e)
    }
    inner.set(row.field, { timestamp: row.timestamp, operationId: row.operationId })
  }
  const tombstoneByKey = new Map<string, { timestamp: number; operationId: string | null; value: string }>()
  for (const row of tx.select().from(schema.syncState).all()) {
    if (!row.key.startsWith('tombstone:')) continue
    let entityType: EntityType | null = null
    let entityId = ''
    if (row.key.startsWith('tombstone:topic:')) {
      entityType = 'topic'
      entityId = row.key.slice('tombstone:topic:'.length)
    } else if (row.key.startsWith('tombstone:message_block:')) {
      entityType = 'message_block'
      entityId = row.key.slice('tombstone:message_block:'.length)
    } else if (row.key.startsWith('tombstone:message:')) {
      entityType = 'message'
      entityId = row.key.slice('tombstone:message:'.length)
    } else {
      fail(`baseline apply malformed local tombstone key ${JSON.stringify(row.key).slice(0, 80)}`)
    }
    if (!entityType || entityId.length === 0) fail('baseline apply malformed local tombstone key')
    if (row.value === null || row.value === undefined) {
      fail(`baseline apply malformed local tombstone value for ${entityType}/${entityId}: missing`)
    }
    let parsed: { timestamp: number; operationId: string | null }
    try {
      const result = parseSyncTombstoneValue(row.value)
      if (!result) fail(`baseline apply malformed local tombstone for ${entityType}/${entityId}`)
      parsed = result
    } catch (e) {
      fail(
        `baseline apply malformed local tombstone for ${entityType}/${entityId}: ${e instanceof Error ? e.message : String(e)}`,
        e
      )
    }
    const key = `${entityType}:${entityId}`
    if (!tombstoneByKey.has(key)) {
      tombstoneByKey.set(key, { timestamp: parsed.timestamp, operationId: parsed.operationId, value: row.value })
    }
  }
  return { entityClockByKey, fieldClockByKey, tombstoneByKey }
}

function decodeTopicOverflow(extra: string | null, id: string): Record<string, unknown> {
  if (extra === null || extra === undefined || extra === '') return {}
  if (extra === '{}') return {}
  try {
    const parsed = decodeJson<Record<string, unknown>>(extra, { entity: id, table: 'topics', id })
    return parsed ?? {}
  } catch (e) {
    fail(`baseline apply unreadable local topic overflow for ${id}: ${e instanceof Error ? e.message : String(e)}`, e)
  }
}

function topicLocalFieldValue(
  row: typeof schema.topics.$inferSelect,
  overflow: Record<string, unknown>,
  field: string
): unknown {
  if (field === 'name') return row.name ?? null
  if (field === 'assistantId') return row.assistantId ?? null
  if (field === 'createdAt') return row.createdAt ?? null
  if (field === 'updatedAt') return row.updatedAt ?? null
  if (field === 'deletedAt') return row.deletedAt ?? null
  if (Object.prototype.hasOwnProperty.call(overflow, field)) return overflow[field]
  return null
}

function messageLocalFieldValue(row: typeof schema.messages.$inferSelect, field: string): unknown {
  const record = row as unknown as Record<string, unknown>
  if (field === 'sortOrder') return record.sortOrder ?? 0
  return record[field] ?? null
}

function blockLocalFieldValue(row: typeof schema.messageBlocks.$inferSelect, field: string): unknown {
  const record = row as unknown as Record<string, unknown>
  if (field === 'sortOrder') return record.sortOrder ?? 0
  return record[field] ?? null
}

function incomingTombstoneBeatsLocal(
  incomingTs: number,
  incomingOp: string | null,
  localTs: number,
  localOp: string | null
): boolean {
  if (incomingOp === null || localOp === null) {
    // Legacy-conservative: larger timestamp wins; equal keeps existing.
    return incomingTs > localTs
  }
  return compareLww(incomingTs, incomingOp, localTs, localOp) > 0
}

function incomingTombstoneWinsOverLocal(
  incoming: { timestamp: number; operationId: string | null },
  localClock: { timestamp: number; operationId: string } | undefined,
  localTomb: { timestamp: number; operationId: string | null } | undefined
): boolean {
  if (localTomb) {
    if (
      !incomingTombstoneBeatsLocal(incoming.timestamp, incoming.operationId, localTomb.timestamp, localTomb.operationId)
    ) {
      return false
    }
  }
  if (localClock) {
    if (incoming.operationId === null) {
      // Legacy tombstones suppress equal-timestamp entity state conservatively.
      if (!(incoming.timestamp >= localClock.timestamp)) return false
      if (incoming.timestamp === localClock.timestamp) return true
      return incoming.timestamp > localClock.timestamp
    }
    if (compareLww(incoming.timestamp, incoming.operationId, localClock.timestamp, localClock.operationId) <= 0) {
      return false
    }
  }
  return true
}

function upsertEntityClock(
  tx: BaselineTx,
  entityType: EntityType,
  entityId: string,
  timestamp: number,
  operationId: string,
  local: Map<string, { timestamp: number; operationId: string }>
): boolean {
  const key = `${entityType}:${entityId}`
  const existing = local.get(key)
  if (existing && compareLww(timestamp, operationId, existing.timestamp, existing.operationId) <= 0) return false
  tx.insert(schema.syncEntityClock)
    .values({ entityType, entityId, timestamp, operationId })
    .onConflictDoUpdate({
      target: [schema.syncEntityClock.entityType, schema.syncEntityClock.entityId],
      set: { timestamp, operationId }
    })
    .run()
  local.set(key, { timestamp, operationId })
  return true
}

function upsertFieldClock(
  tx: BaselineTx,
  entityType: EntityType,
  entityId: string,
  field: string,
  timestamp: number,
  operationId: string,
  local: Map<string, Map<string, { timestamp: number; operationId: string }>>
): boolean {
  const key = `${entityType}:${entityId}`
  let inner = local.get(key)
  if (!inner) {
    inner = new Map()
    local.set(key, inner)
  }
  const existing = inner.get(field)
  if (existing && compareLww(timestamp, operationId, existing.timestamp, existing.operationId) <= 0) return false
  tx.insert(schema.syncFieldClock)
    .values({ entityType, entityId, field, timestamp, operationId })
    .onConflictDoUpdate({
      target: [schema.syncFieldClock.entityType, schema.syncFieldClock.entityId, schema.syncFieldClock.field],
      set: { timestamp, operationId }
    })
    .run()
  inner.set(field, { timestamp, operationId })
  return true
}

function deleteEmptySegmentsForTopic(tx: BaselineTx, topicId: string): void {
  // Authoritative user-data cleanup boundary without sync capture: remove
  // segments left empty by message deletes. FK cascade already removed
  // memberships for deleted messages; empty segments would otherwise linger.
  // No order renormalization here: segment/message sortOrders stay versioned.
  const segments = tx
    .select({ id: schema.topicSegments.id })
    .from(schema.topicSegments)
    .where(eq(schema.topicSegments.topicId, topicId))
    .all()
  for (const seg of segments) {
    const members = tx
      .select({ messageId: schema.topicSegmentMessages.messageId })
      .from(schema.topicSegmentMessages)
      .where(eq(schema.topicSegmentMessages.segmentId, seg.id))
      .all()
    if (members.length === 0) {
      tx.delete(schema.topicSegments).where(eq(schema.topicSegments.id, seg.id)).run()
    }
  }
}

function requireVersionedLiveForTombstone(
  tx: BaselineTx,
  entityType: EntityType,
  entityId: string,
  entityClockByKey: Map<string, { timestamp: number; operationId: string }>
): void {
  // F2: a live local row without a trustworthy entity clock must never be
  // deleted by an incoming tombstone, regardless of tombstone strength.
  // Existing tombstones without a live row still compare under legacy rules.
  let liveExists = false
  if (entityType === 'topic') {
    liveExists = !!tx.select().from(schema.topics).where(eq(schema.topics.id, entityId)).get()
  } else if (entityType === 'message') {
    liveExists = !!tx.select().from(schema.messages).where(eq(schema.messages.id, entityId)).get()
  } else {
    liveExists = !!tx.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, entityId)).get()
  }
  if (liveExists && !entityClockByKey.get(`${entityType}:${entityId}`)) {
    fail(`baseline apply unversioned_local_collision for tombstone ${entityType}/${entityId}`)
  }
  // Cascade boundary: a winning parent delete must not silently remove
  // unversioned descendants. Fail closed before any write.
  if (entityType === 'topic' && liveExists) {
    const childMessages = tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.topicId, entityId))
      .all()
    for (const m of childMessages) {
      if (!entityClockByKey.get(`message:${m.id}`)) {
        fail(`baseline apply unversioned_local_collision for cascade message/${m.id}`)
      }
      const childBlocks = tx
        .select({ id: schema.messageBlocks.id })
        .from(schema.messageBlocks)
        .where(eq(schema.messageBlocks.messageId, m.id))
        .all()
      for (const b of childBlocks) {
        if (!entityClockByKey.get(`message_block:${b.id}`)) {
          fail(`baseline apply unversioned_local_collision for cascade message_block/${b.id}`)
        }
      }
    }
  }
  if (entityType === 'message' && liveExists) {
    const childBlocks = tx
      .select({ id: schema.messageBlocks.id })
      .from(schema.messageBlocks)
      .where(eq(schema.messageBlocks.messageId, entityId))
      .all()
    for (const b of childBlocks) {
      if (!entityClockByKey.get(`message_block:${b.id}`)) {
        fail(`baseline apply unversioned_local_collision for cascade message_block/${b.id}`)
      }
    }
  }
}

function persistTombstone(
  tx: BaselineTx,
  entityType: EntityType,
  entityId: string,
  timestamp: number,
  operationId: string | null,
  local: Map<string, { timestamp: number; operationId: string | null; value: string }>
): boolean {
  const key = `${entityType}:${entityId}`
  const existing = local.get(key)
  if (existing) {
    if (!incomingTombstoneBeatsLocal(timestamp, operationId, existing.timestamp, existing.operationId)) return false
  }
  const value = formatSyncTombstoneValue(timestamp, operationId)
  tx.insert(schema.syncState)
    .values({ key: tombstoneKey(entityType, entityId), value })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value } })
    .run()
  local.set(key, { timestamp, operationId, value })
  return true
}

// ---------------------------------------------------------------------------
// Public apply.
// ---------------------------------------------------------------------------

/**
 * Transactionally union/merge a validated complete baseline candidate into
 * another Main SQLite chat authority. Fails closed with whole-transaction
 * rollback on any unsafe ambiguity. Never writes `sync_applied`,
 * `sync_outbox`, cursor/channel, or conflict state.
 */
export function applyLocalSyncBaselineCandidate(
  db: BaselineTx,
  candidate: LocalSyncBaselineCandidate
): LocalSyncBaselineApplyResult {
  validatePureCandidate(candidate)

  const incomingEntityByKey = new Map<string, LocalSyncBaselineEntity>()
  for (const entity of candidate.entities) incomingEntityByKey.set(`${entity.entityType}:${entity.entityId}`, entity)
  const incomingTombByKey = new Map<string, LocalSyncBaselineTombstone>()
  for (const tomb of candidate.tombstones) incomingTombByKey.set(`${tomb.entityType}:${tomb.entityId}`, tomb)

  const result: LocalSyncBaselineApplyResult = { inserted: 0, updated: 0, deleted: 0, suppressed: 0, unchanged: 0 }

  db.transaction((tx) => {
    const inner = tx as unknown as BaselineTx
    const { entityClockByKey, fieldClockByKey, tombstoneByKey } = loadLocalClocks(inner)

    // Resolve live+tombstone deterministically by versions (not array order).
    const suppressedLiveKeys = new Set<string>()
    for (const [key, tomb] of incomingTombByKey) {
      const live = incomingEntityByKey.get(key)
      if (!live || !live.entityClock) continue
      const liveTs = live.entityClock.timestamp
      const liveOp = live.entityClock.operationId
      if (isSuppressedByTombstone(liveTs, liveOp, tomb.timestamp, tomb.operationId)) {
        suppressedLiveKeys.add(key)
      }
    }

    // Determine winning incoming tombstones against local state.
    // A tombstone coexisting with a winning live (live beats tombstone by
    // versions) loses deterministically and must not delete.
    const winningTombKeys = new Set<string>()
    for (const [key, tomb] of incomingTombByKey) {
      if (incomingEntityByKey.has(key) && !suppressedLiveKeys.has(key)) continue
      const localClock = entityClockByKey.get(key)
      const localTomb = tombstoneByKey.get(key)
      if (incomingTombstoneWinsOverLocal(tomb, localClock, localTomb)) winningTombKeys.add(key)
    }

    const insertedTopicIds = new Set<string>()
    const insertedMessageIds = new Set<string>()

    // Process live entities in candidate order (already topic→message→block).
    for (const entity of candidate.entities) {
      const key = `${entity.entityType}:${entity.entityId}`
      const payload = entity.payload
      const incomingEntityClock = entity.entityClock
      if (!incomingEntityClock) fail(`baseline apply missing entity clock for ${entity.entityId}`)

      // Live suppressed by its own winning incoming tombstone.
      if (suppressedLiveKeys.has(key)) {
        result.suppressed += 1
        continue
      }

      // Stale descendant suppression via winning parent/exact tombstones and
      // local delete-wins containment (mirrors SyncService parent checks).
      if (entity.entityType === 'message') {
        const topicId = payload.topicId as string
        const parentWinningKey = `topic:${topicId}`
        const parentWinningTomb = incomingTombByKey.get(parentWinningKey)
        const parentWinning = parentWinningKey && winningTombKeys.has(parentWinningKey) ? parentWinningTomb : undefined
        const localParentTomb = tombstoneByKey.get(parentWinningKey)
        const localParentRow = inner.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get()
        if (parentWinning && !localParentRow) {
          // Parent will be/was deleted and is absent: consume the stale child
          // and inherit exact containment (same delete identity, not the
          // child's op) so late blocks stay covered.
          if (parentWinning) {
            persistTombstone(
              inner,
              'message',
              entity.entityId,
              parentWinning.timestamp,
              parentWinning.operationId,
              tombstoneByKey
            )
          }
          result.suppressed += 1
          continue
        }
        if (localParentTomb && !localParentRow) {
          result.suppressed += 1
          continue
        }
        if (localParentRow && localParentTomb) {
          if (
            isSuppressedByTombstone(
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              localParentTomb.timestamp,
              localParentTomb.operationId
            )
          ) {
            persistTombstone(
              inner,
              'message',
              entity.entityId,
              localParentTomb.timestamp,
              localParentTomb.operationId,
              tombstoneByKey
            )
            result.suppressed += 1
            continue
          }
        }
        if (parentWinning && localParentRow) {
          if (
            isSuppressedByTombstone(
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              parentWinning.timestamp,
              parentWinning.operationId
            )
          ) {
            persistTombstone(
              inner,
              'message',
              entity.entityId,
              parentWinning.timestamp,
              parentWinning.operationId,
              tombstoneByKey
            )
            result.suppressed += 1
            continue
          }
        }
        // Exact local tombstone delete-wins for the same message.
        const localExact = tombstoneByKey.get(key)
        if (
          localExact &&
          isSuppressedByTombstone(
            incomingEntityClock.timestamp,
            incomingEntityClock.operationId,
            localExact.timestamp,
            localExact.operationId
          )
        ) {
          result.suppressed += 1
          continue
        }
      }
      if (entity.entityType === 'message_block') {
        const messageId = payload.messageId as string
        const parentWinningKey = `message:${messageId}`
        const parentWinningTomb = incomingTombByKey.get(parentWinningKey)
        const parentWinning = winningTombKeys.has(parentWinningKey) ? parentWinningTomb : undefined
        const localParentTomb = tombstoneByKey.get(parentWinningKey)
        const localParentRow = inner.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
        // Candidate-internal parent may have been inserted earlier in this tx.
        const candidateParentInserted = insertedMessageIds.has(messageId)
        const parentPresent = !!localParentRow || candidateParentInserted
        if (!parentPresent) {
          if (parentWinning || localParentTomb) {
            result.suppressed += 1
            continue
          }
          fail(`baseline apply orphan block ${entity.entityId} parent ${messageId} missing`)
        }
        if (localParentRow && localParentTomb) {
          if (
            isSuppressedByTombstone(
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              localParentTomb.timestamp,
              localParentTomb.operationId
            )
          ) {
            result.suppressed += 1
            continue
          }
        }
        if (parentWinning && parentPresent) {
          if (
            isSuppressedByTombstone(
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              parentWinning.timestamp,
              parentWinning.operationId
            )
          ) {
            result.suppressed += 1
            continue
          }
          // Delete-wins when the parent will be deleted and is currently
          // absent is handled above; a present parent falls back to LWW here.
          if (!localParentRow && !candidateParentInserted) {
            result.suppressed += 1
            continue
          }
        }
        const localExact = tombstoneByKey.get(key)
        if (
          localExact &&
          isSuppressedByTombstone(
            incomingEntityClock.timestamp,
            incomingEntityClock.operationId,
            localExact.timestamp,
            localExact.operationId
          )
        ) {
          result.suppressed += 1
          continue
        }
      }
      if (entity.entityType === 'topic') {
        const localExact = tombstoneByKey.get(key)
        if (
          localExact &&
          isSuppressedByTombstone(
            incomingEntityClock.timestamp,
            incomingEntityClock.operationId,
            localExact.timestamp,
            localExact.operationId
          )
        ) {
          result.suppressed += 1
          continue
        }
      }

      // Existing vs missing.
      if (entity.entityType === 'topic') {
        const local = inner.select().from(schema.topics).where(eq(schema.topics.id, entity.entityId)).get()
        if (!local) {
          const overflow: Record<string, unknown> = {}
          for (const k of ['pinned', 'prompt', 'isNameManuallyEdited'] as const) {
            if (Object.prototype.hasOwnProperty.call(payload, k) && payload[k] !== undefined) overflow[k] = payload[k]
          }
          const extraValue = encodeJson(Object.keys(overflow).length > 0 ? overflow : null)
          inner
            .insert(schema.topics)
            .values({
              id: entity.entityId,
              name: (payload.name as string | null) ?? null,
              assistantId: (payload.assistantId as string | null) ?? null,
              createdAt: (payload.createdAt as string | null) ?? null,
              updatedAt: (payload.updatedAt as string | null) ?? null,
              deletedAt: (payload.deletedAt as string | null) ?? null,
              extra: extraValue
            })
            .run()
          upsertEntityClock(
            inner,
            'topic',
            entity.entityId,
            incomingEntityClock.timestamp,
            incomingEntityClock.operationId,
            entityClockByKey
          )
          for (const fc of entity.fieldClocks) {
            upsertFieldClock(inner, 'topic', entity.entityId, fc.field, fc.timestamp, fc.operationId, fieldClockByKey)
          }
          insertedTopicIds.add(entity.entityId)
          result.inserted += 1
          continue
        }
        // Existing: per-field LWW. This bounded path is intentionally stricter
        // than ordinary operation replay: a differing field without a local
        // field clock fails closed even when a local entity clock exists, so
        // legacy unversioned state can never be overwritten or silently kept
        // without causality. Equal values may install the incoming field clock
        // as metadata repair (no logical change, never regressing stronger).
        const overflow = decodeTopicOverflow(local.extra, local.id)
        const incomingFcs = new Map(entity.fieldClocks.map((fc) => [fc.field, fc]))
        const localFcs = fieldClockByKey.get(key) ?? new Map()
        const winners: Array<{ field: string; value: unknown }> = []
        let hasSuppressedField = false
        let allEqual = true
        for (const field of Object.keys(payload)) {
          if (field === 'id') continue
          if (!BASELINE_FIELD_CLOCK_ALLOW.topic.has(field)) continue
          const incomingFc = incomingFcs.get(field)
          if (!incomingFc) fail(`baseline apply missing field clock for ${entity.entityId}/${field}`)
          const incomingVal = (payload[field] ?? null) as unknown
          const localVal = topicLocalFieldValue(local, overflow, field)
          if (fieldValuesEqual(incomingVal, localVal)) {
            const prior = localFcs.get(field)
            if (!prior) {
              upsertFieldClock(
                inner,
                'topic',
                entity.entityId,
                field,
                incomingFc.timestamp,
                incomingFc.operationId,
                fieldClockByKey
              )
            } else if (
              compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0
            ) {
              upsertFieldClock(
                inner,
                'topic',
                entity.entityId,
                field,
                incomingFc.timestamp,
                incomingFc.operationId,
                fieldClockByKey
              )
            }
            continue
          }
          allEqual = false
          const prior = localFcs.get(field)
          if (prior) {
            if (compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0) {
              winners.push({ field, value: incomingVal })
            } else {
              hasSuppressedField = true
            }
          } else {
            fail(`baseline apply unversioned_local_collision for topic/${entity.entityId}/${field}`)
          }
        }
        if (winners.length === 0) {
          // Advance entity clock when stronger but no logical change (equal
          // path already advanced field clocks above).
          if (!allEqual && hasSuppressedField) {
            result.suppressed += 1
          } else {
            upsertEntityClock(
              inner,
              'topic',
              entity.entityId,
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              entityClockByKey
            )
            result.unchanged += 1
          }
          // Still allow entity-clock advancement for equal case (done below
          // via unchanged path); for suppressed case preserve stronger local.
          if (allEqual) {
            upsertEntityClock(
              inner,
              'topic',
              entity.entityId,
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              entityClockByKey
            )
          }
          continue
        }
        const colSet: Record<string, unknown> = {}
        const mergedOverflow: Record<string, unknown> = { ...overflow }
        const wonPayload: Record<string, unknown> = {}
        for (const w of winners) {
          wonPayload[w.field] = payload[w.field]
          if (
            w.field === 'name' ||
            w.field === 'assistantId' ||
            w.field === 'createdAt' ||
            w.field === 'updatedAt' ||
            w.field === 'deletedAt'
          ) {
            colSet[w.field] = w.value
          } else {
            mergedOverflow[w.field] = w.value
          }
        }
        const extraValue = encodeJson(Object.keys(mergedOverflow).length > 0 ? mergedOverflow : null)
        inner
          .update(schema.topics)
          .set({ ...colSet, extra: extraValue })
          .where(eq(schema.topics.id, entity.entityId))
          .run()
        for (const w of winners) {
          const fc = incomingFcs.get(w.field)
          if (fc)
            upsertFieldClock(inner, 'topic', entity.entityId, w.field, fc.timestamp, fc.operationId, fieldClockByKey)
        }
        upsertEntityClock(
          inner,
          'topic',
          entity.entityId,
          incomingEntityClock.timestamp,
          incomingEntityClock.operationId,
          entityClockByKey
        )
        result.updated += 1
        continue
      }

      if (entity.entityType === 'message') {
        const topicId = payload.topicId as string
        const local = inner.select().from(schema.messages).where(eq(schema.messages.id, entity.entityId)).get()
        if (!local) {
          const parentRow = inner.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get()
          if (!parentRow && !insertedTopicIds.has(topicId)) {
            fail(`baseline apply orphan message ${entity.entityId} parent ${topicId} missing`)
          }
          // Full payload required: no defaults compensate for absent fields.
          if (!isSafeInteger(payload.sortOrder)) {
            fail(`baseline apply missing required message sortOrder for ${entity.entityId}`)
          }
          const sortOrder = payload.sortOrder
          inner
            .insert(schema.messages)
            .values({
              id: entity.entityId,
              topicId,
              role: (payload.role as string | null) ?? null,
              content: (payload.content as string | null) ?? null,
              status: (payload.status as string | null) ?? null,
              askId: (payload.askId as string | null) ?? null,
              model: (payload.model as string | null) ?? null,
              modelId: (payload.modelId as string | null) ?? null,
              assistantId: (payload.assistantId as string | null) ?? null,
              createdAt: (payload.createdAt as string | null) ?? null,
              updatedAt: (payload.updatedAt as string | null) ?? null,
              sortOrder,
              extra: null
            })
            .run()
          upsertEntityClock(
            inner,
            'message',
            entity.entityId,
            incomingEntityClock.timestamp,
            incomingEntityClock.operationId,
            entityClockByKey
          )
          for (const fc of entity.fieldClocks) {
            upsertFieldClock(inner, 'message', entity.entityId, fc.field, fc.timestamp, fc.operationId, fieldClockByKey)
          }
          insertedMessageIds.add(entity.entityId)
          result.inserted += 1
          continue
        }
        if (local.topicId !== topicId) {
          fail(
            `baseline apply immutable message parent mismatch for ${entity.entityId}: ${local.topicId} vs ${topicId}`
          )
        }
        const incomingFcs = new Map(entity.fieldClocks.map((fc) => [fc.field, fc]))
        const localFcs = fieldClockByKey.get(key) ?? new Map()
        // Stricter than ordinary replay: no entity-clock fallback for fields.
        const winners: Array<{ field: string; value: unknown }> = []
        let hasSuppressedField = false
        let allEqual = true
        for (const field of Object.keys(payload)) {
          if (field === 'id' || field === 'topicId') continue
          if (!BASELINE_FIELD_CLOCK_ALLOW.message.has(field)) continue
          const incomingFc = incomingFcs.get(field)
          if (!incomingFc) fail(`baseline apply missing field clock for ${entity.entityId}/${field}`)
          let incomingVal: unknown = (payload[field] ?? null) as unknown
          if (field === 'sortOrder') {
            const raw = payload[field] as number | null | undefined
            if (!isSafeInteger(raw)) fail(`baseline apply invalid message sortOrder for ${entity.entityId}`)
            incomingVal = raw
          }
          const localVal = messageLocalFieldValue(local, field)
          if (fieldValuesEqual(incomingVal, localVal)) {
            const prior = localFcs.get(field)
            if (!prior) {
              upsertFieldClock(
                inner,
                'message',
                entity.entityId,
                field,
                incomingFc.timestamp,
                incomingFc.operationId,
                fieldClockByKey
              )
            } else if (
              compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0
            ) {
              upsertFieldClock(
                inner,
                'message',
                entity.entityId,
                field,
                incomingFc.timestamp,
                incomingFc.operationId,
                fieldClockByKey
              )
            }
            continue
          }
          allEqual = false
          const prior = localFcs.get(field)
          if (prior) {
            if (compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0) {
              winners.push({ field, value: incomingVal })
            } else {
              hasSuppressedField = true
            }
          } else {
            fail(`baseline apply unversioned_local_collision for message/${entity.entityId}/${field}`)
          }
        }
        if (winners.length === 0) {
          if (!allEqual && hasSuppressedField) {
            result.suppressed += 1
          } else {
            upsertEntityClock(
              inner,
              'message',
              entity.entityId,
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              entityClockByKey
            )
            result.unchanged += 1
          }
          if (allEqual) {
            upsertEntityClock(
              inner,
              'message',
              entity.entityId,
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              entityClockByKey
            )
          }
          insertedMessageIds.add(entity.entityId)
          continue
        }
        const setM: Record<string, unknown> = {}
        for (const w of winners) setM[w.field] = w.value
        inner.update(schema.messages).set(setM).where(eq(schema.messages.id, entity.entityId)).run()
        for (const w of winners) {
          const fc = incomingFcs.get(w.field)
          if (fc)
            upsertFieldClock(inner, 'message', entity.entityId, w.field, fc.timestamp, fc.operationId, fieldClockByKey)
        }
        upsertEntityClock(
          inner,
          'message',
          entity.entityId,
          incomingEntityClock.timestamp,
          incomingEntityClock.operationId,
          entityClockByKey
        )
        insertedMessageIds.add(entity.entityId)
        result.updated += 1
        continue
      }

      // message_block
      {
        const messageId = payload.messageId as string
        const local = inner
          .select()
          .from(schema.messageBlocks)
          .where(eq(schema.messageBlocks.id, entity.entityId))
          .get()
        if (!local) {
          const parentRow = inner.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
          if (!parentRow && !insertedMessageIds.has(messageId)) {
            fail(`baseline apply orphan block ${entity.entityId} parent ${messageId} missing`)
          }
          if (!isSafeInteger(payload.sortOrder)) {
            fail(`baseline apply missing required block sortOrder for ${entity.entityId}`)
          }
          const sortOrder = payload.sortOrder
          inner
            .insert(schema.messageBlocks)
            .values({
              id: entity.entityId,
              messageId,
              type: (payload.type as string | null) ?? null,
              content: (payload.content as string | null) ?? null,
              status: (payload.status as string | null) ?? null,
              createdAt: (payload.createdAt as string | null) ?? null,
              updatedAt: (payload.updatedAt as string | null) ?? null,
              sortOrder,
              extra: null
            })
            .run()
          upsertEntityClock(
            inner,
            'message_block',
            entity.entityId,
            incomingEntityClock.timestamp,
            incomingEntityClock.operationId,
            entityClockByKey
          )
          for (const fc of entity.fieldClocks) {
            upsertFieldClock(
              inner,
              'message_block',
              entity.entityId,
              fc.field,
              fc.timestamp,
              fc.operationId,
              fieldClockByKey
            )
          }
          result.inserted += 1
          continue
        }
        if (local.messageId !== messageId) {
          fail(
            `baseline apply immutable block parent mismatch for ${entity.entityId}: ${local.messageId} vs ${messageId}`
          )
        }
        const incomingFcs = new Map(entity.fieldClocks.map((fc) => [fc.field, fc]))
        const localFcs = fieldClockByKey.get(key) ?? new Map()
        // Stricter than ordinary replay: no entity-clock fallback for fields.
        const winners: Array<{ field: string; value: unknown }> = []
        let hasSuppressedField = false
        let allEqual = true
        for (const field of Object.keys(payload)) {
          if (field === 'id' || field === 'messageId') continue
          if (!BASELINE_FIELD_CLOCK_ALLOW.message_block.has(field)) continue
          const incomingFc = incomingFcs.get(field)
          if (!incomingFc) fail(`baseline apply missing field clock for ${entity.entityId}/${field}`)
          let incomingVal: unknown = (payload[field] ?? null) as unknown
          if (field === 'sortOrder') {
            const raw = payload[field] as number | null | undefined
            if (!isSafeInteger(raw)) fail(`baseline apply invalid block sortOrder for ${entity.entityId}`)
            incomingVal = raw
          }
          const localVal = blockLocalFieldValue(local, field)
          if (fieldValuesEqual(incomingVal, localVal)) {
            const prior = localFcs.get(field)
            if (!prior) {
              upsertFieldClock(
                inner,
                'message_block',
                entity.entityId,
                field,
                incomingFc.timestamp,
                incomingFc.operationId,
                fieldClockByKey
              )
            } else if (
              compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0
            ) {
              upsertFieldClock(
                inner,
                'message_block',
                entity.entityId,
                field,
                incomingFc.timestamp,
                incomingFc.operationId,
                fieldClockByKey
              )
            }
            continue
          }
          allEqual = false
          const prior = localFcs.get(field)
          if (prior) {
            if (compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0) {
              winners.push({ field, value: incomingVal })
            } else {
              hasSuppressedField = true
            }
          } else {
            fail(`baseline apply unversioned_local_collision for message_block/${entity.entityId}/${field}`)
          }
        }
        if (winners.length === 0) {
          if (!allEqual && hasSuppressedField) {
            result.suppressed += 1
          } else {
            upsertEntityClock(
              inner,
              'message_block',
              entity.entityId,
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              entityClockByKey
            )
            result.unchanged += 1
          }
          if (allEqual) {
            upsertEntityClock(
              inner,
              'message_block',
              entity.entityId,
              incomingEntityClock.timestamp,
              incomingEntityClock.operationId,
              entityClockByKey
            )
          }
          continue
        }
        const setB: Record<string, unknown> = {}
        for (const w of winners) setB[w.field] = w.value
        inner.update(schema.messageBlocks).set(setB).where(eq(schema.messageBlocks.id, entity.entityId)).run()
        for (const w of winners) {
          const fc = incomingFcs.get(w.field)
          if (fc)
            upsertFieldClock(
              inner,
              'message_block',
              entity.entityId,
              w.field,
              fc.timestamp,
              fc.operationId,
              fieldClockByKey
            )
        }
        upsertEntityClock(
          inner,
          'message_block',
          entity.entityId,
          incomingEntityClock.timestamp,
          incomingEntityClock.operationId,
          entityClockByKey
        )
        result.updated += 1
        continue
      }
    }

    // Apply winning tombstones with cascade/containment. F2 runs before the
    // winning check so any tombstone targeting unversioned live fails closed
    // regardless of strength; whole transaction rolls back.
    for (const tomb of candidate.tombstones) {
      const key = `${tomb.entityType}:${tomb.entityId}`
      requireVersionedLiveForTombstone(inner, tomb.entityType, tomb.entityId, entityClockByKey)
      if (!winningTombKeys.has(key)) {
        result.suppressed += 1
        continue
      }
      if (tomb.entityType === 'topic') {
        const childIds: string[] = inner
          .select({ id: schema.messages.id })
          .from(schema.messages)
          .where(eq(schema.messages.topicId, tomb.entityId))
          .all()
          .map((r) => r.id)
        const existing = inner.select().from(schema.topics).where(eq(schema.topics.id, tomb.entityId)).get()
        if (existing) {
          // FK cascade removes messages/blocks/file_refs/segments/memberships.
          inner.delete(schema.topics).where(eq(schema.topics.id, tomb.entityId)).run()
          result.deleted += 1
        } else {
          result.unchanged += 1
        }
        persistTombstone(inner, 'topic', tomb.entityId, tomb.timestamp, tomb.operationId, tombstoneByKey)
        if (tomb.operationId !== null) {
          upsertEntityClock(inner, 'topic', tomb.entityId, tomb.timestamp, tomb.operationId, entityClockByKey)
        } else if (tomb.entityClock) {
          upsertEntityClock(
            inner,
            'topic',
            tomb.entityId,
            tomb.entityClock.timestamp,
            tomb.entityClock.operationId,
            entityClockByKey
          )
        }
        for (const mid of childIds) {
          persistTombstone(inner, 'message', mid, tomb.timestamp, tomb.operationId, tombstoneByKey)
        }
        // If the live candidate also carried the same topic suppressed above,
        // the delete above already accounts for it; suppressed count stays.
      } else if (tomb.entityType === 'message') {
        const existing = inner.select().from(schema.messages).where(eq(schema.messages.id, tomb.entityId)).get()
        const topicIdForCleanup = existing?.topicId ?? null
        if (existing) {
          // FK cascade removes blocks/file_refs/memberships.
          inner.delete(schema.messages).where(eq(schema.messages.id, tomb.entityId)).run()
          if (topicIdForCleanup) deleteEmptySegmentsForTopic(inner, topicIdForCleanup)
          result.deleted += 1
        } else {
          result.unchanged += 1
        }
        persistTombstone(inner, 'message', tomb.entityId, tomb.timestamp, tomb.operationId, tombstoneByKey)
        if (tomb.operationId !== null) {
          upsertEntityClock(inner, 'message', tomb.entityId, tomb.timestamp, tomb.operationId, entityClockByKey)
        } else if (tomb.entityClock) {
          upsertEntityClock(
            inner,
            'message',
            tomb.entityId,
            tomb.entityClock.timestamp,
            tomb.entityClock.operationId,
            entityClockByKey
          )
        }
      } else {
        const existing = inner
          .select()
          .from(schema.messageBlocks)
          .where(eq(schema.messageBlocks.id, tomb.entityId))
          .get()
        if (existing) {
          // FK cascade removes file_refs.
          inner.delete(schema.messageBlocks).where(eq(schema.messageBlocks.id, tomb.entityId)).run()
          result.deleted += 1
        } else {
          result.unchanged += 1
        }
        persistTombstone(inner, 'message_block', tomb.entityId, tomb.timestamp, tomb.operationId, tombstoneByKey)
        if (tomb.operationId !== null) {
          upsertEntityClock(inner, 'message_block', tomb.entityId, tomb.timestamp, tomb.operationId, entityClockByKey)
        } else if (tomb.entityClock) {
          upsertEntityClock(
            inner,
            'message_block',
            tomb.entityId,
            tomb.entityClock.timestamp,
            tomb.entityClock.operationId,
            entityClockByKey
          )
        }
      }
    }
  })

  return result
}
