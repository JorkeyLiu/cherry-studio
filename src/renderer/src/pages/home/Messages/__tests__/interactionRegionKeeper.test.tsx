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
