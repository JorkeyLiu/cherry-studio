import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, provider, size }: any) => (
    <div
      data-testid="model-avatar-stub"
      data-model-id={model?.id}
      data-provider-id={provider?.id ?? ''}
      data-size={size}
    />
  )
}))
vi.mock('@renderer/components/ErrorDetailModal', () => ({ showErrorDetailPopup: vi.fn() }))
vi.mock('@renderer/components/HealthStatusIndicator', () => ({
  HealthStatusIndicator: () => <div data-testid="health-stub" />
}))
vi.mock('@renderer/components/Layout', () => ({
  HStack: ({ children }: any) => <div>{children}</div>
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

import ModelListItem from '../ModelListItem'

describe('ModelListItem display name + serving ID', () => {
  it('shows id when trimmed name differs from id', () => {
    render(
      <ModelListItem
        model={{ id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'test' } as any}
        provider={{ id: 'openai', name: 'OpenAI' } as any}
        modelStatus={undefined}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    )
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o-2024-08-06')).toBeInTheDocument()
  })

  it('shows once when trimmed name equals id', () => {
    render(
      <ModelListItem
        model={{ id: 'gpt-4o', name: 'gpt-4o', provider: 'openai', group: 'test' } as any}
        provider={{ id: 'openai', name: 'OpenAI' } as any}
        modelStatus={undefined}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    )
    // name appears once, no duplicate id span
    const nameEls = screen.getAllByText('gpt-4o')
    expect(nameEls).toHaveLength(1)
    // the id span with title should not exist when equal
    expect(document.querySelector('[title="gpt-4o"]')).toBeNull()
  })

  it('trimmed equality hides id, whitespace difference shows id', () => {
    const { unmount } = render(
      <ModelListItem
        model={{ id: '  gpt-4o  ', name: 'gpt-4o', provider: 'openai', group: 'test' } as any}
        provider={{ id: 'openai', name: 'OpenAI' } as any}
        modelStatus={undefined}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    )
    // trimmed id equals trimmed name -> no id visible
    expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    expect(screen.queryByText('  gpt-4o  ')).toBeNull()
    unmount()

    render(
      <ModelListItem
        model={{ id: ' gpt-4o-1 ', name: ' GPT-4o ', provider: 'openai', group: 'test' } as any}
        provider={{ id: 'openai', name: 'OpenAI' } as any}
        modelStatus={undefined}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    )
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o-1')).toBeInTheDocument()
  })

  it('case difference shows id (case-sensitive trim)', () => {
    render(
      <ModelListItem
        model={{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'test' } as any}
        provider={{ id: 'openai', name: 'OpenAI' } as any}
        modelStatus={undefined}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    )
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o')).toBeInTheDocument()
  })
})
