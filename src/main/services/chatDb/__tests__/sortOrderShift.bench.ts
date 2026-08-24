/**
 * Sort-Order Shift Controlled Scale Curve — Measurement-Only M1 Diagnostic
 *
 * MEASUREMENT-ONLY (LOCK-001): records the deterministic middle/batch insert
 * `sort_order` shift scale curve (N = 100/500/1000 × M = 1/10/50, index
 * floor(N/2)) via isolated temporary SQLite + existing MessagesRepository
 * insertAt/insertManyAt APIs. No production SQL/schema/index/IPC/migration
 * change; the harness calls existing repository APIs against a temporary
 * migrated DB (LOCK-002). The matrix is bounded (3×3 = 9 combos) and is
 * DIRECTIONAL diagnostic evidence only — no threshold, capacity, or default
 * is adopted from it.
 *
 * ENV-GATED (default skip, LOCK-005): the diagnostic body runs ONLY when
 * `SORT_ORDER_SHIFT_BENCH=1` is set (canonical `pnpm bench:sort-order-shift`
 * script). Under the default `pnpm bench:main:native` the file registers a
 * single SKIPPED task and performs ZERO setup — no temp DB, no corpus, no
 * migrations, no artifact.
 *
 *   SORT_ORDER_SHIFT_BENCH=1 \
 *     pnpm native:run node -- vitest bench --run --project main-native \
 *       src/main/services/chatDb/__tests__/sortOrderShift.bench.ts
 *   # or simply: pnpm bench:sort-order-shift
 *
 * METHODOLOGY (trigger-based shifted-row counting):
 *  - An isolated temporary SQLite database is created via `mkdtempSync` +
 *    `better-sqlite3` with `registerChatDbNormalize` + `runMigrations` schema-v1
 *    setup; no user data is touched.
 *  - Deterministic synthetic topic/messages: one topic `sort-shift-topic` is
 *    populated per combo with N dense zero-based rows (sort_order 0..N-1).
 *    Corpus generation and trigger setup are OUTSIDE the timed window.
 *  - A TEMP trigger local to the harness counts shifted rows:
 *      CREATE TEMP TABLE shift_log(n INTEGER);
 *      CREATE TEMP TRIGGER trg_sort_shift AFTER UPDATE OF sort_order ON messages
 *        WHEN NEW.sort_order != OLD.sort_order
 *        BEGIN INSERT INTO shift_log(n) VALUES (1); END;
 *    The WHEN clause ensures only value-changing updates are counted (the
 *    dense-topic normalizeOrdersInTx rewrite that assigns the same dense value
 *    is not counted), so the count equals N - index for a dense topic —
 *    both for single (`insertAt`) and batch (`insertManyAt`, N-index
 *    regardless of M). The trigger is TEMP and harness-local (LOCK-002).
 *  - Correctness/parity assertions run BEFORE any timing for every combo:
 *    expected row count N, dense zero-based ordering 0..N-1, expected shifted
 *    count N-index after the insert, row count N+M, dense ordering 0..N+M-1.
 *    Failure aborts with no artifact.
 *  - Timing: for each combo, warmupRounds (3) + measureRounds (20) rounds;
 *    each round recreates the N-row corpus and clears shift_log OUTSIDE the
 *    timed window, then measures ONLY the insertAt/insertManyAt call via
 *    `performance.now()`. The count is read after the window and verified
 *    against expected before the sample is recorded; timing samples never
 *    include trigger setup or corpus generation.
 *  - Artifact: schema-v1 (`benchResult.ts` closed contract), stable id
 *    `chatdb-sort-order-shift`, emitted only after every registered tinybench
 *    task completed successfully (audit F1). `benchmark.scale` makes topic
 *    sizes (100/500/1000) and batch sizes (1/10/50) visible as finite numbers.
 *    The `samples.complete` gate records the sample-count guard's actual
 *    validation outcome. The `environment.command` is the explicit canonical
 *    `pnpm bench:sort-order-shift` (never argv-derived).
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
  assertSortOrderShiftSampleCounts,
  buildSortOrderShiftMetrics,
  computeTimingStats,
  expectedShiftedCount,
  resolveSortOrderShiftGate,
  SORT_ORDER_SHIFT_BATCH_SIZES,
  SORT_ORDER_SHIFT_BENCH_ENV,
  SORT_ORDER_SHIFT_BENCH_ID,
  SORT_ORDER_SHIFT_BENCH_NAME,
  SORT_ORDER_SHIFT_COMBOS,
  SORT_ORDER_SHIFT_COMMAND,
  SORT_ORDER_SHIFT_MEASURE_ROUNDS,
  SORT_ORDER_SHIFT_TOPIC_SIZES,
  SORT_ORDER_SHIFT_WARMUP_ROUNDS,
  sortOrderShiftScale
} from './sortOrderShiftBench'

// ---------------------------------------------------------------------------
// Env gate — the diagnostic body is inert unless explicitly enabled
// ---------------------------------------------------------------------------

const shiftEnabled = resolveSortOrderShiftGate(process.env[SORT_ORDER_SHIFT_BENCH_ENV])

if (!shiftEnabled) {
  // Default collection: zero setup (no temp DB, no corpus, no migrations, no
  // artifact) and a single self-documenting skipped task. Run the diagnostic
  // only through the canonical `pnpm bench:sort-order-shift` script.
  describe('sort-order shift diagnostic (on-demand, M1)', () => {
    bench.skip('sort-order shift skipped — enable via pnpm bench:sort-order-shift (SORT_ORDER_SHIFT_BENCH=1)', () => {})
  })
} else {
  // -------------------------------------------------------------------------
  // Setup — isolated temporary SQLite database, schema-v1
  // -------------------------------------------------------------------------

  const tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-sort-shift-bench-'))
  const sqlite = new Database(realPath.join(tempDir, 'chat.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')

  registerChatDbNormalize(sqlite)
  runMigrations(drizzle(sqlite, { schema }), sqlite)

  const BENCH_TOPIC_ID = 'sort-shift-topic'
  const BENCH_CREATED_AT = '2025-01-01T00:00:00.000Z'
  const BENCH_ASSISTANT_ID = 'bench-asst'

  const db = drizzle(sqlite, { schema })
  const topicsRepo = new TopicsRepository(db)
  const messagesRepo = new MessagesRepository(db)

  // Ensure the single synthetic topic exists once.
  topicsRepo.create({
    id: BENCH_TOPIC_ID,
    assistantId: BENCH_ASSISTANT_ID,
    name: 'Sort Shift Diagnostic Topic',
    createdAt: BENCH_CREATED_AT,
    updatedAt: BENCH_CREATED_AT,
    deletedAt: null,
    overflow: {}
  })

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
  // Deterministic synthetic corpus helpers — outside the timed window
  // -------------------------------------------------------------------------

  /**
   * Recreate a dense zero-based topic with exactly `count` messages
   * (sort_order 0..count-1). Caller must have ensured the topic exists.
   * This is corpus generation and is NOT inside any timed window.
   */
  function seedTopic(topicId: string, count: number): void {
    // Delete any prior messages for the topic (idempotent reset).
    sqlite.prepare('DELETE FROM messages WHERE topic_id = ?').run(topicId)
    const stmt = sqlite.prepare(
      'INSERT INTO messages (id, topic_id, role, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    const insertMany = sqlite.transaction(() => {
      for (let i = 0; i < count; i++) {
        const id = `seed-${count}-${String(i).padStart(5, '0')}`
        stmt.run(id, topicId, 'user', i, BENCH_CREATED_AT)
      }
    })
    insertMany()
  }

  function verifyDense(topicId: string, expectedCount: number): void {
    const rows = sqlite
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id = ? ORDER BY sort_order ASC, id ASC')
      .all(topicId) as Array<{ id: string; sort_order: number }>
    if (rows.length !== expectedCount) {
      throw new Error(`verifyDense: topic ${topicId} expected ${expectedCount} rows, got ${rows.length}`)
    }
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].sort_order !== i) {
        throw new Error(
          `verifyDense: topic ${topicId} row ${i} sort_order ${rows[i].sort_order} != ${i} (not dense zero-based)`
        )
      }
    }
  }

  function pad(n: number, width: number): string {
    return String(n).padStart(width, '0')
  }

  // -------------------------------------------------------------------------
  // TEMP trigger for shifted-row counting — harness-local, isolated
  // -------------------------------------------------------------------------

  /**
   * Create the TEMP counting infrastructure. The WHEN clause ensures only
   * value-changing sort_order updates are counted, so the dense-topic
   * normalize rewrite that assigns the same value is not counted.
   */
  function ensureShiftLogAndTrigger(): void {
    sqlite.exec('CREATE TEMP TABLE IF NOT EXISTS shift_log(n INTEGER)')
    sqlite.exec('DROP TRIGGER IF EXISTS TEMP.trg_sort_shift')
    sqlite.exec(`
      CREATE TEMP TRIGGER trg_sort_shift
      AFTER UPDATE OF sort_order ON messages
      WHEN NEW.sort_order != OLD.sort_order
      BEGIN
        INSERT INTO shift_log(n) VALUES (1);
      END
    `)
  }

  function clearShiftLog(): void {
    sqlite.prepare('DELETE FROM shift_log').run()
  }

  function getShiftedCount(): number {
    const row = sqlite.prepare('SELECT COUNT(*) as c FROM shift_log').get() as { c: number }
    return row.c
  }

  function teardownShiftLog(): void {
    sqlite.exec('DROP TRIGGER IF EXISTS TEMP.trg_sort_shift')
    sqlite.exec('DROP TABLE IF EXISTS TEMP.shift_log')
  }

  // Install trigger once (logs are cleared per round).
  ensureShiftLogAndTrigger()

  // -------------------------------------------------------------------------
  // Correctness/parity assertions — BEFORE any timing (fail-closed)
  // -------------------------------------------------------------------------

  const parityErrors: string[] = []
  const shiftedGateErrors: string[] = []

  for (const combo of SORT_ORDER_SHIFT_COMBOS) {
    const { topicSize: N, batchSize: M, index, id } = combo
    const expectedShift = expectedShiftedCount(N, index)

    // Reset corpus for this combo's correctness probe.
    seedTopic(BENCH_TOPIC_ID, N)
    try {
      verifyDense(BENCH_TOPIC_ID, N)
    } catch (e) {
      parityErrors.push(`${id}: seed dense check failed: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    const countBefore = messagesRepo.countByTopic(BENCH_TOPIC_ID)
    if (countBefore !== N) {
      parityErrors.push(`${id}: expected count ${N}, got ${countBefore}`)
      continue
    }

    clearShiftLog()

    if (M === 1) {
      // Single middle insert path — existing MessagesRepository.insertAt API.
      const data = {
        id: `probe-${id}-single`,
        topicId: BENCH_TOPIC_ID,
        role: 'user' as const,
        content: 'probe single',
        status: 'success' as const,
        askId: null,
        model: null,
        modelId: null,
        assistantId: BENCH_ASSISTANT_ID,
        createdAt: BENCH_CREATED_AT,
        updatedAt: BENCH_CREATED_AT,
        sortOrder: 0,
        overflow: {}
      }
      messagesRepo.insertAt(data as any, index)
    } else {
      // Batch middle insert path — existing MessagesRepository.insertManyAt API.
      const items = Array.from({ length: M }, (_, j) => ({
        id: `probe-${id}-batch-${pad(j, 3)}`,
        topicId: BENCH_TOPIC_ID,
        role: 'user' as const,
        content: `probe batch ${j}`,
        status: 'success' as const,
        askId: null,
        model: null,
        modelId: null,
        assistantId: BENCH_ASSISTANT_ID,
        createdAt: BENCH_CREATED_AT,
        updatedAt: BENCH_CREATED_AT,
        sortOrder: 0,
        overflow: {}
      }))
      messagesRepo.insertManyAt(items as any[], index)
    }

    const shifted = getShiftedCount()
    if (shifted !== expectedShift) {
      shiftedGateErrors.push(
        `${id}: shifted count ${shifted} != expected ${expectedShift} (N=${N} index=${index} M=${M})`
      )
    }

    const countAfter = messagesRepo.countByTopic(BENCH_TOPIC_ID)
    const expectedCount = N + M
    if (countAfter !== expectedCount) {
      parityErrors.push(`${id}: expected row count ${expectedCount}, got ${countAfter}`)
    }

    try {
      verifyDense(BENCH_TOPIC_ID, expectedCount)
    } catch (e) {
      parityErrors.push(`${id}: post-insert dense check failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // Verify inserted batch occupies index..index+M-1 contiguously and
    // surrounding seed rows remain in order — complete expected-order parity
    // (fail-closed). Any id out of position aborts before timing.
    const rows = sqlite
      .prepare('SELECT sort_order, id FROM messages WHERE topic_id = ? ORDER BY sort_order ASC')
      .all(BENCH_TOPIC_ID) as Array<{ sort_order: number; id: string }>
    const expectedIds: string[] = []
    for (let i = 0; i < index; i++) {
      expectedIds.push(`seed-${N}-${pad(i, 5)}`)
    }
    if (M === 1) {
      expectedIds.push(`probe-${id}-single`)
    } else {
      for (let j = 0; j < M; j++) {
        expectedIds.push(`probe-${id}-batch-${pad(j, 3)}`)
      }
    }
    for (let i = index; i < N; i++) {
      expectedIds.push(`seed-${N}-${pad(i, 5)}`)
    }
    if (rows.length !== expectedIds.length) {
      parityErrors.push(`${id}: expected order length ${expectedIds.length}, got ${rows.length}`)
    } else {
      for (let k = 0; k < expectedIds.length; k++) {
        if (rows[k].id !== expectedIds[k]) {
          parityErrors.push(
            `${id}: order mismatch at sort_order ${k}: expected ${expectedIds[k]}, got ${rows[k].id} (N=${N} M=${M} index=${index})`
          )
          break
        }
      }
    }
  }

  if (parityErrors.length > 0 || shiftedGateErrors.length > 0) {
    teardownShiftLog()
    cleanup()
    throw new Error(
      `Benchmark aborted — correctness parity failed BEFORE timing:\n` +
        [...parityErrors, ...shiftedGateErrors].join('\n')
    )
  }

  console.log(
    `Parity: ${SORT_ORDER_SHIFT_COMBOS.length}/${SORT_ORDER_SHIFT_COMBOS.length} combos passed dense zero-based ordering ` +
      `and expected shifted count (N-index) before timing; ` +
      `scale matrix topicSizes ${SORT_ORDER_SHIFT_TOPIC_SIZES.join('/')} batchSizes ${SORT_ORDER_SHIFT_BATCH_SIZES.join('/')} index floor(N/2)`
  )

  // -------------------------------------------------------------------------
  // Measurement — per-combo warmup + measured rounds (timed window = insert only)
  // -------------------------------------------------------------------------

  const samples = new Map<string, number[]>()
  const shiftedCounts = new Map<string, number>()
  for (const combo of SORT_ORDER_SHIFT_COMBOS) {
    samples.set(combo.id, [])
    shiftedCounts.set(combo.id, expectedShiftedCount(combo.topicSize, combo.index))
  }

  // Warmup (not recorded) — heats statement caches per combo.
  for (let r = 0; r < SORT_ORDER_SHIFT_WARMUP_ROUNDS; r++) {
    for (const combo of SORT_ORDER_SHIFT_COMBOS) {
      const { topicSize: N, batchSize: M, index } = combo
      seedTopic(BENCH_TOPIC_ID, N)
      clearShiftLog()
      if (M === 1) {
        messagesRepo.insertAt(
          {
            id: `warmup-${combo.id}-${r}`,
            topicId: BENCH_TOPIC_ID,
            role: 'user',
            content: 'warmup',
            status: 'success',
            askId: null,
            model: null,
            modelId: null,
            assistantId: BENCH_ASSISTANT_ID,
            createdAt: BENCH_CREATED_AT,
            updatedAt: BENCH_CREATED_AT,
            sortOrder: 0,
            overflow: {}
          } as any,
          index
        )
      } else {
        const items = Array.from({ length: M }, (_, j) => ({
          id: `warmup-${combo.id}-${r}-${pad(j, 3)}`,
          topicId: BENCH_TOPIC_ID,
          role: 'user',
          content: 'warmup',
          status: 'success',
          askId: null,
          model: null,
          modelId: null,
          assistantId: BENCH_ASSISTANT_ID,
          createdAt: BENCH_CREATED_AT,
          updatedAt: BENCH_CREATED_AT,
          sortOrder: 0,
          overflow: {}
        }))
        messagesRepo.insertManyAt(items as any[], index)
      }
    }
  }

  // Measured rounds — timing window excludes trigger setup and corpus generation.
  for (let round = 0; round < SORT_ORDER_SHIFT_MEASURE_ROUNDS; round++) {
    for (const combo of SORT_ORDER_SHIFT_COMBOS) {
      const { topicSize: N, batchSize: M, index, id } = combo
      // Corpus generation outside the timed window.
      seedTopic(BENCH_TOPIC_ID, N)
      clearShiftLog()

      // Input construction outside the timed window — timed interval contains only the repository call.
      let singleData: any = null
      let batchItems: any[] | null = null
      if (M === 1) {
        singleData = {
          id: `m-${id}-${pad(round, 3)}`,
          topicId: BENCH_TOPIC_ID,
          role: 'user',
          content: `measured ${round}`,
          status: 'success',
          askId: null,
          model: null,
          modelId: null,
          assistantId: BENCH_ASSISTANT_ID,
          createdAt: BENCH_CREATED_AT,
          updatedAt: BENCH_CREATED_AT,
          sortOrder: 0,
          overflow: {}
        } as any
      } else {
        batchItems = Array.from({ length: M }, (_, j) => ({
          id: `m-${id}-${pad(round, 3)}-${pad(j, 3)}`,
          topicId: BENCH_TOPIC_ID,
          role: 'user',
          content: `measured ${round}-${j}`,
          status: 'success',
          askId: null,
          model: null,
          modelId: null,
          assistantId: BENCH_ASSISTANT_ID,
          createdAt: BENCH_CREATED_AT,
          updatedAt: BENCH_CREATED_AT,
          sortOrder: 0,
          overflow: {}
        })) as any[]
      }

      const timedStart = performance.now()
      if (M === 1) {
        messagesRepo.insertAt(singleData, index)
      } else {
        messagesRepo.insertManyAt(batchItems!, index)
      }
      const elapsed = performance.now() - timedStart

      // Verify shifted count AFTER the timed window (not counted in timing).
      const shifted = getShiftedCount()
      const expectedShift = expectedShiftedCount(N, index)
      if (shifted !== expectedShift) {
        teardownShiftLog()
        cleanup()
        throw new Error(
          `Measurement aborted — shifted count mismatch during timing: combo ${id} round ${round} ` +
            `shifted ${shifted} != expected ${expectedShift} (N=${N} index=${index} M=${M})`
        )
      }

      samples.get(id)!.push(elapsed)
    }
  }

  // Fail-fast completeness guard — exact sample counts BEFORE result build.
  const sampleValidation = assertSortOrderShiftSampleCounts(
    SORT_ORDER_SHIFT_COMBOS,
    samples,
    SORT_ORDER_SHIFT_MEASURE_ROUNDS
  )

  // -------------------------------------------------------------------------
  // Console report (per-combo timing + shifted count)
  // -------------------------------------------------------------------------

  const reportLines = SORT_ORDER_SHIFT_COMBOS.map((combo) => {
    const comboSamples = samples.get(combo.id)!
    const stats = computeTimingStats(comboSamples)
    const shifted = shiftedCounts.get(combo.id)!
    return (
      `  ${combo.id.padEnd(10)} N=${String(combo.topicSize).padStart(4)} M=${String(combo.batchSize).padStart(2)} ` +
      `idx=${String(combo.index).padStart(3)} shifted=${String(shifted).padStart(3)} ` +
      `p50=${stats.p50.toFixed(3).padStart(7)}ms p95=${stats.p95.toFixed(3).padStart(7)}ms ` +
      `mean=${stats.mean.toFixed(3).padStart(7)}ms max=${stats.max.toFixed(3).padStart(7)}ms`
    )
  }).join('\n')

  console.log(
    `\n=== Sort-Order Shift Scale Curve (on-demand diagnostic, M1) ===\n` +
      `Matrix: topicSizes ${SORT_ORDER_SHIFT_TOPIC_SIZES.join(', ')} × batchSizes ${SORT_ORDER_SHIFT_BATCH_SIZES.join(', ')} ` +
      `(index floor(N/2); 9 combos; directional evidence only, no threshold)\n` +
      `Rounds: ${SORT_ORDER_SHIFT_WARMUP_ROUNDS} warmup + ${SORT_ORDER_SHIFT_MEASURE_ROUNDS} measured per combo\n` +
      `${reportLines}`
  )

  // -------------------------------------------------------------------------
  // Schema-v1 artifact (closed contract) — built here, written only by the
  // file-level afterAll below after every registered task completed (audit F1)
  // -------------------------------------------------------------------------

  const metrics = buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, samples, shiftedCounts)

  const sortShiftBenchmarkResult: BenchmarkResult = {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: SORT_ORDER_SHIFT_BENCH_ID,
      name: SORT_ORDER_SHIFT_BENCH_NAME,
      scale: {
        ...sortOrderShiftScale(),
        combos: SORT_ORDER_SHIFT_COMBOS.length
      }
    },
    environment: collectEnvironmentMetadata({ command: SORT_ORDER_SHIFT_COMMAND }),
    metrics,
    gates: [
      {
        id: 'parity.rowCountAndDense',
        name: 'Row count and dense zero-based ordering parity before timing',
        kind: 'correctness',
        passed: parityErrors.length === 0,
        detail: `${SORT_ORDER_SHIFT_COMBOS.length}/${SORT_ORDER_SHIFT_COMBOS.length} combos passed dense ordering and expected row count before timing`
      },
      {
        id: 'parity.shiftedCount',
        name: 'Expected shifted count (N-index for single, N-index for batch regardless of batch size) before timing',
        kind: 'correctness',
        passed: shiftedGateErrors.length === 0,
        detail:
          shiftedGateErrors.length === 0
            ? `all ${SORT_ORDER_SHIFT_COMBOS.length} combos shifted count = N - floor(N/2) (e.g. N=100→50, N=500→250, N=1000→500)`
            : shiftedGateErrors.join('; ')
      },
      {
        id: 'samples.complete',
        name: `Exactly ${SORT_ORDER_SHIFT_MEASURE_ROUNDS} samples per combo`,
        kind: 'correctness',
        passed: sampleValidation.ok,
        detail:
          `${sampleValidation.verifiedCombos.length}/${SORT_ORDER_SHIFT_COMBOS.length} combos recorded with ` +
          `exactly ${sampleValidation.expectedCount} samples (fail-fast guard passed before artifact build)`
      }
    ]
  }

  // -------------------------------------------------------------------------
  // Vitest bench tasks — comparison output; the authoritative metrics and
  // gates are the artifact above
  // -------------------------------------------------------------------------

  describe(`sort-order shift — middle/batch insert scale curve (${SORT_ORDER_SHIFT_COMBOS.length} combos)`, () => {
    bench(
      'middle/batch insertAll combos (single insertAt + batch insertManyAt)',
      () => {
        for (const combo of SORT_ORDER_SHIFT_COMBOS) {
          const { topicSize: N, batchSize: M, index } = combo
          // Bench task uses the same corpus reset + insert path as the timed
          // measurement above, but as a single pooled tinybench task (comparison
          // output). The authoritative per-combo metrics are from the manual
          // timing above; this task exists solely so the artifact emission gate
          // observes a completed bench task (audit F1).
          seedTopic(BENCH_TOPIC_ID, N)
          clearShiftLog()
          if (M === 1) {
            messagesRepo.insertAt(
              {
                id: `bench-${combo.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                topicId: BENCH_TOPIC_ID,
                role: 'user',
                content: 'bench',
                status: 'success',
                askId: null,
                model: null,
                modelId: null,
                assistantId: BENCH_ASSISTANT_ID,
                createdAt: BENCH_CREATED_AT,
                updatedAt: BENCH_CREATED_AT,
                sortOrder: 0,
                overflow: {}
              } as any,
              index
            )
          } else {
            const items = Array.from({ length: M }, (_, j) => ({
              id: `bench-${combo.id}-${Date.now()}-${Math.random().toString(36).slice(2)}-${j}`,
              topicId: BENCH_TOPIC_ID,
              role: 'user',
              content: 'bench',
              status: 'success',
              askId: null,
              model: null,
              modelId: null,
              assistantId: BENCH_ASSISTANT_ID,
              createdAt: BENCH_CREATED_AT,
              updatedAt: BENCH_CREATED_AT,
              sortOrder: 0,
              overflow: {}
            }))
            messagesRepo.insertManyAt(items as any[], index)
          }
        }
      },
      { warmupIterations: 1, iterations: 2 }
    )
  })

  afterAll((suite) => {
    const artifactPath = emitBenchmarkResultAfterSuccessfulTasks(suite, sortShiftBenchmarkResult)
    if (artifactPath !== null) {
      console.log(`Result artifact: ${artifactPath}`)
    }
    teardownShiftLog()
    cleanup()
  })
}
