/**
 * Composer layout-operation provenance (controller side): one logical layout
 * operation carries a common identity so native scroll observations are never
 * classified by sourceless guessing.
 *
 * - begin/advance/end lifecycle on a single active slot (monotonic id);
 * - begin invalidates the previous operation's echo;
 * - end retains the final write's echo for the follow-up native scroll;
 * - request/invalidateAll/declareUserIntent cancel the active operation and
 *   clear its echo;
 * - consume keeps declareSeq + tolerance but rejects cross-route and
 *   cross-operation stale markers;
 * - programmatic writes still work with no operation (latest-wins, no queue).
 */
import { describe, expect, it } from 'vitest'

import { RouteViewportController } from '../routeViewportController'

const displayed = (topicId: string, route: string | null) => ({ topicId, route })
const routeKeyFor = (topicId: string, route: string | null): string => `topic-${topicId}::${route ?? 'main'}`

describe('layout operation lifecycle (single active slot)', () => {
  it('begin assigns a monotonic id; advance/end only affect the current operation', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const key = routeKeyFor('t1', 'A')
    const first = c.beginLayoutOperation('composer-overlay', key)
    const second = c.beginLayoutOperation('composer-overlay', key)
    expect(second.id).toBeGreaterThan(first.id)
    expect(c.isCurrentLayoutOperation(first)).toBe(false)
    expect(c.isCurrentLayoutOperation(second)).toBe(true)
    expect(c.advanceLayoutOperation(first, 1)).toBe(false)
    expect(c.advanceLayoutOperation(second, 1)).toBe(true)
    expect(c.endLayoutOperation(first)).toBe(false)
    expect(c.endLayoutOperation(second)).toBe(true)
    // Ended operations are no longer current and never advance again.
    expect(c.isCurrentLayoutOperation(second)).toBe(false)
    expect(c.advanceLayoutOperation(second, 2)).toBe(false)
    expect(c.endLayoutOperation(second)).toBe(false)
  })

  it('getCurrentLayoutOperation mirrors the active operation and clears on end', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    expect(c.getCurrentLayoutOperation()).toBeNull()
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    expect(c.getCurrentLayoutOperation()).toEqual(op)
    c.endLayoutOperation(op)
    expect(c.getCurrentLayoutOperation()).toBeNull()
  })

  it('an operation is not current for a different route (topic switch)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    expect(c.isCurrentLayoutOperation(op)).toBe(true)
    c.syncDisplayed(displayed('t1', 'B'))
    expect(c.isCurrentLayoutOperation(op)).toBe(false)
  })
})

describe('layout operation cancellation', () => {
  it('request supersedes the active operation and drops its echo', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    c.noteCompensationWrite(-300, op)
    expect(c.consumeCompensationEcho(-300)).toBe(true)
    const op2 = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    c.noteCompensationWrite(-310, op2)
    c.request({ kind: 'top', topicId: 't1', targetRoute: 'main', saved: null })
    expect(c.isCurrentLayoutOperation(op2)).toBe(false)
    expect(c.getCurrentLayoutOperation()).toBeNull()
    expect(c.consumeCompensationEcho(-310)).toBe(false)
  })

  it('invalidateAll cancels the active operation and drops its echo', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    c.noteCompensationWrite(-300, op)
    c.invalidateAll()
    expect(c.isCurrentLayoutOperation(op)).toBe(false)
    expect(c.consumeCompensationEcho(-300)).toBe(false)
  })

  it('a genuine declare cancels the active operation and clears its echo', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    c.noteCompensationWrite(-300, op)
    c.declareUserIntent()
    expect(c.isCurrentLayoutOperation(op)).toBe(false)
    expect(c.getCurrentLayoutOperation()).toBeNull()
    expect(c.consumeCompensationEcho(-300)).toBe(false)
  })

  it('a new operation may begin after a cancellation', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const key = routeKeyFor('t1', 'A')
    const old = c.beginLayoutOperation('composer-overlay', key)
    c.declareUserIntent()
    const next = c.beginLayoutOperation('composer-overlay', key)
    expect(next.id).toBeGreaterThan(old.id)
    expect(c.isCurrentLayoutOperation(next)).toBe(true)
    c.noteCompensationWrite(-400, next)
    expect(c.consumeCompensationEcho(-400)).toBe(true)
  })
})

describe('operation-carrying compensation echo', () => {
  it('end retains the final write echo for the follow-up native scroll', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    c.noteCompensationWrite(-500, op)
    expect(c.endLayoutOperation(op)).toBe(true)
    // The operation ended normally: the retained echo still reads as app echo.
    expect(c.consumeCompensationEcho(-500)).toBe(true)
    expect(c.consumeCompensationEcho(-500)).toBe(false)
  })

  it('a stale operation write is never recorded (fail-closed, no swallow)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const key = routeKeyFor('t1', 'A')
    const old = c.beginLayoutOperation('composer-overlay', key)
    const next = c.beginLayoutOperation('composer-overlay', key)
    // A late write from the superseded operation records nothing.
    c.noteCompensationWrite(-500, old)
    expect(c.consumeCompensationEcho(-500)).toBe(false)
    // The live operation still records and consumes normally.
    c.noteCompensationWrite(-510, next)
    expect(c.consumeCompensationEcho(-510)).toBe(true)
  })

  it('an echo from another route never swallows this route scroll', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    c.noteCompensationWrite(-500, op)
    // Bootstrap rebase moves displayed without owning a transition: the
    // marker keeps its old route provenance and must be rejected at consume
    // time, never swallowed as this route's app echo.
    c.rebaseClean(displayed('t1', 'B'), 'window-b1')
    expect(c.consumeCompensationEcho(-500)).toBe(false)
    // Same-route markers still consume after the rebase.
    const opB = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'B'))
    c.noteCompensationWrite(-510, opB)
    expect(c.consumeCompensationEcho(-510)).toBe(true)
  })
  it('rebaseClean cancels the live operation so the new route inherits no stale identity', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    expect(c.rebaseClean(displayed('t1', 'B'), 'window-b1')).toBe(true)
    // The previous route's episode is gone: no active slot, old token not current.
    expect(c.getCurrentLayoutOperation()).toBeNull()
    expect(c.isCurrentLayoutOperation(op)).toBe(false)
    // An ordinary operation-less write on the new route carries no old op id
    // and consumes normally as the new route's echo.
    c.noteCompensationWrite(-500)
    expect(c.consumeCompensationEcho(-500)).toBe(true)
    // A fresh episode begins normally on the new route afterwards.
    const opB = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'B'))
    expect(c.isCurrentLayoutOperation(opB)).toBe(true)
    // A foreign-route operation never surfaces as current, even while live.
    const c2 = new RouteViewportController(displayed('t1', 'A'))
    c2.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'B'))
    expect(c2.getCurrentLayoutOperation()).toBeNull()
  })
  it('a write from a user-cancelled operation is never recorded', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    const op = c.beginLayoutOperation('composer-overlay', routeKeyFor('t1', 'A'))
    c.declareUserIntent()
    c.noteCompensationWrite(-500, op)
    expect(c.consumeCompensationEcho(-500)).toBe(false)
  })

  it('operation-less writes keep the legacy latest-wins echo (ordinary RO/MO holds)', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.noteCompensationWrite(-1842)
    expect(c.consumeCompensationEcho(-1842)).toBe(true)
    expect(c.consumeCompensationEcho(-1842)).toBe(false)
    c.noteCompensationWrite(-900)
    expect(c.consumeCompensationEcho(-640)).toBe(false)
  })

  it('operation-less writes still respect fresh declarations and route invalidation', () => {
    const c = new RouteViewportController(displayed('t1', 'A'))
    c.noteCompensationWrite(-220)
    c.declareUserIntent()
    expect(c.consumeCompensationEcho(-220)).toBe(false)
    c.noteCompensationWrite(-221)
    c.syncDisplayed(displayed('t1', 'B'))
    expect(c.consumeCompensationEcho(-221)).toBe(false)
  })
})
