import { utf8ByteLength } from '@shared/chatDb'
import {
  B01_MAX_TOPICS,
  B02_MAX_BYTES,
  B05_CALIBRATION_CANDIDATE_BYTES,
  canonicalizeLogicalPayload,
  canonicalJsonStringify,
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION
} from '@shared/chatDb/logicalPayload'
import { describe, expect, it } from 'vitest'

describe('shared logicalPayload — renderer importability (browser-compatible)', () => {
  it('imports in renderer (jsdom) and canonicalizes with TextEncoder parity', () => {
    const topic = {
      topicId: 'renderer-smoke',
      messages: [{ id: 'msg-001', topicId: 'renderer-smoke', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>],
      blocks: [
        { id: 'b1', messageId: 'msg-001', type: 'main_text', content: '中文😀 a', status: 'success' } as Record<
          string,
          unknown
        >
      ],
      segments: [] as Record<string, unknown>[],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalJson, byteLength, canonicalFrame } = canonicalizeLogicalPayload(topic)
    expect(canonicalFrame.accountingVersion).toBe(LOGICAL_PAYLOAD_ACCOUNTING_VERSION)
    expect(LOGICAL_PAYLOAD_ACCOUNTING_VERSION).toBe('phase4-logical-payload-v1')
    expect(B01_MAX_TOPICS).toBe(8)
    expect(B02_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(B05_CALIBRATION_CANDIDATE_BYTES).toBe(B02_MAX_BYTES)
    // No Node Buffer used — TextEncoder via shared utf8ByteLength
    expect(byteLength).toBe(utf8ByteLength(canonicalJson))
    expect(byteLength).toBe(new TextEncoder().encode(canonicalJson).byteLength)
    expect(canonicalJson).not.toContain(': ')
    // Lexicographic keys
    expect(canonicalJsonStringify({ '2': 'two', '10': 'ten', '1': 'one' })).toBe('{"1":"one","10":"ten","2":"two"}')
    // Multi-byte parity
    expect(byteLength).toBeGreaterThan(canonicalJson.length)
  })
})
