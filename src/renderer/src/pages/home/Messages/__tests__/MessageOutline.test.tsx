import { fireEvent, render, screen } from '@testing-library/react'
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
