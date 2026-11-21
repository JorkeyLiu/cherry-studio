/**
 * Same-route appended-tail follow — the VIEWPORT half of the contract.
 *
 * `reconcileMessageWindow` mounting the appended rows is not enough: geometry
 * belongs to the shared viewport keeper, and the keeper pins the normal-flow
 * bottom only while it holds no row anchor. A route that was paged through older
 * history carries a committed row anchor (the previous resident tail), so an
 * append that grows the content BELOW that row is held at the old offset and the
 * appended rows stay under the fold. These cases drive the production keeper over
 * real DOM scroll metrics (scrollTop / scrollHeight / clientHeight), not range
 * returns:
 *
 * - retained row anchor + growth below → old scroll offset kept (the reproduced
 *   defect fact, and the correct behavior for a genuine reading position);
 * - the same commit after the bottom suspension (`beginSendBottom`, resolved from
 *   the same follow rule the reconcile uses) → the new bottom is pinned in the
 *   same frame and stays pinned through later chrome/layout growth;
 * - the suspension is fail-closed: an in-flight interaction hold and an owning
 *   route transition both keep geometry where it was.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { suspendKeeperForAppendedTailBottom } from '../Messages'
import { RouteViewportContext, type RouteViewportContextValue, useStableVisualAnchor } from '../routeViewportContext'
import { RouteViewportController } from '../routeViewportController'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

const TARGET = { topicId: 't1', route: null }

/** The runtime geometry: 1724px of content, 403px visible, bottom at 1321. */
const CLIENT_HEIGHT = 403
const BOTTOM_BEFORE = 1321
const HEIGHT_BEFORE = 1724
/** One 4-row append below the anchored tail (1724 → 2276, bottom 1321 → 1873). */
const HEIGHT_AFTER_PASTE = 2276
/** A later chrome/layout commit on the same route. */
const HEIGHT_AFTER_CHROME = 2600

const ANCHOR_OFFSET = -60

const rect = (top: number, height: number): DOMRect =>
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

class FakeResizeObserver {
  observe = (): void => {}
  unobserve = (): void => {}
  disconnect = (): void => {}
}

class FakeMutationObserver {
  observe = (): void => {}
  disconnect = (): void => {}
  takeRecords = (): MutationRecord[] => []
}

interface Surface {
  container: HTMLDivElement
  ref: { current: HTMLDivElement | null }
  anchorRow: HTMLDivElement
  setScrollTop: (value: number) => void
  setScrollHeight: (value: number) => void
}

/**
 * One route surface parked at the true bottom, holding the mounted tail row the
 * keeper would anchor on — the row offset the append below must not move.
 */
const buildSurface = (): Surface => {
  const container = document.createElement('div')
  container.id = 'messages'
  container.getBoundingClientRect = () => rect(0, CLIENT_HEIGHT)
  let scrollTop = BOTTOM_BEFORE
  let scrollHeight = HEIGHT_BEFORE
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    },
    configurable: true
  })
  Object.defineProperty(container, 'scrollHeight', {
    get: () => scrollHeight,
    set: (value: number) => {
      scrollHeight = value
    },
    configurable: true
  })
  Object.defineProperty(container, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true })

  // `container.firstElementChild` is the observed content wrapper.
  const content = document.createElement('div')
  const anchorRow = document.createElement('div')
  anchorRow.id = 'message-m-tail'
  anchorRow.setAttribute('data-message-id', 'm-tail')
  anchorRow.getBoundingClientRect = () => rect(ANCHOR_OFFSET, 40)
  content.append(anchorRow)
  container.append(content)
  document.body.append(container)

  return {
    container,
    ref: { current: container },
    anchorRow,
    setScrollTop: (value) => {
      scrollTop = value
    },
    setScrollHeight: (value) => {
      scrollHeight = value
    }
  }
}

const driveStableMessage = (controller: RouteViewportController, messageId: string, offset: number): void => {
  const { epoch } = controller.request({
    kind: 'top',
    topicId: TARGET.topicId,
    targetRoute: null,
    saved: { scrollTop: BOTTOM_BEFORE, messageId, intraRowOffset: offset, isAtBottom: false },
    snapshotInvalid: false
  })
  controller.appliedWindow(epoch)
  controller.firstPositioned(epoch, 'placed')
  controller.revealed(epoch)
  const out = controller.commitStable(epoch, {
    messageId,
    intraRowOffset: offset,
    scrollTop: BOTTOM_BEFORE,
    isAtBottom: false
  })
  expect(out.committed).toBe(true)
}

const renderKeeper = (
  controller: RouteViewportController,
  ref: { current: HTMLDivElement | null }
): { rerender: (version: number) => void; unmount: () => void } => {
  const Harness = ({ containerRef }: { containerRef: { current: HTMLDivElement | null } }) => {
    useStableVisualAnchor(containerRef as React.RefObject<HTMLElement | null>)
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
    <RouteViewportContext value={value(0)}>
      <Harness containerRef={ref} />
    </RouteViewportContext>
  )
  return {
    rerender: (version: number) => {
      rendered.rerender(
        <RouteViewportContext value={value(version)}>
          <Harness containerRef={ref} />
        </RouteViewportContext>
      )
    },
    unmount: () => rendered.unmount()
  }
}

let store: Map<string, unknown>

beforeEach(() => {
  store = new Map()
  document.body.innerHTML = ''
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

describe('same-route appended tail: keeper bottom pin after the commit', () => {
  it('a retained tail anchor holds its offset through growth below (appended rows stay under the fold)', () => {
    const controller = new RouteViewportController({ topicId: TARGET.topicId, route: TARGET.route })
    driveStableMessage(controller, 'm-tail', ANCHOR_OFFSET)
    const surface = buildSurface()
    const keeper = renderKeeper(controller, surface.ref)
    expect(surface.container.scrollTop).toBe(BOTTOM_BEFORE)

    // The paste commit appends four rows BELOW the anchored tail row: the
    // content grows, the anchored row keeps its viewport offset.
    act(() => {
      surface.setScrollHeight(HEIGHT_AFTER_PASTE)
      keeper.rerender(1)
    })

    // Row-anchor hold: the old offset is kept, so the four new rows are loaded
    // and mounted but sit below the fold until a user gesture.
    expect(surface.container.scrollTop).toBe(BOTTOM_BEFORE)
    expect(controller.getAnchorFor(TARGET)).not.toBeNull()
    keeper.unmount()
  })

  it('after the same-route bottom suspension the commit pins the new bottom and keeps following', () => {
    const controller = new RouteViewportController({ topicId: TARGET.topicId, route: TARGET.route })
    driveStableMessage(controller, 'm-tail', ANCHOR_OFFSET)
    const surface = buildSurface()
    const keeper = renderKeeper(controller, surface.ref)

    // Same layout phase as the reconcile: the follow decision suspends the
    // retained row keeper to the bottom semantic (no scroll write here).
    expect(suspendKeeperForAppendedTailBottom(controller, TARGET)).toBe(true)
    expect(controller.getAnchorFor(TARGET)).toBeNull()
    expect(surface.container.scrollTop).toBe(BOTTOM_BEFORE)
    // Already at the bottom semantic: every further tail commit is a no-op.
    expect(suspendKeeperForAppendedTailBottom(controller, TARGET)).toBe(false)

    act(() => {
      surface.setScrollHeight(HEIGHT_AFTER_PASTE)
      keeper.rerender(1)
    })

    // The keeper's own layout hold pinned the new normal-flow bottom: the pasted
    // rows are visible without any gesture.
    expect(surface.container.scrollTop).toBe(HEIGHT_AFTER_PASTE - CLIENT_HEIGHT)

    // Sticky: a later chrome/layout commit on the same route stays pinned.
    act(() => {
      surface.setScrollHeight(HEIGHT_AFTER_CHROME)
      keeper.rerender(2)
    })
    expect(surface.container.scrollTop).toBe(HEIGHT_AFTER_CHROME - CLIENT_HEIGHT)
    expect(controller.getAnchorFor(TARGET)).toBeNull()
    keeper.unmount()
  })

  it('an in-flight interaction hold outranks the bottom: no suspension, no steal', () => {
    const controller = new RouteViewportController({ topicId: TARGET.topicId, route: TARGET.route })
    driveStableMessage(controller, 'm-tail', ANCHOR_OFFSET)
    expect(
      controller.beginInteractionIntent(TARGET, { kind: 'message', id: 'm-tail' }, 'message-controls', ANCHOR_OFFSET)
    ).toBe(true)

    expect(suspendKeeperForAppendedTailBottom(controller, TARGET)).toBe(false)
    expect(controller.activeInteractionIntent).not.toBeNull()
    expect(controller.getAnchorFor(TARGET)).not.toBeNull()
  })

  it('an owning route transition keeps geometry: the suspension refuses', () => {
    const controller = new RouteViewportController({ topicId: TARGET.topicId, route: TARGET.route })
    driveStableMessage(controller, 'm-tail', ANCHOR_OFFSET)
    controller.request({
      kind: 'top',
      topicId: TARGET.topicId,
      targetRoute: null,
      saved: null,
      snapshotInvalid: true
    })
    expect(controller.programmaticOwned).toBe(true)

    expect(suspendKeeperForAppendedTailBottom(controller, TARGET)).toBe(false)
    expect(controller.getAnchorFor(TARGET)).not.toBeNull()
    // Another route's append never suspends this route's keeper either.
    expect(suspendKeeperForAppendedTailBottom(controller, { topicId: 't2', route: null })).toBe(false)
  })
})
