import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateProviderMock = vi.fn()
const showAnthropicMarker = 'anthropic-settings-stub'

vi.mock('@renderer/aiCore/provider/providerConfig', () => ({
  adaptProvider: ({ provider }: any) => provider
}))
vi.mock('@renderer/components/ErrorDetailModal', () => ({ showErrorDetailPopup: vi.fn() }))
vi.mock('@renderer/components/Icons', () => ({ LoadingIcon: () => <span /> }))
vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: any) => <div>{children}</div>,
  Center: ({ children }: any) => <div>{children}</div>,
  VStack: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/components/Popups/ApiKeyListPopup', () => ({
  ApiKeyListPopup: { show: vi.fn() }
}))
vi.mock('@renderer/components/Selector', () => ({ default: () => <span /> }))
vi.mock('@renderer/components/TooltipIcons', () => ({
  HelpTooltip: ({ title }: any) => <span>{title}</span>,
  InfoTooltip: ({ title }: any) => <span>{title}</span>
}))
vi.mock('@renderer/config/models', () => ({ isRerankModel: () => false }))
vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('@renderer/hooks/useTimer', () => ({ useTimer: () => ({ setTimeoutTimer: vi.fn() }) }))
vi.mock('@renderer/pages/settings/ProviderSettings/AnthropicSettings', () => ({
  default: () => <div data-testid={showAnthropicMarker} />
}))
vi.mock('@renderer/pages/settings/ProviderSettings/ModelList', () => ({
  ModelList: () => <div />
}))
vi.mock('@renderer/services/ApiService', () => ({ checkApi: vi.fn() }))
vi.mock('@renderer/services/ProviderService', () => ({ isProviderSupportAuth: () => false }))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k, i18n: { t: (k: string) => k } }) }
})

const providerState = { current: 'openai' }
const sentinelApiOptions = { isNotSupportStreamOptions: true, customFlag: 'sentinel-keep' }

vi.mock('@renderer/hooks/useProvider', () => ({
  useAllProviders: () => [],
  useProviders: () => ({ updateProviders: vi.fn() }),
  useProvider: () => {
    const id = providerState.current
    const base: any = {
      id,
      type: id === 'anthropic-oauth' ? 'anthropic' : id === 'gemini-conn' ? 'gemini' : 'openai',
      name: id,
      apiKey: id === 'stored-key-conn' ? 'sk-stored-keep' : '',
      apiHost: 'https://api.example.com',
      models: [],
      enabled: true,
      apiOptions: {},
      authType: id === 'anthropic-oauth' ? 'oauth' : 'apiKey'
    }
    if (id === 'no-key-conn') {
      base.apiOptions = { requiresApiKey: false }
    }
    if (id === 'stored-key-conn') {
      base.apiKey = 'sk-stored-keep'
      base.apiOptions = { requiresApiKey: false }
    }
    if (id === 'sentinel-conn') {
      base.apiOptions = { ...sentinelApiOptions }
    }
    return { provider: base, models: [], updateProvider: updateProviderMock }
  }
}))

vi.mock('@renderer/pages/settings/ProviderSettings/ApiOptionsSettings/ApiOptionsSettingsPopup', () => ({
  default: { show: vi.fn() }
}))
vi.mock('@renderer/pages/settings/ProviderSettings/CustomHeaderPopup', () => ({
  default: { show: vi.fn() }
}))
vi.mock('@renderer/pages/settings/ProviderSettings/SelectProviderModelPopup', () => ({
  default: { show: vi.fn() }
}))
vi.mock('@renderer/pages/settings', () => ({
  SettingContainer: ({ children }: any) => <div>{children}</div>,
  SettingHelpText: ({ children, id }: any) => <span id={id}>{children}</span>,
  SettingHelpTextRow: ({ children }: any) => <div>{children}</div>,
  SettingSubtitle: ({ children }: any) => <div>{children}</div>,
  SettingTitle: ({ children }: any) => <div>{children}</div>
}))

import ApiOptionsSettings from '../ApiOptionsSettings/ApiOptionsSettings'
import ProviderSetting from '../ProviderSetting'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  providerState.current = 'openai'
})

describe('ProviderSetting requiresApiKey control — removed from API Key section', () => {
  it('does NOT expose Require API key toggle in the API Key header and help text is no longer visible there', async () => {
    providerState.current = 'openai'
    render(<ProviderSetting providerId="openai" />)
    expect(screen.queryByLabelText('settings.provider.require_api_key.label')).not.toBeInTheDocument()
    // visible help text row that previously showed tip must be absent; only api_key.tip remains
    expect(screen.queryByText('settings.provider.require_api_key.tip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('require-api-key-tip')).not.toBeInTheDocument()
    // API key label and input remain
    expect(screen.getByText('settings.provider.api_key.label')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('settings.provider.api_key.label')).toBeInTheDocument()
    // Input must be enabled when requiresApiKey is unset (defaults to true)
    const input = screen.getByPlaceholderText('settings.provider.api_key.label') as HTMLInputElement
    expect(input.disabled).toBe(false)
    // api_key.tip should still be present (not removed)
    expect(screen.getByText('settings.provider.api_key.tip')).toBeInTheDocument()
  })

  it('disables the API Key password input while retaining stored key semantics when requiresApiKey is false (switch lives in API Settings)', async () => {
    providerState.current = 'no-key-conn'
    render(<ProviderSetting providerId="no-key-conn" />)
    // switch absent in this section even when disabled state
    expect(screen.queryByLabelText('settings.provider.require_api_key.label')).not.toBeInTheDocument()
    const input = screen.getByPlaceholderText('settings.provider.api_key.label') as HTMLInputElement
    expect(input.disabled).toBe(true)
    cleanup()
    // Stored key is retained: provider with stored key and requiresApiKey:false still shows value and disabled
    providerState.current = 'stored-key-conn'
    render(<ProviderSetting providerId="stored-key-conn" />)
    const storedInput = screen.getByPlaceholderText('settings.provider.api_key.label') as HTMLInputElement
    expect(storedInput.value).toBe('sk-stored-keep')
    expect(storedInput.disabled).toBe(true)
    expect(screen.queryByLabelText('settings.provider.require_api_key.label')).not.toBeInTheDocument()
  })

  it('does not show header-anchored control for gemini protocol either — control lives in API Settings popup', async () => {
    providerState.current = 'gemini-conn'
    render(<ProviderSetting providerId="gemini-conn" />)
    expect(screen.queryByLabelText('settings.provider.require_api_key.label')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.provider.require_api_key.tip')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('settings.provider.api_key.label')).toBeInTheDocument()
  })

  it('preserves OAuth special handling: API key row hidden when anthropic oauth (and Require switch absent there)', async () => {
    providerState.current = 'anthropic-oauth'
    render(<ProviderSetting providerId="anthropic-oauth" />)
    expect(await screen.findByTestId(showAnthropicMarker)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('settings.provider.api_key.label')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('settings.provider.require_api_key.label')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.provider.require_api_key.tip')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.provider.check')).not.toBeInTheDocument()
  })
})

describe('ApiOptionsSettings requiresApiKey row — relocated control', () => {
  it('exposes Require API key toggle as an API Settings popup row using existing label and InfoTooltip tip', async () => {
    providerState.current = 'openai'
    render(<ApiOptionsSettings providerId="openai" />)
    const requireSwitch = await screen.findByLabelText('settings.provider.require_api_key.label')
    expect(requireSwitch).toBeInTheDocument()
    expect(requireSwitch).toBeChecked()
    // label text rendered via <label htmlFor>
    expect(screen.getByText('settings.provider.require_api_key.label')).toBeInTheDocument()
    // InfoTooltip pattern: title is the tip sentence
    expect(screen.getByText('settings.provider.require_api_key.tip')).toBeInTheDocument()
  })

  it('starts checked when requiresApiKey is unset, and toggling OFF preserves the exact sentinel payload', async () => {
    providerState.current = 'sentinel-conn'
    const user = userEvent.setup()
    render(<ApiOptionsSettings providerId="sentinel-conn" />)
    const requireKeySwitch = await screen.findByLabelText('settings.provider.require_api_key.label')
    expect(requireKeySwitch).toBeChecked()
    await user.click(requireKeySwitch)
    expect(updateProviderMock).toHaveBeenCalledTimes(1)
    expect(updateProviderMock).toHaveBeenCalledWith({
      apiOptions: { ...sentinelApiOptions, requiresApiKey: false }
    })
  })

  it('reflects unchecked when requiresApiKey is false and toggles back to true preserving other options', async () => {
    providerState.current = 'no-key-conn'
    const user = userEvent.setup()
    render(<ApiOptionsSettings providerId="no-key-conn" />)
    const requireSwitch = await screen.findByLabelText('settings.provider.require_api_key.label')
    expect(requireSwitch).not.toBeChecked()
    await user.click(requireSwitch)
    expect(updateProviderMock).toHaveBeenCalledWith({
      apiOptions: { requiresApiKey: true }
    })
  })

  it('shows the same row for gemini protocol', async () => {
    providerState.current = 'gemini-conn'
    render(<ApiOptionsSettings providerId="gemini-conn" />)
    expect(await screen.findByLabelText('settings.provider.require_api_key.label')).toBeInTheDocument()
  })
})

describe('Anthropic OAuth settings', () => {
  it('still renders when authType is oauth', async () => {
    providerState.current = 'anthropic-oauth'
    render(<ProviderSetting providerId="anthropic-oauth" />)
    expect(await screen.findByTestId(showAnthropicMarker)).toBeInTheDocument()
  })
})
