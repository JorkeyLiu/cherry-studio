/**
 * Cached-path compatibility repair via the authority resolver
 * (docs/adr/context-window.md §10).
 *
 * `loadTopicMessagesThunk` must schedule compatibility repair for a cache hit —
 * a COMPLETE resident entry (e.g. a fresh branch pre-populated by
 * `cloneMessagesToNewTopicThunk`, which publishes through the joint
 * publication) — without blocking the cached early return.
 * Repair is authority-resolved (`chatdb:resolve-context-closure`,
 * intent `establish`): no loaded-viewport authority decisions, only the
 * non-stale returned anchor is persisted (key removed on empty). Transport
 * failures preserve settings. Because repair is fire-and-forget background
 * work, these tests await eventual convergence via `vi.waitFor` (polling,
 * no wall-clock sleeps) rather than asserting synchronously after the thunk.
 *
 *   - complete resident topic, no anchor    → repair writes the resolver anchor
 *   - complete resident topic, valid anchor → no write (resolver echo)
 *   - complete resident topic, ghost anchor → repaired to the resolver anchor
 *   - index-only (cold) empty topic         → fetch path publishes; no write
 *   - deferred resolver                     → thunk settles while repair pending
 *
 * Call-sequence contract tests (hook mocked) live in
 * `messageThunk.anchorEstablishment.test.ts`.
 */
import { JOINT_PUBLISH_COMPLETE } from '@renderer/store/residentRegistry'
import type { Message } from '@renderer/types/newMessage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadTopicMessagesThunk } from '../messageThunk'
import { type ChatReadFixture, createChatReadFixture } from './helpers/chatReadStoreFixture'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchMessages: vi.fn(),
    fetchMessagesWindow: vi.fn(async (req: any) => {
      const limit = req.limit ?? 10
      return {
        messages: [],
        blocks: [],
        window: {
          kind: 'latest',
          completeness: 'window',
          topicId: req.topicId,
          anchorMessageId: null,
          requested: { limit },
          firstMessageId: null,
          lastMessageId: null,
          returnedCount: 0,
          hasMoreBefore: false,
          hasMoreAfter: false
        },
        // Bundled-structure mirror of Main: the fetch path always requests the
        // structure, and an empty catalog is a valid known-empty signal.
        ...(req.includeStructure === true
          ? {
              structure: {
                catalog: [],
                route: { topicId: req.topicId, branchId: req.branchId ?? null, qualifications: [] }
              }
            }
          : {})
      }
    }),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicFulfilled', payload: p })),
    setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p })),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p })),
    updateAssistantSettings: vi.fn((p: unknown) => ({ type: 'updateAssistantSettings', payload: p })),
    loadTopicSegmentsThunk: vi.fn(),
    resolveContextClosure: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

let fixture: ChatReadFixture

// NOTE: anchorService (and its decision pipeline) is intentionally NOT mocked —
// the real ensureTopicAnchorEstablished runs against the fixture's real slices.
vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => fixture.getState()
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt,
  updateAssistantSettings: mocks.updateAssistantSettings
}))

vi.mock('@renderer/store/newMessage', async () => {
  const actual = await vi.importActual<any>('@renderer/store/newMessage')
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      messagesReceived: mocks.messagesReceived,
      setTopicLoading: mocks.setTopicLoading,
      setTopicFulfilled: mocks.setTopicFulfilled,
      setCurrentTopicId: mocks.setCurrentTopicId
    },
    selectLoadedMessagesForTopic: (state: unknown, topicId: string) => {
      // Real projection shape: the fixture's messages slice.
      const slice = (
        state as {
          messages: {
            messageIdsByTopic: Record<string, string[]>
            entities: Record<string, Message>
          }
        }
      ).messages
      return (slice.messageIdsByTopic[topicId] ?? [])
        .map((id) => slice.entities[id])
        .filter((message): message is Message => !!message)
    }
  }
})

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: { settings?: Record<string, unknown> }) => ({
    contextCount: (assistant.settings?.contextCount as number | null | undefined) ?? 1,
    contextWindowAnchor: assistant.settings?.contextWindowAnchor as
      | Record<string, { kind: 'active'; groupKey: string } | undefined>
      | undefined
  })
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchMessages: mocks.fetchMessages,
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    resolveContextClosure: (...args: unknown[]) =>
      (mocks.resolveContextClosure as (...a: unknown[]) => unknown)(...args),
    appendMessage: vi.fn(),
    deleteMessagesWithSegments: vi.fn(),
    resetMessagesForResend: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    updateMessage: vi.fn(),
    listBlocksByFile: vi.fn(),
    deleteBlocks: vi.fn()
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: vi.fn(),
  restoreOrdinaryTopic: vi.fn(),
  softDeleteOrdinaryTopic: vi.fn()
}))

vi.mock('@renderer/store/messageBlock', async () => {
  const actual = await vi.importActual<any>('@renderer/store/messageBlock')
  return {
    // Real slice reducer: the read-path fixture publishes through it.
    default: actual.default,
    upsertManyBlocks: vi.fn(),
    removeManyBlocks: vi.fn(),
    updateOneBlock: vi.fn(),
    upsertOneBlock: vi.fn()
  }
})

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: mocks.loadTopicSegmentsThunk
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: vi.fn() }),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  addAbortController: vi.fn()
}))

vi.mock('swr', () => ({
  mutate: vi.fn()
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (k: string) => k
  },
  t: (k: string) => k
}))

// --- Helpers --------------------------------------------------------------

const userMsg = (id: string): Message => ({ id, role: 'user' }) as unknown as Message

const assistantMsg = (id: string, askId: string): Message => ({ id, role: 'assistant', askId }) as unknown as Message

const active = (groupKey: string) => ({ kind: 'active' as const, groupKey })

const messageById = (id: string): Message => (id.startsWith('a') ? assistantMsg(id, 'u1') : userMsg(id))

/**
 * Real-reducer fixture seeded with the cache-hit precondition the read path
 * actually checks: a COMPLETE resident entry (initial generation bump + guarded
 * joint publication), not a hand-rolled messageId index.
 */
const setupFixture = (settings: Record<string, unknown>, messageIds: string[]): ChatReadFixture => {
  const next = createChatReadFixture([{ id: 'asst-1', settings, topics: [{ id: 'topic-1' }] }])
  next.seedResidentComplete('topic-1', messageIds.map(messageById))
  return next
}

// --- Tests ----------------------------------------------------------------

describe('loadTopicMessagesThunk cached-path repair (authority resolver)', () => {
  beforeEach(() => {
    // clearAllMocks (not reset) preserves the hoisted fetchMessagesWindow
    // implementation while isolating call counts between its.
    vi.clearAllMocks()
    fixture = setupFixture({ contextCount: 1 }, ['u1', 'a1', 'u2'])
    const success = (resolvedAnchorGroupKey: string | null) =>
      ({
        messages: [],
        blocks: [],
        closure: {
          completeness: 'context-closure',
          topicId: 'topic-1',
          anchorGroupKey: resolvedAnchorGroupKey,
          firstMessageId: resolvedAnchorGroupKey ? 'm1' : null,
          lastMessageId: resolvedAnchorGroupKey ? 'm1' : null,
          returnedCount: resolvedAnchorGroupKey ? 1 : 0,
          totalTurnCount: resolvedAnchorGroupKey ? 1 : 0,
          selectedTurnCount: resolvedAnchorGroupKey ? 1 : 0,
          foldedMessageIds: [],
          boundaryMessageId: null
        },
        resolvedAnchorGroupKey,
        changed: true
      }) as unknown
    mocks.resolveContextClosure.mockResolvedValue(success('u2'))
  })

  afterEach(() => {
    // Each test awaits background repair convergence, so no in-flight repair
    // leaks into the next test. Clear call history for isolation (mock
    // implementations set in beforeEach are preserved).
    vi.clearAllMocks()
  })

  it('writes the default anchor for a cached NON-EMPTY topic with no anchor (no refetch)', async () => {
    // Turns [u1, u2]; contextCount=1 → default window position is the LAST
    // turn (u2).
    const dispatch = vi.fn()
    const getState = () => fixture.getState() as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    // Cached path: no refetch, no messagesReceived.
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(mocks.messagesReceived).not.toHaveBeenCalled()

    // Repair is scheduled fire-and-forget: the thunk settles first, then the
    // background repair eventually writes the anchor through the ordinary
    // settings dispatch. Await convergence by polling (no wall-clock sleep).
    await vi.waitFor(() => expect(mocks.resolveContextClosure).toHaveBeenCalled())
    await vi.waitFor(() => expect(mocks.updateAssistantSettings).toHaveBeenCalledTimes(1))
    expect(mocks.updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: { 'topic-1': active('u2') } }
    })
  })

  it('thunk settles without awaiting background repair (deferred resolver)', async () => {
    // Hold the authority resolver open: the cached early return must still
    // settle while repair is pending, and the repair must converge once the
    // resolver releases.
    let releaseResolver!: (value: unknown) => void
    mocks.resolveContextClosure.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseResolver = resolve as (value: unknown) => void
        })
    )
    const dispatch = vi.fn()
    const getState = () => fixture.getState() as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    // Thunk resolved while the resolver is still pending — anchor never
    // blocked topic activation.
    expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(1)
    expect(mocks.updateAssistantSettings).not.toHaveBeenCalled()
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()

    releaseResolver({
      messages: [],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: 'topic-1',
        anchorGroupKey: 'u2',
        firstMessageId: 'm1',
        lastMessageId: 'm1',
        returnedCount: 1,
        totalTurnCount: 1,
        selectedTurnCount: 1,
        foldedMessageIds: [],
        boundaryMessageId: null
      },
      resolvedAnchorGroupKey: 'u2',
      changed: true
    } as unknown)
    await vi.waitFor(() => expect(mocks.updateAssistantSettings).toHaveBeenCalledTimes(1))
    expect(mocks.updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: { 'topic-1': active('u2') } }
    })
  })

  it('never recalculates a VALID cached anchor (no write)', async () => {
    fixture = setupFixture({ contextCount: 1, contextWindowAnchor: { 'topic-1': active('u1') } }, ['u1', 'a1', 'u2'])
    // Authority echo: the persisted anchor is valid, so the resolver returns it.
    const echo = {
      messages: [],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: 'topic-1',
        anchorGroupKey: 'u1',
        firstMessageId: 'm1',
        lastMessageId: 'm1',
        returnedCount: 1,
        totalTurnCount: 1,
        selectedTurnCount: 1,
        foldedMessageIds: [],
        boundaryMessageId: null
      },
      resolvedAnchorGroupKey: 'u1',
      changed: false
    } as unknown
    mocks.resolveContextClosure.mockResolvedValueOnce(echo)

    const dispatch = vi.fn()
    const getState = () => fixture.getState() as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    // Background repair must have run to completion before asserting no
    // write — otherwise the assertion would pass vacuously. The resolver was
    // invoked; drain the repair continuation, then confirm the valid
    // persisted anchor (resolver echo) is left untouched with no late write.
    await vi.waitFor(() => expect(mocks.resolveContextClosure).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.updateAssistantSettings).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('repairs an unresolvable (ghost) cached anchor to the default position', async () => {
    fixture = setupFixture({ contextCount: 1, contextWindowAnchor: { 'topic-1': active('ghost') } }, ['u1', 'a1', 'u2'])

    const dispatch = vi.fn()
    const getState = () => fixture.getState() as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    // Background repair converges after the non-blocking return.
    await vi.waitFor(() => expect(mocks.resolveContextClosure).toHaveBeenCalled())
    await vi.waitFor(() => expect(mocks.updateAssistantSettings).toHaveBeenCalledTimes(1))
    expect(mocks.updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: { 'topic-1': active('u2') } }
    })
  })

  it('an index-only (cold) EMPTY topic falls through to the fetch path and never receives an anchor', async () => {
    // Present-empty index with nothing resident: a cold projection, not a cache
    // hit (the deleted registry-less branch used to treat it as one).
    fixture = createChatReadFixture([{ id: 'asst-1', settings: { contextCount: 1 }, topics: [{ id: 'topic-1' }] }])
    fixture.seedCachedIndexOnly('topic-1', [])
    expect(fixture.getState().residentRegistry.entries['topic-1']).toBeUndefined()
    // Authority reports an existing empty target (null anchor).
    const empty = {
      messages: [],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: 'topic-1',
        anchorGroupKey: null,
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        totalTurnCount: 0,
        selectedTurnCount: 0,
        foldedMessageIds: [],
        boundaryMessageId: null
      },
      resolvedAnchorGroupKey: null,
      changed: false
    } as unknown
    mocks.resolveContextClosure.mockResolvedValueOnce(empty)

    const dispatch = vi.fn((action: unknown) => fixture.dispatch(action as never))
    const getState = () => fixture.getState() as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    // Not "cached": the fetch path runs and its joint publication lands as a
    // real complete resident entry (empty window included).
    expect(mocks.fetchMessagesWindow).toHaveBeenCalled()
    expect(
      dispatch.mock.calls.some(([action]) => (action as { type?: string } | undefined)?.type === JOINT_PUBLISH_COMPLETE)
    ).toBe(true)
    const entry = fixture.getState().residentRegistry.entries['topic-1']
    expect(entry?.residentTopic).toBe(true)
    expect(entry?.chatData).toBe(true)
    expect(entry?.segments).toBe(true)
    // The empty topic stays anchorless (I-1). The fetch path also schedules
    // background anchor work, so wait for the resolver before asserting no write.
    await vi.waitFor(() => expect(mocks.resolveContextClosure).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.updateAssistantSettings).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.updateAssistantSettings).not.toHaveBeenCalled()
  })
})
