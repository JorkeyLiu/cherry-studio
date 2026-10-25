/**
 * Early-fit streaming pause vs shared interaction handoff (VIEWPORT15).
 *
 * Proves the exact event-time order for an early non-overflow stream press
 * (pointerdown pause first, click-capture second, passive growth third,
 * adopt last) and the two root causes it fixes:
 *
 * - R1 (passive mistaken as effect): at the scroll limit (short content,
 *   scrollTop 0, no overflow) passive stream growth displacing a static
 *   footer must NOT count as a click effect. The keeper re-arms (preserving
 *   the ORIGINAL pause anchor) until sustained stillness drops it with no
 *   adopt and no snapshot — never rebasing the pause/reading anchor to
 *   another row.
 * - R2 (vicinity follow): an interaction handoff keeps the explicit row
 *   even when truthfully at the bottom vicinity. Only a true user scroll to
 *   the exact physical bottom (`userTakeover` with `bottomFollow`) or an
 *   explicit send/bottom (`adoptProgrammaticViewport`) resumes follow (live
 *   anchor null). Snapshot `isAtBottom` stays truthful in both cases.
 *
 * Generic, no per-button branch, no duration hack, no paused flag: proof is
 * scope-owner dimensions vs fingerprint, region-node replacement identity,
 * and cross-row structural proof — never a control name.
 */
import { commitSnapshotForRoute } from '@renderer/hooks/useScrollPosition'
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
  version: number
): { rerender: (version: number) => void; unmount: () => void } => {
  const Harness = ({ containerRef }: { containerRef: { current: HTMLDivElement | null } }) => {
    useStableVisualAnchor(containerRef as React.RefObject<HTMLElement | null>)
    return null
  }
  const value = (v: number): RouteViewportContextValue => ({
    controller,
    version: v,
    connectionGeneration: 0,
    notifyChanged: () => {},
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

const driveBottomFollow = (controller: RouteViewportController): void => {
  driveStableMessage(controller, 'm2', -60)
  const adopted = controller.adoptProgrammaticViewport(
    { topicId: 't1', route: null },
    { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true },
    { expectedEpoch: controller.currentEpoch }
  )
  expect(adopted.taken).toBe(true)
  expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
}

/**
 * Event-time pause (what `attemptStreamingPause` does on a successful primary
 * press during an active displayed-route stream): declare → takeover with the
 * measured reading row (kept EVEN when truthfully at the bottom) → truthful
 * snapshot commit → session close so the keeper resumes holding the row.
 * Returns the taken snapshot; the live anchor is the ORIGINAL pause anchor.
 */
const pressPauseEarlyFit = (controller: RouteViewportController, messageId: string, offset: number) => {
  const token = controller.declareUserIntent()
  const out = controller.userTakeover(
    { messageId, intraRowOffset: offset, scrollTop: 0, isAtBottom: true },
    undefined,
    token
  )
  expect(out.taken).toBe(true)
  if (!out.taken) return null
  const ok = commitSnapshotForRoute(out.routeKey, {
    scrollTop: out.snapshot.scrollTop,
    anchorId: out.snapshot.messageId,
    messageId: out.snapshot.messageId,
    intraRowOffset: out.snapshot.intraRowOffset,
    rawScrollTop: out.snapshot.scrollTop,
    isAtBottom: out.snapshot.isAtBottom
  })
  expect(ok).toBe(true)
  controller.clearUserIntent()
  return out
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
 * Early-fit DOM: short content (scrollHeight 342 < clientHeight 600, scrollTop
 * 0 clamped at the limit), reading row `m-read` at 87.4 (the inspector row
 * offset), user copy scope `m-user` with a `message-controls` footer, and a
 * streaming assistant row `m-stream` that grows passively (len 38 → 2053).
 * The copy scope dims stay static (copy swaps same-size icons, no layout);
 * passive growth displaces the static footer at the limit.
 */
const buildEarlyFit = (): {
  container: HTMLDivElement
  ref: { current: HTMLDivElement | null }
  readRow: HTMLDivElement
  userRow: HTMLDivElement
  footer: HTMLDivElement
  streamRow: HTMLDivElement
} => {
  const container = document.createElement('div')
  container.id = 'messages'
  mockRect(container, 'container')
  Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
  Object.defineProperty(container, 'scrollHeight', { value: 342, writable: true, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, writable: true, configurable: true })
  const readRow = document.createElement('div')
  readRow.id = 'message-m-read'
  readRow.setAttribute('data-message-id', 'm-read')
  mockRect(readRow, 'row-m-read')
  const userRow = document.createElement('div')
  userRow.id = 'message-m-user'
  userRow.setAttribute('data-message-id', 'm-user')
  mockRect(userRow, 'row-m-user')
  const footer = document.createElement('div')
  footer.setAttribute('data-interaction-region', 'message-controls')
  mockRect(footer, 'footer-m-user')
  userRow.append(footer)
  const streamRow = document.createElement('div')
  streamRow.id = 'message-m-stream'
  streamRow.setAttribute('data-message-id', 'm-stream')
  mockRect(streamRow, 'row-m-stream')
  container.append(readRow, userRow, streamRow)
  document.body.append(container)
  return { container, ref: { current: container }, readRow, userRow, footer, streamRow }
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

describe('VIEWPORT15 early-fit: pause + copy + passive growth preserves ORIGINAL pause', () => {
  it('adopts the reading row at the bottom short viewport, then drops the passive-displaced copy with no rebase and no follow', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveBottomFollow(controller)
    // Successful primary press on the live early stream (38 chars): the
    // measured reading row is kept EVEN at scrollTop 0 / isAtBottom true.
    const paused = pressPauseEarlyFit(controller, 'm-read', 87.4)
    expect(paused?.snapshot).toMatchObject({ messageId: 'm-read', scrollTop: 0, isAtBottom: true })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm-read',
      offset: 87.4
    })
    const pauseSnapshot = store.get('scroll:topic-t1::main') as { messageId: string } | undefined
    expect(pauseSnapshot?.messageId).toBe('m-read')

    rects.set('row-m-read', { top: 87.4, height: 60 })
    rects.set('row-m-user', { top: 160, height: 80 })
    rects.set('footer-m-user', { top: 200, height: 26 })
    rects.set('row-m-stream', { top: -40, height: 40 })
    const { container, ref } = buildEarlyFit()
    // Generic shared capture on the footer subsequent click (no button-name
    // branch): the static user scope + message-controls region arms with its
    // layout-owner fingerprint. Succeeds because the pause installed a live
    // row anchor (bottom refusal no longer applies).
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm-user' },
        'message-controls',
        200,
        { fingerprint: { scopeH: 80, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0)

    // Passive stream growth (len 38 → 2053): the streaming row grows, the
    // static copy scope keeps its dims, but the footer displaces +50 at the
    // clamped limit (scrollTop 0 cannot hold). Scope-dim growth of the
    // streaming row must NOT count as the copy's effect; displacement alone
    // must NOT rebase the pause to another row and vicinity must NOT follow.
    act(() => {
      rects.set('row-m-stream', { top: -40, height: 280 })
      rects.set('row-m-user', { top: 160, height: 80 })
      rects.set('footer-m-user', { top: 250, height: 26 })
      rects.set('row-m-read', { top: 137.4, height: 60 })
      Object.defineProperty(container, 'scrollHeight', { value: 900, writable: true, configurable: true })
      keeper.rerender(1)
    })
    await act(async () => {
      for (let i = 0; i < 14; i++) await flushFrame()
    })

    // Dropped with no adopt and no snapshot write: the ORIGINAL pause anchor
    // stands (same id, same offset), never rebased to the copy row and never
    // cleared to follow — even though truthfully at the bottom vicinity.
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm-read',
      offset: 87.4
    })
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m-read')
    expect(stored?.intraRowOffset).toBe(87.4)
    keeper.unmount()
  })

  it('genuinely no-effect copy at the bottom limit drops with no snapshot write', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveBottomFollow(controller)
    pressPauseEarlyFit(controller, 'm-read', 87.4)
    rects.set('row-m-read', { top: 87.4, height: 60 })
    rects.set('row-m-user', { top: 160, height: 80 })
    rects.set('footer-m-user', { top: 200, height: 26 })
    rects.set('row-m-stream', { top: -40, height: 40 })
    const { ref } = buildEarlyFit()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm-user' },
        'message-controls',
        200,
        { fingerprint: { scopeH: 80, scopeW: 300 } }
      )
    ).toBe(true)
    store.delete('scroll:topic-t1::main')
    const keeper = renderKeeper(controller, ref, 0)
    // No layout change at all (copy swaps same-size icons; stream idle this
    // frame): sustained stillness drops WITHOUT adopting.
    await act(async () => {
      for (let i = 0; i < 12; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm-read',
      offset: 87.4
    })
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    keeper.unmount()
  })

  it('real structural replacement at the true bottom retains the valid baseline event-driven without implicit follow', async () => {
    // Approved BOTTOM baseline (VIEWPORT-13/14): a message-controls scope
    // whose owner changed height hands off ONLY to the first visible row
    // BELOW (adjacent to the bottom baseline) — never to its own moving TOP.
    // With no visible row below (true bottom: m-read above, m-stream above,
    // nothing adjacent below m-user) there is no valid handoff target, so the
    // intent stays pending with the valid baseline retained event-driven (no
    // deadline expiry while the region stays connected/finite/visible and
    // currency holds). The ORIGINAL pause anchor stands, follow never opens,
    // and nothing is snapshotted while compensating.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveBottomFollow(controller)
    pressPauseEarlyFit(controller, 'm-read', 87.4)
    rects.set('row-m-read', { top: 87.4, height: 60 })
    rects.set('row-m-user', { top: 160, height: 80 })
    rects.set('footer-m-user', { top: 200, height: 26 })
    rects.set('row-m-stream', { top: -40, height: 40 })
    const { ref, userRow, footer } = buildEarlyFit()
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm-user' },
        'message-controls',
        200,
        { fingerprint: { scopeH: 80, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0)
    await act(async () => {
      await flushFrame()
    })
    // Editor swap lands at identical-then-growing geometry: same region key,
    // different connected node (structural replacement) plus scope growth
    // (80 → 150, a genuine layout effect — not passive displacement).
    const replacement = document.createElement('div')
    replacement.setAttribute('data-interaction-region', 'message-controls')
    mockRect(replacement, 'footer-m-user')
    act(() => {
      userRow.removeChild(footer)
      userRow.append(replacement)
      rects.set('row-m-user', { top: 160, height: 150 })
      rects.set('footer-m-user', { top: 200, height: 38 })
      keeper.rerender(1)
    })
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushFrame()
    })
    // No below row: retained pending, never the moving own TOP.
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.activeInteractionIntent).toMatchObject({
      scopeId: 'm-user',
      region: 'message-controls',
      offset: 200
    })
    // ORIGINAL pause anchor stands (never rebased to the copy row, never
    // cleared to follow — vicinity is not permission to follow).
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm-read',
      offset: 87.4
    })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).not.toBeNull()
    // Layout compensation never snapshots: the pause snapshot is untouched.
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m-read')
    expect(stored?.intraRowOffset).toBe(87.4)
    // Valid baseline never expires on wall time: past the correspondence
    // deadline (which bounds only lost/hidden/disconnected correspondence)
    // the intent is still armed with the same anchor and no snapshot.
    const capturedAt = controller.activeInteractionIntent?.capturedAt ?? 0
    expect(capturedAt).toBeGreaterThan(0)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(capturedAt + 20000 + 1)
    try {
      await act(async () => {
        for (let i = 0; i < 3; i++) await flushFrame()
      })
    } finally {
      nowSpy.mockRestore()
    }
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm-read',
      offset: 87.4
    })
    const storedLate = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(storedLate?.messageId).toBe('m-read')
    expect(storedLate?.intraRowOffset).toBe(87.4)
    keeper.unmount()
  })

  it('real structural replacement with a below row hands off to the neighbor without implicit follow', async () => {
    // Same genuine structural replacement as above, but a real visible row
    // exists below the change domain: the heightChanged handoff adopts the
    // adjacent lower neighbor (m-tail at 320, below the grown scope bottom
    // 310) — never the moving scope TOP (160) and never a row above. Still a
    // ROW handoff, never a follow clear.
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveBottomFollow(controller)
    pressPauseEarlyFit(controller, 'm-read', 87.4)
    rects.set('row-m-read', { top: 87.4, height: 60 })
    rects.set('row-m-user', { top: 160, height: 80 })
    rects.set('footer-m-user', { top: 200, height: 26 })
    rects.set('row-m-stream', { top: -40, height: 40 })
    rects.set('row-m-tail', { top: 320, height: 60 })
    const { container, ref, userRow, footer } = buildEarlyFit()
    const tail = document.createElement('div')
    tail.id = 'message-m-tail'
    tail.setAttribute('data-message-id', 'm-tail')
    mockRect(tail, 'row-m-tail')
    container.append(tail)
    expect(
      controller.beginInteractionIntent(
        { topicId: 't1', route: null },
        { kind: 'message', id: 'm-user' },
        'message-controls',
        200,
        { fingerprint: { scopeH: 80, scopeW: 300 } }
      )
    ).toBe(true)
    const keeper = renderKeeper(controller, ref, 0)
    await act(async () => {
      await flushFrame()
    })
    const replacement = document.createElement('div')
    replacement.setAttribute('data-interaction-region', 'message-controls')
    mockRect(replacement, 'footer-m-user')
    act(() => {
      userRow.removeChild(footer)
      userRow.append(replacement)
      rects.set('row-m-user', { top: 160, height: 150 })
      rects.set('footer-m-user', { top: 200, height: 38 })
      rects.set('row-m-tail', { top: 320, height: 60 })
      keeper.rerender(1)
    })
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushFrame()
    })
    expect(controller.activeInteractionIntent).toBeNull()
    // Neighbor adopt — explicitly not the moving own TOP and not above.
    const anchor = controller.getAnchorFor({ topicId: 't1', route: null })
    expect(anchor).toEqual({ kind: 'message', messageId: 'm-tail', offset: 320 })
    expect(anchor?.kind).toBe('message')
    if (anchor?.kind === 'message') {
      expect(anchor.messageId).not.toBe('m-user')
      expect(anchor.messageId).not.toBe('m-read')
    }
    const stored = store.get('scroll:topic-t1::main') as
      | { messageId: string | null; intraRowOffset: number | null; scrollTop: number; isAtBottom: boolean }
      | undefined
    expect(stored?.messageId).toBe('m-tail')
    expect(stored?.intraRowOffset).toBe(320)
    expect(typeof stored?.scrollTop).toBe('number')
    keeper.unmount()
  })
})

describe('adoptInteractionViewport keeps the row at the bottom vicinity', () => {
  it('explicit row + truthful bottom stays a row (never a follow clear); null + bottom still pins', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const epoch = controller.currentEpoch
    const out = controller.adoptInteractionViewport(
      { topicId: 't1', route: null },
      { messageId: 'm9', intraRowOffset: -12, scrollTop: 0, isAtBottom: true },
      { expectedEpoch: epoch }
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(out.snapshot).toMatchObject({ messageId: 'm9', isAtBottom: true, scrollTop: 0 })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm9',
      offset: -12
    })
    expect(controller.currentEpoch).toBe(epoch)

    const bottom = controller.adoptInteractionViewport(
      { topicId: 't1', route: null },
      { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true }
    )
    expect(bottom.taken).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
  })

  it('refuses non-bottom null, owned, dirty, route-mismatch, and stale epoch (route/epoch currency)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const ghost = controller.adoptInteractionViewport(
      { topicId: 't1', route: null },
      { messageId: null, intraRowOffset: null, scrollTop: -300, isAtBottom: false }
    )
    expect(ghost.taken).toBe(false)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })

    const owned = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(owned, 'm2', -60)
    owned.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    const refused = owned.adoptInteractionViewport(
      { topicId: 't1', route: null },
      { messageId: 'm9', intraRowOffset: -12, scrollTop: 0, isAtBottom: true }
    )
    expect(refused.taken).toBe(false)

    const stale = controller.adoptInteractionViewport(
      { topicId: 't1', route: null },
      { messageId: 'm9', intraRowOffset: -12, scrollTop: 0, isAtBottom: true },
      { expectedEpoch: controller.currentEpoch + 99 }
    )
    expect(stale.taken).toBe(false)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
  })
})
