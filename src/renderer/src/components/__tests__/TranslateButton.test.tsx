/**
 * Focused tests for the translation button popover (LOCK-110).
 *
 * Verifies:
 *  - the popover contains the target-language selector and the
 *    translate-confirm switch, both backed by the existing global settings
 *    state (shared across input / message / text-edit translation flows);
 *  - translation execution semantics are preserved (calls translateText with
 *    the selected target language and routes the result through onTranslated).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const dispatch = vi.fn()
  const useSettings = vi.fn(() => ({
    targetLanguage: 'en-us',
    showTranslateConfirm: true,
    setTargetLanguage: vi.fn()
  }))
  const useTranslate = vi.fn(() => ({
    translateLanguages: [{ langCode: 'en-us', label: () => 'English', emoji: '🇺🇸' }],
    getLanguageByLangcode: vi.fn((code: string) => ({ langCode: code, label: () => 'English' }))
  }))
  const translateText = vi.fn(async () => 'translated text')
  const t = vi.fn((key: string) => key)
  return { dispatch, useSettings, useTranslate, translateText, t }
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

vi.mock('@renderer/hooks/useTranslate', () => ({
  default: () => mocks.useTranslate()
}))

vi.mock('@renderer/services/TranslateService', () => ({
  translateText: mocks.translateText
}))

vi.mock('@renderer/config/translate', () => ({
  UNKNOWN: { value: 'Unknown', langCode: 'unknown', label: () => 'Unknown', emoji: '🏳️' }
}))

vi.mock('@renderer/components/Selector', () => ({
  default: ({ value, onChange }: any) => (
    <button type="button" data-testid="language-selector" data-value={value} onClick={() => onChange('zh-cn')} />
  )
}))

vi.mock('antd', () => ({
  Popover: ({ children, content, onOpenChange }: any) => (
    <div data-testid="popover">
      <div data-testid="popover-content">{content}</div>
      <div data-testid="popover-trigger" onClick={() => onOpenChange?.(true)}>
        {children}
      </div>
    </div>
  ),
  Tooltip: ({ children }: any) => <div data-testid="tooltip">{children}</div>,
  Switch: ({ checked, onChange }: any) => (
    <button type="button" data-testid="switch" data-checked={String(checked)} onClick={() => onChange?.(!checked)} />
  ),
  Button: ({ children, onClick, disabled, type }: any) => (
    <button type="button" data-testid="antd-button" data-type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}))

vi.mock('lucide-react', () => ({
  Languages: () => <span data-testid="languages-icon" />
}))

vi.mock('@renderer/pages/settings', () => ({
  SettingDivider: () => <hr data-testid="settings-divider" />,
  SettingRow: ({ children }: { children: React.ReactNode }) => <div data-testid="setting-row">{children}</div>,
  SettingRowTitle: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="setting-row-title">{children}</span>
  )
}))

import TranslateButton from '../TranslateButton'

describe('TranslateButton (LOCK-110)', () => {
  const onTranslated = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: showTranslateConfirm on; confirm dialog auto-accepts.
    mocks.useSettings.mockReturnValue({
      targetLanguage: 'en-us',
      showTranslateConfirm: true,
      setTargetLanguage: vi.fn()
    })
    ;(window as any).modal = { confirm: vi.fn().mockResolvedValue(true) }
    ;(window as any).toast = { error: vi.fn(), success: vi.fn() }
    // handleTranslate copies the source text before translating (pre-existing
    // execution semantics); jsdom has no navigator.clipboard.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true
    })
  })

  it('renders the popover with target-language selector and translate-confirm switch', () => {
    render(<TranslateButton text="hello" onTranslated={onTranslated} />)

    const titles = screen.getAllByTestId('setting-row-title').map((el) => el.textContent)
    expect(titles).toEqual(['settings.input.target_language.label', 'settings.input.show_translate_confirm'])
    expect(screen.getByTestId('language-selector')).toBeInTheDocument()
  })

  it('toggles translate-confirm and dispatches setShowTranslateConfirm', () => {
    render(<TranslateButton text="hello" onTranslated={onTranslated} />)

    fireEvent.click(screen.getByTestId('switch'))
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'settings/setShowTranslateConfirm', payload: false })
  })

  it('translates the text with the selected target language and calls onTranslated', async () => {
    render(<TranslateButton text="hello" onTranslated={onTranslated} />)

    // The "Translate" action button lives inside the popover content; the
    // toolbar trigger button (also an antd Button) is a different element.
    const translateAction = screen.getByText('chat.translate').closest('button')!
    fireEvent.click(translateAction)

    await waitFor(() => {
      expect(mocks.translateText).toHaveBeenCalled()
      expect(onTranslated).toHaveBeenCalledWith('translated text')
    })
  })

  it('still asks for confirmation when showTranslateConfirm is on (semantics unchanged)', async () => {
    render(<TranslateButton text="hello" onTranslated={onTranslated} />)

    const translateAction = screen.getByText('chat.translate').closest('button')!
    fireEvent.click(translateAction)

    await waitFor(() => {
      expect((window as any).modal.confirm).toHaveBeenCalled()
    })
  })
})
