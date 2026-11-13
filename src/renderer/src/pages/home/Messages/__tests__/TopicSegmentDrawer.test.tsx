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
        // Catalog order puts this group BEFORE seg-2, but on the current route
        // its first reachable member comes after seg-2's (see the ordering test).
        sortOrder: 1,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        firstMessageId: 'msg-offscreen',
        folded: false
      },
      {
        id: 'seg-2',
        name: 'Segment Two',
        color: '#000',
        sortOrder: 0,
        memberIds: ['msg-4'],
        messageCount: 1,
        firstMessageId: 'msg-4',
        folded: false
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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('antd', () => ({
  Popover: ({ content, children, zIndex }: any) => (
    <div data-testid="drawer-popover" data-z-index={zIndex}>
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
        sortOrder: 1,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        firstMessageId: 'msg-offscreen',
        folded: false
      },
      {
        id: 'seg-2',
        name: 'Segment Two',
        color: '#000',
        sortOrder: 0,
        memberIds: ['msg-4'],
        messageCount: 1,
        firstMessageId: 'msg-4',
        folded: false
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

  it('renders the projected route order, never re-sorting by catalog sortOrder', () => {
    render(<TopicSegmentDrawer topicId="topic-1" />)
    const items = screen.getAllByText(/Segment (One|Two)/).map((el) => el.textContent)
    // The hook hands rows over in first-reachable-route-position order; seg-1 has
    // the higher catalog sortOrder and still comes first on this route.
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

  it('lists the drawer title above the navigation rows', () => {
    render(<TopicSegmentDrawer topicId="topic-1" />)
    expect(screen.getByText('topicSegment.navigation.title')).toBeTruthy()
  })

  it('shows a folded group by its fold state instead of the hidden name, keeping the count', () => {
    state.segments = [
      {
        id: 'seg-1',
        name: 'Segment One',
        color: '#fff',
        sortOrder: 1,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        firstMessageId: 'msg-offscreen',
        folded: true
      },
      {
        id: 'seg-2',
        name: 'Segment Two',
        color: '#000',
        sortOrder: 0,
        memberIds: ['msg-4'],
        messageCount: 1,
        firstMessageId: 'msg-4',
        folded: false
      }
    ]
    render(<TopicSegmentDrawer topicId="topic-1" />)

    // Folded row: i18n fold label, no original name in the row text, the
    // original name preserved as the hover title, and the count unchanged.
    const foldedRow = screen.getByText('topicSegment.folded')
    expect(foldedRow.textContent).not.toContain('Segment One')
    const foldedItem = foldedRow.closest('[title]') as HTMLElement | null
    expect(foldedItem?.getAttribute('title')).toBe('Segment One')
    expect(screen.queryByText('Segment One')).toBeNull()
    expect(screen.getByText('3')).toBeTruthy()

    // Expanded row keeps its original name and count.
    expect(screen.getByText('Segment Two')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('keeps navigation by the folded row on the projected first member', () => {
    state.segments = [
      {
        id: 'seg-1',
        name: 'Segment One',
        color: '#fff',
        sortOrder: 1,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        firstMessageId: 'msg-offscreen',
        folded: true
      }
    ]
    render(<TopicSegmentDrawer topicId="topic-1" />)
    fireEvent.click(screen.getByText('topicSegment.folded'))
    expect(emitMock).toHaveBeenCalledWith(EVENT_NAMES.NAVIGATE_TO_MESSAGE, 'msg-offscreen')
  })

  it('portals the trigger and its popover above the group-header layer', () => {
    render(<TopicSegmentDrawer topicId="topic-1" />)
    // The floating trigger carries its own test id so the layer contract can be
    // observed (portaled node, explicit z above the z1000 group header).
    expect(screen.getByTestId('topic-segment-drawer-trigger')).toBeTruthy()
    expect(document.body.contains(screen.getByTestId('drawer-popover'))).toBe(true)
    const popoverZ = Number(screen.getByTestId('drawer-popover').getAttribute('data-z-index'))
    expect(popoverZ).toBeGreaterThan(1000)
  })
})
