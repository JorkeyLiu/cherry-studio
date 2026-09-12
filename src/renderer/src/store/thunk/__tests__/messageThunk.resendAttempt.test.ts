/**
 * Resend execution identity isolation (F1) + finalization quiescence (F2).
 *
 * F1: the Main-authoritative attempt is captured into the resend/regenerate
 * execution closure and threaded explicitly — no messageId-keyed lookup feeds
 * any write path. Overlapping executions keep their own immutable ids, so a
 * superseded execution's residual writes still carry the old id and fail
 * closed in Main instead of adopting the new one.
 *
 * F2: the success-final message write awaits BlockManager quiescence (pending
 * throttled trailing flushes + in-flight DB writes) before running, so the
 * Main issuer can never observe a partially flushed streaming state.
 */

import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { WriteBarrier } from '@renderer/services/messageStreaming/writeBarrier'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resetMessagesForResend: vi.fn(),
    appendMessage: vi.fn(),
    updateMessage: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    bulkAddBlocks: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    selectMessagesForTopic: vi.fn(),
    transformMessagesAndFetch: vi.fn(),
    autoRenameTopic: vi.fn(),
    computeContextInfo: vi.fn(),
    getAssistantSettings: vi.fn()
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

vi.mock('@renderer/services/db', () => ({
  dbService: {
    resetMessagesForResend: mocks.resetMessagesForResend,
    appendMessage: mocks.appendMessage,
    updateMessage: mocks.updateMessage,
    updateMessageAndBlocks: mocks.updateMessageAndBlocks,
    updateBlocks: mocks.updateBlocks,
    updateSingleBlock: mocks.updateSingleBlock,
    bulkAddBlocks: mocks.bulkAddBlocks
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn()
}))

vi.mock('@renderer/utils/queue', () => ({
  // Execute queued tasks inline so closure capture is observable.
  getTopicQueue: () => ({ add: (task: () => Promise<unknown>) => task() }),
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

vi.mock('@renderer/services/ApiService', () => ({
  transformMessagesAndFetch: mocks.transformMessagesAndFetch
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  autoRenameTopic: mocks.autoRenameTopic
}))

vi.mock('@renderer/services/contextInfoService', () => ({
  computeContextInfo: mocks.computeContextInfo
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: mocks.getAssistantSettings
}))

const createMessage = (overrides: Partial<Message> & Record<string, unknown> = {}): Message =>
  ({
    id: 'assistant-1',
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: AssistantMessageStatus.PENDING,
    blocks: [],
    askId: 'user-msg-1',
    model: { id: 'model-1' } as any,
    modelId: 'model-1',
    ...overrides
  }) as unknown as Message

const createUserMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'user-msg-1',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    blocks: ['user-block-1'],
    ...overrides
  }) as unknown as Message

interface StoreState {
  messages: { entities: Record<string, Message>; messageIdsByTopic: Record<string, string[]> }
  messageBlocks: { entities: Record<string, any> }
  assistants: { assistants: Array<{ id: string }> }
}

let storeState: StoreState

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  }
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    addMessage: vi.fn((p: unknown) => ({ type: 'addMessage', p })),
    updateMessage: vi.fn((p: unknown) => ({ type: 'updateMessage', p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'setTopicLoading', p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'setTopicFulfilled', p })),
    upsertBlockReference: vi.fn((p: unknown) => ({ type: 'upsertBlockReference', p }))
  },
  selectMessagesForTopic: mocks.selectMessagesForTopic
}))

vi.mock('@renderer/store/messageBlock', () => ({
  removeManyBlocks: vi.fn((p: unknown) => ({ type: 'removeManyBlocks', p })),
  updateOneBlock: vi.fn((p: unknown) => ({ type: 'updateOneBlock', p })),
  upsertManyBlocks: vi.fn(),
  upsertOneBlock: vi.fn((p: unknown) => ({ type: 'upsertOneBlock', p })),
  messageBlocksSelectors: {
    selectById: (state: any, id: string) => state?.messageBlocks?.entities?.[id]
  }
}))

// --- Helpers --------------------------------------------------------------

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain the microtask queue (deeper than a single tick). */
const flushMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r))

// --- Tests ----------------------------------------------------------------

describe('F1: execution closure owns the attempt (no shared lookup)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} },
      assistants: { assistants: [] }
    }
    mocks.transformMessagesAndFetch.mockResolvedValue(undefined)
    mocks.selectMessagesForTopic.mockImplementation(() => [])
    mocks.updateBlocks.mockResolvedValue(undefined)
    mocks.updateMessage.mockResolvedValue(undefined)
  })

  it('routes per-message attempts into their own execution closures', async () => {
    const { resendMessageThunk } = await import('../messageThunk')
    const userMsg = createUserMessage()
    const assistantA = createMessage({ id: 'assistant-A', askId: userMsg.id, blocks: [] })
    const assistantB = createMessage({ id: 'assistant-B', askId: userMsg.id, blocks: [] })
    storeState.messages.entities[userMsg.id] = userMsg
    storeState.messages.entities[assistantA.id] = assistantA
    storeState.messages.entities[assistantB.id] = assistantB
    storeState.messageBlocks.entities['block-A'] = { id: 'block-A', messageId: 'assistant-A' }
    storeState.messageBlocks.entities['block-B'] = { id: 'block-B', messageId: 'assistant-B' }
    storeState.assistants.assistants = [{ id: 'assistant-1', topics: [], settings: {}, prompt: '' } as never]
    mocks.selectMessagesForTopic.mockReturnValue([userMsg, assistantA, assistantB])
    mocks.resetMessagesForResend.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      attempts: [
        { messageId: 'assistant-A', attemptId: 'attempt-A' },
        { messageId: 'assistant-B', attemptId: 'attempt-B' }
      ]
    })

    const dispatch = vi.fn()
    const getState = () => storeState as never
    await resendMessageThunk('topic-1', userMsg, { id: 'assistant-1', topics: [], settings: {} } as never)(
      dispatch,
      getState as never
    )
    expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(2)

    // Each captured execution writes with exactly its own attempt.
    const calls = mocks.transformMessagesAndFetch.mock.calls as Array<[any, any]>
    expect(calls).toHaveLength(2)
    for (const [fetchArgs] of calls) {
      const manager = fetchArgs.blockManager as BlockManager
      const targetBlock = fetchArgs.assistantMsgId === 'assistant-A' ? 'block-A' : 'block-B'
      const expected = fetchArgs.assistantMsgId === 'assistant-A' ? 'attempt-A' : 'attempt-B'
      manager.smartBlockUpdate(
        targetBlock,
        { content: 'x', status: MessageBlockStatus.SUCCESS },
        MessageBlockType.MAIN_TEXT,
        true
      )
      await flushMicrotasks()
      const blockCalls = mocks.updateBlocks.mock.calls.filter(
        ([blocks]) => (blocks as Array<{ id: string }>)[0]?.id === targetBlock
      )
      expect(blockCalls.length).toBeGreaterThan(0)
      for (const [, , attempt] of blockCalls) {
        expect(attempt).toBe(expected)
      }
    }
  })

  it('a superseded execution keeps carrying its own stale id (never adopts the new one)', async () => {
    const { saveUpdatedBlockToDB } = await import('../messageThunk')
    // Execution A (attempt-A) starts a streaming write and suspends it.
    const gateA = deferred<void>()
    mocks.updateBlocks.mockReturnValueOnce(gateA.promise)
    const barrierA = new WriteBarrier()
    const execA = { attempt: 'attempt-A', barrier: barrierA }
    const managerA = new BlockManager({
      dispatch: vi.fn(),
      getState: () => storeState as never,
      saveUpdatedBlockToDB: (bid, mid, tid, gs) => saveUpdatedBlockToDB(bid, mid, tid, gs, execA.attempt),
      saveUpdatesToDB: async () => {},
      assistantMsgId: 'assistant-1',
      topicId: 'topic-1',
      resendAttemptId: execA.attempt,
      barrier: execA.barrier,
      throttledBlockUpdate: vi.fn(),
      flushThrottledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    storeState.messageBlocks.entities['block-A1'] = { id: 'block-A1', messageId: 'assistant-1' }
    managerA.smartBlockUpdate('block-A1', { content: 'A-partial' }, MessageBlockType.MAIN_TEXT, true)
    await flushMicrotasks()
    expect(mocks.updateBlocks).toHaveBeenCalledTimes(1)

    // Execution B supersedes (attempt-B) and completes normally.
    const barrierB = new WriteBarrier()
    const execB = { attempt: 'attempt-B', barrier: barrierB }
    const managerB = new BlockManager({
      dispatch: vi.fn(),
      getState: () => storeState as never,
      saveUpdatedBlockToDB: (bid, mid, tid, gs) => saveUpdatedBlockToDB(bid, mid, tid, gs, execB.attempt),
      saveUpdatesToDB: async () => {},
      assistantMsgId: 'assistant-1',
      topicId: 'topic-1',
      resendAttemptId: execB.attempt,
      barrier: execB.barrier,
      throttledBlockUpdate: vi.fn(),
      flushThrottledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    storeState.messageBlocks.entities['block-B1'] = { id: 'block-B1', messageId: 'assistant-1' }
    managerB.smartBlockUpdate('block-B1', { content: 'B-final' }, MessageBlockType.MAIN_TEXT, true)
    await flushMicrotasks()

    // Release A's residual write: it still carries attempt-A.
    gateA.resolve()
    await flushMicrotasks()
    const attempts = mocks.updateBlocks.mock.calls.map((c) => (c as unknown[])[2])
    expect(attempts).toEqual(['attempt-A', 'attempt-B'])
    // Neither execution cleared or consulted the other.
    await managerA.quiesceWrites()
    await managerB.quiesceWrites()
    expect(barrierA.pendingCount).toBe(0)
    expect(barrierB.pendingCount).toBe(0)
  })

  it('legacy reset without a mapping omits the carrier', async () => {
    const { resendMessageThunk, updateMessage } = await import('../messageThunk')
    mocks.resetMessagesForResend.mockResolvedValueOnce({
      affectedFileIds: [],
      remainingReferenceCounts: {}
    })
    const userMsg = createUserMessage()
    const assistantMsg = createMessage({ id: 'assistant-1', askId: userMsg.id, blocks: [] })
    storeState.messages.entities[userMsg.id] = userMsg
    storeState.messages.entities[assistantMsg.id] = assistantMsg
    mocks.selectMessagesForTopic.mockReturnValue([userMsg, assistantMsg])
    const dispatch = vi.fn()
    const getState = () => storeState as never
    await resendMessageThunk('topic-1', userMsg, { id: 'assistant-1', topics: [], settings: {} } as never)(
      dispatch,
      getState as never
    )

    await updateMessage('topic-1', 'assistant-1', { content: 'x' } as never)
    expect(mocks.updateMessage).toHaveBeenCalledWith('topic-1', 'assistant-1', { content: 'x' }, undefined)
  })

  it('explicit updateMessageAndBlocksThunk never carries an execution attempt', async () => {
    const { resendMessageThunk, updateMessageAndBlocksThunk } = await import('../messageThunk')
    const userMsg = createUserMessage()
    const assistantMsg = createMessage({ id: 'assistant-1', askId: userMsg.id })
    storeState.messages.entities[userMsg.id] = userMsg
    storeState.messages.entities[assistantMsg.id] = assistantMsg
    mocks.selectMessagesForTopic.mockReturnValue([userMsg, assistantMsg])
    mocks.resetMessagesForResend.mockResolvedValue({
      affectedFileIds: [],
      remainingReferenceCounts: {},
      attempts: [{ messageId: 'assistant-1', attemptId: 'attempt-ctx-1' }]
    })
    const dispatch = vi.fn()
    const getState = () => storeState as never
    await resendMessageThunk('topic-1', userMsg, { id: 'assistant-1', topics: [], settings: {} } as never)(
      dispatch,
      getState as never
    )

    mocks.updateMessageAndBlocks.mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} })
    const editUpdates = { id: 'assistant-1', content: 'edit' } as never
    await updateMessageAndBlocksThunk('topic-1', editUpdates, [])(vi.fn())
    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledWith('topic-1', editUpdates, [], [])
  })
})

describe('F2: success-final awaits quiescence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} },
      assistants: { assistants: [] }
    }
    mocks.transformMessagesAndFetch.mockResolvedValue(undefined)
    mocks.selectMessagesForTopic.mockImplementation(() => [])
    mocks.getAssistantSettings.mockReturnValue({})
    mocks.computeContextInfo.mockReturnValue({ uiMessages: [] })
    mocks.updateBlocks.mockResolvedValue(undefined)
    mocks.updateMessage.mockResolvedValue(undefined)
  })

  it('quiesce flushes touched throttlers and resolves only after pending writes settle', async () => {
    const { updateBlocks } = await import('../messageThunk')
    const barrier = new WriteBarrier()
    const gate = deferred<void>()
    mocks.updateBlocks.mockReturnValueOnce(gate.promise)
    const flushFn = vi.fn()
    const throttledFn = vi.fn()
    const manager = new BlockManager({
      dispatch: vi.fn(),
      getState: () => storeState as never,
      saveUpdatedBlockToDB: async () => {},
      saveUpdatesToDB: async () => {},
      assistantMsgId: 'assistant-1',
      topicId: 'topic-1',
      barrier,
      throttledBlockUpdate: throttledFn,
      flushThrottledBlockUpdate: flushFn,
      cancelThrottledBlockUpdate: vi.fn()
    })
    // Throttled-path write marks the block touched; immediate path suspends a write.
    manager.smartBlockUpdate('b-t', { content: 'streaming' }, MessageBlockType.MAIN_TEXT)
    expect(throttledFn).toHaveBeenCalledTimes(1)
    storeState.messageBlocks.entities['b-q'] = { id: 'b-q', messageId: 'assistant-1' }
    void barrier.track(updateBlocks([{ id: 'b-q', messageId: 'assistant-1' }] as never))
    expect(barrier.pendingCount).toBe(1)
    let settled = false
    const q = manager.quiesceWrites().then(() => {
      settled = true
    })
    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(flushFn).toHaveBeenCalledWith('b-t')
    gate.resolve()
    await q
    expect(settled).toBe(true)
    expect(barrier.pendingCount).toBe(0)
  })

  it('onComplete holds the success-final message write until the suspended block write lands', async () => {
    const assistantMsg = createMessage({
      id: 'assistant-1',
      status: AssistantMessageStatus.SUCCESS,
      blocks: ['b-final'],
      content: 'final answer'
    })
    storeState.messages.entities['assistant-1'] = assistantMsg
    storeState.messageBlocks.entities['b-final'] = {
      id: 'b-final',
      messageId: 'assistant-1',
      content: 'final answer',
      status: MessageBlockStatus.SUCCESS
    }
    mocks.selectMessagesForTopic.mockReturnValue([assistantMsg])

    const barrier = new WriteBarrier()
    const gate = deferred<void>()
    mocks.updateBlocks.mockReturnValueOnce(gate.promise)

    const { saveUpdatesToDB, saveUpdatedBlockToDB } = await import('../messageThunk')
    const attempt = 'attempt-F2'
    const manager = new BlockManager({
      dispatch: vi.fn(),
      getState: () => storeState as never,
      saveUpdatedBlockToDB: (bid, mid, tid, gs) => saveUpdatedBlockToDB(bid, mid, tid, gs, attempt),
      saveUpdatesToDB: (mid, tid, mu, blocks) => saveUpdatesToDB(mid, tid, mu, blocks, attempt),
      assistantMsgId: 'assistant-1',
      topicId: 'topic-1',
      resendAttemptId: attempt,
      barrier,
      throttledBlockUpdate: vi.fn(),
      flushThrottledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    const callbacks = createCallbacks({
      blockManager: manager,
      dispatch: vi.fn(),
      getState: () => storeState as never,
      topicId: 'topic-1',
      assistantMsgId: 'assistant-1',
      saveUpdatesToDB: (mid: string, tid: string, mu: any, blocks: any[]) =>
        saveUpdatesToDB(mid, tid, mu, blocks, attempt),
      assistant: { id: 'assistant-1', settings: {}, topics: [] } as never
    })

    // Suspend the final block write through the immediate completion path.
    manager.smartBlockUpdate(
      'b-final',
      { content: 'final answer', status: MessageBlockStatus.SUCCESS },
      MessageBlockType.MAIN_TEXT,
      true
    )
    await flushMicrotasks()
    expect(mocks.updateBlocks).toHaveBeenCalledTimes(1)

    // Trigger onComplete while the block write is still suspended.
    const done = callbacks.onComplete(AssistantMessageStatus.SUCCESS, {
      usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 },
      metrics: { completion_tokens: 5 }
    } as never)
    await flushMicrotasks()
    expect(mocks.updateMessage).not.toHaveBeenCalled()

    // Release: the block write lands first, then the success-final follows.
    gate.resolve()
    await done
    const firstBlockCall = mocks.updateBlocks.mock.calls[0] as unknown[]
    expect((firstBlockCall[0] as Array<{ content: string }>)[0].content).toBe('final answer')
    expect(firstBlockCall[2]).toBe(attempt)
    expect(mocks.updateMessage).toHaveBeenCalledTimes(1)
    const [, , updates, finalAttempt] = mocks.updateMessage.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      string
    ]
    expect(updates.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(finalAttempt).toBe(attempt)
  })
})

describe('Legacy ordinary path: no attempt, no barrier, no flush wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      messages: { entities: {}, messageIdsByTopic: {} },
      messageBlocks: { entities: {} },
      assistants: { assistants: [] }
    }
  })

  it('tolerates save mocks returning nothing and keeps the old cancel semantics', () => {
    const dispatch = vi.fn()
    const cancelFn = vi.fn()
    const manager = new BlockManager({
      dispatch,
      getState: () => storeState as never,
      // Legacy/test wiring: bare vi.fn() returns undefined, like the
      // pre-F2 `void save(...)` fire-and-forget call sites tolerated.
      saveUpdatedBlockToDB: vi.fn(),
      saveUpdatesToDB: vi.fn(),
      assistantMsgId: 'assistant-1',
      topicId: 'topic-1',
      throttledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: cancelFn
    })
    expect(() => manager.smartBlockUpdate('b-legacy', { content: 'x' }, MessageBlockType.MAIN_TEXT, true)).not.toThrow()
    // Redux update still lands and the pending throttle is cancelled (never flushed).
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(cancelFn).toHaveBeenCalledWith('b-legacy')
  })

  it('handleBlockTransition with a barrier but a non-promise save resolves without tracking', async () => {
    const dispatch = vi.fn()
    const barrier = new WriteBarrier()
    storeState.messages.entities['assistant-1'] = createMessage({ id: 'assistant-1' })
    const manager = new BlockManager({
      dispatch,
      getState: () => storeState as never,
      saveUpdatedBlockToDB: vi.fn(),
      saveUpdatesToDB: vi.fn(),
      assistantMsgId: 'assistant-1',
      topicId: 'topic-1',
      barrier,
      throttledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    await expect(
      manager.handleBlockTransition({ id: 'nb-legacy', messageId: 'assistant-1' } as never, MessageBlockType.MAIN_TEXT)
    ).resolves.toBeUndefined()
    expect(barrier.pendingCount).toBe(0)
    // Transition dispatches (message update + block upsert + block reference) all land.
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
