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
    // The catalog array order itself is untouched by the route projection.
    expect(catalog.map((s) => s.id)).toEqual(['s-b', 's-a'])
    // On C, s-b intersects only m3 -> projected count differs but catalog count stays 2.
    expect(catalog[0].messageCount).toBe(2)
    expect(catalog[0].messageIds).toEqual(['p2', 'm3'])
  })

  it('orders groups by first reachable route position and preserves color only when present', () => {
    // Catalog order (sortOrder 0 first) is the reverse of route order (m3 before m5).
    const catalog = [seg('s-late', 1, ['m3']), seg('s-early', 0, ['m5'], { color: '#123456' })]
    const projected = projectSegmentsOntoRoute(MAIN, catalog)
    expect(projected.map((s) => s.id)).toEqual(['s-late', 's-early'])
    expect(projected[0].color).toBeUndefined()
    expect(projected[1].color).toBe('#123456')
    expect('color' in projected[0]).toBe(false)
  })

  it('reverses catalog creation order when the route positions run the other way', () => {
    // Created first (sortOrder 0) but it starts later on this route.
    const createdFirst = seg('s-created-first', 0, ['m12', 'm13'])
    const createdSecond = seg('s-created-second', 1, ['m2', 'm3'])
    expect(projectSegmentsOntoRoute(MAIN, [createdFirst, createdSecond]).map((s) => s.id)).toEqual([
      's-created-second',
      's-created-first'
    ])
    // Same catalog, unchanged by the projection.
    expect([createdFirst.id, createdSecond.id]).toEqual(['s-created-first', 's-created-second'])
  })

  it('orders a branch route by the first REACHABLE member when the catalog first member is off-route', () => {
    // s-off-head's catalog member order starts with the parent-only p2 (not on C);
    // its reachable intersection starts at m15, still before c1 on C.
    const offHead = seg('s-off-head', 1, ['p2', 'm15'])
    const childTail = seg('s-child-tail', 0, ['c1'])
    const onC = projectSegmentsOntoRoute(ROUTE_C, [childTail, offHead])
    expect(onC.map((s) => s.id)).toEqual(['s-off-head', 's-child-tail'])
    expect(onC[0].firstMessageId).toBe('m15')
    expect(onC[0].memberIds).toEqual(['m15'])
    // On the parent route both members are reachable; the intersection is still
    // ordered by the route (m15 before p2), never by the catalog member order.
    const onP = projectSegmentsOntoRoute(ROUTE_P, [childTail, offHead])
    expect(onP.map((s) => s.id)).toEqual(['s-off-head'])
    expect(onP[0].memberIds).toEqual(['m15', 'p2'])
    expect(onP[0].firstMessageId).toBe('m15')
  })

  it('orders by route position even when membership was inserted out of route order', () => {
    // s-inserted-first was authored with m20 before m8; the route starts at m8.
    const insertedFirst = seg('s-inserted-first', 0, ['m20', 'm8'])
    const insertedSecond = seg('s-inserted-second', 1, ['m4'])
    const projected = projectSegmentsOntoRoute(MAIN, [insertedFirst, insertedSecond])
    expect(projected.map((s) => s.id)).toEqual(['s-inserted-second', 's-inserted-first'])
    expect(projected[1].memberIds).toEqual(['m8', 'm20'])
    expect(projected[1].firstMessageId).toBe('m8')
  })

  it('breaks equal route positions deterministically by catalog sortOrder then id', () => {
    // Overlapping groups that all start at m7: position ties resolve by
    // sortOrder (s-b/s-c at 1) and then id (s-b before s-c), s-a last.
    const a = seg('s-a', 2, ['m7', 'm9'])
    const b = seg('s-b', 1, ['m7', 'm10'])
    const c = seg('s-c', 1, ['m7'])
    for (const input of [
      [a, b, c],
      [c, a, b],
      [b, c, a]
    ]) {
      expect(projectSegmentsOntoRoute(MAIN, input).map((s) => s.id)).toEqual(['s-b', 's-c', 's-a'])
    }
  })

  it('returns an empty projection for an empty route or an empty catalog', () => {
    expect(projectSegmentsOntoRoute([], [seg('s', 0, ['m1'])])).toEqual([])
    expect(projectSegmentsOntoRoute(['m1'], [])).toEqual([])
  })
})
