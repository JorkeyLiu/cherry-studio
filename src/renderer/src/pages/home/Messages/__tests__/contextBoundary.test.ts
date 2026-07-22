/**
 * Tests for computeContextBoundaryMessageId — the pure helper that determines
 * where the context window boundary falls in the full topic message sequence.
 *
 * Uses the same filter pipeline as ConversationService.filterMessagesPipeline.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant, TopicAnchor } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { computeContextBoundaryMessageId } from '../contextBoundary'

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
      fixedWindowAnchor?: Record<string, TopicAnchor>
    }
  }) => ({
    contextCount: assistant.settings?.contextCount ?? 10,
    contextWindowMode: assistant.settings?.contextWindowMode ?? 'sliding',
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
describe('computeContextBoundaryMessageId', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  describe('sliding mode', () => {
    it('returns null when all messages fit within contextCount + 2', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2'), msg('a2', 'assistant', 'u2'), msg('u3')]
      // 5 messages, contextCount=10 → contextCount+2=12 → all fit
      const result = computeContextBoundaryMessageId(messages, assistantWith({ contextCount: 10 }), TOPIC_ID)
      expect(result).toBeNull()
    })

    it('returns the boundary message when messages exceed contextCount + 2', () => {
      // 20 messages, contextCount=5 → contextCount+2=7
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextBoundaryMessageId(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result).not.toBeNull()
      expect(typeof result).toBe('string')
    })

    it('returns null for empty messages', () => {
      expect(computeContextBoundaryMessageId([], assistantWith({ contextCount: 5 }), TOPIC_ID)).toBeNull()
    })

    it('returns null when assistant is undefined', () => {
      expect(computeContextBoundaryMessageId([msg('u1')], undefined, TOPIC_ID)).toBeNull()
    })
  })

  describe('fixed mode', () => {
    it('active anchor → returns boundary at groupKey message', () => {
      const messages = [
        msg('u1'),
        msg('a1', 'assistant', 'u1'),
        msg('u2'),
        msg('a2', 'assistant', 'u2'),
        msg('u3'),
        msg('a3', 'assistant', 'u3')
      ]

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u2' } }
        }),
        TOPIC_ID
      )

      expect(result).toBe('u2')
    })

    it('active anchor with groupKey at index 0 → returns null (all in context)', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2'), msg('a2', 'assistant', 'u2')]

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'u1' } }
        }),
        TOPIC_ID
      )

      expect(result).toBeNull()
    })

    it('active anchor with deleted groupKey → returns null (vacant-like fallback)', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'nonexistent' } }
        }),
        TOPIC_ID
      )

      // GroupKey not found → no boundary (vacant-like)
      expect(result).toBeNull()
    })

    it('vacant anchor → returns null (no boundary)', () => {
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'vacant' } }
        }),
        TOPIC_ID
      )

      // Vacant → all messages, no boundary
      expect(result).toBeNull()
    })

    it('does NOT fall through to sliding when anchor is missing (vacant/active)', () => {
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const slidingResult = computeContextBoundaryMessageId(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      const fixedVacantResult = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: { kind: 'vacant' } }
        }),
        TOPIC_ID
      )

      // Sliding should produce a boundary
      expect(slidingResult).not.toBeNull()
      // Fixed with vacant should NOT produce a boundary
      expect(fixedVacantResult).toBeNull()
    })

    it('falls through to sliding when no anchor is set (undefined)', () => {
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor → undefined → falls through to sliding
        }),
        TOPIC_ID
      )

      // Should fall through to sliding mode
      expect(result).not.toBeNull()
    })
  })

  describe('unlimited context', () => {
    it('returns null for unlimited context count', () => {
      const messages = Array.from({ length: 100 }, (_, i) => msg(`m${i}`))
      const UNLIMITED = 999999

      const result = computeContextBoundaryMessageId(messages, assistantWith({ contextCount: UNLIMITED }), TOPIC_ID)
      expect(result).toBeNull()
    })
  })
})
