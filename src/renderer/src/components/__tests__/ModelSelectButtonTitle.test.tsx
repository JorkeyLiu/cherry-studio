import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => <div data-testid="avatar" />
}))
vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: { show: vi.fn() }
}))

// antd Tooltip renders children and keeps title prop accessible via DOM
vi.mock('antd', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    Tooltip: ({ title, children }: any) => (
      <div data-testid="tooltip" title={title}>
        {children}
      </div>
    ),
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>
  }
})

import ModelSelectButton from '../ModelSelectButton'

describe('ModelSelectButton tooltip title (name-only)', () => {
  it('tooltip is name-only even when trimmed id != trimmed name', () => {
    const model = { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai' } as any
    const { container } = render(<ModelSelectButton model={model} onSelectModel={vi.fn()} />)
    const tooltip = container.querySelector('[data-testid="tooltip"]') as HTMLElement | null
    expect(tooltip?.getAttribute('title')).toBe('GPT-4o')
    expect(tooltip?.getAttribute('title')).not.toContain('gpt-4o-2024-08-06')
  })

  it('does not duplicate when trimmed id == trimmed name (name-only)', () => {
    const model = { id: 'gpt-4o', name: 'gpt-4o', provider: 'openai' } as any
    const { container } = render(<ModelSelectButton model={model} onSelectModel={vi.fn()} />)
    const tooltip = container.querySelector('[data-testid="tooltip"]') as HTMLElement | null
    expect(tooltip?.getAttribute('title')).toBe('gpt-4o')
  })

  it('trims whitespace but remains name-only', () => {
    const same = { id: '  gpt-4o  ', name: 'gpt-4o', provider: 'openai' } as any
    const { container: c1 } = render(<ModelSelectButton model={same} onSelectModel={vi.fn()} />)
    expect(c1.querySelector('[data-testid="tooltip"]')?.getAttribute('title')).toBe('gpt-4o')

    const diff = { id: ' gpt-4o-1 ', name: ' GPT-4o ', provider: 'openai' } as any
    const { container: c2 } = render(<ModelSelectButton model={diff} onSelectModel={vi.fn()} />)
    expect(c2.querySelector('[data-testid="tooltip"]')?.getAttribute('title')).toBe(' GPT-4o ')
    expect(c2.querySelector('[data-testid="tooltip"]')?.getAttribute('title')).not.toContain('gpt-4o-1')
  })

  it('case difference still name-only', () => {
    const model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any
    const { container } = render(<ModelSelectButton model={model} onSelectModel={vi.fn()} />)
    expect(container.querySelector('[data-testid="tooltip"]')?.getAttribute('title')).toBe('GPT-4o')
  })

  it('same display name different ids share same name-only tooltip', () => {
    const a = { id: 'gpt-4o-a', name: 'GPT-4o', provider: 'openai' } as any
    const b = { id: 'gpt-4o-b', name: 'GPT-4o', provider: 'openai' } as any
    const { container: ca } = render(<ModelSelectButton model={a} onSelectModel={vi.fn()} />)
    const { container: cb } = render(<ModelSelectButton model={b} onSelectModel={vi.fn()} />)
    expect(ca.querySelector('[data-testid="tooltip"]')?.getAttribute('title')).toBe('GPT-4o')
    expect(cb.querySelector('[data-testid="tooltip"]')?.getAttribute('title')).toBe('GPT-4o')
  })
})
