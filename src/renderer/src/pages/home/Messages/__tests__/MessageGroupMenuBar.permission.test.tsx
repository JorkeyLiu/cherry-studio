/**
 * PROJ-13 (A5) MessageGroupMenuBar permission gating (real component).
 *
 * - `disabled` (group-immutable): retry-all button hidden, zero calls.
 * - Enabled + shared loaded member: handler fails closed with zero calls
 *   (Main per-item guard stays final for window-outside members).
 * - Enabled + private group: failed members retried; the first Main
 *   failure stops the batch (no partial-success continuation, no atomicity
 *   claim).
 */
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type * as FindModule from '@renderer/utils/messageUtils/find'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, fakeState } = vi.hoisted(() => ({
  mocks: {
    regenerateAssistant: vi.fn()
  },
  fakeState: {
    current: null as any
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({ regenerateAssistant: mocks.regenerateAssistant })
}))

vi.mock('@renderer/store', () => ({
  default: { getState: () => fakeState.current, dispatch: vi.fn() },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/find', async (importOriginal) => {
  const actual = await importOriginal<typeof FindModule>()
  return { ...actual, getMainTextContent: (m: any) => m._content ?? '' }
})

vi.mock('../MessageGroupModelList', () => ({
  default: () => <div data-testid="model-list-stub" />
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const { default: MessageGroupMenuBar } = await import('../MessageGroupMenuBar')

const topic = { id: 'topic-1' } as Topic

const failedAssistant = (id: string): Message =>
  ({
    id,
    topicId: 'topic-1',
    role: 'assistant',
    assistantId: 'asst-1',
    askId: 'u1',
    blocks: [],
    status: 'error',
    _content: ''
  }) as unknown as Message

const userRoot = (): Message =>
  ({ id: 'u1', topicId: 'topic-1', role: 'user', assistantId: 'asst-1', blocks: [] }) as unknown as Message

function setGroupState(mutableIds: string[]) {
  const entities: Record<string, Message> = { u1: userRoot(), a1: failedAssistant('a1'), a2: failedAssistant('a2') }
  fakeState.current = {
    messages: {
      entities,
      messageIdsByTopic: { 'topic-1': ['u1', 'a1', 'a2'] },
      mutableMessageIdsByTopic: { 'topic-1': mutableIds },
      mutableRouteByTopic: { 'topic-1': null }
    },
    topicBranch: { activeBranchIdByTopic: {} }
  }
  return [entities.a1, entities.a2]
}

function renderBar(messages: Message[], disabled?: boolean) {
  return render(
    <MessageGroupMenuBar
      messages={messages}
      selectMessageId="a1"
      setSelectedMessage={vi.fn()}
      onReorderMessages={vi.fn()}
      topic={topic}
      disabled={disabled}
    />
  )
}

describe('MessageGroupMenuBar permission gating', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.regenerateAssistant.mockResolvedValue(undefined)
    // Pre-warm the handler's dynamic import so each click's async
    // continuation settles within the test's own waits instead of leaking
    // into the next test's shared fakeState (call-count pollution).
    await import('@renderer/store/routeAnswerGroup')
  })

  it('hides retry-all when disabled (group-immutable)', () => {
    const messages = setGroupState(['u1', 'a1'])
    const { unmount } = renderBar(messages, true)
    expect(screen.queryByTestId('group-retry-all-btn')).toBeNull()
    expect(mocks.regenerateAssistant).not.toHaveBeenCalled()
    unmount()
  })

  it('fails closed with zero calls when a loaded member is shared', async () => {
    const messages = setGroupState(['u1', 'a1'])
    const { unmount } = renderBar(messages, false)
    expect(screen.queryByTestId('group-retry-all-btn')).not.toBeNull()
    fireEvent.click(screen.getByTestId('group-retry-all-btn'))
    await vi.waitFor(() => expect(mocks.regenerateAssistant).not.toHaveBeenCalled())
    // Allow any queued microtasks to settle; still zero calls.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.regenerateAssistant).not.toHaveBeenCalled()
    unmount()
  })

  it('retries every failed member of a private group', async () => {
    const messages = setGroupState(['u1', 'a1', 'a2'])
    const { unmount } = renderBar(messages, false)
    fireEvent.click(screen.getByTestId('group-retry-all-btn'))
    await vi.waitFor(() => expect(mocks.regenerateAssistant).toHaveBeenCalledTimes(2))
    expect(mocks.regenerateAssistant).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'a1' })
    expect(mocks.regenerateAssistant).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'a2' })
    unmount()
  })

  it('stops the batch at the first failure without claiming atomicity', async () => {
    const messages = setGroupState(['u1', 'a1', 'a2'])
    mocks.regenerateAssistant.mockRejectedValueOnce(new Error('Main guard rejected a2'))
    const { unmount } = renderBar(messages, false)
    fireEvent.click(screen.getByTestId('group-retry-all-btn'))
    await vi.waitFor(() => expect(mocks.regenerateAssistant).toHaveBeenCalledTimes(1))
    expect(mocks.regenerateAssistant).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'a1' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.regenerateAssistant).toHaveBeenCalledTimes(1)
    unmount()
  })
})
