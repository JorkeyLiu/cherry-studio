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
})
