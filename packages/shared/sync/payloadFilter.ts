/**
 * Allowlisted payload serialization for sync operations.
 * Strips credentials, FTS, UI state, contextWindowAnchor, file_path binary etc.
 */

import { parseAssistantConfigKey, validateAssistantConfigPayload } from './assistantConfig'
import { validateStableReplacePayloadStrict } from './stableReplace'

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
// `branchId` (string|null, absent = main route) is the immutable owner route.
// `topicId` stays the immutable logical topic. No synthetic composite keys.
const MESSAGE_ALLOW = new Set([
  'id',
  'topicId',
  'branchId',
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
// Block allowlist — never file_path, never binary, no extra file metadata.
// assetIds is the portable ordered attachment identity (ordered unique asset IDs, no paths/blobs).
const BLOCK_ALLOW = new Set([
  'id',
  'messageId',
  'type',
  'content',
  'status',
  'createdAt',
  'updatedAt',
  'sortOrder',
  'assetIds'
])
// File asset allowlist — strict 7-key FileAsset identity (no path/count/tokens/purpose/device/secret)
const FILE_ASSET_ALLOW = new Set(['id', 'sha256', 'byteLength', 'extension', 'mimeType', 'originalName', 'createdAt'])
// Branch allowlist — identity (id/topicId/parentBranchId/anchorMessageId) plus
// mutable state (name/createdAt/updatedAt). No synthetic decoded identities.
const BRANCH_ALLOW = new Set(['id', 'topicId', 'parentBranchId', 'anchorMessageId', 'name', 'createdAt', 'updatedAt'])

// Denied substrings (defense-in-depth)
const DENIED_KEYS = new Set(['file_path', 'filePath', 'credentials', 'token', 'password', 'secret'])

/**
 * Canonical absent defaults for the three syncable topic overflow metadata
 * fields. Single source of truth shared by Main capture (`syncTopicPayload`)
 * and baseline capture (`buildTopicPayload`) so the two can never drift.
 * Absent/undefined materializes the default; any present value including
 * explicit null is preserved (never overwritten).
 */
export const TOPIC_SYNC_DEFAULTS = {
  pinned: false,
  prompt: null,
  isNameManuallyEdited: false
} as const

export type TopicSyncDefaultField = keyof typeof TOPIC_SYNC_DEFAULTS

export function applyTopicSyncDefaults(payload: Record<string, unknown>): Record<string, unknown> {
  for (const [key, defaultValue] of Object.entries(TOPIC_SYNC_DEFAULTS)) {
    if (payload[key] === undefined) payload[key] = defaultValue
  }
  return payload
}

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

export function filterBranchPayload(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (!BRANCH_ALLOW.has(k)) continue
    if (DENIED_KEYS.has(k)) continue
    const v = raw[k]
    if (v !== undefined) out[k] = v
  }
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
  if (op.entityType === 'assistant_config') {
    // Full DTO strict validation (structure keys denied, values never scanned).
    // Settings/contextWindowAnchor nested refs are validated by the DTO validator.
    return validateAssistantConfigPayload(op.payload)
  }
  if (!isPayloadSafe(op.payload)) return 'payload contains denied field'
  // Check FTS derived tables never synced
  if ('fts' in op.payload || 'fts_content' in op.payload) return 'fts field denied'
  if ('contextWindowAnchor' in op.payload) return 'contextWindowAnchor denied'
  // File asset has its own allowlist
  if (op.entityType === 'file_asset') {
    for (const k of Object.keys(op.payload)) {
      if (!FILE_ASSET_ALLOW.has(k)) return `field ${k} not allowlisted for ${op.entityType}`
    }
    return null
  }
  // Ensure only allowlisted keys
  const allow =
    op.entityType === 'topic'
      ? TOPIC_ALLOW
      : op.entityType === 'message'
        ? MESSAGE_ALLOW
        : op.entityType === 'topic_branch'
          ? BRANCH_ALLOW
          : BLOCK_ALLOW
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
  if (p.kind !== 'topicMessage' && p.kind !== 'messageBlock' && p.kind !== 'branchSuffix') {
    return 'order_frame unknown kind'
  }
  // Three legal pairs only; any cross combination fails closed with no new spelling.
  if (p.kind === 'topicMessage' && op.entityType !== 'topic') return 'order_frame entityType/kind mismatch'
  if (p.kind === 'messageBlock' && op.entityType !== 'message') return 'order_frame entityType/kind mismatch'
  if (p.kind === 'branchSuffix' && op.entityType !== 'topic_branch') return 'order_frame entityType/kind mismatch'
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

/**
 * Strictly-closed whole-turn move contract (V5 move sync, current-development
 * amendment): ONE purpose-specific compound operation for an explicit
 * `moveSelectedTurnsToNewBranch` whole-turn move, never a generic reparent.
 * `entityType` is always `topic_branch`, `entityId` is the new branch id, and
 * the payload is exactly
 * `{topicId,sourceBranchId,destBranchId,anchorMessageId,movedMessageIds,
 * branchName,branchCreatedAt,branchUpdatedAt,sourceOrderedChildIds,
 * sourceFrameClock,destFrameClock}`.
 * The envelope `(timestamp,id)` is the single transition clock for ALL moved
 * message membership parents. `dest` order is exactly `movedMessageIds`;
 * `source` order is `sourceOrderedChildIds` (remaining source owner order,
 * disjoint from moved). `sourceFrameClock`/`destFrameClock` are the winning
 * frame clocks persisted verbatim with those orders. Ordinary content upserts
 * never carry owner intent; only this op may change `branchId` owners.
 */
function validateMoveTurnsToBranchPayloadStrict(op: {
  id?: unknown
  entityType?: unknown
  entityId?: unknown
  payload?: unknown
}): string | null {
  if (op.entityType !== 'topic_branch') return 'move_turns_to_branch entityType must be topic_branch'
  const payload = op.payload as Record<string, unknown> | undefined | null
  if (payload === undefined || payload === null) return 'move_turns_to_branch missing payload'
  if (typeof payload !== 'object' || Array.isArray(payload)) return 'invalid payload'
  const keys = Object.keys(payload).sort()
  const expected = [
    'anchorMessageId',
    'branchCreatedAt',
    'branchName',
    'branchUpdatedAt',
    'destBranchId',
    'destFrameClock',
    'movedMessageIds',
    'sourceBranchId',
    'sourceFrameClock',
    'sourceOrderedChildIds',
    'topicId'
  ].sort()
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) {
    return 'move_turns_to_branch payload must be exactly {topicId,sourceBranchId,destBranchId,anchorMessageId,movedMessageIds,branchName,branchCreatedAt,branchUpdatedAt,sourceOrderedChildIds,sourceFrameClock,destFrameClock}'
  }
  if (!isNonEmptyString(payload.topicId) || !isValidUnicodeScalarStringLocal(payload.topicId)) {
    return 'move_turns_to_branch invalid topicId'
  }
  const dest = payload.destBranchId
  if (!isNonEmptyString(dest) || !isValidUnicodeScalarStringLocal(dest)) {
    return 'move_turns_to_branch invalid destBranchId'
  }
  if (dest.includes(':')) return 'move_turns_to_branch invalid destBranchId'
  if (dest !== (op as { entityId?: unknown }).entityId) {
    return 'move_turns_to_branch destBranchId must agree with entityId'
  }
  const src = payload.sourceBranchId
  if (src !== null) {
    if (!isNonEmptyString(src) || !isValidUnicodeScalarStringLocal(src)) {
      return 'move_turns_to_branch invalid sourceBranchId'
    }
    if (src.includes(':')) return 'move_turns_to_branch invalid sourceBranchId'
    if (src === dest) return 'move_turns_to_branch source and dest must differ'
  }
  if (!isNonEmptyString(payload.anchorMessageId) || !isValidUnicodeScalarStringLocal(payload.anchorMessageId)) {
    return 'move_turns_to_branch invalid anchorMessageId'
  }
  const moved = payload.movedMessageIds
  if (!Array.isArray(moved) || moved.length === 0) return 'move_turns_to_branch movedMessageIds must be non-empty array'
  const movedSeen = new Set<string>()
  for (const v of moved as unknown[]) {
    if (typeof v !== 'string' || v.length === 0 || !isValidUnicodeScalarStringLocal(v)) {
      return 'move_turns_to_branch invalid movedMessageId'
    }
    if (movedSeen.has(v)) return 'move_turns_to_branch duplicate movedMessageId'
    movedSeen.add(v)
  }
  if (movedSeen.has(payload.anchorMessageId)) return 'move_turns_to_branch anchor must not be moved'
  const bn = payload.branchName
  if (bn !== null && bn !== undefined && typeof bn !== 'string') return 'move_turns_to_branch invalid branchName'
  if (typeof bn === 'string' && !isValidUnicodeScalarStringLocal(bn)) return 'move_turns_to_branch invalid branchName'
  if (!isNonEmptyString(payload.branchCreatedAt)) return 'move_turns_to_branch invalid branchCreatedAt'
  if (!isNonEmptyString(payload.branchUpdatedAt)) return 'move_turns_to_branch invalid branchUpdatedAt'
  const srcOrder = payload.sourceOrderedChildIds
  if (!Array.isArray(srcOrder)) return 'move_turns_to_branch sourceOrderedChildIds must be array'
  const srcSeen = new Set<string>()
  for (const v of srcOrder as unknown[]) {
    if (typeof v !== 'string' || v.length === 0 || !isValidUnicodeScalarStringLocal(v)) {
      return 'move_turns_to_branch invalid sourceOrderedChildId'
    }
    if (srcSeen.has(v)) return 'move_turns_to_branch duplicate sourceOrderedChildId'
    srcSeen.add(v)
    if (movedSeen.has(v)) return 'move_turns_to_branch sourceOrderedChildIds must exclude moved ids'
  }
  if (srcSeen.has(payload.anchorMessageId) === false) {
    // Anchor must remain in the source owner order (empty-source moves are
    // forbidden by the local guard: the predecessor anchor stays source-owned).
    return 'move_turns_to_branch sourceOrderedChildIds must contain anchorMessageId'
  }
  for (const clockKey of ['sourceFrameClock', 'destFrameClock'] as const) {
    const fc = payload[clockKey] as Record<string, unknown> | null | undefined
    if (typeof fc !== 'object' || fc === null || Array.isArray(fc)) {
      return `move_turns_to_branch invalid ${clockKey}`
    }
    const fcKeys = Object.keys(fc).sort()
    if (fcKeys.length !== 2 || fcKeys[0] !== 'operationId' || fcKeys[1] !== 'timestamp') {
      return `move_turns_to_branch ${clockKey} must be exactly {timestamp,operationId}`
    }
    if (typeof fc.timestamp !== 'number' || !Number.isSafeInteger(fc.timestamp) || fc.timestamp < 0) {
      return `move_turns_to_branch invalid ${clockKey} timestamp`
    }
    if (
      typeof fc.operationId !== 'string' ||
      fc.operationId.length === 0 ||
      fc.operationId.length > 256 ||
      fc.operationId.includes(':') ||
      !isValidUnicodeScalarStringLocal(fc.operationId)
    ) {
      return `move_turns_to_branch invalid ${clockKey} operationId`
    }
  }
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
  if (
    op.entityType !== 'topic' &&
    op.entityType !== 'message' &&
    op.entityType !== 'message_block' &&
    op.entityType !== 'topic_branch' &&
    op.entityType !== 'assistant_config' &&
    op.entityType !== 'file_asset'
  ) {
    return `invalid entityType ${String(op.entityType)}`
  }
  if (
    op.op !== 'upsert' &&
    op.op !== 'delete' &&
    op.op !== 'order_frame' &&
    op.op !== 'message_stable_replace' &&
    op.op !== 'move_turns_to_branch'
  )
    return `invalid op ${String(op.op)}`
  if (!isNonEmptyString(op.entityId)) return 'invalid entityId'
  if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp)) return 'invalid timestamp'
  if (!isNonEmptyString(op.deviceId)) return 'invalid deviceId'
  const entityType = op.entityType as string
  const kind = op.op as string
  const payload = op.payload as Record<string, unknown> | undefined | null
  if (kind === 'order_frame') {
    return validateOrderFramePayloadStrict(op, payload)
  }
  if (kind === 'message_stable_replace') {
    // Dedicated strictly-closed stable-replace contract (SYNC-DATA-050):
    // single shared source of truth in stableReplace.ts — never reimplemented here.
    return validateStableReplacePayloadStrict(op)
  }
  if (kind === 'move_turns_to_branch') {
    return validateMoveTurnsToBranchPayloadStrict(op)
  }
  if (kind === 'delete') {
    if (payload !== undefined && payload !== null) {
      if (typeof payload !== 'object' || Array.isArray(payload)) return 'invalid payload'
      if (Object.keys(payload).length > 0) return 'delete must not have payload'
    }
    if (entityType === 'assistant_config') {
      const parsed = parseAssistantConfigKey((op as { entityId?: unknown }).entityId)
      if (!parsed) return 'invalid assistant_config entityId: must be assistant_config:<kind>:<id>'
    }
    return null
  }
  // upsert
  if (payload === undefined || payload === null) return 'upsert missing payload'
  if (typeof payload !== 'object' || Array.isArray(payload)) return 'invalid payload'
  // assistant_config: kind-qualified stable entityId + full DTO strict.
  if (entityType === 'assistant_config') {
    const parsed = parseAssistantConfigKey((op as { entityId?: unknown }).entityId)
    if (!parsed) return 'invalid assistant_config entityId: must be assistant_config:<kind>:<id>'
    const dtoErr = validateAssistantConfigPayload(payload)
    if (dtoErr) return dtoErr
    const p = payload
    if (p.kind !== parsed.kind || p.id !== parsed.id) return 'assistant_config payload kind/id must agree with entityId'
    return null
  }
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
    // Immutable owner route: absent/undefined/null/empty = main route, otherwise
    // a non-empty branch id. Never a synthetic composite key.
    if ('branchId' in payload && payload.branchId !== undefined && payload.branchId !== null) {
      if (!isNonEmptyString(payload.branchId)) return 'invalid message branchId'
      if (typeof payload.branchId === 'string' && !isValidUnicodeScalarStringLocal(payload.branchId)) {
        return 'invalid message branchId'
      }
      if (typeof payload.branchId === 'string' && payload.branchId.includes(':')) {
        return 'invalid message branchId'
      }
    }
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
  // topic_branch
  if (entityType === 'topic_branch') {
    if (!isNonEmptyString(payload.topicId)) return 'branch upsert missing topicId'
    if (!isNonEmptyString(payload.anchorMessageId)) return 'branch upsert missing anchorMessageId'
    if ('parentBranchId' in payload && payload.parentBranchId !== undefined && payload.parentBranchId !== null) {
      if (!isNonEmptyString(payload.parentBranchId)) return 'invalid branch parentBranchId'
      if (typeof payload.parentBranchId === 'string' && !isValidUnicodeScalarStringLocal(payload.parentBranchId)) {
        return 'invalid branch parentBranchId'
      }
    }
    if ('name' in payload && !isOptionalStringOrNull(payload.name)) return 'invalid branch name'
    if ('createdAt' in payload && !isOptionalStringOrNull(payload.createdAt)) return 'invalid branch createdAt'
    if ('updatedAt' in payload && !isOptionalStringOrNull(payload.updatedAt)) return 'invalid branch updatedAt'
    return null
  }
  // file_asset
  if (entityType === 'file_asset') {
    if (!isNonEmptyString(payload.id)) return 'file_asset upsert missing id'
    if (typeof payload.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sha256)) return 'invalid file_asset sha256'
    if (typeof payload.byteLength !== 'number' || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 0)
      return 'invalid file_asset byteLength'
    if (typeof payload.extension !== 'string' || !/^\.[a-z0-9]+$/.test(payload.extension))
      return 'invalid file_asset extension'
    if (!isOptionalStringOrNull(payload.mimeType)) return 'invalid file_asset mimeType'
    if (!isNonEmptyString(payload.originalName)) return 'invalid file_asset originalName'
    if (payload.originalName.includes('/') || payload.originalName.includes('\\'))
      return 'invalid file_asset originalName'
    if (!isOptionalStringOrNull(payload.createdAt)) return 'invalid file_asset createdAt'
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
  if ('assetIds' in payload && payload.assetIds !== undefined && payload.assetIds !== null) {
    if (!Array.isArray(payload.assetIds)) return 'invalid block assetIds'
    const seen = new Set<string>()
    for (const v of payload.assetIds as unknown[]) {
      if (!isNonEmptyString(v)) return 'invalid block assetIds entry'
      if (v.includes('/') || v.includes('\\') || v.includes('..')) return 'invalid block assetIds entry'
      if (seen.has(v)) return 'duplicate block assetIds'
      seen.add(v)
    }
  }
  // Strict portable-media contract (incremental): file/image/video full-state upsert must carry non-empty ordered assetIds;
  // non-media must not carry assetIds (null/absent/empty allowed, non-empty forbidden).
  // Patch paths that omit type are validated by the applier against stored type (stored-type wins);
  // here we validate only when payload explicitly declares a portable type.
  const rawType = typeof payload.type === 'string' ? payload.type.toLowerCase() : ''
  const isPortablePayload = rawType === 'file' || rawType === 'image' || rawType === 'video'
  if (isPortablePayload) {
    const ids = payload.assetIds as unknown[] | undefined | null
    if (!Array.isArray(ids) || ids.length === 0) return 'portable media block requires non-empty assetIds'
  } else if (payload.type !== undefined) {
    // Non-portable explicit type must not carry non-empty assetIds (empty [] is tolerated as absent)
    const ids = payload.assetIds as unknown[] | undefined | null
    if (Array.isArray(ids) && ids.length > 0) return 'non-media block must not have assetIds'
  }
  return null
}
