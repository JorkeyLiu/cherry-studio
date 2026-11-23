import { describe, expect, it } from 'vitest'

import { projectCommittedChromeFromStructure } from '../routeCommittedChrome'

function wire(id: string, mids: string[], sortOrder = 0) {
  return {
    id,
    topicId: 't1',
    name: `g-${id}`,
    messageIds: mids,
    headerMessageId: mids.length > 0 ? mids[0] : null,
    ownerTopicId: 't1',
    ownerBranchId: null,
    createdAt: null,
    updatedAt: null,
    sortOrder,
    firstMessageId: mids.length > 0 ? mids[0] : null,
    lastMessageId: mids.length > 0 ? mids[mids.length - 1] : null,
    messageCount: mids.length
  }
}

describe('projectCommittedChromeFromStructure (bundled receipt)', () => {
  it('projects neutral catalog plus qualifications in catalog order with route-effective members', () => {
    const structure = {
      catalog: [wire('s1', ['m1', 'm2']), wire('s2', ['m3'])],
      route: {
        topicId: 't1',
        branchId: null,
        qualifications: [
          { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m2'] },
          { segmentId: 's2', headerInRoute: false, headerOwnedByRoute: false, routeMemberMessageIds: [] }
        ]
      }
    } as any
    const projected = projectCommittedChromeFromStructure({ topicId: 't1', branchId: null, structure })
    expect(projected).not.toBeNull()
    // Only groups with reachable members survive; catalog order preserved.
    expect(projected!.routeKey).toBe('t1::main')
    expect(projected!.segments.map((s) => s.id)).toEqual(['s1'])
    expect(projected!.segments[0].memberIds).toEqual(['m2'])
    expect(projected!.segments[0].headerMessageId).toBe('m1')
    expect(projected!.segments[0].headerInRoute).toBe(true)
  })

  it('fail-closed on route echo mismatch (never projects another route)', () => {
    const structure = {
      catalog: [wire('s1', ['m1'])],
      route: {
        topicId: 't1',
        branchId: 'b-other',
        qualifications: [
          { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: false, routeMemberMessageIds: ['m1'] }
        ]
      }
    } as any
    expect(projectCommittedChromeFromStructure({ topicId: 't1', branchId: null, structure })).toBeNull()
    expect(projectCommittedChromeFromStructure({ topicId: 'other', branchId: null, structure })).toBeNull()
  })

  it('fail-closed on branch echo mismatch (caller guard pairs structure with the requested route)', () => {
    // The shared result validator has no request context for the branch echo;
    // this projection is the guard that refuses to publish another route's
    // structure under the requested address.
    const onBranch = {
      catalog: [wire('s1', ['m1'])],
      route: {
        topicId: 't1',
        branchId: 'b1',
        qualifications: [
          { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] }
        ]
      }
    } as any
    expect(projectCommittedChromeFromStructure({ topicId: 't1', branchId: null, structure: onBranch })).toBeNull()
    expect(projectCommittedChromeFromStructure({ topicId: 't1', branchId: 'b-other', structure: onBranch })).toBeNull()
    expect(projectCommittedChromeFromStructure({ topicId: 't1', branchId: 'b1', structure: onBranch })).not.toBeNull()
  })
  it('empty catalog and empty projection return null (caller applies same-route clear)', () => {
    const empty = { catalog: [], route: { topicId: 't1', branchId: null, qualifications: [] } } as any
    expect(projectCommittedChromeFromStructure({ topicId: 't1', branchId: null, structure: empty })).toBeNull()
    const noReachable = {
      catalog: [wire('s1', ['m1'])],
      route: {
        topicId: 't1',
        branchId: null,
        qualifications: [
          { segmentId: 's1', headerInRoute: false, headerOwnedByRoute: false, routeMemberMessageIds: [] }
        ]
      }
    } as any
    expect(projectCommittedChromeFromStructure({ topicId: 't1', branchId: null, structure: noReachable })).toBeNull()
  })
})
