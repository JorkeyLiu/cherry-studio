import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ContentSearch, type ContentSearchRef } from '../ContentSearch'

// Stub CSS.highlights for jsdom
const highlightsMock = {
  clear: vi.fn(),
  set: vi.fn(),
  delete: vi.fn()
}
// @ts-ignore
global.CSS = global.CSS || {}
// @ts-ignore
global.CSS.highlights = highlightsMock

// Highlight global may not exist
// @ts-ignore
global.Highlight = class Highlight {
  constructor(..._args: any[]) {}
}

vi.mock('@renderer/utils', async () => {
  const actual = await vi.importActual('@renderer/utils')
  return {
    // @ts-ignore
    ...actual,
    scrollElementIntoView: vi.fn()
  }
})

describe('S3.5 ContentSearch lazy activation', () => {
  it('renders visible when mounted (parent-owned) with data-testid and is focused', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const onClose = vi.fn()
    const target = document.createElement('div')
    render(<ContentSearch searchTarget={target} filter={filter} onClose={onClose} />)
    // Semantic marker is the painted visible bar; host is zero-box container
    const host = screen.getByTestId('content-search-host')
    const semantic = screen.getByTestId('content-search')
    expect(host).toBeInTheDocument()
    expect(semantic).toBeInTheDocument()
    // Parent-owned: host has no display:none; semantic is the visible UI
    expect(host.style.display).not.toBe('none')
    const input = semantic.querySelector('input')!
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it('applies initialText on mount and triggers search', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    target.innerHTML =
      '<div class="message message-assistant"><div class="message-content-container">hello world hello</div></div>'
    document.body.appendChild(target)
    render(<ContentSearch searchTarget={target} filter={filter} initialText="hello" onClose={() => {}} />)
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    expect(input.value).toBe('hello')
    document.body.removeChild(target)
  })

  it('disable calls onClose and clears highlights (parent owns unmount)', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const onClose = vi.fn()
    const target = document.createElement('div')
    const ref2 = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref2} searchTarget={target} filter={filter} onClose={onClose} />)
    highlightsMock.clear.mockClear()
    ref2.current?.disable()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(highlightsMock.clear).toHaveBeenCalled()
  })

  it('imperative enable while mounted updates value and focuses', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} />)
    ref.current?.enable('selected text')
    await waitFor(() => {
      const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
      expect(input.value).toBe('selected text')
    })
  })

  it('clears highlights on unmount', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    const { unmount } = render(<ContentSearch searchTarget={target} filter={filter} />)
    highlightsMock.clear.mockClear()
    unmount()
    expect(highlightsMock.clear).toHaveBeenCalled()
  })

  it('Escape key triggers disable/onClose', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const onClose = vi.fn()
    const target = document.createElement('div')
    render(<ContentSearch searchTarget={target} filter={filter} onClose={onClose} />)
    const input = screen.getByTestId('content-search').querySelector('input')!
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('parent conditional mount yields zero instance before invocation', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    const Parent = ({ active }: { active: boolean }) => (
      <div>{active ? <ContentSearch searchTarget={target} filter={filter} onClose={() => {}} /> : null}</div>
    )
    const { rerender } = render(<Parent active={false} />)
    // Both host and semantic are absent before parent mount
    expect(screen.queryByTestId('content-search')).not.toBeInTheDocument()
    expect(screen.queryByTestId('content-search-host')).not.toBeInTheDocument()
    rerender(<Parent active={true} />)
    expect(screen.getByTestId('content-search')).toBeInTheDocument()
    expect(screen.getByTestId('content-search-host')).toBeInTheDocument()
    rerender(<Parent active={false} />)
    expect(screen.queryByTestId('content-search')).not.toBeInTheDocument()
    expect(screen.queryByTestId('content-search-host')).not.toBeInTheDocument()
  })

  it('rapid repeated parent activation/dismissal preserves pending text and does not throw', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    target.innerHTML =
      '<div class="message message-assistant"><div class="message-content-container">hello hello</div></div>'
    document.body.appendChild(target)
    const Parent = ({ active, text }: { active: boolean; text?: string }) => (
      <div>
        {active ? <ContentSearch searchTarget={target} filter={filter} initialText={text} onClose={() => {}} /> : null}
      </div>
    )
    const { rerender, unmount } = render(<Parent active={false} />)
    // rapid enable with text
    rerender(<Parent active={true} text="hello" />)
    expect(screen.getByTestId('content-search').querySelector('input')!.value).toBe('hello')
    expect(screen.getByTestId('content-search-host')).toBeInTheDocument()
    // rapid disable + re-enable with different text
    rerender(<Parent active={false} />)
    expect(screen.queryByTestId('content-search')).not.toBeInTheDocument()
    expect(screen.queryByTestId('content-search-host')).not.toBeInTheDocument()
    rerender(<Parent active={true} text="world" />)
    expect(screen.getByTestId('content-search').querySelector('input')!.value).toBe('world')
    // rapid dismiss again
    rerender(<Parent active={false} />)
    rerender(<Parent active={true} />)
    expect(screen.getByTestId('content-search')).toBeInTheDocument()
    expect(screen.getByTestId('content-search-host')).toBeInTheDocument()
    unmount()
    document.body.removeChild(target)
  })

  it('rapid imperative enable/disable via ref does not throw and last call wins', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const onClose = vi.fn()
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={onClose} />)
    // rapid enable calls
    act(() => {
      ref.current?.enable('first')
      ref.current?.enable('second')
      ref.current?.enable('third')
    })
    await waitFor(() => {
      const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
      expect(input.value).toBe('third')
    })
    // rapid disable calls should be idempotent
    act(() => {
      ref.current?.disable()
      ref.current?.disable()
    })
    expect(onClose).toHaveBeenCalled()
    // disable when already disabled (parent-owned would be unmounted, but legacy mode test covers hidden)
  })

  it('does not throw when CSS.highlights is unavailable (all clear/set/delete paths guarded)', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    target.innerHTML =
      '<div class="message message-assistant"><div class="message-content-container">hello world</div></div>'
    document.body.appendChild(target)
    const savedHighlights = (global as any).CSS.highlights
    const savedHighlight = (global as any).Highlight
    // @ts-ignore
    delete (global as any).CSS.highlights
    // @ts-ignore
    delete (global as any).Highlight
    try {
      const ref = { current: null as any } as React.RefObject<ContentSearchRef>
      const { unmount } = render(
        <ContentSearch ref={ref} searchTarget={target} filter={filter} initialText="hello" onClose={() => {}} />
      )
      const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
      expect(input.value).toBe('hello')
      // imperative paths should not throw
      expect(() => ref.current?.search()).not.toThrow()
      expect(() => ref.current?.silentSearch()).not.toThrow()
      expect(() => ref.current?.disable()).not.toThrow()
      // typing should not throw
      const input2 = screen.queryByTestId('content-search')?.querySelector('input')
      if (input2) {
        expect(() => fireEvent.input(input2, { target: { value: 'world' } })).not.toThrow()
      }
      expect(() => unmount()).not.toThrow()
    } finally {
      // @ts-ignore
      ;(global as any).CSS.highlights = savedHighlights
      // @ts-ignore
      ;(global as any).Highlight = savedHighlight
      document.body.removeChild(target)
    }
  })

  it('legacy mode (RichEditor, no onClose) starts hidden and toggles via imperative enable/disable', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} />)
    // Legacy mode hides via host display:none; semantic is child of host
    const host = screen.getByTestId('content-search-host')
    const semantic = screen.getByTestId('content-search')
    expect(host.style.display).toBe('none')
    expect(host).toBeInTheDocument()
    expect(semantic).toBeInTheDocument()
    act(() => ref.current?.enable('legacy text'))
    await waitFor(() => expect(host.style.display).not.toBe('none'))
    expect(semantic.querySelector('input')!.value).toBe('legacy text')
    act(() => ref.current?.disable())
    await waitFor(() => expect(host.style.display).toBe('none'))
    // re-enable without text should still show
    act(() => ref.current?.enable())
    await waitFor(() => expect(host.style.display).not.toBe('none'))
  })

  it('cancels debounced search and rAF on unmount without throwing', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    target.innerHTML =
      '<div class="message message-assistant"><div class="message-content-container">debounce test hello world</div></div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount } = render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const input = screen.getByTestId('content-search').querySelector('input')!
    // trigger debounced search
    fireEvent.input(input, { target: { value: 'hello' } })
    // unmount before debounce fires (300ms)
    unmount()
    // should not throw, and should have cleared highlights on unmount (guarded)
    // wait past debounce interval to ensure no late invocation throws
    await new Promise((r) => setTimeout(r, 400))
    document.body.removeChild(target)
  })

  it('imperative enable rAF is cancelled on unmount (no silentSearch on unmounted instance)', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount } = render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    // enable schedules rAF that will call search(false)
    act(() => ref.current?.enable('hello'))
    // unmount before rAF fires
    unmount()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    // no throw expected
  })

  it('preserves active search across topic switches (LOCK-S35-008) — does not auto-dismiss on activeTopic change', async () => {
    const filter: NodeFilter = { acceptNode: () => NodeFilter.FILTER_ACCEPT } as any
    const target = document.createElement('div')
    // Simulate Chat parent-owned wrapper where isContentSearchActive stays true across topicId changes
    const Parent = ({ topicId, active }: { topicId: string; active: boolean }) => (
      <div data-topic={topicId}>
        {active ? <ContentSearch searchTarget={target} filter={filter} onClose={() => {}} /> : null}
      </div>
    )
    const { rerender } = render(<Parent topicId="t1" active={true} />)
    const before = screen.getByTestId('content-search')
    expect(before).toBeInTheDocument()
    const inputBefore = before.querySelector('input') as HTMLInputElement
    // Simulate user typing
    fireEvent.input(inputBefore, { target: { value: 'hello' } })
    // Switch topic — parent keeps search active (no auto-dismiss)
    rerender(<Parent topicId="t2" active={true} />)
    const after = screen.getByTestId('content-search')
    expect(after).toBeInTheDocument()
    // Input should retain value (parent did not reset) and no unmount occurred
    expect(after.querySelector('input')!.value).toBe('hello')
    // Deactivation only via explicit close, not via topic change
    rerender(<Parent topicId="t2" active={false} />)
    expect(screen.queryByTestId('content-search')).not.toBeInTheDocument()
  })
})
