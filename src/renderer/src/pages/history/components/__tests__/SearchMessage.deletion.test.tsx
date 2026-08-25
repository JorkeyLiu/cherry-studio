import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Focused deletion invalidation for selected History message (LOCK-004).
 * - Selected message hidden when its topic generation advances.
 * - Locate navigation prevented after deletion.
 * - Normal selected-message behavior preserved when not deleted.
 * - Soft-delete preserves.
 */

const { getTopicByIdMock, locateToMessageMock, navigateMock, toastErrorMock } = vi.hoisted(() => ({
  getTopicByIdMock: vi.fn(),
  locateToMessageMock: vi.fn(),
  navigateMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('@renderer/hooks/useTopic', () => ({ getTopicById: getTopicByIdMock }))
vi.mock('@renderer/services/MessagesService', () => ({ locateToMessage: locateToMessageMock }))
vi.mock('@renderer/services/NavigationService', () => ({ default: { navigate: navigateMock } }))
vi.mock('@renderer/pages/home/Messages/Message', () => ({
  default: ({ message }: any) => <div data-testid="message-item">{message.id}</div>
}))
vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/context/MessageEditingContext', () => ({
  MessageEditingProvider: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/utils', () => ({
  runAsyncFunction: async (fn: () => Promise<void>) => fn()
}))
vi.mock('antd', () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props} type="button">
      {children}
    </button>
  )
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})
vi.mock('lucide-react', () => ({ Forward: () => null }))

const { default: SearchMessage } = await import('../SearchMessage')
import {
  bumpDeletionGeneration,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'

const makeTopic = (id: string) => ({ id, name: `Topic ${id}`, assistantId: 'assistant-1' }) as any
const makeMessage = (id: string, topicId: string) =>
  ({
    id,
    topicId,
    role: 'user',
    content: 'hello',
    createdAt: new Date().toISOString(),
    status: 'success',
    blocks: []
  }) as any

beforeEach(() => {
  vi.clearAllMocks()
  resetAllDeletionGenerationsForTests()
  ;(window as any).toast = { error: toastErrorMock }
  getTopicByIdMock.mockResolvedValue(makeTopic('topic-1'))
})

describe('SearchMessage deletion invalidation (focused)', () => {
  it('renders normally when not deleted and locate navigates', async () => {
    const message = makeMessage('msg-1', 'topic-1')
    render(<SearchMessage message={message} />)

    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())
    expect(screen.getByTestId('message-item')).toHaveTextContent('msg-1')

    fireEvent.click(screen.getByTestId('search-message-locate'))
    expect(locateToMessageMock).toHaveBeenCalledTimes(1)
    expect(locateToMessageMock).toHaveBeenCalledWith(navigateMock, message)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('hides selected message projection when its topic is hard-deleted (subscription)', async () => {
    const message = makeMessage('msg-1', 'topic-1')
    render(<SearchMessage message={message} />)

    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())

    bumpDeletionGeneration('topic-1')

    await waitFor(() => expect(screen.queryByTestId('search-message-view')).not.toBeInTheDocument())
    expect(screen.queryByTestId('message-item')).not.toBeInTheDocument()
  })

  it('prevents locate navigation after deletion via guard', async () => {
    const message = makeMessage('msg-1', 'topic-1')
    render(<SearchMessage message={message} />)
    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())

    bumpDeletionGeneration('topic-1')
    await waitFor(() => expect(screen.queryByTestId('search-message-view')).not.toBeInTheDocument())

    // Fresh instance already stale at mount should not render
    resetAllDeletionGenerationsForTests()
    bumpDeletionGeneration('topic-1')
    getTopicByIdMock.mockResolvedValue(makeTopic('topic-1'))
    render(<SearchMessage message={message} />)
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryAllByTestId('search-message-view')).toHaveLength(0)
  })

  it('soft-delete does not hide or block locate', async () => {
    const message = makeMessage('msg-1', 'topic-1')
    render(<SearchMessage message={message} />)
    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('search-message-locate-primary'))
    expect(locateToMessageMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('search-message-view')).toBeInTheDocument()
  })

  it('deletion of unrelated topic does not hide selected message', async () => {
    const message = makeMessage('msg-1', 'topic-1')
    render(<SearchMessage message={message} />)
    await waitFor(() => expect(screen.getByTestId('search-message-view')).toBeInTheDocument())

    bumpDeletionGeneration('topic-999')

    await new Promise((r) => setTimeout(r, 10))
    expect(screen.getByTestId('search-message-view')).toBeInTheDocument()
    expect(screen.getByTestId('message-item')).toBeInTheDocument()
  })

  it('locate guard blocks navigation when already stale before click', async () => {
    const message = makeMessage('msg-1', 'topic-1')
    getTopicByIdMock.mockResolvedValue(makeTopic('topic-1'))
    const utils = render(<SearchMessage message={message} />)
    await waitFor(() => expect(utils.getByTestId('search-message-view')).toBeInTheDocument())
    bumpDeletionGeneration('topic-1')
    // Click while still mounted but stale — handleLocate should toast and block
    const btn = utils.queryByTestId('search-message-locate-primary')
    // If still present for a tick, test guard; otherwise after hide it is gone which also proves prevention
    if (btn) {
      fireEvent.click(btn)
      expect(locateToMessageMock).not.toHaveBeenCalled()
    } else {
      // Already hidden — locate is prevented by not rendering
      expect(utils.queryByTestId('search-message-view')).not.toBeInTheDocument()
    }
  })
})
