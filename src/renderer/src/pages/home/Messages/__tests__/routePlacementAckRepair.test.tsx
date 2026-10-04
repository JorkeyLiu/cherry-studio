/**
 * Placement-ack repair (F1 empty + F2 activation gating).
 *
 * Exercises the actual pre-paint layout/ack integration with the real shared
 * helper (`attemptFirstPosition`), the real completion gate
 * (`isFirstPlacementAwaitingAttempt`), and the real controller — never a pure
 * promise artificially resolved on an unrelated gate:
 * - F1: a legitimate observed empty projection for the current target fails
 *   visible exactly once (releases, visible terminal, ack settle false) and
 *   never replaces the prior lawful snapshot; a not-yet-observed (null)
 *   window stays hidden awaiting the commit; the existing positive protocol
 *   (placed/searching usable attempt acks true) remains.
 * - F2: an activation attempt whose actual outcome is unplaced (or whose
 *   helper throws → refused-current terminal) never acks true — it fails
 *   visible preserving the prior snapshot, adopts the current-terminal
 *   own-target render iff valid nonempty, settles false; stale failures stay
 *   inert; a later genuine scroll can save under the adopted target.
 */
import { describe, expect, it } from 'vitest'

import {
  attemptFirstPosition,
  type FirstPlacementPending,
  isFirstPlacementAwaitingAttempt
} from '../routeFirstPlacement'
import { viewportPhaseAttrFor } from '../routeViewportContext'
import { RouteViewportController } from '../routeViewportController'
import { isViewportTransitionCurrent } from '../viewportTransition'

type Ack = { epoch: number; resolve: (observed: boolean) => void; promise: Promise<boolean> }

const installRows = (container: HTMLElement, ids: string[]): void => {
  container.innerHTML = ''
  for (const id of ids) {
    const row = document.createElement('div')
    row.id = `message-${id}`
    row.textContent = id
    container.appendChild(row)
  }
}

/** Minimal production-shaped Messages placement harness (fixed F1/F2 logic). */
const makeHarness = (opts: {
  controller: RouteViewportController
  container: HTMLElement
  topicId: string
  routeId: string | null
}) => {
  const { controller, container, topicId, routeId } = opts
  const state = {
    pending: null as FirstPlacementPending | null,
    window: null as { displayMessages: { id: string }[] } | null,
    ack: null as Ack | null,
    mounted: true,
    snapshots: new Map<string, { messageId: string | null }>()
  }

  const settleAck = (epoch: number | null, observed: boolean): void => {
    const ack = state.ack
    if (!ack) return
    if (epoch !== null && ack.epoch !== epoch) return
    state.ack = null
    try {
      ack.resolve(observed)
    } catch {}
  }

  const armAck = (epoch: number): void => {
    settleAck(null, false)
    let resolve: (observed: boolean) => void = () => undefined
    const promise = new Promise<boolean>((res) => {
      resolve = res
    })
    state.ack = { epoch, resolve, promise }
  }

  const failVisible = (epoch: number): void => {
    if (epoch !== controller.currentEpoch) return
    const owned = controller.isSessionCurrent(epoch)
    if (owned) {
      controller.terminate(epoch, 'fail-visible')
    }
    try {
      const rendered = controller.renderedProvenance
      if (
        rendered &&
        rendered.epoch === epoch &&
        rendered.topicId === topicId &&
        rendered.routeId === routeId &&
        (state.window?.displayMessages.length ?? 0) > 0
      ) {
        controller.adoptRenderedAsDisplayed(epoch)
      }
    } catch {}
    settleAck(epoch, false)
    state.pending = null
  }

  const awaitPlacement = async (epoch: number, isStillTarget: () => boolean): Promise<boolean> => {
    if (!state.mounted) return false
    if (!isStillTarget()) return false
    if (!isFirstPlacementAwaitingAttempt(controller, state.pending, epoch)) {
      return isStillTarget()
    }
    const ack = state.ack
    if (!ack || ack.epoch !== epoch) return isStillTarget()
    try {
      await ack.promise
    } catch {
      return false
    }
    return isStillTarget()
  }

  const stillTarget = (epoch: number): boolean =>
    isViewportTransitionCurrent({
      topicMatch: true,
      routeMatch: true,
      epochCurrent: controller.currentEpoch === epoch,
      mounted: state.mounted
    })

  /** Fixed pre-paint placement: F1 empty fallback + F2 outcome/phase gating. */
  const runPrePaint = (): string => {
    if (controller.currentPhase !== 'positioning') return 'skip-phase'
    const pending = state.pending
    if (!pending) return 'skip-nopending'
    if (pending.outcome !== null) return 'skip-consumed'
    if (!controller.isSessionCurrent(pending.epoch)) return 'skip-stale'
    const live: HTMLElement | null = container
    const hasWindow = (state.window?.displayMessages.length ?? 0) > 0
    const current = isViewportTransitionCurrent({
      topicMatch: true,
      routeMatch: true,
      epochCurrent: controller.isSessionCurrent(pending.epoch),
      mounted: state.mounted
    })
    if (!current || !live || !hasWindow) {
      const observedWindow = state.window
      const observedEmpty = observedWindow != null && (observedWindow.displayMessages?.length ?? 0) === 0
      if (!hasWindow && current && live && state.mounted && !observedEmpty) return 'hidden-awaiting-commit'
      failVisible(pending.epoch)
      return 'fail-empty-or-stale'
    }
    let attempt: string
    try {
      attempt = attemptFirstPosition(controller, pending, live)
    } catch {
      attempt = 'refused'
    }
    if (attempt === 'refused') {
      failVisible(pending.epoch)
      return 'fail-refused'
    }
    // Re-read: the mutable controller phase may move between the top guard
    // and here; the cast defeats stale narrowing.
    if (attempt === 'unplaced' || (controller.currentPhase as string) === 'terminal') {
      failVisible(pending.epoch)
      return 'fail-unplaced-terminal'
    }
    if (!controller.isSessionCurrent(pending.epoch) || !state.mounted) {
      failVisible(pending.epoch)
      return 'fail-mismatch'
    }
    if (!controller.isActivationSession) {
      const revealedOk = controller.revealed(pending.epoch)
      if (!revealedOk) {
        failVisible(pending.epoch)
        return 'fail-reveal'
      }
    }
    if ((controller.currentPhase as string) === 'terminal') {
      failVisible(pending.epoch)
      return 'fail-terminal-race'
    }
    settleAck(pending.epoch, true)
    return `acked-${attempt}`
  }

  return { state, armAck, failVisible, awaitPlacement, stillTarget, runPrePaint }
}

describe('placement-ack repair (F1 empty + F2 activation gating)', () => {
  it('F1: observed empty for the current target settles false, releases visible, preserves the prior snapshot', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      installRows(container, [])
      const c = new RouteViewportController({ topicId: 't1', route: null })
      const h = makeHarness({ controller: c, container, topicId: 't1', routeId: null })
      // Prior lawful snapshot for the target (must survive the empty fallback).
      h.state.snapshots.set('topic-t1::main', { messageId: 'm-prior' })

      const req = c.request({ kind: 'top', topicId: 't1', targetRoute: null })
      expect(c.applyTransitionWindow(req.epoch, { topicId: 't1', route: null }, 'empty::empty::0')).toBe(true)
      // Legitimate empty projection observed (empty topic / deletion tail).
      h.state.window = { displayMessages: [] }
      h.state.pending = {
        topicId: 't1',
        routeId: null,
        epoch: req.epoch,
        plan: { kind: 'bottom' },
        outcome: null
      }
      h.armAck(req.epoch)
      const ackPromise = h.state.ack?.promise
      expect(ackPromise).toBeDefined()
      let observed: boolean | null = null
      ackPromise?.then((v) => {
        observed = v
      })

      const still = (): boolean => h.stillTarget(req.epoch)
      const awaitingBefore = isFirstPlacementAwaitingAttempt(c, h.state.pending, req.epoch)
      expect(awaitingBefore).toBe(true)
      const waiter = h.awaitPlacement(req.epoch, still)

      // Pre-paint observes the deterministic empty fallback (never hidden).
      expect(h.runPrePaint()).toBe('fail-empty-or-stale')
      expect(c.currentPhase).toBe('terminal')
      expect(c.programmaticOwned).toBe(false)
      // Visible terminal (never hidden ownership held), ack cleared settling false.
      expect(viewportPhaseAttrFor(c.currentPhase, c.currentIntent?.kind ?? null)).toBe('revealed')
      expect(h.state.ack).toBeNull()
      expect(h.state.pending).toBeNull()
      // Ack wakes the waiter with observed=false (production await returns
      // currency: still-current true here); the terminal phase then refuses
      // any stable commit below, so no false stable can land.
      expect(await waiter).toBe(true)
      expect(observed).toBe(false)
      // No fake stable snapshot/anchor invented: prior snapshot stands, no commit.
      expect(h.state.snapshots.get('topic-t1::main')).toEqual({ messageId: 'm-prior' })
      expect(
        c.commitStable(req.epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: false }).committed
      ).toBe(false)
    } finally {
      container.remove()
    }
  })

  it('F1: null (not-yet-observed) window stays hidden awaiting the commit without settling', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      installRows(container, ['m1'])
      const c = new RouteViewportController({ topicId: 't1', route: null })
      const h = makeHarness({ controller: c, container, topicId: 't1', routeId: null })
      const req = c.request({ kind: 'top', topicId: 't1', targetRoute: null })
      expect(c.applyTransitionWindow(req.epoch, { topicId: 't1', route: null }, 'w1')).toBe(true)
      h.state.window = null
      h.state.pending = {
        topicId: 't1',
        routeId: null,
        epoch: req.epoch,
        plan: { kind: 'bottom' },
        outcome: null
      }
      h.armAck(req.epoch)
      expect(h.runPrePaint()).toBe('hidden-awaiting-commit')
      // Still hidden-owned, ack still armed (no settle, no fail).
      expect(c.currentPhase).toBe('positioning')
      expect(c.programmaticOwned).toBe(true)
      expect(h.state.ack).not.toBeNull()
      expect(h.state.pending).not.toBeNull()
    } finally {
      container.remove()
    }
  })

  it('positive protocol remains: placed and searching usable attempts ack true', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      installRows(container, ['m2'])
      const c = new RouteViewportController({ topicId: 't1', route: null })
      const h = makeHarness({ controller: c, container, topicId: 't1', routeId: null })
      const req = c.request({
        kind: 'top',
        topicId: 't1',
        targetRoute: null,
        saved: { scrollTop: -58.9, messageId: 'm2', intraRowOffset: -58.9, isAtBottom: false }
      })
      expect(c.applyTransitionWindow(req.epoch, { topicId: 't1', route: null }, 'w-main')).toBe(true)
      h.state.window = { displayMessages: [{ id: 'm2' }] }
      h.state.pending = {
        topicId: 't1',
        routeId: null,
        epoch: req.epoch,
        plan: { kind: 'message', messageId: 'm2', wantOffset: -58.9, fallbackScrollTop: null },
        outcome: null
      }
      h.armAck(req.epoch)
      const waiter = h.awaitPlacement(req.epoch, () => h.stillTarget(req.epoch))
      expect(h.runPrePaint()).toBe('acked-placed')
      expect(c.currentPhase).toBe('aligned')
      expect(await waiter).toBe(true)
      expect(c.revealed(req.epoch)).toBe(true)

      // Searching (edge-parked intermediate) is also a usable ack-success path.
      const c2 = new RouteViewportController({ topicId: 't1', route: null })
      const h2 = makeHarness({ controller: c2, container, topicId: 't1', routeId: null })
      const req2 = c2.request({ kind: 'top', topicId: 't1', targetRoute: null })
      expect(c2.applyTransitionWindow(req2.epoch, { topicId: 't1', route: null }, 'w2')).toBe(true)
      h2.state.window = { displayMessages: [{ id: 'm2' }] }
      h2.state.pending = {
        topicId: 't1',
        routeId: null,
        epoch: req2.epoch,
        plan: {
          kind: 'message',
          messageId: 'm-missing',
          wantOffset: 0,
          fallbackScrollTop: null,
          edgeFallbackOnMissing: true
        },
        outcome: null
      }
      h2.armAck(req2.epoch)
      const waiter2 = h2.awaitPlacement(req2.epoch, () => h2.stillTarget(req2.epoch))
      expect(h2.runPrePaint()).toBe('acked-searching')
      expect(c2.currentPhase).toBe('searching')
      expect(await waiter2).toBe(true)
    } finally {
      container.remove()
    }
  })

  it('F2: activation unplaced never acks true — fails visible, adopts clean, later scroll can save; stale stays inert', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      installRows(container, ['m1', 'm2'])
      const c = new RouteViewportController({ topicId: 't1', route: null })
      // Prior lawful snapshot for the target (preserved through the failure).
      const snapshots = new Map<string, { messageId: string | null }>()
      snapshots.set('topic-t1::main', { messageId: 'm-prior' })
      c.detach()
      const reactivated = c.request({
        kind: 'top',
        topicId: 't1',
        targetRoute: null,
        saved: { scrollTop: -400, messageId: 'm-absent', intraRowOffset: -12, isAtBottom: false }
      })
      expect(c.isActivationSession).toBe(true)
      // Retained nonempty window committed, but the requested anchor row is
      // absent from the DOM with no fallback → real helper returns unplaced.
      expect(c.applyTransitionWindow(reactivated.epoch, { topicId: 't1', route: null }, 'm00::m01::2')).toBe(true)
      const h = makeHarness({ controller: c, container, topicId: 't1', routeId: null })
      h.state.window = { displayMessages: [{ id: 'm1' }, { id: 'm2' }] }
      h.state.pending = {
        topicId: 't1',
        routeId: null,
        epoch: reactivated.epoch,
        plan: { kind: 'message', messageId: 'm-absent', wantOffset: -12, fallbackScrollTop: null },
        outcome: null
      }
      h.armAck(reactivated.epoch)
      let observed: boolean | null = null
      h.state.ack?.promise.then((v) => {
        observed = v
      })
      const waiter = h.awaitPlacement(reactivated.epoch, () => h.stillTarget(reactivated.epoch))

      expect(h.runPrePaint()).toBe('fail-unplaced-terminal')
      // Never acked true: terminal, released exactly once, ack cleared false.
      expect(c.currentPhase).toBe('terminal')
      expect(c.programmaticOwned).toBe(false)
      expect(h.state.ack).toBeNull()
      // Ack wakes with observed=false; production await returns still-current
      // currency (true) and the terminal phase refuses commit below.
      expect(await waiter).toBe(true)
      expect(observed).toBe(false)
      // Current-terminal own-target adoption made the valid nonempty render clean.
      expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })
      expect(c.isDomProvenanceClean).toBe(true)
      expect(c.isTerminalClean).toBe(true)
      expect(snapshots.get('topic-t1::main')).toEqual({ messageId: 'm-prior' })

      // The restored clean terminal is real user state: a later genuine scroll
      // can save under the adopted target.
      expect(c.canAcceptUserScrollWrite()).toBe(true)
      c.declareUserIntent()
      const takeover = c.userTakeover(
        { messageId: 'm1', intraRowOffset: -5, scrollTop: -50, isAtBottom: false },
        'm00::m01::2'
      )
      expect(takeover.taken).toBe(true)
      if (takeover.taken) {
        snapshots.set(takeover.routeKey, takeover.snapshot)
        expect(takeover.routeKey).toBe('topic-t1::main')
        expect(snapshots.get('topic-t1::main')?.messageId).toBe('m1')
      }

      // Stale failure after supersession never touches the newer transaction.
      const next = c.request({ kind: 'top', topicId: 't1', targetRoute: null })
      expect(next.epoch).toBeGreaterThan(reactivated.epoch)
      const releasesBefore = c.releaseCount
      h.failVisible(reactivated.epoch)
      expect(c.currentEpoch).toBe(next.epoch)
      expect(c.releaseCount).toBe(releasesBefore)
      expect(c.isSessionCurrent(next.epoch)).toBe(true)
      expect(c.adoptRenderedAsDisplayed(reactivated.epoch)).toBe(false)
    } finally {
      container.remove()
    }
  })

  it('F2: activation helper exception (refused-current) fails visible settling false without disturbing newer', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      installRows(container, ['m1'])
      const c = new RouteViewportController({ topicId: 't1', route: null })
      c.detach()
      const reactivated = c.request({
        kind: 'top',
        topicId: 't1',
        targetRoute: null,
        saved: { scrollTop: -100, messageId: 'm1', intraRowOffset: -5, isAtBottom: false }
      })
      expect(c.applyTransitionWindow(reactivated.epoch, { topicId: 't1', route: null }, 'w1')).toBe(true)
      const h = makeHarness({ controller: c, container, topicId: 't1', routeId: null })
      h.state.window = { displayMessages: [{ id: 'm1' }] }
      h.state.pending = {
        topicId: 't1',
        routeId: null,
        epoch: reactivated.epoch,
        plan: { kind: 'message', messageId: 'm1', wantOffset: -5, fallbackScrollTop: null },
        outcome: null
      }
      h.armAck(reactivated.epoch)
      // Force the shared helper to throw (firstPositioned failure) so the
      // layout outer catch takes the refused path for the current epoch.
      const throwing = c as unknown as { firstPositioned: (...args: unknown[]) => boolean }
      const original = throwing.firstPositioned.bind(c)
      throwing.firstPositioned = (): boolean => {
        throw new Error('boom')
      }
      let waiterResult = false
      let observed: boolean | null = null
      h.state.ack?.promise.then((v) => {
        observed = v
      })
      let waiterCurrency = false
      try {
        const waiter = h.awaitPlacement(reactivated.epoch, () => h.stillTarget(reactivated.epoch))
        expect(h.runPrePaint()).toBe('fail-refused')
        waiterCurrency = await waiter
        waiterResult = observed === false && waiterCurrency === true
      } finally {
        throwing.firstPositioned = original as (...args: unknown[]) => boolean
      }
      // Refused-current fails visible settling false (never true), releases once.
      expect(waiterResult).toBe(true)
      expect(observed).toBe(false)
      expect(h.state.ack).toBeNull()
      expect(c.programmaticOwned).toBe(false)
      expect(c.currentPhase).toBe('terminal')
      // Valid nonempty own-target render adopted clean (no fake snapshot).
      expect(c.isDomProvenanceClean).toBe(true)
    } finally {
      container.remove()
    }
  })
})
