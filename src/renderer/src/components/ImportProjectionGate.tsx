/**
 * ImportProjectionGate — gates the ordinary chat tree on the one-shot L2
 * navigation projection readiness (LOCK-001, LOCK-PROJECTION).
 *
 * The stale redux-persist navigation must NOT mount Home/useActiveTopic and
 * call Main `fetchMessages` (topic priming) before
 * `applyPendingImportProjection` has replaced/flushed/acked the imported
 * navigation. This gate renders NO children until the import projection
 * readiness settles successfully (`importProjectionReadiness`); while
 * pending or after a failure it renders nothing, so the ordinary chat tree
 * stays unmounted and no stale topic load can occur. A failure leaves the
 * pending row unacked for next-startup retry (no infinite retry here).
 *
 * Placement: INSIDE `CatalogHandoffBoundary` (in App.tsx), because the
 * catalog recovery handler must still register at App mount in every window
 * (LOCK-BRIDGE-1 handshake) — the gate only blocks the ordinary
 * TopViewContainer/Router tree.
 *
 * `null` loading is deliberate and testable: this boot window is normally a
 * few IPC round-trips (read → replace-all dispatch → flush → ack), and a
 * blank frame is safer than any flash of stale navigation.
 */

import { useEffect, useState } from 'react'

import { isImportProjectionReady, subscribeImportProjectionReadiness } from '../services/importProjectionReadiness'

/**
 * React view of the import projection readiness singleton. `true` only after
 * the projection has safely settled (applied or verified no-pending).
 */
export function useImportProjectionReadiness(): boolean {
  const [ready, setReady] = useState<boolean>(() => isImportProjectionReady())

  useEffect(() => {
    if (ready) {
      return
    }
    const unsubscribe = subscribeImportProjectionReadiness(() => {
      setReady(isImportProjectionReady())
    })
    // Re-read in case readiness settled between the initial render and the
    // effect subscription.
    setReady(isImportProjectionReady())
    return unsubscribe
  }, [ready])

  return ready
}

export function ImportProjectionGate({ children }: { children: React.ReactNode }) {
  const ready = useImportProjectionReadiness()
  if (!ready) {
    return null
  }
  return <>{children}</>
}

export default ImportProjectionGate
