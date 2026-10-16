import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUpsert, mockReplace, mockList } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockReplace: vi.fn(),
  mockList: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: mockUpsert,
    replaceSegmentMembership: mockReplace,
    listSegments: mockList,
    deleteSegment: vi.fn()
  }
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

import { SEGMENT_CATALOG_PUBLISH_COMPLETE } from '@renderer/store/residentRegistry'

import { restoreSegmentsAfterUndo, restoreTargetSegments } from '../topicSegmentThunk'

function wire(id: string, topicId: string, sortOrder: number, messageIds: string[]) {
  return {
    id,
    topicId,
    name: id,
    messageIds: [...messageIds],
    color: `color-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    messageCount: messageIds.length
  }
}

describe('segment restore batch convergence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('restoreSegmentsAfterUndo batches same-topic restores into exactly one preserving publication', async () => {
    const snapA = {
      id: 'seg-a',
      topicId: 't1',
      name: 'A',
      messageIds: ['m-a'],
      color: 'color-seg-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 99,
      firstMessageId: 'm-a',
      lastMessageId: 'm-a',
      messageCount: 1
    }
    const snapB = {
      id: 'seg-b',
      topicId: 't1',
      name: 'B',
      messageIds: ['m-b'],
      color: 'color-seg-b',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 99,
      firstMessageId: 'm-b',
      lastMessageId: 'm-b',
      messageCount: 1
    }
    const getState = () =>
      ({
        topicSegments: { segments: { entities: { 'seg-a': { ...snapA } } }, segmentsByTopic: { t1: ['seg-a'] } }
      }) as any
    mockReplace.mockResolvedValue(wire('seg-a', 't1', 1, ['m-a']))
    mockUpsert.mockResolvedValue(wire('seg-b', 't1', 0, ['m-b']))
    mockList.mockResolvedValue([wire('seg-b', 't1', 0, ['m-b']), wire('seg-a', 't1', 1, ['m-a'])])

    const dispatch = vi.fn()
    await restoreSegmentsAfterUndo(dispatch, getState, [snapA, snapB] as any)

    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(mockList).toHaveBeenCalledTimes(1)
    expect(mockList).toHaveBeenCalledWith('t1')
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === SEGMENT_CATALOG_PUBLISH_COMPLETE)
    expect(replaces).toHaveLength(1)
    expect(replaces[0][0].payload.topicId).toBe('t1')
    expect(replaces[0][0].payload.segments.map((s: any) => s.id)).toEqual(['seg-b', 'seg-a'])
  })

  it('restore batch converges once per affected topic', async () => {
    const snapA = {
      id: 'seg-a',
      topicId: 't1',
      name: 'A',
      messageIds: ['m-a'],
      color: 'color-seg-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-a',
      lastMessageId: 'm-a',
      messageCount: 1
    }
    const snapB = {
      id: 'seg-b',
      topicId: 't2',
      name: 'B',
      messageIds: ['m-b'],
      color: 'color-seg-b',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-b',
      lastMessageId: 'm-b',
      messageCount: 1
    }
    const getState = () => ({ topicSegments: { segments: { entities: {} }, segmentsByTopic: {} } }) as any
    mockUpsert.mockImplementation((id: string, topicId: string) => Promise.resolve(wire(id, topicId, 0, [`m-${id}`])))
    mockList.mockImplementation((topicId: string) => Promise.resolve([wire(`seg-${topicId}`, topicId, 0, ['m-x'])]))

    const dispatch = vi.fn()
    await restoreSegmentsAfterUndo(dispatch, getState, [snapA, snapB] as any)

    expect(mockList).toHaveBeenCalledTimes(2)
    expect(mockList).toHaveBeenCalledWith('t1')
    expect(mockList).toHaveBeenCalledWith('t2')
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === SEGMENT_CATALOG_PUBLISH_COMPLETE)
    expect(replaces).toHaveLength(2)
  })

  it('restore list failure surfaces without fabricating per-wire catalog (fail closed)', async () => {
    const snapB = {
      id: 'seg-b',
      topicId: 't1',
      name: 'B',
      messageIds: ['m-b'],
      color: 'color-seg-b',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 99,
      firstMessageId: 'm-b',
      lastMessageId: 'm-b',
      messageCount: 1
    }
    const getState = () => ({ topicSegments: { segments: { entities: {} }, segmentsByTopic: {} } }) as any
    mockUpsert.mockResolvedValue(wire('seg-b', 't1', 0, ['m-b']))
    mockList.mockRejectedValue(new Error('list failed'))

    const dispatch = vi.fn()
    await expect(restoreSegmentsAfterUndo(dispatch, getState, [snapB] as any)).rejects.toThrow('list failed')

    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(mockList).toHaveBeenCalledTimes(1)
    // No fabricated catalog: neither preserving publication nor per-wire
    // fallback is dispatched on list failure.
    const publishes = dispatch.mock.calls.filter((c) => c[0]?.type === SEGMENT_CATALOG_PUBLISH_COMPLETE)
    expect(publishes).toHaveLength(0)
    const flatTypes = dispatch.mock.calls.map((c) => c[0]?.type as string)
    expect(flatTypes.some((t) => t.includes('addSegment'))).toBe(false)
    expect(flatTypes.some((t) => t.includes('updateSegment'))).toBe(false)
    expect(flatTypes.some((t) => t.includes('removeSegment'))).toBe(false)
  })

  it('restoreTargetSegments batches same-topic upserts into exactly one preserving publication', async () => {
    const snapA = {
      id: 'seg-a',
      topicId: 't1',
      name: 'A',
      messageIds: ['m-a'],
      color: 'color-seg-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-a',
      lastMessageId: 'm-a',
      messageCount: 1
    }
    const snapB = {
      id: 'seg-b',
      topicId: 't1',
      name: 'B',
      messageIds: ['m-b'],
      color: 'color-seg-b',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 1,
      firstMessageId: 'm-b',
      lastMessageId: 'm-b',
      messageCount: 1
    }
    mockUpsert.mockImplementation((id: string, topicId: string) => Promise.resolve(wire(id, topicId, 0, ['m-x'])))
    mockList.mockResolvedValue([wire('seg-a', 't1', 0, ['m-a']), wire('seg-b', 't1', 1, ['m-b'])])

    const dispatch = vi.fn()
    await restoreTargetSegments(dispatch, [snapA, snapB] as any)

    expect(mockUpsert).toHaveBeenCalledTimes(2)
    expect(mockList).toHaveBeenCalledTimes(1)
    expect(mockList).toHaveBeenCalledWith('t1')
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === SEGMENT_CATALOG_PUBLISH_COMPLETE)
    expect(replaces).toHaveLength(1)
  })

  it('restoreSegmentsAfterUndo pins the staged sibling route for replace+upsert while live differs', async () => {
    const snapA = {
      id: 'seg-a',
      topicId: 't1',
      name: 'A',
      messageIds: ['m-a'],
      color: 'color-seg-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-a',
      lastMessageId: 'm-a',
      messageCount: 1
    }
    const snapB = {
      id: 'seg-b',
      topicId: 't1',
      name: 'B',
      messageIds: ['m-b'],
      color: 'color-seg-b',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 1,
      firstMessageId: 'm-b',
      lastMessageId: 'm-b',
      messageCount: 1
    }
    // Live route switched away from the staged cut route after paste.
    const getState = () =>
      ({
        topicBranch: { activeBranchIdByTopic: { t1: 'branch-live' } },
        topicSegments: { segments: { entities: { 'seg-a': { ...snapA } } }, segmentsByTopic: { t1: ['seg-a'] } }
      }) as any
    mockReplace.mockResolvedValue(wire('seg-a', 't1', 1, ['m-a']))
    mockUpsert.mockResolvedValue(wire('seg-b', 't1', 0, ['m-b']))
    mockList.mockResolvedValue([wire('seg-b', 't1', 0, ['m-b']), wire('seg-a', 't1', 1, ['m-a'])])

    const dispatch = vi.fn()
    await restoreSegmentsAfterUndo(dispatch, getState, [snapA, snapB] as any, 'branch-staged')

    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith('seg-a', ['m-a'], 'branch-staged')
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(mockUpsert.mock.calls[0][5]).toBe('branch-staged')
    for (const call of [...mockReplace.mock.calls, ...mockUpsert.mock.calls]) {
      expect(call[call.length - 1]).not.toBe('branch-live')
    }
  })

  it('restoreSegmentsAfterUndo pins explicit main (null) while live is a sibling', async () => {
    const snapA = {
      id: 'seg-a',
      topicId: 't1',
      name: 'A',
      messageIds: ['m-a'],
      color: 'color-seg-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-a',
      lastMessageId: 'm-a',
      messageCount: 1
    }
    const getState = () =>
      ({
        topicBranch: { activeBranchIdByTopic: { t1: 'branch-live' } },
        topicSegments: { segments: { entities: { 'seg-a': { ...snapA } } }, segmentsByTopic: { t1: ['seg-a'] } }
      }) as any
    mockReplace.mockResolvedValue(wire('seg-a', 't1', 1, ['m-a']))
    mockList.mockResolvedValue([wire('seg-a', 't1', 1, ['m-a'])])

    const dispatch = vi.fn()
    await restoreSegmentsAfterUndo(dispatch, getState, [snapA] as any, null)

    expect(mockReplace).toHaveBeenCalledExactlyOnceWith('seg-a', ['m-a'], null)
  })

  it('restoreSegmentsAfterUndo without a pinned route retains the live-route behavior', async () => {
    const snapA = {
      id: 'seg-a',
      topicId: 't1',
      name: 'A',
      messageIds: ['m-a'],
      color: 'color-seg-a',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-a',
      lastMessageId: 'm-a',
      messageCount: 1
    }
    const getState = () =>
      ({
        topicBranch: { activeBranchIdByTopic: { t1: 'branch-live' } },
        topicSegments: { segments: { entities: { 'seg-a': { ...snapA } } }, segmentsByTopic: { t1: ['seg-a'] } }
      }) as any
    mockReplace.mockResolvedValue(wire('seg-a', 't1', 1, ['m-a']))
    mockList.mockResolvedValue([wire('seg-a', 't1', 1, ['m-a'])])

    const dispatch = vi.fn()
    await restoreSegmentsAfterUndo(dispatch, getState, [snapA] as any)

    expect(mockReplace).toHaveBeenCalledExactlyOnceWith('seg-a', ['m-a'], 'branch-live')
  })

  it('restoreTargetSegments pins the staged target route; explicit null pins main; omitted keeps live resolution', async () => {
    const snap = {
      id: 'seg-t',
      topicId: 't1',
      name: 'T',
      messageIds: ['m-t'],
      color: 'color-seg-t',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm-t',
      lastMessageId: 'm-t',
      messageCount: 1
    }
    mockList.mockResolvedValue([wire('seg-t', 't1', 0, ['m-t'])])

    // restoreTargetSegments resolves the live route via the store fallback;
    // the pinned cases below must not depend on it, the omitted case asserts it.
    const dispatch = vi.fn()

    mockUpsert.mockResolvedValue(wire('seg-t', 't1', 0, ['m-t']))
    await restoreTargetSegments(dispatch, [snap] as any, 'branch-tgt')
    expect(mockUpsert.mock.calls[0][5]).toBe('branch-tgt')

    vi.clearAllMocks()
    mockUpsert.mockResolvedValue(wire('seg-t', 't1', 0, ['m-t']))
    mockList.mockResolvedValue([wire('seg-t', 't1', 0, ['m-t'])])
    await restoreTargetSegments(dispatch, [snap] as any, null)
    expect(mockUpsert.mock.calls[0][5]).toBe(null)

    // Omitted keeps the existing live-route resolution (store fallback here).
    vi.clearAllMocks()
    mockUpsert.mockResolvedValue(wire('seg-t', 't1', 0, ['m-t']))
    mockList.mockResolvedValue([wire('seg-t', 't1', 0, ['m-t'])])
    await restoreTargetSegments(dispatch, [snap] as any)
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    // Omitted resolves live (store fallback) — never the previously pinned route.
    expect(mockUpsert.mock.calls[0][5]).not.toBe('branch-tgt')
  })
})
