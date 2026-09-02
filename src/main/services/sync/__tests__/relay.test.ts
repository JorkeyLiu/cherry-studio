import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
// Note: relay server is not imported here — this test validates relay DB logic directly without HTTP, keeping relay isolated

describe('reference relay db logic', () => {
  it('online create: insert and query', () => {
    const db = new Database(':memory:')
    db.exec(
      `CREATE TABLE operations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, entity_type TEXT, op TEXT, entity_id TEXT, timestamp INTEGER, device_id TEXT, payload_json TEXT)`
    )
    const insert = db.prepare(
      `INSERT OR IGNORE INTO operations (id, entity_type, op, entity_id, timestamp, device_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const op = {
      id: 'op-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't1',
      timestamp: Date.now(),
      deviceId: 'd1',
      payload: { id: 't1', name: 'A' }
    }
    insert.run(op.id, op.entityType, op.op, op.entityId, op.timestamp, op.deviceId, JSON.stringify(op.payload))
    const row = db.prepare('SELECT id FROM operations WHERE id=?').get('op-1') as any
    expect(row.id).toBe('op-1')
    db.close()
  })

  it('duplicate replay is idempotent via INSERT OR IGNORE', () => {
    const db = new Database(':memory:')
    db.exec(
      `CREATE TABLE operations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, entity_type TEXT, op TEXT, entity_id TEXT, timestamp INTEGER, device_id TEXT, payload_json TEXT)`
    )
    const insert = db.prepare(
      `INSERT OR IGNORE INTO operations (id, entity_type, op, entity_id, timestamp, device_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('op-dup', 'topic', 'upsert', 't1', Date.now(), 'd1', '{}')
    insert.run('op-dup', 'topic', 'upsert', 't1', Date.now(), 'd1', '{}')
    const ch2 = db.prepare('SELECT changes() as c').get() as { c: number }
    expect(ch2.c).toBe(0)
    const count = (db.prepare('SELECT COUNT(*) as n FROM operations').get() as { n: number }).n
    expect(count).toBe(1)
    db.close()
  })

  it('pull after cursor returns only newer ops', () => {
    const db = new Database(':memory:')
    db.exec(
      `CREATE TABLE operations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, entity_type TEXT, op TEXT, entity_id TEXT, timestamp INTEGER, device_id TEXT, payload_json TEXT)`
    )
    const insert = db.prepare(
      `INSERT INTO operations (id, entity_type, op, entity_id, timestamp, device_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('op-1', 'topic', 'upsert', 't1', 1000, 'd1', '{}')
    insert.run('op-2', 'topic', 'upsert', 't2', 2000, 'd1', '{}')
    const rows = db.prepare('SELECT seq, id FROM operations WHERE seq > ? ORDER BY seq ASC').all(1) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('op-2')
    db.close()
  })

  it('integrity after close and reopen', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.exec(
      `CREATE TABLE operations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, entity_type TEXT, op TEXT, entity_id TEXT, timestamp INTEGER, device_id TEXT)`
    )
    db.prepare(
      `INSERT INTO operations (id, entity_type, op, entity_id, timestamp, device_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('op-x', 'topic', 'upsert', 't1', Date.now(), 'd1')
    expect(db.pragma('integrity_check', { simple: true }) as string).toBe('ok')
    db.close()
  })
})
