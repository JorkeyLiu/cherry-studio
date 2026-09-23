import React, { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import { RouteChunkLoadError } from './RouteChunkLoadError'
import RouteErrorFallback from './RouteErrorFallback'
import RouteLoadingFallback from './RouteLoadingFallback'

type RouteImporter = () => Promise<{ default: React.ComponentType<any> }>

interface LazyRouteProps {
  importer: RouteImporter
}

// Stable lazy identity per importer: the route fallback must appear only for
// the actual first module resolution. Without this cache every LazyRoute mount
// (each Chat -> Settings -> Chat navigation) creates a fresh lazy() identity
// that suspends again and flashes the fallback even though the chunk already
// resolved. The importer promise itself stays lazy (per-route bundle splitting
// unchanged); only the resolved React identity is reused across mounts. The
// cache is keyed on the original importer prop (stable module-level functions
// in Router), never on a per-mount wrapper.
const lazyComponentCache = new WeakMap<RouteImporter, React.LazyExoticComponent<React.ComponentType<any>>>()

const getCachedLazyComponent = (importer: RouteImporter): React.LazyExoticComponent<React.ComponentType<any>> => {
  let component = lazyComponentCache.get(importer)
  if (!component) {
    const wrappedImporter: RouteImporter = () =>
      importer().catch((error: unknown) => {
        if (error instanceof RouteChunkLoadError) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new RouteChunkLoadError(message || 'Failed to load chunk', { cause: error })
      })
    component = lazy(wrappedImporter)
    lazyComponentCache.set(importer, component)
  }
  return component
}

export const LazyRoute: React.FC<LazyRouteProps> = ({ importer }) => {
  const [retryKey, setRetryKey] = useState(0)

  const LazyComponent = useMemo(() => {
    if (retryKey > 0) {
      // Retry after a chunk failure must attempt a fresh resolution, so drop
      // the stale (rejected) identity; ordinary mounts reuse the cache.
      lazyComponentCache.delete(importer)
    }
    return getCachedLazyComponent(importer)
  }, [importer, retryKey])

  const handleReset = useCallback(() => {
    setRetryKey((k) => k + 1)
  }, [])

  return (
    <ErrorBoundary FallbackComponent={RouteErrorFallback} onReset={handleReset} resetKeys={[retryKey]}>
      <Suspense fallback={<RouteLoadingFallback />} key={retryKey}>
        <LazyComponent />
      </Suspense>
    </ErrorBoundary>
  )
}

export default LazyRoute
