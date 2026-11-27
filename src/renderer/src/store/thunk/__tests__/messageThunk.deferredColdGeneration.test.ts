/**
 * Cold-topic deferred route read — resident generation establishment.
 *
 * Root fault (code-provable): `loadRouteMessagesThunk` registers its
 * dispatch-source publication token as the resident applicability generation
 * that exists at registration time (`entry?.applicabilityGeneration ?? 0`),
 * with no bump. A deferred read for a topic that has no resident-registry
 * entry (a fresh cold topic, e.g. a search hit in a topic that was never
 * loaded) therefore registers generation 0, and the same-route bootstrap
 * adoption publishes the joint window under generation 0. The production
 * guard (`shouldDiscardJointPublish` + `rootReducer`) discards a joint
 * publication whose registry entry is missing, so the entire publication —
 * residency marker, message projection and retained window boundary — is
 * returned as state identity. `selectLoadedMessagesForTopic` then stays
 * undefined and the viewport keeps waiting for a resident projection that
 * will never arrive.
 *
 * Contract proven here (real `rootReducer` + real thunks, DB mocked only):
 * - a fresh cold topic's deferred read establishes exactly one canonical
 *   generation (>= 1) before the receipt captures it, so receipt, adoption
 *   joint publication and live entry share that same generation;
 * - the adopted resident bootstrap publishes successfully: resident marker,
 *   chatData, segments, the exact around window ids and the loaded projection;
 * - an existing entry is never bumped a second time and keeps its generation;
 * - an ordinary cold deferred latest read is still a single request, no
 *   joint publication, not resident;
 * - the guard still discards stale/absent-generation joint publications
 *   (no bypass), and a superseded deferred receipt still fails closed.
 */
import { configureStore } from '@reduxjs/toolkit'
import type { FetchMessagesWindowRequest } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchMessagesWindow: vi.fn()
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
vi.mock('@renderer/services/topicDeletionInvalidation', () => ({
  captureDeletionGeneration: vi.fn(() => 0),
  getDeletionGeneration: vi.fn(() => 0),
  isDeletionStale: vi.fn(() => false)
}))
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

import { rootReducer } from '@renderer/store'
import { selectLoadedMessagesForTopic } from '@renderer/store/newMessage'
import { bumpGeneration, publishResidentComplete, selectGeneration } from '@renderer/store/residentRegistry'
import type { FetchMessagesWindowResponse as WindowResponse } from '@shared/chatDb'

const TOPIC = 't-cold'

function makeStore() {
  const actions: any[] = []
  const recorder = () => (next: any) => (action: any) => {
    actions.push(action)
    return next(action)
  }
  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefault) => getDefault().concat(recorder)
  })
  return { store, actions }
}

function countType(actions: any[], type: string): number {
  return actions.filter((a) => a?.type === type).length
}

function aroundResponse(ids: string[], anchorMessageId: string, before = 2, after = 3): WindowResponse {
  const messages = ids.map((id) => ({ id })) as unknown as WindowResponse['messages']
  return {
    messages,
    blocks: [] as unknown as WindowResponse['blocks'],
    mutableMessageIds: [...ids],
    structure: { catalog: [] },
    window: {
      kind: 'around',
      completeness: 'window',
      topicId: TOPIC,
      anchorMessageId,
      requested: { before, after },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as WindowResponse
}

function latestResponse(ids: string[], limit = 10): WindowResponse {
  const messages = ids.map((id) => ({ id })) as unknown as WindowResponse['messages']
  return {
    messages,
    blocks: [] as unknown as WindowResponse['blocks'],
    mutableMessageIds: [...ids],
    structure: { catalog: [] },
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId: TOPIC,
      anchorMessageId: null,
      requested: { limit },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as WindowResponse
}

function deferredFetch(): (v: WindowResponse) => void {
  let resolve!: (v: WindowResponse) => void
  mocks.fetchMessagesWindow.mockImplementationOnce(
    () =>
      new Promise<WindowResponse>((res) => {
        resolve = res
      })
  )
  return (v: WindowResponse) => resolve(v)
}

type Store = ReturnType<typeof makeStore>['store']

function entryOf(store: Store, topicId = TOPIC): any {
  return (store.getState() as any).residentRegistry.entries[topicId]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('cold deferred route read — resident generation establishment', () => {
  it('fresh cold topic: the adopted around bootstrap publishes a resident projection', async () => {
    const { dispatchDeferredRouteWindowRead, loadTopicMessagesThunk } = await import('../messageThunk')
    const { store, actions } = makeStore()
    const resolveFetch = deferredFetch()

    // Same-route deferred around read (the search-hit target pipeline).
    const deferredPromise = dispatchDeferredRouteWindowRead(store.dispatch as any, store.getState as any, TOPIC, null, {
      kind: 'around',
      anchorMessageId: 'm3',
      before: 2,
      after: 3
    })
    // Cold mount bootstrap: adoption of the in-flight same-route restore.
    const bootstrapPromise = store.dispatch(loadTopicMessagesThunk(TOPIC) as any)

    // Canonical generation must exist before the receipt captured it.
    const entryBeforeSettle = entryOf(store)
    expect(entryBeforeSettle).toBeDefined()
    expect(entryBeforeSettle.applicabilityGeneration).toBeGreaterThanOrEqual(1)
    expect(entryBeforeSettle.residentTopic).toBe(false)

    const aroundIds = ['m1', 'm2', 'm3', 'm4', 'm5']
    resolveFetch(aroundResponse(aroundIds, 'm3'))
    const receipt = await deferredPromise
    await bootstrapPromise

    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
    // The deferred read did not issue its own second structure request.
    expect((mocks.fetchMessagesWindow.mock.calls[0][0] as FetchMessagesWindowRequest).kind).toBe('around')

    const entry = entryOf(store)
    expect(entry.applicabilityGeneration).toBeGreaterThanOrEqual(1)
    expect(entry.residentTopic).toBe(true)
    expect(entry.chatData).toBe(true)
    expect(entry.segments).toBe(true)
    // Receipt, joint publication and live entry share one generation.
    expect(receipt).toBeDefined()
    expect(receipt!.publicationGeneration).toBe(entry.applicabilityGeneration)
    // Exactly one generation establishment for this fresh topic.
    expect(countType(actions, 'residentRegistry/bumpGeneration')).toBe(1)
    expect(countType(actions, 'resident/jointPublishComplete')).toBe(1)
    const published = actions.find((a) => a?.type === 'resident/jointPublishComplete')
    expect(published?.payload?.generation).toBe(entry.applicabilityGeneration)

    // Resident projection is ready for the viewport.
    const projection = selectLoadedMessagesForTopic(store.getState() as any, TOPIC)
    expect(projection).toBeDefined()
    expect([...(projection as any)].map((m: any) => m.id)).toEqual(aroundIds)
  })

  it('existing entry: no second bump, receipt and joint keep the existing generation', async () => {
    const { dispatchDeferredRouteWindowRead, loadTopicMessagesThunk } = await import('../messageThunk')
    const { store, actions } = makeStore()
    store.dispatch(bumpGeneration(TOPIC))
    const preGen = entryOf(store).applicabilityGeneration as number
    expect(preGen).toBeGreaterThanOrEqual(1)
    const resolveFetch = deferredFetch()

    const deferredPromise = dispatchDeferredRouteWindowRead(store.dispatch as any, store.getState as any, TOPIC, null, {
      kind: 'around',
      anchorMessageId: 'm3',
      before: 2,
      after: 3
    })
    const bootstrapPromise = store.dispatch(loadTopicMessagesThunk(TOPIC) as any)
    const genAtRegistration = entryOf(store).applicabilityGeneration as number
    expect(genAtRegistration).toBe(preGen)

    resolveFetch(aroundResponse(['m2', 'm3', 'm4'], 'm3'))
    const receipt = await deferredPromise
    await bootstrapPromise

    const entry = entryOf(store)
    expect(countType(actions, 'residentRegistry/bumpGeneration')).toBe(1)
    expect(entry.applicabilityGeneration).toBe(preGen)
    expect(receipt!.publicationGeneration).toBe(preGen)
    expect(actions.find((a) => a?.type === 'resident/jointPublishComplete')?.payload?.generation).toBe(preGen)
    expect(entry.residentTopic).toBe(true)
  })

  it('ordinary cold deferred latest: one request, one canonical generation, no joint publication', async () => {
    const { dispatchDeferredRouteWindowRead } = await import('../messageThunk')
    const { store, actions } = makeStore()
    const resolveFetch = deferredFetch()

    const deferredPromise = dispatchDeferredRouteWindowRead(store.dispatch as any, store.getState as any, TOPIC, null, {
      kind: 'latest',
      limit: 10
    })
    const entryAtRegistration = entryOf(store)
    expect(entryAtRegistration.applicabilityGeneration).toBeGreaterThanOrEqual(1)

    resolveFetch(latestResponse(['m21', 'm22', 'm5']))
    const receipt = await deferredPromise

    expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
    expect(countType(actions, 'residentRegistry/bumpGeneration')).toBe(1)
    expect(countType(actions, 'resident/jointPublishComplete')).toBe(0)
    expect(receipt!.publicationGeneration).toBe(entryOf(store).applicabilityGeneration)
    expect(entryOf(store).residentTopic).toBe(false)
  })

  it('guard still discards a joint publication for a missing entry at generation 0', () => {
    const { store } = makeStore()
    const before = store.getState()
    store.dispatch(
      publishResidentComplete({
        topicId: 'other-cold',
        generation: 0,
        windowResponse: aroundResponse(['m1', 'm2'], 'm1'),
        segments: []
      })
    )
    expect(store.getState()).toBe(before)
  })

  it('guard still discards a stale-generation joint publication for an existing entry', () => {
    const { store } = makeStore()
    store.dispatch(bumpGeneration(TOPIC))
    store.dispatch(bumpGeneration(TOPIC))
    const gen = entryOf(store).applicabilityGeneration as number
    const before = store.getState()
    store.dispatch(
      publishResidentComplete({
        topicId: TOPIC,
        generation: gen - 1,
        windowResponse: aroundResponse(['m1', 'm2'], 'm1'),
        segments: []
      })
    )
    expect(store.getState()).toBe(before)
    expect(entryOf(store).applicabilityGeneration).toBe(gen)
    expect(entryOf(store).residentTopic).toBe(false)
  })

  it('superseded deferred receipt: the superseded read fails closed, the newer generation still publishes', async () => {
    const { dispatchDeferredRouteWindowRead, loadTopicMessagesThunk } = await import('../messageThunk')
    const { store, actions } = makeStore()
    const resolveFirst = deferredFetch()
    const resolveSecond = deferredFetch()

    const firstPromise = dispatchDeferredRouteWindowRead(store.dispatch as any, store.getState as any, TOPIC, null, {
      kind: 'around',
      anchorMessageId: 'm2',
      before: 1,
      after: 2
    })
    // A newer same-topic read supersedes the first registration.
    const secondPromise = dispatchDeferredRouteWindowRead(store.dispatch as any, store.getState as any, TOPIC, null, {
      kind: 'around',
      anchorMessageId: 'm4',
      before: 2,
      after: 3
    })
    const bootstrapPromise = store.dispatch(loadTopicMessagesThunk(TOPIC) as any)
    // The superseding read must not establish a second generation.
    expect(entryOf(store).applicabilityGeneration).toBe(1)

    resolveSecond(aroundResponse(['m3', 'm4', 'm5'], 'm4'))
    const secondReceipt = await secondPromise
    await bootstrapPromise
    expect(secondReceipt).toBeDefined()
    expect(secondReceipt!.publicationGeneration).toBe(1)

    resolveFirst(aroundResponse(['m1', 'm2', 'm3'], 'm2'))
    const firstReceipt = await firstPromise

    expect(firstReceipt).toBeUndefined()
    expect(countType(actions, 'resident/jointPublishComplete')).toBe(1)
    expect(selectLoadedMessagesForTopic(store.getState() as any, TOPIC)).toBeDefined()
    expect([...(selectLoadedMessagesForTopic(store.getState() as any, TOPIC) as any)].map((m: any) => m.id)).toEqual([
      'm3',
      'm4',
      'm5'
    ])
  })

  it('cold topic without a registry entry: the typed selector falls back to 0 like the legacy read', () => {
    const { store } = makeStore()
    const state = store.getState()
    expect(selectGeneration(state, 'never-loaded')).toBe(0)
    expect(selectGeneration(state, 'never-loaded')).toBe(
      (state as any).residentRegistry?.entries?.['never-loaded']?.applicabilityGeneration ?? 0
    )
  })
})
