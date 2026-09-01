/**
 * Closure-derived context info — authoritative metadata projection (LOCK-001/003).
 *
 * Validates that deriveContextInfoFromClosure projects full-topic semantics
 * from the validated closure response without re-deriving from bounded renderer
 * state, while still applying the existing model/token/UI filter pipeline to
 * closure messages. Fallback path (computeContextInfo) retains bounded
 * viewport behavior.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { computeContextInfo, deriveContextInfoFromClosure } from '@renderer/services/contextInfoService'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reducer = combineReducers({ messageBlocks: messageBlocksSlice.reducer })
const createMockStore = () =>
  configureStore({ reducer, middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false }) })
let mockStore: ReturnType<typeof createMockStore>
vi.mock('@renderer/store', () => ({
  default: { getState: () => mockStore.getState(), dispatch: (action: unknown) => mockStore.dispatch(action as never) }
}))
vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: {
    settings?: { contextCount?: number | null; contextWindowAnchor?: Record<string, any> }
  }) => ({
    contextCount: assistant?.settings?.contextCount === undefined ? 25 : assistant.settings.contextCount,
    contextWindowAnchor: assistant?.settings?.contextWindowAnchor ?? {}
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
const withBlocks = (messages: Message[]): Message[] =>
  messages.map((m) => {
    const blockId = `block-${m.id}`
    mockStore.dispatch(
      messageBlocksSlice.actions.upsertOneBlock({
        id: blockId,
        type: MessageBlockType.MAIN_TEXT,
        content: `c-${m.id}`,
        messageId: m.id
      } as any)
    )
    return { ...m, blocks: [blockId] }
  })

const makeClosure = (
  messages: Message[],
  closure: Partial<FetchContextClosureResponse['closure']>
): FetchContextClosureResponse => {
  const first = messages.length > 0 ? messages[0].id : null
  const last = messages.length > 0 ? messages[messages.length - 1].id : null
  return {
    messages: messages as unknown as FetchContextClosureResponse['messages'],
    blocks: messages.flatMap((m) =>
      m.blocks.map((b) => ({ id: b, messageId: m.id, type: 'main_text', content: `c-${m.id}` }))
    ) as any,
    closure: {
      completeness: 'context-closure',
      topicId: 'topic-1',
      anchorGroupKey: 'm0',
      firstMessageId: first,
      lastMessageId: last,
      returnedCount: messages.length,
      totalTurnCount: 10,
      selectedTurnCount: 10,
      boundaryMessageId: null,
      ...closure
    } as FetchContextClosureResponse['closure']
  }
}

describe('deriveContextInfoFromClosure', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  it('projects whole-topic metadata: selected===total => boundary null, current/max from closure', () => {
    const msgs = withBlocks([
      msg('m0', 'user'),
      msg('m1', 'assistant', 'm0'),
      msg('m2', 'user'),
      msg('m3', 'assistant', 'm2')
    ])
    const closure = makeClosure(msgs, {
      totalTurnCount: 2,
      selectedTurnCount: 2,
      boundaryMessageId: null,
      anchorGroupKey: 'm0',
      firstMessageId: 'm0',
      lastMessageId: 'm3'
    })
    const info = deriveContextInfoFromClosure(closure)
    expect(info.boundaryMessageId).toBeNull()
    expect(info.anchorGroupKey).toBe('m0')
    expect(info.contextCount).toEqual({ current: 2, max: 2 })
    // Filtering still applies: trailing assistant removed from uiMessages
    expect(info.uiMessages.some((m) => m.id === 'm3')).toBe(false)
    expect(info.tokenEstimationMessages.some((m) => m.id === 'm3')).toBe(true)
  })

  it('projects partial metadata: selected<total => boundary equals firstMessageId, current/selected and max/total from closure', () => {
    const msgs = withBlocks([
      msg('m8', 'user'),
      msg('m9', 'assistant', 'm8'),
      msg('m10', 'user'),
      msg('m11', 'assistant', 'm10')
    ])
    const closure = makeClosure(msgs, {
      totalTurnCount: 10,
      selectedTurnCount: 6,
      boundaryMessageId: 'm8',
      anchorGroupKey: 'm8',
      firstMessageId: 'm8',
      lastMessageId: 'm11'
    })
    const info = deriveContextInfoFromClosure(closure)
    expect(info.boundaryMessageId).toBe('m8')
    expect(info.anchorGroupKey).toBe('m8')
    expect(info.contextCount).toEqual({ current: 6, max: 10 })
    expect(info.uiMessages[0]?.id).toBe('m8')
  })

  it('does not recompute from bounded messages: metadata is authoritative even if closure slice would otherwise yield different boundary', () => {
    // Simulate closure that is partial (selected<total) but its firstMessageId is m8.
    // If implementation incorrectly recomputed from closure slice alone (e.g., building turns from closure only),
    // a closure starting at its own first turn would appear whole (boundary null). Authoritative says partial.
    const msgs = withBlocks([msg('m8', 'user'), msg('m9', 'assistant', 'm8')])
    const closurePartial = makeClosure(msgs, {
      totalTurnCount: 10,
      selectedTurnCount: 6,
      boundaryMessageId: 'm8',
      anchorGroupKey: 'm8',
      firstMessageId: 'm8',
      lastMessageId: 'm9'
    })
    const infoPartial = deriveContextInfoFromClosure(closurePartial)
    expect(infoPartial.boundaryMessageId).toBe('m8')
    expect(infoPartial.contextCount).toEqual({ current: 6, max: 10 })

    const closureWhole = makeClosure(msgs, {
      totalTurnCount: 1,
      selectedTurnCount: 1,
      boundaryMessageId: null,
      anchorGroupKey: 'm8',
      firstMessageId: 'm8',
      lastMessageId: 'm9'
    })
    const infoWhole = deriveContextInfoFromClosure(closureWhole)
    expect(infoWhole.boundaryMessageId).toBeNull()
    expect(infoWhole.contextCount).toEqual({ current: 1, max: 1 })
  })

  it('applies same filter pipeline as fallback (empty blocks, trailing assistant, etc.)', () => {
    // Create a message with empty block content that should be filtered out
    const blockIdEmpty = 'block-empty'
    mockStore.dispatch(
      messageBlocksSlice.actions.upsertOneBlock({
        id: blockIdEmpty,
        type: MessageBlockType.MAIN_TEXT,
        content: '   ',
        messageId: 'u1'
      } as any)
    )
    const emptyMsg = { ...msg('u1', 'user'), blocks: [blockIdEmpty] }
    const okMsg = withBlocks([msg('a1', 'assistant', 'u1')])[0]
    // Closure with 2 messages where first will be filtered by empty block
    const closure = makeClosure([emptyMsg, okMsg], {
      totalTurnCount: 2,
      selectedTurnCount: 1,
      boundaryMessageId: 'u1',
      anchorGroupKey: 'u1',
      firstMessageId: 'u1',
      lastMessageId: 'a1'
    })
    const info = deriveContextInfoFromClosure(closure)
    // Empty user message filtered, remainder is assistant-only which is trimmed to empty by leading non-user filter
    expect(info.uiMessages).toEqual([])
    // Metadata still authoritative
    expect(info.boundaryMessageId).toBe('u1')
    expect(info.contextCount).toEqual({ current: 1, max: 2 })
  })

  it('fallback computeContextInfo remains available and derives from bounded viewport (no closure)', () => {
    const msgs = withBlocks([
      msg('m0', 'user'),
      msg('m1', 'assistant', 'm0'),
      msg('m2', 'user'),
      msg('m3', 'assistant', 'm2')
    ])
    const assistant = {
      id: 'assistant-1',
      settings: { contextCount: 1, contextWindowAnchor: {} }
    } as unknown as Assistant
    const fallback = computeContextInfo(msgs, assistant, 'topic-1')
    // Bounded fallback with N=1 selects last turn, boundary at m2
    expect(fallback.boundaryMessageId).toBe('m2')
    expect(fallback.contextCount).toEqual({ current: 1, max: 2 })
  })
})
