import { describe, expect, it } from 'vitest'

import {
  aggregateLogicalPayload,
  B01_MAX_TOPICS,
  B02_MAX_BYTES,
  B05_CALIBRATION_CANDIDATE_BYTES,
  canonicalizeLogicalPayload,
  canonicalJsonStringify,
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION
} from '../logicalPayload'
import { utf8ByteLength } from '../validation'

describe('shared logicalPayload — browser-compatible UTF-8 accounting parity', () => {
  it('utf8ByteLength matches Buffer.byteLength for ASCII', () => {
    const cases = ['', 'abc', 'a'.repeat(1024), 'Hello, World! 123', '{"a":1}']
    for (const str of cases) {
      expect(utf8ByteLength(str)).toBe(Buffer.byteLength(str, 'utf8'))
      // canonical byteLength must equal both
      const topic = {
        topicId: 'ascii-parity',
        messages: [
          { id: 'msg-001', topicId: 'ascii-parity', sortOrder: 0, blocks: ['b1'], note: str } as Record<string, unknown>
        ],
        blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: str } as Record<string, unknown>],
        segments: [] as Record<string, unknown>[],
        completeness: { chatData: true, segments: true, residentTopic: true },
        applicabilityGeneration: 0
      }
      const { canonicalJson, byteLength } = canonicalizeLogicalPayload(topic)
      expect(byteLength).toBe(utf8ByteLength(canonicalJson))
      expect(byteLength).toBe(Buffer.byteLength(canonicalJson, 'utf8'))
    }
  })

  it('utf8ByteLength matches Buffer.byteLength for multi-byte CJK, emoji, mixed', () => {
    const cases = [
      '中文',
      '😀',
      '中文😀 a',
      'a文😀',
      'a'.repeat(100) + '中文😀',
      'é', // 2 bytes
      '𐍈', // 4 bytes via surrogate pair
      'Hello 世界 🌍'
    ]
    for (const str of cases) {
      expect(utf8ByteLength(str)).toBe(Buffer.byteLength(str, 'utf8'))
      const topic = {
        topicId: 'unicode-parity',
        messages: [
          { id: 'msg-001', topicId: 'unicode-parity', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>
        ],
        blocks: [
          { id: 'b1', messageId: 'msg-001', type: 'main_text', content: str, status: 'success' } as Record<
            string,
            unknown
          >
        ],
        segments: [] as Record<string, unknown>[],
        completeness: { chatData: true, segments: true, residentTopic: true },
        applicabilityGeneration: 0
      }
      const { canonicalJson, byteLength } = canonicalizeLogicalPayload(topic)
      expect(byteLength).toBe(utf8ByteLength(canonicalJson))
      expect(byteLength).toBe(Buffer.byteLength(canonicalJson, 'utf8'))
      // Multi-byte string length < byte length
      if (/[^\x00-\x7F]/.test(str)) {
        expect(byteLength).toBeGreaterThan(canonicalJson.length)
      }
    }
  })

  it('canonical byteLength is TextEncoder-based and not Node Buffer API', () => {
    // Ensure shared module does not rely on Buffer — canonicalize uses utf8ByteLength internally
    const topic = {
      topicId: 'encoder-check',
      messages: [{ id: 'msg-001', topicId: 'encoder-check', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'a' } as Record<string, unknown>],
      segments: [] as Record<string, unknown>[],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalJson, byteLength } = canonicalizeLogicalPayload(topic)
    expect(byteLength).toBe(new TextEncoder().encode(canonicalJson).byteLength)
    expect(byteLength).toBe(utf8ByteLength(canonicalJson))
  })

  it('retains deterministic validation/boundary semantics via shared contract', () => {
    // Determinism
    const makeTopic = () => ({
      topicId: 'determinism-shared',
      messages: [
        { id: 'msg-002', topicId: 'determinism-shared', sortOrder: 1, blocks: ['b2'] } as Record<string, unknown>,
        { id: 'msg-001', topicId: 'determinism-shared', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>
      ],
      blocks: [
        { id: 'b2', messageId: 'msg-002', type: 'main_text', content: 'y' } as Record<string, unknown>,
        { id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'x' } as Record<string, unknown>
      ],
      segments: [] as Record<string, unknown>[],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    })
    const a = canonicalizeLogicalPayload(makeTopic())
    const b = canonicalizeLogicalPayload(makeTopic())
    expect(a.canonicalJson).toBe(b.canonicalJson)
    expect(a.byteLength).toBe(b.byteLength)
    expect(a.canonicalJson).not.toContain(': ')
    expect(a.canonicalJson).not.toContain(', ')

    // Boundary: B constants preserved exactly
    expect(LOGICAL_PAYLOAD_ACCOUNTING_VERSION).toBe('phase4-logical-payload-v1')
    expect(B01_MAX_TOPICS).toBe(8)
    expect(B02_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(B05_CALIBRATION_CANDIDATE_BYTES).toBe(B02_MAX_BYTES)

    // Aggregate binding strict > semantics
    const singleSmall = canonicalizeLogicalPayload({
      topicId: 'small-bound',
      messages: [{ id: 'msg-001', topicId: 'small-bound', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'a' } as Record<string, unknown>],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    })
    const aggSingle = aggregateLogicalPayload([
      {
        topicId: 'small-bound',
        messages: [{ id: 'msg-001', topicId: 'small-bound', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>],
        blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'a' } as Record<string, unknown>],
        segments: [],
        completeness: { chatData: true, segments: true, residentTopic: true },
        applicabilityGeneration: 0
      }
    ])
    expect(aggSingle.binding).toBe('none')
    expect(aggSingle.isByteBound).toBe(false)
    expect(aggSingle.isCountBound).toBe(false)
    // Cross-check canonical serializer lexicographic keys
    const obj: Record<string, unknown> = { '2': 'two', '10': 'ten', '1': 'one' }
    expect(canonicalJsonStringify(obj)).toBe('{"1":"one","10":"ten","2":"two"}')
    // Ensure single small byte length matches direct utf8ByteLength
    expect(singleSmall.byteLength).toBe(utf8ByteLength(singleSmall.canonicalJson))
  })

  it('rejects orphan and non-finite via shared contract (strict boundary semantics)', () => {
    const orphan = {
      topicId: 'orphan-shared',
      messages: [{ id: 'msg-001', topicId: 'orphan-shared', sortOrder: 0 } as Record<string, unknown>],
      blocks: [{ id: 'b-orphan', messageId: 'msg-999', type: 'main_text', content: 'x' } as Record<string, unknown>],
      segments: [] as Record<string, unknown>[],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    expect(() => canonicalizeLogicalPayload(orphan)).toThrow(/orphan/)

    const bad = {
      topicId: 'nonfinite-shared',
      messages: [
        { id: 'msg-001', topicId: 'nonfinite-shared', sortOrder: 0, blocks: ['b1'], bad: Number.NaN } as Record<
          string,
          unknown
        >
      ],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'x' } as Record<string, unknown>],
      segments: [] as Record<string, unknown>[],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    expect(() => canonicalizeLogicalPayload(bad)).toThrow(/non-finite/)
  })
})
