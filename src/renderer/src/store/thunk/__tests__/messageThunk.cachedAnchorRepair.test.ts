/**
 * Cached-path compatibility repair against the REAL `ensureTopicAnchorEstablished`
 * (docs/context-window.md §10, CW-FIX-2).
 *
 * `loadTopicMessagesThunk` must run compatibility repair for a NON-EMPTY
 * cached topic (messages already in Redux, e.g. a fresh branch pre-populated
 * by `cloneMessagesToNewTopicThunk`) before the cached early return. This file
 * proves the PERSISTED-RESULT semantics with the real decision pipeline
 * (`buildContextTurns` + `resolveAnchorEstablishDecision`):
 *
 *   - cached non-empty topic, no anchor       → repair writes the default anchor
 *   - cached non-empty topic, valid anchor    → no write (never recalculated)
 *   - cached non-empty topic, ghost anchor    → repaired to the default anchor
 *   - cached empty topic                      → fetch path runs; no write
 *
 * Call-sequence contract tests (hook mocked) live in
 * `messageThunk.anchorEstablishment.test.ts`.
 */
import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchMessages: vi.fn(),
    fetchMessagesWindow: vi.fn(async (req: any) => {
      const limit = req.limit ?? 10
      return {
        messages: [],
        blocks: [],
        window: {
          kind: 'latest',
          completeness: 'window',
          topicId: req.topicId,
          anchorMessageId: null,
          requested: { limit },
          firstMessageId: null,
          lastMessageId: null,
          returnedCount: 0,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }
    }),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicFulfilled', payload: p })),
    setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p })),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p })),
    updateAssistantSettings: vi.fn((p: unknown) => ({ type: 'updateAssistantSettings', payload: p })),
    loadTopicSegmentsThunk: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

interface StoreState {
  assistants: {
    assistants: Array<{ id: string; settings?: Record<string, unknown>; topics?: Array<{ id: string }> }>
  }
  messages: {
    entities: Record<string, Message>
    messageIdsByTopic: Record<string, string[]>
    loadingByTopic: Record<string, boolean>
    fulfilledByTopic: Record<string, boolean>
    currentTopicId: string | null
  }
}

let storeState: StoreState

// NOTE: anchorService (and its decision pipeline) is intentionally NOT mocked —
// the real ensureTopicAnchorEstablished runs against this store shape.
vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt,
  updateAssistantSettings: mocks.updateAssistantSettings
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    messagesReceived: mocks.messagesReceived,
    setTopicLoading: mocks.setTopicLoading,
    setTopicFulfilled: mocks.setTopicFulfilled,
    setCurrentTopicId: mocks.setCurrentTopicId
  },
  selectMessagesForTopic: (state: unknown, topicId: string) =>
    ((state as StoreState).messages.messageIdsByTopic[topicId] ?? [])
      .map((id: string) => (state as StoreState).messages.entities[id])
      .filter((m: Message | undefined): m is Message => !!m)
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: { settings?: Record<string, unknown> }) => ({
    contextCount: (assistant.settings?.contextCount as number | null | undefined) ?? 1,
    contextWindowAnchor: assistant.settings?.contextWindowAnchor as
      | Record<string, { kind: 'active'; groupKey: string } | undefined>
      | undefined
  })
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchMessages: mocks.fetchMessages,
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    appendMessage: vi.fn(),
    deleteMessagesWithSegments: vi.fn(),
    resetMessagesForResend: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    updateMessage: vi.fn(),
    listBlocksByFile: vi.fn(),
    deleteBlocks: vi.fn()
  }
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: vi.fn(),
  restoreOrdinaryTopic: vi.fn(),
  softDeleteOrdinaryTopic: vi.fn()
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: vi.fn(),
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: mocks.loadTopicSegmentsThunk
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: vi.fn() }),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  addAbortController: vi.fn()
}))

vi.mock('swr', () => ({
  mutate: vi.fn()
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (k: string) => k
  },
  t: (k: string) => k
}))

// --- Helpers --------------------------------------------------------------

const userMsg = (id: string): Message => ({ id, role: 'user' }) as unknown as Message

const assistantMsg = (id: string, askId: string): Message => ({ id, role: 'assistant', askId }) as unknown as Message

const active = (groupKey: string) => ({ kind: 'active' as const, groupKey })

const makeStoreState = (settings: Record<string, unknown>, messageIds: string[]): StoreState => ({
  assistants: {
    assistants: [{ id: 'asst-1', settings, topics: [{ id: 'topic-1' }] }]
  },
  messages: {
    entities: { u1: userMsg('u1'), a1: assistantMsg('a1', 'u1'), u2: userMsg('u2') },
    messageIdsByTopic: { 'topic-1': messageIds },
    loadingByTopic: {},
    fulfilledByTopic: {},
    currentTopicId: null
  }
})

// --- Tests ----------------------------------------------------------------

describe('loadTopicMessagesThunk cached-path repair (real decision pipeline)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = makeStoreState({ contextCount: 1 }, ['u1', 'a1', 'u2'])
  })

  it('writes the default anchor for a cached NON-EMPTY topic with no anchor (no refetch)', async () => {
    // Turns [u1, u2]; contextCount=1 → default window position is the LAST
    // turn (u2).
    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    // Cached path: no refetch, no messagesReceived.
    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(mocks.messagesReceived).not.toHaveBeenCalled()

    // Repair writes the anchor through the ordinary settings dispatch.
    expect(mocks.updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: { 'topic-1': active('u2') } }
    })
  })

  it('never recalculates a VALID cached anchor (no write)', async () => {
    storeState = makeStoreState({ contextCount: 1, contextWindowAnchor: { 'topic-1': active('u1') } }, [
      'u1',
      'a1',
      'u2'
    ])

    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    // Valid persisted anchor (u1, resolvable in the cached turns) is left
    // untouched — exactly-once repair never recalcules a valid anchor.
    expect(mocks.updateAssistantSettings).not.toHaveBeenCalled()
  })

  it('repairs an unresolvable (ghost) cached anchor to the default position', async () => {
    storeState = makeStoreState({ contextCount: 1, contextWindowAnchor: { 'topic-1': active('ghost') } }, [
      'u1',
      'a1',
      'u2'
    ])

    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    expect(mocks.fetchMessages).not.toHaveBeenCalled()
    expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()
    expect(mocks.updateAssistantSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateAssistantSettings).toHaveBeenCalledWith({
      assistantId: 'asst-1',
      settings: { contextWindowAnchor: { 'topic-1': active('u2') } }
    })
  })

  it('an EMPTY cached topic falls through to the fetch path and never receives an anchor', async () => {
    storeState = makeStoreState({ contextCount: 1 }, [])
    // empty topic via window fetch already mocked to return empty window

    const { loadTopicMessagesThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const getState = () => storeState as never

    await loadTopicMessagesThunk('topic-1')(dispatch, getState)

    // Empty cached topic is not "cached" — the fetch path runs and the empty
    // topic stays anchorless (I-1).
    expect(mocks.fetchMessagesWindow).toHaveBeenCalled()
    expect(mocks.messagesReceived).toHaveBeenCalled()
    expect(mocks.updateAssistantSettings).not.toHaveBeenCalled()
  })
})
