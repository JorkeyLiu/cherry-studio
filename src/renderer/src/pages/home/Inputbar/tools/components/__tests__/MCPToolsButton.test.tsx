import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import MCPToolsButton from '../MCPToolsButton'

const mockUseAssistant = vi.fn()
const mockUseMCPServers = vi.fn()
const mockUseTranslation = vi.fn()
const mockNavigate = vi.fn()

vi.mock('react-router', () => ({ useNavigate: () => mockNavigate }))
vi.mock('react-i18next', async () => {
  const actual: any = await vi.importActual('react-i18next')
  return {
    ...actual,
    useTranslation: () => mockUseTranslation(),
    initReactI18next: { type: '3rdParty', init: vi.fn() }
  }
})
vi.mock('@renderer/hooks/useAssistant', () => ({ useAssistant: (...args: any[]) => mockUseAssistant(...args) }))
vi.mock('@renderer/hooks/useMCPServers', () => ({ useMCPServers: () => mockUseMCPServers() }))
vi.mock('@renderer/hooks/useTimer', () => ({ useTimer: () => ({ setTimeoutTimer: (_k: string, fn: any) => fn() }) }))
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
    ),
    Divider: () => <hr />,
    Form: { useForm: () => [{ resetFields: vi.fn(), validateFields: vi.fn(async () => ({})) }] },
    Input: (props: any) => <input {...props} />
  }
})

vi.mock('@renderer/components/Buttons', () => ({
  ActionIconButton: ({ children, onClick, ...props }: any) => (
    <button data-testid="mcp-button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

const baseAssistant: any = {
  id: 'a1',
  mcpMode: 'disabled',
  mcpServers: [],
  enableWebSearch: false,
  enableUrlContext: false,
  model: { id: 'm1' }
}

const renderComponent = (overrides: any = {}) => {
  const assistant = { ...baseAssistant, ...overrides.assistant }
  const updateAssistant = vi.fn()
  mockUseAssistant.mockReturnValue({ assistant, updateAssistant })
  mockUseMCPServers.mockReturnValue({
    activedMcpServers: overrides.servers ?? [
      { id: 's1', name: 'Server 1', description: 'desc1' },
      { id: 's2', name: 'Server 2', description: 'desc2' }
    ]
  })
  mockUseTranslation.mockReturnValue({
    t: (key: string) => {
      const map: Record<string, string> = {
        'settings.mcp.title': 'MCP',
        'assistants.settings.mcp.mode.disabled.label': 'Disabled',
        'assistants.settings.mcp.mode.disabled.description': 'Disabled desc',
        'assistants.settings.mcp.mode.auto.label': 'Auto',
        'assistants.settings.mcp.mode.auto.description': 'Auto desc',
        'assistants.settings.mcp.mode.manual.label': 'Manual',
        'assistants.settings.mcp.mode.manual.description': 'Manual desc',
        'settings.mcp.tabs.prompts': 'Prompts',
        'settings.mcp.tabs.resources': 'Resources',
        'settings.mcp.addServer.label': 'Add Server',
        'settings.mcp.prompts.arguments': 'Arguments',
        'settings.mcp.prompts.requiredField': 'Required',
        'common.confirm': 'Confirm',
        'common.cancel': 'Cancel',
        'common.error': 'Error',
        'settings.mcp.prompts.genericError': 'Prompt error',
        'settings.mcp.resources.genericError': 'Resource error',
        'settings.mcp.resources.blobInvisible': 'Blob',
        'chat.mcp.warning.url_context': 'url warning',
        'chat.mcp.warning.gemini_web_search': 'gemini warning'
      }
      return map[key] ?? key
    }
  })
  // mock window.api.mcp
  ;(global.window as any).api = {
    mcp: {
      listPrompts: vi.fn(async () => []),
      getPrompt: vi.fn(async () => ({ messages: [{ role: 'assistant', content: { type: 'text', text: 'prompt' } }] })),
      listResources: vi.fn(async () => []),
      getResource: vi.fn(async () => ({ contents: [] }))
    }
  }
  ;(global.window as any).modal = { confirm: vi.fn(), error: vi.fn() }
  ;(global.window as any).toast = { warning: vi.fn() }

  render(<MCPToolsButton assistantId="a1" setInputValue={vi.fn()} resizeTextArea={vi.fn()} />)
  return { updateAssistant, assistant }
}

describe('MCPToolsButton Popover', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows mode options', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('mcp-button'))
    expect(screen.getByTestId('mcp-mode-disabled')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-mode-auto')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-mode-manual')).toBeInTheDocument()
  })

  it('clicking auto mode updates assistant', () => {
    const { updateAssistant } = renderComponent()
    fireEvent.click(screen.getByTestId('mcp-button'))
    fireEvent.click(screen.getByTestId('mcp-mode-auto'))
    expect(updateAssistant).toHaveBeenCalledWith(expect.objectContaining({ mcpMode: 'auto' }))
  })

  it('manual mode shows server list with multi-select', async () => {
    renderComponent({ assistant: { mcpMode: 'manual', mcpServers: [] } })
    fireEvent.click(screen.getByTestId('mcp-button'))
    await waitFor(() => expect(screen.getByTestId('mcp-server-s1')).toBeInTheDocument())
    expect(screen.getByTestId('mcp-server-s2')).toBeInTheDocument()
  })

  it('selecting server toggles it', async () => {
    const { updateAssistant } = renderComponent({ assistant: { mcpMode: 'manual', mcpServers: [] } })
    fireEvent.click(screen.getByTestId('mcp-button'))
    await waitFor(() => expect(screen.getByTestId('mcp-server-s1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('mcp-server-s1'))
    expect(updateAssistant).toHaveBeenCalledWith(expect.objectContaining({ mcpMode: 'manual' }))
    // should contain server s1
    const call = updateAssistant.mock.calls[0][0]
    expect(call.mcpServers.some((s: any) => s.id === 's1')).toBe(true)
  })

  it('selecting Disabled closes popover', () => {
    renderComponent({ assistant: { mcpMode: 'manual', mcpServers: [] } })
    fireEvent.click(screen.getByTestId('mcp-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('mcp-mode-disabled'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
  })

  it('selecting Auto closes popover', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('mcp-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('mcp-mode-auto'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
  })

  it('selecting Manual keeps popover open for multi-select', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('mcp-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('mcp-mode-manual'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
  })

  it('selecting server keeps popover open for multi-select', async () => {
    const { updateAssistant } = renderComponent({ assistant: { mcpMode: 'manual', mcpServers: [] } })
    fireEvent.click(screen.getByTestId('mcp-button'))
    await waitFor(() => expect(screen.getByTestId('mcp-server-s1')).toBeInTheDocument())
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('mcp-server-s1'))
    expect(updateAssistant).toHaveBeenCalled()
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    // second server still selectable without reopening
    fireEvent.click(screen.getByTestId('mcp-server-s2'))
    expect(updateAssistant).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
  })

  it('Tooltip is forced closed when popover open', () => {
    renderComponent()
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
    fireEvent.click(screen.getByTestId('mcp-button'))
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
  })

  it('Escape closes popover and restores Tooltip', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('mcp-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
  })

  it('second button click closes popover', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('mcp-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('mcp-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
  })
})
