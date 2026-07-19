import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

/**
 * Regression: MessageItem must render without EditModeProvider in the tree.
 *
 * MessageItem uses useOptionalEditMode() (not the strict useEditMode) so it
 * gracefully handles the absence of EditModeContext. This test uses the REAL
 * EditModeContext module — no mock — to catch regressions where someone
 * switches back to the strict hook or where the optional hook misbehaves.
 *
 * Heavy child components and hooks are mocked to keep the test focused.
 * EditModeContext is intentionally NOT mocked.
 */

// ── Mocks (hoisted) ────────────────────────────────────────────────────────

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
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children, ...props }: any) => <div {...props}>{children}</div>
}))

// NOTE: EditModeContext is NOT mocked — real useOptionalEditMode runs here.

vi.mock('@renderer/context/MessageEditingContext', () => ({
  MessageEditingProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMessageEditing: () => ({
    editingMessageId: null,
    startEditing: vi.fn(),
    stopEditing: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: null,
    setModel: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => ({ isMultiSelectMode: false })
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => ({
    editMessage: vi.fn(),
    editMessageBlocks: vi.fn(),
    resendUserMessageWithEdit: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useModel: () => null
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    messageFont: 'system',
    fontSize: 14,
    messageStyle: 'plain',
    showMessageOutline: false
  })
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: vi.fn() })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    LOCATE_MESSAGE: 'locate-message',
    EDIT_MESSAGE: 'edit-message',
    NEW_CONTEXT: 'new-context'
  },
  EventEmitter: {
    on: vi.fn(() => vi.fn()),
    off: vi.fn(),
    emit: vi.fn()
  }
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

vi.mock('@renderer/services/db/DbService', () => ({
  DbService: {
    getInstance: () => ({
      getDatabase: vi.fn(),
      execute: vi.fn()
    })
  }
}))

vi.mock('@renderer/utils', () => ({
  classNames: (...args: any[]) =>
    args
      .flat()
      .filter((v) => typeof v === 'string' || (typeof v === 'object' && v))
      .map((v) =>
        typeof v === 'string'
          ? v
          : Object.keys(v)
              .filter((k) => v[k])
              .join(' ')
      )
      .join(' '),
  cn: (...args: any[]) =>
    args
      .flat()
      .filter((v) => typeof v === 'string' || (typeof v === 'object' && v))
      .map((v) =>
        typeof v === 'string'
          ? v
          : Object.keys(v)
              .filter((k) => v[k])
              .join(' ')
      )
      .join(' ')
}))

vi.mock('@renderer/utils/dom', () => ({
  scrollIntoView: vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/is', () => ({
  isMessageProcessing: () => false
}))

vi.mock('antd', () => ({
  Divider: () => <hr />
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('../MessageContent', () => ({ default: () => <div>content</div> }))
vi.mock('../MessageEditor', () => ({ default: () => <div>editor</div> }))
vi.mock('../MessageErrorBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('../MessageHeader', () => ({ default: () => <div>header</div> }))
vi.mock('../MessageMenubar', () => ({ default: () => <div>menubar</div> }))
vi.mock('../MessageOutline', () => ({ default: () => null }))

// ── Import real MessageItem (after mocks) ──────────────────────────────────

const { default: MessageItem } = await import('../Message')

// ── Helpers ────────────────────────────────────────────────────────────────

const makeMessage = (overrides?: Partial<Message>): Message =>
  ({
    id: 'msg-1',
    topicId: 'topic-1',
    role: 'assistant',
    assistantId: 'asst-1',
    askId: 'ask-1',
    blocks: [],
    model: { provider: 'openai', id: 'gpt-4' },
    status: 'success',
    type: 'message',
    ...overrides
  }) as unknown as Message

const topic = { id: 'topic-1' } as Topic

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MessageItem without EditModeProvider', () => {
  it('renders without throwing when no EditModeProvider is in the tree', () => {
    const message = makeMessage()

    const { container } = render(<MessageItem message={message} topic={topic} />)

    // Should render the message content (mocked as "content")
    expect(container.textContent).toContain('content')
  })

  it('renders a user message without EditModeProvider', () => {
    const message = makeMessage({ role: 'user', askId: undefined })

    const { container } = render(<MessageItem message={message} topic={topic} />)

    expect(container.textContent).toContain('content')
  })

  it('selectedGroupIds defaults to empty array without provider (no crash on .includes)', () => {
    // This specifically tests the `editMode?.selectedGroupIds ?? []` path.
    // If useEditMode (strict) were used instead of useOptionalEditMode,
    // this render would throw.
    const message = makeMessage({ role: 'user', askId: undefined })

    // Should not throw during context-menu handler wiring
    expect(() => render(<MessageItem message={message} topic={topic} />)).not.toThrow()
  })
})
