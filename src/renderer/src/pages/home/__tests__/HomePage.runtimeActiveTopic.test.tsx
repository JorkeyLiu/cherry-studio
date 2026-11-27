/**
 * HomePage owns the single runtime `activeTopic` mirror.
 *
 * Before this change every message consumer (`useChatContext`) dispatched
 * `runtime/setActiveTopic` on each new topic reference, so one branch switch
 * fanned out into one identical action per mounted consumer. Now the owner
 * (HomePage: `useActiveTopic` + local `setActiveTopic`) is the only writer:
 * - initial mount syncs the selected topic exactly once;
 * - a topic switch syncs the new topic exactly once;
 * - a lagging consumer holding a stale topic object cannot overwrite the
 *   runtime copy (consumers never dispatch);
 * - a same-id metadata update mirrors the latest object while the id stays;
 * - the navbar `Tools` id gate keeps working off the mirrored copy.
 *
 * Heavy HomePage children (Chat/Navbar/Tabs/viewport providers) are stubbed
 * like the existing Chat suites; the owner state, its transition callbacks,
 * the real `useActiveTopic`, the new mirror effect, the real `useChatContext`
 * probes and the real `Tools` gate all run for real against a real store.
 */
import { act, render, screen } from '@testing-library/react'
import type * as ReactModule from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  assistant: {
    id: 'assistant-1',
    name: 'Assistant',
    topics: [
      { id: 'topic-A', name: 'Topic A' },
      { id: 'topic-B', name: 'Topic B' }
    ]
  } as any,
  chatProps: null as any,
  freezeDisplayed: vi.fn()
}))

vi.mock('motion/react', () => {
  const MotionDiv = ({ children, ...rest }: { children?: ReactModule.ReactNode }) => <div {...rest}>{children}</div>
  return {
    motion: { div: MotionDiv },
    AnimatePresence: ({ children }: { children?: ReactModule.ReactNode }) => <>{children}</>
  }
})

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/services/db', () => ({ dbService: { fetchTopicNamingContext: vi.fn() } }))
vi.mock('@renderer/services/db/topicMetadataPersist', () => ({ persistAutomaticTopicName: vi.fn() }))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: vi.fn(),
  ensureOrdinaryTopicOwnership: vi.fn(async () => {})
}))
vi.mock('@renderer/services/ApiService', () => ({
  fetchMessagesSummary: vi.fn()
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistants: () => ({ assistants: [hoisted.assistant] }),
  useAssistant: () => ({ assistant: hoisted.assistant })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ showAssistants: false, showTopics: false, messageNavigation: false }),
  getStoreSetting: () => false
}))

vi.mock('@renderer/hooks/useStore', () => ({
  useShowAssistants: () => ({ showAssistants: false, setShowAssistants: vi.fn() }),
  useShowTopics: () => ({ showTopics: false, toggleShowTopics: vi.fn() })
}))

vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcut: vi.fn()
}))

vi.mock('../Messages/routeViewportContext', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    RouteViewportProvider: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
    useRouteViewportCommands: () => ({ freezeDisplayed: hoisted.freezeDisplayed })
  }
})

vi.mock('../Messages/pairedReadingMinContext', () => ({
  PairedReadingMinProvider: ({ children }: { children: ReactModule.ReactNode }) => <>{children}</>,
  usePairedReadingMin: () => ({ pairedMinPair: 0, windowWidth: 1024 })
}))

vi.mock('../Chat', () => ({
  default: (props: any) => {
    hoisted.chatProps = props
    return <div data-testid="chat-stub" />
  }
}))

vi.mock('../Navbar', () => ({
  default: () => null
}))

vi.mock('../Tabs', () => ({
  default: () => null
}))

vi.mock('@renderer/components/EditModeToggle', () => ({
  default: () => <div data-testid="edit-mode-toggle" />
}))

vi.mock('@renderer/pages/home/components/ChatNavBar/Tools/SettingsButton', () => ({
  default: () => <div data-testid="settings-button" />
}))

vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: { children?: ReactModule.ReactNode }) => <div>{children}</div>
}))

import { configureStore } from '@reduxjs/toolkit'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { rootReducer } from '@renderer/store'
import { MemoryRouter } from 'react-router-dom'

import Tools from '../components/ChatNavBar/Tools'
import HomePage from '../HomePage'

type Any = any

const RUNTIME_SYNC_TYPE = 'runtime/setActiveTopic'

const makeStore = () =>
  configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

function mountOwner(store: Any) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Provider store={store}>
        <HomePage />
      </Provider>
    </MemoryRouter>
  )
}

function syncCalls(dispatchSpy: Any) {
  return dispatchSpy.mock.calls.filter((call: Any[]) => call[0]?.type === RUNTIME_SYNC_TYPE)
}

function runtimeActiveTopic(store: Any) {
  return store.getState().runtime.chat.activeTopic
}

function StaleProbe({ topic }: { topic: Any }) {
  // Real consumer hook holding a stale (lagging) topic reference.
  useChatContext(topic)
  return null
}

beforeEach(() => {
  hoisted.chatProps = null
  hoisted.freezeDisplayed.mockClear()
  hoisted.assistant = {
    id: 'assistant-1',
    name: 'Assistant',
    topics: [
      { id: 'topic-A', name: 'Topic A' },
      { id: 'topic-B', name: 'Topic B' }
    ]
  } as any
  ;(window as Any).api = {
    window: { setMinimumSize: vi.fn(), resetMinimumSize: vi.fn() }
  }
})

describe('HomePage runtime activeTopic single owner', () => {
  it('initial mount mirrors the selected topic exactly once', () => {
    const store = makeStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')

    mountOwner(store)

    const calls = syncCalls(dispatchSpy)
    expect(calls).toHaveLength(1)
    expect(runtimeActiveTopic(store)?.id).toBe('topic-A')
    expect(runtimeActiveTopic(store)).toEqual(hoisted.chatProps.activeTopic)
  })

  it('a topic switch syncs once and lagging consumers cannot overwrite it', () => {
    const store = makeStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    const { rerender } = mountOwner(store)

    // Drive through the real owner transition (no-op when already there).
    if (hoisted.chatProps.activeTopic?.id !== 'topic-A') {
      act(() => {
        hoisted.chatProps.setActiveTopic(hoisted.assistant.topics[0])
      })
    }
    dispatchSpy.mockClear()

    act(() => {
      hoisted.chatProps.setActiveTopic(hoisted.assistant.topics[1])
    })

    const switchCalls = syncCalls(dispatchSpy)
    expect(switchCalls).toHaveLength(1)
    expect(switchCalls[0][0].payload.id).toBe('topic-B')
    expect(runtimeActiveTopic(store)?.id).toBe('topic-B')

    // An unrelated rerender of the owner without a selection change syncs nothing.
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Provider store={store}>
          <HomePage />
        </Provider>
      </MemoryRouter>
    )
    expect(syncCalls(dispatchSpy)).toHaveLength(1)

    // Lagging consumers still holding the old topic: mount several and
    // rerender them with fresh stale references — the pre-fix fan-out wrote
    // one runtime action per consumer here; now nothing may be written.
    const staleA = { ...hoisted.assistant.topics[0] }
    const { rerender: rerenderStale } = render(
      <Provider store={store}>
        <StaleProbe topic={staleA} />
        <StaleProbe topic={{ ...hoisted.assistant.topics[0] }} />
      </Provider>
    )
    rerenderStale(
      <Provider store={store}>
        <StaleProbe topic={{ ...hoisted.assistant.topics[0] }} />
        <StaleProbe topic={{ ...hoisted.assistant.topics[0] }} />
      </Provider>
    )

    expect(syncCalls(dispatchSpy)).toHaveLength(1)
    expect(runtimeActiveTopic(store)?.id).toBe('topic-B')
  })

  it('a same-id metadata update mirrors the latest object while the id stays', () => {
    const store = makeStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    const { rerender } = mountOwner(store)

    act(() => {
      hoisted.chatProps.setActiveTopic(hoisted.assistant.topics[1])
    })
    expect(runtimeActiveTopic(store)?.id).toBe('topic-B')
    dispatchSpy.mockClear()

    // Assistant-side metadata sync arrives as new objects with the same ids.
    hoisted.assistant = {
      ...hoisted.assistant,
      topics: [{ ...hoisted.assistant.topics[0] }, { ...hoisted.assistant.topics[1], name: 'Topic B (renamed)' }]
    }
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Provider store={store}>
          <HomePage />
        </Provider>
      </MemoryRouter>
    )

    expect(runtimeActiveTopic(store)?.id).toBe('topic-B')
    expect(runtimeActiveTopic(store)?.name).toBe('Topic B (renamed)')
    expect(syncCalls(dispatchSpy).length).toBeGreaterThanOrEqual(1)
    expect(syncCalls(dispatchSpy).every((call: Any[]) => call[0].payload.id === 'topic-B')).toBe(true)
  })

  it('the Tools id gate keeps working off the mirrored copy', () => {
    const store = makeStore()

    const { unmount: unmountTools } = render(
      <Provider store={store}>
        <Tools />
      </Provider>
    )
    // No selection mirrored yet: the edit toggle stays hidden, settings stay.
    expect(runtimeActiveTopic(store)).toBeNull()
    expect(screen.queryByTestId('edit-mode-toggle')).toBeNull()
    expect(screen.getByTestId('settings-button')).toBeInTheDocument()
    unmountTools()

    mountOwner(store)
    act(() => {
      if (hoisted.chatProps.activeTopic?.id !== 'topic-B') {
        hoisted.chatProps.setActiveTopic(hoisted.assistant.topics[1])
      }
    })

    render(
      <Provider store={store}>
        <Tools />
      </Provider>
    )
    expect(runtimeActiveTopic(store)?.id).toBe('topic-B')
    expect(screen.getByTestId('edit-mode-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('settings-button')).toBeInTheDocument()
  })
})
