/**
 * Deterministic L2 message identity tests (LOCK-MID-1/2).
 *
 * - Known-answer vectors for the frozen frame bytes and target IDs.
 * - Determinism, cross-topic distinctness, all-occurrence mapping.
 * - Ill-formed lone-surrogate rejection BEFORE UTF-8 encoding.
 * - Frame length-prefix exactness for multi-byte inputs.
 */

import { describe, expect, it } from 'vitest'

import {
  buildMessageIdFrame,
  computeMessageTargetId,
  isWellFormedUnicode,
  L2_MESSAGE_ID_DOMAIN,
  L2_MESSAGE_ID_TARGET_PREFIX,
  L2_MESSAGE_ID_VERSION_BYTE,
  MessageIdentityError
} from '../messageIdentity'

// Known-answer vector computed with node:crypto over the frozen frame:
//   ASCII 'cherry-chat:l2-message-id' (25 bytes) + 0x01 +
//   uint32be(3) + 't-1' + uint32be(3) + 'm-1'
const KAT_FRAME_HEX =
  '6368657272792d636861743a6c322d6d6573736167652d6964' + '01' + '00000003' + '742d31' + '00000003' + '6d2d31'
const KAT_TARGET = 'l2m1:ba016c0674dfa8a95575fffeeb1b2cf6eb6be2579409ca21fe8cae8cce1f3ec9'

describe('buildMessageIdFrame (LOCK-MID-2)', () => {
  it('produces the exact frozen frame bytes for the known-answer vector', () => {
    const frame = buildMessageIdFrame('t-1', 'm-1')
    expect(frame.toString('hex')).toBe(KAT_FRAME_HEX)
    expect(frame.length).toBe(25 + 1 + 4 + 3 + 4 + 3)
  })

  it('encodes each component with an exact uint32be UTF-8 byte length prefix', () => {
    // '话题A' = 7 UTF-8 bytes; '消息😀' = 10 UTF-8 bytes.
    // Layout: domain(25) + version(1) + u32(4) + topic(7) + u32(4) + id(10).
    const frame = buildMessageIdFrame('话题A', '消息😀')
    expect(frame.length).toBe(25 + 1 + 4 + 7 + 4 + 10)
    // uint32be(7) at offset 26..30, then the 7 topic bytes at 30..37.
    expect(frame.subarray(26, 30).toString('hex')).toBe('00000007')
    expect(frame.subarray(30, 37).toString('utf8')).toBe('话题A')
    // uint32be(10) at offset 37..41, then the 10 id bytes at 41..51.
    expect(frame.subarray(37, 41).toString('hex')).toBe('0000000a')
    expect(frame.subarray(41).toString('utf8')).toBe('消息😀')
  })

  it('freezes the domain and version byte', () => {
    const frame = buildMessageIdFrame('t', 'm')
    expect(L2_MESSAGE_ID_DOMAIN).toBe('cherry-chat:l2-message-id')
    expect(L2_MESSAGE_ID_VERSION_BYTE).toBe(0x01)
    expect(frame.subarray(0, L2_MESSAGE_ID_DOMAIN.length).toString('ascii')).toBe(L2_MESSAGE_ID_DOMAIN)
    expect(frame[L2_MESSAGE_ID_DOMAIN.length]).toBe(0x01)
  })
})

describe('computeMessageTargetId (LOCK-MID-1/2)', () => {
  it('returns the known-answer target', () => {
    expect(computeMessageTargetId('t-1', 'm-1')).toBe(KAT_TARGET)
  })

  it('is deterministic and carries the l2m1: prefix with 64 lowercase hex chars', () => {
    const a = computeMessageTargetId('topic-x', 'msg-y')
    expect(computeMessageTargetId('topic-x', 'msg-y')).toBe(a)
    expect(a.startsWith(L2_MESSAGE_ID_TARGET_PREFIX)).toBe(true)
    expect(a.length).toBe(L2_MESSAGE_ID_TARGET_PREFIX.length + 64)
    expect(/^[0-9a-f]{64}$/.test(a.slice(L2_MESSAGE_ID_TARGET_PREFIX.length))).toBe(true)
  })

  it('maps EVERY occurrence — a reused legacy id in a different outer topic is a distinct target', () => {
    // The real artifact's cross-topic reuse: same legacy id, two outer topics.
    const t1 = computeMessageTargetId('t-1', 'shared-id')
    const t2 = computeMessageTargetId('t-2', 'shared-id')
    expect(t1).not.toBe(t2)
    expect(computeMessageTargetId('t-1', 'shared-id')).toBe(t1) // all occurrences of the tuple agree
  })

  it('distinguishes swapped tuple components (length prefixes forbid ambiguity)', () => {
    // ('ab', 'cd') must not equal ('a', 'bcd') — length prefixes make these distinct.
    expect(computeMessageTargetId('ab', 'cd')).not.toBe(computeMessageTargetId('a', 'bcd'))
  })
})

describe('ill-formed input rejection (LOCK-MID-2)', () => {
  it('rejects a lone surrogate in the outerTopicId before UTF-8 encoding', () => {
    // Buffer.from('\uD800x', 'utf8') would silently emit U+FFFD bytes — the
    // helper must reject instead so the frame is never corrupted.
    expect(() => computeMessageTargetId('\uD800x', 'm-1')).toThrowError(MessageIdentityError)
    expect(() => computeMessageTargetId('\uD800x', 'm-1')).toThrowError(/ILL_FORMED_INPUT/)
    expect(() => buildMessageIdFrame('\uD800x', 'm-1')).toThrowError(MessageIdentityError)
  })

  it('rejects a lone surrogate in the legacyMessageId', () => {
    expect(() => computeMessageTargetId('t-1', 'm\uDC00')).toThrowError(MessageIdentityError)
    expect(() => computeMessageTargetId('t-1', 'm\uDC00')).toThrowError(/ILL_FORMED_INPUT/)
  })

  it('rejects a trailing high surrogate', () => {
    expect(() => computeMessageTargetId('t-1', 'm-\uD83D')).toThrowError(MessageIdentityError)
  })

  it('accepts a valid surrogate pair (well-formed supplementary character)', () => {
    // U+1F600 😀 — valid pair; must encode to its 4-byte UTF-8 form.
    const target = computeMessageTargetId('t-1', 'emoji-😀')
    expect(target.startsWith(L2_MESSAGE_ID_TARGET_PREFIX)).toBe(true)
    expect(target.length).toBe(L2_MESSAGE_ID_TARGET_PREFIX.length + 64)
    // Frame must contain the 4-byte F0 9F 98 80 encoding, not two U+FFFD.
    const frame = buildMessageIdFrame('t-1', 'emoji-😀')
    expect(frame.toString('hex')).toContain('f09f9880')
  })
})

describe('isWellFormedUnicode', () => {
  it('accepts plain ASCII and valid pairs', () => {
    expect(isWellFormedUnicode('plain-ascii-123')).toBe(true)
    expect(isWellFormedUnicode('emoji-😀')).toBe(true)
    expect(isWellFormedUnicode('')).toBe(true)
  })

  it('rejects lone high surrogates', () => {
    expect(isWellFormedUnicode('\uD800')).toBe(false)
    expect(isWellFormedUnicode('a\uD83Db')).toBe(false)
  })

  it('rejects lone low surrogates', () => {
    expect(isWellFormedUnicode('\uDC00')).toBe(false)
    expect(isWellFormedUnicode('a\uDFFFb')).toBe(false)
  })
})
