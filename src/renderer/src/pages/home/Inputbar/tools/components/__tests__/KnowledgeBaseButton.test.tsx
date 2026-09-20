import type { KnowledgeBase } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import KnowledgeBaseButton from '../KnowledgeBaseButton'

const mockNavigate = vi.fn()
const mockUseAppSelector = vi.fn()
const mockUseTranslation = vi.fn()

vi.mock('react-router', () => ({ useNavigate: () => mockNavigate }))
vi.mock('react-i18next', () => ({ useTranslation: () => mockUseTranslation() }))
vi.mock('@renderer/store', () => ({ useAppSelector: (fn: any) => mockUseAppSelector(fn) }))

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
    <button data-testid="kb-button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

const createBase = (id: string, name: string, count = 2): KnowledgeBase =>
  ({
    id,
    name,
    items: new Array(count).fill(null).map((_, i) => ({ id: `${id}-${i}`, type: 'file' })) as any,
    created_at: '',
    updated_at: ''
  }) as any

const renderComponent = (
  overrides: { selectedBases?: KnowledgeBase[]; onSelect?: any; bases?: KnowledgeBase[] } = {}
) => {
  const bases = overrides.bases ?? [createBase('b1', 'Base 1'), createBase('b2', 'Base 2')]
  mockUseAppSelector.mockImplementation((selector: any) => selector({ knowledge: { bases } } as any))
  mockUseTranslation.mockReturnValue({
    t: (key: string) => {
      const map: Record<string, string> = {
        'chat.input.knowledge_base': 'Knowledge Base',
        'settings.input.clear.all': 'Clear All',
        'settings.input.clear.knowledge_base': 'Clear KB',
        'knowledge.add.title': 'Add Knowledge',
        'files.count': 'files'
      }
      return map[key] ?? key
    }
  })
  const onSelect = overrides.onSelect ?? vi.fn()
  const selectedBases = overrides.selectedBases ?? []
  render(<KnowledgeBaseButton selectedBases={selectedBases} onSelect={onSelect} />)
  return { onSelect, bases }
}

describe('KnowledgeBaseButton Popover', () => {
  beforeEach(() => vi.clearAllMocks())

  it('toggles selection on base click', () => {
    const base1 = createBase('b1', 'Base 1')
    const { onSelect } = renderComponent({ selectedBases: [], bases: [base1] })
    fireEvent.click(screen.getByTestId('kb-button'))
    fireEvent.click(screen.getByTestId('kb-option-b1'))
    expect(onSelect).toHaveBeenCalledWith([base1])
  })

  it('removes when already selected (multi-select)', () => {
    const base1 = createBase('b1', 'Base 1')
    const onSelect = vi.fn()
    renderComponent({ selectedBases: [base1], onSelect, bases: [base1] })
    fireEvent.click(screen.getByTestId('kb-button'))
    fireEvent.click(screen.getByTestId('kb-option-b1'))
    expect(onSelect).toHaveBeenCalledWith([])
  })

  it('clear all removes all', () => {
    const b1 = createBase('b1', 'Base 1')
    const onSelect = vi.fn()
    renderComponent({ selectedBases: [b1], onSelect, bases: [b1] })
    fireEvent.click(screen.getByTestId('kb-button'))
    fireEvent.click(screen.getByTestId('kb-clear-all'))
    expect(onSelect).toHaveBeenCalledWith([])
  })

  it('reflects selected state via data-selected', () => {
    const b1 = createBase('b1', 'Base 1')
    renderComponent({ selectedBases: [b1], bases: [b1] })
    fireEvent.click(screen.getByTestId('kb-button'))
    expect(screen.getByTestId('kb-option-b1').getAttribute('data-selected')).toBe('true')
  })

  it('Tooltip is forced closed when popover open', () => {
    renderComponent()
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
    fireEvent.click(screen.getByTestId('kb-button'))
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
  })

  it('Escape closes popover and restores Tooltip', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('kb-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
    expect(screen.getByTestId('tooltip').getAttribute('data-open')).toBe('undefined')
  })

  it('second button click closes popover', () => {
    renderComponent()
    fireEvent.click(screen.getByTestId('kb-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    fireEvent.click(screen.getByTestId('kb-button'))
    expect(screen.getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
  })
})
