/**
 * Closed-snapshot context derivation — explicit snapshot decides content.
 *
 * Validates that the closed UI snapshot path (`snapshotBlocks` provided)
 * resolves blocks exclusively from the explicit map: a block missing from
 * the snapshot is treated as missing, never the global store, so a later
 * store change cannot alter the derivation. The legacy path (no snapshot)
 * keeps the store-backed reads unchanged.
 *
 * Metadata (boundary/count/anchor) stays authoritative from the closure in
 * both modes; only list membership changes with the snapshot.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import {
  computeContextInfo,
  deriveContextInfoFromClosure,
  resolveSharedContextInfo
} from '@renderer/services/contextInfoService'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { createSnapshotBlockMap, type SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
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
      foldedMessageIds: [],
      boundaryMessageId: null,
      ...closure
    } as FetchContextClosureResponse['closure']
  }
}

const plainAssistant = {
  id: 'assistant-1',
  settings: { contextCount: 25, contextWindowAnchor: {} }
} as unknown as Assistant

const anchorAssistant = {
  id: 'assistant-1',
  settings: { contextCount: 25, contextWindowAnchor: { t1: { kind: 'active', groupKey: 'g0' } } }
} as unknown as Assistant

describe('closed-snapshot context derivation', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
  })

  it('closed snapshot excludes what the store still holds; legacy includes it', () => {
    const [u0] = withBlocks([msg('u0', 'user')])
    const closure = makeClosure([u0], {
      totalTurnCount: 2,
      selectedTurnCount: 1,
      foldedMessageIds: [],
      boundaryMessageId: 'u0',
      anchorGroupKey: 'u0',
      firstMessageId: 'u0',
      lastMessageId: 'u0'
    })

    // Empty snapshot: the store block is invisible to the closed path.
    const empty: SnapshotBlockMap = new Map()
    const closed = deriveContextInfoFromClosure(closure, empty)
    expect(closed.uiMessages).toEqual([])
    expect(closed.tokenEstimationMessages).toEqual([])

    // Legacy (no snapshot): the same derivation reads the store block.
    const legacy = deriveContextInfoFromClosure(closure)
    expect(legacy.uiMessages.map((m) => m.id)).toEqual(['u0'])
    expect(legacy.tokenEstimationMessages.map((m) => m.id)).toEqual(['u0'])

    // The exposed snapshot is exactly the one the caller supplied.
    expect(closed.blockSnapshot).toBe(empty)
  })

  it('computeContextInfo threads the snapshot: empty map filters, legacy keeps', () => {
    const [u0] = withBlocks([msg('u0', 'user')])

    const closed = computeContextInfo([u0], plainAssistant, 'topic-1', undefined, null, new Map())
    expect(closed.tokenEstimationMessages).toEqual([])

    const legacy = computeContextInfo([u0], plainAssistant, 'topic-1')
    expect(legacy.tokenEstimationMessages.map((m) => m.id)).toEqual(['u0'])
  })

  it('re-deriving with the same snapshot is stable while the store flips to empty', () => {
    const [u0] = withBlocks([msg('u0', 'user')])
    const snapshot = createSnapshotBlockMap([
      { id: 'block-u0', type: MessageBlockType.MAIN_TEXT, content: 'snap', messageId: 'u0' } as any
    ])
    const closure = makeClosure([u0], {
      totalTurnCount: 2,
      selectedTurnCount: 1,
      foldedMessageIds: [],
      boundaryMessageId: 'u0',
      anchorGroupKey: 'u0',
      firstMessageId: 'u0',
      lastMessageId: 'u0'
    })

    const before = deriveContextInfoFromClosure(closure, snapshot)
    expect(before.tokenEstimationMessages.map((m) => m.id)).toEqual(['u0'])

    // A later store change empties the live block; the same snapshot still decides.
    mockStore.dispatch(
      messageBlocksSlice.actions.upsertOneBlock({
        id: 'block-u0',
        type: MessageBlockType.MAIN_TEXT,
        content: '   ',
        messageId: 'u0'
      } as any)
    )
    const after = deriveContextInfoFromClosure(closure, snapshot)
    expect(after.tokenEstimationMessages.map((m) => m.id)).toEqual(['u0'])
    expect(after.uiMessages.map((m) => m.id)).toEqual(before.uiMessages.map((m) => m.id))

    // Legacy follows the store: the message is now empty-filtered.
    const legacy = deriveContextInfoFromClosure(closure)
    expect(legacy.tokenEstimationMessages).toEqual([])
  })

  it('closure metadata stays authoritative while the snapshot empty-filters the lists', () => {
    const [u0, a0] = withBlocks([msg('u0', 'user'), msg('a0', 'assistant', 'u0')])
    const closure = makeClosure([u0, a0], {
      totalTurnCount: 10,
      selectedTurnCount: 6,
      foldedMessageIds: [],
      boundaryMessageId: 'u0',
      anchorGroupKey: 'u0',
      firstMessageId: 'u0',
      lastMessageId: 'a0'
    })

    const closed = deriveContextInfoFromClosure(closure, new Map())
    expect(closed.uiMessages).toEqual([])
    expect(closed.tokenEstimationMessages).toEqual([])
    expect(closed.boundaryMessageId).toBe('u0')
    expect(closed.anchorGroupKey).toBe('u0')
    expect(closed.contextCount).toEqual({ current: 6, max: 10 })
  })

  it('pending branch exposes the supplied snapshot with pending authority', () => {
    const snapshot = createSnapshotBlockMap([
      { id: 'block-x', type: MessageBlockType.MAIN_TEXT, content: 'x', messageId: 'x' } as any
    ])
    const info = resolveSharedContextInfo([{ id: 'x' }] as any, anchorAssistant, 't1', null, null, snapshot)
    expect(info.isAuthoritativePending).toBe(true)
    expect(info.anchorGroupKey).toBe('g0')
    expect(info.uiMessages).toEqual([])
    expect(info.tokenEstimationMessages).toEqual([])
    expect(info.blockSnapshot).toBe(snapshot)
  })

  it('empty-route fallback threads the snapshot with non-pending authority', () => {
    const snapshot = createSnapshotBlockMap([
      { id: 'block-x', type: MessageBlockType.MAIN_TEXT, content: 'x', messageId: 'x' } as any
    ])
    const info = resolveSharedContextInfo([], plainAssistant, 'topic-1', null, null, snapshot)
    expect(info.isAuthoritativePending).toBe(false)
    expect(info.blockSnapshot).toBe(snapshot)
  })
})
