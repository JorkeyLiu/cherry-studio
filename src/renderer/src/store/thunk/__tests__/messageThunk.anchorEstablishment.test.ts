/**
 * Anchor establishment + compatibility-repair hooks in the message thunks.
 *
 * First establishment (docs/context-window.md §6): ordinary `sendMessage`
 * persists the topic anchor idempotently AFTER the user message is persisted
 * and added to Redux and BEFORE the assistant response is queued, so the first
 * request resolves the same position.
 *
 * Compatibility repair (docs/context-window.md §10): `loadTopicMessagesThunk`
 * initializes a missing/unresolvable anchor exactly once AFTER a successful
 * load into Redux — on BOTH the fetch path (after `messagesReceived`) and the
 * cached path (a non-empty cached topic, e.g. a fresh branch pre-populated by
 * `cloneMessagesToNewTopicThunk`, runs repair BEFORE the cached early return).
 * Empty cached topics fall through to the fetch path. No render effects exist.
 *
 * The actual persisted-result semantics (valid anchor → no write, empty topic
 * → no write) are proven against the REAL `ensureTopicAnchorEstablished` in
 * `messageThunk.cachedAnchorRepair.test.ts`; this file proves the call
 * sequence with the hook mocked.
 */
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureTopicAnchorEstablished: vi.fn(),
    appendMessage: vi.fn(),
    addMessage: vi.fn((p: unknown) => ({ type: 'newMessages/addMessage', payload: p })),
    upsertManyBlocks: vi.fn(),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', payload: p })),
    messagesReceived: vi.fn((p: unknown) => ({ type: 'newMessages/messagesReceived', payload: p })),
    createAssistantMessage: vi.fn((assistantId: string, topicId: string) => ({
      id: `asst-${topicId}`,
      assistantId,
      topicId,
      role: 'assistant',
      askId: 'user-1',
      status: AssistantMessageStatus.PENDING,
      blocks: []
    })),
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicLoading', payload: p })),
    setCurrentTopicId: vi.fn((p: unknown) => ({ type: 'newMessages/setCurrentTopicId', payload: p })),
    loadTopicSegmentsThunk: vi.fn(),
    queueAdd: vi.fn(),
    transformMessagesAndFetch: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/anchorService', () => ({
  ensureTopicAnchorEstablished: mocks.ensureTopicAnchorEstablished,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    appendMessage: mocks.appendMessage,
    fetchMessages: vi.fn(),
    deleteMessagesWithSegments: vi.fn(),
    resetMessagesForResend: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    selectAnswerMessage: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@renderer/utils/messageUtils/create', () => ({
  createAssistantMessage: mocks.createAssistantMessage,
  createTranslationBlock: vi.fn(),
  resetAssistantMessage: vi.fn()
}))

vi.mock('@renderer/store/messageBlock', () => ({
  upsertManyBlocks: mocks.upsertManyBlocks,
  removeManyBlocks: vi.fn(),
  updateOneBlock: vi.fn(),
  upsertOneBlock: vi.fn()
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: mocks.loadTopicSegmentsThunk
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: () => ({ add: mocks.queueAdd }),
  waitForTopicQueue: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  addAbortController: vi.fn()
}))

vi.mock('@renderer/services/ApiService', () => ({
  transformMessagesAndFetch: mocks.transformMessagesAndFetch
}))

vi.mock('@renderer/services/messageStreaming/callbacks', () => ({
  createCallbacks: vi.fn(() => ({}))
}))

vi.mock('@renderer/services/StreamProcessingService', () => ({
  createStreamProcessor: vi.fn(() => vi.fn())
}))

vi.mock('@renderer/services/SpanManagerService', () => ({
  endSpan: vi.fn()
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

interface StoreState {
  assistants: {
    assistants: Array<{
      id: string
      prompt?: string
      settings?: Record<string, unknown>
      topics?: Array<{ id: string }>
    }>
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

vi.mock('@renderer/store', () => ({
  default: {
    dispatch: vi.fn(),
    getState: () => storeState
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    addMessage: mocks.addMessage,
    messagesReceived: mocks.messagesReceived,
    setTopicLoading: mocks.setTopicLoading,
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'newMessages/setTopicFulfilled', payload: p })),
    setCurrentTopicId: mocks.setCurrentTopicId,
    insertMessageAtIndex: vi.fn((p: unknown) => ({ type: 'newMessages/insertMessageAtIndex', payload: p }))
  },
  selectMessagesForTopic: () => []
}))

// --- Helpers --------------------------------------------------------------

const createUserMessage = (): Message =>
  ({
    id: 'user-1',
    role: 'user',
    assistantId: 'asst-1',
    topicId: 'topic-1',
    status: UserMessageStatus.SUCCESS,
    blocks: ['block-1'],
    mentions: undefined
  }) as unknown as Message

const makeAssistant = () => ({ id: 'asst-1', settings: { contextCount: 5 } })

// Simulates the deep freeze Immer autoFreeze applies to Redux state: the
// request path must never receive (or mutate) one of these objects.
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

// --- Tests ----------------------------------------------------------------

describe('messageThunk anchor hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = {
      assistants: { assistants: [{ id: 'asst-1', settings: { contextCount: 5 }, topics: [{ id: 'topic-1' }] }] },
      messages: {
        entities: {},
        messageIdsByTopic: { 'topic-1': [] },
        loadingByTopic: {},
        fulfilledByTopic: {},
        currentTopicId: null
      }
    }
  })

  describe('sendMessage first establishment', () => {
    it(
      'persists the topic anchor AFTER the user message reaches Redux and BEFORE queueing the response',
      { timeout: 60_000 },
      async () => {
        mocks.appendMessage.mockResolvedValue(undefined)

        const { sendMessage } = await import('../messageThunk')
        const dispatch = vi.fn()
        const getState = () => storeState as never

        await sendMessage(createUserMessage(), [], makeAssistant() as never, 'topic-1')(dispatch, getState)

        // User message persisted first (SQLite append), then Redux add, then anchor establishment.
        expect(mocks.appendMessage).toHaveBeenCalled()
        expect(mocks.addMessage).toHaveBeenCalledWith({ topicId: 'topic-1', message: expect.anything() })

        const addMessageCall = mocks.addMessage.mock.invocationCallOrder[0]
        const establishCall = mocks.ensureTopicAnchorEstablished.mock.invocationCallOrder[0]
        expect(establishCall).toBeGreaterThan(addMessageCall)

        expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledWith(
          expect.any(Function),
          expect.any(Function),
          'asst-1',
          'topic-1'
        )

        // Response is queued (not started) after establishment.
        expect(mocks.queueAdd).toHaveBeenCalledTimes(1)
      }
    )
  })

  describe('first-send frozen assistant snapshot (writable, fresh anchor, caller model override)', () => {
    it(
      'hands request preparation a writable snapshot carrying the fresh anchor and the caller model override — never the frozen Redux assistant',
      { timeout: 60_000 },
      async () => {
        mocks.appendMessage.mockResolvedValue(undefined)

        // Capture the queued response task (mirrors the production queue) so
        // fetchAndProcessAssistantResponseImpl runs against the frozen state.
        let queuedTask: (() => Promise<void>) | undefined
        mocks.queueAdd.mockImplementation(async (task: () => Promise<void>) => {
          queuedTask = task
        })

        // Post-establishment Redux assistant: deeply frozen (Immer autoFreeze),
        // carrying the just-persisted anchor for topic-1, and configured with
        // the STORE model — which differs from the caller's model override so
        // a wholesale-fresh spread regression is caught.
        const freshAssistant = deepFreeze({
          id: 'asst-1',
          name: 'asst-1',
          prompt: 'base prompt',
          type: 'assistant',
          topics: [{ id: 'topic-1' }],
          model: { id: 'store-model', name: 'Store Model' },
          settings: {
            contextCount: 5,
            contextWindowAnchor: { 'topic-1': { kind: 'active', groupKey: 'u1' } }
          }
        })
        storeState = {
          assistants: { assistants: [freshAssistant] },
          messages: {
            entities: {},
            messageIdsByTopic: { 'topic-1': [] },
            loadingByTopic: {},
            fulfilledByTopic: {},
            currentTopicId: null
          }
        }

        // The captured (pre-establishment) assistant snapshot the thunk
        // receives. It is a REAL topic-carrying assistant (Audit F2: the
        // previous fixture lacked `topics` and could fail before the intended
        // assertions) and carries a caller-specific model override — the
        // multi-model mention / append-model / grouped resend shape.
        const staleAssistant = {
          id: 'asst-1',
          name: 'asst-1',
          prompt: 'base prompt',
          type: 'assistant',
          topics: [{ id: 'topic-1' }],
          model: { id: 'caller-model', name: 'Caller Model' },
          settings: { contextCount: 5 }
        }

        const { sendMessage } = await import('../messageThunk')
        const dispatch = vi.fn()
        const getState = () => storeState as never

        await sendMessage(createUserMessage(), [], staleAssistant as never, 'topic-1')(dispatch, getState)
        await queuedTask?.()

        // Request preparation was reached with a single queued response.
        expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(1)
        const requestAssistant = mocks.transformMessagesAndFetch.mock.calls[0][0].assistant as Record<string, unknown>

        // The assistant handed to request preparation is a writable
        // snapshot — NOT the frozen Redux object.
        expect(Object.isFrozen(requestAssistant)).toBe(false)

        // The fresh store settings won, so the snapshot carries the
        // just-persisted anchor (not the stale captured assistant's absence).
        const settings = requestAssistant.settings as { contextWindowAnchor?: Record<string, unknown> }
        expect(settings.contextWindowAnchor?.['topic-1']).toEqual({ kind: 'active', groupKey: 'u1' })

        // The caller-specific model override survives the narrow merge
        // even though the store model differs (regression: a wholesale
        // `...freshAssistant` spread would clobber it with 'store-model').
        expect(requestAssistant.model).toEqual({ id: 'caller-model', name: 'Caller Model' })

        // The Redux-owned object is untouched and still frozen.
        expect(Object.isFrozen(freshAssistant)).toBe(true)
        expect((freshAssistant as { prompt: string }).prompt).toBe('base prompt')

        // Request preparation's prompt mutation (ApiService line ~197) now
        // succeeds on the snapshot and never reaches the frozen Redux object.
        ;(requestAssistant as { prompt: string }).prompt = 'replaced prompt'
        expect(requestAssistant.prompt).toBe('replaced prompt')
        expect((freshAssistant as { prompt: string }).prompt).toBe('base prompt')
      }
    )

    it(
      'preserves the append-model override through appendAssistantResponseThunk while the request resolves the fresh anchor',
      { timeout: 60_000 },
      async () => {
        mocks.appendMessage.mockResolvedValue(undefined)

        // Capture the queued response task (mirrors the production queue) so
        // fetchAndProcessAssistantResponseImpl runs against the frozen state.
        let queuedTask: (() => Promise<void>) | undefined
        mocks.queueAdd.mockImplementation(async (task: () => Promise<void>) => {
          queuedTask = task
        })

        // Post-establishment Redux assistant: deeply frozen with the
        // just-persisted anchor and the STORE model.
        const freshAssistant = deepFreeze({
          id: 'asst-1',
          name: 'asst-1',
          prompt: 'base prompt',
          type: 'assistant',
          topics: [{ id: 'topic-1' }],
          model: { id: 'store-model', name: 'Store Model' },
          settings: {
            contextCount: 5,
            contextWindowAnchor: { 'topic-1': { kind: 'active', groupKey: 'u1' } }
          }
        })
        storeState = {
          assistants: { assistants: [freshAssistant] },
          messages: {
            entities: {
              'user-1': createUserMessage(),
              'asst-msg-1': {
                id: 'asst-msg-1',
                role: 'assistant',
                assistantId: 'asst-1',
                topicId: 'topic-1',
                createdAt: '2026-01-01T00:00:00.000Z',
                askId: 'user-1',
                status: AssistantMessageStatus.SUCCESS,
                blocks: []
              }
            },
            messageIdsByTopic: { 'topic-1': ['user-1', 'asst-msg-1'] },
            loadingByTopic: {},
            fulfilledByTopic: {},
            currentTopicId: null
          }
        }

        const staleAssistant = {
          id: 'asst-1',
          name: 'asst-1',
          prompt: 'base prompt',
          type: 'assistant',
          topics: [{ id: 'topic-1' }],
          model: { id: 'store-model', name: 'Store Model' },
          settings: { contextCount: 5 }
        }

        const { appendAssistantResponseThunk } = await import('../messageThunk')
        const dispatch = vi.fn()
        const getState = () => storeState as never

        await appendAssistantResponseThunk(
          'topic-1',
          'asst-msg-1',
          { id: 'append-model', provider: 'test-provider', name: 'Append Model', group: 'test-group' },
          staleAssistant as never
        )(dispatch, getState)
        await queuedTask?.()

        expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(1)
        const requestAssistant = mocks.transformMessagesAndFetch.mock.calls[0][0].assistant as Record<string, unknown>

        // The append-model override reaches request preparation.
        expect(requestAssistant.model).toMatchObject({ id: 'append-model', name: 'Append Model' })

        // The fresh anchor is observed by the appended request.
        const settings = requestAssistant.settings as { contextWindowAnchor?: Record<string, unknown> }
        expect(settings.contextWindowAnchor?.['topic-1']).toEqual({ kind: 'active', groupKey: 'u1' })

        // The Redux-owned object is untouched and still frozen.
        expect(Object.isFrozen(freshAssistant)).toBe(true)
      }
    )

    it(
      'preserves each mention model override through the multi-model send path while every request resolves the fresh anchor',
      { timeout: 60_000 },
      async () => {
        mocks.appendMessage.mockResolvedValue(undefined)

        // Capture all queued response tasks (one per mentioned model).
        const queuedTasks: Array<() => Promise<void>> = []
        mocks.queueAdd.mockImplementation(async (task: () => Promise<void>) => {
          queuedTasks.push(task)
        })

        const freshAssistant = deepFreeze({
          id: 'asst-1',
          name: 'asst-1',
          prompt: 'base prompt',
          type: 'assistant',
          topics: [{ id: 'topic-1' }],
          model: { id: 'store-model', name: 'Store Model' },
          settings: {
            contextCount: 5,
            contextWindowAnchor: { 'topic-1': { kind: 'active', groupKey: 'u1' } }
          }
        })
        storeState = {
          assistants: { assistants: [freshAssistant] },
          messages: {
            entities: {},
            messageIdsByTopic: { 'topic-1': [] },
            loadingByTopic: {},
            fulfilledByTopic: {},
            currentTopicId: null
          }
        }

        const staleAssistant = {
          id: 'asst-1',
          name: 'asst-1',
          prompt: 'base prompt',
          type: 'assistant',
          topics: [{ id: 'topic-1' }],
          model: { id: 'caller-model', name: 'Caller Model' },
          settings: { contextCount: 5 }
        }

        const mentionA = { id: 'mention-a', provider: 'test-provider', name: 'Mention A', group: 'test-group' }
        const mentionB = { id: 'mention-b', provider: 'test-provider', name: 'Mention B', group: 'test-group' }

        const { sendMessage } = await import('../messageThunk')
        const dispatch = vi.fn()
        const getState = () => storeState as never

        const userMessage: Message = { ...createUserMessage(), mentions: [mentionA, mentionB] }
        await sendMessage(userMessage, [], staleAssistant as never, 'topic-1')(dispatch, getState)
        await Promise.all(queuedTasks.map((task) => task()))

        // One request per mentioned model, each carrying its own model override.
        expect(mocks.transformMessagesAndFetch).toHaveBeenCalledTimes(2)
        const requestedModelIds = mocks.transformMessagesAndFetch.mock.calls.map(
          (call) => (call[0].assistant as { model: { id: string } }).model.id
        )
        expect(requestedModelIds).toEqual(['mention-a', 'mention-b'])

        // Every mention request still resolves the fresh anchor.
        for (const call of mocks.transformMessagesAndFetch.mock.calls) {
          const settings = call[0].assistant.settings as { contextWindowAnchor?: Record<string, unknown> }
          expect(settings.contextWindowAnchor?.['topic-1']).toEqual({ kind: 'active', groupKey: 'u1' })
        }

        // The Redux-owned object is untouched and still frozen.
        expect(Object.isFrozen(freshAssistant)).toBe(true)
      }
    )
  })

  describe('mergeRequestAssistantSnapshot narrow merge', () => {
    // Direct boundary tests of the exported merge helper: the common
    // function every caller path (sendMessage, multi-model mention, append
    // model, grouped resend/regenerate) funnels through.

    const makeFresh = (overrides: Record<string, unknown> = {}) =>
      deepFreeze({
        id: 'asst-1',
        name: 'asst-1',
        prompt: 'fresh base prompt',
        type: 'assistant',
        topics: [{ id: 'topic-1', prompt: 'topic prompt' }],
        model: { id: 'store-model', name: 'Store Model' },
        settings: {
          contextCount: 7,
          contextWindowAnchor: { 'topic-1': { kind: 'active', groupKey: 'u1' } }
        },
        ...overrides
      })

    const makeOrig = (overrides: Record<string, unknown> = {}) => ({
      id: 'asst-1',
      name: 'asst-1',
      prompt: 'caller base prompt',
      type: 'assistant',
      topics: [{ id: 'topic-1' }],
      model: { id: 'caller-model', name: 'Caller Model' },
      settings: { contextCount: 5 },
      ...overrides
    })

    it('retains the caller model override when the store model differs', async () => {
      const { mergeRequestAssistantSnapshot } = await import('../messageThunk')
      const merged = mergeRequestAssistantSnapshot(makeOrig() as never, makeFresh() as never, 'topic-1')

      // Caller request configuration wins for non-settings fields.
      expect(merged.model).toEqual({ id: 'caller-model', name: 'Caller Model' })
      // Only the settings surface is refreshed from the store.
      expect(merged.settings).toEqual(makeFresh().settings)
    })

    it('takes the fresh anchor-bearing settings surface (and only that)', async () => {
      const { mergeRequestAssistantSnapshot } = await import('../messageThunk')
      const fresh = makeFresh()
      const merged = mergeRequestAssistantSnapshot(makeOrig() as never, fresh as never, 'topic-1')

      // The merged settings object IS the fresh store settings object
      // (identity, not a copy) — the anchor is observed by reference.
      expect(merged.settings).toBe(fresh.settings)
      expect(
        (merged.settings as { contextWindowAnchor: Record<string, unknown> }).contextWindowAnchor['topic-1']
      ).toEqual({ kind: 'active', groupKey: 'u1' })
      // The stale caller settings (no anchor) are replaced, not merged.
      expect((merged.settings as { contextCount: number }).contextCount).toBe(7)
    })

    it('returns an independently writable top-level object even when both inputs are frozen', async () => {
      const { mergeRequestAssistantSnapshot } = await import('../messageThunk')
      const merged = mergeRequestAssistantSnapshot(makeOrig() as never, makeFresh() as never, 'topic-1')

      expect(Object.isFrozen(merged)).toBe(false)
      // Request preparation writes `prompt` on the snapshot.
      merged.prompt = 'replaced prompt'
      expect(merged.prompt).toBe('replaced prompt')
    })

    it('never mutates the frozen store object', async () => {
      const { mergeRequestAssistantSnapshot } = await import('../messageThunk')
      const fresh = makeFresh()
      const merged = mergeRequestAssistantSnapshot(makeOrig() as never, fresh as never, 'topic-1')

      expect(Object.isFrozen(fresh)).toBe(true)
      ;(merged as { prompt: string }).prompt = 'replaced prompt'
      expect((fresh as { prompt: string }).prompt).toBe('fresh base prompt')
      expect((merged as { settings: { contextCount: number } }).settings.contextCount).toBe(7)
      expect((fresh as { settings: { contextCount: number } }).settings.contextCount).toBe(7)
    })

    it('retains caller-only fields that the fresh assistant does not carry', async () => {
      const { mergeRequestAssistantSnapshot } = await import('../messageThunk')
      const fresh = makeFresh()
      const merged = mergeRequestAssistantSnapshot(makeOrig({ mcpMode: 'auto' }) as never, fresh as never, 'topic-1')

      expect(merged.mcpMode).toBe('auto')
      // Fresh-only fields still win on the settings surface only.
      expect(merged.settings).toBe(fresh.settings)
    })

    it('composes the topic prompt from the fresh assistant and keeps the fresh base prompt', async () => {
      const { mergeRequestAssistantSnapshot } = await import('../messageThunk')
      const merged = mergeRequestAssistantSnapshot(makeOrig() as never, makeFresh() as never, 'topic-1')

      expect(merged.prompt).toBe('fresh base prompt\ntopic prompt')
    })

    it('keeps the fresh base prompt when the topic carries no prompt', async () => {
      const { mergeRequestAssistantSnapshot } = await import('../messageThunk')
      const fresh = makeFresh({ topics: [{ id: 'topic-1' }] })
      const merged = mergeRequestAssistantSnapshot(makeOrig() as never, fresh as never, 'topic-1')

      expect(merged.prompt).toBe('fresh base prompt')
    })

    it('falls back safely when fresh and orig are the same object (assistant not in store)', async () => {
      const { mergeRequestAssistantSnapshot } = await import('../messageThunk')
      const assistant = deepFreeze(makeFresh())
      const merged = mergeRequestAssistantSnapshot(assistant as never, assistant as never, 'topic-1')

      // Still a writable independent clone — never the frozen input.
      expect(merged).not.toBe(assistant)
      expect(Object.isFrozen(merged)).toBe(false)
      expect(merged.model).toEqual({ id: 'store-model', name: 'Store Model' })
      expect(merged.settings).toBe(assistant.settings)
      expect(merged.prompt).toBe('fresh base prompt\ntopic prompt')
    })
  })

  describe('loadTopicMessagesThunk compatibility repair', () => {
    it('runs the repair AFTER messagesReceived for the topic-owning assistant', async () => {
      const { dbService } = await import('@renderer/services/db')
      vi.mocked(dbService.fetchMessages).mockResolvedValue({ messages: [], blocks: [] })

      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()
      const getState = () => storeState as never

      await loadTopicMessagesThunk('topic-1')(dispatch, getState)

      const receivedCall = mocks.messagesReceived.mock.invocationCallOrder[0]
      const repairCall = mocks.ensureTopicAnchorEstablished.mock.invocationCallOrder[0]
      expect(receivedCall).toBeLessThan(repairCall)
      expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function),
        'asst-1',
        'topic-1'
      )
      expect(mocks.loadTopicSegmentsThunk).toHaveBeenCalled()
    })

    it('runs repair for a NON-EMPTY cached topic before the cached early return (no refetch)', async () => {
      storeState.messages.messageIdsByTopic['topic-1'] = ['user-1']
      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()
      const getState = () => storeState as never

      await loadTopicMessagesThunk('topic-1')(dispatch, getState)

      // Cached path: no refetch, but the repair hook still runs so a
      // pre-populated branch/cached topic missing an anchor is initialized.
      expect(mocks.messagesReceived).not.toHaveBeenCalled()
      expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledTimes(1)
      expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function),
        'asst-1',
        'topic-1'
      )
    })

    it('an EMPTY cached topic is not treated as cached — falls through to the fetch path', async () => {
      storeState.messages.messageIdsByTopic['topic-1'] = []
      const { dbService } = await import('@renderer/services/db')
      vi.mocked(dbService.fetchMessages).mockResolvedValue({ messages: [], blocks: [] })

      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()
      const getState = () => storeState as never

      await loadTopicMessagesThunk('topic-1')(dispatch, getState)

      // Empty cached topic: the fetch path runs (messagesReceived dispatched);
      // the repair hook is invoked after it and no-ops on empty turns (proven
      // by the ensureTopicAnchorEstablished unit tests).
      expect(mocks.messagesReceived).toHaveBeenCalled()
      expect(mocks.ensureTopicAnchorEstablished).toHaveBeenCalledTimes(1)
      const receivedCall = mocks.messagesReceived.mock.invocationCallOrder[0]
      const repairCall = mocks.ensureTopicAnchorEstablished.mock.invocationCallOrder[0]
      expect(receivedCall).toBeLessThan(repairCall)
    })

    it('skips repair when no assistant owns the topic', async () => {
      storeState.assistants.assistants = []
      const { dbService } = await import('@renderer/services/db')
      vi.mocked(dbService.fetchMessages).mockResolvedValue({ messages: [], blocks: [] })

      const { loadTopicMessagesThunk } = await import('../messageThunk')
      const dispatch = vi.fn()
      const getState = () => storeState as never

      await loadTopicMessagesThunk('topic-1')(dispatch, getState)

      expect(mocks.messagesReceived).toHaveBeenCalled()
      expect(mocks.ensureTopicAnchorEstablished).not.toHaveBeenCalled()
    })
  })
})
