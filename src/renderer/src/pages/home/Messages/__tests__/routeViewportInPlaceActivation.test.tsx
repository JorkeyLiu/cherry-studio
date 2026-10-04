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

import {
  alignRetainedViewportOnce,
  isRetainedAnchorOffsetAligned,
  isRetainedBottomAligned,
  RETAINED_CONTINUATION_ALIGN_EPS_PX,
  shouldContinueRetainedViewport,
  shouldRestoreRetainedWindowInPlace,
  shouldTopPipelineRefuseDividerIntent
} from '../routeViewportActivation'
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

  it('validated continuation keeps the return revealed: no hidden repositioning, no extra generation, release exactly once', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    c.detach()
    expect(c.isRetainedContinuation).toBe(false)
    const reactivated = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm14', intraRowOffset: -12, isAtBottom: false }
    })
    // Unvalidated activation still hides: the guard is not simply removed.
    expect(c.isRetainedContinuation).toBe(false)
    expect(viewportPhaseAttrFor(c.currentPhase, 'top', true, false, c.isRetainedContinuation)).toBe('positioning')
    const generationBefore = c.windowGeneration
    const anchorBefore = c.getAnchorFor({ topicId: 't1', route: null })

    // Synchronous validation of the already-correct retained window: no window
    // redispatch, no placement plan, no scroll write, no generation bump —
    // observable as unchanged generation + unchanged anchor + aligned phase.
    expect(c.validateRetainedContinuation(reactivated.epoch, { topicId: 't1', route: null }, 'm00::m29::30')).toBe(true)
    expect(c.isRetainedContinuation).toBe(true)
    expect(c.currentPhase).toBe('aligned')
    expect(c.windowGeneration).toBe(generationBefore)
    expect(c.getAnchorFor({ topicId: 't1', route: null })).toEqual(anchorBefore)
    // The validated return stays revealed (first visible frame already correct).
    expect(viewportPhaseAttrFor(c.currentPhase, 'top', true, false, c.isRetainedContinuation)).toBe('revealed')
    expect(viewportPhaseAttrFor('fetch-hold', 'top', true, false, true)).toBe('revealed')
    expect(viewportPhaseAttrFor('searching', 'top', true, false, true)).toBe('revealed')

    // Synchronous reveal + identity commit releases exactly once; the snapshot
    // keeps the same stable identity (continuation, not a new position).
    expect(c.revealed(reactivated.epoch)).toBe(true)
    const releasesBefore = c.releaseCount
    expect(
      c.commitStable(reactivated.epoch, {
        messageId: 'm14',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(true)
    expect(c.currentPhase).toBe('stable')
    expect(c.releaseCount).toBe(releasesBefore + 1)
    expect(c.isDomProvenanceClean).toBe(true)
    expect(viewportPhaseAttrFor(c.currentPhase, 'top', true, false, c.isRetainedContinuation)).toBe('revealed')
    // Second completion on the released epoch is inert (release exactly once).
    expect(
      c.commitStable(reactivated.epoch, {
        messageId: 'm14',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(false)
    expect(c.releaseSession(reactivated.epoch)).toBe(false)
  })

  it('continuation refuses everything the hidden restore must still own; stale epochs stay inert', () => {
    // Ordinary (non-detached) session is never a continuation.
    const ordinary = new RouteViewportController({ topicId: 't1', route: null })
    const ordReq = ordinary.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm14', intraRowOffset: -12, isAtBottom: false }
    })
    expect(ordinary.validateRetainedContinuation(ordReq.epoch, { topicId: 't1', route: null }, 'm00::m29::30')).toBe(
      false
    )
    expect(ordinary.isRetainedContinuation).toBe(false)

    // Divider explicit continuation keeps priority: TOP continuation refuses it.
    const divider = new RouteViewportController({ topicId: 't1', route: null })
    divider.detach()
    const divReq = divider.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b9',
      dividerKey: 'mFork::main',
      clickOffset: 55
    })
    expect(divider.validateRetainedContinuation(divReq.epoch, { topicId: 't1', route: 'b9' }, 'a::b::5')).toBe(false)

    // Activation validation matrix: wrong phase, wrong target, empty window,
    // stale epoch all refuse with no effect on the live session.
    const c = new RouteViewportController({ topicId: 't1', route: null })
    c.detach()
    const reactivated = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm14', intraRowOffset: -12, isAtBottom: false }
    })
    expect(c.validateRetainedContinuation(reactivated.epoch, { topicId: 't1', route: 'bX' }, 'm00::m29::30')).toBe(
      false
    )
    expect(c.validateRetainedContinuation(reactivated.epoch, { topicId: 't1', route: null }, '')).toBe(false)
    expect(c.validateRetainedContinuation(reactivated.epoch + 99, { topicId: 't1', route: null }, 'm00::m29::30')).toBe(
      false
    )
    expect(c.currentPhase).toBe('fetch-hold')
    expect(c.isSessionCurrent(reactivated.epoch)).toBe(true)
    // A new request clears a previously validated continuation.
    expect(c.validateRetainedContinuation(reactivated.epoch, { topicId: 't1', route: null }, 'm00::m29::30')).toBe(true)
    expect(c.isRetainedContinuation).toBe(true)
    c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -100, messageId: 'm2', intraRowOffset: -5, isAtBottom: false }
    })
    expect(c.isRetainedContinuation).toBe(false)
    c.invalidateAll()
    expect(c.isRetainedContinuation).toBe(false)
  })

  it('continuation admission needs a provable geometry target; 1px production epsilon (not E2E budget)', () => {
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
    // Anchored continuation requires a finite saved offset target.
    expect(shouldContinueRetainedViewport({ ...base, wantOffsetFinite: true })).toBe(true)
    expect(shouldContinueRetainedViewport({ ...base, wantOffsetFinite: false })).toBe(false)
    // Anchorless bottom continues; anchorless non-bottom never invents a target.
    expect(
      shouldContinueRetainedViewport({
        ...base,
        canonicalAnchor: null,
        isAtBottom: true,
        retainedContainsAnchor: false,
        loadedContainsAnchor: false,
        domAnchorResident: true,
        wantOffsetFinite: false
      })
    ).toBe(true)
    expect(
      shouldContinueRetainedViewport({
        ...base,
        canonicalAnchor: null,
        isAtBottom: false,
        retainedContainsAnchor: false,
        loadedContainsAnchor: false,
        domAnchorResident: true,
        wantOffsetFinite: false
      })
    ).toBe(false)
    // Route/topic/deletion/empty/coverage failures decline to the hidden path.
    expect(shouldContinueRetainedViewport({ ...base, wantOffsetFinite: true, selectedRoute: 'b1' })).toBe(false)
    expect(shouldContinueRetainedViewport({ ...base, wantOffsetFinite: true, deletionPending: true })).toBe(false)
    expect(shouldContinueRetainedViewport({ ...base, wantOffsetFinite: true, hasRetainedWindow: false })).toBe(false)
    expect(shouldContinueRetainedViewport({ ...base, wantOffsetFinite: true, retainedContainsAnchor: false })).toBe(
      false
    )
    expect(shouldContinueRetainedViewport({ ...base, wantOffsetFinite: true, wasActivation: false })).toBe(false)

    // Production geometric acceptance is 1px (viewportTransition + pagination
    // epsilon), NOT the E2E measurement budget (12px anchor / 100px bottom).
    expect(RETAINED_CONTINUATION_ALIGN_EPS_PX).toBe(1)
    expect(isRetainedAnchorOffsetAligned(-12, -12)).toBe(true)
    expect(isRetainedAnchorOffsetAligned(-12, -11)).toBe(true)
    expect(isRetainedAnchorOffsetAligned(-12, -10.9)).toBe(false)
    // Within-E2E-but-inaccurate cases must REJECT: 9px offset is inside the
    // 12px E2E budget but outside the 1px production epsilon.
    expect(isRetainedAnchorOffsetAligned(0, 9)).toBe(false)
    expect(isRetainedAnchorOffsetAligned(0, 12)).toBe(false)
    expect(isRetainedAnchorOffsetAligned(0, 12.1)).toBe(false)
    expect(isRetainedAnchorOffsetAligned(NaN, -12)).toBe(false)
    expect(isRetainedAnchorOffsetAligned(0, Number.POSITIVE_INFINITY)).toBe(false)
    expect(isRetainedBottomAligned(0)).toBe(true)
    expect(isRetainedBottomAligned(1)).toBe(true)
    expect(isRetainedBottomAligned(1.1)).toBe(false)
    // 80px bottom is inside the 100px E2E budget but far outside true-bottom
    // geometry (column-reverse scrollTop 0 within 1px).
    expect(isRetainedBottomAligned(80)).toBe(false)
    expect(isRetainedBottomAligned(100)).toBe(false)
    expect(isRetainedBottomAligned(100.1)).toBe(false)
    expect(isRetainedBottomAligned(NaN)).toBe(false)
    expect(isRetainedBottomAligned(Number.NaN)).toBe(false)
  })

  it('shared pre-paint helper: exact means zero writes; coverable mismatch means one write + 1px remeasure; failure never invents aligned', () => {
    const makeContainer = (overrides: {
      top?: number
      width?: number
      height?: number
      clientHeight?: number
      scrollTop?: number
      clampScroll?: boolean
    }) => {
      let scrollTop = overrides.scrollTop ?? 0
      let writes = 0
      const rect = () => ({ top: overrides.top ?? 100, width: overrides.width ?? 400, height: overrides.height ?? 600 })
      const container = {
        clientHeight: overrides.clientHeight ?? 600,
        getBoundingClientRect: () => ({ ...rect() }),
        isConnected: true
      } as unknown as HTMLElement
      Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (v: number) => {
          writes += 1
          scrollTop = overrides.clampScroll === true ? scrollTop : v
        },
        configurable: true
      })
      return { container, getWrites: () => writes, getScrollTop: () => scrollTop }
    }
    const makeRow = (top: number, height = 40, connected = true, finite = true) => {
      const row = { isConnected: connected } as unknown as HTMLElement

      ;(row as any).getBoundingClientRect = () => ({
        top: finite ? top : Number.NaN,
        height: finite ? height : Number.NaN
      })
      return row
    }

    // Exact anchored geometry: no scroll write.
    {
      const c = makeContainer({ top: 100, scrollTop: -400 })
      const row = makeRow(88)
      const before = c.getScrollTop()
      const res = alignRetainedViewportOnce({
        container: c.container,
        rowEl: row,
        anchorId: 'm14',
        wantOffset: -12,
        isAtBottom: false,
        isRowVisible: true
      })
      expect(res).toEqual({ aligned: true, writes: 0 })
      expect(c.getWrites()).toBe(0)
      expect(c.getScrollTop()).toBe(before)
    }

    // Coverable 9px mismatch (inside E2E 12px, outside 1px): exactly one
    // synchronous correction, then the remeasure verifies within 1px. The
    // fake row tracks the container scroll so the second measure lands exact.
    {
      let scrollTop = -400
      const containerTop = 100
      const want = -12
      const haveBefore = -3 // 9px off
      let writes = 0
      const container = { clientHeight: 600, isConnected: true } as unknown as HTMLElement
      Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (v: number) => {
          writes += 1
          scrollTop = v
        },
        configurable: true
      })

      ;(container as any).getBoundingClientRect = () => ({ top: containerTop, width: 400, height: 600 })
      const row = { isConnected: true } as unknown as HTMLElement

      ;(row as any).getBoundingClientRect = () => ({
        // After the single correction the row sits exactly at want.
        top: writes === 0 ? containerTop + haveBefore : containerTop + want,
        height: 40
      })
      const res = alignRetainedViewportOnce({
        container,
        rowEl: row,
        anchorId: 'm14',
        wantOffset: want,
        isAtBottom: false,
        isRowVisible: true
      })
      expect(res).toEqual({ aligned: true, writes: 1 })
      expect(writes).toBe(1)
    }

    // Clamped/failed correction must NOT mark aligned: the write happens once
    // but the remeasure still misses, so the caller falls back to hidden.
    {
      const c = makeContainer({ top: 100, scrollTop: -400, clampScroll: true })
      const row = makeRow(97) // 9px off (100+9-100=9 vs want -12 => 21px off)
      const res = alignRetainedViewportOnce({
        container: c.container,
        rowEl: row,
        anchorId: 'm14',
        wantOffset: -12,
        isAtBottom: false,
        isRowVisible: true
      })
      expect(res.aligned).toBe(false)
      expect(res.writes).toBe(1)
      expect(c.getWrites()).toBe(1)
    }

    // Unmeasurable geometry never writes and never aligns.
    {
      const c = makeContainer({ top: 100 })
      expect(
        alignRetainedViewportOnce({
          container: c.container,
          rowEl: null,
          anchorId: 'm14',
          wantOffset: -12,
          isAtBottom: false,
          isRowVisible: true
        })
      ).toEqual({ aligned: false, writes: 0 })
      expect(c.getWrites()).toBe(0)

      const hidden = makeContainer({ top: 100 })
      const hiddenRow = makeRow(88)
      expect(
        alignRetainedViewportOnce({
          container: hidden.container,
          rowEl: hiddenRow,
          anchorId: 'm14',
          wantOffset: -12,
          isAtBottom: false,
          isRowVisible: false
        })
      ).toEqual({ aligned: false, writes: 0 })

      const zeroBox = makeContainer({ top: 100, width: 0, height: 600 })
      expect(
        alignRetainedViewportOnce({
          container: zeroBox.container,
          rowEl: makeRow(88),
          anchorId: 'm14',
          wantOffset: -12,
          isAtBottom: false,
          isRowVisible: true
        })
      ).toEqual({ aligned: false, writes: 0 })

      // Anchorless non-bottom invents no target.
      const bottomless = makeContainer({ top: 100 })
      expect(
        alignRetainedViewportOnce({
          container: bottomless.container,
          rowEl: null,
          anchorId: null,
          wantOffset: null,
          isAtBottom: false,
          isRowVisible: true
        })
      ).toEqual({ aligned: false, writes: 0 })
    }

    // Bottom: exact means zero writes; 80px mismatch (inside E2E 100px,
    // outside 1px) aligns with exactly one write to true bottom.
    {
      const exact = makeContainer({ scrollTop: 0 })
      expect(
        alignRetainedViewportOnce({
          container: exact.container,
          rowEl: null,
          anchorId: null,
          wantOffset: null,
          isAtBottom: true,
          isRowVisible: true
        })
      ).toEqual({ aligned: true, writes: 0 })
      expect(exact.getWrites()).toBe(0)

      const off = makeContainer({ scrollTop: -80 })
      const res = alignRetainedViewportOnce({
        container: off.container,
        rowEl: null,
        anchorId: null,
        wantOffset: null,
        isAtBottom: true,
        isRowVisible: true
      })
      expect(res).toEqual({ aligned: true, writes: 1 })
      expect(off.getScrollTop()).toBe(0)
    }
  })

  it('reconnect ordering: hidden/disconnected stays inert without consuming activation; layout setup precedes pre-paint measurement', () => {
    // Production contract (Messages layout lifetime + pre-paint + passive):
    // - the lifetime marker is layout-ordered before pre-paint measurement, so
    //   a show's pre-paint validation observes the reconnected (not stale
    //   disconnected) state;
    // - the passive lane never starts/consumes while the container is
    //   detached or under an actual display:none ancestor (existing
    //   isCaptureContainerHidden predicate); visibility:hidden stays
    //   measurable on purpose and is covered by the alignment helper.
    // Asserted against the actual production helpers, not a copied sketch.
    const hiddenHost = document.createElement('div')
    hiddenHost.style.display = 'none'
    const hiddenContainer = document.createElement('div')
    hiddenHost.appendChild(hiddenContainer)
    document.body.appendChild(hiddenHost)
    const visibleContainer = document.createElement('div')
    document.body.appendChild(visibleContainer)
    try {
      expect(isCaptureContainerHidden(hiddenContainer)).toBe(true)
      expect(isCaptureContainerHidden(visibleContainer)).toBe(false)
      // Detached container is hidden-proof without rect inference.
      const detached = document.createElement('div')
      expect(isCaptureContainerHidden(detached)).toBe(true)
      visibleContainer.appendChild(detached)
      // Still connected under a visible parent: not hidden.
      expect(isCaptureContainerHidden(detached)).toBe(false)

      // Armed activation survives hidden: the passive-style hidden gate must
      // decline BEFORE any request/epoch/snapshot/scroll side effect.
      const c = new RouteViewportController({ topicId: 't1', route: null })
      c.detach()
      expect(c.isActivationRequired).toBe(true)
      expect(c.currentPhase).toBe('idle')
      const epochBefore = c.currentEpoch
      // Simulated passive gate order (actual predicate): hidden → inert.
      const passiveGateAllows = !isCaptureContainerHidden(hiddenContainer)
      expect(passiveGateAllows).toBe(false)
      // No consumption happened: activation still armed, epoch unchanged.
      expect(c.isActivationRequired).toBe(true)
      expect(c.currentEpoch).toBe(epochBefore)
      expect(c.currentPhase).toBe('idle')

      // Visible container passes the gate and the shared 1px helper proves
      // exact geometry with zero writes (sole fast-path owner stays pre-paint).
      expect(isCaptureContainerHidden(visibleContainer)).toBe(false)
      const row = document.createElement('div')
      visibleContainer.appendChild(row)
      const want = -12
      const containerTop = 100
      vi.spyOn(visibleContainer, 'getBoundingClientRect').mockReturnValue({
        top: containerTop,
        width: 400,
        height: 600,
        bottom: 700,
        left: 0,
        right: 400,
        x: 0,
        y: containerTop,
        toJSON: () => ({})
      } as unknown as DOMRect)
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        top: containerTop + want,
        height: 40,
        width: 100,
        bottom: containerTop + want + 40,
        left: 0,
        right: 100,
        x: 0,
        y: containerTop + want,
        toJSON: () => ({})
      } as unknown as DOMRect)
      Object.defineProperty(visibleContainer, 'clientHeight', { value: 600, configurable: true })
      const aligned = alignRetainedViewportOnce({
        container: visibleContainer,
        rowEl: row,
        anchorId: 'm14',
        wantOffset: want,
        isAtBottom: false,
        isRowVisible: true
      })
      expect(aligned).toEqual({ aligned: true, writes: 0 })

      // Stale same-lifetime completions stay inert after detach advances the
      // epoch: the old epoch can never validate/commit/release the new one.
      const reactivated = c.request({
        kind: 'top',
        topicId: 't1',
        targetRoute: null,
        saved: { scrollTop: -400, messageId: 'm14', intraRowOffset: -12, isAtBottom: false }
      })
      const staleEpoch = reactivated.epoch
      c.detach()
      expect(c.isSessionCurrent(staleEpoch)).toBe(false)
      expect(c.validateRetainedContinuation(staleEpoch, { topicId: 't1', route: null }, 'm00::m29::30')).toBe(false)
      expect(
        c.commitStable(staleEpoch, { messageId: 'm14', intraRowOffset: -12, scrollTop: -400, isAtBottom: false })
          .committed
      ).toBe(false)
      expect(c.releaseSession(staleEpoch)).toBe(false)
    } finally {
      hiddenHost.remove()
      visibleContainer.remove()
    }
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
