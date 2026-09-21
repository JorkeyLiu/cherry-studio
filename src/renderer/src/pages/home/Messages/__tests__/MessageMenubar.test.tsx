/**
 * Focused tests for MessageMenubar's context-anchor button.
 *
 * Anchor-icon semantics:
 *   - The highlight (`data-context-anchor-active`) is derived ONLY from the
 *     resolved anchor projection (`anchorGroupKey` from the Messages-scoped
 *     AnchorGroupProvider) — never from persisted anchor/source state.
 *     A non-empty user-led topic has exactly one highlighted anchor button.
 *   - Clicking the button writes ONLY the persisted `contextWindowAnchor`
 *     through `chatdb:resolve-context-closure` authority calls
 *     (docs/adr/context-window.md §8): a first `move` (`messageId`) call is the
 *     authority determination with no loaded-turn inference; an echo of the
 *     still-current persisted key issues a second `reanchor-default` call
 *     (current `contextCount` + current target anchor baseline). No
 *     `selectLoadedMessagesForTopic` / `buildContextTurns` authority decisions.
 *     Only a non-stale returned anchor is persisted (key removed on empty);
 *     transport failures and stale/racing results preserve settings.
 *
 * The heavy menubar surface is mocked; the anchor button, the real
 * AnchorGroupProvider, and the real click decision semantics are exercised.
 */
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest' // ── Mocks (hoisted) ────────────────────────────────────────────────────────

const { mocks } = vi.hoisted(() => ({
  mocks: {
    selectLoadedMessagesForTopic: vi.fn(() => [] as Message[]),
    resolveContextClosure: vi.fn(),
    buildContextTurns: vi.fn((..._args: unknown[]) => [] as unknown[]),
    getStateAssistants: [] as any[]
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
  default: {
    getState: () => ({ messages: { entities: {} }, assistants: { assistants: mocks.getStateAssistants } }),
    dispatch: vi.fn()
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/services/contextTurnService', () => ({
  isMessageInContextTurn: (message: { role: string; id: string; askId?: string }, groupKey: string | null) => {
    if (groupKey === null || groupKey === undefined) return false
    if (message.role === 'user' || message.role === 'system') return message.id === groupKey
    if (message.role === 'assistant') return (message.askId ?? message.id) === groupKey
    return false
  },
  buildContextTurns: (...args: unknown[]) => mocks.buildContextTurns(...args)
}))

vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: { selectEntities: () => ({}) },
  selectMessageBlocksByIds: () => []
}))

vi.mock('@renderer/store/newMessage', () => ({
  selectLoadedMessagesForTopic: mocks.selectLoadedMessagesForTopic
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    resolveContextClosure: (...args: unknown[]) => mocks.resolveContextClosure(...args)
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    resolveContextClosure: (...args: unknown[]) => mocks.resolveContextClosure(...args)
  }
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
    mocks.selectLoadedMessagesForTopic.mockReset()
    mocks.selectLoadedMessagesForTopic.mockReturnValue([])
    mocks.resolveContextClosure.mockReset()
    mocks.buildContextTurns.mockClear()
    mocks.getStateAssistants = []
  })

  const expectNoLoadedTurnAuthority = () => {
    expect(mocks.selectLoadedMessagesForTopic).not.toHaveBeenCalled()
    expect(mocks.buildContextTurns).not.toHaveBeenCalled()
  }

  const resolverSuccess = (resolvedAnchorGroupKey: string | null) =>
    ({
      messages: [],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: 'topic-1',
        anchorGroupKey: resolvedAnchorGroupKey,
        firstMessageId: resolvedAnchorGroupKey ? 'm1' : null,
        lastMessageId: resolvedAnchorGroupKey ? 'm1' : null,
        returnedCount: resolvedAnchorGroupKey ? 1 : 0,
        totalTurnCount: resolvedAnchorGroupKey ? 1 : 0,
        selectedTurnCount: resolvedAnchorGroupKey ? 1 : 0,
        boundaryMessageId: null
      },
      resolvedAnchorGroupKey,
      changed: true
    }) as any

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

  it('clicking a non-anchored user turn moves the persisted anchor via the authority resolver', async () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u1' })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u3'))
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await vi.waitFor(() => expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1))

    expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(1)
    expect(mocks.resolveContextClosure).toHaveBeenCalledWith({
      topicId: 'topic-1',
      intent: 'move',
      messageId: 'u3',
      currentAnchorGroupKey: 'u1',
      detail: 'anchor'
    })
    expect(updateAssistantSettingsMock).toHaveBeenCalledWith({
      contextWindowAnchor: {
        'topic-1': { kind: 'active', groupKey: 'u3' }
      }
    })
    expectNoLoadedTurnAuthority()
  })

  it('clicking the currently anchored turn re-anchors to the authority default', async () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u3' }, 2)
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u3'))
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u1'))
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await vi.waitFor(() => expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1))

    expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(2)
    expect(mocks.resolveContextClosure).toHaveBeenNthCalledWith(1, {
      topicId: 'topic-1',
      intent: 'move',
      messageId: 'u3',
      currentAnchorGroupKey: 'u3',
      detail: 'anchor'
    })
    expect(mocks.resolveContextClosure).toHaveBeenNthCalledWith(2, {
      topicId: 'topic-1',
      intent: 'reanchor-default',
      contextCount: 2,
      currentAnchorGroupKey: 'u3',
      detail: 'anchor'
    })
    expect(updateAssistantSettingsMock).toHaveBeenCalledWith({
      contextWindowAnchor: {
        'topic-1': { kind: 'active', groupKey: 'u1' }
      }
    })
    expectNoLoadedTurnAuthority()
  })

  it('same-turn re-anchor to an already-default anchor produces no dispatch', async () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u3' }, 2)
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u3'))
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u3'))
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await new Promise((r) => setTimeout(r, 20))

    expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(2)
    expect(updateAssistantSettingsMock).not.toHaveBeenCalled()
    expectNoLoadedTurnAuthority()
  })

  it('same-turn re-anchor removing the key on empty persists removal', async () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u3' }, 2)
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u3'))
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess(null))
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await vi.waitFor(() => expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1))

    expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(2)
    const arg = updateAssistantSettingsMock.mock.calls[0][0] as { contextWindowAnchor: Record<string, unknown> }
    expect(arg.contextWindowAnchor['topic-1']).toBeUndefined()
    expectNoLoadedTurnAuthority()
  })

  it('transport failure on the first call preserves settings (no dispatch, no second call)', async () => {
    const message = makeUserMessage('u2')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u1' })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockRejectedValueOnce(new Error('IPC fail'))
    renderMenubar(message, assistant, 'u2')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await new Promise((r) => setTimeout(r, 0))

    expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(1)
    expect(updateAssistantSettingsMock).not.toHaveBeenCalled()
    expectNoLoadedTurnAuthority()
  })

  it('transport failure on the second call preserves settings (no dispatch)', async () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u3' }, 2)
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u3'))
    mocks.resolveContextClosure.mockRejectedValueOnce(new Error('IPC fail'))
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await new Promise((r) => setTimeout(r, 20))

    expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(2)
    expect(updateAssistantSettingsMock).not.toHaveBeenCalled()
    expectNoLoadedTurnAuthority()
  })

  it('stale result after a concurrent anchor change does not overwrite', async () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u1' })
    const updated = makeAssistant({ kind: 'active', groupKey: 'u9' })
    mocks.getStateAssistants = [assistant]
    let resolveFirst!: (v: unknown) => void
    mocks.resolveContextClosure.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirst = res
        })
    )
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await new Promise((r) => setTimeout(r, 0))
    mocks.getStateAssistants = [updated]
    resolveFirst(resolverSuccess('u3'))
    await new Promise((r) => setTimeout(r, 20))

    expect(updateAssistantSettingsMock).not.toHaveBeenCalled()
    expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(1)
    expectNoLoadedTurnAuthority()
  })

  it('race between first and second calls does not overwrite newer anchor state', async () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u3' }, 2)
    const updated = makeAssistant({ kind: 'active', groupKey: 'u9' }, 2)
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u3'))
    let resolveSecond!: (v: unknown) => void
    mocks.resolveContextClosure.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSecond = res
        })
    )
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await vi.waitFor(() => expect(mocks.resolveContextClosure).toHaveBeenCalledTimes(2))
    mocks.getStateAssistants = [updated]
    resolveSecond(resolverSuccess('u1'))
    await new Promise((r) => setTimeout(r, 20))

    expect(updateAssistantSettingsMock).not.toHaveBeenCalled()
    expectNoLoadedTurnAuthority()
  })

  it('uses messageId (not loaded group lists) so orphan assistant turns resolve by authority', async () => {
    const message = makeUserMessage('u9')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u1' }, 1)
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce(resolverSuccess('u3'))
    renderMenubar(message, assistant, 'u1')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await vi.waitFor(() => expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1))

    expect(mocks.resolveContextClosure).toHaveBeenCalledWith({
      topicId: 'topic-1',
      intent: 'move',
      messageId: 'u9',
      currentAnchorGroupKey: 'u1',
      detail: 'anchor'
    })
    expect(updateAssistantSettingsMock).toHaveBeenCalledWith({
      contextWindowAnchor: {
        'topic-1': { kind: 'active', groupKey: 'u3' }
      }
    })
    expectNoLoadedTurnAuthority()
  })

  it('persists a metadata-only anchor response with no messages/blocks/closure', async () => {
    const message = makeUserMessage('u3')
    const assistant = makeAssistant({ kind: 'active', groupKey: 'u1' })
    mocks.getStateAssistants = [assistant]
    mocks.resolveContextClosure.mockResolvedValueOnce({ resolvedAnchorGroupKey: 'u3', changed: true } as any)
    renderMenubar(message, assistant, 'u3')

    fireEvent.click(screen.getByTestId('context-anchor-btn'))
    await vi.waitFor(() => expect(updateAssistantSettingsMock).toHaveBeenCalledTimes(1))

    expect(mocks.resolveContextClosure).toHaveBeenCalledWith({
      topicId: 'topic-1',
      intent: 'move',
      messageId: 'u3',
      currentAnchorGroupKey: 'u1',
      detail: 'anchor'
    })
    expect(updateAssistantSettingsMock).toHaveBeenCalledWith({
      contextWindowAnchor: {
        'topic-1': { kind: 'active', groupKey: 'u3' }
      }
    })
    expectNoLoadedTurnAuthority()
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
