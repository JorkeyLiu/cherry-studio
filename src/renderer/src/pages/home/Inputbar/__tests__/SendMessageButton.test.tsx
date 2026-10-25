/**
 * Regression tests for the composer send control.
 *
 * The previous bespoke `styled.button` relied on a custom `onKeyDown` on top
 * of native button synthesis (double-fire risk), carried no native
 * `disabled` (aria-only constraint), had no hover/focus affordance, and set
 * its color inline on the button — which the global
 * `.lucide:not(.lucide-custom)` pin to `--color-icon` silently overrode, so
 * enabled and disabled rendered the same color.
 *
 * Verifies:
 *  - native `disabled` attribute in the disabled state (and its absence when
 *    enabled), with the primary tone contract (`data-tone="primary"`);
 *  - click fires `sendMessage` exactly once when enabled, never when disabled;
 *  - no custom key synthesis path exists: raw keyDown alone never sends;
 *  - native keyboard activation (Enter/Space on the focused native button)
 *    fires exactly once when enabled, never when disabled;
 *  - tooltip title, accessible label, and 16px glyph.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock('antd', async () => {
  const actual: any = await vi.importActual('antd')
  return {
    ...actual,
    Tooltip: ({ children, title }: any) => (
      <div data-testid="send-tooltip" data-title={typeof title === 'string' ? title : ''}>
        {children}
      </div>
    )
  }
})

import SendMessageButton from '../SendMessageButton'

const getButton = () => screen.getByTestId('send-message-button')

describe('SendMessageButton', () => {
  it('renders enabled with the primary tone, label, tooltip, and 16px glyph', () => {
    render(<SendMessageButton disabled={false} sendMessage={vi.fn()} />)

    const button = getButton()
    expect(button.tagName).toBe('BUTTON')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('data-tone', 'primary')
    expect(button).toHaveAttribute('aria-label', 'chat.input.send')
    expect(screen.getByTestId('send-tooltip')).toHaveAttribute('data-title', 'chat.input.send')

    const glyph = button.querySelector('svg.lucide')
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute('width')).toBe('16')
    expect(glyph?.getAttribute('height')).toBe('16')
  })

  it('renders disabled with a native disabled constraint', () => {
    render(<SendMessageButton disabled={true} sendMessage={vi.fn()} />)

    const button = getButton()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('disabled')
  })

  it('fires click exactly once when enabled and never when disabled', () => {
    const onSend = vi.fn()
    const { rerender } = render(<SendMessageButton disabled={false} sendMessage={onSend} />)

    fireEvent.click(getButton())
    expect(onSend).toHaveBeenCalledTimes(1)

    rerender(<SendMessageButton disabled={true} sendMessage={onSend} />)
    fireEvent.click(getButton())
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('has no custom key synthesis path: raw keyDown alone never sends', () => {
    const onSend = vi.fn()
    render(<SendMessageButton disabled={false} sendMessage={onSend} />)

    const button = getButton()
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.keyDown(button, { key: 'a' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('activates natively via Enter and Space exactly once when enabled', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<SendMessageButton disabled={false} sendMessage={onSend} />)

    const button = getButton()
    button.focus()
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)

    await user.keyboard(' ')
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('never activates via keyboard when disabled', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<SendMessageButton disabled={true} sendMessage={onSend} />)

    const button = getButton()
    button.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    fireEvent.click(button)
    expect(onSend).not.toHaveBeenCalled()
  })
})
