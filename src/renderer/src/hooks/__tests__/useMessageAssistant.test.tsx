/**
 * useMessageAssistant narrow-subscription isolation (real store + real hooks).
 *
 * Root fact (real reducer): `updateTopicUpdatedAt` is an Immer nested draft
 * assign that produces a new topic -> topics array -> assistant reference
 * even for a pure timestamp bump, so the whole-assistant subscription in
 * `useAssistant` invalidates EVERY mounted consumer on every ordinary send.
 * The narrow `useMessageAssistant` projection (configuration only, no
 * topics) must stay reference-stable across exactly those writes while the
 * old hook fires, and must invalidate on every real configuration change
 * (settings/name/model/default-model fallback). The original `useAssistant`
 * keeps full topic behavior for sidebar/topic management.
 *
 * No store mocking: a real configureStore with the real assistants + llm
 * reducers and real react-redux subscription; only side-effect services
 * (SQLite topic lifecycle, TopicManager) are stubbed and never invoked.
 */
import { configureStore } from '@reduxjs/toolkit'
import { DEFAULT_CONTEXTCOUNT, DEFAULT_TEMPERATURE } from '@renderer/config/constant'
import type { AssistantDefaults } from '@renderer/services/assistantDefaults'
import assistantsReducer, {
  addTopic,
  setModel,
  updateAssistant,
  updateTopic,
  updateTopicUpdatedAt
} from '@renderer/store/assistants'
import llmReducer, { setDefaultModel } from '@renderer/store/llm'
import type { Assistant, Model, Topic } from '@renderer/types'
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/db', () => ({ dbService: {} }))
vi.mock('@renderer/services/db/topicMetadataPersist', () => ({
  persistTopicMetadata: vi.fn()
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  ensureOrdinaryTopicOwnership: vi.fn(),
  resetOrdinaryAssistantTopics: vi.fn(),
  restoreOrdinaryTopic: vi.fn(),
  softDeleteOrdinaryTopic: vi.fn()
}))
vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: { removeTopic: vi.fn() }
}))
vi.mock('@renderer/services/assistantDefaults', () => ({
  DEFAULT_ASSISTANT_SETTINGS: {},
  createAssistantDefaults: () => ({ settings: {} }),
  createInitialAssistant: () => ({ id: 'seed-default', name: 'seed', prompt: '', topics: [], settings: {} }),
  getDefaultTopic: (assistantId: string) => ({
    id: `default-${assistantId}`,
    assistantId,
    name: 'Default',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: []
  })
}))
vi.mock('@renderer/utils', () => ({ uuid: () => 'uuid-test' }))

const { isMessageAssistantConfigEqual, useAssistant, useAssistantSettingsUpdater, useMessageAssistant } = await import(
  '../useAssistant'
)

const MODEL_A: Model = { id: 'model-a', provider: 'test-provider', name: 'Model A' } as Model
const MODEL_B: Model = { id: 'model-b', provider: 'test-provider', name: 'Model B' } as Model
const GLOBAL_DEFAULT: Model = { id: 'global-default', provider: 'test-provider', name: 'Global Default' } as Model
const GLOBAL_NEXT: Model = { id: 'global-next', provider: 'test-provider', name: 'Global Next' } as Model

function makeTopic(id: string, extra?: Partial<Topic>): Topic {
  return {
    id,
    assistantId: 'asst-1',
    name: `Topic ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    ...extra
  }
}

function makeAssistant(extra?: Partial<Assistant>): Assistant {
  return {
    id: 'asst-1',
    name: 'Assistant One',
    prompt: 'prompt',
    type: 'assistant',
    emoji: '🤖',
    model: MODEL_A,
    settings: { temperature: 0.7, contextCount: 20 },
    topics: [makeTopic('t-1'), makeTopic('t-2')],
    ...extra
  }
}

function buildStore(assistant: Assistant, defaultModel: Model | undefined) {
  const baseLlm = llmReducer(undefined, { type: '@@INIT' } as never)
  return configureStore({
    reducer: { assistants: assistantsReducer, llm: llmReducer },
    preloadedState: {
      assistants: {
        // Complete AssistantDefaults baseline mirroring the current
        // DEFAULT_ASSISTANT_SETTINGS values (temperature/topP/contextCount/
        // streamOutput/reasoning_effort/toolUseMode); no casts.
        assistantDefaults: {
          name: 'Test Defaults',
          prompt: '',
          type: 'assistant',
          settings: {
            temperature: DEFAULT_TEMPERATURE,
            topP: 1,
            contextCount: DEFAULT_CONTEXTCOUNT,
            streamOutput: true,
            reasoning_effort: 'default',
            toolUseMode: 'function'
          }
        } satisfies AssistantDefaults,
        assistants: [assistant],
        tagsOrder: [],
        collapsedTags: {},
        presets: [],
        unifiedListOrder: []
      },
      llm: { ...baseLlm, defaultModel }
    }
  })
}

type TestStore = ReturnType<typeof buildStore>

interface NarrowSeen {
  assistant: { name?: string; model?: unknown; settings?: Record<string, unknown> } | null | undefined
  model: unknown
  setModel: (model: Model) => void
  updateAssistantSettings: (settings: Record<string, unknown>) => void
}

function NarrowProbe({ id, seen }: { id: string; seen: NarrowSeen[] }) {
  const { assistant, model, setModel, updateAssistantSettings } = useMessageAssistant(id)
  seen.push({
    assistant: assistant as NarrowSeen['assistant'],
    model,
    setModel,
    updateAssistantSettings: updateAssistantSettings as NarrowSeen['updateAssistantSettings']
  })
  return null
}

function WideProbe({ id, seen }: { id: string; seen: unknown[] }) {
  const { assistant } = useAssistant(id)
  seen.push(assistant)
  return null
}

function TopicsProbe({ id, seen }: { id: string; seen: number[] }) {
  const { assistant } = useAssistant(id)
  seen.push(assistant.topics.length)
  return null
}

function renderProbes(store: TestStore, id = 'asst-1') {
  const narrowSeen: NarrowSeen[] = []
  const wideSeen: unknown[] = []
  render(
    <Provider store={store as never}>
      <NarrowProbe id={id} seen={narrowSeen} />
      <WideProbe id={id} seen={wideSeen} />
    </Provider>
  )
  return { narrowSeen, wideSeen }
}

const stripTopics = (assistant: Assistant) => {
  const { topics: _ignored, ...config } = assistant
  return config
}

describe('useMessageAssistant narrow subscription (real store)', () => {
  it('updateTopicUpdatedAt replaces the whole assistant ref but leaves config identity intact', () => {
    const store = buildStore(makeAssistant(), GLOBAL_DEFAULT)
    const beforeAssistant = store.getState().assistants.assistants[0]

    act(() => {
      store.dispatch(updateTopicUpdatedAt({ topicId: 't-1' }))
    })

    const afterAssistant = store.getState().assistants.assistants[0]
    // Old whole-object subscription fires: new assistant + new topics array.
    expect(afterAssistant).not.toBe(beforeAssistant)
    expect(afterAssistant.topics).not.toBe(beforeAssistant.topics)
    expect(afterAssistant.topics[0]).not.toBe(beforeAssistant.topics[0])
    // The narrow projection is blind to it: every configuration field keeps
    // its reference, so the presentation equality holds.
    expect(isMessageAssistantConfigEqual(stripTopics(beforeAssistant), stripTopics(afterAssistant))).toBe(true)
    expect(afterAssistant.settings).toBe(beforeAssistant.settings)
    expect(afterAssistant.model).toBe(beforeAssistant.model)
    expect(afterAssistant.defaultModel).toBe(beforeAssistant.defaultModel)
    expect(afterAssistant.name).toBe(beforeAssistant.name)
  })

  it('ordinary send-shaped topic writes re-render the old hook but not the narrow consumer', () => {
    const store = buildStore(makeAssistant(), GLOBAL_DEFAULT)
    const { narrowSeen, wideSeen } = renderProbes(store)
    expect(narrowSeen).toHaveLength(1)
    expect(wideSeen).toHaveLength(1)
    const stableUpdater = narrowSeen[0].updateAssistantSettings
    const stableSetModel = narrowSeen[0].setModel

    // Pure updatedAt bump: the per-send updateTopicUpdatedAt shape.
    act(() => {
      store.dispatch(updateTopicUpdatedAt({ topicId: 't-1' }))
    })
    expect(wideSeen).toHaveLength(2)
    expect(narrowSeen).toHaveLength(1)

    // Topic rename: new topics array, configuration untouched.
    const renamed = { ...makeTopic('t-2'), name: 'Renamed topic' }
    act(() => {
      store.dispatch(updateTopic({ assistantId: 'asst-1', topic: renamed }))
    })
    expect(wideSeen).toHaveLength(3)
    expect(narrowSeen).toHaveLength(1)

    // Topic append: another send-shaped reference replacement.
    act(() => {
      store.dispatch(addTopic({ assistantId: 'asst-1', topic: makeTopic('t-3') }))
    })
    expect(wideSeen).toHaveLength(4)
    expect(narrowSeen).toHaveLength(1)

    // Dispatcher callbacks stay reference-stable across topic-only writes.
    expect(narrowSeen[0].updateAssistantSettings).toBe(stableUpdater)
    expect(narrowSeen[0].setModel).toBe(stableSetModel)
  })

  it('settings / name / model changes invalidate with correct values', () => {
    const store = buildStore(makeAssistant(), GLOBAL_DEFAULT)
    const { narrowSeen } = renderProbes(store)

    act(() => {
      narrowSeen[0].updateAssistantSettings({ temperature: 0.9 })
    })
    expect(narrowSeen).toHaveLength(2)
    expect(narrowSeen[1].assistant?.settings?.temperature).toBe(0.9)

    act(() => {
      store.dispatch(updateAssistant({ id: 'asst-1', name: 'Renamed Assistant' }))
    })
    expect(narrowSeen).toHaveLength(3)
    expect(narrowSeen[2].assistant?.name).toBe('Renamed Assistant')

    act(() => {
      narrowSeen[2].setModel(MODEL_B)
    })
    expect(narrowSeen).toHaveLength(4)
    expect(narrowSeen[3].model).toBe(MODEL_B)
    expect(narrowSeen[3].assistant?.model).toBe(MODEL_B)
  })

  it('global default-model fallback follows only while no assistant model is pinned', () => {
    const store = buildStore(makeAssistant({ model: undefined, defaultModel: undefined }), GLOBAL_DEFAULT)
    const narrowSeen: NarrowSeen[] = []
    render(
      <Provider store={store as never}>
        <NarrowProbe id="asst-1" seen={narrowSeen} />
      </Provider>
    )
    expect(narrowSeen[0].model).toBe(GLOBAL_DEFAULT)

    act(() => {
      store.dispatch(setDefaultModel({ model: GLOBAL_NEXT }))
    })
    expect(narrowSeen).toHaveLength(2)
    expect(narrowSeen[1].model).toBe(GLOBAL_NEXT)

    // Pinning an assistant model decouples from further global changes.
    act(() => {
      store.dispatch(setModel({ assistantId: 'asst-1', model: MODEL_A }))
    })
    expect(narrowSeen).toHaveLength(3)
    expect(narrowSeen[2].model).toBe(MODEL_A)
    act(() => {
      store.dispatch(setDefaultModel({ model: GLOBAL_DEFAULT }))
    })
    expect(narrowSeen).toHaveLength(3)
    expect(narrowSeen[2].model).toBe(MODEL_A)
  })

  it('dispatch-only updater writes settings without its own subscription', () => {
    const store = buildStore(makeAssistant(), GLOBAL_DEFAULT)
    let updater: ((settings: Record<string, unknown>) => void) | undefined
    function UpdaterProbe() {
      updater = useAssistantSettingsUpdater('asst-1') as typeof updater
      return null
    }
    render(
      <Provider store={store as never}>
        <UpdaterProbe />
      </Provider>
    )
    expect(updater).toBeDefined()
    const stable = updater
    act(() => {
      store.dispatch(updateTopicUpdatedAt({ topicId: 't-1' }))
    })
    // No subscription: no re-render observed here, updater identity comes
    // from the id-captured callback; the write path still works.
    act(() => {
      stable!({ contextCount: 5 })
    })
    const settings = store.getState().assistants.assistants[0].settings as Record<string, unknown>
    expect(settings.contextCount).toBe(5)
  })

  it('original useAssistant keeps full topic behavior for sidebar management', () => {
    const store = buildStore(makeAssistant(), GLOBAL_DEFAULT)
    const seen: number[] = []
    render(
      <Provider store={store as never}>
        <TopicsProbe id="asst-1" seen={seen} />
      </Provider>
    )
    expect(seen).toEqual([2])

    act(() => {
      store.dispatch(addTopic({ assistantId: 'asst-1', topic: makeTopic('t-3') }))
    })
    expect(seen).toEqual([2, 3])

    act(() => {
      store.dispatch(updateTopicUpdatedAt({ topicId: 't-1' }))
    })
    const topics = store.getState().assistants.assistants[0].topics
    expect(topics.find((topic) => topic.id === 't-1')?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
    expect(topics).toHaveLength(3)
  })
})
