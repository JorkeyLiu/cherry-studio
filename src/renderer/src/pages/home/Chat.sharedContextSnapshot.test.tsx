/**
 * Chat shared-context snapshot — production Chat with a real block store.
 *
 * Renders the real Chat component against a real Redux store (real
 * `messageBlocks` slice + real `selectMessageBlocksByIds` + real
 * `resolveSharedContextInfo` + real `createSnapshotBlockMap`; only the
 * Messages/Inputbar children are stubs that record the shared projection).
 * The route sits authority-pending (persisted anchor, no closure), so the
 * shared input is the loaded topic's referenced blocks.
 *
 * Proves the inactive-block isolation claim: committing a block the active
 * input does not reference leaves the recorded shared projection untouched
 * (same identity), while updating a referenced block forms a new snapshot
 * and a new derivation carrying the updated content.
 */
import { configureStore } from '@reduxjs/toolkit'
import { act, render } from '@testing-library/react'
import type * as ReactModule from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  infos: [] as unknown[],
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
  useContextClosure: () => ({ closure: null, loading: false }),
  useClosureSemanticSignal: () => '0:0'
}))

vi.mock('@renderer/services/contextClosure', () => ({
  computeClosureFingerprint: () => 'fp',
  getFreshValidatedClosure: () => null,
  isAcceptedClosureForRoute: () => false
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

vi.mock('lodash', () => ({
  debounce: (fn: (...args: unknown[]) => void) => {
    const wrapped = (...args: unknown[]) => fn(...args)
    wrapped.cancel = vi.fn()
    return wrapped
  }
}))

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

vi.mock('./Messages/ConversationNavigation', () => ({
  default: () => null
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

import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { MessageBlockType } from '@renderer/types/newMessage'

import Chat from './Chat'

const makeStore = () =>
  configureStore({
    reducer: {
      messageBlocks: messageBlocksSlice.reducer,
      topicBranch: (state: any = { activeBranchIdByTopic: {}, routeGenerationByTopic: {} }) => state
    } as any,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

const lastInfo = (): any => hoisted.infos[hoisted.infos.length - 1]

describe('Chat shared-context snapshot', () => {
  beforeEach(() => {
    hoisted.infos.length = 0
  })

  it('inactive block commits do not invalidate the shared input; referenced updates form a new snapshot', () => {
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

    // Pending route: persisted anchor, no closure, content from the snapshot.
    const rendered = hoisted.infos.length
    expect(rendered).toBeGreaterThan(0)
    for (const info of hoisted.infos) {
      expect(info).toBe(hoisted.infos[0])
    }
    const info1 = lastInfo()
    expect(info1.isAuthoritativePending).toBe(true)
    expect(info1.anchorGroupKey).toBe('g0')
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

    // Updating a referenced block forms a new snapshot and a new derivation.
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
    const info2 = lastInfo()
    expect(info2).not.toBe(info1)
    expect(info2.blockSnapshot.get('b1').content).toBe('hello updated')
    expect(info2.isAuthoritativePending).toBe(true)
    expect(info2.anchorGroupKey).toBe('g0')
  })
})
