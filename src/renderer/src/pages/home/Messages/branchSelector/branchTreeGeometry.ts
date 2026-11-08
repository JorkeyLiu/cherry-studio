/**
 * Branch-tree connector geometry (pure).
 *
 * Input is DOM-measured row geometry: each row's centre y, the expansion
 * arrow slot's centre x, and the slot's left/right edges. Output is a set of
 * `<path d>` strings plus the axis-aligned segments they were built from.
 *
 * The slot's centre (`pivotX`) is both the row's visual anchor and the pivot
 * of every connector: the trunk drops under the parent's arrow, the elbow
 * turns on that centre, and the leg ends on the child's centre. The drawn
 * position is never shifted off the column's centre to dodge a glyph; when a
 * row does draw an arrow, the renderer cuts that glyph's box out of the line
 * (see `glyphCuts`) without moving the arrow, the indent, or a turning point,
 * and without painting anything behind the arrow.
 *
 * Coordinate space: the positioned content container's top-left is (0, 0),
 * unit px. Connectors are always orthogonal with small rounded corners.
 */

export type BranchGeoNode = {
  id: string
  parentId: string | null
  depth: number
  /** Row centre y. */
  centerY: number
  /** Expansion arrow slot centre x — the row's visual anchor and connector pivot. */
  pivotX: number
  /** Expansion arrow slot left edge x. */
  slotLeft: number
  /** Expansion arrow slot right edge x (the name column starts here). */
  slotRight: number
  /** The row draws an expansion arrow (its catalog node has children). */
  expandable: boolean
}

export type GeoPoint = { x: number; y: number }

export type GeoSegment = {
  axis: 'v' | 'h'
  x1: number
  y1: number
  x2: number
  y2: number
  kind: 'trunk' | 'stub' | 'active'
  parentId?: string
  childId?: string
}

export type GeoBox = {
  /** Left edge x, in the content container's coordinate space. */
  x: number
  /** Top edge y. */
  y: number
  width: number
  height: number
}

export type GeoOptions = {
  /** Corner radius for right-angle turns. */
  radius: number
  /** How far below the parent row's centre the trunk starts (clears the arrow). */
  tail: number
  /**
   * Side of the square expansion-arrow glyph, centred in its chevron slot.
   *
   * The glyph is the one thing a connector must never cross, and it is centred
   * on the slot's centre — which is exactly where the connectors pivot, so the
   * line behind it is cut by the renderer instead of the geometry moving.
   */
  glyphSize: number
  /** Extra room kept on every side of that glyph, so no line touches its ink. */
  glyphClearance: number
}

export type BranchTreeGeometry = {
  /** Neutral edges: one "shared trunk + last-child corner" path per parent, plus a stub per non-last child. */
  grey: string[]
  /** The current root → current node route as one continuous path ('' when shorter than two rows). */
  active: string
  /** Turn points of the active path, root-first. */
  turns: GeoPoint[]
  start: GeoPoint | null
  /** Where the route ends, measured: the terminal row's column centre. */
  end: GeoPoint | null
  /**
   * Where the endpoint dot may be drawn: the same point as `end`, but only on
   * a terminal row that draws no expansion arrow (a leaf).
   *
   * The dot lives outside the connector mask so an endpoint is still visible,
   * which also means a dot on an arrow row would sit on top of its glyph. The
   * row that carries an arrow already says "this is the current branch" with
   * its green name and current badge, so the dot is only ever added where the
   * arrow column is empty: `null` for an expandable endpoint, whether the fork
   * is expanded or collapsed, and for the root.
   */
  endDot: GeoPoint | null
  /** Node ids on the drawn active route (root → current), a contiguous rendered ancestor chain. */
  chain: string[]
  /** Pre-rounding axis-aligned segments, for geometry assertions. */
  greySegments: GeoSegment[]
  activeSegments: GeoSegment[]
  /**
   * Boxes the SVG layer must keep clear of ink: one per rendered row that
   * draws an expansion arrow (`expandable`), i.e. the glyph box grown by
   * `glyphClearance`. A leaf row draws no arrow and gets no box, so a line is
   * never cut where there is nothing to cut around.
   */
  glyphCuts: GeoBox[]
  /** Stable identity of the drawn geometry; equal signatures mean "do not re-render". */
  signature: string
}

const EPSILON = 0.01
const round2 = (n: number): number => Math.round(n * 100) / 100
const near = (a: number, b: number): boolean => Math.abs(a - b) < EPSILON

/** Renders a polyline as a path with small rounded right-angle corners (Q), never diagonals. */
export function cornerPath(vertices: GeoPoint[], radius: number): string {
  if (vertices.length === 0) return ''
  const out: string[] = [`M ${round2(vertices[0].x)} ${round2(vertices[0].y)}`]

  for (let i = 1; i < vertices.length; i += 1) {
    const current = vertices[i]
    const lineTo = (): number => out.push(`L ${round2(current.x)} ${round2(current.y)}`)

    if (i === vertices.length - 1) {
      lineTo()
      continue
    }

    const previous = vertices[i - 1]
    const next = vertices[i + 1]
    const straightThrough =
      (near(previous.x, current.x) && near(current.x, next.x)) ||
      (near(previous.y, current.y) && near(current.y, next.y))
    if (straightThrough) {
      lineTo()
      continue
    }

    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y)
    const outLength = Math.hypot(next.x - current.x, next.y - current.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)
    if (!(r > 0.5)) {
      lineTo()
      continue
    }

    const inPoint = {
      x: current.x + ((previous.x - current.x) / inLength) * r,
      y: current.y + ((previous.y - current.y) / inLength) * r
    }
    const outPoint = {
      x: current.x + ((next.x - current.x) / outLength) * r,
      y: current.y + ((next.y - current.y) / outLength) * r
    }
    out.push(`L ${round2(inPoint.x)} ${round2(inPoint.y)}`)
    out.push(`Q ${round2(current.x)} ${round2(current.y)} ${round2(outPoint.x)} ${round2(outPoint.y)}`)
  }

  return out.join(' ')
}

/**
 * Connectors for the rendered rows.
 *
 * `pathIds` is the current route root-first (root node id first). The active
 * line is emitted only while every node on it is rendered and parent-child
 * contiguous, so a collapsed ancestor naturally truncates the highlight.
 */
export function buildBranchTreeGeometry(
  nodes: BranchGeoNode[],
  pathIds: string[],
  options: GeoOptions
): BranchTreeGeometry {
  const byId = new Map<string, BranchGeoNode>()
  const order = new Map<string, number>()
  nodes.forEach((node, index) => {
    byId.set(node.id, node)
    order.set(node.id, index)
  })

  const childrenOf = new Map<string, BranchGeoNode[]>()
  nodes.forEach((node) => {
    if (!node.parentId || !byId.has(node.parentId)) return
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node)
    childrenOf.set(node.parentId, list)
  })
  childrenOf.forEach((list) => list.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)))

  const grey: string[] = []
  const greySegments: GeoSegment[] = []

  for (const parent of nodes) {
    const kids = childrenOf.get(parent.id) ?? []
    if (kids.length === 0) continue

    const trunkX = parent.pivotX
    const top = parent.centerY + options.tail
    const last = kids[kids.length - 1]
    const lastPivot = last.pivotX
    const runX = lastPivot - trunkX
    const dropY = last.centerY - top

    if (runX > 0.5 && dropY > 0.5) {
      // Shared trunk: from just below the parent's arrow down to the last direct
      // child, then a rounded corner into that row's centre.
      const radius = Math.min(options.radius, runX / 2, dropY / 2)
      grey.push(
        cornerPath(
          [
            { x: trunkX, y: top },
            { x: trunkX, y: last.centerY },
            { x: lastPivot, y: last.centerY }
          ],
          radius
        )
      )
      greySegments.push({
        axis: 'v',
        x1: trunkX,
        y1: top,
        x2: trunkX,
        y2: last.centerY,
        kind: 'trunk',
        parentId: parent.id
      })
    }

    for (const kid of kids) {
      const kidPivot = kid.pivotX
      if (kidPivot - trunkX <= 0.5) continue
      greySegments.push({
        axis: 'h',
        x1: trunkX,
        y1: kid.centerY,
        x2: kidPivot,
        y2: kid.centerY,
        kind: 'stub',
        parentId: parent.id,
        childId: kid.id
      })
      // The last child's horizontal run is already part of the trunk's corner.
      if (kid === last) continue
      grey.push(`M ${round2(trunkX)} ${round2(kid.centerY)} L ${round2(kidPivot)} ${round2(kid.centerY)}`)
    }
  }

  // Active route: must be a rendered, parent-child contiguous ancestor chain;
  // stop at the first break so a collapsed tree simply drops the highlight.
  const chain: BranchGeoNode[] = []
  for (const id of pathIds) {
    const node = byId.get(id)
    if (!node) break
    const previous = chain[chain.length - 1]
    if (previous && node.parentId !== previous.id) break
    chain.push(node)
  }

  const activeSegments: GeoSegment[] = []
  const turns: GeoPoint[] = []
  const vertices: GeoPoint[] = []
  const start =
    chain.length > 0 ? { x: chain[0].pivotX, y: chain[0].centerY + (chain.length > 1 ? options.tail : 0) } : null
  const end = chain.length > 0 ? { x: chain[chain.length - 1].pivotX, y: chain[chain.length - 1].centerY } : null
  // The endpoint dot shares the drawn endpoint, but only when that row leaves
  // its arrow column empty: an expandable row (root included, expanded or
  // collapsed) keeps the column for its glyph and marks currency elsewhere.
  const endDot = end && chain.length > 0 && !chain[chain.length - 1].expandable ? end : null

  if (chain.length > 1) {
    vertices.push({ x: chain[0].pivotX, y: chain[0].centerY + options.tail })
    for (let i = 1; i < chain.length; i += 1) {
      const parent = chain[i - 1]
      const node = chain[i]
      const parentPivot = parent.pivotX
      const nodePivot = node.pivotX
      // The turn stays on the parent's centre and the leg runs across to the
      // child's centre: no turning point and no leg is shifted off a column to
      // dodge an arrow. The leg does cross an intermediate chain row's glyph,
      // so the renderer cuts exactly that glyph's box out of the line.
      vertices.push({ x: parentPivot, y: node.centerY })
      turns.push({ x: parentPivot, y: node.centerY })
      vertices.push({ x: nodePivot, y: node.centerY })

      activeSegments.push({
        axis: 'v',
        x1: parentPivot,
        y1: i === 1 ? chain[0].centerY + options.tail : parent.centerY,
        x2: parentPivot,
        y2: node.centerY,
        kind: 'active',
        parentId: parent.id,
        childId: node.id
      })
      activeSegments.push({
        axis: 'h',
        x1: parentPivot,
        y1: node.centerY,
        x2: nodePivot,
        y2: node.centerY,
        kind: 'active',
        parentId: parent.id,
        childId: node.id
      })
    }
  }

  // The arrow keeps its slot, its indent and its neutral colour: where a row
  // draws one, the line behind it is cut away here and the renderer subtracts
  // exactly these boxes — nothing is rerouted and nothing is painted behind it.
  const cutSize = options.glyphSize + options.glyphClearance * 2
  const glyphCuts: GeoBox[] = []
  for (const node of nodes) {
    // A leaf renders an empty slot, not an arrow: a cut there would punch a
    // hole in a line that crosses nothing.
    if (!node.expandable) continue
    glyphCuts.push({
      x: round2(node.pivotX - cutSize / 2),
      y: round2(node.centerY - cutSize / 2),
      width: round2(cutSize),
      height: round2(cutSize)
    })
  }

  const active = vertices.length > 1 ? cornerPath(vertices, options.radius) : ''
  const signature = JSON.stringify({
    g: grey,
    a: active,
    t: turns.map((point) => [round2(point.x), round2(point.y)]),
    c: glyphCuts,
    e: end ? [round2(end.x), round2(end.y)] : null,
    d: endDot ? [round2(endDot.x), round2(endDot.y)] : null
  })

  return {
    grey,
    active,
    turns,
    start,
    end,
    endDot,
    chain: chain.map((node) => node.id),
    greySegments,
    activeSegments,
    glyphCuts,
    signature
  }
}

export type RevealScrollInput = {
  /** Current scroll offset of the list viewport. */
  scrollTop: number
  /** Visible height of the list viewport. */
  clientHeight: number
  /** Top edge of the row that must stay visible (the row the user expanded). */
  anchorTop: number
  /** Bottom edge of that anchor row. */
  anchorBottom: number
  /** Top edge of the newly revealed row. */
  revealTop: number
  /** Bottom edge of the newly revealed row. */
  revealBottom: number
  /** Breathing room kept above/below a revealed row. */
  padding: number
}

/**
 * Minimal scroll offset that reveals a newly expanded child row while doing as
 * much as possible to keep the row the user acted on on screen. When both rows
 * cannot fit, the revealed child wins unless that would push the anchor row out
 * of the viewport entirely.
 *
 * Pure: row edges arrive in the scroll content's coordinate space, so the
 * caller's measurements are the only input and the plan is directly assertable.
 */
export function planRevealScroll(input: RevealScrollInput): number {
  const { scrollTop, clientHeight, anchorTop, anchorBottom, revealTop, revealBottom, padding } = input
  if (!(clientHeight > 0)) return scrollTop

  const viewportTop = scrollTop + padding
  const viewportBottom = scrollTop + clientHeight - padding
  const revealed = revealTop >= viewportTop && revealBottom <= viewportBottom
  const anchorVisible = anchorTop >= viewportTop && anchorBottom <= viewportBottom
  if (revealed && anchorVisible) return scrollTop

  // Offset that puts the revealed row's bottom edge inside the viewport.
  const revealLimit = revealBottom + padding - clientHeight
  // Offset beyond which the anchor row's bottom edge would leave the viewport.
  const anchorBottomLimit = anchorBottom - padding

  if (revealLimit <= anchorTop - padding) {
    // Both rows fit: satisfy both, minimally.
    const lower = Math.max(0, revealLimit)
    const upper = Math.max(0, anchorTop - padding)
    return Math.min(upper, Math.max(lower, scrollTop))
  }

  // Not enough room for both: reveal the child, but never scroll the anchor row
  // completely out of the viewport.
  return Math.max(0, Math.min(Math.max(0, revealLimit), Math.max(0, anchorBottomLimit)))
}

export type ScrollIntoViewInput = {
  scrollTop: number
  clientHeight: number
  /** Row edges relative to the scroll content's top. */
  rowTop: number
  rowBottom: number
  /** Breathing room kept above/below the row. */
  padding: number
}

/**
 * Minimal scroll offset that brings one row fully inside the viewport, moving
 * only as far as needed and never past its own bounds. A degenerate viewport
 * (unmeasured) keeps the current offset.
 */
export function planScrollIntoView(input: ScrollIntoViewInput): number {
  const { scrollTop, clientHeight, rowTop, rowBottom, padding } = input
  if (!(clientHeight > 0)) return scrollTop
  if (rowTop < scrollTop + padding) return Math.max(0, rowTop - padding)
  if (rowBottom > scrollTop + clientHeight - padding) {
    return Math.max(0, rowBottom - clientHeight + padding)
  }
  return scrollTop
}
