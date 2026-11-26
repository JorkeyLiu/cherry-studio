/**
 * Generation ownership: same-topic same-route deferred-around adoption.
 *
 * Root fault: `loadTopicMessagesThunk` miss path bumped the resident
 * applicability generation unconditionally (2→3) BEFORE checking the shared
 * `pendingRouteRestoreByTopic` map, then adopted the pending deferred around
 * under the shared requestSeq and published the joint window under the
 * bumped generation. The dispatching prepare still gated on its pre-dispatch
 * capture (2), so it cancelled its own just-published around
 * (stale-gate post resident 2→3), while around/thunk settle/merge publish
 * paths never bump — the only bumper was the adopting latest itself.
 *
 * Contract under test:
 * - Around-first + latest-second (real child-before-parent effect order):
 *   the latest adopts the in-flight around under the dispatch-source
 *   publication generation with NO bump; the joint publication generation
 *   equals the registration generation; the prepare baseline adopts the
 *   registration the deferred entry itself proved (same-tick route + promise
 *   identity) and stays applicable; a later external bump still stales.
 * - Latest-settled then prepare-around: the around fetches independently
 *   (no false adoption/reuse), deferred with zero publications.
 * - The registration is transient dispatch/request-source identity only: the
 *   renderer never writes the resident registry to fix the gate (no
 *   `bumpGeneration` on the adopt path; the baseline moves only via the
 *   proven registration handed over by the deferred entry).
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

const AROUND_IDS = ['m7', 'm8', 'm9', 'm10', 'm21', 'm22', 'm1', 'm2', 'm3', 'm4', 'm23', 'm24', 'm5', 'm6']
const LATEST_IDS = ['m21', 'm22', 'm1', 'm2', 'm3', 'm4', 'm23', 'm24', 'm5', 'm6']

function makeWindowResponse(
  request: FetchMessagesWindowRequest,
  ids: string[],
  overrides: Partial<FetchMessagesWindowResponse['window']> = {}
): FetchMessagesWindowResponse {
  const messages = ids.map((id) => ({ id }))
  // Bundled-structure mirror of Main: the window response carries the
  // structure if and only if the request asked for it (empty catalog is a
  // valid known-empty signal, never a missing-structure fail-closed).
  const withStructure =
    (request as { includeStructure?: unknown }).includeStructure === true
      ? {
          structure: {
            catalog: [],
            route: {
              topicId: request.topicId,
              branchId: (request as { branchId?: string | null }).branchId ?? null,
              qualifications: []
            }
          }
        }
      : {}
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
    } as FetchMessagesWindowResponse['window'],
    ...withStructure
  } as unknown as FetchMessagesWindowResponse
}

function baseStateWithResidentGen(gen: number) {
  return {
    assistants: { assistants: [{ id: 'asst-1', settings: { contextCount: 5 }, topics: [{ id: 't1' }] }] },
    messages: {
      entities: {},
      messageIdsByTopic: {},
      loadingByTopic: {},
      fulfilledByTopic: {},
      currentTopicId: 't1',
      displayCount: 10
    },
    messageBlocks: { entities: {} },
    topicBranch: { branchesByTopic: {}, activeBranchIdByTopic: { t1: 'b1' }, routeGenerationByTopic: { t1: 1 } },
    residentRegistry: {
      entries: { t1: { residentTopic: false, chatData: false, segments: false, applicabilityGeneration: gen } }
    }
  } as any
}

function execDispatch(getState: () => any) {
  const seen: any[] = []
  const exec: any = (action: any) => {
    seen.push(action)
    if (typeof action === 'function') return action(exec, getState)
    return action
  }
  return { exec, seen }
}

const bumpActions = (seen: any[]): any[] =>
  seen.filter((a) => typeof a?.type === 'string' && a.type.endsWith('/bumpGeneration'))
const jointGenerations = (seen: any[]): number[] =>
  seen.filter((a) => a?.payload?.windowResponse).map((a) => a.payload.generation as number)
const jointMessages = (seen: any[]): string[][] =>
  seen
    .filter((a) => a?.payload?.windowResponse)
    .map((a) => (a.payload.windowResponse.messages as Array<{ id: string }>).map((m) => m.id))

describe('generation ownership: deferred-around adoption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deletionMocks.captureDeletionGeneration.mockReturnValue(0)
    deletionMocks.getDeletionGeneration.mockReturnValue(0)
    deletionMocks.isDeletionStale.mockReturnValue(false)
    mocks.listSegments.mockResolvedValue([])
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      if (req.kind === 'around') return makeWindowResponse(req, AROUND_IDS)
      return makeWindowResponse(req, LATEST_IDS, { hasMoreBefore: true, hasMoreAfter: false })
    })
  })

  it('around-first + latest-second: latest adopts under the proven registration with no bump; the handed registration keeps the prepare baseline applicable; external bump still stales', async () => {
    const { dispatchDeferredRouteWindowRead, loadTopicMessagesThunk } = await import('../messageThunk')
    const { shouldDiscardPaginationForResident } = await import('@renderer/services/paginationResidentGuard')
    const state = baseStateWithResidentGen(2)
    const getState = () => state
    const { exec, seen } = execDispatch(getState)

    // Prepare captures 2, then dispatches its deferred around through the only
    // deferred entry. The entry proves its own registration in the sync prefix
    // (same tick: route + promise identity) and hands it over before any await,
    // so the caller never reads the pending map or repeats the proof.
    const prepareCaptured = 2
    let registration: any = null
    const pDeferred = dispatchDeferredRouteWindowRead(
      exec,
      getState,
      't1',
      'b1',
      { kind: 'around', anchorMessageId: 'm7', before: 10, after: 19 },
      {
        onRegistrationProven: (proven) => {
          registration = proven
        }
      }
    )
    // Synchronous handoff: already delivered before the first await settles.
    expect(registration).not.toBeNull()
    expect(registration.topicId).toBe('t1')
    expect(registration.route).toBe('b1')
    expect(registration.publicationGeneration).toBe(prepareCaptured)

    // Bootstrap latest dispatched second adopts the same in-flight around.
    const pBoot = exec(loadTopicMessagesThunk('t1'))
    const [deferredReceipt] = await Promise.all([pDeferred, pBoot])

    // Single flight: exactly one around fetch, zero latest fetches.
    const kinds = mocks.fetchMessagesWindow.mock.calls.map((c) => c[0].kind as string)
    expect(kinds.filter((k) => k === 'around').length).toBe(1)
    expect(kinds.filter((k) => k === 'latest').length).toBe(0)

    // The adopting joint carries the anchor window under the registration
    // generation (2) — not a bumped 3 — and the adopter bumped nothing.
    expect(jointMessages(seen)).toEqual([AROUND_IDS])
    expect(jointGenerations(seen)).toEqual([2])
    expect(bumpActions(seen).length).toBe(0)

    // The receipt repeats the handed registration: one proven identity, not a
    // second map read.
    expect(deferredReceipt).toBeTruthy()
    expect((deferredReceipt as any).requestSeq).toBe(registration.requestSeq)
    expect((deferredReceipt as any).publicationGeneration).toBe(registration.publicationGeneration)
    expect((deferredReceipt as any).route).toBe(registration.route)

    // Prepare adopts that registration into its local baseline: its own
    // publication no longer self-stales, an external advance still stales.
    expect(shouldDiscardPaginationForResident(registration.publicationGeneration, jointGenerations(seen)[0])).toBe(
      false
    )
    expect(shouldDiscardPaginationForResident(registration.publicationGeneration, 3)).toBe(true)
  })

  it('same-tick newer registration: each dispatch is handed only its own proven registration and the superseded read yields no receipt', async () => {
    const { dispatchDeferredRouteWindowRead } = await import('../messageThunk')
    const state = baseStateWithResidentGen(2)
    const getState = () => state
    const { exec } = execDispatch(getState)

    let firstRegistration: any = null
    let secondRegistration: any = null
    const pFirst = dispatchDeferredRouteWindowRead(
      exec,
      getState,
      't1',
      'b1',
      { kind: 'latest', limit: 10 },
      {
        onRegistrationProven: (proven) => {
          firstRegistration = proven
        }
      }
    )
    const pSecond = dispatchDeferredRouteWindowRead(
      exec,
      getState,
      't1',
      'b1',
      { kind: 'latest', limit: 10 },
      {
        onRegistrationProven: (proven) => {
          secondRegistration = proven
        }
      }
    )

    // Both handoffs already happened, each with its own dispatch identity: the
    // newer registration never replaces the older one that was already handed.
    expect(firstRegistration).not.toBeNull()
    expect(secondRegistration).not.toBeNull()
    expect(firstRegistration.requestSeq).toBeLessThan(secondRegistration.requestSeq)

    const [firstReceipt, secondReceipt] = await Promise.all([pFirst, pSecond])
    // Superseded: no receipt at all, so the older identity can never reach a
    // later publication (no -1 sentinel identity is ever produced).
    expect(firstReceipt).toBeUndefined()
    expect((secondReceipt as any)?.requestSeq).toBe(secondRegistration.requestSeq)
    expect((secondReceipt as any)?.publicationGeneration).toBe(secondRegistration.publicationGeneration)
  })

  it('latest-settled then prepare-around: independent around fetch, no false adoption or reuse', async () => {
    const { dispatchDeferredRouteWindowRead, loadTopicMessagesThunk } = await import('../messageThunk')
    const state = baseStateWithResidentGen(2)
    const getState = () => state
    const { exec, seen } = execDispatch(getState)

    await exec(loadTopicMessagesThunk('t1'))
    expect(mocks.fetchMessagesWindow.mock.calls.map((c) => c[0].kind)).toEqual(['latest'])
    // Latest-first (no pending) keeps the historic bump+latest path.
    expect(bumpActions(seen).length).toBe(1)
    expect(jointGenerations(seen).length).toBe(1)

    const jointsBefore = jointGenerations(seen).length
    let registration: any = null
    const aroundReceipt = await dispatchDeferredRouteWindowRead(
      exec,
      getState,
      't1',
      'b1',
      { kind: 'around', anchorMessageId: 'm7', before: 10, after: 19 },
      {
        onRegistrationProven: (proven) => {
          registration = proven
        }
      }
    )
    // The settled latest left no adoptable hold: the around fetches on its own
    // registration instead of reusing the completed read.
    expect(registration).not.toBeNull()
    expect(registration.requestSeq).toBeGreaterThan(0)
    expect(aroundReceipt && (aroundReceipt as any).requestSeq).toBe(registration.requestSeq)
    expect(mocks.fetchMessagesWindow.mock.calls.map((c) => c[0].kind)).toEqual(['latest', 'around'])
    // Deferred: zero publications — the stage merges the returned window.
    expect(jointGenerations(seen).length).toBe(jointsBefore)
    expect(seen.filter((a) => a?.type === 'newMessages/rebaseRouteMessages').length).toBe(0)
  })

  it('overlapping same-topic restores: an older settle never reclaims the newer registration and the bootstrap still adopts the newer read', async () => {
    const { dispatchDeferredRouteWindowRead, loadTopicMessagesThunk } = await import('../messageThunk')
    const state = baseStateWithResidentGen(2)
    const getState = () => state
    const { exec, seen } = execDispatch(getState)

    // Both requests stay in flight until released below (the newer one must
    // still own the shared single-flight entry when the older settles).
    // Both requests stay in flight until released below (the newer one must
    // still own the shared single-flight entry when the older settles). Each
    // read is released with the response Main would build for ITS OWN request
    // (the deferred read asks for the bundled structure), so the adopting
    // bootstrap can consume it without a refetch.
    let calls = 0
    const inFlight: Array<{
      request: FetchMessagesWindowRequest
      release: (response: FetchMessagesWindowResponse) => void
    }> = []
    mocks.fetchMessagesWindow.mockImplementation(
      (req: FetchMessagesWindowRequest) =>
        new Promise<FetchMessagesWindowResponse>((resolve) => {
          calls += 1
          inFlight.push({ request: req, release: resolve })
        })
    )

    let oldRegistration: any = null
    let newRegistration: any = null
    const pOld = dispatchDeferredRouteWindowRead(
      exec,
      getState,
      't1',
      'b1',
      { kind: 'latest', limit: 10 },
      {
        onRegistrationProven: (proven) => {
          oldRegistration = proven
        }
      }
    )
    const pNew = dispatchDeferredRouteWindowRead(
      exec,
      getState,
      't1',
      'b1',
      { kind: 'latest', limit: 10 },
      {
        onRegistrationProven: (proven) => {
          newRegistration = proven
        }
      }
    )
    expect(oldRegistration.requestSeq).toBeLessThan(newRegistration.requestSeq)

    // Old settles first: its requestSeq guard must not reclaim the new entry.
    inFlight[0].release(makeWindowResponse(inFlight[0].request, LATEST_IDS))
    const oldReceipt = await pOld
    expect(oldReceipt).toBeUndefined()

    // The newer registration is still the single-flight owner: the bootstrap
    // adopts it (no third fetch, no competing latest) and publishes the joint
    // under its registration generation.
    const pBoot = exec(loadTopicMessagesThunk('t1'))
    inFlight[1].release(
      makeWindowResponse(inFlight[1].request, LATEST_IDS, { hasMoreBefore: true, hasMoreAfter: false })
    )
    const [newReceipt] = await Promise.all([pNew, pBoot])
    expect(calls).toBe(2)
    expect((newReceipt as any)?.requestSeq).toBe(newRegistration.requestSeq)
    expect(jointGenerations(seen)).toEqual([newRegistration.publicationGeneration])
    expect(bumpActions(seen).length).toBe(0)
  })
})
