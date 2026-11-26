import type { TopicBranchWire } from '@renderer/services/db/types'
import type { WholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { loadSnapshotMock, warnMock } = vi.hoisted(() => ({
  loadSnapshotMock: vi.fn(),
  warnMock: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: warnMock, error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/utils/topicSnapshot', () => ({
  loadWholeTopicSnapshot: (...args: unknown[]) => loadSnapshotMock(...args)
}))

import { useBranchAnchorRanks } from '../useBranchAnchorRanks'

const wire = (id: string, parentBranchId: string | null, anchorMessageId: string): TopicBranchWire => ({
  id,
  topicId: 't-1',
  parentBranchId,
  anchorMessageId,
  name: id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

const snapshot = (messageIds: string[]): WholeTopicSnapshot =>
  ({
    messages: messageIds.map((id) => ({ id })),
    blocks: [],
    blocksById: new Map(),
    snapshot: {}
  }) as unknown as WholeTopicSnapshot

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useBranchAnchorRanks', () => {
  beforeEach(() => {
    loadSnapshotMock.mockReset()
    warnMock.mockReset()
  })

  it('does not load while the panel is closed', () => {
    renderHook(() => useBranchAnchorRanks('t-1', [wire('b-1', null, 'm-1')], false))

    expect(loadSnapshotMock).not.toHaveBeenCalled()
  })

  it('loads each unique parent route once and indexes that route’s messages by position', async () => {
    const branches = [
      wire('b-1', null, 'm-root'),
      wire('b-2', null, 'm-root'),
      wire('b-3', 'b-1', 'm-child'),
      wire('b-4', 'b-1', 'm-child')
    ]
    loadSnapshotMock.mockImplementation(async (_topicId: string, parentBranchId: string | null) =>
      snapshot(parentBranchId === null ? ['m-before', 'm-root', 'm-after'] : ['m-child', 'm-later'])
    )

    const { result } = renderHook(() => useBranchAnchorRanks('t-1', branches, true))

    await waitFor(() => expect(result.current.get(null)?.get('m-root')).toBe(1))
    expect(result.current.get(null)?.get('m-before')).toBe(0)
    expect(result.current.get(null)?.get('m-after')).toBe(2)
    expect(result.current.get('b-1')?.get('m-child')).toBe(0)
    expect(result.current.get('b-1')?.get('m-later')).toBe(1)
    expect(loadSnapshotMock).toHaveBeenCalledTimes(2)
    expect(loadSnapshotMock).toHaveBeenCalledWith('t-1', null)
    expect(loadSnapshotMock).toHaveBeenCalledWith('t-1', 'b-1')
  })

  it('isolates a failed parent route without discarding successful ranks', async () => {
    const branches = [wire('b-1', null, 'm-root'), wire('b-2', 'b-1', 'm-child')]
    loadSnapshotMock.mockImplementation(async (_topicId: string, parentBranchId: string | null) => {
      if (parentBranchId === 'b-1') throw new Error('private route failure')
      return snapshot(['m-root'])
    })

    const { result } = renderHook(() => useBranchAnchorRanks('t-1', branches, true))

    await waitFor(() => expect(result.current.get(null)?.get('m-root')).toBe(0))
    expect(result.current.has('b-1')).toBe(false)
    expect(warnMock).toHaveBeenCalledWith('[useBranchAnchorRanks] Failed to load parent-route message positions')
  })

  it('discards a late result from the previous topic', async () => {
    const oldTopic = deferred<WholeTopicSnapshot>()
    const branches = [wire('b-1', null, 'm-root')]
    loadSnapshotMock.mockImplementation((topicId: string) =>
      topicId === 't-1' ? oldTopic.promise : Promise.resolve(snapshot(['m-new-topic']))
    )
    const { result, rerender } = renderHook(
      ({ topicId }: { topicId: string }) => useBranchAnchorRanks(topicId, branches, true),
      { initialProps: { topicId: 't-1' } }
    )

    rerender({ topicId: 't-2' })
    await waitFor(() => expect(result.current.get(null)?.get('m-new-topic')).toBe(0))
    await act(async () => {
      oldTopic.resolve(snapshot(['m-old-topic']))
      await oldTopic.promise
    })

    expect(result.current.get(null)?.has('m-old-topic')).toBe(false)
    expect(result.current.get(null)?.get('m-new-topic')).toBe(0)
  })

  it('discards a late result from the previous catalog anchor set', async () => {
    const oldCatalog = deferred<WholeTopicSnapshot>()
    const oldBranches = [wire('b-old', null, 'm-old')]
    const newBranches = [wire('b-new', null, 'm-new')]
    loadSnapshotMock.mockReturnValueOnce(oldCatalog.promise).mockResolvedValueOnce(snapshot(['m-new']))
    const { result, rerender } = renderHook(
      ({ branches }: { branches: TopicBranchWire[] }) => useBranchAnchorRanks('t-1', branches, true),
      { initialProps: { branches: oldBranches } }
    )

    rerender({ branches: newBranches })
    await waitFor(() => expect(result.current.get(null)?.get('m-new')).toBe(0))
    await act(async () => {
      oldCatalog.resolve(snapshot(['m-old']))
      await oldCatalog.promise
    })

    expect(result.current.get(null)?.has('m-old')).toBe(false)
    expect(result.current.get(null)?.get('m-new')).toBe(0)
  })

  it('reuses cached ranks across close/open and refreshes when an anchor is added', async () => {
    const initialBranches = [wire('b-1', null, 'm-first')]
    loadSnapshotMock.mockResolvedValue(snapshot(['m-first', 'm-second']))
    const { result, rerender } = renderHook(
      ({ branches, enabled }: { branches: TopicBranchWire[]; enabled: boolean }) =>
        useBranchAnchorRanks('t-1', branches, enabled),
      { initialProps: { branches: initialBranches, enabled: true } }
    )
    await waitFor(() => expect(result.current.get(null)?.get('m-first')).toBe(0))

    rerender({ branches: [...initialBranches], enabled: false })
    rerender({ branches: [...initialBranches], enabled: true })
    await waitFor(() => expect(result.current.get(null)?.get('m-first')).toBe(0))
    expect(loadSnapshotMock).toHaveBeenCalledTimes(1)

    rerender({ branches: [...initialBranches, wire('b-2', null, 'm-second')], enabled: true })
    await waitFor(() => expect(result.current.get(null)?.get('m-second')).toBe(1))
    expect(loadSnapshotMock).toHaveBeenCalledTimes(2)
  })
})
