/**
 * Read vs generation split — real-thunk proof (no action-only mocks).
 *
 * Uses a REAL redux store (real `messages` + `topicBranch` + `residentRegistry`
 * reducers, real `loadRouteMessagesThunk`) with a deferred `fetchMessagesWindow`
 * data source. Proves through the production read path that:
 * - a window read completing while generation is busy leaves generation true;
 * - two overlapping reads never clear each other (late first finalizer only
 *   releases its own request identity; the newer read stays busy, and the
 *   superseded first publication never overwrites the second).
 *
 * The `newMessage` slice is deliberately NOT mocked here (unlike the
 * dispatch-spy suites): every assertion below reads the real reducer state
 * through the real selectors.
 */
import { configureStore } from '@reduxjs/toolkit'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchMessagesWindow: vi.fn(),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p }))
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
vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    fetchMessages: vi.fn(),
    resolveContextClosure: vi.fn(),
    createBranch: vi.fn(),
    listBranches: vi.fn(),
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
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt,
  updateAssistantSettings: vi.fn((p: unknown) => ({ type: 'updateAssistantSettings', payload: p }))
}))
vi.mock('@renderer/store/index', () => ({
  default: { dispatch: vi.fn(), getState: () => ({}) as any },
  useAppDispatch: () => vi.fn()
}))
vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: vi.fn(() => () => Promise.resolve())
}))
vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({ AiSdkToChunkAdapter: class {} }))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
// Immediate passthrough so overlapping same-topic reads truly overlap in test
// (the FIFO serializer would otherwise order them; overlap semantics —
// per-identity release — is what this file proves).
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
vi.mock('i18n', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k } as any,
  t: (k: string) => k
}))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k } as any,
  t: (k: string) => k
}))

import messagesReducer, {
  newMessagesActions,
  selectIsTopicGenerating,
  selectIsTopicWindowReadBusy
} from '@renderer/store/newMessage'
import residentRegistryReducer from '@renderer/store/residentRegistry'
import topicBranchReducer from '@renderer/store/topicBranch'

function makeStore() {
  return configureStore({
    reducer: {
      messages: messagesReducer,
      topicBranch: topicBranchReducer,
      residentRegistry: residentRegistryReducer,
      messageBlocks: (state = { entities: {}, ids: [] } as any) => state,
      assistants: (state = { assistants: [] } as any) => state
    }
  })
}

function makeWindowResponse(request: FetchMessagesWindowRequest, messageIds: string[]): FetchMessagesWindowResponse {
  const messages = messageIds.map((id) => ({ id }) as unknown as FetchMessagesWindowResponse['messages'])
  return {
    messages,
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: request.kind,
      completeness: 'window',
      topicId: request.topicId,
      anchorMessageId: request.kind === 'around' ? (request as any).anchorMessageId : null,
      requested:
        request.kind === 'latest'
          ? { limit: (request as any).limit }
          : { before: (request as any).before, after: (request as any).after },
      firstMessageId: messageIds.length > 0 ? messageIds[0] : null,
      lastMessageId: messageIds.length > 0 ? messageIds[messageIds.length - 1] : null,
      returnedCount: messageIds.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

describe('read vs generation split — real thunk + real store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('real route read completing during generation leaves generation true and publishes', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const store = makeStore()
    let resolveFetch!: (v: FetchMessagesWindowResponse) => void
    mocks.fetchMessagesWindow.mockImplementationOnce(
      () =>
        new Promise<FetchMessagesWindowResponse>((resolve) => {
          resolveFetch = resolve
        })
    )
    // Generation busy (e.g. an active stream on the same topic).
    store.dispatch(newMessagesActions.setTopicLoading({ topicId: 't1', loading: true }))

    const promise = store.dispatch(loadRouteMessagesThunk('t1', null, { kind: 'latest' }) as any)
    // Registration is synchronous at dispatch: the read is busy while generation stays true.
    expect(selectIsTopicWindowReadBusy(store.getState() as any, 't1')).toBe(true)
    expect(selectIsTopicGenerating(store.getState() as any, 't1')).toBe(true)

    resolveFetch(makeWindowResponse({ kind: 'latest', topicId: 't1', branchId: null, limit: 10 }, ['m1', 'm2']))
    await promise

    const s = store.getState() as any
    // Read settled, publication landed, generation untouched by the real read path.
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(false)
    expect(selectIsTopicGenerating(s, 't1')).toBe(true)
    expect(s.messages.messageIdsByTopic['t1']).toEqual(['m1', 'm2'])
  })

  it('overlapping real route reads: second completion does not clear the first; late first finalizer releases only itself', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const store = makeStore()
    let resolveFirst!: (v: FetchMessagesWindowResponse) => void
    let resolveSecond!: (v: FetchMessagesWindowResponse) => void
    mocks.fetchMessagesWindow
      .mockImplementationOnce(
        () =>
          new Promise<FetchMessagesWindowResponse>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<FetchMessagesWindowResponse>((resolve) => {
            resolveSecond = resolve
          })
      )

    const pFirst = store.dispatch(loadRouteMessagesThunk('t1', null, { kind: 'latest' }) as any)
    const pSecond = store.dispatch(loadRouteMessagesThunk('t1', null, { kind: 'latest' }) as any)
    expect(selectIsTopicWindowReadBusy(store.getState() as any, 't1')).toBe(true)

    // Newer read settles first: publication lands, older read still outstanding.
    resolveSecond(makeWindowResponse({ kind: 'latest', topicId: 't1', branchId: null, limit: 10 }, ['b1']))
    await pSecond
    let s = store.getState() as any
    expect(s.messages.messageIdsByTopic['t1']).toEqual(['b1'])
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(true)
    expect(selectIsTopicGenerating(s, 't1')).toBe(false)

    // Stale first settles late: discarded (superseded), releases only its own identity.
    resolveFirst(makeWindowResponse({ kind: 'latest', topicId: 't1', branchId: null, limit: 10 }, ['stale']))
    await pFirst
    s = store.getState() as any
    expect(s.messages.messageIdsByTopic['t1']).toEqual(['b1'])
    expect(selectIsTopicWindowReadBusy(s, 't1')).toBe(false)
    expect(selectIsTopicGenerating(s, 't1')).toBe(false)
  })
})
