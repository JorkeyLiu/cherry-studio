// Cancellable browser-idle scheduler. Prefers requestIdleCallback; falls back
// to an async setTimeout in runtimes/tests without the API. Never forces
// execution with a timeout while busy.
export const scheduleIdleCallback = (callback: () => void): (() => void) => {
  const scope = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof scope.requestIdleCallback === 'function') {
    const id = scope.requestIdleCallback(callback)
    return () => {
      try {
        if (typeof scope.cancelIdleCallback === 'function') {
          scope.cancelIdleCallback(id)
        }
      } catch {
        // Ignore cancellation races on teardown.
      }
    }
  }
  const timeoutId = setTimeout(callback, 0)
  return () => clearTimeout(timeoutId)
}
