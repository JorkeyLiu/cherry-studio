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
    manager.registerRun('seg-a', header, { runId: 'run-header', isHeader: true, endsGroup: false })
    manager.registerRun('seg-a', lower, { runId: 'run-carrier', isHeader: false, endsGroup: true })
    manager.measure()

    expect(manager.getGeometry('seg-a')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 400 - 100 - SEGMENT_GROUP_RAIL_TOP_PX - SEGMENT_GROUP_RAIL_TAIL_TRIM_PX,
      anchorRunId: 'run-header'
    })
    manager.suspend()
  })

  it('keeps measuring the same one group across a divider split (two runs, one span, no tail trim)', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    const lower = makeHost()
    stubRect(header, { top: 100, bottom: 132 })
    stubRect(lower, { top: 260, bottom: 360 })
    manager.registerRun('seg-a', header, { runId: 'run-header', isHeader: true, endsGroup: false })
    manager.registerRun('seg-a', lower, { runId: 'run-carrier', isHeader: false, endsGroup: false })
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
    manager.registerRun('seg-a', header, { runId: 'run-header', isHeader: true, endsGroup: true })
    manager.registerRun('seg-a', lower, { runId: 'run-carrier', isHeader: false, endsGroup: true })
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

  it('anchors a headed group at its stable header run (start mounted in-window)', () => {
    const manager = createSegmentGroupLayoutManager()
    // The run mounting the route-stable start registers `isHeader: true` and
    // is the anchor the rail is measured from; the other carrier only widens
    // the span.
    const header = makeHost()
    const lower = makeHost()
    stubRect(header, { top: 100, bottom: 132 })
    stubRect(lower, { top: 200, bottom: 380 })
    manager.registerRun('seg-partial', header, { runId: 'run-header', isHeader: true, endsGroup: false })
    manager.registerRun('seg-partial', lower, { runId: 'run-carrier', isHeader: false, endsGroup: false })
    manager.measure()

    // One span, no tail trim (the group's authority last member is outside the
    // mounted window), and the anchor is the header run itself.
    expect(manager.getGeometry('seg-partial')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 380 - 100 - SEGMENT_GROUP_RAIL_TOP_PX,
      anchorRunId: 'run-header'
    })
    manager.suspend()
  })

  it('measures a headless group from its continuation carriers (rail geometry, zero header occupancy)', () => {
    const manager = createSegmentGroupLayoutManager()
    // No run mounts the route-stable start: BOTH carriers register
    // `isHeader: false`. The manager still publishes the full span anchored
    // at the topmost carrier — the rail-only continuation geometry — while no
    // header run exists to occupy a 32px row.
    const topCarrier = makeHost()
    const lowerCarrier = makeHost()
    stubRect(topCarrier, { top: 100, bottom: 160 })
    stubRect(lowerCarrier, { top: 200, bottom: 380 })
    manager.registerRun('seg-headless', topCarrier, { runId: 'run-top', isHeader: false, endsGroup: false })
    manager.registerRun('seg-headless', lowerCarrier, { runId: 'run-lower', isHeader: false, endsGroup: false })
    manager.measure()

    expect(manager.getGeometry('seg-headless')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 380 - 100 - SEGMENT_GROUP_RAIL_TOP_PX,
      anchorRunId: 'run-top'
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
    manager.registerRun('seg-a', header, { runId: 'run-header', isHeader: true, endsGroup: true })
    manager.registerRun('seg-a', lower, { runId: 'run-carrier', isHeader: false, endsGroup: true })
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
    const unregister = manager.registerRun('seg-a', header, { runId: 'run-header', isHeader: true, endsGroup: true })
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

  /**
   * A collapsed fold block carries a group whose body rows are gone (the run
   * hosts keep their place in flow but contribute no height), so the group's
   * mounted extent is the block's summary row ABOVE the header. The summary
   * registers as a range member: it widens the measured span, it never becomes
   * the header and never ends the group. Without it the rail measured a
   * zero-length line inside the header row.
   */
  it('measures a collapsed block from the range member above the header, not a zero-length rail', () => {
    const manager = createSegmentGroupLayoutManager()
    const summary = makeHost()
    const header = makeHost()
    const emptyBodyHost = makeHost()
    stubRect(summary, { top: 309.55, bottom: 335.55 })
    stubRect(header, { top: 341.55, bottom: 373.55 })
    stubRect(emptyBodyHost, { top: 341.55, bottom: 341.55 })
    manager.registerRangeMember('seg-folded', summary)
    manager.registerRun('seg-folded', header, { runId: 'run-header', isHeader: true, endsGroup: false })
    manager.registerRun('seg-folded', emptyBodyHost, { runId: 'run-carrier', isHeader: false, endsGroup: true })
    manager.measure()

    const geometry = manager.getGeometry('seg-folded')!
    // The rail starts at the summary (negative relative to the header row) and
    // covers the summary plus the header row, trimmed above the group's end.
    expect(geometry.top).toBeCloseTo(309.55 - 341.55, 5)
    expect(geometry.height).toBeCloseTo(373.55 - 309.55 - SEGMENT_GROUP_RAIL_TAIL_TRIM_PX, 5)
    expect(geometry.height).toBeGreaterThan(0)
    manager.suspend()
  })

  it('re-measures the span from live rects, so the rail follows a growing range member', () => {
    const manager = createSegmentGroupLayoutManager()
    const summary = makeHost()
    const header = makeHost()
    stubRect(summary, { top: 320, bottom: 340 })
    stubRect(header, { top: 350, bottom: 382 })
    manager.registerRangeMember('seg-folded', summary)
    manager.registerRun('seg-folded', header, { runId: 'run-header', isHeader: true, endsGroup: false })
    manager.measure()
    expect(manager.getGeometry('seg-folded')!.top).toBeCloseTo(-30, 5)

    // Nothing static: the range member's own new geometry is what the next
    // pass reads (its ResizeObserver entry or the commit-time pass).
    stubRect(summary, { top: 280, bottom: 340 })
    manager.measure()
    expect(manager.getGeometry('seg-folded')!.top).toBeCloseTo(-70, 5)
    expect(manager.getGeometry('seg-folded')!.height).toBeCloseTo(382 - 280, 5)
    manager.suspend()
  })

  it('restores the run-only span when the range member leaves (the block expanded)', () => {
    const manager = createSegmentGroupLayoutManager()
    const summary = makeHost()
    const header = makeHost()
    stubRect(summary, { top: 309.55, bottom: 335.55 })
    stubRect(header, { top: 341.55, bottom: 373.55 })
    const unregister = manager.registerRangeMember('seg-folded', summary)
    manager.registerRun('seg-folded', header, { runId: 'run-header', isHeader: true, endsGroup: true })
    manager.measure()
    expect(manager.getGeometry('seg-folded')!.top).toBeLessThan(0)

    unregister()
    manager.measure()
    // Run-only span restored: the rail starts at the pill top and covers the
    // run below it, trimmed above the group's end.
    expect(manager.getGeometry('seg-folded')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 373.55 - (341.55 + SEGMENT_GROUP_RAIL_TOP_PX) - SEGMENT_GROUP_RAIL_TAIL_TRIM_PX,
      anchorRunId: 'run-header'
    })
    // The group itself is untouched: its run still owns the chrome and geometry.
    expect(manager.getGeometry('seg-folded')).not.toBeNull()
    manager.suspend()
  })

  it('never lets a range member own a group: no carrying run, no header, no menu anchor', () => {
    const manager = createSegmentGroupLayoutManager()
    const summary = makeHost()
    stubRect(summary, { top: 100, bottom: 140 })
    manager.registerRangeMember('seg-bodyless', summary)
    manager.measure()
    expect(manager.getGeometry('seg-bodyless')).toBeNull()
    manager.suspend()
  })
})
describe('segment group anchor identity', () => {
  it('anchors headless geometry to the geometric topmost run, not the first registered', () => {
    const manager = createSegmentGroupLayoutManager()
    const first = makeHost()
    const second = makeHost()
    stubRect(first, { top: 200, bottom: 380 })
    stubRect(second, { top: 100, bottom: 160 })
    manager.registerRun('seg-swap', first, { runId: 'run-first', isHeader: false, endsGroup: false })
    manager.registerRun('seg-swap', second, { runId: 'run-second', isHeader: false, endsGroup: true })
    manager.measure()
    const geometry = manager.getGeometry('seg-swap')!
    expect(geometry.anchorRunId).toBe('run-second')
    expect(geometry.top).toBe(SEGMENT_GROUP_RAIL_TOP_PX)
    expect(geometry.height).toBe(380 - 100 - SEGMENT_GROUP_RAIL_TOP_PX - SEGMENT_GROUP_RAIL_TAIL_TRIM_PX)
    manager.suspend()
  })
  it('notifies when the anchor identity changes while top and height stay equal', () => {
    const manager = createSegmentGroupLayoutManager()
    const runA = makeHost()
    const runB = makeHost()
    stubRect(runA, { top: 100, bottom: 260 })
    stubRect(runB, { top: 200, bottom: 260 })
    const listener = vi.fn()
    manager.subscribe('seg-move', listener)
    manager.registerRun('seg-move', runA, { runId: 'run-a', isHeader: false, endsGroup: true })
    manager.registerRun('seg-move', runB, { runId: 'run-b', isHeader: false, endsGroup: true })
    manager.measure()
    expect(listener).toHaveBeenCalledTimes(1)
    const before = manager.getGeometry('seg-move')!
    expect(before.anchorRunId).toBe('run-a')
    stubRect(runA, { top: 200, bottom: 260 })
    stubRect(runB, { top: 100, bottom: 260 })
    manager.measure()
    const after = manager.getGeometry('seg-move')!
    expect(after.top).toBe(before.top)
    expect(after.height).toBe(before.height)
    expect(after.anchorRunId).toBe('run-b')
    expect(listener).toHaveBeenCalledTimes(2)
    manager.suspend()
  })
  it('drops the publication synchronously when the anchor unmounts, then re-elects the survivor', () => {
    const manager = createSegmentGroupLayoutManager()
    const runA = makeHost()
    const runB = makeHost()
    stubRect(runA, { top: 100, bottom: 200 })
    stubRect(runB, { top: 200, bottom: 380 })
    const listener = vi.fn()
    manager.subscribe('seg-drop', listener)
    const unregisterA = manager.registerRun('seg-drop', runA, { runId: 'run-a', isHeader: false, endsGroup: false })
    manager.registerRun('seg-drop', runB, { runId: 'run-b', isHeader: false, endsGroup: true })
    manager.measure()
    expect(manager.getGeometry('seg-drop')?.anchorRunId).toBe('run-a')
    expect(listener).toHaveBeenCalledTimes(1)
    unregisterA()
    expect(manager.getGeometry('seg-drop')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    manager.measure()
    expect(manager.getGeometry('seg-drop')?.anchorRunId).toBe('run-b')
    expect(listener).toHaveBeenCalledTimes(3)
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
/** Rail top sits at the pill top (anchor 100 + band 10 = 110): 400 − 110 − 12 (tail trim). */
const EXPECTED_RAIL_GEOMETRY = '10:278'

let pendingFrames: number[] = []
let frameSeed = 0

const RunHostProbe = ({
  groupId,
  rect,
  isHeader,
  endsGroup,
  runId
}: {
  groupId: string
  rect: { top: number; bottom: number }
  isHeader: boolean
  endsGroup: boolean
  runId: string
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
    return manager.registerRun(groupId, element, { isHeader, endsGroup, runId })
  }, [manager, groupId, isHeader, endsGroup, runId])

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
    <RunHostProbe groupId="seg-a" rect={RUN_HEADER_RECT} isHeader endsGroup={false} runId="run-header" />
    <RunHostProbe groupId="seg-a" rect={RUN_TAIL_RECT} isHeader={false} endsGroup runId="run-tail" />
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
    manager.registerRun('seg-a', header, { runId: 'run-header', isHeader: true, endsGroup: false })
    manager.registerRun('seg-a', tail, { runId: 'run-carrier', isHeader: false, endsGroup: true })
    manager.measure()
    expect(manager.getGeometry('seg-a')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 278,
      anchorRunId: 'run-header'
    })

    // Activity hide / StrictMode replay: the instance is paused, not killed.
    manager.suspend()
    expect(manager.getGeometry('seg-a')).toBeNull()

    const returningHeader = makeHost()
    const returningTail = makeHost()
    stubRect(returningHeader, RUN_HEADER_RECT)
    stubRect(returningTail, RUN_TAIL_RECT)
    const listener = vi.fn()
    manager.subscribe('seg-a', listener)
    manager.registerRun('seg-a', returningHeader, { runId: 'run-header', isHeader: true, endsGroup: false })
    manager.registerRun('seg-a', returningTail, { runId: 'run-carrier', isHeader: false, endsGroup: true })
    manager.measure()
    expect(manager.getGeometry('seg-a')).toBeNull()
    expect(listener).not.toHaveBeenCalled()

    // Return: the same instance observes and republishes the full span.
    manager.resume()
    manager.measure()
    expect(manager.getGeometry('seg-a')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 278,
      anchorRunId: 'run-header'
    })
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
    expect(manager?.getGeometry('seg-a')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 278,
      anchorRunId: 'run-header'
    })
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
      expect(manager?.getGeometry('seg-a')).toEqual({
        top: SEGMENT_GROUP_RAIL_TOP_PX,
        height: 278,
        anchorRunId: 'run-header'
      })
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
    expect(sink.current?.getGeometry('seg-a')).toEqual({
      top: SEGMENT_GROUP_RAIL_TOP_PX,
      height: 278,
      anchorRunId: 'run-header'
    })
    // The replayed activation was disconnected exactly once; only the live one
    // still observes the two carrying runs (no observer leak).
    const observing = FakeResizeObserver.instances.filter((observer) => observer.observed.size === 2)
    expect(observing).toHaveLength(1)
    expect(
      FakeResizeObserver.instances.filter((observer) => observer.observed.size === 0 && observer.disconnects === 1)
    ).toHaveLength(1)
  })
})

describe('segment group slot first message', () => {
  /**
   * The expanded pill shares the slot run's first message band, so exactly
   * that header indents by the pill width (see `MessageHeader`). The mapping
   * is the run's own first RENDERED message — never the authority
   * presentation start, which may belong to a later message when a segment
   * validly starts mid-turn (edit-mode selection groups arbitrary subsets).
   */
  const messageChild = (id: string) => {
    const child = document.createElement('div')
    child.setAttribute('data-message-id', id)
    return child
  }

  it('publishes the header run first rendered message, so exactly that header indents', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    header.appendChild(messageChild('m-a'))
    header.appendChild(messageChild('m-b'))
    manager.registerRun('seg-slot', header, { runId: 'run-header', isHeader: true, endsGroup: true })
    manager.measure()
    expect(manager.getSlotFirstMessageId('seg-slot')).toBe('m-a')
    manager.suspend()
  })

  it('reads the run own first message even when the authority start belongs to a later one (mid-turn group start)', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    header.appendChild(messageChild('m-run-first'))
    header.appendChild(messageChild('m-authority-start'))
    manager.registerRun('seg-midturn', header, { runId: 'run-header', isHeader: true, endsGroup: true })
    manager.measure()
    // The pill hangs at the run top; the later authority id never wins.
    expect(manager.getSlotFirstMessageId('seg-midturn')).toBe('m-run-first')
    manager.suspend()
  })

  it('publishes null when the header run renders no message (a collapsed browse block indents nothing)', () => {
    const manager = createSegmentGroupLayoutManager()
    const header = makeHost()
    manager.registerRun('seg-collapsed', header, { runId: 'run-header', isHeader: true, endsGroup: true })
    manager.measure()
    expect(manager.getSlotFirstMessageId('seg-collapsed')).toBeNull()
    manager.suspend()
  })

  it('ignores non-header carriers and clears the slot first when the header run unmounts', () => {
    const manager = createSegmentGroupLayoutManager()
    const carrier = makeHost()
    carrier.appendChild(messageChild('m-tail'))
    manager.registerRun('seg-tail', carrier, { runId: 'run-carrier', isHeader: false, endsGroup: true })
    manager.measure()
    expect(manager.getSlotFirstMessageId('seg-tail')).toBeNull()

    const header = makeHost()
    header.appendChild(messageChild('m-head'))
    const unregister = manager.registerRun('seg-tail', header, {
      runId: 'run-header',
      isHeader: true,
      endsGroup: false
    })
    manager.measure()
    expect(manager.getSlotFirstMessageId('seg-tail')).toBe('m-head')

    unregister()
    manager.measure()
    expect(manager.getSlotFirstMessageId('seg-tail')).toBeNull()
    manager.suspend()
  })
})
