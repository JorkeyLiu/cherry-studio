/**
 * Tests for computeContextInfo — the unified pure function that determines
 * context boundary, context count, and filtered UI messages in a single pipeline.
 *
 * Uses the same filter pipeline as ConversationService.filterMessagesPipeline.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant, TopicAnchor } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock store for filter selectors
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

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: {
    settings?: {
      contextCount?: number
      contextWindowMode?: string
      topicContextWindowMode?: Record<string, 'fixed' | 'sliding' | undefined>
      fixedWindowAnchor?: Record<string, TopicAnchor>
    }
  }) => ({
    contextCount: assistant.settings?.contextCount ?? 10,
    contextWindowMode: assistant.settings?.contextWindowMode ?? 'sliding',
    topicContextWindowMode: assistant.settings?.topicContextWindowMode ?? {},
    fixedWindowAnchor: assistant.settings?.fixedWindowAnchor
  }),
  getDefaultAssistant: () => ({
    id: 'assistant-default',
    name: 'Default',
    topics: [],
    messages: [],
    type: 'assistant',
    settings: { contextCount: 10 }
  }),
  getDefaultTopic: () => ({ id: 'topic-default', assistantId: 'assistant-default' })
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const msg = (id: string, role: Message['role'] = 'user', askId?: string): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant-1',
  topicId: 'topic-1',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

/** Create a message with a non-empty MAIN_TEXT block (so filterEmptyMessages keeps it).
 *  Accepts the store explicitly to make the dispatch dependency clear. */
const msgWithBlock = (
  id: string,
  role: Message['role'] = 'user',
  askId?: string,
  store: ReturnType<typeof createMockStore> = mockStore
): Message => {
  const blockId = `block-${id}`
  const m = msg(id, role, askId)
  m.blocks = [blockId]
  // Dispatch the block entity into the mock store so filterEmptyMessages can find it
  store.dispatch(
    messageBlocksSlice.actions.upsertOneBlock({
      id: blockId,
      type: MessageBlockType.MAIN_TEXT,
      content: `content-${id}`,
      messageId: id
    } as any)
  )
  return m
}

const assistantWith = (settings: {
  contextCount: number
  contextWindowMode?: 'fixed' | 'sliding'
  topicContextWindowMode?: Record<string, 'fixed' | 'sliding' | undefined>
  fixedWindowAnchor?: Record<string, TopicAnchor>
}): Assistant =>
  ({
    id: 'assistant-1',
    settings
  }) as unknown as Assistant

const TOPIC_ID = 'topic-1'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('computeContextInfo', () => {
  // Helper: N alternating user/assistant messages (starts with user).
  // Display source = N (all messages, including any trailing assistant).
  // Model source (withoutAdjacentUsers) = N for odd N (ends with user), N-1 for even N (trailing assistant removed).
  const makeMessages = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
    })

  // 20 alternating messages: last is assistant (index 19) — display source includes all 20
  const twentyMessages = makeMessages(20)

  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  describe('boundaryMessageId — sliding mode', () => {
    it('returns null when all messages fit within contextCount + 2', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2'), msg('a2', 'assistant', 'u2'), msg('u3')]
      // 5 messages, contextCount=10 → contextCount+2=12 → all fit
      const result = computeContextInfo(messages, assistantWith({ contextCount: 10 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
    })

    it('returns the boundary message when messages exceed contextCount + 2', () => {
      // 20 messages, contextCount=5 → contextCount+2=7
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextInfo(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.boundaryMessageId).not.toBeNull()
      expect(typeof result.boundaryMessageId).toBe('string')
    })

    it('returns null for empty messages', () => {
      const result = computeContextInfo([], assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
    })

    it('returns null when assistant is undefined', () => {
      const result = computeContextInfo([msg('u1')], undefined, TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
    })
  })

  describe('boundaryMessageId — fixed mode', () => {
    it('active anchor → returns boundary at groupKey message', () => {
      const messages = [
        msg('u1'),
        msg('a1', 'assistant', 'u1'),
        msg('u2'),
        msg('a2', 'assistant', 'u2'),
        msg('u3'),
        msg('a3', 'assistant', 'u3')
      ]

      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u2' } }
        }),
        TOPIC_ID
      )

      expect(result.boundaryMessageId).toBe('u2')
    })

    it('active anchor with groupKey at index 0 → returns null (all in context)', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2'), msg('a2', 'assistant', 'u2')]

      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
        }),
        TOPIC_ID
      )

      expect(result.boundaryMessageId).toBeNull()
    })

    it('active anchor with deleted groupKey → returns null (fallback)', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]

      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'nonexistent' } }
        }),
        TOPIC_ID
      )

      // GroupKey not found → no boundary (fallback)
      expect(result.boundaryMessageId).toBeNull()
    })

    it('undefined anchor + fixed mode → returns null (no boundary)', () => {
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined anchor → full messages, no boundary
        }),
        TOPIC_ID
      )

      // undefined anchor in fixed mode → all messages, no boundary
      expect(result.boundaryMessageId).toBeNull()
    })

    it('does NOT fall through to sliding when anchor is missing (undefined)', () => {
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const slidingResult = computeContextInfo(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      const fixedNoAnchorResult = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined
        }),
        TOPIC_ID
      )

      // Sliding should produce a boundary
      expect(slidingResult.boundaryMessageId).not.toBeNull()
      // Fixed with undefined anchor should NOT produce a boundary (full messages)
      expect(fixedNoAnchorResult.boundaryMessageId).toBeNull()
    })

    it('fixed mode with no anchor set → full messages (no boundary)', () => {
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined → full messages, no boundary
        }),
        TOPIC_ID
      )

      // fixed + undefined anchor: full messages, no boundary
      expect(result.boundaryMessageId).toBeNull()
    })
  })

  describe('boundaryMessageId — topicContextWindowMode (per-topic override)', () => {
    const manyMessages = Array.from({ length: 20 }, (_, i) => {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
    })

    it('topicContextWindowMode=fixed but contextWindowMode=sliding → sliding behavior (assistant is gate)', () => {
      const result = computeContextInfo(
        manyMessages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'sliding',
          topicContextWindowMode: { [TOPIC_ID]: 'fixed' },
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm4' } }
        }),
        TOPIC_ID
      )
      // assistant level is sliding → topic override is ignored → sliding behavior
      expect(result.boundaryMessageId).not.toBeNull()
      expect(typeof result.boundaryMessageId).toBe('string')
    })

    it('topicContextWindowMode=sliding (even if contextWindowMode=fixed) → sliding behavior', () => {
      const result = computeContextInfo(
        manyMessages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          topicContextWindowMode: { [TOPIC_ID]: 'sliding' },
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm0' } }
        }),
        TOPIC_ID
      )
      // sliding mode: takeRight(preFiltered, 5+2=7) → boundary exists
      expect(result.boundaryMessageId).not.toBeNull()
      expect(typeof result.boundaryMessageId).toBe('string')
    })

    it('topicContextWindowMode=undefined + contextWindowMode=fixed → fallback to fixed', () => {
      const result = computeContextInfo(
        manyMessages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm4' } }
        }),
        TOPIC_ID
      )
      // falls back to fixed mode → boundary at anchor
      expect(result.boundaryMessageId).toBe('m4')
    })

    it('topicContextWindowMode=undefined + contextWindowMode=sliding → sliding', () => {
      const result = computeContextInfo(
        manyMessages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'sliding'
        }),
        TOPIC_ID
      )
      // sliding mode: boundary exists
      expect(result.boundaryMessageId).not.toBeNull()
    })
  })

  describe('boundaryMessageId — unlimited context', () => {
    it('returns null for unlimited context count', () => {
      const messages = Array.from({ length: 100 }, (_, i) => msg(`m${i}`))
      const UNLIMITED = 999999

      const result = computeContextInfo(messages, assistantWith({ contextCount: UNLIMITED }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
    })
  })

  describe('contextCount', () => {
    it('returns current based on display source count and max = raw contextCount', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]
      // 3 msgs (u, a, u): no trailing assistant → display source = 3
      // sliding: Math.min(3, 10) = 3
      const result = computeContextInfo(messages, assistantWith({ contextCount: 10 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(3)
      expect(result.contextCount.max).toBe(10)
    })

    it('returns current=0 for empty messages', () => {
      const result = computeContextInfo([], assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBe(5)
    })

    it('returns current=0, max=null when assistant is undefined', () => {
      const result = computeContextInfo([msg('u1')], undefined, TOPIC_ID)
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBeNull()
    })
  })

  describe('contextCount current/max', () => {
    // --- Sliding mode tests ---

    it('sliding: 20 msgs, contextCount=5 → current=5, max=5', () => {
      // Display source=20, Math.min(20, 5) = 5
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(5)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: 4 msgs, contextCount=5 → current=4, max=5', () => {
      // 4 msgs end with assistant → display source=4 (trailing assistant is viewport-visible),
      // Math.min(4, 5) = 4. Model source (withoutAdjacentUsers) = 3 but display uses slidingDisplaySource.
      const result = computeContextInfo(makeMessages(4), assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(4)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: 5 msgs, contextCount=5 → current=5, max=5', () => {
      // 5 msgs end with user → display source=5, Math.min(5, 5) = 5
      const result = computeContextInfo(makeMessages(5), assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(5)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: 0 msgs, contextCount=5 → current=0, max=5', () => {
      const result = computeContextInfo([], assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: 20 msgs, contextCount=100 (unlimited sentinel) → current=displaySourceLength, max=null', () => {
      // 100 is MAX_CONTEXT_COUNT → sentinel for unlimited → max = null
      // Display source = 20 (all messages after context-clear, including trailing assistant)
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: 100 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(twentyMessages.length)
      expect(result.contextCount.max).toBeNull()
    })

    // --- Fixed mode tests ---

    it('fixed + active anchor at 3rd user group → current=rawCountFromAnchor, max=null', () => {
      // 20 raw messages (m0..m19), anchor at m4 → raw count = 20 - 4 = 16
      // Includes m19 (trailing assistant) because fixed current counts RAW messages.
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: 100,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm4' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(16) // 20 raw - 4 offset
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + active anchor at 1st user group (start) → current=allRaw, max=null', () => {
      // Anchor at m0 → raw count = 20 - 0 = 20 (includes trailing assistant m19)
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: 100,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm0' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(20)
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + undefined anchor, 20 msgs → current=0, max=null', () => {
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: 100,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined anchor
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + undefined anchor, 0 msgs → current=0, max=null', () => {
      const result = computeContextInfo(
        [],
        assistantWith({
          contextCount: 100,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined anchor
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBeNull()
    })

    // --- Fixed active: completed assistant tail is included ---

    it('fixed + active: trailing assistant is included in raw current count', () => {
      // [u1, a1, u2, a2]: anchor at u1 → raw count = 4 (includes trailing a2)
      // RAW counting does not apply filterLastAssistantMessage.
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2'), msg('a2', 'assistant', 'u2')]
      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(4) // u1, a1, u2, a2 (raw includes trailing assistant)
      expect(result.contextCount.max).toBeNull()
    })

    // --- Fixed active: pending user tail ---

    it('fixed + active: pending user tail, raw count includes all from anchor', () => {
      // [u1, a1, u2]: no trailing assistant → raw count from u1 = 3
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]
      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(3)
      expect(result.contextCount.max).toBeNull()
    })

    // --- Fixed active: multiple assistants in one Q&A group ---

    it('fixed + active: multiple assistant responses in anchored group are all counted', () => {
      // [u1, a1, a1_retry, u2, a2]: a1 and a1_retry both belong to u1's group (askId='u1')
      // Anchor at u1 → raw count = 5
      const messages = [
        msg('u1'),
        msg('a1', 'assistant', 'u1'),
        msg('a1_retry', 'assistant', 'u1'),
        msg('u2'),
        msg('a2', 'assistant', 'u2')
      ]
      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(5) // all 5 raw messages from u1
      expect(result.contextCount.max).toBeNull()
    })

    // --- Fixed active: missing anchor (groupKey not in raw messages) ---

    it('fixed + active: missing anchor groupKey → current=0', () => {
      // groupKey 'nonexistent' doesn't exist in messages
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]
      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'nonexistent' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBeNull()
    })

    // --- Fixed active: anchor not at index 0 ---

    it('fixed + active: anchor at non-zero index counts all raw messages from anchor', () => {
      // [u1, a1, u2, a2, u3, a3]: anchor at u2 (index 2)
      // Raw from u2: [u2, a2, u3, a3] → 4 messages
      const messages = [
        msg('u1'),
        msg('a1', 'assistant', 'u1'),
        msg('u2'),
        msg('a2', 'assistant', 'u2'),
        msg('u3'),
        msg('a3', 'assistant', 'u3')
      ]
      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u2' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(4) // u2, a2, u3, a3
      expect(result.contextCount.max).toBeNull()
    })

    // --- Sliding boundary marks start of N-message display window ---

    it('sliding: boundary is at start of last N messages of display source', () => {
      // 20 alternating msgs → display source = 20 (post-context-clear, including trailing assistant m19)
      // Display window = last 5 → m15, m16, m17, m18, m19
      // Boundary should be m15 (start of display window)
      // Model window = last 7 (N+2) of withoutAdjacentUsers (19) → m12..m18, but boundary is m15
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBe('m15')
      expect(result.contextCount.current).toBe(5)
      expect(result.contextCount.max).toBe(5)
    })

    // --- Sliding sentinel 100: no boundary when unlimited ---

    it('sliding: sentinel 100 → no boundary, current=displaySourceLength, max=null', () => {
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: 100 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount.current).toBe(twentyMessages.length)
      expect(result.contextCount.max).toBeNull()
    })

    // --- Model uiMessages uses N+2 window, display uses N ---

    it('sliding: uiMessages derived from N+2 model window, display current capped at N', () => {
      // 20 msgs with blocks → display source = 20 (includes trailing assistant m19)
      // Model source (withoutAdjacentUsers) = 19 (trailing assistant removed by step 4)
      // Model: takeRight(19, 5+2=7) → m12..m18 (7 msgs)
      // Post-limit filters: filterEmptyMessages keeps all (blocks exist),
      // filterUserRoleStartMessages: m12 is user (even index) → no removal → uiMessages = 7
      // Display current = min(20, 5) = 5 (from slidingDisplaySource, not model source)
      const msgs = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msgWithBlock(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.uiMessages.length).toBe(7) // model window: N+2 (from withoutAdjacentUsers)
      expect(result.contextCount.current).toBe(5) // display window: N (from slidingDisplaySource)
      expect(result.contextCount.max).toBe(5)
    })
  })

  describe('uiMessages', () => {
    it('returns filtered messages starting from first user message', () => {
      const messages = [msg('a-leading', 'assistant'), msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]
      const result = computeContextInfo(messages, assistantWith({ contextCount: 10 }), TOPIC_ID)
      // Leading assistant should be filtered; first message should be user
      if (result.uiMessages.length > 0) {
        expect(result.uiMessages[0].role).toBe('user')
      }
    })

    it('sliding: display current/boundary track N-message window independent of post-limit filters', () => {
      // 10 messages: some with blocks (kept by filterEmptyMessages), some without (removed).
      // Pre-filtered=10 (no trailing assistant, no adjacent users, alternation correct).
      // Model window = takeRight(10, 5+2=7) = [m3..m9] (7 messages).
      //   m3 is user → filterUserRoleStartMessages keeps all 7 that have blocks.
      //   But m4 (assistant) and m6 (assistant) have NO blocks → filterEmptyMessages removes them.
      //   So uiMessages = 5 (m3, m5, m7, m8, m9 — those with blocks).
      // Display current = min(10, 5) = 5 — unaffected by post-limit filtering.
      // Boundary = start of last 5 of 10 = m5.
      const msgs = [
        msgWithBlock('m0', 'user'),
        msgWithBlock('m1', 'assistant', 'm0'),
        msgWithBlock('m2', 'user'),
        msg('m3', 'user'), // no block → filtered by filterEmptyMessages
        msg('m4', 'assistant', 'm3'), // no block → filtered
        msgWithBlock('m5', 'user'),
        msg('m6', 'assistant', 'm5'), // no block → filtered
        msgWithBlock('m7', 'user'),
        msgWithBlock('m8', 'assistant', 'm7'),
        msgWithBlock('m9', 'user')
      ]
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      // Display window is independent of post-limit filters
      expect(result.contextCount.current).toBe(5) // min(10, 5)
      expect(result.contextCount.max).toBe(5)
      expect(result.boundaryMessageId).toBe('m5') // start of last 5 of 10
      // Model window (N+2) is smaller after post-limit filters remove empty messages
      expect(result.uiMessages.length).toBeLessThan(7) // some messages filtered as empty
      expect(result.uiMessages.length).toBeGreaterThan(0)
    })

    // --- Sliding: display source vs model source ---

    it('sliding: trailing assistant included in display source but excluded from model source', () => {
      // 20 alternating msgs ending with assistant m19, all with blocks.
      // Display source (slidingDisplaySource) = 20 (includes m19).
      // Model source (withoutAdjacentUsers) = 19 (m19 removed by filterLastAssistantMessage).
      // current/boundary use display source; uiMessages uses model source via N+2.
      const msgs = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msgWithBlock(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      // Display: 20 messages → current = min(20, 5) = 5, boundary at m15
      expect(result.contextCount.current).toBe(5)
      expect(result.boundaryMessageId).toBe('m15')
      // Model: 19 messages → takeRight(19, 7) = m12..m18 → uiMessages = 7
      // (all post-limit filters pass through; m12 is user, no leading-assistant removal)
      expect(result.uiMessages.length).toBe(7)
    })

    it('sliding: pending user tail — display and model sources align when no trailing assistant', () => {
      // 19 alternating msgs ending with user m18 (no trailing assistant).
      // Display source = 19, model source (withoutAdjacentUsers) = 19 (no removal).
      // Both sources are identical → current and boundary consistent.
      const msgs = Array.from({ length: 19 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      // Display: 19 → current = min(19, 5) = 5, boundary at m14
      expect(result.contextCount.current).toBe(5)
      expect(result.boundaryMessageId).toBe('m14')
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: adjacent user pair counted in display source, filtered from model source', () => {
      // Messages: u0, a0, u1, u2, a2, u3, a3, u4, a4, u5, a5 (11 messages)
      // u1 and u2 are adjacent users → filterAdjacentUserMessaegs removes u1 from model source.
      // Display source = 11 (post-context-clear only).
      // Model source = 10 (u1 removed).
      // With contextCount=5: display current = min(11, 5) = 5, boundary = start of last 5 of 11.
      const msgs = [
        msg('u0'),
        msg('a0', 'assistant', 'u0'),
        msg('u1'),
        msg('u2'), // adjacent users
        msg('a2', 'assistant', 'u2'),
        msg('u3'),
        msg('a3', 'assistant', 'u3'),
        msg('u4'),
        msg('a4', 'assistant', 'u4'),
        msg('u5'),
        msg('a5', 'assistant', 'u5')
      ]
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(5) // min(11, 5)
      // indices 0..10, last 5 = indices 6..10 → [a3, u4, a4, u5, a5]
      // boundary = a3 (index 6)
      expect(result.boundaryMessageId).toBe('a3')
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: context-clear source excludes pre-clear history', () => {
      // Messages: u0, a0, u1, [clear], u2, a2, u3, a3, u4, a4 (10 messages)
      // filterAfterContextClearMessages removes u0, a0, u1 → display source = 7.
      // current = min(7, 5) = 5, boundary = start of last 5 of 7.
      const msgs = [
        msg('u0'),
        msg('a0', 'assistant', 'u0'),
        msg('u1'),
        { ...msg('clear-msg'), type: 'clear' as const },
        msg('u2'),
        msg('a2', 'assistant', 'u2'),
        msg('u3'),
        msg('a3', 'assistant', 'u3'),
        msg('u4'),
        msg('a4', 'assistant', 'u4')
      ]
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      // clear is at index 3, so display source = messages after clear = [u2, a2, u3, a3, u4, a4] = 6
      expect(result.contextCount.current).toBe(Math.min(6, 5)) // 5
      expect(result.contextCount.max).toBe(5)
      // Last 5 of 6: [a2, u3, a3, u4, a4] → boundary = a2
      expect(result.boundaryMessageId).toBe('a2')
    })
  })
})
