import { act, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COMPOSER_FLOATING_CONTROL_BAND_PX } from '../composerFloatingBand'
import {
  COMPOSER_OVERLAY_HEIGHT_VAR,
  COMPOSER_TAIL_INSET_VAR,
  type ComposerOverlayGeometry,
  readComposerTailInsetPx,
  resolveComposerTailInset,
  useComposerOverlayHeight
} from '../composerOverlayGeometry'
import { distanceFromBottom, maxScrollTop, readScrollMetrics } from '../flowScrollGeometry'
import { resolveUnobscuredReadingBand, SEARCH_MATCH_READING_PADDING_PX } from '../messageNavigation'

const rectFor = (height: number): DOMRect =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: height,
    right: 300,
    width: 300,
    height,
    toJSON: () => ({})
  }) as DOMRect

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  static callbacks: ResizeObserverCallback[] = []
  observed = new Set<Element>()
  constructor(callback?: ResizeObserverCallback) {
    if (callback) FakeResizeObserver.callbacks.push(callback)
    FakeResizeObserver.instances.push(this)
  }
  observe = (el: Element): void => {
    this.observed.add(el)
  }
  unobserve = (el: Element): void => {
    this.observed.delete(el)
  }
  disconnect = (): void => {
    this.observed.clear()
  }
}

const Probe = ({ onGeometry }: { onGeometry: (geometry: ComposerOverlayGeometry) => void }) => {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const geometry = useComposerOverlayHeight(ref)
  React.useEffect(() => {
    onGeometry(geometry)
  }, [geometry, onGeometry])
  return <div ref={ref} data-testid="composer-box" />
}

const heightsOf = (seen: ComposerOverlayGeometry[]): number[] => seen.map((g) => g.height)

const fireResizeObserved = (): void => {
  const callback = FakeResizeObserver.callbacks[0]
  const instance = FakeResizeObserver.instances[0]
  act(() => {
    callback([], instance as unknown as ResizeObserver)
  })
}

describe('composerOverlayGeometry tail inset (pure)', () => {
  it('adds the measured composer height to the existing control band', () => {
    expect(resolveComposerTailInset(120)).toBe(120 + COMPOSER_FLOATING_CONTROL_BAND_PX)
    expect(resolveComposerTailInset(40)).toBe(40 + COMPOSER_FLOATING_CONTROL_BAND_PX)
  })

  it('falls back to the band alone before the first measure (never zero, never double-counted)', () => {
    expect(resolveComposerTailInset(0)).toBe(COMPOSER_FLOATING_CONTROL_BAND_PX)
    expect(resolveComposerTailInset(-5)).toBe(COMPOSER_FLOATING_CONTROL_BAND_PX)
    expect(resolveComposerTailInset(Number.NaN)).toBe(COMPOSER_FLOATING_CONTROL_BAND_PX)
    expect(resolveComposerTailInset(undefined)).toBe(COMPOSER_FLOATING_CONTROL_BAND_PX)
    expect(resolveComposerTailInset('120' as unknown as number)).toBe(COMPOSER_FLOATING_CONTROL_BAND_PX)
  })

  it('publishes the vars the scroll tail reads (single-source names)', () => {
    expect(COMPOSER_OVERLAY_HEIGHT_VAR).toBe('--composer-overlay-height')
    expect(COMPOSER_TAIL_INSET_VAR).toBe('--composer-tail-inset')
  })

  it('reads the published tail inset off an element inheriting the canvas vars', () => {
    const el = document.createElement('div')
    el.style.setProperty(COMPOSER_TAIL_INSET_VAR, '152px')
    document.body.appendChild(el)
    expect(readComposerTailInsetPx(el)).toBe(152)
    el.remove()
  })

  it('readComposerTailInsetPx fails closed to 0 (unset var, garbage, missing element)', () => {
    expect(readComposerTailInsetPx(document.createElement('div'))).toBe(0)
    expect(readComposerTailInsetPx(null)).toBe(0)
    expect(readComposerTailInsetPx(undefined)).toBe(0)
    const garbage = document.createElement('div')
    garbage.style.setProperty(COMPOSER_TAIL_INSET_VAR, 'not-a-length')
    document.body.appendChild(garbage)
    expect(readComposerTailInsetPx(garbage)).toBe(0)
    garbage.remove()
  })
})

describe('useComposerOverlayHeight (single ResizeObserver, no scroll/focus/snapshot writes)', () => {
  let getBoundingClientRect: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = ''
    FakeResizeObserver.instances = []
    FakeResizeObserver.callbacks = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    getBoundingClientRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('measures the first frame synchronously in the layout phase', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    expect(heightsOf(seen)[heightsOf(seen).length - 1]).toBe(120)
    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances[0].observed.size).toBe(1)
  })

  it('follows composer growth (textarea wrap, tool-row show/hide) through the observer', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    expect(heightsOf(seen)[heightsOf(seen).length - 1]).toBe(120)
    getBoundingClientRect.mockReturnValue(rectFor(200))
    fireResizeObserved()
    const heights = heightsOf(seen)
    expect(heights[heights.length - 1]).toBe(200)
  })

  it('ignores same-height reports (no state churn)', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    const calls = seen.length
    fireResizeObserved()
    fireResizeObserved()
    expect(seen.length).toBe(calls)
    const heights = heightsOf(seen)
    expect(heights[heights.length - 1]).toBe(120)
  })

  it('same-height reports never advance the revision; real changes advance it monotonically', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    const first = seen[seen.length - 1]
    expect(first.revision).toBe(1)
    fireResizeObserved()
    expect(seen[seen.length - 1].revision).toBe(1)
    getBoundingClientRect.mockReturnValue(rectFor(200))
    fireResizeObserved()
    expect(seen[seen.length - 1].revision).toBe(2)
    getBoundingClientRect.mockReturnValue(rectFor(180))
    fireResizeObserved()
    expect(seen[seen.length - 1].revision).toBe(3)
    const revisions = seen.map((g) => g.revision)
    const sorted = [...revisions].sort((a, b) => a - b)
    expect(revisions).toEqual(sorted)
  })

  it('a box height transitionrun opens one logical animation; end/cancel closes it', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    const box = screen.getByTestId('composer-box')
    expect(seen[seen.length - 1].transitioning).toBe(false)
    expect(seen[seen.length - 1].transitionId).toBe(0)
    act(() => {
      const run = new Event('transitionrun', { bubbles: true }) as Event & { propertyName?: string }
      run.propertyName = 'height'
      box.dispatchEvent(run)
    })
    expect(seen[seen.length - 1].transitioning).toBe(true)
    expect(seen[seen.length - 1].transitionId).toBe(1)
    act(() => {
      const end = new Event('transitionend', { bubbles: true }) as Event & { propertyName?: string }
      end.propertyName = 'height'
      box.dispatchEvent(end)
    })
    expect(seen[seen.length - 1].transitioning).toBe(false)
    expect(seen[seen.length - 1].transitionId).toBe(1)
  })

  it('transitioncancel closes the logical animation without a new transition id', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    const box = screen.getByTestId('composer-box')
    act(() => {
      const run = new Event('transitionrun', { bubbles: true }) as Event & { propertyName?: string }
      run.propertyName = 'height'
      box.dispatchEvent(run)
    })
    expect(seen[seen.length - 1].transitioning).toBe(true)
    act(() => {
      const cancel = new Event('transitioncancel', { bubbles: true }) as Event & { propertyName?: string }
      cancel.propertyName = 'height'
      box.dispatchEvent(cancel)
    })
    const last = seen[seen.length - 1]
    expect(last.transitioning).toBe(false)
    expect(last.transitionId).toBe(1)
  })

  it('ignores transitions that do not drive the composer border-box height', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    const box = screen.getByTestId('composer-box')
    const calls = seen.length
    // A non-height property on the box is not a height episode.
    act(() => {
      const run = new Event('transitionrun', { bubbles: true }) as Event & { propertyName?: string }
      run.propertyName = 'opacity'
      box.dispatchEvent(run)
    })
    // A height transition on a CHILD (bubbled) never belongs to the box.
    act(() => {
      const child = document.createElement('div')
      box.append(child)
      const run = new Event('transitionrun', { bubbles: true }) as Event & { propertyName?: string }
      run.propertyName = 'height'
      child.dispatchEvent(run)
    })
    expect(seen.length).toBe(calls)
    expect(seen[seen.length - 1].transitioning).toBe(false)
    expect(seen[seen.length - 1].transitionId).toBe(0)
  })

  it('disconnects the observer exactly once on unmount', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const { unmount } = render(<Probe onGeometry={() => {}} />)
    expect(FakeResizeObserver.instances[0].observed.size).toBe(1)
    unmount()
    expect(FakeResizeObserver.instances[0].observed.size).toBe(0)
  })

  it('degrades to sync measure plus window resize when ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined as unknown as typeof ResizeObserver)
    getBoundingClientRect.mockReturnValue(rectFor(96))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    expect(heightsOf(seen)[heightsOf(seen).length - 1]).toBe(96)
    getBoundingClientRect.mockReturnValue(rectFor(140))
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(heightsOf(seen)[heightsOf(seen).length - 1]).toBe(140)
  })

  it('never takes over scrolling: no scrollTo call, scrollTop untouched', () => {
    getBoundingClientRect.mockReturnValue(rectFor(120))
    const seen: ComposerOverlayGeometry[] = []
    render(<Probe onGeometry={(geometry) => seen.push(geometry)} />)
    const box = screen.getByTestId('composer-box')
    // jsdom ships no scrollTo; install an own-property sentinel so any
    // takeover attempt would be observable without touching the prototype.
    const scrollTo = vi.fn()
    Object.defineProperty(box, 'scrollTo', { configurable: true, writable: true, value: scrollTo })
    box.scrollTop = 77
    getBoundingClientRect.mockReturnValue(rectFor(200))
    fireResizeObserved()
    expect(heightsOf(seen)[heightsOf(seen).length - 1]).toBe(200)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(box.scrollTop).toBe(77)
  })
})

describe('composer overlay tail geometry (last message clears the float)', () => {
  const tailInsetFor = (measuredComposerHeight: number): number => resolveComposerTailInset(measuredComposerHeight)

  it('at the real bottom the last row sits exactly one tail inset above the viewport edge', () => {
    const tail = tailInsetFor(120)
    const contentHeight = 848
    // scrollHeight carries the padded tail (content + inset), like the
    // ScrollContainer bottom padding does.
    const metrics = readScrollMetrics({ scrollTop: 0, scrollHeight: contentHeight + tail, clientHeight: 400 })
    const bottom = maxScrollTop(metrics)
    const atBottom = readScrollMetrics({ scrollTop: bottom, scrollHeight: contentHeight + tail, clientHeight: 400 })
    expect(distanceFromBottom(atBottom)).toBe(0)
    // Viewport bottom edge in content coordinates minus the last content row
    // bottom leaves exactly the reserved inset: the float covers nothing.
    const viewportBottom = atBottom.scrollTop + atBottom.clientHeight
    expect(viewportBottom - contentHeight).toBe(tail)
  })

  it('a short composer still reserves band plus box (never just the band)', () => {
    const tail = tailInsetFor(40)
    expect(tail).toBe(40 + COMPOSER_FLOATING_CONTROL_BAND_PX)
    expect(tail).toBeGreaterThan(COMPOSER_FLOATING_CONTROL_BAND_PX)
    const contentHeight = 500
    const metrics = readScrollMetrics({
      scrollTop: contentHeight + tail - 300,
      scrollHeight: contentHeight + tail,
      clientHeight: 300
    })
    expect(distanceFromBottom(metrics)).toBe(0)
    expect(metrics.scrollTop + metrics.clientHeight - contentHeight).toBe(tail)
  })

  it('pre-measure the band alone keeps the control trigger strip inside the scrollport', () => {
    const tail = tailInsetFor(0)
    expect(tail).toBe(COMPOSER_FLOATING_CONTROL_BAND_PX)
    const contentHeight = 900
    const metrics = readScrollMetrics({
      scrollTop: contentHeight + tail - 400,
      scrollHeight: contentHeight + tail,
      clientHeight: 400
    })
    expect(distanceFromBottom(metrics)).toBe(0)
  })
})

describe('unobscured reading band with the composer overlay inset', () => {
  it('defaults to the legacy band (no overlay info changes nothing)', () => {
    const band = resolveUnobscuredReadingBand({ containerTop: 0, containerHeight: 800, obscurer: null })
    expect(band).toEqual({ top: SEARCH_MATCH_READING_PADDING_PX, height: 800 - SEARCH_MATCH_READING_PADDING_PX * 2 })
  })

  it('subtracts the tail inset from the visible height only', () => {
    const tail = resolveComposerTailInset(120)
    const band = resolveUnobscuredReadingBand({
      containerTop: 0,
      containerHeight: 800,
      obscurer: null,
      bottomInsetPx: tail
    })
    expect(band).toEqual({
      top: SEARCH_MATCH_READING_PADDING_PX,
      height: 800 - tail - SEARCH_MATCH_READING_PADDING_PX * 2
    })
    expect(band!.height).toBeGreaterThan(0)
  })

  it('fails closed when the overlay covers the whole band', () => {
    expect(
      resolveUnobscuredReadingBand({ containerTop: 0, containerHeight: 100, obscurer: null, bottomInsetPx: 100 })
    ).toBeNull()
    expect(
      resolveUnobscuredReadingBand({ containerTop: 0, containerHeight: 800, obscurer: null, bottomInsetPx: 900 })
    ).toBeNull()
  })
})
