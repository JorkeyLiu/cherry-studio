/**
 * Send-draft lifecycle regression for the Inputbar send path.
 *
 * A sent draft must be consumed exactly once, synchronously: the input is
 * cleared with the dispatch, and afterwards the input belongs entirely to
 * the next composition. A stale delayed clear (the removed 500ms
 * `setText('')` timer) wiped text typed after sending — both fast typing on
 * the same topic and a draft started after a topic-route switch (Chat
 * renders one Inputbar instance without a topic key, so the switch is a
 * prop change on the same instance).
 *
 * The real Inputbar component renders here with real draft state
 * (useInputText + CacheService), the real in-flight guard, the real timer
 * hook under fake timers, and the real InputbarCore textarea. Only the
 * network/dispatch boundary is mocked (rate limit, upload, thunk), plus
 * heavy service/config seams no renderer test loads for real under jsdom.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const stableModel = { id: 'mock-model', name: 'mock-model' }
  const stableKnowledgeBases: unknown[] = []
  const stableAssistant = { id: 'assistant-1', model: stableModel, knowledge_bases: stableKnowledgeBases }
  return {
    dispatch: vi.fn(),
    checkRateLimit: vi.fn(async (..._args: any[]) => false),
    uploadFiles: vi.fn(async (..._args: any[]) => undefined),
    thunkSendMessage: vi.fn((...args: any[]) => ({ type: 'mock/sendMessage', message: args[0] })),
    getUserMessage: vi.fn((base: Record<string, unknown>) => ({
      message: { ...base, id: 'mock-message-id' },
      blocks: []
    })),
    startTrace: vi.fn((..._args: any[]) => undefined),
    emit: vi.fn(),
    onReanchor: vi.fn(),
    // Stable across renders: the real Inputbar syncs
    // `assistant.knowledge_bases` into provider state in an effect, so a
    // fresh array per render would loop forever.
    stableAssistant,
    stableModel
  }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}))

vi.mock('antd', async (importOriginal) => {
  const actual: any = await importOriginal<any>()
  return {
    ...actual,
    Tooltip: ({ children }: any) => <>{children}</>
  }
})

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: () => undefined
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  sendMessage: (...args: any[]) => mocks.thunkSendMessage(...args)
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: mocks.stableAssistant,
    addTopic: vi.fn(),
    model: mocks.stableModel,
    setModel: vi.fn(),
    updateAssistant: vi.fn(),
    updateAssistantSettings: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    sendMessageShortcut: 'Enter',
    includeHistoryMediaContext: true,
    fontSize: 14,
    pasteLongTextAsFile: false,
    pasteLongTextThreshold: 1500,
    enableSpellCheck: false
  })
}))

vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcut: () => {}
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => ({ pauseMessages: vi.fn() }),
  useTopicLoading: () => false
}))

vi.mock('@renderer/hooks/useRuntime', () => ({
  useRuntime: () => ({ searching: false })
}))

vi.mock('@renderer/pages/home/Inputbar/hooks/usePromptTokenEstimate', () => ({
  usePromptTokenEstimate: () => undefined
}))

// Heavy service/config seams orthogonal to the draft-lifecycle claim. No
// existing renderer test loads the real AssistantService graph (real store,
// i18n, model registry) under jsdom; the send path under test never calls
// these — upload/dispatch are mocked at the network boundary instead.
vi.mock('@renderer/config/models', () => ({
  isAutoEnableImageGenerationModel: () => false,
  isGenerateImageModel: () => false
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultTopic: (assistantId: string) => ({ id: `topic-new-${assistantId}`, name: 'new topic' })
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  ensureOrdinaryTopicOwnership: vi.fn(async () => {})
}))

vi.mock('@renderer/services/TokenService', () => ({
  estimateHistoryTokens: vi.fn(() => ({}))
}))

vi.mock('@renderer/pages/home/Inputbar/hooks/useContextWindowAnchor', () => ({
  useContextWindowAnchor: () => ({ onReanchor: mocks.onReanchor })
}))

vi.mock('@renderer/pages/home/Inputbar/hooks/usePasteHandler', () => ({
  usePasteHandler: () => ({ handlePaste: vi.fn() })
}))

vi.mock('@renderer/pages/home/Inputbar/hooks/useFileDragDrop', () => ({
  useFileDragDrop: () => ({
    handleDragEnter: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
    isDragging: false
  })
}))

vi.mock('@renderer/services/PasteService', () => ({
  default: {
    init: vi.fn(),
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    setLastFocusedComponent: vi.fn(),
    getLastFocusedComponent: () => 'inputbar'
  }
}))

vi.mock('@renderer/services/MessagesService', () => ({
  checkRateLimit: (...args: any[]) => mocks.checkRateLimit(...args),
  getUserMessage: (base: unknown) => mocks.getUserMessage(base as Record<string, unknown>)
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: { uploadFiles: (...args: any[]) => mocks.uploadFiles(...args) }
}))

vi.mock('@renderer/services/SpanManagerService', () => ({
  spanManagerService: { startTrace: (...args: any[]) => mocks.startTrace(...args) }
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    SEND_MESSAGE: 'SEND_MESSAGE',
    ADD_NEW_TOPIC: 'ADD_NEW_TOPIC',
    SHOW_TOPIC_SIDEBAR: 'SHOW_TOPIC_SIDEBAR'
  },
  EventEmitter: { on: vi.fn(() => vi.fn()), emit: (...args: unknown[]) => mocks.emit(...args) }
}))

vi.mock('@renderer/components/TranslateButton', () => ({
  default: () => null
}))

vi.mock('../components/InputbarSettings', () => ({
  default: () => null
}))

vi.mock('../InputbarTools', () => ({
  default: () => null
}))

vi.mock('../../Messages/TopicSegmentDrawer', () => ({
  default: () => null
}))

import { CacheService } from '@renderer/services/CacheService'
import { TopicType } from '@renderer/types'

import Inputbar from '../Inputbar'

const assistantFixture = {
  id: 'assistant-1',
  name: 'assistant-1',
  model: { id: 'mock-model', name: 'mock-model' },
  topics: [],
  knowledge_bases: []
} as any

const topicFixture = (id: string) => ({ id, name: id, type: TopicType.Chat }) as any

const sharedContextInfoFixture = {
  tokenEstimationMessages: [],
  contextCount: 3,
  isAuthoritativePending: false
} as any

function renderInputbar(topicId: string) {
  return render(
    <Inputbar
      assistant={assistantFixture}
      setActiveTopic={vi.fn()}
      topic={topicFixture(topicId)}
      sharedContextInfo={sharedContextInfoFixture}
    />
  )
}

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector('.inputbar textarea')
  expect(textarea).not.toBeNull()
  return textarea as HTMLTextAreaElement
}

async function clickSend() {
  fireEvent.click(screen.getByTestId('send-message-button'))
  await act(async () => {})
}

beforeEach(() => {
  vi.useFakeTimers()
  CacheService.clear()
  mocks.dispatch.mockClear()
  mocks.checkRateLimit.mockClear()
  mocks.uploadFiles.mockClear()
  mocks.thunkSendMessage.mockClear()
  mocks.getUserMessage.mockClear()
  mocks.emit.mockClear()
  ;(window as any).electron = { ipcRenderer: { on: vi.fn(() => vi.fn()) } }
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  delete (window as any).electron
})

describe('Inputbar send-draft lifecycle', () => {
  it('sends the typed draft and keeps text typed afterwards (no delayed clear)', async () => {
    const { container } = renderInputbar('topic-1')
    const textarea = getTextarea(container)

    fireEvent.change(textarea, { target: { value: 'first message' } })
    expect(textarea).toHaveValue('first message')

    await clickSend()

    // The consumed draft is cleared synchronously with the dispatch …
    expect(mocks.getUserMessage).toHaveBeenCalledTimes(1)
    expect(mocks.getUserMessage.mock.calls[0][0]).toMatchObject({ content: 'first message' })
    expect(textarea).toHaveValue('')

    // … and text typed inside the old 500ms window belongs to the next
    // composition: advancing past the window must not wipe it.
    fireEvent.change(textarea, { target: { value: 'follow-up' } })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(textarea).toHaveValue('follow-up')
  })

  it('does not clear a new-route draft with a stale send timer after a topic switch', async () => {
    const { container, rerender } = renderInputbar('topic-1')
    const textarea = getTextarea(container)

    fireEvent.change(textarea, { target: { value: 'topic-1 message' } })
    await clickSend()
    expect(textarea).toHaveValue('')

    // Same instance, new route (Chat renders Inputbar without a topic key).
    rerender(
      <Inputbar
        assistant={assistantFixture}
        setActiveTopic={vi.fn()}
        topic={topicFixture('topic-2')}
        sharedContextInfo={sharedContextInfoFixture}
      />
    )

    fireEvent.change(getTextarea(container), { target: { value: 'topic-2 draft' } })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(getTextarea(container)).toHaveValue('topic-2 draft')
  })

  it('consumes consecutive sends in order without the guard or timers losing text', async () => {
    const { container } = renderInputbar('topic-1')
    const textarea = getTextarea(container)

    fireEvent.change(textarea, { target: { value: 'message A' } })
    await clickSend()
    expect(textarea).toHaveValue('')

    fireEvent.change(textarea, { target: { value: 'message B' } })
    await clickSend()

    expect(mocks.getUserMessage).toHaveBeenCalledTimes(2)
    expect(mocks.getUserMessage.mock.calls[0][0]).toMatchObject({ content: 'message A' })
    expect(mocks.getUserMessage.mock.calls[1][0]).toMatchObject({ content: 'message B' })
    expect(textarea).toHaveValue('')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(textarea).toHaveValue('')
  })

  it('retains the draft when the send fails (existing failure policy)', async () => {
    mocks.uploadFiles.mockRejectedValueOnce(new Error('upload boom'))
    const { container } = renderInputbar('topic-1')
    const textarea = getTextarea(container)

    fireEvent.change(textarea, { target: { value: 'unsent draft' } })
    await clickSend()

    expect(mocks.getUserMessage).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('unsent draft')
  })
})
