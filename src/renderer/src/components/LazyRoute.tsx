import React, { Suspense, useCallback, useMemo, useState } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import RouteErrorFallback from './RouteErrorFallback'
import RouteLoadingFallback from './RouteLoadingFallback'
import type { RouteImporter } from './routeResource'
import { getRouteResource } from './routeResource'

interface LazyRouteProps {
  importer: RouteImporter
}

// Route-resource rendering: preload and render share one loading state per
// importer. A successfully preloaded module renders synchronously without
// entering the Suspense fallback; ordinary mounts reuse the same lazy
// identity so the fallback appears only for the actual first resolution.
// The importer promise itself stays lazy (per-route bundle splitting
// unchanged). Preload-only failures are dropped silently by the resource so
// later navigation retries fresh; render failures keep the rejected identity
// until retry explicitly resets for a fresh load.

export const LazyRoute: React.FC<LazyRouteProps> = ({ importer }) => {
  const [retryKey, setRetryKey] = useState(0)

  const { ResolvedComponent, LazyComponent } = useMemo(() => {
    const resource = getRouteResource(importer)
    if (retryKey > 0) {
      // Retry after a chunk failure must attempt a fresh resolution, so drop
      // the stale (rejected) identity; ordinary mounts reuse the cache.
      resource.reset()
    }
    const resolved = resource.getResolvedComponent()
    if (resolved) {
      return { ResolvedComponent: resolved, LazyComponent: null }
    }
    return { ResolvedComponent: null, LazyComponent: resource.getLazyComponent() }
  }, [importer, retryKey])

  const handleReset = useCallback(() => {
    setRetryKey((k) => k + 1)
  }, [])

  return (
    <ErrorBoundary FallbackComponent={RouteErrorFallback} onReset={handleReset} resetKeys={[retryKey]}>
      <Suspense fallback={<RouteLoadingFallback />} key={retryKey}>
        {ResolvedComponent ? <ResolvedComponent /> : LazyComponent ? <LazyComponent /> : null}
      </Suspense>
    </ErrorBoundary>
  )
}

export default LazyRoute
