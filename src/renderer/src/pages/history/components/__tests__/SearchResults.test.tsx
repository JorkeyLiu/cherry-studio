import type * as StoreModule from '@renderer/store'
import type * as MessageBlockModule from '@renderer/store/messageBlock'
import type * as NewMessageModule from '@renderer/store/newMessage'
import type { SearchMessagesRequest, SearchMessagesResponse, SearchResultItem } from '@shared/chatDb'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 5.2A — SearchResults SQLite migration tests.
 *
 * Covers:
 * - request mapping: keywords/matchMode/sortOrder/pageSize=10, no cursor on first page
 * - structured error surfaces visibly, no Dexie fallback, no retry
 * - cursor-driven pagination: page cache, no synthesized cursors, and the
 *   LOCK-003 constraint that only cached pages plus the single next
 *   cursor-reachable page are navigable (no distant uncached jumps)
 * - keywords/matchMode/sortOrder changes reset to first page, invalidate
 *   stale responses, and (LOCK-001) start the new first-page request without
 *   waiting for an obsolete generation's pending request
 * - matching options and order flow into the request
 * - navigation callbacks resolve Message/Topic objects for compatibility only
 */

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  searchMessagesMock,
  dbServiceFetchMock,
  fetchMessagesWindowMock,
  storeDispatchMock,
  storeGetStateMock,
  upsertManyBlocksMock,
  messagesReceivedMock,
  toastErrorMock,
  storeTopicsMap
} = vi.hoisted(() => ({
  searchMessagesMock: vi.fn<(request: SearchMessagesRequest) => Promise<SearchMessagesResponse>>(),
  dbServiceFetchMock: vi.fn(),
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
  dbService: {
    fetchMessages: dbServiceFetchMock,
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
    Pagination: ({ current, pageSize, total, onChange, hideOnSinglePage }: any) => {
      const pageCount = Math.ceil((total ?? 0) / (pageSize || 10))
      if (hideOnSinglePage && pageCount <= 1) return null
      return (
        <div data-testid="pagination" data-current={String(current)}>
          {Array.from({ length: pageCount }, (_, i) => (
            <button key={i} type="button" data-testid={`page-${i + 1}`} onClick={() => onChange(i + 1, pageSize)}>
              {i + 1}
            </button>
          ))}
          {/* Simulates a programmatic/out-of-band onChange with a page the UI never offers. */}
          <button
            type="button"
            data-testid="page-out-of-range"
            onClick={() => onChange(pageCount + 5, pageSize)}></button>
        </div>
      )
    },
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

// ── Imports (after mocks) ──────────────────────────────────────────────────

const { default: SearchResults } = await import('../SearchResults')
const { ChatDbResultError } = await import('@renderer/services/db/SqliteMessageDataSource')

// ── Helpers ────────────────────────────────────────────────────────────────

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

type Deferred = {
  promise: Promise<SearchMessagesResponse>
  resolve: (value: SearchMessagesResponse) => void
  reject: (reason: unknown) => void
}

const makeDeferred = (): Deferred => {
  let resolve!: (value: SearchMessagesResponse) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<SearchMessagesResponse>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const renderComponent = (keywords = 'hello') => {
  const onMessageClick = vi.fn()
  const onTopicClick = vi.fn()
  const utils = render(
    <SearchResults keywords={keywords} onMessageClick={onMessageClick} onTopicClick={onTopicClick} />
  )
  return { ...utils, onMessageClick, onTopicClick }
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  storeTopicsMap.clear()
  storeGetStateMock.mockReturnValue({
    messages: { entities: {}, messageIdsByTopic: {}, currentTopicId: null as unknown as string | null },
    messageBlocks: { entities: {} }
  } as any)
  ;(window as any).toast = { error: toastErrorMock }
})

describe('SearchResults (SQLite search)', () => {
  describe('request mapping', () => {
    it('sends exact first-page request: keywords/matchMode/sortOrder/pageSize=10, no cursor', async () => {
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)]))
      renderComponent('hello world')

      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledOnce())
      expect(searchMessagesMock).toHaveBeenCalledWith({
        keywords: 'hello world',
        matchMode: 'whole-word',
        sortOrder: 'newest',
        pageSize: 10
      })
      expect('cursor' in searchMessagesMock.mock.calls[0][0]).toBe(false)
    })

    it('does not issue a request for empty keywords', async () => {
      renderComponent('')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(searchMessagesMock).not.toHaveBeenCalled()
    })

    it('renders results with snippet and topic name from the SQLite response', async () => {
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)]))
      renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      expect(screen.getByText('Topic topic-1')).toBeInTheDocument()
      // Snippet built from rawContent with keyword highlighted
      expect(screen.getByText('hello')).toBeInTheDocument()
    })
  })

  describe('matching options and order', () => {
    it('substring mode change issues a new first-page request with matchMode=substring', async () => {
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)]))
      renderComponent('hello')
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledOnce())

      fireEvent.click(screen.getByTestId('segment-substring'))

      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(2))
      expect(searchMessagesMock.mock.calls[1][0]).toEqual({
        keywords: 'hello',
        matchMode: 'substring',
        sortOrder: 'newest',
        pageSize: 10
      })
    })

    it('sort order change issues a new first-page request with sortOrder=oldest', async () => {
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)]))
      renderComponent('hello')
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledOnce())

      fireEvent.click(screen.getByTestId('segment-oldest'))

      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(2))
      expect(searchMessagesMock.mock.calls[1][0]).toEqual({
        keywords: 'hello',
        matchMode: 'whole-word',
        sortOrder: 'oldest',
        pageSize: 10
      })
      expect('cursor' in searchMessagesMock.mock.calls[1][0]).toBe(false)
    })
  })

  describe('structured error, no fallback', () => {
    it('surfaces structured search failure visibly with code and message', async () => {
      searchMessagesMock.mockRejectedValue(
        new ChatDbResultError({ code: 'SEARCH_ERROR', message: 'fts unavailable', retryable: false })
      )
      renderComponent('hello')

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      expect(screen.getByText('history.search.error')).toBeInTheDocument()
      expect(screen.getByText(/\[SEARCH_ERROR\]\s*fts unavailable/)).toBeInTheDocument()
    })

    it('does not fall back to Dexie and does not retry on failure', async () => {
      searchMessagesMock.mockRejectedValue(
        new ChatDbResultError({ code: 'SEARCH_ERROR', message: 'boom', retryable: false })
      )
      renderComponent('hello')

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      expect(searchMessagesMock).toHaveBeenCalledOnce()
      expect(dbServiceFetchMock).not.toHaveBeenCalled()
      expect(screen.queryAllByTestId('result-item')).toHaveLength(0)
    })

    it('surfaces transport errors as well (no silent empty result)', async () => {
      searchMessagesMock.mockRejectedValue(new Error('IPC transport failed'))
      renderComponent('hello')

      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      expect(screen.getByText('IPC transport failed')).toBeInTheDocument()
    })
  })

  describe('pagination and cursor behavior', () => {
    it('fetches page 2 with the opaque cursor from page 1 and caches visited pages', async () => {
      const page1 = Array.from({ length: 10 }, (_, i) => makeItem(i))
      const page2 = Array.from({ length: 10 }, (_, i) => makeItem(10 + i))
      searchMessagesMock
        .mockResolvedValueOnce(makeResponse(page1, { nextCursor: 'cursor-1', hasMore: true, totalCount: 25 }))
        .mockResolvedValueOnce(makeResponse(page2, { nextCursor: 'cursor-2', hasMore: true, totalCount: 25 }))
      renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(10))

      fireEvent.click(screen.getByTestId('page-2'))
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(2))
      expect(searchMessagesMock.mock.calls[1][0]).toEqual({
        keywords: 'hello',
        matchMode: 'whole-word',
        sortOrder: 'newest',
        pageSize: 10,
        cursor: 'cursor-1'
      })
      await waitFor(() => expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '2'))

      // Going back to page 1 uses the cache — no additional request.
      fireEvent.click(screen.getByTestId('page-1'))
      await waitFor(() => expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '1'))
      expect(searchMessagesMock).toHaveBeenCalledTimes(2)

      // Returning to page 2 also uses the cache.
      fireEvent.click(screen.getByTestId('page-2'))
      await waitFor(() => expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '2'))
      expect(searchMessagesMock).toHaveBeenCalledTimes(2)
    })

    it('LOCK-003: exposes only cached pages plus one next reachable page; page 3 is reached step by step', async () => {
      const page1 = Array.from({ length: 10 }, (_, i) => makeItem(i))
      const page2 = Array.from({ length: 10 }, (_, i) => makeItem(10 + i))
      const page3 = Array.from({ length: 5 }, (_, i) => makeItem(20 + i))
      searchMessagesMock
        .mockResolvedValueOnce(makeResponse(page1, { nextCursor: 'cursor-1', hasMore: true, totalCount: 25 }))
        .mockResolvedValueOnce(makeResponse(page2, { nextCursor: 'cursor-2', hasMore: true, totalCount: 25 }))
        .mockResolvedValueOnce(makeResponse(page3, { hasMore: false, totalCount: 25 }))
      renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(10))

      // Despite server totalCount=25, only the cached page and the single
      // next cursor-reachable page are offered — no distant page 3 button.
      expect(screen.getByTestId('page-2')).toBeInTheDocument()
      expect(screen.queryByTestId('page-3')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('page-2'))
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(2))
      expect(searchMessagesMock.mock.calls[1][0].cursor).toBe('cursor-1')
      await waitFor(() => expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '2'))

      // Page 3 becomes reachable only now that page 2 is cached.
      await waitFor(() => expect(screen.getByTestId('page-3')).toBeInTheDocument())
      fireEvent.click(screen.getByTestId('page-3'))
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(3))
      expect(searchMessagesMock.mock.calls[2][0].cursor).toBe('cursor-2')

      // Page 3 shows exactly the 5 items from the third server page —
      // no omissions, no duplicates.
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(5))
      expect(screen.getByText(/content 20/)).toBeInTheDocument()
    })

    it('LOCK-003: a programmatic distant uncached page change is rejected — no IPC, no page change', async () => {
      const page1 = Array.from({ length: 10 }, (_, i) => makeItem(i))
      searchMessagesMock.mockResolvedValueOnce(
        makeResponse(page1, { nextCursor: 'cursor-1', hasMore: true, totalCount: 55 })
      )
      renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(10))
      expect(searchMessagesMock).toHaveBeenCalledOnce()

      // onChange invoked with a page far beyond the cached+next window.
      fireEvent.click(screen.getByTestId('page-out-of-range'))
      await new Promise((resolve) => setTimeout(resolve, 0))

      // No cursor-page waterfall is triggered and the current page is unchanged.
      expect(searchMessagesMock).toHaveBeenCalledOnce()
      expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '1')
      expect(screen.getAllByTestId('result-item')).toHaveLength(10)
    })

    it('reaches page 2 with the exact server cursor when totalCount=0 but hasMore=true (best-effort total)', async () => {
      const page1 = Array.from({ length: 10 }, (_, i) => makeItem(i))
      const page2 = Array.from({ length: 3 }, (_, i) => makeItem(10 + i))
      searchMessagesMock
        .mockResolvedValueOnce(makeResponse(page1, { nextCursor: 'cursor-1', hasMore: true, totalCount: 0 }))
        .mockResolvedValueOnce(makeResponse(page2, { hasMore: false, totalCount: 0 }))
      renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(10))

      // Pagination must expose page 2 despite the best-effort totalCount=0.
      expect(screen.getByTestId('pagination')).toBeInTheDocument()
      expect(screen.getByTestId('page-2')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('page-2'))
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(2))
      // The exact server-returned cursor is forwarded — never synthesized.
      expect(searchMessagesMock.mock.calls[1][0]).toEqual({
        keywords: 'hello',
        matchMode: 'whole-word',
        sortOrder: 'newest',
        pageSize: 10,
        cursor: 'cursor-1'
      })
      await waitFor(() => expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '2'))
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(3))
      // End reached: derived total settles on the 13 cached items (2 pages),
      // no phantom third page.
      expect(screen.queryByTestId('page-3')).not.toBeInTheDocument()
    })

    it('hides pagination for a single page of results', async () => {
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)], { totalCount: 1 }))
      renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      expect(screen.queryByTestId('pagination')).not.toBeInTheDocument()
    })
  })

  describe('pagination error recovery', () => {
    it('clears a stale page-fetch error after cached navigation and a successful exact-cursor retry', async () => {
      const page1 = Array.from({ length: 10 }, (_, i) => makeItem(i))
      const page2 = Array.from({ length: 10 }, (_, i) => makeItem(10 + i))
      searchMessagesMock
        .mockResolvedValueOnce(makeResponse(page1, { nextCursor: 'cursor-1', hasMore: true, totalCount: 25 }))
        .mockRejectedValueOnce(
          new ChatDbResultError({ code: 'SEARCH_ERROR', message: 'page 2 failed', retryable: true })
        )
        .mockResolvedValueOnce(makeResponse(page2, { nextCursor: 'cursor-2', hasMore: true, totalCount: 25 }))
      renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(10))
      expect(screen.getByText(/Found 25 results/)).toBeInTheDocument()

      // Page 2 fetch fails — alert shows and the stats line disappears.
      fireEvent.click(screen.getByTestId('page-2'))
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      expect(screen.getByText(/\[SEARCH_ERROR\]\s*page 2 failed/)).toBeInTheDocument()
      expect(screen.queryByText(/Found 25 results/)).not.toBeInTheDocument()
      expect(searchMessagesMock).toHaveBeenCalledTimes(2)

      // Back to cached page 1 — no request, and no optimistic error clear.
      fireEvent.click(screen.getByTestId('page-1'))
      await waitFor(() => expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '1'))
      expect(searchMessagesMock).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('alert')).toBeInTheDocument()

      // Retry page 2 — the exact same server cursor is forwarded again.
      fireEvent.click(screen.getByTestId('page-2'))
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(3))
      expect(searchMessagesMock.mock.calls[1][0].cursor).toBe('cursor-1')
      expect(searchMessagesMock.mock.calls[2][0].cursor).toBe('cursor-1')

      // Success clears the stale alert, shows page 2 results, restores stats.
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(10))
      expect(screen.getByText(/content 10/)).toBeInTheDocument()
      expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '2')
      expect(screen.getByText(/Found 25 results/)).toBeInTheDocument()
    })

    it('LOCK-002: a stale generation success cannot clear the active generation error', async () => {
      const oldRequest = makeDeferred()
      searchMessagesMock
        .mockReturnValueOnce(oldRequest.promise)
        .mockRejectedValueOnce(
          new ChatDbResultError({ code: 'SEARCH_ERROR', message: 'active failed', retryable: true })
        )

      const { rerender } = renderComponent('old-keywords')
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledOnce())

      rerender(<SearchResults keywords="new-keywords" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      expect(screen.getByText(/active failed/)).toBeInTheDocument()

      // Obsolete generation succeeds late — the active error must remain.
      oldRequest.resolve(makeResponse([makeItem(1)], { totalCount: 1 }))
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/active failed/)).toBeInTheDocument()
      expect(screen.queryAllByTestId('result-item')).toHaveLength(0)
    })
  })

  describe('stale response safety', () => {
    it('a late response from an old keywords search cannot overwrite the new search state', async () => {
      const firstRequest = makeDeferred()
      const secondRequest = makeDeferred()
      searchMessagesMock.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(secondRequest.promise)

      const { rerender, onMessageClick, onTopicClick } = renderComponent('old-keywords')
      void onMessageClick
      void onTopicClick
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledOnce())

      rerender(<SearchResults keywords="new-keywords" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)

      // Old response arrives late — must be discarded.
      firstRequest.resolve(
        makeResponse([{ ...makeItem(99), rawContent: 'stale old-keywords result' }], { totalCount: 1 })
      )
      // New response arrives after the old one.
      secondRequest.resolve(
        makeResponse([{ ...makeItem(1), rawContent: 'fresh new-keywords result' }], { totalCount: 1 })
      )

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
      expect(screen.getByText(/fresh/)).toBeInTheDocument()
      expect(searchMessagesMock).toHaveBeenCalledTimes(2)
      expect(searchMessagesMock.mock.calls[1][0].keywords).toBe('new-keywords')
    })

    it('LOCK-001: a new generation fires its first-page request before the old deferred request settles, and the obsolete completion mutates nothing', async () => {
      const oldRequest = makeDeferred()
      const newRequest = makeDeferred()
      searchMessagesMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)

      const { rerender } = renderComponent('old-keywords')
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledOnce())

      rerender(<SearchResults keywords="new-keywords" onMessageClick={vi.fn()} onTopicClick={vi.fn()} />)

      // The new generation's request is issued while the old request is
      // still pending — it is not queued behind the obsolete generation.
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(2))
      expect(searchMessagesMock.mock.calls[1][0].keywords).toBe('new-keywords')

      // New generation settles first with a single short page.
      newRequest.resolve(makeResponse([{ ...makeItem(1), rawContent: 'fresh new-keywords result' }], { totalCount: 1 }))
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      expect(screen.getByText(/fresh/)).toBeInTheDocument()

      // Obsolete completion arrives late with pagination-affecting payload —
      // it must not touch pages, cursors, totals, or pagination.
      oldRequest.resolve(
        makeResponse(
          Array.from({ length: 10 }, (_, i) => ({ ...makeItem(50 + i), rawContent: `stale old-keywords ${i}` })),
          { nextCursor: 'stale-cursor', hasMore: true, totalCount: 40 }
        )
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(screen.getAllByTestId('result-item')).toHaveLength(1)
      expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
      expect(screen.getByText(/fresh/)).toBeInTheDocument()
      // Single page of one item — the stale cursor must not mint a page 2.
      expect(screen.queryByTestId('pagination')).not.toBeInTheDocument()
      expect(searchMessagesMock).toHaveBeenCalledTimes(2)
    })

    it('mode change resets to first page', async () => {
      const page1 = Array.from({ length: 10 }, (_, i) => makeItem(i))
      const page2 = Array.from({ length: 10 }, (_, i) => makeItem(10 + i))
      searchMessagesMock
        .mockResolvedValueOnce(makeResponse(page1, { nextCursor: 'cursor-1', hasMore: true, totalCount: 20 }))
        .mockResolvedValueOnce(makeResponse(page2, { hasMore: false, totalCount: 20 }))
        .mockResolvedValueOnce(makeResponse(page1, { nextCursor: 'cursor-x', hasMore: true, totalCount: 20 }))
      renderComponent('hello')
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledOnce())

      fireEvent.click(screen.getByTestId('page-2'))
      await waitFor(() => expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '2'))

      fireEvent.click(screen.getByTestId('segment-substring'))
      await waitFor(() => expect(searchMessagesMock).toHaveBeenCalledTimes(3))
      await waitFor(() => expect(screen.getByTestId('pagination')).toHaveAttribute('data-current', '1'))
      // New session first page request carries no cursor.
      expect('cursor' in searchMessagesMock.mock.calls[2][0]).toBe(false)
    })
  })

  describe('navigation callbacks', () => {
    it('topic click resolves the Topic object from the store map', async () => {
      const storeTopic = { id: 'topic-1', name: 'Store Topic' }
      storeTopicsMap.set('topic-1', storeTopic)
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)]))
      const { onTopicClick } = renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('Topic topic-1'))

      expect(onTopicClick).toHaveBeenCalledWith(storeTopic)
      expect(toastErrorMock).not.toHaveBeenCalled()
    })

    it('topic click shows an error toast when the topic is missing', async () => {
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)]))
      const { onTopicClick } = renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('Topic topic-1'))

      expect(onTopicClick).not.toHaveBeenCalled()
      expect(toastErrorMock).toHaveBeenCalledWith('history.error.topic_not_found')
    })
  })

  // S6.2a R-04: authoritative around-window search-hit navigation
  describe('search-hit navigation (R-04 around-window)', () => {
    const makeWindowResponse = (
      request: { topicId: string; anchorMessageId: string; before: number; after: number },
      messages: Array<Record<string, unknown>>,
      blocks: Array<Record<string, unknown>> = []
    ) => {
      const returnedCount = messages.length
      const firstMessageId = returnedCount > 0 ? (messages[0] as any).id : null
      const lastMessageId = returnedCount > 0 ? (messages[returnedCount - 1] as any).id : null
      return {
        messages,
        blocks,
        window: {
          kind: 'around' as const,
          completeness: 'window' as const,
          topicId: request.topicId,
          anchorMessageId: request.anchorMessageId,
          requested: { before: request.before, after: request.after },
          firstMessageId,
          lastMessageId,
          returnedCount,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }
    }

    it('fetchs authoritative around window (10/19), validates, merges via stable ID, stages blocks/messages atomically, then invokes onMessageClick — no whole-topic fetch', async () => {
      const anchor = makeItem(1)
      const incomingMessages = [
        { id: `message-0`, topicId: 'topic-1', sortOrder: 0, blocks: ['block-0'] },
        { id: `message-1`, topicId: 'topic-1', sortOrder: 1, blocks: ['block-1'] },
        { id: `message-2`, topicId: 'topic-1', sortOrder: 2, blocks: ['block-2'] }
      ]
      const incomingBlocks = [
        { id: 'block-0', messageId: 'message-0', type: 'main_text', content: 'a' },
        { id: 'block-1', messageId: 'message-1', type: 'main_text', content: 'hello content 1' },
        { id: 'block-2', messageId: 'message-2', type: 'main_text', content: 'c' }
      ]
      // existing projection empty
      storeGetStateMock.mockReturnValue({
        messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
        messageBlocks: { entities: {} }
      })
      fetchMessagesWindowMock.mockResolvedValue(
        makeWindowResponse(
          { topicId: 'topic-1', anchorMessageId: 'message-1', before: 10, after: 19 },
          incomingMessages as any,
          incomingBlocks as any
        )
      )
      searchMessagesMock.mockResolvedValue(makeResponse([anchor]))

      const { onMessageClick } = renderComponent('hello')
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('hello'))

      await waitFor(() => expect(fetchMessagesWindowMock).toHaveBeenCalledTimes(1))
      const req = fetchMessagesWindowMock.mock.calls[0][0]
      expect(req.kind).toBe('around')
      expect(req.topicId).toBe('topic-1')
      expect(req.anchorMessageId).toBe('message-1')
      expect(req.before).toBe(10)
      expect(req.after).toBe(19)
      expect(dbServiceFetchMock).not.toHaveBeenCalled()

      await waitFor(() => expect(storeDispatchMock).toHaveBeenCalled())
      // blocks staged before messages — both atomically before navigation
      expect(upsertManyBlocksMock).toHaveBeenCalledWith(incomingBlocks)
      expect(messagesReceivedMock).toHaveBeenCalledWith({
        topicId: 'topic-1',
        messages: expect.arrayContaining([expect.objectContaining({ id: 'message-1' })])
      })
      await waitFor(() => expect(onMessageClick).toHaveBeenCalledTimes(1))
      const calledMsg = (onMessageClick as any).mock.calls[0][0]
      expect(calledMsg.id).toBe('message-1')
    })

    it('stale/cancel: a second rapid click discards the first fetch result (no double publish, no whole-topic)', async () => {
      const anchor1 = makeItem(1)
      const deferred1 = (() => {
        let resolve!: (v: any) => void
        const promise = new Promise<any>((res) => (resolve = res))
        return { promise, resolve }
      })()
      const deferred2 = (() => {
        let resolve!: (v: any) => void
        const promise = new Promise<any>((res) => (resolve = res))
        return { promise, resolve }
      })()
      const msgs1 = [{ id: 'message-1', topicId: 'topic-1', sortOrder: 1, blocks: [] }]
      const msgs2 = [
        { id: 'message-0', topicId: 'topic-1', sortOrder: 0, blocks: [] },
        { id: 'message-1', topicId: 'topic-1', sortOrder: 1, blocks: [] },
        { id: 'message-2', topicId: 'topic-1', sortOrder: 2, blocks: [] }
      ]
      const win1 = makeWindowResponse(
        { topicId: 'topic-1', anchorMessageId: 'message-1', before: 10, after: 19 },
        msgs1 as any,
        []
      )
      const win2 = makeWindowResponse(
        { topicId: 'topic-1', anchorMessageId: 'message-1', before: 10, after: 19 },
        msgs2 as any,
        []
      )
      storeGetStateMock.mockReturnValue({
        messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
        messageBlocks: { entities: {} }
      })
      // first click deferred, second click deferred
      fetchMessagesWindowMock.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise)
      searchMessagesMock.mockResolvedValue(makeResponse([anchor1]))
      const { onMessageClick } = renderComponent('hello')
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      // fire first click
      fireEvent.click(screen.getByText('hello'))
      await new Promise((r) => setTimeout(r, 0))
      // second rapid click bumps generation
      fireEvent.click(screen.getByText('hello'))
      // Resolve second (newer generation) first — should publish
      deferred2.resolve(win2)
      await waitFor(() => expect(onMessageClick).toHaveBeenCalledTimes(1))
      expect((onMessageClick as any).mock.calls[0][0].id).toBe('message-1')
      const dispatchCallsAfterSecond = storeDispatchMock.mock.calls.length
      // Now resolve stale first — must be ignored (no additional dispatch or callback)
      deferred1.resolve(win1)
      await new Promise((r) => setTimeout(r, 0))
      expect(onMessageClick).toHaveBeenCalledTimes(1)
      expect(storeDispatchMock.mock.calls.length).toBe(dispatchCallsAfterSecond)
      expect(dbServiceFetchMock).not.toHaveBeenCalled()
    })

    it('malformed response (topic mismatch / completeness not window / missing anchor) fails closed with toast and no partial publication', async () => {
      const anchor = makeItem(1)
      storeGetStateMock.mockReturnValue({
        messages: {
          entities: { 'message-1': { id: 'message-1', topicId: 'topic-1' } },
          messageIdsByTopic: { 'topic-1': ['message-1'] },
          currentTopicId: 'topic-1'
        },
        messageBlocks: { entities: {} }
      })
      searchMessagesMock.mockResolvedValue(makeResponse([anchor]))
      // malformed: window.topicId mismatch
      const badTopic = makeWindowResponse(
        { topicId: 'topic-1', anchorMessageId: 'message-1', before: 10, after: 19 },
        [{ id: 'message-1', topicId: 'topic-1' } as any],
        []
      )
      ;(badTopic.window as any).topicId = 'wrong-topic'
      fetchMessagesWindowMock.mockResolvedValueOnce(badTopic as any)
      const utils = renderComponent('hello')
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('hello'))
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found'))
      expect(storeDispatchMock).not.toHaveBeenCalled()
      expect(upsertManyBlocksMock).not.toHaveBeenCalled()
      expect(messagesReceivedMock).not.toHaveBeenCalled()
      expect(utils.onMessageClick).not.toHaveBeenCalled()

      // reset for next malformed: completeness not window
      vi.clearAllMocks()
      storeGetStateMock.mockReturnValue({
        messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
        messageBlocks: { entities: {} }
      })
      searchMessagesMock.mockResolvedValue(makeResponse([anchor]))
      const badCompleteness = makeWindowResponse(
        { topicId: 'topic-1', anchorMessageId: 'message-1', before: 10, after: 19 },
        [{ id: 'message-1', topicId: 'topic-1' } as any],
        []
      )
      ;(badCompleteness.window as any).completeness = 'whole-topic'
      fetchMessagesWindowMock.mockResolvedValueOnce(badCompleteness as any)
      const utils2 = renderComponent('hello')
      void utils2
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      // need to find hello text in second render — there will be two components now, query latest
      const hellos = screen.getAllByText('hello')
      fireEvent.click(hellos[hellos.length - 1])
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found'))
      expect(storeDispatchMock).not.toHaveBeenCalled()
    })

    it('NOT_FOUND (structured) fails closed with toast and no partial publication; transport error also fails closed', async () => {
      const anchor = makeItem(1)
      searchMessagesMock.mockResolvedValue(makeResponse([anchor]))
      storeGetStateMock.mockReturnValue({
        messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
        messageBlocks: { entities: {} }
      })
      fetchMessagesWindowMock.mockRejectedValueOnce(
        new ChatDbResultError({ code: 'NOT_FOUND', message: 'no such anchor', retryable: false })
      )
      const utils = renderComponent('hello')
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('hello'))
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found'))
      expect(storeDispatchMock).not.toHaveBeenCalled()
      expect(dbServiceFetchMock).not.toHaveBeenCalled()
      expect(utils.onMessageClick).not.toHaveBeenCalled()

      vi.clearAllMocks()
      storeGetStateMock.mockReturnValue({
        messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
        messageBlocks: { entities: {} }
      })
      searchMessagesMock.mockResolvedValue(makeResponse([anchor]))
      fetchMessagesWindowMock.mockRejectedValueOnce(new Error('transport fail'))
      const utils2 = renderComponent('hello')
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      const hellos2 = screen.getAllByText('hello')
      fireEvent.click(hellos2[hellos2.length - 1])
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found'))
      expect(storeDispatchMock).not.toHaveBeenCalled()
      expect(utils2.onMessageClick).not.toHaveBeenCalled()
    })

    it('does not masquerade empty as NOT_FOUND: empty window with valid metadata fails validation and does not publish', async () => {
      const anchor = makeItem(1)
      searchMessagesMock.mockResolvedValue(makeResponse([anchor]))
      storeGetStateMock.mockReturnValue({
        messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
        messageBlocks: { entities: {} }
      })
      // empty window but valid — however anchor missing should fail validation (isValidWindowResponse checks anchor presence)
      const emptyWin = makeWindowResponse(
        { topicId: 'topic-1', anchorMessageId: 'message-1', before: 10, after: 19 },
        [],
        []
      )
      ;(emptyWin as any).window.returnedCount = 0
      ;(emptyWin as any).window.firstMessageId = null
      ;(emptyWin as any).window.lastMessageId = null
      fetchMessagesWindowMock.mockResolvedValueOnce(emptyWin as any)
      const utils = renderComponent('hello')
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('hello'))
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found'))
      expect(storeDispatchMock).not.toHaveBeenCalled()
      expect(utils.onMessageClick).not.toHaveBeenCalled()
    })

    it('disjoint window with resident latest tail: retains tail, adds hit window via stable-ID union, no duplicates, deterministic sort — no whole-topic fetch', async () => {
      const anchor = makeItem(5, 'topic-1')
      // Resident tail: 10 messages (30..39) with sortOrder 30..39 — simulates latest 20 tail but truncated for brevity
      const residentIds = Array.from({ length: 10 }, (_, i) => `message-${30 + i}`)
      const residentEntities: Record<string, any> = {}
      residentIds.forEach((id, idx) => {
        const n = 30 + idx
        residentEntities[id] = { id, topicId: 'topic-1', sortOrder: n, blocks: [`block-${n}`] }
      })
      storeGetStateMock.mockReturnValue({
        messages: {
          entities: residentEntities,
          messageIdsByTopic: { 'topic-1': [...residentIds] },
          currentTopicId: 'topic-1'
        },
        messageBlocks: { entities: {} }
      })
      // Disjoint incoming around hit 5: messages 0..9 (includes anchor 5), none overlap with resident 30..39
      const incomingMessages = Array.from({ length: 10 }, (_, i) => ({
        id: `message-${i}`,
        topicId: 'topic-1',
        sortOrder: i,
        blocks: [`block-${i}`]
      }))
      const incomingBlocks = incomingMessages.map((m) => ({
        id: (m as any).blocks[0],
        messageId: (m as any).id,
        type: 'main_text',
        content: `block ${m.id}`
      }))
      fetchMessagesWindowMock.mockResolvedValue(
        makeWindowResponse(
          { topicId: 'topic-1', anchorMessageId: 'message-5', before: 10, after: 19 },
          incomingMessages as any,
          incomingBlocks as any
        )
      )
      searchMessagesMock.mockResolvedValue(makeResponse([anchor]))

      const { onMessageClick } = renderComponent('hello')
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      // Click the hit's rendered snippet (real SearchResults(hit) path)
      fireEvent.click(screen.getByText(`hello`))

      await waitFor(() => expect(fetchMessagesWindowMock).toHaveBeenCalledTimes(1))
      expect(dbServiceFetchMock).not.toHaveBeenCalled()

      await waitFor(() => expect(messagesReceivedMock).toHaveBeenCalledTimes(1))
      const published = (messagesReceivedMock.mock.calls[0][0] as any).messages as Array<any>
      // Hit materialized
      expect(published.some((m) => m.id === 'message-5')).toBe(true)
      // Resident tail retained
      for (const rid of residentIds) {
        expect(published.some((m) => m.id === rid)).toBe(true)
      }
      // Incoming hit window also present
      for (const iid of incomingMessages.map((m) => m.id)) {
        expect(published.some((m) => m.id === iid)).toBe(true)
      }
      // No duplicates
      const ids = published.map((m) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
      // No wholesale loss: length = union size (no overlap => 10 + 10)
      expect(published.length).toBe(residentIds.length + incomingMessages.length)
      // Deterministic order: ascending sortOrder and id tie-break — without reproducing sort, check monotonic sortOrder
      for (let i = 1; i < published.length; i++) {
        const prev = published[i - 1]
        const cur = published[i]
        const prevSort = typeof prev.sortOrder === 'number' ? prev.sortOrder : Number.MAX_SAFE_INTEGER
        const curSort = typeof cur.sortOrder === 'number' ? cur.sortOrder : Number.MAX_SAFE_INTEGER
        if (prevSort !== curSort) {
          expect(curSort).toBeGreaterThan(prevSort)
        } else {
          expect(cur.id.localeCompare(prev.id)).toBeGreaterThan(0)
        }
      }
      // Blocks staged atomically before messages
      expect(upsertManyBlocksMock).toHaveBeenCalledWith(incomingBlocks)
      await waitFor(() => expect(onMessageClick).toHaveBeenCalledTimes(1))
      expect((onMessageClick as any).mock.calls[0][0].id).toBe('message-5')
    })

    it('disjoint window union via id when sortOrder absent: retains tail, stably sorted by id only', async () => {
      const anchor = makeItem(2, 'topic-1')
      const residentIds = ['message-b', 'message-c']
      const residentEntities: Record<string, any> = {
        'message-b': { id: 'message-b', topicId: 'topic-1', blocks: [] },
        'message-c': { id: 'message-c', topicId: 'topic-1', blocks: [] }
      }
      storeGetStateMock.mockReturnValue({
        messages: {
          entities: residentEntities,
          messageIdsByTopic: { 'topic-1': [...residentIds] },
          currentTopicId: 'topic-1'
        },
        messageBlocks: { entities: {} }
      })
      const incomingMessages = [
        { id: 'message-a', topicId: 'topic-1', blocks: [] },
        { id: 'message-2', topicId: 'topic-1', blocks: [] },
        { id: 'message-d', topicId: 'topic-1', blocks: [] }
      ]
      fetchMessagesWindowMock.mockResolvedValue(
        makeWindowResponse(
          { topicId: 'topic-1', anchorMessageId: 'message-2', before: 10, after: 19 },
          incomingMessages as any,
          []
        )
      )
      searchMessagesMock.mockResolvedValue(makeResponse([anchor]))

      const { onMessageClick } = renderComponent('hello')
      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('hello'))

      await waitFor(() => expect(messagesReceivedMock).toHaveBeenCalledTimes(1))
      const published = (messagesReceivedMock.mock.calls[0][0] as any).messages as Array<any>
      expect(published.some((m) => m.id === 'message-2')).toBe(true)
      for (const rid of residentIds) expect(published.some((m) => m.id === rid)).toBe(true)
      expect(new Set(published.map((m) => m.id)).size).toBe(published.length)
      // Lexicographic id order only
      const ids = published.map((m) => m.id)
      const sorted = [...ids].sort((a, b) => a.localeCompare(b))
      expect(ids).toEqual(sorted)
      expect(onMessageClick).toHaveBeenCalledTimes(1)
    })
  })
})
