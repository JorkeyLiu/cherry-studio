/**
 * selectAnswerMessageThunk — cross-process authority selection.
 *
 * Verifies:
 *  1. DB-first: ONE `dbService.selectAnswerMessage` call with the selected
 *     ID only runs BEFORE any Redux commit.
 *  2. Exactly ONE plural `updateManyMessages` Redux dispatch intersected
 *     with the loaded projection (never injects window-outside entities).
 *  3. The Redux commit carries foldSelected patches for the loaded
 *     intersection only: selected=true, others=false.
 *  4. DB failure propagates and NO Redux commit happens.
 *  5. The thunk does NOT dispatch updateTopicUpdatedAt itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    dbSelectAnswerMessage: vi.fn(),
    dbAppendMessage: vi.fn(),
    dispatch: vi.fn(),
    getState: vi.fn(),
    queueAdd: vi.fn(),
    waitForTopicQueue: vi.fn(),
    storeDispatch: vi.fn(),
    updateManyMessagesAction: vi.fn((p: unknown) => ({ type: 'updateManyMessages', payload: p })),
    updateTopicUpdatedAtAction: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p })),
    insertMessageAtIndexAction: vi.fn((p: unknown) => ({ type: 'insertMessageAtIndex', payload: p })),
    setTopicLoadingAction: vi.fn((p: unknown) => ({ type: 'setTopicLoading', payload: p })),
    setTopicFulfilledAction: vi.fn((p: unknown) => ({ type: 'setTopicFulfilled', payload: p }))
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: mocks.storeDispatch,
    getState: () => ({})
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    updateManyMessages: mocks.updateManyMessagesAction,
    updateMessage: vi.fn(),
    insertMessageAtIndex: mocks.insertMessageAtIndexAction,
    setTopicLoading: mocks.setTopicLoadingAction,
    setTopicFulfilled: mocks.setTopicFulfilledAction
  },
  selectMessagesForTopic: vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAtAction,
  default: {}
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: vi.fn(),
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    selectAnswerMessage: mocks.dbSelectAnswerMessage,
    updateMessageAndBlocks: vi.fn(),
    updateMessage: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    appendMessage: mocks.dbAppendMessage,
    deleteMessage: vi.fn(),
    resetMessagesForResend: vi.fn(),
    fetchMessages: vi.fn().mockResolvedValue({ messages: [], blocks: [] }),
    deleteMessagesWithSegments: vi.fn(),
    deleteBlocks: vi.fn(),
    listBlocksByFile: vi.fn()
  }
}))

vi.mock('@renderer/services/db/DbService', () => ({
  DbService: {
    getInstance: () => ({
      selectAnswerMessage: vi.fn()
    })
  }
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: vi.fn(() => ({ add: mocks.queueAdd })),
  waitForTopicQueue: mocks.waitForTopicQueue
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: vi.fn(),
  findMainTextBlocks: vi.fn(),
  findAllBlocks: vi.fn(),
  findTranslationBlocks: vi.fn(),
  findTranslationBlocksById: vi.fn(),
  isAssistantInterruptedThinkingOnlyMessage: vi.fn()
}))

vi.mock('lru-cache', () => ({
  LRUCache: vi.fn().mockImplementation(() => ({
    has: vi.fn(() => false),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }))
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

vi.mock('@renderer/store/topicSegment', () => ({
  clearSegmentsForTopic: vi.fn()
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  clearTopicSegmentsFromDB: vi.fn(),
  loadTopicSegmentsThunk: vi.fn(),
  removeMessageFromSegmentsThunk: vi.fn()
}))

// Import AFTER mocks
import { appendAssistantResponseThunk, selectAnswerMessageThunk } from '@renderer/store/thunk/messageThunk'

// --- Test data ------------------------------------------------------------

const topicId = 'topic-123'
const selectedMessageId = 'a-2'
const authorityResponse = {
  topicId,
  askId: 'ask-1',
  selectedMessageId,
  messageIds: ['a-1', 'a-2', 'a-3']
}

// --- Tests ----------------------------------------------------------------

describe('selectAnswerMessageThunk — cross-process authority selection', () => {
  const dispatch = mocks.dispatch as any
  const getState = mocks.getState as any

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dbSelectAnswerMessage.mockResolvedValue(authorityResponse)
    getState.mockReturnValue({
      messages: {
        entities: { 'a-1': { id: 'a-1' }, 'a-2': { id: 'a-2' } },
        messageIdsByTopic: { [topicId]: ['a-1', 'a-2'] }
      }
    })
  })

  it('runs ONE atomic DB command with the selected ID only BEFORE any Redux commit', async () => {
    const callOrder: string[] = []
    mocks.dbSelectAnswerMessage.mockImplementation(async () => {
      callOrder.push('db-atomic')
      return authorityResponse
    })
    dispatch.mockImplementation((action: unknown) => {
      callOrder.push(`redux-${(action as any).type}`)
      return action
    })

    await selectAnswerMessageThunk(topicId, selectedMessageId)(dispatch, getState)

    expect(mocks.dbSelectAnswerMessage).toHaveBeenCalledTimes(1)
    expect(mocks.dbSelectAnswerMessage).toHaveBeenCalledWith(topicId, selectedMessageId)

    const dbIdx = callOrder.findIndex((c) => c.startsWith('db-'))
    const reduxIdx = callOrder.findIndex((c) => c.startsWith('redux-'))
    expect(dbIdx).toBeGreaterThanOrEqual(0)
    expect(reduxIdx).toBeGreaterThanOrEqual(0)
    expect(dbIdx).toBeLessThan(reduxIdx)
  })

  it('performs EXACTLY ONE plural Redux dispatch for the loaded intersection', async () => {
    await selectAnswerMessageThunk(topicId, selectedMessageId)(dispatch, getState)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.updateManyMessagesAction).toHaveBeenCalledTimes(1)
  })

  it('commits only the loaded intersection (window-outside member excluded)', async () => {
    await selectAnswerMessageThunk(topicId, selectedMessageId)(dispatch, getState)

    const payload = mocks.updateManyMessagesAction.mock.calls[0][0] as any
    expect(payload.topicId).toBe(topicId)
    expect(payload.updates).toEqual([
      { messageId: 'a-1', updates: { foldSelected: false } },
      { messageId: 'a-2', updates: { foldSelected: true } }
    ])
  })

  it('does NOT touch Redux when the DB command fails (no divergent state)', async () => {
    mocks.dbSelectAnswerMessage.mockRejectedValue(new Error('SQLite not found'))

    await expect(selectAnswerMessageThunk(topicId, selectedMessageId)(dispatch, getState)).rejects.toThrow(
      'SQLite not found'
    )

    expect(dispatch).not.toHaveBeenCalled()
    expect(mocks.updateManyMessagesAction).not.toHaveBeenCalled()
  })

  it('rejection is awaitable by the caller (append path contains it in try/catch, no unhandled rejection)', async () => {
    // appendAssistantResponseThunk awaits this thunk inside its own try/catch:
    // a second-transaction failure must surface as a catchable rejection (so
    // the caller logs it) while the already-committed stub stands as DB truth
    // — never an unhandled rejection, never a claimed rollback.
    mocks.dbSelectAnswerMessage.mockRejectedValue(new Error('second-transaction failure'))

    const pending = selectAnswerMessageThunk(topicId, selectedMessageId)(dispatch, getState)
    await expect(pending).rejects.toThrow('second-transaction failure')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does NOT dispatch updateTopicUpdatedAt itself (data source owns the single timestamp dispatch)', async () => {
    await selectAnswerMessageThunk(topicId, selectedMessageId)(dispatch, getState)

    expect(mocks.updateTopicUpdatedAtAction).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('appendAssistantResponseThunk — selection failure never blocks the generation queue', () => {
  const appendTopicId = 'topic-append'
  const existingAssistantId = 'asst-existing'
  const userQueryId = 'user-query-1'
  const newModel = { id: 'new-model', provider: 'test-provider', name: 'New Model', group: 'test' } as never
  const assistant = { id: 'asst-1', name: 'asst-1' } as never

  const makeAppendState = () => ({
    messages: {
      entities: {
        [userQueryId]: { id: userQueryId, role: 'user' },
        [existingAssistantId]: { id: existingAssistantId, role: 'assistant', askId: userQueryId }
      },
      messageIdsByTopic: { [appendTopicId]: [userQueryId, existingAssistantId] }
    }
  })

  // Mirrors Redux-thunk semantics: dispatching a thunk executes it so the
  // selectAnswer rejection is a catchable promise inside the append thunk —
  // never an unhandled rejection.
  const makeThunkAwareDispatch = () => {
    const d: any = vi.fn((action: unknown) => {
      if (typeof action === 'function') {
        return (action as any)(d, mocks.getState)
      }
      return action
    })
    return d
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dbAppendMessage.mockResolvedValue(undefined)
    mocks.queueAdd.mockResolvedValue(undefined)
    mocks.waitForTopicQueue.mockResolvedValue(undefined)
    mocks.dbSelectAnswerMessage.mockImplementation(async (_t: string, selectedId: string) => ({
      topicId: appendTopicId,
      askId: userQueryId,
      selectedMessageId: selectedId,
      messageIds: [existingAssistantId, selectedId]
    }))
  })

  it('selection reject still starts queue.add/fetch pipeline and resolves per existing return semantics', async () => {
    mocks.dbSelectAnswerMessage.mockRejectedValue(new Error('second-transaction failure'))
    mocks.getState.mockReturnValue(makeAppendState())

    const dispatch = makeThunkAwareDispatch()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(
        appendAssistantResponseThunk(appendTopicId, existingAssistantId, newModel, assistant)(dispatch, mocks.getState)
      ).resolves.toBeUndefined()

      // Stub committed first, then generation queued unconditionally.
      expect(mocks.dbAppendMessage).toHaveBeenCalledTimes(1)
      expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
      // Selection was attempted but its failure did not propagate.
      expect(mocks.dbSelectAnswerMessage).toHaveBeenCalledTimes(1)
      // Caller keeps fire-and-forget queue semantics: the LLM task itself is not awaited.
      const queuedTask = mocks.queueAdd.mock.calls[0][0] as () => Promise<void>
      expect(typeof queuedTask).toBe('function')

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('selection success does not need to block queue start (queue.add runs before selection settles)', async () => {
    let resolveSelection!: (value: unknown) => void
    const selectionGate = new Promise((resolve) => {
      resolveSelection = resolve
    })
    mocks.dbSelectAnswerMessage.mockImplementation(async (_t: string, selectedId: string) =>
      selectionGate.then(() => ({
        topicId: appendTopicId,
        askId: userQueryId,
        selectedMessageId: selectedId,
        messageIds: [existingAssistantId, selectedId]
      }))
    )
    mocks.getState.mockReturnValue(makeAppendState())

    const dispatch = makeThunkAwareDispatch()
    const pending = appendAssistantResponseThunk(
      appendTopicId,
      existingAssistantId,
      newModel,
      assistant
    )(dispatch, mocks.getState)

    // Flush so the thunk reaches queue.add while selection is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.dbAppendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1)

    resolveSelection(undefined)
    await expect(pending).resolves.toBeUndefined()
    expect(mocks.dbSelectAnswerMessage).toHaveBeenCalledTimes(1)
  })
})
