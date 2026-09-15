/**
 * Loaded-projection semantic/type barrier — focused selector/hook regression.
 *
 * Ordinary renderer Redux message data is a bounded loaded projection of the
 * resident topic, never the whole topic. These tests pin the explicit API
 * against REAL reducers (messages + residentRegistry + messageBlocks):
 *
 * - `undefined` when the topic is not a complete resident projection or
 *   `messageIdsByTopic[topicId]` is absent; a resident topic with an explicit
 *   `[]` returns a defined empty projection.
 * - Reference stability (acceptance-critical): unrelated-topic entity
 *   updates, unrelated block updates, loading/displayCount changes, and
 *   alternate-topic calls must not create new arrays/projection objects for
 *   an unchanged topic. Same-topic entity/ID changes must update.
 * - Projection discriminator (`completeness: 'loaded-projection'`) and the
 *   stored-ID-ref contract.
 */

import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type { RootState } from '@renderer/store'
import { messageBlocksSlice, upsertManyBlocks } from '@renderer/store/messageBlock'
import messagesReducer, {
  EMPTY_LOADED_MESSAGES,
  newMessagesActions,
  selectLoadedMessageIdsForTopic,
  selectLoadedMessagesForTopic,
  selectLoadedTopicProjection
} from '@renderer/store/newMessage'
import residentRegistryReducer, {
  bumpGeneration,
  publishResidentComplete,
  retentionEvict
} from '@renderer/store/residentRegistry'
import type { Message } from '@renderer/types/newMessage'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

// Hook section only: keep the real slices/selectors, but stub the heavy
// module graph of useMessageOperations (thunks/services) like the dedicated
// hook tests do. `useAppSelector` passes through to react-redux so the hooks
// subscribe to the real test store provided below.
vi.mock('@renderer/store', async () => {
  const reactRedux = await import('react-redux')
  return {
    default: { getState: () => ({}), dispatch: vi.fn() },
    useAppDispatch: () => vi.fn(),
    useAppSelector: reactRedux.useSelector
  }
})
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/store/thunk/messageThunk', () => ({
  appendAssistantResponseThunk: vi.fn(),
  branchMessagesToTopicThunk: vi.fn(),
  deleteSingleMessageThunk: vi.fn(),
  initiateTranslationThunk: vi.fn(),
  regenerateAssistantResponseThunk: vi.fn(),
  resendMessageThunk: vi.fn(),
  resendUserMessageWithEditThunk: vi.fn(),
  selectAnswerMessageThunk: vi.fn(),
  updateMessageAndBlocksThunk: vi.fn(),
  updateTranslationBlockThunk: vi.fn()
}))
vi.mock('@renderer/services/ClipboardService', () => ({ deleteSingleMessage: vi.fn() }))
vi.mock('@renderer/services/EventService', () => ({ EVENT_NAMES: {}, EventEmitter: { emit: vi.fn() } }))
vi.mock('@renderer/services/SpanManagerService', () => ({
  appendMessageTrace: vi.fn(),
  pauseTrace: vi.fn(),
  restartTrace: vi.fn()
}))
vi.mock('@renderer/services/TokenService', () => ({ estimateUserPromptUsage: vi.fn() }))
vi.mock('@renderer/utils/messageUtils/usage', () => ({ estimateMessageBlocksUsage: vi.fn() }))

const rootReducer = combineReducers({
  messages: messagesReducer,
  messageBlocks: messageBlocksSlice.reducer,
  residentRegistry: residentRegistryReducer
})

type TestState = ReturnType<typeof rootReducer>
const asRoot = (state: TestState): RootState => state as unknown as RootState

const makeMessage = (id: string, topicId = 'topic-a', overrides: Partial<Message> = {}): Message =>
  ({
    id,
    topicId,
    role: 'user',
    assistantId: 'assistant-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks: [],
    ...overrides
  }) as unknown as Message

const TOPIC_A = 'topic-a'
const TOPIC_B = 'topic-b'

/** Seed a topic via the real publication path and mark it resident. */
function seedResidentTopic(state: TestState, topicId: string, messages: Message[]): TestState {
  let next = rootReducer(state, newMessagesActions.messagesReceived({ topicId, messages }))
  next = rootReducer(next, bumpGeneration(topicId))
  const generation = next.residentRegistry.entries[topicId].applicabilityGeneration
  next = rootReducer(
    next,
    publishResidentComplete({ topicId, generation, windowResponse: { messages, blocks: [] } as never, segments: [] })
  )
  return next
}

function seedBase(): TestState {
  let state = rootReducer(undefined, { type: '@@INIT' } as never)
  state = seedResidentTopic(state, TOPIC_A, [makeMessage('a-1'), makeMessage('a-2')])
  state = seedResidentTopic(state, TOPIC_B, [makeMessage('b-1', TOPIC_B)])
  return state
}

describe('loaded projection selectors (real reducers)', () => {
  it('returns undefined when the topic is not a complete resident projection', () => {
    let state = rootReducer(undefined, { type: '@@INIT' } as never)
    // Loaded IDs exist but residency was never established.
    state = rootReducer(
      state,
      newMessagesActions.messagesReceived({ topicId: TOPIC_A, messages: [makeMessage('a-1')] })
    )
    const root = asRoot(state)
    expect(selectLoadedMessageIdsForTopic(root, TOPIC_A)).toBeUndefined()
    expect(selectLoadedMessagesForTopic(root, TOPIC_A)).toBeUndefined()
    expect(selectLoadedTopicProjection(root, TOPIC_A)).toBeUndefined()
  })

  it('returns undefined when messageIdsByTopic[topicId] is absent despite residency', () => {
    const seeded = seedBase()
    // Synthetic: residency holds but the topic has no loaded ID list.
    const state: TestState = {
      ...seeded,
      messages: { ...seeded.messages, messageIdsByTopic: { ...seeded.messages.messageIdsByTopic } }
    }
    delete state.messages.messageIdsByTopic[TOPIC_A]
    const root = asRoot(state)
    expect(selectLoadedMessageIdsForTopic(root, TOPIC_A)).toBeUndefined()
    expect(selectLoadedMessagesForTopic(root, TOPIC_A)).toBeUndefined()
    expect(selectLoadedTopicProjection(root, TOPIC_A)).toBeUndefined()
  })

  it('returns a defined empty projection for a resident topic with explicit []', () => {
    let state = rootReducer(undefined, { type: '@@INIT' } as never)
    state = seedResidentTopic(state, TOPIC_A, [])
    const root = asRoot(state)
    const ids = selectLoadedMessageIdsForTopic(root, TOPIC_A)
    const messages = selectLoadedMessagesForTopic(root, TOPIC_A)
    const projection = selectLoadedTopicProjection(root, TOPIC_A)
    expect(ids).toBeDefined()
    expect(ids).toHaveLength(0)
    expect(ids).toBe(state.messages.messageIdsByTopic[TOPIC_A])
    expect(messages).toBeDefined()
    expect(messages).toBe(EMPTY_LOADED_MESSAGES)
    expect(projection).toBeDefined()
    expect(projection!.completeness).toBe('loaded-projection')
    expect(projection!.topicId).toBe(TOPIC_A)
    expect(projection!.messageIds).toBe(state.messages.messageIdsByTopic[TOPIC_A])
    expect(projection!.messages).toBe(EMPTY_LOADED_MESSAGES)
  })

  it('exposes the stored ID ref and the projection discriminator', () => {
    const state = seedBase()
    const root = asRoot(state)
    const ids = selectLoadedMessageIdsForTopic(root, TOPIC_A)
    expect(ids).toBe(state.messages.messageIdsByTopic[TOPIC_A])
    const messages = selectLoadedMessagesForTopic(root, TOPIC_A)
    expect(messages!.map((m) => m.id)).toEqual(['a-1', 'a-2'])
    const projection = selectLoadedTopicProjection(root, TOPIC_A)
    expect(projection!.completeness).toBe('loaded-projection')
    expect(projection!.topicId).toBe(TOPIC_A)
    expect(projection!.messageIds).toBe(state.messages.messageIdsByTopic[TOPIC_A])
    expect(projection!.messages).toBe(messages)
  })

  it('returns undefined after retention eviction or generation invalidation', () => {
    const seeded = seedBase()
    const evicted = rootReducer(seeded, retentionEvict(TOPIC_A))
    const evictedRoot = asRoot(evicted)
    expect(selectLoadedMessageIdsForTopic(evictedRoot, TOPIC_A)).toBeUndefined()
    expect(selectLoadedMessagesForTopic(evictedRoot, TOPIC_A)).toBeUndefined()
    expect(selectLoadedTopicProjection(evictedRoot, TOPIC_A)).toBeUndefined()

    const invalidated = rootReducer(seeded, bumpGeneration(TOPIC_A))
    const invalidatedRoot = asRoot(invalidated)
    expect(selectLoadedMessageIdsForTopic(invalidatedRoot, TOPIC_A)).toBeUndefined()
    expect(selectLoadedMessagesForTopic(invalidatedRoot, TOPIC_A)).toBeUndefined()
    expect(selectLoadedTopicProjection(invalidatedRoot, TOPIC_A)).toBeUndefined()

    // The unrelated resident topic is unaffected by either path.
    expect(selectLoadedMessagesForTopic(evictedRoot, TOPIC_B)).toBeDefined()
    expect(selectLoadedMessagesForTopic(invalidatedRoot, TOPIC_B)).toBeDefined()
  })

  it('keeps reference stability across unrelated-topic entity updates', () => {
    const state = seedBase()
    const root = asRoot(state)
    const messagesBefore = selectLoadedMessagesForTopic(root, TOPIC_A)
    const projectionBefore = selectLoadedTopicProjection(root, TOPIC_A)
    const next = rootReducer(
      state,
      newMessagesActions.updateMessage({ topicId: TOPIC_B, messageId: 'b-1', updates: { updatedAt: '2026-02-02' } })
    )
    const nextRoot = asRoot(next)
    expect(selectLoadedMessagesForTopic(nextRoot, TOPIC_A)).toBe(messagesBefore)
    expect(selectLoadedTopicProjection(nextRoot, TOPIC_A)).toBe(projectionBefore)
  })

  it('keeps reference stability across unrelated block updates and loading/displayCount changes', () => {
    const state = seedBase()
    const root = asRoot(state)
    const messagesBefore = selectLoadedMessagesForTopic(root, TOPIC_A)
    const projectionBefore = selectLoadedTopicProjection(root, TOPIC_A)
    let next = rootReducer(state, upsertManyBlocks([{ id: 'unrelated', messageId: 'b-1' } as never]))
    next = rootReducer(next, newMessagesActions.setTopicLoading({ topicId: TOPIC_B, loading: true }))
    next = rootReducer(next, newMessagesActions.setTopicLoading({ topicId: TOPIC_A, loading: true }))
    next = rootReducer(next, newMessagesActions.setDisplayCount(42))
    const nextRoot = asRoot(next)
    expect(selectLoadedMessagesForTopic(nextRoot, TOPIC_A)).toBe(messagesBefore)
    expect(selectLoadedTopicProjection(nextRoot, TOPIC_A)).toBe(projectionBefore)
  })

  it('keeps reference stability across alternate-topic calls', () => {
    const state = seedBase()
    const root = asRoot(state)
    const aMessages = selectLoadedMessagesForTopic(root, TOPIC_A)
    const aProjection = selectLoadedTopicProjection(root, TOPIC_A)
    selectLoadedMessagesForTopic(root, TOPIC_B)
    selectLoadedTopicProjection(root, TOPIC_B)
    selectLoadedMessageIdsForTopic(root, TOPIC_B)
    expect(selectLoadedMessagesForTopic(root, TOPIC_A)).toBe(aMessages)
    expect(selectLoadedTopicProjection(root, TOPIC_A)).toBe(aProjection)
  })

  it('updates on same-topic entity and ID changes', () => {
    const state = seedBase()
    const root = asRoot(state)
    const messagesBefore = selectLoadedMessagesForTopic(root, TOPIC_A)
    const projectionBefore = selectLoadedTopicProjection(root, TOPIC_A)

    const updated = rootReducer(
      state,
      newMessagesActions.updateMessage({ topicId: TOPIC_A, messageId: 'a-1', updates: { updatedAt: '2026-03-03' } })
    )
    const updatedRoot = asRoot(updated)
    const messagesAfter = selectLoadedMessagesForTopic(updatedRoot, TOPIC_A)
    expect(messagesAfter).not.toBe(messagesBefore)
    expect(messagesAfter!.find((m) => m.id === 'a-1')!.updatedAt).toBe('2026-03-03')
    expect(selectLoadedTopicProjection(updatedRoot, TOPIC_A)).not.toBe(projectionBefore)

    const extended = rootReducer(
      updated,
      newMessagesActions.addMessage({ topicId: TOPIC_A, message: makeMessage('a-3') })
    )
    const extendedRoot = asRoot(extended)
    expect(selectLoadedMessagesForTopic(extendedRoot, TOPIC_A)).not.toBe(messagesAfter)
    expect(selectLoadedMessagesForTopic(extendedRoot, TOPIC_A)!.map((m) => m.id)).toEqual(['a-1', 'a-2', 'a-3'])
  })
})

describe('loaded projection hooks (real store)', () => {
  it('preserve undefined at the boundary and stabilize across unrelated updates', async () => {
    const { renderHook, act } = await import('@testing-library/react')
    const { Provider } = await import('react-redux')
    const { createElement } = await import('react')
    const { useLoadedTopicMessages, useLoadedTopicProjection } = await import('@renderer/hooks/useMessageOperations')
    const store = configureStore({ reducer: rootReducer, middleware: (g) => g({ serializableCheck: false }) })
    store.dispatch(newMessagesActions.messagesReceived({ topicId: TOPIC_A, messages: [makeMessage('a-1')] }))

    const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { store, children })
    const messagesHook = renderHook(() => useLoadedTopicMessages(TOPIC_A), { wrapper })
    const projectionHook = renderHook(() => useLoadedTopicProjection(TOPIC_A), { wrapper })
    // Not resident yet: both hooks stay `undefined` at the API boundary.
    expect(messagesHook.result.current).toBeUndefined()
    expect(projectionHook.result.current).toBeUndefined()

    act(() => {
      store.dispatch(bumpGeneration(TOPIC_A))
      const generation = store.getState().residentRegistry.entries[TOPIC_A].applicabilityGeneration
      store.dispatch(
        publishResidentComplete({
          topicId: TOPIC_A,
          generation,
          windowResponse: { messages: [makeMessage('a-1')], blocks: [] } as never,
          segments: []
        })
      )
    })
    const messagesAfterResident = messagesHook.result.current
    const projectionAfterResident = projectionHook.result.current
    expect(messagesAfterResident!.map((m) => m.id)).toEqual(['a-1'])
    expect(projectionAfterResident!.completeness).toBe('loaded-projection')

    // Unrelated-topic entity update + loading change must not create new refs.
    act(() => {
      store.dispatch(newMessagesActions.messagesReceived({ topicId: TOPIC_B, messages: [makeMessage('b-1', TOPIC_B)] }))
      store.dispatch(newMessagesActions.setTopicLoading({ topicId: TOPIC_B, loading: true }))
    })
    expect(messagesHook.result.current).toBe(messagesAfterResident)
    expect(projectionHook.result.current).toBe(projectionAfterResident)
  })
})
