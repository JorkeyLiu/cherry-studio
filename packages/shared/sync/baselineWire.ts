/**
 * sync-baseline-wire-v1 pure protocol module.
 * Strict validators, canonical JCS digest helpers, tombstone ordering, duplicate-key scan.
 * No Node/Electron imports; digest is injected.
 *
 * Note: local candidate projection (validating a candidate baseline that lacks
 * parent membership clocks for newly created children) is not implemented here
 * because the wire requires complete parentMembershipClocks; candidate gaps are
 * the publisher's responsibility.
 */

// canonicalize@2.1.0 is CJS (module.exports = fn). With esModuleInterop (toolkit tsconfig)
// `import canonicalize from 'canonicalize'` resolves to the function. For bundlers that
// interop via `default` property, unwrap defensively without using `any` to bypass types.
import canonicalizeImport from 'canonicalize'

const canonicalize: (value: unknown) => string | undefined = (() => {
  const mod = canonicalizeImport as unknown as { default?: (v: unknown) => string | undefined }
  if (typeof (mod as unknown as () => unknown) === 'function') {
    return mod as unknown as (v: unknown) => string | undefined
  }
  if (mod && typeof mod.default === 'function') return mod.default
  // Fallback: the import itself is the function (common CJS interop)
  return canonicalizeImport as unknown as (v: unknown) => string | undefined
})()

// ---------------------------------------------------------------------------
// Constants (locked per SYNC-DATA-027/032/040/041/045 + §10A.1)
// ---------------------------------------------------------------------------

export const WIRE_VERSION = 'sync-baseline-wire-v1' as const
export const PAYLOAD_SCHEMA = 'chat-core-baseline-v1' as const
export const INVENTORY_VERSION = 'topic-message-stable-block-order-v1' as const
export const ORDER_FRAME_VERSION = 'parent-order-frame-v1' as const
export const SCOPE = 'chat-core-baseline-v1:topic-message-stable-block-order-v1' as const
export const DIGEST_SCHEME = 'jcs-sha256-v1' as const
export const COMPLETENESS_COMPLETE = 'complete' as const

// Baseline v2 literals (SYNC-DATA-056 / §10B): outer wire + payload triple +
// scope. Order-frame family stays parent-order-frame-v1 (object unchanged).
export const WIRE_VERSION_V2 = 'sync-baseline-wire-v2' as const
export const PAYLOAD_SCHEMA_V2 = 'chat-core-baseline-v2' as const
export const INVENTORY_VERSION_V2 = 'topic-message-stable-block-order-v2' as const
export const SCOPE_V2 = 'chat-core-baseline-v2:topic-message-stable-block-order-v2' as const

// Baseline v3 literals (true-branch full sync): outer wire + payload triple +
// scope for the branch inventory. Order-frame family stays
// parent-order-frame-v1 (object unchanged); the inventory adds the
// branchSuffix kind alongside topicMessage/messageBlock.
export const WIRE_VERSION_V3 = 'sync-baseline-wire-v3' as const
export const PAYLOAD_SCHEMA_V3 = 'chat-core-baseline-v3' as const
export const INVENTORY_VERSION_V3 = 'topic-message-stable-block-order-branch-v3' as const
export const SCOPE_V3 = 'chat-core-baseline-v3:topic-message-stable-block-order-branch-v3' as const

// Baseline v4 literals (assistant-config full sync, branch + assistant only).
// No attachments domain in this revision (v5 may add it with a new revision).
// Order-frame family stays parent-order-frame-v1 (object unchanged).
export const WIRE_VERSION_V4 = 'sync-baseline-wire-v4' as const
export const PAYLOAD_SCHEMA_V4 = 'chat-core-baseline-v4' as const
export const INVENTORY_VERSION_V4 = 'topic-message-stable-block-order-branch-assistant-v4' as const
export const SCOPE_V4 = 'chat-core-baseline-v4:topic-message-stable-block-order-branch-assistant-v4' as const

// Baseline v5 literals (attachment full sync: branch + assistant + file/image/video attachments).
// Inventory: topic-message-stable-block-order-branch-assistant-attachment-v5 at
// sync-baseline-wire-v5 / chat-core-baseline-v5 / parent-order-frame-v1.
// Order-frame family stays parent-order-frame-v1 (object unchanged).
export const WIRE_VERSION_V5 = 'sync-baseline-wire-v5' as const
export const PAYLOAD_SCHEMA_V5 = 'chat-core-baseline-v5' as const
export const INVENTORY_VERSION_V5 = 'topic-message-stable-block-order-branch-assistant-attachment-v5' as const
export const SCOPE_V5 = 'chat-core-baseline-v5:topic-message-stable-block-order-branch-assistant-attachment-v5' as const

/** Rank for regressive-wire rejection (higher never downgrades to lower). */
export const WIRE_VERSION_RANK: Record<string, number> = {
  'sync-baseline-wire-v1': 1,
  'sync-baseline-wire-v2': 2,
  'sync-baseline-wire-v3': 3,
  'sync-baseline-wire-v4': 4,
  'sync-baseline-wire-v5': 5
}

export const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER
export const OPERATION_ID_MAX_LENGTH = 256

export const TRANSIENT_STATUSES = ['streaming', 'pending', 'processing', 'searching'] as const
export const UNSUPPORTED_BLOCK_TYPES = ['tool', 'file', 'image', 'video', 'citation'] as const

// ---------------------------------------------------------------------------
// Types (wire JSON keys are lowerCamelCase, exact)
// ---------------------------------------------------------------------------

export interface SyncClock {
  timestamp: number
  operationId: string
}

export interface DeletionClock {
  timestamp: number
  operationId: string | null
}

export interface TopicEntity {
  id: string
  name: string | null
  assistantId: string | null
  createdAt: string | null
  updatedAt: string | null
  deletedAt: string | null
  pinned: boolean | null
  prompt: string | null
  isNameManuallyEdited: boolean | null
  entityClock: SyncClock
  fieldClocks: Record<TopicFieldClockKey, SyncClock>
}

export type TopicFieldClockKey =
  | 'name'
  | 'assistantId'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'pinned'
  | 'prompt'
  | 'isNameManuallyEdited'

export interface MessageEntity {
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
  entityClock: SyncClock
  fieldClocks: Record<MessageFieldClockKey, SyncClock>
  parentMembershipClock: SyncClock
}

export type MessageFieldClockKey =
  | 'role'
  | 'content'
  | 'status'
  | 'askId'
  | 'model'
  | 'modelId'
  | 'assistantId'
  | 'createdAt'
  | 'updatedAt'

export interface MessageBlockEntity {
  id: string
  messageId: string
  type: string | null
  content: string | null
  status: string | null
  createdAt: string | null
  updatedAt: string | null
  entityClock: SyncClock
  fieldClocks: Record<BlockFieldClockKey, SyncClock>
  parentMembershipClock: SyncClock
}

export type BlockFieldClockKey = 'type' | 'content' | 'status' | 'createdAt' | 'updatedAt'

export type TombstoneEntityType = 'topic' | 'message' | 'messageBlock'

export interface Tombstone {
  entityType: TombstoneEntityType
  entityId: string
  deletionClock: DeletionClock
  survivingEntityClock: SyncClock | null
}

export type OrderFrameKind = 'topicMessage' | 'messageBlock'

export interface OrderFrame {
  frameVersion: typeof ORDER_FRAME_VERSION
  kind: OrderFrameKind
  parentId: string
  orderedChildIds: string[]
  frameClock: SyncClock
}

export interface Manifest {
  payloadSchema: typeof PAYLOAD_SCHEMA
  inventoryVersion: typeof INVENTORY_VERSION
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE
  liveCounts: { topic: number; message: number; messageBlock: number }
  tombstoneCounts: { topic: number; message: number; messageBlock: number }
  frameCounts: { topicMessage: number; messageBlock: number }
  completeness: typeof COMPLETENESS_COMPLETE
}

export interface SyncPayload {
  payloadSchema: typeof PAYLOAD_SCHEMA
  inventoryVersion: typeof INVENTORY_VERSION
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE
  topics: TopicEntity[]
  messages: MessageEntity[]
  messageBlocks: MessageBlockEntity[]
  tombstones: Tombstone[]
  orderFrames: OrderFrame[]
  manifest: Manifest
}

export interface SyncEnvelope {
  wireVersion: typeof WIRE_VERSION
  channelId: string
  watermark: number
  digestScheme: typeof DIGEST_SCHEME
  digest: string
  payload: SyncPayload
}

// Baseline v2 types (SYNC-DATA-056 / §10B): same v1 content plus a
// strictly-closed replacementRegisters array. Each entry carries exactly the
// locked keys {messageId, replacementClock, activeBlockIds} with
// activeBlockIds in business order. The manifest gains replacementCount.
export interface ReplacementRegister {
  messageId: string
  replacementClock: SyncClock
  activeBlockIds: string[]
}

export interface ManifestV2 {
  payloadSchema: typeof PAYLOAD_SCHEMA_V2
  inventoryVersion: typeof INVENTORY_VERSION_V2
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE_V2
  liveCounts: { topic: number; message: number; messageBlock: number }
  tombstoneCounts: { topic: number; message: number; messageBlock: number }
  frameCounts: { topicMessage: number; messageBlock: number }
  replacementCount: number
  completeness: typeof COMPLETENESS_COMPLETE
}

export interface SyncPayloadV2 {
  payloadSchema: typeof PAYLOAD_SCHEMA_V2
  inventoryVersion: typeof INVENTORY_VERSION_V2
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE_V2
  topics: TopicEntity[]
  messages: MessageEntity[]
  messageBlocks: MessageBlockEntity[]
  tombstones: Tombstone[]
  orderFrames: OrderFrame[]
  replacementRegisters: ReplacementRegister[]
  manifest: ManifestV2
}

export interface SyncEnvelopeV2 {
  wireVersion: typeof WIRE_VERSION_V2
  channelId: string
  watermark: number
  digestScheme: typeof DIGEST_SCHEME
  digest: string
  payload: SyncPayloadV2
}

export type SyncPayloadAny = SyncPayload | SyncPayloadV2 | SyncPayloadV3 | SyncPayloadV4 | SyncPayloadV5
export type SyncEnvelopeAny = SyncEnvelope | SyncEnvelopeV2 | SyncEnvelopeV3 | SyncEnvelopeV4 | SyncEnvelopeV5
export type ValidatedSyncPayloadAny =
  | ValidatedSyncPayload
  | (SyncPayloadV2 & { readonly [ValidatedPayloadBrand]: true })
  | (SyncPayloadV3 & { readonly [ValidatedPayloadBrand]: true })
  | (SyncPayloadV4 & { readonly [ValidatedPayloadBrand]: true })
  | (SyncPayloadV5 & { readonly [ValidatedPayloadBrand]: true })
export type ValidatedSyncEnvelopeAny =
  | ValidatedSyncEnvelope
  | (SyncEnvelopeV2 & { readonly [ValidatedEnvelopeBrand]: true })
  | (SyncEnvelopeV3 & { readonly [ValidatedEnvelopeBrand]: true })
  | (SyncEnvelopeV4 & { readonly [ValidatedEnvelopeBrand]: true })
  | (SyncEnvelopeV5 & { readonly [ValidatedEnvelopeBrand]: true })

// Branded validated types: ensures only strictly validated values are used for digest.
// The brand is compile-time only; runtime validation is still enforced in digest helpers.
declare const ValidatedPayloadBrand: unique symbol
declare const ValidatedEnvelopeBrand: unique symbol
export type ValidatedSyncPayload = SyncPayload & { readonly [ValidatedPayloadBrand]: true }
export type ValidatedSyncEnvelope = SyncEnvelope & { readonly [ValidatedEnvelopeBrand]: true }

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  path: string
  constructor(message: string, path: string) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'ValidationError'
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// Unicode / UTF-8 helpers
// ---------------------------------------------------------------------------

function isValidUnicodeScalarString(str: string): boolean {
  // Reject lone surrogates and code points > 0x10FFFF
  // Iterate via codePointAt which combines surrogate pairs when valid
  let i = 0
  const len = str.length
  while (i < len) {
    const cp = str.codePointAt(i)!
    if (cp >= 0xd800 && cp <= 0xdfff) return false // lone surrogate (codePointAt returns surrogate unit when unpaired)
    if (cp > 0x10ffff) return false
    i += cp > 0xffff ? 2 : 1
  }
  return true
}

function assertValidUnicodeScalarString(value: string, path: string): void {
  if (!isValidUnicodeScalarString(value)) {
    throw new ValidationError('invalid Unicode scalar (lone surrogate or illegal code point)', path)
  }
}

function assertNonEmptyValidUnicodeScalarString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ValidationError('must be string', path)
  if (value.length === 0) throw new ValidationError('must be non-empty string', path)
  assertValidUnicodeScalarString(value, path)
  return value
}

function assertNullableValidUnicodeScalarString(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new ValidationError('must be string|null', path)
  assertValidUnicodeScalarString(value, path)
  return value
}

function assertNullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  throw new ValidationError('must be boolean|null', path)
}

function utf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

export function compareUtf8ByteLex(a: string, b: string): number {
  const ba = utf8Bytes(a)
  const bb = utf8Bytes(b)
  const len = Math.min(ba.length, bb.length)
  for (let i = 0; i < len; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i]
  }
  return ba.length - bb.length
}

// ---------------------------------------------------------------------------
// Plain object/array helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assertPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValidationError('must be plain JSON object', path)
  return value as Record<string, unknown>
}

function assertPlainArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError('must be plain JSON array', path)
  // Ensure no extra prototype pollution
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ValidationError('must be plain JSON array', path)
  }
  return value
}

function assertExactKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  const keys = Object.keys(obj)
  if (keys.length !== allowed.size) {
    const missing = [...allowed].filter((k) => !(k in obj))
    const extra = keys.filter((k) => !allowed.has(k))
    if (missing.length > 0) throw new ValidationError(`missing required key "${missing[0]}"`, path)
    if (extra.length > 0) throw new ValidationError(`unknown key "${extra[0]}"`, path)
    throw new ValidationError('exact keys mismatch', path)
  }
  for (const k of keys) {
    if (!allowed.has(k)) throw new ValidationError(`unknown key "${k}"`, path)
  }
}

function assertSafeNonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError('must be safe non-negative integer', path)
  }
  return value
}

function assertOperationId(value: unknown, path: string, allowNull: boolean): string | null {
  if (allowNull && value === null) return null
  if (typeof value !== 'string') throw new ValidationError('operationId must be string', path)
  if (value.length === 0 || value.length > OPERATION_ID_MAX_LENGTH) {
    throw new ValidationError('operationId must be non-empty and <=256', path)
  }
  if (value.includes(':')) throw new ValidationError('operationId must not contain colon', path)
  assertValidUnicodeScalarString(value, path)
  return value
}

// ---------------------------------------------------------------------------
// Clock validators
// ---------------------------------------------------------------------------

const CLOCK_KEYS = new Set<string>(['timestamp', 'operationId'])

export function validateClock(value: unknown, path: string, allowNullOperationId: boolean): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, CLOCK_KEYS, path)
  assertSafeNonNegativeInt(obj.timestamp, `${path}.timestamp`)
  assertOperationId(obj.operationId, `${path}.operationId`, allowNullOperationId)
}

// ---------------------------------------------------------------------------
// FieldClocks
// ---------------------------------------------------------------------------

const TOPIC_FIELD_CLOCK_KEYS: ReadonlySet<string> = new Set([
  'name',
  'assistantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited'
])
const MESSAGE_FIELD_CLOCK_KEYS: ReadonlySet<string> = new Set([
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
const BLOCK_FIELD_CLOCK_KEYS: ReadonlySet<string> = new Set(['type', 'content', 'status', 'createdAt', 'updatedAt'])

function validateFieldClocks(value: unknown, expectedKeys: ReadonlySet<string>, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, expectedKeys, path)
  for (const k of expectedKeys) {
    validateClock(obj[k], `${path}.${k}`, false)
  }
}

// ---------------------------------------------------------------------------
// Entity validators
// ---------------------------------------------------------------------------

const TOPIC_KEYS = new Set<string>([
  'id',
  'name',
  'assistantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited',
  'entityClock',
  'fieldClocks'
])
const MESSAGE_KEYS = new Set<string>([
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
  'entityClock',
  'fieldClocks',
  'parentMembershipClock'
])
const MESSAGE_BLOCK_KEYS = new Set<string>([
  'id',
  'messageId',
  'type',
  'content',
  'status',
  'createdAt',
  'updatedAt',
  'entityClock',
  'fieldClocks',
  'parentMembershipClock'
])

const TRANSIENT_SET = new Set<string>([...TRANSIENT_STATUSES])
const UNSUPPORTED_BLOCK_TYPE_SET = new Set<string>([...UNSUPPORTED_BLOCK_TYPES].map((s) => s.toLowerCase()))

function validateTopic(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, TOPIC_KEYS, path)
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  assertNullableValidUnicodeScalarString(obj.name, `${path}.name`)
  assertNullableValidUnicodeScalarString(obj.assistantId, `${path}.assistantId`)
  assertNullableValidUnicodeScalarString(obj.createdAt, `${path}.createdAt`)
  assertNullableValidUnicodeScalarString(obj.updatedAt, `${path}.updatedAt`)
  assertNullableValidUnicodeScalarString(obj.deletedAt, `${path}.deletedAt`)
  assertNullableBoolean(obj.pinned, `${path}.pinned`)
  assertNullableValidUnicodeScalarString(obj.prompt, `${path}.prompt`)
  assertNullableBoolean(obj.isNameManuallyEdited, `${path}.isNameManuallyEdited`)
  validateClock(obj.entityClock, `${path}.entityClock`, false)
  validateFieldClocks(obj.fieldClocks, TOPIC_FIELD_CLOCK_KEYS, `${path}.fieldClocks`)
}

export function validateMessage(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MESSAGE_KEYS, path)
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  assertNonEmptyValidUnicodeScalarString(obj.topicId, `${path}.topicId`)
  assertNullableValidUnicodeScalarString(obj.role, `${path}.role`)
  assertNullableValidUnicodeScalarString(obj.content, `${path}.content`)
  const status = assertNullableValidUnicodeScalarString(obj.status, `${path}.status`)
  if (status !== null && TRANSIENT_SET.has(status)) {
    throw new ValidationError(`transient status "${status}" not allowed on wire`, `${path}.status`)
  }
  assertNullableValidUnicodeScalarString(obj.askId, `${path}.askId`)
  assertNullableValidUnicodeScalarString(obj.model, `${path}.model`)
  assertNullableValidUnicodeScalarString(obj.modelId, `${path}.modelId`)
  assertNullableValidUnicodeScalarString(obj.assistantId, `${path}.assistantId`)
  assertNullableValidUnicodeScalarString(obj.createdAt, `${path}.createdAt`)
  assertNullableValidUnicodeScalarString(obj.updatedAt, `${path}.updatedAt`)
  validateClock(obj.entityClock, `${path}.entityClock`, false)
  validateFieldClocks(obj.fieldClocks, MESSAGE_FIELD_CLOCK_KEYS, `${path}.fieldClocks`)
  validateClock(obj.parentMembershipClock, `${path}.parentMembershipClock`, false)
}

export function validateMessageBlock(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MESSAGE_BLOCK_KEYS, path)
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  assertNonEmptyValidUnicodeScalarString(obj.messageId, `${path}.messageId`)
  const typeVal = assertNullableValidUnicodeScalarString(obj.type, `${path}.type`)
  if (typeVal !== null) {
    const canonical = typeVal.trim().toLowerCase()
    if (UNSUPPORTED_BLOCK_TYPE_SET.has(canonical)) {
      throw new ValidationError(`unsupported block type "${typeVal}"`, `${path}.type`)
    }
  }
  assertNullableValidUnicodeScalarString(obj.content, `${path}.content`)
  const status = assertNullableValidUnicodeScalarString(obj.status, `${path}.status`)
  if (status !== null && TRANSIENT_SET.has(status)) {
    throw new ValidationError(`transient status "${status}" not allowed on wire`, `${path}.status`)
  }
  assertNullableValidUnicodeScalarString(obj.createdAt, `${path}.createdAt`)
  assertNullableValidUnicodeScalarString(obj.updatedAt, `${path}.updatedAt`)
  validateClock(obj.entityClock, `${path}.entityClock`, false)
  validateFieldClocks(obj.fieldClocks, BLOCK_FIELD_CLOCK_KEYS, `${path}.fieldClocks`)
  validateClock(obj.parentMembershipClock, `${path}.parentMembershipClock`, false)
}

// ---------------------------------------------------------------------------
// Tombstone / OrderFrame / Manifest
// ---------------------------------------------------------------------------

const TOMBSTONE_KEYS = new Set<string>(['entityType', 'entityId', 'deletionClock', 'survivingEntityClock'])
const TOMBSTONE_ENTITY_TYPES: ReadonlySet<string> = new Set(['topic', 'message', 'messageBlock'])
const ORDER_FRAME_KEYS = new Set<string>(['frameVersion', 'kind', 'parentId', 'orderedChildIds', 'frameClock'])
const ORDER_FRAME_KINDS: ReadonlySet<string> = new Set(['topicMessage', 'messageBlock'])
const MANIFEST_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'liveCounts',
  'tombstoneCounts',
  'frameCounts',
  'completeness'
])
const LIVE_COUNTS_KEYS = new Set<string>(['topic', 'message', 'messageBlock'])
const TOMBSTONE_COUNTS_KEYS = new Set<string>(['topic', 'message', 'messageBlock'])
const FRAME_COUNTS_KEYS = new Set<string>(['topicMessage', 'messageBlock'])

function validateTombstone(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, TOMBSTONE_KEYS, path)
  if (typeof obj.entityType !== 'string' || !TOMBSTONE_ENTITY_TYPES.has(obj.entityType)) {
    throw new ValidationError(`entityType must be one of topic,message,messageBlock`, `${path}.entityType`)
  }
  if (typeof obj.entityType === 'string') assertValidUnicodeScalarString(obj.entityType, `${path}.entityType`)
  assertNonEmptyValidUnicodeScalarString(obj.entityId, `${path}.entityId`)
  validateClock(obj.deletionClock, `${path}.deletionClock`, true)
  if (obj.survivingEntityClock === null) {
    // ok
  } else {
    validateClock(obj.survivingEntityClock, `${path}.survivingEntityClock`, false)
  }
}

export function validateOrderFrame(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, ORDER_FRAME_KEYS, path)
  if (obj.frameVersion !== ORDER_FRAME_VERSION) {
    throw new ValidationError(`frameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.frameVersion`)
  }
  if (typeof obj.kind !== 'string' || !ORDER_FRAME_KINDS.has(obj.kind)) {
    throw new ValidationError('kind must be topicMessage|messageBlock', `${path}.kind`)
  }
  if (typeof obj.kind === 'string') assertValidUnicodeScalarString(obj.kind, `${path}.kind`)
  assertNonEmptyValidUnicodeScalarString(obj.parentId, `${path}.parentId`)
  const arr = assertPlainArray(obj.orderedChildIds, `${path}.orderedChildIds`)
  const seen = new Set<string>()
  for (let i = 0; i < arr.length; i++) {
    const cid = arr[i]
    const p = `${path}.orderedChildIds[${i}]`
    assertNonEmptyValidUnicodeScalarString(cid, p)
    if (seen.has(cid as string)) throw new ValidationError(`duplicate orderedChildIds "${cid}"`, p)
    seen.add(cid as string)
  }
  validateClock(obj.frameClock, `${path}.frameClock`, false)
}

function validateManifest(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MANIFEST_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE) throw new ValidationError(`scope must be "${SCOPE}"`, `${path}.scope`)
  const liveCounts = assertPlainObject(obj.liveCounts, `${path}.liveCounts`)
  assertExactKeys(liveCounts, LIVE_COUNTS_KEYS, `${path}.liveCounts`)
  for (const k of LIVE_COUNTS_KEYS) assertSafeNonNegativeInt(liveCounts[k], `${path}.liveCounts.${k}`)
  const tCounts = assertPlainObject(obj.tombstoneCounts, `${path}.tombstoneCounts`)
  assertExactKeys(tCounts, TOMBSTONE_COUNTS_KEYS, `${path}.tombstoneCounts`)
  for (const k of TOMBSTONE_COUNTS_KEYS) assertSafeNonNegativeInt(tCounts[k], `${path}.tombstoneCounts.${k}`)
  const fCounts = assertPlainObject(obj.frameCounts, `${path}.frameCounts`)
  assertExactKeys(fCounts, FRAME_COUNTS_KEYS, `${path}.frameCounts`)
  for (const k of FRAME_COUNTS_KEYS) assertSafeNonNegativeInt(fCounts[k], `${path}.frameCounts.${k}`)
  if (obj.completeness !== COMPLETENESS_COMPLETE)
    throw new ValidationError('completeness must be "complete"', `${path}.completeness`)
}

// ---------------------------------------------------------------------------
// Ordering + duplicate helpers
// ---------------------------------------------------------------------------

function assertStrictlySortedByUtf8<T>(arr: T[], getId: (v: T) => string, path: string): void {
  for (let i = 1; i < arr.length; i++) {
    const prev = getId(arr[i - 1])
    const cur = getId(arr[i])
    if (compareUtf8ByteLex(prev, cur) >= 0) {
      if (prev === cur) throw new ValidationError(`duplicate id "${cur}"`, `${path}[${i}]`)
      throw new ValidationError(`array not sorted UTF-8 byte lex: "${prev}" >= "${cur}"`, path)
    }
  }
}

// ---------------------------------------------------------------------------
// Clock comparison pure functions
// ---------------------------------------------------------------------------

export function compareClocks(a: SyncClock, b: SyncClock): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  return compareUtf8ByteLex(a.operationId, b.operationId)
}

export function compareDeletionClocks(a: DeletionClock, b: DeletionClock): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  if (a.operationId === null && b.operationId === null) return 0
  if (a.operationId === null && b.operationId !== null) return 1 // (T,null) > (T,nonNull)
  if (a.operationId !== null && b.operationId === null) return -1
  return compareUtf8ByteLex(a.operationId as string, b.operationId as string)
}

/**
 * Compare membership clock to frame clock (both non-null SyncClocks).
 * Returns negative if membership < frame, 0 if equal, positive if >.
 */
export function compareMembershipToFrameClock(membership: SyncClock, frame: SyncClock): number {
  return compareClocks(membership, frame)
}

// ---------------------------------------------------------------------------
// Duplicate-key linear scan (raw JSON) - internal helper, not exported
// ---------------------------------------------------------------------------

function decodeJsonString(raw: string, start: number): { decoded: string; end: number } {
  // start is index of opening "
  let pos = start + 1
  let decoded = ''
  const len = raw.length
  while (pos < len) {
    const ch = raw[pos]
    if (ch === '"') {
      return { decoded, end: pos + 1 }
    }
    if (ch === '\\') {
      pos++
      if (pos >= len) break
      const esc = raw[pos]
      if (esc === '"') decoded += '"'
      else if (esc === '\\') decoded += '\\'
      else if (esc === '/') decoded += '/'
      else if (esc === 'b') decoded += '\b'
      else if (esc === 'f') decoded += '\f'
      else if (esc === 'n') decoded += '\n'
      else if (esc === 'r') decoded += '\r'
      else if (esc === 't') decoded += '\t'
      else if (esc === 'u') {
        const hex = raw.slice(pos + 1, pos + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          const code = parseInt(hex, 16)
          decoded += String.fromCharCode(code)
          pos += 4
        } else {
          decoded += '\\u'
        }
      } else {
        decoded += esc
      }
      pos++
    } else {
      decoded += ch
      pos++
    }
  }
  // Unterminated string; let JSON.parse report syntax error. Return what we have.
  return { decoded, end: pos }
}

function assertNoDuplicateKeys(json: string): void {
  type StackEntry = { type: 'object' | 'array'; keys: Set<string>; expectKey: boolean }
  const stack: StackEntry[] = []
  let i = 0
  const len = json.length

  const skipWhitespace = (): void => {
    while (i < len && (json[i] === ' ' || json[i] === '\n' || json[i] === '\r' || json[i] === '\t')) i++
  }

  while (i < len) {
    skipWhitespace()
    if (i >= len) break
    const ch = json[i]
    if (ch === '"') {
      const { decoded, end } = decodeJsonString(json, i)
      const top = stack[stack.length - 1]
      if (top && top.type === 'object' && top.expectKey) {
        // Look ahead for colon to determine if this string is a key
        let j = end
        while (j < len && (json[j] === ' ' || json[j] === '\n' || json[j] === '\r' || json[j] === '\t')) j++
        if (j < len && json[j] === ':') {
          if (top.keys.has(decoded)) {
            throw new ValidationError(`duplicate key "${decoded}"`, `$.${decoded}`)
          }
          top.keys.add(decoded)
          top.expectKey = false
          i = end
          continue
        } else {
          // Value string while expecting key but not followed by colon -> treat as value (will be syntax error later, but mark object as not expecting key)
          top.expectKey = false
          i = end
          continue
        }
      } else {
        // Value string
        i = end
        continue
      }
    } else if (ch === '{') {
      stack.push({ type: 'object', keys: new Set<string>(), expectKey: true })
      i++
    } else if (ch === '}') {
      stack.pop()
      i++
    } else if (ch === '[') {
      stack.push({ type: 'array', keys: new Set<string>(), expectKey: false })
      i++
    } else if (ch === ']') {
      stack.pop()
      i++
    } else if (ch === ':') {
      i++
    } else if (ch === ',') {
      const top = stack[stack.length - 1]
      if (top && top.type === 'object') top.expectKey = true
      i++
    } else if (ch === 't' && json.slice(i, i + 4) === 'true') {
      i += 4
    } else if (ch === 'f' && json.slice(i, i + 5) === 'false') {
      i += 5
    } else if (ch === 'n' && json.slice(i, i + 4) === 'null') {
      i += 4
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let k = i
      if (json[k] === '-') k++
      while (k < len && json[k] >= '0' && json[k] <= '9') k++
      if (k < len && json[k] === '.') {
        k++
        while (k < len && json[k] >= '0' && json[k] <= '9') k++
      }
      if (k < len && (json[k] === 'e' || json[k] === 'E')) {
        k++
        if (k < len && (json[k] === '+' || json[k] === '-')) k++
        while (k < len && json[k] >= '0' && json[k] <= '9') k++
      }
      i = k
    } else {
      // Other char (whitespace already handled); skip
      i++
    }
  }
}

// ---------------------------------------------------------------------------
// Payload / Envelope validators
// ---------------------------------------------------------------------------

const PAYLOAD_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'topics',
  'messages',
  'messageBlocks',
  'tombstones',
  'orderFrames',
  'manifest'
])

const ENVELOPE_KEYS = new Set<string>(['wireVersion', 'channelId', 'watermark', 'digestScheme', 'digest', 'payload'])

function validatePayloadStructure(value: unknown, path: string): SyncPayload {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, PAYLOAD_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE) throw new ValidationError(`scope must be "${SCOPE}"`, `${path}.scope`)

  const topics = assertPlainArray(obj.topics, `${path}.topics`)
  topics.forEach((t, idx) => validateTopic(t, `${path}.topics[${idx}]`))

  const messages = assertPlainArray(obj.messages, `${path}.messages`)
  messages.forEach((m, idx) => validateMessage(m, `${path}.messages[${idx}]`))

  const blocks = assertPlainArray(obj.messageBlocks, `${path}.messageBlocks`)
  blocks.forEach((b, idx) => validateMessageBlock(b, `${path}.messageBlocks[${idx}]`))

  const tombstones = assertPlainArray(obj.tombstones, `${path}.tombstones`)
  tombstones.forEach((t, idx) => validateTombstone(t, `${path}.tombstones[${idx}]`))

  const frames = assertPlainArray(obj.orderFrames, `${path}.orderFrames`)
  frames.forEach((f, idx) => validateOrderFrame(f, `${path}.orderFrames[${idx}]`))

  validateManifest(obj.manifest, `${path}.manifest`)

  // Array ordering + duplicate checks
  assertStrictlySortedByUtf8(topics as TopicEntity[], (v) => v.id, `${path}.topics`)
  assertStrictlySortedByUtf8(messages as MessageEntity[], (v) => v.id, `${path}.messages`)
  assertStrictlySortedByUtf8(blocks as MessageBlockEntity[], (v) => v.id, `${path}.messageBlocks`)

  // Tombstones: type rank then entityId lex
  const tombRank = (t: Tombstone): number => {
    if (t.entityType === 'topic') return 0
    if (t.entityType === 'message') return 1
    return 2
  }
  for (let i = 1; i < tombstones.length; i++) {
    const prev = tombstones[i - 1] as Tombstone
    const cur = tombstones[i] as Tombstone
    const pr = tombRank(prev)
    const cr = tombRank(cur)
    if (cr < pr) throw new ValidationError('tombstones not sorted by type rank', `${path}.tombstones`)
    if (cr === pr) {
      const cmp = compareUtf8ByteLex(prev.entityId, cur.entityId)
      if (cmp >= 0) {
        if (cmp === 0)
          throw new ValidationError(`duplicate tombstone ${cur.entityType}:${cur.entityId}`, `${path}.tombstones[${i}]`)
        throw new ValidationError('tombstones not sorted by entityId', `${path}.tombstones`)
      }
    }
  }

  // OrderFrames: kind rank then parentId
  const frameRank = (f: OrderFrame): number => (f.kind === 'topicMessage' ? 0 : 1)
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1] as OrderFrame
    const cur = frames[i] as OrderFrame
    const pr = frameRank(prev)
    const cr = frameRank(cur)
    if (cr < pr) throw new ValidationError('orderFrames not sorted by kind rank', `${path}.orderFrames`)
    if (cr === pr) {
      const cmp = compareUtf8ByteLex(prev.parentId, cur.parentId)
      if (cmp >= 0) {
        if (cmp === 0)
          throw new ValidationError(`duplicate frame ${cur.kind}:${cur.parentId}`, `${path}.orderFrames[${i}]`)
        throw new ValidationError('orderFrames not sorted by parentId', `${path}.orderFrames`)
      }
    }
  }

  // Parent / closure / frame coverage / membershipClock suffix
  validatePayloadClosure(obj as unknown as SyncPayload, path)

  // Manifest recompute
  validateManifestRecompute(obj as unknown as SyncPayload, path)

  return obj as unknown as SyncPayload
}

function validatePayloadClosure(payload: SyncPayload, path: string): void {
  const topicIds = new Set<string>(payload.topics.map((t) => t.id))
  const messageById = new Map<string, MessageEntity>()
  for (const m of payload.messages) {
    if (messageById.has(m.id)) throw new ValidationError(`duplicate message id "${m.id}"`, `${path}.messages`)
    messageById.set(m.id, m)
  }
  const blockById = new Map<string, MessageBlockEntity>()
  for (const b of payload.messageBlocks) {
    if (blockById.has(b.id)) throw new ValidationError(`duplicate block id "${b.id}"`, `${path}.messageBlocks`)
    blockById.set(b.id, b)
  }

  // Parent checks
  for (const m of payload.messages) {
    if (!topicIds.has(m.topicId)) {
      throw new ValidationError(`message parent topic "${m.topicId}" must be live`, `${path}.messages`)
    }
  }
  for (const b of payload.messageBlocks) {
    if (!messageById.has(b.messageId)) {
      throw new ValidationError(`block parent message "${b.messageId}" must be live`, `${path}.messageBlocks`)
    }
  }

  // Tombstone checks
  const tombstoneKeySet = new Set<string>()
  for (const t of payload.tombstones) {
    const key = `${t.entityType}:${t.entityId}`
    if (tombstoneKeySet.has(key)) throw new ValidationError(`duplicate tombstone ${key}`, `${path}.tombstones`)
    tombstoneKeySet.add(key)
  }
  // live vs tombstone overlap
  for (const t of payload.tombstones) {
    if (t.entityType === 'topic' && topicIds.has(t.entityId))
      throw new ValidationError(`entity both live and tombstoned: topic ${t.entityId}`, `${path}.tombstones`)
    if (t.entityType === 'message' && messageById.has(t.entityId))
      throw new ValidationError(`entity both live and tombstoned: message ${t.entityId}`, `${path}.tombstones`)
    if (t.entityType === 'messageBlock' && blockById.has(t.entityId))
      throw new ValidationError(`entity both live and tombstoned: messageBlock ${t.entityId}`, `${path}.tombstones`)
  }

  // Frame closure
  const frameByKey = new Map<string, OrderFrame>()
  for (const f of payload.orderFrames) {
    const key = `${f.kind}:${f.parentId}`
    if (frameByKey.has(key)) throw new ValidationError(`duplicate frame ${key}`, `${path}.orderFrames`)
    frameByKey.set(key, f)
  }

  // Every live topic exactly one topicMessage frame, every live message exactly one messageBlock frame
  for (const tid of topicIds) {
    const key = `topicMessage:${tid}`
    if (!frameByKey.has(key))
      throw new ValidationError(`missing topicMessage frame for topic "${tid}"`, `${path}.orderFrames`)
  }
  for (const mid of messageById.keys()) {
    const key = `messageBlock:${mid}`
    if (!frameByKey.has(key))
      throw new ValidationError(`missing messageBlock frame for message "${mid}"`, `${path}.orderFrames`)
  }
  // No frame for tombstoned/excluded/unknown parent
  for (const f of payload.orderFrames) {
    if (f.kind === 'topicMessage') {
      if (!topicIds.has(f.parentId))
        throw new ValidationError(`frame parent topic unknown/tombstoned "${f.parentId}"`, `${path}.orderFrames`)
    } else {
      if (!messageById.has(f.parentId))
        throw new ValidationError(`frame parent message unknown/tombstoned "${f.parentId}"`, `${path}.orderFrames`)
    }
  }

  // orderedChildIds exact coverage + membershipClock suffix rule
  // Build child maps for quick lookup
  const messagesByTopic = new Map<string, MessageEntity[]>()
  for (const m of payload.messages) {
    const arr = messagesByTopic.get(m.topicId) ?? []
    arr.push(m)
    messagesByTopic.set(m.topicId, arr)
  }
  const blocksByMessage = new Map<string, MessageBlockEntity[]>()
  for (const b of payload.messageBlocks) {
    const arr = blocksByMessage.get(b.messageId) ?? []
    arr.push(b)
    blocksByMessage.set(b.messageId, arr)
  }

  for (const f of payload.orderFrames) {
    const framePath = `${path}.orderFrames[ kind=${f.kind} parentId=${f.parentId}]`
    let liveChildren: Array<{ id: string; membership: SyncClock }> = []
    if (f.kind === 'topicMessage') {
      const children = messagesByTopic.get(f.parentId) ?? []
      liveChildren = children.map((c) => ({ id: c.id, membership: c.parentMembershipClock }))
    } else {
      const children = blocksByMessage.get(f.parentId) ?? []
      liveChildren = children.map((c) => ({ id: c.id, membership: c.parentMembershipClock }))
    }
    const childIdSet = new Set<string>(liveChildren.map((c) => c.id))
    if (f.orderedChildIds.length !== childIdSet.size) {
      throw new ValidationError(
        `orderedChildIds length ${f.orderedChildIds.length} != live children ${childIdSet.size} for parent ${f.parentId}`,
        framePath
      )
    }
    for (const cid of f.orderedChildIds) {
      if (!childIdSet.has(cid)) {
        throw new ValidationError(
          `orderedChildIds contains unknown/deleted child "${cid}" for parent ${f.parentId}`,
          framePath
        )
      }
    }
    // No duplicates already checked in frame validator, but re-check for safety
    if (new Set(f.orderedChildIds).size !== f.orderedChildIds.length) {
      throw new ValidationError('duplicate orderedChildIds', framePath)
    }

    // MembershipClock suffix rule
    const childMembershipById = new Map<string, SyncClock>()
    for (const c of liveChildren) childMembershipById.set(c.id, c.membership)

    // Partition check: all > frameClock must be suffix contiguous and sorted
    let seenGreater = false
    const suffix: Array<{ id: string; clock: SyncClock }> = []
    for (let idx = 0; idx < f.orderedChildIds.length; idx++) {
      const childId = f.orderedChildIds[idx]
      const mem = childMembershipById.get(childId)!
      const cmp = compareClocks(mem, f.frameClock)
      const isGreater = cmp > 0
      if (isGreater) {
        seenGreater = true
        suffix.push({ id: childId, clock: mem })
      } else {
        if (seenGreater) {
          throw new ValidationError(
            `membershipClock suffix violation: covered child "${childId}" after greater-than-frame child for parent ${f.parentId}`,
            `${framePath}.orderedChildIds[${idx}]`
          )
        }
      }
    }
    // Suffix must be sorted by membershipClock asc then id lex
    const expectedSuffix = [...suffix].sort((a, b) => {
      const c = compareClocks(a.clock, b.clock)
      if (c !== 0) return c
      return compareUtf8ByteLex(a.id, b.id)
    })
    for (let i = 0; i < suffix.length; i++) {
      if (suffix[i].id !== expectedSuffix[i].id) {
        throw new ValidationError(
          `membershipClock suffix not sorted deterministically for parent ${f.parentId}: expected "${expectedSuffix[i].id}" at suffix index ${i} but got "${suffix[i].id}"`,
          framePath
        )
      }
      // Also verify that suffix strictly increasing (no duplicates in sort order is already ensured)
      if (i > 0) {
        const c = compareClocks(suffix[i].clock, suffix[i - 1].clock)
        if (c < 0) throw new ValidationError('suffix membershipClock not ascending', framePath)
        if (c === 0) {
          const idCmp = compareUtf8ByteLex(suffix[i - 1].id, suffix[i].id)
          if (idCmp >= 0) throw new ValidationError('suffix id not ascending for equal clocks', framePath)
        }
      }
    }
  }
}

function validateManifestRecompute(payload: SyncPayload, path: string): void {
  const manifest = payload.manifest
  const liveCounts = {
    topic: payload.topics.length,
    message: payload.messages.length,
    messageBlock: payload.messageBlocks.length
  }
  const tCounts = { topic: 0, message: 0, messageBlock: 0 }
  for (const t of payload.tombstones) {
    if (t.entityType === 'topic') tCounts.topic++
    else if (t.entityType === 'message') tCounts.message++
    else if (t.entityType === 'messageBlock') tCounts.messageBlock++
  }
  const fCounts = { topicMessage: 0, messageBlock: 0 }
  for (const f of payload.orderFrames) {
    if (f.kind === 'topicMessage') fCounts.topicMessage++
    else fCounts.messageBlock++
  }

  if (
    manifest.liveCounts.topic !== liveCounts.topic ||
    manifest.liveCounts.message !== liveCounts.message ||
    manifest.liveCounts.messageBlock !== liveCounts.messageBlock
  ) {
    throw new ValidationError(
      `manifest liveCounts mismatch: expected ${JSON.stringify(liveCounts)} got ${JSON.stringify(manifest.liveCounts)}`,
      `${path}.manifest.liveCounts`
    )
  }
  if (
    manifest.tombstoneCounts.topic !== tCounts.topic ||
    manifest.tombstoneCounts.message !== tCounts.message ||
    manifest.tombstoneCounts.messageBlock !== tCounts.messageBlock
  ) {
    throw new ValidationError(
      `manifest tombstoneCounts mismatch: expected ${JSON.stringify(tCounts)} got ${JSON.stringify(manifest.tombstoneCounts)}`,
      `${path}.manifest.tombstoneCounts`
    )
  }
  if (
    manifest.frameCounts.topicMessage !== fCounts.topicMessage ||
    manifest.frameCounts.messageBlock !== fCounts.messageBlock
  ) {
    throw new ValidationError(
      `manifest frameCounts mismatch: expected ${JSON.stringify(fCounts)} got ${JSON.stringify(manifest.frameCounts)}`,
      `${path}.manifest.frameCounts`
    )
  }
  if (manifest.completeness !== COMPLETENESS_COMPLETE) {
    throw new ValidationError('manifest completeness must be "complete"', `${path}.manifest.completeness`)
  }
}

// ---------------------------------------------------------------------------
// Baseline v2: replacement registers (SYNC-DATA-056 / §10B)
// ---------------------------------------------------------------------------

const REPLACEMENT_REGISTER_KEYS = new Set<string>(['messageId', 'replacementClock', 'activeBlockIds'])
const PAYLOAD_V2_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'topics',
  'messages',
  'messageBlocks',
  'tombstones',
  'orderFrames',
  'replacementRegisters',
  'manifest'
])
const MANIFEST_V2_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'liveCounts',
  'tombstoneCounts',
  'frameCounts',
  'replacementCount',
  'completeness'
])

export function validateReplacementRegister(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, REPLACEMENT_REGISTER_KEYS, path)
  assertNonEmptyValidUnicodeScalarString(obj.messageId, `${path}.messageId`)
  validateClock(obj.replacementClock, `${path}.replacementClock`, false)
  const arr = assertPlainArray(obj.activeBlockIds, `${path}.activeBlockIds`)
  const seen = new Set<string>()
  for (let i = 0; i < arr.length; i++) {
    const id = arr[i]
    const p = `${path}.activeBlockIds[${i}]`
    assertNonEmptyValidUnicodeScalarString(id, p)
    if (seen.has(id as string)) throw new ValidationError(`duplicate activeBlockIds "${id}"`, p)
    seen.add(id as string)
  }
}

function validateManifestV2(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MANIFEST_V2_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA_V2)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA_V2}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION_V2)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION_V2}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE_V2) throw new ValidationError(`scope must be "${SCOPE_V2}"`, `${path}.scope`)
  const liveCounts = assertPlainObject(obj.liveCounts, `${path}.liveCounts`)
  assertExactKeys(liveCounts, LIVE_COUNTS_KEYS, `${path}.liveCounts`)
  for (const k of LIVE_COUNTS_KEYS) assertSafeNonNegativeInt(liveCounts[k], `${path}.liveCounts.${k}`)
  const tCounts = assertPlainObject(obj.tombstoneCounts, `${path}.tombstoneCounts`)
  assertExactKeys(tCounts, TOMBSTONE_COUNTS_KEYS, `${path}.tombstoneCounts`)
  for (const k of TOMBSTONE_COUNTS_KEYS) assertSafeNonNegativeInt(tCounts[k], `${path}.tombstoneCounts.${k}`)
  const fCounts = assertPlainObject(obj.frameCounts, `${path}.frameCounts`)
  assertExactKeys(fCounts, FRAME_COUNTS_KEYS, `${path}.frameCounts`)
  for (const k of FRAME_COUNTS_KEYS) assertSafeNonNegativeInt(fCounts[k], `${path}.frameCounts.${k}`)
  assertSafeNonNegativeInt(obj.replacementCount, `${path}.replacementCount`)
  if (obj.completeness !== COMPLETENESS_COMPLETE)
    throw new ValidationError('completeness must be "complete"', `${path}.completeness`)
}

function validatePayloadV2Structure(value: unknown, path: string): SyncPayloadV2 {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, PAYLOAD_V2_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA_V2)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA_V2}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION_V2)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION_V2}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE_V2) throw new ValidationError(`scope must be "${SCOPE_V2}"`, `${path}.scope`)

  const topics = assertPlainArray(obj.topics, `${path}.topics`)
  topics.forEach((t, idx) => validateTopic(t, `${path}.topics[${idx}]`))
  const messages = assertPlainArray(obj.messages, `${path}.messages`)
  messages.forEach((m, idx) => validateMessage(m, `${path}.messages[${idx}]`))
  const blocks = assertPlainArray(obj.messageBlocks, `${path}.messageBlocks`)
  blocks.forEach((b, idx) => validateMessageBlock(b, `${path}.messageBlocks[${idx}]`))
  const tombstones = assertPlainArray(obj.tombstones, `${path}.tombstones`)
  tombstones.forEach((t, idx) => validateTombstone(t, `${path}.tombstones[${idx}]`))
  const frames = assertPlainArray(obj.orderFrames, `${path}.orderFrames`)
  frames.forEach((f, idx) => validateOrderFrame(f, `${path}.orderFrames[${idx}]`))
  const registers = assertPlainArray(obj.replacementRegisters, `${path}.replacementRegisters`)
  registers.forEach((r, idx) => validateReplacementRegister(r, `${path}.replacementRegisters[${idx}]`))

  validateManifestV2(obj.manifest, `${path}.manifest`)

  assertStrictlySortedByUtf8(topics as TopicEntity[], (v) => v.id, `${path}.topics`)
  assertStrictlySortedByUtf8(messages as MessageEntity[], (v) => v.id, `${path}.messages`)
  assertStrictlySortedByUtf8(blocks as MessageBlockEntity[], (v) => v.id, `${path}.messageBlocks`)
  // Tombstone + frame ordering rules are shared with v1 (rank + lex).
  const tombRank = (t: Tombstone): number => {
    if (t.entityType === 'topic') return 0
    if (t.entityType === 'message') return 1
    return 2
  }
  for (let i = 1; i < tombstones.length; i++) {
    const prev = tombstones[i - 1] as Tombstone
    const cur = tombstones[i] as Tombstone
    const pr = tombRank(prev)
    const cr = tombRank(cur)
    if (cr < pr) throw new ValidationError('tombstones not sorted by type rank', `${path}.tombstones`)
    if (cr === pr) {
      const cmp = compareUtf8ByteLex(prev.entityId, cur.entityId)
      if (cmp >= 0) {
        if (cmp === 0)
          throw new ValidationError(`duplicate tombstone ${cur.entityType}:${cur.entityId}`, `${path}.tombstones[${i}]`)
        throw new ValidationError('tombstones not sorted by entityId', `${path}.tombstones`)
      }
    }
  }
  const frameRank = (f: OrderFrame): number => (f.kind === 'topicMessage' ? 0 : 1)
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1] as OrderFrame
    const cur = frames[i] as OrderFrame
    const pr = frameRank(prev)
    const cr = frameRank(cur)
    if (cr < pr) throw new ValidationError('orderFrames not sorted by kind rank', `${path}.orderFrames`)
    if (cr === pr) {
      const cmp = compareUtf8ByteLex(prev.parentId, cur.parentId)
      if (cmp >= 0) {
        if (cmp === 0)
          throw new ValidationError(`duplicate frame ${cur.kind}:${cur.parentId}`, `${path}.orderFrames[${i}]`)
        throw new ValidationError('orderFrames not sorted by parentId', `${path}.orderFrames`)
      }
    }
  }
  // replacementRegisters: messageId UTF-8 byte lex strictly increasing, duplicates fail-closed.
  assertStrictlySortedByUtf8(registers as ReplacementRegister[], (v) => v.messageId, `${path}.replacementRegisters`)

  // Shared v1 closure/frame-coverage rules apply unchanged to the v1 content subset.
  validatePayloadClosure(obj as unknown as SyncPayload, path)

  // Manifest recompute: v1 counts plus replacementCount == registers.length.
  validateManifestRecompute(obj as unknown as SyncPayload, path)
  const manifest = obj.manifest as ManifestV2
  if (manifest.replacementCount !== registers.length) {
    throw new ValidationError(
      `manifest replacementCount mismatch: expected ${registers.length} got ${manifest.replacementCount}`,
      `${path}.manifest.replacementCount`
    )
  }
  return obj as unknown as SyncPayloadV2
}

function isV2PayloadLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const obj = value as Record<string, unknown>
  return obj.payloadSchema === PAYLOAD_SCHEMA_V2 || obj.inventoryVersion === INVENTORY_VERSION_V2
}

export function isV2EnvelopeLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (value as Record<string, unknown>).wireVersion === WIRE_VERSION_V2
}

export function validatePayloadV1(value: unknown): ValidatedSyncPayload {
  return validatePayloadStructure(value, 'payload') as ValidatedSyncPayload
}

export function validatePayloadV2(value: unknown): SyncPayloadV2 & { readonly [ValidatedPayloadBrand]: true } {
  return validatePayloadV2Structure(value, 'payload') as SyncPayloadV2 & {
    readonly [ValidatedPayloadBrand]: true
  }
}

export function validatePayloadAny(value: unknown): ValidatedSyncPayloadAny {
  if (isV5PayloadLike(value)) return validatePayloadV5(value) as ValidatedSyncPayloadAny
  if (isV4PayloadLike(value)) return validatePayloadV4(value) as ValidatedSyncPayloadAny
  if (isV3PayloadLike(value)) return validatePayloadV3(value) as ValidatedSyncPayloadAny
  if (isV2PayloadLike(value)) return validatePayloadV2(value) as ValidatedSyncPayloadAny
  return validatePayloadStructure(value, 'payload') as ValidatedSyncPayload
}

export function validateEnvelopeV1(value: unknown): ValidatedSyncEnvelope {
  const obj = assertPlainObject(value, '$')
  assertExactKeys(obj, ENVELOPE_KEYS, '$')
  if (obj.wireVersion !== WIRE_VERSION)
    throw new ValidationError(`wireVersion must be "${WIRE_VERSION}"`, '$.wireVersion')
  assertNonEmptyValidUnicodeScalarString(obj.channelId, '$.channelId')
  assertSafeNonNegativeInt(obj.watermark, '$.watermark')
  if (obj.digestScheme !== DIGEST_SCHEME)
    throw new ValidationError(`digestScheme must be "${DIGEST_SCHEME}"`, '$.digestScheme')
  if (typeof obj.digest !== 'string' || !/^[0-9a-f]{64}$/.test(obj.digest)) {
    throw new ValidationError('digest must be lowercase 64hex', '$.digest')
  }
  const payload = validatePayloadStructure(obj.payload, '$.payload')
  return {
    wireVersion: obj.wireVersion as typeof WIRE_VERSION,
    channelId: obj.channelId as string,
    watermark: obj.watermark as number,
    digestScheme: obj.digestScheme as typeof DIGEST_SCHEME,
    digest: obj.digest,
    payload
  } as ValidatedSyncEnvelope
}

export function validateEnvelopeV2(value: unknown): SyncEnvelopeV2 & { readonly [ValidatedEnvelopeBrand]: true } {
  const obj = assertPlainObject(value, '$')
  assertExactKeys(obj, ENVELOPE_KEYS, '$')
  if (obj.wireVersion !== WIRE_VERSION_V2)
    throw new ValidationError(`wireVersion must be "${WIRE_VERSION_V2}"`, '$.wireVersion')
  assertNonEmptyValidUnicodeScalarString(obj.channelId, '$.channelId')
  assertSafeNonNegativeInt(obj.watermark, '$.watermark')
  if (obj.digestScheme !== DIGEST_SCHEME)
    throw new ValidationError(`digestScheme must be "${DIGEST_SCHEME}"`, '$.digestScheme')
  if (typeof obj.digest !== 'string' || !/^[0-9a-f]{64}$/.test(obj.digest)) {
    throw new ValidationError('digest must be lowercase 64hex', '$.digest')
  }
  const payload = validatePayloadV2Structure(obj.payload, '$.payload')
  return {
    wireVersion: obj.wireVersion as typeof WIRE_VERSION_V2,
    channelId: obj.channelId as string,
    watermark: obj.watermark as number,
    digestScheme: obj.digestScheme as typeof DIGEST_SCHEME,
    digest: obj.digest,
    payload
  } as SyncEnvelopeV2 & { readonly [ValidatedEnvelopeBrand]: true }
}

export function validateEnvelopeAny(value: unknown): ValidatedSyncEnvelopeAny {
  if (isV5EnvelopeLike(value)) return validateEnvelopeV5(value) as ValidatedSyncEnvelopeAny
  if (isV4EnvelopeLike(value)) return validateEnvelopeV4(value) as ValidatedSyncEnvelopeAny
  if (isV3EnvelopeLike(value)) return validateEnvelopeV3(value) as ValidatedSyncEnvelopeAny
  if (isV2EnvelopeLike(value)) return validateEnvelopeV2(value) as ValidatedSyncEnvelopeAny
  // Version-dispatched: unknown wireVersion fails closed inside the v1 path
  // (which strictly requires the v1 literal); v2/v3/v4/v5 are handled above.
  // Older peers receiving newer wire fail closed on their own validators (no silent downgrade).
  return validateEnvelopeV1(value)
}

// ---------------------------------------------------------------------------
// Strict JSON parse API (duplicate keys + JSON.parse syntax)
// Protocol notes:
// - JSON grammar is fully delegated to JSON.parse (spec-compliant). Trailing
//   commas, trailing tokens, unclosed constructs are rejected via JSON.parse.
// - assertNoDuplicateKeys is an internal helper (not exported) that scans raw
//   text for duplicate keys (decoded via JSON string decoding) before parsing.
// - Deep structure handling: scanForIllegalScalars is iterative (explicit stack)
//   to avoid RangeError on deep inputs. Other validators (payload structure,
//   manifest, closure) are bounded by protocol fixed hierarchy (payload has 9
//   top keys, arrays of bounded depth), thus not susceptible to unbounded recursion.
// ---------------------------------------------------------------------------

export function parseStrictJson(text: string): unknown {
  assertNoDuplicateKeys(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    if (e instanceof ValidationError) throw e
    if (e instanceof RangeError) {
      throw new ValidationError(`JSON too deep: ${(e as Error).message}`, '$')
    }
    throw new ValidationError(`JSON syntax error: ${(e as Error).message}`, '$')
  }
  try {
    scanForIllegalScalars(parsed, '$')
  } catch (e) {
    if (e instanceof ValidationError) throw e
    if (e instanceof RangeError) {
      throw new ValidationError(`JSON too deep: ${(e as Error).message}`, '$')
    }
    throw e
  }
  return parsed
}

function scanForIllegalScalars(value: unknown, path: string): void {
  type StackItem = { value: unknown; path: string }
  const stack: StackItem[] = [{ value, path }]
  while (stack.length > 0) {
    const curItem = stack.pop()!
    const cur = curItem.value
    const curPath = curItem.path
    if (typeof cur === 'string') {
      if (!isValidUnicodeScalarString(cur)) {
        throw new ValidationError('invalid Unicode scalar (lone surrogate or illegal code point)', curPath)
      }
      continue
    }
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) {
        stack.push({ value: cur[i], path: `${curPath}[${i}]` })
      }
      continue
    }
    if (isPlainObject(cur)) {
      const obj = cur as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) {
        if (!isValidUnicodeScalarString(k)) {
          throw new ValidationError('invalid Unicode scalar in key', `${curPath}.${k}`)
        }
        stack.push({ value: v, path: `${curPath}.${k}` })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// High-level validators / parsers
// ---------------------------------------------------------------------------

export function validatePayload(value: unknown): ValidatedSyncPayloadAny {
  // Version-dispatched: v1 strict semantics preserved; v2 validated by its own
  // strict literals/types. New callers may use validatePayloadV1/V2/Any explicitly.
  return validatePayloadAny(value)
}

export function validateEnvelope(value: unknown): ValidatedSyncEnvelopeAny {
  // Version-dispatched: v1 current row stays valid; v2 validated strictly.
  return validateEnvelopeAny(value)
}

export function parseEnvelopeJson(json: string): ValidatedSyncEnvelopeAny {
  const parsed = parseStrictJson(json)
  return validateEnvelope(parsed)
}

export function parsePayloadJson(json: string): ValidatedSyncPayloadAny {
  const parsed = parseStrictJson(json)
  return validatePayload(parsed)
}

export function parseEnvelopeJsonAny(json: string): ValidatedSyncEnvelopeAny {
  const parsed = parseStrictJson(json)
  return validateEnvelopeAny(parsed)
}

export function parsePayloadJsonAny(json: string): ValidatedSyncPayloadAny {
  const parsed = parseStrictJson(json)
  return validatePayloadAny(parsed)
}

// ---------------------------------------------------------------------------
// Canonicalize / Digest helpers (injected hash)
// All helpers strictly validate before canonicalizing; hash callback receives
// canonical UTF-8 bytes (TextEncoder) and must return lowercase 64hex.
// ---------------------------------------------------------------------------

export function canonicalizePayload(payload: SyncPayloadAny): string {
  // Strict validation before canonicalize ensures lone-surrogate gap in
  // canonicalize@2.1.0 is unreachable (all strings are valid scalars).
  // Digest still jcs-sha256-v1 covering only the payload object (both versions).
  validatePayloadAny(payload)
  const canonical = canonicalize(payload)
  if (typeof canonical !== 'string') {
    throw new ValidationError('payload not canonicalizable (non-I-JSON)', 'payload')
  }
  return canonical
}

export function computeSyncDigest(payload: SyncPayloadAny, hashHex: (canonicalUtf8: Uint8Array) => string): string {
  const canonical = canonicalizePayload(payload)
  const bytes = new TextEncoder().encode(canonical)
  const digest = hashHex(bytes)
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new ValidationError('hashHex must return lowercase 64hex', 'digest')
  }
  return digest
}

export function verifySyncDigest(
  payload: SyncPayloadAny,
  expectedDigest: string,
  hashHex: (canonicalUtf8: Uint8Array) => string
): boolean {
  // expectedDigest must be lowercase 64hex; if not, treat as mismatch (strict compare will fail)
  // but we validate format to avoid silent case-insensitive matches
  if (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    return false
  }
  const actual = computeSyncDigest(payload, hashHex)
  return actual === expectedDigest
}

export function verifyEnvelopeDigest(
  envelope: SyncEnvelopeAny,
  hashHex: (canonicalUtf8: Uint8Array) => string
): boolean {
  const validated = validateEnvelopeAny(envelope)
  const canonical = canonicalizePayload(validated.payload as SyncPayloadAny)
  const bytes = new TextEncoder().encode(canonical)
  const computed = hashHex(bytes)
  if (typeof computed !== 'string' || !/^[0-9a-f]{64}$/.test(computed)) {
    throw new ValidationError('hashHex must return lowercase 64hex', 'digest')
  }
  return computed === (validated as { digest: string }).digest
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isSyncPayload(value: unknown): value is SyncPayloadAny {
  try {
    validatePayload(value)
    return true
  } catch {
    return false
  }
}

export function isSyncEnvelope(value: unknown): value is SyncEnvelopeAny {
  try {
    validateEnvelope(value)
    return true
  } catch {
    return false
  }
}

export function isSyncPayloadV1(value: unknown): value is SyncPayload {
  try {
    validatePayloadV1(value)
    return true
  } catch {
    return false
  }
}

export function isSyncPayloadV2(value: unknown): value is SyncPayloadV2 {
  try {
    validatePayloadV2(value)
    return true
  } catch {
    return false
  }
}

export function isSyncClock(value: unknown): value is SyncClock {
  try {
    validateClock(value, '$', false)
    return true
  } catch {
    return false
  }
}

export function isValidationError(e: unknown): e is ValidationError {
  return e instanceof ValidationError
}

// ---------------------------------------------------------------------------
// Baseline v3: true-branch full sync (§10C)
// Inventory: topic-message-stable-block-order-branch-v3 at
// sync-baseline-wire-v3 / chat-core-baseline-v3 / parent-order-frame-v1.
// - Message carries immutable owner `branchId: string|null` (null = main).
// - New `branches` array: full-state branch nodes with entity + field clocks.
// - New `branchSuffix` frame kind: parentId = branch id, children = owned suffix.
// - topicMessage frames carry main-owned children only; messageBlock frames
//   cover all messages (branch-owned included); branchSuffix frames cover each
//   live branch's owned suffix (empty [] when the branch owns nothing yet).
// - Manifest gains branch-aware counts; digest input stays payload-only.
// - v1/v2 validators above are unchanged (old inputs still validate); new
//   clients publish v3 and fail closed on unknown/incompatible versions.
// ---------------------------------------------------------------------------

export interface BranchEntityV3 {
  id: string
  topicId: string
  parentBranchId: string | null
  anchorMessageId: string
  name: string | null
  createdAt: string | null
  updatedAt: string | null
  entityClock: SyncClock
  fieldClocks: Record<BranchFieldClockKeyV3, SyncClock>
}

export type BranchFieldClockKeyV3 = 'name' | 'createdAt' | 'updatedAt'

export interface MessageEntityV3 extends Omit<MessageEntity, 'topicId'> {
  topicId: string
  branchId: string | null
}

export type TombstoneEntityTypeV3 = 'topic' | 'message' | 'messageBlock' | 'topicBranch'

export interface TombstoneV3 {
  entityType: TombstoneEntityTypeV3
  entityId: string
  deletionClock: DeletionClock
  survivingEntityClock: SyncClock | null
}

export type OrderFrameKindV3 = 'topicMessage' | 'messageBlock' | 'branchSuffix'

export interface OrderFrameV3 {
  frameVersion: typeof ORDER_FRAME_VERSION
  kind: OrderFrameKindV3
  parentId: string
  orderedChildIds: string[]
  frameClock: SyncClock
}

export interface ManifestV3 {
  payloadSchema: typeof PAYLOAD_SCHEMA_V3
  inventoryVersion: typeof INVENTORY_VERSION_V3
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE_V3
  liveCounts: { topic: number; message: number; messageBlock: number; branch: number }
  tombstoneCounts: { topic: number; message: number; messageBlock: number; topicBranch: number }
  frameCounts: { topicMessage: number; messageBlock: number; branchSuffix: number }
  replacementCount: number
  completeness: typeof COMPLETENESS_COMPLETE
}

export interface ReplacementRegisterV3 {
  messageId: string
  replacementClock: SyncClock
  activeBlockIds: string[]
}

export interface SyncPayloadV3 {
  payloadSchema: typeof PAYLOAD_SCHEMA_V3
  inventoryVersion: typeof INVENTORY_VERSION_V3
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE_V3
  topics: TopicEntity[]
  messages: MessageEntityV3[]
  messageBlocks: MessageBlockEntity[]
  branches: BranchEntityV3[]
  tombstones: TombstoneV3[]
  orderFrames: OrderFrameV3[]
  replacementRegisters: ReplacementRegisterV3[]
  manifest: ManifestV3
}

export interface SyncEnvelopeV3 {
  wireVersion: typeof WIRE_VERSION_V3
  channelId: string
  watermark: number
  digestScheme: typeof DIGEST_SCHEME
  digest: string
  payload: SyncPayloadV3
}

const BRANCH_FIELD_CLOCK_KEYS_V3: ReadonlySet<string> = new Set(['name', 'createdAt', 'updatedAt'])

const BRANCH_KEYS_V3 = new Set<string>([
  'id',
  'topicId',
  'parentBranchId',
  'anchorMessageId',
  'name',
  'createdAt',
  'updatedAt',
  'entityClock',
  'fieldClocks'
])

const MESSAGE_KEYS_V3 = new Set<string>([
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
  'entityClock',
  'fieldClocks',
  'parentMembershipClock'
])

const TOMBSTONE_KEYS_V3 = new Set<string>(['entityType', 'entityId', 'deletionClock', 'survivingEntityClock'])
const TOMBSTONE_ENTITY_TYPES_V3: ReadonlySet<string> = new Set(['topic', 'message', 'messageBlock', 'topicBranch'])
const ORDER_FRAME_KINDS_V3: ReadonlySet<string> = new Set(['topicMessage', 'messageBlock', 'branchSuffix'])

const PAYLOAD_V3_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'topics',
  'messages',
  'messageBlocks',
  'branches',
  'tombstones',
  'orderFrames',
  'replacementRegisters',
  'manifest'
])

const MANIFEST_V3_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'liveCounts',
  'tombstoneCounts',
  'frameCounts',
  'replacementCount',
  'completeness'
])

const LIVE_COUNTS_KEYS_V3 = new Set<string>(['topic', 'message', 'messageBlock', 'branch'])
const TOMBSTONE_COUNTS_KEYS_V3 = new Set<string>(['topic', 'message', 'messageBlock', 'topicBranch'])
const FRAME_COUNTS_KEYS_V3 = new Set<string>(['topicMessage', 'messageBlock', 'branchSuffix'])

export function validateBranchV3(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, BRANCH_KEYS_V3, path)
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  assertNonEmptyValidUnicodeScalarString(obj.topicId, `${path}.topicId`)
  if (obj.parentBranchId === null) {
    // level-1 branch forked from main: ok
  } else {
    assertNonEmptyValidUnicodeScalarString(obj.parentBranchId, `${path}.parentBranchId`)
  }
  assertNonEmptyValidUnicodeScalarString(obj.anchorMessageId, `${path}.anchorMessageId`)
  assertNullableValidUnicodeScalarString(obj.name, `${path}.name`)
  assertNullableValidUnicodeScalarString(obj.createdAt, `${path}.createdAt`)
  assertNullableValidUnicodeScalarString(obj.updatedAt, `${path}.updatedAt`)
  validateClock(obj.entityClock, `${path}.entityClock`, false)
  validateFieldClocks(obj.fieldClocks, BRANCH_FIELD_CLOCK_KEYS_V3, `${path}.fieldClocks`)
}

export function validateMessageV3(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MESSAGE_KEYS_V3, path)
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  assertNonEmptyValidUnicodeScalarString(obj.topicId, `${path}.topicId`)
  if (obj.branchId === null) {
    // main route: ok
  } else {
    assertNonEmptyValidUnicodeScalarString(obj.branchId, `${path}.branchId`)
  }
  assertNullableValidUnicodeScalarString(obj.role, `${path}.role`)
  assertNullableValidUnicodeScalarString(obj.content, `${path}.content`)
  const status = assertNullableValidUnicodeScalarString(obj.status, `${path}.status`)
  if (status !== null && TRANSIENT_SET.has(status)) {
    throw new ValidationError(`transient status "${status}" not allowed on wire`, `${path}.status`)
  }
  assertNullableValidUnicodeScalarString(obj.askId, `${path}.askId`)
  assertNullableValidUnicodeScalarString(obj.model, `${path}.model`)
  assertNullableValidUnicodeScalarString(obj.modelId, `${path}.modelId`)
  assertNullableValidUnicodeScalarString(obj.assistantId, `${path}.assistantId`)
  assertNullableValidUnicodeScalarString(obj.createdAt, `${path}.createdAt`)
  assertNullableValidUnicodeScalarString(obj.updatedAt, `${path}.updatedAt`)
  validateClock(obj.entityClock, `${path}.entityClock`, false)
  validateFieldClocks(obj.fieldClocks, MESSAGE_FIELD_CLOCK_KEYS, `${path}.fieldClocks`)
  validateClock(obj.parentMembershipClock, `${path}.parentMembershipClock`, false)
}

function validateTombstoneV3(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, TOMBSTONE_KEYS_V3, path)
  if (typeof obj.entityType !== 'string' || !TOMBSTONE_ENTITY_TYPES_V3.has(obj.entityType)) {
    throw new ValidationError('entityType must be one of topic,message,messageBlock,topicBranch', `${path}.entityType`)
  }
  if (typeof obj.entityType === 'string') assertValidUnicodeScalarString(obj.entityType, `${path}.entityType`)
  assertNonEmptyValidUnicodeScalarString(obj.entityId, `${path}.entityId`)
  validateClock(obj.deletionClock, `${path}.deletionClock`, true)
  if (obj.survivingEntityClock === null) {
    // ok
  } else {
    validateClock(obj.survivingEntityClock, `${path}.survivingEntityClock`, false)
  }
}

export function validateOrderFrameV3(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, ORDER_FRAME_KEYS, path)
  if (obj.frameVersion !== ORDER_FRAME_VERSION) {
    throw new ValidationError(`frameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.frameVersion`)
  }
  if (typeof obj.kind !== 'string' || !ORDER_FRAME_KINDS_V3.has(obj.kind)) {
    throw new ValidationError('kind must be topicMessage|messageBlock|branchSuffix', `${path}.kind`)
  }
  if (typeof obj.kind === 'string') assertValidUnicodeScalarString(obj.kind, `${path}.kind`)
  assertNonEmptyValidUnicodeScalarString(obj.parentId, `${path}.parentId`)
  const arr = assertPlainArray(obj.orderedChildIds, `${path}.orderedChildIds`)
  const seen = new Set<string>()
  for (let i = 0; i < arr.length; i++) {
    const cid = arr[i]
    const p = `${path}.orderedChildIds[${i}]`
    assertNonEmptyValidUnicodeScalarString(cid, p)
    if (seen.has(cid as string)) throw new ValidationError(`duplicate orderedChildIds "${cid}"`, p)
    seen.add(cid as string)
  }
  validateClock(obj.frameClock, `${path}.frameClock`, false)
}

function validateManifestV3(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MANIFEST_V3_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA_V3)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA_V3}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION_V3)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION_V3}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE_V3) throw new ValidationError(`scope must be "${SCOPE_V3}"`, `${path}.scope`)
  const liveCounts = assertPlainObject(obj.liveCounts, `${path}.liveCounts`)
  assertExactKeys(liveCounts, LIVE_COUNTS_KEYS_V3, `${path}.liveCounts`)
  for (const k of LIVE_COUNTS_KEYS_V3) assertSafeNonNegativeInt(liveCounts[k], `${path}.liveCounts.${k}`)
  const tCounts = assertPlainObject(obj.tombstoneCounts, `${path}.tombstoneCounts`)
  assertExactKeys(tCounts, TOMBSTONE_COUNTS_KEYS_V3, `${path}.tombstoneCounts`)
  for (const k of TOMBSTONE_COUNTS_KEYS_V3) assertSafeNonNegativeInt(tCounts[k], `${path}.tombstoneCounts.${k}`)
  const fCounts = assertPlainObject(obj.frameCounts, `${path}.frameCounts`)
  assertExactKeys(fCounts, FRAME_COUNTS_KEYS_V3, `${path}.frameCounts`)
  for (const k of FRAME_COUNTS_KEYS_V3) assertSafeNonNegativeInt(fCounts[k], `${path}.frameCounts.${k}`)
  assertSafeNonNegativeInt(obj.replacementCount, `${path}.replacementCount`)
  if (obj.completeness !== COMPLETENESS_COMPLETE)
    throw new ValidationError('completeness must be "complete"', `${path}.completeness`)
}

function validatePayloadV3Structure(value: unknown, path: string): SyncPayloadV3 {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, PAYLOAD_V3_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA_V3)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA_V3}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION_V3)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION_V3}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE_V3) throw new ValidationError(`scope must be "${SCOPE_V3}"`, `${path}.scope`)

  const topics = assertPlainArray(obj.topics, `${path}.topics`)
  topics.forEach((t, idx) => validateTopic(t, `${path}.topics[${idx}]`))
  const messages = assertPlainArray(obj.messages, `${path}.messages`)
  messages.forEach((m, idx) => validateMessageV3(m, `${path}.messages[${idx}]`))
  const blocks = assertPlainArray(obj.messageBlocks, `${path}.messageBlocks`)
  blocks.forEach((b, idx) => validateMessageBlock(b, `${path}.messageBlocks[${idx}]`))
  const branches = assertPlainArray(obj.branches, `${path}.branches`)
  branches.forEach((b, idx) => validateBranchV3(b, `${path}.branches[${idx}]`))
  const tombstones = assertPlainArray(obj.tombstones, `${path}.tombstones`)
  tombstones.forEach((t, idx) => validateTombstoneV3(t, `${path}.tombstones[${idx}]`))
  const frames = assertPlainArray(obj.orderFrames, `${path}.orderFrames`)
  frames.forEach((f, idx) => validateOrderFrameV3(f, `${path}.orderFrames[${idx}]`))
  const registers = assertPlainArray(obj.replacementRegisters, `${path}.replacementRegisters`)
  registers.forEach((r, idx) => validateReplacementRegister(r, `${path}.replacementRegisters[${idx}]`))

  validateManifestV3(obj.manifest, `${path}.manifest`)

  assertStrictlySortedByUtf8(topics as TopicEntity[], (v) => v.id, `${path}.topics`)
  assertStrictlySortedByUtf8(messages as MessageEntityV3[], (v) => v.id, `${path}.messages`)
  assertStrictlySortedByUtf8(blocks as MessageBlockEntity[], (v) => v.id, `${path}.messageBlocks`)
  assertStrictlySortedByUtf8(branches as BranchEntityV3[], (v) => v.id, `${path}.branches`)
  assertStrictlySortedByUtf8(registers as ReplacementRegisterV3[], (v) => v.messageId, `${path}.replacementRegisters`)

  const tombRankV3 = (t: TombstoneV3): number => {
    if (t.entityType === 'topic') return 0
    if (t.entityType === 'message') return 1
    if (t.entityType === 'messageBlock') return 2
    return 3
  }
  for (let i = 1; i < tombstones.length; i++) {
    const prev = tombstones[i - 1] as TombstoneV3
    const cur = tombstones[i] as TombstoneV3
    const pr = tombRankV3(prev)
    const cr = tombRankV3(cur)
    if (cr < pr) throw new ValidationError('tombstones not sorted by type rank', `${path}.tombstones`)
    if (cr === pr) {
      const cmp = compareUtf8ByteLex(prev.entityId, cur.entityId)
      if (cmp >= 0) {
        if (cmp === 0)
          throw new ValidationError(`duplicate tombstone ${cur.entityType}:${cur.entityId}`, `${path}.tombstones[${i}]`)
        throw new ValidationError('tombstones not sorted by entityId', `${path}.tombstones`)
      }
    }
  }
  const frameRankV3 = (f: OrderFrameV3): number => {
    if (f.kind === 'topicMessage') return 0
    if (f.kind === 'messageBlock') return 1
    return 2
  }
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1] as OrderFrameV3
    const cur = frames[i] as OrderFrameV3
    const pr = frameRankV3(prev)
    const cr = frameRankV3(cur)
    if (cr < pr) throw new ValidationError('orderFrames not sorted by kind rank', `${path}.orderFrames`)
    if (cr === pr) {
      const cmp = compareUtf8ByteLex(prev.parentId, cur.parentId)
      if (cmp >= 0) {
        if (cmp === 0)
          throw new ValidationError(`duplicate frame ${cur.kind}:${cur.parentId}`, `${path}.orderFrames[${i}]`)
        throw new ValidationError('orderFrames not sorted by parentId', `${path}.orderFrames`)
      }
    }
  }

  validatePayloadV3Closure(obj as unknown as SyncPayloadV3, path)
  validateManifestV3Recompute(obj as unknown as SyncPayloadV3, path)

  return obj as unknown as SyncPayloadV3
}

function validatePayloadV3Closure(payload: SyncPayloadV3, path: string): void {
  const topicIds = new Set<string>(payload.topics.map((t) => t.id))
  const branchById = new Map<string, BranchEntityV3>()
  for (const b of payload.branches) {
    if (branchById.has(b.id)) throw new ValidationError(`duplicate branch id "${b.id}"`, `${path}.branches`)
    branchById.set(b.id, b)
  }
  const messageById = new Map<string, MessageEntityV3>()
  for (const m of payload.messages) {
    if (messageById.has(m.id)) throw new ValidationError(`duplicate message id "${m.id}"`, `${path}.messages`)
    messageById.set(m.id, m)
  }
  const blockById = new Map<string, MessageBlockEntity>()
  for (const b of payload.messageBlocks) {
    if (blockById.has(b.id)) throw new ValidationError(`duplicate block id "${b.id}"`, `${path}.messageBlocks`)
    blockById.set(b.id, b)
  }

  // Branch closure: topic live; parent null or live branch of same topic;
  // anchor must be a live message of the same topic owned by the parent route
  // (owner equality); ancestry acyclic.
  for (const b of payload.branches) {
    if (!topicIds.has(b.topicId)) {
      throw new ValidationError(`branch parent topic "${b.topicId}" must be live`, `${path}.branches`)
    }
    if (b.parentBranchId !== null) {
      const parent = branchById.get(b.parentBranchId)
      if (!parent) {
        throw new ValidationError(`branch parent "${b.parentBranchId}" must be live`, `${path}.branches`)
      }
      if (parent.topicId !== b.topicId) {
        throw new ValidationError(`branch parent topic mismatch "${b.id}" vs parent "${parent.id}"`, `${path}.branches`)
      }
    }
    const anchor = messageById.get(b.anchorMessageId)
    if (!anchor) {
      throw new ValidationError(
        `branch anchor "${b.anchorMessageId}" must be a live message of topic "${b.topicId}"`,
        `${path}.branches`
      )
    }
    if (anchor.topicId !== b.topicId) {
      throw new ValidationError(`branch anchor topic mismatch for branch "${b.id}"`, `${path}.branches`)
    }
    const expectedOwner = b.parentBranchId
    const actualOwner = anchor.branchId
    if ((actualOwner ?? null) !== (expectedOwner ?? null)) {
      throw new ValidationError(
        `branch anchor "${b.anchorMessageId}" not owned by parent route of branch "${b.id}"`,
        `${path}.branches`
      )
    }
    if (b.id === b.parentBranchId) {
      throw new ValidationError(`branch cycle at "${b.id}"`, `${path}.branches`)
    }
  }
  // Ancestry cycle guard (depth-bounded walk).
  for (const b of payload.branches) {
    const seen = new Set<string>([b.id])
    let cur: string | null = b.parentBranchId
    for (let depth = 0; depth < 32 && cur !== null; depth++) {
      if (seen.has(cur)) throw new ValidationError(`branch ancestry cycle at "${cur}"`, `${path}.branches`)
      seen.add(cur)
      const node = branchById.get(cur)
      if (!node) break
      cur = node.parentBranchId
    }
  }

  // Message closure: topic live; branch null or live branch of same topic.
  for (const m of payload.messages) {
    if (!topicIds.has(m.topicId)) {
      throw new ValidationError(`message parent topic "${m.topicId}" must be live`, `${path}.messages`)
    }
    if (m.branchId !== null) {
      const br = branchById.get(m.branchId)
      if (!br) {
        throw new ValidationError(`message branch "${m.branchId}" must be live`, `${path}.messages`)
      }
      if (br.topicId !== m.topicId) {
        throw new ValidationError(`message branch topic mismatch for message "${m.id}"`, `${path}.messages`)
      }
    }
  }
  for (const b of payload.messageBlocks) {
    if (!messageById.has(b.messageId)) {
      throw new ValidationError(`block parent message "${b.messageId}" must be live`, `${path}.messageBlocks`)
    }
  }

  // Tombstones: strictly one entry per entity; live/tombstone overlap fails.
  const tombstoneKeySet = new Set<string>()
  for (const t of payload.tombstones) {
    const key = `${t.entityType}:${t.entityId}`
    if (tombstoneKeySet.has(key)) throw new ValidationError(`duplicate tombstone ${key}`, `${path}.tombstones`)
    tombstoneKeySet.add(key)
  }
  for (const t of payload.tombstones) {
    if (t.entityType === 'topic' && topicIds.has(t.entityId))
      throw new ValidationError(`entity both live and tombstoned: topic ${t.entityId}`, `${path}.tombstones`)
    if (t.entityType === 'message' && messageById.has(t.entityId))
      throw new ValidationError(`entity both live and tombstoned: message ${t.entityId}`, `${path}.tombstones`)
    if (t.entityType === 'messageBlock' && blockById.has(t.entityId))
      throw new ValidationError(`entity both live and tombstoned: messageBlock ${t.entityId}`, `${path}.tombstones`)
    if (t.entityType === 'topicBranch' && branchById.has(t.entityId))
      throw new ValidationError(`entity both live and tombstoned: topicBranch ${t.entityId}`, `${path}.tombstones`)
  }

  // Frame closure: exactly one frame per live parent of each kind.
  const frameByKey = new Map<string, OrderFrameV3>()
  for (const f of payload.orderFrames) {
    const key = `${f.kind}:${f.parentId}`
    if (frameByKey.has(key)) throw new ValidationError(`duplicate frame ${key}`, `${path}.orderFrames`)
    frameByKey.set(key, f)
  }
  for (const tid of topicIds) {
    if (!frameByKey.has(`topicMessage:${tid}`))
      throw new ValidationError(`missing topicMessage frame for topic "${tid}"`, `${path}.orderFrames`)
  }
  for (const mid of messageById.keys()) {
    if (!frameByKey.has(`messageBlock:${mid}`))
      throw new ValidationError(`missing messageBlock frame for message "${mid}"`, `${path}.orderFrames`)
  }
  for (const bid of branchById.keys()) {
    if (!frameByKey.has(`branchSuffix:${bid}`))
      throw new ValidationError(`missing branchSuffix frame for branch "${bid}"`, `${path}.orderFrames`)
  }
  for (const f of payload.orderFrames) {
    if (f.kind === 'topicMessage') {
      if (!topicIds.has(f.parentId))
        throw new ValidationError(`frame parent topic unknown/tombstoned "${f.parentId}"`, `${path}.orderFrames`)
    } else if (f.kind === 'messageBlock') {
      if (!messageById.has(f.parentId))
        throw new ValidationError(`frame parent message unknown/tombstoned "${f.parentId}"`, `${path}.orderFrames`)
    } else {
      if (!branchById.has(f.parentId))
        throw new ValidationError(`frame parent branch unknown/tombstoned "${f.parentId}"`, `${path}.orderFrames`)
    }
  }

  // Membership maps for coverage checks.
  const mainMessagesByTopic = new Map<string, MessageEntityV3[]>()
  const suffixByBranch = new Map<string, MessageEntityV3[]>()
  for (const m of payload.messages) {
    if (m.branchId === null) {
      const arr = mainMessagesByTopic.get(m.topicId) ?? []
      arr.push(m)
      mainMessagesByTopic.set(m.topicId, arr)
    } else {
      const arr = suffixByBranch.get(m.branchId) ?? []
      arr.push(m)
      suffixByBranch.set(m.branchId, arr)
    }
  }
  const blocksByMessage = new Map<string, MessageBlockEntity[]>()
  for (const b of payload.messageBlocks) {
    const arr = blocksByMessage.get(b.messageId) ?? []
    arr.push(b)
    blocksByMessage.set(b.messageId, arr)
  }

  for (const f of payload.orderFrames) {
    const framePath = `${path}.orderFrames[ kind=${f.kind} parentId=${f.parentId}]`
    let liveChildren: Array<{ id: string; membership: SyncClock }> = []
    if (f.kind === 'topicMessage') {
      const children = mainMessagesByTopic.get(f.parentId) ?? []
      liveChildren = children.map((c) => ({ id: c.id, membership: c.parentMembershipClock }))
      // topicMessage frames are main-owned only: every child must be branchId null.
      for (const c of children) {
        if (c.branchId !== null) {
          throw new ValidationError(
            `topicMessage frame for topic "${f.parentId}" must not include branch message "${c.id}"`,
            framePath
          )
        }
      }
    } else if (f.kind === 'messageBlock') {
      const children = blocksByMessage.get(f.parentId) ?? []
      liveChildren = children.map((c) => ({ id: c.id, membership: c.parentMembershipClock }))
    } else {
      const children = suffixByBranch.get(f.parentId) ?? []
      liveChildren = children.map((c) => ({ id: c.id, membership: c.parentMembershipClock }))
      for (const c of children) {
        if (c.branchId !== f.parentId) {
          throw new ValidationError(
            `branchSuffix frame for branch "${f.parentId}" must not include message "${c.id}"`,
            framePath
          )
        }
      }
    }
    // Membership parent binding: main messages bind topicId, branch messages bind branchId.
    for (const m of payload.messages) {
      void m
    }
    const childIdSet = new Set<string>(liveChildren.map((c) => c.id))
    if (f.orderedChildIds.length !== childIdSet.size) {
      throw new ValidationError(
        `orderedChildIds length ${f.orderedChildIds.length} != live children ${childIdSet.size} for parent ${f.parentId}`,
        framePath
      )
    }
    for (const cid of f.orderedChildIds) {
      if (!childIdSet.has(cid)) {
        throw new ValidationError(
          `orderedChildIds contains unknown/deleted child "${cid}" for parent ${f.parentId}`,
          framePath
        )
      }
    }
    if (new Set(f.orderedChildIds).size !== f.orderedChildIds.length) {
      throw new ValidationError('duplicate orderedChildIds', framePath)
    }
    const childMembershipById = new Map<string, SyncClock>()
    for (const c of liveChildren) childMembershipById.set(c.id, c.membership)
    let seenGreater = false
    const suffix: Array<{ id: string; clock: SyncClock }> = []
    for (let idx = 0; idx < f.orderedChildIds.length; idx++) {
      const childId = f.orderedChildIds[idx]
      const mem = childMembershipById.get(childId)!
      const cmp = compareClocks(mem, f.frameClock)
      const isGreater = cmp > 0
      if (isGreater) {
        seenGreater = true
        suffix.push({ id: childId, clock: mem })
      } else if (seenGreater) {
        throw new ValidationError(
          `membershipClock suffix violation: covered child "${childId}" after greater-than-frame child for parent ${f.parentId}`,
          `${framePath}.orderedChildIds[${idx}]`
        )
      }
    }
    const expectedSuffix = [...suffix].sort((a, b) => {
      const c = compareClocks(a.clock, b.clock)
      if (c !== 0) return c
      return compareUtf8ByteLex(a.id, b.id)
    })
    for (let i = 0; i < suffix.length; i++) {
      if (suffix[i].id !== expectedSuffix[i].id) {
        throw new ValidationError(
          `membershipClock suffix not sorted deterministically for parent ${f.parentId}: expected "${expectedSuffix[i].id}" at suffix index ${i} but got "${suffix[i].id}"`,
          framePath
        )
      }
      if (i > 0) {
        const c = compareClocks(suffix[i].clock, suffix[i - 1].clock)
        if (c < 0) throw new ValidationError('suffix membershipClock not ascending', framePath)
        if (c === 0) {
          const idCmp = compareUtf8ByteLex(suffix[i - 1].id, suffix[i].id)
          if (idCmp >= 0) throw new ValidationError('suffix id not ascending for equal clocks', framePath)
        }
      }
    }
  }
}

function validateManifestV3Recompute(payload: SyncPayloadV3, path: string): void {
  const manifest = payload.manifest
  const liveCounts = {
    topic: payload.topics.length,
    message: payload.messages.length,
    messageBlock: payload.messageBlocks.length,
    branch: payload.branches.length
  }
  const tCounts = { topic: 0, message: 0, messageBlock: 0, topicBranch: 0 }
  for (const t of payload.tombstones) {
    if (t.entityType === 'topic') tCounts.topic++
    else if (t.entityType === 'message') tCounts.message++
    else if (t.entityType === 'messageBlock') tCounts.messageBlock++
    else if (t.entityType === 'topicBranch') tCounts.topicBranch++
  }
  const fCounts = { topicMessage: 0, messageBlock: 0, branchSuffix: 0 }
  for (const f of payload.orderFrames) {
    if (f.kind === 'topicMessage') fCounts.topicMessage++
    else if (f.kind === 'messageBlock') fCounts.messageBlock++
    else fCounts.branchSuffix++
  }
  if (
    manifest.liveCounts.topic !== liveCounts.topic ||
    manifest.liveCounts.message !== liveCounts.message ||
    manifest.liveCounts.messageBlock !== liveCounts.messageBlock ||
    manifest.liveCounts.branch !== liveCounts.branch
  ) {
    throw new ValidationError(
      `manifest liveCounts mismatch: expected ${JSON.stringify(liveCounts)} got ${JSON.stringify(manifest.liveCounts)}`,
      `${path}.manifest.liveCounts`
    )
  }
  if (
    manifest.tombstoneCounts.topic !== tCounts.topic ||
    manifest.tombstoneCounts.message !== tCounts.message ||
    manifest.tombstoneCounts.messageBlock !== tCounts.messageBlock ||
    manifest.tombstoneCounts.topicBranch !== tCounts.topicBranch
  ) {
    throw new ValidationError(
      `manifest tombstoneCounts mismatch: expected ${JSON.stringify(tCounts)} got ${JSON.stringify(manifest.tombstoneCounts)}`,
      `${path}.manifest.tombstoneCounts`
    )
  }
  if (
    manifest.frameCounts.topicMessage !== fCounts.topicMessage ||
    manifest.frameCounts.messageBlock !== fCounts.messageBlock ||
    manifest.frameCounts.branchSuffix !== fCounts.branchSuffix
  ) {
    throw new ValidationError(
      `manifest frameCounts mismatch: expected ${JSON.stringify(fCounts)} got ${JSON.stringify(manifest.frameCounts)}`,
      `${path}.manifest.frameCounts`
    )
  }
  if (manifest.completeness !== COMPLETENESS_COMPLETE) {
    throw new ValidationError('manifest completeness must be "complete"', `${path}.manifest.completeness`)
  }
  const manifestV3 = manifest
  if (manifestV3.replacementCount !== payload.replacementRegisters.length) {
    throw new ValidationError(
      `manifest replacementCount mismatch: expected ${(payload).replacementRegisters.length} got ${manifestV3.replacementCount}`,
      `${path}.manifest.replacementCount`
    )
  }
}

function isV3PayloadLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const obj = value as Record<string, unknown>
  return obj.payloadSchema === PAYLOAD_SCHEMA_V3 || obj.inventoryVersion === INVENTORY_VERSION_V3
}

export function isV3EnvelopeLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (value as Record<string, unknown>).wireVersion === WIRE_VERSION_V3
}

export function validatePayloadV3(value: unknown): SyncPayloadV3 & { readonly [ValidatedPayloadBrand]: true } {
  return validatePayloadV3Structure(value, 'payload') as SyncPayloadV3 & {
    readonly [ValidatedPayloadBrand]: true
  }
}

export function validateEnvelopeV3(value: unknown): SyncEnvelopeV3 & { readonly [ValidatedEnvelopeBrand]: true } {
  const obj = assertPlainObject(value, '$')
  assertExactKeys(obj, ENVELOPE_KEYS, '$')
  if (obj.wireVersion !== WIRE_VERSION_V3)
    throw new ValidationError(`wireVersion must be "${WIRE_VERSION_V3}"`, '$.wireVersion')
  assertNonEmptyValidUnicodeScalarString(obj.channelId, '$.channelId')
  assertSafeNonNegativeInt(obj.watermark, '$.watermark')
  if (obj.digestScheme !== DIGEST_SCHEME)
    throw new ValidationError(`digestScheme must be "${DIGEST_SCHEME}"`, '$.digestScheme')
  if (typeof obj.digest !== 'string' || !/^[0-9a-f]{64}$/.test(obj.digest)) {
    throw new ValidationError('digest must be lowercase 64hex', '$.digest')
  }
  const payload = validatePayloadV3Structure(obj.payload, '$.payload')
  return {
    wireVersion: obj.wireVersion as typeof WIRE_VERSION_V3,
    channelId: obj.channelId as string,
    watermark: obj.watermark as number,
    digestScheme: obj.digestScheme as typeof DIGEST_SCHEME,
    digest: obj.digest,
    payload
  } as SyncEnvelopeV3 & { readonly [ValidatedEnvelopeBrand]: true }
}

export function isSyncPayloadV3(value: unknown): value is SyncPayloadV3 {
  try {
    validatePayloadV3(value)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Baseline v4: assistant-config full sync (branch + assistant only, §10D)
// Inventory: topic-message-stable-block-order-branch-assistant-v4 at
// sync-baseline-wire-v4 / chat-core-baseline-v4 / parent-order-frame-v1.
// - V3 chat/branch/frame/replacement content unchanged (reused validators).
// - New `assistantConfigs` array: full portable DTO + entity/field clocks.
// - New `assistantTombstones` array: explicit deletion tombstones.
// - Manifest gains assistant live/tombstone counts; digest input stays payload-only.
// - v1-v3 validators above are unchanged (old inputs still validate); new
//   clients publish v4 and fail closed on unknown/incompatible versions.
// - Topic `assistantId` references are opaque: closure never requires the
//   referenced assistant to exist and never fabricates one.
// ---------------------------------------------------------------------------

export type AssistantConfigFieldClockKeyV4 =
  | 'name'
  | 'prompt'
  | 'type'
  | 'emoji'
  | 'description'
  | 'tags'
  | 'model'
  | 'defaultModel'
  | 'settings'
  | 'knowledgeBaseIds'
  | 'mcpMode'
  | 'mcpServerIds'
  | 'enableWebSearch'
  | 'webSearchProviderId'
  | 'enableUrlContext'
  | 'enableGenerateImage'
  | 'knowledgeRecognition'
  | 'enableMemory'

export const ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4: ReadonlySet<string> = new Set([
  'name',
  'prompt',
  'type',
  'emoji',
  'description',
  'tags',
  'model',
  'defaultModel',
  'settings',
  'knowledgeBaseIds',
  'mcpMode',
  'mcpServerIds',
  'enableWebSearch',
  'webSearchProviderId',
  'enableUrlContext',
  'enableGenerateImage',
  'knowledgeRecognition',
  'enableMemory'
])

export interface AssistantConfigEntityV4 {
  key: string
  kind: 'assistant' | 'defaults'
  id: string
  config: Record<string, unknown>
  entityClock: SyncClock
  fieldClocks: Record<string, SyncClock>
}

export interface AssistantTombstoneV4 {
  key: string
  kind: 'assistant' | 'defaults'
  id: string
  deletionClock: DeletionClock
  survivingEntityClock: SyncClock | null
}

export interface ManifestV4 {
  payloadSchema: typeof PAYLOAD_SCHEMA_V4
  inventoryVersion: typeof INVENTORY_VERSION_V4
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE_V4
  liveCounts: { topic: number; message: number; messageBlock: number; branch: number; assistantConfig: number }
  tombstoneCounts: {
    topic: number
    message: number
    messageBlock: number
    topicBranch: number
    assistantConfig: number
  }
  frameCounts: { topicMessage: number; messageBlock: number; branchSuffix: number }
  replacementCount: number
  completeness: typeof COMPLETENESS_COMPLETE
}

export interface SyncPayloadV4 {
  payloadSchema: typeof PAYLOAD_SCHEMA_V4
  inventoryVersion: typeof INVENTORY_VERSION_V4
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE_V4
  topics: TopicEntity[]
  messages: MessageEntityV3[]
  messageBlocks: MessageBlockEntity[]
  branches: BranchEntityV3[]
  assistantConfigs: AssistantConfigEntityV4[]
  tombstones: TombstoneV3[]
  assistantTombstones: AssistantTombstoneV4[]
  orderFrames: OrderFrameV3[]
  replacementRegisters: ReplacementRegisterV3[]
  manifest: ManifestV4
}

export interface SyncEnvelopeV4 {
  wireVersion: typeof WIRE_VERSION_V4
  channelId: string
  watermark: number
  digestScheme: typeof DIGEST_SCHEME
  digest: string
  payload: SyncPayloadV4
}

const ASSISTANT_CONFIG_ENTITY_KEYS_V4 = new Set<string>(['key', 'kind', 'id', 'config', 'entityClock', 'fieldClocks'])
const ASSISTANT_TOMBSTONE_KEYS_V4 = new Set<string>(['key', 'kind', 'id', 'deletionClock', 'survivingEntityClock'])
const PAYLOAD_V4_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'topics',
  'messages',
  'messageBlocks',
  'branches',
  'assistantConfigs',
  'tombstones',
  'assistantTombstones',
  'orderFrames',
  'replacementRegisters',
  'manifest'
])
const MANIFEST_V4_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'liveCounts',
  'tombstoneCounts',
  'frameCounts',
  'replacementCount',
  'completeness'
])
const LIVE_COUNTS_KEYS_V4 = new Set<string>(['topic', 'message', 'messageBlock', 'branch', 'assistantConfig'])
const TOMBSTONE_COUNTS_KEYS_V4 = new Set<string>(['topic', 'message', 'messageBlock', 'topicBranch', 'assistantConfig'])
const FRAME_COUNTS_KEYS_V4 = new Set<string>(['topicMessage', 'messageBlock', 'branchSuffix'])

function validateAssistantConfigEntityV4(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, ASSISTANT_CONFIG_ENTITY_KEYS_V4, path)
  const key = assertNonEmptyValidUnicodeScalarString(obj.key, `${path}.key`)
  if (obj.kind !== 'assistant' && obj.kind !== 'defaults') {
    throw new ValidationError('kind must be assistant|defaults', `${path}.kind`)
  }
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  const expectedKey = `assistant_config:${obj.kind as string}:${obj.id as string}`
  if (key !== expectedKey) {
    throw new ValidationError(`key must equal assistant_config:<kind>:<id> (got "${key}")`, `${path}.key`)
  }
  if (obj.kind === 'defaults' && obj.id !== 'defaults') {
    throw new ValidationError('defaults id must be "defaults"', `${path}.id`)
  }
  // Full DTO strict via structural key check here (deep DTO validator lives in
  // assistantConfig.ts; wire keeps exact-key + denied-key gate to avoid import).
  // Validate config is a plain object with exact allowlisted top keys only.
  const config = assertPlainObject(obj.config, `${path}.config`)
  const allowed = new Set<string>([
    'schemaVersion',
    'kind',
    'id',
    'name',
    'prompt',
    'type',
    'emoji',
    'description',
    'tags',
    'model',
    'defaultModel',
    'settings',
    'knowledgeBaseIds',
    'mcpMode',
    'mcpServerIds',
    'enableWebSearch',
    'webSearchProviderId',
    'enableUrlContext',
    'enableGenerateImage',
    'knowledgeRecognition',
    'enableMemory',
    'deleted'
  ])
  for (const k of Object.keys(config)) {
    if (!allowed.has(k)) throw new ValidationError(`config field "${k}" not allowlisted`, `${path}.config.${k}`)
  }
  if (config.schemaVersion !== 1) {
    throw new ValidationError('config schemaVersion must be 1', `${path}.config.schemaVersion`)
  }
  if (config.kind !== obj.kind || config.id !== obj.id) {
    throw new ValidationError('config kind/id must agree with entity kind/id', `${path}.config`)
  }
  if (config.deleted === true) {
    throw new ValidationError('live assistantConfigs must not carry deleted=true (use tombstone)', `${path}.config`)
  }
  validateClock(obj.entityClock, `${path}.entityClock`, false)
  const clocks = assertPlainObject(obj.fieldClocks, `${path}.fieldClocks`)
  for (const k of Object.keys(clocks)) {
    if (!ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4.has(k)) {
      throw new ValidationError(`fieldClock "${k}" not allowlisted`, `${path}.fieldClocks.${k}`)
    }
    validateClock(clocks[k], `${path}.fieldClocks.${k}`, false)
  }
  // Every present mutable config field must carry a clock (absent fields need none).
  const presentMutable = Object.keys(config).filter((k) => ASSISTANT_CONFIG_FIELD_CLOCK_KEYS_V4.has(k))
  for (const k of presentMutable) {
    if (!(k in clocks)) throw new ValidationError(`missing fieldClock for present field "${k}"`, `${path}.fieldClocks`)
  }
}

function validateAssistantTombstoneV4(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, ASSISTANT_TOMBSTONE_KEYS_V4, path)
  const key = assertNonEmptyValidUnicodeScalarString(obj.key, `${path}.key`)
  if (obj.kind !== 'assistant' && obj.kind !== 'defaults') {
    throw new ValidationError('kind must be assistant|defaults', `${path}.kind`)
  }
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  const expectedKey = `assistant_config:${obj.kind as string}:${obj.id as string}`
  if (key !== expectedKey) {
    throw new ValidationError(`key must equal assistant_config:<kind>:<id> (got "${key}")`, `${path}.key`)
  }
  validateClock(obj.deletionClock, `${path}.deletionClock`, true)
  if (obj.survivingEntityClock === null) {
    // ok
  } else {
    validateClock(obj.survivingEntityClock, `${path}.survivingEntityClock`, false)
  }
}

function validateManifestV4(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MANIFEST_V4_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA_V4)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA_V4}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION_V4)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION_V4}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE_V4) throw new ValidationError(`scope must be "${SCOPE_V4}"`, `${path}.scope`)
  const liveCounts = assertPlainObject(obj.liveCounts, `${path}.liveCounts`)
  assertExactKeys(liveCounts, LIVE_COUNTS_KEYS_V4, `${path}.liveCounts`)
  for (const k of LIVE_COUNTS_KEYS_V4) assertSafeNonNegativeInt(liveCounts[k], `${path}.liveCounts.${k}`)
  const tCounts = assertPlainObject(obj.tombstoneCounts, `${path}.tombstoneCounts`)
  assertExactKeys(tCounts, TOMBSTONE_COUNTS_KEYS_V4, `${path}.tombstoneCounts`)
  for (const k of TOMBSTONE_COUNTS_KEYS_V4) assertSafeNonNegativeInt(tCounts[k], `${path}.tombstoneCounts.${k}`)
  const fCounts = assertPlainObject(obj.frameCounts, `${path}.frameCounts`)
  assertExactKeys(fCounts, FRAME_COUNTS_KEYS_V4, `${path}.frameCounts`)
  for (const k of FRAME_COUNTS_KEYS_V4) assertSafeNonNegativeInt(fCounts[k], `${path}.frameCounts.${k}`)
  assertSafeNonNegativeInt(obj.replacementCount, `${path}.replacementCount`)
  if (obj.completeness !== COMPLETENESS_COMPLETE)
    throw new ValidationError('completeness must be "complete"', `${path}.completeness`)
}

function validatePayloadV4Structure(value: unknown, path: string): SyncPayloadV4 {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, PAYLOAD_V4_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA_V4)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA_V4}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION_V4)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION_V4}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE_V4) throw new ValidationError(`scope must be "${SCOPE_V4}"`, `${path}.scope`)
  const topics = assertPlainArray(obj.topics, `${path}.topics`)
  topics.forEach((t, idx) => validateTopic(t, `${path}.topics[${idx}]`))
  const messages = assertPlainArray(obj.messages, `${path}.messages`)
  messages.forEach((m, idx) => validateMessageV3(m, `${path}.messages[${idx}]`))
  const blocks = assertPlainArray(obj.messageBlocks, `${path}.messageBlocks`)
  blocks.forEach((b, idx) => validateMessageBlock(b, `${path}.messageBlocks[${idx}]`))
  const branches = assertPlainArray(obj.branches, `${path}.branches`)
  branches.forEach((b, idx) => validateBranchV3(b, `${path}.branches[${idx}]`))
  const assistantConfigs = assertPlainArray(obj.assistantConfigs, `${path}.assistantConfigs`)
  assistantConfigs.forEach((c, idx) => validateAssistantConfigEntityV4(c, `${path}.assistantConfigs[${idx}]`))
  const tombstones = assertPlainArray(obj.tombstones, `${path}.tombstones`)
  tombstones.forEach((t, idx) => validateTombstoneV3Shim(t, `${path}.tombstones[${idx}]`))
  const assistantTombstones = assertPlainArray(obj.assistantTombstones, `${path}.assistantTombstones`)
  assistantTombstones.forEach((t, idx) => validateAssistantTombstoneV4(t, `${path}.assistantTombstones[${idx}]`))
  const frames = assertPlainArray(obj.orderFrames, `${path}.orderFrames`)
  frames.forEach((f, idx) => validateOrderFrameV3(f, `${path}.orderFrames[${idx}]`))
  const registers = assertPlainArray(obj.replacementRegisters, `${path}.replacementRegisters`)
  registers.forEach((r, idx) => validateReplacementRegister(r, `${path}.replacementRegisters[${idx}]`))
  validateManifestV4(obj.manifest, `${path}.manifest`)
  assertStrictlySortedByUtf8(topics as TopicEntity[], (v) => v.id, `${path}.topics`)
  assertStrictlySortedByUtf8(messages as MessageEntityV3[], (v) => v.id, `${path}.messages`)
  assertStrictlySortedByUtf8(blocks as MessageBlockEntity[], (v) => v.id, `${path}.messageBlocks`)
  assertStrictlySortedByUtf8(branches as BranchEntityV3[], (v) => v.id, `${path}.branches`)
  assertStrictlySortedByUtf8(assistantConfigs as AssistantConfigEntityV4[], (v) => v.key, `${path}.assistantConfigs`)
  assertStrictlySortedByUtf8(registers as ReplacementRegisterV3[], (v) => v.messageId, `${path}.replacementRegisters`)
  // Reuse v3 closure + manifest recompute for the chat/branch subset, then
  // check the assistant extension (sorted, no live/tombstone overlap, counts).
  validatePayloadV3ClosureShim(
    {
      topics: obj.topics,
      messages: obj.messages,
      messageBlocks: obj.messageBlocks,
      branches: obj.branches,
      tombstones: obj.tombstones,
      orderFrames: obj.orderFrames
    } as unknown as SyncPayloadV3,
    path
  )
  const liveKeys = new Set<string>((assistantConfigs as AssistantConfigEntityV4[]).map((c) => c.key))
  const tombKeys = new Set<string>()
  for (const t of assistantTombstones as AssistantTombstoneV4[]) {
    if (tombKeys.has(t.key))
      throw new ValidationError(`duplicate assistant tombstone ${t.key}`, `${path}.assistantTombstones`)
    tombKeys.add(t.key)
    if (liveKeys.has(t.key))
      throw new ValidationError(`assistant both live and tombstoned: ${t.key}`, `${path}.assistantTombstones`)
  }
  // Assistant references from topics are opaque: no existence requirement, no fabrication.
  validateManifestV4Recompute(obj as unknown as SyncPayloadV4, path)
  return obj as unknown as SyncPayloadV4
}

function validateManifestV4Recompute(payload: SyncPayloadV4, path: string): void {
  const manifest = payload.manifest
  const tCounts = { topic: 0, message: 0, messageBlock: 0, topicBranch: 0 }
  for (const t of payload.tombstones) {
    if (t.entityType === 'topic') tCounts.topic++
    else if (t.entityType === 'message') tCounts.message++
    else if (t.entityType === 'messageBlock') tCounts.messageBlock++
    else if (t.entityType === 'topicBranch') tCounts.topicBranch++
  }
  const fCounts = { topicMessage: 0, messageBlock: 0, branchSuffix: 0 }
  for (const f of payload.orderFrames) {
    if (f.kind === 'topicMessage') fCounts.topicMessage++
    else if (f.kind === 'messageBlock') fCounts.messageBlock++
    else fCounts.branchSuffix++
  }
  if (
    manifest.liveCounts.topic !== payload.topics.length ||
    manifest.liveCounts.message !== payload.messages.length ||
    manifest.liveCounts.messageBlock !== payload.messageBlocks.length ||
    manifest.liveCounts.branch !== (payload.branches as unknown[]).length ||
    manifest.liveCounts.assistantConfig !== (payload.assistantConfigs as unknown[]).length
  ) {
    throw new ValidationError('manifest liveCounts mismatch', `${path}.manifest.liveCounts`)
  }
  if (
    manifest.tombstoneCounts.topic !== tCounts.topic ||
    manifest.tombstoneCounts.message !== tCounts.message ||
    manifest.tombstoneCounts.messageBlock !== tCounts.messageBlock ||
    manifest.tombstoneCounts.topicBranch !== tCounts.topicBranch ||
    manifest.tombstoneCounts.assistantConfig !== (payload.assistantTombstones as unknown[]).length
  ) {
    throw new ValidationError('manifest tombstoneCounts mismatch', `${path}.manifest.tombstoneCounts`)
  }
  if (
    manifest.frameCounts.topicMessage !== fCounts.topicMessage ||
    manifest.frameCounts.messageBlock !== fCounts.messageBlock ||
    manifest.frameCounts.branchSuffix !== fCounts.branchSuffix
  ) {
    throw new ValidationError('manifest frameCounts mismatch', `${path}.manifest.frameCounts`)
  }
  if (manifest.replacementCount !== (payload.replacementRegisters as unknown[]).length) {
    throw new ValidationError('manifest replacementCount mismatch', `${path}.manifest.replacementCount`)
  }
  if (manifest.completeness !== COMPLETENESS_COMPLETE) {
    throw new ValidationError('manifest completeness must be "complete"', `${path}.manifest.completeness`)
  }
}

function isV4PayloadLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const obj = value as Record<string, unknown>
  return obj.payloadSchema === PAYLOAD_SCHEMA_V4 || obj.inventoryVersion === INVENTORY_VERSION_V4
}

export function isV4EnvelopeLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (value as Record<string, unknown>).wireVersion === WIRE_VERSION_V4
}

export function validatePayloadV4(value: unknown): SyncPayloadV4 & { readonly [ValidatedPayloadBrand]: true } {
  return validatePayloadV4Structure(value, 'payload') as SyncPayloadV4 & {
    readonly [ValidatedPayloadBrand]: true
  }
}

export function validateEnvelopeV4(value: unknown): SyncEnvelopeV4 & { readonly [ValidatedEnvelopeBrand]: true } {
  const obj = assertPlainObject(value, '$')
  assertExactKeys(obj, ENVELOPE_KEYS, '$')
  if (obj.wireVersion !== WIRE_VERSION_V4)
    throw new ValidationError(`wireVersion must be "${WIRE_VERSION_V4}"`, '$.wireVersion')
  assertNonEmptyValidUnicodeScalarString(obj.channelId, '$.channelId')
  assertSafeNonNegativeInt(obj.watermark, '$.watermark')
  if (obj.digestScheme !== DIGEST_SCHEME)
    throw new ValidationError(`digestScheme must be "${DIGEST_SCHEME}"`, '$.digestScheme')
  if (typeof obj.digest !== 'string' || !/^[0-9a-f]{64}$/.test(obj.digest)) {
    throw new ValidationError('digest must be lowercase 64hex', '$.digest')
  }
  const payload = validatePayloadV4Structure(obj.payload, '$.payload')
  return {
    wireVersion: obj.wireVersion as typeof WIRE_VERSION_V4,
    channelId: obj.channelId as string,
    watermark: obj.watermark as number,
    digestScheme: obj.digestScheme as typeof DIGEST_SCHEME,
    digest: obj.digest,
    payload
  } as SyncEnvelopeV4 & { readonly [ValidatedEnvelopeBrand]: true }
}

export function isSyncPayloadV4(value: unknown): value is SyncPayloadV4 {
  try {
    validatePayloadV4(value)
    return true
  } catch {
    return false
  }
}

// Local shims: v3 validators are function-scoped below the v4 block in source
// order; forward to the hoisted shared implementations via dynamic lookup to
// avoid duplicating closure logic. These resolve at call time (after module init).
function validateTombstoneV3Shim(value: unknown, path: string): void {
  ;(validateTombstoneV3 as unknown as (v: unknown, p: string) => void)(value, path)
}
function validatePayloadV3ClosureShim(payload: SyncPayloadV3, path: string): void {
  ;(validatePayloadV3Closure as unknown as (p: SyncPayloadV3, pp: string) => void)(payload, path)
}

// ---------------------------------------------------------------------------
// Baseline v5: attachment full sync (branch + assistant + file/image/video attachments, §10E)
// Inventory: topic-message-stable-block-order-branch-assistant-attachment-v5 at
// sync-baseline-wire-v5 / chat-core-baseline-v5 / parent-order-frame-v1.
// - V4 chat/branch/assistant/frame/replacement content unchanged.
// - New `fileAssets` array: strict FileAsset entities with clocks (identity
//   immutable id/sha256/byteLength/extension; mutable mimeType/originalName/
//   createdAt via per-field clocks). Every asset strictly validates via the
//   shared attachments validator (exact 7 keys, no path/count/tokens/purpose).
// - New wire block rule: file/image/video blocks carry full portable state
//   with explicit valid refs; tool/citation remain excluded. The block
//   validator now permits file/image/video only when they project to a full
//   valid FileAsset refs set (strict shape, no partial shell, no arbitrary
//   overflow) — otherwise the block is still unsupported and fails the
//   candidate barrier (never partial). Blocks of those types with valid refs
//   are stable-checkpoint eligible when status is stable and pending barrier
//   is clear (no secret/path keys ever on wire).
// - Manifest gains fileAsset live count; digest input stays payload-only.
// - v1-v4 validators unchanged (old inputs still validate); new clients
//   publish v5 and fail closed on unknown/incompatible versions.
// ---------------------------------------------------------------------------

export type FileAssetFieldClockKeyV5 = 'mimeType' | 'originalName' | 'createdAt'

export const FILE_ASSET_FIELD_CLOCK_KEYS_V5: ReadonlySet<string> = new Set(['mimeType', 'originalName', 'createdAt'])

export type BlockFieldClockKeyV5 = 'type' | 'content' | 'status' | 'createdAt' | 'updatedAt' | 'assetIds'

export const BLOCK_FIELD_CLOCK_KEYS_V5: ReadonlySet<string> = new Set([
  'type',
  'content',
  'status',
  'createdAt',
  'updatedAt',
  'assetIds'
])

export interface MessageBlockEntityV5 {
  id: string
  messageId: string
  type: string | null
  content: string | null
  status: string | null
  createdAt: string | null
  updatedAt: string | null
  assetIds: string[]
  entityClock: SyncClock
  fieldClocks: Record<BlockFieldClockKeyV5, SyncClock>
  parentMembershipClock: SyncClock
}

const MESSAGE_BLOCK_KEYS_V5 = new Set<string>([
  'id',
  'messageId',
  'type',
  'content',
  'status',
  'createdAt',
  'updatedAt',
  'assetIds',
  'entityClock',
  'fieldClocks',
  'parentMembershipClock'
])

export interface FileAssetEntityV5 {
  id: string
  sha256: string
  byteLength: number
  extension: string
  mimeType: string
  originalName: string
  createdAt: string
  entityClock: SyncClock
  fieldClocks: Record<FileAssetFieldClockKeyV5, SyncClock>
}

export interface ManifestV5 {
  payloadSchema: typeof PAYLOAD_SCHEMA_V5
  inventoryVersion: typeof INVENTORY_VERSION_V5
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE_V5
  liveCounts: {
    topic: number
    message: number
    messageBlock: number
    branch: number
    assistantConfig: number
    fileAsset: number
  }
  tombstoneCounts: {
    topic: number
    message: number
    messageBlock: number
    topicBranch: number
    fileAsset: number
    assistantConfig: number
  }
  frameCounts: { topicMessage: number; messageBlock: number; branchSuffix: number }
  replacementCount: number
  completeness: typeof COMPLETENESS_COMPLETE
}

export interface SyncPayloadV5 {
  payloadSchema: typeof PAYLOAD_SCHEMA_V5
  inventoryVersion: typeof INVENTORY_VERSION_V5
  orderFrameVersion: typeof ORDER_FRAME_VERSION
  scope: typeof SCOPE_V5
  topics: TopicEntity[]
  messages: MessageEntityV3[]
  messageBlocks: MessageBlockEntityV5[]
  branches: BranchEntityV3[]
  assistantConfigs: AssistantConfigEntityV4[]
  fileAssets: FileAssetEntityV5[]
  tombstones: TombstoneV3[]
  assistantTombstones: AssistantTombstoneV4[]
  orderFrames: OrderFrameV3[]
  replacementRegisters: ReplacementRegisterV3[]
  manifest: ManifestV5
}

export interface SyncEnvelopeV5 {
  wireVersion: typeof WIRE_VERSION_V5
  channelId: string
  watermark: number
  digestScheme: typeof DIGEST_SCHEME
  digest: string
  payload: SyncPayloadV5
}

const FILE_ASSET_ENTITY_KEYS_V5 = new Set<string>([
  'id',
  'sha256',
  'byteLength',
  'extension',
  'mimeType',
  'originalName',
  'createdAt',
  'entityClock',
  'fieldClocks'
])
const PAYLOAD_V5_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'topics',
  'messages',
  'messageBlocks',
  'branches',
  'assistantConfigs',
  'fileAssets',
  'tombstones',
  'assistantTombstones',
  'orderFrames',
  'replacementRegisters',
  'manifest'
])
const MANIFEST_V5_KEYS = new Set<string>([
  'payloadSchema',
  'inventoryVersion',
  'orderFrameVersion',
  'scope',
  'liveCounts',
  'tombstoneCounts',
  'frameCounts',
  'replacementCount',
  'completeness'
])
const LIVE_COUNTS_KEYS_V5 = new Set<string>([
  'topic',
  'message',
  'messageBlock',
  'branch',
  'assistantConfig',
  'fileAsset'
])
const TOMBSTONE_COUNTS_KEYS_V5 = new Set<string>([
  'topic',
  'message',
  'messageBlock',
  'topicBranch',
  'fileAsset',
  'assistantConfig'
])
const FRAME_COUNTS_KEYS_V5 = new Set<string>(['topicMessage', 'messageBlock', 'branchSuffix'])

export function validateMessageBlockV5(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MESSAGE_BLOCK_KEYS_V5, path)
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  assertNonEmptyValidUnicodeScalarString(obj.messageId, `${path}.messageId`)
  const typeVal = assertNullableValidUnicodeScalarString(obj.type, `${path}.type`)
  if (typeVal !== null) {
    const canonical = typeVal.trim().toLowerCase()
    // V5 permits file/image/video (media) with valid assetIds; other unsupported remain banned
    const banned = new Set(['tool', 'citation'])
    if (banned.has(canonical)) {
      throw new ValidationError(`unsupported block type "${typeVal}"`, `${path}.type`)
    }
  }
  assertNullableValidUnicodeScalarString(obj.content, `${path}.content`)
  const status = assertNullableValidUnicodeScalarString(obj.status, `${path}.status`)
  if (status !== null && TRANSIENT_SET.has(status)) {
    throw new ValidationError(`transient status "${status}" not allowed on wire`, `${path}.status`)
  }
  assertNullableValidUnicodeScalarString(obj.createdAt, `${path}.createdAt`)
  assertNullableValidUnicodeScalarString(obj.updatedAt, `${path}.updatedAt`)
  const assetIdsRaw = obj.assetIds
  if (!Array.isArray(assetIdsRaw)) throw new ValidationError('assetIds must be array', `${path}.assetIds`)
  if (Object.getPrototypeOf(assetIdsRaw as unknown[]) !== Array.prototype)
    throw new ValidationError('must be plain JSON array', `${path}.assetIds`)
  const seen = new Set<string>()
  for (let i = 0; i < assetIdsRaw.length; i++) {
    const v = assetIdsRaw[i]
    const p = `${path}.assetIds[${i}]`
    assertNonEmptyValidUnicodeScalarString(v, p)
    if ((v as string).includes('/') || (v as string).includes('\\') || (v as string).includes('..'))
      throw new ValidationError('assetIds entry must not contain path separators', p)
    if (seen.has(v as string)) throw new ValidationError(`duplicate assetIds "${v}"`, p)
    seen.add(v as string)
  }
  // Media types require non-empty assetIds; non-media must be empty
  const typeCanonical = typeVal ? typeVal.trim().toLowerCase() : ''
  const isMedia = typeCanonical === 'file' || typeCanonical === 'image' || typeCanonical === 'video'
  if (isMedia) {
    if (assetIdsRaw.length === 0)
      throw new ValidationError('media block must carry non-empty assetIds', `${path}.assetIds`)
  } else {
    if (assetIdsRaw.length !== 0)
      throw new ValidationError('non-media block must carry empty assetIds', `${path}.assetIds`)
  }
  validateClock(obj.entityClock, `${path}.entityClock`, false)
  validateFieldClocks(obj.fieldClocks, BLOCK_FIELD_CLOCK_KEYS_V5, `${path}.fieldClocks`)
  validateClock(obj.parentMembershipClock, `${path}.parentMembershipClock`, false)
}

function validateFileAssetEntityV5(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, FILE_ASSET_ENTITY_KEYS_V5, path)
  assertNonEmptyValidUnicodeScalarString(obj.id, `${path}.id`)
  if (typeof obj.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(obj.sha256)) {
    throw new ValidationError('sha256 must be lowercase 64hex', `${path}.sha256`)
  }
  assertSafeNonNegativeInt(obj.byteLength, `${path}.byteLength`)
  if (typeof obj.extension !== 'string' || !/^\.[a-z0-9]+$/.test(obj.extension)) {
    throw new ValidationError('extension must be lowercase dot extension', `${path}.extension`)
  }
  if (typeof obj.mimeType !== 'string' || obj.mimeType.length < 3 || obj.mimeType.length > 128) {
    throw new ValidationError('mimeType must be a valid mime', `${path}.mimeType`)
  }
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(obj.mimeType)) {
    throw new ValidationError('mimeType must be a valid mime', `${path}.mimeType`)
  }
  assertNonEmptyValidUnicodeScalarString(obj.originalName, `${path}.originalName`)
  if ((obj.originalName as string).includes('/') || (obj.originalName as string).includes('\\')) {
    throw new ValidationError('originalName must not contain path separators', `${path}.originalName`)
  }
  assertNonEmptyValidUnicodeScalarString(obj.createdAt, `${path}.createdAt`)
  if (!Number.isFinite(Date.parse(obj.createdAt as string))) {
    throw new ValidationError('createdAt must be ISO date', `${path}.createdAt`)
  }
  // Strict FileAsset 7-key shape (no denied keys) — mirrors attachments validator.
  const assetForShape: Record<string, unknown> = {
    id: obj.id,
    sha256: obj.sha256,
    byteLength: obj.byteLength,
    extension: obj.extension,
    mimeType: obj.mimeType,
    originalName: obj.originalName,
    createdAt: obj.createdAt
  }
  const denied = ['path', 'filepath', 'file_path', 'count', 'tokens', 'purpose', 'device', 'secret']
  for (const k of Object.keys(assetForShape)) {
    if (denied.includes(k.toLowerCase())) throw new ValidationError(`asset denied key ${k}`, path)
  }
  if ((obj.id as string).includes('/') || (obj.id as string).includes('\\') || (obj.id as string).includes('..')) {
    throw new ValidationError('asset id must not contain path separators', `${path}.id`)
  }
  validateClock(obj.entityClock, `${path}.entityClock`, false)
  const clocks = assertPlainObject(obj.fieldClocks, `${path}.fieldClocks`)
  for (const k of Object.keys(clocks)) {
    if (!FILE_ASSET_FIELD_CLOCK_KEYS_V5.has(k)) {
      throw new ValidationError(`fieldClock "${k}" not allowlisted`, `${path}.fieldClocks.${k}`)
    }
    validateClock(clocks[k], `${path}.fieldClocks.${k}`, false)
  }
  // Every present mutable file-asset field must carry a clock (absent fields need none)
  // In wire V5 every live file asset carries all three mutable fields (full state).
  for (const k of FILE_ASSET_FIELD_CLOCK_KEYS_V5) {
    if (!(k in clocks)) throw new ValidationError(`missing fieldClock for "${k}"`, `${path}.fieldClocks`)
  }
}

function validateManifestV5(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, MANIFEST_V5_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA_V5)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA_V5}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION_V5)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION_V5}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE_V5) throw new ValidationError(`scope must be "${SCOPE_V5}"`, `${path}.scope`)
  const liveCounts = assertPlainObject(obj.liveCounts, `${path}.liveCounts`)
  assertExactKeys(liveCounts, LIVE_COUNTS_KEYS_V5, `${path}.liveCounts`)
  for (const k of LIVE_COUNTS_KEYS_V5) assertSafeNonNegativeInt(liveCounts[k], `${path}.liveCounts.${k}`)
  const tCounts = assertPlainObject(obj.tombstoneCounts, `${path}.tombstoneCounts`)
  assertExactKeys(tCounts, TOMBSTONE_COUNTS_KEYS_V5, `${path}.tombstoneCounts`)
  for (const k of TOMBSTONE_COUNTS_KEYS_V5) assertSafeNonNegativeInt(tCounts[k], `${path}.tombstoneCounts.${k}`)
  const fCounts = assertPlainObject(obj.frameCounts, `${path}.frameCounts`)
  assertExactKeys(fCounts, FRAME_COUNTS_KEYS_V5, `${path}.frameCounts`)
  for (const k of FRAME_COUNTS_KEYS_V5) assertSafeNonNegativeInt(fCounts[k], `${path}.frameCounts.${k}`)
  assertSafeNonNegativeInt(obj.replacementCount, `${path}.replacementCount`)
  if (obj.completeness !== COMPLETENESS_COMPLETE)
    throw new ValidationError('completeness must be "complete"', `${path}.completeness`)
}

const TOMBSTONE_KEYS_V5 = new Set<string>(['entityType', 'entityId', 'deletionClock', 'survivingEntityClock'])
const TOMBSTONE_ENTITY_TYPES_V5: ReadonlySet<string> = new Set([
  'topic',
  'message',
  'messageBlock',
  'topicBranch',
  'fileAsset'
])

function validateTombstoneV5(value: unknown, path: string): void {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, TOMBSTONE_KEYS_V5, path)
  if (typeof obj.entityType !== 'string' || !TOMBSTONE_ENTITY_TYPES_V5.has(obj.entityType)) {
    throw new ValidationError(
      'entityType must be one of topic,message,messageBlock,topicBranch,fileAsset',
      `${path}.entityType`
    )
  }
  if (typeof obj.entityType === 'string') assertValidUnicodeScalarString(obj.entityType, `${path}.entityType`)
  assertNonEmptyValidUnicodeScalarString(obj.entityId, `${path}.entityId`)
  validateClock(obj.deletionClock, `${path}.deletionClock`, true)
  if (obj.survivingEntityClock === null) {
    // ok
  } else {
    validateClock(obj.survivingEntityClock, `${path}.survivingEntityClock`, false)
  }
}

function validatePayloadV5Structure(value: unknown, path: string): SyncPayloadV5 {
  const obj = assertPlainObject(value, path)
  assertExactKeys(obj, PAYLOAD_V5_KEYS, path)
  if (obj.payloadSchema !== PAYLOAD_SCHEMA_V5)
    throw new ValidationError(`payloadSchema must be "${PAYLOAD_SCHEMA_V5}"`, `${path}.payloadSchema`)
  if (obj.inventoryVersion !== INVENTORY_VERSION_V5)
    throw new ValidationError(`inventoryVersion must be "${INVENTORY_VERSION_V5}"`, `${path}.inventoryVersion`)
  if (obj.orderFrameVersion !== ORDER_FRAME_VERSION)
    throw new ValidationError(`orderFrameVersion must be "${ORDER_FRAME_VERSION}"`, `${path}.orderFrameVersion`)
  if (obj.scope !== SCOPE_V5) throw new ValidationError(`scope must be "${SCOPE_V5}"`, `${path}.scope`)
  const topics = assertPlainArray(obj.topics, `${path}.topics`)
  topics.forEach((t, idx) => validateTopic(t, `${path}.topics[${idx}]`))
  const messages = assertPlainArray(obj.messages, `${path}.messages`)
  messages.forEach((m, idx) => validateMessageV3(m, `${path}.messages[${idx}]`))
  const blocks = assertPlainArray(obj.messageBlocks, `${path}.messageBlocks`)
  blocks.forEach((b, idx) => validateMessageBlockV5(b, `${path}.messageBlocks[${idx}]`))
  const branches = assertPlainArray(obj.branches, `${path}.branches`)
  branches.forEach((b, idx) => validateBranchV3(b, `${path}.branches[${idx}]`))
  const assistantConfigs = assertPlainArray(obj.assistantConfigs, `${path}.assistantConfigs`)
  assistantConfigs.forEach((c, idx) => validateAssistantConfigEntityV4(c, `${path}.assistantConfigs[${idx}]`))
  const fileAssets = assertPlainArray(obj.fileAssets, `${path}.fileAssets`)
  fileAssets.forEach((a, idx) => validateFileAssetEntityV5(a, `${path}.fileAssets[${idx}]`))
  const tombstones = assertPlainArray(obj.tombstones, `${path}.tombstones`)
  tombstones.forEach((t, idx) => validateTombstoneV5(t, `${path}.tombstones[${idx}]`))
  const assistantTombstones = assertPlainArray(obj.assistantTombstones, `${path}.assistantTombstones`)
  assistantTombstones.forEach((t, idx) => validateAssistantTombstoneV4(t, `${path}.assistantTombstones[${idx}]`))
  const frames = assertPlainArray(obj.orderFrames, `${path}.orderFrames`)
  frames.forEach((f, idx) => validateOrderFrameV3(f, `${path}.orderFrames[${idx}]`))
  const registers = assertPlainArray(obj.replacementRegisters, `${path}.replacementRegisters`)
  registers.forEach((r, idx) => validateReplacementRegister(r, `${path}.replacementRegisters[${idx}]`))
  validateManifestV5(obj.manifest, `${path}.manifest`)
  assertStrictlySortedByUtf8(topics as TopicEntity[], (v) => v.id, `${path}.topics`)
  assertStrictlySortedByUtf8(messages as MessageEntityV3[], (v) => v.id, `${path}.messages`)
  assertStrictlySortedByUtf8(blocks as MessageBlockEntity[], (v) => v.id, `${path}.messageBlocks`)
  assertStrictlySortedByUtf8(branches as BranchEntityV3[], (v) => v.id, `${path}.branches`)
  assertStrictlySortedByUtf8(assistantConfigs as AssistantConfigEntityV4[], (v) => v.key, `${path}.assistantConfigs`)
  assertStrictlySortedByUtf8(fileAssets as FileAssetEntityV5[], (v) => v.id, `${path}.fileAssets`)
  assertStrictlySortedByUtf8(registers as ReplacementRegisterV3[], (v) => v.messageId, `${path}.replacementRegisters`)
  // Tombstones rank + lex order for V5 (topic < message < messageBlock < topicBranch < fileAsset)
  {
    const rank = (t: { entityType: string }): number => {
      if (t.entityType === 'topic') return 0
      if (t.entityType === 'message') return 1
      if (t.entityType === 'messageBlock') return 2
      if (t.entityType === 'topicBranch') return 3
      return 4
    }
    for (let i = 1; i < tombstones.length; i++) {
      const prev = tombstones[i - 1] as { entityType: string; entityId: string }
      const cur = tombstones[i] as { entityType: string; entityId: string }
      const pr = rank(prev)
      const cr = rank(cur)
      if (cr < pr) throw new ValidationError('tombstones not sorted by type rank', `${path}.tombstones`)
      if (cr === pr) {
        const cmp = compareUtf8ByteLex(prev.entityId, cur.entityId)
        if (cmp >= 0) {
          if (cmp === 0)
            throw new ValidationError(
              `duplicate tombstone ${cur.entityType}:${cur.entityId}`,
              `${path}.tombstones[${i}]`
            )
          throw new ValidationError('tombstones not sorted by entityId', `${path}.tombstones`)
        }
      }
    }
  }
  // Reuse v4 closure for chat/branch/assistant subset filtered to V3 tombstones
  const tombstonesV3Only = (tombstones as unknown as Array<{ entityType: string }>).filter(
    (t) => t.entityType !== 'fileAsset'
  )
  validatePayloadV3ClosureShim(
    {
      topics: obj.topics,
      messages: obj.messages,
      messageBlocks: obj.messageBlocks,
      branches: obj.branches,
      tombstones: tombstonesV3Only,
      orderFrames: obj.orderFrames
    } as unknown as SyncPayloadV3,
    path
  )
  // FileAsset live/tombstone overlap
  {
    const fileAssetIds = new Set<string>((fileAssets as FileAssetEntityV5[]).map((a) => a.id))
    const seen = new Set<string>()
    for (const t of tombstones as Array<{ entityType: string; entityId: string }>) {
      if (t.entityType !== 'fileAsset') continue
      const key = `${t.entityType}:${t.entityId}`
      if (seen.has(key)) throw new ValidationError(`duplicate tombstone ${key}`, `${path}.tombstones`)
      seen.add(key)
      if (fileAssetIds.has(t.entityId)) {
        throw new ValidationError(`entity both live and tombstoned: fileAsset ${t.entityId}`, `${path}.tombstones`)
      }
    }
  }
  const liveKeys = new Set<string>((assistantConfigs as AssistantConfigEntityV4[]).map((c) => c.key))
  const tombKeys = new Set<string>()
  for (const t of assistantTombstones as AssistantTombstoneV4[]) {
    if (tombKeys.has(t.key))
      throw new ValidationError(`duplicate assistant tombstone ${t.key}`, `${path}.assistantTombstones`)
    tombKeys.add(t.key)
    if (liveKeys.has(t.key))
      throw new ValidationError(`assistant both live and tombstoned: ${t.key}`, `${path}.assistantTombstones`)
  }
  // FileAsset closure: every block assetIds must point to a live fileAsset.
  const fileAssetIdSet = new Set<string>((fileAssets as FileAssetEntityV5[]).map((a) => a.id))
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as MessageBlockEntityV5
    for (const aid of b.assetIds) {
      if (!fileAssetIdSet.has(aid)) {
        throw new ValidationError(
          `block assetIds "${aid}" must reference a live fileAsset`,
          `${path}.messageBlocks[${i}].assetIds`
        )
      }
    }
  }
  // Ensure no unknown assetIds leakage: all fileAssets should be referenced (optional strict)
  // is not enforced as hard fail — unreferenced assets are allowed to remain but must still be valid.
  validateManifestV5Recompute(obj as unknown as SyncPayloadV5, path)
  return obj as unknown as SyncPayloadV5
}

function validateManifestV5Recompute(payload: SyncPayloadV5, path: string): void {
  const manifest = payload.manifest
  const tCounts = { topic: 0, message: 0, messageBlock: 0, topicBranch: 0, fileAsset: 0 }
  for (const t of payload.tombstones as Array<{ entityType: string }>) {
    if (t.entityType === 'topic') (tCounts as Record<string, number>).topic++
    else if (t.entityType === 'message') (tCounts as Record<string, number>).message++
    else if (t.entityType === 'messageBlock') (tCounts as Record<string, number>).messageBlock++
    else if (t.entityType === 'topicBranch') (tCounts as Record<string, number>).topicBranch++
    else if (t.entityType === 'fileAsset') (tCounts as Record<string, number>).fileAsset++
  }
  const fCounts = { topicMessage: 0, messageBlock: 0, branchSuffix: 0 }
  for (const f of payload.orderFrames) {
    if (f.kind === 'topicMessage') fCounts.topicMessage++
    else if (f.kind === 'messageBlock') fCounts.messageBlock++
    else fCounts.branchSuffix++
  }
  if (
    manifest.liveCounts.topic !== payload.topics.length ||
    manifest.liveCounts.message !== payload.messages.length ||
    manifest.liveCounts.messageBlock !== payload.messageBlocks.length ||
    manifest.liveCounts.branch !== (payload.branches as unknown[]).length ||
    manifest.liveCounts.assistantConfig !== (payload.assistantConfigs as unknown[]).length ||
    manifest.liveCounts.fileAsset !== (payload.fileAssets as unknown[]).length
  ) {
    throw new ValidationError('manifest liveCounts mismatch', `${path}.manifest.liveCounts`)
  }
  if (
    manifest.tombstoneCounts.topic !== tCounts.topic ||
    manifest.tombstoneCounts.message !== tCounts.message ||
    manifest.tombstoneCounts.messageBlock !== tCounts.messageBlock ||
    manifest.tombstoneCounts.topicBranch !== tCounts.topicBranch ||
    (manifest.tombstoneCounts as Record<string, number>).fileAsset !== (tCounts as Record<string, number>).fileAsset ||
    manifest.tombstoneCounts.assistantConfig !== (payload.assistantTombstones as unknown[]).length
  ) {
    throw new ValidationError('manifest tombstoneCounts mismatch', `${path}.manifest.tombstoneCounts`)
  }
  if (
    manifest.frameCounts.topicMessage !== fCounts.topicMessage ||
    manifest.frameCounts.messageBlock !== fCounts.messageBlock ||
    manifest.frameCounts.branchSuffix !== fCounts.branchSuffix
  ) {
    throw new ValidationError('manifest frameCounts mismatch', `${path}.manifest.frameCounts`)
  }
  if (manifest.replacementCount !== (payload.replacementRegisters as unknown[]).length) {
    throw new ValidationError('manifest replacementCount mismatch', `${path}.manifest.replacementCount`)
  }
  if (manifest.completeness !== COMPLETENESS_COMPLETE) {
    throw new ValidationError('manifest completeness must be "complete"', `${path}.manifest.completeness`)
  }
}

function isV5PayloadLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const obj = value as Record<string, unknown>
  return obj.payloadSchema === PAYLOAD_SCHEMA_V5 || obj.inventoryVersion === INVENTORY_VERSION_V5
}

export function isV5EnvelopeLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (value as Record<string, unknown>).wireVersion === WIRE_VERSION_V5
}

export function validatePayloadV5(value: unknown): SyncPayloadV5 & { readonly [ValidatedPayloadBrand]: true } {
  return validatePayloadV5Structure(value, 'payload') as SyncPayloadV5 & {
    readonly [ValidatedPayloadBrand]: true
  }
}

export function validateEnvelopeV5(value: unknown): SyncEnvelopeV5 & { readonly [ValidatedEnvelopeBrand]: true } {
  const obj = assertPlainObject(value, '$')
  assertExactKeys(obj, ENVELOPE_KEYS, '$')
  if (obj.wireVersion !== WIRE_VERSION_V5)
    throw new ValidationError(`wireVersion must be "${WIRE_VERSION_V5}"`, '$.wireVersion')
  assertNonEmptyValidUnicodeScalarString(obj.channelId, '$.channelId')
  assertSafeNonNegativeInt(obj.watermark, '$.watermark')
  if (obj.digestScheme !== DIGEST_SCHEME)
    throw new ValidationError(`digestScheme must be "${DIGEST_SCHEME}"`, '$.digestScheme')
  if (typeof obj.digest !== 'string' || !/^[0-9a-f]{64}$/.test(obj.digest)) {
    throw new ValidationError('digest must be lowercase 64hex', '$.digest')
  }
  const payload = validatePayloadV5Structure(obj.payload, '$.payload')
  return {
    wireVersion: obj.wireVersion as typeof WIRE_VERSION_V5,
    channelId: obj.channelId as string,
    watermark: obj.watermark as number,
    digestScheme: obj.digestScheme as typeof DIGEST_SCHEME,
    digest: obj.digest,
    payload
  } as SyncEnvelopeV5 & { readonly [ValidatedEnvelopeBrand]: true }
}

export function isSyncPayloadV5(value: unknown): value is SyncPayloadV5 {
  try {
    validatePayloadV5(value)
    return true
  } catch {
    return false
  }
}
