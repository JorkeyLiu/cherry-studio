/**
 * Bootstrap restore session contract (ordinary topic restore isolation).
 *
 * Wires the pure bootstrap decision (`resolveBootstrapDecision`) to the
 * controller session (`request` + `commitStable`) the way `Messages.tsx`
 * does after the fix:
 * - restore reuses the single decision-time saved source for the session AND
 *   the final explicit commit context (never a live re-read);
 * - pending explicit navigation carries no saved source, so it can never
 *   masquerade as a saved restore at the final commit, even with the flag.
 */
import { resolveBootstrapDecision } from '@renderer/pages/home/Messages/messageNavigation'
import { isSavedBottomIntent, RouteViewportController } from '@renderer/pages/home/Messages/routeViewportController'
import { describe, expect, it } from 'vitest'

const displayed = (topicId: string, route: string | null) => ({ topicId, route })

const wid = (n: string): string => `oldest::newest::${n}`

const driveToAligned = (c: RouteViewportController, epoch: number, topicId: string, route: string | null): void => {
  c.applyTransitionWindow(epoch, { topicId, route }, wid('25'))
  c.firstPositioned(epoch, 'placed')
  expect(c.revealed(epoch)).toBe(true)
}

describe('bootstrap restore session wiring (decision-time source reuse + pending isolation)', () => {
  it('restore bottom: decision restore → generic session carries saved-bottom → explicit context + bottom forces null/null/true', () => {
    const savedPosition = { scrollTop: -8, anchorId: null, messageId: 'm1', intraRowOffset: -12, isAtBottom: true }
    const decision = resolveBootstrapDecision({
      phase: 'idle',
      isTopicReadBusy: false,
      topicId: 't1',
      pending: null,
      savedPosition,
      savedRestoreHandled: false
    })
    expect(decision.action).toBe('restore')
    if (decision.action !== 'restore') return
    expect(decision.intent).toEqual({ kind: 'bottom', source: 'restore' })

    // Messages reuses the SAME decision-time object for the session and the commit.
    const sessionSaved = {
      scrollTop: savedPosition.scrollTop,
      messageId: savedPosition.messageId,
      intraRowOffset: savedPosition.intraRowOffset,
      isAtBottom: savedPosition.isAtBottom
    }
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({ kind: 'generic', topicId: 't1', targetRoute: 'b1', saved: sessionSaved })
    driveToAligned(c, epoch, 't1', 'b1')
    const out = c.commitStable(
      epoch,
      { messageId: 'm1', intraRowOffset: -12, scrollTop: -8, isAtBottom: true },
      wid('25'),
      { savedBottomIntent: isSavedBottomIntent(sessionSaved) }
    )
    expect(isSavedBottomIntent(sessionSaved)).toBe(true)
    expect(out.committed).toBe(true)
    expect(out.commit?.snapshot).toEqual({ scrollTop: -8, messageId: null, intraRowOffset: null, isAtBottom: true })
    expect(c.getAnchorFor(displayed('t1', 'b1'))).toBeNull()
  })

  it('restore row: decision restore → generic session carries saved row → row commit keeps identity', () => {
    const savedPosition = { scrollTop: -400, anchorId: null, messageId: 'm1', intraRowOffset: -12, isAtBottom: false }
    const decision = resolveBootstrapDecision({
      phase: 'idle',
      isTopicReadBusy: false,
      topicId: 't1',
      pending: null,
      savedPosition,
      savedRestoreHandled: false
    })
    expect(decision.action).toBe('restore')
    if (decision.action !== 'restore') return
    expect(decision.intent).toEqual({
      kind: 'message',
      targetId: 'm1',
      source: 'restore',
      restoreOffset: -12
    })

    const sessionSaved = {
      scrollTop: savedPosition.scrollTop,
      messageId: savedPosition.messageId,
      intraRowOffset: savedPosition.intraRowOffset,
      isAtBottom: savedPosition.isAtBottom
    }
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({ kind: 'generic', topicId: 't1', targetRoute: 'b1', saved: sessionSaved })
    driveToAligned(c, epoch, 't1', 'b1')
    const out = c.commitStable(
      epoch,
      { messageId: 'm1', intraRowOffset: -12, scrollTop: -400, isAtBottom: false },
      wid('25'),
      { savedBottomIntent: isSavedBottomIntent(sessionSaved) }
    )
    expect(isSavedBottomIntent(sessionSaved)).toBe(false)
    expect(out.committed).toBe(true)
    expect(out.commit?.snapshot).toMatchObject({ messageId: 'm1', intraRowOffset: -12, isAtBottom: false })
  })

  it('pending explicit navigation wins over saved bottom and carries no saved source (cannot force bottom)', () => {
    const savedPosition = { scrollTop: -8, anchorId: null, messageId: 'm1', intraRowOffset: -12, isAtBottom: true }
    const decision = resolveBootstrapDecision({
      phase: 'idle',
      isTopicReadBusy: false,
      topicId: 't1',
      pending: { messageId: 'm9', topicId: 't1' },
      savedPosition,
      savedRestoreHandled: false
    })
    expect(decision.action).toBe('pending')
    if (decision.action !== 'pending') return

    // Messages opens the pending bootstrap session with NO saved source.
    const c = new RouteViewportController(displayed('t1', null))
    const { epoch } = c.request({ kind: 'generic', topicId: 't1', targetRoute: 'b1', saved: null })
    driveToAligned(c, epoch, 't1', 'b1')
    // Even a mistaken explicit flag must not force: the session source is absent.
    const out = c.commitStable(
      epoch,
      { messageId: 'm9', intraRowOffset: null, scrollTop: -8, isAtBottom: true },
      wid('25'),
      { savedBottomIntent: true }
    )
    expect(out.committed).toBe(true)
    expect(out.commit?.snapshot).toMatchObject({ messageId: 'm9', isAtBottom: true })
  })
})
