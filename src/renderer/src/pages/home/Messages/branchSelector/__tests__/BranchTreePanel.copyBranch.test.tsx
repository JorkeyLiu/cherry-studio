import type { TopicBranchWire } from '@renderer/services/db/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { buildBranchTreeIndex } from '../branchTreeModel'
import { BranchTreePanel } from '../BranchTreePanel'

/**
 * Branch-row copy affordance in the selector.
 *
 * The button lives on a BRANCH row (never on the main row), shares the existing
 * row-action area with rename/delete so revealing it cannot shift the row, and
 * copies the row it was pressed on — a press never switches route.
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

const wire = (id: string, parentBranchId: string | null, createdAt: string): TopicBranchWire =>
  ({
    id,
    topicId: 't-1',
    parentBranchId,
    anchorMessageId: `m-${id}`,
    name: id,
    createdAt,
    updatedAt: createdAt
  }) as TopicBranchWire

/** Root → fork b-0 → leaf b-1: b-1 is current, so both rows are laid out. */
const forkCatalog = (): TopicBranchWire[] => [
  wire('b-0', null, '2026-01-01T00:00:00.000Z'),
  wire('b-1', 'b-0', '2026-01-02T00:00:00.000Z')
]

const renderPanel = (overrides: { activeBranchId?: string | null; copyingBranchId?: string | null } = {}) => {
  const onCopyBranch = vi.fn()
  const onSelectRoute = vi.fn()
  const props = {
    index: buildBranchTreeIndex(forkCatalog()),
    topicName: 'Root',
    activeBranchId: overrides.activeBranchId === undefined ? 'b-1' : overrides.activeBranchId,
    visible: true,
    onSelectRoute,
    onCommitRename: vi.fn(),
    onConfirmDelete: vi.fn(),
    onCopyBranch,
    deletingBranchId: null,
    copyingBranchId: overrides.copyingBranchId ?? null,
    onDeleteConfirmChange: vi.fn(),
    maxWidth: 420
  }
  const view = render(<BranchTreePanel {...props} />)
  return {
    ...view,
    onCopyBranch,
    onSelectRoute,
    props,
    rerenderPanel: (next: typeof overrides) => {
      view.rerender(
        <BranchTreePanel
          {...props}
          activeBranchId={next.activeBranchId === undefined ? props.activeBranchId : next.activeBranchId}
          copyingBranchId={next.copyingBranchId ?? null}
        />
      )
    }
  }
}

describe('BranchTreePanel branch-row copy', () => {
  it('offers copy on branch rows only', () => {
    renderPanel()

    expect(screen.getByTestId('branch-cascader-item-main')).toBeInTheDocument()
    // The main route is not a branch: no copy affordance to ask for.
    expect(screen.queryByTestId('branch-copy-btn-__main')).toBeNull()
    expect(screen.getByTestId('branch-copy-btn-b-0')).toBeInTheDocument()
    expect(screen.getByTestId('branch-copy-btn-b-1')).toBeInTheDocument()
  })

  it('keeps the copy control in the same row-action area as rename and delete', () => {
    renderPanel()

    const copy = screen.getByTestId('branch-copy-btn-b-0')
    const rename = screen.getByTestId('branch-rename-btn-b-0')
    const del = screen.getByTestId('branch-delete-btn-b-0')

    // Same area, no extra wrapper: revealing copy cannot shift the name column
    // because the area keeps its width at all times.
    expect(copy.parentElement).toBe(rename.parentElement)
    expect(copy.parentElement).toBe(del.parentElement)
    const row = copy.closest('[data-branch-id="b-0"]')
    expect(row).not.toBeNull()
    expect(row).toContainElement(copy)

    // Tooltip/aria wording is the translated branch-copy label.
    expect(copy.getAttribute('aria-label')).toBe('Copy branch')
  })

  it('copies the row it was pressed on, not the active route', () => {
    const { onCopyBranch, onSelectRoute } = renderPanel({ activeBranchId: 'b-1' })

    // b-0 is NOT the active route; its own copy button still captures b-0.
    fireEvent.click(screen.getByTestId('branch-copy-btn-b-0'))

    expect(onCopyBranch).toHaveBeenCalledTimes(1)
    expect(onCopyBranch).toHaveBeenCalledWith('b-0')
    expect(onSelectRoute).not.toHaveBeenCalled()
  })

  it('never switches route on a press or a pointer-down on the control', () => {
    const { onCopyBranch, onSelectRoute } = renderPanel()

    const button = screen.getByTestId('branch-copy-btn-b-1')
    fireEvent.mouseDown(button)
    fireEvent.mouseUp(button)
    fireEvent.click(button)

    expect(onSelectRoute).not.toHaveBeenCalled()
    expect(onCopyBranch).toHaveBeenCalledWith('b-1')
  })

  it('spins only the row whose copy is in flight', () => {
    const { rerenderPanel } = renderPanel()

    const idle = screen.getByTestId('branch-copy-btn-b-0')
    expect(idle.className).not.toContain('ant-btn-loading')

    rerenderPanel({ copyingBranchId: 'b-0' })

    const busy = screen.getByTestId('branch-copy-btn-b-0')
    expect(busy.className).toContain('ant-btn-loading')
    // The sibling row keeps its interactive control.
    expect(screen.getByTestId('branch-copy-btn-b-1').className).not.toContain('ant-btn-loading')
  })

  it('keeps the main row free of every row action', () => {
    renderPanel()

    expect(screen.queryByTestId('branch-rename-btn-__main')).toBeNull()
    expect(screen.queryByTestId('branch-delete-btn-__main')).toBeNull()
    expect(screen.queryByTestId('branch-copy-btn-__main')).toBeNull()
  })
})
