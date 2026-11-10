/**
 * Frame-ordered publication wait for the ordinary user edge page.
 *
 * Why it exists: the ordinary `older` page resolves its fetch and commits the
 * merged window inside the same task that received the response, i.e. inside a
 * scroll-echo task. Everything downstream of that commit (projection growth,
 * stable-anchor keeper hold, the user's own continuing momentum) then competes
 * for the very next paint. This helper lets ONE entry — the ordinary user edge
 * in the `older` direction — wait for one animation frame after the response
 * has passed every state-dependent guard and before the instant precommit
 * capture, so the growth is committed in a frame the user actually paints.
 *
 * It owns no lifecycle of its own. The page attempt keeps its resource identity
 * exactly where it already lives (`loading[direction]`, the token-scoped fetch
 * lease, the attempt handle); this helper only holds ONE queued frame per
 * attempt and settles deterministically (`frame` / `hidden` / `cancelled`).
 * There is deliberately no timer: a hidden document never publishes late, and
 * the caller abandons that page instead (see `awaitOrdinaryPageFrame`).
 *
 * Cancellation is the existing one: every cancel entry (`cancelActiveLoads`,
 * which is reached by unmount, route change and deletion fallback) calls
 * `cancelAll()`, which cancels the queued frame and settles `cancelled`, so a
 * cancelled attempt can never publish its response afterwards.
 */

/** Which entry started a window page. Only the ordinary user edge opts in. */
export type PaginationPageOrigin = 'shared' | 'ordinary-user-edge'

/** Direction of the window page (mirrors the viewport load direction). */
export type PaginationFrameDirection = 'older' | 'newer'

export type PaginationFrameWaitOutcome = 'frame' | 'hidden' | 'cancelled'

/** The effect of the frame step on the page attempt. */
export type OrdinaryPageFrameStep =
  /** Not an opted-in entry: the attempt continues synchronously as before. */
  | { step: 'not-required' }
  /** The frame was reached and ownership still holds: continue to the precommit. */
  | { step: 'frame' }
  /** Nothing may be published; the caller abandons (release + load/cancel). */
  | { step: 'abandon'; reason: 'hidden' | 'cancelled' | 'superseded' }

/**
 * Only the ordinary user edge in the `older` direction is frame-ordered.
 * Restore-owned (divider search), selection-boundary, route-transition and
 * every `newer` page keep their existing synchronous publication path.
 */
export function isFrameOrderedPublicationOrigin(
  origin: PaginationPageOrigin,
  direction: PaginationFrameDirection
): boolean {
  return origin === 'ordinary-user-edge' && direction === 'older'
}

export interface PaginationFrameWaitDeps {
  /** Schedule one frame; `null` when the environment has no frame source. */
  requestFrame: (callback: () => void) => number | null
  cancelFrame: (handle: number) => void
  /** Whether the document is currently hidden (no frames will be painted). */
  isHidden: () => boolean
  /** Subscribe to "the document became hidden"; returns the unsubscribe. */
  subscribeHidden: (listener: () => void) => () => void
}

export interface PaginationFrameWait {
  /** Wait one frame; resolves exactly once with the outcome. */
  wait: (signal?: AbortSignal) => Promise<PaginationFrameWaitOutcome>
  /** Cancel every queued wait (a cancelled frame never runs). */
  cancelAll: () => void
  /** Queued waits that have not settled yet. */
  pendingCount: () => number
}

const noop = (): void => {}

const defaultIsHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'

const defaultRequestFrame = (callback: () => void): number | null =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => callback()) : null

const defaultCancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
}

export function createPaginationFrameWait(overrides: Partial<PaginationFrameWaitDeps> = {}): PaginationFrameWait {
  const deps: PaginationFrameWaitDeps = {
    requestFrame: defaultRequestFrame,
    cancelFrame: defaultCancelFrame,
    isHidden: defaultIsHidden,
    subscribeHidden: noop as () => () => void,
    ...overrides
  }
  // The default subscription asks the RESOLVED `isHidden` so an injected
  // visibility predicate stays coherent with the change notification.
  const subscribeHidden =
    overrides.subscribeHidden ??
    ((listener: () => void): (() => void) => {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return noop
      const onChange = (): void => {
        if (deps.isHidden()) listener()
      }
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    })

  interface Waiter {
    done: boolean
    settle: (outcome: PaginationFrameWaitOutcome) => void
    detach: () => void
  }

  const waiters = new Set<Waiter>()

  const finish = (waiter: Waiter, outcome: PaginationFrameWaitOutcome): void => {
    if (waiter.done) return
    waiter.done = true
    waiters.delete(waiter)
    waiter.detach()
    waiter.settle(outcome)
  }

  const wait = (signal?: AbortSignal): Promise<PaginationFrameWaitOutcome> =>
    new Promise((resolve) => {
      const waiter: Waiter = { done: false, settle: resolve, detach: noop }
      // Already-cancelled attempt: never register a frame.
      if (signal?.aborted) {
        finish(waiter, 'cancelled')
        return
      }
      // Hidden before the wait: no frame will paint, so do not register one and
      // do not publish late through any other channel.
      if (deps.isHidden()) {
        finish(waiter, 'hidden')
        return
      }

      waiters.add(waiter)
      const detachers: Array<() => void> = []
      const onAbort = (): void => finish(waiter, 'cancelled')
      if (signal) {
        signal.addEventListener('abort', onAbort)
        detachers.push(() => signal.removeEventListener('abort', onAbort))
      }

      let frame: number | null = null
      let unsubscribeHidden: (() => void) | null = null
      waiter.detach = () => {
        if (frame !== null) {
          deps.cancelFrame(frame)
          frame = null
        }
        if (unsubscribeHidden) {
          unsubscribeHidden()
          unsubscribeHidden = null
        }
        for (const detach of detachers.splice(0)) detach()
      }

      const handle = deps.requestFrame(() => finish(waiter, 'frame'))
      if (waiter.done) {
        // Settled inside the scheduler (never the case for a real frame source):
        // do not keep a frame we cannot use.
        if (handle !== null) deps.cancelFrame(handle)
        return
      }
      if (handle === null) {
        // No frame source: fail closed rather than publishing without a frame.
        finish(waiter, 'cancelled')
        return
      }
      frame = handle
      unsubscribeHidden = subscribeHidden(() => finish(waiter, 'hidden'))
      // A hidden notification delivered synchronously by the subscription is
      // already accounted for by `finish`; nothing else to disarm here.
    })

  return {
    wait,
    cancelAll: () => {
      for (const waiter of Array.from(waiters)) finish(waiter, 'cancelled')
    },
    pendingCount: () => waiters.size
  }
}

/**
 * Run the frame step for one window page attempt.
 *
 * Placement contract (enforced by the caller): the fetch has resolved, the
 * state-dependent applicability guards and the response guards have passed, and
 * the instant precommit capture has NOT yet happened. `stillApplicable` is the
 * caller's own re-proof of those guards and is evaluated again after the wait,
 * because the wait yields to a frame.
 */
export async function awaitOrdinaryPageFrame(options: {
  origin: PaginationPageOrigin
  direction: PaginationFrameDirection
  gate: PaginationFrameWait
  stillApplicable: () => boolean
  signal?: AbortSignal
}): Promise<OrdinaryPageFrameStep> {
  if (!isFrameOrderedPublicationOrigin(options.origin, options.direction)) return { step: 'not-required' }
  const outcome = await options.gate.wait(options.signal)
  if (outcome !== 'frame') return { step: 'abandon', reason: outcome }
  if (!options.stillApplicable()) return { step: 'abandon', reason: 'superseded' }
  return { step: 'frame' }
}
