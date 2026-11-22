/**
 * Terminal join: every execution waits for its triggered terminal
 * before disposing scheduler ownership; abort/error flush trailing writes and
 * quiesce DB pending before the terminal persist; channel assembly and process
 * failures close out through the same error terminal without dropping text.
 *
 * These tests drive the real call chain — dispatcher (`createStreamProcessor`)
 * into the composed callbacks (`createCallbacks`), `BlockManager`, a real
 * `WriteBarrier` and a real `StreamWriteScheduler` — and assert observable
 * behavior (persist order, projection content, disposal timing), never
 * internal counters or implementation details.
 */

import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { AssistantExecutionState } from '@renderer/services/messageStreaming/executionState'
import { liveSchedulerCount, StreamWriteScheduler } from '@renderer/services/messageStreaming/streamWriteScheduler'
import { WriteBarrier } from '@renderer/services/messageStreaming/writeBarrier'
import { createStreamProcessor } from '@renderer/services/StreamProcessingService'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { messagesSlice } from '@renderer/store/newMessage'
import { ChunkType } from '@renderer/types/chunk'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks (same surface the terminal paths touch) --------------------------

const { mocks, loggerMocks, storeHolder } = vi.hoisted(() => ({
  mocks: {
    updateMessageAndBlocks: vi.fn(),
    consumeFileCleanupResult: vi.fn(),
    getAssistantSettings: vi.fn(),
    computeContextInfo: vi.fn(),
    autoRenameTopic: vi.fn(),
    appendMessage: vi.fn(),
    notificationSend: vi.fn()
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
    updateMessage: vi.fn(),
    updateMessageAndBlocks: mocks.updateMessageAndBlocks,
    updateBlocks: vi.fn(),
    updateSingleBlock: vi.fn(),
    appendMessage: mocks.appendMessage
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
    getInstance: vi.fn(() => ({ send: mocks.notificationSend }))
  }
}))

vi.mock('@renderer/utils/window', () => ({
  isOnHomePage: vi.fn(() => true),
  isFocused: vi.fn(() => true)
}))

vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({
  AiSdkToChunkAdapter: vi.fn(() => ({
    processStream: vi.fn().mockResolvedValue(undefined)
  }))
}))

// --- Store + RAF control -----------------------------------------------------

const reducer = combineReducers({
  messages: messagesSlice.reducer,
  messageBlocks: messageBlocksSlice.reducer
})

type TestStore = ReturnType<typeof createTestStore>
const createTestStore = () =>
  configureStore({ reducer, middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false }) })

const TOPIC_ID = 'topic-terminal-join'
const ASSISTANT_MSG_ID = 'assistant-terminal-join'

const pendingRafs = new Map<number, FrameRequestCallback>()
let rafSeq = 0

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const assistantStub = { id: 'assistant-1', settings: {}, topics: [], model: { id: 'm', provider: 'openai' } } as never

const successResponse = {
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  metrics: { completion_tokens: 5, time_completion_millsec: 100 }
} as { usage: any; metrics: any }

interface Harness {
  store: TestStore
  manager: BlockManager
  callbacks: ReturnType<typeof createCallbacks>
  dispatchChunk: (chunk: any) => void
  scheduler: StreamWriteScheduler
  barrier: WriteBarrier
  events: string[]
  mirrors: string[]
  releaseFinal: () => void
  saveFinal: ReturnType<typeof vi.fn>
  saveUpdatesTransition: ReturnType<typeof vi.fn>
  saveUpdatesFinal: ReturnType<typeof vi.fn>
}

async function createHarness(opts: { deferTerminalPersist?: boolean } = {}): Promise<Harness> {
  const store = createTestStore()
  storeHolder.current = store
  const message = {
    id: ASSISTANT_MSG_ID,
    assistantId: 'assistant-1',
    role: 'assistant',
    topicId: TOPIC_ID,
    blocks: [],
    status: AssistantMessageStatus.PENDING,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    askId: 'user-1'
  } as unknown as Message
  store.dispatch(messagesSlice.actions.addMessage({ topicId: TOPIC_ID, message }))

  const events: string[] = []
  const mirrors: string[] = []
  const barrier = new WriteBarrier()
  let finalGateResolve: (() => void) | null = null
  const finalGate = opts.deferTerminalPersist ? new Promise<void>((r) => (finalGateResolve = r)) : null

  const scheduler = new StreamWriteScheduler({
    throttleMs: 50,
    barrier,
    topicId: TOPIC_ID,
    branchId: null,
    isLoaded: () => {
      try {
        return !!store.getState().messages.entities[ASSISTANT_MSG_ID]
      } catch {
        return false
      }
    },
    performWrite: (_id, update) => {
      events.push(`write:${String(update?.content ?? '')}`)
      return Promise.resolve()
    },
    mirrorToRedux: (id, update) => {
      mirrors.push(`mirror:${id}:${String(update?.content ?? '')}`)
      store.dispatch(messageBlocksSlice.actions.updateOneBlock({ id, changes: update }))
    }
  })
  const origDispose = scheduler.dispose.bind(scheduler)
  scheduler.dispose = () => {
    events.push('disposed')
    origDispose()
  }

  const executionState = new AssistantExecutionState(message, [])
  // BlockManager-scoped streaming saves (transitions, immediate marks):
  // always immediate so quiescence only waits on real DB latency.
  const saveUpdatedBlockToDB = vi.fn().mockImplementation(async () => {
    events.push('immediate-save')
  })
  const saveUpdatesTransition = vi.fn().mockImplementation(async () => {
    events.push('transition-save')
  })
  // Terminal-final saves (error-final via callbacks, success-final via
  // saveFinal below): deferred under test gating to prove the owner join.
  const saveUpdatesFinal = vi.fn().mockImplementation(async () => {
    events.push('error-final-save')
    if (finalGate) {
      await finalGate
    }
  })
  const manager = new BlockManager({
    dispatch: store.dispatch as any,
    getState: store.getState as any,
    saveUpdatedBlockToDB,
    saveUpdatesToDB: saveUpdatesTransition,
    assistantMsgId: ASSISTANT_MSG_ID,
    topicId: TOPIC_ID,
    barrier,
    executionState,
    throttledBlockUpdate: (
      id: string,
      blockUpdate: any,
      _attemptId?: string,
      trackBarrier?: WriteBarrier,
      shouldMirror?: () => boolean
    ) => scheduler.schedule(id, blockUpdate, { barrier: trackBarrier, shouldMirrorToRedux: shouldMirror }),
    flushThrottledBlockUpdate: (id: string) => scheduler.flush(id),
    cancelThrottledBlockUpdate: (id: string) => scheduler.cancel(id),
    drainMirrors: () => scheduler.drainMirrors()
  })
  const saveFinal = vi.fn().mockImplementation(async () => {
    events.push('final-start')
    if (finalGate) {
      await finalGate
    }
    events.push('final-end')
    return { affectedFileIds: [], remainingReferenceCounts: {} }
  })
  const callbacks = createCallbacks({
    blockManager: manager,
    dispatch: store.dispatch as any,
    getState: store.getState as any,
    topicId: TOPIC_ID,
    assistantMsgId: ASSISTANT_MSG_ID,
    requestRoute: null,
    saveUpdatesToDB: saveUpdatesFinal,
    saveFinalUpdatesAtomically: saveFinal,
    assistant: assistantStub,
    executionState
  })
  const dispatchChunk = createStreamProcessor(callbacks as any)
  return {
    store,
    manager,
    callbacks,
    dispatchChunk,
    scheduler,
    barrier,
    events,
    mirrors,
    releaseFinal: () => finalGateResolve?.(),
    saveFinal,
    saveUpdatesTransition,
    saveUpdatesFinal
  }
}

async function streamTwoChunks(dispatchChunk: (chunk: any) => void) {
  dispatchChunk({ type: ChunkType.LLM_RESPONSE_CREATED })
  dispatchChunk({ type: ChunkType.TEXT_START })
  await tick(10)
  dispatchChunk({ type: ChunkType.TEXT_DELTA, text: 'hello-part-1' })
  dispatchChunk({ type: ChunkType.TEXT_DELTA, text: 'hello-part-1-part-2' })
}

describe('Terminal join: owner waits for the triggered terminal before dispose', () => {
  const owned: StreamWriteScheduler[] = []

  beforeEach(() => {
    owned.length = 0
    pendingRafs.clear()
    rafSeq = 0
    vi.clearAllMocks()
    mocks.getAssistantSettings.mockReturnValue({})
    mocks.computeContextInfo.mockReturnValue({ uiMessages: [] })
    mocks.autoRenameTopic.mockResolvedValue(undefined)
    mocks.notificationSend.mockResolvedValue(undefined)
    mocks.appendMessage.mockImplementation(() => new Promise(() => {}))
    mocks.consumeFileCleanupResult.mockResolvedValue(undefined)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafSeq += 1
        pendingRafs.set(rafSeq, cb)
        return rafSeq
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        pendingRafs.delete(id)
      })
    )
  })

  afterEach(() => {
    for (const scheduler of owned) {
      scheduler.dispose()
    }
    owned.length = 0
    vi.unstubAllGlobals()
  })

  it('success: provider resolve does not dispose before the deferred final persist lands', async () => {
    const h = await createHarness({ deferTerminalPersist: true })
    owned.push(h.scheduler)
    await streamTwoChunks(h.dispatchChunk)

    h.dispatchChunk({ type: ChunkType.BLOCK_COMPLETE, response: successResponse })

    // The terminal is registered synchronously in the dispatch tick: quiesce
    // already flushed the trailing write before the first await.
    await vi.waitFor(() => expect(h.saveFinal).toHaveBeenCalledTimes(1))
    expect(h.events).toContain('write:hello-part-1-part-2')

    // Simulate the SSE owner: provider resolved, finally joins the terminal.
    let ownerSettled = false
    const owner = (async () => {
      await Promise.resolve()
      await h.manager.awaitTerminal()
      h.scheduler.dispose()
      ownerSettled = true
    })()
    await tick(20)
    expect(ownerSettled).toBe(false)
    expect(h.scheduler.isDisposed).toBe(false)
    expect(h.events).not.toContain('final-end')

    h.releaseFinal()
    await owner
    expect(ownerSettled).toBe(true)
    expect(h.events).toContain('final-end')
    expect(h.events).toContain('disposed')

    const trailingIdx = h.events.indexOf('write:hello-part-1-part-2')
    const finalIdx = h.events.indexOf('final-end')
    const disposedIdx = h.events.indexOf('disposed')
    expect(trailingIdx).toBeGreaterThanOrEqual(0)
    expect(trailingIdx).toBeLessThan(finalIdx)
    expect(finalIdx).toBeLessThan(disposedIdx)

    // Projection completeness: the terminal mirror publishes the full text
    // even though no RAF ever fired and dispose cancels RAF.
    expect(h.mirrors.some((m) => m.endsWith(':hello-part-1-part-2'))).toBe(true)
    expect(h.store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.SUCCESS)
  })

  it('error: pending trailing is flushed and the error terminal persists before owner dispose', async () => {
    const h = await createHarness({ deferTerminalPersist: true })
    owned.push(h.scheduler)
    await streamTwoChunks(h.dispatchChunk)

    h.dispatchChunk({ type: ChunkType.ERROR, error: new Error('provider boom') })
    await vi.waitFor(() => expect(h.saveUpdatesFinal).toHaveBeenCalled())

    let ownerSettled = false
    const owner = (async () => {
      await Promise.resolve()
      await h.manager.awaitTerminal()
      h.scheduler.dispose()
      ownerSettled = true
    })()
    await tick(20)
    expect(ownerSettled).toBe(false)
    expect(h.scheduler.isDisposed).toBe(false)

    h.releaseFinal()
    await owner
    expect(ownerSettled).toBe(true)

    // Trailing content reached the DB before the terminal persist and dispose.
    expect(h.events).toContain('write:hello-part-1-part-2')
    const trailingIdx = h.events.indexOf('write:hello-part-1-part-2')
    const terminalIdx = h.events.indexOf('error-final-save')
    const disposedIdx = h.events.indexOf('disposed')
    expect(terminalIdx).toBeGreaterThanOrEqual(0)
    expect(trailingIdx).toBeLessThan(terminalIdx)
    expect(terminalIdx).toBeLessThan(disposedIdx)

    // The error path keeps the streamed text and marks the terminal state.
    expect(h.store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.ERROR)
    const errorBlocks = Object.values(h.store.getState().messageBlocks.entities).filter(
      (b) => b?.type === MessageBlockType.ERROR
    )
    expect(errorBlocks.length).toBe(1)
    expect(h.mirrors.some((m) => m.endsWith(':hello-part-1-part-2'))).toBe(true)
  })

  it('abort: same join with pause semantics, no dropped tail', async () => {
    const h = await createHarness({ deferTerminalPersist: true })
    owned.push(h.scheduler)
    await streamTwoChunks(h.dispatchChunk)

    h.dispatchChunk({ type: ChunkType.ERROR, error: new DOMException('Request was aborted.', 'AbortError') })
    await vi.waitFor(() => expect(h.saveUpdatesFinal).toHaveBeenCalled())

    let ownerSettled = false
    const owner = (async () => {
      await Promise.resolve()
      await h.manager.awaitTerminal()
      h.scheduler.dispose()
      ownerSettled = true
    })()
    await tick(20)
    expect(ownerSettled).toBe(false)

    h.releaseFinal()
    await owner
    expect(ownerSettled).toBe(true)

    expect(h.events).toContain('write:hello-part-1-part-2')
    const trailingIdx = h.events.indexOf('write:hello-part-1-part-2')
    const terminalIdx = h.events.indexOf('error-final-save')
    const disposedIdx = h.events.indexOf('disposed')
    expect(trailingIdx).toBeLessThan(terminalIdx)
    expect(terminalIdx).toBeLessThan(disposedIdx)

    expect(h.store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.SUCCESS)
    const paused = Object.values(h.store.getState().messageBlocks.entities).filter(
      (b) => b?.status === MessageBlockStatus.PAUSED
    )
    expect(paused.length).toBeGreaterThan(0)
  })

  it('a trailing error after success does not publish or persist twice', async () => {
    const h = await createHarness()
    owned.push(h.scheduler)
    await streamTwoChunks(h.dispatchChunk)

    h.dispatchChunk({ type: ChunkType.BLOCK_COMPLETE, response: successResponse })
    await vi.waitFor(() => expect(h.saveFinal).toHaveBeenCalledTimes(1))
    await h.manager.awaitTerminal()
    const transitionCalls = h.saveUpdatesTransition.mock.calls.length

    h.dispatchChunk({ type: ChunkType.ERROR, error: new Error('late trailing failure') })
    await tick(20)

    expect(h.saveFinal).toHaveBeenCalledTimes(1)
    expect(h.saveUpdatesFinal).not.toHaveBeenCalled()
    expect(h.saveUpdatesTransition.mock.calls.length).toBe(transitionCalls)
    expect(h.store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.SUCCESS)
  })

  it('channel-style process rejection enters the error terminal, keeps text, and dispose joins it', async () => {
    const h = await createHarness()
    owned.push(h.scheduler)
    await streamTwoChunks(h.dispatchChunk)

    const channelError = new Error('channel socket broke')
    const events: string[] = []
    // Same shape as the channel tail: log (existing contract), route the
    // rejection into the error terminal, then join before dispose.
    await Promise.reject(channelError)
      .catch((err: unknown) => {
        events.push('logged')
        try {
          ;(h.callbacks.onError as (error: unknown) => unknown)?.(err)
        } catch {
          events.push('callback-threw')
        }
      })
      .finally(async () => {
        await h.manager.awaitTerminal()
        h.scheduler.dispose()
        events.push('loading-false')
      })

    expect(events).toContain('logged')
    expect(events).not.toContain('callback-threw')
    // Terminal persist ran (text kept) before dispose and loading reset.
    expect(h.events).toContain('write:hello-part-1-part-2')
    expect(h.saveUpdatesFinal).toHaveBeenCalled()
    const trailingIdx = h.events.indexOf('write:hello-part-1-part-2')
    const terminalIdx = h.events.indexOf('error-final-save')
    const disposedIdx = h.events.indexOf('disposed')
    expect(trailingIdx).toBeLessThan(terminalIdx)
    expect(terminalIdx).toBeLessThan(disposedIdx)
    expect(events.indexOf('loading-false')).toBeGreaterThanOrEqual(0)
    expect(h.store.getState().messages.entities[ASSISTANT_MSG_ID]?.status).toBe(AssistantMessageStatus.ERROR)
  })

  it('channel assembly sync throw cleans scheduler ownership, resets loading, preserves the error', async () => {
    const { setupChannelStream } = await import('../../../store/thunk/messageThunk')
    const { AiSdkToChunkAdapter } = await import('@renderer/aiCore/chunk/AiSdkToChunkAdapter')
    const store = createTestStore()
    storeHolder.current = store
    const seen: any[] = []
    const dispatch = ((action: any) => {
      seen.push(action)
      return (store.dispatch as any)(action)
    }) as any

    const liveBefore = liveSchedulerCount()
    const assemblyError = new Error('assembly boom')
    vi.mocked(AiSdkToChunkAdapter).mockImplementationOnce(() => {
      throw assemblyError
    })

    let caught: unknown = null
    try {
      setupChannelStream(dispatch, store.getState as any, TOPIC_ID, 'agent-1')
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(assemblyError)
    expect(liveSchedulerCount()).toBe(liveBefore)
    const loadingFlags = seen.filter((a) => typeof a?.type === 'string' && a.type.includes('setTopicLoading'))
    expect(loadingFlags.length).toBeGreaterThan(0)
    expect(loadingFlags[loadingFlags.length - 1].payload).toMatchObject({ topicId: TOPIC_ID, loading: false })
  })
})
