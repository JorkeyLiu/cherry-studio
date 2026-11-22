/**
 * sendMessage handover result (`accepted`) boundary tests.
 *
 * The thunk returns a minimal handover result reporting ONLY whether the user
 * row was authoritatively received by Main (valid `toValidAppendEntry` of the
 * USER append against the pinned route) — independent of projection currency
 * and never waiting for queue idle or streaming:
 * - legacy 4-arg success: accepted, every append on the entry route;
 * - explicit root/branch pins survive an active switch (appends stay pinned,
 *   stale publication still accepted);
 * - pre-user-ack failures (throw / empty blocks / invalid ack) are unreceived
 *   and fail closed with no assistant stub or provider queue;
 * - post-user-ack failures (stub unacknowledged / anchor throw) stay accepted
 *   with no queue against a phantom row.
 */
import type { Message } from '@renderer/types/newMessage'
import { UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks (same Main boundary as messageThunk.appendAck.test.ts) --------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    appendMessage: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    addMessage: vi.fn((p: unknown) => ({ type: 'newMessages/addMessage', payload: p })),
    applyAppendAck: vi.fn((p: unknown) => ({ type: 'newMessages/applyAppendAcknowledgment', payload: p })),
    applyAppendAcks: vi.fn((p: unknown) => ({ type: 'newMessages/applyAppendAcknowledgments', payload: p })),
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
    applyAppendAcknowledgments: mocks.applyAppendAcks,
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

describe('sendMessage handover result (accepted)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.asstCounter = 0
    mocks.appendMessage.mockImplementation(echoAck as never)
    mocks.queueAdd.mockImplementation(async () => {})
    mocks.transformMessagesAndFetch.mockResolvedValue(undefined)
    storeState = freshState()
  })

  it('legacy 4-arg success reports accepted with every append on the entry route', { timeout: 60_000 }, async () => {
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const result = await sendMessage(
      createUserMessage(),
      [],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)
    expect(result).toEqual({ accepted: true })
    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(appendRoutes()).toEqual([null, null])
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
  })

  it(
    'explicit root pin survives an active switch: appends stay pinned, still accepted',
    { timeout: 60_000 },
    async () => {
      mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
        const tb = storeState.topicBranch!
        tb.activeBranchIdByTopic['t-1'] = 'b1'
        tb.routeGenerationByTopic['t-1'] = 1
        return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
      }) as never)
      const { sendMessage } = await import('../messageThunk')
      const dispatch = vi.fn()
      const result = await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1', {
        route: null,
        generation: 0
      })(dispatch, () => storeState as never)
      expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
      expect(appendRoutes()).toEqual([null, null])
      // Late publication into the unrelated route is rejected, but the owned
      // write was received: the handover stays accepted.
      expect(mocks.applyAppendAck).not.toHaveBeenCalled()
      expect(result).toEqual({ accepted: true })
      expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
    }
  )

  it('explicit branch pin addresses the branch on every append after a switch away', { timeout: 60_000 }, async () => {
    storeState.topicBranch!.activeBranchIdByTopic['t-1'] = 'b1'
    storeState.topicBranch!.routeGenerationByTopic['t-1'] = 3
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      const tb = storeState.topicBranch!
      tb.activeBranchIdByTopic['t-1'] = null
      tb.routeGenerationByTopic['t-1'] = 4
      return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const result = await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1', {
      route: 'b1',
      generation: 3
    })(dispatch, () => storeState as never)
    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(appendRoutes()).toEqual(['b1', 'b1'])
    expect(result).toEqual({ accepted: true })
  })

  it(
    'away-and-back switch (stale publication) still reports accepted for the owned write',
    { timeout: 60_000 },
    async () => {
      mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
        const tb = storeState.topicBranch!
        tb.activeBranchIdByTopic['t-1'] = 'b1'
        tb.routeGenerationByTopic['t-1'] = 1
        tb.activeBranchIdByTopic['t-1'] = null
        tb.routeGenerationByTopic['t-1'] = 2
        return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
      }) as never)
      const { sendMessage } = await import('../messageThunk')
      const dispatch = vi.fn()
      const result = await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1', {
        route: null,
        generation: 0
      })(dispatch, () => storeState as never)
      expect(mocks.applyAppendAck).not.toHaveBeenCalled()
      expect(result).toEqual({ accepted: true })
    }
  )

  it('pre-user-ack failure reports unreceived and creates no stub or queue', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockRejectedValueOnce(new Error('db down'))
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const result = await sendMessage(
      createUserMessage(),
      [],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)
    expect(result).toEqual({ accepted: false })
    expect(mocks.appendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.applyAppendAck).not.toHaveBeenCalled()
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it('empty blocks report unreceived with zero writes', { timeout: 60_000 }, async () => {
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const emptyUser = { ...createUserMessage(), blocks: [] as string[] }
    const result = await sendMessage(
      emptyUser,
      [],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)
    expect(result).toEqual({ accepted: false })
    expect(mocks.appendMessage).not.toHaveBeenCalled()
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it('invalid user ack fails closed with no generation', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockResolvedValueOnce(undefined)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const result = await sendMessage(
      createUserMessage(),
      [],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)
    expect(result).toEqual({ accepted: false })
    expect(mocks.appendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.applyAppendAck).not.toHaveBeenCalled()
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it('post-user-ack stub failure still reports accepted with no queue', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { id: string }
      if (message.id.startsWith('asst-')) return undefined
      return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const result = await sendMessage(
      createUserMessage(),
      [],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)
    expect(result).toEqual({ accepted: true })
    expect(mocks.applyAppendAck).toHaveBeenCalledTimes(1)
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it('post-user-ack anchor failure still reports accepted', { timeout: 60_000 }, async () => {
    mocks.ensureTopicAnchorEstablished.mockRejectedValueOnce(new Error('anchor down'))
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const result = await sendMessage(
      createUserMessage(),
      [],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)
    expect(result).toEqual({ accepted: true })
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it('multi-model success reports accepted and queues every acknowledged stub', { timeout: 60_000 }, async () => {
    const mentionA = { id: 'mention-a', provider: 'p', name: 'A', group: 'g' }
    const mentionB = { id: 'mention-b', provider: 'p', name: 'B', group: 'g' }
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
    const result = await sendMessage(
      userMessage,
      [],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)
    expect(result).toEqual({ accepted: true })
    expect(mocks.appendMessage).toHaveBeenCalledTimes(3)
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2)
  })
})
