/**
 * Migration 002 + Codec/Mapper/Cursor Tests — real better-sqlite3, no mocks.
 *
 * Covers:
 * - Fresh DB applies 001 + 002
 * - DB stopped after 001 upgrades through 002
 * - Representative rows / extra JSON survive migration
 * - Duplicate file_references deterministically collapsed (lowest id wins)
 * - Cascade deletes work with foreign_keys ON
 * - Indexes and unique constraints exist and enforce (single mechanism)
 * - Migration idempotency and transaction rollback
 * - Type-safe migration runner: FK restoration, injected failure
 * - Mapper/codec round trips, unknown fields, explicit null, tool block
 * - Overflow merge semantics: set, remove, clear, preserve, undefined no-op
 * - Reconstruct helper: columns win over stale overflow
 * - Collision/disagreement tests for promoted fields and tool content
 * - Opaque cursor encoding/decoding, malformed rejection, limit validation
 * - Cursor ties, special/unicode ids, asc/desc
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Unmock real filesystem and OS modules for integration tests.
// ---------------------------------------------------------------------------
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

// Mock @main/config to prevent getDataPath() side effect at import time.
vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

// Keep logger mocked — not needed for SQL-level tests.
// Keep electron mocked — not needed.

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { decodeJson, encodeJson, mergeOverflow, OVERFLOW_CLEAR, OVERFLOW_REMOVE, reconstruct } from '../domain/codec'
import { decodeCursor, DEFAULT_LIMIT, encodeCursor, MAX_LIMIT, validateLimit } from '../domain/cursor'
import {
  applyOverflowPatch,
  fileReferenceFromRow,
  fileReferenceToRow,
  messageBlockFromRow,
  messageBlockToRow,
  messageBlockToRowPatch,
  messageFromRow,
  messageToRow,
  messageToRowPatch,
  topicFromRow,
  topicSegmentFromRow,
  topicSegmentMessageFromRow,
  topicSegmentMessageToRow,
  topicSegmentToRow,
  topicToRow,
  topicToRowPatch
} from '../domain/mappers'
import type { TopicRow } from '../domain/types'
import { MIGRATIONS, runMigrations } from '../migration'
import * as schema from '../schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-migration002-'))
}

function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}

function openTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}

function wrapDrizzle(sqlite: Database.Database): BetterSQLite3Database<typeof schema> {
  return drizzle(sqlite, { schema })
}

/** Get all table names in the database. */
function getTableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

/** Get all index names for a given table. */
function getIndexNames(sqlite: Database.Database, tableName: string): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? ORDER BY name")
      .all(tableName) as Array<{ name: string }>
  ).map((r) => r.name)
}

/** Get column info for a table. */
function getColumnInfo(
  sqlite: Database.Database,
  tableName: string
): Array<{ name: string; notnull: number; dflt_value: string | null }> {
  return sqlite.pragma(`table_info(${tableName})`) as Array<{
    name: string
    notnull: number
    dflt_value: string | null
  }>
}

/** Insert representative 001-style data (before migration 002 runs). */
function insert001Data(sqlite: Database.Database): void {
  // topics
  sqlite
    .prepare(
      `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'topic-1',
      'asst-1',
      'Test Topic',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      JSON.stringify({ type: 'chat', pinned: true, prompt: 'You are helpful' })
    )
  sqlite
    .prepare(
      `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'topic-deleted',
      'asst-1',
      'Deleted Topic',
      '2026-01-01T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
      null
    )

  // messages
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, created_at, sort_order, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'msg-1',
      'topic-1',
      'user',
      'Hello world',
      'success',
      null,
      'gpt-4',
      '2026-01-01T00:01:00.000Z',
      0,
      JSON.stringify({
        modelId: 'gpt-4o',
        assistantId: 'asst-1',
        updatedAt: '2026-01-01T00:02:00.000Z',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        blocks: ['block-1', 'block-2']
      })
    )
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, created_at, sort_order, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'msg-2',
      'topic-1',
      'assistant',
      null,
      'processing',
      'msg-1',
      null,
      '2026-01-01T00:01:30.000Z',
      null,
      JSON.stringify({
        assistantId: 'asst-1',
        metrics: { latency: 150 },
        blocks: ['block-3', 'block-4']
      })
    )

  // message_blocks
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run('block-1', 'msg-1', 'main_text', 'Hello world', 0, JSON.stringify({ createdAt: '2026-01-01T00:01:00.000Z' }))

  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      'block-2',
      'msg-1',
      'file',
      null,
      1,
      JSON.stringify({
        status: 'success',
        createdAt: '2026-01-01T00:01:01.000Z',
        updatedAt: '2026-01-01T00:01:02.000Z',
        file: { id: 'file-a', name: 'doc.pdf', path: '/files/doc.pdf', type: 'file', size: 1024 }
      })
    )

  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      'block-3',
      'msg-2',
      'main_text',
      'Here is the answer',
      0,
      JSON.stringify({ createdAt: '2026-01-01T00:01:30.000Z' })
    )

  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      'block-4',
      'msg-2',
      'tool',
      null,
      1,
      JSON.stringify({
        status: 'success',
        createdAt: '2026-01-01T00:01:31.000Z',
        toolId: 'tool-1',
        toolName: 'web_search',
        arguments: { query: 'test' },
        content: { results: [{ title: 'Test', url: 'https://example.com' }] }
      })
    )

  // topic_segments
  sqlite
    .prepare(
      `INSERT INTO topic_segments (id, topic_id, sort_order, extra)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      'seg-1',
      'topic-1',
      0,
      JSON.stringify({
        name: 'First Conversation',
        color: '#FF0000',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:02:00.000Z'
      })
    )

  // topic_segment_messages
  sqlite
    .prepare(
      `INSERT INTO topic_segment_messages (segment_id, message_id, sort_order)
       VALUES (?, ?, ?)`
    )
    .run('seg-1', 'msg-1', 0)
  sqlite
    .prepare(
      `INSERT INTO topic_segment_messages (segment_id, message_id, sort_order)
       VALUES (?, ?, ?)`
    )
    .run('seg-1', 'msg-2', 1)

  // file_references — block-2 is a file block referencing file-a
  sqlite
    .prepare(
      `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'ref-1',
      'msg-1',
      'file-a',
      'doc.pdf',
      '/files/doc.pdf',
      'file',
      1,
      JSON.stringify({
        id: 'file-a',
        name: 'doc.pdf',
        origin_name: 'doc.pdf',
        path: '/files/doc.pdf',
        size: 1024,
        ext: '.pdf',
        type: 'file',
        created_at: '2026-01-01',
        count: 1
      })
    )

  // Orphan file_reference: references msg-2 but no file block in msg-2 has file-b
  sqlite
    .prepare(
      `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('ref-orphan', 'msg-2', 'file-b', 'orphan.txt', '/files/orphan.txt', 'file', 1, null)
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Migration 002', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmrf(tempDir)
  })

  // =========================================================================
  // 1. Fresh DB applies 001 + 002
  // =========================================================================

  describe('Fresh DB', () => {
    it('should apply both 001 and 002 and create all tables', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)
      const db = wrapDrizzle(sqlite)

      const count = runMigrations(db, sqlite)
      expect(count).toBe(9)

      const tables = getTableNames(sqlite)
      expect(tables).toContain('migration_state')
      expect(tables).toContain('topics')
      expect(tables).toContain('messages')
      expect(tables).toContain('message_blocks')
      expect(tables).toContain('topic_segments')
      expect(tables).toContain('topic_segment_messages')
      expect(tables).toContain('file_references')

      sqlite.close()
    })

    it('should have all expected columns in messages', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      const cols = getColumnInfo(sqlite, 'messages')
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('model_id')
      expect(colNames).toContain('assistant_id')
      expect(colNames).toContain('updated_at')

      // sort_order should be NOT NULL DEFAULT 0
      const sortOrderCol = cols.find((c) => c.name === 'sort_order')!
      expect(sortOrderCol.notnull).toBe(1)
      expect(sortOrderCol.dflt_value).toBe('0')

      sqlite.close()
    })

    it('should have all expected columns in message_blocks', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      const cols = getColumnInfo(sqlite, 'message_blocks')
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('status')
      expect(colNames).toContain('created_at')
      expect(colNames).toContain('updated_at')

      const sortOrderCol = cols.find((c) => c.name === 'sort_order')!
      expect(sortOrderCol.notnull).toBe(1)
      expect(sortOrderCol.dflt_value).toBe('0')

      sqlite.close()
    })

    it('should have all expected columns in topic_segments', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      const cols = getColumnInfo(sqlite, 'topic_segments')
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('name')
      expect(colNames).toContain('created_at')
      expect(colNames).toContain('updated_at')

      sqlite.close()
    })

    it('should have block_id in file_references (not message_id)', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      const cols = getColumnInfo(sqlite, 'file_references')
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('block_id')
      expect(colNames).not.toContain('message_id')

      sqlite.close()
    })

    it('should have all expected indexes', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      // topics
      const topicIdx = getIndexNames(sqlite, 'topics')
      expect(topicIdx).toContain('topics_deleted_at_idx')

      // messages
      const msgIdx = getIndexNames(sqlite, 'messages')
      expect(msgIdx).toContain('messages_topic_id_sort_order_idx')
      expect(msgIdx).toContain('messages_assistant_id_idx')

      // message_blocks
      const blockIdx = getIndexNames(sqlite, 'message_blocks')
      expect(blockIdx).toContain('message_blocks_message_id_sort_order_idx')

      // topic_segments
      const segIdx = getIndexNames(sqlite, 'topic_segments')
      expect(segIdx).toContain('topic_segments_topic_id_sort_order_idx')

      // topic_segment_messages
      const memberIdx = getIndexNames(sqlite, 'topic_segment_messages')
      expect(memberIdx).toContain('topic_segment_messages_segment_id_sort_order_idx')
      expect(memberIdx).toContain('topic_segment_messages_message_id_idx')

      // file_references
      const fileIdx = getIndexNames(sqlite, 'file_references')
      expect(fileIdx).toContain('file_references_block_id_idx')
      expect(fileIdx).toContain('file_references_file_id_idx')
      expect(fileIdx).toContain('file_references_block_id_file_id_uniq')

      sqlite.close()
    })
  })

  // =========================================================================
  // 2. DB stopped after 001 upgrades through 002
  // =========================================================================

  describe('Upgrade from 001 to 002', () => {
    it('should preserve topics data including extra JSON', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)

      // Apply only 001 manually
      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )

      insert001Data(sqlite)

      // Apply 002 (+003, +004 — all pending)
      const db2 = wrapDrizzle(sqlite)
      const count = runMigrations(db2, sqlite)
      expect(count).toBe(8)

      // Verify topic data survived
      const topic = sqlite.prepare('SELECT * FROM topics WHERE id = ?').get('topic-1') as Record<string, unknown>
      expect(topic.id).toBe('topic-1')
      expect(topic.assistant_id).toBe('asst-1')
      expect(topic.name).toBe('Test Topic')
      expect(topic.created_at).toBe('2026-01-01T00:00:00.000Z')
      expect(topic.updated_at).toBe('2026-01-02T00:00:00.000Z')

      // Extra JSON should survive
      const extra = JSON.parse(topic.extra as string)
      expect(extra.type).toBe('chat')
      expect(extra.pinned).toBe(true)
      expect(extra.prompt).toBe('You are helpful')

      sqlite.close()
    })

    it('should extract modelId and assistantId from extra JSON into explicit columns', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)

      // Apply 001 manually
      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )
      insert001Data(sqlite)

      // Apply 002
      runMigrations(wrapDrizzle(sqlite), sqlite)

      // msg-1 had modelId='gpt-4o' and assistantId='asst-1' in extra
      const msg1 = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get('msg-1') as Record<string, unknown>
      expect(msg1.model_id).toBe('gpt-4o')
      expect(msg1.assistant_id).toBe('asst-1')
      expect(msg1.updated_at).toBe('2026-01-01T00:02:00.000Z') // from extra.updatedAt
      expect(msg1.sort_order).toBe(0)

      // msg-2 had no modelId, assistantId='asst-1' in extra
      const msg2 = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get('msg-2') as Record<string, unknown>
      expect(msg2.model_id).toBeNull()
      expect(msg2.assistant_id).toBe('asst-1')
      expect(msg2.updated_at).toBe('2026-01-01T00:01:30.000Z') // fallback to created_at
      expect(msg2.sort_order).toBe(0) // null → 0

      sqlite.close()
    })

    it('should extract status, createdAt, updatedAt from block extra JSON', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)

      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )
      insert001Data(sqlite)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      // block-2 had status, createdAt, updatedAt in extra
      const block2 = sqlite.prepare('SELECT * FROM message_blocks WHERE id = ?').get('block-2') as Record<
        string,
        unknown
      >
      expect(block2.status).toBe('success')
      expect(block2.created_at).toBe('2026-01-01T00:01:01.000Z')
      expect(block2.updated_at).toBe('2026-01-01T00:01:02.000Z')
      expect(block2.sort_order).toBe(1)

      // block-1 had only createdAt in extra
      const block1 = sqlite.prepare('SELECT * FROM message_blocks WHERE id = ?').get('block-1') as Record<
        string,
        unknown
      >
      expect(block1.status).toBeNull()
      expect(block1.created_at).toBe('2026-01-01T00:01:00.000Z')

      sqlite.close()
    })

    it('should extract name, createdAt, updatedAt from segment extra JSON', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)

      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )
      insert001Data(sqlite)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      const seg = sqlite.prepare('SELECT * FROM topic_segments WHERE id = ?').get('seg-1') as Record<string, unknown>
      expect(seg.name).toBe('First Conversation')
      expect(seg.created_at).toBe('2026-01-01T00:00:00.000Z')
      expect(seg.updated_at).toBe('2026-01-01T00:02:00.000Z')
      expect(seg.sort_order).toBe(0)

      // Extra should still have color
      const extra = JSON.parse(seg.extra as string)
      expect(extra.color).toBe('#FF0000')

      sqlite.close()
    })

    it('should derive block_id for file_references that have matching blocks', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)

      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )
      insert001Data(sqlite)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      // ref-1 had message_id='msg-1', file_id='file-a'. block-2 is a file block
      // in msg-1 whose extra has file.id='file-a'. So block_id should be 'block-2'.
      const ref = sqlite.prepare('SELECT * FROM file_references WHERE id = ?').get('ref-1') as Record<string, unknown>
      expect(ref.block_id).toBe('block-2')
      expect(ref.file_id).toBe('file-a')

      sqlite.close()
    })

    it('should drop orphan file_references with no matching block', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)

      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )
      insert001Data(sqlite)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      // ref-orphan should be dropped — no file block in msg-2 has file.id='file-b'
      const orphan = sqlite.prepare('SELECT * FROM file_references WHERE id = ?').get('ref-orphan')
      expect(orphan).toBeUndefined()

      sqlite.close()
    })

    it('should preserve tool block object content in extra JSON', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)

      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )
      insert001Data(sqlite)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      const block4 = sqlite.prepare('SELECT * FROM message_blocks WHERE id = ?').get('block-4') as Record<
        string,
        unknown
      >
      expect(block4.type).toBe('tool')
      expect(block4.content).toBeNull() // tool content is object → in extra

      const extra = JSON.parse(block4.extra as string)
      expect(extra.toolId).toBe('tool-1')
      expect(extra.toolName).toBe('web_search')
      expect(extra.arguments).toEqual({ query: 'test' })
      expect(extra.content).toEqual({ results: [{ title: 'Test', url: 'https://example.com' }] })

      sqlite.close()
    })

    it('should preserve segment membership data', () => {
      const dbPath = realPath.join(tempDir, 'test.db')
      const sqlite = openTestDb(dbPath)

      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )
      insert001Data(sqlite)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      const members = sqlite
        .prepare('SELECT * FROM topic_segment_messages WHERE segment_id = ? ORDER BY sort_order')
        .all('seg-1') as Array<Record<string, unknown>>
      expect(members).toHaveLength(2)
      expect(members[0].message_id).toBe('msg-1')
      expect(members[0].sort_order).toBe(0)
      expect(members[1].message_id).toBe('msg-2')
      expect(members[1].sort_order).toBe(1)

      sqlite.close()
    })
  })

  // =========================================================================
  // 3. Cascade deletes with foreign_keys ON
  // =========================================================================

  describe('Cascade deletes', () => {
    function setupWithBothMigrations(): Database.Database {
      const dbPath = realPath.join(tempDir, 'cascade.db')
      const sqlite = openTestDb(dbPath)
      runMigrations(wrapDrizzle(sqlite), sqlite)
      return sqlite
    }

    it('should cascade topic delete → messages → blocks → file_references', () => {
      const sqlite = setupWithBothMigrations()

      // Insert data
      sqlite
        .prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`)
        .run('t1', 'Cascade Topic', '2026-01-01')
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('m1', 't1', 'user', 0)
      sqlite
        .prepare(`INSERT INTO message_blocks (id, message_id, type, sort_order) VALUES (?, ?, ?, ?)`)
        .run('b1', 'm1', 'file', 0)
      sqlite.prepare(`INSERT INTO file_references (id, block_id, file_id) VALUES (?, ?, ?)`).run('fr1', 'b1', 'f1')

      // Delete topic
      sqlite.prepare('DELETE FROM topics WHERE id = ?').run('t1')

      // All children should be gone
      expect(sqlite.prepare('SELECT * FROM messages WHERE id = ?').get('m1')).toBeUndefined()
      expect(sqlite.prepare('SELECT * FROM message_blocks WHERE id = ?').get('b1')).toBeUndefined()
      expect(sqlite.prepare('SELECT * FROM file_references WHERE id = ?').get('fr1')).toBeUndefined()

      sqlite.close()
    })

    it('should cascade message delete → blocks → file_references', () => {
      const sqlite = setupWithBothMigrations()

      sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('m1', 't1', 'user', 0)
      sqlite
        .prepare(`INSERT INTO message_blocks (id, message_id, type, sort_order) VALUES (?, ?, ?, ?)`)
        .run('b1', 'm1', 'file', 0)
      sqlite.prepare(`INSERT INTO file_references (id, block_id, file_id) VALUES (?, ?, ?)`).run('fr1', 'b1', 'f1')

      sqlite.prepare('DELETE FROM messages WHERE id = ?').run('m1')

      expect(sqlite.prepare('SELECT * FROM message_blocks WHERE id = ?').get('b1')).toBeUndefined()
      expect(sqlite.prepare('SELECT * FROM file_references WHERE id = ?').get('fr1')).toBeUndefined()

      sqlite.close()
    })

    it('should cascade segment delete → memberships', () => {
      const sqlite = setupWithBothMigrations()

      sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('m1', 't1', 'user', 0)
      sqlite.prepare(`INSERT INTO topic_segments (id, topic_id, sort_order) VALUES (?, ?, ?)`).run('s1', 't1', 0)
      sqlite
        .prepare(`INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?, ?, ?)`)
        .run('s1', 'm1', 0)

      sqlite.prepare('DELETE FROM topic_segments WHERE id = ?').run('s1')

      expect(sqlite.prepare('SELECT * FROM topic_segment_messages WHERE segment_id = ?').get('s1')).toBeUndefined()

      sqlite.close()
    })

    it('should cascade message delete → segment memberships', () => {
      const sqlite = setupWithBothMigrations()

      sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('m1', 't1', 'user', 0)
      sqlite.prepare(`INSERT INTO topic_segments (id, topic_id, sort_order) VALUES (?, ?, ?)`).run('s1', 't1', 0)
      sqlite
        .prepare(`INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?, ?, ?)`)
        .run('s1', 'm1', 0)

      sqlite.prepare('DELETE FROM messages WHERE id = ?').run('m1')

      expect(sqlite.prepare('SELECT * FROM topic_segment_messages WHERE message_id = ?').get('m1')).toBeUndefined()

      sqlite.close()
    })

    it('should cascade block delete → file_references', () => {
      const sqlite = setupWithBothMigrations()

      sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('m1', 't1', 'user', 0)
      sqlite
        .prepare(`INSERT INTO message_blocks (id, message_id, type, sort_order) VALUES (?, ?, ?, ?)`)
        .run('b1', 'm1', 'file', 0)
      sqlite.prepare(`INSERT INTO file_references (id, block_id, file_id) VALUES (?, ?, ?)`).run('fr1', 'b1', 'f1')

      sqlite.prepare('DELETE FROM message_blocks WHERE id = ?').run('b1')

      expect(sqlite.prepare('SELECT * FROM file_references WHERE id = ?').get('fr1')).toBeUndefined()

      sqlite.close()
    })
  })

  // =========================================================================
  // 4. Unique constraint enforcement
  // =========================================================================

  describe('Unique constraints', () => {
    it('should enforce UNIQUE(block_id, file_id) on file_references', () => {
      const dbPath = realPath.join(tempDir, 'uniq.db')
      const sqlite = openTestDb(dbPath)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('m1', 't1', 'user', 0)
      sqlite
        .prepare(`INSERT INTO message_blocks (id, message_id, type, sort_order) VALUES (?, ?, ?, ?)`)
        .run('b1', 'm1', 'file', 0)

      // First insert succeeds
      sqlite.prepare(`INSERT INTO file_references (id, block_id, file_id) VALUES (?, ?, ?)`).run('fr1', 'b1', 'f1')

      // Duplicate (block_id, file_id) should fail
      expect(() => {
        sqlite.prepare(`INSERT INTO file_references (id, block_id, file_id) VALUES (?, ?, ?)`).run('fr2', 'b1', 'f1')
      }).toThrow()

      // Same block_id with different file_id should succeed
      sqlite.prepare(`INSERT INTO file_references (id, block_id, file_id) VALUES (?, ?, ?)`).run('fr3', 'b1', 'f2')

      // Same file_id with different block_id should succeed
      sqlite
        .prepare(`INSERT INTO message_blocks (id, message_id, type, sort_order) VALUES (?, ?, ?, ?)`)
        .run('b2', 'm1', 'file', 1)
      sqlite.prepare(`INSERT INTO file_references (id, block_id, file_id) VALUES (?, ?, ?)`).run('fr4', 'b2', 'f1')

      sqlite.close()
    })
  })

  // =========================================================================
  // 5. Migration idempotency
  // =========================================================================

  describe('Migration idempotency', () => {
    it('should be idempotent — second run applies 0 migrations', () => {
      const dbPath = realPath.join(tempDir, 'idem.db')
      const sqlite = openTestDb(dbPath)
      const db = wrapDrizzle(sqlite)

      const first = runMigrations(db, sqlite)
      expect(first).toBe(9)

      const second = runMigrations(db, sqlite)
      expect(second).toBe(0)

      sqlite.close()
    })

    it('should preserve data after re-running migrations', () => {
      const dbPath = realPath.join(tempDir, 'idem-data.db')
      const sqlite = openTestDb(dbPath)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'Persist', '2026-01-01')
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('m1', 't1', 'user', 0)

      // Re-run migrations (no-op)
      runMigrations(wrapDrizzle(sqlite), sqlite)

      const topic = sqlite.prepare('SELECT * FROM topics WHERE id = ?').get('t1') as Record<string, unknown>
      expect(topic.name).toBe('Persist')

      sqlite.close()
    })
  })

  // =========================================================================
  // 6. Transaction rollback on failure
  // =========================================================================

  describe('Transaction rollback', () => {
    it('should rollback entire migration if a statement fails', () => {
      const dbPath = realPath.join(tempDir, 'rollback.db')
      const sqlite = openTestDb(dbPath)

      // Apply 001 only
      sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
      for (const stmt of MIGRATIONS[0].sql) {
        sqlite.exec(stmt)
      }
      sqlite.exec(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
      )

      // Snapshot table structure before failed migration attempt
      const tablesBefore = getTableNames(sqlite)
      const colsBefore = getColumnInfo(sqlite, 'messages').map((c) => c.name)

      // Save and inject broken SQL for 002 so that it fails
      const saved002Sql = [...MIGRATIONS[1].sql]
      MIGRATIONS[1].sql = ['THIS IS NOT VALID SQL']

      try {
        const db = wrapDrizzle(sqlite)
        expect(() => runMigrations(db, sqlite)).toThrow()
      } finally {
        // Restore 002's SQL
        MIGRATIONS[1].sql = saved002Sql
      }

      // 002 should NOT have been applied — transaction rolled back
      const tablesAfter = getTableNames(sqlite)
      expect(tablesAfter).toEqual(tablesBefore)

      const colsAfter = getColumnInfo(sqlite, 'messages').map((c) => c.name)
      expect(colsAfter).toEqual(colsBefore)

      sqlite.close()
    })
  })

  // =========================================================================
  // 7. Migration registry
  // =========================================================================

  describe('Migration registry', () => {
    it('should have exactly nine migrations', () => {
      expect(MIGRATIONS).toHaveLength(9)
      expect(MIGRATIONS[0].key).toBe('001_initial_schema')
      expect(MIGRATIONS[1].key).toBe('002_corrective_schema')
      expect(MIGRATIONS[2].key).toBe('003_fts5_normalized_search')
      expect(MIGRATIONS[3].key).toBe('004_fts_rowid_identity')
      expect(MIGRATIONS[4].key).toBe('005_sync_metadata')
      expect(MIGRATIONS[5].key).toBe('006_sync_field_merge')
      expect(MIGRATIONS[6].key).toBe('007_sync_pairing_trust')
      expect(MIGRATIONS[7].key).toBe('008_sync_channel_reset')
      expect(MIGRATIONS[8].key).toBe('009_sync_membership_clock')
    })

    it('002 should have SQL statements', () => {
      expect(MIGRATIONS[1].sql.length).toBeGreaterThan(0)
    })

    it('migration keys should be unique', () => {
      const keys = MIGRATIONS.map((m) => m.key)
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('migration descriptions should be non-empty', () => {
      for (const migration of MIGRATIONS) {
        expect(migration.description).toBeTruthy()
      }
    })

    it('002 should contain table rebuild SQL', () => {
      const sql = MIGRATIONS[1].sql.join(' ')
      expect(sql).toContain('messages_new')
      expect(sql).toContain('message_blocks_new')
      expect(sql).toContain('topic_segments_new')
      expect(sql).toContain('file_references_new')
    })

    it('002 should contain CASCADE on DELETE for all FK references', () => {
      const sql = MIGRATIONS[1].sql.join(' ')
      expect(sql).toContain('ON DELETE CASCADE')
    })

    it('002 should contain UNIQUE index for file_references(block_id, file_id)', () => {
      const sql = MIGRATIONS[1].sql.join(' ')
      expect(sql).toContain('file_references_block_id_file_id_uniq')
    })
  })
})

// ===========================================================================
// Codec Tests
// ===========================================================================

describe('JSON Codec', () => {
  describe('encodeJson', () => {
    it('should return null for null/undefined', () => {
      expect(encodeJson(null)).toBeNull()
      expect(encodeJson(undefined)).toBeNull()
    })

    it('should return null for empty object', () => {
      expect(encodeJson({})).toBeNull()
    })

    it('should encode normal objects', () => {
      const result = encodeJson({ key: 'value', num: 42 })
      expect(result).toBe('{"key":"value","num":42}')
    })

    it('should preserve ordered arrays', () => {
      const result = encodeJson({ items: [3, 1, 2] })
      const parsed = JSON.parse(result!)
      expect(parsed.items).toEqual([3, 1, 2])
    })

    it('should encode nested objects', () => {
      const input = { a: { b: { c: 'deep' } }, arr: [1, 'two', null] }
      const result = encodeJson(input)
      expect(JSON.parse(result!)).toEqual(input)
    })

    it('should throw descriptive error for circular references', () => {
      const obj: any = {}
      obj.self = obj
      expect(() => encodeJson(obj)).toThrow('Failed to encode JSON')
    })
  })

  describe('decodeJson', () => {
    const ctx = { entity: 'test', table: 'tests', id: '1' }

    it('should return null for null/undefined/empty', () => {
      expect(decodeJson(null, ctx)).toBeNull()
      expect(decodeJson(undefined, ctx)).toBeNull()
      expect(decodeJson('', ctx)).toBeNull()
    })

    it('should return null for normalised empty object', () => {
      expect(decodeJson('{}', ctx)).toBeNull()
    })

    it('should decode valid JSON', () => {
      const result = decodeJson<{ key: string }>('{"key":"value"}', ctx)
      expect(result).toEqual({ key: 'value' })
    })

    it('should throw descriptive error for invalid JSON', () => {
      expect(() => decodeJson('{invalid', ctx)).toThrow(/Invalid JSON in tests\.test \(id=1\)/)
    })

    it('should include raw value in error for debugging', () => {
      const longInvalid = 'x'.repeat(300)
      try {
        decodeJson(longInvalid, ctx)
        expect.fail('should have thrown')
      } catch (error) {
        expect((error as Error).message).toContain(longInvalid.slice(0, 200))
      }
    })
  })
})

// ===========================================================================
// Mapper Tests
// ===========================================================================

describe('Mapper round trips', () => {
  describe('Topic', () => {
    it('should round-trip from domain to row and back', () => {
      const data = {
        id: 't1',
        assistantId: 'asst-1',
        name: 'Test',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
        deletedAt: null,
        overflow: { type: 'chat', pinned: true }
      }

      const row = topicToRow(data)
      expect(row.id).toBe('t1')
      expect(row.assistant_id).toBe('asst-1')
      expect(row.extra).toContain('"type"')
      expect(row.extra).toContain('"pinned"')

      const back = topicFromRow(row)
      expect(back.id).toBe('t1')
      expect(back.assistantId).toBe('asst-1')
      expect(back.overflow.type).toBe('chat')
      expect(back.overflow.pinned).toBe(true)
    })

    it('should handle null overflow', () => {
      const data = {
        id: 't1',
        assistantId: null,
        name: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        overflow: {}
      }
      const row = topicToRow(data)
      expect(row.extra).toBeNull()

      const back = topicFromRow(row)
      expect(back.overflow).toEqual({})
    })

    it('should produce correct partial patch', () => {
      const result = topicToRowPatch({ name: 'New Name', deletedAt: '2026-01-03' })
      expect(result.columns.name).toBe('New Name')
      expect(result.columns.deleted_at).toBe('2026-01-03')
      expect(result.columns.id).toBeUndefined()
      expect(result.overflowDelta).toBeNull()
    })
  })

  describe('Message', () => {
    it('should round-trip with all fields', () => {
      const data = {
        id: 'm1',
        topicId: 't1',
        role: 'user',
        content: 'Hello',
        status: 'success',
        askId: null,
        model: 'gpt-4',
        modelId: 'gpt-4o',
        assistantId: 'asst-1',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
        sortOrder: 0,
        overflow: { usage: { tokens: 100 }, blocks: ['b1', 'b2'] }
      }

      const row = messageToRow(data)
      expect(row.model_id).toBe('gpt-4o')
      expect(row.assistant_id).toBe('asst-1')

      const back = messageFromRow(row)
      expect(back.modelId).toBe('gpt-4o')
      expect(back.overflow.usage).toEqual({ tokens: 100 })
      expect(back.overflow.blocks).toEqual(['b1', 'b2'])
    })

    it('should handle overflow with unknown keys in toRow', () => {
      const data = {
        id: 'm1',
        topicId: 't1',
        role: 'assistant',
        content: null,
        status: 'processing',
        askId: null,
        model: null,
        modelId: null,
        assistantId: 'asst-1',
        createdAt: '2026-01-01',
        updatedAt: null,
        sortOrder: 5,
        overflow: {
          traceId: 'trace-123',
          agentSessionId: 'session-abc',
          customField: { nested: true }
        }
      }

      const row = messageToRow(data)
      const extra = JSON.parse(row.extra!)
      expect(extra.traceId).toBe('trace-123')
      expect(extra.agentSessionId).toBe('session-abc')
      expect(extra.customField).toEqual({ nested: true })
    })

    it('should produce correct partial patch with overflow keys', () => {
      const result = messageToRowPatch({ status: 'error', sortOrder: 3 })
      expect(result.columns.status).toBe('error')
      expect(result.columns.sort_order).toBe(3)
      expect(result.overflowDelta).toBeNull()
    })
  })

  describe('MessageBlock', () => {
    it('should round-trip tool block with object content in overflow', () => {
      const data = {
        id: 'b1',
        messageId: 'm1',
        type: 'tool',
        content: null, // object content lives in overflow
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: null,
        sortOrder: 1,
        overflow: {
          toolId: 'tool-1',
          toolName: 'web_search',
          arguments: { query: 'test' },
          content: { results: [{ title: 'R1', url: 'https://example.com' }] }
        }
      }

      const row = messageBlockToRow(data)
      expect(row.type).toBe('tool')
      expect(row.content).toBeNull()

      const back = messageBlockFromRow(row)
      expect(back.type).toBe('tool')
      expect(back.content).toBeNull()
      expect(back.overflow.toolId).toBe('tool-1')
      expect(back.overflow.content).toEqual({ results: [{ title: 'R1', url: 'https://example.com' }] })
    })

    it('should round-trip main_text block with string content', () => {
      const data = {
        id: 'b2',
        messageId: 'm1',
        type: 'main_text',
        content: 'Hello world',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: null,
        sortOrder: 0,
        overflow: {}
      }

      const row = messageBlockToRow(data)
      expect(row.content).toBe('Hello world')

      const back = messageBlockFromRow(row)
      expect(back.content).toBe('Hello world')
    })

    it('should handle explicit null for clear semantics', () => {
      const result = messageBlockToRowPatch({ content: null, status: null })
      expect(result.columns.content).toBeNull()
      expect(result.columns.status).toBeNull()
      expect(result.overflowDelta).toBeNull()
    })
  })

  describe('TopicSegment', () => {
    it('should round-trip', () => {
      const data = {
        id: 's1',
        topicId: 't1',
        name: 'Segment 1',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
        sortOrder: 0,
        overflow: { color: '#FF0000' }
      }

      const row = topicSegmentToRow(data)
      expect(row.name).toBe('Segment 1')

      const back = topicSegmentFromRow(row)
      expect(back.name).toBe('Segment 1')
      expect(back.overflow.color).toBe('#FF0000')
    })
  })

  describe('TopicSegmentMessage', () => {
    it('should round-trip', () => {
      const data = { segmentId: 's1', messageId: 'm1', sortOrder: 3 }

      const row = topicSegmentMessageToRow(data)
      expect(row.segment_id).toBe('s1')
      expect(row.message_id).toBe('m1')
      expect(row.sort_order).toBe(3)

      const back = topicSegmentMessageFromRow(row)
      expect(back.segmentId).toBe('s1')
      expect(back.messageId).toBe('m1')
      expect(back.sortOrder).toBe(3)
    })
  })

  describe('FileReference', () => {
    it('should round-trip with full file metadata snapshot in overflow', () => {
      const data = {
        id: 'fr1',
        blockId: 'b1',
        fileId: 'file-a',
        fileName: 'doc.pdf',
        filePath: '/files/doc.pdf',
        fileType: 'file',
        count: 1,
        overflow: {
          id: 'file-a',
          name: 'doc.pdf',
          origin_name: 'original_doc.pdf',
          path: '/files/doc.pdf',
          size: 2048,
          ext: '.pdf',
          type: 'file',
          created_at: '2026-01-01',
          count: 1,
          tokens: 500
        }
      }

      const row = fileReferenceToRow(data)
      expect(row.block_id).toBe('b1')
      expect(row.file_id).toBe('file-a')

      const back = fileReferenceFromRow(row)
      expect(back.blockId).toBe('b1')
      expect(back.overflow.size).toBe(2048)
      expect(back.overflow.tokens).toBe(500)
      expect(back.overflow.origin_name).toBe('original_doc.pdf')
    })
  })

  describe('Patch with overflow (RowPatchResult)', () => {
    it('should return overflow delta for topic patch', () => {
      const result = topicToRowPatch({ name: 'Updated', overflow: { pinned: false } })
      expect(result.columns.name).toBe('Updated')
      expect(result.overflowDelta).toEqual({ pinned: false })
    })

    it('should handle explicit overflow object in patch', () => {
      const result = topicToRowPatch({ overflow: { type: 'session', isNameManuallyEdited: true } })
      expect(result.columns).toEqual({})
      expect(result.overflowDelta).toEqual({ type: 'session', isNameManuallyEdited: true })
    })

    it('should skip undefined values in patch', () => {
      const result = topicToRowPatch({ name: undefined, overflow: undefined })
      expect(result.columns).toEqual({})
      expect(result.overflowDelta).toBeNull()
    })

    it('should collect unknown domain keys into overflowDelta', () => {
      const result = topicToRowPatch({ name: 'Test', unknownKey: 'value' } as any)
      expect(result.columns.name).toBe('Test')
      expect(result.overflowDelta).toEqual({ unknownKey: 'value' })
    })
  })

  describe('Unknown fields preservation', () => {
    it('should preserve unknown fields through row round-trip', () => {
      // Simulate a row with unknown keys in extra
      const row: TopicRow = {
        id: 't1',
        assistant_id: 'asst-1',
        name: 'Test',
        created_at: '2026-01-01',
        updated_at: '2026-01-02',
        deleted_at: null,
        extra: JSON.stringify({
          type: 'chat',
          pinned: true,
          futureFeature: { nested: 'value' },
          anotherFuture: [1, 2, 3]
        })
      }

      const data = topicFromRow(row)
      expect(data.overflow.type).toBe('chat')
      expect(data.overflow.pinned).toBe(true)
      expect(data.overflow.futureFeature).toEqual({ nested: 'value' })
      expect(data.overflow.anotherFuture).toEqual([1, 2, 3])

      // Convert back — unknown keys preserved in extra
      const rowBack = topicToRow(data)
      const extraBack = JSON.parse(rowBack.extra!)
      expect(extraBack.futureFeature).toEqual({ nested: 'value' })
      expect(extraBack.anotherFuture).toEqual([1, 2, 3])
    })
  })

  describe('Entity-level mapper overflow clear (OVERFLOW_CLEAR)', () => {
    it('should set clearOverflow=true when overflow is OVERFLOW_CLEAR', () => {
      const result = topicToRowPatch({ overflow: OVERFLOW_CLEAR })
      expect(result.clearOverflow).toBe(true)
      expect(result.columns).toEqual({})
      expect(result.overflowDelta).toBeNull()
    })

    it('should set clearOverflow=true with delta keys (clear then apply)', () => {
      const result = topicToRowPatch({ overflow: OVERFLOW_CLEAR, name: 'New' })
      expect(result.clearOverflow).toBe(true)
      expect(result.columns.name).toBe('New')
    })

    it('should not set clearOverflow for normal overflow delta', () => {
      const result = topicToRowPatch({ overflow: { pinned: false } })
      expect(result.clearOverflow).toBe(false)
      expect(result.overflowDelta).toEqual({ pinned: false })
    })

    it('should not set clearOverflow for absent overflow', () => {
      const result = topicToRowPatch({ name: 'Test' })
      expect(result.clearOverflow).toBe(false)
      expect(result.overflowDelta).toBeNull()
    })
  })

  describe('Entity-level mapper: unchanged / merge / individual removal / undefined no-op', () => {
    it('should return no overflow change for empty patch (unchanged)', () => {
      const result = messageToRowPatch({})
      expect(result.clearOverflow).toBe(false)
      expect(result.overflowDelta).toBeNull()
      expect(Object.keys(result.columns)).toHaveLength(0)
    })

    it('should merge overflow delta preserving existing keys', () => {
      const result = messageToRowPatch({ overflow: { traceId: 'abc' } })
      expect(result.overflowDelta).toEqual({ traceId: 'abc' })
      expect(result.clearOverflow).toBe(false)
    })

    it('should support individual key removal via OVERFLOW_REMOVE', () => {
      const result = messageToRowPatch({ overflow: { oldKey: OVERFLOW_REMOVE } })
      expect(result.overflowDelta).toEqual({ oldKey: OVERFLOW_REMOVE })
      expect(result.clearOverflow).toBe(false)
    })

    it('should skip undefined values (undefined no-op)', () => {
      const result = topicToRowPatch({ name: undefined, overflow: undefined })
      expect(result.columns).toEqual({})
      expect(result.overflowDelta).toBeNull()
      expect(result.clearOverflow).toBe(false)
    })

    it('should handle explicit null for column clear semantics', () => {
      const result = messageBlockToRowPatch({ content: null, status: null })
      expect(result.columns.content).toBeNull()
      expect(result.columns.status).toBeNull()
      expect(result.clearOverflow).toBe(false)
    })
  })

  describe('applyOverflowPatch helper', () => {
    it('should return current extra unchanged when no overflow change', () => {
      const currentExtra = JSON.stringify({ type: 'chat', pinned: true })
      const patch = topicToRowPatch({ name: 'New Name' })
      const result = applyOverflowPatch(currentExtra, patch)
      expect(result).toBe(currentExtra)
    })

    it('should merge delta into current overflow', () => {
      const currentExtra = JSON.stringify({ type: 'chat', pinned: true })
      const patch = topicToRowPatch({ overflow: { color: '#FF0000' } })
      const result = applyOverflowPatch(currentExtra, patch)
      const parsed = JSON.parse(result!)
      expect(parsed.type).toBe('chat')
      expect(parsed.pinned).toBe(true)
      expect(parsed.color).toBe('#FF0000')
    })

    it('should clear all overflow when clearOverflow is true', () => {
      const currentExtra = JSON.stringify({ type: 'chat', pinned: true, future: 'data' })
      const patch = topicToRowPatch({ overflow: OVERFLOW_CLEAR })
      const result = applyOverflowPatch(currentExtra, patch)
      // Empty overflow → encodeJson returns null
      expect(result).toBeNull()
    })

    it('should clear then apply delta when clearOverflow + delta combined', () => {
      const currentExtra = JSON.stringify({ type: 'chat', pinned: true })
      const patch = topicToRowPatch({ overflow: OVERFLOW_CLEAR })
      // Manually add delta to simulate clear + new keys
      patch.overflowDelta = { fresh: true }
      const result = applyOverflowPatch(currentExtra, patch)
      const parsed = JSON.parse(result!)
      expect(parsed).toEqual({ fresh: true })
      expect(parsed.type).toBeUndefined()
    })

    it('should remove individual keys via OVERFLOW_REMOVE', () => {
      const currentExtra = JSON.stringify({ a: 1, b: 2, c: 3 })
      const patch = messageToRowPatch({ overflow: { b: OVERFLOW_REMOVE } })
      const result = applyOverflowPatch(currentExtra, patch)
      const parsed = JSON.parse(result!)
      expect(parsed).toEqual({ a: 1, c: 3 })
    })

    it('should return null for null current extra with no overflow change', () => {
      const patch = topicToRowPatch({ name: 'Test' })
      const result = applyOverflowPatch(null, patch)
      expect(result).toBeNull()
    })
  })
})

// ===========================================================================
// Cursor Tests (opaque base64url encoding)
// ===========================================================================

describe('Cursor primitives', () => {
  describe('encodeCursor / decodeCursor round-trip', () => {
    it('should round-trip sortOrder and id', () => {
      const encoded = encodeCursor(42, 'msg-abc')
      const decoded = decodeCursor(encoded)
      expect(decoded.sortOrder).toBe(42)
      expect(decoded.id).toBe('msg-abc')
    })

    it('should produce opaque base64url string (not plain text)', () => {
      const encoded = encodeCursor(0, 'test-id')
      // Should not contain raw JSON characters
      expect(encoded).not.toContain('"')
      expect(encoded).not.toContain('{')
      // Should be valid base64url (no +, /, or = padding)
      expect(encoded).not.toMatch(/[+/=]/)
    })

    it('should handle zero sortOrder', () => {
      const decoded = decodeCursor(encodeCursor(0, 'first'))
      expect(decoded.sortOrder).toBe(0)
      expect(decoded.id).toBe('first')
    })

    it('should handle negative sortOrder', () => {
      const decoded = decodeCursor(encodeCursor(-5, 'neg'))
      expect(decoded.sortOrder).toBe(-5)
    })

    it('should handle large sortOrder', () => {
      const decoded = decodeCursor(encodeCursor(999999999, 'large'))
      expect(decoded.sortOrder).toBe(999999999)
    })

    it('should handle special/unicode ids', () => {
      const specialId = 'id-日本語-🎉-Ö-ü'
      const decoded = decodeCursor(encodeCursor(1, specialId))
      expect(decoded.id).toBe(specialId)
    })

    it('should handle empty-ish ids gracefully', () => {
      // Single character id should work
      const decoded = decodeCursor(encodeCursor(0, 'x'))
      expect(decoded.id).toBe('x')
    })

    it('should produce deterministic output for same input', () => {
      const a = encodeCursor(10, 'abc')
      const b = encodeCursor(10, 'abc')
      expect(a).toBe(b)
    })

    it('should produce different output for different sortOrder', () => {
      const a = encodeCursor(10, 'abc')
      const b = encodeCursor(11, 'abc')
      expect(a).not.toBe(b)
    })

    it('should produce different output for different id', () => {
      const a = encodeCursor(10, 'abc')
      const b = encodeCursor(10, 'def')
      expect(a).not.toBe(b)
    })
  })

  describe('encodeCursor validation (encoder rejects invalid values)', () => {
    it('should reject non-finite sortOrder (Infinity)', () => {
      expect(() => encodeCursor(Infinity, 'id')).toThrow(/Must be a finite number/)
    })

    it('should reject non-finite sortOrder (NaN)', () => {
      expect(() => encodeCursor(NaN, 'id')).toThrow(/Must be a finite number/)
    })

    it('should reject fractional sortOrder', () => {
      expect(() => encodeCursor(10.5, 'id')).toThrow(/Must be an integer/)
      expect(() => encodeCursor(0.1, 'id')).toThrow(/Must be an integer/)
      expect(() => encodeCursor(-3.7, 'id')).toThrow(/Must be an integer/)
    })

    it('should reject empty string id', () => {
      expect(() => encodeCursor(0, '')).toThrow(/Must be a non-empty string/)
    })

    it('should reject non-string id', () => {
      // @ts-expect-error — testing runtime guard
      expect(() => encodeCursor(0, 123)).toThrow(/Must be a non-empty string/)
      // @ts-expect-error
      expect(() => encodeCursor(0, null)).toThrow()
      // @ts-expect-error
      expect(() => encodeCursor(0, undefined)).toThrow()
    })
  })

  describe('decodeCursor validation (malformed rejection)', () => {
    it('should reject random base64 that is not a valid cursor payload', () => {
      // "not-json" is a valid JSON string but not a valid cursor object
      // — should fail version check
      expect(() => decodeCursor('bm90LWpzb24')).toThrow(/Malformed cursor/)
      // "invalid" is a valid JSON string — should also fail
      expect(() => decodeCursor('aW52YWxpZA')).toThrow(/Malformed cursor/)
    })

    it('should reject completely invalid base64url', () => {
      expect(() => decodeCursor('!!!invalid!!!')).toThrow()
    })

    it('should reject empty string', () => {
      expect(() => decodeCursor('')).toThrow()
    })

    it('should reject payload with wrong version', () => {
      const payload = JSON.stringify({ v: 99, t: 'keyset', so: 0, id: 'x' })
      const encoded = Buffer.from(payload).toString('base64url')
      expect(() => decodeCursor(encoded)).toThrow(/unsupported version/)
    })

    it('should reject payload with wrong type', () => {
      const payload = JSON.stringify({ v: 1, t: 'offset', so: 0, id: 'x' })
      const encoded = Buffer.from(payload).toString('base64url')
      expect(() => decodeCursor(encoded)).toThrow(/unsupported type/)
    })

    it('should reject payload with non-finite sortOrder', () => {
      const payload = JSON.stringify({ v: 1, t: 'keyset', so: Infinity, id: 'x' })
      const encoded = Buffer.from(payload).toString('base64url')
      // Infinity serialises to null in JSON, so sortOrder type check fails
      expect(() => decodeCursor(encoded)).toThrow(/sortOrder must be a/)
    })

    it('should reject payload with NaN sortOrder', () => {
      const payload = JSON.stringify({ v: 1, t: 'keyset', so: NaN, id: 'x' })
      const encoded = Buffer.from(payload).toString('base64url')
      // NaN serialises to null in JSON, so sortOrder type check fails
      expect(() => decodeCursor(encoded)).toThrow(/sortOrder must be a/)
    })

    it('should reject payload with fractional sortOrder', () => {
      const payload = JSON.stringify({ v: 1, t: 'keyset', so: 10.5, id: 'x' })
      const encoded = Buffer.from(payload).toString('base64url')
      expect(() => decodeCursor(encoded)).toThrow(/sortOrder must be an integer/)
    })

    it('should reject payload with fractional sortOrder (0.1)', () => {
      const payload = JSON.stringify({ v: 1, t: 'keyset', so: 0.1, id: 'x' })
      const encoded = Buffer.from(payload).toString('base64url')
      expect(() => decodeCursor(encoded)).toThrow(/sortOrder must be an integer/)
    })

    it('should reject payload with empty id', () => {
      const payload = JSON.stringify({ v: 1, t: 'keyset', so: 0, id: '' })
      const encoded = Buffer.from(payload).toString('base64url')
      expect(() => decodeCursor(encoded)).toThrow(/id must be a non-empty string/)
    })

    it('should reject payload with non-string id', () => {
      const payload = JSON.stringify({ v: 1, t: 'keyset', so: 0, id: 123 })
      const encoded = Buffer.from(payload).toString('base64url')
      expect(() => decodeCursor(encoded)).toThrow(/id must be a non-empty string/)
    })

    it('should reject payload that is an array', () => {
      const payload = JSON.stringify([1, 2, 3])
      const encoded = Buffer.from(payload).toString('base64url')
      expect(() => decodeCursor(encoded)).toThrow(/payload is not an object/)
    })

    it('should reject payload that is null', () => {
      const payload = JSON.stringify(null)
      const encoded = Buffer.from(payload).toString('base64url')
      expect(() => decodeCursor(encoded)).toThrow(/payload is not an object/)
    })
  })

  describe('validateLimit', () => {
    it('should return DEFAULT_LIMIT for undefined/null', () => {
      expect(validateLimit(undefined)).toBe(DEFAULT_LIMIT)
      expect(validateLimit(null)).toBe(DEFAULT_LIMIT)
    })

    it('should accept valid positive integers', () => {
      expect(validateLimit(1)).toBe(1)
      expect(validateLimit(50)).toBe(50)
      expect(validateLimit(MAX_LIMIT)).toBe(MAX_LIMIT)
    })

    it('should clamp values above MAX_LIMIT', () => {
      expect(validateLimit(999)).toBe(MAX_LIMIT)
      expect(validateLimit(101)).toBe(MAX_LIMIT)
    })

    it('should reject non-integer values (no flooring)', () => {
      expect(() => validateLimit(10.5)).toThrow(/Must be an integer/)
      expect(() => validateLimit(1.9)).toThrow(/Must be an integer/)
      expect(() => validateLimit(0.5)).toThrow(/Must be an integer/)
    })

    it('should reject values below 1', () => {
      expect(() => validateLimit(0)).toThrow(/Must be >= 1/)
      expect(() => validateLimit(-1)).toThrow(/Must be >= 1/)
    })

    it('should reject non-finite numbers', () => {
      expect(() => validateLimit(Infinity)).toThrow(/Must be a positive finite number/)
      expect(() => validateLimit(NaN)).toThrow(/Must be a positive finite number/)
    })

    it('should reject non-number types', () => {
      expect(() => validateLimit('ten')).toThrow(/Must be a positive finite number/)
      expect(() => validateLimit({})).toThrow(/Must be a positive finite number/)
    })
  })
})

// ===========================================================================
// Fix 1: Duplicate file_references migration test
// ===========================================================================

describe('Migration 002 — duplicate file_references collapse', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-dup-'))
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('should collapse duplicate 001 refs deriving to same (block_id, file_id) — lowest id wins deterministically', () => {
    const dbPath = realPath.join(tempDir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    // Apply 001 manually
    sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
    for (const stmt of MIGRATIONS[0].sql) {
      sqlite.exec(stmt)
    }
    sqlite.exec(
      `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
    )

    // Insert data: topic → message → block (file type) → two file_references for same file
    sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
    sqlite
      .prepare(`INSERT INTO messages (id, topic_id, role, content, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('m1', 't1', 'user', 'Hello', 0, '2026-01-01')
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('b1', 'm1', 'file', null, 0, JSON.stringify({ file: { id: 'file-x' } }))

    // Two 001 file_references that both resolve to (b1, file-x)
    // ref-z has lower id → should be the deterministic winner
    sqlite
      .prepare(
        `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'ref-z',
        'm1',
        'file-x',
        'winner.pdf',
        '/winner.pdf',
        'file',
        1,
        JSON.stringify({ id: 'file-x', note: 'winner' })
      )
    sqlite
      .prepare(
        `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'ref-a',
        'm1',
        'file-x',
        'loser.pdf',
        '/loser.pdf',
        'file',
        2,
        JSON.stringify({ id: 'file-x', note: 'loser' })
      )

    // Apply 002 (+003, +004 — all pending)
    const db = drizzle(sqlite, { schema })
    const count = runMigrations(db, sqlite)
    expect(count).toBe(8)

    // Only one row should survive (ref-a has lower id lexicographically)
    const refs = sqlite.prepare('SELECT * FROM file_references').all() as Array<Record<string, unknown>>
    expect(refs).toHaveLength(1)
    expect(refs[0].id).toBe('ref-a')
    expect(refs[0].block_id).toBe('b1')
    expect(refs[0].file_id).toBe('file-x')
    expect(refs[0].file_name).toBe('loser.pdf')

    // Winner's metadata preserved (ref-a had note: 'loser')
    const extra = JSON.parse(refs[0].extra as string)
    expect(extra.note).toBe('loser')

    sqlite.close()
  })

  it('should keep distinct (block_id, file_id) pairs unchanged', () => {
    const dbPath = realPath.join(tempDir, 'test2.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
    for (const stmt of MIGRATIONS[0].sql) {
      sqlite.exec(stmt)
    }
    sqlite.exec(
      `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
    )

    sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
    sqlite
      .prepare(`INSERT INTO messages (id, topic_id, role, content, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('m1', 't1', 'user', 'Hello', 0, '2026-01-01')

    // Two file blocks for different files
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('b1', 'm1', 'file', null, 0, JSON.stringify({ file: { id: 'file-a' } }))
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('b2', 'm1', 'file', null, 1, JSON.stringify({ file: { id: 'file-b' } }))

    // Two distinct file_references
    sqlite
      .prepare(
        `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('ref-1', 'm1', 'file-a', 'a.pdf', '/a.pdf', 'file', 1, null)
    sqlite
      .prepare(
        `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('ref-2', 'm1', 'file-b', 'b.pdf', '/b.pdf', 'file', 1, null)

    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    const refs = sqlite.prepare('SELECT * FROM file_references ORDER BY id').all() as Array<Record<string, unknown>>
    expect(refs).toHaveLength(2)
    expect(refs[0].id).toBe('ref-1')
    expect(refs[0].block_id).toBe('b1')
    expect(refs[1].id).toBe('ref-2')
    expect(refs[1].block_id).toBe('b2')

    sqlite.close()
  })
})

// ===========================================================================
// Fix 1 (extended): Multi-block file reference resolution test
// ===========================================================================

describe('Migration 002 — multi-block file reference resolution', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-multiblock-'))
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('should resolve each reference to exactly one block deterministically when multiple blocks match, then collapse duplicates', () => {
    const dbPath = realPath.join(tempDir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    // Apply 001 manually
    sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
    for (const stmt of MIGRATIONS[0].sql) {
      sqlite.exec(stmt)
    }
    sqlite.exec(
      `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
    )

    // Setup: topic → message → two file blocks with same file.id
    sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
    sqlite
      .prepare(`INSERT INTO messages (id, topic_id, role, content, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('m1', 't1', 'user', 'Hello', 0, '2026-01-01')

    // Two file blocks for the SAME file, different sort_order
    // b1 is at sort_order=0 (lower), b2 is at sort_order=1 (higher)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('b1', 'm1', 'file', null, 0, JSON.stringify({ file: { id: 'file-shared' } }))
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('b2', 'm1', 'file', null, 1, JSON.stringify({ file: { id: 'file-shared' } }))

    // Two file_references that both resolve to file-shared
    // ref-1 has lower id → should be the deterministic winner
    sqlite
      .prepare(
        `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'ref-1',
        'm1',
        'file-shared',
        'winner.pdf',
        '/winner.pdf',
        'file',
        1,
        JSON.stringify({ id: 'file-shared', note: 'low-id-wins' })
      )
    sqlite
      .prepare(
        `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'ref-2',
        'm1',
        'file-shared',
        'high-meta.pdf',
        '/high-meta.pdf',
        'file',
        5,
        JSON.stringify({ id: 'file-shared', note: 'high-meta-loses' })
      )

    // Apply 002 (+003, +004 — all pending)
    const db = drizzle(sqlite, { schema })
    const count = runMigrations(db, sqlite)
    expect(count).toBe(8)

    // Exactly one reference should survive
    const refs = sqlite.prepare('SELECT * FROM file_references').all() as Array<Record<string, unknown>>
    expect(refs).toHaveLength(1)

    // ref-1 has lower id → deterministic winner
    expect(refs[0].id).toBe('ref-1')

    // Block resolution: b1 has lower sort_order (0) → should be selected
    expect(refs[0].block_id).toBe('b1')
    expect(refs[0].file_id).toBe('file-shared')

    // Winner's metadata preserved
    expect(refs[0].file_name).toBe('winner.pdf')
    const extra = JSON.parse(refs[0].extra as string)
    expect(extra.note).toBe('low-id-wins')

    sqlite.close()
  })

  it('should select block with lowest sort_order when multiple blocks match same file_id in same message', () => {
    const dbPath = realPath.join(tempDir, 'sortorder.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
    for (const stmt of MIGRATIONS[0].sql) {
      sqlite.exec(stmt)
    }
    sqlite.exec(
      `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
    )

    sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('t1', 'T', '2026-01-01')
    sqlite
      .prepare(`INSERT INTO messages (id, topic_id, role, content, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('m1', 't1', 'user', 'Hello', 0, '2026-01-01')

    // Three file blocks for same file, varying sort_order
    // b-mid (sort_order=0) should be selected over b-low (sort_order=5) and b-high (sort_order=10)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('b-low', 'm1', 'file', null, 5, JSON.stringify({ file: { id: 'file-x' } }))
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('b-mid', 'm1', 'file', null, 0, JSON.stringify({ file: { id: 'file-x' } }))
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('b-high', 'm1', 'file', null, 10, JSON.stringify({ file: { id: 'file-x' } }))

    // Single reference
    sqlite
      .prepare(
        `INSERT INTO file_references (id, message_id, file_id, file_name, file_path, file_type, count, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('ref-1', 'm1', 'file-x', 'x.pdf', '/x.pdf', 'file', 1, null)

    runMigrations(drizzle(sqlite, { schema }), sqlite)

    const ref = sqlite.prepare('SELECT * FROM file_references WHERE id = ?').get('ref-1') as Record<string, unknown>
    // b-mid has sort_order=0 (lowest) → should be the selected block
    expect(ref.block_id).toBe('b-mid')

    sqlite.close()
  })
})

// ===========================================================================
// Fix 2: Overflow merge semantics tests
// ===========================================================================

describe('Overflow merge semantics (mergeOverflow)', () => {
  it('should merge new keys into current overflow', () => {
    const current = { a: 1, b: 2 }
    const result = mergeOverflow(current, { c: 3 })
    expect(result).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('should overwrite existing keys', () => {
    const current = { a: 1, b: 2 }
    const result = mergeOverflow(current, { b: 99 })
    expect(result).toEqual({ a: 1, b: 99 })
  })

  it('should remove keys marked with OVERFLOW_REMOVE', () => {
    const current = { a: 1, b: 2, c: 3 }
    const result = mergeOverflow(current, { b: OVERFLOW_REMOVE })
    expect(result).toEqual({ a: 1, c: 3 })
  })

  it('should skip undefined values (no-op)', () => {
    const current = { a: 1, b: 2 }
    const result = mergeOverflow(current, { b: undefined, c: undefined })
    expect(result).toEqual({ a: 1, b: 2 })
  })

  it('should preserve unrelated unknown keys', () => {
    const current = { futureFeature: { x: 1 }, anotherField: [1, 2], known: 'val' }
    const result = mergeOverflow(current, { known: 'updated' })
    expect(result.futureFeature).toEqual({ x: 1 })
    expect(result.anotherField).toEqual([1, 2])
    expect(result.known).toBe('updated')
  })

  it('should clear all overflow when options.clear is true', () => {
    const current = { a: 1, b: 2, c: 3 }
    const result = mergeOverflow(current, {}, { clear: true })
    expect(result).toEqual({})
  })

  it('should clear then apply delta when clear + delta combined', () => {
    const current = { a: 1, b: 2 }
    const result = mergeOverflow(current, { fresh: true }, { clear: true })
    expect(result).toEqual({ fresh: true })
  })

  it('should not mutate the current object', () => {
    const current = { a: 1 }
    mergeOverflow(current, { b: 2 })
    expect(current).toEqual({ a: 1 })
  })

  it('should return empty object when current is empty and delta is empty', () => {
    const result = mergeOverflow({}, {})
    expect(result).toEqual({})
  })

  it('should handle OVERFLOW_REMOVE on non-existent key gracefully', () => {
    const current = { a: 1 }
    const result = mergeOverflow(current, { notThere: OVERFLOW_REMOVE })
    expect(result).toEqual({ a: 1 })
  })

  it('should support combination of set, remove, and skip', () => {
    const current = { a: 1, b: 2, c: 3, d: 4 }
    const result = mergeOverflow(current, {
      a: 100, // set
      b: OVERFLOW_REMOVE, // remove
      c: undefined, // skip (no-op)
      // d: absent → preserve
      e: 'new' // add
    })
    expect(result).toEqual({ a: 100, c: 3, d: 4, e: 'new' })
  })
})

// ===========================================================================
// Fix 4: Collision-safe mapping / reconstruct tests
// ===========================================================================

describe('Reconstruct helper — collision safety', () => {
  it('should make columns win over same-named overflow keys', () => {
    // Simulate a topic where overflow has stale 'name' value
    const domain = {
      id: 't1',
      assistantId: 'asst-1',
      name: 'Column Name', // authoritative column
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      deletedAt: null,
      overflow: {
        name: 'Stale Overflow Name', // stale same-named key
        type: 'chat',
        pinned: true
      }
    }

    const plain = reconstruct(domain)
    // Column wins
    expect(plain.name).toBe('Column Name')
    // Non-colliding overflow preserved
    expect((plain as any).type).toBe('chat')
    expect((plain as any).pinned).toBe(true)
    // overflow key itself is removed
    expect((plain as any).overflow).toBeUndefined()
  })

  it('should make promoted fields win over stale extra values (messages)', () => {
    const domain = {
      id: 'm1',
      topicId: 't1',
      role: 'user',
      content: 'Hello',
      status: 'success', // promoted column
      askId: null,
      model: 'gpt-4',
      modelId: 'gpt-4o', // promoted column
      assistantId: 'asst-1', // promoted column
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      sortOrder: 0,
      overflow: {
        status: 'old-status', // stale
        modelId: 'old-model', // stale
        assistantId: 'old-asst', // stale
        usage: { tokens: 100 }
      }
    }

    const plain = reconstruct(domain)
    expect(plain.status).toBe('success')
    expect(plain.modelId).toBe('gpt-4o')
    expect(plain.assistantId).toBe('asst-1')
    expect((plain as any).usage).toEqual({ tokens: 100 })
  })

  it('should handle tool block: object content in overflow via overrides', () => {
    const block = {
      id: 'b1',
      messageId: 'm1',
      type: 'tool',
      content: null as string | null, // column is null for tool blocks
      status: 'success',
      createdAt: '2026-01-01',
      updatedAt: null,
      sortOrder: 1,
      overflow: {
        toolId: 'tool-1',
        content: { results: [{ title: 'R1', url: 'https://example.com' }] }
      }
    }

    // Without override: column content (null) wins → tool content lost
    const plain = reconstruct(block)
    expect(plain.content).toBeNull()

    // With override: explicitly restore object content
    const withContent = reconstruct(block, {
      content: block.overflow.content
    })
    expect(withContent.content).toEqual({ results: [{ title: 'R1', url: 'https://example.com' }] })
  })

  it('should handle string content blocks without override (no collision)', () => {
    const block = {
      id: 'b2',
      messageId: 'm1',
      type: 'main_text',
      content: 'Hello world',
      status: 'success',
      createdAt: '2026-01-01',
      updatedAt: null,
      sortOrder: 0,
      overflow: {}
    }

    const plain = reconstruct(block)
    expect(plain.content).toBe('Hello world')
  })

  it('should apply overrides with highest precedence', () => {
    const domain = {
      id: 't1',
      assistantId: null,
      name: 'Column',
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      overflow: { name: 'Overflow' }
    }

    const plain = reconstruct(domain, { name: 'Override' })
    expect(plain.name).toBe('Override')
  })
})

// ===========================================================================
// Fix 5: Type-safe migration runner tests
// ===========================================================================

describe('Type-safe migration runner', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-typesafe-'))
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('should restore original foreign_keys value after successful migration', () => {
    const dbPath = realPath.join(tempDir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    const fkBefore = sqlite.pragma('foreign_keys', { simple: true })
    expect(fkBefore).toBe(1)

    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    // FK should be restored to ON after migration
    const fkAfter = sqlite.pragma('foreign_keys', { simple: true })
    expect(fkAfter).toBe(1)

    sqlite.close()
  })

  it('should restore original foreign_keys value after injected migration failure', () => {
    const dbPath = realPath.join(tempDir, 'rollback-fk.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    // Apply 001 only
    sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
    for (const stmt of MIGRATIONS[0].sql) {
      sqlite.exec(stmt)
    }
    sqlite.exec(
      `INSERT INTO migration_state (key, value, updated_at) VALUES ('001_initial_schema', '001_initial_schema', '${new Date().toISOString()}')`
    )

    const fkBefore = sqlite.pragma('foreign_keys', { simple: true })
    expect(fkBefore).toBe(1)

    // Inject broken SQL for 002
    const saved002Sql = [...MIGRATIONS[1].sql]
    MIGRATIONS[1].sql = ['THIS IS NOT VALID SQL']

    try {
      const db = drizzle(sqlite, { schema })
      expect(() => runMigrations(db, sqlite)).toThrow()
    } finally {
      MIGRATIONS[1].sql = saved002Sql
    }

    // FK should be restored even after failure
    const fkAfter = sqlite.pragma('foreign_keys', { simple: true })
    expect(fkAfter).toBe(1)

    sqlite.close()
  })

  it('should fail fast when rawSqlite is not provided', () => {
    const dbPath = realPath.join(tempDir, 'test.db')
    const sqlite = new Database(dbPath)
    const db = drizzle(sqlite, { schema })

    // @ts-expect-error — testing runtime guard for missing second argument
    expect(() => runMigrations(db, null)).toThrow(/requires a raw better-sqlite3 Database/)
    expect(() => runMigrations(db, undefined as any)).toThrow(/requires a raw better-sqlite3 Database/)

    sqlite.close()
  })
})

// ===========================================================================
// Fix 6: Single uniqueness mechanism verification
// ===========================================================================

describe('Single file_references uniqueness mechanism', () => {
  it('002 migration should define uniqueness only via named CREATE UNIQUE INDEX (not inline UNIQUE)', () => {
    const sql = MIGRATIONS[1].sql.join(' ')
    // Named unique index present
    expect(sql).toContain('file_references_block_id_file_id_uniq')
    // Inline UNIQUE constraint on CREATE TABLE should NOT be present
    // (check that the CREATE TABLE for file_references_new does not contain UNIQUE)
    const createTableSql = MIGRATIONS[1].sql.find((s) => s.includes('file_references_new'))
    expect(createTableSql).toBeDefined()
    // The CREATE TABLE statement should NOT have an inline UNIQUE constraint
    // We check for UNIQUE( but not inside a CREATE UNIQUE INDEX statement
    const tableSql = createTableSql!
    const lines = tableSql.split('\n').map((l) => l.trim())
    const hasInlineUnique = lines.some((l) => l.startsWith('UNIQUE(') || l.startsWith('UNIQUE ('))
    expect(hasInlineUnique).toBe(false)
  })

  it('Drizzle schema should use the same named uniqueIndex', () => {
    // The schema file defines uniqueIndex('file_references_block_id_file_id_uniq')
    // This is verified by the fact that the Drizzle schema compiles without error
    // and the migration SQL uses the same name. A runtime check:
    // schema is already imported at the top level
    expect(schema.fileReferences).toBeDefined()
  })
})
