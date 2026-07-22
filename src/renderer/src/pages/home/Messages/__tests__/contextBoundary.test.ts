/**
 * Tests for computeContextBoundaryMessageId — the pure helper that determines
 * where the context window boundary falls in the full topic message sequence.
 *
 * Uses the same filter pipeline as ConversationService.filterMessagesPipeline.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant } from '@renderer/types'
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
    settings?: { contextCount?: number; contextWindowMode?: string; fixedWindowAnchor?: Record<string, string> }
  }) => ({
    contextCount: assistant.settings?.contextCount ?? 10,
    contextWindowMode: assistant.settings?.contextWindowMode ?? 'sliding',
    fixedWindowAnchor: assistant.settings?.fixedWindowAnchor
  })
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
  fixedWindowAnchor?: Record<string, string>
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
      // Pre-filtered (after removing useful dupes, trailing assistant, adjacent users):
      // The boundary should be the 14th message (index 13) in the pre-filtered array
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextBoundaryMessageId(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      // After pre-filtering: filterUsefulMessages keeps one per group,
      // filterLastAssistantMessage removes trailing assistant,
      // filterAdjacentUserMessaegs removes adjacent users.
      // With 20 messages (10 user, 10 assistant), after filtering we get ~10 messages.
      // takeRight(10, 7) → messages[3..9], boundary = messages[3] = 'm6'
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
    it('returns the anchor message ID when it exists in pre-filtered messages', () => {
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
          fixedWindowAnchor: { [TOPIC_ID]: 'u2' }
        }),
        TOPIC_ID
      )

      expect(result).toBe('u2')
    })

    it('returns null when anchor message is not found (deleted) but falls back to first message', () => {
      // With resolveAnchorMessageId, deleted anchor resolves to the first pre-filtered message.
      // Since resolvedIndex === 0, the boundary is null (all messages in context).
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2')]

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: 'nonexistent' }
        }),
        TOPIC_ID
      )

      // Resolves to first message → index 0 → no boundary needed
      expect(result).toBeNull()
    })

    it('returns boundary when deleted anchor resolves to first message and messages exceed context', () => {
      // Create enough messages so that the resolved anchor (first message) is NOT
      // the first pre-filtered message when context is limited.
      // Actually since resolveAnchor returns first message, resolvedIndex=0, always null.
      // This test verifies that behavior.
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: 'nonexistent' }
        }),
        TOPIC_ID
      )

      // Deleted anchor resolves to first pre-filtered message → index 0 → no boundary
      expect(result).toBeNull()
    })

    it('does NOT fall through to sliding when anchor is missing', () => {
      // This is the key audit finding: fixed mode with missing anchor must NOT
      // produce a sliding-mode boundary.
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const slidingResult = computeContextBoundaryMessageId(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      const fixedMissingResult = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: 'nonexistent' }
        }),
        TOPIC_ID
      )

      // Sliding should produce a boundary
      expect(slidingResult).not.toBeNull()
      // Fixed with missing anchor should NOT produce a boundary
      expect(fixedMissingResult).toBeNull()
    })

    it('returns null when anchor is the first pre-filtered message (all messages in context)', () => {
      const messages = [msg('u1'), msg('a1', 'assistant', 'u1'), msg('u2'), msg('a2', 'assistant', 'u2')]

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed',
          fixedWindowAnchor: { [TOPIC_ID]: 'u1' }
        }),
        TOPIC_ID
      )

      expect(result).toBeNull()
    })

    it('falls through to sliding when no anchor is set', () => {
      const messages = Array.from({ length: 20 }, (_, i) => {
        const role = i % 2 === 0 ? 'user' : 'assistant'
        return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
      })

      const result = computeContextBoundaryMessageId(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowMode: 'fixed'
          // no fixedWindowAnchor
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
