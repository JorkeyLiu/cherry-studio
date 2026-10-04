/**
 * Terminal fallback clean restoration (branch→main dirty terminal repair).
 *
 * Exact runtime shape from the failing resume (existing route-settings-session
 * branch→main): branch stable, main top request, `applyTransitionWindow` ok,
 * stable completion refused while `positioning` (no placement observed), then
 * terminal with displayed=branch / rendered=main (dirty). The deterministic
 * own-target fallback adopts the committed rendered target as displayed —
 * guarded epoch + same-current target — so the terminal becomes clean, the
 * prior lawful snapshot is preserved (no fake/temporary geometry submitted),
 * and the next genuine user scroll forms the new stable snapshot under the
 * displayed provenance. Stale/pre-commit/foreign attempts are no-ops and
 * release stays exactly-once.
 */
import { describe, expect, it } from 'vitest'

import { RouteViewportController } from '../routeViewportController'

const TOPIC = 'route-sess-test'
const BRANCH = 'branch-id'
const MAIN: null = null

describe('adoptRenderedAsDisplayed terminal fallback', () => {
  it('restores rendered=main/displayed=branch to clean without inventing a snapshot', () => {
    const c = new RouteViewportController({ topicId: TOPIC, route: BRANCH })
    // Branch stable (epoch 1).
    const first = c.request({ kind: 'top', topicId: TOPIC, targetRoute: BRANCH })
    expect(c.applyTransitionWindow(first.epoch, { topicId: TOPIC, route: BRANCH }, 'w-branch')).toBe(true)
    expect(c.firstPositioned(first.epoch, 'placed')).toBe(true)
    expect(c.revealed(first.epoch)).toBe(true)
    const { commit: branchCommit } = c.commitStable(first.epoch, {
      messageId: 'mb',
      intraRowOffset: -10,
      scrollTop: -100,
      isAtBottom: false
    })
    expect(branchCommit).not.toBeNull()
    expect(c.currentPhase).toBe('stable')

    // Main top request (epoch 2): window commits, placement never observed.
    const toMain = c.request({
      kind: 'top',
      topicId: TOPIC,
      targetRoute: MAIN,
      saved: { scrollTop: -58.9, messageId: 'm14', intraRowOffset: -58.9, isAtBottom: false }
    })
    expect(c.applyTransitionWindow(toMain.epoch, { topicId: TOPIC, route: MAIN }, 'w-main-30')).toBe(true)
    expect(c.currentPhase).toBe('positioning')
    // Exact failure: async completion attempts stable while positioning.
    expect(
      c.commitStable(toMain.epoch, { messageId: 'm14', intraRowOffset: -58.9, scrollTop: -58.9, isAtBottom: false })
        .committed
    ).toBe(false)
    // Terminal fallback: displayed stays branch, rendered is main → dirty.
    const term = c.terminate(toMain.epoch, 'fail-visible')
    expect(term).toEqual({ terminated: true, didRelease: true })
    expect(c.displayedRoute).toEqual({ topicId: TOPIC, route: BRANCH })
    expect(c.renderedProvenance).toMatchObject({ topicId: TOPIC, routeId: MAIN, epoch: toMain.epoch })
    expect(c.isDirtyTerminal).toBe(true)
    expect(c.canAcceptUserScrollWrite()).toBe(false)
    const releasesAfterTerminate = c.releaseCount

    // Deterministic own-target adoption: same latest epoch, committed render.
    expect(c.adoptRenderedAsDisplayed(toMain.epoch)).toBe(true)
    expect(c.displayedRoute).toEqual({ topicId: TOPIC, route: MAIN })
    expect(c.isDomProvenanceClean).toBe(true)
    expect(c.isTerminalClean).toBe(true)
    expect(c.isDirtyTerminal).toBe(false)
    // No release, no snapshot invention: still terminal (not stable), the
    // failed session's reason stands, and the live anchor still belongs to
    // the adopted target (never an arbitrary old DOM claim).
    expect(c.releaseCount).toBe(releasesAfterTerminate)
    expect(c.currentPhase).toBe('terminal')
    expect(c.lastTerminalReason).toBe('fail-visible')
    expect(c.getAnchorFor({ topicId: TOPIC, route: MAIN })).toEqual({
      kind: 'message',
      messageId: 'm14',
      offset: -58.9
    })

    // The restored terminal is real user state: a genuine scroll writes the
    // new stable snapshot under the displayed (main) provenance.
    expect(c.canAcceptUserScrollWrite()).toBe(true)
    c.declareUserIntent()
    const takeover = c.userTakeover(
      { messageId: 'm14', intraRowOffset: -58.9, scrollTop: -58.9, isAtBottom: false },
      'w-main-30'
    )
    expect(takeover.taken).toBe(true)
    if (takeover.taken) {
      expect(takeover.routeKey).toBe(`topic-${TOPIC}::main`)
      expect(takeover.reason).toBe('stable-update')
    }
    expect(c.currentPhase).toBe('stable')
    expect(c.displayedRoute).toEqual({ topicId: TOPIC, route: MAIN })
  })

  it('stale, pre-commit, foreign, and non-terminal adoptions are no-ops', () => {
    const c = new RouteViewportController({ topicId: TOPIC, route: BRANCH })
    const first = c.request({ kind: 'top', topicId: TOPIC, targetRoute: BRANCH })
    expect(c.applyTransitionWindow(first.epoch, { topicId: TOPIC, route: BRANCH }, 'w-branch')).toBe(true)
    expect(c.firstPositioned(first.epoch, 'placed')).toBe(true)
    expect(c.revealed(first.epoch)).toBe(true)
    expect(
      c.commitStable(first.epoch, { messageId: 'mb', intraRowOffset: -10, scrollTop: -100, isAtBottom: false }).commit
    ).not.toBeNull()

    // Pre-commit failure (fetch failed before any window bound): rendered is
    // still the older session's — never adopted for the new epoch.
    const failed = c.request({ kind: 'top', topicId: TOPIC, targetRoute: MAIN })
    expect(c.terminate(failed.epoch, 'fail-visible').terminated).toBe(true)
    expect(c.renderedProvenance?.epoch).not.toBe(failed.epoch)
    expect(c.adoptRenderedAsDisplayed(failed.epoch)).toBe(false)
    expect(c.displayedRoute).toEqual({ topicId: TOPIC, route: BRANCH })

    // Owned in-flight session: never adopts (still positioning, not terminal).
    const live = c.request({ kind: 'top', topicId: TOPIC, targetRoute: MAIN })
    expect(c.applyTransitionWindow(live.epoch, { topicId: TOPIC, route: MAIN }, 'w-main')).toBe(true)
    expect(c.adoptRenderedAsDisplayed(live.epoch)).toBe(false)
    expect(c.displayedRoute).toEqual({ topicId: TOPIC, route: BRANCH })

    // Stale epoch: never touches the newer transaction.
    expect(c.adoptRenderedAsDisplayed(failed.epoch)).toBe(false)
    expect(c.currentEpoch).toBe(live.epoch)
    expect(c.displayedRoute).toEqual({ topicId: TOPIC, route: BRANCH })
  })
})
