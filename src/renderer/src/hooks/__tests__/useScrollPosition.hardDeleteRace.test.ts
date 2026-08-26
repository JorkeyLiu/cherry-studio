import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SCROLL_SNAPSHOT_INDEX_KEY } from '../../services/scrollSnapshotCache'
import {
  removeScrollSnapshotsForTopicIds,
  resetInvalidatedScrollSnapshotsForTests,
  resetScrollSnapshotCacheForTests
} from '../../services/scrollSnapshotCache'
import { resetAllDeletionGenerationsForTests } from '../../services/topicDeletionInvalidation'
import useScrollPosition from '../useScrollPosition'

let store: Map<string, unknown>

function createKeyvMock() {
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    remove: (key: string) => store.delete(key),
    keys: () => Array.from(store.keys())
  }
}

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('window', {
    ...window,
    keyv: createKeyvMock()
  })
  resetScrollSnapshotCacheForTests()
  resetInvalidatedScrollSnapshotsForTests()
  resetAllDeletionGenerationsForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const createMockContainer = (scrollTop = -200) => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true })
  Object.defineProperty(el, 'scrollHeight', { value: 5000, writable: true })
  return el
}

describe('useScrollPosition hard-delete race (BLOCKER)', () => {
  it('pending throttle trailing does not recreate snapshot after hard delete (cache invalidation)', () => {
    vi.useFakeTimers()
    const container = createMockContainer(-300)
    const { result } = renderHook(() => useScrollPosition('topic-race-a'))

    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.handleScroll()
    })
    // Leading write
    expect((store.get('scroll:topic-race-a') as any).scrollTop).toBe(-300)

    // Second scroll within throttle window => trailing pending with -600
    Object.defineProperty(container, 'scrollTop', { value: -600 })
    act(() => {
      result.current.handleScroll()
    })
    expect((store.get('scroll:topic-race-a') as any).scrollTop).toBe(-300)

    // Hard delete while trailing pending — simulates topic hard deletion
    act(() => {
      removeScrollSnapshotsForTopicIds(['race-a'])
    })
    expect(store.get('scroll:topic-race-a')).toBeUndefined()

    // Advance past throttle window — trailing must NOT recreate
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(store.get('scroll:topic-race-a')).toBeUndefined()
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[] | undefined
    if (idx) expect(idx.find((e) => e.key === 'scroll:topic-race-a')).toBeUndefined()

    vi.useRealTimers()
  })

  it('flush on key change does not recreate hard-deleted snapshot', () => {
    vi.useFakeTimers()
    const container = createMockContainer(-300)
    const { result, rerender } = renderHook(({ key }) => useScrollPosition(key), {
      initialProps: { key: 'topic-race-b' }
    })

    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.handleScroll()
    })
    expect((store.get('scroll:topic-race-b') as any).scrollTop).toBe(-300)

    Object.defineProperty(container, 'scrollTop', { value: -600 })
    act(() => {
      result.current.handleScroll()
    })

    // Hard delete before key change (unmount flush scenario)
    act(() => {
      removeScrollSnapshotsForTopicIds(['race-b'])
    })
    expect(store.get('scroll:topic-race-b')).toBeUndefined()

    // Key change triggers flush of pending trailing to old key — must remain blocked
    rerender({ key: 'topic-race-c' })
    // Flush happens synchronously in cleanup
    expect(store.get('scroll:topic-race-b')).toBeUndefined()
    expect(store.get('scroll:topic-race-c')).toBeUndefined()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(store.get('scroll:topic-race-b')).toBeUndefined()

    vi.useRealTimers()
  })

  it('mounted hook cancels pending throttle on deletion generation bump (subscription)', async () => {
    vi.useFakeTimers()
    // Dynamically import to avoid hoisting issues with window stub
    const { bumpDeletionGeneration } = await import('../../services/topicDeletionInvalidation')
    const container = createMockContainer(-300)
    const { result } = renderHook(() => useScrollPosition('topic-race-d'))

    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.handleScroll()
    })
    Object.defineProperty(container, 'scrollTop', { value: -600 })
    act(() => {
      result.current.handleScroll()
    })

    // Bump generation — hook subscribes and should cancel pending trailing
    act(() => {
      bumpDeletionGeneration('race-d')
      // Also mark invalidated via cache (hard delete path does both)
      removeScrollSnapshotsForTopicIds(['race-d'])
    })
    expect(store.get('scroll:topic-race-d')).toBeUndefined()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(store.get('scroll:topic-race-d')).toBeUndefined()

    vi.useRealTimers()
  })

  it('savePosition is blocked for hard-deleted key', () => {
    const container = createMockContainer(-300)
    const { result } = renderHook(() => useScrollPosition('topic-race-e'))

    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.savePosition()
    })
    expect(store.get('scroll:topic-race-e')).toBeDefined()

    act(() => {
      removeScrollSnapshotsForTopicIds(['race-e'])
    })
    expect(store.get('scroll:topic-race-e')).toBeUndefined()

    Object.defineProperty(container, 'scrollTop', { value: -999 })
    act(() => {
      result.current.savePosition()
    })
    expect(store.get('scroll:topic-race-e')).toBeUndefined()
  })

  it('cleanup remains safe for mounted/unmounted hooks', () => {
    vi.useFakeTimers()
    const container = createMockContainer(-300)
    const { result, unmount } = renderHook(() => useScrollPosition('topic-race-f'))

    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.handleScroll()
    })
    Object.defineProperty(container, 'scrollTop', { value: -600 })
    act(() => {
      result.current.handleScroll()
    })

    act(() => {
      removeScrollSnapshotsForTopicIds(['race-f'])
    })
    // Unmount triggers flush + cancel — must not throw and must not recreate
    expect(() => unmount()).not.toThrow()
    expect(store.get('scroll:topic-race-f')).toBeUndefined()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(store.get('scroll:topic-race-f')).toBeUndefined()

    vi.useRealTimers()
  })
})
