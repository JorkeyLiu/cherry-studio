/**
 * M5 File Dual-State Consistency — synthetic measurement-only diagnostic.
 *
 * Default-inert: the file registers one skipped task and performs no setup
 * unless M5_FILE_DUAL_BENCH=1. Enabled runs use an owned mkdtemp SQLite
 * database, schema-v1 migrations, synthetic file-reference rows, and an
 * explicit synthetic renderer catalog/physical-presence model. No user data,
 * real profile, ZIP, Dexie, Files directory, path, content, credential, or
 * observed database size is read or emitted. Results are directional L3 only.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterAll, bench, describe, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { registerChatDbNormalize, runMigrations } from '../migration'
import { FileReferencesRepository } from '../repository/FileReferencesRepository'
import * as schema from '../schema'
import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasksAndGates
} from './benchResult'
import {
  assertM5FiniteMetrics,
  assertM5PrivacyInvariants,
  buildM5FileDualStateGates,
  buildM5FileDualStateMetrics,
  buildM5Scenarios,
  calculateM5ScenarioParitySet,
  M5_FILE_DUAL_BENCH_ENV,
  M5_FILE_DUAL_BENCH_NAME,
  M5_FILE_DUAL_COMMAND,
  M5_FILE_DUAL_PROFILES,
  M5_FILE_DUAL_SCALE_ENV,
  m5ScaleMetadata,
  resolveM5FileDualGate,
  resolveM5FileDualScale
} from './m5FileDualState'

const enabled = resolveM5FileDualGate(process.env[M5_FILE_DUAL_BENCH_ENV])

if (!enabled) {
  describe('M5 file dual-state consistency diagnostic (on-demand)', () => {
    bench.skip('M5 file dual-state skipped — enable via pnpm bench:m5-file-dual-state (M5_FILE_DUAL_BENCH=1)', () => {})
  })
} else {
  const profileKey = resolveM5FileDualScale(process.env[M5_FILE_DUAL_SCALE_ENV])
  const profile = M5_FILE_DUAL_PROFILES[profileKey]
  const tempRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m5-file-dual-'))
  let sqlite: Database.Database | undefined
  let cleanedUp = false
  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    try {
      sqlite?.close()
    } catch {
      // The database may already be closed after setup or benchmark failure.
    }
    realFs.rmSync(tempRoot, { recursive: true, force: true })
  }
  try {
    process.once('exit', cleanup)
    const dbPath = realPath.join(tempRoot, 'synthetic-chat.db')
    sqlite = new Database(dbPath)
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('busy_timeout = 5000')
    registerChatDbNormalize(sqlite)
    runMigrations(drizzle(sqlite, { schema }), sqlite)

    const insertTopic = sqlite.prepare('INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)')
    const insertMessage = sqlite.prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insertBlock = sqlite.prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES (?, ?, ?, ?, ?)'
    )
    const fileRefs = new FileReferencesRepository(drizzle(sqlite, { schema }))
    const syntheticMessageIds: string[] = []
    const timestamp = '2026-01-01T00:00:00.000Z'
    const seed = sqlite.transaction(() => {
      insertTopic.run('m5-topic', 'synthetic', timestamp)
      for (let index = 0; index < profile.references; index++) {
        const messageId = `m5-message-${index}`
        const blockId = `m5-block-${index}`
        syntheticMessageIds.push(messageId)
        insertMessage.run(messageId, 'm5-topic', 'user', 'synthetic', 'success', timestamp, index)
        insertBlock.run(blockId, messageId, 'main_text', 'synthetic', 0)
        fileRefs.create({
          id: `m5-reference-${index}`,
          blockId,
          fileId: `m5-file-${index}`,
          fileName: null,
          filePath: null,
          fileType: null,
          count: 1,
          overflow: {}
        })
      }
    })
    seed()

    const referenceCount = fileRefs.listByMessages(syntheticMessageIds).length
    const scenarios = calculateM5ScenarioParitySet(buildM5Scenarios({ ...profile, references: referenceCount }))
    const metrics = buildM5FileDualStateMetrics(scenarios, referenceCount)
    assertM5FiniteMetrics(metrics)
    assertM5PrivacyInvariants(metrics)
    const gates = buildM5FileDualStateGates({
      scenarios,
      expectedScenarioCount: 4,
      expectedReferenceCount: profile.references,
      observedReferenceCount: referenceCount,
      metrics
    })
    if (gates.some((gate) => !gate.passed)) {
      cleanup()
      throw new Error(
        `M5 benchmark aborted before artifact: ${gates
          .filter((gate) => !gate.passed)
          .map((gate) => gate.id)
          .join(', ')}`
      )
    }

    const result: BenchmarkResult = {
      schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
      benchmark: {
        id: 'chatdb-m5-file-dual-state',
        name: M5_FILE_DUAL_BENCH_NAME,
        scale: m5ScaleMetadata(profile)
      },
      environment: collectEnvironmentMetadata({ command: M5_FILE_DUAL_COMMAND }),
      metrics,
      gates
    }

    describe(`M5 file dual-state consistency — ${profileKey}`, () => {
      bench(
        'read-only synthetic reference/catalog/physical parity probe',
        () => {
          if (sqlite === undefined) throw new Error('M5 benchmark database is unavailable')
          const count = (sqlite.prepare('SELECT COUNT(*) AS count FROM file_references').get() as { count: number })
            .count
          const repeatedScenarios = calculateM5ScenarioParitySet(buildM5Scenarios({ ...profile, references: count }))
          const repeatedMetrics = buildM5FileDualStateMetrics(repeatedScenarios, count)
          assertM5FiniteMetrics(repeatedMetrics)
        },
        { warmupIterations: 1, iterations: 2 }
      )
    })

    afterAll((suite) => {
      try {
        const artifactPath = emitBenchmarkResultAfterSuccessfulTasksAndGates(suite, result)
        if (artifactPath !== null) process.stdout.write(`Result artifact: ${artifactPath}\n`)
      } finally {
        cleanup()
      }
    })
  } catch (error) {
    cleanup()
    throw error
  }
}
