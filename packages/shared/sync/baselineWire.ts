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

function validateMessage(value: unknown, path: string): void {
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

function validateMessageBlock(value: unknown, path: string): void {
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

function validateOrderFrame(value: unknown, path: string): void {
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

export function validatePayload(value: unknown): ValidatedSyncPayload {
  return validatePayloadStructure(value, 'payload') as ValidatedSyncPayload
}

export function validateEnvelope(value: unknown): ValidatedSyncEnvelope {
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

export function parseEnvelopeJson(json: string): ValidatedSyncEnvelope {
  const parsed = parseStrictJson(json)
  return validateEnvelope(parsed)
}

export function parsePayloadJson(json: string): ValidatedSyncPayload {
  const parsed = parseStrictJson(json)
  return validatePayload(parsed)
}

// ---------------------------------------------------------------------------
// Canonicalize / Digest helpers (injected hash)
// All helpers strictly validate before canonicalizing; hash callback receives
// canonical UTF-8 bytes (TextEncoder) and must return lowercase 64hex.
// ---------------------------------------------------------------------------

export function canonicalizePayload(payload: SyncPayload): string {
  // Strict validation before canonicalize ensures lone-surrogate gap in
  // canonicalize@2.1.0 is unreachable (all strings are valid scalars).
  validatePayload(payload)
  const canonical = canonicalize(payload)
  if (typeof canonical !== 'string') {
    throw new ValidationError('payload not canonicalizable (non-I-JSON)', 'payload')
  }
  return canonical
}

export function computeSyncDigest(payload: SyncPayload, hashHex: (canonicalUtf8: Uint8Array) => string): string {
  const canonical = canonicalizePayload(payload)
  const bytes = new TextEncoder().encode(canonical)
  const digest = hashHex(bytes)
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new ValidationError('hashHex must return lowercase 64hex', 'digest')
  }
  return digest
}

export function verifySyncDigest(
  payload: SyncPayload,
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

export function verifyEnvelopeDigest(envelope: SyncEnvelope, hashHex: (canonicalUtf8: Uint8Array) => string): boolean {
  const validated = validateEnvelope(envelope)
  const canonical = canonicalizePayload(validated.payload)
  const bytes = new TextEncoder().encode(canonical)
  const computed = hashHex(bytes)
  if (typeof computed !== 'string' || !/^[0-9a-f]{64}$/.test(computed)) {
    throw new ValidationError('hashHex must return lowercase 64hex', 'digest')
  }
  return computed === validated.digest
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isSyncPayload(value: unknown): value is SyncPayload {
  try {
    validatePayload(value)
    return true
  } catch {
    return false
  }
}

export function isSyncEnvelope(value: unknown): value is SyncEnvelope {
  try {
    validateEnvelope(value)
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
