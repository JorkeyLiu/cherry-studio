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
  // Full selection identity: same id served by different providers stays distinct.
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

const optionOf = (el: Element | null) => el?.closest('.ant-select-item-option') as HTMLElement | null

const inlineIdOf = (container: Element | null) =>
  container?.querySelector('[data-testid="model-name-with-id"] [title]') as HTMLElement | null

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

      // Grouped mode carries the provider in the group heading, so the redundant
      // per-option " | provider" suffix is gone.
      expect(optionOf(ada)?.textContent).not.toContain(' | OpenAI')
      expect(optionOf(cohere)?.textContent).not.toContain(' | Cohere')
      expect(optionOf(ada)?.getAttribute('title')).toBe('text-embedding-ada-002')

      // name == id: the ID is not repeated (shared house rule)
      expect(inlineIdOf(optionOf(ada))).toBeNull()

      // Check that filtered models are not present
      expect(screen.queryByText('GPT-4.1')).not.toBeInTheDocument()
      expect(screen.queryByText('rerank-english-v2.0')).not.toBeInTheDocument()
    })

    it('renders the muted monospace model ID inline when it differs from the name', () => {
      render(<ModelSelector providers={mockProviders} predicate={(model) => model.group === 'chat'} open />)

      const option = optionOf(screen.getByText('GPT-4.1'))
      const inlineId = inlineIdOf(option)

      expect(inlineId).not.toBeNull()
      expect(inlineId?.textContent).toBe('gpt-4.1')
      expect(inlineId?.getAttribute('title')).toBe('gpt-4.1')
      expect(inlineId?.className).toContain('font-mono')
      expect(inlineId?.className).toContain('text-[12px]')
      expect(inlineId?.className).toContain('text-[var(--color-text-3)]')
      expect(inlineId?.className).toContain('truncate')
      // title stays name-only (no provider suffix, no ID)
      expect(option?.getAttribute('title')).toBe('GPT-4.1')
      expect(option?.textContent).not.toContain(' | OpenAI')
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
      // Ungrouped consumers keep the provider suffix for differentiation
      expect(optionOf(ada)?.textContent).toContain(' | OpenAI')
      expect(optionOf(cohere)?.textContent).toContain(' | Cohere')
      expect(optionOf(ada)?.getAttribute('title')).toBe('text-embedding-ada-002 | OpenAI')

      // Check that filtered models are not present
      expect(screen.queryByText('GPT-4.1')).not.toBeInTheDocument()
      expect(screen.queryByText('rerank-english-v2.0')).not.toBeInTheDocument()
    })

    it('should hide suffix when showSuffix is false but keep the inline ID', () => {
      render(<ModelSelector providers={mockProviders} grouped={false} showSuffix={false} open />)

      const option = optionOf(screen.getByText('GPT-4.1'))
      expect(option?.textContent).toContain('GPT-4.1')
      expect(option?.textContent).not.toContain(' | OpenAI')
      expect(inlineIdOf(option)?.textContent).toBe('gpt-4.1')
      expect(option?.getAttribute('title')).toBe('GPT-4.1')
    })

    it('keeps same-name different-id models as separate, distinguishable rows', () => {
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
      render(<ModelSelector providers={providers} grouped={false} open />)

      expect(screen.getAllByText('GPT-4o')).toHaveLength(2)
      const options = Array.from(document.querySelectorAll('.ant-select-item-option'))
      expect(options).toHaveLength(2)
      expect(options.map((el) => inlineIdOf(el)?.textContent)).toEqual(['gpt-4o-a', 'gpt-4o-b'])
      // neither row is distinguishable by name alone; the ID is the differentiator
      expect(options.every((el) => el.textContent?.includes('GPT-4o'))).toBe(true)
    })
  })

  describe('selection identity', () => {
    it('selects by the full {id, provider} value, not by the display name', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
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

      render(<ModelSelector providers={providers} grouped={false} open onChange={onChange} />)

      await user.click(screen.getByText('gpt-4o-b'))

      expect(onChange).toHaveBeenCalledWith('openai-gpt-4o-b', expect.anything())
    })
  })

  describe('inline ID width budget', () => {
    it('keeps the inline ID shrinkable but never caps it at an arbitrary share of the row', () => {
      const longId = 'a-very-long-model-identifier-that-should-never-push-the-select-out-of-bounds'
      const providers: Provider[] = [
        {
          id: 'openai',
          name: 'OpenAI',
          type: 'openai',
          apiKey: '123',
          apiHost: 'https://api.openai.com',
          models: [{ id: longId, name: 'Long Model', provider: 'openai', group: 'chat' } as any]
        }
      ]

      render(<ModelSelector providers={providers} open />)

      const option = optionOf(screen.getByText('Long Model'))
      const inlineId = inlineIdOf(option)

      // the full ID always stays reachable
      expect(inlineId?.getAttribute('title')).toBe(longId)
      // shrink/ellipsis is available for genuinely long IDs...
      expect(inlineId?.className).toContain('truncate')
      expect(inlineId?.className).toContain('min-w-0')
      // ...but nothing caps it at a share of the row independent of the actual space
      expect(inlineId?.className).not.toContain('max-w-')
      expect(inlineId?.className).not.toContain('w-[50%]')
    })

    it('lets the name+ID group fill the option row instead of sizing to its own content', () => {
      render(<ModelSelector providers={mockProviders} predicate={(model) => model.group === 'chat'} open />)

      const option = optionOf(screen.getByText('GPT-4.1'))
      const group = option?.querySelector('[data-testid="model-name-with-id"]') as HTMLElement | null
      const nameLine = group?.firstElementChild as HTMLElement | null

      // the composite grows into the row...
      expect(group?.className).toContain('flex-1')
      expect(group?.className).toContain('min-w-0')
      // ...and the name never surrenders width while the ID has room to shrink
      expect(nameLine?.className).toContain('shrink-0')
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

    it('does not repeat the ID when trimmed id == trimmed name', () => {
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

      const option = optionOf(screen.getByText('gpt-4o'))
      expect(inlineIdOf(option)).toBeNull()
      expect(option?.textContent?.match(/gpt-4o/g)).toHaveLength(1)
    })

    it('shows the ID when only the case differs (case-sensitive)', () => {
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

      expect(inlineIdOf(optionOf(screen.getByText('GPT-4o')))?.textContent).toBe('gpt-4o')
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

    it('matches the exact model id via keywords even though the title is name-only', () => {
      const mockOption = {
        title: 'GPT-4o | OpenAI',
        keywords: 'GPT-4o gpt-4o-2024-08-06 OpenAI openai OpenAI',
        value: 'openai-gpt-4o-2024-08-06'
      }
      expect(modelSelectFilter('gpt-4o-2024-08-06', mockOption)).toBe(true)
      expect(modelSelectFilter('openai', mockOption)).toBe(true)
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

    it('filters by exact model ID through the explicit keywords', async () => {
      const user = userEvent.setup()
      render(<ModelSelector providers={mockProviders} open />)

      const searchInput = screen.getByRole('combobox')
      await user.type(searchInput, 'gpt-4.1')

      expect(screen.getByText('GPT-4.1')).toBeInTheDocument()
      expect(screen.queryByText('text-embedding-ada-002')).not.toBeInTheDocument()
      expect(screen.queryByText('embed-english-v3.0')).not.toBeInTheDocument()
    })
  })
})
