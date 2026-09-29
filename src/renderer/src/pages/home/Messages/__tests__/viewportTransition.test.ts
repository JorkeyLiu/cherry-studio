/**
 * Atomic viewport transition unit tests (approved one-frame fix).
 *
 * Covers the pure contract at the cheapest sufficient layer:
 * - hidden-but-measurable target commit (visibility, never display:none),
 * - pre-paint first positioning for every restoration kind (bottom, saved
 *   message + intra-row offset, divider + fallback chain, raw scrollTop),
 * - reveal tied to the same route/epoch (stale cannot reveal),
 * - failure/cancellation fails visible (never permanently hidden).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyViewportFirstPosition,
  isViewportTransitionCurrent,
  type ViewportFirstPositionPlan
} from '../viewportTransition'

const makeContainer = (scrollTop = 0): HTMLElement => {
  const el = document.createElement('div')
  el.getBoundingClientRect = () =>
    ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400, x: 0, y: 100 }) as DOMRect
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true })
  document.body.appendChild(el)
  return el
}

const makeRow = (id: string, top: number): HTMLElement => {
  const el = document.createElement('div')
  el.id = id
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40, x: 0, y: top }) as DOMRect
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('isViewportTransitionCurrent', () => {
  it('reveals only when topic + route + epoch + mounted all match', () => {
    expect(isViewportTransitionCurrent({ topicMatch: true, routeMatch: true, epochCurrent: true, mounted: true })).toBe(
      true
    )
  })

  it.each([
    [{ topicMatch: false, routeMatch: true, epochCurrent: true, mounted: true }],
    [{ topicMatch: true, routeMatch: false, epochCurrent: true, mounted: true }],
    [{ topicMatch: true, routeMatch: true, epochCurrent: false, mounted: true }],
    [{ topicMatch: true, routeMatch: true, epochCurrent: true, mounted: false }]
  ])('stays hidden on stale input %j (fail-visible by caller)', (input) => {
    expect(isViewportTransitionCurrent(input as never)).toBe(false)
  })
})

describe('applyViewportFirstPosition', () => {
  it('bottom snaps scrollTop to 0', () => {
    const container = makeContainer(220)
    expect(applyViewportFirstPosition(container, { kind: 'bottom' })).toBe('placed')
    expect(container.scrollTop).toBe(0)
  })

  it('raw scrollTop restores exactly', () => {
    const container = makeContainer(0)
    expect(applyViewportFirstPosition(container, { kind: 'scrollTop', scrollTop: -320 })).toBe('placed')
    expect(container.scrollTop).toBe(-320)
  })

  it('saved message row returns to its intra-row offset', () => {
    const container = makeContainer(0)
    // Row top 210 relative to document; container top 100 → offset 110.
    makeRow('message-m1', 210)
    // Want offset 30 → delta +80 applied to scrollTop.
    const plan: ViewportFirstPositionPlan = {
      kind: 'message',
      messageId: 'm1',
      wantOffset: 30,
      fallbackScrollTop: -999
    }
    expect(applyViewportFirstPosition(container, plan)).toBe('placed')
    expect(container.scrollTop).toBe(80)
  })

  it('message plan without offset scrolls the row into view', () => {
    const container = makeContainer(0)
    const row = makeRow('message-m2', 400)
    const spy = vi.fn()
    row.scrollIntoView = spy as never
    expect(
      applyViewportFirstPosition(container, {
        kind: 'message',
        messageId: 'm2',
        wantOffset: null,
        fallbackScrollTop: 0
      })
    ).toBe('placed')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('missing message row is unplaced (caller still reveals fail-visible)', () => {
    const container = makeContainer(50)
    expect(
      applyViewportFirstPosition(container, {
        kind: 'message',
        messageId: 'ghost',
        wantOffset: 10,
        fallbackScrollTop: null
      })
    ).toBe('unplaced')
    expect(container.scrollTop).toBe(50)
  })

  it('missing message row uses the explicit raw scrollTop fallback (never a silent unplaced reveal)', () => {
    const container = makeContainer(50)
    expect(
      applyViewportFirstPosition(container, {
        kind: 'message',
        messageId: 'ghost',
        wantOffset: 10,
        fallbackScrollTop: -320
      })
    ).toBe('placed')
    expect(container.scrollTop).toBe(-320)
  })

  it('missing message row already at the fallback offset reports placed without moving', () => {
    const container = makeContainer(-320)
    expect(
      applyViewportFirstPosition(container, {
        kind: 'message',
        messageId: 'ghost',
        wantOffset: 10,
        fallbackScrollTop: -320
      })
    ).toBe('placed')
    expect(container.scrollTop).toBe(-320)
  })

  it('divider row returns to the same offset', () => {
    const container = makeContainer(10)
    const row = document.createElement('div')
    row.setAttribute('data-divider-key', 'anchor::parent')
    row.getBoundingClientRect = () =>
      ({ top: 260, bottom: 280, left: 0, right: 300, width: 300, height: 20, x: 0, y: 260 }) as DOMRect
    Object.defineProperty(row, 'isConnected', { value: true, configurable: true })
    document.body.appendChild(row)
    const plan: ViewportFirstPositionPlan = {
      kind: 'divider',
      dividerKey: 'anchor::parent',
      anchorMessageId: 'anchor',
      wantOffset: 60,
      fallbackMessageId: null,
      fallbackOffset: null,
      rawScrollTop: null
    }
    // have 160, want 60 → delta +100.
    expect(applyViewportFirstPosition(container, plan)).toBe('placed')
    expect(container.scrollTop).toBe(110)
  })

  it('divider falls back to the shared message row when the divider is absent', () => {
    const container = makeContainer(0)
    makeRow('message-shared', 150)
    const plan: ViewportFirstPositionPlan = {
      kind: 'divider',
      dividerKey: 'missing::parent',
      anchorMessageId: 'anchor',
      wantOffset: 999,
      fallbackMessageId: 'shared',
      fallbackOffset: 20,
      rawScrollTop: -50
    }
    // have 50, want 20 → delta +30.
    expect(applyViewportFirstPosition(container, plan)).toBe('placed')
    expect(container.scrollTop).toBe(30)
  })

  it('divider falls back to raw scrollTop when both rows are absent', () => {
    const container = makeContainer(0)
    const plan: ViewportFirstPositionPlan = {
      kind: 'divider',
      dividerKey: 'missing::parent',
      anchorMessageId: 'anchor',
      wantOffset: 999,
      fallbackMessageId: null,
      fallbackOffset: null,
      rawScrollTop: -77
    }
    expect(applyViewportFirstPosition(container, plan)).toBe('placed')
    expect(container.scrollTop).toBe(-77)
  })

  it('divider with edge fallback parks a partial window at the oldest edge as INTERMEDIATE search (never placed/stable)', () => {
    const container = makeContainer(0)
    Object.defineProperty(container, 'clientHeight', { value: 402, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 1268, configurable: true })
    const plan: ViewportFirstPositionPlan = {
      kind: 'divider',
      dividerKey: 'missing::parent',
      anchorMessageId: 'anchor',
      wantOffset: 999,
      fallbackMessageId: null,
      fallbackOffset: null,
      rawScrollTop: null,
      edgeFallbackOnMissing: true
    }
    // Oldest edge = min(0, 402 - 1268) = -866: a partial window lands near
    // the pagination edge and auto-pages under the divider anchor. The
    // outcome is `searching` — the caller must keep the restore intent,
    // ownership, and preferred anchor and drive restore-owned pagination;
    // it must NOT commit this edge scroll as the route stable snapshot.
    expect(applyViewportFirstPosition(container, plan)).toBe('searching')
    expect(applyViewportFirstPosition(container, plan)).not.toBe('placed')
    expect(container.scrollTop).toBe(-866)
  })

  it('message with edge fallback parks a partial window at the oldest edge as INTERMEDIATE search', () => {
    const container = makeContainer(0)
    Object.defineProperty(container, 'clientHeight', { value: 402, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 1754, configurable: true })
    expect(
      applyViewportFirstPosition(container, {
        kind: 'message',
        messageId: 'ghost',
        wantOffset: 10,
        fallbackScrollTop: null,
        edgeFallbackOnMissing: true
      })
    ).toBe('searching')
    expect(container.scrollTop).toBe(-1352)
  })

  it('divider with edge fallback skips parking the newest row at the top (still searching, not placed)', () => {
    const container = makeContainer(0)
    Object.defineProperty(container, 'clientHeight', { value: 402, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 1268, configurable: true })
    // Anchor row exists but the divider + shared rows are absent: the edge
    // contract wins over scrollIntoView so the window stays near the
    // pagination edge instead of stranding the newest row at the top.
    makeRow('message-anchor', 700)
    const spy = vi.fn()
    document.getElementById('message-anchor')!.scrollIntoView = spy as never
    const plan: ViewportFirstPositionPlan = {
      kind: 'divider',
      dividerKey: 'missing::parent',
      anchorMessageId: 'anchor',
      wantOffset: 999,
      fallbackMessageId: null,
      fallbackOffset: null,
      rawScrollTop: null,
      edgeFallbackOnMissing: true
    }
    expect(applyViewportFirstPosition(container, plan)).toBe('searching')
    expect(spy).not.toHaveBeenCalled()
    expect(container.scrollTop).toBe(-866)
  })

  it('edge searching never reports placed: requested identity still unresident', () => {
    // Regression guard for the 867px drift: treating the edge park as success
    // let the coordinator commit stable + release ownership before the anchor
    // was resident, so later pagination ran anchor-less. The type makes the
    // confusion inexpressible: only 'placed' authorizes a stable commit.
    const container = makeContainer(0)
    Object.defineProperty(container, 'clientHeight', { value: 402, configurable: true })
    Object.defineProperty(container, 'scrollHeight', { value: 1268, configurable: true })
    const outcome = applyViewportFirstPosition(container, {
      kind: 'divider',
      dividerKey: 'missing::parent',
      anchorMessageId: 'anchor',
      wantOffset: 999,
      fallbackMessageId: null,
      fallbackOffset: null,
      rawScrollTop: null,
      edgeFallbackOnMissing: true
    })
    expect(outcome).toBe('searching')
    const commitAuthorized = outcome === 'placed'
    expect(commitAuthorized).toBe(false)
  })

  it('none plan never moves (fail-visible reveal without placement)', () => {
    const container = makeContainer(33)
    expect(applyViewportFirstPosition(container, { kind: 'none' })).toBe('unplaced')
    expect(container.scrollTop).toBe(33)
  })
})
