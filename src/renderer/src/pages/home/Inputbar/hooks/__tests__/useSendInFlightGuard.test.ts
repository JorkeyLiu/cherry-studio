import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useSendInFlightGuard } from '../useSendInFlightGuard'

// ---------------------------------------------------------------------------
// Helper: a deferred promise resolved manually, so async overlap is
// deterministic: the first send stays parked in its rate-limit await while
// the second activation fires.
// ---------------------------------------------------------------------------
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Mirrors the Inputbar send preparation shape: an async rate-limit read
 * first, then the user-message build + send dispatch. Counting the rate-limit
 * read and the dispatch separately proves the audit claim (one read AND one
 * send dispatch per rapid double activation).
 */
function makeSend(rateLimitGate: Deferred<boolean>, onDispatch: () => void, opts?: { blocked?: boolean }) {
  const rateLimitRead = vi.fn(() => rateLimitGate.promise)
  const dispatchSend = vi.fn(() => {
    onDispatch()
  })
  const send = vi.fn(async () => {
    if (await rateLimitRead()) {
      return
    }
    if (opts?.blocked) {
      throw new Error('should not reach dispatch')
    }
    dispatchSend()
  })
  return { send, rateLimitRead, dispatchSend }
}

describe('useSendInFlightGuard — Inputbar rapid re-entry', () => {
  it('two concurrent sends produce one rate-limit read and one send dispatch; the loser is a no-op', async () => {
    const { result } = renderHook(() => useSendInFlightGuard())
    const gate = deferred<boolean>()
    let dispatchCount = 0
    const { send, rateLimitRead, dispatchSend } = makeSend(gate, () => dispatchCount++)

    let first: Promise<boolean> | undefined
    await act(async () => {
      first = result.current.runSend(send)
      // Let the first send reach its rate-limit await before re-entering.
      await Promise.resolve()
      await Promise.resolve()
    })

    let second: Promise<boolean> | undefined
    await act(async () => {
      second = result.current.runSend(send)
    })

    // The second activation must have been rejected synchronously, without
    // touching the rate-limit read or the dispatch.
    await expect(second).resolves.toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(rateLimitRead).toHaveBeenCalledTimes(1)
    expect(dispatchSend).not.toHaveBeenCalled()

    // Release the first send's rate-limit await (allowed) and let it dispatch.
    await act(async () => {
      gate.resolve(false)
      await first
    })

    await expect(first).resolves.toBe(true)
    expect(rateLimitRead).toHaveBeenCalledTimes(1)
    expect(dispatchSend).toHaveBeenCalledTimes(1)
    expect(dispatchCount).toBe(1)
  })

  it('a rate-limit-blocked send releases the guard for a later send', async () => {
    const { result } = renderHook(() => useSendInFlightGuard())
    const dispatchSend = vi.fn()

    let blocked: Promise<boolean> | undefined
    await act(async () => {
      blocked = result.current.runSend(async () => {
        if (await Promise.resolve(true)) {
          return
        }
        dispatchSend()
      })
      await blocked
    })

    await expect(blocked).resolves.toBe(true)
    expect(dispatchSend).not.toHaveBeenCalled()

    // The guard must not stay locked after the block: a later send runs.
    let later: Promise<boolean> | undefined
    await act(async () => {
      later = result.current.runSend(async () => {
        dispatchSend()
      })
      await later
    })

    await expect(later).resolves.toBe(true)
    expect(dispatchSend).toHaveBeenCalledTimes(1)
  })

  it('an errored send releases the guard for a later send', async () => {
    const { result } = renderHook(() => useSendInFlightGuard())
    const dispatchSend = vi.fn()

    let failed: Promise<boolean> | undefined
    await act(async () => {
      failed = result.current.runSend(async () => {
        await Promise.resolve()
        throw new Error('upload failed')
      })
      await expect(failed).rejects.toThrow('upload failed')
    })

    let later: Promise<boolean> | undefined
    await act(async () => {
      later = result.current.runSend(async () => {
        dispatchSend()
      })
      await later
    })

    await expect(later).resolves.toBe(true)
    expect(dispatchSend).toHaveBeenCalledTimes(1)
  })

  it('sequential sends are not serialized across the streaming lifecycle: a send after completion runs', async () => {
    const { result } = renderHook(() => useSendInFlightGuard())
    const dispatchSend = vi.fn()

    await act(async () => {
      await expect(result.current.runSend(async () => void dispatchSend())).resolves.toBe(true)
    })
    await act(async () => {
      await expect(result.current.runSend(async () => void dispatchSend())).resolves.toBe(true)
    })

    // Both preparations ran; the guard only ever covered one preparation.
    expect(dispatchSend).toHaveBeenCalledTimes(2)
  })
})
