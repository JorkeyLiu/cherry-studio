import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Focused deletion invalidation for History TopicMessages local projection (LOCK-004).
 * - Synchronous clear after permanent deletion (subscription)
 * - Stale async getTopicById guard during deletion
 * - Unrelated topic preservation
 * - Normal non-deleted load
 * - Soft-delete preserves (no bump)
 */

const { getTopicByIdMock, navigateMock } = vi.hoisted(() => ({
  getTopicByIdMock: vi.fn(),
  navigateMock: vi.fn()
}))

vi.mock('@renderer/hooks/useTopic', () => ({ getTopicById: getTopicByIdMock }))
vi.mock('@renderer/hooks/useScrollPosition', () => ({
  default: () => ({ handleScroll: vi.fn(), containerRef: { current: null } })
}))
vi.mock('@renderer/hooks/useTimer', () => ({ useTimer: () => ({ setTimeoutTimer: vi.fn() }) }))
vi.mock('@renderer/services/AssistantService', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, getAssistantById: vi.fn(() => ({ id: 'assistant-1' })) }
})
// EventService not mocked — use real implementation to avoid breaking SpanManagerService's EventEmitter.on
vi.mock('@renderer/services/MessagesService', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, isGenerating: vi.fn(async () => {}), locateToMessage: vi.fn() }
})
vi.mock('@renderer/services/NavigationService', () => ({ default: { navigate: navigateMock } }))
vi.mock('@renderer/components/Layout', () => ({ HStack: ({ children }: any) => <div>{children}</div> }))
vi.mock('@renderer/components/Popups/SearchPopup', () => ({ default: { hide: vi.fn() }, hide: vi.fn() }))
vi.mock('@renderer/context/MessageEditingContext', () => ({
  MessageEditingProvider: ({ children }: any) => <div>{children}</div>
}))
vi.mock('@renderer/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    classNames: (arr: any) => (Array.isArray(arr) ? arr.join(' ') : String(arr ?? '')),
    runAsyncFunction: async (fn: () => Promise<void>) => fn()
  }
})
vi.mock('antd', () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props} type="button">
      {children}
    </button>
  ),
  Divider: () => <hr />,
  Empty: () => <div data-testid="empty" />
}))
vi.mock('@ant-design/icons', () => ({ MessageOutlined: () => null }))
vi.mock('lucide-react', () => ({ Forward: () => null }))
vi.mock('@renderer/pages/home/Messages/Message', () => ({
  default: ({ message }: any) => <div data-testid="message-item">{message.id}</div>
}))
vi.mock('i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, t: (k: string) => k, default: { ...actual.default, t: (k: string) => k } }
})

const { default: TopicMessages } = await import('../TopicMessages')
import {
  bumpDeletionGeneration,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'

const makeTopic = (id: string, messages: any[] = []) =>
  ({
    id,
    name: `Topic ${id}`,
    assistantId: 'assistant-1',
    messages
  }) as any

const makeMessages = (topicId: string) => [
  { id: 'msg-1', role: 'user', topicId },
  { id: 'msg-2', role: 'assistant', topicId }
]

beforeEach(() => {
  vi.clearAllMocks()
  resetAllDeletionGenerationsForTests()
  ;(window as any).toast = { error: vi.fn() }
  // window.keyv stub for any stray hook usage
  if (!(window as any).keyv) {
    ;(window as any).keyv = { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
  }
  getTopicByIdMock.mockReset()
})

describe('TopicMessages deletion invalidation (focused)', () => {
  it('normal non-deleted load renders fetched messages', async () => {
    const initial = makeTopic('topic-1', [])
    const fetched = makeTopic('topic-1', makeMessages('topic-1'))
    getTopicByIdMock.mockResolvedValue(fetched)

    render(<TopicMessages topic={initial} />)

    await waitFor(() => expect(getTopicByIdMock).toHaveBeenCalledWith('topic-1'))
    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(2))
    expect(screen.getAllByTestId('message-item')[0]).toHaveTextContent('msg-1')
  })

  it('clears local topic state synchronously after permanent deletion (post-load)', async () => {
    const initial = makeTopic('topic-1', [])
    const fetched = makeTopic('topic-1', makeMessages('topic-1'))
    getTopicByIdMock.mockResolvedValue(fetched)

    render(<TopicMessages topic={initial} />)

    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(2))

    bumpDeletionGeneration('topic-1')

    await waitFor(() => expect(screen.queryByTestId('message-item')).not.toBeInTheDocument())
    // Entire projection should be gone (component returns null)
    expect(screen.queryAllByTestId('message-item')).toHaveLength(0)
  })

  it('rejects stale async getTopicById response when deletion occurs during fetch', async () => {
    const initial = makeTopic('topic-1', [])
    let resolveFetched!: (v: any) => void
    const fetched = makeTopic('topic-1', makeMessages('topic-1'))
    getTopicByIdMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetched = resolve
        })
    )

    render(<TopicMessages topic={initial} />)

    // Wait for effect to start fetch
    await waitFor(() => expect(getTopicByIdMock).toHaveBeenCalledWith('topic-1'))

    // Deletion happens before async resolves
    bumpDeletionGeneration('topic-1')

    // Now resolve the stale fetch
    resolveFetched(fetched)

    // Allow microtasks to run
    await new Promise((r) => setTimeout(r, 20))

    // Must not publish stale projection
    expect(screen.queryByTestId('message-item')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('message-item')).toHaveLength(0)
    // Ensure only one call (no second publish)
    expect(getTopicByIdMock).toHaveBeenCalledTimes(1)
  })

  it('preserves local projection when unrelated topic is deleted', async () => {
    const initial = makeTopic('topic-1', [])
    const fetched = makeTopic('topic-1', makeMessages('topic-1'))
    getTopicByIdMock.mockResolvedValue(fetched)

    render(<TopicMessages topic={initial} />)
    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(2))

    bumpDeletionGeneration('topic-999')

    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getAllByTestId('message-item')).toHaveLength(2)
    expect(screen.getAllByTestId('message-item')[0]).toHaveTextContent('msg-1')
  })

  it('soft-delete (no bump) preserves projection and normal behavior remains', async () => {
    const initial = makeTopic('topic-1', [])
    const fetched = makeTopic('topic-1', makeMessages('topic-1'))
    getTopicByIdMock.mockResolvedValue(fetched)

    render(<TopicMessages topic={initial} />)
    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(2))

    // No bump — simulate soft-delete / failure (should not clear)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getAllByTestId('message-item')).toHaveLength(2)
  })

  it('already-deleted before mount never publishes stale fetch', async () => {
    bumpDeletionGeneration('topic-1')
    const initial = makeTopic('topic-1', [])
    const fetched = makeTopic('topic-1', makeMessages('topic-1'))
    getTopicByIdMock.mockResolvedValue(fetched)

    render(<TopicMessages topic={initial} />)

    await new Promise((r) => setTimeout(r, 20))
    // getTopicById should not have been called or if called, result discarded and projection cleared
    // With fail-closed before fetch, we expect no messages
    expect(screen.queryByTestId('message-item')).not.toBeInTheDocument()
  })

  it('identity mismatch (fetched id differs) is not published', async () => {
    const initial = makeTopic('topic-1', [])
    const wrong = makeTopic('topic-2', makeMessages('topic-2'))
    getTopicByIdMock.mockResolvedValue(wrong)

    render(<TopicMessages topic={initial} />)

    await new Promise((r) => setTimeout(r, 20))
    // Should not show wrong topic's messages; projection remains without messages or cleared?
    // At minimum, wrong identity must not be rendered as topic-1 messages
    expect(
      screen.queryAllByTestId('message-item').some((el) => el.textContent === 'msg-1' && wrong.id === 'topic-2')
    ).toBeFalsy()
    // Since initial topic had no messages, after rejected publish it shows empty or still initial (no msg)
    // Ensure no messages from wrong topic appear? Our wrong messages are also msg-1/msg-2 but topic differs
    // The guard discards, so no update; initial had empty messages, so still no history messages?
    // But initial state is _topic (empty). After discard, it stays empty -> empty placeholder, no message-item
    expect(screen.queryByTestId('message-item')).not.toBeInTheDocument()
  })
})
