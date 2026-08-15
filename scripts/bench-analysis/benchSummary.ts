/**
 * Read-only schema-v1 benchmark artifact summary consumer.
 *
 * Reads schema-v1 result artifacts (the closed contract defined in
 * `src/main/services/chatDb/__tests__/benchResult.ts`) from a directory,
 * validates the closed shape with the existing `validateBenchmarkResult`
 * validator, groups comparable metrics into benchmark families, and emits
 * deterministic directional summaries:
 *
 *   - curve direction across distinct scale points (increasing / decreasing /
 *     flat / non-monotonic), only when exactly one scale dimension varies;
 *   - run variance at identical scale points (descriptive statistics only);
 *   - a simple knee candidate, only when the curve is monotonic and has at
 *     least three distinct scale points.
 *
 * Family identity (PERF-004 F1): the PERF-004 search benchmark emits one
 * artifact id per corpus profile (`chatdb-search-1k`, `chatdb-search-10k`).
 * Series are grouped by a derived family id — the narrow explicit mapping in
 * `deriveBenchmarkFamily`, built from the emitter's own `SEARCH_BENCH_PROFILES`
 * so it cannot drift from the profile contract — so both scale profiles form
 * one cross-scale family (`chatdb-search`) with a `blocks` curve. Unknown ids
 * keep their exact id as the family; there is no fuzzy matching.
 *
 * Scale-dimension semantics (PERF-004 F2): emitter/profile metadata keys are
 * excluded from the dimension-axis analysis (`SCALE_METADATA_KEYS`, currently
 * `profileCode` — a profile ordinal that duplicates `blocks`). Excluded keys
 * never become a curve axis and never participate in scale-point identity, so
 * old artifacts without the key and new artifacts with it merge as the same
 * physical scale. Any other scale-key-set drift (a non-excluded key present in
 * some records but absent in others) is structural incompatibility and is
 * reported as confounded — an undefined scale coordinate is never emitted.
 *
 * Semantics (deliberately narrow, this analysis is a standalone read-only
 * unit):
 *   - Reads only. No writes, no persistence, no production runtime, no
 *     lifecycle changes. The report is derived purely from the input files.
 *   - Directional L3 output only. Every summary is a descriptive heuristic
 *     for inspection. There are no thresholds, no regression gate, and no
 *     promotion or ranking semantics anywhere in the output.
 *   - Malformed or incompatible artifacts are rejected per file and listed in
 *     the report; they never contribute data and never abort the report.
 *   - Privacy guard: artifacts are scanned for forbidden leaf keys (message
 *     content, credentials, user paths, and similar) and rejected with an
 *     explicit reason. This is defense in depth — the closed schema already
 *     forbids every such field.
 *
 * Determinism contract: files are processed in code-unit file-name order;
 * scale records are canonicalized by sorted keys after dropping excluded
 * metadata keys; series are ordered by (family id, metric id, unit); curve
 * points are sorted by the varying scale axis with stable tie-breaks; repeated
 * runs at one scale point are aggregated with the arithmetic mean; knee ties
 * resolve to the lowest scale point. No timestamps, randomness, or
 * machine-local values enter the report.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { type BenchmarkResult, validateBenchmarkResult } from '../../src/main/services/chatDb/__tests__/benchResult'
import { SEARCH_BENCH_PROFILES } from '../../src/main/services/chatDb/__tests__/searchBenchHarness'

// ---------------------------------------------------------------------------
// Public output shapes
// ---------------------------------------------------------------------------

export const BENCH_SUMMARY_NOTICE =
  'Directional L3 analysis only: no thresholds, no regression gate, no promotion semantics. ' +
  'Curve direction, variance statistics, and the knee candidate are descriptive heuristics for ' +
  'inspection, not claims of regression proof.'

export interface BenchAnalysisFileResult {
  /** Base file name (no directory). */
  file: string
  status: 'accepted' | 'rejected'
  /** Human-readable rejection reason; undefined when accepted. */
  reason?: string
}

export interface ArtifactInput {
  /** Base file name the artifact was read from. */
  file: string
  result: BenchmarkResult
}

export interface ArtifactScan {
  dir: string
  files: BenchAnalysisFileResult[]
  artifacts: ArtifactInput[]
}

export interface ScalePointVarianceSufficient {
  kind: 'sufficient'
  runs: number
  /** Run values, ascending. */
  values: number[]
  min: number
  max: number
  range: number
  mean: number
  /** Population standard deviation. */
  stddev: number
  /** Coefficient of variation (stddev / mean); null when the mean is exactly 0. */
  cv: number | null
}

export interface ScalePointVarianceInsufficient {
  kind: 'insufficient'
  runs: number
  /** Run values, ascending. */
  values: number[]
  reason: string
}

export type ScalePointVariance = ScalePointVarianceSufficient | ScalePointVarianceInsufficient

export interface ScalePointSummary {
  /** Canonical scale record (keys sorted). */
  scale: Record<string, number>
  variance: ScalePointVariance
}

export type CurveDirection = 'increasing' | 'decreasing' | 'flat' | 'non-monotonic'

export interface CurvePoint {
  /** Value of the varying scale dimension at this point. */
  scale: number
  /** Mean of run values at this scale point. */
  value: number
}

export interface CurveSummary {
  /** The single scale dimension that varies across the series' scale points. */
  axis: string
  /** Scale points sorted ascending by axis value (stable tie-break by scale key). */
  points: CurvePoint[]
  direction: CurveDirection
}

export type CurveResult =
  | { kind: 'curve'; curve: CurveSummary }
  | { kind: 'insufficient'; reason: string }
  | { kind: 'confounded'; axes: string[] }

export interface KneeCandidate {
  /** 0-based index into the curve's sorted points. */
  index: number
  scale: number
  value: number
  /** Value-space second difference at this point (raw, unnormalized). */
  secondDifference: number
}

export type KneeResult = { kind: 'reported'; candidate: KneeCandidate } | { kind: 'insufficient'; reason: string }

export interface SeriesSummary {
  benchmarkId: string
  metricId: string
  metricName: string
  /** Metric unit; null when the artifact omits it. */
  unit: string | null
  /** Total number of runs (artifact metric values) in this series. */
  runs: number
  /** Number of distinct scale records in this series. */
  scalePoints: number
  curve: CurveResult
  variance: ScalePointSummary[]
  knee: KneeResult
}

export interface BenchSummaryReport {
  scope: {
    kind: 'directory'
    dir: string
    filesScanned: number
    accepted: number
    rejected: number
    files: BenchAnalysisFileResult[]
  }
  series: SeriesSummary[]
  notice: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Benchmark family identity (PERF-004 F1) and scale metadata exclusion
// (PERF-004 F2)
// ---------------------------------------------------------------------------

/**
 * Family id for the PERF-004 search benchmark. The emitter's profile ids are
 * `<family>-<scaleKey>` (`chatdb-search-1k`, `chatdb-search-10k`); the family
 * is the stable cross-scale identity the analysis groups on.
 */
export const SEARCH_BENCH_FAMILY_ID = 'chatdb-search'

/** Profile ids the emitter declares for the search benchmark family. */
const SEARCH_BENCH_PROFILE_IDS: ReadonlySet<string> = new Set(
  Object.values(SEARCH_BENCH_PROFILES).map((profile) => profile.id)
)

/**
 * Derive the stable family id for a benchmark artifact id.
 *
 * An explicitly declared profile id of the PERF-004 search benchmark maps to
 * the family id, so `chatdb-search-1k` and `chatdb-search-10k` form one
 * cross-scale series. Every other id maps to itself — unknown benchmarks are
 * never grouped with each other and never fuzzy-matched into a family.
 */
export function deriveBenchmarkFamily(benchmarkId: string): string {
  return SEARCH_BENCH_PROFILE_IDS.has(benchmarkId) ? SEARCH_BENCH_FAMILY_ID : benchmarkId
}

/**
 * Scale keys that are emitter/profile metadata, not physical scale
 * dimensions. `profileCode` is a profile ordinal that duplicates `blocks`
 * (0 for 1k, 1 for 10k); treating it as a dimension axis would manufacture a
 * false "profileCode curve" and would split old artifacts (recorded before the
 * key existed) from new ones. Excluded keys never become a curve axis and
 * never participate in scale-point identity.
 */
export const SCALE_METADATA_KEYS: ReadonlySet<string> = new Set(['profileCode'])

/**
 * The scale record used for analysis: the artifact scale with excluded
 * metadata keys removed and remaining keys sorted. Deterministic and
 * idempotent.
 */
export function analysisScale(scale: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const key of Object.keys(scale).sort()) {
    if (!SCALE_METADATA_KEYS.has(key)) result[key] = scale[key]
  }
  return result
}

/**
 * Leaf keys that must never appear anywhere in a benchmark artifact (message
 * content, credentials, user paths, raw data). The closed schema already
 * rejects all of them as unknown fields; this scan makes the privacy
 * rejection explicit and names the offending keys.
 */
const FORBIDDEN_LEAF_KEYS = [
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
  'raw'
]

function collectLeafKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectLeafKeys(item, out)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key)
      collectLeafKeys(child, out)
    }
  }
  return out
}

/**
 * Return the forbidden leaf keys present anywhere in `value`, sorted and
 * deduplicated (deterministic). Empty array means the value is clean.
 */
export function detectForbiddenFields(value: unknown): string[] {
  const forbiddenSet = new Set(FORBIDDEN_LEAF_KEYS)
  const found = new Set<string>()
  for (const key of collectLeafKeys(value)) {
    if (forbiddenSet.has(key)) found.add(key)
  }
  return [...found].sort()
}

/** Canonical scale record with keys sorted in code-unit order. */
export function canonicalScale(scale: Record<string, number>): Record<string, number> {
  const canonical: Record<string, number> = {}
  for (const key of Object.keys(scale).sort()) canonical[key] = scale[key]
  return canonical
}

/** Deterministic identity of a scale record (sorted-key canonical JSON). */
export function canonicalScaleKey(scale: Record<string, number>): string {
  return JSON.stringify(canonicalScale(scale))
}

function meanOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

// ---------------------------------------------------------------------------
// Per-file validation (closed schema + privacy guard)
// ---------------------------------------------------------------------------

export type ArtifactFileVerdict = { ok: true; result: BenchmarkResult } | { ok: false; reason: string }

/**
 * Validate a single artifact's raw JSON text against the schema-v1 closed
 * contract. Returns the parsed, typed result on success or a deterministic
 * human-readable rejection reason.
 */
export function validateArtifactFile(raw: string): ArtifactFileVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const forbidden = detectForbiddenFields(parsed)
  if (forbidden.length > 0) {
    return { ok: false, reason: `forbidden fields present: ${forbidden.join(', ')}` }
  }

  if (isRecord(parsed) && typeof parsed.schemaVersion === 'number' && parsed.schemaVersion !== 1) {
    return {
      ok: false,
      reason: `incompatible schemaVersion ${parsed.schemaVersion} (only schemaVersion 1 is supported)`
    }
  }

  const problems = validateBenchmarkResult(parsed)
  if (problems.length > 0) {
    return { ok: false, reason: `schema violation: ${problems.join('; ')}` }
  }
  return { ok: true, result: parsed as BenchmarkResult }
}

// ---------------------------------------------------------------------------
// Directory reading
// ---------------------------------------------------------------------------

/**
 * Read and validate every `*.json` file in `dir`, in code-unit file-name
 * order. Non-regular entries are rejected explicitly. Throws (e.g. ENOENT)
 * when the directory itself cannot be read.
 */
export function readBenchmarkArtifactDirectory(dir: string): ArtifactScan {
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const files: BenchAnalysisFileResult[] = []
  const artifacts: ArtifactInput[] = []

  for (const name of names) {
    const fullPath = path.join(dir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(fullPath)
    } catch (error) {
      files.push({
        file: name,
        status: 'rejected',
        reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`
      })
      continue
    }
    if (!stat.isFile()) {
      files.push({ file: name, status: 'rejected', reason: 'not a regular file' })
      continue
    }

    let raw: string
    try {
      raw = fs.readFileSync(fullPath, 'utf8')
    } catch (error) {
      files.push({
        file: name,
        status: 'rejected',
        reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`
      })
      continue
    }

    const verdict = validateArtifactFile(raw)
    if (verdict.ok) {
      files.push({ file: name, status: 'accepted' })
      artifacts.push({ file: name, result: verdict.result })
    } else {
      files.push({ file: name, status: 'rejected', reason: verdict.reason })
    }
  }

  return { dir, files, artifacts }
}

// ---------------------------------------------------------------------------
// Analysis primitives
// ---------------------------------------------------------------------------

/**
 * Directional label from consecutive value signs. `flat` means every
 * consecutive delta is exactly zero. Comparisons are exact (no epsilon), so
 * a curve is deterministic for a given input.
 */
export function curveDirection(values: readonly number[]): CurveDirection {
  if (values.length < 2) return 'flat'
  let hasIncrease = false
  let hasDecrease = false
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1]
    if (delta > 0) hasIncrease = true
    else if (delta < 0) hasDecrease = true
  }
  if (hasIncrease && hasDecrease) return 'non-monotonic'
  if (hasIncrease) return 'increasing'
  if (hasDecrease) return 'decreasing'
  return 'flat'
}

/**
 * Curve analysis for a series: exactly one varying scale dimension yields a
 * directional curve; more than one is reported as confounded (no direction
 * claimed); fewer than two distinct scale points is explicit insufficient
 * data. Excluded scale metadata keys (`SCALE_METADATA_KEYS`) are dropped
 * before analysis. Key-set drift among the remaining dimensions (a key
 * present in some scale records but absent in others) is structural
 * incompatibility and is reported as confounded — an axis coordinate that is
 * undefined for some records is never emitted. Repeated runs at a scale point
 * are aggregated with the mean.
 */
export function computeCurve(points: readonly { scale: Record<string, number>; value: number }[]): CurveResult {
  const distinctScales = new Map<string, Record<string, number>>()
  for (const point of points) {
    const scale = analysisScale(point.scale)
    if (!distinctScales.has(canonicalScaleKey(scale))) {
      distinctScales.set(canonicalScaleKey(scale), canonicalScale(scale))
    }
  }
  const scaleRecords = [...distinctScales.values()]
  if (scaleRecords.length < 2) {
    return { kind: 'insufficient', reason: 'at least 2 distinct scale points are required for a curve' }
  }

  const allKeys = new Set<string>()
  for (const record of scaleRecords) {
    for (const key of Object.keys(record)) allKeys.add(key)
  }
  // Key-set drift: a key present in some records but absent in others would
  // otherwise look like a "varying axis" whose coordinate is undefined for the
  // records that lack it. Treat it as confounded and never build the curve.
  const driftedKeys: string[] = []
  for (const key of [...allKeys].sort()) {
    if (scaleRecords.some((record) => key in record) && scaleRecords.some((record) => !(key in record))) {
      driftedKeys.push(key)
    }
  }
  const varyingKeys: string[] = []
  for (const key of [...allKeys].sort()) {
    const values = scaleRecords.map((record) => (key in record ? record[key] : null))
    if (new Set(values).size > 1) varyingKeys.push(key)
  }
  if (driftedKeys.length > 0 || varyingKeys.length !== 1) {
    return { kind: 'confounded', axes: [...new Set([...driftedKeys, ...varyingKeys])].sort() }
  }

  const axis = varyingKeys[0]
  const byScale = new Map<string, { record: Record<string, number>; values: number[] }>()
  for (const point of points) {
    const scale = analysisScale(point.scale)
    const key = canonicalScaleKey(scale)
    let entry = byScale.get(key)
    if (entry === undefined) {
      entry = { record: canonicalScale(scale), values: [] }
      byScale.set(key, entry)
    }
    entry.values.push(point.value)
  }

  const entries = [...byScale.entries()].map(([key, entry]) => ({
    key,
    scaleValue: entry.record[axis],
    value: meanOf(entry.values)
  }))
  entries.sort((a, b) => {
    if (a.scaleValue !== b.scaleValue) return a.scaleValue - b.scaleValue
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })

  const curve: CurveSummary = {
    axis,
    points: entries.map((entry) => ({ scale: entry.scaleValue, value: entry.value })),
    direction: curveDirection(entries.map((entry) => entry.value))
  }
  return { kind: 'curve', curve }
}

/**
 * Run variance at one scale point. Descriptive statistics only; a single run
 * is explicit insufficient data for variance.
 */
export function computeScalePointVariance(scale: Record<string, number>, values: readonly number[]): ScalePointSummary {
  const normalized = canonicalScale(analysisScale(scale))
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length < 2) {
    return {
      scale: normalized,
      variance: {
        kind: 'insufficient',
        runs: sorted.length,
        values: sorted,
        reason: 'single run at this scale point — variance requires at least 2 runs'
      }
    }
  }
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const mean = meanOf(sorted)
  const populationVariance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length
  const stddev = Math.sqrt(populationVariance)
  return {
    scale: normalized,
    variance: {
      kind: 'sufficient',
      runs: sorted.length,
      values: sorted,
      min,
      max,
      range: max - min,
      mean,
      stddev,
      cv: mean === 0 ? null : stddev / mean
    }
  }
}

/**
 * Simple knee candidate: the point of maximum absolute value-space second
 * difference along the curve. Reported only when the curve is monotonic
 * (increasing or decreasing) with at least three distinct scale points;
 * otherwise explicit insufficient data. Raw value-space second differences
 * are scale-spacing-sensitive — the candidate is a pointer for inspection,
 * not a finding. Ties resolve to the lowest scale point.
 */
export function computeKnee(curve: CurveResult): KneeResult {
  if (curve.kind !== 'curve') {
    return { kind: 'insufficient', reason: 'no unconfounded curve to inspect' }
  }
  const { points, direction } = curve.curve
  if (points.length < 3) {
    return { kind: 'insufficient', reason: 'a knee candidate requires at least 3 distinct scale points' }
  }
  if (direction !== 'increasing' && direction !== 'decreasing') {
    return {
      kind: 'insufficient',
      reason: `a knee candidate is only reported for monotonic curves (direction is '${direction}')`
    }
  }

  let bestIndex = -1
  let bestSecond = Number.NEGATIVE_INFINITY
  for (let i = 1; i < points.length - 1; i++) {
    const second = points[i + 1].value - 2 * points[i].value + points[i - 1].value
    if (Math.abs(second) > bestSecond) {
      bestSecond = Math.abs(second)
      bestIndex = i
    }
  }

  const candidate: KneeCandidate = {
    index: bestIndex,
    scale: points[bestIndex].scale,
    value: points[bestIndex].value,
    secondDifference: points[bestIndex + 1].value - 2 * points[bestIndex].value + points[bestIndex - 1].value
  }
  return { kind: 'reported', candidate }
}

// ---------------------------------------------------------------------------
// Series grouping + full report
// ---------------------------------------------------------------------------

interface SeriesPoint {
  benchmarkId: string
  metricId: string
  metricName: string
  unit: string | null
  scale: Record<string, number>
  value: number
  file: string
}

function summarizeSeries(points: SeriesPoint[]): SeriesSummary {
  const ordered = [...points].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  const distinctScales = new Map<string, Record<string, number>>()
  const valuesByScale = new Map<string, number[]>()
  for (const point of ordered) {
    const key = canonicalScaleKey(point.scale)
    if (!distinctScales.has(key)) distinctScales.set(key, canonicalScale(point.scale))
    let bucket = valuesByScale.get(key)
    if (bucket === undefined) {
      bucket = []
      valuesByScale.set(key, bucket)
    }
    bucket.push(point.value)
  }

  const scaleKeys = [...distinctScales.keys()].sort()
  const variance: ScalePointSummary[] = scaleKeys.map((key) => {
    const scale = distinctScales.get(key) as Record<string, number>
    const values = valuesByScale.get(key) as number[]
    return computeScalePointVariance(scale, values)
  })

  const curve = computeCurve(ordered)
  const knee = computeKnee(curve)

  return {
    benchmarkId: ordered[0].benchmarkId,
    metricId: ordered[0].metricId,
    metricName: ordered[0].metricName,
    unit: ordered[0].unit,
    runs: ordered.length,
    scalePoints: distinctScales.size,
    curve,
    variance,
    knee
  }
}

/**
 * Group accepted artifacts into comparable metric series keyed by
 * (family id, metric id, unit) and summarize each. Scale metadata keys are
 * dropped from the point scale (PERF-004 F2). Series are ordered by that key;
 * within a series, points are ordered by file name.
 */
export function groupSeries(artifacts: readonly ArtifactInput[]): SeriesSummary[] {
  const groups = new Map<string, SeriesPoint[]>()
  for (const { file, result } of artifacts) {
    const familyId = deriveBenchmarkFamily(result.benchmark.id)
    for (const metric of result.metrics) {
      const key = `${familyId}\u0000${metric.id}\u0000${metric.unit ?? ''}`
      let group = groups.get(key)
      if (group === undefined) {
        group = []
        groups.set(key, group)
      }
      group.push({
        benchmarkId: familyId,
        metricId: metric.id,
        metricName: metric.name,
        unit: metric.unit ?? null,
        scale: analysisScale(result.benchmark.scale),
        value: metric.value,
        file
      })
    }
  }

  const series: SeriesSummary[] = []
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)
    if (group !== undefined && group.length > 0) series.push(summarizeSeries(group))
  }
  return series
}

export function buildBenchSummaryReport(scan: ArtifactScan, series: SeriesSummary[]): BenchSummaryReport {
  const accepted = scan.files.filter((file) => file.status === 'accepted').length
  return {
    scope: {
      kind: 'directory',
      dir: scan.dir,
      filesScanned: scan.files.length,
      accepted,
      rejected: scan.files.length - accepted,
      files: scan.files
    },
    series,
    notice: BENCH_SUMMARY_NOTICE
  }
}

/**
 * Full pipeline: read + validate a directory of schema-v1 artifacts and emit
 * the deterministic directional summary report. Read-only.
 */
export function summarizeBenchmarkDirectory(dir: string): BenchSummaryReport {
  const scan = readBenchmarkArtifactDirectory(dir)
  const series = groupSeries(scan.artifacts)
  return buildBenchSummaryReport(scan, series)
}
