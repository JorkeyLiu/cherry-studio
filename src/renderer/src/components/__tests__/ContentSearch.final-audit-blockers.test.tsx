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
})

describe('B-08 final blockers regression', () => {
  it('zero-result dirty recovery via searchNext rescans chunk 0 and acquires results', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>xxx yyy zzz</div>'
    document.body.appendChild(target)

    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const bar = screen.getByTestId('content-search')
    const host = screen.getByTestId('content-search-host')
    const input = bar.querySelector('input') as HTMLInputElement

    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(bar.textContent).toContain('0/0'))
    expect(host.getAttribute('data-live-ranges')).toBe('0')

    // meaningful mutation adds matches
    const extra = document.createElement('div')
    extra.textContent = 'hello hello'
    target.appendChild(extra)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // observer should have marked dirty and cleared highlights
    expect(highlightsMock.clear).toHaveBeenCalled()
    highlightsMock.clear.mockClear()
    highlightArgs = []

    // navigation should recover via rescan chunk 0
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(bar.textContent).toContain('1/2'))
    expect(host.getAttribute('data-live-ranges')).toBe('2')
    expect(highlightArgs.some((a) => a.length === 2)).toBe(true)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)

    // searchPrev from first should also work on dirty zero->? test prev recovery direction (reset to zero again then prev)
    // reset to zero state again by mutating away results
    target.innerHTML = '<div>xxx yyy zzz</div>'
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // need to dirty again then navigate to rescan zero case
    // Do a search to get zero again (search resets to 0)
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(bar.textContent).toContain('0/0'))
    expect(host.getAttribute('data-live-ranges')).toBe('0')
    // add again 1 hello
    const extra2 = document.createElement('div')
    extra2.textContent = 'hello'
    target.appendChild(extra2)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    highlightArgs = []
    highlightsMock.clear.mockClear()
    await act(async () => {
      ref.current?.searchPrev()
    })
    await waitFor(() => expect(bar.textContent).toContain('1/1'))
    expect(host.getAttribute('data-live-ranges')).toBe('1')
    expect(highlightArgs.some((a) => a.length === 1)).toBe(true)

    document.body.removeChild(target)
  })

  it('zero-result dirty recovery via searchPrev when no dirty remains no-op', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>aaa bbb</div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const bar = screen.getByTestId('content-search')
    const host = screen.getByTestId('content-search-host')
    const input = bar.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(bar.textContent).toContain('0/0'))
    expect(host.getAttribute('data-live-ranges')).toBe('0')
    highlightArgs = []
    // no DOM change, navigation should remain no-op and not rescan
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(bar.textContent).toContain('0/0'))
    expect(host.getAttribute('data-live-ranges')).toBe('0')
    expect(highlightArgs.length).toBe(0)
    document.body.removeChild(target)
  })

  it('pending enable RAF followed by target replacement cannot commit old-target results', async () => {
    const filter = makeFilter()
    const t1 = document.createElement('div')
    t1.innerHTML = '<div>hello hello hello</div>' // 3
    document.body.appendChild(t1)
    const t2 = document.createElement('div')
    t2.innerHTML = '<div>hello hello</div>' // 2
    document.body.appendChild(t2)

    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { rerender } = render(<ContentSearch ref={ref} searchTarget={t1} filter={filter} onClose={() => {}} />)
    const bar = screen.getByTestId('content-search')
    const host = screen.getByTestId('content-search-host')

    highlightArgs = []
    highlightsMock.clear.mockClear()

    // schedule enable with query hello -> pending search RAF
    await act(async () => {
      ref.current?.enable('hello')
      // before RAF fires, replace target to t2
      rerender(<ContentSearch ref={ref} searchTarget={t2} filter={filter} onClose={() => {}} />)
    })
    // allow effects + cancelled RAF handling + synchronous rescan of t2
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      await new Promise((r) => setTimeout(r, 0))
    })
    // Should reflect t2 (2) not t1 (3)
    await waitFor(() => expect(host.getAttribute('data-live-ranges')).toBe('2'))
    // bar should show 1/2 (jump 0) not 1/3
    expect(bar.textContent).toContain('1/2')
    expect(bar.textContent).not.toContain('1/3')
    expect(highlightArgs.some((a) => a.length === 2)).toBe(true)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)
    // ensure old target's 3 was never committed
    expect(highlightArgs.some((a) => a.length === 3)).toBe(false)

    document.body.removeChild(t1)
    document.body.removeChild(t2)
  })

  it('pending initialText RAF superseded by target replacement commits latest target', async () => {
    const filter = makeFilter()
    const t1 = document.createElement('div')
    t1.innerHTML = '<div>foo foo foo</div>' // 0 hello
    document.body.appendChild(t1)
    const t2 = document.createElement('div')
    t2.innerHTML = '<div>hello world</div>' // 1 hello
    document.body.appendChild(t2)

    // Simulate mount with initialText pending then immediate target replacement before RAF
    // We use a wrapper to change target quickly after mount
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const Wrapper = ({ target }: { target: HTMLElement }) => (
      <ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} initialText="hello" />
    )
    const { rerender } = render(<Wrapper target={t1} />)
    // replace before RAF
    await act(async () => {
      rerender(<Wrapper target={t2} />)
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      await new Promise((r) => setTimeout(r, 0))
    })
    const host = screen.getByTestId('content-search-host')
    const bar = screen.getByTestId('content-search')
    await waitFor(() => expect(host.getAttribute('data-live-ranges')).toBe('1'))
    expect(bar.textContent).toMatch(/1\/1|0\/1/)
    expect(highlightArgs.some((a) => a.length === 1)).toBe(true)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)

    document.body.removeChild(t1)
    document.body.removeChild(t2)
  })

  it('focus-only RAF survives target replacement (no cancelled focus)', async () => {
    const filter = makeFilter()
    const t1 = document.createElement('div')
    t1.innerHTML = '<div>hello</div>'
    document.body.appendChild(t1)
    const t2 = document.createElement('div')
    t2.innerHTML = '<div>hello hello</div>'
    document.body.appendChild(t2)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { rerender } = render(<ContentSearch ref={ref} searchTarget={t1} filter={filter} onClose={() => {}} />)
    const bar = screen.getByTestId('content-search')
    const input = bar.querySelector('input') as HTMLInputElement

    // enable without text schedules focus-only RAF
    await act(async () => {
      ref.current?.enable()
      rerender(<ContentSearch ref={ref} searchTarget={t2} filter={filter} onClose={() => {}} />)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(document.activeElement).toBe(input))

    document.body.removeChild(t1)
    document.body.removeChild(t2)
  })
})
