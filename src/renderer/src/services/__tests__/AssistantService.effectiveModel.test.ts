// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeGetState: vi.fn(() => ({ llm: { defaultModel: undefined } }))
}))

vi.mock('@renderer/store', () => ({
  default: { getState: mocks.storeGetState, dispatch: vi.fn() }
}))
vi.mock('@renderer/hooks/useStore', () => ({
  getStoreProviders: vi.fn(() => []),
  useStoreProviders: vi.fn()
}))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))

import { getDefaultModel } from '../AssistantService'

describe('AssistantService.getDefaultModel projection normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeGetState.mockReturnValue({ llm: { defaultModel: undefined } })
  })

  it('absent global default stays unconfigured', () => {
    expect(getDefaultModel()).toBeUndefined()
  })

  it('malformed persisted global defaults read as unconfigured without coercion', () => {
    const malformed = [
      {},
      { id: undefined, provider: 'p' },
      { id: '', provider: 'p' },
      { id: 'm', provider: '' },
      { id: 1, provider: 'p' }
    ]
    for (const model of malformed) {
      mocks.storeGetState.mockReturnValue({ llm: { defaultModel: model } })
      expect(getDefaultModel()).toBeUndefined()
    }
  })

  it('valid serving model with missing display/group stays accepted with identity preserved', () => {
    const minimal = { id: 'custom-id', provider: 'custom-conn' }
    mocks.storeGetState.mockReturnValue({ llm: { defaultModel: minimal } })
    expect(getDefaultModel()).toBe(minimal)
    const full = { id: 'gpt-4o', provider: 'openai', name: 'GPT', group: 'g' }
    mocks.storeGetState.mockReturnValue({ llm: { defaultModel: full } })
    expect(getDefaultModel()).toBe(full)
  })
})
