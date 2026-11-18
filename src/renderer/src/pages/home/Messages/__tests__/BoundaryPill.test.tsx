import * as fs from 'node:fs'

import type { TopicBranchWire } from '@renderer/services/db/types'
import type { HistoryReferenceMeta } from '@shared/chatDb'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number; name?: string }) => {
      if (key === 'chat.topics.branch.children_here') return `此处有 ${opts?.count ?? 0} 条分支`
      if (opts?.name) return `${key}:${opts.name}`
      return key
    }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }))

vi.mock('@renderer/store', () => ({ useAppDispatch: () => dispatchMock }))
vi.mock('@renderer/services/db/DbService', () => ({ dbService: { renameBranch: vi.fn() } }))
vi.mock('@renderer/services/db/branchSubtree', () => ({ deleteBranchSubtree: vi.fn() }))
vi.mock('@renderer/pages/home/Messages/useBranchTree', () => ({ requestTopicBranches: vi.fn() }))

const { ForkDivider } = await import('../BranchDividers')
const { ReferenceDivider } = await import('../ReferenceDivider')

const wire = (id: string, anchorMessageId: string, name: string): TopicBranchWire =>
  ({
    id,
    topicId: 't-1',
    parentBranchId: null,
    anchorMessageId,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }) as TopicBranchWire

const forkDivider = (onSelectRoute = vi.fn()) => (
  <ForkDivider
    topicId="t-1"
    anchorMessageId="m1"
    taken={undefined}
    children={[wire('b-1', 'm1', 'B1'), wire('b-2', 'm1', 'B2')]}
    parentBranchId={null}
    parentLabel="Topic"
    activeBranchId={null}
    onSelectRoute={onSelectRoute}
  />
)

const reference = (over: Partial<HistoryReferenceMeta> = {}): HistoryReferenceMeta => ({
  sourceTopicId: 'src-1',
  sourceBranchId: null,
  anchorMessageId: 'anchor-1',
  sourceName: 'Source',
  status: 'available',
  boundaryMessageId: 'b-1',
  ...over
})

const referenceDivider = (over: Partial<HistoryReferenceMeta> = {}, onNavigateSource = vi.fn()) => (
  <ReferenceDivider
    reference={reference(over)}
    targetTopicId="dst-1"
    sourceName={over.status === 'missing' ? null : 'Live Source'}
    onNavigateSource={onNavigateSource}
  />
)

/** Direct children that are actually painted: the decorative parts are gone. */
const visibleChildren = (row: HTMLElement): HTMLElement[] =>
  Array.from(row.children).filter(
    (el) => !el.hasAttribute('aria-hidden') && (el as HTMLElement).style.display !== 'none'
  ) as HTMLElement[]

const surfaceOf = (row: HTMLElement): HTMLElement => {
  const pill = row.querySelector('[data-boundary-pill="surface"]')
  expect(pill).not.toBeNull()
  return pill as HTMLElement
}

describe('weak boundary presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).toast = { success: vi.fn(), error: vi.fn() }
  })

  it('fork and history-reference dividers share one pill surface and one rule-free centered row', () => {
    const fork = render(forkDivider())
    const ref = render(referenceDivider())

    // The row itself carries the stable anchor identity; the bare-anchor testid
    // on the row is a hidden alias, so select the explicit anchor+parent id.
    const forkRow = screen.getByTestId('branch-fork-divider-m1-main')
    const refRow = screen.getByTestId('history-reference-divider')
    // One shared surface component: identical class and identical rendered
    // metrics in both families, so a boundary never looks like two designs.
    expect(surfaceOf(forkRow).className).toBe(surfaceOf(refRow).className)
    for (const prop of ['borderRadius', 'fontSize', 'lineHeight', 'backgroundColor', 'color'] as const) {
      expect(getComputedStyle(surfaceOf(forkRow))[prop]).toBe(getComputedStyle(surfaceOf(refRow))[prop])
    }
    // Compact centered pill: fixed radius, 12px label; centered rule-free row
    // with the unchanged min-height in both families.
    expect(getComputedStyle(surfaceOf(forkRow)).borderRadius).toBe('999px')
    expect(getComputedStyle(surfaceOf(forkRow)).fontSize).toBe('12px')
    for (const prop of ['justifyContent', 'minHeight', 'paddingTop', 'marginTop'] as const) {
      expect(getComputedStyle(forkRow)[prop]).toBe(getComputedStyle(refRow)[prop])
    }
    expect(getComputedStyle(forkRow).justifyContent).toBe('center')
    expect(getComputedStyle(forkRow).minHeight).toBe('36px')
    // No left/right through-rules survive: each row paints exactly one child.
    expect(visibleChildren(forkRow)).toHaveLength(1)
    expect(visibleChildren(refRow)).toHaveLength(1)

    fork.unmount()
    ref.unmount()
  })

  it('keeps the flow-row identity anchors of both divider families', () => {
    render(
      <>
        {forkDivider()}
        {referenceDivider()}
      </>
    )
    const forkRow = screen.getByTestId('branch-fork-divider-m1-main')
    expect(forkRow).toHaveAttribute('data-divider-key', 'm1::main')
    expect(forkRow).toHaveAttribute('data-divider-anchor', 'm1')
    expect(forkRow).toHaveAttribute('data-divider-parent', 'main')
    const refRow = screen.getByTestId('history-reference-divider')
    expect(refRow).toHaveAttribute('data-reference-status', 'available')
    expect(refRow).toHaveAttribute('data-reference-source-topic', 'src-1')
    expect(refRow).toHaveAttribute('data-reference-target-topic', 'dst-1')
  })

  it('interactive boundaries are keyboard-hit targets: focus lands on the button, activation runs its own action', () => {
    const onNavigateSource = vi.fn()
    render(referenceDivider({}, onNavigateSource))
    const link = screen.getByTestId('history-reference-divider-link')
    expect(link.tagName).toBe('BUTTON')
    expect(link).toHaveAttribute('type', 'button')
    link.focus()
    expect(document.activeElement).toBe(link)
    fireEvent.click(link)
    expect(onNavigateSource).toHaveBeenCalledTimes(1)
  })

  it('the fork boundary keeps its click-to-expand hit target inside the pill', async () => {
    render(forkDivider())
    const toggle = screen.getByTestId('branch-fork-toggle-m1')
    expect(toggle.tagName).toBe('BUTTON')
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    expect(toggle.querySelector('[data-boundary-pill="surface"]')).not.toBeNull()
    fireEvent.click(toggle)
    expect(await screen.findByTestId('branch-fork-list-m1')).toBeInTheDocument()
  })

  it('missing reference keeps the identical pill but has no click semantics', () => {
    const onNavigateSource = vi.fn()
    render(referenceDivider({ status: 'missing', sourceName: null, boundaryMessageId: null }, onNavigateSource))
    const missingPill = screen.getByTestId('history-reference-divider-missing')
    expect(missingPill.tagName).toBe('SPAN')
    expect(missingPill.closest('button')).toBeNull()
    expect(missingPill).not.toHaveAttribute('role')
    // Same surface as the interactive form: presentation carries no state.
    const available = render(referenceDivider())
    expect(missingPill.className).toBe(
      (available.container.querySelector('[data-boundary-pill="surface"]') as HTMLElement).className
    )
    fireEvent.click(missingPill)
    expect(onNavigateSource).not.toHaveBeenCalled()
    available.unmount()
  })

  it('each reference layer renders its own independent pill and navigates its own endpoint', () => {
    const navigateOuter = vi.fn()
    const navigateInner = vi.fn()
    render(
      <>
        <ReferenceDivider
          reference={reference({ sourceTopicId: 'src-a', sourceName: 'A' })}
          targetTopicId="dst-a"
          sourceName="A"
          onNavigateSource={navigateOuter}
        />
        <ReferenceDivider
          reference={reference({ sourceTopicId: 'src-b', sourceName: 'B' })}
          targetTopicId="dst-b"
          sourceName="B"
          onNavigateSource={navigateInner}
        />
      </>
    )
    const rows = screen.getAllByTestId('history-reference-divider')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-reference-target-topic', 'dst-a')
    expect(rows[1]).toHaveAttribute('data-reference-target-topic', 'dst-b')
    const pills = rows.map(surfaceOf)
    expect(pills[0].className).toBe(pills[1].className)
    expect(pills[0].textContent).not.toBe(pills[1].textContent)
    const links = screen.getAllByTestId('history-reference-divider-link')
    fireEvent.click(links[1])
    expect(navigateInner).toHaveBeenCalledTimes(1)
    expect(navigateOuter).not.toHaveBeenCalled()
  })
})

describe('long-label width constraint', () => {
  // 51+ characters, the shape of a live source topic title: wide enough that
  // the pill's natural width exceeds a narrow message column.
  const LONG_SOURCE = 'Cross-topic source topic title that is much wider than the row'
  const refLabelText = `chat.message.reference_divider.label:${LONG_SOURCE}`

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).toast = { success: vi.fn(), error: vi.fn() }
  })

  it('a long reference label is bounded by the row, never by a fixed pixel width', () => {
    render(
      <ReferenceDivider
        reference={reference()}
        targetTopicId="dst-1"
        sourceName={LONG_SOURCE}
        onNavigateSource={vi.fn()}
      />
    )
    const row = screen.getByTestId('history-reference-divider')
    const button = screen.getByTestId('history-reference-divider-link')
    const pill = surfaceOf(row)
    const label = row.querySelector('[data-boundary-label]') as HTMLElement

    // Width is bounded by the row (100%), and the shell may shrink inside it
    // (min-width 0) instead of overflowing the column.
    expect(getComputedStyle(button).maxWidth).toBe('100%')
    expect(getComputedStyle(button).minWidth).toBe('0')
    expect(getComputedStyle(pill).maxWidth).toBe('100%')
    expect(getComputedStyle(pill).minWidth).toBe('0')
    // Only the label gives way, and it ellipsizes rather than clipping.
    expect(getComputedStyle(pill).overflow).toBe('hidden')
    expect(getComputedStyle(pill).textOverflow).toBe('ellipsis')
    expect(getComputedStyle(pill).whiteSpace).toBe('nowrap')
    expect(getComputedStyle(label).maxWidth).not.toMatch(/px$/)
    expect(getComputedStyle(label).minWidth).toBe('0')
    expect(getComputedStyle(label).overflow).toBe('hidden')
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis')
    // Truncation is visual only: the full name stays in the DOM (accessible
    // name) and on the button title.
    expect(label.textContent).toBe(refLabelText)
    expect(button).toHaveAttribute('title', refLabelText)
  })

  it('the fork pill takes the same bound from the shared surface and keeps its chevron box', () => {
    const view = render(forkDivider())
    const row = screen.getByTestId('branch-fork-divider-m1-main')
    const button = screen.getByTestId('branch-fork-toggle-m1')
    const pill = surfaceOf(row)
    const chevron = view.container.querySelector('[data-boundary-pill="surface"] > svg') as SVGElement

    expect(getComputedStyle(button).maxWidth).toBe('100%')
    expect(getComputedStyle(button).minWidth).toBe('0')
    expect(getComputedStyle(pill).maxWidth).toBe('100%')
    expect(getComputedStyle(pill).minWidth).toBe('0')
    expect(getComputedStyle(pill).overflow).toBe('hidden')
    expect(getComputedStyle(pill).textOverflow).toBe('ellipsis')
    // `flex: none` keeps the icon at its own size instead of letting it be the
    // part that overflows or disappears.
    expect(chevron).not.toBeNull()
    expect(getComputedStyle(chevron).flex).toBe('0 0 auto')
  })

  it('a long missing-reference label keeps the identical bounded surface', () => {
    const available = render(referenceDivider())
    const availableLabel = available.container.querySelector('[data-boundary-label]') as HTMLElement

    render(
      <ReferenceDivider
        reference={reference({ status: 'missing', sourceName: null, boundaryMessageId: null })}
        targetTopicId="dst-1"
        sourceName={null}
        onNavigateSource={vi.fn()}
      />
    )
    const missingPill = screen.getByTestId('history-reference-divider-missing')
    const missingLabel = missingPill.querySelector('[data-boundary-label]') as HTMLElement
    expect(getComputedStyle(missingPill).maxWidth).toBe('100%')
    expect(getComputedStyle(missingPill).minWidth).toBe('0')
    expect(getComputedStyle(missingPill).textOverflow).toBe('ellipsis')
    // Same label element/class: the missing form is the same presentation.
    expect(missingLabel.className).toBe(availableLabel.className)
  })

  it('declares the bound in relative units only — no hard pixel width anywhere in the surface', () => {
    const surface = fs.readFileSync('src/renderer/src/pages/home/Messages/BoundaryPill.tsx', 'utf8')
    expect(surface).toMatch(/max-width:\s*100%/)
    expect(surface).toMatch(/min-width:\s*0/)
    expect(surface).toMatch(/text-overflow:\s*ellipsis/)
    // `width`/`max-width`/`min-width` must never be pinned to pixels.
    expect(surface).not.toMatch(/\b(?:min-|max-)?width:\s*\d+(?:\.\d+)?px/)
  })
})
