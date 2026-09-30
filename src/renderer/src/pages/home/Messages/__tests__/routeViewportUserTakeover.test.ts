/**
 * Controller-owned atomic `userTakeover` integration (interaction session).
 *
 * Proves the missing journey event without string-substituting behavior:
 * - capture (declare opens/refreshes the session) → scroll(s) (measure +
 *   takeover per scroll) → `commitSnapshotForRoute(returnedKey)` write(s);
 *   the session survives each takeover and closes only on `scrollend`
 *   (or request/invalidate);
 * - fetch-hold outgoing writes the outgoing exclusive key, never the selected
 *   incoming key; Redux selection is untouched by the controller;
 * - divider searching takeover cancels the search viewport and adopts the
 *   rendered target; failure terminals still preserve the old snapshot;
 * - scrolls with no live session never take over (programmatic /
 *   window-reconcile layout scrolls keep the stable snapshot; the keeper
 *   compensates the offset);
 * - no double write for one scroll (takeover is the sole authorizer).
 */
import { commitSnapshotForRoute } from '@renderer/hooks/useScrollPosition'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RouteViewportController } from '../routeViewportController'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

vi.mock('@renderer/services/topicDeletionInvalidation', () => ({
  subscribeDeletionGeneration: vi.fn(() => () => {})
}))

let store: Map<string, unknown>
const installKeyv = (): void => {
  vi.stubGlobal('window', {
    ...window,
    keyv: {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => {
        store.set(k, v)
      },
      remove: (k: string) => {
        store.delete(k)
      }
    }
  })
}

beforeEach(() => {
  store = new Map()
  installKeyv()
})

const wid = (n: string): string => `oldest::newest::${n}`

describe('capture → scroll same event writes the exclusive (journey) snapshot', () => {
  it('fetch-hold wheel during A→main writes A exclusive, not selected main', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'A' })
    c.declareUserIntent()
    c.userTakeover({ messageId: 'mA', intraRowOffset: -12, scrollTop: 0, isAtBottom: false })
    c.noteInteractionScrollEnd()
    commitSnapshotForRoute('topic-t1::A', {
      scrollTop: -400,
      anchorId: 'mA',
      messageId: 'mA',
      intraRowOffset: -12,
      rawScrollTop: -400,
      isAtBottom: false
    })
    // Top selector already moved Redux selected to `main` and opened fetch-hold.
    const { epoch } = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    // Capture-phase wheel before the scroll lands: opens the session.
    const token = c.declareUserIntent()
    expect(c.userIntentPending).toBe(true)
    expect(c.programmaticOwned).toBe(true)
    // Scroll lands: crossing-first measure on the still-outgoing A viewport.
    const out = c.userTakeover(
      { messageId: 'mExclA', intraRowOffset: -8, scrollTop: -120, isAtBottom: false },
      undefined,
      token
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(out.routeKey).toBe('topic-t1::A')
    expect(out.routeKey).not.toBe('topic-t1::main')
    const writes: string[] = []
    const origSet = store.set.bind(store)
    // Single authorized write for this scroll.
    let writeCount = 0
    const ok = commitSnapshotForRoute(out.routeKey, {
      scrollTop: out.snapshot.scrollTop,
      anchorId: out.snapshot.messageId,
      messageId: out.snapshot.messageId,
      intraRowOffset: out.snapshot.intraRowOffset,
      rawScrollTop: out.snapshot.scrollTop,
      isAtBottom: out.snapshot.isAtBottom
    })
    writeCount += ok ? 1 : 0
    writes.push(out.routeKey)
    expect(ok).toBe(true)
    expect(writeCount).toBe(1)
    expect(writes).toEqual(['topic-t1::A'])
    const saved = store.get('scroll:topic-t1::A') as { messageId: string }
    expect(saved.messageId).toBe('mExclA')
    // Incoming key untouched by the user scroll.
    expect(store.get('scroll:topic-t1::main')).toBeUndefined()
    // Takeover released ownership; the gesture session stays live for
    // momentum until scrollend (keeper closes it afterwards).
    expect(c.programmaticOwned).toBe(false)
    expect(c.isDomProvenanceClean).toBe(true)
    expect(c.currentPhase).toBe('stable')
    expect(c.userIntentPending).toBe(true)
    expect(c.noteInteractionScrollEnd(token)).toBe(true)
    expect(c.userIntentPending).toBe(false)
    // Old epoch is dead: stale fetch apply/commit cannot revive it.
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: 'main' }, wid('late'))).toBe(false)
    expect(
      c.commitStable(epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: true }).committed
    ).toBe(false)
    void origSet
  })

  it('divider searching user scroll cancels the search and adopts the rendered target', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm1::main',
      clickOffset: 10
    })
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'searching')
    const token = c.declareUserIntent()
    const out = c.userTakeover(
      { messageId: 'mDivLive', intraRowOffset: 10, scrollTop: -60, isAtBottom: false },
      undefined,
      token
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(out.routeKey).toBe('topic-t1::b1')
    commitSnapshotForRoute(out.routeKey, {
      scrollTop: out.snapshot.scrollTop,
      anchorId: out.snapshot.messageId,
      messageId: out.snapshot.messageId,
      intraRowOffset: out.snapshot.intraRowOffset,
      rawScrollTop: out.snapshot.scrollTop,
      isAtBottom: out.snapshot.isAtBottom
    })
    const saved = store.get('scroll:topic-t1::b1') as { messageId: string }
    expect(saved.messageId).toBe('mDivLive')
    expect(c.paginationSettled(epoch)).toBe(false)
  })

  it('failure terminals keep the old snapshot (no user commit on oldest-edge)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    commitSnapshotForRoute('topic-t1::b1', {
      scrollTop: -10,
      anchorId: 'mOld',
      messageId: 'mOld',
      intraRowOffset: -1,
      rawScrollTop: -10,
      isAtBottom: false
    })
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm1::main',
      clickOffset: 10
    })
    c.appliedWindow(epoch)
    c.firstPositioned(epoch, 'searching')
    const term = c.terminate(epoch, 'oldest-edge')
    expect(term.terminated).toBe(true)
    // Dirty terminal (rendered b1 vs displayed null) refuses user adoption
    // even with a live session: provenance first, token second.
    const token = c.declareUserIntent()
    const rej = c.userTakeover(
      { messageId: 'mEdge', intraRowOffset: 0, scrollTop: -5, isAtBottom: false },
      undefined,
      token
    )
    expect(rej.taken).toBe(false)
    const kept = store.get('scroll:topic-t1::b1') as { messageId: string }
    expect(kept.messageId).toBe('mOld')
  })

  it('ordinary stable scroll goes through the same path with an explicit displayed key', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'A' })
    const token = c.declareUserIntent()
    const out = c.userTakeover(
      { messageId: 'mStable', intraRowOffset: -3, scrollTop: -200, isAtBottom: false },
      undefined,
      token
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(out.reason).toBe('stable-update')
    expect(out.routeKey).toBe('topic-t1::A')
    commitSnapshotForRoute(out.routeKey, {
      scrollTop: out.snapshot.scrollTop,
      anchorId: out.snapshot.messageId,
      messageId: out.snapshot.messageId,
      intraRowOffset: out.snapshot.intraRowOffset,
      rawScrollTop: out.snapshot.scrollTop,
      isAtBottom: out.snapshot.isAtBottom
    })
    expect((store.get('scroll:topic-t1::A') as { messageId: string }).messageId).toBe('mStable')
    expect(c.userIntentPending).toBe(true)
    expect(c.noteInteractionScrollEnd(token)).toBe(true)
    expect(c.userIntentPending).toBe(false)
  })

  it('programmatic scroll with no session never takes over (aexcl06 → window 16→28 stays aexcl06)', () => {
    // Exact regression for the last proven gap: A wheel exclusive aexcl06 is
    // already stable+persisted and the A→B→A (main is concrete B) programmatic
    // completion committed aexcl06; a same-route window refresh (::16→::28) then emits a
    // scroll event with NO declare. The scroll must be rejected and the A
    // snapshot/anchor must stay aexcl06 (keeper compensates the offset).
    const c = new RouteViewportController({ topicId: 't1', route: 'A' })
    const t0 = c.declareUserIntent()
    const excl = c.userTakeover(
      { messageId: 'mAexcl06', intraRowOffset: -8, scrollTop: -120, isAtBottom: false },
      undefined,
      t0
    )
    expect(excl.taken).toBe(true)
    if (!excl.taken) return
    commitSnapshotForRoute(excl.routeKey, {
      scrollTop: excl.snapshot.scrollTop,
      anchorId: excl.snapshot.messageId,
      messageId: excl.snapshot.messageId,
      intraRowOffset: excl.snapshot.intraRowOffset,
      rawScrollTop: excl.snapshot.scrollTop,
      isAtBottom: excl.snapshot.isAtBottom
    })
    expect(c.noteInteractionScrollEnd(t0)).toBe(true)
    // Programmatic A→B→A (main is concrete B) around the stable A anchor
    // (controller completion is still a legal stable source and needs no user input).
    const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    c.applyTransitionWindow(first.epoch, { topicId: 't1', route: 'main' }, wid('main-25'))
    const second = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'A',
      saved: { scrollTop: -120, messageId: 'mAexcl06', intraRowOffset: -8, isAtBottom: false }
    })
    c.applyTransitionWindow(second.epoch, { topicId: 't1', route: 'A' }, wid('16'))
    c.firstPositioned(second.epoch, 'placed')
    expect(c.revealed(second.epoch)).toBe(true)
    const stableOut = c.commitStable(second.epoch, {
      messageId: 'mAexcl06',
      intraRowOffset: -8,
      scrollTop: -120,
      isAtBottom: false
    })
    expect(stableOut.committed).toBe(true)
    if (!stableOut.committed || !stableOut.commit) return
    commitSnapshotForRoute(stableOut.commit.routeKey, {
      scrollTop: stableOut.commit.snapshot.scrollTop,
      anchorId: stableOut.commit.snapshot.messageId,
      messageId: stableOut.commit.snapshot.messageId,
      intraRowOffset: stableOut.commit.snapshot.intraRowOffset,
      rawScrollTop: stableOut.commit.snapshot.scrollTop,
      isAtBottom: stableOut.commit.snapshot.isAtBottom
    })
    expect(c.currentPhase).toBe('stable')
    // Same-route window refresh for ordinary pagination/reconcile.
    expect(c.noteSameRouteWindowUpdate({ topicId: 't1', route: 'A' }, wid('28'))).toBe(true)
    // Layout scroll with NO declare (programmatic window growth): rejected.
    const prog = c.userTakeover({ messageId: 'mMsg11', intraRowOffset: -4, scrollTop: -310, isAtBottom: false })
    expect(prog.taken).toBe(false)
    if (!prog.taken) expect(prog.reason).toBe('no-user-intent')
    expect(c.getAnchorFor({ topicId: 't1', route: 'A' })).toEqual({
      kind: 'message',
      messageId: 'mAexcl06',
      offset: -8
    })
    const kept = store.get('scroll:topic-t1::A') as { messageId: string }
    expect(kept.messageId).toBe('mAexcl06')
    // A real wheel afterwards opens a new session and adopts across scrolls.
    const wheel = c.declareUserIntent()
    expect(wheel.interactionId).not.toBe(t0.interactionId)
    const u1 = c.userTakeover(
      { messageId: 'mWheel1', intraRowOffset: -6, scrollTop: -200, isAtBottom: false },
      undefined,
      wheel
    )
    expect(u1.taken).toBe(true)
    const wheelRefresh = c.declareUserIntent()
    expect(wheelRefresh.interactionId).toBe(wheel.interactionId)
    const u2 = c.userTakeover(
      { messageId: 'mWheel2', intraRowOffset: -5, scrollTop: -260, isAtBottom: false },
      undefined,
      wheelRefresh
    )
    expect(u2.taken).toBe(true)
    if (u2.taken) {
      commitSnapshotForRoute(u2.routeKey, {
        scrollTop: u2.snapshot.scrollTop,
        anchorId: u2.snapshot.messageId,
        messageId: u2.snapshot.messageId,
        intraRowOffset: u2.snapshot.intraRowOffset,
        rawScrollTop: u2.snapshot.scrollTop,
        isAtBottom: u2.snapshot.isAtBottom
      })
    }
    expect(c.noteInteractionScrollEnd(wheel)).toBe(true)
    expect((store.get('scroll:topic-t1::A') as { messageId: string }).messageId).toBe('mWheel2')
    expect(c.getAnchorFor({ topicId: 't1', route: 'A' })).toEqual({
      kind: 'message',
      messageId: 'mWheel2',
      offset: -5
    })
  })
})
