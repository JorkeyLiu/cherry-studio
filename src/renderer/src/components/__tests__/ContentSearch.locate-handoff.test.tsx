import { scrollElementIntoView } from '@renderer/utils'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContentSearch, type ContentSearchLocatedMatch, type ContentSearchRef } from '../ContentSearch'

/**
 * Match-positioning handoff (`onLocateMatch`).
 *
 * The component owns the scan/highlight session; a host whose scroll owner is
 * NOT the search target owns the actual positioning. These tests pin the
 * contract between the two:
 *  - no hook       -> the generic target scroll is kept (non-chat hosts)
 *  - hook true     -> the generic scroll is skipped, the host gets the exact
 *                     match (range + owning element), including distinct hits
 *                     inside one row
 *  - hook false    -> the generic scroll is kept (host declined)
 *  - silent search -> no positioning at all (no jump, no handoff)
 */

const highlightsMock = {
  clear: vi.fn(),
  set: vi.fn(),
  delete: vi.fn()
}
// @ts-ignore
global.CSS = global.CSS || {}
// @ts-ignore
global.CSS.highlights = highlightsMock

// @ts-ignore
global.Highlight = class Highlight {
  readonly ranges: unknown[]
  constructor(...ranges: unknown[]) {
    this.ranges = ranges
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

const makeFilter = (): NodeFilter => ({ acceptNode: () => NodeFilter.FILTER_ACCEPT }) as any

let appendedTargets: HTMLElement[] = []

const trackTarget = (el: HTMLElement): HTMLElement => {
  appendedTargets.push(el)
  document.body.appendChild(el)
  return el
}

const ONE_ROW_TWO_HITS =
  '<div class="message message-assistant"><div class="message-content-container">' +
  '<p>marker one</p><p>marker two</p>' +
  '</div></div>'

const mount = (options: { target: HTMLElement; onLocateMatch?: (match: ContentSearchLocatedMatch) => boolean }) => {
  const ref = { current: null as any } as React.RefObject<ContentSearchRef>
  render(
    <ContentSearch
      ref={ref}
      searchTarget={options.target}
      filter={makeFilter()}
      onClose={() => {}}
      onLocateMatch={options.onLocateMatch}
    />
  )
  const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
  return { ref, input }
}

const runSearch = async (ref: React.RefObject<ContentSearchRef>, input: HTMLInputElement, query: string) => {
  fireEvent.input(input, { target: { value: '' } })
  input.value = query
  await act(async () => {
    ref.current?.search()
  })
  await waitFor(() => {
    expect(screen.getByTestId('content-search').textContent).toContain('/')
  })
}

const runNext = async (ref: React.RefObject<ContentSearchRef>) => {
  await act(async () => {
    ref.current?.searchNext()
  })
}

beforeEach(() => {
  highlightsMock.clear.mockClear()
  highlightsMock.set.mockClear()
  highlightsMock.delete.mockClear()
  vi.mocked(scrollElementIntoView).mockClear()
})

afterEach(() => {
  cleanup()
  for (const target of appendedTargets) {
    try {
      target.remove()
    } catch {}
  }
  appendedTargets = []
  vi.mocked(scrollElementIntoView).mockClear()
})

describe('ContentSearch match-positioning handoff', () => {
  it('keeps the generic target scroll when no host hook is provided', async () => {
    const target = trackTarget(document.createElement('div'))
    target.innerHTML = ONE_ROW_TWO_HITS
    const { ref, input } = mount({ target })

    await runSearch(ref, input, 'marker')
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('1/2')
    })
    await waitFor(() => expect(scrollElementIntoView).toHaveBeenCalled())

    const [element, scrollTarget] = vi.mocked(scrollElementIntoView).mock.calls.at(-1)!
    expect(element.textContent).toBe('marker one')
    expect(scrollTarget).toBe(target)
  })

  it('skips the generic scroll when the host reports it positioned the match', async () => {
    const target = trackTarget(document.createElement('div'))
    target.innerHTML = ONE_ROW_TWO_HITS
    const located: ContentSearchLocatedMatch[] = []
    const onLocateMatch = vi.fn((match: ContentSearchLocatedMatch) => {
      located.push(match)
      return true
    })
    const { ref, input } = mount({ target, onLocateMatch })

    await runSearch(ref, input, 'marker')
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('1/2')
    })
    await waitFor(() => expect(onLocateMatch).toHaveBeenCalled())

    // Host owned the positioning: no generic target scroll happened at all.
    expect(scrollElementIntoView).not.toHaveBeenCalled()

    const first = located.at(-1)!
    expect(first.element?.textContent).toBe('marker one')
    expect(first.range.startContainer.textContent).toBe('marker one')
    expect(first.element?.closest('.message')).not.toBeNull()
  })

  it('hands off each hit of one long row as its own element (never the row)', async () => {
    const target = trackTarget(document.createElement('div'))
    target.innerHTML = ONE_ROW_TWO_HITS
    const located: ContentSearchLocatedMatch[] = []
    const onLocateMatch = vi.fn((match: ContentSearchLocatedMatch) => {
      located.push(match)
      return true
    })
    const { ref, input } = mount({ target, onLocateMatch })

    await runSearch(ref, input, 'marker')
    await waitFor(() => expect(onLocateMatch).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('1/2')
    })

    await runNext(ref)
    await waitFor(() => {
      expect(screen.getByTestId('content-search').textContent).toContain('2/2')
    })
    await waitFor(() => expect(located.at(-1)?.element?.textContent).toBe('marker two'))

    const first = located.find((match) => match.element?.textContent === 'marker one')
    const second = located.at(-1)!
    expect(first).toBeDefined()
    expect(second.element?.textContent).toBe('marker two')
    // Distinct hit elements inside the SAME owning row: positioning per hit,
    // not per row.
    expect(first!.element).not.toBe(second.element)
    expect(first!.element?.closest('.message')).toBe(second.element?.closest('.message'))
    expect(scrollElementIntoView).not.toHaveBeenCalled()
  })

  it('hands off distinct RANGES for two hits inside the same paragraph', async () => {
    const target = trackTarget(document.createElement('div'))
    target.innerHTML =
      '<div class="message message-assistant"><div class="message-content-container">' +
      '<p>marker alpha and marker beta</p>' +
      '</div></div>'
    const located: ContentSearchLocatedMatch[] = []
    const onLocateMatch = vi.fn((match: ContentSearchLocatedMatch) => {
      located.push(match)
      return true
    })
    const { ref, input } = mount({ target, onLocateMatch })

    await runSearch(ref, input, 'marker')
    await waitFor(() => expect(onLocateMatch).toHaveBeenCalled())
    await runNext(ref)
    await waitFor(() => expect(located.length).toBeGreaterThan(1))

    const [first, second] = located
    // One paragraph element owns both hits ...
    expect(first.element).toBe(second.element)
    // ... so only the range can tell them apart, which is exactly what the
    // positioning host needs in order to land on the matched text.
    expect(first.range).not.toBe(second.range)
    expect(first.range.startContainer).toBe(second.range.startContainer)
    expect(second.range.startOffset).toBeGreaterThan(first.range.startOffset)
  })

  it('hands the search panel over so a host can exclude the strip it covers', async () => {
    const target = trackTarget(document.createElement('div'))
    target.innerHTML = ONE_ROW_TWO_HITS
    const located: ContentSearchLocatedMatch[] = []
    const onLocateMatch = vi.fn((match: ContentSearchLocatedMatch) => {
      located.push(match)
      return true
    })
    const { ref, input } = mount({ target, onLocateMatch })

    await runSearch(ref, input, 'marker')
    await waitFor(() => expect(onLocateMatch).toHaveBeenCalled())

    // The floating bar itself, not the host wrapper and not the search target.
    expect(located.at(-1)!.overlay).toBe(screen.getByTestId('content-search'))
    expect(located.at(-1)!.overlay).not.toBe(target)
  })

  it('falls back to the generic scroll when the host declines', async () => {
    const target = trackTarget(document.createElement('div'))
    target.innerHTML = ONE_ROW_TWO_HITS
    const onLocateMatch = vi.fn(() => false)
    const { ref, input } = mount({ target, onLocateMatch })

    await runSearch(ref, input, 'marker')
    await waitFor(() => expect(onLocateMatch).toHaveBeenCalled())
    await waitFor(() => expect(scrollElementIntoView).toHaveBeenCalled())

    const [, scrollTarget] = vi.mocked(scrollElementIntoView).mock.calls.at(-1)!
    expect(scrollTarget).toBe(target)
  })

  it('does not position or hand off on a silent (non-jumping) search', async () => {
    const target = trackTarget(document.createElement('div'))
    target.innerHTML = ONE_ROW_TWO_HITS
    const onLocateMatch = vi.fn(() => true)
    const { ref, input } = mount({ target, onLocateMatch })

    fireEvent.input(input, { target: { value: '' } })
    input.value = 'marker'
    await act(async () => {
      ref.current?.silentSearch()
    })
    await waitFor(() => {
      // Silent search commits the count but never selects/positions a hit.
      expect(screen.getByTestId('content-search').textContent).toContain('0/2')
    })
    expect(onLocateMatch).not.toHaveBeenCalled()
    expect(scrollElementIntoView).not.toHaveBeenCalled()
  })
})
