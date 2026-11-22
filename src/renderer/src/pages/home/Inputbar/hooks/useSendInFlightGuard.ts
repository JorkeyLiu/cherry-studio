import { useCallback, useRef } from 'react'

// Component-scoped in-flight guard for the Inputbar send action.
// `Inputbar.sendMessage` awaits `checkRateLimit` (a topic-activity DB read)
// and then awaits the send thunk handover (authoritative admission, never
// stream), which widens the rapid re-entry window: two activations while the
// first call is still awaiting would each build and dispatch their own user
// message. This guard serializes one send's preparation AND handover: it is
// acquired before the rate-limit await and released in a `finally` once the
// handover settles (rate-limit block, validation early return, error, or
// accepted/unaccepted admission alike). It never spans streaming: the thunk
// returns after queue admission, so back-to-back sends stay serialized
// without holding the guard for the assistant lifecycle.
// Implemented with `useRef` (not state): no re-render, no new Redux state,
// no button/loading UI change, no stale closure (the flag is read and set
// synchronously at call time), and no unmount issue (per-instance ref with
// no pending setState).
// `runSend` runs one send preparation+handover; returns `false` when a
// previous send is still preparing or awaiting admission (caller returns
// without side effects).
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
