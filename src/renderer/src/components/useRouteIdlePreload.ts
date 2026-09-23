import { useEffect } from 'react'

import type { RouteImporter } from './routeResource'
import { getRouteResource } from './routeResource'
import { scheduleIdleCallback } from './scheduleIdleCallback'

// Schedule a cancellable idle preload once the caller reports stability
// (chat first-update window). Fire-and-forget: never awaited, never in the
// startup critical path. Clearing enabled/unmount cancels a pending idle task.
export const useRouteIdlePreload = (importer: RouteImporter, enabled: boolean): void => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const resource = getRouteResource(importer)
    const cancel = scheduleIdleCallback(() => {
      void resource.preload()
    })
    return cancel
  }, [importer, enabled])
}
