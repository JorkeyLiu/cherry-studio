/**
 * Ordinary-send append acknowledgment publication.
 *
 * Verifies the send pipeline captures its operation route once and publishes
 * each Main-issued creation acknowledgment as one atomic row + capability
 * commit (immediate mutability, no reload):
 * - user + assistant stubs publish with the captured route;
 * - every append carries the captured route explicitly (no re-resolve);
 * - append failure / missing ack publishes nothing (fail-closed);
 * - a route switch mid-send (including away-and-back) injects no rows or
 *   capability into the unrelated route, while owned persistence and queueing
 *   continue and queued executions keep the pinned route for request context.
 */
import type { Message } from '@renderer/types/newMessage'
import { UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    appendMessage: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    addMessage: vi.fn((p: unknown) => ({ type: 'newMessages/addMessage', payload: p })),
    applyAppendAck: vi.fn((p: unknown) => ({ type: 'newMessages/applyAppendAcknowledgment', payload: p })),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'upsertManyBlocks', payload: p })),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicFulfilled', payload: p })),
    queueAdd: vi.fn(),
    transformMessagesAndFetch: vi.fn(),
    asstCounter: 0
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/anchorService', () => ({
  ensureTopicAnchorEstablished: mocks.ensureTopicAnchorEstablished,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    appendMessage: mocks.appendMessage,
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    updateMessage: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    bulkAddBlocks: vi.fn(),
    updateMessageAndBlocks: vi.fn()
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: vi.fn(),
  restoreOrdinaryTopic: vi.fn(),
  softDeleteOrdinaryTopic: vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/create', () => ({
  createAssistantMessage: vi.fn((_assistantId: string, topicId: string) => {
    mocks.asstCounter += 1
    return {
      id: `asst-${topicId}-${mocks.asstCounter}`,
      assistantId: _assistantId,
      topicId,
      role: 'assistant',
      askId: 'user-1',
      status: 'pending',
      blocks: []
    }
  }),
  createTranslationBlock: vi.fn(),
  resetAssistantMessage: vi.fn()
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: mocks.upsertManyBlocks,
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: mocks.queueAdd }),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  addAbortController: vi.fn()
}))

vi.mock('@renderer/services/ApiService', () => ({
  transformMessagesAndFetch: mocks.transformMessagesAndFetch
}))

vi.mock('@renderer/services/messageStreaming/callbacks', () => ({
  createCallbacks: vi.fn(() => ({}))
}))

vi.mock('@renderer/services/StreamProcessingService', () => ({
  createStreamProcessor: vi.fn(() => vi.fn())
}))

vi.mock('@renderer/services/SpanManagerService', () => ({
  endSpan: vi.fn()
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

interface StoreState {
  assistants: {
    assistants: Array<{
      id: string
      prompt?: string
      settings?: Record<string, unknown>
      topics?: Array<{ id: string }>
    }>
  }
  messages: {
    entities: Record<string, Message>
    messageIdsByTopic: Record<string, string[]>
    mutableMessageIdsByTopic?: Record<string, string[]>
    mutableRouteByTopic?: Record<string, string | null>
    loadingByTopic: Record<string, boolean>
    fulfilledByTopic: Record<string, boolean>
    currentTopicId: string | null
  }
  topicBranch?: {
    branchesByTopic: Record<string, unknown[]>
    activeBranchIdByTopic: Record<string, string | null>
    routeGenerationByTopic: Record<string, number>
  }
}

let storeState: StoreState

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    addMessage: mocks.addMessage,
    applyAppendAcknowledgment: mocks.applyAppendAck,
    messagesReceived: mocks.messagesReceived,
    setTopicLoading: mocks.setTopicLoading,
    setTopicFulfilled: mocks.setTopicFulfilled
  },
  selectLoadedMessagesForTopic: () => []
}))

// --- Helpers --------------------------------------------------------------

const createUserMessage = (): Message =>
  ({
    id: 'user-1',
    role: 'user',
    assistantId: 'asst-1',
    topicId: 't-1',
    status: UserMessageStatus.SUCCESS,
    blocks: ['block-1'],
    mentions: undefined
  }) as unknown as Message

const makeAssistant = () => ({ id: 'asst-1', settings: { contextCount: 5 } })

function freshState(): StoreState {
  return {
    assistants: { assistants: [{ id: 'asst-1', settings: { contextCount: 5 }, topics: [{ id: 't-1' }] }] },
    messages: {
      entities: {},
      messageIdsByTopic: { 't-1': [] },
      loadingByTopic: {},
      fulfilledByTopic: {},
      currentTopicId: null
    },
    topicBranch: {
      branchesByTopic: {},
      activeBranchIdByTopic: {},
      routeGenerationByTopic: {}
    }
  }
}

/** Echo a Main-issued creation acknowledgment for the appended message. */
function echoAck(
  topicId: string,
  message: { id: string },
  _blocks: unknown,
  _index: unknown,
  _sendContext: unknown,
  _attempt: unknown,
  branchId: unknown
) {
  return {
    topicId,
    branchId: (branchId as string | null | undefined) ?? null,
    messageId: message.id,
    createdMessageIds: [message.id],
    mutableMessageIds: [message.id]
  }
}

/** The 7th positional arg of dbService.appendMessage is the addressed route. */
function appendRoutes() {
  return mocks.appendMessage.mock.calls.map((c) => c[6] ?? null)
}

// --- Tests ----------------------------------------------------------------

describe('sendMessage append acknowledgment publication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.asstCounter = 0
    mocks.appendMessage.mockImplementation(echoAck as never)
    mocks.queueAdd.mockImplementation(async () => {})
    mocks.transformMessagesAndFetch.mockResolvedValue(undefined)
    storeState = freshState()
  })

  it('publishes user + assistant rows with capability immediately (no reload)', { timeout: 60_000 }, async () => {
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1')(dispatch, getState)

    // Both appends address the captured main route explicitly.
    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(appendRoutes()).toEqual([null, null])

    // One atomic row + capability commit per acknowledgment.
    expect(mocks.applyAppendAck).toHaveBeenCalledTimes(2)
    expect(mocks.applyAppendAck.mock.calls[0][0]).toEqual({
      topicId: 't-1',
      route: null,
      message: expect.objectContaining({ id: 'user-1' }),
      createdMessageIds: ['user-1'],
      mutableMessageIds: ['user-1']
    })
    expect(mocks.applyAppendAck.mock.calls[1][0]).toEqual({
      topicId: 't-1',
      route: null,
      message: expect.objectContaining({ id: 'asst-t-1-1' }),
      createdMessageIds: ['asst-t-1-1'],
      mutableMessageIds: ['asst-t-1-1']
    })

    // No reload or unguarded add heals this path.
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(mocks.messagesReceived).not.toHaveBeenCalled()
    expect(mocks.addMessage).not.toHaveBeenCalled()

    // The assistant response is queued (not started) after establishment.
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
  })

  it('append failure publishes nothing and queues nothing', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockRejectedValue(new Error('db down'))
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    expect(mocks.applyAppendAck).not.toHaveBeenCalled()
    expect(mocks.addMessage).not.toHaveBeenCalled()
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it('missing acknowledgment publishes nothing (fail-closed)', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockResolvedValue(undefined)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    expect(mocks.applyAppendAck).not.toHaveBeenCalled()
    expect(mocks.addMessage).not.toHaveBeenCalled()
  })

  it('rejected/stale ack emits no orphan blocks (send user blocks gated)', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      const tb = storeState.topicBranch!
      tb.activeBranchIdByTopic['t-1'] = 'b1'
      tb.routeGenerationByTopic['t-1'] = 1
      return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const userBlocks = [{ id: 'block-1', messageId: 'user-1', type: 'main_text', content: 'hi' }]

    await sendMessage(
      createUserMessage(),
      userBlocks as never,
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)

    expect(mocks.applyAppendAck).not.toHaveBeenCalled()
    expect(mocks.upsertManyBlocks).not.toHaveBeenCalled()
  })

  it(
    'route switch mid-send keeps the captured route on every append but injects nothing',
    { timeout: 60_000 },
    async () => {
      const mentionA = { id: 'mention-a', provider: 'p', name: 'A', group: 'g' }
      const mentionB = { id: 'mention-b', provider: 'p', name: 'B', group: 'g' }
      mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
        // The user switch lands while the first append is in flight.
        const tb = storeState.topicBranch!
        tb.activeBranchIdByTopic['t-1'] = 'b1'
        tb.routeGenerationByTopic['t-1'] = 1
        return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
      }) as never)
      const { sendMessage } = await import('../messageThunk')
      const dispatch = vi.fn()

      const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
      await sendMessage(userMessage, [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

      // All three appends (user + 2 stubs) still address the captured route.
      expect(mocks.appendMessage).toHaveBeenCalledTimes(3)
      expect(appendRoutes()).toEqual([null, null, null])

      // Late publication into the unrelated route is rejected.
      expect(mocks.applyAppendAck).not.toHaveBeenCalled()
      expect(mocks.addMessage).not.toHaveBeenCalled()

      // Owned execution is not cancelled: both model tasks are still queued.
      expect(mocks.queueAdd).toHaveBeenCalledTimes(2)
    }
  )

  it('away-and-back switch injects nothing (generation guard)', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      // Away and back: the route matches again but the generation advanced.
      const tb = storeState.topicBranch!
      tb.activeBranchIdByTopic['t-1'] = 'b1'
      tb.routeGenerationByTopic['t-1'] = 1
      tb.activeBranchIdByTopic['t-1'] = null
      tb.routeGenerationByTopic['t-1'] = 2
      return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(mocks.applyAppendAck).not.toHaveBeenCalled()
    expect(mocks.addMessage).not.toHaveBeenCalled()
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
  })

  it('multi-model stubs publish one atomic commit each under the captured route', { timeout: 60_000 }, async () => {
    const mentionA = { id: 'mention-a', provider: 'p', name: 'A', group: 'g' }
    const mentionB = { id: 'mention-b', provider: 'p', name: 'B', group: 'g' }
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
    await sendMessage(userMessage, [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    expect(mocks.appendMessage).toHaveBeenCalledTimes(3)
    expect(appendRoutes()).toEqual([null, null, null])
    expect(mocks.applyAppendAck).toHaveBeenCalledTimes(3)
    const publishedIds = mocks.applyAppendAck.mock.calls.map((c) => (c[0] as { message: { id: string } }).message.id)
    expect(publishedIds).toEqual(['user-1', 'asst-t-1-1', 'asst-t-1-2'])
    for (const call of mocks.applyAppendAck.mock.calls) {
      expect((call[0] as { route: unknown }).route).toBeNull()
    }
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2)
  })

  it('queued executions keep the pinned route for request context after a switch', { timeout: 60_000 }, async () => {
    const queuedTasks: Array<() => Promise<void>> = []
    mocks.queueAdd.mockImplementation(async (task: () => Promise<void>) => {
      queuedTasks.push(task)
    })
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      const tb = storeState.topicBranch!
      tb.activeBranchIdByTopic['t-1'] = 'b1'
      tb.routeGenerationByTopic['t-1'] = 1
      return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)
    expect(queuedTasks).toHaveLength(1)
    await queuedTasks[0]()

    // Request context selection uses the pinned send route, never the
    // queue-time active route.
    expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(1)
    expect(mocks.transformMessagesAndFetch.mock.calls[0][0].branchId).toBeNull()
    // The stale send still published nothing into the unrelated route.
    expect(mocks.applyAppendAck).not.toHaveBeenCalled()
  })
})
