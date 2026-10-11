/**
 * Streaming follow resume: natural root-follow intent distinction.
 *
 * - Pause click keeps the row EVEN at bottom (default `userTakeover`
 *   behavior, no opt-in): snapshot truthful, live anchor row.
 * - Genuine user SCROLL landing at the exact physical bottom resumes follow
 *   (opt-in `bottomFollow`): live anchor null, snapshot stays TRUTHFUL
 *   (measured messageId/offset/isAtBottom untouched — never a synthesized
 *   bottom record).
 * - A wide near-bottom scroll (e.g. -30, inside the 50px snapshot vicinity)
 *   never jumps: row kept, no follow.
 * - Programmatic / no-gesture scrolls never take over (no inference).
 * - Exact gate is `abs(scrollTop) <= 1` (renderer-local
 *   `isGenuinePhysicalBottom`), not the 50px snapshot threshold.
 */
import { commitSnapshotForRoute } from '@renderer/hooks/useScrollPosition'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isGenuinePhysicalBottom } from '../Messages'
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

beforeEach(() => {
  store = new Map()
  ;(window as unknown as { keyv: unknown }).keyv = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
    remove: (key: string) => {
      store.delete(key)
    }
  }
})

const commitTaken = (
  routeKey: string,
  snapshot: { scrollTop: number; messageId: string | null; intraRowOffset: number | null; isAtBottom: boolean }
): void => {
  const ok = commitSnapshotForRoute(routeKey, {
    scrollTop: snapshot.scrollTop,
    anchorId: snapshot.messageId,
    messageId: snapshot.messageId,
    intraRowOffset: snapshot.intraRowOffset,
    rawScrollTop: snapshot.scrollTop,
    isAtBottom: snapshot.isAtBottom
  })
  expect(ok).toBe(true)
}

describe('isGenuinePhysicalBottom exact gate', () => {
  it('accepts only the exact physical bottom (1px subpixel tolerance)', () => {
    expect(isGenuinePhysicalBottom(0)).toBe(true)
    expect(isGenuinePhysicalBottom(-0.5)).toBe(true)
    expect(isGenuinePhysicalBottom(1)).toBe(true)
    expect(isGenuinePhysicalBottom(-1)).toBe(true)
    expect(isGenuinePhysicalBottom(-1.01)).toBe(false)
    expect(isGenuinePhysicalBottom(-30)).toBe(false)
    expect(isGenuinePhysicalBottom(-49)).toBe(false)
    expect(isGenuinePhysicalBottom(-200)).toBe(false)
    expect(isGenuinePhysicalBottom(NaN)).toBe(false)
    expect(isGenuinePhysicalBottom(null)).toBe(false)
  })
})

describe('pause click vs genuine scroll resume', () => {
  it('pause click at bottom keeps the row while the snapshot stays truthful', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const token = c.declareUserIntent()
    const out = c.userTakeover(
      { messageId: 'm2', intraRowOffset: -60, scrollTop: 0, isAtBottom: true },
      undefined,
      token
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(out.snapshot).toMatchObject({ messageId: 'm2', scrollTop: 0, isAtBottom: true })
    commitTaken(out.routeKey, out.snapshot)
    c.clearUserIntent()
    expect(c.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    const saved = store.get('scroll:topic-t1::main') as { messageId: string; isAtBottom: boolean }
    expect(saved.messageId).toBe('m2')
    expect(saved.isAtBottom).toBe(true)
  })

  it('genuine scroll landing at exact bottom resumes follow with a truthful snapshot', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    // Pause first (row held at bottom).
    const pauseToken = c.declareUserIntent()
    const paused = c.userTakeover(
      { messageId: 'm2', intraRowOffset: -60, scrollTop: 0, isAtBottom: true },
      undefined,
      pauseToken
    )
    expect(paused.taken).toBe(true)
    if (!paused.taken) return
    commitTaken(paused.routeKey, paused.snapshot)
    c.clearUserIntent()
    expect(c.getAnchorFor({ topicId: 't1', route: null })).not.toBeNull()
    // Ordinary wheel away keeps the row (no auto-resume).
    const away = c.declareUserIntent()
    const awayOut = c.userTakeover(
      { messageId: 'm2', intraRowOffset: -60, scrollTop: -400, isAtBottom: false },
      undefined,
      away,
      { bottomFollow: isGenuinePhysicalBottom(-400) }
    )
    expect(awayOut.taken).toBe(true)
    if (!awayOut.taken) return
    commitTaken(awayOut.routeKey, awayOut.snapshot)
    expect(c.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
    // Real wheel landing at exact bottom resumes follow: anchor null,
    // snapshot still carries the measured row truth (never nulled).
    const bottom = c.declareUserIntent()
    const bottomOut = c.userTakeover(
      { messageId: 'mTail', intraRowOffset: -4, scrollTop: 0, isAtBottom: true },
      undefined,
      bottom,
      { bottomFollow: isGenuinePhysicalBottom(0) }
    )
    expect(bottomOut.taken).toBe(true)
    if (!bottomOut.taken) return
    expect(bottomOut.snapshot).toMatchObject({ messageId: 'mTail', scrollTop: 0, isAtBottom: true })
    commitTaken(bottomOut.routeKey, bottomOut.snapshot)
    expect(c.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    const saved = store.get('scroll:topic-t1::main') as { messageId: string; isAtBottom: boolean }
    expect(saved.messageId).toBe('mTail')
    expect(saved.isAtBottom).toBe(true)
    c.noteInteractionScrollEnd(bottom)
    expect(c.userIntentPending).toBe(false)
  })

  it('wide near-bottom scroll never jumps to follow (50px vicinity is not exact)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const token = c.declareUserIntent()
    const out = c.userTakeover(
      { messageId: 'mTail', intraRowOffset: -4, scrollTop: -30, isAtBottom: true },
      undefined,
      token,
      { bottomFollow: isGenuinePhysicalBottom(-30) }
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    // Snapshot keeps the 50px vicinity flag; the live anchor keeps the row.
    expect(out.snapshot.isAtBottom).toBe(true)
    expect(c.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'mTail',
      offset: -4
    })
  })

  it('stale opt-in at a reading offset cannot null the row (controller re-validates exact)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const token = c.declareUserIntent()
    const out = c.userTakeover(
      { messageId: 'mTail', intraRowOffset: -4, scrollTop: -30, isAtBottom: true },
      undefined,
      token,
      { bottomFollow: true }
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(c.getAnchorFor({ topicId: 't1', route: null })).not.toBeNull()
  })

  it('programmatic scroll with no live session never takes over', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const out = c.userTakeover(
      { messageId: 'mTail', intraRowOffset: -4, scrollTop: 0, isAtBottom: true },
      undefined,
      undefined,
      { bottomFollow: true }
    )
    expect(out.taken).toBe(false)
    if (!out.taken) expect(out.reason).toBe('no-user-intent')
    expect(c.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
  })

  it('stale interaction token never resumes follow on the wrong session', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const live = c.declareUserIntent()
    const out = c.userTakeover(
      { messageId: 'mTail', intraRowOffset: -4, scrollTop: 0, isAtBottom: true },
      undefined,
      { interactionId: live.interactionId + 99, epoch: live.epoch },
      { bottomFollow: true }
    )
    expect(out.taken).toBe(false)
    if (!out.taken) expect(out.reason).toBe('stale-interaction')
  })
})
