/**
 * Phase 4 resident lifecycle/read-path observability hardening — cohesive thunk-driven sequence.
 *
 * Renderer-local, bounded scalar-only, no B-01..B-05, no IPC/preload/shared/persistence/SQLite/schema/StoreSync.
 * Proves in one isolated thunk-driven batch:
 * 1) staged fetch failure (one or both legs) increments staged failed and never discarded, followed by validated stale-generation discard with snapshot invariants and privacy-safe scalars;
 * 2) resident lifecycle reset/retry through existing local seams: complete -> generation advance/incomplete -> reset -> successful retry with coherent recomputation;
 * 3) malformed vs generation-mismatch through thunk-driven paths with distinct discard counters and no publication.
 *
 * Correction: uses isolated Redux store with real residentRegistry/newMessage reducers/action paths for bumpGeneration,
 * joint publication, and reset lifecycle transitions; generation mismatch via production bumpGeneration while staged reads
 * are pending (no direct increment); SENTINEL_CONTENT injected into realistic mocked window response payload exercised
 * by thunk and asserted absent from Phase4Snapshot and Phase4BoundScalars. External/db reads remain mocked.
 * Reuses existing test helpers/conventions and existing mocks. Latency assertions are finite/non-negative, never exact.
 */

import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type { getResidentDiagnostics } from '@renderer/services/residentDiagnostics'
import type { getResidentReadDiagnostics } from '@renderer/services/residentReadDiagnostics'
import messageBlocksReducer from '@renderer/store/messageBlock'
import newMessagesReducer from '@renderer/store/newMessage'
import residentRegistryReducer, {
  bumpGeneration,
  JOINT_PUBLISH_COMPLETE,
  resetAllResidentRegistry
} from '@renderer/store/residentRegistry'
import topicSegmentReducer from '@renderer/store/topicSegment'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    listSegments: vi.fn()
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
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({ AiSdkToChunkAdapter: class {} }))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
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
    anchorMessageId: null,
    requested: { limit: (request as any).limit },
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

function makeSentinelWindowResponse(
  request: FetchMessagesWindowRequest,
  topicId: string,
  sentinel: string
): FetchMessagesWindowResponse {
  const msgId = `m-${topicId}-sentinel`
  const blockId = `b-${topicId}-sentinel`
  const messages = [
    {
      id: msgId,
      topicId,
      role: 'assistant' as const,
      content: sentinel,
      blocks: [blockId]
    }
  ]
  const blocks = [
    {
      id: blockId,
      messageId: msgId,
      type: 'main_text' as const,
      content: sentinel,
      status: 'success' as const
    }
  ]
  const resp = makeWindowResponse(request, messages as any)
  ;(resp as any).blocks = blocks as any
  return resp
}

function makeSentinelSegments(topicId: string, sentinel: string) {
  const now = new Date().toISOString()
  return [
    {
      id: `seg-${topicId}-sentinel`,
      topicId,
      name: sentinel,
      messageIds: [],
      color: 'blue',
      createdAt: now,
      updatedAt: now
    }
  ]
}

// Privacy sentinels — must never appear in scalar snapshot output
const SENTINEL_TOPIC = 'SENTINEL_TOPIC_priv_hardening_9c284b7f'
const SENTINEL_CONTENT = 'SENTINEL_CONTENT_priv_hardening_abc123'

function assertBoundScalarsInvariant(
  diag: ReturnType<typeof getResidentReadDiagnostics>,
  resident: ReturnType<typeof getResidentDiagnostics>
) {
  // read-path derived invariants
  expect(diag.missCount).toBe(
    diag.missForced +
      diag.missNoIndex +
      diag.missDeletion +
      diag.missLegacyEmpty +
      diag.missNoEntry +
      diag.missIncomplete
  )
  expect(diag.totalRequests).toBe(diag.hitCount + diag.missCount)
  expect(diag.discardedCount).toBe(
    diag.discardedSuperseded +
      diag.discardedCurrentMoved +
      diag.discardedDeletedDuringFetch +
      diag.discardedGenerationMismatch +
      diag.discardedMalformed
  )
  expect(diag.stagedCount).toBe(diag.stagedSuccessCount + diag.stagedFailedCount)
  if (diag.stagedCount > 0) {
    expect(diag.stagedTotalMs).toBeGreaterThanOrEqual(0)
    expect(diag.stagedMaxMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(diag.stagedTotalMs)).toBe(true)
    expect(Number.isFinite(diag.stagedMaxMs)).toBe(true)
    expect(diag.stagedLastMs === null || (Number.isFinite(diag.stagedLastMs) && diag.stagedLastMs >= 0)).toBe(true)
    expect(diag.stagedAvgMs === null || (Number.isFinite(diag.stagedAvgMs) && diag.stagedAvgMs >= 0)).toBe(true)
    if (diag.stagedAvgMs !== null) {
      expect(Math.abs(diag.stagedAvgMs - diag.stagedTotalMs / diag.stagedCount)).toBeLessThan(1e-6)
    }
  } else {
    expect(diag.stagedTotalMs).toBe(0)
    expect(diag.stagedMaxMs).toBe(0)
  }
  // resident invariants
  expect(resident.incompleteCount).toBe(resident.entryCount - resident.residentCount)
  expect(resident.incompleteCount).toBeGreaterThanOrEqual(0)
  expect(resident.entryCount).toBeGreaterThanOrEqual(resident.residentCount)
  // privacy: no sentinel leakage — diagnostics are scalar-only
  expect(JSON.stringify(diag)).not.toContain(SENTINEL_TOPIC)
  expect(JSON.stringify(diag)).not.toContain(SENTINEL_CONTENT)
  expect(JSON.stringify(resident)).not.toContain(SENTINEL_TOPIC)
  expect(JSON.stringify(resident)).not.toContain(SENTINEL_CONTENT)
  // scalar-only shape
  for (const v of Object.values(diag)) expect(v === null || typeof v === 'number').toBe(true)
  for (const v of Object.values(resident)) expect(typeof v === 'number').toBe(true)
  // no invented field
  expect((diag as unknown as Record<string, unknown>).discardedFetchFailed).toBeUndefined()
}

function getSentinelIds(topicId: string) {
  return {
    messageId: `m-${topicId}-sentinel`,
    blockId: `b-${topicId}-sentinel`,
    segmentId: `seg-${topicId}-sentinel`
  }
}

function captureProjectionSlices(store: ReturnType<typeof createIsolatedTestStore>) {
  const s = store.getState()
  return {
    messageIds: [...s.messages.ids] as string[],
    messageIdsByTopic: JSON.parse(JSON.stringify(s.messages.messageIdsByTopic)),
    messageEntities: JSON.parse(JSON.stringify(s.messages.entities)),
    blockIds: [...s.messageBlocks.ids] as string[],
    blockEntities: JSON.parse(JSON.stringify(s.messageBlocks.entities)),
    segmentIds: [...s.topicSegments.segments.ids] as string[],
    segmentEntities: JSON.parse(JSON.stringify(s.topicSegments.segments.entities)),
    segmentsByTopic: JSON.parse(JSON.stringify(s.topicSegments.segmentsByTopic))
  }
}

function assertNoSentinelPublication(
  store: ReturnType<typeof createIsolatedTestStore>,
  topicId: string,
  sentinel: string,
  before: ReturnType<typeof captureProjectionSlices>
) {
  const { messageId, blockId, segmentId } = getSentinelIds(topicId)
  const s = store.getState()
  // Identities from rejected payload must be absent across real projection slices
  expect(s.messages.ids).not.toContain(messageId)
  expect(s.messageBlocks.ids).not.toContain(blockId)
  expect(s.topicSegments.segments.ids).not.toContain(segmentId)
  expect(s.messages.entities[messageId]).toBeUndefined()
  expect(s.messageBlocks.entities[blockId]).toBeUndefined()
  expect(s.topicSegments.segments.entities[segmentId]).toBeUndefined()
  expect(s.messages.messageIdsByTopic[topicId] ?? []).not.toContain(messageId)
  expect(s.topicSegments.segmentsByTopic[topicId] ?? []).not.toContain(segmentId)
  // Sentinel-bearing payloads must not have leaked into projection
  expect(JSON.stringify(s.messages.entities)).not.toContain(sentinel)
  expect(JSON.stringify(s.messageBlocks.entities)).not.toContain(sentinel)
  expect(JSON.stringify(s.topicSegments.segments.entities)).not.toContain(sentinel)
  // Projection slices unchanged relative to before (no accidental joint publication)
  // setCurrentTopicId may create an empty array for the attempted topic even on discard — allow that empty creation but no sentinel
  expect(s.messages.ids).toEqual(before.messageIds)
  expect(s.messages.entities).toEqual(before.messageEntities)
  const afterMsgTopicIds = s.messages.messageIdsByTopic as Record<string, string[]>
  const beforeMsgTopicIds = before.messageIdsByTopic as Record<string, string[]>
  expect(afterMsgTopicIds[topicId] ?? []).not.toContain(messageId)
  expect((afterMsgTopicIds[topicId] ?? []).length).toBe(0)
  const normalizedBeforeMsg = { ...beforeMsgTopicIds }
  const normalizedAfterMsg: Record<string, string[]> = { ...afterMsgTopicIds }
  if (
    !(topicId in normalizedBeforeMsg) &&
    Array.isArray(normalizedAfterMsg[topicId]) &&
    normalizedAfterMsg[topicId].length === 0
  ) {
    delete normalizedAfterMsg[topicId]
  }
  expect(normalizedAfterMsg).toEqual(normalizedBeforeMsg)
  expect(s.messageBlocks.ids).toEqual(before.blockIds)
  expect(s.messageBlocks.entities).toEqual(before.blockEntities)
  expect(s.topicSegments.segments.ids).toEqual(before.segmentIds)
  expect(s.topicSegments.segments.entities).toEqual(before.segmentEntities)
  const afterSegByTopic = s.topicSegments.segmentsByTopic as Record<string, string[]>
  const beforeSegByTopic = before.segmentsByTopic as Record<string, string[]>
  expect(afterSegByTopic[topicId] ?? []).not.toContain(segmentId)
  expect((afterSegByTopic[topicId] ?? []).length).toBe(0)
  const normalizedBeforeSeg = { ...beforeSegByTopic }
  const normalizedAfterSeg: Record<string, string[]> = { ...afterSegByTopic }
  if (
    !(topicId in normalizedBeforeSeg) &&
    Array.isArray(normalizedAfterSeg[topicId]) &&
    normalizedAfterSeg[topicId].length === 0
  ) {
    delete normalizedAfterSeg[topicId]
  }
  expect(normalizedAfterSeg).toEqual(normalizedBeforeSeg)
  // Serialized projection (excluding diagnostics) must not contain sentinel
  expect(JSON.stringify(s.messages)).not.toContain(sentinel)
  expect(JSON.stringify(s.messageBlocks)).not.toContain(sentinel)
  expect(JSON.stringify(s.topicSegments)).not.toContain(sentinel)
}

function createIsolatedTestStore(topicIds: string[], recordedActions?: any[]) {
  // Minimal assistants state containing the test topics so anchorService can resolve owners if needed
  const now = new Date().toISOString()
  const assistantTopics = topicIds.map((id) => ({
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    messages: []
  }))
  const assistantsInitial: any = {
    defaultAssistant: {
      id: 'asst-1',
      name: 'asst-1',
      prompt: '',
      topics: assistantTopics,
      type: 'assistant',
      settings: {}
    },
    assistants: [
      {
        id: 'asst-1',
        name: 'asst-1',
        prompt: '',
        topics: assistantTopics,
        type: 'assistant',
        settings: {},
        model: undefined
      }
    ],
    tagsOrder: [],
    collapsedTags: {},
    presets: [],
    unifiedListOrder: []
  }

  // Assistants is a stub reducer — real reducer would bring side-effects via getDefaultAssistant
  // and persist; for this test we only need deterministic topic ownership without lifecycle effects.
  const assistantsStubReducer = (state: any = assistantsInitial) => state

  const rootReducer = combineReducers({
    assistants: assistantsStubReducer as any,
    messages: newMessagesReducer as any,
    messageBlocks: messageBlocksReducer as any,
    topicSegments: topicSegmentReducer as any,
    residentRegistry: residentRegistryReducer as any
  })

  return configureStore({
    reducer: rootReducer as any,
    middleware: (getDefaultMiddleware) => {
      const mw = getDefaultMiddleware()
      if (recordedActions) {
        const recorder: any = () => (next: any) => (action: any) => {
          recordedActions.push(action)
          return next(action)
        }
        return mw.concat(recorder)
      }
      return mw
    },
    preloadedState: {
      assistants: assistantsInitial,
      messages: {
        ids: [],
        entities: {},
        messageIdsByTopic: {},
        currentTopicId: null,
        loadingByTopic: {},
        fulfilledByTopic: {},
        displayCount: 10
      } as any,
      messageBlocks: {
        ids: [],
        entities: {},
        loadingState: 'idle',
        error: null
      } as any,
      topicSegments: {
        segments: { ids: [], entities: {} },
        segmentsByTopic: {}
      } as any,
      residentRegistry: { entries: {} } as any
    } as any
  })
}

describe('Phase 4 resident observability hardening — cohesive lifecycle/read-path (renderer-local)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { resetResidentReadDiagnosticsForTests } = await import('@renderer/services/residentReadDiagnostics')
    resetResidentReadDiagnosticsForTests()
    const { resetAllDeletionGenerationsForTests } = await import('@renderer/services/topicDeletionInvalidation')
    resetAllDeletionGenerationsForTests()

    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      const limit = (req as any).limit ?? 10
      const msgs = Array.from({ length: Math.min(limit, 2) }, (_, i) => ({
        id: `m-${i}`,
        topicId: req.topicId,
        blocks: []
      }))
      return makeWindowResponse(req, msgs)
    })
    mocks.listSegments.mockResolvedValue([])
    mocks.ensureTopicAnchorEstablished.mockResolvedValue(undefined)
  })

  it('staged fetch failure (single and both legs) increments stagedFailed never discarded, then stale-generation discard in same isolated state — snapshot/bound invariants and privacy', async () => {
    const { getResidentReadDiagnostics } = await import('@renderer/services/residentReadDiagnostics')
    const { getResidentDiagnostics } = await import('@renderer/services/residentDiagnostics')
    const { getPhase4Snapshot, getPhase4BoundScalars } = await import('@renderer/services/phase4Observability')
    const { loadTopicMessagesThunk } = await import('@renderer/store/thunk/messageThunk')

    const topicSingle = 't-hardening-fail-single'
    const topicBoth = 't-hardening-fail-both'
    const topicDiscard = 't-hardening-discard-gen'

    const recordedActions: any[] = []
    const store = createIsolatedTestStore([topicSingle, topicBoth, topicDiscard], recordedActions)

    const getEntries = () => store.getState().residentRegistry.entries as Record<string, any>

    // Step 1: single-leg failure — window resolves, segment leg rejects
    {
      const windowResp = makeWindowResponse(
        { kind: 'latest', topicId: topicSingle, limit: 10 } as unknown as FetchMessagesWindowRequest,
        [{ id: 'm-single', topicId: topicSingle, blocks: [], content: SENTINEL_CONTENT } as any]
      )
      ;(windowResp as any).blocks = [
        { id: 'b-single', messageId: 'm-single', type: 'main_text', content: SENTINEL_CONTENT } as any
      ]
      mocks.fetchMessagesWindow.mockImplementationOnce(async () => windowResp)
      mocks.listSegments.mockRejectedValueOnce(new Error('segment leg failure'))

      const before = getResidentReadDiagnostics()
      await (store.dispatch as any)(loadTopicMessagesThunk(topicSingle))
      const after = getResidentReadDiagnostics()

      expect(after.stagedCount - before.stagedCount).toBe(1)
      expect(after.stagedFailedCount - before.stagedFailedCount).toBe(1)
      expect(after.stagedSuccessCount - before.stagedSuccessCount).toBe(0)
      expect(after.discardedCount - before.discardedCount).toBe(0)
      expect((after as unknown as Record<string, unknown>).discardedFetchFailed).toBeUndefined()

      // no publication for failed topic — resident not established via real reducer
      expect(getEntries()[topicSingle]?.residentTopic).not.toBe(true)

      // latency finite/non-negative, never exact equality
      expect(Number.isFinite(after.stagedTotalMs)).toBe(true)
      expect(Number.isFinite(after.stagedMaxMs)).toBe(true)
      expect(after.stagedTotalMs).toBeGreaterThanOrEqual(0)
      expect(after.stagedMaxMs).toBeGreaterThanOrEqual(0)
      expect(after.stagedLastMs === null || after.stagedLastMs >= 0).toBe(true)
      expect(JSON.stringify(after)).not.toContain(topicSingle)
      expect(JSON.stringify(after)).not.toContain(SENTINEL_TOPIC)
      expect(JSON.stringify(after)).not.toContain(SENTINEL_CONTENT)

      // snapshot/bound coherent — sentinel must not leak even though window payload contained it
      const snap = getPhase4Snapshot(null, getEntries())
      const scalars = getPhase4BoundScalars(null, getEntries())
      expect(snap.residentRead.stagedCount).toBe(after.stagedCount)
      expect(scalars.readStagedFailedCount).toBe(after.stagedFailedCount)
      expect(scalars.readDiscardedCount).toBe(after.discardedCount)
      assertBoundScalarsInvariant(after, getResidentDiagnostics(getEntries()))
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_TOPIC)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(snap.residentRead)).not.toContain(topicSingle)
      expect(JSON.stringify(snap.residentRead)).not.toContain(SENTINEL_CONTENT)
    }

    // Step 2: both legs reject — counted once, still never discarded
    {
      mocks.fetchMessagesWindow.mockRejectedValueOnce(new Error('window leg failure'))
      mocks.listSegments.mockRejectedValueOnce(new Error('segment leg failure'))
      const before = getResidentReadDiagnostics()
      await (store.dispatch as any)(loadTopicMessagesThunk(topicBoth))
      const after = getResidentReadDiagnostics()
      expect(after.stagedCount - before.stagedCount).toBe(1)
      expect(after.stagedFailedCount - before.stagedFailedCount).toBe(1)
      expect(after.stagedSuccessCount - before.stagedSuccessCount).toBe(0)
      expect(after.discardedCount - before.discardedCount).toBe(0)
      expect((after as unknown as Record<string, unknown>).discardedFetchFailed).toBeUndefined()
      expect(getEntries()[topicBoth]?.residentTopic).not.toBe(true)
      expect(JSON.stringify(after)).not.toContain(topicBoth)
      expect(JSON.stringify(after)).not.toContain(SENTINEL_CONTENT)
      assertBoundScalarsInvariant(after, getResidentDiagnostics(getEntries()))
      const snap = getPhase4Snapshot(null, getEntries())
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(getPhase4BoundScalars(null, getEntries()))).not.toContain(SENTINEL_CONTENT)
    }

    // Step 3: validated stale-generation discard in SAME isolated state — staged success, discarded generationMismatch distinct, no stagedFailed increment
    {
      // Use sentinel-bearing payload for this staged attempt — should be discarded and not leak
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        const msgs = [{ id: `m-${req.topicId}`, topicId: req.topicId, blocks: [], content: SENTINEL_CONTENT } as any]
        const resp = makeWindowResponse(req, msgs as any)
        ;(resp as any).blocks = [
          { id: `b-${req.topicId}`, messageId: `m-${req.topicId}`, type: 'main_text', content: SENTINEL_CONTENT } as any
        ]
        return resp
      })
      mocks.listSegments.mockImplementation(
        async (topicId: string) => makeSentinelSegments(topicId, SENTINEL_CONTENT) as any
      )

      let resolveW: (v: unknown) => void
      let resolveS: (v: unknown) => void
      mocks.fetchMessagesWindow.mockImplementationOnce(() => new Promise((resolve) => (resolveW = resolve as any)))
      mocks.listSegments.mockImplementationOnce(() => new Promise((resolve) => (resolveS = resolve as any)))

      const before = getResidentReadDiagnostics()
      const beforeResident = getResidentDiagnostics(getEntries())
      const beforeProjection = captureProjectionSlices(store)
      const beforeJointCount = recordedActions.filter((a) => a?.type === JOINT_PUBLISH_COMPLETE).length
      const p = (store.dispatch as any)(loadTopicMessagesThunk(topicDiscard))
      await Promise.resolve()
      await Promise.resolve()
      // Produce generation mismatch through production generation-advance action while staged reads are pending
      store.dispatch(bumpGeneration(topicDiscard))
      const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: topicDiscard, limit: 10 } as any
      const sentinelResp = makeSentinelWindowResponse(req, topicDiscard, SENTINEL_CONTENT)
      resolveW!(sentinelResp)
      resolveS!(makeSentinelSegments(topicDiscard, SENTINEL_CONTENT))
      await p
      const after = getResidentReadDiagnostics()
      const afterResident = getResidentDiagnostics(getEntries())
      // rejected payload non-publication: sentinel IDs absent and projection slices unchanged
      assertNoSentinelPublication(store, topicDiscard, SENTINEL_CONTENT, beforeProjection)
      expect(recordedActions.filter((a) => a?.type === JOINT_PUBLISH_COMPLETE).length).toBe(beforeJointCount)

      expect(after.stagedCount - before.stagedCount).toBe(1)
      expect(after.stagedSuccessCount - before.stagedSuccessCount).toBe(1)
      expect(after.stagedFailedCount - before.stagedFailedCount).toBe(0)
      expect(after.discardedCount - before.discardedCount).toBe(1)
      expect(after.discardedGenerationMismatch - before.discardedGenerationMismatch).toBe(1)
      // staged failure counters unchanged for this step
      expect(after.discardedMalformed - before.discardedMalformed).toBe(0)
      expect(after.discardedSuperseded - before.discardedSuperseded).toBe(0)
      // no publication — resident not made resident by discarded attempt
      expect(getEntries()[topicDiscard]?.residentTopic).not.toBe(true)
      expect(afterResident.residentCount).toBe(beforeResident.residentCount)
      expect(afterResident.entryCount).toBe(beforeResident.entryCount + 1)
      expect(after.stagedLastMs === null || after.stagedLastMs >= 0).toBe(true)
      expect(Number.isFinite(after.stagedTotalMs)).toBe(true)

      // final cumulative invariants across all three steps
      expect(after.stagedCount).toBe(3)
      expect(after.stagedFailedCount).toBe(2)
      expect(after.stagedSuccessCount).toBe(1)
      expect(after.discardedCount).toBe(1)
      expect(after.discardedGenerationMismatch).toBe(1)

      const snap = getPhase4Snapshot(null, getEntries())
      const scalars = getPhase4BoundScalars(null, getEntries())
      expect(snap.residentRead).toEqual(after)
      expect(scalars.readStagedCount).toBe(after.stagedCount)
      expect(scalars.readStagedFailedCount).toBe(after.stagedFailedCount)
      expect(scalars.readDiscardedGenerationMismatch).toBe(after.discardedGenerationMismatch)
      expect(JSON.stringify(snap.residentRead)).not.toContain(topicDiscard)
      expect(JSON.stringify(snap.residentRead)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CONTENT)
      assertBoundScalarsInvariant(after, afterResident)
      // scalar-only shape check
      for (const v of Object.values(snap.residentRead)) expect(v === null || typeof v === 'number').toBe(true)
    }

    // restore defaults for other tests
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      const msgs = [{ id: `m-${req.topicId}`, topicId: req.topicId, blocks: [] }]
      return makeWindowResponse(req, msgs as any)
    })
    mocks.listSegments.mockResolvedValue([])
  })

  it('resident lifecycle reset/retry through local seams recomputes resident and read diagnostics coherently', async () => {
    const { getResidentDiagnostics } = await import('@renderer/services/residentDiagnostics')
    const { getResidentReadDiagnostics, resetResidentReadDiagnosticsForTests } = await import(
      '@renderer/services/residentReadDiagnostics'
    )
    const { getPhase4Snapshot, getPhase4BoundScalars } = await import('@renderer/services/phase4Observability')
    const { loadTopicMessagesThunk } = await import('@renderer/store/thunk/messageThunk')

    const topic = 't-hardening-lifecycle'
    const store = createIsolatedTestStore([topic])
    const getEntries = () => store.getState().residentRegistry.entries as Record<string, any>

    // Ensure staged success path with sentinel-bearing payload exercised via thunk
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      return makeSentinelWindowResponse(req, req.topicId, SENTINEL_CONTENT)
    })
    mocks.listSegments.mockImplementation(
      async (topicId: string) => makeSentinelSegments(topicId, SENTINEL_CONTENT) as any
    )

    // Step complete: successful thunk makes resident complete via real joint publication reducer
    {
      const beforeRead = getResidentReadDiagnostics()
      const beforeResident = getResidentDiagnostics(getEntries())
      await (store.dispatch as any)(loadTopicMessagesThunk(topic))
      const afterRead = getResidentReadDiagnostics()
      const afterResident = getResidentDiagnostics(getEntries())
      expect(afterResident.entryCount).toBe(beforeResident.entryCount + 1)
      expect(afterResident.residentCount).toBe(beforeResident.residentCount + 1)
      expect(afterResident.chatDataCount).toBe(beforeResident.chatDataCount + 1)
      expect(afterResident.segmentsCount).toBe(beforeResident.segmentsCount + 1)
      expect(afterResident.incompleteCount).toBe(0)
      expect(afterResident.maxGeneration).toBeGreaterThan(0)
      expect(Number.isFinite(afterResident.maxGeneration)).toBe(true)
      const entry = getEntries()[topic]
      expect(entry.residentTopic).toBe(true)
      expect(entry.chatData).toBe(true)
      expect(entry.segments).toBe(true)
      // read diagnostics coherent
      expect(afterRead.stagedCount - beforeRead.stagedCount).toBe(1)
      expect(afterRead.stagedSuccessCount - beforeRead.stagedSuccessCount).toBe(1)
      expect(afterRead.totalRequests - beforeRead.totalRequests).toBe(1)
      const snap = getPhase4Snapshot(null, getEntries())
      expect(snap.resident).toEqual(afterResident)
      expect(snap.residentRead).toEqual(afterRead)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(getPhase4BoundScalars(null, getEntries()))).not.toContain(SENTINEL_CONTENT)
      assertBoundScalarsInvariant(afterRead, afterResident)
    }

    // Step generation advance -> incomplete via production bumpGeneration action
    {
      const before = getResidentDiagnostics(getEntries())
      const beforeGen = getEntries()[topic].applicabilityGeneration
      store.dispatch(bumpGeneration(topic))
      const after = getResidentDiagnostics(getEntries())
      expect(after.maxGeneration).toBe(beforeGen + 1)
      expect(after.maxGeneration).toBeGreaterThan(before.maxGeneration)
      expect(after.residentCount).toBe(0)
      expect(after.incompleteCount).toBe(1)
      expect(after.chatDataCount).toBe(0)
      expect(after.segmentsCount).toBe(0)
      expect(after.entryCount).toBe(before.entryCount)
      const e = getEntries()[topic]
      expect(e.residentTopic).toBe(false)
      expect(e.chatData).toBe(false)
      // read diagnostics unchanged by pure generation bump (only thunk increments staged)
      const readAfter = getResidentReadDiagnostics()
      assertBoundScalarsInvariant(readAfter, after)
      const snap = getPhase4Snapshot(null, getEntries())
      expect(snap.resident).toEqual(after)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
    }

    // Step reset: clear resident via production resetAll and reset read diagnostics
    {
      const beforeRead = getResidentReadDiagnostics()
      expect(beforeRead.stagedCount).toBeGreaterThan(0)
      store.dispatch(resetAllResidentRegistry())
      resetResidentReadDiagnosticsForTests()
      const afterRead = getResidentReadDiagnostics()
      const afterResident = getResidentDiagnostics(getEntries())
      expect(afterResident).toEqual({
        entryCount: 0,
        residentCount: 0,
        chatDataCount: 0,
        segmentsCount: 0,
        incompleteCount: 0,
        maxGeneration: 0
      })
      expect(afterRead.hitCount).toBe(0)
      expect(afterRead.missCount).toBe(0)
      expect(afterRead.stagedCount).toBe(0)
      expect(afterRead.discardedCount).toBe(0)
      expect(afterRead.stagedLastMs).toBeNull()
      expect(afterRead.stagedAvgMs).toBeNull()
      const snap = getPhase4Snapshot(null, getEntries())
      expect(snap.resident.entryCount).toBe(0)
      expect(snap.residentRead.totalRequests).toBe(0)
      const scalars = getPhase4BoundScalars(null, getEntries())
      expect(scalars.residentEntryCount).toBe(0)
      expect(scalars.readStagedCount).toBe(0)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CONTENT)
      assertBoundScalarsInvariant(afterRead, afterResident)
    }

    // Step successful retry after reset recomputes both coherently — sentinel payload again exercised
    {
      mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
        return makeSentinelWindowResponse(req, req.topicId, SENTINEL_CONTENT)
      })
      mocks.listSegments.mockImplementation(
        async (topicId: string) => makeSentinelSegments(topicId, SENTINEL_CONTENT) as any
      )
      const beforeRead = getResidentReadDiagnostics()
      const beforeResident = getResidentDiagnostics(getEntries())
      expect(beforeResident.entryCount).toBe(0)
      await (store.dispatch as any)(loadTopicMessagesThunk(topic))
      const afterRead = getResidentReadDiagnostics()
      const afterResident = getResidentDiagnostics(getEntries())
      expect(afterResident.entryCount).toBe(1)
      expect(afterResident.residentCount).toBe(1)
      expect(afterResident.chatDataCount).toBe(1)
      expect(afterResident.segmentsCount).toBe(1)
      expect(afterResident.incompleteCount).toBe(0)
      expect(afterResident.maxGeneration).toBe(1)
      expect(afterRead.stagedCount - beforeRead.stagedCount).toBe(1)
      expect(afterRead.stagedSuccessCount - beforeRead.stagedSuccessCount).toBe(1)
      expect(afterRead.discardedCount).toBe(0)
      // publication occurred — resident entry true via real reducer
      expect(getEntries()[topic].residentTopic).toBe(true)
      const snap = getPhase4Snapshot(null, getEntries())
      expect(snap.resident).toEqual(afterResident)
      expect(snap.residentRead).toEqual(afterRead)
      const scalars = getPhase4BoundScalars(null, getEntries())
      expect(scalars.residentResidentCount).toBe(1)
      expect(scalars.readStagedSuccessCount).toBe(1)
      expect(scalars.readHitCount).toBe(afterRead.hitCount)
      // latency finite/non-negative
      expect(afterRead.stagedTotalMs).toBeGreaterThanOrEqual(0)
      expect(afterRead.stagedMaxMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(afterRead.stagedTotalMs)).toBe(true)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_TOPIC)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CONTENT)
      assertBoundScalarsInvariant(afterRead, afterResident)
    }
  })

  it('malformed versus generation-mismatch via thunk-driven paths have distinct discard counters and no publication', async () => {
    const { getResidentReadDiagnostics } = await import('@renderer/services/residentReadDiagnostics')
    const { getResidentDiagnostics } = await import('@renderer/services/residentDiagnostics')
    const { getPhase4Snapshot, getPhase4BoundScalars } = await import('@renderer/services/phase4Observability')
    const { loadTopicMessagesThunk } = await import('@renderer/store/thunk/messageThunk')

    const topicMalformed = 't-hardening-malformed'
    const topicGenMismatch = 't-hardening-gen-mismatch'
    const recordedActions: any[] = []
    const store = createIsolatedTestStore([topicMalformed, topicGenMismatch], recordedActions)
    const getEntries = () => store.getState().residentRegistry.entries as Record<string, any>

    // malformed path — sentinel segment payload still exercised but window is malformed
    {
      const before = getResidentReadDiagnostics()
      const beforeProjection = captureProjectionSlices(store)
      const beforeJointCount = recordedActions.filter((a) => a?.type === JOINT_PUBLISH_COMPLETE).length
      mocks.fetchMessagesWindow.mockImplementationOnce(async (req: FetchMessagesWindowRequest) => {
        const good = makeSentinelWindowResponse(req, req.topicId, SENTINEL_CONTENT)
        // malform: topicId mismatch
        ;(good as any).window.topicId = 'wrong-topic'
        return good
      })
      mocks.listSegments.mockResolvedValueOnce(makeSentinelSegments(topicMalformed, SENTINEL_CONTENT) as any)
      await (store.dispatch as any)(loadTopicMessagesThunk(topicMalformed))
      const after = getResidentReadDiagnostics()
      expect(after.stagedCount - before.stagedCount).toBe(1)
      expect(after.stagedSuccessCount - before.stagedSuccessCount).toBe(1)
      expect(after.stagedFailedCount - before.stagedFailedCount).toBe(0)
      expect(after.discardedCount - before.discardedCount).toBe(1)
      expect(after.discardedMalformed - before.discardedMalformed).toBe(1)
      expect(after.discardedGenerationMismatch - before.discardedGenerationMismatch).toBe(0)
      expect(after.discardedSuperseded - before.discardedSuperseded).toBe(0)
      // no publication via real reducer
      expect(!getEntries()[topicMalformed] || getEntries()[topicMalformed].residentTopic !== true).toBe(true)
      expect(Number.isFinite(after.stagedTotalMs)).toBe(true)
      expect(after.stagedTotalMs).toBeGreaterThanOrEqual(0)
      expect(after.stagedMaxMs).toBeGreaterThanOrEqual(0)
      expect(JSON.stringify(after)).not.toContain(topicMalformed)
      expect(JSON.stringify(after)).not.toContain('wrong-topic')
      expect(JSON.stringify(after)).not.toContain(SENTINEL_CONTENT)
      assertBoundScalarsInvariant(after, getResidentDiagnostics(getEntries()))
      const snap = getPhase4Snapshot(null, getEntries())
      expect(snap.residentRead.discardedMalformed).toBe(after.discardedMalformed)
      expect(JSON.stringify(snap.residentRead)).not.toContain(SENTINEL_TOPIC)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(getPhase4BoundScalars(null, getEntries()))).not.toContain(SENTINEL_CONTENT)
      // rejected payload non-publication: sentinel IDs absent and projection slices unchanged
      assertNoSentinelPublication(store, topicMalformed, SENTINEL_CONTENT, beforeProjection)
      expect(recordedActions.filter((a) => a?.type === JOINT_PUBLISH_COMPLETE).length).toBe(beforeJointCount)
    }

    // generation-mismatch path (distinct counter, no malformed) — via production bumpGeneration while pending
    {
      const before = getResidentReadDiagnostics()
      const beforeResident = getResidentDiagnostics(getEntries())
      const beforeProjection = captureProjectionSlices(store)
      const beforeJointCount = recordedActions.filter((a) => a?.type === JOINT_PUBLISH_COMPLETE).length
      let resolveW: (v: unknown) => void
      let resolveS: (v: unknown) => void
      mocks.fetchMessagesWindow.mockImplementationOnce(() => new Promise((resolve) => (resolveW = resolve as any)))
      mocks.listSegments.mockImplementationOnce(() => new Promise((resolve) => (resolveS = resolve as any)))

      const p = (store.dispatch as any)(loadTopicMessagesThunk(topicGenMismatch))
      await Promise.resolve()
      await Promise.resolve()
      store.dispatch(bumpGeneration(topicGenMismatch))
      const req: FetchMessagesWindowRequest = { kind: 'latest', topicId: topicGenMismatch, limit: 10 } as any
      resolveW!(makeSentinelWindowResponse(req, topicGenMismatch, SENTINEL_CONTENT))
      resolveS!(makeSentinelSegments(topicGenMismatch, SENTINEL_CONTENT))
      await p
      const after = getResidentReadDiagnostics()
      const afterResident = getResidentDiagnostics(getEntries())
      expect(after.stagedCount - before.stagedCount).toBe(1)
      expect(after.stagedSuccessCount - before.stagedSuccessCount).toBe(1)
      expect(after.discardedCount - before.discardedCount).toBe(1)
      expect(after.discardedGenerationMismatch - before.discardedGenerationMismatch).toBe(1)
      expect(after.discardedMalformed - before.discardedMalformed).toBe(0)
      expect(after.discardedSuperseded - before.discardedSuperseded).toBe(0)
      expect(after.discardedCurrentMoved - before.discardedCurrentMoved).toBe(0)
      expect(after.discardedDeletedDuringFetch - before.discardedDeletedDuringFetch).toBe(0)
      expect(!getEntries()[topicGenMismatch] || getEntries()[topicGenMismatch].residentTopic !== true).toBe(true)
      expect(afterResident.residentCount).toBe(beforeResident.residentCount) // not published
      expect(JSON.stringify(after)).not.toContain(topicGenMismatch)
      expect(JSON.stringify(after)).not.toContain(SENTINEL_CONTENT)
      // distinctness: malformed counter unchanged in this step, generationMismatch incremented
      // cumulative distinct counters both 1
      expect(after.discardedMalformed).toBe(1)
      expect(after.discardedGenerationMismatch).toBe(1)
      expect(after.discardedCount).toBe(2)
      const snap = getPhase4Snapshot(null, getEntries())
      const scalars = getPhase4BoundScalars(null, getEntries())
      expect(snap.residentRead.discardedMalformed).toBe(1)
      expect(snap.residentRead.discardedGenerationMismatch).toBe(1)
      expect(scalars.readDiscardedMalformed).toBe(1)
      expect(scalars.readDiscardedGenerationMismatch).toBe(1)
      expect(scalars.readDiscardedCount).toBe(2)
      // privacy — sentinel must be absent from both Phase4Snapshot and Phase4BoundScalars serialization
      expect(JSON.stringify(snap.residentRead)).not.toContain(topicGenMismatch)
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CONTENT)
      // rejected payload non-publication: sentinel IDs absent and projection slices unchanged
      assertNoSentinelPublication(store, topicGenMismatch, SENTINEL_CONTENT, beforeProjection)
      expect(recordedActions.filter((a) => a?.type === JOINT_PUBLISH_COMPLETE).length).toBe(beforeJointCount)
      assertBoundScalarsInvariant(after, afterResident)
    }

    // final cross-check: both discards never counted as staged failure
    {
      const diag = getResidentReadDiagnostics()
      expect(diag.stagedFailedCount).toBe(0) // malformed+genMismatch are staged success then discard
      expect(diag.stagedSuccessCount).toBe(2)
      expect(diag.stagedCount).toBe(2)
      expect(diag.discardedCount).toBe(2)
      expect((diag as unknown as Record<string, unknown>).discardedFetchFailed).toBeUndefined()
      const snap = getPhase4Snapshot(null, getEntries())
      const scalars = getPhase4BoundScalars(null, getEntries())
      expect(JSON.stringify(snap)).not.toContain(SENTINEL_CONTENT)
      expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CONTENT)
    }

    // restore
    mocks.fetchMessagesWindow.mockImplementation(async (req: FetchMessagesWindowRequest) => {
      const msgs = [{ id: `m-${req.topicId}`, topicId: req.topicId, blocks: [] }]
      return makeWindowResponse(req, msgs as any)
    })
    mocks.listSegments.mockResolvedValue([])
  })
})
