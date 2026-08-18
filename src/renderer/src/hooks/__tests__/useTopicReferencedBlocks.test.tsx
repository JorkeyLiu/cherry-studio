/**
 * Phase 2B freshness regression for the Chat-level shared context projection
 * (LOCK-004).
 *
 * Chat.tsx memoizes computeContextInfo on [topicMessages, topicBlocks,
 * assistant, topicId]. computeContextInfo reads message blocks through
 * block-dependent filters (filterEmptyMessages,
 * filterErrorOnlyMessagesWithRelated), so a block-only Redux update
 * (updateOneBlock) can change the projection output without changing the topic
 * message array. This test proves useTopicReferencedBlocks — the dependency
 * added to that memo — invalidates exactly on active-topic referenced block
 * changes and stays silent for unrelated block commits.
 */

import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { useTopicReferencedBlocks } from '@renderer/hooks/useMessageOperations'
import { messageBlocksSlice, updateOneBlock, upsertManyBlocks } from '@renderer/store/messageBlock'
import messagesReducer, { newMessagesActions } from '@renderer/store/newMessage'
import type { MainTextMessageBlock, Message } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — the module graph of useMessageOperations.ts is mocked, but the two
// store slices (messageBlocks, newMessage) stay REAL so the hook subscribes
// through the actual selectors against a real Redux store.
// ---------------------------------------------------------------------------
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
  cloneMessagesToNewTopicThunk: vi.fn(),
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

// ---------------------------------------------------------------------------
// Real store + fixtures
// ---------------------------------------------------------------------------
const reducer = combineReducers({
  messages: messagesReducer,
  messageBlocks: messageBlocksSlice.reducer
})

const createStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

const makeMainTextBlock = (id: string, content = `content-${id}`): MainTextMessageBlock => ({
  id,
  messageId: `m-${id}`,
  type: MessageBlockType.MAIN_TEXT,
  status: MessageBlockStatus.SUCCESS,
  createdAt: '2026-01-01T00:00:00.000Z',
  content
})

const makeMessage = (id: string, blocks: string[]): Message =>
  ({
    id,
    topicId: 'topic-1',
    role: 'user',
    assistantId: 'assistant-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks
  }) as unknown as Message

const TOPIC_ID = 'topic-1'

/** Seed topic-1 with two messages (b1, b2) plus one unrelated block b-other. */
const seedStore = (store: ReturnType<typeof createStore>) => {
  store.dispatch(
    newMessagesActions.messagesReceived({
      topicId: TOPIC_ID,
      messages: [makeMessage('m1', ['b1']), makeMessage('m2', ['b2'])]
    })
  )
  store.dispatch(upsertManyBlocks([makeMainTextBlock('b1'), makeMainTextBlock('b2'), makeMainTextBlock('b-other')]))
}

const renderTopicBlocksHook = (store: ReturnType<typeof createStore>) =>
  renderHook(() => useTopicReferencedBlocks(TOPIC_ID), {
    wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('useTopicReferencedBlocks (Phase 2B shared-projection freshness)', () => {
  it('invalidates on a block-only update of an active-topic referenced block', () => {
    const store = createStore()
    seedStore(store)
    const { result } = renderTopicBlocksHook(store)

    const before = result.current
    expect(before.map((b) => b.id)).toEqual(['b1', 'b2'])

    // Snapshot the message entity: the update below must NOT touch messages.
    const messageBefore = store.getState().messages.entities['m1']

    // A realistic block-only update: the streaming MAIN_TEXT content changes
    // while the topic message array stays identical.
    act(() => {
      store.dispatch(updateOneBlock({ id: 'b1', changes: { content: 'streamed continuation text' } }))
    })

    expect(store.getState().messages.entities['m1']).toBe(messageBefore)
    // The dependency array identity changed — the Chat memo must recompute.
    expect(result.current).not.toBe(before)
    expect(result.current.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect((result.current[0] as MainTextMessageBlock | undefined)?.content).toBe('streamed continuation text')
  })

  it('stays silent when an unrelated block commits (bounded subscription)', () => {
    const store = createStore()
    seedStore(store)
    const { result } = renderTopicBlocksHook(store)

    const before = result.current

    // b-other is not referenced by any topic-1 message — the subscription must
    // not invalidate (identity stays stable, no re-render).
    act(() => {
      store.dispatch(updateOneBlock({ id: 'b-other', changes: { content: 'unrelated streaming' } }))
    })

    expect(result.current).toBe(before)
  })

  it('invalidates when a message starts referencing a block and when that block lands in the store', () => {
    const store = createStore()
    seedStore(store)
    const { result } = renderTopicBlocksHook(store)

    const before = result.current
    expect(before.map((b) => b.id)).toEqual(['b1', 'b2'])

    // m2 now references b3 (blockInstruction-style block append); b3 is not in
    // the store yet, so the selection drops it.
    act(() => {
      store.dispatch(
        newMessagesActions.messagesReceived({
          topicId: TOPIC_ID,
          messages: [makeMessage('m1', ['b1']), makeMessage('m2', ['b3'])]
        })
      )
    })
    expect(result.current.map((b) => b.id)).toEqual(['b1'])
    expect(result.current).not.toBe(before)

    // The referenced block entity is committed — the selection must include it.
    act(() => {
      store.dispatch(upsertManyBlocks([makeMainTextBlock('b3')]))
    })
    expect(result.current.map((b) => b.id)).toEqual(['b1', 'b3'])
    expect(result.current).not.toBe(before)
  })
})
