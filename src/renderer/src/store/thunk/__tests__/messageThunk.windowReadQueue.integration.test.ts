/**
 * Real-serializer consumer integration — loadTopicMessagesThunk (S6.1 R-02)
 *
 * Unlike messageThunk.windowS61.test.ts — which deliberately mocks
 * `runTopicWindowRead` as an immediate passthrough so the historical
 * out-of-order same-topic stale-token regression keeps exercising direct
 * overlapping completion — this file loads the REAL per-topic FIFO serializer
 * (no `@renderer/utils/windowReadQueue` mock). It proves that an actual
 * consumer (`loadTopicMessagesThunk` latest bootstrap) routes its reads
 * through the real serializer:
 *
 * - overlapping same-topic bootstraps run non-overlapping: the second read's
 *   fetch must NOT start while the first is in flight;
 * - the S6.1 same-topic stale-token guard still discards a superseded
 *   response once the queue advances (serialization does not remove it);
 * - a rejected first read does not deadlock the queued second read and the
 *   consumer keeps failing closed (no whole-topic fallback).
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('S6.1 real serializer consumer — loadTopicMessagesThunk latest', () => {
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
    const { clearAllLatestWindowCompleteness } = await import('@renderer/pages/home/Messages/messageWindow')
    clearAllLatestWindowCompleteness()
  })

  it(
    'overlapping same-topic bootstraps serialize: second fetch does not start until the first settles; superseded result is discarded and the fresh one publishes',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
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

      // Real per-topic FIFO serializer: while read 1 is in flight, read 2 is
      // queued — its dbService.fetchMessagesWindow call must NOT have started.
      await flush()
      expect(deferreds).toHaveLength(1)
      expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)

      // FIFO: the older (superseded) read settles first. requestSeq (1) is
      // superseded by (2), so the stale-token guard discards it — the
      // serializer orders execution, it does not replace the guard.
      const resStale = makeWindowResponse(deferreds[0].req, [{ id: 'm-stale-0' }, { id: 'm-stale-1' }], {
        hasMoreBefore: true,
        hasMoreAfter: false
      } as any) as unknown as FetchMessagesWindowResponse
      ;(resStale as any).blocks = [
        { id: 'b-stale', messageId: 'm-stale-0', type: 'main_text', content: 'stale' } as any
      ]
      deferreds[0].resolve(resStale)
      await p1

      expect(mocks.publishResidentComplete).not.toHaveBeenCalled()

      // Only now does the queue advance and read 2 start.
      await flush()
      expect(deferreds).toHaveLength(2)
      expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(2)

      const resFresh = makeWindowResponse(deferreds[1].req, [{ id: 'm-fresh-0' }, { id: 'm-fresh-1' }], {
        hasMoreBefore: false,
        hasMoreAfter: true
      } as any) as unknown as FetchMessagesWindowResponse
      ;(resFresh as any).blocks = [
        { id: 'b-fresh', messageId: 'm-fresh-0', type: 'main_text', content: 'fresh' } as any
      ]
      deferreds[1].resolve(resFresh)
      await p2

      expect(mocks.publishResidentComplete).toHaveBeenCalledTimes(1)
      const freshPayload = mocks.publishResidentComplete.mock.calls[0][0] as any
      expect(freshPayload.topicId).toBe('t1')
      expect(freshPayload.windowResponse.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'm-fresh-0' })])
      )
      expect(freshPayload.windowResponse.blocks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'b-fresh' })])
      )
      expect(freshPayload.windowResponse.window.hasMoreBefore).toBe(false)
      expect(freshPayload.windowResponse.window.hasMoreAfter).toBe(true)
      expect(mocks.publishResidentComplete).not.toHaveBeenCalledWith(
        expect.objectContaining({
          windowResponse: expect.objectContaining({
            messages: expect.arrayContaining([expect.objectContaining({ id: 'm-stale-0' })])
          })
        })
      )
      expect(mocks.fetchMessages).not.toHaveBeenCalled()
    }
  )

  it(
    'rejected first read through the real serializer does not deadlock the queued second read; consumer fails closed',
    { timeout: 60_000 },
    async () => {
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()
      const getState = () => storeState

      const deferreds: Array<{
        reject: (e: Error) => void
        resolve: (v: any) => void
        req: FetchMessagesWindowRequest
      }> = []
      mocks.fetchMessagesWindow.mockImplementation(
        (req: FetchMessagesWindowRequest) =>
          new Promise((resolve, reject) => {
            deferreds.push({ resolve, reject, req })
          })
      )

      const p1 = loadTopicMessagesThunk('t1')(dispatch, getState as any)
      const p2 = loadTopicMessagesThunk('t1')(dispatch, getState as any)

      await flush()
      expect(deferreds).toHaveLength(1)

      // Read 1 fails hard; the thunk swallows it (fail-closed, no whole-topic fallback).
      deferreds[0].reject(new Error('transport fail'))
      await p1
      expect(mocks.publishResidentComplete).not.toHaveBeenCalled()
      expect(mocks.fetchMessages).not.toHaveBeenCalled()

      // The rejected task settles and p-queue advances — read 2 still runs.
      await flush()
      expect(deferreds).toHaveLength(2)

      deferreds[1].resolve(makeWindowResponse(deferreds[1].req, [{ id: 'm-ok-0' }, { id: 'm-ok-1' }]))
      await p2

      expect(mocks.publishResidentComplete).toHaveBeenCalledTimes(1)
      const okPayload = mocks.publishResidentComplete.mock.calls[0][0] as any
      expect(okPayload.topicId).toBe('t1')
      expect(okPayload.windowResponse.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'm-ok-0' })])
      )
      expect(mocks.fetchMessages).not.toHaveBeenCalled()
    }
  )
})
