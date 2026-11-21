import type { TopicBranchWire } from '@renderer/services/db/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BRANCH_POPOVER_MIN_WIDTH, branchRowKey, buildForkScopeIndex } from '../branchTreeModel'
import { BranchTreePanel } from '../BranchTreePanel'

/**
 * Scoped renders of the shared branch-route tree panel: a fork divider shows
 * the same panel as the top selector, but rooted at its own fork scope (the
 * parent/original route plus its direct children at the anchor) instead of
 * the full catalog. Only the display root and the row count change; rows,
 * current state and copy/rename/delete handling are identical. The fork
 * entry hides the panel header (branch tag + count + collapse all) and shows
 * the tree only; the top entry keeps it.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      const map: Record<string, string> = {
        'chat.topics.branch.tag': 'Branches',
        'chat.topics.branch.current': 'Current',
        'chat.topics.branch.collapse_all': 'Collapse all',
        'chat.topics.branch.children_here': `Branches here: ${options?.count ?? 0}`,
        'chat.topics.branch.copy_tree': 'Copy branch',
        'chat.topics.branch.rename': 'Rename branch',
        'chat.topics.branch.delete': 'Delete branch',
        'chat.topics.branch.delete_confirm': 'Delete branch and its children?'
      }
      return map[key] ?? key
    }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const wire = (id: string, parentBranchId: string | null, name: string, createdAt: string): TopicBranchWire =>
  ({
    id,
    topicId: 't-1',
    parentBranchId,
    anchorMessageId: 'm1',
    name,
    createdAt,
    updatedAt: createdAt
  }) as TopicBranchWire

const renderScope = ({
  scopeParent,
  children,
  activeBranchId,
  displayRootLabel
}: {
  scopeParent: string | null
  children: TopicBranchWire[]
  activeBranchId: string | null
  displayRootLabel?: string
}) => {
  const onSelectRoute = vi.fn()
  const onCommitRename = vi.fn()
  const onConfirmDelete = vi.fn()
  const onCopyBranch = vi.fn()
  const view = render(
    <BranchTreePanel
      index={buildForkScopeIndex(scopeParent, children)}
      topicName="Topic"
      displayRootKey={branchRowKey(scopeParent)}
      displayRootLabel={displayRootLabel}
      activeBranchId={activeBranchId}
      visible
      onSelectRoute={onSelectRoute}
      onCommitRename={onCommitRename}
      onConfirmDelete={onConfirmDelete}
      onCopyBranch={onCopyBranch}
      deletingBranchId={null}
      copyingBranchId={null}
      onDeleteConfirmChange={vi.fn()}
      maxWidth={300}
      showHeader={false}
    />
  )
  return { ...view, onSelectRoute, onCommitRename, onConfirmDelete, onCopyBranch }
}

const currentRowOf = (testId: string): HTMLElement | null => screen.getByTestId(testId).closest('[data-branch-id]')

describe('BranchTreePanel fork scope', () => {
  it('renders a main-route fork as the display root plus its direct children only', () => {
    renderScope({
      scopeParent: null,
      children: [
        wire('b-1', null, 'B1', '2026-01-01T00:00:00.000Z'),
        wire('b-2', null, 'B2', '2026-01-02T00:00:00.000Z')
      ],
      activeBranchId: 'b-2'
    })

    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
    expect(screen.getByTestId('branch-cascader-item-main')).toHaveTextContent('Topic')
    expect(screen.getByTestId('branch-cascader-item-b-1')).toHaveTextContent('B1')
    expect(screen.getByTestId('branch-cascader-item-b-2')).toHaveTextContent('B2')
    // Exact scope: the display root and its two children, nothing else.
    expect(document.querySelectorAll('[data-branch-id]')).toHaveLength(3)
    // No header in the fork entry: only the display root row shows the count
    // for its own direct children.
    expect(screen.getAllByTitle('Branches here: 2')).toHaveLength(1)
    // The fork entry hides the header entirely: no tag, no count, no collapse.
    expect(screen.queryByTestId('branch-collapse-all')).toBeNull()
    expect(screen.queryByText('Branches')).toBeNull()
    // The scope current carries the marker; the main root stays branch-free.
    expect(currentRowOf('branch-cascader-item-b-2')?.classList.contains('is-current')).toBe(true)
    expect(screen.queryByTestId('branch-rename-btn-__main')).toBeNull()
    expect(screen.queryByTestId('branch-delete-btn-__main')).toBeNull()
    expect(screen.queryByTestId('branch-copy-btn-__main')).toBeNull()
  })

  it('maps the main display root back to the null route on select', () => {
    const { onSelectRoute } = renderScope({
      scopeParent: null,
      children: [wire('b-1', null, 'B1', '2026-01-01T00:00:00.000Z')],
      activeBranchId: 'b-1'
    })
    fireEvent.click(screen.getByTestId('branch-cascader-item-main'))
    expect(onSelectRoute).toHaveBeenCalledWith(null)
  })

  it('renders a branch-parent fork rooted at the real parent id with ops on the parent row', () => {
    const { onSelectRoute } = renderScope({
      scopeParent: 'bp',
      children: [wire('c-1', 'bp', 'C1', '2026-01-01T00:00:00.000Z')],
      activeBranchId: 'bp',
      displayRootLabel: 'Parent'
    })

    // The branch display root shows the caller-owned label, not a catalog node.
    expect(screen.getByTestId('branch-cascader-item-bp')).toHaveTextContent('Parent')
    expect(screen.getByTestId('branch-cascader-item-c-1')).toHaveTextContent('C1')
    // No main-route row exists in a branch-parent scope.
    expect(screen.queryByTestId('branch-cascader-item-main')).toBeNull()
    expect(document.querySelectorAll('[data-branch-id]')).toHaveLength(2)
    expect(screen.getAllByTitle('Branches here: 1')).toHaveLength(1)
    // A branch display root is a branch row: same copy/rename/delete handling.
    expect(screen.getByTestId('branch-rename-btn-bp')).toBeInTheDocument()
    expect(screen.getByTestId('branch-delete-btn-bp')).toBeInTheDocument()
    expect(screen.getByTestId('branch-copy-btn-bp')).toBeInTheDocument()
    expect(currentRowOf('branch-cascader-item-bp')?.classList.contains('is-current')).toBe(true)
    // Selecting the display root passes the real parent id through.
    fireEvent.click(screen.getByTestId('branch-cascader-item-bp'))
    expect(onSelectRoute).toHaveBeenCalledWith('bp')
  })

  it('commits a branch-parent root rename with the real branch id', () => {
    const { onCommitRename } = renderScope({
      scopeParent: 'bp',
      children: [wire('c-1', 'bp', 'C1', '2026-01-01T00:00:00.000Z')],
      activeBranchId: 'bp',
      displayRootLabel: 'Parent'
    })
    fireEvent.click(screen.getByTestId('branch-rename-btn-bp'))
    const input = screen.getByTestId('branch-selector-rename-input')
    expect(input).toHaveValue('Parent')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)
    expect(onCommitRename).toHaveBeenCalledWith('bp', 'Renamed')
  })

  it('copies the clicked scope row without switching route', () => {
    const { onCopyBranch, onSelectRoute } = renderScope({
      scopeParent: null,
      children: [
        wire('b-1', null, 'B1', '2026-01-01T00:00:00.000Z'),
        wire('b-2', null, 'B2', '2026-01-02T00:00:00.000Z')
      ],
      activeBranchId: 'b-2'
    })
    fireEvent.click(screen.getByTestId('branch-copy-btn-b-1'))
    expect(onCopyBranch).toHaveBeenCalledWith('b-1')
    expect(onSelectRoute).not.toHaveBeenCalled()
  })

  it('keeps the header on the default top entry', () => {
    render(
      <BranchTreePanel
        index={buildForkScopeIndex(null, [wire('b-1', null, 'B1', '2026-01-01T00:00:00.000Z')])}
        topicName="Topic"
        activeBranchId="b-1"
        visible
        onSelectRoute={vi.fn()}
        onCommitRename={vi.fn()}
        onConfirmDelete={vi.fn()}
        onCopyBranch={vi.fn()}
        deletingBranchId={null}
        copyingBranchId={null}
        onDeleteConfirmChange={vi.fn()}
        maxWidth={300}
      />
    )
    expect(screen.getByTestId('branch-collapse-all')).toBeInTheDocument()
    expect(screen.getByText('Branches')).toBeInTheDocument()
  })
})

describe('BranchTreePanel panel floor (minWidth)', () => {
  const callbacks = () => ({
    onSelectRoute: vi.fn(),
    onCommitRename: vi.fn(),
    onConfirmDelete: vi.fn(),
    onCopyBranch: vi.fn(),
    deletingBranchId: null,
    copyingBranchId: null,
    onDeleteConfirmChange: vi.fn()
  })

  it('defaults to the top selector floor when minWidth is omitted', () => {
    render(
      <BranchTreePanel
        index={buildForkScopeIndex(null, [wire('b-1', null, 'B1', '2026-01-01T00:00:00.000Z')])}
        topicName="Topic"
        activeBranchId="b-1"
        visible
        {...callbacks()}
        maxWidth={300}
      />
    )
    // Unmeasured: nothing invented, but the readable top floor still applies.
    expect(screen.getByTestId('branch-selector-popover').style.minWidth).toBe(`${BRANCH_POPOVER_MIN_WIDTH}px`)
  })

  it('opens a fork scope at its own floor instead of the top floor', () => {
    render(
      <BranchTreePanel
        index={buildForkScopeIndex(null, [wire('b-1', null, 'B1', '2026-01-01T00:00:00.000Z')])}
        topicName="Topic"
        displayRootKey={branchRowKey(null)}
        activeBranchId="b-1"
        visible
        {...callbacks()}
        maxWidth={300}
        minWidth={220}
        showHeader={false}
      />
    )
    const panel = screen.getByTestId('branch-selector-popover')
    expect(panel.style.minWidth).toBe('220px')
    expect(panel.style.maxWidth).toBe('300px')
  })

  it('clamps the floor to the budget when the budget is tighter', () => {
    render(
      <BranchTreePanel
        index={buildForkScopeIndex(null, [wire('b-1', null, 'B1', '2026-01-01T00:00:00.000Z')])}
        topicName="Topic"
        activeBranchId="b-1"
        visible
        {...callbacks()}
        maxWidth={200}
        minWidth={220}
        showHeader={false}
      />
    )
    expect(screen.getByTestId('branch-selector-popover').style.minWidth).toBe('200px')
  })
})
