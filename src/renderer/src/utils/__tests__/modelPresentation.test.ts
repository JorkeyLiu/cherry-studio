import { setModelMetadataSnapshotForTests } from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it } from 'vitest'

import { getModelPresentation } from '../modelPresentation'

const provider: Provider = {
  id: 'openai',
  name: 'OpenAI',
  type: 'openai',
  apiKey: '',
  apiHost: 'https://api.openai.com/v1',
  models: []
} as unknown as Provider

const proxyProvider: Provider = {
  id: 'my-proxy',
  name: 'MyProxy',
  type: 'openai',
  apiKey: '',
  apiHost: 'https://my-proxy.example.com/v1',
  models: []
} as unknown as Provider

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test-model',
    provider: 'openai',
    name: 'test-model',
    group: 'test',
    ...overrides
  }
}

function installEntry(
  modelId: string,
  entry: Record<string, unknown>,
  opts?: { serving?: Record<string, unknown>; canonicalId?: string; providerApi?: string }
) {
  const canonicalId = opts?.canonicalId ?? `openai/${modelId}`
  const models: Record<string, unknown> = { [canonicalId]: { id: canonicalId, ...entry } as never }
  const providers: Record<string, any> = {}
  if (opts?.serving) {
    // For serving, need provider source. We'll use openai source via official host matching.
    providers['openai'] = { id: 'openai', name: 'OpenAI', api: 'https://api.openai.com/v1' }
  }
  setModelMetadataSnapshotForTests({
    source: 'models.dev',
    fetchedAt: 1,
    models: models as never,
    providers: Object.keys(providers).length ? (providers as never) : {}
  })
}

describe('modelPresentation projection', () => {
  beforeEach(() => setModelMetadataSnapshotForTests(null))

  it('fallback id -> uses metadata displayName and effective modalities, preserves ID', () => {
    installEntry('deepseek-flash', {
      name: 'DeepSeek V4.1 Flash',
      modalities: { input: ['text', 'image'], output: ['text'] }
    })
    const model = makeModel({ id: 'deepseek-flash', name: 'deepseek-flash', provider: 'openai' })
    const p = getModelPresentation(model, provider)
    expect(p.displayName).toBe('DeepSeek V4.1 Flash')
    expect(p.effective?.name).toBe('DeepSeek V4.1 Flash')
    expect(p.effective?.modalities?.input).toEqual(['text', 'image'])
    expect(p.source).not.toBe('none')
    // ID untouched
    expect(p.model.id).toBe('deepseek-flash')
    expect(p.displayName).not.toBe('deepseek-flash')
  })

  it('provider real / user name wins over metadata (no overwrite)', () => {
    installEntry('gemini-2.5-pro', { name: 'Metadata Gemini Name' })
    const model = makeModel({ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'openai' })
    const p = getModelPresentation(model, provider)
    expect(p.displayName).toBe('Gemini 2.5 Pro')
    expect(p.displayName).not.toBe('Metadata Gemini Name')
    // still has effective for modalities but displayName preserves real name
    expect(p.effective?.name).toBe('Metadata Gemini Name')
    expect(p.model.id).toBe('gemini-2.5-pro')
  })

  it('blank name uses metadata displayName', () => {
    installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
    const model = makeModel({ id: 'deepseek-flash', name: '   ', provider: 'openai' })
    const p = getModelPresentation(model, provider)
    expect(p.displayName).toBe('DeepSeek V4.1 Flash')
  })

  it('canonical basename custom-proxy match (proxy id basename unique -> canonical)', () => {
    // Install canonical entry for openai/gpt-4 with basename gpt-4 unique
    setModelMetadataSnapshotForTests({
      source: 'models.dev',
      fetchedAt: 1,
      models: {
        'openai/gpt-4': {
          id: 'openai/gpt-4',
          name: 'GPT-4',
          modalities: { input: ['text'], output: ['text'] }
        } as never
      },
      providers: {}
    })
    // Model via custom proxy with id 'gpt-4' should match canonical via basename uniqueness
    const model = makeModel({ id: 'gpt-4', name: 'gpt-4', provider: 'my-proxy' })
    // provider mapping not needed for canonical resolution; it's canonical-only
    const p = getModelPresentation(model, proxyProvider)
    expect(p.displayName).toBe('GPT-4')
    expect(p.effective?.name).toBe('GPT-4')
    expect(p.source).toBe('canonical')
  })

  it('unmatched raw / fail-open preserves original name/id', () => {
    const model = makeModel({ id: 'unknown-model-xyz', name: 'unknown-model-xyz', provider: 'openai' })
    const p = getModelPresentation(model, provider)
    expect(p.displayName).toBe('unknown-model-xyz')
    expect(p.source).toBe('none')
    expect(p.effective).toBeUndefined()
    expect(p.model.id).toBe('unknown-model-xyz')
  })

  it('unmatched blank name fail-open preserves id', () => {
    const model = makeModel({ id: 'unknown-123', name: '', provider: 'openai' })
    const p = getModelPresentation(model, provider)
    expect(p.displayName).toBe('unknown-123')
    expect(p.source).toBe('none')
  })

  it('ID untouched even when displayName replaced', () => {
    installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
    const model = makeModel({ id: 'deepseek-flash', name: 'deepseek-flash', provider: 'openai' })
    const p = getModelPresentation(model, provider)
    expect(p.model.id).toBe('deepseek-flash')
    expect(p.displayName).toBe('DeepSeek V4.1 Flash')
    expect(p.model.name).toBe('deepseek-flash') // original retained in model
  })

  it('avoids duplicating metadata calls (single source) - effective and displayName from same snapshot', () => {
    installEntry('deepseek-flash', {
      name: 'DeepSeek V4.1 Flash',
      modalities: { input: ['text', 'image'], output: ['text'] }
    })
    const model = makeModel({ id: 'deepseek-flash', name: 'deepseek-flash', provider: 'openai' })
    const p = getModelPresentation(model, provider)
    // Both derived from same effective; ensure consistency
    expect(p.displayName).toBe(p.effective?.name)
    expect(p.effective?.modalities?.input).toContain('image')
  })
})
