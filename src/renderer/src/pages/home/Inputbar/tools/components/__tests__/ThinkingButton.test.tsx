import type { Model, ThinkingOption } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ThinkingButton from '../ThinkingButton'

const mockUseAssistant = vi.fn()
const mockGetModelSupportedReasoningEffortOptions = vi.fn()
const mockUseTranslation = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => mockUseTranslation()
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: (...args: any[]) => mockUseAssistant(...args)
}))

vi.mock('@renderer/config/models', () => ({
  getModelSupportedReasoningEffortOptions: (...args: any[]) => mockGetModelSupportedReasoningEffortOptions(...args)
}))

// Single trigger mock: antd Popover with trigger="click" is the sole open/close channel via onOpenChange.
// No manual ActionIconButton onClick toggle. The trigger wrapper handles click and stopPropagation;
// content stopPropagation (ToolPopover PopoverContent) prevents inner clicks from reaching trigger.
// Previously this mock simulated double-drive (Popover + manual toggle); now unified.
vi.mock('antd', async () => {
  const actual: any = await vi.importActual('antd')
  return {
    ...actual,
    Tooltip: ({ children, open }: any) => (
      <div data-testid="tooltip" data-open={open === undefined ? 'undefined' : String(open)}>
        {children}
      </div>
    ),
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
    Switch: ({ checked, onChange, ...rest }: any) => (
      <button
        data-testid={rest['data-testid'] ?? 'show-all-switch'}
        data-checked={String(checked)}
        onClick={(e: any) => {
          e.stopPropagation()
          onChange?.(!checked, e)
        }}
      />
    ),
    Divider: () => <hr />
  }
})

vi.mock('@renderer/components/Buttons', () => ({
  ActionIconButton: ({ children, onClick, ...props }: any) => (
    <button data-testid="thinking-button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

vi.mock('@renderer/components/Icons/SVGIcon', () => ({
  MdiLightbulbAutoOutline: () => <span data-testid="icon-auto" />,
  MdiLightbulbOffOutline: () => <span data-testid="icon-off" />,
  MdiLightbulbOn: () => <span data-testid="icon-on" />,
  MdiLightbulbOn30: () => <span data-testid="icon-30" />,
  MdiLightbulbOn50: () => <span data-testid="icon-50" />,
  MdiLightbulbOn80: () => <span data-testid="icon-80" />,
  MdiLightbulbOn90: () => <span data-testid="icon-90" />,
  MdiLightbulbQuestion: () => <span data-testid="icon-question" />
}))

const createModel = (overrides: Partial<Model> = {}): Model => ({
  id: 'gpt-5',
  provider: 'openai',
  name: 'GPT-5',
  group: 'openai',
  ...overrides
})

const FULL: ThinkingOption[] = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto']

const renderComponent = (
  overrides: {
    model?: Model
    reasoning_effort?: ThinkingOption
    showAllMap?: Record<string, boolean>
    resolverOptions?: ThinkingOption[]
  } = {}
) => {
  const model = overrides.model ?? createModel()
  const reasoning_effort = overrides.reasoning_effort ?? 'low'
  const showAllMap = overrides.showAllMap ?? {}
  const resolverOptions =
    overrides.resolverOptions ?? (['default', 'none', 'low', 'medium', 'high'] as ThinkingOption[])

  const updateAssistantSettings = vi.fn()
  const assistant: any = {
    id: 'assistant-1',
    model,
    settings: {
      reasoning_effort,
      reasoning_effort_by_model: {},
      reasoning_effort_show_all_by_model: showAllMap
    }
  }

  mockUseAssistant.mockReturnValue({ assistant, updateAssistantSettings })
  mockGetModelSupportedReasoningEffortOptions.mockReturnValue(resolverOptions)
  mockUseTranslation.mockReturnValue({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'assistants.settings.reasoning_effort.label': 'Reasoning Effort',
        'assistants.settings.reasoning_effort.default': 'Default',
        'assistants.settings.reasoning_effort.off': 'Off',
        'assistants.settings.reasoning_effort.minimal': 'Minimal',
        'assistants.settings.reasoning_effort.low': 'Low',
        'assistants.settings.reasoning_effort.medium': 'Medium',
        'assistants.settings.reasoning_effort.high': 'High',
        'assistants.settings.reasoning_effort.xhigh': 'Extra High',
        'assistants.settings.reasoning_effort.auto': 'Auto',
        'assistants.settings.reasoning_effort.default_description': 'Default desc',
        'assistants.settings.reasoning_effort.off_description': 'Off desc',
        'assistants.settings.reasoning_effort.minimal_description': 'Minimal desc',
        'assistants.settings.reasoning_effort.low_description': 'Low desc',
        'assistants.settings.reasoning_effort.medium_description': 'Medium desc',
        'assistants.settings.reasoning_effort.high_description': 'High desc',
        'assistants.settings.reasoning_effort.xhigh_description': 'Extra High desc',
        'assistants.settings.reasoning_effort.auto_description': 'Auto desc',
        'chat.input.thinking.show_all': 'Show all'
      }
      return map[key] ?? fallback ?? key
    }
  })

  const view = render(<ThinkingButton model={model} assistantId="assistant-1" />)
  return { view, updateAssistantSettings, assistant, model }
}

describe('ThinkingButton with Popover and show-all', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows resolver defaults when show-all is off', async () => {
    renderComponent({ resolverOptions: ['default', 'none', 'low', 'medium', 'high'] })
    fireEvent.click(screen.getByTestId('thinking-button'))
    expect(screen.getByTestId('thinking-option-default')).toBeInTheDocument()
    expect(screen.getByTestId('thinking-option-none')).toBeInTheDocument()
    expect(screen.getByTestId('thinking-option-low')).toBeInTheDocument()
    expect(screen.getByTestId('thinking-option-high')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-option-xhigh')).not.toBeInTheDocument()
    expect(screen.queryByTestId('thinking-option-auto')).not.toBeInTheDocument()
    expect(screen.queryByTestId('thinking-option-minimal')).not.toBeInTheDocument()
  })

  it('shows full 8 options when show-all is on', () => {
    const model = createModel({ id: 'gpt-5', provider: 'openai' })
    const key = 'openai:gpt-5'
    renderComponent({ model, showAllMap: { [key]: true } })
    fireEvent.click(screen.getByTestId('thinking-button'))
    for (const opt of FULL) {
      expect(screen.getByTestId(`thinking-option-${opt}`)).toBeInTheDocument()
    }
  })

  it('persists show-all per provider:modelId without changing reasoning_effort', () => {
    const model = createModel({ id: 'model-a', provider: 'prov' })
    const key = 'prov:model-a'
    const { updateAssistantSettings } = renderComponent({ model, reasoning_effort: 'medium', showAllMap: {} })
    fireEvent.click(screen.getByTestId('thinking-button'))
    const sw = screen.getByTestId('thinking-show-all-switch')
    expect(sw.getAttribute('data-checked')).toBe('false')
    fireEvent.click(sw)
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      reasoning_effort_show_all_by_model: { [key]: true }
    })
    const call = updateAssistantSettings.mock.calls[0][0]
    expect(call.reasoning_effort).toBeUndefined()
  })

  it('does not reset current value when not in default list', () => {
    renderComponent({ reasoning_effort: 'xhigh', resolverOptions: ['default', 'none', 'low', 'medium', 'high'] })
    fireEvent.click(screen.getByTestId('thinking-button'))
    expect(screen.getByTestId('thinking-option-xhigh')).toBeInTheDocument()
    expect(screen.getByTestId('thinking-option-xhigh').getAttribute('data-selected')).toBe('true')
  })

  it('selecting option updates reasoning_effort and per-model map', () => {
    const model = createModel({ id: 'm1', provider: 'p1' })
    const { updateAssistantSettings } = renderComponent({ model, reasoning_effort: 'low' })
    fireEvent.click(screen.getByTestId('thinking-button'))
    fireEvent.click(screen.getByTestId('thinking-option-high'))
    expect(updateAssistantSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning_effort: 'high',
        reasoning_effort_by_model: { 'p1:m1': 'high' }
      })
    )
  })

  it('toggling show-all does not change current strength', () => {
    const model = createModel({ id: 'm2', provider: 'p2' })
    const { updateAssistantSettings } = renderComponent({ model, reasoning_effort: 'low', showAllMap: {} })
    fireEvent.click(screen.getByTestId('thinking-button'))
    fireEvent.click(screen.getByTestId('thinking-show-all-switch'))
    const firstCall = updateAssistantSettings.mock.calls[0][0]
    expect(firstCall.reasoning_effort).toBeUndefined()
    expect(firstCall.reasoning_effort_show_all_by_model).toBeDefined()
  })

  it('Tooltip is forced closed when popover open and uncontrolled when closed', () => {
    renderComponent()
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
    fireEvent.click(screen.getByTestId('thinking-button'))
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('false')
    fireEvent.click(screen.getByTestId('thinking-option-low'))
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
    expect(screen.queryByTestId('popover-content')).not.toBeInTheDocument()
  })

  it('Escape closes popover and restores Tooltip', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('thinking-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('popover-content')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
    expect(screen.queryByTestId('popover-content')).not.toBeInTheDocument()
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
  })

  it('second button click closes popover (outside click simulated)', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('thinking-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('thinking-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
    expect(screen.queryByTestId('popover-content')).not.toBeInTheDocument()
  })

  it.each(['high', 'none', 'default'] as const)('selecting %s closes popover (data-open=false)', (option) => {
    renderComponent()
    fireEvent.click(screen.getByTestId('thinking-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('popover-content')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`thinking-option-${option}`))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
    expect(screen.queryByTestId('popover-content')).not.toBeInTheDocument()
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
  })

  it('show-all switch toggle keeps popover open (data-open=true)', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('thinking-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('popover-content')).toBeInTheDocument()
    const sw = screen.getByTestId('thinking-show-all-switch')
    expect(sw.getAttribute('data-checked')).toBe('false')
    fireEvent.click(sw)
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('popover-content')).toBeInTheDocument()
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('false')
    fireEvent.click(sw)
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('popover-content')).toBeInTheDocument()
  })

  describe('realistic propagation - stopPropagation prevents double-drive', () => {
    it('option click stops propagation: outer parent not notified and popover closes once', () => {
      const outerSpy = vi.fn()
      const { view } = renderComponent()
      // attach outer spy to a parent wrapper that would receive bubbled events if not stopped
      const outer = document.createElement('div')
      outer.addEventListener('click', outerSpy)
      // Move rendered container into outer to capture bubbling
      const container = view.container
      outer.appendChild(container)
      document.body.appendChild(outer)

      fireEvent.click(screen.getByTestId('thinking-button'))
      expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
      outerSpy.mockClear()

      // Click option: should stop at OptionItem + ToolPopover content, not reach outer
      const high = screen.getByTestId('thinking-option-high')
      fireEvent.click(high)
      expect(outerSpy).not.toHaveBeenCalled()
      expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')

      document.body.removeChild(outer)
    })

    it('option mousedown also stops propagation', () => {
      const outerSpy = vi.fn()
      const { view } = renderComponent()
      const outer = document.createElement('div')
      outer.addEventListener('mousedown', outerSpy)
      const container = view.container
      outer.appendChild(container)
      document.body.appendChild(outer)

      fireEvent.click(screen.getByTestId('thinking-button'))
      outerSpy.mockClear()
      fireEvent.mouseDown(screen.getByTestId('thinking-option-high'))
      expect(outerSpy).not.toHaveBeenCalled()
      document.body.removeChild(outer)
    })

    it('show-all Switch click does not bubble and keeps popover open', () => {
      const outerSpy = vi.fn()
      const { view } = renderComponent()
      const outer = document.createElement('div')
      outer.addEventListener('click', outerSpy)
      const container = view.container
      outer.appendChild(container)
      document.body.appendChild(outer)

      fireEvent.click(screen.getByTestId('thinking-button'))
      expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
      outerSpy.mockClear()

      fireEvent.click(screen.getByTestId('thinking-show-all-switch'))
      // SwitchRow + ToolPopover content should stop, outer not notified
      expect(outerSpy).not.toHaveBeenCalled()
      // Must stay open - proves fix: without stop, outer toggle would have closed it
      expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
      expect(screen.getByTestId('popover-content')).toBeInTheDocument()

      document.body.removeChild(outer)
    })

    it('Switch mousedown does not bubble to outer', () => {
      const outerSpy = vi.fn()
      const { view } = renderComponent()
      const outer = document.createElement('div')
      outer.addEventListener('mousedown', outerSpy)
      const container = view.container
      outer.appendChild(container)
      document.body.appendChild(outer)

      fireEvent.click(screen.getByTestId('thinking-button'))
      outerSpy.mockClear()
      fireEvent.mouseDown(screen.getByTestId('thinking-show-all-switch'))
      expect(outerSpy).not.toHaveBeenCalled()
      document.body.removeChild(outer)
    })
  })
})
