import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { BlockManager } from '@renderer/services/messageStreaming/BlockManager'
import { createCallbacks } from '@renderer/services/messageStreaming/callbacks'
import { createStreamProcessor } from '@renderer/services/StreamProcessingService'
import type { AppDispatch } from '@renderer/store'
import type { RootState } from '@renderer/store'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { messagesSlice } from '@renderer/store/newMessage'
import type { Assistant, Model } from '@renderer/types'
import { ChunkType } from '@renderer/types/chunk'
import { AssistantMessageStatus, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { createThinkingBlock } from '@renderer/utils/messageUtils/create'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/NotificationService', () => ({
  NotificationService: { getInstance: vi.fn(() => ({ send: vi.fn() })) }
}))
vi.mock('@renderer/services/EventService', () => ({
  EventEmitter: { emit: vi.fn(), on: vi.fn() },
  EVENT_NAMES: { MESSAGE_COMPLETE: 'MESSAGE_COMPLETE', SEND_MESSAGE: 'SEND_MESSAGE' }
}))
vi.mock('@renderer/utils/window', () => ({ isOnHomePage: vi.fn(() => true), isFocused: vi.fn(() => true) }))
vi.mock('@renderer/hooks/useTopic', () => ({ autoRenameTopic: vi.fn() }))
vi.mock('@renderer/services/AssistantService', () => ({ getAssistantSettings: vi.fn(() => ({})) }))
vi.mock('@renderer/services/contextInfoService', () => ({ computeContextInfo: vi.fn(() => ({ uiMessages: [] })) }))
vi.mock('@renderer/services/TokenService', () => ({
  estimateMessagesUsage: vi.fn(() => Promise.resolve({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }))
}))

const reducer = combineReducers({
  messages: messagesSlice.reducer,
  messageBlocks: messageBlocksSlice.reducer,
  topics: (state: any = { entities: {} }) => state
})

describe('reasoning fallback integration: normal completion must not leave STREAMING thinking', () => {
  const mockTopicId = 't-reason-fb'
  const mockAssistantMsgId = 'm-reason-fb'
  const mockAssistant: Assistant = {
    id: 'a1',
    name: 'Test',
    model: { id: 'm', name: 'M' } as Model,
    prompt: '',
    enableWebSearch: false,
    enableGenerateImage: false,
    knowledge_bases: [],
    topics: [],
    type: 'test'
  } as unknown as Assistant

  let store: ReturnType<typeof configureStore>
  let dispatch: AppDispatch
  let getState: () => ReturnType<typeof reducer> & RootState

  beforeEach(() => {
    vi.clearAllMocks()
    store = configureStore({ reducer, middleware: (gDM) => gDM({ serializableCheck: false }) })
    dispatch = store.dispatch as unknown as AppDispatch
    getState = store.getState as any
    store.dispatch(
      messagesSlice.actions.addMessage({
        topicId: mockTopicId,
        message: {
          id: mockAssistantMsgId,
          assistantId: mockAssistant.id,
          role: 'assistant',
          topicId: mockTopicId,
          blocks: [],
          status: AssistantMessageStatus.PENDING,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as any
      })
    )
  })

  function createHarness() {
    const blockManager = new BlockManager({
      dispatch: dispatch as any,
      getState: getState as any,
      saveUpdatedBlockToDB: vi.fn().mockResolvedValue(undefined),
      saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
      assistantMsgId: mockAssistantMsgId,
      topicId: mockTopicId,
      throttledBlockUpdate: vi.fn(),
      cancelThrottledBlockUpdate: vi.fn()
    })
    const callbacks = createCallbacks({
      blockManager,
      dispatch: dispatch as any,
      getState: getState as any,
      topicId: mockTopicId,
      assistantMsgId: mockAssistantMsgId,
      saveUpdatesToDB: vi.fn().mockResolvedValue(undefined),
      saveFinalUpdatesAtomically: vi.fn().mockResolvedValue({ affectedFileIds: [], remainingReferenceCounts: {} }),
      assistant: mockAssistant
    })
    const processor = createStreamProcessor(callbacks)
    return { blockManager, callbacks, processor }
  }

  it('reasoning-start + deltas then finish without reasoning-end should end with SUCCESS thinking and reasonable millsec', async () => {
    const { processor, callbacks } = createHarness()
    // Simulate adapter output: THINKING_START, DELTAs, then directly BLOCK_COMPLETE (no THINKING_COMPLETE)
    // This mimics provider that misses reasoning-end and adapter fallback missed (or we test baseCallbacks fallback)
    processor({ type: ChunkType.LLM_RESPONSE_CREATED })
    processor({ type: ChunkType.THINKING_START })
    processor({ type: ChunkType.THINKING_DELTA, text: 'let me think' })
    processor({ type: ChunkType.THINKING_DELTA, text: 'let me think more' })
    // no THINKING_COMPLETE, no TEXT_START, directly complete
    // need to wait a bit for thinking_millsec to be >0
    await new Promise((r) => setTimeout(r, 15))
    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      metrics: { completion_tokens: 5, time_completion_millsec: 100 }
    } as any)

    const state = getState()
    const blocks = Object.values(state.messageBlocks.entities) as any[]
    const thinking = blocks.find((b) => b.type === MessageBlockType.THINKING)
    expect(thinking).toBeDefined()
    expect(thinking.status).toBe(MessageBlockStatus.SUCCESS)
    expect(thinking.thinking_millsec).toBeDefined()
    expect(typeof thinking.thinking_millsec).toBe('number')
    expect(thinking.thinking_millsec).toBeGreaterThan(0)
    // invariant: no STREAMING thinking remains
    expect(
      blocks.filter((b) => b.type === MessageBlockType.THINKING && b.status === MessageBlockStatus.STREAMING)
    ).toHaveLength(0)
  })

  it('thinking + text without explicit thinking complete should converge both to SUCCESS via adapter fallback + baseCallbacks', async () => {
    const { processor, callbacks } = createHarness()
    processor({ type: ChunkType.LLM_RESPONSE_CREATED })
    processor({ type: ChunkType.THINKING_START })
    processor({ type: ChunkType.THINKING_DELTA, text: 'thinking content' })
    processor({ type: ChunkType.THINKING_COMPLETE, text: 'thinking content' })
    processor({ type: ChunkType.TEXT_START })
    processor({ type: ChunkType.TEXT_DELTA, text: 'answer' })
    processor({ type: ChunkType.TEXT_COMPLETE, text: 'answer' })
    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      metrics: { completion_tokens: 5, time_completion_millsec: 100 }
    } as any)

    const blocks = Object.values(getState().messageBlocks.entities) as any[]
    expect(blocks.filter((b) => b.status === MessageBlockStatus.STREAMING)).toHaveLength(0)
    expect(blocks.find((b) => b.type === MessageBlockType.THINKING)?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(blocks.find((b) => b.type === MessageBlockType.MAIN_TEXT)?.status).toBe(MessageBlockStatus.SUCCESS)
  })

  it('legacy STREAMING thinking with 0 and no trusted clock keeps 0 (no fake elapsed)', async () => {
    const { callbacks, blockManager } = createHarness()
    // Inject a legacy thinking block directly via BlockManager, bypassing thinkingCallbacks clock
    // so getCurrentThinkingInfo remains { blockId: null, millsec: 0 } (no trusted info)
    const legacyBlock = createThinkingBlock(mockAssistantMsgId, 'legacy thinking', {
      status: MessageBlockStatus.STREAMING,
      thinking_millsec: 0
    })
    // need an initial placeholder to allow thinking transition; first create LLM_RESPONSE_CREATED
    const processor = createStreamProcessor(callbacks)
    processor({ type: ChunkType.LLM_RESPONSE_CREATED })
    await blockManager.handleBlockTransition(legacyBlock as any, MessageBlockType.THINKING)
    // wait to ensure Date.now() - startTime would be >0 if fake logic were still present
    await new Promise((r) => setTimeout(r, 25))
    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      metrics: { completion_tokens: 5, time_completion_millsec: 100 }
    } as any)

    const blocks = Object.values(getState().messageBlocks.entities) as any[]
    const thinking = blocks.find((b) => b.type === MessageBlockType.THINKING)
    expect(thinking).toBeDefined()
    expect(thinking.status).toBe(MessageBlockStatus.SUCCESS)
    // must not fabricate thinking duration from whole-response elapsed; keep 0
    expect(thinking.thinking_millsec).toBe(0)
    expect(
      blocks.filter((b) => b.type === MessageBlockType.THINKING && b.status === MessageBlockStatus.STREAMING)
    ).toHaveLength(0)
  })

  it('legacy STREAMING thinking with existing non-zero millsec keeps existing value when no trusted clock', async () => {
    const { callbacks, blockManager } = createHarness()
    const existingMillsec = 1234
    const legacyBlock = createThinkingBlock(mockAssistantMsgId, 'legacy thinking', {
      status: MessageBlockStatus.STREAMING,
      thinking_millsec: existingMillsec
    })
    const processor = createStreamProcessor(callbacks)
    processor({ type: ChunkType.LLM_RESPONSE_CREATED })
    await blockManager.handleBlockTransition(legacyBlock as any, MessageBlockType.THINKING)
    await new Promise((r) => setTimeout(r, 15))
    await callbacks.onComplete(AssistantMessageStatus.SUCCESS, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      metrics: { completion_tokens: 5, time_completion_millsec: 100 }
    } as any)

    const blocks = Object.values(getState().messageBlocks.entities) as any[]
    const thinking = blocks.find((b) => b.type === MessageBlockType.THINKING)
    expect(thinking.thinking_millsec).toBe(existingMillsec)
    expect(thinking.status).toBe(MessageBlockStatus.SUCCESS)
  })
})
