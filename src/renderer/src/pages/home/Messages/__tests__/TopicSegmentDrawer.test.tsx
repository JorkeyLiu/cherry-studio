import { EVENT_NAMES } from '@renderer/services/EventService'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { emitMock, segmentsMock } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  segmentsMock: [
    {
      id: 'seg-1',
      topicId: 'topic-1',
      name: 'Segment One',
      messageIds: ['msg-outside-window', 'msg-2', 'msg-3'],
      color: '#fff',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'msg-outside-window',
      lastMessageId: 'msg-3',
      messageCount: 3
    },
    {
      id: 'seg-2',
      topicId: 'topic-1',
      name: 'Segment Two',
      messageIds: ['msg-4'],
      color: '#000',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 1,
      firstMessageId: 'msg-4',
      lastMessageId: 'msg-4',
      messageCount: 1
    }
  ]
}))

vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({
    orderedSegmentsForTopic: segmentsMock
  })
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { NAVIGATE_TO_MESSAGE: 'NAVIGATE_TO_MESSAGE' },
  EventEmitter: { emit: (...args: unknown[]) => emitMock(...args) }
}))

vi.mock('antd', () => ({
  Popover: ({ content, children }: any) => (
    <div>
      <div data-testid="drawer-trigger">{children}</div>
      <div data-testid="drawer-content">{content}</div>
    </div>
  )
}))

const { default: TopicSegmentDrawer } = await import('../TopicSegmentDrawer')

describe('TopicSegmentDrawer unified navigation', () => {
  it('always navigates to the authoritative firstMessageId, never a window-local fallback', () => {
    emitMock.mockClear()
    render(<TopicSegmentDrawer topicId="topic-1" />)
    fireEvent.click(screen.getByText('Segment One'))
    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(EVENT_NAMES.NAVIGATE_TO_MESSAGE, 'msg-outside-window')
  })

  it('shows the authority messageCount, not the loaded window length', () => {
    render(<TopicSegmentDrawer topicId="topic-1" />)
    // seg-1 has authority count 3 (only msg-2/msg-3 resident); seg-2 count 1.
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('preserves Main authority order (sortOrder then id)', () => {
    render(<TopicSegmentDrawer topicId="topic-1" />)
    const items = screen.getAllByText(/Segment (One|Two)/).map((el) => el.textContent)
    expect(items).toEqual(['Segment One', 'Segment Two'])
  })
})
