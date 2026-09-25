/**
 * Terminal write ordering: quiesce BEFORE any terminal block marking.
 *
 * Proves that streaming onComplete — after BlockManager quiescence — commits
 * the assistant message final state together with ALL of its final blocks in
 * ONE `dbService.updateMessageAndBlocks` call (no message-only final save),
 * forces the terminal target to SUCCESS in the committed payload even when a
 * trailing throttled STREAMING write flushes during quiesce, converges Redux
 * (target block + message) to SUCCESS only AFTER the DB-first commit, keeps
 * failure fork-free, fail-closes on a missing target without dropping
 * message.blocks references, threads the resend attempt, and keeps
 * multi-block/unsupported payloads intact in the same tx.
 */

import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { AssistantExecutionState } from '@renderer/services/messageStreaming/executionState'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { messagesSlice } from '@renderer/store/newMessage'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks, storeHolder, loggerMocks } = vi.hoisted(() => ({
  mocks: {
    updateMessage: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    getAssistantSettings: vi.fn(),
    computeContextInfo: vi.fn(),
    autoRenameTopic: vi.fn()
  },
  loggerMocks: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn()
  },
  storeHolder: { current: null as any }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => loggerMocks
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    updateMessage: mocks.updateMessage,
    updateMessageAndBlocks: mocks.updateMessageAndBlocks,
    updateBlocks: mocks.updateBlocks,
    updateSingleBlock: mocks.updateSingleBlock
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: (...args: any[]) => storeHolder.current.dispatch(...args),
    getState: () => storeHolder.current.getState()
  }
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn(() => ({ type: 'UPDATE_TOPIC_UPDATED_AT' }))
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: mocks.getAssistantSettings
}))

vi.mock('@renderer/services/contextInfoService', () => ({
  computeContextInfo: mocks.computeContextInfo
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  autoRenameTopic: mocks.autoRenameTopic
}))

vi.mock('@renderer/services/NotificationService', () => ({
  NotificationService: {
    getInstance: vi.fn(() => ({ send: vi.fn() }))
  }
}))

vi.mock('@renderer/utils/window', () => ({
  isOnHomePage: vi.fn(() => true),
  isFocused: vi.fn(() => true)
}))

// --- Helpers --------------------------------------------------------------

const reducer = combineReducers({
  messages: messagesSlice.reducer,
  messageBlocks: messageBlocksSlice.reducer
})

type TestStore = ReturnType<typeof createTestStore>
const createTestStore = () =>
  configureStore({ reducer, middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false }) })

const TOPIC_ID = 'topic-final'
const ASSISTANT_MSG_ID = 'assistant-final'
const ATTEMPT = 'attempt-final-1'

const seedMessage = (store: TestStore, overrides: Partial<Message> = {}) => {
  const message = {
    id: ASSISTANT_MSG_ID,
    assistantId: 'assistant-1',
    role: 'assistant',
    topicId: TOPIC_ID,
    blocks: [],
    status: AssistantMessageStatus.PENDING,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    askId: 'user-1',
    ...overrides
  } as unknown as Message
  store.dispatch(messagesSlice.actions.addMessage({ topicId: TOPIC_ID, message }))
  return message
}

const seedBlocks = (store: TestStore, blocks: MessageBlock[]) => {
  store.dispatch(messageBlocksSlice.actions.upsertManyBlocks(blocks as any))
}

const textBlock = (overrides: Partial<MessageBlock> = {}): MessageBlock =>
  ({
    id: 'b-text',
    messageId: ASSISTANT_MSG_ID,
    type: MessageBlockType.MAIN_TEXT,
    content: 'final hello',
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }) as MessageBlock

const assistantStub = { id: 'assistant-1', settings: {}, topics: [], model: { id: 'm', provider: 'openai' } } as never

const successResponse = {
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  metrics: { completion_tokens: 5, time_completion_millsec: 100 }
} as { usage: any; metrics: any }

async function createHarness(
  store: TestStore,
  saveFinal?: (mid: string, tid: string, mu: any, blocks: any[]) => any,
  managerOverrides: Record<string, any> = {}
) {
  const { saveFinalMessageAndBlocksAtomically } = await import('../messageThunk')
  const attempt = ATTEMPT
  const manager = new BlockManager({
    dispatch: store.dispatch as any,
    getState: store.getState as any,
    saveUpdatedBlockToDB: vi.fn().mockResolvedValue(undefined),
    saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
    assistantMsgId: ASSISTANT_MSG_ID,
    topicId: TOPIC_ID,
    resendAttemptId: attempt,
    throttledBlockUpdate: vi.fn(),
    flushThrottledBlockUpdate: vi.fn(),
    cancelThrottledBlockUpdate: vi.fn(),
    ...managerOverrides
  })
  const callbacks = createCallbacks({
    blockManager: manager,
    dispatch: store.dispatch as any,
    getState: store.getState as any,
    topicId: TOPIC_ID,
    assistantMsgId: ASSISTANT_MSG_ID,
    saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
    saveFinalUpdatesAtomically:
      saveFinal ??
      ((mid: string, tid: string, mu: any, blocks: any[]) =>
        saveFinalMessageAndBlocksAtomically(tid, mid, mu, blocks, attempt)),
    assistant: assistantStub
  })
  return { manager, callbacks }
}

// --- Tests ----------------------------------------------------------------

describe('Terminal ordering: quiesce before terminal marking + DB-first atomic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateMessageAndBlocks.mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} })
    mocks.consumeFileCleanupResult.mockResolvedValue(undefined)
    mocks.getAssistantSettings.mockReturnValue({})
    mocks.computeContextInfo.mockReturnValue({ uiMessages: [] })
    mocks.autoRenameTopic.mockResolvedValue(undefined)
  })

  it('commits message success + all final blocks in ONE updateMessageAndBlocks; no message-only final save', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-text', 'b-tool', 'b-file'] })
    const toolBlock = {
      id: 'b-tool',
      messageId: ASSISTANT_MSG_ID,
      type: MessageBlockType.TOOL,
      content: '42',
      status: MessageBlockStatus.SUCCESS,
      toolName: 'calculator',
      metadata: { rawMcpToolResponse: { status: 'done' } },
      createdAt: '2026-01-01T00:00:00.000Z'
    } as unknown as MessageBlock
    const fileBlock = {
      id: 'b-file',
      messageId: ASSISTANT_MSG_ID,
      type: MessageBlockType.FILE,
      content: '',
      status: MessageBlockStatus.SUCCESS,
      createdAt: '2026-01-01T00:00:00.000Z'
    } as unknown as MessageBlock
    seedBlocks(store, [
      textBlock({ status: MessageBlockStatus.STREAMING, content: 'final hello (edited)' }),
      toolBlock,
      fileBlock
    ])

    const { manager, callbacks } = await createHarness(store)
    // Terminal target resolves via the trailing active block.
    manager.activeBlockInfo = { id: 'b-text', type: MessageBlockType.MAIN_TEXT }
    const emitSpy = vi.spyOn(EventEmitter, 'emit')
    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)

    // Exactly one atomic commit; no message-only or block-only final writes.
    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledTimes(1)
    expect(mocks.updateMessage).not.toHaveBeenCalled()
    expect(mocks.updateBlocks).not.toHaveBeenCalled()
    expect(mocks.updateSingleBlock).not.toHaveBeenCalled()

    const [topicId, updates, blocks, deletes, attempt] = mocks.updateMessageAndBlocks.mock.calls[0] as unknown as [
      string,
      Record<string, any>,
      Array<Record<string, any>>,
      string[],
      string
    ]
    expect(topicId).toBe(TOPIC_ID)
    expect(updates.id).toBe(ASSISTANT_MSG_ID)
    expect(updates.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(updates.metrics).toEqual(successResponse.metrics)
    expect(updates.usage).toEqual(successResponse.usage)
    // Full original block references — never a filtered list.
    expect(updates.blocks).toEqual(['b-text', 'b-tool', 'b-file'])
    // All final blocks, in message order, with latest payloads; the terminal
    // target is forced SUCCESS in the committed payload.
    expect(blocks.map((b) => b.id)).toEqual(['b-text', 'b-tool', 'b-file'])
    expect(blocks[0].content).toBe('final hello (edited)')
    expect(blocks[0].status).toBe(MessageBlockStatus.SUCCESS)
    expect(blocks[1].toolName).toBe('calculator')
    expect(blocks[2].type).toBe(MessageBlockType.FILE)
    expect(deletes).toEqual([])
    // resend/regenerate attempt threads through.
    expect(attempt).toBe(ATTEMPT)

    // Cleanup consumed once post-commit per the existing paradigm.
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledTimes(1)
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledWith({ affectedFileIds: [], remainingReferenceCounts: {} })

    // Redux converges to the committed state only after success: both the
    // terminal block and the message are SUCCESS.
    expect(store.getState().messageBlocks.entities['b-text']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(emitSpy).toHaveBeenCalledWith(EVENT_NAMES.MESSAGE_COMPLETE, {
      id: ASSISTANT_MSG_ID,
      topicId: TOPIC_ID,
      status: AssistantMessageStatus.SUCCESS
    })
    emitSpy.mockRestore()
  })

  it('quiesces before any terminal block marking or atomic persist (no pre-quiesce SUCCESS dispatch)', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-streaming'] })
    seedBlocks(store, [textBlock({ id: 'b-streaming', content: 'streaming...', status: MessageBlockStatus.STREAMING })])

    const order: string[] = []
    let resolveQuiesce!: () => void
    const quiesceGate = new Promise<void>((r) => {
      resolveQuiesce = r
    })
    const { manager, callbacks } = await createHarness(store)
    manager.activeBlockInfo = { id: 'b-streaming', type: MessageBlockType.MAIN_TEXT }
    const smartSpy = vi.spyOn(manager, 'smartBlockUpdate')
    const origQuiesce = manager.quiesceWrites.bind(manager)
    vi.spyOn(manager, 'quiesceWrites').mockImplementation(async () => {
      order.push('quiesce-start')
      await origQuiesce()
      // Hold the gate open: while quiesce is suspended, nothing terminal may run.
      await quiesceGate
      order.push('quiesce-end')
    })
    const rawSave = mocks.updateMessageAndBlocks.getMockImplementation()
    void rawSave
    mocks.updateMessageAndBlocks.mockImplementationOnce(async () => {
      order.push('atomic')
      return { affectedFileIds: [], remainingReferenceCounts: {} } as any
    })

    const done = callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)
    // Let onComplete reach the suspended quiesce.
    await new Promise((r) => setTimeout(r, 20))
    // No terminal marking and no atomic commit while quiesce is suspended.
    expect(order).toEqual(['quiesce-start'])
    expect(mocks.updateMessageAndBlocks).not.toHaveBeenCalled()
    expect(smartSpy).not.toHaveBeenCalled()
    expect(store.getState().messageBlocks.entities['b-streaming']?.status).toBe(MessageBlockStatus.STREAMING)
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.PENDING)

    resolveQuiesce()
    await done
    expect(order).toEqual(['quiesce-start', 'quiesce-end', 'atomic'])
    expect(smartSpy).not.toHaveBeenCalled()
    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledTimes(1)
    // Post-commit Redux converges to SUCCESS (block first, then message).
    expect(store.getState().messageBlocks.entities['b-streaming']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.SUCCESS)
  })

  it('trailing STREAMING flushed during quiesce still commits target SUCCESS in the final payload', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-streaming'] })
    seedBlocks(store, [textBlock({ id: 'b-streaming', content: 'partial', status: MessageBlockStatus.STREAMING })])

    // Simulate the trailing throttled RAF: during quiesce it overwrites Redux
    // back to STREAMING with the last streaming content.
    const flushDuringQuiesce = vi.fn(() => {
      store.dispatch(
        messageBlocksSlice.actions.updateOneBlock({
          id: 'b-streaming',
          changes: { content: 'trailing streaming...', status: MessageBlockStatus.STREAMING }
        })
      )
    })
    const { manager, callbacks } = await createHarness(store, undefined, {
      flushThrottledBlockUpdate: flushDuringQuiesce,
      throttledBlockUpdate: vi.fn()
    })
    // Mark the block as touched via the throttled path so quiesce flushes it.
    manager.smartBlockUpdate('b-streaming', { content: 'partial' }, MessageBlockType.MAIN_TEXT)
    expect(store.getState().messageBlocks.entities['b-streaming']?.status).toBe(MessageBlockStatus.STREAMING)

    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)

    expect(flushDuringQuiesce).toHaveBeenCalledWith('b-streaming')
    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledTimes(1)
    const [, updates, blocks] = mocks.updateMessageAndBlocks.mock.calls[0] as unknown as [
      string,
      Record<string, any>,
      Array<Record<string, any>>
    ]
    // The committed payload forces the terminal target SUCCESS despite the
    // trailing STREAMING that quiesce just flushed.
    expect(blocks).toHaveLength(1)
    expect(blocks[0].id).toBe('b-streaming')
    expect(blocks[0].content).toBe('trailing streaming...')
    expect(blocks[0].status).toBe(MessageBlockStatus.SUCCESS)
    expect(updates.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(updates.blocks).toEqual(['b-streaming'])
    // Redux converges after the DB-first commit.
    expect(store.getState().messageBlocks.entities['b-streaming']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.SUCCESS)
  })

  it('atomic failure keeps both block and message non-success with no emit (never silently forks)', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-text'] })
    seedBlocks(store, [textBlock({ status: MessageBlockStatus.STREAMING, content: 'streaming...' })])
    mocks.updateMessageAndBlocks.mockRejectedValueOnce(new Error('db down'))

    const { manager, callbacks } = await createHarness(store)
    manager.activeBlockInfo = { id: 'b-text', type: MessageBlockType.MAIN_TEXT }
    const emitSpy = vi.spyOn(EventEmitter, 'emit')
    await expect(callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)).rejects.toThrow('db down')

    // No success claimed anywhere: block stays STREAMING, message stays
    // pending, no success event, no post-commit cleanup consumption.
    expect(store.getState().messageBlocks.entities['b-text']?.status).toBe(MessageBlockStatus.STREAMING)
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.PENDING)
    expect(emitSpy).not.toHaveBeenCalled()
    expect(mocks.consumeFileCleanupResult).not.toHaveBeenCalled()
    expect(loggerMocks.error).toHaveBeenCalled()
    emitSpy.mockRestore()
  })

  it('missing terminal target rejects fail-closed without dropping message.blocks references', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-text'] })
    seedBlocks(store, [textBlock({ status: MessageBlockStatus.STREAMING })])

    const { manager, callbacks } = await createHarness(store)
    // Ghost active block: not a member of message.blocks.
    manager.activeBlockInfo = { id: 'ghost-block', type: MessageBlockType.MAIN_TEXT }
    const emitSpy = vi.spyOn(EventEmitter, 'emit')
    await expect(callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)).rejects.toThrow()
    expect(mocks.updateMessageAndBlocks).not.toHaveBeenCalled()
    // References are preserved — never overwritten with a filtered list.
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.blocks).toEqual(['b-text'])
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.PENDING)
    expect(store.getState().messageBlocks.entities['b-text']?.status).toBe(MessageBlockStatus.STREAMING)
    expect(emitSpy).not.toHaveBeenCalled()
    expect(loggerMocks.error).toHaveBeenCalled()
    emitSpy.mockRestore()
  })

  it('referenced block entity missing rejects fail-closed without dropping message.blocks references', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-text', 'b-gone'] })
    seedBlocks(store, [textBlock({ status: MessageBlockStatus.STREAMING })])

    const { manager, callbacks } = await createHarness(store)
    manager.activeBlockInfo = { id: 'b-text', type: MessageBlockType.MAIN_TEXT }
    const emitSpy = vi.spyOn(EventEmitter, 'emit')
    await expect(callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)).rejects.toThrow()
    expect(mocks.updateMessageAndBlocks).not.toHaveBeenCalled()
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.blocks).toEqual(['b-text', 'b-gone'])
    expect(emitSpy).not.toHaveBeenCalled()
    emitSpy.mockRestore()
  })

  it('saveFinalMessageAndBlocksAtomically forwards the attempt and consumes cleanup; rethrows on failure', async () => {
    const { saveFinalMessageAndBlocksAtomically } = await import('../messageThunk')
    const cleanup = { affectedFileIds: ['f-1'], remainingReferenceCounts: { 'f-1': 0 } }

    mocks.updateMessageAndBlocks.mockResolvedValueOnce(cleanup)
    const result = await saveFinalMessageAndBlocksAtomically(
      TOPIC_ID,
      ASSISTANT_MSG_ID,
      { status: AssistantMessageStatus.SUCCESS } as any,
      [textBlock()],
      ATTEMPT
    )
    expect(result).toBe(cleanup)
    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledWith(
      TOPIC_ID,
      { id: ASSISTANT_MSG_ID, status: AssistantMessageStatus.SUCCESS },
      [expect.objectContaining({ id: 'b-text' })],
      [],
      ATTEMPT,
      null
    )
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledWith(cleanup)

    mocks.updateMessageAndBlocks.mockRejectedValueOnce(new Error('boom'))
    await expect(
      saveFinalMessageAndBlocksAtomically(TOPIC_ID, ASSISTANT_MSG_ID, { status: 'success' } as any, [], ATTEMPT)
    ).rejects.toThrow('boom')
    // Post-commit cleanup never runs when nothing committed.
    expect(mocks.consumeFileCleanupResult).toHaveBeenCalledTimes(1)
  })

  it('ordinary executions omit the attempt carrier', async () => {
    const { saveFinalMessageAndBlocksAtomically } = await import('../messageThunk')
    await saveFinalMessageAndBlocksAtomically(TOPIC_ID, ASSISTANT_MSG_ID, { status: 'success' } as any, [])
    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledWith(
      TOPIC_ID,
      { id: ASSISTANT_MSG_ID, status: 'success' },
      [],
      [],
      undefined,
      null
    )
  })
})

describe('Naming lifecycle: post-persist only', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateMessageAndBlocks.mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} })
    mocks.consumeFileCleanupResult.mockResolvedValue(undefined)
    mocks.getAssistantSettings.mockReturnValue({})
    mocks.computeContextInfo.mockReturnValue({ uiMessages: [] })
    mocks.autoRenameTopic.mockResolvedValue(undefined)
  })

  it('success: naming starts after final DB persist and loaded Redux final dispatch', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-text'] })
    seedBlocks(store, [textBlock({ status: MessageBlockStatus.STREAMING, content: 'streaming...' })])

    const order: string[] = []
    let reduxAtNaming: { block?: string; message?: string } = {}
    mocks.autoRenameTopic.mockImplementationOnce(async () => {
      order.push('naming')
      reduxAtNaming = {
        block: store.getState().messageBlocks.entities['b-text']?.status as unknown as string,
        message: store.getState().messages.entities[ASSISTANT_MSG_ID]?.status as unknown as string
      }
    })
    const saveFinal = async (mid: string, tid: string, mu: any, blocks: any[]) => {
      order.push('persist')
      const { saveFinalMessageAndBlocksAtomically } = await import('../messageThunk')
      return saveFinalMessageAndBlocksAtomically(tid, mid, mu, blocks, ATTEMPT)
    }

    const { manager, callbacks } = await createHarness(store, saveFinal)
    manager.activeBlockInfo = { id: 'b-text', type: MessageBlockType.MAIN_TEXT }
    const emitSpy = vi.spyOn(EventEmitter, 'emit')
    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)
    await new Promise((r) => setTimeout(r, 0))

    expect(order).toEqual(['persist', 'naming'])
    expect(mocks.autoRenameTopic).toHaveBeenCalledTimes(1)
    expect(mocks.autoRenameTopic).toHaveBeenCalledWith(assistantStub, TOPIC_ID, null)
    // Loaded Redux final update already dispatched before naming started.
    expect(reduxAtNaming.block).toBe(MessageBlockStatus.SUCCESS)
    expect(reduxAtNaming.message).toBe(AssistantMessageStatus.SUCCESS)
    expect(emitSpy).toHaveBeenCalledWith(EVENT_NAMES.MESSAGE_COMPLETE, {
      id: ASSISTANT_MSG_ID,
      topicId: TOPIC_ID,
      status: AssistantMessageStatus.SUCCESS
    })
    emitSpy.mockRestore()
  })

  it('success persist rejection never starts naming and never emits', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-text'] })
    seedBlocks(store, [textBlock({ status: MessageBlockStatus.STREAMING, content: 'streaming...' })])
    const saveFinal = vi.fn().mockRejectedValueOnce(new Error('db down'))

    const { manager, callbacks } = await createHarness(store, saveFinal)
    manager.activeBlockInfo = { id: 'b-text', type: MessageBlockType.MAIN_TEXT }
    const emitSpy = vi.spyOn(EventEmitter, 'emit')
    await expect(callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)).rejects.toThrow('db down')
    await new Promise((r) => setTimeout(r, 0))

    expect(saveFinal).toHaveBeenCalledTimes(1)
    expect(mocks.autoRenameTopic).not.toHaveBeenCalled()
    expect(emitSpy).not.toHaveBeenCalled()
    emitSpy.mockRestore()
  })

  it('non-success final never starts naming', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-text'] })
    seedBlocks(store, [textBlock({ status: MessageBlockStatus.STREAMING })])

    const { manager, callbacks } = await createHarness(store)
    manager.activeBlockInfo = { id: 'b-text', type: MessageBlockType.MAIN_TEXT }
    await callbacks.onComplete(AssistantMessageStatus.ERROR, successResponse)
    await new Promise((r) => setTimeout(r, 0))

    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledTimes(1)
    expect(mocks.autoRenameTopic).not.toHaveBeenCalled()
  })
})

describe('Detached execution: request-local state completes without Redux injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateMessageAndBlocks.mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} })
    mocks.consumeFileCleanupResult.mockResolvedValue(undefined)
    mocks.getAssistantSettings.mockReturnValue({})
    mocks.computeContextInfo.mockReturnValue({ uiMessages: [] })
    mocks.autoRenameTopic.mockResolvedValue(undefined)
  })

  const detachedSnapshot = () =>
    ({
      id: ASSISTANT_MSG_ID,
      assistantId: 'assistant-1',
      role: 'assistant',
      topicId: TOPIC_ID,
      blocks: [],
      status: AssistantMessageStatus.PENDING,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      askId: 'user-1'
    }) as unknown as Message

  async function createDetachedHarness(store: TestStore) {
    const { saveFinalMessageAndBlocksAtomically } = await import('../messageThunk')
    const executionState = new AssistantExecutionState(detachedSnapshot(), [])
    const manager = new BlockManager({
      dispatch: store.dispatch as any,
      getState: store.getState as any,
      saveUpdatedBlockToDB: vi.fn().mockResolvedValue(undefined),
      saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
      assistantMsgId: ASSISTANT_MSG_ID,
      topicId: TOPIC_ID,
      resendAttemptId: ATTEMPT,
      executionState,
      throttledBlockUpdate: vi.fn(),
      flushThrottledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    const callbacks = createCallbacks({
      blockManager: manager,
      dispatch: store.dispatch as any,
      getState: store.getState as any,
      topicId: TOPIC_ID,
      assistantMsgId: ASSISTANT_MSG_ID,
      saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
      saveFinalUpdatesAtomically: (mid: string, tid: string, mu: any, blocks: any[]) =>
        saveFinalMessageAndBlocksAtomically(tid, mid, mu, blocks, ATTEMPT),
      assistant: assistantStub,
      executionState
    })
    return { manager, callbacks, executionState }
  }

  it('detached success: text flow completes DB final with attempt, Redux stays absent without orphans', async () => {
    const store = createTestStore()
    storeHolder.current = store
    // Redux has no assistant message (window-outside semantic member).
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]).toBeUndefined()
    const { callbacks, executionState } = await createDetachedHarness(store)

    await callbacks.onLLMResponseCreated()
    await callbacks.onTextStart()
    await callbacks.onTextChunk('hello ')
    await callbacks.onTextChunk('hello world')
    await callbacks.onTextComplete('hello world')
    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)

    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledTimes(1)
    const [topicId, updates, blocks, deletes, attempt] = mocks.updateMessageAndBlocks.mock.calls[0] as unknown as [
      string,
      Record<string, any>,
      Array<Record<string, any>>,
      string[],
      string
    ]
    expect(topicId).toBe(TOPIC_ID)
    expect(updates.id).toBe(ASSISTANT_MSG_ID)
    expect(updates.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(attempt).toBe(ATTEMPT)
    expect(deletes).toEqual([])
    expect(blocks.length).toBeGreaterThan(0)
    expect(updates.blocks).toEqual(blocks.map((b) => b.id))
    expect(blocks[0].content).toBe('hello world')
    expect(blocks[0].status).toBe(MessageBlockStatus.SUCCESS)
    // Local execution fact converged.
    expect(executionState.getMessage().status).toBe(AssistantMessageStatus.SUCCESS)
    expect(executionState.getMissingBlockIds()).toEqual([])
    // Redux never injected: no message, no id, no orphan blocks.
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]).toBeUndefined()
    const ids = (store.getState().messages as any).messageIdsByTopic?.[TOPIC_ID] ?? []
    expect(ids).not.toContain(ASSISTANT_MSG_ID)
    const orphans = Object.values(store.getState().messageBlocks.entities).filter(
      (b: any) => b?.messageId === ASSISTANT_MSG_ID
    )
    expect(orphans).toEqual([])
  })

  it('detached onError: persists error/paused final with attempt, Redux stays absent', async () => {
    const store = createTestStore()
    storeHolder.current = store
    const { saveUpdatesToDB, saveUpdatedBlockToDB } = await import('../messageThunk')
    const executionState = new AssistantExecutionState(detachedSnapshot(), [])
    const saveUpdatesForExec = (mid: string, tid: string, mu: any, blocks: any[]) =>
      saveUpdatesToDB(mid, tid, mu, blocks, ATTEMPT)
    const saveSingleForExec = (bid: string | null, mid: string, tid: string, gs: any, _attempt?: string, local?: any) =>
      saveUpdatedBlockToDB(bid, mid, tid, gs, ATTEMPT, local ?? (bid ? executionState.getBlock(bid) : undefined))
    const manager = new BlockManager({
      dispatch: store.dispatch as any,
      getState: store.getState as any,
      saveUpdatedBlockToDB: saveSingleForExec as any,
      saveUpdatesToDB: saveUpdatesForExec as any,
      assistantMsgId: ASSISTANT_MSG_ID,
      topicId: TOPIC_ID,
      resendAttemptId: ATTEMPT,
      executionState,
      throttledBlockUpdate: vi.fn(),
      flushThrottledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    const callbacks = createCallbacks({
      blockManager: manager,
      dispatch: store.dispatch as any,
      getState: store.getState as any,
      topicId: TOPIC_ID,
      assistantMsgId: ASSISTANT_MSG_ID,
      saveUpdatesToDB: saveUpdatesForExec as any,
      saveFinalUpdatesAtomically: vi.fn().mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} }),
      assistant: assistantStub,
      executionState
    })

    await callbacks.onLLMResponseCreated()
    await callbacks.onTextStart()
    await callbacks.onTextChunk('partial')
    await callbacks.onError(new Error('boom-detached') as any)

    // Error/paused final persisted through the execution attempt carrier.
    expect(mocks.updateBlocks).toHaveBeenCalled()
    for (const call of mocks.updateBlocks.mock.calls) {
      expect((call as unknown[])[2]).toBe(ATTEMPT)
    }
    // Local execution fact carries the terminal error state (message + error block).
    expect(executionState.getMessage().status).toBe(AssistantMessageStatus.ERROR)
    expect(executionState.getBlockIds().length).toBeGreaterThanOrEqual(2)
    // Redux never injected.
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]).toBeUndefined()
    const orphans = Object.values(store.getState().messageBlocks.entities).filter(
      (b: any) => b?.messageId === ASSISTANT_MSG_ID
    )
    expect(orphans).toEqual([])
  })

  it('evicted mid-execution still completes local DB final without re-injection', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: ['b-evict'] })
    seedBlocks(store, [textBlock({ id: 'b-evict', content: 'partial', status: MessageBlockStatus.STREAMING })])
    const { saveFinalMessageAndBlocksAtomically } = await import('../messageThunk')
    const { createAssistantExecutionState } = await import('@renderer/services/messageStreaming/executionState')
    const executionState = createAssistantExecutionState(
      store.getState().messages.entities[ASSISTANT_MSG_ID],
      store.getState as any
    )
    const manager = new BlockManager({
      dispatch: store.dispatch as any,
      getState: store.getState as any,
      saveUpdatedBlockToDB: vi.fn().mockResolvedValue(undefined),
      saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
      assistantMsgId: ASSISTANT_MSG_ID,
      topicId: TOPIC_ID,
      resendAttemptId: ATTEMPT,
      executionState,
      throttledBlockUpdate: vi.fn(),
      flushThrottledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    const callbacks = createCallbacks({
      blockManager: manager,
      dispatch: store.dispatch as any,
      getState: store.getState as any,
      topicId: TOPIC_ID,
      assistantMsgId: ASSISTANT_MSG_ID,
      saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
      saveFinalUpdatesAtomically: (mid: string, tid: string, mu: any, blocks: any[]) =>
        saveFinalMessageAndBlocksAtomically(tid, mid, mu, blocks, ATTEMPT),
      assistant: assistantStub,
      executionState
    })
    manager.activeBlockInfo = { id: 'b-evict', type: MessageBlockType.MAIN_TEXT }
    // Evict the topic projection mid-generation (disposable removal only).
    store.dispatch(messagesSlice.actions.removeMessages({ topicId: TOPIC_ID, messageIds: [ASSISTANT_MSG_ID] }))
    store.dispatch(messageBlocksSlice.actions.removeManyBlocks(['b-evict']))
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]).toBeUndefined()

    // Local throttled chunk still advances the execution fact after eviction.
    manager.smartBlockUpdate('b-evict', { content: 'evicted partial' }, MessageBlockType.MAIN_TEXT)
    expect((executionState.getBlock('b-evict') as { content?: unknown })?.content).toBe('evicted partial')

    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, successResponse)

    expect(mocks.updateMessageAndBlocks).toHaveBeenCalledTimes(1)
    const [, updates, blocks, , attempt] = mocks.updateMessageAndBlocks.mock.calls[0] as unknown as [
      string,
      Record<string, any>,
      Array<Record<string, any>>,
      string[],
      string
    ]
    expect(updates.status).toBe(AssistantMessageStatus.SUCCESS)
    expect(blocks.map((b) => b.id)).toEqual(['b-evict'])
    expect(blocks[0].status).toBe(MessageBlockStatus.SUCCESS)
    expect(attempt).toBe(ATTEMPT)
    // No re-injection after eviction.
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]).toBeUndefined()
    expect(store.getState().messageBlocks.entities['b-evict']).toBeUndefined()
  })
})

describe('BlockManager local-first: transition + patch order/dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateMessageAndBlocks.mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} })
  })

  const mkBlock = (id: string, content: string): MessageBlock =>
    ({
      id,
      messageId: ASSISTANT_MSG_ID,
      type: MessageBlockType.MAIN_TEXT,
      content,
      status: MessageBlockStatus.STREAMING,
      createdAt: '2026-01-01T00:00:00.000Z'
    }) as MessageBlock

  it('detached transitions keep order/dedup locally without Redux injection; patches apply locally first', async () => {
    const store = createTestStore()
    storeHolder.current = store
    const saveUpdates = vi.fn().mockResolvedValue(undefined)
    const executionState = new AssistantExecutionState(
      {
        id: ASSISTANT_MSG_ID,
        assistantId: 'assistant-1',
        role: 'assistant',
        topicId: TOPIC_ID,
        blocks: [],
        status: AssistantMessageStatus.PENDING,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      } as unknown as Message,
      []
    )
    const dispatchSpy = vi.fn(store.dispatch as any)
    const manager = new BlockManager({
      dispatch: dispatchSpy as any,
      getState: store.getState as any,
      saveUpdatedBlockToDB: vi.fn().mockResolvedValue(undefined),
      saveUpdatesToDB: saveUpdates,
      assistantMsgId: ASSISTANT_MSG_ID,
      topicId: TOPIC_ID,
      resendAttemptId: ATTEMPT,
      executionState,
      throttledBlockUpdate: vi.fn(),
      flushThrottledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })

    await manager.handleBlockTransition(mkBlock('b1', 'one'), MessageBlockType.MAIN_TEXT)
    await manager.handleBlockTransition(mkBlock('b2', 'two'), MessageBlockType.MAIN_TEXT)
    // Duplicate transition dedups the ordered reference.
    await manager.handleBlockTransition(mkBlock('b1', 'one'), MessageBlockType.MAIN_TEXT)
    expect(executionState.getBlockIds()).toEqual(['b1', 'b2'])
    expect(saveUpdates).toHaveBeenCalledTimes(3)
    expect(saveUpdates.mock.calls[1][2]).toEqual({ blocks: ['b1', 'b2'] })
    expect(dispatchSpy).not.toHaveBeenCalled()

    // Throttled patch updates local fact immediately (DB mirror is throttled).
    manager.smartBlockUpdate('b1', { content: 'one-patched' }, MessageBlockType.MAIN_TEXT)
    expect((executionState.getBlock('b1') as { content?: unknown })?.content).toBe('one-patched')
    expect(executionState.getOrderedBlocks().map((b) => b.id)).toEqual(['b1', 'b2'])
  })

  it('loaded transitions mirror to Redux while keeping the same local order', async () => {
    const store = createTestStore()
    storeHolder.current = store
    seedMessage(store, { blocks: [] })
    const executionState = new AssistantExecutionState(store.getState().messages.entities[ASSISTANT_MSG_ID], [])
    const manager = new BlockManager({
      dispatch: store.dispatch as any,
      getState: store.getState as any,
      saveUpdatedBlockToDB: vi.fn().mockResolvedValue(undefined),
      saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
      assistantMsgId: ASSISTANT_MSG_ID,
      topicId: TOPIC_ID,
      executionState,
      throttledBlockUpdate: vi.fn(),
      flushThrottledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    await manager.handleBlockTransition(mkBlock('b-loaded', 'hi'), MessageBlockType.MAIN_TEXT)
    expect(executionState.getBlockIds()).toEqual(['b-loaded'])
    expect(store.getState().messages.entities[ASSISTANT_MSG_ID]?.blocks).toEqual(['b-loaded'])
    expect(store.getState().messageBlocks.entities['b-loaded']).toBeDefined()
  })
})
