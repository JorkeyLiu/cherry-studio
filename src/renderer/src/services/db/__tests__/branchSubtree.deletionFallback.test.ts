import * as fs from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatchMock, listBranchesMock, deleteBranchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  listBranchesMock: vi.fn(),
  deleteBranchMock: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      topicBranch: {
        branchesByTopic: {
          't-1': [
            { id: 'b-1', parentBranchId: null },
            { id: 'b-2', parentBranchId: 'b-1' }
          ]
        }
      }
    }),
    dispatch: (...args: unknown[]) => {
      dispatchMock(...args)
      return args[0]
    }
  }
}))

vi.mock('@renderer/store/topicBranch', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...(actual as object),
    activeBranchReset: (payload: unknown) => ({ type: 'topicBranch/activeBranchReset', payload }),
    activeBranchSet: (payload: unknown) => ({ type: 'topicBranch/activeBranchSet', payload }),
    branchesReceived: (payload: unknown) => ({ type: 'topicBranch/branchesReceived', payload }),
    deletionFallbackRequested: (payload: unknown) => ({ type: 'topicBranch/deletionFallbackRequested', payload }),
    deletionFallbackConsumed: (payload: unknown) => ({ type: 'topicBranch/deletionFallbackConsumed', payload })
  }
})

vi.mock('../DbService', () => ({
  dbService: {
    listBranches: (...args: unknown[]) => listBranchesMock(...args),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args)
  }
}))

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn()
}))

import reducer, {
  activeBranchReset,
  branchesRemoved,
  deletionFallbackConsumed,
  deletionFallbackRequested,
  selectDeletionFallbackIntent
} from '@renderer/store/topicBranch'

import { deleteBranchSubtree } from '../branchSubtree'

function stateWith(overrides: Record<string, unknown> = {}): Parameters<typeof reducer>[0] {
  return {
    branchesByTopic: {},
    activeBranchIdByTopic: {},
    routeGenerationByTopic: {},
    deletionFallbackByTopic: {},
    ...overrides
  } as Parameters<typeof reducer>[0]
}

const rootWith = (s: Parameters<typeof reducer>[0]): never => ({ topicBranch: s }) as never

describe('deletion fallback latest intent (branch subtree removal)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listBranchesMock.mockResolvedValue({ topicId: 't-1', branches: [] })
  })

  it('both delete entries share the same helper (TopicContent + BranchDividers call deleteBranchSubtree)', () => {
    const topicContent = fs.readFileSync(
      'src/renderer/src/pages/home/components/ChatNavBar/ChatNavbarContent/TopicContent.tsx',
      'utf8'
    )
    const dividers = fs.readFileSync('src/renderer/src/pages/home/Messages/BranchDividers.tsx', 'utf8')
    expect(topicContent).toMatch(/deleteBranchSubtree\(activeTopic\.id,\s*branchId,\s*activeBranchId\)/)
    expect(dividers).toMatch(/deleteBranchSubtree\(topicId,\s*branchId,\s*activeBranchId\)/)
  })

  it('active-deleted subtree emits one latest intent with the fallback route and drops deleted snapshots', async () => {
    deleteBranchMock.mockResolvedValue({ deletedBranchIds: ['b-1', 'b-2'] })
    const result = await deleteBranchSubtree('t-1', 'b-1', 'b-2')
    expect(result.fallbackBranchId).toBeNull()
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'topicBranch/deletionFallbackRequested' })
    )
    const intentCall = dispatchMock.mock.calls.find(
      (c) => (c[0] as { type: string })?.type === 'topicBranch/deletionFallbackRequested'
    )
    expect(intentCall).toBeDefined()
    const payload = (intentCall![0] as { payload: { topicId: string; route: null; deletedBranchIds: string[] } })
      .payload
    expect(payload.topicId).toBe('t-1')
    expect(payload.route).toBeNull()
    expect(payload.deletedBranchIds).toEqual(['b-1', 'b-2'])
  })

  it('surviving active route emits no fallback intent (no reload needed)', async () => {
    deleteBranchMock.mockResolvedValue({ deletedBranchIds: ['b-9'] })
    const result = await deleteBranchSubtree('t-1', 'b-9', 'b-2')
    expect(result.fallbackBranchId).toBe('b-2')
    expect(dispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'topicBranch/deletionFallbackRequested' })
    )
  })

  it('intent is one-shot: overwrite bumps intentId, stale consume is a no-op, topic removal clears', () => {
    let s = stateWith()
    s = reducer(s, deletionFallbackRequested({ topicId: 't-1', route: null, deletedBranchIds: ['b-1'] }))
    const first = selectDeletionFallbackIntent(rootWith(s), 't-1')
    expect(first?.route).toBeNull()
    expect(first?.intentId).toBe(1)
    s = reducer(s, deletionFallbackRequested({ topicId: 't-1', route: 'b-0', deletedBranchIds: ['b-1'] }))
    const second = selectDeletionFallbackIntent(rootWith(s), 't-1')
    expect(second?.intentId).toBe(2)
    // Stale consume must not drop the newer intent.
    s = reducer(s, deletionFallbackConsumed({ topicId: 't-1', intentId: 1 }))
    expect(selectDeletionFallbackIntent(rootWith(s), 't-1')?.intentId).toBe(2)
    s = reducer(s, deletionFallbackConsumed({ topicId: 't-1', intentId: 2 }))
    expect(selectDeletionFallbackIntent(rootWith(s), 't-1')).toBeUndefined()
    // Re-request then remove the topic: intent cleared with the topic.
    s = reducer(s, deletionFallbackRequested({ topicId: 't-1', route: null, deletedBranchIds: ['b-1'] }))
    s = reducer(s, branchesRemoved({ topicIds: ['t-1'] }))
    expect(selectDeletionFallbackIntent(rootWith(s), 't-1')).toBeUndefined()
  })

  it('Messages consumes the intent once with an explicit latest read (never snapshot-around)', () => {
    const src = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    const start = src.indexOf('Route deletion fallback')
    expect(start).toBeGreaterThanOrEqual(0)
    // Bound the deletion-owner slice to its own effect (up to the next
    // top-selector comment) so the generic around path below is not included.
    const nextStart = src.indexOf('Top-selector route switch', start)
    expect(nextStart).toBeGreaterThan(start)
    const slice = src.slice(start, nextStart)
    // Single owner: claim + cancel + latest + latest viewport + consume.
    expect(slice).toMatch(/claimLoadedRoute\(activeBranchId\)/)
    expect(slice).toMatch(/cancelActiveLoads\(\)/)
    expect(slice).toMatch(/loadRouteMessagesThunk\(topicIdAtEffect,\s*routeAtEffect,\s*\{\s*kind:\s*'latest'/)
    expect(slice).toMatch(/createLatestMessageWindow\(loaded,\s*displayCount/)
    expect(slice).toMatch(/deletionFallbackConsumed/)
    // Never the generic snapshot choice inside the deletion path (comments
    // excluded: the effect comment names the forbidden path explicitly).
    const code = slice
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toMatch(/chooseRouteWindowRequest/)
    expect(code).not.toMatch(/kind:\s*'around'/)
    // Stale follow-up switches never publish.
    expect(slice).toMatch(/topicIdRef\.current !== topicIdAtEffect \|\| routeRef\.current !== routeAtEffect/)
    // Deleted-route snapshots dropped; fallback snapshot preserved (only
    // deleted ids are removed, never the fallback key).
    expect(slice).toMatch(/scroll:topic-/)
    expect(slice).toMatch(/handleScrollSnapshotCleared/)
  })

  it('generic route effect skips while a deletion intent is pending (no around covering latest)', () => {
    const src = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    expect(src).toMatch(/if \(deletionFallbackIntent && deletionFallbackIntent\.route === activeBranchId\) return/)
  })

  it('UI delete entries never tamper the Messages loaded-route ref directly', () => {
    const topicContent = fs.readFileSync(
      'src/renderer/src/pages/home/components/ChatNavBar/ChatNavbarContent/TopicContent.tsx',
      'utf8'
    )
    const dividers = fs.readFileSync('src/renderer/src/pages/home/Messages/BranchDividers.tsx', 'utf8')
    for (const [name, code] of [
      ['TopicContent', topicContent],
      ['BranchDividers', dividers]
    ] as const) {
      expect(code, `${name} must not touch loadedRouteRef`).not.toMatch(/loadedRouteRef/)
      expect(code, `${name} must not claim routes`).not.toMatch(/claimLoadedRoute/)
      expect(code, `${name} must not dispatch route loads`).not.toMatch(/loadRouteMessagesThunk/)
    }
  })

  it('deleting the last branch restores a full never-branched latest window (displayCount-complete)', async () => {
    deleteBranchMock.mockResolvedValue({ deletedBranchIds: ['b-1'] })
    const result = await deleteBranchSubtree('t-1', 'b-1', 'b-1')
    expect(result.fallbackBranchId).toBeNull()
    // Intent carries the empty-branch fallback (main) so Messages rebuilds a
    // full latest window; the viewport constructor guarantees
    // displayCount-completeness for the never-branched tail.
    const intentCall = dispatchMock.mock.calls.find(
      (c) => (c[0] as { type: string })?.type === 'topicBranch/deletionFallbackRequested'
    )
    const payload = (intentCall![0] as { payload: { route: null; deletedBranchIds: string[] } }).payload
    expect(payload.route).toBeNull()
    expect(payload.deletedBranchIds).toEqual(['b-1'])
    // Active reset keeps the stale-guard generation advancing.
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'topicBranch/activeBranchReset' }))
    let s = stateWith({ activeBranchIdByTopic: { 't-1': 'b-1' } })
    s = reducer(s, activeBranchReset({ topicId: 't-1' }))
    expect(s.activeBranchIdByTopic['t-1']).toBeNull()
    const src = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    expect(src).toMatch(/createLatestMessageWindow\(loaded,\s*displayCount/)
  })
})
