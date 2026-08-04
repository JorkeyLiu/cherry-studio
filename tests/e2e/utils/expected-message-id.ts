/**
 * Deterministic L2 target message-ID helper for E2E specs (LOCK-MID-1/2).
 *
 * The production all-occurrence identity lives Main-only
 * (`src/main/services/chatDbImport/identity/messageIdentity.ts`, node:crypto —
 * never exposed over IPC). E2E specs execute in the Node/Playwright runner and
 * must DERIVE the expected target ID for an imported source occurrence
 * instead of asserting the legacy message ID (LOCK-E2E-1): the genuine,
 * dev-origin, and large-container specs assert message identity, block
 * ownership (`message_blocks.message_id`), segment memberships, and Redux/UI
 * message containers against the mapped target.
 *
 * LOCK-MID-2: the frame/version are frozen. This is the allowed "dedicated
 * test helper implementing the same bytes": a self-contained re-implementation
 * of the exact frame
 *   ASCII 'cherry-chat:l2-message-id' + byte 0x01 +
 *   uint32be UTF-8 byte length + outerTopicId UTF-8 bytes +
 *   uint32be UTF-8 byte length + legacyMessageId UTF-8 bytes
 * and the target `'l2m1:' + lowercase SHA-256 hex of the frame`. The focused
 * test pins this helper to the SAME known-answer vector as the production
 * identity test, so a drift in either implementation fails loudly.
 *
 * Boundary parity: ill-formed input (lone surrogates) is rejected BEFORE
 * UTF-8 encoding, exactly like production, so a stray ill-formed fixture id
 * can never silently corrupt the derived expectation.
 */

import { createHash } from 'node:crypto'

/** Frozen ASCII domain prefix of the message-ID frame (LOCK-MID-2). */
export const L2_MESSAGE_ID_DOMAIN = 'cherry-chat:l2-message-id'

/** Frozen version byte of the message-ID frame (LOCK-MID-2). */
export const L2_MESSAGE_ID_VERSION_BYTE = 0x01

/** Target-ID prefix. A full target is this prefix + 64 lowercase hex chars. */
export const L2_MESSAGE_ID_TARGET_PREFIX = 'l2m1:'

/** Rejection raised by the E2E expected-ID helper (mirrors production). */
export class ExpectedMessageIdError extends Error {
  constructor(message: string) {
    super(`E2E expected message id rejection: ${message}`)
    this.name = 'ExpectedMessageIdError'
  }
}

/**
 * True when `value` contains no lone surrogates (every high surrogate is
 * immediately followed by a low surrogate). Mirrors production so the frame
 * bytes can never be silently corrupted by ill-formed fixture ids.
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
 * Build the exact message-ID frame bytes for the source occurrence
 * `(outerTopicId, legacyMessageId)` (LOCK-MID-2). Exposed for the focused
 * test to pin the raw bytes; E2E specs should use
 * {@link expectedMessageTargetId}.
 *
 * @throws {ExpectedMessageIdError} on ill-formed input or length overflow.
 */
export function buildExpectedMessageIdFrame(outerTopicId: string, legacyMessageId: string): Buffer {
  if (!isWellFormedUnicode(outerTopicId)) {
    throw new ExpectedMessageIdError('outerTopicId is not well-formed Unicode (lone surrogate)')
  }
  if (!isWellFormedUnicode(legacyMessageId)) {
    throw new ExpectedMessageIdError('legacyMessageId is not well-formed Unicode (lone surrogate)')
  }
  const topicBytes = Buffer.from(outerTopicId, 'utf8')
  const idBytes = Buffer.from(legacyMessageId, 'utf8')
  if (topicBytes.length > 0xffffffff || idBytes.length > 0xffffffff) {
    throw new ExpectedMessageIdError('UTF-8 byte length exceeds the uint32be frame bound')
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
 * `'l2m1:' + lowercase SHA-256 hex of the frozen frame`.
 *
 * E2E specs derive their expected imported message IDs with this helper and
 * assert the target everywhere target identity is required (LOCK-E2E-1).
 *
 * @throws {ExpectedMessageIdError} on ill-formed input or length overflow.
 */
export function expectedMessageTargetId(outerTopicId: string, legacyMessageId: string): string {
  const frame = buildExpectedMessageIdFrame(outerTopicId, legacyMessageId)
  const hex = createHash('sha256').update(frame).digest('hex')
  return `${L2_MESSAGE_ID_TARGET_PREFIX}${hex}`
}
