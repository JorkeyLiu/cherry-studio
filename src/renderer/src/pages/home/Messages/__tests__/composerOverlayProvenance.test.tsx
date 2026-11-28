/**
 * Composer padding provenance: the explicit composer settle is the only
 * causal entry for padding changes; observer-driven holds must not double
 * it, and native scroll has exactly one classifier.
 *
 * - the keeper's container/content observer only holds when a content-box
 *   size genuinely changed: composer padding-only (same content-box) holds
 *   nothing, while real content growth and window/sidebar resizes still hold;
 * - empty observer entries keep the legacy hold (fail-safe: unprovable
 *   change still compensates);
 * - single scroll classifier: the keeper owns no compensating slot and no
 *   second scroll listener; Messages owns the only controller consume;
 *   the settle command carries the layout-operation reference.
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
  ;(window as unknown as { keyv: unknown }).keyv = {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => {
      store.set(k, v)
    },
    remove: (k: string) => {
      store.delete(k)
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
const containerRect = { top: 0, height: 600, width: 300 }

const mockRect = (el: HTMLElement, key: string): void => {
  el.getBoundingClientRect = () => {
    if (key === 'container') {
      return {
        top: containerRect.top,
        bottom: containerRect.top + containerRect.height,
        height: containerRect.height,
        left: 0,
        right: containerRect.width,
        width: containerRect.width,
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

type ROEntry = { target: Element; contentRect: { width: number; height: number } }

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
  fire = (entries: ROEntry[] = []): void => {
    this.cb(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
  }
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = []
  private cb: MutationCallback
  constructor(cb: MutationCallback) {
    this.cb = cb
    FakeMutationObserver.instances.push(this)
  }
  observe = (): void => {}
  disconnect = (): void => {}
  fire = (): void => {
    this.cb([], this as unknown as MutationObserver)
  }
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

beforeEach(() => {
  store = new Map()
  rects.clear()
  containerRect.top = 0
  containerRect.height = 600
  containerRect.width = 300
  document.body.innerHTML = ''
  installKeyv()
  installFakeObservers()
})

afterEach(() => {
  removeKeyv()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const contentBox = (width: number, height: number): { width: number; height: number } => ({ width, height })

describe('keeper content-box gate (padding-only never holds indirectly)', () => {
  it('real row displacement with an unchanged content-box holds nothing', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container } = buildSurface()
    const keeper = renderKeeper(controller, { current: container }, 0, vi.fn())
    expect(container.scrollTop).toBe(0)
    const content = container.firstElementChild as Element

    // Seed the observed boxes (no displacement: nothing to compensate).
    act(() => {
      for (const ro of FakeResizeObserver.instances) {
        ro.fire([
          { target: container, contentRect: contentBox(300, 600) },
          { target: content, contentRect: contentBox(300, 1400) }
        ])
      }
    })
    expect(container.scrollTop).toBe(0)

    // The anchor row moves (layout displacement) but every observed
    // content-box is provably unchanged — padding-only shape: hold nothing.
    act(() => {
      rects.set('m2', { top: 160, height: 40 })
      for (const ro of FakeResizeObserver.instances) {
        ro.fire([
          { target: container, contentRect: contentBox(300, 600) },
          { target: content, contentRect: contentBox(300, 1400) }
        ])
      }
    })
    expect(container.scrollTop).toBe(0)
    keeper.unmount()
  })

  it('a genuine content-box change still holds the anchor', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container } = buildSurface()
    const keeper = renderKeeper(controller, { current: container }, 0, vi.fn())
    const content = container.firstElementChild as Element

    act(() => {
      for (const ro of FakeResizeObserver.instances) {
        ro.fire([
          { target: container, contentRect: contentBox(300, 600) },
          { target: content, contentRect: contentBox(300, 1400) }
        ])
      }
    })
    expect(container.scrollTop).toBe(0)

    // Content growth pushes the anchor row down and the content-box grows
    // with it: the keeper compensates exactly once.
    act(() => {
      rects.set('m2', { top: 160, height: 40 })
      for (const ro of FakeResizeObserver.instances) {
        ro.fire([
          { target: container, contentRect: contentBox(300, 600) },
          { target: content, contentRect: contentBox(300, 1620) }
        ])
      }
    })
    expect(container.scrollTop).toBe(220)
    keeper.unmount()
  })

  it('a container content-box change (window/sidebar resize) still holds', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container } = buildSurface()
    const keeper = renderKeeper(controller, { current: container }, 0, vi.fn())
    const content = container.firstElementChild as Element

    act(() => {
      for (const ro of FakeResizeObserver.instances) {
        ro.fire([
          { target: container, contentRect: contentBox(300, 600) },
          { target: content, contentRect: contentBox(300, 1400) }
        ])
      }
    })

    // The sidebar narrows the scrollport while the anchor row displaces:
    // container-box protection still compensates.
    act(() => {
      rects.set('m2', { top: 160, height: 40 })
      for (const ro of FakeResizeObserver.instances) {
        ro.fire([
          { target: container, contentRect: contentBox(260, 600) },
          { target: content, contentRect: contentBox(260, 1400) }
        ])
      }
    })
    expect(container.scrollTop).toBe(220)
    keeper.unmount()
  })

  it('empty observer entries keep the legacy hold (fail-safe, never drops layout)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m1', { top: -460, height: 400 })
    rects.set('m2', { top: -60, height: 40 })
    rects.set('m3', { top: -20, height: 400 })
    const { container } = buildSurface()
    const keeper = renderKeeper(controller, { current: container }, 0, vi.fn())

    act(() => {
      rects.set('m2', { top: 160, height: 40 })
      for (const ro of FakeResizeObserver.instances) ro.fire()
    })
    expect(container.scrollTop).toBe(220)
    keeper.unmount()
  })
})
