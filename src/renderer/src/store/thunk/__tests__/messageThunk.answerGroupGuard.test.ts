/**
 * PROJ-13 answer-group thunk prechecks (group-level, never selected-ID-only).
 *
 * - selectAnswer / selectUseful with a private selected ID but a SHARED
 *   non-selected group member (or shared user root) reject BEFORE any IPC
 *   call and dispatch nothing.
 * - Fully private groups call Main exactly once and commit the loaded
 *   intersection only.
 * - appendAssistantResponse with a shared target group returns early with
 *   zero insert calls (the Main join-group guard stays final).
 */
import type { Message } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    selectAnswerMessage: vi.fn(),
    selectUsefulAnswer: vi.fn(),
    insertMessagesAfterAnchor: vi.fn(),
    updateManyMessages: vi.fn((p: unknown) => ({ type: 'updateManyMessages', p })),
    insertMessageAtIndex: vi.fn((p: unknown) => ({ type: 'insertMessageAtIndex', p })),
    addMessage: vi.fn((p: unknown) => ({ type: 'addMessage', p })),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'updateTopicUpdatedAt', p })),
    getTopicQueue: vi.fn(() => ({ add: vi.fn(() => Promise.resolve()) })),
    waitForTopicQueue: vi.fn(() => Promise.resolve())
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    selectAnswerMessage: mocks.selectAnswerMessage,
    selectUsefulAnswer: mocks.selectUsefulAnswer,
    insertMessagesAfterAnchor: mocks.insertMessagesAfterAnchor
  }
}))

vi.mock('@renderer/store', () => ({
  default: { dispatch: vi.fn(), getState: () => storeState },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    updateManyMessages: mocks.updateManyMessages,
    insertMessageAtIndex: mocks.insertMessageAtIndex,
    addMessage: mocks.addMessage,
    setTopicLoading: vi.fn((p: unknown) => ({ type: 'setTopicLoading', p })),
    setTopicFulfilled: vi.fn((p: unknown) => ({ type: 'setTopicFulfilled', p }))
  }
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt
}))

vi.mock('@renderer/utils/queue', () => ({
  getTopicQueue: mocks.getTopicQueue,
  waitForTopicQueue: mocks.waitForTopicQueue
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (k: string) => k
  },
  t: (k: string) => k
}))

function userMsg(id: string): Message {
  return { id, topicId: 'topic-1', role: 'user', assistantId: 'asst-1', blocks: [] } as unknown as Message
}

function assistantMsg(id: string, askId: string): Message {
  return { id, topicId: 'topic-1', role: 'assistant', assistantId: 'asst-1', askId, blocks: [] } as unknown as Message
}

// Module-level mutable state read by the mocked store.
let storeState: any

function setGroupState(opts: { mutableIds: string[]; activeRoute?: string | null }) {
  const { mutableIds, activeRoute = null } = opts
  const entities = { u1: userMsg('u1'), a1: assistantMsg('a1', 'u1'), a2: assistantMsg('a2', 'u1') }
  storeState = {
    messages: {
      entities,
      messageIdsByTopic: { 'topic-1': ['u1', 'a1', 'a2'] },
      mutableMessageIdsByTopic: { 'topic-1': mutableIds },
      mutableRouteByTopic: { 'topic-1': null }
    },
    topicBranch: {
      activeBranchIdByTopic: activeRoute === null ? {} : { 'topic-1': activeRoute }
    },
    assistants: { assistants: [] },
    messageBlocks: { entities: {} }
  }
}

describe('answer-group thunk prechecks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).toast = { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
  })

  it('selectAnswer rejects on a shared NON-selected member with zero IPC and zero dispatch', async () => {
    // a1 (selected) is private; a2 is shared. Selected-ID-only precheck
    // would pass — the group precheck must fail closed.
    setGroupState({ mutableIds: ['u1', 'a1'] })
    const { selectAnswerMessageThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    await expect(selectAnswerMessageThunk('topic-1', 'a1')(dispatch, () => storeState)).rejects.toThrow()
    expect(mocks.selectAnswerMessage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('selectAnswer rejects on a shared user root with zero IPC', async () => {
    setGroupState({ mutableIds: ['a1', 'a2'] })
    const { selectAnswerMessageThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    await expect(selectAnswerMessageThunk('topic-1', 'a1')(dispatch, () => storeState)).rejects.toThrow()
    expect(mocks.selectAnswerMessage).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('selectAnswer on a private group calls Main once and commits the loaded intersection', async () => {
    setGroupState({ mutableIds: ['u1', 'a1', 'a2'] })
    mocks.selectAnswerMessage.mockResolvedValue({
      topicId: 'topic-1',
      askId: 'u1',
      selectedMessageId: 'a2',
      messageIds: ['a1', 'a2']
    })
    const { selectAnswerMessageThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    await selectAnswerMessageThunk('topic-1', 'a2')(dispatch, () => storeState)
    expect(mocks.selectAnswerMessage).toHaveBeenCalledExactlyOnceWith('topic-1', 'a2', null)
    expect(mocks.updateManyMessages).toHaveBeenCalledOnce()
    const payload = mocks.updateManyMessages.mock.calls[0][0] as {
      topicId: string
      updates: Array<{ messageId: string; updates: { foldSelected: boolean } }>
    }
    expect(payload.topicId).toBe('topic-1')
    expect(payload.updates).toEqual([
      { messageId: 'a1', updates: { foldSelected: false } },
      { messageId: 'a2', updates: { foldSelected: true } }
    ])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('selectUseful rejects on a shared group with zero IPC and zero dispatch', async () => {
    setGroupState({ mutableIds: ['u1', 'a1'] })
    const { selectUsefulAnswerThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    await expect(selectUsefulAnswerThunk('topic-1', 'a1')(dispatch, () => storeState)).rejects.toThrow()
    expect(mocks.selectUsefulAnswer).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('selectUseful on a private group calls Main once with the toggled-only request', async () => {
    setGroupState({ mutableIds: ['u1', 'a1', 'a2'] })
    mocks.selectUsefulAnswer.mockResolvedValue({
      topicId: 'topic-1',
      askId: 'u1',
      usefulMessageId: 'a1',
      messageIds: ['a1', 'a2']
    })
    const { selectUsefulAnswerThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    await selectUsefulAnswerThunk('topic-1', 'a1')(dispatch, () => storeState)
    expect(mocks.selectUsefulAnswer).toHaveBeenCalledExactlyOnceWith('topic-1', 'a1', null)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('appendAssistantResponse on a shared group returns early with zero insert calls', async () => {
    setGroupState({ mutableIds: ['u1', 'a1'] })
    const { appendAssistantResponseThunk } = await import('../messageThunk')
    const dispatch = vi.fn()
    const assistant = { id: 'asst-1', model: { id: 'm', provider: 'p', name: 'M', group: 'g' } } as any
    const model = { id: 'm2', provider: 'p', name: 'M2', group: 'g' } as any
    await appendAssistantResponseThunk('topic-1', 'a1', model, assistant)(dispatch, () => storeState)
    expect(mocks.insertMessagesAfterAnchor).not.toHaveBeenCalled()
  })
})
