/**
 * Inputbar generation wiring — production hook wiring proof.
 *
 * The real `Inputbar` component renders here with the full send-draft harness,
 * except the downstream `InputbarCore` is stubbed to capture props. This proves
 * the wiring claim unit tests cannot: `isLoading` follows ONLY the generation
 * hook (`useTopicGenerating`), never the window-read predicate — even with a
 * window read outstanding, the send path stays sendable while generation is
 * idle, and shows stop only while generation is busy.
 */
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    stableAssistant,
    stableModel,
    // Wiring inputs: generation drives isLoading; read-busy must not.
    generating: false,
    readBusy: false
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
  useTopicLoading: () => false,
  useTopicGenerating: () => mocks.generating,
  useTopicWindowReadBusy: () => mocks.readBusy
}))

vi.mock('@renderer/hooks/useRuntime', () => ({
  useRuntime: () => ({ searching: false })
}))

vi.mock('@renderer/pages/home/Inputbar/hooks/usePromptTokenEstimate', () => ({
  usePromptTokenEstimate: () => undefined
}))

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
    handleDrop: vi.fn(),
    isDragging: false
  })
}))

vi.mock('@renderer/services/PasteService', () => ({
  default: {
    init: vi.fn(),
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn()
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

vi.mock('../AttachmentPreview', () => ({
  default: () => null
}))

vi.mock('../../Messages/TopicSegmentDrawer', () => ({
  default: () => null
}))

// Downstream seam only: capture the props the real Inputbar passes down.
vi.mock('../components/InputbarCore', () => ({
  InputbarCore: (props: any) => (
    <div data-testid="inputbar-core-stub" data-loading={String(props.isLoading)} data-text={props.text} />
  )
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

beforeEach(() => {
  CacheService.clear()
  mocks.dispatch.mockClear()
  mocks.generating = false
  mocks.readBusy = false
})

describe('Inputbar generation wiring', () => {
  it('passes generation (not window-read busy) into InputbarCore isLoading', () => {
    // Outstanding window read alone: send path stays sendable.
    mocks.generating = false
    mocks.readBusy = true
    const { container, unmount } = renderInputbar('t1')
    expect(container.querySelector('[data-testid="inputbar-core-stub"]')?.getAttribute('data-loading')).toBe('false')
    unmount()
  })

  it('shows loading only while generation is busy', () => {
    mocks.generating = true
    mocks.readBusy = false
    const { container, unmount } = renderInputbar('t1')
    expect(container.querySelector('[data-testid="inputbar-core-stub"]')?.getAttribute('data-loading')).toBe('true')
    unmount()
  })
})
