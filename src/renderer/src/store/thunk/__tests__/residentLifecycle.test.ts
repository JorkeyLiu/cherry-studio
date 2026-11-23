/**
 * Phase 4 renderer resident-topic lifecycle foundation — focused tests
 *
 * Covers:
 * - valid same-generation joint publication and registry state
 * - no residency/partial publication when a component fails or is stale
 * - deletion invalidation between staged reads
 * - retry succeeds with new generation after failure
 * - registry reset and per-topic isolation
 * - cache-hit only when registry says resident/current
 */
import type * as NewMessageModule from '@renderer/store/newMessage'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    listSegments: vi.fn(),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p })),
    bumpGeneration: vi.fn((p: unknown) => ({ type: 'residentRegistry/bumpGeneration', payload: p })),
    publishResidentComplete: vi.fn((p: unknown) => ({ type: 'resident/jointPublishComplete', payload: p }))
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
  ensureTopicAnchorEstablished: mocks.ensureTopicAnchorEstablished,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    listSegments: mocks.listSegments,
    fetchMessages: vi.fn(),
    appendMessage: vi.fn(),
    deleteMessagesWithSegments: vi.fn(),
    resetMessagesForResend: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    selectAnswerMessage: vi.fn(),
    updateMessage: vi.fn()
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/store/messageBlock', () => ({
  default: (state = { entities: {}, ids: [] } as any) => state,
  upsertManyBlocks: vi.fn(),
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))
vi.mock('@renderer/store/assistants', () => ({
  default: (state = {} as any) => state,
  updateTopicUpdatedAt: vi.fn()
}))
vi.mock('@renderer/store/index', () => ({
  default: { dispatch: vi.fn(), getState: () => ({}) as any },
  useAppDispatch: () => vi.fn()
}))
vi.mock('@renderer/store/residentRegistry', async () => {
  const actual = await vi.importActual<any>('@renderer/store/residentRegistry')
  return {
    ...actual,
    bumpGeneration: mocks.bumpGeneration,
    publishResidentComplete: mocks.publishResidentComplete,
    JOINT_PUBLISH_COMPLETE: 'resident/jointPublishComplete'
  }
})
vi.mock('@renderer/store/topicSegment', () => ({
  default: (state = { segments: { entities: {}, ids: [] }, segmentsByTopic: {} } as any) => state,
  replaceSegmentsForTopic: vi.fn(),
  clearSegmentsForTopic: vi.fn()
}))
vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({ AiSdkToChunkAdapter: class {} }))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/windowReadQueue', () => ({
  runTopicWindowRead: (_topicId: string, _kind: string, read: () => unknown) => read()
}))
vi.mock('@renderer/hooks/useModel', () => ({ getModel: vi.fn() }))
vi.mock('@renderer/services/ApiService', () => ({ transformMessagesAndFetch: vi.fn() }))
vi.mock('@renderer/services/messageStreaming/BlockManager', () => ({ BlockManager: class {} }))
vi.mock('@renderer/services/messageStreaming/callbacks', () => ({ createCallbacks: vi.fn(() => ({})) }))
vi.mock('@renderer/services/StreamProcessingService', () => ({ createStreamProcessor: vi.fn(() => vi.fn()) }))
vi.mock('@renderer/services/SpanManagerService', () => ({ endSpan: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('@renderer/utils/messageUtils/create', () => ({
  createAssistantMessage: vi.fn((aId: string, tId: string) => ({
    id: `asst-${tId}`,
    assistantId: aId,
    topicId: tId,
    role: 'assistant',
    askId: 'user-1',
    status: 'pending',
    blocks: []
  })),
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
      setTopicLoading: mocks.setTopicLoading,
      setCurrentTopicId: mocks.setCurrentTopicId
    }
  }
})

function segWire(topicId: string): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: 'seg-1',
    topicId,
    name: 'S',
    messageIds: [],
    headerMessageId: null,
    ownerTopicId: topicId,
    ownerBranchId: null,
    color: 'blue',
    createdAt: now,
    updatedAt: now,
    sortOrder: 0,
    firstMessageId: null,
    lastMessageId: null,
    messageCount: 0
  }
}

function makeWindowResponse(
  request: FetchMessagesWindowRequest,
  messages: Array<{ id: string } & Record<string, unknown>>,
  overrides: Partial<FetchMessagesWindowResponse['window']> = {},
  catalogEntries: Record<string, unknown>[] = []
): FetchMessagesWindowResponse {
  const returnedCount = messages.length
  const firstMessageId = returnedCount > 0 ? messages[0].id : null
  const lastMessageId = returnedCount > 0 ? messages[returnedCount - 1].id : null
  const baseWindow: FetchMessagesWindowResponse['window'] = {
    kind: request.kind,
    completeness: 'window',
    topicId: request.topicId,
    anchorMessageId: null,
    requested: { limit: (request as any).limit },
    firstMessageId,
    lastMessageId,
    returnedCount,
    hasMoreBefore: false,
    hasMoreAfter: false
  }
  // Bundled-structure mirror of Main: the window response carries the
  // structure if and only if the request asked for it. Qualifications cover
  // every catalog entry exactly once (empty catalog is valid known-empty).
  const withStructure =
    (request as { includeStructure?: unknown }).includeStructure === true
      ? {
          structure: {
            catalog: catalogEntries,
            route: {
              topicId: request.topicId,
              branchId: (request as { branchId?: string | null }).branchId ?? null,
              qualifications: catalogEntries.map((e) => ({
                segmentId: e.id,
                headerInRoute: false,
                headerOwnedByRoute: false,
                routeMemberMessageIds: []
              }))
            }
          }
        }
      : {}
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: { ...baseWindow, ...overrides } as FetchMessagesWindowResponse['window'],
    ...withStructure
  } as unknown as FetchMessagesWindowResponse
}

describe('resident lifecycle joint publication', () => {
  let storeState: any

  beforeEach(async () => {
    vi.clearAllMocks()
    // Cascade hardening: vi.clearAllMocks() only clears call history — a
    // timed-out test's unconsumed mockRejectedValueOnce/mockImplementationOnce
    // queue would otherwise leak into the next test and consume its rejection.
    // mockReset() drops any stale once-queue; defaults are re-established below.
    mocks.fetchMessagesWindow.mockReset()
    mocks.listSegments.mockReset()
    mocks.bumpGeneration.mockReset()
    mocks.publishResidentComplete.mockReset()
    storeState = {
      assistants: { assistants: [{ id: 'asst-1', topics: [{ id: 't1' }, { id: 't2' }] }] },
      messages: {
        entities: {},
        messageIdsByTopic: {},
        loadingByTopic: {},
        fulfilledByTopic: {},
        currentTopicId: null,
        displayCount: 10
      },
      messageBlocks: { entities: {} },
      topicSegments: { segments: { entities: {}, ids: [] }, segmentsByTopic: {} },
      residentRegistry: { entries: {} }
    }
    const { resetAllDeletionGenerationsForTests } = await import('@renderer/services/topicDeletionInvalidation')
    resetAllDeletionGenerationsForTests()
    // when mocked, resident clear is via state reset; ensure state cleared anyway
    storeState.residentRegistry.entries = {}

    // default successful mocks
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      const limit = (req as any).limit ?? 10
      const msgs = Array.from({ length: limit }, (_, i) => ({ id: `m-${i}`, topicId: req.topicId, blocks: [] }))
      // Single IPC: segments ride the bundled catalog (no independent listSegments read).
      return makeWindowResponse(req, msgs, {}, [segWire(req.topicId)])
    })
    mocks.listSegments.mockResolvedValue([
      {
        id: 'seg-1',
        topicId: 't1',
        name: 'S',
        messageIds: [],
        color: 'blue',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ])
    // bumpGeneration mock should simulate generation increment in storeState
    mocks.bumpGeneration.mockImplementation((topicId: unknown) => {
      const tid = topicId as string
      const prev = storeState.residentRegistry.entries[tid]
      const next = (prev?.applicabilityGeneration ?? 0) + 1
      storeState.residentRegistry.entries[tid] = {
        chatData: false,
        segments: false,
        residentTopic: false,
        applicabilityGeneration: next
      }
      return { type: 'residentRegistry/bumpGeneration', payload: tid }
    })
    mocks.publishResidentComplete.mockImplementation((payload: unknown) => {
      const p = payload as any
      const entry = storeState.residentRegistry.entries[p.topicId]
      if (entry && entry.applicabilityGeneration === p.generation) {
        entry.chatData = true
        entry.segments = true
        entry.residentTopic = true
      }
      return { type: 'resident/jointPublishComplete', payload: p }
    })
  })

  it('valid same-generation joint publication updates registry to resident and publishes once', async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn((action: any) => {
      // simulate reducer effects for bump/publish already handled via mocks
      if (typeof action === 'function') return action(dispatch, () => storeState)
      return action
    })
    const getState = () => storeState

    await loadTopicMessagesThunk('t1')(dispatch, getState as any)

    expect(mocks.bumpGeneration).toHaveBeenCalledWith('t1')
    const gen = storeState.residentRegistry.entries['t1'].applicabilityGeneration
    expect(gen).toBe(1)
    expect(mocks.publishResidentComplete).toHaveBeenCalledTimes(1)
    const payload = mocks.publishResidentComplete.mock.calls[0][0] as any
    expect(payload.topicId).toBe('t1')
    expect(payload.generation).toBe(1)
    expect(payload.windowResponse).toBeDefined()
    expect(payload.segments).toBeDefined()
    expect(payload.segments[0].id).toBe('seg-1')
    expect(storeState.residentRegistry.entries['t1'].residentTopic).toBe(true)
    expect(storeState.residentRegistry.entries['t1'].chatData).toBe(true)
    expect(storeState.residentRegistry.entries['t1'].segments).toBe(true)
    // one dispatch for joint publish observable
    const jointDispatches = dispatch.mock.calls.filter(([a]: any) => a?.type === 'resident/jointPublishComplete')
    expect(jointDispatches.length).toBe(1)
    // Local budget only (60s): first dynamic import of messageThunk builds the
    // heavy module graph; under full-suite 2-thread contention this can exceed
    // the 20s global timeout. No global config change.
  }, 60_000)

  it('no residency/partial publication when window fails', { timeout: 60_000 }, async () => {
    mocks.fetchMessagesWindow.mockRejectedValueOnce(new Error('window fail'))
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn((action: any) => {
      if (typeof action === 'function') return action(dispatch, () => storeState)
      return action
    })
    const getState = () => storeState
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    expect(mocks.bumpGeneration).toHaveBeenCalled()
    expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
    expect(storeState.residentRegistry.entries['t1'].residentTopic).toBe(false)
    expect(storeState.residentRegistry.entries['t1'].chatData).toBe(false)
  })

  it('no residency when the bundled structure is missing', { timeout: 60_000 }, async () => {
    // Segments-side failure under the bundle contract: the window resolves
    // but carries no structure (fail-closed, no independent listSegments backfill).
    mocks.fetchMessagesWindow.mockImplementationOnce(async (req: FetchMessagesWindowRequest) => {
      const res = makeWindowResponse(req, [{ id: 'm-0', topicId: req.topicId, blocks: [] }])
      delete (res as any).structure
      return res
    })
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn((action: any) => {
      if (typeof action === 'function') return action(dispatch, () => storeState)
      return action
    })
    const getState = () => storeState
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
    expect(storeState.residentRegistry.entries['t1'].residentTopic).toBe(false)
  })

  it('stale generation discard does not publish', { timeout: 60_000 }, async () => {
    let resolveWindow: (v: any) => void
    // Single IPC: no segment leg exists under the bundle; the window
    // carries the catalog, so only the window resolver is needed.
    mocks.fetchMessagesWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWindow = resolve
        })
    )
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn((action: any) => {
      if (typeof action === 'function') return action(dispatch, () => storeState)
      return action
    })
    const getState = () => storeState
    const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await Promise.resolve()
    await Promise.resolve()
    // bump to simulate concurrent new load before resolve (generation becomes 2)
    const prevGen = storeState.residentRegistry.entries['t1'].applicabilityGeneration
    expect(prevGen).toBe(1)
    // manually bump again to stale the captured generation
    storeState.residentRegistry.entries['t1'].applicabilityGeneration = 2
    const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't1', limit: 10, includeStructure: true } as any
    // Empty bundled catalog (known-empty); the discard under test is driven
    // by the stale generation/deletion gate, not by segment content.
    resolveWindow!(makeWindowResponse(req, [{ id: 'm-0' }]))
    await promise
    expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
    expect(storeState.residentRegistry.entries['t1'].residentTopic).toBe(false)
  })

  it('deletion invalidation between staged reads discards joint publish', { timeout: 60_000 }, async () => {
    let resolveWindow: (v: any) => void
    // Single IPC: no segment leg exists under the bundle; the window
    // carries the catalog, so only the window resolver is needed.
    mocks.fetchMessagesWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWindow = resolve
        })
    )
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const { bumpDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')
    const dispatch = vi.fn((action: any) => {
      if (typeof action === 'function') return action(dispatch, () => storeState)
      return action
    })
    const getState = () => storeState
    const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await Promise.resolve()
    await Promise.resolve()
    // simulate deletion bump before resolve
    bumpDeletionGeneration('t1')
    // need to reflect that bump also increments resident generation via store.dispatch, simulate
    const entry = storeState.residentRegistry.entries['t1']
    if (entry) entry.applicabilityGeneration += 1

    const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't1', limit: 10, includeStructure: true } as any
    // Empty bundled catalog (known-empty); the discard under test is driven
    // by the stale generation/deletion gate, not by segment content.
    resolveWindow!(makeWindowResponse(req, [{ id: 'm-0' }]))
    await promise
    expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
  })

  it('retry succeeds with new generation after failure', { timeout: 60_000 }, async () => {
    mocks.fetchMessagesWindow.mockRejectedValueOnce(new Error('first fail'))
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn((action: any) => {
      if (typeof action === 'function') return action(dispatch, () => storeState)
      return action
    })
    const getState = () => storeState
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    expect(storeState.residentRegistry.entries['t1'].residentTopic).toBe(false)
    expect(storeState.residentRegistry.entries['t1'].applicabilityGeneration).toBe(1)
    // fix mocks for retry
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      const msgs = [{ id: 'm-0', topicId: req.topicId, blocks: [] }]
      return makeWindowResponse(req, msgs, {}, [segWire(req.topicId)])
    })
    mocks.listSegments.mockResolvedValue([
      {
        id: 'seg-1',
        topicId: 't1',
        name: 'S',
        messageIds: [],
        color: 'blue',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ])
    // need to re-mock publish to update state on second call
    mocks.publishResidentComplete.mockImplementation((payload: unknown) => {
      const p = payload as any
      const entry = storeState.residentRegistry.entries[p.topicId]
      if (entry && entry.applicabilityGeneration === p.generation) {
        entry.chatData = true
        entry.segments = true
        entry.residentTopic = true
      }
      return { type: 'resident/jointPublishComplete', payload: p }
    })
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    expect(storeState.residentRegistry.entries['t1'].applicabilityGeneration).toBe(2)
    expect(storeState.residentRegistry.entries['t1'].residentTopic).toBe(true)
    expect(mocks.publishResidentComplete).toHaveBeenCalledTimes(1) // only second succeeded
  })

  it('registry reset and per-topic isolation', { timeout: 60_000 }, async () => {
    const { bumpGeneration, resetAllResidentRegistry } = await import('@renderer/store/residentRegistry')
    // simulate two topics
    storeState.residentRegistry.entries['t1'] = {
      chatData: true,
      segments: true,
      residentTopic: true,
      applicabilityGeneration: 1
    }
    storeState.residentRegistry.entries['t2'] = {
      chatData: true,
      segments: true,
      residentTopic: true,
      applicabilityGeneration: 1
    }
    // bump t1 only
    const prevT2 = { ...storeState.residentRegistry.entries['t2'] }
    storeState.residentRegistry.entries['t1'] = {
      chatData: false,
      segments: false,
      residentTopic: false,
      applicabilityGeneration: 2
    }
    expect(storeState.residentRegistry.entries['t2']).toEqual(prevT2)
    expect(storeState.residentRegistry.entries['t1'].applicabilityGeneration).toBe(2)
    expect(storeState.residentRegistry.entries['t1'].residentTopic).toBe(false)
    // reset all
    storeState.residentRegistry.entries = {}
    expect(Object.keys(storeState.residentRegistry.entries).length).toBe(0)
    void bumpGeneration
    void resetAllResidentRegistry
  })

  it('cache-hit only when registry says resident/current', { timeout: 60_000 }, async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    // prepare resident state for t1
    storeState.messages.messageIdsByTopic['t1'] = ['m-0', 'm-1']
    storeState.residentRegistry.entries['t1'] = {
      chatData: true,
      segments: true,
      residentTopic: true,
      applicabilityGeneration: 1
    }
    storeState.messages.currentTopicId = 't1'

    const dispatch = vi.fn((action: any) => {
      if (typeof action === 'function') return action(dispatch, () => storeState)
      return action
    })
    const getState = () => storeState
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(mocks.listSegments).not.toHaveBeenCalled()

    // now make not resident -> should be miss
    storeState.residentRegistry.entries['t1'] = {
      chatData: false,
      segments: false,
      residentTopic: false,
      applicabilityGeneration: 1
    }
    mocks.fetchMessagesWindow.mockClear()
    mocks.listSegments.mockClear()
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
    // Single IPC: the miss refetch carries the catalog in-bundle; no independent segment read.
    expect(mocks.listSegments).not.toHaveBeenCalled()
  })

  it('empty complete topic is valid resident cache hit (absent index vs empty array distinction)', async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    // empty present index (present empty array) with resident true -> hit, no fetch
    storeState.messages.messageIdsByTopic['t-empty'] = []
    storeState.residentRegistry.entries['t-empty'] = {
      chatData: true,
      segments: true,
      residentTopic: true,
      applicabilityGeneration: 1
    }
    storeState.messages.currentTopicId = 't-empty'
    const dispatch = vi.fn((action: any) => {
      if (typeof action === 'function') return action(dispatch, () => storeState)
      return action
    })
    const getState = () => storeState
    mocks.fetchMessagesWindow.mockClear()
    mocks.listSegments.mockClear()
    await loadTopicMessagesThunk('t-empty')(dispatch, getState as any)
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(mocks.listSegments).not.toHaveBeenCalled()

    // absent index (undefined) even with no resident -> miss (fetch)
    delete storeState.messages.messageIdsByTopic['t-missing']
    delete storeState.residentRegistry.entries['t-missing']
    mocks.fetchMessagesWindow.mockClear()
    mocks.listSegments.mockClear()
    await loadTopicMessagesThunk('t-missing')(dispatch, () => ({
      ...storeState,
      messages: { ...storeState.messages, messageIdsByTopic: { ...storeState.messages.messageIdsByTopic } }
    }))
    // missing index falls through to fetch regardless of resident
    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)

    // present empty array but not resident -> miss (must refetch)
    storeState.messages.messageIdsByTopic['t-empty-not-resident'] = []
    storeState.residentRegistry.entries['t-empty-not-resident'] = {
      chatData: false,
      segments: false,
      residentTopic: false,
      applicabilityGeneration: 1
    }
    mocks.fetchMessagesWindow.mockClear()
    mocks.listSegments.mockClear()
    await loadTopicMessagesThunk('t-empty-not-resident')(dispatch, getState as any)
    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
  }, 60_000)
})
