import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

// Mock the imported modules
vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, size }: any) => (
    <div data-testid="model-avatar" style={{ width: size, height: size }}>
      {model.name.charAt(0)}
    </div>
  )
}))

vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: (model: any) => `${model.provider}-${model.id}`
}))

vi.mock('@renderer/utils', () => ({
  matchKeywordsInString: (input: string, target: string) => target.toLowerCase().includes(input.toLowerCase())
}))

vi.mock('@renderer/utils/naming', () => ({
  getFancyProviderName: (provider: any) => provider.name
}))

// Import after mocking
import type { Provider } from '@renderer/types'

import ModelSelector, { modelSelectFilter } from '../ModelSelector'

describe('ModelSelector', () => {
  const mockProviders: Provider[] = [
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      apiKey: '123',
      apiHost: 'https://api.openai.com',
      models: [
        { id: 'text-embedding-ada-002', name: 'text-embedding-ada-002', provider: 'openai', group: 'embedding' },
        { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', group: 'chat' }
      ]
    },
    {
      id: 'cohere',
      name: 'Cohere',
      type: 'openai',
      apiKey: '123',
      apiHost: 'https://api.cohere.com',
      models: [
        { id: 'embed-english-v3.0', name: 'embed-english-v3.0', provider: 'cohere', group: 'embedding' },
        { id: 'rerank-english-v2.0', name: 'rerank-english-v2.0', provider: 'cohere', group: 'rerank' }
      ]
    },
    {
      id: 'empty-provider',
      name: 'EmptyProvider',
      type: 'openai',
      apiKey: '123',
      apiHost: 'https://api.cohere.com',
      models: []
    }
  ]

  describe('grouped mode (grouped=true)', () => {
    it('should render grouped options and apply predicate', () => {
      render(
        <ModelSelector
          providers={mockProviders}
          predicate={(model) => model.group === 'embedding'}
          open // Keep dropdown open for testing
        />
      )

      // Check for group labels
      expect(screen.getByText('OpenAI')).toBeInTheDocument()
      expect(screen.getByText('Cohere')).toBeInTheDocument()
      expect(screen.queryByText('EmptyProvider')).not.toBeInTheDocument()

      // Check for correct models
      const ada = screen.getByText('text-embedding-ada-002')
      const cohere = screen.getByText('embed-english-v3.0')
      expect(ada).toBeInTheDocument()
      expect(cohere).toBeInTheDocument()
      // Check suffix is present by default (name-only, suffix remains)
      expect(ada.closest('.ant-select-item-option')?.textContent).toContain(' | OpenAI')
      expect(cohere.closest('.ant-select-item-option')?.textContent).toContain(' | Cohere')
      // name-only: no inline ID
      expect(screen.queryByText('gpt-4.1')).not.toBeInTheDocument()
      // no primitive
      expect(document.querySelector('[data-testid="model-name-with-id"]')).toBeNull()

      // Check that filtered models are not present
      expect(screen.queryByText('GPT-4.1')).not.toBeInTheDocument()
      expect(screen.queryByText('rerank-english-v2.0')).not.toBeInTheDocument()
    })

    it('should hide suffix when showSuffix is false', () => {
      render(
        <ModelSelector
          providers={mockProviders}
          predicate={(model) => model.group === 'embedding'}
          showSuffix={false}
          open
        />
      )

      const ada = screen.getByText('text-embedding-ada-002')
      expect(ada.closest('.ant-select-item-option')?.textContent).toContain('text-embedding-ada-002')
      expect(ada.closest('.ant-select-item-option')?.textContent).not.toContain(' | OpenAI')
      expect(document.querySelector('[data-testid="model-name-with-id"]')).toBeNull()
    })

    it('should hide avatar when showAvatar is false', () => {
      render(<ModelSelector providers={mockProviders} showAvatar={false} open />)
      expect(screen.queryByTestId('model-avatar')).not.toBeInTheDocument()
    })

    it('should show avatar when showAvatar is true', () => {
      render(<ModelSelector providers={mockProviders} showAvatar={true} open />)
      // 4 models in total from mockProviders
      expect(screen.getAllByTestId('model-avatar')).toHaveLength(4)
    })
  })

  describe('flat mode (grouped=false)', () => {
    it('should render flat options and apply predicate', () => {
      render(
        <ModelSelector
          providers={mockProviders}
          predicate={(model) => model.group === 'embedding'}
          grouped={false}
          open
        />
      )

      // In flat mode, there are no group labels in the dropdown structure
      expect(document.querySelector('.ant-select-item-option-group')).toBeNull()

      // Check for correct models
      const ada = screen.getByText('text-embedding-ada-002')
      const cohere = screen.getByText('embed-english-v3.0')
      expect(ada).toBeInTheDocument()
      expect(cohere).toBeInTheDocument()
      // Check suffix is present by default
      expect(ada.closest('.ant-select-item-option')?.textContent).toContain(' | OpenAI')
      expect(cohere.closest('.ant-select-item-option')?.textContent).toContain(' | Cohere')

      // Check that filtered models are not present
      expect(screen.queryByText('GPT-4.1')).not.toBeInTheDocument()
      expect(screen.queryByText('rerank-english-v2.0')).not.toBeInTheDocument()
    })

    it('should hide suffix when showSuffix is false', () => {
      render(<ModelSelector providers={mockProviders} grouped={false} showSuffix={false} open />)

      const gpt4 = screen.getByText('GPT-4.1')
      const container = gpt4.closest('.ant-select-item-option')
      // name-only: no inline ID even when suffix hidden
      expect(container?.textContent).toContain('GPT-4.1')
      expect(container?.textContent).not.toContain('gpt-4.1')
      expect(container?.textContent).not.toContain(' | OpenAI')
      expect(container?.querySelector('[data-testid="model-name-with-id"]')).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('should handle empty providers array', () => {
      render(<ModelSelector providers={[]} open />)
      expect(document.querySelector('.ant-select-item-option')).toBeNull()
    })

    it('should handle undefined providers', () => {
      render(<ModelSelector providers={undefined} open />)
      expect(document.querySelector('.ant-select-item-option')).toBeNull()
    })
  })

  describe('modelSelectFilter function', () => {
    it('should filter by provider name in title', () => {
      const mockOption = {
        title: 'GPT-4.1 | OpenAI',
        value: 'openai-gpt-4.1'
      }
      expect(modelSelectFilter('openai', mockOption)).toBe(true)
    })

    it('should filter by model name in title', () => {
      const mockOption = {
        title: 'embed-english-v3.0 | Cohere',
        value: 'cohere-embed-english-v3.0'
      }
      expect(modelSelectFilter('english', mockOption)).toBe(true)
    })

    it('should filter by value if title is not present', () => {
      const mockOption = {
        value: 'openai-gpt-4.1'
      }
      expect(modelSelectFilter('gpt', mockOption)).toBe(true)
    })

    it('should return false for no match', () => {
      const mockOption = {
        title: 'GPT-4.1 | OpenAI',
        value: 'openai-gpt-4.1'
      }
      expect(modelSelectFilter('nonexistent', mockOption)).toBe(false)
    })
  })

  describe('integration', () => {
    it('should filter options correctly when user types in search input', async () => {
      const user = userEvent.setup()
      render(<ModelSelector providers={mockProviders} open />)

      // Find the search input field, which is a combobox
      const searchInput = screen.getByRole('combobox')
      await user.type(searchInput, 'embed')

      // After filtering, only embedding models should be visible
      expect(screen.getByText('text-embedding-ada-002')).toBeInTheDocument()
      expect(screen.getByText('embed-english-v3.0')).toBeInTheDocument()

      // Other models should not be visible
      expect(screen.queryByText('GPT-4.1')).not.toBeInTheDocument()
      expect(screen.queryByText('rerank-english-v2.0')).not.toBeInTheDocument()

      // The group titles for visible items should still be there
      expect(screen.getByText('OpenAI')).toBeInTheDocument()
      expect(screen.getByText('Cohere')).toBeInTheDocument()
    })
  })

  describe('name-only rendering with ID-aware search (trim-based title decoupled)', () => {
    it('renders name-only inline and title without ID, but keywords contain ID for search', () => {
      const providers: Provider[] = [
        {
          id: 'openai',
          name: 'OpenAI',
          type: 'openai',
          apiKey: '123',
          apiHost: 'https://api.openai.com',
          models: [{ id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'chat' } as any]
        }
      ]
      render(<ModelSelector providers={providers} open />)
      // name visible, ID not inline
      expect(screen.getByText('GPT-4o')).toBeInTheDocument()
      expect(screen.queryByText('gpt-4o-2024-08-06')).toBeNull()
      // title is name-only (with suffix, without ID)
      const option = document.querySelector('.ant-select-item-option')
      expect(option?.getAttribute('title')).toBe('GPT-4o | OpenAI')
      expect(option?.getAttribute('title')).not.toContain('gpt-4o-2024-08-06')
      // but filter via keywords still finds by ID
      const mockOption = {
        title: 'GPT-4o | OpenAI',
        keywords: 'GPT-4o gpt-4o-2024-08-06 OpenAI openai OpenAI',
        value: 'openai-gpt-4o-2024-08-06'
      }
      expect(modelSelectFilter('gpt-4o-2024-08-06', mockOption)).toBe(true)
      expect(modelSelectFilter('openai', mockOption)).toBe(true)
    })

    it('name-only distinguishes same name different id via provider suffix only (no ID inline)', () => {
      const providers: Provider[] = [
        {
          id: 'openai',
          name: 'OpenAI',
          type: 'openai',
          apiKey: '123',
          apiHost: 'https://api.openai.com',
          models: [
            { id: 'gpt-4o-a', name: 'GPT-4o', provider: 'openai', group: 'chat' } as any,
            { id: 'gpt-4o-b', name: 'GPT-4o', provider: 'openai', group: 'chat' } as any
          ]
        }
      ]
      render(<ModelSelector providers={providers} open />)
      const els = screen.getAllByText('GPT-4o')
      expect(els.length).toBe(2)
      // no inline IDs
      expect(screen.queryByText('gpt-4o-a')).toBeNull()
      expect(screen.queryByText('gpt-4o-b')).toBeNull()
      // but search still finds via keywords
      expect(
        modelSelectFilter('gpt-4o-a', { keywords: 'GPT-4o gpt-4o-a OpenAI openai', title: 'GPT-4o | OpenAI' })
      ).toBe(true)
    })

    it('does not show duplicate id when trimmed id == trimmed name (name-only always)', () => {
      const providers: Provider[] = [
        {
          id: 'openai',
          name: 'OpenAI',
          type: 'openai',
          apiKey: '123',
          apiHost: 'https://api.openai.com',
          models: [{ id: 'gpt-4o', name: 'gpt-4o', provider: 'openai', group: 'chat' } as any]
        }
      ]
      render(<ModelSelector providers={providers} open />)
      const el = screen.getByText('gpt-4o')
      const containerText = el.closest('.ant-select-item-option')?.textContent ?? ''
      expect(containerText).toContain('gpt-4o | OpenAI')
      expect((containerText.match(/gpt-4o/g) || []).length).toBe(1)
      const opt = document.querySelector('.ant-select-item-option')
      expect(opt?.getAttribute('title')).toBe('gpt-4o | OpenAI')
    })

    it('name-only: whitespace trimmed title remains name-only', () => {
      const providersTrimSame: Provider[] = [
        {
          id: 'openai',
          name: 'OpenAI',
          type: 'openai',
          apiKey: '123',
          apiHost: 'https://api.openai.com',
          models: [{ id: '  gpt-4o  ', name: 'gpt-4o', provider: 'openai', group: 'chat' } as any]
        }
      ]
      const { unmount } = render(<ModelSelector providers={providersTrimSame} open />)
      expect(screen.queryByText('  gpt-4o  ')).toBeNull()
      const opt = document.querySelector('.ant-select-item-option')
      expect(opt?.getAttribute('title')).toBe('gpt-4o | OpenAI')
      unmount()

      const providersDiff: Provider[] = [
        {
          id: 'openai',
          name: 'OpenAI',
          type: 'openai',
          apiKey: '123',
          apiHost: 'https://api.openai.com',
          models: [{ id: ' gpt-4o-1 ', name: ' GPT-4o ', provider: 'openai', group: 'chat' } as any]
        }
      ]
      render(<ModelSelector providers={providersDiff} open />)
      const el2 = document.querySelector('.ant-select-item-option')
      // title is name with spaces preserved? but should be name-only
      expect(el2?.getAttribute('title')).toBe(' GPT-4o  | OpenAI')
      expect(el2?.getAttribute('title')).not.toContain('gpt-4o-1')
    })

    it('case difference still name-only (case-sensitive)', () => {
      const providers: Provider[] = [
        {
          id: 'openai',
          name: 'OpenAI',
          type: 'openai',
          apiKey: '123',
          apiHost: 'https://api.openai.com',
          models: [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'chat' } as any]
        }
      ]
      render(<ModelSelector providers={providers} open />)
      expect(screen.getByText('GPT-4o')).toBeInTheDocument()
      expect(screen.queryByText('gpt-4o')).toBeNull()
    })

    it('keywords enable provider id/name search even when title name-only', () => {
      expect(
        modelSelectFilter('cohere', {
          title: 'embed-english-v3.0 | Cohere',
          keywords: 'embed-english-v3.0 embed-english-v3.0 Cohere cohere Cohere'
        })
      ).toBe(true)
      expect(
        modelSelectFilter('cohere', {
          title: 'embed-english-v3.0 | Cohere',
          keywords: 'embed-english-v3.0 embed-english-v3.0 Cohere cohere Cohere'
        })
      ).toBe(true)
    })
  })
})
