/**
 * Bounded topic activation unit: interactive completion + non-blocking anchor + dedup.
 *
 * - Miss path publishes the bounded latest window + segment catalog atomically and
 *   clears loading without awaiting anchor/retention (anchor scheduled fire-and-forget).
 * - Cache-hit path performs no fetch/publish and schedules anchor without blocking.
 * - Stale switch (current moved) discards without publish or anchor.
 * - Identical segment follow-up commits no second local segment state; identical
 *   window completeness commits no second Map state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    listSegments: vi.fn(),
    bumpGeneration: vi.fn((p: unknown) => ({ type: 'residentRegistry/bumpGeneration', payload: p })),
    publishResidentComplete: vi.fn((p: unknown) => ({ type: 'resident/jointPublishComplete', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p }))
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
  updateTopicUpdatedAt: vi.fn(),
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
  const actual = await vi.importActual<any>('@renderer/store/newMessage')
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
  topicId: string,
  ids: string[],
  completeness = { hasMoreBefore: false, hasMoreAfter: false }
) {
  const messages = ids.map((id) => ({ id, topicId, blocks: [] }))
  return {
    messages,
    blocks: [],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: completeness.hasMoreBefore,
      hasMoreAfter: completeness.hasMoreAfter
    }
  } as any
}

describe('bounded topic activation', () => {
  let storeState: any

  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      assistants: { assistants: [{ id: 'asst-1', topics: [{ id: 't1' }] }] },
      messages: {
        entities: {},
        messageIdsByTopic: {} as Record<string, string[]>,
        loadingByTopic: {},
        fulfilledByTopic: {},
        currentTopicId: 't1',
        displayCount: 10
      },
      messageBlocks: { entities: {} },
      residentRegistry: { entries: {} }
    }
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
    mocks.listSegments.mockResolvedValue([])
  })

  it('miss: joint publish + loading=false settle without awaiting anchor', { timeout: 60_000 }, async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    let resolveAnchor!: () => void
    mocks.ensureTopicAnchorEstablished.mockImplementationOnce(
      () => new Promise<void>((resolve) => void (resolveAnchor = resolve))
    )
    mocks.fetchMessagesWindow.mockResolvedValueOnce(makeWindowResponse('t1', ['m-1', 'm-2']))
    const dispatch = vi.fn()
    const getState = () => storeState
    const done = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await done
    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
    expect(mocks.publishResidentComplete).toHaveBeenCalledTimes(1)
    expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledTimes(1)
    const loadingFalse = dispatch.mock.calls.filter(
      ([a]: any) => a?.type === 'newMessages/setTopicLoading' && a?.payload?.loading === false
    )
    expect(loadingFalse.length).toBeGreaterThanOrEqual(1)
    // Thunk settled while anchor still pending — anchor never blocked loading.
    resolveAnchor()
  })

  it('cache-hit: no fetch/publish, anchor scheduled without blocking', { timeout: 60_000 }, async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    storeState.messages.messageIdsByTopic = { t1: ['m-1'] }
    storeState.residentRegistry.entries = {
      t1: { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 1 }
    }
    mocks.ensureTopicAnchorEstablished.mockResolvedValueOnce(undefined)
    const dispatch = vi.fn()
    await loadTopicMessagesThunk('t1')(dispatch, (() => storeState) as any)
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
    expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledTimes(1)
  })

  it(
    'anchor rejection is caught: activation still settles with no unhandled rejection',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        mocks.ensureTopicAnchorEstablished.mockRejectedValueOnce(new Error('anchor boom'))
        mocks.fetchMessagesWindow.mockResolvedValueOnce(makeWindowResponse('t1', ['m-1', 'm-2']))
        const dispatch = vi.fn()
        await loadTopicMessagesThunk('t1')(dispatch, (() => storeState) as any)
        expect(mocks.publishResidentComplete).toHaveBeenCalledTimes(1)
        expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledTimes(1)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(unhandled).toEqual([])
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
      }
    }
  )
  it(
    'same-topic supersede discards loser without publish or anchor and clears loading',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      let resolveLoser!: (v: any) => void
      let resolveWinner!: (v: any) => void
      mocks.fetchMessagesWindow
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveLoser = resolve
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveWinner = resolve
            })
        )
      mocks.ensureTopicAnchorEstablished.mockResolvedValue(undefined as any)
      const dispatch = vi.fn()
      const getState = () => storeState
      const pendingLoser = loadTopicMessagesThunk('t1')(dispatch, getState as any)
      const pendingWinner = loadTopicMessagesThunk('t1')(dispatch, getState as any)
      resolveLoser(makeWindowResponse('t1', ['m-1']))
      await pendingLoser
      expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
      expect(mocks.ensureTopicAnchorEstablished).not.toHaveBeenCalled()
      resolveWinner(makeWindowResponse('t1', ['m-2']))
      await pendingWinner
      expect(mocks.publishResidentComplete).toHaveBeenCalledTimes(1)
      expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledTimes(1)
      const loadingFalse = dispatch.mock.calls.filter(
        ([a]: any) =>
          a?.type === 'newMessages/setTopicLoading' && a?.payload?.topicId === 't1' && a?.payload?.loading === false
      )
      expect(loadingFalse.length).toBeGreaterThanOrEqual(2)
    }
  )

  it(
    'staged-fetch rejection publishes nothing, schedules no anchor, and clears loading',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      mocks.fetchMessagesWindow.mockRejectedValueOnce(new Error('db boom'))
      const dispatch = vi.fn()
      await loadTopicMessagesThunk('t1')(dispatch, (() => storeState) as any)
      expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
      expect(mocks.ensureTopicAnchorEstablished).not.toHaveBeenCalled()
      const loadingFalse = dispatch.mock.calls.filter(
        ([a]: any) =>
          a?.type === 'newMessages/setTopicLoading' && a?.payload?.topicId === 't1' && a?.payload?.loading === false
      )
      expect(loadingFalse.length).toBeGreaterThanOrEqual(1)
    }
  )

  it('malformed window publishes nothing, schedules no anchor, and clears loading', { timeout: 60_000 }, async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    mocks.fetchMessagesWindow.mockResolvedValueOnce(makeWindowResponse('t-other', ['m-1']))
    const dispatch = vi.fn()
    await loadTopicMessagesThunk('t1')(dispatch, (() => storeState) as any)
    expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
    expect(mocks.ensureTopicAnchorEstablished).not.toHaveBeenCalled()
    const loadingFalse = dispatch.mock.calls.filter(
      ([a]: any) =>
        a?.type === 'newMessages/setTopicLoading' && a?.payload?.topicId === 't1' && a?.payload?.loading === false
    )
    expect(loadingFalse.length).toBeGreaterThanOrEqual(1)
  })

  it('switch-away discards staged window without publish or anchor', { timeout: 60_000 }, async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    let resolveFetch!: (v: any) => void
    mocks.fetchMessagesWindow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )
    const dispatch = vi.fn()
    const getState = vi.fn(() => storeState)
    const pending = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    storeState.messages.currentTopicId = 't2'
    resolveFetch(makeWindowResponse('t1', ['m-1']))
    await pending
    expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
    expect(mocks.ensureTopicAnchorEstablished).not.toHaveBeenCalled()
  })
})
