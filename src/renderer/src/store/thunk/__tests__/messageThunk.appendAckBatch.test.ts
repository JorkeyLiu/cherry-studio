/**
 * Multi-model stub batch publication (plural append-acknowledgment commit).
 *
 * Verifies the optimized multi-model path keeps strictly serial Main writes
 * in stub order with nothing visible before all confirmations, then publishes
 * exactly ONE plural row + capability commit:
 * - N-model saves run serially in stub order; no stub row publishes before
 *   the batch (single-model/user singular path unchanged);
 * - N successes yield exactly 1 plural commit (not N singular commits);
 * - a mid-loop save throw publishes the already-confirmed successes once,
 *   never the failed/unwritten stubs, queues no fetch, and propagates on the
 *   original send failure path;
 * - a mid-flight generation/route switch filters the whole batch
 *   (fail-closed) while owned writes and queued fetches keep the pinned route;
 * - one malformed or mixed-topic ack never discards valid siblings.
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

const mentionA = { id: 'mention-a', provider: 'p', name: 'A', group: 'g' }
const mentionB = { id: 'mention-b', provider: 'p', name: 'B', group: 'g' }

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

function appendMessageIds() {
  return mocks.appendMessage.mock.calls.map((c) => (c[1] as { id: string }).id)
}

// --- Tests ----------------------------------------------------------------

describe('multi-model stub batch publication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.asstCounter = 0
    mocks.appendMessage.mockImplementation(echoAck as never)
    mocks.queueAdd.mockImplementation(async () => {})
    mocks.transformMessagesAndFetch.mockResolvedValue(undefined)
    storeState = freshState()
  })

  it('writes stubs serially in order with nothing visible before one plural commit', { timeout: 60_000 }, async () => {
    const saveOrder: string[] = []
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { id: string }
      saveOrder.push(message.id)
      // No stub row may publish before its own save, let alone the batch:
      // the plural commit fires only after every confirmation.
      if (message.id.startsWith('asst-')) {
        expect(mocks.applyAppendAcks).not.toHaveBeenCalled()
      }
      return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
    await sendMessage(userMessage, [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    // Strictly serial writes in stub order (Main write/route order unchanged).
    expect(appendMessageIds()).toEqual(['user-1', 'asst-t-1-1', 'asst-t-1-2'])
    expect(saveOrder).toEqual(['user-1', 'asst-t-1-1', 'asst-t-1-2'])
    // User row keeps the singular path; stubs share exactly ONE plural commit.
    expect(mocks.applyAppendAck).toHaveBeenCalledTimes(1)
    expect(mocks.applyAppendAcks).toHaveBeenCalledTimes(1)
    const batch = mocks.applyAppendAcks.mock.calls[0][0] as {
      topicId: string
      route: null
      entries: Array<{ message: { id: string }; createdMessageIds: string[]; mutableMessageIds: string[] }>
    }
    expect(batch.topicId).toBe('t-1')
    expect(batch.route).toBeNull()
    expect(batch.entries.map((e) => e.message.id)).toEqual(['asst-t-1-1', 'asst-t-1-2'])
    for (const entry of batch.entries) {
      expect(entry.createdMessageIds).toEqual([entry.message.id])
      expect(entry.mutableMessageIds).toEqual([entry.message.id])
    }
    // Both model fetches queue with the pinned route.
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2)
  })

  it(
    'partial second-write failure publishes the first confirmed stub only and queues no fetch',
    { timeout: 60_000 },
    async () => {
      let stubSaves = 0
      mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
        const message = args[1] as { id: string }
        if (message.id.startsWith('asst-')) {
          stubSaves += 1
          if (stubSaves === 2) throw new Error('second stub write failed')
        }
        return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
      }) as never)
      const { sendMessage } = await import('../messageThunk')
      const dispatch = vi.fn()

      const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
      // sendMessage follows the original failure path (logs, no rethrow).
      await sendMessage(userMessage, [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

      // User singular still published; the confirmed first stub publishes once
      // via the plural batch; the failed/unwritten second stub never publishes.
      expect(mocks.applyAppendAck).toHaveBeenCalledTimes(1)
      expect(mocks.applyAppendAcks).toHaveBeenCalledTimes(1)
      const batch = mocks.applyAppendAcks.mock.calls[0][0] as {
        entries: Array<{ message: { id: string } }>
      }
      expect(batch.entries.map((e) => e.message.id)).toEqual(['asst-t-1-1'])
      // No fetch is queued after a mid-loop write failure (unchanged semantics).
      expect(mocks.queueAdd).not.toHaveBeenCalled()
    }
  )

  it('stale route + second-write failure publishes nothing and queues no fetch', { timeout: 60_000 }, async () => {
    // Combo: first stub confirms, then during the second stub's pending save
    // the route/generation switches and the save rejects. The confirmed first
    // row stays owned-persisted in Main (reload-recoverable authority) but
    // nothing publishes to the now-unrelated projection (whole batch
    // fail-closed: no wrong-projection rows, no failed stub), no fetch
    // queues, and sendMessage keeps its original failure path (logs, no
    // rethrow — the await below resolving proves it).
    let stubSaves = 0
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { id: string }
      if (message.id.startsWith('asst-')) {
        stubSaves += 1
        if (stubSaves === 2) {
          const tb = storeState.topicBranch!
          tb.activeBranchIdByTopic['t-1'] = 'b1'
          tb.routeGenerationByTopic['t-1'] = 1
          throw new Error('second stub write failed under stale route')
        }
      }
      return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
    await sendMessage(userMessage, [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    // Both stub writes were attempted (first row owned-persisted, second
    // never wrote) — yet no renderer optimism: the stale batch publishes
    // nothing into the unrelated route.
    expect(mocks.appendMessage).toHaveBeenCalledTimes(3)
    expect(appendMessageIds()).toEqual(['user-1', 'asst-t-1-1', 'asst-t-1-2'])
    // User singular still published; the stale plural batch fails closed as
    // a whole (neither the confirmed first stub nor the failed second stub
    // publishes).
    expect(mocks.applyAppendAck).toHaveBeenCalledTimes(1)
    expect(mocks.applyAppendAcks).not.toHaveBeenCalled()
    // No fetch is queued after a mid-loop write failure (unchanged semantics).
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it(
    'mid-flight generation/route switch filters the whole batch but keeps pinned writes and fetches',
    { timeout: 60_000 },
    async () => {
      mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
        const tb = storeState.topicBranch!
        tb.activeBranchIdByTopic['t-1'] = 'b1'
        tb.routeGenerationByTopic['t-1'] = 1
        return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
      }) as never)
      const queuedTasks: Array<() => Promise<void>> = []
      mocks.queueAdd.mockImplementation(async (task: () => Promise<void>) => {
        queuedTasks.push(task)
      })
      const { sendMessage } = await import('../messageThunk')
      const dispatch = vi.fn()

      const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
      await sendMessage(userMessage, [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

      // Every append still addressed the captured route; nothing injects into
      // the unrelated route (singular + plural both fail closed).
      expect(mocks.appendMessage).toHaveBeenCalledTimes(3)
      for (const call of mocks.appendMessage.mock.calls) {
        expect(call[6] ?? null).toBeNull()
      }
      expect(mocks.applyAppendAck).not.toHaveBeenCalled()
      expect(mocks.applyAppendAcks).not.toHaveBeenCalled()
      // Owned execution is not cancelled: both fetches queue pinned to the
      // captured route for request context.
      expect(queuedTasks).toHaveLength(2)
      for (const task of queuedTasks) await task()
      expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(2)
      for (const call of mocks.transformMessagesAndFetch.mock.calls) {
        expect(call[0].branchId).toBeNull()
      }
    }
  )

  it('a malformed ack never discards valid siblings', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      const message = args[1] as { id: string }
      if (message.id === 'asst-t-1-1') return undefined
      return (echoAck as (...a: never[]) => unknown)(...(args as never[]))
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
    await sendMessage(userMessage, [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    expect(mocks.applyAppendAcks).toHaveBeenCalledTimes(1)
    const batch = mocks.applyAppendAcks.mock.calls[0][0] as {
      entries: Array<{ message: { id: string } }>
    }
    expect(batch.entries.map((e) => e.message.id)).toEqual(['asst-t-1-2'])
    // All successful writes still queue their fetches.
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2)
  })

  it('a mixed-topic ack is rejected while valid siblings publish', { timeout: 60_000 }, async () => {
    mocks.appendMessage.mockImplementation((async (...args: unknown[]) => {
      const ack = (echoAck as (...a: never[]) => unknown)(...(args as never[])) as Record<string, unknown>
      const message = args[1] as { id: string }
      if (message.id === 'asst-t-1-2') return { ...ack, topicId: 'other-topic' }
      return ack
    }) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    const userMessage = { ...createUserMessage(), mentions: [mentionA, mentionB] }
    await sendMessage(userMessage, [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    expect(mocks.applyAppendAcks).toHaveBeenCalledTimes(1)
    const batch = mocks.applyAppendAcks.mock.calls[0][0] as {
      topicId: string
      entries: Array<{ message: { id: string } }>
    }
    expect(batch.topicId).toBe('t-1')
    expect(batch.entries.map((e) => e.message.id)).toEqual(['asst-t-1-1'])
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2)
  })

  it('single-model send keeps the singular path (no plural commit)', { timeout: 60_000 }, async () => {
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()

    await sendMessage(createUserMessage(), [], makeAssistant() as never, 't-1')(dispatch, () => storeState as never)

    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(mocks.applyAppendAck).toHaveBeenCalledTimes(2)
    expect(mocks.applyAppendAcks).not.toHaveBeenCalled()
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
  })
})
