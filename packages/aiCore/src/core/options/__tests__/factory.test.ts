import { describe, expect, it } from 'vitest'

import { mergeProviderOptions } from '../factory'
import type { TypedProviderOptions } from '../types'

// Helper to build typed options for tests without verbose casts at each call site
const opts = (o: Record<string, Record<string, unknown>>): Partial<TypedProviderOptions> =>
  o as Partial<TypedProviderOptions>

describe('mergeProviderOptions', () => {
  it('deep merges provider options for the same provider', () => {
    const reasoningOptions = opts({ 'openai-compatible': { reasoning: { enabled: true, effort: 'medium' } } })
    const webSearchOptions = opts({ 'openai-compatible': { plugins: [{ id: 'web', max_results: 5 }] } })

    const merged = mergeProviderOptions(reasoningOptions, webSearchOptions)

    expect(merged['openai-compatible']).toEqual({
      reasoning: { enabled: true, effort: 'medium' },
      plugins: [{ id: 'web', max_results: 5 }]
    })
  })

  it('preserves options from other providers while merging', () => {
    const compatible: Partial<TypedProviderOptions> = opts({
      'openai-compatible': { reasoning: { enabled: true, effort: 'medium' } }
    })
    const openAI: Partial<TypedProviderOptions> = { openai: { reasoningEffort: 'low' } }
    const merged = mergeProviderOptions(compatible, openAI)

    expect(merged['openai-compatible']).toEqual({ reasoning: { enabled: true, effort: 'medium' } })
    expect(merged.openai).toEqual({ reasoningEffort: 'low' })
  })

  it('overwrites primitive values with later values', () => {
    const first: Partial<TypedProviderOptions> = { openai: { reasoningEffort: 'low', user: 'user-123' } }
    const second: Partial<TypedProviderOptions> = { openai: { reasoningEffort: 'high', maxToolCalls: 5 } }

    const merged = mergeProviderOptions(first, second)

    expect(merged.openai).toEqual({
      reasoningEffort: 'high',
      user: 'user-123',
      maxToolCalls: 5
    })
  })

  it('overwrites arrays with later values instead of merging', () => {
    const first = opts({ 'openai-compatible': { models: ['gpt-4', 'gpt-3.5-turbo'] } })
    const second = opts({ 'openai-compatible': { models: ['claude-3-opus', 'claude-3-sonnet'] } })

    const merged = mergeProviderOptions(first, second)

    expect((merged['openai-compatible'] as Record<string, unknown>)?.models).toEqual([
      'claude-3-opus',
      'claude-3-sonnet'
    ])
  })

  it('deeply merges nested objects while overwriting primitives', () => {
    const first = opts({
      'openai-compatible': {
        reasoning: { enabled: true, effort: 'low' },
        user: 'user-123'
      }
    })
    const second = opts({
      'openai-compatible': {
        reasoning: { effort: 'high', max_tokens: 500 },
        user: 'user-456'
      }
    })

    const merged = mergeProviderOptions(first, second)

    expect(merged['openai-compatible']).toEqual({
      reasoning: { enabled: true, effort: 'high', max_tokens: 500 },
      user: 'user-456'
    })
  })

  it('replaces arrays instead of merging them', () => {
    const first = opts({ 'openai-compatible': { plugins: [{ id: 'old' }] } })
    const second = opts({ 'openai-compatible': { plugins: [{ id: 'new' }] } })
    const merged = mergeProviderOptions(first, second)
    expect((merged['openai-compatible'] as Record<string, unknown>)?.plugins).toEqual([{ id: 'new' }])
  })
})
