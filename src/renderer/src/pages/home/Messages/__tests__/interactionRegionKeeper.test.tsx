/**
 * Shared interaction-region keeper (generic layout-change completion).
 *
 * Proves the keeper arbitrates arbitrary regions through one gate: a real
 * layout effect (scope-owner dimensions changed versus the capture
 * fingerprint) is held stationary every frame and handed off to the visible
 * representative with a snapshot write only after layout-quiet; a genuinely
 * no-effect action is dropped WITHOUT adopting (no snapshot, pause/reading
 * anchor untouched); disappearance fails closed; stale gestures never clear
 * newer ones. No editor metadata, no button names, no frame-count success
 * hacks — the quiet bound only ever gates the snapshot-free drop.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  markInteractionLayoutDeferred,
  RouteViewportContext,
  type RouteViewportContextValue,
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

interface RectSpec {
  top: number
  height: number
  width?: number
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
    const spec = rects.get(key) ?? { top: 0, height: 40, width: 300 }
    return {
      top: spec.top,
      bottom: spec.top + (spec.height ?? 40),
      height: spec.height ?? 40,
      left: 0,
      right: 300,
      width: spec.width ?? 300,
      x: 0,
      y: spec.top,
      toJSON: () => ({})
    } as DOMRect
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed = new Set<Element>()
  constructor(_cb?: ResizeObserverCallback) {
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
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = []
  observed: { target: Element; options: MutationObserverInit }[] = []
  constructor(_cb?: MutationCallback) {
    FakeMutationObserver.instances.push(this)
  }
  observe = (target: Element, options: MutationObserverInit): void => {
    this.observed.push({ target, options })
  }
  disconnect = (): void => {
    this.observed = []
  }
  takeRecords = (): MutationRecord[] => []
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

const flushFrame = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    try {
      requestAnimationFrame(() => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * Message scope: row `m1` (real box id + data-message-id) hosting a
 * `message-controls` footer; group scope `g1` hosting a `fold-controls`
 * toggle plus a visible member row `m2`.
 */
const buildScopes = (): {
  container: HTMLDivElement
  ref: { current: HTMLDivElement | null }
  row: HTMLDivElement
  footer: HTMLDivElement
  group: HTMLDivElement
  toggle: HTMLDivElement
  member: HTMLDivElement
} => {
  const container = document.createElement('div')
  container.id = 'messages'
  mockRect(container, 'container')
  Object.defineProperty(container, 'scrollTop', { value: -400, writable: true, configurable: true })
  Object.defineProperty(container, 'scrollHeight', { value: 9000, writable: true, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
  const row = document.createElement('div')
  row.id = 'message-m1'
  row.setAttribute('data-message-id', 'm1')
  mockRect(row, 'row-m1')
  const footer = document.createElement('div')
  footer.setAttribute('data-interaction-region', 'message-controls')
  footer.setAttribute('data-viewport-baseline-edge', 'end')
  mockRect(footer, 'footer-m1')
  row.append(footer)
  const group = document.createElement('div')
  group.setAttribute('data-stable-group-id', 'g1')
  mockRect(group, 'group-g1')
  const member = document.createElement('div')
  member.id = 'message-m2'
  member.setAttribute('data-message-id', 'm2')
  mockRect(member, 'row-m2')
  const toggle = document.createElement('div')
  toggle.setAttribute('data-interaction-region', 'fold-controls')
  mockRect(toggle, 'toggle-g1')
  group.append(member, toggle)
  container.append(row, group)
  document.body.append(container)
  return { container, ref: { current: container }, row, footer, group, toggle, member }
}

beforeEach(() => {
  store = new Map()
  rects.clear()
  containerRect.top = 0
  containerRect.height = 600
  document.body.innerHTML = ''
  installKeyv()
  FakeResizeObserver.instances = []
  FakeMutationObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('MutationObserver', FakeMutationObserver)
})

afterEach(() => {
  try {
    delete (window as unknown as { keyv?: unknown }).keyv
  } catch {}
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('shared region keeper: layout-change completes, no-effect drops', () => {
  it('message scope: edit swap holds the region BOTTOM then hands off to the row below', async () => {
    // Approved invariant (VIEWPORT-13/14): the edit baseline is the stable
    // structural boundary BELOW the change domain — the region BOTTOM, not
    // the region TOP inside the changing action-bar geometry. The closed
    // footer (top 120 + 26 = bottom 146) and the open action bar (normal
    // min-38 box, circle-30 buttons, no 26 override) have different heights
    // by design; only the bottom stays invariant while the height delta
    // rises into the upper space and content below stays still. The handoff
    // adopts the first visible row BELOW (m2), never the edited row's moving
    // TOP, so later steps in the same editing session keep holding the same
    // baseline instead of switching ends.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    rects.set('row-m2', { top: 360, height: 120 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(-400)
    // Editor replacement lands: the action bar (38 box) pushes the region
    // bottom +72 below the captured footer bottom (146 → 218).
    act(() => {
      rects.set('row-m1', { top: -100, height: 460 })
      rects.set('footer-m1', { top: 180, height: 38 })
      rects.set('row-m2', { top: 432, height: 120 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-328)
    // Converged frame: compensation shifted every viewport offset back, so
    // the region bottom is back at capture (top 108 + 38 = 146) while the
    // grown row extends upward (top -260, bottom 200 unchanged) and the
    // below row never moved in the viewport (top 360).
    act(() => {
      rects.set('row-m1', { top: -260, height: 460 })
      rects.set('footer-m1', { top: 108, height: 38 })
      rects.set('row-m2', { top: 360, height: 120 })
    })
    // Quiet validation chain hands off to the stable row below — not to the
    // edited row's TOP (which moved from -100 to -260 with the growth).
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: 360
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m2')
    expect(stored?.intraRowOffset).toBe(360)
    expect(typeof stored?.scrollTop).toBe('number')
    keeper.unmount()
  })

  it('message scope: genuinely no-effect click drops with no adopt and no snapshot', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // No layout change at all: after sustained provable stillness the
    // intent drops WITHOUT adopting — the reading anchor and the snapshot
    // store are untouched (an accompanied pause is never rebased).
    await act(async () => {
      for (let i = 0; i < 12; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -100
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('disappearance without correspondence fails closed (no adopt, no snapshot)', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { ref, row, footer } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // The region vanishes with no structural replacement: fail closed.
    act(() => {
      row.removeChild(footer)
      keeper.rerender(1)
    })
    await act(async () => {
      for (let i = 0; i < 4; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('group scope: fold toggle hold hands off to the first visible row', async () => {
    // Fold keeps the default TOP baseline (no `end` declaration on the
    // toggle): the stable control height never changes across the gesture, so
    // TOP delta equals BOTTOM delta and the hold is unchanged.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('group-g1', { top: 350, height: 200 })
    rects.set('toggle-g1', { top: 400, height: 26 })
    rects.set('row-m2', { top: 360, height: 120 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'group', id: 'g1' },
        'fold-controls',
        400,
        { fingerprint: { scopeH: 200, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Expand lands: group grows, toggle shifts +60 below capture.
    act(() => {
      rects.set('group-g1', { top: 350, height: 320 })
      rects.set('toggle-g1', { top: 460, height: 26 })
      rects.set('row-m2', { top: 360, height: 120 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-340)
    // Converged frame: compensation moved every offset by -60.
    act(() => {
      rects.set('toggle-g1', { top: 400, height: 26 })
      rects.set('row-m2', { top: 300, height: 120 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m2')
    expect(stored?.intraRowOffset).toBe(300)
    keeper.unmount()
  })

  it('stale gesture completion never clears a newer hold', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const first = controller.activeInteractionIntent
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Newer interaction overwrites before any validation runs (same live
    // geometry, so the newer gesture is a genuine no-effect action).
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    // A stale completion for the first gesture refuses.
    expect(controller.clearInteractionIntent(first?.epoch, first?.scopeId, first?.gestureId, first?.region)).toBe(false)
    await act(async () => {
      for (let i = 0; i < 12; i++) await flushFrame()
    })
    // No-effect drop applies to the live (newer) gesture only.
    expect(controller.activeInteractionIntent).toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('delayed async target stays pending through stillness, then completes (never mistaken for no-effect)', async () => {
    // Regression pin for the tab handoff: a hidden handoff target with an
    // unchanged fingerprint and sustained stillness must PEND (async
    // mutation delayed, e.g. DB-first selection held open) — dropping it
    // would strand a stale pre-click snapshot while geometry held fine.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    Object.defineProperty(container, 'scrollTop', { value: -400, writable: true, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 9000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
    const strip = document.createElement('div')
    strip.setAttribute('data-testid', 'answer-group-selector')
    strip.setAttribute('data-message-id', 'm1')
    mockRect(strip, 'strip-m1')
    const row = document.createElement('div')
    row.id = 'message-m1'
    row.setAttribute('data-message-id', 'm1')
    row.style.display = 'none'
    mockRect(row, 'row-m1')
    container.append(strip, row)
    document.body.append(container)
    const ref = { current: container }
    rects.set('strip-m1', { top: 200, height: 22 })
    // Answer tabs keep the default TOP baseline (no `end` declaration on the
    // strip): the strip height is stable so TOP is the correct model.
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'answer-tab',
        200,
        { fingerprint: { scopeH: 0, scopeW: 0 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Long stillness with the target hidden: still pending, nothing written.
    await act(async () => {
      for (let i = 0; i < 12; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Selection commits late: target appears, tab shifts +60 (churn held).
    act(() => {
      row.style.display = 'inline-block'
      rects.set('row-m1', { top: 40, height: 300 })
      rects.set('strip-m1', { top: 260, height: 22 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-340)
    // Converged frame: compensation moved every offset by -60.
    act(() => {
      rects.set('strip-m1', { top: 200, height: 22 })
      rects.set('row-m1', { top: -20, height: 300 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m1')
    expect(stored?.intraRowOffset).toBe(-20)
    keeper.unmount()
    document.body.innerHTML = ''
  })

  it('same-size intra-scope reflow with compensation still hands off (F1)', async () => {
    // F1 regression: the region displaces inside UNCHANGED scope dims, the
    // hold compensates before any validation observes the displacement, and
    // stillness follows. Effect evidence (observed displacement latched for
    // the same gesture) must complete the handoff — the quiet drop must not
    // mistake it for a no-effect click and strand a stale snapshot.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Same-size reflow: region shifts +60 while the scope owner keeps its
    // exact dimensions. The hold compensates synchronously.
    act(() => {
      rects.set('row-m1', { top: -100, height: 300 })
      rects.set('footer-m1', { top: 180, height: 26 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-340)
    // Converged frame (compensation moved every offset by -60).
    act(() => {
      rects.set('footer-m1', { top: 120, height: 26 })
    })
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -100
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m1')
    expect(stored?.intraRowOffset).toBe(-100)
    keeper.unmount()
  })

  it('structural replacement at identical geometry still hands off (F1)', async () => {
    // Same region key, different connected node, same offsets and dims
    // (e.g. an exactly height-preserving control swap): the replacement
    // itself is effect evidence — the handoff must complete, not drop.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { ref, row, footer } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Baseline validation records the live node before the swap.
    await act(async () => {
      await flushFrame()
    })
    // Replacement lands at identical geometry.
    const replacement = document.createElement('div')
    replacement.setAttribute('data-interaction-region', 'message-controls')
    replacement.setAttribute('data-viewport-baseline-edge', 'end')
    mockRect(replacement, 'footer-m1')
    act(() => {
      row.removeChild(footer)
      row.append(replacement)
      keeper.rerender(1)
    })
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m1')
    expect(stored?.intraRowOffset).toBe(-100)
    keeper.unmount()
  })

  it('continuous drag settles through the shared discrete path (no deferred gate)', async () => {
    // A resize drag arms the same plain message-controls hold at the region
    // bottom; every frame compensates at that bottom and quiet validation
    // hands off to the stable row below. No settle flag, no release call.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    rects.set('row-m2', { top: 360, height: 120 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Drag frame: bottom displaces +72, the hold compensates synchronously.
    act(() => {
      rects.set('row-m1', { top: -100, height: 460 })
      rects.set('footer-m1', { top: 180, height: 38 })
      rects.set('row-m2', { top: 432, height: 120 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-328)
    // Final committed height converges back to the captured bottom; the
    // handoff adopts the below row with no release step in between.
    act(() => {
      rects.set('row-m1', { top: -260, height: 460 })
      rects.set('footer-m1', { top: 108, height: 38 })
      rects.set('row-m2', { top: 360, height: 120 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: 360
    })
    keeper.unmount()
  })

  it('bottommost edit with changed dims stays pending (never its own TOP, never a row above)', async () => {
    // The edited row is bottommost (no visible row below) and grew: there is
    // no adjacent handoff target — its own TOP moves with the gesture, and a
    // row above has the changing row height between it and the baseline, so
    // holding either lets continued motion drift the region. The intent stays
    // pending with the valid baseline retained event-driven (no deadline
    // expiry while the region stays connected/finite/visible): layout events
    // keep holding the captured bottom, and persistence is covered by the
    // departure freeze. A second growth in the same session is held at the
    // same baseline instead of switching ends.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    // Scope row m1 with nothing below it: m2 (group member, default top 0)
    // sits inside m1's span, so it is neither below (top 0 < scope bottom
    // 199) nor a valid handoff.
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Growth lands: bottom displaces +72 with no adjacent row to take it.
    act(() => {
      rects.set('row-m1', { top: -100, height: 460 })
      rects.set('footer-m1', { top: 180, height: 38 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-328)
    // Converged with the bottom restored (row extends upward).
    act(() => {
      rects.set('row-m1', { top: -260, height: 460 })
      rects.set('footer-m1', { top: 108, height: 38 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    // Still pending: no adopt to the moving own TOP, no snapshot write, the
    // pre-edit reading anchor is untouched.
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -100
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Second growth in the same session: the pending hold keeps the same
    // bottom baseline (no end-switch).
    act(() => {
      rects.set('row-m1', { top: -260, height: 560 })
      rects.set('footer-m1', { top: 208, height: 38 })
      keeper.rerender(1)
    })
    // Bottom displaces +100 (246 - 146); the hold compensates synchronously.
    expect(container.scrollTop).toBe(-228)
    act(() => {
      rects.set('row-m1', { top: -360, height: 560 })
      rects.set('footer-m1', { top: 108, height: 38 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('edit shrink (tall→short) keeps the same bottom baseline; a second growth still holds below', async () => {
    // Direction independence + settle-after-handoff: cancel shrinks the row
    // above the fixed bottom (bottom 146 stays, top falls back down), and a
    // later typing growth in the same session is held by the ordinary
    // below-row anchor (m2) — never by switching back to the edited row TOP.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', 360)
    rects.set('row-m1', { top: -260, height: 460 })
    rects.set('footer-m1', { top: 108, height: 38 })
    rects.set('row-m2', { top: 360, height: 120 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    // Cancel capture at the tall action-bar bottom (108 + 38 = 146).
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 460, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Shrink lands: footer bottom displaces upward (146 → 100, delta -46)
    // while the below row is pushed up with it.
    act(() => {
      rects.set('row-m1', { top: -260, height: 300 })
      rects.set('footer-m1', { top: 74, height: 26 })
      rects.set('row-m2', { top: 314, height: 120 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-446)
    // Converged: the footer bottom is back at 146? No — the shrink settles at
    // the SHORT footer geometry whose bottom is the same invariant only when
    // measured against the row bottom. Model the settled short row with its
    // bottom restored (row top -100, bottom 200) and the footer bottom back
    // at the captured 146 (top 120 + 26): the hold returns scrollTop and the
    // handoff adopts the below row at its restored offset.
    act(() => {
      rects.set('row-m1', { top: -100, height: 300 })
      rects.set('footer-m1', { top: 120, height: 26 })
      rects.set('row-m2', { top: 360, height: 120 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: 360
    })
    keeper.unmount()
  })

  it('correspondence deadline fails closed with no adopt and no snapshot', async () => {
    // A hidden/unresolvable handoff target pends bounded by the fail-closed
    // correspondence deadline: past it the intent drops with no adopt.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { ref, row } = buildScopes()
    // Hide the scope row so the handoff target stays unresolvable (pending).
    row.style.display = 'none'
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    const capturedAt = controller.activeInteractionIntent?.capturedAt ?? 0
    expect(capturedAt).toBeGreaterThan(0)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(capturedAt + 20000 + 1)
    try {
      await act(async () => {
        for (let i = 0; i < 3; i++) await flushFrame()
      })
    } finally {
      spy.mockRestore()
    }
    expect(controller.activeInteractionIntent).toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('width-only reflow keeps the scope own row (never the below neighbor)', async () => {
    // Height gate: a width-only reflow leaves the row TOP stationary, so the
    // scope keeps its own row even with a visible row below. Width stays only
    // generic structural/convergence evidence (adopt), never a neighbor
    // switch.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    rects.set('row-m2', { top: 360, height: 120 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Width-only reflow: same height, wider owner, region bottom unmoved.
    act(() => {
      rects.set('row-m1', { top: -100, height: 300, width: 360 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-400)
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -100
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m1')
    keeper.unmount()
  })

  it('height growth hands off below, never above nor the moving own TOP', async () => {
    // Direction proof with an above row present: the handoff adopts the
    // first visible row BELOW (m2), never the above row (m0) and never the
    // edited row's moving TOP (m1).
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    rects.set('row-m2', { top: 360, height: 120 })
    rects.set('row-m0', { top: -500, height: 120 })
    containerRect.top = 0
    const { container, ref, row } = buildScopes()
    const above = document.createElement('div')
    above.id = 'message-m0'
    above.setAttribute('data-message-id', 'm0')
    mockRect(above, 'row-m0')
    container.insertBefore(above, row)
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      rects.set('row-m1', { top: -100, height: 460 })
      rects.set('footer-m1', { top: 180, height: 38 })
      rects.set('row-m2', { top: 432, height: 120 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-328)
    act(() => {
      rects.set('row-m1', { top: -260, height: 460 })
      rects.set('footer-m1', { top: 108, height: 38 })
      rects.set('row-m2', { top: 360, height: 120 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    const anchor = controller.getAnchorFor({ topicId: 't1', route: null })
    expect(anchor).toEqual({ kind: 'message', messageId: 'm2', offset: 360 })
    expect(anchor?.kind).toBe('message')
    if (anchor?.kind === 'message') {
      expect(anchor.messageId).not.toBe('m0')
      expect(anchor.messageId).not.toBe('m1')
    }
    keeper.unmount()
  })

  it('natural tail (null bottom anchor) refuses non-tab capture: no pending, no deadline', async () => {
    // True bottom owns geometry via the bottom pin: an explicit send-bottom
    // clears the row keeper, and a later controls press arms nothing —
    // fail-closed at capture, so no pending intent can ever age into the
    // 20s correspondence-deadline path.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    expect(controller.beginSendBottom({ topicId: 't1', route: null })).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(false)
    expect(controller.activeInteractionIntent).toBeNull()
  })

  it('anchored bottommost: valid baseline never expires; later growth keeps BOTTOM, late neighbor hands off', async () => {
    // Remedy C direct proof. Bottommost scope with a live reading anchor (no
    // lower row): the valid connected/finite/visible baseline never expires
    // on wall time — past 20s the intent is still armed, validation polling
    // is stopped (no perpetual rAF while quiet), later height changes are
    // still compensated at the captured BOTTOM (never the moving own TOP, so
    // the old TOP never regains ownership), nothing is snapshotted while
    // compensating, and a later-appearing below row hands off to the correct
    // id through the original quiet-verified path.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      rects.set('row-m1', { top: -100, height: 460 })
      rects.set('footer-m1', { top: 180, height: 38 })
      keeper.rerender(1)
    })
    // Bottom displaces +72 (218 - 146); the hold compensates synchronously.
    expect(container.scrollTop).toBe(-328)
    act(() => {
      rects.set('row-m1', { top: -260, height: 460 })
      rects.set('footer-m1', { top: 108, height: 38 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    // Still pending with the pre-edit reading anchor untouched, no snapshot.
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -100
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Quiet event-driven proof: while nothing changes the keeper schedules no
    // new validation frames — only this test's own flush frames run.
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame')
    try {
      const before = rafSpy.mock.calls.length
      await act(async () => {
        for (let i = 0; i < 6; i++) await flushFrame()
      })
      expect(rafSpy.mock.calls.length - before).toBe(6)
    } finally {
      rafSpy.mockRestore()
    }
    expect(controller.activeInteractionIntent).not.toBeNull()
    // Past the old 20s correspondence bound the valid baseline is retained
    // (no expiry, no adopt, no snapshot) — and still schedules nothing.
    const capturedAt = controller.activeInteractionIntent?.capturedAt ?? 0
    expect(capturedAt).toBeGreaterThan(0)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(capturedAt + 20000 + 1)
    const rafSpy2 = vi.spyOn(globalThis, 'requestAnimationFrame')
    try {
      const before = rafSpy2.mock.calls.length
      await act(async () => {
        for (let i = 0; i < 3; i++) await flushFrame()
      })
      expect(rafSpy2.mock.calls.length - before).toBe(3)
    } finally {
      rafSpy2.mockRestore()
      nowSpy.mockRestore()
    }
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -100
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Multiple later height changes keep the SAME bottom baseline: each hold
    // compensates the bottom delta and the old TOP never regains ownership.
    act(() => {
      rects.set('row-m1', { top: -260, height: 560 })
      rects.set('footer-m1', { top: 208, height: 38 })
      keeper.rerender(2)
    })
    // Bottom displaces +100 (246 - 146); the hold compensates synchronously.
    expect(container.scrollTop).toBe(-228)
    act(() => {
      rects.set('row-m1', { top: -360, height: 560 })
      rects.set('footer-m1', { top: 108, height: 38 })
    })
    await act(async () => {
      for (let i = 0; i < 4; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -100
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // A third change in the same session still holds below, not above.
    act(() => {
      rects.set('row-m1', { top: -360, height: 640 })
      rects.set('footer-m1', { top: 188, height: 38 })
      keeper.rerender(3)
    })
    // Bottom displaces +80 (226 - 146); the hold compensates synchronously.
    expect(container.scrollTop).toBe(-148)
    act(() => {
      rects.set('row-m1', { top: -440, height: 640 })
      rects.set('footer-m1', { top: 108, height: 38 })
    })
    await act(async () => {
      for (let i = 0; i < 4; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -100
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // A lower neighbor later appears: the original quiet-verified handoff
    // adopts the correct below id (m3), never the scope TOP or a row above.
    const below = document.createElement('div')
    below.id = 'message-m3'
    below.setAttribute('data-message-id', 'm3')
    mockRect(below, 'row-m3')
    rects.set('row-m3', { top: 360, height: 120 })
    act(() => {
      container.append(below)
      keeper.rerender(4)
    })
    await act(async () => {
      for (let i = 0; i < 8; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm3',
      offset: 360
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m3')
    expect(stored?.intraRowOffset).toBe(360)
    keeper.unmount()
  })

  it('natural bottom pin survives past 20s with no snapshot and no TOP takeover', async () => {
    // True physical bottom (null anchor, bottom pin owns): a controls press
    // arms nothing at capture, so no intent can age; past 20s and across
    // later insertions the pin still holds scrollTop 0, the anchor stays
    // null (no row TOP regains ownership), and nothing is snapshotted.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    expect(controller.beginSendBottom({ topicId: 't1', route: null })).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 600, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(false)
    expect(controller.activeInteractionIntent).toBeNull()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20001)
    try {
      await act(async () => {
        for (let i = 0; i < 3; i++) await flushFrame()
      })
    } finally {
      nowSpy.mockRestore()
    }
    // Later insertions keep the pin: drift is clamped back to the bottom.
    const tail = document.createElement('div')
    tail.id = 'message-m3'
    tail.setAttribute('data-message-id', 'm3')
    mockRect(tail, 'row-m3')
    rects.set('row-m3', { top: 200, height: 120 })
    act(() => {
      container.append(tail)
      try {
        container.scrollTop = -50
      } catch {}
      keeper.rerender(1)
    })
    await act(async () => {
      for (let i = 0; i < 3; i++) await flushFrame()
    })
    expect(container.scrollTop).toBe(0)
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('genuine user intent invalidates the hold through the existing guard', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    controller.declareUserIntent()
    await act(async () => {
      for (let i = 0; i < 2; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    controller.clearUserIntent()
    keeper.unmount()
  })

  it('latched effect dies with its gesture; overwrite drops clean (F1)', async () => {
    // Stale/effect invalidation: gesture 1 latches real effect evidence,
    // then gesture 2 overwrites with matching live geometry. The old
    // evidence must never complete for the new gesture — gesture 2 drops
    // with no adopt and no snapshot.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        146,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Real displacement for gesture 1: hold compensates and latches effect.
    act(() => {
      rects.set('footer-m1', { top: 180, height: 26 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-340)
    await act(async () => {
      await flushFrame()
    })
    // Overwrite with the live geometry: gesture 2 observes no displacement,
    // no replacement, no dimension change.
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm1' },
        'message-controls',
        206,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    await act(async () => {
      for (let i = 0; i < 12; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })
})

describe('visual baseline edge: default TOP vs declared BOTTOM share one helper', () => {
  it('capture and hold re-resolve through the same helper (no end switch on replacement)', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    rects.set('toggle-g1', { top: 400, height: 26 })
    rects.set('group-g1', { top: 350, height: 200 })
    containerRect.top = 0
    const { container, footer, toggle } = buildScopes()
    // Capture: default TOP for fold, declared BOTTOM for message-controls —
    // both through the shared helper.
    expect(mod.captureInteractionIntent(controller, { kind: 'group', id: 'g1' }, 'fold-controls', container)).toBe(true)
    expect(controller.activeInteractionIntent).toMatchObject({ region: 'fold-controls', offset: 400 })
    expect(mod.captureInteractionIntent(controller, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(
      true
    )
    expect(controller.activeInteractionIntent).toMatchObject({ region: 'message-controls', offset: 146 })
    // Hold re-resolution uses the same helper: identical edges, unified delta.
    const scopeEl = mod.resolveInteractionScopeElement(container, { kind: 'message', id: 'm1' })
    expect(scopeEl).not.toBeNull()
    const regionEl = mod.resolveInteractionRegionElement(container, { kind: 'message', id: 'm1' }, 'message-controls')
    expect(regionEl).not.toBeNull()
    expect(mod.resolveViewportBaselineEdge(regionEl)).toBe('end')
    expect(mod.measureViewportRegionOffset(regionEl as HTMLElement, container)).toBe(146)
    expect(mod.resolveViewportBaselineEdge(toggle)).toBe('start')
    expect(mod.measureViewportRegionOffset(toggle, container)).toBe(400)
    expect(mod.resolveViewportBaselineEdge(footer)).toBe('end')
    // Replacement keeps the same declaration: the resolver finds the new node
    // by stable identity, the helper still measures BOTTOM (no two-ends).
    const replacement = document.createElement('div')
    replacement.setAttribute('data-interaction-region', 'message-controls')
    replacement.setAttribute('data-viewport-baseline-edge', 'end')
    const row = footer.parentElement as HTMLElement
    row.removeChild(footer)
    row.append(replacement)
    const reResolved = mod.resolveInteractionRegionElement(container, { kind: 'message', id: 'm1' }, 'message-controls')
    expect(reResolved).toBe(replacement)
    expect(mod.resolveViewportBaselineEdge(reResolved)).toBe('end')
    row.removeChild(replacement)
    row.append(footer)
  })

  it('height-changed controls hold BOTTOM while TOP moves (not metadata only)', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    rects.set('row-m1', { top: -100, height: 300 })
    rects.set('footer-m1', { top: 120, height: 26 })
    rects.set('row-m2', { top: 360, height: 120 })
    containerRect.top = 0
    const { container, ref } = buildScopes()
    // Capture through the helper: declared BOTTOM 146 (TOP would be 120).
    expect(mod.captureInteractionIntent(controller, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(
      true
    )
    expect(controller.activeInteractionIntent).toMatchObject({ offset: 146 })
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Growth: TOP moves +60 (120 → 180) and BOTTOM moves +60 (146 → 206)
    // with the same-shape footer; the hold compensates the BOTTOM delta.
    act(() => {
      rects.set('footer-m1', { top: 180, height: 26 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-340)
    // Taller action bar (38): TOP moves to 180 but BOTTOM is 218; the helper
    // still measures BOTTOM, not the moving TOP.
    act(() => {
      rects.set('footer-m1', { top: 180, height: 38 })
      keeper.rerender(2)
    })
    const live = mod.resolveInteractionRegionElement(container, { kind: 'message', id: 'm1' }, 'message-controls')
    expect(live).not.toBeNull()
    expect(mod.measureViewportRegionOffset(live as HTMLElement, container)).toBe(218)
    keeper.unmount()
  })
})

describe('deferred (asynchronous) layout mutation: mid-list insertion', () => {
  /**
   * Mid-list chat geometry under column-reverse: the DOM is newest-first, so
   * `m3` (newer) sits visually BELOW the clicked row `m1` and `m4` (older)
   * above it. Inserting the user/assistant pair after `m1` therefore places it
   * directly below `m1` and, at an unchanged scroll position, pushes `m1` and
   * everything above it UP by the inserted height while the newer rows below
   * keep their distance from the content bottom.
   */
  const buildMidList = (): {
    container: HTMLDivElement
    ref: { current: HTMLDivElement | null }
    below: HTMLDivElement
  } => {
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    Object.defineProperty(container, 'scrollTop', { value: -1500, writable: true, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 9000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
    const make = (id: string): HTMLDivElement => {
      const el = document.createElement('div')
      el.id = `message-${id}`
      el.setAttribute('data-message-id', id)
      mockRect(el, `row-${id}`)
      return el
    }
    const below = make('m3')
    const row = make('m1')
    const footer = document.createElement('div')
    footer.setAttribute('data-interaction-region', 'message-controls')
    footer.setAttribute('data-viewport-baseline-edge', 'end')
    mockRect(footer, 'footer-m1')
    row.append(footer)
    const above = make('m4')
    container.append(below, row, above)
    document.body.append(container)
    return { container, ref: { current: container }, below }
  }

  const seedMidListRects = (): void => {
    rects.set('row-m3', { top: 400, height: 200 })
    rects.set('row-m1', { top: 100, height: 300 })
    rects.set('footer-m1', { top: 300, height: 26 })
    rects.set('row-m4', { top: -200, height: 300 })
  }

  it('holds the clicked region and the content above it while the inserted pair extends downward', async () => {
    // The reported bug: the insert command's rows land only after the
    // authority round-trip, so the DOM is unchanged far longer than the
    // quiet-read bound and the gesture was dropped as a "no-effect click";
    // the arriving rows then displaced the clicked region and the content
    // above it by the inserted height. Declaring the gesture deferred keeps
    // the SAME shared hold armed across the gap, so the first frame that
    // shows the rows is already compensated.
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', 300)
    seedMidListRects()
    containerRect.top = 0
    const { container, ref } = buildMidList()
    expect(mod.captureInteractionIntent(controller, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(
      true
    )
    expect(controller.activeInteractionIntent).toMatchObject({ region: 'message-controls', offset: 326 })
    const token = mod.markInteractionLayoutDeferred(controller, { kind: 'message', id: 'm1' }, 'message-controls')
    expect(typeof token).toBe('number')
    expect(controller.activeInteractionIntent?.pendingLayoutMutation).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Async gap far past the quiet-read bound: still armed, nothing written and
    // no false "no effect" verdict.
    await act(async () => {
      for (let i = 0; i < 14; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.activeInteractionIntent?.pendingLayoutMutation).toBe(true)
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Rows land: below m1 stays put, m1 and everything above move up by 110.
    act(() => {
      rects.set('row-m1', { top: -10, height: 300 })
      rects.set('footer-m1', { top: 190, height: 26 })
      rects.set('row-m4', { top: -310, height: 300 })
      keeper.rerender(1)
    })
    // Same frame, before any convergence: the region is held at its captured
    // baseline by moving the viewport up (away from the bottom) by the
    // inserted height.
    expect(container.scrollTop).toBe(-1610)
    expect(mod.settleInteractionLayoutDeferred(controller, token, 'applied')).toBe(true)
    // Converged frame: compensation shifted every offset back down by 110, so
    // the clicked region and the content above keep their exact viewport
    // positions while the newer row below moved down (expanded downward).
    act(() => {
      rects.set('row-m1', { top: 100, height: 300 })
      rects.set('footer-m1', { top: 300, height: 26 })
      rects.set('row-m4', { top: -200, height: 300 })
      rects.set('row-m3', { top: 510, height: 200 })
    })
    await act(async () => {
      for (let i = 0; i < 8; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: 100
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m1')
    expect(stored?.intraRowOffset).toBe(100)
    expect(stored?.isAtBottom).toBe(false)
    keeper.unmount()
  })

  it('a command that never lands drops the deferred gesture fail-closed (no adopt, no snapshot)', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', 300)
    seedMidListRects()
    containerRect.top = 0
    const { container, ref } = buildMidList()
    expect(mod.captureInteractionIntent(controller, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(
      true
    )
    const token = mod.markInteractionLayoutDeferred(controller, { kind: 'message', id: 'm1' }, 'message-controls')
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).not.toBeNull()
    // The insert rejected: nothing will land, so the gesture is released.
    expect(mod.settleInteractionLayoutDeferred(controller, token, 'failed')).toBe(true)
    expect(controller.activeInteractionIntent).toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: 300
    })
    keeper.unmount()
  })

  it('genuine user scroll during the gap wins: the deferred hold never pulls the user back', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', 300)
    seedMidListRects()
    containerRect.top = 0
    const { container, ref } = buildMidList()
    expect(mod.captureInteractionIntent(controller, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(
      true
    )
    expect(
      mod.markInteractionLayoutDeferred(controller, { kind: 'message', id: 'm1' }, 'message-controls')
    ).not.toBeNull()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    await act(async () => {
      for (let i = 0; i < 3; i++) await flushFrame()
    })
    // Genuine input supersedes the pending local hold (position-intent
    // priority) and the user scrolls to a new position of their own.
    act(() => {
      controller.declareUserIntent()
      container.scrollTop = -1300
    })
    await act(async () => {
      for (let i = 0; i < 3; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    // Rows land afterwards: the deferred region hold must not restore the
    // pre-click baseline over the user's own scroll position.
    act(() => {
      rects.set('row-m1', { top: -10, height: 300 })
      rects.set('footer-m1', { top: 190, height: 26 })
      rects.set('row-m4', { top: -310, height: 300 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).not.toBe(-1610)
    keeper.unmount()
  })

  it('true bottom keeps its ownership: no deferred gesture can be declared there', async () => {
    // Bottom behaviour is unchanged: at the natural bottom the bottom pin owns
    // geometry, capture refuses, and the dispatching call site's declaration
    // finds no armed gesture (returns null) instead of inventing one.
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    expect(controller.beginSendBottom({ topicId: 't1', route: null })).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    seedMidListRects()
    containerRect.top = 0
    const { container } = buildMidList()
    expect(mod.captureInteractionIntent(controller, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(
      false
    )
    expect(mod.markInteractionLayoutDeferred(controller, { kind: 'message', id: 'm1' }, 'message-controls')).toBeNull()
    expect(controller.activeInteractionIntent).toBeNull()
    expect(mod.settleInteractionLayoutDeferred(controller, null, 'applied')).toBe(false)
    document.body.innerHTML = ''
  })
})

/**
 * Deletion survivor geometry (role-aware adjacency).
 *
 * A delete is the one same-route interaction whose own clicked region is
 * destroyed by its effect, so its baseline can only be an adjacent SURVIVING
 * row: the message above the block when a user row is deleted together with its
 * replies (that row keeps its visual position and the content below moves up),
 * or the message below when an assistant row is deleted alone (that row keeps
 * its visual position). Both directions run through the one shared keeper; the
 * removed rows never become a baseline, a missing adjacency keeps the
 * pre-existing bounded behavior, and user intent still wins.
 */
describe('deletion survivor boundary: role-aware adjacent row keeps its visual position', () => {
  interface DeleteRowSpec {
    id: string
    top: number
    height: number
    askId?: string
  }

  const buildDeleteRows = (
    spec: DeleteRowSpec[]
  ): { container: HTMLDivElement; rows: Map<string, HTMLDivElement>; ref: { current: HTMLDivElement | null } } => {
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    Object.defineProperty(container, 'scrollTop', { value: -400, writable: true, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 9000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
    const rows = new Map<string, HTMLDivElement>()
    for (const s of spec) {
      const row = document.createElement('div')
      row.id = `message-${s.id}`
      row.setAttribute('data-message-id', s.id)
      if (s.askId) row.setAttribute('data-ask-id', s.askId)
      mockRect(row, `row-${s.id}`)
      rects.set(`row-${s.id}`, { top: s.top, height: s.height })
      container.append(row)
      rows.set(s.id, row)
    }
    document.body.append(container)
    return { container, rows, ref: { current: container } }
  }

  it('user delete keeps the surviving row ABOVE and lets the content below move up', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', 130)
    containerRect.top = 0
    // m1 above, m2 = the user row being deleted, m3 = its assistant reply
    // (removed with it), m4 below.
    const { container, rows, ref } = buildDeleteRows([
      { id: 'm1', top: 100, height: 80 },
      { id: 'm2', top: 190, height: 60 },
      { id: 'm3', top: 260, height: 200, askId: 'm2' },
      { id: 'm4', top: 480, height: 100 }
    ])
    // Every row the deletion removes is resolved from the DOM BEFORE the
    // mutation — the reply disappears with its user row, so neither can be a
    // baseline.
    expect(mod.collectDeletedMessageRowIds(container, 'm2')).toEqual(['m2', 'm3'])
    expect(mod.captureDeletionSurvivorIntent(controller, { id: 'm2', role: 'user' }, container)).toBe(true)
    expect(controller.activeInteractionIntent?.survivorRow).toEqual({
      messageId: 'm1',
      offset: 100,
      direction: 'above'
    })
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Rows land: the removed block (60 + 200) is gone, so with an unchanged
    // scrollTop every surviving row above it would drop by 260 — m1 would leave
    // its visual position and the content below would stay put.
    act(() => {
      rows.get('m2')?.remove()
      rows.get('m3')?.remove()
      rects.set('row-m1', { top: 360, height: 80 })
      keeper.rerender(1)
    })
    // Compensated upward by exactly the removed height: the above row is back at
    // its captured offset and the below row has moved up.
    expect(container.scrollTop).toBe(-140)
    act(() => {
      rects.set('row-m1', { top: 100, height: 80 })
      rects.set('row-m4', { top: 220, height: 100 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: 100
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m1')
    expect(stored?.intraRowOffset).toBe(100)
    keeper.unmount()
  })

  it('assistant delete keeps the surviving row BELOW with no scroll write', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm5', 130)
    containerRect.top = 0
    const { container, rows, ref } = buildDeleteRows([
      { id: 'm4', top: 100, height: 80 },
      { id: 'm5', top: 190, height: 60, askId: 'u1' },
      { id: 'm6', top: 260, height: 100 }
    ])
    // A non-user row goes alone: only the clicked row is removed.
    expect(mod.collectDeletedMessageRowIds(container, 'm5')).toEqual(['m5'])
    expect(mod.captureDeletionSurvivorIntent(controller, { id: 'm5', role: 'assistant' }, container)).toBe(true)
    expect(controller.activeInteractionIntent?.survivorRow).toEqual({
      messageId: 'm6',
      offset: 260,
      direction: 'below'
    })
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      rows.get('m5')?.remove()
      // The above row drops by the removed height; the BELOW row keeps its
      // visual position, which is the existing, correct assistant-delete
      // experience that must not regress.
      rects.set('row-m4', { top: 160, height: 80 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-400)
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm6',
      offset: 260
    })
    const stored = store.get('scroll:topic-t1::main') as { messageId: string | null } | undefined
    expect(stored?.messageId).toBe('m6')
    keeper.unmount()
  })

  it('missing adjacency keeps the bounded fallback (no invented baseline)', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'u1', 20)
    containerRect.top = 0
    // First user row of the topic: nothing survives above it.
    const first = buildDeleteRows([
      { id: 'u1', top: 20, height: 60 },
      { id: 'a1', top: 90, height: 100, askId: 'u1' }
    ])
    expect(mod.captureDeletionSurvivorIntent(controller, { id: 'u1', role: 'user' }, first.container)).toBe(false)
    expect(controller.activeInteractionIntent).toBeNull()
    document.body.innerHTML = ''
    // Tail assistant row: nothing survives below it (bottom pin keeps owning
    // the geometry).
    const tail = buildDeleteRows([{ id: 'a2', top: 300, height: 120 }])
    expect(mod.captureDeletionSurvivorIntent(controller, { id: 'a2', role: 'assistant' }, tail.container)).toBe(false)
    expect(controller.activeInteractionIntent).toBeNull()
  })

  it('a non-delete control keeps its region baseline (no survivor semantics)', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const { container } = buildDeleteRows([{ id: 'm1', top: -100, height: 300 }])
    const footer = document.createElement('div')
    footer.setAttribute('data-interaction-region', 'message-controls')
    footer.setAttribute('data-viewport-baseline-edge', 'end')
    mockRect(footer, 'footer-m1')
    rects.set('footer-m1', { top: 140, height: 26 })
    container.firstElementChild?.append(footer)
    expect(mod.captureInteractionIntent(controller, { kind: 'message', id: 'm1' }, 'message-controls', container)).toBe(
      true
    )
    // Edit / expand / tab gestures carry no deletion survivor and keep the
    // declared region baseline, and the retained-row derivation still names the
    // held row rather than a survivor.
    expect(controller.activeInteractionIntent?.survivorRow).toBeUndefined()
    expect(controller.activeInteractionIntent?.offset).toBe(166)
    expect(mod.resolveRetainedViewportMessageId(controller)).toBe('m1')
  })

  it('a deferred deletion survives the authority gap, then hands off once the rows land', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', 130)
    containerRect.top = 0
    const { container, rows, ref } = buildDeleteRows([
      { id: 'm1', top: 100, height: 80 },
      { id: 'm2', top: 190, height: 60 },
      { id: 'm3', top: 260, height: 200, askId: 'm2' }
    ])
    expect(mod.captureDeletionSurvivorIntent(controller, { id: 'm2', role: 'user' }, container)).toBe(true)
    const token = mod.markInteractionLayoutDeferred(controller, { kind: 'message', id: 'm2' }, 'message-controls')
    expect(token).not.toBeNull()
    expect(mod.resolveRetainedViewportMessageId(controller)).toBe('m1')
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Unchanged DOM mid-flight is not a no-effect click: the gesture stays armed
    // with no adopt and no snapshot.
    await act(async () => {
      for (let i = 0; i < 12; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // The command resolves and the rows land: the same gesture now completes.
    expect(mod.settleInteractionLayoutDeferred(controller, token, 'applied')).toBe(true)
    act(() => {
      rows.get('m2')?.remove()
      rows.get('m3')?.remove()
      rects.set('row-m1', { top: 360, height: 80 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-140)
    act(() => {
      rects.set('row-m1', { top: 100, height: 80 })
    })
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    const stored = store.get('scroll:topic-t1::main') as { messageId: string | null } | undefined
    expect(stored?.messageId).toBe('m1')
    keeper.unmount()
  })

  it('explicit user intent during a pending deletion wins: no compensation, no snapshot', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', 130)
    containerRect.top = 0
    const { container, ref } = buildDeleteRows([
      { id: 'm1', top: 100, height: 80 },
      { id: 'm2', top: 190, height: 60 },
      { id: 'm3', top: 260, height: 200, askId: 'm2' }
    ])
    expect(mod.captureDeletionSurvivorIntent(controller, { id: 'm2', role: 'user' }, container)).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    controller.declareUserIntent()
    await act(async () => {
      for (let i = 0; i < 3; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(container.scrollTop).toBe(-400)
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    controller.clearUserIntent()
    keeper.unmount()
  })

  it('a disappearing survivor fails closed: no sibling transfer, no snapshot', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', 130)
    containerRect.top = 0
    const { container, rows, ref } = buildDeleteRows([
      { id: 'm1', top: 100, height: 80 },
      { id: 'm2', top: 190, height: 60 },
      { id: 'm3', top: 260, height: 200, askId: 'm2' }
    ])
    expect(mod.captureDeletionSurvivorIntent(controller, { id: 'm2', role: 'user' }, container)).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      rows.get('m1')?.remove()
      rows.get('m2')?.remove()
      rows.get('m3')?.remove()
      keeper.rerender(1)
    })
    await act(async () => {
      for (let i = 0; i < 4; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(container.scrollTop).toBe(-400)
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })
})

/**
 * A compensation write is a REQUEST: at a real physical boundary the browser
 * clamps it. The keeper records what the container ACTUALLY realized, so the
 * browse-edge gate can tell the app's own scroll from user navigation without
 * ever disarming a live gesture session.
 */
describe('compensation write truth and the app echo marker', () => {
  const buildClampedContainer = (
    initial: number,
    min: number,
    max: number
  ): { container: HTMLDivElement; ref: { current: HTMLDivElement | null }; setLayoutTop: (top: number) => void } => {
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    let value = initial
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        value = Math.min(max, Math.max(min, next))
      }
    })
    Object.defineProperty(container, 'scrollHeight', { value: 9000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
    const row = document.createElement('div')
    row.id = 'message-m1'
    row.setAttribute('data-message-id', 'm1')
    container.append(row)
    document.body.append(container)
    // Real coupling of this container: the row's viewport offset is its
    // content-space position minus the container's scroll, so a scroll write
    // moves the row (and a clamped write moves it only by what was realized).
    let layoutTop = -100
    row.getBoundingClientRect = (() => {
      const top = layoutTop - container.scrollTop
      return {
        top,
        bottom: top + 300,
        height: 300,
        left: 0,
        right: 300,
        width: 300,
        x: 0,
        y: top,
        toJSON: () => ({})
      } as DOMRect
    }) as () => DOMRect
    return {
      container,
      ref: { current: container },
      setLayoutTop: (top: number) => {
        layoutTop = top
      }
    }
  }

  it('records the realized (clamped) position, never the unreachable request', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const { container, ref, setLayoutTop } = buildClampedContainer(-400, -400, 0)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // +500 layout growth asks for scrollTop 100, which the container cannot
    // reach: it realizes 0 (the real physical boundary).
    act(() => {
      setLayoutTop(400)
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(0)
    // The echo names the position the app actually produced.
    expect(controller.consumeCompensationEcho(0)).toBe(true)
    expect(controller.consumeCompensationEcho(100)).toBe(false)
    // The realized pair is the next baseline: re-observing the same geometry
    // invents no movement and writes nothing.
    act(() => {
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(0)
    expect(controller.consumeCompensationEcho(0)).toBe(false)
    keeper.unmount()
  })

  it('an app compensation scroll during a live session is an echo; a later user scroll is not', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const { container, ref, setLayoutTop } = buildClampedContainer(-400, -4000, 0)
    // Genuine wheel gesture is live across the commit (the reported case).
    const token = controller.declareUserIntent()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      setLayoutTop(80)
      keeper.rerender(1)
    })
    // Layout settlement compensated by +180: the app's own scroll.
    expect(container.scrollTop).toBe(-220)
    expect(controller.consumeCompensationEcho(-220)).toBe(true)
    // The gesture session itself is untouched (never disarmed by the echo).
    expect(controller.hasActiveUserInteraction()).toBe(true)
    expect(controller.activeInteractionToken?.interactionId).toBe(token.interactionId)
    // A fresh wheel after settlement refreshes the session and its own scroll is
    // genuine input, so the gate still pages on it.
    const refreshed = controller.declareUserIntent()
    expect(refreshed.interactionId).toBe(token.interactionId)
    expect(controller.consumeCompensationEcho(-380)).toBe(false)
    keeper.unmount()
  })

  it('a genuine wheel coalesced with the keeper write is never swallowed at the same position', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const { container, ref, setLayoutTop } = buildClampedContainer(-400, -4000, 0)
    const token = controller.declareUserIntent()
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      setLayoutTop(80)
      keeper.rerender(1)
    })
    // The keeper's own compensation realized -220 under the live gesture.
    expect(container.scrollTop).toBe(-220)
    // A fresh wheel lands before the browser delivers the coalesced scroll
    // observation: the same numeric position is no longer provably app-only, so
    // the gate must not suppress it.
    const refreshed = controller.declareUserIntent()
    expect(refreshed.interactionId).toBe(token.interactionId)
    expect(controller.consumeCompensationEcho(-220)).toBe(false)
    expect(controller.hasActiveUserInteraction()).toBe(true)
    keeper.unmount()
  })
})

describe('segment fold/expand: the group header is the viewport anchor', () => {
  const BODY_H = 200
  const HEADER_CONTENT_TOP = -200
  const BELOW_CONTENT_TOP = 20
  const SEGMENT_SCOPE_ID = 'seg-1'

  /**
   * A topic-segment group in the real column-reverse layout. The layout is
   * bottom-anchored: removing the group body from the flow shifts the seam —
   * and everything above it — DOWN by the removed body height, while the
   * content BELOW the seam keeps its content-space position. That is exactly
   * the recorded production displacement (header + above moved, below stayed),
   * reproduced here as the honest starting point for the compensation.
   *
   * Rects are coupled to the container's real scroll position, so the keeper's
   * compensation write moves the rows exactly as it does in production and a
   * physical clamp moves them only by what was actually realized.
   */
  const buildSegmentViewport = (
    initialScrollTop: number,
    clampMin: number,
    opts: { bodyHeight?: number; scrollHeight?: number; clientHeight?: number } = {}
  ) => {
    const bodyHeight = opts.bodyHeight ?? BODY_H
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    let value = initialScrollTop
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        value = Math.min(0, Math.max(clampMin, next))
      }
    })
    Object.defineProperty(container, 'scrollHeight', {
      value: opts.scrollHeight ?? 9000,
      writable: true,
      configurable: true
    })
    Object.defineProperty(container, 'clientHeight', {
      value: opts.clientHeight ?? 600,
      writable: true,
      configurable: true
    })
    const rectAt =
      (contentTop: number, height: number): (() => DOMRect) =>
      () => {
        const top = contentTop - container.scrollTop
        return {
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: top,
          toJSON: () => ({})
        } as DOMRect
      }
    const run = document.createElement('div')
    run.setAttribute('data-interaction-scope-id', SEGMENT_SCOPE_ID)
    const chrome = document.createElement('div')
    chrome.setAttribute('data-interaction-region', 'segment-header')
    const body = document.createElement('div')
    body.id = 'message-s1'
    body.setAttribute('data-message-id', 's1')
    const below = document.createElement('div')
    below.id = 'message-below'
    below.setAttribute('data-message-id', 'below')
    run.append(chrome, body)
    container.append(run, below)
    document.body.append(container)
    let folded = false
    const sync = (): void => {
      const delta = folded ? bodyHeight : 0
      run.getBoundingClientRect = rectAt(HEADER_CONTENT_TOP + delta, folded ? 0 : bodyHeight)
      chrome.getBoundingClientRect = rectAt(HEADER_CONTENT_TOP + delta, folded ? 0 : bodyHeight)
      body.getBoundingClientRect = rectAt(HEADER_CONTENT_TOP, bodyHeight)
      below.getBoundingClientRect = rectAt(BELOW_CONTENT_TOP, 120)
    }
    sync()
    return {
      container,
      ref: { current: container } as { current: HTMLDivElement | null },
      chrome,
      below,
      setFolded: (next: boolean) => {
        folded = next
        if (next) {
          // Fully collapsed: the chrome host stays, the body rows leave the
          // flow entirely (zero height at the seam, no placeholder band).
          if (body.parentElement === run) run.removeChild(body)
        } else if (body.parentElement !== run) {
          run.append(body)
        }
        sync()
      }
    }
  }

  const viewportTop = (el: HTMLElement): number => el.getBoundingClientRect().top

  it('non-tail fold holds the header while the content below absorbs the delta', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const { container, ref, chrome, below, setFolded } = buildSegmentViewport(-400, -8400)
    expect(viewportTop(chrome)).toBe(200)
    expect(viewportTop(below)).toBe(420)
    // The click boundary armed the region hold for this group's header before
    // React ran the handler: the seam (not the body) is the baseline.
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'group', id: SEGMENT_SCOPE_ID },
        'segment-header',
        200,
        { fingerprint: { scopeH: BODY_H, scopeW: 300 } }
      )
    ).toBe(true)
    // The persisted fold state is written DB-first, so the rows land only after
    // the authority round-trip: the gesture declares its layout effect deferred
    // and must not be mistaken for a no-effect click while the DOM is unchanged.
    const deferred = markInteractionLayoutDeferred(
      controller,
      { kind: 'group', id: SEGMENT_SCOPE_ID },
      'segment-header'
    )
    expect(typeof deferred).toBe('number')
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent?.pendingLayoutMutation).toBe(true)
    expect(controller.activeInteractionIntent?.gestureId).toBe(deferred)
    // Rows land: the body leaves the flow, so the seam would move down by the
    // removed height if nothing held it.
    act(() => {
      setFolded(true)
      keeper.rerender(1)
    })
    // The keeper realized the compensation write toward the newest edge
    // (`scrollTop += foldedBodyHeight`, no clamp here), so the header keeps its
    // captured position and the content BELOW absorbs the whole delta.
    expect(container.scrollTop).toBe(-200)
    expect(viewportTop(chrome)).toBe(200)
    expect(viewportTop(below)).toBe(220)
    // Quiet handoff: the stable boundary below the seam becomes the snapshot
    // anchor at its post-compensation position.
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('below')
    expect(stored?.intraRowOffset).toBe(220)
    expect(stored?.scrollTop).toBe(-200)
    expect(stored?.isAtBottom).toBe(false)
    keeper.unmount()
  })

  it('newest edge: the natural clamp wins with no invented blank and no forced scroll', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const { container, ref, chrome, below, setFolded } = buildSegmentViewport(-50, -8400)
    // Not enough room toward the newest edge to hold the seam: only 50px of the
    // 200px delta can be realized.
    expect(container.scrollTop).toBe(-50)
    expect(viewportTop(chrome)).toBe(-150)
    expect(viewportTop(below)).toBe(70)
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'group', id: SEGMENT_SCOPE_ID },
        'segment-header',
        -150,
        { fingerprint: { scopeH: BODY_H, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      setFolded(true)
      keeper.rerender(1)
    })
    // The write is a REQUEST: the container stops at its real physical boundary
    // (scrollTop 0) instead of being pulled past it or padded to fake a hold.
    expect(container.scrollTop).toBe(0)
    expect(container.scrollHeight).toBe(9000)
    expect(viewportTop(chrome)).toBe(0)
    expect(viewportTop(below)).toBe(20)
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    // The handoff is truthful: the row actually reached, at the honest bottom.
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('below')
    expect(stored?.intraRowOffset).toBe(20)
    expect(stored?.scrollTop).toBe(0)
    expect(stored?.isAtBottom).toBe(true)
    keeper.unmount()
  })

  // ------------------------------------------------------------- E2E exact numbers
  // The recorded production placement was `scrollTop: -124` on a container of
  // `scrollHeight: 936` / `clientHeight: 403`, and the observed header
  // displacement was exactly 41.5px. Both follow from one law:
  // `residual = max(0, foldedGroupHeight - |scrollTop|)`. The hold is a
  // REQUEST bounded by the real scroll range, never a padding invention. These
  // two cases pin both regimes at the same 124px of room: below the clamp
  // threshold for a 165.5px group (partial hold), above it for a 41.5px group
  // (full hold).
  it('E2E clamp regime: a 165.5px group under 124px of room leaves an honest 41.5px residual', async () => {
    const H = 165.5
    const START = -124
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const { container, ref, chrome, below, setFolded } = buildSegmentViewport(START, -8400, {
      bodyHeight: H,
      scrollHeight: 936,
      clientHeight: 403
    })
    const headerBefore = viewportTop(chrome)
    const belowBefore = viewportTop(below)
    expect(headerBefore).toBe(-76)
    expect(belowBefore).toBe(144)
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'group', id: SEGMENT_SCOPE_ID },
        'segment-header',
        headerBefore,
        { fingerprint: { scopeH: H, scopeW: 300 } }
      )
    ).toBe(true)
    // DB-first fold: the gesture declares its layout effect deferred, so the
    // unchanged DOM is never read as a no-effect click while the authority
    // round-trip is in flight.
    const deferred = markInteractionLayoutDeferred(
      controller,
      { kind: 'group', id: SEGMENT_SCOPE_ID },
      'segment-header'
    )
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent?.pendingLayoutMutation).toBe(true)
    expect(controller.activeInteractionIntent?.gestureId).toBe(deferred)
    // The write is bounded by the physical range: -124 + 165.5 would leave the
    // container, so it stops at 0 instead of being forced past it.
    act(() => {
      setFolded(true)
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(0)
    // No invented geometry: the scroll range is untouched, so no blank band
    // was fabricated to fake a hold.
    expect(container.scrollHeight).toBe(936)
    expect(container.clientHeight).toBe(403)
    const residual = Math.max(0, H - Math.abs(START))
    expect(residual).toBe(41.5)
    expect(Math.abs(viewportTop(chrome) - headerBefore)).toBeCloseTo(residual, 6)
    // The content below absorbed exactly the realized part of the request.
    expect(Math.abs(viewportTop(below) - belowBefore)).toBeCloseTo(Math.abs(START), 6)
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('below')
    expect(stored?.scrollTop).toBe(0)
    expect(stored?.isAtBottom).toBe(true)
    keeper.unmount()
  })

  it('E2E clamp regime: a 41.5px group inside the same 124px of room holds fully', async () => {
    const H = 41.5
    const START = -124
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    containerRect.top = 0
    const { container, ref, chrome, below, setFolded } = buildSegmentViewport(START, -8400, {
      bodyHeight: H,
      scrollHeight: 936,
      clientHeight: 403
    })
    const headerBefore = viewportTop(chrome)
    const belowBefore = viewportTop(below)
    expect(headerBefore).toBe(-76)
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'group', id: SEGMENT_SCOPE_ID },
        'segment-header',
        headerBefore,
        { fingerprint: { scopeH: H, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      setFolded(true)
      keeper.rerender(1)
    })
    // Inside the range, the same request is fully realized: the header keeps
    // its exact captured position and the content below absorbs the whole
    // delta. No residual, no clamp.
    expect(container.scrollTop).toBeCloseTo(START + H, 6)
    expect(Math.abs(viewportTop(chrome) - headerBefore)).toBe(0)
    expect(Math.abs(viewportTop(below) - belowBefore)).toBeCloseTo(H, 6)
    expect(container.scrollHeight).toBe(936)
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.scrollTop).toBeCloseTo(START + H, 6)
    expect(stored?.isAtBottom).toBe(false)
    keeper.unmount()
  })
})
