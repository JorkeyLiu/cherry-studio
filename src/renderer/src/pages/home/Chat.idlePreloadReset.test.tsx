/**
 * Chat idle-preload stability reset — real production Chat component.
 *
 * Regression for the Settings idle-preload runtime defect: on first mount the
 * Messages child effect fires onFirstUpdate (scheduling the 300ms stability
 * timer) BEFORE the Chat parent topic-id reset effect runs. The reset must
 * not treat first mount as a topic switch and clear the just-scheduled
 * timer; a real topic id change must still reset stability and cancel it.
 *
 * Heavy deps are mocked at module boundaries; Chat itself, the real
 * useTimer, and real React effect ordering run as production code. The
 * observable oracle is the `enabled` flag Chat passes to
 * useRouteIdlePreload (mocked to record only).
 */
import { act, render, screen } from '@testing-library/react'
import type * as ReactModule from 'react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const preloadCalls = vi.hoisted(() => ({
  enabledHistory: [] as boolean[]
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
    assistant: { id: 'assistant-1' },
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
  useLoadedTopicMessages: () => [],
  useLoadedTopicReferencedBlocks: () => []
}))

vi.mock('@renderer/hooks/useContextClosure', () => ({
  useContextClosure: () => ({ closure: null })
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: () => ({})
}))

vi.mock('@renderer/services/contextClosure', () => ({
  computeClosureFingerprint: () => 'fp',
  getFreshValidatedClosure: () => null
}))

vi.mock('@renderer/services/contextInfoService', () => ({
  resolveSharedContextInfo: () => ({
    uiMessages: [],
    tokenEstimationMessages: [],
    boundaryMessageId: null,
    contextCount: { current: 0, max: null },
    anchorGroupKey: null
  })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { SHOW_TOPIC_SIDEBAR: 'SHOW_TOPIC_SIDEBAR' },
  EventEmitter: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }
}))

vi.mock('@renderer/services/phaseTimingDiagnostics', () => ({
  currentPhaseCorrelation: () => null,
  recordPhaseDurationForCorrelation: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => []
}))

vi.mock('@renderer/store/messageBlock', () => ({
  selectMessageBlocksByIds: () => []
}))

vi.mock('@renderer/store/settings', () => ({
  setTopicListWidth: (width: number) => ({ type: 'settings/setTopicListWidth', payload: width })
}))

vi.mock('@renderer/config/models', () => ({
  isEmbeddingModel: () => false,
  isRerankModel: () => false
}))

vi.mock('@renderer/components/ContentSearch', () => ({
  ContentSearch: () => null
}))

vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
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
  useRouteIdlePreload: (_importer: unknown, enabled: boolean) => {
    preloadCalls.enabledHistory.push(enabled)
  }
}))

vi.mock('lodash', () => ({
  debounce: (fn: (...args: unknown[]) => void) => {
    const wrapped = (...args: unknown[]) => fn(...args)
    wrapped.cancel = vi.fn()
    return wrapped
  }
}))

vi.mock('motion/react', () => {
  const MotionDiv = ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>
  return {
    motion: { div: MotionDiv },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>
  }
})

vi.mock('antd', () => {
  const Flex = ({ children, ...rest }: { children?: React.ReactNode }) => <div {...rest}>{children}</div>
  return { Flex }
})

// Child stubs: everything inert except Messages, which mirrors the real
// per-topic onFirstUpdate contract (fires in an effect keyed on topic.id,
// i.e. child effect before the Chat parent reset effect).
vi.mock('./components/ChatNavBar', () => ({
  default: () => <div data-testid="chatnavbar-stub" />
}))

vi.mock('./Inputbar/Inputbar', () => ({
  default: () => <div data-testid="inputbar-stub" />
}))

vi.mock('./Messages/ChatNavigation', () => ({
  default: () => null
}))

vi.mock('./Messages/Messages', () => {
  const React = require('react') as typeof ReactModule
  const Stub = ({ ref: _ref, ...props }) => {
    const { topic, onFirstUpdate } = props
    React.useEffect(() => {
      onFirstUpdate?.()
      // Mirror production deps: fire when the topic identity changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topic.id])
    return <div data-testid="messages-stub" data-topic-id={topic.id} />
  }
  return { default: Stub, __esModule: true }
})

vi.mock('./Tabs', () => ({
  default: () => null
}))

import Chat from './Chat'

const assistant = { id: 'assistant-1' } as never
const topicA = { id: 'topic-A', name: 'A' } as never
const topicB = { id: 'topic-B', name: 'B' } as never

const lastEnabled = (): boolean | undefined => preloadCalls.enabledHistory[preloadCalls.enabledHistory.length - 1]

describe('Chat idle-preload stability reset', () => {
  beforeEach(() => {
    preloadCalls.enabledHistory.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('first mount does not clear the just-scheduled stability timer', () => {
    render(<Chat assistant={assistant} activeTopic={topicA} setActiveTopic={vi.fn()} setActiveAssistant={vi.fn()} />)
    expect(screen.getByTestId('messages-stub')).toBeInTheDocument()
    // Child onFirstUpdate scheduled the 300ms timer; the parent first-mount
    // reset must not have cleared it, so stability is still pending.
    expect(lastEnabled()).toBe(false)

    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(lastEnabled()).toBe(true)
  })

  it('a real topic switch resets stability and cancels the pending timer', () => {
    const { rerender } = render(
      <Chat assistant={assistant} activeTopic={topicA} setActiveTopic={vi.fn()} setActiveAssistant={vi.fn()} />
    )
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(lastEnabled()).toBe(true)

    rerender(<Chat assistant={assistant} activeTopic={topicB} setActiveTopic={vi.fn()} setActiveAssistant={vi.fn()} />)
    // Switch resets stability immediately and the new topic schedules fresh.
    expect(lastEnabled()).toBe(false)

    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(lastEnabled()).toBe(true)
  })

  it('switching before the first timer fires cancels it (no stale stable)', () => {
    const { rerender } = render(
      <Chat assistant={assistant} activeTopic={topicA} setActiveTopic={vi.fn()} setActiveAssistant={vi.fn()} />
    )
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(lastEnabled()).toBe(false)

    rerender(<Chat assistant={assistant} activeTopic={topicB} setActiveTopic={vi.fn()} setActiveAssistant={vi.fn()} />)
    expect(lastEnabled()).toBe(false)

    // The old A timer would have fired 200ms later; it must have been
    // cancelled, so only the fresh B timer (300ms after switch) enables.
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(lastEnabled()).toBe(false)

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(lastEnabled()).toBe(true)
  })
})
