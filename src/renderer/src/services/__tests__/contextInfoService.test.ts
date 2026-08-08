/**
 * Tests for computeContextInfo — the unified pure function that determines
 * context boundary, context count, and filtered UI messages in a single pipeline.
 *
 * There is exactly ONE context window model (LOCK-CTX-1): anchor-to-topic-end.
 * A valid manual anchor (`contextWindowAnchor[topicId]`) fixes the window start
 * and the window grows as the topic grows. Without a valid anchor, the start is
 * derived from the assistant's default context count (LOCK-CTX-2, LOCK-CTX-4):
 * finite N selects the most recent N turns, null (∞) selects the first turn of
 * the post-clear segment. contextCount result = selected turns / total turns in
 * the post-clear segment, excluding drafts (LOCK-CTX-5).
 *
 * Canonical unit: ContextTurn. contextCount.current and contextCount.max count
 * turns (not messages). The boundary divider marks the first message of the
 * first selected turn when older turns exist.
 *
 * N+2 compensation is removed: selection is by whole turns, so post-selection
 * model filters cannot create partial turn boundaries. The model may receive
 * fewer messages than the expanded turn count after model filters (useful,
 * error-only, trailing assistant, adjacent users) remove individual messages.
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
      contextCount?: number | null
      contextWindowAnchor?: Record<string, TopicAnchor>
    }
  }) => ({
    contextCount: assistant.settings?.contextCount === undefined ? 25 : assistant.settings.contextCount,
    contextWindowAnchor: assistant.settings?.contextWindowAnchor ?? {}
  }),
  getDefaultAssistant: () => ({
    id: 'assistant-default',
    name: 'Default',
    topics: [],
    messages: [],
    type: 'assistant',
    settings: { contextCount: 25 }
  }),
  getDefaultTopic: () => ({ id: 'topic-default', assistantId: 'assistant-default' })
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const msg = (id: string, role: Message['role'] = 'user', askId?: string, type?: 'clear'): Message => ({
  id,
  role,
  askId,
  type,
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
  type?: 'clear',
  store: ReturnType<typeof createMockStore> = mockStore
): Message => {
  const blockId = `block-${id}`
  const m = msg(id, role, askId, type)
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
  contextWindowAnchor?: Record<string, TopicAnchor>
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
  //
  // Messages are created WITHOUT blocks here so the factory is safe to call at
  // module scope (before the mock store exists). Tests that assert filtered
  // uiMessages content wrap results with `withBlocks`.
  const makeMessages = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      return msg(`m${i}`, role as Message['role'], role === 'assistant' ? `m${i - 1}` : undefined)
    })

  // Add MAIN_TEXT blocks for every message so filterEmptyMessages keeps them.
  // Dispatches into the current mockStore (must be called inside a test).
  const withBlocks = (messages: Message[]): Message[] =>
    messages.map((m) => {
      const blockId = `block-${m.id}`
      mockStore.dispatch(
        messageBlocksSlice.actions.upsertOneBlock({
          id: blockId,
          type: MessageBlockType.MAIN_TEXT,
          content: `content-${m.id}`,
          messageId: m.id
        } as any)
      )
      return { ...m, blocks: [blockId] }
    })

  // 20 alternating messages: 10 turns. Last turn is [m18, m19].
  const twentyMessages = makeMessages(20)

  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  describe('no assistant', () => {
    it('returns empty results when assistant is undefined', () => {
      const result = computeContextInfo([msg('u1')], undefined, TOPIC_ID)
      expect(result.uiMessages).toEqual([])
      expect(result.tokenEstimationMessages).toEqual([])
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount).toEqual({ current: 0, max: null })
    })
  })

  describe('default derivation with no anchor (LOCK-CTX-2)', () => {
    it('finite contextCount selects the most recent N turns and never more than N', () => {
      // 10 turns, default N=5 → window = turns 5..9 (5 turns), boundary at m10.
      const messages = withBlocks(twentyMessages)
      const result = computeContextInfo(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBe('m10')
      expect(result.contextCount).toEqual({ current: 5, max: 10 })
      // uiMessages start at the boundary user message m10.
      expect(result.uiMessages[0]?.id).toBe('m10')
    })

    it('finite contextCount smaller than N when topic has few turns → all turns', () => {
      // 3 turns, default N=5 → all 3 turns fit, no boundary.
      const messages = makeMessages(6)
      const result = computeContextInfo(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount).toEqual({ current: 3, max: 3 })
    })

    it('contextCount 1 selects only the most recent turn', () => {
      // 10 turns, default N=1 → window = turn 9 only, boundary at m18.
      const messages = withBlocks(twentyMessages)
      const result = computeContextInfo(messages, assistantWith({ contextCount: 1 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBe('m18')
      expect(result.contextCount).toEqual({ current: 1, max: 10 })
      expect(result.uiMessages[0]?.id).toBe('m18')
    })

    it('null (unlimited) selects the whole post-clear segment', () => {
      // 10 turns, unlimited → window = turns 0..9, no boundary, current === max.
      const messages = withBlocks(twentyMessages)
      const result = computeContextInfo(messages, assistantWith({ contextCount: null }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount).toEqual({ current: 10, max: 10 })
      expect(result.uiMessages[0]?.id).toBe('m0')
    })

    it('empty message list → zero counts and no boundary', () => {
      const result = computeContextInfo([], assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount).toEqual({ current: 0, max: 0 })
      expect(result.uiMessages).toEqual([])
    })

    it('single turn with finite default → current 1 / max 1', () => {
      const result = computeContextInfo([msgWithBlock('u1')], assistantWith({ contextCount: 5 }), TOPIC_ID)
      expect(result.contextCount).toEqual({ current: 1, max: 1 })
      expect(result.uiMessages[0]?.id).toBe('u1')
    })
  })

  describe('manual anchor (LOCK-CTX-1)', () => {
    it('valid anchor fixes the window start; boundary marks the first selected turn', () => {
      // 10 turns, anchor at user message m8 (turn index 4) → window = turns 4..9.
      const messages = withBlocks(twentyMessages)
      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm8' } }
        }),
        TOPIC_ID
      )
      expect(result.boundaryMessageId).toBe('m8')
      expect(result.contextCount).toEqual({ current: 6, max: 10 })
      expect(result.uiMessages[0]?.id).toBe('m8')
    })

    it('anchor at the first turn → no boundary, full segment selected', () => {
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: 5,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm0' } }
        }),
        TOPIC_ID
      )
      expect(result.boundaryMessageId).toBeNull()
      expect(result.contextCount).toEqual({ current: 10, max: 10 })
    })

    it('valid anchor grows with the topic (window is not capped by contextCount)', () => {
      // Anchor at m8, then 4 more turns are appended (xm0..xm7) → 14 turns total.
      const appended = makeMessages(8).map((m) => ({
        ...m,
        id: `x${m.id}`,
        askId: m.askId ? `x${m.askId}` : undefined
      }))
      const grownMessages = [...twentyMessages, ...appended]
      const result = computeContextInfo(
        grownMessages,
        assistantWith({
          contextCount: 5,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm8' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount).toEqual({ current: 10, max: 14 })
    })
  })

  describe('invalid anchor (LOCK-CTX-2 fallback)', () => {
    it('anchor whose turn no longer exists falls back to the default derivation', () => {
      // groupKey 'ghost' does not resolve → finite default N=5 → most recent 5 turns.
      const messages = withBlocks(twentyMessages)
      const result = computeContextInfo(
        messages,
        assistantWith({
          contextCount: 5,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'ghost' } }
        }),
        TOPIC_ID
      )
      expect(result.boundaryMessageId).toBe('m10')
      expect(result.contextCount).toEqual({ current: 5, max: 10 })
      expect(result.uiMessages[0]?.id).toBe('m10')
    })

    it('assistant askId anchor resolves to its user turn', () => {
      // groupKey = askId 'm12' (assistant message in turn index 6) → window = turns 6..9.
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: 5,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm12' } }
        }),
        TOPIC_ID
      )
      expect(result.boundaryMessageId).toBe('m12')
      expect(result.contextCount).toEqual({ current: 4, max: 10 })
    })
  })

  describe('default-derived anchors for every turn kind (LOCK-FIX-1)', () => {
    // These verify that a persisted derived anchor for a non-user boundary turn
    // (assistant-first / orphan assistant / system) RESOLVES and therefore grows
    // with the topic. Pre-fix these keys were unresolvable, so the window fell
    // back to the default derivation every render and SLID (most-recent-N) as the
    // topic grew instead of staying fixed at the derived start.

    it('assistant-first boundary (orphan with askId): persisted derived anchor grows with the topic', () => {
      // Segment starts with an orphan assistant whose user question is absent.
      // With contextCount=1 and a single initial turn, the default anchor is
      // derived from turn 0 → groupKey = the assistant's own message id 'a0'.
      const grown = [msg('a0', 'assistant', 'u0'), ...makeMessages(4)]
      const result = computeContextInfo(
        grown,
        assistantWith({
          contextCount: 1,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'a0' } }
        }),
        TOPIC_ID
      )
      // 3 turns post-growth: [a0], [m0,m1], [m2,m3]. The anchor fixes the start at
      // turn 0 → the window grows to all 3 turns. If the anchor were unresolvable
      // the fallback would select the most recent 1 turn (current 1, boundary m2).
      expect(result.contextCount).toEqual({ current: 3, max: 3 })
      expect(result.boundaryMessageId).toBeNull()
    })

    it('orphan assistant boundary (no askId): persisted derived anchor grows with the topic', () => {
      const grown = [msg('a0', 'assistant'), ...makeMessages(4)]
      const result = computeContextInfo(
        grown,
        assistantWith({
          contextCount: 1,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'a0' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount).toEqual({ current: 3, max: 3 })
      expect(result.boundaryMessageId).toBeNull()
    })

    it('system boundary: persisted derived anchor grows with the topic', () => {
      const grown = [msg('s0', 'system'), ...makeMessages(4)]
      const result = computeContextInfo(
        grown,
        assistantWith({
          contextCount: 1,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 's0' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount).toEqual({ current: 3, max: 3 })
      expect(result.boundaryMessageId).toBeNull()
    })
  })

  describe('context count semantics (LOCK-CTX-5)', () => {
    it('current = selected turns, max = total turns in the post-clear segment', () => {
      // 10 turns, manual anchor at turn index 7 (groupKey m14) → 3 selected / 10 total.
      const result = computeContextInfo(
        twentyMessages,
        assistantWith({
          contextCount: 5,
          contextWindowAnchor: { [TOPIC_ID]: { kind: 'active', groupKey: 'm14' } }
        }),
        TOPIC_ID
      )
      expect(result.contextCount).toEqual({ current: 3, max: 10 })
    })

    it('turns before the last clear message are excluded from both current and max', () => {
      // u0..a1 before clear, then clear, then 4 turns after (m0..m7).
      const messages = [
        msgWithBlock('pre0'),
        msgWithBlock('pre1', 'assistant', 'pre0'),
        msg('clear-1', 'user', undefined, 'clear'),
        ...withBlocks(makeMessages(8))
      ]
      const result = computeContextInfo(messages, assistantWith({ contextCount: 5 }), TOPIC_ID)
      // 4 post-clear turns all fit within N=5.
      expect(result.contextCount).toEqual({ current: 4, max: 4 })
      expect(result.boundaryMessageId).toBeNull()
      expect(result.uiMessages[0]?.id).toBe('m0')
    })

    it('counts semantic turns, not messages', () => {
      // 3 turns = 5 messages (u,a,u,a,u). current counts turns.
      const messages = [
        msgWithBlock('u1'),
        msgWithBlock('a1', 'assistant', 'u1'),
        msgWithBlock('u2'),
        msgWithBlock('a2', 'assistant', 'u2'),
        msgWithBlock('u3')
      ]
      const result = computeContextInfo(messages, assistantWith({ contextCount: null }), TOPIC_ID)
      expect(result.contextCount).toEqual({ current: 3, max: 3 })
    })
  })

  describe('model filters', () => {
    it('uiMessages drops the trailing assistant message; tokenEstimationMessages keeps it', () => {
      const messages = withBlocks(twentyMessages)
      const result = computeContextInfo(messages, assistantWith({ contextCount: null }), TOPIC_ID)
      // 10 turns = 20 messages; trailing assistant (m19) removed from uiMessages only.
      expect(result.uiMessages.some((m) => m.id === 'm19')).toBe(false)
      expect(result.tokenEstimationMessages.some((m) => m.id === 'm19')).toBe(true)
    })
  })
})
