/**
 * Focused tests for the input-settings popover.
 *
 * Verifies:
 *  - the five rows render in the specified order;
 *  - the paste-long-text threshold row appears only when paste-long-text is
 *    enabled (and is hidden otherwise);
 *  - toggles dispatch the corresponding actions.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const dispatch = vi.fn()
  const defaultSettings = {
    pasteLongTextAsFile: false,
    pasteLongTextThreshold: 1500,
    renderInputMessageAsMarkdown: false,
    enableQuickPanelTriggers: false,
    sendMessageShortcut: 'Enter',
    setSendMessageShortcut: vi.fn()
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
  Popover: ({ children, content }: any) => (
    <div data-testid="popover-trigger">
      <div data-testid="popover-content">{content}</div>
      {children}
    </div>
  ),
  Switch: ({ checked, onChange }: any) => (
    <button type="button" data-testid="switch" data-checked={String(checked)} onClick={() => onChange?.(!checked)} />
  )
}))

vi.mock('lucide-react', () => ({
  Settings2: () => <span data-testid="settings-icon" />
}))

vi.mock('@renderer/components/Selector', () => ({
  default: () => <div data-testid="selector" />
}))

vi.mock('@renderer/components/EditableNumber', () => ({
  default: () => <div data-testid="editable-number" />
}))

import InputbarSettings from '../InputbarSettings'

describe('InputbarSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings })
  })

  it('renders the five rows in the specified order with paste-long-text off', () => {
    render(<InputbarSettings />)

    const titles = screen.getAllByTestId('setting-row-title').map((el) => el.textContent)
    expect(titles).toEqual([
      'settings.messages.input.paste_long_text_as_file',
      'settings.messages.markdown_rendering_input_message',
      'settings.messages.input.enable_quick_triggers',
      'settings.messages.input.send_shortcuts'
    ])
    // Threshold row is hidden while paste-long-text is disabled
    expect(screen.queryByTestId('editable-number')).not.toBeInTheDocument()
  })

  it('shows the threshold row when paste-long-text is enabled', () => {
    mocks.useSettings.mockReturnValue({ ...mocks.defaultSettings, pasteLongTextAsFile: true })
    render(<InputbarSettings />)

    const titles = screen.getAllByTestId('setting-row-title').map((el) => el.textContent)
    expect(titles).toEqual([
      'settings.messages.input.paste_long_text_as_file',
      'settings.messages.input.paste_long_text_threshold',
      'settings.messages.markdown_rendering_input_message',
      'settings.messages.input.enable_quick_triggers',
      'settings.messages.input.send_shortcuts'
    ])
    expect(screen.getByTestId('editable-number')).toBeInTheDocument()
  })

  it('toggles paste-long-text and dispatches setPasteLongTextAsFile', () => {
    render(<InputbarSettings />)

    fireEvent.click(screen.getAllByTestId('switch')[0])
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setPasteLongTextAsFile', payload: true })
  })

  it('toggles render-input-as-markdown and quick-menu triggers', () => {
    render(<InputbarSettings />)

    // Switches with paste off: [paste(0), markdown(1), quick triggers(2)]
    fireEvent.click(screen.getAllByTestId('switch')[1])
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setRenderInputMessageAsMarkdown', payload: true })

    vi.clearAllMocks()
    fireEvent.click(screen.getAllByTestId('switch')[2])
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setEnableQuickPanelTriggers', payload: true })
  })
})
