/**
 * Focused regression test for final deletion audit blocker 2:
 * stale segment response discarded after deletion generation advances.
 */

import {
  captureDeletionGeneration,
  invalidateTopicsDeletion,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'
import { clearSegmentsForTopic, loadSegments } from '@renderer/store/topicSegment'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockListSegments } = vi.hoisted(() => ({
  mockListSegments: vi.fn()
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    listSegments: mockListSegments
  }
}))

// Use real topicDeletionInvalidation (generation bump) and real thunk logic via dynamic import
// to ensure the generation capture/check is exercised.

describe('loadTopicSegmentsThunk stale discard', () => {
  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
    mockListSegments.mockReset()
    vi.clearAllMocks()
  })

  it('stale segment response is discarded after deletion generation advances', async () => {
    const topicId = 't-stale-segments'
    const segments = [
      {
        id: 'seg-1',
        topicId,
        name: 'Old',
        messageIds: ['m1'],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]

    let resolveList: (v: typeof segments) => void
    const pending = new Promise<typeof segments>((resolve) => {
      resolveList = resolve
    })
    mockListSegments.mockReturnValue(pending)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')

    const dispatch = vi.fn()
    // Kick off thunk but do not await yet — captureDeletionGeneration happens synchronously at start
    const promise = (loadTopicSegmentsThunk as any)(topicId)(dispatch, () => ({}) as any, undefined)

    // Ensure clear was dispatched before fetch resolves (thunk clears stale ids first)
    // Wait a tick to allow the thunk to reach await
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledWith(clearSegmentsForTopic(topicId))
    expect(mockListSegments).toHaveBeenCalledWith(topicId)
    // Only clear so far, not loadSegments
    const callsBefore = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === loadSegments.type).length
    expect(callsBefore).toBe(0)

    // Capture should have been taken before fetch; now bump generation to simulate hard deletion
    const genBefore = captureDeletionGeneration(topicId)
    expect(genBefore).toBe(0)
    invalidateTopicsDeletion([topicId])
    expect(captureDeletionGeneration(topicId)).toBe(1)

    // Resolve the stale fetch
    resolveList!(segments as any)
    await promise

    // loadSegments must NOT have been dispatched because generation advanced
    const loadCalls = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === loadSegments.type)
    expect(loadCalls.length).toBe(0)
  })

  it('non-stale load dispatches loadSegments with fresh data', async () => {
    const topicId = 't-fresh-segments'
    const segments = [
      {
        id: 'seg-2',
        topicId,
        name: 'Fresh',
        messageIds: ['m2'],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    mockListSegments.mockResolvedValue(segments as any)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')
    const dispatch = vi.fn()
    await (loadTopicSegmentsThunk as any)(topicId)(dispatch, () => ({}) as any, undefined)

    expect(dispatch).toHaveBeenCalledWith(clearSegmentsForTopic(topicId))
    // loadSegments should have been called with mapped segments (name/color normalized)
    const loadCalls = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === loadSegments.type)
    expect(loadCalls.length).toBe(1)
    expect(loadCalls[0][0].payload).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'seg-2', topicId })]))
  })

  it('stale check is per-topic: other topic generation does not discard', async () => {
    const topicId = 't-per-topic-a'
    const otherTopic = 't-per-topic-b'
    const segments = [
      {
        id: 'seg-3',
        topicId,
        name: 'PerTopic',
        messageIds: [],
        color: undefined,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    let resolveList: (v: typeof segments) => void
    const pending = new Promise<typeof segments>((resolve) => {
      resolveList = resolve
    })
    mockListSegments.mockReturnValue(pending)

    const { loadTopicSegmentsThunk } = await import('../topicSegmentThunk')
    const dispatch = vi.fn()
    const promise = (loadTopicSegmentsThunk as any)(topicId)(dispatch, () => ({}) as any, undefined)
    await Promise.resolve()

    // Bump generation for OTHER topic only
    invalidateTopicsDeletion([otherTopic])
    expect(captureDeletionGeneration(topicId)).toBe(0)
    expect(captureDeletionGeneration(otherTopic)).toBe(1)

    resolveList!(segments as any)
    await promise

    // Should still dispatch because topicId's generation did not advance
    const loadCalls = dispatch.mock.calls.filter((c: any[]) => c[0]?.type === loadSegments.type)
    expect(loadCalls.length).toBe(1)
  })
})
