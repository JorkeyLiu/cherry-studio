/**
 * Turn-level fold thunk — the renderer's only fold write path.
 *
 * Claim under test: ONE atomic Main command is issued from stable turn ids, and
 * only the LOADED intersection of the resolved membership is patched into the
 * projection (`true` / absent key — never `false`), followed by a context-closure
 * invalidation for the addressed route. A rejected command rethrows untouched:
 * the thunk itself never toasts and never touches the selection.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type { AppDispatch, RootState } from '@renderer/store'
import newMessageReducer from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setTurnFoldsMock, bumpAndInvalidateMock } = vi.hoisted(() => ({
  setTurnFoldsMock: vi.fn(),
  bumpAndInvalidateMock: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: { setTurnFolds: (...args: unknown[]) => setTurnFoldsMock(...args) }
}))

vi.mock('@renderer/services/contextClosure', () => ({
  bumpAndInvalidate: (...args: unknown[]) => bumpAndInvalidateMock(...args)
}))

import { setTurnFoldsThunk } from '../turnFold'

const TOPIC = 'topic-1'

const makeMessage = (id: string, folded?: true): Message =>
  ({ id, topicId: TOPIC, role: 'assistant', blocks: [], ...(folded ? { folded } : {}) }) as unknown as Message

/**
 * Real messages slice so the projection patch is an actual reducer commit, with
 * only the listed ids loaded for the topic.
 */
/** Production messages slice alone: the projection patch is a real reducer commit. */
const messagesReducer = combineReducers({ messages: newMessageReducer })

function makeStore(messages: Message[], loadedIds: string[]) {
  const entities: Record<string, Message> = {}
  for (const message of messages) entities[message.id] = message
  return configureStore({
    reducer: messagesReducer,
    preloadedState: {
      messages: {
        entities,
        messageIdsByTopic: { [TOPIC]: loadedIds },
        loadingByTopic: {},
        displayCount: 20,
        currentTopicId: TOPIC
      }
    } as never
  })
}

/** The test store carries only the real messages slice; view it as the app root state. */
const asRootState = (store: ReturnType<typeof makeStore>): RootState => store.getState() as unknown as RootState

const createDispatch = (store: ReturnType<typeof makeStore>): AppDispatch =>
  ((action: unknown) =>
    typeof action === 'function'
      ? (action as (d: unknown, g: () => unknown) => unknown)(store.dispatch, store.getState)
      : store.dispatch(action as never)) as unknown as AppDispatch

describe('setTurnFoldsThunk', () => {
  beforeEach(() => {
    setTurnFoldsMock.mockReset()
    bumpAndInvalidateMock.mockReset()
  })

  it('issues ONE atomic command from stable turn ids and patches the loaded intersection', async () => {
    // u1/a1 are loaded; a2 belongs to the same resolved turn but is outside the
    // window, so it must NOT be injected into the projection.
    const store = makeStore(
      [makeMessage('u1'), makeMessage('a1'), makeMessage('a2'), makeMessage('u3')],
      ['u1', 'a1', 'u3']
    )
    setTurnFoldsMock.mockResolvedValue({
      topicId: TOPIC,
      folded: true,
      turns: [
        { groupId: 'u1', messageIds: ['u1', 'a1', 'a2'], folded: true },
        { groupId: 'u3', messageIds: ['u3'], folded: true }
      ],
      affectedMessageIds: ['u1', 'a1', 'a2', 'u3']
    })

    const dispatch = createDispatch(store)
    const getState = () => asRootState(store)
    await setTurnFoldsThunk(TOPIC, ['u1', 'u3'], true, 'branch-1')(dispatch, getState)

    // The command carries ONLY stable turn ids and the addressed route.
    expect(setTurnFoldsMock).toHaveBeenCalledTimes(1)
    expect(setTurnFoldsMock).toHaveBeenCalledWith(TOPIC, ['u1', 'u3'], true, 'branch-1')

    const state = store.getState().messages
    expect(state.entities['u1'].folded).toBe(true)
    expect(state.entities['a1'].folded).toBe(true)
    expect(state.entities['u3'].folded).toBe(true)
    // Window-outside member: authoritative in Main, never injected here.
    expect(state.entities['a2'].folded).toBeUndefined()
    expect(state.messageIdsByTopic[TOPIC]).toEqual(['u1', 'a1', 'u3'])
    // Fold changes context participation without changing membership/order.
    expect(bumpAndInvalidateMock).toHaveBeenCalledTimes(1)
    expect(bumpAndInvalidateMock).toHaveBeenCalledWith(TOPIC, 'branch-1')
  })

  it('removes the flag (absent key, never `false`) when unfolding', async () => {
    const store = makeStore([makeMessage('u1', true), makeMessage('a1', true)], ['u1', 'a1'])
    setTurnFoldsMock.mockResolvedValue({
      topicId: TOPIC,
      folded: false,
      turns: [{ groupId: 'u1', messageIds: ['u1', 'a1'], folded: false }],
      affectedMessageIds: ['u1', 'a1']
    })

    await setTurnFoldsThunk(TOPIC, ['u1'], false, null)(createDispatch(store), () => asRootState(store))

    const state = store.getState().messages
    expect(state.entities['u1'].folded).toBeNull()
    expect(state.entities['a1'].folded).toBeNull()
    expect(bumpAndInvalidateMock).toHaveBeenCalledWith(TOPIC, null)
  })

  it('never calls Main for an empty or id-less selection', async () => {
    const store = makeStore([makeMessage('u1')], ['u1'])
    await setTurnFoldsThunk(TOPIC, [], true)(createDispatch(store), () => asRootState(store))
    await setTurnFoldsThunk(TOPIC, ['', ''], true)(createDispatch(store), () => asRootState(store))
    expect(setTurnFoldsMock).not.toHaveBeenCalled()
    expect(bumpAndInvalidateMock).not.toHaveBeenCalled()
  })

  it('rethrows a rejected command without toasting or clearing the selection', async () => {
    const store = makeStore([makeMessage('u1')], ['u1'])
    setTurnFoldsMock.mockRejectedValue(new Error('rejected by Main'))
    const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
    ;(window as unknown as { toast: unknown }).toast = toast

    await expect(
      setTurnFoldsThunk(TOPIC, ['u1'], true)(createDispatch(store), () => asRootState(store))
    ).rejects.toThrow('rejected by Main')

    expect(store.getState().messages.entities['u1'].folded).toBeUndefined()
    expect(bumpAndInvalidateMock).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
