import llmReducer, { addModel, updateModel } from '@renderer/store/llm'
import type { Model } from '@renderer/types'
import { describe, expect, it } from 'vitest'

const baseState = (models: Model[] = []) =>
  ({
    providers: [
      {
        id: 'conn-1',
        type: 'openai',
        name: 'My Connection',
        apiKey: '',
        apiHost: 'https://api.example.com',
        models,
        isSystem: false,
        enabled: true
      }
    ],
    defaultModel: undefined,
    topicNamingModel: undefined,
    quickModel: undefined,
    translateModel: undefined,
    quickAssistantId: '',
    settings: { ollama: { keepAliveTime: 0 }, lmstudio: { keepAliveTime: 0 }, gpustack: { keepAliveTime: 0 } }
  }) as any

describe('endpoint_type legacy preservation', () => {
  it('remains in the Model type and survives update round-trip', () => {
    const model = {
      id: 'proxy-model',
      name: 'proxy-model',
      provider: 'conn-1',
      group: 'g',
      endpoint_type: 'anthropic'
    } as unknown as Model
    let state = baseState([model])
    const updated = { ...model, name: 'renamed' }
    state = llmReducer(state, updateModel({ providerId: 'conn-1', model: updated }))
    expect(state.providers[0].models[0]).toMatchObject({ id: 'proxy-model', endpoint_type: 'anthropic' })
    expect(state.providers[0].models[0].name).toBe('renamed')
  })

  it('is not required for new models', () => {
    let state = baseState([])
    const fresh = { id: 'fresh-1', name: 'fresh-1', provider: 'conn-1', group: 'conn-1' } as Model
    state = llmReducer(state, addModel({ providerId: 'conn-1', model: fresh }))
    expect(state.providers[0].models[0].id).toBe('fresh-1')
    expect(state.providers[0].models[0].endpoint_type).toBeUndefined()
  })
})
