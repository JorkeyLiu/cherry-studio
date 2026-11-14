/**
 * Folded-segment navigation — mounted Messages integration (production
 * component, real navigation transaction, real viewport reducer).
 *
 * Claim under test: navigating to a member of a FOLDED (collapsed) segment
 * positions the viewport on the collapsed segment header label — the only
 * painted box the fold has — without expanding the group, selecting an answer,
 * or writing fold metadata. The authority path stays first-message-id based:
 * resident targets resolve straight through, non-resident targets still load
 * their around window first, and an expanded target keeps the unchanged row
 * path. A group whose closing animation still has its body mounted still
 * navigates its LABEL (presentation wins over the disappearing body).
 *
 * The mocked `MessageGroup`/`TopicSegmentLine` render no rows, so geometry
 * fixtures (rows and the real chrome DOM contract: the group's in-flow 32px
 * `topic-segment-group` header row holding a 24px `topic-segment-label`) are
 * grafted into the live `#messages` host — the same technique the
 * reading-anchor and selection-follow suites use. The header row is a real
 * normal-flow row in both states; navigation still measures the LABEL, the only
 * painted box, never the row band.
 */
import { configureStore } from '@reduxjs/toolkit'
import clipboardReducer from '@renderer/store/clipboard'
import editModeReducer from '@renderer/store/editMode'
import type { Assistant, Topic } from '@renderer/types'
import { AssistantMessageStatus, type Message, UserMessageStatus } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveNavigationPresentationTarget } from '../messageNavigation'

const FOLDED_SEGMENT_ID = 'seg-folded'

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
// `MessagesContent` reads the segment catalog here for its own display
// projection; the navigation claim under test reads the AUTHORITY catalog
// through the store selectors, so this mock stays empty.
vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({
    isMessageFirstInSegment: vi.fn(() => false),
    isMessageLastInSegment: vi.fn(() => false),
    isMessageInSegment: vi.fn(() => undefined),
    segmentsForTopic: []
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
// runner positions the label, so the runner and its deps must be untouched.
vi.mock('@renderer/pages/home/Messages/messageNavigationLoader', () => ({
  ensureMessageLoaded: (...args: any[]) => (mocks.ensureMock as (...args: any[]) => unknown)(...args),
  buildNavigationAroundRequest: vi.fn(),
  NAVIGATION_LOADER_BEFORE: 10,
  NAVIGATION_LOADER_AFTER: 19
}))
vi.mock('@renderer/pages/home/Messages/messageViewportProjection', () => ({
  projectMessageViewportGroups: vi.fn(() => []),
  createViewportProjectionCache: () => ({ project: () => [], clear: () => {}, size: () => 0 })
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

const foldedSegmentCatalog = (folded: boolean, topicId = 'topic-1') =>
  folded
    ? {
        segments: {
          entities: {
            [FOLDED_SEGMENT_ID]: {
              id: FOLDED_SEGMENT_ID,
              topicId,
              name: 'Folded group',
              messageIds: ['a0', 'a1', 'a2'],
              folded: true,
              sortOrder: 0
            }
          },
          ids: [FOLDED_SEGMENT_ID]
        },
        segmentsByTopic: { [topicId]: [FOLDED_SEGMENT_ID] }
      }
    : { segments: { entities: {}, ids: [] }, segmentsByTopic: {} }

function makeStore(folded: boolean) {
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
      topicSegments: foldedSegmentCatalog(folded),
      residentRegistry: { entries: { 'topic-1': residentEntry } }
    } as any
  })
}

const rect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top }) as DOMRect

const makeTurns = (turns: number, topicId = 'topic-1'): Message[] =>
  Array.from({ length: turns }, (_, index) => index).flatMap((index) => [
    {
      id: `u${index}`,
      topicId,
      role: 'user',
      assistantId: 'assistant-1',
      createdAt: `2026-01-01T00:0${index}:00.000Z`,
      status: UserMessageStatus.SUCCESS,
      blocks: []
    },
    {
      id: `a${index}`,
      topicId,
      askId: `u${index}`,
      role: 'assistant',
      assistantId: 'assistant-1',
      createdAt: `2026-01-01T00:0${index}:01.000Z`,
      status: AssistantMessageStatus.SUCCESS,
      blocks: []
    }
  ]) as unknown as Message[]

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

const cleanupRows = (): void => {
  for (const el of Array.from(document.querySelectorAll('[id^="message-"]'))) {
    try {
      el.remove()
    } catch {}
  }
  for (const el of Array.from(document.querySelectorAll('[data-testid="topic-segment-group"]'))) {
    try {
      el.remove()
    } catch {}
  }
  mocks.scrollContainerRef.current = null
}

const graftContainer = (): HTMLElement => {
  const host = document.getElementById('messages') as HTMLElement
  Object.defineProperty(host, 'scrollHeight', { value: 6000, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true })
  Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
  host.getBoundingClientRect = () => rect(0, 800)
  mocks.scrollContainerRef.current = host
  return host
}

/** Grafts a resident message row (gives the row container a real box). */
const graftRow = (host: HTMLElement, id: string, top: number, height = 100): HTMLElement => {
  const el = document.createElement('div')
  el.id = `message-${id}`
  el.getBoundingClientRect = () => rect(top, height)
  host.appendChild(el)
  return el
}
/**
 * Grafts the production collapsed-chrome DOM contract: the group's one in-flow
 * header row (`topic-segment-group`, 32px occupancy in both states) holding the
 * `topic-segment-label` pill that carries the real painted box. The label pill
 * is the geometry; the row only carries the stable `data-segment-id`.
 */
const graftSegmentChrome = (
  host: HTMLElement,
  options: { segmentId: string; folded: boolean; labelTop: number; labelHeight?: number }
): { chrome: HTMLElement; label: HTMLElement } => {
  const chrome = document.createElement('div')
  chrome.setAttribute('data-testid', 'topic-segment-group')
  chrome.setAttribute('data-segment-id', options.segmentId)
  chrome.setAttribute('data-segment-folded', options.folded ? 'true' : 'false')
  // The header row occupies its normal-flow 32px row in both states; the label
  // pill inside it is what navigation measures.
  chrome.getBoundingClientRect = () => rect(options.labelTop, 32)
  const label = document.createElement('div')
  label.setAttribute('data-testid', 'topic-segment-label')
  label.setAttribute('data-segment-folded', options.folded ? 'true' : 'false')
  label.getBoundingClientRect = () => rect(options.labelTop, options.labelHeight ?? 24)
  chrome.appendChild(label)
  host.appendChild(chrome)
  return { chrome, label }
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

describe('Folded-segment navigation (mounted Messages)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.topicMessages = [] as any
    mocks.scrollContainerRef.current = null
    mocks.ensureMock.mockReset()
    mocks.ensureMock.mockImplementation(async () => ({ status: 'resident' }) as any)
    ;(window as any).toast = { error: mocks.toastErrorMock, success: vi.fn(), warning: vi.fn(), loading: vi.fn() }
    installManualRaf()
    cleanupRows()
  })

  it('positions a resident folded member on its collapsed label without expanding or selecting', async () => {
    mocks.topicMessages = makeTurns(2)
    const store = makeStore(true)
    renderMessages(store)
    await act(async () => {})

    const host = graftContainer()
    const scrollTo = vi.fn()
    ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    // No body row for the folded members: only the collapsed label is painted.
    const { label } = graftSegmentChrome(host, {
      segmentId: FOLDED_SEGMENT_ID,
      folded: true,
      labelTop: -1200
    })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })

    await fireNavigation('a1')

    // The written geometry is the label's box (start alignment, clamped range).
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: -1200 })
    expect(label.isConnected).toBe(true)
    // Folding is presentation: no expand/select mutation is issued by a scroll.
    expect(mocks.selectAnswerStable).not.toHaveBeenCalled()
  })

  it('keeps the expanded row path unchanged', async () => {
    mocks.topicMessages = makeTurns(2)
    const store = makeStore(false)
    renderMessages(store)
    await act(async () => {})

    const host = graftContainer()
    const scrollTo = vi.fn()
    ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    graftRow(host, 'a1', -1000)
    // An expanded segment paints a label too: it must NOT be the target.
    graftSegmentChrome(host, { segmentId: 'seg-expanded', folded: false, labelTop: -1400 })

    await fireNavigation('a1')

    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: -1000 })
  })

  it('prefers the label while a folded body is still mounted by the closing animation', async () => {
    mocks.topicMessages = makeTurns(2)
    const store = makeStore(true)
    renderMessages(store)
    await act(async () => {})

    const host = graftContainer()
    const scrollTo = vi.fn()
    ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    // Closing animation: the body is still mounted (and still measurable) while
    // the collapsed label already paints at the seam. Presentation-only rows
    // must never own the navigation geometry.
    graftRow(host, 'a1', -1000)
    graftSegmentChrome(host, { segmentId: FOLDED_SEGMENT_ID, folded: true, labelTop: -1200 })

    await fireNavigation('a1')

    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: -1200 })
    expect(mocks.selectAnswerStable).not.toHaveBeenCalled()
  })

  it('locates the collapsed label after the around window load for a non-resident folded member', async () => {
    const tail = makeTurns(2)
    mocks.topicMessages = tail as any
    const loaded = [...tail, ...makeTurns(3).slice(4, 6)] as Message[]
    const target = loaded[loaded.length - 1]
    mocks.ensureMock.mockImplementation(async () => ({ status: 'loaded', messages: loaded, blocks: [] }) as any)
    const store = makeStore(true)
    const view = renderMessages(store)
    await act(async () => {})

    const host = graftContainer()
    const scrollTo = vi.fn()
    ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
    graftSegmentChrome(host, { segmentId: FOLDED_SEGMENT_ID, folded: true, labelTop: -1200 })

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    expect(typeof handler).toBe('function')
    await act(async () => {
      void handler(target.id)
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
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: -1200 })
    expect(mocks.selectAnswerStable).not.toHaveBeenCalled()
  })
})

describe('navigation presentation target resolution (pure)', () => {
  it('maps a folded member to its segment header and keeps the message identity', () => {
    const target = resolveNavigationPresentationTarget('a1', () => FOLDED_SEGMENT_ID)
    expect(target).toEqual({ kind: 'segment-header', messageId: 'a1', segmentId: FOLDED_SEGMENT_ID })
  })

  it('keeps an unfolded member on its own row', () => {
    expect(resolveNavigationPresentationTarget('a1', () => null)).toEqual({ kind: 'message-row', messageId: 'a1' })
    expect(resolveNavigationPresentationTarget('a1', () => undefined)).toEqual({ kind: 'message-row', messageId: 'a1' })
    expect(resolveNavigationPresentationTarget('a1', () => '')).toEqual({ kind: 'message-row', messageId: 'a1' })
  })

  it('fails open to the row when the catalog lookup throws', () => {
    const target = resolveNavigationPresentationTarget('a1', () => {
      throw new Error('catalog unavailable')
    })
    expect(target).toEqual({ kind: 'message-row', messageId: 'a1' })
  })
})
