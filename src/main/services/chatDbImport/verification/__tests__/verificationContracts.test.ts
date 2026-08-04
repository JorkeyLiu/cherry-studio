/**
 * Verification result/diagnostic contract tests (LOCK-4304).
 *
 * Covers: diagnostic message derivation from structured fields only,
 * frozen diagnostics, and the dimension constant set.
 */

import { describe, expect, it } from 'vitest'

import { createDiagnostic, createFatal, VERIFICATION_DIMENSIONS } from '../verificationContracts'

describe('verification contracts (LOCK-4304)', () => {
  it('exposes the 14 documented dimensions in canonical order', () => {
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
      'sample_reads',
      'search_projection'
    ])
    expect(VERIFICATION_DIMENSIONS).toHaveLength(14)
    expect(new Set(VERIFICATION_DIMENSIONS).size).toBe(14)
    // LOCK-SP-1: the 14th dimension is appended — the first 13 are unchanged.
    expect(VERIFICATION_DIMENSIONS.slice(0, 13)).toEqual([
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

  it('derives search-projection diagnostics from fixed evidence only (LOCK-SP-3/LOCK-PRIV)', () => {
    const objectMissing = createDiagnostic({
      dimension: 'search_projection',
      entity: 'sqlite_master',
      entityId: null,
      fieldPath: null,
      expected: 'message_blocks_fts',
      actual: null,
      code: 'SEARCH_PROJECTION_OBJECT_MISSING'
    })
    expect(objectMissing.message).toBe(
      "SEARCH_PROJECTION_OBJECT_MISSING [search_projection] sqlite_master: expected 'message_blocks_fts', actual <none>"
    )

    const contentMismatch = createDiagnostic({
      dimension: 'search_projection',
      entity: 'message_blocks_normalized',
      entityId: 'b-1',
      fieldPath: 'normalized_content',
      expected: 'match',
      actual: 'differ',
      code: 'SEARCH_PROJECTION_CONTENT_MISMATCH'
    })
    expect(contentMismatch.message).toBe(
      "SEARCH_PROJECTION_CONTENT_MISMATCH [search_projection] message_blocks_normalized/b-1 field 'normalized_content': expected 'match', actual 'differ'"
    )

    const countMismatch = createDiagnostic({
      dimension: 'search_projection',
      entity: 'message_blocks_normalized',
      entityId: null,
      fieldPath: null,
      expected: 2,
      actual: 1,
      code: 'SEARCH_PROJECTION_COUNT_MISMATCH'
    })
    expect(countMismatch.message).toBe(
      'SEARCH_PROJECTION_COUNT_MISMATCH [search_projection] message_blocks_normalized: expected 2, actual 1'
    )
  })

  it('derives exact FTS-parity row diagnostics from entity IDs only (LOCK-SP-2/3/LOCK-PRIV)', () => {
    const rowMissing = createDiagnostic({
      dimension: 'search_projection',
      entity: 'message_blocks_normalized',
      entityId: 'b-1',
      fieldPath: null,
      expected: 'fts-row',
      actual: null,
      code: 'SEARCH_PROJECTION_ROW_MISSING'
    })
    expect(rowMissing.message).toBe(
      "SEARCH_PROJECTION_ROW_MISSING [search_projection] message_blocks_normalized/b-1: expected 'fts-row', actual <none>"
    )

    const rowUnexpected = createDiagnostic({
      dimension: 'search_projection',
      entity: 'message_blocks_fts',
      entityId: 'b-9',
      fieldPath: null,
      expected: 'normalized-row',
      actual: null,
      code: 'SEARCH_PROJECTION_ROW_UNEXPECTED'
    })
    expect(rowUnexpected.message).toBe(
      "SEARCH_PROJECTION_ROW_UNEXPECTED [search_projection] message_blocks_fts/b-9: expected 'normalized-row', actual <none>"
    )

    const aggregate = createDiagnostic({
      dimension: 'search_projection',
      entity: 'message_blocks_fts',
      entityId: null,
      fieldPath: null,
      expected: 3,
      actual: 3,
      code: 'SEARCH_PROJECTION_FTS_MISMATCH'
    })
    expect(aggregate.message).toBe(
      'SEARCH_PROJECTION_FTS_MISMATCH [search_projection] message_blocks_fts: expected 3, actual 3'
    )
  })
})
