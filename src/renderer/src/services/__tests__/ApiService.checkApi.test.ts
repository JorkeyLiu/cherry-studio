import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type AiProvider from '@renderer/aiCore/AiProvider'
import type * as ConfigModelsModule from '@renderer/config/models'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type * as UtilsModule from '@renderer/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type CompletionsArgs = Parameters<AiProvider['completions']>

const reducer = combineReducers({ messageBlocks: messageBlocksSlice.reducer })
const createMockStore = () => configureStore({ reducer, middleware: (gdm) => gdm({ serializableCheck: false }) })
let mockStore: ReturnType<typeof createMockStore>

const mockCompletions = vi.hoisted(() =>
  vi.fn(async (..._args: CompletionsArgs) => {
    void _args
    return { getText: () => 'ok', usage: undefined }
  })
)

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
  getDefaultAssistant: vi.fn(() => ({
    id: 'assistant-check',
    name: 'Check Assistant',
    prompt: 'test',
    topics: [],
    messages: [],
    type: 'assistant',
    mcpMode: 'disabled',
    settings: {},
    model: undefined
  })),
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
    async completions(...args: CompletionsArgs) {
      return mockCompletions(...args)
    }
    async getEmbeddingDimensions() {
      return 1
    }
  }
}))
vi.mock('@renderer/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsModule>()
  return {
    ...actual,
    uuid: () => 'check-abort-uuid-1'
  }
})

import { OPENCODE_SESSION_HEADER } from '@renderer/aiCore/prepareParams/header'

import { checkApi } from '../ApiService'

const baseProvider = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'conn-1',
    type: 'openai',
    name: 'My Connection',
    // Fake key for tests only; never a real user secret.
    apiKey: 'sk-fake-check-key',
    apiHost: 'https://api.example.com',
    models: [{ id: 'm1', name: 'm1', provider: 'conn-1', group: 'g' }],
    ...overrides
  }) as any

const checkModel = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'some-model',
    name: 'Some Model',
    provider: 'conn-1',
    group: 'g',
    ...overrides
  }) as any

function sessionHeaderOf(params: any): string | undefined {
  const headers = params?.headers as Record<string, string | undefined> | undefined
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === OPENCODE_SESSION_HEADER)
  return key ? headers[key] : undefined
}

beforeEach(() => {
  mockStore = createMockStore()
  mockCompletions.mockClear()
  vi.stubGlobal('window', {
    ...globalThis.window,
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
  } as any)
})

describe('checkApi OpenCode Go session header wiring', () => {
  it('sends the synthetic per-check session header on the Go endpoint', async () => {
    const provider = baseProvider({
      id: 'opencode-go',
      name: 'OpenCode Go',
      apiHost: 'https://opencode.ai/zen/go/v1'
    })
    const model = checkModel({ id: 'some-model-behind-go', provider: 'opencode-go' })

    await checkApi(provider, model)

    expect(mockCompletions).toHaveBeenCalledTimes(1)
    const params = mockCompletions.mock.calls[0]?.[1] as any
    // The single check request reuses its own abortId as the synthetic
    // session id (mocked uuid), stable within this one request.
    expect(sessionHeaderOf(params)).toBe('check-abort-uuid-1')
  })

  it('uses the synthetic check id rather than user/provider/model content', async () => {
    const provider = baseProvider({
      id: 'opencode-go',
      name: 'OpenCode Go',
      apiHost: 'https://opencode.ai/zen/go'
    })
    const model = checkModel({ id: 'go-model-id', name: 'Go Model Name', provider: 'opencode-go' })

    await checkApi(provider, model)

    const params = mockCompletions.mock.calls[0]?.[1] as any
    const value = sessionHeaderOf(params) ?? ''
    expect(value).toBe('check-abort-uuid-1')
    expect(value).not.toContain('go-model-id')
    expect(value).not.toContain('Go Model Name')
    expect(value).not.toContain('OpenCode Go')
  })

  it('sends no session header for non-OpenCode hosts', async () => {
    const provider = baseProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      apiHost: 'https://api.deepseek.com/v1'
    })
    const model = checkModel({ id: 'deepseek-chat', provider: 'deepseek' })

    await checkApi(provider, model)

    expect(mockCompletions).toHaveBeenCalledTimes(1)
    const params = mockCompletions.mock.calls[0]?.[1] as any
    expect(sessionHeaderOf(params)).toBeUndefined()
    // Non-Go behavior is unchanged: no headers object is fabricated.
    expect(params?.headers?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
  })
})
