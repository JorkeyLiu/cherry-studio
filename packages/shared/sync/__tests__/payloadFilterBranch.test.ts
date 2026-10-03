import { describe, expect, it } from 'vitest'

import {
  filterBranchPayload,
  filterMessagePayload,
  validateSyncOperationStrict,
  validateSyncPayloadAllowlist
} from '../payloadFilter'

describe('payloadFilter branch domain', () => {
  it('allows branchId on messages (null main, string branch) and branch fields', () => {
    expect(filterMessagePayload({ id: 'm', topicId: 't', branchId: null, role: 'user' })).toEqual({
      id: 'm',
      topicId: 't',
      branchId: null,
      role: 'user'
    })
    expect(filterMessagePayload({ id: 'm', topicId: 't', branchId: 'b1' })).toEqual({
      id: 'm',
      topicId: 't',
      branchId: 'b1'
    })
    expect(
      filterBranchPayload({ id: 'b', topicId: 't', parentBranchId: null, anchorMessageId: 'm', name: 'B' })
    ).toEqual({
      id: 'b',
      topicId: 't',
      parentBranchId: null,
      anchorMessageId: 'm',
      name: 'B'
    })
  })

  it('validates topic_branch upsert/delete ops', () => {
    expect(
      validateSyncOperationStrict({
        id: 'op-1',
        entityType: 'topic_branch',
        op: 'upsert',
        entityId: 'b1',
        timestamp: 1,
        deviceId: 'd',
        payload: { id: 'b1', topicId: 't', parentBranchId: null, anchorMessageId: 'm', name: 'B' }
      })
    ).toBeNull()
    expect(
      validateSyncOperationStrict({
        id: 'op-2',
        entityType: 'topic_branch',
        op: 'delete',
        entityId: 'b1',
        timestamp: 2,
        deviceId: 'd'
      })
    ).toBeNull()
    // Missing anchor fails closed.
    expect(
      validateSyncOperationStrict({
        id: 'op-3',
        entityType: 'topic_branch',
        op: 'upsert',
        entityId: 'b1',
        timestamp: 3,
        deviceId: 'd',
        payload: { id: 'b1', topicId: 't', name: 'B' }
      })
    ).not.toBeNull()
  })

  it('validates branchSuffix order_frame with clock/id/timestamp mirror', () => {
    expect(
      validateSyncOperationStrict({
        id: 'op-f',
        entityType: 'topic_branch',
        op: 'order_frame',
        entityId: 'b1',
        timestamp: 9,
        deviceId: 'd',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'branchSuffix',
          parentId: 'b1',
          orderedChildIds: ['m3'],
          frameClock: { timestamp: 9, operationId: 'op-f' }
        }
      })
    ).toBeNull()
    // Cross pair fails closed.
    expect(
      validateSyncOperationStrict({
        id: 'op-f2',
        entityType: 'topic',
        op: 'order_frame',
        entityId: 'b1',
        timestamp: 9,
        deviceId: 'd',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'branchSuffix',
          parentId: 'b1',
          orderedChildIds: [],
          frameClock: { timestamp: 9, operationId: 'op-f2' }
        }
      })
    ).not.toBeNull()
    // Clock/id mirror enforced.
    expect(
      validateSyncOperationStrict({
        id: 'op-f3',
        entityType: 'topic_branch',
        op: 'order_frame',
        entityId: 'b1',
        timestamp: 8,
        deviceId: 'd',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'branchSuffix',
          parentId: 'b1',
          orderedChildIds: [],
          frameClock: { timestamp: 9, operationId: 'op-f3' }
        }
      })
    ).not.toBeNull()
  })

  it('rejects unknown entityType (old peers fail closed on branch ops)', () => {
    expect(
      validateSyncOperationStrict({
        id: 'op-x',
        entityType: 'topic_branches',
        op: 'upsert',
        entityId: 'b1',
        timestamp: 1,
        deviceId: 'd',
        payload: { id: 'b1' }
      })
    ).not.toBeNull()
  })

  it('allowlist gates branch payloads', () => {
    expect(
      validateSyncPayloadAllowlist({
        entityType: 'topic_branch',
        payload: { id: 'b', topicId: 't', anchorMessageId: 'm', name: 'B', file_path: '/x' }
      })
    ).not.toBeNull()
    expect(
      validateSyncPayloadAllowlist({ entityType: 'message', payload: { id: 'm', topicId: 't', branchId: 'b1' } })
    ).toBeNull()
  })
})
