/**
 * Edit-mode group passivity contract (MessageGroup level):
 * - Selection ownership lives one layer up at the turn container
 *   (EditTurn): the group owns no click capture, no hover reporting, no
 *   hover state/timers, and no geometry query attribute. Clicking nested
 *   content at this level toggles nothing.
 * - The grouped model/reorder/retry bar keeps its DOM mount in edit mode
 *   (force-hidden/inert by the real bar — see
 *   MessageGroupMenuBar.editModeHidden); ordinary actions run outside edit
 *   mode unchanged.
 * - MessageItem keeps only the right-click auto-select path via
 *   onGroupClick (covered at Message level); the group forwards the prop.
 */
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spies = vi.hoisted(() => ({
  onGroupClick: vi.fn(),
  nestedMenuAction: vi.fn()
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

vi.mock('@renderer/context/MessageEditingContext', () => ({
  MessageEditingProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMessageEditing: () => ({
    editingMessageId: null,
    startEditing: vi.fn(),
    stopEditing: vi.fn()
  })
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useEditMode: () => ({
    isEnabled: false,
    selectedGroupIds: [] as string[],
    handleGroupClick: vi.fn()
  }),
  useOptionalEditMode: () => ({
    isEnabled: false,
    selectedGroupIds: [] as string[]
  }),
  EditModeProvider: ({ children }: { children: ReactNode }) => <>{children}</>
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

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    selectAnswer: vi.fn().mockResolvedValue(undefined),
    selectUseful: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (selector: (state: unknown) => unknown) => selector({})
}))

vi.mock('@renderer/store/routeAnswerGroup', () => ({
  resolveLoadedAnswerGroup: () => ({}),
  isLoadedAnswerGroupMutable: () => true
}))

vi.mock('@renderer/store/thunk/messageGroupReorder', () => ({
  reorderMessageGroupThunk: vi.fn()
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
  cn: (...args: any[]) => args.flat().filter(Boolean).join(' ')
}))

vi.mock('@renderer/utils/dom', () => ({
  scrollIntoView: vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/is', () => ({
  isMessageProcessing: () => false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('../Message', () => ({
  default: ({ message }: { message: Message }) => (
    <div data-testid={`mock-message-${message.id}`}>message {message.id}</div>
  )
}))

vi.mock('../MessageGroupMenuBar', () => ({
  default: () => (
    <div className="group-menu-bar">
      <button type="button" data-testid="menu-nested-action" onClick={() => spies.nestedMenuAction()}>
        model selector action
      </button>
    </div>
  )
}))

const { default: MessageGroup } = await import('../MessageGroup')

const topic = { id: 'topic-1' } as Topic

const assistantMessage = (id: string, index: number): Message & { index: number } =>
  ({
    id,
    topicId: 'topic-1',
    role: 'assistant',
    assistantId: 'asst-1',
    askId: 'ask-1',
    blocks: [],
    status: 'success',
    index
  }) as unknown as Message & { index: number }

describe('MessageGroup edit-mode passivity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('owns no selection interaction: clicks toggle nothing and no hover/ask identity is exposed', () => {
    const messages = [assistantMessage('a1', 0), assistantMessage('a2', 1)]
    const { container, getByTestId } = render(
      <MessageGroup messages={messages} topic={topic} isEditMode onGroupClick={spies.onGroupClick} />
    )
    // No geometry-query attribute, no hover/click ownership markers.
    expect(container.querySelector('[data-group-ask]')).toBeNull()
    expect(container.querySelector('.edit-mode-group')).toBeNull()
    expect(container.querySelector('.edit-mode-preview')).toBeNull()
    expect(container.querySelector('.edit-mode-unselected')).toBeNull()
    // Clicking message content or the (mocked) menu bar toggles nothing
    // here — the turn container owns the single toggle in production.
    fireEvent.click(getByTestId('mock-message-a1'))
    fireEvent.click(getByTestId('mock-message-a2'), { ctrlKey: true })
    fireEvent.click(getByTestId('menu-nested-action'))
    expect(spies.onGroupClick).not.toHaveBeenCalled()
    // With no capture at this level, nested ordinary actions pass through;
    // the turn boundary intercepts them in production.
    expect(spies.nestedMenuAction).toHaveBeenCalledTimes(1)
  })

  it('unknown hover-reporting props are gone: renders with the passive prop surface only', () => {
    const messages = [assistantMessage('a1', 0)]
    const { container } = render(<MessageGroup messages={messages} topic={topic} isEditMode />)
    expect(container.querySelector('[data-testid="mock-message-a1"]')).not.toBeNull()
  })

  it('group menu bar stays mounted in edit mode', () => {
    const messages = [assistantMessage('a1', 0), assistantMessage('a2', 1)]
    const { container } = render(
      <MessageGroup messages={messages} topic={topic} isEditMode onGroupClick={spies.onGroupClick} />
    )
    // Layout mount preserved; the real bar force-hides itself (proven in
    // MessageGroupMenuBar.editModeHidden against the real component).
    expect(container.querySelector('.group-menu-bar')).not.toBeNull()
  })

  it('outside edit mode the menu bar renders and ordinary actions run with no selection', () => {
    const messages = [assistantMessage('a1', 0), assistantMessage('a2', 1)]
    const { container, getByTestId } = render(<MessageGroup messages={messages} topic={topic} />)
    expect(container.querySelector('.group-menu-bar')).not.toBeNull()
    fireEvent.click(getByTestId('menu-nested-action'))
    expect(spies.nestedMenuAction).toHaveBeenCalledTimes(1)
    expect(spies.onGroupClick).not.toHaveBeenCalled()
  })
})
