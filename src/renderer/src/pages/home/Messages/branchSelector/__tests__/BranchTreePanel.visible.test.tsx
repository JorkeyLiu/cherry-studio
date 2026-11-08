import type { TopicBranchWire } from '@renderer/services/db/types'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BRANCH_POPOVER_MIN_WIDTH, buildBranchTreeIndex } from '../branchTreeModel'
import { BranchTreePanel } from '../BranchTreePanel'

/**
 * The panel is measured inside its own layout pass, so a pass with no boxes
 * commits nothing and a pass with real boxes commits the connectors before the
 * browser paints. This file drives exactly those two situations: zero-size
 * boxes first, then the boxes a laid-out tree produces — and it never waits on
 * a timer, because the commit is not a timer's business.
 *
 * It also pins the open-session width rule (grow only, rightwards, inside the
 * budget) and the minimal current-row scroll.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      const map: Record<string, string> = {
        'chat.topics.branch.tag': 'Branches',
        'chat.topics.branch.current': 'Current',
        'chat.topics.branch.collapse_all': 'Collapse all',
        'chat.topics.branch.children_here': `Branches here: ${options?.count ?? 0}`,
        'common.rename': 'Rename',
        'common.delete': 'Delete',
        'common.more': 'More'
      }
      return map[key] ?? key
    }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const ROW_HEIGHT = 30
const SLOT_WIDTH = 16
const SLOT_END_GAP = 6
const INDENT_SIZE = 20
const ROW_COUNT = 11
const VIEWPORT_HEIGHT = 120
const SCROLL_PADDING = 10
const MAX_WIDTH = 420

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

/** Root plus ten children; the active route is the last child. */
const catalog = (): TopicBranchWire[] =>
  Array.from({ length: 10 }, (_, index) =>
    wire(`b-${index}`, null, `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`)
  )

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

/**
 * Installs the boxes a laid-out tree produces (rows, chevron column, name
 * column) plus the panel's own box, whose width the test drives.
 */
function stubLayout(state: { panelWidth: number }): () => void {
  const rowIndexOf = (row: Element): number => Array.from(row.parentElement?.children ?? []).indexOf(row)
  const rowRect = (row: Element): DOMRect => fakeRect(0, rowIndexOf(row) * ROW_HEIGHT, 400, ROW_HEIGHT)
  const depthOf = (row: Element): number => row.querySelectorAll('.ant-tree-indent-unit').length
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('data-testid') === 'branch-selector-popover') {
      return fakeRect(0, 0, state.panelWidth, 300)
    }
    if (this.classList.contains('ant-tree-treenode')) return rowRect(this)
    const row = this.closest('.ant-tree-treenode')
    if (row && this.classList.contains('ant-tree-switcher')) {
      return fakeRect(depthOf(row) * INDENT_SIZE, rowRect(row).top, SLOT_WIDTH, ROW_HEIGHT)
    }
    if (row && this.classList.contains('ant-tree-node-content-wrapper')) {
      return fakeRect(depthOf(row) * INDENT_SIZE + SLOT_WIDTH + SLOT_END_GAP, rowRect(row).top, 200, 28)
    }
    if (row && this.getAttribute('data-branch-id')) return rowRect(row)
    const children = Array.from(this.children)
    const isContent =
      children.some((child) => child.tagName.toLowerCase() === 'svg') &&
      children.some((child) => child.classList.contains('branch-tree'))
    if (isContent) return fakeRect(0, 0, 400, ROW_COUNT * ROW_HEIGHT)
    return fakeRect(0, 0, 0, 0)
  })
  return () => spy.mockRestore()
}

const edgesOf = (): SVGSVGElement | null =>
  screen.queryByTestId('branch-selector-popover')?.querySelector('svg') ?? null

const panelOf = (): HTMLElement => screen.getByTestId('branch-selector-popover')

/** Root → fork b-0 → leaf b-1: exactly one row draws an expansion arrow. */
const forkCatalog = (): TopicBranchWire[] => [
  wire('b-0', null, '2026-01-01T00:00:00.000Z'),
  wire('b-1', 'b-0', '2026-01-02T00:00:00.000Z')
]

const dotOf = (): Element | null => edgesOf()?.querySelector('circle.edge-dot') ?? null

/**
 * Renders the panel for one catalog + current branch. The default catalog is a
 * root with ten leaf children and the last leaf as the current row.
 */
const renderPanel = (
  visible: boolean,
  maxWidth = MAX_WIDTH,
  selection: { catalog?: TopicBranchWire[]; activeBranchId?: string | null } = {}
) => {
  const index = buildBranchTreeIndex(selection.catalog ?? catalog())
  const props = {
    index,
    topicName: 'Root',
    activeBranchId: selection.activeBranchId === undefined ? 'b-9' : selection.activeBranchId,
    deletingBranchId: null,
    onSelectRoute: vi.fn(),
    onCommitRename: vi.fn(),
    onConfirmDelete: vi.fn(),
    onDeleteConfirmChange: vi.fn()
  }

  const view = render(<BranchTreePanel {...props} visible={visible} maxWidth={maxWidth} />)
  return {
    ...view,
    rerenderPanel: (next: { visible: boolean; maxWidth?: number }) =>
      view.rerender(<BranchTreePanel {...props} visible={next.visible} maxWidth={next.maxWidth ?? maxWidth} />)
  }
}

describe('BranchTreePanel measured-once-laid-out behaviour', () => {
  it('commits no geometry from an unmeasured pass, whatever re-triggers it', async () => {
    renderPanel(false)

    // Zero-size boxes: the mount pass has nothing to measure and must not draw
    // connectors at x=0/y=0.
    expect(edgesOf()).not.toBeNull()
    expect(edgesOf()?.querySelectorAll('path')).toHaveLength(0)

    // The panel's own re-measure triggers run in the same condition.
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(edgesOf()?.querySelectorAll('path')).toHaveLength(0)
    // No glyph hole is invented from an unlaid-out pass either.
    expect(edgesOf()?.querySelectorAll('mask rect[fill="#000"]')).toHaveLength(0)
  })

  it('commits the connectors of the visible rows in the pass that lays them out', async () => {
    const { rerenderPanel } = renderPanel(false)
    const state = { panelWidth: 300 }
    const restore = stubLayout(state)
    try {
      // No frame, no timer: the render that lays the rows out is also the one
      // that produces their connectors.
      await act(async () => {
        rerenderPanel({ visible: true })
      })

      const edges = edgesOf()
      expect(edges).not.toBeNull()
      // Reference values for this layout: the current row is the tenth child,
      // so the route line starts 6px under the root arrow, runs down that
      // column's centre (x = 8) and ends on the child column's centre (x = 28).
      expect(edges?.querySelector('path.edge-active')?.getAttribute('d')).toBe('M 8 21 L 8 311 Q 8 315 12 315 L 28 315')
      // Only the root draws an arrow here (its ten children are leaves), so
      // exactly one glyph hole exists: the 10px glyph plus 1.5px on each side,
      // centred on the root's chevron column.
      const cuts = Array.from(edges?.querySelectorAll('mask rect[fill="#000"]') ?? [])
      expect(cuts).toHaveLength(1)
      expect(cuts[0]?.getAttribute('x')).toBe('1.5')
      expect(cuts[0]?.getAttribute('y')).toBe('8.5')
      expect(cuts[0]?.getAttribute('width')).toBe('13')
      // The hole is subtracted from the connector layer itself, so the lines
      // are the only thing it touches.
      expect(edges?.querySelector('g')?.getAttribute('mask')).toMatch(/^url\(#branch-glyph-clear-[\w-]+\)$/)
      // One trunk plus one stub per non-last child: 10 lines under the tree.
      expect(edges?.querySelectorAll('path:not(.edge-active)')).toHaveLength(10)
    } finally {
      restore()
    }
  })

  it('keeps the endpoint dot on a leaf current row', async () => {
    // Root → fork b-0 → leaf b-1: b-1 is on the route, so its ancestors are
    // expanded and the route really ends on a leaf row.
    const restore = stubLayout({ panelWidth: 300 })
    try {
      const { rerenderPanel } = renderPanel(false, MAX_WIDTH, { catalog: forkCatalog(), activeBranchId: 'b-1' })
      await act(async () => {
        rerenderPanel({ visible: true })
      })
      // A leaf leaves its arrow column empty, so the endpoint keeps its dot:
      // depth 2 puts it at x = 16 + 2 * 20 - 8, on the third row's centre.
      expect(dotOf()?.getAttribute('cx')).toBe('48')
      expect(dotOf()?.getAttribute('cy')).toBe('75')
    } finally {
      restore()
    }
  })

  it('hides the endpoint dot on a current row that draws an expansion arrow', async () => {
    const restore = stubLayout({ panelWidth: 300 })
    try {
      // b-0 is current and carries a chevron (its child is folded), so the dot
      // must not land on the arrow; the route line still ends on its column.
      const { rerenderPanel } = renderPanel(false, MAX_WIDTH, { catalog: forkCatalog(), activeBranchId: 'b-0' })
      await act(async () => {
        rerenderPanel({ visible: true })
      })
      expect(edgesOf()?.querySelector('path.edge-active')?.getAttribute('d')).toBe('M 8 21 L 8 41 Q 8 45 12 45 L 28 45')
      expect(dotOf()).toBeNull()
    } finally {
      restore()
    }
  })

  it('hides the endpoint dot when the root itself is the current row', async () => {
    const restore = stubLayout({ panelWidth: 300 })
    try {
      const { rerenderPanel } = renderPanel(false, MAX_WIDTH, { activeBranchId: null })
      await act(async () => {
        rerenderPanel({ visible: true })
      })
      // The root always draws an arrow, so the single-row route has no dot.
      expect(dotOf()).toBeNull()
    } finally {
      restore()
    }
  })
  it('starts at a readable minimum, grows with the open, and never pulls back in', async () => {
    const state = { panelWidth: 300 }
    const restore = stubLayout(state)
    try {
      const { rerenderPanel } = renderPanel(true)
      expect(panelOf().style.minWidth).toBe('300px')
      expect(panelOf().style.maxWidth).toBe(`${MAX_WIDTH}px`)

      // A wider open (a longer name, another expanded fork): grows.
      state.panelWidth = 360
      await act(async () => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(panelOf().style.minWidth).toBe('360px')

      // Collapsing back or renaming to something shorter: the panel stays where
      // the user saw it — width only ever moves forward during one open.
      state.panelWidth = 240
      await act(async () => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(panelOf().style.minWidth).toBe('360px')
      expect(panelOf().style.maxWidth).toBe(`${MAX_WIDTH}px`)

      // A window resize may re-constrain the open session.
      await act(async () => {
        rerenderPanel({ visible: true, maxWidth: 260 })
      })
      expect(panelOf().style.maxWidth).toBe('260px')
      expect(panelOf().style.minWidth).toBe('260px')
    } finally {
      restore()
    }
  })

  it('never falls below the panel minimum width, even before anything was measured', () => {
    renderPanel(true)
    // Nothing is laid out: no measured width may be invented, but the readable
    // floor still applies.
    expect(panelOf().style.minWidth).toBe(`${BRANCH_POPOVER_MIN_WIDTH}px`)
    expect(panelOf().style.maxWidth).toBe(`${MAX_WIDTH}px`)
  })

  it('scrolls the current row into view minimally once it is really visible', async () => {
    const { rerenderPanel } = renderPanel(false)

    const scroller = screen.getByTestId('branch-tree-scroll')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: VIEWPORT_HEIGHT })
    // Nothing is laid out yet, so nothing scrolled.
    expect(scroller.scrollTop).toBe(0)

    const restore = stubLayout({ panelWidth: 300 })
    try {
      await act(async () => {
        rerenderPanel({ visible: true })
      })

      // Current row is the eleventh row: top 300, bottom 330. Minimal reveal:
      // bottom + padding - viewport = 330 + 10 - 120.
      expect(scroller.scrollTop).toBe(330 + SCROLL_PADDING - VIEWPORT_HEIGHT)
    } finally {
      restore()
    }
  })

  it('keeps the header action wording on the settled panel', () => {
    renderPanel(true)
    expect(screen.getByTestId('branch-collapse-all').textContent).toBe('Collapse all')
    expect(screen.getByTestId('branch-cascader-item-main')).toBeInTheDocument()
  })
})
