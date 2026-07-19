/**
 * Tests for domVisibility helpers — shared visibility logic used by
 * findFirstVisibleMessage (load-more anchoring) and findFirstVisibleMessageId
 * (scroll-position saving).
 */
import { describe, expect, it, vi } from 'vitest'

import { findFirstVisibleMessage, findFirstVisibleMessageId, isElementVisibleInViewport } from '../domVisibility'

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
