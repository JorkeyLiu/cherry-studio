import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
