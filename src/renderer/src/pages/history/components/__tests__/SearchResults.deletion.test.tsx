import type * as StoreModule from '@renderer/store'
import type * as MessageBlockModule from '@renderer/store/messageBlock'
import type * as NewMessageModule from '@renderer/store/newMessage'
import type { SearchMessagesRequest, SearchMessagesResponse, SearchResultItem } from '@shared/chatDb'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Focused deletion regression for SearchResults around-window navigation.
 *
 * - Verifies that a hard deletion during the in-flight around-window fetch
 *   discards the stale response: no upsertManyBlocks, no messagesReceived,
 *   no onMessageClick navigation.
 * - Preserves normal non-deleted response behavior (blocks/messages staged,
 *   navigation invoked) when no deletion occurs.
 *
 * Uses existing renderer seams only: renderer-owned deletion generation,
 * mocked fetchMessagesWindow, mocked store dispatch. No Main/shared IPC.
 */

// ── Hoisted mocks ──────────────────────────────────────────────────────────
const {
  searchMessagesMock,
  fetchMessagesWindowMock,
  storeDispatchMock,
  storeGetStateMock,
  upsertManyBlocksMock,
  messagesReceivedMock,
  toastErrorMock,
  storeTopicsMap,
  locateTargetMock,
  navigateMock
} = vi.hoisted(() => ({
  searchMessagesMock: vi.fn<(request: SearchMessagesRequest) => Promise<SearchMessagesResponse>>(),
  fetchMessagesWindowMock: vi.fn(),
  storeDispatchMock: vi.fn(),
  storeGetStateMock: vi.fn(() => ({
    messages: { entities: {}, messageIdsByTopic: {}, currentTopicId: null as unknown as string | null },
    messageBlocks: { entities: {} }
  })),
  upsertManyBlocksMock: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: blocks })),
  messagesReceivedMock: vi.fn((payload: unknown) => ({
    type: 'newMessages/messagesReceived',
    payload
  })),
  toastErrorMock: vi.fn(),
  storeTopicsMap: new Map<string, { id: string; name: string }>(),
  locateTargetMock: vi.fn(async () => {}),
  navigateMock: vi.fn()
}))

vi.mock('@renderer/services/db/SqliteMessageDataSource', () => {
  class ChatDbResultError extends Error {
    readonly code: string
    readonly retryable: boolean
    constructor(error: { code: string; message: string; retryable: boolean }) {
      super(error.message)
      this.name = 'ChatDbResultError'
      this.code = error.code
      this.retryable = error.retryable
    }
  }
  class SqliteMessageDataSource {
    searchMessages = searchMessagesMock
  }
  return { ChatDbResultError, SqliteMessageDataSource }
})

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchMessages: vi.fn(),
    fetchMessagesWindow: fetchMessagesWindowMock
  },
  ChatDbResultError: class ChatDbResultError extends Error {
    readonly code: string
    readonly retryable: boolean
    constructor(error: { code: string; message: string; retryable: boolean }) {
      super(error.message)
      this.name = 'ChatDbResultError'
      this.code = error.code
      this.retryable = error.retryable
    }
  },
  SqliteMessageDataSource: class SqliteMessageDataSource {}
}))

vi.mock('@renderer/store', async () => {
  const actual = await vi.importActual<typeof StoreModule>('@renderer/store')
  return {
    ...actual,
    default: {
      dispatch: storeDispatchMock,
      getState: storeGetStateMock,
      subscribe: vi.fn(),
      getStateActual: storeGetStateMock
    } as any
  }
})

vi.mock('@renderer/store/messageBlock', async () => {
  const actual = await vi.importActual<typeof MessageBlockModule>('@renderer/store/messageBlock')
  return { ...actual, upsertManyBlocks: upsertManyBlocksMock }
})

vi.mock('@renderer/store/newMessage', async () => {
  const actual = await vi.importActual<typeof NewMessageModule>('@renderer/store/newMessage')
  return {
    ...actual,
    newMessagesActions: { ...actual.newMessagesActions, messagesReceived: messagesReceivedMock }
  }
})

vi.mock('@renderer/databases', () => ({
  default: {}
}))

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({ handleScroll: vi.fn(), containerRef: { current: null } })
}))

vi.mock('@renderer/i18n', () => ({
  default: {
    t: (k: string) => k,
    use: vi.fn().mockReturnThis(),
    init: vi.fn().mockResolvedValue(undefined),
    isInitialized: true
  }
}))

vi.mock('i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, t: (k: string) => k }
})

vi.mock('@renderer/services/MessagesService', () => ({
  locateToMessageTarget: locateTargetMock,
  locateToMessage: vi.fn()
}))

vi.mock('@renderer/services/NavigationService', () => ({
  default: { navigate: navigateMock, setNavigate: vi.fn() }
}))

vi.mock('@renderer/store/assistants', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, selectTopicsMap: vi.fn(() => storeTopicsMap) }
})

vi.mock('react-redux', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  const useSelectorMock: any = () => storeTopicsMap
  useSelectorMock.withTypes = actual.useSelector.withTypes
  const useDispatchMock: any = actual.useDispatch
  const useStoreMock: any = actual.useStore
  return { ...actual, useSelector: useSelectorMock, useDispatch: useDispatchMock, useStore: useStoreMock }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
    initReactI18next: actual.initReactI18next ?? { type: '3rdParty', init: () => {} }
  }
})

vi.mock('@renderer/components/Icons', () => ({
  LoadingIcon: () => null
}))

vi.mock('antd', () => {
  const List = ({ dataSource, renderItem }: any) => (
    <div data-testid="result-list">
      {(dataSource ?? []).map((entry: any, index: number) => (
        <div key={index} data-testid="result-item">
          {renderItem(entry)}
        </div>
      ))}
    </div>
  )
  List.Item = ({ children }: any) => <div>{children}</div>
  return {
    List,
    Pagination: () => null,
    Segmented: ({ options, value, onChange }: any) => (
      <div>
        {options.map((option: any) => (
          <button
            key={option.value}
            type="button"
            data-testid={`segment-${option.value}`}
            data-active={String(option.value === value)}
            onClick={() => onChange(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    ),
    Spin: ({ children, spinning }: any) => (
      <div data-testid="spin" data-spinning={String(Boolean(spinning))}>
        {children}
      </div>
    ),
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
      Title: ({ children, onClick }: any) => <h5 onClick={onClick}>{children}</h5>
    }
  }
})

// ── Imports after mocks ──────────────────────────────────────────────────
const { default: SearchResults } = await import('../SearchResults')
import {
  bumpDeletionGeneration,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'

// ── Helpers ──────────────────────────────────────────────────────────────
const makeItem = (n: number, topicId = 'topic-1'): SearchResultItem => ({
  blockId: `block-${n}`,
  messageId: `message-${n}`,
  topicId,
  topicName: `Topic ${topicId}`,
  rawContent: `hello content ${n}`,
  messageCreatedAt: '2026-01-01T00:00:00.000Z'
})

const makeResponse = (
  items: SearchResultItem[],
  options: { nextCursor?: string; hasMore?: boolean; totalCount?: number } = {}
): SearchMessagesResponse => ({
  items,
  ...(options.nextCursor !== undefined && { nextCursor: options.nextCursor }),
  hasMore: options.hasMore ?? false,
  totalCount: options.totalCount ?? items.length
})

beforeEach(() => {
  vi.clearAllMocks()
  resetAllDeletionGenerationsForTests()
  storeTopicsMap.clear()
  storeGetStateMock.mockReturnValue({
    messages: { entities: {}, messageIdsByTopic: {}, currentTopicId: null as unknown as string | null },
    messageBlocks: { entities: {} }
  } as any)
  ;(window as any).toast = { error: toastErrorMock }
})

describe('SearchResults direct navigation under deletion (unified navigation)', () => {
  it('hard deletion before hit click fails closed: toast, no locate, no window fetch, no publication', async () => {
    const anchor = makeItem(1, 'topic-1')
    searchMessagesMock.mockResolvedValue(makeResponse([anchor]))
    storeTopicsMap.set('topic-1', { id: 'topic-1', name: 'Topic topic-1', assistantId: 'assistant-1' } as any)
    storeGetStateMock.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
      messageBlocks: { entities: {} }
    } as any)

    const onMessageClick = vi.fn()
    const onTopicClick = vi.fn()
    render(<SearchResults keywords="hello" onMessageClick={onMessageClick} onTopicClick={onTopicClick} />)

    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
    // Simulate hard deletion of the topic after results render, before hit click
    bumpDeletionGeneration('topic-1')

    fireEvent.click(screen.getByText('hello'))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found'))
    expect(locateTargetMock).not.toHaveBeenCalled()
    expect(onMessageClick).not.toHaveBeenCalled()
    // SearchResults never fetches/publishes windows; complement lives in Messages.
    expect(fetchMessagesWindowMock).not.toHaveBeenCalled()
    expect(upsertManyBlocksMock).not.toHaveBeenCalled()
    expect(messagesReceivedMock).not.toHaveBeenCalled()
  })

  it('missing topic in the store map fails closed without locate', async () => {
    const anchor = makeItem(1, 'topic-missing')
    searchMessagesMock.mockResolvedValue(makeResponse([anchor]))
    // No storeTopicsMap entry for topic-missing.
    storeGetStateMock.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: {}, currentTopicId: 'topic-missing' },
      messageBlocks: { entities: {} }
    } as any)

    const onMessageClick = vi.fn()
    render(<SearchResults keywords="hello" onMessageClick={onMessageClick} onTopicClick={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
    fireEvent.click(screen.getByText('hello'))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found'))
    expect(locateTargetMock).not.toHaveBeenCalled()
    expect(onMessageClick).not.toHaveBeenCalled()
    expect(fetchMessagesWindowMock).not.toHaveBeenCalled()
  })

  it('non-deleted hit navigates directly via the stable target; no preview or publication here', async () => {
    const anchor = makeItem(1, 'topic-1')
    searchMessagesMock.mockResolvedValue(makeResponse([anchor]))
    storeTopicsMap.set('topic-1', { id: 'topic-1', name: 'Topic topic-1', assistantId: 'assistant-1' } as any)
    storeGetStateMock.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
      messageBlocks: { entities: {} }
    } as any)

    const onMessageClick = vi.fn()
    render(<SearchResults keywords="hello" onMessageClick={onMessageClick} onTopicClick={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
    fireEvent.click(screen.getByText('hello'))

    await waitFor(() => expect(locateTargetMock).toHaveBeenCalledTimes(1))
    expect(locateTargetMock).toHaveBeenCalledWith(navigateMock, {
      topicId: 'topic-1',
      messageId: 'message-1',
      assistantId: 'assistant-1'
    })
    expect(onMessageClick).not.toHaveBeenCalled()
    expect(fetchMessagesWindowMock).not.toHaveBeenCalled()
    expect(upsertManyBlocksMock).not.toHaveBeenCalled()
    expect(messagesReceivedMock).not.toHaveBeenCalled()
  })
})
