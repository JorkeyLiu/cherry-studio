/**
 * Topic-switch departure freeze ordering (production-linked).
 *
 * Guards the unified-entry order: the switch entry calls the provider's
 * `freezeDisplayed` synchronously BEFORE selected changes (mirroring the TOP
 * entry freeze → request → dispatch), and the provider syncs displayed only
 * when the new selected topic renders. Uses the REAL RouteViewportProvider +
 * controller + storage path with the established probe pattern (registered
 * capturer, mocked store/keyv) — no timing assumption, no UI fixture.
 *
 * - freeze-before-change stores the outgoing snapshot under the OLD key;
 * - the post-change provider sync dirties provenance, so a late freeze
 *   refuses and never writes under the incoming key;
 * - owned (transition in flight) and rapid A→B→A freezes refuse, preserving
 *   the stored snapshot instead of capturing foreign DOM.
 */
import { render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readRouteSnapshot, RouteViewportProvider, useRouteViewport } from '../routeViewportContext'
import type { RouteViewportController } from '../routeViewportController'

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

let keyvStore: Map<string, unknown>
const installKeyv = (): void => {
  ;(window as unknown as { keyv: unknown }).keyv = {
    get: (k: string) => keyvStore.get(k),
    set: (k: string, v: unknown) => {
      keyvStore.set(k, v)
    },
    remove: (k: string) => {
      keyvStore.delete(k)
    }
  }
}

const wid = (n: string): string => `oldest::newest::${n}`

beforeEach(() => {
  keyvStore = new Map()
  installKeyv()
  dispatchMock.mockClear()
})

type LiveBox = {
  current: { scrollTop: number; messageId: string | null; intraRowOffset: number | null; isAtBottom: boolean }
}

const Probe = ({
  live,
  onSeen
}: {
  live: LiveBox
  onSeen: (c: RouteViewportController, freeze: () => boolean) => void
}) => {
  const vp = useRouteViewport()
  useEffect(() => {
    vp.registerCapturer(() => ({ ...live.current }))
    return () => vp.registerCapturer(null)
  }, [vp, live])
  useEffect(() => {
    onSeen(vp.controller, vp.freezeDisplayed)
  }, [vp, onSeen])
  return <div data-testid="viewport-probe">probe</div>
}

/** Drive the controller to a clean-stable session (production TOP pipeline). */
const driveStable = (c: RouteViewportController, topicId: string): void => {
  const session = c.request({
    kind: 'top',
    topicId,
    targetRoute: null,
    saved: { scrollTop: -200, messageId: 'm-live', intraRowOffset: -20, isAtBottom: false }
  })
  expect(c.applyTransitionWindow(session.epoch, { topicId, route: null }, wid('stable'))).toBe(true)
  expect(c.firstPositioned(session.epoch, 'placed')).toBe(true)
  expect(c.revealed(session.epoch)).toBe(true)
  const committed = c.commitStable(session.epoch, {
    messageId: 'm-live',
    intraRowOffset: -20,
    scrollTop: -200,
    isAtBottom: false
  })
  expect(committed.committed).toBe(true)
  expect(c.shouldCaptureOutgoing()).toBe(true)
}

const renderProvider = (
  topicId: string,
  live: LiveBox,
  onSeen: (c: RouteViewportController, freeze: () => boolean) => void
) => {
  return render(
    <RouteViewportProvider topicId={topicId} initialRoute={null}>
      <Probe live={live} onSeen={onSeen} />
    </RouteViewportProvider>
  )
}

describe('topic-switch departure freeze ordering (production provider path)', () => {
  it('freeze BEFORE selected change stores the outgoing snapshot; post-change freeze refuses with no wrong-key write', async () => {
    const live: LiveBox = {
      current: { scrollTop: -200, messageId: 'm-live', intraRowOffset: -20, isAtBottom: false }
    }
    let controller: RouteViewportController | null = null
    let freeze: (() => boolean) | null = null
    const { rerender } = renderProvider('tA', live, (c, f) => {
      controller = c
      freeze = f
    })
    expect(await screen.findByTestId('viewport-probe')).toBeInTheDocument()
    const c = controller as unknown as RouteViewportController
    const freezeDisplayed = freeze as unknown as () => boolean
    driveStable(c, 'tA')

    // Unified-entry order: freeze synchronously BEFORE selected changes.
    expect(freezeDisplayed()).toBe(true)
    expect(readRouteSnapshot('topic-tA::main')).toMatchObject({ messageId: 'm-live', intraRowOffset: -20 })

    // Selected change renders the new topic: provider syncs displayed,
    // provenance dirties (rendered unknown), the gate closes.
    rerender(
      <RouteViewportProvider topicId="tB" initialRoute={null}>
        <Probe live={live} onSeen={() => {}} />
      </RouteViewportProvider>
    )
    expect(c.shouldCaptureOutgoing()).toBe(false)

    // A late freeze must refuse and never write under the incoming key.
    expect(freezeDisplayed()).toBe(false)
    expect(readRouteSnapshot('topic-tB::main')).toBeNull()
    // The outgoing snapshot stands unchanged.
    expect(readRouteSnapshot('topic-tA::main')).toMatchObject({ messageId: 'm-live', intraRowOffset: -20 })
  })

  it('owned transition refuses freeze and preserves the stored snapshot', async () => {
    const live: LiveBox = {
      current: { scrollTop: -200, messageId: 'm-live', intraRowOffset: -20, isAtBottom: false }
    }
    let controller: RouteViewportController | null = null
    let freeze: (() => boolean) | null = null
    renderProvider('tA', live, (c, f) => {
      controller = c
      freeze = f
    })
    expect(await screen.findByTestId('viewport-probe')).toBeInTheDocument()
    const c = controller as unknown as RouteViewportController
    const freezeDisplayed = freeze as unknown as () => boolean
    driveStable(c, 'tA')
    expect(freezeDisplayed()).toBe(true)

    // Live DOM moves on while a transition owns the viewport.
    live.current = { scrollTop: -999, messageId: 'm-intruder', intraRowOffset: -99, isAtBottom: false }
    c.request({
      kind: 'top',
      topicId: 'tA',
      targetRoute: null,
      saved: { scrollTop: -200, messageId: 'm-live', intraRowOffset: -20, isAtBottom: false }
    })

    expect(freezeDisplayed()).toBe(false)
    expect(readRouteSnapshot('topic-tA::main')).toMatchObject({ messageId: 'm-live', intraRowOffset: -20 })
  })

  it('rapid A→B→A keeps the single pre-change freeze; intermediate B is never captured as A', async () => {
    const live: LiveBox = {
      current: { scrollTop: -200, messageId: 'm-live', intraRowOffset: -20, isAtBottom: false }
    }
    let controller: RouteViewportController | null = null
    let freeze: (() => boolean) | null = null
    const ui = (topicId: string) => (
      <RouteViewportProvider topicId={topicId} initialRoute={null}>
        <Probe live={live} onSeen={() => {}} />
      </RouteViewportProvider>
    )
    const { rerender } = renderProvider('tA', live, (c, f) => {
      controller = c
      freeze = f
    })
    expect(await screen.findByTestId('viewport-probe')).toBeInTheDocument()
    const c = controller as unknown as RouteViewportController
    const freezeDisplayed = freeze as unknown as () => boolean
    driveStable(c, 'tA')

    // The one legal freeze happens before any selected change.
    expect(freezeDisplayed()).toBe(true)

    // Rapid supersede: B renders (dirty), then A renders again (still dirty —
    // the new DOM is never proven). Neither freeze may capture.
    rerender(ui('tB'))
    expect(freezeDisplayed()).toBe(false)
    rerender(ui('tA'))
    expect(c.shouldCaptureOutgoing()).toBe(false)
    expect(freezeDisplayed()).toBe(false)

    expect(readRouteSnapshot('topic-tA::main')).toMatchObject({ messageId: 'm-live', intraRowOffset: -20 })
    expect(readRouteSnapshot('topic-tB::main')).toBeNull()
  })
})
