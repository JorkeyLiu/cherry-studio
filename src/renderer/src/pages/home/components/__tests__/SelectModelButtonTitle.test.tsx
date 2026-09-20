import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: () => <div data-testid="avatar" />
}))
vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: { show: vi.fn() }
}))
vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: (_id: string) => ({
    model: undefined,
    updateAssistant: vi.fn()
  })
}))
vi.mock('@renderer/hooks/useProvider', () => ({
  useAllProviders: () => []
}))
vi.mock('@renderer/services/ProviderService', () => ({
  getProviderName: () => ''
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

// Simplify: directly test title generation logic via rendering the button component
// We need to mock useAssistant to return the model we want to test. Create a helper.

import * as useAssistantHook from '@renderer/hooks/useAssistant'

import SelectModelButton from '../SelectModelButton'

function renderWithModel(model: any) {
  vi.spyOn(useAssistantHook, 'useAssistant').mockReturnValue({
    model,
    updateAssistant: vi.fn()
  } as any)
  const assistant = { id: 'a1', name: 'Test' } as any
  const { container } = render(<SelectModelButton assistant={assistant} />)
  return container
}

describe('SelectModelButton title (trim-based)', () => {
  it('title includes id when trimmed id != trimmed name', () => {
    const model = { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai' } as any
    const container = renderWithModel(model)
    const btn = container.querySelector('button') as HTMLElement | null
    expect(btn?.getAttribute('title')).toBe('GPT-4o (gpt-4o-2024-08-06)')
    // ModelName span also has title
    const nameSpan = container.querySelector('span[title]') as HTMLElement | null
    expect(nameSpan?.getAttribute('title')).toBe('GPT-4o (gpt-4o-2024-08-06)')
  })

  it('does not duplicate when trimmed equal', () => {
    const model = { id: 'gpt-4o', name: 'gpt-4o', provider: 'openai' } as any
    const container = renderWithModel(model)
    const btn = container.querySelector('button') as HTMLElement | null
    expect(btn?.getAttribute('title')).toBe('gpt-4o')
  })

  it('trims whitespace correctly', () => {
    const same = { id: '  gpt-4o  ', name: 'gpt-4o', provider: 'openai' } as any
    const c1 = renderWithModel(same)
    expect(c1.querySelector('button')?.getAttribute('title')).toBe('gpt-4o')

    const diff = { id: ' gpt-4o-1 ', name: ' GPT-4o ', provider: 'openai' } as any
    const c2 = renderWithModel(diff)
    expect(c2.querySelector('button')?.getAttribute('title')).toContain('gpt-4o-1')
  })

  it('case-sensitive distinction shows id', () => {
    const model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any
    const container = renderWithModel(model)
    expect(container.querySelector('button')?.getAttribute('title')).toBe('GPT-4o (gpt-4o)')
  })

  it('same display name different ids are distinguishable via title', () => {
    const a = { id: 'gpt-4o-a', name: 'GPT-4o', provider: 'openai' } as any
    const b = { id: 'gpt-4o-b', name: 'GPT-4o', provider: 'openai' } as any
    const ca = renderWithModel(a)
    const cb = renderWithModel(b)
    expect(ca.querySelector('button')?.getAttribute('title')).toContain('gpt-4o-a')
    expect(cb.querySelector('button')?.getAttribute('title')).toContain('gpt-4o-b')
  })
})
