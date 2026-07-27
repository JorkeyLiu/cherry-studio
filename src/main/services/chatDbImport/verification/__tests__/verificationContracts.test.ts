/**
 * Verification result/diagnostic contract tests (LOCK-4304).
 *
 * Covers: diagnostic message derivation from structured fields only,
 * frozen diagnostics, and the dimension constant set.
 */

import { describe, expect, it } from 'vitest'

import { createDiagnostic, createFatal, VERIFICATION_DIMENSIONS } from '../verificationContracts'

describe('verification contracts (LOCK-4304)', () => {
  it('exposes the 13 documented dimensions in canonical order', () => {
    expect(VERIFICATION_DIMENSIONS).toEqual([
      'id_sets',
      'table_counts',
      'field_digests',
      'order',
      'fk_references',
      'relations',
      'file_references',
      'segments',
      'structured_json',
      'overflow',
      'integrity_check',
      'foreign_key_check',
      'sample_reads'
    ])
    expect(VERIFICATION_DIMENSIONS).toHaveLength(13)
    expect(new Set(VERIFICATION_DIMENSIONS).size).toBe(13)
  })

  it('derives the message exclusively from structured fields', () => {
    const diagnostic = createDiagnostic({
      dimension: 'field_digests',
      entity: 'messages',
      entityId: 'm-1',
      fieldPath: 'overflow.model',
      expected: 'aaaa1111',
      actual: 'bbbb2222',
      code: 'FIELD_DIGEST_MISMATCH'
    })

    expect(diagnostic.message).toBe(
      "FIELD_DIGEST_MISMATCH [field_digests] messages/m-1 field 'overflow.model': expected 'aaaa1111', actual 'bbbb2222'"
    )
    expect(Object.isFrozen(diagnostic)).toBe(true)
  })

  it('formats entity-level count diagnostics without entityId/fieldPath', () => {
    const diagnostic = createDiagnostic({
      dimension: 'table_counts',
      entity: 'topics',
      entityId: null,
      fieldPath: null,
      expected: 3,
      actual: 2,
      code: 'COUNT_MISMATCH'
    })

    expect(diagnostic.message).toBe('COUNT_MISMATCH [table_counts] topics: expected 3, actual 2')
    expect(diagnostic.entityId).toBeNull()
    expect(diagnostic.fieldPath).toBeNull()
  })

  it('renders absent evidence values as <none>', () => {
    const diagnostic = createDiagnostic({
      dimension: 'id_sets',
      entity: 'blocks',
      entityId: 'b-9',
      fieldPath: null,
      expected: 'deadbeef',
      actual: null,
      code: 'MISSING_ENTITY'
    })
    expect(diagnostic.message).toBe("MISSING_ENTITY [id_sets] blocks/b-9: expected 'deadbeef', actual <none>")
  })

  it('builds frozen sanitized fatals from structured fields only', () => {
    const fatal = createFatal('CANDIDATE_OPEN_FAILED', 'SQLITE_CANTOPEN')
    expect(fatal.message).toBe('CANDIDATE_OPEN_FAILED: SQLITE_CANTOPEN')
    expect(fatal.fieldPath).toBeNull()
    expect(Object.isFrozen(fatal)).toBe(true)

    const withField = createFatal('CANDIDATE_QUERY_FAILED', 'CanonicalizationError', 'root.overflow[2]')
    expect(withField.message).toBe("CANDIDATE_QUERY_FAILED field 'root.overflow[2]': CanonicalizationError")
  })
})
