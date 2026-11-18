/**
 * Fold browse motion driver: JS-owned space with synchronous keeper settlement.
 *
 * Root cause it replaces: the browse space used to be a CSS keyframe height
 * animation whose completion was observed through `getAnimations().finished`,
 * while the route viewport keeper only settled through its own async
 * ResizeObserver loop. The intermediate layout the browser painted between a
 * height step and the keeper's late hold was exposed to native hit-testing,
 * so a pointer resting on the fold label/rail could fall through to a message
 * row mid-gesture (label -> message -> label).
 *
 * Contract of this driver:
 * - The driver owns ONLY the container's inline `height` for the lifetime of
 *   one motion. React never writes that property (the component's `style`
 *   prop carries CSS variables for the fade only), so React and the driver
 *   never fight over it.
 * - Every height write is followed SYNCHRONOUSLY, in the same frame callback,
 *   by `onSettledLayout` — the caller wires that to the existing keeper hold
 *   (`settleLayout` command -> `maintainer.requestHold`), so no painted frame
 *   ever shows an unabsorbed intermediate layout.
 * - Completion comes from the driver's own promise (the last frame wrote the
 *   exact endpoint), never from `getAnimations().finished` and never from a
 *   timer. The body fade rides the same time base in CSS and lands together.
 * - `cancel()` drops the pending frame and the `finished` promise NEVER
 *   settles afterwards, so a superseded motion (inverse flip, unmount) can
 *   never write a stale state.
 * - Pure and DOM-narrow: no measuring (the caller measures live geometry),
 *   no React state, no timers, no polling. The frame clock is injectable so
 *   tests drive it deterministically.
 */

export const FOLD_BROWSE_MOTION_MS = 200

/**
 * CSS `cubic-bezier(0.65, 0, 0.35, 1)` as a JS easing function: the exact
 * curve the old CSS space animation used, so the motion keeps its 200ms
 * feel while the heights are written by JS first.
 */
export function createCubicBezierEasing(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  // CSS cubic-bezier semantics: x(s) is monotonic for x1/x2 in [0, 1], so
  // invert x(s) = t with Newton-Raphson plus a bisection fallback, then
  // evaluate y(s). Constants follow the WebKit/CSS reference solver.
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s
  const sampleDerivativeX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx
  const solveX = (t: number): number => {
    let s = t
    for (let i = 0; i < 8; i++) {
      const error = sampleX(s) - t
      if (Math.abs(error) < 1e-6) return s
      const slope = sampleDerivativeX(s)
      if (Math.abs(slope) < 1e-6) break
      s -= error / slope
    }
    let lo = 0
    let hi = 1
    s = t
    while (lo < hi) {
      const value = sampleX(s)
      if (Math.abs(value - t) < 1e-6) return s
      if (value < t) lo = s
      else hi = s
      s = (lo + hi) / 2
      if (hi - lo < 1e-7) break
    }
    return s
  }
  return (t: number): number => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    return sampleY(solveX(t))
  }
}

/** The space curve the fold browse motion has always used. */
export const foldBrowseSpaceEasing: (t: number) => number = createCubicBezierEasing(0.65, 0, 0.35, 1)

/** Frame clock. Defaults resolve lazily to the globals so tests can stub them. */
export interface FoldBrowseMotionScheduler {
  requestFrame: (callback: (now: number) => void) => number
  cancelFrame: (handle: number) => void
  now: () => number
}

export interface FoldBrowseMotionOptions {
  /** Motion window; defaults to {@link FOLD_BROWSE_MOTION_MS}. */
  durationMs?: number
  /** Progress curve; defaults to {@link foldBrowseSpaceEasing}. */
  easing?: (progress: number) => number
  /** Frame clock; defaults to the global rAF pair. */
  scheduler?: FoldBrowseMotionScheduler
  /**
   * Called synchronously after EVERY height write (first write included),
   * before the frame callback returns. The caller settles the existing
   * keeper here; the driver itself never touches keeper/controller state.
   */
  onSettledLayout?: () => void
}

export interface FoldBrowseMotionHandle {
  /**
   * Resolves once, right after the exact endpoint was written and settled.
   * Never resolves after `cancel()` — a superseded motion leaves no
   * completion behind, so no stale state can be written from it.
   */
  readonly finished: Promise<void>
  cancel: () => void
}

const resolveScheduler = (override?: FoldBrowseMotionScheduler): FoldBrowseMotionScheduler | null => {
  if (override) return override
  try {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      const raf = window.requestAnimationFrame.bind(window)
      const cancel =
        typeof window.cancelAnimationFrame === 'function'
          ? window.cancelAnimationFrame.bind(window)
          : (_handle: number): void => undefined
      const now = (): number => {
        try {
          if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
        } catch {}
        return Date.now()
      }
      return { requestFrame: raf, cancelFrame: cancel, now }
    }
  } catch {}
  return null
}

/**
 * Drive `target`'s inline height from `fromPx` to `toPx`, settling the
 * existing layout keeper synchronously after every write.
 *
 * Degenerate inputs settle immediately with no frames: a null target, a
 * non-finite endpoint, or `fromPx === toPx` resolves `finished` right away
 * (writing the endpoint + one settlement when there is a target to settle).
 */
export function runFoldBrowseMotion(
  target: HTMLElement | null,
  fromPx: number,
  toPx: number,
  options: FoldBrowseMotionOptions = {}
): FoldBrowseMotionHandle {
  const settle = (): void => {
    try {
      options.onSettledLayout?.()
    } catch {}
  }
  const write = (element: HTMLElement, heightPx: number): void => {
    element.style.height = `${heightPx}px`
    settle()
  }
  // Frame + completion state. `finishedResolve` is null once resolved or
  // cancelled: the single flag that makes a superseded motion's late frame
  // a no-op and its promise permanently pending, so no stale state can be
  // written from it. `cancel()` invalidates first, so even an already-queued
  // frame callback that still runs must neither write nor resolve.
  let frame: number | null = null
  let finishedResolve: (() => void) | null = null
  const finished = new Promise<void>((resolve) => {
    finishedResolve = resolve
  })
  const finish = (): void => {
    const resolve = finishedResolve
    finishedResolve = null
    frame = null
    if (resolve) resolve()
  }
  if (!target || !Number.isFinite(fromPx) || !Number.isFinite(toPx)) {
    return { finished: Promise.resolve(), cancel: () => undefined }
  }
  if (fromPx === toPx) {
    write(target, toPx)
    return { finished: Promise.resolve(), cancel: () => undefined }
  }
  const element = target
  const scheduler = resolveScheduler(options.scheduler)
  const durationMs = options.durationMs ?? FOLD_BROWSE_MOTION_MS
  const easing = options.easing ?? foldBrowseSpaceEasing
  if (!scheduler || !Number.isFinite(durationMs) || durationMs <= 0) {
    write(element, toPx)
    return { finished: Promise.resolve(), cancel: () => undefined }
  }
  const handle: FoldBrowseMotionHandle = {
    finished,
    cancel: () => {
      finishedResolve = null
      if (frame !== null) {
        const pending = frame
        frame = null
        try {
          scheduler.cancelFrame(pending)
        } catch {}
      }
    }
  }
  const start = scheduler.now()
  const step = (now: number): void => {
    frame = null
    if (finishedResolve === null) return
    const elapsed = now - start
    const progress = elapsed >= durationMs ? 1 : elapsed <= 0 ? 0 : elapsed / durationMs
    if (progress >= 1) {
      write(element, toPx)
      finish()
      return
    }
    let eased = progress
    try {
      eased = easing(progress)
    } catch {}
    if (!Number.isFinite(eased)) eased = progress
    write(element, fromPx + (toPx - fromPx) * eased)
    try {
      frame = scheduler.requestFrame(step)
    } catch {
      frame = null
      if (finishedResolve !== null) {
        write(element, toPx)
        finish()
      }
    }
  }
  // First write commits synchronously in the caller's pre-paint pass: the
  // box leaves from exactly the measured live height, never from an endpoint.
  write(element, fromPx)
  try {
    frame = scheduler.requestFrame(step)
  } catch {
    frame = null
    write(element, toPx)
    finish()
  }
  return handle
}
