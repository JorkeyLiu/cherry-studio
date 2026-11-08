import { describe, expect, it } from 'vitest'

import {
  type BranchGeoNode,
  buildBranchTreeGeometry,
  cornerPath,
  planRevealScroll,
  planScrollIntoView
} from '../branchTreeGeometry'

/**
 * Connector geometry is a pure function of measured row slots, so these
 * assertions pin the rules the SVG layer depends on: one shared trunk per
 * parent, the last child closing the trunk with a rounded corner, a continuous
 * root-to-current line over the full rendered ancestor chain, every connector
 * pivoting on its chevron column's centre, a glyph hole only where a row
 * really draws an arrow, and the scroll coordinates used when a row is
 * expanded or revealed.
 *
 * The slots mirror the rendered layout (30px rows, 16px chevron columns, 20px
 * per indent level, 6px before the name column). The expected values are the
 * ones the reference tree produces for that layout, so a change in the drawn
 * shape has to be a deliberate change here.
 */

const ROW_HEIGHT = 30
const SLOT_WIDTH = 16
const INDENT_SIZE = 20
const TAIL = 6
const RADIUS = 4
/** Side of the expansion-arrow glyph, and the room kept on every side of it. */
const GLYPH_SIZE = 10
const GLYPH_CLEARANCE = 1.5

/**
 * Mirrors the rendered layout: 30px rows, 16px chevron columns, 20px per level.
 * `expandable` is the catalog fact behind the drawn arrow: a row shows one
 * exactly when its node has children.
 */
const geoNode = (
  id: string,
  parentId: string | null,
  depth: number,
  rowIndex: number,
  expandable: boolean
): BranchGeoNode => {
  const slotRight = SLOT_WIDTH + INDENT_SIZE * depth
  return {
    id,
    parentId,
    depth,
    centerY: ROW_HEIGHT * rowIndex + ROW_HEIGHT / 2,
    pivotX: slotRight - SLOT_WIDTH / 2,
    slotLeft: slotRight - SLOT_WIDTH,
    slotRight,
    expandable
  }
}

/**
 * root
 * ├── a
 * │   └── a1
 * └── b
 *     └── b1
 */
const nodes = (): BranchGeoNode[] => [
  geoNode('root', null, 0, 0, true),
  geoNode('a', 'root', 1, 1, true),
  geoNode('b', 'root', 1, 2, true),
  geoNode('a1', 'a', 2, 3, false),
  geoNode('b1', 'b', 2, 4, false)
]

const geometry = (pathIds: string[], input: BranchGeoNode[] = nodes()) =>
  buildBranchTreeGeometry(input, pathIds, {
    radius: RADIUS,
    tail: TAIL,
    glyphSize: GLYPH_SIZE,
    glyphClearance: GLYPH_CLEARANCE
  })

/** Connector x of a row: its chevron column's centre. */
const pivotOf = (node: BranchGeoNode): number => node.pivotX

describe('branch tree connector geometry', () => {
  it('draws one shared trunk per parent from the parent column down to the last child, with a rounded corner into it', () => {
    const result = geometry(['root'])

    const rootTrunk = result.greySegments.find((segment) => segment.kind === 'trunk' && segment.parentId === 'root')
    expect(rootTrunk).toEqual({
      axis: 'v',
      x1: pivotOf(geoNode('root', null, 0, 0, true)),
      y1: 15 + TAIL,
      x2: pivotOf(geoNode('root', null, 0, 0, true)),
      y2: 75,
      kind: 'trunk',
      parentId: 'root'
    })

    // The trunk path is a single polyline: down the parent column, then a
    // curved run into the last child's column.
    expect(result.grey[0]).toBe('M 8 21 L 8 71 Q 8 75 12 75 L 28 75')
    expect(result.grey).toContain('M 8 45 L 28 45')
  })

  it('runs the horizontal leg a full indent step across and rounds it with the 4px corner', () => {
    const result = geometry(['root'])

    // Both ends sit on a column centre, so the elbow is a real 20px run — not a
    // stub disappearing under the chevrons.
    const stub = result.greySegments.find(
      (segment) => segment.kind === 'stub' && segment.parentId === 'root' && segment.childId === 'a'
    )
    expect(stub).toEqual({
      axis: 'h',
      x1: 8,
      y1: 45,
      x2: 28,
      y2: 45,
      kind: 'stub',
      parentId: 'root',
      childId: 'a'
    })
    expect((stub?.x2 ?? 0) - (stub?.x1 ?? 0)).toBe(INDENT_SIZE)

    // The 4px corner consumes exactly 4 of the run and 4 of the vertical drop:
    // the curve starts at (8, 71) and ends at (12, 75).
    const trunkPath = result.grey[0] ?? ''
    expect(trunkPath).toContain('L 8 71 Q 8 75 12 75')
    expect(trunkPath.endsWith('L 28 75')).toBe(true)
  })

  it('closes the last child through the trunk corner instead of drawing a second stub', () => {
    const result = geometry(['root'])

    // Both direct children contribute a horizontal stub segment ...
    const stubs = result.greySegments.filter((segment) => segment.kind === 'stub' && segment.parentId === 'root')
    expect(stubs.map((segment) => segment.childId)).toEqual(['a', 'b'])

    // ... but only the non-last child gets its own path; the last child's run
    // is part of the trunk polyline, so no second `M ... 75` line exists.
    const lastChildPaths = result.grey.filter((path) => path.startsWith('M 8 75'))
    expect(lastChildPaths).toEqual([])
  })

  it('emits a continuous active line over the whole rendered ancestor chain', () => {
    const result = geometry(['root', 'a', 'a1'])

    expect(result.chain).toEqual(['root', 'a', 'a1'])
    expect(result.active).toBe('M 8 21 L 8 41 Q 8 45 12 45 L 24 45 Q 28 45 28 49 L 28 101 Q 28 105 32 105 L 48 105')
    expect(result.turns).toEqual([
      { x: 8, y: 45 },
      { x: 28, y: 105 }
    ])
    // One vertical + one horizontal leg per hop, in root-first order.
    expect(result.activeSegments.map((segment) => `${segment.axis}:${segment.parentId}>${segment.childId}`)).toEqual([
      'v:root>a',
      'h:root>a',
      'v:a>a1',
      'h:a>a1'
    ])
    // The line stops on the last column's centre, never under the name.
    const lastLeg = result.activeSegments[result.activeSegments.length - 1]
    expect(lastLeg.x2).toBe(48)
    expect(result.start).toEqual({ x: 8, y: 15 + TAIL })
    expect(result.end).toEqual({ x: 48, y: 105 })
    expect(result.active).toContain('Q')
  })

  it('keeps every connector on its column centre and cuts a hole only where a row draws an arrow', () => {
    const input = nodes()
    const result = geometry(['root', 'a', 'a1'], input)

    // No x was shifted off a column centre to dodge a glyph: the turning
    // points, the legs and the endpoint are exactly the measured ones.
    const xs = [
      ...result.greySegments.flatMap((segment) => [segment.x1, segment.x2]),
      ...result.activeSegments.flatMap((segment) => [segment.x1, segment.x2])
    ]
    const centres = new Set([0, 1, 2].map((depth) => depth * INDENT_SIZE + SLOT_WIDTH / 2))
    expect(centres).toEqual(new Set([8, 28, 48]))
    for (const x of xs) {
      expect(centres.has(x)).toBe(true)
    }

    // One hole per row that draws an arrow, centred on that row's column and no
    // bigger than the glyph plus its clearance — never the 28px click target.
    expect(result.glyphCuts).toEqual([
      { x: 1.5, y: 8.5, width: 13, height: 13 },
      { x: 21.5, y: 38.5, width: 13, height: 13 },
      { x: 21.5, y: 68.5, width: 13, height: 13 }
    ])
    for (const cut of result.glyphCuts) {
      expect(cut.width).toBe(GLYPH_SIZE + GLYPH_CLEARANCE * 2)
      // The hole stays inside the chevron column: it never nicks the name
      // column and never shrinks the click target.
      expect(cut.width).toBeLessThan(SLOT_WIDTH)
    }

    // The two leaves (a1, b1) draw no arrow, so their empty slot is never cut.
    expect(result.glyphCuts.some((cut) => cut.x >= pivotOf(input[3]))).toBe(false)

    // The leg into the intermediate row 'a' still ends on that row's centre —
    // cutting the glyph box is what removes the piece behind its arrow.
    const intermediate = result.activeSegments.find((segment) => segment.axis === 'h' && segment.childId === 'a')
    expect(intermediate?.x2).toBe(pivotOf(input[1]))
    const cutAtA = result.glyphCuts.find((cut) => cut.y === 38.5)
    expect(cutAtA).toEqual({ x: 21.5, y: 38.5, width: 13, height: 13 })
    expect(intermediate?.x2).toBeGreaterThan(cutAtA?.x ?? 0)
    expect(intermediate?.x2).toBeLessThan((cutAtA?.x ?? 0) + (cutAtA?.width ?? 0))
  })

  it('truncates the active line at the first collapsed ancestor instead of drawing a broken route', () => {
    // a1 is not rendered (its parent is collapsed), so the chain stops at a.
    const collapsed = nodes().filter((node) => node.id !== 'a1')
    const result = geometry(['root', 'a', 'a1'], collapsed)

    expect(result.chain).toEqual(['root', 'a'])
    expect(result.end).toEqual({ x: 28, y: 45 })
    expect(result.activeSegments).toHaveLength(2)
    // Every rendered arrow row still asks for a hole; the four rendered rows are
    // root, a, b (all arrows) and the leaf b1.
    expect(result.glyphCuts).toHaveLength(3)
  })

  it('draws no active line for a single-row chain but still reports the end point', () => {
    const result = geometry(['root'])
    expect(result.active).toBe('')
    expect(result.turns).toEqual([])
    expect(result.end).toEqual({ x: 8, y: 15 })
  })

  it('places the endpoint dot only on a terminal row that draws no arrow', () => {
    // A leaf current row leaves its arrow column empty, so the endpoint keeps
    // its dot exactly on the drawn end point.
    const leaf = geometry(['root', 'a', 'a1'])
    expect(leaf.endDot).toEqual({ x: 48, y: 105 })
    expect(leaf.endDot).toEqual(leaf.end)

    // A fork that really is the current row still draws its arrow — the same
    // catalog fact that asks for a glyph hole — so no dot is added on top of
    // the chevron, whether that fork is expanded here...
    expect(geometry(['root', 'a']).endDot).toBeNull()

    // ...or collapsed: dropping the child row changes the drawn chain, not the
    // rule, so the collapsed fork is still dotless.
    const collapsed = nodes().filter((node) => node.id !== 'a1')
    expect(geometry(['root', 'a', 'a1'], collapsed).endDot).toBeNull()

    // The root is a fork too: a single-row chain still reports `end`, and the
    // dot stays off its arrow.
    const root = geometry(['root'])
    expect(root.end).toEqual({ x: 8, y: 15 })
    expect(root.endDot).toBeNull()
  })

  it('emits no trunk and no horizontal run when slots are unmeasured (jsdom-like rows)', () => {
    const flat: BranchGeoNode[] = [
      { id: 'root', parentId: null, depth: 0, centerY: 0, pivotX: 0, slotLeft: 0, slotRight: 0, expandable: true },
      { id: 'a', parentId: 'root', depth: 1, centerY: 0, pivotX: 0, slotLeft: 0, slotRight: 0, expandable: false }
    ]
    const result = buildBranchTreeGeometry(flat, ['root', 'a'], {
      radius: RADIUS,
      tail: TAIL,
      glyphSize: GLYPH_SIZE,
      glyphClearance: GLYPH_CLEARANCE
    })
    expect(result.grey).toEqual([])
    expect(result.activeSegments.every((segment) => segment.x1 === segment.x2)).toBe(true)
    // Nothing is drawn, and the panel commits no geometry from such a pass at
    // all — only the arrow rows would ever ask for a hole.
    expect(result.glyphCuts).toHaveLength(1)
  })

  it('keeps corner radii orthogonal: straight runs use L, turns use a bounded Q', () => {
    const path = cornerPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 }
      ],
      4
    )
    expect(path).toBe('M 0 0 L 0 6 Q 0 10 4 10 L 10 10')

    // A straight-through vertex never introduces a curve.
    expect(
      cornerPath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 10 }
        ],
        4
      )
    ).toBe('M 0 0 L 0 10')
  })
})

describe('branch tree scroll coordinates', () => {
  it('reveals a newly expanded child while keeping the expanded row on screen', () => {
    // 300px viewport, scrolled to 0: the parent (rows at 0..30) stays, the new
    // child at 30..60 is already visible.
    expect(
      planRevealScroll({
        scrollTop: 0,
        clientHeight: 300,
        anchorTop: 0,
        anchorBottom: 30,
        revealTop: 30,
        revealBottom: 60,
        padding: 10
      })
    ).toBe(0)

    // Child below the fold: scroll just enough to bring its bottom edge in,
    // without pushing the parent row out of the viewport.
    expect(
      planRevealScroll({
        scrollTop: 0,
        clientHeight: 100,
        anchorTop: 60,
        anchorBottom: 90,
        revealTop: 90,
        revealBottom: 120,
        padding: 10
      })
    ).toBe(30)
  })

  it('prefers revealing the child when both rows cannot fit, but never scrolls the anchor away entirely', () => {
    // 60px viewport, padding 10: the anchor (0..30) and the child (90..120)
    // cannot both fit. Revealing the child needs 70; keeping the anchor's
    // bottom inside allows at most 20 — the anchor wins the residual.
    expect(
      planRevealScroll({
        scrollTop: 0,
        clientHeight: 60,
        anchorTop: 0,
        anchorBottom: 30,
        revealTop: 90,
        revealBottom: 120,
        padding: 10
      })
    ).toBe(20)
  })

  it('keeps the current offset when the viewport is not measured', () => {
    expect(
      planRevealScroll({
        scrollTop: 42,
        clientHeight: 0,
        anchorTop: 0,
        anchorBottom: 30,
        revealTop: 30,
        revealBottom: 60,
        padding: 10
      })
    ).toBe(42)
    expect(planScrollIntoView({ scrollTop: 42, clientHeight: 0, rowTop: 0, rowBottom: 30, padding: 10 })).toBe(42)
  })

  it('scrolls the current row into view minimally, in both directions', () => {
    // Above the viewport: align its top edge to the padding.
    expect(planScrollIntoView({ scrollTop: 100, clientHeight: 200, rowTop: 50, rowBottom: 80, padding: 10 })).toBe(40)
    // Below the viewport: align its bottom edge to the padding.
    expect(planScrollIntoView({ scrollTop: 0, clientHeight: 200, rowTop: 250, rowBottom: 280, padding: 10 })).toBe(90)
    // Already fully visible: no movement.
    expect(planScrollIntoView({ scrollTop: 0, clientHeight: 200, rowTop: 40, rowBottom: 70, padding: 10 })).toBe(0)
    // Never negative.
    expect(planScrollIntoView({ scrollTop: 4, clientHeight: 200, rowTop: 0, rowBottom: 30, padding: 10 })).toBe(0)
  })
})
