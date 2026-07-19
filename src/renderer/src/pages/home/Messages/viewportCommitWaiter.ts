export type ViewportCommitMatcher<T> = (committedState: T) => boolean | null

interface PendingCommit<T> {
  matcher: ViewportCommitMatcher<T>
  resolve: (committed: boolean) => void
}

export interface ViewportCommitWaiter<T> {
  wait: (committedState: T, matcher: ViewportCommitMatcher<T>) => Promise<boolean>
  notify: (committedState: T) => void
  cancelAll: () => void
}

export const createViewportCommitWaiter = <T>(): ViewportCommitWaiter<T> => {
  const pending = new Set<PendingCommit<T>>()

  const settle = (waiter: PendingCommit<T>, committed: boolean) => {
    pending.delete(waiter)
    waiter.resolve(committed)
  }

  return {
    wait(committedState, matcher) {
      const result = matcher(committedState)
      if (result !== null) return Promise.resolve(result)

      return new Promise<boolean>((resolve) => {
        pending.add({ matcher, resolve })
      })
    },
    notify(committedState) {
      for (const waiter of pending) {
        const result = waiter.matcher(committedState)
        if (result !== null) settle(waiter, result)
      }
    },
    cancelAll() {
      for (const waiter of pending) settle(waiter, false)
    }
  }
}
