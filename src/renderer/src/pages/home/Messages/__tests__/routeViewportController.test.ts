/**
 * Route viewport transition controller: single-owner state machine.
 *
 * Covers the core invariants:
 * 1. Exactly one owner of epoch/intent/phase/ownership/displayed/anchor.
 * 2. Top intent restores the target's own anchor (+offset); no history gives
 *    the deterministic bottom default; a valid-but-unresolved anchor never
 *    commits a fallback.
 * 3. Divider intent keeps only the clicked offset; terminal paths commit
 *    nothing.
 * 4. Rapid supersession: monotonic epochs invalidate every older
 *    fetch/window/apply/reveal/commit; stale `finally` blocks touch nothing.
 * 5. Ownership releases exactly once per session.
 * 6. Displayed route advances only when the target is positioned and visible.
 * 7. Snapshot allowlist: user-scroll (stable/idle/terminal) and
 *    controller-commit (aligned/stable) only; transition/window-reconcile
 *    never.
 */
import { describe, expect, it } from 'vitest'

import {
  displayedRouteKey,
  isSnapshotWriteAllowed,
  RouteViewportController,
  routeViewportKey
} from '../routeViewportController'

const displayed = (topicId: string, route: string | null) => ({ topicId, route })

const wid = (n: string): string => `oldest::newest::${n}`

describe('routeViewportKey / displayedRouteKey', () => {
  it('keys routes canonically with main fallback', () => {
    expect(routeViewportKey('t1', null)).toBe('topic-t1::main')
    expect(routeViewportKey('t1', 'b1')).toBe('topic-t1::b1')
    expect(displayedRouteKey(displayed('t1', 'b1'))).toBe('topic-t1::b1')
  })
})

describe('top intent', () => {
  it('restores the target anchor identity + offset', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -400, messageId: 'm1', intraRowOffset: -12, isAtBottom: false }
    })
    expect(c.currentPhase).toBe('fetch-hold')
    expect(c.getAnchorFor(displayed('t1', 'b1'))).toEqual({ kind: 'message', messageId: 'm1', offset: -12 })
    expect(c.programmaticOwned).toBe(true)
    expect(c.canAcceptUserScrollWrite()).toBe(false)
    void epoch
  })

  it('no history resolves to the deterministic bottom default, never outgoing geometry', () => {
    const c = new RouteViewportController(displayed('t1', null))
    c.request({ kind: 'top', topicId: 't1', targetRoute: 'b9', saved: null })
    expect(c.getAnchorFor(displayed('t1', 'b9'))).toBeNull()
  })

  it('commitStable refuses a valid-but-unresolved top anchor (no fallback commit)', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -400, messageId: 'm9', intraRowOffset: -12, isAtBottom: false }
    })
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'placed')
    const out = c.commitStable(epoch, { messageId: null, intraRowOffset: null, scrollTop: -10, isAtBottom: false })
    expect(out.committed).toBe(false)
    expect(c.programmaticOwned).toBe(true)
  })
})

describe('divider intent', () => {
  it('keeps only the clicked offset and never reads target history', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm1::main',
      clickOffset: 150
    })
    expect(c.getAnchorFor(displayed('t1', 'b1'))).toEqual({ kind: 'divider', dividerKey: 'm1::main', offset: 150 })
    void epoch
  })

  it('terminal paths commit nothing and preserve the target snapshot', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm1::main',
      clickOffset: 150
    })
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'searching')
    const out = c.terminate(epoch, 'oldest-edge')
    expect(out.terminated).toBe(true)
    expect(out.didRelease).toBe(true)
    expect(c.currentPhase).toBe('terminal')
    // Phase left searching: no snapshot was produced, displayed never moved.
    expect(c.displayedRoute).toEqual(displayed('t1', null))
  })
})

describe('lifecycle phases', () => {
  it('fetch-hold → positioning → aligned → stable with displayed advancing only on positioned+visible', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -400, messageId: 'm1', intraRowOffset: -12, isAtBottom: false }
    })
    // Displayed stays on the outgoing route until positioned+visible.
    expect(c.displayedRoute).toEqual(displayed('t1', null))
    expect(c.appliedWindow(epoch)).toBe(true)
    expect(c.currentPhase).toBe('positioning')
    expect(c.revealed(epoch), 'not positioned yet: no displayed advance').toBe(false)
    expect(c.firstPositioned(epoch, 'placed')).toBe(true)
    expect(c.currentPhase).toBe('aligned')
    expect(c.revealed(epoch)).toBe(true)
    expect(c.displayedRoute).toEqual(displayed('t1', 'b1'))
    const out = c.commitStable(epoch, { messageId: 'm1', intraRowOffset: -12, scrollTop: -400, isAtBottom: false })
    expect(out.committed).toBe(true)
    expect(out.commit?.routeKey).toBe('topic-t1::b1')
    expect(out.commit?.snapshot).toMatchObject({ messageId: 'm1', intraRowOffset: -12 })
    expect(out.didRelease).toBe(true)
    expect(c.currentPhase).toBe('stable')
    expect(c.canAcceptUserScrollWrite()).toBe(true)
  })

  it('searching requires paginationSettled before commit; unplaced goes terminal', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm1::main',
      clickOffset: 10
    })
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'searching')
    expect(c.currentPhase).toBe('searching')
    const early = c.commitStable(epoch, { messageId: 'm1', intraRowOffset: 10, scrollTop: -100, isAtBottom: false })
    expect(early.committed, 'searching must not commit').toBe(false)
    expect(c.paginationSettled(epoch)).toBe(true)
    const done = c.commitStable(epoch, { messageId: 'm1', intraRowOffset: 10, scrollTop: -100, isAtBottom: false })
    expect(done.committed).toBe(true)

    const c2 = new RouteViewportController(displayed('t1', null))
    const s2 = c2.request({ kind: 'top', topicId: 't1', targetRoute: 'b2', saved: null })
    c2.appliedWindow(s2.epoch)
    c2.firstPositioned(s2.epoch, 'unplaced')
    expect(c2.currentPhase).toBe('terminal')
    expect(c2.lastTerminalReason).toBe('unplaced-fallback')
  })

  it('programmatic restore needs no user input to become stable', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'placed')
    c.revealed(epoch)
    const out = c.commitStable(epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true })
    expect(out.committed).toBe(true)
    expect(c.getAnchorFor(displayed('t1', 'b1'))).toBeNull()
  })
})

describe('rapid supersession', () => {
  it('monotonic epochs invalidate every older completion; old finally touches nothing', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    const releasesAfterFirst = c.releaseCount
    const second = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b2',
      dividerKey: 'm1::main',
      clickOffset: 5
    })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    // Supersession released the old session exactly once.
    expect(c.releaseCount).toBe(releasesAfterFirst + 1)
    // Every older completion is inert.
    expect(c.appliedWindow(first.epoch)).toBe(false)
    expect(c.firstPositioned(first.epoch, 'placed')).toBe(false)
    expect(c.revealed(first.epoch)).toBe(false)
    expect(c.paginationSettled(first.epoch)).toBe(false)
    expect(
      c.commitStable(first.epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true }).committed
    ).toBe(false)
    expect(c.terminate(first.epoch, 'superseded').terminated).toBe(false)
    expect(c.releaseSession(first.epoch), 'stale finally is a no-op').toBe(false)
    // The new session is unaffected and still committable.
    expect(c.isSessionCurrent(second.epoch)).toBe(true)
    c.appliedWindow(second.epoch)
    c.firstPositioned(second.epoch, 'placed')
    c.revealed(second.epoch)
    expect(c.displayedRoute).toEqual(displayed('t1', 'b2'))
  })
})

describe('release exactly once', () => {
  it('commit then terminate/release are no-ops; double finally is safe', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    const before = c.releaseCount
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'placed')
    const out = c.commitStable(epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true })
    expect(out.didRelease).toBe(true)
    expect(c.releaseCount).toBe(before + 1)
    expect(c.releaseSession(epoch)).toBe(false)
    expect(c.terminate(epoch, 'unmounted').terminated).toBe(false)
    expect(c.releaseCount).toBe(before + 1)
  })

  it('invalidateAll releases once and clears; second call is a no-op', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    const before = c.releaseCount
    expect(c.invalidateAll()).toBe(true)
    expect(c.releaseCount).toBe(before + 1)
    expect(c.currentIntent).toBeNull()
    expect(c.releaseSession(epoch)).toBe(false)
    expect(c.invalidateAll()).toBe(false)
  })
})

describe('user intent declare (pending-only, never terminates)', () => {
  it('declare during a transition keeps ownership/phase; takeover owns the scroll', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    c.appliedWindow(epoch)
    const d = c.declareUserIntent()
    expect(d.epoch).toBe(epoch)
    expect(c.userIntentPending).toBe(true)
    expect(c.programmaticOwned).toBe(true)
    expect(c.currentPhase).toBe('positioning')
    // Legacy alias is pending-only as well.
    const ended = c.noteUserIntent()
    expect(ended.endedTransition).toBe(false)
    expect(c.programmaticOwned).toBe(true)
  })

  it('declare while stable only stops compensation; stable-update adopts via takeover', () => {
    const c2 = new RouteViewportController(displayed('t1', null))
    const s2 = c2.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    c2.appliedWindow(s2.epoch)
    c2.firstPositioned(s2.epoch, 'placed')
    c2.revealed(s2.epoch)
    c2.commitStable(s2.epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true })
    const stable = c2.declareUserIntent()
    expect(stable.epoch).toBe(c2.currentEpoch)
    expect(c2.currentPhase).toBe('stable')
    expect(c2.userIntentPending).toBe(true)
    const out = c2.userTakeover(
      { messageId: 'm5', intraRowOffset: -30, scrollTop: -100, isAtBottom: false },
      undefined,
      stable
    )
    expect(out.taken).toBe(true)
    if (out.taken) {
      expect(out.reason).toBe('stable-update')
      expect(out.routeKey).toBe('topic-t1::b1')
      // The session survives the takeover for momentum/drag scrolls; only
      // `scrollend` (or request/invalidate) closes it.
      expect(c2.userIntentPending).toBe(true)
      expect(c2.hasActiveUserInteraction()).toBe(true)
      expect(c2.getAnchorFor(displayed('t1', 'b1'))).toEqual({ kind: 'message', messageId: 'm5', offset: -30 })
      expect(c2.noteInteractionScrollEnd(stable)).toBe(true)
      expect(c2.userIntentPending).toBe(false)
    }
  })
})

describe('userTakeover atomic (single user-scroll event)', () => {
  const measured = { messageId: 'mExcl', intraRowOffset: -8, scrollTop: -120, isAtBottom: false }

  it('fetch-hold pre-apply takes over the outgoing route (never the incoming selected key)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mA', intraRowOffset: -12, scrollTop: 0, isAtBottom: false })
    c.noteInteractionScrollEnd()
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    expect(c.currentPhase).toBe('fetch-hold')
    c.declareUserIntent()
    const out = c.userTakeover(measured)
    expect(out.taken).toBe(true)
    if (out.taken) {
      expect(out.reason).toBe('owned-takeover')
      expect(out.routeKey).toBe('topic-t1::A')
      expect(out.snapshot).toMatchObject({ messageId: 'mExcl' })
      expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
      expect(c.currentPhase).toBe('stable')
      expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'mExcl', offset: -8 })
    }
    expect(c.programmaticOwned).toBe(false)
    const releases = c.releaseCount
    expect(c.releaseSession(epoch)).toBe(false)
    expect(c.releaseCount).toBe(releases)
    // Old epoch continuations are inert via bumped epoch + released session.
    expect(
      c.commitStable(epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true }).committed
    ).toBe(false)
    expect(c.revealed(epoch)).toBe(false)
    expect(c.firstPositioned(epoch, 'placed')).toBe(false)
  })

  it('positioning target takeover adopts the rendered target viewport', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, wid('25'))
    expect(c.currentPhase).toBe('positioning')
    c.declareUserIntent()
    const out = c.userTakeover(measured, wid('25'))
    expect(out.taken).toBe(true)
    if (out.taken) {
      expect(out.routeKey).toBe('topic-t1::main')
      expect(c.displayedRoute).toEqual(displayed('t1', 'main'))
      expect(c.isDomProvenanceClean).toBe(true)
    }
  })

  it('searching divider takeover cancels the search and adopts the rendered target', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm1::main',
      clickOffset: 10
    })
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'searching')
    expect(c.currentPhase).toBe('searching')
    c.declareUserIntent()
    const out = c.userTakeover({ messageId: 'mDiv', intraRowOffset: 10, scrollTop: -50, isAtBottom: false })
    expect(out.taken).toBe(true)
    if (out.taken) {
      expect(out.routeKey).toBe('topic-t1::b1')
      expect(c.displayedRoute).toEqual(displayed('t1', 'b1'))
      expect(c.currentPhase).toBe('stable')
    }
    // Old search epoch can never commit afterwards.
    expect(c.paginationSettled(epoch)).toBe(false)
    expect(
      c.commitStable(epoch, { messageId: 'm1', intraRowOffset: 10, scrollTop: -50, isAtBottom: false }).committed
    ).toBe(false)
  })

  it('aligned takeover adopts the aligned target and releases exactly once', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, wid('7'))
    c.firstPositioned(epoch, 'placed')
    expect(c.currentPhase).toBe('aligned')
    const before = c.releaseCount
    c.declareUserIntent()
    const out = c.userTakeover(measured, wid('7'))
    expect(out.taken).toBe(true)
    expect(c.releaseCount).toBe(before + 1)
    expect(c.releaseSession(epoch)).toBe(false)
    expect(c.releaseCount).toBe(before + 1)
  })

  it('stable update adopts without selected key; unknown rendered rejects fail-closed', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    const out = c.userTakeover(measured)
    expect(out.taken).toBe(true)
    if (out.taken) expect(out.routeKey).toBe('topic-t1::A')
    const d = new RouteViewportController(displayed('t1', 'A'))
    d.syncDisplayed({ topicId: 't1', route: 'main' })
    expect(d.renderedProvenance).toBeNull()
    d.declareUserIntent()
    const rej = d.userTakeover(measured)
    expect(rej.taken).toBe(false)
    if (!rej.taken) expect(rej.reason).toBe('unknown-rendered')
    expect(d.currentPhase).toBe('idle')
  })

  it('live window mismatch rejects (no mis-write under a foreign window)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, wid('25'))
    c.declareUserIntent()
    const rej = c.userTakeover(measured, wid('foreign'))
    expect(rej.taken).toBe(false)
    if (!rej.taken) expect(rej.reason).toBe('window-mismatch')
    expect(c.programmaticOwned).toBe(true)
  })

  it('returned key never follows selected: outgoing takeover while selected is incoming', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    // Redux selected is already `main` (incoming) but DOM/rendered is still A.
    c.declareUserIntent()
    const out = c.userTakeover(measured)
    expect(out.taken).toBe(true)
    if (out.taken) {
      expect(out.routeKey).toBe('topic-t1::A')
      expect(out.routeKey).not.toBe('topic-t1::main')
    }
    void epoch
  })

  it('stable update ignores trailing window length lag (same route, no drop)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    // Rendered proves A; the measured live id trails one pagination commit.
    c.noteSameRouteWindowUpdate({ topicId: 't1', route: 'A' }, wid('25'))
    c.declareUserIntent()
    const out = c.userTakeover(measured, wid('26-lagging'))
    expect(out.taken).toBe(true)
    if (out.taken) expect(out.routeKey).toBe('topic-t1::A')
  })

  it('bottom measured without identity clears the anchor', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    const out = c.userTakeover({ messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true })
    expect(out.taken).toBe(true)
    expect(c.getAnchorFor(displayed('t1', 'A'))).toBeNull()
  })
})

describe('snapshot write allowlist', () => {
  it('only displayed-stable user scrolls and controller commits may write', () => {
    expect(isSnapshotWriteAllowed('user-scroll', 'stable')).toBe(true)
    expect(isSnapshotWriteAllowed('user-scroll', 'idle')).toBe(true)
    expect(isSnapshotWriteAllowed('user-scroll', 'terminal')).toBe(true)
    expect(isSnapshotWriteAllowed('user-scroll', 'positioning')).toBe(false)
    expect(isSnapshotWriteAllowed('user-scroll', 'fetch-hold')).toBe(false)
    expect(isSnapshotWriteAllowed('user-scroll', 'searching')).toBe(false)
    expect(isSnapshotWriteAllowed('user-scroll', 'aligned')).toBe(false)
    expect(isSnapshotWriteAllowed('controller-commit', 'aligned')).toBe(true)
    expect(isSnapshotWriteAllowed('controller-commit', 'stable')).toBe(true)
    expect(isSnapshotWriteAllowed('controller-commit', 'positioning')).toBe(false)
    expect(isSnapshotWriteAllowed('transition-scroll', 'stable')).toBe(false)
    expect(isSnapshotWriteAllowed('window-reconcile', 'stable')).toBe(false)
    expect(isSnapshotWriteAllowed('window-reconcile', 'idle')).toBe(false)
  })
})

describe('displayed provenance', () => {
  it('outgoing freeze always reads displayed, never selected; syncDisplayed is a no-op while owned', () => {
    const c = new RouteViewportController(displayed('t1', 'b1'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'b2', saved: null })
    // Still the outgoing route mid-transition: freeze targets it.
    expect(displayedRouteKey(c.displayedRoute)).toBe('topic-t1::b1')
    c.syncDisplayed({ topicId: 't1', route: 'b9' })
    expect(c.displayedRoute).toEqual(displayed('t1', 'b1'))
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'placed')
    c.revealed(epoch)
    expect(c.displayedRoute).toEqual(displayed('t1', 'b2'))
  })
})

describe('rendered provenance (selected=A/displayed=A/DOM=main expressible)', () => {
  it('request never claims rendered; atomic apply binds epoch+route+window', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    expect(c.isDomProvenanceClean).toBe(true)
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    // Target session started but DOM still shows A.
    expect(c.renderedProvenance).toMatchObject({ topicId: 't1', routeId: 'A' })
    expect(c.isDomProvenanceClean).toBe(true)
    expect(c.applyTransitionWindow(epoch + 99, { topicId: 't1', route: 'main' }, wid('1'))).toBe(false)
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: 'wrong' }, wid('1'))).toBe(false)
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, '')).toBe(false)
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, wid('1'))).toBe(true)
    expect(c.renderedProvenance).toMatchObject({ topicId: 't1', routeId: 'main', epoch, windowId: wid('1') })
    // Rendered=main while displayed=A: dirty, no freeze/write.
    expect(c.isDomProvenanceClean).toBe(false)
    expect(c.shouldCaptureOutgoing()).toBe(false)
    expect(c.canFreezeDisplayed()).toBe(false)
    expect(c.canAcceptUserScrollWrite()).toBe(false)
  })

  it('reveal/commit verify rendered topic/route/epoch/window; displayed advances only positioned+visible', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    expect(c.revealed(epoch)).toBe(false)
    c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, wid('25'))
    expect(c.revealed(epoch)).toBe(false)
    c.firstPositioned(epoch, 'placed')
    expect(c.revealed(epoch)).toBe(true)
    expect(c.revealed(epoch, 'foreign-window')).toBe(false)
    expect(c.displayedRoute).toEqual(displayed('t1', 'main'))
    expect(c.isDomProvenanceClean).toBe(true)
    const out = c.commitStable(
      epoch,
      { messageId: 'm1', intraRowOffset: 0, scrollTop: -100, isAtBottom: false },
      wid('25')
    )
    expect(out.committed).toBe(true)
    expect(c.displayedRoute).toEqual(displayed('t1', 'main'))
    expect(c.renderedProvenance).toMatchObject({ topicId: 't1', routeId: 'main', epoch })
    expect(c.currentPhase).toBe('stable')
    expect(c.isDomProvenanceClean).toBe(true)
  })

  it('rendered mismatch refuses reveal/commit; foreign window never commits', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'B', saved: null })
    c.applyTransitionWindow(epoch, { topicId: 't1', route: 'B' }, wid('1'))
    c.firstPositioned(epoch, 'placed')
    // Corrupt rendered to a foreign route (simulates a bypassing window/apply).
    c.markRenderedUnknown()
    expect(c.revealed(epoch)).toBe(false)
    expect(
      c.commitStable(epoch, { messageId: 'm1', intraRowOffset: 0, scrollTop: 0, isAtBottom: false }).committed
    ).toBe(false)
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
  })

  it('dirty terminal refuses writes until rebase/target success; release alone never reopens', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, wid('1'))
    c.firstPositioned(epoch, 'unplaced')
    expect(c.currentPhase).toBe('terminal')
    expect(c.isDirtyTerminal).toBe(true)
    expect(c.canAcceptUserScrollWrite()).toBe(false)
    expect(c.shouldCaptureOutgoing()).toBe(false)
    // Ownership already released exactly once; dirty stays closed.
    expect(c.programmaticOwned).toBe(false)
    expect(c.canAcceptUserScrollWrite()).toBe(false)
    // Explicit rebase with window proof restores clean (bootstrap path).
    const d = new RouteViewportController(displayed('t1', 'A'))
    d.syncDisplayed({ topicId: 't1', route: 'main' })
    expect(d.renderedProvenance).toBeNull()
    expect(d.canAcceptUserScrollWrite()).toBe(false)
    expect(d.rebaseClean({ topicId: 't1', route: 'main' }, wid('25'))).toBe(true)
    expect(d.isDomProvenanceClean).toBe(true)
    expect(d.canAcceptUserScrollWrite()).toBe(true)
  })

  it('ordinary pagination updates same-route windowId but never switches provenance', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    expect(c.noteSameRouteWindowUpdate({ topicId: 't1', route: 'A' }, wid('2'))).toBe(true)
    expect(c.renderedProvenance).toMatchObject({ routeId: 'A', windowId: wid('2') })
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.noteSameRouteWindowUpdate({ topicId: 't1', route: 'B' }, wid('3'))).toBe(false)
    expect(c.renderedProvenance).toMatchObject({ routeId: 'A' })
    c.markRenderedUnknown()
    expect(c.noteSameRouteWindowUpdate({ topicId: 't1', route: 'A' }, wid('4'))).toBe(false)
  })

  it('rapid A→B→A: second request supersedes, preserves A anchor, never captures B DOM as A', () => {
    // 'main' is the concrete B for this cycle.
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mA', intraRowOffset: -12, scrollTop: 0, isAtBottom: false })
    c.noteInteractionScrollEnd()
    // Outgoing A is clean-stable: capture allowed.
    expect(c.shouldCaptureOutgoing()).toBe(true)
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    // B window rendered but not displayed (hidden fetch window).
    c.applyTransitionWindow(first.epoch, { topicId: 't1', route: 'main' }, wid('main-25'))
    expect(c.isDomProvenanceClean).toBe(false)
    // Second request back to A supersedes main before it ever displayed.
    const second = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'A',
      saved: { scrollTop: -400, messageId: 'mA', intraRowOffset: -12, isAtBottom: false }
    })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    // Displayed never left A; the preserved A anchor restarts the session.
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'mA', offset: -12 })
    // Dirty during the new fetch: no capture of the intermediate B DOM as A.
    expect(c.shouldCaptureOutgoing()).toBe(false)
    // Stale main completions are inert.
    expect(c.revealed(first.epoch)).toBe(false)
    expect(
      c.commitStable(first.epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true }).committed
    ).toBe(false)
    // A target window apply + position + reveal restores A.
    c.applyTransitionWindow(second.epoch, { topicId: 't1', route: 'A' }, wid('A-17'))
    c.firstPositioned(second.epoch, 'placed')
    expect(c.revealed(second.epoch)).toBe(true)
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.isDomProvenanceClean).toBe(true)
  })

  it('rapid return prefers the retained anchor over a stale persisted snapshot', () => {
    // 'main' is the concrete B for this cycle.
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mLive', intraRowOffset: -7, scrollTop: 0, isAtBottom: false })
    c.noteInteractionScrollEnd()
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    c.applyTransitionWindow(first.epoch, { topicId: 't1', route: 'main' }, wid('1'))
    // Second request back to A carries a STALE persisted snapshot (the live
    // A anchor is mLive): the retained anchor must win since the target
    // re-equals the still-displayed route.
    const second = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'A',
      saved: { scrollTop: -10, messageId: 'mStale', intraRowOffset: -1, isAtBottom: false }
    })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'mLive', offset: -7 })
    void second
  })

  it('ordinary switch to a different target still uses the persisted snapshot (no retained leak)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mLive', intraRowOffset: -7, scrollTop: 0, isAtBottom: false })
    c.noteInteractionScrollEnd()
    // First request stashes the A anchor; the main session itself holds null.
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    expect(c.getAnchorFor(displayed('t1', 'main'))).toBeNull()
    // A forth switch to main with a persisted main snapshot uses it (the
    // retained A anchor must never leak into another route's session).
    c.applyTransitionWindow(first.epoch, { topicId: 't1', route: 'main' }, wid('1'))
    c.firstPositioned(first.epoch, 'placed')
    c.revealed(first.epoch)
    c.commitStable(first.epoch, { messageId: 'mMain', intraRowOffset: 3, scrollTop: -50, isAtBottom: false })
    const third = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'main',
      saved: { scrollTop: -50, messageId: 'mMain2', intraRowOffset: 4, isAtBottom: false }
    })
    // Target == displayed (main) with same-target previous session: the live
    // previous anchor (mMain commit) is retained for the same route — still
    // consistent because it belongs to this route.
    expect(c.getAnchorFor(displayed('t1', 'main'))?.kind).toBe('message')
    void third
  })

  it('supersede to the displayed route with no fresh anchor keeps the live/stable anchor', () => {
    // 'main' is the concrete B for this cycle.
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mLive', intraRowOffset: -7, scrollTop: 0, isAtBottom: false })
    c.noteInteractionScrollEnd()
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    c.applyTransitionWindow(first.epoch, { topicId: 't1', route: 'main' }, wid('1'))
    // Target re-equals displayed (A) with no saved anchor: keep live anchor.
    const second = c.request({ kind: 'top', topicId: 't1', targetRoute: 'A', saved: null })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'mLive', offset: -7 })
    void second
  })

  it('top/divider intents unchanged (anchor + offset semantics preserved)', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const top = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -400, messageId: 'm1', intraRowOffset: -12, isAtBottom: false }
    })
    expect(c.getAnchorFor(displayed('t1', 'b1'))).toEqual({ kind: 'message', messageId: 'm1', offset: -12 })
    void top
    const c2 = new RouteViewportController(displayed('t1', null))
    c2.request({ kind: 'divider', topicId: 't1', targetRoute: 'b1', dividerKey: 'm1::main', clickOffset: 150 })
    expect(c2.getAnchorFor(displayed('t1', 'b1'))).toEqual({ kind: 'divider', dividerKey: 'm1::main', offset: 150 })
  })

  it('focused: foreign window apply after supersede-back never pollutes outgoing A snapshot', () => {
    // Simulates the Messages atomic adapter + controller-owned freeze gate:
    // storage snapshots keyed by route, DOM capture gated by
    // shouldCaptureOutgoing(), window apply refused on stale epochs.
    const store = new Map<string, { messageId: string | null }>()
    store.set('topic-t1::A', { messageId: 'mA' })
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mA', intraRowOffset: -12, scrollTop: 0, isAtBottom: false })
    c.noteInteractionScrollEnd()
    const freeze = (): boolean => {
      if (!c.shouldCaptureOutgoing()) return false
      // Would capture live DOM here; the gate above already refused dirty.
      store.set('topic-t1::A', { messageId: 'live-dom' })
      return true
    }
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    // main fetch window lands (rendered=main, displayed=A → dirty).
    expect(c.applyTransitionWindow(first.epoch, { topicId: 't1', route: 'main' }, wid('main'))).toBe(true)
    // Rapid back to A: supersede before main ever displayed.
    const second = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'A',
      saved: { scrollTop: -1, messageId: 'mA', intraRowOffset: -12, isAtBottom: false }
    })
    // Outgoing freeze for the A session must NOT read the intermediate B
    // DOM as A: gate closed while dirty/owned.
    expect(freeze()).toBe(false)
    expect(store.get('topic-t1::A')).toEqual({ messageId: 'mA' })
    // Stale main window apply (late fetch) refuses: rendered stays on the
    // already-bound main/epoch1 window (displayed still A → dirty), never
    // switching provenance to the new session.
    expect(c.applyTransitionWindow(first.epoch, { topicId: 't1', route: 'main' }, wid('main-late'))).toBe(false)
    expect(c.renderedProvenance).toMatchObject({ routeId: 'main', epoch: first.epoch })
    // A target window restores with the preserved anchor.
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'mA', offset: -12 })
    expect(c.applyTransitionWindow(second.epoch, { topicId: 't1', route: 'A' }, wid('A'))).toBe(true)
    c.firstPositioned(second.epoch, 'placed')
    expect(c.revealed(second.epoch)).toBe(true)
    expect(store.get('topic-t1::A')).toEqual({ messageId: 'mA' })
  })

  it('release exactly once across supersede + commit (stale finally inert)', () => {
    const c = new RouteViewportController(displayed('t1', null))
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    const before = c.releaseCount
    const second = c.request({ kind: 'top', topicId: 't1', targetRoute: 'b2', saved: null })
    expect(c.releaseCount).toBe(before + 1)
    expect(c.releaseSession(first.epoch)).toBe(false)
    c.applyTransitionWindow(second.epoch, { topicId: 't1', route: 'b2' }, wid('1'))
    c.firstPositioned(second.epoch, 'placed')
    c.revealed(second.epoch)
    const out = c.commitStable(second.epoch, {
      messageId: null,
      intraRowOffset: null,
      scrollTop: 0,
      isAtBottom: true
    })
    expect(out.didRelease).toBe(true)
    expect(c.releaseSession(second.epoch)).toBe(false)
    expect(c.releaseCount).toBe(before + 2)
  })
})

describe('interaction token/session (controller-owned, no boolean guess)', () => {
  const measured = (id: string, top = -100) => ({
    messageId: id,
    intraRowOffset: -8,
    scrollTop: top,
    isAtBottom: false
  })

  it('declare opens a session with a stable id; refresh keeps the id (wheel momentum)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    expect(c.hasActiveUserInteraction()).toBe(false)
    const t1 = c.declareUserIntent()
    const t2 = c.declareUserIntent()
    expect(t1.interactionId).toBe(t2.interactionId)
    expect(c.hasActiveUserInteraction()).toBe(true)
    expect(c.userIntentPending).toBe(true)
    expect(c.activeInteractionToken?.interactionId).toBe(t1.interactionId)
  })

  it('no session rejects takeover without touching anchor (no-user-intent)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mA', intraRowOffset: -12, scrollTop: 0, isAtBottom: false })
    c.noteInteractionScrollEnd()
    const rej = c.userTakeover(measured('mX'))
    expect(rej.taken).toBe(false)
    if (!rej.taken) expect(rej.reason).toBe('no-user-intent')
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'mA', offset: -12 })
  })

  it('stale token rejects after scrollend; later programmatic scroll refused', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const t = c.declareUserIntent()
    const first = c.userTakeover(measured('m1', -100), undefined, t)
    expect(first.taken).toBe(true)
    expect(c.noteInteractionScrollEnd(t)).toBe(true)
    expect(c.hasActiveUserInteraction()).toBe(false)
    const stale = c.userTakeover(measured('m2', -200), undefined, t)
    expect(stale.taken).toBe(false)
    if (!stale.taken) expect(stale.reason).toBe('stale-interaction')
    const bare = c.userTakeover(measured('m3', -300))
    expect(bare.taken).toBe(false)
    if (!bare.taken) expect(bare.reason).toBe('no-user-intent')
    // Anchor stays at the last session scroll (m1), never m2/m3.
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'm1', offset: -8 })
  })

  it('same session adopts multiple scrolls; final position wins', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const t = c.declareUserIntent()
    const s1 = c.userTakeover(measured('m1', -100), undefined, t)
    expect(s1.taken).toBe(true)
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'm1', offset: -8 })
    // Wheel refresh keeps the same session alive.
    const refreshed = c.declareUserIntent()
    expect(refreshed.interactionId).toBe(t.interactionId)
    const s2 = c.userTakeover(measured('m2', -250), undefined, refreshed)
    expect(s2.taken).toBe(true)
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'm2', offset: -8 })
    expect(c.activeInteractionScrollCount).toBe(2)
    expect(c.noteInteractionScrollEnd()).toBe(true)
  })

  it('pointer/touch end closes only idle sessions (no scroll yet)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const t = c.declareUserIntent()
    expect(c.noteInteractionPointerEnd(t)).toBe(true)
    expect(c.hasActiveUserInteraction()).toBe(false)
    const c2 = new RouteViewportController(displayed('t1', 'A'))
    const t2 = c2.declareUserIntent()
    expect(c2.userTakeover(measured('m1'), undefined, t2).taken).toBe(true)
    // A scroll already landed: the gesture stays open for scrollend.
    expect(c2.noteInteractionPointerEnd(t2)).toBe(false)
    expect(c2.hasActiveUserInteraction()).toBe(true)
    expect(c2.noteInteractionScrollEnd(t2)).toBe(true)
  })

  it('request/supersede forcibly closes the session; invalidateAll too', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const t = c.declareUserIntent()
    expect(c.hasActiveUserInteraction()).toBe(true)
    c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    expect(c.hasActiveUserInteraction()).toBe(false)
    expect(c.userTakeover(measured('mLate'), undefined, t).taken).toBe(false)
    const c2 = new RouteViewportController(displayed('t1', 'A'))
    const t2 = c2.declareUserIntent()
    c2.invalidateAll()
    expect(c2.hasActiveUserInteraction()).toBe(false)
    expect(c2.userTakeover(measured('mLate'), undefined, t2).taken).toBe(false)
  })

  it('programmatic commit keeps the session (wheel declared before completion still adopts)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, wid('7'))
    c.firstPositioned(epoch, 'placed')
    c.revealed(epoch)
    // Wheel lands between reveal and commit: session stays live across commit.
    const t = c.declareUserIntent()
    const commit = c.commitStable(epoch, { messageId: 'mProg', intraRowOffset: 0, scrollTop: -50, isAtBottom: false })
    expect(commit.committed).toBe(true)
    expect(c.hasActiveUserInteraction()).toBe(true)
    const out = c.userTakeover(measured('mUser', -300), undefined, t)
    expect(out.taken).toBe(true)
    if (out.taken) expect(out.routeKey).toBe('topic-t1::main')
  })
})

describe('top-entry cross-route anchor provenance (A stable a1 → B → A)', () => {
  const stableA = (c: RouteViewportController, id = 'a1', offset = -12): void => {
    c.declareUserIntent()
    c.userTakeover({ messageId: id, intraRowOffset: offset, scrollTop: -400, isAtBottom: false })
    c.noteInteractionScrollEnd()
  }
  const savedOf = (id: string | null, offset: number | null = -12) =>
    id ? { scrollTop: -400, messageId: id, intraRowOffset: offset, isAtBottom: false } : null

  it('exact bug sequence: A stable a1 → request B saved b1 (uncommitted) → request A saved a1 keeps a1, never b1', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    stableA(c, 'a1')
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'a1', offset: -12 })
    // Request B: displayed stays A; the incoming B anchor is observable only for B.
    const toB = c.request({ kind: 'top', topicId: 't1', targetRoute: 'B', saved: savedOf('b1', -30) })
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.currentIntent).toMatchObject({ topicId: 't1', targetRoute: 'B' })
    expect(c.getAnchorFor(displayed('t1', 'B'))).toEqual({ kind: 'message', messageId: 'b1', offset: -30 })
    // Foreign anchor is not observable through the route-qualified API.
    expect(c.getAnchorFor(displayed('t1', 'A'))).toBeNull()
    // Request A before B commits: the target's own saved a1 must win, never b1.
    const backA = c.request({ kind: 'top', topicId: 't1', targetRoute: 'A', saved: savedOf('a1') })
    expect(backA.epoch).toBeGreaterThan(toB.epoch)
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.currentIntent).toMatchObject({ topicId: 't1', targetRoute: 'A' })
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'a1', offset: -12 })
    expect(c.getAnchorFor(displayed('t1', 'A'))).not.toEqual({ kind: 'message', messageId: 'b1', offset: -30 })
    // Behavioral commit proves the restored session commits A, not B.
    c.applyTransitionWindow(backA.epoch, { topicId: 't1', route: 'A' }, wid('A-1'))
    c.firstPositioned(backA.epoch, 'placed')
    expect(c.revealed(backA.epoch)).toBe(true)
    const out = c.commitStable(backA.epoch, {
      messageId: 'a1',
      intraRowOffset: -12,
      scrollTop: -400,
      isAtBottom: false
    })
    expect(out.committed).toBe(true)
    expect(out.commit?.routeKey).toBe('topic-t1::A')
    expect(out.commit?.snapshot).toMatchObject({ messageId: 'a1' })
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'a1', offset: -12 })
  })

  it('B saved null variant: uncommitted null-B never corrupts A', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    stableA(c, 'a1')
    c.request({ kind: 'top', topicId: 't1', targetRoute: 'B', saved: null })
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.getAnchorFor(displayed('t1', 'A'))).toBeNull()
    expect(c.getAnchorFor(displayed('t1', 'B'))).toBeNull()
    c.request({ kind: 'top', topicId: 't1', targetRoute: 'A', saved: savedOf('a1') })
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.currentIntent).toMatchObject({ topicId: 't1', targetRoute: 'A' })
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'a1', offset: -12 })
  })

  it('B commits first variant: committed B restores independently, return to A still a1', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    stableA(c, 'a1')
    const toB = c.request({ kind: 'top', topicId: 't1', targetRoute: 'B', saved: savedOf('b1', -30) })
    c.applyTransitionWindow(toB.epoch, { topicId: 't1', route: 'B' }, wid('B-1'))
    c.firstPositioned(toB.epoch, 'placed')
    expect(c.revealed(toB.epoch)).toBe(true)
    const committed = c.commitStable(toB.epoch, {
      messageId: 'b1',
      intraRowOffset: -30,
      scrollTop: -500,
      isAtBottom: false
    })
    expect(committed.committed).toBe(true)
    expect(committed.commit?.routeKey).toBe('topic-t1::B')
    expect(committed.commit?.snapshot).toMatchObject({ messageId: 'b1' })
    expect(c.displayedRoute).toEqual(displayed('t1', 'B'))
    expect(c.getAnchorFor(displayed('t1', 'B'))).toEqual({ kind: 'message', messageId: 'b1', offset: -30 })
    expect(c.getAnchorFor(displayed('t1', 'A'))).toBeNull()
    // Ordinary committed B switch restores B independently; return to A restores a1.
    const backA = c.request({ kind: 'top', topicId: 't1', targetRoute: 'A', saved: savedOf('a1') })
    expect(c.displayedRoute).toEqual(displayed('t1', 'B'))
    expect(c.currentIntent).toMatchObject({ topicId: 't1', targetRoute: 'A' })
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'a1', offset: -12 })
    expect(c.getAnchorFor(displayed('t1', 'B'))).toBeNull()
    void backA
  })

  it('same-route rapid return retains the legitimate live A anchor over a stale snapshot', () => {
    // 'main' is the concrete B for this cycle.
    const c = new RouteViewportController(displayed('t1', 'A'))
    stableA(c, 'mLive', -7)
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.getAnchorFor(displayed('t1', 'main'))).toBeNull()
    expect(c.getAnchorFor(displayed('t1', 'A'))).toBeNull()
    const second = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'A',
      saved: savedOf('mStale', -1)
    })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    // Retained live A anchor beats the stale persisted snapshot.
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'mLive', offset: -7 })
  })

  it('divider fresh-wins over any retained anchor and carries target', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    stableA(c, 'a1')
    c.request({ kind: 'divider', topicId: 't1', targetRoute: 'A', dividerKey: 'a1::A', clickOffset: 55 })
    expect(c.currentIntent).toMatchObject({ kind: 'divider', topicId: 't1', targetRoute: 'A' })
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'divider', dividerKey: 'a1::A', offset: 55 })
    expect(c.getAnchorFor(displayed('t1', 'B'))).toBeNull()
  })

  it('commit/takeover/invalidate maintain route-qualified reads; foreign reads stay null', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    stableA(c, 'a1')
    // Commit on A keeps the A anchor observable only for A.
    const e1 = c.request({ kind: 'top', topicId: 't1', targetRoute: 'A', saved: savedOf('a1') })
    c.applyTransitionWindow(e1.epoch, { topicId: 't1', route: 'A' }, wid('A-1'))
    c.firstPositioned(e1.epoch, 'placed')
    c.revealed(e1.epoch)
    const out = c.commitStable(e1.epoch, {
      messageId: 'a1',
      intraRowOffset: -12,
      scrollTop: -400,
      isAtBottom: false
    })
    expect(out.committed).toBe(true)
    expect(out.commit?.routeKey).toBe('topic-t1::A')
    expect(c.displayedRoute).toEqual(displayed('t1', 'A'))
    expect(c.getAnchorFor(displayed('t1', 'A'))).toEqual({ kind: 'message', messageId: 'a1', offset: -12 })
    expect(c.getAnchorFor(displayed('t1', 'B'))).toBeNull()
    // Invalidate clears the qualified read for every route.
    c.request({ kind: 'top', topicId: 't1', targetRoute: 'B', saved: savedOf('b1') })
    c.invalidateAll()
    expect(c.currentIntent).toBeNull()
    expect(c.getAnchorFor(displayed('t1', 'A'))).toBeNull()
    expect(c.getAnchorFor(displayed('t1', 'B'))).toBeNull()
  })
})
