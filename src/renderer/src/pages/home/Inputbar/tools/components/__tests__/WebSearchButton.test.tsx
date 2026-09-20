import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import WebSearchButton from '../WebSearchButton'

const mockUseAssistant = vi.fn()
const mockUseWebSearchProviders = vi.fn()
const mockIsWebSearchEnabled = vi.fn()
const mockUseTranslation = vi.fn()

vi.mock('react-i18next', async () => {
  const actual: any = await vi.importActual('react-i18next')
  return {
    ...actual,
    useTranslation: () => mockUseTranslation(),
    initReactI18next: { type: '3rdParty', init: vi.fn() }
  }
})
vi.mock('@renderer/hooks/useAssistant', () => ({ useAssistant: (...args: any[]) => mockUseAssistant(...args) }))
vi.mock('@renderer/hooks/useWebSearchProviders', () => ({
  useWebSearchProviders: () => mockUseWebSearchProviders()
}))
vi.mock('@renderer/services/WebSearchService', () => ({
  default: { isWebSearchEnabled: (...args: any[]) => mockIsWebSearchEnabled(...args) }
}))
vi.mock('@renderer/services/AssistantService', () => ({ getProviderByModel: () => null }))

vi.mock('antd', async () => {
  const actual: any = await vi.importActual('antd')
  return {
    ...actual,
    Tooltip: ({ children, open }: any) => (
      <div data-testid="tooltip" data-open={open === undefined ? 'undefined' : String(open)}>
        {children}
      </div>
    ),
    // Single trigger: antd Popover click trigger is sole open/close channel via onOpenChange; no manual button toggle.
    Popover: ({ children, content, open, onOpenChange }: any) => (
      <div data-testid="mock-popover" data-open={String(open)}>
        {open ? <div data-testid="popover-content">{content}</div> : null}
        <div
          data-testid="mock-popover-trigger"
          onClick={(e: any) => {
            e.stopPropagation()
            onOpenChange?.(!open)
          }}>
          {children}
        </div>
      </div>
    )
  }
})

vi.mock('@renderer/components/Buttons', () => ({
  ActionIconButton: ({ children, onClick, ...props }: any) => (
    <button data-testid="ws-button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

vi.mock('@renderer/components/Icons', () => ({
  BochaLogo: () => <span>bocha</span>,
  ExaLogo: () => <span>exa</span>,
  QueritLogo: () => <span>querit</span>,
  SearXNGLogo: () => <span>searxng</span>,
  TavilyLogo: () => <span>tavily</span>,
  ZhipuLogo: () => <span>zhipu</span>,
  BingLogo: () => <span>bing</span>
}))

const baseAssistant: any = {
  id: 'a1',
  model: { id: 'm1', provider: 'openai' },
  enableWebSearch: false,
  webSearchProviderId: undefined
}

const renderComponent = (overrides: any = {}) => {
  const assistant = { ...baseAssistant, ...overrides.assistant }
  const updateAssistant = vi.fn()
  mockUseAssistant.mockReturnValue({ assistant, updateAssistant })
  mockUseWebSearchProviders.mockReturnValue({
    providers: overrides.providers ?? [
      { id: 'tavily', name: 'Tavily' },
      { id: 'exa', name: 'Exa' }
    ]
  })
  mockIsWebSearchEnabled.mockReturnValue(true)
  mockUseTranslation.mockReturnValue({
    t: (key: string) => {
      const map: Record<string, string> = {
        'chat.input.web_search.label': 'Web Search',
        'common.close': 'Close',
        'chat.input.web_search.builtin.label': 'Model Built-in',
        'chat.input.web_search.builtin.enabled_content': 'Builtin enabled',
        'settings.tool.websearch.free': 'Free',
        'settings.tool.websearch.apikey': 'ApiKey',
        'chat.input.web_search.enable_content': 'Enable'
      }
      return map[key] ?? key
    }
  })
  render(<WebSearchButton assistantId="a1" />)
  return { updateAssistant, assistant }
}

describe('WebSearchButton Popover', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows builtin and providers', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('ws-button'))
    expect(screen.getByTestId('websearch-option-builtin')).toBeInTheDocument()
    expect(screen.getByTestId('websearch-option-tavily')).toBeInTheDocument()
    expect(screen.getByTestId('websearch-option-exa')).toBeInTheDocument()
  })

  it('selecting provider calls updateAssistant with provider id', () => {
    const { updateAssistant } = renderComponent()
    fireEvent.click(screen.getByTestId('ws-button'))
    fireEvent.click(screen.getByTestId('websearch-option-tavily'))
    expect(updateAssistant).toHaveBeenCalledWith(expect.objectContaining({ webSearchProviderId: 'tavily' }))
  })

  it('clicking same provider disables it', () => {
    const { updateAssistant } = renderComponent({
      assistant: { webSearchProviderId: 'tavily', enableWebSearch: false }
    })
    // second click should clear
    fireEvent.click(screen.getByTestId('ws-button'))
    fireEvent.click(screen.getByTestId('websearch-option-tavily'))
    expect(updateAssistant).toHaveBeenCalledWith(expect.objectContaining({ webSearchProviderId: undefined }))
  })

  it('builtin toggle flips enableWebSearch', () => {
    const { updateAssistant } = renderComponent()
    fireEvent.click(screen.getByTestId('ws-button'))
    fireEvent.click(screen.getByTestId('websearch-option-builtin'))
    expect(updateAssistant).toHaveBeenCalledWith(expect.objectContaining({ enableWebSearch: true }))
  })

  it('Tooltip is forced closed when popover open', () => {
    renderComponent()
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
    fireEvent.click(screen.getByTestId('ws-button'))
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('websearch-option-builtin'))
    // after selection should close
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
  })

  it('Escape closes popover and restores Tooltip', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('ws-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
  })

  it('second button click closes popover', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('ws-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('ws-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
  })
})
