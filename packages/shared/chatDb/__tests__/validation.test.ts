import { describe, expect, it } from 'vitest'

import {
  fail,
  isFailure,
  isSuccess,
  MAX_DEPTH,
  ok,
  validateIdField,
  validateIndex,
  validateJsonObject,
  validateJsonObjectArray,
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
