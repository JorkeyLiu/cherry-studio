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
    selectActiveBranchId: vi.fn((): string | null => null),
    selectRouteGeneration: vi.fn((): number => 0),
    storeGetState: vi.fn(() => ({}) as any),
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
  default: { getState: (...args: any[]) => (mocks.storeGetState as any)(...args), dispatch: mocks.dispatch },
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: () => undefined
}))
vi.mock('@renderer/store/topicBranch', () => ({
  selectActiveBranchId: (...args: any[]) => (mocks.selectActiveBranchId as any)(...args),
  selectRouteGeneration: (...args: any[]) => (mocks.selectRouteGeneration as any)(...args)
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

vi.mock('../InputbarTools', async () => {
  const provider = await import('../context/InputbarToolsProvider')
  const React = await import('react')
  const probeFile = {
    id: 'probe-file-1',
    name: 'probe.txt',
    origin_name: 'probe.txt',
    size: 10,
    ext: '.txt',
    type: 'document'
  }
  return {
    default: () => {
      const { setFiles } = provider.useInputbarToolsDispatch()
      return React.createElement(
        'button',
        { 'data-testid': 'probe-add-file', onClick: () => setFiles((prev: any[]) => [...prev, probeFile]) },
        'add-file'
      )
    }
  }
})
// AttachmentPreview renders file names through FileManager formatting, a
// heavy seam orthogonal to the draft claim: render names plainly instead.
vi.mock('../AttachmentPreview', () => ({
  default: ({ files }: any) => (
    <>
      {(files ?? []).map((file: any) => (
        <span key={file.id}>{file.name}</span>
      ))}
    </>
  )
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
  isAuthoritativePending: false,
  blockSnapshot: new Map()
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
  mocks.selectActiveBranchId.mockClear()
  mocks.selectRouteGeneration.mockClear()
  mocks.storeGetState.mockClear()
  mocks.dispatch.mockResolvedValue({ accepted: true } as any)
  mocks.checkRateLimit.mockResolvedValue(false as any)
  mocks.uploadFiles.mockResolvedValue(undefined as any)
  mocks.selectActiveBranchId.mockReturnValue(null)
  mocks.selectRouteGeneration.mockReturnValue(0)
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
  describe('Inputbar send handover (route pin plus conditional consume)', () => {
    it('(a) pins the route before any await: a mid-preparation switch cannot move the write address', async () => {
      let resolveCheck: ((blocked: boolean) => void) | undefined
      mocks.checkRateLimit.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveCheck = resolve
          })
      )
      const { container } = renderInputbar('topic-1')
      const textarea = getTextarea(container)
      fireEvent.change(textarea, { target: { value: 'pinned message' } })
      fireEvent.click(screen.getByTestId('send-message-button'))
      await act(async () => {})
      // Branch switch lands while the rate-limit read is still in flight.
      mocks.selectActiveBranchId.mockReturnValue('b1')
      mocks.selectRouteGeneration.mockReturnValue(1)
      resolveCheck!(false)
      await act(async () => {})
      await act(async () => {})
      // Rate-limit and thunk share the pre-await pin (main route, generation 0).
      expect(mocks.checkRateLimit.mock.calls[0][2]).toBeNull()
      expect(mocks.thunkSendMessage).toHaveBeenCalledTimes(1)
      expect(mocks.thunkSendMessage.mock.calls[0][4]).toEqual({ route: null, generation: 0 })
      expect(mocks.getUserMessage.mock.calls[0][0]).toMatchObject({ content: 'pinned message' })
      expect(textarea).toHaveValue('')
    })
    it('(b) ABA edit during preparation is retained while the original snapshot is sent', async () => {
      let resolveUpload: ((files: undefined) => void) | undefined
      mocks.uploadFiles.mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            resolveUpload = resolve
          })
      )
      const { container } = renderInputbar('topic-1')
      const textarea = getTextarea(container)
      fireEvent.change(textarea, { target: { value: 'hello' } })
      fireEvent.click(screen.getByTestId('send-message-button'))
      await act(async () => {})
      // New composition during preparation, ending on text equal to the snapshot.
      fireEvent.change(textarea, { target: { value: 'hello world' } })
      fireEvent.change(textarea, { target: { value: 'hello' } })
      resolveUpload!(undefined)
      await act(async () => {})
      await act(async () => {})
      expect(mocks.getUserMessage.mock.calls[0][0]).toMatchObject({ content: 'hello' })
      expect(textarea).toHaveValue('hello')
    })
    it('(c) attachment added during preparation is retained while the original snapshot is sent', async () => {
      let resolveUpload: ((files: undefined) => void) | undefined
      mocks.uploadFiles.mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            resolveUpload = resolve
          })
      )
      const { container } = renderInputbar('topic-1')
      const textarea = getTextarea(container)
      fireEvent.change(textarea, { target: { value: 'with later attachment' } })
      fireEvent.click(screen.getByTestId('send-message-button'))
      await act(async () => {})
      fireEvent.click(screen.getByTestId('probe-add-file'))
      resolveUpload!(undefined)
      await act(async () => {})
      await act(async () => {})
      expect(mocks.getUserMessage.mock.calls[0][0]).not.toHaveProperty('files')
      expect(screen.getByText('probe.txt')).not.toBeNull()
      expect(textarea).toHaveValue('')
    })
    it('(d) unreceived handover retains the draft, accepted handover consumes it', async () => {
      const { container } = renderInputbar('topic-1')
      const textarea = getTextarea(container)
      fireEvent.change(textarea, { target: { value: 'kept draft' } })
      // Focusing the textarea dispatches runtime/setSearching, so queue the
      // handover result only after that focus dispatch has already run.
      mocks.dispatch.mockClear()
      mocks.dispatch.mockResolvedValueOnce({ accepted: false } as any)
      fireEvent.click(screen.getByTestId('send-message-button'))
      await act(async () => {})
      await act(async () => {})
      expect(mocks.thunkSendMessage).toHaveBeenCalledTimes(1)
      expect(textarea).toHaveValue('kept draft')
      mocks.dispatch.mockResolvedValueOnce({ accepted: true } as any)
      fireEvent.click(screen.getByTestId('send-message-button'))
      await act(async () => {})
      await act(async () => {})
      expect(mocks.thunkSendMessage).toHaveBeenCalledTimes(2)
      expect(textarea).toHaveValue('')
    })
    it('(e) handover waits for admission not stream: no sync clear, guard serializes rapid sends', async () => {
      let resolveDispatch: ((result: unknown) => void) | undefined
      const { container } = renderInputbar('topic-1')
      const textarea = getTextarea(container)
      fireEvent.change(textarea, { target: { value: 'first' } })
      // Same focus-dispatch ordering as (d): queue the pending handover after it.
      mocks.dispatch.mockClear()
      mocks.dispatch.mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            resolveDispatch = resolve
          })
      )
      fireEvent.click(screen.getByTestId('send-message-button'))
      await act(async () => {})
      // Admission still pending: nothing cleared yet, second activation is refused.
      expect(textarea).toHaveValue('first')
      fireEvent.click(screen.getByTestId('send-message-button'))
      await act(async () => {})
      expect(mocks.thunkSendMessage).toHaveBeenCalledTimes(1)
      resolveDispatch!({ accepted: true })
      await act(async () => {})
      await act(async () => {})
      expect(mocks.thunkSendMessage).toHaveBeenCalledTimes(1)
      expect(textarea).toHaveValue('')
      fireEvent.change(textarea, { target: { value: 'second' } })
      fireEvent.click(screen.getByTestId('send-message-button'))
      await act(async () => {})
      await act(async () => {})
      expect(mocks.thunkSendMessage).toHaveBeenCalledTimes(2)
      expect(textarea).toHaveValue('')
    })
  })
})
