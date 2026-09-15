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

import { replaceSegmentsForTopic } from '@renderer/store/topicSegment'

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

  it('restoreSegmentsAfterUndo batches same-topic restores into exactly one list+replace', async () => {
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
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === replaceSegmentsForTopic.type)
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
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaces).toHaveLength(2)
  })

  it('restore list failure keeps per-wire fallback without forging catalog', async () => {
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
    await restoreSegmentsAfterUndo(dispatch, getState, [snapB] as any)

    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(mockList).toHaveBeenCalledTimes(1)
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaces).toHaveLength(0)
    // Fallback keeps the restored wire visible (add), never an empty forge.
    const flatTypes = dispatch.mock.calls.map((c) => c[0]?.type as string)
    expect(flatTypes.some((t) => t.includes('addSegment'))).toBe(true)
    const addedCall = dispatch.mock.calls.find((c) => (c[0]?.type as string).includes('addSegment'))
    const added = (addedCall as unknown as [{ payload: { id: string; messageIds: string[] } }])[0].payload
    expect(added.id).toBe('seg-b')
    expect(added.messageIds).toEqual(['m-b'])
  })

  it('restoreTargetSegments batches same-topic upserts into exactly one list+replace', async () => {
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
    const replaces = dispatch.mock.calls.filter((c) => c[0]?.type === replaceSegmentsForTopic.type)
    expect(replaces).toHaveLength(1)
  })
})
