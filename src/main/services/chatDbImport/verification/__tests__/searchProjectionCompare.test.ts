/**
 * Exact search-projection comparator unit tests (LOCK-SP-2/3).
 *
 * The comparator must replicate SQLite's BINARY collation exactly (UTF-8
 * byte memcmp, shorter-first on a byte prefix) so the ordered merge never
 * miscompares, and must treat two rows as equal ONLY when both
 * (block_id, normalized_content) fields are byte-identical — the injective
 * length-prefixed key, preserving duplicate multiplicity and NUL bytes.
 */

import { describe, expect, it } from 'vitest'

import { compareProjectionRows, compareTextBinary } from '../searchProjectionCompare'

describe('compareTextBinary (SQLite BINARY collation equivalent)', () => {
  it('orders by UTF-8 bytes, not UTF-16 code units (supplementary plane)', () => {
    // SQLite BINARY: U+FFFD ("�", 0xEF 0xBF 0xBD) sorts BEFORE U+10000
    // ("𐀀", 0xF0 0x90 0x80 0x80) because 0xEF < 0xF0. JS string `<`
    // (UTF-16) would order them the opposite way (0xFFFD vs 0xD800).
    expect(compareTextBinary('\u{FFFD}', '\u{10000}')).toBeLessThan(0)
    expect(compareTextBinary('\u{10000}', '\u{FFFD}')).toBeGreaterThan(0)
    // High-surrogate-bearing text sorts between U+D7FF and U+E000 in
    // UTF-16, but after ALL BMP characters in UTF-8 byte order.
    expect(compareTextBinary('\u{10000}', '\u{E000}')).toBeGreaterThan(0)
  })

  it('breaks ties by byte length (a byte prefix sorts first)', () => {
    expect(compareTextBinary('', 'x')).toBeLessThan(0)
    expect(compareTextBinary('a', 'ab')).toBeLessThan(0)
    expect(compareTextBinary('ab', 'a')).toBeGreaterThan(0)
    expect(compareTextBinary('ab', 'ab')).toBe(0)
  })

  it('distinguishes NUL-bearing strings exactly', () => {
    expect(compareTextBinary('ab\x00c', 'ab\x00c')).toBe(0)
    expect(compareTextBinary('ab\x00', 'ab')).toBeGreaterThan(0)
    expect(compareTextBinary('ab', 'ab\x00')).toBeLessThan(0)
    expect(compareTextBinary('a\x00b', 'ab')).toBeLessThan(0) // 0x00 < 0x62
  })

  it('agrees with SQLite ORDER BY on a representative corpus', () => {
    // These values are asserted against the observed SQLite BINARY ordering
    // of the same strings (see the runtime probe). Note 'b-10' < 'b-2'
    // (byte 0x31 < 0x32) and 'a𐀀' < 'b-10' (0x61 < 0x62), while every
    // 0xED/0xEF/0xF0-leading character sorts after all 0x6x-leading text.
    const corpus = ['', 'a\u{10000}', 'b-10', 'b-2', '\u{D7FF}', '\u{FFFD}', '\u{10000}', '\u{1F600}']
    for (let i = 0; i < corpus.length - 1; i++) {
      for (let j = i + 1; j < corpus.length; j++) {
        expect(compareTextBinary(corpus[i], corpus[j])).toBeLessThan(0)
        expect(compareTextBinary(corpus[j], corpus[i])).toBeGreaterThan(0)
      }
    }
    expect(compareTextBinary('b-10', 'b-2')).toBeLessThan(0)
  })
})

describe('compareProjectionRows (injective length-prefixed key)', () => {
  it('compares block_id first, then normalized_content', () => {
    expect(
      compareProjectionRows({ block_id: 'a', normalized_content: 'z' }, { block_id: 'b', normalized_content: 'a' })
    ).toBeLessThan(0)
    expect(
      compareProjectionRows({ block_id: 'b', normalized_content: 'a' }, { block_id: 'a', normalized_content: 'z' })
    ).toBeGreaterThan(0)
    expect(
      compareProjectionRows({ block_id: 'a', normalized_content: 'a' }, { block_id: 'a', normalized_content: 'b' })
    ).toBeLessThan(0)
    expect(
      compareProjectionRows({ block_id: 'a', normalized_content: 'b' }, { block_id: 'a', normalized_content: 'a' })
    ).toBeGreaterThan(0)
  })

  it('is injective: no two distinct tuples compare equal', () => {
    // The classic unframed-concatenation collision ("ab"+"c" vs "a"+"bc").
    expect(
      compareProjectionRows({ block_id: 'ab', normalized_content: 'c' }, { block_id: 'a', normalized_content: 'bc' })
    ).not.toBe(0)
    // Empty-content framing ("abc"+"" vs "a"+"bc").
    expect(
      compareProjectionRows({ block_id: 'abc', normalized_content: '' }, { block_id: 'a', normalized_content: 'bc' })
    ).not.toBe(0)
    // NUL bytes are part of the key, not delimiters.
    expect(
      compareProjectionRows(
        { block_id: 'a', normalized_content: '\x00b' },
        { block_id: 'a\x00', normalized_content: 'b' }
      )
    ).not.toBe(0)
  })

  it('returns 0 iff both fields are byte-identical (duplicates preserved)', () => {
    expect(
      compareProjectionRows(
        { block_id: 'b-1', normalized_content: 'hello\x00world' },
        { block_id: 'b-1', normalized_content: 'hello\x00world' }
      )
    ).toBe(0)
    expect(
      compareProjectionRows(
        { block_id: 'b-1', normalized_content: 'hello\x00world' },
        { block_id: 'b-1', normalized_content: 'hello\x00world' }
      )
    ).toBe(0)
  })
})
