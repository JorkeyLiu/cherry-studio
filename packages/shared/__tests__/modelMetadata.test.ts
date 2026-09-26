import { describe, expect, it } from 'vitest'

import {
  asSafeMetadataFailureReason,
  DEFAULT_NORMALIZATION_LIMITS,
  getCanonicalLabs,
  getCanonicalModelIndex,
  isSafeMetadataKey,
  type ModelMetadataSnapshot,
  normalizeCanonicalModelsPayload,
  normalizeProviderSourcesPayload,
  parseModelMetadataCache,
  parseModelMetadataSnapshot,
  parseModelMetadataStatus,
  resolveCanonicalModel,
  resolveProviderServingModel,
  resolveReferenceServingModel,
  toModelMetadataStatus
} from '../modelMetadata'

const RAW_CANONICAL_FIXTURE = {
  'deepseek/deepseek-v4.1-flash': {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    family: 'deepseek-flash',
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2026-09-10',
    last_updated: '2026-09-10',
    modalities: { input: ['text', 'image', 'PDF'], output: ['text'] },
    limit: { context: 1000000, output: 384000 }
  },
  'moonshotai/kimi-k3': {
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3',
    family: 'kimi-k3',
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: false,
    release_date: '2026-07-16',
    last_updated: '2026-07-16',
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 1048576, output: 131072 }
  },
  'alibaba/qwen3.5-plus': {
    id: 'alibaba/qwen3.5-plus',
    name: 'Qwen3.5 Plus',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 65536 }
  },
  'openai/gpt-5.6-sol': {
    id: 'openai/gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: false,
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    limit: { context: 1050000, input: 922000, output: 128000 }
  },
  'legacy-no-flags': {
    id: 'legacy-no-flags',
    name: 'Legacy'
    // absent optional capability booleans must stay unknown, not false
  },
  'string-bool': {
    id: 'string-bool',
    attachment: 'yes',
    tool_call: 1,
    reasoning: 'true',
    modalities: { input: 'image' },
    cost: { input: 'cheap' },
    reasoning_options: [{ type: 'effort', values: ['low'] }]
  }
}

const RAW_PROVIDER_SOURCES_FIXTURE = {
  anthropic: { id: 'anthropic', name: 'Anthropic' },
  openai: { id: 'openai', name: 'OpenAI', api: 'https://api.openai.com/v1' },
  'party-a': {
    id: 'party-a',
    name: 'Party A',
    api: 'https://api.party-a.example/v1',
    models: { anything: { id: 'anything' } }
  },
  broken: 'not-a-provider'
}

function makeSnapshot(models: Record<string, never> | Record<string, object> = {}): ModelMetadataSnapshot {
  return {
    source: 'models.dev',
    fetchedAt: 999,
    models: models as unknown as ModelMetadataSnapshot['models'],
    providers: {}
  }
}

describe('normalizeCanonicalModelsPayload', () => {
  it('normalizes the flat canonical map, keeping exact canonical ids', () => {
    const models = normalizeCanonicalModelsPayload(RAW_CANONICAL_FIXTURE)
    expect(models).not.toBeNull()
    expect(Object.keys(models!).sort()).toEqual([
      'alibaba/qwen3.5-plus',
      'deepseek/deepseek-v4.1-flash',
      'legacy-no-flags',
      'moonshotai/kimi-k3',
      'openai/gpt-5.6-sol',
      'string-bool'
    ])
  })

  it('keeps validated booleans and leaves absent fields unknown (not false)', () => {
    const models = normalizeCanonicalModelsPayload(RAW_CANONICAL_FIXTURE)!
    const known = models['deepseek/deepseek-v4.1-flash']
    expect(known.attachment).toBe(true)
    expect(known.toolCall).toBe(true)
    expect(known.reasoning).toBe(true)
    expect(known.temperature).toBe(true)
    expect(known.structuredOutput).toBe(true)

    const legacy = models['legacy-no-flags']
    expect(legacy.attachment).toBeUndefined()
    expect(legacy.toolCall).toBeUndefined()
    expect(legacy.reasoning).toBeUndefined()
    expect(legacy.temperature).toBeUndefined()
    expect(legacy.modalities).toEqual({ input: [], output: [] })
    expect(legacy.limits).toBeUndefined()
  })

  it('does not coerce non-boolean capability values and never fills proxy-only facts', () => {
    const models = normalizeCanonicalModelsPayload(RAW_CANONICAL_FIXTURE)!
    const coerced = models['string-bool']
    expect(coerced.attachment).toBeUndefined()
    expect(coerced.toolCall).toBeUndefined()
    expect(coerced.reasoning).toBeUndefined()
    expect(coerced.modalities).toEqual({ input: [], output: [] })
    // models.json publishes no pricing or reasoning options: the normalized
    // shape carries neither, even when proxy-shaped fields are present.
    expect('pricing' in coerced).toBe(false)
    expect('reasoningControls' in coerced).toBe(false)
    expect('pricing' in models['deepseek/deepseek-v4.1-flash']).toBe(false)
    expect('reasoningControls' in models['deepseek/deepseek-v4.1-flash']).toBe(false)
  })

  it('normalizes modalities to lowercase and preserves limits', () => {
    const models = normalizeCanonicalModelsPayload(RAW_CANONICAL_FIXTURE)!
    const known = models['deepseek/deepseek-v4.1-flash']
    expect(known.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] })
    expect(known.limits).toEqual({ context: 1000000, output: 384000 })
    expect(known.family).toBe('deepseek-flash')
    expect(known.knowledgeCutoff).toBe('2025-05')
    expect(models['openai/gpt-5.6-sol'].limits).toEqual({ context: 1050000, input: 922000, output: 128000 })
  })

  it('returns null when the top level is not a model record or has no usable model', () => {
    expect(normalizeCanonicalModelsPayload(null)).toBeNull()
    expect(normalizeCanonicalModelsPayload([])).toBeNull()
    expect(normalizeCanonicalModelsPayload('nope')).toBeNull()
    expect(normalizeCanonicalModelsPayload({ broken: 42 })).toBeNull()
  })
})

describe('normalizeProviderSourcesPayload', () => {
  it('keeps api + name per source and keeps serving effort only when present', () => {
    const providers = normalizeProviderSourcesPayload(RAW_PROVIDER_SOURCES_FIXTURE)!
    expect(Object.keys(providers).sort()).toEqual(['anthropic', 'openai', 'party-a'])
    expect(providers['anthropic']).toEqual({ api: '', name: 'Anthropic' })
    expect(providers['openai']).toEqual({ api: 'https://api.openai.com/v1', name: 'OpenAI' })
    expect(providers['party-a']).toEqual({ api: 'https://api.party-a.example/v1', name: 'Party A' })
    for (const entry of Object.values(providers)) {
      expect('models' in entry).toBe(false)
    }
  })

  it('keeps provider-specific serving effort (max -> xhigh) and never merges into canonical', () => {
    const raw = {
      'provider-a': {
        id: 'provider-a',
        name: 'Provider A',
        api: 'https://api.a.example/v1',
        models: {
          'model-x': {
            id: 'model-x',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }]
          },
          'model-y': {
            id: 'model-y',
            reasoning_options: [{ type: 'effort', values: ['low', 'MAX', 'low'] }]
          },
          'model-no-effort': {
            id: 'model-no-effort',
            reasoning_options: [{ type: 'toggle' }]
          },
          'model-bad': {
            id: 'model-bad',
            reasoning_options: [{ type: 'effort', values: [''] }]
          }
        }
      },
      'provider-b': {
        id: 'provider-b',
        name: 'Provider B',
        api: 'https://api.b.example/v1',
        models: {
          'model-x': {
            id: 'model-x',
            reasoning_options: [{ type: 'effort', values: ['minimal', 'medium'] }]
          }
        }
      }
    }
    const providers = normalizeProviderSourcesPayload(raw)!
    expect(providers['provider-a'].models?.['model-x']?.effort).toEqual(['low', 'high', 'xhigh'])
    expect(providers['provider-a'].models?.['model-y']?.effort).toEqual(['low', 'xhigh'])
    expect(providers['provider-a'].models?.['model-no-effort']).toBeUndefined()
    expect(providers['provider-a'].models?.['model-bad']).toBeUndefined()
    expect(providers['provider-b'].models?.['model-x']?.effort).toEqual(['minimal', 'medium'])
    // canonical models remain untouched (not in this payload)
    expect(Object.keys(providers).sort()).toEqual(['provider-a', 'provider-b'])
  })

  it('returns null for a non-record top level and an empty record otherwise', () => {
    expect(normalizeProviderSourcesPayload(null)).toBeNull()
    expect(normalizeProviderSourcesPayload([])).toBeNull()
    expect(normalizeProviderSourcesPayload({})).toEqual({})
  })
})

describe('parseModelMetadataSnapshot / parseModelMetadataCache', () => {
  function fullSnapshot(): ModelMetadataSnapshot {
    return {
      source: 'models.dev',
      fetchedAt: 999,
      etag: '"abc"',
      models: normalizeCanonicalModelsPayload(RAW_CANONICAL_FIXTURE)!,
      providers: normalizeProviderSourcesPayload(RAW_PROVIDER_SOURCES_FIXTURE)!
    }
  }

  it('round-trips a canonical snapshot through the defensive snapshot schema', () => {
    const snapshot = fullSnapshot()
    expect(parseModelMetadataSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })

  it('rejects snapshots with wrong source or missing canonical maps', () => {
    expect(parseModelMetadataSnapshot(null)).toBeNull()
    expect(parseModelMetadataSnapshot({ source: 'other', fetchedAt: 1, models: {}, providers: {} })).toBeNull()
    expect(parseModelMetadataSnapshot({ source: 'models.dev', fetchedAt: 1 })).toBeNull()
    expect(parseModelMetadataSnapshot({ source: 'models.dev', fetchedAt: 1, models: {} })).toBeNull()
  })

  it('parses the versioned v4 cache envelope and falls back to a bare snapshot', () => {
    const snapshot = fullSnapshot()
    const envelope = { version: 4, fetchedAt: 999, etag: '"abc"', snapshot }
    expect(parseModelMetadataCache(envelope)).toEqual({ snapshot, etag: '"abc"' })
    expect(parseModelMetadataCache(snapshot)).toEqual({ snapshot, etag: '"abc"' })
    expect(parseModelMetadataCache({ version: 4 })).toBeNull()
    expect(parseModelMetadataCache(null)).toBeNull()
  })

  it('requires the literal current cache version (rejects v1/v2/v3 caches)', () => {
    const snapshot = fullSnapshot()
    expect(parseModelMetadataCache({ version: 1, fetchedAt: 999, snapshot })).toBeNull()
    expect(parseModelMetadataCache({ version: 2, fetchedAt: 999, snapshot })).toBeNull()
    expect(parseModelMetadataCache({ version: 3, fetchedAt: 999, snapshot })).toBeNull()
    expect(parseModelMetadataCache({ version: 4, fetchedAt: 999, snapshot })).not.toBeNull()
    expect(parseModelMetadataCache({ version: '4', fetchedAt: 999, snapshot })).toBeNull()
    // A v1-shaped provider-mapped payload is not a v3 snapshot.
    expect(
      parseModelMetadataCache({
        source: 'models.dev',
        fetchedAt: 1,
        providers: { anthropic: { api: '', name: 'A', models: {} } }
      })
    ).toBeNull()
  })
})

describe('prototype-key safety', () => {
  it('rejects unsafe dictionary keys', () => {
    expect(isSafeMetadataKey('__proto__')).toBe(false)
    expect(isSafeMetadataKey('constructor')).toBe(false)
    expect(isSafeMetadataKey('prototype')).toBe(false)
    expect(isSafeMetadataKey('anthropic')).toBe(true)
  })

  it('skips unsafe canonical keys without polluting the dictionaries', () => {
    const raw = {
      'lab/ok': { id: 'lab/ok', reasoning: true },
      __proto__: { id: 'evil', reasoning: true },
      constructor: { id: 'evil', reasoning: true }
    }
    const models = normalizeCanonicalModelsPayload(raw)!
    expect(Object.keys(models)).toEqual(['lab/ok'])
    expect(Object.prototype.hasOwnProperty.call(models, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(models)).toBe(Object.prototype)
  })
})

describe('normalization bounds', () => {
  const tiny = {
    ...DEFAULT_NORMALIZATION_LIMITS,
    maxProviders: 2,
    maxTotalModels: 3,
    maxKeyLength: 12,
    maxStringLength: 8,
    maxModalities: 2
  }

  it('rejects canonical payloads exceeding the total-model count', () => {
    const many = {
      'a/m1': { id: 'a/m1' },
      'a/m2': { id: 'a/m2' },
      'b/m3': { id: 'b/m3' },
      'b/m4': { id: 'b/m4' }
    }
    expect(normalizeCanonicalModelsPayload(many, tiny)).toBeNull()
  })

  it('skips over-long keys and truncates modalities', () => {
    const raw = {
      'toolonglab/toolongmodelname': { id: 'x' },
      'lab/m1': {
        id: 'lab/m1',
        name: 'way-too-long-name',
        modalities: { input: ['text', 'image', 'video', 'audio'], output: ['text'] }
      }
    }
    const models = normalizeCanonicalModelsPayload(raw, tiny)!
    expect(Object.keys(models)).toEqual(['lab/m1'])
    expect(models['lab/m1'].name).toBeUndefined()
    expect(models['lab/m1'].modalities.input).toEqual(['text', 'image'])
  })

  it('rejects provider lists exceeding the provider count', () => {
    const three = { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } }
    expect(normalizeProviderSourcesPayload(three, tiny)).toBeNull()
  })

  it('keeps default bounds far above live canonical data (~408 models)', () => {
    expect(DEFAULT_NORMALIZATION_LIMITS.maxTotalModels).toBeGreaterThanOrEqual(816)
  })
})

describe('resolveCanonicalModel — matching contract', () => {
  function contractSnapshot(): ModelMetadataSnapshot {
    return {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'deepseek/deepseek-v4.1-flash': { id: 'deepseek/deepseek-v4.1-flash', modalities: { input: [], output: [] } },
        'moonshotai/kimi-k3': { id: 'moonshotai/kimi-k3', modalities: { input: [], output: [] } },
        'alibaba/qwen3.5-plus': { id: 'alibaba/qwen3.5-plus', modalities: { input: [], output: [] } },
        'openai/gpt-5.6-sol': { id: 'openai/gpt-5.6-sol', modalities: { input: [], output: [] } },
        'lab-a/shared-name': { id: 'lab-a/shared-name', modalities: { input: [], output: [] } },
        'lab-b/shared-name': { id: 'lab-b/shared-name', modalities: { input: [], output: [] } },
        'lab-c/Model-X': { id: 'lab-c/Model-X', modalities: { input: [], output: [] } },
        'lab-d/model-x': { id: 'lab-d/model-x', modalities: { input: [], output: [] } },
        'deepseek/deepseek-thinker': { id: 'deepseek/deepseek-thinker', modalities: { input: [], output: [] } }
      },
      providers: {}
    }
  }

  it('Tier 1: exact case-sensitive full canonical id match', () => {
    const snapshot = contractSnapshot()
    expect(resolveCanonicalModel('moonshotai/kimi-k3', snapshot)?.canonicalId).toBe('moonshotai/kimi-k3')
    expect(resolveCanonicalModel('  moonshotai/kimi-k3  ', snapshot)?.canonicalId).toBe('moonshotai/kimi-k3')
    // Case differs: not Tier 1, but the unique case-fold still resolves at Tier 3.
    expect(resolveCanonicalModel('Moonshotai/Kimi-K3', snapshot)?.canonicalId).toBe('moonshotai/kimi-k3')
  })

  it('Tier 2: exact unique basename (bare ids and proxy-qualified aliases)', () => {
    const snapshot = contractSnapshot()
    expect(resolveCanonicalModel('deepseek-v4.1-flash', snapshot)?.canonicalId).toBe('deepseek/deepseek-v4.1-flash')
    expect(resolveCanonicalModel('kimi-k3', snapshot)?.canonicalId).toBe('moonshotai/kimi-k3')
    // Proxy-qualified alias: Tier 1 misses, Tier 2 basename resolves canonically.
    expect(resolveCanonicalModel('alibaba/kimi-k3', snapshot)?.canonicalId).toBe('moonshotai/kimi-k3')
    expect(resolveCanonicalModel('azure/gpt-5.6-sol', snapshot)?.canonicalId).toBe('openai/gpt-5.6-sol')
    expect(resolveCanonicalModel('gpt-5.6-sol', snapshot)?.canonicalId).toBe('openai/gpt-5.6-sol')
  })

  it('Tier 3: unique case-folded full id or basename', () => {
    const snapshot = contractSnapshot()
    // Case-variant proxy-qualified alias resolves through the folded basename.
    expect(resolveCanonicalModel('Qwen/Qwen3.5-Plus', snapshot)?.canonicalId).toBe('alibaba/qwen3.5-plus')
    expect(resolveCanonicalModel('QWEN3.5-PLUS', snapshot)?.canonicalId).toBe('alibaba/qwen3.5-plus')
  })

  it('rejects basename collisions (unknown, never first candidate)', () => {
    const snapshot = contractSnapshot()
    expect(resolveCanonicalModel('shared-name', snapshot)).toBeUndefined()
    expect(resolveCanonicalModel('lab-a/shared-name', snapshot)?.canonicalId).toBe('lab-a/shared-name')
    expect(resolveCanonicalModel('lab-b/shared-name', snapshot)?.canonicalId).toBe('lab-b/shared-name')
  })

  it('rejects case-fold collisions (unknown)', () => {
    const snapshot = contractSnapshot()
    // Folded 'model-x' identifies two canonical models: ambiguous -> unknown.
    expect(resolveCanonicalModel('MODEL-X', snapshot)).toBeUndefined()
    // Exact case-sensitive basename still resolves at Tier 2 when unique.
    expect(resolveCanonicalModel('model-x', snapshot)?.canonicalId).toBe('lab-d/model-x')
    // Exact full ids still resolve through Tier 1.
    expect(resolveCanonicalModel('lab-c/Model-X', snapshot)?.canonicalId).toBe('lab-c/Model-X')
    expect(resolveCanonicalModel('lab-d/model-x', snapshot)?.canonicalId).toBe('lab-d/model-x')
  })

  it('never strips route suffixes such as :thinking', () => {
    const snapshot = contractSnapshot()
    expect(resolveCanonicalModel('deepseek-thinker:thinking', snapshot)).toBeUndefined()
    expect(resolveCanonicalModel('deepseek/deepseek-thinker:thinking', snapshot)).toBeUndefined()
    expect(resolveCanonicalModel('deepseek-thinker', snapshot)?.canonicalId).toBe('deepseek/deepseek-thinker')
  })

  it('rejects empty and unsafe malformed queries', () => {
    const snapshot = contractSnapshot()
    expect(resolveCanonicalModel('', snapshot)).toBeUndefined()
    expect(resolveCanonicalModel('   ', snapshot)).toBeUndefined()
    expect(resolveCanonicalModel(undefined, snapshot)).toBeUndefined()
    expect(resolveCanonicalModel(null, snapshot)).toBeUndefined()
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(resolveCanonicalModel(key, snapshot)).toBeUndefined()
    }
    expect(resolveCanonicalModel('kimi-k3', null)).toBeUndefined()
    expect(resolveCanonicalModel('kimi-k3', makeSnapshot())).toBeUndefined()
  })

  it('returns the canonical entry, id, and lab for logo attribution', () => {
    const snapshot = contractSnapshot()
    const resolved = resolveCanonicalModel('alibaba/kimi-k3', snapshot)!
    expect(resolved.canonicalId).toBe('moonshotai/kimi-k3')
    expect(resolved.lab).toBe('moonshotai')
    expect(resolved.entry.id).toBe('moonshotai/kimi-k3')
  })

  it('builds indexes once per snapshot instead of scanning per render', () => {
    const snapshot = contractSnapshot()
    expect(getCanonicalModelIndex(snapshot)).toBe(getCanonicalModelIndex(snapshot))
    expect(getCanonicalModelIndex(null)).toBeNull()
  })

  it('derives distinct safe canonical labs for the logo admission gate', () => {
    expect(getCanonicalLabs(contractSnapshot()).sort()).toEqual([
      'alibaba',
      'deepseek',
      'lab-a',
      'lab-b',
      'lab-c',
      'lab-d',
      'moonshotai',
      'openai'
    ])
    expect(getCanonicalLabs(null)).toEqual([])
  })
})

describe('toModelMetadataStatus — loading/ready/unavailable state machine', () => {
  const SNAPSHOT = {
    source: 'models.dev',
    fetchedAt: 1,
    models: {},
    providers: {}
  } as unknown as ModelMetadataSnapshot

  it('is loading when there is no snapshot and a round is in flight', () => {
    expect(toModelMetadataStatus({ snapshot: null, inFlight: true })).toEqual({ kind: 'loading', snapshot: null })
    expect(toModelMetadataStatus({ snapshot: null, inFlight: true, failureReason: 'network-error' })).toEqual({
      kind: 'loading',
      snapshot: null
    })
  })

  it('is ready whenever a snapshot exists, even after a refresh failure', () => {
    expect(toModelMetadataStatus({ snapshot: SNAPSHOT, inFlight: false })).toEqual({
      kind: 'ready',
      snapshot: SNAPSHOT
    })
    expect(toModelMetadataStatus({ snapshot: SNAPSHOT, inFlight: false, failureReason: 'timeout' })).toEqual({
      kind: 'ready',
      snapshot: SNAPSHOT
    })
  })

  it('is unavailable only for a completed failure with a sanitized reason', () => {
    expect(toModelMetadataStatus({ snapshot: null, inFlight: false, failureReason: 'network-error' })).toEqual({
      kind: 'unavailable',
      snapshot: null,
      reason: 'network-error'
    })
    // non-terminal states without a failure stay loading, never unavailable
    expect(toModelMetadataStatus({ snapshot: null, inFlight: false })).toEqual({ kind: 'loading', snapshot: null })
    // unsafe reasons never leak into the status
    expect(toModelMetadataStatus({ snapshot: null, inFlight: false, failureReason: 'fresh-cache' })).toEqual({
      kind: 'loading',
      snapshot: null
    })
    expect(
      toModelMetadataStatus({ snapshot: null, inFlight: false, failureReason: 'ENOENT /secret/path' as never })
    ).toEqual({ kind: 'loading', snapshot: null })
  })
})

describe('asSafeMetadataFailureReason / parseModelMetadataStatus', () => {
  it('keeps only sanitized fetch/read failure reasons', () => {
    expect(asSafeMetadataFailureReason('timeout')).toBe('timeout')
    expect(asSafeMetadataFailureReason('not-modified')).toBeUndefined()
    expect(asSafeMetadataFailureReason('fresh-cache')).toBeUndefined()
    expect(asSafeMetadataFailureReason('ENOENT /cache/x')).toBeUndefined()
    expect(asSafeMetadataFailureReason(undefined)).toBeUndefined()
  })

  it('parses well-shaped statuses and rejects mismatches', () => {
    const snapshot = { source: 'models.dev', fetchedAt: 1, models: {}, providers: {} }
    expect(parseModelMetadataStatus({ kind: 'loading', snapshot: null })).toEqual({ kind: 'loading', snapshot: null })
    expect(parseModelMetadataStatus({ kind: 'ready', snapshot })).toEqual({ kind: 'ready', snapshot })
    expect(parseModelMetadataStatus({ kind: 'unavailable', snapshot: null, reason: 'http-error' })).toEqual({
      kind: 'unavailable',
      snapshot: null,
      reason: 'http-error'
    })
    expect(parseModelMetadataStatus({ kind: 'ready', snapshot: null })).toBeNull()
    expect(parseModelMetadataStatus({ kind: 'unavailable', snapshot: null })).toBeNull()
    expect(parseModelMetadataStatus({ kind: 'unavailable', snapshot: null, reason: 'evil' })).toBeNull()
    expect(parseModelMetadataStatus({ kind: 'nope', snapshot: null })).toBeNull()
    expect(parseModelMetadataStatus(null)).toBeNull()
  })
})

describe('provider serving full metadata — normalization + exact resolver', () => {
  it('keeps stable display fields from api.json serving records (no unbounded any)', () => {
    const raw = {
      'provider-a': {
        id: 'provider-a',
        name: 'Provider A',
        api: 'https://api.a.example/v1',
        models: {
          'model-x': {
            id: 'model-x',
            name: 'Model X',
            description: 'A test model',
            family: 'test-family',
            knowledge: '2025-01',
            release_date: '2026-01-01',
            last_updated: '2026-09-01',
            modalities: { input: ['text', 'image'], output: ['text'] },
            attachment: true,
            tool_call: true,
            structured_output: false,
            temperature: true,
            reasoning: true,
            limit: { context: 128000, output: 4096 },
            cost: { input: 0.5, output: 1.5 },
            reasoning_options: [{ type: 'effort', values: ['low', 'max'] }]
          },
          'model-y': {
            id: 'model-y',
            name: 'Model Y',
            modalities: { input: ['TEXT'], output: ['TEXT'] },
            cost: { input: 'cheap' }
          },
          'empty-model': { id: 'empty-model' }
        }
      }
    }
    const providers = normalizeProviderSourcesPayload(raw)!
    const x = providers['provider-a'].models?.['model-x']
    expect(x?.id).toBe('model-x')
    expect(x?.name).toBe('Model X')
    expect(x?.description).toBe('A test model')
    expect(x?.family).toBe('test-family')
    expect(x?.knowledgeCutoff).toBe('2025-01')
    expect(x?.releaseDate).toBe('2026-01-01')
    expect(x?.lastUpdated).toBe('2026-09-01')
    expect(x?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] })
    expect(x?.attachment).toBe(true)
    expect(x?.toolCall).toBe(true)
    expect(x?.structuredOutput).toBe(false)
    expect(x?.temperature).toBe(true)
    expect(x?.reasoning).toBe(true)
    expect(x?.limits).toEqual({ context: 128000, output: 4096 })
    expect(x?.cost).toEqual({ input: 0.5, output: 1.5 })
    expect(x?.effort).toEqual(['low', 'xhigh'])
    const y = providers['provider-a'].models?.['model-y']
    expect(y?.modalities).toEqual({ input: ['text'], output: ['text'] })
    expect(y?.cost).toBeUndefined()
    // isolated id-only record is not a useful serving entry and is dropped
    expect(providers['provider-a'].models?.['empty-model']).toBeUndefined()
    // non-boolean cost stays unknown, not coerced
    expect('pricing' in (x as any)).toBe(false)
  })

  it('resolveProviderServingModel is exact, trimmed, case-sensitive, never canonical-merge', () => {
    const snapshot: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: {},
      providers: normalizeProviderSourcesPayload({
        'provider-a': {
          id: 'provider-a',
          name: 'Provider A',
          api: 'https://api.a.example/v1',
          models: {
            'deepseek/deepseek-v3': { id: 'deepseek/deepseek-v3', name: 'DeepSeek V3', limit: { context: 128000 } },
            'Model-Case': { id: 'Model-Case', name: 'Case' }
          }
        }
      })!
    }
    expect(resolveProviderServingModel('provider-a', 'deepseek/deepseek-v3', snapshot)?.name).toBe('DeepSeek V3')
    expect(resolveProviderServingModel('provider-a', '  deepseek/deepseek-v3  ', snapshot)?.name).toBe('DeepSeek V3')
    expect(resolveProviderServingModel('provider-a', 'DEEPSEEK/DEEPSEEK-V3', snapshot)).toBeUndefined()
    expect(resolveProviderServingModel('provider-a', 'deepseek-v3', snapshot)).toBeUndefined()
    expect(resolveProviderServingModel('provider-a', 'Model-Case', snapshot)?.name).toBe('Case')
    expect(resolveProviderServingModel('provider-a', 'model-case', snapshot)).toBeUndefined()
    expect(resolveProviderServingModel('provider-a', '__proto__', snapshot)).toBeUndefined()
    expect(resolveProviderServingModel('provider-a', 'deepseek/deepseek-v3', null)).toBeUndefined()
    // different provider -> undefined
    expect(resolveProviderServingModel('provider-b', 'deepseek/deepseek-v3', snapshot)).toBeUndefined()
  })

  it('parseModelMetadataSnapshot keeps serving fields and is separate from canonical', () => {
    const snapshot: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 999,
      models: {
        'lab-a/model-x': {
          id: 'lab-a/model-x',
          modalities: { input: ['text'], output: ['text'] },
          limits: { context: 10 }
        }
      },
      providers: {
        'provider-a': {
          api: 'https://api.a.example/v1',
          name: 'Provider A',
          models: {
            'model-x': { name: 'Model X', limits: { context: 999999 }, effort: ['low'] } as any
          }
        }
      }
    }
    const parsed = parseModelMetadataSnapshot(JSON.parse(JSON.stringify(snapshot)))!
    expect(parsed.providers['provider-a'].models?.['model-x']?.limits?.context).toBe(999999)
    expect(parsed.models['lab-a/model-x'].limits?.context).toBe(10)
    // serving never overwrote canonical
    expect(parsed.models['lab-a/model-x'].limits?.context).not.toBe(999999)
  })
})

describe('resolveReferenceServingModel — model-centric reference (canonical lab only)', () => {
  function referenceSnapshot(): ModelMetadataSnapshot {
    return {
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'deepseek/deepseek-v4.1-flash': {
          id: 'deepseek/deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash',
          modalities: { input: ['text'], output: ['text'] }
        },
        'moonshotai/kimi-k3': {
          id: 'moonshotai/kimi-k3',
          name: 'Kimi K3',
          modalities: { input: ['text'], output: ['text'] }
        },
        'lab-a/case-model': {
          id: 'lab-a/case-model',
          name: 'Case Model',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: {
        deepseek: {
          api: 'https://api.deepseek.example/v1',
          name: 'DeepSeek',
          models: {
            'deepseek/deepseek-v4.1-flash': {
              id: 'deepseek/deepseek-v4.1-flash',
              name: 'DeepSeek V4.1 Flash',
              cost: { input: 1, output: 2 }
            },
            'deepseek-flash': { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', cost: { input: 3 } }
          }
        },
        moonshotai: {
          api: 'https://api.moonshot.example/v1',
          name: 'Moonshot',
          models: {
            'kimi-k3': { id: 'kimi-k3', name: 'Kimi K3', cost: { input: 5 } }
          }
        },
        'lab-a': {
          api: 'https://api.a.example/v1',
          name: 'Lab A',
          models: {
            'alias-one': { id: 'alias-one', name: 'Case Model' },
            'alias-two': { id: 'alias-two', name: 'Case Model' }
          }
        }
      }
    }
  }

  it('resolves the exact canonical full ID key inside the canonical lab', () => {
    const snapshot = referenceSnapshot()
    expect(resolveReferenceServingModel('deepseek/deepseek-v4.1-flash', snapshot, 'DeepSeek V4.1 Flash')?.cost).toEqual(
      { input: 1, output: 2 }
    )
  })

  it('resolves the exact canonical basename key when the full ID key is absent', () => {
    const snapshot = referenceSnapshot()
    expect(resolveReferenceServingModel('moonshotai/kimi-k3', snapshot, 'Kimi K3')?.cost).toEqual({ input: 5 })
  })

  it('resolves a unique exact display-name alias (DeepSeek V4.1 Flash -> deepseek-flash style)', () => {
    const snapshot: ModelMetadataSnapshot = {
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
    // Neither the full ID nor the basename exists as a serving key; the
    // unique exact display name identifies the reference entry.
    expect(resolveReferenceServingModel('deepseek/deepseek-v4.1-flash', snapshot)?.id).toBe('deepseek-flash')
  })

  it('resolves a unique case-folded display name when no exact-name candidate exists', () => {
    const snapshot: ModelMetadataSnapshot = {
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
            'folded-only': { id: 'folded-only', name: 'case model' }
          }
        }
      }
    }
    expect(resolveReferenceServingModel('lab-a/case-model', snapshot)?.id).toBe('folded-only')
  })

  it('fails closed on ambiguous display names (never first candidate)', () => {
    const snapshot = referenceSnapshot()
    // lab-a has two serving entries both named 'Case Model': exact-name is ambiguous.
    expect(resolveReferenceServingModel('lab-a/case-model', snapshot)).toBeUndefined()
  })

  it('prefers the exact basename key over a competing unique exact-name alias', () => {
    const snapshot: ModelMetadataSnapshot = {
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
            'case-model': { id: 'case-model', name: 'Unrelated', cost: { input: 1 } },
            'alias-one': { id: 'alias-one', name: 'Case Model', cost: { input: 2 } }
          }
        }
      }
    }
    // Tier (b) basename wins even though 'alias-one' is a unique exact-name
    // alias for the canonical name at tier (c).
    expect(resolveReferenceServingModel('lab-a/case-model', snapshot)?.id).toBe('case-model')
  })

  it('returns undefined on ambiguous exact names without falling through to a folded-only candidate', () => {
    const snapshot: ModelMetadataSnapshot = {
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
            'alias-one': { id: 'alias-one', name: 'Case Model' },
            'alias-two': { id: 'alias-two', name: 'Case Model' },
            'folded-only': { id: 'folded-only', name: 'case model' }
          }
        }
      }
    }
    // Two exact-name matches at tier (c) fail closed immediately. The
    // folded-only entry would look unique if exact matches were excluded
    // before tier (d), so undefined here proves no fallthrough.
    expect(resolveReferenceServingModel('lab-a/case-model', snapshot)).toBeUndefined()
  })

  it('returns undefined when the canonical lab has no provider entry', () => {
    const snapshot = referenceSnapshot()
    expect(resolveReferenceServingModel('unknown-lab/some-model', snapshot, 'Some Model')).toBeUndefined()
  })

  it('never reads the user connection: only snapshot.providers[canonicalLab] matters', () => {
    const snapshot = referenceSnapshot()
    // A serving record for the same model id under a different provider is invisible.
    const cross: ModelMetadataSnapshot = {
      ...snapshot,
      providers: {
        ...snapshot.providers,
        other: {
          api: 'https://custom.example/v1',
          name: 'Custom',
          models: {
            'deepseek/deepseek-v4.1-flash': { id: 'deepseek/deepseek-v4.1-flash', name: 'Hijack', cost: { input: 9 } }
          }
        }
      }
    }
    expect(resolveReferenceServingModel('deepseek/deepseek-v4.1-flash', cross, 'DeepSeek V4.1 Flash')?.cost).toEqual({
      input: 1,
      output: 2
    })
    // Removing the canonical-lab provider misses even though another provider has the id.
    const withoutLab: ModelMetadataSnapshot = {
      source: 'models.dev',
      fetchedAt: 1,
      models: cross.models,
      providers: {
        other: cross.providers['other']
      }
    }
    expect(
      resolveReferenceServingModel('deepseek/deepseek-v4.1-flash', withoutLab, 'DeepSeek V4.1 Flash')
    ).toBeUndefined()
  })

  it('rejects unsafe keys and malformed inputs without throwing', () => {
    const snapshot = referenceSnapshot()
    expect(resolveReferenceServingModel('__proto__', snapshot, 'x')).toBeUndefined()
    expect(resolveReferenceServingModel('', snapshot, 'x')).toBeUndefined()
    expect(resolveReferenceServingModel(undefined, snapshot, 'x')).toBeUndefined()
    expect(resolveReferenceServingModel('deepseek/deepseek-v4.1-flash', null, 'DeepSeek V4.1 Flash')).toBeUndefined()
  })
})
