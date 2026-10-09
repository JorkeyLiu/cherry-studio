/**
 * Useful-in-More-menu + Clone Topic regression for MessageMenubar.
 *
 * Intended UI (grouped-assistant useful action):
 *   - The `useful` toggle (chat.message.useful.label) never renders as a
 *     visible toolbar button — it lives in the More menu root, directly after
 *     the Clone Topic entry, only for grouped assistant messages with an
 *     owned (mutable) answer group. Ungrouped assistants never get the entry.
 *   - Driving the menu entry calls the same `onUpdateUseful` callback with the
 *     message id for both select and unselect; the selected state stays
 *     visible in the menu (`data-selected` + filled primary icon).
 *   - Clone Topic keeps its stable contract: `message-copy-topic-btn` testid,
 *     `chat.message.copy_topic.label` i18n key, `copy-topic` menu key wired to
 *     `emitNewBranch` (clone-prefix NEW_BRANCH). Only the display icon changes
 *     to lucide `CopyPlus` (plain message copy keeps CopyIcon, true-branch
 *     keeps Split). User `context-anchor` is untouched.
 */
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, fakeState, dropdownCapture } = vi.hoisted(() => ({
  mocks: {
    selectLoadedMessagesForTopic: vi.fn(() => [] as Message[]),
    resolveContextClosure: vi.fn(),
    buildContextTurns: vi.fn((..._args: unknown[]) => [] as unknown[]),
    getStateAssistants: [] as any[]
  },
  fakeState: {
    current: null as any
  },
  dropdownCapture: { items: [] as any[] }
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

const updateAssistantSettingsMock = vi.fn()
vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ updateAssistantSettings: updateAssistantSettingsMock }),
  useAssistantSettingsUpdater: () => updateAssistantSettingsMock,
  withEmptyTopics: (config: Record<string, unknown>) => ({ ...config, topics: [] })
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

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    regenerateAssistant: vi.fn(),
    resendUser: vi.fn(),
    selectAnswer: vi.fn(),
    editSave: vi.fn(),
    resendWithEdit: vi.fn()
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
  useTemporaryValue: (initial: boolean) => [initial, vi.fn()]
}))

vi.mock('@renderer/hooks/useTranslate', () => ({
  default: () => ({ translateLanguages: [] })
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: any) => assistant?.settings ?? { contextCount: 25, contextWindowAnchor: {} },
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
    getState: () => fakeState.current,
    dispatch: vi.fn()
  },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/services/contextTurnService', () => ({
  isMessageInContextTurn: () => false,
  buildContextTurns: (...args: unknown[]) => mocks.buildContextTurns(...args)
}))

vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: { selectEntities: () => ({}) },
  selectMessageBlocksByIds: () => []
}))

// NOTE: newMessage + topicBranch + routeAnswerGroup are intentionally NOT
// mocked: the real group-mutability selectors run against fakeState.
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
  classNames: (...args: any[]) => args.flat().filter(Boolean).join(' '),
  captureScrollableAsBlob: vi.fn(),
  captureScrollableAsDataURL: vi.fn(),
  copyMessageAsPlainText: vi.fn()
}))

vi.mock('@renderer/utils/abortController', () => ({
  abortCompletion: vi.fn()
}))

vi.mock('@renderer/utils/error', () => ({
  isAbortError: () => false
}))

vi.mock('@renderer/utils/copy', () => ({
  copyMessageAsPlainText: vi.fn()
}))

vi.mock('@renderer/utils/export', () => ({
  exportMarkdownToJoplin: vi.fn(),
  exportMarkdownToSiyuan: vi.fn(),
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

vi.mock('@renderer/utils/messageUtils/find', () => ({
  findMainTextBlocks: () => [],
  findTranslationBlocks: () => [],
  findTranslationBlocksById: () => [],
  getMainTextContent: () => '',
  isAssistantInterruptedThinkingOnlyMessage: () => false
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: any) => unknown) => selector(fakeState.current),
  shallowEqual: (a: unknown, b: unknown) => a === b
}))

const emitNewBranchMock = vi.fn()
vi.mock('../messageBranch', () => ({
  emitNewBranch: (...args: unknown[]) => emitNewBranchMock(...args),
  emitTrueBranch: vi.fn()
}))

vi.mock('../MessageTokens', () => ({ default: () => null }))

// Capture the More-menu Dropdown items (repo pattern: prove overflow entries
// and drive their callbacks without depending on antd overlay internals).
vi.mock('antd', () => ({
  Dropdown: (props: {
    children?: ReactNode
    menu?: { items?: Array<{ key?: string; label?: unknown; icon?: unknown; onClick?: () => void }> }
  }) => {
    dropdownCapture.items = props.menu?.items ?? []
    return <>{props.children}</>
  },
  Popconfirm: (props: { children?: ReactNode }) => <>{props.children}</>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>
}))

const { AnchorGroupProvider } = await import('../anchorGroupContext')
const { default: MessageMenubar } = await import('../MessageMenubar')

const makeUserMessage = (id: string, topicId = 'topic-1'): Message =>
  ({
    id,
    topicId,
    role: 'user',
    assistantId: 'asst-1',
    blocks: [],
    status: 'success'
  }) as unknown as Message

const makeAssistantMessage = (id: string, askId: string, topicId = 'topic-1', useful = false): Message =>
  ({
    id,
    topicId,
    role: 'assistant',
    assistantId: 'asst-1',
    askId,
    blocks: [],
    status: 'success',
    useful
  }) as unknown as Message

const makeAssistant = (): Assistant =>
  ({
    id: 'asst-1',
    settings: { contextCount: 25, contextWindowAnchor: {} }
  }) as unknown as Assistant

const topic = { id: 'topic-1' } as Topic
const emptyRef = { current: null } as unknown as React.RefObject<HTMLDivElement>

function setOwnedGroup(entities: Record<string, Message>, loadedIds: string[], mutableIds: string[]) {
  fakeState.current = {
    settings: {
      exportMenuOptions: {},
      confirmDeleteMessage: false,
      confirmRegenerateMessage: false
    },
    assistants: { assistants: [] },
    messageBlocks: { entities: {}, ids: [] },
    topicBranch: {
      branchesByTopic: {},
      activeBranchIdByTopic: {},
      routeGenerationByTopic: {},
      deletionFallbackByTopic: {}
    },
    messages: {
      entities,
      ids: loadedIds,
      messageIdsByTopic: { 'topic-1': loadedIds },
      currentTopicId: 'topic-1',
      loadingByTopic: {},
      fulfilledByTopic: {},
      displayCount: 10,
      mutableMessageIdsByTopic: { 'topic-1': mutableIds },
      mutableRouteByTopic: { 'topic-1': null }
    },
    residentRegistry: {
      entries: { 'topic-1': { residentTopic: true, chatData: true, segments: true, applicabilityGeneration: 1 } }
    }
  }
}

function renderMenubar(
  message: Message,
  opts?: { isAssistantMessage?: boolean; isGrouped?: boolean; onUpdateUseful?: (msgId: string) => void }
) {
  dropdownCapture.items = []
  return render(
    <AnchorGroupProvider anchorGroupKey={null}>
      <MessageMenubar
        message={message}
        assistant={makeAssistant()}
        topic={topic}
        isLastMessage={false}
        isAssistantMessage={opts?.isAssistantMessage ?? false}
        isGrouped={opts?.isGrouped ?? false}
        messageContainerRef={emptyRef}
        setModel={vi.fn()}
        onUpdateUseful={opts?.onUpdateUseful}
      />
    </AnchorGroupProvider>
  )
}

const findMenuItem = (key: string) => dropdownCapture.items.find((item) => item?.key === key)

describe('MessageMenubar useful-in-More-menu + Clone Topic', () => {
  beforeEach(() => {
    updateAssistantSettingsMock.mockReset()
    emitNewBranchMock.mockReset()
    dropdownCapture.items = []
  })

  it('never renders a useful toolbar button for grouped assistants (selected or not)', () => {
    const entities: Record<string, Message> = {
      u1: makeUserMessage('u1'),
      a1: makeAssistantMessage('a1', 'u1', 'topic-1', true),
      a2: makeAssistantMessage('a2', 'u1')
    }
    setOwnedGroup(entities, ['u1', 'a1', 'a2'], ['u1', 'a1', 'a2'])
    const selected = renderMenubar(entities.a1, { isAssistantMessage: true, isGrouped: true })
    expect(screen.queryByTestId('msg-useful-btn')).toBeNull()
    selected.unmount()

    const unselected = renderMenubar(entities.a2, { isAssistantMessage: true, isGrouped: true })
    expect(screen.queryByTestId('msg-useful-btn')).toBeNull()
    unselected.unmount()
  })

  it('shows the useful menu entry only for grouped assistants, directly after Clone Topic', () => {
    const entities: Record<string, Message> = {
      u1: makeUserMessage('u1'),
      a1: makeAssistantMessage('a1', 'u1'),
      a2: makeAssistantMessage('a2', 'u1')
    }
    setOwnedGroup(entities, ['u1', 'a1', 'a2'], ['u1', 'a1', 'a2'])

    const grouped = renderMenubar(entities.a1, { isAssistantMessage: true, isGrouped: true })
    const keys = dropdownCapture.items.map((item) => item?.key)
    expect(keys).toContain('copy-topic')
    expect(keys).toContain('useful')
    // New entry sits directly after Clone Topic.
    expect(keys.indexOf('useful')).toBe(keys.indexOf('copy-topic') + 1)
    grouped.unmount()

    // Ungrouped assistants never get the entry — the clone entry stays.
    const ungrouped = renderMenubar(entities.a1, { isAssistantMessage: true, isGrouped: false })
    expect(screen.queryByTestId('msg-useful-btn')).toBeNull()
    expect(findMenuItem('copy-topic')).toBeDefined()
    expect(findMenuItem('useful')).toBeUndefined()
    ungrouped.unmount()
  })

  it('drives the same onUpdateUseful callback for select and unselect, with a visible selected state', () => {
    const onUpdateUseful = vi.fn()
    const entities: Record<string, Message> = {
      u1: makeUserMessage('u1'),
      a1: makeAssistantMessage('a1', 'u1', 'topic-1', false),
      a2: makeAssistantMessage('a2', 'u1', 'topic-1', true)
    }
    setOwnedGroup(entities, ['u1', 'a1', 'a2'], ['u1', 'a1', 'a2'])

    // Unselected: same label key, unselected marker, same callback.
    const unselected = renderMenubar(entities.a1, { isAssistantMessage: true, isGrouped: true, onUpdateUseful })
    const selectItem = findMenuItem('useful')
    expect(selectItem).toBeDefined()
    const selectLabel = selectItem?.label as { props?: Record<string, unknown>; children?: unknown }
    expect(selectLabel?.props?.['data-testid']).toBe('msg-useful-menu-btn')
    expect(selectLabel?.props?.['data-selected']).toBe('false')
    // Reuses the established useful label (t mock returns the key).
    expect(selectLabel?.children ?? selectLabel?.props?.['children']).toBe('chat.message.useful.label')
    selectItem?.onClick?.()
    expect(onUpdateUseful).toHaveBeenCalledTimes(1)
    expect(onUpdateUseful).toHaveBeenCalledWith('a1')
    unselected.unmount()

    // Selected: marker flips, callback identical.
    const selected = renderMenubar(entities.a2, { isAssistantMessage: true, isGrouped: true, onUpdateUseful })
    const unselectItem = findMenuItem('useful')
    expect(unselectItem).toBeDefined()
    const unselectLabel = unselectItem?.label as { props?: Record<string, unknown> }
    expect(unselectLabel?.props?.['data-selected']).toBe('true')
    unselectItem?.onClick?.()
    expect(onUpdateUseful).toHaveBeenCalledTimes(2)
    expect(onUpdateUseful).toHaveBeenNthCalledWith(2, 'a2')
    selected.unmount()
  })

  it('keeps the Clone Topic contract: stable testid/key/i18n wiring to emitNewBranch with a CopyPlus icon', () => {
    const entities: Record<string, Message> = {
      u1: makeUserMessage('u1'),
      a1: makeAssistantMessage('a1', 'u1'),
      a2: makeAssistantMessage('a2', 'u1')
    }
    setOwnedGroup(entities, ['u1', 'a1', 'a2'], ['u1', 'a1', 'a2'])
    const { container, unmount } = renderMenubar(entities.a1, { isAssistantMessage: true, isGrouped: true })

    const cloneItem = findMenuItem('copy-topic')
    expect(cloneItem).toBeDefined()
    const cloneLabel = cloneItem?.label as { props?: Record<string, unknown>; children?: unknown }
    expect(cloneLabel?.props?.['data-testid']).toBe('message-copy-topic-btn')
    // Same i18n key (kept for compat), new display value comes from locales.
    expect(cloneLabel?.children ?? cloneLabel?.props?.['children']).toBe('chat.message.copy_topic.label')
    // New icon is CopyPlus — never the plain message-copy Copy.
    const iconType = (cloneItem?.icon as { type?: { displayName?: string; name?: string } })?.type
    expect(iconType?.displayName ?? iconType?.name).toBe('CopyPlus')
    const iconRender = render(<>{cloneItem?.icon as ReactNode}</>)
    expect(iconRender.container.querySelector('.lucide-copy-plus')).not.toBeNull()
    expect(iconRender.container.querySelector('.lucide-copy')).toBeNull()
    iconRender.unmount()

    // Cloning behavior unchanged: still emits NEW_BRANCH for this message.
    cloneItem?.onClick?.()
    expect(emitNewBranchMock).toHaveBeenCalledTimes(1)
    expect(emitNewBranchMock).toHaveBeenCalledWith('a1')

    // Plain message copy keeps CopyIcon; true-branch keeps its Split button.
    expect(container.querySelector('[data-testid="msg-copy-btn"]')).not.toBeNull()
    expect(container.textContent).toContain('copy-icon')
    expect(container.querySelector('[data-testid="msg-true-branch-btn"]')).not.toBeNull()
    expect(container.querySelector('.lucide-split')).not.toBeNull()
    unmount()
  })

  it('leaves the user context-anchor button untouched and offers no useful menu on user messages', () => {
    const entities: Record<string, Message> = {
      u1: makeUserMessage('u1')
    }
    setOwnedGroup(entities, ['u1'], ['u1'])
    const { unmount } = renderMenubar(entities.u1, { isAssistantMessage: false })

    // User toolbar keeps its anchor entry in place; useful never had one there.
    expect(screen.queryByTestId('context-anchor-btn')).not.toBeNull()
    expect(screen.queryByTestId('msg-useful-btn')).toBeNull()
    // User messages have no More menu at all, so no useful overflow either.
    expect(screen.queryByTestId('message-more-menu-btn')).toBeNull()
    expect(findMenuItem('useful')).toBeUndefined()
    unmount()
  })
})
