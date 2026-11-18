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

  it('projects no group fold state (group fold is retired; fold is message-level)', () => {
    // A catalog row may still carry the legacy wire flag; the projection is a
    // structural view of the group and must not expose a fold state at all.
    const legacyFolded = seg('s-legacy-folded', 0, ['m5', 'm6'], { folded: true })
    const projected = projectSegmentsOntoRoute(MAIN, [legacyFolded])
    expect(projected).toHaveLength(1)
    expect(projected[0]).not.toHaveProperty('folded')
    expect(Object.keys(projected[0]).sort()).toEqual(
      [
        'firstMessageId',
        'headerInRoute',
        'headerMessageId',
        'headerOwnedByRoute',
        'id',
        'memberIds',
        'messageCount',
        'name',
        'presentationStartMessageId',
        'sortOrder'
      ].sort()
    )
  })

  it('carries the Main stable head and derives route authority from catalog metadata', () => {
    // Head from Main wins over the reachable first member; head presence is
    // read against the whole-route set. Owner equality compares the head
    // owner against the addressed route (topic AND branch).
    const group = seg('s-owned', 0, ['m5', 'm6'], {
      headerMessageId: 'm0',
      ownerTopicId: 'T',
      ownerBranchId: 'b-1'
    })
    const [onRoute] = projectSegmentsOntoRoute(['m0', 'm5', 'm6'], [group], { topicId: 'T', branchId: 'b-1' })
    expect(onRoute.headerMessageId).toBe('m0')
    expect(onRoute.headerInRoute).toBe(true)
    expect(onRoute.headerOwnedByRoute).toBe(true)
    // Same catalog, foreign route: head outside history, owner mismatch.
    const [offRoute] = projectSegmentsOntoRoute(['m5', 'm6'], [group], { topicId: 'T', branchId: 'b-9' })
    expect(offRoute.headerInRoute).toBe(false)
    expect(offRoute.headerOwnedByRoute).toBe(false)
  })

  it('falls back to the authority first member for legacy rows without a head', () => {
    const legacy = seg('s-legacy', 0, ['m5', 'm6'])
    const [projected] = projectSegmentsOntoRoute(MAIN, [legacy], { topicId: 'T', branchId: null })
    expect(projected.headerMessageId).toBe('m5')
    expect(projected.headerInRoute).toBe(true)
    // No owner metadata on a legacy row: fail-closed, never owned.
    expect(projected.headerOwnedByRoute).toBe(false)
  })

  it('lets a Main route block win verbatim over derivation (and ignores stale blocks)', () => {
    const group = seg('s-block', 0, ['m5'], {
      headerMessageId: 'm5',
      ownerTopicId: 'T',
      ownerBranchId: null
    })
    const routeMemberMessageIds = ['m5']
    const blocks = new Map([
      [
        's-block',
        { topicId: 'T', branchId: 'b-1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds }
      ]
    ])
    const [fromBlock] = projectSegmentsOntoRoute(['m5'], [group], { topicId: 'T', branchId: 'b-1', blocks })
    expect(fromBlock.headerOwnedByRoute).toBe(true)
    // Stale block (addressed to another route): derivation applies instead.
    const [stale] = projectSegmentsOntoRoute(['m5'], [group], { topicId: 'T', branchId: 'b-9', blocks })
    expect(stale.headerInRoute).toBe(true)
    expect(stale.headerOwnedByRoute).toBe(false)
  })

  it('returns an empty projection for an empty route or an empty catalog', () => {
    expect(projectSegmentsOntoRoute([], [seg('s', 0, ['m1'])])).toEqual([])
    expect(projectSegmentsOntoRoute(['m1'], [])).toEqual([])
  })

  it('pins the headed start to the stable head, never the window first member', () => {
    const group = seg('s-headed', 0, ['m0', 'm5', 'm6'], {
      headerMessageId: 'm0',
      ownerTopicId: 'T',
      ownerBranchId: null
    })
    const [onRoute] = projectSegmentsOntoRoute(['m0', 'm5', 'm6'], [group], { topicId: 'T', branchId: null })
    expect(onRoute.headerInRoute).toBe(true)
    expect(onRoute.presentationStartMessageId).toBe('m0')
  })

  it('pins the residual start to the route first reachable member when the head is off-route', () => {
    const group = seg('s-residual', 0, ['m6', 'm5'], {
      headerMessageId: 'm0',
      firstMessageId: 'm0',
      ownerTopicId: 'T',
      ownerBranchId: null
    })
    const [onRoute] = projectSegmentsOntoRoute(['m5', 'm6'], [group], { topicId: 'T', branchId: 'b-9' })
    expect(onRoute.headerInRoute).toBe(false)
    expect(onRoute.firstMessageId).toBe('m5')
    expect(onRoute.presentationStartMessageId).toBe('m5')
  })

  it('keeps per-route residual starts stable and independent across routes', () => {
    const group = seg('s-split', 0, ['m15', 'p2', 'c1'], {
      headerMessageId: 'm15',
      ownerTopicId: 'T',
      ownerBranchId: null
    })
    const [onP] = projectSegmentsOntoRoute(ROUTE_P, [group], { topicId: 'T', branchId: null })
    const [onC] = projectSegmentsOntoRoute(ROUTE_C, [group], { topicId: 'T', branchId: null })
    expect(onP.memberIds).toEqual(['m15', 'p2'])
    expect(onP.headerInRoute).toBe(true)
    expect(onP.presentationStartMessageId).toBe('m15')
    expect(onC.memberIds).toEqual(['m15', 'c1'])
    expect(onC.headerInRoute).toBe(true)
    expect(onC.presentationStartMessageId).toBe('m15')
    const suffix = seg('s-suffix', 0, ['p2', 'c1'], {
      headerMessageId: 'p2',
      firstMessageId: 'p2',
      ownerTopicId: 'T',
      ownerBranchId: null
    })
    const [suffixP] = projectSegmentsOntoRoute(ROUTE_P, [suffix], { topicId: 'T', branchId: null })
    const [suffixC] = projectSegmentsOntoRoute(ROUTE_C, [suffix], { topicId: 'T', branchId: null })
    expect(suffixP.presentationStartMessageId).toBe('p2')
    expect(suffixC.presentationStartMessageId).toBe('c1')
    expect(suffixC.headerInRoute).toBe(false)
  })

  it('keeps ONE normal-flow presentation start when a group crosses a fork inside its own span', () => {
    // Real cross-branch shape (see tests/e2e/diag/route-residual-midviewport):
    // the group's catalog head sits AFTER the fork point, so it is reachable on
    // the parent route only, while the shared prefix members are reachable on
    // both. The head keeps deciding identity/authority; the NORMAL-FLOW SLOT is
    // the group's route-first member, which is the SAME message on both routes —
    // so a route switch inside the group cannot move the group's 32px row.
    const crossing = seg('s-crossing', 0, ['p2', 'm14', 'm15'], {
      headerMessageId: 'p2',
      ownerTopicId: 'T',
      ownerBranchId: null
    })
    const [onParent] = projectSegmentsOntoRoute(ROUTE_P, [crossing], { topicId: 'T', branchId: null })
    const [onChild] = projectSegmentsOntoRoute(ROUTE_C, [crossing], { topicId: 'T', branchId: null })
    // Route order, never catalog order: the head is the LAST reachable on the parent.
    expect(onParent.memberIds).toEqual(['m14', 'm15', 'p2'])
    expect(onChild.memberIds).toEqual(['m14', 'm15'])
    // Identity/authority stay head-based and route-scoped.
    expect(onParent.headerMessageId).toBe('p2')
    expect(onParent.headerInRoute).toBe(true)
    expect(onChild.headerInRoute).toBe(false)
    // One route-stable slot for both routes.
    expect(onParent.presentationStartMessageId).toBe('m14')
    expect(onChild.presentationStartMessageId).toBe(onParent.presentationStartMessageId)
  })

  it('ignores a stale Main block when deriving the start (route-bound, never borrowed)', () => {
    const group = seg('s-stale-start', 0, ['m5'], {
      headerMessageId: 'm5',
      ownerTopicId: 'T',
      ownerBranchId: null
    })
    const blocks = new Map([
      [
        's-stale-start',
        { topicId: 'T', branchId: 'b-1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m5'] }
      ]
    ])
    const [stale] = projectSegmentsOntoRoute(['m5'], [group], { topicId: 'T', branchId: 'b-9', blocks })
    expect(stale.headerOwnedByRoute).toBe(false)
    expect(stale.presentationStartMessageId).toBe('m5')
  })

  describe('projectSegmentsOntoRoute turnCount', () => {
    // Route ids with their turn index: u1/a1 share turn 0, u2/a2 share turn 2,
    // sys is turn 3, u3 is turn 4, dangling-a is turn 5, orphan unmapped.
    const ROUTE = ['u1', 'a1', 'u2', 'a2', 'sys', 'u3', 'dangling-a', 'orphan']
    const TURNS = new Map<string, number>([
      ['u1', 0],
      ['a1', 0],
      ['u2', 2],
      ['a2', 2],
      ['sys', 3],
      ['u3', 4],
      ['dangling-a', 5]
    ])
    const project = (ids: string[], turnMap: ReadonlyMap<string, number> | undefined = TURNS) =>
      projectSegmentsOntoRoute(ROUTE, [seg('s', 0, ids)], undefined, turnMap)[0]

    it('counts user + same-askId answers as one turn, system and dangling as one each', () => {
      const projected = project(['u1', 'a1', 'u2', 'a2', 'sys', 'u3', 'dangling-a'])
      expect(projected.turnCount).toBe(5)
      expect(projected.messageCount).toBe(7)
    })

    it('counts only the route-reachable members of a residual group', () => {
      // u1/a1 live on another route here; only turns 2 and 3 stay reachable.
      expect(project(['u2', 'a2', 'sys']).turnCount).toBe(2)
    })

    it('excludes assistant messages without askId from the turn count', () => {
      expect(project(['u1', 'orphan']).turnCount).toBe(1)
      expect(project(['orphan']).turnCount).toBeUndefined()
    })

    it('leaves turnCount absent without a turn map (never the member count)', () => {
      const [projected] = projectSegmentsOntoRoute(ROUTE, [seg('s', 0, ['u1', 'a1', 'u2'])])
      expect('turnCount' in projected).toBe(false)
    })
  })
})
