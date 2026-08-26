import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SCROLL_SNAPSHOT_INDEX_KEY } from '../../services/scrollSnapshotCache'
import useScrollPosition from '../useScrollPosition'

let store: Map<string, unknown>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('window', {
    ...window,
    keyv: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value)
      },
      remove: (key: string) => {
        store.delete(key)
      },
      keys: () => Array.from(store.keys())
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const createMockContainer = (options?: { scrollTop?: number }) => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: options?.scrollTop ?? -200, writable: true })
  Object.defineProperty(el, 'scrollHeight', { value: 5000, writable: true })
  return el
}

describe('useScrollPosition with bounded scroll snapshot cache', () => {
  it('savePosition creates index entry', () => {
    const container = createMockContainer({ scrollTop: -300 })
    const { result } = renderHook(() => useScrollPosition('topic-cache-a'))
    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.savePosition()
    })
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx).toBeDefined()
    expect(idx.find((e) => e.key === 'scroll:topic-cache-a')).toBeDefined()
    expect(store.get('scroll:topic-cache-a')).toBeDefined()
  })

  it('getSavedPosition updates index recency', () => {
    vi.useFakeTimers()
    const base = 1_000_000
    vi.setSystemTime(base)
    const container = createMockContainer({ scrollTop: -400 })
    const { result } = renderHook(() => useScrollPosition('topic-cache-b'))
    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.savePosition()
    })
    const before = (store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find(
      (e) => e.key === 'scroll:topic-cache-b'
    ).lastAccess
    expect(before).toBe(base)
    const now = base + 5000
    vi.setSystemTime(now)
    act(() => {
      result.current.getSavedPosition()
    })
    const after = (store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).find(
      (e) => e.key === 'scroll:topic-cache-b'
    ).lastAccess
    expect(after).toBe(now)
    expect(after).not.toBe(before)
    vi.useRealTimers()
  })

  it('clearSavedPosition removes index entry without affecting other topics', () => {
    const containerA = createMockContainer({ scrollTop: -100 })
    const containerB = createMockContainer({ scrollTop: -200 })
    const { result: resultA } = renderHook(() => useScrollPosition('topic-cache-c'))
    const { result: resultB } = renderHook(() => useScrollPosition('topic-cache-d'))

    act(() => {
      resultA.current.containerRef.current = containerA as unknown as HTMLDivElement
      resultA.current.savePosition()
    })
    act(() => {
      resultB.current.containerRef.current = containerB as unknown as HTMLDivElement
      resultB.current.savePosition()
    })
    expect((store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]).length).toBe(2)

    act(() => {
      resultA.current.clearSavedPosition()
    })
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === 'scroll:topic-cache-c')).toBeUndefined()
    expect(idx.find((e) => e.key === 'scroll:topic-cache-d')).toBeDefined()
    expect(store.get('scroll:topic-cache-c')).toBeUndefined()
    expect(store.get('scroll:topic-cache-d')).toBeDefined()
  })

  it('throttled handleScroll flush persists and updates index (topic key isolation)', () => {
    vi.useFakeTimers()
    const container = createMockContainer({ scrollTop: -300 })
    const { result, rerender } = renderHook(({ key }) => useScrollPosition(key), {
      initialProps: { key: 'topic-cache-e' }
    })
    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
      result.current.handleScroll()
    })
    // Leading writes immediately
    expect(store.get('scroll:topic-cache-e')).toBeDefined()
    let idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === 'scroll:topic-cache-e')).toBeDefined()

    Object.defineProperty(container, 'scrollTop', { value: -600 })
    act(() => {
      result.current.handleScroll()
    })
    // Throttled trailing pending
    rerender({ key: 'topic-cache-f' })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    // Old key should have flushed trailing
    expect((store.get('scroll:topic-cache-e') as any).scrollTop).toBe(-600)
    // Index for old key still present, new key not yet saved
    idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === 'scroll:topic-cache-e')).toBeDefined()
    expect(store.get('scroll:topic-cache-f')).toBeUndefined()

    vi.useRealTimers()
  })

  it('supports legacy numeric format and indexes it on read', () => {
    store.set('scroll:topic-cache-legacy', -250)
    const { result } = renderHook(() => useScrollPosition('topic-cache-legacy'))
    const pos = result.current.getSavedPosition()
    expect(pos).toEqual({ scrollTop: -250, anchorId: null, isAtBottom: false })
    const idx = store.get(SCROLL_SNAPSHOT_INDEX_KEY) as any[]
    expect(idx.find((e) => e.key === 'scroll:topic-cache-legacy')).toBeDefined()
  })
})
