import { configureStore } from '@reduxjs/toolkit'
import { DEFAULT_CONTEXTCOUNT, DEFAULT_TEMPERATURE } from '@renderer/config/constant'
import type { AssistantDefaults } from '@renderer/services/assistantDefaults'
import assistantsReducer from '@renderer/store/assistants'
import llmReducer from '@renderer/store/llm'
import type { Assistant, Model } from '@renderer/types'
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

const { useAssistant, useDefaultModel, useMessageAssistant } = await import('../useAssistant')

const valid = (id: string, provider = 'openai'): Model => ({ id, provider, name: id, group: 'g' }) as Model

function buildStore(assistant: Assistant, defaultModel: Model | undefined) {
  const baseAssistants = assistantsReducer(undefined, { type: '@@INIT' } as never)
  const baseLlm = llmReducer(undefined, { type: '@@INIT' } as never)
  return configureStore({
    reducer: { assistants: assistantsReducer, llm: llmReducer },
    preloadedState: {
      assistants: {
        ...baseAssistants,
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

function makeAssistant(extra?: Partial<Assistant>): Assistant {
  return {
    id: 'asst-1',
    name: 'Assistant One',
    prompt: 'prompt',
    type: 'assistant',
    settings: {},
    topics: [],
    ...extra
  }
}

function readModel(id = 'asst-1') {
  const seen: unknown[] = []
  function Probe() {
    const { model } = useMessageAssistant(id)
    seen.push(model)
    return null
  }
  function WideProbe() {
    const { model } = useAssistant(id)
    seen.push(model)
    return null
  }
  function DefaultProbe() {
    const { defaultModel } = useDefaultModel()
    seen.push(defaultModel)
    return null
  }
  return { seen, Probe, WideProbe, DefaultProbe }
}

describe('useAssistant malformed persisted model stays unconfigured', () => {
  it('malformed assistant.model does not fall through to valid assistant.defaultModel/global', () => {
    const global = valid('global')
    const assistantDefault = valid('assistant-default')
    const store = buildStore(makeAssistant({ model: {} as Model, defaultModel: assistantDefault }), global)
    const { seen, Probe, WideProbe } = readModel()
    render(
      <Provider store={store as never}>
        <Probe />
        <WideProbe />
      </Provider>
    )
    // narrow selector first, wide hook second
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toBeUndefined()
  })

  it('malformed id/provider variants stay unconfigured in both hooks', () => {
    const global = valid('global')
    const malformedVariants: unknown[] = [
      {},
      { id: undefined, provider: 'openai' },
      { id: '', provider: 'openai' },
      { id: 'm1', provider: '' },
      { id: 123, provider: 'openai' }
    ]
    for (const malformed of malformedVariants) {
      const store = buildStore(makeAssistant({ model: malformed as Model }), global)
      const { seen, Probe, WideProbe } = readModel()
      render(
        <Provider store={store as never}>
          <Probe />
          <WideProbe />
        </Provider>
      )
      expect(seen[0]).toBeUndefined()
      expect(seen[1]).toBeUndefined()
    }
  })

  it('valid minimal serving model with missing display/group is accepted verbatim', () => {
    const minimal = { id: 'custom-id', provider: 'custom-conn' } as Model
    const store = buildStore(makeAssistant({ model: minimal }), valid('global'))
    const { seen, Probe } = readModel()
    render(
      <Provider store={store as never}>
        <Probe />
      </Provider>
    )
    expect(seen[0]).toBe(minimal)
  })

  it('malformed global default reads as unconfigured via useDefaultModel', () => {
    const store = buildStore(makeAssistant({}), {} as Model)
    const { seen, DefaultProbe } = readModel()
    render(
      <Provider store={store as never}>
        <DefaultProbe />
      </Provider>
    )
    expect(seen[0]).toBeUndefined()
  })

  it('absent slots stay unconfigured', () => {
    const store = buildStore(makeAssistant({ model: undefined, defaultModel: undefined }), undefined)
    const { seen, Probe } = readModel()
    render(
      <Provider store={store as never}>
        <Probe />
      </Provider>
    )
    expect(seen[0]).toBeUndefined()
    void act
  })
})
