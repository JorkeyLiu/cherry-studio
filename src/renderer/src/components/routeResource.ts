import React, { lazy } from 'react'

import { RouteChunkLoadError } from './RouteChunkLoadError'

export type RouteImporter = () => Promise<{ default: React.ComponentType<any> }>
export type RouteModule = { default: React.ComponentType<any> }

export interface RouteResource {
  /** Warm the JS module without mounting. Silent: never rejects, never caches preload-only failure. */
  preload: () => Promise<void>
  /** Synchronously return the resolved component when preload/render already succeeded, else null. */
  getResolvedComponent: () => React.ComponentType<any> | null
  /** Lazy identity sharing the same loading state as preload. */
  getLazyComponent: () => React.LazyExoticComponent<React.ComponentType<any>>
  /** Drop cached state so the next render performs a fresh load. */
  reset: () => void
}

interface ResourceState {
  promise: Promise<RouteModule> | null
  resolved: RouteModule | null
  lazyComponent: React.LazyExoticComponent<React.ComponentType<any>> | null
}

const resourceCache = new WeakMap<RouteImporter, RouteResource & { state: ResourceState; importer: RouteImporter }>()

const toChunkError = (error: unknown): RouteChunkLoadError => {
  if (error instanceof RouteChunkLoadError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RouteChunkLoadError(message || 'Failed to load chunk', { cause: error })
}

export const getRouteResource = (importer: RouteImporter): RouteResource => {
  const cached = resourceCache.get(importer)
  if (cached) {
    return cached
  }

  const state: ResourceState = { promise: null, resolved: null, lazyComponent: null }

  const ensurePromise = (): Promise<RouteModule> => {
    if (state.resolved) {
      return Promise.resolve(state.resolved)
    }
    if (state.promise) {
      return state.promise
    }
    const next = importer().then(
      (module) => {
        state.resolved = module
        return module
      },
      (error: unknown) => {
        throw toChunkError(error)
      }
    )
    state.promise = next
    return next
  }

  const resource = {
    state,
    importer,
    preload: (): Promise<void> => {
      return ensurePromise().then(
        () => {},
        () => {
          // Silent preload failure must not permanently cache the failure:
          // when no render has consumed the shared promise yet, drop it so a
          // later normal navigation performs a fresh import. When a render
          // already owns a lazy identity around the same promise, keep the
          // rejection so the existing route error UI still appears; retry
          // clears it via reset().
          if (!state.lazyComponent) {
            state.promise = null
          }
        }
      )
    },
    getResolvedComponent: (): React.ComponentType<any> | null => {
      return state.resolved?.default ?? null
    },
    getLazyComponent: (): React.LazyExoticComponent<React.ComponentType<any>> => {
      if (!state.lazyComponent) {
        state.lazyComponent = lazy(() => ensurePromise())
      }
      return state.lazyComponent
    },
    reset: (): void => {
      state.promise = null
      state.resolved = null
      state.lazyComponent = null
    }
  }

  resourceCache.set(importer, resource)
  return resource
}
