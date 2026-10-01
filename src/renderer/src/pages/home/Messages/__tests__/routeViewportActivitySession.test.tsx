/**
 * Implicit route browsing session continuity across Activity detach/reattach.
 *
 * Real `Activity` hide/show (not source-string assertions):
 * - stable session truth (displayed + anchorCache + persisted snapshot)
 *   survives detach while the short-lived transaction is cancelled/released
 *   exactly once with a fresh epoch (old completions inert);
 * - hidden containers never sample geometry (last legal snapshot preserved);
 * - reactivation renews lifetime and restores through a guarded own-target
 *   transaction; repeated detach/reattach keeps working;
 * - divider explicit continuation keeps the current offset (never the target
 *   historic snapshot).
 */
import { act, render, screen } from '@testing-library/react'
import { Activity, useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { shouldTopPipelineRefuseDividerIntent } from '../routeViewportActivation'
import {
  buildContainerCapturer,
  isCaptureContainerHidden,
  readRouteSnapshot,
  RouteViewportProvider,
  useRouteViewport,
  writeRouteSnapshot
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

const wid = (n: string): string => `oldest::newest::${n}`
const displayed = (topicId: string, route: string | null) => ({ topicId, route })

beforeEach(() => {
  keyvStore = new Map()
  installKeyv()
  dispatchMock.mockClear()
})

describe('controller detach/reattach session continuity', () => {
  it('stable truth survives detach; short-lived transaction cancelled once with fresh epoch; old completions inert', () => {
    const c = new RouteViewportController(displayed('t1', null))
    // Establish stable A anchor (user scroll path).
    c.declareUserIntent()
    const taken = c.userTakeover({ messageId: 'mA', intraRowOffset: -12, scrollTop: -400, isAtBottom: false })
    expect(taken.taken).toBe(true)
    c.noteInteractionScrollEnd()
    expect(c.getAnchorFor(displayed('t1', null))).toEqual({ kind: 'message', messageId: 'mA', offset: -12 })

    // Start an in-flight top transition to B (fetch-hold, owned).
    const toB = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -500, messageId: 'mB', intraRowOffset: -30, isAtBottom: false }
    })
    expect(c.programmaticOwned).toBe(true)
    const releasesBefore = c.releaseCount

    // Explicit detach (Activity hidden): cancels the short-lived transaction
    // and arms the guarded reactivation (single owner, exactly-once release).
    const invalidated = c.detach()
    expect(invalidated).toBe(true)
    expect(c.releaseCount).toBe(releasesBefore + 1)
    expect(c.isActivationRequired).toBe(true)
    // Live short-lived truth cleared; long-lived session truth preserved.
    expect(c.currentIntent).toBeNull()
    expect(c.getAnchorFor(displayed('t1', null))).toBeNull()
    expect(c.renderedProvenance).toBeNull()
    expect(c.displayedRoute).toEqual(displayed('t1', null))
    // While armed, an incidental rebase must refuse — never fake clean.
    expect(c.rebaseClean({ topicId: 't1', route: null }, wid('armed'))).toBe(false)

    // Fresh transaction identity: old epoch completions are inert even with
    // epoch-equality-only checks (currentEpoch advanced past toB.epoch).
    expect(c.currentEpoch).toBeGreaterThan(toB.epoch)
    expect(c.applyTransitionWindow(toB.epoch, { topicId: 't1', route: 'b1' }, wid('1'))).toBe(false)
    expect(c.firstPositioned(toB.epoch, 'placed')).toBe(false)
    expect(c.revealed(toB.epoch)).toBe(false)
    expect(
      c.commitStable(toB.epoch, { messageId: 'mB', intraRowOffset: -30, scrollTop: -500, isAtBottom: false }).committed
    ).toBe(false)
    expect(c.releaseSession(toB.epoch)).toBe(false)

    // Reactivation (single-entry TOP semantics): the armed flag plus no
    // divider refusal admits a guarded own-target transaction from the
    // target's own snapshot (stored stable truth, not outgoing geometry),
    // consuming the flag in the SAME request that the loader then drives.
    expect(c.isActivationRequired).toBe(true)
    expect(shouldTopPipelineRefuseDividerIntent(c, 't1', null)).toBe(false)
    const back = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'mA', intraRowOffset: -12, isAtBottom: false }
    })
    expect(c.isActivationRequired).toBe(false)
    expect(back.epoch).toBeGreaterThan(toB.epoch)
    expect(c.getAnchorFor(displayed('t1', null))).toEqual({ kind: 'message', messageId: 'mA', offset: -12 })
    c.applyTransitionWindow(back.epoch, { topicId: 't1', route: null }, wid('A-1'))
    c.firstPositioned(back.epoch, 'placed')
    expect(c.revealed(back.epoch)).toBe(true)
    const out = c.commitStable(back.epoch, {
      messageId: 'mA',
      intraRowOffset: -12,
      scrollTop: -400,
      isAtBottom: false
    })
    expect(out.committed).toBe(true)
    expect(out.commit?.routeKey).toBe('topic-t1::main')
  })

  it('idle detach still advances epoch so stale async can never revive; repeated reconnect keeps working', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const e0 = c.currentEpoch
    expect(c.detach()).toBe(false)
    expect(c.isActivationRequired).toBe(true)
    expect(c.currentEpoch).toBeGreaterThan(e0)
    expect(c.rebaseClean({ topicId: 't1', route: null }, wid('idle-armed'))).toBe(false)
    const e1 = c.currentEpoch

    // First reconnect cycle restores and consumes the flag.
    const first = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -100, messageId: 'm1', intraRowOffset: -5, isAtBottom: false }
    })
    expect(c.isActivationRequired).toBe(false)
    c.applyTransitionWindow(first.epoch, { topicId: 't1', route: null }, wid('w1'))
    c.firstPositioned(first.epoch, 'placed')
    c.revealed(first.epoch)
    expect(
      c.commitStable(first.epoch, { messageId: 'm1', intraRowOffset: -5, scrollTop: -100, isAtBottom: false }).committed
    ).toBe(true)

    // Second detach/reconnect: old first-epoch completions inert, new works.
    c.detach()
    expect(c.isActivationRequired).toBe(true)
    expect(c.currentEpoch).toBeGreaterThan(first.epoch)
    expect(
      c.commitStable(first.epoch, { messageId: 'm1', intraRowOffset: -5, scrollTop: -100, isAtBottom: false }).committed
    ).toBe(false)
    const second = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -200, messageId: 'm2', intraRowOffset: -7, isAtBottom: false }
    })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(c.getAnchorFor(displayed('t1', 'b1'))).toEqual({ kind: 'message', messageId: 'm2', offset: -7 })
    expect(e1).toBeLessThan(second.epoch)
  })

  it('divider explicit continuation keeps the current offset, never the target historic snapshot', () => {
    const c = new RouteViewportController(displayed('t1', null))
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mCurrent', intraRowOffset: -9, scrollTop: -300, isAtBottom: false })
    c.noteInteractionScrollEnd()
    // Detach preserves the run; reactivation via divider keeps click offset
    // and consumes the armed flag (explicit kind, never generic overwrite).
    c.detach()
    expect(c.isActivationRequired).toBe(true)
    const div = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b9',
      dividerKey: 'mFork::main',
      clickOffset: 55
    })
    expect(c.isActivationRequired).toBe(false)
    expect(c.getAnchorFor(displayed('t1', 'b9'))).toEqual({ kind: 'divider', dividerKey: 'mFork::main', offset: 55 })
    void div
  })
})

describe('hidden-geometry capturer guard', () => {
  it('visible container captures; display:none ancestor and disconnected containers preserve (null)', () => {
    const outer = document.createElement('div')
    const container = document.createElement('div')
    Object.defineProperty(container, 'scrollTop', { value: -400, writable: true, configurable: true })
    const row = document.createElement('div')
    row.setAttribute('data-message-id', 'm-stable')
    container.append(row)
    outer.append(container)
    document.body.append(outer)
    const ref = { current: container } as React.RefObject<HTMLElement | null>

    // Visible: no display:none ancestor → not hidden; capturer runs (anchor
    // may be null in jsdom without layout, but the hidden gate passes).
    expect(isCaptureContainerHidden(container)).toBe(false)
    const capturer = buildContainerCapturer(ref)
    const visible = capturer()
    // jsdom has no layout so the anchor lookup is null, but scrollTop is
    // sampled (gate passed). Hidden must return null instead.
    expect(visible).not.toBeNull()
    expect(visible?.scrollTop).toBe(-400)

    // Hidden via Activity-style display:none ancestor → preserve (null).
    outer.style.display = 'none'
    expect(isCaptureContainerHidden(container)).toBe(true)
    expect(capturer()).toBeNull()

    // Disconnected → preserve (null).
    outer.style.display = ''
    outer.remove()
    expect(isCaptureContainerHidden(container)).toBe(true)
    expect(capturer()).toBeNull()
    document.body.innerHTML = ''
  })
})

describe('RouteViewportProvider inside real Activity hide/show', () => {
  const probeState: {
    controller: RouteViewportController | null
    freeze: (() => boolean) | null
    epochAtVisible: number | null
  } = { controller: null, freeze: null, epochAtVisible: null }

  // Production activation probe: registers the live capturer (as Messages
  // does) and drives the SAME single-entry TOP semantics production uses —
  // no test-only `controller.request` after rerender. On every provider
  // connection-generation bump the effect opens the guarded own-target
  // fetch-hold from the target's own persisted snapshot AND the test then
  // completes that SAME session through the normal window/placed/reveal/commit
  // pipeline (request+load one owner, never split) and asserts
  // provenance-clean only after valid positioning.
  const Probe = ({
    onSeen,
    topicId,
    activeRoute
  }: {
    onSeen: (c: RouteViewportController, freeze: () => boolean) => void
    topicId: string
    activeRoute: string | null
  }) => {
    const vp = useRouteViewport()
    useEffect(() => {
      vp.registerCapturer(() => ({ scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }))
      return () => vp.registerCapturer(null)
    }, [vp])
    useEffect(() => {
      onSeen(vp.controller, vp.freezeDisplayed)
    }, [vp, onSeen])
    // Single-entry TOP activation (mirrors Messages TOP pipeline effect):
    // connection-generation is the sole trigger; controller progress never
    // reopens. Divider-owned fetch-hold for the same target refuses.
    useEffect(() => {
      try {
        if (!vp.controller.isActivationRequired) return
        if (shouldTopPipelineRefuseDividerIntent(vp.controller, topicId, activeRoute)) return
        const key = `topic-${topicId}::${activeRoute ?? 'main'}`
        const saved = vp.readSnapshot(key) ?? readRouteSnapshot(key)
        vp.controller.request({ kind: 'top', topicId, targetRoute: activeRoute, saved })
        vp.notifyChanged()
      } catch {
        // fail-closed: no activation
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vp.controller, topicId, activeRoute, vp.connectionGeneration])
    return <div data-testid="viewport-probe">probe</div>
  }

  const renderProbe = (
    rerender: (ui: React.ReactElement) => void,
    mode: 'visible' | 'hidden',
    onSeen: (c: RouteViewportController, freeze: () => boolean) => void
  ) => {
    const ui = (
      <Activity mode={mode}>
        <RouteViewportProvider topicId="t1" initialRoute={null}>
          <Probe onSeen={onSeen} topicId="t1" activeRoute={null} />
        </RouteViewportProvider>
      </Activity>
    )
    rerender(ui)
  }

  it('retains the stable session across hidden; stale transaction inert; single-entry TOP auto-reactivates; repeated reconnect restores', async () => {
    // Seed the target's own persisted snapshot (production shape) so the
    // single-entry TOP restores from storage, never outgoing geometry.
    keyvStore.set('scroll:topic-t1::main', {
      scrollTop: -400,
      messageId: 'm-stable',
      intraRowOffset: -12,
      isAtBottom: false
    })
    const seen: { controller: RouteViewportController | null; freeze: (() => boolean) | null } = {
      controller: null,
      freeze: null
    }
    const onSeen = vi.fn((c: RouteViewportController, freeze: () => boolean) => {
      seen.controller = c
      seen.freeze = freeze
    })
    const { rerender } = render(
      <Activity mode="visible">
        <RouteViewportProvider topicId="t1" initialRoute={null}>
          <Probe onSeen={onSeen} topicId="t1" activeRoute={null} />
        </RouteViewportProvider>
      </Activity>
    )
    expect(await screen.findByTestId('viewport-probe')).toBeInTheDocument()
    const controller = seen.controller
    expect(controller).not.toBeNull()
    const c = controller as unknown as RouteViewportController

    // Establish a stable session: top request → window → placed → reveal → commit.
    const stable = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    c.applyTransitionWindow(stable.epoch, { topicId: 't1', route: null }, wid('stable-1'))
    c.firstPositioned(stable.epoch, 'placed')
    c.revealed(stable.epoch)
    const committed = c.commitStable(stable.epoch, {
      messageId: 'm-stable',
      intraRowOffset: -12,
      scrollTop: -400,
      isAtBottom: false
    })
    expect(committed.committed).toBe(true)
    // Persist the stable snapshot as production does so reactivation reads it.
    writeRouteSnapshot('topic-t1::main', {
      scrollTop: -400,
      messageId: 'm-stable',
      intraRowOffset: -12,
      isAtBottom: false
    })
    expect(readRouteSnapshot('topic-t1::main')?.messageId).toBe('m-stable')
    probeState.epochAtVisible = c.currentEpoch

    // Start an in-flight restore, then hide: detach cancels it with a fresh epoch.
    const inflight = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -500, messageId: 'mB', intraRowOffset: -30, isAtBottom: false }
    })
    await act(async () => {
      renderProbe(rerender, 'hidden', onSeen)
    })
    // Same controller instance survived (Activity retains state/refs); the
    // short-lived transaction was cancelled with a fresh identity and the
    // explicit reactivation was armed by the single provider detach owner.
    expect(c.currentEpoch).toBeGreaterThan(inflight.epoch)
    expect(c.currentIntent).toBeNull()
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })
    expect(c.isActivationRequired).toBe(true)
    expect(c.applyTransitionWindow(inflight.epoch, { topicId: 't1', route: 'b1' }, wid('stale'))).toBe(false)
    // While armed, an incidental projection rebase must refuse — provenance
    // stays dirty until the guarded activation positions, never fake clean.
    expect(c.rebaseClean({ topicId: 't1', route: null }, wid('rebase-while-armed'))).toBe(false)
    expect(c.isDomProvenanceClean).toBe(false)

    // Show again: the single-entry TOP auto-opens the guarded own-target
    // fetch-hold from the target's own snapshot — the test never calls
    // `controller.request` here. Assert the auto-owned session before driving it.
    await act(async () => {
      renderProbe(rerender, 'visible', onSeen)
    })
    expect(await screen.findByTestId('viewport-probe')).toBeInTheDocument()
    expect(c.isActivationRequired).toBe(false)
    expect(c.programmaticOwned).toBe(true)
    const autoIntent = c.currentIntent
    expect(autoIntent?.kind).toBe('top')
    expect(autoIntent?.targetRoute).toBeNull()
    expect(autoIntent?.topicId).toBe('t1')
    expect(c.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm-stable',
      offset: -12
    })
    // Complete the auto-owned session through the normal pipeline; provenance
    // turns clean only after valid positioning + reveal + commit.
    const autoEpoch = c.currentEpoch
    expect(autoEpoch).toBeGreaterThan(inflight.epoch)
    expect(c.applyTransitionWindow(autoEpoch, { topicId: 't1', route: null }, wid('auto-1'))).toBe(true)
    expect(c.firstPositioned(autoEpoch, 'placed')).toBe(true)
    expect(c.revealed(autoEpoch)).toBe(true)
    const autoCommit = c.commitStable(autoEpoch, {
      messageId: 'm-stable',
      intraRowOffset: -12,
      scrollTop: -400,
      isAtBottom: false
    })
    expect(autoCommit.committed).toBe(true)
    expect(autoCommit.commit?.routeKey).toBe('topic-t1::main')
    expect(c.isDomProvenanceClean).toBe(true)

    // Repeated hide/show keeps working (second cycle auto-reactivates again).
    await act(async () => {
      renderProbe(rerender, 'hidden', onSeen)
    })
    expect(c.isActivationRequired).toBe(true)
    const epochAfterSecondHide = c.currentEpoch
    await act(async () => {
      renderProbe(rerender, 'visible', onSeen)
    })
    expect(c.isActivationRequired).toBe(false)
    expect(c.programmaticOwned).toBe(true)
    expect(c.currentEpoch).toBeGreaterThan(epochAfterSecondHide)
    expect(c.getAnchorFor({ topicId: 't1', route: null })?.kind).toBe('message')
    // Complete the second auto-owned session so no owned session leaks.
    const secondEpoch = c.currentEpoch
    c.applyTransitionWindow(secondEpoch, { topicId: 't1', route: null }, wid('auto-2'))
    c.firstPositioned(secondEpoch, 'placed')
    c.revealed(secondEpoch)
    expect(
      c.commitStable(secondEpoch, {
        messageId: 'm-stable',
        intraRowOffset: -12,
        scrollTop: -400,
        isAtBottom: false
      }).committed
    ).toBe(true)
    void probeState
  })
})

describe('TOP pipeline never consumes divider intent (narrow kind isolation)', () => {
  it('connection-generation/route rerun during pending divider-owned fetch-hold keeps kind/epoch/anchor; no top adoption', () => {
    // Historical target snapshot points at a different exclusive anchor than
    // the live divider continuation — a TOP saved-snapshot plan would use it.
    keyvStore.set('scroll:topic-t1::b9', {
      scrollTop: -500,
      messageId: 'mHistoric',
      intraRowOffset: -30,
      isAtBottom: false
    })
    const c = new RouteViewportController(displayed('t1', null))
    const div = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b9',
      dividerKey: 'mFork::main',
      clickOffset: 55
    })
    const epochBefore = div.epoch
    expect(c.programmaticOwned).toBe(true)
    expect(c.currentPhase).toBe('fetch-hold')
    expect(c.currentIntent?.kind).toBe('divider')
    expect(c.getAnchorFor(displayed('t1', 'b9'))).toEqual({
      kind: 'divider',
      dividerKey: 'mFork::main',
      offset: 55
    })

    // Simulated TOP route-effect rerun (route/connection-generation bump) on the same
    // target while the divider owns fetch-hold: the production TOP gate
    // refuses, so no TOP fetch, no adoption, no saved-snapshot plan runs.
    expect(shouldTopPipelineRefuseDividerIntent(c, 't1', 'b9')).toBe(true)
    // TOP adoption entry mirrors the same refusal (never consumes divider epoch).
    const wouldAdopt =
      c.programmaticOwned &&
      c.currentPhase === 'fetch-hold' &&
      c.currentIntent !== null &&
      c.currentIntent.topicId === 't1' &&
      c.currentIntent.targetRoute === 'b9' &&
      c.currentIntent.kind !== 'divider'
        ? c.currentEpoch
        : null
    expect(wouldAdopt).toBeNull()
    // Single-entry TOP activation refuses the same way: the narrow divider
    // gate above is the sole admission check (no separate activation helper).
    // No TOP request was issued: kind/epoch/anchor offset unchanged.
    expect(c.currentEpoch).toBe(epochBefore)
    expect(c.currentIntent?.kind).toBe('divider')
    expect(c.getAnchorFor(displayed('t1', 'b9'))).toEqual({
      kind: 'divider',
      dividerKey: 'mFork::main',
      offset: 55
    })
    // Historical saved snapshot untouched (TOP never overwrote it).
    expect((keyvStore.get('scroll:topic-t1::b9') as { messageId: string }).messageId).toBe('mHistoric')
    // Shared atomic entry stays generic: the divider hidden fallback still
    // binds this same epoch (proves no global divider disallow).
    expect(c.applyTransitionWindow(epochBefore, { topicId: 't1', route: 'b9' }, wid('divider-hidden'))).toBe(true)
  })

  it('legitimate top/generic/bootstrap sessions are never refused', () => {
    const top = new RouteViewportController(displayed('t1', null))
    top.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b9',
      saved: { scrollTop: -500, messageId: 'mHistoric', intraRowOffset: -30, isAtBottom: false }
    })
    expect(shouldTopPipelineRefuseDividerIntent(top, 't1', 'b9')).toBe(false)

    const generic = new RouteViewportController(displayed('t1', null))
    generic.request({ kind: 'generic', topicId: 't1', targetRoute: 'b9' })
    expect(shouldTopPipelineRefuseDividerIntent(generic, 't1', 'b9')).toBe(false)

    // Foreign-target divider never blocks a different TOP target.
    const foreign = new RouteViewportController(displayed('t1', null))
    foreign.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'bOther',
      dividerKey: 'mFork::main',
      clickOffset: 7
    })
    expect(shouldTopPipelineRefuseDividerIntent(foreign, 't1', 'b9')).toBe(false)
    expect(shouldTopPipelineRefuseDividerIntent(foreign, 't1', 'bOther')).toBe(true)
  })

  it('single-entry TOP never reenters while its own fetch-hold owns the target (no progress retry)', () => {
    // Mirrors the production TOP pipeline single-pipeline guard: an in-flight
    // fetch-hold for the exact target is adopted, never superseded by a
    // second request on a connection-generation/route rerun.
    const c = new RouteViewportController(displayed('t1', null))
    const first = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    expect(c.programmaticOwned).toBe(true)
    expect(c.currentPhase).toBe('fetch-hold')
    // Second TOP entry for the same target while fetch-hold owns it: adopt
    // (same epoch), never a fresh request.
    expect(shouldTopPipelineRefuseDividerIntent(c, 't1', null)).toBe(false)
    const live = c.currentIntent
    const adopted =
      c.programmaticOwned &&
      c.currentPhase === 'fetch-hold' &&
      live !== null &&
      live.topicId === 't1' &&
      live.targetRoute === null &&
      live.kind !== 'divider'
        ? c.currentEpoch
        : null
    expect(adopted).toBe(first.epoch)
    // No second request issued: epoch/kind/anchor unchanged.
    expect(c.currentEpoch).toBe(first.epoch)
    expect(c.currentIntent?.kind).toBe('top')
    expect(c.getAnchorFor(displayed('t1', null))).toEqual({
      kind: 'message',
      messageId: 'm-stable',
      offset: -12
    })
  })

  it('terminal sessions never auto-retry without a fresh activation (fail-closed)', () => {
    // Mirrors the production TOP terminal guard: a released terminal viewport
    // stays until the next genuine selected/connection trigger.
    const c = new RouteViewportController(displayed('t1', null))
    const first = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -400, messageId: 'm-stable', intraRowOffset: -12, isAtBottom: false }
    })
    c.terminate(first.epoch, 'fail-visible')
    expect(c.currentPhase).toBe('terminal')
    expect(c.programmaticOwned).toBe(false)
    expect(c.isActivationRequired).toBe(false)
    // Production TOP entry with no activation refuses terminal (no request).
    const wouldEnter = c.isActivationRequired || c.currentPhase !== 'terminal'
    expect(wouldEnter).toBe(false)
    expect(c.currentEpoch).toBe(first.epoch)
  })
})
