/**
 * Edit-mode message-toolbar hiding contract (MessageItem level):
 * - The ordinary message menubar keeps its DOM/layout mount in edit mode
 *   but is forcibly hidden, noninteractive, and inaccessible
 *   (edit-mode-toolbar-hidden + inert + aria-hidden); outside edit mode it
 *   renders visibly with no hiding treatment.
 * - Hover preview is owned by the turn container (one neutral outline per
 *   Q&A turn), never per MessageItem; messages keep the pointer cursor.
 */
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { editModeValue } = vi.hoisted(() => ({
  editModeValue: {
    current: { selectedGroupIds: [] as string[] }
  }
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
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children, ...props }: any) => <div {...props}>{children}</div>
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useOptionalEditMode: () => ({ isEnabled: true, selectedGroupIds: editModeValue.current.selectedGroupIds })
}))

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
  useChatContext: () => ({ isMultiSelectMode: false })
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => ({
    editMessage: vi.fn(),
    editMessageBlocks: vi.fn(),
    resendUserMessageWithEdit: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    editSave: vi.fn().mockResolvedValue(true),
    resendWithEdit: vi.fn().mockResolvedValue(true),
    regenerateAssistant: vi.fn(),
    resendUser: vi.fn(),
    selectAnswer: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useModel: () => null
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    fontSize: 14,
    showMessageOutline: false
  })
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: vi.fn() })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    LOCATE_MESSAGE: 'locate-message',
    EDIT_MESSAGE: 'edit-message'
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
vi.mock('../MessageMenubar', () => ({
  default: () => (
    <div data-testid="menubar-stub">
      menubar
      <span className="message-footer-metadata">09/27 08:14 · Tokens: 6</span>
    </div>
  )
}))
vi.mock('../MessageOutline', () => ({ default: () => null }))

const { default: MessageItem } = await import('../Message')

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

describe('MessageItem edit-mode toolbar hiding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    editModeValue.current.selectedGroupIds = []
  })

  it('messages keep the pointer cursor with no per-message preview marker', () => {
    const { container } = render(<MessageItem message={makeMessage()} topic={topic} isEditMode />)
    const messageEl = container.querySelector('.edit-mode-message') as HTMLElement
    expect(messageEl).not.toBeNull()
    expect(messageEl.classList.contains('edit-mode-unselected')).toBe(false)
    expect(window.getComputedStyle(messageEl).cursor).toBe('pointer')
  })

  it('menubar stays mounted but forced hidden, noninteractive, and inaccessible in edit mode', () => {
    const { container } = render(<MessageItem message={makeMessage()} topic={topic} isEditMode />)
    // Layout mount preserved (same node the non-edit render produces).
    const footer = container.querySelector('.MessageFooter') as HTMLElement
    expect(footer).not.toBeNull()
    expect(footer.querySelector('[data-testid="menubar-stub"]')).not.toBeNull()
    expect(footer.classList.contains('edit-mode-toolbar-hidden')).toBe(true)
    expect(footer.hasAttribute('inert')).toBe(true)
    expect(footer.getAttribute('aria-hidden')).toBe('true')
    // Forced hide defeats the container-hover opacity reveal.
    expect(window.getComputedStyle(footer).visibility).toBe('hidden')
    expect(window.getComputedStyle(footer).pointerEvents).toBe('none')
    expect(window.getComputedStyle(footer).display).not.toBe('none')
    // The bubble user-message metadata hover reveal is defeated too: the
    // time/tokens line stays hidden with the toolbar.
    const metadata = footer.querySelector('.message-footer-metadata') as HTMLElement
    expect(metadata).not.toBeNull()
    expect(window.getComputedStyle(metadata).visibility).toBe('hidden')
    expect(window.getComputedStyle(metadata).opacity).toBe('0')
  })

  it('menubar renders visibly with no hiding treatment outside edit mode', () => {
    const { container } = render(<MessageItem message={makeMessage()} topic={topic} />)
    const footer = container.querySelector('.MessageFooter') as HTMLElement
    expect(footer).not.toBeNull()
    expect(footer.classList.contains('edit-mode-toolbar-hidden')).toBe(false)
    expect(footer.hasAttribute('inert')).toBe(false)
    expect(footer.hasAttribute('aria-hidden')).toBe(false)
    expect(window.getComputedStyle(footer).visibility).not.toBe('hidden')
  })
})
