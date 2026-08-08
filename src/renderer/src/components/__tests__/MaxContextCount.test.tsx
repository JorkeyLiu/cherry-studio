/**
 * Tests for MaxContextCount — renders ∞ for null (unlimited) and numeric value otherwise.
 */
import MaxContextCount from '@renderer/components/MaxContextCount'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('MaxContextCount', () => {
  it('renders ∞ for null (unlimited)', () => {
    render(<MaxContextCount maxContext={null} />)
    expect(screen.getByText('∞')).toBeDefined()
  })

  it('renders "100" for numeric 100 (not treated as unlimited)', () => {
    render(<MaxContextCount maxContext={100} />)
    expect(screen.getByText('100')).toBeDefined()
  })

  it('renders "5" for numeric 5', () => {
    render(<MaxContextCount maxContext={5} />)
    expect(screen.getByText('5')).toBeDefined()
  })

  it('renders "99" for numeric 99 (finite value stays numeric, never ∞)', () => {
    render(<MaxContextCount maxContext={99} />)
    expect(screen.getByText('99')).toBeDefined()
    expect(screen.queryByText('∞')).toBeNull()
  })

  it('renders "0" for numeric 0', () => {
    render(<MaxContextCount maxContext={0} />)
    expect(screen.getByText('0')).toBeDefined()
  })

  it('applies custom style to numeric value', () => {
    const { container } = render(<MaxContextCount maxContext={42} style={{ color: 'red' }} />)
    const span = container.querySelector('span')
    expect(span).toBeDefined()
    expect(span!.style.color).toBe('red')
    expect(span!.textContent).toBe('42')
  })

  it('applies custom style to ∞', () => {
    const { container } = render(<MaxContextCount maxContext={null} style={{ color: 'blue' }} />)
    const span = container.querySelector('span')
    expect(span).toBeDefined()
    expect(span!.style.color).toBe('blue')
    expect(span!.textContent).toBe('∞')
  })

  it('renders finite and infinity with identical metric styles (LOCK-LAYOUT-1)', () => {
    const finite = render(
      <div style={{ fontSize: '14px', lineHeight: '1.6' }}>
        <MaxContextCount maxContext={99} />
      </div>
    )
    const infinity = render(
      <div style={{ fontSize: '14px', lineHeight: '1.6' }}>
        <MaxContextCount maxContext={null} />
      </div>
    )
    const finiteSpan = finite.container.querySelector('span')!
    const infinitySpan = infinity.container.querySelector('span')!
    expect(finiteSpan).toBeDefined()
    expect(infinitySpan).toBeDefined()
    expect(finiteSpan.textContent).toBe('99')
    expect(infinitySpan.textContent).toBe('∞')
    // LOCK-LAYOUT-1: identical computed inputs for font size, line height,
    // display and vertical alignment — switching finite ⇄ infinity never
    // changes the title-row height.
    for (const prop of ['fontSize', 'lineHeight', 'display', 'verticalAlign'] as const) {
      expect(getComputedStyle(finiteSpan)[prop]).toBe(getComputedStyle(infinitySpan)[prop])
    }
    // Neither branch imposes its own font metrics — both inherit from context.
    expect(finiteSpan.style.fontSize).toBe('')
    expect(infinitySpan.style.fontSize).toBe('')
    finite.unmount()
    infinity.unmount()
  })
})
