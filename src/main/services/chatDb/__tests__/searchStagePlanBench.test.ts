/**
 * Focused pure tests for the search fetch query-plan attribution benchmark
 * helpers (searchStagePlanBench.ts): env gate / scale validation, the
 * shape-agnostic privacy-safe plan classifier (EQP + bytecode), repeated-run
 * determinism, classifier invariants, the 150-row deterministic metric grid
 * (10 fixtures × 15 rows), id uniqueness/order and finite-value invariants,
 * the fail-fast completeness guard, and the stage-shaped schema-v1 artifact
 * vocabulary.
 *
 * Pure logic — imports no native module and performs no filesystem work, so
 * mainLanes.ts classifies it into the core lane (`pnpm test:main:core`).
 */

import { describe, expect, it } from 'vitest'

import { BENCH_RESULT_SCHEMA_VERSION, type BenchmarkResult, validateBenchmarkResult } from './benchResult'
import { SEARCH_BENCH_PROFILES } from './searchBenchHarness'
import type { SearchFixtureDescriptor } from './searchBenchMetrics'
import {
  assertSearchStagePlanCompleteness,
  assertSearchStagePlanNonVacuity,
  buildSearchStagePlanMetrics,
  classifyExplainBytecodeRows,
  classifyExplainQueryPlanRows,
  eqpClassificationInvariantErrors,
  opcodeClassificationInvariantErrors,
  planInvariantErrors,
  resolveSearchStagePlanGate,
  resolveSearchStagePlanScale,
  SEARCH_STAGE_PLAN_BENCH_ENV,
  SEARCH_STAGE_PLAN_BENCH_ID,
  SEARCH_STAGE_PLAN_BENCH_NAME,
  SEARCH_STAGE_PLAN_COMMAND,
  SEARCH_STAGE_PLAN_FIXTURES,
  SEARCH_STAGE_PLAN_PAGE_SIZE,
  SEARCH_STAGE_PLAN_PLANNER_RUNS,
  SEARCH_STAGE_PLAN_PROFILE_KEY,
  searchPlanRunsIdentical,
  type SearchStagePlanFixtureClassification,
  searchStagePlanScale
} from './searchStagePlanBench'

/** Representative EXPLAIN QUERY PLAN rows shaped like better-sqlite3 output. */
const SAMPLE_EQP_ROWS = [
  {
    detail: 'SEARCH message_blocks_normalized nb USING INDEX sqlite_autoindex_message_blocks_normalized_1 (block_id=?)'
  },
  { detail: 'SEARCH message_blocks mb USING INTEGER PRIMARY KEY (rowid=?)' },
  { detail: 'SEARCH messages m USING INTEGER PRIMARY KEY (rowid=?)' },
  { detail: 'SEARCH topics t USING INTEGER PRIMARY KEY (rowid=?)' },
  { detail: 'USE TEMP B-TREE FOR ORDER BY' }
]

/** Representative EXPLAIN bytecode rows shaped like better-sqlite3 output. */
const SAMPLE_BYTECODE_ROWS = [
  { opcode: 'Init' },
  { opcode: 'OpenEphemeral' },
  { opcode: 'Column' },
  { opcode: 'MakeRecord' },
  { opcode: 'IdxInsert' },
  { opcode: 'SeekRowid' },
  { opcode: 'SorterOpen' },
  { opcode: 'SorterInsert' },
  { opcode: 'Sort' },
  { opcode: 'ResultRow' },
  { opcode: 'Next' },
  { opcode: 'Halt' }
]

/** Mutable per-fixture classification grid used by the test fixtures. */
type MutableFixturePlans = Map<string, SearchStagePlanFixtureClassification>

/**
 * Deterministic per-fixture classification grid for the 10 real fixtures with
 * distinct values so every row is distinguishable. Bucket sums equal totals by
 * construction.
 */
function fixturePlans(): MutableFixturePlans {
  const plans: MutableFixturePlans = new Map()
  SEARCH_STAGE_PLAN_FIXTURES.forEach((fixture, index) => {
    const eqpTotal = 4 + index
    const opcodeTotal = 60 + index * 10
    plans.set(fixture.id, {
      exactCount: 40 + index * 4,
      eqpRun1: { total: eqpTotal, search: 2, scan: 1, tempBtreeOrderBy: 1, other: eqpTotal - 4 },
      eqpRun2: { total: eqpTotal, search: 2, scan: 1, tempBtreeOrderBy: 1, other: eqpTotal - 4 },
      opcodeRun1: {
        total: opcodeTotal,
        openEphemeral: 1,
        sort: 1,
        sorter: 2,
        makeRecord: 2,
        idxInsert: 2,
        resultRow: 1,
        seek: 3,
        other: opcodeTotal - 12
      },
      opcodeRun2: {
        total: opcodeTotal,
        openEphemeral: 1,
        sort: 1,
        sorter: 2,
        makeRecord: 2,
        idxInsert: 2,
        resultRow: 1,
        seek: 3,
        other: opcodeTotal - 12
      }
    })
  })
  return plans
}

/** Expected 150 metric ids in fixture-major / row order. */
const EXPECTED_IDS: string[] = SEARCH_STAGE_PLAN_FIXTURES.flatMap((fixture) => [
  `fixture.${fixture.id}.exactCount`,
  `fixture.${fixture.id}.eqpTotal`,
  `fixture.${fixture.id}.eqpSearch`,
  `fixture.${fixture.id}.eqpScan`,
  `fixture.${fixture.id}.eqpTempBtreeOrderBy`,
  `fixture.${fixture.id}.eqpOther`,
  `fixture.${fixture.id}.opcodeTotal`,
  `fixture.${fixture.id}.opcodeOpenEphemeral`,
  `fixture.${fixture.id}.opcodeSort`,
  `fixture.${fixture.id}.opcodeSorter`,
  `fixture.${fixture.id}.opcodeMakeRecord`,
  `fixture.${fixture.id}.opcodeIdxInsert`,
  `fixture.${fixture.id}.opcodeResultRow`,
  `fixture.${fixture.id}.opcodeSeek`,
  `fixture.${fixture.id}.opcodeOther`
])

describe('resolveSearchStagePlanGate (default skip / on-demand enable)', () => {
  it('is disabled by default (unset/empty) so the diagnostic body never runs', () => {
    expect(resolveSearchStagePlanGate(undefined)).toBe(false)
    expect(resolveSearchStagePlanGate('')).toBe(false)
    expect(resolveSearchStagePlanGate('   ')).toBe(false)
  })

  it('enables only on the explicit 1/true values, case-insensitively', () => {
    expect(resolveSearchStagePlanGate('1')).toBe(true)
    expect(resolveSearchStagePlanGate('true')).toBe(true)
    expect(resolveSearchStagePlanGate('TRUE')).toBe(true)
    expect(resolveSearchStagePlanGate(' True ')).toBe(true)
  })

  it('rejects any other non-empty value loudly (never silent skip or run)', () => {
    for (const bad of ['yes', '0', 'false', 'enabled', 'on', '--enable']) {
      expect(() => resolveSearchStagePlanGate(bad)).toThrow(/SEARCH_STAGE_PLAN_BENCH/)
    }
  })
})

describe('resolveSearchStagePlanScale (50k-only diagnostic)', () => {
  it('defaults to the 50k profile when unset or empty', () => {
    expect(resolveSearchStagePlanScale(undefined)).toBe('50k')
    expect(resolveSearchStagePlanScale('')).toBe('50k')
    expect(resolveSearchStagePlanScale(' 50k ')).toBe('50k')
  })

  it('accepts only the explicit 50k profile', () => {
    expect(resolveSearchStagePlanScale('50k')).toBe('50k')
  })

  it('rejects every other profile loudly instead of planning a smaller corpus', () => {
    for (const bad of ['1k', '10k', '120k', '50000', '10K']) {
      expect(() => resolveSearchStagePlanScale(bad)).toThrow(/only supports the 50k profile/)
    }
  })

  it('declares the fixed dimensions, identity, and provenance', () => {
    expect(SEARCH_STAGE_PLAN_BENCH_ENV).toBe('SEARCH_STAGE_PLAN_BENCH')
    expect(SEARCH_STAGE_PLAN_PROFILE_KEY).toBe('50k')
    expect(SEARCH_STAGE_PLAN_PAGE_SIZE).toBe(100)
    expect(SEARCH_STAGE_PLAN_PLANNER_RUNS).toBe(2)
    expect(SEARCH_STAGE_PLAN_BENCH_ID).toBe('chatdb-search-stage-plan-50k')
    expect(SEARCH_STAGE_PLAN_BENCH_NAME).toContain('query-plan')
    expect(SEARCH_STAGE_PLAN_COMMAND).toBe('pnpm bench:search-stage-plan')
    // Audit F3: the canonical artifact command must be path-free.
    expect(SEARCH_STAGE_PLAN_COMMAND).not.toMatch(/[\\/]/)
  })

  it('reuses the deterministic 50k corpus profile without disturbing existing identities', () => {
    expect(searchStagePlanScale()).toEqual({ blocks: 50_000, profileCode: 2 })
    expect(SEARCH_BENCH_PROFILES['50k'].blocks).toBe(50_000)
    // The plan benchmark id is separate from every search bench profile id
    // and from the stage benchmark id.
    const profileIds = Object.values(SEARCH_BENCH_PROFILES).map((p) => p.id)
    expect(profileIds).not.toContain(SEARCH_STAGE_PLAN_BENCH_ID)
    expect(SEARCH_STAGE_PLAN_BENCH_ID).not.toBe('chatdb-search-stage-50k')
    // The default search bench scale and profiles stay untouched.
    expect(SEARCH_BENCH_PROFILES['10k']).toBeDefined()
  })
})

describe('classifyExplainQueryPlanRows (shape-agnostic, privacy-safe)', () => {
  it('classifies SEARCH / SCAN / temp-btree / other into finite counts', () => {
    const result = classifyExplainQueryPlanRows(SAMPLE_EQP_ROWS)
    expect(result).toEqual({ total: 5, search: 4, scan: 0, tempBtreeOrderBy: 1, other: 0 })
  })

  it('puts unrecognized detail shapes into the other bucket', () => {
    const rows = [
      { detail: 'LIST SUBQUERY 1' },
      { detail: 'CORRELATED SCALAR SUBQUERY 1' },
      { detail: 'SCAN messages m' },
      { detail: 'USE TEMP B-TREE FOR ORDER BY' }
    ]
    const result = classifyExplainQueryPlanRows(rows)
    expect(result.total).toBe(4)
    expect(result.other).toBe(2)
    expect(result.scan).toBe(1)
    expect(result.tempBtreeOrderBy).toBe(1)
    expect(result.search).toBe(0)
  })

  it('counts every row exactly once and never retains raw detail strings', () => {
    const rows = [
      { detail: 'SCAN message_blocks_normalized nb' },
      { detail: 'USE TEMP B-TREE FOR ORDER BY' },
      { detail: 'SEARCH messages m USING INDEX messages_idx (created_at=?)' },
      { detail: 'SCAN topics t' }
    ]
    const result = classifyExplainQueryPlanRows(rows)
    expect(result.total).toBe(4)
    expect(result.search + result.scan + result.tempBtreeOrderBy + result.other).toBe(result.total)
    const json = JSON.stringify(result)
    expect(json).not.toContain('SCAN')
    expect(json).not.toContain('message_blocks_normalized')
  })

  it('is shape-agnostic: missing/unknown detail fields classify as other', () => {
    const result = classifyExplainQueryPlanRows([{ detail: undefined }, {}, { detail: null }, { detail: 42 }])
    expect(result).toEqual({ total: 4, search: 0, scan: 0, tempBtreeOrderBy: 0, other: 4 })
  })

  it('returns all-zero counts for an empty plan (no compiled query)', () => {
    expect(classifyExplainQueryPlanRows([])).toEqual({ total: 0, search: 0, scan: 0, tempBtreeOrderBy: 0, other: 0 })
  })

  it('holds the bucket-sum invariant on every sample', () => {
    const result = classifyExplainQueryPlanRows(SAMPLE_EQP_ROWS)
    expect(eqpClassificationInvariantErrors(result)).toEqual([])
  })
})

describe('classifyExplainBytecodeRows (shape-agnostic, privacy-safe)', () => {
  it('classifies the smallest stable opcode family set into finite counts', () => {
    const result = classifyExplainBytecodeRows(SAMPLE_BYTECODE_ROWS)
    expect(result).toEqual({
      total: 12,
      openEphemeral: 1,
      sort: 1,
      sorter: 2,
      makeRecord: 1,
      idxInsert: 1,
      resultRow: 1,
      seek: 1,
      other: 4
    })
  })

  it('keeps Sort distinct from the Sorter* family and Seek* family distinct', () => {
    const rows = [
      { opcode: 'Sort' },
      { opcode: 'SorterSort' },
      { opcode: 'SorterInsert' },
      { opcode: 'SeekRowid' },
      { opcode: 'SeekGE' },
      { opcode: 'SeekHit' }
    ]
    const result = classifyExplainBytecodeRows(rows)
    expect(result.sort).toBe(1)
    expect(result.sorter).toBe(2)
    expect(result.seek).toBe(3)
    expect(result.other).toBe(0)
    expect(result.total).toBe(6)
  })

  it('is shape-agnostic: missing/unknown opcode fields classify as other', () => {
    const result = classifyExplainBytecodeRows([{ opcode: undefined }, {}, { opcode: null }])
    expect(result.total).toBe(3)
    expect(result.other).toBe(3)
  })

  it('returns all-zero counts for an empty plan (no compiled query)', () => {
    expect(classifyExplainBytecodeRows([])).toEqual({
      total: 0,
      openEphemeral: 0,
      sort: 0,
      sorter: 0,
      makeRecord: 0,
      idxInsert: 0,
      resultRow: 0,
      seek: 0,
      other: 0
    })
  })

  it('never retains raw opcode strings in the classified output', () => {
    const result = classifyExplainBytecodeRows(SAMPLE_BYTECODE_ROWS)
    const json = JSON.stringify(result)
    expect(json).not.toContain('OpenEphemeral')
    expect(json).not.toContain('SeekRowid')
    expect(json).not.toContain('SorterOpen')
  })

  it('holds the bucket-sum invariant on every sample', () => {
    const result = classifyExplainBytecodeRows(SAMPLE_BYTECODE_ROWS)
    expect(opcodeClassificationInvariantErrors(result)).toEqual([])
  })
})

describe('classifier invariants and repeated-run determinism', () => {
  it('reports bucket-sum violations for a tampered EQP classification', () => {
    const problems = eqpClassificationInvariantErrors({
      total: 5,
      search: 2,
      scan: 1,
      tempBtreeOrderBy: 1,
      other: 0
    })
    expect(problems).toContain('EQP bucket sum 4 != total 5')
  })

  it('reports non-finite / negative counts as invariant violations', () => {
    const problems = opcodeClassificationInvariantErrors({
      total: 2,
      openEphemeral: 1,
      sort: -1,
      sorter: 0,
      makeRecord: 0,
      idxInsert: 0,
      resultRow: 0,
      seek: 0,
      other: 2
    })
    expect(problems.some((p) => p.includes("opcode count 'sort'"))).toBe(true)
  })

  it('planInvariantErrors covers all four stored classifications', () => {
    const plan = fixturePlans().get('simple-ascii')!
    expect(planInvariantErrors(plan)).toEqual([])
    const tampered = { ...plan, eqpRun2: { ...plan.eqpRun2, search: 99 } }
    expect(planInvariantErrors(tampered).length).toBeGreaterThan(0)
  })

  it('searchPlanRunsIdentical reports per-channel determinism', () => {
    const plan = fixturePlans().get('simple-ascii')!
    expect(searchPlanRunsIdentical(plan)).toEqual({ eqp: true, opcode: true })
    const divergentEqp = { ...plan, eqpRun2: { ...plan.eqpRun2, scan: plan.eqpRun2.scan + 1 } }
    expect(searchPlanRunsIdentical(divergentEqp)).toEqual({ eqp: false, opcode: true })
    const divergentOpcode = { ...plan, opcodeRun2: { ...plan.opcodeRun2, seek: plan.opcodeRun2.seek + 1 } }
    expect(searchPlanRunsIdentical(divergentOpcode)).toEqual({ eqp: true, opcode: false })
  })
})

describe('buildSearchStagePlanMetrics', () => {
  it('builds exactly 150 rows for the 10 real fixtures (10 × 15)', () => {
    expect(SEARCH_STAGE_PLAN_FIXTURES).toHaveLength(10)
    const metrics = buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, fixturePlans())
    expect(metrics).toHaveLength(150)
  })

  it('emits deterministic ids in fixture-major / row order', () => {
    const metrics = buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, fixturePlans())
    expect(metrics.map((m) => m.id)).toEqual(EXPECTED_IDS)
  })

  it('assigns unique ids (no duplicates)', () => {
    const metrics = buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, fixturePlans())
    const ids = metrics.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries finite unitless count values (no timing rows exist)', () => {
    const metrics = buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, fixturePlans())
    for (const metric of metrics) {
      expect(Number.isInteger(metric.value)).toBe(true)
      expect(metric.value).toBeGreaterThanOrEqual(0)
      expect(metric.unit).toBeUndefined()
    }
  })

  it('reports the run-1 classification counts verbatim', () => {
    const plans = fixturePlans()
    const metrics = buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, plans)
    const simple = plans.get('simple-ascii')!
    const byId = new Map(metrics.map((m) => [m.id, m.value]))
    expect(byId.get('fixture.simple-ascii.exactCount')).toBe(simple.exactCount)
    expect(byId.get('fixture.simple-ascii.eqpTotal')).toBe(simple.eqpRun1.total)
    expect(byId.get('fixture.simple-ascii.eqpSearch')).toBe(simple.eqpRun1.search)
    expect(byId.get('fixture.simple-ascii.eqpTempBtreeOrderBy')).toBe(simple.eqpRun1.tempBtreeOrderBy)
    expect(byId.get('fixture.simple-ascii.opcodeTotal')).toBe(simple.opcodeRun1.total)
    expect(byId.get('fixture.simple-ascii.opcodeResultRow')).toBe(simple.opcodeRun1.resultRow)
    expect(byId.get('fixture.simple-ascii.opcodeSeek')).toBe(simple.opcodeRun1.seek)
    expect(byId.get('fixture.simple-ascii.opcodeOther')).toBe(simple.opcodeRun1.other)
  })

  it('names rows deterministically without embedding raw planner strings', () => {
    const metrics = buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, fixturePlans())
    const byId = new Map(metrics.map((m) => [m.id, m.name]))
    expect(byId.get('fixture.simple-ascii.exactCount')).toBe('Fixture simple-ascii exact block count')
    expect(byId.get('fixture.simple-ascii.eqpSearch')).toBe('Fixture simple-ascii EXPLAIN QUERY PLAN SEARCH rows')
    expect(byId.get('fixture.simple-ascii.opcodeSorter')).toBe(
      'Fixture simple-ascii EXPLAIN opcode Sorter-family count'
    )
    for (const name of byId.values()) {
      expect(name).not.toMatch(/message_blocks|topics t|idx_|created_at|IN \(|FROM /)
    }
  })

  it('throws when classifications are missing entirely for a fixture', () => {
    const plans = fixturePlans()
    plans.delete('technical')
    expect(() => buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, plans)).toThrow(
      /no classification recorded for fixture 'technical'/
    )
  })

  it('throws on duplicate fixture ids', () => {
    const fixtures: SearchFixtureDescriptor[] = [
      SEARCH_STAGE_PLAN_FIXTURES[0],
      { id: 'simple-ascii', name: 'duplicate' }
    ]
    expect(() => buildSearchStagePlanMetrics(fixtures, fixturePlans())).toThrow(/duplicate fixture id 'simple-ascii'/)
  })

  it('throws on a non-ASCII / space-bearing fixture id', () => {
    const plans = fixturePlans()
    const empty: SearchStagePlanFixtureClassification = {
      exactCount: 0,
      eqpRun1: { total: 0, search: 0, scan: 0, tempBtreeOrderBy: 0, other: 0 },
      eqpRun2: { total: 0, search: 0, scan: 0, tempBtreeOrderBy: 0, other: 0 },
      opcodeRun1: {
        total: 0,
        openEphemeral: 0,
        sort: 0,
        sorter: 0,
        makeRecord: 0,
        idxInsert: 0,
        resultRow: 0,
        seek: 0,
        other: 0
      },
      opcodeRun2: {
        total: 0,
        openEphemeral: 0,
        sort: 0,
        sorter: 0,
        makeRecord: 0,
        idxInsert: 0,
        resultRow: 0,
        seek: 0,
        other: 0
      }
    }
    plans.set('bad id', empty)
    const fixtures: SearchFixtureDescriptor[] = [{ id: 'bad id', name: 'bad' }]
    expect(() => buildSearchStagePlanMetrics(fixtures, plans)).toThrow(/not a stable ASCII id/)
  })
})

describe('assertSearchStagePlanCompleteness', () => {
  it('passes and records the outcome when every fixture is complete and invariant-clean', () => {
    const outcome = assertSearchStagePlanCompleteness(SEARCH_STAGE_PLAN_FIXTURES, fixturePlans())
    expect(outcome.ok).toBe(true)
    expect(outcome.verifiedFixtures).toEqual(SEARCH_STAGE_PLAN_FIXTURES.map((f) => f.id))
    expect(outcome.expectedFixtureCount).toBe(10)
    expect(outcome.invariantsVerified).toBe(true)
  })

  it('throws when a fixture has no recorded classification', () => {
    const plans = fixturePlans()
    plans.delete('rare-term')
    expect(() => assertSearchStagePlanCompleteness(SEARCH_STAGE_PLAN_FIXTURES, plans)).toThrow(
      /no classification recorded for fixture 'rare-term'/
    )
  })

  it('throws on a non-finite / negative exactCount', () => {
    const plans = fixturePlans()
    plans.set('short-term', { ...plans.get('short-term')!, exactCount: -1 })
    expect(() => assertSearchStagePlanCompleteness(SEARCH_STAGE_PLAN_FIXTURES, plans)).toThrow(
      /exactCount is not a finite non-negative integer/
    )
  })

  it('throws on an invariant violation (bucket sum mismatch)', () => {
    const plans = fixturePlans()
    const simple = plans.get('simple-ascii')!
    plans.set('simple-ascii', { ...simple, eqpRun1: { ...simple.eqpRun1, other: simple.eqpRun1.other + 1 } })
    expect(() => assertSearchStagePlanCompleteness(SEARCH_STAGE_PLAN_FIXTURES, plans)).toThrow(
      /classifier invariants violated/
    )
  })
})

describe('assertSearchStagePlanNonVacuity (fail-fast corpus non-vacuity, audit F1)', () => {
  it('passes when normalized rows equal the expected block count and at least one exact count is positive', () => {
    const plans = fixturePlans() // every fixture has exactCount 40 + index * 4 (> 0)
    expect(() => assertSearchStagePlanNonVacuity(50_000, 50_000, plans)).not.toThrow()
    // Consistent non-zero corpora of any size also pass; the guard compares
    // the measured row count against the requested profile, not a fixed value.
    expect(() => assertSearchStagePlanNonVacuity(10_000, 10_000, plans)).not.toThrow()
  })

  it('throws when the normalized row count differs from the expected block count', () => {
    const plans = fixturePlans()
    expect(() => assertSearchStagePlanNonVacuity(49_999, 50_000, plans)).toThrow(
      /normalized message_blocks_normalized row count 49999 does not equal the expected profile block count 50000/
    )
    // An empty corpus row count is the vacuous-parity failure mode.
    expect(() => assertSearchStagePlanNonVacuity(0, 50_000, plans)).toThrow(
      /does not equal the expected profile block count/
    )
    // Non-numeric row counts never silently match the expected count.
    expect(() => assertSearchStagePlanNonVacuity(Number.NaN, 50_000, plans)).toThrow(
      /normalized message_blocks_normalized row count NaN/
    )
  })

  it('throws when every fixture has a non-positive exact count (vacuously empty run)', () => {
    const zeroPlans = fixturePlans()
    for (const plan of zeroPlans.values()) plan.exactCount = 0
    expect(() => assertSearchStagePlanNonVacuity(50_000, 50_000, zeroPlans)).toThrow(
      /no fixture recorded a positive exact block count/
    )
    const negativePlans = fixturePlans()
    for (const plan of negativePlans.values()) plan.exactCount = -1
    expect(() => assertSearchStagePlanNonVacuity(50_000, 50_000, negativePlans)).toThrow(
      /no fixture recorded a positive exact block count/
    )
  })
})

describe('plan-shaped schema-v1 artifact (closed contract)', () => {
  /** The exact artifact shape the bench file builds from real collection. */
  function planResult(): BenchmarkResult {
    const scale = searchStagePlanScale()
    const plans = fixturePlans()
    const metrics = buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, plans)
    // Mirrors the bench file: the gates report the guard's actual recorded
    // validation outcome (the guard throws on any mismatch before returning).
    const sampleValidation = assertSearchStagePlanCompleteness(SEARCH_STAGE_PLAN_FIXTURES, plans)
    return {
      schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
      benchmark: {
        id: SEARCH_STAGE_PLAN_BENCH_ID,
        name: SEARCH_STAGE_PLAN_BENCH_NAME,
        scale: {
          blocks: scale.blocks,
          profileCode: scale.profileCode,
          queryFixtures: SEARCH_STAGE_PLAN_FIXTURES.length,
          plannerRuns: SEARCH_STAGE_PLAN_PLANNER_RUNS,
          pageSize: SEARCH_STAGE_PLAN_PAGE_SIZE
        }
      },
      environment: {
        timestamp: '2026-08-15T06:00:00.000Z',
        node: 'v24.11.1',
        pnpm: '10.27.0',
        abiLane: 'node',
        abi: '137',
        command: SEARCH_STAGE_PLAN_COMMAND,
        git: { commit: '0'.repeat(40), dirty: true }
      },
      metrics,
      gates: [
        { id: 'parity.ordered', name: 'Ordered parity', kind: 'correctness', passed: true },
        { id: 'parity.no-duplicates', name: 'No duplicates', kind: 'correctness', passed: true },
        { id: 'plan.repeat-determinism', name: 'Repeated plan determinism', kind: 'correctness', passed: true },
        {
          id: 'plan.classifier-complete',
          name: `Every fixture classified with finite counts and recorded exactCount`,
          kind: 'correctness',
          passed: sampleValidation.ok,
          detail:
            `${sampleValidation.verifiedFixtures.length}/${sampleValidation.expectedFixtureCount} fixtures ` +
            `classified with finite counts (fail-fast guard passed before artifact build)`
        },
        {
          id: 'plan.classifier-invariants',
          name: 'Classifier invariants hold for every fixture',
          kind: 'correctness',
          passed: sampleValidation.ok,
          detail: sampleValidation.invariantsVerified
            ? 'EQP and opcode bucket sums equal totals for all fixtures; all counts finite non-negative integers'
            : 'classifier invariants not verified'
        }
      ]
    }
  }

  it('validates against the closed schema v1 contract', () => {
    expect(validateBenchmarkResult(planResult())).toEqual([])
  })

  it('carries the explicit canonical path-free command in environment', () => {
    const result = planResult()
    expect(result.environment.command).toBe('pnpm bench:search-stage-plan')
    expect(result.environment.command).not.toMatch(/[\\/]/)
  })

  it('derives the classifier gates from the recorded validation outcome, not a constant', () => {
    const result = planResult()
    const complete = result.gates.find((g) => g.id === 'plan.classifier-complete')
    const invariants = result.gates.find((g) => g.id === 'plan.classifier-invariants')
    const outcome = assertSearchStagePlanCompleteness(SEARCH_STAGE_PLAN_FIXTURES, fixturePlans())
    expect(complete).toMatchObject({ kind: 'correctness', passed: outcome.ok })
    expect(complete?.detail).toContain('10/10 fixtures')
    expect(invariants).toMatchObject({ kind: 'correctness', passed: outcome.ok })
  })

  it('never serializes planner strings, message content, credentials, or path fields', () => {
    const forbidden = [
      'content',
      'credential',
      'credentials',
      'password',
      'secret',
      'token',
      'apiKey',
      'dbPath',
      'dbSize',
      'profile',
      'userData',
      'attachment',
      'raw',
      'opcode',
      'comment',
      'p4'
    ]
    // `detail` is a legitimate closed-schema gate field; only its CONTENT is
    // privacy-constrained (asserted below on raw planner phrase shapes).
    const leafKeys: string[] = []
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collect(item)
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          leafKeys.push(key)
          collect(child)
        }
      }
    }
    collect(planResult())
    for (const sensitive of forbidden) {
      expect(leafKeys).not.toContain(sensitive)
    }
    const json = JSON.stringify(planResult())
    // Raw EXPLAIN/EQP detail shapes and schema identifiers never appear.
    expect(json).not.toContain('message_blocks_normalized')
    expect(json).not.toContain('USE TEMP B-TREE FOR ORDER BY')
    expect(json).not.toContain('block_id=')
    expect(json).not.toContain('idx_')
    expect(json).not.toContain('Lorem ipsum')
  })

  it('records exactly 150 finite unique count metrics and the deterministic scale', () => {
    const result = planResult()
    expect(result.metrics).toHaveLength(150)
    const ids = result.metrics.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const metric of result.metrics) {
      expect(Number.isInteger(metric.value)).toBe(true)
      expect(metric.value).toBeGreaterThanOrEqual(0)
    }
    expect(result.benchmark.scale).toEqual({
      blocks: 50_000,
      profileCode: 2,
      queryFixtures: 10,
      plannerRuns: 2,
      pageSize: 100
    })
    expect(result.benchmark.id).toBe('chatdb-search-stage-plan-50k')
  })

  it('keeps the plan benchmark id outside the search bench and stage families', () => {
    const profileIds = Object.values(SEARCH_BENCH_PROFILES).map((p) => p.id)
    expect(profileIds).not.toContain(SEARCH_STAGE_PLAN_BENCH_ID)
    expect(SEARCH_STAGE_PLAN_BENCH_ID).not.toBe('chatdb-search-stage-50k')
  })
})
