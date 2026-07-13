import { describe, expect, it, vi } from 'vitest'

import { throttle } from '../throttle'

describe('throttle', () => {
  it('should invoke at most once per time window for rapid calls', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const throttled = throttle(fn, 16)

    for (let i = 0; i < 100; i++) {
      throttled()
    }

    // First call is immediate
    expect(fn).toHaveBeenCalledTimes(1)

    // Fast-forward past the single trailing timeout
    vi.advanceTimersByTime(16)
    expect(fn).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('should execute only once within a 16ms window', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const throttled = throttle(fn, 16)

    throttled() // t=0
    throttled() // t=0, same window
    throttled() // t=0, same window
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(8)
    throttled() // t=8, still within window → no extra call yet
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(8)
    // t=16, trailing timer fires
    expect(fn).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('should execute again after the throttle window passes', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const throttled = throttle(fn, 16)

    throttled() // t=0 → immediate
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(20) // t=20 > 16
    throttled() // new window → immediate
    expect(fn).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('should pass arguments correctly', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const throttled = throttle(fn, 16)

    throttled('a', 1)
    expect(fn).toHaveBeenCalledWith('a', 1)

    vi.advanceTimersByTime(20)
    throttled('b', 2)
    expect(fn).toHaveBeenCalledWith('b', 2)

    vi.useRealTimers()
  })

  it('should not schedule multiple trailing timers', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const throttled = throttle(fn, 16)

    throttled() // t=0
    throttled() // t=0 → schedule trailing at +16
    throttled() // t=0 → already has trailing timer, skip

    vi.advanceTimersByTime(16)
    // Only 1 trailing call
    expect(fn).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('should use the last arguments for trailing call', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const throttled = throttle(fn, 16)

    throttled('first', 1) // t=0 → immediate
    throttled('second', 2) // t=0 → schedule trailing, stores args
    throttled('third', 3) // t=0 → updates trailing args to latest

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('first', 1)

    vi.advanceTimersByTime(16)
    expect(fn).toHaveBeenCalledTimes(2)
    // Trailing call should use the last arguments, not the first
    expect(fn).toHaveBeenLastCalledWith('third', 3)

    vi.useRealTimers()
  })
})
