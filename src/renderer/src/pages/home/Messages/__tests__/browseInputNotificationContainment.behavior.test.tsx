/**
 * Held browse input (native key auto-repeat) — behavioral contract.
 *
 * The reported symptom is per-repeat work: with a key held, every repeat
 * re-rendered the whole mounted conversation. This suite drives REAL DOM
 * `keydown` events (including `repeat: true`) through the production
 * capture-phase input adapter and asserts:
 *
 * - the interaction session is still opened/refreshed per repeat (browse
 *   handling is independent of input cadence: no gate, no queue, no debounce,
 *   no keyboard interception);
 * - exactly ONE projection notification covers the whole gesture: only the
 *   idle → live open transition is observable, repeats publish nothing;
 * - message rows do NOT re-render per repeat, and they also do not re-render
 *   when the viewport DOES notify (they subscribe to the stable command
 *   surface, never the versioned projection) — the containment that removes the
 *   per-repeat message subtree/menubar/cssinjs work;
 * - genuine transitions (navigation/window update, session close) still
 *   notify and are visible to versioned consumers — the notification is
 *   narrowed, never blanket-suppressed;
 * - genuine user input still supersedes a programmatic owner;
 * - the native default action is preserved (`defaultPrevented === false`).
 */
import { act, render } from '@testing-library/react'
import { memo, type RefObject, useCallback, useEffect, useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RouteViewportProvider,
  useOptionalRouteViewport,
  useOptionalRouteViewportCommands,
  useStableVisualAnchor
} from '../routeViewportContext'
import { declareUserIntentSession, RouteViewportController } from '../routeViewportController'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

const dispatchMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: () => null
}))

const ROW_IDS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] as const

interface Counts {
  rowRenders: number
  versionRenders: number
}

let keyvStore: Map<string, unknown>

beforeEach(() => {
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
  dispatchMock.mockClear()
})

/** Row-level consumer: stable commands only (production Message/MessageGroup). */
const Row = memo(({ id, onRender }: { id: string; onRender: () => void }) => {
  const commands = useOptionalRouteViewportCommands()
  void commands
  onRender()
  return <div data-testid={`row-${id}`} />
})

/** Versioned consumer (production Messages/#messages phase attr). */
const VersionProbe = ({ onRender }: { onRender: () => void }) => {
  const viewport = useOptionalRouteViewport()
  onRender()
  return <div data-testid="version-probe" data-version={viewport?.version ?? -1} />
}

const Surface = ({ counts }: { counts: Counts }) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  useStableVisualAnchor(containerRef as RefObject<HTMLElement | null>)
  const onRowRender = useCallback(() => {
    counts.rowRenders += 1
  }, [counts])
  const onVersionRender = useCallback(() => {
    counts.versionRenders += 1
  }, [counts])
  return (
    <div id="messages" tabIndex={0} ref={containerRef}>
      {ROW_IDS.map((id) => (
        <Row key={id} id={id} onRender={onRowRender} />
      ))}
      <VersionProbe onRender={onVersionRender} />
    </div>
  )
}

interface LiveViewport {
  controller: RouteViewportController | null
  notify: (() => void) | null
}

const renderSurface = () => {
  const counts: Counts = { rowRenders: 0, versionRenders: 0 }
  const live: LiveViewport = { controller: null, notify: null }
  const Capture = () => {
    const viewport = useOptionalRouteViewport()
    useEffect(() => {
      live.controller = viewport?.controller ?? null
      live.notify = viewport?.notifyChanged ?? null
    }, [viewport])
    return null
  }
  const rendered = render(
    <RouteViewportProvider topicId="t1" initialRoute={null}>
      <Surface counts={counts} />
      <Capture />
    </RouteViewportProvider>
  )
  const container = rendered.container.querySelector('#messages') as HTMLDivElement
  const pressKey = (repeat: boolean): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', {
      key: 'PageUp',
      bubbles: true,
      cancelable: true,
      repeat
    })
    act(() => {
      container.dispatchEvent(event)
    })
    return event
  }
  return { counts, live, rendered, container, pressKey }
}

const REPEATS = 24

describe('held browse input publishes one notification per gesture and no row re-render per repeat', () => {
  it('opens the session once, refreshes it per repeat, and publishes nothing per repeat', () => {
    const { counts, live, pressKey } = renderSurface()
    const controller = live.controller as RouteViewportController
    // Mount: each row renders once; the versioned probe renders for the
    // provider's own mount layout effect (baseline recorded, not assumed).
    expect(counts.rowRenders).toBe(ROW_IDS.length)
    const versionAtMount = counts.versionRenders
    expect(versionAtMount).toBeGreaterThanOrEqual(1)

    const first = pressKey(false)
    // Native default preserved: the adapter never swallows the paging action.
    expect(first.defaultPrevented).toBe(false)
    expect(controller.hasActiveUserInteraction()).toBe(true)
    expect(controller.activeInteractionDeclareGeneration).toBe(1)
    // The ONE observable transition of the gesture: session opened.
    expect(counts.versionRenders).toBe(versionAtMount + 1)
    const rowsAfterOpen = counts.rowRenders
    expect(rowsAfterOpen).toBe(ROW_IDS.length)

    for (let i = 0; i < REPEATS; i += 1) {
      const repeat = pressKey(true)
      expect(repeat.defaultPrevented).toBe(false)
    }
    // Browse handling is cadence-independent: every repeat still refreshed the
    // live session (no gate, no drop, no queue).
    expect(controller.hasActiveUserInteraction()).toBe(true)
    expect(controller.activeInteractionDeclareGeneration).toBe(REPEATS + 1)
    // ...and the projection published nothing more, and no row re-rendered.
    expect(counts.versionRenders).toBe(versionAtMount + 1)
    expect(counts.rowRenders).toBe(rowsAfterOpen)
  })

  it('keeps message rows out of viewport notifications while versioned consumers still update', () => {
    const { counts, live, pressKey } = renderSurface()
    const controller = live.controller as RouteViewportController
    const versionAttr = (): number =>
      Number(document.querySelector('[data-testid="version-probe"]')?.getAttribute('data-version'))
    pressKey(false)
    const rowsBefore = counts.rowRenders
    const versionBefore = counts.versionRenders
    const versionAttrBefore = versionAttr()
    for (let i = 0; i < REPEATS; i += 1) pressKey(true)
    expect(counts.rowRenders).toBe(rowsBefore)

    // A REAL window/navigation update still notifies and is visible to the
    // versioned projection (notification narrowed, never suppressed).
    act(() => {
      controller.request({ kind: 'top', topicId: 't1', targetRoute: null, saved: null })
      live.notify?.()
    })
    expect(counts.versionRenders).toBe(versionBefore + 1)
    expect(versionAttr()).toBe(versionAttrBefore + 1)
    // Rows are subscribed to the stable command surface only: a viewport
    // notification never re-renders the mounted conversation.
    expect(counts.rowRenders).toBe(rowsBefore)
  })

  it('still notifies on the session-close transition (scrollend) and closes the live session', () => {
    const { counts, live, container, pressKey } = renderSurface()
    const controller = live.controller as RouteViewportController
    pressKey(false)
    for (let i = 0; i < REPEATS; i += 1) pressKey(true)
    const versionBefore = counts.versionRenders

    act(() => {
      container.dispatchEvent(new Event('scrollend', { bubbles: true }))
    })
    expect(controller.hasActiveUserInteraction()).toBe(false)
    expect(counts.versionRenders).toBe(versionBefore + 1)
  })

  it('genuine key input supersedes the programmatic owner and stays a single-notification gesture', () => {
    const { counts, live, pressKey } = renderSurface()
    const controller = live.controller as RouteViewportController
    controller.request({ kind: 'top', topicId: 't1', targetRoute: null, saved: null })
    expect(controller.programmaticOwned).toBe(true)
    act(() => {
      live.notify?.()
    })
    const versionBefore = counts.versionRenders

    const event = pressKey(false)
    expect(event.defaultPrevented).toBe(false)
    expect(controller.hasActiveUserInteraction()).toBe(true)
    expect(counts.versionRenders).toBe(versionBefore + 1)

    const out = controller.userTakeover(
      { messageId: 'm9', intraRowOffset: -10, scrollTop: -120, isAtBottom: false },
      undefined,
      controller.activeInteractionToken ?? undefined
    )
    expect(out.taken).toBe(true)
    if (out.taken) expect(out.reason).toBe('owned-takeover')
    expect(controller.programmaticOwned).toBe(false)

    // The takeover did not close the session: continued repeats publish nothing.
    for (let i = 0; i < REPEATS; i += 1) pressKey(true)
    expect(counts.versionRenders).toBe(versionBefore + 1)
  })

  it('shared declaration helper reports the open transition once for both input boundaries', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    // Capture boundary opens the session...
    expect(declareUserIntentSession(controller)).toBe(true)
    // ...and every repeat (the bubble boundary call for the same gesture)
    // refreshes it without reporting a transition.
    for (let i = 0; i < REPEATS; i += 1) expect(declareUserIntentSession(controller)).toBe(false)
    expect(controller.activeInteractionDeclareGeneration).toBe(REPEATS + 1)
    // Close is a transition again: the next input opens a NEW session.
    expect(controller.noteInteractionScrollEnd()).toBe(true)
    expect(declareUserIntentSession(controller)).toBe(true)
  })
})
