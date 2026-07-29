import type { Topic } from '@renderer/types'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---------------------------------------------------------------

const mockDispatch = vi.fn()

let uuidCounter = 0

const { mocks } = vi.hoisted(() => ({
  mocks: {
    ensureOrdinaryTopicOwnership: vi.fn(),
    softDeleteOrdinaryTopic: vi.fn(),
    restoreOrdinaryTopic: vi.fn(),
    softRemoveTopic: vi.fn(),
    restoreTopic: vi.fn(),
    getTopic: vi.fn(),
    getDefaultTopic: vi.fn(),
    resetOrdinaryAssistantTopics: vi.fn()
  }
}))

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
  getDefaultTopic: mocks.getDefaultTopic
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
  TopicManager: {
    softRemoveTopic: mocks.softRemoveTopic,
    restoreTopic: mocks.restoreTopic,
    getTopic: mocks.getTopic
  }
}))

vi.mock('@renderer/services/db/topicMetadataPersist', () => ({
  persistTopicMetadata: vi.fn()
}))

vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  ensureOrdinaryTopicOwnership: mocks.ensureOrdinaryTopicOwnership,
  softDeleteOrdinaryTopic: mocks.softDeleteOrdinaryTopic,
  restoreOrdinaryTopic: mocks.restoreOrdinaryTopic,
  resetOrdinaryAssistantTopics: mocks.resetOrdinaryAssistantTopics
}))

vi.mock('@renderer/utils/agentSession', () => ({
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:')
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock('@renderer/utils', () => ({
  uuid: () => `uuid-${++uuidCounter}`
}))

// --- Fixtures -------------------------------------------------------------

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 't-1',
    assistantId: 'a-1',
    name: 'Topic',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    ...overrides
  } as Topic
}

const assistant = {
  id: 'a-1',
  name: 'Assistant',
  model: { id: 'm-1', provider: 'openai' },
  settings: undefined,
  topics: [makeTopic()]
}

const fakeState = {
  assistants: { assistants: [assistant], defaultAssistant: assistant },
  llm: { defaultModel: { id: 'dm' }, quickModel: {}, translateModel: {} },
  settings: {}
}

// Must be defined after fakeState due to hoisting of vi.mock factory.
import { useAssistant, useAssistants, useDefaultAssistant } from '../useAssistant'

// --- Tests ----------------------------------------------------------------

describe('useAssistant trash lifecycle (Phase 5.2B)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    mocks.getDefaultTopic.mockImplementation((assistantId: string) => ({
      id: `topic-${assistantId}`,
      assistantId,
      name: 'Default',
      messages: []
    }))
    mocks.resetOrdinaryAssistantTopics.mockResolvedValue({
      replacementTopic: makeTopic({ id: 'topic-a-1', name: 'Persisted default' }),
      cleanup: { affectedFileIds: [], remainingReferenceCounts: {} }
    })
  })

  describe('removeTopic (soft delete)', () => {
    it('routes ordinary topics through SQLite, then dispatches (LOCK-521/528)', async () => {
      mocks.softDeleteOrdinaryTopic.mockResolvedValue(undefined)
      const { result } = renderHook(() => useAssistant('a-1'))
      const topic = makeTopic()

      await result.current.removeTopic(topic)

      expect(mocks.softDeleteOrdinaryTopic).toHaveBeenCalledExactlyOnceWith('t-1')
      expect(mocks.softRemoveTopic).not.toHaveBeenCalled()
      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'removeTopic',
        p: { assistantId: 'a-1', topic }
      })
    })

    it('keeps agent-session topics on Dexie and bypasses SQLite (LOCK-521)', async () => {
      mocks.softRemoveTopic.mockResolvedValue(undefined)
      const { result } = renderHook(() => useAssistant('a-1'))
      const topic = makeTopic({ id: 'agent-session:s-1' })

      await result.current.removeTopic(topic)

      expect(mocks.softRemoveTopic).toHaveBeenCalledExactlyOnceWith(topic)
      expect(mocks.softDeleteOrdinaryTopic).not.toHaveBeenCalled()
      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'removeTopic',
        p: { assistantId: 'a-1', topic }
      })
    })

    it('does NOT dispatch Redux when the ordinary SQLite mutation fails (LOCK-528)', async () => {
      mocks.softDeleteOrdinaryTopic.mockRejectedValue(new Error('SQLITE_FAILURE'))
      const { result } = renderHook(() => useAssistant('a-1'))

      await expect(result.current.removeTopic(makeTopic())).rejects.toThrow('SQLITE_FAILURE')
      expect(mockDispatch).not.toHaveBeenCalled()
      // No Dexie fallback (LOCK-524).
      expect(mocks.softRemoveTopic).not.toHaveBeenCalled()
    })
  })

  describe('restoreTopic', () => {
    it('routes ordinary restore through ONE atomic SQLite command and dispatches its returned row (LOCK-532)', async () => {
      const restored = makeTopic({ name: 'Restored' })
      mocks.restoreOrdinaryTopic.mockResolvedValue(restored)
      const { result } = renderHook(() => useAssistant('a-1'))

      await result.current.restoreTopic('t-1')

      expect(mocks.restoreOrdinaryTopic).toHaveBeenCalledExactlyOnceWith('t-1')
      expect(mocks.restoreTopic).not.toHaveBeenCalled()
      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'addTopicFromTrash',
        p: { assistantId: 'a-1', topic: restored }
      })
    })

    it('does NOT dispatch when the topic is not found in SQLite trash', async () => {
      mocks.restoreOrdinaryTopic.mockResolvedValue(undefined)
      const { result } = renderHook(() => useAssistant('a-1'))

      await result.current.restoreTopic('t-x')

      expect(mockDispatch).not.toHaveBeenCalled()
    })

    it('does NOT dispatch when the ordinary SQLite restore fails (LOCK-528)', async () => {
      mocks.restoreOrdinaryTopic.mockRejectedValue(new Error('SQLITE_FAILURE'))
      const { result } = renderHook(() => useAssistant('a-1'))

      await expect(result.current.restoreTopic('t-1')).rejects.toThrow('SQLITE_FAILURE')
      expect(mockDispatch).not.toHaveBeenCalled()
    })

    it('keeps agent-session restore on Dexie (LOCK-521)', async () => {
      const agentTopic = makeTopic({ id: 'agent-session:s-1', deletedAt: '2026-01-03T00:00:00.000Z' })
      mocks.getTopic.mockResolvedValue(agentTopic)
      // restoreTopic now returns the restored topic directly (LOCK-003)
      mocks.restoreTopic.mockResolvedValue({ ...agentTopic, deletedAt: undefined })
      const { result } = renderHook(() => useAssistant('a-1'))

      await result.current.restoreTopic('agent-session:s-1')

      expect(mocks.restoreTopic).toHaveBeenCalledExactlyOnceWith('agent-session:s-1')
      expect(mocks.restoreOrdinaryTopic).not.toHaveBeenCalled()
      const dispatched = mockDispatch.mock.calls.at(-1)?.[0]
      expect(dispatched.type).toBe('addTopicFromTrash')
      expect(dispatched.p.topic.deletedAt).toBeUndefined()
    })
  })

  describe('useAssistants creation ownership (LOCK-533)', () => {
    it('addAssistant establishes SQLite topic ownership BEFORE Redux exposure', async () => {
      const order: string[] = []
      mocks.ensureOrdinaryTopicOwnership.mockImplementation(async () => {
        order.push('sqlite')
      })
      mockDispatch.mockImplementation(() => {
        order.push('redux')
      })
      const { result } = renderHook(() => useAssistants())
      const newAssistant = { ...assistant, id: 'a-2', topics: [makeTopic({ id: 't-new' })] } as any

      await result.current.addAssistant(newAssistant)

      expect(mocks.ensureOrdinaryTopicOwnership).toHaveBeenCalledExactlyOnceWith('t-new', 'a-2')
      expect(order).toEqual(['sqlite', 'redux'])
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'addAssistant', p: newAssistant })
    })

    it('addAssistant does NOT dispatch when SQLite ownership fails (LOCK-528)', async () => {
      mocks.ensureOrdinaryTopicOwnership.mockRejectedValue(new Error('SQLITE_FAILURE'))
      const { result } = renderHook(() => useAssistants())
      const newAssistant = { ...assistant, id: 'a-2', topics: [makeTopic({ id: 't-new' })] } as any

      await expect(result.current.addAssistant(newAssistant)).rejects.toThrow('SQLITE_FAILURE')
      expect(mockDispatch).not.toHaveBeenCalled()
    })

    it('copyAssistant establishes ownership for the copied default topic before Redux', async () => {
      mocks.ensureOrdinaryTopicOwnership.mockResolvedValue(undefined)
      const { result } = renderHook(() => useAssistants())

      const copied = await result.current.copyAssistant(assistant as any)

      expect(copied).toBeDefined()
      // getDefaultTopic receives the NEW assistant ID, not the original 'a-1'
      expect(mocks.getDefaultTopic).toHaveBeenCalledWith('uuid-1')
      expect(mocks.ensureOrdinaryTopicOwnership).toHaveBeenCalledExactlyOnceWith('topic-uuid-1', 'uuid-1')
      const dispatched = mockDispatch.mock.calls.at(-1)?.[0]
      expect(dispatched.type).toBe('insertAssistant')
    })

    it('copyAssistant creates topic with assistantId matching the NEW assistant ID (LOCK-534)', async () => {
      mocks.ensureOrdinaryTopicOwnership.mockResolvedValue(undefined)
      const { result } = renderHook(() => useAssistants())

      const copied = await result.current.copyAssistant(assistant as any)

      expect(copied).toBeDefined()
      const topic = copied!.topics[0]
      expect(topic.assistantId).toBe(copied!.id)
      expect(topic.assistantId).not.toBe(assistant.id)
    })

    it('copyAssistant does NOT dispatch when SQLite ownership fails (LOCK-528)', async () => {
      mocks.ensureOrdinaryTopicOwnership.mockRejectedValue(new Error('SQLITE_FAILURE'))
      const { result } = renderHook(() => useAssistants())

      await expect(result.current.copyAssistant(assistant as any)).rejects.toThrow('SQLITE_FAILURE')
      expect(mockDispatch).not.toHaveBeenCalled()
    })

    it('copyAssistant produces fresh distinct topic IDs across multiple copies (LOCK-534)', async () => {
      mocks.ensureOrdinaryTopicOwnership.mockResolvedValue(undefined)
      const { result } = renderHook(() => useAssistants())

      const copy1 = await result.current.copyAssistant(assistant as any)
      const copy2 = await result.current.copyAssistant(assistant as any)

      expect(copy1).toBeDefined()
      expect(copy2).toBeDefined()
      // Each copy gets a fresh assistant ID
      expect(copy1!.id).not.toBe(copy2!.id)
      // Each copy gets a fresh topic ID
      expect(copy1!.topics[0].id).not.toBe(copy2!.topics[0].id)
      // Both topics bind to their own assistant
      expect(copy1!.topics[0].assistantId).toBe(copy1!.id)
      expect(copy2!.topics[0].assistantId).toBe(copy2!.id)
    })
  })

  describe('useDefaultAssistant topic ownership', () => {
    it('exposes default assistant topics bound to default assistant ID (LOCK-534)', () => {
      const { result } = renderHook(() => useDefaultAssistant())
      const { defaultAssistant } = result.current

      expect(defaultAssistant.id).toBe('a-1')
      expect(defaultAssistant.topics).toHaveLength(1)
      expect(defaultAssistant.topics[0].assistantId).toBe(defaultAssistant.id)
      expect(mocks.getDefaultTopic).toHaveBeenCalledWith(defaultAssistant.id)
    })
  })
})
