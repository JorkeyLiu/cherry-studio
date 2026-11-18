import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockListSegments } = vi.hoisted(() => ({ mockListSegments: vi.fn() }))

vi.mock('@renderer/services/db', () => ({
  dbService: { listSegments: (...args: unknown[]) => mockListSegments(...args) }
}))

import type { TopicSegment } from '@renderer/types/topicSegment'
import type { SegmentRouteQualification, SegmentWire } from '@shared/chatDb'

import {
  committedChromeRouteKey,
  fetchRouteChromeWires,
  projectCommittedChromeSegments,
  selectOrderedSegmentsForTopic,
  type TopicSegmentCatalogState
} from '../routeCommittedChrome'
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

function block(
  topicId: string,
  branchId: string | null,
  members: string[],
  extra: Partial<SegmentRouteQualification> = {}
): SegmentRouteQualification {
  return { topicId, branchId, headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: members, ...extra }
}

function wire(
  id: string,
  messageIds: string[],
  route: SegmentRouteQualification | undefined,
  extra: Partial<SegmentWire & TopicSegment> = {}
): SegmentWire {
  return {
    id,
    topicId: 'T',
    name: id,
    messageIds,
    headerMessageId: messageIds[0] ?? null,
    ownerTopicId: 'T',
    ownerBranchId: null,
    ...(route ? { route } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder: 0,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    messageCount: messageIds.length,
    ...extra
  } as SegmentWire
}

function catalogState(topicId: string, segments: TopicSegment[]): TopicSegmentCatalogState {
  const entities: Record<string, TopicSegment | undefined> = {}
  for (const s of segments) entities[s.id] = s
  return { topicSegments: { segments: { entities }, segmentsByTopic: { [topicId]: segments.map((s) => s.id) } } }
}

describe('committedChromeRouteKey', () => {
  it('keys null branch as main', () => {
    expect(committedChromeRouteKey('T', null)).toBe('T::main')
    expect(committedChromeRouteKey('T', 'b')).toBe('T::b')
  })
})

describe('selectOrderedSegmentsForTopic', () => {
  it('orders by Main sortOrder ascending with a stable id tie-break', () => {
    const state = catalogState('T', [seg('s-b', 1, ['m1']), seg('s-a', 0, ['m2']), seg('s-c', 0, ['m3'])])
    expect(selectOrderedSegmentsForTopic(state, 'T').map((s) => s.id)).toEqual(['s-a', 's-c', 's-b'])
  })

  it('skips catalog ids without an entity and unknown topics', () => {
    const state = catalogState('T', [seg('s-a', 0, ['m1'])])
    state.topicSegments.segmentsByTopic['T'] = ['s-a', 's-gone']
    expect(selectOrderedSegmentsForTopic(state, 'T').map((s) => s.id)).toEqual(['s-a'])
    expect(selectOrderedSegmentsForTopic(state, 'nope')).toEqual([])
  })
})

describe('projectCommittedChromeSegments', () => {
  const ROUTE = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']

  it('returns null for an empty catalog or empty wires', () => {
    expect(projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog: [], wires: [] })).toBeNull()
    const catalog = [seg('s', 0, ['m1'])]
    expect(projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires: [] })).toBeNull()
    expect(
      projectCommittedChromeSegments({
        topicId: 'T',
        branchId: null,
        catalog: [],
        wires: [wire('s', ['m1'], undefined)]
      })
    ).toBeNull()
  })

  it('omits a group whose wire block addresses another route (stale cache, never borrowed)', () => {
    const catalog = [seg('s-stale', 0, ['m1'], { headerMessageId: 'm1' })]
    const wires = [wire('s-stale', ['m1'], block('T', 'other-branch', ['m1']))]
    expect(projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })).toBeNull()
  })

  it('omits a catalog-only group and an unqualified wire (catalog membership never impersonates)', () => {
    const catalog = [
      seg('s-catalog-only', 0, ['m1'], { headerMessageId: 'm1' }),
      seg('s-unqualified', 1, ['m2'], { headerMessageId: 'm2' })
    ]
    const wires = [wire('s-unqualified', ['m2'], undefined)]
    expect(projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })).toBeNull()
  })

  it('omits a group with zero reachable members, and returns null when all are omitted', () => {
    const catalog = [seg('s-empty', 0, ['m1'], { headerMessageId: 'm1' })]
    const wires = [wire('s-empty', ['m1'], { ...block('T', null, []), headerInRoute: false })]
    expect(projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })).toBeNull()
  })
  it('publishes the target-only head with a stable start, distinct from a residual start', () => {
    const catalog = [
      seg('s-head', 0, ['m1', 'm2'], { headerMessageId: 'm1' }),
      seg('s-residual', 1, ['m4', 'm6'], { headerMessageId: 'x-off' })
    ]
    const wires = [
      wire('s-head', ['m1', 'm2'], block('T', null, ['m1', 'm2'])),
      wire('s-residual', ['m4', 'm6'], { ...block('T', null, ['m4', 'm6']), headerInRoute: false })
    ]
    const projected = projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })
    expect(projected?.routeKey).toBe('T::main')
    const [head, residual] = projected?.segments ?? []
    // Headed: start is the stable head, not the first reachable member.
    expect(head.presentationStartMessageId).toBe('m1')
    expect(head.firstMessageId).toBe('m1')
    expect(head.headerInRoute).toBe(true)
    expect(head.messageCount).toBe(2)
    // Residual (head lives on another route): start is the first reachable member.
    expect(residual.presentationStartMessageId).toBe('m4')
    expect(residual.firstMessageId).toBe('m4')
    expect(residual.headerInRoute).toBe(false)
    expect(head.presentationStartMessageId).not.toBe(residual.presentationStartMessageId)
  })

  it('follows wire (route-effective) member order, never catalog order', () => {
    // Catalog membership lists m8 before m6, but the addressed route composes
    // m6 first: the committed start must be the route-first member so the
    // hook's later acceptance changes nothing visible.
    const catalog = [seg('s-ooo', 0, ['m8', 'm6', 'm4'], { headerMessageId: 'x-off' })]
    const wires = [wire('s-ooo', ['m8', 'm6', 'm4'], { ...block('T', null, ['m4', 'm6', 'm8']), headerInRoute: false })]
    const [only] = projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })?.segments ?? []
    expect(only.memberIds).toEqual(['m4', 'm6', 'm8'])
    expect(only.firstMessageId).toBe('m4')
    expect(only.presentationStartMessageId).toBe('m4')
  })

  it('takes mutation authority verbatim from the wire, never catalog owner metadata', () => {
    // Catalog claims another owner, but the addressed-route wire owns it.
    const catalog = [seg('s-owned', 0, ['m1'], { headerMessageId: 'm1', ownerTopicId: 'OTHER', ownerBranchId: 'x' })]
    const wires = [wire('s-owned', ['m1'], block('T', null, ['m1'], { headerOwnedByRoute: true }))]
    const [only] = projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })?.segments ?? []
    expect(only.headerOwnedByRoute).toBe(true)
    const catalog2 = [seg('s-read', 0, ['m2'], { headerMessageId: 'm2', ownerTopicId: 'T', ownerBranchId: null })]
    const wires2 = [wire('s-read', ['m2'], block('T', null, ['m2'], { headerOwnedByRoute: false }))]
    const [read] =
      projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog: catalog2, wires: wires2 })?.segments ?? []
    expect(read.headerOwnedByRoute).toBe(false)
  })

  it('carries color only when the catalog color is a string', () => {
    const catalog = [
      seg('s-c', 0, ['m1'], { headerMessageId: 'm1', color: '#abc' }),
      seg('s-n', 1, ['m2'], { headerMessageId: 'm2' })
    ]
    const wires = [wire('s-c', ['m1'], block('T', null, ['m1'])), wire('s-n', ['m2'], block('T', null, ['m2']))]
    const [colored, plain] =
      projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })?.segments ?? []
    expect(colored.color).toBe('#abc')
    expect('color' in plain).toBe(false)
  })

  it('matches the hook projection field-for-field (same route, route-ordered wires)', () => {
    const catalog = [
      seg('s-head', 0, ['m1', 'm2'], { headerMessageId: 'm1' }),
      seg('s-residual', 1, ['m8', 'm6', 'm4'], { headerMessageId: 'x-off' })
    ]
    const wires = [
      wire('s-head', ['m1', 'm2'], block('T', null, ['m1', 'm2'])),
      wire('s-residual', ['m8', 'm6', 'm4'], { ...block('T', null, ['m4', 'm6', 'm8']), headerInRoute: false })
    ]
    const committed = projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })
    const blocks = new Map(wires.map((w) => [w.id, w.route as SegmentRouteQualification]))
    const hooked = projectSegmentsOntoRoute(ROUTE, catalog, { topicId: 'T', branchId: null, blocks })
    expect(committed?.segments).toEqual(hooked)
  })

  it('commits ONE normal-flow slot for a group that crosses the fork inside its own span', () => {
    // Same group, both sides of one fork (see
    // tests/e2e/diag/route-residual-midviewport): the catalog head (m4) sits
    // after the fork point, so only the parent route reaches it, while m1/m2
    // are shared. Anchoring the row at the route-first member keeps the slot
    // identical on both routes; the head still owns identity/authority.
    const catalog = [seg('s-crossing', 0, ['m4', 'm1', 'm2'], { headerMessageId: 'm4' })]
    const parentWires = [wire('s-crossing', ['m4', 'm1', 'm2'], block('T', null, ['m1', 'm2', 'm4']))]
    const childWires = [
      wire('s-crossing', ['m4', 'm1', 'm2'], {
        ...block('T', 'b-child', ['m1', 'm2']),
        headerInRoute: false,
        headerOwnedByRoute: false
      })
    ]
    const [onParent] =
      projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires: parentWires })?.segments ?? []
    const [onChild] =
      projectCommittedChromeSegments({ topicId: 'T', branchId: 'b-child', catalog, wires: childWires })?.segments ?? []
    // Identity/authority are the route's own facts, never the slot's.
    expect(onParent.headerMessageId).toBe('m4')
    expect(onParent.headerInRoute).toBe(true)
    expect(onChild.headerMessageId).toBe('m4')
    expect(onChild.headerInRoute).toBe(false)
    expect(onChild.headerOwnedByRoute).toBe(false)
    // One committed slot for the whole fork crossing.
    expect(onParent.presentationStartMessageId).toBe('m1')
    expect(onChild.presentationStartMessageId).toBe(onParent.presentationStartMessageId)
  })

  it('leaves turnCount absent: the hook replacement adds it, never loses it', () => {
    const catalog = [seg('s', 0, ['m1', 'm2'], { headerMessageId: 'm1' })]
    const wires = [wire('s', ['m1', 'm2'], block('T', null, ['m1', 'm2']))]
    const [only] = projectCommittedChromeSegments({ topicId: 'T', branchId: null, catalog, wires })?.segments ?? []
    expect('turnCount' in only).toBe(false)
  })
})

describe('fetchRouteChromeWires', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shares one IPC round-trip across concurrent callers for the same route', async () => {
    mockListSegments.mockResolvedValue([{ id: 's' }])
    const [a, b] = await Promise.all([fetchRouteChromeWires('T-shared', null), fetchRouteChromeWires('T-shared', null)])
    expect(mockListSegments).toHaveBeenCalledTimes(1)
    expect(mockListSegments).toHaveBeenCalledWith('T-shared', null)
    expect(a).toBe(b)
  })

  it('drops the single-flight entry on settle so a later read re-fetches', async () => {
    mockListSegments.mockResolvedValue([])
    await fetchRouteChromeWires('T-settle', null)
    await fetchRouteChromeWires('T-settle', null)
    expect(mockListSegments).toHaveBeenCalledTimes(2)
  })

  it('propagates failure to the caller (pipelines convert it to a null join)', async () => {
    mockListSegments.mockRejectedValueOnce(new Error('ipc down'))
    await expect(fetchRouteChromeWires('T-fail', null)).rejects.toThrow('ipc down')
  })
})
