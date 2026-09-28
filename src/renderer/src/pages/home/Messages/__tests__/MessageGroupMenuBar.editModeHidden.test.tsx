/**
 * MessageGroupMenuBar edit-mode forced hiding (real component):
 * - In edit mode the bar keeps its DOM structure and occupied height
 *   (same mount as non-edit; display never none) while staying invisible,
 *   noninteractive, and inaccessible (hidden class + inert + aria-hidden,
 *   computed visibility hidden, pointer-events none).
 * - Outside edit mode it renders visibly with no hiding treatment and
 *   ordinary actions remain available.
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

function ownedMessages(): Message[] {
  const entities: Record<string, Message> = { u1: userRoot(), a1: failedAssistant('a1'), a2: failedAssistant('a2') }
  fakeState.current = {
    messages: {
      entities,
      messageIdsByTopic: { 'topic-1': ['u1', 'a1', 'a2'] },
      mutableMessageIdsByTopic: { 'topic-1': ['u1', 'a1', 'a2'] },
      mutableRouteByTopic: { 'topic-1': null }
    },
    topicBranch: { activeBranchIdByTopic: {} }
  }
  return [entities.a1, entities.a2]
}

function renderBar(messages: Message[], isEditMode?: boolean) {
  return render(
    <MessageGroupMenuBar
      messages={messages}
      selectMessageId="a1"
      setSelectedMessage={vi.fn()}
      onReorderMessages={vi.fn()}
      topic={topic}
      isEditMode={isEditMode}
    />
  )
}

function barElement(): HTMLElement {
  const bar = document.querySelector('.group-menu-bar') as HTMLElement | null
  expect(bar).not.toBeNull()
  return bar!
}

describe('MessageGroupMenuBar edit-mode forced hiding', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.regenerateAssistant.mockResolvedValue(undefined)
    await import('@renderer/store/routeAnswerGroup')
  })

  it('stays mounted with identical structure but forced hidden, inert, and inaccessible in edit mode', () => {
    const messages = ownedMessages()
    const { unmount } = renderBar(messages, true)
    const bar = barElement()
    // Same DOM mount as non-edit: model list and retry affordances present.
    expect(bar.querySelector('[data-testid="model-list-stub"]')).not.toBeNull()
    expect(bar.querySelector('[data-testid="group-retry-all-btn"]')).not.toBeNull()
    expect(bar.classList.contains('edit-mode-toolbar-hidden')).toBe(true)
    expect(bar.hasAttribute('inert')).toBe(true)
    expect(bar.getAttribute('aria-hidden')).toBe('true')
    expect(window.getComputedStyle(bar).visibility).toBe('hidden')
    expect(window.getComputedStyle(bar).pointerEvents).toBe('none')
    // Layout-affecting removal never happens: display stays structural.
    expect(window.getComputedStyle(bar).display).not.toBe('none')
    unmount()
  })

  // NOTE: inert click/focus blocking is browser-native and jsdom does not
  // enforce it, so non-execution through the hidden bar is proven by the
  // inert + aria-hidden + visibility contract above together with the
  // group-level capture interception covered in MessageGroup.editModeSelect.
  it('renders visibly with working actions outside edit mode', async () => {
    const messages = ownedMessages()
    const { unmount } = renderBar(messages, false)
    const bar = barElement()
    expect(bar.classList.contains('edit-mode-toolbar-hidden')).toBe(false)
    expect(bar.hasAttribute('inert')).toBe(false)
    expect(bar.hasAttribute('aria-hidden')).toBe(false)
    expect(window.getComputedStyle(bar).visibility).not.toBe('hidden')
    fireEvent.click(screen.getByTestId('group-retry-all-btn'))
    await vi.waitFor(() => expect(mocks.regenerateAssistant).toHaveBeenCalledTimes(2))
    unmount()
  })
})
