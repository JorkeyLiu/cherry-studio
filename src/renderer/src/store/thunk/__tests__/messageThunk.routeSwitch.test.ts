import type { AppDispatch, RootState } from '@renderer/store'
import type * as NewMessageModule from '@renderer/store/newMessage'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchMessagesWindow: vi.fn(),
    fetchMessages: vi.fn(),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    rebaseRouteMessages: vi.fn((p: unknown) => ({ type: 'newMessages/rebaseRouteMessages', payload: p })),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    resolveContextClosure: vi.fn(),
    createBranch: vi.fn(),
    listBranches: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/db/sendTimingDiagnostics', () => ({
  createSendDiagnosticsContext: vi.fn(() => ({ correlationId: 'c', ordinal: 1 })),
  elapsedMs: vi.fn(() => 0)
}))
vi.mock('@renderer/services/db/streamTimingDiagnostics', () => ({
  createStreamWriteDiagnosticsContext: vi.fn(() => ({ correlationId: 'c', ordinal: 1 })),
  isStreamAttrRendererMeasureEnabled: vi.fn(() => false),
  recordStreamAttrRendererRecord: vi.fn()
}))
vi.mock('@renderer/services/anchorService', () => ({
  ensureTopicAnchorEstablished: vi.fn(),
  anchorKeyForRoute: (t: string, b?: string | null) => (typeof b === 'string' && b.length > 0 ? `${t}:${b}` : t),
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (a: any) => a?.settings ?? {},
  getDefaultAssistant: vi.fn(),
  getDefaultTopic: vi.fn()
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    fetchMessages: mocks.fetchMessages,
    resolveContextClosure: mocks.resolveContextClosure,
    createBranch: mocks.createBranch,
    listBranches: mocks.listBranches,
    appendMessage: vi.fn(),
    deleteMessagesWithSegments: vi.fn(),
    resetMessagesForResend: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    selectAnswerMessage: vi.fn(),
    updateMessage: vi.fn(),
    listSegments: vi.fn(async () => [])
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/store/messageBlock', () => ({
  default: (state = { entities: {}, ids: [] } as any) => state,
  upsertManyBlocks: mocks.upsertManyBlocks,
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))
vi.mock('@renderer/store/assistants', () => ({
  default: (state = {} as any) => state,
  updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p })),
  updateAssistantSettings: vi.fn((p: unknown) => ({ type: 'updateAssistantSettings', payload: p }))
}))
vi.mock('@renderer/store/index', () => ({
  default: { dispatch: vi.fn(), getState: () => ({}) as any },
  useAppDispatch: () => vi.fn()
}))
vi.mock('@renderer/store/residentRegistry', async () => {
  const actual = await vi.importActual<any>('@renderer/store/residentRegistry')
  return { ...actual }
})
vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: vi.fn(() => () => Promise.resolve())
}))
vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({ AiSdkToChunkAdapter: class {} }))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/windowReadQueue', () => ({
  runTopicWindowRead: (_t: string, _k: string, read: () => unknown) => read()
}))
vi.mock('@renderer/hooks/useModel', () => ({ getModel: vi.fn() }))
vi.mock('@renderer/services/ApiService', () => ({ transformMessagesAndFetch: vi.fn() }))
vi.mock('@renderer/services/messageStreaming/BlockManager', () => ({ BlockManager: class {} }))
vi.mock('@renderer/services/messageStreaming/callbacks', () => ({ createCallbacks: vi.fn(() => ({})) }))
vi.mock('@renderer/services/StreamProcessingService', () => ({
  createStreamProcessor: vi.fn(() => vi.fn())
}))
vi.mock('@renderer/services/SpanManagerService', () => ({ endSpan: vi.fn() }))
vi.mock('@renderer/services/phaseTimingDiagnostics', () => ({
  currentPhaseCorrelation: vi.fn(() => null),
  recordPhaseDuration: vi.fn()
}))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('@renderer/utils/messageUtils/create', () => ({
  createAssistantMessage: vi.fn(),
  createTranslationBlock: vi.fn(),
  resetAssistantMessage: vi.fn((m: any) => m)
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k } as any,
  t: (k: string) => k
}))
vi.mock('@renderer/store/newMessage', async () => {
  const actual = await vi.importActual<typeof NewMessageModule>('@renderer/store/newMessage')
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      rebaseRouteMessages: mocks.rebaseRouteMessages,
      messagesReceived: mocks.messagesReceived,
      setTopicLoading: mocks.setTopicLoading,
      setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p }))
    }
  }
})

function makeWindowResponse(
  request: FetchMessagesWindowRequest,
  messages: Array<{ id: string } & Record<string, unknown>>,
  overrides: Partial<FetchMessagesWindowResponse['window']> = {}
): FetchMessagesWindowResponse {
  const returnedCount = messages.length
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: request.kind,
      completeness: 'window',
      topicId: request.topicId,
      anchorMessageId: request.kind === 'around' ? (request as any).anchorMessageId : null,
      requested: request.kind === 'latest' ? { limit: (request as any).limit } : { before: 10, after: 19 },
      firstMessageId: returnedCount > 0 ? messages[0].id : null,
      lastMessageId: returnedCount > 0 ? messages[returnedCount - 1].id : null,
      returnedCount,
      hasMoreBefore: false,
      hasMoreAfter: false,
      ...overrides
    } as FetchMessagesWindowResponse['window']
  } as unknown as FetchMessagesWindowResponse
}

function baseState() {
  return {
    assistants: { assistants: [{ id: 'asst-1', settings: { contextCount: 5 }, topics: [{ id: 't1' }] }] },
    messages: {
      entities: {},
      messageIdsByTopic: { t1: ['u1', 'a1'] },
      loadingByTopic: {},
      fulfilledByTopic: {},
      currentTopicId: 't1',
      displayCount: 10
    },
    messageBlocks: { entities: {} },
    topicBranch: { branchesByTopic: {}, activeBranchIdByTopic: { t1: 'b-new' }, routeGenerationByTopic: { t1: 1 } },
    residentRegistry: { entries: {} }
  } as any
}

describe('loadRouteMessagesThunk windowed incremental switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      if (req.kind === 'latest') {
        return makeWindowResponse(req, [{ id: 'u1' }, { id: 'a1' }, { id: 'u2-new' }], {
          hasMoreBefore: true,
          hasMoreAfter: false
        })
      }
      const anchor = (req as any).anchorMessageId as string
      return makeWindowResponse(req, [{ id: 'u1' }, { id: anchor }, { id: 'u2-new' }], {
        hasMoreBefore: true,
        hasMoreAfter: true
      })
    })
  })

  it('divider around/fork-anchor calls windowed around with branchId and rebases (no full fetch)', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const state = baseState()
    // Active route already switched to b-new by the caller (activeBranchSet first).
    const getState = () => state
    const res = (await loadRouteMessagesThunk('t1', 'b-new', {
      kind: 'around',
      anchorMessageId: 'u1',
      before: 10,
      after: 19
    })(dispatch, getState)) as unknown as FetchMessagesWindowResponse
    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
    const req = mocks.fetchMessagesWindow.mock.calls[0][0]
    expect(req.kind).toBe('around')
    expect(req.topicId).toBe('t1')
    expect(req.branchId).toBe('b-new')
    expect(req.anchorMessageId).toBe('u1')
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    // Atomic rebase (not full messagesReceived replacement path for routes).
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledTimes(1)
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: 't1', messages: expect.any(Array) })
    )
    // Authoritative hasMore propagates with the response.
    expect(res.window.hasMoreBefore).toBe(true)
    expect(res.window.hasMoreAfter).toBe(true)
  })

  it('top-selector isAtBottom loads latest windowed with branchId', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const state = baseState()
    const getState = () => state
    await loadRouteMessagesThunk('t1', 'b-new', { kind: 'latest' })(dispatch, getState)
    const req = mocks.fetchMessagesWindow.mock.calls[0][0]
    expect(req.kind).toBe('latest')
    expect(req.branchId).toBe('b-new')
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledTimes(1)
  })

  it('rapid consecutive switches: older response never overwrites newer route', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    // First (stale) read resolves slowly.
    let resolveFirst!: (v: FetchMessagesWindowResponse) => void
    const firstGate = new Promise<FetchMessagesWindowResponse>((r) => (resolveFirst = r))
    mocks.fetchMessagesWindow.mockImplementationOnce(() => firstGate)
    mocks.fetchMessagesWindow.mockImplementationOnce(async (req: FetchMessagesWindowRequest) =>
      makeWindowResponse(req, [{ id: 'u1' }, { id: 'second' }])
    )
    const state = baseState()
    const getState = () => state
    const dispatchFirst = vi.fn()
    const dispatchSecond = vi.fn()
    // Newer switch changes active route to b-second before older settles.
    const p1 = loadRouteMessagesThunk('t1', 'b-first', { kind: 'latest' })(dispatchFirst, getState)
    const p2 = loadRouteMessagesThunk('t1', 'b-second', { kind: 'latest' })(dispatchSecond, () => ({
      ...state,
      topicBranch: {
        ...state.topicBranch,
        activeBranchIdByTopic: { t1: 'b-second' },
        routeGenerationByTopic: { t1: 2 }
      }
    }))
    await p2
    // Now settle the stale first response (route moved on).
    const staleReq: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't1', branchId: 'b-first', limit: 10 }
    resolveFirst(makeWindowResponse(staleReq, [{ id: 'stale' }]))
    await p1
    // Stale first must not rebase; newer second rebases exactly once.
    expect(dispatchFirst).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'newMessages/rebaseRouteMessages' }))
    const rebases = dispatchSecond.mock.calls.filter((c) => c[0]?.type === 'newMessages/rebaseRouteMessages')
    expect(rebases.length).toBe(1)
  })

  it('createBranch inherits parent route anchor per-route (index map, clamp covered by Main)', async () => {
    mocks.createBranch.mockResolvedValue({
      branch: { id: 'b-new', anchorMessageId: 'u2' },
      messages: [{ id: 'u1' }, { id: 'u2' }],
      blocks: []
    })
    mocks.listBranches.mockResolvedValue({ branches: [] })
    mocks.resolveContextClosure.mockResolvedValue({ resolvedAnchorGroupKey: 'u1', changed: true })
    const { createBranchThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const state = {
      assistants: {
        assistants: [
          {
            id: 'asst-1',
            settings: { contextCount: 5, contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u1' } } },
            topics: [{ id: 't1' }]
          }
        ]
      },
      messages: { entities: {}, messageIdsByTopic: {}, currentTopicId: 't1', displayCount: 10 },
      topicBranch: { branchesByTopic: {}, activeBranchIdByTopic: {}, routeGenerationByTopic: {} }
    } as any
    const out = await createBranchThunk('t1', null, 'u2', 'branch')(dispatch, () => state)
    expect(out?.branchId).toBe('b-new')
    // Inherit resolver called with parent route + target branch isolation.
    expect(mocks.resolveContextClosure).toHaveBeenCalledWith(
      expect.objectContaining({
        topicId: 't1',
        branchId: 'b-new',
        intent: 'inherit',
        sourceTopicId: 't1',
        sourceAnchorGroupKey: 'u1',
        detail: 'anchor'
      })
    )
    // New route key persisted (t1:b-new), bare parent key untouched.
    const settingsCall = dispatch.mock.calls.find((c) => c[0]?.type === 'updateAssistantSettings')?.[0]
    expect(settingsCall).toBeDefined()
    expect(settingsCall.payload.settings.contextWindowAnchor['t1:b-new']).toEqual({
      kind: 'active',
      groupKey: 'u1'
    })
    expect(settingsCall.payload.settings.contextWindowAnchor['t1']).toEqual({ kind: 'active', groupKey: 'u1' })
  })
})

describe('loadRouteWindowWithFallback (divider reliable degradation, behavior)', () => {
  // Executing dispatch: runs thunks like real Redux dispatch so the fallback
  // helper exercises the production around→latest path (not source text).
  function execDispatch(getState: () => any) {
    const seen: any[] = []
    const exec: any = (action: any) => {
      seen.push(action)
      if (typeof action === 'function') return action(exec, getState)
      return action
    }
    return { exec, seen }
  }

  it('around reject falls back to latest for the SAME target route and publishes it', async () => {
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      if (req.kind === 'around') throw new Error('anchor not on target route')
      return makeWindowResponse(req, [{ id: 'u1' }, { id: 'a1' }, { id: 'u2-new' }], {
        hasMoreBefore: true,
        hasMoreAfter: false
      })
    })
    const { loadRouteWindowWithFallback } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    const out = await loadRouteWindowWithFallback(exec, 't1', 'b-new', {
      anchorMessageId: 'fork-anchor',
      before: 10,
      after: 19
    })
    expect(out.fallbackUsed).toBe(true)
    expect(out.response.window.hasMoreBefore).toBe(true)
    expect(out.response.window.hasMoreAfter).toBe(false)
    // Both around (failed) and latest (fallback) addressed the same route.
    const reqs = mocks.fetchMessagesWindow.mock.calls.map((c) => c[0])
    expect(reqs.map((r) => r.kind)).toEqual(['around', 'latest'])
    expect(reqs.every((r) => r.branchId === 'b-new' && r.topicId === 't1')).toBe(true)
    // Fallback published exactly once via atomic rebase (no full fetch).
    const rebases = seen.filter((a) => a?.type === 'newMessages/rebaseRouteMessages')
    expect(rebases.length).toBe(1)
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
  })

  it('double failure (around + latest) rethrows and publishes nothing (caller rolls back)', async () => {
    mocks.fetchMessagesWindow.mockRejectedValue(new Error('transport down'))
    const { loadRouteWindowWithFallback } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    await expect(loadRouteWindowWithFallback(exec, 't1', 'b-new', { anchorMessageId: 'fork' })).rejects.toThrow()
    // Nothing published: no rebase, so the caller can roll back to the old
    // route without any mixed projection in the store.
    expect(seen.filter((a) => a?.type === 'newMessages/rebaseRouteMessages')).toEqual([])
  })

  it('empty target route publishes [] with authoritative empty flags (atomic clear)', async () => {
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) =>
      makeWindowResponse(req, [], { hasMoreBefore: false, hasMoreAfter: false })
    )
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const dispatch = vi.fn()
    const res = (await loadRouteMessagesThunk('t1', 'b-new', { kind: 'latest' })(
      dispatch,
      getState
    )) as unknown as FetchMessagesWindowResponse
    expect(res.messages).toEqual([])
    expect(res.window.hasMoreBefore).toBe(false)
    expect(res.window.hasMoreAfter).toBe(false)
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledWith(expect.objectContaining({ topicId: 't1', messages: [] }))
  })

  it('stale fallback is not published when the user already moved on', async () => {
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      if (req.kind === 'around') throw new Error('anchor not on target route')
      return makeWindowResponse(req, [{ id: 'late' }])
    })
    const { loadRouteWindowWithFallback } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec } = execDispatch(getState)
    await expect(
      loadRouteWindowWithFallback(exec, 't1', 'b-new', { anchorMessageId: 'fork' }, () => false)
    ).rejects.toThrow()
  })
})

describe('loadRouteMessagesThunk deferPublish contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeDeferredResponse(
    request: FetchMessagesWindowRequest,
    messages: Array<{ id: string } & Record<string, unknown>>,
    blocks: Array<Record<string, unknown>>,
    mutableIds: string[],
    windowOverrides: Partial<FetchMessagesWindowResponse['window']> = {}
  ): FetchMessagesWindowResponse {
    const base = makeWindowResponse(request, messages, windowOverrides)
    ;(base as unknown as { blocks: unknown }).blocks = blocks as unknown as FetchMessagesWindowResponse['blocks']
    ;(base as unknown as { mutableMessageIds: unknown }).mutableMessageIds = mutableIds
    return base
  }

  it('default/absent option publishes immediately with messages+blocks+mutable capability', async () => {
    const msgs = [{ id: 'u1' }, { id: 'a1' }]
    const blks = [{ id: 'blk-1', messageId: 'a1' }]
    const mutable = ['u1']
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) =>
      makeDeferredResponse(req, msgs, blks, mutable, { hasMoreBefore: true, hasMoreAfter: false })
    )
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const state = baseState()
    const getState = () => state
    // absent opts (default latest)
    const resDefault = (await (
      loadRouteMessagesThunk as unknown as (t: string, b: string | null) => (d: unknown, g: unknown) => unknown
    )('t1', 'b-new')(
      dispatch as unknown as AppDispatch,
      getState as unknown as () => RootState
    )) as FetchMessagesWindowResponse
    expect(resDefault.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'u1' })]))
    expect(resDefault.blocks).toEqual(blks as unknown as FetchMessagesWindowResponse['blocks'])
    expect((resDefault as unknown as { mutableMessageIds: string[] }).mutableMessageIds).toEqual(mutable)
    expect(mocks.upsertManyBlocks).toHaveBeenCalledTimes(1)
    expect(mocks.upsertManyBlocks).toHaveBeenCalledWith(blks)
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledTimes(1)
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: 't1', route: 'b-new', mutableMessageIds: mutable })
    )
    vi.clearAllMocks()
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) =>
      makeDeferredResponse(req, msgs, blks, mutable)
    )
    const dispatch2 = vi.fn()
    const resExplicit = (await loadRouteMessagesThunk('t1', 'b-new', { kind: 'latest' })(
      dispatch2 as unknown as AppDispatch,
      getState as unknown as () => RootState
    )) as unknown as FetchMessagesWindowResponse
    expect(resExplicit.window.kind).toBe('latest')
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledTimes(1)
  })

  it('deferPublish true returns authoritative messages/blocks/window/capability without store projection while target selected', async () => {
    const msgs = [{ id: 'u1' }, { id: 'fork1' }, { id: 'a2' }]
    const blks = [{ id: 'blk-fork', messageId: 'a2' }]
    const mutable = ['fork1', 'a2']
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) =>
      makeDeferredResponse(req, msgs, blks, mutable, { hasMoreBefore: true, hasMoreAfter: true })
    )
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const dispatch = vi.fn()
    const res = (await loadRouteMessagesThunk('t1', 'b-new', {
      kind: 'around',
      anchorMessageId: 'fork1',
      before: 10,
      after: 19,
      deferPublish: true
    })(
      dispatch as unknown as AppDispatch,
      getState as unknown as () => RootState
    )) as unknown as FetchMessagesWindowResponse
    expect(res.messages as unknown as Array<{ id: string }>).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'fork1' })])
    )
    expect(res.blocks as unknown as Array<Record<string, unknown>>).toEqual(
      blks as unknown as FetchMessagesWindowResponse['blocks']
    )
    expect((res as unknown as { mutableMessageIds: string[] }).mutableMessageIds).toEqual(mutable)
    expect(res.window.hasMoreBefore).toBe(true)
    expect(res.window.hasMoreAfter).toBe(true)
    expect(res.window.kind).toBe('around')
    // store projection + blocks/capability remain unchanged (no dispatch)
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    expect(mocks.rebaseRouteMessages).not.toHaveBeenCalled()
    // loading was still toggled, but no projection
    const loadingCalls = dispatch.mock.calls.filter((c) => c[0]?.type === 'newMessages/setTopicLoading')
    expect(loadingCalls.length).toBe(2)
  })

  it('rejected query propagates same error and publishes nothing (both immediate and deferred)', async () => {
    const err = new Error('window fetch failed')
    mocks.fetchMessagesWindow.mockRejectedValue(err)
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const dispatchImm = vi.fn()
    await expect(
      loadRouteMessagesThunk('t1', 'b-new', { kind: 'latest' })(
        dispatchImm as unknown as AppDispatch,
        getState as unknown as () => RootState
      )
    ).rejects.toThrow('window fetch failed')
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    expect(mocks.rebaseRouteMessages).not.toHaveBeenCalled()
    vi.clearAllMocks()
    mocks.fetchMessagesWindow.mockRejectedValue(err)
    const dispatchDef = vi.fn()
    await expect(
      loadRouteMessagesThunk('t1', 'b-new', { kind: 'latest', deferPublish: true })(
        dispatchDef as unknown as AppDispatch,
        getState as unknown as () => RootState
      )
    ).rejects.toThrow('window fetch failed')
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    expect(mocks.rebaseRouteMessages).not.toHaveBeenCalled()
  })

  it('caller final publication after defer sets exact route metadata including Main null and branch capability', async () => {
    const branchMsgs = [{ id: 'u1' }, { id: 'b-msg' }]
    const branchBlks = [{ id: 'blk-b', messageId: 'b-msg' }]
    const branchMutable = ['b-msg']
    const branchReq = { kind: 'latest', topicId: 't1', branchId: 'b-new', limit: 10 } as FetchMessagesWindowRequest
    const branchRes = makeDeferredResponse(branchReq, branchMsgs, branchBlks, branchMutable, {
      hasMoreBefore: true,
      hasMoreAfter: false
    })
    mocks.fetchMessagesWindow.mockResolvedValueOnce(branchRes)
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const stateBranch = baseState()
    const getStateBranch = () => stateBranch
    const dispatchBranch = vi.fn()
    const resBranch = (await loadRouteMessagesThunk('t1', 'b-new', { kind: 'latest', deferPublish: true })(
      dispatchBranch as unknown as AppDispatch,
      getStateBranch as unknown as () => RootState
    )) as unknown as FetchMessagesWindowResponse
    // caller publishes deferred projection synchronously with window commit
    const callerDispatch = vi.fn()
    const deferredBlocks = (resBranch.blocks as unknown as Array<Record<string, unknown>>) ?? []
    const deferredMessages = (resBranch.messages as unknown as Array<Record<string, unknown>>) ?? []
    const deferredMutable = (resBranch as unknown as { mutableMessageIds: string[] }).mutableMessageIds ?? []
    if (deferredBlocks.length > 0) callerDispatch(mocks.upsertManyBlocks(deferredBlocks))
    callerDispatch(
      mocks.rebaseRouteMessages({
        topicId: 't1',
        messages: deferredMessages,
        route: 'b-new',
        mutableMessageIds: deferredMutable
      })
    )
    expect(mocks.upsertManyBlocks).toHaveBeenCalledWith(branchBlks)
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: 't1', route: 'b-new', mutableMessageIds: branchMutable, messages: branchMsgs })
    )
    vi.clearAllMocks()
    // Main route (null) exact capability
    const mainMsgs = [{ id: 'm1' }]
    const mainBlks: Array<Record<string, unknown>> = []
    const mainMutable = ['m1']
    const mainReq = { kind: 'latest', topicId: 't1', branchId: null, limit: 10 } as FetchMessagesWindowRequest
    const mainRes = makeDeferredResponse(mainReq, mainMsgs, mainBlks, mainMutable)
    mocks.fetchMessagesWindow.mockResolvedValueOnce(mainRes)
    const stateMain = {
      ...baseState(),
      topicBranch: { branchesByTopic: {}, activeBranchIdByTopic: { t1: null }, routeGenerationByTopic: { t1: 1 } }
    } as unknown as ReturnType<typeof baseState>
    const getStateMain = () => stateMain as unknown as ReturnType<typeof baseState>
    const dispatchMain = vi.fn()
    const resMain = (await loadRouteMessagesThunk('t1', null, { kind: 'latest', deferPublish: true })(
      dispatchMain as unknown as AppDispatch,
      getStateMain as unknown as () => RootState
    )) as unknown as FetchMessagesWindowResponse
    expect((resMain as unknown as { mutableMessageIds: string[] }).mutableMessageIds).toEqual(mainMutable)
    expect(mocks.rebaseRouteMessages).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    const callerMain = vi.fn()
    callerMain(
      mocks.rebaseRouteMessages({
        topicId: 't1',
        messages: resMain.messages as unknown as Array<Record<string, unknown>>,
        route: null,
        mutableMessageIds: (resMain as unknown as { mutableMessageIds: string[] }).mutableMessageIds
      })
    )
    expect(mocks.rebaseRouteMessages).toHaveBeenCalledWith(
      expect.objectContaining({ route: null, mutableMessageIds: mainMutable })
    )
  })

  it('superseded deferred late response is void and not published (response-only caller guard elsewhere)', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    let resolveFirst!: (v: FetchMessagesWindowResponse) => void
    const firstGate = new Promise<FetchMessagesWindowResponse>((r) => (resolveFirst = r))
    mocks.fetchMessagesWindow.mockImplementationOnce(() => firstGate)
    mocks.fetchMessagesWindow.mockImplementationOnce(async (req: FetchMessagesWindowRequest) =>
      makeDeferredResponse(req, [{ id: 'second' }], [{ id: 'blk-second' }], ['second'])
    )
    const state = baseState()
    const getStateFirst = () => state
    const getStateSecond = () => ({
      ...state,
      topicBranch: {
        ...state.topicBranch,
        activeBranchIdByTopic: { t1: 'b-second' },
        routeGenerationByTopic: { t1: 2 }
      }
    })
    const dispatchFirst = vi.fn()
    const dispatchSecond = vi.fn()
    const p1 = (
      loadRouteMessagesThunk('t1', 'b-first', { kind: 'latest', deferPublish: true }) as unknown as (
        d: unknown,
        g: unknown
      ) => Promise<unknown>
    )(dispatchFirst as unknown as AppDispatch, getStateFirst as unknown as () => RootState)
    const p2 = (
      loadRouteMessagesThunk('t1', 'b-second', { kind: 'latest', deferPublish: true }) as unknown as (
        d: unknown,
        g: unknown
      ) => Promise<unknown>
    )(dispatchSecond as unknown as AppDispatch, getStateSecond as unknown as () => RootState)
    const resSecond = (await p2) as FetchMessagesWindowResponse
    expect(resSecond.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'second' })]))
    // thunk deferred second did not auto-publish
    expect(mocks.rebaseRouteMessages).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    vi.clearAllMocks()
    const staleReq = { kind: 'latest', topicId: 't1', branchId: 'b-first', limit: 10 } as FetchMessagesWindowRequest
    resolveFirst(makeDeferredResponse(staleReq, [{ id: 'stale' }], [], ['stale']))
    const resFirst = await p1
    expect(resFirst).toBeUndefined()
    // superseded deferred response not published by defer (response only caller guard elsewhere)
    expect(mocks.rebaseRouteMessages).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    expect(dispatchFirst).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'newMessages/rebaseRouteMessages' }))
  })
})
