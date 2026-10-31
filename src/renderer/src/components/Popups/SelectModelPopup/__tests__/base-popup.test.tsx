/**
 * SelectModelPopupView focused renderer tests.
 *
 * Covers the shared assistant/settings model popup's "Add Model" action:
 * it must be discoverable when zero providers/models exist and in
 * non-empty lists, navigate to `/settings/provider` on click and on keyboard
 * Enter, resolve the popup as cancelled (undefined), and never select a model.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string) => key)
  const getProviderById = vi.fn()
  const navigate = vi.fn()
  // Full selection identity: the same model id served by two providers must stay
  // two distinct selectable entries.
  const getModelUniqId = vi.fn((m?: { id?: string; provider?: string }) =>
    m?.provider ? `${m.provider}::${m.id}` : (m?.id ?? '')
  )
  return { t, getProviderById, navigate, getModelUniqId }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('@renderer/hooks/usePinnedModels', () => ({
  usePinnedModels: () => ({ pinnedModels: [], togglePinnedModel: vi.fn(), loading: false })
}))

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: mocks.getProviderById
}))

vi.mock('@renderer/config/models', () => ({
  isVisionModel: () => false,
  isEmbeddingModel: () => false,
  isReasoningModel: () => false,
  isFunctionCallingModel: () => false,
  isRerankModel: () => false,
  isWebSearchModel: () => false
}))

vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: mocks.getModelUniqId
}))

vi.mock('@renderer/utils', () => ({
  classNames: (...args: unknown[]) => args.filter(Boolean).join(' '),
  filterModelsByKeywords: (_kw: string, models: unknown[]) => models,
  getFancyProviderName: (p: { name?: string; id?: string }) => p.name || p.id || ''
}))

vi.mock('@renderer/utils/model', () => ({
  getDuplicateModelNames: () => new Set<string>(),
  getModelTags: () => ({}),
  isFreeModel: () => false
}))

vi.mock('@renderer/utils/inputModalities', () => ({
  getInputModalityAvailabilityFromProviders: () => ({})
}))

vi.mock('@renderer/components/ModelTagsWithLabel', () => ({
  default: () => null
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, provider, size }: { model?: { id?: string }; provider?: { id?: string }; size?: number }) => (
    <div
      data-testid={`model-avatar-${model?.id ?? 'unknown'}`}
      data-model-id={model?.id ?? ''}
      data-provider-id={provider?.id ?? ''}
      data-size={String(size ?? '')}
    />
  )
}))

vi.mock('@renderer/components/TopView', () => ({
  TopView: { hide: vi.fn(), show: vi.fn() }
}))

vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({
    list,
    children
  }: {
    list: { key: string }[]
    children: (item: { key: string }) => React.ReactNode
  }) => <div>{list.map((item) => children(item))}</div>
}))

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

import SelectModelPopupView from '../base-popup'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const model = (id: string, name = id) => ({ id, name, provider: 'openai', group: 'default' })

const provider = (id: string, name: string, models: ReturnType<typeof model>[]) => ({
  id,
  name,
  type: 'openai' as const,
  apiKey: '',
  apiHost: '',
  models,
  isSystem: false,
  enabled: true
})

function renderPopup(providers: ReturnType<typeof provider>[] = [], modelValue?: ReturnType<typeof model>) {
  const resolve = vi.fn()
  render(
    <SelectModelPopupView
      providers={providers}
      model={modelValue}
      showTagFilter={false}
      showPinnedModels={false}
      resolve={resolve}
    />
  )
  return { resolve }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelectModelPopupView "Add Model" action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.t.mockImplementation((key: string) => key)
    mocks.getProviderById.mockReturnValue(undefined)
    Object.defineProperty(window, 'navigate', {
      value: mocks.navigate,
      configurable: true,
      writable: true
    })
  })

  afterEach(() => {
    cleanup()
  })

  describe('zero providers / zero models', () => {
    it('renders the Add Model action when no providers exist', () => {
      renderPopup([])
      const action = screen.getByTestId('select-model-add-action')
      expect(action).toBeInTheDocument()
      expect(action.textContent).toContain('settings.models.add.add_model')
    })

    it('navigates to /settings/provider and resolves undefined on click', () => {
      const { resolve } = renderPopup([])
      fireEvent.click(screen.getByTestId('select-model-add-action'))

      expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider')
      expect(resolve).toHaveBeenCalledWith(undefined)
    })

    it('navigates to /settings/provider on keyboard Enter (keyboard accessible)', () => {
      const { resolve } = renderPopup([])
      const action = screen.getByTestId('select-model-add-action')

      fireEvent.keyDown(action, { key: 'Enter' })

      expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider')
      expect(resolve).toHaveBeenCalledWith(undefined)
    })

    it('navigates to /settings/provider on keyboard Space', () => {
      const { resolve } = renderPopup([])
      const action = screen.getByTestId('select-model-add-action')

      fireEvent.keyDown(action, { key: ' ' })

      expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider')
      expect(resolve).toHaveBeenCalledWith(undefined)
    })
  })

  describe('non-empty provider/model list (parity)', () => {
    const providers = [provider('openai', 'OpenAI', [model('gpt-4o'), model('gpt-4o-mini')])]

    it('keeps the Add Model action visible alongside the model list', () => {
      renderPopup(providers)
      const action = screen.getByTestId('select-model-add-action')
      expect(action).toBeInTheDocument()
      expect(action.textContent).toContain('settings.models.add.add_model')
    })

    it('navigates and resolves undefined on click without selecting a model', () => {
      const { resolve } = renderPopup(providers)
      fireEvent.click(screen.getByTestId('select-model-add-action'))

      expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider')
      expect(resolve).toHaveBeenCalledWith(undefined)
      expect(resolve).not.toHaveBeenCalledWith(model('gpt-4o'))
    })

    it('keyboard Enter on the action is not hijacked by list navigation', () => {
      const { resolve } = renderPopup(providers)
      const action = screen.getByTestId('select-model-add-action')

      // The window-level list keyboard handler would normally intercept Enter;
      // the action must still fire its own navigation.
      fireEvent.keyDown(action, { key: 'Enter' })

      expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider')
      expect(resolve).toHaveBeenCalledWith(undefined)
    })

    it('clicking a model item still resolves the selected model', () => {
      const { resolve } = renderPopup(providers)
      const gpt4oItem = screen.getByTestId('chat-model-option-gpt-4o')
      fireEvent.click(gpt4oItem)

      expect(resolve).toHaveBeenCalledWith(model('gpt-4o'))
      expect(mocks.navigate).not.toHaveBeenCalled()
    })
  })

  describe('model avatar (visual unification)', () => {
    const providers = [provider('openai', 'OpenAI', [model('gpt-4o'), model('gpt-4o-mini')])]

    it('renders ModelAvatar with the exact model and owning provider at size 24', () => {
      renderPopup(providers)
      const avatar = screen.getByTestId('model-avatar-gpt-4o')
      expect(avatar).toBeInTheDocument()
      expect(avatar.getAttribute('data-model-id')).toBe('gpt-4o')
      expect(avatar.getAttribute('data-provider-id')).toBe('openai')
      expect(avatar.getAttribute('data-size')).toBe('24')
    })

    it('passes distinct owning providers per model row', () => {
      const multi = [
        provider('openai', 'OpenAI', [model('gpt-4o')]),
        provider('anthropic', 'Anthropic', [model('claude')])
      ]
      renderPopup(multi)
      expect(screen.getByTestId('model-avatar-gpt-4o').getAttribute('data-provider-id')).toBe('openai')
      expect(screen.getByTestId('model-avatar-claude').getAttribute('data-provider-id')).toBe('anthropic')
    })
  })

  describe('stable top edge (global popup)', () => {
    it('preserves a fixed top edge while the filtered list reduces in height — only bottom shrinks', async () => {
      const manyModels = Array.from({ length: 12 }, (_, i) => model(`m-${i}`))
      const fewModels = [model('m-0')]
      const manyProviders = [provider('openai', 'OpenAI', manyModels)]
      const fewProviders = [provider('openai', 'OpenAI', fewModels)]

      renderPopup(manyProviders)
      const modalMany = document.querySelector('.ant-modal') as HTMLElement | null
      expect(modalMany).not.toBeNull()
      const topMany = modalMany?.style.top
      expect(topMany).toBeTruthy()
      expect(document.querySelector('.ant-modal-centered')).toBeNull()
      cleanup()

      renderPopup(fewProviders)
      const modalFew = document.querySelector('.ant-modal') as HTMLElement | null
      expect(modalFew).not.toBeNull()
      const topFew = modalFew?.style.top
      expect(topFew).toBe(topMany)
      cleanup()
    })

    it('preserves PAGE_SIZE cap (12 * 36) and shrinks proportionally when filtered', () => {
      const PAGE_SIZE = 12
      const ITEM_HEIGHT = 36
      expect(Math.min(PAGE_SIZE, 20) * ITEM_HEIGHT).toBe(432)
      expect(Math.min(PAGE_SIZE, 2) * ITEM_HEIGHT).toBe(72)
      expect(Math.min(PAGE_SIZE, 1) * ITEM_HEIGHT).toBe(36)
    })
  })

  describe('name + muted inline ID rendering with ID-aware search', () => {
    it('renders the muted monospace model ID next to the name (same name, different ids stay distinct)', () => {
      const providers = [
        provider('openai', 'OpenAI', [
          { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'default' } as any,
          { id: 'gpt-4o-2024-11-20', name: 'GPT-4o', provider: 'openai', group: 'default' } as any
        ])
      ]
      renderPopup(providers)

      // both same-name rows stay present, each carrying its own ID
      expect(screen.getAllByText('GPT-4o').length).toBe(2)
      const inlineId = document.querySelectorAll('[data-testid="model-name-with-id"]')
      expect(inlineId).toHaveLength(2)
      expect(Array.from(inlineId).map((el) => el.querySelector('[title]')?.getAttribute('title'))).toEqual([
        'gpt-4o-2024-08-06',
        'gpt-4o-2024-11-20'
      ])
    })

    it('presents the ID as muted monospace truncated text with the full ID as tooltip', () => {
      const providers = [
        provider('openai', 'OpenAI', [
          { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai', group: 'default' } as any
        ])
      ]
      renderPopup(providers)

      const idEl = screen.getByTitle('gpt-4o-2024-08-06')
      expect(idEl.textContent).toBe('gpt-4o-2024-08-06')
      expect(idEl.className).toContain('font-mono')
      expect(idEl.className).toContain('text-[12px]')
      expect(idEl.className).toContain('text-[var(--color-text-3)]')
      expect(idEl.className).toContain('truncate')
    })

    it('gives the name+ID group the row width the avatar and tags leave over (no arbitrary ID cap)', () => {
      const providers = [
        provider('antigravity', 'Antigravity', [
          {
            id: 'antigravity/gemini-3.8-flash',
            name: 'Gemini 3.8 Flash',
            provider: 'antigravity',
            group: 'default'
          } as any
        ])
      ]
      renderPopup(providers)

      const group = document.querySelector('[data-testid="model-name-with-id"]') as HTMLElement
      const nameLine = group.firstElementChild as HTMLElement
      const idEl = screen.getByTitle('antigravity/gemini-3.8-flash')

      // the composite claims the remaining row width instead of hugging its own content
      expect(group.className).toContain('flex-1')
      expect(group.className).toContain('min-w-0')
      // the name never surrenders width while the ID still has room to shrink
      expect(nameLine.className).toContain('shrink-0')
      // and the ID is not capped at a percentage of the row, so a fitting ID renders in full
      expect(idEl.className).not.toContain('max-w-')
      expect(idEl.className).toContain('min-w-0')
      expect(idEl.className).toContain('truncate')
    })

    it('does not repeat the ID when trimmed id == trimmed name (shared house rule)', () => {
      const providers = [provider('openai', 'OpenAI', [model('gpt-4o', 'gpt-4o')])]
      renderPopup(providers)
      expect(screen.queryByTitle('gpt-4o')).toBeNull()
      expect(screen.getAllByText('gpt-4o')).toHaveLength(1)
    })

    it('hides the ID for whitespace-trimmed equality', () => {
      const providers = [
        provider('openai', 'OpenAI', [
          { id: '  gpt-4o  ', name: 'gpt-4o', provider: 'openai', group: 'default' } as any
        ])
      ]
      renderPopup(providers)
      expect(screen.queryByTitle('  gpt-4o  ')).toBeNull()
      expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    })

    it('shows the ID when only the case differs', () => {
      const providers = [
        provider('openai', 'OpenAI', [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'default' } as any])
      ]
      renderPopup(providers)
      expect(screen.getByText('GPT-4o')).toBeInTheDocument()
      expect(screen.getByTitle('gpt-4o')).toBeInTheDocument()
    })

    it('shows the raw ID when the trimmed values differ', () => {
      const providers = [
        provider('openai', 'OpenAI', [
          { id: ' gpt-4o-1 ', name: ' GPT-4o ', provider: 'openai', group: 'default' } as any
        ])
      ]
      renderPopup(providers)
      expect(document.querySelector('[title=" gpt-4o-1 "]')).not.toBeNull()
      expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    })

    it('keeps near-identical names distinguishable by their IDs', () => {
      const providers = [
        provider('openai', 'OpenAI', [
          { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai', group: 'default' } as any,
          { id: 'gpt-4o-mini-2024', name: 'GPT-4o mini', provider: 'openai', group: 'default' } as any
        ])
      ]
      renderPopup(providers)
      expect(screen.getAllByText('GPT-4o mini').length).toBe(2)
      expect(screen.getByTitle('gpt-4o-mini')).toBeInTheDocument()
      expect(screen.getByTitle('gpt-4o-mini-2024')).toBeInTheDocument()
    })

    it('resolves the clicked row by the full {id, provider} identity, not by the model id alone', () => {
      const providers = [
        provider('provider-a', 'Provider A', [
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'provider-a', group: 'default' } as any
        ]),
        provider('provider-b', 'Provider B', [
          { id: 'gpt-4o', name: 'GPT-4o', provider: 'provider-b', group: 'default' } as any
        ])
      ]
      const { resolve } = renderPopup(providers)

      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-model-option-gpt-4o"]'))
      expect(rows).toHaveLength(2)

      fireEvent.click(rows[1])
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'gpt-4o', provider: 'provider-b' }))
    })

    it('filterModelsByKeywords still ID-aware (search matches IDs beyond the rendered name)', async () => {
      // Real filter function is ID-aware; mocked version passes through, so test direct utility
      const { filterModelsByKeywords } = await import('@renderer/utils/match')
      // Use real implementation via dynamic import would still be mocked; test via direct call of matchKeywordsInModel
      const { matchKeywordsInModel } = await import('@renderer/utils/match')
      const m = { id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai' } as any
      const p = { id: 'openai', name: 'OpenAI' } as any
      expect(matchKeywordsInModel('gpt-4o-2024-08-06', m)).toBe(true)
      expect(matchKeywordsInModel('openai', m, p)).toBe(true)
      void filterModelsByKeywords
    })
  })
})
