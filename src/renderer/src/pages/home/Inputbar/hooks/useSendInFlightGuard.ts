import { useCallback, useRef } from 'react'

/**
 * Component-scoped in-flight guard for the Inputbar send action.
 *
 * `Inputbar.sendMessage` awaits `checkRateLimit` (a topic-activity DB read)
 * before building the user message, which widens a rapid re-entry window:
 * two activations while the first call is still awaiting would each build and
 * dispatch their own user message. This guard serializes one send
 * invocation's synchronous/async *preparation* only — it is acquired before
 * the rate-limit await and released in a `finally` once preparation settles
 * (rate-limit block, validation early return, error, or dispatch initiation).
 * The send thunk itself is fire-and-forget (`void dispatch(...)`), so the
 * guard is never held for the full assistant streaming lifecycle.
 *
 * Implemented with `useRef` (not state): no re-render, no new Redux state,
 * no button/loading UI change, no stale closure (the flag is read and set
 * synchronously at call time), and no unmount issue (per-instance ref with
 * no pending setState).
 *
 * @returns `runSend` — runs one send preparation; returns `false` when a
 * previous send is still preparing (caller returns without side effects).
 */
export function useSendInFlightGuard(): {
  runSend: (send: () => Promise<void>) => Promise<boolean>
} {
  const inFlightRef = useRef(false)

  const runSend = useCallback(async (send: () => Promise<void>): Promise<boolean> => {
    if (inFlightRef.current) {
      return false
    }
    inFlightRef.current = true
    try {
      await send()
    } finally {
      inFlightRef.current = false
    }
    return true
  }, [])

  return { runSend }
}
