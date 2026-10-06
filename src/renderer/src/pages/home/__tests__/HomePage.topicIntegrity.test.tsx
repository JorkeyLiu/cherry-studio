/**
 * HomePage topic-integrity boundary — real production HomePage with a live
 * Redux-like store simulation and a controlled Main service.
 *
 * Production code under test: HomePage's runtime integrity gate (fresh-store
 * reader seam, pending/failed gating, history selection guards) composed with
 * the REAL assistantTopicIntegrity helper and the REAL Main-call ordering.
 * Only the Main IPC (`dbService.ensureAssistantTopics`) is a controllable
 * deferred; dispatches apply into the live store simulation like Redux, and
 * the holder sync below mirrors the production `useActiveTopic` adoption
 * effect (first live topic) so assertions observe rendered behavior.
 *
 * Regression contract: the reader closures must observe CURRENT store state
 * (fresh `store.getState()` seam), never the render-captured array — a
 * delete/unload racing the Main await must ignore the stale result instead
 * of resurrecting or dispatching stale topics.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const liveStore: {
    assistants: Array<{
      id: string
      name?: string
      model?: unknown
      settings?: unknown
      topics?: Array<{ id: string; assistantId?: string; name?: string }>
    }>
  } = { assistants: [] }
  let ensureImpl: (...args: Array<never>) => Promise<unknown> = async () => ({
    topics: [],
    created: false
  })
  const ensureMock = vi.fn((...args: Array<never>) => ensureImpl(...args))
  const dispatchMock = vi.fn((action: { type: string; payload?: unknown }) => {
    if (action && action.type === 'assistants/addTopic') {
      const { assistantId, topic } = action.payload as {
        assistantId: string
        topic: { id: string; assistantId?: string; name?: string }
      }
      liveStore.assistants = liveStore.assistants.map((a) =>
        a.id === assistantId
          ? {
              ...a,
              topics: [{ ...topic }, ...(Array.isArray(a.topics) ? a.topics : [])].filter(
                (t, i, arr) => arr.findIndex((x) => x.id === t.id) === i
              )
            }
          : a
      )
    }
    return action
  })
  let activeTopicHolder: { id: string; assistantId?: string; name?: string } | undefined = undefined
  const setActiveTopicMock = vi.fn((updater: unknown) => {
    activeTopicHolder =
      typeof updater === 'function'
        ? (updater as (prev: unknown) => typeof activeTopicHolder)(activeTopicHolder)
        : (updater as typeof activeTopicHolder)
  })
  const captured: {
    navbarProps?: { setActiveAssistant?: (a: unknown) => void }
    tabsProps?: { setActiveAssistant?: (a: unknown) => void }
  } = {}
  return {
    liveStore,
    ensureMock,
    setEnsureImpl: (fn: (...args: Array<never>) => Promise<unknown>) => {
      ensureImpl = fn
    },
    dispatchMock,
    captured,
    getActiveTopic: () => activeTopicHolder,
    setActiveTopicHolder: (t: typeof activeTopicHolder) => {
      activeTopicHolder = t
    },
    setActiveTopicMock,
    importReady: true
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcut: vi.fn()
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistants: () => ({ assistants: mocks.liveStore.assistants })
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  useActiveTopic: () => ({
    activeTopic: mocks.getActiveTopic(),
    setActiveTopic: mocks.setActiveTopicMock
  })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ showAssistants: false, showTopics: false })
}))

vi.mock('@renderer/hooks/useStore', () => ({
  useShowAssistants: () => ({ setShowAssistants: vi.fn() }),
  useShowTopics: () => ({ toggleShowTopics: vi.fn() })
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    ensureAssistantTopics: (...args: Array<never>) => mocks.ensureMock(...args)
  }
}))

vi.mock('@renderer/services/importProjectionReadiness', () => ({
  isImportProjectionReady: () => mocks.importReady
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { SHOW_ASSISTANTS: 'SHOW_ASSISTANTS' },
  EventEmitter: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({ assistants: { assistants: mocks.liveStore.assistants } })
  }
}))

vi.mock('@renderer/store/assistants', () => ({
  addTopic: (payload: unknown) => ({ type: 'assistants/addTopic', payload })
}))

vi.mock('@renderer/store/settings', () => ({
  setAssistantsWidth: (width: number) => ({ type: 'settings/setAssistantsWidth', payload: width })
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: {
    setTopicFulfilled: (payload: unknown) => ({ type: 'newMessage/setTopicFulfilled', payload })
  }
}))

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatchMock
}))

vi.mock('motion/react', () => {
  const MotionDiv = ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>
  return {
    motion: { div: MotionDiv },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>
  }
})

vi.mock('@renderer/databases', () => ({}))

vi.mock('../Chat', () => ({
  default: (props: { assistant?: { id?: string }; activeTopic?: { id?: string } }) => (
    <div data-testid="chat" data-assistant={props.assistant?.id} data-topic={props.activeTopic?.id} />
  )
}))

vi.mock('../Navbar', () => ({
  default: (props: { setActiveAssistant?: (a: unknown) => void }) => {
    mocks.captured.navbarProps = props
    return null
  }
}))

vi.mock('../Tabs', () => ({
  default: (props: { setActiveAssistant?: (a: unknown) => void }) => {
    mocks.captured.tabsProps = props
    return null
  }
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function seedAssistants(
  assistants: Array<{
    id: string
    name?: string
    model?: unknown
    settings?: unknown
    topics?: Array<{ id: string; assistantId?: string; name?: string }>
  }>
): void {
  mocks.liveStore.assistants = assistants.map((a) => ({
    ...a,
    topics: a.topics?.map((t) => ({ ...t }))
  }))
}

/**
 * Mirrors the production `useActiveTopic` adoption effect: when the holder is
 * missing/stale against the CURRENT live store, adopt the given assistant's
 * first live topic. Tests call this before rerendering, exactly where the
 * production hook effect would have run.
 */
function adoptLiveFirstTopic(assistantId: string): void {
  const live = mocks.liveStore.assistants.find((a) => a.id === assistantId)
  const topics = Array.isArray(live?.topics) ? live.topics : []
  const holder = mocks.getActiveTopic()
  if (!holder || !topics.some((t) => t.id === holder.id)) {
    mocks.setActiveTopicHolder(topics[0] ? { ...topics[0] } : undefined)
  }
}

async function renderHome(): Promise<{ rerender: (ui: ReactElement) => void; unmount: () => void }> {
  const { default: HomePage } = await import('../HomePage')
  const element = (
    <MemoryRouter initialEntries={['/']}>
      <HomePage />
    </MemoryRouter>
  )
  let rendered!: { rerender: (ui: ReactElement) => void; unmount: () => void }
  await act(async () => {
    rendered = render(element)
  })
  return rendered
}

async function rerenderHome(rendered: { rerender: (ui: ReactElement) => void }): Promise<void> {
  const { default: HomePage } = await import('../HomePage')
  await act(async () => {
    rendered.rerender(
      <MemoryRouter initialEntries={['/']}>
        <HomePage />
      </MemoryRouter>
    )
  })
}

beforeEach(() => {
  vi.resetModules()
  mocks.liveStore.assistants = []
  mocks.setActiveTopicHolder(undefined)
  mocks.ensureMock.mockClear()
  mocks.dispatchMock.mockClear()
  mocks.setActiveTopicMock.mockClear()
  mocks.setEnsureImpl(async () => ({ topics: [], created: false }))
  mocks.importReady = true
  mocks.captured.navbarProps = undefined
  mocks.captured.tabsProps = undefined
  document.body.innerHTML = ''
  ;(window as unknown as { api?: unknown }).api = {
    window: { setMinimumSize: vi.fn(), resetMinimumSize: vi.fn() }
  }
})

describe('HomePage topic-integrity boundary', () => {
  it('empty active assistant pending renders normal loading with no Chat and no CTA', async () => {
    seedAssistants([{ id: 'a-empty', name: 'Empty', topics: [] }])
    const gate = deferred<{ topics: Array<Record<string, string>>; created: boolean }>()
    mocks.setEnsureImpl(() => gate.promise)
    const rendered = await renderHome()

    expect(await screen.findByTestId('assistant-integrity-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('chat')).toBeNull()
    expect(screen.queryByText(/new topic/i)).toBeNull()
    expect(mocks.ensureMock).toHaveBeenCalledTimes(1)
    // Same id tuple: active assistant id + a real candidate id/name.
    const [assistantId, candidateId, candidateName] = mocks.ensureMock.mock.calls[0] as unknown as [
      string,
      string,
      string
    ]
    expect(assistantId).toBe('a-empty')
    expect(typeof candidateId).toBe('string')
    expect(candidateId.length).toBeGreaterThan(0)
    expect(typeof candidateName).toBe('string')
    expect(candidateName.length).toBeGreaterThan(0)
    await act(async () => {
      gate.resolve({ topics: [], created: false })
    })
    rendered.unmount()
  })

  it('resolving the authoritative topic mounts Chat exactly once without duplication', async () => {
    seedAssistants([{ id: 'a-empty', name: 'Empty', topics: [] }])
    const gate = deferred<{ topics: Array<Record<string, string>>; created: boolean }>()
    mocks.setEnsureImpl(() => gate.promise)
    const rendered = await renderHome()
    expect(await screen.findByTestId('assistant-integrity-loading')).toBeInTheDocument()

    await act(async () => {
      gate.resolve({
        topics: [
          {
            id: 't-main-1',
            assistantId: 'a-empty',
            name: 'Default Topic',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        created: true
      })
    })
    adoptLiveFirstTopic('a-empty')
    await rerenderHome(rendered)
    await waitFor(() => expect(screen.getByTestId('chat')).toBeInTheDocument())
    expect(screen.getByTestId('chat').getAttribute('data-topic')).toBe('t-main-1')
    expect(mocks.liveStore.assistants.find((a) => a.id === 'a-empty')?.topics?.map((t) => t.id)).toEqual(['t-main-1'])
    expect(mocks.ensureMock).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })

  it('switching from an assistant with topics to an empty one calls service once and guards Chat while pending', async () => {
    seedAssistants([
      { id: 'a-valid', name: 'Valid', topics: [{ id: 't-a', assistantId: 'a-valid', name: 'A' }] },
      { id: 'a-empty', name: 'Empty', topics: [] }
    ])
    mocks.setActiveTopicHolder({ id: 't-a', assistantId: 'a-valid', name: 'A' })
    const gate = deferred<{ topics: Array<Record<string, string>>; created: boolean }>()
    mocks.setEnsureImpl(() => gate.promise)
    const rendered = await renderHome()
    await waitFor(() => expect(screen.getByTestId('chat')).toBeInTheDocument())
    expect(screen.getByTestId('chat').getAttribute('data-topic')).toBe('t-a')

    const target = mocks.liveStore.assistants.find((a) => a.id === 'a-empty')
    await act(async () => {
      // Navbar always mounts (HomeTabs is hidden with showAssistants=false).
      mocks.captured.navbarProps?.setActiveAssistant?.(target)
    })
    expect(await screen.findByTestId('assistant-integrity-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('chat')).toBeNull()
    expect(mocks.ensureMock).toHaveBeenCalledTimes(1)
    expect((mocks.ensureMock.mock.calls[0] as Array<string>)[0]).toBe('a-empty')

    await act(async () => {
      gate.resolve({
        topics: [
          {
            id: 't-main-2',
            assistantId: 'a-empty',
            name: 'Default Topic',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        created: true
      })
    })
    adoptLiveFirstTopic('a-empty')
    await rerenderHome(rendered)
    await waitFor(() => expect(screen.getByTestId('chat')).toBeInTheDocument())
    expect(screen.getByTestId('chat').getAttribute('data-topic')).toBe('t-main-2')
    // The valid assistant's history is untouched.
    expect(mocks.liveStore.assistants.find((a) => a.id === 'a-valid')?.topics?.map((t) => t.id)).toEqual(['t-a'])
    rendered.unmount()
  })

  it('model/config updates keep the valid topic and never call integrity', async () => {
    seedAssistants([
      {
        id: 'a-1',
        name: 'One',
        model: { id: 'm-1' },
        settings: { temperature: 0.5 },
        topics: [{ id: 't-1', assistantId: 'a-1', name: 'T' }]
      }
    ])
    mocks.setActiveTopicHolder({ id: 't-1', assistantId: 'a-1', name: 'T' })
    const rendered = await renderHome()
    await waitFor(() => expect(screen.getByTestId('chat')).toBeInTheDocument())
    expect(mocks.ensureMock).not.toHaveBeenCalled()

    await act(async () => {
      mocks.liveStore.assistants = mocks.liveStore.assistants.map((a) =>
        a.id === 'a-1' ? { ...a, model: { id: 'm-2' }, settings: { temperature: 0.9 } } : a
      )
    })
    await rerenderHome(rendered)
    await waitFor(() => expect(screen.getByTestId('chat')).toBeInTheDocument())
    expect(screen.getByTestId('chat').getAttribute('data-topic')).toBe('t-1')
    expect(mocks.ensureMock).not.toHaveBeenCalled()
    rendered.unmount()
  })

  it('assistant deleted before await resolution never resurrects and dispatches nothing stale', async () => {
    seedAssistants([{ id: 'a-gone', name: 'Gone', topics: [] }])
    const gate = deferred<{ topics: Array<Record<string, string>>; created: boolean }>()
    mocks.setEnsureImpl(() => gate.promise)
    const rendered = await renderHome()
    expect(await screen.findByTestId('assistant-integrity-loading')).toBeInTheDocument()

    // Race: the assistant is deleted while Main is in flight (fresh store!).
    await act(async () => {
      mocks.liveStore.assistants = []
    })
    await act(async () => {
      gate.resolve({
        topics: [
          {
            id: 't-stale',
            assistantId: 'a-gone',
            name: 'Stale',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        created: true
      })
    })
    const addCalls = mocks.dispatchMock.mock.calls.filter(
      (call) => (call[0] as { type?: string })?.type === 'assistants/addTopic'
    )
    expect(addCalls).toHaveLength(0)
    expect(mocks.liveStore.assistants).toEqual([])
    rendered.unmount()
  })

  it('assistant unloaded (topics undefined) before await resolution dispatches nothing stale', async () => {
    seedAssistants([{ id: 'a-unloaded', name: 'U', topics: [] }])
    const gate = deferred<{ topics: Array<Record<string, string>>; created: boolean }>()
    mocks.setEnsureImpl(() => gate.promise)
    const rendered = await renderHome()
    expect(await screen.findByTestId('assistant-integrity-loading')).toBeInTheDocument()

    await act(async () => {
      mocks.liveStore.assistants = [{ id: 'a-unloaded', name: 'U', topics: undefined }]
    })
    await act(async () => {
      gate.resolve({
        topics: [
          {
            id: 't-stale-2',
            assistantId: 'a-unloaded',
            name: 'Stale',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        created: true
      })
    })
    const addCalls = mocks.dispatchMock.mock.calls.filter(
      (call) => (call[0] as { type?: string })?.type === 'assistants/addTopic'
    )
    expect(addCalls).toHaveLength(0)
    rendered.unmount()
  })

  it('genuine failure shows existing error + retry, and retry recovers Chat', async () => {
    seedAssistants([{ id: 'a-flaky', name: 'Flaky', topics: [] }])
    const first = deferred<{ topics: Array<Record<string, string>>; created: boolean }>()
    mocks.setEnsureImpl(() => first.promise)
    const rendered = await renderHome()
    expect(await screen.findByTestId('assistant-integrity-loading')).toBeInTheDocument()

    await act(async () => {
      first.reject(new Error('SQL unavailable'))
    })
    expect(await screen.findByTestId('assistant-integrity-error')).toBeInTheDocument()
    expect(screen.queryByTestId('chat')).toBeNull()
    expect(mocks.ensureMock).toHaveBeenCalledTimes(1)

    const second = deferred<{ topics: Array<Record<string, string>>; created: boolean }>()
    mocks.setEnsureImpl(() => second.promise)
    await act(async () => {
      fireEvent.click(screen.getByTestId('assistant-integrity-retry'))
    })
    expect(mocks.ensureMock).toHaveBeenCalledTimes(2)
    // Same id tuple across retry — never a second assistant or candidate leak.
    expect((mocks.ensureMock.mock.calls[0] as Array<string>)[0]).toBe('a-flaky')
    expect((mocks.ensureMock.mock.calls[1] as Array<string>)[0]).toBe('a-flaky')
    await act(async () => {
      second.resolve({
        topics: [
          {
            id: 't-recovered',
            assistantId: 'a-flaky',
            name: 'Default Topic',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        created: true
      })
    })
    adoptLiveFirstTopic('a-flaky')
    await rerenderHome(rendered)
    await waitFor(() => expect(screen.getByTestId('chat')).toBeInTheDocument())
    expect(screen.getByTestId('chat').getAttribute('data-topic')).toBe('t-recovered')
    rendered.unmount()
  })
})
