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

import { RouteViewportContext, type RouteViewportContextValue, useStableVisualAnchor } from '../routeViewportContext'
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

const renderKeeper = (
  controller: RouteViewportController,
  ref: { current: HTMLDivElement | null },
  version: number,
  notify: () => void
): { rerender: (version: number) => void; unmount: () => void } => {
  const Harness = ({ containerRef }: { containerRef: { current: HTMLDivElement | null } }) => {
    useStableVisualAnchor(containerRef as React.RefObject<HTMLElement | null>)
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

  it('live user session blocks the hold until scrollend', () => {
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
    act(() => {
      rects.set('m2', { top: 973, height: 40 })
      keeper.rerender(1)
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(0)
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

    // Genuine user wheel: declare pending-only, compensation stops.
    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }))
    })
    expect(controller.userIntentPending).toBe(true)

    // Layout grows at the same moment: no programmatic compensation follows
    // user intent.
    act(() => {
      rects.set('m2', { top: 973, height: 40 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(0)

    // The real user scroll lands with m3 crossing the top. The keeper never
    // adopts itself (single writer): Messages measures crossing-first and
    // calls the atomic takeover, whose return authorizes the snapshot write.
    act(() => {
      Object.defineProperty(container, 'scrollTop', { value: 500, writable: true, configurable: true })
      rects.set('m1', { top: -900, height: 400 })
      rects.set('m2', { top: -500, height: 40 })
      rects.set('m3', { top: -10, height: 400 })
      container.dispatchEvent(new Event('scroll'))
    })
    // Keeper alone writes nothing.
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

  it('hidden held answer transfers to the visible same-group sibling; the hidden row is never measured', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'old-short', -60)
    rects.set('old-short', { top: -60, height: 120 })
    rects.set('new-tall', { top: -60, height: 120 })
    const { container, ref, oldRow, newRow } = buildFoldSurface()
    // The tall variant starts hidden (fold shows only the selected short answer).
    newRow.style.display = 'none'
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)

    // Answer-tab switch: the held short answer collapses (display:none) and
    // the tall sibling becomes visible at a shifted position (+300).
    const oldRectSpy = vi.spyOn(oldRow, 'getBoundingClientRect')
    act(() => {
      oldRow.style.display = 'none'
      newRow.style.display = 'inline-block'
      rects.set('new-tall', { top: 240, height: 900 })
      keeper.rerender(1)
    })
    // The keeper held the transferred visible sibling at the intended offset.
    expect(container.scrollTop).toBe(300)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'new-tall',
      offset: -60
    })
    // The hidden replaced row was never measured as stable geometry.
    expect(oldRectSpy).not.toHaveBeenCalled()
    oldRectSpy.mockRestore()

    // Settled geometry holds without further drift.
    act(() => {
      rects.set('new-tall', { top: -60, height: 900 })
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(300)
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
