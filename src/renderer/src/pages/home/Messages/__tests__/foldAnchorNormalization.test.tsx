/**
 * Fold answer-tab anchor normalization (A2 root correction):
 * - tall→short shrink clamps the preserved offset to the nearest valid visible
 *   in-row position (same group, never global bottom/unrelated message);
 * - feasible offsets preserve the EXACT original;
 * - real content boxes (`id+data-message-id`) drive geometry, never the tab
 *   rectangle (`answer-group-selector`);
 * - ordinary keeper holds never write snapshots; only the validated
 *   same-group reconciliation synchronizes the route-local committed stable
 *   snapshot after layout-quiet validation (explicit same-group row, never
 *   crossing-first);
 * - bottom/non-bottom separation refuses ghost adoption;
 * - send-bottom aborts on entry-live same-id new wheel (generation, not id)
 *   and on last-moment displayed mismatch.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runSendBottomIntent, type SendBottomIntentDeps } from '../Messages'
import {
  findVisibleFoldSiblingId,
  resolveRealMessageBox,
  RouteViewportContext,
  type RouteViewportContextValue,
  useStableVisualAnchor
} from '../routeViewportContext'
import { normalizeFoldAnchorOffset, RouteViewportController } from '../routeViewportController'

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

/**
 * Production-faithful fold group: outer fold wrapper (`id` only) + inner real
 * box (`id` + `data-message-id`) per answer, plus a tab-strip selector
 * (`data-message-id` + selector testid, no `message-<id>`) that must never
 * drive geometry.
 */
const buildFoldGroup = (): {
  container: HTMLDivElement
  ref: { current: HTMLDivElement | null }
  tallWrapper: HTMLDivElement
  tallBox: HTMLDivElement
  shortWrapper: HTMLDivElement
  shortBox: HTMLDivElement
  tabForShort: HTMLDivElement
} => {
  const container = document.createElement('div')
  container.id = 'messages'
  mockRect(container, 'container')
  Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
  Object.defineProperty(container, 'scrollHeight', { value: 9000, writable: true, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
  const group = document.createElement('div')
  group.id = 'message-group-ask-1'
  const tallWrapper = document.createElement('div')
  tallWrapper.id = 'message-tall'
  const tallBox = document.createElement('div')
  tallBox.id = 'message-tall'
  tallBox.setAttribute('data-message-id', 'tall')
  mockRect(tallBox, 'tall')
  mockRect(tallWrapper, 'tall-wrapper')
  tallWrapper.append(tallBox)
  const shortWrapper = document.createElement('div')
  shortWrapper.id = 'message-short'
  const shortBox = document.createElement('div')
  shortBox.id = 'message-short'
  shortBox.setAttribute('data-message-id', 'short')
  mockRect(shortBox, 'short')
  mockRect(shortWrapper, 'short-wrapper')
  shortWrapper.append(shortBox)
  group.append(tallWrapper, shortWrapper)
  // Unrelated outside message (must never be adopted by same-group transfer).
  const outside = document.createElement('div')
  outside.id = 'message-outside'
  outside.setAttribute('data-message-id', 'outside')
  mockRect(outside, 'outside')
  // Tab-strip selector for the short answer (tab rectangle, not reading geometry).
  const tabForShort = document.createElement('div')
  tabForShort.setAttribute('data-message-id', 'short')
  tabForShort.setAttribute('data-testid', 'answer-group-selector')
  mockRect(tabForShort, 'tab-short')
  container.append(group, outside, tabForShort)
  document.body.append(container)
  return {
    container,
    ref: { current: container },
    tallWrapper: tallWrapper,
    tallBox: tallBox,
    shortWrapper: shortWrapper,
    shortBox: shortBox,
    tabForShort: tabForShort
  }
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

describe('normalizeFoldAnchorOffset (pure geometry)', () => {
  it('preserves the exact feasible offset', () => {
    expect(normalizeFoldAnchorOffset(-60, 159.6, 600)).toBe(-60)
    expect(normalizeFoldAnchorOffset(-12, 159.6, 600)).toBe(-12)
  })

  it('clamps a far-above tall offset to the short bottom segment (-h+12)', () => {
    // A2: tall pre -2235.2 cannot survive on a 159.6px short answer.
    expect(normalizeFoldAnchorOffset(-2235.2, 159.6, 600)).toBeCloseTo(-147.6, 5)
  })

  it('clamps a below-viewport offset to the top edge (vh-12)', () => {
    expect(normalizeFoldAnchorOffset(700, 159.6, 600)).toBe(588)
  })

  it('fail-closed on non-finite geometry', () => {
    expect(normalizeFoldAnchorOffset(-2235.2, 0, 600)).toBe(-2235.2)
    expect(normalizeFoldAnchorOffset(-2235.2, 159.6, 0)).toBe(-2235.2)
  })
})

describe('controller reconcile with corrected offset', () => {
  it('stores the corrected offset (not the stale tall offset) in anchor+cache', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    const corrected = normalizeFoldAnchorOffset(-2235.2, 159.6, 600)
    expect(
      controller.reconcileAnchorToVisibleMessage({ topicId: 't1', route: null }, 'short', {
        correctedOffset: corrected
      })
    ).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'short',
      offset: corrected
    })
  })

  it('refuses non-bottom null programmatic and user adoption (never proven bottom)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const ghost = controller.adoptProgrammaticViewport(
      { topicId: 't1', route: null },
      { messageId: null, intraRowOffset: null, scrollTop: -300, isAtBottom: false }
    )
    expect(ghost.taken).toBe(false)
    if (!ghost.taken) expect(ghost.reason).toBe('nonbottom-null')
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    controller.declareUserIntent()
    const token = controller.activeInteractionToken
    const wheelGhost = controller.userTakeover(
      { messageId: null, intraRowOffset: null, scrollTop: -300, isAtBottom: false },
      undefined,
      token ?? undefined
    )
    expect(wheelGhost.taken).toBe(false)
    if (!wheelGhost.taken) expect(wheelGhost.reason).toBe('nonbottom-null')
    // Proven bottom still adopts (null anchor = bottom pin).
    const bottom = controller.adoptProgrammaticViewport(
      { topicId: 't1', route: null },
      { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true }
    )
    expect(bottom.taken).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
  })
})

const flushFoldCommit = async (): Promise<void> => {
  // The keeper queues its layout-quiet validation on a single rAF after the
  // reconciling hold. Flushing one frame runs that validation (stable
  // geometry writes, unsettled/invalidated drops). Double-frame to survive a
  // fallback synchronous schedule without double-committing.
  await new Promise<void>((resolve) => {
    try {
      requestAnimationFrame(() => {
        try {
          requestAnimationFrame(() => resolve())
        } catch {
          resolve()
        }
      })
    } catch {
      resolve()
    }
  })
  // Let the queued validation's synchronous adopt+write land before assertions.
  await Promise.resolve()
}

describe('mounted keeper tall→short (A2 shrink)', () => {
  it('keeps the SAME group, normalizes to the nearest visible offset, then syncs the stable snapshot after layout quiet', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    rects.set('tall', { top: -2235.2, height: 2549.5 })
    rects.set('short', { top: -2235.2, height: 159.6 })
    rects.set('outside', { top: 500, height: 120 })
    rects.set('tab-short', { top: 550, height: 22 })
    const { container, ref, tallWrapper, shortWrapper, shortBox, tabForShort } = buildFoldGroup()
    // Pre: tall selected-visible, short hidden.
    shortWrapper.style.display = 'none'
    tallWrapper.style.display = 'inline-block'
    // Real box resolution never returns the tab rectangle.
    expect(resolveRealMessageBox(container, 'short')).toBe(shortBox)
    expect(resolveRealMessageBox(container, 'short')).not.toBe(tabForShort)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)

    // Answer-tab switch tall→short: tall collapses, short becomes visible but
    // sits entirely above the viewport at the stale tall coordinate.
    const tallBox = container.querySelector('[id="message-tall"][data-message-id="tall"]') as HTMLElement
    act(() => {
      tallWrapper.style.display = 'none'
      shortWrapper.style.display = 'inline-block'
      rects.set('short', { top: -2235.3, height: 159.6 })
      rects.set('tab-short', { top: 550, height: 22 })
      keeper.rerender(1)
    })
    // Same-group transfer with normalized offset (-159.6+12), not the stale -2235.2.
    const anchor = controller.getAnchorFor({ topicId: 't1', route: null })
    expect(anchor).toEqual({ kind: 'message', messageId: 'short', offset: expect.closeTo(-147.6, 4) })
    // Minimal local adjustment only: delta = -2235.3 - (-147.6).
    expect(container.scrollTop).toBeCloseTo(-2087.7, 0)
    // Never the global bottom / unrelated message.
    expect(anchor?.kind === 'message' ? (anchor as { messageId: string }).messageId : null).not.toBe('outside')
    expect(container.scrollTop).not.toBe(0)
    // No synchronous write: the stable sync waits for layout-quiet validation.
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    expect(findVisibleFoldSiblingId(tallBox, container)).toBe('short')
    // Layout-quiet validation (stable short real-box height + viewport):
    // the committed stable snapshot now carries the reconciled short identity.
    await act(async () => {
      await flushFoldCommit()
    })
    const stored = store.get('scroll:topic-t1::main') as
      | {
          messageId: string
          intraRowOffset: number
          scrollTop: number
          isAtBottom: boolean
        }
      | undefined
    expect(stored?.messageId).toBe('short')
    expect(stored?.intraRowOffset).toBeCloseTo(-147.6, 4)
    expect(stored?.isAtBottom).toBe(false)
    expect(typeof stored?.scrollTop).toBe('number')
    expect(stored?.scrollTop).toBeCloseTo(-2087.7, 0)
    keeper.unmount()
  })

  it('preserves the exact feasible offset short→tall, then syncs the stable snapshot after layout quiet', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'short', -60)
    rects.set('short', { top: -60, height: 159.6 })
    rects.set('tall', { top: -60, height: 900 })
    rects.set('outside', { top: 500, height: 120 })
    rects.set('tab-short', { top: 550, height: 22 })
    const { container, ref, tallWrapper, shortWrapper } = buildFoldGroup()
    tallWrapper.style.display = 'none'
    shortWrapper.style.display = 'inline-block'
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      shortWrapper.style.display = 'none'
      tallWrapper.style.display = 'inline-block'
      rects.set('tall', { top: 240, height: 900 })
      keeper.rerender(1)
    })
    // Feasible -60 survives exactly (±12): delta 300.
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'tall',
      offset: -60
    })
    expect(container.scrollTop).toBe(300)
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    await act(async () => {
      await flushFoldCommit()
    })
    const stored = store.get('scroll:topic-t1::main') as
      | {
          messageId: string
          intraRowOffset: number
          scrollTop: number
          isAtBottom: boolean
        }
      | undefined
    expect(stored?.messageId).toBe('tall')
    expect(stored?.intraRowOffset).toBe(-60)
    expect(stored?.isAtBottom).toBe(false)
    expect(stored?.scrollTop).toBe(300)
    keeper.unmount()
  })
})

describe('fold stable sync invalidation (never overwrites newer viewports)', () => {
  it('drops the queued commit on route change', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    rects.set('short', { top: -2235.3, height: 159.6 })
    const { ref, tallWrapper, shortWrapper } = buildFoldGroup()
    shortWrapper.style.display = 'none'
    tallWrapper.style.display = 'inline-block'
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      tallWrapper.style.display = 'none'
      shortWrapper.style.display = 'inline-block'
      keeper.rerender(1)
    })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })?.kind).toBe('message')
    // Newer route reconciliation before the queued frame validates.
    act(() => {
      controller.syncDisplayed({ topicId: 't1', route: 'other' })
    })
    await act(async () => {
      await flushFoldCommit()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('drops the queued commit on epoch supersession', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    rects.set('short', { top: -2235.3, height: 159.6 })
    const { ref, tallWrapper, shortWrapper } = buildFoldGroup()
    shortWrapper.style.display = 'none'
    tallWrapper.style.display = 'inline-block'
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      tallWrapper.style.display = 'none'
      shortWrapper.style.display = 'inline-block'
      keeper.rerender(1)
    })
    act(() => {
      controller.request({ kind: 'top', topicId: 't1', targetRoute: null, saved: null })
    })
    await act(async () => {
      await flushFoldCommit()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('drops the queued commit on detach', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    rects.set('short', { top: -2235.3, height: 159.6 })
    const { ref, tallWrapper, shortWrapper } = buildFoldGroup()
    shortWrapper.style.display = 'none'
    tallWrapper.style.display = 'inline-block'
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      tallWrapper.style.display = 'none'
      shortWrapper.style.display = 'inline-block'
      keeper.rerender(1)
    })
    act(() => {
      controller.detach()
    })
    await act(async () => {
      await flushFoldCommit()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('drops the queued commit on a newer genuine user takeover', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    rects.set('short', { top: -2235.3, height: 159.6 })
    const { container, ref, tallWrapper, shortWrapper } = buildFoldGroup()
    shortWrapper.style.display = 'none'
    tallWrapper.style.display = 'inline-block'
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      tallWrapper.style.display = 'none'
      shortWrapper.style.display = 'inline-block'
      keeper.rerender(1)
    })
    // A genuine wheel + takeover adopts a different reading row before validation.
    act(() => {
      container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }))
    })
    const token = controller.activeInteractionToken
    expect(token).not.toBeNull()
    const out = controller.userTakeover(
      { messageId: 'outside', intraRowOffset: -10, scrollTop: 500, isAtBottom: false },
      undefined,
      token ?? undefined
    )
    expect(out.taken).toBe(true)
    await act(async () => {
      await flushFoldCommit()
    })
    const stored = store.get('scroll:topic-t1::main') as { messageId: string } | undefined
    // Never overwrites the newer user viewport with the stale reconciliation.
    expect(stored?.messageId).not.toBe('short')
    keeper.unmount()
  })
})

describe('fold layout-quiet basis stability (no intermediate commit)', () => {
  const flushSingleFoldFrame = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      try {
        requestAnimationFrame(() => resolve())
      } catch {
        resolve()
      }
    })
    await Promise.resolve()
  }

  const queueTallToShort = (): {
    controller: RouteViewportController
    keeper: { rerender: (v: number) => void; unmount: () => void }
    container: HTMLDivElement
    ref: { current: HTMLDivElement | null }
  } => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    rects.set('tall', { top: -2235.2, height: 2549.5 })
    rects.set('short', { top: -2235.2, height: 159.6 })
    rects.set('outside', { top: 500, height: 120 })
    rects.set('tab-short', { top: 550, height: 22 })
    const built = buildFoldGroup()
    built.shortWrapper.style.display = 'none'
    built.tallWrapper.style.display = 'inline-block'
    const keeper = renderKeeper(controller, built.ref, 0, vi.fn())
    act(() => {
      built.tallWrapper.style.display = 'none'
      built.shortWrapper.style.display = 'inline-block'
      rects.set('short', { top: -2235.3, height: 159.6 })
      keeper.rerender(1)
    })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'short',
      offset: expect.closeTo(-147.6, 4)
    })
    return { controller, keeper, container: built.container, ref: built.ref }
  }

  it('feasible replacement growth between queue and frame defers commit until truly stable (original offset preserved)', async () => {
    const { keeper, container } = queueTallToShort()
    // Layout settles taller before the queued frame runs: -147.6 stays
    // feasible for h=300, so the old self-check would commit intermediate
    // geometry. The basis check must defer instead.
    rects.set('short', { top: -2235.3, height: 300 })
    await act(async () => {
      await flushSingleFoldFrame()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Truly stable on the next quiet frame: commits the ORIGINAL corrected
    // offset (never re-normalized away).
    await act(async () => {
      await flushSingleFoldFrame()
    })
    const stored = store.get('scroll:topic-t1::main') as
      | {
          messageId: string
          intraRowOffset: number
          isAtBottom: boolean
        }
      | undefined
    expect(stored?.messageId).toBe('short')
    expect(stored?.intraRowOffset).toBeCloseTo(-147.6, 4)
    expect(stored?.isAtBottom).toBe(false)
    expect(container.scrollTop).not.toBe(0)
    keeper.unmount()
  })

  it('ordinary hold with a layout shift while pending resets the quiet check (no stale commit)', async () => {
    const { keeper } = queueTallToShort()
    // Ordinary layout change notified through a hold before the frame resets
    // the quiet basis; a further shift before the frame must still defer, so
    // the stale queue basis never commits.
    act(() => {
      rects.set('short', { top: -2230.3, height: 159.6 })
      keeper.rerender(2)
    })
    rects.set('short', { top: -2225.3, height: 159.6 })
    await act(async () => {
      await flushSingleFoldFrame()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Settles quiet on the following frame: the legitimate same-route stable
    // correction is not lost forever.
    await act(async () => {
      await flushSingleFoldFrame()
    })
    const stored = store.get('scroll:topic-t1::main') as { messageId: string } | undefined
    expect(stored?.messageId).toBe('short')
    keeper.unmount()
  })

  it('viewport-height change while pending defers commit until quiet', async () => {
    const { keeper, container } = queueTallToShort()
    Object.defineProperty(container, 'clientHeight', { value: 800, writable: true, configurable: true })
    containerRect.height = 800
    await act(async () => {
      await flushSingleFoldFrame()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    await act(async () => {
      await flushSingleFoldFrame()
    })
    const stored = store.get('scroll:topic-t1::main') as { messageId: string } | undefined
    expect(stored?.messageId).toBe('short')
    keeper.unmount()
  })

  it('window-generation bump while pending re-arms (no stale commit on the first frame)', async () => {
    const { controller, keeper } = queueTallToShort()
    expect(controller.noteSameRouteWindowUpdate({ topicId: 't1', route: null }, 'oldest::newest::28')).toBe(true)
    await act(async () => {
      await flushSingleFoldFrame()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    await act(async () => {
      await flushSingleFoldFrame()
    })
    const stored = store.get('scroll:topic-t1::main') as { messageId: string } | undefined
    expect(stored?.messageId).toBe('short')
    keeper.unmount()
  })

  it('more than five successive valid basis shifts coalesce until quiet, then commit the same-group snapshot', async () => {
    const { keeper, container } = queueTallToShort()
    for (let i = 0; i < 6; i++) {
      rects.set('short', { top: -2235.3 + (i + 1) * 5, height: 159.6 })
      await act(async () => {
        await flushSingleFoldFrame()
      })
      expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    }
    await act(async () => {
      await flushSingleFoldFrame()
    })
    const stored = store.get('scroll:topic-t1::main') as
      | {
          messageId: string
          intraRowOffset: number
          isAtBottom: boolean
        }
      | undefined
    expect(stored?.messageId).toBe('short')
    expect(stored?.intraRowOffset).toBeCloseTo(-147.6, 4)
    expect(stored?.isAtBottom).toBe(false)
    expect(container.scrollTop).not.toBe(0)
    keeper.unmount()
  })

  it('zero/non-finite dimensions while pending drop (never write)', async () => {
    const { keeper } = queueTallToShort()
    rects.set('short', { top: -2235.3, height: 0 })
    await act(async () => {
      await flushFoldCommit()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('non-finite row geometry while pending drops (never write)', async () => {
    const { keeper } = queueTallToShort()
    rects.set('short', { top: NaN, height: Number.NaN })
    await act(async () => {
      await flushFoldCommit()
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })
})

describe('fold reconciliation scheduler lifecycle (single bounded frame, no permanent polling)', () => {
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
  const runQueuedFrame = async (): Promise<void> => {
    const cb = rafQueue.shift()
    expect(cb).toBeDefined()
    await act(async () => {
      ;(cb as FrameRequestCallback)(0)
      await Promise.resolve()
    })
  }
  const queueTallToShortManual = (): {
    controller: RouteViewportController
    keeper: { rerender: (v: number) => void; unmount: () => void }
    container: HTMLDivElement
  } => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    rects.set('tall', { top: -2235.2, height: 2549.5 })
    rects.set('short', { top: -2235.2, height: 159.6 })
    rects.set('outside', { top: 500, height: 120 })
    rects.set('tab-short', { top: 550, height: 22 })
    const built = buildFoldGroup()
    built.shortWrapper.style.display = 'none'
    built.tallWrapper.style.display = 'inline-block'
    const keeper = renderKeeper(controller, built.ref, 0, vi.fn())
    expect(rafSpy).not.toHaveBeenCalled()
    act(() => {
      built.tallWrapper.style.display = 'none'
      built.shortWrapper.style.display = 'inline-block'
      rects.set('short', { top: -2235.3, height: 159.6 })
      keeper.rerender(1)
    })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'short',
      offset: expect.closeTo(-147.6, 4)
    })
    return { controller, keeper, container: built.container }
  }

  it('fold success after quiet leaves zero queued frames over extra frames', async () => {
    installManualRaf()
    const { keeper, container } = queueTallToShortManual()
    // Exactly one bounded frame queued for the reconciliation (no polling).
    expect(rafSpy).toHaveBeenCalledTimes(1)
    expect(rafQueue.length).toBe(1)
    await runQueuedFrame()
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string; intraRowOffset: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('short')
    expect(stored?.intraRowOffset).toBeCloseTo(-147.6, 4)
    // Quiet consumed: no re-arm, no queued frame remains.
    expect(rafQueue.length).toBe(0)
    expect(rafSpy).toHaveBeenCalledTimes(1)
    // Extra ordinary holds over further frames schedule nothing new.
    act(() => {
      rects.set('short', { top: -147.6, height: 159.6 })
      keeper.rerender(2)
    })
    act(() => {
      container.dispatchEvent(new Event('scroll'))
    })
    expect(rafSpy).toHaveBeenCalledTimes(1)
    expect(rafQueue.length).toBe(0)
    expect(container.scrollTop).not.toBe(0)
    keeper.unmount()
  })

  it('epoch supersession before the frame drops without re-arm', async () => {
    installManualRaf()
    const { controller, keeper } = queueTallToShortManual()
    expect(rafQueue.length).toBe(1)
    // Newer transition supersedes the queued reconciliation before validation.
    act(() => {
      controller.request({ kind: 'top', topicId: 't1', targetRoute: null, saved: null })
    })
    await runQueuedFrame()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    expect(rafQueue.length).toBe(0)
    expect(rafSpy).toHaveBeenCalledTimes(1)
    keeper.unmount()
  })

  it('detach before the frame drops without re-arm', async () => {
    installManualRaf()
    const { controller, keeper } = queueTallToShortManual()
    expect(rafQueue.length).toBe(1)
    act(() => {
      controller.detach()
    })
    await runQueuedFrame()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    expect(rafQueue.length).toBe(0)
    expect(rafSpy).toHaveBeenCalledTimes(1)
    keeper.unmount()
  })

  it('unmount cancels the queued frame (zero pending scheduler)', async () => {
    installManualRaf()
    const { keeper } = queueTallToShortManual()
    expect(rafQueue.length).toBe(1)
    keeper.unmount()
    expect(cafSpy).toHaveBeenCalled()
    expect(rafQueue.length).toBe(0)
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
  })

  it('layout shifts re-arm for more than six frames only while pending, then cancellation stops all frames', async () => {
    installManualRaf()
    const { controller, keeper } = queueTallToShortManual()
    expect(rafSpy).toHaveBeenCalledTimes(1)
    // Six successive legitimate basis shifts: each frame re-arms exactly one
    // more quiet check, never commits intermediate geometry.
    for (let i = 0; i < 6; i++) {
      rects.set('short', { top: -2235.3 + (i + 1) * 5, height: 159.6 })
      await runQueuedFrame()
      expect(store.get('scroll:topic-t1::main')).toBeUndefined()
      expect(rafQueue.length).toBe(1)
    }
    expect(rafSpy).toHaveBeenCalledTimes(7)
    // True cancellation stops the chain: detach drops on the next frame with
    // no re-arm, and later layout shifts schedule nothing.
    act(() => {
      controller.detach()
    })
    await runQueuedFrame()
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    expect(rafQueue.length).toBe(0)
    const callsAfterCancel = rafSpy.mock.calls.length
    act(() => {
      rects.set('short', { top: -2200.3, height: 159.6 })
      keeper.rerender(9)
    })
    expect(rafSpy.mock.calls.length).toBe(callsAfterCancel)
    expect(rafQueue.length).toBe(0)
    keeper.unmount()
  })
})

describe('send-bottom generation + displayed guards', () => {
  const buildDeps = (
    controller: RouteViewportController,
    opts?: {
      navigate?: () => Promise<'success' | 'cancelled' | 'not-found'>
    }
  ): { deps: SendBottomIntentDeps; commits: { routeKey: string }[]; navigateSpy: ReturnType<typeof vi.fn> } => {
    const commits: { routeKey: string }[] = []
    const navigateSpy = vi.fn(async () => {
      if (opts?.navigate) return opts.navigate()
      return 'success' as const
    })
    const deps: SendBottomIntentDeps = {
      controller,
      navigateToBottom: navigateSpy,
      captureSnapshot: () => ({ scrollTop: 0, messageId: 'm3', intraRowOffset: -8, isAtBottom: true }),
      commitSnapshot: (routeKey) => {
        commits.push({ routeKey })
      },
      notifyViewport: () => {},
      setSuppressUserWrite: () => {},
      getSelectedTopicId: () => 't1',
      getSelectedRoute: () => null,
      getWindowId: () => 'oldest::newest::10',
      getActiveInteractionId: () => {
        try {
          return controller.activeInteractionToken?.interactionId ?? null
        } catch {
          return null
        }
      },
      getActiveInteractionGeneration: () => {
        try {
          return controller.activeInteractionDeclareGeneration
        } catch {
          return null
        }
      },
      isUnmounted: () => false
    }
    return { deps, commits, navigateSpy }
  }

  it('same-id new wheel bumps generation (id-only would miss it)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const first = controller.declareUserIntent()
    const gen1 = controller.activeInteractionDeclareGeneration
    const second = controller.declareUserIntent()
    expect(second.interactionId).toBe(first.interactionId)
    expect(controller.activeInteractionDeclareGeneration).not.toBe(gen1)
  })

  it('entry-live same-id new wheel aborts the send (generation check)', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    controller.declareUserIntent()
    let resolveNav!: (v: 'success' | 'cancelled' | 'not-found') => void
    const gate = new Promise<'success' | 'cancelled' | 'not-found'>((r) => {
      resolveNav = r
    })
    const { deps, commits } = buildDeps(controller, { navigate: () => gate })
    const pending = runSendBottomIntent({ topicId: 't1' }, 't1', deps)
    await new Promise<void>((r) => setTimeout(r, 20))
    // New real wheel while the entry session is still live: same id, new generation.
    controller.declareUserIntent()
    resolveNav('success')
    const res = await pending
    expect(res).toEqual({ outcome: 'aborted', reason: 'user-intent' })
    expect(commits).toEqual([])
  })

  it('last-moment displayed mismatch aborts (no adopt on the wrong route)', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    let resolveNav!: (v: 'success' | 'cancelled' | 'not-found') => void
    const gate = new Promise<'success' | 'cancelled' | 'not-found'>((r) => {
      resolveNav = r
    })
    const { deps, commits } = buildDeps(controller, { navigate: () => gate })
    const pending = runSendBottomIntent({ topicId: 't1' }, 't1', deps)
    await new Promise<void>((r) => setTimeout(r, 20))
    // Displayed route moves under the in-flight send (rebase, no epoch bump).
    expect(controller.rebaseClean({ topicId: 't1', route: 'other' }, 'oldest::newest::10')).toBe(true)
    resolveNav('success')
    const res = await pending
    expect(res).toEqual({ outcome: 'aborted', reason: 'displayed-changed' })
    expect(commits).toEqual([])
  })
})
