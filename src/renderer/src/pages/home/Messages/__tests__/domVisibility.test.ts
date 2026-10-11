/**
 * Tests for domVisibility helpers — shared visibility logic used by
 * findFirstVisibleMessage (load-more anchoring) and findFirstVisibleMessageId
 * (scroll-position saving).
 *
 * The ordered path is covered production-faithfully: flat display ids run
 * newest-first (as `messageWindow.displayMessages`), while live row geometry
 * runs oldest-first top-to-bottom (column-reverse outer + oldest-first group
 * inner order + fold `display:none` siblings). Tests below model that split
 * explicitly — never increasing tops in flat display order.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  buildVisualAnchorMembership,
  createVisibleAnchorCache,
  findAnchorInOrderedRows,
  findFirstVisibleMessage,
  findFirstVisibleMessageId,
  findViewportTopAnchorWithOffset,
  getMessageRowById,
  isElementVisibleInViewport
} from '../domVisibility'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal DOMRect with only the fields the helpers read. */
const rect = (top: number, bottom: number): DOMRect => ({
  top,
  bottom,
  height: bottom - top,
  left: 0,
  right: 100,
  width: 100,
  x: 0,
  y: top,
  toJSON: () => ({})
})

const createMockElement = (id: string, elementRect: DOMRect, options: { display?: string } = {}): HTMLElement => {
  const el = document.createElement('div')
  el.id = id
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => elementRect,
    configurable: true
  })

  // Mock getComputedStyle
  const origGetComputedStyle = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((elt) => {
    if (elt === el) {
      return { display: options.display ?? 'block' } as CSSStyleDeclaration
    }
    return origGetComputedStyle(elt)
  })

  return el
}

// ---------------------------------------------------------------------------
// isElementVisibleInViewport
// ---------------------------------------------------------------------------
describe('isElementVisibleInViewport', () => {
  const containerRect = rect(0, 1000)

  it('returns true for a fully visible element', () => {
    const el = createMockElement('msg-1', rect(100, 300))
    expect(isElementVisibleInViewport(el, containerRect)).toBe(true)
    vi.restoreAllMocks()
  })

  it('returns true for a partially visible element', () => {
    const el = createMockElement('msg-1', rect(-100, 200))
    expect(isElementVisibleInViewport(el, containerRect)).toBe(true)
    vi.restoreAllMocks()
  })

  it('returns false for display:none elements (folded siblings)', () => {
    const el = createMockElement('msg-folded', rect(100, 300), { display: 'none' })
    expect(isElementVisibleInViewport(el, containerRect)).toBe(false)
    vi.restoreAllMocks()
  })

  it('returns false for zero-height elements', () => {
    const el = createMockElement('msg-zero', rect(100, 100))
    expect(isElementVisibleInViewport(el, containerRect)).toBe(false)
    vi.restoreAllMocks()
  })

  it('returns false for elements above viewport', () => {
    const el = createMockElement('msg-above', rect(-500, -300))
    expect(isElementVisibleInViewport(el, containerRect)).toBe(false)
    vi.restoreAllMocks()
  })

  it('returns false for elements below viewport', () => {
    const el = createMockElement('msg-below', rect(1100, 1300))
    expect(isElementVisibleInViewport(el, containerRect)).toBe(false)
    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// findFirstVisibleMessage (map-based)
// ---------------------------------------------------------------------------
describe('findFirstVisibleMessage', () => {
  const containerRect = rect(0, 1000)

  const makeContainer = () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => containerRect,
      configurable: true
    })
    return container
  }

  it('returns the element closest to container top', () => {
    const container = makeContainer()
    const el1 = createMockElement('msg-1', rect(200, 400))
    const el2 = createMockElement('msg-2', rect(600, 800))
    const elements = new Map<string, HTMLElement>([
      ['m1', el1],
      ['m2', el2]
    ])

    const result = findFirstVisibleMessage(container, elements)
    expect(result?.element).toBe(el1)
    vi.restoreAllMocks()
  })

  it('skips folded (display:none) elements', () => {
    const container = makeContainer()
    const elFolded = createMockElement('msg-folded', rect(100, 300), { display: 'none' })
    const elVisible = createMockElement('msg-visible', rect(400, 600))
    const elements = new Map<string, HTMLElement>([
      ['m-folded', elFolded],
      ['m-visible', elVisible]
    ])

    const result = findFirstVisibleMessage(container, elements)
    expect(result?.element).toBe(elVisible)
    vi.restoreAllMocks()
  })

  it('skips zero-height elements', () => {
    const container = makeContainer()
    const elZero = createMockElement('msg-zero', rect(100, 100))
    const elVisible = createMockElement('msg-visible', rect(400, 600))
    const elements = new Map<string, HTMLElement>([
      ['m-zero', elZero],
      ['m-visible', elVisible]
    ])

    const result = findFirstVisibleMessage(container, elements)
    expect(result?.element).toBe(elVisible)
    vi.restoreAllMocks()
  })

  it('returns null for empty elements map', () => {
    const container = makeContainer()
    const result = findFirstVisibleMessage(container, new Map())
    expect(result).toBeNull()
  })

  it('returns null for null container', () => {
    const el = createMockElement('msg-1', rect(100, 300))
    const result = findFirstVisibleMessage(null, new Map([['m1', el]]))
    expect(result).toBeNull()
    vi.restoreAllMocks()
  })

  it('skips all hidden elements and returns null when none visible', () => {
    const container = makeContainer()
    const elHidden1 = createMockElement('msg-h1', rect(100, 300), { display: 'none' })
    const elHidden2 = createMockElement('msg-h2', rect(400, 400)) // zero height
    const elements = new Map<string, HTMLElement>([
      ['m-h1', elHidden1],
      ['m-h2', elHidden2]
    ])

    const result = findFirstVisibleMessage(container, elements)
    expect(result).toBeNull()
    vi.restoreAllMocks()
  })

  it('selects visible element when sibling is folded (multi-model fold scenario)', () => {
    const container = makeContainer()
    // Simulate: 3 assistant siblings sharing same askId
    // First is selected (visible), others are folded (display:none)
    const elSelected = createMockElement('msg-a1', rect(100, 400), { display: 'block' })
    const elFolded1 = createMockElement('msg-a2', rect(0, 0), { display: 'none' })
    const elFolded2 = createMockElement('msg-a3', rect(0, 0), { display: 'none' })
    const elements = new Map<string, HTMLElement>([
      ['m-a1', elSelected],
      ['m-a2', elFolded1],
      ['m-a3', elFolded2]
    ])

    const result = findFirstVisibleMessage(container, elements)
    expect(result?.element).toBe(elSelected)
    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// findFirstVisibleMessageId (query-based)
// ---------------------------------------------------------------------------
describe('findFirstVisibleMessageId', () => {
  const containerRect = rect(0, 1000)

  const makeContainerWithChildren = (
    children: Array<{ id: string; top: number; bottom: number; display?: string }>
  ) => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => containerRect,
      configurable: true
    })

    for (const spec of children) {
      const child = document.createElement('div')
      child.id = spec.id
      Object.defineProperty(child, 'getBoundingClientRect', {
        value: () => rect(spec.top, spec.bottom),
        configurable: true
      })
      container.appendChild(child)
    }

    return container
  }

  it('returns the ID of the element closest to container top', () => {
    const container = makeContainerWithChildren([
      { id: 'message-m1', top: 200, bottom: 400 },
      { id: 'message-m2', top: 600, bottom: 800 }
    ])

    expect(findFirstVisibleMessageId(container)).toBe('m1')
  })

  it('skips message-group containers', () => {
    const container = makeContainerWithChildren([
      { id: 'message-group-g1', top: 100, bottom: 300 },
      { id: 'message-m1', top: 200, bottom: 400 }
    ])

    expect(findFirstVisibleMessageId(container)).toBe('m1')
  })

  it('returns null for null container', () => {
    expect(findFirstVisibleMessageId(null)).toBeNull()
  })

  it('returns null for empty container', () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => containerRect,
      configurable: true
    })
    expect(findFirstVisibleMessageId(container)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildVisualAnchorMembership (visual order: reverse of newest-first display)
// ---------------------------------------------------------------------------
describe('buildVisualAnchorMembership', () => {
  it('returns live registry elements in visual (oldest-first) order, skipping missing/detached', () => {
    const registry = new Map<string, HTMLElement>()
    const live0 = document.createElement('div')
    live0.id = 'message-a'
    const live1 = document.createElement('div')
    live1.id = 'message-b'
    const detached = document.createElement('div')
    detached.id = 'message-c'
    document.body.append(live0, live1)
    registry.set('b', live1)
    registry.set('a', live0)
    registry.set('c', detached)
    registry.set('missing', document.createElement('div'))
    registry.get('missing')!.remove()
    // Newest-first display order b, a, c, missing, ghost → visual order is the
    // reverse (a before b); detached/missing/ghost are skipped.
    const rows = buildVisualAnchorMembership(['b', 'a', 'c', 'missing', 'ghost'], registry)
    expect(rows).toEqual([live0, live1])
    live0.remove()
    live1.remove()
  })

  it('performs no style or geometry reads while assembling membership', () => {
    const registry = new Map<string, HTMLElement>()
    const ids: string[] = []
    for (let i = 0; i < 50; i++) {
      const el = document.createElement('div')
      el.id = `message-m${i}`
      document.body.appendChild(el)
      registry.set(`m${i}`, el)
      ids.push(`m${i}`)
    }
    let rectCalls = 0
    let styleCalls = 0
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      rectCalls += 1
      return rect(0, 0)
    })
    const styleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((() => {
      styleCalls += 1
      return { display: 'block' } as CSSStyleDeclaration
    }) as typeof window.getComputedStyle)
    const rows = buildVisualAnchorMembership(ids, registry)
    expect(rows).toHaveLength(50)
    // Visual order is the reverse of the newest-first display ids.
    expect(rows[0].id).toBe('message-m49')
    expect(rows[49].id).toBe('message-m0')
    expect(rectCalls).toBe(0)
    expect(styleCalls).toBe(0)
    rectSpy.mockRestore()
    styleSpy.mockRestore()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// Visible anchor cache + exact ordered core (production-faithful geometry)
// ---------------------------------------------------------------------------
describe('visible anchor cache (production order: newest-first ids, oldest-first tops)', () => {
  interface Counters {
    rects: number
    styles: number
  }

  interface ProductionStack {
    container: HTMLElement
    /** Newest-first flat display ids (as `messageWindow.displayMessages`). */
    displayNewestFirst: string[]
    registry: Map<string, HTMLElement>
    counters: Counters
    cleanup: () => void
  }

  /**
   * Production-like stack: DOM children append newest-first (as the
   * column-reverse outer renders newest groups first) while live tops run
   * oldest-first ascending (oldest group paints at the top; group inner order
   * is oldest-first in normal flow). Hidden fold siblings get inline
   * `display:none` plus a zero box, exactly like collapsed production rows.
   */
  const buildProductionStack = (
    n: number,
    geometry: (visualIndex: number) => { top: number; height: number; hidden?: boolean },
    options: { duplicates?: boolean } = {}
  ): ProductionStack => {
    const counters: Counters = { rects: 0, styles: 0 }
    const container = document.createElement('div')
    document.body.appendChild(container)
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => {
        counters.rects += 1
        return rect(0, 600)
      },
      configurable: true
    })
    const registry = new Map<string, HTMLElement>()
    // Newest-first flat display ids (visual index 0 is oldest).
    const displayNewestFirst: string[] = []
    for (let v = n - 1; v >= 0; v--) displayNewestFirst.push(`r${v}`)
    // DOM append newest-first (column-reverse production order).
    for (let v = n - 1; v >= 0; v--) {
      const spec = geometry(v)
      const outer = document.createElement('div')
      outer.id = `message-r${v}`
      if (spec.hidden) outer.style.display = 'none'
      const top = spec.hidden ? 0 : spec.top
      const bottom = spec.hidden ? 0 : spec.top + spec.height
      Object.defineProperty(outer, 'getBoundingClientRect', {
        value: () => {
          counters.rects += 1
          return rect(top, bottom)
        },
        configurable: true
      })
      container.appendChild(outer)
      registry.set(`r${v}`, outer)
      if (options.duplicates) {
        // Inner content box under the same id (production duplicate wrappers);
        // the registry keeps the canonical outer row.
        const inner = document.createElement('div')
        inner.id = `message-r${v}`
        inner.setAttribute('data-message-id', `r${v}`)
        Object.defineProperty(inner, 'getBoundingClientRect', {
          value: () => {
            counters.rects += 1
            return rect(top + 2, bottom)
          },
          configurable: true
        })
        outer.appendChild(inner)
      }
    }
    const origGetComputedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
      counters.styles += 1
      return origGetComputedStyle(el)
    }) as typeof window.getComputedStyle)
    return {
      container,
      displayNewestFirst,
      registry,
      counters,
      cleanup: () => {
        container.remove()
        vi.restoreAllMocks()
      }
    }
  }

  // Rows 100px pitch, 80px tall (20px gaps); visual row `crossAt` straddles the edge.
  const stacked = (crossAt: number) => (v: number) => ({
    top: (v - crossAt) * 100 - 30,
    height: 80
  })

  const windowOf = (ids: string[]) => ({ displayMessages: ids.map((id) => ({ id })) })

  it('establishes visual order from live geometry even though flat display ids run newest-first', () => {
    const n = 60
    const crossAt = 30
    const stack = buildProductionStack(n, stacked(crossAt))
    const cache = createVisibleAnchorCache()
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: windowOf(stack.displayNewestFirst),
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    expect(rows).toHaveLength(n)
    // Oldest-first visual order: r0 has the smallest top.
    expect(rows[0].id).toBe('message-r0')
    expect(rows[n - 1].id).toBe(`message-r${n - 1}`)
    const result = findAnchorInOrderedRows(stack.container, rows)
    expect(result).toEqual({ messageId: `r${crossAt}`, intraRowOffset: -30 })
    stack.cleanup()
  })

  it('resolves the crossing row with logarithmically bounded measurement calls (N=300 and N=1200)', () => {
    for (const n of [300, 1200]) {
      const crossAt = Math.floor(n / 2)
      const stack = buildProductionStack(n, stacked(crossAt))
      const cache = createVisibleAnchorCache()
      const win = windowOf(stack.displayNewestFirst)
      const buildRects = stack.counters.rects
      const buildStyles = stack.counters.styles
      const rows = cache.getVisibleRows({
        container: stack.container,
        window: win,
        registry: stack.registry,
        registryVersion: 0,
        foldVersion: 0
      })
      // One O(N) build: one style + one rect per member row (plus container).
      expect(stack.counters.rects - buildRects).toBeLessThanOrEqual(n + 4)
      expect(stack.counters.styles - buildStyles).toBeLessThanOrEqual(n + 2)
      expect(cache.stats().builds).toBe(1)
      const before = { ...stack.counters }
      const result = findAnchorInOrderedRows(stack.container, rows)
      expect(result).toEqual({ messageId: `r${crossAt}`, intraRowOffset: -30 })
      // Non-scaling proof: identical absolute bounds at 300 and 1200 rows
      // (binary search + O(1) neighbour validation, never a per-row scan).
      expect(stack.counters.rects - before.rects).toBeLessThanOrEqual(40)
      expect(stack.counters.styles - before.styles).toBeLessThanOrEqual(6)
      // Repeated captures on ordinary scroll never rebuild and stay logarithmic.
      for (let k = 0; k < 4; k++) {
        const againRows = cache.getVisibleRows({
          container: stack.container,
          window: win,
          registry: stack.registry,
          registryVersion: 0,
          foldVersion: 0
        })
        expect(againRows).toBe(rows)
        const loopBefore = { ...stack.counters }
        expect(findAnchorInOrderedRows(stack.container, againRows)).toEqual(result)
        expect(stack.counters.rects - loopBefore.rects).toBeLessThanOrEqual(40)
        expect(stack.counters.styles - loopBefore.styles).toBeLessThanOrEqual(6)
      }
      expect(cache.stats().builds).toBe(1)
      stack.cleanup()
    }
  })

  it('resolves first-below across a 43px inter-row gap with no full-list scan', () => {
    const n = 300
    const stack = buildProductionStack(n, (v) => {
      if (v < 150) return { top: (v - 150) * 100 - 30, height: 80 }
      if (v === 150) return { top: 5, height: 80 }
      return { top: 5 + (v - 150) * 100, height: 80 }
    })
    const prev = stack.registry.get('r149')!
    Object.defineProperty(prev, 'getBoundingClientRect', {
      value: () => {
        stack.counters.rects += 1
        return rect(-123, -43)
      },
      configurable: true
    })
    const cache = createVisibleAnchorCache()
    const win = windowOf(stack.displayNewestFirst)
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    const before = { ...stack.counters }
    const result = findAnchorInOrderedRows(stack.container, rows)
    expect(result).toEqual({ messageId: 'r150', intraRowOffset: 5 })
    expect(stack.counters.rects - before.rects).toBeLessThanOrEqual(40)
    expect(stack.counters.styles - before.styles).toBeLessThanOrEqual(6)
    stack.cleanup()
  })

  it('resolves first-below under a divider row at the container top', () => {
    const n = 300
    const stack = buildProductionStack(n, (v) => {
      if (v < 150) return { top: (v - 150) * 100 - 30, height: 80 }
      if (v === 150) return { top: 18, height: 80 }
      return { top: 18 + (v - 150) * 100, height: 80 }
    })
    const divider = document.createElement('div')
    divider.setAttribute('data-divider-key', 'd1')
    Object.defineProperty(divider, 'getBoundingClientRect', {
      value: () => {
        stack.counters.rects += 1
        return rect(-12, 18)
      },
      configurable: true
    })
    stack.container.insertBefore(divider, stack.container.firstChild)
    const cache = createVisibleAnchorCache()
    const win = windowOf(stack.displayNewestFirst)
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    const before = { ...stack.counters }
    const result = findAnchorInOrderedRows(stack.container, rows)
    expect(result).toEqual({ messageId: 'r150', intraRowOffset: 18 })
    expect(stack.counters.rects - before.rects).toBeLessThanOrEqual(40)
    expect(stack.counters.styles - before.styles).toBeLessThanOrEqual(6)
    stack.cleanup()
  })

  it('absorbs a 45-hidden fold run with no run-length assumption and matches the exact scan', () => {
    // Folded multi-model siblings: 45 CONSECUTIVE display:none rows (well past
    // any fixed skip/validate budget) plus two isolated hidden rows. Hidden
    // membership is filtered once at cache build time, so the run length is
    // irrelevant to per-scroll cost and the ordered core agrees with the exact
    // full scan oracle.
    const n = 300
    const hidden = new Set<number>()
    for (let v = 100; v < 145; v++) hidden.add(v)
    hidden.add(40)
    hidden.add(200)
    const stack = buildProductionStack(n, (v) => {
      if (hidden.has(v)) return { top: 0, height: 0, hidden: true }
      let shift = 0
      for (const h of hidden) if (h < v) shift += 1
      return { top: (v - shift - 150) * 100 - 30, height: 80 }
    })
    const cache = createVisibleAnchorCache()
    const win = windowOf(stack.displayNewestFirst)
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    expect(rows).toHaveLength(n - hidden.size)
    const buildRects = stack.counters.rects
    const buildStyles = stack.counters.styles
    const before = { ...stack.counters }
    const result = findAnchorInOrderedRows(stack.container, rows)
    // Snapshot the ordered-path cost BEFORE the exact-scan oracle below (the
    // oracle itself is the N-proportional path being replaced).
    const orderedRects = stack.counters.rects - before.rects
    const orderedStyles = stack.counters.styles - before.styles
    const expected = findViewportTopAnchorWithOffset(stack.container)
    expect(result).not.toBeNull()
    expect(result).toEqual(expected)
    expect(orderedRects).toBeLessThanOrEqual(40)
    expect(orderedStyles).toBeLessThanOrEqual(8)
    expect(buildRects).toBeLessThanOrEqual(n + 4)
    expect(buildStyles).toBeLessThanOrEqual(n + 2)
    expect(cache.stats().builds).toBe(1)
    stack.cleanup()
  })

  it('resolves an extremely tall crossing row exactly (no midpoint model)', () => {
    // A single 5000px row straddles the edge; rows above and below are far in
    // absolute distance. Crossing-first must win over the nearer-below row.
    const n = 60
    const stack = buildProductionStack(n, (v) => {
      if (v === 30) return { top: -2000, height: 5000 }
      if (v < 30) return { top: -2000 - (30 - v) * 100, height: 80 }
      return { top: 3000 + (v - 31) * 100, height: 80 }
    })
    const cache = createVisibleAnchorCache()
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: windowOf(stack.displayNewestFirst),
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    expect(findAnchorInOrderedRows(stack.container, rows)).toEqual({
      messageId: 'r30',
      intraRowOffset: -2000
    })
    expect(findAnchorInOrderedRows(stack.container, rows)).toEqual(findViewportTopAnchorWithOffset(stack.container))
    stack.cleanup()
  })

  it('uses one canonical element per id for duplicate nested wrappers (no nested-wrapper scan)', () => {
    const stack = buildProductionStack(3, stacked(1), { duplicates: true })
    const cache = createVisibleAnchorCache()
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: windowOf(stack.displayNewestFirst),
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    // One canonical (outer) row per id despite inner duplicates in the DOM.
    expect(rows).toHaveLength(3)
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(3)
    for (const r of rows) {
      expect(r.hasAttribute('data-message-id')).toBe(false)
    }
    const ordered = findAnchorInOrderedRows(stack.container, rows)
    const exact = findViewportTopAnchorWithOffset(stack.container)
    expect(ordered).not.toBeNull()
    expect(ordered).toEqual(exact)
    stack.cleanup()
  })

  it('tolerates late height changes without a rebuild (order preserved, live geometry re-read)', () => {
    const n = 120
    const stack = buildProductionStack(n, stacked(60))
    const cache = createVisibleAnchorCache()
    const win = windowOf(stack.displayNewestFirst)
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    expect(findAnchorInOrderedRows(stack.container, rows)).toEqual({
      messageId: 'r60',
      intraRowOffset: -30
    })
    // Late image/markdown growth: the crossing row doubles in height in place.
    // Tops keep their order, so no invalidation is needed and the live read
    // still resolves the same crossing row.
    const tall = stack.registry.get('r60')!
    Object.defineProperty(tall, 'getBoundingClientRect', {
      value: () => {
        stack.counters.rects += 1
        return rect(-30, 130)
      },
      configurable: true
    })
    const sameRows = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    expect(sameRows).toBe(rows)
    expect(cache.stats().builds).toBe(1)
    expect(findAnchorInOrderedRows(stack.container, sameRows)).toEqual({
      messageId: 'r60',
      intraRowOffset: -30
    })
    stack.cleanup()
  })

  it('rebuilds on node replacement, fold selection, and window extension — never per scroll', () => {
    const n = 60
    const stack = buildProductionStack(n, stacked(30))
    const cache = createVisibleAnchorCache()
    const win = windowOf(stack.displayNewestFirst)
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    expect(rows).toHaveLength(n)
    expect(cache.stats().builds).toBe(1)

    // Node replacement: same id, fresh element (React re-mount). Registry
    // version bump forces exactly one rebuild; the fresh node is adopted.
    const fresh = document.createElement('div')
    fresh.id = 'message-r30'
    Object.defineProperty(fresh, 'getBoundingClientRect', {
      value: () => {
        stack.counters.rects += 1
        return rect(-30, 50)
      },
      configurable: true
    })
    stack.registry.get('r30')!.remove()
    stack.container.appendChild(fresh)
    stack.registry.set('r30', fresh)
    const rebuilt = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 1,
      foldVersion: 0
    })
    expect(cache.stats().builds).toBe(2)
    expect(rebuilt).toContain(fresh)
    expect(findAnchorInOrderedRows(stack.container, rebuilt)).toEqual({
      messageId: 'r30',
      intraRowOffset: -30
    })

    // Fold selection flip: same nodes and window, new visibility. The fold
    // version bump forces exactly one rebuild that drops the hidden row.
    stack.registry.get('r31')!.style.display = 'none'
    Object.defineProperty(stack.registry.get('r31')!, 'getBoundingClientRect', {
      value: () => {
        stack.counters.rects += 1
        return rect(0, 0)
      },
      configurable: true
    })
    const refolded = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 1,
      foldVersion: 1
    })
    expect(cache.stats().builds).toBe(3)
    expect(refolded).toHaveLength(n - 1)
    expect(refolded.map((r) => r.id)).not.toContain('message-r31')

    // Window extension: older pagination admits new ids under a new window
    // reference. Exactly one rebuild adopts them.
    const extendedIds = [...stack.displayNewestFirst]
    const extra: HTMLElement[] = []
    for (let k = 0; k < 5; k++) {
      const el = document.createElement('div')
      el.id = `message-old${k}`
      const top = -1030 - (4 - k) * 100
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => {
          stack.counters.rects += 1
          return rect(top, top + 80)
        },
        configurable: true
      })
      stack.container.appendChild(el)
      stack.registry.set(`old${k}`, el)
      extra.push(el)
      extendedIds.push(`old${k}`)
    }
    const win2 = windowOf(extendedIds)
    const extended = cache.getVisibleRows({
      container: stack.container,
      window: win2,
      registry: stack.registry,
      registryVersion: 2,
      foldVersion: 1
    })
    expect(cache.stats().builds).toBe(4)
    expect(extended.length).toBe(refolded.length + 5)
    for (const el of extra) stack.registry.get(el.id.replace(/^message-/, ''))?.remove()
    stack.cleanup()
  })

  it('defers while the route container is hidden and rebuilds on visible reactivation', () => {
    const n = 60
    const stack = buildProductionStack(n, stacked(30))
    const cache = createVisibleAnchorCache()
    const win = windowOf(stack.displayNewestFirst)
    const rows = cache.getVisibleRows({
      container: stack.container,
      window: win,
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 0
    })
    expect(cache.stats().builds).toBe(1)
    // Route deactivation (Activity hidden): no rebuild, stale rows returned,
    // no style/rect storm disguised as a cache check.
    stack.container.style.display = 'none'
    const before = { ...stack.counters }
    const stale = cache.getVisibleRows({
      container: stack.container,
      window: windowOf(stack.displayNewestFirst),
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 1
    })
    expect(stale).toBe(rows)
    expect(cache.stats().builds).toBe(1)
    expect(stack.counters.rects - before.rects).toBe(0)
    expect(stack.counters.styles - before.styles).toBe(0)
    // Visible reactivation rebuilds exactly once on the next capture.
    stack.container.style.display = ''
    const reactivated = cache.getVisibleRows({
      container: stack.container,
      window: windowOf(stack.displayNewestFirst),
      registry: stack.registry,
      registryVersion: 0,
      foldVersion: 1
    })
    expect(cache.stats().builds).toBe(2)
    expect(reactivated).not.toBe(rows)
    expect(reactivated).toHaveLength(n)
    stack.cleanup()
  })

  it('returns null for empty/detached membership (callers fall back explicitly)', () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => rect(0, 600),
      configurable: true
    })
    document.body.appendChild(container)
    expect(findAnchorInOrderedRows(container, [])).toBeNull()
    const detached = document.createElement('div')
    detached.id = 'message-x'
    expect(findAnchorInOrderedRows(container, [detached])).toBeNull()
    container.remove()
    vi.restoreAllMocks()
  })

  it('ordered and exact paths agree on row, gap, divider, fold, and tall geometries', () => {
    const cases: Array<{ name: string; geometry: (v: number) => { top: number; height: number; hidden?: boolean } }> = [
      { name: 'row', geometry: stacked(30) },
      {
        name: 'gap',
        geometry: (v) => {
          if (v < 30) return { top: (v - 30) * 100 - 30, height: 80 }
          if (v === 30) return { top: 5, height: 80 }
          return { top: 5 + (v - 30) * 100, height: 80 }
        }
      },
      {
        name: 'fold',
        geometry: (v) => {
          if (v === 29 || v === 31) return { top: 0, height: 0, hidden: true }
          let shift = 0
          if (v > 29) shift += 1
          if (v > 31) shift += 1
          return { top: (v - shift - 30) * 100 - 30, height: 80 }
        }
      },
      {
        name: 'tall',
        geometry: (v) => {
          if (v === 30) return { top: -2000, height: 5000 }
          if (v < 30) return { top: -2000 - (30 - v) * 100, height: 80 }
          return { top: 3000 + (v - 31) * 100, height: 80 }
        }
      }
    ]
    for (const c of cases) {
      const stack = buildProductionStack(60, c.geometry)
      const cache = createVisibleAnchorCache()
      const rows = cache.getVisibleRows({
        container: stack.container,
        window: windowOf(stack.displayNewestFirst),
        registry: stack.registry,
        registryVersion: 0,
        foldVersion: 0
      })
      const ordered = findAnchorInOrderedRows(stack.container, rows)
      const exact = findViewportTopAnchorWithOffset(stack.container)
      expect(ordered, `${c.name}: ordered path must resolve`).not.toBeNull()
      expect(ordered, `${c.name}: ordered/exact parity`).toEqual(exact)
      stack.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// getMessageRowById (canonical outer row vs registry)
// ---------------------------------------------------------------------------
describe('getMessageRowById', () => {
  it('returns the canonical outer row for duplicate same-id wrappers', () => {
    const outer = document.createElement('div')
    outer.id = 'message-dup-canon'
    document.body.appendChild(outer)
    const inner = document.createElement('div')
    inner.id = 'message-dup-canon'
    inner.setAttribute('data-message-id', 'dup-canon')
    outer.appendChild(inner)
    expect(getMessageRowById('dup-canon')).toBe(outer)
    outer.remove()
  })

  it('returns null for missing or detached rows', () => {
    expect(getMessageRowById('no-such-row')).toBeNull()
    const detached = document.createElement('div')
    detached.id = 'message-detached-row'
    expect(getMessageRowById('detached-row')).toBeNull()
  })
})
