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
import { act, render, screen, waitFor } from '@testing-library/react'
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
  anchorGroupKey: null,
  blockSnapshot: new Map()
}

// ---------------------------------------------------------------------------
// vi.hoisted: mock values that must be referenced in vi.mock factory closures
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Pending navigate control — the test can inject/clear pending navigation
  // intents to exercise the bootstrap path.
  let pendingNavigate: { messageId: string; topicId: string } | null = null

  // S3.2: key-aware scroll position store. Mirrors production keyv:
  // keys are `scroll:<scrollKey>`, values are { scrollTop, anchorId, isAtBottom }.
  const scrollKeyStore = new Map<string, unknown>()

  // S3.2: Modeled scrollKeyRef — models the production useScrollPosition hook's
  // scrollKeyRef. The production hook updates scrollKeyRef.current inside
  // useEffect (passive), NOT during render. When useTopicTransition's
  // useLayoutEffect calls savePosition(), scrollKeyRef.current still holds the
  // PREVIOUS render's key. Tests must call simulatePassiveKeyUpdate() after each
  // rerender to advance the ref, matching real passive-effect timing.
  const scrollKeyRef = { current: '' }

  // S3.2: Stable function references. Messages.tsx has savePosition and
  // getSavedPosition in useEffect dependency arrays. If these are new
  // closures each render, the effect re-runs every render causing hangs.
  // Using vi.fn() here gives stable references that also track call counts.
  const savePositionSpy = vi.fn(() => {
    // Write to scrollKeyStore under scrollKeyRef.current.
    // At layout-effect time, scrollKeyRef.current still holds the OLD key
    // because the passive effect hasn't updated it yet.
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
    // Read from scrollKeyStore under scrollKeyRef.current (the modeled ref).
    // At layout-effect time, this still holds the OLD key.
    const val = scrollKeyStore.get(`scroll:${scrollKeyRef.current}`)
    if (val && typeof val === 'object' && 'scrollTop' in val) {
      return val as { scrollTop: number; anchorId: string | null; isAtBottom: boolean }
    }
    return null
  })

  // Mock refs to track (used by the mock factory and tests)
  const scrollContainerRef: { current: HTMLElement | null } = { current: null }

  // Deferred-read seam for the real-receipt mounted proof: per-test impl,
  // default void (existing transition tests keep the void-read path).
  const deferredReadImpl = vi.fn(async (..._args: any[]) => undefined)

  return {
    getPendingNavigate: vi.fn(() => pendingNavigate),
    deferredReadImpl,
    // Provider write seam: the mounted component must forward an accepted
    // receipt structure here from its atomic onPublish, not keep a local copy.
    acceptCommittedStructure: vi.fn(),
    ownershipEvents: [] as string[],
    navigationBegins: [] as Array<{ stage: 'prepare' | 'full'; intent: any; targetId: string | null; source: string }>,
    navigationResults: [] as Array<{ stage: 'prepare' | 'full'; result: string }>,
    clearPendingNavigate: vi.fn(() => true),
    setPendingNavigate: (value: { messageId: string; topicId: string } | null) => {
      pendingNavigate = value
    },

    // useScrollPosition — stable vi.fn() references that also write/read
    // from scrollKeyStore. The spy tracks call count (used by S3.1
    // epoch-guard tests) and the store write/read provides key-aware
    // behavior (used by S3.2 key-aware tests).
    savePosition: savePositionSpy,
    getSavedPosition: getSavedPositionSpy,
    // Stable-commit spy for the displayed-route coordinator: bootstrap and
    // route-switch completions persist via the trusted commit
    // (a programmatic restore needs no user input to become stable).
    commitStableViewport: vi.fn(() => true),
    // Live-viewport capture for stable commits: the coordinator measures the
    // final visible viewport and commits it under the target route key.
    captureSnapshot: vi.fn(() => ({
      scrollTop: -100,
      anchorId: 'm1',
      messageId: 'm1',
      intraRowOffset: -10,
      rawScrollTop: -100,
      isAtBottom: false
    })),
    // Route-snapshot read for the restore pipeline: stable identity like the
    // other scroll-hook spies above (a fresh closure per render would re-run
    // the route effect every render and never settle).
    getSnapshotForRoute: vi.fn(() => null),

    // S3.2: key-aware infrastructure — exposed for setup/teardown/assertion
    scrollKeyStore,
    scrollKeyRef,

    // useTimer mock
    setTimeoutTimer: vi.fn((_name: string, fn: () => void, _ms: number) => fn()),
    clearTimeoutTimer: vi.fn(),

    // EventEmitter subscriptions — captured for assertion
    eventHandlers: {} as Record<string, (...args: any[]) => any>,
    eventSubscribe: vi.fn((event: string, handler: (...args: any[]) => any) => {
      mocks.eventHandlers[event] = handler
      return vi.fn() // unsubscribe
    }),

    // useLoadedTopicMessages mock — returns empty messages by default.
    // `loadedResident` separates "projection not resident yet" (`undefined` =
    // no completeness fact, the A→B→A transient state) from a proven empty
    // projection (`[]`), which is the atomic-visibility gate's observed-empty
    // evidence.
    topicMessages: [] as Message[],
    renderProjectionRows: false,
    loadedResident: true,
    // Target-topic window-read busy state: an explicit pending identity list
    // means a read is in flight for that topic (the reducer slice shape).
    pendingWindowReads: {} as Record<string, unknown[]>,

    // Unified navigation: controllable ensure + observable dispatches/toast.
    ensureMock: vi.fn(async () => ({ status: 'resident' }) as any),
    // Bootstrap prepare structure handoff: opt into the REAL ensure/prepare
    useRealTransaction: false,
    // State used when the mounted component's mocked dispatch executes a real
    // thunk (bootstrap prepare's deferred around read).
    stateForThunk: null as any,
    // helpers for the focused around-receipt tests below; all existing suites
    // keep the controllable shims.
    useRealEnsure: false,
    useRealPrepare: false,
    dispatchMock: vi.fn(),
    upsertManyBlocksMock: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertMany', payload: blocks })),
    messagesReceivedMock: vi.fn((payload: unknown) => ({ type: 'newMessages/messagesReceived', payload })),
    toastErrorMock: vi.fn(),

    // Mock refs to track
    scrollContainerRef,

    // S3.2: Simulate the production useEffect that updates scrollKeyRef.current.
    // Must be called after each rerender to advance the modeled ref.
    simulatePassiveKeyUpdate: (key: string) => {
      scrollKeyRef.current = key
    },

    // S3.4: Stable action-controller mocks — isolated at the same boundary as
    // the suite's existing useMessageOperations mocks. Messages.tsx newly
    // imports useMessageActionController (expanding the real dependency graph
    // to include @renderer/config/constant#isMac); mocking here restores the
    // transition-isolated setup without broadening the narrow constant mock.
    selectAnswer: vi.fn().mockResolvedValue(undefined),
    regenerateAssistant: vi.fn().mockResolvedValue(undefined),
    resendUser: vi.fn().mockResolvedValue(undefined),
    editSave: vi.fn().mockResolvedValue(true),
    resendWithEdit: vi.fn().mockResolvedValue(true),

    // Context resolver: stable stub so the static `dbService` import never
    // loads the real SqliteMessageDataSource/store/assistants graph.
    // NEW_BRANCH inherit path is not exercised here; the null anchor is a
    // no-op that keeps test semantics unchanged.
    resolveContextClosure: vi.fn(async () => ({ resolvedAnchorGroupKey: null }) as any),
    fetchMessagesWindow: vi.fn(async (..._args: any[]) => ({ messages: [], blocks: [] }) as any),
    // Stable `t` identity (production `t` is stable; a fresh closure per
    // render would re-run `t`-dependent route effects every render).
    t: (key: string): string => key
  }
})

/**
 * S3.2: Create a mock scroll container with a controllable scrollTop.
 * In production, useScrollPosition reads containerRef.current.scrollTop.
 * The mock matches: savePosition reads scrollContainerRef.current.scrollTop.
 */
function createMockContainer(scrollTop: number): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true })
  return el
}

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
  // Named exports used by the displayed-route coordinator. The single
  // controller owns transition truth; the mock keeps timing isolated.
  commitSnapshotForRoute: mocks.commitStableViewport,
  routeScrollKey: (topicId: string, branchId: string | null) => `topic-${topicId}::${branchId ?? 'main'}`,
  default: (_key: string) => {
    // S3.2: Model production useScrollPosition key timing.
    //
    // The production hook updates scrollKeyRef.current inside useEffect
    // (passive), so when useTopicTransition's useLayoutEffect calls
    // savePosition(), scrollKeyRef.current still holds the PREVIOUS
    // render's key.
    //
    // We do NOT update scrollKeyRef here (in the factory call, which runs
    // during render). The test must call mocks.simulatePassiveKeyUpdate(key)
    // after each rerender to advance the ref — matching real passive-effect
    // timing. This ensures savePosition() always reads the stale ref value
    // at layout-effect time.
    //
    // IMPORTANT: savePosition and getSavedPosition are stable references
    // (mocks.savePosition and mocks.getSavedPosition — vi.fn() instances
    // defined once in vi.hoisted). Messages.tsx has them in useEffect
    // dependency arrays; new closures each render would cause infinite loops.
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
    // Folded-membership projection comes from authority catalog membership; this
    // suite exercises mounted-transition lifecycle only, so no folded group.
    // Route-scoped projection reads the authority catalog order
    // (orderedSegmentsForTopic); empty catalog here, so it stays fail-closed.
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
    acceptCommittedStructure: mocks.acceptCommittedStructure
  }
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
      // Production RootState always carries the resident-registry slice (its
      // initialState is { entries: {} }); the real selector then reads
      // undefined = never published, exactly like a fresh production store.
      residentRegistry: { entries: {} }
    })),
    subscribe: vi.fn(() => vi.fn())
  },
  useAppDispatch: () => (mocks as any).dispatchMock,
  // Read-busy: window-read pending identities only (generation never sets
  // this slice); the literals read the live knob so tests can inject a read.
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
      // Same production-shape conformance as the default store mock above.
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
    // Restore-pipeline loader stubs: the mocked dispatch never executes thunks,
    // so these only need to be callable. Without them, merely evaluating the
    // import throws a mock-missing error and the pipeline takes its exceptional
    // double-failure path (rebase + toast) instead of the normal empty-window
    // path — a mock-completeness gap, not production behavior.
    loadRouteMessagesThunk: vi.fn(() => ({ type: 'test/loadRouteMessages' })),
    // Deferred receipt: the route pipelines fetch through
    // `dispatchDeferredRouteWindowRead` without publishing. The default impl
    // stays void (fail visible, keep snapshot). Proof tests install
    // `mocks.deferredReadImpl` to delegate to the REAL entry with an executing
    // dispatch + controlled state; checker/payload are always production code.
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
    // Route chrome co-commit reads lightweight qualification (listSegments);
    // empty wires here: this suite carries no segments.
    listSegments: vi.fn(async () => [])
  },
  DbService: vi.fn()
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    resolveContextClosure: (...args: unknown[]) => (mocks as any).resolveContextClosure(...args),
    fetchMessagesWindow: (...args: unknown[]) => (mocks as any).fetchMessagesWindow(...args),
    // Route chrome co-commit reads lightweight qualification (listSegments);
    // empty wires here: this suite carries no segments.
    listSegments: vi.fn(async () => [])
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

vi.mock('@renderer/pages/home/Messages/domVisibility', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    findFirstVisibleMessage: vi.fn(() => null),
    findFirstVisibleMessageId: vi.fn(() => null)
  }
})

vi.mock('@renderer/utils/messageUtils/is', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    isTextLikeBlock: vi.fn(() => false)
  }
})
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
  const actual = (await vi.importActual('../messageNavigation')) as any
  const recordBegin = (stage: 'prepare' | 'full', intent: any, deps: any) => ({
    ...deps,
    begin: (...args: any[]) => {
      mocks.navigationBegins.push({
        stage,
        intent,
        targetId: args[1] ?? null,
        source: args[2] ?? intent?.source
      })
      return deps.begin(...args)
    }
  })
  return {
    ...actual,
    handlePendingNavigateEvent: vi.fn(async (topicId: string, messageId: string, deps: any) => {
      const joined = deps.isPendingInFlight?.(deps.getPending()) === true
      mocks.ownershipEvents.push(joined ? 'join' : 'claim')
      try {
        return await actual.handlePendingNavigateEvent(topicId, messageId, {
          ...deps,
          onStart: (target: any) => {
            mocks.ownershipEvents.push(`start:${target.messageId}`)
            deps.onStart?.(target)
          },
          onEnd: (consumed: boolean, result: string | null) => {
            mocks.ownershipEvents.push(`end:${messageId}:${consumed}:${result}`)
            deps.onEnd?.(consumed, result)
          }
        })
      } finally {
        mocks.ownershipEvents.push(`return:${messageId}`)
      }
    }),
    runMessageNavigationTransaction: vi.fn(
      (_intent: any, _deps: any): Promise<'success' | 'not-found' | 'cancelled'> => {
        mocks.navigationBegins.push({
          stage: 'full',
          intent: _intent,
          targetId: _intent?.targetId ?? null,
          source: _intent?.source
        })
        if ((mocks as any).useRealTransaction) {
          return actual
            .runMessageNavigationTransaction(_intent, recordBegin('full', _intent, _deps))
            .then((result: string) => {
              mocks.navigationResults.push({ stage: 'full', result })
              return result
            })
        }
        return new Promise<'success' | 'not-found' | 'cancelled'>((resolve) => {
          resolveTransactionControlled = resolve
          pendingTransactionResolvers.push((result) => {
            mocks.navigationResults.push({ stage: 'full', result })
            resolve(result)
          })
        })
      }
    ),
    // Bootstrap-only prepare entry: same controllable seam as the full
    // transaction above. Test bodies keep resolving 'success' (the legacy
    // full-transaction terminal); the shim translates it to the prepare
    // terminal 'prepared' so epoch/persistence assertions hold unchanged
    // under the prepare-only bootstrap contract.
    prepareMessageNavigationTarget: vi.fn(
      (_intent: any, _deps: any): Promise<{ status: 'prepared' | 'not-found' | 'cancelled' }> => {
        const deps = recordBegin('prepare', _intent, _deps)
        if ((mocks as any).useRealPrepare) {
          return actual.prepareMessageNavigationTarget(_intent, deps).then((result: { status: string }) => {
            mocks.navigationResults.push({ stage: 'prepare', result: result.status })
            return result
          })
        }
        return new Promise<{ status: 'prepared' | 'not-found' | 'cancelled' }>((resolve) => {
          pendingTransactionResolvers.push((result) => {
            if (result !== 'success') {
              resolve({ status: result })
              return
            }
            // Faithful prepared shape: echo the requested intent the way
            // resolveMessageNavigation would (the completion only reads
            // resolved.kind/targetId for its DEV trace).
            const preparedResolved =
              _intent?.kind === 'message'
                ? {
                    kind: 'message',
                    targetId: _intent.targetId,
                    alignment: _intent.alignment ?? 'start',
                    restoreOffset: null
                  }
                : _intent?.kind === 'scrollTop'
                  ? { kind: 'scrollTop', scrollTop: _intent.scrollTop }
                  : _intent?.kind === 'top'
                    ? { kind: 'top' }
                    : { kind: 'bottom' }
            resolve({ status: 'prepared', token: {}, resolved: preparedResolved } as any)
          })
        })
      }
    )
  }
})

// Unified navigation: the Messages navigate path ensures missing targets through
// messageNavigationLoader before running the transaction. These epoch-guard tests
// use empty topic messages, so without this mock every navigate would take the
// real ensure path (async window read) instead of reaching the controllable
// transaction mock below. Defaulting to `resident` keeps these tests focused on
// pending/epoch/persistence semantics; ensure-then-transaction success is covered
// by messageNavigationLoader.test.ts and the unified block below (controllable
// via mocks.ensureMock per test).
vi.mock('@renderer/pages/home/Messages/messageNavigationLoader', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    // Real loader is opt-in for the around-receipt handoff tests; existing
    // suites keep the deterministic resident shim.
    ensureMessageLoaded: (...args: any[]) =>
      (mocks as any).useRealEnsure ? actual.ensureMessageLoaded(...args) : (mocks as any).ensureMock(...args),
    buildNavigationAroundRequest: vi.fn(),
    NAVIGATION_LOADER_BEFORE: 10,
    NAVIGATION_LOADER_AFTER: 19
  }
})

vi.mock('@renderer/pages/home/Messages/messageViewportProjection', () => ({
  // Most transition tests keep rows mocked out. The cold-search proofs opt
  // into a minimal projected tuple so the target is real mounted DOM inside
  // the production scroll container, which FULL navigation requires.
  projectMessageViewportGroups: vi.fn(() => []),
  createViewportProjectionCache: () => ({
    project: (displayMessages: Message[]) =>
      mocks.renderProjectionRows && displayMessages.length > 0
        ? [['fixture-group', displayMessages.map((message, index) => ({ ...message, index }))]]
        : [],
    clear: () => {},
    size: () => 0
  })
}))

// Child component mocks — render with data-testid for identity/structure assertions
vi.mock('@renderer/pages/home/Messages/MessageGroup', () => ({
  default: vi.fn(({ messages = [] }: any) => (
    <div data-testid="message-group">
      {mocks.renderProjectionRows
        ? messages.map((message: Message) => (
            <div
              key={message.id}
              id={`message-${message.id}`}
              data-message-id={message.id}
              ref={(element) => {
                if (!element) return
                element.getBoundingClientRect = () =>
                  ({ top: 100, bottom: 130, left: 0, right: 200, width: 200, height: 30, x: 0, y: 100 }) as DOMRect
              }}
            />
          ))
        : null}
    </div>
  ))
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
  // Mock-completeness: the real messageThunk graph evaluates i18n/index.ts,
  // which consumes the init plugin object. Shape mirrors the real export.
  initReactI18next: { type: '3rdParty', init: () => undefined }
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
// Legitimate-target fixture helpers (bootstrap provenance fix):
// a mocked 'success' only proves placement when the target is actually
// loaded/rendered. These helpers make the success fixture legitimate via
// the existing seams (topicMessages + DOM row id/rect), never by forcing
// the commit spy or weakening assertions.
// ---------------------------------------------------------------------------
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

const installMessageRow = (id: string): HTMLElement => {
  let el = document.getElementById(`message-${id}`)
  if (!el) {
    el = document.createElement('div')
    el.id = `message-${id}`
    document.body.appendChild(el)
  }
  const htmlEl = el
  try {
    ;(htmlEl as unknown as { scrollIntoView: unknown }).scrollIntoView = () => undefined
  } catch {}
  try {
    htmlEl.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, left: 0, right: 200, width: 200, height: 30, x: 0, y: 100 }) as DOMRect
  } catch {}
  return htmlEl
}

const cleanupMessageRows = (): void => {
  for (const el of Array.from(document.querySelectorAll('[id^="message-"]'))) {
    try {
      el.remove()
    } catch {}
  }
}

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
    // S3.2: Clear key-aware scroll store and reset key ref
    mocks.scrollKeyStore.clear()
    mocks.scrollKeyRef.current = ''
    // Unified navigation defaults: resident (zero reads), empty projection.
    mocks.useRealEnsure = false
    mocks.useRealPrepare = false
    mocks.useRealTransaction = false
    mocks.navigationBegins.length = 0
    mocks.navigationResults.length = 0
    mocks.ownershipEvents.length = 0
    mocks.ensureMock.mockReset()
    mocks.ensureMock.mockImplementation(async () => ({ status: 'resident' }) as any)
    mocks.renderProjectionRows = false
    mocks.loadedResident = true
    mocks.pendingWindowReads = {}
    mocks.topicMessages = [] as any
    cleanupMessageRows()
    ;(window as any).toast = { error: mocks.toastErrorMock, success: vi.fn(), warning: vi.fn(), loading: vi.fn() }
  })

  // -----------------------------------------------------------------------
  // Departure freeze moved pre-change: the unified switch entry
  // (HomeViewportScope) freezes the outgoing displayed route BEFORE selected
  // changes, while the controller still shows the old route. The transition
  // coordinator therefore performs NO post-change save. These tests pin that
  // no stale write lands under any key during A→B / A→B→A.
  // -----------------------------------------------------------------------

  it('transition performs no post-change savePosition on A→B transition', () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Advance key ref to match topic A (simulates passive useEffect)
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)

    // savePosition should not be called on initial render
    mocks.savePosition.mockClear()

    // Switch topic — the transition must not save post-change (freeze is
    // pre-change); teardown duties (reset/epoch/timers) still run.
    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    rerender(
      <Messages
        assistant={assistant}
        topic={topicB}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // No post-change save: neither the old nor the new key may be written
    // by the transition.
    expect(mocks.savePosition).not.toHaveBeenCalled()
    expect(mocks.scrollKeyStore.size).toBe(0)
  })

  it('A→B→A performs no post-change save (no cross-topic contamination possible)', () => {
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

    // Advance key ref to match topic A
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    mocks.savePosition.mockClear()

    // A → B: no post-change save under any key
    rerender(
      <Messages
        assistant={assistant}
        topic={topicB}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    expect(mocks.savePosition).not.toHaveBeenCalled()

    // Advance key ref to match topic B
    mocks.simulatePassiveKeyUpdate(`topic-${topicB.id}`)

    // B → A: still no post-change save; the store stays untouched
    rerender(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    expect(mocks.savePosition).not.toHaveBeenCalled()
    expect(mocks.scrollKeyStore.size).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Key-aware mounted integration test (post-change save removed).
  //
  // Proves the transition writes NEITHER key: with distinct nonzero
  // scrollTop values (-150 for A, -300 for B) staged in mock containers,
  // A→B→A must leave the mock scrollKeyStore untouched — departure freeze
  // now happens pre-change in the unified entry, never post-change here.
  // -----------------------------------------------------------------------

  it('key-aware — A→B→A transition writes neither key (freeze is pre-change)', () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    // Messages component calls useScrollPosition(`topic-${topic.id}`),
    // so the actual keys are 'topic-topic-a' and 'topic-topic-b'.
    const keyA = `topic-${topicA.id}`
    const keyB = `topic-${topicB.id}`
    const storeKeyA = `scroll:${keyA}`
    const storeKeyB = `scroll:${keyB}`

    // Render with topic A — useScrollPosition(keyA) called.
    // Factory does NOT update scrollKeyRef (passive effect deferred).
    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Simulate passive effect: advance scrollKeyRef to keyA.
    mocks.simulatePassiveKeyUpdate(keyA)

    // Set up mock container with topic A's scroll position.
    mocks.scrollContainerRef.current = createMockContainer(-150)

    mocks.savePosition.mockClear()

    // A → B: the transition performs no post-change save (freeze is
    // pre-change). Staged distinct scrollTops stay uncommitted.
    rerender(
      <Messages
        assistant={assistant}
        topic={topicB}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // No save under either key — neither old A's staged -150 nor new B
    expect(mocks.savePosition).not.toHaveBeenCalled()
    expect(mocks.scrollKeyStore.get(storeKeyA)).toBeUndefined()
    expect(mocks.scrollKeyStore.get(storeKeyB)).toBeUndefined()

    // Simulate passive effect: advance scrollKeyRef to keyB.
    mocks.simulatePassiveKeyUpdate(keyB)

    // Set up mock container with topic B's distinct scroll position.
    mocks.scrollContainerRef.current = createMockContainer(-300)

    // B → A: still no post-change save
    rerender(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    expect(mocks.savePosition).not.toHaveBeenCalled()
    expect(mocks.scrollKeyStore.get(storeKeyA)).toBeUndefined()
    expect(mocks.scrollKeyStore.get(storeKeyB)).toBeUndefined()
    expect(mocks.scrollKeyStore.size).toBe(0)
  })

  it('S3.2: same-topic re-render does NOT call savePosition', () => {
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

    mocks.savePosition.mockClear()

    // Re-render with same topic — no transition, no save
    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    rerender(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    expect(mocks.savePosition).not.toHaveBeenCalled()
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

    // The actual child components should be rendered (via mocked versions).
    // Older paging is app-owned: the layout-only wrapper (not an external
    // scroll library) wraps the context menu under the #messages host.
    expect(screen.getByTestId('message-context-menu')).toBeTruthy()
    expect(screen.getByTestId('prompt')).toBeTruthy()
    expect(document.querySelector('#messages [data-older-paging="app-owned"]')).not.toBeNull()
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

    // Reset mock after initial render: the transition performs no
    // post-change save, so any call below would be a stale completion.
    mocks.savePosition.mockClear()

    // Before resolving the navigation, transition A → B (epoch incremented).
    // The epoch-guarded clearPending callback captures navEpoch at handler
    // start (0) and checks transitionEpochRef.current at call time.
    // The transition performs no post-change save; only a stale completion
    // could call savePosition below (guarded by epoch).
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
    // No post-change save exists anymore: the stale completion must NOT add
    // a call, so the count stays at zero.
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

    // S3.2: Reset mock after initial render
    mocks.savePosition.mockClear()

    // Transition A → B before the navigation resolves. The transition
    // performs no post-change save; only a stale completion could call.
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

    // The stale completion must NOT add a call, so the count stays at zero.
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

    // S3.2: Reset mock after initial render
    mocks.savePosition.mockClear()

    // Transition A → B (epoch 1) — no post-change save: departure freeze is
    // pre-change via the unified entry, the transition writes nothing.
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

    // B → A (epoch 2) — likewise no post-change save; bootstrap detects
    // matching pending and starts a new transaction
    // (promise #2), which overwrites resolveTransactionControlled.
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
    // S3.2: savePosition never called — neither transition performs a
    // post-change save (departure freeze is pre-change). The stale epoch-0
    // handler must NOT add calls.
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

    // Unified navigate ensures missing targets before the transaction, so the
    // bootstrap transaction starts after the ensure microtask chain drains.
    await act(async () => {})

    // Bootstrap should have started a pending navigation (epoch 0)
    expect(pendingTransactionResolvers.length).toBe(1)

    // S3.2: Reset mock after initial render
    mocks.savePosition.mockClear()

    // Transition A → B (epoch incremented to 1) — no post-change save: the
    // transition writes nothing; departure freeze is pre-change.
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
    // S3.2: savePosition never called — no post-change save on transition.
    // The stale bootstrap completion must NOT add a call.
    expect(mocks.savePosition).not.toHaveBeenCalled()
  })

  it('S3.1 Blocker 1: pending bootstrap same-epoch completion clears pending and persists', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })
    // Legitimate target proof: the mocked 'success' below claims the
    // load/render committed, so the target must actually be loaded (window
    // non-empty) and measurable in the DOM (row id seam).
    mocks.topicMessages = [makeMsg('msg-boot', 'topic-a'), makeMsg('m-tail', 'topic-a')] as any
    installMessageRow('msg-boot')

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Unified navigate ensures missing targets before the transaction, so the
    // bootstrap transaction starts after the ensure microtask chain drains.
    await act(async () => {})

    // Bootstrap started a pending navigation (epoch 0)
    expect(pendingTransactionResolvers.length).toBe(1)

    // No topic change — same epoch throughout
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })

    // Same epoch: clearPendingNavigate SHOULD have been called
    expect(mocks.clearPendingNavigate).toHaveBeenCalled()
    // Same epoch: the stable completion commits the restored viewport
    // (programmatic restore needs no user input to become stable).
    expect(mocks.commitStableViewport).toHaveBeenCalled()
  })

  it('S3.1 Blocker 1: pending bootstrap A→B→A — stale epoch-0 does not clear at epoch 2', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })
    // Legitimate current-target proof for the epoch-2 bootstrap: the
    // revisited topic actually loads the target and it is measurable.
    mocks.topicMessages = [makeMsg('msg-boot', 'topic-a'), makeMsg('m-tail', 'topic-a')] as any
    installMessageRow('msg-boot')

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )

    // Unified navigate ensures missing targets before the transaction, so the
    // bootstrap transaction starts after the ensure microtask chain drains.
    await act(async () => {})

    // Bootstrap started at epoch 0 (resolver index 0)
    expect(pendingTransactionResolvers.length).toBe(1)

    await act(async () => {})

    // S3.2: Reset mock after initial render
    mocks.savePosition.mockClear()

    // A → B (epoch 1) — no post-change save (departure freeze is pre-change)
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

    // B → A (epoch 2) — likewise no post-change save; bootstrap detects
    // matching pending and starts new navigation
    // (resolver index 1). Unified navigate ensures (async) before the
    // transaction, so drain the ensure microtask chain before asserting.
    // Refresh the loaded projection reference so the first-load window
    // effect re-applies for the revisited topic (same content, new
    // identity — mirrors per-topic resident loads).
    mocks.topicMessages = [makeMsg('msg-boot', 'topic-a'), makeMsg('m-tail', 'topic-a')] as any
    installMessageRow('msg-boot')
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
    await act(async () => {})

    // Two resolvers: epoch-0 (stale) and epoch-2 (current)
    expect(pendingTransactionResolvers.length).toBe(2)

    // Resolve both as 'success'
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
      pendingTransactionResolvers[1]?.('success')
    })

    // clearPendingNavigate called exactly once (epoch-2 bootstrap only)
    expect(mocks.clearPendingNavigate).toHaveBeenCalledTimes(1)
    // S3.2: savePosition never called — neither transition performs a
    // post-change save (departure freeze is pre-change). The epoch-2
    // bootstrap completion persists via the stable commit (not
    // savePosition). The stale epoch-0 completion must add no call.
    expect(mocks.savePosition).not.toHaveBeenCalled()
    expect(mocks.commitStableViewport).toHaveBeenCalledTimes(1)
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

    // S3.2: Reset mock after initial render
    mocks.savePosition.mockClear()

    // Transition A → B (epoch 1) — no post-change save (freeze is pre-change)
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

    // S3.2: savePosition never called — no post-change save on transition.
    // The stale restore completion must NOT add a call.
    expect(mocks.savePosition).not.toHaveBeenCalled()
  })

  it('S3.1 Blocker 2: saved restore same-epoch completion persists', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate(null)
    mocks.getSavedPosition.mockReturnValue({ scrollTop: 100, anchorId: null, isAtBottom: false })
    // Legitimate measurable window: a raw saved success needs a
    // non-perpetually-empty container window, not an empty projection.
    mocks.topicMessages = [makeMsg('m1', 'topic-a'), makeMsg('m2', 'topic-a')] as any

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

    // Same epoch: the stable completion commits the restored viewport
    // (programmatic restore needs no user input to become stable).
    expect(mocks.commitStableViewport).toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Bootstrap provenance: transient empty vs committed target window.
  // Only the current transaction's actually committed target window may
  // take first-placement/final-empty handling; a transient/bootstrap-old
  // empty stays hidden awaiting the hydrate/nav commit. Success strings
  // never force placed without positive placement evidence.
  // -----------------------------------------------------------------------

  it('bootstrap provenance: transient empty stays hidden, loaded target then places exactly once', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })
    mocks.topicMessages = [] as any

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    expect(pendingTransactionResolvers.length).toBe(1)

    // Transient/bootstrap-old empty while the hydrate is still deferred:
    // no premature terminal commit, no pending consume.
    await act(async () => {})
    expect(mocks.commitStableViewport).not.toHaveBeenCalled()
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()

    // Hydrate: the target is actually loaded and measurable.
    mocks.topicMessages = [makeMsg('msg-boot', 'topic-a'), makeMsg('m-tail', 'topic-a')] as any
    installMessageRow('msg-boot')
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
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })
    expect(mocks.clearPendingNavigate).toHaveBeenCalledTimes(1)
    expect(mocks.commitStableViewport).toHaveBeenCalledTimes(1)
  })

  it('bootstrap provenance: final committed empty never fabricates a stable snapshot', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })
    mocks.topicMessages = [] as any

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    expect(pendingTransactionResolvers.length).toBe(1)

    // The transaction claims success but the target window is finally empty
    // (no row, empty projection): fail visible, no stable commit, no fake
    // snapshot — the prior lawful target snapshot stands.
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })
    expect(mocks.commitStableViewport).not.toHaveBeenCalled()
  })

  it('readiness gate: unready target withholds placement until its own projection commits', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })
    // Phase 1: target projection not resident yet (A→B→A transient) — the
    // gate must withhold (waiting): hidden, no reveal, no ack, plan kept.
    // No busy read here: a pending read holds the navigate path itself, so
    // the prepare below would never be created; busy is injected in phase 2
    // after the plan is committed.
    mocks.loadedResident = false
    mocks.topicMessages = [] as any
    mocks.pendingWindowReads = {}

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    expect(pendingTransactionResolvers.length).toBe(1)

    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })
    expect(document.getElementById('messages')?.getAttribute('data-viewport-phase')).toBe('positioning')
    expect(mocks.commitStableViewport).not.toHaveBeenCalled()
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()

    // Phase 2: the target is resident-empty but a window read is in flight —
    // still waiting (busy): hidden, no reveal, no ack. The plan stays
    // committed-but-unconsumed while the completion suspends on its ack.
    mocks.loadedResident = true
    mocks.pendingWindowReads = { 'topic-a': ['read-1'] }
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
    expect(document.getElementById('messages')?.getAttribute('data-viewport-phase')).toBe('positioning')
    expect(mocks.commitStableViewport).not.toHaveBeenCalled()
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()

    // Phase 3: the read drains and the target's own rows commit — the
    // withheld plan places exactly once.
    mocks.pendingWindowReads = {}
    mocks.loadedResident = true
    mocks.topicMessages = [makeMsg('msg-boot', 'topic-a'), makeMsg('m-tail', 'topic-a')] as any
    installMessageRow('msg-boot')
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
    expect(mocks.clearPendingNavigate).toHaveBeenCalledTimes(1)
    expect(mocks.commitStableViewport).toHaveBeenCalledTimes(1)
  })

  it('readiness gate: proven empty target releases visible with no fabricated commit', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })
    // Phase 1: target projection not resident yet (A→B→A transient) — the
    // gate withholds: hidden, no commit, no pending consume.
    mocks.loadedResident = false
    mocks.topicMessages = [] as any
    mocks.pendingWindowReads = {}

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    expect(pendingTransactionResolvers.length).toBe(1)

    // The prepare resolves while the target is still uncommitted: the plan
    // is delivered on the legacy bootstrap binding, the layout gate stays
    // `waiting` (no hydrate window id yet), and the completion suspends on
    // the placement ack — hidden with the plan unconsumed.
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })
    expect(document.getElementById('messages')?.getAttribute('data-viewport-phase')).toBe('positioning')
    expect(mocks.commitStableViewport).not.toHaveBeenCalled()
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()

    // Phase 2: the hydrate read completes AFTER plan delivery. This is the
    // production deferred-receipt race (the ensure around-read receipt lands
    // later than the prepare microtask): the window-reconcile effect
    // re-applies the target's own empty window through the real production
    // `applyMessageWindow` seam, which rebinds the empty window's real
    // identity into rendered provenance via `noteSameRouteWindowUpdate` —
    // no fabricated snapshot, no new epoch, no timer.
    mocks.loadedResident = true
    mocks.topicMessages = [] as any
    mocks.pendingWindowReads = {}
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
    // observed-empty → fail-visible: the owner releases visible, the ack
    // settles, the completion runs to done — with no stable commit and no
    // pending consume (an empty target never clears pending nor invents an
    // anchor snapshot). This is the genuine-empty runtime contract the
    // visible empty-DOM entry proves in production.
    expect(document.getElementById('messages')?.getAttribute('data-viewport-phase')).toBe('revealed')
    expect(mocks.commitStableViewport).not.toHaveBeenCalled()
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()
  })

  it('bootstrap provenance: missing target with a non-empty window still refuses stable', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-missing' })
    mocks.topicMessages = [makeMsg('m1', 'topic-a'), makeMsg('m2', 'topic-a')] as any

    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    expect(pendingTransactionResolvers.length).toBe(1)

    // Window is non-empty but the requested row is absent and the plan
    // carries no raw fallback: actual outcome is unplaced, so even a
    // 'success' string must not force placed/stable.
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })
    expect(mocks.commitStableViewport).not.toHaveBeenCalled()
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()
  })

  it('bootstrap provenance: stale epoch success never commits under the new session', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()

    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-boot' })
    mocks.topicMessages = [] as any

    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    expect(pendingTransactionResolvers.length).toBe(1)
    mocks.commitStableViewport.mockClear()

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
    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })
    expect(mocks.commitStableViewport).not.toHaveBeenCalled()
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()
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

    // S3.2: Reset mock after initial render + scrollToBottom
    mocks.savePosition.mockClear()

    // Transition A → B (epoch 1) — no post-change save (freeze is pre-change)
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

    // S3.2: savePosition never called — no post-change save on transition.
    // The stale scrollToBottom completion must NOT add a call.
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

describe('Unified navigation — ensure/commit/pending semantics (mounted)', () => {
  const msgFor = (id: string, topicId = 'topic-a'): Message =>
    ({
      id,
      role: 'user',
      assistantId: 'assistant-1',
      topicId,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'success',
      blocks: []
    }) as unknown as Message

  const isolateNav = (topicId: string) => {
    mocks.scrollContainerRef.current = null
    mocks.scrollKeyStore.clear()
    mocks.scrollKeyRef.current = ''
    mocks.getSavedPosition.mockImplementation(() => null)
    mocks.simulatePassiveKeyUpdate(`topic-${topicId}`)
  }

  it('missing→loaded dispatches blocks/messages and runs the transaction only after the React commit is observable', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    const tail = [msgFor('m-tail-1'), msgFor('m-tail-2')]
    const target = msgFor('msg-target')
    const loadedMessages = [...tail, target] as Message[]
    const loadedBlocks = [{ id: 'b-target', messageId: 'msg-target' }] as any
    mocks.topicMessages = tail as any
    mocks.ensureMock.mockImplementation(
      async () => ({ status: 'loaded', messages: loadedMessages, blocks: loadedBlocks }) as any
    )

    mocks.setPendingNavigate(null)
    isolateNav('topic-a')
    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    pendingTransactionResolvers.length = 0
    mocks.dispatchMock.mockClear()

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    const handlerPromise: Promise<any> = handler('msg-target')
    // Let ensure resolve + staged publication happen (dispatch), but the
    // projection commit is not yet observable so the transaction must wait.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.dispatchMock).toHaveBeenCalled()
    expect(pendingTransactionResolvers.length).toBe(0)

    // Simulate the Redux projection / React commit becoming observable.
    mocks.topicMessages = loadedMessages as any
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
    // Bounded commit wait polls; allow it to observe the new projection.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120))
    })
    expect(pendingTransactionResolvers.length).toBe(1)

    await act(async () => {
      pendingTransactionResolvers[0]?.('success')
    })
    await handlerPromise
    expect(mocks.toastErrorMock).not.toHaveBeenCalled()
  })

  it('post-fetch stale cancels with zero publication', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()
    mocks.topicMessages = [] as any
    let ensureResolve: ((v: any) => void) | null = null
    mocks.ensureMock.mockImplementation(
      () =>
        new Promise<any>((resolve) => {
          ensureResolve = resolve
        })
    )
    mocks.setPendingNavigate(null)
    isolateNav('topic-a')
    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    pendingTransactionResolvers.length = 0
    mocks.dispatchMock.mockClear()

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    const handlerPromise: Promise<any> = handler('msg-target')
    await act(async () => {})

    // Topic switches while the around read is in flight. The switch itself
    // legitimately loads the new topic (one pipeline dispatch); clear after
    // it settles so the assertions below measure only the stale navigation
    // resolution (which must publish nothing).
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
    mocks.simulatePassiveKeyUpdate(`topic-${topicB.id}`)
    await act(async () => {})
    mocks.dispatchMock.mockClear()
    await act(async () => {
      ensureResolve?.({ status: 'loaded', messages: [msgFor('msg-target', 'topic-a')], blocks: [] })
    })
    await handlerPromise

    expect(mocks.dispatchMock).not.toHaveBeenCalled()
    expect(pendingTransactionResolvers.length).toBe(0)
  })

  it('transport error preserves pending with no publication and no toast', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [] as any
    mocks.ensureMock.mockImplementation(async () => ({ status: 'error' }) as any)
    // Mount settles first: the pending identity arrives on an already-mounted
    // controller, so this proves the mounted same-topic event entrance (which
    // must stay a first-class nav path, never a bootstrap duplicate).
    mocks.setPendingNavigate(null)
    mocks.clearPendingNavigate.mockClear()
    isolateNav('topic-a')
    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    pendingTransactionResolvers.length = 0
    mocks.dispatchMock.mockClear()
    mocks.toastErrorMock.mockClear()
    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-target' })

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    const handlerPromise: Promise<any> = handler('msg-target')
    await handlerPromise

    // Retryable error maps to cancelled: pending preserved, nothing published.
    expect(mocks.clearPendingNavigate).not.toHaveBeenCalled()
    expect(mocks.dispatchMock).not.toHaveBeenCalled()
    expect(mocks.toastErrorMock).not.toHaveBeenCalled()
    expect(pendingTransactionResolvers.length).toBe(0)
  })

  it('authoritative not-found clears pending with a single not-found toast', async () => {
    const topicA = makeTopic('topic-a')
    const assistant = makeAssistant()
    mocks.topicMessages = [] as any
    mocks.ensureMock.mockImplementation(async () => ({ status: 'not-found' }) as any)
    mocks.setPendingNavigate(null)
    mocks.clearPendingNavigate.mockClear()
    mocks.clearPendingNavigate.mockImplementation(() => true)
    isolateNav('topic-a')
    render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    pendingTransactionResolvers.length = 0
    mocks.dispatchMock.mockClear()
    mocks.setPendingNavigate({ topicId: 'topic-a', messageId: 'msg-missing' })

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    const handlerPromise: Promise<any> = handler('msg-missing')
    await handlerPromise

    expect(mocks.dispatchMock).not.toHaveBeenCalled()
    expect(mocks.toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found')
    expect(mocks.clearPendingNavigate).toHaveBeenCalled()
    expect(pendingTransactionResolvers.length).toBe(0)
  })

  it('live topic ref captures a switch during the ensure window (no stale closure)', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()
    mocks.topicMessages = [] as any
    let ensureResolve: ((v: any) => void) | null = null
    mocks.ensureMock.mockImplementation(
      () =>
        new Promise<any>((resolve) => {
          ensureResolve = resolve
        })
    )
    mocks.setPendingNavigate(null)
    isolateNav('topic-a')
    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    pendingTransactionResolvers.length = 0
    mocks.dispatchMock.mockClear()

    const handler = mocks.eventHandlers['NAVIGATE_TO_MESSAGE']
    const handlerPromise: Promise<any> = handler('msg-target')
    await act(async () => {})

    // Live ref must observe the switch even though the navigate closure was
    // created for topic-a: switch to B (its legitimate pipeline load settles
    // first and is cleared), then resolve the in-flight ensure. The stale
    // resolution must publish nothing.
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
    mocks.simulatePassiveKeyUpdate(`topic-${topicB.id}`)
    await act(async () => {})
    mocks.dispatchMock.mockClear()
    await act(async () => {
      ensureResolve?.({ status: 'loaded', messages: [msgFor('msg-target', 'topic-a')], blocks: [] })
    })
    await handlerPromise

    expect(mocks.dispatchMock).not.toHaveBeenCalled()
    expect(pendingTransactionResolvers.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Deferred top refresh — REAL mounted proof.
//
// Unlike the renderer-local harness, these tests render the actual production
// Messages component and drive its real top-restore pipeline:
// - the deferred read is the REAL `dispatchDeferredRouteWindowRead` (executing
//   dispatch + controlled state; I/O seam only `fetchMessagesWindow`), so the
//   receipt carries a genuine sync-prefix proof and requestSeq;
// - currency/payload are the REAL `isDeferredRouteWindowReceiptCurrent` and
//   `toDeferredJointPayload` (suite mock factory spreads the actual module);
// - the commit is the component's REAL `commitRouteWindowAtomic` with its REAL
//   `onPublish` (blocks + rebase dispatched from the production callback;
//   the action creators stay mocked as recorders, the payload is production).
// What the fixture cannot show (projection/rows are mocked to []) is claimed
// only as dispatch order + post-commit DOM target state, never as row content.
// ---------------------------------------------------------------------------
describe('deferred top refresh — real mounted proof (production receipt/commit)', () => {
  beforeEach(() => {
    mocks.deferredReadImpl.mockReset()
    mocks.deferredReadImpl.mockImplementation(async () => undefined)
  })

  /**
   * Real bundled structure for the mocked window (neutral catalog + route
   * qualification echoing the request route), so a mounted success proves
   * the production receipt→projection path instead of a structure-less stub.
   */
  function structuredBundle(req: any, groups: Array<{ id: string; members: string[] }>) {
    return {
      catalog: groups.map((g) => ({
        id: g.id,
        topicId: req.topicId,
        name: `g-${g.id}`,
        messageIds: g.members,
        headerMessageId: g.members[0] ?? null,
        ownerTopicId: req.topicId,
        ownerBranchId: null,
        createdAt: null,
        updatedAt: null,
        sortOrder: 0,
        firstMessageId: g.members[0] ?? null,
        lastMessageId: g.members[g.members.length - 1] ?? null,
        messageCount: g.members.length
      })),
      route: {
        topicId: req.topicId,
        branchId: req.branchId ?? null,
        qualifications: groups.map((g) => ({
          segmentId: g.id,
          headerInRoute: true,
          headerOwnedByRoute: true,
          routeMemberMessageIds: g.members
        }))
      }
    }
  }

  function validWindowResponse(
    req: any,
    ids: string[],
    opts: { blocks?: unknown[]; mutableMessageIds?: string[]; reference?: unknown; structure?: unknown } = {}
  ) {
    const messages = ids.map((id) => ({ id }))
    return {
      messages,
      blocks: opts.blocks ?? [],
      window: {
        kind: req.kind,
        completeness: 'window',
        topicId: req.topicId,
        anchorMessageId: null,
        requested: { limit: 10 },
        firstMessageId: messages.length > 0 ? messages[0].id : null,
        lastMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
        returnedCount: messages.length,
        hasMoreBefore: true,
        hasMoreAfter: false
      },
      ...(opts.mutableMessageIds !== undefined ? { mutableMessageIds: opts.mutableMessageIds } : {}),
      ...(opts.reference !== undefined ? { reference: opts.reference } : {}),
      ...(opts.structure !== undefined ? { structure: opts.structure } : {})
    }
  }

  function controlledState(topicId: string) {
    return {
      assistants: { assistants: [{ id: 'asst-1', settings: { contextCount: 5 }, topics: [{ id: topicId }] }] },
      messages: {
        entities: {},
        messageIdsByTopic: { [topicId]: [] },
        loadingByTopic: {},
        fulfilledByTopic: {},
        currentTopicId: topicId,
        displayCount: 10
      },
      messageBlocks: { entities: {} },
      topicBranch: { branchesByTopic: {}, activeBranchIdByTopic: {}, routeGenerationByTopic: {} },
      residentRegistry: { entries: {} }
    } as any
  }

  function installRealDeferredRead(state: any, seen: any[], captured: any[] = []) {
    return mocks.deferredReadImpl.mockImplementation(
      async (_d: any, _g: any, tid: string, route: string | null, readOpts: any, hooks: any) => {
        const realMod = await vi.importActual<any>('@renderer/store/thunk/messageThunk')
        const exec: any = (a: any) => {
          seen.push(a)
          if (typeof a === 'function') return a(exec, () => state)
          return a
        }
        const receipt = await realMod.dispatchDeferredRouteWindowRead(exec, () => state, tid, route, readOpts, hooks)
        if (receipt) captured.push(receipt)
        return receipt
      }
    )
  }

  it('latest success commits exactly once via the production onPublish (real receipt/checker/payload)', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()
    const state = controlledState(topicB.id)
    const seen: any[] = []
    const receipts: any[] = []
    installRealDeferredRead(state, seen, receipts)
    mocks.fetchMessagesWindow.mockImplementation(async (req: any) =>
      validWindowResponse(req, ['u1', 'a1'], {
        blocks: [{ id: 'blk-1', messageId: 'a1' }],
        mutableMessageIds: ['a1'],
        reference: { kind: 'branch', source: 's1' },
        structure: structuredBundle(req, [{ id: 's1', members: ['u1', 'a1'] }])
      })
    )
    mocks.topicMessages = [] as any
    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    mocks.dispatchMock.mockClear()
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
    mocks.simulatePassiveKeyUpdate(`topic-${topicB.id}`)
    await waitFor(() => {
      const rebases = mocks.dispatchMock.mock.calls
        .map((c) => c[0])
        .filter((a) => a?.type === 'newMessages/rebaseRouteMessages' && a?.payload?.topicId === topicB.id)
      expect(rebases.length).toBe(1)
    })
    const calls = mocks.dispatchMock.mock.calls.map((c) => c[0])
    const rebases = calls.filter((a) => a?.type === 'newMessages/rebaseRouteMessages')
    // Exactly one joint publish, for the new topic only.
    expect(rebases.length).toBe(1)
    const payload = rebases[0].payload
    expect(payload.topicId).toBe(topicB.id)
    expect(payload.route).toBeNull()
    expect([...payload.messages.map((m: any) => m.id)].sort()).toEqual(['a1', 'u1'])
    expect(payload.mutableMessageIds).toEqual(['a1'])
    expect(payload.reference).toEqual({ kind: 'branch', source: 's1' })
    // Same-batch order: blocks first, then the rebase (production onPublish).
    const blockIdx = calls.findIndex((a) => a?.type === 'messageBlocks/upsertMany')
    const rebaseIdx = calls.findIndex((a) => a?.type === 'newMessages/rebaseRouteMessages')
    expect(blockIdx).toBeGreaterThanOrEqual(0)
    expect(rebaseIdx).toBeGreaterThan(blockIdx)
    // The deferred read itself published nothing: zero store writes on the
    // executing dispatch path (real deferPublish guarantee).
    expect(seen.filter((a) => a?.type === 'newMessages/rebaseRouteMessages').length).toBe(0)
    expect(seen.filter((a) => a?.type === 'messageBlocks/upsertManyBlocks').length).toBe(0)
    // Post-commit DOM belongs to the new target (projection rows stay mocked).
    expect(screen.getByTestId('message-context-menu')).toHaveAttribute('data-topic-id', topicB.id)
    // Real response structure → displayed chrome (production receipt seam):
    // the captured receipt's joint carries the bundled structure, and the
    // production projection turns it into the target route's chrome with the
    // same currency the component's onPublish committed via setCommittedChrome.
    // Evidence tier: receipt→projection equality plus the exactly-once joint
    // above (dispatch order). Mounted row headers stay mocked-out, so no DOM
    // header-content claim is made here.
    const { toDeferredJointPayload } = await vi.importActual<any>('@renderer/store/thunk/messageThunk')
    const { projectCommittedChromeFromStructure } = await import('@renderer/utils/routeCommittedChrome')
    const receipt = receipts.find((r) => r?.topicId === topicB.id)
    expect(receipt).toBeDefined()
    const joint = toDeferredJointPayload(receipt)
    expect(joint.structure.route).toEqual({
      topicId: topicB.id,
      branchId: null,
      qualifications: [
        { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['u1', 'a1'] }
      ]
    })
    expect(joint.structure.catalog.map((c: any) => c.id)).toEqual(['s1'])
    const projected = projectCommittedChromeFromStructure({
      topicId: topicB.id,
      branchId: null,
      structure: joint.structure
    })
    expect(projected?.routeKey).toBe(`${topicB.id}::main`)
    expect(projected?.segments.map((s) => s.id)).toEqual(['s1'])
    expect(projected?.segments[0].memberIds).toEqual(['u1', 'a1'])
    expect(projected?.segments[0].headerInRoute).toBe(true)
    // Mounted wiring proof: the real onPublish forwards the committed receipt
    // structure AND its receipt-bound reference into the provider write seam
    // (the provider/hook implementation itself is proven in its own suites).
    expect(mocks.acceptCommittedStructure).toHaveBeenCalledTimes(1)
    expect(mocks.acceptCommittedStructure).toHaveBeenCalledWith(
      topicB.id,
      null,
      expect.objectContaining({
        catalog: expect.arrayContaining([expect.objectContaining({ id: 's1' })]),
        route: {
          topicId: topicB.id,
          branchId: null,
          qualifications: [
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['u1', 'a1'] }
          ]
        }
      }),
      { kind: 'branch', source: 's1' },
      receipt.routeGeneration
    )
  })

  it('read pending across a topic switch commits nothing for the old response (no old data)', async () => {
    const topicA = makeTopic('topic-a')
    const topicB = makeTopic('topic-b')
    const assistant = makeAssistant()
    const state = controlledState(topicB.id)
    const seen: any[] = []
    const receipts: any[] = []
    installRealDeferredRead(state, seen, receipts)
    let resolveRead: ((v: any) => void) | null = null
    const gated = new Promise<any>((r) => {
      resolveRead = r
    })
    mocks.fetchMessagesWindow.mockImplementationOnce(() => gated)
    mocks.topicMessages = [] as any
    const { rerender } = render(
      <Messages
        assistant={assistant}
        topic={topicA}
        setActiveTopic={vi.fn()}
        sharedContextInfo={defaultSharedContextInfo}
      />
    )
    await act(async () => {})
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    mocks.dispatchMock.mockClear()
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
    mocks.simulatePassiveKeyUpdate(`topic-${topicB.id}`)
    await act(async () => {})
    // Switch back while the B read is still pending, then resolve it late.
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
    mocks.simulatePassiveKeyUpdate(`topic-${topicA.id}`)
    await act(async () => {
      // The late response is a full bundled read (structure included), so the
      // refusal below proves a structured stale receipt publishes nothing.
      resolveRead?.(
        validWindowResponse({ kind: 'latest', topicId: topicB.id }, ['stale-b'], {
          structure: structuredBundle({ topicId: topicB.id, branchId: null }, [{ id: 's9', members: ['stale-b'] }])
        })
      )
    })
    await act(async () => {})
    const calls = mocks.dispatchMock.mock.calls.map((c) => c[0])
    const rebases = calls.filter((a) => a?.type === 'newMessages/rebaseRouteMessages')
    // The late B response committed nothing: no rebase, no stale ids.
    expect(rebases.length).toBe(0)
    expect(JSON.stringify(calls)).not.toContain('stale-b')
    expect(screen.getByTestId('message-context-menu')).toHaveAttribute('data-topic-id', topicA.id)
    // The refused read was bundled (structure requested and delivered), and
    // its projection was publishable — yet never published: the only chrome
    // publisher runs inside onPublish inside the guarded commit, which never
    // ran for this receipt (zero rebases above).
    const bReq = mocks.fetchMessagesWindow.mock.calls.map((c) => c[0]).find((r: any) => r?.topicId === topicB.id)
    expect(bReq?.includeStructure).toBe(true)
    const late = receipts.find((r) => r?.topicId === topicB.id)
    expect(late).toBeDefined()
    const { projectCommittedChromeFromStructure } = await import('@renderer/utils/routeCommittedChrome')
    const refused = projectCommittedChromeFromStructure({
      topicId: topicB.id,
      branchId: null,
      structure: late.response.structure
    })
    expect(refused?.segments.map((s) => s.id)).toEqual(['s9'])
  })

  // Bootstrap prepare around receipt — REAL ensure/prepare helpers mounted in
  // Messages. Fixtures above provide the real deferred receipt, checker and
  // provider forwarder seam; only store/I/O are controlled. This closes the
  // previous gap where the prepare helper was always shimmed.
  describe('bootstrap prepare around structure handoff (real mounted wiring)', () => {
    const TARGET = 'msg-boot'
    const OLD = 'old-1'
    const TAIL = 'm-tail'

    beforeEach(() => {
      mocks.useRealEnsure = true
      mocks.useRealPrepare = true
      mocks.acceptCommittedStructure.mockClear()
      mocks.dispatchMock.mockClear()
      mocks.clearPendingNavigate.mockClear()
      mocks.getPendingNavigate.mockClear()
      mocks.fetchMessagesWindow.mockReset()
      // The production component dispatches the real deferred thunk through
      // useAppDispatch; make the mocked dispatch execute it against the same
      // controlled state used by the receipt fixtures.
      mocks.dispatchMock.mockImplementation((action: any) =>
        typeof action === 'function' ? action(mocks.dispatchMock, () => mocks.stateForThunk) : action
      )
      mocks.deferredReadImpl.mockReset()
      mocks.deferredReadImpl.mockImplementation(async () => undefined)
      mocks.setPendingNavigate(null)
      mocks.topicMessages = [] as any
      mocks.loadedResident = true
      mocks.pendingWindowReads = {}
    })

    const mergedFor = (topicId: string) =>
      mocks.dispatchMock.mock.calls
        .map((call) => call[0])
        .filter(
          (action: any) => action?.type === 'newMessages/messagesWindowMerged' && action?.payload?.topicId === topicId
        )

    // Around windows are strictly validated: echo anchor + requested bounds.
    const aroundWindowResponse = (
      req: any,
      ids: string[],
      opts: { blocks?: unknown[]; mutableMessageIds?: string[]; reference?: unknown; structure?: unknown } = {}
    ) => ({
      messages: ids.map((id) => ({ id })),
      blocks: opts.blocks ?? [],
      window: {
        kind: 'around',
        completeness: 'window',
        topicId: req.topicId,
        anchorMessageId: req.anchorMessageId,
        requested: { before: req.before, after: req.after },
        firstMessageId: ids[0] ?? null,
        lastMessageId: ids[ids.length - 1] ?? null,
        returnedCount: ids.length,
        hasMoreBefore: true,
        hasMoreAfter: false
      },
      ...(opts.mutableMessageIds !== undefined ? { mutableMessageIds: opts.mutableMessageIds } : {}),
      ...(opts.reference !== undefined ? { reference: opts.reference } : {}),
      ...(opts.structure !== undefined ? { structure: opts.structure } : {})
    })

    const installRealRead = (topicId: string) => {
      const state = controlledState(topicId)
      mocks.stateForThunk = state
      const receipts: any[] = []
      installRealDeferredRead(state, [], receipts)
      return { state, receipts }
    }

    const commitProjection = (ids: string[], topicId: string) => {
      mocks.topicMessages = ids.map((id) => makeMsg(id, topicId)) as any
      if (!mocks.renderProjectionRows) {
        installMessageRow(TARGET)
        return
      }
      const container = document.getElementById('messages')
      if (container) {
        container.getBoundingClientRect = () =>
          ({ top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800, x: 0, y: 0 }) as DOMRect
        Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2000 })
        Object.defineProperty(container, 'clientHeight', { configurable: true, value: 800 })
      }
    }

    it('accepts the fetched structure only at final apply, exactly once, with full receipt fields', async () => {
      const topic = makeTopic('topic-a')
      const assistant = makeAssistant()
      const { receipts } = installRealRead(topic.id)
      mocks.setPendingNavigate({ topicId: topic.id, messageId: TARGET })
      // One resident neighbour makes the canonical loader take the UNION
      // path, never a rebase of the loaded projection.
      mocks.topicMessages = [makeMsg(OLD, topic.id)] as any
      const reference = { kind: 'branch', source: 's1' }
      const structure = structuredBundle({ topicId: topic.id, branchId: null }, [
        { id: 's1', members: [OLD, TARGET, TAIL] }
      ])
      mocks.fetchMessagesWindow.mockImplementation(async (req: any) =>
        aroundWindowResponse(req, [OLD, TARGET, TAIL], { reference, structure })
      )
      const view = () => (
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
      const { rerender } = render(view())
      await act(async () => {})
      await waitFor(() => expect(mergedFor(topic.id)).toHaveLength(1))
      // Merge happened but the target is not yet observably committed: the
      // provider must still be untouched at this point.
      expect(mocks.acceptCommittedStructure).not.toHaveBeenCalled()
      const merged = mergedFor(topic.id)[0].payload
      expect(new Set(merged.messages.map((message: any) => message.id))).toEqual(new Set([OLD, TARGET, TAIL]))
      expect(mocks.fetchMessagesWindow.mock.calls[0]?.[0]?.includeStructure).toBe(true)

      commitProjection([OLD, TARGET, TAIL], topic.id)
      await act(async () => {
        rerender(view())
      })
      await waitFor(() => expect(mocks.acceptCommittedStructure).toHaveBeenCalledTimes(1))
      const receipt = receipts.find((item) => item?.topicId === topic.id)
      expect(receipt).toBeDefined()
      expect(mocks.acceptCommittedStructure).toHaveBeenCalledWith(
        topic.id,
        null,
        structure,
        reference,
        receipt.routeGeneration
      )
    })

    it('rejects a receipt superseded between merge and final apply (no stale structure)', async () => {
      const topic = makeTopic('topic-a')
      const assistant = makeAssistant()
      const { state } = installRealRead(topic.id)
      mocks.setPendingNavigate({ topicId: topic.id, messageId: TARGET })
      mocks.topicMessages = [makeMsg(OLD, topic.id)] as any
      const structure = structuredBundle({ topicId: topic.id, branchId: null }, [
        { id: 's1', members: [OLD, TARGET, TAIL] }
      ])
      mocks.fetchMessagesWindow.mockImplementation(async (req: any) =>
        aroundWindowResponse(req, [OLD, TARGET, TAIL], { structure })
      )
      const view = () => (
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
      const { rerender } = render(view())
      await act(async () => {})
      await waitFor(() => expect(mergedFor(topic.id)).toHaveLength(1))
      expect(mocks.acceptCommittedStructure).not.toHaveBeenCalled()

      // Late same-topic read advances the request sequence captured by the
      // first receipt. This happens AFTER its merge, before its window apply.
      const realThunk = await vi.importActual<any>('@renderer/store/thunk/messageThunk')
      const exec: any = (action: any) => {
        if (typeof action === 'function') return action(exec, () => state)
        return action
      }
      mocks.fetchMessagesWindow.mockImplementationOnce(async (req: any) =>
        validWindowResponse({ ...req, kind: 'latest' }, ['late-only'])
      )
      await realThunk.dispatchDeferredRouteWindowRead(exec, () => state, topic.id, null, { kind: 'latest' })

      commitProjection([OLD, TARGET, TAIL], topic.id)
      await act(async () => {
        rerender(view())
      })
      await waitFor(() =>
        expect(document.getElementById('messages')?.getAttribute('data-viewport-phase')).toBe('positioning')
      )
      expect(mocks.acceptCommittedStructure).not.toHaveBeenCalled()
      // The merged messages are not withdrawn by the failed handoff.
      expect(mergedFor(topic.id)).toHaveLength(1)
    })

    it('already-loaded target keeps its zero-read contract and accepts nothing extra', async () => {
      const topic = makeTopic('topic-a')
      const assistant = makeAssistant()
      mocks.setPendingNavigate({ topicId: topic.id, messageId: TARGET })
      commitProjection([TARGET, TAIL], topic.id)
      render(
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
      await act(async () => {})
      await waitFor(() => expect(mocks.clearPendingNavigate).toHaveBeenCalledTimes(1))
      expect(mocks.fetchMessagesWindow.mock.calls.filter((call: any) => call[0]?.kind === 'around')).toHaveLength(0)
      expect(mocks.acceptCommittedStructure).not.toHaveBeenCalled()
    })

    it('missing structure keeps the merge but fails closed at the provider seam', async () => {
      const topic = makeTopic('topic-a')
      const assistant = makeAssistant()
      installRealRead(topic.id)
      mocks.setPendingNavigate({ topicId: topic.id, messageId: TARGET })
      mocks.topicMessages = [makeMsg(OLD, topic.id)] as any
      mocks.fetchMessagesWindow.mockImplementation(async (req: any) => aroundWindowResponse(req, [OLD, TARGET, TAIL]))
      const view = () => (
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
      const { rerender } = render(view())
      await act(async () => {})
      await waitFor(() => expect(mergedFor(topic.id)).toHaveLength(1))
      commitProjection([OLD, TARGET, TAIL], topic.id)
      await act(async () => {
        rerender(view())
      })
      await waitFor(() =>
        expect(document.getElementById('messages')?.getAttribute('data-viewport-phase')).toBe('positioning')
      )
      expect(mocks.acceptCommittedStructure).not.toHaveBeenCalled()
      expect(mergedFor(topic.id)).toHaveLength(1)
    })

    it('present-but-empty structure is accepted as the current route projection', async () => {
      const topic = makeTopic('topic-a')
      const assistant = makeAssistant()
      installRealRead(topic.id)
      mocks.setPendingNavigate({ topicId: topic.id, messageId: TARGET })
      mocks.topicMessages = [makeMsg(OLD, topic.id)] as any
      const emptyStructure = structuredBundle({ topicId: topic.id, branchId: null }, [])
      mocks.fetchMessagesWindow.mockImplementation(async (req: any) =>
        aroundWindowResponse(req, [OLD, TARGET, TAIL], { structure: emptyStructure })
      )
      const view = () => (
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
      const { rerender } = render(view())
      await act(async () => {})
      await waitFor(() => expect(mergedFor(topic.id)).toHaveLength(1))
      commitProjection([OLD, TARGET, TAIL], topic.id)
      await act(async () => {
        rerender(view())
      })
      await waitFor(() => expect(mocks.acceptCommittedStructure).toHaveBeenCalledTimes(1))
      expect(mocks.acceptCommittedStructure).toHaveBeenCalledWith(
        topic.id,
        null,
        emptyStructure,
        null,
        expect.any(Number)
      )
    })

    it('cold pending bootstrap owns the matching search event: one PREPARE, one around read, final structure accepted', async () => {
      const topic = makeTopic('topic-a')
      const assistant = makeAssistant()
      installRealRead(topic.id)
      // Per-test trace slice: a leaked async continuation from an earlier test
      // must never make this test's coordination claim ambiguous.
      const beginsAt = mocks.navigationBegins.length
      const resultsAt = mocks.navigationResults.length
      const ownershipAt = mocks.ownershipEvents.length
      mocks.useRealTransaction = true
      mocks.renderProjectionRows = true
      mocks.setPendingNavigate({ topicId: topic.id, messageId: TARGET })
      mocks.topicMessages = [makeMsg(OLD, topic.id)] as any
      const structure = structuredBundle({ topicId: topic.id, branchId: null }, [
        { id: 's1', members: [OLD, TARGET, TAIL] }
      ])
      let resolveRead: ((value: any) => void) | null = null
      const read = new Promise<any>((resolve) => {
        resolveRead = resolve
      })
      let requested: any = null
      mocks.fetchMessagesWindow.mockImplementation((req: any) => {
        requested = req
        return read
      })
      const view = () => (
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
      const { rerender } = render(view())
      await waitFor(() => expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1))

      const eventPromise = mocks.eventHandlers['NAVIGATE_TO_MESSAGE'](TARGET)
      await act(async () => {})
      expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolveRead?.(aroundWindowResponse(requested, [OLD, TARGET, TAIL], { structure }))
      })
      commitProjection([OLD, TARGET, TAIL], topic.id)
      await act(async () => {
        rerender(view())
      })
      await eventPromise

      await waitFor(() => expect(mocks.acceptCommittedStructure).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(mocks.clearPendingNavigate).toHaveBeenCalledTimes(1))
      expect(mocks.ownershipEvents.slice(ownershipAt)).toEqual(['join', `return:${TARGET}`])
      expect(mocks.navigationResults.slice(resultsAt)).toEqual([{ stage: 'prepare', result: 'prepared' }])
      expect(mocks.fetchMessagesWindow.mock.calls.filter((call: any) => call[0]?.kind === 'around')).toHaveLength(1)
      expect(mocks.navigationBegins.slice(beginsAt).filter((entry) => entry.targetId === TARGET)).toEqual([
        expect.objectContaining({ stage: 'prepare', targetId: TARGET, source: 'pending' })
      ])
      expect(document.getElementById(`message-${TARGET}`)).not.toBeNull()
    })

    it('matching search event arrives first: bootstrap joins it without a second PREPARE or around read', async () => {
      const topic = makeTopic('topic-a')
      const assistant = makeAssistant()
      installRealRead(topic.id)
      const beginsAt = mocks.navigationBegins.length
      const resultsAt = mocks.navigationResults.length
      const ownershipAt = mocks.ownershipEvents.length
      // Controlled transaction seam: the test drives the FULL settle explicitly.
      mocks.useRealTransaction = false
      mocks.renderProjectionRows = true
      mocks.setPendingNavigate({ topicId: topic.id, messageId: TARGET })
      mocks.topicMessages = [makeMsg(OLD, topic.id)] as any
      mocks.pendingWindowReads = { [topic.id]: ['bootstrap-read'] }
      let resolveRead: ((value: any) => void) | null = null
      const read = new Promise<any>((resolve) => {
        resolveRead = resolve
      })
      let requested: any = null
      mocks.fetchMessagesWindow.mockImplementation((req: any) => {
        requested = req
        return read
      })
      const view = () => (
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
      const { rerender } = render(view())
      await act(async () => {})
      expect(mocks.fetchMessagesWindow).not.toHaveBeenCalled()

      // The event claims the exact pending identity before bootstrap's read
      // becomes ready. Clearing read-busy must not start a duplicate PREPARE.
      const eventPromise = mocks.eventHandlers['NAVIGATE_TO_MESSAGE'](TARGET)
      await waitFor(() => expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1))
      mocks.pendingWindowReads = {}
      await act(async () => {
        rerender(view())
      })
      expect(mocks.fetchMessagesWindow).toHaveBeenCalledTimes(1)
      expect(mocks.navigationBegins.slice(beginsAt).filter((entry) => entry.stage === 'prepare')).toHaveLength(0)

      await act(async () => {
        resolveRead?.(aroundWindowResponse(requested, [OLD, TARGET, TAIL]))
      })
      commitProjection([OLD, TARGET, TAIL], topic.id)
      await act(async () => {
        rerender(view())
      })
      await waitFor(() =>
        expect(
          mocks.navigationBegins.filter((entry) => entry.stage === 'full' && entry.targetId === TARGET)
        ).toHaveLength(1)
      )
      expect(mocks.fetchMessagesWindow.mock.calls.filter((call: any) => call[0]?.kind === 'around')).toHaveLength(1)

      await act(async () => {
        // The controlled seam records its result where it resolves, so the
        // test settles through the recorded resolver, not the raw one.
        pendingTransactionResolvers[pendingTransactionResolvers.length - 1]?.('success')
      })
      await eventPromise

      expect(mocks.ownershipEvents.slice(ownershipAt)).toEqual([
        'claim',
        `start:${TARGET}`,
        `end:${TARGET}:true:success`,
        `return:${TARGET}`
      ])
      expect(mocks.navigationResults.slice(resultsAt)).toEqual([{ stage: 'full', result: 'success' }])
      await waitFor(() => expect(mocks.clearPendingNavigate).toHaveBeenCalledTimes(1))
      expect(mocks.navigationBegins.slice(beginsAt).filter((entry) => entry.targetId === TARGET)).toEqual([
        expect.objectContaining({ stage: 'full', targetId: TARGET, source: 'pending' })
      ])
      expect(document.getElementById(`message-${TARGET}`)).not.toBeNull()
    })

    it('a retained newer pending stays retryable after the older bootstrap session completes (no cross-consumption)', async () => {
      // A dedicated topic keeps leaked continuations of earlier tests (which
      // reuse topic-a) out of this case's observable trace.
      const topic = makeTopic('topic-gap')
      const assistant = makeAssistant()
      const NEWER = 'msg-newer'
      const beginsAt = mocks.navigationBegins.length
      // Controlled prepare/ensure seams: this case is about phase ownership and
      // retryability, not the around-receipt handoff exercised above.
      mocks.useRealPrepare = false
      mocks.useRealEnsure = false
      // Per-test slices: an earlier test's leaked continuation may still push a
      // resolver or consume a pending after the shared reset.
      const resolversAt = pendingTransactionResolvers.length
      const clearCallsAt = mocks.clearPendingNavigate.mock.calls.length
      mocks.setPendingNavigate({ topicId: topic.id, messageId: TARGET })
      mocks.topicMessages = [makeMsg(TARGET, topic.id), makeMsg(TAIL, topic.id)] as any
      installMessageRow(TARGET)
      const view = () => (
        <Messages
          assistant={assistant}
          topic={topic}
          setActiveTopic={vi.fn()}
          sharedContextInfo={defaultSharedContextInfo}
        />
      )
      const { rerender } = render(view())
      await act(async () => {})
      // The cold pending bootstrap owns exactly one PREPARE for its own target.
      expect(pendingTransactionResolvers.length).toBe(resolversAt + 1)

      // A newer search hit replaces the pending identity while that PREPARE is
      // still in flight: the in-flight session stays the only consumer.
      mocks.setPendingNavigate({ topicId: topic.id, messageId: NEWER })
      await act(async () => {
        rerender(view())
      })
      expect(pendingTransactionResolvers.length).toBe(resolversAt + 1)

      await act(async () => {
        pendingTransactionResolvers[resolversAt]?.('success')
      })
      await waitFor(() => expect(mocks.clearPendingNavigate.mock.calls.length).toBe(clearCallsAt + 1))
      // Only the identity the session armed is consumable; the newer pending
      // identity set afterwards is never consumed by the session predating it.
      const clearedArgs = mocks.clearPendingNavigate.mock.calls[clearCallsAt] as unknown[] | undefined
      expect(clearedArgs?.[0]).toEqual({ topicId: topic.id, messageId: TARGET })

      // Retryable: the next ordinary effect re-decision re-arms the retained
      // pending instead of the mount staying terminally closed for this topic.
      mocks.topicMessages = [makeMsg(TARGET, topic.id), makeMsg(TAIL, topic.id), makeMsg(NEWER, topic.id)] as any
      await act(async () => {
        rerender(view())
      })
      await waitFor(() => expect(pendingTransactionResolvers.length).toBe(resolversAt + 2))
      // The retried arm is a PREPARE of the retained intent, never a second
      // FULL transaction for the identity the older session already consumed.
      expect(mocks.navigationBegins.slice(beginsAt).filter((entry) => entry.stage === 'full')).toHaveLength(0)
      expect(mocks.clearPendingNavigate.mock.calls.length).toBe(clearCallsAt + 1)
      expect(mocks.clearPendingNavigate).not.toHaveBeenCalledWith(expect.objectContaining({ messageId: NEWER }))
    })
  })
})
