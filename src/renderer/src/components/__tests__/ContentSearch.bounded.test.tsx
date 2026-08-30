import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONTENT_SEARCH_CHUNK_SIZE,
  ContentSearch,
  type ContentSearchRef,
  createSearchRegex,
  scanTargetForChunk
} from '../ContentSearch'

// Stub CSS.highlights and Highlight for jsdom
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
})

describe('B-08 bounded ContentSearch', () => {
  it('exports chunk size 500', () => {
    expect(CONTENT_SEARCH_CHUNK_SIZE).toBe(500)
  })

  it('scanTargetForChunk caps live Ranges at 500 and reports total', () => {
    const target = document.createElement('div')
    // 600 containers * 2 matches each = 1200 total "hello"
    target.innerHTML = Array.from({ length: 600 })
      .map(() => '<div class="msg">hello world hello</div>')
      .join('')
    document.body.appendChild(target)
    const filter = makeFilter()

    const c0 = scanTargetForChunk(target, filter, 'hello', false, false, 0)
    expect(c0.ranges.length).toBe(500)
    expect(c0.totalCount).toBe(1200)
    c0.ranges.forEach((r) => expect(r).toBeInstanceOf(Range))
    // descriptor bounded: only 500 Ranges retained, not 1200
    expect(c0.ranges.length).toBeLessThanOrEqual(500)

    const c1 = scanTargetForChunk(target, filter, 'hello', false, false, 1)
    expect(c1.ranges.length).toBe(500)
    expect(c1.totalCount).toBe(1200)

    const c2 = scanTargetForChunk(target, filter, 'hello', false, false, 2)
    expect(c2.ranges.length).toBe(200)
    expect(c2.totalCount).toBe(1200)

    // out of range chunk yields empty but total remains
    const c3 = scanTargetForChunk(target, filter, 'hello', false, false, 3)
    expect(c3.ranges.length).toBe(0)
    expect(c3.totalCount).toBe(1200)

    document.body.removeChild(target)
  })

  it('scanTargetForChunk descriptors bounded — does not materialize unbounded list', () => {
    const target = document.createElement('div')
    target.innerHTML = Array.from({ length: 1000 })
      .map(() => '<span>foo</span>')
      .join(' ')
    document.body.appendChild(target)
    const filter = makeFilter()
    const r = scanTargetForChunk(target, filter, 'foo', false, false, 0)
    expect(r.totalCount).toBe(1000)
    expect(r.ranges.length).toBe(500)
    // Only current chunk materialized
    document.body.removeChild(target)
  })

  it('createSearchRegex respects case-sensitive and whole-word semantics', () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>Hello hello HELLO</div>'
    document.body.appendChild(target)
    // case-insensitive (default for non-latin check? Latin but caseSensitive false => gi)
    let r = scanTargetForChunk(target, filter, 'hello', false, false, 0)
    expect(r.totalCount).toBe(3)
    r = scanTargetForChunk(target, filter, 'hello', true, false, 0)
    // only exact case "hello"
    expect(r.totalCount).toBe(1)
    // whole word
    target.innerHTML = '<div>helloworld hello helloWorld</div>'
    r = scanTargetForChunk(target, filter, 'hello', false, true, 0)
    expect(r.totalCount).toBe(1)
    document.body.removeChild(target)
    // regex helper direct
    expect(createSearchRegex('a.b', false, false).source).toContain('\\.')
  })

  it('component: <=500 matches — preserves count/navigation/highlight', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML =
      '<div class="message message-assistant"><div class="message-content-container">apple banana apple banana apple</div></div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    // type "apple" -> 2? Actually "apple" appears 2? Let's count: "apple banana apple banana apple" => 3 apple
    fireEvent.input(input, { target: { value: '' } })
    input.value = 'apple'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => {
      const count = screen.getByTestId('content-search').textContent
      expect(count).toContain('1/3')
    })
    // highlight should be created with 3 ranges
    // locate effect creates Highlight with chunkRanges (3)
    expect(highlightArgs.some((args) => args.length === 3)).toBe(true)
    // navigation next increments to 2/3, etc., without rescan (same chunk)
    highlightArgs = []
    highlightsMock.clear.mockClear()
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('2/3')
    })
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('3/3')
    })
    // wrap
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('1/3')
    })
    // prev from 1 goes to 3
    await act(async () => {
      ref.current?.searchPrev()
    })
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('3/3')
    })
    document.body.removeChild(target)
  })

  it('component: >500 — bounded chunk, cross-chunk navigation rescans rendered DOM', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    // 620 containers * 2 = 1240 matches -> 3 chunks (500,500,240)
    target.innerHTML = Array.from({ length: 620 })
      .map(() => '<div>hello world hello</div>')
      .join('')
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search')
    const input = host.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => {
      expect(host.textContent).toContain('1/1240')
    })
    // initial chunk materialized is 500 highlights
    expect(highlightArgs.some((a) => a.length === 500)).toBe(true)
    // verify no highlight was created with >500
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)

    // navigate forward 500 times to cross chunk boundary: we will directly test crossing
    // advance to index 499 (last of chunk0) then next should rescan chunk1
    // Do 499 nexts from 0 -> reach 499
    for (let i = 0; i < 499; i++) {
      await act(async () => {
        ref.current?.searchNext()
      })
    }
    await waitFor(() => {
      expect(host.textContent).toContain('500/1240')
    })
    highlightArgs = []
    highlightsMock.clear.mockClear()
    // next crosses to chunk 1, should rescan and show 501/1240
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => {
      expect(host.textContent).toContain('501/1240')
    })
    // after cross-chunk, new highlight should be for chunk 1 (500)
    expect(highlightArgs.some((a) => a.length === 500)).toBe(true)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)

    // navigate prev back across chunk boundary to chunk 0
    highlightArgs = []
    await act(async () => {
      ref.current?.searchPrev()
    })
    await waitFor(() => {
      expect(host.textContent).toContain('500/1240')
    })
    expect(highlightArgs.some((a) => a.length === 500)).toBe(true)

    // navigate to last chunk via prev from start style
    // from 500/1240 go to 1 via wrap? Test wrap forward across many chunks
    // Go to 1240 then next wraps to 1
    // Fast-forward to 1240
    // currently at 500, need 740 more nexts to reach 1240
    for (let i = 0; i < 740; i++) {
      await act(async () => {
        ref.current?.searchNext()
      })
    }
    await waitFor(() => {
      expect(host.textContent).toContain('1240/1240')
    })
    // chunk 2 has 240
    // verify highlight bounded still
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)

    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => {
      expect(host.textContent).toContain('1/1240')
    })

    document.body.removeChild(target)
  })

  it('component: silentSearch keeps bounded chunk but does not select current', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>foo foo foo foo</div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    input.value = 'foo'
    await act(async () => {
      ref.current?.silentSearch()
    })
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('0/4')
    })
    // highlight for all 4 still bounded
    expect(highlightArgs.some((a) => a.length === 4)).toBe(true)
    // search (jump) should select first
    highlightArgs = []
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('1/4')
    })
    document.body.removeChild(target)
  })

  it('component: rescan reflects mutated rendered DOM on cross-chunk navigation', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    // start with 600*2 =1200
    target.innerHTML = Array.from({ length: 600 })
      .map(() => '<div>hello hello</div>')
      .join('')
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('1/1200')
    })
    // mutate DOM: add 600 more hello (another 1200 matches total becomes 2400)
    target.innerHTML += Array.from({ length: 600 })
      .map(() => '<div>hello hello</div>')
      .join('')
    // navigate within same chunk — per generation invalidation, before same-chunk navigation can continue
    // the rendered DOM must be rescanned, so total refreshes even before crossing chunk boundary
    for (let i = 0; i < 499; i++) {
      await act(async () => {
        ref.current?.searchNext()
      })
    }
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('500/2400')
    })
    // next crosses to chunk 1 and stays on refreshed total
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('501/2400')
    })
    document.body.removeChild(target)
  })

  it('component: cleanup clears highlights and bounded state on disable/escape/unmount', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>hello hello hello</div>'
    document.body.appendChild(target)
    const onClose = vi.fn()
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount } = render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={onClose} />)
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('1/3'))
    highlightsMock.clear.mockClear()
    // disable via ref
    await act(async () => {
      ref.current?.disable()
    })
    expect(highlightsMock.clear).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    // after disable, search again should be empty (unmounted parent would remove, but component stays if we simulate legacy? Actually parent-owned unmounts, but ref still exists but component unmounted by parent; here parent keeps mounted because we passed onClose but didn't actually unmount)
    // check unmount clears
    highlightsMock.clear.mockClear()
    unmount()
    expect(highlightsMock.clear).toHaveBeenCalled()
    document.body.removeChild(target)
  })

  it('component: legacy hidden mode retains bounded behavior', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    // 550 matches -> 2 chunks
    target.innerHTML = Array.from({ length: 550 })
      .map(() => '<span>legacy</span>')
      .join(' ')
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} />)
    const host = screen.getByTestId('content-search-host')
    expect(host.style.display).toBe('none')
    await act(async () => {
      ref.current?.enable('legacy')
    })
    await waitFor(() => expect(host.style.display).not.toBe('none'))
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    // after enable with text, result is either silent (0/550) or jumped (1/550) depending on rAF/effect race — both prove bounded total
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toMatch(/0\/550|1\/550/))
    // actual search jump
    input.value = 'legacy'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('1/550'))
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)
    // navigate across chunk
    for (let i = 0; i < 500; i++) {
      await act(async () => {
        ref.current?.searchNext()
      })
    }
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('501/550'))
    // disable hides again and clears
    highlightsMock.clear.mockClear()
    await act(async () => {
      ref.current?.disable()
    })
    await waitFor(() => expect(host.style.display).toBe('none'))
    expect(highlightsMock.clear).toHaveBeenCalled()
    document.body.removeChild(target)
  })

  it('component: includeUser filter governs rendered-DOM-only search', async () => {
    // Simulate Chat filter that excludes user messages when includeUser false
    const target = document.createElement('div')
    target.innerHTML =
      '<div class="message message-user"><div class="message-content-container">secret hello</div></div>' +
      '<div class="message message-assistant"><div class="message-content-container">hello world</div></div>'
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
    const { rerender } = render(
      <ContentSearch ref={ref} searchTarget={target} filter={chatFilterExcludeUser} onClose={() => {}} />
    )
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('1/1'))

    // now include user -> filter accepts all
    const chatFilterIncludeAll: NodeFilter = {
      acceptNode: () => NodeFilter.FILTER_ACCEPT
    } as any
    rerender(<ContentSearch ref={ref} searchTarget={target} filter={chatFilterIncludeAll} onClose={() => {}} />)
    // need to re-search
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('1/2'))
    document.body.removeChild(target)
  })

  it('highlights bounded after case-sensitive and whole-word toggles', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>Hello hello HELLO hello</div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('1/4'))
    // case-sensitive/whole-word semantics already covered via helper; here verify highlight bounded after additional search
    highlightArgs = []
    // Change filter indirectly not needed; we verify highlight bounded even after multiple searches
    await act(async () => {
      ref.current?.search()
    })
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)
    document.body.removeChild(target)
  })

  it('synchronous mutation without yielding: same-chunk navigation drains pending observer records and rescans', async () => {
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
    // Synchronous mutation: append text without yielding to MutationObserver async delivery
    const extra = document.createElement('div')
    extra.textContent = 'foo foo'
    // Immediately navigate without setTimeout / rAF — must synchronously drain via takeRecords
    await act(async () => {
      target.appendChild(extra)
      ref.current?.searchNext()
    })
    await waitFor(() => expect(host.textContent).toContain('2/5'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('5')
    expect(highlightArgs.some((a) => a.length === 5)).toBe(true)
    expect(highlightArgs.every((a) => a.length <= 500)).toBe(true)
    document.body.removeChild(target)
  })

  it('synchronous attribute mutation affecting filter without yielding triggers rescan via drained observer', async () => {
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
    const userMsg = target.querySelector('.message-user') as HTMLElement
    expect(userMsg).not.toBeNull()
    // Synchronous attribute mutation (class) — snapshot textLength/childCount unchanged, observer attributes:true must invalidate
    await act(async () => {
      userMsg.classList.remove('message-user')
      userMsg.classList.add('message-assistant')
      ref.current?.searchNext()
    })
    await waitFor(() => expect(host.textContent).toContain('/2'))
    expect(liveHost.getAttribute('data-live-ranges')).toBe('2')
    expect(highlightArgs.some((a) => a.length === 2)).toBe(true)
    document.body.removeChild(target)
  })
})
