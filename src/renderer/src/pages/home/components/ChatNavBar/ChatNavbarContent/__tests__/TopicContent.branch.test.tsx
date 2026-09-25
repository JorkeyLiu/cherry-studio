import type { TopicBranchWire } from '@renderer/services/db/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const wire = (id: string, anchorMessageId: string, parentBranchId: string | null, name: string): TopicBranchWire =>
  ({
    id,
    topicId: 't-1',
    parentBranchId,
    anchorMessageId,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }) as TopicBranchWire

const b1 = () => wire('b-1', 'm1', null, 'B1')
const b2 = () => wire('b-2', 'm1', null, 'B2')
const b3 = () => wire('b-3', 'm2', 'b-1', 'B1-Child')

const { dispatchMock, renameBranchMock, deleteBranchSubtreeMock, requestBranchesMock, mockTree } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  renameBranchMock: vi.fn(),
  deleteBranchSubtreeMock: vi.fn(),
  requestBranchesMock: vi.fn(),
  mockTree: {
    branches: [] as TopicBranchWire[],
    path: [] as TopicBranchWire[],
    childrenByAnchor: new Map<string, TopicBranchWire[]>()
  }
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (fn: (s: unknown) => unknown) =>
    fn({ topicBranch: { activeBranchIdByTopic: { 't-1': (mockTree as any).activeBranchId ?? null } } })
}))

vi.mock('@renderer/pages/home/Messages/useBranchTree', () => ({
  requestTopicBranches: (...args: unknown[]) => requestBranchesMock(...args),
  useBranchTree: () => mockTree
}))

vi.mock('@renderer/services/db/branchSubtree', () => ({
  deleteBranchSubtree: (...args: unknown[]) => deleteBranchSubtreeMock(...args)
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    renameBranch: (...args: unknown[]) => renameBranchMock(...args)
  }
}))

vi.mock('@renderer/components/EmojiIcon', () => ({ default: () => <div data-testid="mock-emoji" /> }))
vi.mock('@renderer/components/HorizontalScrollContainer', () => ({
  default: ({ children }: any) => <div>{children}</div>
}))
vi.mock('../../../SelectModelButton', () => ({ default: () => <div data-testid="mock-model-btn" /> }))
vi.mock('../../Tools', () => ({ default: () => <div data-testid="mock-tools" /> }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => {
      const map: Record<string, string> = {
        'chat.default.name': 'Chat',
        'chat.topics.branch.rename': 'Rename Branch',
        'chat.topics.branch.delete': 'Delete Branch',
        'chat.topics.branch.delete_confirm': 'Delete this branch and all its descendant branches?',
        'chat.topics.branch.deleted': 'Branch deleted',
        'chat.topics.branch.collapse': 'Collapse branch',
        'chat.topics.branch.expand': 'Expand branch',
        'common.error': 'Error'
      }
      return map[key] ?? (opts?.count !== undefined ? `${key}:${opts.count}` : key)
    }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('antd', () => ({
  Button: ({ children, onClick, ...rest }: any) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
  Input: ({ value, onChange, onPressEnter, onBlur, ...rest }: any) => (
    <input
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      onKeyDown={(e: any) => {
        if (e.key === 'Enter') onPressEnter?.(e)
      }}
      {...rest}
    />
  ),
  Popconfirm: ({ children, onConfirm }: any) => (
    <div>
      {children}
      <button data-testid="mock-confirm" onClick={onConfirm}>
        confirm
      </button>
    </div>
  ),
  Popover: ({ content, children, onOpenChange }: any) => (
    <div>
      {children}
      <div>{content}</div>
      <button data-testid="mock-popover-open" onClick={() => onOpenChange?.(true)}>
        open
      </button>
      <button data-testid="mock-popover-close" onClick={() => onOpenChange?.(false)}>
        close
      </button>
    </div>
  )
}))

import type { Assistant, Topic } from '@renderer/types'

import TopicContent from '../TopicContent'

const assistant = { id: 'a1', name: 'A' } as unknown as Assistant
const topic = { id: 't-1', name: 'Root', assistantId: 'a1' } as Topic

function setTree(branches: TopicBranchWire[], path: TopicBranchWire[], activeBranchId: string | null): void {
  mockTree.branches = branches
  mockTree.path = path
  ;(mockTree as any).activeBranchId = activeBranchId
  const map = new Map<string, TopicBranchWire[]>()
  for (const b of branches) {
    const list = map.get(b.anchorMessageId) ?? []
    list.push(b)
    map.set(b.anchorMessageId, list)
  }
  mockTree.childrenByAnchor = map
}

describe('TopicContent unified branch selector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).toast = { success: vi.fn(), error: vi.fn() }
    setTree([], [], null)
  })

  it('hides the entry entirely when the topic was never branched', () => {
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    expect(screen.queryByTestId('branch-selector-entry')).not.toBeInTheDocument()
  })

  it('shows the topic-only breadcrumb on the main route', () => {
    setTree([b1(), b2()], [], null)
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    expect(screen.getByTestId('branch-selector-breadcrumb')).toHaveTextContent('Root')
  })

  it('shows the branch path breadcrumb on a branch route', () => {
    setTree([b1(), b3()], [b1(), b3()], 'b-3')
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    expect(screen.getByTestId('branch-selector-breadcrumb')).toHaveTextContent('Root / B1 / B1-Child')
  })

  it('cascader column 0 lists the main route plus level-1 branches', () => {
    setTree([b1(), b2()], [], null)
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    expect(screen.getByTestId('branch-cascader-col-0')).toBeInTheDocument()
    expect(screen.getByTestId('branch-cascader-item-main')).toHaveTextContent('Root')
    expect(screen.getByTestId('branch-cascader-item-b-1')).toHaveTextContent('B1')
    expect(screen.getByTestId('branch-cascader-item-b-2')).toHaveTextContent('B2')
  })

  it('current L1 with children opens col-0 only (no child over-expansion) until hover/focus on L1', () => {
    setTree([b1(), b2(), b3()], [b1()], 'b-1')
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    // Default expansion shows the current branch in its own column only:
    // L1 highlighted in col-0, no L1-child column yet.
    expect(screen.getByTestId('branch-cascader-col-0')).toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-col-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-item-b-3')).not.toBeInTheDocument()
    // Hovering/focusing the current L1 reveals its children (keyboard path too).
    fireEvent.mouseEnter(screen.getByTestId('branch-cascader-row-b-1'))
    expect(screen.getByTestId('branch-cascader-item-b-3')).toHaveTextContent('B1-Child')
    // Hovering the sibling collapses back to its (empty) level.
    fireEvent.mouseEnter(screen.getByTestId('branch-cascader-row-b-2'))
    expect(screen.queryByTestId('branch-cascader-item-b-3')).not.toBeInTheDocument()
    // Focusing the parent re-opens the child column (keyboard path).
    fireEvent.focus(screen.getByTestId('branch-cascader-row-b-1'))
    expect(screen.getByTestId('branch-cascader-item-b-3')).toBeInTheDocument()
  })

  it('current L2 opens through the L2-containing column but not L2 children', () => {
    const b4 = { ...b3(), id: 'b-4', parentBranchId: 'b-3', anchorMessageId: 'm3', name: 'B1-Grandchild' }
    setTree([b1(), b2(), b3(), b4], [b1(), b3()], 'b-3')
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    // Columns needed to place the current branch: col-0 (main/L1) + col-1
    // (L1 children incl. current L2). No col-2 for L2's own children.
    expect(screen.getByTestId('branch-cascader-col-0')).toBeInTheDocument()
    expect(screen.getByTestId('branch-cascader-col-1')).toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-col-2')).not.toBeInTheDocument()
    expect(screen.getByTestId('branch-cascader-item-b-3')).toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-item-b-4')).not.toBeInTheDocument()
  })

  it('repeat close/open preserves the same no-over-expansion behavior', () => {
    setTree([b1(), b2(), b3()], [b1()], 'b-1')
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    // Hover reveals children, then close/open resets to the default.
    fireEvent.mouseEnter(screen.getByTestId('branch-cascader-row-b-1'))
    expect(screen.getByTestId('branch-cascader-item-b-3')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mock-popover-close'))
    expect(screen.queryByTestId('branch-cascader-item-b-3')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mock-popover-open'))
    expect(screen.getByTestId('branch-cascader-col-0')).toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-col-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-item-b-3')).not.toBeInTheDocument()
  })

  it('selected options use highlighted background only (no checkmark icons)', () => {
    setTree([b1(), b2()], [], null)
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    expect(screen.getByTestId('branch-cascader-item-main')).not.toHaveTextContent('✓')
    expect(screen.getByTestId('branch-cascader-item-b-1')).not.toHaveTextContent('✓')
    expect(document.body.textContent ?? '').not.toContain('✓')
  })

  it('removes the redundant left breadcrumb while retaining model + branch selectors', () => {
    setTree([b1(), b2()], [], null)
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    // Redundant assistant chip removed.
    expect(screen.queryByTestId('mock-emoji')).not.toBeInTheDocument()
    // Model selector and unified branch selector retained (with own path display).
    expect(screen.getByTestId('mock-model-btn')).toBeInTheDocument()
    expect(screen.getByTestId('branch-selector-entry')).toBeInTheDocument()
    expect(screen.getByTestId('branch-selector-breadcrumb')).toHaveTextContent('Root')
  })

  it('pins Edit/Settings tools at the far right', () => {
    setTree([b1(), b2()], [], null)
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    const toolsRight = screen.getByTestId('navbar-tools-right')
    expect(toolsRight.className).toMatch(/ml-auto/)
    expect(screen.getByTestId('mock-tools')).toBeInTheDocument()
  })

  it('keeps the navbar entry default-aligned while left-aligning every cascader option row', () => {
    setTree([b1(), b2()], [], null)
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    expect(screen.getByTestId('branch-selector-entry').style.justifyContent).not.toBe('flex-start')
    expect(screen.getByTestId('branch-cascader-item-main').style.justifyContent).toBe('flex-start')
    expect(screen.getByTestId('branch-cascader-item-b-1').style.justifyContent).toBe('flex-start')
    expect(screen.getByTestId('branch-cascader-item-b-1').style.textAlign).toBe('left')
  })

  it('switching dispatches the route change for the SAME topic (never setActiveTopic, never addTopic)', () => {
    setTree([b1(), b2()], [], null)
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    fireEvent.click(screen.getByTestId('branch-cascader-item-b-2'))
    expect(setActiveTopic).not.toHaveBeenCalled()
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'topicBranch/activeBranchSet', payload: { topicId: 't-1', branchId: 'b-2' } })
    )
  })

  it('renames the branch DB-first and refreshes the catalog (topic rename untouched)', () => {
    setTree([b1()], [], null)
    renameBranchMock.mockResolvedValue({ branch: b1() })
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    fireEvent.click(screen.getByTestId('branch-rename-btn-b-1'))
    const input = screen.getByTestId('branch-selector-rename-input')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)
    expect(renameBranchMock).toHaveBeenCalledWith('t-1', 'b-1', 'Renamed')
  })

  it('delete removes the subtree and refreshes the catalog; last delete restores the no-branch state', async () => {
    setTree([b1()], [b1()], 'b-1')
    deleteBranchSubtreeMock.mockResolvedValue({ deletedBranchIds: ['b-1'], fallbackBranchId: null })
    const setActiveTopic = vi.fn()
    render(<TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={setActiveTopic} />)
    fireEvent.click(screen.getByTestId('mock-confirm'))
    await vi.waitFor(() => expect(deleteBranchSubtreeMock).toHaveBeenCalledWith('t-1', 'b-1', 'b-1'))
    expect(setActiveTopic).not.toHaveBeenCalled()
    expect(requestBranchesMock).toHaveBeenCalledWith(expect.anything(), 't-1')
  })
})
