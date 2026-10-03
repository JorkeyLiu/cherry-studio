import crypto from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION_V3,
  isV3EnvelopeLike,
  ORDER_FRAME_VERSION,
  parseEnvelopeJson,
  PAYLOAD_SCHEMA_V3,
  SCOPE_V3,
  validateEnvelope,
  validateEnvelopeV1,
  validateEnvelopeV3,
  validatePayloadV3,
  ValidationError,
  verifyEnvelopeDigest,
  WIRE_VERSION_V3
} from '../baselineWire'

function clk(ts: number, op: string): { timestamp: number; operationId: string } {
  return { timestamp: ts, operationId: op }
}

function topicClocks(op: string): Record<string, { timestamp: number; operationId: string }> {
  const c = clk(1, op)
  return {
    name: c,
    assistantId: c,
    createdAt: c,
    updatedAt: c,
    deletedAt: c,
    pinned: c,
    prompt: c,
    isNameManuallyEdited: c
  }
}

function messageClocks(op: string): Record<string, { timestamp: number; operationId: string }> {
  const c = clk(2, op)
  return {
    role: c,
    content: c,
    status: c,
    askId: c,
    model: c,
    modelId: c,
    assistantId: c,
    createdAt: c,
    updatedAt: c
  }
}

function blockClocks(op: string): Record<string, { timestamp: number; operationId: string }> {
  const c = clk(3, op)
  return { type: c, content: c, status: c, createdAt: c, updatedAt: c }
}

function branchClocks(op: string): Record<string, { timestamp: number; operationId: string }> {
  const c = clk(4, op)
  return { name: c, createdAt: c, updatedAt: c }
}

function v3Payload(): any {
  return {
    payloadSchema: PAYLOAD_SCHEMA_V3,
    inventoryVersion: INVENTORY_VERSION_V3,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V3,
    topics: [
      {
        id: 't1',
        name: 'Topic One',
        assistantId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: null,
        pinned: false,
        prompt: null,
        isNameManuallyEdited: false,
        entityClock: clk(1, 'op-t'),
        fieldClocks: topicClocks('op-t')
      }
    ],
    messages: [
      {
        id: 'm1',
        topicId: 't1',
        branchId: null,
        role: 'user',
        content: 'hi',
        status: 'success',
        askId: null,
        model: null,
        modelId: null,
        assistantId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        entityClock: clk(2, 'op-m1'),
        fieldClocks: messageClocks('op-m1'),
        parentMembershipClock: clk(2, 'op-m1')
      },
      {
        id: 'm2',
        topicId: 't1',
        branchId: null,
        role: 'assistant',
        content: 'hello',
        status: 'success',
        askId: null,
        model: null,
        modelId: null,
        assistantId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        entityClock: clk(3, 'op-m2'),
        fieldClocks: messageClocks('op-m2'),
        parentMembershipClock: clk(3, 'op-m2')
      },
      {
        id: 'm3',
        topicId: 't1',
        branchId: 'b1',
        role: 'assistant',
        content: 'branch answer',
        status: 'success',
        askId: null,
        model: null,
        modelId: null,
        assistantId: null,
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        entityClock: clk(6, 'op-m3'),
        fieldClocks: messageClocks('op-m3'),
        parentMembershipClock: clk(6, 'op-m3')
      }
    ],
    messageBlocks: [
      {
        id: 'k1',
        messageId: 'm1',
        type: 'main_text',
        content: 'hi',
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        entityClock: clk(3, 'op-k1'),
        fieldClocks: blockClocks('op-k1'),
        parentMembershipClock: clk(3, 'op-k1')
      },
      {
        id: 'k2',
        messageId: 'm2',
        type: 'main_text',
        content: 'hello',
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        entityClock: clk(4, 'op-k2'),
        fieldClocks: blockClocks('op-k2'),
        parentMembershipClock: clk(4, 'op-k2')
      },
      {
        id: 'k3',
        messageId: 'm3',
        type: 'main_text',
        content: 'branch answer',
        status: 'success',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        entityClock: clk(7, 'op-k3'),
        fieldClocks: blockClocks('op-k3'),
        parentMembershipClock: clk(7, 'op-k3')
      }
    ],
    branches: [
      {
        id: 'b1',
        topicId: 't1',
        parentBranchId: null,
        anchorMessageId: 'm1',
        name: 'Branch One',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        entityClock: clk(5, 'op-b1'),
        fieldClocks: branchClocks('op-b1')
      }
    ],
    tombstones: [],
    replacementRegisters: [],
    orderFrames: [
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'topicMessage',
        parentId: 't1',
        orderedChildIds: ['m1', 'm2'],
        frameClock: clk(10, 'op-f1')
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: 'm1',
        orderedChildIds: ['k1'],
        frameClock: clk(11, 'op-f2')
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: 'm2',
        orderedChildIds: ['k2'],
        frameClock: clk(12, 'op-f3')
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: 'm3',
        orderedChildIds: ['k3'],
        frameClock: clk(13, 'op-f4')
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'branchSuffix',
        parentId: 'b1',
        orderedChildIds: ['m3'],
        frameClock: clk(14, 'op-f5')
      }
    ],
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA_V3,
      inventoryVersion: INVENTORY_VERSION_V3,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V3,
      liveCounts: { topic: 1, message: 3, messageBlock: 3, branch: 1 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0, topicBranch: 0 },
      frameCounts: { topicMessage: 1, messageBlock: 3, branchSuffix: 1 },
      replacementCount: 0,
      completeness: COMPLETENESS_COMPLETE
    }
  }
}

function hashHex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function v3Envelope(payload?: any): any {
  const p = payload ?? v3Payload()
  return {
    wireVersion: WIRE_VERSION_V3,
    channelId: 'ch-1',
    watermark: 7,
    digestScheme: DIGEST_SCHEME,
    digest: computeSyncDigest(p, hashHex),
    payload: p
  }
}

describe('baselineWire v3 branch inventory', () => {
  it('validates a well-formed v3 payload and envelope with digest', () => {
    const payload = v3Payload()
    expect(() => validatePayloadV3(payload)).not.toThrow()
    const envelope = v3Envelope(payload)
    expect(() => validateEnvelopeV3(envelope)).not.toThrow()
    expect(() => validateEnvelope(envelope)).not.toThrow()
    expect(isV3EnvelopeLike(envelope)).toBe(true)
    expect(verifyEnvelopeDigest(envelope, hashHex)).toBe(true)
  })

  it('parses v3 from raw JSON with duplicate-key rejection', () => {
    const envelope = v3Envelope()
    const parsed = parseEnvelopeJson(JSON.stringify(envelope))
    expect((parsed as { wireVersion: string }).wireVersion).toBe(WIRE_VERSION_V3)
    expect(() => parseEnvelopeJson('{"wireVersion":"x","wireVersion":"y"}')).toThrow(ValidationError)
  })

  it('fails closed when a topicMessage frame includes a branch message', () => {
    const payload = v3Payload()
    payload.orderFrames[0].orderedChildIds = ['m1', 'm2', 'm3']
    expect(() => validatePayloadV3(payload)).toThrow(ValidationError)
  })

  it('fails closed on branch anchor owner mismatch (inherited anchor)', () => {
    const payload = v3Payload()
    // m2 is main-owned; a nested branch parented at b1 cannot anchor on m2.
    payload.branches.push({
      id: 'b2',
      topicId: 't1',
      parentBranchId: 'b1',
      anchorMessageId: 'm2',
      name: 'Bad Nested',
      createdAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
      entityClock: clk(15, 'op-b2'),
      fieldClocks: branchClocks('op-b2')
    })
    // Manifest + frames must also change for a well-formed extension; here
    // the closure must fail before counts matter.
    expect(() => validatePayloadV3(payload)).toThrow(ValidationError)
  })

  it('fails closed on branch ancestry cycle', () => {
    const payload = v3Payload()
    payload.branches[0].parentBranchId = 'b1'
    expect(() => validatePayloadV3(payload)).toThrow(ValidationError)
  })

  it('fails closed when a branchSuffix frame omits an owned child', () => {
    const payload = v3Payload()
    payload.orderFrames[4].orderedChildIds = []
    expect(() => validatePayloadV3(payload)).toThrow(ValidationError)
  })

  it('fails closed on manifest count mismatch (branch counts)', () => {
    const payload = v3Payload()
    payload.manifest.liveCounts.branch = 0
    expect(() => validatePayloadV3(payload)).toThrow(ValidationError)
  })

  it('fails closed on unknown keys and versions (strictly closed)', () => {
    const payload = v3Payload()
    payload.messages[0].extraField = 1
    expect(() => validatePayloadV3(payload)).toThrow(ValidationError)
    const payload2 = v3Payload()
    payload2.inventoryVersion = 'topic-message-stable-block-order-v2'
    expect(() => validatePayloadV3(payload2)).toThrow(ValidationError)
  })

  it('v1 validator rejects v3 payloads (incompatible peers blocked, no downgrade)', () => {
    const envelope = v3Envelope()
    expect(() => validateEnvelopeV1(envelope)).toThrow(ValidationError)
  })

  it('branch tombstone requires live-branch absence and counts', () => {
    const payload = v3Payload()
    // Remove the live branch, tombstone it, drop its suffix frame + message.
    payload.branches = []
    payload.messages = payload.messages.filter((m: any) => m.id !== 'm3')
    payload.messageBlocks = payload.messageBlocks.filter((k: any) => k.id !== 'k3')
    payload.orderFrames = payload.orderFrames.filter(
      (f: any) =>
        !(f.kind === 'branchSuffix' && f.parentId === 'b1') && !(f.kind === 'messageBlock' && f.parentId === 'm3')
    )
    payload.tombstones = [
      {
        entityType: 'message',
        entityId: 'm3',
        deletionClock: clk(20, 'op-del'),
        survivingEntityClock: clk(6, 'op-m3')
      },
      {
        entityType: 'topicBranch',
        entityId: 'b1',
        deletionClock: clk(20, 'op-del'),
        survivingEntityClock: clk(5, 'op-b1')
      }
    ]
    payload.manifest.liveCounts = { topic: 1, message: 2, messageBlock: 2, branch: 0 }
    payload.manifest.tombstoneCounts = { topic: 0, message: 1, messageBlock: 0, topicBranch: 1 }
    payload.manifest.frameCounts = { topicMessage: 1, messageBlock: 2, branchSuffix: 0 }
    expect(() => validatePayloadV3(payload)).not.toThrow()
  })
})
