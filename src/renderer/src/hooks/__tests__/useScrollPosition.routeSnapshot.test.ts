/**
 * Route-local snapshot: old-schema compat, sync OLD-route save, and
 * controller-gated writes. Covers contract (3).
 *
 * Ownership lives in the single route viewport transition controller; this
 * hook only accepts a `canWrite` gate. Transition-period scrolls never
 * persist — only displayed-stable user scrolls (plus explicit stable
 * commits via `commitSnapshotForRoute`).
 */
import { RouteViewportController } from '@renderer/pages/home/Messages/routeViewportController'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      }
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const mockContainer = (scrollTop = -200) => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true })
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({
      top: 0,
      bottom: 800,
      height: 800,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }),
    configurable: true
  })
  return el
}

describe('route-local snapshot schema', () => {
  it('normalizes legacy snapshots without offset (fallback, no crash)', () => {
    store.set('scroll:topic-legacy', { scrollTop: -300, anchorId: 'm1', isAtBottom: false })
    const { result } = renderHook(() => useScrollPosition('topic-legacy'))
    const pos = result.current.getSavedPosition()
    expect(pos).toEqual(
      expect.objectContaining({
        scrollTop: -300,
        anchorId: 'm1',
        messageId: 'm1',
        intraRowOffset: null,
        isAtBottom: false
      })
    )
  })

  it('normalizes legacy object without isAtBottom and plain numbers', () => {
    store.set('scroll:topic-old2', { scrollTop: -100, anchorId: 'm2' })
    const { result } = renderHook(() => useScrollPosition('topic-old2'))
    expect(result.current.getSavedPosition()).toEqual(
      expect.objectContaining({ anchorId: 'm2', messageId: 'm2', isAtBottom: false })
    )
    store.set('scroll:topic-num', -250)
    const { result: r2 } = renderHook(() => useScrollPosition('topic-num'))
    expect(r2.current.getSavedPosition()).toEqual(
      expect.objectContaining({ scrollTop: -250, anchorId: null, isAtBottom: false })
    )
  })

  it('savePosition writes route-saved-row-anchor fields synchronously', () => {
    const container = mockContainer(-400)
    const { result } = renderHook(() => useScrollPosition('topic-a::main'))
    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
    })
    act(() => {
      result.current.savePosition()
    })
    const saved = store.get('scroll:topic-a::main') as Record<string, unknown>
    expect(saved).toEqual(expect.objectContaining({ scrollTop: -400, rawScrollTop: -400, isAtBottom: false }))
    expect('messageId' in saved).toBe(true)
    expect('intraRowOffset' in saved).toBe(true)
  })

  it('sync freeze persists the OLD route without throttle/effect flush', () => {
    vi.useFakeTimers()
    const container = mockContainer(-350)
    // Hook keyed to the DISPLAYED (old) route: savePosition freezes it
    // synchronously, independent of the throttle trailing.
    const { result } = renderHook(() => useScrollPosition('topic-a::main'))
    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
    })
    act(() => {
      result.current.handleScroll()
    })
    Object.defineProperty(container, 'scrollTop', { value: -999 })
    act(() => {
      result.current.savePosition()
    })
    expect((store.get('scroll:topic-a::main') as { scrollTop: number }).scrollTop).toBe(-999)
    vi.useRealTimers()
  })

  it('controller ownership blocks scroll recording (not stored as user scroll)', () => {
    vi.useFakeTimers()
    const controller = new RouteViewportController({ topicId: 't', route: null })
    const container = mockContainer(-200)
    const { result } = renderHook(() =>
      useScrollPosition('topic-own', { canWrite: () => controller.canAcceptUserScrollWrite() })
    )
    act(() => {
      result.current.containerRef.current = container as unknown as HTMLDivElement
    })
    const { epoch } = controller.request({ kind: 'top', topicId: 't', targetRoute: 'branchB' })
    try {
      Object.defineProperty(container, 'scrollTop', { value: -900 })
      act(() => {
        result.current.handleScroll()
      })
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(store.get('scroll:topic-own')).toBeUndefined()
    } finally {
      controller.terminate(epoch, 'superseded')
    }
    // After release to idle, user scrolls record again.
    act(() => {
      result.current.handleScroll()
    })
    expect((store.get('scroll:topic-own') as { scrollTop: number }).scrollTop).toBe(-900)
    vi.useRealTimers()
  })
})
