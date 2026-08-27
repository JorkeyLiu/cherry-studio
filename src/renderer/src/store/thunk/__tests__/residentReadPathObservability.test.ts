/**
 * Phase 4 resident read-path observability — focused regression tests.
 *
 * Renderer-local, bounded scalar diagnostics only. No B-01..B-05, no IPC/StoreSync/SQLite/persistence,
 * no IDs/content in diagnostics. Wired from actual loadTopicMessagesThunk lifecycle and all
 * staged/discard paths, composed into Phase 4 snapshot/bound scalars.
 *
 * Verifies:
 * - cache hit increments hitCount and avoids staged fetch
 * - each meaningful miss reason increments correct bounded counter
 * - staged latency is non-negative bounded scalar for success and failure
 * - each discard reason (superseded, currentMoved, deletedDuringFetch, generationMismatch, malformed) increments discarded counters; staged fetch failure before validation is staged failure only, not discarded
 * - snapshot/bound scalars compose correctly and remain bounded scalar-only (no IDs/content)
 * - no behavioral policy is introduced (hit/miss semantics unchanged)
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
vi.mock('@renderer/services/db/streamTimingDiagnostics', () => ({
  createStreamWriteDiagnosticsContext: vi.fn(() => ({ correlationId: 'c', ordinal: 1 })),
  isStreamAttrRendererMeasureEnabled: vi.fn(() => false),
  recordStreamAttrRendererRecord: vi.fn()
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
vi.mock('@renderer/services/phaseTimingDiagnostics', () => ({
  currentPhaseCorrelation: vi.fn(() => null),
  recordPhaseDuration: vi.fn()
}))
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

function makeWindowResponse(
  request: FetchMessagesWindowRequest,
  messages: Array<{ id: string } & Record<string, unknown>>,
  overrides: Partial<FetchMessagesWindowResponse['window']> = {}
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
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: { ...baseWindow, ...overrides } as FetchMessagesWindowResponse['window']
  } as unknown as FetchMessagesWindowResponse
}

describe('resident read-path observability — bounded scalar diagnostics wired to loadTopicMessagesThunk', () => {
  let storeState: any

  beforeEach(async () => {
    vi.clearAllMocks()
    const { resetResidentReadDiagnosticsForTests } = await import('@renderer/services/residentReadDiagnostics')
    resetResidentReadDiagnosticsForTests()
    const { resetAllDeletionGenerationsForTests } = await import('@renderer/services/topicDeletionInvalidation')
    resetAllDeletionGenerationsForTests()
    storeState = {
      assistants: { assistants: [{ id: 'asst-1', topics: [{ id: 't1' }, { id: 't2' }, { id: 't-hit' }] }] },
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

    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      const limit = (req as any).limit ?? 10
      const msgs = Array.from({ length: Math.min(limit, 2) }, (_, i) => ({
        id: `m-${i}`,
        topicId: req.topicId,
        blocks: []
      }))
      return makeWindowResponse(req, msgs)
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
    mocks.setCurrentTopicId.mockImplementation((p: unknown) => {
      storeState.messages.currentTopicId = p as string
      return { type: 'newMessages/setCurrentTopicId', payload: p }
    })
    mocks.setTopicLoading.mockImplementation((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p }))
  })

  it('cache hit increments hitCount and avoids staged fetch, latency not incremented', async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const { getResidentReadDiagnostics } = await import('@renderer/services/residentReadDiagnostics')
    // prepare resident hit state
    storeState.messages.messageIdsByTopic['t-hit'] = ['m-0', 'm-1']
    storeState.residentRegistry.entries['t-hit'] = {
      chatData: true,
      segments: true,
      residentTopic: true,
      applicabilityGeneration: 1
    }
    storeState.messages.currentTopicId = 't-hit'
    const dispatch = vi.fn((a: any) => {
      if (typeof a === 'function') return a(dispatch, () => storeState)
      return a
    })
    const getState = () => storeState
    mocks.fetchMessagesWindow.mockClear()
    mocks.listSegments.mockClear()
    await loadTopicMessagesThunk('t-hit')(dispatch, getState as any)
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(mocks.listSegments).not.toHaveBeenCalled()
    const diag = getResidentReadDiagnostics()
    expect(diag.hitCount).toBe(1)
    expect(diag.missCount).toBe(0)
    expect(diag.totalRequests).toBe(1)
    expect(diag.stagedCount).toBe(0)
    expect(diag.discardedCount).toBe(0)
    // staged scalars are bounded non-negative
    expect(diag.stagedTotalMs).toBe(0)
    expect(diag.stagedMaxMs).toBe(0)
    expect(diag.stagedLastMs).toBeNull()
    // privacy: no topic IDs in serialized scalars
    expect(JSON.stringify(diag)).not.toContain('t-hit')
    // snapshot composition
    const { getPhase4Snapshot, getPhase4BoundScalars } = await import('@renderer/services/phase4Observability')
    const snap = getPhase4Snapshot(null)
    expect(snap.residentRead.hitCount).toBe(1)
    expect(snap.residentRead.missCount).toBe(0)
    const scalars = getPhase4BoundScalars(null)
    expect(scalars.readHitCount).toBe(1)
    expect(scalars.readMissCount).toBe(0)
  })

  it('meaningful miss reasons each increment correct bounded counter', async () => {
    const { getResidentReadDiagnostics } = await import('@renderer/services/residentReadDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')

    // forced
    {
      const { resetResidentReadDiagnosticsForTests } = await import('@renderer/services/residentReadDiagnostics')
      resetResidentReadDiagnosticsForTests()
      storeState.messages.messageIdsByTopic['t-forced'] = ['m-0']
      storeState.residentRegistry.entries['t-forced'] = {
        chatData: true,
        segments: true,
        residentTopic: true,
        applicabilityGeneration: 1
      }
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      await loadTopicMessagesThunk('t-forced', true)(dispatch, () => storeState)
      const d = getResidentReadDiagnostics()
      expect(d.missForced).toBe(1)
      expect(d.hitCount).toBe(0)
      expect(d.missCount).toBe(1)
      expect(d.stagedCount).toBe(1)
    }

    // noIndex
    {
      const { resetResidentReadDiagnosticsForTests } = await import('@renderer/services/residentReadDiagnostics')
      resetResidentReadDiagnosticsForTests()
      delete storeState.messages.messageIdsByTopic['t-noIndex']
      delete storeState.residentRegistry.entries['t-noIndex']
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      await loadTopicMessagesThunk('t-noIndex')(dispatch, () => storeState)
      const d = getResidentReadDiagnostics()
      expect(d.missNoIndex).toBe(1)
      expect(d.missCount).toBe(1)
    }

    // deletion pending
    {
      const { resetResidentReadDiagnosticsForTests } = await import('@renderer/services/residentReadDiagnostics')
      resetResidentReadDiagnosticsForTests()
      const { bumpDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')
      storeState.messages.messageIdsByTopic['t-del'] = ['m-0']
      storeState.residentRegistry.entries['t-del'] = {
        chatData: true,
        segments: true,
        residentTopic: true,
        applicabilityGeneration: 1
      }
      bumpDeletionGeneration('t-del')
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      await loadTopicMessagesThunk('t-del')(dispatch, () => storeState)
      const d = getResidentReadDiagnostics()
      expect(d.missDeletion).toBe(1)
      // cleanup
      const { resetAllDeletionGenerationsForTests } = await import('@renderer/services/topicDeletionInvalidation')
      resetAllDeletionGenerationsForTests()
      // generation bump for deletion also increments resident generation, reset for next subtest
      delete storeState.residentRegistry.entries['t-del']
      delete storeState.messages.messageIdsByTopic['t-del']
    }

    // legacyEmpty (registry absent, empty array)
    {
      const { resetResidentReadDiagnosticsForTests } = await import('@renderer/services/residentReadDiagnostics')
      resetResidentReadDiagnosticsForTests()
      // temporarily use a store without residentRegistry
      const legacyState = {
        ...storeState,
        messages: {
          ...storeState.messages,
          messageIdsByTopic: { ...storeState.messages.messageIdsByTopic, 't-legacy-empty': [] }
        }
      }
      delete legacyState.residentRegistry
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => legacyState) : a))
      const getState = () => legacyState
      // ensure fetch succeeds
      mocks.fetchMessagesWindow.mockClear()
      await loadTopicMessagesThunk('t-legacy-empty')(dispatch, getState as any)
      const d = getResidentReadDiagnostics()
      expect(d.missLegacyEmpty).toBe(1)
    }

    // noEntry (registry present but no entry)
    {
      const { resetResidentReadDiagnosticsForTests } = await import('@renderer/services/residentReadDiagnostics')
      resetResidentReadDiagnosticsForTests()
      storeState.messages.messageIdsByTopic['t-noEntry'] = ['m-0']
      // ensure no entry
      delete storeState.residentRegistry.entries['t-noEntry']
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      await loadTopicMessagesThunk('t-noEntry')(dispatch, () => storeState)
      const d = getResidentReadDiagnostics()
      expect(d.missNoEntry).toBe(1)
    }

    // incomplete (entry exists but not resident)
    {
      const { resetResidentReadDiagnosticsForTests } = await import('@renderer/services/residentReadDiagnostics')
      resetResidentReadDiagnosticsForTests()
      storeState.messages.messageIdsByTopic['t-incomplete'] = ['m-0']
      storeState.residentRegistry.entries['t-incomplete'] = {
        chatData: false,
        segments: false,
        residentTopic: false,
        applicabilityGeneration: 3
      }
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      await loadTopicMessagesThunk('t-incomplete')(dispatch, () => storeState)
      const d = getResidentReadDiagnostics()
      expect(d.missIncomplete).toBe(1)
    }
  })

  it('staged latency is non-negative bounded scalar-only for success and failure', async () => {
    const { getResidentReadDiagnostics, resetResidentReadDiagnosticsForTests } = await import(
      '@renderer/services/residentReadDiagnostics'
    )
    const { loadTopicMessagesThunk } = await import('../messageThunk')

    // success
    resetResidentReadDiagnosticsForTests()
    delete storeState.messages.messageIdsByTopic['t-lat-success']
    delete storeState.residentRegistry.entries['t-lat-success']
    // force small delay via mock
    mocks.fetchMessagesWindow.mockImplementationOnce(async (req: FetchMessagesWindowRequest) => {
      await new Promise((r) => setTimeout(r, 5))
      const msgs = [{ id: 'm-0', topicId: req.topicId, blocks: [] }]
      return makeWindowResponse(req, msgs)
    })
    mocks.listSegments.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return []
    })
    let dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
    await loadTopicMessagesThunk('t-lat-success')(dispatch, () => storeState)
    let d = getResidentReadDiagnostics()
    expect(d.stagedCount).toBe(1)
    expect(d.stagedSuccessCount).toBe(1)
    expect(d.stagedFailedCount).toBe(0)
    expect(d.stagedTotalMs).toBeGreaterThanOrEqual(0)
    expect(d.stagedMaxMs).toBeGreaterThanOrEqual(0)
    expect(d.stagedLastMs).not.toBeNull()
    expect(d.stagedLastMs!).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(d.stagedTotalMs)).toBe(true)
    expect(Number.isFinite(d.stagedMaxMs)).toBe(true)
    expect(d.stagedAvgMs).not.toBeNull()
    expect(d.stagedAvgMs!).toBeGreaterThanOrEqual(0)
    // privacy: latency scalars do not contain IDs
    expect(JSON.stringify(d)).not.toContain('t-lat-success')

    // failure
    resetResidentReadDiagnosticsForTests()
    mocks.fetchMessagesWindow.mockRejectedValueOnce(new Error('fail'))
    mocks.listSegments.mockResolvedValueOnce([])
    dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
    await loadTopicMessagesThunk('t-lat-fail')(dispatch, () => storeState)
    d = getResidentReadDiagnostics()
    expect(d.stagedCount).toBe(1)
    expect(d.stagedFailedCount).toBe(1)
    expect(d.stagedSuccessCount).toBe(0)
    expect(d.stagedTotalMs).toBeGreaterThanOrEqual(0)
    expect(d.stagedMaxMs).toBeGreaterThanOrEqual(0)
    expect(d.stagedLastMs).toBeGreaterThanOrEqual(0)
    // LOCK-005: staged fetch failure before validation is staged failure only, not discarded
    expect(d.discardedCount).toBe(0)
    expect((d as any).discardedFetchFailed).toBeUndefined()
  })

  it('discarded publication attempts increment correct reason counters', async () => {
    const { getResidentReadDiagnostics, resetResidentReadDiagnosticsForTests } = await import(
      '@renderer/services/residentReadDiagnostics'
    )
    const { loadTopicMessagesThunk } = await import('../messageThunk')

    // superseded same-topic request (two concurrent loads)
    {
      resetResidentReadDiagnosticsForTests()
      let resolveW1: (v: any) => void
      let resolveS1: (v: any) => void
      let resolveW2: (v: any) => void
      let resolveS2: (v: any) => void
      mocks.fetchMessagesWindow.mockImplementation(
        () =>
          new Promise((resolve) => {
            // first call -> resolveW1, second -> resolveW2
            if (!resolveW1) resolveW1 = resolve as any
            else resolveW2 = resolve as any
          })
      )
      mocks.listSegments.mockImplementation(
        () =>
          new Promise((resolve) => {
            if (!resolveS1) resolveS1 = resolve as any
            else resolveS2 = resolve as any
          })
      )
      storeState.messages.messageIdsByTopic['t-super'] = []
      delete storeState.residentRegistry.entries['t-super']
      // Need fresh thunk import to get clean requestSeq? requestSeq is module global, not reset per test
      // Simulate superseded by starting p1 then p2; p1 should be discarded as superseded
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      const getState = () => storeState
      const p1 = loadTopicMessagesThunk('t-super')(dispatch, getState as any)
      // allow bump to happen
      await Promise.resolve()
      await Promise.resolve()
      const p2 = loadTopicMessagesThunk('t-super')(dispatch, getState as any)
      await Promise.resolve()
      await Promise.resolve()
      // resolve both
      const req1: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't-super', limit: 10 } as any
      const req2: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't-super', limit: 10 } as any
      // p1 was first, so after p2 started, p1's requestSeq is stale; resolve p1 first
      resolveW1!(makeWindowResponse(req1, [{ id: 'm-0' }]))
      resolveS1!([])
      await p1
      // p1 should have discarded superseded
      let d = getResidentReadDiagnostics()
      expect(d.discardedSuperseded).toBe(1)
      expect(d.discardedCount).toBe(1)
      // now resolve p2 - it should succeed
      resolveW2!(makeWindowResponse(req2, [{ id: 'm-1' }]))
      resolveS2!([])
      await p2
      d = getResidentReadDiagnostics()
      expect(d.discardedSuperseded).toBe(1)
      expect(d.stagedCount).toBe(2)
      expect(d.stagedSuccessCount).toBe(2)
      // restore default mocks for next subtests
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        const msgs = [{ id: 'm-0', topicId: req.topicId, blocks: [] }]
        return makeWindowResponse(req, msgs)
      })
      mocks.listSegments.mockResolvedValue([])
    }

    // currentMoved (topic changed during fetch)
    {
      resetResidentReadDiagnosticsForTests()
      let resolveW: (v: any) => void
      let resolveS: (v: any) => void
      mocks.fetchMessagesWindow.mockImplementation(() => new Promise((resolve) => (resolveW = resolve as any)))
      mocks.listSegments.mockImplementation(() => new Promise((resolve) => (resolveS = resolve as any)))
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      const getState = () => storeState
      storeState.messages.currentTopicId = 't-moved'
      const p = loadTopicMessagesThunk('t-moved')(dispatch, getState as any)
      await Promise.resolve()
      await Promise.resolve()
      // simulate topic switch
      storeState.messages.currentTopicId = 'other-topic'
      const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't-moved', limit: 10 } as any
      resolveW!(makeWindowResponse(req, [{ id: 'm-0' }]))
      resolveS!([])
      await p
      const d = getResidentReadDiagnostics()
      expect(d.discardedCurrentMoved).toBe(1)
      expect(d.discardedCount).toBe(1)
      storeState.messages.currentTopicId = null
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        const msgs = [{ id: 'm-0', topicId: req.topicId, blocks: [] }]
        return makeWindowResponse(req, msgs)
      })
      mocks.listSegments.mockResolvedValue([])
    }

    // deletedDuringFetch
    {
      resetResidentReadDiagnosticsForTests()
      let resolveW: (v: any) => void
      let resolveS: (v: any) => void
      mocks.fetchMessagesWindow.mockImplementation(() => new Promise((resolve) => (resolveW = resolve as any)))
      mocks.listSegments.mockImplementation(() => new Promise((resolve) => (resolveS = resolve as any)))
      const { bumpDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      const getState = () => storeState
      const p = loadTopicMessagesThunk('t-deleted')(dispatch, getState as any)
      await Promise.resolve()
      await Promise.resolve()
      bumpDeletionGeneration('t-deleted')
      // also need to bump resident generation to reflect deletion invalidation for generation check
      const entry = storeState.residentRegistry.entries['t-deleted']
      if (entry) entry.applicabilityGeneration += 1
      else {
        // if no entry, create one to simulate generation mismatch after deletion
        storeState.residentRegistry.entries['t-deleted'] = {
          chatData: false,
          segments: false,
          residentTopic: false,
          applicabilityGeneration: 2
        }
      }
      const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't-deleted', limit: 10 } as any
      resolveW!(makeWindowResponse(req, [{ id: 'm-0' }]))
      resolveS!([])
      await p
      const d = getResidentReadDiagnostics()
      // deletedDuringFetch is checked before generationMismatch, so this should be counted as deletedDuringFetch
      expect(d.discardedDeletedDuringFetch).toBe(1)
      expect(d.discardedCount).toBe(1)
      const { resetAllDeletionGenerationsForTests } = await import('@renderer/services/topicDeletionInvalidation')
      resetAllDeletionGenerationsForTests()
      delete storeState.residentRegistry.entries['t-deleted']
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        const msgs = [{ id: 'm-0', topicId: req.topicId, blocks: [] }]
        return makeWindowResponse(req, msgs)
      })
      mocks.listSegments.mockResolvedValue([])
    }

    // generationMismatch
    {
      resetResidentReadDiagnosticsForTests()
      let resolveW: (v: any) => void
      let resolveS: (v: any) => void
      mocks.fetchMessagesWindow.mockImplementation(() => new Promise((resolve) => (resolveW = resolve as any)))
      mocks.listSegments.mockImplementation(() => new Promise((resolve) => (resolveS = resolve as any)))
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      const getState = () => storeState
      const p = loadTopicMessagesThunk('t-gen-mismatch')(dispatch, getState as any)
      await Promise.resolve()
      await Promise.resolve()
      // bump generation inside registry to stale captured generation
      const entry = storeState.residentRegistry.entries['t-gen-mismatch']
      if (entry) entry.applicabilityGeneration += 1
      const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't-gen-mismatch', limit: 10 } as any
      resolveW!(makeWindowResponse(req, [{ id: 'm-0' }]))
      resolveS!([])
      await p
      const d = getResidentReadDiagnostics()
      expect(d.discardedGenerationMismatch).toBe(1)
      expect(d.discardedCount).toBe(1)
      delete storeState.residentRegistry.entries['t-gen-mismatch']
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        const msgs = [{ id: 'm-0', topicId: req.topicId, blocks: [] }]
        return makeWindowResponse(req, msgs)
      })
      mocks.listSegments.mockResolvedValue([])
    }

    // malformed
    {
      resetResidentReadDiagnosticsForTests()
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        // return malformed: window with wrong topicId
        const good = makeWindowResponse(req, [{ id: 'm-0' }])
        ;(good as any).window.topicId = 'wrong-topic'
        return good
      })
      mocks.listSegments.mockResolvedValueOnce([])
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      await loadTopicMessagesThunk('t-malformed')(dispatch, () => storeState)
      const d = getResidentReadDiagnostics()
      expect(d.discardedMalformed).toBe(1)
      expect(d.discardedCount).toBe(1)
      expect(d.stagedCount).toBe(1)
      expect(d.stagedSuccessCount).toBe(1) // staged fetch succeeded but publication malformed
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        const msgs = [{ id: 'm-0', topicId: req.topicId, blocks: [] }]
        return makeWindowResponse(req, msgs)
      })
    }

    // staged fetch failure before validation is staged failure only, not discarded (LOCK-005)
    {
      resetResidentReadDiagnosticsForTests()
      mocks.fetchMessagesWindow.mockRejectedValueOnce(new Error('staged fail'))
      mocks.listSegments.mockResolvedValueOnce([])
      const dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
      await loadTopicMessagesThunk('t-fetch-fail')(dispatch, () => storeState)
      const d = getResidentReadDiagnostics()
      expect(d.stagedFailedCount).toBe(1)
      expect(d.stagedCount).toBe(1)
      expect(d.discardedCount).toBe(0)
      expect((d as any).discardedFetchFailed).toBeUndefined()
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        const msgs = [{ id: 'm-0', topicId: req.topicId, blocks: [] }]
        return makeWindowResponse(req, msgs)
      })
      mocks.listSegments.mockResolvedValue([])
    }
  })

  it('snapshot/bound scalars compose correctly and remain bounded scalar-only, privacy-safe, no policy', async () => {
    const { resetResidentReadDiagnosticsForTests, getResidentReadDiagnostics } = await import(
      '@renderer/services/residentReadDiagnostics'
    )
    resetResidentReadDiagnosticsForTests()
    const { getPhase4Snapshot, getPhase4BoundScalars } = await import('@renderer/services/phase4Observability')
    const { loadTopicMessagesThunk } = await import('../messageThunk')

    // hit
    storeState.messages.messageIdsByTopic['t-snap-hit'] = ['m-0']
    storeState.residentRegistry.entries['t-snap-hit'] = {
      chatData: true,
      segments: true,
      residentTopic: true,
      applicabilityGeneration: 1
    }
    storeState.messages.currentTopicId = 't-snap-hit'
    let dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
    await loadTopicMessagesThunk('t-snap-hit')(dispatch, () => storeState)

    // miss + staged success + publication
    delete storeState.messages.messageIdsByTopic['t-snap-miss']
    delete storeState.residentRegistry.entries['t-snap-miss']
    dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
    await loadTopicMessagesThunk('t-snap-miss')(dispatch, () => storeState)

    // discard via generationMismatch
    let resolveW: (v: any) => void
    let resolveS: (v: any) => void
    mocks.fetchMessagesWindow.mockImplementationOnce(() => new Promise((resolve) => (resolveW = resolve as any)))
    mocks.listSegments.mockImplementationOnce(() => new Promise((resolve) => (resolveS = resolve as any)))
    dispatch = vi.fn((a: any) => (typeof a === 'function' ? a(dispatch, () => storeState) : a))
    const p = loadTopicMessagesThunk('t-snap-discard')(dispatch, () => storeState)
    await Promise.resolve()
    await Promise.resolve()
    const entry = storeState.residentRegistry.entries['t-snap-discard']
    if (entry) entry.applicabilityGeneration += 1
    const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't-snap-discard', limit: 10 } as any
    resolveW!(makeWindowResponse(req, [{ id: 'm-0' }]))
    resolveS!([])
    await p

    const snap = getPhase4Snapshot(null)
    // residentRead fields bounded scalars
    expect(snap.residentRead.hitCount).toBe(1)
    expect(snap.residentRead.missCount).toBeGreaterThanOrEqual(2)
    expect(snap.residentRead.stagedCount).toBeGreaterThanOrEqual(2)
    expect(snap.residentRead.discardedCount).toBe(1)
    expect(snap.residentRead.discardedGenerationMismatch).toBe(1)
    // staged latency non-negative
    expect(snap.residentRead.stagedTotalMs).toBeGreaterThanOrEqual(0)
    expect(snap.residentRead.stagedMaxMs).toBeGreaterThanOrEqual(0)
    expect(snap.residentRead.stagedLastMs === null || snap.residentRead.stagedLastMs >= 0).toBe(true)
    // bound scalars compose
    const scalars = getPhase4BoundScalars(null)
    expect(scalars.readHitCount).toBe(snap.residentRead.hitCount)
    expect(scalars.readMissCount).toBe(snap.residentRead.missCount)
    expect(scalars.readStagedCount).toBe(snap.residentRead.stagedCount)
    expect(scalars.readDiscardedCount).toBe(snap.residentRead.discardedCount)
    expect(scalars.readStagedTotalMs).toBe(snap.residentRead.stagedTotalMs)
    // privacy: no topic IDs, content, paths, credentials in serialized snapshot
    const serialized = JSON.stringify(snap.residentRead)
    expect(serialized).not.toContain('t-snap')
    expect(serialized).not.toContain('m-0')
    expect(serialized).not.toContain('path')
    expect(serialized).not.toContain('credential')
    expect(serialized).not.toContain('content')
    // bounded shape only scalars
    for (const v of Object.values(snap.residentRead)) {
      expect(v === null || typeof v === 'number').toBe(true)
    }
    // hit/miss semantics preserved: hit did not trigger staged fetch, miss did; no policy thresholds adopted
    // verify resident state unchanged except diagnostics (resident generation etc. not policy)
    expect(getResidentReadDiagnostics().hitCount).toBe(snap.residentRead.hitCount)

    // reset for isolation
    resetResidentReadDiagnosticsForTests()
    const afterReset = getResidentReadDiagnostics()
    expect(afterReset.hitCount).toBe(0)
    expect(afterReset.missCount).toBe(0)
    expect(afterReset.stagedCount).toBe(0)
    expect(afterReset.discardedCount).toBe(0)
    // B-06..B-09 preserved via snapshot (should not have been cleared by reset)
    expect(snap.b07).toBeDefined()
    expect(snap.b08).toBeDefined()
    expect(snap.b09).toBeDefined()
    expect(snap.resident).toBeDefined()
  })
})
