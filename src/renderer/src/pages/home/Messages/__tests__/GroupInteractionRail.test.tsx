import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  INTERACTION_RAIL_COLLAPSED_HEIGHT_PX,
  INTERACTION_RAIL_HIT_WIDTH_PX,
  INTERACTION_RAIL_LINE_WIDTH_PX,
  InteractionRailHitTarget,
  InteractionRailLine
} from '../GroupInteractionRail'

/**
 * Direct contract of the shared interaction rail: the single stroke / hit /
 * hover / focus styling the fold and the message-group edge both use. Pixel
 * defaults stay the group rail's own (2px line, 8px hit, 20px collapsed
 * short line); behavior differences (fold expands, group opens a menu) live
 * with the callers and never in this file.
 */
describe('GroupInteractionRail', () => {
  it('keeps the group rail pixel defaults (2px line, 8px hit, 20px collapsed)', () => {
    expect(INTERACTION_RAIL_LINE_WIDTH_PX).toBe(2)
    expect(INTERACTION_RAIL_HIT_WIDTH_PX).toBe(8)
    expect(INTERACTION_RAIL_COLLAPSED_HEIGHT_PX).toBe(20)
  })

  it('renders a line that only brightens when active (no width change, no tooltip)', () => {
    const { rerender } = render(<InteractionRailLine $color="var(--color-border)" $active={false} />)
    const line = document.querySelector('div')
    expect(line).not.toBeNull()
    // No tooltip or business semantics on the shared primitive.
    expect(line?.getAttribute('title')).toBeNull()

    rerender(<InteractionRailLine $color="var(--color-border)" $active={true} />)
    expect(document.querySelector('div')).not.toBeNull()
  })

  it('paints the optional caller active color instead of the group brightness lift', () => {
    render(<InteractionRailLine $color="var(--color-border)" $active $activeColor="var(--color-primary)" />)
    const css = Array.from(document.querySelectorAll('style'))
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ''))
      .join('')
    // The fold branch: a clearly visible color, same 2px stroke, no width change.
    expect(css).toContain('background-color:var(--color-primary)')
    expect(css).toContain('width:2px')
    // The line is an explicit block box, never inline-sized.
    expect(css).toContain('display:block')
    expect(css).toContain('box-sizing:border-box')
  })

  it('keeps the group brightness-only rule when no active color is given', () => {
    render(<InteractionRailLine $color="var(--color-border)" $active />)
    const css = Array.from(document.querySelectorAll('style'))
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ''))
      .join('')
    // The group branch is untouched: brightness lift, idle color kept.
    expect(css).toContain('brightness(1.35)')
    expect(css).toContain('background-color:var(--color-border)')
  })

  it('renders a transparent hit target that stays a focusable button with no title', () => {
    render(<InteractionRailHitTarget type="button" data-testid="shared-rail-hit" aria-label="rail" />)
    const hit = screen.getByTestId('shared-rail-hit')
    expect(hit.tagName).toBe('BUTTON')
    expect(hit).not.toHaveAttribute('title')
  })
})
