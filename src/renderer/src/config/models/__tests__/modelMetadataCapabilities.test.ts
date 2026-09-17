import { setMetadataProviderResolver, setModelMetadataSnapshotForTests } from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveCustomProviderForModel } from '../../../services/customProviderRegistry'
import {
  getExternalModelContext,
  getExternalModelPricing,
  getExternalReasoningEffortOptions,
  resolveExternalTemperatureSupport,
  resolveExternalToolCallSupport,
  resolveExternalVisionSupport
} from '../modelMetadata'
import { getModelSupportedReasoningEffortOptions, isReasoningModel } from '../reasoning'
import { isFunctionCallingModel } from '../tooluse'
import { isVisionModel } from '../vision'

// Isolate the predicate chain from the real Redux store: reasoning/vision
// import settings/store hooks that would otherwise pull the full store (same
// pattern as the existing vision tests). Legacy embedding/rerank detection
// stays real.
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

const providersById: Record<string, Provider> = { a: anthropicProvider }

const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  providers: {
    anthropic: {
      api: '',
      name: 'Anthropic',
      models: {
        'zzz-custom-1': {
          id: 'zzz-custom-1',
          modalities: { input: ['text', 'image'], output: ['text'] },
          attachment: false,
          toolCall: true,
          reasoning: true,
          reasoningControls: { toggle: true, effort: ['low', 'high', 'max'] },
          temperature: true,
          limits: { context: 500000, output: 64000 },
          pricing: { input: 2, output: 10, cacheRead: 0.2 },
          family: 'zzz',
          knowledgeCutoff: '2026-01-01'
        },
        'gpt-4o-custom': {
          id: 'gpt-4o-custom',
          modalities: { input: ['text'], output: ['text'] },
          toolCall: false,
          reasoning: false
        },
        'my-thinking-fork': {
          id: 'my-thinking-fork',
          modalities: { input: ['text'], output: ['text'] },
          reasoning: false,
          toolCall: false
        },
        'claude-xyz-custom': {
          id: 'claude-xyz-custom',
          modalities: { input: ['text'], output: ['text'] },
          toolCall: false
        }
      }
    }
  }
}

const makeModel = (id: string, provider = 'a', capabilities?: Model['capabilities']): Model =>
  ({ id, name: id, provider, group: provider, ...(capabilities ? { capabilities } : {}) }) as Model

beforeEach(() => {
  vi.clearAllMocks()
  // Attribution flows through the injected accessor (no AssistantService /
  // store import inside config/models): exact provider-id match only.
  setMetadataProviderResolver((model) => providersById[model?.provider ?? ''] ?? null)
  setModelMetadataSnapshotForTests(SNAPSHOT)
})

describe('priority: user override -> external metadata -> legacy heuristic', () => {
  it('prefers validated external metadata over the legacy name heuristic', () => {
    // zzz-custom-1 matches no legacy vision/tool/reasoning pattern, but the
    // registry knows it.
    expect(isVisionModel(makeModel('zzz-custom-1'))).toBe(true)
    expect(isFunctionCallingModel(makeModel('zzz-custom-1'))).toBe(true)
    expect(isReasoningModel(makeModel('zzz-custom-1'))).toBe(true)
  })

  it('lets external false overrule a legacy true', () => {
    // gpt-4o-custom matches legacy vision; my-thinking-fork matches legacy
    // reasoning ("thinking"); claude-xyz-custom matches legacy tool calling.
    expect(isVisionModel(makeModel('gpt-4o-custom'))).toBe(false)
    expect(isReasoningModel(makeModel('my-thinking-fork'))).toBe(false)
    expect(isFunctionCallingModel(makeModel('claude-xyz-custom'))).toBe(false)
  })

  it('keeps explicit user overrides at highest priority', () => {
    const visionOff = makeModel('zzz-custom-1', 'a', [{ type: 'vision', isUserSelected: false }])
    expect(isVisionModel(visionOff)).toBe(false)
    const visionOn = makeModel('gpt-4o-custom', 'a', [{ type: 'vision', isUserSelected: true }])
    expect(isVisionModel(visionOn)).toBe(true)

    const toolOff = makeModel('zzz-custom-1', 'a', [{ type: 'function_calling', isUserSelected: false }])
    expect(isFunctionCallingModel(toolOff)).toBe(false)

    const reasoningOn = makeModel('my-thinking-fork', 'a', [{ type: 'reasoning', isUserSelected: true }])
    expect(isReasoningModel(reasoningOn)).toBe(true)
  })

  it('falls back to legacy behavior when the snapshot is absent', () => {
    setModelMetadataSnapshotForTests(null)
    expect(isVisionModel(makeModel('zzz-custom-1'))).toBe(false)
    expect(isVisionModel(makeModel('gpt-4o-custom'))).toBe(true)
    expect(isFunctionCallingModel(makeModel('claude-xyz-custom'))).toBe(true)
    expect(isReasoningModel(makeModel('my-thinking-fork'))).toBe(true)
  })
})

describe('vision uses modalities.input, not attachment', () => {
  it('returns true for image modality even when attachment is false', () => {
    expect(resolveExternalVisionSupport(makeModel('zzz-custom-1'))).toBe(true)
  })

  it('returns false for text-only modality and unknown for missing/empty lists', () => {
    expect(resolveExternalVisionSupport(makeModel('gpt-4o-custom'))).toBe(false)
    expect(resolveExternalVisionSupport(makeModel('not-mapped'))).toBeUndefined()
  })
})

describe('tool_call / temperature tri-state', () => {
  it('maps tool_call true/false and keeps absent unknown', () => {
    expect(resolveExternalToolCallSupport(makeModel('zzz-custom-1'))).toBe(true)
    expect(resolveExternalToolCallSupport(makeModel('gpt-4o-custom'))).toBe(false)
    expect(resolveExternalToolCallSupport(makeModel('not-mapped'))).toBeUndefined()
  })

  it('maps temperature and keeps absent unknown', () => {
    expect(resolveExternalTemperatureSupport(makeModel('zzz-custom-1'))).toBe(true)
    expect(resolveExternalTemperatureSupport(makeModel('gpt-4o-custom'))).toBeUndefined()
  })
})

describe('strict provider attribution (no silent default fallback)', () => {
  it('returns unknown when the owning provider entry is gone', () => {
    setMetadataProviderResolver(() => null)
    const orphan = makeModel('zzz-custom-1', 'deleted-provider')
    expect(resolveExternalVisionSupport(orphan)).toBeUndefined()
    expect(resolveExternalToolCallSupport(orphan)).toBeUndefined()
    expect(getExternalModelPricing(orphan)).toBeUndefined()
  })

  it('rejects a sloppy resolver result whose id is not the model provider', () => {
    // Even if a resolver substitutes another provider (the old silent
    // default fallback), the boundary enforces the exact id match.
    setMetadataProviderResolver(() => ({ ...anthropicProvider, id: 'default-other' }) as Provider)
    const orphan = makeModel('zzz-custom-1', 'deleted-provider')
    expect(resolveExternalVisionSupport(orphan)).toBeUndefined()
    expect(getExternalModelPricing(orphan)).toBeUndefined()
  })
})

describe('reasoning effort options — external supplement only', () => {
  it('maps external effort values (max -> xhigh) when legacy has no answer', () => {
    expect(getExternalReasoningEffortOptions(makeModel('zzz-custom-1'))).toEqual(['default', 'low', 'high', 'xhigh'])
    expect(getModelSupportedReasoningEffortOptions(makeModel('zzz-custom-1'))).toEqual([
      'default',
      'low',
      'high',
      'xhigh'
    ])
  })

  it('leaves legacy answers untouched and unknown ids permissive', () => {
    // o3-mini has a legacy answer; external must not override it.
    const legacy = getModelSupportedReasoningEffortOptions(makeModel('o3-mini'))
    expect(legacy).toBeDefined()
    // external reasoning false -> no supplement -> still undefined
    expect(getExternalReasoningEffortOptions(makeModel('gpt-4o-custom'))).toBeUndefined()
    // unmapped id -> undefined exactly as before (never a rejection)
    expect(getModelSupportedReasoningEffortOptions(makeModel('definitely-not-a-model-zzz'))).toBeUndefined()
    expect(getExternalReasoningEffortOptions(makeModel('definitely-not-a-model-zzz'))).toBeUndefined()
  })
})

describe('pricing/context enrichment only', () => {
  it('returns externally-sourced pricing distinguishable from user pricing', () => {
    expect(getExternalModelPricing(makeModel('zzz-custom-1'))).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.2,
      source: 'models.dev'
    })
    expect(getExternalModelPricing(makeModel('not-mapped'))).toBeUndefined()
  })

  it('returns context/family enrichment and undefined when nothing is published', () => {
    expect(getExternalModelContext(makeModel('zzz-custom-1'))).toEqual({
      contextLimit: 500000,
      outputLimit: 64000,
      family: 'zzz',
      knowledgeCutoff: '2026-01-01'
    })
    expect(getExternalModelContext(makeModel('not-mapped'))).toBeUndefined()
  })
})

describe('malformed in-memory shapes never throw in predicates', () => {
  it.each([
    ['null providers', { source: 'models.dev', fetchedAt: 1, providers: null }],
    ['null source entry', { source: 'models.dev', fetchedAt: 1, providers: { anthropic: null } }],
    [
      'null models',
      { source: 'models.dev', fetchedAt: 1, providers: { anthropic: { api: '', name: 'A', models: null } } }
    ]
  ])('falls back to legacy behavior for %s', (_label, shape) => {
    setModelMetadataSnapshotForTests(shape as never)
    expect(() => isVisionModel(makeModel('zzz-custom-1'))).not.toThrow()
    expect(() => isFunctionCallingModel(makeModel('zzz-custom-1'))).not.toThrow()
    expect(() => isReasoningModel(makeModel('zzz-custom-1'))).not.toThrow()
    expect(() => getModelSupportedReasoningEffortOptions(makeModel('zzz-custom-1'))).not.toThrow()
    // legacy answers unchanged: unknown ids stay permissive
    expect(isVisionModel(makeModel('zzz-custom-1'))).toBe(false)
    expect(isReasoningModel(makeModel('my-thinking-fork'))).toBe(true)
    setModelMetadataSnapshotForTests(SNAPSHOT)
  })
})

describe('unknown/no-snapshot permissive request path', () => {
  it('still resolves unknown model ids to their owning provider (never gated)', () => {
    setModelMetadataSnapshotForTests(null)
    const providers = [anthropicProvider]
    const resolved = resolveCustomProviderForModel(makeModel('never-seen-custom-id', 'a'), providers)
    expect(resolved.id).toBe('a')
    // ...while capability predicates degrade to legacy behavior, not rejection
    expect(isVisionModel(makeModel('never-seen-custom-id'))).toBe(false)
    expect(isReasoningModel(makeModel('never-seen-custom-id'))).toBe(false)
  })
})
