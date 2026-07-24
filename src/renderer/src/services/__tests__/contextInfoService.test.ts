/**
 * Tests for computeContextInfo — the unified pure function that determines
 * context boundary, context count, and filtered UI messages in a single pipeline.
 *
 * Canonical unit: ContextTurn. contextCount.current and contextCount.max count
 * turns (not messages). The boundary divider marks the first message of the first
 * selected turn when older turns exist.
 *
 * N+2 compensation is removed: selection is by whole turns, so post-selection
 * model filters cannot create partial turn boundaries. The model may receive
 * fewer messages than the expanded turn count after model filters (useful,
 * error-only, trailing assistant, adjacent users) remove individual messages.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { computeContextInfo, PREVIEW_DRAFT_SENTINEL } from '@renderer/services/contextInfoService'
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
      contextCount?: number | null
      contextWindowMode?: string
      topicContextWindowMode?: Record<string, 'fixed' | 'sliding' | undefined>
      fixedWindowAnchor?: Record<string, TopicAnchor>
    }
  }) => ({
    contextCount: assistant.settings?.contextCount === undefined ? 10 : assistant.settings.contextCount,
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
  contextCount: number | null
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
  // Builds ceil(N/2) turns: each user+assistant pair is one turn; an odd trailing
  // user is a standalone turn.
  //
  // Examples:
  //   makeMessages(4) → 4 msgs, 2 turns:  [m0,m1], [m2,m3]
  //   makeMessages(5) → 5 msgs, 3 turns:  [m0,m1], [m2,m3], [m4]
  //   makeMessages(20) → 20 msgs, 10 turns
  const makeMessages = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
    })

  // 20 alternating messages: 10 turns. Last turn is [m18, m19].
  const twentyMessages = makeMessages(20)

  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  describe('boundaryMessageId — sliding mode', () => {
    it('returns null when all turns fit within contextCount', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2'), msg('a2', 'assistant', 'u2'), msg('u3')]
      // 5 msgs → 3 turns. contextCount=10 → all fit → no boundary.
      const result = computeContextInfo(messages, assistantWith({ contextCount: 10 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
    })

    it('returns the boundary message when turns exceed contextCount', () => {
      // 20 messages → 10 turns, contextCount=5 → last 5 turns selected → boundary exists
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
    it('active anchor → returns boundary at anchor turn first message', () => {
      // Turns: [u1,a1](key=u1), [u2,a2](key=u2), [u3,a3](key=u3)
      // Anchor groupKey=u2 → turn index 1 → boundary = first message of that turn = u2
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

    it('active anchor with groupKey at first turn → returns null (all in context)', () => {
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

    it('fixed + invalid anchor: display=0 but model gets full history', () => {
      // Turns: [u1,a1](key=u1), [u2](key=u2). groupKey='nonexistent' → not found.
      // Display semantics: current=0, no boundary.
      // Model semantics: all turns go through filters → full history preserved.
      const messages = [msgWithBlock('u1'), msgWithBlock('a1', 'assistant', 'u1'), msgWithBlock('u2')]

      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'nonexistent' } }
        }),
        TOPIC_ID
      )

      // Display: current=0, no boundary, max=null
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBeNull()
      // Model: full filtered history preserved (not empty)
      // Expanded: u1, a1, u2 → model filters keep all (starts with user, no trailing assistant)
      expect(result.uiMessages.length).toBe(3)
      expect(result.uiMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    })

    it('fixed + undefined anchor: display=0 but model gets full history', () => {
      const messages = Array.from({ length: 6 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msgWithBlock(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined anchor
        }),
        TOPIC_ID
      )

      // Display: current=0, no boundary, max=null
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBeNull()
      // Model: full filtered history preserved (not empty)
      // 6 msgs → 3 turns, expanded → filterLastAssistant removes m5 → 5 uiMessages
      expect(result.uiMessages.length).toBe(5)
      expect(result.uiMessages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
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
      // Fixed with undefined anchor should NOT produce a boundary (safe semantics)
      expect(fixedNoAnchorResult.boundaryMessageId).toBeNull()
    })

    it('fixed mode with no anchor set → safe semantics (empty selection, no boundary)', () => {
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined → safe semantics
        }),
        TOPIC_ID
      )

      // fixed + undefined anchor: safe semantics — no selection, no boundary
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBeNull()
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
      // sliding mode: 10 turns, last 5 selected → boundary exists
      expect(result.boundaryMessageId).not.toBeNull()
      expect(typeof result.boundaryMessageId).toBe('string')
    })

    it('topicContextWindowMode=undefined + contextWindowMode=fixed → fallback to fixed', () => {
      // Turns: [m0,m1], [m2,m3], [m4,m5], ...
      // Anchor groupKey=m4 → turn index 2 → boundary = m4
      const result = computeContextInfo(
        manyMessages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm4' } }
        }),
        TOPIC_ID
      )
      // falls back to fixed mode → boundary at anchor turn first message
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
    it('returns null for unlimited context count (null)', () => {
      const messages = Array.from({ length: 100 }, (_, i) => msg(`m${i}`))

      const result = computeContextInfo(messages, assistantWith({ contextCount: null }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
    })
  })

  describe('contextCount — basic', () => {
    it('returns current based on turn count (not message count)', () => {
      // 3 msgs (u1, a1, u2) → 2 turns: [u1,a1], [u2]
      // contextCount=10 → all 2 turns fit → current=2, max=10
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]
      const result = computeContextInfo(messages, assistantWith({ contextCount: 10 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(2) // turns, not messages
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

  describe('contextCount current/max — sliding mode', () => {
    it('sliding: 20 msgs (10 turns), contextCount=5 → current=5, max=5', () => {
      // 20 msgs → 10 turns. Select last 5 → current=5
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(5)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: 4 msgs (2 turns), contextCount=5 → current=2, max=5', () => {
      // 4 msgs → 2 turns. All fit → current=2
      const result = computeContextInfo(makeMessages(4), assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(2)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: 5 msgs (3 turns), contextCount=5 → current=3, max=5', () => {
      // 5 msgs → 3 turns. All fit → current=3
      const result = computeContextInfo(makeMessages(5), assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(3)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: 0 msgs, contextCount=5 → current=0, max=5', () => {
      const result = computeContextInfo([], assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: contextCount=null → unlimited (current=allTurns, max=null)', () => {
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: null }), TOPIC_ID)
      expect(result.contextCount.current).toBe(10)
      expect(result.contextCount.max).toBeNull()
      expect(result.boundaryMessageId).toBeNull()
    })

    it('sliding: contextCount=99 is a real finite value (not unlimited)', () => {
      // 20 msgs → 10 turns. 99 > 10, so all turns fit. max=99 (finite).
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: 99 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(10)
      expect(result.contextCount.max).toBe(99)
      expect(result.boundaryMessageId).toBeNull()
    })

    it('sliding: contextCount=99 with more than 99 turns → boundary exists, max=99', () => {
      // Create 200 alternating messages → 100 turns. contextCount=99 → select last 99.
      const manyMsgs = Array.from({ length: 200 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })
      const result = computeContextInfo(manyMsgs, assistantWith({ contextCount: 99 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(99)
      expect(result.contextCount.max).toBe(99)
      expect(result.boundaryMessageId).not.toBeNull()
    })

    it('sliding: 20 msgs (10 turns), contextCount=null (unlimited) → current=10, max=null', () => {
      // null means unlimited → max = null
      // 20 msgs → 10 turns, all selected → current=10
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: null }), TOPIC_ID)
      expect(result.contextCount.current).toBe(10)
      expect(result.contextCount.max).toBeNull()
    })
  })

  describe('contextCount current/max — fixed mode', () => {
    it('fixed + active anchor at 3rd user group → current=turnsFromAnchor, max=null', () => {
      // 20 msgs → 10 turns: [m0,m1],[m2,m3],[m4,m5],[m6,m7],[m8,m9],
      //                       [m10,m11],[m12,m13],[m14,m15],[m16,m17],[m18,m19]
      // Anchor at m4 → turn index 2 → selected = 8 turns → current=8
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: null,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm4' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(8)
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + active anchor at 1st user group (start) → current=totalTurns, max=null', () => {
      // Anchor at m0 → turn index 0 → selected = 10 turns → current=10
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: null,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm0' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(10)
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + undefined anchor, 20 msgs → current=0, max=null', () => {
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: null,
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
          contextCount: null,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined anchor
        }),
        TOPIC_ID
      )
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + active: trailing assistant turn is counted as a whole turn', () => {
      // [u1, a1, u2, a2]: anchor at u1
      // Turns: [u1,a1](key=u1), [u2,a2](key=u2) → 2 turns from anchor
      // The trailing assistant a2 is part of its turn — turn-based counting includes it.
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
      expect(result.contextCount.current).toBe(2) // 2 turns (not 4 messages)
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + active: pending user tail creates its own turn', () => {
      // [u1, a1, u2]: anchor at u1
      // Turns: [u1,a1](key=u1), [u2](key=u2) → 2 turns from anchor
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
      expect(result.contextCount.current).toBe(2) // 2 turns (not 3 messages)
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + active: retries count as one turn', () => {
      // [u1, a1, a1_retry, u2, a2]: anchor at u1
      // Turns: [u1,a1,a1_retry](key=u1), [u2,a2](key=u2) → 2 turns from anchor
      // Retries are grouped into the same turn by buildContextTurns.
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
      expect(result.contextCount.current).toBe(2) // 2 turns (retries = 1 turn, not 2)
      expect(result.contextCount.max).toBeNull()
    })

    it('fixed + active: missing anchor groupKey → current=0, safe semantics', () => {
      // groupKey 'nonexistent' doesn't exist in any turn
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

    it('fixed + active: anchor at non-zero index counts turns from anchor', () => {
      // [u1, a1, u2, a2, u3, a3]: 3 turns
      // Anchor at u2 → turn index 1 → selected = 2 turns → current=2
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
      expect(result.contextCount.current).toBe(2) // 2 turns (not 4 messages)
      expect(result.contextCount.max).toBeNull()
    })
  })

  describe('boundaryMessageId + contextCount — turn-based boundary placement', () => {
    it('sliding: boundary at first message of first selected turn', () => {
      // 20 alternating msgs → 10 turns, contextCount=5
      // Select last 5 turns: turns[5]..[9]
      //   turns[5] = [m10, m11] → boundary = m10 (first message of first selected turn)
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBe('m10')
      expect(result.contextCount.current).toBe(5)
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: sentinel null → no boundary, current=turnCount, max=null', () => {
      // 20 msgs → 10 turns, unlimited → current=10, no boundary
      const result = computeContextInfo(twentyMessages, assistantWith({ contextCount: null }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount.current).toBe(10)
      expect(result.contextCount.max).toBeNull()
    })

    it('sliding: N+2 removed — model filters may reduce uiMessages below expanded count', () => {
      // 20 msgs with blocks → 10 turns, contextCount=5 → last 5 turns → 10 expanded msgs
      // After model filters: trailing assistant m19 removed → 9 uiMessages.
      // N+2 is removed because selection is by whole turns — no partial turn compensation needed.
      const msgs = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msgWithBlock(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.uiMessages.length).toBe(9) // 10 expanded - 1 trailing assistant
      expect(result.contextCount.current).toBe(5) // 5 turns
      expect(result.contextCount.max).toBe(5)
    })
  })

  describe('uiMessages — model filter semantics', () => {
    it('returns filtered messages starting from first user message', () => {
      // Turns: [a-leading](orphan), [u1,a1](key=u1), [u2](key=u2)
      // All 3 turns selected (contextCount=10).
      // filterEmptyMessages removes empty messages; filterUserRoleStartMessages trims leading non-user.
      const messages = [msg('a-leading', 'assistant'), msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]
      const result = computeContextInfo(messages, assistantWith({ contextCount: 10 }), TOPIC_ID)
      // Leading assistant should be filtered; first message should be user
      if (result.uiMessages.length > 0) {
        expect(result.uiMessages[0].role).toBe('user')
      }
    })

    it('sliding: contextCount.current tracks turns, independent of post-turn model filters', () => {
      // 10 messages forming 6 turns:
      //   [m0(U,block), m1(A,block)] → turn 0 (key=m0)
      //   [m2(U,block)]             → turn 1 (key=m2, adjacent user starts own turn)
      //   [m3(U,no), m4(A,no)]     → turn 2 (key=m3)
      //   [m5(U,block), m6(A,no)]  → turn 3 (key=m5)
      //   [m7(U,block), m8(A,block)]→ turn 4 (key=m7)
      //   [m9(U,block)]            → turn 5 (key=m9)
      // contextCount=5 → select last 5 turns (indices 1..5) → boundary = first msg of turn 1 = m2
      // current = 5 (turn count), max = 5
      // Expanded: m2,m3,m4,m5,m6,m7,m8,m9 (8 msgs)
      // Model filters:
      //   filterUsefulMessages → 8 (all unique/single)
      //   filterErrorOnlyMessages → 8
      //   filterLastAssistantMessage → 8 (m9 is user)
      //   filterAdjacentUserMessages: m2(U) then m3(U) → m2 removed → 7
      //   filterEmptyMessages: m3(no block), m4(no block), m6(no block) removed → 4
      //   filterUserRoleStartMessages: m5 is user → 4
      // uiMessages = 4
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
      // Turn count is independent of post-selection model filters
      expect(result.contextCount.current).toBe(5) // 5 turns
      expect(result.contextCount.max).toBe(5)
      expect(result.boundaryMessageId).toBe('m2') // first message of first selected turn
      // Model filters reduce uiMessages below expanded turn message count
      expect(result.uiMessages.length).toBeLessThan(8) // some messages filtered as empty
      expect(result.uiMessages.length).toBeGreaterThan(0)
    })

    it('sliding: trailing assistant removed by model filter, not by turn selection', () => {
      // 20 alternating msgs with blocks → 10 turns, contextCount=5
      // Last 5 turns → 10 expanded msgs
      // filterLastAssistantMessage removes trailing m19 → 9 uiMessages
      const msgs = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msgWithBlock(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      // Turn-based: current = 5 turns, boundary at first selected turn's first message
      expect(result.contextCount.current).toBe(5)
      expect(result.boundaryMessageId).toBe('m10') // first msg of turn[5]
      // Model filter removes trailing assistant within the selected turns
      expect(result.uiMessages.length).toBe(9)
    })

    it('sliding: pending user tail — no trailing assistant to remove', () => {
      // 19 alternating msgs (ends with user m18) → 10 turns, contextCount=5
      // Last 5 turns: [m10,m11], [m12,m13], [m14,m15], [m16,m17], [m18]
      // boundary = m10 (first message of first selected turn)
      const msgs = Array.from({ length: 19 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(5)
      expect(result.boundaryMessageId).toBe('m10')
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: adjacent users are separate turns', () => {
      // Messages: u0,a0,u1,u2,a2,u3,a3,u4,a4,u5,a5 (11 msgs)
      // Turns: [u0,a0](key=u0), [u1](key=u1), [u2,a2](key=u2), [u3,a3](key=u3),
      //        [u4,a4](key=u4), [u5,a5](key=u5) = 6 turns
      // contextCount=5 → select last 5 turns: [u1],[u2,a2],[u3,a3],[u4,a4],[u5,a5]
      // boundary = u1 (first message of first selected turn)
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
      expect(result.contextCount.current).toBe(5) // 5 turns
      expect(result.boundaryMessageId).toBe('u1') // first message of first selected turn
      expect(result.contextCount.max).toBe(5)
    })

    it('sliding: context-clear → only post-clear turns selected', () => {
      // Messages: u0, a0, u1, [clear], u2, a2, u3, a3, u4, a4 (10 messages)
      // buildContextTurns handles clear → post-clear: u2, a2, u3, a3, u4, a4
      // Turns: [u2,a2], [u3,a3], [u4,a4] = 3 turns
      // contextCount=5 → all 3 fit → current=3, no boundary
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
      expect(result.contextCount.current).toBe(3) // 3 turns (not 5 or 6 messages)
      expect(result.contextCount.max).toBe(5)
      expect(result.boundaryMessageId).toBeNull() // all turns fit
    })
  })

  describe('uiMessages — SDK-facing Message[] semantics', () => {
    it('fixed + active: expanded turns produce correct uiMessages after model filters', () => {
      // [u1(block), a1(block,u1), u2(block), a2(block,u2)]
      // Anchor at u1 → 2 turns selected
      // Expanded: u1, a1, u2, a2
      // Model filters: all pass (no trailing assistant removal — a2 is last but within a turn)
      // Wait: filterLastAssistantMessage removes trailing assistant regardless of turns.
      // a2 is the last message and is assistant → removed.
      // uiMessages: u1, a1, u2 (3 messages)
      const msgs = [
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('u2', 'user'),
        msgWithBlock('a2', 'assistant', 'u2')
      ]
      const result = computeContextInfo(
        msgs,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
        }),
        TOPIC_ID
      )
      // 2 turns, but model filter removes trailing assistant
      expect(result.contextCount.current).toBe(2)
      expect(result.uiMessages.length).toBe(3) // u1, a1, u2 (a2 removed as trailing assistant)
      expect(result.uiMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    })

    it('sliding: retries deduplicated by filterUsefulMessages within selected turns', () => {
      // [u1, a1, a1_retry, a1_retry2, u2, a2]
      // Turns: [u1,a1,a1_retry,a1_retry2](key=u1), [u2,a2](key=u2) = 2 turns
      // contextCount=2 → select all 2 turns
      // Expanded: u1, a1, a1_retry, a1_retry2, u2, a2 (6 msgs)
      // filterUsefulMessages: none marked useful → keeps first of group → u1, a1, u2, a2 (4 msgs)
      // filterLastAssistantMessage: a2 is trailing assistant → removed → 3 msgs
      // uiMessages: u1, a1, u2
      const msgs = [
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('a1_retry', 'assistant', 'u1'),
        msgWithBlock('a1_retry2', 'assistant', 'u1'),
        msgWithBlock('u2', 'user'),
        msgWithBlock('a2', 'assistant', 'u2')
      ]
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 2 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(2) // 2 turns
      // filterUsefulMessages keeps first of retry group; filterLastAssistantMessage removes trailing
      expect(result.uiMessages.length).toBe(3) // u1, a1, u2
      expect(result.uiMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])
    })

    it('sliding: orphan assistant turn and system turn produce correct messages', () => {
      // Orphan assistant (no askId), system message, then a normal Q&A
      const systemMsg: Message = {
        ...msg('s1', 'system'),
        role: 'system'
      }
      const msgs = [
        msgWithBlock('a-orphan', 'assistant'), // orphan, no askId → turn key=a-orphan
        systemMsg,
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1')
      ]
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 10 }), TOPIC_ID)
      // 3 turns: [a-orphan], [s1], [u1,a1]
      expect(result.contextCount.current).toBe(3)
      // model filters: filterUserRoleStartMessages trims leading non-user
      // a-orphan is assistant → removed; s1 is system → removed; u1 starts
      if (result.uiMessages.length > 0) {
        expect(result.uiMessages[0].role).toBe('user')
      }
    })
  })

  // ── tokenEstimationMessages — retains trailing assistant ──────────────

  describe('tokenEstimationMessages — trailing assistant retention (LOCK-005)', () => {
    it('retains trailing assistant that uiMessages strips', () => {
      // [u1, a1, u2, a2]: 2 turns, contextCount=2
      // uiMessages: trailing a2 removed → [u1, a1, u2] (3 msgs)
      // tokenEstimationMessages: a2 retained → [u1, a1, u2, a2] (4 msgs)
      const msgs = [
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('u2', 'user'),
        msgWithBlock('a2', 'assistant', 'u2')
      ]
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 2 }), TOPIC_ID)

      expect(result.uiMessages.length).toBe(3)
      expect(result.uiMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2'])

      expect(result.tokenEstimationMessages.length).toBe(4)
      expect(result.tokenEstimationMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    })

    it('same length when trailing message is user (no assistant to strip)', () => {
      // [u1, a1, u2]: 2 turns, ends with user
      // Both lists should be equal — no trailing assistant to retain/strip
      const msgs = [msgWithBlock('u1', 'user'), msgWithBlock('a1', 'assistant', 'u1'), msgWithBlock('u2', 'user')]
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)

      expect(result.uiMessages.length).toBe(result.tokenEstimationMessages.length)
      expect(result.tokenEstimationMessages.map((m) => m.id)).toEqual(result.uiMessages.map((m) => m.id))
    })

    it('20-msg sliding: tokenEstimationMessages has 10 msgs (trailing assistant kept)', () => {
      // 20 alternating msgs with blocks → 10 turns, contextCount=5
      // Last 5 turns → 10 expanded msgs
      // uiMessages: trailing m19 removed → 9
      // tokenEstimationMessages: m19 retained → 10
      const msgs = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msgWithBlock(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)

      expect(result.uiMessages.length).toBe(9) // trailing assistant stripped
      expect(result.tokenEstimationMessages.length).toBe(10) // trailing assistant retained
      // Last message in token-estimation list is m19 (assistant)
      expect(result.tokenEstimationMessages[result.tokenEstimationMessages.length - 1].id).toBe('m19')
      expect(result.tokenEstimationMessages[result.tokenEstimationMessages.length - 1].role).toBe('assistant')
    })

    it('empty messages → both lists empty', () => {
      const result = computeContextInfo([], assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.uiMessages.length).toBe(0)
      expect(result.tokenEstimationMessages.length).toBe(0)
    })

    it('undefined assistant → both lists empty', () => {
      const result = computeContextInfo([msg('u1')], undefined, TOPIC_ID)
      expect(result.uiMessages.length).toBe(0)
      expect(result.tokenEstimationMessages.length).toBe(0)
    })

    it('tokenEstimationMessages applies same non-trailing-assistant filters', () => {
      // Verify that tokenEstimationMessages still applies:
      //   filterUsefulMessages, filterErrorOnlyMessages, filterAdjacentUserMessages,
      //   filterAfterContextClearMessages, filterEmptyMessages, filterUserRoleStartMessages
      // Only filterLastAssistantMessage is skipped.
      const msgs = [
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('a1_retry', 'assistant', 'u1'), // retry → filtered by filterUsefulMessages
        msgWithBlock('u2', 'user'),
        msgWithBlock('a2', 'assistant', 'u2')
      ]
      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)

      // filterUsefulMessages deduplicates retries → a1_retry removed
      // uiMessages: a2 stripped as trailing → [u1, a1, u2] (3)
      expect(result.uiMessages.length).toBe(3)
      // tokenEstimationMessages: a2 retained, a1_retry still deduped → [u1, a1, u2, a2] (4)
      expect(result.tokenEstimationMessages.length).toBe(4)
      expect(result.tokenEstimationMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    })
  })

  // ── previewDraft — virtual turn for pending nonblank draft (LOCK-004) ──

  describe('previewDraft — virtual turn participates in turn selection', () => {
    it('sliding at capacity: nonblank draft ejects oldest real turn', () => {
      // 20 alternating msgs → 10 turns, contextCount=5
      // Without draft: select last 5 turns → current=5
      // With draft: totalTurns=11, select last 5 → 4 real + 1 virtual → current=5
      // Oldest real turn (turn[5]) is ejected.
      const msgs = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msgWithBlock(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const withoutDraft = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      const withDraft = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID, {
        previewDraft: 'new message'
      })

      // Without draft: 5 turns, 10 expanded messages (minus trailing assistant = 9 uiMessages)
      expect(withoutDraft.contextCount.current).toBe(5)
      expect(withoutDraft.uiMessages.length).toBe(9)

      // With draft: still 5 turns displayed (4 real + 1 virtual), but only 4 real turns expanded
      expect(withDraft.contextCount.current).toBe(5)
      expect(withDraft.contextCount.max).toBe(5)
      // Only 4 real turns → 8 expanded messages, minus trailing assistant → 7 uiMessages
      expect(withDraft.uiMessages.length).toBe(7)
      // Boundary shifts: without draft boundary is m10, with draft it's m12
      // (oldest real turn ejected → first selected turn shifts by 2 messages)
      expect(withDraft.boundaryMessageId).not.toBeNull()
    })

    it('sliding below capacity: draft adds to turn count without ejection', () => {
      // 4 alternating msgs → 2 turns, contextCount=5
      // With draft: totalTurns=3 ≤ 5 → all real turns kept + virtual → current=3
      const msgs = [
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('u2', 'user'),
        msgWithBlock('a2', 'assistant', 'u2')
      ]

      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID, {
        previewDraft: 'new message'
      })

      expect(result.contextCount.current).toBe(3) // 2 real + 1 virtual
      expect(result.contextCount.max).toBe(5)
      // All real turns included — uiMessages same as without draft
      expect(result.uiMessages.length).toBe(3) // trailing a2 removed
      expect(result.boundaryMessageId).toBeNull() // all turns fit
    })

    it('blank draft does NOT create virtual turn', () => {
      // Blank or whitespace-only draft should not affect turn selection
      const msgs = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msgWithBlock(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const noDraft = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      const blankDraft = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID, {
        previewDraft: '   '
      })
      const emptyDraft = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID, {
        previewDraft: ''
      })

      // All three should produce identical results
      expect(blankDraft.contextCount).toEqual(noDraft.contextCount)
      expect(blankDraft.uiMessages.length).toBe(noDraft.uiMessages.length)
      expect(blankDraft.boundaryMessageId).toBe(noDraft.boundaryMessageId)
      expect(emptyDraft.contextCount).toEqual(noDraft.contextCount)
    })

    it('PREVIEW_DRAFT_SENTINEL (the actual Inputbar sentinel) activates virtual turn', () => {
      // Regression: Inputbar passes PREVIEW_DRAFT_SENTINEL as previewDraft.
      // If the sentinel were still whitespace (' '), .trim() would produce ''
      // and the virtual turn would silently never activate.
      const msgs = [
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('u2', 'user'),
        msgWithBlock('a2', 'assistant', 'u2')
      ]

      const withoutDraft = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID)
      const withSentinel = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID, {
        previewDraft: PREVIEW_DRAFT_SENTINEL
      })

      // Without draft: 2 real turns → current=2
      expect(withoutDraft.contextCount.current).toBe(2)
      // With sentinel: 2 real + 1 virtual → current=3
      expect(withSentinel.contextCount.current).toBe(3)
      expect(withSentinel.contextCount.max).toBe(5)
      // Virtual turn should not appear in output messages
      expect(withSentinel.uiMessages.length).toBe(withoutDraft.uiMessages.length)
    })

    it('draft virtual turn is NOT in output messages', () => {
      // The virtual draft turn should never appear in uiMessages or tokenEstimationMessages
      const msgs = [msgWithBlock('u1', 'user'), msgWithBlock('a1', 'assistant', 'u1')]

      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), TOPIC_ID, {
        previewDraft: 'draft content'
      })

      // No message should have id '__preview_draft_turn__' or similar
      const allIds = [...result.uiMessages.map((m) => m.id), ...result.tokenEstimationMessages.map((m) => m.id)]
      expect(allIds).not.toContain('__preview_draft_turn__')
      expect(allIds).not.toContain(expect.stringMatching(/draft/i))
    })

    it('sliding with draft: contextCount=1 means only virtual turn, no real turns', () => {
      // 6 msgs → 3 turns. contextCount=1 + draft → totalTurns=3+1=4, n=1
      // totalTurns(4) > n(1): realTurnsToKeep = 1-1 = 0 → no real turns selected
      const msgs = [
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('u2', 'user'),
        msgWithBlock('a2', 'assistant', 'u2'),
        msgWithBlock('u3', 'user'),
        msgWithBlock('a3', 'assistant', 'u3')
      ]

      const result = computeContextInfo(msgs, assistantWith({ contextCount: 1 }), TOPIC_ID, {
        previewDraft: 'new message'
      })

      // Only the virtual turn fits → no real turns selected
      expect(result.contextCount.current).toBe(1)
      expect(result.contextCount.max).toBe(1)
      expect(result.uiMessages.length).toBe(0) // no real turns → no messages
      expect(result.tokenEstimationMessages.length).toBe(0)
    })

    it('fixed mode with draft: currentCount includes virtual turn', () => {
      // 6 msgs → 3 turns, fixed at anchor u1 → 3 real turns selected
      // With draft: currentCount = 3 + 1 = 4
      const msgs = [
        msgWithBlock('u1', 'user'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('u2', 'user'),
        msgWithBlock('a2', 'assistant', 'u2'),
        msgWithBlock('u3', 'user'),
        msgWithBlock('a3', 'assistant', 'u3')
      ]

      const withoutDraft = computeContextInfo(
        msgs,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
        }),
        TOPIC_ID
      )

      const withDraft = computeContextInfo(
        msgs,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
        }),
        TOPIC_ID,
        { previewDraft: 'new message' }
      )

      expect(withoutDraft.contextCount.current).toBe(3) // 3 real turns
      expect(withDraft.contextCount.current).toBe(4) // 3 real + 1 virtual
      // Same real messages in output (virtual turn excluded)
      expect(withDraft.uiMessages.length).toBe(withoutDraft.uiMessages.length)
    })

    it('unlimited sliding with draft: currentCount includes virtual turn', () => {
      const msgs = [msgWithBlock('u1', 'user'), msgWithBlock('a1', 'assistant', 'u1')]

      const result = computeContextInfo(msgs, assistantWith({ contextCount: null }), TOPIC_ID, {
        previewDraft: 'new message'
      })

      // 1 real turn + 1 virtual = 2
      expect(result.contextCount.current).toBe(2)
      expect(result.contextCount.max).toBeNull()
    })

    it('previewDraft without topicId still works', () => {
      const msgs = [msgWithBlock('u1', 'user'), msgWithBlock('a1', 'assistant', 'u1')]

      const result = computeContextInfo(msgs, assistantWith({ contextCount: 5 }), undefined, {
        previewDraft: 'new message'
      })

      expect(result.contextCount.current).toBe(2) // 1 real + 1 virtual
    })

    it('undefined assistant with previewDraft returns empty', () => {
      const result = computeContextInfo([msg('u1')], undefined, TOPIC_ID, {
        previewDraft: 'new message'
      })

      expect(result.uiMessages.length).toBe(0)
      expect(result.tokenEstimationMessages.length).toBe(0)
      expect(result.contextCount.current).toBe(0)
    })
  })
})
