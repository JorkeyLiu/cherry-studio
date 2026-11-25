import { EVENT_NAMES } from '@renderer/services/EventService'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitMock, state } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  state: {
    routeKey: 'topic-1::main',
    committedChrome: null,
    acceptCommittedStructure: vi.fn(),
    // The drawer lists only the accepted projection; pending (isCurrent false)
    // is the empty-list case, never a stale route's rows.
    isCurrent: true,
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
        // Route-qualified TURN count: 3 reachable messages form 2 turns —
        // kept distinct from messageCount so the badge source is visible.
        turnCount: 2,
        firstMessageId: 'msg-offscreen',
        // Stable head from Main: NOT the first reachable member, so navigation
        // must target the head, never the first member.
        headerMessageId: 'msg-2',
        headerInRoute: true,
        headerOwnedByRoute: true,
        folded: false
      },
      {
        id: 'seg-2',
        name: 'Segment Two',
        color: '#000',
        sortOrder: 0,
        memberIds: ['msg-4'],
        messageCount: 1,
        turnCount: 1,
        firstMessageId: 'msg-4',
        headerMessageId: 'msg-4',
        headerInRoute: true,
        headerOwnedByRoute: true,
        folded: false
      }
    ] as Array<RouteScopedSegment & { folded: boolean }>
  }
}))

// The drawer reads the chat surface's ONE route-structure value (provider
// mounted by Chat). This test supplies the value the surface would publish, so
// `routeKey` / `isCurrent` semantics stay part of the fixture instead of a
// consumer-only stub.
vi.mock('../../ChatRouteStructure', () => ({
  ChatRouteStructureProvider: ({ children }: { children: unknown }) => <>{children as ReactNode}</>,
  useChatRouteStructure: () => state
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { NAVIGATE_TO_MESSAGE: 'NAVIGATE_TO_MESSAGE' },
  EventEmitter: { emit: (...args: unknown[]) => emitMock(...args) }
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts && 'count' in opts ? String(opts.count) : key)
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
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
    state.isCurrent = true
    state.segments = [
      {
        id: 'seg-1',
        name: 'Segment One',
        color: '#fff',
        sortOrder: 1,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        turnCount: 2,
        firstMessageId: 'msg-offscreen',
        headerMessageId: 'msg-2',
        headerInRoute: true,
        headerOwnedByRoute: true,
        presentationStartMessageId: 'msg-2',
        folded: false
      },
      {
        id: 'seg-2',
        name: 'Segment Two',
        color: '#000',
        sortOrder: 0,
        memberIds: ['msg-4'],
        messageCount: 1,
        turnCount: 1,
        firstMessageId: 'msg-4',
        headerMessageId: 'msg-4',
        headerInRoute: true,
        headerOwnedByRoute: true,
        presentationStartMessageId: 'msg-4',
        folded: false
      }
    ]
  })

  it('navigates to the stable head, never the first reachable member', () => {
    render(<TopicSegmentDrawer />)
    const row = screen.getByText('Segment One')
    // The row carries the stable head id for testability.
    const item = row.closest('[data-testid="topic-segment-drawer-row"]') as HTMLElement | null
    expect(item?.getAttribute('data-segment-header')).toBe('msg-2')
    fireEvent.click(row)
    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledWith(EVENT_NAMES.NAVIGATE_TO_MESSAGE, 'msg-2')
  })

  it('navigates to an unloaded head (window complement stays out of the target)', () => {
    state.segments = [
      {
        id: 'seg-9',
        name: 'Segment Nine',
        color: '#fff',
        sortOrder: 0,
        memberIds: ['msg-2', 'msg-3'],
        messageCount: 2,
        firstMessageId: 'msg-2',
        // The stable head is outside the loaded window: the unified path loads
        // its window and settles on the fold marker.
        headerMessageId: 'msg-head-unloaded',
        headerInRoute: true,
        headerOwnedByRoute: true,
        presentationStartMessageId: 'msg-head-unloaded',
        folded: false
      }
    ]
    render(<TopicSegmentDrawer />)
    fireEvent.click(screen.getByText('Segment Nine'))
    expect(emitMock).toHaveBeenCalledWith(EVENT_NAMES.NAVIGATE_TO_MESSAGE, 'msg-head-unloaded')
  })

  it('hides groups whose stable head resolves outside the current route', () => {
    state.segments = [
      {
        id: 'seg-1',
        name: 'Segment One',
        color: '#fff',
        sortOrder: 1,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        firstMessageId: 'msg-offscreen',
        headerMessageId: 'msg-2',
        headerInRoute: false,
        headerOwnedByRoute: false,
        presentationStartMessageId: 'msg-offscreen',
        folded: false
      }
    ]
    const { container } = render(<TopicSegmentDrawer />)
    // A headless residual keeps its members naturally rendered in the rail but
    // gets no navigation entry: the drawer lists nothing.
    expect(screen.queryByText('Segment One')).toBeNull()
    expect(container.querySelector('[data-testid="drawer-trigger"]')).toBeNull()
  })

  it('shows the route-qualified turn count, never the catalog message count', () => {
    render(<TopicSegmentDrawer />)
    // The projection carries turn counts: 3 reachable messages form 2 turns.
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    // The catalog message count (3) must not appear anywhere.
    expect(screen.queryByText('3')).toBeNull()
  })

  it('renders the projected route order, never re-sorting by catalog sortOrder', () => {
    render(<TopicSegmentDrawer />)
    const items = screen.getAllByText(/Segment (One|Two)/).map((el) => el.textContent)
    // The hook hands rows over in first-reachable-route-position order; seg-1 has
    // the higher catalog sortOrder and still comes first on this route.
    expect(items).toEqual(['Segment One', 'Segment Two'])
  })

  it('hides the trigger and every old row once the projection is empty (route switch pending)', () => {
    const { rerender } = render(<TopicSegmentDrawer />)
    expect(screen.getByText('Segment One')).toBeTruthy()

    // Route switch with the new snapshot pending: the surface publishes
    // `isCurrent: false` with an empty accepted list, so no old-route row is
    // reachable to launch a stale navigation. (The component is memoized, so
    // remounting under the new route key drives the rerender.)
    state.routeKey = 'topic-2::main'
    state.isCurrent = false
    state.segments = []
    rerender(<TopicSegmentDrawer key="topic-2" />)

    expect(screen.queryByText('Segment One')).toBeNull()
    expect(screen.queryByTestId('drawer-content')).toBeNull()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('renders nothing when the projection has no reachable segments', () => {
    state.segments = []
    const { container } = render(<TopicSegmentDrawer />)
    expect(container.querySelector('[data-testid="drawer-trigger"]')).toBeNull()
  })

  it('lists the drawer title above the navigation rows', () => {
    render(<TopicSegmentDrawer />)
    expect(screen.getByText('topicSegment.navigation.title')).toBeTruthy()
  })

  it('lists a group that still carries the legacy fold flag by its own name, keeping the count', () => {
    state.segments = [
      {
        id: 'seg-1',
        name: 'Segment One',
        color: '#fff',
        sortOrder: 1,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        turnCount: 2,
        firstMessageId: 'msg-offscreen',
        headerMessageId: 'msg-2',
        headerInRoute: true,
        headerOwnedByRoute: true,
        presentationStartMessageId: 'msg-2',
        folded: true
      },
      {
        id: 'seg-2',
        name: 'Segment Two',
        color: '#000',
        sortOrder: 0,
        memberIds: ['msg-4'],
        messageCount: 1,
        turnCount: 1,
        firstMessageId: 'msg-4',
        headerMessageId: 'msg-4',
        headerInRoute: true,
        headerOwnedByRoute: true,
        presentationStartMessageId: 'msg-4',
        folded: false
      }
    ]
    render(<TopicSegmentDrawer />)

    // The legacy per-group fold flag is cancelled: it is no longer a
    // presentation state of the navigation row, so a group that still carries
    // it is listed by its own name — the count is unchanged either way.
    const row = screen.getByText('Segment One')
    const item = row.closest('[data-testid="topic-segment-drawer-row"]') as HTMLElement | null
    expect(item?.getAttribute('title')).toBe('Segment One')
    expect(screen.queryByText('topicSegment.folded')).toBeNull()
    expect(screen.getByText('2')).toBeTruthy()

    // Expanded row keeps its original name and count.
    expect(screen.getByText('Segment Two')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('falls back to the first member when the projection predates the head contract', () => {
    state.segments = [
      {
        id: 'seg-1',
        name: 'Segment One',
        color: '#fff',
        sortOrder: 1,
        memberIds: ['msg-offscreen', 'msg-2', 'msg-3'],
        messageCount: 3,
        firstMessageId: 'msg-offscreen',
        // The projection predates the head contract: no stable head, so the
        // row falls back to the first member. Reachable but ownership
        // unprovable (read + navigate only).
        headerMessageId: null,
        headerInRoute: true,
        headerOwnedByRoute: false,
        presentationStartMessageId: 'msg-offscreen',
        folded: true
      }
    ]
    render(<TopicSegmentDrawer />)
    fireEvent.click(screen.getByText('Segment One'))
    expect(emitMock).toHaveBeenCalledWith(EVENT_NAMES.NAVIGATE_TO_MESSAGE, 'msg-offscreen')
  })

  it('portals the trigger and its popover above the group-header layer', () => {
    render(<TopicSegmentDrawer />)
    // The floating trigger carries its own test id so the layer contract can be
    // observed (portaled node, explicit z above the z1000 group header).
    expect(screen.getByTestId('topic-segment-drawer-trigger')).toBeTruthy()
    expect(document.body.contains(screen.getByTestId('drawer-popover'))).toBe(true)
    const popoverZ = Number(screen.getByTestId('drawer-popover').getAttribute('data-z-index'))
    expect(popoverZ).toBeGreaterThan(1000)
  })
})
