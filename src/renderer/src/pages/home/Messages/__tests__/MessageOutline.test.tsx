import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  )
}))

import MessageOutline from '../MessageOutline'

/**
 * The navigator body: the container's only element child is the hover halo, and
 * the halo's only element child is the body — the box whose collapse/expand
 * state, pointer target and scroll geometry these cases are about.
 */
const outlineBody = (nav: Element | null | undefined) => nav?.firstElementChild?.firstElementChild as HTMLElement

describe('MessageOutline restored original presentation', () => {
  it('renders caller entries in the Container > Halo > Body > Item div hierarchy', () => {
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
    // The halo is the pointer surface and the body is its only element child, so
    // the rail is wrapped in nothing that paints, clips or re-sizes it.
    const halo = nav!.firstElementChild
    expect(halo?.getAttribute('data-testid')).toBe('conversation-nav-hitzone')
    const body = outlineBody(nav)
    expect(body).not.toBeNull()
    expect(body.parentElement).toBe(halo)
    // Rows are the content box's children (body > panel > content); the
    // hierarchy the test checks is the row itself.
    const rows = Array.from(body.querySelectorAll('div[data-message-id]'))
    expect(rows.map((row) => row.getAttribute('data-message-id'))).toEqual(['u1', 'u2'])
    for (const row of rows) {
      expect(row.querySelectorAll(':scope > div').length).toBe(2)
    }
    expect(screen.getByTestId('conversation-nav-item-u1').textContent).toContain('First question')
  })

  it('navigates by stable ID on click and keyboard', () => {
    vi.useFakeTimers()
    try {
      const onNavigate = vi.fn()
      const { container } = render(
        <MessageOutline entries={[{ id: 'u9', text: 'Only question' }]} onNavigate={onNavigate} />
      )
      const body = outlineBody(container.querySelector('[data-testid="conversation-navigation"]'))

      const item = screen.getByTestId('conversation-nav-item-u9')
      expect(item.getAttribute('title')).toBe('Only question')
      // Keyboard activation is independent of the pointer gate: it works on the
      // compact rail, before anything has expanded.
      fireEvent.keyDown(item, { key: 'Enter' })
      expect(onNavigate).toHaveBeenCalledWith('u9')
      fireEvent.keyDown(item, { key: ' ' })
      expect(onNavigate).toHaveBeenCalledTimes(2)

      // A pointer click belongs to the settled switch: the rows only take the
      // pointer once the width transition is over.
      fireEvent.mouseEnter(body)
      act(() => {
        vi.advanceTimersByTime(196)
      })
      fireEvent.click(item)
      expect(onNavigate).toHaveBeenCalledTimes(3)
      expect(onNavigate).toHaveBeenLastCalledWith('u9')
    } finally {
      vi.useRealTimers()
    }
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
    // The two caps live on the body's hover halo, grown by its ring on each side.
    expect(norm).toContain('max-width:calc(min(320px,calc(100%-24px))+20px)')
    expect(norm).toContain('max-height:calc(min(100%,45vh,420px)+20px)')
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
    // Caps and interaction invariants still hold: the caps sit on the halo.
    expect(norm).toContain('max-width:calc(min(320px,calc(100%-24px))+20px)')
    expect(norm).toContain('max-height:calc(min(100%,45vh,420px)+20px)')
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
    const body = outlineBody(utils.container.querySelector('[data-testid="conversation-navigation"]'))
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

  it('marks only the active row with aria-current, primary text and a primary dash — never a background chip', () => {
    // Corrected current-row form: primary green text at a stable 500 weight,
    // and the current dash itself takes primary. The collapsed rail reads
    // the dots alone, so without the dash rule the current row was
    // indistinguishable there (user-reported: all-gray dashes, no green
    // mark). The weight never animates, so switching the current row cannot
    // jitter the measured panel width. The row itself carries no background
    // chip — expanded the dots are fully transparent, so the open panel's
    // current stays text-only.
    renderOutline('u2')
    expect(screen.getByTestId('conversation-nav-item-u2').getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('conversation-nav-item-u1').getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('conversation-nav-item-u3').getAttribute('aria-current')).toBeNull()

    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
    const norm = css.replace(/\s+/g, '')
    expect(norm).toContain('color:var(--color-primary)')
    expect(norm).toContain('font-weight:500')
    expect(norm).toContain('background:var(--color-primary)')
    // No chip on the row itself: its own background stays fully transparent.
    // The dash tint is covered by the stylesheet assertion above.
    const activeRow = screen.getByTestId('conversation-nav-item-u2')
    expect(getComputedStyle(activeRow).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    // The dash tint itself is stylesheet-level evidence above: jsdom cannot
    // resolve var() colors to a computed value (both dashes compute to
    // transparent here), so the visible green-vs-gray difference is left to
    // the Electron observation run, not claimed from this suite.
  })

  it('keeps the active text primary under row hover; hover brightens text only', () => {
    // Approved hover form: the settled switch brightens the hovered row's
    // text alone (neutral, no background chip and no hover dot recolor — the
    // only primary dash is the current row's own), and a hovered current row
    // stays on its primary color. The plain active rule loses to the generic
    // hover rule on specificity, so the current row carries its own
    // aria-current hover rule — exactly the two primary-text rules below.
    renderOutline('u2')
    const css = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
    const norm = css.replace(/\s+/g, '')
    const primaryTexts = norm.match(/color:var\(--color-primary\)/g) ?? []
    expect(primaryTexts.length).toBeGreaterThanOrEqual(2)
    // Neutral hover for non-current rows; the idle dot keeps its border fill
    // while the current row's dash carries the primary rule restored above.
    expect(norm).toContain('color:var(--color-text-1)')
    expect(norm).toContain('background:var(--color-primary)')
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

  // The halo's child is the body: the single element that carries the
  // expanded/collapsed presentation (`data-expanded`) and the pointer handlers.
  const renderOutline = () => {
    const utils = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} />)
    const body = outlineBody(utils.container.querySelector('[data-testid="conversation-navigation"]'))
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

describe('MessageOutline textless dividers', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' },
    { id: 'u3', text: 'Third question' }
  ]

  const bodyOf = (container: HTMLElement) =>
    outlineBody(container.querySelector('[data-testid="conversation-navigation"]'))

  // Rows sit in the measured content box: body (clip/scroll) > panel (animated
  // width) > content (intrinsic width) > rows. The group overlay mounts first
  // and stays mounted, so every row list below starts with it.
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

  it('inserts the fork divider directly AFTER the marked message row, and only there', () => {
    const { container } = render(
      <MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', 'Research branch']])} />
    )
    const body = bodyOf(container)
    // Sibling order in DOM: the group overlay, the marked row keeps its own
    // row, the divider follows it, the next message row is unchanged.
    expect(childTestIds(body)).toEqual([
      'conversation-nav-group-overlay',
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

  it('keeps the fork divider out of navigation: no role, ID, tab stop, handler or painted text', () => {
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
    // Approved textless form: the caller label is the accessible and hover
    // name only — nothing paints. The one child is the 1px rule, so width
    // measurement never sees a word.
    expect(fork.children).toHaveLength(1)
    expect(fork.textContent).toBe('')
    expect(fork.getAttribute('title')).toBe('Research branch')
    expect(fork.getAttribute('aria-label')).toBe('Research branch')

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
      'conversation-nav-group-overlay',
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

  it('draws a fixed 16px textless row: a 60% 1px rule, solid clear and dashed lighter', () => {
    // Both variants mount so both interpolated rules are in the sheet.
    render(
      <MessageOutline
        entries={ENTRIES}
        onNavigate={vi.fn()}
        forkAfter={new Map([['u2', 'Research branch']])}
        contextRowId="u1"
      />
    )
    const norm = normalizedCss()

    // The open row keeps its fixed 8px height with -2px top/bottom margins —
    // it is spacing, never a message row — and centers the single rule at 60%
    // of the usable width, short of the text span so the line never reads as
    // long as the text. Footprint: 8 - 4 + 8 gaps = 12px total block.
    expect(norm).toContain('height:8px')
    expect(norm).toContain('width:60%')
    // The context solid is the clearer of the two dividers (message-flow
    // form, ~0.6): a real 1px-high painted line.
    expect(norm).toContain('height:1px;background:var(--color-text-3)')
    // The fork dashed is lighter (~0.4): a 1px dashed top border.
    expect(norm).toContain('border-top:1pxdashedvar(--color-text-3)')
    expect(norm).toContain('opacity:0.6')
    expect(norm).toContain('opacity:0.4')
    // The dot column itself is untouched: still the 14px rail mark.
    expect(norm).toContain('width:14px;height:4px;background:var(--color-border);border-radius:2px')
    // No painted label anywhere in the new form: the old 11.5px fork name is
    // gone, and no divider grows or clips text on the switch.
    expect(norm).not.toContain('font-size:11.5px')
    expect(norm).not.toContain('max-width:320px;opacity:1')
  })

  it('keeps the caller label in title and accessible name only, in both states', () => {
    const { container } = render(
      <MessageOutline entries={ENTRIES} onNavigate={vi.fn()} forkAfter={new Map([['u2', '此处有 2 条分支']])} />
    )
    const body = bodyOf(container)
    const collapsed = screen.getByTestId('conversation-nav-fork')
    // One child in both states: nothing is mounted or unmounted, so there is
    // no frame in which a label appears or vanishes.
    expect(collapsed.children).toHaveLength(1)
    expect(collapsed.textContent).toBe('')
    expect(collapsed.getAttribute('title')).toBe('此处有 2 条分支')
    expect(collapsed.getAttribute('aria-label')).toBe('此处有 2 条分支')

    fireEvent.mouseEnter(body)

    const expanded = screen.getByTestId('conversation-nav-fork')
    expect(expanded.children).toHaveLength(1)
    expect(expanded.textContent).toBe('')
    expect(expanded.getAttribute('title')).toBe('此处有 2 条分支')
    // No caret: the flow's `▾` belongs to its clickable popover trigger.
    expect(expanded.getAttribute('title')).not.toContain('▾')
    // Expanded it is still decorative, never a navigation target.
    expect(expanded.getAttribute('aria-hidden')).toBe('true')
    expect(expanded.getAttribute('role')).toBeNull()
    expect(expanded.getAttribute('data-message-id')).toBeNull()
    expect(expanded.getAttribute('tabindex')).toBeNull()
    // The message row stays the navigation entry right above the marker.
    expect(expanded.previousElementSibling).toBe(screen.getByTestId('conversation-nav-item-u2'))
  })

  it('draws the context divider directly ABOVE the mapped row, as a solid rule', () => {
    // The caller resolves the accepted boundary to an outline row; the solid
    // divider sits above that row — beside the DOM-before anchor, the way the
    // message flow draws it above its own anchor.
    const { container } = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} contextRowId="u2" />)
    const body = bodyOf(container)
    expect(childTestIds(body)).toEqual([
      'conversation-nav-group-overlay',
      'conversation-nav-item-u1',
      'conversation-nav-context',
      'conversation-nav-item-u2',
      'conversation-nav-item-u3'
    ])
    const divider = screen.getByTestId('conversation-nav-context')
    expect(divider.getAttribute('data-divider')).toBe('context')
    expect(divider.getAttribute('aria-hidden')).toBe('true')
    expect(divider.children).toHaveLength(1)
    expect(divider.textContent).toBe('')
    expect(divider.nextElementSibling).toBe(screen.getByTestId('conversation-nav-item-u2'))
    expect(divider.previousElementSibling).toBe(screen.getByTestId('conversation-nav-item-u1'))
  })

  it('mounts the group overlay once, with one node link per run', () => {
    // Geometry itself is proven by the navGroupRuns unit tests and the
    // runtime observation run (jsdom performs no layout, so line/circle
    // attributes stay at their hidden mounts here); what this case pins is
    // the wiring: one node link per run, carrying the run's group color on
    // the single low-contrast 1px stroke, a non-scaling stroke so a resized
    // viewport never distorts it, and hollow end nodes filled with the panel
    // surface so the line never shows through. A multi-row run paints one
    // line plus exactly two end nodes (no middle nodes, no hooks); a
    // single-row run paints exactly one node and no line. The SVG carries
    // no viewBox: user units are CSS px aligned to the content box.
    render(
      <MessageOutline
        entries={ENTRIES}
        onNavigate={vi.fn()}
        groupRuns={[
          { segmentId: 's1', color: '#1a2b3c', rowIds: ['u1', 'u2'], lane: 0 },
          { segmentId: 's2', color: '#4d5e6f', rowIds: ['u3'], lane: 0 }
        ]}
      />
    )
    const overlay = screen.getByTestId('conversation-nav-group-overlay')
    expect(overlay.tagName).toBe('svg')
    expect(overlay.getAttribute('viewBox')).toBeNull()
    expect(overlay.querySelectorAll('path[data-group-run]')).toHaveLength(0)
    const groups = overlay.querySelectorAll('g[data-group-run]')
    expect(Array.from(groups).map((g) => g.getAttribute('data-group-run'))).toEqual(['s1', 's2'])
    const multi = groups[0]
    expect(multi.getAttribute('stroke')).toBe('#1a2b3c')
    expect(multi.getAttribute('stroke-opacity')).toBe('0.7')
    expect(multi.getAttribute('stroke-width')).toBe('1')
    const lines = multi.querySelectorAll('line[data-group-run-line]')
    expect(lines).toHaveLength(1)
    expect(lines[0].getAttribute('vector-effect')).toBe('non-scaling-stroke')
    const multiNodes = multi.querySelectorAll('circle[data-group-run-node]')
    expect(multiNodes).toHaveLength(2)
    for (const node of multiNodes) {
      expect(node.getAttribute('r')).toBe('2.5')
      expect(node.getAttribute('fill')).toBe('var(--color-background)')
      expect(node.getAttribute('vector-effect')).toBe('non-scaling-stroke')
    }
    // Single-row run: exactly one hollow node, never a doubled pair, no line.
    const single = groups[1]
    expect(single.querySelectorAll('line[data-group-run-line]')).toHaveLength(0)
    const singleNodes = single.querySelectorAll('circle[data-group-run-node]')
    expect(singleNodes).toHaveLength(1)
    expect(singleNodes[0].getAttribute('r')).toBe('2.5')
    expect(singleNodes[0].getAttribute('fill')).toBe('var(--color-background)')
    const norm = normalizedCss()
    expect(norm).toContain('vector-effect:non-scaling-stroke')
  })

  it('compresses divider rows to zero when collapsed: no blank bands in the dot column', () => {
    const { container } = render(
      <MessageOutline
        entries={ENTRIES}
        onNavigate={vi.fn()}
        forkAfter={new Map([['u2', 'Research branch']])}
        contextRowId="u1"
      />
    )
    const body = bodyOf(container)
    expect(body.getAttribute('data-expanded')).toBe('false')
    // Both divider rows hold no height with -1px margins and clip their rule:
    // collapsed they add 0 extra beyond the ordinary 2px gap (0 - 2 + 4 - 2),
    // never a blank band.
    for (const testId of ['conversation-nav-fork', 'conversation-nav-context']) {
      const divider = screen.getByTestId(testId)
      expect(getComputedStyle(divider).height).toBe('0px')
      expect(getComputedStyle(divider).overflow).toBe('hidden')
      expect(getComputedStyle(divider).opacity).toBe('0')
    }
    // The user rows keep the compact 12px rhythm around them.
    for (const row of ['u1', 'u2', 'u3']) {
      expect(getComputedStyle(screen.getByTestId(`conversation-nav-item-${row}`)).height).toBe('12px')
    }
    // The group overlay is an absolute layer: it never takes flex space, in
    // either state.
    expect(getComputedStyle(screen.getByTestId('conversation-nav-group-overlay')).position).toBe('absolute')

    // Expanded the dividers return to their 8px rule rows with -2px margins;
    // collapsing again restores zero with the same DOM — no mount swap.
    fireEvent.mouseEnter(body)
    expect(body.getAttribute('data-expanded')).toBe('true')
    for (const testId of ['conversation-nav-fork', 'conversation-nav-context']) {
      expect(getComputedStyle(screen.getByTestId(testId)).height).toBe('8px')
      expect(getComputedStyle(screen.getByTestId(testId)).opacity).toBe('1')
    }
    expect(childTestIds(body)).toEqual([
      'conversation-nav-group-overlay',
      'conversation-nav-context',
      'conversation-nav-item-u1',
      'conversation-nav-item-u2',
      'conversation-nav-fork',
      'conversation-nav-item-u3'
    ])
  })

  it('stacks adjacent context and fork dividers as two rules without merging semantics', () => {
    // u1's fork marker sits after u1 while the context boundary sits above u2:
    // the two rows are adjacent but stay two DOM rows with their own gap, so
    // neither boundary is dropped nor painted twice at one position.
    const { container } = render(
      <MessageOutline
        entries={ENTRIES}
        onNavigate={vi.fn()}
        forkAfter={new Map([['u1', 'branch']])}
        contextRowId="u2"
      />
    )
    const body = bodyOf(container)
    expect(childTestIds(body)).toEqual([
      'conversation-nav-group-overlay',
      'conversation-nav-item-u1',
      'conversation-nav-fork',
      'conversation-nav-context',
      'conversation-nav-item-u2',
      'conversation-nav-item-u3'
    ])
  })

  it('paints the current dash primary in the collapsed rail and keeps it across a reverse', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} activeId="u2" />)
      const body = bodyOf(container)
      // The collapsed rail reads the dots alone, so the current row's dash
      // takes primary here — the rule the rewrite dropped, leaving all
      // dashes gray.
      expect(normalizedCss()).toContain('background:var(--color-primary)')
      expect(screen.getByTestId('conversation-nav-item-u2').getAttribute('aria-current')).toBe('true')

      // Expand and collapse again: the same prop-driven rule applies in both
      // states, so the reversal cannot drop the current mark.
      fireEvent.mouseEnter(body)
      expect(body.getAttribute('data-expanded')).toBe('true')
      fireEvent.mouseLeave(body)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(body.getAttribute('data-expanded')).toBe('false')
      expect(screen.getByTestId('conversation-nav-item-u2').getAttribute('aria-current')).toBe('true')
      expect(normalizedCss()).toContain('background:var(--color-primary)')
    } finally {
      vi.useRealTimers()
    }
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
  // The switch's settle window: its timeline plus one frame of slack, after
  // which the rows take the pointer (and the scrollbar is painted again).
  const EXPAND_SETTLE_DELAY_MS = EXPAND_TRANSITION_MS + 16
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
    const body = outlineBody(utils.container.querySelector('[data-testid="conversation-navigation"]'))
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
    // The click belongs to the settled switch: the rows take the pointer only
    // once the width transition is over.
    advance(EXPAND_SETTLE_DELAY_MS)
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
    const body = outlineBody(nav)
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

  it('floors a short preview at the 200px minimum so a current-row change never jitters the width', () => {
    // Short text needs far less than the floor; the floor still wins while
    // the column cap stays above it — a pure color/weight row change cannot
    // move the panel edge.
    const { nav, body, panel, content } = renderOutline()
    stubBox(nav, 0, 100, 400)
    stubBox(content, 0, 100, 50)
    stubGutter(body, 6)
    fireEvent.mouseEnter(body)
    expect(panel.style.width).toBe('200px')
  })

  it('yields to a narrow column cap below the floor instead of forcing 200px', () => {
    // 200px host column: 200 - 24 host inset - 20 body padding - 6 reserved
    // gutter leaves a 150px cap, and the floor follows it down.
    const { nav, body, panel, content } = renderOutline()
    stubBox(nav, 0, 100, 200)
    stubBox(content, 0, 100, 50)
    stubGutter(body, 6)
    fireEvent.mouseEnter(body)
    expect(panel.style.width).toBe('150px')
    expect(content.style.maxWidth).toBe('150px')
  })

  it('reserves the group gutter while a run is drawn without moving the cap', () => {
    // The node links live in the rail's own left whitespace: the measured width
    // reserves the 18px gutter (8px offset + 6px text gap) on top of the text,
    // so the left-shifted line is never clipped and never presses the
    // text. Dividers carry no text and reserve nothing.
    const utils = render(
      <MessageOutline
        entries={ENTRIES}
        onNavigate={vi.fn()}
        groupRuns={[{ segmentId: 's1', color: '#1a2b3c', rowIds: ['u1'], lane: 0 }]}
      />
    )
    const nav = utils.container.querySelector('[data-testid="conversation-navigation"]') as HTMLElement
    const body = outlineBody(nav)
    const panel = utils.getByTestId('conversation-nav-panel')
    const content = panel.firstElementChild as HTMLElement
    stubBox(nav, 0, 100, 400)
    stubBox(content, 0, 100, 200)
    stubGutter(body, 6)
    fireEvent.mouseEnter(body)
    // Text alone would measure 200px; the gutter reserves the links' own
    // whitespace on top, and the column cap is untouched.
    expect(panel.style.width).toBe('218px')
    expect(content.style.maxWidth).toBe('294px')
  })

  it('turns a mid-collapse re-entry around at once, on the same single target', () => {
    const { nav, body, panel, content, advance } = renderOutline()
    stubBox(nav, 0, 100, 400)
    stubBox(content, 0, 100, 200)
    fireEvent.mouseEnter(body)
    expect(panel.style.width).toBe('200px')
    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    expect(body.getAttribute('data-expanded')).toBe('false')
    expect(panel.style.width).toBe('18px')
    fireEvent.mouseEnter(body)
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(panel.style.width).toBe('200px')
    advance(1000)
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(panel.style.width).toBe('200px')
  })

  it('declares a staged handoff inside one 180ms geometry timeline — and none under reduced motion', () => {
    const { content } = renderOutline()
    expect(content.style.maxWidth).toBe('')
    const norm = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '')
    // Geometry stays one 180ms line: width, rows, gap, margins.
    expect(norm).toContain('transition:width180msease-out')
    expect(norm).toContain('transition:height180msease-out')
    expect(norm).toContain('gap180msease-out')
    expect(norm).toContain('margin-top180msease-out')
    // Staged handoff, not one shared fade: outgoing layers fade in 40ms with
    // no delay; incoming layers wait 40ms then fade over 140ms (40+140=180),
    // so dot and text/nodes/divider are never both clearly visible and a
    // reversal starts from the current value with at most ~40ms of blank.
    expect(norm).toContain('opacity40msease-out0ms')
    expect(norm).toContain('opacity140msease-out40ms')
    // Opaque surface without interpolation: expanding lands in the same commit
    // (0s, no delay); collapsing holds through the 180ms switch with a delayed
    // 0s flip, then drops to transparent — no translucent mid-frame.
    expect(norm).toContain('background-color0s')
    expect(norm).toContain('background-color0slinear180ms')
    // Light halo, not the heavy gray ring: small dark blur at 8%.
    expect(norm).toContain('0 2px 8px 0 rgba(0,0,0,0.08)'.replace(/\s+/g, ''))
    // Neither the text nor the fork label is display-swapped, so neither can pop.
    expect(norm).not.toContain('display:none')
    // Reduced motion drops every one of them, so the switch settles at once.
    expect(norm).toContain('@media(prefers-reduced-motion:reduce)')
    expect(norm).toContain('transition:none')
  })

  it('hands markers without overlap or long blank on a rapid reverse', () => {
    // Static CSS proof of the handoff contract: the two expanded/collapsed
    // opacity rules carry opposite delays, so at any instant at most one layer
    // is clearly visible, and a mid-fade reversal resumes from the drawn value
    // (CSS transitions reverse in place — no flash, no mount swap). The worst
    // fully-hidden window is the 40ms delay itself.
    const norm = Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '')
    const out40 = (norm.match(/opacity40msease-out0ms/g) ?? []).length
    const in140 = (norm.match(/opacity140msease-out40ms/g) ?? []).length
    // Dots, text, overlay and divider rows each carry both directions.
    expect(out40).toBeGreaterThanOrEqual(4)
    expect(in140).toBeGreaterThanOrEqual(3)
  })
  it('settles at once under reduced motion', () => {
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
    const body = outlineBody(nav)
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

describe('MessageOutline navigation hover halo', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' }
  ]

  // styled-components injects component CSS into <style>; normalize whitespace
  // so serialization variants cannot false-fail, then select whole rules.
  const normalizedCss = () =>
    Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '')

  const rulesFor = (element: HTMLElement) => {
    const rules = normalizedCss().match(/[^{}]+\{[^}]*\}/g) ?? []
    return rules.filter((rule) => Array.from(element.classList).some((name) => rule.includes(`.${name}`)))
  }

  const renderOutline = () => {
    const utils = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} />)
    const nav = utils.container.querySelector('[data-testid="conversation-navigation"]') as HTMLElement
    const body = outlineBody(nav)
    const zone = screen.getByTestId('conversation-nav-hitzone')
    return { ...utils, nav, body, zone }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hugs the body with a 10px halo instead of claiming the reading-area height', () => {
    const { nav, body, zone } = renderOutline()

    // The halo is the body's parent, so its box is the body's own: the ring is
    // this box's padding, and the matching negative margin pulls the margin box
    // back to exactly the body's old box, so nothing about the rail's placement
    // (centering included) moved.
    expect(nav.firstElementChild).toBe(zone)
    expect(nav.lastElementChild).toBe(zone)
    expect(zone.firstElementChild).toBe(body)
    const zoneRule = rulesFor(zone).join('\n')
    expect(zoneRule).not.toBe('')
    for (const declaration of ['padding:10px', 'margin:-10px', 'pointer-events:auto']) {
      expect(zoneRule).toContain(declaration)
    }
    // The full-height lane is what this is not: nothing out of flow, nothing
    // stretching to the reading area's top and bottom.
    for (const declaration of ['position:absolute', 'top:0', 'bottom:0', 'z-index:-1']) {
      expect(zoneRule).not.toContain(declaration)
    }
    expect(body.getAttribute('data-expanded')).toBe('false')
  })

  it('expands from the halo alone and treats the halo and the panel as one surface', () => {
    const { body, zone } = renderOutline()
    const expanded = () => body.getAttribute('data-expanded')

    // Entering the halo anywhere expands, exactly as entering the rail does.
    fireEvent.mouseEnter(zone)
    expect(expanded()).toBe('true')

    // Moving between the halo and the panel is travel inside one surface: the
    // pair of events a browser reports for it cannot start a collapse.
    fireEvent.mouseLeave(zone)
    fireEvent.mouseEnter(body)
    expect(expanded()).toBe('true')

    // Leaving the panel arms the grace margin; re-entering the halo cancels it.
    fireEvent.mouseLeave(body)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(expanded()).toBe('true')
    fireEvent.mouseEnter(zone)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(expanded()).toBe('true')

    // Leaving both keeps the existing 160ms grace: not a frame earlier.
    fireEvent.mouseLeave(zone)
    act(() => {
      vi.advanceTimersByTime(159)
    })
    expect(expanded()).toBe('true')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(expanded()).toBe('false')
  })
})

describe('MessageOutline pointer gate across the switch', () => {
  const ENTRIES = [
    { id: 'u1', text: 'First question' },
    { id: 'u2', text: 'Second question' },
    { id: 'u3', text: 'Third question' }
  ]
  const EXPAND_TRANSITION_MS = 180
  // The switch's settle window: its timeline plus one frame of slack.
  const SETTLE_MS = 16
  const COLLAPSE_GRACE_MS = 160

  const normalizedCss = () =>
    Array.from(document.querySelectorAll('style'))
      .map((el) => el.textContent ?? '')
      .join('\n')
      .replace(/\s+/g, '')

  const rulesFor = (element: HTMLElement) => {
    const rules = normalizedCss().match(/[^{}]+\{[^}]*\}/g) ?? []
    return rules.filter((rule) => Array.from(element.classList).some((name) => rule.includes(`.${name}`)))
  }

  const renderOutline = () => {
    const utils = render(<MessageOutline entries={ENTRIES} onNavigate={vi.fn()} />)
    const nav = utils.container.querySelector('[data-testid="conversation-navigation"]') as HTMLElement
    const body = outlineBody(nav)
    const panel = screen.getByTestId('conversation-nav-panel')
    const content = panel.firstElementChild as HTMLElement
    const gate = () => panel.getAttribute('data-outline-interactive')
    const rowOf = (id: string) => body.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
    const advance = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms)
      })
    }
    return { ...utils, nav, body, panel, content, gate, rowOf, advance }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps the rows inert for the whole switch and opens on the settled edge only', () => {
    const { body, gate, advance } = renderOutline()
    expect(gate()).toBe('blocked')

    fireEvent.mouseEnter(body)
    expect(body.getAttribute('data-expanded')).toBe('true')
    // Expanding: the rows are still moving under the pointer.
    expect(gate()).toBe('blocked')

    // The transition's own timeline has run out, but the settle frame that
    // proves the final width is on screen has not landed yet.
    advance(EXPAND_TRANSITION_MS)
    expect(gate()).toBe('blocked')

    advance(SETTLE_MS)
    expect(gate()).toBe('ready')
  })

  it('shuts the gate in the commit that starts a collapse', () => {
    const { body, gate, advance } = renderOutline()
    fireEvent.mouseEnter(body)
    advance(EXPAND_TRANSITION_MS + SETTLE_MS)
    expect(gate()).toBe('ready')

    fireEvent.mouseLeave(body)
    // Still in the grace margin: nothing has changed yet.
    advance(COLLAPSE_GRACE_MS - 1)
    expect(gate()).toBe('ready')

    // The collapse's first frame already refuses the pointer, before the panel
    // has moved back.
    advance(1)
    expect(body.getAttribute('data-expanded')).toBe('false')
    expect(gate()).toBe('blocked')
    // Nothing re-opens it while compact.
    advance(1000)
    expect(gate()).toBe('blocked')
  })

  it('restarts the gate on a reversal instead of inheriting the open state', () => {
    const { body, gate, advance } = renderOutline()
    fireEvent.mouseEnter(body)
    advance(20)
    expect(gate()).toBe('blocked')

    // Leave early: the collapse lands long before the first window's settle.
    fireEvent.mouseLeave(body)
    advance(COLLAPSE_GRACE_MS)
    expect(body.getAttribute('data-expanded')).toBe('false')
    advance(SETTLE_MS)
    expect(gate()).toBe('blocked')

    // Re-entering starts a fresh window rather than inheriting the dropped one.
    fireEvent.mouseEnter(body)
    expect(gate()).toBe('blocked')
    advance(EXPAND_TRANSITION_MS)
    expect(gate()).toBe('blocked')
    advance(SETTLE_MS)
    expect(gate()).toBe('ready')
  })

  it('settles the gate at once under reduced motion', () => {
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
    const { body, gate } = renderOutline()
    expect(gate()).toBe('blocked')
    fireEvent.mouseEnter(body)
    // No transition runs, so the switch is already fully expanded: the rows take
    // the pointer in the same commit instead of waiting out a timeline.
    expect(body.getAttribute('data-expanded')).toBe('true')
    expect(gate()).toBe('ready')
    expect(vi.getTimerCount()).toBe(0)

    // Closing still shuts it immediately.
    fireEvent.mouseLeave(body)
    act(() => {
      vi.advanceTimersByTime(COLLAPSE_GRACE_MS)
    })
    expect(gate()).toBe('blocked')
  })

  it('gates the content subtree and the row affordances, never the keyboard', () => {
    const onNavigate = vi.fn()
    const { container } = render(<MessageOutline entries={ENTRIES} onNavigate={onNavigate} />)
    const nav = container.querySelector('[data-testid="conversation-navigation"]') as HTMLElement
    const body = outlineBody(nav)
    const content = screen.getByTestId('conversation-nav-panel').firstElementChild as HTMLElement
    const row = screen.getByTestId('conversation-nav-item-u1')

    // Hit testing: only the content subtree is transparent, so the body keeps
    // the wheel and its scrollbar, and the halo around it keeps the pointer.
    const gateRule = rulesFor(content).find((rule) => rule.includes("[data-outline-interactive='blocked']"))
    expect(gateRule).toBeDefined()
    expect(gateRule).toContain('pointer-events:none')

    // The pointer affordances exist only under the settled attribute.
    const rowRules = rulesFor(row)
    const pointerRules = rowRules.filter((rule) => rule.includes('cursor:pointer'))
    expect(pointerRules.length).toBeGreaterThan(0)
    const hoverRules = rowRules.filter((rule) => rule.includes(':hover'))
    expect(hoverRules.length).toBeGreaterThan(0)
    for (const rule of [...pointerRules, ...hoverRules]) {
      expect(rule).toContain("[data-outline-interactive='ready']")
    }

    // Pointer navigation is refused while the gate is closed...
    fireEvent.click(row)
    expect(onNavigate).not.toHaveBeenCalled()

    // ...and keyboard navigation is not part of the gate: the row keeps its tab
    // stop and Enter still navigates the compact rail.
    expect(row.getAttribute('tabindex')).toBe('0')
    row.focus()
    expect(document.activeElement).toBe(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('u1')
    fireEvent.keyDown(row, { key: ' ' })
    expect(onNavigate).toHaveBeenCalledTimes(2)

    // Once settled the same click navigates.
    fireEvent.mouseEnter(body)
    act(() => {
      vi.advanceTimersByTime(EXPAND_TRANSITION_MS + SETTLE_MS)
    })
    fireEvent.click(row)
    expect(onNavigate).toHaveBeenCalledTimes(3)
  })
})
