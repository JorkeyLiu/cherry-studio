import { describe, expect, it } from 'vitest'

import {
  BLOCK_JSON_PROFILE,
  createProfileBytes,
  fail,
  isFailure,
  isSuccess,
  MAX_ARRAY_LENGTH,
  MAX_BLOCK_AGGREGATE_UTF8_BYTES,
  MAX_BLOCK_ROW_UTF8_BYTES,
  MAX_BLOCK_STRING_UTF8_BYTES,
  MAX_DEPTH,
  MAX_STRING_LENGTH,
  ok,
  utf8ByteLength,
  validateIdField,
  validateIndex,
  validateJsonObject,
  validateJsonObjectArray,
  validateJsonObjectArrayBlock,
  validateJsonObjectBlock,
  validateJsonValue,
  validateMessageIdField,
  validateNonEmptyString,
  validateRequest,
  validateResultEnvelope,
  validateStringArray,
  ValidationError
} from '../index'

// ===========================================================================
// validateJsonValue
// ===========================================================================

describe('validateJsonValue', () => {
  describe('accepts valid JSON primitives', () => {
    it('accepts null', () => {
      expect(() => validateJsonValue(null)).not.toThrow()
    })

    it('accepts booleans', () => {
      expect(() => validateJsonValue(true)).not.toThrow()
      expect(() => validateJsonValue(false)).not.toThrow()
    })

    it('accepts strings', () => {
      expect(() => validateJsonValue('hello')).not.toThrow()
      expect(() => validateJsonValue('')).not.toThrow()
    })

    it('accepts finite numbers', () => {
      expect(() => validateJsonValue(0)).not.toThrow()
      expect(() => validateJsonValue(-1)).not.toThrow()
      expect(() => validateJsonValue(3.14)).not.toThrow()
      expect(() => validateJsonValue(Number.MAX_SAFE_INTEGER)).not.toThrow()
    })
  })

  describe('rejects invalid primitives', () => {
    it('rejects undefined', () => {
      expect(() => validateJsonValue(undefined)).toThrow(ValidationError)
    })

    it('rejects NaN', () => {
      expect(() => validateJsonValue(NaN)).toThrow(ValidationError)
    })

    it('rejects Infinity', () => {
      expect(() => validateJsonValue(Infinity)).toThrow(ValidationError)
    })

    it('rejects -Infinity', () => {
      expect(() => validateJsonValue(-Infinity)).toThrow(ValidationError)
    })

    it('rejects bigint', () => {
      expect(() => validateJsonValue(BigInt(42))).toThrow(ValidationError)
    })

    it('rejects symbol', () => {
      expect(() => validateJsonValue(Symbol('test'))).toThrow(ValidationError)
    })

    it('rejects function', () => {
      expect(() => validateJsonValue(() => {})).toThrow(ValidationError)
    })
  })

  describe('rejects non-JSON object types', () => {
    it('rejects Date', () => {
      expect(() => validateJsonValue(new Date())).toThrow(ValidationError)
    })

    it('rejects Map', () => {
      expect(() => validateJsonValue(new Map())).toThrow(ValidationError)
    })

    it('rejects Set', () => {
      expect(() => validateJsonValue(new Set())).toThrow(ValidationError)
    })

    it('rejects RegExp', () => {
      expect(() => validateJsonValue(/test/)).toThrow(ValidationError)
    })

    it('rejects Error', () => {
      expect(() => validateJsonValue(new Error('test'))).toThrow(ValidationError)
    })

    it('rejects ArrayBuffer', () => {
      expect(() => validateJsonValue(new ArrayBuffer(8))).toThrow(ValidationError)
    })

    it('rejects Uint8Array', () => {
      expect(() => validateJsonValue(new Uint8Array(4))).toThrow(ValidationError)
    })

    it('rejects Buffer', () => {
      expect(() => validateJsonValue(Buffer.from('hello'))).toThrow(ValidationError)
    })
  })

  describe('accepts valid composites', () => {
    it('accepts empty object', () => {
      expect(() => validateJsonValue({})).not.toThrow()
    })

    it('accepts empty array', () => {
      expect(() => validateJsonValue([])).not.toThrow()
    })

    it('accepts nested object', () => {
      expect(() => validateJsonValue({ a: { b: { c: [1, 'two', null, true] } } })).not.toThrow()
    })

    it('accepts array of objects', () => {
      expect(() => validateJsonValue([{ id: '1', name: 'test' }, { id: '2' }])).not.toThrow()
    })
  })

  describe('rejects sparse arrays', () => {
    it('rejects sparse array', () => {
      // oxlint-disable-next-line no-sparse-arrays
      const sparse = [1, , 3]
      expect(() => validateJsonValue(sparse)).toThrow(ValidationError)
    })
  })

  describe('rejects non-plain objects', () => {
    it('rejects class instance', () => {
      class Foo {
        bar = 1
      }
      expect(() => validateJsonValue(new Foo())).toThrow(ValidationError)
    })

    it('accepts Object.create(null) prototype-less objects', () => {
      const obj = Object.create(null) as Record<string, unknown>
      obj.key = 'value'
      expect(() => validateJsonValue(obj)).not.toThrow()
    })
  })

  describe('depth limit', () => {
    it('rejects nesting beyond MAX_DEPTH', () => {
      let deep: unknown = 'leaf'
      for (let i = 0; i <= MAX_DEPTH + 1; i++) {
        deep = { child: deep }
      }
      expect(() => validateJsonValue(deep)).toThrow(ValidationError)
    })

    it('accepts nesting at exactly MAX_DEPTH', () => {
      let deep: unknown = 'leaf'
      for (let i = 0; i < MAX_DEPTH; i++) {
        deep = { child: deep }
      }
      expect(() => validateJsonValue(deep)).not.toThrow()
    })
  })
})

// ===========================================================================
// validateRequest
// ===========================================================================

describe('validateRequest', () => {
  it('accepts a plain object', () => {
    expect(() => validateRequest({ a: 1 })).not.toThrow()
  })

  it('rejects null', () => {
    expect(() => validateRequest(null)).toThrow(ValidationError)
  })

  it('rejects array', () => {
    expect(() => validateRequest([])).toThrow(ValidationError)
  })

  it('rejects primitive', () => {
    expect(() => validateRequest('hello')).toThrow(ValidationError)
  })

  describe('allowedKeys', () => {
    const allowed = new Set(['topicId', 'message'])

    it('accepts known keys', () => {
      expect(() => validateRequest({ topicId: 't1', message: { id: 'm1' } }, allowed)).not.toThrow()
    })

    it('rejects unknown keys', () => {
      expect(() => validateRequest({ topicId: 't1', unknown: true }, allowed)).toThrow(ValidationError)
    })
  })
})

// ===========================================================================
// validateJsonObject
// ===========================================================================

describe('validateJsonObject', () => {
  it('accepts a plain object', () => {
    expect(() => validateJsonObject({ id: '1' })).not.toThrow()
  })

  it('rejects null', () => {
    expect(() => validateJsonObject(null)).toThrow(ValidationError)
  })

  it('rejects array', () => {
    expect(() => validateJsonObject([])).toThrow(ValidationError)
  })
})

// ===========================================================================
// validateNonEmptyString
// ===========================================================================

describe('validateNonEmptyString', () => {
  it('accepts non-empty string', () => {
    expect(() => validateNonEmptyString('hello', 'test')).not.toThrow()
  })

  it('rejects empty string', () => {
    expect(() => validateNonEmptyString('', 'test')).toThrow(ValidationError)
  })

  it('rejects non-string', () => {
    expect(() => validateNonEmptyString(42, 'test')).toThrow(ValidationError)
  })
})

// ===========================================================================
// validateStringArray
// ===========================================================================

describe('validateStringArray', () => {
  it('accepts array of non-empty strings', () => {
    expect(() => validateStringArray(['a', 'b'], 'test')).not.toThrow()
  })

  it('accepts empty array', () => {
    expect(() => validateStringArray([], 'test')).not.toThrow()
  })

  it('rejects non-array', () => {
    expect(() => validateStringArray('not-array', 'test')).toThrow(ValidationError)
  })

  it('rejects array with empty string', () => {
    expect(() => validateStringArray(['a', ''], 'test')).toThrow(ValidationError)
  })

  it('rejects array with non-string', () => {
    expect(() => validateStringArray(['a', 42], 'test')).toThrow(ValidationError)
  })
})

// ===========================================================================
// validateIndex
// ===========================================================================

describe('validateIndex', () => {
  it('accepts zero', () => {
    expect(() => validateIndex(0, 'test')).not.toThrow()
  })

  it('accepts positive integer', () => {
    expect(() => validateIndex(5, 'test')).not.toThrow()
  })

  it('rejects negative', () => {
    expect(() => validateIndex(-1, 'test')).toThrow(ValidationError)
  })

  it('rejects float', () => {
    expect(() => validateIndex(1.5, 'test')).toThrow(ValidationError)
  })

  it('rejects NaN', () => {
    expect(() => validateIndex(NaN, 'test')).toThrow(ValidationError)
  })

  it('rejects non-number', () => {
    expect(() => validateIndex('1', 'test')).toThrow(ValidationError)
  })
})

// ===========================================================================
// validateIdField
// ===========================================================================

describe('validateIdField', () => {
  it('accepts object with string id', () => {
    expect(() => validateIdField({ id: 'abc' }, 'test')).not.toThrow()
  })

  it('rejects missing id', () => {
    expect(() => validateIdField({ name: 'foo' }, 'test')).toThrow(ValidationError)
  })

  it('rejects empty id', () => {
    expect(() => validateIdField({ id: '' }, 'test')).toThrow(ValidationError)
  })

  it('rejects non-string id', () => {
    expect(() => validateIdField({ id: 42 }, 'test')).toThrow(ValidationError)
  })
})

// ===========================================================================
// Result envelope
// ===========================================================================

describe('ChatDbResult', () => {
  it('ok() creates a success result', () => {
    const result = ok(42)
    expect(result.ok).toBe(true)
    expect(result.value).toBe(42)
  })

  it('ok(null) creates a void success', () => {
    const result = ok(null)
    expect(result.ok).toBe(true)
    expect(result.value).toBe(null)
  })

  it('fail() creates a failure result', () => {
    const result = fail('TEST_ERROR', 'Something went wrong', true)
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('TEST_ERROR')
    expect(result.error.message).toBe('Something went wrong')
    expect(result.error.retryable).toBe(true)
  })

  it('fail() with details', () => {
    const result = fail('ERR', 'msg', false, { key: 'value' })
    expect(result.error.details).toEqual({ key: 'value' })
  })

  it('fail() without details omits the field', () => {
    const result = fail('ERR', 'msg')
    expect(result.error.details).toBeUndefined()
  })

  it('isSuccess() type guard', () => {
    const result = ok('hello')
    expect(isSuccess(result)).toBe(true)
    expect(isFailure(result)).toBe(false)
  })

  it('isFailure() type guard', () => {
    const result = fail('ERR', 'msg')
    expect(isFailure(result)).toBe(true)
    expect(isSuccess(result)).toBe(false)
  })
})

// ===========================================================================
// validateJsonObjectArray
// ===========================================================================

describe('validateJsonObjectArray', () => {
  it('accepts valid object array', () => {
    const arr = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' }
    ]
    expect(() => validateJsonObjectArray(arr, 'test')).not.toThrow()
    expect(validateJsonObjectArray(arr, 'test')).toBe(arr)
  })

  it('accepts empty array', () => {
    expect(() => validateJsonObjectArray([], 'test')).not.toThrow()
    expect(validateJsonObjectArray([], 'test')).toEqual([])
  })

  it('rejects non-array', () => {
    expect(() => validateJsonObjectArray('not-array', 'test')).toThrow(ValidationError)
    expect(() => validateJsonObjectArray(42, 'test')).toThrow(ValidationError)
    expect(() => validateJsonObjectArray(null, 'test')).toThrow(ValidationError)
    expect(() => validateJsonObjectArray(undefined, 'test')).toThrow(ValidationError)
    expect(() => validateJsonObjectArray({}, 'test')).toThrow(ValidationError)
  })

  it('rejects non-object element', () => {
    expect(() => validateJsonObjectArray(['string'], 'test')).toThrow(ValidationError)
    expect(() => validateJsonObjectArray([42], 'test')).toThrow(ValidationError)
    expect(() => validateJsonObjectArray([null], 'test')).toThrow(ValidationError)
    expect(() => validateJsonObjectArray([true], 'test')).toThrow(ValidationError)
    expect(() => validateJsonObjectArray([[]], 'test')).toThrow(ValidationError)
  })

  it('rejects array with mixed valid and invalid elements', () => {
    expect(() => validateJsonObjectArray([{ id: '1' }, 'bad', { id: '2' }], 'test')).toThrow(ValidationError)
  })

  it('returns the typed array on success', () => {
    const arr = [{ a: 1 }, { b: 2 }]
    const result = validateJsonObjectArray(arr, 'test')
    expect(result).toEqual([{ a: 1 }, { b: 2 }])
  })
})

// ===========================================================================
// validateMessageIdField
// ===========================================================================

describe('validateMessageIdField', () => {
  it('accepts object with string messageId', () => {
    expect(() => validateMessageIdField({ id: 'a', messageId: 'b' }, 'test')).not.toThrow()
  })

  it('rejects missing messageId', () => {
    expect(() => validateMessageIdField({ id: 'a' }, 'test')).toThrow(ValidationError)
  })

  it('rejects empty messageId', () => {
    expect(() => validateMessageIdField({ id: 'a', messageId: '' }, 'test')).toThrow(ValidationError)
  })

  it('rejects non-string messageId', () => {
    expect(() => validateMessageIdField({ id: 'a', messageId: 42 }, 'test')).toThrow(ValidationError)
    expect(() => validateMessageIdField({ id: 'a', messageId: null }, 'test')).toThrow(ValidationError)
  })
})

// ===========================================================================
// validateResultEnvelope
// ===========================================================================

describe('validateResultEnvelope', () => {
  // ---- success envelope ----

  describe('success envelope', () => {
    it('accepts valid success with value', () => {
      expect(() => validateResultEnvelope({ ok: true, value: { data: 'test' } }, 'test-cmd')).not.toThrow()
    })

    it('accepts success with null value', () => {
      expect(() => validateResultEnvelope({ ok: true, value: null }, 'test-cmd')).not.toThrow()
    })

    it('accepts success with primitive values', () => {
      expect(() => validateResultEnvelope({ ok: true, value: 42 }, 'test-cmd')).not.toThrow()
      expect(() => validateResultEnvelope({ ok: true, value: 'str' }, 'test-cmd')).not.toThrow()
      expect(() => validateResultEnvelope({ ok: true, value: true }, 'test-cmd')).not.toThrow()
    })

    it('accepts success with array value', () => {
      expect(() => validateResultEnvelope({ ok: true, value: [1, 2, 3] }, 'test-cmd')).not.toThrow()
    })

    it('rejects success with unknown key', () => {
      expect(() => validateResultEnvelope({ ok: true, value: null, extra: true }, 'test-cmd')).toThrow(ValidationError)
    })

    it('rejects success without value', () => {
      expect(() => validateResultEnvelope({ ok: true }, 'test-cmd')).toThrow(ValidationError)
    })

    it('rejects success with error field present', () => {
      expect(() =>
        validateResultEnvelope(
          { ok: true, value: null, error: { code: 'X', message: 'm', retryable: false } },
          'test-cmd'
        )
      ).toThrow(ValidationError)
    })

    it('rejects success with non-JSON value (Date)', () => {
      expect(() => validateResultEnvelope({ ok: true, value: new Date() }, 'test-cmd')).toThrow(ValidationError)
    })
  })

  // ---- failure envelope ----

  describe('failure envelope', () => {
    it('accepts valid failure with error', () => {
      expect(() =>
        validateResultEnvelope({ ok: false, error: { code: 'ERR', message: 'failed', retryable: true } }, 'test-cmd')
      ).not.toThrow()
    })

    it('accepts failure with details', () => {
      expect(() =>
        validateResultEnvelope(
          { ok: false, error: { code: 'ERR', message: 'failed', retryable: false, details: { key: 'val' } } },
          'test-cmd'
        )
      ).not.toThrow()
    })

    it('accepts failure without details', () => {
      expect(() =>
        validateResultEnvelope({ ok: false, error: { code: 'ERR', message: 'failed', retryable: false } }, 'test-cmd')
      ).not.toThrow()
    })

    it('rejects failure with unknown key', () => {
      expect(() =>
        validateResultEnvelope(
          { ok: false, error: { code: 'ERR', message: 'm', retryable: false }, extra: true },
          'test-cmd'
        )
      ).toThrow(ValidationError)
    })

    it('rejects failure without error', () => {
      expect(() => validateResultEnvelope({ ok: false }, 'test-cmd')).toThrow(ValidationError)
    })

    it('rejects failure with value field', () => {
      expect(() =>
        validateResultEnvelope(
          { ok: false, value: 'bad', error: { code: 'ERR', message: 'm', retryable: false } },
          'test-cmd'
        )
      ).toThrow(ValidationError)
    })
  })

  // ---- error structure ----

  describe('error structure', () => {
    it('rejects error with empty code', () => {
      expect(() =>
        validateResultEnvelope({ ok: false, error: { code: '', message: 'm', retryable: false } }, 'test-cmd')
      ).toThrow(ValidationError)
    })

    it('rejects error with non-string code', () => {
      expect(() =>
        validateResultEnvelope({ ok: false, error: { code: 42, message: 'm', retryable: false } }, 'test-cmd')
      ).toThrow(ValidationError)
    })

    it('rejects error with empty message', () => {
      expect(() =>
        validateResultEnvelope({ ok: false, error: { code: 'ERR', message: '', retryable: false } }, 'test-cmd')
      ).toThrow(ValidationError)
    })

    it('rejects error with non-string message', () => {
      expect(() =>
        validateResultEnvelope({ ok: false, error: { code: 'ERR', message: 123, retryable: false } }, 'test-cmd')
      ).toThrow(ValidationError)
    })

    it('rejects error with non-boolean retryable', () => {
      expect(() =>
        validateResultEnvelope({ ok: false, error: { code: 'ERR', message: 'm', retryable: 'yes' } }, 'test-cmd')
      ).toThrow(ValidationError)
    })

    it('rejects error with missing retryable', () => {
      expect(() => validateResultEnvelope({ ok: false, error: { code: 'ERR', message: 'm' } }, 'test-cmd')).toThrow(
        ValidationError
      )
    })

    it('rejects error with unknown key', () => {
      expect(() =>
        validateResultEnvelope(
          { ok: false, error: { code: 'ERR', message: 'm', retryable: false, extra: true } },
          'test-cmd'
        )
      ).toThrow(ValidationError)
    })

    it('rejects error with non-object details', () => {
      expect(() =>
        validateResultEnvelope(
          { ok: false, error: { code: 'ERR', message: 'm', retryable: false, details: 'bad' } },
          'test-cmd'
        )
      ).toThrow(ValidationError)
    })

    it('rejects non-object error', () => {
      expect(() => validateResultEnvelope({ ok: false, error: 'bad' }, 'test-cmd')).toThrow(ValidationError)
    })

    it('rejects null error', () => {
      expect(() => validateResultEnvelope({ ok: false, error: null }, 'test-cmd')).toThrow(ValidationError)
    })
  })

  // ---- general envelope structure ----

  describe('general structure', () => {
    it('rejects non-object result', () => {
      expect(() => validateResultEnvelope('bad', 'test-cmd')).toThrow(ValidationError)
      expect(() => validateResultEnvelope(null, 'test-cmd')).toThrow(ValidationError)
      expect(() => validateResultEnvelope([], 'test-cmd')).toThrow(ValidationError)
      expect(() => validateResultEnvelope(42, 'test-cmd')).toThrow(ValidationError)
    })

    it('rejects result without ok field', () => {
      expect(() => validateResultEnvelope({ value: 'x' }, 'test-cmd')).toThrow(ValidationError)
    })

    it('rejects non-boolean ok', () => {
      expect(() => validateResultEnvelope({ ok: 1, value: 'x' }, 'test-cmd')).toThrow(ValidationError)
      expect(() => validateResultEnvelope({ ok: 'true', value: 'x' }, 'test-cmd')).toThrow(ValidationError)
    })
  })
})

// ===========================================================================
// utf8ByteLength (LOCK-LB-2)
// ===========================================================================

describe('utf8ByteLength', () => {
  it('counts ASCII as one byte per char', () => {
    expect(utf8ByteLength('')).toBe(0)
    expect(utf8ByteLength('abc')).toBe(3)
  })

  it('counts multibyte characters deterministically', () => {
    expect(utf8ByteLength('文')).toBe(3) // U+6587 → 3 UTF-8 bytes
    expect(utf8ByteLength('😀')).toBe(4) // surrogate pair → 4 UTF-8 bytes
    expect(utf8ByteLength('a文😀')).toBe(1 + 3 + 4)
  })
})

// ===========================================================================
// Block JSON profile (LOCK-LB-1/2/4)
// ===========================================================================

describe('block JSON profile bounds', () => {
  it('exposes the exact locked caps', () => {
    expect(MAX_BLOCK_STRING_UTF8_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_BLOCK_ROW_UTF8_BYTES).toBe(16 * 1024 * 1024)
    expect(MAX_BLOCK_AGGREGATE_UTF8_BYTES).toBe(64 * 1024 * 1024)
    expect(BLOCK_JSON_PROFILE).toEqual({
      maxStringUtf8Bytes: MAX_BLOCK_STRING_UTF8_BYTES,
      maxRowUtf8Bytes: MAX_BLOCK_ROW_UTF8_BYTES,
      maxAggregateUtf8Bytes: MAX_BLOCK_AGGREGATE_UTF8_BYTES
    })
  })

  it('generic validateJsonValue/validateJsonObject still reject a >1 MiB string (LOCK-LB-1)', () => {
    const big = 'x'.repeat(MAX_STRING_LENGTH + 1)
    expect(() => validateJsonValue(big)).toThrow(ValidationError)
    expect(() => validateJsonObject({ id: 'b1', content: big })).toThrow(ValidationError)
  })

  it('generic validateJsonObjectArray still rejects a >1 MiB string element (LOCK-LB-1)', () => {
    const big = 'x'.repeat(MAX_STRING_LENGTH + 1)
    expect(() => validateJsonObjectArray([{ content: big }], 'blocks')).toThrow(ValidationError)
  })

  it('block profile accepts a 2–4 MiB string', () => {
    const bytes = createProfileBytes()
    const big = 'x'.repeat(3 * 1024 * 1024) // 3 MiB UTF-8
    expect(() =>
      validateJsonObjectBlock({ id: 'b1', content: big }, 'blocks[0]', BLOCK_JSON_PROFILE, bytes)
    ).not.toThrow()
  })

  it('block profile counts UTF-8 BYTES, not code units (LOCK-LB-2)', () => {
    // '😀' is 4 UTF-8 bytes per 2 UTF-16 code units. 700k chars → 1.4M code
    // units (> generic 1 MiB) but only 2.8M UTF-8 bytes (< 8 MiB profile).
    const multibyte = '😀'.repeat(700_000)
    expect(multibyte.length).toBeGreaterThan(MAX_STRING_LENGTH)
    expect(utf8ByteLength(multibyte)).toBe(700_000 * 4)
    // Generic rejects on code units…
    expect(() => validateJsonValue(multibyte)).toThrow(ValidationError)
    // …but the block profile accepts on UTF-8 bytes.
    const bytes = createProfileBytes()
    expect(() =>
      validateJsonObjectBlock({ id: 'b1', content: multibyte }, 'blocks[0]', BLOCK_JSON_PROFILE, bytes)
    ).not.toThrow()
  })

  it('block profile rejects a string above 8 MiB UTF-8', () => {
    const bytes = createProfileBytes()
    const tooBig = 'x'.repeat(8 * 1024 * 1024 + 1)
    expect(() =>
      validateJsonObjectBlock({ id: 'b1', content: tooBig }, 'blocks[0]', BLOCK_JSON_PROFILE, bytes)
    ).toThrow(/UTF-8 bytes exceeds maximum/)
  })

  it('block profile accepts a row at exactly the 16 MiB cumulative cap (LOCK-LB-1)', () => {
    const bytes = createProfileBytes()
    // Two 8 MiB − 1 byte strings + 2 one-byte keys = exactly 16 MiB.
    const row = { a: 'x'.repeat(8 * 1024 * 1024 - 1), b: 'y'.repeat(8 * 1024 * 1024 - 1) }
    expect(() => validateJsonObjectBlock(row, 'blocks[0]', BLOCK_JSON_PROFILE, bytes)).not.toThrow()
  })

  it('block profile rejects a row above 16 MiB cumulative (LOCK-LB-1)', () => {
    const bytes = createProfileBytes()
    // Two strings at the per-string cap (8 MiB each) + key bytes → the row
    // budget fires, not the per-string budget.
    const row = { a: 'x'.repeat(8 * 1024 * 1024), b: 'y'.repeat(8 * 1024 * 1024) }
    expect(() => validateJsonObjectBlock(row, 'blocks[0]', BLOCK_JSON_PROFILE, bytes)).toThrow(
      /Row cumulative UTF-8 size/
    )
  })

  it('block profile counts object-key UTF-8 bytes toward the row budget (LOCK-LB-2)', () => {
    // A ~17 MiB key alone exceeds the 16 MiB per-row cap (tiny value).
    const row: Record<string, unknown> = { ['k'.repeat(17 * 1024 * 1024)]: 'v' }
    const bytes = createProfileBytes()
    expect(() => validateJsonObjectBlock(row, 'blocks[0]', BLOCK_JSON_PROFILE, bytes)).toThrow(
      /Row cumulative UTF-8 size/
    )
  })

  it('block profile rejects an aggregate above 64 MiB across rows (LOCK-LB-1/4)', () => {
    // 11 rows × ~6 MiB ≈ 66 MiB aggregate > 64 MiB; every row is under the
    // per-string (8 MiB) and per-row (16 MiB) caps, so the aggregate fires.
    const bytes = createProfileBytes()
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, content: 'x'.repeat(6 * 1024 * 1024) }))
    expect(() => {
      for (let i = 0; i < rows.length; i++) {
        validateJsonObjectBlock(rows[i], `blocks[${i}]`, BLOCK_JSON_PROFILE, bytes)
      }
    }).toThrow(/Aggregate UTF-8 size/)
  })

  it('validateJsonObjectArrayBlock enforces the aggregate cap across the array', () => {
    // 11 × 6 MiB in one array → ~66 MiB aggregate > 64 MiB.
    const blocks = Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, content: 'x'.repeat(6 * 1024 * 1024) }))
    expect(() => validateJsonObjectArrayBlock(blocks, 'result.value.blocks', BLOCK_JSON_PROFILE)).toThrow(
      /Aggregate UTF-8 size/
    )
    // 10 × 6 MiB ≈ 60 MiB aggregate under the cap → accepted.
    const okBlocks = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, content: 'x'.repeat(6 * 1024 * 1024) }))
    expect(() => validateJsonObjectArrayBlock(okBlocks, 'result.value.blocks', BLOCK_JSON_PROFILE)).not.toThrow()
  })

  it('keeps the shared JSON-safety rejection set under the block profile (LOCK-LB-2)', () => {
    const bytes = createProfileBytes()
    expect(() => validateJsonObjectBlock(null as never, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock([] as never, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock(42 as never, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: undefined }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: BigInt(1) }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: Symbol('s') }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: () => {} }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: NaN }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: Infinity }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: new Date() }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: new Map() }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    expect(() => validateJsonObjectBlock({ a: new Set() }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    // Sparse array
    // oxlint-disable-next-line no-sparse-arrays
    expect(() => validateJsonObjectBlock({ a: [1, , 3] }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    // Cycle (bounded by depth)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => validateJsonObjectBlock(cyclic, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    // Depth beyond MAX_DEPTH
    let deep: unknown = 'leaf'
    for (let i = 0; i <= MAX_DEPTH + 1; i++) deep = { child: deep }
    expect(() => validateJsonObjectBlock(deep as never, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    // Non-plain object
    class Foo {
      bar = 1
    }
    expect(() => validateJsonObjectBlock(new Foo() as never, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(ValidationError)
    // TypedArray / Buffer-like
    expect(() => validateJsonObjectBlock({ a: new Uint8Array(4) }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(
      ValidationError
    )
  })

  it('keeps MAX_DEPTH and MAX_ARRAY_LENGTH under the block profile (LOCK-LB-1)', () => {
    const bytes = createProfileBytes()
    const bigArray = Array.from({ length: MAX_ARRAY_LENGTH }, (_, i) => i)
    expect(() => validateJsonObjectBlock({ a: bigArray }, 'x', BLOCK_JSON_PROFILE, bytes)).not.toThrow()
    const tooBigArray = Array.from({ length: MAX_ARRAY_LENGTH + 1 }, (_, i) => i)
    expect(() => validateJsonObjectBlock({ a: tooBigArray }, 'x', BLOCK_JSON_PROFILE, bytes)).toThrow(/Array length/)
  })

  it('validateJsonObjectBlock resets rowBytes per row while aggregateBytes persists (LOCK-LB-4)', () => {
    const bytes = createProfileBytes()
    // Row 1: 6 MiB string — row OK, aggregate ~6 MiB.
    validateJsonObjectBlock({ id: 'b1', content: 'x'.repeat(6 * 1024 * 1024) }, 'blocks[0]', BLOCK_JSON_PROFILE, bytes)
    // rowBytes holds the last row's total; aggregateBytes persists.
    expect(bytes.rowBytes).toBeGreaterThan(6 * 1024 * 1024 - 1024)
    const afterRow1 = bytes.aggregateBytes
    // Row 2: tiny object — rowBytes must RESET (not accumulate from row 1),
    // while aggregateBytes keeps growing.
    validateJsonObjectBlock({ id: 'b2' }, 'blocks[1]', BLOCK_JSON_PROFILE, bytes)
    expect(bytes.rowBytes).toBeLessThan(1024)
    expect(bytes.aggregateBytes).toBeGreaterThan(afterRow1)
  })

  it('validateJsonObjectArrayBlock rejects non-arrays', () => {
    expect(() => validateJsonObjectArrayBlock('nope', 'x', BLOCK_JSON_PROFILE)).toThrow(ValidationError)
    expect(() => validateJsonObjectArrayBlock(null, 'x', BLOCK_JSON_PROFILE)).toThrow(ValidationError)
    expect(() => validateJsonObjectArrayBlock({}, 'x', BLOCK_JSON_PROFILE)).toThrow(ValidationError)
  })
})

// ===========================================================================
// LOCK-LB-7: top-level array cardinality — length capped at MAX_ARRAY_LENGTH
// BEFORE element iteration for both array-of-object validators.
// ===========================================================================

describe('top-level array cardinality (LOCK-LB-7)', () => {
  it('validateJsonObjectArray rejects an array longer than MAX_ARRAY_LENGTH before iteration', () => {
    // Bounded dense construction: every slot shares ONE minimal object; the
    // length gate fires before any element is walked.
    const shared = { a: 1 }
    const oversized = new Array(MAX_ARRAY_LENGTH + 1).fill(shared)
    expect(() => validateJsonObjectArray(oversized, 'items')).toThrow(/Array length .* exceeds maximum/)
  })

  it('validateJsonObjectArray accepts an array at exactly MAX_ARRAY_LENGTH', () => {
    const shared = { a: 1 }
    const atCap = new Array(MAX_ARRAY_LENGTH).fill(shared)
    expect(() => validateJsonObjectArray(atCap, 'items')).not.toThrow()
  })

  it('validateJsonObjectArrayBlock rejects an array longer than MAX_ARRAY_LENGTH before iteration', () => {
    const shared = { id: 'b1' }
    const oversized = new Array(MAX_ARRAY_LENGTH + 1).fill(shared)
    expect(() => validateJsonObjectArrayBlock(oversized, 'blocks', BLOCK_JSON_PROFILE)).toThrow(
      /Array length .* exceeds maximum/
    )
  })

  it('validateJsonObjectArrayBlock accepts an array at exactly MAX_ARRAY_LENGTH', () => {
    const shared = { id: 'b1' }
    const atCap = new Array(MAX_ARRAY_LENGTH).fill(shared)
    expect(() => validateJsonObjectArrayBlock(atCap, 'blocks', BLOCK_JSON_PROFILE)).not.toThrow()
  })

  it('keeps sparse-array rejection for arrays within the length cap', () => {
    // A sparse top-level array under the cap is still rejected (holes read
    // as undefined → plain-object requirement) — the cap never widens the
    // exact rejection set.
    // oxlint-disable-next-line no-sparse-arrays
    expect(() => validateJsonObjectArray([{ a: 1 }, , { a: 3 }], 'items')).toThrow(ValidationError)
    // oxlint-disable-next-line no-sparse-arrays
    expect(() => validateJsonObjectArrayBlock([{ id: 'b1' }, , { id: 'b2' }], 'blocks', BLOCK_JSON_PROFILE)).toThrow(
      ValidationError
    )
  })
})
