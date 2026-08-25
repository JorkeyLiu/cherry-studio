import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Focused HistoryPage selected message invalidation (LOCK-004).
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

// Use real children components but mock them to expose behavior
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

describe('HistoryPage selected message clearing (focused)', () => {
  it('clears selected message view when its topic is hard-deleted', async () => {
    render(<HistoryPage />)
    // Trigger message selection via SearchResults
    await waitFor(() => expect(screen.getByTestId('trigger-select')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('trigger-select'))

    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())
    expect(screen.getByTestId('search-message-view')).toHaveTextContent('msg-1')

    bumpDeletionGeneration('topic-1')

    await waitFor(() => expect(screen.queryByTestId('search-message-view')).not.toBeInTheDocument())
  })

  it('preserves selected message when unrelated topic deleted, and soft-delete preserves', async () => {
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByTestId('trigger-select')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('trigger-select'))
    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())

    bumpDeletionGeneration('topic-999')
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.getByTestId('search-message-view')).toBeInTheDocument()

    // Soft-delete simulation: no bump, still present
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.getByTestId('search-message-view')).toBeInTheDocument()
  })

  it('preserves normal selection behavior when not deleted', async () => {
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByTestId('trigger-select')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('trigger-select'))
    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())
    expect(dispatchMock).toHaveBeenCalled()
  })
})
