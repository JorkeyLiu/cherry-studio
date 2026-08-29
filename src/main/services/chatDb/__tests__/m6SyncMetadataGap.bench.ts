/**
 * M6 sync metadata gap fingerprint — synthetic measurement-only diagnostic.
 *
 * Default-inert: without M6_SYNC_GAP_BENCH=1 this file registers one skipped
 * task and performs no database setup. The opt-in path opens only an owned
 * temporary SQLite database, applies the existing schema-v1 migrations, and
 * performs read-only schema introspection. It never opens production chat.db,
 * reads user data, changes migrations, or emits a sync design.
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
import * as schema from '../schema'
import {
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasksAndGates
} from './benchResult'
import {
  assembleM6SyncMetadataGapResult,
  M6_EXCLUDED_TABLES,
  M6_REQUIRED_TABLES,
  M6_SYNC_GAP_BENCH_ENV,
  M6_SYNC_GAP_COMMAND,
  M6_SYNC_GAP_PROFILES,
  M6_SYNC_GAP_SCALE_ENV,
  observeM6SyntheticSchema,
  resolveM6SyncGapGate,
  resolveM6SyncGapScale
} from './m6SyncMetadataGap'

const enabled = resolveM6SyncGapGate(process.env[M6_SYNC_GAP_BENCH_ENV])

if (!enabled) {
  describe('M6 sync metadata gap fingerprint diagnostic (on-demand)', () => {
    bench.skip('M6 sync metadata gap skipped — enable with M6_SYNC_GAP_BENCH=1', () => {})
  })
} else {
  const profileKey = resolveM6SyncGapScale(process.env[M6_SYNC_GAP_SCALE_ENV])
  const profile = M6_SYNC_GAP_PROFILES[profileKey]
  const tempRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m6-sync-gap-'))
  let sqlite: Database.Database | undefined
  let cleanedUp = false

  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    try {
      sqlite?.close()
    } catch {
      // The database may already be closed after a failed setup.
    }
    realFs.rmSync(tempRoot, { recursive: true, force: true })
  }

  try {
    process.once('exit', cleanup)
    sqlite = new Database(realPath.join(tempRoot, 'synthetic-chat.db'))
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('busy_timeout = 5000')
    registerChatDbNormalize(sqlite)
    runMigrations(drizzle(sqlite, { schema }), sqlite)

    const observation = observeM6SyntheticSchema(sqlite, profile)
    const result: BenchmarkResult = assembleM6SyncMetadataGapResult({
      profile,
      observation,
      environment: collectEnvironmentMetadata({ command: M6_SYNC_GAP_COMMAND })
    })
    const failingGates = result.gates.filter((gate) => !gate.passed)
    if (failingGates.length > 0) {
      cleanup()
      throw new Error(`M6 benchmark aborted before artifact: ${failingGates.map((gate) => gate.id).join(', ')}`)
    }

    describe('M6 sync metadata gap fingerprint — isolated schema-v1 introspection', () => {
      bench(
        'read-only synthetic schema metadata probe',
        () => {
          if (sqlite === undefined) throw new Error('M6 benchmark database is unavailable')
          sqlite
            .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .get()
          for (const tableName of M6_REQUIRED_TABLES) {
            sqlite.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all()
          }
          for (const tableName of M6_EXCLUDED_TABLES) {
            sqlite.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all()
          }
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
