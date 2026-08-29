import React, { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import { RouteChunkLoadError } from './RouteChunkLoadError'
import RouteErrorFallback from './RouteErrorFallback'
import RouteLoadingFallback from './RouteLoadingFallback'

interface LazyRouteProps {
  importer: () => Promise<{ default: React.ComponentType<any> }>
}

export const LazyRoute: React.FC<LazyRouteProps> = ({ importer }) => {
  const [retryKey, setRetryKey] = useState(0)

  const wrappedImporter = useCallback(() => {
    return importer().catch((error: unknown) => {
      if (error instanceof RouteChunkLoadError) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new RouteChunkLoadError(message || 'Failed to load chunk', { cause: error })
    })
  }, [importer])

  const LazyComponent = useMemo(() => lazy(wrappedImporter), [wrappedImporter, retryKey])

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
