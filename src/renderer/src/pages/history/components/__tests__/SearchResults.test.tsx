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

const { searchMessagesMock, topicsGetMock, toastErrorMock, storeTopicsMap } = vi.hoisted(() => ({
  searchMessagesMock: vi.fn<(request: SearchMessagesRequest) => Promise<SearchMessagesResponse>>(),
  topicsGetMock: vi.fn(),
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

vi.mock('@renderer/databases', () => ({
  default: { topics: { get: topicsGetMock } }
}))

vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({ handleScroll: vi.fn(), containerRef: { current: null } })
}))

vi.mock('@renderer/store/assistants', () => ({
  selectTopicsMap: vi.fn()
}))

vi.mock('react-redux', () => ({
  useSelector: () => storeTopicsMap
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

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
      expect(topicsGetMock).not.toHaveBeenCalled()
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

    it('message click resolves the Message object from the Dexie topic record', async () => {
      const message = { id: 'message-1', topicId: 'topic-1', createdAt: '2026-01-01T00:00:00.000Z' }
      topicsGetMock.mockResolvedValue({ id: 'topic-1', messages: [message] })
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)]))
      const { onMessageClick } = renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('hello'))

      await waitFor(() => expect(onMessageClick).toHaveBeenCalledWith(message))
      expect(topicsGetMock).toHaveBeenCalledWith('topic-1')
    })

    it('message click shows an error toast when the message cannot be resolved', async () => {
      topicsGetMock.mockResolvedValue(undefined)
      searchMessagesMock.mockResolvedValue(makeResponse([makeItem(1)]))
      const { onMessageClick } = renderComponent('hello')

      await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
      fireEvent.click(screen.getByText('hello'))

      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('history.error.message_not_found'))
      expect(onMessageClick).not.toHaveBeenCalled()
    })
  })
})
