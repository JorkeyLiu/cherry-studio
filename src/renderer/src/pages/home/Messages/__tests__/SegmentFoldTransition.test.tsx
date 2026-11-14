/**
 * Fold/expand body motion contract.
 *
 * The authority fold flag drives the body: the settled folded state mounts
 * nothing (zero-flow, no placeholder) except for the flow-terminal group, which
 * keeps the minimal label slot; a live flip plays one concurrent gesture whose
 * completion comes from the element's own animations (never a timer); a group
 * that mounts already folded never animates; and reduced motion settles
 * immediately.
 *
 * One shared time base is the contract of this component: closing and opening
 * both run the body's opacity and its space height concurrently from the four
 * CSS custom properties asserted below. The fade leads (it lands inside the
 * clip window, so readable rows are gone before the moving boundary reaches
 * them) without waiting for the space to collapse first; the expansion fades
 * the body in as the space opens, so there is no empty-box gap before the
 * text. Serializing the two would bring back the disconnected
 * fade-then-dead-space feel this motion exists to remove.
 *
 * Reversal continuity is the point of the `from` pair: a flip that reverses a
 * running motion starts from the height AND the opacity the body currently has
 * on screen (sampled in the commit that observes the flip) and runs to the new
 * target, so the visible box never snaps back to an endpoint. The old motion's
 * completion is invalidated by the token, never by a timer.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import SegmentFoldTransition, { type FoldBodyPresentation } from '../SegmentFoldTransition'

const originalGetAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getAnimations')
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
const originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
const originalGetComputedStyle = Object.getOwnPropertyDescriptor(window, 'getComputedStyle')
const nativeGetComputedStyle = window.getComputedStyle.bind(window)

// A real group body is tall; the fixture must be measurable so a closing motion
// has a genuine height to clip from.
const MEASURED_BODY_HEIGHT = 240

// Live box height the motion measures. Mutable so a test can emulate the body
// being mid-motion when the inverse flip arrives.
let boxHeight = MEASURED_BODY_HEIGHT
// Live computed opacity of the animating host (null = environment default).
let liveOpacity: string | null = null
// One entry per `getAnimations()` call: the settle resolvers of that arming.
let animationArms: Array<Array<() => void>> = []

function installAnimationHost() {
  animationArms = []
  boxHeight = MEASURED_BODY_HEIGHT
  liveOpacity = null
  // jsdom reports a zero-size box; the motion measures a real pixel height
  // before it arms the clip, so give every box a height.
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const height = this.dataset.segmentFoldPhase ? boxHeight : MEASURED_BODY_HEIGHT
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 100,
        bottom: height,
        width: 100,
        height,
        toJSON() {}
      }
    }
  })
  // Every armed motion host runs two animations (space + fade); the settled
  // states and the unarmed opening measure pass own none.
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value(this: HTMLElement) {
      if (!this.dataset.segmentFoldPhase) return []
      const resolvers: Array<() => void> = []
      const animations = [0, 1].map(() => ({
        finished: new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
      }))
      animationArms.push(resolvers)
      return animations
    }
  })
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => {
      // Only the animating host carries a live opacity override; everything
      // else resolves through the environment's own implementation.
      if (liveOpacity !== null && (element as HTMLElement).dataset.segmentFoldPhase) {
        return { opacity: liveOpacity } as CSSStyleDeclaration
      }
      return nativeGetComputedStyle(element)
    }
  })
}

function installReducedMotion() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query })
  })
}

const body = (presentation: FoldBodyPresentation) => (
  <div data-testid="body">
    {presentation.includeFolded ? 'include-folded' : 'visible'}/{presentation.inert ? 'inert' : 'live'}
  </div>
)

const motionHost = (): HTMLElement => screen.getByTestId('body').parentElement as HTMLElement

const cssVar = (name: string): string => motionHost().style.getPropertyValue(name)

/** Resolve the animations armed by arm `index` (0 = first motion). */
async function settleArm(index: number) {
  await act(async () => {
    for (const resolve of animationArms[index] ?? []) resolve()
  })
}

afterEach(() => {
  if (originalGetAnimations) {
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', originalGetAnimations)
  } else {
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
  }
  if (originalGetBoundingClientRect) {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', originalGetBoundingClientRect)
  } else {
    delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
  }
  if (originalGetComputedStyle) {
    Object.defineProperty(window, 'getComputedStyle', originalGetComputedStyle)
  }
  if (originalMatchMedia) {
    Object.defineProperty(window, 'matchMedia', originalMatchMedia)
  }
})

describe('SegmentFoldTransition', () => {
  beforeEach(() => {
    installAnimationHost()
  })

  it('mounts nothing for a group that is already folded (no restart animation)', () => {
    render(<SegmentFoldTransition folded renderBody={body} />)
    expect(screen.queryByTestId('body')).toBeNull()
    expect(animationArms).toHaveLength(0)
  })

  it('keeps the full body mounted while the exit motion runs, then unmounts it', async () => {
    const { rerender } = render(<SegmentFoldTransition folded={false} renderBody={body} />)
    expect(screen.getByTestId('body').textContent).toBe('visible/live')

    rerender(<SegmentFoldTransition folded renderBody={body} />)
    const transient = screen.getByTestId('body')
    // Exit motion renders the whole body (including the just-folded rows) and
    // reports the transient phase on the motion host.
    expect(transient.textContent).toBe('include-folded/inert')
    expect(transient.parentElement?.getAttribute('data-segment-fold-phase')).toBe('closing')
    expect(animationArms).toHaveLength(1)

    // Completion is the element's own animations finishing — no timer involved.
    await settleArm(0)
    expect(screen.queryByTestId('body')).toBeNull()
  })

  it('closing runs the fade and the space collapse concurrently (one gesture + endpoints)', async () => {
    const { rerender } = render(<SegmentFoldTransition folded={false} renderBody={body} />)
    rerender(<SegmentFoldTransition folded renderBody={body} />)

    // Both motions start on the same frame. The fade is the shorter one so the
    // readable rows are already gone before the clip boundary passes them, but
    // it runs INSIDE the space window instead of owning a dead lead in front of
    // it: one gesture, no visible pause between the body fading and the box
    // collapsing.
    const spaceDuration = Number.parseFloat(cssVar('--fold-space-duration'))
    const spaceDelay = Number.parseFloat(cssVar('--fold-space-delay'))
    const fadeDuration = Number.parseFloat(cssVar('--fold-fade-duration'))
    const fadeDelay = Number.parseFloat(cssVar('--fold-fade-delay'))
    expect(fadeDelay, 'the fade starts with the gesture, not after it').toBe(0)
    expect(spaceDelay, 'the space motion starts with the fade, not after it').toBe(0)
    expect(spaceDuration).toBeGreaterThan(0)
    expect(fadeDuration, 'the fade lands inside the clip window so no readable row is cut').toBeLessThan(spaceDuration)
    expect(
      fadeDuration,
      'the fade covers most of the gesture instead of leaving dead space at the end'
    ).toBeGreaterThanOrEqual(spaceDuration * 0.5)
    // Concurrent overlap: the two runs share the whole space window (there is no
    // serial gap in which only one of them is moving).
    const overlap = Math.min(spaceDelay + spaceDuration, fadeDelay + fadeDuration) - Math.max(spaceDelay, fadeDelay)
    expect(overlap, 'fade and space move together, not one after the other').toBeGreaterThanOrEqual(spaceDuration * 0.6)

    // Height runs from the live box to zero; opacity runs from 1 to 0.
    expect(cssVar('--fold-height-from')).toBe(`${MEASURED_BODY_HEIGHT}px`)
    expect(cssVar('--fold-height-to')).toBe('0px')
    expect(cssVar('--fold-fade-from')).toBe('1')
    expect(cssVar('--fold-fade-to')).toBe('0')

    await settleArm(0)
    expect(screen.queryByTestId('body')).toBeNull()
  })

  it('keeps the body inert (presentation-only) for the whole exit motion', async () => {
    const { rerender } = render(<SegmentFoldTransition folded={false} renderBody={body} />)
    rerender(<SegmentFoldTransition folded renderBody={body} />)
    // The body is still painted, but presentation-only from the first frame:
    // the host is inert, so no click/focus/selection reaches the rows.
    expect(screen.getByTestId('body')).not.toBeNull()
    expect(motionHost().hasAttribute('inert')).toBe(true)
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('closing')

    await settleArm(0)
    expect(screen.queryByTestId('body')).toBeNull()
  })

  it('expands and fades the body in concurrently when a folded group opens and settles into the plain body', async () => {
    const { rerender } = render(<SegmentFoldTransition folded renderBody={body} />)
    expect(screen.queryByTestId('body')).toBeNull()

    rerender(<SegmentFoldTransition folded={false} renderBody={body} />)
    expect(screen.getByTestId('body').textContent).toBe('include-folded/live')
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('opening')

    // The space opens on the first frame and the body joins it a short step
    // later, landing while the space is still opening: the content arrives
    // during the motion instead of after an empty box has already been drawn.
    const spaceDelay = Number.parseFloat(cssVar('--fold-space-delay'))
    const spaceDuration = Number.parseFloat(cssVar('--fold-space-duration'))
    const fadeDelay = Number.parseFloat(cssVar('--fold-fade-delay'))
    const fadeDuration = Number.parseFloat(cssVar('--fold-fade-duration'))
    expect(spaceDelay, 'the space motion owns the first frame').toBe(0)
    expect(fadeDelay, 'the fade joins the expansion, not after it').toBeGreaterThan(0)
    expect(fadeDelay, 'the body must not pop in before the space has started opening').toBeLessThan(spaceDuration * 0.5)
    const overlap = Math.min(spaceDelay + spaceDuration, fadeDelay + fadeDuration) - Math.max(spaceDelay, fadeDelay)
    expect(overlap, 'fade and space move together, not one after the other').toBeGreaterThanOrEqual(spaceDuration * 0.6)
    expect(cssVar('--fold-height-from')).toBe('0px')
    expect(cssVar('--fold-height-to')).toBe(`${MEASURED_BODY_HEIGHT}px`)
    // A settled fold starts hidden: the body fades in rather than popping visible.
    expect(cssVar('--fold-fade-from')).toBe('0')
    expect(cssVar('--fold-fade-to')).toBe('1')

    await settleArm(0)
    expect(screen.getByTestId('body').textContent).toBe('visible/live')
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBeNull()
  })

  it('settles immediately under reduced motion (no motion phase)', () => {
    installReducedMotion()
    const { rerender } = render(<SegmentFoldTransition folded={false} renderBody={body} />)
    rerender(<SegmentFoldTransition folded renderBody={body} />)
    expect(screen.queryByTestId('body')).toBeNull()
    expect(animationArms).toHaveLength(0)
  })

  it('settles immediately when the host cannot report animations (no waiting)', () => {
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
    const { rerender } = render(<SegmentFoldTransition folded={false} renderBody={body} />)
    rerender(<SegmentFoldTransition folded renderBody={body} />)
    expect(screen.queryByTestId('body')).toBeNull()
  })

  it('continues from the visible height and opacity when a fold is reversed inside the motion', async () => {
    const { rerender } = render(<SegmentFoldTransition folded={false} renderBody={body} />)
    rerender(<SegmentFoldTransition folded renderBody={body} />)
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('closing')
    expect(animationArms).toHaveLength(1)

    // Mid-motion: the visible clip has already shrunk to 18px and the body has
    // faded to 0.4 when the authority flag flips back to expanded.
    boxHeight = 18
    liveOpacity = '0.4'
    rerender(<SegmentFoldTransition folded={false} renderBody={body} />)
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('opening')
    // The enter motion starts at the current visible height and opacity, not at
    // an endpoint: continuity, no snap back.
    expect(cssVar('--fold-height-from')).toBe('18px')
    expect(cssVar('--fold-height-to')).toBe(`${MEASURED_BODY_HEIGHT}px`)
    expect(cssVar('--fold-fade-from')).toBe('0.4')
    expect(cssVar('--fold-fade-to')).toBe('1')
    expect(animationArms).toHaveLength(2)

    // The replaced exit animation's completion must not force a stale settle.
    await settleArm(0)
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('opening')
    expect(screen.getByTestId('body').textContent).toBe('include-folded/live')

    await settleArm(1)
    expect(screen.getByTestId('body').textContent).toBe('visible/live')
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBeNull()
  })

  it('continues from the visible height and opacity when an expand is reversed inside the motion', async () => {
    const { rerender } = render(<SegmentFoldTransition folded renderBody={body} />)
    rerender(<SegmentFoldTransition folded={false} renderBody={body} />)
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('opening')
    expect(cssVar('--fold-height-from')).toBe('0px')

    // Mid-motion: the visible clip has grown to 26px and the fade has reached
    // 0.7 when the flag flips back to folded.
    boxHeight = 26
    liveOpacity = '0.7'
    rerender(<SegmentFoldTransition folded renderBody={body} />)
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('closing')
    expect(cssVar('--fold-height-from')).toBe('26px')
    expect(cssVar('--fold-height-to')).toBe('0px')
    expect(cssVar('--fold-fade-from')).toBe('0.7')
    expect(cssVar('--fold-fade-to')).toBe('0')
    expect(animationArms).toHaveLength(2)
    await settleArm(0)
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('closing')

    await settleArm(1)
    expect(screen.queryByTestId('body')).toBeNull()
  })

  it('arms the identical schedule for two bodies of one group started in the same commit', async () => {
    // A group spanning several turn runs owns one body wrapper per run. Both
    // observe the same authority flip in the same commit, so both must carry
    // the same timing — a per-run drift would read as a broken gesture.
    const bodies = (presentation: FoldBodyPresentation) => (
      <div data-testid="body">
        {presentation.includeFolded ? 'include-folded' : 'visible'}/{presentation.inert ? 'inert' : 'live'}
      </div>
    )
    const { rerender } = render(
      <>
        <SegmentFoldTransition folded={false} renderBody={bodies} />
        <SegmentFoldTransition folded={false} renderBody={bodies} />
      </>
    )
    rerender(
      <>
        <SegmentFoldTransition folded renderBody={bodies} />
        <SegmentFoldTransition folded renderBody={bodies} />
      </>
    )
    const hosts = screen.getAllByTestId('body').map((node) => node.parentElement as HTMLElement)
    expect(hosts).toHaveLength(2)
    const schedule = (host: HTMLElement) =>
      [
        '--fold-space-duration',
        '--fold-space-delay',
        '--fold-fade-duration',
        '--fold-fade-delay',
        '--fold-height-from',
        '--fold-height-to',
        '--fold-fade-from',
        '--fold-fade-to'
      ].map((name) => host.style.getPropertyValue(name))
    expect(schedule(hosts[0])).toEqual(schedule(hosts[1]))
    expect(hosts[0].getAttribute('data-segment-fold-phase')).toBe('closing')
    expect(hosts[1].getAttribute('data-segment-fold-phase')).toBe('closing')

    await act(async () => {
      for (const arm of animationArms) for (const resolve of arm) resolve()
    })
    expect(screen.queryAllByTestId('body')).toHaveLength(0)
  })

  it('settles a folded group body to nothing at all (no slot, no reserved row)', () => {
    // The group's header row is separate chrome and keeps its own in-flow row, so
    // the body owns no exception: a settled fold mounts no rows and reserves no
    // label slot anywhere in the flow.
    render(<SegmentFoldTransition folded renderBody={body} />)
    expect(screen.queryByTestId('body')).toBeNull()
    expect(animationArms, 'an already folded group never replays a motion').toHaveLength(0)
  })

  it('closes the body to ZERO height, never to a reserved slot', async () => {
    const { rerender } = render(<SegmentFoldTransition folded={false} renderBody={body} />)
    rerender(<SegmentFoldTransition folded renderBody={body} />)
    expect(cssVar('--fold-height-from')).toBe(`${MEASURED_BODY_HEIGHT}px`)
    expect(cssVar('--fold-height-to')).toBe('0px')

    await settleArm(0)
    expect(screen.queryByTestId('body')).toBeNull()
  })

  it('opens a folded body from zero height (no jump on expand)', async () => {
    const { rerender } = render(<SegmentFoldTransition folded renderBody={body} />)
    rerender(<SegmentFoldTransition folded={false} renderBody={body} />)
    // A settled fold has no mounted box to measure, so the entrance starts at the
    // settled zero height and measures the natural target before paint.
    expect(cssVar('--fold-height-from')).toBe('0px')
    expect(cssVar('--fold-height-to')).toBe(`${MEASURED_BODY_HEIGHT}px`)
    await settleArm(0)
    expect(screen.getByTestId('body').textContent).toBe('visible/live')
  })

  it('gives each direction its own animation identity so a reversal restarts its clock', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/renderer/src/pages/home/Messages/SegmentFoldTransition.tsx'),
      'utf8'
    )
    // A CSS animation is matched by NAME on the element: when only the timing
    // custom properties change, Chromium keeps the cancelled clock and the
    // resumed expand lands on its end height within one frame (measured in the
    // running app: 168px -> 223px in a single observed frame). Four distinct
    // keyframe declarations are what force a fresh clock per direction.
    expect(src).toContain('const foldSpaceClose = keyframes`')
    expect(src).toContain('const foldSpaceOpen = keyframes`')
    expect(src).toContain('const foldFadeClose = keyframes`')
    expect(src).toContain('const foldFadeOpen = keyframes`')
    expect(src).toContain("const space = props.$phase === 'closing' ? foldSpaceClose : foldSpaceOpen")
    expect(src).toContain("const fade = props.$phase === 'closing' ? foldFadeClose : foldFadeOpen")
    // They must also stay textually distinct: styled components derives the
    // animation name from the declaration text, so identical declarations would
    // collapse back into one animation.
    const closeSpace = src.slice(src.indexOf('const foldSpaceClose'), src.indexOf('const foldSpaceOpen'))
    const openSpace = src.slice(src.indexOf('const foldSpaceOpen'), src.indexOf('const foldFadeClose'))
    expect(openSpace).not.toBe(closeSpace)
  })
})
