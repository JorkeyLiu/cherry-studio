/**
 * Chat shared-context snapshot — production Chat with a real block store.
 *
 * Renders the real Chat component against a real Redux store (real
 * `messageBlocks` slice + real `selectMessageBlocksByIds` + real
 * `resolveSharedContextInfo` + real `createSnapshotBlockMap`; only the
 * Messages/Inputbar children are stubs that record the shared projection).
 * The first case sits authority-pending (persisted anchor, no closure): the
 * shared input carries no block snapshot (derivation default empty Map) and
 * empty context/token lists, never the ordinary store. The second case pins
 * an authoritative closure, so the same real pipeline derives the Inputbar's
 * `tokenEstimationMessages` through the real empty-message filter.
 *
 * Proves the isolation claim: ordinary block commits (referenced or not)
 * never touch the pending shared projection (same identity, empty
 * snapshot); on the closure-backed route, updating a referenced block forms
 * a new snapshot and a new derivation carrying the updated content — and the
 * real derived Inputbar input change (a message dropping out of
 * `tokenEstimationMessages` when its only text goes blank) with authority
 * metadata (anchor/boundary/counts) untouched.
 */
import { configureStore } from '@reduxjs/toolkit'
import { act, render } from '@testing-library/react'
import type * as ReactModule from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  infos: [] as unknown[],
  closureState: { closure: null as any, accept: false },
  // The conversation outline is gated by the `messageNavigation` setting (off
  // by default), so its render count is the proof that a disabled navigation
  // is never mounted — and therefore never asks for a snapshot.
  navTelemetry: { renders: 0 },
  stableMsgs: [
    {
      id: 'm1',
      role: 'user',
      topicId: 't1',
      assistantId: 'a1',
      createdAt: '2026-07-19T00:00:00.000Z',
      status: 'success',
      blocks: ['b1']
    }
  ],
  anchorAssistant: {
    id: 'a1',
    name: 'A',
    settings: { contextCount: 25, contextWindowAnchor: { t1: { kind: 'active', groupKey: 'g0' } } }
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('react-hotkeys-hook', () => ({
  useHotkeys: vi.fn()
}))

vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcut: vi.fn()
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: hoisted.anchorAssistant,
    updateAssistant: vi.fn(),
    updateTopic: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ messageNavigation: false })
}))

vi.mock('@renderer/hooks/useStore', () => ({
  useShowTopics: () => ({ showTopics: false })
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: () => hoisted.stableMsgs
}))

vi.mock('@renderer/hooks/useContextClosure', () => ({
  useContextClosure: () => ({ closure: hoisted.closureState.closure, loading: false }),
  useClosureSemanticSignal: () => '0:0'
}))

vi.mock('@renderer/services/contextClosure', () => ({
  closureKeyForRoute: (topicId: string, branchId?: string | null) =>
    typeof branchId === 'string' && branchId.length > 0 ? `${topicId}:${branchId}` : topicId,
  computeClosureFingerprint: () => 'fp',
  getFreshValidatedClosure: () => null,
  isAcceptedClosureForRoute: () => hoisted.closureState.accept
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { SHOW_TOPIC_SIDEBAR: 'SHOW_TOPIC_SIDEBAR' },
  EventEmitter: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }
}))

vi.mock('@renderer/config/models', () => ({
  isEmbeddingModel: () => false,
  isRerankModel: () => false
}))

vi.mock('@renderer/components/ContentSearch', () => ({
  ContentSearch: () => null
}))

vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: { children: ReactModule.ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/components/Popups/PromptPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: { show: vi.fn() }
}))

vi.mock('@renderer/components/ResizableHandle', () => ({
  default: () => null
}))

vi.mock('@renderer/components/routeImporters', () => ({
  importSettingsPage: () => Promise.resolve({ default: () => null })
}))

vi.mock('@renderer/components/useRouteIdlePreload', () => ({
  useRouteIdlePreload: () => {}
}))

vi.mock('lodash', async (importOriginal) => {
  const mod = (await importOriginal()) as any
  // CJS interop: named exports live on `default`, not as own keys.
  const real = mod.default ?? mod
  return {
    ...real,
    debounce: (fn: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]) => fn(...args)
      wrapped.cancel = vi.fn()
      return wrapped
    }
  }
})

vi.mock('motion/react', () => {
  const MotionDiv = ({ children, ...rest }: { children?: ReactModule.ReactNode }) => <div {...rest}>{children}</div>
  return {
    motion: { div: MotionDiv },
    AnimatePresence: ({ children }: { children?: ReactModule.ReactNode }) => <>{children}</>
  }
})

vi.mock('antd', () => {
  const Flex = ({ children, ...rest }: { children?: ReactModule.ReactNode }) => <div {...rest}>{children}</div>
  return { Flex }
})

vi.mock('./components/ChatNavBar', () => ({
  default: () => <div data-testid="chatnavbar-stub" />
}))

vi.mock('./Inputbar/Inputbar', () => {
  const Stub = (props: { sharedContextInfo: unknown }) => {
    hoisted.infos.push(props.sharedContextInfo)
    return <div data-testid="inputbar-stub" />
  }
  return { default: Stub, __esModule: true }
})

// The chat surface's route-structure owner is outside this test's subject:
// a transparent provider keeps Chat's real effect ordering without pulling the
// structural read (and its store slices) into this snapshot test.
vi.mock('./ChatRouteStructure', () => ({
  ChatRouteStructureProvider: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  useChatRouteStructure: () => ({
    segments: [],
    routeKey: '',
    isCurrent: false,
    committedChrome: null,
    acceptCommittedStructure: vi.fn()
  })
}))

// The chat surface's branch-catalog owner asks Main for the topic's branches;
// this snapshot test's subject is the shared context input, so it stays
// transparent here.
vi.mock('./ChatBranchCatalog', () => ({
  ChatBranchCatalogProvider: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  useChatBranchCatalogTopic: () => null,
  requestTopicBranches: vi.fn()
}))

vi.mock('./Messages/ConversationNavigation', () => ({
  default: () => {
    hoisted.navTelemetry.renders += 1
    return null
  }
}))

vi.mock('./Messages/Messages', () => {
  const Stub = ({ ref: _ref, ...props }) => {
    hoisted.infos.push((props as { sharedContextInfo: unknown }).sharedContextInfo)
    return <div data-testid="messages-stub" />
  }
  return { default: Stub, __esModule: true }
})

vi.mock('./Tabs', () => ({
  default: () => null
}))

import {
  registerExecutionOverlay,
  resetExecutionOverlayForTests,
  routeKeyForExecutionOverlay,
  subscribeExecutionOverlay
} from '@renderer/services/executionOverlayRegistry'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { MessageBlockType } from '@renderer/types/newMessage'

import Chat from './Chat'

const makeStore = () =>
  configureStore({
    reducer: {
      messageBlocks: messageBlocksSlice.reducer,
      settings: () => ({ assistantsWidth: 300, showAssistants: true }),
      topicBranch: (state: any = { activeBranchIdByTopic: {}, routeGenerationByTopic: {} }) => state
    } as any,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

const lastInfo = (): any => hoisted.infos[hoisted.infos.length - 1]

describe('Chat shared-context snapshot', () => {
  beforeEach(() => {
    hoisted.infos.length = 0
    hoisted.navTelemetry.renders = 0
    hoisted.closureState.closure = null
    hoisted.closureState.accept = false
    resetExecutionOverlayForTests()
  })

  it('pending route carries no snapshot: ordinary block commits never touch the shared input', () => {
    const store = makeStore()
    store.dispatch(
      messageBlocksSlice.actions.upsertOneBlock({
        id: 'b1',
        type: MessageBlockType.MAIN_TEXT,
        content: 'hello',
        messageId: 'm1'
      } as any)
    )

    render(
      <Provider store={store}>
        <Chat
          assistant={{ id: 'a1' } as never}
          activeTopic={{ id: 't1', name: 'T' } as never}
          setActiveTopic={vi.fn()}
          setActiveAssistant={vi.fn()}
        />
      </Provider>
    )
    // Pending route: persisted anchor, no closure — empty lists, default empty
    // snapshot, never the ordinary store. The outline is off by default
    // (`messageNavigation: false`), so the whole navigation component — and
    // with it every snapshot read — never mounts.
    expect(hoisted.navTelemetry.renders).toBe(0)
    const rendered = hoisted.infos.length
    expect(rendered).toBeGreaterThan(0)
    for (const info of hoisted.infos) {
      expect(info).toBe(hoisted.infos[0])
    }
    const info1 = lastInfo()
    expect(info1.isAuthoritativePending).toBe(true)
    expect(info1.anchorGroupKey).toBe('g0')
    expect(info1.uiMessages).toEqual([])
    expect(info1.tokenEstimationMessages).toEqual([])
    expect(info1.contextCount).toEqual({ current: 0, max: null })
    expect(info1.blockSnapshot.size).toBe(0)
    expect(info1.blockSnapshot.has('b1')).toBe(false)

    // An unrelated block commit does not touch the shared input.
    act(() => {
      store.dispatch(
        messageBlocksSlice.actions.upsertOneBlock({
          id: 'bx',
          type: MessageBlockType.MAIN_TEXT,
          content: 'unrelated',
          messageId: 'm9'
        } as any)
      )
    })
    expect(hoisted.infos.length).toBe(rendered)
    expect(lastInfo()).toBe(info1)

    // A referenced block update stays invisible too: pending reads nothing
    // through the ordinary store.
    act(() => {
      store.dispatch(
        messageBlocksSlice.actions.upsertOneBlock({
          id: 'b1',
          type: MessageBlockType.MAIN_TEXT,
          content: 'hello updated',
          messageId: 'm1'
        } as any)
      )
    })
    expect(hoisted.infos.length).toBe(rendered)
    expect(lastInfo()).toBe(info1)
    expect(lastInfo().blockSnapshot.size).toBe(0)
  })

  it('closure-backed route: referenced patch changes tokenEstimationMessages; unrelated keeps identity; metadata moves same-beat', () => {
    const store = makeStore()

    // Authoritative closure over the same message: bodies come from the
    // closure's own block snapshot (never the ordinary store) — the real
    // derivation reads content through the explicit snapshot, metadata stays
    // authoritative.
    const closureMessage = {
      id: 'm1',
      role: 'user',
      topicId: 't1',
      assistantId: 'a1',
      createdAt: '2026-07-19T00:00:00.000Z',
      status: 'success',
      blocks: ['b1']
    }
    const helloBlock = {
      id: 'b1',
      messageId: 'm1',
      type: MessageBlockType.MAIN_TEXT,
      content: 'hello',
      status: 'success'
    }
    hoisted.closureState.closure = {
      messages: [closureMessage],
      blocks: [helloBlock],
      closure: {
        anchorGroupKey: 'g0',
        boundaryMessageId: null,
        selectedTurnCount: 1,
        totalTurnCount: 1,
        foldedMessageIds: []
      }
    }
    hoisted.closureState.accept = true

    const renderChat = () => (
      <Provider store={store}>
        <Chat
          assistant={{ id: 'a1' } as never}
          activeTopic={{ id: 't1', name: 'T' } as never}
          setActiveTopic={vi.fn()}
          setActiveAssistant={vi.fn()}
        />
      </Provider>
    )
    const { rerender } = render(renderChat())

    const rendered = hoisted.infos.length
    expect(rendered).toBeGreaterThan(0)
    const info1 = lastInfo()
    expect(info1.isAuthoritativePending).toBe(false)
    expect(info1.anchorGroupKey).toBe('g0')
    expect(info1.tokenEstimationMessages.map((m: { id: string }) => m.id)).toEqual(['m1'])
    expect(info1.uiMessages.map((m: { id: string }) => m.id)).toEqual(['m1'])
    expect(info1.blockSnapshot.get('b1').content).toBe('hello')

    // An unrelated block commit does not touch the shared input.
    act(() => {
      store.dispatch(
        messageBlocksSlice.actions.upsertOneBlock({
          id: 'bx',
          type: MessageBlockType.MAIN_TEXT,
          content: 'unrelated',
          messageId: 'm9'
        } as any)
      )
    })
    expect(hoisted.infos.length).toBe(rendered)
    expect(lastInfo()).toBe(info1)

    // Blanking the only referenced text empties the real derived Inputbar
    // inputs (empty-message filter) while authority metadata holds. Bodies
    // now arrive through the execution-owned overlay (accepted member only),
    // never through the ordinary store.
    const execRouteKey = routeKeyForExecutionOverlay('t1', null)
    const execUnsubscribe = subscribeExecutionOverlay(execRouteKey, () => {})
    const execHandle = registerExecutionOverlay({
      topicId: 't1',
      route: null,
      messageId: 'm1',
      snapshot: () => ({
        blocks: [{ ...helloBlock, content: '   ' } as any]
      })
    })
    act(() => {
      execHandle.notifyDelta()
    })
    const info2 = lastInfo()
    expect(info2).not.toBe(info1)
    expect(info2.blockSnapshot.get('b1').content).toBe('   ')
    expect(info2.tokenEstimationMessages).toEqual([])
    expect(info2.uiMessages).toEqual([])
    expect(info2.anchorGroupKey).toBe('g0')
    expect(info2.boundaryMessageId).toBe(info1.boundaryMessageId)
    expect(info2.contextCount).toEqual(info1.contextCount)

    // Same-beat metadata move: a new closure anchor/boundary derives together
    // with the current snapshot content — no stale body rides along.
    hoisted.closureState.closure = {
      ...hoisted.closureState.closure,
      closure: {
        anchorGroupKey: 'g1',
        boundaryMessageId: 'm1',
        selectedTurnCount: 2,
        totalTurnCount: 5,
        foldedMessageIds: []
      }
    }
    rerender(renderChat())
    const info3 = lastInfo()
    expect(info3).not.toBe(info2)
    expect(info3.anchorGroupKey).toBe('g1')
    expect(info3.boundaryMessageId).toBe('m1')
    expect(info3.contextCount).toEqual({ current: 2, max: 5 })
    expect(info3.blockSnapshot.get('b1').content).toBe('   ')
    expect(info3.tokenEstimationMessages).toEqual([])
    execHandle.dispose()
    execUnsubscribe()
  })
})
