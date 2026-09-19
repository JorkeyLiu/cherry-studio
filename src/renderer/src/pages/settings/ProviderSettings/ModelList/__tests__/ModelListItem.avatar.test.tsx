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
vi.mock('@renderer/components/ModelIdWithTags', () => ({
  default: () => <div data-testid="model-id-stub" />
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

import ModelListItem from '../ModelListItem'

const model: any = { id: 'gpt-4o', name: 'gpt-4o' }
const provider: any = { id: 'openai', name: 'OpenAI' }

describe('ModelListItem avatar', () => {
  it('renders ModelAvatar with the model and owning provider context', () => {
    render(
      <ModelListItem model={model} provider={provider} modelStatus={undefined} onEdit={() => {}} onRemove={() => {}} />
    )
    const stub = screen.getByTestId('model-avatar-stub')
    expect(stub.getAttribute('data-model-id')).toBe('gpt-4o')
    expect(stub.getAttribute('data-provider-id')).toBe('openai')
    expect(stub.getAttribute('data-size')).toBe('24')
  })

  it('falls back to resolver attribution when no provider is passed', () => {
    render(<ModelListItem model={model} modelStatus={undefined} onEdit={() => {}} onRemove={() => {}} />)
    const stub = screen.getByTestId('model-avatar-stub')
    expect(stub.getAttribute('data-model-id')).toBe('gpt-4o')
    expect(stub.getAttribute('data-provider-id')).toBe('')
  })
})
