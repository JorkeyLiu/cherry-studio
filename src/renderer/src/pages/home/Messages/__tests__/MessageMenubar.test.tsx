/**
 * Focused tests for MessageMenubar's context-anchor button.
 *
 * Anchor-icon semantics:
 *   - The highlight (`data-context-anchor-active`) is derived ONLY from the
 *     resolved anchor projection (`anchorGroupKey` from the Messages-scoped
 *     AnchorGroupProvider) — never from persisted anchor/source state.
 *     A non-empty user-led topic has exactly one highlighted anchor button.
 *   - Clicking the button writes ONLY the persisted `contextWindowAnchor`
 *     through the real `resolveMessageAnchorDecision` decision helper
 *     (docs/context-window.md §8): clicking a non-anchored turn moves the
 *     anchor there; clicking the CURRENT anchored turn re-anchors to the
 *     current default window position (from the current `contextCount`) —
 *     the interaction never leaves a non-empty initialized topic anchorless.
 *
 * The heavy menubar surface is mocked; the anchor button, the real
 * AnchorGroupProvider, the real turn builder, and the real click decision
 * semantics are exercised.
 */
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest' // ── Mocks (hoisted) ────────────────────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    selectMessagesForTopic: vi.fn(() => [] as Message[])
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), silly: vi.fn() })
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
vi.mock('@renderer/components/Popups/SaveToKnowledgePopup', () => ({ default: { showForMessage: vi.fn() } }))
vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: { show: vi.fn() }
}))

vi.mock('@renderer/context/MessageEditingContext', () => ({
  useMessageEditing: () => ({ startEditing: vi.fn(), stopEditing: vi.fn(), editingMessageId: null })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ updateAssistantSettings: updateAssistantSettingsMock })
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

// ── Shared mock fn (declared after hoisted mocks) ──────────────────────────
const updateAssistantSettingsMock = vi.fn()

// ── Import real MessageMenubar (after mocks) ───────────────────────────────
const { AnchorGroupProvider } = await import('../anchorGroupContext')
const { default: MessageMenubar } = await import('../MessageMenubar')

// ── Helpers ────────────────────────────────────────────────────────────────

const makeUserMessage = (id: string): Message =>
  ({
    id,
    topicId: 'topic-1',
    role: 'user',
    assistantId: 'asst-1',
    blocks: [],
    status: 'success'
  }) as unknown as Message

const makeAssistant = (anchor?: { kind: 'active'; groupKey: string }, contextCount: number | null = 25): Assistant =>
  ({
    id: 'asst-1',
    settings: {
      contextCount,
      contextWindowAnchor: anchor ? { 'topic-1': anchor } : {}
    }
  }) as unknown as Assistant

const topic = { id: 'topic-1' } as Topic

const emptyMessageContainerRef = { current: null } as unknown as React.RefObject<HTMLDivElement>

const renderMenubar = (message: Message, assistant: Assistant, anchorGroupKey: string | null) =>
  render(
    <AnchorGroupProvider anchorGroupKey={anchorGroupKey}>
      <MessageMenubar
        message={message}
        assistant={assistant}
        topic={topic}
        isLastMessage={false}
        isAssistantMessage={message.role === 'assistant'}
        messageContainerRef={emptyMessageContainerRef}
        setModel={vi.fn()}
      />
    </AnchorGroupProvider>
  )

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MessageMenubar context-anchor button', () => {
  beforeEach(() => {
    updateAssistantSettingsMock.mockReset()
    mocks.selectMessagesForTopic.mockReset()
    mocks.selectMessagesForTopic.mockReturnValue([])
  })

  it('highlights exactly the rendered user turn matching the resolved anchor', () => {
    const message = makeUserMessage('u2')
    // Resolved anchor is turn key 'u2' (default-derived position), no persisted anchor.
    const assistant = makeAssistant()
    renderMenubar(message, assistant, 'u2')

    const anchorBtn = screen.getByTestId('context-anchor-btn')
    expect(anchorBtn.getAttribute('data-context-anchor-active')).toBe('true')
  })

  it('does not highlight a user turn that is not the resolved anchor', () => {
    const message = makeUserMessage('u1')
    // Resolved anchor is 'u2'; u1 is outside the window start.
    renderMenubar(message, makeAssistant(), 'u2')

    const anchorBtn = screen.getByTestId('context-anchor-btn')
    expect(anchorBtn.getAttribute('data-context-anchor-active')).toBe('false')
  })

  it('highlight is independent of persisted anchor state (visual projection only)', () => {
    // The persisted anchor targets u1, but the RESOLVED anchor (from the resolver
    // projection) is u2 — the icon follows the resolved anchor, not the stored
    // anchor. Visual position may differ from the persisted origin.
    const message = makeUserMessage('u2')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u1' })
    renderMenubar(message, assistant, 'u2')

    const anchorBtn = screen.getByTestId('context-anchor-btn')
    expect(anchorBtn.getAttribute('data-context-anchor-active')).toBe('true')
  })

  it('no anchor (empty window) never highlights', () => {
    const message = makeUserMessage('u1')
    renderMenubar(message, makeAssistant(), null)

    const anchorBtn = screen.getByTestId('context-anchor-btn')
    expect(anchorBtn.getAttribute('data-context-anchor-active')).toBe('false')
  })

  it('clicking a non-anchored user turn moves the persisted anchor to that turn', () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u1' })
    mocks.selectMessagesForTopic.mockReturnValue([makeUserMessage('u1'), makeUserMessage('u3')])
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))

    expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettingsMock).toHaveBeenCalledWith({
      contextWindowAnchor: {
        'topic-1': { kind: 'active', groupKey: 'u3' }
      }
    })
  })

  it('clicking the CURRENT anchored turn re-anchors to the current default window position', () => {
    // Current anchor is u3; with contextCount=25 and turns [u1,u2,u3] the
    // default window position is the FIRST turn (u1). Clicking the anchored
    // turn re-anchors to u1 — it never clears the anchor.
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u3' })
    mocks.selectMessagesForTopic.mockReturnValue([makeUserMessage('u1'), makeUserMessage('u2'), makeUserMessage('u3')])
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))

    expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettingsMock).toHaveBeenCalledWith({
      contextWindowAnchor: {
        'topic-1': { kind: 'active', groupKey: 'u1' }
      }
    })
  })

  it('clicking a resolved default-derived anchor persists it at the same position (freeze)', () => {
    // No persisted anchor; the resolved anchor is u2 (default-derived). Clicking
    // the resolved anchor persists it at the same position.
    const message = makeUserMessage('u2')
    const assistant = makeAssistant()
    mocks.selectMessagesForTopic.mockReturnValue([makeUserMessage('u1'), makeUserMessage('u2')])
    renderMenubar(message, assistant, 'u2')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))

    expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettingsMock).toHaveBeenCalledWith({
      contextWindowAnchor: {
        'topic-1': { kind: 'active', groupKey: 'u2' }
      }
    })
  })

  it('clicking an unresolvable/stale turn re-anchors to the current default position', () => {
    // The clicked message u9 is not part of the current turns; the interaction
    // must never leave a non-empty initialized topic anchorless, so it
    // re-anchors to the current default position (contextCount=1 → last turn
    // u3, a different position from the current anchor u1).
    const message = makeUserMessage('u9')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u1' }, 1)
    mocks.selectMessagesForTopic.mockReturnValue([makeUserMessage('u1'), makeUserMessage('u2'), makeUserMessage('u3')])
    renderMenubar(message, assistant, 'u1')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))

    expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettingsMock).toHaveBeenCalledWith({
      contextWindowAnchor: {
        'topic-1': { kind: 'active', groupKey: 'u3' }
      }
    })
  })

  it('never renders the anchor button for assistant messages', () => {
    const assistantMsg = {
      id: 'a1',
      topicId: 'topic-1',
      role: 'assistant',
      askId: 'u1',
      assistantId: 'asst-1',
      blocks: [],
      status: 'success'
    } as unknown as Message
    renderMenubar(assistantMsg, makeAssistant(), 'u1')

    expect(screen.queryByTestId('context-anchor-btn')).toBeNull()
  })

  it('context hook is safe outside the provider (no spurious highlight)', () => {
    const message = makeUserMessage('u1')
    render(
      <MessageMenubar
        message={message}
        assistant={makeAssistant()}
        topic={topic}
        isLastMessage={false}
        isAssistantMessage={false}
        messageContainerRef={emptyMessageContainerRef}
        setModel={vi.fn()}
      />
    )

    const anchorBtn = screen.getByTestId('context-anchor-btn')
    expect(anchorBtn.getAttribute('data-context-anchor-active')).toBe('false')
  })
})
