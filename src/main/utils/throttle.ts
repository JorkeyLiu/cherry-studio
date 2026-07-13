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
  let lastThis: any = null

  return function (this: any, ...args: Parameters<T>) {
    const now = Date.now()
    lastArgs = args
    // eslint-disable-next-line typescript-eslint/no-this-alias
    lastThis = this

    if (now - lastCall >= ms) {
      lastCall = now
      fn.apply(this, args)
    } else if (!timer) {
      timer = setTimeout(
        () => {
          lastCall = Date.now()
          timer = null
          if (lastArgs) {
            fn.apply(lastThis, lastArgs)
            lastArgs = null
            lastThis = null
          }
        },
        ms - (now - lastCall)
      )
    }
  }
}
