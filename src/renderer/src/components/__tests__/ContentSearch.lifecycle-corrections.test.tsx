import { act, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContentSearch, type ContentSearchRef } from '../ContentSearch'

const highlightsMock = {
  clear: vi.fn(),
  set: vi.fn(),
  delete: vi.fn()
}
// @ts-ignore
global.CSS = (global as any).CSS || {}
// @ts-ignore
global.CSS.highlights = highlightsMock

let highlightArgs: any[][] = []
// @ts-ignore
global.Highlight = class Highlight {
  args: any[]
  constructor(...args: any[]) {
    this.args = args
    highlightArgs.push(args)
  }
}

vi.mock('@renderer/utils', async () => {
  const actual = await vi.importActual('@renderer/utils')
  return {
    // @ts-ignore
    ...actual,
    scrollElementIntoView: vi.fn()
  }
})

const makeFilter = (): NodeFilter =>
  ({
    acceptNode: () => NodeFilter.FILTER_ACCEPT
  }) as any

beforeEach(() => {
  highlightsMock.clear.mockClear()
  highlightsMock.set.mockClear()
  highlightArgs = []
  ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE = undefined
  ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_TOTAL = undefined
})

describe('B-08 lifecycle corrections (final audit)', () => {
  it('self-host mutation non-invalidation: host attribute/child mutations do not dirty or clear highlights', async () => {
    const filter = makeFilter()
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const Wrapper = () => {
      const outerRef = React.useRef<HTMLDivElement>(null)
      return (
        <div ref={outerRef} data-testid="outer-host-wrap">
          <div data-testid="messages">hello hello hello</div>
          <ContentSearch
            ref={ref}
            searchTarget={outerRef as React.RefObject<HTMLElement>}
            filter={filter}
            onClose={() => {}}
          />
        </div>
      )
    }
    const { unmount } = render(<Wrapper />)
    const outer = screen.getByTestId('outer-host-wrap')
    const messages = screen.getByTestId('messages')
    const hostTestId = screen.getByTestId('content-search-host')
    const bar = screen.getByTestId('content-search')
    const input = bar.querySelector('input') as HTMLInputElement
    // Ensure observed target contains host (Chat mainRef pattern)
    expect(outer.contains(hostTestId)).toBe(true)

    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(bar.textContent).toContain('1/3'))
    expect(hostTestId.getAttribute('data-live-ranges')).toBe('3')
    const genBefore = hostTestId.getAttribute('data-dom-generation')
    const outerRawLenBefore = outer.textContent?.length ?? 0
    const outerRawElementsBefore = outer.querySelectorAll('*').length
    highlightsMock.clear.mockClear()
    highlightArgs = []
    ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE = undefined
    ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_TOTAL = undefined

    // Mutate host-only UI in a way that changes whole-target dimensions (raw text length and element count)
    // but must not affect searchable snapshot (host subtree excluded) — use non-searchable text to avoid altering hello count
    await act(async () => {
      hostTestId.setAttribute('data-test-host', '1')
      const countEl = bar.querySelector('span')
      if (countEl) countEl.textContent = 'mutated-host-text-changing-dimensions'
      const hostExtra = document.createElement('div')
      hostExtra.setAttribute('data-testid', 'host-extra-dimension')
      hostExtra.textContent = 'host-only extra content that changes whole-target dimensions significantly zzz-zzz-zzz'
      hostTestId.appendChild(hostExtra)
      await new Promise((r) => setTimeout(r, 0))
    })
    // Whole-target raw dimensions must have changed
    expect(outer.textContent?.length).not.toBe(outerRawLenBefore)
    expect(outer.querySelectorAll('*').length).not.toBe(outerRawElementsBefore)
    // Observer must have ignored host mutations: no clear, no generation bump (LOCK-003 host exclusion)
    expect(highlightsMock.clear).not.toHaveBeenCalled()
    expect(hostTestId.getAttribute('data-dom-generation')).toBe(genBefore)
    // Same-chunk navigation must NOT trigger clear/highlight teardown nor rescan (fallback snapshot excludes host)
    highlightsMock.clear.mockClear()
    highlightArgs = []
    ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE = undefined
    ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_TOTAL = undefined
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(bar.textContent).toContain('2/3'))
    // Directly assert no rescan: fallback snapshot excluded host, so same-chunk navigation must not teardown/rescan
    expect((globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE).toBeUndefined()
    expect((globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_TOTAL).toBeUndefined()
    expect(hostTestId.getAttribute('data-dom-generation')).toBe(genBefore)
    expect(hostTestId.getAttribute('data-live-ranges')).toBe('3')
    // locateByIndex always clears once to update current-match; rescan path would clear twice (rescan teardown + locate)
    expect(highlightsMock.clear.mock.calls.length).toBeLessThanOrEqual(1)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)

    // Verify meaningful mutation outside host still invalidates (same target)
    highlightsMock.clear.mockClear()
    highlightArgs = []
    const extra = document.createElement('div')
    extra.textContent = 'hello'
    messages.appendChild(extra)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(highlightsMock.clear).toHaveBeenCalled()
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(bar.textContent).toContain('3/4'))
    expect(hostTestId.getAttribute('data-live-ranges')).toBe('4')

    unmount()
  })

  it('zero-result active session: non-null target replacement rescans retained query and acquires results', async () => {
    const filter = makeFilter()
    const t1 = document.createElement('div')
    t1.innerHTML = '<div>xxx yyy zzz</div>'
    document.body.appendChild(t1)
    const t2 = document.createElement('div')
    t2.innerHTML = '<div>hello hello</div>'
    document.body.appendChild(t2)

    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { rerender } = render(<ContentSearch ref={ref} searchTarget={t1} filter={filter} onClose={() => {}} />)
    const bar = screen.getByTestId('content-search')
    const host = screen.getByTestId('content-search-host')
    const input = bar.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    // zero results but searched -> active session per LOCK-005 (0/0 placeholder or 0/0)
    await waitFor(() => expect(bar.textContent).toContain('0/0'))
    expect(host.getAttribute('data-live-ranges')).toBe('0')
    // totalCount 0, but hadActive should be true (Searched + nonempty query)
    highlightsMock.clear.mockClear()
    highlightArgs = []

    // Replace with t2 that has matches — must rescan even though prior count was zero
    rerender(<ContentSearch ref={ref} searchTarget={t2} filter={filter} onClose={() => {}} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(bar.textContent).toMatch(/1\/2|0\/2/))
    await waitFor(() => expect(host.getAttribute('data-live-ranges')).toBe('2'))
    expect(highlightArgs.some((a) => a.length === 2)).toBe(true)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)

    document.body.removeChild(t1)
    document.body.removeChild(t2)
  })

  it('target null (loss) synchronously clears stale result metadata while retaining query', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>hello hello hello</div>'
    document.body.appendChild(target)

    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { rerender } = render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const bar = screen.getByTestId('content-search')
    const host = screen.getByTestId('content-search-host')
    const input = bar.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(bar.textContent).toContain('1/3'))
    expect(host.getAttribute('data-live-ranges')).toBe('3')
    expect(input.value).toBe('hello')
    highlightsMock.clear.mockClear()
    highlightArgs = []

    // Lose target -> pass ref with null current
    const nullRef = { current: null } as unknown as React.RefObject<HTMLElement>
    rerender(<ContentSearch ref={ref} searchTarget={nullRef} filter={filter} onClose={() => {}} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // Must have cleared highlights synchronously
    expect(highlightsMock.clear).toHaveBeenCalled()
    expect(host.getAttribute('data-live-ranges')).toBe('0')
    // Count/index cleared -> UI shows 0/0, navigation disabled (totalCount 0)
    await waitFor(() => expect(bar.textContent).toContain('0/0'))
    // Query retained (input value still hello) per UX, but stale navigation disabled
    expect((screen.getByTestId('content-search').querySelector('input') as HTMLInputElement).value).toBe('hello')
    // Navigation should be no-op (0 total)
    highlightArgs = []
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(bar.textContent).toContain('0/0'))
    expect(host.getAttribute('data-live-ranges')).toBe('0')

    // Replacement back to non-null with same query should rescan (since active session retained)
    highlightsMock.clear.mockClear()
    highlightArgs = []
    rerender(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(bar.textContent).toContain('1/3'))
    expect(host.getAttribute('data-live-ranges')).toBe('3')

    document.body.removeChild(target)
  })
})
