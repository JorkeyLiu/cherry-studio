/**
 * Edit-selection follow — mounted Messages integration (production component,
 * real EditModeProvider, real `useClipboardKeyboard`, real navigation
 * transaction).
 *
 * Claim under test: a Shift+Arrow selection step whose new endpoint row is
 * already resident AND visible writes the viewport geometry in the same input
 * turn — without the transaction's begin-commit / double-frame / scroll-commit
 * barrier that a repeat key can outrun (which left the selection advanced but
 * the viewport behind). Non-resident endpoints keep the unchanged asynchronous
 * navigation (load + fold reveal + settle).
 *
 * The mocked `MessageGroup` renders no rows, so resident rows are grafted into
 * the live `#messages` host with real rects (the same technique the
 * reading-anchor suite uses for measurement fixtures).
 */
import { configureStore } from '@reduxjs/toolkit'
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
  // Stable action-controller identities (production callbacks are stable;
  // fresh closures per render would recreate selectMessageForFold and re-run
  // `t`-dependent route effects every render).
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
// The real hook is used: the selection path starts from a trusted keydown.
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
  // Named exports used by the displayed-route coordinator. The single
  // controller owns transition truth; the mock keeps anchoring tests
  // isolated from hook depth. Scroll-hook identities are stable (mirroring
  // production memoization) so route effects run only on genuine triggers.
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
    // Group derivation for the real edit-mode hook reads the same fixture
    // messages the viewport window is built from (the store slice is a stub).
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
// The navigation transaction stays REAL: the resident-follow claim is about the
// production runner reaching the geometry write without its barrier.
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
  default: vi.fn(() => (
    <div
      data-testid="edit-mode-action-bar"
      style={{ position: 'absolute', top: '0px', left: '0px', right: '0px', zIndex: 10, pointerEvents: 'none' }}>
      <div data-testid="edit-bar-pill" style={{ pointerEvents: 'auto' }}>
        selected
      </div>
    </div>
  ))
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
  // Stable `t` identity (production `t` is stable; a fresh closure per render
  // would re-run `t`-dependent route effects every render).
  return { ...actual, useTranslation: () => ({ t: mocks.tStable }) }
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

// Manual rAF queue: NEVER flushed by these tests. A geometry write that still
// waits for the navigation transaction's double-frame settle can therefore never
// appear here — the assertion itself proves the frame barrier is gone.
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

const cleanupRows = (): void => {
  for (const el of Array.from(document.querySelectorAll('[id^="message-"]'))) {
    try {
      el.remove()
    } catch {}
  }
  mocks.scrollContainerRef.current = null
}

// Container + resident rows with real geometry inside the LIVE `#messages` host
// (the mocked MessageGroup renders no rows).
const graftSelectionRows = (rows: Array<{ id: string; top: number; height?: number }>) => {
  const host = document.getElementById('messages') as HTMLElement
  Object.defineProperty(host, 'scrollHeight', { value: 6000, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true })
  host.getBoundingClientRect = () => rect(0, 800)
  const scrollTo = vi.fn()
  ;(host as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo
  for (const row of rows) {
    const el = document.createElement('div')
    el.id = `message-${row.id}`
    const height = row.height ?? 100
    el.getBoundingClientRect = () => rect(row.top, height)
    host.appendChild(el)
  }
  mocks.scrollContainerRef.current = host
  return { host, scrollTo }
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

const pressSelectionKey = async (key: 'ArrowUp' | 'ArrowDown'): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }))
  })
}

describe('Edit-selection follow (mounted Messages)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.topicMessages = [] as any
    ;(window as any).toast = { error: mocks.toastErrorMock, success: vi.fn(), warning: vi.fn(), loading: vi.fn() }
    installManualRaf()
    cleanupRows()
  })

  it('writes the resident visible endpoint geometry in the input turn (no frame/commit barrier)', async () => {
    mocks.topicMessages = makeTurns(3)
    const store = makeStore(true)
    renderMessages(store)
    // Let the projection window land and the edit-mode heavy bridge publish the
    // real selection handlers.
    await act(async () => {})
    await act(async () => {})

    const { scrollTo } = graftSelectionRows([
      { id: 'u0', top: -300 },
      { id: 'a0', top: -200 },
      { id: 'u1', top: -1200 },
      { id: 'a1', top: -1100 },
      { id: 'u2', top: -2500 }
    ])

    await pressSelectionKey('ArrowDown')

    // The endpoint advanced to the second turn's row and the viewport followed
    // it: one write, exact row geometry. The manual rAF queue is never drained
    // in this file, so a write that still waited on the navigation transaction's
    // double-frame settle could not exist here at all.
    expect(store.getState().editMode.selectedGroupIds).toEqual(['u0', 'u1'])
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: -1200 })
    // Nothing on this path may need a window read: the row is resident.
    expect(mocks.ensureMock).not.toHaveBeenCalled()
  })

  it('leaves a non-resident endpoint to the asynchronous navigation (no same-turn write)', async () => {
    mocks.topicMessages = makeTurns(3)
    const store = makeStore(true)
    renderMessages(store)
    await act(async () => {})
    await act(async () => {})

    // The second turn's row is NOT in the DOM: window load / reveal / settle
    // still own this step, so the synchronous path must not write.
    const { scrollTo } = graftSelectionRows([
      { id: 'u0', top: -300 },
      { id: 'a0', top: -200 }
    ])

    await pressSelectionKey('ArrowDown')

    expect(store.getState().editMode.selectedGroupIds).toEqual(['u0', 'u1'])
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('follows every repeat key: the newest endpoint owns the last write', async () => {
    mocks.topicMessages = makeTurns(3)
    const store = makeStore(true)
    renderMessages(store)
    await act(async () => {})
    await act(async () => {})

    const { scrollTo } = graftSelectionRows([
      { id: 'u0', top: -300 },
      { id: 'a0', top: -200 },
      { id: 'u1', top: -1200 },
      { id: 'a1', top: -1100 },
      { id: 'u2', top: -2500 }
    ])

    await pressSelectionKey('ArrowDown')
    await pressSelectionKey('ArrowDown')

    expect(store.getState().editMode.selectedGroupIds).toEqual(['u0', 'u1', 'u2'])
    expect(scrollTo).toHaveBeenNthCalledWith(1, { top: -1200 })
    expect(scrollTo).toHaveBeenNthCalledWith(2, { top: -2500 })
  })

  it('keeps the last followed endpoint on a clamped key (no viewport write, selection intact)', async () => {
    mocks.topicMessages = makeTurns(2)
    const store = makeStore(true)
    renderMessages(store)
    await act(async () => {})
    await act(async () => {})

    const { scrollTo } = graftSelectionRows([
      { id: 'u0', top: -300 },
      { id: 'a0', top: -200 },
      { id: 'u1', top: -1200 }
    ])

    await pressSelectionKey('ArrowDown')
    await pressSelectionKey('ArrowDown')

    // The endpoint cannot advance past the displayed edge: the key names one
    // bounded page and never rewrites the viewport off the endpoint it followed.
    expect(store.getState().editMode).toMatchObject({
      selectedGroupIds: ['u0', 'u1'],
      anchorGroupId: 'u0',
      focusedGroupId: 'u1'
    })
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: -1200 })
  })

  it('keeps ordinary message navigation on the full asynchronous transaction', async () => {
    mocks.topicMessages = makeTurns(2)
    const store = makeStore(true)
    renderMessages(store)
    await act(async () => {})
    await act(async () => {})

    const { scrollTo } = graftSelectionRows([
      { id: 'u0', top: -300 },
      { id: 'a0', top: -200 },
      { id: 'u1', top: -1200 }
    ])

    const handler = mocks.eventHandlers.NAVIGATE_TO_MESSAGE
    expect(typeof handler).toBe('function')
    // Fire-and-observe: the generic transaction settles through frames this
    // fixture never grants, so the handler stays pending by design.
    await act(async () => {
      void handler('u0')
    })

    // A message-ID navigation keeps its existing transaction shape (the write
    // stays behind the settle barrier, which this fixture never grants).
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
