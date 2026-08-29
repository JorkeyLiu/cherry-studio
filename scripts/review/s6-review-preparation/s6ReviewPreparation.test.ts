import { describe, expect, it } from 'vitest'

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkMetric,
  type BenchmarkResult
} from '../../../src/main/services/chatDb/__tests__/benchResult'
import {
  assertValidS6ReviewPreparation,
  buildS6ReviewPreparationSummary,
  S6_AUTHORIZATION_STATUS,
  S6_PRIVACY_ATTESTATION,
  S6_REQUIRED_GOVERNANCE,
  type S6ReviewInventory,
  validateS6ReviewPreparation,
  validateS6ReviewPreparationInput
} from './s6ReviewPreparation'

const inventory: S6ReviewInventory = {
  reviewedFiles: ['src/main/services/chatDb/searchRepository.ts', 'src/main/services/chatDb/migration.ts'],
  staticIndexInventory: {
    existingIndexes: ['idx_message_blocks_topic_id'],
    normalizedProjectionPresent: true,
    ftsTablePresent: true
  },
  searchInventory: {
    collectCandidatesPresent: true,
    likeCandidatesPresent: true,
    fetchResultsPresent: true
  },
  fileConsistencyInventory: {
    fileReferencesPresent: true,
    attachmentAvailabilityMarkerPresent: true
  }
}

function result(
  benchmarkId: string,
  scale: Record<string, number>,
  metrics: BenchmarkMetric[],
  gates: BenchmarkResult['gates'] = [{ id: 'parity.ordered', name: 'parity', kind: 'correctness', passed: true }]
): BenchmarkResult {
  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: { id: benchmarkId, name: 'synthetic review input', scale },
    environment: {
      timestamp: '2026-08-29T00:00:00.000Z',
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'node',
      abi: '137',
      command: 'pnpm test',
      git: { commit: '0123456789abcdef0123456789abcdef01234567', dirty: false }
    },
    metrics,
    gates
  }
}

function completeInput() {
  return {
    inventory,
    results: [
      {
        source: 'm5' as const,
        result: result('chatdb-m5-file-dual-state', { references: 100 }, [
          { id: 'scenario.count', name: 'scenario count', value: 4 }
        ])
      },
      {
        source: 'm4' as const,
        result: result('chatdb-m4-fts-duplication-50k', { blocks: 50_000 }, [
          { id: 'duplication.logicalBytesUtf8', name: 'logical bytes', value: 10 }
        ])
      },
      {
        source: 'm1' as const,
        result: result('chatdb-sort-order-shift', { rows: 100 }, [
          { id: 'parity.count', name: 'parity count', value: 100 }
        ])
      },
      {
        source: 'm3' as const,
        result: result('chatdb-search-stage-plan-50k', { blocks: 50_000 }, [
          { id: 'plan.count', name: 'plan count', value: 1 }
        ])
      },
      {
        source: 'm2' as const,
        result: result('chatdb-search-stage-50k', { blocks: 50_000 }, [
          { id: 'stage.count', name: 'stage count', value: 1 }
        ])
      },
      {
        source: 'm4' as const,
        result: result('chatdb-m4-fts-duplication-1k', { blocks: 1_000 }, [
          { id: 'duplication.logicalBytesUtf8', name: 'logical bytes', value: 3 }
        ])
      }
    ]
  }
}

describe('S6 review-preparation summary', () => {
  it('aggregates supplied in-memory evidence deterministically regardless of input order', () => {
    const input = completeInput()
    const reversed = { ...input, results: [...input.results].reverse() }
    const first = buildS6ReviewPreparationSummary(input)
    const second = buildS6ReviewPreparationSummary(reversed)

    expect(second).toEqual(first)
    expect(first.inputs).toEqual({
      m1ArtifactPresent: true,
      m2ArtifactPresent: true,
      m3ArtifactPresent: true,
      m4: { present: true, scales: { '1k': true, '10k': false, '50k': true } },
      m5: { present: true, scales: { small: true, medium: false } }
    })
    expect(first.evidenceSummary.m2).toEqual({ gatesPass: true })
    expect(first.evidenceSummary.m3).toEqual({ gatesPass: true })
    expect(first.evidenceSummary.m4).toEqual({ logicalDuplicationBytes: 13, gatesPass: true })
    expect(first.evidenceSummary.m5).toEqual({ scenarios: 4, gatesPass: true })
  })

  it('represents missing M6 execution evidence explicitly without inventing numeric results', () => {
    const summary = buildS6ReviewPreparationSummary({ inventory, results: [] })

    expect(summary.inputs).toEqual({
      m1ArtifactPresent: false,
      m2ArtifactPresent: false,
      m3ArtifactPresent: false,
      m4: { present: false, scales: { '1k': false, '10k': false, '50k': false } },
      m5: { present: false, scales: { small: false, medium: false } }
    })
    expect(summary.evidenceSummary).toEqual({ m1: null, m2: null, m3: null, m4: null, m5: null })
    expect(summary.gaps).toEqual({
      realCorpusMissing: true,
      physicalSizeMissing: true,
      m6EvidenceMissing: true,
      indexBenefitUnproven: true,
      fileConsistencyUnproven: true
    })
  })

  it('preserves the exact non-authorizing status and fixed governance/privacy declarations', () => {
    const summary = buildS6ReviewPreparationSummary({ inventory, results: [] })

    expect(summary.authorizationStatus).toBe(S6_AUTHORIZATION_STATUS)
    expect(summary.requiredGovernance).toEqual(S6_REQUIRED_GOVERNANCE)
    expect(summary.privacyAttestation).toBe(S6_PRIVACY_ATTESTATION)
    expect(validateS6ReviewPreparation(summary)).toEqual([])
    expect(() => assertValidS6ReviewPreparation(summary)).not.toThrow()
  })
})

describe('S6 review-preparation closed and privacy-safe contracts', () => {
  it('rejects unknown output fields and status changes', () => {
    const summary = buildS6ReviewPreparationSummary({ inventory, results: [] })
    expect(validateS6ReviewPreparation({ ...summary, extra: true })).toEqual([
      'summary.extra is not a permitted field (schema is closed)'
    ])
    expect(validateS6ReviewPreparation({ ...summary, gaps: { ...summary.gaps, extra: true } })).toEqual([
      'summary.gaps.extra is not a permitted field (schema is closed)'
    ])
    expect(validateS6ReviewPreparation({ ...summary, authorizationStatus: 'Authorized' })).toContain(
      "summary.authorizationStatus must be exactly 'Candidate — Not Authorized'"
    )
  })

  it('rejects unknown nested gaps keys against the exact five-key allowlist', () => {
    const summary = buildS6ReviewPreparationSummary({ inventory, results: [] })
    const validGaps = summary.gaps
    expect(Object.keys(validGaps).sort()).toEqual([
      'fileConsistencyUnproven',
      'indexBenefitUnproven',
      'm6EvidenceMissing',
      'physicalSizeMissing',
      'realCorpusMissing'
    ])
    expect(validateS6ReviewPreparation({ ...summary, gaps: { ...validGaps, extra: true } })).toEqual([
      'summary.gaps.extra is not a permitted field (schema is closed)'
    ])
    expect(validateS6ReviewPreparation({ ...summary, gaps: { ...validGaps, unknownGap: true } })).toEqual([
      'summary.gaps.unknownGap is not a permitted field (schema is closed)'
    ])
    expect(
      validateS6ReviewPreparation({
        ...summary,
        gaps: { ...validGaps, extra: true, anotherExtra: true }
      })
    ).toEqual(
      expect.arrayContaining([
        'summary.gaps.anotherExtra is not a permitted field (schema is closed)',
        'summary.gaps.extra is not a permitted field (schema is closed)'
      ])
    )
    expect(
      validateS6ReviewPreparation({ ...summary, gaps: { ...validGaps, m6EvidenceMissing: true, extraNested: false } })
    ).toEqual(expect.arrayContaining(['summary.gaps.extraNested is not a permitted field (schema is closed)']))
  })

  it('rejects privacy-sensitive input fields and threshold gates', () => {
    const sensitive = result('chatdb-sort-order-shift', { rows: 100 }, [
      { id: 'parity.count', name: 'parity', value: 1 }
    ]) as unknown as Record<string, unknown>
    sensitive.content = 'message text'
    const sensitiveInput = { inventory, results: [{ source: 'm1', result: sensitive }] }
    expect(validateS6ReviewPreparationInput(sensitiveInput)).toEqual(
      expect.arrayContaining([expect.stringContaining('forbidden fields: content')])
    )

    const thresholdResult = result(
      'chatdb-sort-order-shift',
      { rows: 100 },
      [{ id: 'parity.count', name: 'parity', value: 1 }],
      [{ id: 'performance', name: 'performance', kind: 'threshold', passed: true }]
    )
    expect(
      validateS6ReviewPreparationInput({ inventory, results: [{ source: 'm1', result: thresholdResult }] })
    ).toEqual(expect.arrayContaining([expect.stringContaining('must not contain threshold gates')]))
  })

  it('rejects non-finite numeric values through the schema-v1 contract', () => {
    const invalid = result('chatdb-m4-fts-duplication-1k', { blocks: 1_000 }, [
      { id: 'duplication.logicalBytesUtf8', name: 'logical bytes', value: Number.NaN }
    ])
    expect(validateS6ReviewPreparationInput({ inventory, results: [{ source: 'm4', result: invalid }] })).toEqual(
      expect.arrayContaining([expect.stringContaining('must be a finite number')])
    )
  })

  it('rejects duplicate scale identities instead of making an order-dependent choice', () => {
    const one = result('chatdb-m4-fts-duplication-1k', { blocks: 1_000 }, [])
    // The schema-v1 contract requires a non-empty metric list; use a harmless value.
    one.metrics = [{ id: 'rows', name: 'rows', value: 1 }]
    const input = {
      inventory,
      results: [
        { source: 'm4' as const, result: one },
        { source: 'm4' as const, result: one }
      ]
    }
    expect(validateS6ReviewPreparationInput(input)).toEqual(
      expect.arrayContaining([expect.stringContaining('duplicates evidence identity m4:1k')])
    )
  })

  it('rejects absolute, UNC, drive-absolute, and backslash-bearing reviewed paths', () => {
    for (const reviewedFile of [
      '/tmp/review.ts',
      'C:/review.ts',
      'C:\\review.ts',
      '\\\\server\\share\\review.ts',
      'src\\review.ts'
    ]) {
      expect(
        validateS6ReviewPreparationInput({ inventory: { ...inventory, reviewedFiles: [reviewedFile] }, results: [] })
      ).toEqual(expect.arrayContaining([expect.stringContaining('must be a non-empty repository-relative string')]))
    }
  })

  it('binds each source label to its permitted benchmark identity', () => {
    const mismatched = result('chatdb-search-stage-plan-50k', { blocks: 50_000 }, [
      { id: 'plan.count', name: 'plan count', value: 1 }
    ])
    expect(validateS6ReviewPreparationInput({ inventory, results: [{ source: 'm2', result: mismatched }] })).toEqual(
      expect.arrayContaining([expect.stringContaining('benchmark.id is not permitted for source m2')])
    )
  })

  it('validates malformed nested results without throwing', () => {
    const malformed = [
      { source: 'm4', result: null },
      { source: 'm5', result: { benchmark: null } },
      { source: 'm4', result: { benchmark: { scale: null } } }
    ]
    expect(() => validateS6ReviewPreparationInput({ inventory, results: malformed })).not.toThrow()
    expect(validateS6ReviewPreparationInput({ inventory, results: malformed })).toEqual(
      expect.arrayContaining([expect.stringContaining('must be a JSON object')])
    )
  })

  it('rejects sparse result, benchmark, and inventory arrays without throwing', () => {
    const sparseResults = new Array(1)
    const sparseResultsInput = { inventory, results: sparseResults }
    expect(() => validateS6ReviewPreparationInput(sparseResultsInput)).not.toThrow()
    expect(validateS6ReviewPreparationInput(sparseResultsInput)).toContain('input.results must not be sparse')
    expect(() => buildS6ReviewPreparationSummary(sparseResultsInput as never)).toThrow(
      /input\.results must not be sparse/
    )

    const sparseResult = result('chatdb-m4-fts-duplication-1k', { blocks: 1_000 }, [
      { id: 'rows', name: 'rows', value: 1 }
    ])
    sparseResult.metrics = new Array(1)
    sparseResult.gates = new Array(1)
    const nestedProblems = validateS6ReviewPreparationInput({
      inventory,
      results: [{ source: 'm4', result: sparseResult }]
    })
    expect(nestedProblems).toEqual(
      expect.arrayContaining([
        'input.results[0].result.metrics must not be sparse',
        'input.results[0].result.gates must not be sparse'
      ])
    )

    const sparseInventory: S6ReviewInventory = {
      ...inventory,
      reviewedFiles: new Array(1),
      staticIndexInventory: { ...inventory.staticIndexInventory, existingIndexes: new Array(1) }
    }
    const inventoryProblems = validateS6ReviewPreparationInput({ inventory: sparseInventory, results: [] })
    expect(inventoryProblems).toEqual(
      expect.arrayContaining([
        'inventory.reviewedFiles must not be sparse',
        'inventory.staticIndexInventory.existingIndexes must not be sparse'
      ])
    )

    const summary = buildS6ReviewPreparationSummary({ inventory, results: [] })
    const sparseGovernance = new Array(summary.requiredGovernance.length)
    sparseGovernance[0] = summary.requiredGovernance[0]
    expect(validateS6ReviewPreparation({ ...summary, requiredGovernance: sparseGovernance })).toEqual(
      expect.arrayContaining(['summary.requiredGovernance must not be sparse'])
    )
  })

  it('requires boolean gatesPass for present M4/M5 evidence while allowing nullable metrics', () => {
    const summary = buildS6ReviewPreparationSummary(completeInput())
    const evidenceSummary = {
      ...summary.evidenceSummary,
      m4: { ...summary.evidenceSummary.m4!, logicalDuplicationBytes: null, gatesPass: null },
      m5: { ...summary.evidenceSummary.m5!, scenarios: null, gatesPass: null }
    }

    expect(validateS6ReviewPreparation({ ...summary, evidenceSummary })).toEqual(
      expect.arrayContaining([
        'summary.evidenceSummary.m4.gatesPass must be a boolean',
        'summary.evidenceSummary.m5.gatesPass must be a boolean'
      ])
    )

    expect(
      validateS6ReviewPreparation({
        ...summary,
        evidenceSummary: {
          ...summary.evidenceSummary,
          m4: { ...summary.evidenceSummary.m4!, logicalDuplicationBytes: null, gatesPass: true },
          m5: { ...summary.evidenceSummary.m5!, scenarios: null, gatesPass: true }
        }
      })
    ).toEqual([])
  })

  it('rejects inconsistent output fields across inputs and evidence summaries', () => {
    const summary = buildS6ReviewPreparationSummary(completeInput())
    expect(
      validateS6ReviewPreparation({
        ...summary,
        inputs: { ...summary.inputs, m2ArtifactPresent: false }
      })
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('m2ArtifactPresent must match summary.evidenceSummary.m2 presence')
      ])
    )
  })
})
