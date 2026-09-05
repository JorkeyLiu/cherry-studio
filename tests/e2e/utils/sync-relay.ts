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
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { normalizePairingCode, validatePairingCode } from '../../../packages/shared/sync/pairing'
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
   * Test-only trust-store failure injection (F-003): while set, every
   * trust read/write fails closed with 500 trust-store-unavailable and no
   * bootstrap or success is returned.
   */
  setTrustStoreFailure: (fail: boolean) => void
  isTrustStoreFailure: () => boolean
  /**
   * Test-only trust-state observers (never over HTTP): the relay retains the
   * plaintext it issued so the test runner can authenticate raw diagnostic
   * calls as an already-trusted device. Production code must never use these;
   * device credentials travel only in issuance responses and auth headers.
   */
  getIssuedDeviceAuthForTests: (deviceId: string) => string | undefined
  listTrustedDeviceIdsForTests: () => string[]
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
  // Pairing/trust state (in-memory test mirror of the reference relay).
  const trusted = new Map<string, { deviceId: string; deviceName?: string; trustedAt: string; source: string }>()
  const deviceSecretHash = new Map<string, string>()
  // Test-only retention of issued plaintext (runner-process memory only, never
  // over HTTP, never logged): lets E2E specs authenticate raw diagnostic
  // calls as an already-trusted device without minting new trust.
  const issuedPlaintext = new Map<string, string>()
  const rememberIssued = (deviceId: string, secret: string): void => {
    issuedPlaintext.set(deviceId, secret)
  }
  const DEVICE_AUTH_PATTERN = /^[0-9a-fA-F]{64}$/
  const isValidAuth = (v: unknown): v is string => typeof v === 'string' && DEVICE_AUTH_PATTERN.test(v)
  const genDeviceAuth = (): string => randomBytes(32).toString('hex')
  const hashAuth = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
  const secretEquals = (aHex: string, bHex: string): boolean => {
    try {
      const a = Buffer.from(aHex, 'hex')
      const b = Buffer.from(bHex, 'hex')
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    } catch {
      return false
    }
  }
  const readHeader = (req: IncomingMessage, name: string): string => {
    const v = req.headers[name]
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v[0] ?? ''
    return ''
  }
  let trustStoreFailure = false
  const failTrust = (): boolean => trustStoreFailure === true
  const verifyAuth = (deviceId: string, secret: string): boolean => {
    const stored = deviceSecretHash.get(deviceId)
    if (!stored) return false
    return secretEquals(hashAuth(secret), stored)
  }
  const invites = new Map<string, { code: string; inviterDeviceId: string; createdAt: string; expiresAt: string }>()
  const requests = new Map<
    string,
    {
      id: string
      deviceId: string
      deviceName?: string
      code: string
      createdAt: string
      expiresAt: string
      status: string
      deviceSecretHash?: string
    }
  >()
  const PAIRING_TTL_MS = 15 * 60 * 1000
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const genCode = (): string => {
    const bytes = randomBytes(8)
    let out = ''
    for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
    return out
  }
  const isValidDevice = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= 256 && v.trim().length > 0
  const sweep = (): void => {
    const now = Date.now()
    for (const r of requests.values()) {
      if (r.status === 'pending' && new Date(r.expiresAt).getTime() < now) r.status = 'expired'
    }
  }
  // F-001/F-002: proven tracks first successful credential proof; recovery
  // is allowed only for the sole unproven founder (delivery-loss window).
  const provenDevices = new Set<string>()
  const verifyAndMark = (deviceId: string, secret: string): boolean => {
    const ok = verifyAuth(deviceId, secret)
    if (ok) provenDevices.add(deviceId)
    return ok
  }
  // Atomic founder bootstrap (F-001): empty-check + insert is one synchronous
  // critical section under the Node event loop and mirrors the reference
  // relay single-statement atomic guard — concurrent founders serialize, the
  // loser observes a non-empty set. Throws trust-already-initialized on loss.
  const ensureBootstrap = (deviceId: string, source: string): string => {
    if (!isValidDevice(deviceId)) throw new Error('device id invalid')
    if (trusted.size !== 0) throw new Error('trust-already-initialized')
    if (trusted.has(deviceId)) throw new Error('trust-already-initialized')
    const secret = genDeviceAuth()
    trusted.set(deviceId, { deviceId, trustedAt: new Date().toISOString(), source })
    deviceSecretHash.set(deviceId, hashAuth(secret))
    rememberIssued(deviceId, secret)
    // Confirm synchronously; on mismatch roll back (atomic rollback) so a
    // retry bootstraps fresh instead of trusted-without-secret.
    const stored = deviceSecretHash.get(deviceId)
    if (!stored || !secretEquals(hashAuth(secret), stored)) {
      trusted.delete(deviceId)
      deviceSecretHash.delete(deviceId)
      throw new Error('trust-store-unavailable')
    }
    return secret
  }
  // F-002 decision parity: no unauthenticated rotation. Confirm failures
  // roll back; delivery loss is explicit 403 + operator reset recovery.
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Sync-Device-Id,X-Sync-Device-Auth')
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
        sweep()
        // AUD-001: all operation/payload validation runs BEFORE any trust
        // bootstrap write, so an illegal push never persists founder trust.
        const pushDeviceId: unknown = (body as { deviceId?: unknown })?.deviceId
        if (!isValidDevice(pushDeviceId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device id invalid' }))
          return
        }
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
          if (op.deviceId !== pushDeviceId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `operation device mismatch for ${op?.id ?? ''}` }))
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
        if (failTrust()) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const headerId = readHeader(req, 'x-sync-device-id')
        const headerAuth = readHeader(req, 'x-sync-device-auth')
        let issuedAuth: string | undefined
        if (trusted.size === 0) {
          if (headerId !== '' && headerId !== pushDeviceId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device id mismatch' }))
            return
          }
          try {
            issuedAuth = ensureBootstrap(pushDeviceId, 'bootstrap-sync')
          } catch (e) {
            if ((e as Error)?.message === 'trust-already-initialized') {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'device-not-trusted' }))
              return
            }
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
            return
          }
          if (!issuedAuth) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
            return
          }
        } else {
          if (!isValidDevice(headerId) || headerId !== pushDeviceId) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          }
          if (!isValidAuth(headerAuth) || !verifyAndMark(headerId, headerAuth)) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          }
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
              res.end(
                JSON.stringify(
                  issuedAuth
                    ? { error: `id collision for operation ${String(op.id).slice(0, 80)}`, deviceAuth: issuedAuth }
                    : { error: `id collision for operation ${String(op.id).slice(0, 80)}` }
                )
              )
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
        res.end(
          JSON.stringify(
            issuedAuth ? { acceptedIds, cursor: seq, deviceAuth: issuedAuth } : { acceptedIds, cursor: seq }
          )
        )
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
      // AUD-001: cursor/limit framing is validated BEFORE any trust
      // bootstrap write, so a malformed pull never persists founder trust.
      sweep()
      const pullDeviceId = url.searchParams.get('deviceId') ?? ''
      const pullHeaderId = readHeader(req, 'x-sync-device-id')
      const pullHeaderAuth = readHeader(req, 'x-sync-device-auth')
      if (!isValidDevice(pullDeviceId) || !isValidDevice(pullHeaderId) || pullDeviceId !== pullHeaderId) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
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
      if (failTrust()) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      if (limit <= 0) limit = SYNC_MAX_OPERATIONS_PER_PULL
      if (limit > SYNC_MAX_OPERATIONS_PER_PULL) limit = SYNC_MAX_OPERATIONS_PER_PULL
      // F-002 parity with the reference relay: the pull page is computed
      // BEFORE the bootstrap write so a read failure never leaves
      // enrolled-without-credential trust; post-bootstrap response
      // construction carries the credential on its error path. Pre-bootstrap
      // semantic validation (shared strict + payload limit) rejects a
      // legal-JSON but protocol-illegal page with no bootstrap or credential.
      const page = ops.filter((o) => o.seq > cursor).slice(0, limit)
      let pullIssuedAuth: string | undefined
      if (trusted.size === 0) {
        for (const op of page) {
          const semanticsErr = validateSyncOperationStrict(op as any)
          if (semanticsErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                error: `invalid operation ${String((op as any)?.id ?? '')}: ${semanticsErr}`.slice(0, 500)
              })
            )
            return
          }
          const payload = (op as StoredOperation).payload
          if (payload !== undefined && payload !== null) {
            const payloadStr = JSON.stringify(payload)
            if (Buffer.byteLength(payloadStr, 'utf8') > SYNC_MAX_SERIALIZED_PAYLOAD_BYTES) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  error: `invalid operation ${String((op as any)?.id ?? '')}: payload too large`.slice(0, 500)
                })
              )
              return
            }
          }
        }
        try {
          pullIssuedAuth = ensureBootstrap(pullDeviceId, 'bootstrap-sync')
        } catch (e) {
          if ((e as Error)?.message === 'trust-already-initialized') {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          }
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        if (!pullIssuedAuth) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
      } else if (!isValidAuth(pullHeaderAuth) || !verifyAndMark(pullHeaderId, pullHeaderAuth)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      trackInFlight(res)
      const returnedCursor = page.length > 0 ? page[page.length - 1].seq : cursor
      let respStr: string
      try {
        const respObj = pullIssuedAuth
          ? { operations: page, cursor: returnedCursor, deviceAuth: pullIssuedAuth }
          : { operations: page, cursor: returnedCursor }
        respStr = JSON.stringify(respObj)
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            pullIssuedAuth
              ? { error: 'trust-store-unavailable', deviceAuth: pullIssuedAuth }
              : { error: 'trust-store-unavailable' }
          )
        )
        return
      }
      if (Buffer.byteLength(respStr, 'utf8') > SYNC_MAX_PAYLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            pullIssuedAuth ? { error: 'payload too large', deviceAuth: pullIssuedAuth } : { error: 'payload too large' }
          )
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(respStr)
      return
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/invite') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        sweep()
        if (failTrust()) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const inviterId: unknown = body.deviceId
        if (!isValidDevice(inviterId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device id invalid' }))
          return
        }
        const inviteHeaderId = readHeader(req, 'x-sync-device-id')
        const inviteHeaderAuth = readHeader(req, 'x-sync-device-auth')
        let inviteIssuedAuth: string | undefined
        if (trusted.size === 0) {
          if (inviteHeaderId !== '' && inviteHeaderId !== inviterId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device id mismatch' }))
            return
          }
          try {
            inviteIssuedAuth = ensureBootstrap(inviterId, 'bootstrap-invite')
          } catch (e) {
            if ((e as Error)?.message === 'trust-already-initialized') {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'device-not-trusted' }))
              return
            }
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
            return
          }
          if (!inviteIssuedAuth) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
            return
          }
        } else {
          if (!isValidDevice(inviteHeaderId) || inviteHeaderId !== inviterId) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          }
          if (!isValidAuth(inviteHeaderAuth) || !verifyAndMark(inviteHeaderId, inviteHeaderAuth)) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          }
        }
        const code = genCode()
        const now = new Date()
        invites.set(code, {
          code,
          inviterDeviceId: inviterId,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString()
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            inviteIssuedAuth
              ? { code, expiresAt: invites.get(code)!.expiresAt, deviceAuth: inviteIssuedAuth }
              : { code, expiresAt: invites.get(code)!.expiresAt }
          )
        )
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/request') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        sweep()
        if (failTrust()) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const deviceId: unknown = body.deviceId
        const deviceName: unknown = body.deviceName
        const rawCode: unknown = body.code
        if (!isValidDevice(deviceId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device id invalid' }))
          return
        }
        if (typeof rawCode !== 'string' || validatePairingCode(rawCode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'pairing code invalid' }))
          return
        }
        const code = normalizePairingCode(rawCode)
        const invite = invites.get(code)
        if (!invite) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invite not found' }))
          return
        }
        if (new Date(invite.expiresAt).getTime() < Date.now()) {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invite expired' }))
          return
        }
        if (trusted.has(deviceId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device already trusted' }))
          return
        }
        for (const r of requests.values()) {
          if (r.deviceId === deviceId && r.code === code && r.status === 'pending') {
            const replaySecret = genDeviceAuth()
            r.deviceSecretHash = hashAuth(replaySecret)
            rememberIssued(deviceId as string, replaySecret)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ requestId: r.id, status: r.status, deviceAuth: replaySecret }))
            return
          }
        }
        const now = new Date()
        const id = randomUUID()
        const pendingSecret = genDeviceAuth()
        rememberIssued(deviceId as string, pendingSecret)
        requests.set(id, {
          id,
          deviceId,
          deviceName: typeof deviceName === 'string' ? deviceName.slice(0, 64) : undefined,
          code,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
          status: 'pending',
          deviceSecretHash: hashAuth(pendingSecret)
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ requestId: id, status: 'pending', deviceAuth: pendingSecret }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/sync/pair/pending') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      sweep()
      if (failTrust()) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      const caller = url.searchParams.get('deviceId') ?? ''
      const pendingHeaderId = readHeader(req, 'x-sync-device-id')
      const pendingHeaderAuth = readHeader(req, 'x-sync-device-auth')
      if (!isValidDevice(caller) || pendingHeaderId !== caller) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      if (!isValidAuth(pendingHeaderAuth) || !verifyAndMark(caller, pendingHeaderAuth)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ requests: [...requests.values()].filter((r) => r.status === 'pending') }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/accept') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        sweep()
        if (failTrust()) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const approver: unknown = body.approverDeviceId
        const requestId: unknown = body.requestId
        if (!isValidDevice(approver)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        const acceptHeaderId = readHeader(req, 'x-sync-device-id')
        const acceptHeaderAuth = readHeader(req, 'x-sync-device-auth')
        if (
          acceptHeaderId !== approver ||
          !isValidAuth(acceptHeaderAuth) ||
          !verifyAndMark(acceptHeaderId, acceptHeaderAuth)
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        if (typeof requestId !== 'string' || requestId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request id invalid' }))
          return
        }
        const row = requests.get(requestId)
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request not found' }))
          return
        }
        if (row.status !== 'pending') {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `request ${row.status}` }))
          return
        }
        if (!row.deviceSecretHash) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const nowIso = new Date().toISOString()
        const existingHash = deviceSecretHash.get(row.deviceId)
        if (existingHash && !secretEquals(existingHash, row.deviceSecretHash)) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        trusted.set(row.deviceId, {
          deviceId: row.deviceId,
          deviceName: row.deviceName,
          trustedAt: nowIso,
          source: 'pairing-accept'
        })
        deviceSecretHash.set(row.deviceId, row.deviceSecretHash)
        row.status = 'accepted'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ trusted: trusted.get(row.deviceId) }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/reject') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        sweep()
        if (failTrust()) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const approver: unknown = body.approverDeviceId
        const requestId: unknown = body.requestId
        if (!isValidDevice(approver)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        const rejectHeaderId = readHeader(req, 'x-sync-device-id')
        const rejectHeaderAuth = readHeader(req, 'x-sync-device-auth')
        if (
          rejectHeaderId !== approver ||
          !isValidAuth(rejectHeaderAuth) ||
          !verifyAndMark(rejectHeaderId, rejectHeaderAuth)
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        if (typeof requestId !== 'string' || requestId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request id invalid' }))
          return
        }
        const row = requests.get(requestId)
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request not found' }))
          return
        }
        if (row.status !== 'pending') {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `request ${row.status}` }))
          return
        }
        row.status = 'rejected'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/sync/pair/trusted') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const caller = url.searchParams.get('deviceId') ?? ''
      const trustedHeaderId = readHeader(req, 'x-sync-device-id')
      const trustedHeaderAuth = readHeader(req, 'x-sync-device-auth')
      if (!isValidDevice(caller) || trustedHeaderId !== caller) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      if (failTrust()) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      if (!isValidAuth(trustedHeaderAuth) || !verifyAndMark(caller, trustedHeaderAuth)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ devices: [...trusted.values()] }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/sync/pair/status') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      sweep()
      const caller = url.searchParams.get('deviceId') ?? ''
      if (!isValidDevice(caller)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device id invalid' }))
        return
      }
      if (failTrust()) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      const pending = [...requests.values()].some((r) => r.deviceId === caller && r.status === 'pending')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ trusted: trusted.has(caller), pending }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/revoke') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const approver: unknown = body.approverDeviceId
        const target: unknown = body.targetDeviceId
        if (!isValidDevice(approver)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        const revokeHeaderId = readHeader(req, 'x-sync-device-id')
        const revokeHeaderAuth = readHeader(req, 'x-sync-device-auth')
        if (failTrust()) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        if (
          revokeHeaderId !== approver ||
          !isValidAuth(revokeHeaderAuth) ||
          !verifyAndMark(revokeHeaderId, revokeHeaderAuth)
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        if (!isValidDevice(target)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device id invalid' }))
          return
        }
        if ((approver as string) === (target as string)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'cannot revoke own device' }))
          return
        }
        if (!trusted.has(target as string)) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device not trusted' }))
          return
        }
        trusted.delete(target as string)
        deviceSecretHash.delete(target as string)
        provenDevices.delete(target as string)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
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
        setTrustStoreFailure: (fail: boolean) => {
          trustStoreFailure = fail === true
        },
        isTrustStoreFailure: () => trustStoreFailure,
        getIssuedDeviceAuthForTests: (deviceId: string) => issuedPlaintext.get(deviceId),
        listTrustedDeviceIdsForTests: () => [...trusted.keys()],
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
