/**
 * Focused tests for estimateHistoryTokens — verifies that the function
 * estimates tokens from the exact message set it receives, without
 * re-windowing or re-filtering.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock store for block selectors
// ---------------------------------------------------------------------------
const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: unknown) => mockStore.dispatch(action as never)
  }
}))

// Mock tokenx so tests are deterministic (1 char ≈ 1 token)
vi.mock('tokenx', () => ({
  approximateTokenSize: (text: string) => text.length
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeMsg = (
  id: string,
  role: Message['role'] = 'user',
  askId?: string,
  content = `content-${id}`,
  usage?: Message['usage']
): Message => {
  const blockId = `block-${id}`
  // Inject MAIN_TEXT block into mock store
  mockStore.dispatch(
    messageBlocksSlice.actions.upsertOneBlock({
      id: blockId,
      type: MessageBlockType.MAIN_TEXT,
      content,
      messageId: id
    } as any)
  )
  return {
    id,
    role,
    askId,
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-07-19T00:00:00.000Z',
    status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
    blocks: [blockId],
    usage
  } as Message
}

const makeAssistant = (prompt = 'system prompt'): Assistant =>
  ({ id: 'a1', prompt, settings: {} }) as unknown as Assistant

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('estimateHistoryTokens', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  it('estimates tokens over the exact messages passed — no internal re-windowing', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    // 5 messages passed; the function should estimate all 5, not slice/filter.
    const msgs = [makeMsg('m1'), makeMsg('m2'), makeMsg('m3'), makeMsg('m4'), makeMsg('m5')]
    const result = await estimateHistoryTokens(makeAssistant(), msgs)

    // Each message content "content-mN" = 10 chars → 10 tokens × 5 = 50
    // Messages joined with \n → 4 newlines = 4 extra chars
    // System prompt "system prompt" = 13 chars → 13 tokens
    // Total = 13 + 50 + 4 = 67
    expect(result).toBe(67)
  })

  it('uses usage-based aggregation for messages with usage data', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const msgWithUsage = makeMsg('u1', 'user', undefined, 'ignored', {
      total_tokens: 100,
      completion_tokens: 0
    } as any)
    const msgWithUsage2 = makeMsg('a1', 'assistant', 'u1', 'ignored', {
      total_tokens: 0,
      completion_tokens: 50
    } as any)

    const result = await estimateHistoryTokens(makeAssistant(), [msgWithUsage, msgWithUsage2])

    // user msg: inputTokens=100, outputTokens=0 → 100
    // assistant msg: inputTokens=0, outputTokens=50 → 50
    // usageTokens = 150
    // prompt "system prompt" = 13 tokens (no non-usage msgs → input = "")
    // Total = 13 + 150 = 163
    expect(result).toBe(163)
  })

  it('falls back to text estimation for messages without usage data', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const msgs = [makeMsg('m1', 'user', undefined, 'hello world')] // 11 chars

    const result = await estimateHistoryTokens(makeAssistant(), msgs)

    // prompt "system prompt" = 13 + content "hello world" = 11 → 24
    expect(result).toBe(24)
  })

  it('includes system prompt tokens in the estimate', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const msgs = [makeMsg('m1', 'user', undefined, 'hello')] // 5 chars

    const withPrompt = await estimateHistoryTokens(makeAssistant('system prompt'), msgs)
    const withoutPrompt = await estimateHistoryTokens(makeAssistant(''), msgs)

    // withPrompt includes "system prompt" (13 chars) extra
    expect(withPrompt).toBe(withoutPrompt + 13)
  })

  it('does NOT filter messages by type or content — caller is responsible', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    // A message with empty content should still be estimated (not filtered out)
    const msgs = [makeMsg('m1', 'user', undefined, '')]

    const result = await estimateHistoryTokens(makeAssistant(), msgs)

    // Only prompt tokens: "system prompt" = 13
    expect(result).toBe(13)
  })

  it('handles empty message list', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const result = await estimateHistoryTokens(makeAssistant(), [])

    // Only prompt tokens
    expect(result).toBe(13)
  })

  it('handles mixed usage and non-usage messages', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const withUsage = makeMsg('u1', 'user', undefined, 'ignored', {
      total_tokens: 200,
      completion_tokens: 0
    } as any)
    const without = makeMsg('m2', 'user', undefined, 'some text') // 9 chars
    const withUsage2 = makeMsg('a1', 'assistant', 'u1', 'ignored', {
      total_tokens: 0,
      completion_tokens: 30
    } as any)

    const result = await estimateHistoryTokens(makeAssistant(), [withUsage, without, withUsage2])

    // usageTokens: user=200, assistant=30 → 230
    // Text estimation for non-usage 'without': prompt(13) + "some text"(9) = 22
    // Total = 22 + 230 = 252
    expect(result).toBe(252)
  })
})
