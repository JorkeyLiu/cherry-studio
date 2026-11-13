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
 * former zero-flow state (no placeholder, no padding, no mounted rows), except
 * for the one route-tail group, which keeps the minimal label slot described
 * below.
 *
 * ── Phase separation (why the motion is built this way) ──
 * A single height clip makes rows slide under a hard moving boundary, so the
 * last visible text line / toolbar of the group is cut while it is still
 * readable. The motion therefore separates VISIBILITY from SPACE:
 * - closing: the body fades out first (fast), and only once it is effectively
 *   invisible does the box shrink. Nothing readable is ever painted while the
 *   clip boundary moves.
 * - opening: the box expands first with the content still transparent, and the
 *   body fades in afterwards, at its full natural height — there is no
 *   boundary left to cut anything at the moment the text becomes visible.
 * The two properties run as two animations on the same box with per-phase
 * delays (see the timing constants below), so both phases of one group share a
 * single time base. Every instance starts its animations inside the same
 * commit, i.e. at the same document-timeline time, so a group spanning several
 * turn runs (each run owns its own body wrapper) cannot drift into per-run
 * steps; the schedule is carried by the same four CSS custom properties on
 * every instance, never by an independent timer.
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
 * read at the flip. `to` for a closing motion is the reserved tail slot height
 * (route-tail group) or zero; for an opening motion it is the remembered
 * natural height when the body is still mounted (a reversal of a running
 * exit), otherwise the body is rendered unclipped for one extra layout pass to
 * read the natural target; that pass is committed before paint. The shared
 * route viewport keeper therefore observes a genuine per-frame height delta
 * through its ordinary observer loop, holding the group header and letting the
 * content below absorb the delta exactly as it does for the instant fold. The
 * settled states are untouched: plain block while `open` (identical to
 * rendering the body directly), nothing while `closed` (plus the tail slot
 * when this group is the flow terminal).
 *
 * ── Route-tail label slot ──
 * The collapsed label pill is out-of-flow chrome at the run's top edge. For a
 * folded group that ends the whole message flow, that seam IS the scroll end,
 * so the pill would paint into the scroll host's bottom padding and be clipped.
 * The route-tail group therefore reserves one minimal label slot (pill height +
 * a small safety gap) inside its own body area: the pill keeps its position at
 * the seam, stays fully inside the scrollport, and never reaches the previous
 * message or the composer. The reservation is also the closing animation's
 * end height, so the slot appears as part of the motion instead of as a jump.
 * Every non-tail fold keeps the zero-flow character (no slot, no row height).
 */

/**
 * Label pill height (24px) plus the clearance the composer's floating Layers
 * trigger needs: the portaled trigger sits 8px above the composer and is 24px
 * tall, so its band reaches 32px above the composer top. A 28px slot left the
 * pill's lower half inside that band (measured: pill 438–463 vs trigger
 * 456–480), so the slot carries one pill height plus that whole band and a
 * small safety gap. The slot is the closing animation's end height, so it
 * appears as part of the motion, never as a jump.
 */
const TAIL_SLOT_HEIGHT_PX = 44

/**
 * Close: fade out, then shrink. The space motion starts exactly when the fade
 * ends, so no readable row is ever painted while the clip boundary moves.
 */
const CLOSE_FADE_MS = 40
const CLOSE_FADE_DELAY_MS = 0
const CLOSE_SPACE_DELAY_MS = CLOSE_FADE_MS
const CLOSE_SPACE_MS = 190

/**
 * Open: expand, then fade in. The fade starts exactly when the expansion ends,
 * so the text becomes visible only at its full natural height.
 */
const OPEN_SPACE_MS = 190
const OPEN_SPACE_DELAY_MS = 0
const OPEN_FADE_DELAY_MS = OPEN_SPACE_MS
const OPEN_FADE_MS = 120

/**
 * Space (height) motion: symmetric ease-in-out. A front-loaded curve paints
 * most of the delta in the very first frame (that is the hard snap a fold must
 * not have), so the clip boundary accelerates and lands softly instead.
 */
const FOLD_SPACE_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)'
/** Visibility (opacity) motion: symmetric, so a fade never lingers at the ends. */
const FOLD_FADE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'

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
   * The group ends the whole message flow on the current route: its collapsed
   * label keeps the minimal tail slot instead of a zero-flow seam so the pill
   * stays fully inside the scrollport. Exactly one group per flow has it.
   */
  tailSlot?: boolean
  /**
   * Renders the group body for the current presentation. `includeFolded` is
   * true only while a motion needs the full body on screen (exit/enter); the
   * settled states always receive false, so a folded group's rows are never
   * kept mounted at rest.
   */
  renderBody: (presentation: FoldBodyPresentation) => ReactNode
}

const SegmentFoldTransition: React.FC<SegmentFoldTransitionProps> = ({ folded, tailSlot = false, renderBody }) => {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const motionAvailableRef = useRef<boolean>(isFoldMotionAvailable())
  const [presentation, setPresentation] = useState<FoldPresentation>(() => settledPresentation(folded))
  // Last natural (unclipped) body height: the opening target when the exit
  // motion is being reversed and the rows are still mounted.
  const naturalHeightRef = useRef<number | null>(null)
  // Closing target: the tail slot for the flow-terminal group, zero otherwise.
  const closingTargetRef = useRef<number>(tailSlot ? TAIL_SLOT_HEIGHT_PX : 0)
  closingTargetRef.current = tailSlot ? TAIL_SLOT_HEIGHT_PX : 0

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
      const target = closingTargetRef.current
      setPresentation(
        visible > target
          ? {
              kind: 'motion',
              phase: 'closing',
              from: visible,
              fadeFrom: readVisibleOpacity(bodyRef.current),
              to: target
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
    // Route-tail group: keep the minimal label slot so the collapsed pill stays
    // inside the scrollport. Everything else settles to no mounted box at all.
    if (!tailSlot) return null
    return <TailSlot ref={bodyRef} data-testid="fold-tail-slot" data-segment-fold-tail-slot aria-hidden="true" />
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

/**
 * Zero-paint label slot reserved by the flow-terminal folded group: it occupies
 * exactly the collapsed pill's height plus a small safety gap and offers no hit
 * area of its own (the pill lives in the chrome host above it).
 */
const TailSlot = styled.div`
  height: ${TAIL_SLOT_HEIGHT_PX}px;
  pointer-events: none;
`
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
