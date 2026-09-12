import crypto from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION,
  INVENTORY_VERSION_V2,
  ORDER_FRAME_VERSION,
  parseEnvelopeJson,
  PAYLOAD_SCHEMA,
  PAYLOAD_SCHEMA_V2,
  SCOPE,
  SCOPE_V2,
  validateEnvelope,
  validateEnvelopeV1,
  validateEnvelopeV2,
  validatePayload,
  validatePayloadV1,
  validatePayloadV2,
  ValidationError,
  verifyEnvelopeDigest,
  WIRE_VERSION,
  WIRE_VERSION_V2
} from '../baselineWire'

function hashHex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function v1Payload(): any {
  return {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics: [],
    messages: [],
    messageBlocks: [],
    tombstones: [],
    orderFrames: [],
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA,
      inventoryVersion: INVENTORY_VERSION,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE,
      liveCounts: { topic: 0, message: 0, messageBlock: 0 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 0, messageBlock: 0 },
      completeness: COMPLETENESS_COMPLETE
    }
  }
}

function v2Payload(registers: any[] = []): any {
  return {
    payloadSchema: PAYLOAD_SCHEMA_V2,
    inventoryVersion: INVENTORY_VERSION_V2,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V2,
    topics: [],
    messages: [],
    messageBlocks: [],
    tombstones: [],
    orderFrames: [],
    replacementRegisters: registers,
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA_V2,
      inventoryVersion: INVENTORY_VERSION_V2,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V2,
      liveCounts: { topic: 0, message: 0, messageBlock: 0 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 0, messageBlock: 0 },
      replacementCount: registers.length,
      completeness: COMPLETENESS_COMPLETE
    }
  }
}

function v2Envelope(channelId: string, watermark: number, registers: any[] = []): any {
  const payload = v2Payload(registers)
  const digest = computeSyncDigest(payload, hashHex)
  return { wireVersion: WIRE_VERSION_V2, channelId, watermark, digestScheme: DIGEST_SCHEME, digest, payload }
}

describe('baseline v2 strictness', () => {
  it('v1 payload still validates via v1 path and version-dispatched entry', () => {
    const p = v1Payload()
    expect(() => validatePayloadV1(p)).not.toThrow()
    expect(() => validatePayload(p)).not.toThrow()
    expect(() => validatePayloadV2(p)).toThrow(ValidationError)
  })

  it('v2 payload validates strictly with replacementRegisters + replacementCount', () => {
    const p = v2Payload([
      { messageId: 'm-1', replacementClock: { timestamp: 10, operationId: 'op-1' }, activeBlockIds: ['b-2', 'b-1'] }
    ])
    expect(() => validatePayloadV2(p)).not.toThrow()
    expect(() => validatePayload(p)).not.toThrow()
    expect(() => validatePayloadV1(p)).toThrow(ValidationError)
  })

  it('v2 rejects unknown/missing replacement keys and duplicate messageId', () => {
    const base = v2Payload()
    const missing = JSON.parse(JSON.stringify(base))
    delete missing.replacementRegisters
    expect(() => validatePayloadV2(missing)).toThrow(/missing required key/)
    const extra = JSON.parse(JSON.stringify(base))
    extra.extra = 1
    expect(() => validatePayloadV2(extra)).toThrow(/unknown key/)
    const dup = v2Payload([
      { messageId: 'm-1', replacementClock: { timestamp: 1, operationId: 'op-1' }, activeBlockIds: [] },
      { messageId: 'm-1', replacementClock: { timestamp: 2, operationId: 'op-2' }, activeBlockIds: [] }
    ])
    expect(() => validatePayloadV2(dup)).toThrow(/duplicate/)
  })

  it('v2 enforces messageId UTF-8 byte-lex sort and replacementCount recompute', () => {
    const unsorted = v2Payload([
      { messageId: 'm-b', replacementClock: { timestamp: 1, operationId: 'op-1' }, activeBlockIds: [] },
      { messageId: 'm-a', replacementClock: { timestamp: 1, operationId: 'op-1' }, activeBlockIds: [] }
    ])
    expect(() => validatePayloadV2(unsorted)).toThrow(/sorted/)
    const badCount = v2Payload([
      { messageId: 'm-1', replacementClock: { timestamp: 1, operationId: 'op-1' }, activeBlockIds: [] }
    ])
    badCount.manifest.replacementCount = 0
    expect(() => validatePayloadV2(badCount)).toThrow(/replacementCount/)
    // v1 manifest with replacementCount fails closed (exact keys)
    const v1WithCount = v1Payload()
    v1WithCount.manifest.replacementCount = 0
    expect(() => validatePayloadV1(v1WithCount)).toThrow(/unknown key|exact keys/)
  })

  it('v2 entry validates clock shapes and activeBlockIds duplicates', () => {
    const badClock = v2Payload([
      { messageId: 'm-1', replacementClock: { timestamp: -1, operationId: 'op-1' }, activeBlockIds: [] }
    ])
    expect(() => validatePayloadV2(badClock)).toThrow()
    const colonOp = v2Payload([
      { messageId: 'm-1', replacementClock: { timestamp: 1, operationId: 'a:b' }, activeBlockIds: [] }
    ])
    expect(() => validatePayloadV2(colonOp)).toThrow(/colon/)
    const dupActive = v2Payload([
      { messageId: 'm-1', replacementClock: { timestamp: 1, operationId: 'op-1' }, activeBlockIds: ['b-1', 'b-1'] }
    ])
    expect(() => validatePayloadV2(dupActive)).toThrow(/duplicate activeBlockIds/)
    const emptyActive = v2Payload([
      { messageId: 'm-1', replacementClock: { timestamp: 1, operationId: 'op-1' }, activeBlockIds: [] }
    ])
    expect(() => validatePayloadV2(emptyActive)).not.toThrow()
  })

  it('digest still jcs-sha256-v1 covering only payload for v2', () => {
    const env = v2Envelope('chan-1', 7)
    expect(() => validateEnvelopeV2(env)).not.toThrow()
    expect(() => validateEnvelope(env)).not.toThrow()
    expect(verifyEnvelopeDigest(env, hashHex)).toBe(true)
    const tampered = JSON.parse(JSON.stringify(env))
    tampered.payload.replacementRegisters.push({
      messageId: 'm-x',
      replacementClock: { timestamp: 1, operationId: 'op-1' },
      activeBlockIds: []
    })
    tampered.payload.manifest.replacementCount = 1
    expect(verifyEnvelopeDigest(tampered, hashHex)).toBe(false)
    // Envelope field change does not affect payload-only digest input except validation
    const chanSwap = JSON.parse(JSON.stringify(env))
    chanSwap.channelId = 'chan-2'
    expect(verifyEnvelopeDigest(chanSwap, hashHex)).toBe(true)
  })

  it('version dispatch: v1 envelope stays v1, v2 envelope is v2, unknown fails', () => {
    const v1Env = {
      wireVersion: WIRE_VERSION,
      channelId: 'c',
      watermark: 0,
      digestScheme: DIGEST_SCHEME,
      digest: computeSyncDigest(v1Payload(), hashHex),
      payload: v1Payload()
    }
    expect(() => validateEnvelopeV1(v1Env)).not.toThrow()
    expect(() => validateEnvelopeV2(v1Env)).toThrow(ValidationError)
    const v2Env = v2Envelope('c', 0)
    expect(() => validateEnvelopeV2(v2Env)).not.toThrow()
    expect(() => validateEnvelopeV1(v2Env)).toThrow(ValidationError)
    const bad = JSON.parse(JSON.stringify(v2Env))
    bad.wireVersion = 'sync-baseline-wire-v9'
    expect(() => validateEnvelope(bad)).toThrow(ValidationError)
    expect(() => parseEnvelopeJson(JSON.stringify(bad))).toThrow(ValidationError)
  })
})
