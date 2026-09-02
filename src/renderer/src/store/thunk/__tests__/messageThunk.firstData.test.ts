/**
 * S7.14-E1 — thunk-level firstData attribution (renderer-local, default-off).
 * Deterministic coverage for active-topic success/rejection, and explicit
 * no-topic/cache-hit/non-startup/stale behavior as supported by seams.
 * Bounded privacy-safe numeric-only attribution, one-shot, fail-closed.
 * Blocker fix: eligibility independent of own setCurrentTopicId dispatch (topic
 * existence before mutation) and cache-hit/unknown closes window.
 */
import { STARTUP_STAGE_VALIDATED_ENV } from '@shared/diagnostics/startupStage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks — mirrors windowS61 but keeps real startupStageDiagnostics
const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    listSegments: vi.fn(),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p })),
    bumpGeneration: vi.fn((p: unknown) => ({ type: 'residentRegistry/bumpGeneration', payload: p })),
    publishResidentComplete: vi.fn((p: unknown) => ({ type: 'resident/jointPublishComplete', payload: p })),
    updateTopicUpdatedAt: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
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
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: vi.fn()
}))
vi.mock('@renderer/store/messageBlock', () => ({
  default: (state = { entities: {}, ids: [] } as any) => state,
  upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))
vi.mock('@renderer/store/assistants', () => ({
  default: (state = {} as any) => state,
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt,
  updateAssistantSettings: vi.fn((p: unknown) => ({ type: 'updateAssistantSettings', payload: p }))
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
vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: vi.fn(() => () => Promise.resolve())
}))
vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({ AiSdkToChunkAdapter: class {} }))
vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: vi.fn() }),
  waitForTopicQueue: vi.fn()
}))
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
  const actual = await vi.importActual<any>('@renderer/store/newMessage')
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      setTopicLoading: mocks.setTopicLoading,
      setCurrentTopicId: mocks.setCurrentTopicId,
      messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p }))
    }
  }
})

function makeWindowResponse(req: any, messages: any[], overrides: any = {}) {
  const returnedCount = messages.length
  const firstMessageId = returnedCount > 0 ? messages[0].id : null
  const lastMessageId = returnedCount > 0 ? messages[returnedCount - 1].id : null
  const baseWindow = {
    kind: req.kind,
    completeness: 'window',
    topicId: req.topicId,
    anchorMessageId: req.kind === 'around' ? req.anchorMessageId : null,
    requested: req.kind === 'latest' ? { limit: req.limit } : { before: req.before, after: req.after },
    firstMessageId,
    lastMessageId,
    returnedCount,
    hasMoreBefore: false,
    hasMoreAfter: false
  }
  return {
    messages: messages as any,
    blocks: [] as any,
    window: { ...baseWindow, ...overrides }
  } as any
}

// Helper that reproduces production reducer mutation for setCurrentTopicId
function makeDispatch(storeState: any) {
  const fn = vi.fn((action: any) => {
    try {
      if (action && typeof action.type === 'string') {
        if (action.type === 'newMessages/setCurrentTopicId') {
          const topicId = action.payload as string | null
          // Mirror messagesSlice setCurrentTopicId reducer
          storeState.messages.currentTopicId = topicId
          if (topicId && !(topicId in storeState.messages.messageIdsByTopic)) {
            storeState.messages.messageIdsByTopic[topicId] = []
            if (!(topicId in storeState.messages.loadingByTopic)) storeState.messages.loadingByTopic[topicId] = false
          }
          // Also invoke the mocked action creator for tracking
          mocks.setCurrentTopicId(topicId)
        } else if (action.type === 'newMessages/setTopicLoading') {
          const { topicId, loading } = action.payload
          storeState.messages.loadingByTopic[topicId] = loading
          mocks.setTopicLoading(action.payload)
        } else if (action.type === 'residentRegistry/bumpGeneration') {
          // Delegate to mocked implementation that already mutates entries
          mocks.bumpGeneration(action.payload)
        } else if (action.type === 'resident/jointPublishComplete') {
          mocks.publishResidentComplete(action.payload)
        }
      }
    } catch {}
    return action
  })
  return fn
}

describe('S7.14-E1 thunk firstData attribution — active-topic, stale, cache-hit, no-topic', () => {
  let storeState: any

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    // Enable diagnostics in isolated Vitest seam
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    if (!(globalThis as any).process) (globalThis as any).process = { env: { VITEST: 'true' } }
    else (globalThis as any).process.env.VITEST = 'true'
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    ;(globalThis as any).window = {}
    try {
      const diag = await import('@renderer/services/startupStageDiagnostics')
      diag.resetStartupState()
    } catch {}
    storeState = {
      assistants: { assistants: [{ id: 'asst-1', topics: [{ id: 't1' }, { id: 't2' }] }] },
      messages: {
        entities: {},
        messageIdsByTopic: {},
        loadingByTopic: {},
        fulfilledByTopic: {},
        currentTopicId: 't1',
        displayCount: 10
      },
      messageBlocks: { entities: {} },
      residentRegistry: { entries: {} }
    }
    mocks.listSegments.mockResolvedValue([])
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
    mocks.fetchMessagesWindow.mockImplementation(async (req: any) => {
      if (req.kind === 'latest') {
        const msgs = Array.from({ length: Math.min(req.limit, 2) }, (_, i) => ({
          id: `m-${i}`,
          topicId: req.topicId,
          blocks: []
        }))
        return makeWindowResponse(req, msgs)
      }
      throw new Error('unsupported')
    })
    // Import and mark ordinaryTreeReady after enabling, before thunk loads
    const diag = await import('@renderer/services/startupStageDiagnostics')
    // ensure enabled
    expect(diag.isStartupStageEnabled()).toBe(true)
    diag.markStartupMilestone('renderer.ordinaryTreeReady')
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.ordinaryTreeReady')).toBe(true)
  })

  it('active-topic success records firstData exactly once (ok, bounded, ordered) via real dispatch mutation', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    const getState = () => storeState
    storeState.messages.currentTopicId = 't1'
    // small delay so interval measurable
    await new Promise((r) => setTimeout(r, 5))
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    // allow settlement microtasks
    await new Promise((r) => setTimeout(r, 0))
    const recs = diag.readStartupState().records
    const first = recs.find((r) => r.stage === 'renderer.firstData')
    expect(first).toBeDefined()
    expect(first!.status).toBe('ok')
    expect(Number.isFinite(first!.durationMs) && first!.durationMs >= 0).toBe(true)
    const ord = recs.find((r) => r.stage === 'renderer.ordinaryTreeReady')!
    expect(first!.elapsedMs).toBeGreaterThanOrEqual(ord.elapsedMs)
    // one-shot: second active-topic load must not add
    const before = recs.length
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    expect(diag.readStartupState().records.length).toBe(before)
    // verify dispatch actually mutated state (production transition reproduced)
    expect(storeState.messages.currentTopicId).toBe('t1')
    expect(dispatch).toHaveBeenCalled()
  })

  it('active-topic rejection records error and remains one-shot via real dispatch', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    const getState = () => storeState
    storeState.messages.currentTopicId = 't1'
    mocks.fetchMessagesWindow.mockRejectedValueOnce(new Error('transport fail'))
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await new Promise((r) => setTimeout(r, 0))
    const first = diag.readStartupState().records.find((r) => r.stage === 'renderer.firstData')
    expect(first).toBeDefined()
    expect(first!.status).toBe('error')
    // second success must not overwrite
    mocks.fetchMessagesWindow.mockResolvedValueOnce(
      makeWindowResponse({ kind: 'latest', topicId: 't1', limit: 10 }, [{ id: 'm-0' }])
    )
    await loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    expect(diag.readStartupState().records.find((r) => r.stage === 'renderer.firstData')!.status).toBe('error')
  })

  it('invalid/missing topic (empty/whitespace/non-existent) does not record and consumes window — later valid cannot emit', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    // first candidate is invalid (non-existent id) — independent of own dispatch, existence fails
    storeState.messages.currentTopicId = 't1'
    await loadTopicMessagesThunk('missing-id')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // window should be consumed (fail-closed) so later valid t1 cannot emit
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
  })

  it('no-topic empty and whitespace fail closed and consume window', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    await loadTopicMessagesThunk('')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // whitespace also invalid but window already consumed, still no record
    await loadTopicMessagesThunk('   ')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // valid after consumed window still not record
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
  })

  it('cache-hit path does not record but consumes window — later cold load cannot emit', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    // Simulate resident hit: messageIdsByTopic present and registry resident
    storeState.messages.messageIdsByTopic = { t1: ['m-0'] }
    storeState.messages.currentTopicId = 't1'
    storeState.residentRegistry.entries['t1'] = {
      chatData: true,
      segments: true,
      residentTopic: true,
      applicabilityGeneration: 1
    }
    mocks.fetchMessagesWindow.mockClear()
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // Window consumed by cache-hit, so next non-hit cold load for same active topic must NOT record
    storeState.residentRegistry.entries = {}
    storeState.messages.messageIdsByTopic = {}
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
  })

  it('valid non-active topic before first settlement does not record and consumes window — later active cannot emit', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    // Precondition: current is t1 (active), request t2 is valid but non-active — History/navigation case
    storeState.messages.currentTopicId = 't1'
    storeState.messages.messageIdsByTopic = {}
    storeState.residentRegistry.entries = {}
    // Verify t2 exists in assistants (beforeEach sets t1,t2)
    expect(storeState.assistants.assistants[0].topics.some((t: any) => t.id === 't2')).toBe(true)
    await loadTopicMessagesThunk('t2')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    // Must NOT record — activeBefore false despite valid existence
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // Production-like dispatch must have flipped current to requested topic
    expect(storeState.messages.currentTopicId).toBe('t2')
    // Window must be consumed fail-closed (cannotRecord)
    expect(diag.canRecordFirstDataNow()).toBe(false)
    expect((globalThis as any).__startupStageFirstDataStateForTest?.().firstDataRecorded).toBe(true)
    // Settlement predicate was never armed — even though post-dispatch current===t2, no instrumentation
    // Later active load for t2 (now active) must still NOT record because window consumed
    storeState.residentRegistry.entries = {}
    storeState.messages.messageIdsByTopic = {}
    await loadTopicMessagesThunk('t2')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // Even later valid active t1 (now non-active after previous dispatch? reset to t1) must not record
    storeState.messages.currentTopicId = 't1'
    storeState.residentRegistry.entries = {}
    storeState.messages.messageIdsByTopic = {}
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
  })

  it('non-startup: before ordinaryTreeReady does not record (fail-closed)', async () => {
    // Reset to before ready
    const diag = await import('@renderer/services/startupStageDiagnostics')
    diag.resetStartupState()
    expect(diag.hasOrdinaryTreeReady()).toBe(false)
    expect(diag.readStartupState().records.length).toBe(0)
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    storeState.messages.currentTopicId = 't1'
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // after marking ready, next load should record (eligible) — clear cache from prior pre-ready load
    storeState.messages.messageIdsByTopic = {}
    storeState.residentRegistry.entries = {}
    diag.markStartupMilestone('renderer.ordinaryTreeReady')
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(true)
  })

  it('stale settlement (topic moved before resolve) does not attribute and does not consume — next eligible records', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    storeState.messages.currentTopicId = 't1'
    let resolveFetch: (v: any) => void
    mocks.fetchMessagesWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )
    const getState = () => storeState
    const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    // Move current before settlement via real dispatch mutation (production transition)
    // Simulate user navigating to t2 before stale t1 resolves
    storeState.messages.currentTopicId = 't2'
    const req = { kind: 'latest', topicId: 't1', limit: 10 } as any
    resolveFetch!(makeWindowResponse(req, [{ id: 'm-0' }, { id: 'm-1' }]))
    await promise
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // Subsequent load for new active topic t2 should still be eligible and record exactly once
    // Reset fetch to normal
    mocks.fetchMessagesWindow.mockImplementation(async (req2: any) => {
      const msgs = [{ id: 'm-0', topicId: req2.topicId, blocks: [] }]
      return makeWindowResponse(req2, msgs)
    })
    storeState.messages.currentTopicId = 't2'
    storeState.residentRegistry.entries = {}
    storeState.messages.messageIdsByTopic = {}
    await loadTopicMessagesThunk('t2')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    const first = diag.readStartupState().records.find((r) => r.stage === 'renderer.firstData')!
    expect(first.status).toBe('ok')
  })

  it('unrelated later loads after firstData remain one-shot (no second record)', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    storeState.messages.currentTopicId = 't1'
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    // unrelated later topic after startup — must not create second firstData
    storeState.messages.currentTopicId = 't2'
    storeState.residentRegistry.entries = {}
    storeState.messages.messageIdsByTopic = {}
    await loadTopicMessagesThunk('t2')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    // even forceReload for same topic
    storeState.messages.currentTopicId = 't1'
    await loadTopicMessagesThunk('t1', true)(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
  })

  it('forceReload eligible still records exactly once and later loads remain one-shot', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    storeState.messages.currentTopicId = 't1'
    await loadTopicMessagesThunk('t1', true)(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    // later unrelated
    storeState.messages.currentTopicId = 't2'
    await loadTopicMessagesThunk('t2')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
  })

  it('superseded same-topic overlapping load does not record stale settlement — next eligible records', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    storeState.messages.currentTopicId = 't1'
    let firstResolve: (v: any) => void = () => {}
    let secondResolve: (v: any) => void = () => {}
    let callCount = 0
    mocks.fetchMessagesWindow.mockImplementation(
      (req: any) =>
        new Promise((resolve) => {
          callCount++
          if (callCount === 1) firstResolve = resolve
          else if (callCount === 2) secondResolve = resolve
          else resolve(makeWindowResponse(req, [{ id: 'm-0', topicId: req.topicId, blocks: [] }]))
        })
    )
    const getState = () => storeState
    const p1 = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    // ensure p1 has incremented seq before p2
    await new Promise((r) => setTimeout(r, 0))
    const p2 = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await new Promise((r) => setTimeout(r, 0))
    // Resolve superseded first — thunk will discard as superseded, diagnostic must not record
    const req1 = { kind: 'latest', topicId: 't1', limit: 10 } as any
    firstResolve(makeWindowResponse(req1, [{ id: 'm-0' }]))
    await p1
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // Resolve superseding second — should be applicable and record exactly once
    const req2 = { kind: 'latest', topicId: 't1', limit: 10 } as any
    secondResolve(makeWindowResponse(req2, [{ id: 'm-1' }]))
    await p2
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    expect(diag.readStartupState().records.find((r) => r.stage === 'renderer.firstData')!.status).toBe('ok')
  })

  it('deletion-stale request does not record — next eligible after deletion still records', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const { bumpDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')
    const dispatch = makeDispatch(storeState)
    storeState.messages.currentTopicId = 't1'
    let resolveFetch: (v: any) => void = () => {}
    mocks.fetchMessagesWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )
    const getState = () => storeState
    const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await new Promise((r) => setTimeout(r, 0))
    // Simulate authoritative hard deletion during fetch
    bumpDeletionGeneration('t1')
    const req = { kind: 'latest', topicId: 't1', limit: 10 } as any
    resolveFetch(makeWindowResponse(req, [{ id: 'm-0' }]))
    await promise
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // Subsequent eligible load after deletion: need a fresh topic still resident
    // Reset deletion generation for t1 to allow next load? Use new topic t2 to avoid lingering generation.
    // t2 was never deleted, so generation 0 and should be eligible.
    mocks.fetchMessagesWindow.mockImplementation(async (req2: any) =>
      makeWindowResponse(req2, [{ id: 'm-0', topicId: req2.topicId, blocks: [] }])
    )
    storeState.messages.currentTopicId = 't2'
    storeState.residentRegistry.entries = {}
    storeState.messages.messageIdsByTopic = {}
    await loadTopicMessagesThunk('t2')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
  })

  it('generation-mismatch request does not record — next eligible records', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = makeDispatch(storeState)
    storeState.messages.currentTopicId = 't1'
    let resolveFetch: (v: any) => void = () => {}
    mocks.fetchMessagesWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )
    const getState = () => storeState
    const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await new Promise((r) => setTimeout(r, 0))
    // Bump applicability generation after capture but before settlement
    dispatch(mocks.bumpGeneration('t1') as any)
    const req = { kind: 'latest', topicId: 't1', limit: 10 } as any
    resolveFetch(makeWindowResponse(req, [{ id: 'm-0' }]))
    await promise
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // Next eligible for same topic after generation mismatch: the generation was bumped,
    // but a fresh load will capture the new generation and should record.
    mocks.fetchMessagesWindow.mockImplementation(async (req2: any) =>
      makeWindowResponse(req2, [{ id: 'm-1', topicId: req2.topicId, blocks: [] }])
    )
    storeState.messages.messageIdsByTopic = {}
    // current still t1, activeBefore will be true for next call
    await loadTopicMessagesThunk('t1')(dispatch, () => storeState)
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
  })

  it('generation-mismatch and deletion-mismatch on error path also do not record', async () => {
    const diag = await import('@renderer/services/startupStageDiagnostics')
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const { bumpDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')
    const dispatch = makeDispatch(storeState)
    storeState.messages.currentTopicId = 't1'
    let rejectFetch: (e: any) => void = () => {}
    mocks.fetchMessagesWindow.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject
        })
    )
    const getState = () => storeState
    const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await new Promise((r) => setTimeout(r, 0))
    bumpDeletionGeneration('t1')
    rejectFetch(new Error('transport fail'))
    await promise
    await new Promise((r) => setTimeout(r, 0))
    expect(diag.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
  })
})
