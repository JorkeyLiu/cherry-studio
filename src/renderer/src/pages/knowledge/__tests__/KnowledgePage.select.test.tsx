/**
 * KnowledgePage — compact base selector transitions for the bounded dialog.
 *
 * The dialog replaces the permanent sidebar with a top Select: switching it
 * swaps the detail base, adding selects the new base once the store carries
 * it, deleting the selected base falls back to the first remaining base, and
 * an empty store shows the empty state with an add entry point. All base
 * operations (add/rename/delete/settings) resolve to pre-existing locale
 * keys; no new keys are introduced.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as Antd from 'antd'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string) => key)
  const rename = vi.fn()
  const del = vi.fn()
  const update = vi.fn()
  let bases: { id: string; name: string }[] = []
  return {
    t,
    rename,
    del,
    update,
    get bases() {
      return bases
    },
    set bases(v) {
      bases = v
    }
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('@renderer/hooks/useKnowledge', () => ({
  useKnowledgeBases: () => ({
    bases: mocks.bases,
    renameKnowledgeBase: mocks.rename,
    deleteKnowledgeBase: mocks.del,
    updateKnowledgeBases: mocks.update
  })
}))

vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcut: vi.fn()
}))

vi.mock('../components/AddKnowledgeBasePopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('../components/EditKnowledgeBasePopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('../components/KnowledgeSearchPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/components/Popups/PromptPopup', () => ({
  default: { show: vi.fn() }
}))

// Passthrough seam: real drag interaction is antd/dnd machinery; what this
// suite owns is that a reorder commits through the existing
// updateKnowledgeBases updater and leaves the selection alone.
vi.mock('@renderer/components/DraggableList', () => ({
  DraggableList: ({
    list,
    onUpdate,
    children
  }: {
    list: { id: string }[]
    onUpdate: (list: { id: string }[]) => void
    children: (item: { id: string }, index: number) => ReactNode
  }) => (
    <div data-testid="reorder-list">
      <button data-testid="reorder-apply" onClick={() => onUpdate([...list].reverse())}>
        apply-reorder
      </button>
      {list.map((item, index) => (
        <div key={item.id}>{children(item, index)}</div>
      ))}
    </div>
  )
}))

// The detail pane is a collaborator here: capture which base it receives.
vi.mock('../KnowledgeContent', () => ({
  default: ({ selectedBase }: { selectedBase: { id: string } }) => (
    <div data-testid="mock-content" data-base-id={selectedBase.id} />
  )
}))

// Real antd Select dropdown interaction is unwieldy in jsdom; this seam keeps
// the component's own selection contract (value/options/onChange mapping)
// under test without asserting antd internals.
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof Antd>()
  const MockSelect = ({
    value,
    onChange,
    options,
    placeholder
  }: {
    value?: string
    onChange?: (v: string) => void
    options?: { value: string; label: ReactNode }[]
    placeholder?: string
  }) => (
    <select
      data-testid="knowledge-base-select"
      aria-label={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}>
      {(options ?? []).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
  return { ...actual, Select: MockSelect }
})

import AddKnowledgeBasePopup from '../components/AddKnowledgeBasePopup'
import KnowledgePage from '../KnowledgePage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.bases = [
    { id: 'b1', name: 'Base One' },
    { id: 'b2', name: 'Base Two' }
  ]
})

afterEach(() => {
  cleanup()
})

describe('KnowledgePage — compact base selector', () => {
  it('renders the first base and lists every base as an option', () => {
    render(<KnowledgePage />)
    expect(screen.getByTestId('mock-content').getAttribute('data-base-id')).toBe('b1')
    const select = screen.getByTestId('knowledge-base-select')
    expect(select).toHaveValue('b1')
    expect(screen.getByText('Base One')).toBeInTheDocument()
    expect(screen.getByText('Base Two')).toBeInTheDocument()
  })

  it('switching the selector swaps the detail base', () => {
    render(<KnowledgePage />)
    fireEvent.change(screen.getByTestId('knowledge-base-select'), { target: { value: 'b2' } })
    expect(screen.getByTestId('mock-content').getAttribute('data-base-id')).toBe('b2')
  })

  it('adding a base selects it once the store carries it', async () => {
    // Mirrors the real popup: the store carries the new base before resolve.
    vi.mocked(AddKnowledgeBasePopup.show).mockImplementation(async () => {
      const created = { id: 'b3', name: 'Base Three' }
      mocks.bases = [...mocks.bases, created]
      return created
    })
    render(<KnowledgePage />)
    fireEvent.click(screen.getByTestId('knowledge-base-add'))
    await waitFor(() => {
      expect(AddKnowledgeBasePopup.show).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByTestId('mock-content').getAttribute('data-base-id')).toBe('b3')
    })
  })

  it('deleting the selected base falls back to the first remaining base', () => {
    const { rerender } = render(<KnowledgePage />)
    expect(screen.getByTestId('mock-content').getAttribute('data-base-id')).toBe('b1')
    mocks.bases = [{ id: 'b2', name: 'Base Two' }]
    rerender(<KnowledgePage />)
    expect(screen.getByTestId('mock-content').getAttribute('data-base-id')).toBe('b2')
    expect(screen.getByTestId('knowledge-base-select')).toHaveValue('b2')
  })

  it('empty store shows the empty state with an add entry point', () => {
    mocks.bases = []
    render(<KnowledgePage />)
    expect(screen.getByText('knowledge.empty')).toBeInTheDocument()
    expect(screen.queryByTestId('mock-content')).not.toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-base-more')).not.toBeInTheDocument()
    // Add entry point still offered.
    expect(screen.getByTestId('knowledge-base-add')).toBeInTheDocument()
  })

  it('more menu is offered only when a base is selected', () => {
    render(<KnowledgePage />)
    expect(screen.getByTestId('knowledge-base-more')).toBeInTheDocument()
  })

  it('reorder entry persists order via updateKnowledgeBases and keeps selection', async () => {
    render(<KnowledgePage />)
    fireEvent.click(screen.getByTestId('knowledge-base-more'))
    fireEvent.click(await screen.findByText('knowledge.reorder'))
    expect(await screen.findByTestId('reorder-list')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('reorder-apply'))
    expect(mocks.update).toHaveBeenCalledWith([
      { id: 'b2', name: 'Base Two' },
      { id: 'b1', name: 'Base One' }
    ])
    // Reordering never touches the selection.
    expect(screen.getByTestId('mock-content').getAttribute('data-base-id')).toBe('b1')
    expect(screen.getByTestId('knowledge-base-select')).toHaveValue('b1')
  })
})
