/**
 * Test-owned in-memory reference relay for sync E2E (SYNC-CC-* protocol).
 *
 * Per-spec, in-process, loopback-bound to an ephemeral port, token-protected,
 * fully closed/cleaned in teardown. Mirrors the transport contract of
 * scripts/sync-relay/server.ts (auth, limits, registration, channel pairing,
 * per-channel push/pull framing) WITHOUT loading better-sqlite3 in the
 * Playwright runner process — the runner must stay ABI-neutral (the native
 * binding belongs to the Electron lane; E2E SQLite access goes through the
 * Electron binary only).
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
  /** Total stored operations across channels (diagnostic only). */
  getOperationCount: () => number
  /**
   * Highest per-channel sequence observed across channels (diagnostic
   * only; single-channel tests equal that channel's cursor).
   */
  getCursor: () => number
  /**
   * Test-only registration/pairing observers (never over HTTP): device codes
   * are public by design; secrets are never exposed here.
   */
  listDeviceCodesForTests: () => string[]
  getChannelOfForTests: (deviceCode: string) => string | null
  listPairRequestsForTests: () => Array<{ id: string; requester: string; target: string; status: string }>
  /**
   * Number of push/pull requests currently admitted and executing.
   * Long-lived SSE subscriptions are never counted. Snapshot counters only
   * after {@link waitForQuiescent} so an already-admitted request cannot
   * commit after the snapshot.
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
  // Registration / channel / pairing state (in-memory mirror of the
  // reference relay). Secrets are stored hashed; plaintext is never retained.
  const devices = new Map<string, { secretHash: string; clientDeviceId?: string }>()
  const channels = new Map<string, { dissolved: boolean }>()
  const memberships = new Map<string, string>()
  const requests = new Map<
    string,
    { id: string; requester: string; target: string; status: string; createdAt: string }
  >()
  // Per-channel operation logs with contiguous per-channel sequences.
  const channelOps = new Map<string, StoredOperation[]>()
  const channelByOpId = new Map<string, Map<string, StoredOperation>>()
  let paused = false
  let pushPaused = false
  let pullPaused = false
  const DEVICE_SECRET_PATTERN = /^[0-9a-fA-F]{64}$/
  const isValidSecret = (v: unknown): v is string => typeof v === 'string' && DEVICE_SECRET_PATTERN.test(v)
  const genSecret = (): string => randomBytes(32).toString('hex')
  const hashSecret = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
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
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const genCode = (): string => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const bytes = randomBytes(8)
      let out = ''
      for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
      if (!devices.has(out)) return out
    }
    throw new Error('store-unavailable')
  }
  const isValidDevice = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= 256 && v.trim().length > 0
  const isValidCode = (v: unknown): v is string => typeof v === 'string' && validatePairingCode(v) === null
  // Returns the verified device code, or sends the HTTP error and returns null.
  const requireAuth = (req: IncomingMessage, res: ServerResponse): string | null => {
    const code = readHeader(req, 'x-sync-device-code')
    const secret = readHeader(req, 'x-sync-device-secret')
    if (!isValidCode(code) || !isValidSecret(secret)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid-credential' }))
      return null
    }
    const normalized = normalizePairingCode(code)
    const row = devices.get(normalized)
    if (!row) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown-credential' }))
      return null
    }
    if (!secretEquals(hashSecret(secret), row.secretHash)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid-credential' }))
      return null
    }
    return normalized
  }
  const outgoingOf = (code: string): { id: string; target: string; createdAt: string } | null => {
    for (const r of requests.values()) {
      if (r.requester === code && r.status === 'pending') return { id: r.id, target: r.target, createdAt: r.createdAt }
    }
    return null
  }
  const incomingOf = (code: string): Array<{ id: string; requester: string; createdAt: string }> => {
    return [...requests.values()]
      .filter((r) => r.target === code && r.status === 'pending')
      .map((r) => ({ id: r.id, requester: r.requester, createdAt: r.createdAt }))
  }
  // Admitted push/pull requests still executing. Tracked so tests can wait
  // for quiescence before snapshotting counters; otherwise an
  // already-admitted request could commit after the snapshot and race the
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
  // Notification-only SSE subscribers bound to one device + channel each:
  // cursor hint only, never operations. One channel's hints never reach
  // another channel. Mirrors the production relay binding so departed
  // devices never keep their old channel's stream.
  const sseClients = new Map<ServerResponse, { channelId: string; deviceCode: string }>()
  const broadcastSyncHint = (channelId: string, cursor: number): void => {
    const line = `event: sync\ndata: ${JSON.stringify({ cursor })}\n\n`
    for (const [client, bound] of [...sseClients]) {
      if (bound.channelId !== channelId) continue
      try {
        client.write(line)
      } catch {
        try {
          sseClients.delete(client)
        } catch {}
      }
    }
  }
  /**
   * Close every open subscriber bound to the given channel whose device is
   * no longer a member of it (membership left or dissolved). Survivors of a
   * non-dissolved channel keep their streams. Mirrors production semantics.
   */
  const closeDissolvedChannelSubscribers = (channelId: string, dissolvedCodes: Set<string>): void => {
    for (const [client, bound] of [...sseClients]) {
      if (bound.channelId !== channelId) continue
      if (!dissolvedCodes.has(bound.deviceCode)) continue
      sseClients.delete(client)
      try {
        client.end()
      } catch {}
    }
  }
  const heartbeat = setInterval(() => {
    for (const client of [...sseClients.keys()]) {
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Sync-Device-Code,X-Sync-Device-Secret')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/sync/register') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawCode: unknown = body.deviceCode
        const rawSecret: unknown = body.deviceSecret
        if (rawCode === undefined && rawSecret === undefined) {
          const rawClientId: unknown = body.deviceId
          if (rawClientId !== undefined && !isValidDevice(rawClientId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device id invalid' }))
            return
          }
          let code = ''
          try {
            code = genCode()
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'store-unavailable' }))
            return
          }
          const secret = genSecret()
          devices.set(code, {
            secretHash: hashSecret(secret),
            clientDeviceId: typeof rawClientId === 'string' ? rawClientId : undefined
          })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ deviceCode: code, deviceSecret: secret }))
          return
        }
        if (!isValidCode(rawCode) || !isValidSecret(rawSecret)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid-credential' }))
          return
        }
        const code = normalizePairingCode(rawCode as string)
        const row = devices.get(code)
        if (!row) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown-credential' }))
          return
        }
        if (!secretEquals(hashSecret(rawSecret as string), row.secretHash)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid-credential' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ deviceCode: code }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/sync/state') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const caller = requireAuth(req, res)
      if (!caller) return
      const channel = memberships.get(caller) ?? null
      const outgoing = outgoingOf(caller)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          deviceCode: caller,
          paired: channel !== null,
          channelId: channel,
          outgoing: outgoing ? { id: outgoing.id, targetCode: outgoing.target, createdAt: outgoing.createdAt } : null,
          incoming: incomingOf(caller).map((r) => ({
            id: r.id,
            requesterCode: r.requester,
            createdAt: r.createdAt
          }))
        })
      )
      return
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/request') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const caller = requireAuth(req, res)
      if (!caller) return
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawTarget: unknown = body.targetCode
        if (typeof rawTarget !== 'string' || validatePairingCode(rawTarget)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-code-invalid' }))
          return
        }
        const target = normalizePairingCode(rawTarget)
        if (target === caller) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'cannot-pair-with-self' }))
          return
        }
        if (!devices.has(target)) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown-device' }))
          return
        }
        if (memberships.has(caller)) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'pairing-already-paired' }))
          return
        }
        const existing = outgoingOf(caller)
        if (existing && existing.target === target) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ requestId: existing.id, status: 'pending' }))
          return
        }
        // Single-outgoing-pending invariant (mirrors the file-backed relay
        // partial unique index): the read/replace/insert below runs
        // synchronously with no interleaving await, and the trailing guard
        // fails closed if two pendings ever exist for one requester.
        if (existing) {
          const old = requests.get(existing.id)
          if (old && old.status === 'pending') old.status = 'replaced'
        }
        const id = randomUUID()
        requests.set(id, { id, requester: caller, target, status: 'pending', createdAt: new Date().toISOString() })
        const pendings = [...requests.values()].filter((r) => r.requester === caller && r.status === 'pending')
        if (pendings.length !== 1) {
          requests.delete(id)
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'concurrent-request' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ requestId: id, status: 'pending' }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/cancel') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const caller = requireAuth(req, res)
      if (!caller) return
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawId: unknown = body.requestId
        let row: { id: string } | null = null
        if (typeof rawId === 'string' && rawId.length > 0) {
          const found = requests.get(rawId)
          if (found && found.requester === caller && found.status === 'pending') row = { id: found.id }
          else if (found && found.requester === caller && found.status !== 'pending') {
            res.writeHead(410, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `request-${found.status}` }))
            return
          }
        } else {
          row = outgoingOf(caller)
        }
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no-pending-request' }))
          return
        }
        // Atomic CAS: only pending moves to cancelled; an already terminal
        // row keeps its state and surfaces as 410 above.
        const target = requests.get(row.id)
        if (!target || target.status !== 'pending') {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `request-${target?.status ?? 'unknown'}` }))
          return
        }
        target.status = 'cancelled'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, requestId: row.id }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/accept') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const caller = requireAuth(req, res)
      if (!caller) return
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawId: unknown = body.requestId
        if (typeof rawId !== 'string' || rawId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request id invalid' }))
          return
        }
        const row = requests.get(rawId)
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-not-found' }))
          return
        }
        if (row.target !== caller) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not-request-target' }))
          return
        }
        if (row.status !== 'pending') {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `request-${row.status}` }))
          return
        }
        if (memberships.has(row.requester)) {
          // Late-accept parity with the file-backed relay: the requester
          // paired since the request, so settle the pending row as
          // rejected-equivalent terminal without membership (no merge).
          // CAS: only a still-pending row moves; an already-settled row
          // keeps its terminal state.
          if (row.status === 'pending') row.status = 'rejected'
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'requester-already-paired' }))
          return
        }
        // CAS terminal guard with membership in one synchronous block: a
        // concurrently settled row never creates membership and an accepted
        // row is never overwritten by a later terminal transition.
        if (row.status !== 'pending') {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `request-${row.status}` }))
          return
        }
        const targetChannel = memberships.get(caller) ?? null
        let channelId: string
        if (targetChannel !== null) {
          channelId = targetChannel
          memberships.set(row.requester, channelId)
        } else {
          channelId = randomUUID()
          channels.set(channelId, { dissolved: false })
          memberships.set(row.requester, channelId)
          memberships.set(caller, channelId)
          channelOps.set(channelId, [])
          channelByOpId.set(channelId, new Map())
        }
        row.status = 'accepted'
        // Stale-intent cleanup parity with production: both devices are paired
        // as of this commit, so any other pending outgoing of either device
        // must never revive after a later unpair. Terminal state is
        // 'replaced', consistent with the request-replacement path.
        for (const r of requests.values()) {
          if (r.id === row.id) continue
          if (r.status !== 'pending') continue
          if (r.requester === row.requester || r.requester === caller) r.status = 'replaced'
        }
        // Close stale subscribers of both newly-paired devices still bound to
        // a previous channel so the old stream never receives hints again.
        try {
          const settled: string = channelId
          for (const [client, bound] of [...sseClients]) {
            if (bound.channelId === settled) continue
            if (bound.deviceCode !== row.requester && bound.deviceCode !== caller) continue
            sseClients.delete(client)
            try {
              client.end()
            } catch {}
          }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, channelId }))
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
      const caller = requireAuth(req, res)
      if (!caller) return
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawId: unknown = body.requestId
        if (typeof rawId !== 'string' || rawId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request id invalid' }))
          return
        }
        const row = requests.get(rawId)
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-not-found' }))
          return
        }
        if (row.target !== caller) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not-request-target' }))
          return
        }
        if (row.status !== 'pending') {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `request-${row.status}` }))
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

    if (req.method === 'POST' && url.pathname === '/sync/pair/unpair') {
      if (!checkAuth(req, token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const caller = requireAuth(req, res)
      if (!caller) return
      const channel = memberships.get(caller) ?? null
      if (!channel) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not-paired' }))
        return
      }
      // Capture the full member set before mutation so the dissolve path can
      // close every affected subscriber precisely (production parity).
      const membersBefore: string[] = []
      for (const [code, ch] of memberships) {
        if (ch === channel) membersBefore.push(code)
      }
      memberships.delete(caller)
      let remaining = 0
      for (const ch of memberships.values()) {
        if (ch === channel) remaining += 1
      }
      let dissolvedCodes: string[] = []
      if (remaining < 2) {
        for (const [code, ch] of [...memberships]) {
          if (ch === channel) memberships.delete(code)
        }
        channels.set(channel, { dissolved: true })
        dissolvedCodes = membersBefore
      }
      // Membership changed atomically above: the caller always left its
      // channel, and on dissolve every former member left it. Close exactly
      // those stale subscribers; survivors of a non-dissolved channel keep
      // their streams.
      try {
        const departed = dissolvedCodes.length > 0 ? new Set(dissolvedCodes) : new Set([caller])
        closeDissolvedChannelSubscribers(channel, departed)
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
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
        const caller = requireAuth(req, res)
        if (!caller) return
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
        const channel = memberships.get(caller) ?? null
        if (!channel) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'pairing-required' }))
          return
        }
        // Operation identity binding parity with production: the push body
        // device id (which every operation already equals) must equal the
        // authenticated registration's client device id. A forged device id
        // fails closed with 403; the code/secret are never echoed.
        const registeredClientId = devices.get(caller)?.clientDeviceId ?? null
        if (registeredClientId !== null && pushDeviceId !== registeredClientId) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device identity mismatch' }))
          return
        }
        // Transactional parity with the reference relay: validate and stage
        // the full batch before committing any state, so a rejected batch
        // leaves no partial ops/sequence behind.
        const ops = channelOps.get(channel) ?? []
        const byId = channelByOpId.get(channel) ?? new Map()
        const acceptedIds: string[] = []
        const staged: StoredOperation[] = []
        const stagedById = new Map<string, StoredOperation>()
        let stagedSeq = ops.length > 0 ? ops[ops.length - 1].seq : 0
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
        for (const st of staged) {
          ops.push(st)
          byId.set(st.id, st)
        }
        channelOps.set(channel, ops)
        channelByOpId.set(channel, byId)
        const cursor = ops.length > 0 ? ops[ops.length - 1].seq : 0
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ acceptedIds, cursor, channelId: channel }))
        // Notify only after successful push commit; cursor hint only,
        // scoped to this channel's subscribers.
        if (acceptedIds.length > 0) broadcastSyncHint(channel, cursor)
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
      const caller = requireAuth(req, res)
      if (!caller) return
      const pullDeviceId = url.searchParams.get('deviceId') ?? ''
      if (!isValidDevice(pullDeviceId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device id invalid' }))
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
      const channel = memberships.get(caller) ?? null
      if (!channel) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'pairing-required' }))
        return
      }
      trackInFlight(res)
      const ops = channelOps.get(channel) ?? []
      const page = ops.filter((o) => o.seq > cursor).slice(0, limit)
      const returnedCursor = page.length > 0 ? page[page.length - 1].seq : cursor
      let respStr: string
      try {
        respStr = JSON.stringify({ operations: page, cursor: returnedCursor, channelId: channel })
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'store-unavailable' }))
        return
      }
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
      const caller = requireAuth(req, res)
      if (!caller) return
      const channel = memberships.get(caller) ?? null
      if (!channel) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'pairing-required' }))
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
      sseClients.set(res, { channelId: channel, deviceCode: caller })
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
        getOperationCount: () => {
          let n = 0
          for (const ops of channelOps.values()) n += ops.length
          return n
        },
        getCursor: () => {
          let max = 0
          for (const ops of channelOps.values()) {
            if (ops.length > 0) max = Math.max(max, ops[ops.length - 1].seq)
          }
          return max
        },
        listDeviceCodesForTests: () => [...devices.keys()],
        getChannelOfForTests: (deviceCode: string) => memberships.get(deviceCode) ?? null,
        listPairRequestsForTests: () =>
          [...requests.values()].map((r) => ({ id: r.id, requester: r.requester, target: r.target, status: r.status })),
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
            for (const client of [...sseClients.keys()]) {
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

/**
 * Test-only provisioning helper (never production code): registers `count`
 * devices on the relay and pairs them all into ONE hidden channel (devices
 * 1..n request device 0, which accepts). Returns the public codes plus the
 * durable secrets (test-process memory only, never logged).
 */
export interface ProvisionedDevice {
  code: string
  secret: string
}

export function provisionedHeaders(dev: ProvisionedDevice): Record<string, string> {
  return { 'x-sync-device-code': dev.code, 'x-sync-device-secret': dev.secret }
}

export async function provisionPairedDevices(endpoint: string, token: string, count = 2): Promise<ProvisionedDevice[]> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('provisionPairedDevices requires count >= 1')
  const base = endpoint.replace(/\/$/, '')
  const authedJson = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const devices: ProvisionedDevice[] = []
  for (let i = 0; i < count; i++) {
    // Intentionally registers without a client device id (null binding) so
    // generic push/pull tests can use any well-formed body deviceId (e.g.
    // 'd1') on both relays. Identity-binding semantics are covered
    // explicitly by the shared conformance with bound registrations.
    const res = await fetch(`${base}/sync/register`, {
      method: 'POST',
      headers: authedJson,
      body: JSON.stringify({})
    })
    if (res.status !== 200) throw new Error(`provision register ${i} failed: ${res.status}`)
    const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
    if (typeof body.deviceCode !== 'string' || typeof body.deviceSecret !== 'string') {
      throw new Error('provision register response malformed')
    }
    devices.push({ code: body.deviceCode, secret: body.deviceSecret })
  }
  for (let i = 1; i < devices.length; i++) {
    const req = await fetch(`${base}/sync/pair/request`, {
      method: 'POST',
      headers: { ...authedJson, ...provisionedHeaders(devices[i]) },
      body: JSON.stringify({ targetCode: devices[0].code })
    })
    if (req.status !== 200) throw new Error(`provision request ${i} failed: ${req.status}`)
    const reqBody = (await req.json()) as { requestId: string }
    const accept = await fetch(`${base}/sync/pair/accept`, {
      method: 'POST',
      headers: { ...authedJson, ...provisionedHeaders(devices[0]) },
      body: JSON.stringify({ requestId: reqBody.requestId })
    })
    if (accept.status !== 200) throw new Error(`provision accept ${i} failed: ${accept.status}`)
  }
  return devices
}
