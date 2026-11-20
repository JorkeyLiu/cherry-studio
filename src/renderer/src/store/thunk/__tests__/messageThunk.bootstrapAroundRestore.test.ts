/**
 * Bootstrap prepare-around ownership vs bootstrap latest — request-ownership contract.
 *
 * The bootstrap prepare entry serves its anchor read through the standard
 * `loadRouteMessagesThunk({ kind: 'around', deferPublish: true })`: deferred,
 * so the stage keeps its existing atomic staged-merge publication and the
 * thunk publishes nothing itself — while its sync prefix still registers in
 * the shared `pendingRouteRestoreByTopic` map (single flight). This file
 * contracts the request-rail side of that handoff; the Messages-side rail
 * selection (`viaRouteThunk`) is covered by the wiring assertions in
 * `Messages.bootstrapPrepareThunk.test.ts`.
 *
 * - Around-first + latest-second (real child-before-parent effect order):
 *   one around fetch, shared requestSeq, the adopting joint carries the
 *   anchor window, the deferred around publishes nothing itself, and the
 *   settled map leaves no hold (a later latest fetches fresh).
 * - Latest-completed then bootstrap around: the around still fetches and
 *   returns the anchor window (deferred: zero publications) for the stage
 *   merge — no anchorless latest masquerading as restore.
 * - Deletion-stale / current-topic-moved around: void, publishes nothing,
 *   and the map is reclaimed (a later read still works).
 */
import type * as NewMessageModule from '@renderer/store/newMessage'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, deletionMocks } = vi.hoisted(() => ({
  mocks: {
    fetchMessagesWindow: vi.fn(),
    fetchMessages: vi.fn(),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: p })),
    rebaseRouteMessages: vi.fn((p: unknown) => ({ type: 'newMessages/rebaseRouteMessages', payload: p })),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    resolveContextClosure: vi.fn(),
    createBranch: vi.fn(),
    listBranches: vi.fn(),
    listSegments: vi.fn(async () => [])
  },
  deletionMocks: {
    captureDeletionGeneration: vi.fn(() => 0),
    getDeletionGeneration: vi.fn(() => 0),
    isDeletionStale: vi.fn(() => false)
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
    listSegments: mocks.listSegments
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/services/topicDeletionInvalidation', () => ({
  captureDeletionGeneration: deletionMocks.captureDeletionGeneration,
  getDeletionGeneration: deletionMocks.getDeletionGeneration,
  isDeletionStale: deletionMocks.isDeletionStale
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

// Live topic-A layout: around(m7, before 10, after 19) → effective 14 rows
// with the saved anchor m7 oldest; latest(limit 10) → the 10-row tail.
const AROUND_IDS = ['m7', 'm8', 'm9', 'm10', 'm21', 'm22', 'm1', 'm2', 'm3', 'm4', 'm23', 'm24', 'm5', 'm6']
const LATEST_IDS = ['m21', 'm22', 'm1', 'm2', 'm3', 'm4', 'm23', 'm24', 'm5', 'm6']

function makeWindowResponse(
  request: FetchMessagesWindowRequest,
  ids: string[],
  overrides: Partial<FetchMessagesWindowResponse['window']> = {}
): FetchMessagesWindowResponse {
  const messages = ids.map((id) => ({ id }))
  return {
    messages: messages as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: request.kind,
      completeness: 'window',
      topicId: request.topicId,
      anchorMessageId: request.kind === 'around' ? (request as any).anchorMessageId : null,
      requested: request.kind === 'latest' ? { limit: (request as any).limit } : { before: 10, after: 19 },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false,
      ...overrides
    } as FetchMessagesWindowResponse['window']
  } as unknown as FetchMessagesWindowResponse
}

function baseState() {
  return {
    assistants: { assistants: [{ id: 'asst-1', settings: { contextCount: 5 }, topics: [{ id: 't1' }] }] },
    messages: {
      entities: {},
      messageIdsByTopic: { t1: [...LATEST_IDS] },
      loadingByTopic: {},
      fulfilledByTopic: {},
      currentTopicId: 't1',
      displayCount: 10
    },
    messageBlocks: { entities: {} },
    topicBranch: { branchesByTopic: {}, activeBranchIdByTopic: { t1: 'b1' }, routeGenerationByTopic: { t1: 1 } },
    residentRegistry: { entries: {} }
  } as any
}

/** Executing dispatch: runs thunks like real Redux dispatch. */
function execDispatch(getState: () => any) {
  const seen: any[] = []
  const exec: any = (action: any) => {
    seen.push(action)
    if (typeof action === 'function') return action(exec, getState)
    return action
  }
  return { exec, seen }
}

const rebasePublications = (seen: any[]): string[][] =>
  seen
    .filter((a) => a?.type === 'newMessages/rebaseRouteMessages')
    .map((a) => (a.payload.messages as Array<{ id: string }>).map((m) => m.id))

const jointPublications = (seen: any[]): Array<{ messages: string[]; segments: unknown[] }> =>
  seen
    .filter((a) => a?.payload?.windowResponse)
    .map((a) => ({
      messages: (a.payload.windowResponse.messages as Array<{ id: string }>).map((m) => m.id),
      segments: a.payload.segments as unknown[]
    }))

const fetchKinds = () => mocks.fetchMessagesWindow.mock.calls.map((c) => c[0].kind as string)

describe('bootstrap prepare-around ownership vs bootstrap latest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deletionMocks.captureDeletionGeneration.mockReturnValue(0)
    deletionMocks.getDeletionGeneration.mockReturnValue(0)
    deletionMocks.isDeletionStale.mockReturnValue(false)
    mocks.listSegments.mockResolvedValue([])
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      if (req.kind === 'around') {
        return makeWindowResponse(req, AROUND_IDS)
      }
      return makeWindowResponse(req, LATEST_IDS, { hasMoreBefore: true, hasMoreAfter: false })
    })
  })

  it('bootstrap around-first + bootstrap latest-second: single around fetch under a shared seq, adopter publishes the anchor window, deferred around publishes nothing, no map hold leaks', async () => {
    const { loadRouteMessagesThunk, loadTopicMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    // Real effect order: Messages child (prepare around, deferred) before
    // HomePage parent (useTopic latest), same topic + route.
    const pAround = exec(
      loadRouteMessagesThunk('t1', 'b1', {
        kind: 'around',
        anchorMessageId: 'm7',
        before: 10,
        after: 19,
        deferPublish: true
      })
    )
    const pBoot = exec(loadTopicMessagesThunk('t1'))
    const [aroundRes] = await Promise.all([pAround, pBoot])
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    // Single flight: exactly one around fetch, zero latest fetches.
    expect(fetchKinds().filter((k) => k === 'around').length).toBe(1)
    expect(fetchKinds().filter((k) => k === 'latest').length).toBe(0)
    // Deferred: the around read returns the anchor window to its caller and
    // publishes nothing itself (the stage keeps its merge publication).
    expect((aroundRes as unknown as FetchMessagesWindowResponse).window.kind).toBe('around')
    expect((aroundRes as unknown as FetchMessagesWindowResponse).window.anchorMessageId).toBe('m7')
    expect(rebasePublications(seen).length).toBe(0)
    // The adopting bootstrap latest carries the SAME adopted around14
    // (never an anchorless latest10) with ready segments.
    expect(mocks.listSegments).toHaveBeenCalledWith('t1')
    const joints = jointPublications(seen)
    expect(joints.length).toBe(1)
    expect(joints[0].messages).toEqual(AROUND_IDS)
    expect(joints[0].segments).toEqual([])
    // No map hold leaks: a later latest fetches fresh and publishes.
    const pAfter = exec(loadTopicMessagesThunk('t1', true))
    await pAfter
    expect(fetchKinds().filter((k) => k === 'latest').length).toBe(1)
  })

  it('latest-completed then bootstrap around: the deferred around still fetches and returns the anchor window with zero publications', async () => {
    const { loadRouteMessagesThunk, loadTopicMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    await exec(loadTopicMessagesThunk('t1', true))
    expect(fetchKinds()).toEqual(['latest'])
    const rebaseAfterLatest = rebasePublications(seen).length
    const jointsAfterLatest = jointPublications(seen).length
    const aroundRes = (await exec(
      loadRouteMessagesThunk('t1', 'b1', {
        kind: 'around',
        anchorMessageId: 'm7',
        before: 10,
        after: 19,
        deferPublish: true
      })
    )) as unknown as FetchMessagesWindowResponse
    expect(aroundRes.window.kind).toBe('around')
    expect(aroundRes.window.anchorMessageId).toBe('m7')
    expect(fetchKinds()).toEqual(['latest', 'around'])
    // Deferred: zero publications — the stage merges the returned window.
    expect(rebasePublications(seen).length).toBe(rebaseAfterLatest)
    expect(jointPublications(seen).length).toBe(jointsAfterLatest)
  })

  it('deletion-stale around publishes nothing and leaves no hold; a later read still works', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    deletionMocks.isDeletionStale.mockReturnValue(true)
    const staleRes = await exec(
      loadRouteMessagesThunk('t1', 'b1', {
        kind: 'around',
        anchorMessageId: 'm7',
        before: 10,
        after: 19,
        deferPublish: true
      })
    )
    expect(staleRes).toBeUndefined()
    expect(rebasePublications(seen).length).toBe(0)
    // Map reclaimed: after the deletion clears, a fresh latest publishes.
    deletionMocks.isDeletionStale.mockReturnValue(false)
    const latestRes = (await exec(loadRouteMessagesThunk('t1', 'b1', { kind: 'latest' }))) as unknown as
      | FetchMessagesWindowResponse
      | undefined
    expect(latestRes?.window.kind).toBe('latest')
    expect(rebasePublications(seen).length).toBe(1)
  })

  it('current-topic-moved around publishes nothing (stale, no hold)', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    state.messages.currentTopicId = 't2'
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    const res = await exec(
      loadRouteMessagesThunk('t1', 'b1', {
        kind: 'around',
        anchorMessageId: 'm7',
        before: 10,
        after: 19,
        deferPublish: true
      })
    )
    expect(res).toBeUndefined()
    expect(rebasePublications(seen).length).toBe(0)
  })
})
