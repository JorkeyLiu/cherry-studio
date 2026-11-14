import type { CSSProperties, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { css, keyframes, styled } from 'styled-components'

/**
 * Fold/expand presentation motion for one group body.
 *
 * The authority fold flag is the only input: the context-window decision is
 * already made by the moment this component sees `folded`, so the motion can
 * never re-introduce a hidden body into a request. The body is mounted only
 * while the exit/enter motion is playing (`closing`/`opening`) and leaves the
 * DOM once the CSS animation finishes — the settled folded state is exactly the
 * former zero-flow state for the group's CONTENT (no placeholder, no padding, no
 * mounted rows). The group's own header row is never part of this box: it lives
 * in the group's in-flow header host and keeps its occupied row in both
 * presentation states, so a collapsed group never needs a reserved tail slot,
 * an extra row or a seam exception — the body simply ends at zero height
 * under the header that already exists.
 *
 * ── One concurrent gesture (why the motion is built this way) ──
 * A fold is ONE gesture, not two serial events: the body's visibility and its
 * space change on the same box, started in the same commit, over the same time
 * base. Both properties therefore read as the content moving and shrinking
 * together — there is no window in which the body is already faded/blank while
 * the box is still standing (or already standing while the text is still
 * invisible), which is exactly the "faded first, then a dead gap, then a
 * disconnected size step" feeling a serial schedule produces.
 *
 * The two properties overlap instead of serialising, and the schedule is honest
 * about the overlap: the fade is the shorter animation (and NOT a front-loaded
 * curve — see the timing constants below), so it is essentially complete when
 * the clip boundary lands. Inside that window the clip boundary does cross rows
 * that are still partly visible, i.e. a row can be cut while it is already
 * fading — a brief, low-contrast clip within one gesture, never a cut of fully
 * opaque text and never "fade, then a dead gap, then a size step". Expanding
 * mirrors it: the space starts opening and the fade joins it one short step
 * later, so the text appears while the body is opening instead of after an
 * empty expansion.
 * Both properties remain two animations on the same box carrying one shared
 * schedule, and every instance starts inside the same commit — i.e. at the same
 * document-timeline time — so a group spanning several turn runs (each run owns
 * its own body wrapper) cannot drift into per-run steps. The schedule is
 * carried by the same four CSS custom properties on every instance, never by an
 * independent timer.
 *
 * Motion lifecycle:
 * - mount already folded → `closed` with NO animation (initial load / restart
 *   must not replay a fold transition);
 * - prop flip while mounted → `closing`/`opening`, settled by the element's own
 *   animations (`getAnimations().finished`), never by a timer;
 * - `prefers-reduced-motion` (or an environment without the animation API,
 *   e.g. jsdom) → the settled state is applied immediately, so no motion and no
 *   waiting is ever observable.
 *
 * Continuity: the transition is derived in the render pass that observes the
 * authority flip, i.e. BEFORE React mutates the DOM for that commit. The box
 * still shows the previous presentation there — settled open at the natural
 * height, or mid-motion at the height and opacity the running animations have
 * reached — so a flip that reverses a running motion (a quick fold→expand or
 * expand→fold inside the motion window) continues from what is actually on
 * screen instead of snapping back to an endpoint. Reversal needs no
 * cancellation code: the opposite direction uses the other keyframe set, so the
 * replaced animations are dropped by the engine and the stale settle promise is
 * invalidated by the token below.
 *
 * Layout: the animating wrapper clips to MEASURED pixel heights. A concrete
 * length is required because a percentage/fr track in an indefinite-height box
 * does not shrink, and `height: auto` is not animatable. `from` is the height
 * read at the flip, `to` for a closing motion is ZERO (the group's header row
 * stays in flow above this box, so the body ends at zero height like any other
 * fully hidden content), and for an opening motion it is the remembered
 * natural height when the body is still mounted (a reversal of a running
 * exit), otherwise the body is rendered unclipped for one extra layout pass to
 * read the natural target; that pass is committed before paint. The shared
 * route viewport keeper therefore observes a genuine per-frame height delta
 * through its ordinary observer loop, holding the group header row and letting
 * the content below absorb the delta exactly as it does for the instant fold.
 * The settled states are untouched: plain block while `open` (identical to
 * rendering the body directly), nothing while `closed`.
 */

/**
 * Close: fade and shrink together on one time base. The fade is the SHORTER
 * animation (it is essentially complete when the space motion lands), so the
 * clip boundary crosses rows that are already most of the way transparent.
 * The overlap is honest, not a guarantee: for part of the window a row is both
 * partly visible and already being clipped, so a row can be cut while it is
 * fading. That is a brief, low-contrast clip inside one gesture — the schedule
 * ensures the cut never lands on fully opaque text and that the gesture never
 * serialises into "fade, then a dead gap, then a size step".
 */
const CLOSE_SPACE_MS = 200
const CLOSE_FADE_MS = 140
const CLOSE_FADE_DELAY_MS = 0
const CLOSE_SPACE_DELAY_MS = 0

/**
 * Open: expand and fade in together. The fade joins the expansion one short
 * step later and lands with it (it overlaps the whole opening rather than
 * following an empty box), so the text appears while the body is opening.
 */
const OPEN_SPACE_MS = 200
const OPEN_SPACE_DELAY_MS = 0
const OPEN_FADE_DELAY_MS = 50
const OPEN_FADE_MS = 150

/**
 * One shared motion window for the whole fold gesture: the body size/opacity
 * motion above, and the group chrome (left rule, label tint) that leaves or
 * returns with the body. Chrome takes part in the same window instead of
 * switching ahead of it or lagging behind it.
 */
export const SEGMENT_FOLD_MOTION_MS = Math.max(CLOSE_SPACE_MS, OPEN_SPACE_MS)

/**
 * Space (height) motion: symmetric ease-in-out. A front-loaded curve paints
 * most of the delta in the very first frame (that is the hard snap a fold must
 * not have), so the clip boundary accelerates and lands softly instead.
 */
const FOLD_SPACE_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)'
/**
 * Visibility (opacity) motion: symmetric ease-in-out (mirror control points),
 * NOT a front-loaded ease-out — the fade neither dumps its delta in the first
 * frames nor outruns the clip boundary. Its shorter duration (see above) is
 * what makes it land early; the curve only keeps the change smooth.
 */
const FOLD_FADE_EASING = 'cubic-bezier(0.3, 0, 0.7, 1)'

const FOLD_HEIGHT_FROM_VAR = '--fold-height-from'
const FOLD_HEIGHT_TO_VAR = '--fold-height-to'
const FOLD_FADE_FROM_VAR = '--fold-fade-from'
const FOLD_FADE_TO_VAR = '--fold-fade-to'
const FOLD_SPACE_DURATION_VAR = '--fold-space-duration'
const FOLD_SPACE_DELAY_VAR = '--fold-space-delay'
const FOLD_FADE_DURATION_VAR = '--fold-fade-duration'
const FOLD_FADE_DELAY_VAR = '--fold-fade-delay'

/**
 * One keyframe pair PER DIRECTION, never one shared pair.
 *
 * A CSS animation is matched by NAME on the element that owns it: when only the
 * timing custom properties change, Chromium keeps the running clock, so a
 * reversed exit animation resumes at the cancelled `currentTime` and lands on
 * (nearly) its end value within one frame instead of continuing from the height
 * currently on screen (measured: 168px → 223px inside a single observed frame).
 * Distinct names per phase force a brand-new animation that starts at 0 from the
 * live `--fold-*` values, which is the continuity the entrance/exit split
 * promises. The names differ because their declarations differ (styled
 * components hashes the keyframe text), so the two directions must never be
 * collapsed back into one declaration.
 */
const foldSpaceClose = keyframes`
  from {
    height: var(${FOLD_HEIGHT_FROM_VAR});
  }
  to {
    height: var(${FOLD_HEIGHT_TO_VAR});
  }
`

const foldSpaceOpen = keyframes`
  from {
    height: var(${FOLD_HEIGHT_FROM_VAR});
  }
  to {
    height: var(${FOLD_HEIGHT_TO_VAR});
  }
  /* Open direction: own animation identity, see above. */
`

const foldFadeClose = keyframes`
  from {
    opacity: var(${FOLD_FADE_FROM_VAR});
  }
  to {
    opacity: var(${FOLD_FADE_TO_VAR});
  }
`

const foldFadeOpen = keyframes`
  from {
    opacity: var(${FOLD_FADE_FROM_VAR});
  }
  to {
    opacity: var(${FOLD_FADE_TO_VAR});
  }
  /* Open direction: own animation identity, see above. */
`

type FoldMotionPhase = 'closing' | 'opening'

type FoldPresentation =
  | { kind: 'open' }
  | { kind: 'closed' }
  /** `to === null` is the opening measure pass (no clip, no animation yet). */
  | { kind: 'motion'; phase: FoldMotionPhase; from: number; fadeFrom: number; to: number | null }

/** Per-phase schedule carried as CSS custom properties (one time base). */
interface FoldTiming {
  spaceDuration: number
  spaceDelay: number
  fadeDuration: number
  fadeDelay: number
}

const foldTimingFor = (phase: FoldMotionPhase): FoldTiming =>
  phase === 'closing'
    ? {
        spaceDuration: CLOSE_SPACE_MS,
        spaceDelay: CLOSE_SPACE_DELAY_MS,
        fadeDuration: CLOSE_FADE_MS,
        fadeDelay: CLOSE_FADE_DELAY_MS
      }
    : {
        spaceDuration: OPEN_SPACE_MS,
        spaceDelay: OPEN_SPACE_DELAY_MS,
        fadeDuration: OPEN_FADE_MS,
        fadeDelay: OPEN_FADE_DELAY_MS
      }

/**
 * How the group body must be rendered for the current presentation.
 *
 * `inert` marks a PRESENTATION-ONLY body: the rows are still painted while the
 * exit motion runs, but they are on their way out of the mounted flow, so they
 * must own no reading anchor, no selection and no click target (see the wrapper
 * `inert` attribute below).
 */
export interface FoldBodyPresentation {
  /** Include the just-hidden members (true while a motion needs the body). */
  includeFolded: boolean
  /** Presentation-only retained body: nothing in it can be read or clicked. */
  inert: boolean
}

/**
 * Registry channel for a presentation-only body: it deliberately owns nothing,
 * so the retained rows can never become a persisted reading anchor. Passing it
 * is the *only* new behaviour — the registry contract, its versioning and the
 * region keeper stay untouched.
 */
export const presentationOnlyMessageElementRegistrar = (): void => undefined

const isFoldMotionAvailable = (): boolean => {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false
    // The animation API is the honest capability probe: without it (jsdom,
    // non-animating engines) the settled state must apply immediately.
    if (typeof HTMLElement.prototype.getAnimations !== 'function') return false
    // A missing matchMedia is "no recorded preference", not "reduced motion":
    // real Electron always provides it, and CSS still disables the animation.
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return false
    }
    return true
  } catch {
    return false
  }
}

/** Live pixel height of the box, or 0 when nothing is measurable. */
const readVisibleHeight = (element: HTMLElement | null): number => {
  if (!element) return 0
  try {
    const rect = element.getBoundingClientRect()
    return Number.isFinite(rect.height) && rect.height > 0 ? rect.height : 0
  } catch {
    return 0
  }
}

/**
 * Live opacity of the box, i.e. the value the running fade animation has
 * reached (computed style reflects animation output). Used only for reversal
 * continuity of the fade; a fresh motion starts from a settled endpoint.
 */
const readVisibleOpacity = (element: HTMLElement | null): number => {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 1
  try {
    const raw = window.getComputedStyle(element).opacity
    // Environments without a resolved computed opacity (jsdom) report an
    // empty value; that means "no recorded opacity", i.e. fully opaque.
    if (raw === '') return 1
    const opacity = Number(raw)
    if (!Number.isFinite(opacity)) return 1
    return Math.min(1, Math.max(0, opacity))
  } catch {
    return 1
  }
}

/** Authority fold state a presentation was derived for. */
const presentationAuthorityFolded = (presentation: FoldPresentation): boolean =>
  presentation.kind === 'closed' || (presentation.kind === 'motion' && presentation.phase === 'closing')

const settledPresentation = (folded: boolean): FoldPresentation => (folded ? { kind: 'closed' } : { kind: 'open' })

interface SegmentFoldTransitionProps {
  /** Authority fold state of the group that owns this body. */
  folded: boolean
  /**
   * Renders the group body for the current presentation. `includeFolded` is
   * true only while a motion needs the full body on screen (exit/enter); the
   * settled states always receive false, so a folded group's rows are never
   * kept mounted at rest.
   */
  renderBody: (presentation: FoldBodyPresentation) => ReactNode
}

const SegmentFoldTransition: React.FC<SegmentFoldTransitionProps> = ({ folded, renderBody }) => {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const motionAvailableRef = useRef<boolean>(isFoldMotionAvailable())
  const [presentation, setPresentation] = useState<FoldPresentation>(() => settledPresentation(folded))
  // Last natural (unclipped) body height: the opening target when the exit
  // motion is being reversed and the rows are still mounted.
  const naturalHeightRef = useRef<number | null>(null)

  // The transition is derived in the render that observes the flip, never in a
  // following layout pass: this commit is exactly the one that would take the
  // body out of the flow, so the exit height has to be read while the DOM still
  // shows the previous presentation (see the continuity note above). Deriving
  // from state instead of from a ref keeps the pass idempotent — any render
  // that still sees a presentation belonging to the other fold state derives
  // the same transition again.
  if (presentationAuthorityFolded(presentation) !== folded) {
    const visible = readVisibleHeight(bodyRef.current)
    if (!motionAvailableRef.current) {
      // Reduced motion / no animation API: apply the settled state directly.
      setPresentation(settledPresentation(folded))
    } else if (folded) {
      // Already at (or below) the closing target: nothing to shrink, so settle
      // immediately.
      setPresentation(
        visible > 0
          ? {
              kind: 'motion',
              phase: 'closing',
              from: visible,
              fadeFrom: readVisibleOpacity(bodyRef.current),
              to: 0
            }
          : { kind: 'closed' }
      )
    } else {
      // `from` is whatever is visible right now: the tail slot / 0 after a
      // settled fold, or the partial clipped height when a running exit is
      // being reversed. A reversal keeps its target, because the body never
      // left the flow; a settled fold has to measure the body again (its
      // content may have changed while it was hidden).
      const previousWasClosing = presentation.kind === 'motion' && presentation.phase === 'closing'
      const knownNatural = previousWasClosing ? naturalHeightRef.current : null
      setPresentation({
        kind: 'motion',
        phase: 'opening',
        from: visible,
        // A reversal continues the fade from the opacity on screen. A settled
        // fold starts hidden: the body must be invisible while the space opens.
        fadeFrom: previousWasClosing ? readVisibleOpacity(bodyRef.current) : 0,
        to: knownNatural !== null && knownNatural > 0 ? knownNatural : null
      })
    }
  }

  // Remember the natural height of the mounted body, but only from an
  // unclipped commit: a clipped (animating) frame is not the natural height,
  // and a settled fold forgets it so that reopening measures the body again.
  useLayoutEffect(() => {
    if (presentation.kind === 'closed') {
      naturalHeightRef.current = null
      return
    }
    if (presentation.kind === 'motion' && presentation.to !== null) return
    const visible = readVisibleHeight(bodyRef.current)
    if (visible > 0) naturalHeightRef.current = visible
  })

  // Opening measure pass: the body is committed unclipped at its natural height
  // for this one layout pass, then the clip is armed from the captured exit
  // height. Nothing is painted between the two passes.
  useLayoutEffect(() => {
    if (presentation.kind !== 'motion' || presentation.to !== null) return
    const natural = readVisibleHeight(bodyRef.current) || naturalHeightRef.current || 0
    if (natural <= 0) {
      setPresentation({ kind: 'open' })
      return
    }
    setPresentation((previous) =>
      previous.kind === 'motion' && previous.phase === 'opening' && previous.to === null
        ? { ...previous, to: natural }
        : previous
    )
  }, [presentation])

  // Settle from the element's own animations (space + fade). No state is
  // written after unmount, and a superseded transition (the inverse flip)
  // invalidates the pending completion instead of forcing a stale state.
  useLayoutEffect(() => {
    if (presentation.kind !== 'motion' || presentation.to === null) return
    const phase = presentation.phase
    const settle = () => setPresentation(() => (phase === 'closing' ? { kind: 'closed' } : { kind: 'open' }))
    const element = bodyRef.current
    if (!element || typeof element.getAnimations !== 'function') {
      settle()
      return
    }
    let animations: Animation[] = []
    try {
      animations = element.getAnimations()
    } catch {
      settle()
      return
    }
    if (animations.length === 0) {
      // Reduced motion (or any environment where the animations did not start):
      // the settled state is applied in the same pre-paint pass.
      settle()
      return
    }
    let cancelled = false
    void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(() => {
      if (!cancelled) settle()
    })
    return () => {
      cancelled = true
    }
  }, [presentation])

  if (presentation.kind === 'closed') {
    // The settled folded body mounts nothing at all: the group's header row is
    // separate chrome and keeps its occupied row, so no body slot, seam band or
    // flow-terminal exception is ever added here.
    return null
  }

  const motion = presentation.kind === 'motion' ? presentation : null
  // Armed = both endpoints are known, so the clip and its animations exist.
  const armed = motion !== null && motion.to !== null
  // A closing body is presentation-only: it is inert (no click, focus, hit-test
  // or selection reach it) for the whole exit motion.
  const inert = motion !== null && motion.phase === 'closing'

  let style: CSSProperties | undefined
  if (armed && motion) {
    const timing = foldTimingFor(motion.phase)
    style = {
      [FOLD_HEIGHT_FROM_VAR]: `${motion.from}px`,
      [FOLD_HEIGHT_TO_VAR]: `${motion.to}px`,
      [FOLD_FADE_FROM_VAR]: String(motion.fadeFrom),
      [FOLD_FADE_TO_VAR]: motion.phase === 'closing' ? '0' : '1',
      [FOLD_SPACE_DURATION_VAR]: `${timing.spaceDuration}ms`,
      [FOLD_SPACE_DELAY_VAR]: `${timing.spaceDelay}ms`,
      [FOLD_FADE_DURATION_VAR]: `${timing.fadeDuration}ms`,
      [FOLD_FADE_DELAY_VAR]: `${timing.fadeDelay}ms`
    } as CSSProperties
  }

  return (
    <FoldBody
      ref={bodyRef}
      $phase={motion ? motion.phase : null}
      $armed={armed}
      $inert={inert}
      inert={inert}
      style={style}
      data-segment-fold-phase={armed && motion ? motion.phase : undefined}>
      {renderBody({ includeFolded: motion !== null, inert })}
    </FoldBody>
  )
}

const FoldBody = styled.div<{ $phase: FoldMotionPhase | null; $armed: boolean; $inert: boolean }>`
  ${(props) => {
    if (props.$phase === null || !props.$armed) return null
    // Clipping is only needed while the height animates; the unarmed opening
    // measure pass keeps the natural box so the measurement is honest.
    const space = props.$phase === 'closing' ? foldSpaceClose : foldSpaceOpen
    const fade = props.$phase === 'closing' ? foldFadeClose : foldFadeOpen
    return css`
      overflow: hidden;
      height: var(${FOLD_HEIGHT_FROM_VAR});
      animation:
        ${space} var(${FOLD_SPACE_DURATION_VAR}) ${FOLD_SPACE_EASING} var(${FOLD_SPACE_DELAY_VAR}) both,
        ${fade} var(${FOLD_FADE_DURATION_VAR}) ${FOLD_FADE_EASING} var(${FOLD_FADE_DELAY_VAR}) both;

      @media (prefers-reduced-motion: reduce) {
        animation: none;
      }
    `
  }}
  ${(props) =>
    props.$inert
      ? css`
          pointer-events: none;
          user-select: none;
        `
      : null}
`

export default SegmentFoldTransition
