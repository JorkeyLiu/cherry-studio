/**
 * Message-fold navigation reveal — mounted Messages integration (production
 * component, real navigation transaction, real viewport reducer).
 *
 * Claim under test: a navigation target whose loaded row carries its own
 * message-level fold flag and whose block is COLLAPSED is presentation-hidden,
 * not missing. The transaction answers it MARKER-ONLY: it positions the
 * viewport on the block's mounted collapsed marker — the `[data-folded-
 * message-ids]` root listing the hidden id — and settles. It never writes
 * `expandedFoldSectionIds`, never expands, never selects, never writes fold
 * state. Only a manual expand gesture (the block's own expand control) opens
 * a block; selection ranges and keyboard moves passing through hidden members
 * never expand either.
 *
 * The mocked `MessageGroup` renders one real row per message it receives, so
 * "the row is gone while collapsed and stays gone after a navigation" is a
 * DOM fact of this suite, exactly as the production body-visibility decision
 * produces it. Geometry is supplied through a prototype-level rect stub keyed
 * by row id (and by the collapsed marker test id), the technique the
 * reading-anchor and selection-follow suites use.
 */
import { configureStore } from '@reduxjs/toolkit'
import { dbService } from '@renderer/services/db'
import clipboardReducer from '@renderer/store/clipboard'
import editModeReducer from '@renderer/store/editMode'
import type { Assistant, Topic } from '@renderer/types'
import { AssistantMessageStatus, type Message, UserMessageStatus } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const defaultSharedContextInfo = {
  uiMessages: [] as Message[],
  tokenEstimationMessages: [] as Message[],
  boundaryMessageId: null,
  contextCount: { current: 0, max: null },
  anchorGroupKey: null,
  blockSnapshot: new Map()
}

const mocks = vi.hoisted(() => {
  const scrollContainerRef: { current: HTMLElement | null } = { current: null }
  const handleScrollSpy = vi.fn()
  // Stable hook identities (mirror production useScrollPosition/useTranslation
  // stability): Messages holds these in effect dep arrays, so fresh closures
  // per render would re-run the route pipeline every render and never settle.
  const getSavedPositionStable = vi.fn(() => null)
  const getSnapshotForRouteStable = vi.fn(() => null)
  const clearSavedPositionStable = vi.fn()
  const savePositionStable = vi.fn()
  const captureSnapshotStable = vi.fn(() => null)
  const tStable = (key: string): string => key
  const selectAnswerStable = vi.fn().mockResolvedValue(undefined)
  const regenerateAssistantStable = vi.fn().mockResolvedValue(undefined)
  const resendUserStable = vi.fn().mockResolvedValue(undefined)
  const editSaveStable = vi.fn().mockResolvedValue(true)
  const resendWithEditStable = vi.fn().mockResolvedValue(true)
  return {
    scrollContainerRef,
    handleScrollSpy,
    getSavedPositionStable,
    getSnapshotForRouteStable,
    clearSavedPositionStable,
    savePositionStable,
    captureSnapshotStable,
    tStable,
    selectAnswerStable,
    regenerateAssistantStable,
    resendUserStable,
    editSaveStable,
    resendWithEditStable,
    topicMessages: [] as Message[],
    setTimeoutTimer: vi.fn((_name: string, fn: () => void) => fn()),
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
vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: () => mocks.topicMessages,
  useTopicLoading: () => false,
  useMessageOperations: () => ({ displayCount: 20, createTopicBranchByAnchor: vi.fn() })
}))
vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    selectAnswer: mocks.selectAnswerStable,
    regenerateAssistant: mocks.regenerateAssistantStable,
    resendUser: mocks.resendUserStable,
    editSave: mocks.editSaveStable,
    resendWithEdit: mocks.resendWithEditStable
  })
}))
vi.mock('@renderer/hooks/useScrollPosition', () => ({
  commitSnapshotForRoute: vi.fn(() => true),
  routeScrollKey: (topicId: string, branchId: string | null) => `topic-${topicId}::${branchId ?? 'main'}`,
  default: () => ({
    containerRef: mocks.scrollContainerRef,
    handleScroll: mocks.handleScrollSpy,
    getSavedPosition: mocks.getSavedPositionStable,
    getSnapshotForRoute: mocks.getSnapshotForRouteStable,
    clearSavedPosition: mocks.clearSavedPositionStable,
    savePosition: mocks.savePositionStable,
    captureSnapshot: mocks.captureSnapshotStable
  })
}))
vi.mock('@renderer/hooks/useShortcuts', () => ({ useShortcut: vi.fn() }))
vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: mocks.setTimeoutTimer, clearTimeoutTimer: mocks.clearTimeoutTimer })
}))
vi.mock('@renderer/hooks/useTopic', () => ({ autoRenameTopic: vi.fn() }))
// Group presentation is structural chrome, not the claim under test.
vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({
    isMessageFirstInSegment: vi.fn(() => false),
    isMessageLastInSegment: vi.fn(() => false),
    isMessageInSegment: vi.fn(() => undefined),
    segmentsForTopic: [],
    orderedSegmentsForTopic: []
  })
}))
// Messages reads the chat surface's one route-structure value from its owning
// provider. This suite mounts Messages alone with an empty segment catalog, so
// the real read fails closed (no read, no segments, `isCurrent` false); the
// stub pins that state without pulling the structural read into the suite.
vi.mock('../../ChatRouteStructure', () => {
  const routeStructure = {
    segments: [],
    routeKey: '',
    isCurrent: false,
    committedChrome: null,
    acceptCommittedStructure: vi.fn()
  }
  return { useChatRouteStructure: () => routeStructure }
})
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
    },
    selectLoadedMessagesForTopic: () => mocks.topicMessages
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
    fetchMessagesWindow: vi.fn(),
    setTurnFolds: vi.fn()
  },
  DbService: vi.fn()
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    resolveContextClosure: vi.fn(async () => ({ resolvedAnchorGroupKey: null }) as any),
    fetchMessagesWindow: vi.fn(),
    setTurnFolds: vi.fn()
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
vi.mock('@renderer/utils/messageUtils/is', () => ({
  isTextLikeBlock: vi.fn(() => false),
  isMessageProcessing: vi.fn(() => false)
}))
vi.mock('@renderer/pages/home/Messages/domVisibility', async () => {
  const actual = await vi.importActual('@renderer/pages/home/Messages/domVisibility')
  return {
    ...actual,
    findFirstVisibleMessage: vi.fn(() => null),
    findFirstVisibleMessageId: vi.fn(() => null)
  }
})
vi.mock('@renderer/pages/home/Messages/messageBranch', () => ({ branchFromMessage: vi.fn() }))
// The navigation transaction stays REAL: this suite proves the production
// runner positions a fold-hidden target on its collapsed marker and settles,
// so the runner and its deps must be untouched.
vi.mock('@renderer/pages/home/Messages/messageNavigationLoader', () => ({
  ensureMessageLoaded: (...args: any[]) => (mocks.ensureMock as (...args: any[]) => unknown)(...args),
  buildNavigationAroundRequest: vi.fn(),
  NAVIGATION_LOADER_BEFORE: 10,
  NAVIGATION_LOADER_AFTER: 19
}))
// Every message of a mounted group publishes its own stable row id. When the
// flow hides the turn bodies (a collapsed fold block), these rows are not
// rendered at all — exactly the production body-visibility decision.
vi.mock('@renderer/pages/home/Messages/MessageGroup', () => ({
  default: ({ messages }: { messages: Message[] }) => (
    <div data-testid="message-group">
      {messages.map((message) => (
        <div key={message.id} id={`message-${message.id}`} data-testid={`message-row-${message.id}`} />
      ))}
    </div>
  )
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
  default: vi.fn(() => <div data-testid="edit-mode-action-bar" style={{ position: 'absolute', top: 0 }} />)
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
vi.mock('react-i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, useTranslation: () => ({ t: mocks.tStable }) }
})
vi.mock('@renderer/hooks/useTopicTransition', () => ({ useTopicTransition: vi.fn() }))

const Messages = (await import('../Messages')).default

const makeTopic = (id: string): Topic => ({ id, name: `Topic ${id}`, assistantId: 'assistant-1' }) as unknown as Topic
const makeAssistant = (id = 'assistant-1'): Assistant =>
  ({ id, name: 'Test Assistant', prompt: '' }) as unknown as Assistant

function makeStore() {
  const residentEntry = { chatData: true, segments: true, residentTopic: true, applicabilityGeneration: 1 }
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
      residentRegistry: (state: any = { entries: {} }) => state
    } as any,
    preloadedState: {
      editMode: {
        enabled: false,
        selectedGroupIds: [],
        lastSelectedIndex: null,
        focusedIndex: null,
        isProcessing: false
      },
      clipboard: { mode: null, items: [], sourceTopicId: null, timestamp: 0, segmentSnapshots: [] },
      undoStack: { undoStack: [], redoStack: [] },
      messages: {
        entities: {},
        messageIdsByTopic: { 'topic-1': [] },
        loadingByTopic: {},
        displayCount: 20,
        currentTopicId: 'topic-1'
      },
      messageBlocks: { entities: {} },
      topicSegments: { segments: { entities: {}, ids: [] }, segmentsByTopic: {} },
      residentRegistry: { entries: { 'topic-1': residentEntry } }
    } as any
  })
}

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top }) as DOMRect

/** Row geometry, keyed by message id, for the current test. */
let rowTops: Record<string, number> = {}
/** Collapsed-marker geometry for the current test (the marker has no row id). */
let markerTop = 0

/**
 * Build `turns` Q&A turns. Ids in `foldedIds` carry the message-level fold flag,
 * which is the only fold input the flow consumes.
 */
const makeTurns = (turns: number, foldedIds: string[] = [], topicId = 'topic-1'): Message[] => {
  const folded = new Set(foldedIds)
  return Array.from({ length: turns }, (_, index) => index).flatMap((index) => {
    const userId = `u${index}`
    const assistantId = `a${index}`
    return [
      {
        id: userId,
        topicId,
        role: 'user',
        assistantId: 'assistant-1',
        createdAt: `2026-01-01T00:0${index}:00.000Z`,
        status: UserMessageStatus.SUCCESS,
        blocks: [],
        ...(folded.has(userId) ? { folded: true } : {})
      },
      {
        id: assistantId,
        topicId,
        askId: userId,
        role: 'assistant',
        assistantId: 'assistant-1',
        createdAt: `2026-01-01T00:0${index}:01.000Z`,
        status: AssistantMessageStatus.SUCCESS,
        blocks: [],
        ...(folded.has(assistantId) ? { folded: true } : {})
      }
    ]
  }) as unknown as Message[]
}

let rafQueue: FrameRequestCallback[] = []
const installManualRaf = (): void => {
  rafQueue = []
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback): number => {
      rafQueue.push(cb)
      return rafQueue.length
    })
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn(() => undefined)
  )
}

/** Drains the manual rAF queue with real microtask turns between frames. */
const flushRaf = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    const pending = rafQueue
    rafQueue = []
    for (const cb of pending) {
      try {
        cb(0)
      } catch {}
    }
    await act(async () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const cleanupDom = (): void => {
  mocks.scrollContainerRef.current = null
  rowTops = {}
  markerTop = 0
}

/** Real scroll host of the mounted component, with a measurable box. */
const graftContainer = (): HTMLElement => {
  const host = document.getElementById('messages') as HTMLElement
  Object.defineProperty(host, 'scrollHeight', { value: 6000, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true })
  Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
  host.getBoundingClientRect = () => rect(0, 800)
  mocks.scrollContainerRef.current = host
  return host
}

const renderMessages = (store: ReturnType<typeof makeStore>) =>
  render(
    <Provider store={store}>
      <Messages
        assistant={makeAssistant()}
        topic={makeTopic('topic-1')}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    </Provider>
  )

const rerenderMessages = (view: ReturnType<typeof renderMessages>, store: ReturnType<typeof makeStore>) =>
  view.rerender(
    <Provider store={store}>
      <Messages
        assistant={makeAssistant()}
        topic={makeTopic('topic-1')}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    </Provider>
  )

const fireNavigation = async (messageId: string, rounds = 8): Promise<void> => {
  const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
  expect(typeof handler).toBe('function')
  await act(async () => {
    void handler(messageId)
  })
  await flushRaf(rounds)
}

const collapsedBlock = (): HTMLElement | null => document.querySelector('[data-testid="folded-section-collapsed"]')
const expandedBlock = (): HTMLElement | null => document.querySelector('[data-testid="folded-section-expanded"]')
const rowFor = (messageId: string): HTMLElement | null => document.getElementById(`message-${messageId}`)

describe('Message-fold navigation reveal (mounted Messages)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.topicMessages = [] as any
    mocks.scrollContainerRef.current = null
    mocks.ensureMock.mockReset()
    mocks.ensureMock.mockImplementation(async () => ({ status: 'resident' }) as any)
    ;(window as any).toast = { error: mocks.toastErrorMock, success: vi.fn(), warning: vi.fn(), loading: vi.fn() }
    installManualRaf()
    cleanupDom()
    // Row geometry comes from this stub; everything else keeps jsdom's box.
    // The collapsed marker carries no row id, so its geometry is keyed by its
    // test id through the per-test `markerTop`.
    const original = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.id
      if (id.startsWith('message-')) {
        const messageId = id.slice('message-'.length)
        return rect(rowTops[messageId] ?? 0, 100)
      }
      if (this.getAttribute?.('data-testid') === 'folded-section-collapsed') {
        return rect(markerTop, 60)
      }
      return original.call(this)
    })
  })

  it('positions a fold-hidden target on its collapsed marker and never expands the block', async () => {
    // Turn 2 (u1/a1) is folded: its rows are not mounted while the block is closed.
    mocks.topicMessages = makeTurns(2, ['u1', 'a1'])
    const store = makeStore()
    renderMessages(store)
    await act(async () => {})

    const host = graftContainer()
    const scrollTo = vi.fn()
    ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    rowTops = { a1: 4200, u1: 4100 }
    markerTop = 4300

    // Collapsed: the block is closed and the target row genuinely has no element.
    const marker = collapsedBlock()
    expect(marker).not.toBeNull()
    // The marker stands in for exactly the hidden members of its block.
    expect(marker?.getAttribute('data-folded-message-ids')).toContain('u1')
    expect(marker?.getAttribute('data-folded-message-ids')).toContain('a1')
    expect(rowFor('a1')).toBeNull()

    await fireNavigation('a1')

    // Marker-only: the block stays collapsed (never auto-expanded), the hidden
    // row stays unmounted, and the single scroll write lands on the marker.
    expect(collapsedBlock()).not.toBeNull()
    expect(expandedBlock()).toBeNull()
    expect(rowFor('a1')).toBeNull()
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 4300 })
    // A reveal is presentation: nothing is selected and nothing is written —
    // no fold write either, since only a manual expand may open the block.
    expect(mocks.selectAnswerStable).not.toHaveBeenCalled()
    expect(dbService.setTurnFolds).not.toHaveBeenCalled()
  })

  it('keeps the unchanged row path for an unfolded target', async () => {
    mocks.topicMessages = makeTurns(2)
    const store = makeStore()
    renderMessages(store)
    await act(async () => {})

    const host = graftContainer()
    const scrollTo = vi.fn()
    ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    rowTops = { a1: 4800 }

    expect(collapsedBlock()).toBeNull()
    expect(rowFor('a1')).not.toBeNull()

    await fireNavigation('a1')

    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 4800 })
    expect(expandedBlock()).toBeNull()
  })

  it('never toggles the block on a second navigation to the same hidden target', async () => {
    mocks.topicMessages = makeTurns(2, ['u1', 'a1'])
    const store = makeStore()
    renderMessages(store)
    await act(async () => {})

    const host = graftContainer()
    const scrollTo = vi.fn()
    ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    markerTop = 4300

    await fireNavigation('a1')
    expect(collapsedBlock()).not.toBeNull()
    expect(expandedBlock()).toBeNull()

    await fireNavigation('a1')

    // Still collapsed (navigating inside it never opens it) and positioned
    // on the marker again.
    expect(collapsedBlock()).not.toBeNull()
    expect(expandedBlock()).toBeNull()
    expect(rowFor('a1')).toBeNull()
    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 4300 })
    expect(dbService.setTurnFolds).not.toHaveBeenCalled()
  })

  it('loads the around window for a non-resident folded target, then positions its marker', async () => {
    const loaded = makeTurns(3, ['u2', 'a2'])
    mocks.topicMessages = loaded.slice(0, 4) as any
    mocks.ensureMock.mockImplementation(async () => ({ status: 'loaded', messages: loaded, blocks: [] }) as any)
    const store = makeStore()
    const view = renderMessages(store)
    await act(async () => {})

    const host = graftContainer()
    const scrollTo = vi.fn()
    ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    markerTop = 3600

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    expect(typeof handler).toBe('function')
    await act(async () => {
      void handler('a2')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // The around read only publishes after the loader resolves: the projection
    // becomes observable here, exactly as the real messagesWindowMerged commit
    // would make it.
    mocks.topicMessages = loaded as any
    await act(async () => {
      rerenderMessages(view, store)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    await flushRaf(10)

    expect(mocks.ensureMock).toHaveBeenCalledTimes(1)
    // The loaded block stays collapsed: the window load mounts the marker, and
    // the transaction positions that marker — it never expands the block.
    expect(collapsedBlock()).not.toBeNull()
    expect(expandedBlock()).toBeNull()
    expect(collapsedBlock()?.getAttribute('data-folded-message-ids')).toContain('a2')
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 3600 })
    expect(mocks.selectAnswerStable).not.toHaveBeenCalled()
  })
})
