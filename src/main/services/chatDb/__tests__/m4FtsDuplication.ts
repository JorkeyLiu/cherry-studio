/**
 * M4 FTS/normalized derived-storage duplication volume — pure helpers (measurement-only).
 *
 * Diagnostic, measurement-only harness infrastructure for M4. No schema,
 * migration, trigger, production query, or storage behavior change.
 * Default-inert, env-gated, isolated synthetic SQLite, directional
 * evidence only — never a threshold, baseline, or adoption decision.
 *
 * This module is the pure, side-effect-free half:
 *  - strict env-gate parsing (default inert)
 *  - bounded scale/profile selection (1k/10k/50k, default 10k)
 *  - UTF-8 byte aggregation helpers (privacy-safe, finite)
 *  - metric construction (numeric-only, no content/path)
 *  - gate construction (fail-closed parity/FTS smoke/corpus/finite/privacy)
 *  - sample/completeness checks
 *
 * This file is intentionally NOT a *.test.ts / *.bench.ts file so it is never
 * collected directly by Vitest. It imports no native modules, so its focused
 * unit tests stay in the core lane (`pnpm test:main:core`).
 */

import type { BenchmarkGate, BenchmarkMetric } from './benchResult'

// ---------------------------------------------------------------------------
// Env gate — diagnostic runs ONLY when explicitly enabled
// ---------------------------------------------------------------------------

/** Environment variable that enables the on-demand M4 FTS duplication bench. */
export const M4_FTS_DUP_BENCH_ENV = 'M4_FTS_DUP_BENCH'

/**
 * Deterministically resolve the M4_FTS_DUP_BENCH gate.
 * - unset / empty / whitespace-only → disabled (default; no temp DB, no corpus, no artifact)
 * - `1` or `true` (case-insensitive) → enabled
 * - any other non-empty value → throws loudly
 */
export function resolveM4FtsDupGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `M4_FTS_DUP_BENCH must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the canonical \`pnpm bench:m4-fts-dup\` script.`
  )
}

// ---------------------------------------------------------------------------
// Bounded scale profile — reuse existing deterministic search corpus convention
// ---------------------------------------------------------------------------

export type M4FtsDupProfileKey = '1k' | '10k' | '50k'

export interface M4FtsDupProfile {
  /** Deterministic corpus block count passed to generateCorpus(). */
  blocks: number
  /** Stable artifact/baseline identity — embedded in the artifact file name. */
  id: string
  /** Human-readable benchmark name carried in the schema-v1 artifact. */
  name: string
  /** Numeric profile code recorded in the schema-v1 `scale.profileCode` key. */
  profileCode: number
}

export const M4_FTS_DUP_PROFILES: Record<M4FtsDupProfileKey, M4FtsDupProfile> = {
  '1k': {
    blocks: 1_000,
    id: 'chatdb-m4-fts-duplication-1k',
    name: 'M4 FTS duplication volume — 1k corpus',
    profileCode: 0
  },
  '10k': {
    blocks: 10_000,
    id: 'chatdb-m4-fts-duplication-10k',
    name: 'M4 FTS duplication volume — 10k corpus',
    profileCode: 1
  },
  '50k': {
    blocks: 50_000,
    id: 'chatdb-m4-fts-duplication-50k',
    name: 'M4 FTS duplication volume — 50k corpus',
    profileCode: 2
  }
}

/** Environment variable that selects the M4 corpus profile. */
export const M4_FTS_DUP_SCALE_ENV = 'M4_FTS_DUP_SCALE'

/** Default profile — the bounded 10k fast on-demand diagnostic scale. */
export const DEFAULT_M4_FTS_DUP_SCALE: M4FtsDupProfileKey = '10k'

/**
 * Deterministically resolve a M4_FTS_DUP_SCALE value to a profile key.
 * - `undefined` / empty / whitespace-only → default 10k
 * - declared profile key (after trimming) → that profile
 * - anything else → throws with valid profiles
 */
export function resolveM4FtsDupScale(value: string | undefined): M4FtsDupProfileKey {
  if (value === undefined || value.trim().length === 0) return DEFAULT_M4_FTS_DUP_SCALE
  const key = value.trim()
  if (key in M4_FTS_DUP_PROFILES) return key as M4FtsDupProfileKey
  throw new Error(
    `M4_FTS_DUP_SCALE must be one of: ${Object.keys(M4_FTS_DUP_PROFILES).join(', ')} ` +
      `(got '${value}'). The default profile is '${DEFAULT_M4_FTS_DUP_SCALE}'.`
  )
}

/** Stable schema-v1 command recorded in the artifact `environment.command`. */
export const M4_FTS_DUP_COMMAND = 'pnpm bench:m4-fts-dup'

/** Stable suffix for the default profile id used in docs/inventory. */
export const M4_FTS_DUP_DEFAULT_ID = M4_FTS_DUP_PROFILES[DEFAULT_M4_FTS_DUP_SCALE].id

// ---------------------------------------------------------------------------
// UTF-8 byte aggregation — privacy-safe, numeric-only
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length of a string (numeric-only, no content emitted).
 * Uses Buffer.byteLength (Node) which is equivalent to TextEncoder.
 */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Aggregate character count (UTF-16 code units via `string.length`) over
 * normalized content strings. Returns finite non-negative integer.
 */
export function aggregateCharCount(contents: readonly string[]): number {
  let total = 0
  for (const c of contents) {
    total += c.length
  }
  if (!Number.isFinite(total) || total < 0) throw new Error('aggregateCharCount: non-finite result')
  return total
}

/**
 * Aggregate UTF-8 byte total over normalized content strings.
 * Returns finite non-negative integer (numeric-only duplication volume).
 */
export function aggregateUtf8Bytes(contents: readonly string[]): number {
  let total = 0
  for (const c of contents) {
    const bytes = utf8ByteLength(c)
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('aggregateUtf8Bytes: non-finite byte length')
    total += bytes
  }
  if (!Number.isFinite(total) || total < 0) throw new Error('aggregateUtf8Bytes: non-finite result')
  return total
}

// ---------------------------------------------------------------------------
// Metric construction — numeric-only, no content/path, finite
// ---------------------------------------------------------------------------

export interface M4DuplicationAggregation {
  canonicalRows: number
  normalizedRows: number
  ftsRows: number
  normalizedChars: number
  normalizedBytesUtf8: number
  ftsChars?: number
  ftsBytesUtf8?: number
}

/**
 * Build numeric-only duplication metrics from read-only aggregation.
 * Every value must be a finite non-negative number; otherwise throws fail-closed.
 * Metric ids are stable ASCII; units appear only on byte/size metrics.
 */
export function buildM4FtsDuplicationMetrics(aggregation: M4DuplicationAggregation): BenchmarkMetric[] {
  const { canonicalRows, normalizedRows, ftsRows, normalizedChars, normalizedBytesUtf8, ftsChars, ftsBytesUtf8 } =
    aggregation

  const required: Array<[string, number]> = [
    ['canonical.rows', canonicalRows],
    ['normalized.rows', normalizedRows],
    ['fts.rows', ftsRows],
    ['normalized.chars', normalizedChars],
    ['normalized.bytesUtf8', normalizedBytesUtf8]
  ]
  for (const [id, v] of required) {
    if (!Number.isFinite(v) || v < 0)
      throw new Error(`buildM4FtsDuplicationMetrics: metric ${id} is not a finite non-negative number: ${String(v)}`)
    if (!Number.isInteger(v) && id.endsWith('.rows'))
      throw new Error(`buildM4FtsDuplicationMetrics: row count ${id} must be integer`)
  }

  const metrics: BenchmarkMetric[] = []
  metrics.push({
    id: 'canonical.rows',
    name: 'Canonical MAIN_TEXT rows (message_blocks type main_text, content NOT NULL)',
    value: canonicalRows
  })
  metrics.push({
    id: 'normalized.rows',
    name: 'Normalized projection rows (message_blocks_normalized)',
    value: normalizedRows
  })
  metrics.push({ id: 'fts.rows', name: 'FTS virtual table documents (message_blocks_fts)', value: ftsRows })
  metrics.push({
    id: 'normalized.chars',
    name: 'Normalized content total characters (UTF-16 code units)',
    value: normalizedChars
  })
  metrics.push({
    id: 'normalized.bytesUtf8',
    name: 'Normalized content total UTF-8 bytes',
    value: normalizedBytesUtf8,
    unit: 'bytes'
  })

  // Optional FTS char/byte totals — when measurable (FTS content readable)
  if (ftsChars !== undefined) {
    if (!Number.isFinite(ftsChars) || ftsChars < 0)
      throw new Error(`buildM4FtsDuplicationMetrics: metric fts.chars non-finite: ${ftsChars}`)
    metrics.push({ id: 'fts.chars', name: 'FTS content total characters', value: ftsChars })
  }
  if (ftsBytesUtf8 !== undefined) {
    if (!Number.isFinite(ftsBytesUtf8) || ftsBytesUtf8 < 0)
      throw new Error(`buildM4FtsDuplicationMetrics: metric fts.bytesUtf8 non-finite: ${ftsBytesUtf8}`)
    metrics.push({ id: 'fts.bytesUtf8', name: 'FTS content total UTF-8 bytes', value: ftsBytesUtf8, unit: 'bytes' })
  }

  // Duplication logical totals (normalized + FTS) when both sides measured
  if (ftsChars !== undefined) {
    const dupChars = normalizedChars + ftsChars
    if (!Number.isFinite(dupChars)) throw new Error('buildM4FtsDuplicationMetrics: dupChars non-finite')
    metrics.push({
      id: 'duplication.logicalChars',
      name: 'Logical duplication characters (normalized+FTS)',
      value: dupChars
    })
  }
  if (ftsBytesUtf8 !== undefined) {
    const dupBytes = normalizedBytesUtf8 + ftsBytesUtf8
    if (!Number.isFinite(dupBytes)) throw new Error('buildM4FtsDuplicationMetrics: dupBytes non-finite')
    metrics.push({
      id: 'duplication.logicalBytesUtf8',
      name: 'Logical duplication UTF-8 bytes (normalized+FTS)',
      value: dupBytes,
      unit: 'bytes'
    })
  }

  // Privacy invariant: metric names/ids must not contain path segments or raw content leakage markers
  for (const m of metrics) {
    if (/[\\/]/.test(m.id))
      throw new Error(`buildM4FtsDuplicationMetrics: metric id must not contain path segment: ${m.id}`)
    if (!Number.isFinite(m.value)) throw new Error(`buildM4FtsDuplicationMetrics: metric ${m.id} value non-finite`)
  }

  return metrics
}

// ---------------------------------------------------------------------------
// Gate construction — fail-closed parity/FTS smoke/corpus/finite/privacy
// ---------------------------------------------------------------------------

export interface M4GateInputs {
  canonicalRows: number
  normalizedRows: number
  ftsRows: number
  ftsSmokePassed: boolean
  ftsSmokeDetail: string
  corpusBlocks: number
  finitePassed: boolean
  finiteDetail: string
}

/**
 * Build correctness gates for the M4 harness.
 * - parity: canonical == normalized == fts row counts
 * - ftsSmoke: FTS5 MATCH smoke (`FTS_SMOKE_TOKEN`) executed without throw
 * - corpus: normalized/FTS row counts equals expected corpus blocks (bounded scale)
 * - finite: all metrics finite
 * All gates are `kind: 'correctness'` and carry non-empty bounded details.
 */
export function buildM4FtsDuplicationGates(inputs: M4GateInputs): BenchmarkGate[] {
  const {
    canonicalRows,
    normalizedRows,
    ftsRows,
    ftsSmokePassed,
    ftsSmokeDetail,
    corpusBlocks,
    finitePassed,
    finiteDetail
  } = inputs

  function boundedDetail(text: string): string {
    if (typeof text !== 'string' || text.length === 0) throw new Error('gate detail must be non-empty string')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > 256) throw new Error(`gate detail exceeds 256 UTF-8 bytes: ${bytes}`)
    if (/[\\/]/.test(text) && text.includes('/tmp')) throw new Error('gate detail must not leak path')
    return text
  }

  const parityPassed = canonicalRows === normalizedRows && normalizedRows === ftsRows
  const parityDetail = boundedDetail(
    parityPassed
      ? `row counts parity canonical=${canonicalRows} normalized=${normalizedRows} fts=${ftsRows}`
      : `row counts mismatch canonical=${canonicalRows} normalized=${normalizedRows} fts=${ftsRows}`
  )

  const corpusPassed = normalizedRows === corpusBlocks && ftsRows === corpusBlocks
  const corpusDetail = boundedDetail(
    corpusPassed
      ? `corpus completeness normalized=${normalizedRows} fts=${ftsRows} expected=${corpusBlocks}`
      : `corpus mismatch normalized=${normalizedRows} fts=${ftsRows} expected=${corpusBlocks}`
  )

  const smokeDetailBounded = boundedDetail(ftsSmokeDetail)
  const finiteDetailBounded = boundedDetail(finiteDetail)

  return [
    {
      id: 'parity.rowCounts',
      name: 'Row count parity (canonical == normalized == FTS)',
      kind: 'correctness',
      passed: parityPassed,
      detail: parityDetail
    },
    {
      id: 'fts.smoke',
      name: 'FTS5 MATCH smoke (FTS_SMOKE_TOKEN queryable)',
      kind: 'correctness',
      passed: ftsSmokePassed,
      detail: smokeDetailBounded
    },
    {
      id: 'corpus.completeness',
      name: 'Corpus completeness (normalized/FTS row counts == expected blocks)',
      kind: 'correctness',
      passed: corpusPassed,
      detail: corpusDetail
    },
    {
      id: 'metrics.finite',
      name: 'All metric values finite and non-negative',
      kind: 'correctness',
      passed: finitePassed,
      detail: finiteDetailBounded
    }
  ]
}

// ---------------------------------------------------------------------------
// Sample/completeness & privacy checks
// ---------------------------------------------------------------------------

/**
 * Fail-closed completeness guard: every required count must be present and finite.
 */
export function assertM4SampleCompleteness(
  aggregation: M4DuplicationAggregation,
  expectedBlocks: number
): { ok: true; expectedBlocks: number } {
  const { canonicalRows, normalizedRows, ftsRows } = aggregation
  for (const [name, v] of [
    ['canonicalRows', canonicalRows],
    ['normalizedRows', normalizedRows],
    ['ftsRows', ftsRows]
  ] as const) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`assertM4SampleCompleteness: ${name} is non-finite/non-negative`)
  }
  if (normalizedRows !== expectedBlocks)
    throw new Error(`assertM4SampleCompleteness: normalizedRows ${normalizedRows} != expected ${expectedBlocks}`)
  if (ftsRows !== expectedBlocks)
    throw new Error(`assertM4SampleCompleteness: ftsRows ${ftsRows} != expected ${expectedBlocks}`)
  return { ok: true, expectedBlocks }
}

/**
 * Privacy invariant: ensure no metric leaks raw content or path.
 * Throws if any metric id/name/value string contains path-like segments or overly long raw content.
 */
export function assertM4PrivacyInvariants(metrics: readonly BenchmarkMetric[]): void {
  for (const m of metrics) {
    if (typeof m.id !== 'string' || m.id.length === 0) throw new Error('privacy: metric id empty')
    if (/[\\/]/.test(m.id)) throw new Error(`privacy: metric id must not contain path segment: ${m.id}`)
    if (typeof m.name === 'string' && m.name.includes('/tmp'))
      throw new Error(`privacy: metric name leaks path: ${m.name}`)
    if (!Number.isFinite(m.value)) throw new Error(`privacy: metric ${m.id} value non-finite`)
    // value is numeric-only; no string payload to leak content
  }
}

// ---------------------------------------------------------------------------
// Physical-page proxy — isolated synthetic raw physical metrics (directional only)
// ---------------------------------------------------------------------------

/**
 * Raw physical aggregation — the four approved directional synthetic proxies
 * (LOCK-003): page_count, page_size, freelist_count, isolated synthetic DB
 * file byte size. Numeric-only, no derived bytes, no path leakage.
 * All values must be finite integers; file bytes >0 after WAL checkpoint.
 */
export interface M4PhysicalAggregation {
  pageCount: number
  pageSize: number
  freelistCount: number
  dbFileBytes: number
}

/**
 * Parse WAL checkpoint result into the busy flag.
 * better-sqlite3 shapes:
 *  - pragma(..., {simple:true})  -> number (busy)
 *  - pragma(..., {simple:false}) -> [{busy, log, checkpointed}]
 *  - prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() -> {busy, log, checkpointed}
 * Throws fail-closed if the shape cannot be verified without unsafe
 * assumptions — caller must NOT emit physical metrics in that case.
 */
export function parseCheckpointBusy(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error('parseCheckpointBusy: non-finite busy number')
    return raw
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as Record<string, unknown>
    if (first && typeof first.busy === 'number' && Number.isFinite(first.busy)) return first.busy
    throw new Error('parseCheckpointBusy: array entry missing finite busy')
  }
  if (raw !== null && typeof raw === 'object' && 'busy' in (raw as Record<string, unknown>)) {
    const busy = (raw as Record<string, unknown>).busy
    if (typeof busy === 'number' && Number.isFinite(busy)) return busy
    throw new Error('parseCheckpointBusy: object busy non-finite')
  }
  throw new Error('parseCheckpointBusy: unverifiable checkpoint result shape — fail closed')
}

/**
 * Assert checkpoint completed (busy === 0). Throws fail-closed when busy or
 * unverifiable. Call BEFORE stat/artifact construction.
 */
export function assertCheckpointComplete(raw: unknown): void {
  const busy = parseCheckpointBusy(raw)
  if (busy !== 0) {
    throw new Error(
      `assertCheckpointComplete: WAL checkpoint incomplete/busy (busy=${busy}) — physical proxy fail-closed`
    )
  }
}

/**
 * Privacy-safe fixed categories for M4 physical proxy failures and FTS smoke.
 * These are stable, path-free, and do not interpolate native exception text
 * which may contain the temporary isolated DB path (M4 audit privacy finding).
 * Callers must use these helpers — never interpolate `e.message` directly.
 */
export const M4_CHECKPOINT_FAILURE_CATEGORY = 'checkpoint_failed'
export const M4_STAT_FAILURE_CATEGORY = 'stat_failed'
export const M4_FTS_SMOKE_FAILURE_CATEGORY = 'fts_smoke_failed'

export function buildM4CheckpointFailureMessage(): string {
  return `M4 physical proxy: WAL checkpoint TRUNCATE failed — fail-closed before stat/artifact: ${M4_CHECKPOINT_FAILURE_CATEGORY}`
}

export function buildM4BusyCheckpointFailureMessage(busy: number | string): string {
  return `M4 physical proxy: incomplete/busy checkpoint cannot produce physical artifact (busy=${String(busy)}) — physical proxy fail-closed`
}

export function buildM4StatFailureMessage(): string {
  return `M4 physical proxy: fs stat of isolated synthetic DB failed — fail-closed: ${M4_STAT_FAILURE_CATEGORY}`
}

export function buildM4FtsSmokeFailureDetail(): string {
  return `FTS smoke failed: MATCH token threw — ${M4_FTS_SMOKE_FAILURE_CATEGORY}`
}

/**
 * Validate and build numeric-only physical metrics from raw aggregation.
 * Exactly four metrics, no derived fields. Throws fail-closed on non-finite.
 */
export function buildM4PhysicalMetrics(agg: M4PhysicalAggregation): BenchmarkMetric[] {
  const { pageCount, pageSize, freelistCount, dbFileBytes } = agg
  for (const [id, v] of [
    ['physical.page_count', pageCount],
    ['physical.page_size', pageSize],
    ['physical.freelist_count', freelistCount],
    ['physical.dbFileBytes', dbFileBytes]
  ] as const) {
    if (!Number.isFinite(v) || v < 0)
      throw new Error(`buildM4PhysicalMetrics: ${id} non-finite/non-negative: ${String(v)}`)
    if (!Number.isInteger(v)) throw new Error(`buildM4PhysicalMetrics: ${id} must be integer: ${String(v)}`)
  }
  if (pageCount === 0) throw new Error('buildM4PhysicalMetrics: page_count must be >0')
  if (pageSize === 0) throw new Error('buildM4PhysicalMetrics: page_size must be >0')
  if (dbFileBytes === 0) throw new Error('buildM4PhysicalMetrics: dbFileBytes must be >0')
  const metrics: BenchmarkMetric[] = [
    {
      id: 'physical.page_count',
      name: 'Synthetic DB page count (PRAGMA page_count, directional proxy only)',
      value: pageCount
    },
    {
      id: 'physical.page_size',
      name: 'Synthetic DB page size bytes (PRAGMA page_size)',
      value: pageSize,
      unit: 'bytes'
    },
    {
      id: 'physical.freelist_count',
      name: 'Synthetic DB freelist count (PRAGMA freelist_count)',
      value: freelistCount
    },
    {
      id: 'physical.dbFileBytes',
      name: 'Synthetic DB file size bytes (isolated mkdtemp DB after WAL checkpoint TRUNCATE)',
      value: dbFileBytes,
      unit: 'bytes'
    }
  ]
  for (const m of metrics) {
    if (/[\\/]/.test(m.id)) throw new Error(`buildM4PhysicalMetrics: id must not contain path segment: ${m.id}`)
    if (!Number.isFinite(m.value)) throw new Error(`buildM4PhysicalMetrics: metric ${m.id} non-finite`)
  }
  return metrics
}

/**
 * Privacy/finite guard for physical aggregation before metric construction.
 */
export function assertM4PhysicalInvariants(agg: M4PhysicalAggregation): void {
  buildM4PhysicalMetrics(agg)
}

// ---------------------------------------------------------------------------
// Scale metadata — numeric-only, schema-v1 compliant
// ---------------------------------------------------------------------------

export function m4FtsDupScaleMetadata(profile: M4FtsDupProfile): Record<string, number> {
  return { blocks: profile.blocks, profileCode: profile.profileCode }
}
