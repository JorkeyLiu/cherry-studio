/**
 * Focused tests for the message-settings popover.
 *
 * Verifies:
 *  - the compact popover content renders the six rows in order, with the
 *    font-size row last and no show-prompt row;
 *  - boolean rows use switches and dispatch the corresponding actions;
 *  - the font-size stepper (12–22, step 1) dispatches on minus/plus and
 *    resets to 14 when the displayed value is activated;
 *  - the minus/plus/reset controls are real keyboard-focusable buttons with
 *    accessible translated labels, and the reset value responds to Enter/Space.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const dispatch = vi.fn()
  const defaultSettings = {
    fontSize: 14,
    showMessageOutline: false,
    messageNavigation: false,
    injectContextTimestamp: false,
    confirmDeleteMessage: true,
    confirmRegenerateMessage: true
  }
  const useSettings = vi.fn(() => ({ ...defaultSettings }))
  const t = vi.fn((key: string) => key)
  return { dispatch, useSettings, t, defaultSettings }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => mocks.useSettings()
}))

vi.mock('@renderer/pages/settings', () => ({
  SettingDivider: () => <hr data-testid="settings-divider" />,
  SettingRow: ({ children }: { children: React.ReactNode }) => <div data-testid="setting-row">{children}</div>,
  SettingRowTitle: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="setting-row-title">{children}</span>
  )
}))

vi.mock('antd', () => ({
  Switch: ({ checked, onChange, 'aria-label': ariaLabel }: any) => (
    <button
      type="button"
      data-testid="switch"
      data-checked={String(checked)}
      aria-label={ariaLabel}
      onClick={() => onChange?.(!checked)}
    />
  )
}))

vi.mock('lucide-react', () => ({
  Minus: () => <span data-testid="minus-icon" />,
  Plus: () => <span data-testid="plus-icon" />
}))

import MessageSettings from '../MessageSettings'

describe('MessageSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings })
  })

  it('renders the six rows in the specified order with font size last and no show-prompt row', () => {
    render(<MessageSettings />)

    const titles = screen.getAllByTestId('setting-row-title').map((el) => el.textContent)
    expect(titles).toEqual([
      'settings.messages.show_message_outline',
      'settings.messages.navigation.label',
      'settings.messages.inject_context_timestamp',
      'settings.messages.input.confirm_delete_message',
      'settings.messages.input.confirm_regenerate_message',
      'settings.font_size.title'
    ])
    // The show-prompt row is removed from the UI.
    expect(titles).not.toContain('settings.messages.prompt')
  })

  it('toggles conversation navigation and dispatches setMessageNavigation (boolean)', () => {
    render(<MessageSettings />)

    const switches = screen.getAllByTestId('switch')
    // Row 2 is conversation navigation — the second switch.
    fireEvent.click(switches[1])

    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setMessageNavigation', payload: true })
  })

  it('toggles confirm-delete and confirm-regenerate rows', () => {
    render(<MessageSettings />)

    const switches = screen.getAllByTestId('switch')
    // Row 4 is confirm delete — the fourth switch.
    fireEvent.click(switches[3])
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setConfirmDeleteMessage', payload: false })

    // Row 5 is confirm regenerate — the fifth switch.
    fireEvent.click(switches[4])
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setConfirmRegenerateMessage', payload: false })
  })

  it('decrements font size with the minus stepper, clamped at 12', () => {
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings, fontSize: 14 })
    const { unmount } = render(<MessageSettings />)

    const minusButton = screen.getByRole('button', { name: 'common.decrease' })
    fireEvent.click(minusButton)
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setFontSize', payload: 13 })

    // Clamp at the lower bound: a fresh instance at fontSize 12 cannot go below.
    unmount()
    vi.clearAllMocks()
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings, fontSize: 12 })
    render(<MessageSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'common.decrease' }))
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setFontSize', payload: 12 })
  })

  it('increments font size with the plus stepper, clamped at 22', () => {
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings, fontSize: 14 })
    const { unmount } = render(<MessageSettings />)

    const plusButton = screen.getByRole('button', { name: 'common.increase' })
    fireEvent.click(plusButton)
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setFontSize', payload: 15 })

    // Clamp at the upper bound: a fresh instance at fontSize 22 cannot go above.
    unmount()
    vi.clearAllMocks()
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings, fontSize: 22 })
    render(<MessageSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'common.increase' }))
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setFontSize', payload: 22 })
  })

  it('clicking the displayed value resets the font size to 14', () => {
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings, fontSize: 20 })
    render(<MessageSettings />)

    const valueButton = screen.getByRole('button', { name: 'common.default' })
    fireEvent.click(valueButton)

    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setFontSize', payload: 14 })
  })

  it('renders minus, value, and plus as focusable buttons with accessible labels', () => {
    render(<MessageSettings />)

    const minusButton = screen.getByRole('button', { name: 'common.decrease' })
    const valueButton = screen.getByRole('button', { name: 'common.default' })
    const plusButton = screen.getByRole('button', { name: 'common.increase' })

    expect(minusButton).not.toHaveAttribute('tabindex', '-1')
    expect(valueButton).not.toHaveAttribute('tabindex', '-1')
    expect(plusButton).not.toHaveAttribute('tabindex', '-1')
    // The reset button keeps a visible hint (title) in addition to its label.
    expect(valueButton).toHaveAttribute('title', 'common.default')
  })

  it('resets the font size when the value button is activated with Enter', async () => {
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings, fontSize: 18 })
    render(<MessageSettings />)

    const valueButton = screen.getByRole('button', { name: 'common.default' })
    valueButton.focus()
    await userEvent.keyboard('{Enter}')

    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setFontSize', payload: 14 })
  })

  it('resets the font size when the value button is activated with Space', async () => {
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings, fontSize: 18 })
    render(<MessageSettings />)

    const valueButton = screen.getByRole('button', { name: 'common.default' })
    valueButton.focus()
    await userEvent.keyboard(' ')

    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setFontSize', payload: 14 })
  })
})
