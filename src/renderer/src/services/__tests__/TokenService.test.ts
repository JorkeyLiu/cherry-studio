/**
 * Focused tests for estimateHistoryTokens — verifies that the function
 * estimates all messages from content (LOCK-003), ignoring historical
 * usage fields as baselines or additive request totals.
 *
 * Estimation strategy:
 *   1. For each message, estimate content tokens via estimateMessageUsage
 *   2. Add assistant system prompt tokens
 *   3. No usage.total_tokens baseline — content is always authoritative
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
  estimateTokenCount: (text: string) => text.length
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

// Content-based token cost helper:
// estimateMessageUsage: [content, reasoningContent].filter(s => s !== undefined).join(' ')
// For messages without THINKING blocks: reasoningContent = '' → content + ' ' = content.length + 1
// For messages with THINKING blocks: content + ' ' + thinkingContent = content.length + 1 + thinkingContent.length
// System prompt: estimateTextTokens(prompt) = prompt.length
const msgTokens = (content: string) => content.length + 1
const promptTokens = (prompt: string) => prompt.length

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('estimateHistoryTokens', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  // ── Content-based estimation (LOCK-003) ──────────────────────────────────

  it('estimates all messages from content — no usage baseline', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    // 3-turn conversation: usage fields are set but ignored
    const u1 = makeMsg('u1', 'user', undefined, 'Hello')
    const a1 = makeMsg('a1', 'assistant', 'u1', 'ignored', {
      total_tokens: 200,
      completion_tokens: 50,
      prompt_tokens: 150
    } as any)
    const u2 = makeMsg('u2', 'user', undefined, 'What is X?')
    const a2 = makeMsg('a2', 'assistant', 'u2', 'ignored', {
      total_tokens: 350,
      completion_tokens: 80,
      prompt_tokens: 270
    } as any)
    const u3 = makeMsg('u3', 'user', undefined, 'Tell me more')
    const a3 = makeMsg('a3', 'assistant', 'u3', 'ignored', {
      total_tokens: 500,
      completion_tokens: 100,
      prompt_tokens: 400
    } as any)

    const result = await estimateHistoryTokens(makeAssistant(), [u1, a1, u2, a2, u3, a3])

    // Content-based: each message estimated from its block content, not usage
    // prompt(13) + u1(6) + a1(8) + u2(11) + a2(8) + u3(13) + a3(8) = 67
    const expected =
      promptTokens('system prompt') +
      msgTokens('Hello') +
      msgTokens('ignored') +
      msgTokens('What is X?') +
      msgTokens('ignored') +
      msgTokens('Tell me more') +
      msgTokens('ignored')
    expect(result).toBe(expected)
    expect(result).toBe(67)
    // NOT 500 (latest assistant total_tokens baseline — old broken behavior)
  })

  it('different message sets yield different estimates even with same assistant usage', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    // Key acceptance criterion: two windows with same latest assistant but different
    // selected earlier turns must yield different content estimates.
    const a2 = makeMsg('a2', 'assistant', 'u2', 'same', {
      total_tokens: 300,
      completion_tokens: 50,
      prompt_tokens: 250
    } as any)

    // Window A: short earlier messages
    const uA = makeMsg('uA', 'user', undefined, 'A')
    const resultA = await estimateHistoryTokens(makeAssistant(), [uA, a2])

    // Window B: long earlier messages
    const uB = makeMsg('uB', 'user', undefined, 'A much longer question with many words')
    const resultB = await estimateHistoryTokens(makeAssistant(), [uB, a2])

    // Both have same latest assistant usage, but different content → different estimates
    expect(resultA).not.toBe(resultB)
    expect(resultB).toBeGreaterThan(resultA)
  })

  it('usage fields are completely ignored — content-only estimation', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    // Message with massive usage values — should still estimate from content
    const msg = makeMsg('m1', 'user', undefined, 'short', {
      total_tokens: 99999,
      completion_tokens: 99999,
      prompt_tokens: 99999
    } as any)

    const result = await estimateHistoryTokens(makeAssistant(), [msg])

    // prompt(13) + "short"(6) = 19, NOT 99999 + 13
    expect(result).toBe(promptTokens('system prompt') + msgTokens('short'))
    expect(result).toBe(19)
  })

  it('each message contributes its content tokens independently', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const u1 = makeMsg('u1', 'user', undefined, 'Hello')
    const a1 = makeMsg('a1', 'assistant', 'u1', 'ignored')
    const u2 = makeMsg('u2', 'user', undefined, 'New question')

    const result = await estimateHistoryTokens(makeAssistant(), [u1, a1, u2])

    // prompt(13) + u1("Hello"→6) + a1("ignored"→8) + u2("New question"→13) = 40
    const expected =
      promptTokens('system prompt') + msgTokens('Hello') + msgTokens('ignored') + msgTokens('New question')
    expect(result).toBe(expected)
  })

  it('trailing assistant is included in content estimation', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const u1 = makeMsg('u1', 'user', undefined, 'Hello')
    const a1 = makeMsg('a1', 'assistant', 'u1', 'ignored')
    const u2 = makeMsg('u2', 'user', undefined, 'Follow up')
    const a2 = makeMsg('a2', 'assistant', 'u2', 'ignored')

    // With trailing assistant a2
    const withTrailing = await estimateHistoryTokens(makeAssistant(), [u1, a1, u2, a2])
    // prompt(13) + u1(6) + a1(8) + u2(10) + a2(8) = 45
    const expectedWith =
      promptTokens('system prompt') +
      msgTokens('Hello') +
      msgTokens('ignored') +
      msgTokens('Follow up') +
      msgTokens('ignored')
    expect(withTrailing).toBe(expectedWith)

    // Without trailing assistant
    const withoutTrailing = await estimateHistoryTokens(makeAssistant(), [u1, a1, u2])
    const expectedWithout =
      promptTokens('system prompt') + msgTokens('Hello') + msgTokens('ignored') + msgTokens('Follow up')
    expect(withoutTrailing).toBe(expectedWithout)

    // With trailing > without trailing (a2's content is included)
    expect(withTrailing).toBeGreaterThan(withoutTrailing)
  })

  // ── System prompt ────────────────────────────────────────────────────────

  it('includes system prompt tokens in estimate', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const msgs = [makeMsg('m1', 'user', undefined, 'hello')]

    const withPrompt = await estimateHistoryTokens(makeAssistant('system prompt'), msgs)
    const withoutPrompt = await estimateHistoryTokens(makeAssistant(''), msgs)

    // withPrompt includes "system prompt" (13 chars) extra
    expect(withPrompt).toBe(withoutPrompt + 13)
  })

  it('handles empty message list', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const result = await estimateHistoryTokens(makeAssistant(), [])

    // Only prompt tokens
    expect(result).toBe(13)
  })

  it('handles empty prompt', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const msgs = [makeMsg('m1', 'user', undefined, 'hello')]
    const result = await estimateHistoryTokens(makeAssistant(''), msgs)

    // No prompt + msgTokens("hello") = 6
    expect(result).toBe(msgTokens('hello'))
  })

  // ── Thinking content (reasoning blocks) ─────────────────────────────────

  it('includes thinking/reasoning content in token estimate', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')

    // Create a message with both MAIN_TEXT and THINKING blocks
    const msgId = 'a1-thinking'
    const mainBlockId = `block-${msgId}`
    const thinkingBlockId = `thinking-${msgId}`

    // MAIN_TEXT block
    mockStore.dispatch(
      messageBlocksSlice.actions.upsertOneBlock({
        id: mainBlockId,
        type: MessageBlockType.MAIN_TEXT,
        content: 'response text',
        messageId: msgId
      } as any)
    )

    // THINKING block
    mockStore.dispatch(
      messageBlocksSlice.actions.upsertOneBlock({
        id: thinkingBlockId,
        type: MessageBlockType.THINKING,
        content: 'deep reasoning chain',
        messageId: msgId
      } as any)
    )

    const aThinking: Message = {
      id: msgId,
      role: 'assistant',
      askId: 'u1',
      assistantId: 'assistant-1',
      topicId: 'topic-1',
      createdAt: '2026-07-19T00:00:00.000Z',
      status: AssistantMessageStatus.SUCCESS,
      blocks: [mainBlockId, thinkingBlockId]
    } as Message

    const withThinking = await estimateHistoryTokens(makeAssistant(), [aThinking])

    // estimateMessageUsage: combinedContent = 'response text' + ' ' + 'deep reasoning chain'
    // = 'response text deep reasoning chain' → 34 tokens
    // prompt(13) + 34 = 47
    const expected = promptTokens('system prompt') + 'response text deep reasoning chain'.length
    expect(withThinking).toBe(expected)

    // Compare against same message without thinking block
    const aNoThinking = makeMsg('a1-no-thinking', 'assistant', 'u1', 'response text')
    const withoutThinking = await estimateHistoryTokens(makeAssistant(), [aNoThinking])

    // Without thinking: prompt(13) + msgTokens('response text') = 13 + 14 = 27
    expect(withoutThinking).toBe(promptTokens('system prompt') + msgTokens('response text'))

    // Thinking content adds exactly its length (the space separator is always present)
    expect(withThinking - withoutThinking).toBe('deep reasoning chain'.length)
  })

  // ── Multi-turn realistic scenarios ──────────────────────────────────────

  it('5-turn conversation: all messages estimated from content', async () => {
    const { estimateHistoryTokens } = await import('@renderer/services/TokenService')
    const msgs = [
      makeMsg('u1', 'user', undefined, 'Turn 1 question'),
      makeMsg('a1', 'assistant', 'u1', 'response 1', { total_tokens: 150, completion_tokens: 40 } as any),
      makeMsg('u2', 'user', undefined, 'Turn 2 question'),
      makeMsg('a2', 'assistant', 'u2', 'response 2', { total_tokens: 300, completion_tokens: 60 } as any),
      makeMsg('u3', 'user', undefined, 'Turn 3 question'),
      makeMsg('a3', 'assistant', 'u3', 'response 3', { total_tokens: 500, completion_tokens: 80 } as any),
      makeMsg('u4', 'user', undefined, 'Turn 4 question'),
      makeMsg('a4', 'assistant', 'u4', 'response 4', { total_tokens: 750, completion_tokens: 100 } as any),
      makeMsg('u5', 'user', undefined, 'Turn 5 question'),
      makeMsg('a5', 'assistant', 'u5', 'response 5', { total_tokens: 1000, completion_tokens: 120 } as any)
    ]

    const result = await estimateHistoryTokens(makeAssistant(), msgs)

    // All messages estimated from content, not from usage.total_tokens
    const expected =
      promptTokens('system prompt') +
      msgTokens('Turn 1 question') +
      msgTokens('response 1') +
      msgTokens('Turn 2 question') +
      msgTokens('response 2') +
      msgTokens('Turn 3 question') +
      msgTokens('response 3') +
      msgTokens('Turn 4 question') +
      msgTokens('response 4') +
      msgTokens('Turn 5 question') +
      msgTokens('response 5')
    expect(result).toBe(expected)
    // NOT 1000 (old usage baseline)
  })
})

// ---------------------------------------------------------------------------
// combineHistoryAndDraftTokens — Inputbar combination boundary
// ---------------------------------------------------------------------------
describe('combineHistoryAndDraftTokens', () => {
  it('500 history + 20 draft = 520', async () => {
    const { combineHistoryAndDraftTokens } = await import('@renderer/services/TokenService')
    expect(combineHistoryAndDraftTokens(500, 20)).toBe(520)
  })

  it('clearing draft returns history only (500)', async () => {
    const { combineHistoryAndDraftTokens } = await import('@renderer/services/TokenService')
    expect(combineHistoryAndDraftTokens(500, 0)).toBe(500)
  })

  it('history update retains draft contribution', async () => {
    const { combineHistoryAndDraftTokens } = await import('@renderer/services/TokenService')
    const draft = 20
    expect(combineHistoryAndDraftTokens(500, draft)).toBe(520)
    expect(combineHistoryAndDraftTokens(600, draft)).toBe(620)
  })

  it('does not replace history with draft or ignore draft', async () => {
    const { combineHistoryAndDraftTokens } = await import('@renderer/services/TokenService')
    const result = combineHistoryAndDraftTokens(500, 20)
    expect(result).toBe(520)
    expect(result).not.toBe(500) // must not ignore draft
    expect(result).not.toBe(20) // must not replace history with draft
  })
})
