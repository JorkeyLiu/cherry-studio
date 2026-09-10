import crypto from 'node:crypto'

import canonicalize from 'canonicalize'
import { describe, expect, it } from 'vitest'

import {
  canonicalizePayload,
  compareClocks,
  compareDeletionClocks,
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION,
  ORDER_FRAME_VERSION,
  parseEnvelopeJson,
  parsePayloadJson,
  parseStrictJson,
  PAYLOAD_SCHEMA,
  SCOPE,
  validateEnvelope,
  validatePayload,
  ValidationError,
  verifyEnvelopeDigest,
  verifySyncDigest,
  WIRE_VERSION
} from '../baselineWire'

// ---------------------------------------------------------------------------
// Gold vector
// ---------------------------------------------------------------------------

function goldPayload(): any {
  return {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics: [
      {
        id: 't1',
        name: 'Topic One',
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        pinned: null,
        prompt: null,
        isNameManuallyEdited: null,
        entityClock: { timestamp: 1, operationId: 'op1' },
        fieldClocks: {
          name: { timestamp: 1, operationId: 'op1' },
          assistantId: { timestamp: 1, operationId: 'op1' },
          createdAt: { timestamp: 1, operationId: 'op1' },
          updatedAt: { timestamp: 1, operationId: 'op1' },
          deletedAt: { timestamp: 1, operationId: 'op1' },
          pinned: { timestamp: 1, operationId: 'op1' },
          prompt: { timestamp: 1, operationId: 'op1' },
          isNameManuallyEdited: { timestamp: 1, operationId: 'op1' }
        }
      }
    ],
    messages: [
      {
        id: 'm1',
        topicId: 't1',
        role: 'user',
        content: 'hello',
        status: 'success',
        askId: null,
        model: null,
        modelId: null,
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        entityClock: { timestamp: 2, operationId: 'op2' },
        fieldClocks: {
          role: { timestamp: 2, operationId: 'op2' },
          content: { timestamp: 2, operationId: 'op2' },
          status: { timestamp: 2, operationId: 'op2' },
          askId: { timestamp: 2, operationId: 'op2' },
          model: { timestamp: 2, operationId: 'op2' },
          modelId: { timestamp: 2, operationId: 'op2' },
          assistantId: { timestamp: 2, operationId: 'op2' },
          createdAt: { timestamp: 2, operationId: 'op2' },
          updatedAt: { timestamp: 2, operationId: 'op2' }
        },
        parentMembershipClock: { timestamp: 2, operationId: 'op2' }
      }
    ],
    messageBlocks: [
      {
        id: 'b1',
        messageId: 'm1',
        type: 'text',
        content: 'hello',
        status: 'success',
        createdAt: null,
        updatedAt: null,
        entityClock: { timestamp: 3, operationId: 'op3' },
        fieldClocks: {
          type: { timestamp: 3, operationId: 'op3' },
          content: { timestamp: 3, operationId: 'op3' },
          status: { timestamp: 3, operationId: 'op3' },
          createdAt: { timestamp: 3, operationId: 'op3' },
          updatedAt: { timestamp: 3, operationId: 'op3' }
        },
        parentMembershipClock: { timestamp: 3, operationId: 'op3' }
      }
    ],
    tombstones: [],
    orderFrames: [
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'topicMessage',
        parentId: 't1',
        orderedChildIds: ['m1'],
        frameClock: { timestamp: 2, operationId: 'op2' }
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: 'm1',
        orderedChildIds: ['b1'],
        frameClock: { timestamp: 3, operationId: 'op3' }
      }
    ],
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA,
      inventoryVersion: INVENTORY_VERSION,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE,
      liveCounts: { topic: 1, message: 1, messageBlock: 1 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 1, messageBlock: 1 },
      completeness: COMPLETENESS_COMPLETE
    }
  }
}

const GOLD_CANONICAL =
  '{"inventoryVersion":"topic-message-stable-block-order-v1","manifest":{"completeness":"complete","frameCounts":{"messageBlock":1,"topicMessage":1},"inventoryVersion":"topic-message-stable-block-order-v1","liveCounts":{"message":1,"messageBlock":1,"topic":1},"orderFrameVersion":"parent-order-frame-v1","payloadSchema":"chat-core-baseline-v1","scope":"chat-core-baseline-v1:topic-message-stable-block-order-v1","tombstoneCounts":{"message":0,"messageBlock":0,"topic":0}},"messageBlocks":[{"content":"hello","createdAt":null,"entityClock":{"operationId":"op3","timestamp":3},"fieldClocks":{"content":{"operationId":"op3","timestamp":3},"createdAt":{"operationId":"op3","timestamp":3},"status":{"operationId":"op3","timestamp":3},"type":{"operationId":"op3","timestamp":3},"updatedAt":{"operationId":"op3","timestamp":3}},"id":"b1","messageId":"m1","parentMembershipClock":{"operationId":"op3","timestamp":3},"status":"success","type":"text","updatedAt":null}],"messages":[{"askId":null,"assistantId":null,"content":"hello","createdAt":null,"entityClock":{"operationId":"op2","timestamp":2},"fieldClocks":{"askId":{"operationId":"op2","timestamp":2},"assistantId":{"operationId":"op2","timestamp":2},"content":{"operationId":"op2","timestamp":2},"createdAt":{"operationId":"op2","timestamp":2},"model":{"operationId":"op2","timestamp":2},"modelId":{"operationId":"op2","timestamp":2},"role":{"operationId":"op2","timestamp":2},"status":{"operationId":"op2","timestamp":2},"updatedAt":{"operationId":"op2","timestamp":2}},"id":"m1","model":null,"modelId":null,"parentMembershipClock":{"operationId":"op2","timestamp":2},"role":"user","status":"success","topicId":"t1","updatedAt":null}],"orderFrameVersion":"parent-order-frame-v1","orderFrames":[{"frameClock":{"operationId":"op2","timestamp":2},"frameVersion":"parent-order-frame-v1","kind":"topicMessage","orderedChildIds":["m1"],"parentId":"t1"},{"frameClock":{"operationId":"op3","timestamp":3},"frameVersion":"parent-order-frame-v1","kind":"messageBlock","orderedChildIds":["b1"],"parentId":"m1"}],"payloadSchema":"chat-core-baseline-v1","scope":"chat-core-baseline-v1:topic-message-stable-block-order-v1","tombstones":[],"topics":[{"assistantId":null,"createdAt":null,"deletedAt":null,"entityClock":{"operationId":"op1","timestamp":1},"fieldClocks":{"assistantId":{"operationId":"op1","timestamp":1},"createdAt":{"operationId":"op1","timestamp":1},"deletedAt":{"operationId":"op1","timestamp":1},"isNameManuallyEdited":{"operationId":"op1","timestamp":1},"name":{"operationId":"op1","timestamp":1},"pinned":{"operationId":"op1","timestamp":1},"prompt":{"operationId":"op1","timestamp":1},"updatedAt":{"operationId":"op1","timestamp":1}},"id":"t1","isNameManuallyEdited":null,"name":"Topic One","pinned":null,"prompt":null,"updatedAt":null}]}'

const GOLD_DIGEST = 'a67d76b7cc88823db792d8078fbec50bf1373e62dd9ac57fb74d0dbedf6c446b'

function hashHex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('baselineWire gold vector + canonical', () => {
  it('validates gold payload and gold envelope', () => {
    const payload = goldPayload()
    expect(() => validatePayload(payload)).not.toThrow()
    const canonical = canonicalizePayload(payload)
    expect(canonical).toBe(GOLD_CANONICAL)
    expect(computeSyncDigest(payload, hashHex)).toBe(GOLD_DIGEST)
    // Cross-check with raw canonicalize library
    expect(canonicalize(payload)).toBe(GOLD_CANONICAL)
  })

  it('envelope round-trips and digest recomputes', () => {
    const payload = goldPayload()
    const envelope = {
      wireVersion: WIRE_VERSION,
      channelId: 'chan-1',
      watermark: 42,
      digestScheme: DIGEST_SCHEME,
      digest: GOLD_DIGEST,
      payload
    }
    expect(() => validateEnvelope(envelope)).not.toThrow()
    expect(verifyEnvelopeDigest(envelope, hashHex)).toBe(true)
  })

  it('insertion order does not affect canonical or digest', () => {
    const p1 = goldPayload()
    // Create same payload but with shuffled key insertion order
    const p2: any = {}
    p2.scope = p1.scope
    p2.topics = p1.topics
    p2.manifest = p1.manifest
    p2.payloadSchema = p1.payloadSchema
    p2.messages = p1.messages
    p2.messageBlocks = p1.messageBlocks
    p2.tombstones = p1.tombstones
    p2.orderFrames = p1.orderFrames
    p2.inventoryVersion = p1.inventoryVersion
    p2.orderFrameVersion = p1.orderFrameVersion
    // Intentionally also shuffle topic field order via manual object
    const topicShuffled: any = {}
    topicShuffled.fieldClocks = p1.topics[0].fieldClocks
    topicShuffled.id = p1.topics[0].id
    topicShuffled.name = p1.topics[0].name
    topicShuffled.entityClock = p1.topics[0].entityClock
    // ... but validator will still pass because it checks exact keys, not order
    // For canonical test, we use full payload p2
    expect(canonicalizePayload(p2)).toBe(GOLD_CANONICAL)
    expect(computeSyncDigest(p2, hashHex)).toBe(GOLD_DIGEST)
  })

  it('only payload is hashed, envelope fields excluded', () => {
    const payload = goldPayload()
    const digest = computeSyncDigest(payload, hashHex)
    const env1 = {
      wireVersion: WIRE_VERSION,
      channelId: 'chan-a',
      watermark: 1,
      digestScheme: DIGEST_SCHEME,
      digest,
      payload
    }
    const env2 = {
      wireVersion: WIRE_VERSION,
      channelId: 'chan-b',
      watermark: 999,
      digestScheme: DIGEST_SCHEME,
      digest,
      payload
    }
    // Both envelopes share same payload digest, different channelId/watermark still verify
    expect(verifyEnvelopeDigest(env1 as any, hashHex)).toBe(true)
    expect(verifyEnvelopeDigest(env2 as any, hashHex)).toBe(true)
    // Mutating envelope digest field does not change canonical payload
    expect(canonicalizePayload(payload)).toBe(GOLD_CANONICAL)
  })
})

describe('baselineWire strict raw JSON duplicate keys', () => {
  it('rejects duplicate outer key even with same value', () => {
    const payload = goldPayload()
    const envelope: any = {
      wireVersion: WIRE_VERSION,
      channelId: 'c1',
      watermark: 1,
      digestScheme: DIGEST_SCHEME,
      digest: GOLD_DIGEST,
      payload
    }
    const json = JSON.stringify(envelope)
    // Inject duplicate key by string manipulation: add duplicate wireVersion at end
    const dup = json.slice(0, -1) + ',"wireVersion":"sync-baseline-wire-v1"}'
    expect(() => parseEnvelopeJson(dup)).toThrow(ValidationError)
    expect(() => parseStrictJson(dup)).toThrow(ValidationError)
  })

  it('rejects duplicate payload key', () => {
    const raw = '{"payloadSchema":"chat-core-baseline-v1","payloadSchema":"chat-core-baseline-v1"}'
    expect(() => parseStrictJson(raw)).toThrow(ValidationError)
  })

  it('does not mistake string values for keys (braces inside string)', () => {
    const payload = goldPayload()
    payload.topics[0].name = 'a {"x": 1} value with "quotes" and : colon'
    const json = JSON.stringify(payload)
    expect(() => parsePayloadJson(json)).not.toThrow()
  })

  it('correctly handles escaped quotes and unicode escapes in keys', () => {
    // Duplicate via different encoding: "a" vs "\u0061" should be detected as duplicate
    const dupJson = '{"a":1,"\\u0061":2}'
    expect(() => parseStrictJson(dupJson)).toThrow(ValidationError)
  })

  it('handles nested objects/arrays without false positives', () => {
    const ok = JSON.stringify({ a: { b: 1 }, c: [{ d: 2 }, { d: 3 }] })
    expect(() => parseStrictJson(ok)).not.toThrow()
    const dupNested = '{"a":{"x":1,"x":2}}'
    expect(() => parseStrictJson(dupNested)).toThrow(ValidationError)
  })
})

describe('baselineWire strict envelope/payload validators', () => {
  it('rejects unknown key', () => {
    const p = goldPayload()
    p.unknownKey = 1
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects missing required key', () => {
    const p = goldPayload()
    delete p.topics
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects sortOrder on wire', () => {
    const p = goldPayload()
    p.messages[0].sortOrder = 1
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects wrong version constants', () => {
    const p = goldPayload()
    p.payloadSchema = 'wrong' as any
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects transient status', () => {
    const p = goldPayload()
    p.messages[0].status = 'streaming'
    expect(() => validatePayload(p)).toThrow(ValidationError)
    const p2 = goldPayload()
    p2.messageBlocks[0].status = 'pending'
    expect(() => validatePayload(p2)).toThrow(ValidationError)
  })

  it('rejects unsupported block type (case-insensitive)', () => {
    for (const t of ['tool', 'FILE', '  Image ', 'Video', 'citation']) {
      const p = goldPayload()
      p.messageBlocks[0].type = t
      expect(() => validatePayload(p)).toThrow(ValidationError)
    }
  })

  it('rejects lone surrogate', () => {
    const p = goldPayload()
    p.topics[0].name = '\uD800' // lone high surrogate
    expect(() => validatePayload(p)).toThrow(ValidationError)
    const p2 = goldPayload()
    p2.topics[0].id = 'a\uDFFF' // lone low surrogate
    expect(() => validatePayload(p2)).toThrow(ValidationError)
    // Also via raw JSON with \uD800 escape
    // payload with surrogate already fails via parsePayloadJson duplicate+parse
    expect(() =>
      parsePayloadJson(JSON.stringify({ ...goldPayload(), topics: [{ ...goldPayload().topics[0], name: '\uD800' }] }))
    ).toThrow(ValidationError)
  })

  it('rejects unsafe integer', () => {
    const p = goldPayload()
    p.topics[0].entityClock.timestamp = Number.MAX_SAFE_INTEGER + 1
    expect(() => validatePayload(p)).toThrow(ValidationError)
    const env: any = {
      wireVersion: WIRE_VERSION,
      channelId: 'c1',
      watermark: Number.MAX_SAFE_INTEGER + 1,
      digestScheme: DIGEST_SCHEME,
      digest: GOLD_DIGEST,
      payload: goldPayload()
    }
    expect(() => validateEnvelope(env)).toThrow(ValidationError)
  })

  it('rejects non-safe integer count', () => {
    const p = goldPayload()
    p.manifest.liveCounts.topic = 1.5
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects operationId containing colon or too long or empty', () => {
    const p = goldPayload()
    p.topics[0].entityClock.operationId = 'a:b'
    expect(() => validatePayload(p)).toThrow(ValidationError)
    const p2 = goldPayload()
    p2.topics[0].entityClock.operationId = ''
    expect(() => validatePayload(p2)).toThrow(ValidationError)
    const p3 = goldPayload()
    p3.topics[0].entityClock.operationId = 'a'.repeat(257)
    expect(() => validatePayload(p3)).toThrow(ValidationError)
  })

  it('rejects plain JSON object/array only violations (null prototype is ok via JSON)', () => {
    // Creating object with custom prototype should be rejected by assertPlainObject if we were to call directly,
    // but JSON.parse never creates such. We test via direct validate call with class instance
    class Foo {
      id = 'x'
    }
    const fake = new Foo() as any
    expect(() => validatePayload(fake)).toThrow(ValidationError)
  })
})

describe('baselineWire array ordering and duplicates', () => {
  it('rejects unsorted topics', () => {
    const p = goldPayload()
    // add second topic unsorted
    p.topics.push({
      id: 'a0',
      name: null,
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      pinned: null,
      prompt: null,
      isNameManuallyEdited: null,
      entityClock: { timestamp: 0, operationId: 'op0' },
      fieldClocks: {
        name: { timestamp: 0, operationId: 'op0' },
        assistantId: { timestamp: 0, operationId: 'op0' },
        createdAt: { timestamp: 0, operationId: 'op0' },
        updatedAt: { timestamp: 0, operationId: 'op0' },
        deletedAt: { timestamp: 0, operationId: 'op0' },
        pinned: { timestamp: 0, operationId: 'op0' },
        prompt: { timestamp: 0, operationId: 'op0' },
        isNameManuallyEdited: { timestamp: 0, operationId: 'op0' }
      }
    })
    // topics now [t1, a0] unsorted lex (t1 > a0)
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('UTF-8 byte lex sorting matters (true UTF8 vs UTF16 reverse case)', () => {
    // U+E000 (EE 80 80) vs U+10000 (F0 90 80 80): UTF16 says 10000 < E000, UTF8 says E000 < 10000
    const idE000 = '\uE000'
    const id10000 = '\u{10000}'
    // sanity: compareUtf8ByteLex should give opposite to JS string compare
    // JS string compare (UTF16 code units) : 10000 < E000
    expect(id10000 < idE000).toBe(true)
    expect(compareClocks({ timestamp: 0, operationId: idE000 }, { timestamp: 0, operationId: id10000 })).toBeLessThan(0) // but via utf8, E000 < 10000
    // Build payload with two topics correctly sorted UTF8: [E000, 10000] should pass
    const baseCorrect = goldPayload()
    baseCorrect.topics = [
      {
        id: idE000,
        name: null,
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        pinned: null,
        prompt: null,
        isNameManuallyEdited: null,
        entityClock: { timestamp: 0, operationId: 'op0' },
        fieldClocks: {
          name: { timestamp: 0, operationId: 'op0' },
          assistantId: { timestamp: 0, operationId: 'op0' },
          createdAt: { timestamp: 0, operationId: 'op0' },
          updatedAt: { timestamp: 0, operationId: 'op0' },
          deletedAt: { timestamp: 0, operationId: 'op0' },
          pinned: { timestamp: 0, operationId: 'op0' },
          prompt: { timestamp: 0, operationId: 'op0' },
          isNameManuallyEdited: { timestamp: 0, operationId: 'op0' }
        }
      },
      {
        id: id10000,
        name: null,
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        pinned: null,
        prompt: null,
        isNameManuallyEdited: null,
        entityClock: { timestamp: 0, operationId: 'op1' },
        fieldClocks: {
          name: { timestamp: 0, operationId: 'op1' },
          assistantId: { timestamp: 0, operationId: 'op1' },
          createdAt: { timestamp: 0, operationId: 'op1' },
          updatedAt: { timestamp: 0, operationId: 'op1' },
          deletedAt: { timestamp: 0, operationId: 'op1' },
          pinned: { timestamp: 0, operationId: 'op1' },
          prompt: { timestamp: 0, operationId: 'op1' },
          isNameManuallyEdited: { timestamp: 0, operationId: 'op1' }
        }
      }
    ]
    baseCorrect.messages = []
    baseCorrect.messageBlocks = []
    baseCorrect.tombstones = []
    baseCorrect.orderFrames = [
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'topicMessage',
        parentId: idE000,
        orderedChildIds: [],
        frameClock: { timestamp: 0, operationId: 'op0' }
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'topicMessage',
        parentId: id10000,
        orderedChildIds: [],
        frameClock: { timestamp: 0, operationId: 'op1' }
      }
    ]
    baseCorrect.manifest.liveCounts = { topic: 2, message: 0, messageBlock: 0 }
    baseCorrect.manifest.frameCounts = { topicMessage: 2, messageBlock: 0 }
    expect(() => validatePayload(baseCorrect)).not.toThrow()

    // UTF16 order [10000, E000] should be rejected (since not UTF8 sorted)
    const baseWrong = clone(baseCorrect)
    baseWrong.topics = [...baseCorrect.topics].reverse()
    baseWrong.orderFrames = [...baseCorrect.orderFrames].reverse()
    expect(() => validatePayload(baseWrong)).toThrow(ValidationError)
  })

  it('rejects duplicate entity id', () => {
    const p = goldPayload()
    p.topics.push({ ...p.topics[0] })
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects duplicate tombstone', () => {
    const p = goldPayload()
    p.tombstones = [
      {
        entityType: 'topic',
        entityId: 'tX',
        deletionClock: { timestamp: 5, operationId: 'op5' },
        survivingEntityClock: null
      },
      {
        entityType: 'topic',
        entityId: 'tX',
        deletionClock: { timestamp: 6, operationId: 'op6' },
        survivingEntityClock: null
      }
    ]
    p.manifest.tombstoneCounts = { topic: 2, message: 0, messageBlock: 0 }
    p.manifest.liveCounts = { topic: 1, message: 1, messageBlock: 1 }
    // frames remain, but duplicate tombstone should be caught before manifest
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects duplicate frame', () => {
    const p = goldPayload()
    p.orderFrames.push({ ...p.orderFrames[0] })
    p.manifest.frameCounts = { topicMessage: 2, messageBlock: 1 }
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects duplicate orderedChildIds', () => {
    const p = goldPayload()
    // Make topic with two messages but duplicate child
    const msg2: any = clone(p.messages[0])
    msg2.id = 'm2'
    msg2.parentMembershipClock = { timestamp: 2, operationId: 'op2' }
    // need fieldClocks same
    p.messages.push(msg2)
    p.messages.sort((a, b) => (a.id < b.id ? -1 : 1))
    // update frame to duplicate
    p.orderFrames[0].orderedChildIds = ['m1', 'm1']
    p.manifest.liveCounts.message = 2
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })
})

describe('baselineWire manifest recompute', () => {
  it('rejects manifest tamper even if digest recomputed', () => {
    const p = goldPayload()
    p.manifest.liveCounts.topic = 999
    // computeSyncDigest would throw for tampered manifest, so we test via raw canonicalize for tampered manifest? Actually manifest mismatch fails validatePayload, so computeSyncDigest will throw before hashing
    // To get tamperedDigest we need a valid payload; so we test via manually hashing without validation would give digest, but computeSyncDigest validates so it should fail
    // Instead test that validatePayload fails even though digest could be recomputed via raw canonicalize
    expect(() => validatePayload(p)).toThrow(ValidationError)
    const env: any = {
      wireVersion: WIRE_VERSION,
      channelId: 'c1',
      watermark: 1,
      digestScheme: DIGEST_SCHEME,
      digest: 'a'.repeat(64),
      payload: p
    }
    // Use raw canonicalize to compute tampered digest bypassing validation (simulating attacker)
    const rawCanon = canonicalize(p) as string
    const rawDigest = crypto.createHash('sha256').update(rawCanon, 'utf8').digest('hex')
    env.digest = rawDigest
    expect(() => validateEnvelope(env)).toThrow(ValidationError)
  })
})

describe('baselineWire empty frame and closure', () => {
  it('allows empty frame for parent with zero children', () => {
    const p = goldPayload()
    // Create new topic with zero messages
    p.topics.push({
      id: 't2',
      name: null,
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      pinned: null,
      prompt: null,
      isNameManuallyEdited: null,
      entityClock: { timestamp: 10, operationId: 'op10' },
      fieldClocks: {
        name: { timestamp: 10, operationId: 'op10' },
        assistantId: { timestamp: 10, operationId: 'op10' },
        createdAt: { timestamp: 10, operationId: 'op10' },
        updatedAt: { timestamp: 10, operationId: 'op10' },
        deletedAt: { timestamp: 10, operationId: 'op10' },
        pinned: { timestamp: 10, operationId: 'op10' },
        prompt: { timestamp: 10, operationId: 'op10' },
        isNameManuallyEdited: { timestamp: 10, operationId: 'op10' }
      }
    })
    p.topics.sort((a, b) => (a.id < b.id ? -1 : 1))
    p.orderFrames.push({
      frameVersion: ORDER_FRAME_VERSION,
      kind: 'topicMessage',
      parentId: 't2',
      orderedChildIds: [],
      frameClock: { timestamp: 10, operationId: 'op10' }
    })
    p.orderFrames.sort((a, b) => {
      const ra = a.kind === 'topicMessage' ? 0 : 1
      const rb = b.kind === 'topicMessage' ? 0 : 1
      if (ra !== rb) return ra - rb
      return a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0
    })
    p.manifest.liveCounts.topic = 2
    p.manifest.frameCounts.topicMessage = 2
    expect(() => validatePayload(p)).not.toThrow()
  })

  it('rejects missing frame for live parent', () => {
    const p = goldPayload()
    p.orderFrames = p.orderFrames.filter((f: any) => f.parentId !== 't1')
    p.manifest.frameCounts.topicMessage = 0
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects frame for tombstoned parent', () => {
    const p = goldPayload()
    p.tombstones = [
      {
        entityType: 'topic',
        entityId: 't1',
        deletionClock: { timestamp: 5, operationId: 'op5' },
        survivingEntityClock: null
      }
    ]
    p.manifest.tombstoneCounts.topic = 1
    // Keep frame for t1 -> should fail
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects cross-parent child', () => {
    const p = goldPayload()
    // add second topic t2 and move message m1 to t2 logically but keep frame for t1 listing m1
    p.topics.push({
      id: 't2',
      name: null,
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      pinned: null,
      prompt: null,
      isNameManuallyEdited: null,
      entityClock: { timestamp: 11, operationId: 'op11' },
      fieldClocks: {
        name: { timestamp: 11, operationId: 'op11' },
        assistantId: { timestamp: 11, operationId: 'op11' },
        createdAt: { timestamp: 11, operationId: 'op11' },
        updatedAt: { timestamp: 11, operationId: 'op11' },
        deletedAt: { timestamp: 11, operationId: 'op11' },
        pinned: { timestamp: 11, operationId: 'op11' },
        prompt: { timestamp: 11, operationId: 'op11' },
        isNameManuallyEdited: { timestamp: 11, operationId: 'op11' }
      }
    })
    p.topics.sort((a, b) => (a.id < b.id ? -1 : 1))
    p.messages[0].topicId = 't2'
    p.orderFrames.push({
      frameVersion: ORDER_FRAME_VERSION,
      kind: 'topicMessage',
      parentId: 't2',
      orderedChildIds: ['m1'],
      frameClock: { timestamp: 2, operationId: 'op2' }
    })
    // Now t1 frame still lists m1 but m1's topicId is t2 -> should fail coverage / cross-parent
    p.orderFrames.sort((a, b) => {
      const ra = a.kind === 'topicMessage' ? 0 : 1
      const rb = b.kind === 'topicMessage' ? 0 : 1
      if (ra !== rb) return ra - rb
      return a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0
    })
    p.manifest.liveCounts.topic = 2
    p.manifest.frameCounts.topicMessage = 2
    // frame for t1 lists m1 but m1 not child of t1 anymore -> child set empty but ordered contains m1 -> error
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects frame covering tombstoned child', () => {
    const p = goldPayload()
    // tombstone m1 but frame still lists it
    p.tombstones = [
      {
        entityType: 'message',
        entityId: 'm1',
        deletionClock: { timestamp: 5, operationId: 'op5' },
        survivingEntityClock: null
      }
    ]
    p.manifest.tombstoneCounts.message = 1
    // Need to keep message? Actually spec prohibits same entity both live and tombstoned, so we must remove live message to avoid that error first.
    // But we want to test tombstoned child in frame: remove live message, keep frame listing tombstoned child -> frame coverage will see child set empty but ordered has tombstoned
    p.messages = []
    p.messageBlocks = []
    p.orderFrames = p.orderFrames.filter((f: any) => f.kind !== 'messageBlock')
    p.manifest.liveCounts.message = 0
    p.manifest.liveCounts.messageBlock = 0
    p.manifest.frameCounts.messageBlock = 0
    // Now t1 frame orderedChildIds ['m1'] but live children 0 -> mismatch
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })

  it('rejects live vs tombstone overlap', () => {
    const p = goldPayload()
    p.tombstones = [
      {
        entityType: 'topic',
        entityId: 't1',
        deletionClock: { timestamp: 1, operationId: 'op1' },
        survivingEntityClock: null
      }
    ]
    p.manifest.tombstoneCounts.topic = 1
    expect(() => validatePayload(p)).toThrow(ValidationError)
  })
})

describe('baselineWire membershipClock suffix rule', () => {
  it('allows covered children in any business order then deterministic suffix', () => {
    const p = goldPayload()
    // Create topic t1 with 3 messages: m1 (clock 1), m2 (clock 2), m3 (clock 5)
    // frameClock 2 => m1,m2 covered, m3 suffix
    p.messages = []
    p.messageBlocks = []
    p.orderFrames = p.orderFrames.filter((f: any) => f.kind !== 'messageBlock')
    p.manifest.liveCounts.messageBlock = 0
    p.manifest.frameCounts.messageBlock = 0
    // Actually need messageBlock frames removed, but we still need one per message; we'll add them later
    const mA: any = {
      id: 'm1',
      topicId: 't1',
      role: null,
      content: null,
      status: null,
      askId: null,
      model: null,
      modelId: null,
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      entityClock: { timestamp: 1, operationId: 'op1' },
      fieldClocks: {
        role: { timestamp: 1, operationId: 'op1' },
        content: { timestamp: 1, operationId: 'op1' },
        status: { timestamp: 1, operationId: 'op1' },
        askId: { timestamp: 1, operationId: 'op1' },
        model: { timestamp: 1, operationId: 'op1' },
        modelId: { timestamp: 1, operationId: 'op1' },
        assistantId: { timestamp: 1, operationId: 'op1' },
        createdAt: { timestamp: 1, operationId: 'op1' },
        updatedAt: { timestamp: 1, operationId: 'op1' }
      },
      parentMembershipClock: { timestamp: 1, operationId: 'op1' }
    }
    const mB: any = {
      id: 'm2',
      topicId: 't1',
      role: null,
      content: null,
      status: null,
      askId: null,
      model: null,
      modelId: null,
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      entityClock: { timestamp: 2, operationId: 'op2' },
      fieldClocks: {
        role: { timestamp: 2, operationId: 'op2' },
        content: { timestamp: 2, operationId: 'op2' },
        status: { timestamp: 2, operationId: 'op2' },
        askId: { timestamp: 2, operationId: 'op2' },
        model: { timestamp: 2, operationId: 'op2' },
        modelId: { timestamp: 2, operationId: 'op2' },
        assistantId: { timestamp: 2, operationId: 'op2' },
        createdAt: { timestamp: 2, operationId: 'op2' },
        updatedAt: { timestamp: 2, operationId: 'op2' }
      },
      parentMembershipClock: { timestamp: 2, operationId: 'op2' }
    }
    const mC: any = {
      id: 'm3',
      topicId: 't1',
      role: null,
      content: null,
      status: null,
      askId: null,
      model: null,
      modelId: null,
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      entityClock: { timestamp: 5, operationId: 'op5' },
      fieldClocks: {
        role: { timestamp: 5, operationId: 'op5' },
        content: { timestamp: 5, operationId: 'op5' },
        status: { timestamp: 5, operationId: 'op5' },
        askId: { timestamp: 5, operationId: 'op5' },
        model: { timestamp: 5, operationId: 'op5' },
        modelId: { timestamp: 5, operationId: 'op5' },
        assistantId: { timestamp: 5, operationId: 'op5' },
        createdAt: { timestamp: 5, operationId: 'op5' },
        updatedAt: { timestamp: 5, operationId: 'op5' }
      },
      parentMembershipClock: { timestamp: 5, operationId: 'op5' }
    }
    p.messages = [mA, mB, mC].sort((a, b) => (a.id < b.id ? -1 : 1))
    // Need messageBlock frames for each message (empty)
    p.orderFrames = [
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'topicMessage',
        parentId: 't1',
        orderedChildIds: ['m2', 'm1', 'm3'],
        frameClock: { timestamp: 2, operationId: 'op2' }
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: 'm1',
        orderedChildIds: [],
        frameClock: { timestamp: 1, operationId: 'op1' }
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: 'm2',
        orderedChildIds: [],
        frameClock: { timestamp: 2, operationId: 'op2' }
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: 'm3',
        orderedChildIds: [],
        frameClock: { timestamp: 5, operationId: 'op5' }
      }
    ]
    p.orderFrames.sort((a, b) => {
      const ra = a.kind === 'topicMessage' ? 0 : 1
      const rb = b.kind === 'topicMessage' ? 0 : 1
      if (ra !== rb) return ra - rb
      return a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0
    })
    p.manifest.liveCounts.message = 3
    p.manifest.frameCounts.topicMessage = 1
    p.manifest.frameCounts.messageBlock = 3
    // Business order for covered children [m2,m1] then suffix [m3] (only one suffix, so sorted trivially) should pass
    expect(() => validatePayload(p)).not.toThrow()

    // Now suffix unsorted: add second suffix child m4 with clock 6 but order wrong
    const mD: any = {
      id: 'm4',
      topicId: 't1',
      role: null,
      content: null,
      status: null,
      askId: null,
      model: null,
      modelId: null,
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      entityClock: { timestamp: 6, operationId: 'op6' },
      fieldClocks: {
        role: { timestamp: 6, operationId: 'op6' },
        content: { timestamp: 6, operationId: 'op6' },
        status: { timestamp: 6, operationId: 'op6' },
        askId: { timestamp: 6, operationId: 'op6' },
        model: { timestamp: 6, operationId: 'op6' },
        modelId: { timestamp: 6, operationId: 'op6' },
        assistantId: { timestamp: 6, operationId: 'op6' },
        createdAt: { timestamp: 6, operationId: 'op6' },
        updatedAt: { timestamp: 6, operationId: 'op6' }
      },
      parentMembershipClock: { timestamp: 6, operationId: 'op6' }
    }
    const p2 = clone(p)
    p2.messages.push(mD)
    p2.messages.sort((a, b) => (a.id < b.id ? -1 : 1))
    p2.orderFrames.find((f: any) => f.kind === 'topicMessage').orderedChildIds = ['m2', 'm1', 'm4', 'm3'] // suffix [m4,m3] unsorted (m4 clock 6 > m3 clock 5, but order is m4 before m3 should be m3 before m4)
    p2.orderFrames.push({
      frameVersion: ORDER_FRAME_VERSION,
      kind: 'messageBlock',
      parentId: 'm4',
      orderedChildIds: [],
      frameClock: { timestamp: 6, operationId: 'op6' }
    })
    p2.orderFrames.sort((a, b) => {
      const ra = a.kind === 'topicMessage' ? 0 : 1
      const rb = b.kind === 'topicMessage' ? 0 : 1
      if (ra !== rb) return ra - rb
      return a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0
    })
    p2.manifest.liveCounts.message = 4
    p2.manifest.frameCounts.messageBlock = 4
    expect(() => validatePayload(p2)).toThrow(ValidationError)

    // Interleaving: covered after suffix -> violation
    const p3 = clone(p)
    p3.orderFrames.find((f: any) => f.kind === 'topicMessage').orderedChildIds = ['m2', 'm3', 'm1'] // m3 suffix in middle, then covered m1 after
    expect(() => validatePayload(p3)).toThrow(ValidationError)
  })

  it('suffix tie-break by childId UTF-8 when timestamp+operationId equal', () => {
    const idE000 = '\uE000'
    const id10000 = '\u{10000}'
    const frameClock = { timestamp: 1, operationId: 'op1' }
    const sharedMembership = { timestamp: 5, operationId: 'op5' } // same for both children, so they are both > frameClock and equal to each other

    const mkMsg = (id: string): any => ({
      id,
      topicId: 't1',
      role: null,
      content: null,
      status: null,
      askId: null,
      model: null,
      modelId: null,
      assistantId: null,
      createdAt: null,
      updatedAt: null,
      entityClock: { timestamp: 5, operationId: 'op5' },
      fieldClocks: {
        role: { timestamp: 5, operationId: 'op5' },
        content: { timestamp: 5, operationId: 'op5' },
        status: { timestamp: 5, operationId: 'op5' },
        askId: { timestamp: 5, operationId: 'op5' },
        model: { timestamp: 5, operationId: 'op5' },
        modelId: { timestamp: 5, operationId: 'op5' },
        assistantId: { timestamp: 5, operationId: 'op5' },
        createdAt: { timestamp: 5, operationId: 'op5' },
        updatedAt: { timestamp: 5, operationId: 'op5' }
      },
      parentMembershipClock: sharedMembership
    })

    const pCorrect = goldPayload()
    pCorrect.topics = [
      {
        id: 't1',
        name: null,
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        pinned: null,
        prompt: null,
        isNameManuallyEdited: null,
        entityClock: { timestamp: 1, operationId: 'op1' },
        fieldClocks: {
          name: { timestamp: 1, operationId: 'op1' },
          assistantId: { timestamp: 1, operationId: 'op1' },
          createdAt: { timestamp: 1, operationId: 'op1' },
          updatedAt: { timestamp: 1, operationId: 'op1' },
          deletedAt: { timestamp: 1, operationId: 'op1' },
          pinned: { timestamp: 1, operationId: 'op1' },
          prompt: { timestamp: 1, operationId: 'op1' },
          isNameManuallyEdited: { timestamp: 1, operationId: 'op1' }
        }
      }
    ]
    pCorrect.messages = [mkMsg(idE000), mkMsg(id10000)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) // id order for topic list not important, but need sorted
    // Ensure messages sorted UTF8: E000 < 10000 so E000 first
    pCorrect.messages.sort((a, b) => {
      const ba = new TextEncoder().encode(a.id)
      const bb = new TextEncoder().encode(b.id)
      for (let i = 0; i < Math.min(ba.length, bb.length); i++) if (ba[i] !== bb[i]) return ba[i] - bb[i]
      return ba.length - bb.length
    })
    pCorrect.messageBlocks = []
    pCorrect.tombstones = []
    // UTF8 order is E000 < 10000, so suffix sorted should be [E000, 10000]
    pCorrect.orderFrames = [
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'topicMessage',
        parentId: 't1',
        orderedChildIds: [idE000, id10000],
        frameClock
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: idE000,
        orderedChildIds: [],
        frameClock: sharedMembership
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: id10000,
        orderedChildIds: [],
        frameClock: sharedMembership
      }
    ]
    pCorrect.orderFrames.sort((a, b) => {
      const ra = a.kind === 'topicMessage' ? 0 : 1
      const rb = b.kind === 'topicMessage' ? 0 : 1
      if (ra !== rb) return ra - rb
      const ba = new TextEncoder().encode(a.parentId)
      const bb = new TextEncoder().encode(b.parentId)
      for (let i = 0; i < Math.min(ba.length, bb.length); i++) if (ba[i] !== bb[i]) return ba[i] - bb[i]
      return ba.length - bb.length
    })
    pCorrect.manifest = {
      payloadSchema: PAYLOAD_SCHEMA,
      inventoryVersion: INVENTORY_VERSION,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE,
      liveCounts: { topic: 1, message: 2, messageBlock: 0 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 1, messageBlock: 2 },
      completeness: COMPLETENESS_COMPLETE
    }
    expect(() => validatePayload(pCorrect)).not.toThrow()

    // Reverse suffix order [10000, E000] should be rejected (UTF16 order, not UTF8)
    const pWrong = clone(pCorrect)
    pWrong.orderFrames.find((f: any) => f.kind === 'topicMessage').orderedChildIds = [id10000, idE000]
    expect(() => validatePayload(pWrong)).toThrow(ValidationError)
  })
})

describe('baselineWire tombstone legacy barrier', () => {
  it('compares (T,null) higher than (T,nonNull) at same timestamp', () => {
    const a = { timestamp: 10, operationId: null }
    const b = { timestamp: 10, operationId: 'op1' }
    expect(compareDeletionClocks(a as any, b as any)).toBeGreaterThan(0)
    expect(compareDeletionClocks(b as any, a as any)).toBeLessThan(0)
    expect(compareDeletionClocks(a as any, a as any)).toBe(0)
    expect(compareDeletionClocks(b as any, { timestamp: 10, operationId: 'op2' } as any)).toBeLessThan(0) // op1 < op2
  })

  it('new clocks disallow null operationId', () => {
    const p = goldPayload()
    p.topics[0].entityClock.operationId = null
    expect(() => validatePayload(p)).toThrow(ValidationError)
    const p2 = goldPayload()
    p2.topics[0].parentMembershipClock = null as any // topic has no membership, but test message
    expect(() => validatePayload(p2)).toThrow(ValidationError) // missing key? still
    const p3 = goldPayload()
    p3.messages[0].parentMembershipClock.operationId = null
    expect(() => validatePayload(p3)).toThrow(ValidationError)
    const p4 = goldPayload()
    p4.orderFrames[0].frameClock.operationId = null
    expect(() => validatePayload(p4)).toThrow(ValidationError)
  })

  it('tombstone deletionClock may be null (legacy), but validator only allows there', () => {
    const p = goldPayload()
    p.tombstones = [
      {
        entityType: 'topic',
        entityId: 'tX',
        deletionClock: { timestamp: 5, operationId: null },
        survivingEntityClock: null
      }
    ]
    p.manifest.tombstoneCounts.topic = 1
    expect(() => validatePayload(p)).not.toThrow()
    // New tombstone must have non-null operationId, but validator allows null; we treat null as legacy allowed.
    // However our validator will allow null for deletionClock, and forbid null elsewhere – already tested.
  })
})

describe('baselineWire digest verify', () => {
  it('rejects tampered digest', () => {
    const payload = goldPayload()
    const env: any = {
      wireVersion: WIRE_VERSION,
      channelId: 'c1',
      watermark: 1,
      digestScheme: DIGEST_SCHEME,
      digest: '0'.repeat(64),
      payload
    }
    expect(verifyEnvelopeDigest(env, hashHex)).toBe(false)
    expect(() => validateEnvelope(env)).not.toThrow() // format ok, but verify fails
  })

  it('rejects uppercase digest', () => {
    const payload = goldPayload()
    const upper = GOLD_DIGEST.toUpperCase()
    const env: any = {
      wireVersion: WIRE_VERSION,
      channelId: 'c1',
      watermark: 1,
      digestScheme: DIGEST_SCHEME,
      digest: upper,
      payload
    }
    expect(() => validateEnvelope(env)).toThrow(ValidationError)
  })

  it('verifySyncDigest helpers', () => {
    const payload = goldPayload()
    expect(verifySyncDigest(payload, GOLD_DIGEST, hashHex)).toBe(true)
    expect(verifySyncDigest(payload, 'f'.repeat(64), hashHex)).toBe(false)
    // hashHex injected is used: tamper payload changes digest
    const p2 = clone(payload)
    p2.topics[0].name = 'changed'
    expect(verifySyncDigest(p2, GOLD_DIGEST, hashHex)).toBe(false)
  })

  it('F-01: canonicalizePayload strict validates before canonicalize', () => {
    const illegal = goldPayload()
    illegal.topics[0].name = '\uD800'
    expect(() => canonicalizePayload(illegal)).toThrow(ValidationError)
    expect(() => computeSyncDigest(illegal, hashHex)).toThrow(ValidationError)
    // raw canonicalize library would not throw for lone surrogate in 2.1.0? but our validator ensures gap unreachable
    // computeSyncDigest must not produce digest for illegal payload
    const legal = goldPayload()
    expect(() => computeSyncDigest(legal, hashHex)).not.toThrow()
    // hashHex must return lowercase 64hex, otherwise ValidationError
    const badHash = (_bytes: Uint8Array) => 'ABCDEF'.repeat(10) + 'ABCD' // uppercase
    expect(() => computeSyncDigest(legal, badHash)).toThrow(ValidationError)
    // TextEncoder bytes path: ensure hash receives Uint8Array not string
    let receivedIsUint8Array = false
    const probeHash = (b: Uint8Array) => {
      receivedIsUint8Array = b instanceof Uint8Array
      return GOLD_DIGEST
    }
    computeSyncDigest(legal, probeHash)
    expect(receivedIsUint8Array).toBe(true)
  })

  it('F-01: verifyEnvelopeDigest strict validates envelope before compare', () => {
    const payload = goldPayload()
    const env: any = {
      wireVersion: WIRE_VERSION,
      channelId: 'c1',
      watermark: 1,
      digestScheme: DIGEST_SCHEME,
      digest: GOLD_DIGEST,
      payload
    }
    // illegal outer (lone surrogate) should not verify, should throw ValidationError
    const illegalEnv = clone(env)
    illegalEnv.channelId = '\uD800'
    expect(() => verifyEnvelopeDigest(illegalEnv, hashHex)).toThrow(ValidationError)
    // illegal payload inside envelope should also throw
    const illegalPayloadEnv = clone(env)
    illegalPayloadEnv.payload.topics[0].id = '\uDFFF'
    expect(() => verifyEnvelopeDigest(illegalPayloadEnv, hashHex)).toThrow(ValidationError)
    // tampered outer digest (uppercase) already validated as ValidationError in previous test
    // legal envelope verifies true
    expect(verifyEnvelopeDigest(env, hashHex)).toBe(true)
  })
})

describe('baselineWire strict JSON grammar (F-04)', () => {
  it('rejects trailing comma', () => {
    expect(() => parseStrictJson('{"a":1,}')).toThrow(ValidationError)
    expect(() => parseStrictJson('[1,2,]')).toThrow(ValidationError)
  })
  it('rejects trailing tokens', () => {
    expect(() => parseStrictJson('{"a":1} trailing')).toThrow(ValidationError)
    expect(() => parseStrictJson('null true')).toThrow(ValidationError)
  })
  it('rejects unclosed', () => {
    expect(() => parseStrictJson('{"a":1')).toThrow(ValidationError)
    expect(() => parseStrictJson('[1,2')).toThrow(ValidationError)
    expect(() => parseStrictJson('"abc')).toThrow(ValidationError)
  })
  it('rejects duplicate keys still via JSON grammar', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(ValidationError)
  })
  it('exposes only parseStrictJson/parsePayloadJson/parseEnvelopeJson (assertNoDuplicateKeys not exported)', async () => {
    const mod = await import('../baselineWire')
    expect('assertNoDuplicateKeys' in mod).toBe(false)
    expect(typeof mod.parseStrictJson).toBe('function')
    expect(typeof mod.parsePayloadJson).toBe('function')
    expect(typeof mod.parseEnvelopeJson).toBe('function')
  })
})

describe('baselineWire deep JSON (F-03)', () => {
  it('handles extremely deep legal JSON with explicit stack', () => {
    const depth = 2500
    let json = '1'
    for (let i = 0; i < depth; i++) json = `[${json}]`
    // Should not throw RangeError, should succeed and return nested arrays
    let parsed: unknown
    expect(() => {
      parsed = parseStrictJson(json)
    }).not.toThrow()
    // Verify depth via iterative unwrapping
    let cur: any = parsed
    let d = 0
    while (Array.isArray(cur)) {
      cur = cur[0]
      d++
    }
    expect(d).toBe(depth)
    expect(cur).toBe(1)
  })

  it('all external input errors are ValidationError not RangeError', () => {
    // JSON.parse deep nesting may throw RangeError; ensure parseStrictJson converts to ValidationError
    const deep = '['.repeat(20000) + '1' + ']'.repeat(20000)
    try {
      parseStrictJson(deep)
      // If V8 handles it, then no error; but we still ensure no RangeError leaks
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as Error).name).toBe('ValidationError')
      expect(e).not.toBeInstanceOf(RangeError)
    }
    // Also illegal scalar deep structure via object nesting with lone surrogate at depth
    let json2 = '"ok"'
    for (let i = 0; i < 2500; i++) json2 = `{"a":${json2}}`
    // inject lone surrogate at deepest string via json escape
    const jsonWithSurrogate = json2.replace('"ok"', '"\\uD800"')
    try {
      parseStrictJson(jsonWithSurrogate)
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
    }
  })

  it('payload structure validators are bounded (protocol fixed hierarchy)', () => {
    // The validator recursion for payload is bounded to fixed depth (payload -> topics/messages -> entityClock etc)
    // No arbitrary nesting, so no stack overflow path besides scanForIllegalScalars which is now iterative.
    // This test documents the bound by ensuring a payload with max array sizes still validates quickly.
    const p = goldPayload()
    // Add many topics but depth stays shallow
    for (let i = 0; i < 100; i++) {
      const id = `t-${i.toString().padStart(3, '0')}`
      if (p.topics.some((t: any) => t.id === id)) continue
      p.topics.push({
        id,
        name: null,
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        pinned: null,
        prompt: null,
        isNameManuallyEdited: null,
        entityClock: { timestamp: i, operationId: `op${i}` },
        fieldClocks: {
          name: { timestamp: i, operationId: `op${i}` },
          assistantId: { timestamp: i, operationId: `op${i}` },
          createdAt: { timestamp: i, operationId: `op${i}` },
          updatedAt: { timestamp: i, operationId: `op${i}` },
          deletedAt: { timestamp: i, operationId: `op${i}` },
          pinned: { timestamp: i, operationId: `op${i}` },
          prompt: { timestamp: i, operationId: `op${i}` },
          isNameManuallyEdited: { timestamp: i, operationId: `op${i}` }
        }
      })
    }
    p.topics.sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    // Add missing frames for new topics
    for (const t of p.topics) {
      if (!p.orderFrames.some((f: any) => f.parentId === t.id)) {
        p.orderFrames.push({
          frameVersion: ORDER_FRAME_VERSION,
          kind: 'topicMessage',
          parentId: t.id,
          orderedChildIds: [],
          frameClock: t.entityClock
        })
      }
    }
    p.orderFrames.sort((a: any, b: any) => {
      const ra = a.kind === 'topicMessage' ? 0 : 1
      const rb = b.kind === 'topicMessage' ? 0 : 1
      if (ra !== rb) return ra - rb
      return a.parentId < b.parentId ? -1 : a.parentId > b.parentId ? 1 : 0
    })
    p.manifest.liveCounts.topic = p.topics.length
    p.manifest.frameCounts.topicMessage = p.orderFrames.filter((f: any) => f.kind === 'topicMessage').length
    p.manifest.frameCounts.messageBlock = p.orderFrames.filter((f: any) => f.kind === 'messageBlock').length
    expect(() => validatePayload(p)).not.toThrow()
  })
})

describe('baselineWire RFC8785 representative vectors', () => {
  it('canonicalize handles numbers per JCS (integers as is)', () => {
    // Our payload only allows safe ints, but JCS utility itself should handle numbers like 1.5
    expect(canonicalize(1.5)).toBe('1.5')
    expect(canonicalize(0)).toBe('0')
    // JCS forbids -0? canonicalize maps -0 to 0 via our lib? check
    // We don't rely on this for wire, just ensure no throw
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('canonicalize escapes strings per JCS', () => {
    expect(canonicalize({ s: 'a"b' })).toBe('{"s":"a\\"b"}')
    expect(canonicalize({ s: 'é' })).toBe('{"s":"é"}')
  })
})
