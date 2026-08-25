import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Focused race for HistoryPage pre-effect deletion (finding 1).
 * - Deletion before effect/subscription setup must synchronously clear stale selected message
 */

const { loadTopicMessagesThunkMock, dispatchMock, toastErrorMock } = vi.hoisted(() => ({
  loadTopicMessagesThunkMock: vi.fn(() => ({ type: 'mock/loadTopicMessages' })),
  dispatchMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({ loadTopicMessagesThunk: loadTopicMessagesThunkMock }))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => dispatchMock }))
vi.mock('@renderer/components/Layout', () => ({ HStack: ({ children }: any) => <div>{children}</div> }))
vi.mock('antd', () => {
  const Input = (props: any) => <input {...props} />
  Input.displayName = 'Input'
  return { Divider: () => <hr />, Input }
})
vi.mock('lucide-react', () => ({ ChevronLeft: () => null, CornerDownLeft: () => null, Search: () => null }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('lodash', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, last: (arr: any[]) => arr[arr.length - 1] }
})
vi.mock('../components/TopicsHistory', () => ({ default: () => <div data-testid="topics-history" /> }))
vi.mock('../components/TopicMessages', () => ({
  default: ({ topic }: any) => <div data-testid="topic-messages">{topic?.id ?? 'none'}</div>
}))
vi.mock('../components/SearchResults', () => ({
  default: (props: any) => {
    return (
      <div data-testid="search-results">
        <button
          data-testid="trigger-select"
          onClick={() => props.onMessageClick({ id: 'msg-1', topicId: 'topic-1', blocks: [] })}>
          select
        </button>
        <button
          data-testid="trigger-select-other"
          onClick={() => props.onMessageClick({ id: 'msg-2', topicId: 'topic-2', blocks: [] })}>
          select-other
        </button>
      </div>
    )
  }
}))
vi.mock('../components/SearchMessage', () => ({
  default: ({ message }: any) => (message ? <div data-testid="search-message-view">{message.id}</div> : null)
}))

const { default: HistoryPage } = await import('../HistoryPage')
import {
  bumpDeletionGeneration,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'

beforeEach(() => {
  vi.clearAllMocks()
  resetAllDeletionGenerationsForTests()
  ;(window as any).toast = { error: toastErrorMock }
})

describe('HistoryPage deletion before effect race (focused)', () => {
  it('deletion before subscription setup synchronously clears stale selected message', async () => {
    // Hard delete before the selected message ever exists — simulates render-to-subscription gap
    bumpDeletionGeneration('topic-1')

    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByTestId('trigger-select')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('trigger-select'))

    // Selected message for already-deleted topic must never render (generation nonzero before effect)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('search-message-view')).not.toBeInTheDocument()
  })

  it('deletion before effect preserves unrelated topic selection', async () => {
    bumpDeletionGeneration('topic-999')

    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByTestId('trigger-select')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('trigger-select'))
    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())
    expect(screen.getByTestId('search-message-view')).toHaveTextContent('msg-1')

    // Other topic selection still works
    fireEvent.click(screen.getByTestId('trigger-select-other'))
    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())
    expect(screen.getByTestId('search-message-view')).toHaveTextContent('msg-2')
  })

  it('soft-delete (no bump) before effect preserves selection', async () => {
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByTestId('trigger-select')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('trigger-select'))
    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())
    expect(screen.getByTestId('search-message-view')).toBeInTheDocument()
  })
})
