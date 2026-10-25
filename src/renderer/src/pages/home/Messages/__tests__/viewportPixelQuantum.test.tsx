/**
 * Device-pixel quantum sync (fractional-zoom pause hold).
 *
 * Focused DOM contract for the keeper geometry var:
 * - exact DPR sanitize (`1/dpr` px, finite-positive only);
 * - property write only on change (prior-compare, no RO loop, no extra
 *   callbacks/side effects);
 * - keeper mount + existing RO fire synchronizes the live wrapper var without
 *   touching controller anchor/snapshot/generations;
 * - effect teardown never removes the var (same wrapper retains its live
 *   coordinate; unmount discards local geometry with the node).
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MESSAGES_PIXEL_VAR,
  resolveMessagesPixelQuantum,
  RouteViewportContext,
  type RouteViewportContextValue,
  syncMessagesPixelQuantum,
  useStableVisualAnchor
} from '../routeViewportContext'
import { RouteViewportController } from '../routeViewportController'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

let keyvStore: Map<string, unknown>
const installKeyv = (): void => {
  keyvStore = new Map()
  ;(window as unknown as { keyv: unknown }).keyv = {
    get: (k: string) => keyvStore.get(k),
    set: (k: string, v: unknown) => {
      keyvStore.set(k, v)
    },
    remove: (k: string) => {
      keyvStore.delete(k)
    }
  }
  const api = (globalThis as unknown as { CSS?: { escape?: (v: string) => string } }).CSS
  if (!api?.escape) vi.stubGlobal('CSS', { escape: (v: string) => v })
}
const removeKeyv = (): void => {
  try {
    delete (window as unknown as { keyv?: unknown }).keyv
  } catch {}
}

const rectOf = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 300,
    width: 300,
    x: 0,
    y: top,
    toJSON: () => ({})
  }) as DOMRect

class FakeRO {
  static instances: FakeRO[] = []
  observed = new Set<Element>()
  constructor(private cb: ResizeObserverCallback) {
    FakeRO.instances.push(this)
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
class FakeMO {
  static instances: FakeMO[] = []
  observed: unknown[] = []
  constructor(private cb: MutationCallback) {
    FakeMO.instances.push(this)
  }
  observe = (t: Element, o: MutationObserverInit): void => {
    this.observed.push({ t, o })
  }
  disconnect = (): void => {
    this.observed = []
  }
  fire = (): void => {
    this.cb([], this as unknown as MutationObserver)
  }
  takeRecords = (): MutationRecord[] => []
}

const stubDpr = (dpr: number): void => {
  try {
    Object.defineProperty(window, 'devicePixelRatio', { value: dpr, writable: true, configurable: true })
  } catch {}
}

const driveStable = (controller: RouteViewportController, messageId: string, offset: number): void => {
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
  document.body.innerHTML = ''
  installKeyv()
  FakeRO.instances = []
  FakeMO.instances = []
  vi.stubGlobal('ResizeObserver', FakeRO)
  vi.stubGlobal('MutationObserver', FakeMO)
  stubDpr(1)
})

afterEach(() => {
  removeKeyv()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('resolveMessagesPixelQuantum exact DPR sanitize', () => {
  it('maps finite positive DPR to 1/dpr px', () => {
    expect(resolveMessagesPixelQuantum(1)).toBe('1px')
    expect(resolveMessagesPixelQuantum(2)).toBe('0.5px')
    expect(resolveMessagesPixelQuantum(1.25)).toBe(`${1 / 1.25}px`)
    expect(resolveMessagesPixelQuantum(1.5)).toBe(`${1 / 1.5}px`)
  })
  it('rejects non-finite/non-positive/non-number DPR', () => {
    for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, undefined, null, '2', {}, []]) {
      expect(resolveMessagesPixelQuantum(bad)).toBeNull()
    }
  })
})

describe('syncMessagesPixelQuantum write-only-on-change', () => {
  it('writes exact quantum once, no second write, no extra inline styles', () => {
    const el = document.createElement('div')
    const setSpy = vi.spyOn(el.style, 'setProperty')
    expect(syncMessagesPixelQuantum(el, 2)).toBe(true)
    expect(el.style.getPropertyValue(MESSAGES_PIXEL_VAR)).toBe('0.5px')
    expect(setSpy).toHaveBeenCalledTimes(1)
    // Same DPR: no additional callbacks/writes (RO-loop guard).
    expect(syncMessagesPixelQuantum(el, 2)).toBe(false)
    expect(setSpy).toHaveBeenCalledTimes(1)
    // Changed DPR writes once with the exact new quantum.
    expect(syncMessagesPixelQuantum(el, 1.25)).toBe(true)
    expect(el.style.getPropertyValue(MESSAGES_PIXEL_VAR)).toBe('0.8px')
    expect(setSpy).toHaveBeenCalledTimes(2)
    // Only the quantum var exists inline; nothing else is touched.
    expect(el.style.length).toBe(1)
    setSpy.mockRestore()
  })
  it('invalid DPR never clears or writes; null node is inert', () => {
    const el = document.createElement('div')
    el.style.setProperty(MESSAGES_PIXEL_VAR, '0.5px')
    for (const bad of [0, -1, NaN, Infinity, null, '2']) {
      expect(syncMessagesPixelQuantum(el, bad)).toBe(false)
    }
    // Explicit undefined falls back to window.devicePixelRatio (stubbed 1).
    expect(syncMessagesPixelQuantum(el)).toBe(true)
    expect(el.style.getPropertyValue(MESSAGES_PIXEL_VAR)).toBe('1px')
    expect(syncMessagesPixelQuantum(null, 2)).toBe(false)
  })
})

describe('keeper synchronizes the live wrapper var without touching controller truth', () => {
  const renderKeeper = (controller: RouteViewportController, ref: { current: HTMLDivElement | null }, v: number) => {
    const Harness = ({ r }: { r: { current: HTMLDivElement | null } }) => {
      useStableVisualAnchor(r as React.RefObject<HTMLElement | null>)
      return null
    }
    const value = (version: number): RouteViewportContextValue => ({
      controller,
      version,
      connectionGeneration: 0,
      notifyChanged: () => {},
      freezeDisplayed: () => false,
      readSnapshot: () => null,
      requestTopRoute: () => ({ epoch: controller.currentEpoch, fresh: true }),
      registerCapturer: () => {},
      viewportPhaseAttr: 'revealed'
    })
    const rendered = render(
      <RouteViewportContext value={value(v)}>
        <Harness r={ref} />
      </RouteViewportContext>
    )
    return {
      rerender: (nv: number) => {
        rendered.rerender(
          <RouteViewportContext value={value(nv)}>
            <Harness r={ref} />
          </RouteViewportContext>
        )
      },
      unmount: () => rendered.unmount()
    }
  }

  it('mount writes 1px at DPR1; existing RO fire converges 0.8px at DPR1.25 with anchor/snapshot/generation unchanged', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStable(controller, 'm2', -60)
    const anchorBefore = controller.getAnchorFor({ topicId: 't1', route: null })
    const genBefore = controller.windowGeneration
    const container = document.createElement('div')
    container.id = 'messages'
    container.getBoundingClientRect = () => rectOf(0, 600)
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
    const wrapper = document.createElement('div')
    container.append(wrapper)
    const row = document.createElement('div')
    row.id = 'message-m2'
    row.setAttribute('data-message-id', 'm2')
    row.getBoundingClientRect = () => rectOf(-60, 40)
    wrapper.append(row)
    document.body.append(container)
    const ref = { current: container }
    stubDpr(1)
    const keeper = renderKeeper(controller, ref, 0)
    expect(wrapper.style.getPropertyValue(MESSAGES_PIXEL_VAR)).toBe('1px')

    // DPR change lands via the EXISTING RO path (no new listeners/state):
    // same wrapper, same anchor, only the quantum converges.
    stubDpr(1.25)
    act(() => {
      for (const ro of FakeRO.instances) ro.fire()
    })
    expect(wrapper.style.getPropertyValue(MESSAGES_PIXEL_VAR)).toBe('0.8px')
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual(anchorBefore)
    expect(controller.windowGeneration).toBe(genBefore)
    expect(keyvStore.get('scroll:topic-t1::main')).toBeUndefined()

    // Teardown never strips the live coordinate (no transient-layout removal).
    keeper.unmount()
    expect(wrapper.style.getPropertyValue(MESSAGES_PIXEL_VAR)).toBe('0.8px')
  })
})
