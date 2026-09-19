import { setMetadataProviderResolver, setModelMetadataSnapshotForTests } from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import type { ModelMetadataSnapshot } from '@shared/modelMetadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveCustomProviderForModel } from '../../../services/customProviderRegistry'
import {
  getExternalModelContext,
  getExternalModelEntry,
  resolveExternalTemperatureSupport,
  resolveExternalToolCallSupport,
  resolveExternalVisionSupport
} from '../modelMetadata'
import { isReasoningModel } from '../reasoning'
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

const proxyProvider = {
  id: 'my-proxy',
  type: 'openai',
  name: 'My Proxy',
  apiKey: '',
  apiHost: 'https://proxy.example/v1',
  models: []
} as unknown as Provider

const otherProxyProvider = {
  id: 'other-proxy',
  type: 'openai',
  name: 'Other Proxy',
  apiKey: '',
  apiHost: 'https://other-proxy.example/v1',
  models: []
} as unknown as Provider

const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  models: {
    'lab-zzz/zzz-custom-1': {
      id: 'lab-zzz/zzz-custom-1',
      modalities: { input: ['text', 'image'], output: ['text'] },
      attachment: false,
      toolCall: true,
      reasoning: true,
      temperature: true,
      limits: { context: 500000, output: 64000 },
      family: 'zzz',
      knowledgeCutoff: '2026-01-01'
    },
    'lab-zzz/gpt-4o-custom': {
      id: 'lab-zzz/gpt-4o-custom',
      modalities: { input: ['text'], output: ['text'] },
      toolCall: false,
      reasoning: false
    },
    'lab-zzz/my-thinking-fork': {
      id: 'lab-zzz/my-thinking-fork',
      modalities: { input: ['text'], output: ['text'] },
      reasoning: false,
      toolCall: false
    },
    'lab-zzz/claude-xyz-custom': {
      id: 'lab-zzz/claude-xyz-custom',
      modalities: { input: ['text'], output: ['text'] },
      toolCall: false
    }
  },
  providers: {}
}

const makeModel = (id: string, provider = 'my-proxy', capabilities?: Model['capabilities']): Model =>
  ({ id, name: id, provider, group: provider, ...(capabilities ? { capabilities } : {}) }) as Model

beforeEach(() => {
  vi.clearAllMocks()
  // Capability facts never consult the provider resolver, but request-lane
  // code does: register an exact-match fake for realism.
  setMetadataProviderResolver((model) => (model?.provider === 'my-proxy' ? proxyProvider : null))
  setModelMetadataSnapshotForTests(SNAPSHOT)
})

describe('canonical identity: the same proxy id reports the same capability on every connection', () => {
  it('resolves identically no matter which proxy serves the id', () => {
    const viaProxy = makeModel('zzz-custom-1', 'my-proxy')
    const viaOther = makeModel('zzz-custom-1', 'other-proxy')
    expect(isVisionModel(viaProxy)).toBe(true)
    expect(isVisionModel(viaOther)).toBe(true)
    expect(isFunctionCallingModel(viaProxy)).toBe(true)
    expect(isFunctionCallingModel(viaOther)).toBe(true)
    expect(isReasoningModel(viaProxy)).toBe(true)
    expect(isReasoningModel(viaOther)).toBe(true)
    // The provider argument never participates in resolution.
    expect(getExternalModelEntry(viaProxy, proxyProvider)).toEqual(getExternalModelEntry(viaOther, otherProxyProvider))
  })

  it('returns the canonical id for bare, qualified, and case-variant queries', () => {
    expect(getExternalModelEntry(makeModel('zzz-custom-1'))?.id).toBe('lab-zzz/zzz-custom-1')
    expect(getExternalModelEntry(makeModel('lab-zzz/zzz-custom-1'))?.id).toBe('lab-zzz/zzz-custom-1')
    expect(getExternalModelEntry(makeModel('proxy-lab/zzz-custom-1'))?.id).toBe('lab-zzz/zzz-custom-1')
  })
})

describe('priority: user override -> canonical metadata -> legacy heuristic', () => {
  it('prefers validated canonical metadata over the legacy name heuristic', () => {
    // zzz-custom-1 matches no legacy vision/tool/reasoning pattern, but the
    // canonical registry knows it.
    expect(isVisionModel(makeModel('zzz-custom-1'))).toBe(true)
    expect(isFunctionCallingModel(makeModel('zzz-custom-1'))).toBe(true)
    expect(isReasoningModel(makeModel('zzz-custom-1'))).toBe(true)
  })

  it('lets canonical false overrule a legacy true', () => {
    // gpt-4o-custom matches legacy vision; my-thinking-fork matches legacy
    // reasoning ("thinking"); claude-xyz-custom matches legacy tool calling.
    expect(isVisionModel(makeModel('gpt-4o-custom'))).toBe(false)
    expect(isReasoningModel(makeModel('my-thinking-fork'))).toBe(false)
    expect(isFunctionCallingModel(makeModel('claude-xyz-custom'))).toBe(false)
  })

  it('keeps explicit user overrides at highest priority', () => {
    const visionOff = makeModel('zzz-custom-1', 'my-proxy', [{ type: 'vision', isUserSelected: false }])
    expect(isVisionModel(visionOff)).toBe(false)
    const visionOn = makeModel('gpt-4o-custom', 'my-proxy', [{ type: 'vision', isUserSelected: true }])
    expect(isVisionModel(visionOn)).toBe(true)

    const toolOff = makeModel('zzz-custom-1', 'my-proxy', [{ type: 'function_calling', isUserSelected: false }])
    expect(isFunctionCallingModel(toolOff)).toBe(false)

    const reasoningOn = makeModel('my-thinking-fork', 'my-proxy', [{ type: 'reasoning', isUserSelected: true }])
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

describe('canonical metadata is connection-independent (no silent provider fallback)', () => {
  it('resolves for orphaned provider ids exactly like configured ones', () => {
    setMetadataProviderResolver(() => null)
    const orphan = makeModel('zzz-custom-1', 'deleted-provider')
    expect(resolveExternalVisionSupport(orphan)).toBe(true)
    expect(resolveExternalToolCallSupport(orphan)).toBe(true)
    expect(getExternalModelContext(orphan)?.contextLimit).toBe(500000)
  })

  it('ignores sloppy resolver results: identity is the model id alone', () => {
    // Even a resolver substituting another provider cannot change the facts.
    setMetadataProviderResolver(() => ({ ...proxyProvider, id: 'default-other' }) as Provider)
    const orphan = makeModel('zzz-custom-1', 'deleted-provider')
    expect(resolveExternalVisionSupport(orphan)).toBe(true)
    expect(getExternalModelContext(orphan)?.contextLimit).toBe(500000)
  })
})

describe('canonical models.json carries no pricing or reasoning options', () => {
  it('exposes no pricing or reasoning-option getters as canonical facts', async () => {
    const metadata = await import('../modelMetadata')
    expect('getExternalModelPricing' in metadata).toBe(false)
    expect('getExternalReasoningEffortOptions' in metadata).toBe(false)
    expect('getExternalReasoningControls' in metadata).toBe(false)
  })
})

describe('context enrichment only', () => {
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
    ['null models', { source: 'models.dev', fetchedAt: 1, models: null, providers: {} }],
    ['null providers', { source: 'models.dev', fetchedAt: 1, models: {}, providers: null }],
    ['string models', { source: 'models.dev', fetchedAt: 1, models: 'nope', providers: {} }]
  ])('falls back to legacy behavior for %s', (_label, shape) => {
    setModelMetadataSnapshotForTests(shape as never)
    expect(() => isVisionModel(makeModel('zzz-custom-1'))).not.toThrow()
    expect(() => isFunctionCallingModel(makeModel('zzz-custom-1'))).not.toThrow()
    expect(() => isReasoningModel(makeModel('zzz-custom-1'))).not.toThrow()
    // legacy answers unchanged: unknown ids stay permissive
    expect(isVisionModel(makeModel('zzz-custom-1'))).toBe(false)
    expect(isReasoningModel(makeModel('my-thinking-fork'))).toBe(true)
    setModelMetadataSnapshotForTests(SNAPSHOT)
  })
})

describe('unknown/no-snapshot permissive request path', () => {
  it('still resolves unknown model ids to their owning provider (never gated)', () => {
    setModelMetadataSnapshotForTests(null)
    const providers = [proxyProvider]
    const resolved = resolveCustomProviderForModel(makeModel('never-seen-custom-id', 'my-proxy'), providers)
    expect(resolved.id).toBe('my-proxy')
    // ...while capability predicates degrade to legacy behavior, not rejection
    expect(isVisionModel(makeModel('never-seen-custom-id'))).toBe(false)
    expect(isReasoningModel(makeModel('never-seen-custom-id'))).toBe(false)
  })
})
