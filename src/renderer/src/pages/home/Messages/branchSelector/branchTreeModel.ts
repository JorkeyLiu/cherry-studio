import type { TopicBranchWire } from '@renderer/services/db/types'

/**
 * Pure model for the top branch-tree selector.
 *
 * The catalog is a flat `TopicBranchWire[]`; the selector renders it as a tree
 * whose root is the main route (null branch id). Everything here is a pure
 * projection of that catalog plus the active route, so expansion bookkeeping,
 * the active ancestor path and the breadcrumb's whole-segment omission can be
 * asserted without rendering.
 */

/** Key of the main-route root row (no branch id). */
export const BRANCH_TREE_ROOT_ID = '__main'

/** Stable row key for a route: the branch id, or the root key for the main route. */
export const branchRowKey = (branchId: string | null): string => branchId ?? BRANCH_TREE_ROOT_ID

/** Stable selector id for a route row: branch ids stay verbatim, the main route stays `main`. */
export const branchRowTestId = (branchId: string | null): string => `branch-cascader-item-${branchId ?? 'main'}`

export type BranchTreeIndex = {
  byId: Map<string, TopicBranchWire>
  /** Direct children per parent route key (root key for the main route), creation order. */
  childrenOf: Map<string, TopicBranchWire[]>
  /** Parent route key per node (null for the root). */
  parentKeyOf: Map<string, string | null>
  /** Depth per node key (root = 0). */
  depthOf: Map<string, number>
  /** Root-key → node ancestor chain (root first, excluding the node itself). */
  ancestorsOf: (branchId: string | null) => string[]
  /** Root-first rendered chain for a route: `[rootKey, …ancestors, nodeKey]`. */
  chainTo: (branchId: string | null) => string[]
  /** Every rendered node key, root first (render order). */
  orderedKeys: string[]
}

const byCreation = (a: TopicBranchWire, b: TopicBranchWire): number =>
  (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)

/** Builds the tree index over one logical topic's branch catalog. */
export function buildBranchTreeIndex(branches: readonly TopicBranchWire[]): BranchTreeIndex {
  const byId = new Map<string, TopicBranchWire>(branches.map((branch) => [branch.id, branch]))
  const childrenOf = new Map<string, TopicBranchWire[]>()
  for (const branch of branches) {
    const key = branchRowKey(branch.parentBranchId ?? null)
    const list = childrenOf.get(key) ?? []
    list.push(branch)
    childrenOf.set(key, list)
  }
  childrenOf.forEach((list) => list.sort(byCreation))

  const parentKeyOf = new Map<string, string | null>([[BRANCH_TREE_ROOT_ID, null]])
  const depthOf = new Map<string, number>([[BRANCH_TREE_ROOT_ID, 0]])
  const orderedKeys: string[] = [BRANCH_TREE_ROOT_ID]
  const walk = (key: string): void => {
    for (const child of childrenOf.get(key) ?? []) {
      parentKeyOf.set(child.id, key)
      depthOf.set(child.id, (depthOf.get(key) ?? 0) + 1)
      orderedKeys.push(child.id)
      walk(child.id)
    }
  }
  walk(BRANCH_TREE_ROOT_ID)

  const ancestorsOf = (branchId: string | null): string[] => {
    const out: string[] = []
    let cursor = parentKeyOf.get(branchRowKey(branchId)) ?? null
    const seen = new Set<string>()
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor)
      out.unshift(cursor)
      cursor = parentKeyOf.get(cursor) ?? null
    }
    return out
  }

  const chainTo = (branchId: string | null): string[] => {
    const key = branchRowKey(branchId)
    if (!parentKeyOf.has(key)) return [BRANCH_TREE_ROOT_ID]
    return [...ancestorsOf(branchId), key]
  }

  return { byId, childrenOf, parentKeyOf, depthOf, ancestorsOf, chainTo, orderedKeys }
}

/**
 * Drops expansion keys whose node no longer exists, so a catalog refresh
 * (rename keeps ids; delete/fallback removes them) never leaves stale rows
 * flagged as expanded.
 */
export function pruneExpandedKeys(keys: readonly string[], existingKeys: ReadonlySet<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (!existingKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * Expansion floor used when the selector opens: the root plus the current
 * route's ancestor chain (root first, the route node itself excluded), so the
 * current row is always reachable right away.
 */
export function baseExpandedKeys(ancestors: readonly string[]): string[] {
  return mergeExpandedKeys([BRANCH_TREE_ROOT_ID], ancestors)
}

/**
 * Expansion floor for "collapse all": the current route's ancestor chain only,
 * with no forced root. The current route therefore stays reachable while every
 * other fork — and the current node's own children — fold away, and on the main
 * route (empty chain) the root row folds too.
 */
export function collapseAllExpandedKeys(ancestors: readonly string[]): string[] {
  return mergeExpandedKeys([], ancestors)
}

/** Union of expansion keys, root first and de-duplicated. */
export function mergeExpandedKeys(base: readonly string[], extra: readonly string[]): string[] {
  const out = [...base]
  const seen = new Set(base)
  for (const key of extra) {
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export type CrumbEntry = { kind: 'segment'; index: number } | { kind: 'gap'; hidden: number }

export type CrumbLayoutInput = {
  /** Number of breadcrumb segments, root first; the last one is the current route. */
  segmentCount: number
  /** Measured width per segment. */
  segmentWidths: readonly number[]
  /** Measured width of one `/` separator. */
  separatorWidth: number
  /** Measured width of the `…` gap marker. */
  gapWidth: number
  /** Width available to the crumb. */
  availableWidth: number
}

/**
 * Whole-segment omission for the breadcrumb.
 *
 * The first and the current segment always stay; middle ancestors are dropped
 * oldest-first (most recent ancestors are preferred) and any run of hidden
 * middles collapses into exactly one `…`. Separators exist only between two
 * visible entries, so the result never starts/ends with one and never has two
 * in a row. Falling back (no middle fits) yields `first …, current`.
 */
export function chooseCrumbEntries(input: CrumbLayoutInput): CrumbEntry[] {
  const { segmentCount, segmentWidths, separatorWidth, gapWidth, availableWidth } = input
  if (segmentCount <= 0) return []
  const all: CrumbEntry[] = Array.from({ length: segmentCount }, (_, index) => ({
    kind: 'segment' as const,
    index
  }))
  if (segmentCount <= 2 || !(availableWidth > 0)) return all

  const widthOf = (entries: readonly CrumbEntry[]): number => {
    let sum = 0
    entries.forEach((entry, position) => {
      sum += entry.kind === 'gap' ? gapWidth : (segmentWidths[entry.index] ?? 0)
      if (position > 0) sum += separatorWidth
    })
    return sum
  }

  if (widthOf(all) <= availableWidth) return all

  const last = segmentCount - 1
  const middleCount = segmentCount - 2
  for (let kept = middleCount; kept >= 0; kept -= 1) {
    const candidate: CrumbEntry[] = [{ kind: 'segment', index: 0 }]
    const hidden = middleCount - kept
    if (hidden > 0) candidate.push({ kind: 'gap', hidden })
    for (let index = segmentCount - 1 - kept; index <= last - 1; index += 1) {
      if (index >= 1) candidate.push({ kind: 'segment', index })
    }
    candidate.push({ kind: 'segment', index: last })
    if (widthOf(candidate) <= availableWidth) return candidate
  }

  return [
    { kind: 'segment', index: 0 },
    { kind: 'gap', hidden: middleCount },
    { kind: 'segment', index: last }
  ]
}

/* ------------------------------------------------------------------ *
 * Popover fit and align
 *
 * The branch entry sits at the right end of the navbar, so a panel that kept
 * its right edge on the button could only ever grow leftwards — which would
 * slide the whole panel (and the button's own click point under a moving
 * pointer). The open-session fit below trades that for a stable left edge:
 * at open time the panel reserves the room it may grow into, measured from
 * the window's right edge, and it never moves again for the rest of that
 * open. Content then only grows to the right, up to the reserved budget.
 *
 * Where that left edge is lands on the popover's own align pass, never on a
 * CSS offset of the popup: the align pass measures the popup and re-solves
 * its `left` on every pass (open, content resize, window resize), so a CSS
 * margin is measured as part of the popup and compensated away again.
 * ------------------------------------------------------------------ */

/** Smallest gap kept between the panel and either window edge. */
export const BRANCH_POPOVER_VIEWPORT_MARGIN = 16
/**
 * Narrowest the visible panel may become — and the width it opens at, so it
 * has to hold one readable path segment plus a row's own controls. A bare
 * technical lower bound leaves the tree too cramped to read.
 */
export const BRANCH_POPOVER_MIN_WIDTH = 280
/** Widest the panel may become; long names truncate in place instead. */
export const BRANCH_POPOVER_MAX_WIDTH = 420
/**
 * Room the enclosing popup box takes around the panel's own box. The budget
 * bounds the panel, but what has to stay inside the window margin is the popup
 * around it — measured one pixel wider per side — so it is reserved here
 * instead of being paid out of the margin.
 */
export const BRANCH_POPOVER_FRAME_WIDTH = 2

export type BranchPopoverFitInput = {
  /** Trigger's viewport left edge. */
  triggerLeft: number
  /** Trigger width; `<= 0` (or a non-finite left) means "not measured yet". */
  triggerWidth: number
  viewportWidth: number
  margin?: number
  minWidth?: number
  maxWidth?: number
  frameWidth?: number
}

export type BranchPopoverFit = {
  /** How far left of the trigger's own left edge the panel's left edge starts; `>= 0`. */
  leftShift: number
  /** Widest the panel may grow to during this open. */
  maxWidth: number
}

/**
 * The `align` config this popover has to run with (see `branchPopoverAlign`).
 * Declared structurally — it is exactly the part of the popover's align
 * contract this selector sets, and it stays assignable to the component's own
 * `align` prop.
 */
export type BranchPopoverAlign = {
  /** Moves the alignment target left by `[x, y]`; `y` never moves the panel. */
  targetOffset: [number, number]
  overflow: { adjustX: boolean; adjustY: boolean; shiftX: boolean; shiftY: boolean }
}

/**
 * Open-session fit for the branch popover.
 *
 * The panel is left-anchored and grows rightwards, so the fit answers two
 * questions at open time:
 *
 * - where the left edge must start, so that the widest allowed panel — plus
 *   the popup box around it — still fits inside the window margin
 *   (`leftShift`, applied through the align pass);
 * - how wide the panel may become before it must truncate names instead
 *   (`maxWidth`, fixed for the whole open so growth never re-aligns).
 *
 * Both values are derived from the trigger and the window alone — never from
 * the panel's own content — so growth can never feed back into the position.
 */
export function planBranchPopoverFit(input: BranchPopoverFitInput): BranchPopoverFit {
  const margin = input.margin ?? BRANCH_POPOVER_VIEWPORT_MARGIN
  const minWidth = input.minWidth ?? BRANCH_POPOVER_MIN_WIDTH
  const maxWidth = input.maxWidth ?? BRANCH_POPOVER_MAX_WIDTH
  const frameWidth = input.frameWidth ?? BRANCH_POPOVER_FRAME_WIDTH
  const viewportWidth = Number.isFinite(input.viewportWidth) ? Math.max(0, input.viewportWidth) : 0

  // No layout to fit against: plan the readable minimum rather than a
  // zero-width panel, which could not even measure its own rows.
  if (!(viewportWidth > 0)) return { leftShift: 0, maxWidth: Math.min(maxWidth, minWidth) }

  // Room between the two window margins, minus the popup box around the panel.
  // It is the hard ceiling: a narrow window shrinks the budget — and the
  // panel's own min-width follows the budget down — instead of letting the
  // readable minimum push the popup past the window edge.
  const room = Math.max(0, viewportWidth - margin * 2 - frameWidth)
  const widest = Math.min(maxWidth, room)

  const measured = Number.isFinite(input.triggerLeft) && input.triggerWidth > 0
  if (!measured) {
    // Nothing to anchor to yet (first pass, or no layout at all): keep the
    // anchored position and only cap the width to the window.
    return { leftShift: 0, maxWidth: widest }
  }

  // The leftmost the panel may start and still leave the whole budget inside
  // the margin. The panel never starts right of its anchor, and never left of
  // the window margin.
  const leftStart = Math.max(margin, Math.min(input.triggerLeft, viewportWidth - margin - widest - frameWidth))
  // Rounded outwards: a fractional shift may only add slack, never overflow.
  return { leftShift: Math.max(0, Math.ceil(input.triggerLeft - leftStart)), maxWidth: widest }
}

/**
 * Horizontal correction of the popup: off.
 *
 * The popover's own align pass moves a popup it cannot fit — it flips a
 * `bottomLeft` panel to `bottomRight`, or shifts it back into the visible area —
 * and it re-runs that pass whenever the panel changes size. Either response
 * would drag the panel away from the fixed left edge (and the entry's click
 * point with it) as soon as the content grows, so both are disabled. Vertical
 * avoidance stays on: a tall tree may still flip above the navbar.
 */
const BRANCH_POPOVER_OVERFLOW = { adjustX: false, adjustY: true, shiftX: false, shiftY: true } as const

/**
 * The `align` config that puts the planned left edge on screen.
 *
 * `bottomLeft` anchors the popup's top-left corner to the trigger's
 * bottom-left corner, i.e. the panel's left edge would be the trigger's own
 * left edge. `targetOffset` then moves that anchor left by the planned shift,
 * which puts the panel at its reserved start without moving the entry. The
 * offset is the align pass's own input, so it survives every re-align with the
 * panel's real size in it — unlike a CSS offset on the popup, which the pass
 * measures as part of the popup and cancels out.
 */
export function branchPopoverAlign(fit: BranchPopoverFit): BranchPopoverAlign {
  return {
    targetOffset: [fit.leftShift, 0],
    overflow: BRANCH_POPOVER_OVERFLOW
  }
}
