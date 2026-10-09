import { describe, expect, it } from 'vitest'

import { asConfiguredServingModel, isConfiguredServingModel } from '../effectiveModel'

const valid = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'gpt-4o',
    provider: 'openai',
    name: 'GPT-4o',
    group: 'gpt',
    ...overrides
  }) as never

describe('isConfiguredServingModel / asConfiguredServingModel', () => {
  it('accepts a valid serving model and preserves identity verbatim', () => {
    const model = valid()
    expect(isConfiguredServingModel(model)).toBe(true)
    expect(asConfiguredServingModel(model)).toBe(model)
    expect(asConfiguredServingModel(model)?.id).toBe('gpt-4o')
  })

  it('accepts valid arbitrary IDs with missing display/group metadata (no metadata gating)', () => {
    const minimal = { id: 'custom-arbitrary-id-123', provider: 'custom-conn' } as never
    expect(asConfiguredServingModel(minimal)).toBe(minimal)
    const noGroup = valid({ group: undefined, name: undefined })
    expect(asConfiguredServingModel(noGroup)).toBe(noGroup)
  })

  it('rejects realistic malformed persisted selections without coercing to empty string', () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      { id: undefined, provider: 'openai' },
      { id: null, provider: 'openai' },
      { id: 123, provider: 'openai' },
      { id: '', provider: 'openai' },
      { id: '   ', provider: 'openai' },
      { id: 'm1', provider: undefined },
      { id: 'm1', provider: '' },
      { id: 'm1', provider: '   ' },
      { id: 'm1', provider: 42 },
      'm1',
      0
    ]
    for (const malformed of cases) {
      expect(isConfiguredServingModel(malformed)).toBe(false)
      expect(asConfiguredServingModel(malformed)).toBeUndefined()
    }
  })

  it('requires both id and provider: one-sided values stay unconfigured', () => {
    expect(asConfiguredServingModel({ id: 'only-id' } as never)).toBeUndefined()
    expect(asConfiguredServingModel({ provider: 'only-provider' } as never)).toBeUndefined()
  })
})
