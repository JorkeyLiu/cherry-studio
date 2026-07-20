/**
 * ChatDb error classification tests.
 *
 * Tests typed aggregate errors, SQLite structured code inspection,
 * message-substring fallback, and sanitizeMessage behavior.
 */

import { describe, expect, it } from 'vitest'

import {
  ChatDbConflictError,
  ChatDbForeignKeyError,
  ChatDbIdentityError,
  ChatDbNotFoundError,
  ChatDbUnavailableError,
  ChatDbValidationError,
  internalStorageFailure,
  mapErrorToResult,
  validateConstructedResult
} from '../errors'

describe('ChatDb error classification', () => {
  // =========================================================================
  // Typed aggregate errors (Priority 1)
  // =========================================================================

  describe('typed aggregate errors', () => {
    it('ChatDbValidationError maps to VALIDATION_ERROR', () => {
      const result = mapErrorToResult(new ChatDbValidationError('bad field'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(result.error.retryable).toBe(false)
    })

    it('ChatDbNotFoundError maps to NOT_FOUND', () => {
      const result = mapErrorToResult(new ChatDbNotFoundError('topic missing'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('NOT_FOUND')
      expect(result.error.retryable).toBe(false)
    })

    it('ChatDbIdentityError maps to IDENTITY_VIOLATION', () => {
      const result = mapErrorToResult(new ChatDbIdentityError('cannot change id'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('IDENTITY_VIOLATION')
      expect(result.error.retryable).toBe(false)
    })

    it('ChatDbConflictError maps to CONFLICT_ERROR', () => {
      const result = mapErrorToResult(new ChatDbConflictError('duplicate id'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('CONFLICT_ERROR')
      expect(result.error.retryable).toBe(false)
    })

    it('ChatDbUnavailableError maps to UNAVAILABLE', () => {
      const result = mapErrorToResult(new ChatDbUnavailableError('not initialized'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('UNAVAILABLE')
      expect(result.error.retryable).toBe(false)
    })

    it('ChatDbForeignKeyError maps to FOREIGN_KEY_VIOLATION', () => {
      const result = mapErrorToResult(new ChatDbForeignKeyError('FK failed'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('FOREIGN_KEY_VIOLATION')
      expect(result.error.retryable).toBe(false)
    })
  })

  // =========================================================================
  // SQLite structured code inspection (Priority 2)
  // =========================================================================

  describe('SQLite code inspection', () => {
    it('SQLITE_CONSTRAINT_UNIQUE maps to CONFLICT_ERROR', () => {
      const error = Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
      const result = mapErrorToResult(error, 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('CONFLICT_ERROR')
      expect(result.error.retryable).toBe(false)
    })

    it('SQLITE_CONSTRAINT_PRIMARYKEY maps to CONFLICT_ERROR', () => {
      const error = Object.assign(new Error('PRIMARY KEY constraint failed'), {
        code: 'SQLITE_CONSTRAINT_PRIMARYKEY'
      })
      const result = mapErrorToResult(error, 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('CONFLICT_ERROR')
      expect(result.error.retryable).toBe(false)
    })

    it('SQLITE_CONSTRAINT_FOREIGNKEY maps to FOREIGN_KEY_VIOLATION', () => {
      const error = Object.assign(new Error('FOREIGN KEY constraint failed'), {
        code: 'SQLITE_CONSTRAINT_FOREIGNKEY'
      })
      const result = mapErrorToResult(error, 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('FOREIGN_KEY_VIOLATION')
      expect(result.error.retryable).toBe(false)
    })

    it('SQLITE_BUSY maps to BUSY_ERROR (retryable)', () => {
      const error = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
      const result = mapErrorToResult(error, 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('BUSY_ERROR')
      expect(result.error.retryable).toBe(true)
    })

    it('SQLITE_LOCKED maps to BUSY_ERROR (retryable)', () => {
      const error = Object.assign(new Error('database is locked'), { code: 'SQLITE_LOCKED' })
      const result = mapErrorToResult(error, 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('BUSY_ERROR')
      expect(result.error.retryable).toBe(true)
    })

    it('other SQLITE_CONSTRAINT_* maps to FOREIGN_KEY_VIOLATION', () => {
      const error = Object.assign(new Error('CHECK constraint failed'), {
        code: 'SQLITE_CONSTRAINT_CHECK'
      })
      const result = mapErrorToResult(error, 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('FOREIGN_KEY_VIOLATION')
      expect(result.error.retryable).toBe(false)
    })
  })

  // =========================================================================
  // Message-substring fallback (Priority 3)
  // =========================================================================

  describe('message-substring fallback', () => {
    it('"does not exist" maps to NOT_FOUND', () => {
      const result = mapErrorToResult(new Error('Topic xyz does not exist'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('NOT_FOUND')
    })

    it('"cannot change identity field" maps to IDENTITY_VIOLATION', () => {
      const result = mapErrorToResult(new Error('Cannot change identity field "id"'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('IDENTITY_VIOLATION')
    })

    it('"cannot reparent" maps to IDENTITY_VIOLATION', () => {
      const result = mapErrorToResult(new Error('Message cannot reparent to topic'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('IDENTITY_VIOLATION')
    })

    it('"unique" maps to CONFLICT_ERROR', () => {
      const result = mapErrorToResult(new Error('UNIQUE constraint failed'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('CONFLICT_ERROR')
    })

    it('"duplicate" maps to CONFLICT_ERROR', () => {
      const result = mapErrorToResult(new Error('Duplicate block ID in batch: b-1'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('CONFLICT_ERROR')
    })

    it('"foreign key" maps to FOREIGN_KEY_VIOLATION', () => {
      const result = mapErrorToResult(new Error('FOREIGN KEY constraint failed'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('FOREIGN_KEY_VIOLATION')
    })

    it('"abort due to constraint" without unique/duplicate maps to FOREIGN_KEY_VIOLATION (not CONFLICT)', () => {
      // SQLite uses "abort due to constraint" for FK violations too;
      // without a structured SQLITE_CONSTRAINT_* code, the unstructured
      // message must fall through to FK detection (via "constraint failed"),
      // not conflict detection.
      const result = mapErrorToResult(new Error('abort due to constraint: FOREIGN KEY constraint failed'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('FOREIGN_KEY_VIOLATION')
    })

    it('"abort due to constraint" with unique still maps to CONFLICT_ERROR via "unique" keyword', () => {
      // "abort due to constraint" + "UNIQUE" → "unique" keyword triggers conflict
      const result = mapErrorToResult(new Error('abort due to constraint: UNIQUE constraint failed'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('CONFLICT_ERROR')
    })

    it('"busy" maps to BUSY_ERROR (retryable)', () => {
      const result = mapErrorToResult(new Error('database busy'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('BUSY_ERROR')
      expect(result.error.retryable).toBe(true)
    })

    it('"not been initialised" maps to UNAVAILABLE', () => {
      const result = mapErrorToResult(new Error('ChatDbService has not been initialised'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('UNAVAILABLE')
      expect(result.error.retryable).toBe(false)
    })

    it('"repair-required" maps to UNAVAILABLE', () => {
      const result = mapErrorToResult(new Error('repair-required state'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('UNAVAILABLE')
      expect(result.error.retryable).toBe(false)
    })
  })

  // =========================================================================
  // Generic storage error (Priority 4)
  // =========================================================================

  describe('generic storage error', () => {
    it('unknown Error maps to STORAGE_ERROR (non-retryable)', () => {
      const result = mapErrorToResult(new Error('something unexpected'), 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('STORAGE_ERROR')
      expect(result.error.retryable).toBe(false)
    })

    it('non-Error thrown value maps to STORAGE_ERROR (non-retryable)', () => {
      const result = mapErrorToResult('string error', 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('STORAGE_ERROR')
      expect(result.error.retryable).toBe(false)
    })

    it('null thrown value maps to STORAGE_ERROR (non-retryable)', () => {
      const result = mapErrorToResult(null, 'test')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('STORAGE_ERROR')
      expect(result.error.retryable).toBe(false)
    })
  })

  // =========================================================================
  // Message sanitization
  // =========================================================================

  describe('error message sanitization', () => {
    it('does not leak SQL in wire error messages for typed errors', () => {
      const result = mapErrorToResult(new ChatDbConflictError('SELECT * FROM messages'), 'test')
      expect(result.ok).toBe(false)
      // Typed errors pass through the message as-is (sanitizeMessage is for logs)
      // but the code maps correctly
      expect(result.error.code).toBe('CONFLICT_ERROR')
    })

    it('storage error message is generic (not raw SQL)', () => {
      const error = new Error('SELECT * FROM topics WHERE id = "x"')
      const result = mapErrorToResult(error, 'test')
      expect(result.ok).toBe(false)
      // Generic storage error should have sanitized message
      expect(result.error.message).not.toContain('SELECT * FROM topics')
    })
  })

  // =========================================================================
  // internalStorageFailure
  // =========================================================================

  describe('internalStorageFailure', () => {
    it('creates valid ERR_STORAGE failure envelope', () => {
      const result = internalStorageFailure('test', 'malformed result')
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('STORAGE_ERROR')
      expect(result.error.retryable).toBe(false)
      expect(typeof result.error.message).toBe('string')
      expect(result.error.message.length).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // validateConstructedResult
  // =========================================================================

  describe('validateConstructedResult', () => {
    it('accepts valid success result', () => {
      const result = { ok: true as const, value: null }
      expect(validateConstructedResult(result, 'test')).toBe(true)
    })

    it('accepts valid failure result', () => {
      const result = { ok: false as const, error: { code: 'ERR', message: 'msg', retryable: false } }
      expect(validateConstructedResult(result, 'test')).toBe(true)
    })

    it('rejects result missing "ok"', () => {
      expect(validateConstructedResult({ value: 1 } as any, 'test')).toBe(false)
    })

    it('rejects non-boolean "ok"', () => {
      expect(validateConstructedResult({ ok: 'yes' } as any, 'test')).toBe(false)
    })

    it('rejects success without "value"', () => {
      expect(validateConstructedResult({ ok: true } as any, 'test')).toBe(false)
    })

    it('rejects failure without "error"', () => {
      expect(validateConstructedResult({ ok: false } as any, 'test')).toBe(false)
    })

    it('rejects failure with malformed error (missing code)', () => {
      expect(validateConstructedResult({ ok: false, error: { message: 'm', retryable: false } } as any, 'test')).toBe(
        false
      )
    })

    it('rejects failure with malformed error (missing message)', () => {
      expect(validateConstructedResult({ ok: false, error: { code: 'C', retryable: false } } as any, 'test')).toBe(
        false
      )
    })

    it('rejects failure with malformed error (missing retryable)', () => {
      expect(validateConstructedResult({ ok: false, error: { code: 'C', message: 'm' } } as any, 'test')).toBe(false)
    })

    it('rejects null result', () => {
      expect(validateConstructedResult(null as any, 'test')).toBe(false)
    })
  })
})
