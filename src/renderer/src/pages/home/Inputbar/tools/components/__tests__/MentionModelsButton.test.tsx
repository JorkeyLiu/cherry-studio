import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockProviders = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    apiKey: '',
    apiHost: '',
    models: [
      { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'default' },
      { id: 'gpt-4o', name: 'gpt-4o', provider: 'openai', group: 'default' }
    ]
  }
]

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, provider, size }: any) => (
    <div data-testid={`avatar-${model.id}`} data-provider-id={provider?.id} data-size={size} />
  )
}))
vi.mock('@renderer/components/ModelTagsWithLabel', () => ({ default: () => <div data-testid="tags" /> }))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: mockProviders })
}))
vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: (m: any) => `${m.provider}-${m.id}`
}))
vi.mock('@renderer/utils', () => ({
  getFancyProviderName: (p: any) => p.name
}))
vi.mock('@renderer/config/models', () => ({
  isEmbeddingModel: () => false,
  isRerankModel: () => false
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/pages/home/Inputbar/components/ToolPopover', () => ({
  default: ({ content }: any) => <div>{content}</div>
}))
vi.mock('antd', async () => {
  const actual = await vi.importActual<any>('antd')
  return { ...actual, Tooltip: ({ children }: any) => <div>{children}</div> }
})

import MentionModelsButton from '../MentionModelsButton'

describe('MentionModelsButton name-only', () => {
  it('renders name-only (no inline ID) for all rows', () => {
    render(<MentionModelsButton mentionedModels={[]} setMentionedModels={vi.fn()} files={[]} setText={vi.fn()} />)
    // GPT-4o with id gpt-4o-2024-08-06 -> only name visible, no ID inline/title
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.queryByText('gpt-4o-2024-08-06')).toBeNull()
    expect(document.querySelector('[title="gpt-4o-2024-08-06"]')).toBeNull()
    // gpt-4o where name==id -> only once
    const equalEls = screen.getAllByText('gpt-4o')
    expect(equalEls).toHaveLength(1)
    expect(document.querySelector('[title="gpt-4o"]')).toBeNull()
    // overall no model ids rendered inline
    expect(screen.queryByText('gpt-4o-a')).toBeNull()
  })

  it('keeps avatar provider and tags', () => {
    render(<MentionModelsButton mentionedModels={[]} setMentionedModels={vi.fn()} files={[]} setText={vi.fn()} />)
    expect(screen.getByTestId('avatar-gpt-4o-2024-08-06')).toBeInTheDocument()
    expect(screen.getByTestId('avatar-gpt-4o-2024-08-06').getAttribute('data-provider-id')).toBe('openai')
    expect(screen.getAllByTestId('tags').length).toBe(2)
  })
})
