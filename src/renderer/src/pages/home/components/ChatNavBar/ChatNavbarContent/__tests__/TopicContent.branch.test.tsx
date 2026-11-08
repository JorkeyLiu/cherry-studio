import type { TopicBranchWire } from '@renderer/services/db/types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Behaviour contract for the unified top branch selector.
 *
 * The entry is one icon-only button immediately left of the path it opens — the
 * row reads model selector, branch entry, path, then the right-hand tool group
 * — and it is the only thing that opens the panel. The selector is a vertical
 * branch tree: opening it expands the current
 * route's ancestors, the chevron slot expands/collapses without switching, the
 * name switches route and closes, hover/focus never changes expansion, and
 * several forks stay open at once. Non-root rows carry their rename/delete
 * controls directly: rename edits inline and commits on Enter or blur (Escape
 * cancels it), delete confirms through a popconfirm with a loading state, and
 * neither dismisses the selector. Route switches keep going through the
 * viewport's single `requestTopRoute` entry point (asserted through the
 * dispatched `activeBranchSet` action), and renames/deletes stay DB-first with
 * a catalog refresh afterwards.
 *
 * Layout-dependent rules are asserted through the boxes a laid-out row really
 * produces (stubbed, since jsdom has no layout): how much of the path fits,
 * where the popover's left edge and width come from, and that the tree's
 * connectors are committed in the same pass as the rows they belong to.
 */

const wire = (id: string, parentBranchId: string | null, name: string): TopicBranchWire =>
  ({
    id,
    topicId: 't-1',
    parentBranchId,
    anchorMessageId: `m-${id}`,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }) as TopicBranchWire

const b1 = () => wire('b-1', null, 'B1')
const b2 = () => wire('b-2', null, 'B2')
const b3 = () => wire('b-3', 'b-1', 'B1-Child')
const b4 = () => wire('b-4', 'b-3', 'B1-Grandchild')
const b5 = () => wire('b-5', 'b-2', 'B2-Child')

const {
  dispatchMock,
  renameBranchMock,
  deleteBranchSubtreeMock,
  requestBranchesMock,
  mockTree,
  popoverProps,
  popconfirmProps
} = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  renameBranchMock: vi.fn(),
  deleteBranchSubtreeMock: vi.fn(),
  requestBranchesMock: vi.fn(),
  popoverProps: [] as Array<{ align?: unknown; placement?: unknown }>,
  popconfirmProps: [] as Array<{ okText?: string; cancelText?: string }>,
  mockTree: {
    branches: [] as TopicBranchWire[],
    path: [] as TopicBranchWire[],
    childrenByAnchor: new Map<string, TopicBranchWire[]>()
  }
}))

/**
 * antd's own Popover and Popconfirm, with the props this component hands them
 * recorded.
 *
 * The panel's placement is an align input, and jsdom has no layout to run the
 * real alignment pass in — so what is asserted here is the contract this
 * component hands over (the real popup rendering still comes from antd
 * itself). Whether that contract really keeps the panel still is a rendered
 * behaviour and is proven in the app, not here. The confirmation's wording is
 * the same kind of contract: which labels the app asks for, and that the real
 * component renders them.
 */
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const RealPopover = actual.Popover as (props: Record<string, unknown>) => React.ReactNode
  const RealPopconfirm = actual.Popconfirm as (props: Record<string, unknown>) => React.ReactNode
  return {
    ...actual,
    Popover: (props: Record<string, unknown>) => {
      popoverProps.push(props as { align?: unknown; placement?: unknown })
      return <RealPopover {...props} />
    },
    Popconfirm: (props: Record<string, unknown>) => {
      popconfirmProps.push(props as { okText?: string; cancelText?: string })
      return <RealPopconfirm {...props} />
    }
  }
})

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (fn: (state: unknown) => unknown) =>
    fn({
      topicBranch: {
        activeBranchIdByTopic: { 't-1': (mockTree as { activeBranchId?: string | null }).activeBranchId ?? null }
      }
    })
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
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('../../../SelectModelButton', () => ({ default: () => <div data-testid="mock-model-btn" /> }))
vi.mock('../../Tools', () => ({ default: () => <div data-testid="mock-tools" /> }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      const map: Record<string, string> = {
        'chat.default.name': 'Chat',
        'chat.topics.branch.rename': 'Rename branch',
        'chat.topics.branch.delete': 'Delete branch',
        'chat.topics.branch.delete_confirm': 'Delete this branch and all its descendants?',
        'chat.topics.branch.deleted': 'Branch deleted',
        'chat.topics.branch.current': 'Current',
        'chat.topics.branch.tag': 'Branches',
        'chat.topics.branch.collapse_all': 'Collapse all',
        'chat.topics.branch.expand': 'Expand branch',
        'chat.topics.branch.children_here': `Branches here: ${options?.count ?? 0}`,
        'common.rename': 'Rename',
        'common.delete': 'Delete',
        'common.more': 'More',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
        'common.confirm': 'Confirm',
        'common.error': 'Error'
      }
      return map[key] ?? key
    }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

import { RouteViewportProvider } from '@renderer/pages/home/Messages/routeViewportContext'
import type { Assistant, Topic } from '@renderer/types'

import TopicContent from '../TopicContent'

// jsdom does not implement pseudo-element computed styles, which rc-util's
// scrollbar measurement asks for. Drop the pseudo-element argument instead of
// letting every Modal/Dropdown open log an unimplemented call.
const nativeGetComputedStyle = window.getComputedStyle.bind(window)
vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => nativeGetComputedStyle(element))
const assistant = { id: 'a1', name: 'A' } as unknown as Assistant
const topic = { id: 't-1', name: 'Runtopic', assistantId: 'a1' } as Topic

/** Mirrors production: the route provided by the provider matches the mocked active branch. */
function setTree(branches: TopicBranchWire[], path: TopicBranchWire[], activeBranchId: string | null): void {
  mockTree.branches = branches
  mockTree.path = path
  ;(mockTree as { activeBranchId?: string | null }).activeBranchId = activeBranchId
}

function renderTopicContent(): ReturnType<typeof render> {
  const initialRoute = (mockTree as { activeBranchId?: string | null }).activeBranchId ?? null
  return render(
    <RouteViewportProvider topicId={topic.id} initialRoute={initialRoute}>
      <TopicContent assistant={assistant} activeTopic={topic} setActiveTopic={vi.fn()} />
    </RouteViewportProvider>
  )
}

/** True when `first` really precedes `second` in document order. */
const precedes = (first: Element, second: Element): boolean =>
  (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

const rowOf = (id: string): HTMLElement => screen.getByTestId(`branch-cascader-item-${id}`)
const switcherOf = (id: string): HTMLElement => {
  const row = rowOf(id).closest('.ant-tree-treenode')
  const switcher = row?.querySelector('.ant-tree-switcher')
  if (!switcher) throw new Error(`no chevron slot for ${id}`)
  return switcher as HTMLElement
}
const routeDispatches = (): unknown[] =>
  dispatchMock.mock.calls.map((call) => call[0]).filter((action) => action?.type === 'topicBranch/activeBranchSet')

async function openSelector(): Promise<void> {
  fireEvent.click(screen.getByTestId('branch-selector-entry'))
  await screen.findByTestId('branch-selector-popover')
}

/**
 * Clicks the OK/Cancel control of the popconfirm currently on screen. The
 * confirmation is a popconfirm, so its buttons live outside the tree's subtree.
 */
async function popconfirmButton(ok: boolean): Promise<HTMLElement> {
  return waitFor(() => {
    const buttons = document.querySelectorAll<HTMLElement>('.ant-popconfirm-buttons .ant-btn')
    const target = Array.from(buttons).find((button) =>
      ok ? button.classList.contains('ant-btn-primary') : !button.classList.contains('ant-btn-primary')
    )
    if (!target) throw new Error('delete popconfirm is not open')
    return target
  })
}

const ROW_HEIGHT = 30
/** The chevron column the connector geometry is measured from. */
const SLOT_WIDTH = 16
const SLOT_END_GAP = 6
const INDENT_SIZE = 20

const fakeRect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  }) as DOMRect

/** Width a rendered crumb chip collapses to: the per-segment caps of the plate. */
const crumbChipWidth = (label: string, isCurrent: boolean): number =>
  Math.min(label.length * 8 + 12, isCurrent ? 180 : 140)

type LayoutState = {
  /** Width the row's flexible path slot offers the breadcrumb. */
  crumbSlotWidth?: number
  /** Trigger (branch entry) box, for the popover fit. */
  triggerLeft?: number
  triggerWidth?: number
  /** Panel box after layout. */
  panelWidth?: number
}

/**
 * jsdom performs no layout, so the component's own measurement can only ever
 * see zero-size rects there. This installs the numbers the real navbar and tree
 * produce (a path slot of a given width with real text metrics, the trigger's
 * box, 30px rows from the content's top, a 16px chevron column per depth, a 6px
 * gap, then the name column), which makes the committed decisions assertable.
 * The 28px hit target is a transparent pseudo-element, so it never shows up in
 * these boxes — exactly like the real browser.
 */
function stubLayout(state: LayoutState): () => void {
  const childrenOf = (el: Element): Element[] => Array.from(el.children)
  const rowIndexOf = (row: Element): number => Array.from(row.parentElement?.children ?? []).indexOf(row)
  const rowRect = (row: Element): DOMRect => fakeRect(0, rowIndexOf(row) * ROW_HEIGHT, 400, ROW_HEIGHT)
  const depthOf = (row: Element): number => row.querySelectorAll('.ant-tree-indent-unit').length

  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const testId = this.getAttribute('data-testid')
    if (testId === 'branch-crumb-slot') {
      return fakeRect(0, 0, state.crumbSlotWidth ?? 0, 26)
    }
    if (testId === 'branch-selector-entry') {
      return fakeRect(state.triggerLeft ?? 0, 0, state.triggerWidth ?? 0, 30)
    }
    if (testId === 'branch-selector-popover') {
      return fakeRect(0, 0, state.panelWidth ?? 0, 300)
    }
    const measureKind = this.getAttribute('data-kind')
    if (measureKind === 'segment') {
      const isCurrent = this.getAttribute('data-current') === 'true'
      return fakeRect(0, 0, crumbChipWidth(this.textContent ?? '', isCurrent), 22)
    }
    if (measureKind === 'separator') return fakeRect(0, 0, 6, 12)
    if (measureKind === 'gap') return fakeRect(0, 0, 12, 22)
    if (this.classList.contains('ant-tree-treenode')) return rowRect(this)
    const row = this.closest('.ant-tree-treenode')
    if (row && this.classList.contains('ant-tree-switcher')) {
      return fakeRect(depthOf(row) * INDENT_SIZE, rowRect(row).top, SLOT_WIDTH, ROW_HEIGHT)
    }
    if (row && this.classList.contains('ant-tree-node-content-wrapper')) {
      return fakeRect(depthOf(row) * INDENT_SIZE + SLOT_WIDTH + SLOT_END_GAP, rowRect(row).top, 200, 28)
    }
    // The measured content container: it owns the SVG edge layer and the tree.
    const kids = childrenOf(this)
    const isContent =
      kids.some((kid) => kid.tagName.toLowerCase() === 'svg') &&
      kids.some((kid) => kid.classList.contains('branch-tree'))
    if (isContent) return fakeRect(0, 0, 400, 12 * ROW_HEIGHT)
    return fakeRect(0, 0, 0, 0)
  })
  return () => spy.mockRestore()
}

/** The connector layer of the open popover (the panel's first SVG). */
const edgesOf = (): SVGSVGElement | null =>
  screen.queryByTestId('branch-selector-popover')?.querySelector('svg') ?? null

/** Every style rule styled-components has injected so far. */
const styleText = (): string =>
  Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n')

/** The positioned popup element: whatever offset it carries must not be a CSS one. */
const popupElement = (): HTMLElement | null => document.querySelector<HTMLElement>('.ant-popover')

/** The props of the most recent Popover render — the placement it was handed. */
const lastPopoverProps = (): { align?: unknown; placement?: unknown } => {
  const props = popoverProps.at(-1)
  if (!props) throw new Error('the branch popover was never rendered')
  return props
}

const setViewportWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

describe('TopicContent unified branch selector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { toast: { success: () => void; error: () => void } }).toast = {
      success: vi.fn(),
      error: vi.fn()
    }
    setTree([], [], null)
    // The recorded popup props are not mock functions: cleared by hand.
    popoverProps.length = 0
    popconfirmProps.length = 0
  })

  afterEach(() => {
    setViewportWidth(1024)
  })

  it('hides the entry entirely when the topic was never branched', () => {
    renderTopicContent()
    expect(screen.queryByTestId('branch-selector-entry')).not.toBeInTheDocument()
  })

  it('shows the topic name as the only segment on the main route', () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    const crumb = screen.getByTestId('branch-selector-breadcrumb')
    expect(crumb).toHaveTextContent('Runtopic')
    expect(crumb.getAttribute('aria-label')).toBe('Runtopic')
    expect(crumb.getAttribute('title')).toBe('Runtopic')
  })

  it('shows the full route path as breadcrumb segments with one separator each and the whole path accessible', () => {
    setTree([b1(), b3()], [b1(), b3()], 'b-3')
    renderTopicContent()
    const crumb = screen.getByTestId('branch-selector-breadcrumb')
    // One "/" between two visible segments, nothing leading or trailing.
    expect(crumb.textContent).toBe('Runtopic/B1/B1-Child')
    expect(crumb.getAttribute('aria-label')).toBe('Runtopic / B1 / B1-Child')
    expect(crumb.getAttribute('title')).toBe('Runtopic / B1 / B1-Child')
  })

  it('uses the whole free width of the row and shows every layer when the path fits', () => {
    setTree([b1(), b3(), b4()], [b1(), b3(), b4()], 'b-4')
    const restore = stubLayout({ crumbSlotWidth: 420 })
    try {
      renderTopicContent()
      // Three to four layers are normal: with the row's spare width released,
      // nothing has to be folded away.
      expect(screen.getByTestId('branch-crumb-main')).toHaveTextContent('Runtopic')
      expect(screen.getByTestId('branch-crumb-b-1')).toHaveTextContent('B1')
      expect(screen.getByTestId('branch-crumb-b-3')).toHaveTextContent('B1-Child')
      expect(screen.getByTestId('branch-crumb-b-4')).toHaveTextContent('B1-Grandchild')
      const crumb = screen.getByTestId('branch-selector-breadcrumb')
      expect(crumb.textContent).not.toContain('…')
      expect(crumb.textContent?.split('/')).toHaveLength(4)
      expect(crumb.getAttribute('title')).toBe('Runtopic / B1 / B1-Child / B1-Grandchild')
    } finally {
      restore()
    }
  })

  it('keeps the nearest ancestor when the whole path cannot fit, behind one marker', () => {
    setTree([b1(), b3(), b4()], [b1(), b3(), b4()], 'b-4')
    const restore = stubLayout({ crumbSlotWidth: 320 })
    try {
      renderTopicContent()
      const crumb = screen.getByTestId('branch-selector-breadcrumb')
      // Root, one marker for the hidden layer, then the most recent parent and
      // the current route: the oldest middle is the one that goes.
      expect(crumb.textContent).toBe('Runtopic/…/B1-Child/B1-Grandchild')
      expect(crumb.textContent?.match(/…/g)).toHaveLength(1)
      expect(crumb.textContent).not.toContain('//')
      expect(screen.queryByTestId('branch-crumb-b-1')).not.toBeInTheDocument()
      // The full path stays available even when it is not all on screen.
      expect(crumb.getAttribute('aria-label')).toBe('Runtopic / B1 / B1-Child / B1-Grandchild')
    } finally {
      restore()
    }
  })

  it('keeps only the root and the current route when nothing else fits', () => {
    setTree([b1(), b3(), b4()], [b1(), b3(), b4()], 'b-4')
    const restore = stubLayout({ crumbSlotWidth: 240 })
    try {
      renderTopicContent()
      const crumb = screen.getByTestId('branch-selector-breadcrumb')
      expect(crumb.textContent).toBe('Runtopic/…/B1-Grandchild')
      expect(crumb.textContent?.match(/…/g)).toHaveLength(1)
      expect(crumb.getAttribute('title')).toBe('Runtopic / B1 / B1-Child / B1-Grandchild')
    } finally {
      restore()
    }
  })

  it('opens with the current route ancestors expanded and the other forks left collapsed', async () => {
    setTree([b1(), b2(), b3(), b4(), b5()], [b1(), b3()], 'b-3')
    renderTopicContent()
    await openSelector()

    // Ancestors of the current route are open: the current L2 row is visible.
    expect(rowOf('main')).toBeInTheDocument()
    expect(rowOf('b-1')).toBeInTheDocument()
    expect(rowOf('b-3')).toBeInTheDocument()
    // The current node's own children stay collapsed, and an unrelated fork
    // stays collapsed too.
    expect(screen.queryByTestId('branch-cascader-item-b-4')).not.toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-item-b-5')).not.toBeInTheDocument()
    expect(rowOf('b-2')).toBeInTheDocument()
  })

  it('expands only through the chevron, without switching route or closing the selector', async () => {
    setTree([b1(), b2(), b3()], [b1()], 'b-1')
    renderTopicContent()
    await openSelector()

    fireEvent.click(switcherOf('b-1'))
    await screen.findByTestId('branch-cascader-item-b-3')

    expect(routeDispatches()).toHaveLength(0)
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
    // Collapsing back removes the child row again.
    fireEvent.click(switcherOf('b-1'))
    await waitFor(() => expect(screen.queryByTestId('branch-cascader-item-b-3')).not.toBeInTheDocument())
    expect(routeDispatches()).toHaveLength(0)
  })

  it('switches route on the name and closes the selector', async () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    await openSelector()

    fireEvent.click(rowOf('b-2'))

    expect(routeDispatches()).toEqual([
      expect.objectContaining({
        type: 'topicBranch/activeBranchSet',
        payload: { topicId: 't-1', branchId: 'b-2' }
      })
    ])
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())
  })

  it('never changes expansion on hover or focus', async () => {
    setTree([b1(), b2(), b3()], [], null)
    renderTopicContent()
    await openSelector()

    fireEvent.mouseEnter(rowOf('b-1'))
    fireEvent.focus(rowOf('b-1'))
    // Give any hover-driven update a chance to land before asserting absence.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('branch-cascader-item-b-3')).not.toBeInTheDocument()
    expect(routeDispatches()).toHaveLength(0)
  })

  it('keeps several forks expanded at the same time', async () => {
    setTree([b1(), b2(), b3(), b5()], [], null)
    renderTopicContent()
    await openSelector()

    fireEvent.click(switcherOf('b-1'))
    await screen.findByTestId('branch-cascader-item-b-3')
    fireEvent.click(switcherOf('b-2'))
    await screen.findByTestId('branch-cascader-item-b-5')

    // The first fork stayed open while the second was expanded.
    expect(rowOf('b-3')).toBeInTheDocument()
    expect(rowOf('b-5')).toBeInTheDocument()
  })

  it('switches to an ancestor route from its breadcrumb segment', () => {
    setTree([b1(), b3()], [b1(), b3()], 'b-3')
    renderTopicContent()

    fireEvent.click(screen.getByTestId('branch-crumb-b-1'))

    expect(routeDispatches()).toEqual([
      expect.objectContaining({
        type: 'topicBranch/activeBranchSet',
        payload: { topicId: 't-1', branchId: 'b-1' }
      })
    ])
  })

  it('marks the current row and shows a direct-child count only when it has children', async () => {
    setTree([b1(), b2(), b3()], [b1()], 'b-1')
    renderTopicContent()
    await openSelector()

    const currentRow = rowOf('b-1').closest('[data-branch-id]') as HTMLElement
    expect(currentRow.dataset.current).toBe('true')
    expect(within(currentRow).getByText('Current')).toBeInTheDocument()
    // b-1 has one direct child, b-2 has none.
    expect(within(currentRow).getByTitle('Branches here: 1')).toBeInTheDocument()
    const leafRow = rowOf('b-2').closest('[data-branch-id]') as HTMLElement
    expect(leafRow.dataset.current).toBeUndefined()
    expect(within(leafRow).queryByTitle(/Branches here/)).not.toBeInTheDocument()
  })

  it('offers direct rename/delete controls only for non-root rows', async () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    await openSelector()

    // The root row is the logical topic: nothing to rename or delete.
    expect(screen.queryByTestId('branch-rename-btn-__main')).not.toBeInTheDocument()
    expect(screen.queryByTestId('branch-delete-btn-__main')).not.toBeInTheDocument()
    expect(screen.getByTestId('branch-rename-btn-b-1')).toBeInTheDocument()
    expect(screen.getByTestId('branch-delete-btn-b-1')).toBeInTheDocument()
    // No "more actions" submenu survives the change.
    expect(screen.queryByTestId('branch-more-btn-b-1')).not.toBeInTheDocument()
    // Both controls belong to the row they act on.
    const row = rowOf('b-1').closest('[data-branch-id]')
    expect(screen.getByTestId('branch-rename-btn-b-1').closest('[data-branch-id]')).toBe(row)
    expect(screen.getByTestId('branch-delete-btn-b-1').closest('[data-branch-id]')).toBe(row)
  })

  it('renames DB-first inline on Enter and refreshes the catalog', async () => {
    setTree([b1(), b2()], [], null)
    renameBranchMock.mockResolvedValue({ branch: b1() })
    renderTopicContent()
    await openSelector()

    fireEvent.click(screen.getByTestId('branch-rename-btn-b-1'))
    const input = await screen.findByTestId('branch-selector-rename-input')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(renameBranchMock).toHaveBeenCalledWith('t-1', 'b-1', 'Renamed'))
    expect(requestBranchesMock).toHaveBeenCalledWith(expect.anything(), 't-1')
    await waitFor(() => expect(screen.queryByTestId('branch-selector-rename-input')).not.toBeInTheDocument())
    // Committing closes the editor once: no second write on the closing blur.
    expect(renameBranchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
  })

  it('commits the inline rename on blur without writing twice', async () => {
    setTree([b1(), b2()], [], null)
    renameBranchMock.mockResolvedValue({ branch: b1() })
    renderTopicContent()
    await openSelector()

    fireEvent.click(screen.getByTestId('branch-rename-btn-b-1'))
    const input = await screen.findByTestId('branch-selector-rename-input')
    fireEvent.change(input, { target: { value: 'Blurred' } })
    fireEvent.blur(input)

    await waitFor(() => expect(renameBranchMock).toHaveBeenCalledWith('t-1', 'b-1', 'Blurred'))
    expect(renameBranchMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('branch-selector-rename-input')).not.toBeInTheDocument()
  })

  it('Escape cancels the inline rename without writing and keeps the selector open', async () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    await openSelector()

    fireEvent.click(screen.getByTestId('branch-rename-btn-b-1'))
    const input = await screen.findByTestId('branch-selector-rename-input')
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('branch-selector-rename-input')).not.toBeInTheDocument())
    expect(renameBranchMock).not.toHaveBeenCalled()
    expect(requestBranchesMock).not.toHaveBeenCalled()
    // Cancelling an edit leaves the row and the tree exactly as they were.
    expect(rowOf('b-1')).toHaveTextContent('B1')
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
  })

  it('deletes the subtree from the row popconfirm and refreshes the catalog', async () => {
    setTree([b1()], [b1()], 'b-1')
    deleteBranchSubtreeMock.mockResolvedValue({ deletedBranchIds: ['b-1'], fallbackBranchId: null })
    renderTopicContent()
    await openSelector()

    fireEvent.click(screen.getByTestId('branch-delete-btn-b-1'))
    fireEvent.click(await popconfirmButton(true))

    await waitFor(() => expect(deleteBranchSubtreeMock).toHaveBeenCalledWith('t-1', 'b-1', 'b-1'))
    expect(requestBranchesMock).toHaveBeenCalledWith(expect.anything(), 't-1')
    expect((window as unknown as { toast: { success: ReturnType<typeof vi.fn> } }).toast.success).toHaveBeenCalled()
    // Deleting is a row action on the open tree; it does not dismiss it.
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
  })

  it('asks for the delete in the app locale instead of the popup library default', async () => {
    setTree([b1()], [b1()], 'b-1')
    renderTopicContent()
    await openSelector()

    fireEvent.click(screen.getByTestId('branch-delete-btn-b-1'))
    const okButton = await popconfirmButton(true)
    const cancelButton = await popconfirmButton(false)

    // The confirmation is worded by the app, from the same i18n resource every
    // other destructive confirmation uses — never from the popup library's own
    // built-in English buttons.
    const handedOver = popconfirmProps.at(-1) as { okText?: string; cancelText?: string }
    expect(handedOver.okText).toBe('Confirm')
    expect(handedOver.cancelText).toBe('Cancel')
    // …and those labels are what the buttons really render.
    expect(okButton.textContent).toBe('Confirm')
    expect(cancelButton.textContent).toBe('Cancel')
  })

  it('closes the selector on Escape', async () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    await openSelector()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())
    // The entry stays available for the next open.
    expect(screen.getByTestId('branch-selector-entry')).toBeInTheDocument()
  })

  it('closes the selector on a second click on its own entry', async () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    await openSelector()

    // The entry is the popover's only trigger, so pressing it again is the
    // shortest way to dismiss what it opened.
    fireEvent.click(screen.getByTestId('branch-selector-entry'))
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())
    expect(screen.getByTestId('branch-selector-entry').getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the selector on a press outside the panel', async () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    await openSelector()

    // A press anywhere outside the panel and its entry belongs to the rest of
    // the app: the selector goes away and the row actions never fire.
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())
    expect(screen.getByTestId('branch-selector-entry').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the selector open across a delete confirmation and dismissable right after it', async () => {
    setTree([b1()], [b1()], 'b-1')
    deleteBranchSubtreeMock.mockResolvedValue({ deletedBranchIds: ['b-1'], fallbackBranchId: null })
    renderTopicContent()
    await openSelector()
    const deleteButton = (): HTMLElement => screen.getByTestId('branch-delete-btn-b-1')

    fireEvent.click(deleteButton())
    await waitFor(() => expect(deleteButton().className).toMatch(/ant-popover-open/))

    // The confirmation lives in its own popup layer, so a press outside it
    // reaches the selector as an outside press too. That press dismisses the
    // confirmation and never the tree it belongs to.
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(deleteButton().className).not.toMatch(/ant-popover-open/))
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()

    // With the confirmation gone the selector is an ordinary controlled popup
    // again: the next outside press closes it.
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())
  })

  it('stays dismissable after a selector closed while a delete confirmation was open', async () => {
    setTree([b1()], [b1()], 'b-1')
    deleteBranchSubtreeMock.mockResolvedValue({ deletedBranchIds: ['b-1'], fallbackBranchId: null })
    renderTopicContent()
    await openSelector()

    fireEvent.click(screen.getByTestId('branch-delete-btn-b-1'))
    await waitFor(() => expect(screen.getByTestId('branch-delete-btn-b-1').className).toMatch(/ant-popover-open/))
    // Escape closes the selector, taking the open confirmation with it.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())

    // The next open is an ordinary open: the protection the closed
    // confirmation asked for must not outlive it.
    await openSelector()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())

    // The entry is just as ordinary: opening and pressing it again closes.
    await openSelector()
    fireEvent.click(screen.getByTestId('branch-selector-entry'))
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())
  })

  it('edits a row in place instead of opening a rename dialog', async () => {
    setTree([b1(), b2()], [], null)
    renameBranchMock.mockResolvedValue({ branch: b1() })
    renderTopicContent()
    await openSelector()

    fireEvent.click(screen.getByTestId('branch-rename-btn-b-1'))

    // The editor is part of the row: the tree stays mounted and usable, and no
    // modal layer is involved.
    const input = await screen.findByTestId('branch-selector-rename-input')
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
    expect(input).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('confirms the delete through a popconfirm that survives cancel, without closing the selector', async () => {
    setTree([b1()], [b1()], 'b-1')
    deleteBranchSubtreeMock.mockResolvedValue({ deletedBranchIds: ['b-1'], fallbackBranchId: null })
    renderTopicContent()
    await openSelector()

    fireEvent.click(screen.getByTestId('branch-delete-btn-b-1'))
    await waitFor(() => expect(screen.getByTestId('branch-delete-btn-b-1').className).toMatch(/ant-popover-open/))
    fireEvent.click(await popconfirmButton(false))
    await waitFor(() => expect(screen.getByTestId('branch-delete-btn-b-1').className).not.toMatch(/ant-popover-open/))

    // Cancelling the confirmation cancels the confirmation only.
    expect(deleteBranchSubtreeMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()

    // The same row control confirms from a still-open selector.
    fireEvent.click(screen.getByTestId('branch-delete-btn-b-1'))
    fireEvent.click(await popconfirmButton(true))
    await waitFor(() => expect(deleteBranchSubtreeMock).toHaveBeenCalledWith('t-1', 'b-1', 'b-1'))
  })

  it('commits no geometry from an unlaid-out panel and draws it in the pass that lays the rows out', async () => {
    setTree([b1(), b3()], [b1(), b3()], 'b-3')
    renderTopicContent()
    await openSelector()

    // jsdom reports zero-size rects for everything: the popover is mounted but
    // not laid out. That pass must not become the committed geometry (it used
    // to place every connector at x=0/y=0 with no rounded turns).
    expect(edgesOf()).not.toBeNull()
    expect(edgesOf()?.querySelectorAll('path')).toHaveLength(0)

    const restoreLayout = stubLayout({})
    try {
      // The window resize the component itself observes is the real "measure
      // again now that rows have a box" trigger. The commit happens in the same
      // pass, so there is nothing to wait for.
      await act(async () => {
        window.dispatchEvent(new Event('resize'))
      })

      const edges = edgesOf()
      expect(edges).not.toBeNull()
      const active = edges?.querySelector('path.edge-active')
      const d = active?.getAttribute('d') ?? ''
      // The chain is main(0) → b-1(1) → b-3(2). The line runs down each chevron
      // column's centre (x = 8, 28 and 48) with a 4px corner: no turning point
      // and no leg is shifted off a column, only the arrow glyphs themselves
      // are cut out of the drawn line.
      expect(d).toBe('M 8 21 L 8 41 Q 8 45 12 45 L 24 45 Q 28 45 28 49 L 28 71 Q 28 75 32 75 L 48 75')
      expect(d).not.toMatch(/-\d/)
      // main and b-1 draw an arrow (b-3 is a leaf): two glyph holes, each 13px
      // wide and centred on its own column.
      const cuts = Array.from(edges?.querySelectorAll('mask rect[fill="#000"]') ?? [])
      expect(cuts.map((cut) => cut.getAttribute('x'))).toEqual(['1.5', '21.5'])
      expect((edges?.querySelectorAll('path:not(.edge-active)') ?? []).length).toBeGreaterThan(0)
    } finally {
      restoreLayout()
    }
  })

  it('re-measures the connectors in the same pass that expands a fork', async () => {
    setTree([b1(), b3()], [b1()], 'b-1')
    const restoreLayout = stubLayout({})
    try {
      renderTopicContent()
      await openSelector()
      const before = edgesOf()?.querySelectorAll('path').length ?? 0
      const activeBefore = edgesOf()?.querySelector('path.edge-active')?.getAttribute('d') ?? ''

      fireEvent.click(switcherOf('b-1'))
      await screen.findByTestId('branch-cascader-item-b-3')

      // The new child row and the connector into it arrive together, and the
      // current route's line is unchanged by the expansion.
      expect(edgesOf()?.querySelectorAll('path').length ?? 0).toBeGreaterThan(before)
      expect(edgesOf()?.querySelector('path.edge-active')?.getAttribute('d') ?? '').toBe(activeBefore)
      expect(activeBefore).toBe('M 8 21 L 8 41 Q 8 45 12 45 L 28 45')
    } finally {
      restoreLayout()
    }
  })

  it('keeps one 16px visual chevron column and a separate 28px click target', async () => {
    setTree([b1(), b3()], [b1()], 'b-1')
    renderTopicContent()
    await openSelector()

    const css = styleText()
    // The visual column is what the connector geometry is measured from.
    expect(css).toMatch(/\.ant-tree-switcher[^{}]*\{[^{}]*width:\s*16px/)
    // The click target is a transparent 28px box ending where the name column
    // starts: slot 16 + 6 gap = 22, so it reaches 6px left of the slot.
    expect(css).toMatch(/:not\(\.ant-tree-switcher-noop\)::after[^{}]*\{[^{}]*width:\s*28px/)
    expect(css).toMatch(/:not\(\.ant-tree-switcher-noop\)::after[^{}]*\{[^{}]*right:\s*-6px/)
    // Avoiding the line never shrinks the target.
    expect(css.match(/width:\s*28px/g)?.length ?? 0).toBeGreaterThan(0)
    // Hover stays a small wash around the glyph, never a slab.
    expect(css).toMatch(/\.ant-tree-switcher::before[^{}]*\{[^{}]*width:\s*14px/)
    expect(css).toMatch(/\.ant-tree-switcher::before[^{}]*\{[^{}]*height:\s*14px/)
    // The indent step is untouched by the wider target.
    expect(css).toMatch(/\.ant-tree-indent-unit[^{}]*\{[^{}]*width:\s*20px/)
  })

  it('keeps the arrow neutral with no resting plate, a hover wash and a clear focus ring', async () => {
    setTree([b1(), b3()], [b1()], 'b-1')
    renderTopicContent()
    await openSelector()

    const css = styleText()
    // The arrow is neutral and has no permanent block behind it.
    expect(css).toMatch(/\.ant-tree-switcher[^{}]*\{[^{}]*color:\s*var\(--color-text-3\)/)
    expect(css).toMatch(/\.ant-tree-switcher[^{}]*\{[^{}]*background:\s*transparent/)
    // Its own hover plate (a full 30px square) is replaced by a 14px wash…
    expect(css).toMatch(/:hover::before[^{}]*\{[^{}]*background:\s*var\(--color-hover\)/)
    // …and keyboard focus stays unmistakable.
    expect(css).toMatch(/:focus-visible::before[^{}]*\{[^{}]*box-shadow:\s*0 0 0 1\.5px var\(--color-primary\)/)
    // The wash is the lower layer and the glyph the upper one: an absolutely
    // positioned wash would otherwise paint over the in-flow arrow and the
    // arrow would vanish exactly while it is hovered. The glyph keeps its own
    // 10px box and its chevron column, so this is layering, not geometry.
    const washRule = css.match(/\.ant-tree-switcher::before\s*\{[^}]*\}/)?.[0] ?? ''
    expect(washRule).toMatch(/z-index:\s*0/)
    const glyphRule = css.match(/\.branch-tree \.branch-twig\s*\{[^}]*\}/)?.[0] ?? ''
    expect(glyphRule).toMatch(/position:\s*relative/)
    expect(glyphRule).toMatch(/z-index:\s*1/)
    const glyph = document.querySelector('.branch-twig')
    expect(glyph?.getAttribute('width')).toBe('10')
    expect(glyph?.getAttribute('height')).toBe('10')
    // An expanded row keeps BOTH class tokens. A concatenated
    // 'branch-twigis-open' would stop matching the layering rule above, so the
    // absolutely positioned hover wash would paint over the arrow exactly while
    // it is hovered and the glyph would disappear from the rendered panel.
    const expandedGlyph = document.querySelector('.ant-tree-switcher_open .branch-twig')
    expect(expandedGlyph).not.toBeNull()
    expect(expandedGlyph?.classList.contains('is-open')).toBe(true)
    expect(expandedGlyph?.getAttribute('width')).toBe('10')
    // Green only marks the current route's line.
    expect(css).toMatch(/\.edge-active[^{}]*\{[^{}]*stroke:\s*var\(--color-primary\)/)
  })

  it('sizes the panel from its content inside the open-session budget', async () => {
    setTree([b1(), b3()], [b1()], 'b-1')
    renderTopicContent()
    await openSelector()

    const css = styleText()
    // The panel follows its content and is only bounded — never a fixed column
    // of empty space.
    expect(css).toMatch(/width:\s*max-content/)
    expect(css).not.toMatch(/width:\s*420px/)
    // The bound is the fit planned for this open, not a hard-coded stylesheet
    // width: an unmeasured trigger simply leaves the full prototype ceiling.
    const panel = screen.getByTestId('branch-selector-popover')
    expect(panel.style.maxWidth).toBe('420px')
    // The panel opens at the readable minimum, not at a bare technical bound.
    expect(panel.style.minWidth).toBe('280px')
    // Row controls are 22px, hidden until the row is hovered or focused.
    expect(css).toMatch(/\.ant-tree-node-content-wrapper:hover \.\w+[^{}]*\{[^{}]*opacity:\s*1/)
    expect(css).toMatch(/\.ant-tree-node-content-wrapper:focus-within \.\w+[^{}]*\{[^{}]*opacity:\s*1/)
    expect(css).toMatch(/\.\w+\[aria-expanded='true'\]/)
    // The breadcrumb separator carries its own side spacing.
    expect(css).toMatch(/padding:\s*0 4px/)
  })

  it('places the panel through the popover align pass, off the entry, and never through CSS', async () => {
    setTree([b1(), b3()], [b1()], 'b-1')
    setViewportWidth(1280)
    const restore = stubLayout({ triggerLeft: 1100, triggerWidth: 30 })
    try {
      renderTopicContent()
      await openSelector()

      // 1280 - 16 (margin) - 420 (widest panel) - 2 (popup box) = 842: the panel
      // starts there, 258px left of the entry, so it can grow rightwards
      // without ever moving.
      const { align, placement } = lastPopoverProps() as {
        align: { targetOffset: [number, number]; overflow: Record<string, boolean> }
        placement: string
      }
      expect(placement).toBe('bottomLeft')
      expect(align.targetOffset).toEqual([258, 0])
      // The popover must not correct itself horizontally when the panel grows:
      // a flip or a shift here is exactly what moved the panel and the entry.
      expect(align.overflow).toEqual({ adjustX: false, adjustY: true, shiftX: false, shiftY: true })

      // The placement is an align input, not a CSS offset on the popup: an
      // rc-align pass measures the popup together with any margin it carries.
      expect(popupElement()?.style.marginLeft ?? '').toBe('')
      const panel = screen.getByTestId('branch-selector-popover')
      expect(panel.style.maxWidth).toBe('420px')
      // The reserved room plus the budget ends exactly inside the margin.
      expect(1100 - align.targetOffset[0] + 420 + 2).toBe(1280 - 16)
    } finally {
      restore()
    }
  })

  it('never plans more panel than a narrow window holds', async () => {
    setTree([b1(), b3()], [b1()], 'b-1')
    setViewportWidth(360)
    const restore = stubLayout({ triggerLeft: 200, triggerWidth: 30 })
    try {
      renderTopicContent()
      await openSelector()

      const { align } = lastPopoverProps() as { align: { targetOffset: [number, number] } }
      const panel = screen.getByTestId('branch-selector-popover')
      // A narrow window caps the budget — 360 - 16 - 16 - 2 = 326 — instead of
      // letting the panel be pushed around by its own content.
      expect(panel.style.maxWidth).toBe('326px')
      // Left edge plus budget lands exactly on the window margin.
      expect(200 - align.targetOffset[0]).toBe(16)
      expect(16 + 326 + 2).toBe(360 - 16)
    } finally {
      restore()
    }
  })

  it('re-plans the open panel through the align pass when the window shrinks', async () => {
    setTree([b1(), b3()], [b1()], 'b-1')
    setViewportWidth(1280)
    const restore = stubLayout({ triggerLeft: 1100, triggerWidth: 30 })
    try {
      renderTopicContent()
      await openSelector()
      const targetOffset = (): [number, number] =>
        (lastPopoverProps().align as { targetOffset: [number, number] }).targetOffset
      expect(targetOffset()).toEqual([258, 0])
      expect(popupElement()?.style.marginLeft ?? '').toBe('')

      // The same open session, a narrower window: 1000 - 16 - 420 - 2 = 562, so
      // the panel has to start 538px left of the entry instead of 258px.
      act(() => {
        setViewportWidth(1000)
        window.dispatchEvent(new Event('resize'))
      })
      expect(targetOffset()).toEqual([538, 0])
      // Width is re-constrained by the window too, never by the content.
      expect(screen.getByTestId('branch-selector-popover').style.maxWidth).toBe('420px')
    } finally {
      restore()
    }
  })

  it('opens the tree only from the branch button; breadcrumb segments and the bar never open it', async () => {
    setTree([b1(), b3()], [b1(), b3()], 'b-3')
    renderTopicContent()

    // An ancestor segment navigates and closes; it never opens the selector.
    fireEvent.click(screen.getByTestId('branch-crumb-b-1'))
    expect(routeDispatches()).toEqual([
      expect.objectContaining({
        type: 'topicBranch/activeBranchSet',
        payload: { topicId: 't-1', branchId: 'b-1' }
      })
    ])
    expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument()

    // The current segment is navigation too: it only closes (no dispatch here
    // because the route is already current) and still never opens the tree.
    fireEvent.click(screen.getByTestId('branch-crumb-b-3'))
    expect(routeDispatches()).toHaveLength(1)
    expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument()

    // The topic (main route) segment behaves the same way.
    fireEvent.click(screen.getByTestId('branch-crumb-main'))
    expect(routeDispatches()).toHaveLength(2)
    expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument()

    // Only the separate branch button opens it.
    await openSelector()
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
  })

  it('labels the header action "Collapse all" and folds the root when the current route is the root', async () => {
    setTree([b1(), b2(), b3()], [], null)
    renderTopicContent()
    await openSelector()

    expect(screen.getByTestId('branch-collapse-all').textContent).toBe('Collapse all')
    // Opening makes the current route reachable, so the root row is expanded.
    expect(rowOf('b-1')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('branch-collapse-all'))

    // The main route has no ancestor chain, so "collapse all" folds the root as
    // well instead of forcing it open.
    await waitFor(() => expect(screen.queryByTestId('branch-cascader-item-b-1')).not.toBeInTheDocument())
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
    expect(routeDispatches()).toHaveLength(0)

    // Reopening restores the current (main) route floor only.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('branch-selector-popover')).not.toBeInTheDocument())
    await openSelector()
    expect(rowOf('b-1')).toBeInTheDocument()
  })

  it('keeps the current ancestor chain and folds the current node children and other forks', async () => {
    setTree([b1(), b2(), b3(), b4(), b5()], [b1(), b3()], 'b-3')
    renderTopicContent()
    await openSelector()

    // Chain open, current node's own child and the other fork closed.
    expect(rowOf('b-3')).toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-item-b-4')).not.toBeInTheDocument()
    expect(screen.queryByTestId('branch-cascader-item-b-5')).not.toBeInTheDocument()

    fireEvent.click(switcherOf('b-3'))
    await screen.findByTestId('branch-cascader-item-b-4')
    fireEvent.click(switcherOf('b-2'))
    await screen.findByTestId('branch-cascader-item-b-5')

    fireEvent.click(screen.getByTestId('branch-collapse-all'))
    await waitFor(() => expect(screen.queryByTestId('branch-cascader-item-b-4')).not.toBeInTheDocument())

    expect(screen.queryByTestId('branch-cascader-item-b-5')).not.toBeInTheDocument()
    expect(rowOf('main')).toBeInTheDocument()
    expect(rowOf('b-1')).toBeInTheDocument()
    expect(rowOf('b-3')).toBeInTheDocument()
    // Collapsing never switches route and never closes the selector.
    expect(routeDispatches()).toHaveLength(0)
    expect(screen.getByTestId('branch-selector-popover')).toBeInTheDocument()
  })

  it('orders the row model selector, branch entry, then path, with the entry outside the right tool group', () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    expect(screen.queryByTestId('mock-emoji')).not.toBeInTheDocument()
    expect(screen.getByTestId('branch-selector-breadcrumb')).toHaveTextContent('Runtopic')

    const model = screen.getByTestId('mock-model-btn')
    const entry = screen.getByTestId('branch-selector-entry')
    const crumbSlot = screen.getByTestId('branch-crumb-slot')
    const tools = screen.getByTestId('navbar-tools-right')

    // The tool group is still the right-aligned end of the row, and the branch
    // entry is no longer one of its tools.
    expect(tools.className).toMatch(/ml-auto/)
    expect(within(tools).getByTestId('mock-tools')).toBeInTheDocument()
    expect(within(tools).queryByTestId('branch-selector-entry')).not.toBeInTheDocument()
    // The path plate is its own element: the tool group is not inside it.
    expect(within(tools).queryByTestId('branch-selector-breadcrumb')).not.toBeInTheDocument()

    // DOM order: model selector, the entry immediately before the path, then
    // the path, then the tool group.
    expect(precedes(model, entry)).toBe(true)
    expect(precedes(entry, crumbSlot)).toBe(true)
    expect(precedes(crumbSlot, tools)).toBe(true)
  })

  it('renders the branch entry as an icon-only button that reports its open state', async () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    const entry = screen.getByTestId('branch-selector-entry')
    // Icon only: the old bordered "Branches" text pill is gone.
    expect(entry.textContent).toBe('')
    expect(entry.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(entry)
    await screen.findByTestId('branch-selector-popover')
    expect(screen.getByTestId('branch-selector-entry').getAttribute('aria-expanded')).toBe('true')
  })

  it('marks the open entry with the shared active tool surface, not a custom accent', async () => {
    setTree([b1(), b2()], [], null)
    renderTopicContent()
    await openSelector()

    const css = styleText()
    // Same tokens/shape as the edit-mode toggle: accent surface + light glyph.
    expect(css).toMatch(/\[aria-expanded='true'\][^{}]*\{[^{}]*background:\s*var\(--color-primary\)/)
    expect(css).toMatch(/\[aria-expanded='true'\][^{}]*\{[^{}]*color:\s*var\(--color-icon-white\)/)
    expect(css).toMatch(/\[aria-expanded='true'\][^{}]*\{[^{}]*opacity:\s*0\.85/)
    // No ad-hoc accent: the muted chip belongs to the breadcrumb, not the tool.
    const entryRule = css.match(/\[aria-expanded='true'\][^{}]*\{[^}]*\}/)?.[0] ?? ''
    expect(entryRule).not.toContain('rgba(')
    expect(entryRule).not.toContain('--color-primary-mute')
  })

  it('draws the path in its own dark rounded plate while the current segment keeps the green chip', async () => {
    setTree([b1(), b3()], [b1(), b3()], 'b-3')
    renderTopicContent()

    const crumb = screen.getByTestId('branch-selector-breadcrumb')
    const plate = crumb.parentElement
    expect(plate).not.toBeNull()
    const css = styleText()
    // The accepted navigation base: one dark rounded plate with a thin border
    // around the whole path…
    expect(css).toMatch(/background:\s*var\(--color-background-soft\)/)
    expect(css).toMatch(/border:\s*1px solid var\(--color-border-soft\)/)
    expect(css).toMatch(/border-radius:\s*8px/)
    // …that hugs its content instead of stretching across the row.
    expect(css).toMatch(/width:\s*max-content/)
    // The current segment stays the translucent green chip.
    expect(css).toMatch(/\[data-current='true'\][^{}]*\{[^{}]*background:\s*var\(--color-primary-mute\)/)
    expect(css).toMatch(/\[data-current='true'\][^{}]*\{[^{}]*color:\s*var\(--color-primary\)/)
    // The plate wraps the path only: the tool group is outside it.
    expect(plate?.contains(screen.getByTestId('navbar-tools-right'))).toBe(false)
  })
})
