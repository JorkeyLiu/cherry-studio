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
  it('message scope: observed swap is held every frame then handed off with a snapshot', async () => {
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
        120,
        { fingerprint: { scopeH: 300, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(-400)
    // Editor replacement lands: row grows, region shifts +60 below capture.
    act(() => {
      rects.set('row-m1', { top: -100, height: 460 })
      rects.set('footer-m1', { top: 180, height: 38 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(-340)
    // Model the converged frame: compensation shifted every viewport offset
    // by -60, so the region is back at capture while the row top moved with
    // the height delta (region primary, row follows).
    act(() => {
      rects.set('row-m1', { top: -160, height: 460 })
      rects.set('footer-m1', { top: 120, height: 38 })
    })
    // Quiet validation chain hands off the post-swap visible row geometry.
    await act(async () => {
      for (let i = 0; i < 6; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm1',
      offset: -160
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m1')
    expect(stored?.intraRowOffset).toBe(-160)
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
        120,
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
        120,
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
        120,
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
        120,
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
    // Production capture records the hidden target's zero rects.
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
        120,
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
        120,
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
        120,
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
        180,
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
