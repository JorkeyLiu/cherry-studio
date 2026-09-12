/**
 * Allowlisted payload serialization for sync operations.
 * Strips credentials, FTS, UI state, contextWindowAnchor, file_path binary etc.
 */

// Allowlisted topic fields — deletedAt included for soft-delete sync (hard delete uses op=delete)
// pinned/prompt/isNameManuallyEdited are syncable mutable topic metadata
// (overflow keys surfaced top-level). contextWindowAnchor and all other
// overflow keys remain excluded.
const TOPIC_ALLOW = new Set([
  'id',
  'name',
  'createdAt',
  'updatedAt',
  'assistantId',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited'
])
// Message allowlist
const MESSAGE_ALLOW = new Set([
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
])
// Block allowlist — never file_path, never binary, no extra file metadata
const BLOCK_ALLOW = new Set(['id', 'messageId', 'type', 'content', 'status', 'createdAt', 'updatedAt', 'sortOrder'])

// Denied substrings (defense-in-depth)
const DENIED_KEYS = new Set(['file_path', 'filePath', 'credentials', 'token', 'password', 'secret'])

export function filterTopicPayload(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (!TOPIC_ALLOW.has(k)) continue
    if (DENIED_KEYS.has(k)) continue
    const v = raw[k]
    if (v !== undefined) out[k] = v
  }
  // Strip any extra file_path that slipped via overflow
  delete (out as any).file_path
  delete (out as any).filePath
  return out
}

export function filterMessagePayload(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (!MESSAGE_ALLOW.has(k)) continue
    if (DENIED_KEYS.has(k)) continue
    const v = raw[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

export function filterBlockPayload(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (!BLOCK_ALLOW.has(k)) continue
    if (DENIED_KEYS.has(k)) continue
    const v = raw[k]
    if (v !== undefined) out[k] = v
  }
  // Never include binary content for image/file blocks beyond allowlist — extra is excluded
  return out
}

export function isPayloadSafe(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true
  const obj = payload as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase()
    if (
      lk.includes('credential') ||
      lk.includes('password') ||
      lk.includes('secret') ||
      lk === 'file_path' ||
      lk === 'filepath'
    ) {
      return false
    }
    // Recursively check nested objects shallowly
    const v = obj[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!isPayloadSafe(v)) return false
    }
  }
  return true
}

export function validateSyncPayloadAllowlist(op: {
  entityType: string
  payload?: Record<string, unknown>
}): string | null {
  if (!op.payload) return null
  if (!isPayloadSafe(op.payload)) return 'payload contains denied field'
  // Check FTS derived tables never synced
  if ('fts' in op.payload || 'fts_content' in op.payload) return 'fts field denied'
  if ('contextWindowAnchor' in op.payload) return 'contextWindowAnchor denied'
  // Ensure only allowlisted keys
  const allow = op.entityType === 'topic' ? TOPIC_ALLOW : op.entityType === 'message' ? MESSAGE_ALLOW : BLOCK_ALLOW
  for (const k of Object.keys(op.payload)) {
    if (!allow.has(k)) return `field ${k} not allowlisted for ${op.entityType}`
  }
  return null
}

/**
 * Canonical tombstone operation-ID bound: non-empty, colon-free, at most 256
 * characters. Single source of truth shared by the tombstone writer, the
 * tombstone parser, and the wire validator so all three agree exactly.
 */
export const SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH = 256

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isOptionalStringOrNull(v: unknown): boolean {
  return v === null || v === undefined || typeof v === 'string'
}

/**
 * Entity-specific required/type validation for sync operations.
 * Single shared source of truth for operation shape (relay ingress and
 * SyncClient pull boundary both delegate here).
 * Bounded MVP contract (deterministic LWW, stable topics/messages/blocks only):
 * - Structural: non-empty id/entityId/deviceId, finite timestamp, known entityType/op.
 * - Delete: must not carry a non-empty payload.
 * - Upsert: payload object, allowlisted keys only; payload.id when present
 *   must agree with entityId; required relation IDs enforced; every allowed
 *   field type-checked; sortOrder when present must be a finite integer.
 * - Upsert topic: no required fields.
 * - Upsert message: payload must carry non-empty string topicId.
 * - Upsert block: payload must carry non-empty string messageId.
 * Returns an error string, or null when valid.
 */
function isValidUnicodeScalarStringLocal(str: string): boolean {
  let i = 0
  const len = str.length
  while (i < len) {
    const cp = str.codePointAt(i)!
    if (cp >= 0xd800 && cp <= 0xdfff) return false
    if (cp > 0x10ffff) return false
    i += cp > 0xffff ? 2 : 1
  }
  return true
}

function validateOrderFramePayloadStrict(
  op: { id?: unknown; entityType?: unknown; entityId?: unknown; timestamp?: unknown; deviceId?: unknown },
  payload: unknown
): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'order_frame missing payload'
  const p = payload as Record<string, unknown>
  const keys = Object.keys(p).sort()
  const expected = ['frameClock', 'frameVersion', 'kind', 'orderedChildIds', 'parentId'].sort()
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) {
    return 'order_frame payload must be exactly {frameVersion,kind,parentId,orderedChildIds,frameClock}'
  }
  if (p.frameVersion !== 'parent-order-frame-v1') return 'order_frame unknown frameVersion'
  if (p.kind !== 'topicMessage' && p.kind !== 'messageBlock') return 'order_frame unknown kind'
  // Two legal pairs only; any cross combination fails closed with no new spelling.
  if (p.kind === 'topicMessage' && op.entityType !== 'topic') return 'order_frame entityType/kind mismatch'
  if (p.kind === 'messageBlock' && op.entityType !== 'message') return 'order_frame entityType/kind mismatch'
  if (typeof p.parentId !== 'string' || p.parentId.length === 0 || !isValidUnicodeScalarStringLocal(p.parentId)) {
    return 'order_frame invalid parentId'
  }
  if (p.parentId !== (op as { entityId?: unknown }).entityId) return 'order_frame parentId must equal entityId'
  if (!Array.isArray(p.orderedChildIds)) return 'order_frame orderedChildIds must be array'
  const seen = new Set<string>()
  for (const v of p.orderedChildIds as unknown[]) {
    if (typeof v !== 'string' || v.length === 0 || !isValidUnicodeScalarStringLocal(v)) {
      return 'order_frame invalid orderedChildId'
    }
    if (seen.has(v)) return 'order_frame duplicate orderedChildId'
    seen.add(v)
  }
  const fc = p.frameClock as Record<string, unknown> | null | undefined
  if (typeof fc !== 'object' || fc === null || Array.isArray(fc)) return 'order_frame invalid frameClock'
  const fcKeys = Object.keys(fc).sort()
  if (fcKeys.length !== 2 || fcKeys[0] !== 'operationId' || fcKeys[1] !== 'timestamp') {
    return 'order_frame frameClock must be exactly {timestamp,operationId}'
  }
  if (typeof fc.timestamp !== 'number' || !Number.isSafeInteger(fc.timestamp) || fc.timestamp < 0) {
    return 'order_frame invalid frameClock timestamp'
  }
  if (
    typeof fc.operationId !== 'string' ||
    fc.operationId.length === 0 ||
    fc.operationId.length > 256 ||
    fc.operationId.includes(':') ||
    !isValidUnicodeScalarStringLocal(fc.operationId)
  ) {
    return 'order_frame invalid frameClock operationId'
  }
  if (fc.timestamp !== op.timestamp) return 'order_frame timestamp must mirror frameClock.timestamp'
  if (fc.operationId !== op.id) return 'order_frame id must mirror frameClock.operationId'
  return null
}

export function validateSyncOperationStrict(op: {
  id?: unknown
  entityType?: unknown
  op?: unknown
  entityId?: unknown
  timestamp?: unknown
  deviceId?: unknown
  payload?: unknown
}): string | null {
  if (!isNonEmptyString(op.id)) return 'invalid id'
  // Canonical tombstone operation-ID contract: operation IDs enter over the
  // wire and become tombstone operation IDs, so the wire validator enforces
  // the same non-empty/colon-free/max-length bound as writer and parser.
  // Rejected here before any tombstone persistence (no future poison row).
  const opId = op.id
  if (opId.includes(':')) return 'invalid id: must not contain colon'
  if (opId.length > SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH) return 'invalid id: too long'
  if (op.entityType !== 'topic' && op.entityType !== 'message' && op.entityType !== 'message_block') {
    return `invalid entityType ${String(op.entityType)}`
  }
  if (op.op !== 'upsert' && op.op !== 'delete' && op.op !== 'order_frame') return `invalid op ${String(op.op)}`
  if (!isNonEmptyString(op.entityId)) return 'invalid entityId'
  if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp)) return 'invalid timestamp'
  if (!isNonEmptyString(op.deviceId)) return 'invalid deviceId'
  const entityType = op.entityType as string
  const kind = op.op as string
  const payload = op.payload as Record<string, unknown> | undefined | null
  if (kind === 'order_frame') {
    return validateOrderFramePayloadStrict(op, payload)
  }
  if (kind === 'delete') {
    if (payload !== undefined && payload !== null) {
      if (typeof payload !== 'object' || Array.isArray(payload)) return 'invalid payload'
      if (Object.keys(payload).length > 0) return 'delete must not have payload'
    }
    return null
  }
  // upsert
  if (payload === undefined || payload === null) return 'upsert missing payload'
  if (typeof payload !== 'object' || Array.isArray(payload)) return 'invalid payload'
  const allowErr = validateSyncPayloadAllowlist({ entityType, payload })
  if (allowErr) return allowErr
  // Payload identity agreement: payload.id when present must equal entityId.
  if ('id' in payload && payload.id !== undefined && payload.id !== null) {
    if (!isNonEmptyString(payload.id) || payload.id !== (op as { entityId?: unknown }).entityId) {
      return 'payload id must agree with entityId'
    }
  }
  if (entityType === 'topic') {
    if ('name' in payload && !isOptionalStringOrNull(payload.name)) return 'invalid topic name'
    if ('assistantId' in payload && !isOptionalStringOrNull(payload.assistantId)) return 'invalid topic assistantId'
    if ('createdAt' in payload && !isOptionalStringOrNull(payload.createdAt)) return 'invalid topic createdAt'
    if ('updatedAt' in payload && !isOptionalStringOrNull(payload.updatedAt)) return 'invalid topic updatedAt'
    if ('deletedAt' in payload && !isOptionalStringOrNull(payload.deletedAt)) return 'invalid topic deletedAt'
    if (
      'pinned' in payload &&
      payload.pinned !== undefined &&
      payload.pinned !== null &&
      typeof payload.pinned !== 'boolean'
    ) {
      return 'invalid topic pinned'
    }
    if ('prompt' in payload && !isOptionalStringOrNull(payload.prompt)) return 'invalid topic prompt'
    if (
      'isNameManuallyEdited' in payload &&
      payload.isNameManuallyEdited !== undefined &&
      payload.isNameManuallyEdited !== null &&
      typeof payload.isNameManuallyEdited !== 'boolean'
    ) {
      return 'invalid topic isNameManuallyEdited'
    }
    return null
  }
  if (entityType === 'message') {
    if (!isNonEmptyString(payload.topicId)) return 'message upsert missing topicId'
    if ('role' in payload && !isOptionalStringOrNull(payload.role)) return 'invalid message role'
    if ('content' in payload && !isOptionalStringOrNull(payload.content)) return 'invalid message content'
    if ('status' in payload && !isOptionalStringOrNull(payload.status)) return 'invalid message status'
    if ('askId' in payload && !isOptionalStringOrNull(payload.askId)) return 'invalid message askId'
    if ('model' in payload && !isOptionalStringOrNull(payload.model)) return 'invalid message model'
    if ('modelId' in payload && !isOptionalStringOrNull(payload.modelId)) return 'invalid message modelId'
    if ('assistantId' in payload && !isOptionalStringOrNull(payload.assistantId)) return 'invalid message assistantId'
    if ('createdAt' in payload && !isOptionalStringOrNull(payload.createdAt)) return 'invalid message createdAt'
    if ('updatedAt' in payload && !isOptionalStringOrNull(payload.updatedAt)) return 'invalid message updatedAt'
    if ('sortOrder' in payload && payload.sortOrder !== undefined && payload.sortOrder !== null) {
      if (
        typeof payload.sortOrder !== 'number' ||
        !Number.isFinite(payload.sortOrder) ||
        !Number.isInteger(payload.sortOrder)
      ) {
        return 'invalid message sortOrder'
      }
    }
    return null
  }
  // message_block
  if (!isNonEmptyString(payload.messageId)) return 'block upsert missing messageId'
  if ('type' in payload && !isOptionalStringOrNull(payload.type)) return 'invalid block type'
  if ('content' in payload && !isOptionalStringOrNull(payload.content)) return 'invalid block content'
  if ('status' in payload && !isOptionalStringOrNull(payload.status)) return 'invalid block status'
  if ('createdAt' in payload && !isOptionalStringOrNull(payload.createdAt)) return 'invalid block createdAt'
  if ('updatedAt' in payload && !isOptionalStringOrNull(payload.updatedAt)) return 'invalid block updatedAt'
  if ('sortOrder' in payload && payload.sortOrder !== undefined && payload.sortOrder !== null) {
    if (
      typeof payload.sortOrder !== 'number' ||
      !Number.isFinite(payload.sortOrder) ||
      !Number.isInteger(payload.sortOrder)
    ) {
      return 'invalid block sortOrder'
    }
  }
  return null
}
