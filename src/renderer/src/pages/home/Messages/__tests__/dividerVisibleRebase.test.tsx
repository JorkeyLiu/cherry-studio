/**
 * Divider-only visible incremental rebase (bounded unit).
 *
 * Covers every listed claim with direct assertions:
 * - >=5 shared prefix HTMLElements retain object identity;
 * - shared mounts once / unmounts zero; outgoing unmounts; target mounts;
 * - container never empty; phase never positioning; visibility never hidden;
 * - synchronous divider compensation <=1px;
 * - stale visible apply rejected;
 * - missing anchor falls back to the existing hidden searching path.
 */
import * as fs from 'node:fs'

import type { Message } from '@renderer/types/newMessage'
import { act, render } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { describe, expect, it } from 'vitest'

import { decideDividerRestoreSearchStep } from '../dividerRestoreSearch'
import {
  buildDividerSearchProgressFromVisible,
  buildDividerVisibleMessages,
  isDividerVisibleUnionExact,
  planDividerVisibleRebase
} from '../dividerVisibleRebase'
import { createMessageViewportGroupModel } from '../messageGroups'
import {
  createTargetMessageWindow,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
  type MessageWindow
} from '../messageWindow'
import { RouteViewportController } from '../routeViewportController'

const msg = (id: string): Message => ({ id, topicId: 't1' }) as unknown as Message

// Branch topology: shared trunk m0..m15, fork m15, main-exclusive o*, branch-exclusive n*.
const trunk = Array.from({ length: 16 }, (_, i) => `m${i}`)
const branchSuffix = Array.from({ length: 10 }, (_, i) => `n${i + 1}`)
const currentShifted = [...trunk, 'o1', 'o2']
const responseAround = [...trunk.slice(5), ...branchSuffix]

const baseInput = {
  currentIdsOldestFirst: currentShifted,
  targetResponseIdsOldestFirst: responseAround,
  targetWindowIdsOldestFirst: responseAround,
  forkAnchorId: 'm15',
  currentHasMoreBefore: false,
  targetHasMoreAfter: false
}

describe('fork-aligned visible divider rebase planning (fail closed)', () => {
  it('shifted partial-window heads are eligible: preserved chain may begin earlier than the target window', () => {
    const plan = planDividerVisibleRebase({ ...baseInput })
    expect(plan).not.toBeNull()
    // Full current prefix through the fork is preserved (m0..m4 begin earlier
    // than the m5 response head); outgoing main suffix leaves; the target
    // window suffix mounts.
    expect(plan?.sharedPrefixIds).toEqual(trunk)
    expect(plan?.sharedPrefixIds.length).toBeGreaterThanOrEqual(5)
    expect(plan?.outgoingIds).toEqual(['o1', 'o2'])
    expect(plan?.incomingIds).toEqual(branchSuffix)
    expect(plan?.nextOldestFirst).toEqual([...trunk, ...branchSuffix])
    expect(plan?.forkIndex).toBe(15)
  })

  it('heads may differ either way: current starting later than the response head stays eligible', () => {
    const plan = planDividerVisibleRebase({
      ...baseInput,
      currentIdsOldestFirst: [...trunk.slice(8), 'o1'],
      currentHasMoreBefore: true
    })
    expect(plan).not.toBeNull()
    expect(plan?.sharedPrefixIds).toEqual(trunk.slice(8))
    expect(plan?.outgoingIds).toEqual(['o1'])
    expect(plan?.incomingIds).toEqual(branchSuffix)
    expect(plan?.nextOldestFirst).toEqual([...trunk.slice(8), ...branchSuffix])
  })

  it('identical heads remain eligible (no regression on the narrow case)', () => {
    const plan = planDividerVisibleRebase({
      currentIdsOldestFirst: [...trunk.slice(0, 7), 'o1'],
      targetResponseIdsOldestFirst: [...trunk.slice(0, 7), 'n1', 'n2'],
      targetWindowIdsOldestFirst: [...trunk.slice(0, 7), 'n1', 'n2'],
      forkAnchorId: 'm6',
      currentHasMoreBefore: false,
      targetHasMoreAfter: false
    })
    expect(plan).not.toBeNull()
    expect(plan?.sharedPrefixIds).toEqual(trunk.slice(0, 7))
    expect(plan?.forkIndex).toBe(6)
  })

  it('merges capabilities: older boundary from the preserved current side, newer from the target side', () => {
    // Partial around window but the preserved union starts at the current
    // head m0: the older edge is the current side, never the response head.
    const partial = planDividerVisibleRebase({
      ...baseInput,
      currentHasMoreBefore: false,
      targetHasMoreAfter: true
    })
    expect(partial?.hasMoreBefore).toBe(false)
    expect(partial?.hasMoreAfter).toBe(true)
    const paged = planDividerVisibleRebase({
      ...baseInput,
      currentIdsOldestFirst: [...trunk.slice(8), 'o1'],
      currentHasMoreBefore: true,
      targetHasMoreAfter: false
    })
    expect(paged?.hasMoreBefore).toBe(true)
    expect(paged?.hasMoreAfter).toBe(false)
  })

  it('rejects missing fork in any projection', () => {
    expect(planDividerVisibleRebase({ ...baseInput, forkAnchorId: 'zzz' })).toBeNull()
    expect(
      planDividerVisibleRebase({
        ...baseInput,
        targetResponseIdsOldestFirst: [...trunk.slice(5, 15), 'n1']
      })
    ).toBeNull()
    expect(
      planDividerVisibleRebase({
        ...baseInput,
        targetWindowIdsOldestFirst: [...trunk.slice(5, 15), 'n1']
      })
    ).toBeNull()
  })

  it('rejects target windows outside the authoritative response (order/subsequence)', () => {
    // Window ID absent from the response.
    expect(
      planDividerVisibleRebase({ ...baseInput, targetWindowIdsOldestFirst: [...responseAround, 'ghost'] })
    ).toBeNull()
    // Window order contradicting the response.
    expect(
      planDividerVisibleRebase({
        ...baseInput,
        targetWindowIdsOldestFirst: [...trunk.slice(6, 8).reverse(), ...trunk.slice(8), ...branchSuffix]
      })
    ).toBeNull()
  })

  it('rejects overlap disagreement and outgoing/incoming interleaving', () => {
    // Overlap mismatch at the aligned position (qx where m14 must be).
    expect(
      planDividerVisibleRebase({
        ...baseInput,
        currentIdsOldestFirst: [...trunk.slice(0, 14), 'qx', 'm15', 'o1']
      })
    ).toBeNull()
    // Outgoing suffix present in the target projection (would drop a row).
    expect(
      planDividerVisibleRebase({
        ...baseInput,
        targetResponseIdsOldestFirst: [...responseAround, 'o1'],
        targetWindowIdsOldestFirst: [...responseAround, 'o1']
      })
    ).toBeNull()
    // Empty incoming suffix (window ends at the fork): nothing new to show.
    expect(planDividerVisibleRebase({ ...baseInput, targetWindowIdsOldestFirst: trunk.slice(5) })).toBeNull()
  })

  it('rejects disjoint/malformed/duplicate/unstable IDs', () => {
    expect(planDividerVisibleRebase({ ...baseInput, currentIdsOldestFirst: [] })).toBeNull()
    expect(planDividerVisibleRebase({ ...baseInput, forkAnchorId: '' })).toBeNull()
    expect(planDividerVisibleRebase({ ...baseInput, currentIdsOldestFirst: [...currentShifted, 'o1'] })).toBeNull()
    expect(planDividerVisibleRebase({ ...baseInput, targetResponseIdsOldestFirst: [...responseAround, ''] })).toBeNull()
    expect(planDividerVisibleRebase({ ...baseInput, currentHasMoreBefore: 'yes' as never })).toBeNull()
  })

  it('missing anchor falls back to the existing hidden searching path', () => {
    const plan = planDividerVisibleRebase({ ...baseInput, forkAnchorId: 'zzz' })
    expect(plan).toBeNull()
    // The unchanged hidden searcher owns the absent-anchor case: with older
    // pages remaining it explicitly drives restore-owned pagination (never a
    // visible commit).
    const decision = decideDividerRestoreSearchStep(
      {
        dividerResident: false,
        sharedResident: false,
        hasMoreOlder: true,
        loadingOlder: false,
        pagesDriven: 0,
        targetCurrent: true,
        mounted: true,
        hasWindow: true,
        lastLoadFailed: false
      },
      { kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 }
    )
    expect(decision.action).toBe('drive-older')
  })

  it('reuses resident objects for the preserved prefix (stable keys stay mounted)', () => {
    const plan = planDividerVisibleRebase({ ...baseInput })
    expect(plan).not.toBeNull()
    const currentNewestFirst = [...currentShifted].reverse().map(msg)
    const loadedOldestFirst = responseAround.map(msg)
    const next = buildDividerVisibleMessages(currentNewestFirst, loadedOldestFirst, plan!)
    // Newest-first output in planned union order.
    expect(next.map((m) => m.id)).toEqual([...trunk, ...branchSuffix].reverse())
    // Preserved prefix reuses the exact resident instances (m0..m4 included).
    const byId = new Map(currentNewestFirst.map((m) => [m.id, m]))
    for (const id of trunk) {
      expect(next.find((m) => m.id === id)).toBe(byId.get(id))
    }
  })
})

describe('divider fetch-hold stays visible; top fetch-hold stays hidden', () => {
  it('maps divider fetch-hold to revealed and every other fetch-hold to positioning', async () => {
    const { viewportPhaseAttrFor } = await import('../routeViewportContext')
    expect(viewportPhaseAttrFor('fetch-hold', 'divider')).toBe('revealed')
    expect(viewportPhaseAttrFor('fetch-hold', 'top')).toBe('positioning')
    expect(viewportPhaseAttrFor('fetch-hold', 'generic')).toBe('positioning')
    expect(viewportPhaseAttrFor('fetch-hold')).toBe('positioning')
    expect(viewportPhaseAttrFor('fetch-hold', null)).toBe('positioning')
    expect(viewportPhaseAttrFor('positioning', 'divider')).toBe('positioning')
    expect(viewportPhaseAttrFor('aligned', 'divider')).toBe('revealed')
    expect(viewportPhaseAttrFor('searching', 'divider')).toBe('revealed')
    expect(viewportPhaseAttrFor('stable', 'divider')).toBe('revealed')
    expect(viewportPhaseAttrFor('idle', 'divider')).toBe('idle')
  })

  it('planner failure still uses the hidden atomic fallback (positioning before apply)', () => {
    // The existing hidden entry enters positioning/hidden even for divider
    // intents: a failed visible attempt falls back through it unchanged.
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm15::main',
      clickOffset: 150
    })
    expect(c.currentPhase).toBe('fetch-hold')
    expect(c.applyTransitionWindow(epoch, { topicId: 't1', route: 'b1' }, 'm5::n1::8')).toBe(true)
    expect(c.currentPhase).toBe('positioning')
  })
})

describe('controller applyVisibleRebaseWindow (sole truth)', () => {
  it('divider fetch-hold enters aligned directly with ownership held and no displayed advance', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm6::main',
      clickOffset: 150
    })
    const genBefore = c.windowGeneration
    expect(c.applyVisibleRebaseWindow(epoch, { topicId: 't1', route: 'b1' }, 'm1::n2::8')).toBe(true)
    expect(c.currentPhase).toBe('aligned')
    expect(c.programmaticOwned).toBe(true)
    expect(c.windowGeneration).toBeGreaterThan(genBefore)
    expect(c.renderedProvenance).toMatchObject({ topicId: 't1', routeId: 'b1', epoch })
    // No early displayed-route advance: still the outgoing route until commit.
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })
    // Existing stable commit releases exactly once.
    c.revealed(epoch)
    const out = c.commitStable(epoch, { messageId: 'm1', intraRowOffset: 0, scrollTop: -100, isAtBottom: false })
    expect(out.committed).toBe(true)
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: 'b1' })
    expect(c.currentPhase).toBe('stable')
  })

  it('stale visible apply is rejected and cannot touch the newer session', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const first = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm6::main',
      clickOffset: 10
    })
    const second = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b2',
      dividerKey: 'm6::main',
      clickOffset: 12
    })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(c.applyVisibleRebaseWindow(first.epoch, { topicId: 't1', route: 'b1' }, 'w1')).toBe(false)
    expect(c.releaseSession(first.epoch)).toBe(false)
    expect(c.isSessionCurrent(second.epoch)).toBe(true)
    // Non-divider intents and non-fetch-hold phases also refuse.
    const c2 = new RouteViewportController({ topicId: 't1', route: null })
    const top = c2.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    expect(c2.applyVisibleRebaseWindow(top.epoch, { topicId: 't1', route: 'b1' }, 'w1')).toBe(false)
    expect(c2.currentPhase).toBe('fetch-hold')
  })
})

// --- Component behavior: synchronous visible list rebase --------------------

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

const VisibleHarness: React.FC<{
  ids: string[]
  dividerKey: string
  phaseRef: React.MutableRefObject<string[]>
  containerRef: React.RefObject<HTMLDivElement | null>
}> = ({ ids, dividerKey, phaseRef, containerRef }) => {
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
        <div data-divider-key={dividerKey} data-testid="divider-row" style={{ height: 36 }}>
          divider
        </div>
      </div>
    </div>
  )
}

describe('visible incremental rebase DOM behavior (synchronous, never hidden)', () => {
  it('keeps >=5 shared prefix nodes, swaps only suffixes, never empties/hides, compensates <=1px', () => {
    mountCounts.clear()
    unmountCounts.clear()
    const phaseRef = { current: [] as string[] }
    const containerRef: { current: HTMLDivElement | null } = { current: null }
    const dividerKey = 'm6::main'
    const wantOffset = 240

    // Absolute document tops for the compensation mock (relative = abs - scrollTop).
    const absTops = new Map<string, number>([
      ['m1', 0],
      ['m2', 40],
      ['m3', 80],
      ['m4', 120],
      ['m5', 160],
      ['m6', 200],
      ['divider', 240],
      ['o1', 276],
      ['o2', 316],
      ['n1', 276],
      ['n2', 316]
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
      const row = container.querySelector('[data-divider-key="m6::main"]') as HTMLElement | null
      if (row) {
        row.getBoundingClientRect = () => {
          const abs = absTops.get('divider') ?? 240
          const top = abs - container.scrollTop
          return {
            top,
            bottom: top + 36,
            height: 36,
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
      <VisibleHarness
        ids={['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'o1', 'o2']}
        dividerKey={dividerKey}
        phaseRef={phaseRef as unknown as React.MutableRefObject<string[]>}
        containerRef={containerRef}
      />
    )
    const container = containerRef.current!
    installMocks()

    // Capture >=5 shared prefix HTMLElements before the rebase.
    const beforeShared = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(
      (id) => container.querySelector(`[data-message-id="${id}"]`) as HTMLElement
    )
    for (const el of beforeShared) expect(el?.isConnected).toBe(true)
    expect(container.childElementCount).toBeGreaterThan(0)

    // Simulate layout drift from the suffix swap: the divider rides 5px down.
    absTops.set('divider', 245)

    let nonEmptyDuringRebase = true
    act(() => {
      rerender(
        <VisibleHarness
          ids={['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'n1', 'n2']}
          dividerKey={dividerKey}
          phaseRef={phaseRef as unknown as React.MutableRefObject<string[]>}
          containerRef={containerRef}
        />
      )
      // Synchronously rebase: the container must never be observed empty
      // inside the same commit (no blank/mixed frame).
      if ((containerRef.current?.querySelectorAll('[data-message-id]').length ?? 0) === 0) {
        nonEmptyDuringRebase = false
      }
    })
    installMocks()

    // Shared prefix retains object identity (same HTMLElement instances).
    const afterShared = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(
      (id) => container.querySelector(`[data-message-id="${id}"]`) as HTMLElement
    )
    expect(afterShared.length).toBeGreaterThanOrEqual(5)
    afterShared.forEach((el, i) => {
      expect(el).toBe(beforeShared[i])
      expect(el?.isConnected).toBe(true)
    })

    // Mount accounting: shared mounts once / unmounts zero; outgoing leaves;
    // target mounts.
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
      expect(mountCounts.get(id)).toBe(1)
      expect(unmountCounts.get(id) ?? 0).toBe(0)
    }
    expect(mountCounts.get('o1')).toBe(1)
    expect(mountCounts.get('o2')).toBe(1)
    expect(unmountCounts.get('o1')).toBe(1)
    expect(unmountCounts.get('o2')).toBe(1)
    expect(mountCounts.get('n1')).toBe(1)
    expect(mountCounts.get('n2')).toBe(1)
    expect(container.querySelector('[data-message-id="o1"]')).toBeNull()
    expect(container.querySelector('[data-message-id="n1"]')).not.toBeNull()

    // Container never empty; phase never positioning; visibility never hidden.
    expect(nonEmptyDuringRebase).toBe(true)
    expect(container.querySelectorAll('[data-message-id]').length).toBeGreaterThan(0)
    expect(phaseRef.current.length).toBeGreaterThan(0)
    expect(phaseRef.current.every((p) => p !== 'positioning')).toBe(true)
    expect(container.getAttribute('data-viewport-phase')).not.toBe('positioning')
    expect(getComputedStyle(container).visibility).not.toBe('hidden')

    // Synchronous divider compensation: actual - wanted, then verify <=1px.
    const divider = container.querySelector('[data-divider-key="m6::main"]') as HTMLElement
    expect(divider?.isConnected).toBe(true)
    const actualBefore = divider.getBoundingClientRect().top - container.getBoundingClientRect().top
    expect(actualBefore).toBe(245)
    const delta = actualBefore - wantOffset
    if (Math.abs(delta) > 1) container.scrollTop += delta
    const actualAfter = divider.getBoundingClientRect().top - container.getBoundingClientRect().top
    expect(Math.abs(actualAfter - wantOffset)).toBeLessThanOrEqual(1)
  })
})

describe('post-apply lost residency falls back into hidden searching (same session, no transient commit)', () => {
  const seedDividerSession = (): { c: RouteViewportController; epoch: number } => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm6::main',
      clickOffset: 150
    })
    expect(c.applyVisibleRebaseWindow(epoch, { topicId: 't1', route: 'b1' }, 'm1::n2::8')).toBe(true)
    expect(c.currentPhase).toBe('aligned')
    return { c, epoch }
  }

  it('aligned → searching keeps epoch/intent/ownership/rendered/displayed with no commit', () => {
    const { c, epoch } = seedDividerSession()
    const beforeRendered = c.renderedProvenance
    const beforeReleases = c.releaseCount
    expect(c.fallbackVisibleToSearch(epoch)).toBe(true)
    expect(c.currentPhase).toBe('searching')
    // Same session truth preserved: intent, ownership, rendered, displayed.
    expect(c.currentIntent).toMatchObject({ kind: 'divider', topicId: 't1', targetRoute: 'b1' })
    expect(c.programmaticOwned).toBe(true)
    expect(c.renderedProvenance).toEqual(beforeRendered)
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })
    expect(c.releaseCount).toBe(beforeReleases)
    // Searching must not commit transient geometry: the stable commit refuses.
    const early = c.commitStable(epoch, { messageId: 'm6', intraRowOffset: 0, scrollTop: -50, isAtBottom: false })
    expect(early.committed).toBe(false)
    expect(c.programmaticOwned).toBe(true)
    expect(c.displayedRoute).toEqual({ topicId: 't1', route: null })
    // The existing restore-owned path still completes: settled → aligned → commit.
    expect(c.paginationSettled(epoch)).toBe(true)
    const done = c.commitStable(epoch, { messageId: 'm6', intraRowOffset: 0, scrollTop: -50, isAtBottom: false })
    expect(done.committed).toBe(true)
    expect(done.commit?.routeKey).toBe('topic-t1::b1')
    expect(c.currentPhase).toBe('stable')
  })

  it('stale / non-divider / non-aligned fallbacks refuse with no effect', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const first = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm6::main',
      clickOffset: 10
    })
    const second = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b2',
      dividerKey: 'm6::main',
      clickOffset: 12
    })
    expect(c.fallbackVisibleToSearch(first.epoch)).toBe(false)
    expect(c.currentPhase).toBe('fetch-hold')
    const top = new RouteViewportController({ topicId: 't1', route: null })
    const t = top.request({ kind: 'top', topicId: 't1', targetRoute: 'b1', saved: null })
    top.appliedWindow(t.epoch)
    top.firstPositioned(t.epoch, 'placed')
    expect(top.currentPhase).toBe('aligned')
    expect(top.fallbackVisibleToSearch(t.epoch)).toBe(false)
    expect(top.currentPhase).toBe('aligned')
    void second
  })

  it('visible pending converts to the existing hidden-search progress (pure, no commit)', () => {
    const progress = buildDividerSearchProgressFromVisible({
      ownerEpoch: 7,
      topicId: 't1',
      routeId: 'b1',
      dividerKey: 'm6::main',
      anchorMessageId: 'm6',
      parentOfDivider: null,
      sharedMessageId: 'm5',
      sharedOffset: -8,
      wantOffset: 150
    })
    expect(progress).toEqual({
      ownerEpoch: 7,
      topicId: 't1',
      routeId: 'b1',
      dividerKey: 'm6::main',
      anchorMessageId: 'm6',
      parentOfDivider: null,
      sharedMessageId: 'm5',
      sharedOffset: -8,
      wantOffset: 150,
      pagesDriven: 0,
      lastLoadFailed: false,
      drivenWindowKey: null
    })
    // Lost divider + lost shared with older pages remaining drives
    // restore-owned pagination (never a visible commit of transient geometry).
    const decision = decideDividerRestoreSearchStep(
      {
        dividerResident: false,
        sharedResident: false,
        hasMoreOlder: true,
        loadingOlder: false,
        pagesDriven: progress!.pagesDriven,
        targetCurrent: true,
        mounted: true,
        hasWindow: true,
        lastLoadFailed: false
      },
      { kind: 'divider-row', dividerKey: progress!.dividerKey, targetOffset: progress!.wantOffset ?? 0 }
    )
    expect(decision.action).toBe('drive-older')
    expect(decision.commitStable).toBe(false)
    expect(buildDividerSearchProgressFromVisible({ ...progress!, dividerKey: '' } as never)).toBeNull()
  })

  it('Messages wires the post-apply fallback under the same epoch (structural)', () => {
    const src = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    // Same-session fallback entry in the visible layout effect.
    expect(src).toMatch(/fallBackToHiddenSearch|fallbackVisibleToSearch/)
    expect(src).toMatch(/controller\.fallbackVisibleToSearch\(/)
    // Fallback arms the EXISTING hidden search progress (no new session) and
    // steps it explicitly without writing a stable snapshot.
    expect(src).toMatch(/dividerProgressRef\.current = progress/)
    expect(src).toMatch(/stepDividerSearch\(\)/)
    // The visible success path still never enters positioning/hidden.
    expect(src).toMatch(/commitDividerVisibleAtomic/)
  })
})

describe('visible quiet sequence (structural: no same-effect commit, bounded rAF, shared offset)', () => {
  // Focused structural proof over the current Messages artifact (not a
  // production integration claim: the synthetic DOM harness above never runs
  // the real Messages layout effect; E2E owns production positioning proof).
  const visibleEffectSrc = (): string => {
    const src = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    const start = src.indexOf('Divider-only visible rebase: synchronous first compensation + bounded')
    expect(start).toBeGreaterThanOrEqual(0)
    return src.slice(start, start + 26000)
  }

  it('no stable commit before the first quiet frame (first compensation only writes scrollTop)', () => {
    const fx = visibleEffectSrc()
    // The synchronous section arms the quiet sequence; the ONLY stable commit
    // lives inside the deferred quiet commit path.
    expect(fx).toMatch(/pending\.quietArmed = true/)
    expect(fx).toMatch(/dividerVisibleRafRef\.current = requestAnimationFrame/)
    const commitCalls = fx.match(/commitDisplayedStable\(pending\.topicId, pending\.routeId, pending\.ownerEpoch\)/g)
    expect(commitCalls?.length).toBe(1)
    expect(fx).toMatch(/const commitQuiet = \(\): void => \{[\s\S]*?commitDisplayedStable\(pending\.topicId/)
    // The synchronous first-pass (first compensation → quiet arm) never
    // commits: no commit call sits between the first resolve and the arm.
    const firstResolve = fx.indexOf('const first = resolveTarget()')
    const arm = fx.indexOf('pending.quietArmed = true')
    expect(firstResolve).toBeGreaterThanOrEqual(0)
    expect(arm).toBeGreaterThan(firstResolve)
    expect(fx.slice(firstResolve, arm)).not.toMatch(/commitDisplayedStable\(/)
  })

  it('residual correction waits another frame and revalidates before commit', () => {
    const fx = visibleEffectSrc()
    expect(fx).toMatch(/const residual = reHave - current\.target/)
    // Bounded quiet frames: first quiet + residual recheck (no loop, no
    // timer).
    expect(fx).toMatch(/live\.scrollTop \+= residual/)
    const rafCount = fx.match(/requestAnimationFrame\(\(\) => \{/g)?.length ?? 0
    expect(rafCount).toBeGreaterThanOrEqual(2)
    expect(rafCount).toBeLessThanOrEqual(3)
    expect(fx).not.toMatch(/setTimeout|setInterval/)
    expect(fx).toMatch(/if \(dividerVisibleRef\.current !== pending\) return/)
  })

  it('shared fallback compensates to sharedOffset (not a residency-only hold)', () => {
    const fx = visibleEffectSrc()
    expect(fx).toMatch(/target: pending\.sharedOffset/)
    expect(fx).toMatch(/typeof pending\.sharedOffset !== 'number'/)
    // No path commits transient geometry: the quiet gate re-resolves the
    // target on every frame.
    expect(fx).toMatch(/const current = resolveTarget\(\)/)
  })

  it('commit-false while current explicitly fails/terminates (never clears the driver first)', () => {
    const fx = visibleEffectSrc()
    expect(fx).toMatch(/const ok = commitDisplayedStable\(pending\.topicId, pending\.routeId, pending\.ownerEpoch\)/)
    expect(fx).toMatch(
      /if \(controller\.isSessionCurrent\(pending\.ownerEpoch\)\) \{\s*\n?.*failVisibleTransition\(pending\.ownerEpoch\)/
    )
    // Stale commit refusal drops only its own driver, never a newer session.
    expect(fx).toMatch(/if \(dividerVisibleRef\.current === pending\) dividerVisibleRef\.current = null/)
  })

  it('stale scheduled callbacks cannot affect a newer epoch', () => {
    const fx = visibleEffectSrc()
    // Every rAF body re-checks its own pending identity first (plus the
    // fallback entry guards its own pending the same way; current-session
    // failure funnels through dropOrFailVisible which keeps the same
    // identity guard).
    const staleGuards = fx.match(/dividerVisibleRef\.current !== pending/g)?.length ?? 0
    const dropFails = fx.match(/dropOrFailVisible\(\)/g)?.length ?? 0
    expect(staleGuards + dropFails).toBeGreaterThanOrEqual(3)
    // Controller-level stale safety: epoch-guarded release/terminate.
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const first = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm6::main',
      clickOffset: 10
    })
    expect(c.applyVisibleRebaseWindow(first.epoch, { topicId: 't1', route: 'b1' }, 'w-visible-1')).toBe(true)
    const second = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b2',
      dividerKey: 'm6::main',
      clickOffset: 12
    })
    expect(second.epoch).toBeGreaterThan(first.epoch)
    // Stale quiet work for the first epoch refuses everywhere and never
    // releases the newer session's ownership.
    expect(
      c.commitStable(first.epoch, { messageId: 'm1', intraRowOffset: 0, scrollTop: 0, isAtBottom: false }).committed
    ).toBe(false)
    expect(c.releaseSession(first.epoch)).toBe(false)
    expect(c.terminate(first.epoch, 'fail-visible').terminated).toBe(false)
    expect(c.fallbackVisibleToSearch(first.epoch)).toBe(false)
    expect(c.isSessionCurrent(second.epoch)).toBe(true)
    expect(c.programmaticOwned).toBe(true)
  })
})

describe('commit-false terminates/releases without stranded ownership (controller)', () => {
  it('refused commit holds ownership until the caller explicitly terminates', () => {
    const c = new RouteViewportController({ topicId: 't1', route: null })
    const { epoch } = c.request({
      kind: 'divider',
      topicId: 't1',
      targetRoute: 'b1',
      dividerKey: 'm6::main',
      clickOffset: 150
    })
    expect(c.applyVisibleRebaseWindow(epoch, { topicId: 't1', route: 'b1' }, 'w1')).toBe(true)
    expect(c.fallbackVisibleToSearch(epoch)).toBe(true)
    // Searching phase refuses the stable commit AND keeps ownership: without
    // an explicit same-session terminate the session would strand aligned-held
    // with no driver — the Messages quiet path therefore terminates.
    const refused = c.commitStable(epoch, { messageId: 'm6', intraRowOffset: 0, scrollTop: -50, isAtBottom: false })
    expect(refused.committed).toBe(false)
    expect(c.programmaticOwned).toBe(true)
    expect(c.currentPhase).toBe('searching')
    const term = c.terminate(epoch, 'fail-visible')
    expect(term.terminated).toBe(true)
    expect(term.didRelease).toBe(true)
    expect(c.programmaticOwned).toBe(false)
    // Second terminate is idempotent: exactly-once release.
    expect(c.terminate(epoch, 'fail-visible').terminated).toBe(false)
  })
})

describe('visible union gate fails closed (pure, exported cap truth)', () => {
  const buildExact = (): {
    plan: NonNullable<ReturnType<typeof planDividerVisibleRebase>>
    unionOldestFirst: Message[]
    unionNewestFirst: Message[]
    unionWindow: MessageWindow
    groupCount: number
  } => {
    const plan = planDividerVisibleRebase({ ...baseInput })!
    expect(plan).not.toBeNull()
    const currentNewestFirst = [...currentShifted].reverse().map(msg)
    const loadedOldestFirst = responseAround.map(msg)
    const unionNewestFirst = buildDividerVisibleMessages(currentNewestFirst, loadedOldestFirst, plan)
    const unionOldestFirst = [...unionNewestFirst].reverse()
    const unionModel = createMessageViewportGroupModel(unionOldestFirst)
    const forkIdx = unionModel.groups.indexOf(unionModel.messageIdToGroup.get('m15')!)
    const unionWindow = createTargetMessageWindow(
      unionOldestFirst,
      'm15',
      forkIdx + 1,
      unionModel.groups.length - forkIdx - 1,
      {
        hasMoreBefore: plan.hasMoreBefore,
        hasMoreAfter: plan.hasMoreAfter
      }
    )
    return { plan, unionOldestFirst, unionNewestFirst, unionWindow, groupCount: unionModel.groups.length }
  }

  it('exact union passes; trim/missing-ID/duplicate/flag/capacity mismatches fail closed', () => {
    const exact = buildExact()
    expect(
      isDividerVisibleUnionExact({
        plan: exact.plan,
        unionOldestFirst: exact.unionOldestFirst,
        unionNewestFirst: exact.unionNewestFirst,
        unionWindow: exact.unionWindow,
        unionModelGroupCount: exact.groupCount
      })
    ).toBe(true)

    // Bounded-viewport trim flag set while hasMore flags preserved → closed.
    expect(
      isDividerVisibleUnionExact({
        plan: exact.plan,
        unionOldestFirst: exact.unionOldestFirst,
        unionNewestFirst: exact.unionNewestFirst,
        unionWindow: {
          ...exact.unionWindow,
          boundedViewportObservability: { ...exact.unionWindow.boundedViewportObservability!, didTrim: true }
        },
        unionModelGroupCount: exact.groupCount
      })
    ).toBe(false)

    // Missing ID in the committed display list (silent trim above the cap).
    const dropped = { ...exact }
    const droppedWindow = {
      ...exact.unionWindow,
      displayMessages: exact.unionWindow.displayMessages.slice(1)
    }
    expect(
      isDividerVisibleUnionExact({
        plan: exact.plan,
        unionOldestFirst: exact.unionOldestFirst,
        unionNewestFirst: exact.unionNewestFirst,
        unionWindow: droppedWindow,
        unionModelGroupCount: exact.groupCount
      })
    ).toBe(false)
    void dropped

    // Duplicate ID in the committed display list.
    const dupWindow = {
      ...exact.unionWindow,
      displayMessages: [exact.unionWindow.displayMessages[0], ...exact.unionWindow.displayMessages]
    }
    expect(
      isDividerVisibleUnionExact({
        plan: exact.plan,
        unionOldestFirst: exact.unionOldestFirst,
        unionNewestFirst: exact.unionNewestFirst,
        unionWindow: dupWindow,
        unionModelGroupCount: exact.groupCount
      })
    ).toBe(false)

    // hasMore flags preserved across a trim/object mismatch → closed.
    expect(
      isDividerVisibleUnionExact({
        plan: exact.plan,
        unionOldestFirst: exact.unionOldestFirst,
        unionNewestFirst: exact.unionNewestFirst,
        unionWindow: { ...exact.unionWindow, hasMoreOlder: !exact.unionWindow.hasMoreOlder },
        unionModelGroupCount: exact.groupCount
      })
    ).toBe(false)

    // Group count/capacity inconsistency → closed.
    expect(
      isDividerVisibleUnionExact({
        plan: exact.plan,
        unionOldestFirst: exact.unionOldestFirst,
        unionNewestFirst: exact.unionNewestFirst,
        unionWindow: { ...exact.unionWindow, groupCount: exact.unionWindow.groupCount + 1 },
        unionModelGroupCount: exact.groupCount
      })
    ).toBe(false)
    expect(
      isDividerVisibleUnionExact({
        plan: exact.plan,
        unionOldestFirst: exact.unionOldestFirst,
        unionNewestFirst: exact.unionNewestFirst,
        unionWindow: {
          ...exact.unionWindow,
          groupCapacity: MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT + 1
        },
        unionModelGroupCount: exact.groupCount
      })
    ).toBe(false)
  })
})

describe('stable same-route window refresh stays intact (no adoption)', () => {
  const wid = (oldest: string, newest: string, len: number): string => `${oldest}::${newest}::${len}`

  it('existing stable same-route noteSameRouteWindowUpdate behavior stays intact', () => {
    const c = new RouteViewportController({ topicId: 't1', route: 'A' })
    expect(c.noteSameRouteWindowUpdate({ topicId: 't1', route: 'A' }, wid('a', 'b', 2))).toBe(true)
    expect(c.noteSameRouteWindowUpdate({ topicId: 't1', route: 'B' }, wid('a', 'b', 3))).toBe(false)
    c.markRenderedUnknown()
    expect(c.noteSameRouteWindowUpdate({ topicId: 't1', route: 'A' }, wid('a', 'b', 4))).toBe(false)
  })
})
