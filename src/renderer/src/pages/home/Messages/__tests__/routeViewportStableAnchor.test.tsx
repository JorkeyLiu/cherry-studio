/**
 * Stable visual anchor behavior (keeper + controller integration):
 * - a stable anchor survives a 1033px sibling insert above it: the keeper
 *   compensates scrollTop so the target offset holds, with no rAF polling;
 * - the anchor survives a window/content-height expansion the same way;
 * - same-route window 16→28 with row replacement + 12 rows above: the
 *   generation notify re-resolves the new same-id row in layout phase and a
 *   no-intent scroll holds once (1033px), with no takeover/snapshot change;
 * - genuine user input (wheel) stops compensation and the real scroll result
 *   becomes the new stable anchor (which then keeps holding);
 * - no-history top restores take the deterministic bottom default;
 * - divider restores keep the clicked offset through searching/pagination.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RouteViewportContext,
  type RouteViewportContextValue,
  type StableVisualAnchorMaintainer,
  useStableVisualAnchor
} from '../routeViewportContext'
import { RouteViewportController } from '../routeViewportController'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

let store: Map<string, unknown>

const installKeyv = (): void => {
  // Patch keyv onto the real window (never replace window: jsdom locals like
  // getComputedStyle must survive for the visibility helpers).
  ;(window as unknown as { keyv: unknown }).keyv = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
    remove: (key: string) => {
      store.delete(key)
    }
  }
  const CSSApi = (globalThis as unknown as { CSS?: { escape?: (v: string) => string } }).CSS
  if (!CSSApi?.escape) {
    vi.stubGlobal('CSS', { escape: (v: string) => v })
  }
}

const removeKeyv = (): void => {
  try {
    delete (window as unknown as { keyv?: unknown }).keyv
  } catch {}
}

interface RectSpec {
  top: number
  height: number
}

const rects = new Map<string, RectSpec>()
const containerRect = { top: 0, height: 600 }

const mockRect = (el: HTMLElement, key: string): void => {
  el.getBoundingClientRect = () => {
    if (key === 'container') {
      return {
        top: containerRect.top,
        bottom: containerRect.top + containerRect.height,
        height: containerRect.height,
        left: 0,
        right: 300,
        width: 300,
        x: 0,
        y: containerRect.top,
        toJSON: () => ({})
      } as DOMRect
    }
    const spec = rects.get(key) ?? { top: 0, height: 40 }
    return {
      top: spec.top,
      bottom: spec.top + spec.height,
      height: spec.height,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: spec.top,
      toJSON: () => ({})
    } as DOMRect
  }
}

const buildSurface = (): { container: HTMLDivElement; ref: { current: HTMLDivElement | null } } => {
  const container = document.createElement('div')
  container.id = 'messages-test-surface'
  mockRect(container, 'container')
  Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
  Object.defineProperty(container, 'scrollHeight', { value: 2000, writable: true, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
  for (const id of ['m1', 'm2', 'm3']) {
    const row = document.createElement('div')
    row.id = `message-${id}`
    row.setAttribute('data-message-id', id)
    mockRect(row, id)
    container.append(row)
  }
  document.body.append(container)
  return { container, ref: { current: container } }
}

const buildAnchorSurface = (
  anchorId: string,
  siblings: string[] = ['sib-before', 'sib-after']
): { container: HTMLDivElement; ref: { current: HTMLDivElement | null } } => {
  const container = document.createElement('div')
  container.id = 'messages'
  mockRect(container, 'container')
  Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
  Object.defineProperty(container, 'scrollHeight', { value: 4000, writable: true, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
  const before = document.createElement('div')
  before.id = `message-${siblings[0]}`
  before.setAttribute('data-message-id', siblings[0])
  mockRect(before, siblings[0])
  const anchor = document.createElement('div')
  anchor.id = `message-${anchorId}`
  anchor.setAttribute('data-message-id', anchorId)
  mockRect(anchor, anchorId)
  const after = document.createElement('div')
  after.id = `message-${siblings[1]}`
  after.setAttribute('data-message-id', siblings[1])
  mockRect(after, siblings[1])
  container.append(before, anchor, after)
  document.body.append(container)
  return { container, ref: { current: container } }
}

const driveStableMessage = (controller: RouteViewportController, messageId: string, offset: number): void => {
  const { epoch } = controller.request({
    kind: 'top',
    topicId: 't1',
    targetRoute: null,
    saved: { scrollTop: -400, messageId, intraRowOffset: offset, isAtBottom: false }
  })
  controller.appliedWindow(epoch)
  controller.firstPositioned(epoch, 'placed')
  controller.revealed(epoch)
  const out = controller.commitStable(epoch, { messageId, intraRowOffset: offset, scrollTop: -400, isAtBottom: false })
  expect(out.committed).toBe(true)
}

// --- Fake observers (spy binding, still event-driven, no timers) ---

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed = new Set<Element>()
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    FakeResizeObserver.instances.push(this)
  }
  observe = (el: Element): void => {
    this.observed.add(el)
  }
  unobserve = (el: Element): void => {
    this.observed.delete(el)
  }
  disconnect = (): void => {
    this.observed.clear()
  }
  fire = (): void => {
    this.cb([], this as unknown as ResizeObserver)
  }
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = []
  observed: { target: Element; options: MutationObserverInit }[] = []
  private cb: MutationCallback
  constructor(cb: MutationCallback) {
    this.cb = cb
    FakeMutationObserver.instances.push(this)
  }
  observe = (target: Element, options: MutationObserverInit): void => {
    this.observed.push({ target, options })
  }
  disconnect = (): void => {
    this.observed = []
  }
  fire = (): void => {
    this.cb([], this as unknown as MutationObserver)
  }
  takeRecords = (): MutationRecord[] => []
}

const installFakeObservers = (): void => {
  FakeResizeObserver.instances = []
  FakeMutationObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('MutationObserver', FakeMutationObserver)
}
/**
 * Render the production keeper. `maintainer` receives the live maintainer object
 * so a test can drive the same bridge Messages uses (`publishAnchorSample`).
 */
const renderKeeper = (
  controller: RouteViewportController,
  ref: { current: HTMLDivElement | null },
  version: number,
  notify: () => void,
  maintainer?: { current: StableVisualAnchorMaintainer | null }
): { rerender: (version: number) => void; unmount: () => void } => {
  const Harness = ({ containerRef }: { containerRef: { current: HTMLDivElement | null } }) => {
    const live = useStableVisualAnchor(containerRef as React.RefObject<HTMLElement | null>)
    if (maintainer) maintainer.current = live
    return null
  }
  const value = (v: number): RouteViewportContextValue => ({
    controller,
    version: v,
    connectionGeneration: 0,
    notifyChanged: notify,
    freezeDisplayed: () => false,
    readSnapshot: () => null,
    requestTopRoute: () => ({ epoch: controller.currentEpoch, fresh: true }),
    registerCapturer: () => {},
    viewportPhaseAttr: 'revealed'
  })
  const rendered = render(
    <RouteViewportContext value={value(version)}>
      <Harness containerRef={ref} />
    </RouteViewportContext>
  )
  return {
    rerender: (v: number) => {
      rendered.rerender(
        <RouteViewportContext value={value(v)}>
          <Harness containerRef={ref} />
        </RouteViewportContext>
      )
    },
    unmount: () => rendered.unmount()
  }
}

beforeEach(() => {
  store = new Map()
  rects.clear()
  containerRect.top = 0
  containerRect.height = 600
  document.body.innerHTML = ''
  installKeyv()
  installFakeObservers()
  vi.useFakeTimers()
})

afterEach(() => {
  removeKeyv()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('stable anchor holds across layout growth (no polling)', () => {
  it('1033px sibling inserted above the anchor keeps the target offset', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    // m2 sits at the anchor offset; m1 above, m3 below.
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const notify = vi.fn()
    const keeper = renderKeeper(controller, ref, 0, notify)
    expect(container.scrollTop).toBe(0)

    // A 1033px sibling mounts above m2 (projection growth): m2 is pushed to
    // 973 while the anchor still demands -60.
    act(() => {
      rects.set('m1', { top: -460, height: 1433 })
      rects.set('m2', { top: 973, height: 40 })
      rects.set('m3', { top: 1013, height: 400 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    // The anchor identity is unchanged: it is still the continuing anchor.
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    // Scrolling moved the row back under the anchor in real geometry; model
    // that, then verify no further drift on the next observation.
    act(() => {
      rects.set('m2', { top: -60, height: 40 })
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(1033)
    keeper.unmount()
  })

  it('window/content-height expansion keeps the anchor without user input', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    // Content below grows and pushes nothing above, then an above-the-fold
    // image resolves and shifts m2 down by 220px.
    act(() => {
      containerRect.height = 900
      rects.set('m2', { top: 160, height: 40 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(220)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })
})

describe('same-route window 16→28 full event loop (row replacement + 12 rows)', () => {
  it('generation notify + no-intent scroll compensates 1033 without takeover/snapshot', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'aexcl06', -60)
    rects.set('sib-before', { top: -500, height: 400 })
    rects.set('aexcl06', { top: -60, height: 40 })
    rects.set('sib-after', { top: -20, height: 400 })
    const { container, ref } = buildAnchorSurface('aexcl06')
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)
    const takeoverSpy = vi.spyOn(controller, 'userTakeover')
    const gen0 = controller.windowGeneration

    // Same-route window 16→28: old row detaches, a new same-id row mounts,
    // 12 rows insert above pushing the live anchor from -60 to 973 (+1033).
    act(() => {
      const oldRow = container.querySelector('[data-message-id="aexcl06"]')
      oldRow?.remove()
      // 12 rows above (total 1033px) + the new same-id anchor row.
      let cursorTop = -500
      for (let i = 0; i < 12; i += 1) {
        const extra = document.createElement('div')
        const extraId = `above-${i}`
        extra.id = `message-${extraId}`
        extra.setAttribute('data-message-id', extraId)
        const h = i === 0 ? 133 : 82 + (i % 3)
        mockRect(extra, extraId)
        rects.set(extraId, { top: cursorTop, height: h })
        container.prepend(extra)
        cursorTop += h
      }
      const fresh = document.createElement('div')
      fresh.id = 'message-aexcl06'
      fresh.setAttribute('data-message-id', 'aexcl06')
      mockRect(fresh, 'aexcl06')
      const before = container.querySelector('[data-message-id="sib-before"]')
      if (before?.nextSibling) container.insertBefore(fresh, before.nextSibling)
      else container.append(fresh)
      rects.set('aexcl06', { top: 973, height: 40 })
      rects.set('sib-after', { top: 1013, height: 400 })
      // Same-route generation event (pagination/reconcile path).
      expect(controller.noteSameRouteWindowUpdate({ topicId: 't1', route: null }, 'oldest::newest::28')).toBe(true)
      expect(controller.windowGeneration).toBe(gen0 + 1)
      keeper.rerender(1)
    })
    // Layout-phase hold already compensated the detached→new row shift.
    expect(container.scrollTop).toBe(1033)
    // A no-intent programmatic scroll echo after the window refresh holds
    // without drifting (same hold, idempotent once geometry is modelled).
    act(() => {
      rects.set('aexcl06', { top: -60, height: 40 })
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(1033)
    // Target is back at its offset; identity/snapshot untouched.
    const live = container.querySelector('[data-message-id="aexcl06"]') as HTMLElement | null
    expect(live).not.toBeNull()
    expect(live?.isConnected).toBe(true)
    expect((live as HTMLElement).getBoundingClientRect().top - container.getBoundingClientRect().top).toBe(-60)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'aexcl06',
      offset: -60
    })
    expect(takeoverSpy).not.toHaveBeenCalled()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    takeoverSpy.mockRestore()
    keeper.unmount()
  })
})

describe('ordinary pagination commit and later geometry hold across a live browse session (layout space)', () => {
  it('prepaint same-identity hold applies at the commit instant and keeps holding later growth', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)

    // Continuous upward gesture still live (wheel bursts across fetch flight).
    controller.declareUserIntent()
    expect(controller.hasActiveUserInteraction()).toBe(true)

    // Older prepend commits: 1033px above m2 pushes it from -60 to 973.
    // Production publishes the precommit identity via adopt (same tick as the
    // window commit), then the generation notify drives the keeper prepaint.
    act(() => {
      rects.set('m1', { top: -460, height: 1433 })
      rects.set('m2', { top: 973, height: 40 })
      rects.set('m3', { top: 1013, height: 400 })
      expect(
        controller.adoptOrdinaryPaginationWindow({ topicId: 't1', route: null }, 'old::new::28', {
          messageId: 'm2',
          offset: -60
        })
      ).toBe(true)
      keeper.rerender(1)
    })
    // Held despite the live session: same reading identity, same offset.
    expect(container.scrollTop).toBe(1033)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    // The write landed: the real row is back under its held offset (the mock
    // models a keeper scroll write as the row's offset returning).
    act(() => {
      rects.set('m2', { top: -60, height: 40 })
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(1033)

    // Layout-space scope (no one-shot): LATER content growth in the same live
    // session is still held, so the reading identity does not drift while the
    // user keeps browsing across several fetches.
    act(() => {
      rects.set('m2', { top: 40, height: 40 })
      keeper.rerender(3)
    })
    expect(container.scrollTop).toBe(1133)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })

    // The user's OWN scroll inside the session is never cancelled: offset and
    // scrollTop move together by the same amount (pure scroll, Δoffset =
    // −ΔscrollTop in this container), which measures as zero layout
    // displacement — the hold writes nothing.
    act(() => {
      rects.set('m2', { top: -60, height: 40 })
      keeper.rerender(4)
    })
    expect(container.scrollTop).toBe(1133)
    act(() => {
      Object.defineProperty(container, 'scrollTop', { value: 1333, writable: true, configurable: true })
      rects.set('m2', { top: -260, height: 40 })
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(1333)

    // Layout growth on top of the user's own scroll: exactly the layout part is
    // held (+100 growth below the reading row), never the 200px the user moved.
    act(() => {
      rects.set('m2', { top: -160, height: 40 })
      keeper.rerender(5)
    })
    expect(container.scrollTop).toBe(1433)

    // The write landed (the row is back at its held offset).
    act(() => {
      rects.set('m2', { top: -260, height: 40 })
      keeper.rerender(6)
    })
    expect(container.scrollTop).toBe(1433)

    // After the gesture ends the live anchor still holds its layout position
    // (idempotent: nothing new to compensate, no snapshot fabricated here).
    act(() => {
      controller.noteInteractionScrollEnd()
      keeper.rerender(7)
    })
    expect(container.scrollTop).toBe(1433)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })

  it('pre-commit scroll/mutation observers cannot steal the one-shot from the matching layout commit', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    // Continuous upward gesture still live across the fetch flight.
    controller.declareUserIntent()
    expect(controller.hasActiveUserInteraction()).toBe(true)

    // Arm the commit-scoped hold WITHOUT driving the keeper layout yet (the
    // fetch resolved, the DOM has not committed): pre-growth geometry.
    expect(
      controller.adoptOrdinaryPaginationWindow({ topicId: 't1', route: null }, 'old::new::28', {
        messageId: 'm2',
        offset: -60
      })
    ).toBe(true)

    // Earlier scroll + resize + mutation callbacks on the pre-growth DOM must
    // neither consume the one-shot nor move the viewport.
    act(() => {
      container.dispatchEvent(new Event('scroll'))
      for (const ro of FakeResizeObserver.instances) ro.fire()
      for (const mo of FakeMutationObserver.instances) mo.fire()
    })
    expect(container.scrollTop).toBe(0)

    // The matching layout commit still holds: prepend growth above m2 pushes
    // it from -60 to 973 and the keeper compensates exactly once.
    act(() => {
      rects.set('m1', { top: -460, height: 1433 })
      rects.set('m2', { top: 973, height: 40 })
      rects.set('m3', { top: 1013, height: 400 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })

  it('late layout after the commit hold converges without swapping the reading identity', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    act(() => {
      rects.set('m1', { top: -460, height: 1433 })
      rects.set('m2', { top: 973, height: 40 })
      rects.set('m3', { top: 1013, height: 400 })
      expect(
        controller.adoptOrdinaryPaginationWindow({ topicId: 't1', route: null }, 'old::new::28', {
          messageId: 'm2',
          offset: -60
        })
      ).toBe(true)
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    // Late layout settles the row back under the held offset; the keeper
    // holds nothing further and the identity never swaps to a new oldest row.
    act(() => {
      rects.set('m2', { top: -60, height: 40 })
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(1033)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })
})

describe('layout-space hold symmetry, re-seed provenance and fail-closed recovery', () => {
  it('holds both displacement signs with the same rule (never a direction patch)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)

    // Reading row pushed DOWN by growth (positive layout displacement): the
    // keeper scrolls forward by exactly the growth.
    act(() => {
      rects.set('m2', { top: 120, height: 40 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(180)
    // The write landed.
    act(() => {
      rects.set('m2', { top: -60, height: 40 })
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(180)

    // Reading row pulled UP by growth on the other side (negative layout
    // displacement): the same rule scrolls back by the growth.
    act(() => {
      rects.set('m2', { top: -260, height: 40 })
      keeper.rerender(3)
    })
    expect(container.scrollTop).toBe(-20)
    // The write landed; the opposite sign is idempotent too.
    act(() => {
      rects.set('m2', { top: -60, height: 40 })
      keeper.rerender(4)
    })
    expect(container.scrollTop).toBe(-20)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })

  it('an anchor identity change re-seeds from the published offset (no compensation of the new row)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    // A genuine gesture (wheel declares the session) moves the reading row to
    // m3; offset and scrollTop move together, so the keeper writes nothing.
    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }))
    })
    expect(controller.userIntentPending).toBe(true)
    act(() => {
      Object.defineProperty(container, 'scrollTop', { value: 400, writable: true, configurable: true })
      rects.set('m2', { top: -460, height: 40 })
      rects.set('m3', { top: -15, height: 40 })
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(400)
    // The atomic takeover then publishes m3 as the new live anchor.
    const token = controller.activeInteractionToken
    const out = controller.userTakeover(
      { messageId: 'm3', intraRowOffset: -15, scrollTop: 400, isAtBottom: false },
      undefined,
      token ?? undefined
    )
    expect(out.taken).toBe(true)
    // The new identity is seeded from its own published offset: the keeper does
    // not treat the identity change itself as a layout displacement.
    act(() => {
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(400)
    // Real growth under the new identity is then held normally.
    act(() => {
      rects.set('m3', { top: 85, height: 40 })
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(500)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm3',
      offset: -15
    })
    keeper.unmount()
  })

  it('an unmeasurable anchor row drops the baseline and re-seeds fail-closed', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)

    // The anchor row is gone (window rebuild in flight): nothing is measured,
    // nothing is written, and the stale baseline is dropped.
    act(() => {
      const row = container.querySelector('[data-message-id="m2"]')
      row?.remove()
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(0)

    // The same identity comes back at a shifted offset: the hold re-seeds from
    // the controller's anchor instead of compensating against a stale baseline.
    act(() => {
      const fresh = document.createElement('div')
      fresh.id = 'message-m2'
      fresh.setAttribute('data-message-id', 'm2')
      mockRect(fresh, 'm2')
      rects.set('m2', { top: 120, height: 40 })
      container.prepend(fresh)
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(180)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })
})

describe('keeper event model (generation / scroll / rebind / gates)', () => {
  it('first mount binds container + content wrapper + live anchor row', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    const ro = FakeResizeObserver.instances[0]
    expect(ro).toBeDefined()
    const observed = [...ro.observed]
    expect(observed).toContain(container)
    expect(observed).toContain(container.firstElementChild as Element)
    const anchorRow = container.querySelector('[data-message-id="m2"]')
    expect(anchorRow).not.toBeNull()
    expect(observed).toContain(anchorRow as Element)
    // MutationObserver watches structure (childList/subtree/characterData).
    const mo = FakeMutationObserver.instances[0]
    expect(mo).toBeDefined()
    expect(mo.observed[0]?.target).toBe(container)
    expect(mo.observed[0]?.options).toMatchObject({ childList: true, subtree: true, characterData: true })
    keeper.unmount()
  })

  it('DOM row replacement with the same id rebinds the new connected element', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    const oldRow = container.querySelector('[data-message-id="m2"]') as HTMLElement
    expect(FakeResizeObserver.instances[0].observed.has(oldRow)).toBe(true)
    act(() => {
      oldRow.remove()
      const fresh = document.createElement('div')
      fresh.id = 'message-m2'
      fresh.setAttribute('data-message-id', 'm2')
      mockRect(fresh, 'm2')
      rects.set('m2', { top: 973, height: 40 })
      const after = container.querySelector('[data-message-id="m3"]')
      container.insertBefore(fresh, after)
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    const liveRO = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1]
    expect(liveRO.observed.has(oldRow)).toBe(false)
    const freshRow = container.querySelector('[data-message-id="m2"]') as HTMLElement
    expect(freshRow.isConnected).toBe(true)
    expect(liveRO.observed.has(freshRow)).toBe(true)
    keeper.unmount()
  })

  it('no-intent scroll alone triggers the same hold (no generation bump needed)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)
    act(() => {
      rects.set('m2', { top: 160, height: 40 })
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(220)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })

  it('self compensation echo does not recurse', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      rects.set('m2', { top: 973, height: 40 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    // The compensation write itself emits a scroll echo at the expected
    // position: it must be swallowed, never compensated twice.
    act(() => {
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(1033)
    keeper.unmount()
  })

  it('live user session: layout growth is held at once, the self scroll echo is not re-compensated', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }))
    })
    expect(controller.userIntentPending).toBe(true)
    // Layout growth DURING the live gesture holds immediately (the correction is
    // layout-only, so it cannot cancel the gesture's own movement).
    act(() => {
      rects.set('m2', { top: 973, height: 40 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    // The write landed (the row is back under its held offset); the scroll echo
    // the keeper's own write produced is swallowed, never compensated twice.
    act(() => {
      rects.set('m2', { top: -60, height: 40 })
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(1033)
    act(() => {
      expect(controller.noteInteractionScrollEnd()).toBe(true)
    })
    act(() => {
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(1033)
    keeper.unmount()
  })

  it('generation notify holds even when observers are unavailable', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    // Observers throw at construction: the layout-phase hold must still run.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          throw new Error('no RO')
        }
      }
    )
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor() {
          throw new Error('no MO')
        }
      }
    )
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      rects.set('m2', { top: 973, height: 40 })
      expect(controller.noteSameRouteWindowUpdate({ topicId: 't1', route: null }, 'a::b::28')).toBe(true)
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })

  it('controller window generation is a pure event (no DOM work)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const gen0 = controller.windowGeneration
    expect(controller.noteSameRouteWindowUpdate({ topicId: 't1', route: null }, 'a::b::28')).toBe(true)
    expect(controller.windowGeneration).toBe(gen0 + 1)
    // Same identity is a no-op event (no generation churn).
    expect(controller.noteSameRouteWindowUpdate({ topicId: 't1', route: null }, 'a::b::28')).toBe(true)
    expect(controller.windowGeneration).toBe(gen0 + 1)
    // Foreign route / unknown rendered refuse without a generation bump.
    expect(controller.noteSameRouteWindowUpdate({ topicId: 't1', route: 'other' }, 'a::b::29')).toBe(false)
    expect(controller.windowGeneration).toBe(gen0 + 1)
  })
})

describe('keeper scheduler quiescence (no pending ⇒ zero frame work)', () => {
  let rafQueue: FrameRequestCallback[]
  let rafSpy: ReturnType<typeof vi.fn>
  let cafSpy: ReturnType<typeof vi.fn>
  const installManualRaf = (): void => {
    rafQueue = []
    rafSpy = vi.fn((cb: FrameRequestCallback): number => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    cafSpy = vi.fn((_id: number): void => {
      rafQueue.length = 0
    })
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', cafSpy)
  }

  it('ordinary holds schedule zero frames across observer/scroll/generation signals', () => {
    installManualRaf()
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(rafSpy).not.toHaveBeenCalled()
    expect(rafQueue.length).toBe(0)
    // Ordinary layout shift (no hidden fold): synchronous hold only.
    act(() => {
      rects.set('m2', { top: 160, height: 40 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(220)
    expect(rafSpy).not.toHaveBeenCalled()
    expect(rafQueue.length).toBe(0)
    // No-intent scroll echo plus observer fires plus same-route generation
    // bump: still purely synchronous, zero frame work.
    act(() => {
      container.dispatchEvent(new Event('scroll'))
    })
    for (const ro of FakeResizeObserver.instances) {
      try {
        ;(ro as unknown as { fire: () => void }).fire()
      } catch {}
    }
    for (const mo of FakeMutationObserver.instances) {
      try {
        ;(mo as unknown as { fire: () => void }).fire()
      } catch {}
    }
    expect(controller.noteSameRouteWindowUpdate({ topicId: 't1', route: null }, 'a::b::28')).toBe(true)
    act(() => {
      keeper.rerender(2)
    })
    expect(rafSpy).not.toHaveBeenCalled()
    expect(cafSpy).not.toHaveBeenCalled()
    expect(rafQueue.length).toBe(0)
    keeper.unmount()
  })
})

describe('user input takes over the anchor', () => {
  it('wheel declares pending-only; the atomic takeover adopts the real scroll result', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    // Genuine user wheel: declare pending-only; the keeper stops moving the
    // viewport for the user, but content growth is still held (layout space).
    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }))
    })
    expect(controller.userIntentPending).toBe(true)

    // Layout grows at the same moment: the growth is held in LAYOUT space only,
    // so the reading row stays put and the gesture's own movement is untouched.
    act(() => {
      rects.set('m2', { top: 973, height: 40 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    // The write landed.
    act(() => {
      rects.set('m2', { top: -60, height: 40 })
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(1033)

    // The real user scroll lands with m3 crossing the top. Offset and scrollTop
    // move together (pure scroll in this container's coordinates), so the keeper
    // alone writes NOTHING: it never cancels the user's own movement. The keeper
    // also never adopts itself (single writer): Messages measures crossing-first
    // and calls the atomic takeover, whose return authorizes the snapshot write.
    act(() => {
      Object.defineProperty(container, 'scrollTop', { value: 500, writable: true, configurable: true })
      rects.set('m1', { top: -900, height: 400 })
      // Pure scroll in this container's coordinates: the offset moves exactly
      // opposite to the scroll (Δoffset = −ΔscrollTop), so there is no layout
      // displacement to hold.
      rects.set('m2', { top: 473, height: 40 })
      rects.set('m3', { top: -10, height: 400 })
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(500)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Atomic takeover (Messages path) adopts m3; the session stays live for
    // momentum/drag until scrollend, then the keeper predicate restores.
    const token = controller.activeInteractionToken
    expect(token).not.toBeNull()
    const out = controller.userTakeover(
      { messageId: 'm3', intraRowOffset: -10, scrollTop: 500, isAtBottom: false },
      undefined,
      token ?? undefined
    )
    expect(out.taken).toBe(true)
    if (out.taken) {
      ;(window as unknown as { keyv: { set: (k: string, v: unknown) => void } }).keyv.set(`scroll:${out.routeKey}`, {
        scrollTop: out.snapshot.scrollTop,
        messageId: out.snapshot.messageId,
        intraRowOffset: out.snapshot.intraRowOffset,
        isAtBottom: out.snapshot.isAtBottom
      })
      expect(out.routeKey).toBe('topic-t1::main')
    }
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm3',
      offset: -10
    })
    const stored = store.get('scroll:topic-t1::main') as { messageId: string; intraRowOffset: number } | undefined
    expect(stored?.messageId).toBe('m3')
    expect(stored?.intraRowOffset).toBe(-10)
    expect(controller.userIntentPending).toBe(true)
    expect(controller.noteInteractionScrollEnd()).toBe(true)
    expect(controller.userIntentPending).toBe(false)
    keeper.unmount()
  })
})

describe('keyboard native paging lifecycle (no keyup idle close)', () => {
  const keyDown = (target: HTMLElement, key: string): void => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }
  const keyUp = (target: HTMLElement, key: string): void => {
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  }
  // Native PageUp/PageDown paging is asynchronous: the browser scroll lands
  // AFTER keyup (keydown t4176 -> keyup t4327 -> first smooth scroll t4328 in
  // the E2E chronology). The keyup idle fallback therefore closed the session
  // with scrolls==0 before the real scroll could adopt. Keyboard declarations
  // stay pending for the forthcoming native `scrollend` (same lifecycle as
  // wheel); pointer/touch idle fallback is unchanged.
  it('keydown declares, keyup leaves pending, delayed scroll adopts, scrollend closes', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    act(() => {
      keyDown(container, 'PageDown')
    })
    expect(controller.userIntentPending).toBe(true)

    // The native scroll has not landed yet: keyup must NOT close the session.
    act(() => {
      keyUp(container, 'PageDown')
    })
    expect(controller.userIntentPending).toBe(true)
    expect(controller.activeInteractionScrollCount).toBe(0)

    // Delayed native paging lands inside the still-live session: the atomic
    // takeover (Messages path) adopts the measured viewport as the new stable
    // anchor. The keeper alone writes nothing; only the takeover return
    // authorizes a snapshot write.
    act(() => {
      Object.defineProperty(container, 'scrollTop', { value: 500, writable: true, configurable: true })
      rects.set('m1', { top: -900, height: 400 })
      rects.set('m2', { top: -500, height: 40 })
      rects.set('m3', { top: -10, height: 400 })
      container.dispatchEvent(new Event('scroll'))
    })
    const token = controller.activeInteractionToken
    expect(token).not.toBeNull()
    const out = controller.userTakeover(
      { messageId: 'm3', intraRowOffset: -10, scrollTop: 500, isAtBottom: false },
      undefined,
      token ?? undefined
    )
    expect(out.taken).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm3',
      offset: -10
    })
    expect(controller.userIntentPending).toBe(true)

    // Native `scrollend` closes the adopted session (same as wheel).
    act(() => {
      container.dispatchEvent(new Event('scrollend'))
    })
    expect(controller.userIntentPending).toBe(false)
    keeper.unmount()
  })

  // Pending-only keyboard at a no-op boundary (e.g. PageUp at the oldest edge
  // where the browser scrolls nothing) commits no geometry: the declaration
  // stays pending like the existing wheel-at-boundary case, and the next
  // pointer end / request / invalidate cancels it. Never invent completion.
  it('pending-only keyboard commits nothing; next pointer end cancels it', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const takeoverSpy = vi.spyOn(controller, 'userTakeover')
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    act(() => {
      keyDown(container, 'PageUp')
    })
    expect(controller.userIntentPending).toBe(true)
    act(() => {
      keyUp(container, 'PageUp')
    })
    expect(controller.userIntentPending).toBe(true)
    // No scroll landed, no takeover ran, no geometry committed.
    expect(takeoverSpy).not.toHaveBeenCalled()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()

    // The existing pointer idle fallback still cancels a pending-only session.
    act(() => {
      container.dispatchEvent(new Event('pointerup'))
    })
    expect(controller.userIntentPending).toBe(false)
    takeoverSpy.mockRestore()
    keeper.unmount()
  })

  it('keyboard in an editable field declares nothing (no hijack)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    const input = document.createElement('input')
    container.append(input)

    act(() => {
      keyDown(input, 'PageDown')
    })
    expect(controller.userIntentPending).toBe(false)
    act(() => {
      keyUp(input, 'PageDown')
    })
    expect(controller.userIntentPending).toBe(false)
    keeper.unmount()
  })
})

describe('fold hidden answer reconciliation (same-group transfer, offset preserved)', () => {
  const buildFoldSurface = (): {
    container: HTMLDivElement
    ref: { current: HTMLDivElement | null }
    oldRow: HTMLDivElement
    newRow: HTMLDivElement
  } => {
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 4000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
    const group = document.createElement('div')
    group.id = 'message-group-ask-1'
    const oldRow = document.createElement('div')
    oldRow.id = 'message-old-short'
    oldRow.setAttribute('data-message-id', 'old-short')
    mockRect(oldRow, 'old-short')
    const newRow = document.createElement('div')
    newRow.id = 'message-new-tall'
    newRow.setAttribute('data-message-id', 'new-tall')
    mockRect(newRow, 'new-tall')
    group.append(oldRow, newRow)
    container.append(group)
    document.body.append(container)
    return { container, ref: { current: container }, oldRow: oldRow, newRow: newRow }
  }

  it('hidden held answer never transfers: without a tab intent the keeper holds nothing', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'old-short', -60)
    rects.set('old-short', { top: -60, height: 120 })
    rects.set('new-tall', { top: -60, height: 120 })
    const { container, ref, oldRow, newRow } = buildFoldSurface()
    // The tall variant starts hidden (fold shows only the selected short answer).
    newRow.style.display = 'none'
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)

    // Answer-tab switch WITHOUT a captured tab intent: the held short answer
    // collapses (display:none). SWITCHING owns geometry via the clicked tab,
    // never via a body-anchor sibling transfer — the keeper holds nothing.
    const oldRectSpy = vi.spyOn(oldRow, 'getBoundingClientRect')
    act(() => {
      oldRow.style.display = 'none'
      newRow.style.display = 'inline-block'
      rects.set('new-tall', { top: 240, height: 900 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(0)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'old-short',
      offset: -60
    })
    // The hidden replaced row was never measured as stable geometry.
    expect(oldRectSpy).not.toHaveBeenCalled()
    oldRectSpy.mockRestore()
    keeper.unmount()
  })

  it('a different held visible message is preserved normally (no transfer)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'reader', -40)
    rects.set('reader', { top: -40, height: 60 })
    rects.set('old-short', { top: 400, height: 120 })
    rects.set('new-tall', { top: 400, height: 900 })
    const { container, ref, oldRow, newRow } = buildFoldSurface()
    const reader = document.createElement('div')
    reader.id = 'message-reader'
    reader.setAttribute('data-message-id', 'reader')
    mockRect(reader, 'reader')
    container.prepend(reader)
    oldRow.style.display = 'none'
    newRow.style.display = 'inline-block'
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    // Layout shifts the held reader row while the fold group sits elsewhere.
    act(() => {
      rects.set('reader', { top: 110, height: 60 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(150)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'reader',
      offset: -40
    })
    keeper.unmount()
  })

  it('hidden held answer with no visible sibling holds nothing (no hidden compensation)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'lonely', -60)
    rects.set('lonely', { top: -60, height: 80 })
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 4000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
    const group = document.createElement('div')
    group.id = 'message-group-ask-9'
    const lonely = document.createElement('div')
    lonely.id = 'message-lonely'
    lonely.setAttribute('data-message-id', 'lonely')
    mockRect(lonely, 'lonely')
    group.append(lonely)
    container.append(group)
    document.body.append(container)
    const ref = { current: container }
    const keeper = renderKeeper(controller, ref, 0, vi.fn())

    act(() => {
      lonely.style.display = 'none'
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(0)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'lonely',
      offset: -60
    })
    keeper.unmount()
  })
})

describe('intent defaults', () => {
  it('no-history top restores take the deterministic bottom default', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = controller.request({ kind: 'top', topicId: 't1', targetRoute: 'fresh', saved: null })
    expect(controller.getAnchorFor({ topicId: 't1', route: 'fresh' })).toBeNull()
    controller.appliedWindow(epoch)
    controller.firstPositioned(epoch, 'placed')
    controller.revealed(epoch)
    const out = controller.commitStable(epoch, {
      messageId: null,
      intraRowOffset: null,
      scrollTop: 0,
      isAtBottom: true
    })
    expect(out.committed).toBe(true)
    expect(out.commit?.routeKey).toBe('topic-t1::fresh')
  })

  it('divider keeps the clicked offset through searching/pagination/quiet, then commits', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = controller.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm1::main',
      clickOffset: 150
    })
    controller.appliedWindow(epoch)
    controller.firstPositioned(epoch, 'searching')
    // Restore-owned pagination settles with the identity resident.
    expect(controller.paginationSettled(epoch)).toBe(true)
    const out = controller.commitStable(epoch, {
      messageId: 'm1',
      intraRowOffset: 150,
      scrollTop: -300,
      isAtBottom: false
    })
    expect(out.committed).toBe(true)
    expect(out.commit?.snapshot).toMatchObject({ messageId: 'm1', intraRowOffset: 150 })
    expect(out.didRelease).toBe(true)
  })
})

describe('hold baseline provenance (no fabricated pairs; user input always wins)', () => {
  const holder = (): { current: StableVisualAnchorMaintainer | null } => ({ current: null })

  it('pairs a published offset with the scrollTop measured with it: intervening momentum is not charged to layout', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    // The keeper starts holding a DIFFERENT row than the one the commit publishes,
    // so it has no observation of its own for the committed identity: only the
    // published transactional pair is usable.
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: 400, height: 400 })
    const { container, ref } = buildSurface()
    const maintainer = holder()
    const keeper = renderKeeper(controller, ref, 0, vi.fn(), maintainer)
    expect(maintainer.current).not.toBeNull()
    expect(container.scrollTop).toBe(0)

    // The user's momentum moves the viewport 500px (pure scroll: m3 travels with
    // it) and the keeper observes that scroll, which seeds m3 as a row it has
    // seen — so the pair comes from the commit below instead.
    const publishM3 = (): void => {
      act(() => {
        rects.set('m3', { top: -100, height: 400 })
        maintainer.current!.publishAnchorSample({
          topicId: 't1',
          route: null,
          messageId: 'm3',
          viewportOffset: -100,
          scrollTop: 500
        })
      })
    }
    // Commit instant: the reading row is m3 at offset -100 with scrollTop 500.
    Object.defineProperty(container, 'scrollTop', { value: 500, writable: true, configurable: true })
    act(() => {
      rects.set('m2', { top: -560, height: 40 })
      rects.set('m3', { top: -100, height: 400 })
    })
    publishM3()
    act(() => {
      expect(
        controller.adoptOrdinaryPaginationWindow({ topicId: 't1', route: null }, 'old::new::40', {
          messageId: 'm3',
          offset: -100
        })
      ).toBe(true)
      keeper.rerender(1)
    })

    // Between the publication and the next observation the user keeps scrolling
    // 300px (momentum, with no scrollend guarantee) AND 120px of content grows
    // above the row: layout displacement is exactly 120 and NOT -180.
    act(() => {
      Object.defineProperty(container, 'scrollTop', { value: 800, writable: true, configurable: true })
      rects.set('m2', { top: -860, height: 40 })
      rects.set('m3', { top: -280, height: 400 })
      keeper.rerender(2)
    })
    // The user's 300px of input survives (only the 120px layout growth is held):
    // the fabricated-pair bug would have written -180 and rewound the viewport.
    expect(container.scrollTop).toBe(920)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm3',
      offset: -100
    })
    keeper.unmount()
  })

  it('with no true pair the keeper holds nothing: a cold seed never rewinds the user', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    // Committed anchor is m3 at offset -100; the keeper has no observation of m3
    // and NO transactional pair was published.
    driveStableMessage(controller, 'm3', -100)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -560, height: 40 })
    rects.set('m3', { top: -280, height: 400 })
    const { container, ref } = buildSurface()
    Object.defineProperty(container, 'scrollTop', { value: 800, writable: true, configurable: true })
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // The published offset (-100) and the live scrollTop (800) describe DIFFERENT
    // instants, so no baseline is provable: nothing may be written.
    expect(container.scrollTop).toBe(800)
    act(() => {
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(800)
    keeper.unmount()
  })

  it('a dropped baseline (region intent) with momentum and later growth never rewinds, and a renewed pair holds again', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: 400, height: 400 })
    const { container, ref } = buildSurface()
    const maintainer = holder()
    const keeper = renderKeeper(controller, ref, 0, vi.fn(), maintainer)
    expect(container.scrollTop).toBe(0)

    // A pending region intent (e.g. message controls) owns this frame's geometry
    // and DROPS the anchor baseline.
    act(() => {
      expect(
        controller.beginInteractionIntent(
          { topicId: 't1', route: null },
          { kind: 'message', id: 'm2' },
          'message-controls',
          -60
        )
      ).toBe(true)
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(0)

    // The intent clears and the user's momentum lands (pure scroll of 200): the
    // frame measures zero layout displacement, so the keeper writes nothing at
    // all and the user's own movement is never undone.
    act(() => {
      controller.clearInteractionIntent(controller.currentEpoch, 'm2', 0, 'message-controls')
    })
    act(() => {
      Object.defineProperty(container, 'scrollTop', { value: 200, writable: true, configurable: true })
      rects.set('m2', { top: -260, height: 40 })
    })
    act(() => {
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(200)

    // Content then grows 100px above the same reading row. The keeper's own
    // synchronous read (offset + scrollTop of one instant) is a true pair, so
    // exactly the layout part is held: the row keeps its post-momentum screen
    // offset and the 200px the user moved survive (a fabricated pair would have
    // charged the momentum to layout and rewound the viewport).
    act(() => {
      rects.set('m2', { top: -160, height: 40 })
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(300)

    // The write landed: the row is back at its held offset.
    act(() => {
      rects.set('m2', { top: -260, height: 40 })
      keeper.rerender(3)
    })
    expect(container.scrollTop).toBe(300)

    // A renewed transaction pair (the next commit publishes one) describes the
    // same instant as the keeper's own re-based baseline, and holding resumes
    // with it: the same row growing by 100 with the viewport otherwise still.
    act(() => {
      maintainer.current!.publishAnchorSample({
        topicId: 't1',
        route: null,
        messageId: 'm2',
        viewportOffset: -260,
        scrollTop: 300
      })
      rects.set('m2', { top: -160, height: 40 })
      keeper.rerender(4)
    })
    expect(container.scrollTop).toBe(400)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    keeper.unmount()
  })

  it('initial pagination hold stays effective with a pair published at the commit instant', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container, ref } = buildSurface()
    const maintainer = holder()
    const keeper = renderKeeper(controller, ref, 0, vi.fn(), maintainer)
    expect(container.scrollTop).toBe(0)
    controller.declareUserIntent()

    // Older prepend commits 1033px above m2 while the gesture is live; the pair
    // is published for a row the keeper has NOT observed (m2 is republished as a
    // new anchor identity via the same-route adopt below).
    act(() => {
      maintainer.current!.publishAnchorSample({
        topicId: 't1',
        route: null,
        messageId: 'm2',
        viewportOffset: -60,
        scrollTop: 0
      })
      rects.set('m1', { top: -460, height: 1433 })
      rects.set('m2', { top: 973, height: 40 })
      rects.set('m3', { top: 1013, height: 400 })
      expect(
        controller.adoptOrdinaryPaginationWindow({ topicId: 't1', route: null }, 'old::new::40', {
          messageId: 'm2',
          offset: -60
        })
      ).toBe(true)
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(1033)
    keeper.unmount()
  })
})
