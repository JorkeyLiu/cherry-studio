import { render, screen } from '@testing-library/react'
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
  HelpTooltip: () => <span />,
  InfoTooltip: () => <span />
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
      type: id === 'anthropic-oauth' ? 'anthropic' : 'openai',
      name: id,
      apiKey: '',
      apiHost: 'https://api.example.com',
      models: [],
      enabled: true,
      apiOptions: {},
      authType: id === 'anthropic-oauth' ? 'oauth' : 'apiKey'
    }
    if (id === 'no-key-conn') {
      base.apiOptions = { requiresApiKey: false }
    }
    if (id === 'sentinel-conn') {
      // requiresApiKey unset (toggle starts checked); sentinel fields must survive the toggle.
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
  SettingHelpText: ({ children }: any) => <span>{children}</span>,
  SettingHelpTextRow: ({ children }: any) => <div>{children}</div>,
  SettingSubtitle: ({ children }: any) => <div>{children}</div>,
  SettingTitle: ({ children }: any) => <div>{children}</div>
}))

import ProviderSetting from '../ProviderSetting'

beforeEach(() => {
  vi.clearAllMocks()
  providerState.current = 'openai'
})

describe('ProviderSetting requiresApiKey control', () => {
  it('exposes a protocol-neutral Require API key toggle for any connection', async () => {
    providerState.current = 'openai'
    render(<ProviderSetting providerId="openai" />)
    expect(await screen.findByText('settings.provider.require_api_key.label')).toBeInTheDocument()
    expect(screen.getByText('settings.provider.require_api_key.tip')).toBeInTheDocument()
  })

  it('starts checked when requiresApiKey is unset, and toggling OFF preserves the exact sentinel payload', async () => {
    providerState.current = 'sentinel-conn'
    const user = userEvent.setup()
    render(<ProviderSetting providerId="sentinel-conn" />)
    expect(await screen.findByText('settings.provider.require_api_key.label')).toBeInTheDocument()
    const switches = screen.getAllByRole('switch')
    // First switch is provider.enabled; last is the Require API key control.
    const requireKeySwitch = switches[switches.length - 1]
    expect(requireKeySwitch).toBeChecked()
    await user.click(requireKeySwitch)
    expect(updateProviderMock).toHaveBeenCalledTimes(1)
    expect(updateProviderMock).toHaveBeenCalledWith({
      apiOptions: { ...sentinelApiOptions, requiresApiKey: false }
    })
  })

  it('shows the same control for anthropic/gemini protocols', async () => {
    providerState.current = 'anthropic-oauth'
    render(<ProviderSetting providerId="anthropic-oauth" />)
    expect(await screen.findByText('settings.provider.require_api_key.label')).toBeInTheDocument()
  })
})

describe('Anthropic OAuth settings', () => {
  it('still renders when authType is oauth', async () => {
    providerState.current = 'anthropic-oauth'
    render(<ProviderSetting providerId="anthropic-oauth" />)
    expect(await screen.findByTestId(showAnthropicMarker)).toBeInTheDocument()
  })
})
