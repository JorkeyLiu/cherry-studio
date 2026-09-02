/**
 * Focused synthetic integration coverage for M4 physical-page proxy (audit).
 *
 * Exercises real SQLite PRAGMA/stat collection and checkpoint status
 * without exposing paths/content or changing production code.
 * Isolated mkdtemp only, numeric-only, fail-closed.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import * as schema from '../schema'
import {
  assertCheckpointComplete,
  buildM4BusyCheckpointFailureMessage,
  buildM4CheckpointFailureMessage,
  buildM4PhysicalMetrics,
  buildM4StatFailureMessage,
  parseCheckpointBusy
} from './m4FtsDuplication'
import { generateCorpus } from './searchBenchHarness'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'm4-physical-proxy-'))
}

describe('M4 physical-page proxy — real SQLite PRAGMA/stat + checkpoint (synthetic isolated)', () => {
  let tempDir: string
  let dbPath: string
  let sqlite: Database.Database

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = realPath.join(tempDir, 'chat.db')
    sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('busy_timeout = 5000')
    registerChatDbNormalize(sqlite)
    runMigrations(drizzle(sqlite, { schema }), sqlite)
    // Small deterministic corpus for fast integration
    generateCorpus(sqlite, 10)
  })

  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('collects four approved raw physical metrics via real PRAGMA + stat after checkpoint', () => {
    const checkpointRaw = sqlite.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    expect(() => assertCheckpointComplete(checkpointRaw)).not.toThrow()
    expect(parseCheckpointBusy(checkpointRaw)).toBe(0)

    const pageCount = sqlite.pragma('page_count', { simple: true }) as number
    const pageSize = sqlite.pragma('page_size', { simple: true }) as number
    const freelistCount = sqlite.pragma('freelist_count', { simple: true }) as number
    const dbFileBytes = realFs.statSync(dbPath).size

    const metrics = buildM4PhysicalMetrics({ pageCount, pageSize, freelistCount, dbFileBytes })

    expect(metrics).toHaveLength(4)
    expect(metrics.map((m) => m.id)).toEqual([
      'physical.page_count',
      'physical.page_size',
      'physical.freelist_count',
      'physical.dbFileBytes'
    ])
    for (const m of metrics) {
      expect(Number.isFinite(m.value)).toBe(true)
      expect(m.value).toBeGreaterThanOrEqual(0)
      expect(m.id).not.toMatch(/[\\/]/)
    }
    // Ensure derived fields are not emitted
    const ids = metrics.map((m) => m.id)
    expect(ids).not.toContain('physical.pageBytes')
    expect(ids).not.toContain('physical.freelistBytes')
    // Numeric-only, no path leakage
    expect(JSON.stringify(metrics)).not.toContain('/tmp')
    // pageSize and dbFileBytes carry bytes unit
    expect(metrics.find((m) => m.id === 'physical.page_size')!.unit).toBe('bytes')
    expect(metrics.find((m) => m.id === 'physical.dbFileBytes')!.unit).toBe('bytes')
  })

  it('uses pragma simple:false array shape as alternative checkpoint inspection', () => {
    const altRaw = sqlite.pragma('wal_checkpoint(TRUNCATE)', { simple: false })
    expect(Array.isArray(altRaw)).toBe(true)
    expect(parseCheckpointBusy(altRaw)).toBe(0)
    expect(() => assertCheckpointComplete(altRaw)).not.toThrow()
  })

  it('fail-closed when checkpoint busy — no physical artifact construction', () => {
    expect(() => assertCheckpointComplete({ busy: 1, log: 5, checkpointed: 2 })).toThrow(/incomplete\/busy/)
    expect(() => assertCheckpointComplete([{ busy: 1, log: 5, checkpointed: 2 }])).toThrow(/incomplete\/busy/)
    expect(() => assertCheckpointComplete(1)).toThrow(/incomplete\/busy/)
  })

  it('fail-closed when checkpoint shape unverifiable — does not emit unchecked metric', () => {
    expect(() => parseCheckpointBusy(undefined)).toThrow(/unverifiable/)
    expect(() => assertCheckpointComplete(undefined)).toThrow(/unverifiable/)
    expect(() => parseCheckpointBusy({})).toThrow(/unverifiable/)
    // Caller must not proceed to stat/artifact in this case — fail closed
    let proceeded = false
    try {
      parseCheckpointBusy(null)
      proceeded = true
    } catch {
      proceeded = false
    }
    expect(proceeded).toBe(false)
  })

  it('stat after checkpoint is read-only file size (isolated synthetic DB file byte size)', () => {
    const checkpointRaw = sqlite.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    assertCheckpointComplete(checkpointRaw)
    const stat = realFs.statSync(dbPath)
    expect(Number.isFinite(stat.size)).toBe(true)
    expect(stat.size).toBeGreaterThan(0)
    // Second stat must not mutate DB (read-only after checkpoint)
    const stat2 = realFs.statSync(dbPath)
    expect(stat2.size).toBe(stat.size)
  })

  it('privacy audit — failure messages contain no path-like or dbPath text', () => {
    const fakePath = '/tmp/chatdb-m4-fts-dup-audit/chat.db'
    function assertPathFree(msg: string): void {
      // Path-like means temp dir / synthetic prefix / db filename — not generic slash
      expect(msg).not.toContain('/tmp')
      expect(msg).not.toContain('/var/folders')
      expect(msg).not.toContain('chat.db')
      expect(msg).not.toContain(fakePath)
      expect(msg).not.toContain(dbPath)
      expect(msg).not.toContain('chatdb-m4-fts-dup')
      expect(msg).not.toContain('/private')
    }

    // Checkpoint failure helpers are fixed categories, must be path-free
    assertPathFree(buildM4CheckpointFailureMessage())
    assertPathFree(buildM4StatFailureMessage())
    assertPathFree(buildM4BusyCheckpointFailureMessage(1))
    assertPathFree(buildM4BusyCheckpointFailureMessage('unverifiable'))

    // assertCheckpointComplete / parseCheckpointBusy throw path-free
    try {
      assertCheckpointComplete({ busy: 1, log: 0, checkpointed: 0 })
      throw new Error('expected throw')
    } catch (e) {
      assertPathFree((e as Error).message)
    }
    try {
      parseCheckpointBusy(undefined)
      throw new Error('expected throw')
    } catch (e) {
      assertPathFree((e as Error).message)
    }
    try {
      parseCheckpointBusy(null)
      throw new Error('expected throw')
    } catch (e) {
      assertPathFree((e as Error).message)
    }

    // Even when native error contains dbPath, sanitized helpers remain path-free
    const nativeWithPath = new Error(`stat failed: ${dbPath}: ENOENT`)
    const sanitizedCheckpoint = buildM4CheckpointFailureMessage()
    const sanitizedStat = buildM4StatFailureMessage()
    expect(sanitizedCheckpoint).not.toContain(dbPath)
    expect(sanitizedCheckpoint).not.toContain(nativeWithPath.message)
    expect(sanitizedStat).not.toContain(dbPath)
    expect(sanitizedStat).not.toContain(nativeWithPath.message)
    assertPathFree(sanitizedCheckpoint)
    assertPathFree(sanitizedStat)

    // Busy checkpoint message encodes busy but not path
    const busyMsg = buildM4BusyCheckpointFailureMessage('unverifiable')
    expect(busyMsg).not.toContain(dbPath)
    assertPathFree(busyMsg)
  })
})
