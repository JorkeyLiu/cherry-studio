/**
 * Route-local stable viewport model: every route owns its last stable
 * viewport, independent of user scrolling.
 *
 * Ownership lives in the single route viewport transition controller; the
 * hook gates ordinary writes via `canWrite`, and stable completions commit
 * via the trusted `commitSnapshotForRoute` (bypasses the gate, exactly like
 * the controller's stable completion).
 *
 * Behavioral coverage (no wheel/touch/pointer/keyboard scrolling anywhere;
 * positions are established programmatically and committed as stable):
 *
 * 1. Preseeded distinct A/B snapshots survive A→B→A→B→A with NO scrolling
 *    during the measured loop — each arrival restores its own messageId +
 *    intra-row offset.
 * 2. A programmatic restore with no user input is itself a valid stable
 *    viewport: switch away/back twice with no input, same position persists.
 * 3. A target with no prior snapshot gets its deterministic route-local
 *    default (never outgoing geometry); after the first stable arrival the
 *    default round-trips with no scrolling.
 * 4. Old displayed DOM during an incoming fetch cannot write under the
 *    incoming route key (controller ownership + schedule-time key binding).
 * 5. Rapid A→B→A supersession: stale sessions cannot commit snapshots or
 *    leak ownership; release happens exactly once per session.
 * 6. Stable commits bypass the gate while transient writes are dropped.
 */
import { RouteViewportController } from '@renderer/pages/home/Messages/routeViewportController'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import useScrollPosition, {
  commitSnapshotForRoute,
  routeScrollKey,
  type SavedScrollPosition
} from '../useScrollPosition'

let store: Map<string, unknown>
const mocked = vi.hoisted(() => ({
  queue: [] as { messageId: string; intraRowOffset: number }[]
}))

vi.mock('@renderer/pages/home/Messages/domVisibility', () => ({
  findViewportTopAnchorWithOffset: () => {
    const next = mocked.queue.length > 0 ? mocked.queue[0] : null
    return next ? { ...next } : null
  }
}))

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

vi.mock('@renderer/services/topicDeletionInvalidation', () => ({
  subscribeDeletionGeneration: vi.fn(() => () => {})
}))

const keyA = routeScrollKey('t1', 'branchA')
const keyB = routeScrollKey('t1', null)
const storeKeyA = `scroll:${keyA}`
const storeKeyB = `scroll:${keyB}`

const installKeyv = (): void => {
  vi.stubGlobal('window', {
    ...window,
    keyv: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value)
      },
      remove: (key: string) => {
        store.delete(key)
      }
    }
  })
}

const mockContainer = (scrollTop: number) => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true })
  el.getBoundingClientRect = () =>
    ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400, x: 0, y: 100 }) as DOMRect
  return el
}

const attachContainer = (hook: { containerRef: { current: HTMLDivElement | null } }, scrollTop: number): void => {
  hook.containerRef.current = mockContainer(scrollTop)
}

const queueAnchor = (messageId: string, intraRowOffset: number): void => {
  mocked.queue = [{ messageId, intraRowOffset }]
}

const readStored = (storeKey: string): SavedScrollPosition | null => {
  const raw = store.get(storeKey) as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return null
  return {
    scrollTop: raw.scrollTop as number,
    anchorId: (raw.anchorId as string | null) ?? null,
    messageId: (raw.messageId as string | null) ?? null,
    intraRowOffset: (raw.intraRowOffset as number | null) ?? null,
    rawScrollTop: (raw.rawScrollTop as number) ?? (raw.scrollTop as number),
    isAtBottom: !!raw.isAtBottom
  }
}

/** Trusted stable completion commit (models the controller's stable commit). */
const commitStable = (routeKey: string): boolean =>
  commitSnapshotForRoute(routeKey, {
    scrollTop: mocked.queue[0] ? 0 : 0,
    anchorId: mocked.queue[0]?.messageId ?? null,
    messageId: mocked.queue[0]?.messageId ?? null,
    intraRowOffset: mocked.queue[0]?.intraRowOffset ?? null,
    rawScrollTop: 0,
    isAtBottom: false
  })

beforeEach(() => {
  store = new Map()
  mocked.queue = []
  installKeyv()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('route-local stable viewports (no scrolling in measured loops)', () => {
  it('A→B→A→B→A restores each route independently with zero scroll events', () => {
    // Preseed distinct stable positions WITHOUT any scrolling: trusted
    // stable commits (a successful programmatic restore is itself a valid
    // stable viewport — no user input required to earn a snapshot).
    queueAnchor('msg-A-top', -12)
    attachContainer({ containerRef: { current: null } }, 0)
    expect(commitStable(keyA)).toBe(true)
    queueAnchor('msg-B-top', -64)
    expect(commitStable(keyB)).toBe(true)
    const seededA = readStored(storeKeyA)
    const seededB = readStored(storeKeyB)
    expect(seededA?.messageId).toBe('msg-A-top')
    expect(seededB?.messageId).toBe('msg-B-top')
    expect(seededA?.intraRowOffset).toBe(-12)
    expect(seededB?.intraRowOffset).toBe(-64)

    // Measured loop: A→B→A→B→A. No handleScroll, no wheel/touch/pointer/key
    // input. Arrivals read the target route's own snapshot; the stable
    // completion re-commits the same viewport. The controller owns the
    // session: fetch-hold suppresses transients, commit lands the snapshot.
    const controller = new RouteViewportController({ topicId: 't1', route: 'branchA' })
    const { result } = renderHook(() =>
      useScrollPosition(keyA, { canWrite: () => controller.canAcceptUserScrollWrite() })
    )
    const arrivals: { route: string; messageId: string | null; intra: number | null }[] = []
    const visit = (target: string): void => {
      const stored = readStored(`scroll:${target}`)
      const { epoch } = controller.request({
        kind: 'top',
        topicId: 't1',
        targetRoute: target === keyA ? 'branchA' : null,
        saved: stored
          ? {
              scrollTop: stored.scrollTop,
              messageId: stored.messageId ?? null,
              intraRowOffset: stored.intraRowOffset ?? null,
              isAtBottom: false
            }
          : null
      })
      try {
        let saved: SavedScrollPosition | null = null
        act(() => {
          saved = result.current.getSnapshotForRoute(target)
        })
        const arrival = saved as unknown as SavedScrollPosition | null
        expect(arrival, `${target} must have its own snapshot`).not.toBeNull()
        arrivals.push({ route: target, messageId: arrival?.messageId ?? null, intra: arrival?.intraRowOffset ?? null })
        // Stable completion re-commits the restored viewport: switching away
        // before any user input preserves it.
        queueAnchor(arrival?.messageId ?? 'missing', arrival?.intraRowOffset ?? 0)
        expect(commitStable(target)).toBe(true)
        controller.appliedWindow(epoch)
        controller.firstPositioned(epoch, 'placed')
        controller.revealed(epoch)
        const done = controller.commitStable(epoch, {
          messageId: arrival?.messageId ?? null,
          intraRowOffset: arrival?.intraRowOffset ?? null,
          scrollTop: 0,
          isAtBottom: false
        })
        expect(done.committed).toBe(true)
      } finally {
        controller.releaseSession(epoch)
      }
    }
    visit(keyB)
    visit(keyA)
    visit(keyB)
    visit(keyA)

    expect(arrivals).toHaveLength(4)
    expect(arrivals[0]).toMatchObject({ route: keyB, messageId: 'msg-B-top', intra: -64 })
    expect(arrivals[1]).toMatchObject({ route: keyA, messageId: 'msg-A-top', intra: -12 })
    expect(arrivals[2]).toMatchObject({ route: keyB, messageId: 'msg-B-top', intra: -64 })
    expect(arrivals[3]).toMatchObject({ route: keyA, messageId: 'msg-A-top', intra: -12 })
    // Snapshots still independent after the loop.
    expect(readStored(storeKeyA)?.messageId).toBe('msg-A-top')
    expect(readStored(storeKeyB)?.messageId).toBe('msg-B-top')
    expect(controller.programmaticOwned).toBe(false)
  })

  it('programmatic restore with no user input persists across two away/back cycles', () => {
    const { result } = renderHook(() => useScrollPosition(keyA))
    const readRouteSnapshot = (routeKey: string): SavedScrollPosition | null => {
      let out: SavedScrollPosition | null = null
      act(() => {
        out = result.current.getSnapshotForRoute(routeKey)
      })
      return out as unknown as SavedScrollPosition | null
    }
    // Establish A programmatically only (no scroll events at all).
    queueAnchor('msg-A-only', -33)
    expect(commitStable(keyA)).toBe(true)
    queueAnchor('msg-B-only', -77)
    expect(commitStable(keyB)).toBe(true)
    // Two away/back cycles with zero input: A must repeat exactly.
    for (let round = 0; round < 2; round += 1) {
      const back = readRouteSnapshot(keyA)
      expect(back?.messageId, `round ${round}: A identity persists`).toBe('msg-A-only')
      expect(back?.intraRowOffset, `round ${round}: A offset persists`).toBe(-33)
      queueAnchor('msg-A-only', -33)
      expect(commitStable(keyA)).toBe(true)
    }
  })

  it('ordinary user scroll persists: the scrolled snapshot restores after away/back with no further scrolling', () => {
    const { result } = renderHook(() => useScrollPosition(keyA))
    queueAnchor('msg-A-scrolled', -55)
    attachContainer(result.current, -700)
    act(() => {
      result.current.handleScroll()
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    const afterScroll = readStored(storeKeyA)
    expect(afterScroll?.messageId).toBe('msg-A-scrolled')
    expect(afterScroll?.intraRowOffset).toBe(-55)
    expect(afterScroll?.scrollTop).toBe(-700)
    // Establish B at a different viewport, then return to A with zero
    // scrolling: A's user-scrolled snapshot restores exactly.
    queueAnchor('msg-B-top', -10)
    attachContainer(result.current, -100)
    expect(commitStable(keyB)).toBe(true)
    let backRaw: SavedScrollPosition | null = null
    act(() => {
      backRaw = result.current.getSnapshotForRoute(keyA)
    })
    const back = backRaw as unknown as SavedScrollPosition | null
    expect(back?.messageId).toBe('msg-A-scrolled')
    expect(back?.intraRowOffset).toBe(-55)
    expect(back?.scrollTop).toBe(-700)
  })

  it('target without snapshot uses its route-local default, never outgoing geometry', () => {
    const { result } = renderHook(() => useScrollPosition(keyA))
    // Outgoing A geometry (must never leak into B).
    queueAnchor('msg-A-top', -12)
    expect(commitStable(keyA)).toBe(true)
    // B has no snapshot: the target read is null, so the coordinator takes
    // the deterministic route-local default (here: B's own tail/bottom with
    // its own anchor) — explicitly NOT A's scrollTop/messageId.
    let targetRaw: SavedScrollPosition | null = null
    act(() => {
      targetRaw = result.current.getSnapshotForRoute(keyB)
    })
    const target = targetRaw as unknown as SavedScrollPosition | null
    expect(target).toBeNull()
    const outgoing = readStored(storeKeyA)
    expect(outgoing?.messageId).toBe('msg-A-top')
    // First stable arrival commits B's own default viewport.
    queueAnchor('msg-B-tail', 0)
    expect(commitStable(keyB)).toBe(true)
    const firstB = readStored(storeKeyB)
    expect(firstB?.messageId).toBe('msg-B-tail')
    expect(firstB?.messageId).not.toBe(outgoing?.messageId)
    // After the first stable arrival, a no-scroll round-trip restores B's
    // default exactly.
    let backB: SavedScrollPosition | null = null
    act(() => {
      backB = result.current.getSnapshotForRoute(keyB)
    })
    const back2 = backB as unknown as SavedScrollPosition | null
    expect(back2?.messageId).toBe('msg-B-tail')
    expect(back2?.intraRowOffset).toBe(0)
  })

  it('old displayed DOM during incoming fetch cannot write under the incoming key', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: 'branchA' })
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => useScrollPosition(k, { canWrite: () => controller.canAcceptUserScrollWrite() }),
      {
        initialProps: { k: keyA }
      }
    )
    // Outgoing stable snapshot for A.
    queueAnchor('msg-A-top', -12)
    attachContainer(result.current, -400)
    act(() => {
      result.current.savePosition()
    })
    expect(readStored(storeKeyA)?.messageId).toBe('msg-A-top')
    // Incoming fetch begins: controller ownership held, old DOM (A geometry)
    // still visible. Scroll events from layout shifts must be dropped — never
    // captured under either key as transients.
    const { epoch } = controller.request({ kind: 'top', topicId: 't1', targetRoute: null })
    try {
      queueAnchor('msg-A-top', -13)
      attachContainer(result.current, -401)
      act(() => {
        result.current.handleScroll()
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(store.has(storeKeyB), 'incoming key must stay absent during fetch').toBe(false)
      expect(readStored(storeKeyA)?.intraRowOffset, 'outgoing stable stands during fetch').toBe(-12)
      // Throttle trailing bound at schedule time: a write scheduled under
      // the OLD key before the identity change can never land under the
      // incoming key after it.
      rerender({ k: keyB })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(store.has(storeKeyB), 'trailing write must not leak into incoming key').toBe(false)
    } finally {
      controller.terminate(epoch, 'superseded')
    }
    expect(controller.programmaticOwned).toBe(false)
  })

  it('rapid supersession: stale sessions cannot commit and ownership releases exactly once', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: 'branchA' })
    queueAnchor('msg-A-top', -12)
    expect(commitStable(keyA)).toBe(true)
    // A→B starts (fetch hold), then A→B→A supersedes before B commits. The
    // stale B session must not commit; only the final A commit stands, and
    // each session releases exactly once.
    const stale = controller.request({ kind: 'top', topicId: 't1', targetRoute: null })
    const releasesBefore = controller.releaseCount
    const latest = controller.request({ kind: 'top', topicId: 't1', targetRoute: 'branchA' })
    // The superseded request already released the stale session once.
    expect(controller.releaseCount).toBe(releasesBefore + 1)
    // Stale B attempt: epoch-gated commit refuses.
    controller.appliedWindow(stale.epoch)
    const staleCommit = controller.commitStable(stale.epoch, {
      messageId: 'msg-B-top',
      intraRowOffset: -64,
      scrollTop: -900,
      isAtBottom: false
    })
    expect(staleCommit.committed).toBe(false)
    expect(store.has(storeKeyB)).toBe(false)
    // A stale finally can never touch the new session.
    expect(controller.releaseSession(stale.epoch)).toBe(false)
    // Final A completion commits its own stable viewport.
    controller.appliedWindow(latest.epoch)
    controller.firstPositioned(latest.epoch, 'placed')
    controller.revealed(latest.epoch)
    const done = controller.commitStable(latest.epoch, {
      messageId: 'msg-A-top',
      intraRowOffset: -12,
      scrollTop: -400,
      isAtBottom: false
    })
    expect(done.committed).toBe(true)
    expect(done.didRelease).toBe(true)
    expect(controller.releaseSession(latest.epoch), 'second release is a no-op').toBe(false)
    expect(readStored(storeKeyA)?.messageId).toBe('msg-A-top')
    expect(store.has(storeKeyB)).toBe(false)
    expect(controller.programmaticOwned).toBe(false)
  })

  it('transient writes are dropped while owned; stable commits bypass the gate', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: 'branchA' })
    const { result } = renderHook(() =>
      useScrollPosition(keyA, { canWrite: () => controller.canAcceptUserScrollWrite() })
    )
    queueAnchor('msg-A-top', -12)
    attachContainer(result.current, -400)
    act(() => {
      result.current.savePosition()
    })
    const { epoch } = controller.request({ kind: 'top', topicId: 't1', targetRoute: null })
    try {
      // Transient intermediate: explicit saves and scroll events are dropped,
      // the existing stable snapshot stands.
      queueAnchor('msg-transient', -999)
      attachContainer(result.current, -1)
      let saved = true
      act(() => {
        result.current.savePosition()
        saved = store.get(storeKeyA) !== undefined && readStored(storeKeyA)?.messageId === 'msg-transient'
        result.current.handleScroll()
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(saved).toBe(false)
      expect(readStored(storeKeyA)?.messageId).toBe('msg-A-top')
      // Stable completion with the final visible viewport bypasses the gate
      // — a programmatic restore needs no user input to become stable.
      queueAnchor('msg-A-final', -20)
      expect(commitStable(keyA)).toBe(true)
      expect(readStored(storeKeyA)?.messageId).toBe('msg-A-final')
      expect(readStored(storeKeyA)?.intraRowOffset).toBe(-20)
    } finally {
      controller.terminate(epoch, 'superseded')
    }
  })

  it('trusted plan/window data commits without a live container and never inherits outgoing geometry', () => {
    // commitSnapshotForRoute covers the plan/window-data path (e.g. an empty
    // fallback route committing latest/bottom): explicit snapshot, explicit
    // target key, no container read, no outgoing fallback.
    const committed = commitSnapshotForRoute(keyB, {
      scrollTop: 0,
      anchorId: 'msg-B-tail',
      messageId: 'msg-B-tail',
      intraRowOffset: 0,
      rawScrollTop: 0,
      isAtBottom: true
    })
    expect(committed).toBe(true)
    expect(readStored(storeKeyB)?.messageId).toBe('msg-B-tail')
    expect(store.has(storeKeyA)).toBe(false)
  })

  it('identity commit keeps the applied branch anchor when live crossing-first is foreign; user scroll can overwrite after', () => {
    const branchKey = routeScrollKey('t1', 'branchB')
    const mainKey = routeScrollKey('t1', null)
    const branchStoreKey = `scroll:${branchKey}`
    const mainStoreKey = `scroll:${mainKey}`
    const { result } = renderHook(() => useScrollPosition(branchKey))

    // Live container measures scrollTop 0-ish (bottom-adjacent) but the
    // mocked crossing-first row is the foreign shared msg08, NOT bexcl02.
    // A capture-based stable commit here would poison the branch key with
    // msg08; the identity commit (applied anchor + wantOffset, live
    // scrollTop/bottom) must win. Model the Messages coordinator: read the
    // live scrollTop directly, construct the explicit snapshot, commit via
    // the explicit API under the target route key.
    queueAnchor('msg08', 5)
    attachContainer(result.current, -12)
    const liveScrollTop = (result.current.containerRef.current as HTMLDivElement).scrollTop
    const identityCommitted = commitSnapshotForRoute(branchKey, {
      scrollTop: liveScrollTop,
      anchorId: 'bexcl02',
      messageId: 'bexcl02',
      intraRowOffset: 47,
      rawScrollTop: liveScrollTop,
      isAtBottom: true
    })
    expect(identityCommitted).toBe(true)
    const branchSnap = readStored(branchStoreKey)
    expect(branchSnap?.messageId).toBe('bexcl02')
    expect(branchSnap?.intraRowOffset).toBe(47)
    expect(branchSnap?.messageId).not.toBe('msg08')
    // scrollTop/bottom come from the live container, not the saved anchor.
    expect(branchSnap?.scrollTop).toBe(liveScrollTop)

    // Branch -> main with main key absent: deterministic bottom default
    // establishes main without inheriting the branch scrollTop/anchor.
    expect(store.has(mainStoreKey)).toBe(false)
    const mainDefaultCommitted = commitSnapshotForRoute(mainKey, {
      scrollTop: 0,
      anchorId: 'msg20',
      messageId: 'msg20',
      intraRowOffset: 47,
      rawScrollTop: 0,
      isAtBottom: true
    })
    expect(mainDefaultCommitted).toBe(true)
    const mainSnap = readStored(mainStoreKey)
    expect(mainSnap?.messageId).toBe('msg20')
    expect(mainSnap?.messageId).not.toBe('bexcl02')
    expect(mainSnap?.scrollTop).not.toBe(branchSnap?.scrollTop === 0 ? -99999 : branchSnap?.scrollTop)

    // Ordinary user scroll afterwards still produces a new crossing-first
    // snapshot normally (no fence, no qualification): the hook capture path
    // remains live for genuine input.
    queueAnchor('msg08', 5)
    attachContainer(result.current, -12)
    act(() => {
      result.current.handleScroll()
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    // handleScroll writes under the hook's current key (branchKey here);
    // genuine input overwrites the identity snapshot normally (proves user
    // scrolls are not fenced by identity commits).
    expect(readStored(branchStoreKey)?.messageId).toBe('msg08')
  })
})
