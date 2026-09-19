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

// Isolate the predicate chain from the real Redux store (same pattern as the
// sibling capability tests).
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

// Canonical snapshot: canonical models.json publishes reasoning support but
// no reasoning options, so option lists always come from heuristics.
const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  models: {
    // Matches the o-series heuristic (default/low/medium/high); canonical
    // metadata knows reasoning support but publishes no controls.
    'lab/o3-mini': {
      id: 'lab/o3-mini',
      modalities: { input: ['text'], output: ['text'] },
      toolCall: false,
      reasoning: true
    },
    'lab/toggle-only-model': {
      id: 'lab/toggle-only-model',
      modalities: { input: ['text'], output: ['text'] },
      toolCall: false,
      reasoning: true
    },
    'lab/fixed-ext-model': {
      id: 'lab/fixed-ext-model',
      modalities: { input: ['text'], output: ['text'] },
      toolCall: false,
      reasoning: true
    },
    // Canonical false overrules a legacy true ('thinking' in the id).
    'lab/my-thinking-fork': {
      id: 'lab/my-thinking-fork',
      modalities: { input: ['text'], output: ['text'] },
      toolCall: false,
      reasoning: false
    }
  },
  providers: {}
}

const makeModel = (id: string, provider = 'a', capabilities?: Model['capabilities']): Model =>
  ({ id, name: id, provider, group: provider, ...(capabilities ? { capabilities } : {}) }) as Model

beforeEach(() => {
  vi.clearAllMocks()
  setMetadataProviderResolver((model) => providersById[model?.provider ?? ''] ?? null)
  setModelMetadataSnapshotForTests(SNAPSHOT)
})

describe('single resolver: automatic capability, no manual marking', () => {
  it('resolves reasoning capability without user-selected capabilities', () => {
    expect(isReasoningModel(makeModel('o3-mini'))).toBe(true)
    expect(isFixedReasoningModel(makeModel('o3-mini'))).toBe(false)
  })

  it('lets an explicit user override win over canonical metadata', () => {
    const forced = makeModel('never-seen-zzz', 'a', [{ type: 'reasoning', isUserSelected: true }])
    expect(getResolvedReasoningOptions(forced)).toEqual(['default'])
    const rejected = makeModel('o3-mini', 'a', [{ type: 'reasoning', isUserSelected: false }])
    expect(getResolvedReasoningOptions(rejected)).toBeUndefined()
  })
})

describe('single resolver: canonical support with heuristic option lists', () => {
  it('uses heuristic lists when canonical metadata knows reasoning but publishes no controls', () => {
    expect(getResolvedReasoningOptions(makeModel('o3-mini'))).toEqual(['default', 'low', 'medium', 'high'])
    expect(getModelSupportedReasoningEffortOptions(makeModel('o3-mini'))).toEqual(['default', 'low', 'medium', 'high'])
  })

  it('lets canonical false overrule a legacy true', () => {
    expect(isReasoningModel(makeModel('my-thinking-fork'))).toBe(false)
    expect(getResolvedReasoningOptions(makeModel('my-thinking-fork'))).toBeUndefined()
  })

  it('falls back to heuristics when the snapshot is absent', () => {
    setModelMetadataSnapshotForTests(null)
    expect(getResolvedReasoningOptions(makeModel('o3-mini'))).toEqual(['default', 'low', 'medium', 'high'])
  })
})

describe('single resolver: fixed models', () => {
  it('represents reasoning without heuristic controls as fixed (default only, no false menu)', () => {
    expect(getResolvedReasoningOptions(makeModel('fixed-ext-model'))).toEqual(['default'])
    expect(isFixedReasoningModel(makeModel('fixed-ext-model'))).toBe(true)
  })

  it('keeps always-thinking Qwen fixed and controllable Qwen listed', () => {
    expect(getResolvedReasoningOptions(makeModel('qwen3-thinking'))).toEqual(['default'])
    expect(isFixedReasoningModel(makeModel('qwen3-thinking'))).toBe(true)
    const controllable = getResolvedReasoningOptions(makeModel('qwen3-235b-a22b'))
    expect(controllable).toContain('high')
    expect(controllable?.length).toBeGreaterThan(1)
  })

  it('leaves unknown models undefined (never gated, never fixed)', () => {
    expect(getResolvedReasoningOptions(makeModel('never-seen-zzz'))).toBeUndefined()
    expect(isFixedReasoningModel(makeModel('never-seen-zzz'))).toBe(false)
  })
})

describe('single resolver: protocol lane filtering (no brand branches)', () => {
  it('degrades non-Gemini reasoning to fixed on the Gemini native lane', () => {
    expect(getResolvedReasoningOptions(makeModel('o3-mini'), geminiProvider)).toEqual(['default'])
  })

  it('skips lane filtering when the connection is explicitly unknown', () => {
    expect(getResolvedReasoningOptions(makeModel('o3-mini'), null)).toEqual(['default', 'low', 'medium', 'high'])
  })

  it('keeps Gemini-family controls on the Gemini native lane', () => {
    const options = getResolvedReasoningOptions(makeModel('gemini-2.5-flash'), geminiProvider)
    expect(options).toContain('high')
    expect(options?.length).toBeGreaterThan(1)
  })
})
