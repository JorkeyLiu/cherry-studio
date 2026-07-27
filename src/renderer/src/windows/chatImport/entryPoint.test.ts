import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withTimeout } from './entryPoint'

/**
 * Focused tests for the deterministic page-read timeout helper.
 *
 * These verify that the losing timeout can never leak an unhandled rejection
 * or a pending timer, while preserving the existing 120s timeout error
 * semantics used by handleReadPage.
 */
describe('withTimeout', () => {
  const TIMEOUT_MS = 120_000
  const TIMEOUT_MESSAGE = `Page read timed out after ${TIMEOUT_MS}ms`

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('resolves with the operation value before the timeout and clears the timer', async () => {
    const result = await withTimeout(Promise.resolve('page-data'), TIMEOUT_MS, TIMEOUT_MESSAGE)

    expect(result).toBe('page-data')
    // Timer must be cleared once the operation wins (LOCK-R1: success clears timeout).
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects with the operation error before the timeout and clears the timer', async () => {
    const failure = new Error('read failed')

    await expect(withTimeout(Promise.reject(failure), TIMEOUT_MS, TIMEOUT_MESSAGE)).rejects.toBe(failure)
    // Timer must be cleared on failure (LOCK-R1: read failure clears timeout).
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects once with the diagnostic timeout error when the operation never settles', async () => {
    // A never-settling operation forces the timeout branch to win.
    const never = new Promise<string>(() => {})
    const raced = withTimeout(never, TIMEOUT_MS, TIMEOUT_MESSAGE)
    const assertion = expect(raced).rejects.toThrow(TIMEOUT_MESSAGE)

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await assertion

    // Timeout fired exactly once; nothing else is pending.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no pending timer or unhandled rejection after a successful read', async () => {
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)

    try {
      await withTimeout(Promise.resolve('ok'), TIMEOUT_MS, TIMEOUT_MESSAGE)

      // Advancing well past the timeout must not fire the (already-cleared) timer.
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2)
      // Flush any pending microtasks so a stray rejection would surface.
      await Promise.resolve()

      expect(vi.getTimerCount()).toBe(0)
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
