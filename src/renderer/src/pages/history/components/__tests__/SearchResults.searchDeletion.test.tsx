import type * as StoreModule from '@renderer/store'
import type { SearchMessagesRequest, SearchMessagesResponse, SearchResultItem } from '@shared/chatDb'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Focused deletion invalidation for searchMessages pages (LOCK-004).
 * - Deletion during in-flight searchMessages fetch: no stale page/snippet publication, precise filtering.
 * - Already-loaded deleted-topic results being removed/hidden while preserving other topics.
 * - Normal multi-topic search behavior preserved.
 */

const {
  searchMessagesMock,
  fetchMessagesWindowMock,
  storeDispatchMock,
  storeGetStateMock,
  upsertManyBlocksMock,
  messagesReceivedMock,
  toastErrorMock,
  storeTopicsMap
} = vi.hoisted(() => ({
  searchMessagesMock: vi.fn<(request: SearchMessagesRequest) => Promise<SearchMessagesResponse>>(),
  fetchMessagesWindowMock: vi.fn(),
  storeDispatchMock: vi.fn(),
  storeGetStateMock: vi.fn(() => ({
    messages: { entities: {}, messageIdsByTopic: {}, currentTopicId: null as unknown as string | null },
    messageBlocks: { entities: {} }
  })),
  upsertManyBlocksMock: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: blocks })),
  messagesReceivedMock: vi.fn((payload: unknown) => ({ type: 'newMessages/messagesReceived', payload })),
  toastErrorMock: vi.fn(),
  storeTopicsMap: new Map<string, { id: string; name: string }>()
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
  dbService: { fetchMessagesWindow: fetchMessagesWindowMock },
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
  const actual = await vi.importActual<any>('@renderer/store/messageBlock')
  return { ...actual, upsertManyBlocks: upsertManyBlocksMock }
})

vi.mock('@renderer/store/newMessage', async () => {
  const actual = await vi.importActual<any>('@renderer/store/newMessage')
  return { ...actual, newMessagesActions: { ...actual.newMessagesActions, messagesReceived: messagesReceivedMock } }
})

vi.mock('@renderer/databases', () => ({ default: {} }))
vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({ handleScroll: vi.fn(), containerRef: { current: null } })
}))
vi.mock('@renderer/store/assistants', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, selectTopicsMap: vi.fn(() => storeTopicsMap) }
})
vi.mock('react-redux', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  const useSelectorMock: any = () => storeTopicsMap
  useSelectorMock.withTypes = actual.useSelector.withTypes
  return { ...actual, useSelector: useSelectorMock }
})
vi.mock('react-i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
    initReactI18next: actual.initReactI18next ?? { type: '3rdParty', init: () => {} }
  }
})
vi.mock('@renderer/components/Icons', () => ({ LoadingIcon: () => null }))
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

const { default: SearchResults } = await import('../SearchResults')
import {
  bumpDeletionGeneration,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'

const makeItem = (n: number, topicId = 'topic-1'): SearchResultItem => ({
  blockId: `block-${n}`,
  messageId: `message-${n}`,
  topicId,
  topicName: `Topic ${topicId}`,
  rawContent: `hello content ${n} topic ${topicId}`,
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
    messages: { entities: {}, messageIdsByTopic: {}, currentTopicId: null },
    messageBlocks: { entities: {} }
  } as any)
  ;(window as any).toast = { error: toastErrorMock }
})

describe('SearchResults deletion-generation aware search publication', () => {
  it('deletion during in-flight searchMessages fetch discards stale page — no snippet publication for deleted topic, multi-topic preserved', async () => {
    let resolveSearch!: (v: SearchMessagesResponse) => void
    const deferred = new Promise<SearchMessagesResponse>((res) => (resolveSearch = res))
    searchMessagesMock.mockReturnValueOnce(deferred)

    render(<SearchResults keywords="hello" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)
    // Allow effect to start and capture deletion snapshot (generation 0)
    await new Promise((r) => setTimeout(r, 0))
    expect(searchMessagesMock).toHaveBeenCalledTimes(1)

    // Hard delete topic-1 during in-flight fetch
    bumpDeletionGeneration('topic-1')

    // Response contains mixed topics: topic-1 (deleted) and topic-2 (alive)
    const mixedItems = [makeItem(1, 'topic-1'), makeItem(2, 'topic-2'), makeItem(3, 'topic-1')]
    resolveSearch(makeResponse(mixedItems, { totalCount: 3 }))

    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
    // Only topic-2 item should be visible; topic-1 snippets removed
    expect(screen.getByText(/topic topic-2/)).toBeInTheDocument()
    expect(screen.queryByText(/topic topic-1/)).not.toBeInTheDocument()
    // Ensure the displayed item is the non-deleted one
    expect(screen.getByText('Topic topic-2')).toBeInTheDocument()
    expect(screen.queryByText('Topic topic-1')).not.toBeInTheDocument()
  })

  it('entire page stale (all items deleted topic) is discarded — no publication', async () => {
    let resolveSearch!: (v: SearchMessagesResponse) => void
    const deferred = new Promise<SearchMessagesResponse>((res) => (resolveSearch = res))
    searchMessagesMock.mockReturnValueOnce(deferred)

    render(<SearchResults keywords="hello" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)
    await new Promise((r) => setTimeout(r, 0))

    bumpDeletionGeneration('topic-1')
    resolveSearch(makeResponse([makeItem(1, 'topic-1'), makeItem(2, 'topic-1')], { totalCount: 2 }))

    // Need to wait a tick for the stale discard to settle — no items should appear
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryAllByTestId('result-item')).toHaveLength(0)
  })

  it('already-loaded deleted-topic search results are removed/hidden while other topics preserved', async () => {
    // Initial load with two topics
    const initialItems = [makeItem(1, 'topic-1'), makeItem(2, 'topic-2')]
    searchMessagesMock.mockResolvedValueOnce(makeResponse(initialItems, { totalCount: 2 }))

    render(<SearchResults keywords="hello" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(2))
    expect(screen.getByText('Topic topic-1')).toBeInTheDocument()
    expect(screen.getByText('Topic topic-2')).toBeInTheDocument()

    // Hard delete topic-1 after load — retained page should prune topic-1 items
    bumpDeletionGeneration('topic-1')

    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
    expect(screen.queryByText('Topic topic-1')).not.toBeInTheDocument()
    expect(screen.getByText('Topic topic-2')).toBeInTheDocument()
  })

  it('preserves normal non-deleted multi-topic search behavior', async () => {
    const items = [makeItem(1, 'topic-1'), makeItem(2, 'topic-2'), makeItem(3, 'topic-3')]
    searchMessagesMock.mockResolvedValueOnce(makeResponse(items, { totalCount: 3 }))

    render(<SearchResults keywords="hello" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(3))
    expect(screen.getByText('Topic topic-1')).toBeInTheDocument()
    expect(screen.getByText('Topic topic-2')).toBeInTheDocument()
    expect(screen.getByText('Topic topic-3')).toBeInTheDocument()
  })

  it('soft-delete (no generation bump) preserves search results — no pruning', async () => {
    const items = [makeItem(1, 'topic-1')]
    searchMessagesMock.mockResolvedValueOnce(makeResponse(items))
    render(<SearchResults keywords="hello" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
    expect(screen.getByText('Topic topic-1')).toBeInTheDocument()
    // No bumpDeletionGeneration — simulating soft delete — nothing should be removed
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.getAllByTestId('result-item')).toHaveLength(1)
  })
})
