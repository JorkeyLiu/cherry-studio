import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import { describe, expect, it } from 'vitest'

import {
  buildNavGroupNodes,
  buildNavGroupRuns,
  NAV_GROUP_GUTTER_PX,
  NAV_GROUP_LANE_STEP_PX,
  NAV_GROUP_NODE_RADIUS_PX,
  NAV_GROUP_SPINE_OFFSET_PX,
  NAV_GROUP_TEXT_GAP_PX,
  snapGroupCoord,
  snapStrokeCoord
} from '../navGroupRuns'

const segment = (id: string, memberIds: string[], color?: string): RouteScopedSegment =>
  ({
    id,
    name: id,
    color,
    sortOrder: 0,
    memberIds,
    messageCount: memberIds.length,
    firstMessageId: memberIds[0] ?? null,
    headerMessageId: null,
    headerInRoute: false,
    headerOwnedByRoute: false,
    presentationStartMessageId: memberIds[0] ?? null
  }) as RouteScopedSegment

describe('buildNavGroupRuns', () => {
  it('maps user members to their own rows and assistant members to the preceding user row, deduped', () => {
    const runs = buildNavGroupRuns({
      rowIds: ['u1', 'u2', 'u3'],
      resolveRowId: (id) => ({ u1: 'u1', a1: 'u1', u2: 'u2', a2: 'u2' })[id],
      segments: [segment('g1', ['u1', 'a1', 'u2', 'a2'])]
    })
    expect(runs).toHaveLength(1)
    expect(runs[0].rowIds).toEqual(['u1', 'u2'])
    expect(runs[0].lane).toBe(0)
  })

  it('breaks a run on ordinary ungrouped rows and drops unresolvable members', () => {
    const runs = buildNavGroupRuns({
      rowIds: ['u1', 'u2', 'u3', 'u4'],
      resolveRowId: (id) => ({ u1: 'u1', u3: 'u3', u4: 'u4' })[id],
      segments: [segment('g1', ['u1', 'ghost', 'u3', 'u4'])]
    })
    // u2 sits between u1 and u3 with no membership: two runs, never bridged.
    expect(runs.map((run) => run.rowIds)).toEqual([['u1'], ['u3', 'u4']])
  })

  it('keeps segments with no reachable member out of the outline entirely', () => {
    const runs = buildNavGroupRuns({
      rowIds: ['u1', 'u2'],
      resolveRowId: () => undefined,
      segments: [segment('g1', ['ghost'])]
    })
    expect(runs).toEqual([])
  })

  it('paints the catalog color, falling back to the deterministic segment color', () => {
    const runs = buildNavGroupRuns({
      rowIds: ['u1'],
      resolveRowId: () => 'u1',
      segments: [segment('g1', ['u1'], 'rgb(1, 2, 3)'), segment('g2', ['u1'])]
    })
    expect(runs.map((run) => run.color)).toEqual(['rgb(1, 2, 3)', getSegmentColor('g2')])
  })

  it('assigns overlapping runs distinct deterministic lanes and shares lane 0 otherwise', () => {
    const runs = buildNavGroupRuns({
      rowIds: ['u1', 'u2', 'u3'],
      resolveRowId: (id) => ({ u1: 'u1', u2: 'u2', u3: 'u3' })[id],
      // g1 spans u1..u3, g2 sits inside it on u2: parallel lanes on u2.
      segments: [segment('g1', ['u1', 'u2', 'u3']), segment('g2', ['u2'])]
    })
    expect(runs).toHaveLength(2)
    expect(runs[0].rowIds).toEqual(['u1', 'u2', 'u3'])
    expect(runs[0].lane).toBe(0)
    expect(runs[1].rowIds).toEqual(['u2'])
    expect(runs[1].lane).toBe(1)
  })
})

describe('nav group geometry constants', () => {
  it('uses an 8px spine offset and a 6px text gap, gutter held at 18px, one 6px node ring', () => {
    // Lane-0 line sits one offset + one gap left of the row text; the text gap
    // stays 6px so each line lands 6px left of the row text and text starts
    // never move when the line shifts right. The 18px gutter is unchanged
    // (offset 8 + gap 6 = 14, 4px slack) so text starts stay stable. Every
    // node on a run — the ends and the interior rows — is the same r2.5
    // hollow ring under the group's 1px stroke, so each paints a 6px outer
    // node.
    expect(NAV_GROUP_SPINE_OFFSET_PX).toBe(8)
    expect(NAV_GROUP_TEXT_GAP_PX).toBe(6)
    expect(NAV_GROUP_GUTTER_PX).toBe(18)
    expect(NAV_GROUP_NODE_RADIUS_PX).toBe(2.5)
    expect(2 * NAV_GROUP_NODE_RADIUS_PX + 1).toBe(6)
  })

  it('snaps 1px-stroke coords to CSS n+0.5, never to an integer axis', () => {
    // An integer axis straddles two device rows and blurs the 1px spine; n+0.5
    // paints one crisp row. Floor-based: 4.0 -> 4.5, 4.2 -> 4.5, 4.7 -> 4.5.
    expect(snapStrokeCoord(4.0)).toBe(4.5)
    expect(snapStrokeCoord(4.2)).toBe(4.5)
    expect(snapStrokeCoord(4.7)).toBe(4.5)
    expect(snapStrokeCoord(10)).toBe(10.5)
    expect(snapGroupCoord(10)).toBe(10.5)
    for (const v of [0, 0.4, 3.5, 7.9, 12.5, 100.1]) {
      const s = snapStrokeCoord(v)
      expect(s - Math.floor(s)).toBe(0.5)
      expect(Math.abs(s - v)).toBeLessThanOrEqual(0.5)
    }
  })

  it('places the lane-0 line 8px + 6px left of the text with no hook pressing the text', () => {
    // textStart is the DOM row-text left edge; the lane-0 line sits one spine
    // offset + one text gap left of it, so the text gap stays stable.
    const textStart = 100.5
    const spineX = snapStrokeCoord(textStart - NAV_GROUP_TEXT_GAP_PX - NAV_GROUP_SPINE_OFFSET_PX)
    expect(spineX).toBe(86.5)
    expect(spineX + NAV_GROUP_SPINE_OFFSET_PX).toBe(textStart - NAV_GROUP_TEXT_GAP_PX)
    // Lane 1 steps one lane further left without moving the text.
    const lane1 = snapStrokeCoord(
      textStart - NAV_GROUP_TEXT_GAP_PX - NAV_GROUP_SPINE_OFFSET_PX - NAV_GROUP_LANE_STEP_PX
    )
    expect(lane1).toBe(spineX - NAV_GROUP_LANE_STEP_PX)
  })
})

describe('buildNavGroupNodes', () => {
  it('keeps the two ends on `nodes` and gives every interior row one node of its own', () => {
    // Three rows: one line joining first-to-last, the two ends still the only
    // `nodes`, and the N - 2 interior centers in `middleNodes` — the same
    // hollow node as the ends — so a middle row is never mistaken for an
    // endpoint.
    const { line, nodes, middleNodes } = buildNavGroupNodes([10.5, 20.5, 30.5])
    expect(line).toEqual({ y1: 10.5, y2: 30.5 })
    expect(nodes).toEqual([10.5, 30.5])
    expect(nodes).not.toContain(20.5)
    expect(middleNodes).toEqual([20.5])
    // Five rows: three interior nodes, still in outline order.
    expect(buildNavGroupNodes([10.5, 20.5, 30.5, 40.5, 50.5]).middleNodes).toEqual([20.5, 30.5, 40.5])
  })

  it('joins a two-row run first-to-last with no middle node', () => {
    const { line, nodes, middleNodes } = buildNavGroupNodes([10.5, 30.5])
    expect(line).toEqual({ y1: 10.5, y2: 30.5 })
    expect(nodes).toEqual([10.5, 30.5])
    // Two rows are exactly their two ends: no interior row, so no middle node.
    expect(middleNodes).toEqual([])
  })

  it('draws a single-row run as exactly one node with no line', () => {
    const { line, nodes, middleNodes } = buildNavGroupNodes([12.5])
    expect(line).toBeNull()
    expect(nodes).toEqual([12.5])
    expect(middleNodes).toEqual([])
  })

  it('draws nothing when no row resolves', () => {
    expect(buildNavGroupNodes([])).toEqual({ line: null, nodes: [], middleNodes: [] })
  })
})
