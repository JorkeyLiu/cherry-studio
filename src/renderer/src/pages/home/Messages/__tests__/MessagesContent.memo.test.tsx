import fs from 'fs'
import path from 'path'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useEditMode: vi.fn().mockReturnValue({
    isEnabled: false,
    selectedGroupIds: [],
    handleGroupClick: vi.fn()
  }),
  useClipboardKeyboard: vi.fn(),
  useSettings: vi.fn().mockReturnValue({
    showPrompt: false,
    messageNavigation: 'none'
  }),
  useScrollPosition: vi.fn().mockReturnValue({
    containerRef: { current: null },
    handleScroll: vi.fn(),
    getSavedPosition: vi.fn(),
    clearSavedPosition: vi.fn()
  }),
  useAssistant: vi.fn().mockReturnValue({
    addTopic: vi.fn(),
    updateAssistantSettings: vi.fn()
  }),
  useTopicMessages: vi.fn().mockReturnValue([]),
  useMessageOperations: vi.fn().mockReturnValue({
    displayCount: 50,
    clearTopicMessages: vi.fn(),
    deleteMessage: vi.fn(),
    createTopicBranch: vi.fn()
  }),
  useTimer: vi.fn().mockReturnValue({
    setTimeoutTimer: vi.fn()
  }),
  useShortcut: vi.fn(),
  useAppDispatch: vi.fn().mockReturnValue(vi.fn()),
  setTimeoutTimer: vi.fn(),
  getGroupedMessages: vi.fn().mockReturnValue({}),
  getAssistantSettings: vi.fn().mockReturnValue({ contextCount: 100, contextWindowMode: 'sliding' }),
  estimateHistoryTokens: vi.fn().mockResolvedValue(0),
  getContextCount: vi.fn().mockReturnValue({ used: 0, total: 100 }),
  getUserMessage: vi.fn().mockReturnValue({ message: {} }),
  EventEmitter: {
    on: vi.fn(() => vi.fn()),
    emit: vi.fn()
  },
  scrollIntoView: vi.fn(),
  runAsyncFunction: vi.fn().mockResolvedValue(undefined),
  autoRenameTopic: vi.fn(),
  getDefaultTopic: vi.fn().mockReturnValue({ id: 'default-topic', name: 'New Topic' }),
  saveMessageAndBlocksToDB: vi.fn(),
  updateMessageAndBlocksThunk: vi.fn(),
  captureScrollableAsBlob: vi.fn(),
  captureScrollableAsDataURL: vi.fn(),
  removeSpecialCharactersForFileName: vi.fn(),
  updateCodeBlock: vi.fn(),
  getMainTextContent: vi.fn(),
  isTextLikeBlock: vi.fn(),
  last: vi.fn(),
  filterAdjacentUserMessaegs: vi.fn((arr) => arr),
  filterAfterContextClearMessages: vi.fn((arr) => arr),
  filterErrorOnlyMessagesWithRelated: vi.fn((arr) => arr),
  filterLastAssistantMessage: vi.fn((arr) => arr),
  filterUsefulMessages: vi.fn((arr) => arr),
  messageBlocksSelectors: { selectById: vi.fn() },
  updateOneBlock: vi.fn(),
  newMessagesActions: { addMessage: vi.fn() }
}))

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    })
  }
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  EditModeProvider: vi.fn(({ children }: { children: ReactNode }) => <>{children}</>),
  useEditMode: () => mocks.useEditMode()
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => mocks.useAssistant()
}))

vi.mock('@renderer/hooks/useClipboardKeyboard', () => ({
  useClipboardKeyboard: () => mocks.useClipboardKeyboard()
}))

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useMessageOperations: () => mocks.useMessageOperations(),
  useTopicMessages: () => mocks.useTopicMessages()
}))

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => mocks.useScrollPosition()
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => mocks.useSettings()
}))

vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcut: () => mocks.useShortcut()
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => mocks.useTimer()
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  autoRenameTopic: mocks.autoRenameTopic
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: () => mocks.getAssistantSettings(),
  getDefaultTopic: () => mocks.getDefaultTopic()
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: {
    SEND_MESSAGE: 'send-message',
    CLEAR_MESSAGES: 'clear-messages',
    COPY_TOPIC_IMAGE: 'copy-topic-image',
    EXPORT_TOPIC_IMAGE: 'export-topic-image',
    NEW_CONTEXT: 'new-context',
    NEW_BRANCH: 'new-branch',
    EDIT_CODE_BLOCK: 'edit-code-block',
    ESTIMATED_TOKEN_COUNT: 'estimated-token-count'
  },
  EventEmitter: mocks.EventEmitter
}))

vi.mock('@renderer/services/MessagesService', () => ({
  getGroupedMessages: () => mocks.getGroupedMessages(),
  getContextCount: () => mocks.getContextCount(),
  getUserMessage: () => mocks.getUserMessage()
}))

vi.mock('@renderer/services/TokenService', () => ({
  estimateHistoryTokens: () => mocks.estimateHistoryTokens()
}))

vi.mock('@renderer/store', () => ({
  __esModule: true,
  default: { getState: vi.fn().mockReturnValue({ messages: { messageIdsByTopic: {} } }) },
  useAppDispatch: () => mocks.useAppDispatch()
}))

vi.mock('@renderer/store/messageBlock', () => ({
  messageBlocksSelectors: mocks.messageBlocksSelectors,
  updateOneBlock: mocks.updateOneBlock
}))

vi.mock('@renderer/store/newMessage', () => ({
  newMessagesActions: mocks.newMessagesActions
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  saveMessageAndBlocksToDB: mocks.saveMessageAndBlocksToDB,
  updateMessageAndBlocksThunk: mocks.updateMessageAndBlocksThunk
}))

vi.mock('@renderer/utils', () => ({
  captureScrollableAsBlob: mocks.captureScrollableAsBlob,
  captureScrollableAsDataURL: mocks.captureScrollableAsDataURL,
  removeSpecialCharactersForFileName: mocks.removeSpecialCharactersForFileName,
  runAsyncFunction: mocks.runAsyncFunction
}))

vi.mock('@renderer/utils/dom', () => ({
  scrollIntoView: mocks.scrollIntoView
}))

vi.mock('@renderer/utils/markdown', () => ({
  updateCodeBlock: mocks.updateCodeBlock
}))

vi.mock('@renderer/utils/messageUtils/filters', () => ({
  filterAdjacentUserMessaegs: mocks.filterAdjacentUserMessaegs,
  filterAfterContextClearMessages: mocks.filterAfterContextClearMessages,
  filterErrorOnlyMessagesWithRelated: mocks.filterErrorOnlyMessagesWithRelated,
  filterLastAssistantMessage: mocks.filterLastAssistantMessage,
  filterUsefulMessages: mocks.filterUsefulMessages
}))

vi.mock('@renderer/utils/messageUtils/find', () => ({
  getMainTextContent: mocks.getMainTextContent
}))

vi.mock('@renderer/utils/messageUtils/is', () => ({
  isTextLikeBlock: mocks.isTextLikeBlock
}))

vi.mock('lodash', async () => {
  const actual = await import('lodash')
  return { ...actual }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  }),
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  }
}))

vi.mock('react-infinite-scroll-component', () => ({
  default: vi.fn(({ children }: { children: ReactNode }) => <div>{children}</div>)
}))

vi.mock('../MessageAnchorLine', () => ({
  default: vi.fn(() => <div data-testid="message-anchor-line" />)
}))

vi.mock('../MessageGroup', () => ({
  default: vi.fn(() => <div data-testid="message-group" />)
}))

vi.mock('../NarrowLayout', () => ({
  default: vi.fn(({ children }: { children: ReactNode }) => <div>{children}</div>)
}))

vi.mock('../Prompt', () => ({
  default: vi.fn(() => <div data-testid="prompt" />)
}))

vi.mock('../shared', () => {
  const styled = vi.fn(({ children, ...props }: any) => {
    return <div {...props}>{children}</div>
  })
  return {
    MessagesContainer: styled,
    ScrollContainer: styled
  }
})

vi.mock('@renderer/components/ContextMenu', () => ({
  default: vi.fn(({ children }: { children: ReactNode }) => <div>{children}</div>)
}))

vi.mock('@renderer/components/EditModeActionBar', () => ({
  default: vi.fn(() => <div data-testid="edit-mode-action-bar" />)
}))

vi.mock('@renderer/components/Icons', () => ({
  LoadingIcon: vi.fn(() => <div data-testid="loading-icon" />)
}))

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MessagesContent memo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useScrollPosition.mockReturnValue({
      containerRef: { current: null },
      handleScroll: vi.fn(),
      getSavedPosition: vi.fn(),
      clearSavedPosition: vi.fn()
    })
    mocks.useTopicMessages.mockReturnValue([])
    mocks.getGroupedMessages.mockReturnValue({})
  })

  it('MessagesContent is wrapped with React.memo in source code', () => {
    const sourcePath = path.resolve(__dirname, '../Messages.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')

    // Verify that MessagesContent is declared with React.memo
    // Pattern: const MessagesContent = React.memo(function MessagesContent(...) { ... })
    const memoPattern = /const\s+MessagesContent\s*=\s*React\.memo\s*\(/
    expect(source).toMatch(memoPattern)
  })

  it('parent Messages stabilizes assistant with useMemo keyed on id', () => {
    const sourcePath = path.resolve(__dirname, '../Messages.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')

    // Check that useMemo is used for assistant stabilization
    const useMemoAssistantPattern = /useMemo\s*\(\s*\(\)\s*=>\s*assistant\s*,\s*\[\s*assistant\.id\s*\]\s*\)/
    expect(source).toMatch(useMemoAssistantPattern)
  })

  it('parent Messages stabilizes topic with useMemo keyed on id', () => {
    const sourcePath = path.resolve(__dirname, '../Messages.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')

    const useMemoTopicPattern = /useMemo\s*\(\s*\(\)\s*=>\s*topic\s*,\s*\[\s*topic\.id\s*\]\s*\)/
    expect(source).toMatch(useMemoTopicPattern)
  })

  it('parent Messages stabilizes handleScrollPosition with useCallback', () => {
    const sourcePath = path.resolve(__dirname, '../Messages.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')

    const lines = source.split('\n')

    // Find the Messages component
    const messagesStart = lines.findIndex((l) => l.includes('const Messages = ('))
    expect(messagesStart).toBeGreaterThan(-1)

    // Look for useCallback that wraps the raw handleScroll within the Messages component body
    const messagesBody = lines.slice(messagesStart).join('\n')

    // Check that rawHandleScrollPosition (from useScrollPosition) is wrapped with useCallback
    const useCallbackHandleScrollPattern =
      /useCallback\s*\(\s*\(\)\s*=>\s*\{?\s*\n?\s*rawHandleScrollPosition\(\)|useCallback\s*\(\s*\(\)\s*=>\s*rawHandleScrollPosition\b/
    expect(messagesBody).toMatch(useCallbackHandleScrollPattern)
  })

  it('MessagesContent uses stable props (assistant/topic) from parent useMemo', () => {
    const sourcePath = path.resolve(__dirname, '../Messages.tsx')
    const source = fs.readFileSync(sourcePath, 'utf-8')

    // Verify MessagesContent receives stableAssistant and stableTopic
    const usesStableAssistant = source.includes('assistant={stableAssistant}')
    const usesStableTopic = source.includes('topic={stableTopic}')
    expect(usesStableAssistant).toBe(true)
    expect(usesStableTopic).toBe(true)
  })
})
