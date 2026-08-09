/**
 * SelectModelButton focused renderer tests.
 *
 * Covers the display semantics of the assistant-level model selector:
 * - an unconfigured model (undefined) renders the neutral "Select Model" text
 *   and NO invalid tag;
 * - a stale configured model whose provider cannot resolve renders the invalid
 *   tag;
 * - a model whose provider resolves renders no invalid tag.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string) => key)
  const useAllProviders = vi.fn()
  const updateAssistant = vi.fn()
  const model: { model?: unknown } = { model: undefined }
  return { t, useAllProviders, updateAssistant, model }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ model: mocks.model.model, updateAssistant: mocks.updateAssistant })
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useAllProviders: mocks.useAllProviders
}))

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderName: () => ''
}))

vi.mock('@renderer/config/env', () => ({
  isLocalAi: false
}))

vi.mock('@renderer/config/models', () => ({
  isEmbeddingModel: () => false,
  isRerankModel: () => false,
  isWebSearchModel: () => false
}))

vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: { show: vi.fn() }
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
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

import SelectModelButton from '../SelectModelButton'

const assistant = (id = 'assistant-1') => ({ id, name: 'Assistant', prompt: '', topics: [], type: 'assistant' })

describe('SelectModelButton display semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.t.mockImplementation((key: string) => key)
    mocks.useAllProviders.mockReturnValue([])
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the neutral "Select Model" text when model is unconfigured', () => {
    mocks.model.model = undefined
    render(<SelectModelButton assistant={assistant()} />)
    expect(screen.getByText('button.select_model')).toBeInTheDocument()
  })

  it('shows NO invalid tag when model is unconfigured', () => {
    mocks.model.model = undefined
    render(<SelectModelButton assistant={assistant()} />)
    expect(screen.queryByText('models.invalid_model')).not.toBeInTheDocument()
  })

  it('shows no invalid tag when the model provider resolves', () => {
    mocks.useAllProviders.mockReturnValue([{ id: 'openai' }])
    mocks.model.model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }
    render(<SelectModelButton assistant={assistant()} />)
    expect(screen.queryByText('models.invalid_model')).not.toBeInTheDocument()
    expect(screen.getByText(/GPT-4o/)).toBeInTheDocument()
  })

  it('shows the invalid tag for a stale configured model whose provider cannot resolve', () => {
    mocks.useAllProviders.mockReturnValue([{ id: 'openai' }])
    mocks.model.model = { id: 'gpt-4o', name: 'GPT-4o', provider: 'removed-provider' }
    render(<SelectModelButton assistant={assistant()} />)
    expect(screen.getByText('models.invalid_model')).toBeInTheDocument()
  })
})
