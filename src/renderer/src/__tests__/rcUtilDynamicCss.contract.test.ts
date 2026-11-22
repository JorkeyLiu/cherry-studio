/**
 * DOM contract for rc-util dynamic style lookup (patched findStyles).
 *
 * The patch keeps "direct HTML <style> children only, in document order"
 * while enumerating via `querySelectorAll('style')` on the real container.
 * These tests pin that contract through the public API (`updateCSS` /
 * `removeCSS`) against the REAL installed artifacts, so a future change that
 * drops either guard (direct-parent check, uppercase `STYLE` check) fails
 * here instead of silently restyling nested or SVG-namespaced content.
 *
 * Loading note: rc-util is a transitive dependency (via antd), so bare deep
 * imports do not resolve from source. Resolution is anchored at the direct
 * dependent; the lock pins the patch_hash variant for every consumer, so the
 * loaded files are the patched install-tree copies. The CJS `lib/` build
 * loads via require; the ESM `es/` build is attempted via dynamic import and
 * honestly skipped with a warning when the runner cannot execute it
 * (CJS-typed package carrying ESM syntax) instead of faking coverage.
 *
 * Covered, without performance thresholds:
 * - same-key reuse: same node returned, content updated only on change
 * - insertion order of direct styles, including prependQueue priority order
 * - nested marked styles are never matched or moved
 * - SVG-namespaced styles are never matched or removed
 * - removeCSS deletes, a later updateCSS rebuilds with new content
 * - same key in two containers stays isolated
 * - ShadowRoot container isolation (skipped honestly when jsdom cannot host
 *   open shadow roots; never faked)
 */
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

interface DynamicCssApi {
  updateCSS: (css: string, key: string, option?: Record<string, unknown>) => HTMLStyleElement
  removeCSS: (key: string, option?: Record<string, unknown>) => void
  clearContainerCache: () => void
}

const anchorRequire = createRequire(import.meta.url)
const depRequire = createRequire(anchorRequire.resolve('antd/package.json'))
const esmPath: string = depRequire.resolve('rc-util/es/Dom/dynamicCSS')
const cjsBuild = depRequire('rc-util/lib/Dom/dynamicCSS') as DynamicCssApi

let esmBuild: DynamicCssApi | null = null
let esmLoadError = ''
try {
  esmBuild = (await import(esmPath)) as DynamicCssApi
} catch (error) {
  esmLoadError = error instanceof Error ? error.message : String(error)
}

const BUILDS: Array<{ name: string; api: DynamicCssApi }> = [
  ...(esmBuild ? [{ name: 'esm' as const, api: esmBuild }] : []),
  { name: 'cjs' as const, api: cjsBuild }
]

if (!esmBuild) {
  console.warn(`[rc-util contract] ESM build not executable in this runner, covered by cjs only: ${esmLoadError}`)
}

const MARK_ATTR = 'rc-util-key'
const SVG_NS = 'http://www.w3.org/2000/svg'

const containers: HTMLElement[] = []

function makeContainer(): HTMLDivElement {
  const div = document.createElement('div')
  document.body.appendChild(div)
  containers.push(div)
  return div
}

function directStyleKeys(container: ParentNode): Array<string | null> {
  return Array.from(container.children)
    .filter((node) => node.tagName === 'STYLE')
    .map((node) => node.getAttribute(MARK_ATTR))
}

function directStyleCount(container: ParentNode): number {
  return Array.from(container.children).filter((node) => node.tagName === 'STYLE').length
}

beforeEach(() => {
  for (const { api } of BUILDS) {
    api.clearContainerCache()
  }
})

afterEach(() => {
  while (containers.length > 0) {
    containers.pop()?.remove()
  }
  for (const { api } of BUILDS) {
    api.clearContainerCache()
  }
})

describe.each(BUILDS)('rc-util dynamicCSS contract [$name]', ({ api }) => {
  it('reuses the direct-child style for the same key and updates content only on change', () => {
    const container = makeContainer()

    const first = api.updateCSS('.a{}', 'reuse-key', { attachTo: container })
    expect(first.parentNode).toBe(container)
    expect(directStyleCount(container)).toBe(1)

    const same = api.updateCSS('.a{}', 'reuse-key', { attachTo: container })
    expect(same).toBe(first)
    expect(directStyleCount(container)).toBe(1)

    const changed = api.updateCSS('.b{}', 'reuse-key', { attachTo: container })
    expect(changed).toBe(first)
    expect(changed.innerHTML).toBe('.b{}')
    expect(directStyleCount(container)).toBe(1)
  })

  it('keeps insertion order of direct styles', () => {
    const container = makeContainer()

    api.updateCSS('.a{}', 'order-1', { attachTo: container })
    api.updateCSS('.b{}', 'order-2', { attachTo: container })
    api.updateCSS('.c{}', 'order-3', { attachTo: container })

    expect(directStyleKeys(container)).toEqual(['order-1', 'order-2', 'order-3'])
  })

  it('orders prependQueue styles by priority through the shared lookup', () => {
    const container = makeContainer()
    const queued = (priority: number): Record<string, unknown> => ({
      attachTo: container,
      prepend: 'queue',
      priority
    })

    api.updateCSS('.a{}', 'q-low', queued(1))
    api.updateCSS('.b{}', 'q-high', queued(5))
    api.updateCSS('.c{}', 'q-mid', queued(3))

    expect(directStyleKeys(container)).toEqual(['q-low', 'q-mid', 'q-high'])
  })

  it('never reuses a nested style carrying the same mark', () => {
    const container = makeContainer()
    const wrapper = document.createElement('span')
    const nested = document.createElement('style')
    nested.setAttribute(MARK_ATTR, 'nested-key')
    nested.textContent = '.nested{}'
    wrapper.appendChild(nested)
    container.appendChild(wrapper)

    const node = api.updateCSS('.real{}', 'nested-key', { attachTo: container })

    expect(node).not.toBe(nested)
    expect(node.parentNode).toBe(container)
    expect(nested.textContent).toBe('.nested{}')
    expect(nested.parentNode).toBe(wrapper)
    expect(node.innerHTML).toBe('.real{}')
    expect(directStyleCount(container)).toBe(1)
  })

  it('ignores SVG-namespaced style descendants when matching and removing', () => {
    const container = makeContainer()
    const svg = document.createElementNS(SVG_NS, 'svg')
    const svgStyle = document.createElementNS(SVG_NS, 'style')
    svgStyle.setAttribute(MARK_ATTR, 'svg-key')
    svgStyle.textContent = '.svg{}'
    svg.appendChild(svgStyle)
    container.appendChild(svg)

    const node = api.updateCSS('.html{}', 'svg-key', { attachTo: container })

    expect(node.parentNode).toBe(container)
    expect(node.tagName).toBe('STYLE')
    expect(svgStyle.textContent).toBe('.svg{}')
    expect(svgStyle.parentNode).toBe(svg)

    api.removeCSS('svg-key', { attachTo: container })
    expect(svgStyle.parentNode).toBe(svg)
    expect(node.parentNode).toBeNull()
    expect(directStyleCount(container)).toBe(0)
  })

  it('removes a real style and rebuilds it with new content on next update', () => {
    const container = makeContainer()

    const created = api.updateCSS('.v1{}', 'rebuild-key', { attachTo: container })
    expect(created.innerHTML).toBe('.v1{}')

    api.removeCSS('rebuild-key', { attachTo: container })
    expect(directStyleCount(container)).toBe(0)

    const rebuilt = api.updateCSS('.v2{}', 'rebuild-key', { attachTo: container })
    expect(rebuilt.innerHTML).toBe('.v2{}')
    expect(rebuilt.getAttribute(MARK_ATTR)).toBe('rebuild-key')
    expect(rebuilt.parentNode).toBe(container)
    expect(directStyleCount(container)).toBe(1)
  })

  it('isolates the same key across containers', () => {
    const first = makeContainer()
    const second = makeContainer()

    const inFirst = api.updateCSS('.one{}', 'shared-key', { attachTo: first })
    const inSecond = api.updateCSS('.two{}', 'shared-key', { attachTo: second })

    expect(inFirst).not.toBe(inSecond)
    expect(inFirst.parentNode).toBe(first)
    expect(inSecond.parentNode).toBe(second)

    api.removeCSS('shared-key', { attachTo: first })
    expect(directStyleCount(first)).toBe(0)
    expect(directStyleCount(second)).toBe(1)
    expect(inSecond.innerHTML).toBe('.two{}')
  })
})

const canHostShadowRoot =
  typeof Element !== 'undefined' &&
  typeof (Element.prototype as unknown as { attachShadow?: unknown }).attachShadow === 'function'

describe.skipIf(!canHostShadowRoot)('rc-util dynamicCSS shadow container isolation (jsdom open shadow root)', () => {
  it.each(BUILDS.map((build) => [build.name, build.api] as [string, DynamicCssApi]))(
    'keeps shadow-attached styles inside the shadow root [%s]',
    (_name, api) => {
      const host = makeContainer()
      const shadow = host.attachShadow({ mode: 'open' })

      const node = api.updateCSS('.shadow{}', 'shadow-key', { attachTo: shadow })

      expect(node.parentNode).toBe(shadow)
      expect(node.innerHTML).toBe('.shadow{}')
      expect(
        Array.from(document.head.querySelectorAll('style')).some(
          (style) => style.getAttribute(MARK_ATTR) === 'shadow-key'
        )
      ).toBe(false)

      api.removeCSS('shadow-key', { attachTo: shadow })
      expect(node.parentNode).toBeNull()
    }
  )
})
