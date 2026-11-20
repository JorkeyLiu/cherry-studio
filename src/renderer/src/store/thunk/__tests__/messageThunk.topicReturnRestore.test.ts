/**
 * Topic-return restore vs bootstrap-latest race (live A→B→A) — single-flight contract.
 *
 * Live evidence: topic A (route b1) has an effective 14-row window with the
 * saved anchor m7 oldest (`around(m7, before 10, after 19)` →
 * [m7,m8,m9,m10,m21,m22,m1,m2,m3,m4,m23,m24,m5,m6]); `latest(limit 10)` →
 * [m21,m22,m1,m2,m3,m4,m23,m24,m5,m6] (moreB=true, m7 absent). After A→B→A the
 * loaded projection equaled latest10: the TOP around (dispatched first,
 * child-before-parent effect order) was superseded by the bootstrap latest
 * (dispatched second) on the shared same-topic request sequence, so the
 * correct restore never published.
 *
 * Contract: a bootstrap that dispatches while a same-topic same-route window
 * read is still in flight adopts that ongoing read instead of fetching a
 * competing latest. Strict terms:
 * - the around window is fetched exactly ONCE (no retry second fetch);
 * - no anchorless latest10 window is ever published for the target;
 * - the final route publication is the anchor-containing around14;
 * - the bootstrap joint publication carries the same around14 window plus
 *   ready segments (resident joint publication / segments preserved).
 */
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
    listBranches: vi.fn(),
    listSegments: vi.fn(async () => [])
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

describe('topic-return restore vs bootstrap-latest race (single-flight)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listSegments.mockResolvedValue([])
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      if (req.kind === 'around') {
        return makeWindowResponse(req, AROUND_IDS)
      }
      return makeWindowResponse(req, LATEST_IDS, { hasMoreBefore: true, hasMoreAfter: false })
    })
  })

  it('route-around dispatched before topic-latest: one around fetch, no anchorless latest, anchor window published', async () => {
    const { loadRouteMessagesThunk, loadTopicMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    // Child-before-parent effect order on topic switch: TOP around first,
    // bootstrap latest second (same topic + route).
    const pAround = exec(
      loadRouteMessagesThunk('t1', 'b1', { kind: 'around', anchorMessageId: 'm7', before: 10, after: 19 })
    )
    const pBoot = exec(loadTopicMessagesThunk('t1'))
    await Promise.all([pAround, pBoot])
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    // Single flight: exactly one around fetch, zero latest fetches.
    const kinds = mocks.fetchMessagesWindow.mock.calls.map((c) => c[0].kind)
    expect(kinds.filter((k) => k === 'around').length).toBe(1)
    expect(kinds.filter((k) => k === 'latest').length).toBe(0)
    // The route publication is the anchor-containing around14.
    const published = rebasePublications(seen)
    expect(published.length).toBeGreaterThan(0)
    expect(published[published.length - 1]).toEqual(AROUND_IDS)
    // The bootstrap joint publication carries the same adopted around14
    // window (not an anchorless latest) with ready segments.
    expect(mocks.listSegments).toHaveBeenCalled()
    const joints = jointPublications(seen)
    expect(joints.length).toBe(1)
    expect(joints[0].messages).toEqual(AROUND_IDS)
    expect(joints[0].segments).toEqual([])
  })

  it('stale route (moved on) never publishes the older target', async () => {
    const { loadRouteMessagesThunk } = await import('../messageThunk')
    let resolveFirst!: (v: FetchMessagesWindowResponse) => void
    const firstGate = new Promise<FetchMessagesWindowResponse>((r) => (resolveFirst = r))
    mocks.fetchMessagesWindow.mockImplementationOnce(() => firstGate)
    mocks.fetchMessagesWindow.mockImplementationOnce(async (req: FetchMessagesWindowRequest) =>
      makeWindowResponse(req, LATEST_IDS)
    )
    const state = baseState()
    // Live-store fixture: getState reflects the route switch.
    let cur: any = state
    const getState = () => cur
    const { exec: execFirst, seen: seenFirst } = execDispatch(getState)
    const p1 = execFirst(loadRouteMessagesThunk('t1', 'b1', { kind: 'around', anchorMessageId: 'm7' }))
    // Newer switch changes the active route before the older read settles.
    cur = {
      ...state,
      topicBranch: {
        ...state.topicBranch,
        activeBranchIdByTopic: { t1: 'b-second' },
        routeGenerationByTopic: { t1: 2 }
      }
    }
    const { exec: execSecond, seen: seenSecond } = execDispatch(getState)
    const p2 = execSecond(loadRouteMessagesThunk('t1', 'b-second', { kind: 'latest' }))
    await p2
    const staleReq: FetchMessagesWindowRequest = {
      kind: 'around',
      topicId: 't1',
      branchId: 'b1',
      anchorMessageId: 'm7',
      before: 10,
      after: 19
    }
    resolveFirst(makeWindowResponse(staleReq, AROUND_IDS))
    await p1
    expect(rebasePublications(seenFirst).length).toBe(0)
    expect(rebasePublications(seenSecond).length).toBe(1)
  })

  it('no-restore switch (route-latest + bootstrap): single latest fetch shared by both', async () => {
    const { loadRouteMessagesThunk, loadTopicMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    const pLatest = exec(loadRouteMessagesThunk('t1', 'b1', { kind: 'latest' }))
    const pBoot = exec(loadTopicMessagesThunk('t1'))
    await Promise.all([pLatest, pBoot])
    // One latest fetch total; both publishers carry the same tail.
    const latestCalls = mocks.fetchMessagesWindow.mock.calls.filter((c) => c[0].kind === 'latest')
    expect(latestCalls.length).toBe(1)
    const published = rebasePublications(seen)
    expect(published.length).toBe(1)
    expect(published[0]).toEqual(LATEST_IDS)
    const joints = jointPublications(seen)
    expect(joints.length).toBe(1)
    expect(joints[0].messages).toEqual(LATEST_IDS)
  })

  it('bootstrap alone (no in-flight restore): normal latest success with segments', async () => {
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const state = baseState()
    const getState = () => state
    const { exec, seen } = execDispatch(getState)
    await exec(loadTopicMessagesThunk('t1'))
    const kinds = mocks.fetchMessagesWindow.mock.calls.map((c) => c[0].kind)
    expect(kinds).toEqual(['latest'])
    expect(mocks.listSegments).toHaveBeenCalledWith('t1')
    const joints = jointPublications(seen)
    expect(joints.length).toBe(1)
    expect(joints[0].messages).toEqual(LATEST_IDS)
    expect(joints[0].segments).toEqual([])
  })
})
