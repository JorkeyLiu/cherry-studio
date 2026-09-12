/**
 * Exhaustive closure tests for the dedicated `message_stable_replace`
 * operation wire contract (SYNC-DATA-050 / SYNC-CC-025, receiver-first slice).
 *
 * Locked shape under test: existing SyncOperation envelope with
 * `op:'message_stable_replace'`, `entityType:'message'`,
 * `entityId === payload.messageId === payload.message.id ===
 * payload.messageFrame.parentId`, every block `messageId === messageId`,
 * `deviceId` envelope-only, envelope `id/timestamp` mirroring
 * `replacementClock`, strictly closed eight-key payload with
 * `replaceVersion:'message-stable-replace-v1'`, full stable message +
 * canonical id-sorted stable-supported blocks (no `sortOrder` on wire),
 * `activeBlockIds` exactly the block set in business order,
 * `topicFrame`/`messageFrame` in exact `parent-order-frame-v1` shape with
 * both `frameClock`s mirroring `replacementClock` and
 * `messageFrame.orderedChildIds` exactly `activeBlockIds`.
 */
import { describe, expect, it } from 'vitest'

import { validateSyncOperationStrict } from '../payloadFilter'
import { MESSAGE_STABLE_REPLACE_PAYLOAD_KEYS, MESSAGE_STABLE_REPLACE_VERSION } from '../stableReplace'

function clock(ts: number, opId: string): Record<string, unknown> {
  return { timestamp: ts, operationId: opId }
}

function fieldClocks(keys: string[], ts: number, opId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = clock(ts, opId)
  return out
}

const MESSAGE_FIELDS = [
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt'
]
const BLOCK_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt']

function makeMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    topicId: 't-1',
    role: 'assistant',
    content: 'final answer',
    status: 'success',
    askId: 'a-1',
    model: 'm',
    modelId: 'mid',
    assistantId: 'as-1',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:01.000Z',
    entityClock: clock(1000, 'rep-op-1'),
    fieldClocks: fieldClocks(MESSAGE_FIELDS, 1000, 'rep-op-1'),
    parentMembershipClock: clock(900, 'create-op-1'),
    ...overrides
  }
}

function makeBlock(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    messageId: 'm-1',
    type: 'text',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:01.000Z',
    entityClock: clock(1000, 'rep-op-1'),
    fieldClocks: fieldClocks(BLOCK_FIELDS, 1000, 'rep-op-1'),
    parentMembershipClock: clock(950, `create-${id}`),
    ...overrides
  }
}

function makeFrame(kind: string, parentId: string, children: string[]): Record<string, unknown> {
  return {
    frameVersion: 'parent-order-frame-v1',
    kind,
    parentId,
    orderedChildIds: [...children],
    frameClock: clock(1000, 'rep-op-1')
  }
}

/** Legal op: blocks id-sorted [b-1,b-2], business order [b-2,b-1]. */
function makeLegalOp(): Record<string, unknown> {
  return {
    id: 'rep-op-1',
    entityType: 'message',
    op: 'message_stable_replace',
    entityId: 'm-1',
    timestamp: 1000,
    deviceId: 'd-1',
    payload: {
      replaceVersion: MESSAGE_STABLE_REPLACE_VERSION,
      messageId: 'm-1',
      replacementClock: clock(1000, 'rep-op-1'),
      message: makeMessage(),
      messageBlocks: [makeBlock('b-1'), makeBlock('b-2')],
      activeBlockIds: ['b-2', 'b-1'],
      topicFrame: makeFrame('topicMessage', 't-1', ['m-0', 'm-1']),
      messageFrame: makeFrame('messageBlock', 'm-1', ['b-2', 'b-1'])
    }
  }
}

function payloadOf(op: Record<string, unknown>): Record<string, unknown> {
  return op.payload as Record<string, unknown>
}

describe('message_stable_replace shared validator closure', () => {
  it('locks the eight-key payload spelling', () => {
    expect([...MESSAGE_STABLE_REPLACE_PAYLOAD_KEYS].sort()).toEqual(
      [
        'activeBlockIds',
        'message',
        'messageBlocks',
        'messageFrame',
        'messageId',
        'replaceVersion',
        'replacementClock',
        'topicFrame'
      ].sort()
    )
    expect(MESSAGE_STABLE_REPLACE_VERSION).toBe('message-stable-replace-v1')
  })

  it('accepts the exact locked shape (business order may differ from canonical sort)', () => {
    expect(validateSyncOperationStrict(makeLegalOp())).toBeNull()
  })

  it('accepts empty blocks with empty active set', () => {
    const op = makeLegalOp()
    const p = payloadOf(op)
    p.messageBlocks = []
    p.activeBlockIds = []
    ;(p.messageFrame as Record<string, unknown>).orderedChildIds = []
    expect(validateSyncOperationStrict(op)).toBeNull()
  })

  it('rejects wrong entityType', () => {
    const op = makeLegalOp()
    op.entityType = 'topic'
    expect(validateSyncOperationStrict(op)).not.toBeNull()
  })

  it('rejects unknown op-adjacent bindings', () => {
    const op = makeLegalOp()
    // entityId must equal payload.messageId
    const mismatch = makeLegalOp()
    mismatch.entityId = 'm-9'
    expect(validateSyncOperationStrict(mismatch)).not.toBeNull()
    // message.id must equal payload.messageId
    const p = payloadOf(op)
    ;(p.message as Record<string, unknown>).id = 'm-9'
    expect(validateSyncOperationStrict(op)).not.toBeNull()
  })

  it('rejects block messageId mismatch', () => {
    const op = makeLegalOp()
    const p = payloadOf(op)
    ;(p.messageBlocks as Record<string, unknown>[])[0].messageId = 'm-9'
    expect(validateSyncOperationStrict(op)).not.toBeNull()
  })

  it('rejects messageFrame parent mismatch and topicFrame parent mismatch', () => {
    const a = makeLegalOp()
    ;(payloadOf(a).messageFrame as Record<string, unknown>).parentId = 'm-9'
    expect(validateSyncOperationStrict(a)).not.toBeNull()
    const b = makeLegalOp()
    ;(payloadOf(b).topicFrame as Record<string, unknown>).parentId = 't-9'
    expect(validateSyncOperationStrict(b)).not.toBeNull()
  })

  it('rejects unknown replaceVersion and unknown/extra/missing payload keys', () => {
    const a = makeLegalOp()
    payloadOf(a).replaceVersion = 'message-stable-replace-v2'
    expect(validateSyncOperationStrict(a)).not.toBeNull()
    const b = makeLegalOp()
    payloadOf(b).extra = 1
    expect(validateSyncOperationStrict(b)).not.toBeNull()
    const c = makeLegalOp()
    delete payloadOf(c).topicFrame
    expect(validateSyncOperationStrict(c)).not.toBeNull()
    const d = makeLegalOp()
    payloadOf(d).deviceId = 'd-1'
    expect(validateSyncOperationStrict(d)).not.toBeNull()
  })

  it('rejects sortOrder on wire in message and blocks', () => {
    const a = makeLegalOp()
    ;(payloadOf(a).message as Record<string, unknown>).sortOrder = 0
    expect(validateSyncOperationStrict(a)).not.toBeNull()
    const b = makeLegalOp()
    ;(payloadOf(b).messageBlocks as Record<string, unknown>[])[0].sortOrder = 0
    expect(validateSyncOperationStrict(b)).not.toBeNull()
  })

  it('rejects transient statuses and excluded block types', () => {
    for (const s of ['streaming', 'pending', 'processing', 'searching']) {
      const a = makeLegalOp()
      ;(payloadOf(a).message as Record<string, unknown>).status = s
      expect(validateSyncOperationStrict(a)).not.toBeNull()
      const b = makeLegalOp()
      ;(payloadOf(b).messageBlocks as Record<string, unknown>[])[0].status = s
      expect(validateSyncOperationStrict(b)).not.toBeNull()
    }
    for (const t of ['tool', ' File ', 'IMAGE', 'video', 'citation']) {
      const b = makeLegalOp()
      ;(payloadOf(b).messageBlocks as Record<string, unknown>[])[0].type = t
      expect(validateSyncOperationStrict(b)).not.toBeNull()
    }
    // stable strings stay eligible
    for (const s of ['success', 'error', 'paused', 'sent']) {
      const a = makeLegalOp()
      ;(payloadOf(a).message as Record<string, unknown>).status = s
      expect(validateSyncOperationStrict(a)).toBeNull()
    }
  })

  it('rejects duplicate/unsorted blocks and active-set divergence', () => {
    const dup = makeLegalOp()
    const dp = payloadOf(dup)
    dp.messageBlocks = [makeBlock('b-1'), makeBlock('b-1')]
    expect(validateSyncOperationStrict(dup)).not.toBeNull()
    const unsorted = makeLegalOp()
    const up = payloadOf(unsorted)
    up.messageBlocks = [makeBlock('b-2'), makeBlock('b-1')]
    expect(validateSyncOperationStrict(unsorted)).not.toBeNull()
    const omission = makeLegalOp()
    payloadOf(omission).activeBlockIds = ['b-1']
    expect(validateSyncOperationStrict(omission)).not.toBeNull()
    const extra = makeLegalOp()
    payloadOf(extra).activeBlockIds = ['b-2', 'b-1', 'b-9']
    expect(validateSyncOperationStrict(extra)).not.toBeNull()
    const dupActive = makeLegalOp()
    payloadOf(dupActive).activeBlockIds = ['b-1', 'b-1']
    expect(validateSyncOperationStrict(dupActive)).not.toBeNull()
  })

  it('rejects topicFrame self omission (sibling completeness stays apply-side)', () => {
    const op = makeLegalOp()
    ;(payloadOf(op).topicFrame as Record<string, unknown>).orderedChildIds = ['m-0']
    expect(validateSyncOperationStrict(op)).toMatch(/must include payload\.messageId/)
    // Self present with a partial sibling set still validates: sibling
    // coverage is enforced by the apply-side frame completeness gate.
    const partial = makeLegalOp()
    ;(payloadOf(partial).topicFrame as Record<string, unknown>).orderedChildIds = ['m-1']
    expect(validateSyncOperationStrict(partial)).toBeNull()
  })

  it('rejects messageFrame order that differs from activeBlockIds', () => {
    const op = makeLegalOp()
    ;(payloadOf(op).messageFrame as Record<string, unknown>).orderedChildIds = ['b-1', 'b-2']
    expect(validateSyncOperationStrict(op)).not.toBeNull()
  })

  it('rejects frameClock divergence and envelope mirror mismatch', () => {
    const a = makeLegalOp()
    ;((payloadOf(a).topicFrame as Record<string, unknown>).frameClock as Record<string, unknown>).timestamp = 999
    expect(validateSyncOperationStrict(a)).not.toBeNull()
    const b = makeLegalOp()
    ;((payloadOf(b).messageFrame as Record<string, unknown>).frameClock as Record<string, unknown>).operationId =
      'other'
    expect(validateSyncOperationStrict(b)).not.toBeNull()
    const c = makeLegalOp()
    c.timestamp = 999
    expect(validateSyncOperationStrict(c)).not.toBeNull()
    const d = makeLegalOp()
    d.id = 'other-op'
    expect(validateSyncOperationStrict(d)).not.toBeNull()
  })

  it('rejects unknown frame version/kind and duplicate frame children', () => {
    const a = makeLegalOp()
    ;(payloadOf(a).topicFrame as Record<string, unknown>).frameVersion = 'parent-order-frame-v2'
    expect(validateSyncOperationStrict(a)).not.toBeNull()
    const b = makeLegalOp()
    ;(payloadOf(b).topicFrame as Record<string, unknown>).kind = 'messageBlock'
    expect(validateSyncOperationStrict(b)).not.toBeNull()
    const c = makeLegalOp()
    ;(payloadOf(c).messageFrame as Record<string, unknown>).orderedChildIds = ['b-1', 'b-1']
    expect(validateSyncOperationStrict(c)).not.toBeNull()
  })

  it('rejects Unicode/safe-int/clock gates', () => {
    const lone = makeLegalOp()
    payloadOf(lone).messageId = '\uD800'
    expect(validateSyncOperationStrict(lone)).not.toBeNull()
    const unsafe = makeLegalOp()
    ;(payloadOf(unsafe).replacementClock as Record<string, unknown>).timestamp = Number.MAX_SAFE_INTEGER + 1
    expect(validateSyncOperationStrict(unsafe)).not.toBeNull()
    const colon = makeLegalOp()
    const colonOp = { ...colon, id: 'a:b' }
    ;(payloadOf(colonOp).replacementClock as Record<string, unknown>).operationId = 'a:b'
    expect(validateSyncOperationStrict(colonOp)).not.toBeNull()
    const long = makeLegalOp()
    const longId = `x`.repeat(257)
    const longOp = { ...long, id: longId }
    ;(payloadOf(longOp).replacementClock as Record<string, unknown>).operationId = longId
    expect(validateSyncOperationStrict(longOp)).not.toBeNull()
    const empty = makeLegalOp()
    payloadOf(empty).messageId = ''
    expect(validateSyncOperationStrict(empty)).not.toBeNull()
  })

  it('rejects missing field clocks and wrong value types', () => {
    const a = makeLegalOp()
    delete ((payloadOf(a).message as Record<string, unknown>).fieldClocks as Record<string, unknown>).status
    expect(validateSyncOperationStrict(a)).not.toBeNull()
    const b = makeLegalOp()
    ;(payloadOf(b).messageBlocks as Record<string, unknown>[])[0].content = 42
    expect(validateSyncOperationStrict(b)).not.toBeNull()
    const c = makeLegalOp()
    delete (payloadOf(c).message as Record<string, unknown>).parentMembershipClock
    expect(validateSyncOperationStrict(c)).not.toBeNull()
  })
})
