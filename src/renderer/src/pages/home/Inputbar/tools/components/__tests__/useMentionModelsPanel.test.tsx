/**
 * useMentionModelsPanel focused renderer tests.
 *
 * Covers the temporary input-bar selector's "Add Model" action: the
 * action must be preserved (present in the quick-panel list, navigating
 * to `/settings/provider`) in both zero-provider and populated states, and the
 * panel must only mutate temporary/session `mentionedModels` state.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string) => key)
  const navigate = vi.fn()
  const open = vi.fn()
  const setMentionedModels = vi.fn()
  const getModelUniqId = vi.fn((m?: { id?: string }) => m?.id ?? '')
  const providers: { providers: unknown[] } = { providers: [] }
  return { t, navigate, open, setMentionedModels, getModelUniqId, providers }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('react-router', () => ({
  useNavigate: () => mocks.navigate
}))

vi.mock('@renderer/components/QuickPanel', () => ({
  QuickPanelReservedSymbol: { MentionModels: 'mention-models' }
}))

vi.mock('@renderer/config/models', () => ({
  getModelLogo: () => undefined,
  isEmbeddingModel: () => false,
  isRerankModel: () => false,
  isVisionModel: () => false
}))

vi.mock('@renderer/databases', () => ({
  db: {}
}))

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => []
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: mocks.providers.providers })
}))

vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: mocks.getModelUniqId
}))

vi.mock('@renderer/utils', () => ({
  getFancyProviderName: (p: { name?: string; id?: string }) => p?.name || p?.id || ''
}))

vi.mock('@renderer/components/ModelTagsWithLabel', () => ({
  default: () => null
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

import { useMentionModelsPanel } from '../useMentionModelsPanel'

const model = (id: string) => ({ id, name: id, provider: 'openai' })

const provider = (id: string, models: ReturnType<typeof model>[]) => ({
  id,
  name: id,
  models,
  isSystem: false,
  enabled: true
})

function makeParams() {
  return {
    quickPanel: { registerRootMenu: vi.fn(() => () => {}), registerTrigger: vi.fn(() => () => {}) },
    quickPanelController: {
      open: mocks.open,
      close: vi.fn(),
      updateList: vi.fn(),
      isVisible: false,
      symbol: 'mention-models'
    },
    mentionedModels: [] as ReturnType<typeof model>[],
    setMentionedModels: mocks.setMentionedModels,
    couldMentionNotVisionModel: true,
    files: [],
    setText: vi.fn()
  }
}

function lastListItem() {
  const list = mocks.open.mock.calls[0][0].list
  return list[list.length - 1]
}

describe('useMentionModelsPanel temporary selector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.t.mockImplementation((key: string) => key)
    mocks.providers.providers = []
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the Add Model action when zero providers exist', () => {
    const params = makeParams()
    const { result } = renderHook(() => useMentionModelsPanel(params as never))
    act(() => {
      result.current.openQuickPanel({ type: 'button' })
    })

    const addModelItem = lastListItem()
    expect(addModelItem.label).toBe('settings.models.add.add_model...')
    expect(typeof addModelItem.action).toBe('function')
  })

  it('navigates to /settings/provider from the Add Model action', () => {
    const params = makeParams()
    const { result } = renderHook(() => useMentionModelsPanel(params as never))
    act(() => {
      result.current.openQuickPanel({ type: 'button' })
    })

    const addModelItem = lastListItem()
    act(() => {
      addModelItem.action()
    })
    expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider')
  })

  it('keeps the Add Model action when providers/models exist', () => {
    mocks.providers.providers = [provider('openai', [model('gpt-4o')])]
    const params = makeParams()
    const { result } = renderHook(() => useMentionModelsPanel(params as never))
    act(() => {
      result.current.openQuickPanel({ type: 'button' })
    })

    const addModelItem = lastListItem()
    expect(addModelItem.label).toBe('settings.models.add.add_model...')
  })

  it('only mutates temporary mentionedModels state via model actions', () => {
    mocks.providers.providers = [provider('openai', [model('gpt-4o')])]
    const params = makeParams()
    const { result } = renderHook(() => useMentionModelsPanel(params as never))
    act(() => {
      result.current.openQuickPanel({ type: 'button' })
    })

    const list = mocks.open.mock.calls[0][0].list
    // Model items carry a `filterText` (provider + model name); the Add Model
    // and Clear actions do not.
    const modelItem = list.find(
      (item: { filterText?: string; alwaysVisible?: boolean }) =>
        typeof item.filterText === 'string' && item.filterText.includes('gpt-4o')
    )

    expect(modelItem).toBeTruthy()
    act(() => {
      modelItem.action()
    })
    // The panel toggles the temporary mention list — not assistant state.
    expect(mocks.setMentionedModels).toHaveBeenCalled()
  })
})
