/**
 * Focused tests for the E2E expected message-ID helper (LOCK-MID-1/2).
 *
 * Pins the helper to the SAME known-answer vector the production identity
 * test (`src/main/services/chatDbImport/identity/__tests__/messageIdentity.test.ts`)
 * asserts, so a byte-level drift in either implementation fails loudly:
 *   frame = ASCII 'cherry-chat:l2-message-id' + 0x01 +
 *           uint32be(3) + 't-1' + uint32be(3) + 'm-1'
 *   target = 'l2m1:ba016c0674dfa8a95575fffeeb1b2cf6eb6be2579409ca21fe8cae8cce1f3ec9'
 *
 * Also locks the deterministic per-occurrence semantics the E2E specs rely on:
 * cross-topic reuse of a legacy id yields DISTINCT targets, and the derived
 * ids for the disposable seed fixtures (file-origin + dev-origin) are stable
 * and prefixed (never a legacy id).
 */
import { describe, expect, it } from 'vitest'

import {
  ExpectedMessageIdError,
  L2_MESSAGE_ID_DOMAIN,
  L2_MESSAGE_ID_TARGET_PREFIX,
  L2_MESSAGE_ID_VERSION_BYTE,
  buildExpectedMessageIdFrame,
  expectedMessageTargetId,
  isWellFormedUnicode
} from './expected-message-id'

// Same known-answer vector as the production identity test (LOCK-MID-2):
//   ASCII 'cherry-chat:l2-message-id' (25 bytes) + 0x01 +
//   uint32be(3) + 't-1' + uint32be(3) + 'm-1'
const KAT_FRAME_HEX =
  '6368657272792d636861743a6c322d6d6573736167652d6964' + '01' + '00000003' + '742d31' + '00000003' + '6d2d31'
const KAT_TARGET = 'l2m1:ba016c0674dfa8a95575fffeeb1b2cf6eb6be2579409ca21fe8cae8cce1f3ec9'

describe('buildExpectedMessageIdFrame (LOCK-MID-2)', () => {
  it('produces the exact frozen frame bytes of the known-answer vector', () => {
    const frame = buildExpectedMessageIdFrame('t-1', 'm-1')
    expect(frame.toString('hex')).toBe(KAT_FRAME_HEX)
    expect(frame.length).toBe(25 + 1 + 4 + 3 + 4 + 3)
  })

  it('freezes the domain and version byte', () => {
    const frame = buildExpectedMessageIdFrame('t', 'm')
    expect(L2_MESSAGE_ID_DOMAIN).toBe('cherry-chat:l2-message-id')
    expect(L2_MESSAGE_ID_VERSION_BYTE).toBe(0x01)
    expect(frame.subarray(0, L2_MESSAGE_ID_DOMAIN.length).toString('ascii')).toBe(L2_MESSAGE_ID_DOMAIN)
    expect(frame[L2_MESSAGE_ID_DOMAIN.length]).toBe(0x01)
  })
})

describe('expectedMessageTargetId (LOCK-MID-1/2)', () => {
  it('returns the known-answer target shared with production', () => {
    expect(expectedMessageTargetId('t-1', 'm-1')).toBe(KAT_TARGET)
  })

  it('is deterministic, prefixed, and 69 chars (prefix + 64 lowercase hex)', () => {
    const a = expectedMessageTargetId('topic-x', 'msg-y')
    expect(expectedMessageTargetId('topic-x', 'msg-y')).toBe(a)
    expect(a.startsWith(L2_MESSAGE_ID_TARGET_PREFIX)).toBe(true)
    expect(a.length).toBe(L2_MESSAGE_ID_TARGET_PREFIX.length + 64)
    expect(/^[0-9a-f]{64}$/.test(a.slice(L2_MESSAGE_ID_TARGET_PREFIX.length))).toBe(true)
  })

  it('maps EVERY occurrence — a reused legacy id in a different outer topic is a distinct target', () => {
    const t1 = expectedMessageTargetId('t-1', 'm-shared')
    const t2 = expectedMessageTargetId('t-2', 'm-shared')
    expect(t1).not.toBe(t2)
    expect(expectedMessageTargetId('t-1', 'm-shared')).toBe(t1) // all occurrences of the tuple agree
  })

  it('derives stable, never-legacy targets for the disposable seed fixtures', () => {
    // File-origin genuine/large-container seed (disposable-seed-zip.ts).
    const fileOrigin = expectedMessageTargetId('t-e2e-1', 'm-e2e-1')
    // Dev-origin seed (disposable-dev-origin-seed-zip.ts).
    const devOrigin = expectedMessageTargetId('t-e2e-dev-1', 'm-e2e-dev-1')
    for (const target of [fileOrigin, devOrigin]) {
      expect(target.startsWith(L2_MESSAGE_ID_TARGET_PREFIX)).toBe(true)
      expect(target.length).toBe(L2_MESSAGE_ID_TARGET_PREFIX.length + 64)
    }
    expect(fileOrigin).not.toBe(devOrigin)
    expect(fileOrigin).not.toContain('m-e2e-1')
    expect(devOrigin).not.toContain('m-e2e-dev-1')
  })
})

describe('ill-formed input rejection (LOCK-MID-2 parity)', () => {
  it('rejects a lone surrogate in either tuple component before UTF-8 encoding', () => {
    expect(() => expectedMessageTargetId('\uD800x', 'm-1')).toThrowError(ExpectedMessageIdError)
    expect(() => expectedMessageTargetId('t-1', 'm\uDC00')).toThrowError(ExpectedMessageIdError)
    expect(() => buildExpectedMessageIdFrame('t-1', 'm-\uD83D')).toThrowError(ExpectedMessageIdError)
  })

  it('accepts a valid surrogate pair (well-formed supplementary character)', () => {
    const target = expectedMessageTargetId('t-1', 'emoji-😀')
    expect(target.startsWith(L2_MESSAGE_ID_TARGET_PREFIX)).toBe(true)
    expect(target.length).toBe(L2_MESSAGE_ID_TARGET_PREFIX.length + 64)
  })

  it('mirrors production well-formedness detection', () => {
    expect(isWellFormedUnicode('plain-ascii-123')).toBe(true)
    expect(isWellFormedUnicode('emoji-😀')).toBe(true)
    expect(isWellFormedUnicode('\uD800')).toBe(false)
    expect(isWellFormedUnicode('a\uDFFFb')).toBe(false)
  })
})
