import type { Topic } from '@renderer/types'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---------------------------------------------------------------

const mockDispatch = vi.fn()
const mockPersist = vi.fn()

vi.mock('@renderer/store', () => ({
  default: { getState: vi.fn() },
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (s: any) => unknown) => selector(fakeState),
  useAppStore: () => ({})
}))

vi.mock('@renderer/config/models', () => ({
  getThinkModelType: () => 'default',
  isSupportedReasoningEffortModel: () => false,
  isSupportedThinkingTokenModel: () => false,
  MODEL_SUPPORTED_OPTIONS: {},
  MODEL_SUPPORTED_REASONING_EFFORT: {}
}))

vi.mock('@renderer/databases', () => ({
  db: { topics: { add: vi.fn() } }
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultTopic: () => ({ id: 'default-topic', name: 'Default', messages: [] })
}))

vi.mock('@renderer/store/assistants', () => ({
  addAssistant: vi.fn((p) => ({ type: 'addAssistant', p })),
  addTopic: vi.fn((p) => ({ type: 'addTopic', p })),
  addTopicFromTrash: vi.fn((p) => ({ type: 'addTopicFromTrash', p })),
  insertAssistant: vi.fn((p) => ({ type: 'insertAssistant', p })),
  removeAllTopics: vi.fn((p) => ({ type: 'removeAllTopics', p })),
  removeAssistant: vi.fn((p) => ({ type: 'removeAssistant', p })),
  removeTopic: vi.fn((p) => ({ type: 'removeTopic', p })),
  setModel: vi.fn((p) => ({ type: 'setModel', p })),
  updateAssistant: vi.fn((p) => ({ type: 'updateAssistant', p })),
  updateAssistants: vi.fn((p) => ({ type: 'updateAssistants', p })),
  updateAssistantSettings: vi.fn((p) => ({ type: 'updateAssistantSettings', p })),
  updateDefaultAssistant: vi.fn((p) => ({ type: 'updateDefaultAssistant', p })),
  updateTopic: vi.fn((p) => ({ type: 'assistants/updateTopic', p })),
  updateTopics: vi.fn((p) => ({ type: 'updateTopics', p }))
}))

vi.mock('@renderer/store/llm', () => ({
  setDefaultModel: vi.fn((p) => ({ type: 'setDefaultModel', p })),
  setQuickModel: vi.fn((p) => ({ type: 'setQuickModel', p })),
  setTranslateModel: vi.fn((p) => ({ type: 'setTranslateModel', p }))
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: { removeTopic: vi.fn() }
}))

vi.mock('@renderer/services/db/topicMetadataPersist', () => ({
  persistTopicMetadata: (...args: unknown[]) => mockPersist(...args)
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  ensureOrdinaryTopicOwnership: vi.fn(),
  softDeleteOrdinaryTopic: vi.fn(),
  restoreOrdinaryTopic: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock('@renderer/utils', () => ({
  uuid: () => 'uuid-1'
}))

// --- Fixtures -------------------------------------------------------------

const assistant = {
  id: 'a-1',
  name: 'Assistant',
  model: { id: 'm-1', provider: 'openai' },
  settings: undefined,
  topics: [
    {
      id: 't-1',
      assistantId: 'a-1',
      name: 'Old Name',
      pinned: false,
      prompt: '',
      isNameManuallyEdited: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages: []
    }
  ]
}

const fakeState = {
  assistants: { assistants: [assistant], defaultAssistant: assistant },
  llm: { defaultModel: { id: 'dm' }, quickModel: {}, translateModel: {} },
  settings: {}
}

// Must be defined after fakeState due to hoisting of vi.mock factory.
import { useAssistant } from '../useAssistant'

// --- Tests ----------------------------------------------------------------

describe('useAssistant.updateTopic (Phase 5.2B metadata caller)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists to SQLite then dispatches Redux on success', async () => {
    mockPersist.mockResolvedValue(undefined)

    const { result } = renderHook(() => useAssistant('a-1'))
    const next = { ...assistant.topics[0], name: 'Renamed' } as Topic

    await result.current.updateTopic(next)

    expect(mockPersist).toHaveBeenCalledTimes(1)
    expect(mockPersist).toHaveBeenCalledWith(next)
    // LOCK-528: Redux must be updated only after SQLite succeeds.
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'assistants/updateTopic',
      p: { assistantId: 'a-1', topic: next }
    })
  })

  it('does NOT dispatch Redux when SQLite persistence fails', async () => {
    mockPersist.mockRejectedValue(new Error('NOT_FOUND'))

    const { result } = renderHook(() => useAssistant('a-1'))
    const next = { ...assistant.topics[0], name: 'Renamed' } as Topic

    await expect(result.current.updateTopic(next)).rejects.toThrow('NOT_FOUND')
    expect(mockPersist).toHaveBeenCalledTimes(1)
    expect(mockDispatch).not.toHaveBeenCalled()
  })
})
