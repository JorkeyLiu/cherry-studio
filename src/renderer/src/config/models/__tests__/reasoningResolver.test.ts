import { setMetadataProviderResolver, setModelMetadataSnapshotForTests } from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getModelSupportedReasoningEffortOptions,
  getResolvedReasoningOptions,
  isFixedReasoningModel,
  isReasoningModel
} from '../reasoning'

vi.mock('@renderer/hooks/useStore', () => ({
  getStoreProviders: vi.fn(() => [])
}))

vi.mock('@renderer/store', () => ({
  __esModule: true,
  default: {
    getState: () => ({
      llm: { providers: [] },
      settings: {}
    })
  },
  useAppDispatch: vi.fn(),
  useAppSelector: vi.fn()
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: vi.fn(() => ({})),
  useNavbarPosition: vi.fn(() => ({ navbarPosition: 'left' })),
  useMessageStyle: vi.fn(() => ({ isBubbleStyle: false })),
  getStoreSetting: vi.fn()
}))

const anthropicProvider = {
  id: 'a',
  type: 'anthropic',
  name: 'a',
  apiKey: '',
  apiHost: '',
  models: []
} as unknown as Provider

const geminiProvider = {
  id: 'g',
  type: 'gemini',
  name: 'g',
  apiKey: '',
  apiHost: '',
  models: []
} as unknown as Provider

const providersById: Record<string, Provider> = { a: anthropicProvider, g: geminiProvider }

const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  models: {
    'lab/o3-mini': {
      id: 'lab/o3-mini',
      modalities: { input: ['text'], output: ['text'] },
      toolCall: false,
      reasoning: true
    },
    'lab/reasoning-true': {
      id: 'lab/reasoning-true',
      modalities: { input: ['text'], output: ['text'] },
      reasoning: true
    },
    'lab/reasoning-false': {
      id: 'lab/reasoning-false',
      modalities: { input: ['text'], output: ['text'] },
      reasoning: false
    },
    'lab/unknown-missing': {
      id: 'lab/unknown-missing',
      modalities: { input: ['text'], output: ['text'] }
    },
    'lab/served-model': {
      id: 'lab/served-model',
      modalities: { input: ['text'], output: ['text'] },
      reasoning: true
    },
    'lab/my-thinking-fork': {
      id: 'lab/my-thinking-fork',
      modalities: { input: ['text'], output: ['text'] },
      toolCall: false,
      reasoning: false
    }
  },
  providers: {
    anthropic: {
      api: '',
      name: 'a',
      models: {
        'served-model': { effort: ['low', 'high', 'max'] },
        'low-only': { effort: ['low'] },
        'dedup-model': { effort: ['low', 'high', 'max', 'low'] },
        'with-none': { effort: ['none', 'low'] }
      }
    },
    google: {
      api: '',
      name: 'g',
      models: {
        'gemini-served': { effort: ['low', 'high'] }
      }
    }
  }
}

const makeModel = (id: string, provider = 'a', capabilities?: Model['capabilities']): Model =>
  ({ id, name: id, provider, group: provider, ...(capabilities ? { capabilities } : {}) }) as Model

beforeEach(() => {
  vi.clearAllMocks()
  setMetadataProviderResolver((model) => providersById[model?.provider ?? ''] ?? null)
  setModelMetadataSnapshotForTests(SNAPSHOT)
})

describe('single resolver: product options default/none', () => {
  it('reasoning:false returns default/none', () => {
    expect(getResolvedReasoningOptions(makeModel('reasoning-false'))).toEqual(['default', 'none'])
    expect(getResolvedReasoningOptions(makeModel('my-thinking-fork'))).toEqual(['default', 'none'])
  })

  it('isFixed is always false (UI fixed determination removed)', () => {
    expect(isFixedReasoningModel(makeModel('reasoning-false'))).toBe(false)
    expect(isFixedReasoningModel(makeModel('o3-mini'))).toBe(false)
    expect(isFixedReasoningModel(makeModel('served-model'))).toBe(false)
  })
})

describe('single resolver: canonical true or missing -> generic fallback', () => {
  it('reasoning:true without serving returns generic low/medium/high', () => {
    expect(getResolvedReasoningOptions(makeModel('reasoning-true'))).toEqual([
      'default',
      'none',
      'low',
      'medium',
      'high'
    ])
    expect(getResolvedReasoningOptions(makeModel('o3-mini'))).toEqual(['default', 'none', 'low', 'medium', 'high'])
  })

  it('missing reasoning (unknown) returns same generic fallback', () => {
    expect(getResolvedReasoningOptions(makeModel('unknown-missing'))).toEqual([
      'default',
      'none',
      'low',
      'medium',
      'high'
    ])
  })

  it('falls back to generic when snapshot is absent', () => {
    setModelMetadataSnapshotForTests(null)
    expect(getResolvedReasoningOptions(makeModel('o3-mini'))).toEqual(['default', 'none', 'low', 'medium', 'high'])
  })
})

describe('single resolver: provider-specific serving effort', () => {
  it('with serving effort values returns default/none + normalized values, max->xhigh', () => {
    expect(getResolvedReasoningOptions(makeModel('served-model'))).toEqual(['default', 'none', 'low', 'high', 'xhigh'])
    expect(getModelSupportedReasoningEffortOptions(makeModel('served-model'))).toEqual([
      'default',
      'none',
      'low',
      'high',
      'xhigh'
    ])
  })

  it('deduplicates and keeps product none only once', () => {
    expect(getResolvedReasoningOptions(makeModel('dedup-model'))).toEqual(['default', 'none', 'low', 'high', 'xhigh'])
    expect(getResolvedReasoningOptions(makeModel('with-none'))).toEqual(['default', 'none', 'low'])
  })

  it('without serving for this provider falls back to generic', () => {
    // reasoning-true has no serving entry for provider a
    expect(getResolvedReasoningOptions(makeModel('reasoning-true'))).toEqual([
      'default',
      'none',
      'low',
      'medium',
      'high'
    ])
  })

  it('provider mismatch does not leak serving (exact provider->source mapping)', () => {
    // served-model only exists under provider a, not g
    expect(getResolvedReasoningOptions(makeModel('served-model', 'g'))).toEqual([
      'default',
      'none',
      'low',
      'medium',
      'high'
    ])
  })

  it('explicit null provider (known absent) falls back to generic, no serving', () => {
    expect(getResolvedReasoningOptions(makeModel('served-model'), null)).toEqual([
      'default',
      'none',
      'low',
      'medium',
      'high'
    ])
  })
})

describe('single resolver: provider-specific not merged into canonical', () => {
  it('canonical false stays false regardless of other provider serving', () => {
    // reasoning-false is canonical false; even if another provider had serving for same id (not in this snapshot), it must stay default/none
    expect(isReasoningModel(makeModel('reasoning-false'))).toBe(false)
    expect(getResolvedReasoningOptions(makeModel('reasoning-false'))).toEqual(['default', 'none'])
  })

  it('same model id served under one provider does not affect canonical global', () => {
    // served-model is canonical true with serving under a; under g it should not inherit a's serving
    expect(getResolvedReasoningOptions(makeModel('served-model', 'a'))).toEqual([
      'default',
      'none',
      'low',
      'high',
      'xhigh'
    ])
    expect(getResolvedReasoningOptions(makeModel('served-model', 'g'))).not.toEqual([
      'default',
      'none',
      'low',
      'high',
      'xhigh'
    ])
  })
})

describe('single resolver: user override', () => {
  it('lets explicit user override win: false -> undefined, true -> generic or serving', () => {
    const forced = makeModel('never-seen-zzz', 'a', [{ type: 'reasoning', isUserSelected: true }])
    expect(getResolvedReasoningOptions(forced)).toEqual(['default', 'none', 'low', 'medium', 'high'])
    const rejected = makeModel('o3-mini', 'a', [{ type: 'reasoning', isUserSelected: false }])
    expect(getResolvedReasoningOptions(rejected)).toBeUndefined()
  })

  it('user forced true with serving returns serving options', () => {
    const forcedServed = makeModel('served-model', 'a', [{ type: 'reasoning', isUserSelected: true }])
    expect(getResolvedReasoningOptions(forcedServed)).toEqual(['default', 'none', 'low', 'high', 'xhigh'])
  })
})

describe('single resolver: request layer lazy (no extra blocking)', () => {
  it('unknown model without serving still returns generic (never undefined) unless user override false', () => {
    expect(getResolvedReasoningOptions(makeModel('never-seen-zzz'))).toEqual([
      'default',
      'none',
      'low',
      'medium',
      'high'
    ])
    expect(isFixedReasoningModel(makeModel('never-seen-zzz'))).toBe(false)
  })
})
