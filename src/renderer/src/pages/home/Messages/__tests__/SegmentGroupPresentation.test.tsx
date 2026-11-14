import { act, render, screen } from '@testing-library/react'
import { Activity, StrictMode, useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSegmentGroupLayoutManager,
  SEGMENT_GROUP_RAIL_TAIL_TRIM_PX,
  SEGMENT_GROUP_RAIL_TOP_PX,
  type SegmentGroupLayoutManager,
  SegmentGroupPresentationProvider,
  useSegmentGroupGeometry,
  useSegmentGroupLayoutManager
} from '../SegmentGroupPresentation'

/**
 * Geometry contract of the group presentation manager: ONE registry above the
 * run/selection composition measures the mounted span of a group from its
 * carrying run hosts, so the group's rail is a single continuous overlay
 * instead of a mark per run. The manager is DOM-derived and publishes geometry
 * only when it actually changes.
 */

const stubRect = (element: HTMLElement, rect: { top: number; bottom: number }) => {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        ...rect,
        x: 0,
        y: rect.top,
        left: 0,
        right: 100,
        width: 100,
        height: rect.bottom - rect.top,
        toJSON: () => ({})
      }) as DOMRectReadOnly
  })
}

const makeHost = () => {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return element
}

describe('segment group layout manager', () => {
  it('measures ONE span from the group header run down to its last mounted run', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    const lower = makeHost()
    // Header row (32px) at 100..132; the group's lowest mounted run ends at 400.
    stubRect(header, { top: 100, bottom: 132 })
    stubRect(lower, { top: 200, bottom: 400 })
    manager.registerRun('seg-a', header, { isHeader: true, endsGroup: false })
    manager.registerRun('seg-a', lower, { isHeader: false, endsGroup: true })
    manager.measure()

    expect(manager.getGeometry('seg-a')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 400 - 100 - SEGMENT_GROUP_RAIL_TOP_PX - SEGMENT_GROUP_RAIL_TAIL_TRIM_PX
    })
    manager.suspend()
  })

  it('keeps measuring the same one group across a divider split (two runs, one span, no tail trim)', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    const lower = makeHost()
    stubRect(header, { top: 100, bottom: 132 })
    stubRect(lower, { top: 260, bottom: 360 })
    manager.registerRun('seg-a', header, { isHeader: true, endsGroup: false })
    manager.registerRun('seg-a', lower, { isHeader: false, endsGroup: false })
    manager.measure()

    const geometry = manager.getGeometry('seg-a')
    // The divider height between 132 and 260 is inside the measured span, so the
    // single rail crosses it; a group whose last member is outside the mounted
    // window paints no tail trim.
    expect(geometry?.height).toBe(360 - 100 - SEGMENT_GROUP_RAIL_TOP_PX)
    manager.suspend()
  })

  it('keeps the ONE rail across the divider band when that band grows between measure passes', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    const lower = makeHost()
    stubRect(header, { top: 100, bottom: 132 })
    stubRect(lower, { top: 260, bottom: 360 })
    manager.registerRun('seg-a', header, { isHeader: true, endsGroup: true })
    manager.registerRun('seg-a', lower, { isHeader: false, endsGroup: true })
    manager.measure()

    const geometry = manager.getGeometry('seg-a')!
    // The divider is a normal-flow SIBLING between the two run hosts, so it is
    // never registered: the span is still coordinate-based and covers its band.
    const railTop = 100 + SEGMENT_GROUP_RAIL_TOP_PX
    const railBottom = railTop + geometry.height
    expect(railTop).toBeLessThanOrEqual(260)
    expect(railBottom).toBeGreaterThanOrEqual(260)

    // The divider band grows (its own commit-time reflow): the lower run host
    // cannot report that as its own resize, so the next layout pass is what
    // re-reads the coordinates. The ONE rail follows the same rule.
    stubRect(lower, { top: 340, bottom: 440 })
    manager.measure()
    expect(manager.getGeometry('seg-a')?.height).toBe(
      440 - 100 - SEGMENT_GROUP_RAIL_TOP_PX - SEGMENT_GROUP_RAIL_TAIL_TRIM_PX
    )
    manager.suspend()
  })

  it('measures a partially mounted group from its elected topmost run (authority first member outside the window)', () => {
    const manager = createSegmentGroupLayoutManager()
    // A windowed group has no authority-first member: the composition elects
    // the LAST carrying run in render order as its header, i.e. the group's
    // mounted visual top. That run is the only anchor the rail may use.
    const topmost = makeHost()
    const lower = makeHost()
    stubRect(topmost, { top: 100, bottom: 132 })
    stubRect(lower, { top: 200, bottom: 380 })
    manager.registerRun('seg-partial', topmost, { isHeader: true, endsGroup: false })
    manager.registerRun('seg-partial', lower, { isHeader: false, endsGroup: false })
    manager.measure()

    // One span, no tail trim (the group's authority last member is outside the
    // mounted window), and the anchor is the header run itself.
    expect(manager.getGeometry('seg-partial')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 380 - 100 - SEGMENT_GROUP_RAIL_TOP_PX
    })
    manager.suspend()
  })

  it('notifies only on a real span change, not on identical or sub-half-pixel remeasurement', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    const lower = makeHost()
    stubRect(header, { top: 100, bottom: 132 })
    stubRect(lower, { top: 200, bottom: 400 })
    const listener = vi.fn()
    manager.subscribe('seg-a', listener)
    manager.registerRun('seg-a', header, { isHeader: true, endsGroup: true })
    manager.registerRun('seg-a', lower, { isHeader: false, endsGroup: true })
    manager.measure()
    expect(listener).toHaveBeenCalledTimes(1)
    manager.measure()
    expect(listener).toHaveBeenCalledTimes(1)

    stubRect(lower, { top: 200, bottom: 400.4 })
    manager.measure()
    expect(listener).toHaveBeenCalledTimes(1)

    stubRect(lower, { top: 200, bottom: 460 })
    manager.measure()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(manager.getGeometry('seg-a')?.height).toBe(
      460 - 100 - SEGMENT_GROUP_RAIL_TOP_PX - SEGMENT_GROUP_RAIL_TAIL_TRIM_PX
    )
    manager.suspend()
  })

  it('drops a group entirely when its last carrying run unmounts (empty/offscreen groups paint nothing)', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    stubRect(header, { top: 100, bottom: 132 })
    const listener = vi.fn()
    manager.subscribe('seg-a', listener)
    const unregister = manager.registerRun('seg-a', header, { isHeader: true, endsGroup: true })
    manager.measure()
    expect(manager.getGeometry('seg-a')).not.toBeNull()

    unregister()
    expect(manager.getGeometry('seg-a')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    manager.suspend()
  })

  it('reports no geometry for a group with no mounted run', () => {
    const manager = createSegmentGroupLayoutManager()
    manager.measure()
    expect(manager.getGeometry('seg-missing')).toBeNull()
    manager.suspend()
  })
})

/**
 * Route-reactivation lifecycle. React Activity hides Home (Settings active) by
 * tearing the hidden subtree's effects down while keeping component state,
 * refs and DOM, and StrictMode replays the same mount → cleanup → mount cycle.
 * Both reuse the SAME provider instance, so an effect cleanup is an
 * activation teardown, not the manager's death. A manager disposed there left
 * returning runs in a dead registry — the empty rail reported after Home came
 * back.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  readonly observed = new Set<Element>()
  disconnects = 0

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.add(element)
  }

  unobserve(element: Element): void {
    this.observed.delete(element)
  }

  disconnect(): void {
    this.observed.clear()
    this.disconnects += 1
  }
}

const RUN_HEADER_RECT = { top: 100, bottom: 132 }
const RUN_TAIL_RECT = { top: 200, bottom: 400 }
/** 400 − 100 (span start) − 28 (rail top) − 12 (tail trim). */
const EXPECTED_RAIL_GEOMETRY = '28:260'

let pendingFrames: number[] = []
let frameSeed = 0

const RunHostProbe = ({
  groupId,
  rect,
  isHeader,
  endsGroup
}: {
  groupId: string
  rect: { top: number; bottom: number }
  isHeader: boolean
  endsGroup: boolean
}) => {
  const manager = useSegmentGroupLayoutManager()
  const elementRef = useRef<HTMLDivElement | null>(null)

  // jsdom reports no layout: stub the host rect before registration so the
  // measured span is deterministic instead of zero.
  useLayoutEffect(() => {
    if (elementRef.current) stubRect(elementRef.current, rect)
  })

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!manager || !element) return
    return manager.registerRun(groupId, element, { isHeader, endsGroup })
  }, [manager, groupId, isHeader, endsGroup])

  return <div ref={elementRef} />
}

const RailGeometryProbe = ({ groupId }: { groupId: string }) => {
  const geometry = useSegmentGroupGeometry(groupId)
  return <output data-testid="rail-geometry">{geometry ? `${geometry.top}:${geometry.height}` : 'none'}</output>
}

const ManagerProbe = ({ sink }: { sink: { current: SegmentGroupLayoutManager | null } }) => {
  sink.current = useSegmentGroupLayoutManager()
  return null
}

const SegmentGroupFlow = ({ sink }: { sink: { current: SegmentGroupLayoutManager | null } }) => (
  <SegmentGroupPresentationProvider>
    <ManagerProbe sink={sink} />
    <RunHostProbe groupId="seg-a" rect={RUN_HEADER_RECT} isHeader endsGroup={false} />
    <RunHostProbe groupId="seg-a" rect={RUN_TAIL_RECT} isHeader={false} endsGroup />
    <RailGeometryProbe groupId="seg-a" />
  </SegmentGroupPresentationProvider>
)

describe('segment group presentation across route reactivation', () => {
  const realResizeObserver = globalThis.ResizeObserver
  const realRequestAnimationFrame = globalThis.requestAnimationFrame
  const realCancelAnimationFrame = globalThis.cancelAnimationFrame

  beforeEach(() => {
    FakeResizeObserver.instances = []
    pendingFrames = []
    frameSeed = 0
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.stubGlobal('requestAnimationFrame', () => {
      frameSeed += 1
      pendingFrames.push(frameSeed)
      return frameSeed
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pendingFrames = pendingFrames.filter((pending) => pending !== id)
    })
  })

  afterEach(() => {
    vi.stubGlobal('ResizeObserver', realResizeObserver)
    vi.stubGlobal('requestAnimationFrame', realRequestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', realCancelAnimationFrame)
  })

  it('treats an activation teardown as reversible: the suspended manager takes returning runs again', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    const tail = makeHost()
    stubRect(header, RUN_HEADER_RECT)
    stubRect(tail, RUN_TAIL_RECT)
    manager.registerRun('seg-a', header, { isHeader: true, endsGroup: false })
    manager.registerRun('seg-a', tail, { isHeader: false, endsGroup: true })
    manager.measure()
    expect(manager.getGeometry('seg-a')).toEqual({ top: SEGMENT_GROUP_RAIL_TOP_PX, height: 260 })

    // Activity hide / StrictMode replay: the instance is paused, not killed.
    manager.suspend()
    expect(manager.getGeometry('seg-a')).toBeNull()

    const returningHeader = makeHost()
    const returningTail = makeHost()
    stubRect(returningHeader, RUN_HEADER_RECT)
    stubRect(returningTail, RUN_TAIL_RECT)
    const listener = vi.fn()
    manager.subscribe('seg-a', listener)
    manager.registerRun('seg-a', returningHeader, { isHeader: true, endsGroup: false })
    manager.registerRun('seg-a', returningTail, { isHeader: false, endsGroup: true })
    manager.measure()
    expect(manager.getGeometry('seg-a')).toBeNull()
    expect(listener).not.toHaveBeenCalled()

    // Return: the same instance observes and republishes the full span.
    manager.resume()
    manager.measure()
    expect(manager.getGeometry('seg-a')).toEqual({ top: SEGMENT_GROUP_RAIL_TOP_PX, height: 260 })
    expect(listener).toHaveBeenCalledTimes(1)
    manager.suspend()
  })

  it('Home → Settings → Home keeps the ONE group rail measurable on every return, with one observer per activation', async () => {
    const sink: { current: SegmentGroupLayoutManager | null } = { current: null }
    const { rerender } = render(
      <Activity mode="visible">
        <SegmentGroupFlow sink={sink} />
      </Activity>
    )
    expect(screen.getByTestId('rail-geometry').textContent).toBe(EXPECTED_RAIL_GEOMETRY)
    const manager = sink.current
    expect(manager?.getGeometry('seg-a')).toEqual({ top: SEGMENT_GROUP_RAIL_TOP_PX, height: 260 })
    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances[0]?.observed.size).toBe(2)

    for (let activation = 1; activation <= 3; activation += 1) {
      // Navigate away (Settings): Home is hidden, effects torn down.
      await act(async () => {
        rerender(
          <Activity mode="hidden">
            <SegmentGroupFlow sink={sink} />
          </Activity>
        )
      })
      expect(sink.current).toBe(manager)
      expect(manager?.getGeometry('seg-a')).toBeNull()
      expect(FakeResizeObserver.instances[activation - 1]?.disconnects).toBe(1)
      expect(pendingFrames).toEqual([])

      // Navigate back (Home, no reload): the SAME manager takes fresh
      // registrations and republishes the full geometry before paint.
      await act(async () => {
        rerender(
          <Activity mode="visible">
            <SegmentGroupFlow sink={sink} />
          </Activity>
        )
      })
      expect(sink.current).toBe(manager)
      expect(screen.getByTestId('rail-geometry').textContent).toBe(EXPECTED_RAIL_GEOMETRY)
      expect(manager?.getGeometry('seg-a')).toEqual({ top: SEGMENT_GROUP_RAIL_TOP_PX, height: 260 })
      expect(FakeResizeObserver.instances).toHaveLength(activation + 1)
      expect(FakeResizeObserver.instances[activation]?.observed.size).toBe(2)
    }
  })

  it('survives the StrictMode setup → cleanup → setup replay with the same live manager', () => {
    const sink: { current: SegmentGroupLayoutManager | null } = { current: null }
    render(
      <StrictMode>
        <SegmentGroupFlow sink={sink} />
      </StrictMode>
    )
    expect(screen.getByTestId('rail-geometry').textContent).toBe(EXPECTED_RAIL_GEOMETRY)
    expect(sink.current?.getGeometry('seg-a')).toEqual({ top: SEGMENT_GROUP_RAIL_TOP_PX, height: 260 })
    // The replayed activation was disconnected exactly once; only the live one
    // still observes the two carrying runs (no observer leak).
    const observing = FakeResizeObserver.instances.filter((observer) => observer.observed.size === 2)
    expect(observing).toHaveLength(1)
    expect(
      FakeResizeObserver.instances.filter((observer) => observer.observed.size === 0 && observer.disconnects === 1)
    ).toHaveLength(1)
  })
})
