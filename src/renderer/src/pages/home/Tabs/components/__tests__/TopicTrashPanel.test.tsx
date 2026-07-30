import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listOrdinaryTrashTopics: vi.fn(),
  getTrashTopics: vi.fn()
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  listOrdinaryTrashTopics: mocks.listOrdinaryTrashTopics,
  // Real comparator semantics: deletedAt DESC, id DESC (LOCK-523).
  compareTrashTopicsForDisplay: (a: { id: string; deletedAt?: string }, b: { id: string; deletedAt?: string }) => {
    const aDeletedAt = a.deletedAt ?? ''
    const bDeletedAt = b.deletedAt ?? ''
    if (aDeletedAt !== bDeletedAt) return aDeletedAt < bDeletedAt ? 1 : -1
    if (a.id !== b.id) return a.id < b.id ? 1 : -1
    return 0
  }
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: {
    getTrashTopics: mocks.getTrashTopics
  }
}))

vi.mock('@renderer/utils/agentSession', () => ({
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:')
}))

vi.mock('@renderer/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ')
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`)
  })
}))

import { TopicTrashPanel } from '../TopicTrashPanel'

const trashTopic = (id: string, deletedAt = '2026-01-02T00:00:00.000Z') => ({
  id,
  assistantId: 'assistant-1',
  name: `Deleted topic ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  messages: [],
  deletedAt
})

describe('TopicTrashPanel', () => {
  beforeEach(() => {
    mocks.listOrdinaryTrashTopics.mockReset()
    mocks.getTrashTopics.mockReset()
    // Default: no Dexie trash unless a test provides it.
    mocks.getTrashTopics.mockResolvedValue([])
  })

  it('refreshes trash count from the SQLite-backed list when refreshVersion changes', async () => {
    mocks.listOrdinaryTrashTopics.mockResolvedValueOnce([]).mockResolvedValueOnce([trashTopic('topic-1')])

    const { rerender } = render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:0')).toBeInTheDocument())

    rerender(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={1}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:1')).toBeInTheDocument())
    expect(mocks.listOrdinaryTrashTopics).toHaveBeenCalledTimes(2)
    expect(mocks.listOrdinaryTrashTopics).toHaveBeenLastCalledWith('assistant-1')
  })

  it('merges agent-session Dexie trash with ordinary SQLite trash in deletedAt DESC order (LOCK-521)', async () => {
    mocks.listOrdinaryTrashTopics.mockResolvedValue([trashTopic('topic-ordinary', '2026-01-02T00:00:00.000Z')])
    mocks.getTrashTopics.mockResolvedValue([
      trashTopic('agent-session:s-1', '2026-01-03T00:00:00.000Z'),
      // Ordinary Dexie leftover: must be strictly filtered out.
      trashTopic('topic-dexie-leftover', '2026-01-05T00:00:00.000Z')
    ])

    render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:2')).toBeInTheDocument())
    fireEvent.click(screen.getByText('chat.topics.trash.label:2'))

    await waitFor(() => expect(screen.getByText('Deleted topic agent-session:s-1')).toBeInTheDocument())
    expect(screen.getByText('Deleted topic topic-ordinary')).toBeInTheDocument()
    expect(screen.queryByText('Deleted topic topic-dexie-leftover')).not.toBeInTheDocument()

    // Deterministic order: newer deletedAt (agent row) first.
    const names = screen
      .getAllByText(/Deleted topic /)
      .map((el) => el.textContent)
      .filter((text) => text !== null)
    expect(names).toEqual(['Deleted topic agent-session:s-1', 'Deleted topic topic-ordinary'])
  })

  it('agent trash rows expose the same restore/delete actions (routed by ID upstream)', async () => {
    mocks.listOrdinaryTrashTopics.mockResolvedValue([])
    mocks.getTrashTopics.mockResolvedValue([trashTopic('agent-session:s-1', '2026-01-03T00:00:00.000Z')])
    const onRestore = vi.fn().mockResolvedValue(undefined)

    render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={onRestore}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('chat.topics.trash.label:1'))
    await waitFor(() => expect(screen.getByText('Deleted topic agent-session:s-1')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('chat.topics.trash.restore'))

    await waitFor(() => expect(onRestore).toHaveBeenCalledExactlyOnceWith('agent-session:s-1'))
  })

  it('removes the row only after the awaited restore callback succeeds (LOCK-528)', async () => {
    mocks.listOrdinaryTrashTopics.mockResolvedValue([trashTopic('topic-1')])
    const onRestore = vi.fn().mockResolvedValue(undefined)

    render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={onRestore}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('chat.topics.trash.label:1'))
    await waitFor(() => expect(screen.getByText('Deleted topic topic-1')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('chat.topics.trash.restore'))

    await waitFor(() => expect(onRestore).toHaveBeenCalledExactlyOnceWith('topic-1'))
    await waitFor(() => expect(screen.queryByText('Deleted topic topic-1')).not.toBeInTheDocument())
  })

  it('keeps the row when the restore callback fails (no optimistic stale state)', async () => {
    mocks.listOrdinaryTrashTopics.mockResolvedValue([trashTopic('topic-1')])
    const onRestore = vi.fn().mockRejectedValue(new Error('SQLITE_FAILURE'))

    render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={onRestore}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('chat.topics.trash.label:1'))
    await waitFor(() => expect(screen.getByText('Deleted topic topic-1')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('chat.topics.trash.restore'))

    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Deleted topic topic-1')).toBeInTheDocument()
  })

  it('keeps rows when the permanent delete callback fails', async () => {
    mocks.listOrdinaryTrashTopics.mockResolvedValue([trashTopic('topic-1')])
    const onPermanentDelete = vi.fn().mockRejectedValue(new Error('SQLITE_FAILURE'))

    render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={vi.fn()}
        onPermanentDelete={onPermanentDelete}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('chat.topics.trash.label:1'))
    await waitFor(() => expect(screen.getByText('Deleted topic topic-1')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('common.delete'))

    await waitFor(() => expect(onPermanentDelete).toHaveBeenCalledExactlyOnceWith('topic-1'))
    expect(screen.getByText('Deleted topic topic-1')).toBeInTheDocument()
  })

  it('clears the list only after empty trash succeeds', async () => {
    mocks.listOrdinaryTrashTopics.mockResolvedValue([trashTopic('topic-1'), trashTopic('topic-2')])
    const onEmptyTrash = vi.fn().mockResolvedValue(undefined)

    render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={onEmptyTrash}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:2')).toBeInTheDocument())
    fireEvent.click(screen.getByText('chat.topics.trash.label:2'))
    await waitFor(() => expect(screen.getByText('chat.topics.trash.empty_trash')).toBeInTheDocument())

    fireEvent.click(screen.getByText('chat.topics.trash.empty_trash'))

    await waitFor(() => expect(onEmptyTrash).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('Deleted topic topic-1')).not.toBeInTheDocument())
  })

  it('renders a localized fallback for historical blank names with a tooltip', async () => {
    mocks.listOrdinaryTrashTopics.mockResolvedValue([{ ...trashTopic('historical-null'), name: '' }])

    render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('chat.topics.trash.label:1'))

    await waitFor(() => expect(screen.getByText('common.unnamed')).toBeInTheDocument())
    expect(screen.getByText('common.unnamed')).toHaveAttribute('title', 'common.unnamed')
  })

  it('preserves the full long topic name in the title while rendering the row', async () => {
    const longName = 'A'.repeat(300)
    mocks.listOrdinaryTrashTopics.mockResolvedValue([{ ...trashTopic('long-topic'), name: longName }])

    render(
      <TopicTrashPanel
        assistantId="assistant-1"
        refreshVersion={0}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
        onEmptyTrash={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('chat.topics.trash.label:1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('chat.topics.trash.label:1'))

    await waitFor(() => expect(screen.getByText(longName)).toBeInTheDocument())
    expect(screen.getByText(longName)).toHaveAttribute('title', longName)
  })
})
