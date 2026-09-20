import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDispatch = vi.fn()

// mutable fake state for selector
let fakeAssistant: any

function createAssistant(overrides: Partial<any> = {}) {
  return {
    id: 'a-1',
    name: 'Assistant',
    model: { id: 'grok-3-mini', provider: 'mock-openai', name: 'grok-3-mini', group: 'e2e' },
    settings: {
      reasoning_effort: 'default',
      reasoning_effort_by_model: {},
      reasoning_effort_show_all_by_model: {},
      reasoning_effort_cache: 'default',
      qwenThinkMode: false
    },
    topics: [
      {
        id: 't-1',
        assistantId: 'a-1',
        name: 'Topic',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: []
      }
    ],
    ...overrides
  }
}

let fakeState: any

vi.mock('@renderer/store', () => ({
  default: { getState: vi.fn(() => fakeState) },
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (s: any) => unknown) => selector(fakeState),
  useAppStore: () => ({})
}))

vi.mock('@renderer/config/models', () => ({
  getModelSupportedReasoningEffortOptions: () => ['default', 'none', 'low', 'medium', 'high'],
  isReasoningModel: () => true
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
  updateAssistantSettings: vi.fn((p) => ({ type: 'assistants/updateAssistantSettings', payload: p })),
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
  persistTopicMetadata: vi.fn()
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

import { useAssistant } from '../useAssistant'

describe('useAssistant per-model reasoning_effort independent restore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeAssistant = createAssistant({
      model: { id: 'grok-3-mini', provider: 'mock-openai', name: 'grok-3-mini', group: 'e2e' },
      settings: {
        reasoning_effort: 'high',
        reasoning_effort_by_model: { 'mock-openai:grok-3-mini': 'high' },
        reasoning_effort_show_all_by_model: {},
        reasoning_effort_cache: 'high',
        qwenThinkMode: true
      }
    })
    fakeState = {
      assistants: { assistants: [fakeAssistant], defaultAssistant: fakeAssistant },
      llm: { defaultModel: { id: 'mock-model', provider: 'mock-openai' } },
      settings: {}
    }
  })

  it('A high -> unset B default -> B low -> A high restores per-model without leaking', async () => {
    const MODEL_A = { id: 'grok-3-mini', provider: 'mock-openai', name: 'grok-3-mini', group: 'e2e' }
    const MODEL_B = { id: 'mock-model', provider: 'mock-openai', name: 'mock-model', group: 'e2e' }
    const KEY_A = 'mock-openai:grok-3-mini'
    const KEY_B = 'mock-openai:mock-model'

    // initial A high
    const { rerender } = renderHook(() => useAssistant('a-1'))
    // no dispatch on mount when already A high
    expect(mockDispatch).not.toHaveBeenCalled()

    // switch to B (unset) -> should restore default and save A high (A already saved)
    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_B,
      settings: {
        reasoning_effort: 'high',
        reasoning_effort_by_model: { [KEY_A]: 'high' },
        reasoning_effort_cache: 'high',
        qwenThinkMode: true
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]

    rerender()

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1))
    const firstCall = mockDispatch.mock.calls[0][0]
    expect(firstCall.payload.settings.reasoning_effort).toBe('default')
    expect(firstCall.payload.settings.reasoning_effort_by_model[KEY_A]).toBe('high')
    expect(firstCall.payload.settings.reasoning_effort_cache).toBe('default')
    expect(firstCall.payload.settings.qwenThinkMode).toBe(false)
    // B should have no entry yet (or default not stored until explicit)
    expect(firstCall.payload.settings.reasoning_effort_by_model[KEY_B]).toBeUndefined()

    // simulate Redux applying first dispatch: B now default
    mockDispatch.mockClear()
    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_B,
      settings: {
        reasoning_effort: 'default',
        reasoning_effort_by_model: { [KEY_A]: 'high' },
        reasoning_effort_cache: 'default',
        qwenThinkMode: false
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()
    // no new dispatch because already at default and map already saved
    await act(async () => {})
    expect(mockDispatch).not.toHaveBeenCalled()

    // user selects B low via ThinkingButton (direct settings update, not hook effect)
    fakeAssistant = {
      ...fakeAssistant,
      settings: {
        reasoning_effort: 'low',
        reasoning_effort_by_model: { [KEY_A]: 'high', [KEY_B]: 'low' },
        reasoning_effort_cache: 'low',
        qwenThinkMode: true
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()
    await act(async () => {})
    // hook should not overwrite explicit low while staying on B
    expect(mockDispatch).not.toHaveBeenCalled()

    // switch back to A -> should restore high and save B low
    mockDispatch.mockClear()
    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_A,
      // settings still holds B low before effect processes
      settings: {
        reasoning_effort: 'low',
        reasoning_effort_by_model: { [KEY_A]: 'high', [KEY_B]: 'low' },
        reasoning_effort_cache: 'low',
        qwenThinkMode: true
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()

    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1))
    const secondCall = mockDispatch.mock.calls[0][0]
    expect(secondCall.payload.settings.reasoning_effort).toBe('high')
    expect(secondCall.payload.settings.reasoning_effort_by_model[KEY_B]).toBe('low')
    expect(secondCall.payload.settings.reasoning_effort_by_model[KEY_A]).toBe('high')
    expect(secondCall.payload.settings.qwenThinkMode).toBe(true)
    expect(secondCall.payload.settings.reasoning_effort_cache).toBe('high')
  })

  it('does not gate by model capability and keeps lazy value', async () => {
    // A high with value 'xhigh' (not in resolver list) should be preserved and saved
    fakeAssistant = createAssistant({
      model: { id: 'grok-3-mini', provider: 'mock-openai', name: 'grok-3-mini', group: 'e2e' },
      settings: {
        reasoning_effort: 'xhigh',
        reasoning_effort_by_model: { 'mock-openai:grok-3-mini': 'xhigh' },
        reasoning_effort_cache: 'xhigh',
        qwenThinkMode: true
      }
    })
    fakeState.assistants.assistants = [fakeAssistant]
    const MODEL_B = { id: 'mock-model', provider: 'mock-openai', name: 'mock-model', group: 'e2e' }
    const { rerender } = renderHook(() => useAssistant('a-1'))
    expect(mockDispatch).not.toHaveBeenCalled()
    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_B,
      settings: {
        reasoning_effort: 'xhigh',
        reasoning_effort_by_model: { 'mock-openai:grok-3-mini': 'xhigh' },
        reasoning_effort_cache: 'xhigh',
        qwenThinkMode: true
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1))
    // should restore default for B even though previous was xhigh, without rejecting xhigh
    expect(mockDispatch.mock.calls[0][0].payload.settings.reasoning_effort).toBe('default')
    expect(mockDispatch.mock.calls[0][0].payload.settings.reasoning_effort_by_model['mock-openai:grok-3-mini']).toBe(
      'xhigh'
    )
  })

  it('raw default leaving model does not produce placeholder map entry', async () => {
    const MODEL_A = { id: 'grok-3-mini', provider: 'mock-openai', name: 'grok-3-mini', group: 'e2e' }
    const MODEL_B = { id: 'mock-model', provider: 'mock-openai', name: 'mock-model', group: 'e2e' }
    const KEY_A = 'mock-openai:grok-3-mini'
    const KEY_B = 'mock-openai:mock-model'

    // initial A with raw default and empty map
    fakeAssistant = createAssistant({
      model: MODEL_A,
      settings: {
        reasoning_effort: 'default',
        reasoning_effort_by_model: {},
        reasoning_effort_show_all_by_model: {},
        reasoning_effort_cache: 'default',
        qwenThinkMode: false
      }
    })
    fakeState.assistants.assistants = [fakeAssistant]
    const { rerender } = renderHook(() => useAssistant('a-1'))
    expect(mockDispatch).not.toHaveBeenCalled()

    // A(default) -> B(default unset): leave-save must NOT write placeholder 'default' for A
    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_B,
      settings: {
        reasoning_effort: 'default',
        reasoning_effort_by_model: {},
        reasoning_effort_cache: 'default',
        qwenThinkMode: false
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()
    await act(async () => {})
    // no dispatch expected because no map change and no effort change
    expect(mockDispatch).not.toHaveBeenCalled()

    // ensure no placeholder entry would be created even if dispatch happened
    // explicitly set B low via ThinkingButton semantics (writes map entry)
    mockDispatch.mockClear()
    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_B,
      settings: {
        reasoning_effort: 'low',
        reasoning_effort_by_model: { [KEY_B]: 'low' },
        reasoning_effort_cache: 'low',
        qwenThinkMode: true
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()
    await act(async () => {})
    expect(mockDispatch).not.toHaveBeenCalled()

    // B(low) -> A(default unset): should restore default for A and keep B low, but NOT create A=default entry
    mockDispatch.mockClear()
    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_A,
      settings: {
        reasoning_effort: 'low',
        reasoning_effort_by_model: { [KEY_B]: 'low' },
        reasoning_effort_cache: 'low',
        qwenThinkMode: true
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1))
    const call = mockDispatch.mock.calls[0][0]
    expect(call.payload.settings.reasoning_effort).toBe('default')
    expect(call.payload.settings.reasoning_effort_by_model[KEY_B]).toBe('low')
    expect(call.payload.settings.reasoning_effort_by_model[KEY_A]).toBeUndefined()
    expect(call.payload.settings.reasoning_effort_cache).toBe('default')
    expect(call.payload.settings.qwenThinkMode).toBe(false)

    // A(default) -> B: leaving A default again must still not produce A=default entry
    mockDispatch.mockClear()
    // simulate Redux applied previous dispatch: now on A default with map {B:low}
    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_A,
      settings: {
        reasoning_effort: 'default',
        reasoning_effort_by_model: { [KEY_B]: 'low' },
        reasoning_effort_cache: 'default',
        qwenThinkMode: false
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()
    await act(async () => {})
    expect(mockDispatch).not.toHaveBeenCalled()

    fakeAssistant = {
      ...fakeAssistant,
      model: MODEL_B,
      settings: {
        reasoning_effort: 'default',
        reasoning_effort_by_model: { [KEY_B]: 'low' },
        reasoning_effort_cache: 'default',
        qwenThinkMode: false
      }
    }
    fakeState.assistants.assistants = [fakeAssistant]
    rerender()
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1))
    const backCall = mockDispatch.mock.calls[0][0]
    expect(backCall.payload.settings.reasoning_effort).toBe('low')
    expect(backCall.payload.settings.reasoning_effort_by_model[KEY_A]).toBeUndefined()
    expect(backCall.payload.settings.reasoning_effort_by_model[KEY_B]).toBe('low')
    expect(backCall.payload.settings.qwenThinkMode).toBe(true)
  })
})
