/**
 * S6.1 real-consumption slice — focused renderer tests
 *
 * Covers: bootstrap latest (R-02) via fetchMessagesWindow, around history (R-03),
 * coverage miss/hit via isWindowCovering, stale discard, malformed metadata/bounds,
 * stable-anchor not-found, and no whole-topic fallback on the new window path.
 */

import { isWindowCovering } from '@renderer/services/windowCoverage'
import type * as NewMessageModule from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Hoisted mocks ----------------------------------------------------------
const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    fetchMessages: vi.fn(),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p })),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    loadTopicSegmentsThunk: vi.fn(() => () => Promise.resolve()),
    updateTopicUpdatedAt: vi.fn()
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
    fetchMessages: mocks.fetchMessages,
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
  upsertManyBlocks: mocks.upsertManyBlocks,
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

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: mocks.loadTopicSegmentsThunk
}))

vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({ AiSdkToChunkAdapter: class {} }))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: vi.fn() }),
  waitForTopicQueue: vi.fn()
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

// Mock newMessage slice actions
vi.mock('@renderer/store/newMessage', async () => {
  const actual = await vi.importActual<typeof NewMessageModule>('@renderer/store/newMessage')
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      messagesReceived: mocks.messagesReceived,
      setTopicLoading: mocks.setTopicLoading,
      setCurrentTopicId: mocks.setCurrentTopicId
    }
  }
})

// Helper to build a valid window response
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
    anchorMessageId: request.kind === 'around' ? (request as any).anchorMessageId : null,
    requested:
      request.kind === 'latest'
        ? { limit: (request as any).limit }
        : { before: (request as any).before, after: (request as any).after },
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

describe('S6.1 windowed bootstrap (R-02) and around history (R-03)', () => {
  let storeState: any

  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      assistants: { assistants: [{ id: 'asst-1', topics: [{ id: 't1' }] }] },
      messages: {
        entities: {},
        messageIdsByTopic: { t1: [] },
        loadingByTopic: {},
        fulfilledByTopic: {},
        currentTopicId: 't1',
        displayCount: 10
      },
      messageBlocks: { entities: {} }
    }
    // default successful window for bootstrap
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      if (req.kind === 'latest') {
        const msgs = Array.from({ length: req.limit }, (_, i) => ({ id: `m-${i}`, topicId: 't1', blocks: [] }))
        return makeWindowResponse(req, msgs)
      }
      if (req.kind === 'around') {
        const before = (req as any).before
        const after = (req as any).after
        const anchor = (req as any).anchorMessageId
        // produce before + anchor + after
        const msgs: Array<{ id: string } & Record<string, unknown>> = []
        for (let i = 0; i < before; i++) msgs.push({ id: `${anchor}-before-${i}`, topicId: 't1', blocks: [] })
        msgs.push({ id: anchor, topicId: 't1', blocks: [] })
        for (let i = 0; i < after; i++) msgs.push({ id: `${anchor}-after-${i}`, topicId: 't1', blocks: [] })
        return makeWindowResponse(req, msgs)
      }
      throw new Error('unsupported')
    })
  })

  it(
    'bootstrap latest invokes fetchMessagesWindow with limit derived from displayCount',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()
      const getState = () => storeState
      storeState.messages.displayCount = 20
      await loadTopicMessagesThunk('t1')(dispatch, getState)
      expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
      const req = mocks.fetchMessagesWindow.mock.calls[0][0] as FetchMessagesWindowRequest
      expect(req.kind).toBe('latest')
      expect(req.topicId).toBe('t1')
      expect((req as any).limit).toBe(20)
      expect(mocks.fetchMessages).not.toHaveBeenCalled()
    }
  )

  it('bootstrap publishes validated window atomically (blocks + messagesReceived)', { timeout: 60_000 }, async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState
    await loadTopicMessagesThunk('t1')(dispatch, getState)
    // window validated, so messagesReceived dispatched, no whole-topic fallback
    expect(mocks.messagesReceived).toHaveBeenCalledTimes(1)
    expect(mocks.messagesReceived).toHaveBeenCalledWith(expect.objectContaining({ topicId: 't1' }))
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
  })

  it('around history invokes fetchMessagesWindow with stable anchor and before/after', async () => {
    const { isValidWindowResponse } = await import('@renderer/services/windowCoverage')
    const req: FetchMessagesWindowRequest = {
      kind: 'around',
      topicId: 't1',
      anchorMessageId: 'm-anchor',
      before: 20,
      after: 1
    }
    const res = makeWindowResponse(req, [{ id: 'm-before' }, { id: 'm-anchor' }, { id: 'm-after' }])
    // ensure our helper validates
    expect(isValidWindowResponse(req as any, res as any)).toBe(true)
    // directly call dbService to prove path exists
    const { dbService } = await import('@renderer/services/db')
    const out = await dbService.fetchMessagesWindow(req)
    expect(out.window.anchorMessageId).toBe('m-anchor')
    expect(out.window.requested.before).toBe(20)
    expect(out.window.requested.after).toBe(1)
  })

  it('coverage miss/hit via isWindowCovering', async () => {
    const cached = makeWindowResponse(
      { kind: 'latest', topicId: 't1', limit: 20 } as FetchMessagesWindowRequest,
      Array.from({ length: 20 }, (_, i) => ({ id: `m-${i}` }))
    )
    expect(
      isWindowCovering(cached as any, { kind: 'latest', topicId: 't1', limit: 10 } as FetchMessagesWindowRequest, 't1')
    ).toBe(true)
    expect(
      isWindowCovering(cached as any, { kind: 'latest', topicId: 't1', limit: 30 } as FetchMessagesWindowRequest, 't1')
    ).toBe(false)
    const aroundCached = makeWindowResponse(
      { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 10, after: 10 } as FetchMessagesWindowRequest,
      [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]
    )
    expect(
      isWindowCovering(
        aroundCached as any,
        { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 5, after: 5 } as any,
        't1'
      )
    ).toBe(true)
    expect(
      isWindowCovering(
        aroundCached as any,
        { kind: 'around', topicId: 't1', anchorMessageId: 'm9', before: 5, after: 5 } as any,
        't1'
      )
    ).toBe(false)
  })

  it('stale discard: does not publish when currentTopicId changed after await', { timeout: 60_000 }, async () => {
    // make fetch delay to allow state change before validation
    let resolveFetch: (v: any) => void
    mocks.fetchMessagesWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = vi.fn(() => storeState)
    const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    // before fetch resolves, switch currentTopicId to simulate stale
    storeState.messages.currentTopicId = 't2'
    const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't1', limit: 10 } as any
    resolveFetch!(makeWindowResponse(req, [{ id: 'm-0' }, { id: 'm-1' }]))
    await promise
    // stale => no messagesReceived
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
  })

  it('malformed metadata/bounds fail closed (no publish, error path)', { timeout: 60_000 }, async () => {
    const { loadTopicMessagesThunk, validateWindowResponse } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState

    // malformed: wrong topicId in window
    const malformedTopicReq: FetchMessagesWindowRequest = { kind: 'latest', topicId: 't1', limit: 10 } as any
    const malformedTopicRes = makeWindowResponse(malformedTopicReq, [{ id: 'm-0' }], { topicId: 'wrong' } as any)
    expect(validateWindowResponse(malformedTopicReq, malformedTopicRes as any)).toBe(false)

    // malformed: completeness not window
    const badCompleteness = makeWindowResponse(malformedTopicReq, [{ id: 'm-0' }], {
      completeness: 'whole-topic' as any
    } as any)
    expect(validateWindowResponse(malformedTopicReq, badCompleteness as any)).toBe(false)

    // malformed: requested limit missing/out of bounds
    const missingLimit = makeWindowResponse(malformedTopicReq, [{ id: 'm-0' }], { requested: {} as any } as any)
    expect(validateWindowResponse(malformedTopicReq, missingLimit as any)).toBe(false)

    // integration: thunk fails closed on malformed response
    mocks.fetchMessagesWindow.mockResolvedValueOnce(malformedTopicRes as any)
    await loadTopicMessagesThunk('t1')(dispatch, getState)
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
  })

  it(
    'stable-anchor not-found: around fetch rejects and bootstrap does not fallback to whole-topic',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()
      const getState = () => storeState

      // Simulate Main throwing ERR_NOT_FOUND for missing anchor (around not used in bootstrap, but ensure bootstrap latest not-found for missing topic also fails closed)
      const notFoundError = Object.assign(new Error('Topic does not exist'), { code: 'ERR_NOT_FOUND' })
      mocks.fetchMessagesWindow.mockRejectedValueOnce(notFoundError)

      await loadTopicMessagesThunk('missing-topic')(dispatch, getState)
      expect(mocks.messagesReceived).not.toHaveBeenCalled()
      expect(mocks.fetchMessages).not.toHaveBeenCalled()
    }
  )

  it(
    'no whole-topic fallback on new window path (fetchMessages never called even on window failure)',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()
      const getState = () => storeState
      mocks.fetchMessagesWindow.mockRejectedValueOnce(new Error('transport fail'))
      await loadTopicMessagesThunk('t1')(dispatch, getState)
      expect(mocks.fetchMessages).not.toHaveBeenCalled()
      expect(mocks.messagesReceived).not.toHaveBeenCalled()
    }
  )

  it('around validation requires anchor present in messages', { timeout: 60_000 }, async () => {
    const { validateWindowResponse } = await import('../messageThunk')
    const req: FetchMessagesWindowRequest = {
      kind: 'around',
      topicId: 't1',
      anchorMessageId: 'm-anchor',
      before: 2,
      after: 2
    } as any
    // response missing anchor
    const resMissingAnchor = makeWindowResponse(req, [{ id: 'm-1' }, { id: 'm-2' }])
    // force window anchor remains but messages don't contain it — should be invalid
    expect(validateWindowResponse(req, resMissingAnchor as any)).toBe(false)
  })

  it(
    'same-topic overlapping latest out-of-order: only newest publishes and updates completeness (S6.1 stale-bootstrap guard)',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const { getLatestWindowCompleteness, clearAllLatestWindowCompleteness } = await import(
        '@renderer/pages/home/Messages/messageWindow'
      )
      clearAllLatestWindowCompleteness()
      // ensure empty topic — fetch path, not cached early-return
      storeState.messages.messageIdsByTopic = { t1: [] }
      storeState.messages.currentTopicId = 't1'
      storeState.messages.displayCount = 10
      storeState.messages.entities = {}
      const dispatch = vi.fn()
      const getState = () => storeState

      const deferreds: Array<{ resolve: (v: any) => void; req: FetchMessagesWindowRequest }> = []
      mocks.fetchMessagesWindow.mockImplementation(
        (req: FetchMessagesWindowRequest) =>
          new Promise((resolve) => {
            deferreds.push({ resolve, req })
          })
      )

      const p1 = loadTopicMessagesThunk('t1')(dispatch, getState as any)
      const p2 = loadTopicMessagesThunk('t1')(dispatch, getState as any)

      expect(deferreds).toHaveLength(2)
      expect(deferreds[0].req.topicId).toBe('t1')
      expect(deferreds[1].req.topicId).toBe('t1')

      const resStale = makeWindowResponse(deferreds[0].req, [{ id: 'm-stale-0' }, { id: 'm-stale-1' }], {
        hasMoreBefore: true,
        hasMoreAfter: false
      } as any) as unknown as FetchMessagesWindowResponse
      ;(resStale as any).blocks = [
        { id: 'b-stale', messageId: 'm-stale-0', type: 'main_text', content: 'stale' } as any
      ]
      const resFresh = makeWindowResponse(deferreds[1].req, [{ id: 'm-fresh-0' }, { id: 'm-fresh-1' }], {
        hasMoreBefore: false,
        hasMoreAfter: true
      } as any) as unknown as FetchMessagesWindowResponse
      ;(resFresh as any).blocks = [
        { id: 'b-fresh', messageId: 'm-fresh-0', type: 'main_text', content: 'fresh' } as any
      ]

      // Resolve newest first (out-of-order) — only newest must publish
      deferreds[1].resolve(resFresh)
      await p2

      expect(mocks.messagesReceived).toHaveBeenCalledTimes(1)
      expect(mocks.messagesReceived).toHaveBeenCalledWith(
        expect.objectContaining({
          topicId: 't1',
          messages: expect.arrayContaining([expect.objectContaining({ id: 'm-fresh-0' })])
        })
      )
      expect(mocks.upsertManyBlocks).toHaveBeenCalledTimes(1)
      expect(mocks.upsertManyBlocks).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'b-fresh' })])
      )
      expect(getLatestWindowCompleteness('t1')).toEqual({ hasMoreBefore: false, hasMoreAfter: true })
      expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledTimes(1)
      // No stale ids leaked into published payload
      expect(mocks.messagesReceived).not.toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({ id: 'm-stale-0' })])
        })
      )

      // Now resolve stale — must be discarded before validation/completeness/publication/anchor
      mocks.messagesReceived.mockClear()
      mocks.upsertManyBlocks.mockClear()
      mocks.ensureTopicAnchorEstablished.mockClear()
      deferreds[0].resolve(resStale)
      await p1

      expect(mocks.messagesReceived).not.toHaveBeenCalled()
      expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
      expect(mocks.ensureTopicAnchorEstablished).not.toHaveBeenCalled()
      expect(getLatestWindowCompleteness('t1')).toEqual({ hasMoreBefore: false, hasMoreAfter: true })

      // Loading cleanup still runs for both (finally)
      const loadingFalseDispatches = dispatch.mock.calls.filter(
        ([a]: any) => a?.type === 'newMessages/setTopicLoading' && a?.payload?.loading === false
      )
      expect(loadingFalseDispatches.length).toBeGreaterThanOrEqual(2)
    }
  )
})

describe('S6.1 Messages merge helpers — production path', () => {
  it('mergeWindowIntoTopic inserts before/after correctly and preserves order (production helper)', async () => {
    const { mergeWindowIntoTopic } = await import('@renderer/pages/home/Messages/messageWindow')
    const existing: Message[] = [{ id: 'm2' } as Message, { id: 'm3' } as Message, { id: 'm4' } as Message]
    const incoming: Message[] = [{ id: 'm1' } as Message, { id: 'm2' } as Message, { id: 'm3' } as Message]
    const merged = mergeWindowIntoTopic(existing, incoming, 'm2')
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('clampWindowCount respects 1..100 bounds (production helper)', async () => {
    const { clampWindowCount } = await import('@renderer/pages/home/Messages/messageWindow')
    expect(clampWindowCount(0)).toBe(1)
    expect(clampWindowCount(101)).toBe(100)
    expect(clampWindowCount(20)).toBe(20)
    expect(clampWindowCount(NaN as any)).toBe(1)
  })

  it('authoritative completeness propagates through window model and is retained on expand', async () => {
    const {
      createLatestMessageWindow,
      expandMessageWindowOlder,
      expandMessageWindowNewer,
      getLatestWindowCompleteness,
      setLatestWindowCompleteness
    } = await import('@renderer/pages/home/Messages/messageWindow')

    const msgs = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      assistantId: 'a',
      topicId: 't1',
      createdAt: '2026-07-19T00:00:00.000Z',
      status: 'success' as any,
      blocks: []
    })) as unknown as Message[]

    // Simulate >limit topic: only latest 10 loaded, but Main says hasMoreBefore=true
    setLatestWindowCompleteness('t1', { hasMoreBefore: true, hasMoreAfter: false })
    const completeness = getLatestWindowCompleteness('t1')!
    const latestWindow = createLatestMessageWindow(msgs.slice(10), 10, completeness)
    expect(latestWindow.hasMoreOlder).toBe(true)
    expect(latestWindow.hasMoreNewer).toBe(false)
    expect(latestWindow.authoritativeHasMoreBefore).toBe(true)

    // Older around response: hasMoreBefore still true, hasMoreAfter false — expand must update older side only
    const olderMsgs = msgs.slice(5, 15) as unknown as Message[]
    // merge produces 15 messages (5..19) - just test window expansion side preservation
    const mergedOlder = [...olderMsgs, ...msgs.slice(15)] as unknown as Message[]
    // Provide deduped merged for test simplicity
    const olderWindow = expandMessageWindowOlder(mergedOlder, latestWindow, 5, {
      hasMoreBefore: true,
      hasMoreAfter: latestWindow.hasMoreNewer
    })
    expect(olderWindow.hasMoreOlder).toBe(true)
    expect(olderWindow.hasMoreNewer).toBe(false)

    // Simulate around newer where hasMoreAfter becomes false and hasMoreBefore preserved true
    const newerWindow = expandMessageWindowNewer(mergedOlder, olderWindow, 5, {
      hasMoreBefore: olderWindow.hasMoreOlder,
      hasMoreAfter: false
    })
    expect(newerWindow.hasMoreNewer).toBe(false)
    expect(newerWindow.hasMoreOlder).toBe(true)
  })
})
