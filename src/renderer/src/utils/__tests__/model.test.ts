import type { Model, ModelTag } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { getDuplicateModelNames, getModelTags, isFreeModel } from '../model'

describe('model', () => {
  describe('isFreeModel', () => {
    const base = { provider: '', group: '' }
    it('should return true if id or name contains "free" (case-insensitive)', () => {
      expect(isFreeModel({ id: 'free-model', name: 'test', ...base })).toBe(true)
      expect(isFreeModel({ id: 'model', name: 'FreePlan', ...base })).toBe(true)
      expect(isFreeModel({ id: 'model', name: 'notfree', ...base })).toBe(true)
      expect(isFreeModel({ id: 'model', name: 'test', ...base })).toBe(false)
    })

    it('should handle empty id or name', () => {
      expect(isFreeModel({ id: '', name: 'free', ...base })).toBe(true)
      expect(isFreeModel({ id: 'free', name: '', ...base })).toBe(true)
      expect(isFreeModel({ id: '', name: '', ...base })).toBe(false)
    })
  })

  describe('getModelTags (persistence-compat shim)', () => {
    const baseModel: Model = {
      id: 'test',
      provider: 'test',
      group: 'test',
      name: 'test'
    }

    it('keeps the persisted ModelTag keys without reporting legacy tags', () => {
      // Compact display/filter uses the five input modalities now (see
      // utils/inputModalities); this shim retains the Record<ModelTag>
      // shape with all false so no key is deleted or migrated.
      const expected: Record<ModelTag, boolean> = {
        vision: false,
        embedding: false,
        reasoning: false,
        rerank: false,
        free: false,
        function_calling: false,
        web_search: false
      }
      expect(getModelTags([baseModel])).toStrictEqual(expected)
      expect(
        getModelTags([
          { ...baseModel, id: 'vision' },
          { ...baseModel, id: 'free-model' }
        ])
      ).toStrictEqual(expected)
    })
  })

  describe('getDuplicateModelNames', () => {
    it('should return an empty Set for an empty array', () => {
      expect(getDuplicateModelNames([])).toStrictEqual(new Set())
    })

    it('should return an empty Set when no model names are duplicated', () => {
      expect(getDuplicateModelNames([{ name: 'gpt-4o' }, { name: 'claude-3-7-sonnet' }])).toStrictEqual(new Set())
    })

    it('should return the duplicated model names', () => {
      expect(
        getDuplicateModelNames([{ name: 'gpt-4o' }, { name: 'claude-3-7-sonnet' }, { name: 'gpt-4o' }])
      ).toStrictEqual(new Set(['gpt-4o']))
    })

    it('should return all names when every name appears more than once', () => {
      expect(
        getDuplicateModelNames([
          { name: 'gpt-4o' },
          { name: 'gpt-4o' },
          { name: 'claude-3-7-sonnet' },
          { name: 'claude-3-7-sonnet' }
        ])
      ).toStrictEqual(new Set(['gpt-4o', 'claude-3-7-sonnet']))
    })
  })
})
