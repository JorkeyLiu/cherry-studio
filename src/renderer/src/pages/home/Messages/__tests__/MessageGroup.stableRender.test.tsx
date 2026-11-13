/**
 * MessageGroup history isolation (real assembly) — mounts the real
 * MessageGroup + real MessageItem tree (leaf presenters mocked) and proves
 * via per-message render counts that an append-shaped parent rebuild
 * (new messages array, identical canonical entities, pure `updatedAt` topic
 * bump) does NOT re-render unchanged history MessageItems, while a status
 * change, a real topic change, edit-mode toggle, and selection-handler
 * change each correctly propagate.
 *
 * This is not a mock-memo test: the production memo comparators on
 * MessageGroup/MessageItem execute for real; only the leaf presenters
 * (content/header/menubar/outline) are mocked, and their call counts are the
 * render evidence.
 */
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SegmentFoldTransition, { presentationOnlyMessageElementRegistrar } from '../SegmentFoldTransition'

const mocks = vi.hoisted(() => ({
  editMessage: vi.fn(),
  selectAnswerMessage: vi.fn(),
  selectUseful: vi.fn(),
  scrollIntoView: vi.fn(),
  setTimeoutTimer: vi.fn(),
  useChatContext: vi.fn().mockReturnValue({ isMultiSelectMode: false }),
  useSettings: vi.fn().mockReturnValue({
    fontSize: 14,
    showMessageOutline: false
  }),
  EventEmitter: {
    on: vi.fn(() => vi.fn()),
    off: vi.fn(),
    emit: vi.fn()
  },
  lastMenuBarProps: undefined as { setSelectedMessage?: (message: Message) => void } | undefined,
  MessageEditingProvider: vi.fn(({ children }: { children: ReactNode }) => <>{children}</>),
  useMessageEditing: vi.fn().mockReturnValue({
    editingMessageId: null,
    startEditing: vi.fn(),
    stopEditing: vi.fn()
  }),
  MessageGroupMenuBar: vi.fn(() => <div className="group-menu-bar">menu</div>),
  HorizontalScrollContainer: vi.fn(({ children }: { children: ReactNode }) => <div>{children}</div>),
  MessageContent: vi.fn((_props: { message: Message }) => <div>content</div>),
  MessageEditor: vi.fn(() => <div>editor</div>),
  MessageErrorBoundary: vi.fn(({ children }: { children: ReactNode }) => <>{children}</>),
  MessageHeader: vi.fn(() => <div className="message-header">header</div>),
  MessageMenubar: vi.fn(() => <div className="message-menubar">menubar</div>)
}))

const fakeGroupState = vi.hoisted(() => {
  const assistant = (id: string): Record<string, unknown> => ({
    id,
    topicId: 'topic-1',
    role: 'assistant',
    assistantId: 'asst-1',
    askId: 'ask-1',
    blocks: []
  })
  const ids = ['a0', 'a1']
  return {
    current: {
      messages: {
        entities: Object.fromEntries(ids.map((id) => [id, assistant(id)])),
        messageIdsByTopic: { 'topic-1': ids },
        mutableMessageIdsByTopic: { 'topic-1': ids },
        mutableRouteByTopic: { 'topic-1': null }
      },
      topicBranch: { activeBranchIdByTopic: {} }
    }
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    })
  }
}))

vi.mock('@renderer/components/HorizontalScrollContainer', () => ({
  default: mocks.HorizontalScrollContainer
}))

vi.mock('@renderer/context/MessageEditingContext', () => ({
  MessageEditingProvider: mocks.MessageEditingProvider,
  useMessageEditing: () => mocks.useMessageEditing()
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useEditMode: () => ({
    isEnabled: false,
    selectedGroupIds: [],
    handleGroupClick: vi.fn()
  }),
  useOptionalEditMode: () => ({
    isEnabled: false,
    selectedGroupIds: [],
    handleGroupClick: vi.fn()
  }),
  EditModeProvider: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@renderer/utils', () => {
  const flattenClassNames = (value: unknown): string[] => {
    if (!value) return []
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(flattenClassNames)
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, boolean>)
        .filter(([, enabled]) => enabled)
        .map(([className]) => className)
    }
    return []
  }

  return {
    classNames: (value: unknown) => flattenClassNames(value).join(' '),
    cn: (...values: unknown[]) => flattenClassNames(values).join(' ')
  }
})

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: null,
    setModel: vi.fn()
  }),
  useMessageAssistant: () => ({
    assistant: null,
    model: null,
    setModel: vi.fn(),
    updateAssistantSettings: vi.fn()
  }),
  useAssistantSettingsUpdater: () => vi.fn()
}))

vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => mocks.useChatContext()
}))

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    selectAnswer: mocks.selectAnswerMessage,
    selectUseful: mocks.selectUseful,
    regenerateAssistant: vi.fn(),
    resendUser: vi.fn(),
    editSave: vi.fn(),
    resendWithEdit: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useModel: () => null
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => mocks.useSettings()
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({
    setTimeoutTimer: mocks.setTimeoutTimer
  })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    LOCATE_MESSAGE: 'locate-message',
    EDIT_MESSAGE: 'edit-message'
  },
  EventEmitter: mocks.EventEmitter
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getMessageModelId: () => 'model-id'
}))

vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: () => 'model-uniq-id'
}))

vi.mock('@renderer/services/TokenService', () => ({
  estimateMessageUsage: vi.fn().mockResolvedValue(0)
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (selector: (state: unknown) => unknown) => selector(fakeGroupState.current)
}))

vi.mock('@renderer/store/thunk/messageGroupReorder', () => ({
  reorderMessageGroupThunk: vi.fn()
}))

vi.mock('@renderer/utils/dom', () => ({
  scrollIntoView: mocks.scrollIntoView
}))

vi.mock('@renderer/utils/messageUtils/is', () => ({
  isMessageProcessing: () => false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  }),
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  }
}))

vi.mock('../MessageContent', () => ({
  default: mocks.MessageContent
}))

vi.mock('../MessageEditor', () => ({
  default: mocks.MessageEditor
}))

vi.mock('../MessageErrorBoundary', () => ({
  default: mocks.MessageErrorBoundary
}))

vi.mock('../MessageGroupMenuBar', () => ({
  default: mocks.MessageGroupMenuBar
}))

vi.mock('../MessageHeader', () => ({
  default: mocks.MessageHeader
}))

vi.mock('../MessageMenubar', () => ({
  default: mocks.MessageMenubar
}))

const { default: MessageGroup } = await import('../MessageGroup')

type ProjectedMessage = Message & { index: number }

const createMessage = (id: string, index: number, extra?: Partial<Message>): ProjectedMessage =>
  ({
    id,
    askId: 'ask-1',
    role: 'assistant',
    assistantId: 'asst-1',
    topicId: 'topic-1',
    createdAt: '2026-07-19T00:00:00.000Z',
    status: AssistantMessageStatus.SUCCESS,
    blocks: [],
    ...extra,
    index
  }) as unknown as ProjectedMessage

const createTopic = (): Topic =>
  ({
    id: 'topic-1',
    assistantId: 'asst-1',
    name: 'topic',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    messages: []
  }) as unknown as Topic

const renderCountFor = (id: string): number =>
  mocks.MessageContent.mock.calls.filter((call) => (call[0] as { message: Message }).message.id === id).length

describe('MessageGroup stable render isolation (real assembly)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('append-shaped rebuild (new array, same entities, pure updatedAt bump) does not re-render history items', () => {
    const a0 = createMessage('a0', 5)
    const a1 = createMessage('a1', 4)
    const topic = createTopic()
    const registerMessageElement = vi.fn()
    const onGroupClick = vi.fn()

    const { rerender } = render(
      <MessageGroup
        messages={[a0, a1]}
        topic={topic}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    expect(renderCountFor('a0')).toBe(1)
    expect(renderCountFor('a1')).toBe(1)

    // Parent rebuild after an append elsewhere: fresh array identity, same
    // canonical entity refs, topic object replaced with only updatedAt moved
    // (the per-send updateTopicUpdatedAt shape).
    rerender(
      <MessageGroup
        messages={[a0, a1]}
        topic={{ ...topic, updatedAt: '2026-07-19T00:00:01.000Z' }}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    expect(renderCountFor('a0')).toBe(1)
    expect(renderCountFor('a1')).toBe(1)
  })

  it('a single message status change re-renders only its owner item', () => {
    const a0 = createMessage('a0', 1)
    const a1 = createMessage('a1', 0)
    const topic = createTopic()
    const registerMessageElement = vi.fn()
    const onGroupClick = vi.fn()

    const { rerender } = render(
      <MessageGroup
        messages={[a0, a1]}
        topic={topic}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    expect(renderCountFor('a0')).toBe(1)
    expect(renderCountFor('a1')).toBe(1)

    const a0Failed = createMessage('a0', 1, { status: AssistantMessageStatus.ERROR })
    rerender(
      <MessageGroup
        messages={[a0Failed, a1]}
        topic={topic}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    expect(renderCountFor('a0')).toBe(2)
    expect(renderCountFor('a1')).toBe(1)
  })

  it('a real topic field change invalidates history items (no stale topic)', () => {
    const a0 = createMessage('a0', 1)
    const a1 = createMessage('a1', 0)
    const topic = createTopic()
    const registerMessageElement = vi.fn()
    const onGroupClick = vi.fn()

    const { rerender } = render(
      <MessageGroup
        messages={[a0, a1]}
        topic={topic}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    rerender(
      <MessageGroup
        messages={[a0, a1]}
        topic={{ ...topic, name: 'renamed' }}
        registerMessageElement={registerMessageElement}
        onGroupClick={onGroupClick}
      />
    )
    expect(renderCountFor('a0')).toBe(2)
    expect(renderCountFor('a1')).toBe(2)
  })

  it('edit-mode toggle and selection-handler change propagate (never stale)', () => {
    const a0 = createMessage('a0', 1)
    const a1 = createMessage('a1', 0)
    const topic = createTopic()
    const registerMessageElement = vi.fn()

    const { rerender } = render(
      <MessageGroup
        messages={[a0, a1]}
        topic={topic}
        registerMessageElement={registerMessageElement}
        onGroupClick={vi.fn()}
      />
    )
    expect(renderCountFor('a0')).toBe(1)

    rerender(
      <MessageGroup
        messages={[a0, a1]}
        topic={topic}
        registerMessageElement={registerMessageElement}
        onGroupClick={vi.fn()}
        isEditMode
      />
    )
    expect(renderCountFor('a0')).toBe(2)
    expect(renderCountFor('a1')).toBe(2)
  })

  it('fold-selection change on one member re-renders only its owner item', () => {
    const a0 = createMessage('a0', 1)
    const a1 = createMessage('a1', 0)
    const topic = createTopic()

    const { rerender } = render(<MessageGroup messages={[a0, a1]} topic={topic} />)
    expect(renderCountFor('a0')).toBe(1)
    expect(renderCountFor('a1')).toBe(1)

    const a1Selected = createMessage('a1', 0, { foldSelected: true })
    rerender(<MessageGroup messages={[a0, a1Selected]} topic={topic} />)
    expect(renderCountFor('a0')).toBe(1)
    expect(renderCountFor('a1')).toBe(2)
  })
})

/**
 * Presentation-only retained body.
 *
 * Mounts the real `MessageGroup` (its own registry effect, real `MessageItem`
 * rows) through the real fold transition, and proves the closing body that is
 * still painted while the exit motion runs can never become a durable reading
 * anchor: the rows stay in the DOM but leave the message-element registry, the
 * host is inert, and the settled folded state owns no body at all (zero flow).
 *
 * The `inert ? presentationOnlyMessageElementRegistrar : registerMessageElement`
 * binding mirrors the production `renderBody` in Messages.tsx; the registrar
 * below is the production export, and the unregister itself comes from
 * MessageGroup's existing effect cleanup (no second authority is added).
 */
describe('presentation-only fold body (registry + inert contract)', () => {
  const originalGetAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getAnimations')
  const originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
  const settleAnimations: Array<() => void> = []

  beforeEach(() => {
    settleAnimations.length = 0
    // A real box height: the motion refuses to arm a clip it cannot measure.
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 200,
          bottom: 60,
          width: 200,
          height: 60,
          toJSON() {}
        }
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value(this: HTMLElement) {
        if (!this.dataset.segmentFoldPhase) return []
        return [
          {
            finished: new Promise<void>((resolve) => {
              settleAnimations.push(resolve)
            })
          }
        ]
      }
    })
  })

  afterEach(() => {
    if (originalGetAnimations) {
      Object.defineProperty(HTMLElement.prototype, 'getAnimations', originalGetAnimations)
    } else {
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
    }
    if (originalGetBoundingClientRect) {
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', originalGetBoundingClientRect)
    } else {
      delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
    }
  })

  it('keeps the closing rows painted but unregistered and inert, and settles to zero flow', async () => {
    const a0 = createMessage('a0', 1)
    const a1 = createMessage('a1', 0)
    const topic = createTopic()
    // Stable array identity: production passes the same `groupMessages` array
    // to the retained body, so the registry effect only re-runs on the channel.
    const groupMessages = [a0, a1]
    const registry = new Map<string, HTMLElement>()
    const registerMessageElement = vi.fn((id: string, element: HTMLElement | null) => {
      if (element) registry.set(id, element)
      else registry.delete(id)
    })
    const onGroupClick = vi.fn()

    const renderFoldBody = (folded: boolean) => (
      <SegmentFoldTransition
        folded={folded}
        renderBody={({ includeFolded: _includeFolded, inert }) => (
          <MessageGroup
            messages={groupMessages}
            topic={topic}
            registerMessageElement={inert ? presentationOnlyMessageElementRegistrar : registerMessageElement}
            isEditMode={false}
            onGroupClick={inert ? undefined : onGroupClick}
          />
        )}
      />
    )

    const { rerender, container } = render(renderFoldBody(false))
    // Live body: the real rows publish their stable DOM anchors and own them.
    expect(registry.size).toBe(2)
    expect(registry.has('a0')).toBe(true)
    expect(registry.has('a1')).toBe(true)
    expect(container.querySelector('#message-a0')).not.toBeNull()

    rerender(renderFoldBody(true))

    // Exit motion: the body is still painted...
    const motionHost = container.querySelector('[data-segment-fold-phase="closing"]') as HTMLElement | null
    expect(motionHost).not.toBeNull()
    expect(container.querySelector('#message-a0')).not.toBeNull()
    // ...but it owns nothing: inert for the whole motion, and out of the
    // registry (the live channel's own cleanup unregistered both members).
    expect(motionHost?.hasAttribute('inert')).toBe(true)
    expect(registry.size).toBe(0)
    const unregistered = registerMessageElement.mock.calls.filter((call) => call[1] === null).map((call) => call[0])
    expect(unregistered).toEqual(expect.arrayContaining(['a0', 'a1']))

    // Settled folded: no body, no phase host (zero flow), registry still empty.
    await act(async () => {
      settleAnimations[0]?.()
    })
    expect(container.querySelector('[data-segment-fold-phase]')).toBeNull()
    expect(container.querySelector('#message-a0')).toBeNull()
    expect(registry.size).toBe(0)
  })
})
