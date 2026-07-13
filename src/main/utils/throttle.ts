/**
 * Creates a throttled function that only invokes `fn` at most once per `ms` milliseconds.
 *
 * Uses a trailing call to ensure the last invocation is not lost.
 * The trailing call uses the most recent arguments from within the throttle window.
 */
export function throttle<T extends (...args: any[]) => any>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let lastCall = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: Parameters<T> | null = null
  let lastBoundFn: ((...args: any[]) => any) | null = null

  return function (this: any, ...args: Parameters<T>) {
    const now = Date.now()
    lastArgs = args
    lastBoundFn = fn.bind(this)

    if (now - lastCall >= ms) {
      lastCall = now
      fn.apply(this, args)
    } else if (!timer) {
      timer = setTimeout(
        () => {
          lastCall = Date.now()
          timer = null
          if (lastArgs && lastBoundFn) {
            lastBoundFn(...lastArgs)
            lastArgs = null
            lastBoundFn = null
          }
        },
        ms - (now - lastCall)
      )
    }
  }
}
