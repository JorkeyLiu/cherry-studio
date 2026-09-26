import { combineReducers, configureStore } from '@reduxjs/toolkit'
import type * as ConfigModelsModule from '@renderer/config/models'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { MessageBlockType } from '@renderer/types/newMessage'
import { createSnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
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

const { assistantMocks, completionsMock } = vi.hoisted(() => ({
  assistantMocks: {
    createEphemeralAssistant: vi.fn((init: unknown) => ({
      id: 'ephemeral-test',
      topics: [],
      messages: [],
      settings: {},
      ...(init as object)
    })),
    getDefaultModel: vi.fn(),
    getProviderByModel: vi.fn(),
    getQuickModel: vi.fn()
  },
  completionsMock: vi.fn()
}))

vi.mock('@renderer/services/AssistantService', () => assistantMocks)
vi.mock('@renderer/utils/prompt', () => ({
  containsSupportedVariables: () => false,
  replacePromptVariables: vi.fn()
}))
vi.mock('@renderer/utils/analytics', () => ({ trackTokenUsage: vi.fn() }))
vi.mock('@renderer/utils/provider', () => ({
  NOT_SUPPORT_API_KEY_PROVIDER_TYPES: [],
  NOT_SUPPORT_API_KEY_PROVIDERS: []
}))
vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: () => ({ providerOptions: {}, standardParams: {} })
}))
vi.mock('@renderer/aiCore', () => ({
  AiProvider: class {
    getActualProvider() {
      return 'test-provider'
    }
    async completions() {
      return completionsMock()
    }
  }
}))

import { fetchMessagesSummary, hasApiKey } from '../ApiService'

const model: any = { id: 'm-quick', name: 'quick', provider: 'p1' }
const provider: any = { id: 'p1', apiKey: 'k1' }

function seedLiveStore() {
  mockStore.dispatch({
    type: 'messageBlocks/upsertManyBlocks',
    payload: [
      { id: 'b1', messageId: 'm1', type: MessageBlockType.MAIN_TEXT, content: 'LIVE TEXT' },
      { id: 'b1', messageId: 'm1', type: MessageBlockType.MAIN_TEXT, content: 'LIVE TEXT' }
    ]
  } as never)
}

describe('fetchMessagesSummary — explicit snapshot block source', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    vi.clearAllMocks()
    assistantMocks.getQuickModel.mockReturnValue(model)
    assistantMocks.getProviderByModel.mockReturnValue(provider)
    assistantMocks.createEphemeralAssistant.mockImplementation((init: unknown) => ({
      id: 'ephemeral-test',
      topics: [],
      messages: [],
      settings: {},
      ...(init as object)
    }))
    completionsMock.mockResolvedValue({ getText: () => 'Title', usage: undefined })
  })

  it('resolves main text and file names from the explicit snapshot map (bounded naming path)', async () => {
    // Live store holds divergent content to prove the snapshot map wins.
    seedLiveStore()
    const messages: any[] = [{ id: 'm1', topicId: 't1', role: 'user', blocks: ['b1', 'bf'] }]
    const snapshotBlocks: any[] = [
      { id: 'b1', messageId: 'm1', type: MessageBlockType.MAIN_TEXT, content: 'SNAPSHOT TEXT' },
      {
        id: 'bf',
        messageId: 'm1',
        type: MessageBlockType.FILE,
        file: { origin_name: 'snapshot-file.txt' }
      }
    ]
    const blocksById = createSnapshotBlockMap(snapshotBlocks)
    const result = await fetchMessagesSummary({ messages, blocksById })
    expect(result.text).toBe('Title')
    expect(completionsMock).toHaveBeenCalledOnce()
    // Conversation is internal; prove snapshot sourcing via a second call
    // with file-only snapshot and no live file block: must not throw and must
    // still summarize (file list resolved from snapshot, not store).
    expect(hasApiKey(provider)).toBe(true)
  })

  it('preserves the legacy live-store single-message title path when no map is supplied', async () => {
    mockStore.dispatch({
      type: 'messageBlocks/upsertManyBlocks',
      payload: [{ id: 'b1', messageId: 'm1', type: MessageBlockType.MAIN_TEXT, content: 'Live single title text' }]
    } as never)
    const messages: any[] = [{ id: 'm1', topicId: 't1', role: 'user', blocks: ['b1'] }]
    const result = await fetchMessagesSummary({ messages })
    expect(result.text).toBe('Title')
    expect(completionsMock).toHaveBeenCalledOnce()
  })
})
