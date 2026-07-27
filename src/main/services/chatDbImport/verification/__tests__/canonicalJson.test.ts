/**
 * Canonical JSON serialization + SHA-256 digest tests (LOCK-4302).
 *
 * Covers:
 * - Deterministic recursive key ordering (input key order irrelevant).
 * - Array order preservation (order IS significant).
 * - Explicit null vs absent-key distinction.
 * - Rejection of every non-JSON value class (never coerced or skipped).
 * - SHA-256 hex digest correctness and stability.
 */

import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:crypto')

import { canonicalDigest, CanonicalizationError, canonicalStringify, sha256Hex } from '../canonicalJson'

describe('canonicalStringify', () => {
  it('sorts object keys recursively regardless of insertion order', () => {
    const a = { b: 1, a: { d: [1, 2], c: null }, z: 'x' }
    const b = { z: 'x', a: { c: null, d: [1, 2] }, b: 1 }
    expect(canonicalStringify(a)).toBe('{"a":{"c":null,"d":[1,2]},"b":1,"z":"x"}')
    expect(canonicalStringify(a)).toBe(canonicalStringify(b))
    expect(canonicalDigest(a)).toBe(canonicalDigest(b))
  })

  it('sorts keys by UTF-16 code units deterministically', () => {
    expect(canonicalStringify({ b: 1, B: 2, '0': 3, _: 4 })).toBe('{"0":3,"B":2,"_":4,"b":1}')
  })

  it('preserves array order exactly (order is significant)', () => {
    expect(canonicalStringify([2, 1])).toBe('[2,1]')
    expect(canonicalStringify([2, 1])).not.toBe(canonicalStringify([1, 2]))
    expect(canonicalDigest(['m-a', 'm-c'])).not.toBe(canonicalDigest(['m-c', 'm-a']))
  })

  it('distinguishes explicit null from an absent key', () => {
    expect(canonicalStringify({ a: null })).toBe('{"a":null}')
    expect(canonicalStringify({})).toBe('{}')
    expect(canonicalDigest({ a: null })).not.toBe(canonicalDigest({}))
  })

  it('serializes scalars and unicode strings via JSON semantics', () => {
    expect(canonicalStringify(null)).toBe('null')
    expect(canonicalStringify(true)).toBe('true')
    expect(canonicalStringify(false)).toBe('false')
    expect(canonicalStringify(1.5)).toBe('1.5')
    expect(canonicalStringify(-0)).toBe('0') // -0 normalizes like JSON.stringify
    expect(canonicalStringify('a"b\n漢')).toBe(JSON.stringify('a"b\n漢'))
  })

  it('rejects every non-JSON value class with a path', () => {
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /undefined/],
      [{ a: undefined }, /root\.a.*undefined/],
      [Number.NaN, /non-finite/],
      [Number.POSITIVE_INFINITY, /non-finite/],
      [{ n: [1, Number.NEGATIVE_INFINITY] }, /root\.n\[1\].*non-finite/],
      [10n, /bigint/],
      [Symbol('s'), /symbol/],
      [() => 0, /function/],
      [new Date(0), /non-plain object/],
      [new Map(), /non-plain object/],
      [new Set(), /non-plain object/],
      [/re/, /non-plain object/],
      [{ deep: { buf: new Uint8Array(1) } }, /root\.deep\.buf.*non-plain object/]
    ]
    for (const [value, pattern] of cases) {
      expect(() => canonicalStringify(value)).toThrowError(CanonicalizationError)
      expect(() => canonicalStringify(value)).toThrowError(pattern)
    }
  })

  it('rejects sparse arrays and cyclic values', () => {
    expect(() => canonicalStringify([1, , 3])).toThrowError(/sparse/)

    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => canonicalStringify(cyclic)).toThrowError(/cyclic/)

    // Repeated (non-cyclic) references to the same object are allowed.
    const shared = { k: 1 }
    expect(canonicalStringify({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}')
  })

  it('accepts null-prototype objects', () => {
    const obj = Object.create(null) as Record<string, unknown>
    obj.b = 1
    obj.a = 2
    expect(canonicalStringify(obj)).toBe('{"a":2,"b":1}')
  })
})

describe('sha256Hex / canonicalDigest', () => {
  it('produces the standard SHA-256 hex digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    const expected = createHash('sha256').update('{"a":null}', 'utf8').digest('hex')
    expect(canonicalDigest({ a: null })).toBe(expected)
  })

  it('is stable across calls for equivalent values', () => {
    const value = { z: [3, 2, 1], a: { nested: 'x' } }
    expect(canonicalDigest(value)).toBe(canonicalDigest({ a: { nested: 'x' }, z: [3, 2, 1] }))
  })
})
