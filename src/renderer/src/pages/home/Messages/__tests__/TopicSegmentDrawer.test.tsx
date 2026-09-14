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
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ]
}))

vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({
    orderedSegmentsForTopic: segmentsMock,
    messageIndexById: new Map<string, number>([
      // Authoritative first ID is deliberately NOT resident: the drawer must
      // still navigate to messageIds[0] (unified ensure complements it).
      ['msg-2', 0],
      ['msg-3', 1]
    ])
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
  it('always navigates to the authoritative segment.messageIds[0], never a window-local fallback', () => {
    emitMock.mockClear()
    render(<TopicSegmentDrawer topicId="topic-1" />)
    fireEvent.click(screen.getByText('Segment One'))
    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(EVENT_NAMES.NAVIGATE_TO_MESSAGE, 'msg-outside-window')
  })
})
