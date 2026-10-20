/**
 * Deferred (optional) user-prompt token estimate on the send path.
 *
 * The estimate is display metadata, never a request input, so:
 * - it is scheduled on its OWN TASK (macrotask) after the user echo, the anchor
 *   step, the assistant stub and the provider queue — its synchronous tokenization
 *   never runs inside the send/echo task (asserted: not called when the thunk
 *   resolves, called after the task flush);
 * - it is written through the conditional usage mode (Main decides in one
 *   transaction whether the estimate still describes the prompt);
 * - the projection is enriched ONLY for an `applied` outcome, and only when the
 *   message is still loaded — a rejection, a deleted row, or an unloaded
 *   (windowed-out) message never produces a Redux write and never resurrects an
 *   entity.
 */
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    estimateUserPromptUsage: vi.fn(),
    updateMessageUsageIfUnchanged: vi.fn(),
    appendMessage: vi.fn(),
    applyAppendAck: vi.fn((p: unknown) => ({ type: 'newMessages/applyAppendAcknowledgment', payload: p })),
    applyAppendAcks: vi.fn((p: unknown) => ({ type: 'newMessages/applyAppendAcknowledgments', payload: p })),
    updateMessageReducer: vi.fn((p: unknown) => ({ type: 'newMessages/updateMessage', payload: p })),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'upsertManyBlocks', payload: p })),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicFulfilled', payload: p })),
    ensureTopicAnchorEstablished: vi.fn(),
    queueAdd: vi.fn(),
    transformMessagesAndFetch: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/TokenService', () => ({
  estimateUserPromptUsage: mocks.estimateUserPromptUsage
}))

vi.mock('@renderer/services/anchorService', () => ({
  ensureTopicAnchorEstablished: mocks.ensureTopicAnchorEstablished,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    appendMessage: mocks.appendMessage,
    updateMessageUsageIfUnchanged: mocks.updateMessageUsageIfUnchanged,
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
  createAssistantMessage: vi.fn((assistantId: string, topicId: string) => ({
    id: `asst-${topicId}`,
    assistantId,
    topicId,
    role: 'assistant',
    askId: 'user-1',
    status: 'pending',
    blocks: []
  })),
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

vi.mock('swr', () => ({ mutate: vi.fn() }))

vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

interface StoreState {
  assistants: { assistants: Array<{ id: string; settings?: Record<string, unknown>; topics?: Array<{ id: string }> }> }
  messages: {
    entities: Record<string, Message>
    messageIdsByTopic: Record<string, string[]>
    loadingByTopic: Record<string, boolean>
    fulfilledByTopic: Record<string, boolean>
    currentTopicId: string | null
  }
  topicBranch: {
    branchesByTopic: Record<string, unknown[]>
    activeBranchIdByTopic: Record<string, string | null>
    routeGenerationByTopic: Record<string, number>
  }
}

let storeState: StoreState

vi.mock('@renderer/store', () => ({
  default: { dispatch: vi.fn(), getState: () => storeState },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    applyAppendAcknowledgment: mocks.applyAppendAck,
    applyAppendAcknowledgments: mocks.applyAppendAcks,
    updateMessage: mocks.updateMessageReducer,
    setTopicLoading: mocks.setTopicLoading,
    setTopicFulfilled: mocks.setTopicFulfilled
  },
  selectLoadedMessagesForTopic: () => []
}))

// --- Helpers --------------------------------------------------------------

const userMessage = (): Message =>
  ({
    id: 'user-1',
    role: 'user',
    assistantId: 'asst-1',
    topicId: 't-1',
    status: UserMessageStatus.SUCCESS,
    blocks: ['block-text'],
    mentions: undefined
  }) as unknown as Message

const estimateSourceBlocks = (): MessageBlock[] =>
  [
    { id: 'block-text', messageId: 'user-1', type: MessageBlockType.MAIN_TEXT, content: 'hello world' },
    {
      id: 'block-file',
      messageId: 'user-1',
      type: MessageBlockType.FILE,
      file: { id: 'file-1', name: 'notes.txt', origin_name: 'notes.txt', path: '/tmp/notes.txt', size: 12 }
    }
  ] as unknown as MessageBlock[]

const makeAssistant = () => ({ id: 'asst-1', settings: { contextCount: 5 } })

const freshState = (): StoreState => ({
  assistants: { assistants: [{ id: 'asst-1', settings: { contextCount: 5 }, topics: [{ id: 't-1' }] }] },
  messages: {
    entities: {},
    messageIdsByTopic: { 't-1': [] },
    loadingByTopic: {},
    fulfilledByTopic: {},
    currentTopicId: null
  },
  topicBranch: { branchesByTopic: {}, activeBranchIdByTopic: {}, routeGenerationByTopic: {} }
})

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

/** Flush one macrotask so the scheduled estimate task can run to completion. */
const flushTask = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

const usage = { prompt_tokens: 7, completion_tokens: 7, total_tokens: 9 }

// --- Tests ----------------------------------------------------------------

describe('sendMessage deferred prompt-token estimate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.appendMessage.mockImplementation(echoAck as never)
    mocks.queueAdd.mockImplementation(async () => {})
    mocks.transformMessagesAndFetch.mockResolvedValue(undefined)
    mocks.updateMessageUsageIfUnchanged.mockResolvedValue({ applied: true })
    mocks.ensureTopicAnchorEstablished.mockResolvedValue(undefined)
    mocks.estimateUserPromptUsage.mockResolvedValue(usage)
    storeState = freshState()
  })

  it('never runs the estimate inside the send task (scheduled on its own task)', async () => {
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await sendMessage(userMessage(), estimateSourceBlocks(), makeAssistant() as never, 't-1')(dispatch, getState)

    // Send completed: echo published, stub appended, provider queued — and the
    // estimate's tokenization has NOT started in this task.
    expect(mocks.applyAppendAck).toHaveBeenCalledTimes(2)
    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
    expect(mocks.estimateUserPromptUsage).not.toHaveBeenCalled()
    expect(mocks.updateMessageUsageIfUnchanged).not.toHaveBeenCalled()

    // The scheduled task then performs the estimate.
    await flushTask()
    expect(mocks.estimateUserPromptUsage).toHaveBeenCalledTimes(1)
  })

  it('writes through the conditional usage mode with the estimated source snapshot', async () => {
    storeState.messages.entities['user-1'] = userMessage()
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await sendMessage(userMessage(), estimateSourceBlocks(), makeAssistant() as never, 't-1')(dispatch, getState)
    await flushTask()

    // Estimation inputs come from the message blocks: main text + the
    // ALREADY-UPLOADED file metadata.
    expect(mocks.estimateUserPromptUsage).toHaveBeenCalledWith({
      content: 'hello world',
      files: [expect.objectContaining({ id: 'file-1' })]
    })
    // The write carries the exact estimated source so Main can re-check it, on
    // the route pinned by this send.
    expect(mocks.updateMessageUsageIfUnchanged).toHaveBeenCalledWith(
      't-1',
      'user-1',
      usage,
      { textContents: ['hello world'], fileIds: ['file-1'] },
      null
    )
    // Applied + still loaded → the projection is enriched once.
    expect(mocks.updateMessageReducer).toHaveBeenCalledTimes(1)
    expect(mocks.updateMessageReducer).toHaveBeenCalledWith({
      topicId: 't-1',
      messageId: 'user-1',
      updates: { usage }
    })
  })

  it('an applied authority write with an unloaded message projects nothing (no resurrection)', async () => {
    // The message was windowed out while the estimate was in flight: the
    // authority value stands, but the projection must not gain an entity.
    storeState.messages.entities = {}
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await sendMessage(userMessage(), estimateSourceBlocks(), makeAssistant() as never, 't-1')(dispatch, getState)
    await flushTask()

    expect(mocks.updateMessageUsageIfUnchanged).toHaveBeenCalledTimes(1)
    expect(mocks.updateMessageReducer).not.toHaveBeenCalled()
  })

  it('a rejected condition (edited prompt / owned usage) projects nothing', async () => {
    storeState.messages.entities['user-1'] = userMessage()
    mocks.updateMessageUsageIfUnchanged.mockResolvedValueOnce({ applied: false, rejection: 'source-changed' })
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await sendMessage(userMessage(), estimateSourceBlocks(), makeAssistant() as never, 't-1')(dispatch, getState)
    await flushTask()

    expect(mocks.updateMessageUsageIfUnchanged).toHaveBeenCalledTimes(1)
    expect(mocks.updateMessageReducer).not.toHaveBeenCalled()
    // The send itself is unaffected.
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
  })

  it('an estimation failure never blocks the send and never writes', async () => {
    storeState.messages.entities['user-1'] = userMessage()
    mocks.estimateUserPromptUsage.mockRejectedValueOnce(new Error('estimator exploded'))
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await sendMessage(userMessage(), estimateSourceBlocks(), makeAssistant() as never, 't-1')(dispatch, getState)
    await flushTask()

    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
    expect(mocks.updateMessageUsageIfUnchanged).not.toHaveBeenCalled()
    expect(mocks.updateMessageReducer).not.toHaveBeenCalled()
  })

  it('a failing conditional write is best-effort and never projected', async () => {
    storeState.messages.entities['user-1'] = userMessage()
    mocks.updateMessageUsageIfUnchanged.mockRejectedValueOnce(new Error('storage error'))
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await sendMessage(userMessage(), estimateSourceBlocks(), makeAssistant() as never, 't-1')(dispatch, getState)
    await flushTask()

    expect(mocks.updateMessageUsageIfUnchanged).toHaveBeenCalledTimes(1)
    expect(mocks.updateMessageReducer).not.toHaveBeenCalled()
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
  })

  it('never schedules the estimate when the user echo was not published', async () => {
    // The user append is unacknowledged → nothing authoritative to enrich.
    mocks.appendMessage.mockImplementationOnce((async () => undefined) as never)
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await sendMessage(userMessage(), estimateSourceBlocks(), makeAssistant() as never, 't-1')(dispatch, getState)
    await flushTask()

    expect(mocks.estimateUserPromptUsage).not.toHaveBeenCalled()
    expect(mocks.updateMessageUsageIfUnchanged).not.toHaveBeenCalled()
  })
})
