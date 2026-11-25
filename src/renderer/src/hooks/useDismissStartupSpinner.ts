import { useEffect } from 'react'

/**
 * Release the static HTML startup overlay once React has committed its first
 * presentation. The ordinary app and the fresh-bootstrap readiness gate share
 * this lifecycle so a blocked chat tree never leaves the overlay intercepting
 * pointer events on the loading or retry surface.
 */
export function useDismissStartupSpinner(): void {
  useEffect(() => {
    document.getElementById('spinner')?.remove()
  }, [])
}
