/**
 * Fold/expand body motion contract.
 *
 * The authority fold flag drives the body: the settled folded state mounts
 * nothing (zero-flow, no placeholder) except for the flow-terminal group, which
 * keeps the minimal label slot; a live flip plays one phased motion whose
 * completion comes from the element's own animations (never a timer); a group
 * that mounts already folded never animates; and reduced motion settles
 * immediately.
 *
 * The phased schedule is the contract of this component: closing fades the body
 * out FIRST and only then shrinks the space, opening expands the space FIRST and
 * only then fades the body in. Both phases are armed from the four per-phase
 * CSS custom properties asserted below, so the phase order can never regress
 * into a single height clip that cuts readable rows at a moving boundary.
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

// A real folded group body is far taller than the reserved tail slot, so the
// measured fixture must exceed it (a body already shorter than the slot settles
// immediately instead of shrinking "up" to it).
const MEASURED_BODY_HEIGHT = 240
/** Reserved route-tail label slot the component documents (44px). */
const TAIL_SLOT_HEIGHT = 44

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
  // before it arms the clip, so give every box a height. The reserved tail slot
  // reports its own reserved height.
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const height = this.dataset.segmentFoldTailSlot
        ? TAIL_SLOT_HEIGHT
        : this.dataset.segmentFoldPhase
          ? boxHeight
          : MEASURED_BODY_HEIGHT
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
    expect(screen.queryByTestId('fold-tail-slot')).toBeNull()
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

  it('closing fades the body out before the space collapses (phase order + endpoints)', async () => {
    const { rerender } = render(<SegmentFoldTransition folded={false} renderBody={body} />)
    rerender(<SegmentFoldTransition folded renderBody={body} />)

    // Fade starts immediately; the space motion is delayed until the body is
    // effectively invisible, so no readable row is ever cut by a moving clip.
    const fadeDuration = Number.parseFloat(cssVar('--fold-fade-duration'))
    const fadeDelay = Number.parseFloat(cssVar('--fold-fade-delay'))
    const spaceDelay = Number.parseFloat(cssVar('--fold-space-delay'))
    const spaceDuration = Number.parseFloat(cssVar('--fold-space-duration'))
    expect(fadeDelay, 'the fade owns the first frame').toBe(0)
    expect(spaceDelay, 'the space motion must not start on the first frame').toBeGreaterThan(0)
    expect(spaceDelay, 'the space motion starts while the fade is finishing (one gesture)').toBeLessThanOrEqual(
      fadeDuration
    )
    expect(spaceDelay, 'the body is effectively faded out before the space collapses').toBeGreaterThanOrEqual(
      fadeDuration * 0.6
    )
    expect(spaceDuration).toBeGreaterThan(0)
    // The fade-only lead is a window in which the flow does not move at all:
    // the rows above the group stay put only while the layout is changing, so a
    // long lead measurably drifts them (100ms lead ≈ 3-4px, 40ms lead ≤1px of
    // anchor drift on the row above). Keep it short — a fast fade is the point.
    expect(fadeDuration, 'the fade-only lead stays short enough to hold the rows above').toBeLessThanOrEqual(60)

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

  it('plays a space-then-fade enter motion when a folded group expands and settles into the plain body', async () => {
    const { rerender } = render(<SegmentFoldTransition folded renderBody={body} />)
    expect(screen.queryByTestId('body')).toBeNull()

    rerender(<SegmentFoldTransition folded={false} renderBody={body} />)
    expect(screen.getByTestId('body').textContent).toBe('include-folded/live')
    expect(motionHost().getAttribute('data-segment-fold-phase')).toBe('opening')

    // The space opens first and the body stays invisible until it is open: the
    // fade is delayed past most of the expansion, so no boundary is left when
    // the text becomes visible.
    const spaceDelay = Number.parseFloat(cssVar('--fold-space-delay'))
    const spaceDuration = Number.parseFloat(cssVar('--fold-space-duration'))
    const fadeDelay = Number.parseFloat(cssVar('--fold-fade-delay'))
    expect(spaceDelay, 'the space motion owns the first frame').toBe(0)
    expect(fadeDelay, 'the body must not become visible while the space is still moving').toBeGreaterThan(0)
    expect(fadeDelay, 'the fade follows the expansion (one gesture, no dead time)').toBeGreaterThanOrEqual(
      spaceDuration * 0.7
    )
    expect(cssVar('--fold-height-from')).toBe('0px')
    expect(cssVar('--fold-height-to')).toBe(`${MEASURED_BODY_HEIGHT}px`)
    // A settled fold starts hidden: the content must not be visible while the
    // space opens.
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

  it('reserves the minimal label slot for the flow-terminal folded group and animates into it', async () => {
    // Settled route-tail fold: the group keeps exactly the documented slot (no
    // body rows), so its collapsed pill stays inside the scrollport.
    render(<SegmentFoldTransition folded tailSlot renderBody={body} />)
    expect(screen.queryByTestId('body')).toBeNull()
    const slot = screen.getByTestId('fold-tail-slot')
    expect(slot.getAttribute('aria-hidden')).toBe('true')
    expect(animationArms, 'an already folded group never replays a motion').toHaveLength(0)
  })

  it('closes a route-tail fold onto the reserved slot instead of zero height', async () => {
    const { rerender } = render(<SegmentFoldTransition folded={false} tailSlot renderBody={body} />)
    rerender(<SegmentFoldTransition folded tailSlot renderBody={body} />)
    expect(cssVar('--fold-height-from')).toBe(`${MEASURED_BODY_HEIGHT}px`)
    expect(cssVar('--fold-height-to')).toBe(`${TAIL_SLOT_HEIGHT}px`)

    await settleArm(0)
    expect(screen.queryByTestId('body')).toBeNull()
    expect(screen.getByTestId('fold-tail-slot')).toBeTruthy()
  })

  it('opens a route-tail fold from the reserved slot height (no jump on expand)', async () => {
    const { rerender } = render(<SegmentFoldTransition folded tailSlot renderBody={body} />)
    expect(screen.getByTestId('fold-tail-slot')).toBeTruthy()
    rerender(<SegmentFoldTransition folded={false} tailSlot renderBody={body} />)
    expect(cssVar('--fold-height-from')).toBe(`${TAIL_SLOT_HEIGHT}px`)
    expect(cssVar('--fold-height-to')).toBe(`${MEASURED_BODY_HEIGHT}px`)
    await settleArm(0)
    expect(screen.getByTestId('body').textContent).toBe('visible/live')
    expect(screen.queryByTestId('fold-tail-slot')).toBeNull()
  })

  it('drops the reserved slot when the group is no longer the flow terminal', () => {
    const { rerender } = render(<SegmentFoldTransition folded tailSlot renderBody={body} />)
    expect(screen.getByTestId('fold-tail-slot')).toBeTruthy()
    // A newer message arrived below this group: the tail slot must leave with
    // the terminal position, and the folded group returns to zero flow.
    rerender(<SegmentFoldTransition folded tailSlot={false} renderBody={body} />)
    expect(screen.queryByTestId('fold-tail-slot')).toBeNull()
    expect(screen.queryByTestId('body')).toBeNull()
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
