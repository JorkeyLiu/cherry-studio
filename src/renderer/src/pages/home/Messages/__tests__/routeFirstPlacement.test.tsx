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
import type { HistoryReferenceChainLayer, HistoryReferenceMeta } from '@shared/chatDb'
import { render } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  attemptFirstPosition,
  type FirstPlacementPending,
  isFirstPlacementAwaitingAttempt,
  resolveTargetProjectionReadiness,
  type TargetProjectionWindow
} from '../routeFirstPlacement'
import { type RenderedProvenance, RouteViewportController } from '../routeViewportController'

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

  it('bootstrap fetch-hold exposes no consumable placement until the same-session positioning commit', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'branch' })
    stableBranch(c)
    // beginBootstrapFetch shape: generic request opens fetch-hold (hidden,
    // measurable) with NO plan delivered yet.
    const fetchEpoch = c.request({ kind: 'generic', topicId: 't1', targetRoute: null }).epoch
    expect(c.currentPhase).toBe('fetch-hold')
    // No plan exists, so the completion gate reports nothing awaiting: the
    // pre-paint layout effect (phase guard + null plan) stays hidden instead
    // of consuming the exactly-once outcome on the stale projection.
    expect(isFirstPlacementAwaitingAttempt(c, null, fetchEpoch)).toBe(false)
    // commitBootstrapPositioningPlan shape: same epoch, still fetch-hold →
    // applyTransitionWindow binds the committed window identity and moves to
    // positioning; only then is the plan delivered.
    expect(c.applyTransitionWindow(fetchEpoch, { topicId: 't1', route: null }, 'm1::m3::3')).toBe(true)
    expect(c.currentPhase).toBe('positioning')
    const pending: FirstPlacementPending = {
      topicId: 't1',
      routeId: null,
      epoch: fetchEpoch,
      plan: { kind: 'message', messageId: 'm2', wantOffset: -58.9, fallbackScrollTop: null },
      outcome: null
    }
    expect(isFirstPlacementAwaitingAttempt(c, pending, fetchEpoch)).toBe(true)
    expect(attemptFirstPosition(c, pending, container)).toBe('placed')
    // Exactly-once: the recorded outcome stands, no second scroll write.
    expect(attemptFirstPosition(c, pending, container)).toBe('placed')
    expect(writes()).toBe(1)
    expect(c.currentPhase).toBe('aligned')
  })

  it('a superseded bootstrap fetch-hold can never deliver a stale placement', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'branch' })
    stableBranch(c)
    const staleFetch = c.request({ kind: 'generic', topicId: 't1', targetRoute: null }).epoch
    const newer = c.request({ kind: 'generic', topicId: 't1', targetRoute: null }).epoch
    expect(newer).toBeGreaterThan(staleFetch)
    // Same-session commit for the stale epoch refuses: no dispatch, and the
    // newer owner is undisturbed.
    expect(c.applyTransitionWindow(staleFetch, { topicId: 't1', route: null }, 'm1::m3::3')).toBe(false)
    expect(c.currentEpoch).toBe(newer)
    expect(c.currentPhase).toBe('fetch-hold')
    const stalePending: FirstPlacementPending = {
      topicId: 't1',
      routeId: null,
      epoch: staleFetch,
      plan: { kind: 'bottom' },
      outcome: null
    }
    expect(attemptFirstPosition(c, stalePending, container)).toBe('refused')
    expect(stalePending.outcome).toBeNull()
    expect(writes()).toBe(0)
    expect(c.currentEpoch).toBe(newer)
  })

  // ---------------------------------------------------------------------------
  // Target-projection readiness (atomic-visibility boundary).
  //
  // The pre-paint placement/reveal may only complete on the target projection
  // THIS transaction committed. A transient pre-commit projection (an empty
  // window while the target's window read is in flight, or while its loaded
  // projection already holds the content the window must show) is
  // not-yet-observed: the pass stays hidden with the plan unconsumed instead of
  // being treated as a completed first placement. Genuine observed empties and
  // short real content stay legal, and the gate never looks at scroll geometry.
  // ---------------------------------------------------------------------------

  const installStreamedRows = (
    container: HTMLElement,
    ids: string[],
    geometry: { scrollHeight: number; clientHeight: number }
  ): void => {
    container.innerHTML = ''
    for (const id of ids) {
      const row = document.createElement('div')
      row.id = `message-${id}`
      row.textContent = id
      container.appendChild(row)
    }
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => geometry.scrollHeight })
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => geometry.clientHeight })
  }

  const projectionWindow = (displayMessages: Array<{ id: string; topicId?: string }>) => ({
    oldestMessageId: displayMessages.at(-1)?.id,
    newestMessageId: displayMessages[0]?.id,
    displayMessages
  })

  const windowIdentity = (window: TargetProjectionWindow): string =>
    `${String(window.oldestMessageId ?? '')}::${String(window.newestMessageId ?? '')}::${window.displayMessages.length}`

  /** Projection facts a render commit exposes to the pre-paint layout pass. */
  interface ProjectionCommit {
    window: ReturnType<typeof projectionWindow> | null
    loadedProjection: readonly unknown[] | undefined
    windowReadBusy: boolean
    reference?: HistoryReferenceMeta | null
  }

  /**
   * Production-shaped pre-paint delivery: the real readiness gate, the real
   * exactly-once attempt, the real controller, and the real reveal. Deps are
   * the commit facts (window / loaded projection / read busy / reference) plus
   * the controller's phase/epoch — never a timer.
   */
  const ReadinessDeliveryHarness = ({
    controller,
    containerHost,
    pendingHost,
    seq,
    projection,
    reference,
    events
  }: {
    controller: RouteViewportController
    containerHost: { current: HTMLElement | null }
    pendingHost: { current: FirstPlacementPending | null }
    seq: number
    projection: ProjectionCommit
    reference?: HistoryReferenceMeta | null
    events: string[]
  }): null => {
    void seq
    useLayoutEffect(() => {
      if (controller.currentPhase !== 'positioning') return
      const pending = pendingHost.current
      if (!pending || pending.outcome !== null) return
      if (!controller.isSessionCurrent(pending.epoch)) return
      const live = containerHost.current
      if (!live) return
      const readiness = resolveTargetProjectionReadiness({
        pending,
        rendered: controller.renderedProvenance,
        window: projection.window,
        reference: projection.reference ?? reference,
        loadedProjection: projection.loadedProjection,
        windowReadBusy: projection.windowReadBusy
      })
      events.push(readiness)
      if (readiness !== 'ready') return
      let attempt: ReturnType<typeof attemptFirstPosition>
      try {
        attempt = attemptFirstPosition(controller, pending, live)
      } catch {
        attempt = 'refused'
      }
      events.push(attempt)
      if (attempt === 'refused' || attempt === 'unplaced') return
      if ((controller.currentPhase as string) === 'terminal') return
      if (!controller.isActivationSession) controller.revealed(pending.epoch)
    }, [
      controller,
      controller.currentPhase,
      controller.currentEpoch,
      seq,
      projection.window,
      projection.loadedProjection,
      projection.windowReadBusy,
      projection.reference,
      reference
    ])
    return null
  }

  describe('target-projection readiness (atomic-visibility boundary)', () => {
    const session = { topicId: 'A', routeId: null, epoch: 7 }
    const rendered: Pick<RenderedProvenance, 'epoch' | 'topicId' | 'routeId' | 'windowId'> = {
      epoch: 7,
      topicId: 'A',
      routeId: null,
      windowId: 'm1::m2::2'
    }
    const rows = [
      { id: 'm2', topicId: 'A' },
      { id: 'm1', topicId: 'A' }
    ]

    it('classifies readiness from the commit facts (never from scroll geometry)', () => {
      const readiness = (
        input: Partial<Omit<Parameters<typeof resolveTargetProjectionReadiness>[0], 'pending' | 'rendered'>> & {
          rendered?: typeof rendered | null
        }
      ): string => {
        const window = input.window === undefined ? projectionWindow(rows) : input.window
        return resolveTargetProjectionReadiness({
          pending: session,
          rendered:
            input.rendered === undefined
              ? window
                ? { ...rendered, windowId: windowIdentity(window) }
                : rendered
              : input.rendered,
          window,
          reference: input.reference,
          loadedProjection: input.loadedProjection === undefined ? rows : input.loadedProjection,
          windowReadBusy: input.windowReadBusy ?? false
        })
      }

      // Not-yet-observed target projection.
      expect(readiness({ window: null })).toBe('waiting')
      expect(readiness({ rendered: null })).toBe('waiting')
      // A rendered provenance from another session never authorizes placement.
      expect(readiness({ rendered: { ...rendered, epoch: 6 } })).toBe('waiting')
      expect(readiness({ rendered: { ...rendered, topicId: 'B' } })).toBe('waiting')
      expect(readiness({ rendered: { ...rendered, routeId: 'branch' } })).toBe('waiting')
      // Own committed non-empty projection: ready on its own facts. An unrelated
      // in-flight read (topic-level window read / pagination) never delays it.
      expect(readiness({})).toBe('ready')
      expect(readiness({ windowReadBusy: true })).toBe('ready')
      // Rows owned by the OUTGOING topic are the stale pre-commit window: a
      // topic return keeps the old window in viewportState until the target
      // window lands, whatever its length.
      expect(readiness({ window: projectionWindow([{ id: 'm9', topicId: 'B' }]) })).toBe('waiting')
      expect(readiness({ window: projectionWindow([{ id: 'm9' }]) })).toBe('waiting')
      // Even an own/mixed row set cannot authorize a previous window identity.
      expect(readiness({ rendered: { ...rendered, windowId: 'old::old::2' } })).toBe('waiting')
      expect(
        readiness({
          window: projectionWindow([
            { id: 'a2', topicId: 'A' },
            { id: 'b1', topicId: 'B' }
          ]),
          rendered: { ...rendered, windowId: 'old::old::2' },
          reference: {
            sourceTopicId: 'B',
            sourceBranchId: null,
            anchorMessageId: 'b1',
            sourceName: 'B',
            status: 'available',
            boundaryMessageId: 'b1'
          }
        })
      ).toBe('waiting')
      // Empty own window: only an idle read plus a proven-empty resident
      // projection is an observed empty. A read in flight is still transient.
      expect(readiness({ window: projectionWindow([]), windowReadBusy: true })).toBe('waiting')
      expect(readiness({ window: projectionWindow([]) })).toBe('waiting')
      expect(readiness({ window: projectionWindow([]), loadedProjection: undefined })).toBe('waiting')
      // Genuine observed empty (empty topic / deletion fallback tail).
      expect(readiness({ window: projectionWindow([]), loadedProjection: [] })).toBe('observed-empty')
    })

    it('accepts the current mixed target suffix plus Main-attested foreign prefix', () => {
      const reference: HistoryReferenceMeta = {
        sourceTopicId: 'B',
        sourceBranchId: null,
        anchorMessageId: 'b2',
        sourceName: 'B',
        status: 'available',
        boundaryMessageId: 'b2'
      }
      const mixed = projectionWindow([
        { id: 'a2', topicId: 'A' },
        { id: 'a1', topicId: 'A' },
        { id: 'b2', topicId: 'B' },
        { id: 'b1', topicId: 'B' }
      ])
      const resolve = (window: ReturnType<typeof projectionWindow>, ref: HistoryReferenceMeta | null | undefined) =>
        resolveTargetProjectionReadiness({
          pending: session,
          rendered: { ...rendered, windowId: windowIdentity(window) },
          window,
          reference: ref,
          loadedProjection: window.displayMessages,
          windowReadBusy: false
        })

      expect(resolve(mixed, reference)).toBe('ready')
      // A newly-created reference target has a legal empty owned suffix.
      expect(resolve(projectionWindow(mixed.displayMessages.slice(2)), reference)).toBe('ready')
      // Foreign rows are never accepted without the matching Main relation.
      expect(resolve(mixed, undefined)).toBe('waiting')
      expect(resolve(mixed, { ...reference, status: 'missing', boundaryMessageId: null })).toBe('waiting')
      expect(resolve(mixed, { ...reference, sourceTopicId: 'X' })).toBe('waiting')
      expect(resolve(mixed, { ...reference, boundaryMessageId: 'b1' })).toBe('waiting')
      // Target rows after the foreign prefix are not a canonical owned suffix.
      expect(
        resolve(
          projectionWindow([
            { id: 'a2', topicId: 'A' },
            { id: 'b1', topicId: 'B' },
            { id: 'a1', topicId: 'A' }
          ]),
          { ...reference, boundaryMessageId: 'b1' }
        )
      ).toBe('waiting')
    })

    it('rejects stale foreign and mixed windows for every session identity dimension', () => {
      const reference: HistoryReferenceMeta = {
        sourceTopicId: 'B',
        sourceBranchId: null,
        anchorMessageId: 'b2',
        sourceName: 'B',
        status: 'available',
        boundaryMessageId: 'b2'
      }
      const resolve = (rows: Array<{ id: string; topicId: string }>, provenance: Partial<typeof rendered> = {}) => {
        const window = projectionWindow(rows)
        return resolveTargetProjectionReadiness({
          pending: session,
          rendered: { ...rendered, windowId: windowIdentity(window), ...provenance },
          window,
          reference,
          loadedProjection: rows,
          windowReadBusy: false
        })
      }
      const foreign = [
        { id: 'b2', topicId: 'B' },
        { id: 'b1', topicId: 'B' }
      ]
      const mixed = [{ id: 'a2', topicId: 'A' }, { id: 'a1', topicId: 'A' }, ...foreign]
      for (const rows of [foreign, mixed]) {
        expect(resolve(rows)).toBe('ready')
        expect(resolve(rows, { epoch: rendered.epoch + 1 })).toBe('waiting')
        expect(resolve(rows, { topicId: 'C' })).toBe('waiting')
        expect(resolve(rows, { routeId: 'branch' })).toBe('waiting')
        expect(resolve(rows, { windowId: 'old::old::2' })).toBe('waiting')
      }
    })

    it('accepts nested mixed windows in nearest-first canonical layer order', () => {
      const layerA: HistoryReferenceChainLayer = {
        targetTopicId: 'B',
        sourceTopicId: 'C',
        sourceBranchId: null,
        anchorMessageId: 'c2',
        sourceName: 'C',
        status: 'available',
        boundaryMessageId: 'c2'
      }
      const layerB: HistoryReferenceChainLayer = {
        targetTopicId: 'A',
        sourceTopicId: 'B',
        sourceBranchId: null,
        anchorMessageId: 'b2',
        sourceName: 'B',
        status: 'available',
        boundaryMessageId: 'b2'
      }
      const reference: HistoryReferenceMeta = { ...layerB, layers: [layerB, layerA] }
      const nested = projectionWindow([
        { id: 'a2', topicId: 'A' },
        { id: 'a1', topicId: 'A' },
        { id: 'b2', topicId: 'B' },
        { id: 'b1', topicId: 'B' },
        { id: 'c2', topicId: 'C' },
        { id: 'c1', topicId: 'C' }
      ])
      const resolve = (window: ReturnType<typeof projectionWindow>, ref: HistoryReferenceMeta) =>
        resolveTargetProjectionReadiness({
          pending: session,
          rendered: { ...rendered, windowId: windowIdentity(window) },
          window,
          reference: ref,
          loadedProjection: window.displayMessages,
          windowReadBusy: false
        })

      expect(resolve(nested, reference)).toBe('ready')
      // The captured B endpoint may truncate the upstream C layer entirely.
      expect(resolve(projectionWindow(nested.displayMessages.slice(0, 4)), reference)).toBe('ready')
      // The endpoint may itself be inherited from C, leaving no B-owned rows.
      expect(
        resolve(projectionWindow(nested.displayMessages.slice(0, 2).concat(nested.displayMessages.slice(4))), reference)
      ).toBe('ready')
      // Reversed layers and a broken chain are not authority for foreign rows.
      expect(resolve(nested, { ...reference, layers: [layerA, layerB] })).toBe('waiting')
      expect(resolve(nested, { ...reference, layers: [{ ...layerA, targetTopicId: 'X' }, layerB] })).toBe('waiting')
      // The top-level relation and its nearest layer must describe the same source/boundary.
      expect(resolve(nested, { ...reference, sourceTopicId: 'X' })).toBe('waiting')
      expect(resolve(nested, { ...reference, boundaryMessageId: 'b1' })).toBe('waiting')
    })

    it('A→B→A return: transient empty projection stays hidden, then places the saved bottom once the target rows are positioned', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      try {
        const ids = Array.from({ length: 10 }, (_, i) => `rrp-msg-00${790 + i}`).reverse()
        const writes = countScrollWrites(container).writes
        // B is the displayed route; the user returns to the long topic A whose
        // window is NOT resident (A→B→A). A's saved viewport is the real bottom.
        const c = new RouteViewportController({ topicId: 'B', route: null })
        const saved = {
          scrollTop: 2314,
          messageId: 'rrp-msg-00798',
          intraRowOffset: -120.109375,
          isAtBottom: true
        }
        const ret = c.request({ kind: 'top', topicId: 'A', targetRoute: null, saved })
        expect(c.displayedRoute).toEqual({ topicId: 'B', route: null })
        // The return commits the target window identity pre-paint (still hidden).
        expect(
          c.applyTransitionWindow(ret.epoch, { topicId: 'A', route: null }, 'rrp-msg-00790::rrp-msg-00799::10')
        ).toBe(true)
        expect(c.currentPhase).toBe('positioning')

        const pendingHost: { current: FirstPlacementPending | null } = {
          current: { topicId: 'A', routeId: null, epoch: ret.epoch, plan: { kind: 'bottom' }, outcome: null }
        }
        const events: string[] = []
        const loadedProjection = ids.map((id) => ({ id, topicId: 'A' }))
        const host = { current: container as HTMLElement | null }
        const view = render(
          <ReadinessDeliveryHarness
            controller={c}
            containerHost={host}
            pendingHost={pendingHost}
            seq={0}
            projection={{ window: projectionWindow([]), loadedProjection, windowReadBusy: true }}
            events={events}
          />
        )
        // Transient pre-commit empty while the target's window read is in flight:
        // hidden-owned, plan unconsumed, no write, no reveal, B stays displayed.
        expect(events).toEqual(['waiting'])
        expect(pendingHost.current?.outcome).toBeNull()
        expect(c.currentPhase).toBe('positioning')
        expect(c.displayedRoute).toEqual({ topicId: 'B', route: null })
        expect(writes()).toBe(0)

        // Read completed, projection still not committed: the loaded projection
        // already holds the content the target window must show.
        view.rerender(
          <ReadinessDeliveryHarness
            controller={c}
            containerHost={host}
            pendingHost={pendingHost}
            seq={1}
            projection={{ window: projectionWindow([]), loadedProjection, windowReadBusy: false }}
            events={events}
          />
        )
        expect(events).toEqual(['waiting', 'waiting'])
        expect(pendingHost.current?.outcome).toBeNull()
        expect(writes()).toBe(0)

        // The projection commit: the target window and its rows land in the same
        // React commit (rows installed before the layout pass reads the port).
        installStreamedRows(container, ids, { scrollHeight: 2717, clientHeight: 403 })
        const committedProjection: ProjectionCommit = {
          window: projectionWindow(loadedProjection),
          loadedProjection,
          windowReadBusy: false
        }
        view.rerender(
          <ReadinessDeliveryHarness
            controller={c}
            containerHost={host}
            pendingHost={pendingHost}
            seq={2}
            projection={committedProjection}
            events={events}
          />
        )
        expect(events).toEqual(['waiting', 'waiting', 'ready', 'placed'])
        expect(container.querySelectorAll('#message-rrp-msg-00790')).toHaveLength(1)
        expect(writes()).toBe(1)
        expect(container.scrollTop).toBe(2314)
        expect(pendingHost.current?.outcome).toBe('placed')
        expect(c.currentPhase).toBe('aligned')
        expect(c.displayedRoute).toEqual({ topicId: 'A', route: null })
        view.unmount()
      } finally {
        container.remove()
      }
    })

    it('same-route short real content with zero scroll travel is a legal bottom placement', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      try {
        const ids = ['s2', 's1']
        // Short real content: the port has no travel at all (scrollHeight ==
        // clientHeight). Zero travel is legal content, not a missing projection.
        installStreamedRows(container, ids, { scrollHeight: 403, clientHeight: 403 })
        const writes = countScrollWrites(container).writes
        const c = new RouteViewportController({ topicId: 't1', route: null })
        const req = c.request({
          kind: 'top',
          topicId: 't1',
          targetRoute: null,
          saved: { scrollTop: 0, messageId: null, intraRowOffset: null, isAtBottom: true }
        })
        expect(c.applyTransitionWindow(req.epoch, { topicId: 't1', route: null }, 's1::s2::2')).toBe(true)
        const pendingHost: { current: FirstPlacementPending | null } = {
          current: { topicId: 't1', routeId: null, epoch: req.epoch, plan: { kind: 'bottom' }, outcome: null }
        }
        const events: string[] = []
        const projection = {
          window: projectionWindow(ids.map((id) => ({ id, topicId: 't1' }))),
          loadedProjection: ids,
          windowReadBusy: false
        }
        render(
          <ReadinessDeliveryHarness
            controller={c}
            containerHost={{ current: container }}
            pendingHost={pendingHost}
            seq={0}
            projection={projection}
            events={events}
          />
        )
        expect(events).toEqual(['ready', 'placed'])
        expect(writes()).toBe(0)
        expect(container.scrollTop).toBe(0)
        expect(c.currentPhase).toBe('aligned')
        expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })
      } finally {
        container.remove()
      }
    })

    it('A→B→A stale mixed window never reveals; the current recommit reveals once', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      try {
        const rows = [
          { id: 'a2', topicId: 'A' },
          { id: 'a1', topicId: 'A' },
          { id: 'b1', topicId: 'B' }
        ]
        const reference: HistoryReferenceMeta = {
          sourceTopicId: 'B',
          sourceBranchId: null,
          anchorMessageId: 'b1',
          sourceName: 'B',
          status: 'available',
          boundaryMessageId: 'b1'
        }
        installStreamedRows(
          container,
          rows.map((row) => row.id),
          { scrollHeight: 1000, clientHeight: 400 }
        )
        const writes = countScrollWrites(container).writes
        const c = new RouteViewportController({ topicId: 'B', route: null })
        const ret = c.request({
          kind: 'top',
          topicId: 'A',
          targetRoute: null,
          saved: { scrollTop: 600, messageId: 'a1', intraRowOffset: -10, isAtBottom: false }
        })
        expect(c.applyTransitionWindow(ret.epoch, { topicId: 'A', route: null }, 'a1::a2::2')).toBe(true)
        // A newer navigation supersedes the return before its projection lands.
        const newer = c.request({ kind: 'top', topicId: 'A', targetRoute: null })
        expect(newer.epoch).toBeGreaterThan(ret.epoch)
        const pendingHost: { current: FirstPlacementPending | null } = {
          current: { topicId: 'A', routeId: null, epoch: ret.epoch, plan: { kind: 'bottom' }, outcome: null }
        }
        const events: string[] = []
        const projection = {
          window: projectionWindow(rows),
          loadedProjection: rows,
          windowReadBusy: false,
          reference
        }
        const view = render(
          <ReadinessDeliveryHarness
            controller={c}
            containerHost={{ current: container }}
            pendingHost={pendingHost}
            seq={0}
            projection={projection}
            events={events}
          />
        )
        expect(events).toEqual([])
        expect(pendingHost.current?.outcome).toBeNull()
        expect(writes()).toBe(0)
        expect(c.displayedRoute).toEqual({ topicId: 'B', route: null })
        expect(c.currentEpoch).toBe(newer.epoch)

        // Only the current epoch's exact mixed-window recommit may place/reveal.
        expect(
          c.applyTransitionWindow(newer.epoch, { topicId: 'A', route: null }, windowIdentity(projection.window))
        ).toBe(true)
        pendingHost.current = {
          topicId: 'A',
          routeId: null,
          epoch: newer.epoch,
          plan: { kind: 'bottom' },
          outcome: null
        }
        view.rerender(
          <ReadinessDeliveryHarness
            controller={c}
            containerHost={{ current: container }}
            pendingHost={pendingHost}
            seq={1}
            projection={projection}
            events={events}
          />
        )
        expect(events).toEqual(['ready', 'placed'])
        expect(writes()).toBe(1)
        expect(c.displayedRoute).toEqual({ topicId: 'A', route: null })
        view.unmount()
      } finally {
        container.remove()
      }
    })
  })
})
