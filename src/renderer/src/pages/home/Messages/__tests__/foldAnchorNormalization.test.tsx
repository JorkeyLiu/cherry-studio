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
import { RouteViewportContext, type RouteViewportContextValue, useStableVisualAnchor } from '../routeViewportContext'
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

const flushTabFrame = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    try {
      requestAnimationFrame(() => resolve())
    } catch {
      resolve()
    }
  })
  await Promise.resolve()
}

describe('answer-tab switch intent (SWITCHING, not reading restoration)', () => {
  it('begins only when stable/clean/unowned without live user gesture', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    expect(controller.activeAnswerTabIntent).toEqual({
      topicId: 't1',
      route: null,
      epoch: controller.currentEpoch,
      tabMessageId: 'short',
      tabOffset: 200,
      gestureId: 1
    })
  })

  it('stale failure must not clear a newer gesture (gesture identity guard)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    const first = controller.activeAnswerTabIntent
    expect(first?.gestureId).toBe(1)
    // Newer click overwrites with a fresh gesture on the same epoch.
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'tall', 210)).toBe(true)
    const second = controller.activeAnswerTabIntent
    expect(second?.gestureId).toBe(2)
    expect(second?.tabMessageId).toBe('tall')
    // Stale completion for the first gesture refuses.
    expect(controller.clearAnswerTabSwitch(first!.epoch, first!.tabMessageId, first!.gestureId)).toBe(false)
    expect(controller.activeAnswerTabIntent?.tabMessageId).toBe('tall')
    expect(controller.activeAnswerTabIntent?.gestureId).toBe(2)
    // Current gesture clears.
    expect(controller.clearAnswerTabSwitch(second!.epoch, second!.tabMessageId, second!.gestureId)).toBe(true)
    expect(controller.activeAnswerTabIntent).toBeNull()
  })

  it('refuses while owned, dirty, user-live, wrong route, or non-adoptable phase', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    // Owned: an open transition refuses.
    const { epoch } = controller.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: null,
      snapshotInvalid: false
    })
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(false)
    expect(controller.activeAnswerTabIntent).toBeNull()
    controller.appliedWindow(epoch)
    controller.firstPositioned(epoch, 'placed')
    controller.revealed(epoch)
    const out = controller.commitStable(epoch, {
      messageId: 'm1',
      intraRowOffset: -100,
      scrollTop: -400,
      isAtBottom: false
    })
    expect(out.committed).toBe(true)
    // Wrong route refuses.
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: 'branch-a' }, 'short', 200)).toBe(false)
    // Live user gesture refuses.
    controller.declareUserIntent()
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(false)
    controller.clearUserIntent()
    // Non-finite geometry refuses.
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', Number.NaN)).toBe(false)
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, '', 200)).toBe(false)
  })

  it('clears on route transition, detach, user intent, takeover, and send-bottom', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm1', -100)
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    controller.declareUserIntent()
    expect(controller.activeAnswerTabIntent).toBeNull()
    controller.clearUserIntent()

    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    controller.request({ kind: 'top', topicId: 't1', targetRoute: null, saved: null, snapshotInvalid: false })
    expect(controller.activeAnswerTabIntent).toBeNull()

    const c2 = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c2, 'm1', -100)
    expect(c2.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    c2.detach()
    expect(c2.activeAnswerTabIntent).toBeNull()

    const c3 = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c3, 'm1', -100)
    expect(c3.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    expect(c3.beginSendBottom({ topicId: 't1', route: null })).toBe(true)
    expect(c3.activeAnswerTabIntent).toBeNull()

    const c4 = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(c4, 'm1', -100)
    expect(c4.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    c4.declareUserIntent()
    const token = c4.activeInteractionToken
    const taken = c4.userTakeover(
      { messageId: 'm1', intraRowOffset: -100, scrollTop: -400, isAtBottom: false },
      undefined,
      token ?? undefined
    )
    expect(taken.taken).toBe(true)
    expect(c4.activeAnswerTabIntent).toBeNull()
  })

  it('capture helper measures the clicked tab offset and arms the intent', async () => {
    const mod = await import('../routeViewportContext')
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -60)
    rects.set('tab-short', { top: 200, height: 22 })
    containerRect.top = 0
    containerRect.height = 600
    const built = buildFoldGroup()
    const ok = mod.captureAnswerTabSwitchIntent(controller, 'short', built.container)
    expect(ok).toBe(true)
    expect(controller.activeAnswerTabIntent?.tabMessageId).toBe('short')
    expect(controller.activeAnswerTabIntent?.tabOffset).toBeCloseTo(200, 5)
    expect(mod.captureAnswerTabSwitchIntent(controller, 'missing-id', built.container)).toBe(false)
    built.container.remove()
  })

  it('keeper holds the clicked tab stationary and never transfers the body anchor', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -60)
    rects.set('tall', { top: -60, height: 900 })
    rects.set('short', { top: -60, height: 159.6 })
    rects.set('outside', { top: 500, height: 120 })
    rects.set('tab-short', { top: 200, height: 22 })
    containerRect.top = 0
    const { container, ref } = buildFoldGroup()
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    expect(container.scrollTop).toBe(0)
    // Height swap moves the tab +60 below its captured offset.
    act(() => {
      rects.set('tab-short', { top: 260, height: 22 })
      keeper.rerender(1)
    })
    // Tab hold compensates exactly; body anchor identity is untouched and no
    // snapshot is written by the hold.
    expect(container.scrollTop).toBe(60)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'tall',
      offset: -60
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('pending survives an unrelated layout while the target is still hidden (async IPC gap)', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -60)
    rects.set('tab-short', { top: 200, height: 22 })
    rects.set('short', { top: 0, height: 159.6 })
    containerRect.top = 0
    const { ref, shortWrapper } = buildFoldGroup()
    // Target not yet selected: short answer still hidden (DB-first IPC pending).
    shortWrapper.style.display = 'none'
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    // Unrelated layout/observer fires before the IPC response while the tab
    // itself sits quiet at its captured offset: the early-settle candidate
    // must NOT clear the pending interaction.
    act(() => {
      containerRect.height = 620
      keeper.rerender(1)
    })
    await act(async () => {
      await flushTabFrame()
    })
    expect(controller.activeAnswerTabIntent?.tabMessageId).toBe('short')
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('settles only after the target is visible and hands off to the post-switch geometry', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -60)
    rects.set('tab-short', { top: 200, height: 22 })
    rects.set('short', { top: 40, height: 159.6 })
    containerRect.top = 0
    const { container, ref, shortWrapper, tallWrapper } = buildFoldGroup()
    shortWrapper.style.display = 'none'
    tallWrapper.style.display = 'inline-block'
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      rects.set('tab-short', { top: 260, height: 22 })
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(60)
    expect(controller.activeAnswerTabIntent).not.toBeNull()
    // Selection commits: short becomes visible, tall collapses. Model the
    // converged frame: tab back at its captured offset, short real box at 40.
    act(() => {
      tallWrapper.style.display = 'none'
      shortWrapper.style.display = 'inline-block'
      rects.set('short', { top: 40, height: 159.6 })
      rects.set('tab-short', { top: 200, height: 22 })
      keeper.rerender(2)
    })
    await act(async () => {
      await flushTabFrame()
      await flushTabFrame()
    })
    expect(controller.activeAnswerTabIntent).toBeNull()
    // Handoff rebases to the CURRENT post-switch visible geometry (short at
    // its measured 40, never the old tall -60 and never intermediate).
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'short',
      offset: 40
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('short')
    expect(stored?.intraRowOffset).toBe(40)
    expect(stored?.isAtBottom).toBe(false)
    expect(typeof stored?.scrollTop).toBe('number')
    keeper.unmount()
  })

  it('a hidden body anchor never compensates while the tab intent is armed', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'tall', -2235.2)
    rects.set('tab-short', { top: 200, height: 22 })
    containerRect.top = 0
    const { container, ref, tallWrapper, shortWrapper } = buildFoldGroup()
    tallWrapper.style.display = 'none'
    shortWrapper.style.display = 'inline-block'
    expect(controller.beginAnswerTabSwitch({ topicId: 't1', route: null }, 'short', 200)).toBe(true)
    const keeper = renderKeeper(controller, ref, 0, vi.fn())
    act(() => {
      rects.set('tab-short', { top: 230, height: 22 })
      keeper.rerender(1)
    })
    // Only the tab delta (+30) is compensated; no body-anchor transfer occurs.
    expect(container.scrollTop).toBe(30)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })?.kind).toBe('message')
    const anchor = controller.getAnchorFor({ topicId: 't1', route: null })
    expect(anchor && anchor.kind === 'message' ? anchor.messageId : null).toBe('tall')
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
