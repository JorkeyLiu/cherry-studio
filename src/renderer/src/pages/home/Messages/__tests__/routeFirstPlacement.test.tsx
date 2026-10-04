/**
 * First-position plan delivery regression (bounded root repair).
 *
 * Real shared helper + real layout-effect delivery (no source-string
 * assertions, no massive component mocks):
 * - an ordinary branch→main new-window plan is placed exactly once for the
 *   current epoch, and unrelated re-renders never re-apply it;
 * - a retained same-window recommitted plan (SAME window identity, same
 *   visual values, new epoch) is still reactively delivered via the plan
 *   generation — the historical miss that left branch→main hidden;
 * - a stale plan is inert (refused, never touches the newer transaction);
 * - the pure completion gate only reports "awaiting attempt" while the
 *   current session is `positioning` with an unrecorded outcome, so an async
 *   completion can never falsely stable/reveal before positive placement.
 */
import { render } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  attemptFirstPosition,
  type FirstPlacementPending,
  isFirstPlacementAwaitingAttempt
} from '../routeFirstPlacement'
import { RouteViewportController } from '../routeViewportController'

const installRows = (container: HTMLElement, ids: string[]): void => {
  container.innerHTML = ''
  for (const id of ids) {
    const row = document.createElement('div')
    row.id = `message-${id}`
    row.textContent = id
    container.appendChild(row)
  }
}

const countScrollWrites = (container: HTMLElement): { writes: () => number } => {
  let backing = 0
  let writes = 0
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => backing,
    set: (v: number) => {
      writes += 1
      backing = v
    }
  })
  return { writes: () => writes }
}

/** Minimal production-shaped delivery: plan generation drives the layout attempt. */
const DeliveryHarness = ({
  controller,
  containerHost,
  pendingHost,
  seq,
  attempts
}: {
  controller: RouteViewportController
  containerHost: { current: HTMLElement | null }
  pendingHost: { current: FirstPlacementPending | null }
  seq: number
  attempts: unknown[]
}): null => {
  void seq
  useLayoutEffect(() => {
    const pending = pendingHost.current
    if (!pending) return
    // Production-shaped exactly-once guard: a consumed plan never re-enters
    // the attempt (the recorded outcome stands).
    if (pending.outcome !== null) return
    const live = containerHost.current
    if (!live) return
    attempts.push(attemptFirstPosition(controller, pending, live))
  }, [controller, seq])
  return null
}

const stableBranch = (c: RouteViewportController): void => {
  // Epoch 1: branch is the stable displayed route (user-scroll snapshot path).
  const first = c.request({ kind: 'top', topicId: 't1', targetRoute: 'branch' })
  expect(c.applyTransitionWindow(first.epoch, { topicId: 't1', route: 'branch' }, 'w-branch')).toBe(true)
  expect(c.firstPositioned(first.epoch, 'placed')).toBe(true)
  expect(c.revealed(first.epoch)).toBe(true)
  const { commit } = c.commitStable(first.epoch, {
    messageId: 'mb',
    intraRowOffset: -10,
    scrollTop: -100,
    isAtBottom: false
  })
  expect(commit).not.toBeNull()
}

describe('routeFirstPlacement delivery', () => {
  let container: HTMLElement
  let writes: () => number

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    installRows(container, ['m1', 'm2', 'm3'])
    writes = countScrollWrites(container).writes
    return () => {
      container.remove()
    }
  })

  it('places an ordinary branch→main plan exactly once, then ignores re-renders', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'branch' })
    stableBranch(c)
    const toMain = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -58.9, messageId: 'm2', intraRowOffset: -58.9, isAtBottom: false }
    })
    expect(c.applyTransitionWindow(toMain.epoch, { topicId: 't1', route: null }, 'w-main')).toBe(true)

    const pendingHost: { current: FirstPlacementPending | null } = {
      current: {
        topicId: 't1',
        routeId: null,
        epoch: toMain.epoch,
        plan: { kind: 'message', messageId: 'm2', wantOffset: -58.9, fallbackScrollTop: null },
        outcome: null
      }
    }
    const containerHost = { current: container as HTMLElement | null }
    const attempts: unknown[] = []
    const view = render(
      <DeliveryHarness
        controller={c}
        containerHost={containerHost}
        pendingHost={pendingHost}
        seq={0}
        attempts={attempts}
      />
    )
    expect(attempts).toEqual(['placed'])
    expect(pendingHost.current?.outcome).toBe('placed')
    expect(c.currentPhase).toBe('aligned')
    expect(writes()).toBe(1)
    // Positive placement lets the session reveal + complete (production order).
    expect(c.revealed(toMain.epoch)).toBe(true)
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })

    // Unrelated re-renders (same generation) never re-apply the consumed plan.
    view.rerender(
      <DeliveryHarness
        controller={c}
        containerHost={containerHost}
        pendingHost={pendingHost}
        seq={0}
        attempts={attempts}
      />
    )
    expect(attempts).toEqual(['placed'])
    expect(writes()).toBe(1)
    view.unmount()
  })

  it('delivers a retained same-window recommitted plan under a new epoch', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'branch' })
    stableBranch(c)
    // First main restore places (ordinary new window).
    const first = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -58.9, messageId: 'm2', intraRowOffset: -58.9, isAtBottom: false }
    })
    expect(c.applyTransitionWindow(first.epoch, { topicId: 't1', route: null }, 'w-main')).toBe(true)
    const pendingHost: { current: FirstPlacementPending | null } = {
      current: {
        topicId: 't1',
        routeId: null,
        epoch: first.epoch,
        plan: { kind: 'message', messageId: 'm2', wantOffset: -58.9, fallbackScrollTop: null },
        outcome: null
      }
    }
    const containerHost = { current: container as HTMLElement | null }
    const attempts: unknown[] = []
    const view = render(
      <DeliveryHarness
        controller={c}
        containerHost={containerHost}
        pendingHost={pendingHost}
        seq={0}
        attempts={attempts}
      />
    )
    expect(attempts).toEqual(['placed'])
    expect(c.revealed(first.epoch)).toBe(true)
    const writesAfterFirst = writes()

    // Retained reactivation: SAME window object recommitted under a fresh
    // epoch (no fetch, identical visual values). Generation bump re-drives
    // the layout attempt — the historical miss left this plan unplaced.
    const retained = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: null,
      saved: { scrollTop: -58.9, messageId: 'm2', intraRowOffset: -58.9, isAtBottom: false }
    })
    expect(c.applyTransitionWindow(retained.epoch, { topicId: 't1', route: null }, 'w-main')).toBe(true)
    pendingHost.current = {
      topicId: 't1',
      routeId: null,
      epoch: retained.epoch,
      plan: { kind: 'message', messageId: 'm2', wantOffset: -58.9, fallbackScrollTop: null },
      outcome: null
    }
    view.rerender(
      <DeliveryHarness
        controller={c}
        containerHost={containerHost}
        pendingHost={pendingHost}
        seq={1}
        attempts={attempts}
      />
    )
    expect(attempts).toEqual(['placed', 'placed'])
    expect(pendingHost.current?.outcome).toBe('placed')
    expect(c.currentPhase).toBe('aligned')
    expect(writes()).toBeGreaterThan(writesAfterFirst)
    view.unmount()
  })

  it('refuses a stale plan without touching the newer session', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'branch' })
    stableBranch(c)
    const stale = c.request({ kind: 'top', topicId: 't1', targetRoute: null })
    expect(c.applyTransitionWindow(stale.epoch, { topicId: 't1', route: null }, 'w-main')).toBe(true)
    // Newer session supersedes before the stale plan is attempted.
    const newer = c.request({ kind: 'top', topicId: 't1', targetRoute: null })
    expect(newer.epoch).toBeGreaterThan(stale.epoch)
    const releasesBefore = c.releaseCount

    const stalePending: FirstPlacementPending = {
      topicId: 't1',
      routeId: null,
      epoch: stale.epoch,
      plan: { kind: 'message', messageId: 'm2', wantOffset: -58.9, fallbackScrollTop: null },
      outcome: null
    }
    const attempts: unknown[] = []
    const view = render(
      <DeliveryHarness
        controller={c}
        containerHost={{ current: container }}
        pendingHost={{ current: stalePending }}
        seq={0}
        attempts={attempts}
      />
    )
    expect(attempts).toEqual(['refused'])
    expect(stalePending.outcome).toBeNull()
    expect(writes()).toBe(0)
    // The newer transaction is undisturbed (no place/reveal/commit/release).
    expect(c.currentEpoch).toBe(newer.epoch)
    expect(c.releaseCount).toBe(releasesBefore)
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: 'branch' })
    view.unmount()
  })

  it('records an unplaced plan and terminalizes (fail-visible input, no commit)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'branch' })
    stableBranch(c)
    const epoch = c.request({ kind: 'top', topicId: 't1', targetRoute: null }).epoch
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: null }, 'w-main')).toBe(true)
    const pending: FirstPlacementPending = {
      topicId: 't1',
      routeId: null,
      epoch,
      plan: { kind: 'none' },
      outcome: null
    }
    container.innerHTML = ''
    expect(attemptFirstPosition(c, pending, container)).toBe('unplaced')
    expect(pending.outcome).toBe('unplaced')
    expect(c.currentPhase).toBe('terminal')
    expect(c.isDirtyTerminal).toBe(true)
    // A terminalized session never commits a snapshot from this plan.
    expect(
      c.commitStable(epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: false }).committed
    ).toBe(false)
  })

  it('completion gate is true only while placement is genuinely unobserved', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'branch' })
    stableBranch(c)
    const epoch = c.request({ kind: 'top', topicId: 't1', targetRoute: null }).epoch
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: null }, 'w-main')).toBe(true)
    const pending: FirstPlacementPending = {
      topicId: 't1',
      routeId: null,
      epoch,
      plan: { kind: 'message', messageId: 'm2', wantOffset: -58.9, fallbackScrollTop: null },
      outcome: null
    }
    // Positioning + current + unrecorded → the async completion must wait.
    expect(isFirstPlacementAwaitingAttempt(c, pending, epoch)).toBe(true)
    expect(isFirstPlacementAwaitingAttempt(c, null, epoch)).toBe(false)
    expect(isFirstPlacementAwaitingAttempt(c, pending, epoch + 1)).toBe(false)
    // Once observed, completions proceed (no wait, no hang).
    expect(attemptFirstPosition(c, pending, container)).toBe('placed')
    expect(isFirstPlacementAwaitingAttempt(c, pending, epoch)).toBe(false)
    // After terminal release, nothing waits.
    const doomed = c.request({ kind: 'top', topicId: 't1', targetRoute: null }).epoch
    expect(c.applyTransitionWindow(doomed, { topicId: 't1', route: null }, 'w-main')).toBe(true)
    const doomedPending: FirstPlacementPending = {
      topicId: 't1',
      routeId: null,
      epoch: doomed,
      plan: { kind: 'none' },
      outcome: null
    }
    installRows(container, [])
    expect(attemptFirstPosition(c, doomedPending, container)).toBe('unplaced')
    expect(isFirstPlacementAwaitingAttempt(c, doomedPending, doomed)).toBe(false)
  })
})
