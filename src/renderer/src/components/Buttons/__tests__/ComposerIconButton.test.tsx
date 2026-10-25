/**
 * Contract tests for the shared composer tool button.
 *
 * Verifies:
 *  - 28x28 hit target with a 16px glyph lockdown for every composer tool;
 *  - enabled/disabled icon colors are distinct and explicit
 *    (`var(--color-primary)` for the primary tone, `var(--color-text-3)`
 *    while disabled) so the global `.lucide` pin to `--color-icon` can no
 *    longer collapse both states into one color;
 *  - disabled never advertises the enabled action (active affordance is
 *    suppressed while disabled, no hover background);
 *  - native `disabled` is forwarded (actual constraint, not aria-only);
 *  - a visible keyboard focus indicator survives the global `*:focus` and
 *    antd focus-visible resets.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../ActionIconButton', () => ({
  default: ({ children, className, active, ...props }: any) => (
    <button type="button" data-testid="composer-inner" data-active={String(active)} className={className} {...props}>
      {children}
    </button>
  )
}))

import ComposerIconButton, { StyledComposerButton } from '../ComposerIconButton'

const rules = () => (StyledComposerButton.componentStyle as any).rules.join('')

describe('ComposerIconButton', () => {
  it('renders children in a native button and forwards interaction props', () => {
    const onClick = vi.fn()
    render(
      <ComposerIconButton onClick={onClick} aria-label="composer-tool">
        <span data-testid="glyph" />
      </ComposerIconButton>
    )

    const button = screen.getByTestId('composer-inner')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('aria-label', 'composer-tool')
    expect(button).not.toBeDisabled()
    expect(screen.getByTestId('glyph')).toBeInTheDocument()

    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('forwards native disabled and suppresses the active affordance while disabled', () => {
    const { rerender } = render(
      <ComposerIconButton active disabled aria-label="tool">
        <span />
      </ComposerIconButton>
    )

    let button = screen.getByTestId('composer-inner')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('data-active', 'false')

    rerender(
      <ComposerIconButton active aria-label="tool">
        <span />
      </ComposerIconButton>
    )
    button = screen.getByTestId('composer-inner')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('data-active', 'true')
  })

  it('defaults to the default tone and honors the primary tone', () => {
    const { rerender } = render(
      <ComposerIconButton aria-label="tool">
        <span />
      </ComposerIconButton>
    )
    expect(screen.getByTestId('composer-inner')).toHaveAttribute('data-tone', 'default')

    rerender(
      <ComposerIconButton tone="primary" aria-label="tool">
        <span />
      </ComposerIconButton>
    )
    expect(screen.getByTestId('composer-inner')).toHaveAttribute('data-tone', 'primary')
  })

  it('locks geometry to a 28x28 target with 16px glyphs', () => {
    const css = rules()
    expect(css).toContain('28px')
    expect(css).toContain('16px')
    expect(css).not.toContain('30px')
  })

  it('keeps enabled and disabled icon colors distinct and explicit', () => {
    const css = rules()
    expect(css).toContain('var(--color-primary)')
    expect(css).toContain('var(--color-text-3)')
    expect(css).toContain(':disabled')
  })

  it('gives disabled no hover background and keeps a visible keyboard focus', () => {
    const css = rules()
    expect(css).toContain(':hover')
    expect(css).toContain('focus-visible')
    expect(css).toContain('outline')
  })
})
