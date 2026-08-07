/**
 * SQLite Runtime Performance Benchmarks — Phase 5.4
 *
 * Measures three critical runtime surfaces against the SQLite-authoritative
 * chatDb path using deterministic temp databases:
 *
 *   1. Message-load p50/p95 — full topic load (listByTopic + listByMessages)
 *   2. Write throughput — batch message+block inserts (ops/sec)
 *   3. Cold DB open latency — fresh open + pragmas + migrations (<500ms gate)
 *
 * LOCK-5.4.1: All data is generated in temp directories. No user data touched.
 * LOCK-5.4.2: No historical Dexie comparator values exist in the repository.
 *   Comparator absence is reported explicitly in output.
 * LOCK-5.4.3: Only the documented cold-open <500ms threshold is enforced.
 *   No arbitrary write/load thresholds are asserted.
 *
 * Run with:
 *   npx vitest bench --run --project main-native src/main/services/chatDb/__tests__/sqlite-runtime.perf.bench.ts
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

import type { MessageBlockData, MessageData } from '../domain/types'
import { registerChatDbNormalize, runMigrations } from '../migration'
import { BlocksRepository } from '../repository/BlocksRepository'
import { MessagesRepository } from '../repository/MessagesRepository'
import { TopicsRepository } from '../repository/TopicsRepository'
import * as schema from '../schema'

// Re-export for metric-helpers.test.ts
export { mean, opsPerSec, percentile, sortTimings, sum } from './benchMetrics'
import { mean, opsPerSec, percentile, sortTimings, sum } from './benchMetrics'

// ---------------------------------------------------------------------------
// Cleanup — registered early so temp files are removed even on setup failure
// ---------------------------------------------------------------------------

let _sqlite: Database.Database | null = null
let _tempDir: string | null = null

function cleanup(): void {
  try {
    _sqlite?.close()
  } catch {
    /* already closed */
  }
  if (_tempDir) {
    realFs.rmSync(_tempDir, { recursive: true, force: true })
  }
}

process.once('exit', cleanup)

// ---------------------------------------------------------------------------
// Fixture dimensions — deterministic, no randomness
// ---------------------------------------------------------------------------

const TOPIC_COUNT = 5
const MESSAGES_PER_TOPIC = 200
const TOTAL_MESSAGES = TOPIC_COUNT * MESSAGES_PER_TOPIC
const EXTRA_BLOCK_EVERY = 10
const BENCH_CREATED_AT = '2025-01-01T00:00:00.000Z'

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function topicIdOf(t: number): string {
  return `bench-topic-${pad(t, 2)}`
}

function messageIdOf(g: number): string {
  return `bench-msg-${pad(g, 5)}`
}

function blockIdOf(g: number): string {
  return `bench-block-${pad(g, 5)}`
}

function extraBlockIdOf(g: number): string {
  return `bench-xblock-${pad(g, 5)}`
}

// ---------------------------------------------------------------------------
// Setup — temp DB + deterministic corpus
// ---------------------------------------------------------------------------

const tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-runtime-bench-'))
_tempDir = tempDir
const dbPath = realPath.join(tempDir, 'chat.db')

function openFreshDb(dir: string): { sqlite: Database.Database; db: ReturnType<typeof drizzle> } {
  const sqlite = new Database(realPath.join(dir, 'chat.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')
  const db = drizzle(sqlite, { schema })
  registerChatDbNormalize(sqlite)
  runMigrations(db, sqlite)
  return { sqlite, db }
}

// --- Primary benchmark DB ---
const { sqlite, db } = openFreshDb(tempDir)
_sqlite = sqlite
const topicsRepo = new TopicsRepository(db)
const messagesRepo = new MessagesRepository(db)
const blocksRepo = new BlocksRepository(db)

// --- Populate deterministic corpus ---
const buildStart = performance.now()

for (let t = 0; t < TOPIC_COUNT; t++) {
  topicsRepo.create({
    id: topicIdOf(t),
    assistantId: 'bench-asst',
    name: `Bench Topic ${t}`,
    createdAt: BENCH_CREATED_AT,
    updatedAt: BENCH_CREATED_AT,
    deletedAt: null,
    overflow: {}
  })
}

const messageDataList: MessageData[] = []
const blockDataList: MessageBlockData[] = []

for (let g = 0; g < TOTAL_MESSAGES; g++) {
  const topicIndex = Math.floor(g / MESSAGES_PER_TOPIC)
  messageDataList.push({
    id: messageIdOf(g),
    topicId: topicIdOf(topicIndex),
    role: g % 2 === 0 ? 'user' : 'assistant',
    content: null,
    status: 'success',
    askId: null,
    model: null,
    modelId: null,
    assistantId: 'bench-asst',
    createdAt: BENCH_CREATED_AT,
    updatedAt: BENCH_CREATED_AT,
    sortOrder: g % MESSAGES_PER_TOPIC,
    overflow: {}
  })

  // One main_text block per message
  blockDataList.push({
    id: blockIdOf(g),
    messageId: messageIdOf(g),
    type: 'main_text',
    content: `Benchmark message content #${g}. This is realistic message text with varied length to simulate actual chat data. ${'Lorem ipsum dolor sit amet. '.repeat(Math.floor((g % 5) + 1))}`,
    status: 'success',
    createdAt: BENCH_CREATED_AT,
    updatedAt: BENCH_CREATED_AT,
    sortOrder: 0,
    overflow: {}
  })

  // Every Nth message gets an extra file block
  if (g % EXTRA_BLOCK_EVERY === 0) {
    blockDataList.push({
      id: extraBlockIdOf(g),
      messageId: messageIdOf(g),
      type: 'file',
      content: null,
      status: 'success',
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      sortOrder: 1,
      overflow: {}
    })
  }
}

// Batch insert messages (per-topic to respect FK constraint)
for (let t = 0; t < TOPIC_COUNT; t++) {
  const topicMessages = messageDataList.filter((m) => m.topicId === topicIdOf(t))
  messagesRepo.createMany(topicMessages)
}

// Batch insert blocks
blocksRepo.createMany(blockDataList)

const buildTime = performance.now() - buildStart

console.log(
  `\n=== SQLite Runtime Performance Benchmarks (Phase 5.4) ===\n` +
    `Topics: ${TOPIC_COUNT}\n` +
    `Messages: ${TOTAL_MESSAGES}\n` +
    `Blocks: ${blockDataList.length}\n` +
    `Corpus build time: ${buildTime.toFixed(1)}ms\n` +
    `Database: ${dbPath}\n` +
    `\nNote: No historical Dexie load/write values exist in the repository.\n` +
    `Comparator absence documented per LOCK-5.4.2.`
)

// ---------------------------------------------------------------------------
// Correctness checks — BEFORE any timing (same pattern as search.bench.ts)
// ---------------------------------------------------------------------------

// Verify all topics have the expected message count
const parityErrors: string[] = []
for (let t = 0; t < TOPIC_COUNT; t++) {
  const count = messagesRepo.countByTopic(topicIdOf(t))
  if (count !== MESSAGES_PER_TOPIC) {
    parityErrors.push(`Topic ${t}: expected ${MESSAGES_PER_TOPIC} messages, got ${count}`)
  }
}

// Verify message load returns full data
const sampleTopic = messagesRepo.listByTopic(topicIdOf(0))
if (sampleTopic.length !== MESSAGES_PER_TOPIC) {
  parityErrors.push(`listByTopic(0): expected ${MESSAGES_PER_TOPIC}, got ${sampleTopic.length}`)
}

const sampleIds = sampleTopic.map((m) => m.id)
const sampleBlocks = blocksRepo.listByMessages(sampleIds)
if (sampleBlocks.size !== MESSAGES_PER_TOPIC) {
  parityErrors.push(`listByMessages: expected ${MESSAGES_PER_TOPIC} entries, got ${sampleBlocks.size}`)
}

// Verify blocks have correct total count (messages + extras)
const totalExtras = Math.floor(TOTAL_MESSAGES / EXTRA_BLOCK_EVERY)
const expectedBlocks = TOTAL_MESSAGES + totalExtras
if (blockDataList.length !== expectedBlocks) {
  parityErrors.push(`Block fixture: expected ${expectedBlocks}, got ${blockDataList.length}`)
}

if (parityErrors.length > 0) {
  cleanup()
  throw new Error(`Benchmark aborted — correctness parity failed BEFORE timing:\n${parityErrors.join('\n')}`)
}

console.log(`Parity: ${TOPIC_COUNT} topics, ${TOTAL_MESSAGES} messages, ${blockDataList.length} blocks verified`)

// ---------------------------------------------------------------------------
// Benchmark 1: Message-load p50/p95
// ---------------------------------------------------------------------------
// Measures the production read path: listByTopic + listByMessages per topic.
// This mirrors ChatDbAggregateService.fetchMessages() but at the repository
// level without wire serialization overhead.

const LOAD_WARMUP_ROUNDS = 5
const LOAD_MEASURE_ROUNDS = 20
const loadTimings: number[] = []

// Warmup
for (let i = 0; i < LOAD_WARMUP_ROUNDS; i++) {
  for (let t = 0; t < TOPIC_COUNT; t++) {
    const tid = topicIdOf(t)
    const msgs = messagesRepo.listByTopic(tid)
    blocksRepo.listByMessages(msgs.map((m) => m.id))
  }
}

// Measure
for (let round = 0; round < LOAD_MEASURE_ROUNDS; round++) {
  const roundStart = performance.now()
  for (let t = 0; t < TOPIC_COUNT; t++) {
    const tid = topicIdOf(t)
    const msgs = messagesRepo.listByTopic(tid)
    blocksRepo.listByMessages(msgs.map((m) => m.id))
  }
  loadTimings.push(performance.now() - roundStart)
}

const loadSorted = sortTimings(loadTimings)
const loadP50 = percentile(loadSorted, 50)
const loadP95 = percentile(loadSorted, 95)
const loadP99 = percentile(loadSorted, 99)
const loadMean = mean(loadSorted)
const loadMin = loadSorted[0]
const loadMax = loadSorted[loadSorted.length - 1]

console.log(
  `\n=== Message Load p50/p95 (per-round: all ${TOPIC_COUNT} topics × ${MESSAGES_PER_TOPIC} msgs) ===\n` +
    `  p50:  ${loadP50.toFixed(2)}ms\n` +
    `  p95:  ${loadP95.toFixed(2)}ms\n` +
    `  p99:  ${loadP99.toFixed(2)}ms\n` +
    `  mean: ${loadMean.toFixed(2)}ms\n` +
    `  min:  ${loadMin.toFixed(2)}ms\n` +
    `  max:  ${loadMax.toFixed(2)}ms\n` +
    `  samples: ${loadTimings.length} rounds × ${TOPIC_COUNT} topics`
)

// ---------------------------------------------------------------------------
// Benchmark 2: Write throughput
// ---------------------------------------------------------------------------
// Measures two sequential repository createMany calls: messages then blocks.
// Each operation creates 10 messages + their blocks via two separate
// repository transactions (messagesRepo.createMany + blocksRepo.createMany).
// NOT a single aggregate transaction — see LOCK-5.4.3 label below.

const WRITE_BATCH_SIZE = 10
const WRITE_WARMUP_OPS = 5
const WRITE_MEASURE_OPS = 50
const writeTimings: number[] = []

// Determine start IDs for write benchmark (avoid collision with corpus)
const writeBaseId = TOTAL_MESSAGES + 1000 // offset from corpus
const writeTopicId = topicIdOf(0) // write into first topic (has capacity)

// Warmup
for (let i = 0; i < WRITE_WARMUP_OPS; i++) {
  const startG = writeBaseId + i * WRITE_BATCH_SIZE
  const batch: MessageData[] = []
  for (let j = 0; j < WRITE_BATCH_SIZE; j++) {
    const g = startG + j
    batch.push({
      id: `wbench-msg-${pad(g, 5)}`,
      topicId: writeTopicId,
      role: 'user',
      content: null,
      status: 'success',
      askId: null,
      model: null,
      modelId: null,
      assistantId: 'bench-asst',
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      sortOrder: MESSAGES_PER_TOPIC + i * WRITE_BATCH_SIZE + j,
      overflow: {}
    })
  }
  messagesRepo.createMany(batch)
}

// Measure
for (let op = 0; op < WRITE_MEASURE_OPS; op++) {
  const startG = writeBaseId + WRITE_WARMUP_OPS * WRITE_BATCH_SIZE + op * WRITE_BATCH_SIZE
  const batch: MessageData[] = []
  const blockBatch: MessageBlockData[] = []
  for (let j = 0; j < WRITE_BATCH_SIZE; j++) {
    const g = startG + j
    const msgId = `wbench-msg-${pad(g, 5)}`
    batch.push({
      id: msgId,
      topicId: writeTopicId,
      role: 'user',
      content: null,
      status: 'success',
      askId: null,
      model: null,
      modelId: null,
      assistantId: 'bench-asst',
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      sortOrder: MESSAGES_PER_TOPIC + WRITE_WARMUP_OPS * WRITE_BATCH_SIZE + op * WRITE_BATCH_SIZE + j,
      overflow: {}
    })
    blockBatch.push({
      id: `wbench-block-${pad(g, 5)}`,
      messageId: msgId,
      type: 'main_text',
      content: `Write benchmark message ${g}`,
      status: 'success',
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      sortOrder: 0,
      overflow: {}
    })
  }

  const opStart = performance.now()
  messagesRepo.createMany(batch)
  blocksRepo.createMany(blockBatch)
  writeTimings.push(performance.now() - opStart)
}

const writeSorted = sortTimings(writeTimings)
const writeTotalMessages = WRITE_MEASURE_OPS * WRITE_BATCH_SIZE
const writeTotalOps = writeTimings.length
const writeMeanMs = mean(writeSorted)
const writeTotalElapsedMs = sum(writeTimings)
const writeOpsPerSec = opsPerSec(writeTotalOps, writeTotalElapsedMs)
const writeMsgsPerSec = opsPerSec(writeTotalMessages, writeTotalElapsedMs)

console.log(
  `\n=== Write Throughput (${WRITE_BATCH_SIZE} messages+blocks per op, two sequential repo transactions) ===\n` +
    `  LOCK-5.4.3: NOT a single aggregate transaction — labeled per LOCK-003.\n` +
    `  mean:        ${writeMeanMs.toFixed(2)}ms per op\n` +
    `  p50:         ${percentile(writeSorted, 50).toFixed(2)}ms\n` +
    `  p95:         ${percentile(writeSorted, 95).toFixed(2)}ms\n` +
    `  min:         ${writeSorted[0].toFixed(2)}ms\n` +
    `  max:         ${writeSorted[writeSorted.length - 1].toFixed(2)}ms\n` +
    `  total elapsed: ${writeTotalElapsedMs.toFixed(2)}ms (${writeTotalOps} ops)\n` +
    `  batch ops/sec: ${writeOpsPerSec.toFixed(1)}\n` +
    `  msgs/sec:      ${writeMsgsPerSec.toFixed(1)}\n` +
    `  total:         ${writeTotalMessages} messages written across ${writeTotalOps} ops`
)

// ---------------------------------------------------------------------------
// Benchmark 3: Cold DB open latency
// ---------------------------------------------------------------------------
// Measures the time to open a fresh database from scratch: create + pragmas +
// register normalize + run migrations. This mirrors ChatDbService.doInit()
// production semantics without the coordinator/repair/restore complexity.
// LOCK-5.4.3: Checks against the documented <500ms threshold for p95.

const COLD_OPEN_RUNS = 15
const coldOpenTimings: number[] = []
const coldOpenErrors: string[] = []

for (let i = 0; i < COLD_OPEN_RUNS; i++) {
  const coldDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-cold-'))
  const coldDbPath = realPath.join(coldDir, 'chat.db')
  let coldSqlite: Database.Database | null = null

  try {
    const openStart = performance.now()

    coldSqlite = new Database(coldDbPath)
    coldSqlite.pragma('journal_mode = WAL')
    coldSqlite.pragma('foreign_keys = ON')
    coldSqlite.pragma('synchronous = NORMAL')
    coldSqlite.pragma('busy_timeout = 5000')

    const coldDb = drizzle(coldSqlite, { schema })
    registerChatDbNormalize(coldSqlite)
    runMigrations(coldDb, coldSqlite)

    const openTime = performance.now() - openStart
    coldOpenTimings.push(openTime)

    // Quick sanity: verify tables exist
    const tableCount = coldSqlite.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'").get() as {
      count: number
    }
    if (tableCount.count < 6) {
      coldOpenErrors.push(`Run ${i}: expected ≥6 tables, got ${tableCount.count}`)
    }
  } catch (err) {
    coldOpenErrors.push(`Run ${i}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    // Always close handle to prevent leak (resource finding)
    try {
      coldSqlite?.close()
    } catch {
      /* already closed */
    }
    realFs.rmSync(coldDir, { recursive: true, force: true })
  }
}

// FAIL on any cold-open error — errors must not be silently omitted
if (coldOpenErrors.length > 0) {
  throw new Error(
    `Benchmark ABORTED — cold-open errors detected (${coldOpenErrors.length}):\n${coldOpenErrors.join('\n')}`
  )
}

const coldSorted = sortTimings(coldOpenTimings)
const coldP50 = percentile(coldSorted, 50)
const coldP95 = percentile(coldSorted, 95)
const coldMean = mean(coldSorted)
const coldMin = coldSorted[0]
const coldMax = coldSorted[coldSorted.length - 1]
const coldThresholdPass = coldP95 < 500

console.log(
  `\n=== Cold DB Open Latency (${COLD_OPEN_RUNS} runs, fresh each time) ===\n` +
    `  mean:      ${coldMean.toFixed(2)}ms\n` +
    `  p50:       ${coldP50.toFixed(2)}ms\n` +
    `  p95:       ${coldP95.toFixed(2)}ms\n` +
    `  min:       ${coldMin.toFixed(2)}ms\n` +
    `  max:       ${coldMax.toFixed(2)}ms\n` +
    `  threshold: <500ms (documented)\n` +
    `  result:    ${coldThresholdPass ? 'PASS' : 'FAIL'} (p95=${coldP95.toFixed(2)}ms ${coldThresholdPass ? '<' : '≥'} 500ms)`
)

// FAIL on threshold breach — not just a warning (LOCK-5.4.3)
if (!coldThresholdPass) {
  throw new Error(
    `Benchmark FAILED — LOCK-5.4.3: Cold-open p95 (${coldP95.toFixed(2)}ms) exceeds documented 500ms threshold.`
  )
}

// ---------------------------------------------------------------------------
// Vitest bench tasks — standard tinybench comparison output
// ---------------------------------------------------------------------------

describe('SQLite runtime — message load (5 topics × 200 msgs)', () => {
  afterAll(() => {
    cleanup()
  })

  bench(
    'listByTopic + listByMessages (full topic load)',
    () => {
      for (let t = 0; t < TOPIC_COUNT; t++) {
        const tid = topicIdOf(t)
        const msgs = messagesRepo.listByTopic(tid)
        blocksRepo.listByMessages(msgs.map((m) => m.id))
      }
    },
    { warmupIterations: 3, iterations: 10 }
  )

  bench(
    'listByTopic only (messages without blocks)',
    () => {
      for (let t = 0; t < TOPIC_COUNT; t++) {
        messagesRepo.listByTopic(topicIdOf(t))
      }
    },
    { warmupIterations: 3, iterations: 10 }
  )
})

describe('SQLite runtime — write throughput', () => {
  // Counter for unique IDs across bench invocations (single-threaded vitest bench)
  let benchWriteCounter = writeBaseId + WRITE_WARMUP_OPS * WRITE_BATCH_SIZE + WRITE_MEASURE_OPS * WRITE_BATCH_SIZE

  bench(
    `createMany messages (${WRITE_BATCH_SIZE} batch)`,
    () => {
      const batch: MessageData[] = []
      for (let j = 0; j < WRITE_BATCH_SIZE; j++) {
        batch.push({
          id: `bench-vit-${pad(benchWriteCounter++, 6)}`,
          topicId: writeTopicId,
          role: 'user',
          content: null,
          status: 'success',
          askId: null,
          model: null,
          modelId: null,
          assistantId: 'bench-asst',
          createdAt: BENCH_CREATED_AT,
          updatedAt: BENCH_CREATED_AT,
          sortOrder: 0,
          overflow: {}
        })
      }
      messagesRepo.createMany(batch)
    },
    { warmupIterations: 2, iterations: 5 }
  )
})
