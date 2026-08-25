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

describe('SearchResults deletion during around-window fetch (focused)', () => {
  it('discards stale around-window response after hard deletion: no blocks/messages publication, no navigation', async () => {
    const anchor = makeItem(1, 'topic-1')
    searchMessagesMock.mockResolvedValue(makeResponse([anchor]))

    // Deferred window fetch so we can interleave deletion before resolution
    let resolveWindow!: (v: any) => void
    const windowPromise = new Promise<any>((res) => {
      resolveWindow = res
    })
    fetchMessagesWindowMock.mockReturnValueOnce(windowPromise)

    storeGetStateMock.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
      messageBlocks: { entities: {} }
    } as any)

    const onMessageClick = vi.fn()
    const onTopicClick = vi.fn()
    render(<SearchResults keywords="hello" onMessageClick={onMessageClick} onTopicClick={onTopicClick} />)

    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
    // Trigger around-window fetch
    fireEvent.click(screen.getByText('hello'))
    // Allow handleMessageClick to start and capture deletionGenAtStart
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMessagesWindowMock).toHaveBeenCalledTimes(1)

    // Simulate hard deletion of the topic during in-flight fetch
    bumpDeletionGeneration('topic-1')

    // Resolve stale window response — should be discarded before validation/publication
    const staleMessages = [
      { id: 'message-1', topicId: 'topic-1', sortOrder: 1, blocks: ['block-1'] },
      { id: 'message-2', topicId: 'topic-1', sortOrder: 2, blocks: ['block-2'] }
    ]
    const staleBlocks = [
      { id: 'block-1', messageId: 'message-1', type: 'main_text', content: 'hello content 1' },
      { id: 'block-2', messageId: 'message-2', type: 'main_text', content: 'other' }
    ]
    resolveWindow(
      makeWindowResponse(
        { topicId: 'topic-1', anchorMessageId: 'message-1', before: 10, after: 19 },
        staleMessages as any,
        staleBlocks as any
      )
    )

    await new Promise((r) => setTimeout(r, 0))
    await waitFor(() => expect(fetchMessagesWindowMock).toHaveBeenCalledTimes(1))

    // Must not publish blocks/messages nor navigate for deleted topic
    expect(upsertManyBlocksMock).not.toHaveBeenCalled()
    expect(messagesReceivedMock).not.toHaveBeenCalled()
    expect(onMessageClick).not.toHaveBeenCalled()
    expect(storeDispatchMock).not.toHaveBeenCalled()
  })

  it('preserves normal non-deleted around-window response: stages blocks/messages and navigates', async () => {
    const anchor = makeItem(1, 'topic-1')
    searchMessagesMock.mockResolvedValue(makeResponse([anchor]))

    const incomingMessages = [
      { id: 'message-1', topicId: 'topic-1', sortOrder: 1, blocks: ['block-1'] },
      { id: 'message-2', topicId: 'topic-1', sortOrder: 2, blocks: ['block-2'] }
    ]
    const incomingBlocks = [
      { id: 'block-1', messageId: 'message-1', type: 'main_text', content: 'hello content 1' },
      { id: 'block-2', messageId: 'message-2', type: 'main_text', content: 'other' }
    ]
    fetchMessagesWindowMock.mockResolvedValue(
      makeWindowResponse(
        { topicId: 'topic-1', anchorMessageId: 'message-1', before: 10, after: 19 },
        incomingMessages as any,
        incomingBlocks as any
      )
    )
    storeGetStateMock.mockReturnValue({
      messages: { entities: {}, messageIdsByTopic: { 'topic-1': [] }, currentTopicId: 'topic-1' },
      messageBlocks: { entities: {} }
    } as any)

    const onMessageClick = vi.fn()
    render(<SearchResults keywords="hello" onMessageClick={onMessageClick} onTopicClick={vi.fn()} />)

    await waitFor(() => expect(screen.getAllByTestId('result-item')).toHaveLength(1))
    fireEvent.click(screen.getByText('hello'))

    await waitFor(() => expect(fetchMessagesWindowMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onMessageClick).toHaveBeenCalledTimes(1))
    expect(upsertManyBlocksMock).toHaveBeenCalledWith(incomingBlocks)
    expect(messagesReceivedMock).toHaveBeenCalledWith({
      topicId: 'topic-1',
      messages: expect.arrayContaining([expect.objectContaining({ id: 'message-1' })])
    })
    expect(onMessageClick.mock.calls[0][0].id).toBe('message-1')
  })
})
