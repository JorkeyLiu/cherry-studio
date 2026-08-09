import type { Model, Provider } from '@renderer/types'
import type { AiSdkErrorUnion } from '@renderer/types/error'
import { serializeError } from '@renderer/utils/error'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the factory dependency-neutral: the translated message comes from the
// mocked i18n, so the tests assert marker behavior, not locale content.
vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

import { assertProviderMatchesModel, createNoModelError, isNoModelError, NO_MODEL_ERROR_NAME } from '../noModelError'

describe('createNoModelError', () => {
  it('produces an Error with the stable NoModelError name marker', () => {
    const error = createNoModelError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe(NO_MODEL_ERROR_NAME)
  })

  it('preserves the localized message.error.enter.model text', () => {
    const error = createNoModelError()
    // i18n is mocked to return the key itself.
    expect(error.message).toBe('message.error.enter.model')
  })

  it('retains the custom name when serialized through the real serializer', () => {
    // The chat error pipeline (messageStreaming baseCallbacks) serializes every
    // error with serializeError; the serialized `name` drives ErrorBlock's
    // classification, so it must survive serialization.
    const serialized = serializeError(createNoModelError() as unknown as AiSdkErrorUnion)
    expect(serialized.name).toBe(NO_MODEL_ERROR_NAME)
    expect(serialized.message).toBe('message.error.enter.model')
  })
})

describe('isNoModelError', () => {
  it('matches the factory-produced error', () => {
    expect(isNoModelError(createNoModelError())).toBe(true)
  })

  it('does not match a plain Error', () => {
    expect(isNoModelError(new Error('No model configured'))).toBe(false)
  })

  it('does not match non-object values', () => {
    expect(isNoModelError(undefined)).toBe(false)
    expect(isNoModelError(null)).toBe(false)
    expect(isNoModelError('NoModelError')).toBe(false)
  })
})

describe('assertProviderMatchesModel', () => {
  const openaiModel = { id: 'gpt-4', name: 'gpt-4', provider: 'openai' } as Model
  const openaiProvider = { id: 'openai', name: 'OpenAI' } as Provider

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts a provider that belongs to the requested model', () => {
    let provider: Provider | undefined
    expect(() => {
      assertProviderMatchesModel(openaiModel, openaiProvider)
      provider = openaiProvider
    }).not.toThrow()
    // The assertion narrows provider to a definite Provider.
    expect(provider?.id).toBe('openai')
  })

  it('throws NoModelError when the provider does not belong to the requested model (stale provider)', () => {
    // getProviderByModel falls back to the global default provider here; the
    // stale assistant model must not silently switch to it.
    const defaultProvider = { id: 'anthropic', name: 'Anthropic' } as Provider
    expect(() => assertProviderMatchesModel(openaiModel, defaultProvider)).toThrowError(
      expect.objectContaining({ name: NO_MODEL_ERROR_NAME })
    )
  })

  it('throws NoModelError when no provider resolves', () => {
    expect(() => assertProviderMatchesModel(openaiModel, undefined)).toThrowError(
      expect.objectContaining({ name: NO_MODEL_ERROR_NAME })
    )
  })
})
