/**
 * Bounded position stabilizer: after a commit wait + rAF, re-align a target
 * offset while late layout (Markdown/images/divider inserts) settles.
 *
 * Contract:
 * - Reuses the viewport scroll token (`beginScroll('anchoring'/'programmatic')`).
 *   Target validity is owned by the caller's restore epoch
 *   (topic/route/unmount/generation) — never by `canHandleUserViewportScroll`,
 *   which is false while the token is held and would self-cancel.
 * - Cancellable: restore epoch invalidation, route/topic change, explicit user
 *   input cancel, unmount, or explicit cancel.
 * - Bounded: max deadline (default 1500ms) + quiet period; never holds the
 *   scroll long-term. After cancel/timeout no further compensation runs.
 * - No virtual list; only container scrollTop compensation + continuous rAF
 *   frames with a real ResizeObserver on the container AND the current target
 *   row. The observer callback re-measures and compensates immediately (it
 *   participates in the loop); the target is rebound safely when it changes.
 */

/** Pure decision: scroll delta needed to restore `targetOffset`. */
export const computeRestoreDelta = (currentOffset: number, targetOffset: number): number => currentOffset - targetOffset

/**
 * Pure restore-target validity: topic + route + mounted + this restore
 * generation still current. Deliberately independent of the viewport scroll
 * token: `beginScroll('anchoring'/'programmatic')` closes
 * `canHandleUserViewportScroll` by design, so consulting it here would
 * self-cancel every restore. Anchoring therefore keeps this true.
 */
export const isRestoreTargetValid = (input: {
  topicMatch: boolean
  routeMatch: boolean
  mounted: boolean
  epochCurrent: boolean
}): boolean => input.topicMatch && input.routeMatch && input.mounted && input.epochCurrent

/** Pure decision: whether a delta is worth compensating (|delta| > 1px). */
export const shouldCompensate = (delta: number): boolean => Math.abs(delta) > 1

/**
 * Precise single-frame suppression for programmatic `scrollTop += delta`.
 *
 * The old 80ms timestamp window swallowed genuine keyboard/scrollbar scrolls.
 * Suppression is now limited to synchronous/at-most-one-frame: each
 * `applyDelta` arms `{ expected, armed, generation }` with the post-apply
 * `scrollTop`, and `handleScroll` only suppresses when the observed scrollTop
 * still equals `expected` while armed. A next-frame or different-scrollTop
 * user scroll never matches and cancels instead. The arm is cleared on the
 * next animation frame (generation-guarded so newer arms survive).
 */
export interface StabilizerScrollSuppress {
  expected: number | null
  armed: boolean
  generation: number
}

export const createStabilizerScrollSuppress = (): StabilizerScrollSuppress => ({
  expected: null,
  armed: false,
  generation: 0
})

export const armStabilizerSuppress = (state: StabilizerScrollSuppress, expectedScrollTop: number): number => {
  state.expected = expectedScrollTop
  state.armed = true
  state.generation += 1
  return state.generation
}

export const disarmStabilizerSuppress = (state: StabilizerScrollSuppress, generation: number): void => {
  if (state.generation === generation) state.armed = false
}

export const isSelfInducedStabilizerScroll = (
  state: Pick<StabilizerScrollSuppress, 'expected' | 'armed'>,
  actualScrollTop: number
): boolean => state.armed && state.expected !== null && actualScrollTop === state.expected

/**
 * Keyboard scroll pre-cancel: ArrowUp/Down, PageUp/Down, Home/End, Space.
 * Input targets never cancel (INPUT/TEXTAREA/SELECT/contentEditable), and
 * modified keys (Ctrl/Meta/Alt) are ignored so shortcuts never miscancel.
 */
const STABILIZER_CANCEL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])

export const isStabilizerScrollKey = (key: string): boolean => STABILIZER_CANCEL_KEYS.has(key)

export interface StabilizerKeyModifiers {
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

const isEditableTarget = (target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean => {
  if (!target) return false
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable === true
}

export const shouldCancelStabilizerForKeyDown = (
  event: { key: string } & StabilizerKeyModifiers,
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined
): boolean => {
  if (!isStabilizerScrollKey(event.key)) return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (isEditableTarget(target)) return false
  return true
}

export interface StabilizerBudget {
  /** Hard deadline in ms (default 1500). */
  maxMs?: number
  /** Quiet period in ms with no compensation before finishing (default 120). */
  quietMs?: number
  /** Frame epsilon: deltas at/below this px are considered settled. */
  epsilonPx?: number
}

export interface StabilizerCallbacks {
  /** Current target offset (element top - container top), null when target missing. */
  getCurrentOffset: () => number | null
  /** Apply a scrollTop delta (positive = scroll down in offset terms). */
  applyDelta: (delta: number) => void
  /** True when stabilization must abort (route/topic/user-scroll/unmount). */
  isCancelled: () => boolean
}

export interface StabilizerHandle {
  cancel: () => void
  readonly done: Promise<'settled' | 'cancelled' | 'timeout'>
}

export interface StabilizerObserve {
  /** Resolve the current target row element; called per frame to rebind safely. */
  getTargetElement?: () => HTMLElement | null
}

/**
 * Pure frame-step controller (testable without DOM): given a sequence of
 * observed offsets, decide compensate/finish. `step` returns the delta to
 * apply (0 = settled this frame) and whether the budget is exhausted.
 */
export class OffsetStabilizerController {
  private cancelled = false
  private readonly startedAt: number
  private lastCompensateAt: number
  private readonly maxMs: number
  private readonly quietMs: number
  private readonly epsilonPx: number

  constructor(
    private readonly now: () => number = () => Date.now(),
    budget?: StabilizerBudget
  ) {
    this.maxMs = budget?.maxMs ?? 1500
    this.quietMs = budget?.quietMs ?? 120
    this.epsilonPx = budget?.epsilonPx ?? 1
    this.startedAt = this.now()
    this.lastCompensateAt = this.startedAt
  }

  cancel(): void {
    this.cancelled = true
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  isExpired(): boolean {
    return this.now() - this.startedAt >= this.maxMs
  }

  isQuiet(): boolean {
    return this.now() - this.lastCompensateAt >= this.quietMs
  }

  /**
   * One observation step. Returns `{ action: 'cancelled'|'timeout'|'quiet'|
   * 'compensate'|'watch', delta }`. `targetOffset` is the desired offset,
   * `currentOffset` null means the target row is missing (keep watching until
   * budget expires; never jump elsewhere).
   */
  step(targetOffset: number, currentOffset: number | null): { action: string; delta: number } {
    if (this.cancelled) return { action: 'cancelled', delta: 0 }
    if (this.isExpired()) return { action: 'timeout', delta: 0 }
    if (currentOffset === null) return { action: 'watch', delta: 0 }
    const delta = computeRestoreDelta(currentOffset, targetOffset)
    if (Math.abs(delta) <= this.epsilonPx) {
      return { action: this.isQuiet() ? 'quiet' : 'watch', delta: 0 }
    }
    this.lastCompensateAt = this.now()
    return { action: 'compensate', delta }
  }
}

/**
 * Run a bounded rAF + ResizeObserver stabilization loop. Holds no scroll
 * ownership itself — the caller must `beginScroll('anchoring')` before calling
 * and `scroll/end` after `done` settles. The loop compensates `scrollTop` so
 * the target stays at `targetOffset` until quiet, timeout, or cancellation.
 * The ResizeObserver watches the container AND the current target row; its
 * callback re-measures and compensates immediately (same controller budget),
 * and the target binding follows `observe.getTargetElement()` replacements.
 * Cleanup always disconnects the observer and cancels the pending frame.
 */
export const runBoundedPositionStabilizer = (
  container: HTMLElement,
  targetOffset: number,
  callbacks: StabilizerCallbacks,
  budget?: StabilizerBudget,
  observe?: StabilizerObserve
): StabilizerHandle => {
  const controller = new OffsetStabilizerController(undefined, budget)
  let rafId = 0
  let finished = false
  let resolveDone: (v: 'settled' | 'cancelled' | 'timeout') => void = () => {}
  const done = new Promise<'settled' | 'cancelled' | 'timeout'>((resolve) => {
    resolveDone = resolve
  })
  const compensateOnce = (): void => {
    if (finished) return
    if (callbacks.isCancelled() || controller.isCancelled) {
      finish('cancelled')
      return
    }
    const current = callbacks.getCurrentOffset()
    const s = controller.step(targetOffset, current)
    if (s.action === 'cancelled') {
      finish('cancelled')
      return
    }
    if (s.action === 'timeout') {
      finish('timeout')
      return
    }
    if (s.action === 'quiet') {
      finish('settled')
      return
    }
    if (s.action === 'compensate' && s.delta !== 0) {
      try {
        callbacks.applyDelta(s.delta)
      } catch {
        finish('cancelled')
        return
      }
    }
  }

  const finish = (v: 'settled' | 'cancelled' | 'timeout') => {
    if (finished) return
    finished = true
    try {
      ro.disconnect()
    } catch {}
    try {
      cancelAnimationFrame(rafId)
    } catch {}
    observedTarget = null
    resolveDone(v)
  }

  let observedTarget: HTMLElement | null = null
  const bindTarget = (): void => {
    if (!observe?.getTargetElement) return
    let next: HTMLElement | null = null
    try {
      next = observe.getTargetElement() ?? null
    } catch {
      next = null
    }
    if (next === observedTarget) return
    try {
      if (observedTarget) ro.unobserve(observedTarget)
    } catch {}
    observedTarget = next && next.isConnected ? next : null
    if (observedTarget) {
      try {
        ro.observe(observedTarget)
      } catch {}
    }
  }

  const ro: ResizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          // Real observation: container or target resize re-measures now.
          bindTarget()
          compensateOnce()
        })
      : ({ disconnect: () => {}, observe: () => {}, unobserve: () => {} } as unknown as ResizeObserver)
  try {
    ro.observe(container)
  } catch {}
  bindTarget()

  const tick = () => {
    if (finished) return
    bindTarget()
    compensateOnce()
    if (finished) return
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)

  return {
    cancel: () => {
      // Synchronous, idempotent settle: disconnect + cancel the pending frame
      // and resolve `done` immediately so unmount never hangs on a paused rAF.
      // `finish` guards with `finished`, so repeat cancels are no-ops with the
      // same `done` promise (single release counted by the caller).
      controller.cancel()
      finish('cancelled')
    },
    get done() {
      return done
    }
  }
}
