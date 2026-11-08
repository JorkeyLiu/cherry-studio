import type { TopicBranchWire } from '@renderer/services/db/types'
import { describe, expect, it } from 'vitest'

import {
  baseExpandedKeys,
  BRANCH_POPOVER_FRAME_WIDTH,
  BRANCH_POPOVER_MAX_WIDTH,
  BRANCH_POPOVER_MIN_WIDTH,
  BRANCH_POPOVER_VIEWPORT_MARGIN,
  BRANCH_TREE_ROOT_ID,
  branchPopoverAlign,
  branchRowKey,
  branchRowTestId,
  buildBranchTreeIndex,
  chooseCrumbEntries,
  collapseAllExpandedKeys,
  type CrumbEntry,
  mergeExpandedKeys,
  planBranchPopoverFit,
  pruneExpandedKeys
} from '../branchTreeModel'

/**
 * The selector's model is a pure projection of the flat branch catalog plus
 * the active route: render order, the ancestor chain used for the active
 * line, expansion bookkeeping across catalog refreshes, the breadcrumb's
 * whole-segment omission, and the popover's open-session fit. No rendering
 * involved.
 */

const wire = (id: string, parentBranchId: string | null, createdAt: string, name = id): TopicBranchWire =>
  ({
    id,
    topicId: 't-1',
    parentBranchId,
    anchorMessageId: `m-${id}`,
    name,
    createdAt,
    updatedAt: createdAt
  }) as TopicBranchWire

/**
 * root
 * ├── a      (2026-01-01)
 * │   └── a1 (2026-01-03)
 * └── b      (2026-01-02)
 */
const catalog = (): TopicBranchWire[] => [
  wire('b', null, '2026-01-02T00:00:00.000Z'),
  wire('a1', 'a', '2026-01-03T00:00:00.000Z'),
  wire('a', null, '2026-01-01T00:00:00.000Z')
]

const kinds = (entries: CrumbEntry[]): string[] =>
  entries.map((entry) => (entry.kind === 'gap' ? `gap:${entry.hidden}` : `seg:${entry.index}`))

describe('branch tree index', () => {
  it('orders rows depth-first in creation order under the main-route root', () => {
    const index = buildBranchTreeIndex(catalog())
    expect(index.orderedKeys).toEqual([BRANCH_TREE_ROOT_ID, 'a', 'a1', 'b'])
    expect(index.parentKeyOf.get('a')).toBe(BRANCH_TREE_ROOT_ID)
    expect(index.parentKeyOf.get('a1')).toBe('a')
    expect(index.depthOf.get('a1')).toBe(2)
    expect(index.childrenOf.get(BRANCH_TREE_ROOT_ID)?.map((branch) => branch.id)).toEqual(['a', 'b'])
  })

  it('resolves the ancestor chain of a route, and treats the main route as the root alone', () => {
    const index = buildBranchTreeIndex(catalog())
    expect(index.ancestorsOf('a1')).toEqual([BRANCH_TREE_ROOT_ID, 'a'])
    expect(index.chainTo('a1')).toEqual([BRANCH_TREE_ROOT_ID, 'a', 'a1'])
    expect(index.ancestorsOf(null)).toEqual([])
    expect(index.chainTo(null)).toEqual([BRANCH_TREE_ROOT_ID])
    // A branch that is no longer in the catalog still resolves to the root.
    expect(index.chainTo('gone')).toEqual([BRANCH_TREE_ROOT_ID])
  })

  it('keeps row keys and selector ids stable for the main route and branches', () => {
    expect(branchRowKey(null)).toBe(BRANCH_TREE_ROOT_ID)
    expect(branchRowTestId(null)).toBe('branch-cascader-item-main')
    expect(branchRowTestId('b-1')).toBe('branch-cascader-item-b-1')
  })
})

describe('branch tree expansion bookkeeping', () => {
  it('opens the root plus the current route ancestors', () => {
    expect(baseExpandedKeys([])).toEqual([BRANCH_TREE_ROOT_ID])
    expect(baseExpandedKeys([BRANCH_TREE_ROOT_ID])).toEqual([BRANCH_TREE_ROOT_ID])
    expect(baseExpandedKeys([BRANCH_TREE_ROOT_ID, 'a'])).toEqual([BRANCH_TREE_ROOT_ID, 'a'])
    // Duplicates never widen the floor.
    expect(baseExpandedKeys([BRANCH_TREE_ROOT_ID, 'a', 'a'])).toEqual([BRANCH_TREE_ROOT_ID, 'a'])
    expect(mergeExpandedKeys([BRANCH_TREE_ROOT_ID], ['a', 'b', 'a'])).toEqual([BRANCH_TREE_ROOT_ID, 'a', 'b'])
  })

  it('collapsing all keeps only the current ancestor chain, and nothing at all on the main route', () => {
    // No forced root: on the main route every row folds, the root included.
    expect(collapseAllExpandedKeys([])).toEqual([])
    expect(collapseAllExpandedKeys([BRANCH_TREE_ROOT_ID])).toEqual([BRANCH_TREE_ROOT_ID])
    expect(collapseAllExpandedKeys([BRANCH_TREE_ROOT_ID, 'a'])).toEqual([BRANCH_TREE_ROOT_ID, 'a'])
  })

  it('drops expansion keys whose branch disappeared from the refreshed catalog', () => {
    const existing = new Set(['__main', 'a', 'b'])
    expect(pruneExpandedKeys(['__main', 'a', 'gone', 'b', 'b'], existing)).toEqual(['__main', 'a', 'b'])
    expect(pruneExpandedKeys(['gone'], existing)).toEqual([])
  })
})

describe('breadcrumb whole-segment omission', () => {
  const layout = (availableWidth: number) =>
    chooseCrumbEntries({
      segmentCount: 5,
      segmentWidths: [50, 10, 10, 10, 50],
      separatorWidth: 6,
      gapWidth: 12,
      availableWidth
    })

  it('keeps every segment while the whole path fits', () => {
    expect(kinds(layout(200))).toEqual(['seg:0', 'seg:1', 'seg:2', 'seg:3', 'seg:4'])
    // Exactly fitting is still "fits".
    expect(kinds(layout(154))).toEqual(['seg:0', 'seg:1', 'seg:2', 'seg:3', 'seg:4'])
  })

  it('hides middle segments oldest-first behind one marker, keeping the first and the current one', () => {
    // 150 fits first + the two most recent middles + current in place of the
    // full path: the oldest middle is the one that goes.
    expect(kinds(layout(150))).toEqual(['seg:0', 'gap:2', 'seg:3', 'seg:4'])
    // Tighter: only the freshest middle survives.
    expect(kinds(layout(130))).toEqual(['seg:0', 'gap:3', 'seg:4'])
    // No middle fits at all: first … current, still exactly one marker.
    expect(kinds(layout(100))).toEqual(['seg:0', 'gap:3', 'seg:4'])
  })

  it('never emits an empty or doubled separator position', () => {
    for (const available of [100, 130, 140, 150, 154, 200]) {
      const entries = layout(available)
      const first = entries[0]
      const last = entries[entries.length - 1]
      expect(first.kind).toBe('segment')
      expect(last.kind).toBe('segment')
      // Separators are implied by position, so two adjacent gaps (or a
      // leading/trailing gap) would render as an empty or doubled segment.
      for (let index = 1; index < entries.length; index += 1) {
        expect(entries[index - 1].kind === 'gap' && entries[index].kind === 'gap').toBe(false)
      }
      expect(kinds(entries)[0]).toBe('seg:0')
      expect(kinds(entries)[entries.length - 1]).toBe('seg:4')
    }
  })

  it('never omits anything it cannot measure, and short paths never collapse', () => {
    expect(kinds(layout(0))).toEqual(['seg:0', 'seg:1', 'seg:2', 'seg:3', 'seg:4'])
    expect(
      kinds(
        chooseCrumbEntries({
          segmentCount: 2,
          segmentWidths: [400, 400],
          separatorWidth: 6,
          gapWidth: 12,
          availableWidth: 20
        })
      )
    ).toEqual(['seg:0', 'seg:1'])
    expect(
      kinds(
        chooseCrumbEntries({ segmentCount: 0, segmentWidths: [], separatorWidth: 6, gapWidth: 12, availableWidth: 10 })
      )
    ).toEqual([])
  })
})

describe('branch popover open-session fit', () => {
  const fit = (triggerLeft: number, triggerWidth: number, viewportWidth: number) =>
    planBranchPopoverFit({ triggerLeft, triggerWidth, viewportWidth })
  /** Where the popup's own left border box lands: the anchor moved by its shift. */
  const popupLeft = (triggerLeft: number, plan: { leftShift: number }): number => triggerLeft - plan.leftShift

  it('reserves the growth room from the window edge, so the panel can grow rightwards', () => {
    // The entry sits near the right end of a wide window: a panel keeping its
    // right edge on the entry would have nowhere to grow.
    const plan = fit(1100, 30, 1280)

    expect(plan.leftShift).toBeGreaterThan(0)
    expect(plan.maxWidth).toBe(BRANCH_POPOVER_MAX_WIDTH)
    // Left edge plus budget — plus the popup box around the panel — still ends
    // inside the window margin: nothing is left for the popover to correct
    // later, so growing never re-aligns it.
    expect(popupLeft(1100, plan) + plan.maxWidth + BRANCH_POPOVER_FRAME_WIDTH).toBeLessThanOrEqual(
      1280 - BRANCH_POPOVER_VIEWPORT_MARGIN
    )
    expect(popupLeft(1100, plan)).toBeGreaterThanOrEqual(BRANCH_POPOVER_VIEWPORT_MARGIN)
  })

  it('reserves that room for the real navbar geometry the popover opens in', () => {
    // A 1440px window with the entry at its observed left edge: the budget
    // lands at 1440 - 16 - 420 - 2 = 1002, i.e. 33.5px left of the entry.
    const plan = fit(1035.5, 32, 1440)

    expect(plan.maxWidth).toBe(BRANCH_POPOVER_MAX_WIDTH)
    // Rounded outwards, so the reserved start is half a pixel further left than
    // strictly needed — never further right.
    expect(plan.leftShift).toBe(34)
    expect(popupLeft(1035.5, plan)).toBe(1001.5)
    expect(popupLeft(1035.5, plan) + plan.maxWidth + BRANCH_POPOVER_FRAME_WIDTH).toBeLessThanOrEqual(1440 - 16)
  })

  it('never plans more than a narrow window can hold', () => {
    const plan = fit(200, 30, 360)
    expect(plan.maxWidth).toBeLessThanOrEqual(360 - 2 * BRANCH_POPOVER_VIEWPORT_MARGIN - BRANCH_POPOVER_FRAME_WIDTH)
    expect(popupLeft(200, plan) + plan.maxWidth + BRANCH_POPOVER_FRAME_WIDTH).toBeLessThanOrEqual(
      360 - BRANCH_POPOVER_VIEWPORT_MARGIN
    )
    expect(plan.maxWidth).toBeGreaterThan(BRANCH_POPOVER_MIN_WIDTH)
    // The panel starts on the left margin, not off the window.
    expect(popupLeft(200, plan)).toBe(BRANCH_POPOVER_VIEWPORT_MARGIN)
  })

  it('falls back to the anchored position and a window-capped width when the trigger is unmeasured', () => {
    // No layout (first pass, or an environment without layout): nothing may be
    // invented from a zero-size rect.
    const plan = fit(0, 0, 1024)
    expect(plan.leftShift).toBe(0)
    expect(plan.maxWidth).toBe(BRANCH_POPOVER_MAX_WIDTH)

    // A window narrower than the readable minimum shrinks the budget instead of
    // letting the panel overflow it; the panel's own min-width follows the
    // budget down, so a small window never pushes the panel past its edge.
    const tiny = fit(0, 0, 150)
    expect(tiny.maxWidth).toBe(150 - 2 * BRANCH_POPOVER_VIEWPORT_MARGIN - BRANCH_POPOVER_FRAME_WIDTH)
    expect(tiny.maxWidth).toBeLessThan(BRANCH_POPOVER_MIN_WIDTH)

    // With no window at all there is nothing to bound against, so the readable
    // minimum is what the panel may occupy rather than a zero-width column.
    expect(fit(0, 0, 0).maxWidth).toBe(BRANCH_POPOVER_MIN_WIDTH)
  })
})

describe('branch popover align config', () => {
  it('places the planned left edge through the align pass, not through the popup box', () => {
    const plan = planBranchPopoverFit({ triggerLeft: 1100, triggerWidth: 30, viewportWidth: 1280 })
    const align = branchPopoverAlign(plan)

    // `bottomLeft` alone would put the popup's left edge on the trigger's; the
    // target offset is what moves it to the planned start, and it moves only
    // the horizontal axis.
    expect(align.targetOffset).toEqual([plan.leftShift, 0])
    expect(1100 - align.targetOffset[0]).toBe(1280 - 16 - 420 - 2)
  })

  it('turns the popover horizontal self-correction off and keeps the vertical one', () => {
    const align = branchPopoverAlign(planBranchPopoverFit({ triggerLeft: 1100, triggerWidth: 30, viewportWidth: 1280 }))

    // A content resize re-runs the align pass: a flip or a shift here would drag
    // the panel (and the entry's click point) off the fixed left edge.
    expect(align.overflow.adjustX).toBe(false)
    expect(align.overflow.shiftX).toBe(false)
    // Vertical avoidance is not part of that contract: a tall tree may still
    // move above the navbar.
    expect(align.overflow.adjustY).toBe(true)
    expect(align.overflow.shiftY).toBe(true)
  })

  it('is stable for the whole open: no content size can change it', () => {
    const plan = planBranchPopoverFit({ triggerLeft: 1035.5, triggerWidth: 32, viewportWidth: 1440 })
    // Same plan, same config: nothing about the panel's own width is an input.
    expect(branchPopoverAlign(plan)).toEqual(branchPopoverAlign(plan))
    // A narrower window re-plans, and only then does the config move.
    const narrow = branchPopoverAlign(
      planBranchPopoverFit({ triggerLeft: 1035.5, triggerWidth: 32, viewportWidth: 1200 })
    )
    expect(narrow.targetOffset[0]).toBeGreaterThan(plan.leftShift)
  })
})
