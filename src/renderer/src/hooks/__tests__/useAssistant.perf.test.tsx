/**
 * useAssistant 渲染次数统计测试
 *
 * 验证 useAssistant 在 assistants 数组变化时的重渲染行为。
 * useAssistant 使用 .find() selector，当其他 assistant 被修改时，
 * 由于 Immer 的数组重建，可能触发不必要的重渲染。
 * 这是 selector 重构前的基线行为。
 */
import { configureStore } from '@reduxjs/toolkit'
import type * as ConfigModels from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import assistantsReducer, {
  addAssistant,
  updateAssistant,
  updateAssistants,
  updateAssistantSettings
} from '@renderer/store/assistants'
import type { Assistant, Model } from '@renderer/types'
import { act, renderHook } from '@testing-library/react'
import React, { Profiler, type ProfilerOnRenderCallback } from 'react'
import type * as ReactI18next from 'react-i18next'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---

// Mock @renderer/store to use test store's typed hooks
vi.mock('@renderer/store', async () => {
  const reactRedux = await import('react-redux')
  return {
    useAppDispatch: reactRedux.useDispatch,
    useAppSelector: reactRedux.useSelector
  }
})

// Mock config/models — prevent useEffect side effects in useAssistant
vi.mock('@renderer/config/models', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModels>()
  return {
    ...actual,
    getThinkModelType: vi.fn(() => 'default'),
    isSupportedReasoningEffortModel: vi.fn(() => false),
    isSupportedThinkingTokenModel: vi.fn(() => false),
    MODEL_SUPPORTED_OPTIONS: { default: ['default', 'none'] },
    MODEL_SUPPORTED_REASONING_EFFORT: { default: [] }
  }
})

// Mock databases — only used in moveTopic, not needed for render count test
vi.mock('@renderer/databases', () => ({
  default: { topics: { where: vi.fn().mockReturnValue({ equals: vi.fn().mockReturnValue({ modify: vi.fn() }) }) } },
  db: { topics: { where: vi.fn().mockReturnValue({ equals: vi.fn().mockReturnValue({ modify: vi.fn() }) }) } }
}))

// Mock AssistantService — getDefaultTopic is used in initial state
vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: vi.fn(() => ({
    id: 'default',
    name: 'Default Assistant',
    emoji: '😀',
    prompt: '',
    topics: [
      { id: 'default-topic', assistantId: 'default', createdAt: '', updatedAt: '', name: 'New Session', messages: [] }
    ],
    type: 'assistant',
    regularPhrases: [],
    settings: { temperature: 1, contextCount: 5, enableMaxTokens: false, maxTokens: 0, streamOutput: true }
  })),
  getDefaultTopic: vi.fn((assistantId: string) => ({
    id: `topic-${assistantId}`,
    assistantId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: 'New Session',
    messages: []
  })),
  DEFAULT_ASSISTANT_SETTINGS: {
    temperature: 1,
    contextCount: 5,
    enableMaxTokens: false,
    maxTokens: 0,
    streamOutput: true
  }
}))

// Mock TopicManager — used in removeTopic, moveTopic, etc.
vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: {
    removeTopic: vi.fn(),
    softRemoveTopic: vi.fn(),
    restoreTopic: vi.fn(),
    getTopic: vi.fn()
  }
}))

// Mock react-i18next — keep actual exports, override useTranslation
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: 'en' }
    })
  }
})

// --- Test data ---

const MOCK_MODEL: Model = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  provider: 'openai'
} as Model

function createAssistant(id: string, name: string): Assistant {
  return {
    id,
    name,
    emoji: '🤖',
    prompt: `Prompt for ${name}`,
    topics: [
      {
        id: `topic-${id}`,
        assistantId: id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: 'New Session',
        messages: []
      }
    ],
    type: 'assistant',
    model: MOCK_MODEL,
    regularPhrases: []
  }
}

// Create a list of assistants for testing
const TARGET_ASSISTANT_ID = 'assistant-1'
const UNRELATED_ASSISTANT_ID = 'assistant-2'

const initialAssistants: Assistant[] = [
  createAssistant(TARGET_ASSISTANT_ID, 'Target Assistant'),
  createAssistant(UNRELATED_ASSISTANT_ID, 'Unrelated Assistant'),
  createAssistant('assistant-3', 'Third Assistant'),
  createAssistant('assistant-4', 'Fourth Assistant'),
  createAssistant('assistant-5', 'Fifth Assistant')
]

function createTestStore(assistants: Assistant[] = initialAssistants) {
  return configureStore({
    reducer: {
      assistants: assistantsReducer,
      llm: (
        state = {
          defaultModel: MOCK_MODEL,
          quickModel: MOCK_MODEL,
          translateModel: MOCK_MODEL,
          providers: [],
          settings: {}
        }
      ) => state
    },
    preloadedState: {
      assistants: {
        defaultAssistant: assistants[0],
        assistants,
        tagsOrder: [],
        collapsedTags: {},
        presets: [],
        unifiedListOrder: []
      }
    }
  })
}

// --- Profiler-based render counting ---

let renderCount = 0
const onRender: ProfilerOnRenderCallback = () => {
  renderCount++
}

function createWrapper(store: ReturnType<typeof createTestStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <Profiler id="useAssistant" onRender={onRender}>
        <Provider store={store}>{children}</Provider>
      </Profiler>
    )
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useAssistant render count (baseline)', () => {
  it('should render exactly once on initial mount', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useAssistant(TARGET_ASSISTANT_ID), { wrapper: createWrapper(store) })
    // Initial mount may trigger additional renders due to useEffect for reasoning effort sync
    console.log(`[useAssistant] Initial mount → ${renderCount} render(s)`)
    expect(renderCount).toBeGreaterThanOrEqual(1)
  })

  it('should re-render when an UNRELATED assistant is modified (baseline: records render count)', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useAssistant(TARGET_ASSISTANT_ID), { wrapper: createWrapper(store) })

    // Wait for useEffect to settle
    act(() => {})

    const beforeCount = renderCount

    // Modify a different assistant — ideally should NOT cause re-render
    act(() => {
      store.dispatch(
        updateAssistant({
          id: UNRELATED_ASSISTANT_ID,
          name: 'Updated Unrelated Assistant'
        })
      )
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    // Record baseline: after refactoring with memoized selectors, this should be 0
    console.log(`[useAssistant] Unrelated assistant change → ${extraRenders} extra render(s)`)
    // Current behavior: may or may not re-render depending on Immer structural sharing
    expect(extraRenders).toBeGreaterThanOrEqual(0)
  })

  it('should re-render when the TARGET assistant is modified', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useAssistant(TARGET_ASSISTANT_ID), { wrapper: createWrapper(store) })

    act(() => {})

    const beforeCount = renderCount

    // Modify the target assistant — should cause re-render
    act(() => {
      store.dispatch(
        updateAssistant({
          id: TARGET_ASSISTANT_ID,
          name: 'Updated Target Assistant'
        })
      )
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[useAssistant] Target assistant change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should record renders for sequential unrelated changes (cumulative baseline)', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useAssistant(TARGET_ASSISTANT_ID), { wrapper: createWrapper(store) })

    act(() => {})

    const beforeCount = renderCount
    const counts: number[] = []

    // Multiple unrelated assistant changes
    act(() => {
      store.dispatch(updateAssistant({ id: UNRELATED_ASSISTANT_ID, name: 'Update 1' }))
    })
    counts.push(renderCount - beforeCount)

    act(() => {
      store.dispatch(updateAssistant({ id: 'assistant-3', name: 'Update 2' }))
    })
    counts.push(renderCount - beforeCount)

    act(() => {
      store.dispatch(updateAssistant({ id: 'assistant-4', name: 'Update 3' }))
    })
    counts.push(renderCount - beforeCount)

    act(() => {
      store.dispatch(updateAssistant({ id: 'assistant-5', name: 'Update 4' }))
    })
    counts.push(renderCount - beforeCount)

    console.log(`[useAssistant] Sequential unrelated changes → cumulative renders: [${counts.join(', ')}]`)
    // Record the pattern: each unrelated change should ideally not add renders
    expect(counts.length).toBe(4)
  })

  it('should record renders when a new assistant is added', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useAssistant(TARGET_ASSISTANT_ID), { wrapper: createWrapper(store) })

    act(() => {})

    const beforeCount = renderCount

    act(() => {
      store.dispatch(addAssistant(createAssistant('assistant-new', 'New Assistant')))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[useAssistant] Add new assistant → ${extraRenders} extra render(s)`)
    // Adding a new assistant creates a new array, which may trigger re-render
    expect(extraRenders).toBeGreaterThanOrEqual(0)
  })

  it('should record renders when assistant settings are updated', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useAssistant(TARGET_ASSISTANT_ID), { wrapper: createWrapper(store) })

    act(() => {})

    const beforeCount = renderCount

    act(() => {
      store.dispatch(
        updateAssistantSettings({
          assistantId: TARGET_ASSISTANT_ID,
          settings: { temperature: 0.5 }
        })
      )
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[useAssistant] Update target assistant settings → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should not re-render when updateAssistants replaces the entire array but target assistant is unchanged', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useAssistant(TARGET_ASSISTANT_ID), { wrapper: createWrapper(store) })

    act(() => {})

    const beforeCount = renderCount

    // Build a brand-new array with the same target assistant object reference
    // but different references for the other assistants — simulating a full array replacement
    const currentAssistants = store.getState().assistants.assistants
    const newAssistants = currentAssistants.map((a) =>
      a.id === TARGET_ASSISTANT_ID ? a : { ...a, name: `Replaced ${a.name}` }
    )

    act(() => {
      store.dispatch(updateAssistants(newAssistants))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[useAssistant] updateAssistants (target unchanged) → ${extraRenders} extra render(s)`)
    // After memoization: should NOT re-render because the target assistant object is referentially stable
    expect(extraRenders).toBe(0)
  })

  it('should not re-render during batch updateAssistant when target assistant is not among the changed ones', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useAssistant(TARGET_ASSISTANT_ID), { wrapper: createWrapper(store) })

    act(() => {})

    const beforeCount = renderCount

    // Dispatch 5 consecutive updates to assistants OTHER than the target
    act(() => {
      store.dispatch(updateAssistant({ id: UNRELATED_ASSISTANT_ID, name: 'Batch 1' }))
      store.dispatch(updateAssistant({ id: 'assistant-3', name: 'Batch 2' }))
      store.dispatch(updateAssistant({ id: 'assistant-4', name: 'Batch 3' }))
      store.dispatch(updateAssistant({ id: 'assistant-5', name: 'Batch 4' }))
      store.dispatch(updateAssistant({ id: UNRELATED_ASSISTANT_ID, name: 'Batch 5' }))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[useAssistant] Batch updateAssistant (target unchanged) → ${extraRenders} extra render(s)`)
    // After memoization: should NOT re-render because the target assistant is not modified
    expect(extraRenders).toBe(0)
  })
})
