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
  INVENTORY_VERSION_V2,
  INVENTORY_VERSION_V3,
  INVENTORY_VERSION_V5,
  type MessageBlockEntity,
  type MessageEntity,
  ORDER_FRAME_VERSION,
  type OrderFrame,
  PAYLOAD_SCHEMA_V2,
  PAYLOAD_SCHEMA_V3,
  PAYLOAD_SCHEMA_V5,
  type ReplacementRegister,
  SCOPE_V2,
  SCOPE_V3,
  SCOPE_V5,
  type SyncPayloadV2,
  type SyncPayloadV3,
  type SyncPayloadV4,
  type SyncPayloadV5,
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
 * Baseline v2 (SYNC-DATA-056): the output is the `chat-core-baseline-v2`
 * payload carrying the same v1 content plus the strictly-closed
 * `replacementRegisters` array read in the same snapshot. Self-validates via
 * the shared strict `validatePayload` (version-dispatched) before returning.
 * Throws `SyncBaselineWireProjectionError` (with `ValidationError` cause where
 * applicable) for any illegal or incomplete candidate.
 */
export function projectLocalBaselineToWirePayload(candidate: LocalSyncBaselineCandidate): SyncPayloadV2 {
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
  // No silent downgrade: the v2 projection never drops branch inventory.
  // Candidates carrying branch entities, branch tombstones, branchSuffix
  // frames, or branch-owned messages project only via the v3 projector.
  for (const entity of c.entities) {
    if ((entity as { entityType?: unknown }).entityType === 'topic_branch') {
      fail('v2 projection cannot carry branch inventory (use v3)')
    }
    if (
      (entity as { entityType?: unknown }).entityType === 'message' &&
      (entity as { payload?: Record<string, unknown> }).payload?.branchId !== undefined &&
      (entity as { payload?: Record<string, unknown> }).payload?.branchId !== null
    ) {
      fail('v2 projection cannot carry branch-owned messages (use v3)')
    }
  }
  for (const t of c.tombstones) {
    if ((t as { entityType?: unknown }).entityType === 'topic_branch') {
      fail('v2 projection cannot carry branch tombstones (use v3)')
    }
  }
  for (const f of c.orderFrames) {
    if ((f as { kind?: unknown }).kind === 'branchSuffix') {
      fail('v2 projection cannot carry branchSuffix frames (use v3)')
    }
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

  // Baseline v2 registers: carried as-is from the same snapshot, sorted by
  // messageId UTF-8 byte lex. Local candidate order is lexical; wire order is
  // enforced here. Duplicates fail closed via the shared validator.
  const rawRegisters = (c as { replacementRegisters?: unknown }).replacementRegisters
  const registerList: ReplacementRegister[] = []
  if (rawRegisters !== undefined) {
    if (!Array.isArray(rawRegisters)) fail('candidate replacementRegisters must be an array')
    for (const r of rawRegisters as unknown[]) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) fail('candidate replacementRegister must be an object')
      const rec = r as { messageId?: unknown; timestamp?: unknown; operationId?: unknown; activeBlockIds?: unknown }
      if (typeof rec.messageId !== 'string' || rec.messageId.length === 0) {
        fail(`candidate replacementRegister messageId must be a non-empty string`)
      }
      if (typeof rec.timestamp !== 'number' || !Number.isSafeInteger(rec.timestamp) || rec.timestamp < 0) {
        fail(`candidate replacementRegister timestamp malformed for ${String(rec.messageId)}`)
      }
      if (typeof rec.operationId !== 'string' || rec.operationId.length === 0) {
        fail(`candidate replacementRegister operationId malformed for ${String(rec.messageId)}`)
      }
      if (!Array.isArray(rec.activeBlockIds)) {
        fail(`candidate replacementRegister activeBlockIds must be an array for ${String(rec.messageId)}`)
      }
      registerList.push({
        messageId: rec.messageId,
        replacementClock: { timestamp: rec.timestamp, operationId: rec.operationId },
        activeBlockIds: [...(rec.activeBlockIds as string[])]
      })
    }
  }
  registerList.sort((a, b) => compareUtf8ByteLex(a.messageId, b.messageId))

  const payload: SyncPayloadV2 = {
    payloadSchema: PAYLOAD_SCHEMA_V2,
    inventoryVersion: INVENTORY_VERSION_V2,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V2,
    topics,
    messages,
    messageBlocks,
    tombstones,
    orderFrames,
    replacementRegisters: registerList,
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA_V2,
      inventoryVersion: INVENTORY_VERSION_V2,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V2,
      liveCounts: { topic: topics.length, message: messages.length, messageBlock: messageBlocks.length },
      tombstoneCounts,
      frameCounts,
      replacementCount: registerList.length,
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
  const expected = new Set<string>(expectedFields)
  for (const entry of entity.fieldClocks ?? []) {
    if (!entry || typeof entry.field !== 'string') {
      fail(`entity ${entity.entityId} has malformed fieldClock`)
    }
    // Legacy V3/V2 callers now see assetIds clocks minted for V5 but must ignore them (version-specific contract)
    if (entry.field === 'assetIds' && !expected.has('assetIds')) {
      continue
    }
    if (seen.has(entry.field)) fail(`entity ${entity.entityId} duplicate fieldClock "${entry.field}"`)
    seen.add(entry.field)
    map[entry.field] = { timestamp: entry.timestamp, operationId: entry.operationId }
  }
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
export function computeWirePayloadDigest(payload: SyncPayloadV2): string {
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
export function verifyWirePayloadDigest(payload: SyncPayloadV2, expectedDigest: string): boolean {
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

const BRANCH_WIRE_FIELDS = ['name', 'createdAt', 'updatedAt'] as const

function tombstoneRankV3(entityType: string): number {
  if (entityType === 'topic') return 0
  if (entityType === 'message') return 1
  if (entityType === 'messageBlock') return 2
  return 3
}

function frameRankV3(kind: string): number {
  if (kind === 'topicMessage') return 0
  if (kind === 'messageBlock') return 1
  return 2
}

/**
 * Project a complete branch-aware local baseline candidate to the locked
 * v3 wire `payload` (`chat-core-baseline-v3` /
 * `topic-message-stable-block-order-branch-v3`).
 *
 * Same transport-free contract as the v2 projector: only `complete` bound
 * outbox-empty fully-clocked candidates project; everything else fails
 * closed. Messages carry the immutable owner `branchId` (null = main);
 * branches map full-state with entity + name/createdAt/updatedAt field
 * clocks; tombstones map `topic_branch` → `topicBranch`; frames map all
 * three kinds with membership-gated coverage enforced by the shared strict
 * `validatePayload` (version-dispatched to v3). Self-validates before
 * returning. Incompatible (v1/v2-only) peers fail closed on the unknown
 * wire version — never silently downgraded.
 */
export function projectLocalBaselineToWirePayloadV3(candidate: LocalSyncBaselineCandidate): SyncPayloadV3 {
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
  const messages: SyncPayloadV3['messages'] = []
  const messageBlocks: MessageBlockEntity[] = []
  const branches: SyncPayloadV3['branches'] = []

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
      const ownerBranch =
        payload['branchId'] === undefined || payload['branchId'] === null
          ? null
          : requireNonEmptyString(payload['branchId'], `message/${entity.entityId} branchId`)
      const expectedParent =
        ownerBranch !== null
          ? ownerBranch
          : requireNonEmptyString(payload['topicId'], `message/${entity.entityId} topicId`)
      if (pm.parentId !== expectedParent) {
        fail(`message/${entity.entityId} membership parent mismatch`)
      }
      const clockMap = toClockMap(entity, 9, MESSAGE_WIRE_FIELDS as readonly string[])
      messages.push({
        id: entity.entityId,
        topicId: requireNonEmptyString(payload['topicId'], `message/${entity.entityId} topicId`),
        branchId: ownerBranch,
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
    } else if (entity.entityType === 'topic_branch') {
      const payload = entity.payload
      if (!payload || typeof payload !== 'object') fail(`branch/${entity.entityId} payload must be an object`)
      if (!entity.entityClock) fail(`branch/${entity.entityId} missing entityClock`)
      const clockMap = toClockMap(entity, 3, BRANCH_WIRE_FIELDS as readonly string[])
      const parentBranchId =
        payload['parentBranchId'] === undefined || payload['parentBranchId'] === null
          ? null
          : requireNonEmptyString(payload['parentBranchId'], `branch/${entity.entityId} parentBranchId`)
      branches.push({
        id: entity.entityId,
        topicId: requireNonEmptyString(payload['topicId'], `branch/${entity.entityId} topicId`),
        parentBranchId,
        anchorMessageId: requireNonEmptyString(payload['anchorMessageId'], `branch/${entity.entityId} anchorMessageId`),
        name: fieldValue(payload, entity.entityId, 'name'),
        createdAt: fieldValue(payload, entity.entityId, 'createdAt'),
        updatedAt: fieldValue(payload, entity.entityId, 'updatedAt'),
        entityClock: { timestamp: entity.entityClock.timestamp, operationId: entity.entityClock.operationId },
        fieldClocks: {
          name: clockMap['name'],
          createdAt: clockMap['createdAt'],
          updatedAt: clockMap['updatedAt']
        }
      })
    } else {
      fail(`unknown candidate entityType ${String((entity as { entityType?: unknown }).entityType)}`)
    }
  }

  const tombstones: SyncPayloadV3['tombstones'] = c.tombstones.map((t) => {
    if (!t || typeof t !== 'object') fail('candidate tombstone must be an object')
    const entityType =
      t.entityType === 'message_block' ? 'messageBlock' : t.entityType === 'topic_branch' ? 'topicBranch' : t.entityType
    if (
      entityType !== 'topic' &&
      entityType !== 'message' &&
      entityType !== 'messageBlock' &&
      entityType !== 'topicBranch'
    ) {
      fail(`unknown tombstone entityType ${String(t.entityType)}`)
    }
    return {
      entityType,
      entityId: t.entityId,
      deletionClock: { timestamp: t.timestamp, operationId: t.operationId },
      survivingEntityClock: t.entityClock
        ? { timestamp: t.entityClock.timestamp, operationId: t.entityClock.operationId }
        : null
    } as SyncPayloadV3['tombstones'][number]
  })

  const orderFrames: SyncPayloadV3['orderFrames'] = c.orderFrames.map((f) => {
    if (!f || typeof f !== 'object') fail('candidate orderFrame must be an object')
    if (f.frameVersion !== LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION) {
      fail(`orderFrame frameVersion must be "${LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION}"`)
    }
    if (f.kind !== 'topicMessage' && f.kind !== 'messageBlock' && f.kind !== 'branchSuffix') {
      fail(`unknown orderFrame kind ${String(f.kind)}`)
    }
    if (!Array.isArray(f.orderedChildIds)) fail(`orderFrame/${f.parentId} orderedChildIds must be an array`)
    return {
      frameVersion: ORDER_FRAME_VERSION,
      kind: f.kind,
      parentId: f.parentId,
      orderedChildIds: [...f.orderedChildIds],
      frameClock: { timestamp: f.frameClock.timestamp, operationId: f.frameClock.operationId }
    } as SyncPayloadV3['orderFrames'][number]
  })

  // Wire UTF-8 byte-lex ordering (validator enforces; projection produces it).
  topics.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  messages.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  messageBlocks.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  branches.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  tombstones.sort((a, b) => {
    const r = tombstoneRankV3(a.entityType) - tombstoneRankV3(b.entityType)
    if (r !== 0) return r
    return compareUtf8ByteLex(a.entityId, b.entityId)
  })
  orderFrames.sort((a, b) => {
    const r = frameRankV3(a.kind) - frameRankV3(b.kind)
    if (r !== 0) return r
    return compareUtf8ByteLex(a.parentId, b.parentId)
  })

  const tombstoneCounts = { topic: 0, message: 0, messageBlock: 0, topicBranch: 0 }
  for (const t of tombstones) {
    if (t.entityType === 'topic') tombstoneCounts.topic += 1
    else if (t.entityType === 'message') tombstoneCounts.message += 1
    else if (t.entityType === 'messageBlock') tombstoneCounts.messageBlock += 1
    else tombstoneCounts.topicBranch += 1
  }
  const frameCounts = { topicMessage: 0, messageBlock: 0, branchSuffix: 0 }
  for (const f of orderFrames) {
    if (f.kind === 'topicMessage') frameCounts.topicMessage += 1
    else if (f.kind === 'messageBlock') frameCounts.messageBlock += 1
    else frameCounts.branchSuffix += 1
  }

  // Baseline v2 registers ride v3 unchanged (same locked three keys, same
  // snapshot, UTF-8 byte-lex order). The merge core consumes them via the
  // shared adapter; no branch rule touches them.
  const rawRegistersV3 = (c as { replacementRegisters?: unknown }).replacementRegisters
  const registerListV3: SyncPayloadV3['replacementRegisters'] = []
  if (rawRegistersV3 !== undefined) {
    if (!Array.isArray(rawRegistersV3)) fail('candidate replacementRegisters must be an array')
    for (const r of rawRegistersV3 as unknown[]) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) fail('candidate replacementRegister must be an object')
      const rec = r as { messageId?: unknown; timestamp?: unknown; operationId?: unknown; activeBlockIds?: unknown }
      if (typeof rec.messageId !== 'string' || rec.messageId.length === 0) {
        fail(`candidate replacementRegister messageId must be a non-empty string`)
      }
      if (typeof rec.timestamp !== 'number' || !Number.isSafeInteger(rec.timestamp) || rec.timestamp < 0) {
        fail(`candidate replacementRegister timestamp malformed for ${String(rec.messageId)}`)
      }
      if (typeof rec.operationId !== 'string' || rec.operationId.length === 0) {
        fail(`candidate replacementRegister operationId malformed for ${String(rec.messageId)}`)
      }
      if (!Array.isArray(rec.activeBlockIds)) {
        fail(`candidate replacementRegister activeBlockIds must be an array for ${String(rec.messageId)}`)
      }
      registerListV3.push({
        messageId: rec.messageId,
        replacementClock: { timestamp: rec.timestamp, operationId: rec.operationId },
        activeBlockIds: [...(rec.activeBlockIds as string[])]
      })
    }
  }
  registerListV3.sort((a, b) => compareUtf8ByteLex(a.messageId, b.messageId))

  const payload: SyncPayloadV3 = {
    payloadSchema: PAYLOAD_SCHEMA_V3,
    inventoryVersion: INVENTORY_VERSION_V3,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V3,
    topics,
    messages,
    messageBlocks,
    branches,
    tombstones,
    orderFrames,
    replacementRegisters: registerListV3,
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA_V3,
      inventoryVersion: INVENTORY_VERSION_V3,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V3,
      liveCounts: {
        topic: topics.length,
        message: messages.length,
        messageBlock: messageBlocks.length,
        branch: branches.length
      },
      tombstoneCounts,
      frameCounts,
      replacementCount: registerListV3.length,
      completeness: COMPLETENESS_COMPLETE
    }
  }

  try {
    validatePayload(payload)
  } catch (e) {
    if (e instanceof ValidationError) {
      fail(`projected v3 payload failed wire validation: ${e.message}`, e)
    }
    throw e
  }
  return payload
}

/**
 * Payload-only `jcs-sha256-v1` digest over a projected v3 wire `payload`.
 */
export function computeWirePayloadDigestV3(payload: SyncPayloadV3): string {
  try {
    return computeSyncDigest(payload, hashHex)
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new SyncBaselineWireProjectionError(`wire v3 digest failed validation: ${e.message}`, { cause: e })
    }
    throw e
  }
}

/**
 * Verify a payload-only `jcs-sha256-v1` digest for a v3 payload. Returns
 * false on format/digest mismatch; throws only when the payload itself is
 * not wire-valid (fail-closed).
 */
export function verifyWirePayloadDigestV3(payload: SyncPayloadV3, expectedDigest: string): boolean {
  try {
    validatePayload(payload)
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new SyncBaselineWireProjectionError(`wire v3 verify failed validation: ${e.message}`, { cause: e })
    }
    throw e
  }
  return verifySyncDigest(payload, expectedDigest, hashHex)
}

const BLOCK_WIRE_FIELDS_V5 = ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds'] as const
const FILE_ASSET_WIRE_FIELDS_V5 = ['mimeType', 'originalName', 'createdAt'] as const

/**
 * Project a complete local baseline candidate + assistant section to the locked
 * v5 wire `payload` (`chat-core-baseline-v5`).
 * Direct V5 projection with full media, branch, assistant, replacement and fileAssets.
 * Validates via shared strict validatePayload (dispatched to V5).
 */
export function projectLocalBaselineToWirePayloadV5(
  candidate: LocalSyncBaselineCandidate,
  assistantSection?: { configs: unknown[]; tombstones: unknown[] }
): SyncPayloadV5 {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('candidate must be a plain object')
  }
  const c = candidate as unknown as LocalSyncBaselineCandidate & {
    fileAssets?: Array<{
      entityId: string
      payload: Record<string, unknown>
      entityClock: { timestamp: number; operationId: string } | null
      fieldClocks: Array<{ field: string; timestamp: number; operationId: string }>
    }>
    pendingAttachmentCount?: number
  }
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
  if ((c.pendingAttachmentCount ?? 0) !== 0) {
    fail('only candidates with pendingAttachmentCount 0 project')
  }
  if (!c.manifest || typeof c.manifest !== 'object') {
    fail('candidate manifest must be present')
  }
  const manifestState = (c.manifest as { completenessState?: unknown }).completenessState
  if (manifestState !== 'complete') {
    fail('only candidates with manifest completenessState complete project')
  }

  const topics: TopicEntity[] = []
  const messages: SyncPayloadV5['messages'] = []
  const messageBlocks: SyncPayloadV5['messageBlocks'] = []
  const branches: SyncPayloadV5['branches'] = []

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
      const ownerBranch =
        payload['branchId'] === undefined || payload['branchId'] === null
          ? null
          : requireNonEmptyString(payload['branchId'], `message/${entity.entityId} branchId`)
      const expectedParent =
        ownerBranch !== null
          ? ownerBranch
          : requireNonEmptyString(payload['topicId'], `message/${entity.entityId} topicId`)
      if (pm.parentId !== expectedParent) {
        fail(`message/${entity.entityId} membership parent mismatch`)
      }
      const clockMap = toClockMap(entity, 9, MESSAGE_WIRE_FIELDS as readonly string[])
      messages.push({
        id: entity.entityId,
        topicId: requireNonEmptyString(payload['topicId'], `message/${entity.entityId} topicId`),
        branchId: ownerBranch,
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
      const clockMap = toClockMap(entity, 6, BLOCK_WIRE_FIELDS_V5 as readonly string[])
      const assetIdsRaw = payload['assetIds']
      if (!Array.isArray(assetIdsRaw)) fail(`message_block/${entity.entityId} assetIds must be array`)
      const assetIds = (assetIdsRaw as unknown[]).map((v) => {
        if (typeof v !== 'string') fail(`message_block/${entity.entityId} assetIds must be strings`)
        return v
      })
      messageBlocks.push({
        id: entity.entityId,
        messageId: requireNonEmptyString(payload['messageId'], `message_block/${entity.entityId} messageId`),
        type: fieldValue(payload, entity.entityId, 'type'),
        content: fieldValue(payload, entity.entityId, 'content'),
        status: fieldValue(payload, entity.entityId, 'status'),
        createdAt: fieldValue(payload, entity.entityId, 'createdAt'),
        updatedAt: fieldValue(payload, entity.entityId, 'updatedAt'),
        assetIds,
        entityClock: { timestamp: entity.entityClock.timestamp, operationId: entity.entityClock.operationId },
        fieldClocks: {
          type: clockMap['type'],
          content: clockMap['content'],
          status: clockMap['status'],
          createdAt: clockMap['createdAt'],
          updatedAt: clockMap['updatedAt'],
          assetIds: clockMap['assetIds']
        } as SyncPayloadV5['messageBlocks'][number]['fieldClocks'],
        parentMembershipClock: { timestamp: pm.timestamp, operationId: pm.operationId }
      })
    } else if (entity.entityType === 'topic_branch') {
      const payload = entity.payload
      if (!payload || typeof payload !== 'object') fail(`branch/${entity.entityId} payload must be an object`)
      if (!entity.entityClock) fail(`branch/${entity.entityId} missing entityClock`)
      const clockMap = toClockMap(entity, 3, BRANCH_WIRE_FIELDS as readonly string[])
      const parentBranchId =
        payload['parentBranchId'] === undefined || payload['parentBranchId'] === null
          ? null
          : requireNonEmptyString(payload['parentBranchId'], `branch/${entity.entityId} parentBranchId`)
      branches.push({
        id: entity.entityId,
        topicId: requireNonEmptyString(payload['topicId'], `branch/${entity.entityId} topicId`),
        parentBranchId,
        anchorMessageId: requireNonEmptyString(payload['anchorMessageId'], `branch/${entity.entityId} anchorMessageId`),
        name: fieldValue(payload, entity.entityId, 'name'),
        createdAt: fieldValue(payload, entity.entityId, 'createdAt'),
        updatedAt: fieldValue(payload, entity.entityId, 'updatedAt'),
        entityClock: { timestamp: entity.entityClock.timestamp, operationId: entity.entityClock.operationId },
        fieldClocks: {
          name: clockMap['name'],
          createdAt: clockMap['createdAt'],
          updatedAt: clockMap['updatedAt']
        }
      })
    } else {
      fail(`unknown candidate entityType ${String((entity as { entityType?: unknown }).entityType)}`)
    }
  }

  const tombstones: SyncPayloadV5['tombstones'] = c.tombstones.map((t) => {
    if (!t || typeof t !== 'object') fail('candidate tombstone must be an object')
    const entityType =
      t.entityType === 'message_block'
        ? 'messageBlock'
        : t.entityType === 'topic_branch'
          ? 'topicBranch'
          : t.entityType === 'file_asset'
            ? 'fileAsset'
            : t.entityType
    if (
      entityType !== 'topic' &&
      entityType !== 'message' &&
      entityType !== 'messageBlock' &&
      entityType !== 'topicBranch' &&
      entityType !== 'fileAsset'
    ) {
      fail(`unknown tombstone entityType ${String(t.entityType)}`)
    }
    return {
      entityType,
      entityId: t.entityId,
      deletionClock: { timestamp: t.timestamp, operationId: t.operationId },
      survivingEntityClock: t.entityClock
        ? { timestamp: t.entityClock.timestamp, operationId: t.entityClock.operationId }
        : null
    } as SyncPayloadV5['tombstones'][number]
  })

  const orderFrames: SyncPayloadV5['orderFrames'] = c.orderFrames.map((f) => {
    if (!f || typeof f !== 'object') fail('candidate orderFrame must be an object')
    if (f.frameVersion !== LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION) {
      fail(`orderFrame frameVersion must be "${LOCAL_SYNC_BASELINE_ORDER_FRAME_VERSION}"`)
    }
    if (f.kind !== 'topicMessage' && f.kind !== 'messageBlock' && f.kind !== 'branchSuffix') {
      fail(`unknown orderFrame kind ${String(f.kind)}`)
    }
    if (!Array.isArray(f.orderedChildIds)) fail(`orderFrame/${f.parentId} orderedChildIds must be an array`)
    return {
      frameVersion: ORDER_FRAME_VERSION,
      kind: f.kind,
      parentId: f.parentId,
      orderedChildIds: [...f.orderedChildIds],
      frameClock: { timestamp: f.frameClock.timestamp, operationId: f.frameClock.operationId }
    } as SyncPayloadV5['orderFrames'][number]
  })

  topics.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  messages.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  messageBlocks.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  branches.sort((a, b) => compareUtf8ByteLex(a.id, b.id))
  tombstones.sort((a, b) => {
    const rank = (t: string): number => {
      if (t === 'topic') return 0
      if (t === 'message') return 1
      if (t === 'messageBlock') return 2
      if (t === 'topicBranch') return 3
      return 4
    }
    const r = rank(a.entityType)
    const r2 = rank(b.entityType)
    if (r !== r2) return r - r2
    return compareUtf8ByteLex(a.entityId, b.entityId)
  })
  orderFrames.sort((a, b) => {
    const r = a.kind === 'topicMessage' ? 0 : a.kind === 'messageBlock' ? 1 : 2
    const r2 = b.kind === 'topicMessage' ? 0 : b.kind === 'messageBlock' ? 1 : 2
    if (r !== r2) return r - r2
    return compareUtf8ByteLex(a.parentId, b.parentId)
  })

  const rawRegistersV5 = (c as { replacementRegisters?: unknown }).replacementRegisters
  const registerListV5: SyncPayloadV5['replacementRegisters'] = []
  if (rawRegistersV5 !== undefined) {
    if (!Array.isArray(rawRegistersV5)) fail('candidate replacementRegisters must be an array')
    for (const r of rawRegistersV5 as unknown[]) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) fail('candidate replacementRegister must be an object')
      const rec = r as { messageId?: unknown; timestamp?: unknown; operationId?: unknown; activeBlockIds?: unknown }
      if (typeof rec.messageId !== 'string' || rec.messageId.length === 0) {
        fail(`candidate replacementRegister messageId must be a non-empty string`)
      }
      if (typeof rec.timestamp !== 'number' || !Number.isSafeInteger(rec.timestamp) || rec.timestamp < 0) {
        fail(`candidate replacementRegister timestamp malformed for ${String(rec.messageId)}`)
      }
      if (typeof rec.operationId !== 'string' || rec.operationId.length === 0) {
        fail(`candidate replacementRegister operationId malformed for ${String(rec.messageId)}`)
      }
      if (!Array.isArray(rec.activeBlockIds)) {
        fail(`candidate replacementRegister activeBlockIds must be an array for ${String(rec.messageId)}`)
      }
      registerListV5.push({
        messageId: rec.messageId,
        replacementClock: { timestamp: rec.timestamp, operationId: rec.operationId },
        activeBlockIds: [...(rec.activeBlockIds as string[])]
      })
    }
  }
  registerListV5.sort((a, b) => compareUtf8ByteLex(a.messageId, b.messageId))

  // File assets
  const rawFileAssets = (c as { fileAssets?: unknown }).fileAssets ?? []
  if (!Array.isArray(rawFileAssets)) fail('candidate fileAssets must be an array')
  const fileAssets: SyncPayloadV5['fileAssets'] = []
  for (const fa of rawFileAssets as unknown[]) {
    if (!fa || typeof fa !== 'object' || Array.isArray(fa)) fail('candidate fileAsset must be an object')
    const rec = fa as {
      entityId?: unknown
      payload?: unknown
      entityClock?: unknown
      fieldClocks?: unknown
    }
    if (typeof rec.entityId !== 'string' || rec.entityId.length === 0)
      fail('candidate fileAsset entityId must be non-empty')
    if (!rec.payload || typeof rec.payload !== 'object' || Array.isArray(rec.payload))
      fail(`candidate fileAsset ${String(rec.entityId)} payload must be object`)
    const p = rec.payload as Record<string, unknown>
    const ec = rec.entityClock as { timestamp?: unknown; operationId?: unknown } | null
    if (!ec || typeof ec.timestamp !== 'number' || typeof ec.operationId !== 'string')
      fail(`candidate fileAsset ${String(rec.entityId)} missing entityClock`)
    const clocksArr = rec.fieldClocks as Array<{ field: string; timestamp: number; operationId: string }> | undefined
    if (!Array.isArray(clocksArr)) fail(`candidate fileAsset ${String(rec.entityId)} fieldClocks must be array`)
    const map: Record<string, { timestamp: number; operationId: string }> = {}
    for (const e of clocksArr) {
      if (!e || typeof e.field !== 'string') fail(`candidate fileAsset ${String(rec.entityId)} malformed fieldClock`)
      map[e.field] = { timestamp: e.timestamp, operationId: e.operationId }
    }
    for (const k of FILE_ASSET_WIRE_FIELDS_V5) {
      if (!(k in map)) fail(`candidate fileAsset ${String(rec.entityId)} missing fieldClock ${k}`)
    }
    fileAssets.push({
      id: rec.entityId,
      sha256: requireNonEmptyString(p['sha256'], `fileAsset/${rec.entityId} sha256`),
      byteLength: (() => {
        const v = p['byteLength']
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
          fail(`fileAsset ${String(rec.entityId)} byteLength malformed`)
        return v
      })(),
      extension: requireNonEmptyString(p['extension'], `fileAsset/${rec.entityId} extension`),
      mimeType: requireNonEmptyString(p['mimeType'], `fileAsset/${rec.entityId} mimeType`),
      originalName: requireNonEmptyString(p['originalName'], `fileAsset/${rec.entityId} originalName`),
      createdAt: requireNonEmptyString(p['createdAt'], `fileAsset/${rec.entityId} createdAt`),
      entityClock: { timestamp: ec.timestamp, operationId: ec.operationId },
      fieldClocks: {
        mimeType: map['mimeType'],
        originalName: map['originalName'],
        createdAt: map['createdAt']
      }
    })
  }
  fileAssets.sort((a, b) => compareUtf8ByteLex(a.id, b.id))

  // Assistant configs (V4) – pass-through
  const assistantConfigs: SyncPayloadV5['assistantConfigs'] = []
  const assistantTombstones: SyncPayloadV5['assistantTombstones'] = []
  if (assistantSection) {
    const cfgs = (assistantSection as { configs?: unknown }).configs
    const tombs = (assistantSection as { tombstones?: unknown }).tombstones
    if (Array.isArray(cfgs)) {
      for (const c of cfgs as SyncPayloadV4['assistantConfigs']) {
        assistantConfigs.push(c as never)
      }
    }
    if (Array.isArray(tombs)) {
      for (const t of tombs as SyncPayloadV4['assistantTombstones']) {
        assistantTombstones.push(t as never)
      }
    }
    assistantConfigs.sort((a, b) => compareUtf8ByteLex((a as { key: string }).key, (b as { key: string }).key))
    assistantTombstones.sort((a, b) => compareUtf8ByteLex((a as { key: string }).key, (b as { key: string }).key))
  }

  const payload: SyncPayloadV5 = {
    payloadSchema: PAYLOAD_SCHEMA_V5,
    inventoryVersion: INVENTORY_VERSION_V5,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V5,
    topics,
    messages,
    messageBlocks,
    branches,
    assistantConfigs,
    fileAssets,
    tombstones,
    assistantTombstones,
    orderFrames,
    replacementRegisters: registerListV5,
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA_V5,
      inventoryVersion: INVENTORY_VERSION_V5,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V5,
      liveCounts: {
        topic: topics.length,
        message: messages.length,
        messageBlock: messageBlocks.length,
        branch: branches.length,
        assistantConfig: assistantConfigs.length,
        fileAsset: fileAssets.length
      },
      tombstoneCounts: {
        topic: tombstones.filter((t) => t.entityType === 'topic').length,
        message: tombstones.filter((t) => t.entityType === 'message').length,
        messageBlock: tombstones.filter((t) => t.entityType === 'messageBlock').length,
        topicBranch: tombstones.filter((t) => t.entityType === 'topicBranch').length,
        fileAsset: tombstones.filter((t) => (t as { entityType: string }).entityType === 'fileAsset').length,
        assistantConfig: assistantTombstones.length
      },
      frameCounts: {
        topicMessage: orderFrames.filter((f) => f.kind === 'topicMessage').length,
        messageBlock: orderFrames.filter((f) => f.kind === 'messageBlock').length,
        branchSuffix: orderFrames.filter((f) => f.kind === 'branchSuffix').length
      },
      replacementCount: registerListV5.length,
      completeness: COMPLETENESS_COMPLETE
    }
  }

  try {
    validatePayload(payload)
  } catch (e) {
    if (e instanceof ValidationError) {
      fail(`projected v5 payload failed wire validation: ${e.message}`, e)
    }
    throw e
  }
  return payload
}

export function computeWirePayloadDigestV5(payload: SyncPayloadV5): string {
  try {
    return computeSyncDigest(payload, hashHex)
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new SyncBaselineWireProjectionError(`wire v5 digest failed validation: ${e.message}`, { cause: e })
    }
    throw e
  }
}

export function verifyWirePayloadDigestV5(payload: SyncPayloadV5, expectedDigest: string): boolean {
  try {
    validatePayload(payload)
  } catch (e) {
    if (e instanceof ValidationError) {
      throw new SyncBaselineWireProjectionError(`wire v5 verify failed validation: ${e.message}`, { cause: e })
    }
    throw e
  }
  return verifySyncDigest(payload, expectedDigest, hashHex)
}
