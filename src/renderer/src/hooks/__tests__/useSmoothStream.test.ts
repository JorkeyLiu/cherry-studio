import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSmoothStream } from '../useSmoothStream'

/**
 * useSmoothStream contract tests (LOCK-004):
 *   - completion drains the exact full accumulated text with no loss/truncation
 *   - reset clears pending chunks and starts over
 *   - frames never lose queued chunks regardless of cadence
 *   - UI updates respect the minDelay cadence
 *
 * requestAnimationFrame is stubbed with a controllable callback queue so the
 * render loop can be advanced deterministically with synthetic timestamps.
 */

const raf = vi.hoisted(() => ({
  callbacks: new Map<number, FrameRequestCallback>(),
  nextId: 1
}))

const rafStub = vi.fn((cb: FrameRequestCallback) => {
  const id = raf.nextId++
  raf.callbacks.set(id, cb)
  return id
})
const cafStub = vi.fn((id: number) => {
  raf.callbacks.delete(id)
})

/** Run the pending rAF callbacks once per frame with increasing timestamps. */
const advanceFrames = (count: number, stepMs = 16, startTime = 1000) => {
  act(() => {
    let t = startTime
    for (let i = 0; i < count; i++) {
      t += stepMs
      const callbacks = [...raf.callbacks.values()]
      raf.callbacks.clear()
      for (const cb of callbacks) {
        cb(t)
      }
    }
  })
}

const runSingleFrame = (timestamp: number) => {
  act(() => {
    const callbacks = [...raf.callbacks.values()]
    raf.callbacks.clear()
    for (const cb of callbacks) {
      cb(timestamp)
    }
  })
}

describe('useSmoothStream', () => {
  beforeEach(() => {
    raf.callbacks.clear()
    raf.nextId = 1
    vi.stubGlobal('requestAnimationFrame', rafStub)
    vi.stubGlobal('cancelAnimationFrame', cafStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('drains the exact full accumulated text on completion (no loss, no truncation)', () => {
    const onUpdate = vi.fn()
    const { result, rerender } = renderHook(
      ({ done }) => useSmoothStream({ onUpdate, streamDone: done, minDelay: 0, initialText: '' }),
      { initialProps: { done: false } }
    )

    act(() => {
      result.current.addChunk('Hello ')
      result.current.addChunk('world!')
    })

    // Let the loop make partial progress but not necessarily finish.
    advanceFrames(20)

    // Complete the stream: the remaining queue must drain to the exact text.
    act(() => {
      rerender({ done: true })
    })
    advanceFrames(20)

    expect(onUpdate).toHaveBeenLastCalledWith('Hello world!')
  })

  it('appends to an existing initialText without re-rendering it', () => {
    const onUpdate = vi.fn()
    const { result, rerender } = renderHook(
      ({ done }) => useSmoothStream({ onUpdate, streamDone: done, minDelay: 0, initialText: 'Base' }),
      { initialProps: { done: false } }
    )

    act(() => {
      result.current.addChunk('-tail')
    })
    advanceFrames(20)
    act(() => {
      rerender({ done: true })
    })
    advanceFrames(20)

    expect(onUpdate).toHaveBeenLastCalledWith('Base-tail')
  })

  it('reset clears pending chunks and starts over with the new text', () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useSmoothStream({ onUpdate, streamDone: false, minDelay: 0, initialText: '' }))

    act(() => {
      result.current.addChunk('stale content')
      result.current.reset('fresh')
      result.current.addChunk('-tail')
    })
    advanceFrames(30)

    expect(onUpdate).toHaveBeenLastCalledWith('fresh-tail')
    expect(onUpdate.mock.calls.flat().every((call) => !String(call).includes('stale'))).toBe(true)
  })

  it('never loses queued chunks regardless of frame cadence', () => {
    const onUpdate = vi.fn()
    const text = Array.from({ length: 50 }, (_, i) => `chunk${i} `).join('')
    const { result, rerender } = renderHook(
      ({ done }) => useSmoothStream({ onUpdate, streamDone: done, minDelay: 0, initialText: '' }),
      { initialProps: { done: false } }
    )

    act(() => {
      result.current.addChunk(text)
    })
    // Sparse frames — the loop must not lose queued chunks.
    advanceFrames(4)
    act(() => {
      rerender({ done: true })
    })
    advanceFrames(30)

    expect(onUpdate).toHaveBeenLastCalledWith(text)
  })

  it('respects minDelay between UI updates (bounded update cadence)', () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useSmoothStream({ onUpdate, streamDone: false, minDelay: 50, initialText: '' }))

    act(() => {
      result.current.addChunk('abcdefghij')
    })

    // First frame: 1016 - 0 >= 50 → renders (establishes lastUpdateTime).
    runSingleFrame(1016)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    // 16ms later: 1032 - 1016 = 16 < 50 → must be skipped.
    runSingleFrame(1032)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    // 54ms after the last render: 1070 - 1016 = 54 >= 50 → renders again.
    runSingleFrame(1070)
    expect(onUpdate).toHaveBeenCalledTimes(2)
  })

  it('does not schedule frames when disabled', () => {
    const onUpdate = vi.fn()
    renderHook(() => useSmoothStream({ onUpdate, streamDone: true, enabled: false, initialText: 'final' }))

    expect(rafStub).not.toHaveBeenCalled()
    expect(raf.callbacks.size).toBe(0)
  })

  it('starts scheduling frames when enabled after a completed mount', () => {
    const onUpdate = vi.fn()
    const { rerender } = renderHook(
      ({ enabled, done }) => useSmoothStream({ onUpdate, streamDone: done, enabled, initialText: 'final' }),
      { initialProps: { enabled: false, done: true } }
    )

    expect(raf.callbacks.size).toBe(0)

    rerender({ enabled: true, done: false })

    expect(rafStub).toHaveBeenCalledTimes(1)
    expect(raf.callbacks.size).toBe(1)
  })

  it('cancels the pending stream and drops stale content across disable and re-enable', () => {
    const onUpdate = vi.fn()
    const { result, rerender } = renderHook(
      ({ enabled }) => useSmoothStream({ onUpdate, streamDone: false, enabled, minDelay: 0, initialText: '' }),
      { initialProps: { enabled: true } }
    )
    const pendingFrameId = [...raf.callbacks.keys()][0]
    const staleCallback = raf.callbacks.get(pendingFrameId)

    act(() => {
      result.current.addChunk('stale content')
    })

    act(() => {
      rerender({ enabled: false })
    })

    expect(cafStub).toHaveBeenCalledWith(pendingFrameId)
    expect(raf.callbacks.size).toBe(0)
    expect(onUpdate).not.toHaveBeenCalled()

    act(() => {
      rerender({ enabled: true })
    })

    const reenabledFrameId = [...raf.callbacks.keys()][0]
    expect(reenabledFrameId).not.toBe(pendingFrameId)
    expect(raf.callbacks.size).toBe(1)

    act(() => {
      staleCallback?.(1016)
    })
    expect(onUpdate).not.toHaveBeenCalled()

    act(() => {
      result.current.addChunk('fresh content')
    })
    advanceFrames(30)

    expect(onUpdate).toHaveBeenLastCalledWith('fresh content')
    expect(onUpdate.mock.calls.flat().every((call) => !String(call).includes('stale'))).toBe(true)
  })
})
