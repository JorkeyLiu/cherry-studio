/**
 * Pure local baseline wire `payload` projection.
 *
 * Maps a fully versioned, frame-aware `local-sync-baseline-v1` candidate
 * (`LocalSyncBaselineCandidate`) to the locked `sync-baseline-wire-v1`
 * `payload` object (`SyncPayload`). Transport-free: no relay persistence,
 * publish/fetch, barrier, receiver bootstrap, IPC, or UI.
 *
 * Rules (locked wire §10A.1 / SYNC-DATA-041..045 / SYNC-CC-021):
 * - Output is strictly the `payload` object, never an envelope.
 * - All local internal diagnostics are stripped: `pendingOutboxCount`,
 *   `observationBinding`, `observedLocalChannelKey`/`observedLocalCursor`,
 *   `unversioned`/`excluded`/`orphan`/`aggregate` counters, `reasons` /
 *   `completenessReasons`, local `kind`/`schemaVersion` envelope, and the
 *   local manifest digest. None of these enter the wire payload or digest.
 * - Only `complete` candidates project. `partial`/`unbound`, non-zero pending
 *   outbox, unbound observation, missing entity/field/membership clocks, or
 *   version mismatch fail closed.
 * - Entities/tombstones/orderFrames/manifest map completely with wire UTF-8
 *   byte-lex ordering. Protocol truth (exact keys, versions, clocks, closure,
 *   manifest recompute, JCS digest) is enforced by the existing shared
 *   `baselineWire` strict validator/canonicalizer/digest, never reimplemented.
 */

import { createHash } from 'node:crypto'

import {
  compareUtf8ByteLex,
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  INVENTORY_VERSION,
  type MessageBlockEntity,
  type MessageEntity,
  ORDER_FRAME_VERSION,
  type OrderFrame,
  PAYLOAD_SCHEMA,
  SCOPE,
  type SyncPayload,
  type Tombstone,
  type TopicEntity,
  validatePayload,
  ValidationError,
  verifySyncDigest
} from '@shared/sync'

import {
  LOCAL_SYNC_BASELINE_INVENTORY_VERSION,
  LOCAL_SYNC_BASELINE_KIND,
  LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION,
  LOCAL_SYNC_BASELINE_SCHEMA_VERSION,
  type LocalSyncBaselineCandidate
} from './syncBaseline'

export class SyncBaselineWireProjectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'SyncBaselineWireProjectionError'
  }
}

function fail(message: string, cause?: unknown): never {
  throw new SyncBaselineWireProjectionError(message, cause === undefined ? undefined : { cause })
}

const TOPIC_WIRE_FIELDS = [
  'name',
  'assistantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited'
] as const

const MESSAGE_WIRE_FIELDS = [
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

const BLOCK_WIRE_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt'] as const

type TopicWireField = (typeof TOPIC_WIRE_FIELDS)[number]
type MessageWireField = (typeof MESSAGE_WIRE_FIELDS)[number]
type BlockWireField = (typeof BLOCK_WIRE_FIELDS)[number]

function tombstoneRank(entityType: string): number {
  if (entityType === 'topic') return 0
  if (entityType === 'message') return 1
  return 2
}

function frameRank(kind: string): number {
  return kind === 'topicMessage' ? 0 : 1
}

function hashHex(canonicalUtf8: Uint8Array): string {
  return createHash('sha256').update(canonicalUtf8).digest('hex')
}

/**
 * Project a complete local baseline candidate to the locked wire `payload`.
 * Self-validates via the shared strict `validatePayload` before returning.
 * Throws `SyncBaselineWireProjectionError` (with `ValidationError` cause where
 * applicable) for any illegal or incomplete candidate.
 */
export function projectLocalBaselineToWirePayload(candidate: LocalSyncBaselineCandidate): SyncPayload {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('candidate must be a plain object')
  }
  const c = candidate
  if (c.kind !== LOCAL_SYNC_BASELINE_KIND) {
    fail(`candidate kind must be "${LOCAL_SYNC_BASELINE_KIND}"`)
  }
  if (c.schemaVersion !== LOCAL_SYNC_BASELINE_SCHEMA_VERSION) {
    fail(`candidate schemaVersion must be "${LOCAL_SYNC_BASELINE_SCHEMA_VERSION}"`)
  }
  if (c.inventoryVersion !== LOCAL_SYNC_BASELINE_INVENTORY_VERSION) {
    fail(`candidate inventoryVersion must be "${LOCAL_SYNC_BASELINE_INVENTORY_VERSION}"`)
  }
  if (c.orderFrameVersion !== LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION) {
    fail(`candidate orderFrameVersion must be "${LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION}"`)
  }
  if (!Array.isArray(c.entities) || !Array.isArray(c.tombstones) || !Array.isArray(c.orderFrames)) {
    fail('candidate entities/tombstones/orderFrames must be arrays')
  }
  if (!c.completeness || typeof c.completeness !== 'object') {
    fail('candidate completeness must be present')
  }
  if (c.completeness.state !== 'complete') {
    fail(`only complete candidates project (state=${String(c.completeness.state)})`)
  }
  if (Array.isArray(c.completeness.reasons) && c.completeness.reasons.length > 0) {
    fail(`complete candidate must carry no reasons (got ${c.completeness.reasons.length})`)
  }
  if (c.observationBinding !== 'bound') {
    fail('only bound candidates project')
  }
  if (c.pendingOutboxCount !== 0) {
    fail('only candidates with pendingOutboxCount 0 project')
  }
  if (!c.manifest || typeof c.manifest !== 'object') {
    fail('candidate manifest must be present')
  }
  const manifestState = (c.manifest as { completenessState?: unknown }).completenessState
  if (manifestState !== 'complete') {
    fail('only candidates with manifest completenessState complete project')
  }

  const topics: TopicEntity[] = []
  const messages: MessageEntity[] = []
  const messageBlocks: MessageBlockEntity[] = []

  for (const entity of c.entities) {
    if (!entity || typeof entity !== 'object') fail('candidate entity must be an object')
    if (entity.entityType === 'topic') {
      const payload = entity.payload
      if (!payload || typeof payload !== 'object') fail(`topic/${entity.entityId} payload must be an object`)
      if (!entity.entityClock) fail(`topic/${entity.entityId} missing entityClock`)
      const clockMap = toClockMap(entity, 8, TOPIC_WIRE_FIELDS as readonly string[])
      const wire: TopicEntity = {
        id: entity.entityId,
        name: fieldValue(payload, entity.entityId, 'name'),
        assistantId: fieldValue(payload, entity.entityId, 'assistantId'),
        createdAt: fieldValue(payload, entity.entityId, 'createdAt'),
        updatedAt: fieldValue(payload, entity.entityId, 'updatedAt'),
        deletedAt: fieldValue(payload, entity.entityId, 'deletedAt'),
        pinned: fieldValueBoolean(payload, entity.entityId, 'pinned'),
        prompt: fieldValue(payload, entity.entityId, 'prompt'),
        isNameManuallyEdited: fieldValueBoolean(payload, entity.entityId, 'isNameManuallyEdited'),
        entityClock: { timestamp: entity.entityClock.timestamp, operationId: entity.entityClock.operationId },
        fieldClocks: {
          name: clockMap['name'],
          assistantId: clockMap['assistantId'],
          createdAt: clockMap['createdAt'],
          updatedAt: clockMap['updatedAt'],
          deletedAt: clockMap['deletedAt'],
          pinned: clockMap['pinned'],
          prompt: clockMap['prompt'],
          isNameManuallyEdited: clockMap['isNameManuallyEdited']
        } as TopicEntity['fieldClocks']
      }
      topics.push(wire)
    } else if (entity.entityType === 'message') {
      const payload = entity.payload
      if (!payload || typeof payload !== 'object') fail(`message/${entity.entityId} payload must be an object`)
      if (!entity.entityClock) fail(`message/${entity.entityId} missing entityClock`)
      const pm = entity.parentMembershipClock
      if (!pm) fail(`message/${entity.entityId} missing parentMembershipClock`)
      if (pm.parentId !== (payload['topicId'] as string)) {
        fail(`message/${entity.entityId} membership parent mismatch`)
      }
      const clockMap = toClockMap(entity, 9, MESSAGE_WIRE_FIELDS as readonly string[])
      messages.push({
        id: entity.entityId,
        topicId: requireNonEmptyString(payload['topicId'], `message/${entity.entityId} topicId`),
        role: fieldValue(payload, entity.entityId, 'role'),
        content: fieldValue(payload, entity.entityId, 'content'),
        status: fieldValue(payload, entity.entityId, 'status'),
        askId: fieldValue(payload, entity.entityId, 'askId'),
        model: fieldValue(payload, entity.entityId, 'model'),
        modelId: fieldValue(payload, entity.entityId, 'modelId'),
        assistantId: fieldValue(payload, entity.entityId, 'assistantId'),
        createdAt: fieldValue(payload, entity.entityId, 'createdAt'),
        updatedAt: fieldValue(payload, entity.entityId, 'updatedAt'),
        entityClock: { timestamp: entity.entityClock.timestamp, operationId: entity.entityClock.operationId },
        fieldClocks: {
          role: clockMap['role'],
          content: clockMap['content'],
          status: clockMap['status'],
          askId: clockMap['askId'],
          model: clockMap['model'],
          modelId: clockMap['modelId'],
          assistantId: clockMap['assistantId'],
          createdAt: clockMap['createdAt'],
          updatedAt: clockMap['updatedAt']
        } as MessageEntity['fieldClocks'],
        parentMembershipClock: { timestamp: pm.timestamp, operationId: pm.operationId }
      })
    } else if (entity.entityType === 'message_block') {
      const payload = entity.payload
      if (!payload || typeof payload !== 'object') fail(`message_block/${entity.entityId} payload must be an object`)
      if (!entity.entityClock) fail(`message_block/${entity.entityId} missing entityClock`)
      const pm = entity.parentMembershipClock
      if (!pm) fail(`message_block/${entity.entityId} missing parentMembershipClock`)
      if (pm.parentId !== (payload['messageId'] as string)) {
        fail(`message_block/${entity.entityId} membership parent mismatch`)
      }
      const clockMap = toClockMap(entity, 5, BLOCK_WIRE_FIELDS as readonly string[])
      messageBlocks.push({
        id: entity.entityId,
        messageId: requireNonEmptyString(payload['messageId'], `message_block/${entity.entityId} messageId`),
        type: fieldValue(payload, entity.entityId, 'type'),
        content: fieldValue(payload, entity.entityId, 'content'),
        status: fieldValue(payload, entity.entityId, 'status'),
        createdAt: fieldValue(payload, entity.entityId, 'createdAt'),
        updatedAt: fieldValue(payload, entity.entityId, 'updatedAt'),
        entityClock: { timestamp: entity.entityClock.timestamp, operationId: entity.entityClock.operationId },
        fieldClocks: {
          type: clockMap['type'],
          content: clockMap['content'],
          status: clockMap['status'],
          createdAt: clockMap['createdAt'],
          updatedAt: clockMap['updatedAt']
        } as MessageBlockEntity['fieldClocks'],
        parentMembershipClock: { timestamp: pm.timestamp, operationId: pm.operationId }
      })
    } else {
      fail(`unknown candidate entityType ${String((entity as { entityType?: unknown }).entityType)}`)
    }
  }

  const tombstones: Tombstone[] = c.tombstones.map((t) => {
    if (!t || typeof t !== 'object') fail('candidate tombstone must be an object')
    const entityType = t.entityType === 'message_block' ? 'messageBlock' : t.entityType
    if (entityType !== 'topic' && entityType !== 'message' && entityType !== 'messageBlock') {
      fail(`unknown tombstone entityType ${String(t.entityType)}`)
    }
    return {
      entityType,
      entityId: t.entityId,
      deletionClock: { timestamp: t.timestamp, operationId: t.operationId },
      survivingEntityClock: t.entityClock
        ? { timestamp: t.entityClock.timestamp, operationId: t.entityClock.operationId }
        : null
    } as Tombstone
  })

  const orderFrames: OrderFrame[] = c.orderFrames.map((f) => {
    if (!f || typeof f !== 'object') fail('candidate orderFrame must be an object')
    if (f.frameVersion !== LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION) {
      fail(`orderFrame frameVersion must be "${LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION}"`)
    }
    if (f.kind !== 'topicMessage' && f.kind !== 'messageBlock') {
      fail(`unknown orderFrame kind ${String(f.kind)}`)
    }
    if (!Array.isArray(f.orderedChildIds)) fail(`orderFrame/${f.parentId} orderedChildIds must be an array`)
    return {
      frameVersion: ORDER_FRAME_VERSION,
      kind: f.kind,
      parentId: f.parentId,
      orderedChildIds: [...f.orderedChildIds],
      frameClock: { timestamp: f.frameClock.timestamp, operationId: f.frameClock.operationId }
    } as OrderFrame
  })

  // Wire UTF-8 byte-lex ordering (validator enforces; projection produces it).
  topics.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  messages.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  messageBlocks.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  tombstones.sort((a, b) => {
    const r = tombstoneRank(a.entityType) - tombstoneRank(b.entityType)
    if (r !== 0) return r
    return compareUtf8ByteLex(a.entityId, b.entityId)
  })
  orderFrames.sort((a, b) => {
    const r = frameRank(a.kind) - frameRank(b.kind)
    if (r !== 0) return r
    return compareUtf8ByteLex(a.parentId, b.parentId)
  })

  const tombstoneCounts = { topic: 0, message: 0, messageBlock: 0 }
  for (const t of tombstones) {
    if (t.entityType === 'topic') tombstoneCounts.topic += 1
    else if (t.entityType === 'message') tombstoneCounts.message += 1
    else tombstoneCounts.messageBlock += 1
  }
  const frameCounts = { topicMessage: 0, messageBlock: 0 }
  for (const f of orderFrames) {
    if (f.kind === 'topicMessage') frameCounts.topicMessage += 1
    else frameCounts.messageBlock += 1
  }

  const payload: SyncPayload = {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics,
    messages,
    messageBlocks,
    tombstones,
    orderFrames,
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA,
      inventoryVersion: INVENTORY_VERSION,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE,
      liveCounts: { topic: topics.length, message: messages.length, messageBlock: messageBlocks.length },
      tombstoneCounts,
      frameCounts,
      completeness: COMPLETENESS_COMPLETE
    }
  }

  try {
    validatePayload(payload)
  } catch (e) {
    if (e instanceof ValidationError) {
      fail(`projected payload failed wire validation: ${e.message}`, e)
    }
    throw e
  }
  return payload
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${context} must be a non-empty string`)
  return value
}

function fieldValue(payload: Record<string, unknown>, entityId: string, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) {
    fail(`entity ${entityId} missing required field "${field}"`)
  }
  const value = payload[field]
  if (value !== null && typeof value !== 'string') {
    fail(`entity ${entityId} field "${field}" must be string|null`)
  }
  return value
}

function fieldValueBoolean(payload: Record<string, unknown>, entityId: string, field: string): boolean | null {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) {
    fail(`entity ${entityId} missing required field "${field}"`)
  }
  const value = payload[field]
  if (value !== null && typeof value !== 'boolean') {
    fail(`entity ${entityId} field "${field}" must be boolean|null`)
  }
  return value
}

function toClockMap(
  entity: LocalSyncBaselineCandidate['entities'][number],
  expectedSize: number,
  expectedFields: readonly string[]
): Record<string, { timestamp: number; operationId: string }> {
  const map: Record<string, { timestamp: number; operationId: string }> = {}
  const seen = new Set<string>()
  for (const entry of entity.fieldClocks ?? []) {
    if (!entry || typeof entry.field !== 'string') {
      fail(`entity ${entity.entityId} has malformed fieldClock`)
    }
    if (seen.has(entry.field)) fail(`entity ${entity.entityId} duplicate fieldClock "${entry.field}"`)
    seen.add(entry.field)
    map[entry.field] = { timestamp: entry.timestamp, operationId: entry.operationId }
  }
  const expected = new Set<string>(expectedFields)
  for (const field of expected) {
    if (!(field in map)) fail(`entity ${entity.entityId} missing fieldClock "${field}"`)
  }
  for (const field of Object.keys(map)) {
    if (!expected.has(field)) fail(`entity ${entity.entityId} unexpected fieldClock "${field}"`)
  }
  if (Object.keys(map).length !== expectedSize) {
    fail(`entity ${entity.entityId} fieldClock count mismatch`)
  }
  return map
}

/**
 * Payload-only `jcs-sha256-v1` digest over the projected wire `payload`.
 * Uses the shared canonicalizer/digest; hash is SHA-256 over JCS UTF-8 bytes.
 */
export function computeWirePayloadDigest(payload: SyncPayload): string {
  try {
    return computeSyncDigest(payload, hashHex)
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new SyncBaselineWireProjectionError(`wire digest failed validation: ${e.message}`, { cause: e })
    }
    throw e
  }
}

/**
 * Verify a payload-only `jcs-sha256-v1` digest. Returns false on format
 * mismatch or digest mismatch; throws only when the payload itself is not
 * wire-valid (fail-closed, never hashed around).
 */
export function verifyWirePayloadDigest(payload: SyncPayload, expectedDigest: string): boolean {
  try {
    validatePayload(payload)
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new SyncBaselineWireProjectionError(`wire verify failed validation: ${e.message}`, { cause: e })
    }
    throw e
  }
  return verifySyncDigest(payload, expectedDigest, hashHex)
}

export type { BlockWireField, MessageWireField, TopicWireField }
