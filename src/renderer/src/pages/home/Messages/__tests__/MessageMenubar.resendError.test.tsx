/**
 * MessageMenubar user-resend error boundary (classified).
 *
 * `handleResendUserMessage` awaits the `resendUser` controller, whose thunk
 * rejects fail-closed. Both the direct click and the Popconfirm confirm
 * branch call this same handler, so the handler itself must catch with a
 * single classified toast:
 * - missing model (NoModelError name OR legacy production throw text) ->
 *   `message.error.enter.model` (ApiService parity);
 * - ChatDbResultError NOT_FOUND (project ERR_NOT_FOUND) ->
 *   `error.missing_user_message`;
 * - any other ChatDb/transport/local error -> `common.error`.
 * Logger records stable IDs plus the toast key only, never message content,
 * and no unhandled rejection escapes the click path.
 */
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    resendUser: vi.fn(),
    regenerateAssistant: vi.fn(),
    selectMessagesForTopic: vi.fn(() => [] as Message[]),
    loggerError: vi.fn(),
    toastError: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: mocks.loggerError,
      warn: vi.fn(),
      info: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/components/Icons', () => ({
  CopyIcon: () => <span>copy-icon</span>,
  DeleteIcon: () => <span>delete-icon</span>,
  EditIcon: () => <span>edit-icon</span>,
  RefreshIcon: () => <span>refresh-icon</span>
}))

vi.mock('@renderer/components/Popups/InspectMessagePopup', () => ({ default: { show: vi.fn() } }))
vi.mock('@renderer/components/Popups/ObsidianExportPopup', () => ({ default: { show: vi.fn() } }))
vi.mock('@renderer/components/Popups/SaveToKnowledgePopup', () => ({ default: { show: vi.fn() } }))
vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: { show: vi.fn() }
}))

vi.mock('@renderer/context/MessageEditingContext', () => ({
  useMessageEditing: () => ({ startEditing: vi.fn(), stopEditing: vi.fn(), editingMessageId: null })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ updateAssistantSettings: vi.fn() })
}))

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    resendUser: mocks.resendUser,
    regenerateAssistant: mocks.regenerateAssistant,
    selectAnswer: vi.fn(),
    editSave: vi.fn(),
    resendWithEdit: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => ({
    deleteMessageWithUndo: vi.fn(),
    resendMessage: vi.fn(),
    regenerateAssistantMessage: vi.fn(),
    getTranslationUpdater: vi.fn(),
    appendAssistantResponse: vi.fn(),
    removeMessageBlock: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useNotesSettings', () => ({
  useNotesSettings: () => ({ notesPath: '' })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useMessageStyle: () => ({ isBubbleStyle: false }),
  useEnableDeveloperMode: () => ({ enableDeveloperMode: false }),
  useSettings: () => ({ confirmDeleteMessage: false, confirmRegenerateMessage: false })
}))

vi.mock('@renderer/hooks/useTemporaryValue', () => ({
  useTemporaryValue: () => [false, vi.fn()]
}))

vi.mock('@renderer/hooks/useTranslate', () => ({
  default: () => ({ translateLanguages: [] })
}))

vi.mock('@renderer/services/AssistantService', () => ({
  DEFAULT_ASSISTANT_SETTINGS: { contextCount: 25, contextWindowAnchor: {} },
  getAssistantSettings: (assistant: {
    settings?: { contextCount?: number | null; contextWindowAnchor?: Record<string, unknown> }
  }) => ({
    contextCount: assistant.settings?.contextCount === undefined ? 25 : assistant.settings.contextCount,
    contextWindowAnchor: assistant?.settings?.contextWindowAnchor ?? {}
  }),
  getDefaultAssistant: () => ({ id: 'asst-1', settings: { contextCount: 25 } }),
  getDefaultTopic: () => ({ id: 'topic-1', assistantId: 'asst-1' })
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getMessageTitle: vi.fn().mockResolvedValue('title')
}))

vi.mock('@renderer/services/TranslateService', () => ({
  translateText: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  default: { getState: () => ({ messages: { entities: {} } }), dispatch: vi.fn() },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: { selectEntities: () => ({}) },
  selectMessageBlocksByIds: () => []
}))

vi.mock('@renderer/store/newMessage', () => ({
  selectMessagesForTopic: mocks.selectMessagesForTopic
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  insertMessagesThunk: vi.fn(),
  removeBlocksThunk: vi.fn()
}))

vi.mock('@renderer/trace/pages/Component', () => ({
  TraceIcon: () => <span>trace-icon</span>
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
  captureScrollableAsBlob: vi.fn(),
  captureScrollableAsDataURL: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  abortCompletion: vi.fn()
}))

vi.mock('@renderer/utils/error', () => ({
  isAbortError: () => false
}))

vi.mock('@renderer/utils/export', () => ({
  exportMarkdownToJoplin: vi.fn(),
  exportMarkdownToSiyuan: vi.fn(),
  exportMarkdownToYuque: vi.fn(),
  exportMessageAsMarkdown: vi.fn(),
  exportMessageToNotes: vi.fn(),
  exportMessageToNotion: vi.fn(),
  messageToMarkdown: vi.fn(() => ''),
  messageToPlainText: vi.fn(() => ''),
  topicToMarkdown: vi.fn(() => ''),
  topicToPlainText: vi.fn(() => '')
}))

vi.mock('@renderer/utils/markdown', () => ({
  removeTrailingDoubleSpaces: (s: string) => s
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: any) => unknown) =>
    selector({
      settings: {
        exportMenuOptions: {
          plain_text: false,
          image: false,
          markdown: false,
          markdown_reason: false,
          docx: false,
          notion: false,
          yuque: false,
          obsidian: false,
          joplin: false,
          siyuan: false
        }
      }
    }),
  shallowEqual: (a: unknown, b: unknown) => a === b
}))

vi.mock('./messageBranch', () => ({
  emitNewBranch: vi.fn()
}))

vi.mock('./MessageTokens', () => ({ default: () => null }))

const { default: MessageMenubar } = await import('../MessageMenubar')
const { ChatDbResultError } = await import('@renderer/services/db/SqliteMessageDataSource')
const { NO_MODEL_ERROR_NAME } = await import('@renderer/utils/noModelError')

const makeUserMessage = (id: string): Message =>
  ({
    id,
    topicId: 'topic-1',
    role: 'user',
    assistantId: 'asst-1',
    blocks: [],
    status: 'success'
  }) as unknown as Message

const assistant = { id: 'asst-1', settings: { contextCount: 25, contextWindowAnchor: {} } } as unknown as Assistant
const topic = { id: 'topic-1' } as Topic
const emptyMessageContainerRef = { current: null } as unknown as React.RefObject<HTMLDivElement>

describe('MessageMenubar user-resend error boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.toast = { error: mocks.toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() } as never
  })

  const renderUserMenubar = (id: string) => {
    render(
      <MessageMenubar
        message={makeUserMessage(id)}
        assistant={assistant}
        topic={topic}
        isLastMessage={false}
        isAssistantMessage={false}
        messageContainerRef={emptyMessageContainerRef}
        setModel={vi.fn()}
      />
    )
  }

  const clickResend = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('msg-regenerate-btn'))
    })
  }

  it('legacy missing-model throw text maps to message.error.enter.model (single toast, IDs only)', async () => {
    mocks.resendUser.mockRejectedValueOnce(new Error('Assistant model is not configured for resend'))
    renderUserMenubar('u-1')
    await clickResend()
    expect(mocks.resendUser).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'u-1' })
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith('message.error.enter.model')
    expect(mocks.loggerError).toHaveBeenCalledTimes(1)
    const logged = mocks.loggerError.mock.calls.map((c) => String(c[0])).join(' ')
    expect(logged).toContain('topic-1/u-1')
  })

  it('NoModelError name marker maps to message.error.enter.model', async () => {
    const err = Object.assign(new Error('Please select a model first'), { name: NO_MODEL_ERROR_NAME })
    mocks.resendUser.mockRejectedValueOnce(err)
    renderUserMenubar('u-nomodel')
    await clickResend()
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith('message.error.enter.model')
    expect(mocks.loggerError).toHaveBeenCalledTimes(1)
  })

  it('ChatDbResultError NOT_FOUND maps to error.missing_user_message (real constructor)', async () => {
    // Real constructor per SqliteMessageDataSource: new ChatDbResultError({ code, message, retryable }).
    const notFound = new ChatDbResultError({ code: 'NOT_FOUND', message: 'User message not found', retryable: false })
    mocks.resendUser.mockRejectedValueOnce(notFound)
    renderUserMenubar('u-missing')
    await clickResend()
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith('error.missing_user_message')
    expect(mocks.loggerError).toHaveBeenCalledTimes(1)
    const logged = mocks.loggerError.mock.calls.map((c) => String(c[0])).join(' ')
    expect(logged).toContain('topic-1/u-missing')
  })

  it('generic local error maps to common.error', async () => {
    mocks.resendUser.mockRejectedValueOnce(new Error('boom'))
    renderUserMenubar('u-generic')
    await clickResend()
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith('common.error')
    expect(mocks.loggerError).toHaveBeenCalledTimes(1)
  })

  it('other ChatDb error (non-NOT_FOUND) maps to common.error', async () => {
    const storage = new ChatDbResultError({ code: 'STORAGE_ERROR', message: 'db locked', retryable: true })
    mocks.resendUser.mockRejectedValueOnce(storage)
    renderUserMenubar('u-storage')
    await clickResend()
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith('common.error')
    expect(mocks.loggerError).toHaveBeenCalledTimes(1)
  })

  it('successful resend stays silent: no toast, no error log', async () => {
    mocks.resendUser.mockResolvedValueOnce(undefined)
    renderUserMenubar('u-2')
    await clickResend()
    expect(mocks.resendUser).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'u-2' })
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.loggerError).not.toHaveBeenCalled()
  })
})
