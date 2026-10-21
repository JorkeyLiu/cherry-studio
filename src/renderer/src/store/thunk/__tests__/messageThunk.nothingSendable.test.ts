/**
 * Only-unavailable finalization of an ordinary send.
 *
 * Reported defect: a message whose attachments are all provably unavailable on
 * this device (file removed outside the app / imported without payload) was
 * reported through the request-error channel, which rendered an inline failed
 * answer after the top notice.
 *
 * Required lifecycle, proven here end to end at the send entry point:
 * - the user message is still persisted and published (the turn stays visible);
 * - no assistant stub is appended, so no empty/failed answer row exists;
 * - no provider request is queued at all;
 * - the top notice is emitted exactly once;
 * - the topic loading state is returned to not-loading (nothing sticks);
 * - text-only and text+usable-attachment sends keep the unchanged path.
 */
import type { FileMetadata } from '@renderer/types'
import type { FileMessageBlock, Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    appendMessage: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    applyAppendAck: vi.fn((p: unknown) => ({ type: 'newMessages/applyAppendAcknowledgment', payload: p })),
    applyAppendAcks: vi.fn((p: unknown) => ({ type: 'newMessages/applyAppendAcknowledgments', payload: p })),
    upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'upsertManyBlocks', payload: p })),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicFulfilled', payload: p })),
    queueAdd: vi.fn(),
    transformMessagesAndFetch: vi.fn(),
    toastError: vi.fn(),
    exists: vi.fn(),
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
  transferAnchorsAfterDeletion: vi.fn(),
  anchorKeyForRoute: (topicId: string, route: string | null) => (route ? `${topicId}:${route}` : topicId),
  transferAnchorsWithAuthorityGroupKeys: vi.fn()
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
  upsertOneBlock: vi.fn(),
  messageBlocksSelectors: { selectById: () => undefined }
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: mocks.queueAdd }),
  waitForTopicQueue: vi.fn(async () => undefined)
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

vi.mock('@renderer/services/messageStreaming/BlockManager', () => ({
  BlockManager: class MockBlockManager {}
}))

vi.mock('@renderer/services/messageStreaming/executionState', () => ({
  createAssistantExecutionState: vi.fn(() => ({}))
}))

vi.mock('@renderer/services/messageStreaming/writeBarrier', () => ({
  WriteBarrier: class MockWriteBarrier {
    track = vi.fn()
  }
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

vi.mock('@renderer/i18n', () => ({
  default: { t: (k: string) => k }
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
    loadingByTopic: Record<string, boolean>
    fulfilledByTopic: Record<string, boolean>
    currentTopicId: string | null
  }
  messageBlocks: { entities: Record<string, MessageBlock> }
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
    addMessage: vi.fn((p: unknown) => ({ type: 'newMessages/addMessage', payload: p })),
    applyAppendAcknowledgment: mocks.applyAppendAck,
    applyAppendAcknowledgments: mocks.applyAppendAcks,
    messagesReceived: vi.fn(),
    setTopicLoading: mocks.setTopicLoading,
    setTopicFulfilled: mocks.setTopicFulfilled
  },
  selectLoadedMessagesForTopic: () => []
}))

// --- Helpers --------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z'

function storedFile(id: string): FileMetadata {
  return {
    id,
    origin_name: `${id}.pdf`,
    name: `${id}.pdf`,
    path: `/managed/files/${id}.pdf`,
    created_at: TS,
    size: 2048,
    ext: '.pdf',
    type: 'document',
    count: 1
  } as unknown as FileMetadata
}

function fileBlock(messageId: string, id: string): FileMessageBlock {
  return {
    id: `block-${id}`,
    messageId,
    type: MessageBlockType.FILE,
    createdAt: TS,
    updatedAt: TS,
    status: MessageBlockStatus.SUCCESS,
    file: storedFile(id)
  } as unknown as FileMessageBlock
}

const userMessage = (blocks: string[]): Message =>
  ({
    id: 'user-1',
    role: 'user',
    assistantId: 'asst-1',
    topicId: 't-1',
    status: UserMessageStatus.SUCCESS,
    blocks
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
    messageBlocks: { entities: {} },
    topicBranch: {
      branchesByTopic: {},
      activeBranchIdByTopic: {},
      routeGenerationByTopic: {}
    }
  }
}

function echoAck(
  topicId: string,
  message: { id: string },
  _b: unknown,
  _i: unknown,
  _c: unknown,
  _a: unknown,
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

// --- Tests ----------------------------------------------------------------

describe('sendMessage — only-unavailable attachments finish the send cleanly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.asstCounter = 0
    mocks.appendMessage.mockImplementation(echoAck as never)
    mocks.queueAdd.mockImplementation(async () => {})
    mocks.transformMessagesAndFetch.mockResolvedValue(undefined)
    mocks.exists.mockResolvedValue(false)
    storeState = freshState()
    ;(window as any).toast = { error: mocks.toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() }
    ;(window as any).api = { file: { exists: mocks.exists } }
  })

  it('finalizes without an assistant stub, provider request, or error chunk', { timeout: 60_000 }, async () => {
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const block = fileBlock('user-1', 'missing-doc')

    await sendMessage(
      userMessage([block.id]),
      [block],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)

    // The user message itself is still persisted and published: the turn stays
    // visible, and only the send is skipped.
    expect(mocks.appendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.applyAppendAck).toHaveBeenCalledTimes(1)
    expect(mocks.applyAppendAck.mock.calls[0][0]).toEqual(
      expect.objectContaining({ message: expect.objectContaining({ id: 'user-1' }) })
    )

    // No assistant row was created, so no empty or failed answer can render.
    expect(
      mocks.appendMessage.mock.calls.some((call) => String((call[1] as { id: string }).id).startsWith('asst-'))
    ).toBe(false)

    // No provider execution was queued or started: nothing can produce an
    // inline error block.
    expect(mocks.queueAdd).not.toHaveBeenCalled()
    expect(mocks.transformMessagesAndFetch).not.toHaveBeenCalled()

    // The existing top notice is the whole user-visible result, emitted once.
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledWith('message.error.attachment.unavailable_skipped')

    // Loading does not stick.
    expect(mocks.setTopicLoading).toHaveBeenCalledWith({ topicId: 't-1', loading: false })
    expect(mocks.setTopicLoading).not.toHaveBeenCalledWith({ topicId: 't-1', loading: true })
  })

  it('a text-only send keeps the unchanged path (assistant stub + queued request)', { timeout: 60_000 }, async () => {
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const textBlock = {
      id: 'block-text',
      messageId: 'user-1',
      type: MessageBlockType.MAIN_TEXT,
      content: 'hello',
      createdAt: TS,
      updatedAt: TS,
      status: MessageBlockStatus.SUCCESS
    } as unknown as MessageBlock

    await sendMessage(
      userMessage([textBlock.id]),
      [textBlock],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)

    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('a missing attachment alongside text still sends the text (notice, no skip)', { timeout: 60_000 }, async () => {
    const { sendMessage } = await import('../messageThunk')
    const dispatch = vi.fn()
    const textBlock = {
      id: 'block-text-2',
      messageId: 'user-1',
      type: MessageBlockType.MAIN_TEXT,
      content: 'question',
      createdAt: TS,
      updatedAt: TS,
      status: MessageBlockStatus.SUCCESS
    } as unknown as MessageBlock
    const block = fileBlock('user-1', 'missing-doc-2')

    await sendMessage(
      userMessage([textBlock.id, block.id]),
      [textBlock, block],
      makeAssistant() as never,
      't-1'
    )(dispatch, () => storeState as never)

    // The request is attempted: the request boundary skips the missing
    // attachment and emits the single notice there.
    expect(mocks.appendMessage).toHaveBeenCalledTimes(2)
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
