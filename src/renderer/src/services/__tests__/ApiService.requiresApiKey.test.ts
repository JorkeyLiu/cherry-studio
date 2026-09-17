import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type * as ConfigModelsModule from '@renderer/config/models'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reducer = combineReducers({ messageBlocks: messageBlocksSlice.reducer })
const createMockStore = () => configureStore({ reducer, middleware: (gdm) => gdm({ serializableCheck: false }) })
let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: unknown) => mockStore.dispatch(action as never)
  }
}))
vi.mock('@renderer/store/mcp', () => ({ hubMCPServer: { id: 'hub' } }))
vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@renderer/config/models', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModelsModule>()
  return {
    ...actual,
    isDedicatedImageGenerationModel: vi.fn(() => false),
    isEmbeddingModel: vi.fn(() => false),
    isFunctionCallingModel: vi.fn(() => false)
  }
})
vi.mock('@renderer/hooks/useSettings', () => ({ getStoreSetting: vi.fn(() => '') }))
vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: vi.fn(),
  getDefaultModel: vi.fn(),
  getProviderByModel: vi.fn(),
  getQuickModel: vi.fn()
}))
vi.mock('@renderer/utils/prompt', () => ({
  containsSupportedVariables: () => false,
  replacePromptVariables: vi.fn()
}))
vi.mock('@renderer/utils/analytics', () => ({ trackTokenUsage: vi.fn() }))
vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: () => ({ providerOptions: {}, standardParams: {} })
}))
vi.mock('@renderer/aiCore', () => ({
  AiProvider: class {
    getActualProvider() {
      return 'test-provider'
    }
    async completions() {
      return { getText: () => 'ok', usage: undefined }
    }
  }
}))

import { checkApiProvider, hasApiKey } from '../ApiService'

const baseProvider = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'conn-1',
    type: 'openai',
    name: 'My Connection',
    apiKey: '',
    apiHost: 'https://api.example.com',
    models: [{ id: 'm1', name: 'm1', provider: 'conn-1', group: 'g' }],
    ...overrides
  }) as any

beforeEach(() => {
  mockStore = createMockStore()
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    ...globalThis.window,
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
  } as any)
})

describe('hasApiKey honors the explicit per-connection option', () => {
  it('requires a key by default when the option is unset', () => {
    expect(hasApiKey(baseProvider({ apiKey: '' }))).toBe(false)
    expect(hasApiKey(baseProvider({ apiKey: 'sk-live' }))).toBe(true)
  })

  it('treats requiresApiKey:false as no-key even without a stored key', () => {
    expect(hasApiKey(baseProvider({ apiKey: '', apiOptions: { requiresApiKey: false } }))).toBe(true)
    expect(hasApiKey(baseProvider({ apiKey: 'sk-live', apiOptions: { requiresApiKey: false } }))).toBe(true)
  })

  it('treats explicit requiresApiKey:true like unset', () => {
    expect(hasApiKey(baseProvider({ apiKey: '', apiOptions: { requiresApiKey: true } }))).toBe(false)
    expect(hasApiKey(baseProvider({ apiKey: 'sk-live', apiOptions: { requiresApiKey: true } }))).toBe(true)
  })

  it('treats OAuth as no-key where applicable regardless of stored key', () => {
    expect(hasApiKey(baseProvider({ apiKey: '', authType: 'oauth', type: 'anthropic' }))).toBe(true)
  })

  it('uses the explicit option, not brand ids/types', () => {
    // Historical local brand id alone grants nothing without the explicit opt-out.
    expect(hasApiKey(baseProvider({ id: 'ollama', type: 'openai', apiKey: '' }))).toBe(false)
    expect(
      hasApiKey(baseProvider({ id: 'ollama', type: 'openai', apiKey: '', apiOptions: { requiresApiKey: false } }))
    ).toBe(true)
  })
})

describe('checkApiProvider honors the explicit per-connection option', () => {
  it('throws for a keyless default connection', () => {
    expect(() => checkApiProvider(baseProvider({ apiKey: '' }))).toThrow()
  })

  it('passes for a keyless connection with requiresApiKey:false', () => {
    expect(() => checkApiProvider(baseProvider({ apiKey: '', apiOptions: { requiresApiKey: false } }))).not.toThrow()
  })

  it('throws for a keyless connection with explicit requiresApiKey:true', () => {
    expect(() => checkApiProvider(baseProvider({ apiKey: '', apiOptions: { requiresApiKey: true } }))).toThrow()
  })

  it('passes for OAuth without a stored key', () => {
    expect(() => checkApiProvider(baseProvider({ apiKey: '', authType: 'oauth', type: 'anthropic' }))).not.toThrow()
  })

  it('still requires host and models even when no key is required', () => {
    expect(() =>
      checkApiProvider(baseProvider({ apiKey: '', apiOptions: { requiresApiKey: false }, apiHost: '' }))
    ).toThrow()
    expect(() =>
      checkApiProvider(baseProvider({ apiKey: '', apiOptions: { requiresApiKey: false }, models: [] }))
    ).toThrow()
  })
})
