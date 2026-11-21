import type { TopicBranchWire } from '@renderer/services/db/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { findAnchorsWithChildren, ForkDivider, forkRouteOptions, takenChildAtAnchor } from '../BranchDividers'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => {
      // Base locale mirror: interpolation and plural selection are the
      // production i18n config's job, so the mock only needs the same shape.
      if (key === 'chat.topics.branch.children_here') return `此处有 ${opts?.count ?? 0} 条分支`
      if (key === 'chat.edit.copied') return `Copied ${opts?.count ?? 0} message(s)`
      const map: Record<string, string> = {
        'chat.topics.branch.tag': 'Branches',
        'chat.topics.branch.current': 'Current',
        'chat.topics.branch.collapse_all': 'Collapse all',
        'chat.topics.branch.copy_tree': 'Copy branch',
        'chat.topics.branch.rename': 'Rename Branch',
        'chat.topics.branch.delete': 'Delete Branch',
        'chat.topics.branch.delete_confirm': 'Delete this branch and all its descendant branches?',
        'chat.topics.branch.deleted': 'Branch deleted',
        'chat.topics.branch.collapse': 'Collapse branch',
        'chat.topics.branch.expand': 'Expand branch',
        'common.confirm': 'Confirm',
        'common.cancel': 'Cancel',
        'common.error': 'Error'
      }
      if (map[key] !== undefined) return map[key]
      return opts?.count !== undefined ? `${key}:${opts.count}` : key
    }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const { dispatchMock, renameBranchMock, deleteBranchSubtreeMock, copyBranchTreeMock, requestBranchesMock } = vi.hoisted(
  () => ({
    dispatchMock: vi.fn(),
    renameBranchMock: vi.fn(),
    deleteBranchSubtreeMock: vi.fn(),
    copyBranchTreeMock: vi.fn(),
    requestBranchesMock: vi.fn()
  })
)

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    // The real renameBranchWithHistory writes through here, so the fork popup
    // exercises the same DB-first path as the top selector without a mock of
    // the history layer itself.
    renameBranch: (...args: unknown[]) => renameBranchMock(...args)
  }
}))

vi.mock('@renderer/services/db/branchSubtree', () => ({
  deleteBranchSubtree: (...args: unknown[]) => deleteBranchSubtreeMock(...args)
}))

vi.mock('@renderer/services/ClipboardService', () => ({
  copyBranchTree: (...args: unknown[]) => copyBranchTreeMock(...args)
}))

vi.mock('@renderer/pages/home/Messages/useBranchTree', () => ({
  requestTopicBranches: (...args: unknown[]) => requestBranchesMock(...args)
}))

const makeMessages = (entries: Array<{ id: string }>): any[] =>
  entries.map((e) => ({ ...e, topicId: 't-1', role: 'user', blocks: [] }))

const wire = (
  id: string,
  anchorMessageId: string,
  parentBranchId: string | null,
  name: string,
  createdAt = '2026-01-01T00:00:00.000Z'
): TopicBranchWire =>
  ({ id, topicId: 't-1', parentBranchId, anchorMessageId, name, createdAt, updatedAt: createdAt }) as TopicBranchWire

describe('findAnchorsWithChildren', () => {
  it('collects anchors with direct child branches in display order', () => {
    const messages = makeMessages([{ id: 'm0' }, { id: 'm1' }, { id: 'm2' }])
    const childrenByAnchor = new Map([
      ['m1', [wire('b-1', 'm1', null, 'B1')]],
      ['m0', [wire('b-0', 'm0', null, 'B0')]]
    ])
    expect(findAnchorsWithChildren(messages, childrenByAnchor)).toEqual(['m0', 'm1'])
  })
})

describe('takenChildAtAnchor', () => {
  it('returns the path branch anchored here among the direct children', () => {
    const b1 = wire('b-1', 'm1', null, 'B1')
    const b2 = wire('b-2', 'm1', null, 'B2')
    expect(takenChildAtAnchor([b2], 'm1', [b1, b2])).toBe(b2)
    expect(takenChildAtAnchor([], 'm1', [b1, b2])).toBeUndefined()
    expect(takenChildAtAnchor([b1], 'm0', [b1, b2])).toBeUndefined()
  })
})

describe('forkRouteOptions', () => {
  it('lists the parent/original route first, then children in order; taken selected, else parent selected', () => {
    const b1 = wire('b-1', 'm1', null, 'B1', '2026-01-01T00:00:00.000Z')
    const b2 = wire('b-2', 'm1', null, 'B2', '2026-01-02T00:00:00.000Z')
    expect(forkRouteOptions('Topic', null, [b2, b1], null)).toEqual([
      { branchId: null, label: 'Topic', selected: true },
      { branchId: 'b-1', label: 'B1', selected: false },
      { branchId: 'b-2', label: 'B2', selected: false }
    ])
    expect(forkRouteOptions('Topic', null, [b1, b2], 'b-2')).toEqual([
      { branchId: null, label: 'Topic', selected: false },
      { branchId: 'b-1', label: 'B1', selected: false },
      { branchId: 'b-2', label: 'B2', selected: true }
    ])
  })
})

describe('ForkDivider', () => {
  const b1 = () => wire('b-1', 'm1', null, 'B1')
  const b2 = () => wire('b-2', 'm1', null, 'B2')

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).toast = { success: vi.fn(), error: vi.fn() }
  })

  const baseProps = {
    topicId: 't-1',
    activeBranchId: null as string | null,
    parentBranchId: null as string | null,
    parentLabel: 'Topic'
  }

  const openPopup = async (toggleTestId: string, listTestId: string): Promise<void> => {
    fireEvent.click(screen.getByTestId(toggleTestId))
    await waitFor(() => expect(screen.getByTestId(listTestId)).toBeInTheDocument())
  }

  it('untaken fork renders the count form; popup shows the shared tree scoped to parent/original plus children', async () => {
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    expect(screen.getByTestId('branch-fork-divider-m1')).toBeInTheDocument()
    expect(screen.getByTestId('branch-fork-toggle-m1')).toHaveTextContent('此处有 2 条分支')

    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    // Same panel, same rows as the top selector: display root plus children.
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
    expect(screen.getByTestId('branch-cascader-item-main')).toHaveTextContent('Topic')
    expect(screen.getByTestId('branch-cascader-item-b-1')).toHaveTextContent('B1')
    expect(screen.getByTestId('branch-cascader-item-b-2')).toHaveTextContent('B2')
    // Exact scope: nothing else renders (no other anchors, ancestors or descendants).
    const rows = screen.getByTestId('branch-fork-list-m1').querySelectorAll('[data-branch-id]')
    expect(
      Array.from(rows)
        .map((row) => row.getAttribute('data-branch-id'))
        .sort()
    ).toEqual(['__main', 'b-1', 'b-2'])
  })

  it('taken fork renders the selected branch name; popup switches among parent/original and siblings', async () => {
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={b2()}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
        activeBranchId="b-2"
      />
    )
    expect(screen.getByTestId('branch-fork-selected-m1')).toHaveTextContent('B2')

    await openPopup('branch-fork-selected-m1', 'branch-fork-list-m1')
    // The taken child carries the current marker.
    expect(
      screen.getByTestId('branch-cascader-item-b-2').closest('[data-branch-id]')?.classList.contains('is-current')
    ).toBe(true)
    fireEvent.click(screen.getByTestId('branch-cascader-item-main'))
    expect(onSelectRoute).toHaveBeenCalledWith(
      null,
      'm1',
      expect.objectContaining({ anchorMessageId: 'm1', dividerKey: 'm1::main', parentBranchId: null })
    )
  })

  it('clicking the already-current row only closes, never navigates', async () => {
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={b2()}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
        activeBranchId="b-2"
      />
    )
    await openPopup('branch-fork-selected-m1', 'branch-fork-list-m1')
    fireEvent.click(screen.getByTestId('branch-cascader-item-b-2'))
    expect(onSelectRoute).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('branch-fork-selected-m1')).toHaveAttribute('aria-expanded', 'false'))
  })

  it('switching targets the shared anchor (never bottom) via the callback', async () => {
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    fireEvent.click(screen.getByTestId('branch-cascader-item-b-2'))
    expect(onSelectRoute).toHaveBeenCalledWith(
      'b-2',
      'm1',
      expect.objectContaining({ anchorMessageId: 'm1', dividerKey: 'm1::main', parentBranchId: null })
    )
  })

  it('open popup overlays content and never pushes in-flow layout (stable closed/open height)', async () => {
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    const row = screen.getByTestId('branch-fork-divider-m1')
    const beforeHeight = row.offsetHeight
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    // The option list renders in the overlay portal, not as in-flow content
    // inside the divider row — closed and open occupy the same layout height.
    expect(row.querySelector('[data-testid="branch-fork-list-m1"]')).toBeNull()
    expect(row.offsetHeight).toBe(beforeHeight)
  })

  it('popup offers rename/delete/copy on branch rows; the main/original row has no branch management', async () => {
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    expect(screen.getByTestId('branch-rename-btn-b-1')).toBeInTheDocument()
    expect(screen.getByTestId('branch-delete-btn-b-1')).toBeInTheDocument()
    expect(screen.getByTestId('branch-copy-btn-b-1')).toBeInTheDocument()
    expect(screen.queryByTestId('branch-rename-btn-__main')).toBeNull()
    expect(screen.queryByTestId('branch-delete-btn-__main')).toBeNull()
    expect(screen.queryByTestId('branch-copy-btn-__main')).toBeNull()
  })

  it('rename via the divider popup renames DB-first and refreshes the catalog', async () => {
    renameBranchMock.mockResolvedValue({ branch: b1() })
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    fireEvent.click(screen.getByTestId('branch-rename-btn-b-1'))
    const input = screen.getByTestId('branch-selector-rename-input')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)
    await waitFor(() => expect(renameBranchMock).toHaveBeenCalledWith('t-1', 'b-1', 'Renamed'))
    expect(requestBranchesMock).toHaveBeenCalledWith(expect.anything(), 't-1')
  })

  it('Escape cancels the divider rename: editor closes, nothing is written, re-entry starts from the original name', async () => {
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    fireEvent.click(screen.getByTestId('branch-rename-btn-b-1'))
    const input = screen.getByTestId('branch-selector-rename-input')
    fireEvent.change(input, { target: { value: 'Discarded draft' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    // The editor is gone, the row is back ...
    expect(screen.queryByTestId('branch-selector-rename-input')).toBeNull()
    expect(screen.getByTestId('branch-cascader-item-b-1')).toHaveTextContent('B1')
    // ... nothing was written and the catalog was not refreshed ...
    expect(renameBranchMock).not.toHaveBeenCalled()
    expect(requestBranchesMock).not.toHaveBeenCalled()
    // ... and re-entering starts from the stored name, not the discarded draft.
    fireEvent.click(screen.getByTestId('branch-rename-btn-b-1'))
    expect(screen.getByTestId('branch-selector-rename-input')).toHaveValue('B1')
  })

  it('delete via the divider popup removes the subtree and refreshes the catalog', async () => {
    deleteBranchSubtreeMock.mockResolvedValue({ deletedBranchIds: ['b-1'], fallbackBranchId: null })
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    // The shared confirmation's localized confirm button commits the delete.
    fireEvent.click(screen.getByTestId('branch-delete-btn-b-1'))
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(deleteBranchSubtreeMock).toHaveBeenCalledWith('t-1', 'b-1', null))
    expect(requestBranchesMock).toHaveBeenCalledWith(expect.anything(), 't-1')
  })

  it('copy via the divider popup copies the clicked row without switching route', async () => {
    copyBranchTreeMock.mockResolvedValue(3)
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    fireEvent.click(screen.getByTestId('branch-copy-btn-b-1'))
    await waitFor(() => expect(copyBranchTreeMock).toHaveBeenCalledTimes(1))
    // The clicked row is the source (never the active route): dispatch first,
    // then the topic and the row's own branch id.
    expect(copyBranchTreeMock.mock.calls[0].slice(1)).toEqual(['t-1', 'b-1'])
    expect(onSelectRoute).not.toHaveBeenCalled()
  })

  it('exposes localized expanded state on the toggle', async () => {
    const onSelectRoute = vi.fn()
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[b1(), b2()]}
        onSelectRoute={onSelectRoute}
        {...baseProps}
      />
    )
    const toggle = screen.getByTestId('branch-fork-toggle-m1')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-label', 'Expand branch')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m1')).toBeInTheDocument())
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-label', 'Collapse branch')
  })

  it('two dividers on distinct anchors open independently with their own children', async () => {
    const onSelectRoute = vi.fn()
    const messages = makeMessages([{ id: 'm0' }, { id: 'm1' }])
    const childrenByAnchor = new Map([
      ['m0', [wire('b-0', 'm0', null, 'B0')]],
      ['m1', [b1(), b2()]]
    ])
    expect(findAnchorsWithChildren(messages, childrenByAnchor)).toEqual(['m0', 'm1'])
    render(
      <div>
        <ForkDivider
          anchorMessageId="m0"
          taken={undefined}
          children={childrenByAnchor.get('m0')!}
          parentBranchId={null}
          parentLabel="Topic"
          topicId="t-1"
          activeBranchId={null}
          onSelectRoute={onSelectRoute}
        />
        <ForkDivider
          anchorMessageId="m1"
          taken={undefined}
          children={childrenByAnchor.get('m1')!}
          parentBranchId={null}
          parentLabel="Topic"
          topicId="t-1"
          activeBranchId={null}
          onSelectRoute={onSelectRoute}
        />
      </div>
    )
    fireEvent.click(screen.getByTestId('branch-fork-toggle-m0'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m0')).toBeInTheDocument())
    expect(screen.queryByTestId('branch-fork-list-m1')).not.toBeInTheDocument()
    expect(screen.getByTestId('branch-fork-toggle-m1')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('branch-cascader-item-b-0'))
    expect(onSelectRoute).toHaveBeenCalledWith(
      'b-0',
      'm0',
      expect.objectContaining({ anchorMessageId: 'm0', dividerKey: 'm0::main', parentBranchId: null })
    )
  })

  it('branch-parent fork scopes to that branch plus its direct children, with ops on the parent row', async () => {
    const onSelectRoute = vi.fn()
    const c1 = wire('c-1', 'm1', 'bp', 'C1', '2026-01-01T00:00:00.000Z')
    const c2 = wire('c-2', 'm1', 'bp', 'C2', '2026-01-02T00:00:00.000Z')
    render(
      <ForkDivider
        anchorMessageId="m1"
        taken={undefined}
        children={[c1, c2]}
        parentBranchId="bp"
        parentLabel="Parent"
        topicId="t-1"
        activeBranchId="bp"
        onSelectRoute={onSelectRoute}
      />
    )
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    // The display root is the parent branch itself (not the main route), and
    // a branch display root carries the same copy/rename/delete operations.
    expect(screen.getByTestId('branch-cascader-item-bp')).toHaveTextContent('Parent')
    expect(screen.getByTestId('branch-cascader-item-c-1')).toHaveTextContent('C1')
    expect(screen.getByTestId('branch-cascader-item-c-2')).toHaveTextContent('C2')
    expect(screen.getByTestId('branch-rename-btn-bp')).toBeInTheDocument()
    expect(screen.getByTestId('branch-delete-btn-bp')).toBeInTheDocument()
    expect(screen.getByTestId('branch-copy-btn-bp')).toBeInTheDocument()
    // The parent/original route is current here, so clicking it never navigates.
    expect(
      screen.getByTestId('branch-cascader-item-bp').closest('[data-branch-id]')?.classList.contains('is-current')
    ).toBe(true)
    // A child still switches with the fork's own parent identity in the payload.
    fireEvent.click(screen.getByTestId('branch-cascader-item-c-1'))
    expect(onSelectRoute).toHaveBeenCalledWith(
      'c-1',
      'm1',
      expect.objectContaining({ anchorMessageId: 'm1', dividerKey: 'm1::bp', parentBranchId: 'bp' })
    )
    // Reopen: clicking the current parent/original row only closes the popup.
    await openPopup('branch-fork-toggle-m1', 'branch-fork-list-m1')
    fireEvent.click(screen.getByTestId('branch-cascader-item-bp'))
    expect(onSelectRoute).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('branch-fork-toggle-m1')).toHaveAttribute('aria-expanded', 'false'))
  })
})

describe('single shared branch-route menu', () => {
  it('the fork divider renders the shared tree panel, not a second flat menu', async () => {
    const fs = await import('fs')
    const dividers = fs.readFileSync('src/renderer/src/pages/home/Messages/BranchDividers.tsx', 'utf8')
    expect(dividers).toMatch(/BranchTreePanel/)
    // The fork entry opens at its own floor, never the top selector's minimum.
    expect(dividers).toMatch(/minWidth=\{FORK_PANEL_MIN_WIDTH\}/)
    // No flat-only option row of its own: the only menu rows come from the panel.
    expect(dividers).not.toMatch(/BranchRouteOptionRow/)
    const routeOption = fs.readFileSync('src/renderer/src/pages/home/Messages/branchRouteOption.tsx', 'utf8')
    expect(routeOption).not.toMatch(/BranchRouteOptionRow/)
  })
})
