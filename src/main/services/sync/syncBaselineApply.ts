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
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { decodeJson, encodeJson } from '../chatDb/domain/codec'
import * as schema from '../chatDb/schema'
import {
  BASELINE_FIELD_CLOCK_ALLOW,
  computeLocalSyncBaselineDigest,
  LOCAL_SYNC_BASELINE_INVENTORY_VERSION,
  LOCAL_SYNC_BASELINE_KIND,
  LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION,
  LOCAL_SYNC_BASELINE_SCHEMA_VERSION,
  LOCAL_SYNC_BASELINE_SCOPE,
  type LocalSyncBaselineCandidate,
  type LocalSyncBaselineEntity,
  type LocalSyncBaselineOrderFrame,
  type LocalSyncBaselineTombstone
} from './syncBaseline'
import {
  compareDeletionClock,
  compareUtf8ByteLex,
  evaluateEffectiveOrder,
  isTombstoneWinningOverLive,
  isValidUnicodeScalarString,
  validateFrameRowStrict,
  validateOperationIdStrict,
  validateOrdinaryIdStrict,
  validateTimestampStrict
} from './syncFrameEvaluation'
import { advanceFrameHighWater } from './syncFrameHighWater'
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
 * - message: 11 required (sortOrder excluded per SYNC-DATA-038), always materialized.
 * - block: 7 required (sortOrder excluded), always materialized.
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
  'updatedAt'
] as const
const BASELINE_BLOCK_REQUIRED = ['id', 'messageId', 'type', 'content', 'status', 'createdAt', 'updatedAt'] as const

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
  return compareUtf8ByteLex(aId, bId)
}

function isValidTimestamp(value: unknown): value is number {
  try {
    validateTimestampStrict(value, 'timestamp')
    return true
  } catch {
    return false
  }
}

function requireOperationId(value: unknown, context: string): string {
  try {
    return validateOperationIdStrict(value, context)
  } catch (e) {
    fail(`baseline apply malformed operationId for ${context}: ${e instanceof Error ? e.message : String(e)}`, e)
  }
}

function requireOrdinaryId(value: unknown, context: string): string {
  try {
    return validateOrdinaryIdStrict(value, context)
  } catch (e) {
    fail(`baseline apply malformed id for ${context}: ${e instanceof Error ? e.message : String(e)}`, e)
  }
}

function isValidOrdinaryId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && isValidUnicodeScalarString(value)
}

function isSuppressedByTombstone(opTs: number, opId: string, tombTs: number, tombOpId: string | null): boolean {
  // D2: (T,null) > (T,nonNull); legacy null tombstone suppresses equal-T live operations
  if (tombOpId === null) return opTs <= tombTs
  if (opTs !== tombTs) return opTs < tombTs
  return compareUtf8ByteLex(opId, tombOpId) <= 0
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
      if (k === 'sortOrder') fail(`baseline apply unexpected message field for ${entityId}: sortOrder`)
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
    if (Object.prototype.hasOwnProperty.call(payload, 'sortOrder')) {
      fail(`baseline apply unexpected message sortOrder for ${entityId}`)
    }
    return
  }
  const required = new Set<string>(BASELINE_BLOCK_REQUIRED)
  if (keys.length !== required.size) {
    fail(`baseline apply block field count mismatch for ${entityId}: expected ${required.size}, got ${keys.length}`)
  }
  for (const k of keys) {
    if (!required.has(k)) fail(`baseline apply unexpected block field for ${entityId}: ${k}`)
    if (payload[k] === undefined) fail(`baseline apply undefined block field for ${entityId}: ${k}`)
    if (k === 'sortOrder') fail(`baseline apply unexpected block field for ${entityId}: sortOrder`)
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
  if (Object.prototype.hasOwnProperty.call(payload, 'sortOrder')) {
    fail(`baseline apply unexpected block sortOrder for ${entityId}`)
  }
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
  if (candidate.orderFrameVersion !== LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION)
    fail('baseline apply orderFrameVersion mismatch')
  const manifest = candidate.manifest as LocalSyncBaselineCandidate['manifest'] | undefined
  if (!manifest || typeof manifest !== 'object') fail('baseline apply malformed manifest')
  if (manifest.schemaVersion !== LOCAL_SYNC_BASELINE_SCHEMA_VERSION) fail('baseline apply manifest schema mismatch')
  if (manifest.inventoryVersion !== LOCAL_SYNC_BASELINE_INVENTORY_VERSION) {
    fail('baseline apply manifest inventory mismatch')
  }
  if (
    (manifest as unknown as { orderFrameVersion?: unknown }).orderFrameVersion !==
    LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION
  ) {
    fail('baseline apply manifest orderFrameVersion mismatch')
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

  // --- Manifest exact-keys and numeric shape ---
  const ec = (manifest as unknown as { entityCounts?: unknown }).entityCounts as Record<string, unknown> | undefined
  if (!ec || typeof ec !== 'object' || Array.isArray(ec)) fail('baseline apply malformed entityCounts')
  const ecKeys = Object.keys(ec).sort()
  const expectedEcKeys = ['message', 'message_block', 'topic', 'total'].sort()
  if (JSON.stringify(ecKeys) !== JSON.stringify(expectedEcKeys)) fail('baseline apply entityCounts exact keys mismatch')
  for (const k of expectedEcKeys) {
    const v = ec[k]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(`baseline apply malformed entityCounts ${k}`)
  }
  const fcRaw = (manifest as unknown as { frameCounts?: unknown }).frameCounts
  if (!fcRaw || typeof fcRaw !== 'object' || Array.isArray(fcRaw)) fail('baseline apply malformed frameCounts')
  const fcKeys = Object.keys(fcRaw as Record<string, unknown>).sort()
  const expectedFcKeys = ['messageBlock', 'topicMessage'].sort()
  if (JSON.stringify(fcKeys) !== JSON.stringify(expectedFcKeys)) fail('baseline apply frameCounts exact keys mismatch')
  const frameCounts = fcRaw as { topicMessage: unknown; messageBlock: unknown }
  if (
    typeof frameCounts.topicMessage !== 'number' ||
    !Number.isSafeInteger(frameCounts.topicMessage) ||
    frameCounts.topicMessage < 0
  )
    fail('baseline apply malformed frameCounts topicMessage')
  if (
    typeof frameCounts.messageBlock !== 'number' ||
    !Number.isSafeInteger(frameCounts.messageBlock) ||
    frameCounts.messageBlock < 0
  )
    fail('baseline apply malformed frameCounts messageBlock')

  // Validate numeric counters are safe ints >=0
  const numericFields: Array<keyof typeof manifest> = [
    'tombstoneCount',
    'unversionedEntityCount',
    'unversionedFieldCount',
    'unversionedMembershipCount',
    'excludedTransientMessages',
    'excludedTransientBlocks',
    'excludedUnsupportedBlocks',
    'orphanSuppressedChildren',
    'aggregateIncompleteParents',
    'missingOrderFrameCount',
    'incompleteOrderFrameCount',
    'pendingOutboxCount'
  ] as never
  for (const f of numericFields) {
    const v = (manifest as unknown as Record<string, unknown>)[f as string]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      fail(`baseline apply malformed manifest ${String(f)}`)
  }

  // --- Candidate/manifest echo exact match for derivable scalars ---
  if (candidate.pendingOutboxCount !== manifest.pendingOutboxCount)
    fail('baseline apply pendingOutboxCount echo mismatch')
  if (candidate.observationBinding !== manifest.observationBinding)
    fail('baseline apply observationBinding echo mismatch')
  if (candidate.completeness.state !== manifest.completenessState)
    fail('baseline apply completenessState echo mismatch')
  if (
    JSON.stringify([...candidate.completeness.reasons].sort()) !==
    JSON.stringify([...manifest.completenessReasons].sort())
  )
    fail('baseline apply completenessReasons echo mismatch')
  if (candidate.schemaVersion !== manifest.schemaVersion) fail('baseline apply schemaVersion echo mismatch')
  if (candidate.inventoryVersion !== manifest.inventoryVersion) fail('baseline apply inventoryVersion echo mismatch')
  if (candidate.orderFrameVersion !== (manifest as unknown as { orderFrameVersion: string }).orderFrameVersion)
    fail('baseline apply orderFrameVersion echo mismatch')

  // --- Known reasons and sorted unique check ---
  const KNOWN_REASONS = new Set<string>([
    'observed-watermark-unbound',
    'transient-message-excluded',
    'transient-block-excluded',
    'unsupported-block-excluded',
    'orphan-child-suppressed',
    'unversioned-entity',
    'unversioned-field',
    'unversioned-membership',
    'pending-outbox',
    'aggregate-incomplete-child-excluded',
    'missing-order-frame',
    'incomplete-order-frame'
  ])
  const checkReasons = (reasons: unknown, ctx: string): string[] => {
    if (!Array.isArray(reasons)) fail(`baseline apply malformed ${ctx} reasons`)
    const arr = reasons as unknown[]
    for (const r of arr) if (typeof r !== 'string') fail(`baseline apply malformed reason ${String(r)} in ${ctx}`)
    const sorted = [...(arr as string[])].sort()
    if (JSON.stringify(arr) !== JSON.stringify(sorted)) fail(`baseline apply ${ctx} reasons not sorted`)
    if (new Set(arr).size !== arr.length) fail(`baseline apply ${ctx} reasons not unique`)
    for (const r of arr as string[]) if (!KNOWN_REASONS.has(r)) fail(`baseline apply unknown reason ${r} in ${ctx}`)
    return arr as string[]
  }
  const candReasons = checkReasons(candidate.completeness.reasons, 'candidate completeness')
  const manifestReasons = checkReasons(manifest.completenessReasons, 'manifest completeness')
  // Ensure candidate and manifest reasons match exactly (already sorted)
  if (JSON.stringify(candReasons) !== JSON.stringify(manifestReasons))
    fail('baseline apply completeness reasons echo mismatch')

  // --- Source-observation internal consistency (non-derivable counters) ---
  const counterReasonMap: Array<[keyof typeof manifest, string]> = [
    ['excludedTransientMessages', 'transient-message-excluded'],
    ['excludedTransientBlocks', 'transient-block-excluded'],
    ['excludedUnsupportedBlocks', 'unsupported-block-excluded'],
    ['orphanSuppressedChildren', 'orphan-child-suppressed'],
    ['aggregateIncompleteParents', 'aggregate-incomplete-child-excluded'],
    ['missingOrderFrameCount', 'missing-order-frame'],
    ['incompleteOrderFrameCount', 'incomplete-order-frame'],
    ['pendingOutboxCount', 'pending-outbox'],
    ['unversionedEntityCount', 'unversioned-entity'],
    ['unversionedFieldCount', 'unversioned-field'],
    ['unversionedMembershipCount', 'unversioned-membership']
  ] as never
  for (const [field, reason] of counterReasonMap) {
    const cnt = (manifest as unknown as Record<string, unknown>)[field as string] as number
    const hasReason = manifestReasons.includes(reason)
    if (cnt > 0 && !hasReason) fail(`baseline apply manifest ${String(field)}=${cnt} >0 but reason ${reason} absent`)
    if (cnt === 0 && hasReason) fail(`baseline apply manifest ${String(field)}=0 but reason ${reason} present`)
  }
  // aggregateIncompleteParents >0 requires at least one relevant excluded/orphan >0
  if (manifest.aggregateIncompleteParents > 0) {
    const relevant =
      manifest.excludedTransientMessages +
      manifest.excludedTransientBlocks +
      manifest.excludedUnsupportedBlocks +
      manifest.orphanSuppressedChildren
    if (relevant === 0) fail('baseline apply aggregateIncompleteParents >0 but no excluded/orphan counts >0')
  }
  // observation binding consistency
  if (candidate.observationBinding === 'unbound' || manifest.observationBinding === 'unbound') {
    if (candidate.observationBinding !== 'unbound' || manifest.observationBinding !== 'unbound')
      fail('baseline apply observationBinding mismatch bound/unbound')
    if (candidate.observedLocalChannelKey !== null || candidate.observedLocalCursor !== null)
      fail('baseline apply unbound must have null observed key/cursor')
    if ((manifest as unknown as Record<string, unknown>).observationBinding !== 'unbound')
      fail('baseline apply manifest unbound binding mismatch')
    if (manifest.completenessState !== 'unbound') fail('baseline apply manifest unbound must have completeness unbound')
    if (!manifestReasons.includes('observed-watermark-unbound'))
      fail('baseline apply unbound missing observed-watermark-unbound reason')
  } else {
    // bound
    if (candidate.observedLocalChannelKey === null || candidate.observedLocalCursor === null)
      fail('baseline apply bound must have non-null observed key/cursor')
  }
  // bound+complete iff all reasons empty and all source-diagnostic counters zero; bound+partial iff reasons nonempty
  const allDiagnosticZero =
    manifest.excludedTransientMessages === 0 &&
    manifest.excludedTransientBlocks === 0 &&
    manifest.excludedUnsupportedBlocks === 0 &&
    manifest.orphanSuppressedChildren === 0 &&
    manifest.aggregateIncompleteParents === 0 &&
    manifest.missingOrderFrameCount === 0 &&
    manifest.incompleteOrderFrameCount === 0 &&
    manifest.pendingOutboxCount === 0 &&
    manifest.unversionedEntityCount === 0 &&
    manifest.unversionedFieldCount === 0 &&
    manifest.unversionedMembershipCount === 0
  if (candidate.observationBinding === 'bound') {
    if (candidate.completeness.state === 'complete') {
      if (candReasons.length !== 0) fail('baseline apply bound+complete must have empty reasons')
      if (!allDiagnosticZero) fail('baseline apply bound+complete must have all diagnostic counters zero')
      if (manifest.completenessState !== 'complete') fail('baseline apply manifest bound+complete must be complete')
    } else if (candidate.completeness.state === 'partial') {
      if (candReasons.length === 0) fail('baseline apply bound+partial must have nonempty reasons')
      if (manifest.completenessState !== 'partial') fail('baseline apply manifest bound+partial mismatch')
    } else if (candidate.completeness.state === 'unbound') {
      fail('baseline apply bound cannot have unbound completeness')
    }
  }

  // Bounded safe path only (still enforce complete for apply)
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
  // unversioned counts already checked via counterReasonMap, but keep zero checks for complete
  if (manifest.unversionedEntityCount !== 0) fail('baseline apply manifest must have zero unversioned entities')
  const unversionedFieldCount = (manifest as { unversionedFieldCount?: unknown }).unversionedFieldCount
  if (unversionedFieldCount !== 0) fail('baseline apply manifest must have zero unversioned fields')
  const unversionedMembershipCount = (manifest as { unversionedMembershipCount?: unknown }).unversionedMembershipCount
  if (unversionedMembershipCount !== 0) fail('baseline apply manifest must have zero unversioned memberships')
  if (manifest.excludedTransientMessages !== 0) fail('baseline apply manifest must exclude no transient messages')
  if (manifest.excludedTransientBlocks !== 0) fail('baseline apply manifest must exclude no transient blocks')
  if (manifest.excludedUnsupportedBlocks !== 0) fail('baseline apply manifest must exclude no unsupported blocks')
  if (manifest.orphanSuppressedChildren !== 0) fail('baseline apply manifest must suppress no orphans')
  if (manifest.aggregateIncompleteParents !== 0) fail('baseline apply manifest must have no incomplete parents')
  // Frame manifest
  if (
    (manifest as unknown as { orderFrameVersion?: unknown }).orderFrameVersion !==
    LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION
  ) {
    fail('baseline apply manifest orderFrameVersion mismatch')
  }
  if (!Array.isArray((candidate as unknown as { orderFrames?: unknown }).orderFrames))
    fail('baseline apply malformed orderFrames')
  const candidateFrames = (candidate as unknown as { orderFrames: unknown[] })
    .orderFrames as LocalSyncBaselineCandidate['orderFrames']
  if (typeof (manifest as unknown as { frameCounts?: unknown }).frameCounts !== 'object')
    fail('baseline apply malformed frameCounts')
  const frameCounts2 = (manifest as unknown as { frameCounts: { topicMessage: unknown; messageBlock: unknown } })
    .frameCounts
  if (typeof frameCounts2.topicMessage !== 'number' || typeof frameCounts2.messageBlock !== 'number') {
    fail('baseline apply malformed frameCounts')
  }
  if (frameCounts2.topicMessage !== candidateFrames.filter((f) => f.kind === 'topicMessage').length) {
    fail('baseline apply frameCount topicMessage mismatch')
  }
  if (frameCounts2.messageBlock !== candidateFrames.filter((f) => f.kind === 'messageBlock').length) {
    fail('baseline apply frameCount messageBlock mismatch')
  }
  const missingOrderFrameCount = (manifest as unknown as { missingOrderFrameCount?: unknown }).missingOrderFrameCount
  const incompleteOrderFrameCount = (manifest as unknown as { incompleteOrderFrameCount?: unknown })
    .incompleteOrderFrameCount
  if (typeof missingOrderFrameCount !== 'number' || typeof incompleteOrderFrameCount !== 'number') {
    fail('baseline apply malformed missing/incomplete frame counts')
  }
  if (missingOrderFrameCount !== 0) fail('baseline apply manifest must have zero missing order frames')
  if (incompleteOrderFrameCount !== 0) fail('baseline apply manifest must have zero incomplete order frames')
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
  // Exact recompute for unversioned counts (derivable)
  {
    const computedUnversionedEntity = candidate.entities.filter((e) => !e.entityClock).length
    if ((manifest.unversionedEntityCount as unknown as number) !== computedUnversionedEntity)
      fail(
        `baseline apply unversionedEntityCount mismatch manifest ${manifest.unversionedEntityCount} vs computed ${computedUnversionedEntity}`
      )
    // unversionedFieldCount: for each entity, count payload clocked fields missing clocks
    let computedUnversionedField = 0
    for (const e of candidate.entities) {
      const allow = BASELINE_FIELD_CLOCK_ALLOW[e.entityType]
      const present = new Set<string>(Object.keys(e.payload).filter((k) => allow.has(k)))
      const seen = new Set<string>(e.fieldClocks.map((fc) => fc.field))
      for (const k of present) if (!seen.has(k)) computedUnversionedField++
      // extra clocks for absent fields already validated earlier but also count as mismatch? Actually unversionedFieldCount counts missing, not extra; but if extra exists, it would be validated as error earlier. So just missing.
    }
    if ((manifest.unversionedFieldCount as unknown as number) !== computedUnversionedField)
      fail(
        `baseline apply unversionedFieldCount mismatch manifest ${manifest.unversionedFieldCount} vs computed ${computedUnversionedField}`
      )
    const computedMissing = candidate.entities.filter((e) => {
      if (e.entityType === 'topic') return false
      const pm = (e as unknown as { parentMembershipClock?: unknown }).parentMembershipClock
      return pm === null || pm === undefined
    }).length
    const manifestMissing = (manifest as { unversionedMembershipCount?: unknown }).unversionedMembershipCount
    if (typeof manifestMissing !== 'number' || manifestMissing !== computedMissing) {
      fail(
        `baseline apply membership count mismatch: manifest ${String(manifestMissing)} vs computed ${computedMissing}`
      )
    }
    if (computedMissing !== 0) fail('baseline apply requires zero missing memberships for complete')
    if (computedUnversionedField !== 0) fail('baseline apply requires zero missing field clocks for complete')
    if (computedUnversionedEntity !== 0) fail('baseline apply requires zero unversioned entities for complete')
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
    if (!isValidOrdinaryId(entity.entityId)) fail('baseline apply malformed entityId')
    try {
      requireOrdinaryId(entity.entityId, `${entity.entityType}/${entity.entityId}`)
    } catch (e) {
      throw e
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
      requireOrdinaryId(payload.topicId, `message/${entity.entityId} topicId`)
      if (!isStableMessageStatus(payload.status)) fail(`baseline apply transient message for ${entity.entityId}`)
    }
    if (entity.entityType === 'message_block') {
      requireOrdinaryId(payload.messageId, `block/${entity.entityId} messageId`)
      if (!isStableBlockStatus(payload.status)) fail(`baseline apply transient block for ${entity.entityId}`)
      const blockType = typeof payload.type === 'string' ? payload.type.toLowerCase() : ''
      if (UNSUPPORTED_BLOCK_TYPES.has(blockType)) {
        fail(`baseline apply unsupported block type for ${entity.entityId}`)
      }
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
    // Parent-membership clock validation.
    if (entity.entityType === 'topic') {
      if (Object.prototype.hasOwnProperty.call(entity as unknown as Record<string, unknown>, 'parentMembershipClock')) {
        fail(`baseline apply unexpected topic membership for ${entity.entityId}`)
      }
    } else {
      if (
        !Object.prototype.hasOwnProperty.call(entity as unknown as Record<string, unknown>, 'parentMembershipClock')
      ) {
        fail(`baseline apply missing parent membership for ${entity.entityId}`)
      }
      const pm = (entity as unknown as { parentMembershipClock: unknown }).parentMembershipClock
      if (pm === null || pm === undefined) {
        fail(`baseline apply missing parent membership for ${entity.entityId}`)
      }
      if (typeof pm !== 'object' || Array.isArray(pm) || pm === null) {
        fail(`baseline apply malformed parent membership for ${entity.entityId}`)
      }
      const pmObj = pm as { timestamp?: unknown; operationId?: unknown; parentId?: unknown }
      if (!isValidTimestamp(pmObj.timestamp)) {
        fail(`baseline apply malformed parent membership timestamp for ${entity.entityId}`)
      }
      requireOperationId(pmObj.operationId, `${entity.entityType}/${entity.entityId}/parentMembershipClock`)
      // Validate parentId via ordinary ID (no 256 bound)
      if (typeof pmObj.parentId !== 'string' || !isValidOrdinaryId(pmObj.parentId))
        fail(`baseline apply malformed parentId for ${entity.entityId}`)
      requireOrdinaryId(pmObj.parentId, `${entity.entityType}/${entity.entityId} parentId`)
      // Also ensure payload parent matches membership parent
      const payloadParent =
        entity.entityType === 'message' ? (payload.topicId as string) : (payload.messageId as string)
      if (pmObj.parentId !== payloadParent)
        fail(
          `baseline apply parentId mismatch for ${entity.entityId}: membership ${pmObj.parentId} vs payload ${payloadParent}`
        )
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
    requireOrdinaryId(tomb.entityId, `tombstone/${tomb.entityType}`)
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

  // Order frames validation (strict, fail-closed)
  {
    const frames = candidate.orderFrames
    if (!Array.isArray(frames)) fail('baseline apply malformed orderFrames')
    const seenKeys = new Set<string>()
    let lastKind: 'topicMessage' | 'messageBlock' | null = null
    let lastParentId = ''
    const kindRank = (k: string): number => (k === 'topicMessage' ? 0 : 1)
    const frameByKey = new Map<string, (typeof frames)[number]>()
    for (let idx = 0; idx < frames.length; idx++) {
      const f = frames[idx] as unknown as Record<string, unknown>
      if (!f || typeof f !== 'object') fail(`baseline apply malformed orderFrame at index ${idx}`)
      if (f.frameVersion !== LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION) {
        fail(`baseline apply frameVersion mismatch at index ${idx}`)
      }
      if (f.kind !== 'topicMessage' && f.kind !== 'messageBlock') {
        fail(`baseline apply frame kind mismatch at index ${idx}`)
      }
      requireOrdinaryId(f.parentId, `frame/${String(f.parentId)} parentId`)
      if (!Array.isArray(f.orderedChildIds)) fail(`baseline apply malformed orderedChildIds at index ${idx}`)
      const ids = f.orderedChildIds as unknown[]
      const seenChild = new Set<string>()
      for (const cid of ids) {
        requireOrdinaryId(cid, `frame/${String(f.parentId)} childId`)
        if (seenChild.has(cid as string))
          fail(`baseline apply duplicate orderedChildId ${cid} in frame ${String(f.parentId)}`)
        seenChild.add(cid as string)
      }
      if (typeof f.frameClock !== 'object' || f.frameClock === null || Array.isArray(f.frameClock)) {
        fail(`baseline apply malformed frameClock at index ${idx}`)
      }
      const fc = f.frameClock as { timestamp?: unknown; operationId?: unknown }
      if (!isValidTimestamp(fc.timestamp)) fail(`baseline apply malformed frameClock timestamp at index ${idx}`)
      requireOperationId(fc.operationId, `frameClock/${String(f.parentId)}`)
      const key = `${f.kind}:${f.parentId}`
      if (seenKeys.has(key)) fail(`baseline apply duplicate frame ${key}`)
      seenKeys.add(key)
      if (frameByKey.has(key)) fail(`baseline apply duplicate frame ${key}`)
      frameByKey.set(key, f as never)
      if (lastKind !== null) {
        const curRank = kindRank(f.kind as string)
        const prevRank = kindRank(lastKind as string)
        if (curRank < prevRank) fail('baseline apply orderFrames not sorted by kind rank')
        if (curRank === prevRank) {
          const cmp = compareUtf8ByteLex(lastParentId, f.parentId as string)
          if (cmp >= 0) {
            if (cmp === 0) fail(`baseline apply duplicate frame ${key}`)
            fail('baseline apply orderFrames not sorted by parentId')
          }
        }
      }
      lastKind = f.kind as never
      lastParentId = f.parentId as string
    }
    const suppressedForFrame = new Set<string>()
    for (const e of candidate.entities) {
      const tKey = `${e.entityType}:${e.entityId}`
      if (!tombKeys.has(tKey) || !e.entityClock) continue
      const tomb = candidate.tombstones.find((t) => `${t.entityType}:${t.entityId}` === tKey)!
      const liveTs = e.entityClock.timestamp
      const liveOp = e.entityClock.operationId
      let isSuppressed = false
      if (tomb.operationId === null) {
        isSuppressed = liveTs <= tomb.timestamp
      } else {
        if (liveTs !== tomb.timestamp) isSuppressed = liveTs < tomb.timestamp
        else isSuppressed = compareUtf8ByteLex(liveOp, tomb.operationId) <= 0
      }
      if (isSuppressed) suppressedForFrame.add(tKey)
    }
    for (const tid of topicIds) {
      if (suppressedForFrame.has(`topic:${tid}`)) continue
      const k = `topicMessage:${tid}`
      if (!frameByKey.has(k)) fail(`baseline apply missing topicMessage frame for topic "${tid}"`)
    }
    for (const mid of messageIds) {
      if (suppressedForFrame.has(`message:${mid}`)) continue
      const k = `messageBlock:${mid}`
      if (!frameByKey.has(k)) fail(`baseline apply missing messageBlock frame for message "${mid}"`)
    }
    for (const [, f] of frameByKey) {
      const kind = (f as unknown as { kind: string }).kind
      const pid = (f as unknown as { parentId: string }).parentId
      if (kind === 'topicMessage') {
        if (!topicIds.has(pid)) fail(`baseline apply frame parent topic unknown/tombstoned "${pid}"`)
        if (suppressedForFrame.has(`topic:${pid}`)) fail(`baseline apply frame parent topic tombstoned "${pid}"`)
      } else {
        if (!messageIds.has(pid)) fail(`baseline apply frame parent message unknown/tombstoned "${pid}"`)
        if (suppressedForFrame.has(`message:${pid}`)) fail(`baseline apply frame parent message tombstoned "${pid}"`)
      }
    }
    const messagesByTopic = new Map<
      string,
      Array<{ id: string; membership: { timestamp: number; operationId: string } }>
    >()
    for (const e of candidate.entities) {
      if (e.entityType === 'message') {
        if (suppressedForFrame.has(`message:${e.entityId}`)) continue
        const tid = e.payload.topicId as string
        const pm = e.parentMembershipClock as { timestamp: number; operationId: string }
        const arr = messagesByTopic.get(tid) ?? []
        arr.push({ id: e.entityId, membership: pm })
        messagesByTopic.set(tid, arr)
      }
    }
    const blocksByMessage = new Map<
      string,
      Array<{ id: string; membership: { timestamp: number; operationId: string } }>
    >()
    for (const e of candidate.entities) {
      if (e.entityType === 'message_block') {
        if (suppressedForFrame.has(`message_block:${e.entityId}`)) continue
        const mid = e.payload.messageId as string
        if (suppressedForFrame.has(`message:${mid}`)) continue
        const pm = e.parentMembershipClock as { timestamp: number; operationId: string }
        const arr = blocksByMessage.get(mid) ?? []
        arr.push({ id: e.entityId, membership: pm })
        blocksByMessage.set(mid, arr)
      }
    }
    for (const f of frames as unknown as Array<{
      kind: string
      parentId: string
      orderedChildIds: string[]
      frameClock: { timestamp: number; operationId: string }
    }>) {
      const isTopic = f.kind === 'topicMessage'
      const liveChildren = isTopic ? (messagesByTopic.get(f.parentId) ?? []) : (blocksByMessage.get(f.parentId) ?? [])
      const liveIdSet = new Set(liveChildren.map((c) => c.id))
      if (f.orderedChildIds.length !== liveIdSet.size) {
        fail(
          `baseline apply orderedChildIds length ${f.orderedChildIds.length} != live children ${liveIdSet.size} for parent ${f.parentId}`
        )
      }
      for (const cid of f.orderedChildIds) {
        if (!liveIdSet.has(cid))
          fail(`baseline apply orderedChildIds contains unknown/deleted child "${cid}" for parent ${f.parentId}`)
      }
      if (new Set(f.orderedChildIds).size !== f.orderedChildIds.length) fail('baseline apply duplicate orderedChildIds')
      const childMembershipById = new Map<string, { timestamp: number; operationId: string }>()
      for (const c of liveChildren) childMembershipById.set(c.id, c.membership)
      let seenGreater = false
      const suffix: Array<{ id: string; clock: { timestamp: number; operationId: string } }> = []
      for (let idx = 0; idx < f.orderedChildIds.length; idx++) {
        const childId = f.orderedChildIds[idx]
        const mem = childMembershipById.get(childId)!
        const cmpLex =
          mem.timestamp !== f.frameClock.timestamp
            ? mem.timestamp - f.frameClock.timestamp
            : compareUtf8ByteLex(mem.operationId, f.frameClock.operationId)
        const isGreater = cmpLex > 0
        if (isGreater) {
          seenGreater = true
          suffix.push({ id: childId, clock: mem })
        } else {
          if (seenGreater) {
            fail(
              `baseline apply membershipClock suffix violation: covered child "${childId}" after greater-than-frame child for parent ${f.parentId}`
            )
          }
        }
      }
      const expectedSuffix = [...suffix].sort((a, b) => {
        const c =
          a.clock.timestamp !== b.clock.timestamp
            ? a.clock.timestamp - b.clock.timestamp
            : compareUtf8ByteLex(a.clock.operationId, b.clock.operationId)
        if (c !== 0) return c
        return compareUtf8ByteLex(a.id, b.id)
      })
      for (let i = 0; i < suffix.length; i++) {
        if (suffix[i].id !== expectedSuffix[i].id) {
          fail(`baseline apply membershipClock suffix not sorted deterministically for parent ${f.parentId}`)
        }
      }
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
  membershipByKey: Map<string, { parentId: string; timestamp: number; operationId: string }>
}

function loadLocalClocks(tx: BaselineTx): LocalClocks {
  const entityClockByKey = new Map<string, { timestamp: number; operationId: string }>()
  for (const row of tx.select().from(schema.syncEntityClock).all()) {
    const key = `${row.entityType}:${row.entityId}`
    if (entityClockByKey.has(key)) continue
    if (!isValidTimestamp(row.timestamp)) {
      fail(`baseline apply malformed local entity clock for ${key}`)
    }
    if (typeof row.entityId !== 'string' || row.entityId.length === 0 || !isValidUnicodeScalarString(row.entityId)) {
      fail(`baseline apply malformed local entity clock id for ${key}`)
    }
    try {
      const parsed = parseSyncOperationIdShape(row.operationId)
      if (!isValidUnicodeScalarString(parsed)) {
        throw new Error(`malformed operationId unicode scalar for ${key}`)
      }
    } catch (e) {
      fail(`baseline apply malformed local entity clock op for ${key}`, e)
    }
    entityClockByKey.set(key, { timestamp: row.timestamp, operationId: row.operationId })
  }
  const fieldClockByKey = new Map<string, Map<string, { timestamp: number; operationId: string }>>()
  for (const row of tx.select().from(schema.syncFieldClock).all()) {
    if (row.field === 'sortOrder') continue // E: legacy sortOrder ignored
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
    if (typeof row.entityId !== 'string' || row.entityId.length === 0 || !isValidUnicodeScalarString(row.entityId)) {
      fail(`baseline apply malformed local field clock id for ${key}/${row.field}`)
    }
    try {
      const parsed = parseSyncOperationIdShape(row.operationId)
      if (!isValidUnicodeScalarString(parsed)) {
        throw new Error(`malformed operationId unicode scalar for ${key}/${row.field}`)
      }
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
    if (!entityType || entityId.length === 0 || !isValidUnicodeScalarString(entityId))
      fail('baseline apply malformed local tombstone key')
    if (row.value === null || row.value === undefined) {
      fail(`baseline apply malformed local tombstone value for ${entityType}/${entityId}: missing`)
    }
    let parsed: { timestamp: number; operationId: string | null }
    try {
      const result = parseSyncTombstoneValue(row.value)
      if (!result) fail(`baseline apply malformed local tombstone for ${entityType}/${entityId}`)
      if (result.operationId !== null && !isValidUnicodeScalarString(result.operationId)) {
        throw new Error(`malformed tombstone operationId unicode scalar for ${entityType}/${entityId}`)
      }
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
  const membershipByKey = new Map<string, { parentId: string; timestamp: number; operationId: string }>()
  for (const row of tx.select().from(schema.syncMembershipClock).all()) {
    const key = `${row.childEntityType}:${row.childEntityId}`
    if (membershipByKey.has(key)) continue
    if (row.childEntityType !== 'message' && row.childEntityType !== 'message_block') {
      fail(`baseline apply malformed local membership child type for ${key}`)
    }
    if (
      typeof row.childEntityId !== 'string' ||
      row.childEntityId.length === 0 ||
      !isValidUnicodeScalarString(row.childEntityId)
    ) {
      fail(`baseline apply malformed local membership child id for ${key}`)
    }
    if (typeof row.parentId !== 'string' || row.parentId.length === 0 || !isValidUnicodeScalarString(row.parentId)) {
      fail(`baseline apply malformed local membership parent for ${key}`)
    }
    if (!isValidTimestamp(row.timestamp)) {
      fail(`baseline apply malformed local membership timestamp for ${key}`)
    }
    try {
      const parsed = parseSyncOperationIdShape(row.operationId)
      if (!isValidUnicodeScalarString(parsed)) {
        throw new Error(`malformed operationId unicode scalar for ${key}`)
      }
    } catch (e) {
      fail(`baseline apply malformed local membership op for ${key}`, e)
    }
    membershipByKey.set(key, { parentId: row.parentId, timestamp: row.timestamp, operationId: row.operationId })
  }
  return { entityClockByKey, fieldClockByKey, tombstoneByKey, membershipByKey }
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
  return record[field] ?? null
}

function blockLocalFieldValue(row: typeof schema.messageBlocks.$inferSelect, field: string): unknown {
  const record = row as unknown as Record<string, unknown>
  return record[field] ?? null
}

function incomingTombstoneBeatsLocal(
  incomingTs: number,
  incomingOp: string | null,
  localTs: number,
  localOp: string | null
): boolean {
  return (
    compareDeletionClock(
      { timestamp: incomingTs, operationId: incomingOp },
      { timestamp: localTs, operationId: localOp }
    ) > 0
  )
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

function upsertMembershipClock(
  tx: BaselineTx,
  childEntityType: 'message' | 'message_block',
  childEntityId: string,
  parentId: string,
  timestamp: number,
  operationId: string,
  local: Map<string, { parentId: string; timestamp: number; operationId: string }>
): void {
  const key = `${childEntityType}:${childEntityId}`
  const existing = local.get(key)
  if (existing) {
    if (existing.parentId !== parentId) {
      fail(
        `baseline apply membership parent conflict for ${childEntityType}/${childEntityId}: retained ${existing.parentId} vs incoming ${parentId}`
      )
    }
    if (existing.timestamp === timestamp && existing.operationId === operationId) return
    fail(
      `baseline apply membership clock conflict for ${childEntityType}/${childEntityId}: retained (${existing.timestamp}:${existing.operationId}) vs incoming (${timestamp}:${operationId})`
    )
  }
  tx.insert(schema.syncMembershipClock)
    .values({ childEntityType, childEntityId, parentId, timestamp, operationId })
    .run()
  local.set(key, { parentId, timestamp, operationId })
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
export interface ValidatedBaselineMergeInput {
  entities: LocalSyncBaselineEntity[]
  tombstones: LocalSyncBaselineTombstone[]
  orderFrames: LocalSyncBaselineOrderFrame[]
}

/**
 * Validated merge core runnable inside a caller-owned SQLite transaction.
 * Takes already-validated normalized entities/tombstones/frames and merges
 * them with the existing LWW/merge rules. Never opens its own transaction;
 * never writes `sync_applied`, `sync_outbox`, cursor/channel, or conflict
 * state. The caller owns the atomic boundary (e.g. bootstrap cursor commit).
 */
export function mergeValidatedBaselineInTx(
  tx: BaselineTx,
  input: ValidatedBaselineMergeInput
): LocalSyncBaselineApplyResult {
  const inner = tx as unknown as BaselineTx

  const incomingEntityByKey = new Map<string, LocalSyncBaselineEntity>()
  for (const entity of input.entities) incomingEntityByKey.set(`${entity.entityType}:${entity.entityId}`, entity)
  const incomingTombByKey = new Map<string, LocalSyncBaselineTombstone>()
  for (const tomb of input.tombstones) incomingTombByKey.set(`${tomb.entityType}:${tomb.entityId}`, tomb)

  const result: LocalSyncBaselineApplyResult = { inserted: 0, updated: 0, deleted: 0, suppressed: 0, unchanged: 0 }
  const { entityClockByKey, fieldClockByKey, tombstoneByKey, membershipByKey } = loadLocalClocks(inner)
  // Track affected parents for fixed-point materialization
  const affectedParents = new Set<string>()
  // Load local frames for LWW with centralized strict validation (A3)
  const localFrames = new Map<
    string,
    {
      kind: string
      parentId: string
      frameVersion: string
      orderedChildIds: string[]
      timestamp: number
      operationId: string
    }
  >()
  try {
    const rows = inner.select().from(schema.syncParentOrderFrame).all()
    for (const r of rows) {
      const key = `${r.kind}:${r.parentId}`
      let validated: {
        kind: 'topicMessage' | 'messageBlock'
        parentId: string
        orderedChildIds: string[]
        timestamp: number
        operationId: string
      }
      try {
        validated = validateFrameRowStrict(
          {
            kind: r.kind,
            parentId: r.parentId,
            frameVersion: r.frameVersion,
            orderedChildIdsJson: r.orderedChildIdsJson,
            timestamp: r.timestamp,
            operationId: r.operationId
          },
          `persisted-frame/${key}`
        )
      } catch (e) {
        throw new SyncBaselineApplyError(
          `persisted frame malformed for ${key}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e }
        )
      }
      localFrames.set(key, {
        kind: validated.kind,
        parentId: validated.parentId,
        frameVersion: 'parent-order-frame-v1',
        orderedChildIds: validated.orderedChildIds,
        timestamp: validated.timestamp,
        operationId: validated.operationId
      })
    }
  } catch (e) {
    if (e instanceof SyncBaselineApplyError) throw e
    const msg = e instanceof Error ? e.message : String(e)
    if (/no such table/i.test(msg)) {
      // pre-010 table missing is allowed; treat as empty
    } else {
      throw e
    }
  }

  // --- Persisted target frame parent/liveness validation on load (every row) ---
  {
    const toPurge = new Set<string>()
    for (const [key, frame] of [...localFrames.entries()]) {
      const kind = frame.kind
      const parentId = frame.parentId
      const topicExists = !!inner.select().from(schema.topics).where(eq(schema.topics.id, parentId)).get()
      const messageExists = !!inner.select().from(schema.messages).where(eq(schema.messages.id, parentId)).get()
      const blockExists = !!inner.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, parentId)).get()
      if (kind === 'topicMessage') {
        if (messageExists || blockExists) {
          throw new SyncBaselineApplyError(
            'persisted wrong-kind frame parent for topicMessage/' +
              parentId +
              ': known parent is ' +
              (messageExists ? 'message' : 'message_block')
          )
        }
        if (!topicExists) {
          const tomb = tombstoneByKey.get('topic:' + parentId)
          const liveClock = entityClockByKey.get('topic:' + parentId)
          let tombWins = false
          if (tomb) {
            if (liveClock) tombWins = isTombstoneWinningOverLive(tomb, liveClock)
            else tombWins = true
          }
          if (tombWins) {
            toPurge.add(key)
            continue
          }
          throw new SyncBaselineApplyError(
            'persisted orphan frame for topicMessage/' + parentId + ' with no business row or tombstone'
          )
        }
        const tomb = tombstoneByKey.get('topic:' + parentId)
        const liveClock = entityClockByKey.get('topic:' + parentId)
        if (tomb && liveClock && isTombstoneWinningOverLive(tomb, liveClock)) {
          toPurge.add(key)
          continue
        }
      } else {
        if (topicExists || blockExists) {
          const wrong = topicExists ? 'topic' : 'message_block'
          throw new SyncBaselineApplyError(
            'persisted wrong-kind frame parent for messageBlock/' + parentId + ': known parent is ' + wrong
          )
        }
        if (!messageExists) {
          const tomb = tombstoneByKey.get('message:' + parentId)
          const liveClock = entityClockByKey.get('message:' + parentId)
          let tombWins = false
          if (tomb) {
            if (liveClock) tombWins = isTombstoneWinningOverLive(tomb, liveClock)
            else tombWins = true
          }
          if (tombWins) {
            toPurge.add(key)
            continue
          }
          throw new SyncBaselineApplyError(
            'persisted orphan frame for messageBlock/' + parentId + ' with no business row or tombstone'
          )
        }
        const msgRow = inner.select().from(schema.messages).where(eq(schema.messages.id, parentId)).get()
        if (msgRow && !isStableMessageStatus(msgRow.status)) {
          toPurge.add(key)
          continue
        }
        const tomb = tombstoneByKey.get('message:' + parentId)
        const liveClock = entityClockByKey.get('message:' + parentId)
        if (tomb && liveClock && isTombstoneWinningOverLive(tomb, liveClock)) {
          toPurge.add(key)
          continue
        }
      }
    }
    for (const k of toPurge) {
      const fr = localFrames.get(k)
      if (!fr) continue
      inner
        .delete(schema.syncParentOrderFrame)
        .where(
          and(eq(schema.syncParentOrderFrame.kind, fr.kind), eq(schema.syncParentOrderFrame.parentId, fr.parentId))
        )
        .run()
      localFrames.delete(k)
    }
  }

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
  for (const entity of input.entities) {
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

    // Membership clock handling for non-suppressed message/message_block.
    // Complete candidates carry non-null parentMembershipClock; suppressed lives already continued above.
    if (entity.entityType === 'message' || entity.entityType === 'message_block') {
      const pm = (entity as unknown as { parentMembershipClock?: unknown }).parentMembershipClock as
        | { parentId: string; timestamp: number; operationId: string }
        | null
        | undefined
      // Pure validation already guaranteed non-null for complete, but fail closed if missing here.
      if (!pm || typeof pm !== 'object' || typeof (pm as { parentId?: unknown }).parentId !== 'string') {
        fail(`baseline apply missing parent membership for ${entity.entityId}`)
      }
      // parentId is mandatory and must equal payload parent; no fallback to payload-only
      if (typeof pm.parentId !== 'string' || !isValidOrdinaryId(pm.parentId)) {
        fail(`baseline apply malformed parentId for ${entity.entityId}`)
      }
      requireOrdinaryId(pm.parentId, `${entity.entityType}/${entity.entityId} parentId`)
      const payloadParentId =
        entity.entityType === 'message' ? (payload.topicId as string) : (payload.messageId as string)
      if (pm.parentId !== payloadParentId) {
        fail(
          `baseline apply parentId mismatch for ${entity.entityId}: membership ${pm.parentId} vs payload ${payloadParentId}`
        )
      }
      upsertMembershipClock(
        inner,
        entity.entityType,
        entity.entityId,
        pm.parentId,
        pm.timestamp,
        pm.operationId,
        membershipByKey
      )
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
          } else if (compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0) {
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
        const sortOrder = 0 // provisional, materialization will write dense
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
        affectedParents.add(`topicMessage:${topicId}`)
        result.inserted += 1
        continue
      }
      if (local.topicId !== topicId) {
        fail(`baseline apply immutable message parent mismatch for ${entity.entityId}: ${local.topicId} vs ${topicId}`)
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
        const incomingVal: unknown = (payload[field] ?? null) as unknown
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
          } else if (compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0) {
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
        affectedParents.add(`topicMessage:${topicId}`)
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
      affectedParents.add(`topicMessage:${topicId}`)
      result.updated += 1
      continue
    }

    // message_block
    {
      const messageId = payload.messageId as string
      const local = inner.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, entity.entityId)).get()
      if (!local) {
        const parentRow = inner.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get()
        if (!parentRow && !insertedMessageIds.has(messageId)) {
          fail(`baseline apply orphan block ${entity.entityId} parent ${messageId} missing`)
        }
        const sortOrder = 0 // provisional
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
        affectedParents.add(`messageBlock:${messageId}`)
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
        const incomingVal: unknown = (payload[field] ?? null) as unknown
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
          } else if (compareLww(incomingFc.timestamp, incomingFc.operationId, prior.timestamp, prior.operationId) > 0) {
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
        affectedParents.add(`messageBlock:${messageId}`)
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
      affectedParents.add(`messageBlock:${messageId}`)
      result.updated += 1
      continue
    }
  }

  // Tombstone application comes before frame merge so that liveness is final.
  // Apply winning tombstones with cascade/containment. F2 runs before the
  // winning check so any tombstone targeting unversioned live fails closed
  // regardless of strength; whole transaction rolls back.
  // Capture affected parents for each winning delete before row removal.
  const tombstoneAffectedParents = new Set<string>()
  for (const tomb of input.tombstones) {
    const key = `${tomb.entityType}:${tomb.entityId}`
    requireVersionedLiveForTombstone(inner, tomb.entityType, tomb.entityId, entityClockByKey)
    if (!winningTombKeys.has(key)) {
      result.suppressed += 1
      continue
    }
    if (tomb.entityType === 'topic') {
      // Capture child messages before delete for containment tombstones and frame cleanup
      const childIds: string[] = inner
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.topicId, tomb.entityId))
        .all()
        .map((r) => r.id)
      // Capture membership parent for each child to know descendant blocks? Use membership map
      const existing = inner.select().from(schema.topics).where(eq(schema.topics.id, tomb.entityId)).get()
      if (existing) {
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
        // Mark descendant block frames for removal; they will be cleaned after frame merge
        tombstoneAffectedParents.add(`messageBlock:${mid}`)
      }
      tombstoneAffectedParents.add(`topicMessage:${tomb.entityId}`)
      // Also mark topic's own frame for removal
      affectedParents.add(`topicMessage:${tomb.entityId}`)
      for (const mid of childIds) affectedParents.add(`messageBlock:${mid}`)
    } else if (tomb.entityType === 'message') {
      // Capture parent topic before delete for fixed-point
      const existing = inner.select().from(schema.messages).where(eq(schema.messages.id, tomb.entityId)).get()
      const topicIdForCleanup = existing?.topicId ?? membershipByKey.get(`message:${tomb.entityId}`)?.parentId ?? null
      // Capture before delete for affectedParents
      if (topicIdForCleanup) affectedParents.add(`topicMessage:${topicIdForCleanup}`)
      affectedParents.add(`messageBlock:${tomb.entityId}`)
      tombstoneAffectedParents.add(`messageBlock:${tomb.entityId}`)
      if (topicIdForCleanup) tombstoneAffectedParents.add(`topicMessage:${topicIdForCleanup}`)
      if (existing) {
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
      // message_block
      const existing = inner.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, tomb.entityId)).get()
      const parentMessageId =
        existing?.messageId ?? membershipByKey.get(`message_block:${tomb.entityId}`)?.parentId ?? null
      if (parentMessageId) {
        affectedParents.add(`messageBlock:${parentMessageId}`)
        tombstoneAffectedParents.add(`messageBlock:${parentMessageId}`)
      }
      if (existing) {
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

  // Merge winning frames with normalized-baseline semantics (B).
  // After entity/tombstone/membership merge, evaluate existing local raw winner's semantic effective
  // sequence under merged live state. Higher clock wins (persist incoming normalized), lower loses
  // (keep existing), equal clock: compare semantic effective sequences under merged state; if equal
  // accept idempotently (optionally normalize stored row while retaining clock), if divergent fail closed.
  // This is arrival-order independent because effective is always re-derived from the selected raw winner.
  for (const frame of input.orderFrames) {
    const key = `${frame.kind}:${frame.parentId}`
    // Skip persisting frame for tombstoned (deleted) parents where tombstone actually wins over live
    const parentEntityType = frame.kind === 'topicMessage' ? 'topic' : 'message'
    const parentKey = `${parentEntityType}:${frame.parentId}`
    const parentLiveClock = entityClockByKey.get(parentKey)
    const parentTomb = tombstoneByKey.get(parentKey)
    let parentIsLive = false
    if (parentTomb && parentLiveClock) {
      // Check if tombstone actually wins over live
      if (isTombstoneWinningOverLive(parentTomb, parentLiveClock)) parentIsLive = false
      else parentIsLive = true
    } else if (parentTomb && !parentLiveClock) {
      // No live row but tombstone exists => deleted (no frame)
      parentIsLive = false
    } else {
      // Check if parent row exists
      let exists = false
      if (frame.kind === 'topicMessage')
        exists = !!inner.select().from(schema.topics).where(eq(schema.topics.id, frame.parentId)).get()
      else exists = !!inner.select().from(schema.messages).where(eq(schema.messages.id, frame.parentId)).get()
      parentIsLive = exists
    }
    if (!parentIsLive) {
      // Ensure no frame remains for deleted parent
      inner
        .delete(schema.syncParentOrderFrame)
        .where(
          and(
            eq(schema.syncParentOrderFrame.kind, frame.kind),
            eq(schema.syncParentOrderFrame.parentId, frame.parentId)
          )
        )
        .run()
      localFrames.delete(key)
      affectedParents.delete(key)
      continue
    }
    const existing = localFrames.get(key)
    if (!existing) {
      inner
        .insert(schema.syncParentOrderFrame)
        .values({
          kind: frame.kind,
          parentId: frame.parentId,
          frameVersion: frame.frameVersion,
          orderedChildIdsJson: JSON.stringify(frame.orderedChildIds),
          timestamp: frame.frameClock.timestamp,
          operationId: frame.frameClock.operationId
        })
        .run()
      // High-water (SYNC-DATA-048): every accepted winning-frame persist
      // advances the per-parent mark in the same merge tx, so a later local
      // invalidate + re-mint can never reuse this timestamp.
      advanceFrameHighWater(inner, frame.kind, frame.parentId, frame.frameClock.timestamp)
      localFrames.set(key, {
        kind: frame.kind,
        parentId: frame.parentId,
        frameVersion: frame.frameVersion,
        orderedChildIds: [...frame.orderedChildIds],
        timestamp: frame.frameClock.timestamp,
        operationId: frame.frameClock.operationId
      })
      affectedParents.add(key)
      continue
    }
    const cmp = compareLww(
      frame.frameClock.timestamp,
      frame.frameClock.operationId,
      existing.timestamp,
      existing.operationId
    )
    if (cmp > 0) {
      inner
        .insert(schema.syncParentOrderFrame)
        .values({
          kind: frame.kind,
          parentId: frame.parentId,
          frameVersion: frame.frameVersion,
          orderedChildIdsJson: JSON.stringify(frame.orderedChildIds),
          timestamp: frame.frameClock.timestamp,
          operationId: frame.frameClock.operationId
        })
        .onConflictDoUpdate({
          target: [schema.syncParentOrderFrame.kind, schema.syncParentOrderFrame.parentId],
          set: {
            frameVersion: frame.frameVersion,
            orderedChildIdsJson: JSON.stringify(frame.orderedChildIds),
            timestamp: frame.frameClock.timestamp,
            operationId: frame.frameClock.operationId
          }
        })
        .run()
      advanceFrameHighWater(inner, frame.kind, frame.parentId, frame.frameClock.timestamp)
      localFrames.set(key, {
        kind: frame.kind,
        parentId: frame.parentId,
        frameVersion: frame.frameVersion,
        orderedChildIds: [...frame.orderedChildIds],
        timestamp: frame.frameClock.timestamp,
        operationId: frame.frameClock.operationId
      })
      affectedParents.add(key)
    } else if (cmp < 0) {
      // Lower loses, keep existing but still mark affected for fixed-point
      affectedParents.add(key)
    } else {
      // Equal clock: compare semantic effective sequences under merged live state
      // Build liveChildren for this parent strictly (fail if any live child missing membership)
      const buildLiveStrict = (
        kind: 'topicMessage' | 'messageBlock',
        parentId: string
      ): Map<string, { timestamp: number; operationId: string }> => {
        if (kind === 'topicMessage') {
          const rows = inner
            .select({ id: schema.messages.id })
            .from(schema.messages)
            .where(eq(schema.messages.topicId, parentId))
            .all()
          const map = new Map<string, { timestamp: number; operationId: string }>()
          for (const r of rows) {
            const mem = membershipByKey.get(`message:${r.id}`)
            if (!mem || mem.parentId !== parentId)
              fail(`baseline apply missing valid membership for live message ${r.id} under ${parentId}`)
            const msgRow = inner.select().from(schema.messages).where(eq(schema.messages.id, r.id)).get()
            if (!msgRow || !isStableMessageStatus(msgRow.status)) continue
            map.set(r.id, { timestamp: mem.timestamp, operationId: mem.operationId })
          }
          return map
        } else {
          const rows = inner
            .select({ id: schema.messageBlocks.id })
            .from(schema.messageBlocks)
            .where(eq(schema.messageBlocks.messageId, parentId))
            .all()
          const map = new Map<string, { timestamp: number; operationId: string }>()
          for (const r of rows) {
            const mem = membershipByKey.get(`message_block:${r.id}`)
            if (!mem || mem.parentId !== parentId)
              fail(`baseline apply missing valid membership for live block ${r.id} under ${parentId}`)
            const blkRow = inner.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, r.id)).get()
            if (!blkRow || !isStableBlockStatus(blkRow.status)) continue
            let overflow: Record<string, unknown> = {}
            try {
              overflow = blkRow.extra ? (JSON.parse(blkRow.extra) as Record<string, unknown>) : {}
            } catch {}
            if (isUnsupportedBlockForSync({ type: blkRow.type, overflow })) continue
            map.set(r.id, { timestamp: mem.timestamp, operationId: mem.operationId })
          }
          return map
        }
      }
      const liveMap = buildLiveStrict(frame.kind, frame.parentId)
      const childParentLookup = (cid: string): { parentId: string | null; exists: boolean } | null => {
        if (frame.kind === 'topicMessage') {
          const row = inner.select().from(schema.messages).where(eq(schema.messages.id, cid)).get()
          if (!row) return { parentId: null, exists: false }
          const mem = membershipByKey.get(`message:${cid}`)
          if (mem) return { parentId: mem.parentId, exists: true }
          return { parentId: row.topicId, exists: true }
        } else {
          const row = inner.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, cid)).get()
          if (!row) return { parentId: null, exists: false }
          const mem = membershipByKey.get(`message_block:${cid}`)
          if (mem) return { parentId: mem.parentId, exists: true }
          return { parentId: row.messageId, exists: true }
        }
      }
      let existingEffective: string[]
      let incomingEffective: string[]
      try {
        const exEval = evaluateEffectiveOrder({
          kind: frame.kind,
          parentId: frame.parentId,
          orderedChildIds: existing.orderedChildIds,
          frameClock: { timestamp: existing.timestamp, operationId: existing.operationId },
          liveChildren: liveMap,
          childParentLookup
        })
        existingEffective = exEval.effective
      } catch (e) {
        fail(
          `baseline apply frame parent mismatch for ${key} existing: ${e instanceof Error ? e.message : String(e)}`,
          e
        )
      }
      try {
        const incEval = evaluateEffectiveOrder({
          kind: frame.kind,
          parentId: frame.parentId,
          orderedChildIds: frame.orderedChildIds,
          frameClock: { timestamp: frame.frameClock.timestamp, operationId: frame.frameClock.operationId },
          liveChildren: liveMap,
          childParentLookup
        })
        incomingEffective = incEval.effective
      } catch (e) {
        fail(
          `baseline apply frame parent mismatch for ${key} incoming: ${e instanceof Error ? e.message : String(e)}`,
          e
        )
      }
      if (JSON.stringify(existingEffective) !== JSON.stringify(incomingEffective)) {
        fail(
          `baseline apply frame clock conflict for ${key}: equal clock with semantically divergent effective content`
        )
      }
      // Idempotent: optionally normalize stored row to incoming normalized (retain clock)
      if (JSON.stringify(existing.orderedChildIds) !== JSON.stringify(frame.orderedChildIds)) {
        inner
          .insert(schema.syncParentOrderFrame)
          .values({
            kind: frame.kind,
            parentId: frame.parentId,
            frameVersion: frame.frameVersion,
            orderedChildIdsJson: JSON.stringify(frame.orderedChildIds),
            timestamp: existing.timestamp,
            operationId: existing.operationId
          })
          .onConflictDoUpdate({
            target: [schema.syncParentOrderFrame.kind, schema.syncParentOrderFrame.parentId],
            set: { orderedChildIdsJson: JSON.stringify(frame.orderedChildIds) }
          })
          .run()
        advanceFrameHighWater(inner, frame.kind, frame.parentId, existing.timestamp)
        localFrames.set(key, { ...existing, orderedChildIds: [...frame.orderedChildIds] })
      }
      affectedParents.add(key)
    }
  }

  // Clean up frames for tombstoned parents that may have been missed (winning tombstones)
  for (const tomb of input.tombstones) {
    const k = `${tomb.entityType}:${tomb.entityId}`
    if (!winningTombKeys.has(k)) continue
    if (tomb.entityType === 'topic') {
      inner
        .delete(schema.syncParentOrderFrame)
        .where(
          and(
            eq(schema.syncParentOrderFrame.kind, 'topicMessage'),
            eq(schema.syncParentOrderFrame.parentId, tomb.entityId)
          )
        )
        .run()
      localFrames.delete(`topicMessage:${tomb.entityId}`)
      affectedParents.delete(`topicMessage:${tomb.entityId}`)
      // Descendant messageBlock frames already handled via tombstoneAffectedParents
      for (const kk of [...tombstoneAffectedParents]) {
        if (kk.startsWith('messageBlock:')) {
          const mid = kk.slice('messageBlock:'.length)
          inner
            .delete(schema.syncParentOrderFrame)
            .where(
              and(eq(schema.syncParentOrderFrame.kind, 'messageBlock'), eq(schema.syncParentOrderFrame.parentId, mid))
            )
            .run()
          localFrames.delete(kk)
          affectedParents.delete(kk)
        }
      }
    } else if (tomb.entityType === 'message') {
      inner
        .delete(schema.syncParentOrderFrame)
        .where(
          and(
            eq(schema.syncParentOrderFrame.kind, 'messageBlock'),
            eq(schema.syncParentOrderFrame.parentId, tomb.entityId)
          )
        )
        .run()
      localFrames.delete(`messageBlock:${tomb.entityId}`)
      affectedParents.delete(`messageBlock:${tomb.entityId}`)
    }
  }

  // Fixed-point re-evaluation and dense sortOrder materialization for every affected parent (C)
  // C1: enumerate ALL live stable/inventory-supported children; if any lacks valid matching membership clock, fail closed before materializing
  // C2: absence never deletes local-only children; versioned local-only with membership > frameClock append deterministically, <= missing from winner => incomplete => fail
  // C3: every structurally affected parent already collected in affectedParents (child create/update, block tombstone parent, message tombstone parent+own block, topic cascade, reappearance)
  // C4/C5: liveness via actual winner between live entity clock and tombstone deletion clock (null barrier, UTF-8 lex); only winning tombstone deletes frame, live parent requires winning frame, empty child set materializes empty
  const loadLiveChildrenForTopicStrict = (topicId: string): Map<string, { timestamp: number; operationId: string }> => {
    const rows = inner
      .select({ id: schema.messages.id, status: schema.messages.status })
      .from(schema.messages)
      .where(eq(schema.messages.topicId, topicId))
      .all()
    const map = new Map<string, { timestamp: number; operationId: string }>()
    for (const r of rows as Array<{ id: string; status: string | null }>) {
      if (!isStableMessageStatus(r.status)) continue
      const mem = membershipByKey.get(`message:${r.id}`)
      if (!mem || mem.parentId !== topicId)
        fail(`baseline apply missing valid membership for live message ${r.id} under topic ${topicId}`)
      // Validate membership clock shape strictly
      try {
        validateFrameRowStrict(
          {
            kind: 'topicMessage',
            parentId: topicId,
            frameVersion: 'parent-order-frame-v1',
            orderedChildIdsJson: '[]',
            timestamp: mem.timestamp,
            operationId: mem.operationId
          },
          `membership/${r.id}`
        )
      } catch (e) {
        fail(
          `baseline apply malformed membership clock for message/${r.id}: ${e instanceof Error ? e.message : String(e)}`,
          e
        )
      }
      map.set(r.id, { timestamp: mem.timestamp, operationId: mem.operationId })
    }
    return map
  }
  const loadLiveChildrenForMessageStrict = (
    messageId: string
  ): Map<string, { timestamp: number; operationId: string }> => {
    const rows = inner
      .select({
        id: schema.messageBlocks.id,
        status: schema.messageBlocks.status,
        type: schema.messageBlocks.type,
        extra: schema.messageBlocks.extra
      })
      .from(schema.messageBlocks)
      .where(eq(schema.messageBlocks.messageId, messageId))
      .all()
    const map = new Map<string, { timestamp: number; operationId: string }>()
    for (const r of rows as Array<{ id: string; status: string | null; type: string | null; extra: string | null }>) {
      if (!isStableBlockStatus(r.status)) continue
      let overflow: Record<string, unknown> = {}
      try {
        overflow = r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : {}
      } catch (e) {
        fail(`baseline apply malformed block extra for ${r.id}: ${e instanceof Error ? e.message : String(e)}`, e)
      }
      if (isUnsupportedBlockForSync({ type: r.type, overflow })) continue
      const mem = membershipByKey.get(`message_block:${r.id}`)
      if (!mem || mem.parentId !== messageId)
        fail(`baseline apply missing valid membership for live block ${r.id} under message ${messageId}`)
      try {
        validateFrameRowStrict(
          {
            kind: 'messageBlock',
            parentId: messageId,
            frameVersion: 'parent-order-frame-v1',
            orderedChildIdsJson: '[]',
            timestamp: mem.timestamp,
            operationId: mem.operationId
          },
          `membership/${r.id}`
        )
      } catch (e) {
        fail(
          `baseline apply malformed membership clock for block/${r.id}: ${e instanceof Error ? e.message : String(e)}`,
          e
        )
      }
      map.set(r.id, { timestamp: mem.timestamp, operationId: mem.operationId })
    }
    return map
  }
  for (const key of [...affectedParents]) {
    let kind: 'topicMessage' | 'messageBlock'
    let parentId: string
    if (key.startsWith('topicMessage:')) {
      kind = 'topicMessage'
      parentId = key.slice('topicMessage:'.length)
    } else if (key.startsWith('messageBlock:')) {
      kind = 'messageBlock'
      parentId = key.slice('messageBlock:'.length)
    } else {
      fail(`baseline apply malformed affected parent key ${JSON.stringify(key).slice(0, 80)}`)
    }
    const tKey = kind === 'topicMessage' ? `topic:${parentId}` : `message:${parentId}`
    // C4: determine actual liveness via winner between live entity clock and tombstone deletion clock
    const liveClock = entityClockByKey.get(tKey)
    const tomb = tombstoneByKey.get(tKey)
    let isLive = false
    let isTombstoneWinning = false
    if (tomb && liveClock) {
      if (isTombstoneWinningOverLive(tomb, liveClock)) {
        isLive = false
        isTombstoneWinning = true
      } else {
        isLive = true
        isTombstoneWinning = false
      }
    } else if (tomb && !liveClock) {
      // Check if parent row actually exists (hard delete without clock? but tombstone without live => deleted)
      let rowExists = false
      if (kind === 'topicMessage')
        rowExists = !!inner.select().from(schema.topics).where(eq(schema.topics.id, parentId)).get()
      else rowExists = !!inner.select().from(schema.messages).where(eq(schema.messages.id, parentId)).get()
      if (rowExists) {
        // Unversioned live row with tombstone => fail closed already handled in requireVersionedLiveForTombstone, but here treat as live winning? Actually F2 would have failed, but if we reach here, treat as tombstone not winning if no liveClock?
        // For safety, if row exists but no liveClock, we already failed earlier; but to be strict, consider tombstone not winning if liveClock missing? However C1 says unversioned live with tombstone fails closed, so we would have thrown.
        isLive = !rowExists
        isTombstoneWinning = rowExists ? false : true
      } else {
        isLive = false
        isTombstoneWinning = true
      }
    } else {
      let rowExists = false
      if (kind === 'topicMessage')
        rowExists = !!inner.select().from(schema.topics).where(eq(schema.topics.id, parentId)).get()
      else rowExists = !!inner.select().from(schema.messages).where(eq(schema.messages.id, parentId)).get()
      isLive = rowExists
    }
    if (isTombstoneWinning) {
      // C5: tombstoned/deleted parent removes persistent frame only when tombstone actually wins
      inner
        .delete(schema.syncParentOrderFrame)
        .where(and(eq(schema.syncParentOrderFrame.kind, kind), eq(schema.syncParentOrderFrame.parentId, parentId)))
        .run()
      localFrames.delete(key)
      continue
    }
    if (!isLive) {
      // Parent gone without winning tombstone (should not happen for complete candidate, but skip)
      inner
        .delete(schema.syncParentOrderFrame)
        .where(and(eq(schema.syncParentOrderFrame.kind, kind), eq(schema.syncParentOrderFrame.parentId, parentId)))
        .run()
      continue
    }
    const winning = localFrames.get(key)
    if (!winning) {
      fail(`baseline apply missing winning frame for live parent ${key}`)
    }
    // Validate persisted winning frame strictly (centralized) before evaluation
    try {
      validateFrameRowStrict(
        {
          kind: winning.kind,
          parentId: winning.parentId,
          frameVersion: winning.frameVersion,
          orderedChildIdsJson: JSON.stringify(winning.orderedChildIds),
          timestamp: winning.timestamp,
          operationId: winning.operationId
        },
        `persisted-frame/${key}`
      )
    } catch (e) {
      fail(`baseline apply malformed persisted frame for ${key}: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    const liveMap =
      kind === 'topicMessage' ? loadLiveChildrenForTopicStrict(parentId) : loadLiveChildrenForMessageStrict(parentId)
    const childParentLookup = (cid: string): { parentId: string | null; exists: boolean } | null => {
      if (kind === 'topicMessage') {
        const row = inner.select().from(schema.messages).where(eq(schema.messages.id, cid)).get()
        if (!row) return { parentId: null, exists: false }
        const mem = membershipByKey.get(`message:${cid}`)
        if (mem) return { parentId: mem.parentId, exists: true }
        return { parentId: row.topicId, exists: true }
      } else {
        const row = inner.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, cid)).get()
        if (!row) return { parentId: null, exists: false }
        const mem = membershipByKey.get(`message_block:${cid}`)
        if (mem) return { parentId: mem.parentId, exists: true }
        return { parentId: row.messageId, exists: true }
      }
    }
    let evaluation: ReturnType<typeof evaluateEffectiveOrder>
    try {
      evaluation = evaluateEffectiveOrder({
        kind,
        parentId,
        orderedChildIds: winning.orderedChildIds,
        frameClock: { timestamp: winning.timestamp, operationId: winning.operationId },
        liveChildren: liveMap,
        childParentLookup
      })
    } catch (e) {
      fail(`baseline apply frame parent mismatch for ${key}: ${e instanceof Error ? e.message : String(e)}`, e)
    }
    if (evaluation.incomplete) {
      fail(`baseline apply incomplete frame for ${key}: missing <= frameClock child ${evaluation.missingIds.join(',')}`)
    }
    // C2: materialize one dense 0..n-1 sequence covering every live inventory child
    const effective = evaluation.effective
    // Verify dense coverage: effective must cover all liveMap keys (incomplete already ensures <= missing, suffix ensures > included)
    if (effective.length !== liveMap.size)
      fail(`baseline apply effective length ${effective.length} != live children ${liveMap.size} for ${key}`)
    for (const id of liveMap.keys())
      if (!effective.includes(id)) fail(`baseline apply effective missing live child ${id} for ${key}`)
    for (let idx = 0; idx < effective.length; idx++) {
      const childId = effective[idx]
      if (kind === 'topicMessage')
        inner.update(schema.messages).set({ sortOrder: idx }).where(eq(schema.messages.id, childId)).run()
      else inner.update(schema.messageBlocks).set({ sortOrder: idx }).where(eq(schema.messageBlocks.id, childId)).run()
    }
  }

  return result
}

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
  let out: LocalSyncBaselineApplyResult | undefined
  db.transaction((tx) => {
    out = mergeValidatedBaselineInTx(tx as unknown as BaselineTx, {
      entities: candidate.entities,
      tombstones: candidate.tombstones,
      orderFrames: candidate.orderFrames
    })
  })
  if (!out) fail('baseline apply transaction produced no result')
  return out
}
