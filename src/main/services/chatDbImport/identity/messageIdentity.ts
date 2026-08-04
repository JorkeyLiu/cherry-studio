/**
 * Deterministic L2 message identity (LOCK-MID-1/2).
 *
 * Replaces the global legacy message-ID identity with a deterministic
 * all-occurrence target identity derived from the source tuple
 * `(outerTopicId, legacyMessageId)`.
 *
 * Locked algorithm (LOCK-MID-2, frozen — never change domain/version/frame):
 * - frame = ASCII `cherry-chat:l2-message-id` + byte `0x01` +
 *   uint32be UTF-8 byte length + outerTopicId UTF-8 bytes +
 *   uint32be UTF-8 byte length + legacyMessageId UTF-8 bytes
 * - target = `'l2m1:'` + lowercase SHA-256 hex of the frame (69 chars).
 *
 * Boundary rules:
 * - EVERY occurrence maps; no first occurrence retains its legacy ID
 *   (LOCK-MID-1). The same legacyMessageId in different outer topics is a
 *   different source occurrence and yields a different target.
 * - Ill-formed inputs (lone surrogates in either string) are rejected
 *   BEFORE UTF-8 encoding: `Buffer.from(str, 'utf8')` would silently
 *   substitute U+FFFD, which would corrupt the frame bytes.
 * - Version/domain are frozen; callers must never parameterize them.
 *
 * Pure module: node:crypto only. Main-only — never expose over IPC.
 */

import { createHash } from 'node:crypto'

/** Frozen ASCII domain prefix of the message-ID frame (LOCK-MID-2). */
export const L2_MESSAGE_ID_DOMAIN = 'cherry-chat:l2-message-id'

/** Frozen version byte of the message-ID frame (LOCK-MID-2). */
export const L2_MESSAGE_ID_VERSION_BYTE = 0x01

/** Target-ID prefix. A full target is this prefix + 64 lowercase hex chars. */
export const L2_MESSAGE_ID_TARGET_PREFIX = 'l2m1:'

export type MessageIdentityErrorCode = 'ILL_FORMED_INPUT' | 'TARGET_OVERFLOW'

/**
 * Rejection raised by the identity helper. Carries a machine-readable code
 * and a privacy-safe detail (field name only — never the offending value).
 */
export class MessageIdentityError extends Error {
  readonly code: MessageIdentityErrorCode

  constructor(code: MessageIdentityErrorCode, detail: string) {
    super(`Message identity rejection (${code}): ${detail}`)
    this.name = 'MessageIdentityError'
    this.code = code
  }
}

/**
 * True when `value` contains no lone surrogates (every high surrogate is
 * immediately followed by a low surrogate). Required before UTF-8 encoding:
 * ill-formed code units would otherwise be silently replaced with U+FFFD.
 */
export function isWellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code > 0xdbff) return false // lone low surrogate
      if (i + 1 >= value.length) return false // trailing high surrogate
      const next = value.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      i++ // consume the valid surrogate pair
    }
  }
  return true
}

/**
 * Build the exact message-ID frame bytes (LOCK-MID-2). Exposed for focused
 * tests and for callers that need the raw frame; production callers should
 * use {@link computeMessageTargetId}.
 *
 * @throws {MessageIdentityError} on ill-formed input or length overflow.
 */
export function buildMessageIdFrame(outerTopicId: string, legacyMessageId: string): Buffer {
  if (!isWellFormedUnicode(outerTopicId)) {
    throw new MessageIdentityError('ILL_FORMED_INPUT', 'outerTopicId is not well-formed Unicode (lone surrogate)')
  }
  if (!isWellFormedUnicode(legacyMessageId)) {
    throw new MessageIdentityError('ILL_FORMED_INPUT', 'legacyMessageId is not well-formed Unicode (lone surrogate)')
  }
  const topicBytes = Buffer.from(outerTopicId, 'utf8')
  const idBytes = Buffer.from(legacyMessageId, 'utf8')
  if (topicBytes.length > 0xffffffff || idBytes.length > 0xffffffff) {
    throw new MessageIdentityError('TARGET_OVERFLOW', 'UTF-8 byte length exceeds the uint32be frame bound')
  }

  const header = Buffer.from(L2_MESSAGE_ID_DOMAIN, 'ascii')
  const frame = Buffer.alloc(header.length + 1 + 4 + topicBytes.length + 4 + idBytes.length)
  let offset = 0
  header.copy(frame, offset)
  offset += header.length
  frame[offset] = L2_MESSAGE_ID_VERSION_BYTE
  offset += 1
  frame.writeUInt32BE(topicBytes.length, offset)
  offset += 4
  topicBytes.copy(frame, offset)
  offset += topicBytes.length
  frame.writeUInt32BE(idBytes.length, offset)
  offset += 4
  idBytes.copy(frame, offset)
  return frame
}

/**
 * Deterministic all-occurrence target ID for the source occurrence
 * `(outerTopicId, legacyMessageId)` (LOCK-MID-1/2):
 * `'l2m1:'` + lowercase SHA-256 hex of the frozen frame.
 *
 * @throws {MessageIdentityError} on ill-formed input or length overflow.
 */
export function computeMessageTargetId(outerTopicId: string, legacyMessageId: string): string {
  const frame = buildMessageIdFrame(outerTopicId, legacyMessageId)
  const hex = createHash('sha256').update(frame).digest('hex')
  return `${L2_MESSAGE_ID_TARGET_PREFIX}${hex}`
}
