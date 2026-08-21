import { describe, expect, it } from 'vitest'

import {
  aggregateLogicalPayload,
  B01_MAX_TOPICS,
  B02_MAX_BYTES,
  B05_CALIBRATION_CANDIDATE_BYTES,
  canonicalizeLogicalPayload,
  canonicalJsonStringify,
  createSyntheticByteFirstProfile,
  createSyntheticCountFirstProfile,
  createSyntheticOversizedSingleProfile,
  createSyntheticTopic,
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION
} from './logicalPayload'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('logicalPayload — canonical frame', () => {
  it('encodes exact accountingVersion and lexicographic top-level key order', () => {
    const topic = createSyntheticTopic({ topicId: 'frame-key-order', messageCount: 1, blockContentSize: 5 })
    const { canonicalJson, canonicalFrame } = canonicalizeLogicalPayload(topic)
    expect(canonicalFrame.accountingVersion).toBe(LOGICAL_PAYLOAD_ACCOUNTING_VERSION)
    // Keys must be lexicographically sorted: accountingVersion, applicabilityGeneration, blocks, completeness, messages, segments, topicId
    const expectedOrder = [
      'accountingVersion',
      'applicabilityGeneration',
      'blocks',
      'completeness',
      'messages',
      'segments',
      'topicId'
    ]
    expect(Object.keys(canonicalFrame)).toEqual(expectedOrder)
    // Verify JSON string key order matches Object.keys order at top-level via parsing position
    // Do not use naive indexOf because inner objects also contain same keys (e.g., topicId)
    let lastIndex = -1
    for (const key of expectedOrder) {
      // Find top-level occurrence by checking parsed canonicalFrame key order is preserved in JSON.stringify output
      // JSON.stringify preserves insertion order of canonicalFrame which is sorted, so ensure sequential appearance of top-level keys
      // Use a regex that matches top-level pattern `"<key>":` after previous key's position
      const pattern = `"${key}":`
      const idx = canonicalJson.indexOf(pattern, lastIndex + 1)
      expect(idx, `key ${key} should appear after previous`).toBeGreaterThan(lastIndex)
      lastIndex = idx
    }
    // No whitespace: next char after colon or comma is quoted/bracket, no spaces
    expect(canonicalJson).not.toContain(': ')
    expect(canonicalJson).not.toContain(', ')
    expect(canonicalJson.includes('  ')).toBe(false)
  })

  it('recursively lexicographically sorts object keys inside entities', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'recurse-key',
      messages: [
        // intentionally unsorted keys: z, a, m
        {
          z: 'last',
          a: 'first',
          m: 'middle',
          id: 'msg-001',
          sortOrder: 0,
          topicId: 'recurse-key',
          blocks: ['b1']
        } as Record<string, unknown>
      ],
      blocks: [
        { id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'hi', status: 'success', z: 1, a: 0 } as Record<
          string,
          unknown
        >
      ],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalJson } = canonicalizeLogicalPayload(topic)
    // Inside the single message object, keys must be sorted: a,m,z,... but id sortOrder etc also sorted
    const msgSlice = canonicalJson.slice(canonicalJson.indexOf('"messages"'))
    // Check that within the message JSON, "a" appears before "m" before "z"
    expect(msgSlice.indexOf('"a"')).toBeLessThan(msgSlice.indexOf('"m"'))
    expect(msgSlice.indexOf('"m"')).toBeLessThan(msgSlice.indexOf('"z"'))
    // Also top-level block object a before z
    const blockSlice = canonicalJson.slice(canonicalJson.indexOf('"blocks"'))
    expect(blockSlice.indexOf('"a"')).toBeLessThan(blockSlice.indexOf('"z"'))
  })

  it('sorts messages by sortOrder ascending then id, missing sortOrder sorts after present values', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'msg-sort',
      messages: [
        { id: 'msg-c', sortOrder: 1, topicId: 'msg-sort', blocks: ['b-c'] } as Record<string, unknown>,
        { id: 'msg-a', sortOrder: 0, topicId: 'msg-sort', blocks: ['b-a'] } as Record<string, unknown>,
        { id: 'msg-b', /* no sortOrder */ topicId: 'msg-sort', blocks: ['b-b'] } as Record<string, unknown>,
        { id: 'msg-d', /* no sortOrder */ topicId: 'msg-sort', blocks: ['b-d'] } as Record<string, unknown>
      ],
      blocks: [
        { id: 'b-a', messageId: 'msg-a', type: 'main_text', content: 'x' } as Record<string, unknown>,
        { id: 'b-c', messageId: 'msg-c', type: 'main_text', content: 'x' } as Record<string, unknown>,
        { id: 'b-b', messageId: 'msg-b', type: 'main_text', content: 'x' } as Record<string, unknown>,
        { id: 'b-d', messageId: 'msg-d', type: 'main_text', content: 'x' } as Record<string, unknown>
      ],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalFrame } = canonicalizeLogicalPayload(topic)
    const ids = (canonicalFrame.messages as Record<string, unknown>[]).map((m) => String(m.id))
    // Present sortOrders first in asc order, then absent sorted by id
    expect(ids).toEqual(['msg-a', 'msg-c', 'msg-b', 'msg-d'])
    // Blocks should be sorted by parent message position (canonical messages order), then id
    const blockIds = (canonicalFrame.blocks as Record<string, unknown>[]).map((b) => String(b.id))
    expect(blockIds).toEqual(['b-a', 'b-c', 'b-b', 'b-d'])
  })

  it('sorts blocks by parent message position then id, ignoring block sortOrder', () => {
    // Even if blocks carry sortOrder, spec says block sortOrder is omitted — order is parent position then id
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'block-sort',
      messages: [
        { id: 'msg-002', sortOrder: 1, topicId: 'block-sort', blocks: ['b2'] } as Record<string, unknown>,
        { id: 'msg-001', sortOrder: 0, topicId: 'block-sort', blocks: ['b1', 'b3'] } as Record<string, unknown>
      ],
      blocks: [
        // msg-002 is second parent (pos 1), msg-001 pos 0. Blocks for msg-002 should come after msg-001 regardless of sortOrder
        { id: 'b2', messageId: 'msg-002', sortOrder: 0, type: 'main_text', content: 'x' } as Record<string, unknown>,
        { id: 'b1', messageId: 'msg-001', sortOrder: 999, type: 'main_text', content: 'x' } as Record<string, unknown>,
        { id: 'b3', messageId: 'msg-001', sortOrder: -1, type: 'main_text', content: 'x' } as Record<string, unknown>
      ],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalFrame } = canonicalizeLogicalPayload(topic)
    const blockIds = (canonicalFrame.blocks as Record<string, unknown>[]).map((b) => String(b.id))
    // Parent msg-001 blocks first, sorted by id (b1, b3) since sortOrder ignored, then msg-002
    expect(blockIds).toEqual(['b1', 'b3', 'b2'])
  })

  it('sorts segments by id (sortOrder field absent in current shape)', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'seg-sort',
      messages: [{ id: 'msg-001', topicId: 'seg-sort', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'x' } as Record<string, unknown>],
      segments: [
        { id: 'seg-b', topicId: 'seg-sort', name: 'B' } as Record<string, unknown>,
        { id: 'seg-a', topicId: 'seg-sort', name: 'A' } as Record<string, unknown>
      ],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 1
    }
    const { canonicalFrame } = canonicalizeLogicalPayload(topic)
    const segIds = (canonicalFrame.segments as Record<string, unknown>[]).map((s) => String(s.id))
    expect(segIds).toEqual(['seg-a', 'seg-b'])
  })

  it('sorts segments by sortOrder when present then id', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'seg-sortorder',
      messages: [{ id: 'msg-001', topicId: 'seg-sortorder', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'x' } as Record<string, unknown>],
      segments: [
        { id: 'seg-001', topicId: 'seg-sortorder', name: 'X', sortOrder: 2 } as Record<string, unknown>,
        { id: 'seg-002', topicId: 'seg-sortorder', name: 'Y', sortOrder: 1 } as Record<string, unknown>,
        { id: 'seg-003', topicId: 'seg-sortorder', name: 'Z' } as Record<string, unknown> // absent -> after present
      ],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalFrame } = canonicalizeLogicalPayload(topic)
    const segIds = (canonicalFrame.segments as Record<string, unknown>[]).map((s) => String(s.id))
    expect(segIds).toEqual(['seg-002', 'seg-001', 'seg-003'])
  })
})

describe('logicalPayload — value canonicalization', () => {
  it('omits undefined object properties', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'undef-omit',
      messages: [
        {
          id: 'msg-001',
          topicId: 'undef-omit',
          sortOrder: 0,
          optional: undefined,
          present: 'yes',
          blocks: ['b1']
        } as unknown as Record<string, unknown>
      ],
      blocks: [
        {
          id: 'b1',
          messageId: 'msg-001',
          type: 'main_text',
          content: 'x',
          extra: undefined as unknown as string
        } as unknown as Record<string, unknown>
      ],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalJson } = canonicalizeLogicalPayload(topic)
    expect(canonicalJson).not.toContain('optional')
    expect(canonicalJson).not.toContain('extra')
    expect(canonicalJson).toContain('"present"')
  })

  it('converts undefined array slots to null and retains explicit null', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'array-null',
      messages: [
        {
          id: 'msg-001',
          topicId: 'array-null',
          sortOrder: 0,
          tags: ['a', undefined, null, 'b'] as unknown as string[],
          blocks: ['b1']
        } as unknown as Record<string, unknown>
      ],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'x' } as Record<string, unknown>],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalFrame } = canonicalizeLogicalPayload(topic)
    const tags = (canonicalFrame.messages as Record<string, unknown>[])[0]['tags'] as unknown[]
    expect(tags).toEqual(['a', null, null, 'b'])
  })

  it('retains explicit null values', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'null-retain',
      messages: [
        { id: 'msg-001', topicId: 'null-retain', sortOrder: 0, value: null, blocks: ['b1'] } as Record<string, unknown>
      ],
      blocks: [
        { id: 'b1', messageId: 'msg-001', type: 'main_text', content: null as unknown as string } as unknown as Record<
          string,
          unknown
        >
      ],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalJson, canonicalFrame } = canonicalizeLogicalPayload(topic)
    expect(canonicalJson).toContain(':null')
    expect((canonicalFrame.messages as Record<string, unknown>[])[0]['value']).toBeNull()
  })

  it('rejects non-finite numbers', () => {
    const base = createSyntheticTopic({ topicId: 'non-finite', messageCount: 1, blockContentSize: 1 })
    base.messages[0]['bad'] = Infinity
    expect(() => canonicalizeLogicalPayload(base)).toThrow(/non-finite/)
    base.messages[0]['bad'] = Number.NaN
    expect(() => canonicalizeLogicalPayload(base)).toThrow(/non-finite/)
    base.messages[0]['bad'] = -Infinity
    expect(() => canonicalizeLogicalPayload(base)).toThrow(/non-finite/)
  })

  it('rejects unsupported JSON values (function, symbol, bigint, non-plain object)', () => {
    const topic1 = createSyntheticTopic({ topicId: 'unsupported-fn', messageCount: 1, blockContentSize: 1 })
    topic1.messages[0]['fn'] = (() => {}) as unknown as string
    expect(() => canonicalizeLogicalPayload(topic1)).toThrow(/unsupported JSON value/)

    const topic2 = createSyntheticTopic({ topicId: 'unsupported-sym', messageCount: 1, blockContentSize: 1 })
    topic2.messages[0]['sym'] = Symbol('x') as unknown as string
    expect(() => canonicalizeLogicalPayload(topic2)).toThrow(/unsupported JSON value/)

    const topic3 = createSyntheticTopic({ topicId: 'unsupported-bigint', messageCount: 1, blockContentSize: 1 })
    topic3.messages[0]['big'] = 123n as unknown as number
    expect(() => canonicalizeLogicalPayload(topic3)).toThrow(/unsupported JSON value/)

    const topic4 = createSyntheticTopic({ topicId: 'unsupported-date', messageCount: 1, blockContentSize: 1 })
    topic4.messages[0]['date'] = new Date() as unknown as string
    expect(() => canonicalizeLogicalPayload(topic4)).toThrow(/unsupported JSON value/)
  })

  it('rejects orphan blocks whose messageId is absent from frame messages', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'orphan',
      messages: [{ id: 'msg-001', topicId: 'orphan', sortOrder: 0 } as Record<string, unknown>],
      blocks: [
        { id: 'b-orphan', messageId: 'msg-999', type: 'main_text', content: 'orphan' } as Record<string, unknown>
      ],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/orphan block/)
  })

  it('UTF-8 byte count is stable and matches Buffer.byteLength (CJK/emoji)', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'utf8',
      messages: [
        { id: 'msg-001', topicId: 'utf8', sortOrder: 0, content: 'hello', blocks: ['b1'] } as Record<string, unknown>
      ],
      blocks: [
        {
          id: 'b1',
          messageId: 'msg-001',
          type: 'main_text',
          content: '中文😀 a', // mixed CJK + emoji + ascii
          status: 'success'
        } as Record<string, unknown>
      ],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalJson, byteLength } = canonicalizeLogicalPayload(topic)
    expect(byteLength).toBe(Buffer.byteLength(canonicalJson, 'utf8'))
    // String length is shorter than UTF-8 byte length for CJK/emoji
    expect(byteLength).toBeGreaterThan(canonicalJson.length)
    // Deterministic second pass yields same bytes
    const second = canonicalizeLogicalPayload(topic)
    expect(second.byteLength).toBe(byteLength)
    expect(second.canonicalJson).toBe(canonicalJson)
  })

  it('repeated identical input yields identical byte counts and JSON (determinism)', () => {
    const topic = createSyntheticTopic({ topicId: 'determinism', messageCount: 3, blockContentSize: 256 })
    const a = canonicalizeLogicalPayload(topic)
    const b = canonicalizeLogicalPayload(topic)
    expect(a.byteLength).toBe(b.byteLength)
    expect(a.canonicalJson).toBe(b.canonicalJson)
    // Cross-instance but structurally identical input
    const topicClone = createSyntheticTopic({ topicId: 'determinism', messageCount: 3, blockContentSize: 256 })
    const c = canonicalizeLogicalPayload(topicClone)
    expect(c.byteLength).toBe(a.byteLength)
    expect(c.canonicalJson).toBe(a.canonicalJson)
  })

  it('produces compact JSON with no whitespace artifacts', () => {
    const topic = createSyntheticTopic({ topicId: 'compact', messageCount: 1, blockContentSize: 5 })
    const { canonicalJson } = canonicalizeLogicalPayload(topic)
    // No newline, no "  ", no ": " pattern
    expect(canonicalJson.includes('\n')).toBe(false)
    expect(canonicalJson).not.toMatch(/:\s/)
    expect(canonicalJson).not.toMatch(/,\s/)
  })
})

describe('logicalPayload — accounting and binding', () => {
  it('duplicates shared entities per topic (aggregate = sum of per-topic)', () => {
    const sharedMessageBase: Record<string, unknown> = {
      id: 'shared-msg-001',
      topicId: 'placeholder',
      sortOrder: 0,
      role: 'user',
      content: 'shared content',
      blocks: ['shared-block-001']
    }
    const sharedBlockBase: Record<string, unknown> = {
      id: 'shared-block-001',
      messageId: 'shared-msg-001',
      type: 'main_text',
      content: 'shared block payload',
      status: 'success'
    }
    const makeTopic = (suffix: string): ReturnType<typeof createSyntheticTopic> => ({
      topicId: `shared-${suffix}`,
      messages: [{ ...sharedMessageBase, topicId: `shared-${suffix}` }],
      blocks: [{ ...sharedBlockBase }],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    })
    const topicA = makeTopic('a')
    const topicB = makeTopic('b')
    const resultA = canonicalizeLogicalPayload(topicA)
    const resultB = canonicalizeLogicalPayload(topicB)
    // Per-topic bytes must match because topics are symmetric (same lengths, only a vs b which are equal length)
    expect(resultA.byteLength).toBe(resultB.byteLength)
    const agg = aggregateLogicalPayload([topicA, topicB])
    expect(agg.aggregateBytes).toBe(resultA.byteLength + resultB.byteLength)
    expect(agg.perTopic).toHaveLength(2)
  })

  it('classifies count-first binding (B-01 exceeded, B-02 not exceeded)', () => {
    const topics = createSyntheticCountFirstProfile()
    expect(topics).toHaveLength(9)
    const agg = aggregateLogicalPayload(topics)
    expect(agg.topicCount).toBe(9)
    expect(agg.isCountBound).toBe(true)
    expect(agg.isByteBound).toBe(false)
    expect(agg.binding).toBe('count-first')
    expect(agg.aggregateBytes).toBeLessThan(B02_MAX_BYTES)
    expect(B01_MAX_TOPICS).toBe(8)
  })

  it('classifies byte-first binding (B-02 exceeded, B-01 not exceeded)', () => {
    const topics = createSyntheticByteFirstProfile()
    expect(topics).toHaveLength(4)
    const agg = aggregateLogicalPayload(topics)
    expect(agg.isByteBound).toBe(true)
    expect(agg.isCountBound).toBe(false)
    expect(agg.binding).toBe('byte-first')
    expect(agg.aggregateBytes).toBeGreaterThan(B02_MAX_BYTES)
  })

  it('classifies both when count and byte bounds exceeded', () => {
    // Combine count-first (9) + byte-first (4) => 13 topics, large aggregate => both
    const combined = [...createSyntheticCountFirstProfile(), ...createSyntheticByteFirstProfile()]
    const agg = aggregateLogicalPayload(combined)
    expect(agg.topicCount).toBe(13)
    expect(agg.isCountBound).toBe(true)
    expect(agg.isByteBound).toBe(true)
    expect(agg.binding).toBe('both')
  })

  it('classifies none when within both caps', () => {
    const small = [createSyntheticTopic({ topicId: 'small-00', messageCount: 1, blockContentSize: 10 })]
    const agg = aggregateLogicalPayload(small)
    expect(agg.binding).toBe('none')
    expect(agg.isCountBound).toBe(false)
    expect(agg.isByteBound).toBe(false)
  })

  it('classifies B-05 oversized single topic (>32 MiB)', () => {
    const topics = createSyntheticOversizedSingleProfile()
    expect(topics).toHaveLength(1)
    const agg = aggregateLogicalPayload(topics)
    const singleBytes = agg.perTopic[0].byteLength
    expect(singleBytes).toBeGreaterThan(B05_CALIBRATION_CANDIDATE_BYTES)
    expect(singleBytes).toBeGreaterThan(B02_MAX_BYTES)
    expect(agg.oversizedTopicIds).toEqual([topics[0].topicId])
    // Also verify calibration candidate is exactly B-02 (32 MiB)
    expect(B05_CALIBRATION_CANDIDATE_BYTES).toBe(B02_MAX_BYTES)
    expect(B05_CALIBRATION_CANDIDATE_BYTES).toBe(32 * 1024 * 1024)
  })

  it('does not mark non-oversized topics as oversized', () => {
    const topics = createSyntheticCountFirstProfile()
    const agg = aggregateLogicalPayload(topics)
    expect(agg.oversizedTopicIds).toEqual([])
  })
})

describe('logicalPayload — canonical serializer edge cases (C-01 accepted)', () => {
  it('lexicographically orders integer-like keys (not numeric)', () => {
    // Keys "2","10","1" lexicographic is "1","10","2" ; numeric would be "1","2","10"
    const obj: Record<string, unknown> = {}
    obj['2'] = 'two'
    obj['10'] = 'ten'
    obj['1'] = 'one'
    obj['b'] = 'bee'
    const json = canonicalJsonStringify(obj)
    const idx1 = json.indexOf('"1":')
    const idx10 = json.indexOf('"10":')
    const idx2 = json.indexOf('"2":')
    const idxb = json.indexOf('"b":')
    expect(idx1).toBeLessThan(idx10)
    expect(idx10).toBeLessThan(idx2)
    expect(idx2).toBeLessThan(idxb)
    // Ensure numeric order would be 1,2,10 but we assert lexicographic
    expect(json).toBe('{"1":"one","10":"ten","2":"two","b":"bee"}')
  })

  it('recursively lexicographically orders integer-like keys inside nested objects', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'int-keys-nested',
      messages: [
        {
          id: 'msg-001',
          topicId: 'int-keys-nested',
          sortOrder: 0,
          nested: { '2': 'x', '10': 'y', '1': 'z' } as unknown as Record<string, unknown>,
          blocks: ['b1']
        } as unknown as Record<string, unknown>
      ],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'hi' } as Record<string, unknown>],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalJson } = canonicalizeLogicalPayload(topic)
    // nested object keys must be lexicographic: "1" < "10" < "2"
    const nestedSlice = canonicalJson.slice(canonicalJson.indexOf('"nested"'))
    const n1 = nestedSlice.indexOf('"1":')
    const n10 = nestedSlice.indexOf('"10":')
    const n2 = nestedSlice.indexOf('"2":')
    expect(n1).toBeLessThan(n10)
    expect(n10).toBeLessThan(n2)
  })

  it('serializes own __proto__ enumerable data property without prototype pollution', () => {
    const obj: Record<string, unknown> = {}
    Object.defineProperty(obj, '__proto__', {
      value: 'polluted',
      enumerable: true,
      writable: true,
      configurable: true
    })
    obj['a'] = 'alpha'
    obj['z'] = 1
    const json = canonicalJsonStringify(obj)
    // Must contain "__proto__" as key, lexicographically between "a" and "z" ? Actually "__proto__" (underscore) sorts after letters? Check ascii: '_' (95) vs 'a' (97) => '_' < 'a'. So order is "__proto__", "a", "z"
    expect(json).toContain('"__proto__":"polluted"')
    expect(json).toBe('{"__proto__":"polluted","a":"alpha","z":1}')
    // Ensure prototype not polluted
    expect((obj as unknown as Record<string, unknown>)['__proto__']).toBe('polluted')
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype)
    // Through frame: ensure own __proto__ inside message is preserved and sorted
    const msg: Record<string, unknown> = { id: 'msg-001', topicId: 'proto-test', sortOrder: 0, blocks: ['b1'] }
    Object.defineProperty(msg, '__proto__', { value: 'evil', enumerable: true, writable: true, configurable: true })
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'proto-test',
      messages: [msg],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'x' } as Record<string, unknown>],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalJson: cjson } = canonicalizeLogicalPayload(topic)
    expect(cjson).toContain('"__proto__":"evil"')
  })

  it('escapes keys and values via JSON string escaping', () => {
    const obj = { 'a"b': 'c\nd', 'e\\f': 'g\t' }
    const json = canonicalJsonStringify(obj)
    // Keys sorted lexicographically: 'a"b' (a=97,",34) vs 'e\\f' (e=101) => a"b first; values escaped via JSON stringify
    expect(json).toBe('{"a\\"b":"c\\nd","e\\\\f":"g\\t"}')
    // Directly check escaping: key with quote must be escaped, newline escaped
    expect(json).toContain('"a\\"b"')
    expect(json).toContain('"e\\\\f"')
    expect(json).toContain('\\n')
    expect(json).toContain('\\t')
  })
})

describe('logicalPayload — validation strengthening (C-01 accepted)', () => {
  it('rejects duplicate message ids', () => {
    const topic = createSyntheticTopic({ topicId: 'dup-msg', messageCount: 2, blockContentSize: 10 })
    // duplicate first message id
    topic.messages.push({ ...topic.messages[0] } as Record<string, unknown>)
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/duplicate message id/)
  })

  it('rejects duplicate block ids', () => {
    const topic = createSyntheticTopic({ topicId: 'dup-block', messageCount: 2, blockContentSize: 10 })
    topic.blocks.push({ ...topic.blocks[0] } as Record<string, unknown>)
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/duplicate block id/)
  })

  it('rejects duplicate segment ids', () => {
    const topic = createSyntheticTopic({ topicId: 'dup-seg', messageCount: 1, blockContentSize: 10, segmentCount: 1 })
    topic.segments.push({ ...topic.segments[0] } as Record<string, unknown>)
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/duplicate segment id/)
  })

  it('rejects cross-topic message topicId', () => {
    const topic = createSyntheticTopic({ topicId: 'frame-topic', messageCount: 1, blockContentSize: 10 })
    topic.messages[0].topicId = 'other-topic'
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/cross-topic message/)
  })

  it('rejects cross-topic segment topicId', () => {
    const topic = createSyntheticTopic({
      topicId: 'frame-topic',
      messageCount: 1,
      blockContentSize: 10,
      segmentCount: 1
    })
    topic.segments[0].topicId = 'other-topic'
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/cross-topic segment/)
  })

  it('rejects orphan block (already covered) and message blocks unresolved', () => {
    const topic = createSyntheticTopic({ topicId: 'msg-blocks-unresolved', messageCount: 1, blockContentSize: 10 })
    // Make message reference a non-existent block
    topic.messages[0].blocks = ['non-existent-block-id']
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/message blocks reference unresolved/)
  })

  it('rejects message blocks contradictory ownership', () => {
    const topic = createSyntheticTopic({ topicId: 'contradict', messageCount: 2, blockContentSize: 10 })
    // Swap ownership: make msg-0 reference block of msg-1
    const msg0 = topic.messages[0]
    const block1Id = String(topic.blocks[1].id)
    msg0.blocks = [block1Id]
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/contradictory/)
  })

  it('rejects block not referenced by its owning message blocks', () => {
    const topic = createSyntheticTopic({ topicId: 'missing-ref', messageCount: 1, blockContentSize: 10 })
    // Remove block reference from owning message
    topic.messages[0].blocks = []
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/block membership missing/)
  })

  it('rejects block-bearing message missing its blocks array', () => {
    const topic = createSyntheticTopic({ topicId: 'missing-blocks-array', messageCount: 1, blockContentSize: 10 })
    delete topic.messages[0].blocks
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/block membership missing/)
  })

  it('accepts message without blocks array when no blocks claim it', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'zero-block-no-array',
      messages: [{ id: 'msg-001', topicId: 'zero-block-no-array', sortOrder: 0 } as Record<string, unknown>],
      blocks: [],
      segments: [],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    expect(topic.messages[0].blocks).toBeUndefined()
    expect(() => canonicalizeLogicalPayload(topic)).not.toThrow()
  })

  it('rejects duplicate block membership across messages', () => {
    const topic = createSyntheticTopic({ topicId: 'dup-membership', messageCount: 2, blockContentSize: 10 })
    const block0Id = String(topic.blocks[0].id)
    // Both messages claim block0
    topic.messages[0].blocks = [block0Id]
    topic.messages[1].blocks = [block0Id, String(topic.blocks[1].id)]
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/duplicate block membership|contradictory/)
  })

  it('rejects segment messageId unresolved', () => {
    const topic = createSyntheticTopic({
      topicId: 'seg-unresolved',
      messageCount: 1,
      blockContentSize: 10,
      segmentCount: 1
    })
    topic.segments[0].messageIds = ['missing-msg-id']
    expect(() => canonicalizeLogicalPayload(topic)).toThrow(/segment messageId unresolved/)
  })

  it('rejects completeness composite mismatch (residentTopic !== chatData && segments)', () => {
    const base = createSyntheticTopic({ topicId: 'complete-mismatch', messageCount: 1, blockContentSize: 10 })
    base.completeness = { chatData: true, segments: false, residentTopic: true }
    expect(() => canonicalizeLogicalPayload(base)).toThrow(/residentTopic must equal/)
    const base2 = createSyntheticTopic({ topicId: 'complete-mismatch2', messageCount: 1, blockContentSize: 10 })
    base2.completeness = { chatData: true, segments: true, residentTopic: false }
    expect(() => canonicalizeLogicalPayload(base2)).toThrow(/residentTopic must equal/)
  })

  it('accepts all valid completeness combinations where residentTopic equals conjunction', () => {
    const combos: Array<[boolean, boolean, boolean]> = [
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false]
    ]
    for (const [chatData, segments, residentTopic] of combos) {
      const t = createSyntheticTopic({
        topicId: `complete-${chatData}-${segments}-${residentTopic}`,
        messageCount: 1,
        blockContentSize: 10
      })
      t.completeness = { chatData, segments, residentTopic }
      expect(
        () => canonicalizeLogicalPayload(t),
        `should accept ${chatData} ${segments} ${residentTopic}`
      ).not.toThrow()
    }
  })

  it('rejects non-integer or negative generation', () => {
    const base = createSyntheticTopic({ topicId: 'gen', messageCount: 1, blockContentSize: 10 })
    base.applicabilityGeneration = -1
    expect(() => canonicalizeLogicalPayload(base)).toThrow(/applicabilityGeneration/)
    base.applicabilityGeneration = 1.5
    expect(() => canonicalizeLogicalPayload(base)).toThrow(/applicabilityGeneration/)
    base.applicabilityGeneration = Number.NaN
    expect(() => canonicalizeLogicalPayload(base)).toThrow(/applicabilityGeneration/)
    base.applicabilityGeneration = Infinity
    expect(() => canonicalizeLogicalPayload(base)).toThrow(/applicabilityGeneration/)
  })

  it('rejects non-finite values deep in nested arrays/objects', () => {
    const t = createSyntheticTopic({ topicId: 'deep-nonfinite', messageCount: 1, blockContentSize: 10 })
    t.messages[0].nested = { arr: [1, Number.NaN] } as unknown as Record<string, unknown>
    expect(() => canonicalizeLogicalPayload(t)).toThrow(/non-finite/)
  })
})

describe('logicalPayload — deep nonmutation regression', () => {
  it('does not mutate input (deep nonmutation including nested arrays)', () => {
    const topic = createSyntheticTopic({ topicId: 'nonmutate', messageCount: 3, blockContentSize: 10, segmentCount: 1 })
    // Add a nested array inside a message to test deep nonmutation
    topic.messages[0].tags = ['z', 'a'] as unknown as string[]
    const beforeNested = JSON.stringify(topic.messages[0].tags)
    const snapshot = JSON.stringify(topic)
    const { canonicalJson } = canonicalizeLogicalPayload(topic)
    // Input must be identical after call (deep nonmutation)
    expect(JSON.stringify(topic)).toBe(snapshot)
    expect(JSON.stringify(topic.messages[0].tags)).toBe(beforeNested)
    // Ensure sorted output did not reorder input arrays
    expect(topic.messages[0].id).toBe('nonmutate-msg-00000')
    // Mutate the returned canonicalFrame and ensure original not affected
    const result = canonicalizeLogicalPayload(topic)
    ;(result.canonicalFrame.messages as Record<string, unknown>[])[0]['id'] = 'mutated'
    expect(topic.messages[0].id).not.toBe('mutated')
    // Byte length stable across calls
    const second = canonicalizeLogicalPayload(topic)
    expect(second.canonicalJson).toBe(canonicalJson)
    expect(second.byteLength).toBe(result.byteLength)
  })

  it('synthetic fixtures are projection-complete with blocks references and topicId matching', () => {
    const topic = createSyntheticTopic({
      topicId: 'proj-complete',
      messageCount: 2,
      blockContentSize: 16,
      segmentCount: 1
    })
    // Verify projection completeness fields exist
    for (const m of topic.messages) {
      expect(typeof m.assistantId).toBe('string')
      expect(Array.isArray(m.blocks)).toBe(true)
      expect(m.topicId).toBe('proj-complete')
    }
    for (const b of topic.blocks) {
      expect(typeof b.messageId).toBe('string')
    }
    for (const s of topic.segments) {
      expect(s.topicId).toBe('proj-complete')
      expect(Array.isArray(s.messageIds)).toBe(true)
    }
    // Must validate without throwing
    expect(() => canonicalizeLogicalPayload(topic)).not.toThrow()
  })

  it('preserves approved segment comparator: sortOrder present sorts before absent, then id', () => {
    const topic: ReturnType<typeof createSyntheticTopic> = {
      topicId: 'seg-comparator-preserve',
      messages: [
        { id: 'msg-001', topicId: 'seg-comparator-preserve', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>
      ],
      blocks: [{ id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'x' } as Record<string, unknown>],
      segments: [
        { id: 'seg-c', topicId: 'seg-comparator-preserve', name: 'C' } as Record<string, unknown>, // absent sortOrder
        { id: 'seg-a', topicId: 'seg-comparator-preserve', name: 'A', sortOrder: 2 } as Record<string, unknown>,
        { id: 'seg-b', topicId: 'seg-comparator-preserve', name: 'B', sortOrder: 1 } as Record<string, unknown>
      ],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const { canonicalFrame } = canonicalizeLogicalPayload(topic)
    const segIds = (canonicalFrame.segments as Record<string, unknown>[]).map((s) => String(s.id))
    // Approved: present sortOrders first asc, then absent by id
    expect(segIds).toEqual(['seg-b', 'seg-a', 'seg-c'])
  })
})
