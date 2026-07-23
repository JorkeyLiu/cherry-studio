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
    expect(span!.style.fontSize).toBe('16px')
    expect(span!.textContent).toBe('∞')
  })
})
