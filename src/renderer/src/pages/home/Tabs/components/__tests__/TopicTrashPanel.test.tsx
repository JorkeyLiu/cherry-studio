import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TopicTrashPanel } from '../TopicTrashPanel'

const mocks = vi.hoisted(() => ({
  getTrashTopics: vi.fn()
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: {
    getTrashTopics: mocks.getTrashTopics
  }
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

describe('TopicTrashPanel', () => {
  beforeEach(() => {
    mocks.getTrashTopics.mockReset()
  })

  it('refreshes trash count when refreshVersion changes', async () => {
    mocks.getTrashTopics.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'topic-1',
        assistantId: 'assistant-1',
        name: 'Deleted topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [],
        deletedAt: '2026-01-02T00:00:00.000Z'
      }
    ])

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
    expect(mocks.getTrashTopics).toHaveBeenCalledTimes(2)
    expect(mocks.getTrashTopics).toHaveBeenLastCalledWith('assistant-1')
  })
})
