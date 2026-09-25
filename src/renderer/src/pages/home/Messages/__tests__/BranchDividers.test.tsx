import type { TopicBranchWire } from '@renderer/services/db/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { findAnchorsWithChildren, ForkDivider, forkRouteOptions, takenChildAtAnchor } from '../BranchDividers'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => {
      const map: Record<string, string> = {
        'chat.topics.branch.rename': 'Rename Branch',
        'chat.topics.branch.delete': 'Delete Branch',
        'chat.topics.branch.delete_confirm': 'Delete this branch and all its descendant branches?',
        'chat.topics.branch.deleted': 'Branch deleted',
        'chat.topics.branch.collapse': 'Collapse branch',
        'chat.topics.branch.expand': 'Expand branch',
        'common.error': 'Error'
      }
      if (map[key] !== undefined) return map[key]
      return opts?.count !== undefined ? `${key}:${opts.count}` : key
    }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const { dispatchMock, renameBranchMock, deleteBranchSubtreeMock, requestBranchesMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  renameBranchMock: vi.fn(),
  deleteBranchSubtreeMock: vi.fn(),
  requestBranchesMock: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    renameBranch: (...args: unknown[]) => renameBranchMock(...args)
  }
}))

vi.mock('@renderer/services/db/branchSubtree', () => ({
  deleteBranchSubtree: (...args: unknown[]) => deleteBranchSubtreeMock(...args)
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
    parentLabel: 'Topic',
    countLabel: '此处有 2 条分支'
  }

  it('untaken fork renders the count form; popup includes the parent/original route plus children', async () => {
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

    fireEvent.click(screen.getByTestId('branch-fork-toggle-m1'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m1')).toBeInTheDocument())
    // Flat peer set: parent/original + direct children, no cascader columns.
    expect(screen.queryByTestId('branch-cascader-col-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('branch-fork-item-parent-m1')).toHaveTextContent('Topic')
    expect(screen.getByTestId('branch-fork-item-b-1')).toHaveTextContent('B1')
    expect(screen.getByTestId('branch-fork-item-b-2')).toHaveTextContent('B2')
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

    fireEvent.click(screen.getByTestId('branch-fork-selected-m1'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('branch-fork-item-parent-m1'))
    expect(onSelectRoute).toHaveBeenCalledWith(null, 'm1')
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
    fireEvent.click(screen.getByTestId('branch-fork-toggle-m1'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('branch-fork-item-b-2'))
    expect(onSelectRoute).toHaveBeenCalledWith('b-2', 'm1')
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
    fireEvent.click(screen.getByTestId('branch-fork-toggle-m1'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m1')).toBeInTheDocument())
    // The option list renders in the overlay portal, not as in-flow content
    // inside the divider row — closed and open occupy the same layout height.
    expect(row.querySelector('[data-testid="branch-fork-list-m1"]')).toBeNull()
    expect(row.offsetHeight).toBe(beforeHeight)
  })

  it('popup provides rename/delete controls for non-main branch options only', async () => {
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
    fireEvent.click(screen.getByTestId('branch-fork-toggle-m1'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m1')).toBeInTheDocument())
    expect(screen.getByTestId('branch-fork-rename-btn-b-1')).toBeInTheDocument()
    expect(screen.getByTestId('branch-fork-delete-btn-b-1')).toBeInTheDocument()
    expect(screen.queryByTestId('branch-fork-rename-btn-parent')).toBeNull()
    // No cascader/descendant navigation inside a divider popup.
    expect(screen.queryByTestId('branch-cascader-col-0')).toBeNull()
    expect(screen.queryByTestId('branch-cascader-col-1')).toBeNull()
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
    fireEvent.click(screen.getByTestId('branch-fork-toggle-m1'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('branch-fork-rename-btn-b-1'))
    const input = screen.getByTestId('branch-fork-rename-input')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)
    await waitFor(() => expect(renameBranchMock).toHaveBeenCalledWith('t-1', 'b-1', 'Renamed'))
    expect(requestBranchesMock).toHaveBeenCalledWith(expect.anything(), 't-1')
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
    fireEvent.click(screen.getByTestId('branch-fork-toggle-m1'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m1')).toBeInTheDocument())
    // The Popconfirm confirm button commits the delete.
    fireEvent.click(screen.getByTestId('branch-fork-delete-btn-b-1'))
    const confirmBtn = await screen.findByRole('button', { name: 'OK' })
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(deleteBranchSubtreeMock).toHaveBeenCalledWith('t-1', 'b-1', null))
    expect(requestBranchesMock).toHaveBeenCalledWith(expect.anything(), 't-1')
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

  it('two dividers on distinct anchors open independently with their own flat children', async () => {
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
          countLabel="此处有 1 条分支"
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
          countLabel="此处有 2 条分支"
          onSelectRoute={onSelectRoute}
        />
      </div>
    )
    fireEvent.click(screen.getByTestId('branch-fork-toggle-m0'))
    await waitFor(() => expect(screen.getByTestId('branch-fork-list-m0')).toBeInTheDocument())
    expect(screen.queryByTestId('branch-fork-list-m1')).not.toBeInTheDocument()
    expect(screen.getByTestId('branch-fork-toggle-m1')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('branch-fork-item-b-0'))
    expect(onSelectRoute).toHaveBeenCalledWith('b-0', 'm0')
  })
})
