/**
 * createBranchThunk — BRANCH-7 bounded owner-only gating.
 *
 * - Loaded inherited anchor (including the parent fork anchor) makes zero IPC
 *   calls and returns null.
 * - Parent-owned anchor succeeds.
 * - Unknown/stale parent metadata makes zero IPC calls.
 * - Unloaded anchors stay Main-decided (IPC allowed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createBranch: vi.fn(),
    listBranches: vi.fn(),
    dispatch: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    createBranch: mocks.createBranch,
    listBranches: mocks.listBranches,
    resolveContextClosure: vi.fn().mockResolvedValue({ resolvedAnchorGroupKey: null })
  }
}))
vi.mock('@renderer/store/newMessage', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      messagesReceived: vi.fn((p: unknown) => ({ type: 'messagesReceived', payload: p })),
      invalidateRouteMutability: vi.fn((p: unknown) => ({ type: 'invalidateRouteMutability', payload: p }))
    }
  }
})
vi.mock('@renderer/store/messageBlock', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'upsertManyBlocks', payload: p })) }
})
vi.mock('@renderer/store/closureOwnership', () => ({
  withClosureTopics: (action: unknown) => action
}))

function branchState(opts: {
  active: string | null
  parentOfActive?: string | null
  anchorOfActive?: string
  loaded: string[]
  mutable: string[]
}) {
  const { active, loaded, mutable } = opts
  const branches =
    active !== null && opts.anchorOfActive !== undefined
      ? [
          {
            id: active,
            topicId: 't-1',
            parentBranchId: opts.parentOfActive ?? null,
            anchorMessageId: opts.anchorOfActive,
            name: active,
            createdAt: null,
            updatedAt: null
          }
        ]
      : []
  return {
    topicBranch: {
      branchesByTopic: { 't-1': branches },
      activeBranchIdByTopic: active === null ? {} : { 't-1': active },
      routeGenerationByTopic: {},
      deletionFallbackByTopic: {}
    },
    messages: {
      entities: {},
      ids: [],
      messageIdsByTopic: { 't-1': loaded },
      mutableMessageIdsByTopic: { 't-1': mutable },
      mutableRouteByTopic: { 't-1': active }
    },
    assistants: { assistants: [] }
  }
}

describe('createBranchThunk bounded gating (BRANCH-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createBranch.mockResolvedValue({ branch: { id: 'nb', anchorMessageId: 'c0' }, messages: [], blocks: [] })
    mocks.listBranches.mockResolvedValue({ branches: [] })
  })

  it('loaded inherited anchor returns null with zero IPC', async () => {
    const { createBranchThunk } = await import('../messageThunk')
    const state = branchState({
      active: 'b1',
      anchorOfActive: 'm1',
      loaded: ['m0', 'm1', 'c0'],
      mutable: ['c0']
    })
    const res = await createBranchThunk('t-1', 'b1', 'm0', 'B2')(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.createBranch).not.toHaveBeenCalled()
  })

  it('parent fork anchor itself returns null with zero IPC', async () => {
    const { createBranchThunk } = await import('../messageThunk')
    const state = branchState({
      active: 'b1',
      anchorOfActive: 'm1',
      loaded: ['m0', 'm1', 'c0'],
      mutable: ['c0']
    })
    const res = await createBranchThunk('t-1', 'b1', 'm1', 'B2')(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.createBranch).not.toHaveBeenCalled()
  })

  it('parent-owned anchor succeeds', async () => {
    const { createBranchThunk } = await import('../messageThunk')
    const state = branchState({
      active: 'b1',
      anchorOfActive: 'm1',
      loaded: ['m0', 'm1', 'c0'],
      mutable: ['c0']
    })
    const res = await createBranchThunk('t-1', 'b1', 'c0', 'B2')(mocks.dispatch as any, (() => state) as any)
    expect(res).not.toBeNull()
    expect(mocks.createBranch).toHaveBeenCalledOnce()
  })

  it('stale parent metadata returns null with zero IPC', async () => {
    const { createBranchThunk } = await import('../messageThunk')
    const state = {
      topicBranch: {
        branchesByTopic: { 't-1': [] },
        activeBranchIdByTopic: { 't-1': 'b-stale' },
        routeGenerationByTopic: {},
        deletionFallbackByTopic: {}
      },
      messages: {
        entities: {},
        ids: [],
        messageIdsByTopic: { 't-1': ['c0'] },
        mutableMessageIdsByTopic: { 't-1': ['c0'] },
        mutableRouteByTopic: { 't-1': 'b-stale' }
      },
      assistants: { assistants: [] }
    }
    const res = await createBranchThunk('t-1', 'b-stale', 'c0', 'B2')(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.createBranch).not.toHaveBeenCalled()
  })
})
