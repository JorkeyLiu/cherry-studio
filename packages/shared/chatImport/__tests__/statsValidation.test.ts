/**
 * ChatImport Phase 4.2 stats/result contract validation tests.
 *
 * Validates the explicit source-read and candidate-import stats types, the
 * candidate-ready result, and the versioned envelope wrapper:
 * - Exact field sets (missing OR extra keys rejected).
 * - Safe non-negative integer counts.
 * - elapsedMs non-negative finite (fractional allowed) constraint.
 * - Malformed / missing / extra fields.
 * - Envelope version behavior (backward rejection, no coercion) — LOCK-4211D.
 *
 * Pattern follows packages/shared/chatDb/__tests__/validation.test.ts.
 */

import { describe, expect, it } from 'vitest'

import type { CandidateImportStats, CandidateReadyResult, SourceReadStats } from '../types'
import {
  CHAT_IMPORT_WIRE_VERSION,
  isCandidateImportStats,
  isCandidateReadyResult,
  isSourceReadStats,
  validateCandidateImportStats,
  validateCandidateReadyResult,
  validateChatImportEnvelope,
  validateSourceReadStats
} from '../validation'

// ===========================================================================
// Fixtures
// ===========================================================================

const validSourceReadStats: SourceReadStats = {
  topicRecordCount: 10,
  blockRecordCount: 500,
  segmentRecordCount: 5,
  sourceFileRecordCount: 20
}

const validCandidateImportStats: CandidateImportStats = {
  topicCount: 10,
  messageCount: 100,
  blockCount: 500,
  segmentCount: 5,
  segmentMembershipCount: 12,
  fileReferenceCount: 20,
  pageCount: 4,
  elapsedMs: 1234.5
}

const validCandidateReadyResult: CandidateReadyResult = {
  sessionId: 'session-123',
  candidateId: 'candidate-abc',
  stats: validCandidateImportStats
}

// ===========================================================================
// SourceReadStats (LOCK-4211A)
// ===========================================================================

describe('validateSourceReadStats', () => {
  it('accepts the exact field set with valid counts', () => {
    expect(() => validateSourceReadStats(validSourceReadStats)).not.toThrow()
    expect(validateSourceReadStats(validSourceReadStats)).toEqual(validSourceReadStats)
  })

  it('accepts all-zero counts (empty source)', () => {
    const zero: SourceReadStats = {
      topicRecordCount: 0,
      blockRecordCount: 0,
      segmentRecordCount: 0,
      sourceFileRecordCount: 0
    }
    expect(() => validateSourceReadStats(zero)).not.toThrow()
  })

  it('rejects a missing field', () => {
    const { sourceFileRecordCount, ...missing } = validSourceReadStats
    void sourceFileRecordCount
    expect(() => validateSourceReadStats(missing)).toThrow(/sourceFileRecordCount.*missing/)
  })

  it('rejects an extra field', () => {
    expect(() => validateSourceReadStats({ ...validSourceReadStats, messageCount: 1 })).toThrow(
      /Unknown property 'messageCount'/
    )
  })

  it('rejects negative counts', () => {
    expect(() => validateSourceReadStats({ ...validSourceReadStats, topicRecordCount: -1 })).toThrow(/non-negative/)
  })

  it('rejects non-integer counts', () => {
    expect(() => validateSourceReadStats({ ...validSourceReadStats, blockRecordCount: 1.5 })).toThrow(/integer/)
  })

  it('rejects NaN / Infinity counts', () => {
    expect(() => validateSourceReadStats({ ...validSourceReadStats, segmentRecordCount: Number.NaN })).toThrow()
    expect(() =>
      validateSourceReadStats({ ...validSourceReadStats, segmentRecordCount: Number.POSITIVE_INFINITY })
    ).toThrow()
  })

  it('rejects unsafe integer counts', () => {
    expect(() =>
      validateSourceReadStats({ ...validSourceReadStats, topicRecordCount: Number.MAX_SAFE_INTEGER + 1 })
    ).toThrow(/safe integer/)
  })

  it('rejects string counts', () => {
    expect(() => validateSourceReadStats({ ...validSourceReadStats, topicRecordCount: '10' as any })).toThrow(/number/)
  })

  it('rejects non-object input', () => {
    expect(() => validateSourceReadStats(null)).toThrow(/plain object/)
    expect(() => validateSourceReadStats([validSourceReadStats] as any)).toThrow(/plain object/)
  })
})

describe('isSourceReadStats', () => {
  it('returns true for a valid value', () => {
    expect(isSourceReadStats(validSourceReadStats)).toBe(true)
  })
  it('returns false for malformed values', () => {
    expect(isSourceReadStats({ ...validSourceReadStats, topicRecordCount: -1 })).toBe(false)
    expect(isSourceReadStats({})).toBe(false)
    expect(isSourceReadStats(undefined)).toBe(false)
  })
})

// ===========================================================================
// CandidateImportStats (LOCK-4211B)
// ===========================================================================

describe('validateCandidateImportStats', () => {
  it('accepts the exact field set with valid values', () => {
    expect(() => validateCandidateImportStats(validCandidateImportStats)).not.toThrow()
    expect(validateCandidateImportStats(validCandidateImportStats)).toEqual(validCandidateImportStats)
  })

  it('accepts integer elapsedMs and zero elapsedMs', () => {
    expect(() => validateCandidateImportStats({ ...validCandidateImportStats, elapsedMs: 0 })).not.toThrow()
    expect(() => validateCandidateImportStats({ ...validCandidateImportStats, elapsedMs: 42 })).not.toThrow()
  })

  it('accepts all-zero counts', () => {
    const zero: CandidateImportStats = {
      topicCount: 0,
      messageCount: 0,
      blockCount: 0,
      segmentCount: 0,
      segmentMembershipCount: 0,
      fileReferenceCount: 0,
      pageCount: 0,
      elapsedMs: 0
    }
    expect(() => validateCandidateImportStats(zero)).not.toThrow()
  })

  it('rejects a missing count field', () => {
    const { segmentMembershipCount, ...missing } = validCandidateImportStats
    void segmentMembershipCount
    expect(() => validateCandidateImportStats(missing)).toThrow(/segmentMembershipCount.*missing/)
  })

  it('rejects a missing elapsedMs', () => {
    const { elapsedMs, ...missing } = validCandidateImportStats
    void elapsedMs
    expect(() => validateCandidateImportStats(missing)).toThrow(/elapsedMs.*missing/)
  })

  it('rejects an extra field', () => {
    expect(() => validateCandidateImportStats({ ...validCandidateImportStats, fileRefCount: 1 })).toThrow(
      /Unknown property 'fileRefCount'/
    )
  })

  it('rejects negative counts', () => {
    expect(() => validateCandidateImportStats({ ...validCandidateImportStats, pageCount: -1 })).toThrow(/non-negative/)
  })

  it('rejects non-integer counts', () => {
    expect(() => validateCandidateImportStats({ ...validCandidateImportStats, topicCount: 2.5 })).toThrow(/integer/)
  })

  it('rejects negative elapsedMs', () => {
    expect(() => validateCandidateImportStats({ ...validCandidateImportStats, elapsedMs: -1 })).toThrow(
      /non-negative duration/
    )
  })

  it('rejects non-finite elapsedMs', () => {
    expect(() =>
      validateCandidateImportStats({ ...validCandidateImportStats, elapsedMs: Number.POSITIVE_INFINITY })
    ).toThrow(/finite/)
    expect(() => validateCandidateImportStats({ ...validCandidateImportStats, elapsedMs: Number.NaN })).toThrow(
      /finite/
    )
  })

  it('rejects non-object input', () => {
    expect(() => validateCandidateImportStats(null)).toThrow(/plain object/)
  })
})

describe('isCandidateImportStats', () => {
  it('returns true for a valid value', () => {
    expect(isCandidateImportStats(validCandidateImportStats)).toBe(true)
  })
  it('returns false for malformed values', () => {
    expect(isCandidateImportStats({ ...validCandidateImportStats, elapsedMs: -1 })).toBe(false)
    expect(isCandidateImportStats({})).toBe(false)
  })
})

// ===========================================================================
// CandidateReadyResult (LOCK-4211C)
// ===========================================================================

describe('validateCandidateReadyResult', () => {
  it('accepts the exact field set', () => {
    expect(() => validateCandidateReadyResult(validCandidateReadyResult)).not.toThrow()
    expect(validateCandidateReadyResult(validCandidateReadyResult)).toEqual(validCandidateReadyResult)
  })

  it('rejects empty sessionId', () => {
    expect(() => validateCandidateReadyResult({ ...validCandidateReadyResult, sessionId: '' })).toThrow(/sessionId/)
  })

  it('rejects empty candidateId', () => {
    expect(() => validateCandidateReadyResult({ ...validCandidateReadyResult, candidateId: '' })).toThrow(/candidateId/)
  })

  it('rejects a missing field', () => {
    const { stats, ...missing } = validCandidateReadyResult
    void stats
    expect(() => validateCandidateReadyResult(missing)).toThrow(/stats.*missing/)
  })

  it('rejects an extra field (e.g. leaked filesystem path)', () => {
    expect(() =>
      validateCandidateReadyResult({ ...validCandidateReadyResult, candidatePath: '/tmp/x.sqlite' })
    ).toThrow(/Unknown property 'candidatePath'/)
  })

  it('rejects a malformed nested stats', () => {
    expect(() =>
      validateCandidateReadyResult({
        ...validCandidateReadyResult,
        stats: { ...validCandidateImportStats, topicCount: -1 }
      })
    ).toThrow(/stats.topicCount/)
  })

  it('round-trips through JSON', () => {
    const roundTripped = JSON.parse(JSON.stringify(validCandidateReadyResult))
    expect(() => validateCandidateReadyResult(roundTripped)).not.toThrow()
    expect(roundTripped).toEqual(validCandidateReadyResult)
  })
})

describe('isCandidateReadyResult', () => {
  it('returns true for a valid value', () => {
    expect(isCandidateReadyResult(validCandidateReadyResult)).toBe(true)
  })
  it('returns false for malformed values', () => {
    expect(isCandidateReadyResult({ ...validCandidateReadyResult, sessionId: '' })).toBe(false)
    expect(isCandidateReadyResult({})).toBe(false)
  })
})

// ===========================================================================
// Envelope version behavior (LOCK-4211D)
// ===========================================================================

describe('validateChatImportEnvelope', () => {
  const wrap = <T>(data: T, overrides: Record<string, unknown> = {}) => ({
    sessionId: 'session-123',
    phase: 'complete',
    version: CHAT_IMPORT_WIRE_VERSION,
    data,
    ...overrides
  })

  it('accepts a valid envelope and validates its payload', () => {
    const env = wrap(validCandidateReadyResult)
    const result = validateChatImportEnvelope(env, validateCandidateReadyResult)
    expect(result.sessionId).toBe('session-123')
    expect(result.version).toBe(CHAT_IMPORT_WIRE_VERSION)
    expect(result.data).toEqual(validCandidateReadyResult)
  })

  it('rejects a future version (backward rejection, no coercion)', () => {
    const env = wrap(validCandidateReadyResult, { version: 2 })
    expect(() => validateChatImportEnvelope(env, validateCandidateReadyResult)).toThrow(/Unsupported wire version 2/)
  })

  it('rejects a version 0 / string version', () => {
    expect(() =>
      validateChatImportEnvelope(wrap(validCandidateReadyResult, { version: 0 }), validateCandidateReadyResult)
    ).toThrow(/Unsupported wire version/)
    expect(() =>
      validateChatImportEnvelope(wrap(validCandidateReadyResult, { version: '1' }), validateCandidateReadyResult)
    ).toThrow(/Unsupported wire version/)
  })

  it('rejects empty sessionId', () => {
    expect(() =>
      validateChatImportEnvelope(wrap(validCandidateReadyResult, { sessionId: '' }), validateCandidateReadyResult)
    ).toThrow(/sessionId/)
  })

  it('rejects an unknown phase', () => {
    expect(() =>
      validateChatImportEnvelope(wrap(validCandidateReadyResult, { phase: 'bogus' }), validateCandidateReadyResult)
    ).toThrow(/Unknown phase 'bogus'/)
  })

  it('rejects extra envelope keys', () => {
    expect(() =>
      validateChatImportEnvelope(wrap(validCandidateReadyResult, { extra: true }), validateCandidateReadyResult)
    ).toThrow(/Unknown property 'extra'/)
  })

  it('rejects a missing data key', () => {
    const env = { sessionId: 'session-123', phase: 'complete', version: CHAT_IMPORT_WIRE_VERSION }
    expect(() => validateChatImportEnvelope(env, validateCandidateReadyResult)).toThrow(/data.*missing/)
  })

  it('propagates payload validation failure', () => {
    const env = wrap({ ...validCandidateReadyResult, sessionId: '' })
    expect(() => validateChatImportEnvelope(env, validateCandidateReadyResult)).toThrow(/sessionId/)
  })

  it('round-trips a source-read stats envelope through JSON', () => {
    const env = wrap(validSourceReadStats, { phase: 'reading' })
    const roundTripped = JSON.parse(JSON.stringify(env))
    const result = validateChatImportEnvelope(roundTripped, validateSourceReadStats)
    expect(result.data).toEqual(validSourceReadStats)
  })
})
