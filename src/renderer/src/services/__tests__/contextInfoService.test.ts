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
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
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
    it('returns current = uiMessages.length and max = settingContextCount', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]
      const result = computeContextInfo(messages, assistantWith({ contextCount: 10 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(result.uiMessages.length)
      expect(result.contextCount.max).toBe(10)
    })

    it('returns current=0 for empty messages', () => {
      const result = computeContextInfo([], assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBe(5)
    })

    it('returns current=0 when assistant is undefined', () => {
      const result = computeContextInfo([msg('u1')], undefined, TOPIC_ID)
      expect(result.contextCount.current).toBe(0)
      expect(result.contextCount.max).toBe(0)
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
  })
})
