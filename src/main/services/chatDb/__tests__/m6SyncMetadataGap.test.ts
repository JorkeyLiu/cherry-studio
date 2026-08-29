/** Focused contract tests for the M6 synthetic sync metadata gap analysis. */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

import { registerChatDbNormalize, runMigrations } from '../migration'
import * as schema from '../schema'
import { validateBenchmarkResult } from './benchResult'
import {
  assembleM6SyncMetadataGapResult,
  assertM6FiniteMetrics,
  assertM6PrivacyInvariants,
  buildM6GapFingerprint,
  buildM6SyncMetadataGapGates,
  DEFAULT_M6_SYNC_GAP_SCALE,
  M6_EXCLUDED_TABLES,
  M6_EXPECTED_CANDIDATE_TABLE_COUNT,
  M6_EXPECTED_EXCLUDED_DOMAIN_COUNT,
  M6_EXPECTED_EXCLUDED_TABLE_COUNT,
  M6_GAP_CATEGORY_COUNT,
  M6_REQUIRED_TABLES,
  M6_SYNC_GAP_BENCH_ENV,
  M6_SYNC_GAP_BENCHMARK_ID,
  M6_SYNC_GAP_COMMAND,
  M6_SYNC_GAP_PROFILES,
  M6_SYNC_GAP_SCALE_ENV,
  m6SyncGapScaleMetadata,
  observeM6SyntheticSchema,
  resolveM6SyncGapGate,
  resolveM6SyncGapScale,
  summarizeM6SyncMetadataGap
} from './m6SyncMetadataGap'

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

const COMPLETE_OBSERVATION = {
  requiredTableCount: M6_EXPECTED_CANDIDATE_TABLE_COUNT,
  observedRequiredTableCount: M6_EXPECTED_CANDIDATE_TABLE_COUNT,
  excludedTableCount: M6_EXPECTED_EXCLUDED_TABLE_COUNT,
  observedExcludedTableCount: M6_EXPECTED_EXCLUDED_TABLE_COUNT,
  observedSyncMetadataColumnCount: 0,
  observedSyncMetadataTableCount: 0,
  syntheticOnly: true
} as const

describe('M6 default-off and bounded profile contracts', () => {
  it('is inert unless explicitly enabled with 1 or true', () => {
    expect(resolveM6SyncGapGate(undefined)).toBe(false)
    expect(resolveM6SyncGapGate('')).toBe(false)
    expect(resolveM6SyncGapGate('  ')).toBe(false)
    expect(resolveM6SyncGapGate('1')).toBe(true)
    expect(resolveM6SyncGapGate(' TRUE ')).toBe(true)
    for (const value of ['0', 'false', 'yes', 'on', '2']) {
      expect(() => resolveM6SyncGapGate(value)).toThrow(M6_SYNC_GAP_BENCH_ENV)
    }
  })

  it('accepts only the single bounded small profile', () => {
    expect(DEFAULT_M6_SYNC_GAP_SCALE).toBe('small')
    expect(resolveM6SyncGapScale(undefined)).toBe('small')
    expect(resolveM6SyncGapScale(' small ')).toBe('small')
    expect(M6_SYNC_GAP_SCALE_ENV).toBe('M6_SYNC_GAP_SCALE')
    expect(M6_SYNC_GAP_PROFILES.small.candidateTables).toBe(5)
    expect(M6_SYNC_GAP_PROFILES.small.excludedDomains).toBe(11)
    expect(() => resolveM6SyncGapScale('medium')).toThrow(M6_SYNC_GAP_SCALE_ENV)
    expect(Object.values(m6SyncGapScaleMetadata(M6_SYNC_GAP_PROFILES.small)).every(Number.isFinite)).toBe(true)
  })

  it('declares a path-free canonical command', () => {
    expect(M6_SYNC_GAP_COMMAND).toBe('pnpm bench:m6-sync-gap')
    expect(M6_SYNC_GAP_COMMAND).not.toMatch(/[\\/]/)
  })
})

describe('M6 fixed document-backed gap fingerprint', () => {
  it('is deterministic and closed to nine fixed categories', () => {
    expect(buildM6GapFingerprint()).toEqual(buildM6GapFingerprint())
    expect(buildM6GapFingerprint()).toHaveLength(M6_GAP_CATEGORY_COUNT)
    expect(buildM6GapFingerprint().map((category) => category.key)).toEqual([
      'revision-version',
      'ordering-cursor',
      'deletion-tombstone',
      'outbox-checkpoint',
      'device-local-leakage',
      'idempotence-atomicity',
      'checkpoint-boundary',
      'conflict-matrix',
      'extra-field-governance'
    ])
  })

  it('keeps schema absence separate from documented open design questions', () => {
    const categories = buildM6GapFingerprint()
    expect(categories.filter((category) => category.classification === 'schema-absent')).toHaveLength(4)
    expect(categories.filter((category) => category.classification === 'open-design')).toHaveLength(5)
    expect(categories.map((category) => category.classification)).toEqual([
      'schema-absent',
      'schema-absent',
      'schema-absent',
      'schema-absent',
      'open-design',
      'open-design',
      'open-design',
      'open-design',
      'open-design'
    ])
  })

  it('fails closed when the fingerprint is changed', () => {
    const categories = buildM6GapFingerprint().map((category) =>
      category.key === 'revision-version' ? { ...category, classification: 'open-design' as const } : category
    )
    const summary = summarizeM6SyncMetadataGap()
    const gates = buildM6SyncMetadataGapGates({
      categories,
      observation: COMPLETE_OBSERVATION,
      metrics: summary.metrics,
      expectedExcludedDomains: M6_EXPECTED_EXCLUDED_DOMAIN_COUNT
    })
    expect(gates.find((gate) => gate.id === 'fingerprint.closed')?.passed).toBe(false)
  })
})

describe('M6 numeric-only metrics, gates, and schema-v1 output', () => {
  it('builds deterministic numeric metrics and passing gates', () => {
    const summary = summarizeM6SyncMetadataGap()
    expect(summary.metrics.map((metric) => metric.id).slice(0, 10)).toEqual([
      'inventory.requiredTables',
      'inventory.observedRequiredTables',
      'inventory.excludedTables',
      'inventory.observedExcludedTables',
      'schema.syncMetadataColumns',
      'schema.syncMetadataTables',
      'category.count',
      'category.schemaAbsent.count',
      'category.openDesign.count',
      'excluded.domain.count'
    ])
    expect(summary.metrics.slice(10).map((metric) => metric.id)).toEqual([
      'category.revision-version.schema-absent',
      'category.ordering-cursor.schema-absent',
      'category.deletion-tombstone.schema-absent',
      'category.outbox-checkpoint.schema-absent',
      'category.device-local-leakage.open-design',
      'category.idempotence-atomicity.open-design',
      'category.checkpoint-boundary.open-design',
      'category.conflict-matrix.open-design',
      'category.extra-field-governance.open-design'
    ])
    expect(summary.metrics.find((metric) => metric.id === 'category.schemaAbsent.count')?.value).toBe(4)
    expect(summary.metrics.find((metric) => metric.id === 'category.openDesign.count')?.value).toBe(5)
    expect(summary.gates.every((gate) => gate.passed)).toBe(true)
    expect(() => assertM6FiniteMetrics(summary.metrics)).not.toThrow()
    expect(() => assertM6PrivacyInvariants(summary.metrics)).not.toThrow()
  })

  it('fails closed for observed metadata or non-synthetic state', () => {
    const summary = summarizeM6SyncMetadataGap({ ...COMPLETE_OBSERVATION, observedSyncMetadataColumnCount: 1 })
    expect(summary.gates.find((gate) => gate.id === 'schema.metadataAbsent')?.passed).toBe(false)

    const nonSynthetic = summarizeM6SyncMetadataGap({ ...COMPLETE_OBSERVATION, syntheticOnly: false })
    expect(nonSynthetic.gates.find((gate) => gate.id === 'analysis.syntheticOnly')?.passed).toBe(false)
  })

  it('fails closed when the scoped inventory loses its explicit excluded table', () => {
    const summary = summarizeM6SyncMetadataGap({ ...COMPLETE_OBSERVATION, observedExcludedTableCount: 0 })
    expect(summary.gates.find((gate) => gate.id === 'inventory.scoped')?.passed).toBe(false)
    expect(summary.gates.find((gate) => gate.id === 'excluded.domains')?.passed).toBe(true)
  })

  it('rejects unsafe or non-finite output', () => {
    expect(() => assertM6PrivacyInvariants([{ id: 'bad/path', name: 'bad', value: 1, unit: 'count' }])).toThrow(
      /path segment/
    )
    expect(() => assertM6PrivacyInvariants([{ id: 'bad', name: 'bad', value: Number.NaN, unit: 'count' }])).toThrow(
      /finite and non-negative/
    )
    expect(() => assertM6FiniteMetrics([{ id: 'negative', name: 'negative', value: -1, unit: 'count' }])).toThrow(
      /finite and non-negative/
    )
  })

  it('keeps the schema-v1 result closed and numeric-only', () => {
    const summary = summarizeM6SyncMetadataGap()
    const result = {
      schemaVersion: 1,
      benchmark: {
        id: 'chatdb-m6-sync-metadata-gap-small',
        name: 'M6 synthetic sync metadata gap fingerprint',
        scale: m6SyncGapScaleMetadata(M6_SYNC_GAP_PROFILES.small)
      },
      environment: {
        timestamp: '2026-08-29T00:00:00.000Z',
        node: 'v24.11.1',
        pnpm: '10.27.0',
        abiLane: 'node',
        abi: '137',
        command: M6_SYNC_GAP_COMMAND,
        git: { commit: '', dirty: false }
      },
      metrics: summary.metrics,
      gates: summary.gates
    }
    expect(validateBenchmarkResult(result)).toEqual([])
    expect(
      validateBenchmarkResult({
        ...result,
        metrics: [...result.metrics, { id: 'unsafe', name: 'unsafe', value: 1, unit: 'count', path: 'blocked' }]
      })
    ).not.toEqual([])
  })
})

describe('M6 enabled-path synthetic schema observation and assembly', () => {
  let tempRoot: string
  let sqlite: Database.Database

  beforeEach(() => {
    tempRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m6-sync-gap-test-'))
    sqlite = new Database(realPath.join(tempRoot, 'synthetic-chat.db'))
    sqlite.pragma('foreign_keys = ON')
    registerChatDbNormalize(sqlite)
    runMigrations(drizzle(sqlite, { schema }), sqlite)
  })

  afterEach(() => {
    sqlite.close()
    realFs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('observes the required schema and assembles a passing schema-v1 result on the enabled path', () => {
    const profile = M6_SYNC_GAP_PROFILES.small
    const observation = observeM6SyntheticSchema(sqlite, profile)

    expect(observation).toEqual({
      requiredTableCount: 5,
      observedRequiredTableCount: 5,
      excludedTableCount: 1,
      observedExcludedTableCount: 1,
      observedSyncMetadataColumnCount: 0,
      observedSyncMetadataTableCount: 0,
      syntheticOnly: true
    })
    expect(M6_REQUIRED_TABLES).toEqual([
      'topics',
      'messages',
      'message_blocks',
      'topic_segments',
      'topic_segment_messages'
    ])
    expect(M6_EXCLUDED_TABLES).toEqual(['file_references'])

    const result = assembleM6SyncMetadataGapResult({
      profile,
      observation,
      environment: {
        timestamp: '2026-08-29T00:00:00.000Z',
        node: 'v24.11.1',
        pnpm: '10.27.0',
        abiLane: 'node',
        abi: '137',
        command: M6_SYNC_GAP_COMMAND,
        git: { commit: '', dirty: false }
      }
    })

    expect(result.schemaVersion).toBe(1)
    expect(result.benchmark.id).toBe(M6_SYNC_GAP_BENCHMARK_ID)
    expect(result.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'inventory.requiredTables', value: 5 }),
        expect.objectContaining({ id: 'inventory.observedRequiredTables', value: 5 }),
        expect.objectContaining({ id: 'inventory.excludedTables', value: 1 }),
        expect.objectContaining({ id: 'inventory.observedExcludedTables', value: 1 }),
        expect.objectContaining({ id: 'schema.syncMetadataColumns', value: 0 }),
        expect.objectContaining({ id: 'schema.syncMetadataTables', value: 0 }),
        expect.objectContaining({ id: 'excluded.domain.count', value: 11 })
      ])
    )
    expect(result.metrics.find((metric) => metric.id === 'category.schemaAbsent.count')?.value).toBe(4)
    expect(result.metrics.find((metric) => metric.id === 'category.openDesign.count')?.value).toBe(5)
    expect(result.gates.every((gate) => gate.passed)).toBe(true)
    expect(validateBenchmarkResult(result)).toEqual([])
  })
})
