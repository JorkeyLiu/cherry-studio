import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  editMessage: vi.fn(),
  editMessageBlocks: vi.fn(),
  selectAnswerMessage: vi.fn(),
  resendUserMessageWithEdit: vi.fn(),
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
  MessageGroupMenuBar: vi.fn((props: { setSelectedMessage?: (message: Message) => void }) => {
    mocks.lastMenuBarProps = props
    return <div className="group-menu-bar">menu</div>
  }),
  HorizontalScrollContainer: vi.fn(({ children }: { children: ReactNode }) => <div>{children}</div>),
  MessageContent: vi.fn(() => <div style={{ minHeight: 600 }}>Long message content</div>),
  MessageEditor: vi.fn(() => <div>editor</div>),
  MessageErrorBoundary: vi.fn(({ children }: { children: ReactNode }) => <>{children}</>),
  MessageHeader: vi.fn(() => <div className="message-header">header</div>),
  MessageMenubar: vi.fn(() => <div className="message-menubar">menubar</div>),
  MessageOutline: vi.fn(() => null)
}))

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
  })
}))

vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => mocks.useChatContext()
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => ({
    editMessage: mocks.editMessage,
    editMessageBlocks: mocks.editMessageBlocks,
    selectAnswerMessage: mocks.selectAnswerMessage,
    resendUserMessageWithEdit: mocks.resendUserMessageWithEdit
  })
}))

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    selectAnswer: mocks.selectAnswerMessage,
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
  useAppDispatch: () => vi.fn()
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

vi.mock('../MessageOutline', () => ({
  default: mocks.MessageOutline
}))

const { default: MessageGroup } = await import('../MessageGroup')
const { deriveStableGroupId } = await import('../messageRenderLayers')

const toDomGroupId = (ids: string[]) => {
  const gid = deriveStableGroupId(ids.map((id) => ({ id }) as Message))
  return `message-group-${gid.replace(/[:|]/g, (ch: string) => (ch === ':' ? '-' : '_'))}`
}

const createMessage = (id: string, index: number, multiModelMessageStyle: Message['multiModelMessageStyle']) =>
  ({
    id,
    askId: 'ask-1',
    role: 'assistant',
    blocks: [],
    multiModelMessageStyle,
    index
  }) as unknown as Message & { index: number }

describe('MessageGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders multi-model groups in fold/tag mode (LOCK-105: always fold)', () => {
    const messages = [createMessage('msg-1', 0, 'horizontal'), createMessage('msg-2', 1, 'horizontal')]
    const topic = { id: 'topic-1' } as Topic

    const { container } = render(<MessageGroup messages={messages} topic={topic} />)

    // The runtime layout is always fold — even when the persisted per-message
    // multiModelMessageStyle field says otherwise (import compatibility).
    const expectedDomId = toDomGroupId(messages.map((m) => m.id))
    const groupContainer = container.querySelector(`#${CSS.escape(expectedDomId)}`)
    expect(groupContainer).not.toBeNull()
    expect(groupContainer!.className).toContain('fold')

    // In fold mode only the selected message is visible (display: inline-block)
    const selectedWrapper = document.getElementById('message-msg-1')
    expect(selectedWrapper).not.toBeNull()
    expect(getComputedStyle(selectedWrapper!).display).toBe('inline-block')

    const hiddenWrapper = document.getElementById('message-msg-2')
    expect(hiddenWrapper).not.toBeNull()
    expect(getComputedStyle(hiddenWrapper!).display).toBe('none')
  })

  it('renders the fold/tag group menu bar (MessageGroupModelList) for grouped assistant messages', () => {
    const messages = [createMessage('msg-1', 0, 'fold'), createMessage('msg-2', 1, 'fold')]
    const topic = { id: 'topic-1' } as Topic

    const { container } = render(<MessageGroup messages={messages} topic={topic} />)

    // MessageGroupMenuBar is mocked to render a "menu" marker.
    expect(container.querySelector('.group-menu-bar')).not.toBeNull()
  })

  it('preserves visible content overflow for the fold layout', () => {
    const messages = [createMessage('msg-1', 0, 'fold'), createMessage('msg-2', 1, 'fold')]
    const topic = { id: 'topic-1' } as Topic

    const { container } = render(<MessageGroup messages={messages} topic={topic} />)

    const contentContainer = container.querySelector('#message-msg-1 .message-content-container')
    expect(contentContainer).not.toBeNull()
    expect(getComputedStyle(contentContainer as HTMLElement).overflowY).toBe('visible')
  })

  it('passes the edit-mode flag as the inline editor reset token (PERF-100)', () => {
    const messages = [createMessage('msg-1', 0, 'fold')]
    const topic = { id: 'topic-1' } as Topic

    const { rerender } = render(<MessageGroup messages={messages} topic={topic} isEditMode={false} />)

    const lastCallProps = mocks.MessageEditingProvider.mock.calls.at(-1)
    expect(lastCallProps?.[0]).toMatchObject({ resetToken: false })

    rerender(<MessageGroup messages={messages} topic={topic} isEditMode={true} />)

    const lastCallPropsAfterToggle = mocks.MessageEditingProvider.mock.calls.at(-1)
    expect(lastCallPropsAfterToggle?.[0]).toMatchObject({ resetToken: true })
  })

  it('selects a message via ONE atomic answer-group command (PERF-100) and preserves the 200ms scroll timer', () => {
    const messages = [
      { ...createMessage('msg-1', 0, 'fold'), foldSelected: true },
      { ...createMessage('msg-2', 1, 'fold'), foldSelected: false }
    ] as unknown as (Message & { index: number })[]
    const topic = { id: 'topic-1' } as Topic

    render(<MessageGroup messages={messages} topic={topic} />)

    // Invoke the real setSelectedMessage callback through the menu bar props.
    const setSelectedMessage = mocks.lastMenuBarProps?.setSelectedMessage
    expect(setSelectedMessage).toBeDefined()
    setSelectedMessage!(messages[1])

    // S3.4: ONE atomic selection via event-time resolved group — explicit
    // target IDs only, never the captured messages array. Controller derives
    // the complete group from Redux at event time.
    expect(mocks.selectAnswerMessage).toHaveBeenCalledTimes(1)
    expect(mocks.selectAnswerMessage).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'msg-2' })
    expect(mocks.editMessage).not.toHaveBeenCalled()

    // The 200ms setTimeoutTimer smooth-scroll contract is preserved exactly.
    expect(mocks.setTimeoutTimer).toHaveBeenCalledTimes(1)
    const [timerKey, timerCallback, delay] = mocks.setTimeoutTimer.mock.calls[0]
    expect(timerKey).toBe('setSelectedMessage')
    expect(delay).toBe(200)
    expect(typeof timerCallback).toBe('function')

    // The timer callback dispatches a smooth scroll into view on the target.
    mocks.setTimeoutTimer.mock.calls[0][1]()
    expect(mocks.scrollIntoView).toHaveBeenCalledWith(expect.anything(), {
      behavior: 'smooth',
      block: 'start',
      container: 'nearest'
    })
  })

  it('separate same-askId groups produce unique deterministic outer DOM ids (S6.2a duplicate-id fix)', () => {
    // Two separate groups sharing the same askId must not collide on outer DOM id
    const groupA = [createMessage('a0', 0, 'fold'), createMessage('a1', 1, 'fold')]
    const groupB = [createMessage('a2', 2, 'fold'), createMessage('a3', 3, 'fold')]
    // Ensure both groups share the same askId but have distinct membership
    expect(groupA[0].askId).toBe(groupB[0].askId)

    const topic = { id: 'topic-1' } as Topic
    const { container: containerA } = render(<MessageGroup messages={groupA} topic={topic} />)
    const { container: containerB } = render(<MessageGroup messages={groupB} topic={topic} />)

    const expectedA = toDomGroupId(groupA.map((m) => m.id))
    const expectedB = toDomGroupId(groupB.map((m) => m.id))
    expect(expectedA).not.toBe(expectedB)

    const elA = containerA.querySelector(`#${CSS.escape(expectedA)}`)
    const elB = containerB.querySelector(`#${CSS.escape(expectedB)}`)
    expect(elA).not.toBeNull()
    expect(elB).not.toBeNull()

    // Direct duplicate old askId selector would have collided; new ids are membership-derived and unique
    const allDomIds = [expectedA, expectedB]
    expect(new Set(allDomIds).size).toBe(2)

    // Stable ids are valid and deterministic: re-rendering same membership yields same DOM id
    const { container: containerA2 } = render(<MessageGroup messages={groupA} topic={topic} />)
    const elA2 = containerA2.querySelector(`#${CSS.escape(expectedA)}`)
    expect(elA2).not.toBeNull()
  })

  it('outer DOM id is stableGroupId-derived and valid (no duplicate even for singleton groups)', () => {
    const solo1 = [createMessage('solo-1', 0, 'fold')] as unknown as (Message & { index: number })[]
    solo1[0].askId = undefined
    solo1[0].role = 'user'
    const solo2 = [createMessage('solo-2', 1, 'fold')] as unknown as (Message & { index: number })[]
    solo2[0].askId = undefined
    solo2[0].role = 'user'
    const topic = { id: 'topic-1' } as Topic
    const { container: c1 } = render(<MessageGroup messages={solo1} topic={topic} />)
    const { container: c2 } = render(<MessageGroup messages={solo2} topic={topic} />)
    const id1 = toDomGroupId(solo1.map((m) => m.id))
    const id2 = toDomGroupId(solo2.map((m) => m.id))
    expect(id1).not.toBe(id2)
    expect(c1.querySelector(`#${CSS.escape(id1)}`)).not.toBeNull()
    expect(c2.querySelector(`#${CSS.escape(id2)}`)).not.toBeNull()
  })
})
