/**
 * Folded (collapsed) turn participation — one definition shared by the actual
 * request, the token-estimation list, the context count and the boundary
 * divider.
 *
 * Fold is a message-level fact: every member of a folded turn carries
 * `folded: true`, so the exclusion source is the message rows themselves, never
 * a loaded/projected window (a turn folded off-window is excluded exactly like
 * one on screen) and never the group catalog. See
 * `docs/adr/context-window.md` (window continuity with folded participation).
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { computeContextInfo, deriveContextInfoFromClosure } from '@renderer/services/contextInfoService'
import {
  excludeFoldedMessages,
  foldedMessageIdsForTopic,
  isMessageFolded
} from '@renderer/services/foldedSegmentService'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { messagesSlice } from '@renderer/store/newMessage'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer,
  messages: messagesSlice.reducer
})
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

const TS = '2026-07-19T00:00:00.000Z'
const TOPIC = 'topic-1'

const msg = (id: string, role: Message['role'] = 'user', askId?: string): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant-1',
  topicId: TOPIC,
  createdAt: TS,
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

/**
 * Fold a set of loaded rows at the MESSAGE level — the only fold the product
 * has. Each member is its own row and carries its own flag, which is exactly
 * what the projection-level fallback reads.
 */
function foldMessages(topicId: string, messageIds: string[], folded = true): void {
  for (const id of messageIds) {
    mockStore.dispatch(
      messagesSlice.actions.addMessage({
        topicId,
        message: { ...msg(id), folded: folded ? true : undefined } as Message
      })
    )
  }
}

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
      topicId: TOPIC,
      anchorGroupKey: 'u1',
      firstMessageId: first,
      lastMessageId: last,
      returnedCount: messages.length,
      totalTurnCount: 3,
      selectedTurnCount: 3,
      boundaryMessageId: null,
      foldedMessageIds: [],
      ...closure
    } as FetchContextClosureResponse['closure']
  }
}

const ids = (messages: Message[]): string[] => messages.map((m) => m.id)

describe('foldedSegmentService — authority exclusion list', () => {
  beforeEach(() => {
    mockStore = createMockStore()
  })

  it('removes folded members from the authority list unconditionally — never re-injected', () => {
    const messages = ['m0', 'm1', 'm2', 'm3'].map((id) => msg(id))

    expect(ids(excludeFoldedMessages(messages, ['m1', 'm2']))).toEqual(['m0', 'm3'])
    // Hidden bodies never come back into a payload: the request path fails
    // closed when its own prompt belongs to a folded group.
    expect(isMessageFolded('m1', ['m1', 'm2'])).toBe(true)
    expect(isMessageFolded('m0', ['m1', 'm2'])).toBe(false)
    expect(isMessageFolded('m1', [])).toBe(false)
    expect(isMessageFolded(undefined, ['m1'])).toBe(false)
    // Identity when the slice is untouched (no needless downstream churn).
    const untouched = [msg('m3')]
    expect(excludeFoldedMessages(untouched, ['m1'])).toBe(untouched)
    expect(excludeFoldedMessages(untouched, undefined)).toBe(untouched)
    const noList = [msg('m1')]
    expect(excludeFoldedMessages(noList, undefined)).toBe(noList)
  })

  it('never consults the renderer projection: an empty/stale window cannot re-enable a folded body', () => {
    const messages = ['m0', 'm1'].map((id) => msg(id))
    // The window holds no fold at all (unloaded) while Main authority reports
    // one — the exclusion still applies. Claiming "no fold" because the window
    // is unloaded is exactly the leak this guards.
    expect(foldedMessageIdsForTopic(TOPIC).size).toBe(0)
    expect(ids(excludeFoldedMessages(messages, ['m1']))).toEqual(['m0'])
    // Stale projection disagrees in both directions; the authority list wins.
    foldMessages(TOPIC, ['m0'], false)
    expect(ids(excludeFoldedMessages(messages, ['m1']))).toEqual(['m0'])
    foldMessages(TOPIC, ['m1'], true)
    expect(ids(excludeFoldedMessages(messages, ['m1']))).toEqual(['m0'])
  })

  it('reads the projection fallback from message rows only', () => {
    foldMessages(TOPIC, ['m1', 'm2'])
    foldMessages(TOPIC, ['m3', 'm4'], false)
    foldMessages('topic-2', ['m5'])

    expect(foldedMessageIdsForTopic(TOPIC)).toEqual(new Set(['m1', 'm2']))
    expect(foldedMessageIdsForTopic('topic-2')).toEqual(new Set(['m5']))
    expect(foldedMessageIdsForTopic('topic-unknown').size).toBe(0)
  })

  it('collects message-level folded flags in foldedMessageIdsForTopic', () => {
    mockStore.dispatch(
      messagesSlice.actions.addMessage({
        topicId: TOPIC,
        message: { ...msg('m10'), folded: true }
      })
    )
    mockStore.dispatch(
      messagesSlice.actions.addMessage({
        topicId: TOPIC,
        message: { ...msg('m11'), folded: false }
      })
    )
    expect(foldedMessageIdsForTopic(TOPIC).has('m10')).toBe(true)
    expect(foldedMessageIdsForTopic(TOPIC).has('m11')).toBe(false)
  })
})

describe('folded participation — context info consistency', () => {
  beforeEach(() => {
    mockStore = createMockStore()
  })

  it('closure projection drops folded bodies while counts stay closure-authoritative', () => {
    const all = withBlocks([
      msg('u1', 'user'),
      msg('a1', 'assistant', 'u1'),
      msg('u2', 'user'),
      msg('a2', 'assistant', 'u2'),
      msg('u3', 'user'),
      msg('a3', 'assistant', 'u3')
    ])
    // The fold comes from the closure response itself (Main authority), not
    // from the renderer catalog: nothing is dispatched here.
    const closure = makeClosure(all, {
      totalTurnCount: 3,
      selectedTurnCount: 3,
      boundaryMessageId: null,
      foldedMessageIds: ['u2', 'a2']
    })

    const info = deriveContextInfoFromClosure(closure)
    // Counts are the Main authority's participating counts — never recomputed
    // from the projected slice.
    expect(info.contextCount).toEqual({ current: 3, max: 3 })
    expect(info.boundaryMessageId).toBeNull()
    expect(ids(info.uiMessages)).toEqual(['u1', 'a1', 'u3'])
    expect(ids(info.tokenEstimationMessages)).toEqual(['u1', 'a1', 'u3', 'a3'])
    // Same exclusion applies to both consumers: no folded body anywhere.
    expect(ids(info.tokenEstimationMessages)).not.toContain('u2')
    expect(ids(info.tokenEstimationMessages)).not.toContain('a2')
  })

  it('bounded fallback drops the folded turn before turn construction (counts and lists agree)', () => {
    const all = withBlocks([
      msg('u1', 'user'),
      msg('a1', 'assistant', 'u1'),
      msg('u2', 'user'),
      msg('a2', 'assistant', 'u2'),
      msg('u3', 'user'),
      msg('a3', 'assistant', 'u3')
    ])
    const assistant = {
      id: 'assistant-1',
      settings: { contextCount: 25, contextWindowAnchor: {} }
    } as unknown as Assistant

    const expanded = computeContextInfo(all, assistant, TOPIC)
    expect(expanded.contextCount).toEqual({ current: 3, max: 3 })

    // The fold is a message-level fact: every member row of the turn carries it.
    foldMessages(TOPIC, ['u2', 'a2'])
    const folded = computeContextInfo(all, assistant, TOPIC)
    // The folded turn leaves the participating turn set that both numbers use.
    expect(folded.contextCount).toEqual({ current: 2, max: 2 })
    expect(ids(folded.uiMessages)).toEqual(['u1', 'a1', 'u3'])
    expect(ids(folded.tokenEstimationMessages)).toEqual(['u1', 'a1', 'u3', 'a3'])
  })
})
