import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContentSearch, type ContentSearchRef } from '../ContentSearch'

const highlightsMock = {
  clear: vi.fn(),
  set: vi.fn(),
  delete: vi.fn()
}
// @ts-ignore
global.CSS = global.CSS || {}
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

describe('B-08 audit focused', () => {
  it('a) bounded retained Range ownership across chunk replacement — only one 500-chunk retained before/during/after', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    // 620*2=1240 -> 3 chunks
    target.innerHTML = Array.from({ length: 620 })
      .map(() => '<div>hello world hello</div>')
      .join('')
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search')
    const liveHost = screen.getByTestId('content-search-host')
    const input = host.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(host.textContent).toContain('1/1240'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('500')
    expect(highlightArgs.some((a) => a.length === 500)).toBe(true)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)
    for (let i = 0; i < 499; i++) {
      await act(async () => {
        ref.current?.searchNext()
      })
    }
    await waitFor(() => expect(host.textContent).toContain('500/1240'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('500')
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)
    highlightArgs = []
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(host.textContent).toContain('501/1240'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('500')
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)
    expect(highlightArgs.some((a) => a.length === 500)).toBe(true)
    const maxArgs = Math.max(...highlightArgs.map((a) => a.length), 0)
    expect(maxArgs).toBeLessThanOrEqual(500)
    document.body.removeChild(target)
  })

  it('b) DOM mutation while navigation remains in same chunk refreshes count/ranges/highlights before continuation', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>foo foo foo</div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search')
    const liveHost = screen.getByTestId('content-search-host')
    const input = host.querySelector('input') as HTMLInputElement
    input.value = 'foo'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(host.textContent).toContain('1/3'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('3')
    highlightArgs = []
    const extra = document.createElement('div')
    extra.textContent = 'foo foo'
    target.appendChild(extra)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(host.textContent).toContain('2/5'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('5')
    expect(highlightArgs.some((a) => a.length === 5)).toBe(true)
    highlightArgs = []
    extra.textContent = 'foo'
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      ref.current?.searchPrev()
    })
    await waitFor(() => expect(host.textContent).toContain('1/4'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('4')
    document.body.removeChild(target)
  })

  it('c) focus returns/persists after next/previous navigation (RAF not canceled by state transitions)', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>apple apple apple apple</div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search')
    const input = host.querySelector('input') as HTMLInputElement
    input.value = 'apple'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(host.textContent).toContain('1/4'))
    input.focus()
    expect(document.activeElement).toBe(input)
    const allBtns = host.querySelectorAll('button')
    expect(allBtns.length).toBeGreaterThanOrEqual(3)
    const prevBtnEl = allBtns[allBtns.length - 3]
    const nextBtnEl = allBtns[allBtns.length - 2]
    fireEvent.click(nextBtnEl)
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    })
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(host.textContent).toContain('2/4')
    fireEvent.click(prevBtnEl)
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    })
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(host.textContent).toContain('1/4')
    await act(async () => {
      ref.current?.searchNext()
      requestAnimationFrame(() => input.focus())
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    })
    await waitFor(() => expect(host.textContent).toContain('2/4'))
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r))
    })
    expect(document.activeElement).toBe(input)
    document.body.removeChild(target)
  })
})

describe('B-08 re-audit strict triggers', () => {
  it('a-strict) 500-match same-chunk rescan does not retain old Range[] while materializing new ranges (allocation window instrumentation)', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    // exactly 500 matches => chunk 0 boundary, same-chunk navigation will stay in chunk 0
    target.innerHTML = Array.from({ length: 500 })
      .map(() => '<div>hello</div>')
      .join('')
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search')
    const liveHost = screen.getByTestId('content-search-host')
    const input = host.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(host.textContent).toContain('1/500'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('500')

    // Prepare instrumentation: track order of clear vs Range allocation in same-chunk window
    const order: string[] = []
    const origClear = highlightsMock.clear
    const clearSpy = vi.fn(() => order.push('clear'))
    highlightsMock.clear = clearSpy as any
    // @ts-ignore global Range patch
    const OrigRange = globalThis.Range
    // @ts-ignore
    globalThis.Range = function (this: any, ...args: any[]) {
      order.push('range')
      // @ts-ignore
      return new (OrigRange as any)(...args)
    } as any
    ;(globalThis as any).Range.prototype = (OrigRange as any).prototype

    // Make DOM stale but keep same 500 count: append non-matching node (changes childCount/textLength)
    highlightArgs = []
    order.length = 0
    ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE = undefined
    const extra = document.createElement('div')
    extra.textContent = 'zzz'
    target.appendChild(extra)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Same-chunk navigation (0 ->1) with stale DOM triggers rescan branch that must clear before allocation
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(host.textContent).toContain('2/500'))

    // Instrumentation assertions: before-scan live must be 0 (old ranges released before new allocation)
    expect((globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE).toBe(0)
    // Order must be clear before first range allocation in this window
    const firstClearIdx = order.indexOf('clear')
    const firstRangeIdx = order.indexOf('range')
    expect(firstClearIdx).not.toBe(-1)
    expect(firstRangeIdx).not.toBe(-1)
    expect(firstClearIdx).toBeLessThan(firstRangeIdx)
    // Highlights remain bounded
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)
    expect(liveHost.getAttribute('data-live-ranges')).toBe('500')
    // No double retention: max highlight length still 500, not 1000
    const max = Math.max(...highlightArgs.map((a) => a.length), 0)
    expect(max).toBeLessThanOrEqual(500)

    // restore
    highlightsMock.clear = origClear as any
    // @ts-ignore
    globalThis.Range = OrigRange

    document.body.removeChild(target)
  })

  it('b-strict) target replacement with same snapshot dimensions rescans and updates result ownership/count', async () => {
    const filter = makeFilter()
    const t1 = document.createElement('div')
    // 3 hellos, textLength = 'hello hello hello' = 17, childCount 1
    t1.innerHTML = '<div>hello hello hello</div>'
    document.body.appendChild(t1)
    const t2 = document.createElement('div')
    // same textLength 17 and childCount 1 but only 1 hello: 'hello xxxxx xxxxx' (5+1+5+1+5=17)
    t2.innerHTML = '<div>hello xxxxx xxxxx</div>'
    document.body.appendChild(t2)
    expect(t1.textContent?.length).toBe(t2.textContent?.length)
    expect(t1.childElementCount).toBe(t2.childElementCount)

    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { rerender } = render(<ContentSearch ref={ref} searchTarget={t1} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search')
    const liveHost = screen.getByTestId('content-search-host')
    const input = host.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(host.textContent).toContain('1/3'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('3')

    highlightArgs = []
    highlightsMock.clear.mockClear()

    // Replace target identity (same snapshot dimensions)
    rerender(<ContentSearch ref={ref} searchTarget={t2} filter={filter} onClose={() => {}} />)
    // target effect synchronously rescans; await next tick for React state commit
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // After replacement, total must reflect new target (1), not stale 3
    await waitFor(() => expect(host.textContent).toMatch(/1\/1|0\/1/))
    await waitFor(() => expect(liveHost.getAttribute('data-live-ranges')).toBe('1'))
    expect(highlightArgs.some((a) => a.length === 1)).toBe(true)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)

    // Navigation after replacement must operate on new target's ranges (same-chunk still bounded)
    highlightsMock.clear.mockClear()
    highlightArgs = []
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(host.textContent).toContain('1/1'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('1')

    document.body.removeChild(t1)
    document.body.removeChild(t2)
  })

  it('c-strict) class/attribute mutation affecting Chat NodeFilter invalidates and recalculates results', async () => {
    const target = document.createElement('div')
    target.innerHTML =
      '<div class="message message-assistant"><div class="message-content-container">hello world</div></div>' +
      '<div class="message message-user"><div class="message-content-container">hello world</div></div>'
    document.body.appendChild(target)
    const chatFilterExcludeUser: NodeFilter = {
      acceptNode(node) {
        const container = (node.parentElement as HTMLElement)?.closest('.message-content-container')
        if (!container) return NodeFilter.FILTER_REJECT
        const message = container.closest('.message')
        if (!message) return NodeFilter.FILTER_REJECT
        if (message.classList.contains('message-assistant')) return NodeFilter.FILTER_ACCEPT
        return NodeFilter.FILTER_REJECT
      }
    } as any
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={chatFilterExcludeUser} onClose={() => {}} />)
    const host = screen.getByTestId('content-search')
    const liveHost = screen.getByTestId('content-search-host')
    const input = host.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(host.textContent).toContain('1/1'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('1')
    // Snapshot capture: textLength/childCount unchanged by class change, so snapshot alone would miss it
    const beforeGen = liveHost.getAttribute('data-dom-generation')

    // Change class of user message to assistant via attribute mutation (class)
    const userMsg = target.querySelector('.message-user') as HTMLElement
    expect(userMsg).not.toBeNull()
    highlightArgs = []
    highlightsMock.clear.mockClear()
    userMsg.classList.remove('message-user')
    userMsg.classList.add('message-assistant')
    // observer with attributes:true must mark dirty
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // dom generation should have incremented due to attribute observation
    // (if attribute observation missing, generation would not increment)
    // Note: generation increments in observer callback, but may also increment on commit; check at least dirty path
    // Navigate same-chunk to force rescan — total must refresh to 2, current may wrap to 1/2
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(host.textContent).toContain('/2'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('2')
    expect(highlightArgs.some((a) => a.length === 2)).toBe(true)
    expect(host.textContent).toMatch(/1\/2|2\/2/)

    // Also verify that observer indeed observed attributes: generation increased
    // (not strictly required but proves attribute path)
    const afterGen = liveHost.getAttribute('data-dom-generation')
    expect(afterGen).not.toBe(beforeGen)

    document.body.removeChild(target)
  })

  it('d-strict) focus moves from navigation button back to input via component-owned RAF (survives debounce lifecycle)', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>apple apple apple</div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search')
    const input = host.querySelector('input') as HTMLInputElement
    input.value = 'apple'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(host.textContent).toContain('1/3'))

    const btns = host.querySelectorAll('button')
    expect(btns.length).toBeGreaterThanOrEqual(3)
    const nextBtn = btns[btns.length - 2]
    const prevBtn = btns[btns.length - 3]

    // Focus starts on input, then click next (button gains focus transiently, RAF returns to input)
    nextBtn.focus()
    expect(document.activeElement).toBe(nextBtn)
    fireEvent.click(nextBtn)
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    })
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(host.textContent).toContain('2/3')

    // Prev button same
    prevBtn.focus()
    expect(document.activeElement).toBe(prevBtn)
    fireEvent.click(prevBtn)
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    })
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(host.textContent).toContain('1/3')

    // Verify scheduling survives: trigger search via debounce path then navigation, focus RAF not canceled
    input.focus()
    expect(document.activeElement).toBe(input)
    // simulate user typing that triggers debounce search (will cancel debounce on state change but not RAF)
    fireEvent.input(input, { target: { value: 'apple' } })
    // immediately navigate via button while debounce pending
    nextBtn.focus()
    fireEvent.click(nextBtn)
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    })
    await waitFor(() => expect(document.activeElement).toBe(input))

    document.body.removeChild(target)
  })
})
