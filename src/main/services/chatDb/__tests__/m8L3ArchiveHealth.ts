/**
 * M8 Backup/restore L3 archive metadata health — pure helpers (measurement-only).
 *
 * Diagnostic, read-only w.r.t production/user state; synthetic owned mkdtemp
 * roots are permitted for temporary backup/restore writes.
 *
 * This module is the pure, side-effect-free half:
 *   - env gate (inactive by default, strict parsing)
 *   - bounded synthetic scale matrix (M8-S0/S1/S1-wide)
 *   - deterministic fixture math (file lengths, byte rule, SHA-256 helpers)
 *   - bounded detail, metric/gate ID validation, timing stats, sample completeness
 *
 * This file is intentionally NOT a *.test.ts / *.bench.ts file so it is never
 * collected directly by Vitest. It imports no native modules, so its focused
 * unit tests stay in the core lane.
 */

import { createHash } from 'node:crypto'

import type { BenchmarkGate, BenchmarkMetric } from './benchResult'

// ---------------------------------------------------------------------------
// Env gate — diagnostic runs ONLY when explicitly enabled
// ---------------------------------------------------------------------------

export const M8_L3_ARCHIVE_BENCH_ENV = 'M8_L3_ARCHIVE_BENCH'

/**
 * Deterministically resolve the M8 gate.
 * - unset / empty / whitespace-only → disabled (default; no temp roots, no artifact)
 * - `1` or `true` (case-insensitive) → enabled
 * - any other non-empty value → throws loudly
 */
export function resolveM8L3ArchiveGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `M8_L3_ARCHIVE_BENCH must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the canonical \`pnpm bench:m8-l3-archive\` script.`
  )
}

// ---------------------------------------------------------------------------
// Bounded scale matrix — S0/S1 only, no S2/S3, directional diagnostic
// ---------------------------------------------------------------------------

export const M8_WARMUP_ROUNDS = 1
export const M8_MEASURE_ROUNDS = 5

export const M8_L3_ARCHIVE_BENCH_ID = 'chatdb-m8-l3-archive-health'
export const M8_L3_ARCHIVE_BENCH_NAME =
  'Backup/restore L3 archive metadata health (diagnostic, synthetic, directional L3 only)'
export const M8_L3_ARCHIVE_COMMAND = 'pnpm bench:m8-l3-archive'

export interface M8Scenario {
  readonly suffix: 's0' | 's1' | 's1wide'
  readonly label: string
  readonly topics: number
  readonly messages: number
  readonly blocks: number
  readonly fileEntries: number
  readonly fileBytes: number
}

export const M8_SCENARIOS: readonly M8Scenario[] = [
  {
    suffix: 's0',
    label: 'M8-S0',
    topics: 1,
    messages: 100,
    blocks: 100,
    fileEntries: 4,
    fileBytes: 4096
  },
  {
    suffix: 's1',
    label: 'M8-S1',
    topics: 10,
    messages: 1000,
    blocks: 1000,
    fileEntries: 32,
    fileBytes: 65536
  },
  {
    suffix: 's1wide',
    label: 'M8-S1-wide',
    topics: 25,
    messages: 5000,
    blocks: 5000,
    fileEntries: 128,
    fileBytes: 262144
  }
] as const

export const M8_SCENARIO_COUNT = M8_SCENARIOS.length

// ---------------------------------------------------------------------------
// Deterministic fixture math
// ---------------------------------------------------------------------------

/**
 * Deterministic file payload byte value.
 * Mirrors (fileIndex + byteOffset) mod 251.
 */
export function deterministicFileByte(fileIndex: number, byteOffset: number): number {
  return (fileIndex + byteOffset) % 251
}

/**
 * Deterministic file lengths for a scenario's Data/Files fixture.
 * Exactly fileEntries files, each floor(fileBytes/fileEntries) plus remainder
 * distributed one byte to the first (fileBytes % fileEntries) files.
 */
export function fileLengthsForScenario(fileBytes: number, fileEntries: number): number[] {
  if (fileEntries <= 0) throw new Error('fileLengthsForScenario: fileEntries must be >0')
  if (fileBytes < 0) throw new Error('fileLengthsForScenario: fileBytes must be >=0')
  const base = Math.floor(fileBytes / fileEntries)
  const remainder = fileBytes % fileEntries
  const lengths: number[] = []
  for (let i = 0; i < fileEntries; i++) {
    lengths.push(base + (i < remainder ? 1 : 0))
  }
  const sum = lengths.reduce((a, b) => a + b, 0)
  if (sum !== fileBytes) throw new Error(`fileLengthsForScenario: sum ${sum} != ${fileBytes}`)
  return lengths
}

/**
 * Scale metadata — finite numeric only, closed schema.
 */
export function m8Scale(): Record<string, number> {
  return {
    scenarioCount: M8_SCENARIO_COUNT,
    topics_s0: M8_SCENARIOS[0].topics,
    messages_s0: M8_SCENARIOS[0].messages,
    blocks_s0: M8_SCENARIOS[0].blocks,
    fileEntries_s0: M8_SCENARIOS[0].fileEntries,
    fileBytes_s0: M8_SCENARIOS[0].fileBytes,
    topics_s1: M8_SCENARIOS[1].topics,
    messages_s1: M8_SCENARIOS[1].messages,
    blocks_s1: M8_SCENARIOS[1].blocks,
    fileEntries_s1: M8_SCENARIOS[1].fileEntries,
    fileBytes_s1: M8_SCENARIOS[1].fileBytes,
    topics_s1wide: M8_SCENARIOS[2].topics,
    messages_s1wide: M8_SCENARIOS[2].messages,
    blocks_s1wide: M8_SCENARIOS[2].blocks,
    fileEntries_s1wide: M8_SCENARIOS[2].fileEntries,
    fileBytes_s1wide: M8_SCENARIOS[2].fileBytes,
    warmupRounds: M8_WARMUP_ROUNDS,
    measuredSamples: M8_MEASURE_ROUNDS
  }
}

// ---------------------------------------------------------------------------
// Bounded detail (M8 producer-level max 256 UTF-8 bytes)
// ---------------------------------------------------------------------------

export const M8_MAX_DETAIL_BYTES = 256

export function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Validate that a gate detail string is bounded, non-empty UTF-8 <=256 bytes.
 * Throws on violation — fail-closed, no artifact.
 */
export function assertBoundedDetail(detail: string): void {
  if (typeof detail !== 'string' || detail.length === 0) {
    throw new Error('bounded detail must be a non-empty string')
  }
  const bytes = byteLengthUtf8(detail)
  if (bytes > M8_MAX_DETAIL_BYTES) {
    throw new Error(`bounded detail exceeds ${M8_MAX_DETAIL_BYTES} bytes (got ${bytes})`)
  }
  if (/[\\/]/.test(detail) && detail.includes('/')) {
    // Path-bearing details are discouraged; but we don't reject all slashes
    // because bounded counts/details may contain "a/b" safely. The validator
    // forbids paths in benchmark metadata; here we only enforce size.
  }
}

/**
 * Build a bounded detail string, validating byte length. Helper for gates.
 */
export function boundedDetail(detail: string): string {
  assertBoundedDetail(detail)
  return detail
}

// ---------------------------------------------------------------------------
// Timing stats (nearest-rank p50/p95, mean, min, max)
// ---------------------------------------------------------------------------

export interface M8TimingStats {
  p50: number
  p95: number
  mean: number
  min: number
  max: number
}

export function computeM8TimingStats(samples: readonly number[]): M8TimingStats {
  if (samples.length === 0) throw new Error('computeM8TimingStats: empty sample set')
  for (const v of samples) {
    if (!Number.isFinite(v)) throw new Error('computeM8TimingStats: sample must be finite number')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (p: number): number => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)]
  }
  return {
    p50: percentile(50),
    p95: percentile(95),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1]
  }
}

// ---------------------------------------------------------------------------
// Production exclusion set (must mirror BackupManager.EXCLUDED_DATA_ENTRIES)
// ---------------------------------------------------------------------------

export const M8_PRODUCTION_EXCLUDED_BASENAMES: ReadonlySet<string> = new Set([
  'chat.db-wal',
  'chat.db-shm',
  'chat.db.backup',
  'chat-import-candidates',
  'promotion-journal.json',
  'promotion-journal.json.staging',
  'rollback-snapshot.json',
  'rollback-snapshot.json.staging',
  'files-rollback-snapshot',
  'files-rollback-snapshot.staging',
  'files-rollback-snapshot.old',
  'files-promote-staging',
  'files-catalog-snapshot.json',
  'files-catalog-snapshot.json.staging'
])

/**
 * Check if an archive entry corresponds to a production-excluded artifact.
 * chat.db itself is authoritative and must NOT be treated as excluded;
 * the caller handles authoritative presence separately.
 */
export function isProductionExcludedEntry(entryName: string): boolean {
  const base = entryName.includes('/') ? (entryName.split('/').pop() ?? entryName) : entryName
  if (M8_PRODUCTION_EXCLUDED_BASENAMES.has(base)) return true
  if (M8_PRODUCTION_EXCLUDED_BASENAMES.has(entryName)) return true
  if (entryName.startsWith('Data/chat.db-wal') || entryName.startsWith('Data/chat.db-shm')) return true
  return false
}

// ---------------------------------------------------------------------------
// Metric / gate ID validation
// ---------------------------------------------------------------------------

export const M8_METRIC_SUFFIXES = ['s0', 's1', 's1wide'] as const
export type M8MetricSuffix = (typeof M8_METRIC_SUFFIXES)[number]

export const M8_METRIC_KINDS = [
  'backup_ms',
  'restore_ms',
  'metadata_bytes',
  'archive_entry_count',
  'archive_compressed_bytes'
] as const

export const M8_GATE_KINDS = [
  'metadata_v7',
  'archive_safety',
  'chat_db_presence',
  'excluded_absence',
  'snapshot_integrity',
  'restore_parity',
  'sample_completeness'
] as const

const M8_SUFFIX_PATTERN = /^(s0|s1|s1wide)$/

export function isValidM8Suffix(suffix: string): boolean {
  return M8_SUFFIX_PATTERN.test(suffix)
}

// ---------------------------------------------------------------------------
// Sample completeness guard
// ---------------------------------------------------------------------------

export interface M8SampleValidation {
  readonly ok: true
  readonly verifiedScenarios: readonly string[]
  readonly expectedCount: number
}

export function assertM8SampleCounts(
  samples: ReadonlyMap<string, readonly number[]>,
  expectedCount: number
): M8SampleValidation {
  for (const scenario of M8_SCENARIOS) {
    const arr = samples.get(scenario.suffix)
    if (arr === undefined) {
      throw new Error(
        `assertM8SampleCounts: no samples recorded for scenario '${scenario.suffix}' (expected ${expectedCount})`
      )
    }
    if (arr.length !== expectedCount) {
      throw new Error(
        `assertM8SampleCounts: scenario '${scenario.suffix}' has ${arr.length} samples, expected exactly ${expectedCount}`
      )
    }
  }
  return { ok: true, verifiedScenarios: M8_SCENARIOS.map((s) => s.suffix), expectedCount }
}

// ---------------------------------------------------------------------------
// Snapshot integrity — independent pre-staging validation helper
// ---------------------------------------------------------------------------

/**
 * Snapshot integrity gate is an independent pre-staging validation over the
 * archived Data/chat.db bytes, distinct from metadata/exclusion gates.
 * Returns true when the extracted snapshot passes read-only production-compatible
 * integrity (open + integrity_check + foreign_key_check via validateReadonlyChatDb).
 * Fail-closed: any error or non-null validation is false.
 */
export function isSnapshotIntegrityPass(
  snapshotDbPath: string,
  validate: (p: string, sample: number) => unknown
): boolean {
  try {
    const result = validate(snapshotDbPath, 2)
    return result === null
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Deterministic DB parity digest (internal, never emitted)
// ---------------------------------------------------------------------------

/**
 * Internal canonical SHA-256 logical digest for a seeded source DB or
 * staged/restored DB. Includes prescribed numeric IDs, topic/message/block
 * relationships, counts, content lengths/bytes (canonical payload fields), and
 * sorted deterministic ordering. Digest value is internal only — callers must
 * compare digests without emitting them.
 *
 * Canonicalization rules:
 * - Fetches rows without ORDER BY; ordering is imposed strictly in code by
 *   numeric fixture IDs (never textual query order or raw identifier spelling).
 * - Every row class is normalized to complete numeric fixture IDs/relationships,
 *   counts, content byte lengths and deterministic ordering/content fields.
 * - Serialization uses only numeric IDs and byte lengths — raw id strings are
 *   never hashed directly; relationships are numeric.
 */
export function computeM8LogicalDigest(sqlite: {
  prepare: (sql: string) => { get: () => unknown; all: () => unknown[] }
}): string {
  const h = createHash('sha256')

  // No ORDER BY — ordering is imposed deterministically in JS by numeric IDs
  const topics = sqlite.prepare('SELECT id, name, created_at FROM topics').all() as Array<{
    id: string
    name: string
    created_at: string
  }>
  const messages = sqlite
    .prepare('SELECT id, topic_id, role, content, status, created_at, sort_order FROM messages')
    .all() as Array<{
    id: string
    topic_id: string
    role: string
    content: string
    status: string
    created_at: string
    sort_order: number
  }>
  const blocks = sqlite.prepare('SELECT id, message_id, type, content, sort_order FROM message_blocks').all() as Array<{
    id: string
    message_id: string
    type: string
    content: string
    sort_order: number
  }>

  const numericId = (id: string, prefix: string): number => {
    if (!id.startsWith(prefix)) throw new Error(`digest id ${id} missing prefix ${prefix}`)
    const n = Number.parseInt(id.slice(prefix.length), 10)
    if (!Number.isFinite(n) || String(n) !== id.slice(prefix.length))
      throw new Error(`digest id ${id} non-numeric suffix`)
    return n
  }

  // Strict numeric-ID order for all classes (deterministic, not query-order dependent)
  topics.sort((a, b) => numericId(a.id, 't') - numericId(b.id, 't'))
  messages.sort((a, b) => numericId(a.id, 'm') - numericId(b.id, 'm'))
  blocks.sort((a, b) => numericId(a.id, 'b') - numericId(b.id, 'b'))

  // Header counts (numeric only)
  h.update(`counts|topics:${topics.length}|messages:${messages.length}|blocks:${blocks.length}\n`)
  // Topics: numeric id, name byte length, created_at byte length
  for (const t of topics) {
    const n = numericId(t.id, 't')
    const nameLen = Buffer.byteLength(t.name ?? '', 'utf8')
    const createdLen = Buffer.byteLength(t.created_at ?? '', 'utf8')
    h.update(`topic|n:${n}|nameLen:${nameLen}|createdLen:${createdLen}\n`)
  }
  // Messages: numeric id, numeric topic relationship, sort_order, role/status/created byte lengths, content byte length
  for (const m of messages) {
    const n = numericId(m.id, 'm')
    const topicN = numericId(m.topic_id, 't')
    if (!Number.isFinite(m.sort_order)) throw new Error(`digest message m${n} sort_order non-finite`)
    const contentLen = Buffer.byteLength(m.content ?? '', 'utf8')
    const roleLen = Buffer.byteLength(m.role ?? '', 'utf8')
    const statusLen = Buffer.byteLength(m.status ?? '', 'utf8')
    const createdLen = Buffer.byteLength(m.created_at ?? '', 'utf8')
    h.update(
      `msg|n:${n}|topicN:${topicN}|sort:${m.sort_order}|roleLen:${roleLen}|statusLen:${statusLen}|createdLen:${createdLen}|contentLen:${contentLen}\n`
    )
  }
  // Blocks: numeric id, numeric message relationship, type byte length, content byte length, sort_order
  for (const b of blocks) {
    const n = numericId(b.id, 'b')
    const msgN = numericId(b.message_id, 'm')
    const contentLen = Buffer.byteLength(b.content ?? '', 'utf8')
    const typeLen = Buffer.byteLength(b.type ?? '', 'utf8')
    if (!Number.isFinite(b.sort_order)) throw new Error(`digest block b${n} sort_order non-finite`)
    h.update(`block|n:${n}|msgN:${msgN}|typeLen:${typeLen}|contentLen:${contentLen}|sort:${b.sort_order}\n`)
  }
  return h.digest('hex')
}

/**
 * Assert digest parity between source and staged/restored DBs. Computes
 * canonical SHA-256 logical digests for both and throws on mismatch.
 * Does NOT emit digest values.
 */
export function assertM8DigestParity(
  sourceSqlite: { prepare: (sql: string) => { get: () => unknown; all: () => unknown[] } },
  stagedSqlite: { prepare: (sql: string) => { get: () => unknown; all: () => unknown[] } }
): void {
  const a = computeM8LogicalDigest(sourceSqlite)
  const b = computeM8LogicalDigest(stagedSqlite)
  if (a !== b) throw new Error('db parity digest mismatch between source and staged')
}

// ---------------------------------------------------------------------------
// Data/Files exact-set parity (complete directory listing, no filter)
// ---------------------------------------------------------------------------

export interface M8FilesParityResult {
  count: number
  bytes: number
  hashHex: string
}

/**
 * Validate that filesDir contains the complete expected numeric fixture file set
 * using the full directory listing:
 * - exactly fileEntries entries, exactly the sorted expected set file-<index>.bin
 * - no missing, no unexpected entries
 * - every expected entry must be a regular file
 * - byte count and SHA-256 over exact sorted set must match
 * Throws on mismatch. Does not include raw names in thrown artifact details.
 */
export function assertFilesParityExactSet(
  allEntries: string[],
  fileBuffersSorted: Buffer[],
  expectedCount: number,
  expectedBytes: number,
  expectedHash: string
): void {
  if (allEntries.length !== expectedCount)
    throw new Error(`files parity complete listing count ${allEntries.length} != ${expectedCount}`)
  const expectedNames = Array.from({ length: expectedCount }, (_, i) => `file-${i}.bin`)
  const sortedActual = [...allEntries].sort((a, b) => {
    const ai = Number.parseInt(a.slice(5).split('.')[0] ?? 'NaN', 10)
    const bi = Number.parseInt(b.slice(5).split('.')[0] ?? 'NaN', 10)
    if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi
    return a.localeCompare(b)
  })
  const sortedExpected = [...expectedNames].sort((a, b) => {
    const ai = Number.parseInt(a.slice(5), 10)
    const bi = Number.parseInt(b.slice(5), 10)
    return ai - bi
  })
  if (sortedActual.length !== sortedExpected.length || sortedActual.some((v, i) => v !== sortedExpected[i])) {
    throw new Error('files parity complete set mismatch')
  }
  if (fileBuffersSorted.length !== expectedCount) throw new Error(`files parity buffers length mismatch`)
  let total = 0
  for (const b of fileBuffersSorted) total += b.length
  if (total !== expectedBytes) throw new Error(`files parity bytes ${total} != ${expectedBytes}`)
  // Verify hash matches expected (caller provides expectedHex); compute locally for fail-closed
  const h = createHash('sha256')
  for (const buf of fileBuffersSorted) h.update(buf)
  const actualHash = h.digest('hex')
  if (actualHash !== expectedHash) throw new Error('files parity hash mismatch')
}

// ---------------------------------------------------------------------------
// Metric builder
// ---------------------------------------------------------------------------

export interface M8PerScenarioSamples {
  backupMs: readonly number[]
  restoreMs: readonly number[]
  metadataBytes: readonly number[]
  archiveEntryCount: readonly number[]
  archiveCompressedBytes: readonly number[]
}

export type M8SamplesByScenario = ReadonlyMap<M8MetricSuffix, M8PerScenarioSamples>

/**
 * Build 15 finite numeric metrics (5 per scenario: 3 scenarios).
 * Each per-scenario metric is the mean of its measured samples.
 * All values must be finite numbers.
 */
export function buildM8Metrics(samplesByScenario: M8SamplesByScenario): BenchmarkMetric[] {
  const metrics: BenchmarkMetric[] = []
  const seenIds = new Set<string>()
  for (const scenario of M8_SCENARIOS) {
    const entry = samplesByScenario.get(scenario.suffix)
    if (!entry) throw new Error(`buildM8Metrics: no samples recorded for scenario '${scenario.suffix}'`)
    const kinds: Array<{ kind: (typeof M8_METRIC_KINDS)[number]; values: readonly number[]; unit?: string }> = [
      { kind: 'backup_ms', values: entry.backupMs, unit: 'ms' },
      { kind: 'restore_ms', values: entry.restoreMs, unit: 'ms' },
      { kind: 'metadata_bytes', values: entry.metadataBytes },
      { kind: 'archive_entry_count', values: entry.archiveEntryCount },
      { kind: 'archive_compressed_bytes', values: entry.archiveCompressedBytes, unit: 'bytes' }
    ]
    for (const { kind, values, unit } of kinds) {
      const id = `${kind}_${scenario.suffix}`
      if (seenIds.has(id)) throw new Error(`buildM8Metrics: duplicate metric id '${id}'`)
      seenIds.add(id)
      if (values.length === 0)
        throw new Error(`buildM8Metrics: scenario '${scenario.suffix}' kind '${kind}' has no values`)
      for (const v of values) {
        if (!Number.isFinite(v))
          throw new Error(`buildM8Metrics: scenario '${scenario.suffix}' kind '${kind}' has non-finite value ${v}`)
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length
      if (!Number.isFinite(mean)) throw new Error(`buildM8Metrics: mean non-finite for ${id}`)
      const metric: BenchmarkMetric = {
        id,
        name: `${scenario.label} ${kind}`,
        value: mean
      }
      if (unit) metric.unit = unit
      metrics.push(metric)
    }
  }
  return metrics
}

// ---------------------------------------------------------------------------
// Gate builder
// ---------------------------------------------------------------------------

export interface M8GateInputs {
  /** per-suffix boolean + detail */
  [suffix: string]: {
    metadataV7: { passed: boolean; detail: string }
    archiveSafety: { passed: boolean; detail: string }
    chatDbPresence: { passed: boolean; detail: string }
    excludedAbsence: { passed: boolean; detail: string }
    snapshotIntegrity: { passed: boolean; detail: string }
    restoreParity: { passed: boolean; detail: string }
    sampleCompleteness: { passed: boolean; detail: string }
  }
}

export function buildM8Gates(inputs: M8GateInputs): BenchmarkGate[] {
  const gates: BenchmarkGate[] = []
  for (const scenario of M8_SCENARIOS) {
    const suffix = scenario.suffix
    const entry = inputs[suffix]
    if (!entry) throw new Error(`buildM8Gates: no gate inputs for scenario '${suffix}'`)
    const rows: Array<{ kind: (typeof M8_GATE_KINDS)[number]; passed: boolean; detail: string; name: string }> = [
      {
        kind: 'metadata_v7',
        passed: entry.metadataV7.passed,
        detail: entry.metadataV7.detail,
        name: `${scenario.label} metadata v7 product/purpose`
      },
      {
        kind: 'archive_safety',
        passed: entry.archiveSafety.passed,
        detail: entry.archiveSafety.detail,
        name: `${scenario.label} archive safety`
      },
      {
        kind: 'chat_db_presence',
        passed: entry.chatDbPresence.passed,
        detail: entry.chatDbPresence.detail,
        name: `${scenario.label} authoritative chat.db presence`
      },
      {
        kind: 'excluded_absence',
        passed: entry.excludedAbsence.passed,
        detail: entry.excludedAbsence.detail,
        name: `${scenario.label} excluded promotion/WAL absence`
      },
      {
        kind: 'snapshot_integrity',
        passed: entry.snapshotIntegrity.passed,
        detail: entry.snapshotIntegrity.detail,
        name: `${scenario.label} snapshot integrity`
      },
      {
        kind: 'restore_parity',
        passed: entry.restoreParity.passed,
        detail: entry.restoreParity.detail,
        name: `${scenario.label} staged restore parity`
      },
      {
        kind: 'sample_completeness',
        passed: entry.sampleCompleteness.passed,
        detail: entry.sampleCompleteness.detail,
        name: `${scenario.label} sample completeness`
      }
    ]
    for (const row of rows) {
      const id = `${row.kind}_${suffix}`
      assertBoundedDetail(row.detail)
      gates.push({ id, name: row.name, kind: 'correctness', passed: row.passed, detail: row.detail })
    }
  }
  return gates
}
