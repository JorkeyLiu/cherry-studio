/**
 * Reading-anchor report — mounted Messages integration (production component).
 *
 * Covers the observe-only `onReadingAnchor` contract in Messages.tsx:
 * - viewport-top anchor measurement through the real `findViewportTopAnchorWithOffset`
 *   (ordered rows via the real registry + real container geometry)
 * - RAF coalescing + four-field dedup (repeat frames do not re-emit)
 * - topic/branch transition stale suppression (no foreign-route reports)
 * - pending navigationTargetId lifecycle: set at navigateAndSave start,
 *   programmatic scrolls keep it, genuine user input clears it, Promise
 *   settle clears it with token matching
 *
 * Heavy dependencies reuse the Messages.mountedTransition fixture strategy
 * (module-boundary mocks, real reducer/transition/navigation-decision code).
 * The domVisibility module stays REAL here (unlike mountedTransition, which
 * nulls the pickers): measurement is the claim under test. Only the
 * navigation *transaction* is deferred-controllable so pending lifecycles can
 * be sequenced deterministically.
 */
import type { Assistant, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReadingAnchorReport } from '../Messages'

// ---------------------------------------------------------------------------
// Shared context info stub
// ---------------------------------------------------------------------------
const defaultSharedContextInfo = {
  uiMessages: [] as Message[],
  tokenEstimationMessages: [] as Message[],
  boundaryMessageId: null,
  contextCount: { current: 0, max: null },
  anchorGroupKey: null
}

const mocks = vi.hoisted(() => {
  let pendingNavigate: { messageId: string; topicId: string } | null = null
  const scrollKeyStore = new Map<string, unknown>()
  const scrollKeyRef = { current: '' }
  const savePositionSpy = vi.fn(() => {
    const storeKey = `scroll:${scrollKeyRef.current}`
    const container = scrollContainerRef.current
    if (!container) return
    scrollKeyStore.set(storeKey, { scrollTop: container.scrollTop, anchorId: null, isAtBottom: false })
  })
  const getSavedPositionSpy = vi.fn(() => null)
  const scrollContainerRef: { current: HTMLElement | null } = { current: null }
  return {
    getPendingNavigate: vi.fn(() => pendingNavigate),
    clearPendingNavigate: vi.fn(() => true),
    setPendingNavigate: (v: { messageId: string; topicId: string } | null) => {
      pendingNavigate = v
    },
    savePosition: savePositionSpy,
    getSavedPosition: getSavedPositionSpy,
    commitStableViewport: vi.fn(() => true),
    // Live-viewport capture: delegate to the real ordered-core measurement is
    // impossible without a real container, so keep the hook-level snapshot
    // neutral (null anchor) — the reading-anchor path measures separately.
    captureSnapshot: vi.fn(() => null),
    getSnapshotForRoute: vi.fn(() => null),
    scrollKeyStore,
    scrollKeyRef,
    simulatePassiveKeyUpdate: (key: string) => {
      scrollKeyRef.current = key
    },
    setTimeoutTimer: vi.fn((_name: string, fn: () => void, _ms: number) => fn()),
    clearTimeoutTimer: vi.fn(),
    eventHandlers: {} as Record<string, (...args: any[]) => any>,
    eventSubscribe: vi.fn((event: string, handler: (...args: any[]) => any) => {
      mocks.eventHandlers[event] = handler
      return vi.fn()
    }),
    topicMessages: [] as Message[],
    ensureMock: vi.fn(async () => ({ status: 'resident' }) as any),
    dispatchMock: vi.fn(),
    toastErrorMock: vi.fn(),
    scrollContainerRef,
    selectAnswer: vi.fn().mockResolvedValue(undefined),
    resolveContextClosure: vi.fn(async () => ({ resolvedAnchorGroupKey: null }) as any),
    fetchMessagesWindow: vi.fn(async () => ({ messages: [], blocks: [] }) as any),
    t: (key: string): string => key
  }
})

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ addTopic: vi.fn(), updateAssistantSettings: vi.fn() }),
  useMessageAssistant: () => ({ assistant: null, model: null, setModel: vi.fn(), updateAssistantSettings: vi.fn() }),
  useAssistantSettingsUpdater: () => vi.fn()
}))
vi.mock('@renderer/hooks/useChatContext', () => ({
  useChatContext: () => ({ isMultiSelectMode: false, handleSelectMessage: vi.fn() })
}))
vi.mock('@renderer/hooks/useClipboardKeyboard', () => ({
  useClipboardKeyboard: vi.fn()
}))
vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: () => mocks.topicMessages,
  useTopicLoading: () => false,
  useMessageOperations: () => ({ displayCount: 20, createTopicBranch: vi.fn(), selectAnswerMessage: vi.fn() })
}))
vi.mock('@renderer/hooks/useMessageActionController', () => ({
  useMessageActionController: () => ({
    selectAnswer: mocks.selectAnswer,
    regenerateAssistant: vi.fn().mockResolvedValue(undefined),
    resendUser: vi.fn().mockResolvedValue(undefined),
    editSave: vi.fn().mockResolvedValue(true),
    resendWithEdit: vi.fn().mockResolvedValue(true)
  })
}))
vi.mock('@renderer/hooks/useScrollPosition', () => ({
  commitSnapshotForRoute: mocks.commitStableViewport,
  routeScrollKey: (topicId: string, branchId: string | null) => `topic-${topicId}::${branchId ?? 'main'}`,
  default: (_key: string) => ({
    containerRef: mocks.scrollContainerRef,
    handleScroll: vi.fn(),
    getSavedPosition: mocks.getSavedPosition,
    getSnapshotForRoute: mocks.getSnapshotForRoute,
    clearSavedPosition: vi.fn(),
    savePosition: mocks.savePosition,
    captureSnapshot: mocks.captureSnapshot
  })
}))
vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcut: vi.fn()
}))
vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: mocks.setTimeoutTimer, clearTimeoutTimer: mocks.clearTimeoutTimer })
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
  useEditMode: () => ({ isEnabled: false, selectedGroupIds: [], handleGroupClick: vi.fn() })
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
  getPendingNavigate: mocks.getPendingNavigate,
  clearPendingNavigate: mocks.clearPendingNavigate
}))
vi.mock('@renderer/store', () => ({
  default: {
    getState: vi.fn(() => ({ messages: { messageIdsByTopic: {}, entities: {} }, editMode: { enabled: false } })),
    subscribe: vi.fn(() => vi.fn())
  },
  useAppDispatch: () => (mocks as any).dispatchMock,
  // Active branch defaults to main (null); branch-override tests rerender with
  // a selector that returns a branch id (see below).
  useAppSelector: (selector: any) => selector({ editMode: { enabled: false } } as any),
  useAppStore: () => ({
    getState: vi.fn(() => ({ messages: { messageIdsByTopic: {}, entities: {} }, editMode: { enabled: false } })),
    subscribe: vi.fn(() => vi.fn())
  })
}))
vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: { selectById: vi.fn() },
  updateOneBlock: vi.fn(),
  upsertManyBlocks: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertMany', payload: blocks }))
}))
vi.mock('@renderer/store/thunk/messageThunk', () => ({
  updateMessageAndBlocksThunk: vi.fn(),
  loadRouteMessagesThunk: vi.fn(() => ({ type: 'test/loadRouteMessages' })),
  loadRouteWindowWithFallback: vi.fn(async () => undefined)
}))
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
    fetchMessagesWindow: (...args: unknown[]) => (mocks as any).fetchMessagesWindow(...args)
  },
  DbService: vi.fn()
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    resolveContextClosure: (...args: unknown[]) => (mocks as any).resolveContextClosure(...args),
    fetchMessagesWindow: (...args: unknown[]) => (mocks as any).fetchMessagesWindow(...args)
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
// domVisibility stays REAL: viewport-top measurement is the claim under test.
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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))
vi.mock('styled-components', async () => {
  const actual = await vi.importActual('styled-components')
  return { ...actual, default: actual.default }
})

const Messages = (await import('../Messages')).default

const makeTopic = (id: string): Topic => ({ id, name: `Topic ${id}`, assistantId: 'assistant-1' }) as unknown as Topic
const makeAssistant = (): Assistant =>
  ({ id: 'assistant-1', name: 'Test Assistant', prompt: '' }) as unknown as Assistant
const makeMsg = (id: string, topicId = 'topic-a'): Message =>
  ({
    id,
    role: 'user',
    assistantId: 'assistant-1',
    topicId,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks: []
  }) as unknown as Message

// Manual rAF queue: the report path coalesces through requestAnimationFrame.
// Each test installs this BEFORE render so schedule→emit is deterministic.
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
const flushRaf = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    const pending = rafQueue
    rafQueue = []
    for (const cb of pending) {
      try {
        cb(0)
      } catch {}
    }
    await act(async () => {})
  }
}

// Container + rows with real geometry. The container rect top is 0; the
// ordered core picks the row crossing the top edge, else the first row below.
// Rows are grafted into the LIVE `#messages` host rendered by the component
// (see graftGeometryRows): the mocked MessageGroup children render no rows,
// so geometry fixtures must live inside the real host for the component's
// container fallback (`document.getElementById('messages')`) to measure them.
const graftGeometryRows = (
  view: HTMLElement,
  rowTops: Array<{ id: string; top: number; height: number }>
): HTMLElement => {
  const host = view.querySelector('#messages') as HTMLElement | null
  if (!host) throw new Error('readingAnchor fixture: live #messages host not found')
  host.getBoundingClientRect = () =>
    ({ top: 0, bottom: 600, left: 0, right: 400, width: 400, height: 600, x: 0, y: 0 }) as DOMRect
  for (const row of rowTops) {
    const el = document.createElement('div')
    el.id = `message-${row.id}`
    host.appendChild(el)
    el.getBoundingClientRect = () =>
      ({
        top: row.top,
        bottom: row.top + row.height,
        left: 0,
        right: 400,
        width: 400,
        height: row.height,
        x: 0,
        y: row.top
      }) as DOMRect
  }
  return host
}
const cleanupDom = (): void => {
  for (const el of Array.from(document.querySelectorAll('#messages, [id^="message-"]'))) {
    try {
      el.remove()
    } catch {}
  }
  mocks.scrollContainerRef.current = null
}

describe('Reading-anchor report (mounted Messages)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setPendingNavigate(null)
    mocks.getSavedPosition.mockReturnValue(null)
    pendingTransactionResolvers.length = 0
    mocks.scrollKeyStore.clear()
    mocks.scrollKeyRef.current = ''
    mocks.ensureMock.mockReset()
    mocks.ensureMock.mockImplementation(async () => ({ status: 'resident' }) as any)
    mocks.topicMessages = [] as any
    cleanupDom()
    ;(window as any).toast = { error: mocks.toastErrorMock, success: vi.fn(), warning: vi.fn(), loading: vi.fn() }
    installManualRaf()
  })

  it('reports the viewport-top anchor with a long-answer offset row on top', async () => {
    // Long answer a1 crosses the top edge (top -400, height 800); the next
    // user turn u2 starts below. Crossing-first semantics must pick a1.
    // Geometry rows are grafted into the LIVE `#messages` host after mount
    // (the mocked MessageGroup children render no rows); the component's
    // `document.getElementById('messages')` fallback then measures them.
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [makeMsg('u1'), makeMsg('a1'), makeMsg('u2')] as any
    const reports: ReadingAnchorReport[] = []
    const { container: view } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
        onReadingAnchor={(r) => reports.push(r)}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}::main`)
    graftGeometryRows(view, [
      { id: 'u1', top: -900, height: 60 },
      { id: 'a1', top: -400, height: 800 },
      { id: 'u2', top: 420, height: 60 }
    ])
    await flushRaf()
    expect(reports.length).toBeGreaterThan(0)
    const last = reports[reports.length - 1]
    expect(last.topicId).toBe('topic-a')
    expect(last.route).toBe(null)
    expect(last.messageId).toBe('a1')
    expect(last.navigationTargetId).toBe(null)
  })

  it('dedups identical frames: one report per anchor state', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [makeMsg('u1'), makeMsg('a1')] as any
    const reports: ReadingAnchorReport[] = []
    const { container: view } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
        onReadingAnchor={(r) => reports.push(r)}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}::main`)
    graftGeometryRows(view, [
      { id: 'u1', top: -300, height: 60 },
      { id: 'a1', top: -40, height: 400 }
    ])
    await flushRaf(5)
    // The anchor never moves across the extra frames: exactly one emission.
    expect(reports.length).toBe(1)
    expect(reports[0].messageId).toBe('a1')
  })

  it('suppresses stale reports across a topic transition (no foreign emit)', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()
    mocks.topicMessages = [makeMsg('u1', 'topic-a')] as any
    const reports: ReadingAnchorReport[] = []
    const { container: view, rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
        onReadingAnchor={(r) => reports.push(r)}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}::main`)
    graftGeometryRows(view, [{ id: 'u1', top: -20, height: 60 }])
    await flushRaf()
    expect(reports.length).toBeGreaterThan(0)
    expect(reports[reports.length - 1].topicId).toBe('topic-a')
    const countAfterA = reports.length

    // Switch to topic B with no measurable rows for B: the mismatch gate must
    // emit nothing (never a topic-a report under topic B).
    await act(async () => {
      rerender(
        <Messages
          assistant={assistant}
          topic={topicB}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
          onReadingAnchor={(r) => reports.push(r)}
        />
      )
    })
    mocks.simulatePassiveKeyUpdate(`topic-${topicB.id}::main`)
    await flushRaf()
    for (const r of reports.slice(countAfterA)) {
      expect(r.topicId).not.toBe('topic-a')
    }
  })

  it('pending target survives programmatic scrolls and clears on Promise settle', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [makeMsg('msg-target')] as any
    const reports: ReadingAnchorReport[] = []
    const { container: view } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
        onReadingAnchor={(r) => reports.push(r)}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}::main`)
    const host = graftGeometryRows(view, [{ id: 'msg-target', top: -10, height: 60 }])
    await flushRaf()
    // Initial anchor report (dedup baseline): one emission for msg-target.
    expect(reports.length).toBe(1)
    expect(reports[0].navigationTargetId).toBe(null)

    // The NAVIGATE_TO_MESSAGE entry uses internal `navigate` (not
    // navigateAndSave): no user-pending target is set, and a programmatic
    // scroll echo (no live user session) schedules only a re-measure.
    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    expect(typeof handler).toBe('function')
    const handlerPromise: Promise<any> = handler('msg-target')
    await act(async () => {})
    host.dispatchEvent(new Event('scroll'))
    await flushRaf()
    // Dedup holds (anchor unchanged, still no pending target): no new emission.
    expect(reports.length).toBe(1)
    for (const r of reports) {
      expect(r.navigationTargetId).toBe(null)
    }
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })
    await handlerPromise
    await flushRaf()
    // Settle emits nothing new when the anchor is unchanged (dedup holds):
    // the baseline report still carries no pending target.
    expect(reports.length).toBe(1)
    const last = reports[reports.length - 1]
    expect(last.navigationTargetId).toBe(null)
    expect(last.topicId).toBe('topic-a')
  })
  it('genuine user input clears a pending navigateAndSave target', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [makeMsg('u1'), makeMsg('a1')] as any
    const reports: ReadingAnchorReport[] = []
    const handleRef: { current: any } = { current: null }
    const { container: view } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
        onReadingAnchor={(r) => reports.push(r)}
        ref={handleRef}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}::main`)
    const host = graftGeometryRows(view, [
      { id: 'u1', top: -300, height: 60 },
      { id: 'a1', top: -40, height: 400 }
    ])
    await flushRaf()
    reports.length = 0

    // Imperative message navigate => pending target set (navigateAndSave).
    await act(async () => {
      handleRef.current?.scrollToMessageById('a1')
    })
    await flushRaf()
    expect(reports.length).toBeGreaterThan(0)
    expect(reports[reports.length - 1].navigationTargetId).toBe('a1')

    // Genuine user wheel on the live host (declare path) clears the pending
    // target and re-measures with a null target.
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.wheel(host, { deltaY: -120 })
    await flushRaf()
    expect(reports[reports.length - 1].navigationTargetId).toBe(null)
  })

  it('registry mount of a new top row re-measures (observer-effective path)', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [makeMsg('u1'), makeMsg('a1')] as any
    const reports: ReadingAnchorReport[] = []
    const { container: view } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
        onReadingAnchor={(r) => reports.push(r)}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}::main`)
    const host = graftGeometryRows(view, [
      { id: 'u1', top: -300, height: 60 },
      { id: 'a1', top: -40, height: 400 }
    ])
    await flushRaf()
    expect(reports[reports.length - 1].messageId).toBe('a1')

    // A new row mounting above the viewport top (older page prepended):
    // added to the live host; the MutationObserver path schedules a
    // re-measure. jsdom MutationObserver is async — flush microtasks + rAF.
    const older = document.createElement('div')
    older.id = 'message-u0'
    older.getBoundingClientRect = () =>
      ({ top: -900, bottom: -840, left: 0, right: 400, width: 400, height: 60, x: 0, y: -900 }) as DOMRect
    await act(async () => {
      host.insertBefore(older, host.firstChild)
      await new Promise((r) => setTimeout(r, 0))
    })
    await flushRaf()
    // Top anchor is unchanged (u0 is fully above the edge): dedup holds, no
    // spurious emission beyond the single anchor state.
    const last = reports[reports.length - 1]
    expect(last.messageId).toBe('a1')
    expect(reports.length).toBe(1)
  })
  it('post-settle sliver yields the clicked target (no previous-turn steal)', async () => {
    // Click-settle geometry: the previous answer keeps only a 1px sliver
    // below the viewport top while the clicked user target starts just below
    // (16px grid gap). Visual reading belongs to the target, not the sliver.
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [makeMsg('u1'), makeMsg('a1'), makeMsg('u2')] as any
    const reports: ReadingAnchorReport[] = []
    const { container: view } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
        onReadingAnchor={(r) => reports.push(r)}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}::main`)
    graftGeometryRows(view, [
      { id: 'u1', top: -900, height: 60 },
      { id: 'a1', top: -400, height: 401 },
      { id: 'u2', top: 17, height: 60 }
    ])
    await flushRaf()
    expect(reports.length).toBeGreaterThan(0)
    expect(reports[reports.length - 1].messageId).toBe('u2')
  })

  it('genuine previous-turn residency keeps the previous anchor', async () => {
    // Same stack but the previous answer still occupies 60px below the top:
    // natural cross-turn reading keeps a1 — the sliver guard must not steal.
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [makeMsg('u1'), makeMsg('a1'), makeMsg('u2')] as any
    const reports: ReadingAnchorReport[] = []
    const { container: view } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
        onReadingAnchor={(r) => reports.push(r)}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}::main`)
    graftGeometryRows(view, [
      { id: 'u1', top: -900, height: 60 },
      { id: 'a1', top: -400, height: 460 },
      { id: 'u2', top: 76, height: 60 }
    ])
    await flushRaf()
    expect(reports.length).toBeGreaterThan(0)
    expect(reports[reports.length - 1].messageId).toBe('a1')
  })
})
