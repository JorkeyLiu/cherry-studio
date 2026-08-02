/**
 * Focused tests for the shared cloneForWire JSON wire boundary helper.
 *
 * Covers LOCK-N2 (undefined property omission, undefined array element
 * rejection), LOCK-N3 (non-JSON value rejection), and the full set of
 * constraints: depth limit, cycle detection, sparse array rejection,
 * plain object enforcement, and insertion order preservation.
 *
 * These tests validate the shared implementation used by both
 * SqliteMessageDataSource (renderer→Main IPC) and the chatImport
 * entry point (Dexie→Main IPC).
 */
import { describe, expect, it } from 'vitest'

import { cloneForWire } from '../jsonWire'

describe('cloneForWire (shared JSON wire boundary)', () => {
  // =========================================================================
  // LOCK-N2: undefined property omission
  // =========================================================================

  describe('undefined property omission (LOCK-N2)', () => {
    it('omits undefined properties from plain objects', () => {
      const clone = cloneForWire({ a: 1, b: undefined, c: null })
      expect(clone).toEqual({ a: 1, c: null })
      expect('b' in (clone as object)).toBe(false)
    })

    it('omits undefined in nested objects', () => {
      const clone = cloneForWire({ outer: { a: 1, b: undefined } })
      expect(clone).toEqual({ outer: { a: 1 } })
    })

    it('omits multiple undefined properties', () => {
      const clone = cloneForWire({ a: undefined, b: undefined, c: 'keep' })
      expect(clone).toEqual({ c: 'keep' })
    })

    it('preserves empty objects', () => {
      const clone = cloneForWire({})
      expect(clone).toEqual({})
    })

    it('preserves all-defined objects', () => {
      const clone = cloneForWire({ a: 1, b: 'two', c: null, d: false })
      expect(clone).toEqual({ a: 1, b: 'two', c: null, d: false })
    })
  })

  // =========================================================================
  // LOCK-N2: undefined array element rejection
  // =========================================================================

  describe('undefined array element rejection (LOCK-N2)', () => {
    it('rejects explicit undefined in arrays', () => {
      expect(() => cloneForWire([1, undefined, 3])).toThrow(TypeError)
    })

    it('rejects sparse arrays', () => {
      const sparse: number[] = []
      sparse[0] = 1
      sparse[2] = 3
      expect(1 in sparse).toBe(false)
      expect(() => cloneForWire(sparse)).toThrow(TypeError)
    })
  })

  // =========================================================================
  // Historical Message optional undefined fields
  // =========================================================================

  describe('historical Message optional undefined fields', () => {
    it('strips explicit undefined from upgradeToV7-style message reference', () => {
      const message = {
        id: 'msg-1',
        role: 'user',
        assistantId: '',
        topicId: 'topic-1',
        createdAt: '2026-07-30T00:00:00.000Z',
        status: 'success',
        modelId: undefined,
        model: undefined,
        type: undefined,
        useful: undefined,
        askId: undefined,
        mentions: undefined,
        enabledMCPs: undefined,
        usage: undefined,
        metrics: undefined,
        multiModelMessageStyle: undefined,
        foldSelected: undefined,
        blocks: ['block-1']
      }
      const clone = cloneForWire(message)
      expect(clone).toEqual({
        id: 'msg-1',
        role: 'user',
        assistantId: '',
        topicId: 'topic-1',
        createdAt: '2026-07-30T00:00:00.000Z',
        status: 'success',
        blocks: ['block-1']
      })
    })

    it('strips undefined from nested message content blocks', () => {
      const block = {
        id: 'blk-1',
        messageId: 'msg-1',
        type: 'tool',
        status: 'success',
        content: { result: 'data', items: [1, 2, 3] },
        error: undefined,
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: undefined
      }
      const clone = cloneForWire(block)
      expect(clone).toEqual({
        id: 'blk-1',
        messageId: 'msg-1',
        type: 'tool',
        status: 'success',
        content: { result: 'data', items: [1, 2, 3] },
        createdAt: '2026-07-30T00:00:00.000Z'
      })
    })
  })

  // =========================================================================
  // Preserved values
  // =========================================================================

  describe('preserved values', () => {
    it('preserves null values', () => {
      const clone = cloneForWire({ a: null, b: [null, 1] })
      expect(clone).toEqual({ a: null, b: [null, 1] })
    })

    it('preserves insertion order', () => {
      const input: Record<string, unknown> = { z: 1, a: 2, m: 3 }
      const clone = cloneForWire(input)
      expect(Object.keys(clone)).toEqual(['z', 'a', 'm'])
    })

    it('deeply clones nested objects', () => {
      const inner = { x: 1 }
      const input = { nested: inner }
      const clone = cloneForWire(input)
      expect(clone.nested).toEqual({ x: 1 })
      expect(clone.nested).not.toBe(inner)
    })

    it('does not mutate input', () => {
      const input: Record<string, unknown> = { a: 1, b: { c: 2 } }
      const original = { ...input }
      cloneForWire(input)
      expect(input).toEqual(original)
    })
  })

  // =========================================================================
  // Nested objects preserved
  // =========================================================================

  describe('nested objects preserved', () => {
    it('preserves tool block object content', () => {
      const toolContent = { result: 'data', items: [1, 2, 3] }
      const input = { type: 'tool', content: toolContent, id: 'b-1' }
      const clone = cloneForWire(input)
      expect(clone.content).toEqual(toolContent)
      expect(clone.content).not.toBe(toolContent)
    })

    it('preserves structured model object', () => {
      const model = {
        id: 'gpt-4',
        provider: 'openai',
        name: 'GPT-4',
        group: 'gpt',
        capabilities: [{ type: 'text' }]
      }
      const input = { model, modelId: 'gpt-4' }
      const clone = cloneForWire(input)
      expect(clone.model).toEqual(model)
      expect(clone.model).not.toBe(model)
    })
  })

  // =========================================================================
  // LOCK-N3: non-JSON value rejection
  // =========================================================================

  describe('non-JSON value rejection (LOCK-N3)', () => {
    it('rejects bigint', () => {
      expect(() => cloneForWire({ v: BigInt(42) })).toThrow(TypeError)
    })

    it('rejects symbol', () => {
      expect(() => cloneForWire({ v: Symbol('x') })).toThrow(TypeError)
    })

    it('rejects function', () => {
      expect(() => cloneForWire({ v: () => {} })).toThrow(TypeError)
    })

    it('rejects Date', () => {
      expect(() => cloneForWire({ v: new Date() })).toThrow(TypeError)
    })

    it('rejects Map', () => {
      expect(() => cloneForWire({ v: new Map() })).toThrow(TypeError)
    })

    it('rejects Set', () => {
      expect(() => cloneForWire({ v: new Set() })).toThrow(TypeError)
    })

    it('rejects TypedArray (Uint8Array)', () => {
      expect(() => cloneForWire({ v: new Uint8Array([1]) })).toThrow(TypeError)
    })

    it('rejects non-finite number (NaN)', () => {
      expect(() => cloneForWire({ v: NaN })).toThrow(TypeError)
    })

    it('rejects non-finite number (Infinity)', () => {
      expect(() => cloneForWire({ v: Infinity })).toThrow(TypeError)
    })

    it('rejects sparse arrays', () => {
      const sparse: number[] = []
      sparse[0] = 1
      sparse[2] = 3
      expect(1 in sparse).toBe(false)
      expect(() => cloneForWire(sparse)).toThrow(TypeError)
    })

    it('rejects undefined in arrays', () => {
      expect(() => cloneForWire([1, undefined, 3])).toThrow(TypeError)
    })

    it('rejects cyclic references', () => {
      const obj: Record<string, unknown> = { a: 1 }
      obj.self = obj
      expect(() => cloneForWire(obj)).toThrow(/cyclic/)
    })

    it('rejects class instances', () => {
      class Custom {
        value = 42
      }
      expect(() => cloneForWire({ v: new Custom() })).toThrow(TypeError)
    })

    it('rejects deeply nested beyond depth limit', () => {
      let deep: any = 1
      for (let i = 0; i <= 25; i++) {
        deep = { v: deep }
      }
      expect(() => cloneForWire(deep)).toThrow(/depth/)
    })

    it('rejects RegExp', () => {
      expect(() => cloneForWire({ v: /abc/ })).toThrow(TypeError)
    })
  })
})
