/**
 * MessageMenubar mutation capability gating (real component).
 *
 * The menubar derives `isInherited = !isMutable` from the Main-authoritative
 * window capability (`selectIsMessageMutable`) — never from branchId guessing.
 * Owned rows show edit/delete even when referenced by live descendants
 * (BRANCH-4/9 owner equality only); inherited ancestor references hide them;
 * main-null resolves correctly; unknown capability fails closed.
 */
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, fakeState } = vi.hoisted(() => ({
  mocks: {
    selectLoadedMessagesForTopic: vi.fn(() => [] as Message[]),
    resolveContextClosure: vi.fn(),
    buildContextTurns: vi.fn((..._args: unknown[]) => [] as unknown[]),
    getStateAssistants: [] as any[]
  },
  fakeState: {
    current: null as any
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
vi.mock('@renderer/components/Popups/ObsidianExportPopup', () => ({ default: { showForMessage: vi.fn() } }))
vi.mock('@renderer/components/Popups/SaveToKnowledgePopup', () => ({ default: { showForMessage: vi.fn() } }))
vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: { show: vi.fn() }
}))

vi.mock('@renderer/context/MessageEditingContext', () => ({
  useMessageEditing: () => ({ startEditing: vi.fn(), stopEditing: vi.fn(), editingMessageId: null })
}))

const updateAssistantSettingsMock = vi.fn()
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

// NOTE: newMessage + topicBranch are intentionally NOT mocked: the real
// selectIsMessageMutable / selectActiveBranchId run against fakeState.
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
  useSelector: (selector: (state: any) => unknown) => selector(fakeState.current),
  shallowEqual: (a: unknown, b: unknown) => a === b
}))

vi.mock('./messageBranch', () => ({
  emitNewBranch: vi.fn(),
  emitTrueBranch: vi.fn()
}))

vi.mock('./MessageTokens', () => ({ default: () => null }))

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

const makeAssistantMessage = (id: string, askId: string, topicId = 'topic-1'): Message =>
  ({
    id,
    topicId,
    role: 'assistant',
    assistantId: 'asst-1',
    askId,
    blocks: [],
    status: 'success'
  }) as unknown as Message

const makeAssistant = (): Assistant =>
  ({
    id: 'asst-1',
    settings: { contextCount: 25, contextWindowAnchor: {} }
  }) as unknown as Assistant

const topic = { id: 'topic-1' } as Topic
const emptyRef = { current: null } as unknown as React.RefObject<HTMLDivElement>

function setFakeState(opts: {
  activeRoute: string | null
  loadedIds: string[]
  mutableIds?: string[]
  mutableRoute?: string | null
  resident?: boolean
  entities?: Record<string, Message>
  branches?: Array<{ id: string; parentBranchId: string | null; anchorMessageId: string }>
}) {
  const { activeRoute, loadedIds, mutableIds, mutableRoute, resident = true, entities, branches = [] } = opts
  fakeState.current = {
    settings: {
      exportMenuOptions: {},
      confirmDeleteMessage: false,
      confirmRegenerateMessage: false
    },
    assistants: { assistants: [] },
    messageBlocks: { entities: {}, ids: [] },
    topicBranch: {
      branchesByTopic: {
        'topic-1': branches.map((b) => ({
          id: b.id,
          topicId: 'topic-1',
          parentBranchId: b.parentBranchId,
          anchorMessageId: b.anchorMessageId,
          name: b.id,
          createdAt: null,
          updatedAt: null
        }))
      },
      activeBranchIdByTopic: activeRoute === null ? {} : { 'topic-1': activeRoute },
      routeGenerationByTopic: {},
      deletionFallbackByTopic: {}
    },
    messages: {
      entities: entities ?? Object.fromEntries(loadedIds.map((id) => [id, makeUserMessage(id)])),
      ids: loadedIds,
      messageIdsByTopic: { 'topic-1': loadedIds },
      currentTopicId: 'topic-1',
      loadingByTopic: {},
      fulfilledByTopic: {},
      displayCount: 10,
      mutableMessageIdsByTopic: mutableIds === undefined ? {} : { 'topic-1': mutableIds },
      mutableRouteByTopic: mutableRoute === undefined ? {} : { 'topic-1': mutableRoute }
    },
    residentRegistry: {
      entries: resident
        ? { 'topic-1': { residentTopic: true, chatData: true, segments: true, applicabilityGeneration: 1 } }
        : {}
    }
  }
}

function renderMenubar(message: Message, opts?: { isAssistantMessage?: boolean; isGrouped?: boolean }) {
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
      />
    </AnchorGroupProvider>
  )
}

describe('MessageMenubar capability gating (real component)', () => {
  beforeEach(() => {
    updateAssistantSettingsMock.mockReset()
  })

  it('owned user message shows edit/delete', () => {
    setFakeState({ activeRoute: 'b1', loadedIds: ['m0', 'c0'], mutableIds: ['c0'], mutableRoute: 'b1' })
    const { unmount } = renderMenubar(makeUserMessage('c0'))
    expect(screen.queryByTestId('msg-edit-btn')).not.toBeNull()
    expect(screen.queryByTestId('message-delete-button')).not.toBeNull()
    unmount()
  })

  it('inherited message hides edit/delete', () => {
    setFakeState({ activeRoute: 'b1', loadedIds: ['m0', 'c0'], mutableIds: ['c0'], mutableRoute: 'b1' })
    const { unmount } = renderMenubar(makeUserMessage('m0'))
    expect(screen.queryByTestId('msg-edit-btn')).toBeNull()
    expect(screen.queryByTestId('message-delete-button')).toBeNull()
    unmount()
  })

  it('referenced owner message keeps edit/delete on the owner route (BRANCH-4/9)', () => {
    // Parent route active; m1 is parent-owned and referenced by a live child.
    // Owner equality only: referenced owned rows stay mutable.
    setFakeState({
      activeRoute: null,
      loadedIds: ['m0', 'm1', 'm2'],
      mutableIds: ['m0', 'm1', 'm2'],
      mutableRoute: null
    })
    const { unmount } = renderMenubar(makeUserMessage('m1'))
    expect(screen.queryByTestId('msg-edit-btn')).not.toBeNull()
    expect(screen.queryByTestId('message-delete-button')).not.toBeNull()
    unmount()
  })

  it('main-null owned message shows edit/delete', () => {
    setFakeState({ activeRoute: null, loadedIds: ['m0', 'm1'], mutableIds: ['m0', 'm1'], mutableRoute: null })
    const { unmount } = renderMenubar(makeUserMessage('m0'))
    expect(screen.queryByTestId('msg-edit-btn')).not.toBeNull()
    expect(screen.queryByTestId('message-delete-button')).not.toBeNull()
    unmount()
  })

  it('unknown capability fails closed (hides edit/delete)', () => {
    setFakeState({ activeRoute: null, loadedIds: ['m0'], mutableIds: undefined, mutableRoute: undefined })
    const { unmount } = renderMenubar(makeUserMessage('m0'))
    expect(screen.queryByTestId('msg-edit-btn')).toBeNull()
    expect(screen.queryByTestId('message-delete-button')).toBeNull()
    unmount()
  })

  it('owned answer group shows mention-model and useful', () => {
    const entities: Record<string, Message> = {
      u1: makeUserMessage('u1'),
      a1: makeAssistantMessage('a1', 'u1'),
      a2: makeAssistantMessage('a2', 'u1')
    }
    setFakeState({
      activeRoute: null,
      loadedIds: ['u1', 'a1', 'a2'],
      mutableIds: ['u1', 'a1', 'a2'],
      mutableRoute: null,
      entities
    })
    const { unmount } = renderMenubar(entities.a1, { isAssistantMessage: true, isGrouped: true })
    expect(screen.queryByTestId('assistant-mention-model')).not.toBeNull()
    expect(screen.queryByTestId('msg-useful-btn')).not.toBeNull()
    unmount()
  })

  it('non-owned answer group hides mention-model and useful', () => {
    const entities: Record<string, Message> = {
      u1: makeUserMessage('u1'),
      a1: makeAssistantMessage('a1', 'u1'),
      a2: makeAssistantMessage('a2', 'u1')
    }
    // a2 is non-owned through this route (absent from the capability): the whole group is immutable.
    setFakeState({
      activeRoute: null,
      loadedIds: ['u1', 'a1', 'a2'],
      mutableIds: ['u1', 'a1'],
      mutableRoute: null,
      entities
    })
    const { unmount } = renderMenubar(entities.a1, { isAssistantMessage: true, isGrouped: true })
    expect(screen.queryByTestId('assistant-mention-model')).toBeNull()
    expect(screen.queryByTestId('msg-useful-btn')).toBeNull()
    unmount()
  })

  it('unknown group capability hides mention-model and useful (fail-closed)', () => {
    const entities: Record<string, Message> = {
      u1: makeUserMessage('u1'),
      a1: makeAssistantMessage('a1', 'u1')
    }
    setFakeState({
      activeRoute: null,
      loadedIds: ['u1', 'a1'],
      mutableIds: undefined,
      mutableRoute: undefined,
      entities
    })
    const { unmount } = renderMenubar(entities.a1, { isAssistantMessage: true, isGrouped: true })
    expect(screen.queryByTestId('assistant-mention-model')).toBeNull()
    expect(screen.queryByTestId('msg-useful-btn')).toBeNull()
    unmount()
  })

  it('true-branch hides on inherited messages including the fork anchor (BRANCH-7)', () => {
    const entities: Record<string, Message> = {
      m0: makeAssistantMessage('m0', 'u0'),
      m1: makeAssistantMessage('m1', 'u0'),
      c0: makeAssistantMessage('c0', 'u9')
    }
    // Active branch b1 anchored at m1; owned suffix is c0 only.
    setFakeState({
      activeRoute: 'b1',
      loadedIds: ['m0', 'm1', 'c0'],
      mutableIds: ['c0'],
      mutableRoute: 'b1',
      entities,
      branches: [{ id: 'b1', parentBranchId: null, anchorMessageId: 'm1' }]
    })
    const owned = renderMenubar(entities.c0, { isAssistantMessage: true })
    expect(screen.queryByTestId('msg-true-branch-btn')).not.toBeNull()
    owned.unmount()
    const inherited = renderMenubar(entities.m0, { isAssistantMessage: true })
    expect(screen.queryByTestId('msg-true-branch-btn')).toBeNull()
    inherited.unmount()
    const forkAnchor = renderMenubar(entities.m1, { isAssistantMessage: true })
    expect(screen.queryByTestId('msg-true-branch-btn')).toBeNull()
    forkAnchor.unmount()
  })

  it('insert shows only at the exact fork anchor among inherited refs (BRANCH-3)', () => {
    const entities: Record<string, Message> = {
      m0: makeAssistantMessage('m0', 'u0'),
      m1: makeAssistantMessage('m1', 'u0'),
      c0: makeAssistantMessage('c0', 'u9')
    }
    setFakeState({
      activeRoute: 'b1',
      loadedIds: ['m0', 'm1', 'c0'],
      mutableIds: ['c0'],
      mutableRoute: 'b1',
      entities,
      branches: [{ id: 'b1', parentBranchId: null, anchorMessageId: 'm1' }]
    })
    const owned = renderMenubar(entities.c0, { isAssistantMessage: true })
    expect(screen.queryByTestId('msg-insert-btn')).not.toBeNull()
    owned.unmount()
    const forkAnchor = renderMenubar(entities.m1, { isAssistantMessage: true })
    expect(screen.queryByTestId('msg-insert-btn')).not.toBeNull()
    forkAnchor.unmount()
    const older = renderMenubar(entities.m0, { isAssistantMessage: true })
    expect(screen.queryByTestId('msg-insert-btn')).toBeNull()
    older.unmount()
  })

  it('unknown/stale branch metadata hides true-branch and insert (fail-closed)', () => {
    const entities: Record<string, Message> = {
      m1: makeAssistantMessage('m1', 'u0'),
      c0: makeAssistantMessage('c0', 'u9')
    }
    // Active route b-stale has no catalog node: both creation actions hide.
    setFakeState({
      activeRoute: 'b-stale',
      loadedIds: ['m1', 'c0'],
      mutableIds: ['m1', 'c0'],
      mutableRoute: 'b-stale',
      entities,
      branches: []
    })
    const { unmount } = renderMenubar(entities.c0, { isAssistantMessage: true })
    expect(screen.queryByTestId('msg-true-branch-btn')).toBeNull()
    expect(screen.queryByTestId('msg-insert-btn')).toBeNull()
    unmount()
  })
})
