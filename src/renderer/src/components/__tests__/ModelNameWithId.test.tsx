import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import ModelNameWithId from '../ModelNameWithId'

describe('ModelNameWithId', () => {
  it('shows id when trimmed name differs from id', () => {
    render(<ModelNameWithId model={{ name: 'GPT-4o', id: 'gpt-4o-2024-08-06' } as any} />)
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    const idEl = screen.getByText('gpt-4o-2024-08-06')
    expect(idEl).toBeInTheDocument()
    expect(idEl.getAttribute('title')).toBe('gpt-4o-2024-08-06')
  })

  it('shows once when trimmed name equals id (no duplicate id)', () => {
    render(<ModelNameWithId model={{ name: 'gpt-4o', id: 'gpt-4o' } as any} />)
    const els = screen.getAllByText('gpt-4o')
    expect(els).toHaveLength(1)
    expect(document.querySelector('[title="gpt-4o"]')).toBeNull()
  })

  it('trimmed equality hides id (whitespace)', () => {
    render(<ModelNameWithId model={{ name: 'gpt-4o', id: '  gpt-4o  ' } as any} />)
    expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    expect(screen.queryByText('  gpt-4o  ')).toBeNull()
    expect(document.querySelector('[title="  gpt-4o  "]')).toBeNull()
  })

  it('whitespace difference shows id', () => {
    render(<ModelNameWithId model={{ name: ' GPT-4o ', id: ' gpt-4o-1 ' } as any} />)
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    const idEl = document.querySelector('[title=" gpt-4o-1 "]')
    expect(idEl).not.toBeNull()
    expect(idEl?.textContent).toBe(' gpt-4o-1 ')
  })

  it('case difference shows id (case-sensitive)', () => {
    render(<ModelNameWithId model={{ name: 'GPT-4o', id: 'gpt-4o' } as any} />)
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    expect(document.querySelector('[title="gpt-4o"]')).not.toBeNull()
  })

  it('applies truncation via idMaxWidth style and preserves title', () => {
    render(<ModelNameWithId model={{ name: 'My Model', id: 'very-long-id-1234567890' } as any} idMaxWidth={120} />)
    const idEl = screen.getByText('very-long-id-1234567890')
    expect(idEl.getAttribute('title')).toBe('very-long-id-1234567890')
    expect(idEl.style.maxWidth).toBe('120px')
  })

  it('idMaxWidth overrides idStyle.maxWidth when both are provided', () => {
    render(
      <ModelNameWithId
        model={{ name: 'My Model', id: 'very-long-id-1234567890' } as any}
        idMaxWidth={120}
        idStyle={{ maxWidth: 999, color: 'red' }}
      />
    )
    const idEl = screen.getByText('very-long-id-1234567890')
    expect(idEl.getAttribute('title')).toBe('very-long-id-1234567890')
    // documented override: idMaxWidth wins over idStyle.maxWidth
    expect(idEl.style.maxWidth).toBe('120px')
    // other idStyle props are preserved
    expect(idEl.style.color).toBe('red')
  })

  it('idMaxWidth string value overrides idStyle.maxWidth', () => {
    render(
      <ModelNameWithId
        model={{ name: 'My Model', id: 'very-long-id-1234567890' } as any}
        idMaxWidth="50%"
        idStyle={{ maxWidth: '99%' }}
      />
    )
    const idEl = screen.getByText('very-long-id-1234567890')
    expect(idEl.style.maxWidth).toBe('50%')
  })

  it('allows className/style overrides without breaking predicate', () => {
    render(
      <ModelNameWithId
        model={{ name: 'A', id: 'b' } as any}
        className="custom-container"
        nameClassName="custom-name"
        idClassName="custom-id"
      />
    )
    expect(document.querySelector('.custom-container')).not.toBeNull()
    expect(document.querySelector('.custom-name')).not.toBeNull()
    expect(document.querySelector('.custom-id')).not.toBeNull()
  })
})
