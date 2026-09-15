import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Focused deletion invalidation for History TopicMessages local snapshot (LOCK-004).
 * - Synchronous clear after permanent deletion (subscription)
 * - Stale async snapshot guard during deletion
 * - Unrelated topic preservation
 * - Normal non-deleted snapshot load (whole-topic snapshot + local blocks, no Redux injection)
 * - Soft-delete preserves (no bump)
 */

const { getTopicMock, loadWholeTopicSnapshotMock, navigateMock } = vi.hoisted(() => ({
  getTopicMock: vi.fn(),
  loadWholeTopicSnapshotMock: vi.fn(),
  navigateMock: vi.fn()
}))

vi.mock('@renderer/hooks/useTopic', () => ({ TopicManager: { getTopic: getTopicMock } }))
vi.mock('@renderer/utils/topicSnapshot', () => ({ loadWholeTopicSnapshot: loadWholeTopicSnapshotMock }))
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
  default: ({ message, snapshotBlocksById }: any) => (
    <div data-testid="message-item" data-snapshot-blocks={snapshotBlocksById ? snapshotBlocksById.size : -1}>
      {message.id}
    </div>
  )
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

const makeTopic = (id: string) =>
  ({
    id,
    name: `Topic ${id}`,
    assistantId: 'assistant-1'
  }) as any

const makeMessages = (topicId: string) => [
  { id: 'msg-1', role: 'user', topicId, blocks: ['b-1'] },
  { id: 'msg-2', role: 'assistant', topicId, blocks: ['b-2'] }
]

const makeBlocks = () => [
  { id: 'b-1', messageId: 'msg-1', type: 'main_text', content: 'hello' },
  { id: 'b-2', messageId: 'msg-2', type: 'main_text', content: 'world' }
]

const snapshotOf = (topicId: string, messages: any[], blocks: any[]) => ({
  messages,
  blocks,
  blocksById: new Map(blocks.map((b) => [b.id, b])),
  snapshot: {
    completeness: 'whole-topic',
    topicId,
    firstMessageId: messages[0]?.id,
    lastMessageId: messages.at(-1)?.id
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  resetAllDeletionGenerationsForTests()
  ;(window as any).toast = { error: vi.fn() }
  // window.keyv stub for any stray hook usage
  if (!(window as any).keyv) {
    ;(window as any).keyv = { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
  }
  getTopicMock.mockReset()
  loadWholeTopicSnapshotMock.mockReset()
})

const seedFetch = (topicId: string, messages: any[] = makeMessages(topicId)) => {
  getTopicMock.mockResolvedValue(makeTopic(topicId))
  loadWholeTopicSnapshotMock.mockResolvedValue(snapshotOf(topicId, messages, makeBlocks()))
}

describe('TopicMessages deletion invalidation (focused)', () => {
  it('normal non-deleted load renders snapshot messages with local blocks and no Redux injection', async () => {
    const initial = makeTopic('topic-1')
    seedFetch('topic-1')

    render(<TopicMessages topic={initial} />)

    await waitFor(() => expect(getTopicMock).toHaveBeenCalledWith('topic-1'))
    await waitFor(() => expect(loadWholeTopicSnapshotMock).toHaveBeenCalledWith('topic-1'))
    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(2))
    expect(screen.getAllByTestId('message-item')[0]).toHaveTextContent('msg-1')
    // Local snapshot block map is injected (2 blocks), not Redux.
    expect(screen.getAllByTestId('message-item')[0].getAttribute('data-snapshot-blocks')).toBe('2')
  })

  it('clears local topic state synchronously after permanent deletion (post-load)', async () => {
    const initial = makeTopic('topic-1')
    seedFetch('topic-1')

    render(<TopicMessages topic={initial} />)

    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(2))

    bumpDeletionGeneration('topic-1')

    await waitFor(() => expect(screen.queryByTestId('message-item')).not.toBeInTheDocument())
    // Entire projection should be gone (component returns null)
    expect(screen.queryAllByTestId('message-item')).toHaveLength(0)
  })

  it('rejects stale async snapshot response when deletion occurs during fetch', async () => {
    const initial = makeTopic('topic-1')
    getTopicMock.mockResolvedValue(makeTopic('topic-1'))
    let resolveSnapshot!: (v: any) => void
    loadWholeTopicSnapshotMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )

    render(<TopicMessages topic={initial} />)

    // Wait for effect to start fetch
    await waitFor(() => expect(getTopicMock).toHaveBeenCalledWith('topic-1'))

    // Deletion happens before async resolves
    bumpDeletionGeneration('topic-1')

    // Now resolve the stale fetch
    resolveSnapshot(snapshotOf('topic-1', makeMessages('topic-1'), makeBlocks()))

    // Allow microtasks to run
    await new Promise((r) => setTimeout(r, 20))

    // Must not publish stale projection
    expect(screen.queryByTestId('message-item')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('message-item')).toHaveLength(0)
    // Ensure only one call (no second publish)
    expect(loadWholeTopicSnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('preserves local projection when unrelated topic is deleted', async () => {
    const initial = makeTopic('topic-1')
    seedFetch('topic-1')

    render(<TopicMessages topic={initial} />)
    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(2))

    bumpDeletionGeneration('topic-999')

    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getAllByTestId('message-item')).toHaveLength(2)
    expect(screen.getAllByTestId('message-item')[0]).toHaveTextContent('msg-1')
  })

  it('soft-delete (no bump) preserves projection and normal behavior remains', async () => {
    const initial = makeTopic('topic-1')
    seedFetch('topic-1')

    render(<TopicMessages topic={initial} />)
    await waitFor(() => expect(screen.getAllByTestId('message-item')).toHaveLength(2))

    // No bump — simulate soft-delete / failure (should not clear)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getAllByTestId('message-item')).toHaveLength(2)
  })

  it('already-deleted before mount never publishes stale fetch', async () => {
    bumpDeletionGeneration('topic-1')
    const initial = makeTopic('topic-1')
    seedFetch('topic-1')

    render(<TopicMessages topic={initial} />)

    await new Promise((r) => setTimeout(r, 20))
    // Fail-closed before fetch: no messages and no snapshot load publish
    expect(screen.queryByTestId('message-item')).not.toBeInTheDocument()
    expect(loadWholeTopicSnapshotMock).not.toHaveBeenCalled()
  })

  it('identity mismatch (fetched id differs) is not published', async () => {
    const initial = makeTopic('topic-1')
    getTopicMock.mockResolvedValue(makeTopic('topic-2'))
    loadWholeTopicSnapshotMock.mockResolvedValue(snapshotOf('topic-2', makeMessages('topic-2'), makeBlocks()))

    render(<TopicMessages topic={initial} />)

    await new Promise((r) => setTimeout(r, 20))
    // Wrong identity must not be rendered as topic-1 messages
    expect(screen.queryByTestId('message-item')).not.toBeInTheDocument()
  })
})
