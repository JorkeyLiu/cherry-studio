import { loggerService } from '@logger'
import { LoadingIcon } from '@renderer/components/Icons'
import useScrollPosition from '@renderer/hooks/useScrollPosition'
import {
  NAVIGATION_VISUALLY_NEWER_GROUPS,
  NAVIGATION_VISUALLY_OLDER_GROUPS
} from '@renderer/pages/home/Messages/messageNavigation'
import {
  clampWindowCount,
  mergeWindowIntoTopic,
  unionWindowMessages
} from '@renderer/pages/home/Messages/messageWindow'
import { dbService } from '@renderer/services/db'
import { ChatDbResultError, SqliteMessageDataSource } from '@renderer/services/db/SqliteMessageDataSource'
import { isValidWindowResponse } from '@renderer/services/windowCoverage'
import store from '@renderer/store'
import { selectTopicsMap } from '@renderer/store/assistants'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import {
  buildKeywordRegexes,
  buildKeywordUnionRegex,
  type KeywordMatchMode,
  splitKeywordsToTerms
} from '@renderer/utils/keywordSearch'
import type { FetchMessagesWindowRequest, SearchResultItem } from '@shared/chatDb'
import { normalizeText, stripMarkdownFormatting } from '@shared/searchTextNormalization'
import { List, Pagination, Segmented, Spin, Typography } from 'antd'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'
import styled from 'styled-components'

const logger = loggerService.withContext('SearchResults')

const { Text, Title } = Typography

interface Props extends React.HTMLAttributes<HTMLDivElement> {
  keywords: string
  onMessageClick: (message: Message) => void
  onTopicClick: (topic: Topic) => void
}

const SEARCH_SNIPPET_CONTEXT_LINES = 1
const SEARCH_SNIPPET_MAX_LINES = 12
const SEARCH_SNIPPET_MAX_LINE_LENGTH = 160
const SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS = 40
const SEARCH_SNIPPET_MAX_LINE_FRAGMENTS = 3

const SEARCH_PAGE_SIZE = 10

type ResultSortOrder = 'newest' | 'oldest'

/** A result item paired with its precomputed display snippet. */
type DisplayResult = {
  item: SearchResultItem
  snippet: string
}

type SearchFailure = {
  message: string
  code?: string
}

// stripMarkdownFormatting and normalizeText are now imported from @shared/searchTextNormalization
// Re-export for any other consumers within this module
export { normalizeText, stripMarkdownFormatting }

const mergeRanges = (ranges: Array<[number, number]>) => {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (!last || range[0] > last[1] + 1) {
      merged.push([range[0], range[1]])
      continue
    }
    last[1] = Math.max(last[1], range[1])
  }
  return merged
}

const buildLineSnippet = (line: string, regexes: RegExp[]) => {
  if (line.length <= SEARCH_SNIPPET_MAX_LINE_LENGTH) {
    return line
  }

  const matchRanges: Array<[number, number]> = []
  for (const regex of regexes) {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(line)) !== null) {
      matchRanges.push([match.index, match.index + match[0].length])
      if (match[0].length === 0) {
        regex.lastIndex += 1
      }
    }
  }

  if (matchRanges.length === 0) {
    return `${line.slice(0, SEARCH_SNIPPET_MAX_LINE_LENGTH)}...`
  }

  const expandedRanges: Array<[number, number]> = matchRanges.map(([start, end]) => [
    Math.max(0, start - SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS),
    Math.min(line.length, end + SEARCH_SNIPPET_LINE_FRAGMENT_RADIUS)
  ])
  const mergedRanges = mergeRanges(expandedRanges)
  const limitedRanges = mergedRanges.slice(0, SEARCH_SNIPPET_MAX_LINE_FRAGMENTS)

  let result = limitedRanges.map(([start, end]) => line.slice(start, end)).join(' ... ')
  // 片段未从行首开始，补前置省略号。
  if (limitedRanges[0][0] > 0) {
    result = `...${result}`
  }
  // 片段未覆盖到行尾，补后置省略号。
  if (limitedRanges[limitedRanges.length - 1][1] < line.length) {
    result = `${result}...`
  }
  // 还有未展示的匹配片段，提示省略。
  if (mergedRanges.length > SEARCH_SNIPPET_MAX_LINE_FRAGMENTS) {
    result = `${result}...`
  }
  // 最终长度超限，强制截断并补省略号。
  if (result.length > SEARCH_SNIPPET_MAX_LINE_LENGTH) {
    result = `${result.slice(0, SEARCH_SNIPPET_MAX_LINE_LENGTH)}...`
  }
  return result
}

const buildSearchSnippet = (text: string, terms: string[], matchMode: KeywordMatchMode) => {
  const normalized = normalizeText(stripMarkdownFormatting(text))
  const lines = normalized.split('\n')
  if (lines.length === 0) {
    return ''
  }

  const nonEmptyTerms = terms.filter((term) => term.length > 0)
  const regexes = buildKeywordRegexes(nonEmptyTerms, { matchMode, flags: 'gi' })
  const matchedLineIndexes: number[] = []

  if (regexes.length > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const isMatch = regexes.some((regex) => {
        regex.lastIndex = 0
        return regex.test(line)
      })
      if (isMatch) {
        matchedLineIndexes.push(i)
      }
    }
  }

  const ranges: Array<[number, number]> =
    matchedLineIndexes.length > 0
      ? mergeRanges(
          matchedLineIndexes.map((index) => [
            Math.max(0, index - SEARCH_SNIPPET_CONTEXT_LINES),
            Math.min(lines.length - 1, index + SEARCH_SNIPPET_CONTEXT_LINES)
          ])
        )
      : [[0, Math.min(lines.length - 1, SEARCH_SNIPPET_MAX_LINES - 1)]]

  const outputLines: string[] = []
  let truncated = false

  if (ranges[0][0] > 0) {
    outputLines.push('...')
  }

  for (const [start, end] of ranges) {
    if (outputLines.length >= SEARCH_SNIPPET_MAX_LINES) {
      truncated = true
      break
    }
    if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== '...') {
      outputLines.push('...')
    }
    for (let i = start; i <= end; i += 1) {
      if (outputLines.length >= SEARCH_SNIPPET_MAX_LINES) {
        truncated = true
        break
      }
      outputLines.push(buildLineSnippet(lines[i], regexes))
    }
    if (truncated) {
      break
    }
  }

  if ((truncated || ranges[ranges.length - 1][1] < lines.length - 1) && outputLines.at(-1) !== '...') {
    outputLines.push('...')
  }

  return outputLines.join('\n')
}

const SearchResults: FC<Props> = ({ keywords, onMessageClick, onTopicClick, ...props }) => {
  const { t } = useTranslation()
  const { handleScroll, containerRef } = useScrollPosition('SearchResults')
  const observerRef = useRef<MutationObserver | null>(null)

  const [matchMode, setMatchMode] = useState<KeywordMatchMode>('whole-word')
  const [sortOrder, setSortOrder] = useState<ResultSortOrder>('newest')
  const [searchTerms, setSearchTerms] = useState<string[]>(splitKeywordsToTerms(keywords))

  // FIXME: db 中没有 topic.name 等信息，只能从 store 获取
  // Store topics are only resolved for the onTopicClick navigation callback
  // (LOCK-004) — never used to search or filter blocks.
  const storeTopicsMap = useSelector(selectTopicsMap)

  const dataSource = useMemo(() => new SqliteMessageDataSource(), [])

  const [pages, setPages] = useState<DisplayResult[][]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  // Whether the last fetched page returned a usable cursor for the next page.
  // Drives the LOCK-004 pagination fallback when totalCount is best-effort 0.
  const [hasNextCursor, setHasNextCursor] = useState(false)
  const [searchTime, setSearchTime] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [searchError, setSearchError] = useState<SearchFailure | null>(null)

  // Request generation. Incremented on every keywords/matchMode/sortOrder
  // change so responses of an older search session can never overwrite
  // the current state.
  const generationRef = useRef(0)
  // Fetched pages for the current search session (index = zero-based page).
  const pagesRef = useRef<DisplayResult[][]>([])
  // cursorsRef.current[i] = opaque SQLite cursor needed to request page i.
  // Index 0 is always undefined (first page). For i > 0, undefined means
  // the end of results was reached before page i.
  const cursorsRef = useRef<Array<string | undefined>>([undefined])
  // Serializes fetches within one generation so concurrent page navigations
  // cannot duplicate or race cursor pages (LOCK-002). The chain is replaced
  // (not appended to) whenever a new generation starts, so a new search never
  // waits behind an obsolete generation's pending IPC (LOCK-001).
  const fetchChainRef = useRef<Promise<void>>(Promise.resolve())

  /**
   * Fetch pages sequentially (forward-only opaque cursors) until the target
   * page index is cached or the end of results is reached. Never re-fetches
   * a cached page and never synthesizes cursors, so pages can neither omit
   * nor duplicate blocks.
   */
  const fetchPagesThrough = useCallback(
    async (params: {
      generation: number
      targetPageIndex: number
      keywords: string
      matchMode: KeywordMatchMode
      sortOrder: ResultSortOrder
      terms: string[]
    }) => {
      const { generation, targetPageIndex } = params
      while (generation === generationRef.current && pagesRef.current.length <= targetPageIndex) {
        const pageIndex = pagesRef.current.length
        const cursor = cursorsRef.current[pageIndex]
        if (pageIndex > 0 && cursor === undefined) {
          // End of results — no further cursor available.
          return
        }
        const response = await dataSource.searchMessages({
          keywords: params.keywords,
          matchMode: params.matchMode,
          sortOrder: params.sortOrder,
          pageSize: SEARCH_PAGE_SIZE,
          ...(cursor !== undefined && { cursor })
        })
        if (generation !== generationRef.current) {
          // Stale response — a newer search session started; discard.
          return
        }
        const displayItems: DisplayResult[] = response.items.map((item) => ({
          item,
          snippet: buildSearchSnippet(item.rawContent, params.terms, params.matchMode)
        }))
        pagesRef.current = [...pagesRef.current, displayItems]
        const nextCursor = response.hasMore ? response.nextCursor : undefined
        cursorsRef.current[pageIndex + 1] = nextCursor
        setPages(pagesRef.current)
        setTotalCount(response.totalCount)
        setHasNextCursor(nextCursor !== undefined)
        // A successful active-generation response supersedes any stale
        // pagination error (e.g. a failed next-page fetch that was later
        // retried successfully). The generation guard above ensures a stale
        // generation's completion can never clear the active error.
        setSearchError(null)
      }
    },
    [dataSource]
  )

  const toSearchFailure = useCallback((error: unknown): SearchFailure => {
    if (error instanceof ChatDbResultError) {
      return { message: error.message, code: error.code }
    }
    return { message: error instanceof Error ? error.message : String(error) }
  }, [])

  // New search session on keywords/matchMode/sortOrder change:
  // reset paging state, invalidate in-flight requests, fetch first page.
  useEffect(() => {
    const generation = ++generationRef.current
    pagesRef.current = []
    cursorsRef.current = [undefined]
    setPages([])
    setCurrentPage(1)
    setTotalCount(0)
    setHasNextCursor(false)
    setSearchError(null)

    const terms = splitKeywordsToTerms(keywords)
    setSearchTerms(terms)

    if (keywords.length === 0) {
      setSearchTime(0)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    const startTime = performance.now()
    // LOCK-001: start a fresh chain for the new generation instead of
    // appending to the old one, so the first-page request fires immediately
    // even if an obsolete generation still has a pending IPC. Generation
    // guards inside fetchPagesThrough keep the obsolete completion from
    // mutating pagesRef/cursorsRef or state.
    fetchChainRef.current = fetchPagesThrough({ generation, targetPageIndex: 0, keywords, matchMode, sortOrder, terms })
      .then(() => {
        if (generation !== generationRef.current) return
        setSearchTime((performance.now() - startTime) / 1000)
        setIsLoading(false)
      })
      .catch((error) => {
        if (generation !== generationRef.current) return
        logger.error('searchMessages failed', error as Error)
        setSearchError(toSearchFailure(error))
        setIsLoading(false)
      })
  }, [keywords, matchMode, sortOrder, fetchPagesThrough, toSearchFailure])

  const handlePageChange = useCallback(
    (page: number) => {
      const targetPageIndex = page - 1
      if (targetPageIndex < 0) {
        return
      }
      if (pagesRef.current.length > targetPageIndex) {
        // Cached page — navigate with no request.
        setCurrentPage(page)
        return
      }
      // LOCK-003: cursors are forward-only, so the only fetchable uncached
      // page is the single next one reached via the last server-returned
      // cursor. Any farther target would require fetching multiple uncached
      // intermediate pages — reject it (normal UI never offers such a page;
      // this also keeps programmatic calls safe).
      const isNextCursorReachablePage =
        targetPageIndex === pagesRef.current.length && cursorsRef.current[targetPageIndex] !== undefined
      if (!isNextCursorReachablePage) {
        return
      }
      setCurrentPage(page)
      const generation = generationRef.current
      setIsLoading(true)
      fetchChainRef.current = fetchChainRef.current
        .then(() =>
          fetchPagesThrough({ generation, targetPageIndex, keywords, matchMode, sortOrder, terms: searchTerms })
        )
        .then(() => {
          if (generation !== generationRef.current) return
          setIsLoading(false)
        })
        .catch((error) => {
          if (generation !== generationRef.current) return
          logger.error('searchMessages page fetch failed', error as Error)
          setSearchError(toSearchFailure(error))
          setIsLoading(false)
        })
    },
    [keywords, matchMode, sortOrder, searchTerms, fetchPagesThrough, toSearchFailure]
  )

  const handleTopicClick = useCallback(
    (topicId: string) => {
      const topic = storeTopicsMap.get(topicId)
      if (!topic) {
        window.toast.error(t('history.error.topic_not_found'))
        return
      }
      onTopicClick(topic)
    },
    [storeTopicsMap, onTopicClick, t]
  )

  // R-04: authoritative around-window search-hit navigation. No whole-topic fetch.
  // Uses existing chatdb:fetch-messages-window around contract with validation and
  // stable-ID merge before invoking the existing navigation transaction.
  const searchHitGenerationRef = useRef(0)
  const handleMessageClick = useCallback(
    async (item: SearchResultItem) => {
      const generation = ++searchHitGenerationRef.current
      const topicId = item.topicId
      const anchorId = item.messageId
      const before = clampWindowCount(NAVIGATION_VISUALLY_OLDER_GROUPS)
      const after = clampWindowCount(NAVIGATION_VISUALLY_NEWER_GROUPS)
      const request: FetchMessagesWindowRequest = {
        kind: 'around',
        topicId,
        anchorMessageId: anchorId,
        before,
        after
      }
      try {
        const response = await dbService.fetchMessagesWindow(request)
        if (generation !== searchHitGenerationRef.current) return
        if (!isValidWindowResponse(request, response)) {
          logger.error('[SearchResults] malformed window response', response.window as unknown as Error)
          window.toast.error(t('history.error.message_not_found'))
          return
        }
        if (
          response.window.topicId !== topicId ||
          response.window.kind !== 'around' ||
          response.window.anchorMessageId !== anchorId
        ) {
          logger.error('[SearchResults] window topic/kind/anchor mismatch')
          window.toast.error(t('history.error.message_not_found'))
          return
        }
        const existingMessages = selectMessagesForTopic(store.getState(), topicId)
        const incomingMessages = response.messages as unknown as Message[]
        const incomingBlocks = response.blocks as unknown as MessageBlock[]

        // Merge by stable ID without wholesale replacement or loss of resident projection.
        // Reuse existing mergeWindowIntoTopic when anchor is resident; handle disjoint
        // window (anchor not in existing) via canonical sorted union helper.
        let merged: Message[]
        const anchorInExisting = existingMessages.some((m) => m.id === anchorId)
        if (anchorInExisting) {
          merged = mergeWindowIntoTopic(existingMessages, incomingMessages, anchorId)
        } else {
          if (!incomingMessages.some((m) => m.id === anchorId)) {
            logger.error('[SearchResults] anchor missing in window response')
            window.toast.error(t('history.error.message_not_found'))
            return
          }
          merged = unionWindowMessages(existingMessages, incomingMessages)
        }

        if (generation !== searchHitGenerationRef.current) return
        if (!merged.some((m) => m.id === anchorId)) {
          logger.error('[SearchResults] anchor missing after merge')
          window.toast.error(t('history.error.message_not_found'))
          return
        }
        // Atomic staged publication: validate first, then merge, then publish blocks+messages.
        if (incomingBlocks.length > 0) {
          store.dispatch(upsertManyBlocks(incomingBlocks))
        }
        if (generation !== searchHitGenerationRef.current) return
        store.dispatch(newMessagesActions.messagesReceived({ topicId, messages: merged }))
        const message = merged.find((m) => m.id === anchorId)
        if (!message) {
          window.toast.error(t('history.error.message_not_found'))
          return
        }
        if (generation !== searchHitGenerationRef.current) return
        onMessageClick(message)
      } catch (error) {
        if (generation !== searchHitGenerationRef.current) return
        if (error instanceof ChatDbResultError) {
          const code = error.code
          if (code === 'NOT_FOUND' || code === 'ERR_NOT_FOUND' || code === 'TOPIC_NOT_FOUND') {
            logger.warn('[SearchResults] search-hit NOT_FOUND', error as Error)
            window.toast.error(t('history.error.message_not_found'))
            return
          }
          logger.error('[SearchResults] search-hit ChatDbResultError', error as Error)
          window.toast.error(t('history.error.message_not_found'))
          return
        }
        logger.error('[SearchResults] search-hit window fetch failed', error as Error)
        window.toast.error(t('history.error.message_not_found'))
      }
    },
    [onMessageClick, t]
  )

  const highlightText = (text: string) => {
    // Escape HTML entities to prevent XSS from LLM response content
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const safeText = escapeHtml(text)
    const highlightRegex = buildKeywordUnionRegex(searchTerms, { matchMode, flags: 'gi' })
    if (!highlightRegex) {
      return <span dangerouslySetInnerHTML={{ __html: safeText }} />
    }
    const highlightedText = safeText.replace(highlightRegex, (match) => `<mark>${match}</mark>`)
    return <span dangerouslySetInnerHTML={{ __html: highlightedText }} />
  }

  useEffect(() => {
    if (!containerRef.current) return

    observerRef.current = new MutationObserver(() => {
      containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    })

    observerRef.current.observe(containerRef.current, {
      childList: true,
      subtree: true
    })

    return () => observerRef.current?.disconnect()
  }, [containerRef])

  const currentItems = pages[currentPage - 1] ?? []

  // LOCK-003 + LOCK-004: pagination exposes exactly the cached pages plus at
  // most one extra slot when a server cursor for the next page is known, so
  // the next page stays reachable even when the best-effort totalCount is 0.
  // The server totalCount is used only for the stats line — it must not mint
  // distant page buttons, because cursors are forward-only and a distant
  // jump would fan out N-1 serial IPC calls. No cursors are synthesized —
  // navigation still forwards the exact server-returned cursor.
  const cachedItemCount = useMemo(() => pages.reduce((count, page) => count + page.length, 0), [pages])
  const paginationTotal = cachedItemCount + (hasNextCursor ? 1 : 0)

  return (
    <Container ref={containerRef} {...props} onScroll={handleScroll}>
      <Spin spinning={isLoading} indicator={<LoadingIcon color="var(--color-text-2)" />}>
        <SearchToolbar>
          <Segmented
            shape="round"
            size="small"
            value={sortOrder}
            onChange={(value) => setSortOrder(value as ResultSortOrder)}
            options={[
              { label: t('history.search.sort.newest'), value: 'newest' },
              { label: t('history.search.sort.oldest'), value: 'oldest' }
            ]}
          />
          <Segmented
            shape="round"
            size="small"
            value={matchMode}
            onChange={(value) => setMatchMode(value as KeywordMatchMode)}
            options={[
              { label: t('history.search.match.whole_word'), value: 'whole-word' },
              { label: t('history.search.match.substring'), value: 'substring' }
            ]}
          />
        </SearchToolbar>
        {searchError && (
          <SearchErrorContainer role="alert">
            <Text type="danger">{t('history.search.error')}</Text>
            <Text type="secondary">
              {searchError.code ? `[${searchError.code}] ` : ''}
              {searchError.message}
            </Text>
          </SearchErrorContainer>
        )}
        {!searchError && totalCount > 0 && (
          <SearchStats>
            Found {totalCount} results in {searchTime.toFixed(3)} seconds
          </SearchStats>
        )}
        <List
          itemLayout="vertical"
          dataSource={currentItems}
          pagination={false}
          style={{ opacity: isLoading ? 0 : 1 }}
          renderItem={({ item, snippet }) => (
            <List.Item>
              <Title
                level={5}
                style={{ color: 'var(--color-primary)', cursor: 'pointer' }}
                onClick={() => handleTopicClick(item.topicId)}>
                {item.topicName ?? ''}
              </Title>
              <div
                data-testid="search-result-hit"
                data-message-id={item.messageId}
                style={{ cursor: 'pointer' }}
                onClick={() => void handleMessageClick(item)}>
                <Text style={{ whiteSpace: 'pre-line' }}>{highlightText(snippet)}</Text>
              </div>
              <SearchResultTime>
                <Text type="secondary">
                  {item.messageCreatedAt ? new Date(item.messageCreatedAt).toLocaleString() : ''}
                </Text>
              </SearchResultTime>
            </List.Item>
          )}
        />
        <PaginationContainer style={{ opacity: isLoading ? 0 : 1 }}>
          <Pagination
            current={currentPage}
            pageSize={SEARCH_PAGE_SIZE}
            total={paginationTotal}
            onChange={handlePageChange}
            showSizeChanger={false}
            hideOnSinglePage
          />
        </PaginationContainer>
        <div style={{ minHeight: 30 }}></div>
      </Spin>
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  height: 100%;
  padding: 20px 36px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
`

const SearchStats = styled.div`
  font-size: 13px;
  color: var(--color-text-3);
`

const SearchErrorContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid var(--color-error, #ff4d4f);
  border-radius: 8px;
`

const SearchToolbar = styled.div`
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: flex-start;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
`

const PaginationContainer = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  margin-top: 12px;
`

const SearchResultTime = styled.div`
  margin-top: 10px;
  text-align: right;
`

export default memo(SearchResults)
