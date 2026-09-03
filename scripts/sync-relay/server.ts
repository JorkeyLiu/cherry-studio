/**
 * Reference HTTP relay for sync MVP — isolated non-production path.
 * Minimal persistent operation log with endpoint handlers.
 * Must NOT be imported by production app code.
 * Runnable via:  npx tsx scripts/sync-relay/server.ts [--port 3000] [--db /tmp/sync-relay.db] [--token secret]
 */

import { existsSync, mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'

import Database from 'better-sqlite3'

import { validateSyncOperationStrict as validateSyncOperationStrictShared } from '../../packages/shared/sync/payloadFilter'

const SYNC_MAX_OPERATIONS_PER_PUSH = 200
const SYNC_MAX_OPERATIONS_PER_PULL = 200
const SYNC_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const SYNC_MAX_SERIALIZED_PAYLOAD_BYTES = 512 * 1024

interface SyncOperation {
  id: string
  entityType: string
  op: string
  entityId: string
  timestamp: number
  deviceId: string
  payload?: Record<string, unknown>
}

export interface RelayOptions {
  /** If set, Bearer token is required for push/pull */
  token?: string
}

function parseArgs(): { port: number; dbPath: string; token?: string } {
  const args = process.argv.slice(2)
  let port = 3030
  let dbPath = resolve(process.cwd(), 'tmp-sync-relay.db')
  let token: string | undefined
  const envToken = process.env.SYNC_RELAY_TOKEN
  if (envToken && envToken.length > 0) token = envToken
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1], 10)
    if (args[i] === '--db' && args[i + 1]) dbPath = resolve(args[i + 1])
    if (args[i] === '--token' && args[i + 1]) token = args[i + 1]
  }
  return { port, dbPath, token }
}

function initDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      entity_type TEXT NOT NULL,
      op TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS operations_timestamp_idx ON operations(timestamp);
    CREATE INDEX IF NOT EXISTS operations_entity_id_idx ON operations(entity_id);
  `)
  return db
}

// Operation validation delegates to the shared strict validator
// (packages/shared/sync/payloadFilter) as the single source of truth;
// relay adds only transport byte limits here.
function validateOp(op: SyncOperation): string | null {
  // Single source of truth: shared strict validator covers structure,
  // allowlist, identity agreement, relation IDs, and per-field types.
  const sharedErr = validateSyncOperationStrictShared(op as any)
  if (sharedErr) return sharedErr
  if (op.payload !== undefined && op.payload !== null) {
    const payloadStr = JSON.stringify(op.payload)
    if (Buffer.byteLength(payloadStr, 'utf8') > SYNC_MAX_SERIALIZED_PAYLOAD_BYTES) {
      return 'payload too large'
    }
  }
  return null
}

function jsonBodyWithLimit(req: IncomingMessage, limitBytes: number): Promise<any> {
  return new Promise((resolveBody, reject) => {
    let total = 0
    let data = ''
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limitBytes) {
        exceeded = true
        // stop collecting but keep draining
        return
      }
      data += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (exceeded) {
        reject(new Error('payload too large'))
        return
      }
      if (!data) return resolveBody({})
      try {
        resolveBody(JSON.parse(data))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function checkAuth(req: IncomingMessage, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true
  const hdr = req.headers.authorization
  if (!hdr || typeof hdr !== 'string') return false
  const prefix = 'Bearer '
  if (!hdr.startsWith(prefix)) return false
  const token = hdr.slice(prefix.length)
  return token === expectedToken
}

export function createRelayServer(db: Database.Database, opts?: RelayOptions) {
  const expectedToken = opts?.token ?? process.env.SYNC_RELAY_TOKEN ?? undefined
  const tokenRequired = typeof expectedToken === 'string' && expectedToken.length > 0

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? 'localhost'
    const url = new URL(req.url ?? '/', `http://${host}`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/sync/push') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      // Enforce byte limit via header check + body accumulation
      const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
      if (contentLength > SYNC_MAX_PAYLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, SYNC_MAX_PAYLOAD_BYTES)
        const rawOps: unknown = body.operations
        if (!Array.isArray(rawOps)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'operations must be array' }))
          return
        }
        const ops = rawOps as SyncOperation[]
        if (ops.length > SYNC_MAX_OPERATIONS_PER_PUSH) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `too many operations max ${SYNC_MAX_OPERATIONS_PER_PUSH}` }))
          return
        }
        // Validate all ops before inserting — reject invalid instead of silently skipping
        for (const op of ops) {
          const err = validateOp(op)
          if (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `invalid operation ${op?.id ?? ''}: ${err}` }))
            return
          }
        }
        // Serialized body limit — check JSON size
        const bodyStr = JSON.stringify(body)
        if (Buffer.byteLength(bodyStr, 'utf8') > SYNC_MAX_PAYLOAD_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'payload too large' }))
          return
        }
        const acceptedIds: string[] = []
        const insert = db.prepare(
          `INSERT OR IGNORE INTO operations (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        const txn = db.transaction((opsList: SyncOperation[]) => {
          for (const op of opsList) {
            insert.run(
              op.id,
              op.entityType,
              op.op,
              op.entityId,
              op.timestamp,
              op.deviceId,
              op.payload ? JSON.stringify(op.payload) : null,
              new Date().toISOString()
            )
            const ch = db.prepare('SELECT changes() as c').get() as { c: number }
            if (ch.c > 0) acceptedIds.push(op.id)
          }
        })
        txn(ops)
        const row = db.prepare('SELECT COALESCE(MAX(seq),0) as maxSeq FROM operations').get() as { maxSeq: number }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ acceptedIds, cursor: row.maxSeq }))
      } catch (e) {
        const msg = (e as Error).message
        if (msg === 'payload too large') {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'payload too large' }))
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: msg.slice(0, 500) }))
        }
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/sync/pull') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const cursorParam = url.searchParams.get('cursor') ?? '0'
      const cursor = parseInt(cursorParam, 10)
      if (!Number.isFinite(cursor) || cursor < 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid cursor' }))
        return
      }
      const limitParam = parseInt(url.searchParams.get('limit') ?? String(SYNC_MAX_OPERATIONS_PER_PULL), 10)
      let limit = Number.isFinite(limitParam) ? limitParam : SYNC_MAX_OPERATIONS_PER_PULL
      if (limit <= 0) limit = SYNC_MAX_OPERATIONS_PER_PULL
      if (limit > SYNC_MAX_OPERATIONS_PER_PULL) limit = SYNC_MAX_OPERATIONS_PER_PULL
      const rows = db
        .prepare(
          'SELECT seq, id, entity_type, op, entity_id, timestamp, device_id, payload_json FROM operations WHERE seq > ? ORDER BY seq ASC LIMIT ?'
        )
        .all(cursor, limit) as any[]
      const ops = rows.map((r) => ({
        seq: r.seq,
        id: r.id,
        entityType: r.entity_type,
        op: r.op,
        entityId: r.entity_id,
        timestamp: r.timestamp,
        deviceId: r.device_id,
        payload: r.payload_json ? JSON.parse(r.payload_json) : undefined
      }))
      // Cursor is last sequence actually returned, not global max — prevents skip on push or paging
      const returnedCursor = ops.length > 0 ? ops[ops.length - 1].seq : cursor
      // Enforce serialized payload limit for pull response
      const respObj = { operations: ops, cursor: returnedCursor }
      const respStr = JSON.stringify(respObj)
      if (Buffer.byteLength(respStr, 'utf8') > SYNC_MAX_PAYLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(respStr)
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  return server
}

const isMain = typeof require !== 'undefined' && (require as any).main === module
if (isMain) {
  const { port, dbPath, token } = parseArgs()
  const db = initDb(dbPath)
  const server = createRelayServer(db, { token })
  // Bind to loopback only — isolated non-production
  server.listen(port, '127.0.0.1', () => {
    // Bounded readiness output — no sensitive path
    console.log(`[sync-relay] listening on http://127.0.0.1:${port}`)
  })
}
