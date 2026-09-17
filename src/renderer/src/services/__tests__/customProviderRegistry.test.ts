/**
 * Focused tests for the custom-connection registry (slice 1):
 * - only the three approved protocols are offered for new connections;
 * - basic request resolution never consults external model metadata/catalogs;
 * - stale provider-id mismatch protection is preserved (no fallback).
 */
import type { Model, Provider } from '@renderer/types'
import { NO_MODEL_ERROR_NAME } from '@renderer/utils/noModelError'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

import {
  CUSTOM_CREATABLE_PROTOCOLS,
  isCustomCreatableProtocol,
  isPreservedCompatibleProtocol,
  normalizeEditedProviderType,
  resolveCustomProviderForModel
} from '../customProviderRegistry'

const makeProvider = (overrides: Partial<Provider> & { id: string; type: string }): Provider =>
  ({
    name: overrides.id,
    apiKey: '',
    apiHost: 'https://api.example.com',
    models: [],
    enabled: true,
    isSystem: false,
    ...overrides
  }) as Provider

const makeModel = (id: string, provider: string): Model =>
  ({
    id,
    name: id,
    provider,
    group: provider
  }) as Model

describe('custom creatable protocols', () => {
  it('offers exactly the three approved protocols', () => {
    expect([...CUSTOM_CREATABLE_PROTOCOLS]).toEqual(['openai', 'anthropic', 'gemini'])
  })

  it('accepts only the approved protocols for new creation', () => {
    expect(isCustomCreatableProtocol('openai')).toBe(true)
    expect(isCustomCreatableProtocol('anthropic')).toBe(true)
    expect(isCustomCreatableProtocol('gemini')).toBe(true)
    for (const type of ['openai-response', 'azure-openai', 'ollama', 'new-api', 'vertexai', 'aws-bedrock']) {
      expect(isCustomCreatableProtocol(type)).toBe(false)
    }
  })

  it('treats openai-compatible variants as preserved-compatible for migration', () => {
    for (const type of ['openai', 'openai-response', 'anthropic', 'gemini', 'ollama', 'new-api']) {
      expect(isPreservedCompatibleProtocol(type)).toBe(true)
    }
    for (const type of ['azure-openai', 'vertexai', 'vertex-anthropic', 'aws-bedrock', 'mistral', 'gateway']) {
      expect(isPreservedCompatibleProtocol(type)).toBe(false)
    }
  })
})

describe('resolveCustomProviderForModel — catalog-free resolution', () => {
  const providers = [
    makeProvider({ id: 'my-openai', type: 'openai', apiHost: 'https://my.example.com' }),
    makeProvider({ id: 'my-anthropic', type: 'anthropic', apiHost: 'https://anthropic.example.com' }),
    makeProvider({ id: 'my-gemini', type: 'gemini', apiHost: 'https://gemini.example.com' })
  ]

  it.each([
    ['my-renamed-unknown-1', 'my-openai'],
    ['custom-claude-xyz', 'my-anthropic'],
    ['gemini-my-fork-99', 'my-gemini']
  ])('resolves unknown manually added model id %s without catalog/metadata', (id, providerId) => {
    // The id is absent from every external catalog (SYSTEM_MODELS/models.dev);
    // resolution consults only the owning provider entry.
    const resolved = resolveCustomProviderForModel(makeModel(id, providerId), providers)
    expect(resolved.id).toBe(providerId)
  })

  it('throws NoModelError when the model slot is unconfigured', () => {
    expect(() => resolveCustomProviderForModel(undefined, providers)).toThrowError(
      expect.objectContaining({ name: NO_MODEL_ERROR_NAME })
    )
  })

  it('throws NoModelError when the owning provider entry is gone', () => {
    expect(() => resolveCustomProviderForModel(makeModel('m', 'deleted-provider'), providers)).toThrowError(
      expect.objectContaining({ name: NO_MODEL_ERROR_NAME })
    )
  })

  it('throws NoModelError for a stale provider instead of falling back to another provider', () => {
    // A provider entry exists, but not the one the model belongs to: the
    // resolver must not silently substitute it.
    const others = [makeProvider({ id: 'other', type: 'openai' })]
    expect(() => resolveCustomProviderForModel(makeModel('m', 'my-openai'), others)).toThrowError(
      expect.objectContaining({ name: NO_MODEL_ERROR_NAME })
    )
  })
})

describe('normalizeEditedProviderType — legacy edit preservation', () => {
  it('accepts the edited type when the original is an approved protocol', () => {
    expect(normalizeEditedProviderType('openai', 'anthropic')).toBe('anthropic')
    expect(normalizeEditedProviderType('gemini', 'gemini')).toBe('gemini')
  })

  it('preserves the original type for retained legacy entries regardless of popup interaction', () => {
    expect(normalizeEditedProviderType('azure-openai' as any, 'openai' as any)).toBe('azure-openai')
    expect(normalizeEditedProviderType('vertexai' as any, 'gemini' as any)).toBe('vertexai')
    expect(normalizeEditedProviderType('aws-bedrock' as any, 'anthropic' as any)).toBe('aws-bedrock')
    // OpenAI-compatible variants that are preserved but not creatable also stay put.
    expect(normalizeEditedProviderType('openai-response', 'openai')).toBe('openai-response')
    expect(normalizeEditedProviderType('ollama' as any, 'openai' as any)).toBe('ollama')
    expect(normalizeEditedProviderType('new-api' as any, 'gemini' as any)).toBe('new-api')
  })
})
