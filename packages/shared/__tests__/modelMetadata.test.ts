import { describe, expect, it } from 'vitest'

import {
  asSafeMetadataFailureReason,
  DEFAULT_NORMALIZATION_LIMITS,
  isSafeMetadataKey,
  type ModelMetadataSnapshot,
  normalizeModelMetadataPayload,
  parseModelMetadataCache,
  parseModelMetadataSnapshot,
  parseModelMetadataStatus,
  toModelMetadataStatus
} from '../modelMetadata'

const RAW_FIXTURE = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        family: 'claude',
        attachment: false,
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }],
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: '2026-01-01',
        last_updated: '2026-02-01',
        modalities: { input: ['text', 'image', 'PDF'], output: ['text'] },
        limit: { context: 1000000, output: 128000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }
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
        cost: { input: 'cheap' }
      }
    }
  },
  'third-party': {
    id: 'third-party',
    name: 'Third Party',
    api: 'https://api.example.com/v1',
    models: {
      'effort-model': {
        id: 'effort-model',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }, { type: 'toggle' }],
        tool_call: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200000, output: 32000 },
        cost: { input: 1, output: 2, tiers: [{ min: 1 }] }
      },
      'empty-controls': {
        id: 'empty-controls',
        reasoning: true,
        reasoning_options: [],
        modalities: { input: ['text'], output: ['text'] }
      }
    }
  },
  broken: 'not-a-provider',
  'no-models': { id: 'no-models', name: 'No Models' }
}

describe('normalizeModelMetadataPayload', () => {
  it('normalizes providers, keeps exact model keys, and records source/fetchedAt', () => {
    const snapshot = normalizeModelMetadataPayload(RAW_FIXTURE, 123456789)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.source).toBe('models.dev')
    expect(snapshot!.fetchedAt).toBe(123456789)
    expect(Object.keys(snapshot!.providers).sort()).toEqual(['anthropic', 'third-party'])
    expect(snapshot!.providers['third-party'].api).toBe('https://api.example.com/v1')
    expect(Object.keys(snapshot!.providers['anthropic'].models).sort()).toEqual([
      'claude-sonnet-4-6',
      'legacy-no-flags',
      'string-bool'
    ])
  })

  it('keeps validated booleans and leaves absent fields unknown (not false)', () => {
    const snapshot = normalizeModelMetadataPayload(RAW_FIXTURE, 1)!
    const known = snapshot.providers['anthropic'].models['claude-sonnet-4-6']
    expect(known.attachment).toBe(false)
    expect(known.toolCall).toBe(true)
    expect(known.reasoning).toBe(true)
    expect(known.temperature).toBe(true)
    expect(known.structuredOutput).toBe(true)

    const legacy = snapshot.providers['anthropic'].models['legacy-no-flags']
    expect(legacy.attachment).toBeUndefined()
    expect(legacy.toolCall).toBeUndefined()
    expect(legacy.reasoning).toBeUndefined()
    expect(legacy.temperature).toBeUndefined()
    expect(legacy.modalities).toEqual({ input: [], output: [] })
    expect(legacy.reasoningControls).toBeUndefined()
    expect(legacy.limits).toBeUndefined()
    expect(legacy.pricing).toBeUndefined()
  })

  it('does not coerce non-boolean capability values to false', () => {
    const snapshot = normalizeModelMetadataPayload(RAW_FIXTURE, 1)!
    const coerced = snapshot.providers['anthropic'].models['string-bool']
    expect(coerced.attachment).toBeUndefined()
    expect(coerced.toolCall).toBeUndefined()
    expect(coerced.reasoning).toBeUndefined()
    // malformed modalities/cost degrade to empty/absent, never throw
    expect(coerced.modalities).toEqual({ input: [], output: [] })
    expect(coerced.pricing).toBeUndefined()
  })

  it('normalizes modalities to lowercase and preserves pricing/limits', () => {
    const snapshot = normalizeModelMetadataPayload(RAW_FIXTURE, 1)!
    const known = snapshot.providers['anthropic'].models['claude-sonnet-4-6']
    expect(known.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] })
    expect(known.limits).toEqual({ context: 1000000, output: 128000 })
    expect(known.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    expect(known.family).toBe('claude')
    expect(known.releaseDate).toBe('2026-01-01')
    expect(known.lastUpdated).toBe('2026-02-01')
  })

  it('normalizes reasoning control shapes (toggle/effort/budget, empty)', () => {
    const snapshot = normalizeModelMetadataPayload(RAW_FIXTURE, 1)!
    const claude = snapshot.providers['anthropic'].models['claude-sonnet-4-6']
    expect(claude.reasoningControls).toEqual({ toggle: true, budget: true })

    const effort = snapshot.providers['third-party'].models['effort-model']
    expect(effort.reasoningControls).toEqual({ toggle: true, effort: ['low', 'high', 'max'] })
    expect(effort.toolCall).toBe(false)
    expect(effort.pricing?.hasTiers).toBe(true)

    const empty = snapshot.providers['third-party'].models['empty-controls']
    expect(empty.reasoning).toBe(true)
    expect(empty.reasoningControls).toBeUndefined()
  })

  it('returns null when the top level is not a provider record or has no usable provider', () => {
    expect(normalizeModelMetadataPayload(null, 1)).toBeNull()
    expect(normalizeModelMetadataPayload([], 1)).toBeNull()
    expect(normalizeModelMetadataPayload('nope', 1)).toBeNull()
    // malformed entries are skipped, never fatal; a payload with no usable
    // provider is rejected rather than persisted as emptiness
    expect(normalizeModelMetadataPayload({ broken: 42 }, 1)).toBeNull()
  })
})

describe('parseModelMetadataSnapshot / parseModelMetadataCache', () => {
  it('round-trips a normalized snapshot through the defensive snapshot schema', () => {
    const snapshot = normalizeModelMetadataPayload(RAW_FIXTURE, 999)!
    expect(parseModelMetadataSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })

  it('rejects snapshots with wrong source or missing providers', () => {
    expect(parseModelMetadataSnapshot(null)).toBeNull()
    expect(parseModelMetadataSnapshot({ source: 'other', fetchedAt: 1, providers: {} })).toBeNull()
    expect(parseModelMetadataSnapshot({ source: 'models.dev', fetchedAt: 1 })).toBeNull()
  })

  it('parses the versioned cache envelope and falls back to a bare snapshot', () => {
    const snapshot = normalizeModelMetadataPayload(RAW_FIXTURE, 999)!
    const envelope = { version: 1, fetchedAt: 999, etag: '"abc"', snapshot }
    expect(parseModelMetadataCache(envelope)).toEqual({ snapshot, etag: '"abc"' })
    expect(parseModelMetadataCache(snapshot)).toEqual({ snapshot, etag: undefined })
    expect(parseModelMetadataCache({ version: 1 })).toBeNull()
    expect(parseModelMetadataCache(null)).toBeNull()
  })

  it('requires the literal current cache version', () => {
    const snapshot = normalizeModelMetadataPayload(RAW_FIXTURE, 999)!
    expect(parseModelMetadataCache({ version: 2, fetchedAt: 999, snapshot })).toBeNull()
    expect(parseModelMetadataCache({ version: 0, fetchedAt: 999, snapshot })).toBeNull()
    expect(parseModelMetadataCache({ version: '1', fetchedAt: 999, snapshot })).toBeNull()
    expect(parseModelMetadataCache({ version: 1, fetchedAt: 999, snapshot })).not.toBeNull()
  })
})

describe('prototype-key safety', () => {
  it('rejects unsafe dictionary keys', () => {
    expect(isSafeMetadataKey('__proto__')).toBe(false)
    expect(isSafeMetadataKey('constructor')).toBe(false)
    expect(isSafeMetadataKey('prototype')).toBe(false)
    expect(isSafeMetadataKey('anthropic')).toBe(true)
  })

  it('skips unsafe provider/model keys without polluting the dictionaries', () => {
    const raw = {
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          ok: { id: 'ok', reasoning: true },
          __proto__: { id: 'evil', reasoning: true },
          constructor: { id: 'evil', reasoning: true }
        }
      },
      __proto__: { id: 'evil', name: 'Evil', models: {} }
    }
    const snapshot = normalizeModelMetadataPayload(raw, 1)!
    expect(Object.keys(snapshot.providers)).toEqual(['anthropic'])
    expect(Object.keys(snapshot.providers['anthropic'].models)).toEqual(['ok'])
    // no own phantom keys and no prototype mutation through assignment
    expect(Object.prototype.hasOwnProperty.call(snapshot.providers, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(snapshot.providers)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(snapshot.providers['anthropic'].models, '__proto__')).toBe(false)
    // serialization round-trips stably with no phantom keys
    const reparsed = parseModelMetadataSnapshot(JSON.parse(JSON.stringify(snapshot)))!
    expect(Object.keys(reparsed.providers['anthropic'].models)).toEqual(['ok'])
  })
})

describe('normalization bounds', () => {
  const tiny = {
    ...DEFAULT_NORMALIZATION_LIMITS,
    maxProviders: 2,
    maxModelsPerProvider: 2,
    maxTotalModels: 3,
    maxKeyLength: 8,
    maxStringLength: 8,
    maxModalities: 2,
    maxReasoningOptions: 2,
    maxEffortValues: 2,
    maxEffortValueLength: 4
  }

  const provider = (models: Record<string, unknown>) => ({ id: 'p', name: 'P', models })

  it('rejects payloads exceeding provider or total-model counts', () => {
    const three = { a: provider({}), b: provider({}), c: provider({}) }
    expect(normalizeModelMetadataPayload(three, 1, undefined, tiny)).toBeNull()
    // each provider fits its own cap, but the total exceeds maxTotalModels
    const many = {
      a: provider({ m1: { id: 'm1' }, m2: { id: 'm2' } }),
      b: provider({ m3: { id: 'm3' }, m4: { id: 'm4' } })
    }
    expect(normalizeModelMetadataPayload(many, 1, undefined, tiny)).toBeNull()
  })

  it('truncates per-provider models and skips over-long keys/strings/lists', () => {
    const raw = {
      // key 'toolongprovider' exceeds maxKeyLength 8 -> skipped entirely
      toolongprovider: provider({ ok: { id: 'ok' } }),
      p1: provider({
        m1: {
          id: 'm1',
          name: 'way-too-long-name',
          modalities: { input: ['text', 'image', 'video', 'audio'], output: ['text'] },
          reasoning_options: [
            { type: 'toggle' },
            { type: 'effort', values: ['low', 'mid', 'high'] },
            { type: 'toggle' }
          ],
          cost: { input: 1, output: 2 }
        },
        m2: { id: 'm2' },
        m3: { id: 'm3' },
        toolongmodelkey: { id: 'toolongmodelkey' }
      })
    }
    const snapshot = normalizeModelMetadataPayload(raw, 1, undefined, tiny)!
    expect(Object.keys(snapshot.providers)).toEqual(['p1'])
    // per-provider truncation keeps the first two models only
    expect(Object.keys(snapshot.providers['p1'].models)).toEqual(['m1', 'm2'])
    const m1 = snapshot.providers['p1'].models['m1']
    // over-long free strings degrade to unknown, modalities truncate
    expect(m1.name).toBeUndefined()
    expect(m1.modalities.input).toEqual(['text', 'image'])
    // reasoning options truncate to the first two controls, and effort
    // values truncate to the first two entries
    expect(m1.reasoningControls).toEqual({ toggle: true, effort: ['low', 'mid'] })
  })

  it('bounds effort value counts and lengths', () => {
    const raw = {
      p: provider({
        m: {
          id: 'm',
          reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'toolongvalue'] }]
        }
      })
    }
    const snapshot = normalizeModelMetadataPayload(raw, 1, undefined, tiny)!
    // 'medium' exceeds maxEffortValueLength, count caps at maxEffortValues
    expect(snapshot.providers['p'].models['m'].reasoningControls).toEqual({ effort: ['low', 'high'] })
  })

  it('keeps default bounds far above live data (~220 providers / ~7842 models)', () => {
    expect(DEFAULT_NORMALIZATION_LIMITS.maxProviders).toBeGreaterThanOrEqual(440)
    expect(DEFAULT_NORMALIZATION_LIMITS.maxTotalModels).toBeGreaterThanOrEqual(15684)
  })
})

describe('toModelMetadataStatus — loading/ready/unavailable state machine', () => {
  const SNAPSHOT = {
    source: 'models.dev',
    fetchedAt: 1,
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
    const snapshot = { source: 'models.dev', fetchedAt: 1, providers: {} }
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
