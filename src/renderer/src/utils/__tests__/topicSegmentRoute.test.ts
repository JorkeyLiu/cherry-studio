import type { TopicSegment } from '@renderer/types/topicSegment'
import { describe, expect, it } from 'vitest'

import { projectSegmentsOntoRoute } from '../topicSegmentRoute'

function seg(id: string, sortOrder: number, messageIds: string[], extra: Partial<TopicSegment> = {}): TopicSegment {
  return {
    id,
    topicId: 'T',
    name: id,
    messageIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    messageCount: messageIds.length,
    ...extra
  }
}

// Route topology mirroring the child-route-leak scenario:
//   main: m0..m29
//   P (parent, forked at m15): m0..m15, p1, p2
//   C (child, forked at P-owned p1): m0..m15, p1, c1
const MAIN = Array.from({ length: 30 }, (_, i) => `m${i}`)
const ROUTE_P = [...MAIN.slice(0, 16), 'p1', 'p2']
const ROUTE_C = [...MAIN.slice(0, 16), 'p1', 'c1']

describe('projectSegmentsOntoRoute', () => {
  it('hides a segment whose only member lives on another route (child isolation)', () => {
    // Parent-only suffix member p2 after the child fork anchor is not on C.
    const parentOnly = seg('s-parent-only', 0, ['p2'])
    expect(projectSegmentsOntoRoute(ROUTE_P, [parentOnly]).map((s) => s.id)).toEqual(['s-parent-only'])
    expect(projectSegmentsOntoRoute(ROUTE_C, [parentOnly])).toEqual([])
  })

  it('preserves a legal ancestor-prefix segment with its full reachable count', () => {
    const prefix = seg('s-prefix', 0, ['m5', 'm6'])
    for (const route of [ROUTE_P, ROUTE_C, MAIN]) {
      const [projected] = projectSegmentsOntoRoute(route, [prefix])
      expect(projected.id).toBe('s-prefix')
      expect(projected.memberIds).toEqual(['m5', 'm6'])
      expect(projected.messageCount).toBe(2)
      expect(projected.firstMessageId).toBe('m5')
    }
  })

  it('excludes a sibling-route segment (no member on the addressed route)', () => {
    const sibling = seg('s-sibling', 0, ['x1', 'x2'])
    expect(projectSegmentsOntoRoute(ROUTE_C, [sibling])).toEqual([])
  })

  it('projects a cross-anchor segment onto the reachable intersection with a reachable first', () => {
    // Spans the child fork boundary: prefix m14/m15, inherited p1, parent-only p2.
    const cross = seg('s-cross', 0, ['m14', 'm15', 'p1', 'p2'])
    const onP = projectSegmentsOntoRoute(ROUTE_P, [cross])[0]
    expect(onP.memberIds).toEqual(['m14', 'm15', 'p1', 'p2'])
    expect(onP.messageCount).toBe(4)
    expect(onP.firstMessageId).toBe('m14')

    const onC = projectSegmentsOntoRoute(ROUTE_C, [cross])[0]
    // p2 is unreachable on C and is dropped; count = intersection.
    expect(onC.memberIds).toEqual(['m14', 'm15', 'p1'])
    expect(onC.messageCount).toBe(3)
    expect(onC.firstMessageId).toBe('m14')
    expect(onC.memberIds).not.toContain('p2')
  })

  it('takes the reachable first member when the segment array head is not on the route', () => {
    // Segment array head is unreachable on either route; only the parent-owned
    // suffix member (p2) is reachable, and only on P — never on C.
    const parentSuffix = seg('s-parent-suffix', 0, ['x-unreachable', 'p2'])
    expect(projectSegmentsOntoRoute(ROUTE_C, [parentSuffix])).toEqual([])
    const onP = projectSegmentsOntoRoute(ROUTE_P, [parentSuffix])[0]
    expect(onP.memberIds).toEqual(['p2'])
    expect(onP.firstMessageId).toBe('p2')
    expect(onP.messageCount).toBe(1)
  })

  it('projects members in effective-route order, not the catalog member order', () => {
    // Catalog array order is descending; route order is ascending.
    const reversed = seg('s-rev', 0, ['m6', 'm5', 'm4'])
    const [projected] = projectSegmentsOntoRoute([...MAIN], [reversed])
    expect(projected.memberIds).toEqual(['m4', 'm5', 'm6'])
    expect(projected.firstMessageId).toBe('m4')
  })

  it('keeps a member that is outside any loaded window (off-screen reachability)', () => {
    // Route ids are the whole-route read; m0 is never in a tail window.
    const offScreen = seg('s-offscreen', 0, ['m0'])
    const [projected] = projectSegmentsOntoRoute(ROUTE_C, [offScreen])
    expect(projected.firstMessageId).toBe('m0')
    expect(projected.messageCount).toBe(1)
  })

  it('never mutates the input catalog (order, members, counts, boundaries untouched)', () => {
    const catalog = [
      seg('s-b', 0, ['p2', 'm3'], { firstMessageId: 'p2', lastMessageId: 'm3', messageCount: 2, color: '#abc' }),
      seg('s-a', 1, ['m5'], { firstMessageId: 'm5', lastMessageId: 'm5', messageCount: 1 })
    ]
    const snapshot = JSON.parse(JSON.stringify(catalog))
    projectSegmentsOntoRoute(ROUTE_C, catalog)
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(snapshot)
    // On C, s-b intersects only m3 -> projected count differs but catalog count stays 2.
    expect(catalog[0].messageCount).toBe(2)
    expect(catalog[0].messageIds).toEqual(['p2', 'm3'])
  })

  it('returns authority order and preserves color only when present', () => {
    const catalog = [seg('s-late', 1, ['m3']), seg('s-early', 0, ['m5'], { color: '#123456' })]
    const projected = projectSegmentsOntoRoute(MAIN, catalog)
    expect(projected.map((s) => s.id)).toEqual(['s-early', 's-late'])
    expect(projected[0].color).toBe('#123456')
    expect('color' in projected[1]).toBe(false)
  })

  it('returns an empty projection for an empty route or an empty catalog', () => {
    expect(projectSegmentsOntoRoute([], [seg('s', 0, ['m1'])])).toEqual([])
    expect(projectSegmentsOntoRoute(['m1'], [])).toEqual([])
  })
})
