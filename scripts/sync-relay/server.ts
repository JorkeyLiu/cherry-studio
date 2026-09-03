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
const SYNC_SSE_HEARTBEAT_MS = 15000

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
    if (args[i] === '--port' && args[i + 1]) {
      const parsed = Number(args[i + 1])
      if (Number.isSafeInteger(parsed) && parsed >= 0) port = parsed
    }
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

function payloadJsonEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true
  if (!a || !b) return false
  try {
    return stableStringify(JSON.parse(a)) === stableStringify(JSON.parse(b))
  } catch {
    return false
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? ''
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
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

/**
 * Strict canonical relay cursor parser: only canonical non-negative
 * safe-integer decimal forms are accepted (`0` or `[1-9][0-9]*`, no leading
 * zeros, no whitespace, no trailing junk like `12junk`, no `07`). Numbers
 * must be safe integers >= 0. Anything else throws — callers reject with 400
 * before any database access.
 */
function parseStrictRelayCursor(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid cursor')
    return value
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('invalid cursor')
  }
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new Error('invalid cursor')
  return n
}

export function createRelayServer(db: Database.Database, opts?: RelayOptions) {
  const expectedToken = opts?.token ?? process.env.SYNC_RELAY_TOKEN ?? undefined
  const tokenRequired = typeof expectedToken === 'string' && expectedToken.length > 0
  // Notification-only SSE subscribers. Each entry is an open event-stream
  // response; events carry only a non-authoritative cursor hint ({cursor}),
  // never operations or payloads. Data moves only via push/pull.
  const sseClients = new Set<ServerResponse>()
  const broadcastSyncHint = (cursor: number): void => {
    const line = `event: sync\ndata: ${JSON.stringify({ cursor })}\n\n`
    for (const client of [...sseClients]) {
      try {
        client.write(line)
      } catch {
        try {
          sseClients.delete(client)
        } catch {}
      }
    }
  }
  const heartbeat = setInterval(() => {
    for (const client of [...sseClients]) {
      try {
        client.write(': heartbeat\n\n')
      } catch {
        try {
          sseClients.delete(client)
        } catch {}
      }
    }
  }, SYNC_SSE_HEARTBEAT_MS)
  // Avoid keeping the process alive on the heartbeat alone; HTTP sockets keep
  // the server alive while subscribed.
  try {
    ;(heartbeat as unknown as { unref?: () => void }).unref?.()
  } catch {}

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
      const clHeader = req.headers['content-length']
      const clStr = Array.isArray(clHeader) ? (clHeader[0] ?? '0') : (clHeader ?? '0')
      const contentLength = Number(clStr)
      if (Number.isFinite(contentLength) && contentLength > SYNC_MAX_PAYLOAD_BYTES) {
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
        const findById = db.prepare(
          'SELECT id, entity_type, op, entity_id, timestamp, device_id, payload_json FROM operations WHERE id = ?'
        )
        const txn = db.transaction((opsList: SyncOperation[]) => {
          for (const op of opsList) {
            const incomingPayloadJson = op.payload ? JSON.stringify(op.payload) : null
            insert.run(
              op.id,
              op.entityType,
              op.op,
              op.entityId,
              op.timestamp,
              op.deviceId,
              incomingPayloadJson,
              new Date().toISOString()
            )
            const ch = db.prepare('SELECT changes() as c').get() as { c: number }
            if (ch.c > 0) {
              acceptedIds.push(op.id)
              continue
            }
            // Idempotent replay: the ID already exists. Prove the stored row
            // matches the current-chunk operation exactly (no mismatched ID
            // collision accepted). Identical content counts as accepted so a
            // lost push response can be replayed without stranding the outbox.
            const existing = findById.get(op.id) as
              | {
                  id: string
                  entity_type: string
                  op: string
                  entity_id: string
                  timestamp: number
                  device_id: string
                  payload_json: string | null
                }
              | undefined
            if (
              existing &&
              existing.entity_type === op.entityType &&
              existing.op === op.op &&
              existing.entity_id === op.entityId &&
              existing.timestamp === op.timestamp &&
              existing.device_id === op.deviceId &&
              payloadJsonEqual(existing.payload_json, incomingPayloadJson)
            ) {
              acceptedIds.push(op.id)
              continue
            }
            throw new Error(`id collision for operation ${String(op.id).slice(0, 80)}`)
          }
        })
        try {
          txn(ops)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.startsWith('id collision')) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: msg.slice(0, 500) }))
            return
          }
          throw e
        }
        const row = db.prepare('SELECT COALESCE(MAX(seq),0) as maxSeq FROM operations').get() as { maxSeq: number }
        // Notify only after successful push commit; hint carries cursor only.
        if (acceptedIds.length > 0) broadcastSyncHint(row.maxSeq)
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
      let cursor: number
      try {
        cursor = parseStrictRelayCursor(cursorParam)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid cursor' }))
        return
      }
      let limit = SYNC_MAX_OPERATIONS_PER_PULL
      const limitRaw = url.searchParams.get('limit')
      if (limitRaw !== null) {
        try {
          limit = parseStrictRelayCursor(limitRaw)
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid limit' }))
          return
        }
      }
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

    if (req.method === 'GET' && url.pathname === '/sync/subscribe') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      // Non-authoritative cursor query hint only; strict framing is validated
      // before subscribing, never used to filter or promise delivery. Actual
      // data moves via pull.
      const cursorParam = url.searchParams.get('cursor') ?? '0'
      try {
        parseStrictRelayCursor(cursorParam)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid cursor' }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // Flush headers immediately so clients observe the stream pre-event.
      try {
        ;(res as unknown as { flushHeaders?: () => void }).flushHeaders?.()
      } catch {}
      res.write(': connected\n\n')
      sseClients.add(res)
      const cleanup = (): void => {
        sseClients.delete(res)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  server.on('close', () => {
    try {
      clearInterval(heartbeat)
    } catch {}
    for (const client of [...sseClients]) {
      try {
        client.end()
      } catch {}
    }
    sseClients.clear()
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
    // Report the actual bound port so `--port 0` (ephemeral) is observable;
    // fixed ports log unchanged.
    const addr = server.address()
    const boundPort = typeof addr === 'object' && addr ? addr.port : port
    // Bounded readiness output — no sensitive path
    console.log(`[sync-relay] listening on http://127.0.0.1:${boundPort}`)
  })
}
