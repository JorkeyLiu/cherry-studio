/**
 * M6 sync metadata gap fingerprint — pure synthetic analysis helpers.
 *
 * This module inventories only the fixed, document-backed current-state
 * categories. It does not choose a sync design, authority, conflict rule,
 * schema shape, vendor, or transport. It is measurement-only and has no
 * production side effects.
 */

import type Database from 'better-sqlite3'

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkEnvironment,
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult
} from './benchResult'

export const M6_SYNC_GAP_BENCH_ENV = 'M6_SYNC_GAP_BENCH'
export const M6_SYNC_GAP_SCALE_ENV = 'M6_SYNC_GAP_SCALE'
export const M6_SYNC_GAP_COMMAND = 'pnpm bench:m6-sync-gap'
export const M6_SYNC_GAP_BENCH_NAME = 'M6 sync metadata gap fingerprint (synthetic, analysis-only, directional L3 only)'
export const M6_SYNC_GAP_BENCHMARK_ID = 'chatdb-m6-sync-metadata-gap-small'

export type M6SyncGapScaleKey = 'small'
export type M6GapClassification = 'schema-absent' | 'open-design'

export interface M6SyncGapProfile {
  readonly key: M6SyncGapScaleKey
  readonly candidateTables: number
  readonly excludedDomains: number
  readonly profileCode: number
}

export interface M6GapCategory {
  readonly key:
    | 'revision-version'
    | 'ordering-cursor'
    | 'deletion-tombstone'
    | 'outbox-checkpoint'
    | 'device-local-leakage'
    | 'idempotence-atomicity'
    | 'checkpoint-boundary'
    | 'conflict-matrix'
    | 'extra-field-governance'
  readonly classification: M6GapClassification
}

export interface M6SchemaObservation {
  readonly requiredTableCount: number
  readonly observedRequiredTableCount: number
  readonly excludedTableCount: number
  readonly observedExcludedTableCount: number
  readonly observedSyncMetadataColumnCount: number
  readonly observedSyncMetadataTableCount: number
  readonly syntheticOnly: boolean
}

export interface M6Summary {
  readonly categories: readonly M6GapCategory[]
  readonly metrics: readonly BenchmarkMetric[]
  readonly gates: readonly BenchmarkGate[]
}

export const M6_SYNC_GAP_PROFILES: Readonly<Record<M6SyncGapScaleKey, M6SyncGapProfile>> = {
  small: {
    key: 'small',
    candidateTables: 5,
    excludedDomains: 11,
    profileCode: 0
  }
}

export const DEFAULT_M6_SYNC_GAP_SCALE: M6SyncGapScaleKey = 'small'
export const M6_GAP_CATEGORY_COUNT = 9
export const M6_EXPECTED_CANDIDATE_TABLE_COUNT = 5
export const M6_EXPECTED_EXCLUDED_TABLE_COUNT = 1
export const M6_EXPECTED_EXCLUDED_DOMAIN_COUNT = 11
export const M6_MAX_DETAIL_BYTES = 256

/** The five migrated chat tables in scope for this synthetic analysis. */
export const M6_REQUIRED_TABLES = [
  'topics',
  'messages',
  'message_blocks',
  'topic_segments',
  'topic_segment_messages'
] as const

/** Existing schema tables explicitly outside the sync-domain inventory. */
export const M6_EXCLUDED_TABLES = ['file_references'] as const

/**
 * Safe identifiers used only for isolated schema introspection. These are
 * documented sync metadata concepts, not a proposal for future columns.
 */
export const M6_SYNC_METADATA_IDENTIFIERS = [
  'revision',
  'version',
  'sync_cursor',
  'checkpoint',
  'outbox',
  'inbox',
  'tombstone',
  'source_device'
] as const

const EXPECTED_M6_CATEGORIES: readonly M6GapCategory[] = [
  { key: 'revision-version', classification: 'schema-absent' },
  { key: 'ordering-cursor', classification: 'schema-absent' },
  { key: 'deletion-tombstone', classification: 'schema-absent' },
  { key: 'outbox-checkpoint', classification: 'schema-absent' },
  { key: 'device-local-leakage', classification: 'open-design' },
  { key: 'idempotence-atomicity', classification: 'open-design' },
  { key: 'checkpoint-boundary', classification: 'open-design' },
  { key: 'conflict-matrix', classification: 'open-design' },
  { key: 'extra-field-governance', classification: 'open-design' }
] as const

export function resolveM6SyncGapGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `${M6_SYNC_GAP_BENCH_ENV} must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the canonical \`${M6_SYNC_GAP_COMMAND}\` script.`
  )
}

export function resolveM6SyncGapScale(value: string | undefined): M6SyncGapScaleKey {
  if (value === undefined || value.trim().length === 0) return DEFAULT_M6_SYNC_GAP_SCALE
  if (value.trim() === DEFAULT_M6_SYNC_GAP_SCALE) return DEFAULT_M6_SYNC_GAP_SCALE
  throw new Error(
    `${M6_SYNC_GAP_SCALE_ENV} must be one of: ${DEFAULT_M6_SYNC_GAP_SCALE} ` +
      `(got '${value}'). The default profile is '${DEFAULT_M6_SYNC_GAP_SCALE}'.`
  )
}

export function m6SyncGapScaleMetadata(profile: M6SyncGapProfile): Record<string, number> {
  return {
    candidateTables: profile.candidateTables,
    excludedDomains: profile.excludedDomains,
    profileCode: profile.profileCode
  }
}

/**
 * Observe only the fixed required-table inventory on an owned SQLite handle.
 * The caller owns the handle and is responsible for applying the existing
 * schema-v1 migrations before calling this function.
 */
export function observeM6SyntheticSchema(
  sqlite: Database.Database,
  profile: M6SyncGapProfile = M6_SYNC_GAP_PROFILES[DEFAULT_M6_SYNC_GAP_SCALE]
): M6SchemaObservation {
  const tableRows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  const tableNames = new Set(tableRows.map((row) => row.name))
  const observedRequiredTableCount = M6_REQUIRED_TABLES.filter((tableName) => tableNames.has(tableName)).length

  const observedColumns = new Set<string>()
  for (const tableName of M6_REQUIRED_TABLES) {
    const columns = sqlite.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as Array<{ name: string }>
    for (const column of columns) observedColumns.add(column.name.toLowerCase())
  }
  const observedSyncMetadataColumnCount = M6_SYNC_METADATA_IDENTIFIERS.filter((identifier) =>
    observedColumns.has(identifier)
  ).length
  const observedSyncMetadataTableCount = tableRows.filter((row) =>
    M6_SYNC_METADATA_IDENTIFIERS.includes(row.name as (typeof M6_SYNC_METADATA_IDENTIFIERS)[number])
  ).length

  return {
    requiredTableCount: profile.candidateTables,
    observedRequiredTableCount,
    excludedTableCount: M6_EXCLUDED_TABLES.length,
    observedExcludedTableCount: M6_EXCLUDED_TABLES.filter((tableName) => tableNames.has(tableName)).length,
    observedSyncMetadataColumnCount,
    observedSyncMetadataTableCount,
    syntheticOnly: true
  }
}

export function buildM6GapFingerprint(): readonly M6GapCategory[] {
  return EXPECTED_M6_CATEGORIES.map((category) => ({ ...category }))
}

function assertFiniteNonNegativeInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a finite non-negative integer`)
  }
}

function boundedDetail(detail: string): string {
  if (detail.length === 0) throw new Error('M6 gate detail must be non-empty')
  if (Buffer.byteLength(detail, 'utf8') > M6_MAX_DETAIL_BYTES) {
    throw new Error(`M6 gate detail exceeds ${M6_MAX_DETAIL_BYTES} UTF-8 bytes`)
  }
  if (/[\\/]/.test(detail)) throw new Error('M6 gate detail must not contain path segments')
  return detail
}

function assertCategorySet(categories: readonly M6GapCategory[]): void {
  if (categories.length !== M6_GAP_CATEGORY_COUNT) throw new Error('M6 category set is incomplete')
  const expected = new Map(EXPECTED_M6_CATEGORIES.map((category) => [category.key, category]))
  const seen = new Set<string>()
  for (const category of categories) {
    if (seen.has(category.key)) throw new Error(`M6 category is duplicated: ${category.key}`)
    seen.add(category.key)
    const expectedCategory = expected.get(category.key)
    if (expectedCategory === undefined || category.classification !== expectedCategory.classification) {
      throw new Error(`M6 category fingerprint mismatch: ${category.key}`)
    }
  }
}

export function buildM6SyncMetadataGapMetrics(
  categories: readonly M6GapCategory[],
  observation: M6SchemaObservation
): BenchmarkMetric[] {
  assertCategorySet(categories)
  for (const [name, value] of Object.entries(observation)) {
    if (name !== 'syntheticOnly') assertFiniteNonNegativeInteger(value as number, `observation.${name}`)
  }

  const schemaAbsentCount = categories.filter((category) => category.classification === 'schema-absent').length
  const openDesignCount = categories.filter((category) => category.classification === 'open-design').length
  const metrics: BenchmarkMetric[] = [
    {
      id: 'inventory.requiredTables',
      name: 'Scoped required schema table count',
      value: observation.requiredTableCount,
      unit: 'count'
    },
    {
      id: 'inventory.observedRequiredTables',
      name: 'Observed scoped required schema table count',
      value: observation.observedRequiredTableCount,
      unit: 'count'
    },
    {
      id: 'inventory.excludedTables',
      name: 'Scoped excluded schema table count',
      value: observation.excludedTableCount,
      unit: 'count'
    },
    {
      id: 'inventory.observedExcludedTables',
      name: 'Observed scoped excluded schema table count',
      value: observation.observedExcludedTableCount,
      unit: 'count'
    },
    {
      id: 'schema.syncMetadataColumns',
      name: 'Observed sync metadata column count',
      value: observation.observedSyncMetadataColumnCount,
      unit: 'count'
    },
    {
      id: 'schema.syncMetadataTables',
      name: 'Observed sync metadata table count',
      value: observation.observedSyncMetadataTableCount,
      unit: 'count'
    },
    { id: 'category.count', name: 'Fixed documented category count', value: categories.length, unit: 'count' },
    {
      id: 'category.schemaAbsent.count',
      name: 'Schema-observable absent metadata category count',
      value: schemaAbsentCount,
      unit: 'count'
    },
    {
      id: 'category.openDesign.count',
      name: 'Documented open design question category count',
      value: openDesignCount,
      unit: 'count'
    },
    {
      id: 'excluded.domain.count',
      name: 'Explicitly excluded sync domain count',
      value: M6_EXPECTED_EXCLUDED_DOMAIN_COUNT,
      unit: 'count'
    }
  ]

  for (const category of categories) {
    metrics.push({
      id: `category.${category.key}.${category.classification}`,
      name: `Category classification: ${category.key}`,
      value: 1,
      unit: 'count'
    })
  }
  assertM6FiniteMetrics(metrics)
  return metrics
}

export interface M6GateInputs {
  readonly categories: readonly M6GapCategory[]
  readonly observation: M6SchemaObservation
  readonly metrics: readonly BenchmarkMetric[]
  readonly expectedExcludedDomains: number
}

export function buildM6SyncMetadataGapGates(inputs: M6GateInputs): BenchmarkGate[] {
  const { categories, observation, metrics, expectedExcludedDomains } = inputs
  const fingerprintMatches = (() => {
    try {
      assertCategorySet(categories)
      return true
    } catch {
      return false
    }
  })()
  const finitePassed = metrics.every((metric) => Number.isFinite(metric.value) && metric.value >= 0)
  const privacyPassed = assertM6PrivacyInvariants(metrics, false)
  const inventoryPassed =
    observation.requiredTableCount === M6_EXPECTED_CANDIDATE_TABLE_COUNT &&
    observation.observedRequiredTableCount === observation.requiredTableCount &&
    observation.excludedTableCount === M6_EXPECTED_EXCLUDED_TABLE_COUNT &&
    observation.observedExcludedTableCount === observation.excludedTableCount
  const metadataAbsentPassed =
    observation.observedSyncMetadataColumnCount === 0 && observation.observedSyncMetadataTableCount === 0
  const schemaAbsentCount = categories.filter((category) => category.classification === 'schema-absent').length
  const openDesignCount = categories.filter((category) => category.classification === 'open-design').length
  const classificationPassed =
    fingerprintMatches &&
    schemaAbsentCount === 4 &&
    openDesignCount === 5 &&
    schemaAbsentCount + openDesignCount === M6_GAP_CATEGORY_COUNT
  const exclusionPassed = expectedExcludedDomains === M6_EXPECTED_EXCLUDED_DOMAIN_COUNT

  return [
    {
      id: 'inventory.scoped',
      name: 'Synthetic schema-v1 scoped table inventory is complete',
      kind: 'correctness',
      passed: inventoryPassed,
      detail: boundedDetail(
        `required=${observation.requiredTableCount} observed=${observation.observedRequiredTableCount} excluded=${observation.excludedTableCount} excludedObserved=${observation.observedExcludedTableCount}`
      )
    },
    {
      id: 'schema.metadataAbsent',
      name: 'Schema-observable sync metadata columns and tables remain absent',
      kind: 'correctness',
      passed: metadataAbsentPassed,
      detail: boundedDetail(
        `columns=${observation.observedSyncMetadataColumnCount} tables=${observation.observedSyncMetadataTableCount}`
      )
    },
    {
      id: 'fingerprint.closed',
      name: 'Closed fixed gap fingerprint classification',
      kind: 'correctness',
      passed: classificationPassed,
      detail: boundedDetail(`schemaAbsent=${schemaAbsentCount} openDesign=${openDesignCount}`)
    },
    {
      id: 'excluded.domains',
      name: 'Explicitly excluded sync domains are not counted as absent metadata',
      kind: 'correctness',
      passed: exclusionPassed,
      detail: boundedDetail(`excluded=${expectedExcludedDomains}`)
    },
    {
      id: 'analysis.syntheticOnly',
      name: 'Analysis uses synthetic isolated state only',
      kind: 'correctness',
      passed: observation.syntheticOnly,
      detail: boundedDetail(`syntheticOnly=${observation.syntheticOnly ? 'true' : 'false'}`)
    },
    {
      id: 'metrics.finite',
      name: 'All M6 metric values finite and non-negative',
      kind: 'correctness',
      passed: finitePassed,
      detail: boundedDetail(`finite=${finitePassed ? 'true' : 'false'}`)
    },
    {
      id: 'output.privacy',
      name: 'Closed numeric-only privacy output',
      kind: 'correctness',
      passed: privacyPassed,
      detail: boundedDetail(`privacy=${privacyPassed ? 'valid' : 'invalid'}`)
    }
  ]
}

export function summarizeM6SyncMetadataGap(
  observation: M6SchemaObservation = {
    requiredTableCount: M6_EXPECTED_CANDIDATE_TABLE_COUNT,
    observedRequiredTableCount: M6_EXPECTED_CANDIDATE_TABLE_COUNT,
    excludedTableCount: M6_EXPECTED_EXCLUDED_TABLE_COUNT,
    observedExcludedTableCount: M6_EXPECTED_EXCLUDED_TABLE_COUNT,
    observedSyncMetadataColumnCount: 0,
    observedSyncMetadataTableCount: 0,
    syntheticOnly: true
  }
): M6Summary {
  const categories = buildM6GapFingerprint()
  const metrics = buildM6SyncMetadataGapMetrics(categories, observation)
  const gates = buildM6SyncMetadataGapGates({
    categories,
    observation,
    metrics,
    expectedExcludedDomains: M6_EXPECTED_EXCLUDED_DOMAIN_COUNT
  })
  return { categories, metrics, gates }
}

export interface AssembleM6SyncMetadataGapResultParams {
  readonly profile: M6SyncGapProfile
  readonly observation: M6SchemaObservation
  readonly environment: BenchmarkEnvironment
}

/** Assemble the closed schema-v1 result without writing an artifact. */
export function assembleM6SyncMetadataGapResult(params: AssembleM6SyncMetadataGapResultParams): BenchmarkResult {
  const categories = buildM6GapFingerprint()
  const metrics = buildM6SyncMetadataGapMetrics(categories, params.observation)
  const gates = buildM6SyncMetadataGapGates({
    categories,
    observation: params.observation,
    metrics,
    expectedExcludedDomains: params.profile.excludedDomains
  })

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: M6_SYNC_GAP_BENCHMARK_ID,
      name: M6_SYNC_GAP_BENCH_NAME,
      scale: m6SyncGapScaleMetadata(params.profile)
    },
    environment: params.environment,
    metrics,
    gates
  }
}

export function assertM6FiniteMetrics(metrics: readonly BenchmarkMetric[]): void {
  for (const metric of metrics) {
    if (!Number.isFinite(metric.value) || metric.value < 0) {
      throw new Error(`M6 metric ${metric.id} must be finite and non-negative`)
    }
  }
}

export function assertM6PrivacyInvariants(metrics: readonly BenchmarkMetric[], throwOnFailure = true): boolean {
  try {
    for (const metric of metrics) {
      if (!/^[A-Za-z0-9._-]+$/.test(metric.id)) {
        throw new Error(`M6 metric id contains a path segment or is not closed: ${metric.id}`)
      }
      if (/[\\/]/.test(metric.name)) throw new Error(`M6 metric name contains a path segment: ${metric.id}`)
      if (!Number.isFinite(metric.value) || metric.value < 0) {
        throw new Error(`M6 metric ${metric.id} must be finite and non-negative`)
      }
      if (metric.unit !== 'count') throw new Error(`M6 metric ${metric.id} must use count units`)
    }
    return true
  } catch (error) {
    if (throwOnFailure) throw error
    return false
  }
}
