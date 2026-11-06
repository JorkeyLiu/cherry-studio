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
    const rows = Array.from(body!.querySelectorAll(':scope > div[data-message-id]'))
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
    const rows = Array.from(nav!.firstElementChild!.querySelectorAll(':scope > div[data-message-id]'))
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

  it('leaves the outline scroll alone when the active row rests in the safe zone', () => {
    const { body, rowOf } = renderOutline('u2')
    stubRect(body, 0, 100)
    // Row center 42 sits inside the safe band (36..64: the 1.5-row floor
    // dominates 20% on a 100px box): no motion.
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

  it('follows early when a still-visible row nears the edge band', () => {
    const { body, rowOf, rerender } = renderOutline('u1')
    stubRect(body, 0, 100)
    // Visible (60..84) but center 72 sits outside the 20..80 safe zone:
    // deviate +22 from container center 50.
    stubRect(rowOf('u1'), 60, 84)
    flushRaf()
    expect(body.scrollTop).toBe(22)

    // Symmetric top band: center 12 deviates -38 from container center 50.
    rerender(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u3" />)
    body.scrollTop = 0
    stubRect(rowOf('u3'), 0, 24)
    flushRaf()
    expect(body.scrollTop).toBe(-38)
  })

  it('holds still when the active row crosses the middle without touching the bands', () => {
    const { body, rowOf, rerender } = renderOutline('u1')
    stubRect(body, 0, 100)
    stubRect(rowOf('u1'), 30, 54)
    flushRaf()
    expect(body.scrollTop).toBe(0)

    // Re-anchor inside the safe zone: no recenter per turn change.
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

  it('keeps a 1.5-row edge band even when 20% of the container is smaller', () => {
    // 120px container: 20% = 24 < 1.5-row floor 36, so the safe band is
    // 36..84 and a row centered at 30 follows early.
    const { body, rowOf } = renderOutline('u1')
    stubRect(body, 0, 120)
    stubRect(rowOf('u1'), 18, 42)
    flushRaf()
    // Center 30 vs container center 60: deviate -30.
    expect(body.scrollTop).toBe(-30)
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

  const childTestIds = (body: HTMLElement) => Array.from(body.children).map((el) => el.getAttribute('data-testid'))

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

  it('keeps the fork row out of navigation: no role, ID, tab stop, handler or text', () => {
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
    // Collapsed the marker is two dashes only: the name exists for this fork,
    // so an empty textContent proves the collapsed state renders no text at
    // all — not a hidden-but-present label.
    expect(fork.children).toHaveLength(2)
    expect(fork.textContent).toBe('')

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

  it('sits on the dot band collapsed: 6px + 2px gap + 6px = the 14px dot width', () => {
    render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', 'Research branch']])} />)
    const norm = normalizedCss()

    const dot = /width:(\d+)px;height:4px;background:var\(--color-border\);border-radius:2px/.exec(norm)
    const row = /height:12px;width:(\d+)px;align-self:flex-start;display:flex;align-items:center;gap:(\d+)px/.exec(norm)
    const segment = /width:(\d+)px;height:1px;background:var\(--color-border\);border-radius:2px/.exec(norm)
    expect(dot).not.toBeNull()
    expect(row).not.toBeNull()
    expect(segment).not.toBeNull()

    const dotWidth = Number(dot![1])
    const markerWidth = Number(row![1])
    const gap = Number(row![2])
    const dashWidth = Number(segment![1])
    expect(dashWidth).toBe(6)
    expect(gap).toBe(2)
    // Two 6px dashes with the 2px gap add up to exactly the row width.
    expect(dashWidth * 2 + gap).toBe(14)
    expect(markerWidth).toBe(14)
    // ... and the row is exactly as wide as the dot it replaces in the band.
    expect(markerWidth).toBe(dotWidth)
    // The dash keeps the dot's own radius so it reads as part of the same rail.
    expect(norm).toContain('border-radius:2px')
  })

  it('expands into the message flow form: line + name + line at the 24px row height', () => {
    const { container } = render(
      <MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', 'Research branch']])} />
    )
    // Expanded, because the name element (and therefore its rule) exists only
    // while the taken branch name is actually rendered.
    fireEvent.mouseEnter(bodyOf(container))
    const norm = normalizedCss()

    // The message-row height, the full content width, and the flow's 8px gap
    // around the name.
    expect(norm).toContain('height:24px;width:auto;align-self:stretch;gap:8px')
    // Two equal rules: `flex: 1 1 0` on both dashes.
    expect(norm).toContain('flex:110')
    // Name typography matches the flow's selected-fork label.
    expect(norm).toContain('font-size:11.5px;color:var(--color-text-2);white-space:nowrap')
  })

  it('reveals the taken branch name only while expanded, between the two rules', () => {
    const { container } = render(
      <MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', 'Research branch']])} />
    )
    const body = bodyOf(container)
    const collapsed = screen.getByTestId('conversation-nav-fork')
    expect(collapsed.children).toHaveLength(2)
    expect(collapsed.textContent).toBe('')

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
    expect(screen.getByTestId('conversation-nav-fork').children).toHaveLength(2)

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
