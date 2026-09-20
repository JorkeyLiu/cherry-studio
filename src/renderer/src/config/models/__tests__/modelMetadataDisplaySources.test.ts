import { setMetadataProviderResolver, setModelMetadataSnapshotForTests } from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getModelMetadataForDisplay } from '../modelMetadata'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }
}))

const providerOpenAI: Provider = {
  id: 'openai',
  type: 'openai',
  name: 'OpenAI',
  apiKey: '',
  apiHost: 'https://api.openai.com/v1',
  models: []
} as unknown as Provider

const makeModel = (id: string, name = id, provider = 'openai'): Model =>
  ({ id, name, provider, group: provider }) as Model

const baseSnapshot: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1,
  models: {
    'openai/gpt-4': {
      id: 'openai/gpt-4',
      modalities: { input: ['text'], output: ['text'] },
      family: 'gpt',
      limits: { context: 128000 }
    },
    'openai/gpt-4o': {
      id: 'openai/gpt-4o',
      modalities: { input: ['text'], output: ['text'] },
      family: 'gpt',
      toolCall: true
    }
  },
  providers: {
    openai: {
      api: 'https://api.openai.com/v1',
      name: 'OpenAI',
      models: {
        'gpt-4': {
          id: 'gpt-4',
          name: 'GPT-4',
          description: 'serving desc',
          cost: { input: 1, output: 2 },
          effort: ['low']
        },
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          modalities: { input: ['text'], output: ['text'] }
        }
      }
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setMetadataProviderResolver((m) => (m?.provider === 'openai' ? providerOpenAI : null))
  setModelMetadataSnapshotForTests(baseSnapshot)
})

describe('getModelMetadataForDisplay source honest mixed rule', () => {
  it('returns none when both canonical and serving absent', () => {
    setModelMetadataSnapshotForTests({ source: 'models.dev', fetchedAt: 1, models: {}, providers: {} })
    const res = getModelMetadataForDisplay(makeModel('unknown-id'))
    expect(res.source).toBe('none')
    expect(res.canonical).toBeUndefined()
    expect(res.serving).toBeUndefined()
    expect(res.effective).toBeUndefined()
  })

  it('returns serving when serving exists and canonical does not', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {},
      providers: {
        openai: {
          api: 'https://api.openai.com/v1',
          name: 'OpenAI',
          models: {
            'only-serving': { id: 'only-serving', name: 'Only Serving', description: 'x' }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    const res = getModelMetadataForDisplay(makeModel('only-serving'))
    expect(res.source).toBe('serving')
    expect(res.serving).toBeDefined()
    expect(res.canonical).toBeUndefined()
    expect(res.effective?.description).toBe('x')
  })

  it('returns canonical when canonical exists and serving does not', () => {
    void getModelMetadataForDisplay(makeModel('openai/gpt-4', 'openai/gpt-4', 'unknown-provider'))
    // unknown-provider has no resolver -> no serving, but canonical exists via id match
    setMetadataProviderResolver(() => null)
    const res2 = getModelMetadataForDisplay(makeModel('gpt-4', 'gpt-4', 'unknown-provider'))
    // Use baseSnapshot canonical: gpt-4 exists, but without provider cannot resolve serving
    expect(res2.source).toBe('canonical')
    expect(res2.canonical).toBeDefined()
    expect(res2.serving).toBeUndefined()
    // restore resolver for other tests
    setMetadataProviderResolver((m) => (m?.provider === 'openai' ? providerOpenAI : null))
    // also test with exact canonical but no serving model entry
    const snapNoServing: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'openai/only-canonical': { id: 'openai/only-canonical', modalities: { input: ['text'], output: ['text'] } }
      },
      providers: { openai: { api: 'https://api.openai.com/v1', name: 'OpenAI', models: {} } }
    }
    setModelMetadataSnapshotForTests(snapNoServing)
    const res3 = getModelMetadataForDisplay(makeModel('only-canonical'))
    expect(res3.source).toBe('canonical')
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('returns mixed when both exist and serving has any field (including description/cost/effort)', () => {
    // baseSnapshot: openai/gpt-4 canonical + serving with description/cost/effort should be mixed
    const res = getModelMetadataForDisplay(makeModel('gpt-4'))
    expect(res.source).toBe('mixed')
    expect(res.canonical).toBeDefined()
    expect(res.serving).toBeDefined()
    expect(res.effective?.description).toBe('serving desc')
    expect(res.effective?.cost).toEqual({ input: 1, output: 2 })
    expect(res.effective?.effort).toEqual(['low'])

    // also when serving contributes only modalities
    const res2 = getModelMetadataForDisplay(makeModel('gpt-4o'))
    expect(res2.source).toBe('mixed')

    // serving with only description (simulate minimal serving)
    const snapDescOnly: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'openai/desc-only': { id: 'openai/desc-only', modalities: { input: ['text'], output: ['text'] } }
      },
      providers: {
        openai: {
          api: 'https://api.openai.com/v1',
          name: 'OpenAI',
          models: {
            'desc-only': { id: 'desc-only', description: 'only desc' }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snapDescOnly)
    const res3 = getModelMetadataForDisplay(makeModel('desc-only'))
    expect(res3.source).toBe('mixed')
    expect(res3.effective?.description).toBe('only desc')

    // serving with only cost
    const snapCostOnly: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'openai/cost-only': { id: 'openai/cost-only', modalities: { input: ['text'], output: ['text'] } }
      },
      providers: {
        openai: {
          api: 'https://api.openai.com/v1',
          name: 'OpenAI',
          models: {
            'cost-only': { id: 'cost-only', cost: { input: 5 } }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snapCostOnly)
    const res4 = getModelMetadataForDisplay(makeModel('cost-only'))
    expect(res4.source).toBe('mixed')

    // serving with only effort
    const snapEffortOnly: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'openai/effort-only': { id: 'openai/effort-only', modalities: { input: ['text'], output: ['text'] } }
      },
      providers: {
        openai: {
          api: 'https://api.openai.com/v1',
          name: 'OpenAI',
          models: {
            'effort-only': { id: 'effort-only', effort: ['medium'] }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snapEffortOnly)
    const res5 = getModelMetadataForDisplay(makeModel('effort-only'))
    expect(res5.source).toBe('mixed')

    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('effective merges: serving wins, canonical fills missing', () => {
    const res = getModelMetadataForDisplay(makeModel('gpt-4'))
    // serving has name/description/cost/effort, canonical has family/limits
    expect(res.effective?.name).toBe('GPT-4')
    expect(res.effective?.family).toBe('gpt')
    expect(res.effective?.limits?.context).toBe(128000)
  })
})
