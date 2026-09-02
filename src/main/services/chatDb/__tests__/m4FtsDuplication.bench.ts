/**
 * M4 FTS Duplication Volume — Measurement-Only Diagnostic
 *
 * MEASUREMENT-ONLY: no corpus writes after seed; one isolated WAL checkpoint/TRUNCATE
 * normalization step outside timed probe; then read-only metric collection of
 * FTS/normalized derived-storage duplication volume PLUS directional synthetic
 * physical-page proxies in an isolated synthetic SQLite database.
 * No schema/migration/trigger/production query/storage change; S6.5 not
 * authorized. Output is directional measurement evidence only, never a
 * threshold, baseline, capacity policy, or adoption decision.
 *
 * ENV-GATED (default inert): body runs ONLY when `M4_FTS_DUP_BENCH=1`
 * (canonical `pnpm bench:m4-fts-dup`). Default `pnpm bench:main:native`
 * registers a single SKIPPED task and performs ZERO setup.
 *
 * METHODOLOGY
 *  - Isolated temporary SQLite via mkdtempSync + better-sqlite3 with
 *    registerChatDbNormalize + runMigrations (schema-v1), never user data.
 *  - Deterministic synthetic corpus via existing searchBenchHarness
 *    generateCorpus / ALL_CORPUS cycling; bounded profile 1k/10k/50k
 *    (default 10k for fast on-demand diagnostics) via M4_FTS_DUP_SCALE.
 *  - No corpus writes after seed; one isolated WAL checkpoint/TRUNCATE normalization step outside timed probe; then read-only metric collection:
 *    canonical/main_text row counts, normalized/FTS row counts,
 *    normalized char + UTF-8 byte totals (via Buffer.byteLength), optional
 *    FTS char/byte totals (when readable), duplication logical totals.
 *  - Physical-page proxy (directional synthetic proxies only, numeric-only):
 *    perform a single WAL checkpoint TRUNCATE outside the timed probe,
 *    inspect checkpoint busy status fail-closed, then collect the four
 *    approved raw physical metrics: page_count, page_size, freelist_count,
 *    isolated synthetic DB file byte size (via fs.statSync after checkpoint).
 *    No derived pageBytes/freelistBytes are emitted (audit). The timed
 *    bench probe remains read-only and never performs checkpoint/truncation.
 *  - Fail-closed gates: row-count parity (canonical==normalized==FTS),
 *    FTS smoke (FTS_SMOKE_TOKEN MATCH), corpus completeness (rows==blocks),
 *    finite-value invariants. Incomplete/busy checkpoint aborts with no
 *    artifact (no physical metrics emitted). Any gate failure aborts with no
 *    artifact.
 *  - Artifact: schema-v1 closed contract (benchResult.ts) with stable
 *    profile-dependent id, emitted only after every registered tinybench task
 *    succeeded AND every gate passed (fail-closed).
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterAll, bench, describe, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { FTS_SMOKE_TOKEN, registerChatDbNormalize, runMigrations } from '../migration'
import * as schema from '../schema'
import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasksAndGates
} from './benchResult'
import {
  aggregateCharCount,
  aggregateUtf8Bytes,
  assertCheckpointComplete,
  assertM4PrivacyInvariants,
  assertM4SampleCompleteness,
  buildM4BusyCheckpointFailureMessage,
  buildM4CheckpointFailureMessage,
  buildM4FtsDuplicationGates,
  buildM4FtsDuplicationMetrics,
  buildM4FtsSmokeFailureDetail,
  buildM4PhysicalMetrics,
  buildM4StatFailureMessage,
  M4_FTS_DUP_BENCH_ENV,
  M4_FTS_DUP_COMMAND,
  M4_FTS_DUP_PROFILES,
  M4_FTS_DUP_SCALE_ENV,
  m4FtsDupScaleMetadata,
  parseCheckpointBusy,
  resolveM4FtsDupGate,
  resolveM4FtsDupScale
} from './m4FtsDuplication'
import { generateCorpus } from './searchBenchHarness'

// ---------------------------------------------------------------------------
// Env gate — default inert
// ---------------------------------------------------------------------------

const m4Enabled = resolveM4FtsDupGate(process.env[M4_FTS_DUP_BENCH_ENV])

if (!m4Enabled) {
  describe('M4 FTS duplication volume diagnostic (on-demand, M4)', () => {
    bench.skip('M4 FTS duplication skipped — enable via pnpm bench:m4-fts-dup (M4_FTS_DUP_BENCH=1)', () => {})
  })
} else {
  // -------------------------------------------------------------------------
  // Scale profile (bounded, default 10k)
  // -------------------------------------------------------------------------

  const scaleKey = resolveM4FtsDupScale(process.env[M4_FTS_DUP_SCALE_ENV])
  const profile = M4_FTS_DUP_PROFILES[scaleKey]

  // -------------------------------------------------------------------------
  // Setup — isolated temp DB, schema-v1, synthetic corpus (outside timing)
  // -------------------------------------------------------------------------

  const tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m4-fts-dup-'))
  const dbPath = realPath.join(tempDir, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')

  registerChatDbNormalize(sqlite)
  runMigrations(drizzle(sqlite, { schema }), sqlite)

  generateCorpus(sqlite, profile.blocks)

  function cleanup(): void {
    try {
      sqlite.close()
    } catch {
      /* already closed */
    }
    realFs.rmSync(tempDir, { recursive: true, force: true })
  }
  process.once('exit', cleanup)

  // -------------------------------------------------------------------------
  // Read-only post-seed aggregation (numeric-only)
  // -------------------------------------------------------------------------

  const canonicalRow = sqlite
    .prepare(`SELECT COUNT(*) as n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL`)
    .get() as { n: number }
  const canonicalRows = canonicalRow.n

  const normalizedCountRow = sqlite.prepare(`SELECT COUNT(*) as n FROM message_blocks_normalized`).get() as {
    n: number
  }
  const normalizedRows = normalizedCountRow.n

  const ftsCountRow = sqlite.prepare(`SELECT COUNT(*) as n FROM message_blocks_fts`).get() as { n: number }
  const ftsRows = ftsCountRow.n

  // Normalized content read-only aggregation (privacy: numeric totals only, no content emitted)
  const normalizedContents = sqlite.prepare(`SELECT normalized_content FROM message_blocks_normalized`).all() as Array<{
    normalized_content: string
  }>
  const normalizedContentStrings = normalizedContents.map((r) => r.normalized_content ?? '')
  const normalizedChars = aggregateCharCount(normalizedContentStrings)
  const normalizedBytesUtf8 = aggregateUtf8Bytes(normalizedContentStrings)

  // FTS content — best-effort read (FTS5 shadow content is readable via SELECT normalized_content)
  let ftsChars: number | undefined
  let ftsBytesUtf8: number | undefined
  try {
    const ftsContents = sqlite.prepare(`SELECT normalized_content FROM message_blocks_fts`).all() as Array<{
      normalized_content: string
    }>
    const ftsStrings = ftsContents.map((r) => r.normalized_content ?? '')
    ftsChars = aggregateCharCount(ftsStrings)
    ftsBytesUtf8 = aggregateUtf8Bytes(ftsStrings)
  } catch {
    // FTS content not directly readable on this build — omit FTS char/byte metrics
    ftsChars = undefined
    ftsBytesUtf8 = undefined
  }

  // FTS smoke — bounded trigram MATCH with fixed synthetic token (LOCK-SP-4 pattern)
  let ftsSmokePassed = false
  let ftsSmokeDetail = ''
  try {
    sqlite
      .prepare(`SELECT block_id FROM message_blocks_fts WHERE message_blocks_fts MATCH ? LIMIT 1`)
      .get(FTS_SMOKE_TOKEN)
    ftsSmokePassed = true
    ftsSmokeDetail = 'FTS smoke passed: MATCH token executed without throw'
  } catch (_e) {
    ftsSmokePassed = false
    ftsSmokeDetail = buildM4FtsSmokeFailureDetail()
  }

  // Fail-closed completeness guard before metric/gate construction
  assertM4SampleCompleteness(
    { canonicalRows, normalizedRows, ftsRows, normalizedChars, normalizedBytesUtf8 },
    profile.blocks
  )

  // Metrics — numeric-only, privacy-safe (logical row/char/UTF-8 duplication only)
  const logicalMetrics = buildM4FtsDuplicationMetrics({
    canonicalRows,
    normalizedRows,
    ftsRows,
    normalizedChars,
    normalizedBytesUtf8,
    ftsChars,
    ftsBytesUtf8
  })

  // -------------------------------------------------------------------------
  // Physical-page proxy — WAL checkpoint + four raw physical metrics (outside timing)
  // -------------------------------------------------------------------------
  // Single checkpoint TRUNCATE outside the timed probe; inspect busy/status
  // fail-closed before any stat/artifact. Timed probe remains read-only.
  let checkpointRaw: unknown
  try {
    // Use prepare.get for explicit object shape; fallback to pragma simple:false if needed
    checkpointRaw = sqlite.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    // If prepare.get returns undefined (some builds), try pragma shape
    if (checkpointRaw === undefined) {
      checkpointRaw = sqlite.pragma('wal_checkpoint(TRUNCATE)', { simple: false })
    }
  } catch (_e) {
    cleanup()
    throw new Error(buildM4CheckpointFailureMessage())
  }

  // Inspect checkpoint busy/status before any physical stat — incomplete/busy => fail closed
  try {
    assertCheckpointComplete(checkpointRaw)
  } catch (_e) {
    // If checkpoint status cannot be verified without unsafe assumptions, fail closed as well
    const busyParsed = (() => {
      try {
        return parseCheckpointBusy(checkpointRaw)
      } catch {
        return 'unverifiable'
      }
    })()
    cleanup()
    throw new Error(buildM4BusyCheckpointFailureMessage(busyParsed))
  }

  // Collect four approved raw physical metrics after successful checkpoint
  const pageCountRaw = sqlite.pragma('page_count', { simple: true })
  const pageSizeRaw = sqlite.pragma('page_size', { simple: true })
  const freelistCountRaw = sqlite.pragma('freelist_count', { simple: true })

  const pageCount = typeof pageCountRaw === 'number' ? pageCountRaw : Number(pageCountRaw)
  const pageSize = typeof pageSizeRaw === 'number' ? pageSizeRaw : Number(pageSizeRaw)
  const freelistCount = typeof freelistCountRaw === 'number' ? freelistCountRaw : Number(freelistCountRaw)

  let dbFileBytes: number
  try {
    const stat = realFs.statSync(dbPath)
    dbFileBytes = stat.size
  } catch (_e) {
    cleanup()
    throw new Error(buildM4StatFailureMessage())
  }

  const physicalMetrics = buildM4PhysicalMetrics({
    pageCount,
    pageSize,
    freelistCount,
    dbFileBytes
  })

  const metrics = [...logicalMetrics, ...physicalMetrics]

  // Validate privacy/finite invariants before artifact build (fail-closed)
  assertM4PrivacyInvariants(metrics)
  for (const m of metrics) {
    if (!Number.isFinite(m.value)) throw new Error(`M4 metric ${m.id} is non-finite`)
  }

  // Gates — fail-closed parity/corpus/FTS smoke/finite
  const gates = buildM4FtsDuplicationGates({
    canonicalRows,
    normalizedRows,
    ftsRows,
    ftsSmokePassed,
    ftsSmokeDetail,
    corpusBlocks: profile.blocks,
    finitePassed: metrics.every((m) => Number.isFinite(m.value)),
    finiteDetail: metrics.every((m) => Number.isFinite(m.value))
      ? 'all metrics finite and non-negative'
      : 'some metrics non-finite'
  })

  // If any gate failed, abort with no artifact (fail-closed) — throw before tinybench tasks
  const failingGates = gates.filter((g) => !g.passed)
  if (failingGates.length > 0) {
    cleanup()
    throw new Error(
      `Benchmark aborted — M4 correctness gates failed BEFORE artifact:\n${failingGates.map((g) => `${g.id}: ${g.detail}`).join('\n')}`
    )
  }

  console.log(
    `\n=== M4 FTS Duplication Volume (on-demand diagnostic, measurement-only) ===\n` +
      `Profile: ${scaleKey} blocks=${profile.blocks}\n` +
      `Canonical=${canonicalRows} Normalized=${normalizedRows} FTS=${ftsRows} normalizedChars=${normalizedChars} normalizedBytes=${normalizedBytesUtf8}` +
      (ftsBytesUtf8 !== undefined ? ` ftsBytes=${ftsBytesUtf8}` : '') +
      ` pageCount=${pageCount} pageSize=${pageSize} freelistCount=${freelistCount} dbFileBytes=${dbFileBytes}`
  )

  // -------------------------------------------------------------------------
  // Schema-v1 artifact — emitted only after successful tinybench tasks + gates
  // -------------------------------------------------------------------------

  const m4BenchmarkResult: BenchmarkResult = {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: profile.id,
      name: profile.name,
      scale: {
        ...m4FtsDupScaleMetadata(profile)
      }
    },
    environment: collectEnvironmentMetadata({ command: M4_FTS_DUP_COMMAND }),
    metrics,
    gates
  }

  // Tinybench tasks — single read-only aggregation probe (comparison output;
  // authoritative metrics are the manual aggregation above). Exists so the
  // artifact emission gate observes completed bench tasks (audit F1).
  // NOTE: This probe is strictly read-only — no checkpoint/truncation/stat.
  describe(`M4 FTS duplication volume — ${scaleKey} corpus (${profile.blocks} blocks)`, () => {
    bench(
      'read-only duplication aggregation probe (counts + char/byte totals)',
      () => {
        // Re-run the same read-only aggregation probes without side effects
        sqlite
          .prepare(`SELECT COUNT(*) as n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL`)
          .get()
        sqlite.prepare(`SELECT COUNT(*) as n FROM message_blocks_normalized`).get()
        sqlite.prepare(`SELECT COUNT(*) as n FROM message_blocks_fts`).get()
        const rows = sqlite.prepare(`SELECT normalized_content FROM message_blocks_normalized`).all() as Array<{
          normalized_content: string
        }>
        aggregateUtf8Bytes(rows.map((r) => r.normalized_content ?? ''))
        sqlite
          .prepare(`SELECT block_id FROM message_blocks_fts WHERE message_blocks_fts MATCH ? LIMIT 1`)
          .get(FTS_SMOKE_TOKEN)
      },
      { warmupIterations: 1, iterations: 2 }
    )
  })

  afterAll((suite) => {
    const artifactPath = emitBenchmarkResultAfterSuccessfulTasksAndGates(suite, m4BenchmarkResult)
    if (artifactPath !== null) {
      console.log(`Result artifact: ${artifactPath}`)
    }
    cleanup()
  })
}
