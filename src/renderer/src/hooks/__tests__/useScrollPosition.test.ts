import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import useScrollPosition from '../useScrollPosition'

// In-memory keyv store for test isolation
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
      }
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Create a mock scroll container with controllable scroll dimensions.
 * The container simulates a column-reverse layout where scrollTop ≈ 0
 * means "at bottom" (newest messages).
 */
const createMockContainer = (options?: { scrollTop?: number; scrollHeight?: number }) => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: options?.scrollTop ?? 0, writable: true })
  Object.defineProperty(el, 'scrollHeight', { value: options?.scrollHeight ?? 5000, writable: true })
  return el
}

describe('useScrollPosition', () => {
  describe('savePosition', () => {
    it('persists the current scroll position immediately (non-throttled)', () => {
      const container = createMockContainer({ scrollTop: -200 })
      const { result } = renderHook(() => useScrollPosition('test-topic'))

      act(() => {
        result.current.containerRef.current = container as unknown as HTMLDivElement
      })

      act(() => {
        result.current.savePosition()
      })

      const saved = window.keyv.get('scroll:test-topic')
      expect(saved).toEqual({
        scrollTop: -200,
        anchorId: null,
        isAtBottom: false
      })
    })

    it('detects isAtBottom when scrollTop is near zero (column-reverse layout)', () => {
      const container = createMockContainer({ scrollTop: -10 })
      const { result } = renderHook(() => useScrollPosition('test-topic'))

      act(() => {
        result.current.containerRef.current = container as unknown as HTMLDivElement
        result.current.savePosition()
      })

      const saved = window.keyv.get('scroll:test-topic') as { isAtBottom: boolean }
      expect(saved.isAtBottom).toBe(true)
    })

    it('is safe to call when containerRef is null', () => {
      const { result } = renderHook(() => useScrollPosition('test-topic'))

      // Should not throw
      act(() => {
        result.current.savePosition()
      })

      expect(window.keyv.get('scroll:test-topic')).toBeUndefined()
    })

    it('writes directly to keyv without throttle delay', () => {
      const container = createMockContainer({ scrollTop: -500 })
      const { result } = renderHook(() => useScrollPosition('test-topic', 10000))

      act(() => {
        result.current.containerRef.current = container as unknown as HTMLDivElement
      })

      act(() => {
        result.current.savePosition()
      })

      expect(window.keyv.get('scroll:test-topic')).toEqual({
        scrollTop: -500,
        anchorId: null,
        isAtBottom: false
      })

      Object.defineProperty(container, 'scrollTop', { value: -1000 })
      act(() => {
        result.current.savePosition()
      })

      expect(window.keyv.get('scroll:test-topic')).toEqual({
        scrollTop: -1000,
        anchorId: null,
        isAtBottom: false
      })
    })

    it('cancels pending throttle trailing before writing — trailing does not overwrite', () => {
      vi.useFakeTimers()
      const container = createMockContainer({ scrollTop: -300 })
      const { result } = renderHook(() => useScrollPosition('test-topic'))

      act(() => {
        result.current.containerRef.current = container as unknown as HTMLDivElement
      })

      // handleScroll → leading fires immediately, trailing is scheduled
      act(() => {
        result.current.handleScroll()
      })
      expect((store.get('scroll:test-topic') as { scrollTop: number }).scrollTop).toBe(-300)

      // Second handleScroll within throttle window → trailing pending
      Object.defineProperty(container, 'scrollTop', { value: -600 })
      act(() => {
        result.current.handleScroll()
      })

      // Explicit savePosition at -900 — must cancel the pending trailing
      Object.defineProperty(container, 'scrollTop', { value: -900 })
      act(() => {
        result.current.savePosition()
      })
      expect((store.get('scroll:test-topic') as { scrollTop: number }).scrollTop).toBe(-900)

      // Advance past the throttle window — trailing must NOT fire
      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect((store.get('scroll:test-topic') as { scrollTop: number }).scrollTop).toBe(-900)

      vi.useRealTimers()
    })
  })

  describe('handleScroll', () => {
    it('persists scroll position via throttled handler', async () => {
      vi.useFakeTimers()
      const container = createMockContainer({ scrollTop: -300 })
      const { result } = renderHook(() => useScrollPosition('test-topic'))

      act(() => {
        result.current.containerRef.current = container as unknown as HTMLDivElement
        result.current.handleScroll()
      })

      // lodash throttle with leading:true executes the first call immediately
      const saved = window.keyv.get('scroll:test-topic') as { scrollTop: number }
      expect(saved.scrollTop).toBe(-300)

      // Second call within the throttle window is delayed
      Object.defineProperty(container, 'scrollTop', { value: -600 })
      act(() => {
        result.current.handleScroll()
      })

      // Still the old value (throttled — trailing call pending)
      expect((window.keyv.get('scroll:test-topic') as { scrollTop: number }).scrollTop).toBe(-300)

      // Advance past the default 100ms throttle — trailing call fires
      act(() => {
        vi.advanceTimersByTime(150)
      })

      expect((window.keyv.get('scroll:test-topic') as { scrollTop: number }).scrollTop).toBe(-600)

      vi.useRealTimers()
    })
  })

  describe('getSavedPosition', () => {
    it('returns null when no position is saved', () => {
      const { result } = renderHook(() => useScrollPosition('test-topic'))
      expect(result.current.getSavedPosition()).toBeNull()
    })

    it('returns the saved position after savePosition is called', () => {
      const container = createMockContainer({ scrollTop: -400 })
      const { result } = renderHook(() => useScrollPosition('test-topic'))

      act(() => {
        result.current.containerRef.current = container as unknown as HTMLDivElement
        result.current.savePosition()
      })

      expect(result.current.getSavedPosition()).toEqual({
        scrollTop: -400,
        anchorId: null,
        isAtBottom: false
      })
    })

    it('supports legacy plain number format', () => {
      store.set('scroll:test-topic', -250)
      const { result } = renderHook(() => useScrollPosition('test-topic'))

      expect(result.current.getSavedPosition()).toEqual({
        scrollTop: -250,
        anchorId: null,
        isAtBottom: false
      })
    })
  })

  describe('clearSavedPosition', () => {
    it('removes the persisted position', () => {
      const container = createMockContainer({ scrollTop: -100 })
      const { result } = renderHook(() => useScrollPosition('test-topic'))

      act(() => {
        result.current.containerRef.current = container as unknown as HTMLDivElement
        result.current.savePosition()
      })

      expect(result.current.getSavedPosition()).not.toBeNull()

      act(() => {
        result.current.clearSavedPosition()
      })

      expect(result.current.getSavedPosition()).toBeNull()
    })
  })

  describe('topic key isolation', () => {
    it('flushes pending trailing to old key on key change — trailing writes to topic-A, not topic-B', () => {
      vi.useFakeTimers()
      const container = createMockContainer({ scrollTop: -300 })

      const { result, rerender } = renderHook(({ key }) => useScrollPosition(key), {
        initialProps: { key: 'topic-A' }
      })

      act(() => {
        result.current.containerRef.current = container as unknown as HTMLDivElement
      })

      // handleScroll → leading writes -300 to topic-A; trailing pending
      act(() => {
        result.current.handleScroll()
      })
      expect((store.get('scroll:topic-A') as { scrollTop: number }).scrollTop).toBe(-300)

      // Second handleScroll within window → trailing scheduled with -600
      Object.defineProperty(container, 'scrollTop', { value: -600 })
      act(() => {
        result.current.handleScroll()
      })

      // Switch topic — cleanup must flush the trailing to topic-A then cancel
      rerender({ key: 'topic-B' })

      // topic-A now has the flushed trailing value (-600), not just the leading (-300)
      expect((store.get('scroll:topic-A') as { scrollTop: number }).scrollTop).toBe(-600)
      // topic-B has nothing saved yet
      expect(store.get('scroll:topic-B')).toBeUndefined()

      // Advance past throttle window — no further trailing fires
      act(() => {
        vi.advanceTimersByTime(150)
      })
      // topic-A value unchanged
      expect((store.get('scroll:topic-A') as { scrollTop: number }).scrollTop).toBe(-600)

      vi.useRealTimers()
    })

    it('new key can save independently after key switch', () => {
      const containerA = createMockContainer({ scrollTop: -100 })
      const containerB = createMockContainer({ scrollTop: -400 })

      const { result, rerender } = renderHook(({ key }) => useScrollPosition(key), {
        initialProps: { key: 'topic-A' }
      })

      act(() => {
        result.current.containerRef.current = containerA as unknown as HTMLDivElement
        result.current.savePosition()
      })
      expect((store.get('scroll:topic-A') as { scrollTop: number }).scrollTop).toBe(-100)

      // Switch to topic-B and save
      rerender({ key: 'topic-B' })
      act(() => {
        result.current.containerRef.current = containerB as unknown as HTMLDivElement
        result.current.savePosition()
      })
      expect((store.get('scroll:topic-B') as { scrollTop: number }).scrollTop).toBe(-400)

      // topic-A untouched
      expect((store.get('scroll:topic-A') as { scrollTop: number }).scrollTop).toBe(-100)
    })
  })
})
