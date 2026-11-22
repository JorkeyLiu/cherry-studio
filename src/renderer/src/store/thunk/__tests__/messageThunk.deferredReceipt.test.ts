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
  overrides: Partial<FetchMessagesWindowResponse['window']> = {},
  extras: { blocks?: unknown[]; mutableMessageIds?: string[]; reference?: unknown } = {}
): FetchMessagesWindowResponse {
  const returnedCount = messages.length
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: (extras.blocks ?? []) as unknown as FetchMessagesWindowResponse['blocks'],
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
    } as FetchMessagesWindowResponse['window'],
    ...(extras.mutableMessageIds !== undefined ? { mutableMessageIds: extras.mutableMessageIds } : {}),
    ...(extras.reference !== undefined ? { reference: extras.reference } : {})
  } as unknown as FetchMessagesWindowResponse
}

function baseState(topicId: string, route: string | null, routeGen = 1, applicabilityGeneration = 0) {
  return {
    assistants: { assistants: [{ id: 'asst-1', settings: { contextCount: 5 }, topics: [{ id: topicId }] }] },
    messages: {
      entities: {},
      messageIdsByTopic: { [topicId]: ['u1', 'a1'] },
      loadingByTopic: {},
      fulfilledByTopic: {},
      currentTopicId: topicId,
      displayCount: 10
    },
    messageBlocks: { entities: {} },
    topicBranch: {
      branchesByTopic: {},
      activeBranchIdByTopic: { [topicId]: route },
      routeGenerationByTopic: { [topicId]: routeGen }
    },
    residentRegistry: { entries: { [topicId]: { applicabilityGeneration } } }
  } as any
}

// Executing dispatch: runs thunks like real Redux dispatch so the deferred
// wrapper exercises the production sync-prefix registration.
function execDispatch(getState: () => any) {
  const seen: any[] = []
  const exec: any = (action: any) => {
    seen.push(action)
    if (typeof action === 'function') return action(exec, getState)
    return action
  }
  return { exec, seen }
}

describe('deferred route-window receipt (unified joint-publish identity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      if (req.kind === 'latest') {
        return makeWindowResponse(
          req,
          [{ id: 'u1' }, { id: 'a1' }],
          { hasMoreBefore: true, hasMoreAfter: false },
          { blocks: [{ id: 'blk-1' }], mutableMessageIds: ['a1'] }
        )
      }
      const anchor = (req as any).anchorMessageId as string
      return makeWindowResponse(
        req,
        [{ id: 'u1' }, { id: anchor }],
        { hasMoreBefore: true, hasMoreAfter: true },
        { blocks: [{ id: 'blk-1' }], mutableMessageIds: [anchor] }
      )
    })
  })

  it('deferred latest publishes nothing and returns a currently-valid receipt with fresh joint payload', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent, toDeferredJointPayload } =
      await import('../messageThunk')
    const state = baseState('t-receipt-1', 'b-new')
    const getState = () => state
    const { exec } = execDispatch(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-1', 'b-new', { kind: 'latest' })
    expect(receipt).toBeDefined()
    expect(mocks.rebaseRouteMessages).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(true)
    // Joint payload: fresh entities per call, absent reference clears to null.
    const first = toDeferredJointPayload(receipt!)
    const second = toDeferredJointPayload(receipt!)
    expect(first.messages).not.toBe(receipt!.response.messages)
    expect(first.messages).toEqual(receipt!.response.messages as unknown as object[])
    expect(first.mutableMessageIds).not.toBe(
      (receipt!.response as unknown as { mutableMessageIds: string[] }).mutableMessageIds
    )
    expect(first.mutableMessageIds).toEqual(['a1'])
    expect(first.reference).toBeNull()
    expect(second.messages).not.toBe(first.messages)
    expect(second.mutableMessageIds).not.toBe(first.mutableMessageIds)
  })

  it('deferred around binds the fork anchor and carries authoritative window meta', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent } = await import('../messageThunk')
    const state = baseState('t-receipt-2', 'b-new')
    const getState = () => state
    const { exec } = execDispatch(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-2', 'b-new', {
      kind: 'around',
      anchorMessageId: 'u1',
      before: 10,
      after: 19
    })
    expect(receipt).toBeDefined()
    const req = mocks.fetchMessagesWindow.mock.calls[0][0]
    expect(req.kind).toBe('around')
    expect(req.branchId).toBe('b-new')
    expect(req.anchorMessageId).toBe('u1')
    expect(receipt!.response.window.hasMoreBefore).toBe(true)
    expect(mocks.rebaseRouteMessages).not.toHaveBeenCalled()
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(true)
  })

  it('newer same-topic request supersedes the older receipt (late requestSeq cannot publish)', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent } = await import('../messageThunk')
    let resolveFirst!: (v: FetchMessagesWindowResponse) => void
    const firstGate = new Promise<FetchMessagesWindowResponse>((r) => (resolveFirst = r))
    mocks.fetchMessagesWindow.mockImplementationOnce(() => firstGate)
    const state = baseState('t-receipt-3', 'b-new')
    const getState = () => state
    const { exec } = execDispatch(getState)
    const p1 = dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-3', 'b-new', { kind: 'latest' })
    const receipt2 = await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-3', 'b-new', { kind: 'latest' })
    expect(receipt2).toBeDefined()
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt2!)).toBe(true)
    const staleReq = {
      kind: 'latest',
      topicId: 't-receipt-3',
      branchId: 'b-new',
      limit: 10
    } as FetchMessagesWindowRequest
    resolveFirst(makeWindowResponse(staleReq, [{ id: 'stale' }]))
    const receipt1 = await p1
    // The thunk discards the superseded fetch: the wrapper resolves void, so
    // no receipt exists to publish.
    expect(receipt1).toBeUndefined()
  })

  it('route ABA invalidates the old receipt even when the route returns', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent } = await import('../messageThunk')
    const state = baseState('t-receipt-4', 'b-a')
    let currentRoute: string | null = 'b-a'
    const getState = () => ({
      ...state,
      topicBranch: {
        ...state.topicBranch,
        activeBranchIdByTopic: { 't-receipt-4': currentRoute }
      }
    })
    const { exec } = execDispatch(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-4', 'b-a', { kind: 'latest' })
    expect(receipt).toBeDefined()
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(true)
    // A→B→A: the intermediate switch bumped the shared sequence, so the
    // original receipt is expired even though the route matches again.
    currentRoute = 'b-b'
    await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-4', 'b-b', { kind: 'latest' })
    currentRoute = 'b-a'
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(false)
  })

  it('active-route mismatch invalidates without a newer request', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent } = await import('../messageThunk')
    const state = baseState('t-receipt-5', 'b-a')
    let currentRoute: string | null = 'b-a'
    const getState = () => ({
      ...state,
      topicBranch: {
        ...state.topicBranch,
        activeBranchIdByTopic: { 't-receipt-5': currentRoute }
      }
    })
    const { exec } = execDispatch(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-5', 'b-a', { kind: 'latest' })
    currentRoute = 'b-b'
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(false)
  })

  it('deletion during fetch invalidates the receipt', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent } = await import('../messageThunk')
    const { bumpDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')
    const state = baseState('t-receipt-6', 'b-new')
    const getState = () => state
    const { exec } = execDispatch(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-6', 'b-new', { kind: 'latest' })
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(true)
    bumpDeletionGeneration('t-receipt-6')
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(false)
  })

  it('route-generation and resident-applicability advances invalidate independently', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent } = await import('../messageThunk')
    const state = baseState('t-receipt-7', 'b-new', 1, 0)
    let routeGen = 1
    let applicability = 0
    const getState = () => ({
      ...state,
      topicBranch: { ...state.topicBranch, routeGenerationByTopic: { 't-receipt-7': routeGen } },
      residentRegistry: { entries: { 't-receipt-7': { applicabilityGeneration: applicability } } }
    })
    const { exec } = execDispatch(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-7', 'b-new', { kind: 'latest' })
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(true)
    routeGen = 2
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(false)
    routeGen = 1
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(true)
    applicability = 1
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(false)
  })

  it('topic switch invalidates the receipt', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent } = await import('../messageThunk')
    const state = baseState('t-receipt-8', 'b-new')
    let currentTopic: string | null = 't-receipt-8'
    const getState = () => ({
      ...state,
      messages: { ...state.messages, currentTopicId: currentTopic }
    })
    const { exec } = execDispatch(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-receipt-8', 'b-new', { kind: 'latest' })
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(true)
    currentTopic = 't-other'
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(false)
  })
})
