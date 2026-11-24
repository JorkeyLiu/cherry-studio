/**
 * Messages flow-nodes memo — mounted redundant-build proof + staleness guard.
 *
 * Proves on the real production `Messages` component (same mounted-transition
 * mock pattern as `Messages.mountedTransition.test.tsx` — heavy UI mocked at
 * module boundaries, viewport/navigation/plan/flow builders REAL) that:
 * - a parent `sharedContextInfo` identity churn with unchanged
 *   structure/callback/scalar semantics does NOT rebuild the message flow
 *   (`buildMessageRenderPlan` / `buildMessageFlowNodesFromPlan` call counts
 *   unchanged, DOM unchanged);
 * - positive controls that really affect the flow DO rebuild: a structure
 *   change (topic/route switch) and a flow scalar change
 *   (`contextBoundaryMessageId`), with DOM assertions proving the memo is not
 *   stale (menu follows the topic, no fabricated divider for a non-resident
 *   boundary).
 *
 * The spies delegate to the REAL builders, so counts measure production work.
 */
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Helper: default sharedContextInfo with all required production fields
// ---------------------------------------------------------------------------
const defaultSharedContextInfo = {
  uiMessages: [] as Message[],
  tokenEstimationMessages: [] as Message[],
  boundaryMessageId: null,
  contextCount: { current: 0, max: null },
  anchorGroupKey: null,
  blockSnapshot: new Map()
}

// ---------------------------------------------------------------------------
// vi.hoisted: mock values that must be referenced in vi.mock factory closures
// ---------------------------------------------------------------------------

const flowCounts = vi.hoisted(() => ({ renderPlan: 0, flowNodes: 0 }))

const mocks = vi.hoisted(() => {
  // Pending navigate control — the test can inject/clear pending navigation
  // intents to exercise the bootstrap path.
  let pendingNavigate: { messageId: string; topicId: string } | null = null

  // S3.2: key-aware scroll position store. Mirrors production keyv:
  // keys are `scroll:<scrollKey>`, values are { scrollTop, anchorId, isAtBottom }.
  const scrollKeyStore = new Map<string, unknown>()

  // S3.2: Modeled scrollKeyRef — models the production useScrollPosition hook's
  // scrollKeyRef. The production hook updates scrollKeyRef.current inside
  // useEffect (passive), NOT during render.
  const scrollKeyRef = { current: '' }

  // S3.2: Stable function references. Messages.tsx has savePosition and
  // getSavedPosition in useEffect dependency arrays.
  const savePositionSpy = vi.fn(() => {
    const storeKey = `scroll:${scrollKeyRef.current}`
    const container = scrollContainerRef.current
    if (!container) return
    const scrollTop = container.scrollTop
    scrollKeyStore.set(storeKey, {
      scrollTop,
      anchorId: null,
      isAtBottom: Math.abs(scrollTop) <= 50
    })
  })

  const getSavedPositionSpy = vi.fn((): { scrollTop: number; anchorId: string | null; isAtBottom: boolean } | null => {
    const val = scrollKeyStore.get(`scroll:${scrollKeyRef.current}`)
    if (val && typeof val === 'object' && 'scrollTop' in val) {
      return val as { scrollTop: number; anchorId: string | null; isAtBottom: boolean }
    }
    return null
  })

  // Mock refs to track (used by the mock factory and tests)
  const scrollContainerRef: { current: HTMLElement | null } = { current: null }

  // Deferred-read seam: per-test impl, default void.
  const deferredReadImpl = vi.fn(async (..._args: any[]) => undefined)

  return {
    getPendingNavigate: vi.fn(() => pendingNavigate),
    deferredReadImpl,
    clearPendingNavigate: vi.fn(() => true),
    setPendingNavigate: (value: { messageId: string; topicId: string } | null) => {
      pendingNavigate = value
    },

    savePosition: savePositionSpy,
    getSavedPosition: getSavedPositionSpy,
    commitStableViewport: vi.fn(() => true),
    captureSnapshot: vi.fn(() => ({
      scrollTop: -100,
      anchorId: 'm1',
      messageId: 'm1',
      intraRowOffset: -10,
      rawScrollTop: -100,
      isAtBottom: false
    })),
    getSnapshotForRoute: vi.fn(() => null),

    scrollKeyStore,
    scrollKeyRef,

    setTimeoutTimer: vi.fn((_name: string, fn: () => void, _ms: number) => fn()),
    clearTimeoutTimer: vi.fn(),

    eventHandlers: {} as Record<string, (...args: any[]) => any>,
    eventSubscribe: vi.fn((event: string, handler: (...args: any[]) => any) => {
      mocks.eventHandlers[event] = handler
      return vi.fn() // unsubscribe
    }),

    topicMessages: [] as Message[],
    loadedResident: true,
    pendingWindowReads: {} as Record<string, unknown[]>,

    ensureMock: vi.fn(async () => ({ status: 'resident' }) as any),
    dispatchMock: vi.fn(),
    upsertManyBlocksMock: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertMany', payload: blocks })),
    messagesReceivedMock: vi.fn((payload: unknown) => ({ type: 'newMessages/messagesReceived', payload })),
    toastErrorMock: vi.fn(),

    scrollContainerRef,

    simulatePassiveKeyUpdate: (key: string) => {
      scrollKeyRef.current = key
    },

    selectAnswer: vi.fn().mockResolvedValue(undefined),
    regenerateAssistant: vi.fn().mockResolvedValue(undefined),
    resendUser: vi.fn().mockResolvedValue(undefined),
    editSave: vi.fn().mockResolvedValue(true),
    resendWithEdit: vi.fn().mockResolvedValue(true),

    resolveContextClosure: vi.fn(async () => ({ resolvedAnchorGroupKey: null }) as any),
    fetchMessagesWindow: vi.fn(async (..._args: unknown[]) => ({ messages: [], blocks: [] }) as any),
    t: (key: string): string => key
  }
})

// ---------------------------------------------------------------------------
// Module mocks — keep useTopicTransition, useReducer, viewportReducer REAL
// ---------------------------------------------------------------------------

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    addTopic: vi.fn(),
    updateAssistantSettings: vi.fn()
  }),
  useMessageAssistant: () => ({
    assistant: null,
    model: null,
    setModel: vi.fn(),
    updateAssistantSettings: vi.fn()
  }),
  useAssistantSettingsUpdater: () => vi.fn()
}))

vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => ({
    isMultiSelectMode: false,
    handleSelectMessage: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useClipboardKeyboard', () => ({
  useClipboardKeyboard: vi.fn()
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: () => (mocks.loadedResident ? mocks.topicMessages : undefined),
  useTopicLoading: () => false,
  useMessageOperations: () => ({
    displayCount: 20,
    createTopicBranch: vi.fn(),
    selectAnswerMessage: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    selectAnswer: mocks.selectAnswer,
    regenerateAssistant: mocks.regenerateAssistant,
    resendUser: mocks.resendUser,
    editSave: mocks.editSave,
    resendWithEdit: mocks.resendWithEdit
  })
}))

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  commitSnapshotForRoute: mocks.commitStableViewport,
  routeScrollKey: (topicId: string, branchId: string | null) => `topic-${topicId}::${branchId ?? 'main'}`,
  default: (_key: string) => {
    return {
      containerRef: mocks.scrollContainerRef,
      handleScroll: vi.fn(),
      getSavedPosition: mocks.getSavedPosition,
      getSnapshotForRoute: mocks.getSnapshotForRoute,
      clearSavedPosition: vi.fn(),
      savePosition: mocks.savePosition,
      captureSnapshot: mocks.captureSnapshot
    }
  }
}))

vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcut: vi.fn()
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({
    setTimeoutTimer: mocks.setTimeoutTimer,
    clearTimeoutTimer: mocks.clearTimeoutTimer
  })
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  autoRenameTopic: vi.fn()
}))

vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({
    isMessageFirstInSegment: vi.fn(() => false),
    isMessageLastInSegment: vi.fn(() => false),
    isMessageInSegment: vi.fn(() => undefined),
    segmentsForTopic: [],
    orderedSegmentsForTopic: []
  })
}))

vi.mock('../../ChatRouteStructure', () => {
  const routeStructure = { segments: [], routeKey: '', isCurrent: false }
  return { useChatRouteStructure: () => routeStructure }
})

vi.mock('@renderer/context/EditModeContext', () => ({
  EditModeProvider: ({ children }: { children: React.ReactNode }) => children,
  useEditMode: () => ({
    isEnabled: false,
    selectedGroupIds: [],
    handleGroupClick: vi.fn()
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
  EventEmitter: {
    on: mocks.eventSubscribe,
    emit: vi.fn()
  }
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getPendingNavigate: mocks.getPendingNavigate,
  clearPendingNavigate: mocks.clearPendingNavigate
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: vi.fn(() => ({
      messages: { messageIdsByTopic: {}, entities: {}, pendingWindowReadsByTopic: mocks.pendingWindowReads },
      editMode: { enabled: false },
      residentRegistry: { entries: {} }
    })),
    subscribe: vi.fn(() => vi.fn())
  },
  useAppDispatch: () => (mocks as any).dispatchMock,
  useAppSelector: (selector: any) =>
    selector({
      messages: { messageIdsByTopic: {}, entities: {}, pendingWindowReadsByTopic: mocks.pendingWindowReads },
      editMode: { enabled: false },
      residentRegistry: { entries: {} }
    } as any),
  useAppStore: () => ({
    getState: vi.fn(() => ({
      messages: { messageIdsByTopic: {}, entities: {}, pendingWindowReadsByTopic: mocks.pendingWindowReads },
      editMode: { enabled: false },
      residentRegistry: { entries: {} }
    })),
    subscribe: vi.fn(() => vi.fn())
  })
}))

vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: { selectById: vi.fn() },
  updateOneBlock: vi.fn(),
  upsertManyBlocks: (...args: any[]) => (mocks as any).upsertManyBlocksMock(...args)
}))

vi.mock('@renderer/store/newMessage', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      messagesReceived: (...args: any[]) => (mocks as any).messagesReceivedMock(...args)
    }
  }
})

vi.mock('@renderer/store/thunk/messageThunk', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    updateMessageAndBlocksThunk: vi.fn(),
    loadRouteMessagesThunk: vi.fn(() => ({ type: 'test/loadRouteMessages' })),
    dispatchDeferredRouteWindowRead: (...args: any[]) => (mocks as any).deferredReadImpl(...args),
    isDeferredRouteWindowReceiptCurrent: actual.isDeferredRouteWindowReceiptCurrent,
    toDeferredJointPayload: actual.toDeferredJointPayload
  }
})

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
    resolveContextClosure: (...args: unknown[]) => (mocks as any).resolveContextClosure(...args),
    fetchMessagesWindow: (...args: unknown[]) => (mocks as any).fetchMessagesWindow(...args),
    listSegments: vi.fn(async () => [])
  },
  DbService: vi.fn()
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

vi.mock('@renderer/utils/dom', () => ({
  scrollIntoView: vi.fn()
}))

vi.mock('@renderer/utils/markdown', () => ({
  updateCodeBlock: vi.fn()
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: vi.fn(() => '')
}))

vi.mock('@renderer/utils/messageUtils/is', () => ({
  isTextLikeBlock: vi.fn(() => false)
}))

vi.mock('@renderer/pages/home/Messages/domVisibility', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    findFirstVisibleMessage: vi.fn(() => null),
    findFirstVisibleMessageId: vi.fn(() => null)
  }
})

vi.mock('@renderer/pages/home/Messages/messageBranch', () => ({
  branchFromMessage: vi.fn()
}))

const pendingTransactionResolvers: Array<(result: 'success' | 'not-found' | 'cancelled') => void> = []

vi.mock('@renderer/pages/home/Messages/messageNavigation', async () => {
  const actual = await vi.importActual('../messageNavigation')
  return {
    ...actual,
    runMessageNavigationTransaction: vi.fn(
      (_intent: any, _deps: any): Promise<'success' | 'not-found' | 'cancelled'> =>
        new Promise<'success' | 'not-found' | 'cancelled'>((resolve) => {
          pendingTransactionResolvers.push(resolve)
        })
    ),
    prepareMessageNavigationTarget: vi.fn(
      (_intent: any, _deps: any): Promise<{ status: 'prepared' | 'not-found' | 'cancelled' }> =>
        new Promise<{ status: 'prepared' | 'not-found' | 'cancelled' }>((resolve) => {
          pendingTransactionResolvers.push((result) => {
            if (result !== 'success') {
              resolve({ status: result })
              return
            }
            resolve({ status: 'prepared', token: {}, resolved: { kind: 'bottom' } } as any)
          })
        })
    )
  }
})

vi.mock('@renderer/pages/home/Messages/messageNavigationLoader', () => ({
  ensureMessageLoaded: (...args: any[]) => (mocks as any).ensureMock(...args),
  buildNavigationAroundRequest: vi.fn(),
  NAVIGATION_LOADER_BEFORE: 10,
  NAVIGATION_LOADER_AFTER: 19
}))

vi.mock('@renderer/pages/home/Messages/messageViewportProjection', () => ({
  projectMessageViewportGroups: vi.fn(() => []),
  createViewportProjectionCache: () => ({ project: () => [], clear: () => {}, size: () => 0 })
}))

// Child component mocks — render with data-testid for identity/structure assertions
vi.mock('@renderer/pages/home/Messages/MessageGroup', () => ({
  default: vi.fn(() => <div data-testid="message-group" />)
}))

vi.mock('@renderer/pages/home/Messages/Prompt', () => ({
  default: vi.fn(() => <div data-testid="prompt" />)
}))

vi.mock('@renderer/pages/home/Messages/SelectionBox', () => ({
  default: vi.fn(() => null)
}))

vi.mock('@renderer/pages/home/Messages/MessageContextMenu', () => ({
  default: ({ children, topicId }: any) => (
    <div data-testid="message-context-menu" data-topic-id={topicId}>
      {children}
    </div>
  )
}))

vi.mock('@renderer/pages/home/Messages/TopicSegmentLine', () => ({
  default: vi.fn(() => null)
}))

vi.mock('@renderer/pages/home/Messages/anchorGroupContext', () => ({
  AnchorGroupProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="anchor-group-provider">{children}</div>
  )
}))

vi.mock('@renderer/components/EditModeActionBar', () => ({
  default: vi.fn(() => <div data-testid="edit-mode-action-bar" />)
}))

vi.mock('@renderer/components/Icons', () => ({
  LoadingIcon: vi.fn(() => <div data-testid="loading-icon" />)
}))

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children, ...props }: any) => (
    <div data-testid="scrollbar" {...props}>
      {children}
    </div>
  )
}))

vi.mock('@renderer/config/constant', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    LOAD_MORE_COUNT: 20,
    isDev: false
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mocks.t
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined }
}))

vi.mock('styled-components', async () => {
  const actual = await vi.importActual('styled-components')
  return {
    ...actual,
    default: actual.default
  }
})

// ---------------------------------------------------------------------------
// Builder call-count spies — delegate to the REAL builders (production work).
// ---------------------------------------------------------------------------
vi.mock('../messageRenderPlan', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>
  return {
    ...actual,
    buildMessageRenderPlan: (...args: any[]) => {
      flowCounts.renderPlan += 1
      return actual.buildMessageRenderPlan(...args)
    }
  }
})

vi.mock('../messageFlowNodes', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>
  return {
    ...actual,
    buildMessageFlowNodesFromPlan: (...args: any[]) => {
      flowCounts.flowNodes += 1
      return actual.buildMessageFlowNodesFromPlan(...args)
    }
  }
})

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const makeTopic = (id: string): Topic => ({ id, name: `Topic ${id}`, assistantId: 'assistant-1' }) as unknown as Topic

const makeAssistant = (): Assistant =>
  ({ id: 'assistant-1', name: 'Test Assistant', prompt: '' }) as unknown as Assistant

// ---------------------------------------------------------------------------
// Import the actual Messages component AFTER mocks are set up.
// ---------------------------------------------------------------------------
const Messages = (await import('../Messages')).default

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Messages flow-nodes memo — pure context identity vs real flow changes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setPendingNavigate(null)
    mocks.getSavedPosition.mockReturnValue(null)
    mocks.savePosition.mockClear()
    pendingTransactionResolvers.length = 0
    mocks.scrollKeyStore.clear()
    mocks.scrollKeyRef.current = ''
    mocks.ensureMock.mockReset()
    mocks.ensureMock.mockImplementation(async () => ({ status: 'resident' }) as any)
    mocks.loadedResident = true
    mocks.pendingWindowReads = {}
    mocks.topicMessages = [] as any
    flowCounts.renderPlan = 0
    flowCounts.flowNodes = 0
    ;(window as any).toast = { error: mocks.toastErrorMock, success: vi.fn(), warning: vi.fn(), loading: vi.fn() }
  })

  it('pure sharedContextInfo identity churn does not rebuild the flow; structure and boundary scalar do', () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()
    const setActiveTopic = vi.fn()

    // Mount with a first sharedContextInfo object.
    const infoA = { ...defaultSharedContextInfo }
    const { rerender } = render(
      <Messages assistant={assistant} topic={topicA} setActiveTopic={setActiveTopic} sharedContextInfo={infoA} />
    )
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)

    // Sanity: the real builders really ran on mount, and the DOM is mounted.
    expect(flowCounts.flowNodes).toBeGreaterThan(0)
    expect(flowCounts.renderPlan).toBeGreaterThan(0)
    expect(screen.getByTestId('prompt')).toBeInTheDocument()
    expect(screen.getByTestId('message-context-menu')).toHaveAttribute('data-topic-id', topicA.id)
    expect(screen.queryByTestId('message-group')).not.toBeInTheDocument()
    expect(screen.queryByTestId('context-boundary')).not.toBeInTheDocument()
    const planAfterMount = flowCounts.renderPlan
    const flowAfterMount = flowCounts.flowNodes

    // Pure identity churn: new object, identical structure/callback/scalar
    // semantics (same null boundary, same null anchor, new block snapshot map).
    // This mirrors the Chat-level projection allocating a new result per
    // content patch without changing what the flow renders.
    const infoB = { ...infoA, blockSnapshot: new Map() }
    rerender(
      <Messages assistant={assistant} topic={topicA} setActiveTopic={setActiveTopic} sharedContextInfo={infoB} />
    )

    // No redundant rebuild, DOM byte-identical in the asserted structure.
    expect(flowCounts.flowNodes).toBe(flowAfterMount)
    expect(flowCounts.renderPlan).toBe(planAfterMount)
    expect(screen.getByTestId('prompt')).toBeInTheDocument()
    expect(screen.getByTestId('message-context-menu')).toHaveAttribute('data-topic-id', topicA.id)
    expect(screen.queryByTestId('message-group')).not.toBeInTheDocument()
    expect(screen.queryByTestId('context-boundary')).not.toBeInTheDocument()

    // Positive control B (flow scalar, while the route is settled): a boundary
    // change MUST rebuild the plan and the flow — the memo must not go stale.
    // The boundary message is not resident in this empty window, so no divider
    // may be fabricated.
    const planBeforeScalar = flowCounts.renderPlan
    const flowBeforeScalar = flowCounts.flowNodes
    const infoC = { ...infoB, boundaryMessageId: 'm-x' }
    rerender(
      <Messages assistant={assistant} topic={topicA} setActiveTopic={setActiveTopic} sharedContextInfo={infoC} />
    )
    expect(flowCounts.renderPlan).toBeGreaterThan(planBeforeScalar)
    expect(flowCounts.flowNodes).toBeGreaterThan(flowBeforeScalar)
    expect(screen.getByTestId('prompt')).toBeInTheDocument()
    expect(screen.queryByTestId('context-boundary')).not.toBeInTheDocument()

    // Positive control A (structure): a topic/route switch MUST rebuild and
    // the DOM MUST follow (menu tracks the new topic).
    rerender(
      <Messages assistant={assistant} topic={topicB} setActiveTopic={setActiveTopic} sharedContextInfo={infoB} />
    )
    expect(flowCounts.flowNodes).toBeGreaterThan(flowBeforeScalar)
    expect(screen.getByTestId('prompt')).toBeInTheDocument()
    expect(screen.getByTestId('message-context-menu')).toHaveAttribute('data-topic-id', topicB.id)

    // Return to A: the frame follows the committed route back.
    rerender(
      <Messages assistant={assistant} topic={topicA} setActiveTopic={setActiveTopic} sharedContextInfo={infoB} />
    )
    expect(screen.getByTestId('message-context-menu')).toHaveAttribute('data-topic-id', topicA.id)
  })
})
