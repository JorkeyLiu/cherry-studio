/**
 * prepareRollbackSnapshot tests — real better-sqlite3, no mocks
 * (Phase 4.4.1, LOCK-4411/4412/4417).
 *
 * Covers:
 * - Success: fixed staging → full validation → atomic retained publish →
 *   existence confirmation; exactly one retained snapshot; staging cleaned.
 * - Online backup failure, staging open/integrity/FK/migration/sample-read
 *   failures: old retained preserved byte-for-byte, staging cleaned up.
 * - Replacement interruption (before rename) and real rename failure:
 *   old retained preserved, staging cleaned.
 * - Live DB handle stays open, usable, and unmodified on every outcome;
 *   live WAL/SHM sidecars are never copied; no journal file is written.
 */

import * as realFs from 'node:fs'
// Default export (mutable object) — spy target for bounded fault injection;
// the production module imports the same default object.
import nodeFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../../chatDb/migration'
import * as schema from '../../../chatDb/schema'
import { PROMOTION_JOURNAL_FILENAME, ROLLBACK_SNAPSHOT_FILENAME, ROLLBACK_SNAPSHOT_STAGING_FILENAME } from '../journal'
import type { PrepareRollbackSnapshotOptions, RollbackSnapshotResult } from '../snapshot'
import { prepareRollbackSnapshot } from '../snapshot'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const OLD_RETAINED_BYTES = Buffer.from('old-retained-snapshot-sentinel-not-a-real-db')

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-rollback-snapshot-'))
}

/** Create + migrate + seed a live chat.db in WAL mode; returns the OPEN handle. */
function makeLiveDb(dir: string): { dbPath: string; sqlite: Database.Database } {
  const dbPath = realPath.join(dir, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)
  seed(sqlite)
  return { dbPath, sqlite }
}

function seed(sqlite: Database.Database): void {
  sqlite.exec(`
    INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES
      ('t-1', 'a-1', 'Topic 1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}'),
      ('t-2', 'a-1', 'Topic 2', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}');
    INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES
      ('m-1', 't-1', 'user', 'hello', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}'),
      ('m-2', 't-1', 'assistant', 'world', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:02.000Z', '2020-01-01T00:00:02.000Z', 1, '{}'),
      ('m-3', 't-2', 'user', 'other', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:03.000Z', '2020-01-01T00:00:03.000Z', 0, '{}');
    INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES
      ('b-1', 'm-1', 'main_text', 'hi', 'success', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}'),
      ('b-2', 'm-2', 'main_text', 'there', 'success', '2020-01-01T00:00:02.000Z', '2020-01-01T00:00:02.000Z', 0, '{}');
    INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES
      ('s-1', 't-1', 'Segment 1', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 0, '{}');
    INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES
      ('s-1', 'm-1', 0),
      ('s-1', 'm-2', 1);
  `)
}

/** Open the staging snapshot writable (FKs off), mutate, close. */
function mutateStaging(stagingPath: string, fn: (db: Database.Database) => void): void {
  const db = new Database(stagingPath)
  db.pragma('foreign_keys = OFF')
  fn(db)
  db.close()
}

/**
 * Overwrite the root b-tree page of one named index with a structurally
 * VALID but EMPTY leaf-index page: PRAGMA integrity_check deterministically
 * REPORTS the rows missing from the index instead of raising SQLITE_CORRUPT.
 */
function corruptIndexToEmptyPage(dbPath: string, indexName: string): void {
  const db = new Database(dbPath, { readonly: true })
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const row = db.prepare(`SELECT rootpage FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName) as
    | { rootpage: number }
    | undefined
  db.close()
  expect(row).toBeDefined()
  const page = Buffer.alloc(pageSize, 0)
  page[0] = 0x0a // leaf index b-tree page
  page.writeUInt16BE(0, 1) // no freeblocks
  page.writeUInt16BE(0, 3) // zero cells
  page.writeUInt16BE(pageSize & 0xffff, 5) // cell content area starts at page end
  const fd = realFs.openSync(dbPath, 'r+')
  realFs.writeSync(fd, page, 0, pageSize, (row!.rootpage - 1) * pageSize)
  realFs.closeSync(fd)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('prepareRollbackSnapshot', () => {
  let tempDir: string
  let live: { dbPath: string; sqlite: Database.Database }
  let stagingPath: string
  let retainedPath: string
  let journalPath: string

  beforeEach(() => {
    tempDir = makeTempDir()
    live = makeLiveDb(tempDir)
    stagingPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_STAGING_FILENAME)
    retainedPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
    journalPath = realPath.join(tempDir, PROMOTION_JOURNAL_FILENAME)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      live.sqlite.close()
    } catch {
      // Already closed by a test.
    }
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  function run(extra?: Partial<PrepareRollbackSnapshotOptions>): Promise<RollbackSnapshotResult> {
    return prepareRollbackSnapshot({
      dbDir: tempDir,
      getLiveSqlite: () => live.sqlite,
      ...extra
    })
  }

  /** Old-retained preservation + staging cleanup + live-untouched bundle. */
  function expectPrepublishFailure(result: RollbackSnapshotResult, code: string): void {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(code)
    expect(result.oldRetainedPreserved).toBe(true)
    // Old retained is byte-for-byte untouched.
    expect(realFs.readFileSync(retainedPath).equals(OLD_RETAINED_BYTES)).toBe(true)
    // Staging (and staging sidecars) cleaned up.
    expect(realFs.existsSync(stagingPath)).toBe(false)
    expect(realFs.existsSync(`${stagingPath}-wal`)).toBe(false)
    expect(realFs.existsSync(`${stagingPath}-shm`)).toBe(false)
    expectLiveUsableAndUntouched()
    // No journal I/O in this unit (LOCK-4417).
    expect(realFs.existsSync(journalPath)).toBe(false)
  }

  /** The live handle remains open, readable, and writable (LOCK-4411). */
  function expectLiveUsableAndUntouched(expectedTopics = 2): void {
    expect(live.sqlite.open).toBe(true)
    const count = live.sqlite.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
    expect(count.c).toBe(expectedTopics)
    live.sqlite.prepare(`INSERT INTO topics (id, extra) VALUES ('t-probe-${Date.now()}-${Math.random()}', '{}')`).run()
    live.sqlite.prepare(`DELETE FROM topics WHERE id LIKE 't-probe-%'`).run()
  }

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  it('creates, validates, and publishes exactly one retained snapshot', async () => {
    const result = await run()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.retainedPath).toBe(retainedPath)
    expect(result.pagesCopied).toBeGreaterThan(0)

    // Exactly one retained artifact: staging + sidecars are gone.
    expect(realFs.statSync(retainedPath).isFile()).toBe(true)
    expect(realFs.existsSync(stagingPath)).toBe(false)
    expect(realFs.existsSync(`${retainedPath}-wal`)).toBe(false)
    expect(realFs.existsSync(`${retainedPath}-shm`)).toBe(false)

    // The retained snapshot is a self-contained, readable database.
    const snapshot = new Database(retainedPath, { readonly: true, fileMustExist: true })
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
    const topics = snapshot.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
    expect(topics.c).toBe(2)
    snapshot.close()

    // Live sidecars were never moved/deleted; live handle stays usable.
    expect(realFs.existsSync(`${live.dbPath}-wal`)).toBe(true)
    expectLiveUsableAndUntouched()
    expect(realFs.existsSync(journalPath)).toBe(false)
  })

  it('atomically replaces a previously retained snapshot only after validation', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)

    const result = await run()

    expect(result.ok).toBe(true)
    const bytes = realFs.readFileSync(retainedPath)
    expect(bytes.equals(OLD_RETAINED_BYTES)).toBe(false)
    expect(bytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000')
    expect(realFs.existsSync(stagingPath)).toBe(false)
  })

  it('succeeds for an empty (migrated, zero-row) live database', async () => {
    live.sqlite.exec(`
      DELETE FROM topic_segment_messages;
      DELETE FROM topic_segments;
      DELETE FROM message_blocks;
      DELETE FROM messages;
      DELETE FROM topics;
    `)
    const result = await run()
    expect(result.ok).toBe(true)
    const snapshot = new Database(retainedPath, { readonly: true, fileMustExist: true })
    expect((snapshot.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }).c).toBe(0)
    snapshot.close()
  })

  // -------------------------------------------------------------------------
  // Backup failure — the destructive window never opens
  // -------------------------------------------------------------------------

  it('preserves the old retained snapshot when the online backup fails', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const detached = new Database(live.dbPath)
    detached.close() // closed source handle → backup fails

    const result = await prepareRollbackSnapshot({
      dbDir: tempDir,
      getLiveSqlite: () => detached
    })

    expectPrepublishFailure(result, 'ONLINE_BACKUP_FAILED')
  })

  // -------------------------------------------------------------------------
  // Validation failures — staging discarded, old retained untouched
  // -------------------------------------------------------------------------

  it('fails with SNAPSHOT_OPEN_FAILED when staging disappears before validation', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const result = await run({
      onAfterBackup: () => realFs.unlinkSync(stagingPath)
    })
    expectPrepublishFailure(result, 'SNAPSHOT_OPEN_FAILED')
  })

  it('fails with SNAPSHOT_INTEGRITY_FAILED for a structurally damaged staging snapshot', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const result = await run({
      onAfterBackup: () => corruptIndexToEmptyPage(stagingPath, 'messages_topic_id_sort_order_idx')
    })
    expectPrepublishFailure(result, 'SNAPSHOT_INTEGRITY_FAILED')
  })

  it('fails with SNAPSHOT_FOREIGN_KEYS_FAILED for an FK-violating staging snapshot', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const result = await run({
      onAfterBackup: () =>
        mutateStaging(stagingPath, (db) => {
          db.prepare(`INSERT INTO messages (id, topic_id, sort_order) VALUES ('m-orphan', 't-missing', 0)`).run()
        })
    })
    expectPrepublishFailure(result, 'SNAPSHOT_FOREIGN_KEYS_FAILED')
  })

  it('fails with SNAPSHOT_MIGRATION_INCOMPATIBLE when a registered migration key is missing', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const result = await run({
      onAfterBackup: () =>
        mutateStaging(stagingPath, (db) => {
          db.prepare(`DELETE FROM migration_state WHERE key = '002_corrective_schema'`).run()
        })
    })
    expectPrepublishFailure(result, 'SNAPSHOT_MIGRATION_INCOMPATIBLE')
    if (!result.ok) expect(result.safeCode).toBe('MIGRATION_KEY_MISSING')
  })

  it('fails with SNAPSHOT_MIGRATION_INCOMPATIBLE for an unknown (ahead-of-schema) migration key', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const result = await run({
      onAfterBackup: () =>
        mutateStaging(stagingPath, (db) => {
          db.prepare(
            `INSERT INTO migration_state (key, value, updated_at) VALUES ('999_future', '999_future', '2020-01-01T00:00:00.000Z')`
          ).run()
        })
    })
    expectPrepublishFailure(result, 'SNAPSHOT_MIGRATION_INCOMPATIBLE')
    if (!result.ok) expect(result.safeCode).toBe('MIGRATION_KEY_UNKNOWN')
  })

  it('fails with SNAPSHOT_SAMPLE_READ_FAILED when application-layer reads break', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const result = await run({
      onAfterBackup: () =>
        mutateStaging(stagingPath, (db) => {
          db.exec('DROP TABLE topic_segment_messages')
        })
    })
    expectPrepublishFailure(result, 'SNAPSHOT_SAMPLE_READ_FAILED')
  })

  // -------------------------------------------------------------------------
  // Publish failures — replacement interruption
  // -------------------------------------------------------------------------

  it('preserves the old retained snapshot when replacement is interrupted before rename', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const result = await run({
      onBeforePublish: () => {
        throw new Error('simulated crash between validation and rename')
      }
    })
    expectPrepublishFailure(result, 'RETAINED_PUBLISH_FAILED')
  })

  it('fails with RETAINED_PUBLISH_FAILED when the atomic rename itself fails', async () => {
    // A directory at the retained path makes renameSync fail.
    realFs.mkdirSync(retainedPath)

    const result = await run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('RETAINED_PUBLISH_FAILED')
    expect(result.oldRetainedPreserved).toBe(true)
    expect(realFs.statSync(retainedPath).isDirectory()).toBe(true)
    expect(realFs.existsSync(stagingPath)).toBe(false)
    expectLiveUsableAndUntouched()
  })

  it('fails with RETAINED_DIRECTORY_SYNC_FAILED when the post-rename parent-directory fsync fails', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)

    // Bounded injection: fail ONLY the directory open used by the parent
    // fsync (fsyncDirectory opens dbDir itself); the staging-file fsync and
    // every other open pass through untouched.
    const realOpenSync = nodeFs.openSync
    const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation(((
      filePath: realFs.PathLike,
      flags: realFs.OpenMode,
      mode?: realFs.Mode | null
    ) => {
      if (filePath === tempDir) {
        const error: NodeJS.ErrnoException = new Error('EIO: injected directory fsync failure')
        error.code = 'EIO'
        throw error
      }
      return realOpenSync(filePath, flags, mode)
    }) as typeof realFs.openSync)

    const result = await run()
    openSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('RETAINED_DIRECTORY_SYNC_FAILED')
    expect(result.safeCode).toBe('EIO')
    // The rename already happened: the retained name now holds the NEW
    // validated snapshot — old-retained is NOT preserved and the caller
    // must not treat the result as durably committed.
    expect(result.oldRetainedPreserved).toBe(false)
    const bytes = realFs.readFileSync(retainedPath)
    expect(bytes.equals(OLD_RETAINED_BYTES)).toBe(false)
    expect(bytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000')
    // Staging was consumed by the rename; no staging artifacts remain.
    expect(realFs.existsSync(stagingPath)).toBe(false)
    // Live DB untouched and usable; no journal was written (LOCK-4417):
    // an unconfirmed-durability rename can never be journaled.
    expectLiveUsableAndUntouched()
    expect(realFs.existsSync(journalPath)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Required ordering evidence
  // -------------------------------------------------------------------------

  it('runs backup → validation → publish in exact order and never publishes unvalidated bytes', async () => {
    realFs.writeFileSync(retainedPath, OLD_RETAINED_BYTES)
    const order: string[] = []

    const result = await run({
      onAfterBackup: () => {
        order.push('after-backup')
        // Staging exists at the fixed name while the OLD retained is intact.
        expect(realFs.existsSync(stagingPath)).toBe(true)
        expect(realFs.readFileSync(retainedPath).equals(OLD_RETAINED_BYTES)).toBe(true)
      },
      onBeforePublish: () => {
        order.push('before-publish')
        // Validation has completed, but the OLD retained is STILL intact.
        expect(realFs.readFileSync(retainedPath).equals(OLD_RETAINED_BYTES)).toBe(true)
      }
    })

    expect(order).toEqual(['after-backup', 'before-publish'])
    expect(result.ok).toBe(true)
    // Only now the retained name holds the validated snapshot.
    expect(realFs.readFileSync(retainedPath).subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000')
  })

  it('keeps a stale staging leftover from being trusted: it is discarded before backup', async () => {
    realFs.writeFileSync(stagingPath, Buffer.from('stale-staging-garbage'))

    const result = await run()

    expect(result.ok).toBe(true)
    // Success proves the garbage staging was replaced by a fresh online
    // backup (garbage bytes can never pass validation).
    expect(realFs.existsSync(stagingPath)).toBe(false)
  })
})
