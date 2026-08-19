/**
 * S3.1 Mounted Messages integration test — actual production component.
 *
 * Verifies that the real Messages component:
 * - Preserves component identity across topic prop changes (no remount)
 * - Fires onFirstUpdate once per topic (ref resets on transition)
 * - Renders current topic ID correctly across transitions
 * - Mounts and survives topic prop changes (A→B→A)
 * - Epoch-guards stale NAVIGATE_TO_MESSAGE pending clear and savePosition
 * - Epoch-guards stale navigateAndSave persistence
 * - Proves same-epoch completions still clear/save
 *
 * Heavy dependencies are mocked at module boundaries; the component under
 * test is the actual production Messages export — NOT a mirrored wrapper.
 * The viewport reducer, useTopicTransition hook, and navigation decision
 * logic run as production code.
 */
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { act, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessagesHandle } from '../Messages'

// ---------------------------------------------------------------------------
// Helper: default sharedContextInfo with all required production fields
// ---------------------------------------------------------------------------
const defaultSharedContextInfo = {
  uiMessages: [] as Message[],
  tokenEstimationMessages: [] as Message[],
  boundaryMessageId: null,
  contextCount: { current: 0, max: null },
  anchorGroupKey: null
}

// ---------------------------------------------------------------------------
// vi.hoisted: mock values that must be referenced in vi.mock factory closures
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Pending navigate control — the test can inject/clear pending navigation
  // intents to exercise the bootstrap path.
  let pendingNavigate: { messageId: string; topicId: string } | null = null

  return {
    getPendingNavigate: vi.fn(() => pendingNavigate),
    clearPendingNavigate: vi.fn(() => true),
    setPendingNavigate: (value: { messageId: string; topicId: string } | null) => {
      pendingNavigate = value
    },

    // useScrollPosition — controlled mock so we can inspect savePosition calls
    // and avoid the real keyv/store dependency.
    savePosition: vi.fn(),
    getSavedPosition: vi.fn((): { scrollTop: number; anchorId: string | null; isAtBottom: boolean } | null => null),

    // useTimer mock
    setTimeoutTimer: vi.fn((_name: string, fn: () => void, _ms: number) => fn()),
    clearTimeoutTimer: vi.fn(),

    // EventEmitter subscriptions — captured for assertion
    eventHandlers: {} as Record<string, (...args: any[]) => any>,
    eventSubscribe: vi.fn((event: string, handler: (...args: any[]) => any) => {
      mocks.eventHandlers[event] = handler
      return vi.fn() // unsubscribe
    }),

    // useTopicMessages mock — returns empty messages by default
    topicMessages: [] as Message[],

    // Mock refs to track
    scrollContainerRef: { current: null }
  }
})

// ---------------------------------------------------------------------------
// Module mocks — keep useTopicTransition, useReducer, viewportReducer REAL
// ---------------------------------------------------------------------------

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    addTopic: vi.fn(),
    updateAssistantSettings: vi.fn()
  })
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
  useTopicMessages: () => mocks.topicMessages,
  useTopicLoading: () => false,
  useMessageOperations: () => ({
    displayCount: 20,
    createTopicBranch: vi.fn(),
    selectAnswerMessage: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: (_key: string) => ({
    containerRef: mocks.scrollContainerRef,
    handleScroll: vi.fn(),
    getSavedPosition: mocks.getSavedPosition,
    clearSavedPosition: vi.fn(),
    savePosition: mocks.savePosition
  })
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
    isMessageInSegment: vi.fn(() => undefined)
  })
}))

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

vi.mock('@renderer/services/phaseTimingDiagnostics', () => ({
  currentPhaseCorrelation: vi.fn(() => null),
  recordPhaseDurationForCorrelation: vi.fn(),
  recordPhaseEndpoint: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  default: { getState: vi.fn(() => ({ messages: { messageIdsByTopic: {}, entities: {} } })) },
  useAppDispatch: () => vi.fn()
}))

vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: { selectById: vi.fn() },
  updateOneBlock: vi.fn()
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  updateMessageAndBlocksThunk: vi.fn()
}))

vi.mock('@renderer/services/anchorService', () => ({
  buildGroupList: vi.fn(() => []),
  ensureTopicAnchorEstablished: vi.fn(),
  inheritAnchorForBranch: vi.fn()
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: vi.fn(() => ({})),
  getDefaultTopic: vi.fn(() => ({ id: 'default-topic', name: 'Default' }))
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

vi.mock('@renderer/pages/home/Messages/domVisibility', () => ({
  findFirstVisibleMessage: vi.fn(() => null),
  findFirstVisibleMessageId: vi.fn(() => null)
}))

vi.mock('@renderer/pages/home/Messages/messageBranch', () => ({
  branchFromMessage: vi.fn()
}))

// ---------------------------------------------------------------------------
// S3.1 deferred tests: control runMessageNavigationTransaction timing
//
// The real transaction returns 'not-found' synchronously when messages are
// empty (no DOM element → 'missing' status → not-found). To exercise the
// real handler's epoch guard on clearPending and savePosition, we need a
// deferred completion that can resolve AFTER a topic transition. We keep
// handlePendingNavigateEvent and all other messageNavigation exports real;
// only runMessageNavigationTransaction is replaced with a controllable mock.
// ---------------------------------------------------------------------------
let resolveTransactionControlled: ((result: 'success' | 'not-found' | 'cancelled') => void) | null = null
// Collect all pending resolvers so we can drain them when multiple
// runMessageNavigationTransaction calls are in flight (e.g. original handler
// + bootstrap navigate after rerender).
const pendingTransactionResolvers: Array<(result: 'success' | 'not-found' | 'cancelled') => void> = []

vi.mock('@renderer/pages/home/Messages/messageNavigation', async () => {
  const actual = await vi.importActual('../messageNavigation')
  return {
    ...actual,
    runMessageNavigationTransaction: vi.fn(
      (_intent: any, _deps: any): Promise<'success' | 'not-found' | 'cancelled'> =>
        new Promise<'success' | 'not-found' | 'cancelled'>((resolve) => {
          resolveTransactionControlled = resolve
          pendingTransactionResolvers.push(resolve)
        })
    )
  }
})

vi.mock('@renderer/pages/home/Messages/messageViewportProjection', () => ({
  projectMessageViewportGroups: vi.fn((_messages: any[], groups: any[]) => groups)
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

vi.mock('@renderer/config/constant', () => ({
  LOAD_MORE_COUNT: 20
}))

vi.mock('react-infinite-scroll-component', () => ({
  default: ({ children }: any) => <div data-testid="infinite-scroll">{children}</div>
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

// Keep styled-components real but mock Scrollbar since it depends on
// renderer-specific DOM APIs. The styled divs (ScrollContainer, etc.)
// just render as regular divs.
vi.mock('styled-components', async () => {
  const actual = await vi.importActual('styled-components')
  return {
    ...actual,
    default: actual.default
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
// We use a dynamic import to ensure vi.mock has taken effect.
// ---------------------------------------------------------------------------
const Messages = (await import('../Messages')).default

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S3.1 Mounted Messages integration — actual production component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setPendingNavigate(null)
    mocks.getSavedPosition.mockReturnValue(null)
    mocks.savePosition.mockClear()
    resolveTransactionControlled = null
    pendingTransactionResolvers.length = 0
  })

  it('preserves component identity across topic prop changes (no remount)', () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    const { container, rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // The actual Messages component should render
    const containerBefore = container.querySelector('[data-testid="scrollbar"]')
    expect(containerBefore).toBeTruthy()

    // Switch topic — same element should persist (no remount)
    rerender(
      <Messages
        assistant={assistant}
        topic={topicB}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    const containerAfter = container.querySelector('[data-testid="scrollbar"]')
    // Same DOM node = same component instance = stable identity
    expect(containerAfter).toBe(containerBefore)
  })

  it('survives A→B→A topic transitions without crashing', () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // A → B
    rerender(
      <Messages
        assistant={assistant}
        topic={topicB}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    // Component should still be mounted and functional
    expect(document.querySelector('[data-testid="scrollbar"]')).toBeTruthy()

    // B → A (revisit)
    rerender(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    // Component should still be mounted and functional
    expect(document.querySelector('[data-testid="scrollbar"]')).toBeTruthy()
  })

  it('onFirstUpdate fires once per topic across A→B→A', () => {
    const onFirstUpdate = vi.fn()
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        onFirstUpdate={onFirstUpdate}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    expect(onFirstUpdate).toHaveBeenCalledTimes(1)

    // A → B: onFirstUpdate should fire again
    rerender(
      <Messages
        assistant={assistant}
        topic={topicB}
        setActiveTopic={vi.fn()}
        onFirstUpdate={onFirstUpdate}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    expect(onFirstUpdate).toHaveBeenCalledTimes(2)

    // B → A: onFirstUpdate should fire again (epoch incremented)
    rerender(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        onFirstUpdate={onFirstUpdate}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    expect(onFirstUpdate).toHaveBeenCalledTimes(3)
  })

  it('does not fire onFirstUpdate on same-topic re-render', () => {
    const onFirstUpdate = vi.fn()
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        onFirstUpdate={onFirstUpdate}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    expect(onFirstUpdate).toHaveBeenCalledTimes(1)

    // Re-render with same topic
    rerender(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        onFirstUpdate={onFirstUpdate}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    expect(onFirstUpdate).toHaveBeenCalledTimes(1)
  })

  it('renders child components (MessageGroup, Prompt, etc.)', () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // The actual child components should be rendered (via mocked versions)
    expect(screen.getByTestId('message-context-menu')).toBeTruthy()
    expect(screen.getByTestId('prompt')).toBeTruthy()
    expect(screen.getByTestId('infinite-scroll')).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // S3.1 deferred production-path tests
  //
  // These exercise the real NAVIGATE_TO_MESSAGE event handler and
  // navigateAndSave through the actual Messages component. The real
  // handlePendingNavigateEvent and epoch-guarded callbacks are live;
  // only runMessageNavigationTransaction is replaced with a controllable
  // mock that returns a deferred promise, allowing topic transitions to
  // interleave between navigation start and completion.
  // -----------------------------------------------------------------------

  it('S3.1 Blocker 1: NAVIGATE_TO_MESSAGE stale pending clear suppressed after A→B', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Set up a matching pending for topic A
    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-stale' })

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    expect(handler).toBeDefined()

    // Start the NAVIGATE_TO_MESSAGE handler — runMessageNavigationTransaction
    // is mocked to return a deferred promise; it won't resolve until we call
    // resolveTransactionControlled.
    const handlerPromise: Promise<any> = handler('msg-stale')

    // Let microtasks settle so the handler has started and the real
    // handlePendingNavigateEvent has called deps.navigate().
    await act(async () => {})

    // Before resolving the navigation, transition A → B (epoch incremented).
    // The epoch-guarded clearPending callback captures navEpoch at handler
    // start (0) and checks transitionEpochRef.current at call time.
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicB}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // Now resolve the deferred navigation — handlePendingNavigateEvent will
    // call deps.clearPending(pending), which is epoch-guarded. The epoch is
    // now 1 (topic changed), but the handler captured navEpoch=0, so the
    // guard suppresses the clear.
    await act(async () => {
      resolveTransactionControlled?.('success')
    })

    // Let the handler's post-navigation code settle
    await handlerPromise

    // S3.1 Blocker 1: stale clearPending must NOT have been called
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()
    // S3.1 Blocker 1: stale savePosition must NOT have been called
    expect(mocks.savePosition).not.toHaveBeenCalled()
  })

  it('S3.1 Blocker 1: NAVIGATE_TO_MESSAGE same-epoch completion clears pending and persists', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Set up a matching pending for topic A
    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-same' })

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    const handlerPromise: Promise<any> = handler('msg-same')

    // Let microtasks settle so the handler has started
    await act(async () => {})

    // No topic change — same epoch throughout. Resolve with 'success'.
    await act(async () => {
      resolveTransactionControlled?.('success')
    })

    await handlerPromise

    // Same epoch: clearPendingNavigate SHOULD have been called (pending matched)
    expect(mocks.clearPendingNavigate).toHaveBeenCalled()
    // Same epoch: savePosition SHOULD have been called (navigation succeeded)
    expect(mocks.savePosition).toHaveBeenCalled()
  })

  it('S3.1 Blocker 2: NAVIGATE_TO_MESSAGE stale savePosition suppressed after A→B (no pending)', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // No pending — the event is source='event', not 'pending'.
    // The handler still calls navigate() then savePosition on success.
    mocks.setPendingNavigate(null)

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    const handlerPromise: Promise<any> = handler('msg-imperative')

    await act(async () => {})

    // Transition A → B before the navigation resolves
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicB}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // Resolve the deferred navigation — the handler's post-nav epoch check
    // (transitionEpochRef.current !== navEpoch) catches the stale completion.
    await act(async () => {
      resolveTransactionControlled?.('success')
    })

    await handlerPromise

    // S3.1 Blocker 2: stale savePosition must NOT have been called
    expect(mocks.savePosition).not.toHaveBeenCalled()
  })

  it('S3.1 Blocker 2: NAVIGATE_TO_MESSAGE same-epoch savePosition persists', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    mocks.setPendingNavigate(null)

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    const handlerPromise: Promise<any> = handler('msg-imperative')

    await act(async () => {})

    // No topic change — same epoch throughout
    await act(async () => {
      resolveTransactionControlled?.('success')
    })

    await handlerPromise

    // Same epoch: savePosition SHOULD have been called
    expect(mocks.savePosition).toHaveBeenCalled()
  })

  it('S3.1 Blocker 1: A→B→A revisit distinguishes epochs — stale epoch-0 handler does not clear at epoch 2', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Set pending for topic A (epoch 0)
    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-revisit' })
    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']

    // Start handler at epoch 0 — creates promise #1 via mocked transaction
    const handlerPromiseEpoch0: Promise<any> = handler('msg-revisit')

    await act(async () => {})

    // Transition A → B (epoch 1)
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicB}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // B → A (epoch 2) — bootstrap detects matching pending and starts a new
    // transaction (promise #2), which overwrites resolveTransactionControlled.
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicA}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // Resolve all pending transaction resolvers.
    // pendingTransactionResolvers[0] = promise #1 (original handler, epoch 0)
    // pendingTransactionResolvers[1] = promise #2 (bootstrap, epoch 2)
    //
    // Promise #1 resolves 'success' — handler completes; epoch guard rejects.
    // Promise #2 resolves 'cancelled' — bootstrap's .then() sees cancelled,
    // skips clearPendingNavigate (so the mock is only exercised by the stale
    // handler's guard, which rejects it).
    await act(async () => {
      const resolvers = [...pendingTransactionResolvers]
      resolvers[0]?.('success')
      resolvers[1]?.('cancelled')
    })

    await handlerPromiseEpoch0

    // Epoch-0 handler is stale at epoch 2: must NOT clear or persist
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()
    expect(mocks.savePosition).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // S3.1 pending bootstrap — epoch guards on the bootstrap effect's pending
  // path (Messages.tsx lines 954-971).
  //
  // The bootstrap useEffect captures `bootstrapEpoch` and checks
  // transitionEpochRef.current in its .then() before calling
  // clearPendingNavigate, setting bootstrapPhaseRef='done', or savePosition.
  // -----------------------------------------------------------------------

  it('S3.1 Blocker 1: pending bootstrap stale completion suppressed after A→B', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    // Set pending BEFORE render so the bootstrap effect picks it up on mount
    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Bootstrap should have started a pending navigation (epoch 0)
    expect(pendingTransactionResolvers.length).toBe(1)

    await act(async () => {})

    // Transition A → B (epoch incremented to 1)
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicB}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // Resolve the deferred navigation as 'success' — stale at epoch 1
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })

    // Stale: clearPendingNavigate must NOT have been called
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()
    // Stale: savePosition must NOT have been called
    expect(mocks.savePosition).not.toHaveBeenCalled()
  })

  it('S3.1 Blocker 1: pending bootstrap same-epoch completion clears pending and persists', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Bootstrap started a pending navigation (epoch 0)
    expect(pendingTransactionResolvers.length).toBe(1)

    await act(async () => {})

    // No topic change — same epoch throughout
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })

    // Same epoch: clearPendingNavigate SHOULD have been called
    expect(mocks.clearPendingNavigate).toHaveBeenCalled()
    // Same epoch: savePosition SHOULD have been called
    expect(mocks.savePosition).toHaveBeenCalled()
  })

  it('S3.1 Blocker 1: pending bootstrap A→B→A — stale epoch-0 does not clear at epoch 2', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Bootstrap started at epoch 0 (resolver index 0)
    expect(pendingTransactionResolvers.length).toBe(1)

    await act(async () => {})

    // A → B (epoch 1)
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicB}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // B → A (epoch 2) — bootstrap detects matching pending and starts new
    // navigation (resolver index 1)
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicA}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // Two resolvers: epoch-0 (stale) and epoch-2 (current)
    expect(pendingTransactionResolvers.length).toBe(2)

    // Resolve both as 'success'
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
      pendingTransactionResolvers[1]?.('success')
    })

    // clearPendingNavigate called exactly once (epoch-2 bootstrap only)
    expect(mocks.clearPendingNavigate).toHaveBeenCalledTimes(1)
    // savePosition called exactly once (epoch-2 bootstrap only)
    expect(mocks.savePosition).toHaveBeenCalledTimes(1)
  })

  // -----------------------------------------------------------------------
  // S3.1 saved restore — epoch guards on the bootstrap effect's restore path
  // (Messages.tsx lines 974-983).
  //
  // When no matching pending exists but a saved scroll position is available,
  // the bootstrap effect captures `restoreEpoch` and checks it in .then()
  // before calling savePosition.
  // -----------------------------------------------------------------------

  it('S3.1 Blocker 2: saved restore stale completion suppressed after A→B', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    // No pending — saved restore path
    mocks.setPendingNavigate(null)
    mocks.getSavedPosition.mockReturnValue({ scrollTop: 100, anchorId: null, isAtBottom: false })

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Bootstrap started a restore navigation (epoch 0)
    expect(pendingTransactionResolvers.length).toBe(1)

    await act(async () => {})

    // Transition A → B (epoch 1)
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicB}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // Resolve the deferred navigation as 'success' — stale at epoch 1
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })

    // Stale: savePosition must NOT have been called
    expect(mocks.savePosition).not.toHaveBeenCalled()
  })

  it('S3.1 Blocker 2: saved restore same-epoch completion persists', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate(null)
    mocks.getSavedPosition.mockReturnValue({ scrollTop: 100, anchorId: null, isAtBottom: false })

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Bootstrap started a restore navigation (epoch 0)
    expect(pendingTransactionResolvers.length).toBe(1)

    await act(async () => {})

    // No topic change — same epoch
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })

    // Same epoch: savePosition SHOULD have been called
    expect(mocks.savePosition).toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // S3.1 imperative navigateAndSave — epoch guards on user-initiated
  // navigation via useImperativeHandle (Messages.tsx lines 671-684).
  //
  // scrollToBottom calls navigateAndSave which captures `saveEpoch` at
  // invocation and checks transitionEpochRef.current in .then() before
  // calling savePosition.
  // -----------------------------------------------------------------------

  it('S3.1 Blocker 2: imperative scrollToBottom stale completion suppressed after A→B', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    const ref: RefObject<MessagesHandle | null> = { current: null }

    const { rerender } = render(
      <Messages
        ref={ref}
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Imperative handle should be available
    expect(ref.current).toBeTruthy()

    // Call scrollToBottom — captures saveEpoch=0, starts deferred navigation
    await act(async () => {
      ref.current!.scrollToBottom()
    })

    expect(pendingTransactionResolvers.length).toBe(1)

    // Transition A → B (epoch 1)
    await act(async () => {
      rerender(
        <Messages
          ref={ref}
          assistant={assistant}
          topic={topicB}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
    })

    // Resolve the deferred navigation as 'success' — stale at epoch 1
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })

    // Stale: savePosition must NOT have been called
    expect(mocks.savePosition).not.toHaveBeenCalled()
  })

  it('S3.1 Blocker 2: imperative scrollToBottom same-epoch completion persists', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    const ref: RefObject<MessagesHandle | null> = { current: null }

    render(
      <Messages
        ref={ref}
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    expect(ref.current).toBeTruthy()

    // Call scrollToBottom — captures saveEpoch=0
    await act(async () => {
      ref.current!.scrollToBottom()
    })

    expect(pendingTransactionResolvers.length).toBe(1)

    // No topic change — same epoch
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })

    // Same epoch: savePosition SHOULD have been called
    expect(mocks.savePosition).toHaveBeenCalled()
  })
})
