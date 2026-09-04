/**
 * Test-owned in-memory reference relay for sync E2E.
 *
 * Per-spec, in-process, loopback-bound to an ephemeral port, token-protected,
 * fully closed/cleaned in teardown. Mirrors the transport contract of
 * scripts/sync-relay/server.ts (auth, limits, push/pull framing) WITHOUT
 * loading better-sqlite3 in the Playwright runner process — the runner must
 * stay ABI-neutral (the native binding belongs to the Electron lane; E2E
 * SQLite access goes through the Electron binary only).
 *
 * Operation shape validation delegates to the shared strict validator
 * (packages/shared/sync/payloadFilter) as the single source of truth.
 * Must NOT be imported by production app code.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { validateSyncOperationStrict } from '../../../packages/shared/sync/payloadFilter'

const SYNC_MAX_OPERATIONS_PER_PUSH = 200
const SYNC_MAX_OPERATIONS_PER_PULL = 200
const SYNC_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const SYNC_MAX_SERIALIZED_PAYLOAD_BYTES = 512 * 1024
const SYNC_SSE_HEARTBEAT_MS = 15000

interface StoredOperation {
  seq: number
  id: string
  entityType: string
  op: string
  entityId: string
  timestamp: number
  deviceId: string
  payload?: Record<string, unknown>
}

export interface TestRelayHandle {
  endpoint: string
  port: number
  token: string
  close: () => Promise<void>
  /**
   * Reversible controlled network interruption for E2E. While paused, push
   * and pull fail closed (503) without touching the in-memory operation log
   * or cursor. This is NOT durable restart evidence: state lives only in
   * this process and close() discards it.
   */
  setPaused: (paused: boolean) => void
  isPaused: () => boolean
  /**
   * Independent direction barriers (test-only, in-memory). Push and pull
   * fail closed (503) independently when their barrier is set, without
   * touching the in-memory operation log or cursor. Auth precedence is
   * unchanged (401 wins over 503). SSE remains hint-only and is never
   * gated by these barriers. Combined with the legacy full pause: a push
   * is blocked while paused OR push-blocked; a pull is blocked while
   * paused OR pull-blocked. Clearing requires resetting each flag set.
   */
  setPushPaused: (paused: boolean) => void
  setPullPaused: (paused: boolean) => void
  isPushPaused: () => boolean
  isPullPaused: () => boolean
  /** Current relay cursor (sequence of the last stored operation). */
  getCursor: () => number
  /** Number of stored operations (in-memory log length). */
  getOperationCount: () => number
  /**
   * Number of push/pull requests currently admitted and executing.
   * Long-lived SSE subscriptions are never counted. Snapshot relay
   * cursor/operation counters only after {@link waitForQuiescent} so an
   * already-admitted request cannot commit after the snapshot.
   */
  getInFlightCount: () => number
  /** Resolve once no admitted push/pull request is still executing. */
  waitForQuiescent: (timeoutMs?: number) => Promise<void>
}

function checkAuth(req: IncomingMessage, expectedToken: string): boolean {
  const hdr = req.headers.authorization
  if (!hdr || typeof hdr !== 'string') return false
  const prefix = 'Bearer '
  if (!hdr.startsWith(prefix)) return false
  return hdr.slice(prefix.length) === expectedToken
}

/**
 * Strict canonical relay cursor parser (test relay mirror): only canonical
 * non-negative safe-integer decimal forms (`0` or `[1-9][0-9]*`). Rejects
 * `12junk`, `07`, whitespace, negatives, and unsafe integers with 400 before
 * any data access.
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

function jsonBodyWithLimit(req: IncomingMessage, limitBytes: number): Promise<any> {
  return new Promise((resolveBody, reject) => {
    let total = 0
    let data = ''
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limitBytes) {
        exceeded = true
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? ''
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function storedEquals(stored: StoredOperation, op: any): boolean {
  return (
    stored.entityType === op.entityType &&
    stored.op === op.op &&
    stored.entityId === op.entityId &&
    stored.timestamp === op.timestamp &&
    stored.deviceId === op.deviceId &&
    stableStringify(stored.payload ?? null) === stableStringify(op.payload ?? null)
  )
}

/**
 * Start the test-owned relay bound to 127.0.0.1 on an ephemeral port.
 * The caller owns the handle and MUST await close() (fail-closed).
 */
export function startTestRelay(token: string): Promise<TestRelayHandle> {
  if (!token || typeof token !== 'string') throw new Error('startTestRelay requires a non-empty token')
  const ops: StoredOperation[] = []
  let seq = 0
  let paused = false
  let pushPaused = false
  let pullPaused = false
  // Admitted push/pull requests still executing. Tracked so tests can wait
  // for quiescence before snapshotting cursor/operation counters; otherwise
  // an already-admitted request could commit after the snapshot and race the
  // assertion. SSE subscriptions are long-lived and never counted here.
  let inFlight = 0
  const trackInFlight = (res: ServerResponse): void => {
    inFlight += 1
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      inFlight = Math.max(0, inFlight - 1)
    }
    res.on('finish', finish)
    res.on('close', finish)
  }
  // Notification-only SSE subscribers: cursor hint only, never operations.
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
  try {
    ;(heartbeat as unknown as { unref?: () => void }).unref?.()
  } catch {}

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      // Auth precedence: invalid/missing auth stays 401 even while paused;
      // only authenticated requests observe the 503 pause signal.
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (paused || pushPaused) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'relay paused' }))
        return
      }
      // Admitted from here: finish/close listeners in trackInFlight
      // decrement once this response completes.
      trackInFlight(res)
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
        if (rawOps.length > SYNC_MAX_OPERATIONS_PER_PUSH) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `too many operations max ${SYNC_MAX_OPERATIONS_PER_PUSH}` }))
          return
        }
        for (const op of rawOps as any[]) {
          const err = validateSyncOperationStrict(op)
          if (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `invalid operation ${op?.id ?? ''}: ${err}` }))
            return
          }
          if (op.payload !== undefined && op.payload !== null) {
            const payloadStr = JSON.stringify(op.payload)
            if (Buffer.byteLength(payloadStr, 'utf8') > SYNC_MAX_SERIALIZED_PAYLOAD_BYTES) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: `invalid operation ${op?.id ?? ''}: payload too large` }))
              return
            }
          }
        }
        const bodyStr = JSON.stringify(body)
        if (Buffer.byteLength(bodyStr, 'utf8') > SYNC_MAX_PAYLOAD_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'payload too large' }))
          return
        }
        // Transactional parity with the reference relay (LOCK-RT-005/006):
        // validate and stage the full batch before committing any state, so
        // a rejected batch leaves no partial ops/sequence behind.
        const acceptedIds: string[] = []
        const byId = new Map(ops.map((o) => [o.id, o]))
        const staged: StoredOperation[] = []
        const stagedById = new Map<string, StoredOperation>()
        let stagedSeq = seq
        for (const op of rawOps as any[]) {
          const existing = stagedById.get(op.id) ?? byId.get(op.id)
          if (existing) {
            // Idempotent replay: identical content counts as accepted so a
            // lost push response can be replayed without stranding the outbox.
            // Mismatched ID content is a collision and is rejected.
            if (!storedEquals(existing, op)) {
              res.writeHead(409, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: `id collision for operation ${String(op.id).slice(0, 80)}` }))
              return
            }
            acceptedIds.push(op.id)
            continue
          }
          stagedSeq += 1
          const stagedOp: StoredOperation = {
            seq: stagedSeq,
            id: op.id,
            entityType: op.entityType,
            op: op.op,
            entityId: op.entityId,
            timestamp: op.timestamp,
            deviceId: op.deviceId,
            payload: op.payload
          }
          staged.push(stagedOp)
          stagedById.set(op.id, stagedOp)
          acceptedIds.push(op.id)
        }
        for (const s of staged) {
          ops.push(s)
          byId.set(s.id, s)
        }
        seq = stagedSeq
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ acceptedIds, cursor: seq }))
        // Notify only after successful push commit; cursor hint only.
        if (acceptedIds.length > 0) broadcastSyncHint(seq)
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
      // Auth precedence mirrors push: 401 wins over the 503 pause signal.
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (paused || pullPaused) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'relay paused' }))
        return
      }
      // Admitted from here: finish/close listeners in trackInFlight
      // decrement once this response completes.
      trackInFlight(res)
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
      const page = ops.filter((o) => o.seq > cursor).slice(0, limit)
      const returnedCursor = page.length > 0 ? page[page.length - 1].seq : cursor
      const respObj = { operations: page, cursor: returnedCursor }
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
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
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

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Loopback only — isolated non-production.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('test relay did not bind to a port'))
        return
      }
      const endpoint = `http://127.0.0.1:${addr.port}`
      const handle: TestRelayHandle = {
        endpoint,
        port: addr.port,
        token,
        setPaused: (p: boolean) => {
          paused = p === true
        },
        isPaused: () => paused,
        setPushPaused: (p: boolean) => {
          pushPaused = p === true
        },
        setPullPaused: (p: boolean) => {
          pullPaused = p === true
        },
        isPushPaused: () => paused || pushPaused,
        isPullPaused: () => paused || pullPaused,
        getCursor: () => seq,
        getOperationCount: () => ops.length,
        getInFlightCount: () => inFlight,
        waitForQuiescent: async (timeoutMs = 5000) => {
          const deadline = Date.now() + timeoutMs
          while (inFlight > 0) {
            if (Date.now() >= deadline) throw new Error(`relay not quiescent: ${inFlight} in flight`)
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
        },
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            try {
              clearInterval(heartbeat)
            } catch {}
            for (const client of [...sseClients]) {
              try {
                client.end()
              } catch {}
            }
            sseClients.clear()
            server.close((err) => {
              if (err) rejectClose(err)
              else resolveClose()
            })
          })
      }
      resolve(handle)
    })
  })
}
