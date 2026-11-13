/**
 * Folded (collapsed) message-group participation — one definition shared by the
 * actual request, the token-estimation list, the context count and the boundary
 * divider.
 *
 * The exclusion source is the authority segment catalog the renderer already
 * holds (`topicSegments`), never a loaded/projected message window: a group
 * folded off-window is excluded exactly like one on screen. See
 * `docs/adr/context-window.md` (window continuity with folded participation).
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { computeContextInfo, deriveContextInfoFromClosure } from '@renderer/services/contextInfoService'
import {
  excludeFoldedMessages,
  foldedMessageIdsForTopic,
  foldedSegmentsForTopic,
  isMessageFolded
} from '@renderer/services/foldedSegmentService'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import topicSegmentReducer, { addSegment } from '@renderer/store/topicSegment'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer,
  topicSegments: topicSegmentReducer
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

/** Authority catalog entry with the required authority fields. */
function segmentEntity(topicId: string, id: string, messageIds: string[], folded: boolean) {
  return {
    id,
    topicId,
    name: `group-${id}`,
    messageIds,
    createdAt: TS,
    updatedAt: TS,
    sortOrder: 0,
    firstMessageId: messageIds[0],
    lastMessageId: messageIds[messageIds.length - 1],
    messageCount: messageIds.length,
    folded
  } as any
}

function foldGroup(topicId: string, id: string, messageIds: string[], folded = true): void {
  mockStore.dispatch(addSegment(segmentEntity(topicId, id, messageIds, folded)))
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

  it('never consults the renderer catalog: an empty/stale projection cannot re-enable a folded body', () => {
    const messages = ['m0', 'm1'].map((id) => msg(id))
    // Redux holds no segment catalog at all (unloaded window) while Main
    // authority reports the fold — the exclusion still applies. Claiming "no
    // fold" because the catalog is unloaded is exactly the leak this guards.
    expect(foldedMessageIdsForTopic(TOPIC).size).toBe(0)
    expect(ids(excludeFoldedMessages(messages, ['m1']))).toEqual(['m0'])
    // Stale projection disagrees in both directions; the authority list wins.
    foldGroup(TOPIC, 'seg-stale', ['m1'], false)
    expect(ids(excludeFoldedMessages(messages, ['m1']))).toEqual(['m0'])
    mockStore = createMockStore()
    foldGroup(TOPIC, 'seg-stale-folded', ['m0'], true)
    expect(ids(excludeFoldedMessages(messages, ['m1']))).toEqual(['m0'])
  })

  it('keeps the catalog helpers as projection-only conveniences (UI/fallback)', () => {
    foldGroup(TOPIC, 'seg-folded', ['m1', 'm2'])
    foldGroup(TOPIC, 'seg-expanded', ['m3', 'm4'], false)
    foldGroup('topic-2', 'seg-other', ['m5'])

    expect(foldedSegmentsForTopic(TOPIC).map((s) => s.id)).toEqual(['seg-folded'])
    expect(foldedMessageIdsForTopic(TOPIC)).toEqual(new Set(['m1', 'm2']))
    expect(foldedMessageIdsForTopic('topic-2')).toEqual(new Set(['m5']))
    expect(foldedMessageIdsForTopic('topic-unknown').size).toBe(0)
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

    foldGroup(TOPIC, 'seg-folded', ['u2', 'a2'])
    const folded = computeContextInfo(all, assistant, TOPIC)
    // The folded turn leaves the participating turn set that both numbers use.
    expect(folded.contextCount).toEqual({ current: 2, max: 2 })
    expect(ids(folded.uiMessages)).toEqual(['u1', 'a1', 'u3'])
    expect(ids(folded.tokenEstimationMessages)).toEqual(['u1', 'a1', 'u3', 'a3'])
  })
})
