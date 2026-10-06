/**
 * Bounded send-bottom intent (same-route bottom transaction):
 * - SEND_MESSAGE topic guard: only the matching topic may reposition the
 *   displayed route; unrelated topic sends are ignored.
 * - Explicit send bottom suspends the prior row keeper to the bottom semantic
 *   BEFORE scrolling (`beginSendBottom`), scrolls through the currency-bound
 *   navigation (stale route/epoch or a later real wheel skips the write),
 *   then adopts the bottom through the gesture-free programmatic controller
 *   path (bottom takes priority over top-row identity: live anchor null).
 *   The keeper pins the bottom through insertion/stream layout instead of
 *   pulling back to the old reading position. A later genuine wheel cancels
 *   the pending bottom work and adopts the user's geometry; an owned restore
 *   is deferred to (never stolen) until it releases through its own API.
 * - Baseline `userTakeover` session semantics below are unchanged and kept as
 *   the no-gesture-requirement contrast (takeover without a live session
 *   still takes nothing).
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runMessageNavigationTransaction } from '../messageNavigation'
import type { SendBottomIntentDeps } from '../Messages'
import { runSendBottomIntent, shouldHandleSendMessageForTopic } from '../Messages'
import type { MessageWindow } from '../messageWindow'
import { RouteViewportContext, type RouteViewportContextValue, useStableVisualAnchor } from '../routeViewportContext'
import { RouteViewportController } from '../routeViewportController'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

let store: Map<string, unknown>

const driveStableMessage = (controller: RouteViewportController, messageId: string, offset: number): void => {
  const { epoch } = controller.request({
    kind: 'top',
    topicId: 't1',
    targetRoute: null,
    saved: { scrollTop: -400, messageId, intraRowOffset: offset, isAtBottom: false }
  })
  controller.appliedWindow(epoch)
  controller.firstPositioned(epoch, 'placed')
  controller.revealed(epoch)
  const out = controller.commitStable(epoch, { messageId, intraRowOffset: offset, scrollTop: -400, isAtBottom: false })
  expect(out.committed).toBe(true)
}

beforeEach(() => {
  store = new Map()
  document.body.innerHTML = ''
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

afterEach(() => {
  try {
    delete (window as unknown as { keyv?: unknown }).keyv
  } catch {}
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('SEND_MESSAGE topic guard', () => {
  it('handles matching topic and legacy payloads, ignores unrelated topics', () => {
    expect(shouldHandleSendMessageForTopic({ topicId: 't1' }, 't1')).toBe(true)
    expect(shouldHandleSendMessageForTopic({ topicId: 'other' }, 't1')).toBe(false)
    expect(shouldHandleSendMessageForTopic(undefined, 't1')).toBe(true)
    expect(shouldHandleSendMessageForTopic({} as { topicId?: string }, 't1')).toBe(true)
  })
})

describe('send bottom adoption replaces the retained reading anchor', () => {
  it('declare + takeover with the bottom measurement adopts bottom; old anchor no longer held', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })

    // Explicit send bottom snap measured at bottom (newest m3, isAtBottom).
    // Same single-writer path as handleScroll: declare, takeover, commit.
    const token = controller.declareUserIntent()
    const out = controller.userTakeover(
      { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true },
      undefined,
      token
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(out.routeKey).toBe('topic-t1::main')
    expect(out.snapshot).toMatchObject({ messageId: 'm3', isAtBottom: true })

    // The retained reading anchor (m2) is replaced by the bottom anchor (m3):
    // the keeper will now hold m3 through insertion/stream, never m2.
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm3',
      offset: -8
    })
    expect(controller.userIntentPending).toBe(true)
    expect(controller.noteInteractionScrollEnd(token)).toBe(true)
    expect(controller.userIntentPending).toBe(false)
  })

  it('takeover without a live session takes nothing (fail-closed, no anchor change)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const out = controller.userTakeover(
      { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true },
      undefined,
      undefined
    )
    expect(out.taken).toBe(false)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
  })
})

describe('programmatic bottom adoption (gesture-free, genuine sessions untouched)', () => {
  it('adopts bottom with no live session; bottom clears the row keeper, opens none, bumps no epoch', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const epoch = controller.currentEpoch
    const releases = controller.releaseCount
    const out = controller.adoptProgrammaticViewport(
      { topicId: 't1', route: null },
      { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true },
      { expectedEpoch: epoch }
    )
    expect(out.taken).toBe(true)
    if (!out.taken) return
    expect(out.routeKey).toBe('topic-t1::main')
    // Snapshot retains the measured identity for ADR resume; the live anchor
    // is bottom (null) so the keeper pins scrollTop 0, never the old row.
    expect(out.snapshot).toMatchObject({ messageId: 'm3', isAtBottom: true })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    expect(controller.userIntentPending).toBe(false)
    expect(controller.currentEpoch).toBe(epoch)
    expect(controller.releaseCount).toBe(releases)
    expect(controller.programmaticOwned).toBe(false)
  })

  it('beginSendBottom suspends the row keeper before scrolling (fail-closed while owned)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    expect(controller.beginSendBottom({ topicId: 't1', route: null }, { expectedEpoch: controller.currentEpoch })).toBe(
      true
    )
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    expect(controller.programmaticOwned).toBe(false)
    expect(controller.userIntentPending).toBe(false)

    const owned = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(owned, 'm2', -60)
    owned.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    expect(owned.beginSendBottom({ topicId: 't1', route: null })).toBe(false)
    expect(owned.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
  })

  it('rejects while a restore owns the viewport (no steal, no release, anchor kept)', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const { epoch } = controller.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    expect(controller.programmaticOwned).toBe(true)
    const releases = controller.releaseCount
    const out = controller.adoptProgrammaticViewport(
      { topicId: 't1', route: null },
      { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true },
      { expectedEpoch: controller.currentEpoch }
    )
    expect(out.taken).toBe(false)
    if (out.taken) return
    expect(out.reason).toBe('owned-active')
    expect(controller.programmaticOwned).toBe(true)
    expect(controller.releaseCount).toBe(releases)
    expect(controller.currentEpoch).toBe(epoch)
  })

  it('rejects on dirty provenance and on stale expected epoch', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    controller.syncDisplayed({ topicId: 't2', route: null })
    const dirty = controller.adoptProgrammaticViewport(
      { topicId: 't2', route: null },
      { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true }
    )
    expect(dirty.taken).toBe(false)

    const clean = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(clean, 'm2', -60)
    const stale = clean.adoptProgrammaticViewport(
      { topicId: 't1', route: null },
      { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true },
      { expectedEpoch: clean.currentEpoch + 99 }
    )
    expect(stale.taken).toBe(false)
    if (stale.taken) return
    expect(stale.reason).toBe('stale-epoch')
    expect(clean.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
  })

  it('a non-bottom programmatic adoption still holds the row anchor', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const out = controller.adoptProgrammaticViewport(
      { topicId: 't1', route: null },
      { messageId: 'm9', intraRowOffset: -12, scrollTop: -300, isAtBottom: false }
    )
    expect(out.taken).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm9',
      offset: -12
    })
  })

  it('preserves a genuine co-active wheel session; the later real scroll still adopts', () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const token = controller.declareUserIntent()
    const adopted = controller.adoptProgrammaticViewport(
      { topicId: 't1', route: null },
      { messageId: 'm3', intraRowOffset: -8, scrollTop: 0, isAtBottom: true }
    )
    expect(adopted.taken).toBe(true)
    // The genuine session stays live with its scroll count untouched (a
    // synthetic takeover would have incremented and later closed it).
    expect(controller.userIntentPending).toBe(true)
    expect(controller.activeInteractionToken?.interactionId).toBe(token.interactionId)
    expect(controller.activeInteractionScrollCount).toBe(0)
    // A subsequent real wheel scroll-away adopts normally through takeover.
    const wheel = controller.userTakeover(
      { messageId: 'm4', intraRowOffset: -5, scrollTop: -50, isAtBottom: false },
      undefined,
      token
    )
    expect(wheel.taken).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm4',
      offset: -5
    })
    expect(controller.noteInteractionScrollEnd(token)).toBe(true)
    expect(controller.userIntentPending).toBe(false)
  })
})

interface SequenceHarness {
  deps: SendBottomIntentDeps
  commits: {
    routeKey: string
    snapshot: { scrollTop: number; messageId: string | null; intraRowOffset: number | null; isAtBottom: boolean }
  }[]
  notify: ReturnType<typeof vi.fn>
  navigateSpy: ReturnType<typeof vi.fn>
  setTopicId: (v: string) => void
  setRoute: (v: string | null) => void
  setWindowId: (v: string | null) => void
  setUnmounted: (v: boolean) => void
  isSuppressed: () => boolean
}

const buildSequenceHarness = (
  controller: RouteViewportController,
  opts?: {
    navigate?: () => Promise<'success' | 'cancelled' | 'not-found'>
    snapshot?: () => {
      scrollTop: number
      messageId: string | null
      intraRowOffset: number | null
      isAtBottom: boolean
    } | null
  }
): SequenceHarness => {
  let topicId = 't1'
  let route: string | null = null
  let windowId: string | null = 'oldest::newest::10'
  let unmounted = false
  let suppressed = false
  const commits: SequenceHarness['commits'] = []
  const notify = vi.fn()
  const navigateSpy = vi.fn(async () => {
    if (opts?.navigate) return opts.navigate()
    return 'success' as const
  })
  const deps: SendBottomIntentDeps = {
    controller,
    navigateToBottom: navigateSpy,
    captureSnapshot:
      opts?.snapshot ?? (() => ({ scrollTop: 0, messageId: 'm3', intraRowOffset: -8, isAtBottom: true })),
    commitSnapshot: (routeKey, snapshot) => {
      commits.push({ routeKey, snapshot: { ...snapshot } })
    },
    notifyViewport: notify,
    setSuppressUserWrite: (v) => {
      suppressed = v
    },
    getSelectedTopicId: () => topicId,
    getSelectedRoute: () => route,
    getWindowId: () => windowId,
    getActiveInteractionId: () => {
      try {
        return controller.activeInteractionToken?.interactionId ?? null
      } catch {
        return null
      }
    },
    isUnmounted: () => unmounted
  }
  return {
    deps,
    commits,
    notify,
    navigateSpy,
    setTopicId: (v) => {
      topicId = v
    },
    setRoute: (v) => {
      route = v
    },
    setWindowId: (v) => {
      windowId = v
    },
    setUnmounted: (v) => {
      unmounted = v
    },
    isSuppressed: () => suppressed
  }
}

describe('runSendBottomIntent handler guards (actual sequence path)', () => {
  it('ignores an unrelated topic send without navigating or committing', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const h = buildSequenceHarness(controller)
    const res = await runSendBottomIntent({ topicId: 'other' }, 't1', h.deps)
    expect(res).toEqual({ outcome: 'ignored-unrelated-topic' })
    expect(h.navigateSpy).not.toHaveBeenCalled()
    expect(h.commits).toEqual([])
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm2',
      offset: -60
    })
  })

  it('completes the happy path with no gesture session and no write suppression', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const h = buildSequenceHarness(controller)
    const res = await runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    expect(res).toEqual({ outcome: 'completed-bottom-adopted', routeKey: 'topic-t1::main' })
    expect(h.navigateSpy).toHaveBeenCalledTimes(1)
    expect(h.commits).toHaveLength(1)
    expect(h.commits[0].routeKey).toBe('topic-t1::main')
    // Stored snapshot retains the measured identity for ADR resume; the live
    // anchor is bottom (null) so the keeper pins the bottom, never m2.
    expect(h.commits[0].snapshot).toMatchObject({ messageId: 'm3', isAtBottom: true })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    expect(controller.userIntentPending).toBe(false)
    expect(h.isSuppressed()).toBe(false)
    expect(h.notify).toHaveBeenCalled()
  })

  it('suspends the row keeper before navigating (pre-scroll bottom, no suppression)', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    let resolveNav!: (v: 'success' | 'cancelled' | 'not-found') => void
    const gate = new Promise<'success' | 'cancelled' | 'not-found'>((r) => {
      resolveNav = r
    })
    const h = buildSequenceHarness(controller, { navigate: () => gate })
    const pending = runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    await new Promise<void>((r) => setTimeout(r, 20))
    // The prior row keeper is already bottom-suspended while navigation is
    // still in flight — the keeper cannot pull back to m2 mid-transaction.
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    expect(h.navigateSpy).toHaveBeenCalledTimes(1)
    resolveNav('success')
    const res = await pending
    expect(res).toEqual({ outcome: 'completed-bottom-adopted', routeKey: 'topic-t1::main' })
    expect(h.commits).toHaveLength(1)
  })

  it('aborts when the topic switches across the async navigate (no commit, no release steal)', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    let resolveNav!: (v: 'success' | 'cancelled' | 'not-found') => void
    const gate = new Promise<'success' | 'cancelled' | 'not-found'>((r) => {
      resolveNav = r
    })
    const h = buildSequenceHarness(controller, { navigate: () => gate })
    const pending = runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    h.setTopicId('t2')
    resolveNav('success')
    const res = await pending
    expect(res).toEqual({ outcome: 'aborted', reason: 'topic-route-changed' })
    expect(h.commits).toEqual([])
    // Live anchor is the pre-scroll bottom suspension for the entry route;
    // no snapshot was committed and no ownership was released/stolen.
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
    expect(controller.programmaticOwned).toBe(false)
    expect(h.isSuppressed()).toBe(false)
  })

  it('a later genuine wheel during send wins: send aborts, user geometry adopts, session stays live', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    let resolveNav!: (v: 'success' | 'cancelled' | 'not-found') => void
    const gate = new Promise<'success' | 'cancelled' | 'not-found'>((r) => {
      resolveNav = r
    })
    const h = buildSequenceHarness(controller, { navigate: () => gate })
    const pending = runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    await new Promise<void>((r) => setTimeout(r, 20))
    // A real wheel arrives AFTER the send while navigation is in flight:
    // genuine input opens a live session (no synthetic gesture by send).
    const token = controller.declareUserIntent()
    resolveNav('success')
    const res = await pending
    expect(res).toEqual({ outcome: 'aborted', reason: 'user-intent' })
    expect(h.commits).toEqual([])
    // The genuine session is never closed by the aborted send; the user's
    // own scroll adopts normally through takeover (no held-bottom fight:
    // the keeper bottom-hold is gated on no live session).
    expect(controller.userIntentPending).toBe(true)
    const wheel = controller.userTakeover(
      { messageId: 'm4', intraRowOffset: -5, scrollTop: -50, isAtBottom: false },
      undefined,
      token
    )
    expect(wheel.taken).toBe(true)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm4',
      offset: -5
    })
    expect(controller.noteInteractionScrollEnd(token)).toBe(true)
    expect(controller.userIntentPending).toBe(false)
  })

  it('a real transaction rejects a stale scroll across awaits: route swap skips the DOM write', async () => {
    // Real transaction awaits (applyWindow + settle) with a route swap in
    // between: the scroll callback rechecks currency immediately before the
    // DOM mutation and skips the stale write to the new container.
    let liveRoute: string | null = null
    const scrollSpy = vi.fn()
    const result = await runMessageNavigationTransaction(
      { kind: 'bottom', source: 'imperative' },
      {
        begin: async () => true,
        isCurrent: () => true,
        cancelLoadsAndTimers: () => {},
        resolve: () => ({ kind: 'bottom' }),
        prepareWindow: () => ({}) as unknown as MessageWindow,
        applyWindow: async () => {
          liveRoute = 'b1'
          return true
        },
        getTargetStatus: () => 'visible' as const,
        revealTarget: async () => {},
        settleDom: async () => {},
        beginProgrammaticScroll: async () => true,
        scroll: (resolved) => {
          if (liveRoute !== null) return
          scrollSpy(resolved)
        },
        finish: () => {},
        cancel: () => {}
      }
    )
    expect(result).toBe('success')
    expect(scrollSpy).not.toHaveBeenCalled()

    // Control: without a swap the same transaction scrolls exactly once.
    const scrollOk = vi.fn()
    const ok = await runMessageNavigationTransaction(
      { kind: 'bottom', source: 'imperative' },
      {
        begin: async () => true,
        isCurrent: () => true,
        cancelLoadsAndTimers: () => {},
        resolve: () => ({ kind: 'bottom' }),
        prepareWindow: () => null,
        applyWindow: async () => true,
        getTargetStatus: () => 'visible' as const,
        revealTarget: async () => {},
        settleDom: async () => {},
        beginProgrammaticScroll: async () => true,
        scroll: (resolved) => {
          scrollOk(resolved)
        },
        finish: () => {},
        cancel: () => {}
      }
    )
    expect(ok).toBe('success')
    expect(scrollOk).toHaveBeenCalledTimes(1)
    expect(scrollOk).toHaveBeenCalledWith({ kind: 'bottom' })
  })

  it('aborts when the branch route switches across the async navigate', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    let resolveNav!: (v: 'success' | 'cancelled' | 'not-found') => void
    const gate = new Promise<'success' | 'cancelled' | 'not-found'>((r) => {
      resolveNav = r
    })
    const h = buildSequenceHarness(controller, { navigate: () => gate })
    const pending = runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    h.setRoute('b1')
    resolveNav('success')
    const res = await pending
    expect(res).toEqual({ outcome: 'aborted', reason: 'topic-route-changed' })
    expect(h.commits).toEqual([])
  })

  it('aborts on epoch supersession across the async navigate (new session untouched)', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    let resolveNav!: (v: 'success' | 'cancelled' | 'not-found') => void
    const gate = new Promise<'success' | 'cancelled' | 'not-found'>((r) => {
      resolveNav = r
    })
    const h = buildSequenceHarness(controller, { navigate: () => gate })
    const pending = runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    controller.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    resolveNav('success')
    const res = await pending
    expect(res).toEqual({ outcome: 'aborted', reason: 'epoch-superseded' })
    expect(h.commits).toEqual([])
    expect(controller.programmaticOwned).toBe(true)
  })

  it('sequences an owned restore without stealing it: defers until release, then adopts bottom once', async () => {
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const { epoch } = controller.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    expect(controller.programmaticOwned).toBe(true)
    const releasesBefore = controller.releaseCount
    const h = buildSequenceHarness(controller)
    const pending = runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    // The send intent must not navigate while the owner holds the viewport —
    // and it must not time out: after the previous 5s bound it stays queued.
    await new Promise<void>((r) => setTimeout(r, 150))
    expect(h.navigateSpy).not.toHaveBeenCalled()
    // The owner releases exactly once through its own API; the deferred send
    // then proceeds without adding a second release or a gesture session.
    controller.terminate(epoch, 'fail-visible')
    const res = await pending
    expect(res).toEqual({ outcome: 'completed-bottom-adopted', routeKey: 'topic-t1::main' })
    expect(controller.releaseCount).toBe(releasesBefore + 1)
    expect(controller.userIntentPending).toBe(false)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()
  }, 15000)
})

describe('send bottom keeper adoption (mounted keeper holds bottom, never the old anchor)', () => {
  const rects = new Map<string, { top: number; height: number }>()
  const containerRect = { top: 0, height: 600 }

  const mockRect = (el: HTMLElement, key: string): void => {
    el.getBoundingClientRect = () => {
      if (key === 'container') {
        return {
          top: containerRect.top,
          bottom: containerRect.top + containerRect.height,
          height: containerRect.height,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: containerRect.top,
          toJSON: () => ({})
        } as DOMRect
      }
      const spec = rects.get(key) ?? { top: 0, height: 40 }
      return {
        top: spec.top,
        bottom: spec.top + spec.height,
        height: spec.height,
        left: 0,
        right: 300,
        width: 300,
        x: 0,
        y: spec.top,
        toJSON: () => ({})
      } as DOMRect
    }
  }

  const renderKeeper = (
    controller: RouteViewportController,
    ref: { current: HTMLDivElement | null },
    version: number
  ): { rerender: (version: number) => void; unmount: () => void } => {
    const Harness = ({ containerRef }: { containerRef: { current: HTMLDivElement | null } }) => {
      useStableVisualAnchor(containerRef as React.RefObject<HTMLElement | null>)
      return null
    }
    const value = (v: number): RouteViewportContextValue => ({
      controller,
      version: v,
      connectionGeneration: 0,
      notifyChanged: () => {},
      freezeDisplayed: () => false,
      readSnapshot: () => null,
      requestTopRoute: () => ({ epoch: controller.currentEpoch, fresh: true }),
      registerCapturer: () => {},
      viewportPhaseAttr: 'revealed'
    })
    const rendered = render(
      <RouteViewportContext value={value(version)}>
        <Harness containerRef={ref} />
      </RouteViewportContext>
    )
    return {
      rerender: (v: number) => {
        rendered.rerender(
          <RouteViewportContext value={value(v)}>
            <Harness containerRef={ref} />
          </RouteViewportContext>
        )
      },
      unmount: () => rendered.unmount()
    }
  }

  it('true bottom with a message id present pins scrollTop 0 through insertion and stream growth', async () => {
    rects.clear()
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    rects.set('m2', { top: -60, height: 60 })
    rects.set('m3', { top: -8, height: 60 })
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
    const m2 = document.createElement('div')
    m2.id = 'message-m2'
    m2.setAttribute('data-message-id', 'm2')
    mockRect(m2, 'm2')
    const m3 = document.createElement('div')
    m3.id = 'message-m3'
    m3.setAttribute('data-message-id', 'm3')
    mockRect(m3, 'm3')
    container.append(m2, m3)
    document.body.append(container)
    const ref = { current: container }
    const keeper = renderKeeper(controller, ref, 0)
    const oldRectSpy = vi.spyOn(m2, 'getBoundingClientRect')

    // The actual send sequence adopts the bottom viewport (gesture-free)
    // even though the measured snapshot carries a top-visible message id:
    // bottom takes priority, so the live anchor is bottom (null).
    const h = buildSequenceHarness(controller)
    const res = await runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    expect(res).toEqual({ outcome: 'completed-bottom-adopted', routeKey: 'topic-t1::main' })
    expect(h.commits[0].snapshot).toMatchObject({ messageId: 'm3', isAtBottom: true })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()

    // New-user insertion drifts the viewport off bottom (-90): the keeper
    // pins it back to 0 instead of holding the old m2 row.
    act(() => {
      container.scrollTop = -90
      keeper.rerender(1)
    })
    expect(container.scrollTop).toBe(0)
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()

    // Assistant reply stream growth drifts again (-149, then -137): each
    // layout generation re-pins the true bottom.
    act(() => {
      container.scrollTop = -149
      keeper.rerender(2)
    })
    expect(container.scrollTop).toBe(0)
    act(() => {
      container.scrollTop = -137
      keeper.rerender(3)
    })
    expect(container.scrollTop).toBe(0)
    // The old reading row is never re-measured for compensation.
    expect(oldRectSpy).not.toHaveBeenCalled()
    oldRectSpy.mockRestore()
    keeper.unmount()
  })

  it('a subsequent genuine wheel scroll-away wins over the held bottom (no fight)', async () => {
    rects.clear()
    const controller = new RouteViewportController({ topicId: 't1', route: null })
    driveStableMessage(controller, 'm2', -60)
    const container = document.createElement('div')
    container.id = 'messages'
    mockRect(container, 'container')
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
    const m4 = document.createElement('div')
    m4.id = 'message-m4'
    m4.setAttribute('data-message-id', 'm4')
    rects.set('m4', { top: -5, height: 60 })
    mockRect(m4, 'm4')
    container.append(m4)
    document.body.append(container)
    const ref = { current: container }
    const keeper = renderKeeper(controller, ref, 0)

    const h = buildSequenceHarness(controller)
    const res = await runSendBottomIntent({ topicId: 't1' }, 't1', h.deps)
    expect(res).toEqual({ outcome: 'completed-bottom-adopted', routeKey: 'topic-t1::main' })
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toBeNull()

    // Genuine wheel input opens a live session first; the keeper bottom-hold
    // is gated on no live session, so it never fights the user's scroll.
    const token = controller.declareUserIntent()
    const wheel = controller.userTakeover(
      { messageId: 'm4', intraRowOffset: -5, scrollTop: -50, isAtBottom: false },
      undefined,
      token
    )
    expect(wheel.taken).toBe(true)
    act(() => {
      container.scrollTop = -50
      keeper.rerender(1)
    })
    // The keeper now holds the user's m4 row (offset preserved), not bottom.
    expect(controller.getAnchorFor({ topicId: 't1', route: null })).toEqual({
      kind: 'message',
      messageId: 'm4',
      offset: -5
    })
    expect(container.scrollTop).toBe(-50)
    expect(controller.noteInteractionScrollEnd(token)).toBe(true)
    keeper.unmount()
  })
})
