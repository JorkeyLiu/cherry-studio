import { act, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContentSearch, type ContentSearchRef } from '../ContentSearch'
import {
  createContentSearchSessionOwnerId,
  getActiveContentSearchOwnerForTests,
  getContentSearchDiagnostics,
  recordContentSearchCommit,
  releaseContentSearchSessionIfOwned,
  resetContentSearchDiagnosticsForTests
} from '../contentSearchDiagnostics'

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
  resetContentSearchDiagnosticsForTests()
  ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_LIVE = undefined
  ;(globalThis as any).__CS_SAME_CHUNK_BEFORE_SCAN_TOTAL = undefined
})

describe('B-08 diagnostics corrections', () => {
  it('active query target replacement increments rescan count exactly once and publishes current generation', async () => {
    const filter = makeFilter()
    const t1 = document.createElement('div')
    t1.innerHTML = '<div>hello hello hello</div>'
    document.body.appendChild(t1)
    const t2 = document.createElement('div')
    t2.innerHTML = '<div>hello xxxxx xxxxx</div>'
    document.body.appendChild(t2)

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
    const before = getContentSearchDiagnostics()
    const rescanBefore = before.rescanCount
    const genBefore = before.domGeneration
    const liveGenBefore = Number(liveHost.getAttribute('data-dom-generation'))

    // Replace target — active session must rescan, increment rescanCount exactly once, publish generation
    rerender(<ContentSearch ref={ref} searchTarget={t2} filter={filter} onClose={() => {}} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(liveHost.getAttribute('data-live-ranges')).toBe('1'))
    const after = getContentSearchDiagnostics()
    expect(after.rescanCount).toBe(rescanBefore + 1)
    expect(after.domGeneration).toBeGreaterThanOrEqual(genBefore + 1)
    // publishes current generation: host and diagnostics agree and are monotonic
    const hostGen = Number(liveHost.getAttribute('data-dom-generation'))
    expect(hostGen).toBe(after.domGeneration)
    expect(hostGen).toBeGreaterThanOrEqual(liveGenBefore + 1)

    // second replacement should increment again exactly once
    const t3 = document.createElement('div')
    t3.innerHTML = '<div>hello hello</div>'
    document.body.appendChild(t3)
    const rescanMid = after.rescanCount
    rerender(<ContentSearch ref={ref} searchTarget={t3} filter={filter} onClose={() => {}} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(liveHost.getAttribute('data-live-ranges')).toBe('2'))
    const after2 = getContentSearchDiagnostics()
    expect(after2.rescanCount).toBe(rescanMid + 1)

    document.body.removeChild(t1)
    document.body.removeChild(t2)
    document.body.removeChild(t3)
  })

  it('pending-search target replacement rescan increments exactly once', async () => {
    const filter = makeFilter()
    const t1 = document.createElement('div')
    t1.innerHTML = '<div>hello hello hello</div>'
    document.body.appendChild(t1)
    const t2 = document.createElement('div')
    t2.innerHTML = '<div>hello hello</div>'
    document.body.appendChild(t2)

    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { rerender } = render(<ContentSearch ref={ref} searchTarget={t1} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search-host')
    const before = getContentSearchDiagnostics()
    const rescanBefore = before.rescanCount

    await act(async () => {
      ref.current?.enable('hello')
      rerender(<ContentSearch ref={ref} searchTarget={t2} filter={filter} onClose={() => {}} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(host.getAttribute('data-live-ranges')).toBe('2'))
    const after = getContentSearchDiagnostics()
    expect(after.rescanCount).toBe(rescanBefore + 1)

    document.body.removeChild(t1)
    document.body.removeChild(t2)
  })

  it('zero-result dirty/rescan paths increment generation and publish it (same-chunk and cross-chunk)', async () => {
    const filter = makeFilter()
    // same-chunk zero: start with 2 matches, mutate to 0, then stale same-chunk navigation triggers zero branch
    const target = document.createElement('div')
    target.innerHTML = '<div>hello hello</div>'
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
    await waitFor(() => expect(bar.textContent).toContain('1/2'))
    const genBefore = getContentSearchDiagnostics().domGeneration
    const rescanBefore = getContentSearchDiagnostics().rescanCount
    const hostGenBefore = Number(host.getAttribute('data-dom-generation'))

    // mutate to zero matches but make DOM dirty via text change
    target.innerHTML = '<div>xxx yyy</div>'
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // stale same-chunk navigation (next within same chunk 0) should rescan and hit zero branch
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => expect(bar.textContent).toContain('0/0'))
    expect(host.getAttribute('data-live-ranges')).toBe('0')
    const after = getContentSearchDiagnostics()
    expect(after.rescanCount).toBe(rescanBefore + 1)
    expect(after.domGeneration).toBeGreaterThan(genBefore)
    expect(Number(host.getAttribute('data-dom-generation'))).toBe(after.domGeneration)
    expect(Number(host.getAttribute('data-dom-generation'))).toBeGreaterThan(hostGenBefore)

    // cross-chunk zero: create large target >500, navigate to next chunk then mutate to zero before cross
    const largeTarget = document.createElement('div')
    largeTarget.innerHTML = Array.from({ length: 620 })
      .map(() => '<div>hello world hello</div>')
      .join('')
    document.body.appendChild(largeTarget)
    const ref2 = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount } = render(
      <ContentSearch ref={ref2} searchTarget={largeTarget} filter={filter} onClose={() => {}} />
    )
    // need to isolate diagnostics for cross-chunk test: reset not possible without unmount effect, so check generation monotonic still
    // Do search on large target
    const bar2 = screen.getAllByTestId('content-search').at(-1)!
    const host2 = screen.getAllByTestId('content-search-host').at(-1)!
    const input2 = bar2.querySelector('input') as HTMLInputElement
    input2.value = 'hello'
    await act(async () => {
      ref2.current?.search()
    })
    await waitFor(() => expect(bar2.textContent).toContain('1/1240'))
    // advance to last index of chunk0
    for (let i = 0; i < 499; i++) {
      await act(async () => {
        ref2.current?.searchNext()
      })
    }
    await waitFor(() => expect(bar2.textContent).toContain('500/1240'))
    const genBeforeCross = getContentSearchDiagnostics().domGeneration
    const rescanBeforeCross = getContentSearchDiagnostics().rescanCount
    const hostGenBeforeCross = Number(host2.getAttribute('data-dom-generation'))
    // mutate large target to zero matches
    largeTarget.innerHTML = '<div>xxx yyy</div>'
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // next should cross to chunk 1 and hit zero branch
    await act(async () => {
      ref2.current?.searchNext()
    })
    await waitFor(() => expect(bar2.textContent).toContain('0/0'))
    expect(host2.getAttribute('data-live-ranges')).toBe('0')
    const afterCross = getContentSearchDiagnostics()
    expect(afterCross.rescanCount).toBe(rescanBeforeCross + 1)
    // monotonic: global never decreases, host must increment
    expect(afterCross.domGeneration).toBeGreaterThanOrEqual(genBeforeCross)
    expect(Number(host2.getAttribute('data-dom-generation'))).toBeGreaterThan(hostGenBeforeCross)
    // if host local surpassed global, global catches up; otherwise global stays at prior high
    expect(Number(host2.getAttribute('data-dom-generation'))).toBeGreaterThan(hostGenBeforeCross)

    // prev zero branch: from zero state, dirty then prev should also publish generation
    // Reset target to have 1 hello, then dirty to zero and prev
    largeTarget.innerHTML = '<div>hello</div>'
    await act(async () => {
      // force rescan via search to get 1
      input2.value = 'hello'
      ref2.current?.search()
    })
    await waitFor(() => expect(bar2.textContent).toContain('1/1'))
    largeTarget.innerHTML = '<div>zzz zzz</div>'
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const genBeforePrevZero = getContentSearchDiagnostics().domGeneration
    const rescanBeforePrevZero = getContentSearchDiagnostics().rescanCount
    const hostGenBeforePrevZero = Number(host2.getAttribute('data-dom-generation'))
    await act(async () => {
      ref2.current?.searchPrev()
    })
    // prev stale same-chunk zero path (still chunk 0) -> 0/0
    await waitFor(() => expect(bar2.textContent).toContain('0/0'))
    const afterPrevZero = getContentSearchDiagnostics()
    expect(afterPrevZero.rescanCount).toBe(rescanBeforePrevZero + 1)
    expect(afterPrevZero.domGeneration).toBeGreaterThanOrEqual(genBeforePrevZero)
    expect(Number(host2.getAttribute('data-dom-generation'))).toBeGreaterThan(hostGenBeforePrevZero)

    unmount()
    document.body.removeChild(target)
    document.body.removeChild(largeTarget)
  })

  it('owner A high generation -> unmount -> B lower local generation never decreases global diagnostic generation', async () => {
    const filter = makeFilter()
    const targetA = document.createElement('div')
    targetA.innerHTML = '<div>hello hello hello</div>'
    document.body.appendChild(targetA)
    const refA = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountA } = render(
      <ContentSearch ref={refA} searchTarget={targetA} filter={filter} onClose={() => {}} />
    )
    const barA = screen.getByTestId('content-search')
    const inputA = barA.querySelector('input') as HTMLInputElement
    inputA.value = 'hello'
    await act(async () => {
      refA.current?.search()
    })
    await waitFor(() => expect(barA.textContent).toContain('1/3'))
    // mutate to bump generation multiple times
    for (let i = 0; i < 5; i++) {
      const extra = document.createElement('div')
      extra.textContent = 'hello'
      targetA.appendChild(extra)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      await act(async () => {
        refA.current?.searchNext()
      })
    }
    const diagAfterA = getContentSearchDiagnostics()
    const highGen = diagAfterA.domGeneration
    expect(highGen).toBeGreaterThan(1)
    // unmount A (releases owner but preserves generation)
    unmountA()
    const afterRelease = getContentSearchDiagnostics()
    expect(afterRelease.domGeneration).toBe(highGen)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // Direct diagnostics: B tries to commit lower generation, must not decrease
    const ownerB = createContentSearchSessionOwnerId()
    recordContentSearchCommit(ownerB, 1, 0, 1, 1) // lower than highGen
    const afterBCommit = getContentSearchDiagnostics()
    expect(afterBCommit.domGeneration).toBe(highGen)
    expect(afterBCommit.liveRangeCount).toBe(1)
    // commit with higher generation should increase
    const ownerC = createContentSearchSessionOwnerId()
    // need to release B first to allow C to claim (monotonic)
    releaseContentSearchSessionIfOwned(ownerB)
    recordContentSearchCommit(ownerC, 1, 0, 1, highGen + 10)
    expect(getContentSearchDiagnostics().domGeneration).toBe(highGen + 10)

    // Component-level handoff: mount B with fresh local generation 0, ensure global never decreases
    const targetB = document.createElement('div')
    targetB.innerHTML = '<div>hello</div>'
    document.body.appendChild(targetB)
    const refB = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={refB} searchTarget={targetB} filter={filter} onClose={() => {}} />)
    const hostB = screen.getAllByTestId('content-search-host').at(-1)!
    const barB = screen.getAllByTestId('content-search').at(-1)!
    const inputB = barB.querySelector('input') as HTMLInputElement
    inputB.value = 'hello'
    await act(async () => {
      refB.current?.search()
    })
    await waitFor(() => expect(barB.textContent).toContain('1/1'))
    // local B generation is low (1), but global must stay at least highGen+10 (monotonic, never decreases)
    expect(getContentSearchDiagnostics().domGeneration).toBeGreaterThanOrEqual(highGen + 10)
    // host shows local generation (1), which is lower than global but global preserved
    expect(getContentSearchDiagnostics().domGeneration).toBe(highGen + 10)
    expect(Number(hostB.getAttribute('data-dom-generation'))).toBeLessThanOrEqual(
      getContentSearchDiagnostics().domGeneration
    )

    document.body.removeChild(targetA)
    document.body.removeChild(targetB)
  })

  it('rerender does not allocate owner IDs', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>hello</div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { rerender } = render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    // capture sessionCounter via owner allocation: next id after mount
    const idAfterMount = createContentSearchSessionOwnerId()
    // rerender same instance multiple times (props change but instance preserved)
    for (let i = 0; i < 5; i++) {
      rerender(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    }
    const idAfterRerenders = createContentSearchSessionOwnerId()
    // exactly one increment between the two allocations — rerenders did not allocate
    expect(idAfterRerenders).toBe(idAfterMount + 1)

    // also test that multiple rerenders with target changes do not allocate per render, only per replacement rescan (which allocates via existing owner, not new)
    // ensure active owner stays stable across rerenders
    // need to have an active commit to have owner
    const bar = screen.getByTestId('content-search')
    const input = bar.querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(bar.textContent).toContain('1/1'))
    const activeAfterSearch = getActiveContentSearchOwnerForTests()
    expect(activeAfterSearch).not.toBeNull()
    for (let i = 0; i < 3; i++) {
      rerender(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    }
    expect(getActiveContentSearchOwnerForTests()).toBe(activeAfterSearch)

    document.body.removeChild(target)
  })
})
