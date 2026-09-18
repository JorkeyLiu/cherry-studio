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
  getCreatableProtocolForProviderType,
  getEndpointModeForProviderType,
  isCustomCreatableProtocol,
  isEditableCustomProviderType,
  isOpenAICompatibleEndpointType,
  isPreservedCompatibleProtocol,
  normalizeEditedProviderType,
  resolveProviderTypeForProtocol
} from '../customProviderRegistry'
import { resolveCustomProviderForModel } from '../customProviderRegistry'

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
    // OpenAI-compatible variants that are preserved but not endpoint modes stay put.
    expect(normalizeEditedProviderType('ollama' as any, 'openai' as any)).toBe('ollama')
    expect(normalizeEditedProviderType('new-api' as any, 'gemini' as any)).toBe('new-api')
  })

  it('supports switching between OpenAI-compatible endpoint modes in either direction', () => {
    expect(normalizeEditedProviderType('openai', 'openai-response')).toBe('openai-response')
    expect(normalizeEditedProviderType('openai-response', 'openai')).toBe('openai')
  })

  it('treats the Responses endpoint mode as editable to other approved protocols', () => {
    expect(normalizeEditedProviderType('openai-response', 'anthropic')).toBe('anthropic')
    expect(normalizeEditedProviderType('openai-response', 'gemini')).toBe('gemini')
  })
})

describe('OpenAI-compatible endpoint mode — creation/edit mapping', () => {
  it('keeps the top-level creatable protocols as openai/anthropic/gemini', () => {
    expect([...CUSTOM_CREATABLE_PROTOCOLS]).toEqual(['openai', 'anthropic', 'gemini'])
    expect(isCustomCreatableProtocol('openai-response')).toBe(false)
  })

  it('groups both endpoint modes under the openai protocol', () => {
    expect(isOpenAICompatibleEndpointType('openai')).toBe(true)
    expect(isOpenAICompatibleEndpointType('openai-response')).toBe(true)
    expect(isOpenAICompatibleEndpointType('anthropic')).toBe(false)
    expect(getCreatableProtocolForProviderType('openai')).toBe('openai')
    expect(getCreatableProtocolForProviderType('openai-response')).toBe('openai')
    expect(getCreatableProtocolForProviderType('anthropic')).toBe('anthropic')
    expect(getCreatableProtocolForProviderType('gemini')).toBe('gemini')
  })

  it('defaults creation to Chat Completions (openai)', () => {
    expect(getEndpointModeForProviderType(undefined)).toBe('openai')
    expect(resolveProviderTypeForProtocol('openai', 'openai')).toBe('openai')
  })

  it('maps selecting Responses to the openai-response provider type', () => {
    expect(getEndpointModeForProviderType('openai-response')).toBe('openai-response')
    expect(resolveProviderTypeForProtocol('openai', 'openai-response')).toBe('openai-response')
  })

  it('ignores the endpoint mode for non-OpenAI protocols', () => {
    expect(resolveProviderTypeForProtocol('anthropic', 'openai-response')).toBe('anthropic')
    expect(resolveProviderTypeForProtocol('gemini', 'openai')).toBe('gemini')
  })

  it('treats openai-response as editable while legacy variants stay read-only', () => {
    expect(isEditableCustomProviderType('openai')).toBe(true)
    expect(isEditableCustomProviderType('openai-response')).toBe(true)
    expect(isEditableCustomProviderType('anthropic')).toBe(true)
    expect(isEditableCustomProviderType('ollama')).toBe(false)
    expect(isEditableCustomProviderType('new-api')).toBe(false)
    expect(isEditableCustomProviderType('azure-openai')).toBe(false)
  })

  it('preserves non-mode fields when applying an endpoint-mode edit', () => {
    const original = makeProvider({
      id: 'conn-1',
      type: 'openai',
      apiHost: 'https://api.example.com/v1',
      apiKey: 'sk-original',
      anthropicApiHost: 'https://claude.example.com'
    })
    const sentinelModels = [{ id: 'm1' }, { id: 'm2' }]
    const withModels = { ...original, models: sentinelModels as any, apiOptions: { requiresApiKey: true } as any }
    const editedType = normalizeEditedProviderType(
      withModels.type,
      resolveProviderTypeForProtocol('openai', 'openai-response')
    )
    const merged = { ...withModels, name: 'renamed', type: editedType }
    expect(merged.type).toBe('openai-response')
    expect(merged.id).toBe('conn-1')
    expect(merged.apiHost).toBe('https://api.example.com/v1')
    expect(merged.apiKey).toBe('sk-original')
    expect(merged.anthropicApiHost).toBe('https://claude.example.com')
    expect(merged.models).toBe(sentinelModels)
    expect(merged.apiOptions).toEqual({ requiresApiKey: true })
  })
})
