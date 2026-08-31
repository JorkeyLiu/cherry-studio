/**
 * PERF-STREAM-ATTR-001 Streaming Persistence Differential Benchmark
 * (Node lane, deterministic temp DB; LOCK-STREAM-ATTR-001..006).
 *
 * MEASUREMENT-ONLY: attributes the deterministic streaming write cost on the
 * SQLite side to (a) the base-table row write and (b) the normalized/FTS
 * trigger projection (DELETE + INSERT per content update), via two equivalent
 * deterministic temporary databases:
 *
 *   - `dbOn`  — the exact production schema (runMigrations) with the three
 *     rowid-addressable sync triggers active;
 *   - `dbOff` — the SAME schema and identical seed, but with the three sync
 *     triggers dropped (base-only write semantics; projection is later
 *     rebuilt explicitly for parity).
 *
 * Both lanes run the IDENTICAL deterministic update sequences (three profiles:
 * accumulated-content growth / identical-content rewrite / completion-style
 * flush) in lockstep rounds, so the per-round differential `triggerOn −
 * baseOnly` is an honest ESTIMATE of the projection-trigger cost per write.
 * It is NOT direct trigger-body profiling (better-sqlite3 does not expose
 * trigger-body time separately from the UPDATE — LOCK-STREAM-ATTR-006); it is
 * reported as a differential estimate only, never as root cause.
 *
 * Correctness/parity ALL run BEFORE any timing (fail-closed aborts with no
 * artifact) — preflight on fresh equivalent DBs validates complete
 * base-table parity, projection equivalence after explicit rebuild, 1:1
 * projection row invariant, normalized rowid advance proving trigger fires
 * per content update (including identical rewrites), base-only changes=1
 * (better-sqlite3 exposes only base row), and completion warmup-streaming
 * → measured-success transition in both lanes — without contaminating the
 * measured state:
 *   - seed parity: base tables AND projections equal across both DBs;
 *   - preflight parity/projection/rowid/1:1/completionFlip on fresh equivalent
 *     DBs before timing;
 *   - post parity: base tables equal after the identical update sequences
 *     (the base-only lane wrote identical content);
 *   - projection equivalence: after explicitly rebuilding the base-only lane's
 *     projection (production candidate rebuild), it equals the
 *     trigger-maintained lane's projection.
 *   - projection row-op accounting: trigger fires per update verified by
 *     normalized rowid advance plus 1:1 projection row invariant
 *     (base-only changes=1; better-sqlite3 exposes only base row).
 *
 * ENV-GATED (default skip): the diagnostic body runs ONLY when
 * `STREAM_PERSIST_BENCH=1` (canonical `pnpm bench:stream-persist`). Under the
 * default `pnpm bench:main:native` the file registers a single SKIPPED task
 * and performs ZERO setup — no temp DBs, no corpus, no artifact.
 *
 * Artifact: schema-v1 (`benchResult.ts` closed contract), stable id
 * `chatdb-stream-persist-node` (the `chatdb-stream-persist-*` family,
 * LOCK-STREAM-ATTR-004), emitted only after every registered tinybench task
 * completed successfully (audit F1). All numeric timings are L3
 * directional/non-threshold (LOCK-STREAM-ATTR-005).
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

import { registerChatDbNormalize, runMigrations } from '../migration'
import { DERIVED_PROJECTION_REBUILD_SQL, MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER } from '../migration'
import { BlocksRepository } from '../repository/BlocksRepository'
import { MessagesRepository } from '../repository/MessagesRepository'
import { TopicsRepository } from '../repository/TopicsRepository'
import * as schema from '../schema'
import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasks
} from './benchResult'
import {
  assertStreamPersistSampleCounts,
  buildStreamPersistGates,
  buildStreamPersistMetrics,
  resolveStreamPersistGate,
  STREAM_PERSIST_BENCH_ENV,
  STREAM_PERSIST_COMPLETION_STATUS,
  STREAM_PERSIST_CORPUS_BLOCKS,
  STREAM_PERSIST_MEASURE_ROUNDS,
  STREAM_PERSIST_NODE_BENCH_ID,
  STREAM_PERSIST_NODE_BENCH_NAME,
  STREAM_PERSIST_NODE_COMMAND,
  STREAM_PERSIST_PROFILES,
  STREAM_PERSIST_STREAMING_STATUS,
  STREAM_PERSIST_WARMUP_ROUNDS,
  streamPersistContent,
  streamPersistExpectedRowidAdvance,
  type StreamPersistLaneSamples,
  type StreamPersistProfileKey,
  streamPersistScale,
  streamPersistShouldHeatBeforeTimed,
  streamPersistStatus
} from './streamPersistBench'

// ---------------------------------------------------------------------------
// Env gate — the diagnostic body is inert unless explicitly enabled
// ---------------------------------------------------------------------------

const streamPersistEnabled = resolveStreamPersistGate(process.env[STREAM_PERSIST_BENCH_ENV])

if (!streamPersistEnabled) {
  // Default collection: zero setup (no temp DBs, no corpus, no artifact) and
  // a single self-documenting skipped task.
  describe('streaming persistence differential (on-demand diagnostic)', () => {
    bench.skip('persist differential skipped — enable via pnpm bench:stream-persist (STREAM_PERSIST_BENCH=1)', () => {})
  })
} else {
  // -------------------------------------------------------------------------
  // Setup — two equivalent deterministic temp DBs
  // -------------------------------------------------------------------------

  const tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-stream-persist-bench-'))

  interface FreshDb {
    sqlite: Database.Database
    dir: string
  }

  /** Open a FRESH deterministic temp DB with the exact production schema. */
  function openFreshDb(dir: string): FreshDb {
    const sqlite = new Database(realPath.join(dir, 'chat.db'))
    try {
      sqlite.pragma('journal_mode = WAL')
      sqlite.pragma('foreign_keys = ON')
      sqlite.pragma('synchronous = NORMAL')
      sqlite.pragma('busy_timeout = 5000')
      const db = drizzle(sqlite, { schema })
      registerChatDbNormalize(sqlite)
      runMigrations(db, sqlite)
      return { sqlite, dir }
    } catch (e) {
      try {
        sqlite.close()
      } catch {
        /* already closed */
      }
      throw e
    }
  }

  const dirOn = realPath.join(tempDir, 'on')
  const dirOff = realPath.join(tempDir, 'off')
  realFs.mkdirSync(dirOn, { recursive: true })
  realFs.mkdirSync(dirOff, { recursive: true })
  let dbOn: Database.Database
  let dbOff: Database.Database
  {
    let tmpOn: Database.Database | null = null
    try {
      const openedOn = openFreshDb(dirOn)
      tmpOn = openedOn.sqlite
      const openedOff = openFreshDb(dirOff)
      const tmpOff = openedOff.sqlite
      dbOn = tmpOn
      dbOff = tmpOff
    } catch (e) {
      if (tmpOn !== null) {
        try {
          tmpOn.close()
        } catch {
          /* already closed */
        }
      }
      try {
        realFs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* already removed */
      }
      throw e
    }
  }
  const CLEANUP: Database.Database[] = [dbOn, dbOff]
  let cleanupDone = false
  function cleanup(): void {
    if (cleanupDone) return
    cleanupDone = true
    for (const sqlite of CLEANUP) {
      try {
        sqlite.close()
      } catch {
        /* already closed */
      }
    }
    try {
      realFs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* already removed */
    }
  }
  process.once('exit', cleanup)

  const TOPIC_ID = 'stream-persist-topic'
  const MESSAGE_ID = 'stream-persist-message'
  const STREAM_BLOCK_ID = 'stream-persist-block'
  const BENCH_CREATED_AT = '2025-01-01T00:00:00.000Z'
  const SEED_LENGTH = STREAM_PERSIST_CORPUS_BLOCKS
  const pad = (n: number, width: number): string => String(n).padStart(width, '0')

  /**
   * Seed each DB with the IDENTICAL deterministic corpus through the
   * production repositories (insert paths fire the sync triggers, so both
   * projections are populated exactly like a migration-004-fresh DB).
   */
  function seedDb(sqlite: Database.Database): void {
    const db = drizzle(sqlite, { schema })
    const topics = new TopicsRepository(db)
    const messages = new MessagesRepository(db)
    const blocks = new BlocksRepository(db)
    topics.create({
      id: TOPIC_ID,
      assistantId: 'bench-asst',
      name: 'Stream Persist Topic',
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      deletedAt: null,
      overflow: {}
    })
    // Seed corpus messages + blocks (deterministic contents).
    for (let i = 0; i < SEED_LENGTH; i++) {
      const messageId = `seed-msg-${pad(i, 5)}`
      messages.create({
        id: messageId,
        topicId: TOPIC_ID,
        role: 'assistant',
        content: null,
        status: 'success',
        askId: null,
        model: null,
        modelId: null,
        assistantId: 'bench-asst',
        createdAt: BENCH_CREATED_AT,
        updatedAt: BENCH_CREATED_AT,
        sortOrder: i,
        overflow: {}
      })
      blocks.create({
        id: `seed-block-${pad(i, 5)}`,
        messageId,
        type: 'main_text',
        content: `Seed corpus paragraph #${i} ${'deterministic filler text. '.repeat(4)}`,
        status: 'success',
        createdAt: BENCH_CREATED_AT,
        updatedAt: BENCH_CREATED_AT,
        sortOrder: 0,
        overflow: {}
      })
    }
    // The measured streaming block (same row in both DBs).
    messages.create({
      id: MESSAGE_ID,
      topicId: TOPIC_ID,
      role: 'assistant',
      content: null,
      status: 'streaming',
      askId: null,
      model: null,
      modelId: null,
      assistantId: 'bench-asst',
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      sortOrder: SEED_LENGTH,
      overflow: {}
    })
    blocks.create({
      id: STREAM_BLOCK_ID,
      messageId: MESSAGE_ID,
      type: 'main_text',
      content: 'streaming placeholder',
      status: STREAM_PERSIST_STREAMING_STATUS,
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      sortOrder: 0,
      overflow: {}
    })
  }

  seedDb(dbOn)
  seedDb(dbOff)

  // Base-only lane: drop the three sync triggers (identical schema otherwise).
  dbOff.exec(
    [
      'DROP TRIGGER IF EXISTS message_blocks_normalized_insert',
      'DROP TRIGGER IF EXISTS message_blocks_normalized_update',
      'DROP TRIGGER IF EXISTS ' + MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER
    ].join(';\n')
  )

  // -------------------------------------------------------------------------
  // Row comparison helpers (closed-field, deterministic)
  // -------------------------------------------------------------------------

  interface ProjectionRows {
    normalized: Array<{ block_id: string; content: string }>
    fts: Array<{ block_id: string; content: string }>
  }

  function baseRowsOf(sqlite: Database.Database): string[][] {
    const rows = sqlite
      .prepare('SELECT id, message_id, type, content, status FROM message_blocks ORDER BY id')
      .all() as Array<{
      id: string
      message_id: string
      type: string | null
      content: string | null
      status: string | null
    }>
    return rows.map((r) => [r.id, r.message_id, r.type ?? '', r.content ?? '', r.status ?? ''])
  }

  function projectionRowsOf(sqlite: Database.Database): ProjectionRows {
    const normalized = (
      sqlite
        .prepare('SELECT block_id, normalized_content FROM message_blocks_normalized ORDER BY block_id')
        .all() as Array<{ block_id: string; normalized_content: string }>
    ).map((r) => ({ block_id: r.block_id, content: r.normalized_content }))
    const fts = (
      sqlite.prepare('SELECT block_id, normalized_content FROM message_blocks_fts ORDER BY block_id').all() as Array<{
        block_id: string
        normalized_content: string
      }>
    ).map((r) => ({ block_id: r.block_id, content: r.normalized_content }))
    return { normalized, fts }
  }

  function projectionEqual(a: ProjectionRows, b: ProjectionRows): boolean {
    const eqRows = (
      x: Array<{ block_id: string; content: string }>,
      y: Array<{ block_id: string; content: string }>
    ): boolean =>
      x.length === y.length && x.every((row, i) => row.block_id === y[i].block_id && row.content === y[i].content)
    return eqRows(a.normalized, b.normalized) && eqRows(a.fts, b.fts)
  }

  function baseEqual(): boolean {
    const a = baseRowsOf(dbOn)
    const b = baseRowsOf(dbOff)
    return a.length === b.length && a.every((row, i) => row.join('\u0000') === b[i].join('\u0000'))
  }

  function baseEqualOf(aSqlite: Database.Database, bSqlite: Database.Database): boolean {
    const a = baseRowsOf(aSqlite)
    const b = baseRowsOf(bSqlite)
    return a.length === b.length && a.every((row, i) => row.join('\u0000') === b[i].join('\u0000'))
  }

  function projectionEqualOf(aSqlite: Database.Database, bSqlite: Database.Database): boolean {
    return projectionEqual(projectionRowsOf(aSqlite), projectionRowsOf(bSqlite))
  }

  // -------------------------------------------------------------------------
  // Seed parity checks — BEFORE any timing
  // -------------------------------------------------------------------------

  const seedErrors: string[] = []
  if (!baseEqual()) {
    seedErrors.push('seed: base tables differ between trigger-on and base-only lanes')
  }
  if (!projectionEqual(projectionRowsOf(dbOn), projectionRowsOf(dbOff))) {
    seedErrors.push('seed: projections differ between lanes (both trigger-maintained at seed)')
  }
  // Base-only lane must have exactly zero sync triggers after the drop.
  const offTriggerCount = (
    dbOff
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'message_blocks_normalized_%'"
      )
      .get() as { count: number }
  ).count
  if (offTriggerCount !== 0) {
    seedErrors.push(`seed: base-only lane still has ${offTriggerCount} sync triggers`)
  }

  if (seedErrors.length > 0) {
    cleanup()
    throw new Error(`Streaming persist benchmark aborted — seed parity failed BEFORE timing:\n${seedErrors.join('\n')}`)
  }

  // -------------------------------------------------------------------------
  // Fresh-equivalent preflight — complete parity/projection/rowid/1:1/completionFlip BEFORE timing
  // (uses disposable clones so measured state/rowid baseline stays pristine)
  // -------------------------------------------------------------------------

  {
    const preDirOn = realPath.join(tempDir, 'preflight-on')
    const preDirOff = realPath.join(tempDir, 'preflight-off')
    realFs.mkdirSync(preDirOn, { recursive: true })
    realFs.mkdirSync(preDirOff, { recursive: true })
    let preOn: Database.Database | null = null
    let preOff: Database.Database | null = null
    const preflightErrors: string[] = []
    try {
      const openedOn = openFreshDb(preDirOn)
      preOn = openedOn.sqlite
      const openedOff = openFreshDb(preDirOff)
      preOff = openedOff.sqlite
      seedDb(preOn)
      seedDb(preOff)
      preOff.exec(
        [
          'DROP TRIGGER IF EXISTS message_blocks_normalized_insert',
          'DROP TRIGGER IF EXISTS message_blocks_normalized_update',
          'DROP TRIGGER IF EXISTS ' + MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER
        ].join(';\n')
      )

      if (!baseEqualOf(preOn, preOff)) {
        preflightErrors.push('preflight: base tables differ between lanes (fresh clones)')
      }
      if (!projectionEqualOf(preOn, preOff)) {
        preflightErrors.push('preflight: projections differ between lanes (fresh clones)')
      }

      const preStmtOn = preOn.prepare('UPDATE message_blocks SET content = ?, status = ? WHERE id = ?')
      const preStmtOff = preOff.prepare('UPDATE message_blocks SET content = ?, status = ? WHERE id = ?')
      const preRowidBefore = (
        preOn.prepare('SELECT rowid FROM message_blocks_normalized WHERE block_id = ?').get(STREAM_BLOCK_ID) as {
          rowid: number
        }
      ).rowid
      const preOpsOn: number[] = []
      const preOpsOff: number[] = []
      let preWarmupStreaming = false
      let preMeasuredSuccess = false
      let preFirstTimedOnStatus: string | null = null
      let preFirstTimedOffStatus: string | null = null
      for (const profile of STREAM_PERSIST_PROFILES) {
        for (let round = 1; round <= STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS; round++) {
          const content = streamPersistContent(profile, Math.min(round, STREAM_PERSIST_MEASURE_ROUNDS))
          const status = streamPersistStatus(profile, round)
          if (profile === 'completion') {
            if (round <= STREAM_PERSIST_WARMUP_ROUNDS && status === STREAM_PERSIST_STREAMING_STATUS) {
              preWarmupStreaming = true
            }
            if (round > STREAM_PERSIST_WARMUP_ROUNDS && status === 'success') {
              preMeasuredSuccess = true
            }
          }
          if (streamPersistShouldHeatBeforeTimed(profile, round)) {
            preStmtOn.run(content, status, STREAM_BLOCK_ID)
            preStmtOff.run(content, status, STREAM_BLOCK_ID)
          }
          if (round <= STREAM_PERSIST_WARMUP_ROUNDS) continue
          const rOn = preStmtOn.run(content, status, STREAM_BLOCK_ID)
          const rOff = preStmtOff.run(content, status, STREAM_BLOCK_ID)
          preOpsOn.push(rOn.changes)
          preOpsOff.push(rOff.changes)
          if (profile === 'completion' && round === STREAM_PERSIST_WARMUP_ROUNDS + 1) {
            preFirstTimedOnStatus = (
              preOn.prepare('SELECT status FROM message_blocks WHERE id = ?').get(STREAM_BLOCK_ID) as { status: string }
            ).status
            preFirstTimedOffStatus = (
              preOff.prepare('SELECT status FROM message_blocks WHERE id = ?').get(STREAM_BLOCK_ID) as {
                status: string
              }
            ).status
          }
        }
      }
      const preRowidAfter = (
        preOn.prepare('SELECT rowid FROM message_blocks_normalized WHERE block_id = ?').get(STREAM_BLOCK_ID) as {
          rowid: number
        }
      ).rowid
      const expectedPreAdvance = streamPersistExpectedRowidAdvance()
      if (preRowidAfter - preRowidBefore !== expectedPreAdvance) {
        preflightErrors.push(
          `preflight: normalized rowid advanced ${preRowidAfter - preRowidBefore}, expected ${expectedPreAdvance}`
        )
      }
      if (!baseEqualOf(preOn, preOff)) {
        preflightErrors.push('preflight: base tables differ after deterministic replay')
      }
      preOff.exec(DERIVED_PROJECTION_REBUILD_SQL.join(';\n'))
      if (!projectionEqualOf(preOn, preOff)) {
        preflightErrors.push('preflight: rebuilt projection differs from trigger-maintained projection')
      }
      const preNormCount = (preOn.prepare('SELECT COUNT(*) AS n FROM message_blocks_normalized').get() as { n: number })
        .n
      const preFtsCount = (preOn.prepare('SELECT COUNT(*) AS n FROM message_blocks_fts').get() as { n: number }).n
      if (preNormCount !== SEED_LENGTH + 1 || preFtsCount !== SEED_LENGTH + 1) {
        preflightErrors.push(
          `preflight: projection row invariant failed (normalized=${preNormCount}, fts=${preFtsCount}, expected=${SEED_LENGTH + 1})`
        )
      }
      if (!preOpsOff.every((c) => c === 1)) {
        preflightErrors.push(
          `preflight: base-only changes not all 1 (got ${JSON.stringify([...new Set(preOpsOff)].slice(0, 4))})`
        )
      }
      if (!preWarmupStreaming || !preMeasuredSuccess) {
        preflightErrors.push(
          `preflight: completion status flip not verified (warmup streaming=${preWarmupStreaming} measured success=${preMeasuredSuccess})`
        )
      }
      if (
        preFirstTimedOnStatus !== STREAM_PERSIST_COMPLETION_STATUS ||
        preFirstTimedOffStatus !== STREAM_PERSIST_COMPLETION_STATUS
      ) {
        preflightErrors.push(
          `preflight: first timed completion transition did not persist success in both lanes (on=${preFirstTimedOnStatus} off=${preFirstTimedOffStatus})`
        )
      }
      const preFinalOnStatus = (
        preOn.prepare('SELECT status FROM message_blocks WHERE id = ?').get(STREAM_BLOCK_ID) as { status: string }
      ).status
      const preFinalOffStatus = (
        preOff.prepare('SELECT status FROM message_blocks WHERE id = ?').get(STREAM_BLOCK_ID) as { status: string }
      ).status
      if (preFinalOnStatus !== 'success' || preFinalOffStatus !== 'success') {
        preflightErrors.push(
          `preflight: final persisted status not success (on=${preFinalOnStatus} off=${preFinalOffStatus})`
        )
      }
      if (preflightErrors.length > 0) {
        throw new Error(preflightErrors.join('\n'))
      }
    } catch (e) {
      if (preOn) {
        try {
          preOn.close()
        } catch {
          /* already closed */
        }
      }
      if (preOff) {
        try {
          preOff.close()
        } catch {
          /* already closed */
        }
      }
      realFs.rmSync(preDirOn, { recursive: true, force: true })
      realFs.rmSync(preDirOff, { recursive: true, force: true })
      cleanup()
      throw new Error(
        `Streaming persist benchmark aborted — preflight parity failed BEFORE timing:\n${e instanceof Error ? e.message : String(e)}`
      )
    }
    if (preOn) {
      try {
        preOn.close()
      } catch {
        /* already closed */
      }
    }
    if (preOff) {
      try {
        preOff.close()
      } catch {
        /* already closed */
      }
    }
    realFs.rmSync(preDirOn, { recursive: true, force: true })
    realFs.rmSync(preDirOff, { recursive: true, force: true })
  }

  // -------------------------------------------------------------------------
  // Profile measurement — deterministic update sequences in lockstep rounds
  // -------------------------------------------------------------------------

  const samples = new Map<StreamPersistProfileKey, StreamPersistLaneSamples>()
  const opCounts = new Map<StreamPersistProfileKey, { triggerOn: number[]; baseOnly: number[] }>()

  const stmtOn = dbOn.prepare('UPDATE message_blocks SET content = ?, status = ? WHERE id = ?')
  const stmtOff = dbOff.prepare('UPDATE message_blocks SET content = ?, status = ? WHERE id = ?')

  // Deterministic side-effect proof (LOCK-STREAM-ATTR-006): the rowid-addressable
  // UPDATE trigger performs a DELETE+INSERT of the normalized projection each
  // time it fires, and the normalized rowid is INTEGER PRIMARY KEY AUTOINCREMENT
  // (migration 004), so a fired trigger advances the streaming block's
  // normalized rowid by exactly one. Captured before/after the profiles: if the
  // trigger fires on EVERY content update (including identical-content
  // rewrites), the rowid advances by exactly the deterministic heat+timed count
  // via streamPersistExpectedRowidAdvance() — currently 149 heat + 120 timed = 269.
  const streamingNormRowidBefore = (
    dbOn.prepare('SELECT rowid FROM message_blocks_normalized WHERE block_id = ?').get(STREAM_BLOCK_ID) as {
      rowid: number
    }
  ).rowid

  let completionWarmupSeenStreaming = false
  let completionMeasuredSeenSuccess = false
  let completionFirstTimedOnStatus: string | null = null
  let completionFirstTimedOffStatus: string | null = null

  for (const profile of STREAM_PERSIST_PROFILES) {
    const timing: StreamPersistLaneSamples = { triggerOn: [], baseOnly: [] }
    const ops: { triggerOn: number[]; baseOnly: number[] } = { triggerOn: [], baseOnly: [] }

    for (let round = 1; round <= STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS; round++) {
      const content = streamPersistContent(profile, Math.min(round, STREAM_PERSIST_MEASURE_ROUNDS))
      const status = streamPersistStatus(profile, round)
      if (profile === 'completion') {
        if (round <= STREAM_PERSIST_WARMUP_ROUNDS && status === STREAM_PERSIST_STREAMING_STATUS) {
          completionWarmupSeenStreaming = true
        }
        if (round > STREAM_PERSIST_WARMUP_ROUNDS && status === STREAM_PERSIST_COMPLETION_STATUS) {
          completionMeasuredSeenSuccess = true
        }
      }

      if (streamPersistShouldHeatBeforeTimed(profile, round)) {
        stmtOn.run(content, status, STREAM_BLOCK_ID)
        stmtOff.run(content, status, STREAM_BLOCK_ID)
      }
      const isMeasured = round > STREAM_PERSIST_WARMUP_ROUNDS
      if (!isMeasured) continue

      // Interleaved measured windows: trigger-on then base-only, same content.
      const tOn = performance.now()
      const rOn = stmtOn.run(content, status, STREAM_BLOCK_ID)
      timing.triggerOn.push(performance.now() - tOn)
      ops.triggerOn.push(rOn.changes)

      const tOff = performance.now()
      const rOff = stmtOff.run(content, status, STREAM_BLOCK_ID)
      timing.baseOnly.push(performance.now() - tOff)
      ops.baseOnly.push(rOff.changes)

      if (profile === 'completion' && round === STREAM_PERSIST_WARMUP_ROUNDS + 1) {
        completionFirstTimedOnStatus = (
          dbOn.prepare('SELECT status FROM message_blocks WHERE id = ?').get(STREAM_BLOCK_ID) as { status: string }
        ).status
        completionFirstTimedOffStatus = (
          dbOff.prepare('SELECT status FROM message_blocks WHERE id = ?').get(STREAM_BLOCK_ID) as { status: string }
        ).status
      }
    }

    samples.set(profile, timing)
    opCounts.set(profile, ops)
  }

  // After all profiles: the streaming block's normalized rowid must have
  // advanced by exactly the deterministic count of heat + timed writes —
  // proving the UPDATE trigger (rowid DELETE+INSERT) fired on EVERY content
  // update, including the identical-content nochange/completion rewrites.
  const streamingNormRowidAfter = (
    dbOn.prepare('SELECT rowid FROM message_blocks_normalized WHERE block_id = ?').get(STREAM_BLOCK_ID) as {
      rowid: number
    }
  ).rowid
  const expectedRowidAdvance = streamPersistExpectedRowidAdvance()
  const triggerFiresOnEveryUpdate = streamingNormRowidAfter - streamingNormRowidBefore === expectedRowidAdvance

  // -------------------------------------------------------------------------
  // Post parity — base equality + projection equivalence (BEFORE metrics/artifact)
  // -------------------------------------------------------------------------

  const baseParityOk = baseEqual()

  // Explicitly rebuild the base-only lane's projection (production candidate
  // rebuild) and compare against the trigger-maintained lane's projection.
  dbOff.exec(DERIVED_PROJECTION_REBUILD_SQL.join(';\n'))
  const projectionEquivalenceOk = projectionEqual(projectionRowsOf(dbOn), projectionRowsOf(dbOff))

  // 1:1 projection row invariant (no accumulation/leak): each trigger-on
  // content update performs a paired DELETE+INSERT of the normalized AND FTS
  // projections, so the projection row counts stay exactly the canonical
  // corpus (SEED_LENGTH seed blocks + 1 streaming block). Confirms the
  // structural phenomenon without relying on SQLite's shadow-table counting.
  const expectedProjectionRows = SEED_LENGTH + 1
  const normOnCount = (dbOn.prepare('SELECT COUNT(*) AS n FROM message_blocks_normalized').get() as { n: number }).n
  const ftsOnCount = (dbOn.prepare('SELECT COUNT(*) AS n FROM message_blocks_fts').get() as { n: number }).n
  const projectionRowInvariantOk = normOnCount === expectedProjectionRows && ftsOnCount === expectedProjectionRows

  // Projection row-op accounting: better-sqlite3's `changes` exposes only the
  // row directly modified by the UPDATE (the base row), NOT the trigger-derived
  // DELETE+INSERT rows, so the trigger-maintained lane's `changes` is also 1,
  // not strictly greater. The L1 gate is therefore exactly three structurally
  // sound proofs: base-only `changes === 1` (base row only), the trigger FIRES
  // on every content update (proven deterministically by the normalized-rowid
  // advance below, including identical-content rewrites), and the projection
  // stays 1:1 (the row invariant above). Exact `changes` values are recorded
  // below as L3 directional metrics, never asserted as a strict inequality.
  const opsOn = opCounts
    .get('growth')!
    .triggerOn.concat(opCounts.get('nochange')!.triggerOn, opCounts.get('completion')!.triggerOn)
  const opsOff = opCounts
    .get('growth')!
    .baseOnly.concat(opCounts.get('nochange')!.baseOnly, opCounts.get('completion')!.baseOnly)
  const projectionOpsOk = opsOff.every((c) => c === 1) && triggerFiresOnEveryUpdate && projectionRowInvariantOk

  const finalOnStatus = (
    dbOn.prepare('SELECT status FROM message_blocks WHERE id = ?').get(STREAM_BLOCK_ID) as { status: string }
  ).status
  const finalOffStatus = (
    dbOff.prepare('SELECT status FROM message_blocks WHERE id = ?').get(STREAM_BLOCK_ID) as { status: string }
  ).status
  const completionFirstTransitionOk =
    completionFirstTimedOnStatus === STREAM_PERSIST_COMPLETION_STATUS &&
    completionFirstTimedOffStatus === STREAM_PERSIST_COMPLETION_STATUS
  const completionFlipOk =
    completionWarmupSeenStreaming &&
    completionMeasuredSeenSuccess &&
    completionFirstTransitionOk &&
    finalOnStatus === STREAM_PERSIST_COMPLETION_STATUS &&
    finalOffStatus === STREAM_PERSIST_COMPLETION_STATUS

  const postErrors: string[] = []
  if (!baseParityOk) postErrors.push('post: base tables differ after the update sequences')
  if (!projectionEquivalenceOk)
    postErrors.push('post: rebuilt base-only projection differs from trigger-maintained projection')
  if (!projectionRowInvariantOk)
    postErrors.push(
      `post: projection row invariant failed (normalized=${normOnCount}, fts=${ftsOnCount}, expected=${expectedProjectionRows})`
    )
  if (!triggerFiresOnEveryUpdate)
    postErrors.push(
      `post: the projection trigger did NOT fire on every update (normalized rowid advanced ${streamingNormRowidAfter - streamingNormRowidBefore}, ` +
        `expected ${expectedRowidAdvance} deterministic heat+timed writes per streamPersistExpectedRowidAdvance())`
    )
  if (!projectionOpsOk)
    postErrors.push(
      `post: projection row-op accounting failed (triggerOn changes=${JSON.stringify([...new Set(opsOn)].slice(0, 4))}, ` +
        `baseOnly changes=${JSON.stringify([...new Set(opsOff)].slice(0, 4))})`
    )
  if (!completionFlipOk)
    postErrors.push(
      `post: completion status flip not verified (warmup streaming=${completionWarmupSeenStreaming} measured success=${completionMeasuredSeenSuccess} firstTimed on/off ${completionFirstTimedOnStatus}/${completionFirstTimedOffStatus} final on/off ${finalOnStatus}/${finalOffStatus})`
    )
  if (postErrors.length > 0) {
    cleanup()
    throw new Error(`Streaming persist benchmark aborted — post parity failed:\n${postErrors.join('\n')}`)
  }

  // -------------------------------------------------------------------------
  // Sample completeness guard (fail-fast BEFORE artifact build)
  // -------------------------------------------------------------------------

  const sampleValidation = assertStreamPersistSampleCounts(samples, STREAM_PERSIST_MEASURE_ROUNDS)

  // -------------------------------------------------------------------------
  // Console report
  // -------------------------------------------------------------------------

  const fmt = (value: number): string => value.toFixed(3)
  const reportLines = STREAM_PERSIST_PROFILES.map((profile) => {
    const laneSamples = samples.get(profile)!
    const stats = (values: number[]): string => {
      const sorted = [...values].sort((a, b) => a - b)
      const percentile = (p: number): number => sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? 0
      return `p50=${fmt(percentile(50))} p95=${fmt(percentile(95))} mean=${fmt(sorted.reduce((s, v) => s + v, 0) / sorted.length)}`
    }
    const diff = laneSamples.triggerOn.map((v, i) => v - laneSamples.baseOnly[i])
    return (
      `  ${profile.padEnd(12)} on ${stats(laneSamples.triggerOn).padEnd(52)}` +
      `off ${stats(laneSamples.baseOnly).padEnd(52)}` +
      `Δp50=${fmt([...diff].sort((a, b) => a - b)[Math.ceil(0.5 * diff.length) - 1] ?? 0)} ms`
    )
  }).join('\n')

  console.log(
    `\n=== Streaming persistence differential (${STREAM_PERSIST_MEASURE_ROUNDS} measured rounds/profile, ` +
      `${STREAM_PERSIST_CORPUS_BLOCKS}-block corpus) ===\n${reportLines}` +
      `\nClaim boundary (LOCK-STREAM-ATTR-006): per-round 'triggerOn − baseOnly' is a differential ESTIMATE of the ` +
      `projection-trigger cost; it is NOT direct trigger-body profiling and NOT root cause.`
  )

  // -------------------------------------------------------------------------
  // Schema-v1 artifact (closed contract) — built here, written only by afterAll
  // -------------------------------------------------------------------------

  const metrics = buildStreamPersistMetrics(samples)
  const scale = streamPersistScale()
  // L3 directional accounting: exact per-call changed-row counts (mean) per
  // lane — reflects the derived DELETE+INSERT rows fired per content update.
  const changesMeanOn = opsOn.reduce((a, b) => a + b, 0) / opsOn.length
  const changesMeanOff = opsOff.reduce((a, b) => a + b, 0) / opsOff.length
  const metricsWithCounts = [
    ...metrics,
    {
      id: 'counts.changesOnMean',
      name: 'Mean sqlite changes per content update (trigger-maintained lane; better-sqlite3 exposes only the base row)',
      value: changesMeanOn
    },
    {
      id: 'counts.changesOffMean',
      name: 'Mean sqlite changes per content update (base-only lane; base row only)',
      value: changesMeanOff
    },
    {
      id: 'counts.rowidAdvance',
      name: 'Normalized projection rowid advance across all profiles (proves the trigger fired per content update)',
      value: streamingNormRowidAfter - streamingNormRowidBefore
    },
    {
      id: 'counts.projectionRows',
      name: 'Projection row count after all profiles (must equal corpus; 1:1 DELETE+INSERT pair invariant)',
      value: normOnCount
    }
  ]
  const gatesDetail = {
    seedParity: `${STREAM_PERSIST_CORPUS_BLOCKS} corpus blocks + streaming block seeded identically; base tables and projections equal; base-only lane has 0 sync triggers`,
    postBaseParity: `preflight base-table parity passed before timing; base tables equal after the identical update sequences (all 3 profiles)`,
    projectionEquivalence:
      'preflight projection equivalence passed before timing; explicit candidate rebuild of the base-only lane matched the trigger-maintained projection (normalized + FTS rows, content-level)',
    projectionOps:
      `preflight projection row-op accounting passed before timing; base-only lane reported changes=1 (base row only); the trigger-maintained normalized rowid advanced exactly ${streamingNormRowidAfter - streamingNormRowidBefore} ` +
      `(= ${expectedRowidAdvance} deterministic heat+timed writes per streamPersistExpectedRowidAdvance()) — proving the rowid DELETE+INSERT trigger fired on EVERY content update including identical-content rewrites; projection stayed 1:1 (${normOnCount} rows)`,
    completionFlip: `warmup streaming=${completionWarmupSeenStreaming} measured success=${completionMeasuredSeenSuccess} firstTimed on/off ${completionFirstTimedOnStatus}/${completionFirstTimedOffStatus} final on/off ${finalOnStatus}/${finalOffStatus} preflight firstTimed also success`,
    samplesComplete: `${sampleValidation.verifiedProfiles.length}/${STREAM_PERSIST_PROFILES.length} profiles recorded with exactly ${sampleValidation.expectedCount} samples in each of ${sampleValidation.verifiedLanes.length} lanes (fail-fast guard passed before artifact build)`,
    abi137: 'Node lane, abi=137'
  }

  const environment = collectEnvironmentMetadata({ command: STREAM_PERSIST_NODE_COMMAND })
  const abi137Gate = environment.abiLane === 'node' && environment.abi === '137'

  const streamPersistResult: BenchmarkResult = {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: STREAM_PERSIST_NODE_BENCH_ID,
      name: STREAM_PERSIST_NODE_BENCH_NAME,
      scale: {
        warmupRounds: scale.warmupRounds,
        measureRounds: scale.measureRounds,
        corpusBlocks: scale.corpusBlocks,
        profileCode: scale.profileCode,
        profiles: STREAM_PERSIST_PROFILES.length
      }
    },
    environment,
    metrics: metricsWithCounts,
    gates: buildStreamPersistGates(
      {
        seedParity: true,
        postBaseParity: baseParityOk,
        projectionEquivalence: projectionEquivalenceOk,
        projectionOps: projectionOpsOk,
        completionFlip: completionFlipOk,
        samplesComplete: sampleValidation.ok,
        abi137: abi137Gate,
        schemaV1: true
      },
      gatesDetail
    )
  }

  // -------------------------------------------------------------------------
  // Vitest bench tasks — comparison output; authoritative metrics/gates are
  // the artifact above
  // -------------------------------------------------------------------------

  describe(`streaming persistence differential — ${STREAM_PERSIST_CORPUS_BLOCKS}-block corpus (${STREAM_PERSIST_MEASURE_ROUNDS} rounds/profile)`, () => {
    bench(
      'per-round trigger-maintained UPDATE + base-only UPDATE (all profiles)',
      () => {
        for (const profile of [...STREAM_PERSIST_PROFILES].reverse()) {
          const content = streamPersistContent(profile, STREAM_PERSIST_MEASURE_ROUNDS)
          const status = streamPersistStatus(profile, STREAM_PERSIST_MEASURE_ROUNDS)
          stmtOn.run(content, status, STREAM_BLOCK_ID)
          stmtOff.run(content, status, STREAM_BLOCK_ID)
        }
      },
      { warmupIterations: 1, iterations: 2 }
    )
  })

  afterAll((suite) => {
    const artifactPath = emitBenchmarkResultAfterSuccessfulTasks(suite, streamPersistResult)
    if (artifactPath !== null) {
      console.log(`Result artifact: ${artifactPath}`)
    }
    cleanup()
  })
}
