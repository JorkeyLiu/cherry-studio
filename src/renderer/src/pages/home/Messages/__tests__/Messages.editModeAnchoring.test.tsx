/**
 * Regression: edit-mode toggle must preserve #messages host and non-bottom scrollTop.
 * Defect: #messages at -11435 reset to 0 and host was disconnected/replaced on toggle,
 * while scrollHeight/clientHeight unchanged. Fix preserves host (stable outer EditModeProvider
 * with internal bridge) and keeps current scroll position.
 * This test exercises the actual EditModeProvider (not mocked) via integration.
 */
import { configureStore } from '@reduxjs/toolkit'
import clipboardReducer from '@renderer/store/clipboard'
import editModeReducer from '@renderer/store/editMode'
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const defaultSharedContextInfo = {
  uiMessages: [] as Message[],
  tokenEstimationMessages: [] as Message[],
  boundaryMessageId: null,
  contextCount: { current: 0, max: null },
  anchorGroupKey: null
}

const mocks = vi.hoisted(() => {
  const scrollContainerRef: { current: HTMLElement | null } = { current: null }
  const handleScrollSpy = vi.fn()
  return {
    scrollContainerRef,
    handleScrollSpy,
    topicMessages: [] as Message[],
    setTimeoutTimer: vi.fn((_name: string, fn: () => void, _ms: number) => fn()),
    clearTimeoutTimer: vi.fn(),
    eventHandlers: {} as Record<string, (...args: any[]) => any>,
    eventSubscribe: vi.fn((event: string, handler: (...args: any[]) => any) => {
      mocks.eventHandlers[event] = handler
      return vi.fn()
    }),
    ensureMock: vi.fn(async () => ({ status: 'resident' }) as any),
    toastErrorMock: vi.fn()
  }
})

// Clipboard/Undo mocks needed for heavy hook
vi.mock('@renderer/services/ClipboardService', () => ({
  copyMessages: vi.fn(),
  cutMessages: vi.fn(),
  deleteSelectedMessages: vi.fn(),
  pasteMessages: vi.fn()
}))
vi.mock('@renderer/services/UndoService', () => ({
  executeUndo: vi.fn(),
  executeRedo: vi.fn()
}))
vi.mock('@renderer/services/db/topicMetadataPersist', () => ({
  default: {}
}))
vi.mock('@renderer/services/db/SqliteMessageDataSource', () => ({
  SqliteMessageDataSource: class {
    constructor() {}
  }
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ addTopic: vi.fn(), updateAssistantSettings: vi.fn() })
}))
vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => ({ isMultiSelectMode: false, handleSelectMessage: vi.fn() })
}))
vi.mock('@renderer/hooks/useClipboardKeyboard', () => ({ useClipboardKeyboard: vi.fn() }))
vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: () => mocks.topicMessages,
  useTopicLoading: () => false,
  useMessageOperations: () => ({ displayCount: 20, createTopicBranchByAnchor: vi.fn() })
}))
vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    selectAnswer: vi.fn().mockResolvedValue(undefined),
    regenerateAssistant: vi.fn().mockResolvedValue(undefined),
    resendUser: vi.fn().mockResolvedValue(undefined),
    editSave: vi.fn().mockResolvedValue(true),
    resendWithEdit: vi.fn().mockResolvedValue(true)
  })
}))
vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: (_key: string) => ({
    containerRef: mocks.scrollContainerRef,
    handleScroll: mocks.handleScrollSpy,
    getSavedPosition: vi.fn(() => null),
    clearSavedPosition: vi.fn(),
    savePosition: vi.fn()
  })
}))
vi.mock('@renderer/hooks/useShortcuts', () => ({ useShortcut: vi.fn() }))
vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: mocks.setTimeoutTimer, clearTimeoutTimer: mocks.clearTimeoutTimer })
}))
vi.mock('@renderer/hooks/useTopic', () => ({ autoRenameTopic: vi.fn() }))
vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({
    isMessageFirstInSegment: vi.fn(() => false),
    isMessageLastInSegment: vi.fn(() => false),
    isMessageInSegment: vi.fn(() => undefined)
  })
}))
vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    SEND_MESSAGE: 'SEND_MESSAGE',
    SCROLL_TO_BOTTOM: 'SCROLL_TO_BOTTOM',
    COPY_TOPIC_IMAGE: 'COPY_TOPIC_IMAGE',
    EXPORT_TOPIC_IMAGE: 'EXPORT_TOPIC_IMAGE',
    NEW_BRANCH: 'NEW_BRANCH',
    EDIT_CODE_BLOCK: 'EDIT_CODE_BLOCK',
    NAVIGATE_TO_MESSAGE: 'NAVIGATE_TO_MESSAGE'
  },
  EventEmitter: { on: mocks.eventSubscribe, emit: vi.fn() }
}))
vi.mock('@renderer/services/MessagesService', () => ({
  getPendingNavigate: vi.fn(() => null),
  clearPendingNavigate: vi.fn(() => true)
}))
vi.mock('@renderer/services/phaseTimingDiagnostics', () => ({
  currentPhaseCorrelation: vi.fn(() => null),
  recordPhaseDurationForCorrelation: vi.fn(),
  recordPhaseEndpoint: vi.fn()
}))
vi.mock('@renderer/store/messageBlock', () => ({
  default: (state: any = { entities: {} }) => state,
  messageBlocksSelectors: { selectById: vi.fn() },
  updateOneBlock: vi.fn(),
  upsertManyBlocks: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertMany', payload: blocks })),
  messageBlocksReducer: (state: any = { entities: {} }) => state
}))
vi.mock('@renderer/store/newMessage', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      messagesReceived: vi.fn((payload: unknown) => ({ type: 'newMessages/messagesReceived', payload }))
    }
  }
})
vi.mock('@renderer/store/thunk/messageThunk', () => ({ updateMessageAndBlocksThunk: vi.fn() }))
vi.mock('@renderer/services/anchorService', () => ({
  buildGroupList: vi.fn(() => []),
  ensureTopicAnchorEstablished: vi.fn(),
  inheritAnchorForBranch: vi.fn()
}))
vi.mock('@renderer/services/AssistantService', () => ({
  DEFAULT_ASSISTANT_SETTINGS: { contextCount: 25, contextWindowAnchor: {} },
  getAssistantSettings: vi.fn(() => ({})),
  getDefaultAssistant: vi.fn(() => ({ id: 'assistant-1', settings: {} })),
  getDefaultTopic: vi.fn(() => ({ id: 'default-topic', name: 'Default' }))
}))
vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    resolveContextClosure: vi.fn(async () => ({ resolvedAnchorGroupKey: null }) as any),
    fetchMessagesWindow: vi.fn()
  },
  DbService: vi.fn()
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    resolveContextClosure: vi.fn(async () => ({ resolvedAnchorGroupKey: null }) as any),
    fetchMessagesWindow: vi.fn()
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  ensureOrdinaryTopicOwnership: vi.fn(),
  consumeFileCleanupResult: vi.fn()
}))
vi.mock('@renderer/utils', () => ({
  captureScrollableAsBlob: vi.fn(),
  captureScrollableAsDataURL: vi.fn(),
  removeSpecialCharactersForFileName: vi.fn()
}))
vi.mock('@renderer/utils/dom', () => ({ scrollIntoView: vi.fn() }))
vi.mock('@renderer/utils/markdown', () => ({ updateCodeBlock: vi.fn() }))
vi.mock('@renderer/utils/messageUtils/find', () => ({ getMainTextContent: vi.fn(() => '') }))
vi.mock('@renderer/utils/messageUtils/is', () => ({ isTextLikeBlock: vi.fn(() => false) }))
vi.mock('@renderer/pages/home/Messages/domVisibility', () => ({
  findFirstVisibleMessage: vi.fn(() => null),
  findFirstVisibleMessageId: vi.fn(() => null)
}))
vi.mock('@renderer/pages/home/Messages/messageBranch', () => ({ branchFromMessage: vi.fn() }))
vi.mock('@renderer/pages/home/Messages/messageNavigation', async () => {
  const actual = await vi.importActual('../messageNavigation')
  return { ...actual, runMessageNavigationTransaction: vi.fn(async () => 'success' as const) }
})
vi.mock('@renderer/pages/home/Messages/messageNavigationLoader', () => ({
  ensureMessageLoaded: (...args: any[]) => (mocks.ensureMock as (...args: any[]) => unknown)(...args),
  buildNavigationAroundRequest: vi.fn(),
  NAVIGATION_LOADER_BEFORE: 10,
  NAVIGATION_LOADER_AFTER: 19
}))
vi.mock('@renderer/pages/home/Messages/messageViewportProjection', () => ({
  projectMessageViewportGroups: vi.fn(() => [])
}))
vi.mock('@renderer/pages/home/Messages/MessageGroup', () => ({
  default: vi.fn(() => <div data-testid="message-group" />)
}))
vi.mock('@renderer/pages/home/Messages/Prompt', () => ({
  default: vi.fn(() => <div data-testid="prompt" />)
}))
vi.mock('@renderer/pages/home/Messages/SelectionBox', () => ({ default: vi.fn(() => null) }))
vi.mock('@renderer/pages/home/Messages/MessageContextMenu', () => ({
  default: ({ children }: any) => <div data-testid="message-context-menu">{children}</div>
}))
vi.mock('@renderer/pages/home/Messages/TopicSegmentLine', () => ({ default: vi.fn(() => null) }))
vi.mock('@renderer/pages/home/Messages/anchorGroupContext', () => ({
  AnchorGroupProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="anchor-group-provider">{children}</div>
  )
}))
vi.mock('@renderer/components/EditModeActionBar', () => ({
  default: vi.fn(() => <div data-testid="edit-mode-action-bar" />)
}))
vi.mock('@renderer/components/Icons', () => ({ LoadingIcon: vi.fn(() => <div data-testid="loading-icon" />) }))
vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children, ...props }: any) => (
    <div data-testid="scrollbar" {...props}>
      {children}
    </div>
  )
}))
vi.mock('@renderer/config/constant', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, LOAD_MORE_COUNT: 20 }
})
vi.mock('react-infinite-scroll-component', () => ({
  default: ({ children }: any) => <div data-testid="infinite-scroll">{children}</div>
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock('@renderer/hooks/useTopicTransition', () => ({
  useTopicTransition: vi.fn()
}))

const Messages = (await import('../Messages')).default

const makeTopic = (id: string): Topic => ({ id, name: `Topic ${id}`, assistantId: 'assistant-1' }) as unknown as Topic
const makeAssistant = (id = 'assistant-1'): Assistant =>
  ({ id, name: 'Test Assistant', prompt: '' }) as unknown as Assistant

function makeStore(enabled: boolean) {
  return configureStore({
    reducer: {
      editMode: editModeReducer,
      clipboard: clipboardReducer,
      undoStack: (state: any = { undoStack: [], redoStack: [] }) => state,
      messages: (
        state: any = {
          entities: {},
          messageIdsByTopic: {},
          loadingByTopic: {},
          displayCount: 20,
          currentTopicId: 'topic-1'
        }
      ) => state,
      messageBlocks: (state: any = { entities: {} }) => state,
      topicSegments: (state: any = { segments: { entities: {}, ids: [] }, segmentsByTopic: {} }) => state,
      residentRegistry: (
        state: any = {
          entries: {
            'topic-1': { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 1 },
            'topic-a': { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 1 },
            'topic-b': { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 1 }
          }
        }
      ) => state
    } as any,
    preloadedState: {
      editMode: {
        enabled,
        selectedGroupIds: [],
        lastSelectedIndex: null,
        focusedIndex: null,
        isProcessing: false
      },
      clipboard: { mode: null, items: [], sourceTopicId: null, timestamp: 0, segmentSnapshots: [] },
      undoStack: { undoStack: [], redoStack: [] },
      messages: {
        entities: {},
        messageIdsByTopic: { 'topic-1': [], 'topic-a': [], 'topic-b': [] },
        loadingByTopic: {},
        displayCount: 20,
        currentTopicId: 'topic-1'
      },
      messageBlocks: { entities: {} },
      topicSegments: { segments: { entities: {}, ids: [] }, segmentsByTopic: {} },
      residentRegistry: {
        entries: {
          'topic-1': { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 1 },
          'topic-a': { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 1 },
          'topic-b': { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 1 }
        }
      }
    } as any
  })
}

describe('Messages edit-mode host regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.topicMessages = [] as any
    ;(window as any).toast = { error: mocks.toastErrorMock, success: vi.fn(), warning: vi.fn(), loading: vi.fn() }
  })

  it('preserves #messages host identity and non-bottom scrollTop across edit-mode enter and exit (real EditModeProvider)', async () => {
    const topic = makeTopic('topic-1')
    const assistant = makeAssistant()
    const store = makeStore(false)

    const { rerender } = render(
      <Provider store={store}>
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      </Provider>
    )

    const hostBefore = document.getElementById('messages')
    expect(hostBefore).not.toBeNull()
    Object.defineProperty(hostBefore!, 'scrollHeight', { value: 20000, configurable: true })
    Object.defineProperty(hostBefore!, 'clientHeight', { value: 800, configurable: true })
    hostBefore!.scrollTop = -11435
    mocks.scrollContainerRef.current = hostBefore as unknown as HTMLElement

    // Enter edit mode via real store dispatch — exercises actual EditModeProvider
    await act(async () => {
      store.dispatch({ type: 'editMode/toggleEditMode', payload: true } as any)
    })
    // Rerender to propagate store change (Messages reads via Provider)
    await act(async () => {
      rerender(
        <Provider store={store}>
          <Messages
            assistant={assistant}
            topic={topic}
            setActiveTopic={vi.fn()}
            sharedContextInfo={defaultSharedContextInfo}
          />
        </Provider>
      )
    })

    const hostAfterEnter = document.getElementById('messages')
    expect(hostAfterEnter).not.toBeNull()
    expect(hostAfterEnter).toBe(hostBefore)
    expect(hostAfterEnter!.isConnected).toBe(true)
    expect(hostAfterEnter!.scrollTop).toBe(-11435)
    expect(hostAfterEnter!.scrollHeight).toBe(20000)
    expect(hostAfterEnter!.clientHeight).toBe(800)
    // Heavy marker must be active now (real provider)
    expect(document.querySelector('[data-testid="edit-heavy-active"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="edit-heavy-inactive"]')).toBeNull()

    hostAfterEnter!.scrollTop = -5000

    await act(async () => {
      store.dispatch({ type: 'editMode/toggleEditMode', payload: false } as any)
    })
    await act(async () => {
      rerender(
        <Provider store={store}>
          <Messages
            assistant={assistant}
            topic={topic}
            setActiveTopic={vi.fn()}
            sharedContextInfo={defaultSharedContextInfo}
          />
        </Provider>
      )
    })

    const hostAfterExit = document.getElementById('messages')
    expect(hostAfterExit).toBe(hostBefore)
    expect(hostAfterExit!.isConnected).toBe(true)
    expect(hostAfterExit!.scrollTop).toBe(-5000)
    expect(document.querySelector('[data-testid="edit-heavy-inactive"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="edit-heavy-active"]')).toBeNull()
  })

  it('ordinary topic change still preserves host via mounted transition (no key remount) but scroll lifecycle is per-topic via save/restore', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()
    const store = makeStore(false)

    const { rerender } = render(
      <Provider store={store}>
        <Messages
          assistant={assistant}
          topic={topicA}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      </Provider>
    )

    const hostA = document.getElementById('messages')
    expect(hostA).not.toBeNull()
    hostA!.scrollTop = -8000
    mocks.scrollContainerRef.current = hostA as unknown as HTMLElement

    await act(async () => {
      rerender(
        <Provider store={store}>
          <Messages
            assistant={assistant}
            topic={topicB}
            setActiveTopic={vi.fn()}
            sharedContextInfo={defaultSharedContextInfo}
          />
        </Provider>
      )
    })

    const hostB = document.getElementById('messages')
    expect(hostB).toBe(hostA)
    expect(hostB!.isConnected).toBe(true)
  })

  it('assistant change does not remount host due to removed key (host stable)', async () => {
    const topic = makeTopic('topic-1')
    const assistant1 = makeAssistant('assistant-1')
    const assistant2 = makeAssistant('assistant-2')
    const store = makeStore(false)

    const { rerender } = render(
      <Provider store={store}>
        <Messages
          assistant={assistant1}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      </Provider>
    )

    const host1 = document.getElementById('messages')
    expect(host1).not.toBeNull()
    host1!.scrollTop = -9000
    mocks.scrollContainerRef.current = host1 as unknown as HTMLElement

    await act(async () => {
      rerender(
        <Provider store={store}>
          <Messages
            assistant={assistant2}
            topic={topic}
            setActiveTopic={vi.fn()}
            sharedContextInfo={defaultSharedContextInfo}
          />
        </Provider>
      )
    })

    const host2 = document.getElementById('messages')
    expect(host2).toBe(host1)
    expect(host2!.scrollTop).toBe(-9000)
  })
})
