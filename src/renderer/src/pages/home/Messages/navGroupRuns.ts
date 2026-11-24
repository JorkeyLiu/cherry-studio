import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'

/**
 * Navigation group runs: the caller-local projection of topic-segment groups
 * onto the outline's user-turn rows.
 *
 * Each member resolves to its outline row through the caller's single
 * row-mapping (user messages are their own row, anything else maps to its
 * nearest preceding user row — the same resolver the reading-anchor
 * highlight and the fork markers share). Members that resolve to no row are
 * dropped; a row appears at most once per run.
 *
 * Runs are maximal contiguous row spans: an ordinary (ungrouped) row between
 * two grouped rows always breaks the span, so no run ever crosses a row that
 * belongs to no group. Group color follows the same rule the message flow
 * paints (`segment.color || getSegmentColor(segment.id)`).
 *
 * Lane assignment is deterministic interval coloring in segment order:
 * overlapping runs take distinct lanes, non-overlapping runs share lane 0.
 * This mirrors the message flow, where every group owns its own rail —
 * overlapping membership paints parallel rails instead of hiding a group.
 */
export interface NavGroupRun {
  segmentId: string
  color: string
  /** Contiguous user-row ids in outline order. Never empty. */
  rowIds: string[]
  /** Deterministic parallel lane for rows this run shares with other runs. */
  lane: number
}

/**
 * Group node-link geometry: each run is one 1px vertical line in the run's
 * group color joining the first/last row centers, with one small hollow node
 * (1px stroke, same group color) at each end. No horizontal hooks, no corner
 * arcs, no middle nodes; a single-row run is one node with no line. The lane-0
 * line sits one spine offset + one text gap left of the row text, deeper lanes
 * step further left in the rail's own whitespace and never touch the text.
 * The 18px gutter is the rail's own left whitespace reserved in the measured
 * width, never taken from text, so the line (offset 8 + gap 6 = 14 left of
 * text, 4px inside the gutter) is never clipped.
 */
export const NAV_GROUP_SPINE_OFFSET_PX = 8
/** Gap between the node-link line and the row text's left edge. */
export const NAV_GROUP_TEXT_GAP_PX = 6
/** Horizontal step between parallel lanes for overlapping runs. */
export const NAV_GROUP_LANE_STEP_PX = 6
/** Hollow node centerline radius: a 1px stroke paints a 6px outer node. */
export const NAV_GROUP_NODE_RADIUS_PX = 2.5
/** Extra measured panel width reserved while at least one run is drawn. */
export const NAV_GROUP_GUTTER_PX = 18

/**
 * Snap a 1px-stroke coordinate to CSS n+0.5 so a 1px line paints one crisp
 * device row instead of straddling two (integer-axis blur). Row-center Y may
 * sit up to 0.5px off the true center after the snap; that error is stable
 * across frames and DPR scaling keeps it inside half a CSS px at runtime.
 */
export const snapStrokeCoord = (value: number): number => Math.floor(value) + 0.5
/** Legacy alias: same n+0.5 snap (see `snapStrokeCoord`). */
export const snapGroupCoord = snapStrokeCoord

export function buildNavGroupRuns(input: {
  /** Outline row ids in display order. */
  rowIds: readonly string[]
  /** The caller's single member→row mapping; undefined means unresolvable. */
  resolveRowId: (messageId: string) => string | undefined
  /** Segments in deterministic order (route position, then catalog order). */
  segments: readonly RouteScopedSegment[]
}): NavGroupRun[] {
  const rowIndex = new Map<string, number>()
  input.rowIds.forEach((id, index) => {
    if (!rowIndex.has(id)) rowIndex.set(id, index)
  })
  const runs: NavGroupRun[] = []
  for (const segment of input.segments) {
    const seen = new Set<string>()
    const indices: number[] = []
    for (const memberId of segment.memberIds) {
      const rowId = input.resolveRowId(memberId)
      if (rowId === undefined || seen.has(rowId)) continue
      seen.add(rowId)
      const index = rowIndex.get(rowId)
      // A member resolving outside the outline (e.g. a folded-away row) ends
      // the current span rather than bridging across it.
      if (index === undefined) continue
      indices.push(index)
    }
    indices.sort((a, b) => a - b)
    let spanStart = -1
    let spanPrev = -1
    const flush = (end: number) => {
      if (spanStart < 0) return
      runs.push({
        segmentId: segment.id,
        color: segment.color || getSegmentColor(segment.id),
        rowIds: input.rowIds.slice(spanStart, end + 1),
        lane: 0
      })
      spanStart = -1
    }
    for (const index of indices) {
      if (spanStart < 0 || index !== spanPrev + 1) {
        flush(spanPrev)
        spanStart = index
      }
      spanPrev = index
    }
    flush(spanPrev)
  }
  // Deterministic interval coloring in run order: the smallest lane no
  // overlapping run already holds. Sort by run order (already segment order,
  // then span order) so a rebuild never flips lanes.
  const laneByRun = new Array<number>(runs.length).fill(0)
  const runStart = runs.map((run) => rowIndex.get(run.rowIds[0]) ?? -1)
  const runEnd = runs.map((run) => rowIndex.get(run.rowIds[run.rowIds.length - 1]) ?? -1)
  for (let i = 0; i < runs.length; i++) {
    const taken = new Set<number>()
    for (let j = 0; j < i; j++) {
      if (runStart[i] <= runEnd[j] && runStart[j] <= runEnd[i]) taken.add(laneByRun[j])
    }
    let lane = 0
    while (taken.has(lane)) lane += 1
    laneByRun[i] = lane
    runs[i].lane = lane
  }
  return runs
}

/**
 * Node-link endpoints for a run — pure geometry, no DOM.
 *
 * `centers` are the resolved row-center Y coordinates in outline order
 * (already snapped). A multi-row run joins first-to-last with one vertical
 * line and paints one hollow node at each end; a single-row run paints
 * exactly one node and no line; no run paints middle nodes and ungrouped
 * rows paint nothing. The caller draws the line center-to-center and paints
 * each node over it with the panel surface as fill, so the line never shows
 * through a hollow node.
 */
export function buildNavGroupNodes(centers: readonly number[]): {
  line: { y1: number; y2: number } | null
  nodes: number[]
} {
  if (centers.length === 0) return { line: null, nodes: [] }
  if (centers.length === 1) return { line: null, nodes: [centers[0]] }
  return {
    line: { y1: centers[0], y2: centers[centers.length - 1] },
    nodes: [centers[0], centers[centers.length - 1]]
  }
}
