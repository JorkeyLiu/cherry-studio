import { EVENT_NAMES } from '@renderer/services/EventService'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitMock, state } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  state: {
    routeKey: 'topic-1::main',
    segments: [
      {
        id: 'seg-1',
        name: 'Segment One',
        color: '#fff',
        sortOrder: 0,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        firstMessageId: 'msg-offscreen'
      },
      {
        id: 'seg-2',
        name: 'Segment Two',
        color: '#000',
        sortOrder: 1,
        memberIds: ['msg-4'],
        messageCount: 1,
        firstMessageId: 'msg-4'
      }
    ]
  }
}))

vi.mock('@renderer/hooks/useRouteScopedSegments', () => ({
  useRouteScopedSegments: () => state
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

describe('TopicSegmentDrawer route-scoped navigation', () => {
  beforeEach(() => {
    emitMock.mockClear()
    state.routeKey = 'topic-1::main'
    state.segments = [
      {
        id: 'seg-1',
        name: 'Segment One',
        color: '#fff',
        sortOrder: 0,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        firstMessageId: 'msg-offscreen'
      },
      {
        id: 'seg-2',
        name: 'Segment Two',
        color: '#000',
        sortOrder: 1,
        memberIds: ['msg-4'],
        messageCount: 1,
        firstMessageId: 'msg-4'
      }
    ]
  })

  it('navigates to the projected route-reachable first member (no window-local fallback)', () => {
    render(<TopicSegmentDrawer topicId="topic-1" />)
    fireEvent.click(screen.getByText('Segment One'))
    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(EVENT_NAMES.NAVIGATE_TO_MESSAGE, 'msg-offscreen')
  })

  it('shows the projected intersection count, not the topic-wide authority count', () => {
    render(<TopicSegmentDrawer topicId="topic-1" />)
    // The projection carries the reachable-intersection counts.
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('preserves authority order (sortOrder then id)', () => {
    render(<TopicSegmentDrawer topicId="topic-1" />)
    const items = screen.getAllByText(/Segment (One|Two)/).map((el) => el.textContent)
    expect(items).toEqual(['Segment One', 'Segment Two'])
  })

  it('hides the trigger and every old row once the projection is empty (route switch pending)', () => {
    const { rerender } = render(<TopicSegmentDrawer topicId="topic-1" />)
    expect(screen.getByText('Segment One')).toBeTruthy()

    // Route switch with the new snapshot pending: the projection derives empty,
    // so no old-route row is reachable to launch a stale navigation. (The
    // component is memoized, so a new topicId drives the rerender.)
    state.routeKey = 'topic-2::main'
    state.segments = []
    rerender(<TopicSegmentDrawer topicId="topic-2" />)

    expect(screen.queryByText('Segment One')).toBeNull()
    expect(screen.queryByTestId('drawer-content')).toBeNull()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('renders nothing when the projection has no reachable segments', () => {
    state.segments = []
    const { container } = render(<TopicSegmentDrawer topicId="topic-1" />)
    expect(container.querySelector('[data-testid="drawer-trigger"]')).toBeNull()
  })
})
