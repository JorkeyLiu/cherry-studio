import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  )
}))

import MessageOutline from '../MessageOutline'

describe('MessageOutline restored original presentation', () => {
  it('renders caller entries in the original Container > Body > Item div hierarchy', () => {
    const onNavigate = vi.fn()
    const { container } = render(
      <MessageOutline
        entries={[
          { id: 'u1', text: 'First question' },
          { id: 'u2', text: 'Second question' }
        ]}
        onNavigate={onNavigate}
      />
    )

    const nav = container.querySelector('[data-testid="conversation-navigation"]')
    expect(nav).not.toBeNull()
    expect(nav?.tagName).toBe('DIV')
    const body = nav!.firstElementChild as HTMLElement | null
    expect(body).not.toBeNull()
    // Rows are the content box's children (body > panel > content); the
    // hierarchy the test checks is the row itself.
    const rows = Array.from(body!.querySelectorAll('div[data-message-id]'))
    expect(rows.map((row) => row.getAttribute('data-message-id'))).toEqual(['u1', 'u2'])
    for (const row of rows) {
      expect(row.querySelectorAll(':scope > div').length).toBe(2)
    }
    expect(screen.getByTestId('conversation-nav-item-u1').textContent).toContain('First question')
  })

  it('navigates by stable ID on click and keyboard', () => {
    const onNavigate = vi.fn()
    render(<MessageOutline entries={[{ id: 'u9', text: 'Only question' }]} onNavigate={onNavigate} />)

    const item = screen.getByTestId('conversation-nav-item-u9')
    expect(item.getAttribute('title')).toBe('Only question')
    fireEvent.click(item)
    expect(onNavigate).toHaveBeenCalledWith('u9')
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('u9')
  })

  it('renders null for empty caller state', () => {
    const { container } = render(<MessageOutline entries={[]} onNavigate={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('applies approved 13px text + bounded body caps while keeping row geometry', () => {
    const { container } = render(
      <MessageOutline
        entries={[
          { id: 'u1', text: 'First question' },
          { id: 'u2', text: 'Second question' }
        ]}
        onNavigate={vi.fn()}
      />
    )

    // styled-components injects component CSS into <style>; normalize
    // whitespace so calc/min serialization variants cannot false-fail.
    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
    const norm = css.replace(/\s+/g, '')
    expect(norm).toContain('font-size:13px')
    expect(norm).toContain('max-width:min(320px,calc(100%-24px))')
    expect(norm).toContain('max-height:min(100%,45vh,420px)')
    expect(norm).not.toContain('font-size:15px')

    // Row geometry + DOM invariants stay unchanged.
    const nav = container.querySelector('[data-testid="conversation-navigation"]')
    const rows = Array.from(nav!.querySelectorAll('div[data-message-id]'))
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.querySelectorAll(':scope > div').length).toBe(2)
    }
    expect(norm).toContain('height:24px')
    expect(norm).toContain('gap:4px')
    expect(norm).toContain('gap:8px')
  })

  it('centers the body in the reading area by pure CSS flex, never a count-estimated top', () => {
    render(<MessageOutline entries={[{ id: 'u1', text: 'Only question' }]} onNavigate={vi.fn()} />)

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
    const norm = css.replace(/\s+/g, '')
    // Container covers the reading area and flex-centers the body vertically.
    expect(norm).toContain('inset:00010px')
    expect(norm).toContain('display:flex')
    expect(norm).toContain('align-items:center')
    // Intrinsic body size is preserved (no cross-axis stretch).
    expect(norm).toContain('align-self:center')
    // No count-estimated sticky top: the old midpoint formula is gone.
    expect(norm).not.toContain('position:sticky')
    expect(norm).not.toContain('calc(50%-')
    // Caps and interaction invariants still hold.
    expect(norm).toContain('max-width:min(320px,calc(100%-24px))')
    expect(norm).toContain('max-height:min(100%,45vh,420px)')
    expect(norm).toContain('pointer-events:none')
    expect(norm).toContain('pointer-events:auto')
  })
})

describe('MessageOutline reading-anchor follow', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' },
    { id: 'u3', text: 'Third question' }
  ]

  let rafQueue: FrameRequestCallback[]

  const flushRaf = () => {
    const pending = [...rafQueue]
    rafQueue.length = 0
    for (const cb of pending) cb(0)
  }

  const stubRect = (el: Element, top: number, bottom: number) => {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: top,
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      toJSON: () => ({})
    } as DOMRect)
  }

  const stubScrollable = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  }

  const renderOutline = (activeId?: string) => {
    const utils = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId={activeId} />)
    const body = utils.container.querySelector('[data-testid="conversation-navigation"]')!
      .firstElementChild as HTMLElement
    // Overflowing list by default (jsdom reports zero sizes); short-list
    // tests override via stubScrollable.
    stubScrollable(body, 500, 100)
    const rowOf = (id: string) => body.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    return { ...utils, body, rowOf, stubScrollable: (sh: number, ch: number) => stubScrollable(body, sh, ch) }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    rafQueue = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback): number => {
        rafQueue.push(cb)
        return rafQueue.length
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn(() => {
        rafQueue.length = 0
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('marks only the active row with aria-current and theme highlight CSS', () => {
    renderOutline('u2')
    expect(screen.getByTestId('conversation-nav-item-u2').getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('conversation-nav-item-u1').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('conversation-nav-item-u3').getAttribute('aria-current')).toBeNull()

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
    const norm = css.replace(/\s+/g, '')
    expect(norm).toContain('color:var(--color-text-1)')
    expect(norm).toContain('background:var(--color-primary)')
  })

  it('keeps the active dot on the theme color under row hover', () => {
    // Specificity battle: the generic `&:hover` dot rule (item:hover dot)
    // outranks the plain active dot rule, so without an explicit
    // active-hover dot rule the hovered active dot turns neutral gray.
    // Require a second theme-primary dot rule for the hovered active row;
    // the single neutral hover rule for non-active rows must remain.
    renderOutline('u2')
    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
    const norm = css.replace(/\s+/g, '')
    const primaryDots = norm.match(/background:var\(--color-primary\)/g) ?? []
    expect(primaryDots.length).toBeGreaterThanOrEqual(2)
    expect(norm).toContain('background:var(--color-text-3)')
    expect(norm).toContain('color:var(--color-text-2)')
    expect(norm).toContain('color:var(--color-text-1)')
  })

  it('leaves the outline scroll alone when the active row is fully visible', () => {
    const { body, rowOf } = renderOutline('u2')
    stubRect(body, 0, 100)
    // 30..54 sits inside the box edge to edge: the reader can already read the
    // row, so follow keeps the position it has instead of centering it.
    stubRect(rowOf('u2'), 30, 54)
    flushRaf()
    expect(body.scrollTop).toBe(0)
  })

  it('centers an out-of-view row in the outline container, never the chat', () => {
    const scrollIntoView = vi.fn()
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
    const had = 'scrollIntoView' in proto
    const prev = proto.scrollIntoView
    proto.scrollIntoView = scrollIntoView
    try {
      // Below: row center 132 deviates +82 from the container center 50.
      const { body, rowOf } = renderOutline('u2')
      stubRect(body, 0, 100)
      stubRect(rowOf('u2'), 120, 144)
      flushRaf()
      expect(body.scrollTop).toBe(82)
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      if (had) proto.scrollIntoView = prev
      else delete proto.scrollIntoView
    }
  })

  it('centers up symmetric to down: out-of-view rows above recenter by the same rule', () => {
    // Above: row center -18 deviates -68 from the container center 50.
    const { body, rowOf } = renderOutline('u1')
    stubRect(body, 0, 100)
    stubRect(rowOf('u1'), -30, -6)
    flushRaf()
    expect(body.scrollTop).toBe(-68)
  })

  it('keeps a visible row exactly where it is, at an edge as well as in the middle', () => {
    const { body, rowOf, rerender } = renderOutline('u1')
    stubRect(body, 0, 100)
    // Fully visible at 76..100, the bottom edge of the box: no motion.
    stubRect(rowOf('u1'), 76, 100)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // Symmetric top edge: 0..24 fully visible, still no motion.
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u3" />)
    body.scrollTop = 0
    stubRect(rowOf('u3'), 0, 24)
    flushRaf()
    expect(body.scrollTop).toBe(0)
  })

  it('reveals a row the box edge cuts, where it is not readable yet', () => {
    const { body, rowOf } = renderOutline('u1')
    stubRect(body, 0, 100)
    // 88..112 crosses the bottom edge: row center 100 vs container center 50.
    stubRect(rowOf('u1'), 88, 112)
    flushRaf()
    expect(body.scrollTop).toBe(50)
  })

  it('holds still when the active row changes inside the visible box', () => {
    const { body, rowOf, rerender } = renderOutline('u1')
    stubRect(body, 0, 100)
    stubRect(rowOf('u1'), 30, 54)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // Re-anchor inside the visible box: no recenter per turn change.
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u2" />)
    stubRect(rowOf('u2'), 40, 64)
    flushRaf()
    expect(body.scrollTop).toBe(0)
  })

  it('does not scroll a short list with no overflow', () => {
    const { body, rowOf, stubScrollable: restub } = renderOutline('u3')
    restub(100, 100)
    stubRect(body, 0, 100)
    stubRect(rowOf('u3'), 120, 144)
    flushRaf()
    expect(body.scrollTop).toBe(0)
  })

  it('keeps a short box exact too: a visible row stays put and a cut one is revealed', () => {
    // 120px box: 18..42 is fully visible, so nothing moves there either.
    const { body, rowOf, rerender } = renderOutline('u1')
    stubRect(body, 0, 120)
    stubRect(rowOf('u1'), 18, 42)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // 110..134 crosses the 120px edge: center 122 vs container center 60.
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u2" />)
    stubRect(rowOf('u2'), 110, 134)
    flushRaf()
    expect(body.scrollTop).toBe(62)
  })

  it('pauses follow on wheel input and resumes after the idle window', () => {
    const { body, rowOf, rerender } = renderOutline('u1')
    stubRect(body, 0, 100)
    stubRect(rowOf('u1'), 30, 54)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // Manual wheel interaction pauses follow: the new out-of-bounds active
    // row must not move the outline.
    fireEvent.wheel(body)
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u3" />)
    stubRect(rowOf('u3'), 120, 144)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // After the idle window follow resumes for the next anchor change.
    vi.advanceTimersByTime(1000)
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u2" />)
    stubRect(rowOf('u2'), 120, 144)
    flushRaf()
    expect(body.scrollTop).toBe(82)
  })

  it('pauses on pointer/key input, releases drag via document pointerup, and cleans up on unmount', () => {
    const { body, rowOf, rerender, unmount } = renderOutline('u1')
    stubRect(body, 0, 100)

    // Pointer drag pauses follow.
    fireEvent.pointerDown(body)
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u3" />)
    stubRect(rowOf('u3'), 120, 144)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // Drag release anywhere re-arms the idle window; expiry resumes follow.
    fireEvent.pointerUp(document)
    vi.advanceTimersByTime(1000)
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u2" />)
    stubRect(rowOf('u2'), 120, 144)
    flushRaf()
    expect(body.scrollTop).toBe(82)

    // Keyboard interaction pauses follow too.
    fireEvent.keyDown(body, { key: 'ArrowDown' })
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u1" />)
    stubRect(rowOf('u1'), 200, 224)
    flushRaf()
    expect(body.scrollTop).toBe(82)

    // Unmount clears the pending resume timer and RAF (no lingering handles).
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    flushRaf()
  })
})

describe('MessageOutline expand/collapse grace margin', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' }
  ]

  // `nav.firstElementChild` is the body: the single element that carries the
  // expanded/collapsed presentation (`data-expanded`) and the pointer handlers.
  const renderOutline = () => {
    const utils = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} />)
    const body = utils.container.querySelector('[data-testid="conversation-navigation"]')!
      .firstElementChild as HTMLElement
    return { ...utils, body }
  }

  // Fake timers stay scoped to this suite: the reading-anchor follow suite owns
  // its own timer setup, so real timers are restored after every case here.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('expands immediately on body entry, before any expand timer runs', () => {
    const { body } = renderOutline()
    expect(body.getAttribute('data-expanded')).toBe('false')

    fireEvent.mouseEnter(body)
    expect(body.getAttribute('data-expanded')).toBe('true')
  })

  it('collapses on leave only after the 160ms grace margin expires', () => {
    const { body } = renderOutline()
    fireEvent.mouseEnter(body)
    expect(body.getAttribute('data-expanded')).toBe('true')

    fireEvent.mouseLeave(body)
    // 150ms of travel slack: the panel is still expanded.
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(body.getAttribute('data-expanded')).toBe('true')

    // Past the margin the pending collapse lands.
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(body.getAttribute('data-expanded')).toBe('false')
  })

  it('cancels the pending collapse when the pointer re-enters inside the grace margin', () => {
    const { body } = renderOutline()
    fireEvent.mouseEnter(body)
    fireEvent.mouseLeave(body)

    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.mouseEnter(body)

    // Well past the margin: the canceled timer must never fire late.
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(body.getAttribute('data-expanded')).toBe('true')
  })
})

describe('MessageOutline fork markers', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' },
    { id: 'u3', text: 'Third question' }
  ]

  const bodyOf = (container: HTMLElement) =>
    container.querySelector('[data-testid="conversation-navigation"]')!.firstElementChild as HTMLElement

  // Rows sit in the measured content box: body (clip/scroll) > panel (animated
  // width) > content (intrinsic width) > rows.
  const rowListOf = (body: HTMLElement) => body.firstElementChild!.firstElementChild as HTMLElement

  const childTestIds = (body: HTMLElement) =>
    Array.from(rowListOf(body).children).map((el) => el.getAttribute('data-testid'))

  // styled-components injects component CSS into <style>; normalize whitespace
  // so serialization variants cannot false-fail, then read the geometry.
  const normalizedCss = () =>
    Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '')

  it('inserts the fork row directly AFTER the marked message row, and only there', () => {
    const { container } = render(
      <MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', 'Research branch']])} />
    )
    const body = bodyOf(container)
    // Sibling order in DOM: the marked row keeps its own row, the fork row
    // follows it, the next message row is unchanged.
    expect(childTestIds(body)).toEqual([
      'conversation-nav-item-u1',
      'conversation-nav-item-u2',
      'conversation-nav-fork',
      'conversation-nav-item-u3'
    ])
    const fork = screen.getByTestId('conversation-nav-fork')
    expect(fork.previousElementSibling?.getAttribute('data-message-id')).toBe('u2')
    expect(fork.nextElementSibling?.getAttribute('data-message-id')).toBe('u3')
    // The anchor row itself stays a normal, clickable navigation row: the
    // marker owns its own row, so the message never loses its jump target.
    const marked = screen.getByTestId('conversation-nav-item-u2')
    expect(marked.getAttribute('role')).toBe('button')
    expect(marked.getAttribute('tabindex')).toBe('0')
    // Only the marked row produces a marker.
    expect(screen.getAllByTestId('conversation-nav-fork')).toHaveLength(1)
  })

  it('keeps the fork row out of navigation: no role, ID, tab stop, handler or interactive content', () => {
    const onNavigate = vi.fn()
    render(
      <MessageOutline
        entries={ENTRIES}
        onNavigate={onNavigate}
        activeId="u2"
        forkAfter={new Map([['u2', 'Research branch']])}
      />
    )
    const fork = screen.getByTestId('conversation-nav-fork')
    expect(fork.getAttribute('role')).toBeNull()
    expect(fork.getAttribute('data-message-id')).toBeNull()
    expect(fork.getAttribute('tabindex')).toBeNull()
    // Never a highlight winner, and never announced.
    expect(fork.getAttribute('aria-current')).toBeNull()
    expect(fork.getAttribute('aria-hidden')).toBe('true')
    // The label is mounted in both states — swapping it on expansion would
    // replace its fade with a pop — so the compact marker is two dashes around a
    // clipped, transparent label, never an interactive target.
    expect(fork.children).toHaveLength(3)
    expect(fork.textContent).toBe('Research branch')
    expect(fork.querySelector('[data-outline-fork-label]')).not.toBeNull()

    fireEvent.click(fork)
    fireEvent.keyDown(fork, { key: 'Enter' })
    fireEvent.keyDown(fork, { key: ' ' })
    expect(onNavigate).not.toHaveBeenCalled()
    // The active row next to the marker is still the message row.
    expect(screen.getByTestId('conversation-nav-item-u2').getAttribute('aria-current')).toBe('true')
  })

  it('renders byte-identical DOM when nothing is marked (empty map or absent prop)', () => {
    const withEmptyMap = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map()} />)
    expect(childTestIds(bodyOf(withEmptyMap.container))).toEqual([
      'conversation-nav-item-u1',
      'conversation-nav-item-u2',
      'conversation-nav-item-u3'
    ])
    expect(screen.queryAllByTestId('conversation-nav-fork')).toHaveLength(0)
    const htmlWithEmptyMap = withEmptyMap.container.innerHTML
    withEmptyMap.unmount()

    const withoutProp = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} />)
    expect(withoutProp.container.innerHTML).toBe(htmlWithEmptyMap)
    expect(screen.queryAllByTestId('conversation-nav-fork')).toHaveLength(0)
  })

  it('sits on the dot band collapsed: 6px + a 2px gap + 6px = the 14px dot width', () => {
    render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', 'Research branch']])} />)
    const norm = normalizedCss()

    const dot = /width:(\d+)px;height:4px;background:var\(--color-border\);border-radius:2px/.exec(norm)
    const row = /height:12px;align-self:stretch;display:flex;align-items:center;gap:(\d+)px/.exec(norm)
    const segment = /width:(\d+)px;height:1px;background:var\(--color-border\);border-radius:2px/.exec(norm)
    expect(dot).not.toBeNull()
    expect(row).not.toBeNull()
    expect(segment).not.toBeNull()

    const dotWidth = Number(dot![1])
    const gap = Number(row![1])
    const dashWidth = Number(segment![1])
    expect(dashWidth).toBe(6)
    // One gap either side of the clipped label: 6 + 1 + 0 + 1 + 6 = 14.
    expect(gap).toBe(1)
    expect(norm).toContain('max-width:0;overflow:hidden')
    const markerWidth = dashWidth * 2 + gap * 2
    // Two 6px dashes a 2px visual gap apart add up to exactly the dot width, so
    // the collapsed marker still reads as part of the same rail. (The row itself
    // stays as wide as the content in both states, so the marker's own boxes do
    // not re-place themselves inside a still-open panel.)
    expect(markerWidth).toBe(14)
    expect(markerWidth).toBe(dotWidth)
    // The dash keeps the dot's own radius so it reads as part of the same rail.
    expect(norm).toContain('border-radius:2px')
  })

  it('expands into the message flow form: line + name + line at the 24px row height', () => {
    const { container } = render(
      <MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', 'Research branch']])} />
    )
    // Expanded geometry: the label is mounted in both states, so the row's rules
    // and its height are the switch, not the label's existence.
    fireEvent.mouseEnter(bodyOf(container))
    const norm = normalizedCss()

    // The message-row height and the flow's 8px gap around the name, which
    // interpolates out of the compact 1px band gap. The rules grow, so they need
    // no space-between: they own the row's two ends once the rail is wider than
    // the label.
    expect(norm).toContain('height:24px;gap:8px')
    // Both rules reserve a definite base size, then grow into whatever width
    // the row has left, with an 8px floor. The base keeps them part of the
    // row's intrinsic width (a zero-basis rule contributes nothing, so a rail
    // whose widest content was the label sized itself to the label plus the two
    // gaps and left the rules at 0px — the divider lost its lines on short
    // messages); the growth is what still draws long dividers around the name
    // on a wide message rather than two short dashes beside a wide gap; the
    // floor keeps a visible line when a capped panel has to shrink the row.
    // (Declared geometry only: jsdom performs no flex layout, so the resulting
    // pixel widths are proven by the runtime observation run, not here.)
    expect(norm).toContain('flex:118px;min-width:8px')
    expect(norm).not.toContain('flex:018px')
    expect(norm).not.toContain('flex:110;')
    // Name typography matches the flow's selected-fork label.
    expect(norm).toContain('font-size:11.5px;color:var(--color-text-2);white-space:nowrap')
  })

  it('keeps the taken branch name mounted between the two rules and only switches its clip', () => {
    const { container } = render(
      <MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', 'Research branch']])} />
    )
    const body = bodyOf(container)
    const collapsed = screen.getByTestId('conversation-nav-fork')
    // Same three children in both states: nothing is mounted or unmounted, so
    // there is no frame in which the label appears or vanishes.
    expect(collapsed.children).toHaveLength(3)
    expect(collapsed.textContent).toBe('Research branch')
    const collapsedLabel = collapsed.querySelector('[data-outline-fork-label]') as HTMLElement
    expect(collapsedLabel).not.toBeNull()
    // Declared geometry of the two states (both rules are always in the sheet):
    // compact clips the label to nothing and keeps it transparent, expanded
    // opens the clip and fades it in. The pixel result is the runtime
    // observation run's to prove.
    const norm = normalizedCss()
    expect(norm).toContain('max-width:0;overflow:hidden')
    expect(norm).toContain('max-width:320px;opacity:1')

    fireEvent.mouseEnter(body)

    const expanded = screen.getByTestId('conversation-nav-fork')
    expect(expanded.children).toHaveLength(3)
    const [leadingRule, name, trailingRule] = Array.from(expanded.children)
    expect(leadingRule.textContent).toBe('')
    expect(name.textContent).toBe('Research branch')
    expect(trailingRule.textContent).toBe('')
    expect(expanded.textContent).toBe('Research branch')
    // Expanded it is still decorative, never a navigation target.
    expect(expanded.getAttribute('aria-hidden')).toBe('true')
    expect(expanded.getAttribute('role')).toBeNull()
    expect(expanded.getAttribute('data-message-id')).toBeNull()
    expect(expanded.getAttribute('tabindex')).toBeNull()
    // The message row stays the navigation entry right above the marker.
    expect(expanded.previousElementSibling).toBe(screen.getByTestId('conversation-nav-item-u2'))
  })

  it('renders the caller-supplied fork text, including the untaken-fork count form', () => {
    const { container } = render(
      <MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', '此处有 2 条分支']])} />
    )
    const body = bodyOf(container)
    expect(screen.getByTestId('conversation-nav-fork').children).toHaveLength(3)

    fireEvent.mouseEnter(body)

    // The marker owns no text decision of its own: whatever label the caller
    // resolved (branch name or the flow's children-here form) is what renders
    // between the two rules, so a fork the route did not take is never a bare
    // line.
    const expanded = screen.getByTestId('conversation-nav-fork')
    expect(expanded.children).toHaveLength(3)
    const [, label] = Array.from(expanded.children)
    expect(label.textContent).toBe('此处有 2 条分支')
    expect(expanded.textContent).toBe('此处有 2 条分支')
    // No caret: the flow's `▾` belongs to its clickable popover trigger.
    expect(expanded.textContent).not.toContain('▾')
  })
})

describe('MessageOutline follow across the expand/collapse geometry switch', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' },
    { id: 'u3', text: 'Third question' }
  ]

  // The two delays the component owns: the collapse grace margin and the
  // geometry window the compensation holds a row's on-screen position for.
  const COLLAPSE_GRACE_MS = 160
  const EXPAND_TRANSITION_MS = 180
  // Idle window after the last manual wheel/pointer/key interaction.
  const FOLLOW_RESUME_IDLE_MS = 800

  let rafQueue: FrameRequestCallback[]
  let resizeCallbacks: ResizeObserverCallback[]

  const flushRaf = () => {
    const pending = [...rafQueue]
    rafQueue.length = 0
    for (const cb of pending) cb(0)
  }

  const rect = (top: number, bottom: number) =>
    ({
      x: 0,
      y: top,
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      toJSON: () => ({})
    }) as DOMRect

  const stubRect = (el: Element, top: number, bottom: number) => {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(top, bottom))
  }

  const stubScrollable = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  }

  /**
   * Layout model for one row: what it draws is its content-space top minus the
   * body's current scrollTop, the very relationship the compensation cancels.
   * jsdom lays nothing out, so without the model a scroll write would not move
   * anything and the drift a real transition produces could not be imitated.
   * The returned handle is mutated to imitate rows growing or shrinking.
   */
  const modelRow = (body: HTMLElement, row: HTMLElement, contentTop: number, height: number) => {
    const layout = { contentTop, height }
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
      const top = layout.contentTop - body.scrollTop
      return rect(top, top + layout.height)
    })
    return layout
  }

  const ROWS_CONTENT_TOP = 400

  /**
   * Coherent three-row layout: the rows share one height and the 4px expanded
   * gap, so a row-height change of d moves the content end by 3d while the top
   * row moves by nothing. That surplus is exactly what a row anchor cannot
   * absorb at the end of the list, and why the end itself is the reference
   * there. Returns the content height the rows add up to, so a test can address
   * the scroll end without repeating the arithmetic, plus the top row's handle.
   */
  const modelEnd = (body: HTMLElement, rowOf: (id: string) => HTMLElement, height: number) => {
    const pitch = height + 4
    const topRow = modelRow(body, rowOf('u1'), ROWS_CONTENT_TOP, height)
    modelRow(body, rowOf('u2'), ROWS_CONTENT_TOP + pitch, height)
    modelRow(body, rowOf('u3'), ROWS_CONTENT_TOP + pitch * 2, height)
    const scrollHeight = ROWS_CONTENT_TOP + pitch * 2 + height
    stubScrollable(body, scrollHeight, 100)
    return { scrollHeight, topRow }
  }

  const renderOutline = (activeId?: string) => {
    const onNavigate = vi.fn()
    const utils = render(<MessageOutline entries={ENTRIES} onNavigate={onNavigate} activeId={activeId} />)
    const body = utils.container.querySelector('[data-testid="conversation-navigation"]')!
      .firstElementChild as HTMLElement
    // A long route: the body keeps its capped height in both states, so the
    // box a ResizeObserver watches never changes size across the switch.
    stubScrollable(body, 5000, 100)
    stubRect(body, 0, 100)
    const rowOf = (id: string) => body.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    const advance = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms)
      })
    }
    return { ...utils, body, rowOf, advance, onNavigate }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    rafQueue = []
    resizeCallbacks = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback): number => {
        rafQueue.push(cb)
        return rafQueue.length
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn(() => {
        rafQueue.length = 0
      })
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          resizeCallbacks.push(cb)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds the on-screen row where it is drawn while the rows grow', () => {
    const { body, rowOf, advance } = renderOutline('u2')
    body.scrollTop = 400
    // Drawn 70px below the box top, fully visible: follow leaves it alone.
    const layout = modelRow(body, rowOf('u2'), 470, 12)
    flushRaf()
    expect(body.scrollTop).toBe(400)
    expect(rowOf('u2').getBoundingClientRect().top).toBe(70)

    fireEvent.mouseEnter(body)
    // Every row grows over the transition: the rows above the anchor push its
    // content-space top down by up to 116px and its own height doubles. Each
    // frame corrects the scroll offset, so the row keeps its 70px position and
    // never drifts out of the box.
    for (const step of [
      { contentTop: 499, height: 13.79 },
      { contentTop: 528, height: 15.43 },
      { contentTop: 557, height: 19.72 },
      { contentTop: 586, height: 24 }
    ]) {
      layout.contentTop = step.contentTop
      layout.height = step.height
      flushRaf()
      expect(Math.abs(rowOf('u2').getBoundingClientRect().top - 70)).toBeLessThan(0.51)
    }

    // The window closes on the settled geometry: still 70, not the 38px offset
    // a recenter would pick for a 24px row.
    advance(EXPAND_TRANSITION_MS)
    flushRaf()
    expect(body.scrollTop).toBe(586 - 70)
    expect(rowOf('u2').getBoundingClientRect().top).toBe(70)
  })

  it('holds the on-screen row through a collapse instead of snapping it back', () => {
    const { body, rowOf, advance } = renderOutline('u2')
    body.scrollTop = 400
    const layout = modelRow(body, rowOf('u2'), 460, 24)
    flushRaf()
    expect(body.scrollTop).toBe(400)

    fireEvent.mouseEnter(body)
    advance(EXPAND_TRANSITION_MS)
    flushRaf()
    expect(body.scrollTop).toBe(400)

    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    expect(body.getAttribute('data-expanded')).toBe('false')
    // Rows shrink back: the rows above the anchor pull its content-space top up
    // by up to 116px. The anchor keeps its 60px position throughout.
    for (const step of [
      { contentTop: 431, height: 22.21 },
      { contentTop: 402, height: 19.72 },
      { contentTop: 373, height: 15.43 },
      { contentTop: 344, height: 12 }
    ]) {
      layout.contentTop = step.contentTop
      layout.height = step.height
      flushRaf()
      expect(Math.abs(rowOf('u2').getBoundingClientRect().top - 60)).toBeLessThan(0.51)
    }

    advance(EXPAND_TRANSITION_MS)
    flushRaf()
    expect(body.scrollTop).toBe(344 - 60)
    expect(rowOf('u2').getBoundingClientRect().top).toBe(60)
  })

  it('keeps a single writer when a ResizeObserver callback lands mid-switch', () => {
    const { body, rowOf } = renderOutline('u2')
    body.scrollTop = 400
    const layout = modelRow(body, rowOf('u2'), 470, 12)
    flushRaf()

    fireEvent.mouseEnter(body)
    layout.contentTop = 528
    layout.height = 15
    flushRaf()
    expect(body.scrollTop).toBe(458)
    expect(rowOf('u2').getBoundingClientRect().top).toBe(70)

    // The body's content width changes across the switch, so the observer fires
    // once mid-transition. Its follow must not split the transition: an
    // edge-band rule would have re-centered this visible row (center 77.5).
    for (const cb of resizeCallbacks) cb([], {} as ResizeObserver)
    flushRaf()
    expect(body.scrollTop).toBe(458)
  })

  it('re-anchors a rapid reverse on the row that is on screen then', () => {
    const { body, rowOf, advance } = renderOutline('u2')
    body.scrollTop = 400
    const layout = modelRow(body, rowOf('u2'), 470, 12)
    flushRaf()

    fireEvent.mouseEnter(body)
    layout.contentTop = 500
    layout.height = 16
    flushRaf()
    expect(body.scrollTop).toBe(430)

    // Leave and come back inside the collapse transition: each switch takes a
    // fresh measurement of the row that is on screen at that moment.
    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    layout.contentTop = 440
    layout.height = 12
    flushRaf()
    expect(body.scrollTop).toBe(370)

    fireEvent.mouseEnter(body)
    layout.contentTop = 480
    layout.height = 18
    flushRaf()
    expect(body.scrollTop).toBe(410)

    // The reverse settles on the same row: the compensation ends with the
    // expanded geometry and keeps holding the position it had.
    layout.contentTop = 490
    layout.height = 24
    flushRaf()
    expect(body.scrollTop).toBe(420)
    advance(EXPAND_TRANSITION_MS)
    flushRaf()
    expect(body.scrollTop).toBe(420)
    expect(rowOf('u2').getBoundingClientRect().top).toBe(70)
  })

  it('yields the scroll to a gesture and leaves no handle behind on unmount', () => {
    const { body, rowOf, unmount } = renderOutline('u2')
    body.scrollTop = 400
    const layout = modelRow(body, rowOf('u2'), 470, 12)
    flushRaf()

    fireEvent.mouseEnter(body)
    layout.contentTop = 500
    flushRaf()
    expect(body.scrollTop).toBe(430)

    // Wheel input takes over: the compensation is dropped, so no later frame
    // writes over the reader's own scroll.
    fireEvent.wheel(body)
    const browsed = body.scrollTop
    layout.contentTop = 560
    flushRaf()
    expect(body.scrollTop).toBe(browsed)

    // A switch interrupted by unmount leaves no timer or frame behind.
    fireEvent.mouseEnter(body)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    layout.contentTop = 640
    flushRaf()
    expect(body.scrollTop).toBe(browsed)
  })

  it('holds the row in view, never the hidden active row, while the reader browses', () => {
    const { body, rowOf, advance } = renderOutline('u3')
    body.scrollTop = 400
    const browseRow = modelRow(body, rowOf('u1'), 420, 12)
    const activeRow = modelRow(body, rowOf('u3'), 432, 12)
    flushRaf()
    expect(body.scrollTop).toBe(400)

    // The reader wheels away and the reading anchor moves far down the list:
    // while the pause holds, the outline keeps the browse position.
    fireEvent.wheel(body)
    activeRow.contentTop = 1200
    fireEvent.mouseEnter(body)
    browseRow.contentTop = 478
    browseRow.height = 24
    flushRaf()
    expect(body.scrollTop).toBe(458)
    expect(rowOf('u1').getBoundingClientRect().top).toBe(20)

    // The switch does not drag the hidden anchor into view either, and the
    // compensation ends on the settled row height.
    advance(EXPAND_TRANSITION_MS)
    flushRaf()
    expect(body.scrollTop).toBe(458)

    // The deferred reveal lands only once the idle window closes.
    advance(FOLLOW_RESUME_IDLE_MS)
    flushRaf()
    expect(body.scrollTop).toBe(1156)
    expect(rowOf('u3').getBoundingClientRect().top).toBe(1200 - 1156)
  })

  it('reveals the clicked row after a quick leave, and only when the paused follow resumes', () => {
    const { body, rowOf, advance, rerender, onNavigate } = renderOutline('u1')
    stubRect(rowOf('u1'), 30, 54)
    flushRaf()
    fireEvent.mouseEnter(body)
    advance(EXPAND_TRANSITION_MS)
    stubRect(rowOf('u1'), 30, 54)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // Far upward browse inside the expanded list: wheel pauses follow.
    fireEvent.wheel(body)
    // Click a far row: the pointer interaction re-arms the idle window, the
    // caller reports the new reading anchor, and follow is paused throughout.
    fireEvent.pointerDown(rowOf('u3'))
    fireEvent.click(rowOf('u3'))
    expect(onNavigate).toHaveBeenCalledWith('u3')
    rerender(<MessageOutline entries={ENTRIES} onNavigate={onNavigate} activeId="u3" />)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // Quick leave: the collapse lands 160ms later while the pause is still
    // active, so the collapse's own reveal is held back, not dropped.
    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    expect(body.getAttribute('data-expanded')).toBe('false')
    // Settled compact geometry: the collapse's own reveal is only deferred.
    stubRect(rowOf('u1'), 30, 42)
    flushRaf()
    advance(EXPAND_TRANSITION_MS)
    flushRaf()

    // Still inside the idle window: the browse position is intact.
    advance(FOLLOW_RESUME_IDLE_MS - COLLAPSE_GRACE_MS - EXPAND_TRANSITION_MS - 100)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // The compact rail puts the clicked row out of view; the idle window then
    // closes with no rerender, no new anchor and no further interaction.
    stubRect(rowOf('u3'), 120, 144)
    advance(100)
    flushRaf()
    expect(body.scrollTop).toBe(82)
  })

  it('lands a late anchor update received while paused, not the one held at collapse time', () => {
    const { body, rowOf, advance, rerender, onNavigate } = renderOutline('u1')
    stubRect(rowOf('u1'), 30, 54)
    flushRaf()
    fireEvent.mouseEnter(body)
    advance(EXPAND_TRANSITION_MS)
    flushRaf()

    fireEvent.wheel(body)
    fireEvent.pointerDown(rowOf('u1'))
    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS + EXPAND_TRANSITION_MS)
    expect(body.getAttribute('data-expanded')).toBe('false')
    // The compact rows are the settled geometry of the collapse: its reveal is
    // deferred by the pause, not performed now.
    stubRect(rowOf('u1'), 30, 42)
    flushRaf()

    // The anchor report arrives after the collapse, while follow is paused.
    // The old anchor stays visible, so a reveal of it would not move anything.
    stubRect(rowOf('u1'), 30, 54)
    stubRect(rowOf('u2'), 120, 144)
    rerender(<MessageOutline entries={ENTRIES} onNavigate={onNavigate} activeId="u2" />)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // Resuming follows the anchor that is current now, not the captured one.
    advance(FOLLOW_RESUME_IDLE_MS)
    flushRaf()
    expect(body.scrollTop).toBe(82)
  })

  it('keeps a paused browse position when only the row list changes', () => {
    const { body, rowOf, advance, rerender, onNavigate } = renderOutline('u2')
    stubRect(rowOf('u2'), 30, 54)
    flushRaf()
    fireEvent.mouseEnter(body)
    advance(EXPAND_TRANSITION_MS)
    flushRaf()

    fireEvent.wheel(body)
    // Callers hand down a fresh entries array on every render (streaming
    // tokens included): a row-list change must not arm a reveal while the user
    // is browsing the outline.
    rerender(<MessageOutline entries={ENTRIES.map((entry) => ({ ...entry }))} onNavigate={onNavigate} activeId="u2" />)
    stubRect(rowOf('u2'), 120, 144)
    advance(FOLLOW_RESUME_IDLE_MS * 2)
    flushRaf()
    expect(body.scrollTop).toBe(0)
  })

  it('holds the end of the list through an expansion, so the last row stays whole and the grown range is reached', () => {
    const { body, rowOf } = renderOutline('u2')
    // The compact end: the last row sits exactly on the body's bottom edge.
    const compact = modelEnd(body, rowOf, 12)
    body.scrollTop = compact.scrollHeight - 100
    flushRaf()
    expect(body.scrollTop).toBe(compact.scrollHeight - 100)
    expect(rowOf('u3').getBoundingClientRect().bottom).toBeCloseTo(100, 5)

    fireEvent.mouseEnter(body)
    // Every row grows, so the content end moves three times as far as any one
    // row top: holding the end lets the scroll range grow to where the rows
    // actually end, instead of stopping a row short with the last row sliced by
    // the box edge.
    for (const height of [13.79, 19.43, 24]) {
      const frame = modelEnd(body, rowOf, height)
      flushRaf()
      expect(body.scrollTop).toBeCloseTo(frame.scrollHeight - 100, 5)
      expect(rowOf('u3').getBoundingClientRect().bottom).toBeCloseTo(100, 5)
    }

    // Settled: the grown range is reached and the row the reader was looking at
    // is still whole, so the reveal the switch hands back leaves it alone.
    expect(body.scrollTop).toBeCloseTo(480 - 100, 5)
    expect(rowOf('u2').getBoundingClientRect().top).toBeCloseTo(48, 5)
    expect(rowOf('u2').getBoundingClientRect().bottom).toBeCloseTo(72, 5)
  })

  it('holds the end through the collapse and lands back on the compact scroll end', () => {
    const { body, rowOf, advance } = renderOutline('u2')
    // Expanded and at the end: the growth is over and the last row is whole.
    const expanded = modelEnd(body, rowOf, 24)
    body.scrollTop = expanded.scrollHeight - 100
    fireEvent.mouseEnter(body)
    flushRaf()
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(body.scrollTop).toBeCloseTo(expanded.scrollHeight - 100, 5)

    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    expect(body.getAttribute('data-expanded')).toBe('false')
    // Rows shrink, so the content end rises frame by frame: the end distance
    // stays held and the last row keeps its bottom on the box edge.
    for (const height of [19.43, 13.79, 12]) {
      const frame = modelEnd(body, rowOf, height)
      flushRaf()
      expect(body.scrollTop).toBeCloseTo(frame.scrollHeight - 100, 5)
      expect(rowOf('u3').getBoundingClientRect().bottom).toBeCloseTo(100, 5)
    }

    // The compact rail lands exactly on its own scroll end, with the row the
    // reader was looking at still whole and not re-centered.
    advance(EXPAND_TRANSITION_MS)
    flushRaf()
    expect(body.scrollTop).toBeCloseTo(444 - 100, 5)
    expect(rowOf('u3').getBoundingClientRect().bottom).toBeCloseTo(100, 5)
    expect(rowOf('u2').getBoundingClientRect().top).toBeCloseTo(72, 5)
  })

  it('keeps a near-end browse position on its row anchor, where the reader is not at the end', () => {
    const { body, rowOf, advance } = renderOutline('u1')
    // A row and a half short of the end: a browse position inside the last page,
    // not the end of the list. The top row is above the growth, so the row
    // anchor holds it by leaving the scroll offset alone.
    const compact = modelEnd(body, rowOf, 12)
    body.scrollTop = compact.scrollHeight - 118
    flushRaf()
    expect(body.scrollTop).toBe(compact.scrollHeight - 118)
    const anchoredTop = rowOf('u1').getBoundingClientRect().top
    expect(anchoredTop).toBeCloseTo(74, 5)

    fireEvent.mouseEnter(body)
    for (const height of [13.79, 19.43, 24]) {
      const frame = modelEnd(body, rowOf, height)
      flushRaf()
      // The scroll never goes to the end: the end is the reference only for a
      // reader who is actually there.
      expect(body.scrollTop).toBe(compact.scrollHeight - 118)
      expect(body.scrollTop).not.toBeCloseTo(frame.scrollHeight - 100, 5)
      expect(rowOf('u1').getBoundingClientRect().top).toBeCloseTo(anchoredTop, 5)
    }

    // Settled: the row grew into the space its held top leaves free, still
    // whole, and the browse position is untouched.
    advance(EXPAND_TRANSITION_MS)
    flushRaf()
    expect(body.scrollTop).toBe(compact.scrollHeight - 118)
    expect(rowOf('u1').getBoundingClientRect().bottom).toBeCloseTo(anchoredTop + 24, 5)
  })
})

describe('MessageOutline single reversible compact/expanded transition', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' },
    { id: 'u3', text: 'Third question' }
  ]
  const COLLAPSE_GRACE_MS = 160

  let rafQueue: FrameRequestCallback[]
  let resizeCallbacks: ResizeObserverCallback[]

  const flushRaf = () => {
    const pending = [...rafQueue]
    rafQueue.length = 0
    for (const cb of pending) cb(0)
  }

  // jsdom lays nothing out: give one element the box the test needs to see.
  const stubBox = (el: Element, top: number, bottom: number, width = 0) =>
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: top,
      top,
      bottom,
      left: 0,
      right: width,
      width,
      height: bottom - top,
      toJSON: () => ({})
    } as DOMRect)

  // The reserved scrollbar gutter is what the body's offset/client boxes differ
  // by (it has no border), and jsdom reports both as 0.
  const stubGutter = (el: HTMLElement, gutter: number) => {
    Object.defineProperty(el, 'offsetWidth', { value: 34, configurable: true })
    Object.defineProperty(el, 'clientWidth', { value: 34 - gutter, configurable: true })
  }

  const renderOutline = (activeId?: string) => {
    const utils = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId={activeId} />)
    const nav = utils.container.querySelector('[data-testid="conversation-navigation"]') as HTMLElement
    const body = nav.firstElementChild as HTMLElement
    const panel = screen.getByTestId('conversation-nav-panel')
    const content = panel.firstElementChild as HTMLElement
    const rowOf = (id: string) => body.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    const advance = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms)
      })
    }
    return { ...utils, nav, body, panel, content, rowOf, advance }
  }

  const stubScrollable = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    rafQueue = []
    resizeCallbacks = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback): number => {
        rafQueue.push(cb)
        return rafQueue.length
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn(() => {
        rafQueue.length = 0
      })
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          resizeCallbacks.push(cb)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens to the width its own content needs, not a state swap', () => {
    const { nav, body, panel, content } = renderOutline()
    // Compact: the panel is exactly the dot column, whatever the text needs.
    expect(panel.style.width).toBe('18px')

    // A 400px reading column, a 6px reserved scrollbar gutter and the body's own
    // 10px padding either side: 320 - 20 - 6 is what the panel may use.
    stubBox(nav, 0, 100, 400)
    stubBox(content, 0, 100, 200)
    stubGutter(body, 6)
    fireEvent.mouseEnter(body)
    // Measured before paint: the first frame already animates to 200px.
    expect(panel.style.width).toBe('200px')
    expect(content.style.maxWidth).toBe('294px')
  })

  it('caps a long preview at the reading column instead of one fixed width', () => {
    const { nav, body, panel, content } = renderOutline()
    stubBox(nav, 0, 100, 400)
    stubBox(content, 0, 100, 900)
    stubGutter(body, 6)
    fireEvent.mouseEnter(body)
    expect(panel.style.width).toBe('294px')

    // A narrower reading column lowers the cap the same content is measured
    // against, and the panel follows it: 300 - 24 - 20 - 6.
    stubBox(nav, 0, 100, 300)
    act(() => {
      for (const cb of resizeCallbacks) cb([], {} as ResizeObserver)
    })
    expect(panel.style.width).toBe('250px')
    expect(content.style.maxWidth).toBe('250px')
  })

  it('turns a mid-collapse re-entry around at once, on the same single target', () => {
    const { nav, body, panel, content, advance } = renderOutline()
    stubBox(nav, 0, 100, 400)
    stubBox(content, 0, 100, 200)
    fireEvent.mouseEnter(body)
    expect(panel.style.width).toBe('200px')

    // The grace expires and the collapse lands: the panel's own target is the
    // compact rail again, and the running width transition heads there.
    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    expect(body.getAttribute('data-expanded')).toBe('false')
    expect(panel.style.width).toBe('18px')

    // Re-enter while the collapse is still on screen: expansion is immediate and
    // the target is the same single measured width again — the transition turns
    // around from the width that is drawn right now, because the width it is
    // heading for is the only state there is.
    fireEvent.mouseEnter(body)
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(panel.style.width).toBe('200px')

    // Nothing was held back waiting for the collapse to finish.
    advance(1000)
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(panel.style.width).toBe('200px')
  })

  it('declares one timeline for width, rows, fades and chrome — and none under reduced motion', () => {
    const { content } = renderOutline()
    expect(content.style.maxWidth).toBe('')
    const norm = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '')
    // Width, rows, gap, text fade, chrome: the same 180ms ease-out.
    expect(norm).toContain('transition:width180msease-out')
    expect(norm).toContain('transition:height180msease-out')
    expect(norm).toContain('gap180msease-out')
    expect(norm).toContain('opacity180msease-out')
    expect(norm).toContain('background-color180msease-out')
    // Neither the text nor the fork label is display-swapped, so neither can pop.
    expect(norm).not.toContain('display:none')
    // Reduced motion drops every one of them, so the switch settles at once.
    expect(norm).toContain('@media(prefers-reduced-motion:reduce)')
    expect(norm).toContain('transition:none')
  })

  it('settles a reduced-motion switch at once, with no settle wait armed', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false
    }))
    const { nav, body, content, rowOf } = renderOutline('u2')
    stubBox(nav, 0, 100, 400)
    stubBox(content, 0, 100, 200)
    stubBox(body, 0, 100)
    stubBox(rowOf('u2'), 30, 54)
    stubScrollable(body, 5000, 100)

    fireEvent.mouseEnter(body)
    expect(body.getAttribute('data-expanded')).toBe('true')
    // The switch is settled in the frame it was applied: nothing waits for a
    // transition that will never run. (The animated path arms its 680ms settle
    // fallback at this exact point.)
    expect(vi.getTimerCount()).toBe(0)
    flushRaf()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('MessageOutline scrollbar paint across the width transition', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' },
    { id: 'u3', text: 'Third question' }
  ]
  const COLLAPSE_GRACE_MS = 160
  const EXPAND_TRANSITION_MS = 180
  // The reveal waits out the switch's own timeline plus one frame of slack.
  const REVEAL_MS = EXPAND_TRANSITION_MS + 16

  const renderOutline = () => {
    const utils = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} />)
    const nav = utils.container.querySelector('[data-testid="conversation-navigation"]') as HTMLElement
    const body = nav.firstElementChild as HTMLElement
    const advance = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms)
      })
    }
    const scrollbar = () => body.getAttribute('data-outline-scrollbar')
    return { ...utils, nav, body, advance, scrollbar }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('withholds the scrollbar for the whole width transition and reveals it on the settled edge', () => {
    const { body, advance, scrollbar } = renderOutline()
    // Compact paints no scrollbar at all (the body clips with overflow hidden).
    expect(scrollbar()).toBe('hidden')

    fireEvent.mouseEnter(body)
    // Opening starts at the compact rail: a painted bar here would materialize
    // at the narrow left edge and be carried across the panel.
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(scrollbar()).toBe('hidden')

    // The width is still changing, so the edge the bar sits on is still moving.
    advance(EXPAND_TRANSITION_MS)
    expect(scrollbar()).toBe('hidden')

    // Settled at its final width: the bar appears where it belongs.
    advance(REVEAL_MS - EXPAND_TRANSITION_MS)
    expect(scrollbar()).toBe('visible')
  })

  it('drops the scrollbar in the commit that starts a collapse, and never re-reveals it while compact', () => {
    const { body, advance, scrollbar } = renderOutline()
    fireEvent.mouseEnter(body)
    advance(REVEAL_MS)
    expect(scrollbar()).toBe('visible')

    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    // The collapse's first frame: the panel starts narrowing with the bar
    // already gone, so nothing slides left with it.
    expect(body.getAttribute('data-expanded')).toBe('false')
    expect(scrollbar()).toBe('hidden')

    // A pending reveal must not survive into the compact rail.
    advance(1000)
    expect(scrollbar()).toBe('hidden')
  })

  it('restarts the window on a reversal, so no stale reveal paints a moving edge', () => {
    const { body, advance, scrollbar } = renderOutline()
    fireEvent.mouseEnter(body)
    advance(20)
    expect(scrollbar()).toBe('hidden')

    // Leave early: the collapse lands at 180ms, i.e. before the reveal armed by
    // the opening (196ms) would have fired.
    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    expect(body.getAttribute('data-expanded')).toBe('false')

    // The dropped window must not fire into the collapsed rail.
    advance(REVEAL_MS - 20 - COLLAPSE_GRACE_MS)
    expect(scrollbar()).toBe('hidden')

    // Re-entering starts a fresh window instead of inheriting the old one's.
    fireEvent.mouseEnter(body)
    expect(scrollbar()).toBe('hidden')
    advance(REVEAL_MS - 1)
    expect(scrollbar()).toBe('hidden')
    advance(1)
    expect(scrollbar()).toBe('visible')
  })

  it('reveals a reduced-motion switch in the same commit, with no timer left to fire', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false
    }))
    const { body, scrollbar } = renderOutline()
    fireEvent.mouseEnter(body)
    // No transition runs, so there is no moving edge to hide the bar from and
    // nothing to wait out: settled in the frame the switch is applied.
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(scrollbar()).toBe('visible')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('scopes the withheld paint to this body instead of the shared scrollbar', () => {
    const { body } = renderOutline()
    const norm = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '')
    const withheld = norm.match(/[^{}]*\[data-outline-scrollbar='hidden'\][^{]*\{[^}]*\}/g) ?? []
    expect(withheld).toHaveLength(1)
    const rule = withheld[0] ?? ''
    // Element-scoped: the selector is this body's own class, never a bare
    // `::-webkit-scrollbar` override that would reach every other scrollbar.
    expect(Array.from(body.classList).some((name) => rule.includes(`.${name}[data-outline-scrollbar`))).toBe(true)
    // Both the paint and the shared component's 2s fade are dropped, so the bar
    // is gone in the frame the switch starts rather than fading across it.
    expect(rule).toContain('background:transparent')
    expect(rule).toContain('transition:none')
  })
})
