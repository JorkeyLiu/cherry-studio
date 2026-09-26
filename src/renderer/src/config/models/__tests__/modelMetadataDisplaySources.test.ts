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

const customProvider: Provider = {
  id: 'custom',
  type: 'openai',
  name: 'Custom',
  apiKey: '',
  apiHost: 'https://custom.example/v1',
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

describe('getModelMetadataForDisplay source honest mixed rule (model-centric)', () => {
  it('returns none when canonical is absent, even if a serving record exists elsewhere', () => {
    setModelMetadataSnapshotForTests({ source: 'models.dev', fetchedAt: 1, models: {}, providers: {} })
    const res = getModelMetadataForDisplay(makeModel('unknown-id'))
    expect(res.source).toBe('none')
    expect(res.canonical).toBeUndefined()
    expect(res.serving).toBeUndefined()
    expect(res.effective).toBeUndefined()
  })

  it('returns none when only a non-lab serving record exists without canonical', () => {
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
    // Model-centric reference requires canonical first: no canonical, no display.
    const res = getModelMetadataForDisplay(makeModel('only-serving'))
    expect(res.source).toBe('none')
    expect(res.effective).toBeUndefined()
  })

  it('returns canonical when canonical exists and reference serving does not', () => {
    // Unknown provider connection never controls the display result.
    setMetadataProviderResolver(() => null)
    const res2 = getModelMetadataForDisplay(makeModel('gpt-4', 'gpt-4', 'unknown-provider'))
    expect(res2.source).toBe('mixed')
    expect(res2.canonical).toBeDefined()
    expect(res2.serving).toBeDefined()
    // restore resolver for other tests
    setMetadataProviderResolver((m) => (m?.provider === 'openai' ? providerOpenAI : null))
    // Canonical without any reference serving entry stays canonical.
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

  it('is independent of the user provider connection and API host', () => {
    const viaOfficial = getModelMetadataForDisplay(makeModel('gpt-4'), providerOpenAI)
    const viaCustom = getModelMetadataForDisplay(makeModel('gpt-4'), customProvider)
    const viaNull = getModelMetadataForDisplay(makeModel('gpt-4'), null)
    expect(viaOfficial.source).toBe('mixed')
    expect(viaCustom).toEqual(viaOfficial)
    expect(viaNull).toEqual(viaOfficial)
  })

  it('returns none when the canonical lab has no provider entry', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'nolab/model-z': { id: 'nolab/model-z', modalities: { input: ['text'], output: ['text'] } }
      },
      providers: {}
    }
    setModelMetadataSnapshotForTests(snap)
    const res = getModelMetadataForDisplay(makeModel('model-z'))
    expect(res.source).toBe('canonical')
    expect(res.serving).toBeUndefined()
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('returns mixed when both exist and reference serving has any field (including description/cost/effort)', () => {
    // baseSnapshot: openai/gpt-4 canonical + reference basename serving with description/cost/effort.
    const res = getModelMetadataForDisplay(makeModel('gpt-4'))
    expect(res.source).toBe('mixed')
    expect(res.canonical).toBeDefined()
    expect(res.serving).toBeDefined()
    expect(res.effective?.description).toBe('serving desc')
    expect(res.effective?.cost).toEqual({ input: 1, output: 2 })
    expect(res.effective?.effort).toEqual(['low'])

    // also when reference contributes only modalities
    const res2 = getModelMetadataForDisplay(makeModel('gpt-4o'))
    expect(res2.source).toBe('mixed')

    // reference with only description (simulate minimal reference)
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

    // reference with only cost
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

    // reference with only effort
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

  it('resolves a unique exact display name for a differing official serving entry inside the canonical lab', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'deepseek/deepseek-v4.1-flash': {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: {
        deepseek: {
          api: 'https://api.deepseek.example/v1',
          name: 'DeepSeek',
          models: {
            'deepseek-flash': { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', cost: { input: 3 } }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    const res = getModelMetadataForDisplay(makeModel('deepseek/deepseek-v4.1-flash'))
    expect(res.source).toBe('mixed')
    expect(res.serving?.id).toBe('deepseek-flash')
    expect(res.effective?.cost).toEqual({ input: 3 })
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('effective merges: reference serving wins, canonical fills missing', () => {
    const res = getModelMetadataForDisplay(makeModel('gpt-4'))
    // reference has name/description/cost/effort, canonical has family/limits
    expect(res.effective?.name).toBe('GPT-4')
    expect(res.effective?.family).toBe('gpt')
    expect(res.effective?.limits?.context).toBe(128000)
  })

  it('resolves the exact official serving ID to the same unified reference metadata as canonical (deepseek-flash)', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'deepseek/deepseek-v4.1-flash': {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          modalities: { input: ['text'], output: ['text'] },
          limits: { context: 128000, output: 32000 }
        }
      },
      providers: {
        deepseek: {
          api: 'https://api.deepseek.com/v1',
          name: 'DeepSeek',
          models: {
            'deepseek-flash': {
              id: 'deepseek-flash',
              name: 'DeepSeek V4.1 Flash',
              cost: { input: 0.15, output: 1.2 },
              limits: { context: 128000 },
              effort: ['low', 'medium']
            }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    const viaServing = getModelMetadataForDisplay(makeModel('deepseek-flash'))
    const viaCanonical = getModelMetadataForDisplay(makeModel('deepseek/deepseek-v4.1-flash'))
    // Same unified reference metadata: mixed source with official reference
    // cost/limits/effort, proving the Edit Model UI no longer shows no-data.
    expect(viaServing.source).toBe('mixed')
    expect(viaCanonical.source).toBe('mixed')
    expect(viaServing.canonical?.id).toBe('deepseek/deepseek-v4.1-flash')
    expect(viaServing.effective?.cost).toEqual({ input: 0.15, output: 1.2 })
    expect(viaServing.effective?.effort).toEqual(['low', 'medium'])
    expect(viaServing.effective).toEqual(viaCanonical.effective)
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('never rewrites the request Model.id and never uses editable name/group/apiHost', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'deepseek/deepseek-v4.1-flash': {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: {
        deepseek: {
          api: 'https://api.deepseek.com/v1',
          name: 'DeepSeek',
          models: {
            'deepseek-flash': { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', cost: { input: 3 } }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    const model = { id: 'deepseek-flash', name: 'My Custom Name', provider: 'custom', group: 'custom-group' } as Model
    const customConn = {
      id: 'custom',
      type: 'openai',
      name: 'Custom',
      apiKey: '',
      apiHost: 'https://custom.example/v1',
      models: []
    } as unknown as Provider
    const res = getModelMetadataForDisplay(model, customConn)
    expect(res.source).toBe('mixed')
    expect(res.canonical?.id).toBe('deepseek/deepseek-v4.1-flash')
    // The caller's Model is untouched: request identity stays `deepseek-flash`.
    expect(model.id).toBe('deepseek-flash')
    expect(model.name).toBe('My Custom Name')
    // A misleading editable name/group/connection never changes the result.
    const misleading = {
      id: 'deepseek-flash',
      name: 'Something Else Entirely',
      provider: 'custom',
      group: 'other-group'
    } as Model
    expect(getModelMetadataForDisplay(misleading, customConn)).toEqual(res)
    expect(getModelMetadataForDisplay(misleading, null)).toEqual(res)
    expect(getModelMetadataForDisplay(misleading, providerOpenAI)).toEqual(res)
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('resolves a mirrored serving key when only one source yields a same-lab canonical candidate', () => {
    // Live models.dev reality: `deepseek-flash` exists under both `deepseek`
    // and the `302ai` mirror. Only `deepseek` yields a same-lab canonical
    // candidate (`deepseek/deepseek-v4.1-flash`); `302ai` has no `302ai/*`
    // canonical model, so the mirrored key still resolves to DeepSeek.
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'deepseek/deepseek-v4.1-flash': {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: {
        deepseek: {
          api: 'https://api.deepseek.com/v1',
          name: 'DeepSeek',
          models: {
            'deepseek-flash': { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', cost: { input: 1 } }
          }
        },
        '302ai': {
          api: 'https://api.302.ai/v1',
          name: '302.AI',
          models: {
            'deepseek-flash': { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', cost: { input: 9 } }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    const res = getModelMetadataForDisplay(makeModel('deepseek-flash'))
    expect(res.source).toBe('mixed')
    expect(res.canonical?.id).toBe('deepseek/deepseek-v4.1-flash')
    expect(res.effective?.cost).toEqual({ input: 1 })
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('fails closed when two sources each yield distinct same-lab canonical candidates', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'lab-a/model-a': {
          id: 'lab-a/model-a',
          name: 'Name A',
          modalities: { input: ['text'], output: ['text'] }
        },
        'lab-b/model-b': {
          id: 'lab-b/model-b',
          name: 'Name B',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: {
        'lab-a': {
          api: 'https://api.a.example/v1',
          name: 'Lab A',
          models: {
            'shared-serving': { id: 'shared-serving', name: 'Name A', cost: { input: 1 } }
          }
        },
        'lab-b': {
          api: 'https://api.b.example/v1',
          name: 'Lab B',
          models: {
            'shared-serving': { id: 'shared-serving', name: 'Name B', cost: { input: 2 } }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    const res = getModelMetadataForDisplay(makeModel('shared-serving'))
    expect(res.source).toBe('none')
    expect(res.effective).toBeUndefined()
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('fails closed on duplicate exact canonical names in the lab without folded fallback', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'lab-a/one': {
          id: 'lab-a/one',
          name: 'Case Model',
          modalities: { input: ['text'], output: ['text'] }
        },
        'lab-a/two': {
          id: 'lab-a/two',
          name: 'Case Model',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: {
        'lab-a': {
          api: 'https://api.a.example/v1',
          name: 'Lab A',
          models: {
            'serving-x': { id: 'serving-x', name: 'Case Model', cost: { input: 1 } },
            'folded-only': { id: 'folded-only', name: 'case model', cost: { input: 2 } }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    // Exact-name ambiguity fails immediately and never falls through to the
    // folded-only candidate.
    const res = getModelMetadataForDisplay(makeModel('serving-x'))
    expect(res.source).toBe('none')
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('recovers a folded-only unique official serving ID and rejects unsafe/empty inputs', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'lab-a/case-model': {
          id: 'lab-a/case-model',
          name: 'Case Model',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: {
        'lab-a': {
          api: 'https://api.a.example/v1',
          name: 'Lab A',
          models: {
            'folded-serving': { id: 'folded-serving', name: 'case model', cost: { input: 4 } }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    const res = getModelMetadataForDisplay(makeModel('folded-serving'))
    expect(res.source).toBe('mixed')
    expect(res.canonical?.id).toBe('lab-a/case-model')
    expect(getModelMetadataForDisplay(makeModel('__proto__')).source).toBe('none')
    expect(getModelMetadataForDisplay(makeModel('')).source).toBe('none')
    expect(getModelMetadataForDisplay(makeModel('   ')).source).toBe('none')
    expect(getModelMetadataForDisplay(undefined).source).toBe('none')
    expect(getModelMetadataForDisplay(null).source).toBe('none')
    setModelMetadataSnapshotForTests(baseSnapshot)
  })

  it('keeps direct canonical precedence and full-id/basename behavior', () => {
    const snap: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'deepseek/deepseek-v4.1-flash': {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          modalities: { input: ['text'], output: ['text'] }
        },
        'deepseek/other-model': {
          id: 'deepseek/other-model',
          name: 'Other',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: {
        deepseek: {
          api: 'https://api.deepseek.com/v1',
          name: 'DeepSeek',
          models: {
            'deepseek-flash': { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', cost: { input: 3 } }
          }
        }
      }
    }
    setModelMetadataSnapshotForTests(snap)
    // Direct full-id and basename inputs resolve without the reverse path.
    expect(getModelMetadataForDisplay(makeModel('deepseek/deepseek-v4.1-flash')).source).toBe('mixed')
    expect(getModelMetadataForDisplay(makeModel('deepseek-v4.1-flash')).source).toBe('mixed')
    setModelMetadataSnapshotForTests(baseSnapshot)
  })
})
