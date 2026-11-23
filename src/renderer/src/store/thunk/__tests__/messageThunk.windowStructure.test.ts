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

function segWire(id: string, mids: string[]) {
  return {
    id,
    topicId: 't-bundle',
    name: `g-${id}`,
    messageIds: mids,
    headerMessageId: mids[0] ?? null,
    ownerTopicId: 't-bundle',
    ownerBranchId: null,
    createdAt: null,
    updatedAt: null,
    sortOrder: 0,
    firstMessageId: mids[0] ?? null,
    lastMessageId: mids[mids.length - 1] ?? null,
    messageCount: mids.length
  }
}

function bundledResponse(req: FetchMessagesWindowRequest, mids: string[]): FetchMessagesWindowResponse {
  return {
    messages: mids.map((id) => ({ id })) as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [],
    window: {
      kind: req.kind,
      completeness: 'window',
      topicId: req.topicId,
      anchorMessageId: req.kind === 'around' ? (req as any).anchorMessageId : null,
      requested: req.kind === 'latest' ? { limit: (req as any).limit } : { before: 10, after: 10 },
      firstMessageId: mids[0] ?? null,
      lastMessageId: mids[mids.length - 1] ?? null,
      returnedCount: mids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    } as FetchMessagesWindowResponse['window'],
    mutableMessageIds: [],
    reference: null,
    structure: {
      catalog: [segWire('s1', ['u1', 'a1'])],
      route: {
        topicId: req.topicId,
        branchId: req.branchId ?? null,
        qualifications: [
          { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['u1', 'a1'] }
        ]
      }
    }
  } as unknown as FetchMessagesWindowResponse
}

function baseStateLocal(topicId: string, route: string | null) {
  return {
    assistants: { assistants: [{ id: 'asst-1', settings: {}, topics: [{ id: topicId }] }] },
    messages: {
      entities: {},
      messageIdsByTopic: {},
      loadingByTopic: {},
      fulfilledByTopic: {},
      currentTopicId: topicId,
      displayCount: 10
    },
    messageBlocks: { entities: {} },
    topicBranch: {
      branchesByTopic: {},
      activeBranchIdByTopic: { [topicId]: route },
      routeGenerationByTopic: { [topicId]: 1 }
    },
    residentRegistry: { entries: { [topicId]: { applicabilityGeneration: 0 } } }
  } as any
}

function execDispatchLocal(getState: () => any) {
  const seen: any[] = []
  const exec: any = (action: any) => {
    seen.push(action)
    if (typeof action === 'function') return action(exec, getState)
    return action
  }
  return { exec, seen }
}

/**
 * Main mirror: the window response carries the structure if and only if the
 * request asked for it — exactly what the Main contract enforces.
 */
function mirroredResponse(req: FetchMessagesWindowRequest, mids: string[]): FetchMessagesWindowResponse {
  const full = bundledResponse(req, mids)
  if ((req as unknown as { includeStructure?: unknown }).includeStructure === true) return full
  const { structure: _drop, ...rest } = full as unknown as Record<string, unknown>
  return rest as unknown as FetchMessagesWindowResponse
}

describe('bundled window+structure renderer (single IPC)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) =>
      mirroredResponse(req, ['u1', 'a1'])
    )
  })

  it('deferred route read sends includeStructure and carries the bundle with one IPC, no listSegments', async () => {
    const { dispatchDeferredRouteWindowRead, isDeferredRouteWindowReceiptCurrent, toDeferredJointPayload } =
      await import('../messageThunk')
    const state = baseStateLocal('t-bundle', null)
    const getState = () => state
    const { exec } = execDispatchLocal(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-bundle', null, { kind: 'latest' })
    expect(receipt).toBeDefined()
    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
    const req = mocks.fetchMessagesWindow.mock.calls[0][0]
    expect(req.includeStructure).toBe(true)
    expect(isDeferredRouteWindowReceiptCurrent(getState, receipt!)).toBe(true)
    const joint = toDeferredJointPayload(receipt!)
    expect(joint.messages.map((m: any) => m.id)).toEqual(['u1', 'a1'])
    expect(joint.structure).not.toBeNull()
    expect(joint.structure!.catalog.map((c) => c.id)).toEqual(['s1'])
    expect(joint.structure!.route.qualifications[0].routeMemberMessageIds).toEqual(['u1', 'a1'])
  })

  it('missing structure in a required deferred receipt fails closed (null chrome, no backfill)', async () => {
    const { dispatchDeferredRouteWindowRead, toDeferredJointPayload, toDeferredChromeStructure } = await import(
      '../messageThunk'
    )
    mocks.fetchMessagesWindow.mockImplementationOnce(async (req: FetchMessagesWindowRequest) => {
      const full = bundledResponse(req, ['u1'])
      const { structure: _drop, ...rest } = full as unknown as Record<string, unknown>
      return rest as unknown as FetchMessagesWindowResponse
    })
    const state = baseStateLocal('t-bundle', null)
    const getState = () => state
    const { exec } = execDispatchLocal(getState)
    const receipt = await dispatchDeferredRouteWindowRead(exec, getState, 't-bundle', null, { kind: 'latest' })
    expect(receipt).toBeDefined()
    const joint = toDeferredJointPayload(receipt!)
    expect(joint.structure).toBeNull()
    expect(toDeferredChromeStructure(receipt!)).toBeNull()
  })

  it('adopting an unstructured in-flight restore refetches structured (paired read-busy, no backfill)', async () => {
    const { loadRouteMessagesThunk, loadTopicMessagesThunk } = await import('../messageThunk')
    const state = baseStateLocal('t-bundle', null)
    const getState = () => state
    const { exec, seen } = execDispatchLocal(getState)
    // Direct (non-deferred) restore registers an unstructured in-flight read.
    const pRestore = exec(loadRouteMessagesThunk('t-bundle', null))
    // Same-tick bootstrap adopts it instead of fetching a competing latest.
    const pBoot = exec(loadTopicMessagesThunk('t-bundle'))
    await Promise.all([pRestore, pBoot])

    const reqs = mocks.fetchMessagesWindow.mock.calls.map((c) => c[0] as Record<string, unknown>)
    // Exactly two IPCs: the unstructured restore plus the bootstrap's own
    // structured refetch. No third read, no independent catalog backfill.
    expect(reqs.length).toBe(2)
    expect('includeStructure' in reqs[0]).toBe(false)
    expect(reqs[1].includeStructure).toBe(true)
    // Read-busy: every registration completes under the same token (no leak).
    // Both calls share the adopted token, so the pair is balanced by count.
    const regs = seen.filter((a) => typeof a?.type === 'string' && (a.type as string).endsWith('registerWindowRead'))
    const dones = seen.filter((a) => typeof a?.type === 'string' && (a.type as string).endsWith('completeWindowRead'))
    expect(regs.length).toBe(2)
    expect(dones.map((a) => a.payload.requestSeq).sort()).toEqual(regs.map((a) => a.payload.requestSeq).sort())
    // The joint carries the structured refetch (catalog present), never the
    // adopted unstructured window and never a listSegments join.
    const joints = seen.filter((a) => a?.type === 'resident/jointPublishComplete')
    expect(joints.length).toBe(1)
    const jointResponse = joints[0].payload.windowResponse as FetchMessagesWindowResponse
    expect(jointResponse.structure).toBeDefined()
    expect((jointResponse.structure as unknown as { catalog: Array<{ id: string }> }).catalog.map((c) => c.id)).toEqual(
      ['s1']
    )
  })

  it('direct (non-deferred) route read stays lightweight without structure', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const state = baseStateLocal('t-bundle', null)
    const getState = () => state
    const { exec } = execDispatchLocal(getState)
    mocks.fetchMessagesWindow.mockImplementationOnce(async (req: FetchMessagesWindowRequest) =>
      bundledResponse(req, ['u1'])
    )
    await loadRouteMessagesThunk('t-bundle', null)(exec, getState)
    const req = mocks.fetchMessagesWindow.mock.calls[0][0]
    expect('includeStructure' in req).toBe(false)
  })
})
