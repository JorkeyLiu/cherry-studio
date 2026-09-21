import { setModelMetadataSnapshotForTests } from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  getModelMetadataDisplayName,
  isDefaultModelName,
  isDefaultModelNameForEdit,
  resolveManualAddModelName,
  resolveModelNameWithMetadata
} from '../modelDisplayName'

const provider: Provider = {
  id: 'openai',
  type: 'openai',
  name: 'OpenAI',
  apiKey: '',
  apiHost: 'https://api.openai.com/v1',
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

function installEntry(modelId: string, entry: Record<string, unknown>) {
  const canonicalId = `openai/${modelId}`
  setModelMetadataSnapshotForTests({
    source: 'models.dev',
    fetchedAt: 1,
    models: { [canonicalId]: { id: canonicalId, ...entry } as never },
    providers: {}
  })
}

describe('modelDisplayName helper', () => {
  beforeEach(() => {
    setModelMetadataSnapshotForTests(null)
  })

  describe('isDefaultModelName', () => {
    it('returns true for blank', () => {
      expect(isDefaultModelName('', 'x')).toBe(true)
      expect(isDefaultModelName('   ', 'x')).toBe(true)
      expect(isDefaultModelName(undefined, 'x')).toBe(true)
      expect(isDefaultModelName(null, 'x')).toBe(true)
    })

    it('returns true when trimmed name equals trimmed id (case-sensitive)', () => {
      expect(isDefaultModelName('gpt-4o', 'gpt-4o')).toBe(true)
      expect(isDefaultModelName('  gpt-4o  ', 'gpt-4o')).toBe(true)
      expect(isDefaultModelName('gpt-4o', '  gpt-4o  ')).toBe(true)
    })

    it('returns false when name differs (including case)', () => {
      expect(isDefaultModelName('GPT-4o', 'gpt-4o')).toBe(false)
      expect(isDefaultModelName('My Custom', 'gpt-4o')).toBe(false)
      expect(isDefaultModelName(' gpt-4o-1 ', 'gpt-4o')).toBe(false)
    })

    it('alias isDefaultModelNameForEdit matches', () => {
      expect(isDefaultModelNameForEdit).toBe(isDefaultModelName)
    })
  })

  describe('getModelMetadataDisplayName', () => {
    it('returns trimmed effective name when present', () => {
      installEntry('deepseek-flash', { name: '  DeepSeek V4.1 Flash  ' })
      expect(getModelMetadataDisplayName(makeModel({ id: 'deepseek-flash', name: 'deepseek-flash' }), provider)).toBe(
        'DeepSeek V4.1 Flash'
      )
    })

    it('returns undefined when absent or blank or unknown', () => {
      expect(getModelMetadataDisplayName(makeModel({ id: 'unknown', name: 'unknown' }), provider)).toBeUndefined()
      installEntry('blank-name', { name: '   ' })
      expect(getModelMetadataDisplayName(makeModel({ id: 'blank-name', name: 'blank-name' }), provider)).toBeUndefined()
      installEntry('no-name-field', {})
      expect(
        getModelMetadataDisplayName(makeModel({ id: 'no-name-field', name: 'no-name-field' }), provider)
      ).toBeUndefined()
    })

    it('fail-open on exception', () => {
      // passing null provider should not throw
      expect(getModelMetadataDisplayName(makeModel({ id: 'x', name: 'x' }), null as any)).toBeUndefined()
    })
  })

  describe('resolveModelNameWithMetadata', () => {
    it('returns metadata name when default-like and metadata exists', () => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
      const model = makeModel({ id: 'deepseek-flash', name: 'deepseek-flash' })
      expect(resolveModelNameWithMetadata(model, provider)).toBe('DeepSeek V4.1 Flash')
    })

    it('preserves custom name even when metadata exists', () => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
      const model = makeModel({ id: 'deepseek-flash', name: 'My Custom Name' })
      expect(resolveModelNameWithMetadata(model, provider)).toBe('My Custom Name')
    })

    it('returns original name when metadata absent', () => {
      const model = makeModel({ id: 'unknown-model', name: 'unknown-model' })
      expect(resolveModelNameWithMetadata(model, provider)).toBe('unknown-model')
    })

    it('handles blank name as default-like', () => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
      const model = makeModel({ id: 'deepseek-flash', name: '' })
      expect(resolveModelNameWithMetadata(model, provider)).toBe('DeepSeek V4.1 Flash')
    })
  })

  describe('resolveManualAddModelName', () => {
    it('explicit non-fallback wins over metadata', () => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
      expect(resolveManualAddModelName('deepseek-flash', 'My Explicit Name', provider)).toBe('My Explicit Name')
    })

    it('blank explicit uses metadata when available', () => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
      expect(resolveManualAddModelName('deepseek-flash', undefined, provider)).toBe('DeepSeek V4.1 Flash')
      expect(resolveManualAddModelName('deepseek-flash', '', provider)).toBe('DeepSeek V4.1 Flash')
      expect(resolveManualAddModelName('deepseek-flash', '   ', provider)).toBe('DeepSeek V4.1 Flash')
    })

    it('fallback name equals id uses metadata (batch)', () => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
      // batch passes name === id
      expect(resolveManualAddModelName('deepseek-flash', 'deepseek-flash', provider)).toBe('DeepSeek V4.1 Flash')
      expect(resolveManualAddModelName('deepseek-flash', '  deepseek-flash  ', provider)).toBe('DeepSeek V4.1 Flash')
    })

    it('fallback without metadata returns uppercased id or explicit id', () => {
      // no metadata installed
      expect(resolveManualAddModelName('my-model', undefined, provider)).toBe('MY-MODEL')
      expect(resolveManualAddModelName('my-model', '', provider)).toBe('MY-MODEL')
      // explicit equals id and no metadata -> preserve id (batch behavior)
      expect(resolveManualAddModelName('my-model', 'my-model', provider)).toBe('my-model')
    })

    it('explicit trimmed wins but trims whitespace', () => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
      expect(resolveManualAddModelName('deepseek-flash', '  My Custom  ', provider)).toBe('My Custom')
    })

    it('metadata absence never blocks add (fail-open)', () => {
      expect(resolveManualAddModelName('unknown', undefined, provider)).toBe('UNKNOWN')
    })
  })

  describe('fetched Manage Models add logic (isFallback === trimmed equality)', () => {
    it('replaces fallback-id model with metadata while preserving real provider name', () => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
      const fetchedFallback = makeModel({ id: 'deepseek-flash', name: 'deepseek-flash' })
      expect(resolveModelNameWithMetadata(fetchedFallback, provider)).toBe('DeepSeek V4.1 Flash')

      // Real Gemini/provider display name must be preserved: name differs from id
      const geminiModel = makeModel({ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' })
      // even if metadata also has an entry, the helper should preserve the real display name
      installEntry('gemini-2.5-pro', { name: 'Metadata Gemini Name' })
      expect(resolveModelNameWithMetadata(geminiModel, provider)).toBe('Gemini 2.5 Pro')
    })
  })
})
