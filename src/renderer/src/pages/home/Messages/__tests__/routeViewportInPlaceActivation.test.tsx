/**
 * Browser-tab-like page reactivation: retained-projection-first restore.
 *
 * Covers the production contract without touching docs/e2e/config:
 * - real Activity hide/show retains the controller session while the
 *   short-lived transaction is cancelled with a fresh epoch (stale inert);
 * - reactivation opens a fresh guarded epoch (never reuses the detached one);
 * - the reactivated fetch-hold stays hidden-but-measurable (`positioning`)
 *   while ordinary top fetch-holds stay visible incremental (`revealed`);
 * - the pure in-place admission validates presentation only (retained window
 *   + loaded projection + connected DOM for the requested anchor, bottom for
 *   anchorless-bottom) and falls back safely for invalid/missing/changed-route
 *   shapes; divider explicit continuation keeps priority via the narrow refusal.
 */
import { act, render, screen } from '@testing-library/react'
import { Activity, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { shouldRestoreRetainedWindowInPlace, shouldTopPipelineRefuseDividerIntent } from '../routeViewportActivation'
import {
  buildContainerCapturer,
  isCaptureContainerHidden,
  RouteViewportProvider,
  useRouteViewport,
  viewportPhaseAttrFor
} from '../routeViewportContext'
import { RouteViewportController } from '../routeViewportController'

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

beforeEach(() => {
  keyvStore = new Map()
  installKeyv()
  dispatchMock.mockClear()
})

describe('activation session + page-resume gate', () => {
  it('ordinary top fetch-hold stays revealed; reactivated fetch-hold hides until positioned', () => {
    expect(viewportPhaseAttrFor('fetch-hold', 'top')).toBe('revealed')
    expect(viewportPhaseAttrFor('fetch-hold', 'divider')).toBe('revealed')
    expect(viewportPhaseAttrFor('fetch-hold', 'top', false)).toBe('revealed')
    expect(viewportPhaseAttrFor('fetch-hold', 'top', true)).toBe('positioning')
    expect(viewportPhaseAttrFor('fetch-hold', 'divider', true)).toBe('positioning')
    expect(viewportPhaseAttrFor('fetch-hold', 'generic', true)).toBe('positioning')
    expect(viewportPhaseAttrFor('positioning', 'top', true)).toBe('positioning')
    expect(viewportPhaseAttrFor('idle', null)).toBe('idle')
    // Armed idle (detached, reactivation pending) never paints visible before
    // the single TOP request: hidden-but-measurable instead of idle/visible.
    expect(viewportPhaseAttrFor('idle', null, false, true)).toBe('positioning')
    expect(viewportPhaseAttrFor('idle', 'top', false, true)).toBe('positioning')
    expect(viewportPhaseAttrFor('idle', null, false, false)).toBe('idle')
    // Activation settle stays hidden through aligned/searching until the
    // deferred reveal/stable commit; ordinary aligned stays visible.
    expect(viewportPhaseAttrFor('aligned', 'top', true)).toBe('positioning')
    expect(viewportPhaseAttrFor('searching', 'top', true)).toBe('positioning')
    expect(viewportPhaseAttrFor('aligned', 'top', false)).toBe('revealed')
    expect(viewportPhaseAttrFor('searching', 'divider', false)).toBe('revealed')
    expect(viewportPhaseAttrFor('stable', 'top', true)).toBe('revealed')
    expect(viewportPhaseAttrFor('terminal', 'top', true)).toBe('revealed')
  })

  it('request consumes the armed activation: fresh epoch, activation session set; ordinary requests reset it', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    expect(c.isActivationSession).toBe(false)
    c.detach()
    expect(c.isActivationRequired).toBe(true)
    const epochBefore = c.currentEpoch
    const reactivated = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    expect(reactivated.epoch).toBeGreaterThan(epochBefore)
    expect(c.isActivationRequired).toBe(false)
    expect(c.isActivationSession).toBe(true)
    expect(c.currentPhase).toBe('fetch-hold')

    // The reactivated session positions hidden: stale detached completions stay inert.
    expect(c.applyTransitionWindow(epochBefore, { topicId: 't1', route: null }, 'old::new::1')).toBe(false)
    expect(c.applyTransitionWindow(reactivated.epoch, { topicId: 't1', route: null }, 'old::new::1')).toBe(true)
    c.firstPositioned(reactivated.epoch, 'placed')
    c.revealed(reactivated.epoch)
    expect(
      c.commitStable(reactivated.epoch, {
        messageId: 'm-stable',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(true)

    // The next ordinary transition is not an activation session.
    const next = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -100, messageId: 'm2', intraRowOffset: -5, isAtBottom: false }
    })
    expect(c.isActivationSession).toBe(false)
    expect(next.epoch).toBeGreaterThan(reactivated.epoch)
  })

  it('invalidateAll clears the activation session marker', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    c.detach()
    c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -100, messageId: 'm1', intraRowOffset: -5, isAtBottom: false }
    })
    expect(c.isActivationSession).toBe(true)
    c.invalidateAll()
    expect(c.isActivationSession).toBe(false)
  })
})

describe('shouldRestoreRetainedWindowInPlace (pure presentation validation)', () => {
  const base = {
    wasActivation: true,
    selectedTopicId: 't1',
    selectedRoute: null as string | null,
    displayedTopicId: 't1',
    displayedRoute: null as string | null,
    deletionPending: false,
    hasRetainedWindow: true,
    canonicalAnchor: 'm14',
    isAtBottom: false,
    retainedContainsAnchor: true,
    loadedContainsAnchor: true,
    domAnchorResident: true
  }

  it('admits valid middle/top/bottom retained windows', () => {
    // Middle: anchored, covered everywhere.
    expect(shouldRestoreRetainedWindowInPlace(base)).toBe(true)
    // Bottom: anchorless bottom re-asserts in place with a retained window.
    expect(
      shouldRestoreRetainedWindowInPlace({
        ...base,
        canonicalAnchor: null,
        isAtBottom: true,
        retainedContainsAnchor: false,
        loadedContainsAnchor: false,
        domAnchorResident: false
      })
    ).toBe(true)
  })

  it('falls back safely for invalid/missing/changed shapes', () => {
    // Not an activation (ordinary switch uses its own snapshot/default path).
    expect(shouldRestoreRetainedWindowInPlace({ ...base, wasActivation: false })).toBe(false)
    // Changed route: never reuse another route's retained window.
    expect(shouldRestoreRetainedWindowInPlace({ ...base, selectedRoute: 'b1' })).toBe(false)
    // Changed topic.
    expect(shouldRestoreRetainedWindowInPlace({ ...base, selectedTopicId: 't2' })).toBe(false)
    // Deletion fallback owns the route (explicit latest).
    expect(shouldRestoreRetainedWindowInPlace({ ...base, deletionPending: true })).toBe(false)
    // No retained window.
    expect(shouldRestoreRetainedWindowInPlace({ ...base, hasRetainedWindow: false })).toBe(false)
    // Anchor missing from the retained window (interrupted restore target).
    expect(shouldRestoreRetainedWindowInPlace({ ...base, retainedContainsAnchor: false })).toBe(false)
    // Anchor missing from the loaded projection (never infer completeness).
    expect(shouldRestoreRetainedWindowInPlace({ ...base, loadedContainsAnchor: false })).toBe(false)
    // Anchor row not in the connected DOM (unmeasurable geometry).
    expect(shouldRestoreRetainedWindowInPlace({ ...base, domAnchorResident: false })).toBe(false)
    // Anchorless non-bottom (raw/default shapes use the existing default path).
    expect(
      shouldRestoreRetainedWindowInPlace({
        ...base,
        canonicalAnchor: null,
        isAtBottom: false,
        retainedContainsAnchor: false,
        loadedContainsAnchor: false,
        domAnchorResident: false
      })
    ).toBe(false)
  })

  it('divider explicit continuation keeps priority (narrow refusal holds even across activation)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b9',
      dividerKey: 'mFork::main',
      clickOffset: 55
    })
    // A TOP rerun for the same target while the divider owns fetch-hold refuses —
    // the TOP pipeline (including the retained-window path) never consumes it.
    expect(shouldTopPipelineRefuseDividerIntent(c, 't1', 'b9')).toBe(true)
    expect(shouldTopPipelineRefuseDividerIntent(c, 't1', null)).toBe(false)
  })
})

describe('real Activity reattach ordering with the resume gate', () => {
  const Probe = ({ onSeen }: { onSeen: (c: RouteViewportController, phaseAttr: string) => void }) => {
    const vp = useRouteViewport()
    useEffect(() => {
      onSeen(vp.controller, vp.viewportPhaseAttr)
    }, [vp, vp.controller, vp.viewportPhaseAttr, onSeen])
    return <div data-testid="inplace-probe">probe</div>
  }

  it('hide preserves the session and disconnects; show reopens a fresh hidden activation epoch', async () => {
    keyvStore.set('scroll:topic-t1::main', {
      scrollTop: -400,
      messageId: 'm-stable',
      intraRowOffset: -12,
      isAtBottom: false
    })
    const seen: { controller: RouteViewportController | null; phaseAttr: string | null } = {
      controller: null,
      phaseAttr: null
    }
    const onSeen = vi.fn((c: RouteViewportController, phaseAttr: string) => {
      seen.controller = c
      seen.phaseAttr = phaseAttr
    })
    const ui = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <RouteViewportProvider topicId="t1" initialRoute={null}>
          <Probe onSeen={onSeen} />
        </RouteViewportProvider>
      </Activity>
    )
    const { rerender } = render(ui('visible'))
    expect(await screen.findByTestId('inplace-probe')).toBeInTheDocument()
    const c = seen.controller as unknown as RouteViewportController

    // Stable session before hide.
    const stable = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    c.applyTransitionWindow(stable.epoch, { topicId: 't1', route: null }, 'old::new::10')
    c.firstPositioned(stable.epoch, 'placed')
    c.revealed(stable.epoch)
    expect(
      c.commitStable(stable.epoch, {
        messageId: 'm-stable',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(true)
    expect(c.isActivationSession).toBe(false)

    // Hide: same instance survives, short-lived identity renews, activation armed.
    await act(async () => {
      rerender(ui('hidden'))
    })
    expect(seen.controller).toBe(c)
    expect(c.isActivationRequired).toBe(true)
    const epochAtHide = c.currentEpoch
    expect(epochAtHide).toBeGreaterThan(stable.epoch)
    expect(
      c.commitStable(stable.epoch, {
        messageId: 'm-stable',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(false)

    // Show: the provider attach bumps the generation; the next guarded TOP
    // request is the single activation entry with a fresh hidden epoch.
    await act(async () => {
      rerender(ui('visible'))
    })
    expect(await screen.findByTestId('inplace-probe')).toBeInTheDocument()
    const reactivated = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    expect(reactivated.epoch).toBeGreaterThan(epochAtHide)
    expect(c.isActivationSession).toBe(true)
    expect(c.currentPhase).toBe('fetch-hold')
    // Resume gate: the reactivated fetch-hold hides (measurable) instead of
    // showing a wrong visible frame.
    expect(viewportPhaseAttrFor(c.currentPhase, c.currentIntent?.kind ?? null, c.isActivationSession)).toBe(
      'positioning'
    )
    // Complete the activation through the normal hidden pipeline; provenance
    // turns clean only after valid positioning + reveal + commit.
    c.applyTransitionWindow(reactivated.epoch, { topicId: 't1', route: null }, 'old::new::11')
    c.firstPositioned(reactivated.epoch, 'placed')
    expect(c.revealed(reactivated.epoch)).toBe(true)
    expect(
      c.commitStable(reactivated.epoch, {
        messageId: 'm-stable',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(true)
    expect(c.isDomProvenanceClean).toBe(true)
  })

  it('armed idle cannot paint visible before the single activation request; hidden geometry never captures', async () => {
    keyvStore.set('scroll:topic-t1::main', {
      scrollTop: -400,
      messageId: 'm-stable',
      intraRowOffset: -12,
      isAtBottom: false
    })
    const seen: { controller: RouteViewportController | null } = { controller: null }
    const Probe = ({ onSeen }: { onSeen: (c: RouteViewportController) => void }) => {
      const vp = useRouteViewport()
      useEffect(() => {
        onSeen(vp.controller)
      }, [vp, vp.controller, onSeen])
      return <div data-testid="armed-probe">probe</div>
    }
    const onSeen = vi.fn((c: RouteViewportController) => {
      seen.controller = c
    })
    const ui = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <RouteViewportProvider topicId="t1" initialRoute={null}>
          <Probe onSeen={onSeen} />
        </RouteViewportProvider>
      </Activity>
    )
    const { rerender } = render(ui('visible'))
    expect(await screen.findByTestId('armed-probe')).toBeInTheDocument()
    const c = seen.controller as unknown as RouteViewportController
    const stable = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    c.applyTransitionWindow(stable.epoch, { topicId: 't1', route: null }, 'old::new::20')
    c.firstPositioned(stable.epoch, 'placed')
    c.revealed(stable.epoch)
    expect(
      c.commitStable(stable.epoch, {
        messageId: 'm-stable',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(true)

    await act(async () => {
      rerender(ui('hidden'))
    })
    expect(seen.controller).toBe(c)
    // Detach: fresh epoch, short-lived identity cancelled, reactivation armed.
    const epochAtHide = c.currentEpoch
    expect(epochAtHide).toBeGreaterThan(stable.epoch)
    expect(c.isActivationRequired).toBe(true)
    expect(c.isActivationSession).toBe(false)
    expect(c.currentPhase).toBe('idle')
    // Pre-request armed idle maps hidden — never idle (visible) nor revealed.
    expect(
      viewportPhaseAttrFor(c.currentPhase, c.currentIntent?.kind ?? null, c.isActivationSession, c.isActivationRequired)
    ).toBe('positioning')
    // Stale detached completions stay inert.
    expect(c.applyTransitionWindow(stable.epoch, { topicId: 't1', route: null }, 'old::new::20')).toBe(false)
    expect(c.revealed(stable.epoch)).toBe(false)

    // Hidden display:none geometry never becomes a snapshot: the capturer
    // refuses while an ancestor proves detached-hidden.
    const hiddenHost = document.createElement('div')
    hiddenHost.style.display = 'none'
    const hiddenContainer = document.createElement('div')
    hiddenHost.appendChild(hiddenContainer)
    document.body.appendChild(hiddenHost)
    try {
      expect(isCaptureContainerHidden(hiddenContainer)).toBe(true)
      const capturer = buildContainerCapturer({ current: hiddenContainer } as { current: HTMLElement | null })
      expect(capturer()).toBeNull()
    } finally {
      document.body.removeChild(hiddenHost)
    }

    // Show, but BEFORE the single TOP request: still armed idle-hidden, no
    // visible gap. The request below is the test's stand-in for the single
    // Messages TOP pipeline entry (the provider itself never requests).
    await act(async () => {
      rerender(ui('visible'))
    })
    expect(await screen.findByTestId('armed-probe')).toBeInTheDocument()
    expect(c.isActivationRequired).toBe(true)
    expect(c.currentPhase).toBe('idle')
    expect(
      viewportPhaseAttrFor(c.currentPhase, c.currentIntent?.kind ?? null, c.isActivationSession, c.isActivationRequired)
    ).toBe('positioning')
    const reactivated = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    expect(reactivated.epoch).toBeGreaterThan(epochAtHide)
    expect(c.isActivationRequired).toBe(false)
    expect(c.isActivationSession).toBe(true)
    expect(
      viewportPhaseAttrFor(c.currentPhase, c.currentIntent?.kind ?? null, c.isActivationSession, c.isActivationRequired)
    ).toBe('positioning')
  })
})

describe('activation hidden settle (no reveal-before-settle)', () => {
  it('reveal requires alignment; folded/moving anchors cannot commit; stale completions stay inert', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    c.detach()
    const reactivated = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    // Reveal before placement refuses: still fetch-hold, never aligned.
    expect(c.revealed(reactivated.epoch)).toBe(false)
    expect(c.currentPhase).toBe('fetch-hold')
    expect(viewportPhaseAttrFor(c.currentPhase, 'top', true, false)).toBe('positioning')

    c.applyTransitionWindow(reactivated.epoch, { topicId: 't1', route: null }, 'old::new::31')
    expect(c.currentPhase).toBe('positioning')
    // Placed pre-paint while hidden: aligned activation stays hidden until
    // the deferred reveal/stable commit (ordinary aligned stays revealed).
    c.firstPositioned(reactivated.epoch, 'placed')
    expect(c.currentPhase).toBe('aligned')
    expect(viewportPhaseAttrFor('aligned', 'top', true)).toBe('positioning')
    expect(viewportPhaseAttrFor('aligned', 'top', false)).toBe('revealed')
    // Folded/moving anchor: a top session holding a message anchor cannot
    // commit a null identity (unresolved anchor never becomes a fallback).
    expect(
      c.commitStable(reactivated.epoch, {
        messageId: null,
        intraRowOffset: null,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(false)
    expect(c.currentPhase).toBe('aligned')
    // Deferred reveal after hidden verification, then identity commit.
    expect(c.revealed(reactivated.epoch)).toBe(true)
    expect(
      c.commitStable(reactivated.epoch, {
        messageId: 'm-stable',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(true)
    expect(c.currentPhase).toBe('stable')
    expect(viewportPhaseAttrFor('stable', 'top', true)).toBe('revealed')

    // Stale cancel: supersede with a new session; the old epoch can never
    // reveal, commit, or release the new transaction.
    const next = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -100, messageId: 'm2', intraRowOffset: -5, isAtBottom: false }
    })
    expect(next.epoch).toBeGreaterThan(reactivated.epoch)
    expect(c.isActivationSession).toBe(false)
    expect(c.revealed(reactivated.epoch)).toBe(false)
    expect(
      c.commitStable(reactivated.epoch, {
        messageId: 'm-stable',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(false)
    expect(c.releaseSession(reactivated.epoch)).toBe(false)
    expect(c.isSessionCurrent(next.epoch)).toBe(true)
  })
})

describe('retained same-window pre-paint trigger (regression)', () => {
  it('same window object + same visual attr still positions via the real phase/epoch trigger, exactly once', async () => {
    const { applyViewportFirstPosition, isViewportTransitionCurrent } = await import('../viewportTransition')
    const c = new RouteViewportController({ topicId: 't1', route: null })
    // Stable baseline on the same route (30-row retained projection shape).
    const stable = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm14', intraRowOffset: -12, isAtBottom: false }
    })
    c.applyTransitionWindow(stable.epoch, { topicId: 't1', route: null }, 'm00::m29::30')
    c.firstPositioned(stable.epoch, 'placed')
    c.revealed(stable.epoch)
    expect(
      c.commitStable(stable.epoch, {
        messageId: 'm14',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(true)

    // Detached lifetime arms activation (idle epoch, hidden-but-measurable).
    c.detach()
    expect(c.isActivationRequired).toBe(true)
    const idleAttr = viewportPhaseAttrFor(
      c.currentPhase,
      c.currentIntent?.kind ?? null,
      c.isActivationSession,
      c.isActivationRequired
    )
    expect(c.currentPhase).toBe('idle')
    expect(idleAttr).toBe('positioning')

    // Reactivation request: fetch-hold activation maps to the SAME visual attr.
    const reactivated = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm14', intraRowOffset: -12, isAtBottom: false }
    })
    expect(c.isActivationSession).toBe(true)
    const fetchHoldAttr = viewportPhaseAttrFor(
      c.currentPhase,
      c.currentIntent?.kind ?? null,
      c.isActivationSession,
      c.isActivationRequired
    )
    expect(c.currentPhase).toBe('fetch-hold')
    expect(fetchHoldAttr).toBe('positioning')

    // Retained SAME window object recommitted: internal fetch-hold → positioning,
    // but the visual attr stays `positioning` and the object identity is unchanged.
    const retainedWindow = {
      displayMessages: Array.from({ length: 30 }, (_, i) => ({ id: `m${String(i).padStart(2, '0')}` }))
    } as unknown as { displayMessages: { id: string }[] }
    const windowBefore = retainedWindow
    expect(c.applyTransitionWindow(reactivated.epoch, { topicId: 't1', route: null }, 'm00::m29::30')).toBe(true)
    const positioningAttr = viewportPhaseAttrFor(
      c.currentPhase,
      c.currentIntent?.kind ?? null,
      c.isActivationSession,
      c.isActivationRequired
    )
    expect(c.currentPhase).toBe('positioning')
    expect(positioningAttr).toBe('positioning')
    // Old trigger (visual attr + window object) is blind here …
    expect(positioningAttr).toBe(fetchHoldAttr)
    expect(retainedWindow).toBe(windowBefore)
    // … but the real transaction trigger moved: fetch-hold → positioning on a new epoch.
    expect(c.currentEpoch).toBe(reactivated.epoch)
    expect(c.isSessionCurrent(reactivated.epoch)).toBe(true)

    // Real pre-paint gate (same shape as the Messages layout effect): the current
    // plan must place even though attr/window are unchanged.
    const container = document.createElement('div')
    const row = document.createElement('div')
    row.id = 'message-m14'
    container.appendChild(row)
    document.body.appendChild(container)
    try {
      const current = isViewportTransitionCurrent({
        topicMatch: true,
        routeMatch: true,
        epochCurrent: c.isSessionCurrent(reactivated.epoch),
        mounted: true
      })
      expect(current).toBe(true)
      const outcome = applyViewportFirstPosition(container, {
        kind: 'message',
        messageId: 'm14',
        wantOffset: -12,
        fallbackScrollTop: null
      })
      expect(outcome).toBe('placed')
      expect(c.firstPositioned(reactivated.epoch, outcome)).toBe(true)
      // Activation stays hidden through aligned until the deferred reveal/stable commit.
      expect(c.currentPhase).toBe('aligned')
      expect(viewportPhaseAttrFor(c.currentPhase, 'top', true)).toBe('positioning')
    } finally {
      document.body.removeChild(container)
    }

    // Repeated effect runs are inert: leaving `positioning` makes re-entry a no-op,
    // and a delayed old epoch never places/reveals/commits the new session.
    expect(c.firstPositioned(reactivated.epoch, 'placed')).toBe(false)
    expect(c.revealed(stable.epoch)).toBe(false)
    expect(
      c.commitStable(stable.epoch, { messageId: 'm14', intraRowOffset: -12, scrollTop: -400, isAtBottom: false })
        .committed
    ).toBe(false)
    expect(c.releaseSession(stable.epoch)).toBe(false)
    expect(c.isSessionCurrent(reactivated.epoch)).toBe(true)
  })

  it('current-owner rejected completion fails visible; stale-owner failure never terminates the new session', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    c.detach()
    const reactivated = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm14', intraRowOffset: -12, isAtBottom: false }
    })
    // Current owner, not yet positioned: reveal rejects while the session is current.
    expect(c.isSessionCurrent(reactivated.epoch)).toBe(true)
    expect(c.revealed(reactivated.epoch)).toBe(false)
    // Bounded handling: the current owner's rejected completion terminates visibly
    // (preserving snapshot, releasing exactly once) instead of staying hidden.
    const terminated = c.terminate(reactivated.epoch, 'fail-visible')
    expect(terminated.terminated).toBe(true)
    expect(c.currentPhase).toBe('terminal')
    expect(c.programmaticOwned).toBe(false)

    // The next guarded session starts clean; the old owner's late failures stay inert.
    const next = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm14', intraRowOffset: -12, isAtBottom: false }
    })
    expect(next.epoch).toBeGreaterThan(reactivated.epoch)
    expect(c.isSessionCurrent(next.epoch)).toBe(true)
    expect(c.revealed(reactivated.epoch)).toBe(false)
    expect(
      c.commitStable(reactivated.epoch, { messageId: 'm14', intraRowOffset: -12, scrollTop: -400, isAtBottom: false })
        .committed
    ).toBe(false)
    expect(c.terminate(reactivated.epoch, 'fail-visible').terminated).toBe(false)
    expect(c.releaseSession(reactivated.epoch)).toBe(false)
    // The new session is untouched and still owns its transaction.
    expect(c.isSessionCurrent(next.epoch)).toBe(true)
    expect(c.currentPhase).toBe('fetch-hold')
  })
})
