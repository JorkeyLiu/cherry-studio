import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  editMessage: vi.fn(),
  editMessageBlocks: vi.fn(),
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
  MessageEditingProvider: vi.fn(({ children }: { children: ReactNode }) => <>{children}</>),
  useMessageEditing: vi.fn().mockReturnValue({
    editingMessageId: null,
    startEditing: vi.fn(),
    stopEditing: vi.fn()
  }),
  MessageGroupMenuBar: vi.fn(() => <div className="group-menu-bar">menu</div>),
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
    resendUserMessageWithEdit: mocks.resendUserMessageWithEdit
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
    const groupContainer = container.querySelector('#message-group-ask-1')
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
})
