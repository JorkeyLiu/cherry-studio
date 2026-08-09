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
  const getModelUniqId = vi.fn((m?: { id?: string }) => m?.id ?? '')
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
  getModelLogo: () => undefined,
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

vi.mock('@renderer/components/ModelTagsWithLabel', () => ({
  default: () => null
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
})
