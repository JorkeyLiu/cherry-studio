/**
 * Creates a throttled function that only invokes `fn` at most once per `ms` milliseconds.
 *
 * Uses a trailing call to ensure the last invocation is not lost.
 */
export function throttle<T extends (...args: any[]) => any>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let lastCall = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  return function (this: any, ...args: Parameters<T>) {
    const now = Date.now()
    if (now - lastCall >= ms) {
      lastCall = now
      fn.apply(this, args)
    } else if (!timer) {
      timer = setTimeout(
        () => {
          lastCall = Date.now()
          timer = null
          fn.apply(this, args)
        },
        ms - (now - lastCall)
      )
    }
  }
}
