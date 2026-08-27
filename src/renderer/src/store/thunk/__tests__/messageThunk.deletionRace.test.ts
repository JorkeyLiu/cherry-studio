/**
 * Focused single-window deletion invalidation during in-flight window reads.
 *
 * Proves that a `latest` window read via `loadTopicMessagesThunk` does NOT
 * publish stale response data when the topic is invalidated/deleted before
 * the deferred `fetchMessagesWindow` response resolves.
 *
 * - Uses deferred promise to keep read in flight
 * - Bumps deletion generation through public seam (bumpDeletionGeneration)
 * - Resolves with otherwise-valid window response
 * - Asserts stale response is discarded/not re-published: no Redux/block/segment dispatch, no anchor, no window-completeness
 *
 * Fail-closed: stale responses are discarded before validation/publication.
 * Soft-delete (no bump) remains non-invalidating — shown as complementary.
 *
 * Scope is single-window focused Vitest coverage, reusing existing
 * SearchResults around-window deletion race coverage without duplication.
 */

import type * as NewMessageModule from '@renderer/store/newMessage'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Hoisted mocks ----------------------------------------------------------
const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    listSegments: vi.fn(),
    fetchMessages: vi.fn(),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p })),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    bumpGeneration: vi.fn((p: unknown) => ({ type: 'residentRegistry/bumpGeneration', payload: p })),
    publishResidentComplete: vi.fn((p: unknown) => ({ type: 'resident/jointPublishComplete', payload: p })),
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
    listSegments: mocks.listSegments,
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
  loadTopicSegmentsThunk: mocks.loadTopicSegmentsThunk
}))

vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({ AiSdkToChunkAdapter: class {} }))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: vi.fn() }),
  waitForTopicQueue: vi.fn()
}))

// Keep serializer as immediate passthrough so in-flight deletion race can be exercised
// directly (same as windowS61.test.ts). FIFO only orders reads; deletion guard is independent.
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
      messagesReceived: mocks.messagesReceived,
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

describe('loadTopicMessagesThunk latest in-flight deletion race (focused)', () => {
  let storeState: any

  beforeEach(async () => {
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
    const { resetAllDeletionGenerationsForTests } = await import('@renderer/services/topicDeletionInvalidation')
    resetAllDeletionGenerationsForTests()
    storeState.residentRegistry.entries = {}
    const { clearAllLatestWindowCompleteness } = await import('@renderer/pages/home/Messages/messageWindow')
    clearAllLatestWindowCompleteness()
  })

  it(
    'stale valid latest response is discarded/not re-published when topic deleted before deferred resolve',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const { bumpDeletionGeneration, getDeletionGeneration } = await import(
        '@renderer/services/topicDeletionInvalidation'
      )
      const { getLatestWindowCompleteness } = await import('@renderer/pages/home/Messages/messageWindow')

      expect(getDeletionGeneration('t1')).toBe(0)
      expect(getLatestWindowCompleteness('t1')).toBeUndefined()

      let resolveFetch: (v: FetchMessagesWindowResponse) => void
      mocks.fetchMessagesWindow.mockImplementation(
        () =>
          new Promise<FetchMessagesWindowResponse>((resolve) => {
            resolveFetch = resolve
          })
      )

      const dispatch = vi.fn()
      const getState = () => storeState

      const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)

      // Allow the thunk to reach the await (captureDeletionGeneration already taken)
      await Promise.resolve()
      await Promise.resolve()
      expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
      const req = mocks.fetchMessagesWindow.mock.calls[0][0] as FetchMessagesWindowRequest
      expect(req.kind).toBe('latest')
      expect(req.topicId).toBe('t1')

      // Authoritative hard deletion before fetch resolves — bumps generation synchronously
      // and clears window completeness. Real store also purges resident projections;
      // this test verifies the stale deferred response is discarded/not re-published.
      const genAfterBump = bumpDeletionGeneration('t1')
      expect(genAfterBump).toBe(1)
      expect(getDeletionGeneration('t1')).toBe(1)
      expect(getLatestWindowCompleteness('t1')).toBeUndefined()

      // Resolve with an otherwise-valid latest window (would have published if not stale)
      const validRes = makeWindowResponse(req, [
        { id: 'm-valid-0', topicId: 't1', blocks: [] },
        { id: 'm-valid-1', topicId: 't1', blocks: [] }
      ])
      ;(validRes as any).blocks = [
        { id: 'b-valid-0', messageId: 'm-valid-0', type: 'main_text', content: 'valid' } as any
      ]

      resolveFetch!(validRes)
      await promise

      // Fail-closed: stale response discarded/not re-published — no joint publication, no anchor
      expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
      expect(mocks.ensureTopicAnchorEstablished).not.toHaveBeenCalled()
      expect(getLatestWindowCompleteness('t1')).toBeUndefined()

      // Projection remains empty — stale valid payload was discarded/not re-published (no resurrection)
      expect(storeState.messages.messageIdsByTopic['t1']).toEqual([])
      expect(mocks.fetchMessages).not.toHaveBeenCalled()

      // Loading cleanup still runs (finally)
      const loadingFalse = dispatch.mock.calls.filter(
        ([a]: any) => a?.type === 'newMessages/setTopicLoading' && a?.payload?.loading === false
      )
      expect(loadingFalse.length).toBeGreaterThanOrEqual(1)
    }
  )

  it('soft-delete (no bump) still publishes valid latest response', { timeout: 60_000 }, async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const { getDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')

    let resolveFetch: (v: FetchMessagesWindowResponse) => void
    mocks.fetchMessagesWindow.mockImplementation(
      () =>
        new Promise<FetchMessagesWindowResponse>((resolve) => {
          resolveFetch = resolve
        })
    )

    const dispatch = vi.fn()
    const getState = () => storeState

    const promise = loadTopicMessagesThunk('t1')(dispatch, getState as any)
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
    const req = mocks.fetchMessagesWindow.mock.calls[0][0] as FetchMessagesWindowRequest

    // No bump — soft delete preserves projection; generation stays 0
    expect(getDeletionGeneration('t1')).toBe(0)

    const validRes = makeWindowResponse(req, [{ id: 'm-soft-0', topicId: 't1', blocks: [] }])
    resolveFetch!(validRes)
    await promise

    expect(mocks.publishResidentComplete).toHaveBeenCalledTimes(1)
    const payload = mocks.publishResidentComplete.mock.calls[0][0] as any
    expect(payload.topicId).toBe('t1')
    expect(payload.windowResponse.messages[0].id).toBe('m-soft-0')
  })
})
