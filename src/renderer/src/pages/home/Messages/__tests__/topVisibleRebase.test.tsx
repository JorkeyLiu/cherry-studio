/**
 * Top-only visible incremental rebase (bounded unit, behavior-only).
 *
 * Eligibility: the target route's own saved message anchor + exact offset is
 * provably resident shared — current displayed window + connected raw-ID DOM
 * row + this topic's loaded projection + target authoritative around-window
 * all agree, no paging required to place. Any doubt fails closed to the
 * existing hidden atomic restore (never divider search semantics).
 */
import type { Message } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { describe, expect, it } from 'vitest'

import { createMessageViewportGroupModel } from '../messageGroups'
import {
  createTargetMessageWindow,
  isTopStableCommittable,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
} from '../messageWindow'
import {
  buildRouteVisibleMessages,
  isRouteVisibleUnionExact,
  planRouteVisibleRebase,
  planTopVisibleRebase
} from '../routeOverlapRebase'
import { RouteViewportController } from '../routeViewportController'

const msg = (id: string): Message => ({ id, topicId: 't1' }) as unknown as Message

const trunk = Array.from({ length: 16 }, (_, i) => `m${i}`)
const branchSuffix = Array.from({ length: 10 }, (_, i) => `n${i + 1}`)
const currentShifted = [...trunk, 'o1', 'o2']
const responseAround = [...trunk.slice(5), ...branchSuffix]

const baseTopInput = {
  currentIdsOldestFirst: currentShifted,
  targetResponseIdsOldestFirst: responseAround,
  targetWindowIdsOldestFirst: responseAround,
  anchorId: 'm15',
  currentHasMoreBefore: false,
  targetHasMoreAfter: false,
  loadedIds: new Set([...currentShifted, ...branchSuffix])
}

describe('top visible shared overlap planning (fail closed)', () => {
  it('eligible shared saved anchor preserves resident instances (same identity, stable keys)', () => {
    const plan = planTopVisibleRebase({ ...baseTopInput })
    expect(plan).not.toBeNull()
    expect(plan?.sharedPrefixIds).toEqual(trunk)
    expect(plan?.outgoingIds).toEqual(['o1', 'o2'])
    expect(plan?.incomingIds).toEqual(branchSuffix)
    expect(plan?.nextOldestFirst).toEqual([...trunk, ...branchSuffix])
    expect(plan?.anchorIndex).toBe(15)
    const currentNewestFirst = [...currentShifted].reverse().map(msg)
    const loadedOldestFirst = responseAround.map(msg)
    const next = buildRouteVisibleMessages(currentNewestFirst, loadedOldestFirst, plan!)
    expect(next.map((m) => m.id)).toEqual([...trunk, ...branchSuffix].reverse())
    const byId = new Map(currentNewestFirst.map((m) => [m.id, m]))
    for (const id of trunk) {
      expect(next.find((m) => m.id === id)).toBe(byId.get(id))
    }
  })

  it('supports numeric-leading UUID and special IDs (raw-ID contract)', () => {
    const anchor = '123e4567-e89b-12d3-a456-426614174000'
    const current = ['9-start', anchor, 'o1']
    const response = ['9-start', anchor, 'n1']
    const plan = planTopVisibleRebase({
      currentIdsOldestFirst: current,
      targetResponseIdsOldestFirst: response,
      targetWindowIdsOldestFirst: response,
      anchorId: anchor,
      currentHasMoreBefore: false,
      targetHasMoreAfter: false,
      loadedIds: new Set([...current, 'n1'])
    })
    expect(plan).not.toBeNull()
    expect(plan?.sharedPrefixIds).toEqual(['9-start', anchor])
    expect(plan?.incomingIds).toEqual(['n1'])
  })

  it('fail-closed: nonresident anchor (absent from current window)', () => {
    expect(
      planTopVisibleRebase({
        ...baseTopInput,
        currentIdsOldestFirst: [...trunk.slice(0, 10), 'o1'],
        loadedIds: new Set([...trunk.slice(0, 10), 'o1', ...branchSuffix])
      })
    ).toBeNull()
  })

  it('fail-closed: exclusive anchor (present in current but absent from target projection)', () => {
    expect(
      planTopVisibleRebase({
        ...baseTopInput,
        anchorId: 'o1',
        targetWindowIdsOldestFirst: responseAround,
        loadedIds: new Set([...currentShifted, ...branchSuffix])
      })
    ).toBeNull()
  })

  it('fail-closed: incomplete projection (anchor absent from this-topic loaded IDs, even if elsewhere in Redux)', () => {
    expect(
      planTopVisibleRebase({
        ...baseTopInput,
        loadedIds: new Set([...trunk.slice(0, 15), 'o1', 'o2', ...branchSuffix])
      })
    ).toBeNull()
  })

  it('fail-closed: anchor outside the target window (uncovered, would need paging)', () => {
    expect(
      planTopVisibleRebase({
        ...baseTopInput,
        targetWindowIdsOldestFirst: [...trunk.slice(5, 15), ...branchSuffix.slice(0, 5)],
        loadedIds: new Set([...currentShifted, ...branchSuffix])
      })
    ).toBeNull()
  })

  it('fail-closed: need-older-pagination shape (anchor resident but target window contradicts response order)', () => {
    expect(
      planTopVisibleRebase({
        ...baseTopInput,
        targetWindowIdsOldestFirst: [...trunk.slice(6, 8).reverse(), ...trunk.slice(8), ...branchSuffix]
      })
    ).toBeNull()
  })

  it('fail-closed: outgoing suffix present in target projection (would drop a row)', () => {
    expect(
      planTopVisibleRebase({
        ...baseTopInput,
        targetResponseIdsOldestFirst: [...responseAround, 'o1'],
        targetWindowIdsOldestFirst: [...responseAround, 'o1']
      })
    ).toBeNull()
  })

  it('fail-closed: shared planner rejects duplicates/empty/incoming-empty', () => {
    const { loadedIds: _loaded, ...sharedBase } = baseTopInput
    void _loaded
    expect(planRouteVisibleRebase({ ...sharedBase, anchorId: '' })).toBeNull()
    expect(
      planRouteVisibleRebase({
        ...sharedBase,
        currentIdsOldestFirst: [...currentShifted, 'o1']
      })
    ).toBeNull()
    expect(planTopVisibleRebase({ ...baseTopInput, currentIdsOldestFirst: [...currentShifted, 'o1'] })).toBeNull()
    expect(planTopVisibleRebase({ ...baseTopInput, targetWindowIdsOldestFirst: trunk.slice(5) })).toBeNull()
  })

  it('union gate fails closed on trim/missing/flag mismatch (exact capacity)', () => {
    const plan = planTopVisibleRebase({ ...baseTopInput })!
    expect(plan).not.toBeNull()
    const currentNewestFirst = [...currentShifted].reverse().map(msg)
    const loadedOldestFirst = responseAround.map(msg)
    const unionNewestFirst = buildRouteVisibleMessages(currentNewestFirst, loadedOldestFirst, plan)
    const unionOldestFirst = [...unionNewestFirst].reverse()
    const unionModel = createMessageViewportGroupModel(unionOldestFirst)
    const anchorIdx = unionModel.groups.indexOf(unionModel.messageIdToGroup.get('m15')!)
    const unionWindow = createTargetMessageWindow(
      unionOldestFirst,
      'm15',
      anchorIdx + 1,
      unionModel.groups.length - anchorIdx - 1,
      {
        hasMoreBefore: plan.hasMoreBefore,
        hasMoreAfter: plan.hasMoreAfter
      }
    )
    expect(
      isRouteVisibleUnionExact({
        plan,
        unionOldestFirst,
        unionNewestFirst,
        unionWindow,
        unionModelGroupCount: unionModel.groups.length
      })
    ).toBe(true)
    expect(
      isRouteVisibleUnionExact({
        plan,
        unionOldestFirst,
        unionNewestFirst,
        unionWindow: {
          ...unionWindow,
          boundedViewportObservability: { ...unionWindow.boundedViewportObservability!, didTrim: true }
        },
        unionModelGroupCount: unionModel.groups.length
      })
    ).toBe(false)
    expect(
      isRouteVisibleUnionExact({
        plan,
        unionOldestFirst,
        unionNewestFirst,
        unionWindow: { ...unionWindow, hasMoreOlder: !unionWindow.hasMoreOlder },
        unionModelGroupCount: unionModel.groups.length
      })
    ).toBe(false)
    expect(
      isRouteVisibleUnionExact({
        plan,
        unionOldestFirst,
        unionNewestFirst,
        unionWindow: {
          ...unionWindow,
          groupCapacity: MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT + 1
        },
        unionModelGroupCount: unionModel.groups.length
      })
    ).toBe(false)
  })
})

describe('controller top visible same saved identity + offset (sole truth)', () => {
  it('top fetch-hold enters aligned with saved identity + offset, no displayed advance, stale refuses', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -400, messageId: 'm15', intraRowOffset: -12, isAtBottom: false }
    })
    expect(c.getAnchorFor({ topicId: 't1', route: 'b1' })).toEqual({
      kind: 'message',
      messageId: 'm15',
      offset: -12
    })
    const genBefore = c.windowGeneration
    expect(c.applyVisibleRebaseWindow(epoch, { topicId: 't1', route: 'b1' }, 'm0::n10::26')).toBe(true)
    expect(c.currentPhase).toBe('aligned')
    expect(c.programmaticOwned).toBe(true)
    expect(c.windowGeneration).toBeGreaterThan(genBefore)
    expect(c.renderedProvenance).toMatchObject({ topicId: 't1', routeId: 'b1', epoch })
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })
    // Top visible never enters divider search semantics.
    expect(c.fallbackVisibleToSearch(epoch)).toBe(false)
    expect(c.currentPhase).toBe('aligned')
    c.revealed(epoch)
    const out = c.commitStable(epoch, { messageId: 'm15', intraRowOffset: -12, scrollTop: -400, isAtBottom: false })
    expect(out.committed).toBe(true)
    expect(out.commit?.snapshot).toMatchObject({ messageId: 'm15', intraRowOffset: -12 })
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: 'b1' })
    expect(c.currentPhase).toBe('stable')
  })

  it('stale top apply/commit refuse and cannot touch the newer session (release once)', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const first = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b1',
      saved: { scrollTop: -100, messageId: 'm1', intraRowOffset: -5, isAtBottom: false }
    })
    const second = c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute: 'b2',
      saved: { scrollTop: -200, messageId: 'm2', intraRowOffset: -7, isAtBottom: false }
    })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(c.applyVisibleRebaseWindow(first.epoch, { topicId: 't1', route: 'b1' }, 'w1')).toBe(false)
    expect(c.releaseSession(first.epoch)).toBe(false)
    expect(
      c.commitStable(first.epoch, { messageId: 'm1', intraRowOffset: -5, scrollTop: -100, isAtBottom: false }).committed
    ).toBe(false)
    expect(c.isSessionCurrent(second.epoch)).toBe(true)
    expect(c.applyVisibleRebaseWindow(second.epoch, { topicId: 't1', route: 'b2' }, 'w2')).toBe(true)
    // Foreign geometry never commits: wrong window refuses.
    c.revealed(second.epoch)
    expect(
      c.commitStable(
        second.epoch,
        { messageId: 'm2', intraRowOffset: -7, scrollTop: -200, isAtBottom: false },
        'foreign-window'
      ).committed
    ).toBe(false)
    expect(c.programmaticOwned).toBe(true)
    const done = c.commitStable(
      second.epoch,
      { messageId: 'm2', intraRowOffset: -7, scrollTop: -200, isAtBottom: false },
      'w2'
    )
    expect(done.committed).toBe(true)
    expect(done.didRelease).toBe(true)
    expect(c.releaseSession(second.epoch)).toBe(false)
  })
})

describe('controller fallbackTopVisibleToHidden (same-epoch top visible → hidden)', () => {
  const startTop = (c: RouteViewportController, targetRoute: string, anchor: string, offset: number) =>
    c.request({
      kind: 'top',
      topicId: 't1',
      targetRoute,
      saved: { scrollTop: -400, messageId: anchor, intraRowOffset: offset, isAtBottom: false }
    })

  it('same-epoch top aligned rewinds to fetch-hold with epoch/intent/displayed/ownership retained, hidden commit binds the stored window (no union adoption)', () => {
    // Production-path sequence with real window identities
    // (`oldest::newest::len`, same key Messages uses): visible union arms on
    // the union identity, proof loss rewinds, and the EXISTING hidden entry
    // binds the stored authoritative target window — never the union.
    const plan = planTopVisibleRebase({ ...baseTopInput })!
    expect(plan).not.toBeNull()
    const currentNewestFirst = [...currentShifted].reverse().map(msg)
    const loadedOldestFirst = responseAround.map(msg)
    const unionNewestFirst = buildRouteVisibleMessages(currentNewestFirst, loadedOldestFirst, plan)
    const unionOldestFirst = [...unionNewestFirst].reverse()
    const unionModel = createMessageViewportGroupModel(unionOldestFirst)
    const unionAnchorIdx = unionModel.groups.indexOf(unionModel.messageIdToGroup.get('m15')!)
    const unionWindow = createTargetMessageWindow(
      unionOldestFirst,
      'm15',
      unionAnchorIdx + 1,
      unionModel.groups.length - unionAnchorIdx - 1,
      { hasMoreBefore: plan.hasMoreBefore, hasMoreAfter: plan.hasMoreAfter }
    )
    const hiddenOldestFirst = responseAround.map(msg)
    const hiddenModel = createMessageViewportGroupModel(hiddenOldestFirst)
    const hiddenAnchorIdx = hiddenModel.groups.indexOf(hiddenModel.messageIdToGroup.get('m15')!)
    const hiddenWindow = createTargetMessageWindow(
      hiddenOldestFirst,
      'm15',
      hiddenAnchorIdx + 1,
      hiddenModel.groups.length - hiddenAnchorIdx - 1,
      { hasMoreBefore: false, hasMoreAfter: false }
    )
    const keyOf = (w: { oldestMessageId?: unknown; newestMessageId?: unknown; displayMessages?: unknown[] }): string =>
      `${String(w.oldestMessageId ?? '')}::${String(w.newestMessageId ?? '')}::${(w.displayMessages as unknown[]).length}`
    const unionId = keyOf(unionWindow)
    const hiddenId = keyOf(hiddenWindow)
    expect(unionId.length).toBeGreaterThan(0)
    expect(hiddenId.length).toBeGreaterThan(0)
    expect(hiddenId).not.toBe(unionId)

    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = startTop(c, 'b1', 'm15', -12)
    const displayedBefore = c.displayedRoute
    // Visible union arms: fetch-hold → aligned, displayed NOT advanced.
    expect(c.applyVisibleRebaseWindow(epoch, { topicId: 't1', route: 'b1' }, unionId)).toBe(true)
    expect(c.currentPhase).toBe('aligned')
    expect(c.programmaticOwned).toBe(true)
    expect(c.displayedRoute).toEqual(displayedBefore)
    const releasesBefore = c.releaseCount
    // Post-apply proof loss: same-epoch rewind keeps epoch/intent/ownership.
    expect(c.fallbackTopVisibleToHidden(epoch)).toBe(true)
    expect(c.currentPhase).toBe('fetch-hold')
    expect(c.currentEpoch).toBe(epoch)
    expect(c.currentIntent).toMatchObject({ kind: 'top', topicId: 't1', targetRoute: 'b1' })
    expect(c.displayedRoute).toEqual(displayedBefore)
    expect(c.programmaticOwned).toBe(true)
    expect(c.releaseCount).toBe(releasesBefore)
    // Existing hidden entry binds the STORED authoritative window.
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: 'b1' }, hiddenId)).toBe(true)
    expect(c.currentPhase).toBe('positioning')
    expect(c.renderedProvenance).toMatchObject({ topicId: 't1', routeId: 'b1', epoch, windowId: hiddenId })
    // Normal hidden path settles: first position → reveal → identity commit
    // with the SAME saved anchor + exact offset; ownership releases once.
    expect(c.firstPositioned(epoch, 'placed')).toBe(true)
    expect(c.revealed(epoch)).toBe(true)
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: 'b1' })
    const out = c.commitStable(epoch, { messageId: 'm15', intraRowOffset: -12, scrollTop: -400, isAtBottom: false })
    expect(out.committed).toBe(true)
    expect(out.commit?.snapshot).toMatchObject({ messageId: 'm15', intraRowOffset: -12 })
    expect(out.didRelease).toBe(true)
    expect(c.releaseSession(epoch)).toBe(false)
  })

  it('refuses stale epoch, divider/generic intents, and non-aligned phases; divider search stays divider-only', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const first = startTop(c, 'b1', 'm1', -5)
    const second = startTop(c, 'b2', 'm2', -7)
    expect(second.epoch).toBeGreaterThan(first.epoch)
    // Stale epoch never rewinds the newer session.
    expect(c.fallbackTopVisibleToHidden(first.epoch)).toBe(false)
    expect(c.isSessionCurrent(second.epoch)).toBe(true)
    expect(c.currentPhase).toBe('fetch-hold')
    // Non-aligned phase refuses.
    expect(c.fallbackTopVisibleToHidden(second.epoch)).toBe(false)
    expect(c.applyVisibleRebaseWindow(second.epoch, { topicId: 't1', route: 'b2' }, 'w2')).toBe(true)
    // Divider + generic sessions refuse; top fallback never enters search.
    const d = new RouteViewportController({ topicId: 't1', route: null })
    const div = d.request({ kind: 'divider', topicId: 't1', targetRoute: 'b1', dividerKey: 'k1', clickOffset: 9 })
    expect(d.applyVisibleRebaseWindow(div.epoch, { topicId: 't1', route: 'b1' }, 'w1')).toBe(true)
    expect(d.fallbackTopVisibleToHidden(div.epoch)).toBe(false)
    expect(d.fallbackVisibleToSearch(div.epoch)).toBe(true)
    const g = new RouteViewportController({ topicId: 't1', route: null })
    const gen = g.request({ kind: 'generic', topicId: 't1', targetRoute: 'b1' })
    expect(g.fallbackTopVisibleToHidden(gen.epoch)).toBe(false)
    // Top aligned never enters divider search semantics.
    expect(c.fallbackVisibleToSearch(second.epoch)).toBe(false)
    expect(c.currentPhase).toBe('aligned')
  })

  it('hidden retry unsuccessful preserves the prior snapshot: unresolvable anchor refuses commit, terminal preserves, release exactly once, stale inert', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = startTop(c, 'b1', 'm15', -12)
    expect(c.applyVisibleRebaseWindow(epoch, { topicId: 't1', route: 'b1' }, 'union-w')).toBe(true)
    expect(c.fallbackTopVisibleToHidden(epoch)).toBe(true)
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: 'b1' }, 'hidden-w')).toBe(true)
    expect(c.firstPositioned(epoch, 'placed')).toBe(true)
    expect(c.revealed(epoch)).toBe(true)
    // Retry gate under the original policy: valid anchor without
    // coverage/residency must not commit a fallback.
    expect(
      isTopStableCommittable({
        isAtBottom: false,
        snapshotInvalidForRoute: false,
        requestedAnchor: 'm15',
        projectionContains: false,
        domConnected: false
      })
    ).toBe(false)
    // Identity commit with no anchor identity refuses (never a fallback
    // commit that would poison the saved snapshot).
    const refused = c.commitStable(epoch, { messageId: null, intraRowOffset: null, scrollTop: 0, isAtBottom: false })
    expect(refused.committed).toBe(false)
    expect(c.programmaticOwned).toBe(true)
    // Terminal preserve releases exactly once; a second release is inert.
    expect(c.terminate(epoch, 'fail-visible').didRelease).toBe(true)
    expect(c.releaseSession(epoch)).toBe(false)
    // Stale fallback/commit work stays inert against the newer session.
    const next = startTop(c, 'b2', 'm2', -7)
    expect(next.epoch).toBeGreaterThan(epoch)
    expect(c.fallbackTopVisibleToHidden(epoch)).toBe(false)
    expect(
      c.commitStable(epoch, { messageId: 'm15', intraRowOffset: -12, scrollTop: -400, isAtBottom: false }).committed
    ).toBe(false)
    expect(c.isSessionCurrent(next.epoch)).toBe(true)
  })

  it('no old-target reveal or snapshot pollution across the fallback: foreign window never reveals, commit binds only the stored window', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = startTop(c, 'b1', 'm15', -12)
    expect(c.applyVisibleRebaseWindow(epoch, { topicId: 't1', route: 'b1' }, 'union-w')).toBe(true)
    expect(c.fallbackTopVisibleToHidden(epoch)).toBe(true)
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: 'b1' }, 'hidden-w')).toBe(true)
    expect(c.firstPositioned(epoch, 'placed')).toBe(true)
    // Old union identity can never reveal or commit the hidden session.
    expect(c.revealed(epoch, 'union-w')).toBe(false)
    expect(
      c.commitStable(epoch, { messageId: 'm15', intraRowOffset: -12, scrollTop: -400, isAtBottom: false }, 'union-w')
        .committed
    ).toBe(false)
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })
    expect(c.revealed(epoch)).toBe(true)
    const out = c.commitStable(
      epoch,
      { messageId: 'm15', intraRowOffset: -12, scrollTop: -400, isAtBottom: false },
      'hidden-w'
    )
    expect(out.committed).toBe(true)
    expect(out.commit?.snapshot).toMatchObject({ messageId: 'm15', intraRowOffset: -12 })
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: 'b1' })
  })
})

const mountCounts = new Map<string, number>()
const unmountCounts = new Map<string, number>()

const TrackedRow: React.FC<{ id: string }> = ({ id }) => {
  useEffect(() => {
    mountCounts.set(id, (mountCounts.get(id) ?? 0) + 1)
    return () => {
      unmountCounts.set(id, (unmountCounts.get(id) ?? 0) + 1)
    }
  }, [id])
  return (
    <div id={`message-${id}`} data-message-id={id} style={{ height: 40 }}>
      {id}
    </div>
  )
}

const TopVisibleHarness: React.FC<{
  ids: string[]
  phaseRef: React.MutableRefObject<string[]>
  containerRef: React.RefObject<HTMLDivElement | null>
}> = ({ ids, phaseRef, containerRef }) => {
  const [scrollTop, setScrollTop] = useState(0)
  const phase: string = 'revealed'
  phaseRef.current.push(phase)
  return (
    <div
      id="messages"
      data-viewport-phase={phase}
      ref={(el) => {
        if (containerRef) {
          ;(containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el
        }
      }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      data-scroll-top={scrollTop}
      style={{ overflowY: 'auto', height: 600 }}>
      <div>
        {ids.map((id) => (
          <TrackedRow key={id} id={id} />
        ))}
      </div>
    </div>
  )
}

describe('top visible incremental rebase DOM behavior (synchronous, never hidden)', () => {
  it('keeps shared prefix nodes, swaps only suffixes, never empties/hides, compensates <=1px', () => {
    mountCounts.clear()
    unmountCounts.clear()
    const phaseRef = { current: [] as string[] }
    const containerRef: { current: HTMLDivElement | null } = { current: null }
    const wantOffset = -12

    const absTops = new Map<string, number>([
      ['m14', 160],
      ['m15', 200],
      ['o1', 240],
      ['o2', 280],
      ['n1', 240],
      ['n2', 280]
    ])

    const installMocks = (): void => {
      const container = containerRef.current
      if (!container) return
      container.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 600,
          height: 600,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect
      const row = container.querySelector('[data-message-id="m15"]') as HTMLElement | null
      if (row) {
        row.getBoundingClientRect = () => {
          const abs = absTops.get('m15') ?? 200
          const top = abs - container.scrollTop
          return {
            top,
            bottom: top + 40,
            height: 40,
            left: 0,
            right: 300,
            width: 300,
            x: 0,
            y: top,
            toJSON: () => ({})
          } as DOMRect
        }
      }
    }

    const { rerender } = render(
      <TopVisibleHarness
        ids={['m14', 'm15', 'o1', 'o2']}
        phaseRef={phaseRef as unknown as React.MutableRefObject<string[]>}
        containerRef={containerRef}
      />
    )
    const container = containerRef.current!
    installMocks()

    const beforeShared = ['m14', 'm15'].map((id) => container.querySelector(`[data-message-id="${id}"]`) as HTMLElement)
    for (const el of beforeShared) expect(el?.isConnected).toBe(true)

    absTops.set('m15', 205)

    let nonEmptyDuringRebase = true
    act(() => {
      rerender(
        <TopVisibleHarness
          ids={['m14', 'm15', 'n1', 'n2']}
          phaseRef={phaseRef as unknown as React.MutableRefObject<string[]>}
          containerRef={containerRef}
        />
      )
      if ((containerRef.current?.querySelectorAll('[data-message-id]').length ?? 0) === 0) {
        nonEmptyDuringRebase = false
      }
    })
    installMocks()

    const afterShared = ['m14', 'm15'].map((id) => container.querySelector(`[data-message-id="${id}"]`) as HTMLElement)
    afterShared.forEach((el, i) => {
      expect(el).toBe(beforeShared[i])
      expect(el?.isConnected).toBe(true)
    })
    for (const id of ['m14', 'm15']) {
      expect(mountCounts.get(id)).toBe(1)
      expect(unmountCounts.get(id) ?? 0).toBe(0)
    }
    expect(unmountCounts.get('o1')).toBe(1)
    expect(unmountCounts.get('o2')).toBe(1)
    expect(mountCounts.get('n1')).toBe(1)
    expect(mountCounts.get('n2')).toBe(1)
    expect(nonEmptyDuringRebase).toBe(true)
    expect(phaseRef.current.every((p) => p !== 'positioning')).toBe(true)
    expect(container.getAttribute('data-viewport-phase')).not.toBe('positioning')
    expect(getComputedStyle(container).visibility).not.toBe('hidden')

    const anchor = container.querySelector('[data-message-id="m15"]') as HTMLElement
    const actualBefore = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
    const delta = actualBefore - wantOffset
    if (Math.abs(delta) > 1) container.scrollTop += delta
    const actualAfter = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
    expect(Math.abs(actualAfter - wantOffset)).toBeLessThanOrEqual(1)
  })
})
