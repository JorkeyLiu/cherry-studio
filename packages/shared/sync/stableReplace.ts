/**
 * Dedicated strictly-closed `message_stable_replace` operation wire contract
 * (SYNC-DATA-050 / SYNC-CC-025, receiver-first vertical slice).
 *
 * Reuses the existing `SyncOperation` endpoint/envelope with one precise
 * `op: 'message_stable_replace'`. No generic atomic group: one op is one
 * per-channel seq item and one receiver-visible SQLite transaction.
 *
 * JSON-only, no Node/Electron imports. All nested entity/frame/clock rules
 * delegate to the existing locked `baselineWire` validators
 * (`validateMessage` / `validateMessageBlock` / `validateOrderFrame` /
 * `validateClock`) and the shared `compareUtf8ByteLex` contract — no copied
 * divergent rules. This module adds only the eight-key payload closure and
 * the envelope/payload binding/mirror rules locked by SYNC-DATA-050.
 */

import {
  compareUtf8ByteLex,
  ORDER_FRAME_VERSION,
  validateClock,
  validateMessage,
  validateMessageBlock,
  validateOrderFrame
} from './baselineWire'

/** Single legal op name for this unit. */
export const MESSAGE_STABLE_REPLACE_OP = 'message_stable_replace' as const

/** Locked payload version identifier (single allowed value). */
export const MESSAGE_STABLE_REPLACE_VERSION = 'message-stable-replace-v1' as const

/** Exact eight lowerCamelCase payload keys (locked spelling, SYNC-DATA-050). */
export const MESSAGE_STABLE_REPLACE_PAYLOAD_KEYS = [
  'replaceVersion',
  'messageId',
  'replacementClock',
  'message',
  'messageBlocks',
  'activeBlockIds',
  'topicFrame',
  'messageFrame'
] as const

export interface StableReplaceClock {
  timestamp: number
  operationId: string
}

export interface StableReplacePayload {
  replaceVersion: typeof MESSAGE_STABLE_REPLACE_VERSION
  messageId: string
  replacementClock: StableReplaceClock
  message: Record<string, unknown>
  messageBlocks: Array<Record<string, unknown>>
  activeBlockIds: string[]
  topicFrame: Record<string, unknown>
  messageFrame: Record<string, unknown>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * Strict validator for the `message_stable_replace` operation.
 * Single shared source of truth: the relay ingress and the SyncClient pull
 * boundary both delegate here via `validateSyncOperationStrict`.
 *
 * Envelope binding (exact, SYNC-DATA-050):
 * - `entityType === 'message'` (no other value legal for this op).
 * - `entityId === payload.messageId === payload.message.id === payload.messageFrame.parentId`.
 * - Every `payload.messageBlocks[].messageId === payload.messageId`.
 * - `deviceId` envelope-only, never in payload (exact-keys closure).
 * - `id === replacementClock.operationId` and `timestamp === replacementClock.timestamp`
 *   (single clock — never a separately allocated second clock).
 *
 * Payload closure (exact eight keys): `{replaceVersion, messageId,
 * replacementClock, message, messageBlocks, activeBlockIds, topicFrame,
 * messageFrame}` with `replaceVersion === 'message-stable-replace-v1'`.
 * `message` is the full stable message state (existing v1 fields +
 * entityClock + exactly-one-per-field fieldClocks + parentMembershipClock;
 * stable status only; no `sortOrder`). `messageBlocks` is the canonical
 * id-sorted (UTF-8 byte lex, one entry per block, no duplicates) full
 * stable-supported block array (existing v1 fields + clocks; no `sortOrder`).
 * `activeBlockIds` is business (user-visible) order and is exactly the block
 * set (set-equal to `messageBlocks[].id`, no duplicates, no omission).
 * `topicFrame` (`kind:'topicMessage'`, `parentId === message.topicId`) and
 * `messageFrame` (`kind:'messageBlock'`, `parentId === messageId`) each reuse
 * the exact five-key `parent-order-frame-v1` shape;
 * `messageFrame.orderedChildIds` is exactly `activeBlockIds`;
 * both `frameClock`s mirror `replacementClock` exactly.
 *
 * Wire overflow note: wire blocks carry no `overflow` object, so the
 * structured-overflow half of the SYNC-DATA-043 gate is not evaluable on the
 * wire; the enforced wire gate is the same type/transient gate as the
 * existing baseline wire validator (case-insensitive trimmed block-type
 * exclusion + case-sensitive transient-status exclusion), reused by
 * delegation, never reimplemented.
 *
 * Returns an error string, or null when valid.
 */
export function validateStableReplacePayloadStrict(op: {
  id?: unknown
  entityType?: unknown
  entityId?: unknown
  timestamp?: unknown
  deviceId?: unknown
  payload?: unknown
}): string | null {
  if (op.entityType !== 'message') return 'message_stable_replace entityType must be message'
  if (!isNonEmptyString(op.id)) return 'invalid id'
  if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp)) return 'invalid timestamp'
  if (!isNonEmptyString(op.deviceId)) return 'invalid deviceId'
  if (!isNonEmptyString(op.entityId)) return 'invalid entityId'
  const payload = op.payload
  if (!isPlainObject(payload)) return 'message_stable_replace missing payload'
  const keys = Object.keys(payload)
  const expected = new Set<string>([...MESSAGE_STABLE_REPLACE_PAYLOAD_KEYS])
  if (keys.length !== expected.size) {
    const missing = [...expected].filter((k) => !(k in payload))
    const extra = keys.filter((k) => !expected.has(k))
    if (missing.length > 0) return `message_stable_replace missing payload key "${missing[0]}"`
    if (extra.length > 0) return `message_stable_replace unknown payload key "${extra[0]}"`
    return 'message_stable_replace payload keys mismatch'
  }
  for (const k of keys) {
    if (!expected.has(k)) return `message_stable_replace unknown payload key "${k}"`
  }
  if (payload.replaceVersion !== MESSAGE_STABLE_REPLACE_VERSION) {
    return 'message_stable_replace unknown replaceVersion'
  }
  if (!isNonEmptyString(payload.messageId)) return 'message_stable_replace invalid messageId'
  if (payload.messageId !== op.entityId) return 'message_stable_replace entityId must equal payload.messageId'
  // replacementClock shape (SYNC-DATA-043 clock shapes) via the shared clock validator.
  try {
    validateClock(payload.replacementClock, 'replacementClock', false)
  } catch (e) {
    return `message_stable_replace invalid replacementClock: ${e instanceof Error ? e.message : String(e)}`
  }
  const rc = payload.replacementClock as { timestamp: unknown; operationId: unknown }
  if (rc.timestamp !== op.timestamp) return 'message_stable_replace timestamp must mirror replacementClock.timestamp'
  if (rc.operationId !== op.id) return 'message_stable_replace id must mirror replacementClock.operationId'
  // Full stable message state via the existing locked v1 validator (exact
  // keys, type/value domain, transient-status gate, field-clock closure,
  // parentMembershipClock, no sortOrder on wire).
  try {
    validateMessage(payload.message, 'message')
  } catch (e) {
    return `message_stable_replace invalid message: ${e instanceof Error ? e.message : String(e)}`
  }
  const message = payload.message as Record<string, unknown>
  if (message.id !== payload.messageId) return 'message_stable_replace message.id must equal payload.messageId'
  if (!isNonEmptyString(message.topicId)) return 'message_stable_replace message missing topicId'
  // Canonical id-sorted full stable-supported block array.
  if (!Array.isArray(payload.messageBlocks)) return 'message_stable_replace messageBlocks must be array'
  const blocks = payload.messageBlocks as unknown[]
  const seenBlockIds = new Set<string>()
  let prevBlockId: string | null = null
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    try {
      validateMessageBlock(b, `messageBlocks[${i}]`)
    } catch (e) {
      return `message_stable_replace invalid messageBlocks[${i}]: ${e instanceof Error ? e.message : String(e)}`
    }
    const bRec = b as Record<string, unknown>
    if (bRec.messageId !== payload.messageId) {
      return `message_stable_replace messageBlocks[${i}].messageId must equal payload.messageId`
    }
    const bid = bRec.id as string
    if (seenBlockIds.has(bid)) return `message_stable_replace duplicate block id "${bid}"`
    seenBlockIds.add(bid)
    // Canonical UTF-8 byte-lex order (shared contract, same as wire inventory).
    if (prevBlockId !== null && compareUtf8ByteLex(prevBlockId, bid) >= 0) {
      return 'message_stable_replace messageBlocks must be id-sorted (UTF-8 byte lex)'
    }
    prevBlockId = bid
  }
  // activeBlockIds: business order, exactly the block set.
  if (!Array.isArray(payload.activeBlockIds)) return 'message_stable_replace activeBlockIds must be array'
  const active = payload.activeBlockIds as unknown[]
  const seenActive = new Set<string>()
  for (let i = 0; i < active.length; i++) {
    const v = active[i]
    if (!isNonEmptyString(v)) return `message_stable_replace invalid activeBlockIds[${i}]`
    if (seenActive.has(v)) return `message_stable_replace duplicate activeBlockIds "${v}"`
    seenActive.add(v)
  }
  if (seenActive.size !== seenBlockIds.size) {
    return 'message_stable_replace activeBlockIds must be exactly the block set'
  }
  for (const id of seenActive) {
    if (!seenBlockIds.has(id)) return 'message_stable_replace activeBlockIds must be exactly the block set'
  }
  // Both frames reuse the exact five-key parent-order-frame-v1 shape.
  try {
    validateOrderFrame(payload.topicFrame, 'topicFrame')
  } catch (e) {
    return `message_stable_replace invalid topicFrame: ${e instanceof Error ? e.message : String(e)}`
  }
  try {
    validateOrderFrame(payload.messageFrame, 'messageFrame')
  } catch (e) {
    return `message_stable_replace invalid messageFrame: ${e instanceof Error ? e.message : String(e)}`
  }
  const topicFrame = payload.topicFrame as Record<string, unknown>
  const messageFrame = payload.messageFrame as Record<string, unknown>
  if (topicFrame.kind !== 'topicMessage') return 'message_stable_replace topicFrame kind must be topicMessage'
  if (messageFrame.kind !== 'messageBlock') return 'message_stable_replace messageFrame kind must be messageBlock'
  if (topicFrame.parentId !== message.topicId) {
    return 'message_stable_replace topicFrame.parentId must equal message.topicId'
  }
  // The bundled topic frame is the topic's full winning order including the
  // (possibly new) message itself (SYNC-DATA-050): self omission fails
  // closed here. Sibling completeness against receiver-held state stays
  // apply-side (frame coverage gate), never a validator concern.
  const topicChildren: unknown = topicFrame.orderedChildIds
  if (!Array.isArray(topicChildren) || !topicChildren.includes(payload.messageId)) {
    return 'message_stable_replace topicFrame.orderedChildIds must include payload.messageId'
  }
  if (messageFrame.parentId !== payload.messageId) {
    return 'message_stable_replace messageFrame.parentId must equal payload.messageId'
  }
  // messageFrame.orderedChildIds is exactly activeBlockIds (same order).
  const frameChildren = messageFrame.orderedChildIds as unknown[]
  if (frameChildren.length !== active.length) {
    return 'message_stable_replace messageFrame.orderedChildIds must equal activeBlockIds'
  }
  for (let i = 0; i < frameChildren.length; i++) {
    if (frameChildren[i] !== active[i]) {
      return 'message_stable_replace messageFrame.orderedChildIds must equal activeBlockIds'
    }
  }
  // Both frameClocks mirror replacementClock exactly (single clock).
  for (const [name, frame] of [
    ['topicFrame', topicFrame],
    ['messageFrame', messageFrame]
  ] as const) {
    const fc = frame.frameClock as { timestamp: unknown; operationId: unknown }
    if (fc.timestamp !== rc.timestamp || fc.operationId !== rc.operationId) {
      return `message_stable_replace ${name}.frameClock must mirror replacementClock`
    }
  }
  if (topicFrame.frameVersion !== ORDER_FRAME_VERSION || messageFrame.frameVersion !== ORDER_FRAME_VERSION) {
    return 'message_stable_replace frameVersion must be parent-order-frame-v1'
  }
  return null
}

/** True when the operation claims the dedicated stable-replace kind. */
export function isStableReplaceOperation(op: { op?: unknown }): boolean {
  return (op as { op?: unknown }).op === MESSAGE_STABLE_REPLACE_OP
}
