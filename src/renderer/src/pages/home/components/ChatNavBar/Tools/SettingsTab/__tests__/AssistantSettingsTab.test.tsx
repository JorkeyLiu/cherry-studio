/**
 * AssistantSettingsTab focused renderer tests.
 *
 * An unconfigured model/provider is a valid UI state. The settings
 * drawer must not crash when `useProvider` resolves to `undefined` — which
 * happens when neither the assistant's model provider nor the global default
 * provider exists (e.g. after the CherryIN/CherryAI platform was removed and
 * migration 217 cleared the platform model references).
 *
 * These tests verify:
 *  - an unconfigured model + provider renders without throwing and without
 *    any provider-specific settings group (OpenAI / Groq);
 *  - a stale configured model whose provider no longer resolves renders
 *    without throwing and without any provider-specific settings group;
 *  - a resolved provider still renders the OpenAI group (the guard does not
 *    over-suppress the existing behavior).
 *
 * The assertions that the provider-utility functions are never invoked in the
 * undefined-provider cases pin the fix: previously
 * `isOpenAICompatibleProvider(undefined)` / `isSupportServiceTierProvider(undefined)`
 * / `isGroqSystemProvider(undefined)` threw on property access.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string) => key)
  const dispatch = vi.fn()
  const useAssistant = vi.fn()
  const useProvider = vi.fn()
  const useSettings = vi.fn(() => ({
    messageStyle: 'plain',
    fontSize: 14,
    language: 'en-us',
    showPrompt: true,
    messageFont: 'system',
    showInputEstimatedTokens: false,
    sendMessageShortcut: 'Enter',
    setSendMessageShortcut: vi.fn(),
    targetLanguage: 'en-us',
    setTargetLanguage: vi.fn(),
    pasteLongTextAsFile: false,
    renderInputMessageAsMarkdown: false,
    codeShowLineNumbers: false,
    codeCollapsible: false,
    codeWrappable: false,
    codeEditor: {
      enabled: false,
      themeLight: 'auto',
      themeDark: 'auto',
      highlightActiveLine: false,
      foldGutter: false,
      autocompletion: true,
      keymap: false
    },
    codeViewer: { themeLight: 'auto', themeDark: 'auto' },
    codeImageTools: false,
    codeExecution: { enabled: false, timeoutMinutes: 1 },
    codeFancyBlock: false,
    mathEngine: 'KaTeX',
    mathEnableSingleDollar: false,
    autoTranslateWithSpace: false,
    pasteLongTextThreshold: 1500,
    multiModelMessageStyle: 'fold',
    thoughtAutoCollapse: true,
    messageNavigation: 'buttons',
    enableQuickPanelTriggers: false,
    injectContextTimestamp: false,
    showTranslateConfirm: false,
    showMessageOutline: true,
    confirmDeleteMessage: false,
    confirmRegenerateMessage: false
  }))
  const useTheme = vi.fn(() => ({ theme: 'dark' }))
  const useCodeStyle = vi.fn(() => ({ themeNames: [] }))
  const useTranslate = vi.fn(() => ({ translateLanguages: [] }))
  const getDefaultModel = vi.fn()
  const isOpenAIModel = vi.fn()
  const isSupportVerbosityModel = vi.fn()
  const isOpenAICompatibleProvider = vi.fn()
  const isSupportServiceTierProvider = vi.fn()
  const isSupportVerbosityProvider = vi.fn()
  return {
    t,
    dispatch,
    useAssistant,
    useProvider,
    useSettings,
    useTheme,
    useCodeStyle,
    useTranslate,
    getDefaultModel,
    isOpenAIModel,
    isSupportVerbosityModel,
    isOpenAICompatibleProvider,
    isSupportServiceTierProvider,
    isSupportVerbosityProvider
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: mocks.useAssistant
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useProvider: mocks.useProvider
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: mocks.useSettings
}))

vi.mock('@renderer/hooks/useTranslate', () => ({
  default: mocks.useTranslate
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: mocks.useTheme
}))

vi.mock('@renderer/context/CodeStyleProvider', () => ({
  useCodeStyle: mocks.useCodeStyle
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultModel: mocks.getDefaultModel
}))

vi.mock('@renderer/config/translate', () => ({
  UNKNOWN: { value: 'Unknown', langCode: 'unknown', label: () => 'Unknown', emoji: '🏳️' }
}))

vi.mock('@renderer/config/models', () => ({
  isOpenAIModel: mocks.isOpenAIModel,
  isSupportVerbosityModel: mocks.isSupportVerbosityModel
}))

vi.mock('@renderer/utils/provider', () => ({
  isOpenAICompatibleProvider: mocks.isOpenAICompatibleProvider,
  isSupportServiceTierProvider: mocks.isSupportServiceTierProvider,
  isSupportVerbosityProvider: mocks.isSupportVerbosityProvider
}))

vi.mock('@renderer/components/Selector', () => ({
  default: () => null
}))

vi.mock('@renderer/components/EditableNumber', () => ({
  default: () => null
}))

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/components/TooltipIcons', () => ({
  HelpTooltip: () => null
}))

vi.mock('@renderer/pages/settings', () => ({
  SettingDivider: () => null,
  SettingRow: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SettingRowTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@renderer/pages/settings/SettingGroup', () => ({
  CollapsibleSettingGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('../OpenAISettingsGroup', () => ({
  default: () => <div data-testid="openai-settings-group" />
}))

vi.mock('../GroqSettingsGroup', () => ({
  default: () => <div data-testid="groq-settings-group" />
}))

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

import AssistantSettingsTab from '../AssistantSettingsTab'

const assistant = (overrides: Record<string, unknown> = {}) => ({
  id: 'assistant-1',
  name: 'Assistant',
  prompt: '',
  topics: [],
  type: 'assistant',
  ...overrides
})

describe('AssistantSettingsTab no-provider guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.t.mockImplementation((key: string) => key)
    mocks.getDefaultModel.mockReturnValue(undefined)
    mocks.isOpenAIModel.mockReturnValue(false)
    mocks.isSupportVerbosityModel.mockReturnValue(false)
    mocks.isOpenAICompatibleProvider.mockReturnValue(false)
    mocks.isSupportServiceTierProvider.mockReturnValue(false)
    mocks.isSupportVerbosityProvider.mockReturnValue(false)
  })

  afterEach(() => {
    cleanup()
  })

  const renderTab = (assistantState: Record<string, unknown>) => {
    mocks.useAssistant.mockReturnValue({ assistant: assistant(assistantState) })
    render(<AssistantSettingsTab assistant={assistant()} />)
  }

  it('does not crash and renders no provider-specific groups when model and provider are unconfigured', () => {
    // No assistant model and no global default model -> useProvider resolves
    // to undefined. Previously the OpenAI/Groq checks dereferenced it and
    // the drawer crashed.
    mocks.useProvider.mockReturnValue({ provider: undefined })

    expect(() => renderTab({})).not.toThrow()

    expect(screen.queryByTestId('openai-settings-group')).not.toBeInTheDocument()
    expect(screen.queryByTestId('groq-settings-group')).not.toBeInTheDocument()
    // The provider-utility checks must never run against an undefined provider.
    expect(mocks.isOpenAICompatibleProvider).not.toHaveBeenCalled()
    expect(mocks.isSupportServiceTierProvider).not.toHaveBeenCalled()
    expect(mocks.isSupportVerbosityProvider).not.toHaveBeenCalled()
  })

  it('does not crash and renders no provider-specific groups when the configured model provider is stale', () => {
    // The assistant references a provider that no longer exists (e.g. a
    // removed custom provider or the deleted CherryIN/CherryAI platform) and
    // there is no default provider to fall back to -> provider is undefined.
    mocks.useProvider.mockReturnValue({ provider: undefined })

    expect(() =>
      renderTab({
        model: { id: 'qwen', name: 'Qwen', provider: 'removed-provider', group: 'default' }
      })
    ).not.toThrow()

    expect(screen.queryByTestId('openai-settings-group')).not.toBeInTheDocument()
    expect(screen.queryByTestId('groq-settings-group')).not.toBeInTheDocument()
    expect(mocks.isOpenAICompatibleProvider).not.toHaveBeenCalled()
    expect(mocks.isSupportServiceTierProvider).not.toHaveBeenCalled()
    expect(mocks.isSupportVerbosityProvider).not.toHaveBeenCalled()
  })

  it('still renders the OpenAI group when the model provider resolves (guard does not over-suppress)', () => {
    mocks.useProvider.mockReturnValue({ provider: { id: 'openai', name: 'OpenAI', type: 'openai', models: [] } })
    mocks.isOpenAICompatibleProvider.mockReturnValue(true)

    renderTab({ model: { id: 'gpt-4', name: 'GPT-4', provider: 'openai', group: 'default' } })

    expect(screen.getByTestId('openai-settings-group')).toBeInTheDocument()
    expect(screen.queryByTestId('groq-settings-group')).not.toBeInTheDocument()
    expect(mocks.isOpenAICompatibleProvider).toHaveBeenCalled()
  })
})
