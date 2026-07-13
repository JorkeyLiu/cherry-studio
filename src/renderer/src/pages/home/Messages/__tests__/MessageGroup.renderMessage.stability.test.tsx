import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
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
    multiModelMessageStyle: 'horizontal',
    gridColumns: 2,
    gridPopoverTrigger: 'click',
    messageFont: 'system',
    fontSize: 14,
    messageStyle: 'plain',
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
  HorizontalScrollContainer: vi.fn(({ children }: { children: ReactNode }) => <div>{children}</div>),
  MessageContent: vi.fn(() => <div style={{ minHeight: 600 }}>Long message content</div>),
  MessageEditor: vi.fn(() => <div>editor</div>),
  MessageErrorBoundary: vi.fn(({ children }: { children: ReactNode }) => <>{children}</>),
  MessageHeader: vi.fn(() => <div className="message-header">header</div>),
  MessageMenubar: vi.fn(() => <div className="message-menubar">menubar</div>),
  MessageOutline: vi.fn(() => null),
  MessageGroupMenuBar: vi.fn(() => <div className="group-menu-bar">menu</div>)
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
  useSettings: () => mocks.useSettings(),
  useMessageGroupSettings: () => ({
    multiModelMessageStyle: 'horizontal',
    gridColumns: 2,
    gridPopoverTrigger: 'click',
    foldDisplayMode: 'tab'
  })
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({
    setTimeoutTimer: mocks.setTimeoutTimer
  })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    LOCATE_MESSAGE: 'locate-message',
    EDIT_MESSAGE: 'edit-message',
    NEW_CONTEXT: 'new-context'
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

vi.mock('../Message', () => ({
  default: function MockMessageItem(props: Record<string, unknown>) {
    return <div data-testid={`message-${(props.message as any)?.id}`}>message</div>
  }
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

describe('MessageGroup renderMessage stability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renderMessage useCallback deps use messageCount (primitive) instead of messages (array)', () => {
    // Read the source file and verify the dependency array uses messageCount, not messages
    const sourcePath = path.resolve(__dirname, '../MessageGroup.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')

    const lines = source.split('\n')
    const renderMessageStart = lines.findIndex((l) => l.includes('const renderMessage = useCallback('))
    expect(renderMessageStart).toBeGreaterThan(-1)

    // Walk forward to find the closing deps array: the line `    ]` followed by `  )`
    let depsStart = -1
    for (let i = renderMessageStart; i < lines.length; i++) {
      // The deps array starts after `],` — find the last `[` before `)`
      if (lines[i].trim().startsWith('[') && i > renderMessageStart + 5) {
        // Check if this is the deps array by looking ahead for `]` then `)`
        const remaining = lines.slice(i).join('\n')
        const closeMatch = remaining.match(/^\s*\[([\s\S]*?)\]\s*\n\s*\)/m)
        if (closeMatch) {
          depsStart = i
          break
        }
      }
    }
    expect(depsStart).toBeGreaterThan(-1)

    // Extract deps content between [ and ]
    const depsBlock = lines.slice(depsStart).join('\n')
    const depsContent = depsBlock.match(/^\s*\[([\s\S]*?)\]\s*$/m)?.[1] || ''
    const deps = depsContent
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)

    // Should contain messageCount (the extracted primitive)
    expect(deps).toContain('messageCount')
    // Should NOT contain bare `messages` (the array reference)
    expect(deps).not.toContain('messages')
  })

  it('extracts messageCount from messages.length before the useCallback', () => {
    const sourcePath = path.resolve(__dirname, '../MessageGroup.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')

    // Verify `const messageCount = messages.length` exists before renderMessage
    const messageCountIdx = source.indexOf('const messageCount = messages.length')
    const renderMessageIdx = source.indexOf('const renderMessage = useCallback')

    expect(messageCountIdx).toBeGreaterThan(-1)
    expect(renderMessageIdx).toBeGreaterThan(messageCountIdx)
  })

  it('renders correctly with multiple messages', () => {
    const messages = [createMessage('msg-1', 0, 'horizontal'), createMessage('msg-2', 1, 'horizontal')]
    const topic = { id: 'topic-1' } as Topic

    const { container } = render(<MessageGroup messages={messages} topic={topic} />)

    expect(container.querySelector('#message-msg-1')).not.toBeNull()
    expect(container.querySelector('#message-msg-2')).not.toBeNull()
  })

  it('renders correctly with a single message', () => {
    const messages = [createMessage('msg-1', 0, 'horizontal')]
    const topic = { id: 'topic-1' } as Topic

    const { container } = render(<MessageGroup messages={messages} topic={topic} />)

    expect(container.querySelector('#message-msg-1')).not.toBeNull()
  })
})
