/**
 * L2 trash retention helper tests (LOCK-TRASH-1..10).
 *
 * Pure unit coverage for the shared retention module:
 * - LOCK-TRASH-5: strict canonical UTC ISO marker validation + baseline
 *   generation always satisfies it.
 * - LOCK-TRASH-6: effective retention start = max(original deletedAt,
 *   valid marker); missing/invalid marker falls back to deletedAt.
 * - LOCK-TRASH-10: fail-safe parsing — malformed/non-object extra and
 *   unparseable deletedAt never throw.
 */
import { describe, expect, it } from 'vitest'

import {
  computeTrashRetentionDecision,
  generateL2TrashRetentionBaseline,
  isValidL2TrashRetentionMarker,
  L2_TRASH_RETENTION_MARKER,
  parseCanonicalIsoMs,
  parseStrictCanonicalIsoMs
} from '../trashRetention'

const BASE = '2026-08-04T00:00:00.000Z'
const BASE_MS = Date.parse(BASE)

const OLD_DELETED_AT = '2020-01-01T00:00:00.000Z'
const OLD_DELETED_AT_MS = Date.parse(OLD_DELETED_AT)

describe('isValidL2TrashRetentionMarker (LOCK-TRASH-5)', () => {
  it('accepts a strict canonical UTC ISO string with milliseconds', () => {
    expect(isValidL2TrashRetentionMarker(BASE)).toBe(true)
    expect(isValidL2TrashRetentionMarker('2026-08-04T01:02:03.456Z')).toBe(true)
  })

  it('rejects non-string values', () => {
    expect(isValidL2TrashRetentionMarker(null)).toBe(false)
    expect(isValidL2TrashRetentionMarker(undefined)).toBe(false)
    expect(isValidL2TrashRetentionMarker(12345)).toBe(false)
    expect(isValidL2TrashRetentionMarker({})).toBe(false)
    expect(isValidL2TrashRetentionMarker([])).toBe(false)
    expect(isValidL2TrashRetentionMarker(true)).toBe(false)
  })

  it('rejects non-canonical string representations (LOCK-TRASH-5 exact canonical)', () => {
    // Valid instant, but NOT the exact canonical representation.
    expect(isValidL2TrashRetentionMarker('2026-08-04T00:00:00Z')).toBe(false)
    expect(isValidL2TrashRetentionMarker('2026-08-04T00:00:00.000+00:00')).toBe(false)
    expect(isValidL2TrashRetentionMarker('2026-08-04T08:00:00.000+08:00')).toBe(false)
    expect(isValidL2TrashRetentionMarker('2026-08-04 00:00:00.000Z')).toBe(false)
    expect(isValidL2TrashRetentionMarker('2026-08-04')).toBe(false)
    expect(isValidL2TrashRetentionMarker('')).toBe(false)
  })

  it('rejects unparseable / out-of-range dates', () => {
    expect(isValidL2TrashRetentionMarker('not-a-date')).toBe(false)
    expect(isValidL2TrashRetentionMarker('2026-13-01T00:00:00.000Z')).toBe(false)
    // 13 months → Date.parse NaN.
    expect(parseCanonicalIsoMs('2026-13-01T00:00:00.000Z')).toBeNull()
  })
})

describe('parseCanonicalIsoMs (LOCK-TRASH-5/10)', () => {
  it('parses to epoch milliseconds', () => {
    expect(parseCanonicalIsoMs(BASE)).toBe(BASE_MS)
  })

  it('returns null for non-string / empty / unparseable input (never throws)', () => {
    expect(parseCanonicalIsoMs(undefined)).toBeNull()
    expect(parseCanonicalIsoMs(null)).toBeNull()
    expect(parseCanonicalIsoMs(0)).toBeNull()
    expect(parseCanonicalIsoMs({})).toBeNull()
    expect(parseCanonicalIsoMs('')).toBeNull()
    expect(parseCanonicalIsoMs('garbage')).toBeNull()
  })
})

describe('parseStrictCanonicalIsoMs (LOCK-TRASH-13)', () => {
  it('parses a strict canonical UTC ISO timestamp with milliseconds', () => {
    expect(parseStrictCanonicalIsoMs(BASE)).toBe(BASE_MS)
  })

  it('rejects parseable-but-non-canonical timestamps (null — caller rejects as ERR_VALIDATION)', () => {
    // Valid instants, but NOT the exact canonical representation — identical
    // to the shared IPC contract (`validateIso8601Timestamp`).
    expect(parseStrictCanonicalIsoMs('2026-08-04T00:00:00Z')).toBeNull()
    expect(parseStrictCanonicalIsoMs('2026-08-04')).toBeNull()
    expect(parseStrictCanonicalIsoMs('2026-08-04T00:00:00.000+00:00')).toBeNull()
    expect(parseStrictCanonicalIsoMs('2026-08-04 00:00:00.000Z')).toBeNull()
    expect(parseStrictCanonicalIsoMs('2026-08-04T00:00:00.000')).toBeNull()
    expect(parseStrictCanonicalIsoMs('2026-08-04T00:00:00.00Z')).toBeNull()
  })

  it('rejects non-string / empty / unparseable values (never throws)', () => {
    expect(parseStrictCanonicalIsoMs(undefined)).toBeNull()
    expect(parseStrictCanonicalIsoMs(null)).toBeNull()
    expect(parseStrictCanonicalIsoMs(0)).toBeNull()
    expect(parseStrictCanonicalIsoMs({})).toBeNull()
    expect(parseStrictCanonicalIsoMs('')).toBeNull()
    expect(parseStrictCanonicalIsoMs('garbage')).toBeNull()
    expect(parseStrictCanonicalIsoMs('2026-13-01T00:00:00.000Z')).toBeNull()
  })
})

describe('generateL2TrashRetentionBaseline (LOCK-TRASH-2/5)', () => {
  it('produces a strict canonical UTC ISO string from the injected clock', () => {
    const baseline = generateL2TrashRetentionBaseline(() => BASE_MS)
    expect(isValidL2TrashRetentionMarker(baseline)).toBe(true)
    expect(baseline).toBe(BASE)
  })

  it('defaults to the real clock', () => {
    const baseline = generateL2TrashRetentionBaseline()
    expect(isValidL2TrashRetentionMarker(baseline)).toBe(true)
  })
})

describe('computeTrashRetentionDecision (LOCK-TRASH-6/7/10)', () => {
  it('no marker (empty extra) → deletedAt exactly, not invalid', () => {
    const d = computeTrashRetentionDecision(OLD_DELETED_AT, null)
    expect(d).toEqual({ effectiveStartMs: OLD_DELETED_AT_MS, invalidMarker: false })

    const d2 = computeTrashRetentionDecision(OLD_DELETED_AT, '')
    expect(d2).toEqual({ effectiveStartMs: OLD_DELETED_AT_MS, invalidMarker: false })

    const d3 = computeTrashRetentionDecision(OLD_DELETED_AT, '{}')
    expect(d3).toEqual({ effectiveStartMs: OLD_DELETED_AT_MS, invalidMarker: false })
  })

  it('no marker key in a plain-object extra → deletedAt, not invalid (L3 legacy)', () => {
    const d = computeTrashRetentionDecision(OLD_DELETED_AT, JSON.stringify({ pinned: true }))
    expect(d).toEqual({ effectiveStartMs: OLD_DELETED_AT_MS, invalidMarker: false })
  })

  it('valid marker newer than deletedAt → effective start = marker (LOCK-TRASH-6)', () => {
    // deletedAt 2020, marker 2026 → effective start = marker.
    const d = computeTrashRetentionDecision(OLD_DELETED_AT, JSON.stringify({ [L2_TRASH_RETENTION_MARKER]: BASE }))
    expect(d).toEqual({ effectiveStartMs: BASE_MS, invalidMarker: false })
  })

  it('valid marker older than deletedAt → effective start = deletedAt (max)', () => {
    // deletedAt 2026, marker 2020 → effective start = deletedAt.
    const newerDeletedAt = BASE
    const d = computeTrashRetentionDecision(
      newerDeletedAt,
      JSON.stringify({ [L2_TRASH_RETENTION_MARKER]: OLD_DELETED_AT })
    )
    expect(d).toEqual({ effectiveStartMs: BASE_MS, invalidMarker: false })
  })

  it('invalid marker type/value is ignored → deletedAt fallback, counted invalid', () => {
    const cases: unknown[] = [
      'not-a-date',
      '',
      12345,
      true,
      null,
      {},
      [],
      '2026-08-04T00:00:00Z', // non-canonical representation
      '2026-13-01T00:00:00.000Z' // out-of-range
    ]
    for (const bad of cases) {
      const d = computeTrashRetentionDecision(OLD_DELETED_AT, JSON.stringify({ [L2_TRASH_RETENTION_MARKER]: bad }))
      expect(d).toEqual({ effectiveStartMs: OLD_DELETED_AT_MS, invalidMarker: true })
    }
  })

  it('malformed extra JSON → deletedAt fallback, counted invalid (LOCK-TRASH-10)', () => {
    const d = computeTrashRetentionDecision(OLD_DELETED_AT, '{not valid json')
    expect(d).toEqual({ effectiveStartMs: OLD_DELETED_AT_MS, invalidMarker: true })
  })

  it('non-object extra JSON → deletedAt fallback, counted invalid (LOCK-TRASH-10)', () => {
    for (const nonObject of ['"str"', '42', '[1,2]', 'true']) {
      const d = computeTrashRetentionDecision(OLD_DELETED_AT, nonObject)
      expect(d).toEqual({ effectiveStartMs: OLD_DELETED_AT_MS, invalidMarker: true })
    }
  })

  it('unparseable deletedAt → null (retained, never throws — LOCK-TRASH-10)', () => {
    expect(computeTrashRetentionDecision('not-a-date', null)).toBeNull()
    expect(
      computeTrashRetentionDecision('not-a-date', JSON.stringify({ [L2_TRASH_RETENTION_MARKER]: BASE }))
    ).toBeNull()
  })

  it('future valid marker protects until its calculated window', () => {
    const future = '2099-01-01T00:00:00.000Z'
    const d = computeTrashRetentionDecision(OLD_DELETED_AT, JSON.stringify({ [L2_TRASH_RETENTION_MARKER]: future }))
    expect(d).toEqual({ effectiveStartMs: Date.parse(future), invalidMarker: false })
  })
})
