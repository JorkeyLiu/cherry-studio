/**
 * Reference HTTP relay for sync MVP — isolated non-production path.
 * Minimal persistent operation log with endpoint handlers.
 * Must NOT be imported by production app code.
 * Runnable via:  npx tsx scripts/sync-relay/server.ts [--port 3000] [--db /tmp/sync-relay.db] [--token secret]
 * LAN HTTPS via: npx tsx scripts/sync-relay/server.ts --host <LAN-IP> --cert <cert.pem> --key <key.pem> [--port ...] [--db ...] [--token ...]
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { createSecureContext } from 'node:tls'

import { formatRelayHostForUrl, normalizeRelayBindHost } from './relayHost'

export { formatRelayHostForUrl, normalizeRelayBindHost } from './relayHost'

import Database from 'better-sqlite3'

import {
  normalizePairingCode as normalizePairingCodeShared,
  validatePairingCode as validatePairingCodeShared
} from '../../packages/shared/sync/pairing'
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
  /** If set, the relay terminates native TLS with this cert/key pair. */
  tls?: { cert: string | Buffer; key: string | Buffer }
}

export const RELAY_LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'] as const

export function isLoopbackHost(host: string): boolean {
  return (RELAY_LOOPBACK_HOSTS as readonly string[]).includes(host)
}

/**
 * True when the host carries a zone suffix (`%eth0`, inside or outside
 * brackets). Zone-scoped literals have platform-dependent `listen`/TLS
 * behavior, so non-loopback relay binds reject them explicitly instead of
 * producing an ambiguous URL.
 */
export function hasZoneSuffix(host: string): boolean {
  const n = host.trim()
  if (n.startsWith('[')) {
    const close = n.indexOf(']')
    if (close !== -1) {
      if (n.slice(1, close).includes('%')) return true
      return n.slice(close + 1).startsWith('%')
    }
  }
  return n.includes('%')
}

/**
 * True for wildcard/all-interface bind forms (LOCK-002 forbids them for
 * non-loopback HTTPS). Covers `0.0.0.0`, `::`, equivalent all-zero IPv6
 * forms (`0:0:0:0:0:0:0:0`, `0::`, `::0`, `0::0`, bracketed `[::]`), the
 * IPv4-mapped unspecified forms Node binds as `::` (`::ffff:0.0.0.0` and its
 * compressed/expanded/hex/case variants such as `0:0:0:0:0:ffff:0.0.0.0`,
 * `::ffff:0:0`, `0:0:0:0:0:ffff:0:0`, `[::ffff:0.0.0.0]`), the deprecated
 * IPv4-compatible unspecified form (`::0.0.0.0`), and the bare `*` form.
 * Zone-suffixed representations (`::%eth0`, `::ffff:0.0.0.0%eth0`) are
 * stripped before the check so Node-wildcard zone forms also fail.
 * Fail-closed: any all-zero IPv6 literal or mapped-unspecified literal is
 * wildcard. Detection is stdlib-based (`net.isIP` + deterministic hextet
 * expansion); the legacy all-zero heuristic is kept as a fallback OR.
 */
export function isWildcardHost(host: string): boolean {
  let n = host.trim().toLowerCase()
  if (n.startsWith('[')) {
    const close = n.indexOf(']')
    if (close !== -1) {
      // Bracketed literal: zone may sit inside (`[::%eth0]`, RFC 6874) or
      // trailing outside (`[::]%eth0`); both strip to the bare address.
      let inner = n.slice(1, close)
      const pctIn = inner.indexOf('%')
      if (pctIn !== -1) inner = inner.slice(0, pctIn)
      n = inner
    } else {
      if (n.startsWith('[') && n.endsWith(']')) n = n.slice(1, -1)
      const pct = n.indexOf('%')
      if (pct !== -1) n = n.slice(0, pct)
    }
  } else {
    const pct = n.indexOf('%')
    if (pct !== -1) n = n.slice(0, pct)
  }
  if (n === '*' || n === '0.0.0.0' || n === '::') return true
  if (n.includes(':')) {
    const expanded = expandIpv6Hextets(n)
    if (expanded) {
      const allZero = expanded.every((g) => g === 0)
      if (allZero) return true
      // IPv4-mapped unspecified: ::ffff:0.0.0.0 in any compressed/expanded/
      // hex/case form (first five groups 0, sixth 0xffff, last two 0).
      if (
        expanded[0] === 0 &&
        expanded[1] === 0 &&
        expanded[2] === 0 &&
        expanded[3] === 0 &&
        expanded[4] === 0 &&
        expanded[5] === 0xffff &&
        expanded[6] === 0 &&
        expanded[7] === 0
      ) {
        return true
      }
      return false
    }
    const withoutZeroColonDot = n.replace(/[:0.]/g, '')
    if (withoutZeroColonDot === '') return true
  }
  return false
}

/**
 * Deterministically expand an IPv6 literal (already lowercased, brackets and
 * zone stripped) to eight 16-bit groups. Handles embedded IPv4 dotted tails
 * (`::ffff:0.0.0.0`, `::0.0.0.0`). Returns null when the literal does not
 * parse as IPv6.
 */
function expandIpv6Hextets(addr: string): number[] | null {
  const parseHextet = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    return parseInt(part, 16)
  }
  const parseIpv4Tail = (tail: string): [number, number] | null => {
    const octets = tail.split('.')
    if (octets.length !== 4) return null
    const bytes: number[] = []
    for (const o of octets) {
      if (!/^[0-9]{1,3}$/.test(o)) return null
      const v = Number(o)
      if (!Number.isSafeInteger(v) || v < 0 || v > 255) return null
      bytes.push(v)
    }
    return [bytes[0] * 256 + bytes[1], bytes[2] * 256 + bytes[3]]
  }
  const expandHead = (head: string, slots: number): number[] | null => {
    if (head === '') return new Array(slots).fill(0)
    if (head.includes('::')) {
      const parts = head.split('::')
      if (parts.length !== 2) return null
      const left = parts[0] === '' ? [] : parts[0].split(':')
      const right = parts[1] === '' ? [] : parts[1].split(':')
      const leftVals: number[] = []
      for (const p of left) {
        const v = parseHextet(p)
        if (v === null) return null
        leftVals.push(v)
      }
      const rightVals: number[] = []
      for (const p of right) {
        const v = parseHextet(p)
        if (v === null) return null
        rightVals.push(v)
      }
      if (leftVals.length + rightVals.length > slots) return null
      const zeros = new Array(slots - leftVals.length - rightVals.length).fill(0)
      return [...leftVals, ...zeros, ...rightVals]
    }
    const pieces = head.split(':')
    if (pieces.length !== slots) return null
    const vals: number[] = []
    for (const p of pieces) {
      const v = parseHextet(p)
      if (v === null) return null
      vals.push(v)
    }
    return vals
  }
  if (isIP(addr) !== 6) return null
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    if (lastColon === -1) return null
    const head = addr.slice(0, lastColon)
    const tail = addr.slice(lastColon + 1)
    const tailGroups = parseIpv4Tail(tail)
    if (!tailGroups) return null
    const headGroups = expandHead(head, 6)
    if (!headGroups) return null
    return [...headGroups, ...tailGroups]
  }
  return expandHead(addr, 8)
}

/**
 * True only for explicit numeric IP literals (IPv4 or IPv6). Non-loopback
 * relay binds require this (LOCK-002 single secure topology): hostnames are
 * never accepted for non-loopback binds.
 */
export function isNumericIpHost(host: string): boolean {
  let n = host.trim()
  if (n.startsWith('[') && n.endsWith(']')) n = n.slice(1, -1)
  const pct = n.indexOf('%')
  if (pct !== -1) n = n.slice(0, pct)
  return isIP(n) !== 0
}

export const RELAY_HELP_TEXT = [
  'Cherry Chat personal sync relay (reference implementation).',
  '',
  'Usage:',
  '  pnpm sync:relay -- --port <port> --db <path> --token <token>',
  '  pnpm sync:relay -- --host <LAN-IP> --port <port> --db <path> --token <token> --cert <cert.pem> --key <key.pem>',
  '  pnpm sync:relay -- --help',
  '',
  'Options:',
  '  --port <port>    TCP port to bind (0 = ephemeral, otherwise 1-65535; default 3030)',
  '  --db <path>      SQLite file for relay state (persistent; never deleted on stop)',
  '  --token <token>  Bearer token (fallback: SYNC_RELAY_TOKEN env; required for the supported path)',
  '  --host <host>    Bind host: 127.0.0.1 or localhost for loopback HTTP (default 127.0.0.1);',
  '                     a non-loopback LAN address requires --cert and --key (native HTTPS)',
  '                     Non-loopback hosts must be an explicit numeric LAN IP;',
  '                     wildcard/all-interface binds (0.0.0.0, ::, equivalents, *) are forbidden.',
  '  --cert <path>    PEM certificate file for non-loopback HTTPS (required with --key)',
  '  --key <path>     PEM private-key file for non-loopback HTTPS (required with --cert)',
  '  --help, -h       Show this help and exit 0',
  '',
  'Notes:',
  '  - Loopback binds serve plain HTTP without cert/key; non-loopback hosts',
  '    require both --cert and --key and serve native HTTPS only.',
  '    Plaintext non-loopback HTTP is rejected (fail-closed).',
  '  - Non-loopback hosts must be an explicit numeric LAN IP address;',
  '    wildcard/all-interface binds (0.0.0.0, ::, equivalents, *) and',
  '    non-numeric hostnames are rejected before the DB is opened.',
  '  - Cert/key files are read before the DB is opened; missing, empty, or',
  '    mismatched cert/key aborts startup without creating the DB.',
  '  - SIGTERM/SIGINT shut down gracefully exactly once without deleting the DB.',
  '  - Same --db/--token (--cert/--key for LAN HTTPS) on restart retains relay state.'
].join('\n')

export interface RelayCliArgs {
  port: number
  dbPath: string
  host: string
  token?: string
  certPath?: string
  keyPath?: string
  help: boolean
}

export function parseRelayArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RelayCliArgs {
  let port = 3030
  let dbPath = resolve(process.cwd(), 'tmp-sync-relay.db')
  let host = '127.0.0.1'
  let token: string | undefined
  const envToken = env.SYNC_RELAY_TOKEN
  if (typeof envToken === 'string' && envToken.length > 0) token = envToken
  let certPath: string | undefined
  let keyPath: string | undefined
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (
      arg === '--port' ||
      arg === '--db' ||
      arg === '--token' ||
      arg === '--host' ||
      arg === '--cert' ||
      arg === '--key'
    ) {
      const raw = argv[i + 1]
      if (raw === undefined) {
        throw new Error(`missing value for ${arg} (expected a value)`)
      }
      if (arg === '--port') {
        const parsed = Number(raw)
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error(`invalid --port '${String(raw).slice(0, 32)}' (expected 0-65535)`)
        }
        port = parsed
        i++
        continue
      }
      if (arg === '--db') {
        if (typeof raw !== 'string' || raw.length === 0) throw new Error('invalid --db (expected a file path)')
        dbPath = resolve(raw)
        i++
        continue
      }
      if (arg === '--token') {
        token = raw
        i++
        continue
      }
      if (arg === '--cert') {
        if (typeof raw !== 'string' || raw.length === 0) throw new Error('invalid --cert (expected a file path)')
        certPath = resolve(raw)
        i++
        continue
      }
      if (arg === '--key') {
        if (typeof raw !== 'string' || raw.length === 0) throw new Error('invalid --key (expected a file path)')
        keyPath = resolve(raw)
        i++
        continue
      }
      // arg === '--host': loopback hosts normalize localhost to 127.0.0.1
      // so bind and readiness share one reachable IPv4 contract.
      // Non-loopback LAN hosts must be explicit numeric IP addresses that
      // are not unspecified/wildcard (LOCK-002); the cert/key requirement
      // is enforced in resolveRelayTls before the DB is opened. Plaintext
      // LAN binding is never permitted. Bracketed IPv6 literals (`[::1]`)
      // normalize to raw form (`::1`) for `server.listen()`; URL/readiness
      // serialization keeps brackets via formatRelayHostForUrl().
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > 253) {
        throw new Error('invalid --host (expected a hostname or IP address)')
      }
      if (isLoopbackHost(raw)) {
        host = raw === 'localhost' ? '127.0.0.1' : raw
      } else {
        if (isWildcardHost(raw)) {
          throw new Error(
            `invalid --host '${String(raw).slice(0, 64)}' (wildcard/all-interface binds are forbidden; use an explicit LAN IP address)`
          )
        }
        if (hasZoneSuffix(raw)) {
          throw new Error(
            `invalid --host '${String(raw).slice(0, 64)}' (zone-scoped IPv6 addresses are unsupported; use an unscoped explicit LAN IP address)`
          )
        }
        let normalized: string
        try {
          normalized = normalizeRelayBindHost(raw)
        } catch (e) {
          throw e instanceof Error ? e : new Error(String(e))
        }
        if (isLoopbackHost(normalized)) {
          host = normalized === 'localhost' ? '127.0.0.1' : normalized
        } else {
          if (isWildcardHost(normalized)) {
            throw new Error(
              `invalid --host '${String(raw).slice(0, 64)}' (wildcard/all-interface binds are forbidden; use an explicit LAN IP address)`
            )
          }
          if (hasZoneSuffix(normalized)) {
            throw new Error(
              `invalid --host '${String(raw).slice(0, 64)}' (zone-scoped IPv6 addresses are unsupported; use an unscoped explicit LAN IP address)`
            )
          }
          if (!isNumericIpHost(normalized)) {
            throw new Error(
              `invalid --host '${String(raw).slice(0, 64)}' (expected an explicit numeric LAN IP address for non-loopback binds)`
            )
          }
          host = normalized
        }
      }
      i++
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option '${String(arg).slice(0, 64)}'`)
    }
    throw new Error(`unknown option '${String(arg).slice(0, 64)}'`)
  }
  return { port, dbPath, host, token, certPath, keyPath, help }
}

export interface RelayTlsConfig {
  scheme: 'http' | 'https'
  cert?: Buffer
  key?: Buffer
}

/**
 * Resolve the transport for a parsed CLI host/cert/key triple. Fail-closed:
 * non-loopback hosts require both --cert and --key; cert/key files are read
 * here (before the DB is opened by the caller) and missing/empty/mismatched
 * material throws. Loopback hosts serve plain HTTP unless both --cert/--key
 * are given (loopback HTTPS opt-in); one without the other throws.
 */
export function resolveRelayTls(host: string, certPath?: string, keyPath?: string): RelayTlsConfig {
  const loopback = isLoopbackHost(host)
  if (!loopback) {
    if (isWildcardHost(host)) {
      throw new Error(
        `wildcard --host '${String(host).slice(0, 64)}' forbidden (bind an explicit LAN IP address; wildcard/all-interface binds are rejected)`
      )
    }
    if (hasZoneSuffix(host)) {
      throw new Error(
        `non-loopback --host '${String(host).slice(0, 64)}' with a zone suffix is unsupported (use an unscoped explicit LAN IP address)`
      )
    }
    if (!isNumericIpHost(host)) {
      throw new Error(`non-loopback --host '${String(host).slice(0, 64)}' must be an explicit numeric LAN IP address`)
    }
  }
  if (loopback && !certPath && !keyPath) return { scheme: 'http' }
  if (!certPath || !keyPath) {
    if (loopback) {
      throw new Error(`loopback --host with partial TLS config requires both --cert and --key`)
    }
    throw new Error(
      `non-loopback --host '${String(host).slice(0, 64)}' requires --cert and --key (native HTTPS required; plaintext LAN binding rejected)`
    )
  }
  let cert: Buffer
  let key: Buffer
  try {
    cert = readFileSync(certPath)
  } catch {
    throw new Error(`cannot read --cert file (expected a PEM certificate)`)
  }
  try {
    key = readFileSync(keyPath)
  } catch {
    throw new Error(`cannot read --key file (expected a PEM private key)`)
  }
  if (cert.length === 0) throw new Error('invalid --cert (file is empty)')
  if (key.length === 0) throw new Error('invalid --key (file is empty)')
  try {
    createSecureContext({ cert, key })
  } catch {
    throw new Error('mismatched certificate/key (TLS context creation failed)')
  }
  return { scheme: 'https', cert, key }
}

function parseArgs(): RelayCliArgs {
  return parseRelayArgs(process.argv.slice(2), process.env)
}

const SYNC_PAIRING_INVITE_TTL_MS = 15 * 60 * 1000
const SYNC_PAIRING_REQUEST_TTL_MS = 15 * 60 * 1000
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generatePairingCode(): string {
  const bytes = randomBytes(SYNC_PAIRING_CODE_LENGTH)
  let out = ''
  for (const b of bytes) out += PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]
  return out
}

const SYNC_PAIRING_CODE_LENGTH = 8

function isValidRelayDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim().length > 0
}

const RELAY_DEVICE_ID_HEADER = 'x-sync-device-id'
const RELAY_DEVICE_AUTH_HEADER = 'x-sync-device-auth'
const DEVICE_AUTH_PATTERN = /^[0-9a-fA-F]{64}$/

function isValidDeviceAuth(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_AUTH_PATTERN.test(value)
}

function generateDeviceAuth(): string {
  return randomBytes(32).toString('hex')
}

function hashDeviceAuth(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function secretEquals(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex')
    const b = Buffer.from(bHex, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function readDeviceHeader(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[0] ?? ''
  return ''
}

function ensureDeviceAuthColumns(db: Database.Database): void {
  const trustCols = db.prepare(`SELECT name FROM pragma_table_info('sync_trusted_devices')`).all() as Array<{
    name: string
  }>
  if (!trustCols.some((c) => c.name === 'device_secret_hash')) {
    db.exec(`ALTER TABLE sync_trusted_devices ADD COLUMN device_secret_hash TEXT`)
  }
  if (!trustCols.some((c) => c.name === 'auth_proven')) {
    db.exec(`ALTER TABLE sync_trusted_devices ADD COLUMN auth_proven INTEGER NOT NULL DEFAULT 0`)
  }
  const reqCols = db.prepare(`SELECT name FROM pragma_table_info('sync_pairing_requests')`).all() as Array<{
    name: string
  }>
  if (!reqCols.some((c) => c.name === 'device_secret_hash')) {
    db.exec(`ALTER TABLE sync_pairing_requests ADD COLUMN device_secret_hash TEXT`)
  }
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
    CREATE TABLE IF NOT EXISTS sync_trusted_devices (
      device_id TEXT PRIMARY KEY,
      device_name TEXT,
      trusted_at TEXT,
      source TEXT,
      device_secret_hash TEXT,
      auth_proven INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sync_pairing_invites (
      code TEXT PRIMARY KEY,
      inviter_device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sync_pairing_requests (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      device_name TEXT,
      code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      device_secret_hash TEXT
    );
  `)
  ensureDeviceAuthColumns(db)
  return db
}

function sweepExpiredPairing(db: Database.Database): void {
  try {
    const nowIso = new Date().toISOString()
    db.prepare(`UPDATE sync_pairing_requests SET status='expired' WHERE status='pending' AND expires_at < ?`).run(
      nowIso
    )
  } catch {}
}

/**
 * Throwing trust-store accessors (F-003): every read/write failure throws so
 * callers fail closed with 500 instead of treating the failure as an empty
 * trust set (founder bootstrap) or swallowing the write.
 */
function trustedCountOrThrow(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM sync_trusted_devices').get() as { n: number }
  return row?.n ?? 0
}

function isTrustedDeviceOrThrow(db: Database.Database, deviceId: string): boolean {
  const row = db.prepare('SELECT device_id FROM sync_trusted_devices WHERE device_id = ?').get(deviceId) as
    | { device_id: string }
    | undefined
  return !!row
}

function getTrustedSecretHashOrThrow(db: Database.Database, deviceId: string): string | null {
  const row = db.prepare('SELECT device_secret_hash FROM sync_trusted_devices WHERE device_id = ?').get(deviceId) as
    | { device_secret_hash: string | null }
    | undefined
  if (!row) return null
  return row.device_secret_hash ?? null
}

/**
 * Verify (deviceId, secret) against the stored hash. Returns true only when
 * the device row exists, carries a stored hash (legacy rows without a hash
 * never verify — re-pair required), and the secret matches. Throws on store
 * errors (fail closed).
 */
function verifyDeviceAuthOrThrow(db: Database.Database, deviceId: string, secret: string): boolean {
  const stored = getTrustedSecretHashOrThrow(db, deviceId)
  if (!stored) return false
  return secretEquals(hashDeviceAuth(secret), stored)
}

/**
 * Verify then mark proven (F-002 recovery bound): the first successful
 * credential proof flips auth_proven=1 so later unauthenticated
 * same-device recovery is disabled. Mark is best-effort and never fails the
 * caller — a mark failure only leaves the pre-proof recovery window open.
 */
function verifyAndMarkProvenOrThrow(db: Database.Database, deviceId: string, secret: string): boolean {
  const ok = verifyDeviceAuthOrThrow(db, deviceId, secret)
  if (ok) {
    try {
      ensureDeviceAuthColumns(db)
      db.prepare('UPDATE sync_trusted_devices SET auth_proven = 1 WHERE device_id = ?').run(deviceId)
    } catch {}
  }
  return ok
}

/**
 * Founder bootstrap writer (F-001 atomic): the empty-check and the insert are
 * a single SQLite statement executed under the writer lock, so concurrent
 * first push/pull/invite processes serialize — exactly one founder wins.
 * The loser observes changes==0 and receives 'trust-already-initialized'
 * (callers map it to 403 pairing-required, never auto-trust). Throws
 * 'trust-store-unavailable' on store failure (fail closed, never success).
 */
function bootstrapTrustedDeviceOrThrow(
  db: Database.Database,
  deviceId: string,
  source: string
): { deviceAuth: string } {
  if (!isValidRelayDeviceId(deviceId)) throw new Error('device id invalid')
  const secret = generateDeviceAuth()
  const hash = hashDeviceAuth(secret)
  try {
    ensureDeviceAuthColumns(db)
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e))
  }
  let changes = 0
  try {
    const info = db
      .prepare(
        'INSERT INTO sync_trusted_devices (device_id, trusted_at, source, device_secret_hash, auth_proven) SELECT ?, ?, ?, ?, 0 WHERE (SELECT COUNT(*) FROM sync_trusted_devices) = 0'
      )
      .run(deviceId, new Date().toISOString(), source, hash)
    changes = Number((info as { changes: number }).changes ?? 0)
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e))
  }
  if (changes !== 1) throw new Error('trust-already-initialized')
  // Confirm the row now carries the hash; on confirm failure roll back the
  // just-inserted row (atomic rollback) so a retry bootstraps fresh instead
  // of leaving trusted-without-secret.
  let stored: string | null = null
  try {
    stored = getTrustedSecretHashOrThrow(db, deviceId)
  } catch (e) {
    try {
      db.prepare('DELETE FROM sync_trusted_devices WHERE device_id = ? AND device_secret_hash = ?').run(deviceId, hash)
    } catch {}
    throw e instanceof Error ? e : new Error(String(e))
  }
  if (!stored || !secretEquals(hash, stored)) {
    try {
      db.prepare('DELETE FROM sync_trusted_devices WHERE device_id = ? AND device_secret_hash = ?').run(deviceId, hash)
    } catch {}
    throw new Error('trust-store-unavailable')
  }
  return { deviceAuth: secret }
}

/**
 * F-002 consistency decision (no unauthenticated re-issuance): the relay
 * never rotates a credential without a valid proof. Confirm-read failures
 * roll back the just-inserted row (see bootstrap); post-bootstrap commit
 * failures carry the plaintext on the error response; network delivery loss
 * surfaces as explicit 403 pairing-required. Recovery is an explicit relay
 * reset (operator clears the unproven trust row) followed by a fresh
 * bootstrap — verifiable, controlled, and never a token-only impersonation.
 * A future explicit founder-confirm ACK would need a protocol decision.
 */
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

  const requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      // Trust enforcement is best-effort pre-parse: the canonical device
      // check runs again after the body is parsed (body.deviceId). This
      // header fast-path rejects untrusted devices without reading payloads.
      try {
        sweepExpiredPairing(db)
      } catch {}
      // Enforce byte limit via header check + body accumulation
      const clHeader = req.headers['content-length']
      const clStr = Array.isArray(clHeader) ? (clHeader[0] ?? '0') : (clHeader ?? '0')
      const contentLength = Number(clStr)
      if (Number.isFinite(contentLength) && contentLength > SYNC_MAX_PAYLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'payload too large' }))
        return
      }
      // Hoisted so post-bootstrap commit failures can still issue the
      // credential (no enrolled-without-credential lockout). Pre-bootstrap
      // validation failures return without trust or credential.
      let pushIssuedAuthForError: string | undefined
      try {
        const body = await jsonBodyWithLimit(req, SYNC_MAX_PAYLOAD_BYTES)
        // Device-identity authorization (F-001/F-003): the relay token alone
        // is never device trust. The calling identity is the
        // X-Sync-Device-Id header proven by the X-Sync-Device-Auth credential
        // (issued at founder bootstrap or pairing-request, stored hashed).
        // body.deviceId must equal the header identity and every
        // operation.deviceId must equal it (body/op binding). An empty trust
        // set is the founder bootstrap: the caller is enrolled and the
        // plaintext credential is returned once. Any trust-store read/write
        // failure is 500 fail-closed, never treated as an empty set.
        // AUD-001: all operation/cursor/payload validation runs BEFORE any
        // trust bootstrap write, so an illegal request never persists founder
        // trust. The bootstrap happens only after validation passes.
        const pushDeviceId: unknown = (body as { deviceId?: unknown })?.deviceId
        if (!isValidRelayDeviceId(pushDeviceId)) {
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
        const ops = rawOps as SyncOperation[]
        if (ops.length > SYNC_MAX_OPERATIONS_PER_PUSH) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `too many operations max ${SYNC_MAX_OPERATIONS_PER_PUSH}` }))
          return
        }
        // Validate all ops before inserting — reject invalid instead of silently skipping.
        for (const op of ops) {
          const err = validateOp(op)
          if (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `invalid operation ${op?.id ?? ''}: ${err}` }))
            return
          }
          // Body/operation identity binding (F-001): every operation must be
          // authored by the authenticated calling device.
          if (op?.deviceId !== pushDeviceId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `operation device mismatch for ${op?.id ?? ''}` }))
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
        let trustSize: number
        try {
          trustSize = trustedCountOrThrow(db)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const headerDeviceId = readDeviceHeader(req, RELAY_DEVICE_ID_HEADER)
        const headerAuth = readDeviceHeader(req, RELAY_DEVICE_AUTH_HEADER)
        let issuedAuth: string | undefined
        if (trustSize === 0) {
          // Founder bootstrap (F-001 atomic): header identity when present
          // must agree with the body; no credential is required yet. The
          // empty-check + insert is one atomic statement — concurrent
          // founders serialize, the loser gets trust-already-initialized.
          // Reached only after full payload validation above.
          if (headerDeviceId !== '' && headerDeviceId !== pushDeviceId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device id mismatch' }))
            return
          }
          try {
            issuedAuth = bootstrapTrustedDeviceOrThrow(db, pushDeviceId, 'bootstrap-sync').deviceAuth
          } catch (e) {
            // Concurrent founder race lost: explicit pairing required, never
            // auto-join. Delivery-loss retries without a credential stay 403
            // (no unauthenticated rotation — token+deviceId alone is never
            // proof); recovery is explicit relay reset, never silent re-issue.
            if ((e as Error)?.message === 'trust-already-initialized') {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'device-not-trusted' }))
              return
            }
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
            return
          }
          pushIssuedAuthForError = issuedAuth
        } else {
          if (!isValidRelayDeviceId(headerDeviceId) || headerDeviceId !== pushDeviceId) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          }
          if (!isValidDeviceAuth(headerAuth)) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          } else {
            let ok = false
            try {
              ok = verifyAndMarkProvenOrThrow(db, headerDeviceId, headerAuth)
            } catch {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
              return
            }
            if (!ok) {
              // Well-formed but wrong credential never rotates (no churn);
              // only missing/malformed auth on the sole unproven founder may
              // recover. All other mismatches stay 403 pairing-required.
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'device-not-trusted' }))
              return
            }
          }
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
            res.end(
              JSON.stringify(
                issuedAuth ? { error: msg.slice(0, 500), deviceAuth: issuedAuth } : { error: msg.slice(0, 500) }
              )
            )
            return
          }
          throw e
        }
        const row = db.prepare('SELECT COALESCE(MAX(seq),0) as maxSeq FROM operations').get() as { maxSeq: number }
        // Notify only after successful push commit; hint carries cursor only.
        if (acceptedIds.length > 0) broadcastSyncHint(row.maxSeq)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            issuedAuth
              ? { acceptedIds, cursor: row.maxSeq, deviceAuth: issuedAuth }
              : { acceptedIds, cursor: row.maxSeq }
          )
        )
      } catch (e) {
        const msg = (e as Error).message
        // Post-bootstrap commit failure still carries the credential so the
        // founder is never enrolled-without-credential. Pre-bootstrap body
        // parse failures have no credential (no trust was created).
        if (msg === 'payload too large') {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify(
              pushIssuedAuthForError
                ? { error: 'payload too large', deviceAuth: pushIssuedAuthForError }
                : { error: 'payload too large' }
            )
          )
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify(
              pushIssuedAuthForError
                ? { error: msg.slice(0, 500), deviceAuth: pushIssuedAuthForError }
                : { error: msg.slice(0, 500) }
            )
          )
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
      try {
        sweepExpiredPairing(db)
      } catch {}
      // Device-identity authorization for reads (F-001/F-002/F-003): pull
      // always requires the X-Sync-Device-Id header proven by
      // X-Sync-Device-Auth. No missing-identity compat path: a missing or
      // invalid identity is 403 fail-closed. Founder bootstrap (empty trust
      // set) enrolls the header identity and returns the credential once.
      // AUD-001: cursor/limit framing is validated BEFORE any trust
      // bootstrap write, so a malformed pull never persists founder trust.
      const pullDeviceId = url.searchParams.get('deviceId') ?? ''
      const pullHeaderId = readDeviceHeader(req, RELAY_DEVICE_ID_HEADER)
      const pullHeaderAuth = readDeviceHeader(req, RELAY_DEVICE_AUTH_HEADER)
      if (!isValidRelayDeviceId(pullDeviceId) || !isValidRelayDeviceId(pullHeaderId) || pullDeviceId !== pullHeaderId) {
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
      if (limit <= 0) limit = SYNC_MAX_OPERATIONS_PER_PULL
      if (limit > SYNC_MAX_OPERATIONS_PER_PULL) limit = SYNC_MAX_OPERATIONS_PER_PULL
      let pullTrustSize: number
      try {
        pullTrustSize = trustedCountOrThrow(db)
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      // F-002 bootstrap consistency: every fallible operation read/parse
      // runs BEFORE the bootstrap write in the empty-trust case, so a
      // validation/read failure never leaves enrolled-without-credential
      // trust behind. Post-bootstrap response construction carries the
      // credential on its error path (deterministic recoverable outcome).
      const readPullPage = (): Array<{
        seq: number
        id: string
        entityType: string
        op: string
        entityId: string
        timestamp: number
        deviceId: string
        payload?: unknown
      }> => {
        const rows = db
          .prepare(
            'SELECT seq, id, entity_type, op, entity_id, timestamp, device_id, payload_json FROM operations WHERE seq > ? ORDER BY seq ASC LIMIT ?'
          )
          .all(cursor, limit) as any[]
        return rows.map((r) => ({
          seq: r.seq,
          id: r.id,
          entityType: r.entity_type,
          op: r.op,
          entityId: r.entity_id,
          timestamp: r.timestamp,
          deviceId: r.device_id,
          payload: r.payload_json ? JSON.parse(r.payload_json) : undefined
        }))
      }
      let pullIssuedAuth: string | undefined
      let pullIssuedAuthForError: string | undefined
      let ops: Array<{
        seq: number
        id: string
        entityType: string
        op: string
        entityId: string
        timestamp: number
        deviceId: string
        payload?: unknown
      }>
      if (pullTrustSize === 0) {
        try {
          ops = readPullPage()
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        // F-002 pre-bootstrap semantic validation: every decoded operation
        // is checked with the protocol validator (shared strict + transport
        // payload limit) BEFORE any trust write. A legal-JSON but
        // semantically illegal row rejects with 500 and no bootstrap, no
        // credential, empty trust — never enrolled-without-credential.
        for (const op of ops) {
          const semanticsErr = validateOp(op as unknown as SyncOperation)
          if (semanticsErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({ error: `invalid operation ${String(op?.id ?? '')}: ${semanticsErr}`.slice(0, 500) })
            )
            return
          }
        }
        try {
          pullIssuedAuth = bootstrapTrustedDeviceOrThrow(db, pullDeviceId, 'bootstrap-sync').deviceAuth
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
        pullIssuedAuthForError = pullIssuedAuth
      } else {
        if (!isValidDeviceAuth(pullHeaderAuth)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        } else {
          let ok = false
          try {
            ok = verifyAndMarkProvenOrThrow(db, pullHeaderId, pullHeaderAuth)
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
            return
          }
          if (!ok) {
            // Well-formed but wrong credential never rotates; stays 403.
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          }
        }
        try {
          ops = readPullPage()
        } catch {
          if (pullIssuedAuthForError !== undefined) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable', deviceAuth: pullIssuedAuthForError }))
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          }
          return
        }
      }
      // Cursor is last sequence actually returned, not global max — prevents skip on push or paging
      const returnedCursor = ops.length > 0 ? ops[ops.length - 1].seq : cursor
      // Enforce serialized payload limit for pull response
      let respStr: string
      try {
        const respObj = pullIssuedAuth
          ? { operations: ops, cursor: returnedCursor, deviceAuth: pullIssuedAuth }
          : { operations: ops, cursor: returnedCursor }
        respStr = JSON.stringify(respObj)
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            pullIssuedAuthForError
              ? { error: 'trust-store-unavailable', deviceAuth: pullIssuedAuthForError }
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

    // ---- Device pairing protocol (reference/test implementation) ----
    if (req.method === 'POST' && url.pathname === '/sync/pair/invite') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        sweepExpiredPairing(db)
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const inviterId: unknown = body.deviceId
        if (!isValidRelayDeviceId(inviterId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device id invalid' }))
          return
        }
        // Only a trusted member (or the founder when the group is empty) may
        // mint invite codes. The inviter proves identity with its device
        // credential when the group is non-empty; minting as founder
        // bootstraps trust and issues the credential once.
        let inviteTrustSize: number
        try {
          inviteTrustSize = trustedCountOrThrow(db)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const inviteHeaderId = readDeviceHeader(req, RELAY_DEVICE_ID_HEADER)
        const inviteHeaderAuth = readDeviceHeader(req, RELAY_DEVICE_AUTH_HEADER)
        let inviteIssuedAuth: string | undefined
        if (inviteTrustSize === 0) {
          if (inviteHeaderId !== '' && inviteHeaderId !== inviterId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device id mismatch' }))
            return
          }
          try {
            inviteIssuedAuth = bootstrapTrustedDeviceOrThrow(db, inviterId, 'bootstrap-invite').deviceAuth
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
        } else {
          if (!isValidRelayDeviceId(inviteHeaderId) || inviteHeaderId !== inviterId) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          }
          if (!isValidDeviceAuth(inviteHeaderAuth)) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device-not-trusted' }))
            return
          } else {
            let ok = false
            try {
              ok = verifyAndMarkProvenOrThrow(db, inviteHeaderId, inviteHeaderAuth)
            } catch {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
              return
            }
            if (!ok) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'device-not-trusted' }))
              return
            }
          }
        }
        const code = generatePairingCode()
        const now = new Date()
        const expiresAt = new Date(now.getTime() + SYNC_PAIRING_INVITE_TTL_MS).toISOString()
        try {
          db.prepare(
            'INSERT INTO sync_pairing_invites (code, inviter_device_id, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)'
          ).run(code, inviterId, now.toISOString(), expiresAt)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify(
              inviteIssuedAuth
                ? { error: 'trust-store-unavailable', deviceAuth: inviteIssuedAuth }
                : { error: 'trust-store-unavailable' }
            )
          )
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(inviteIssuedAuth ? { code, expiresAt, deviceAuth: inviteIssuedAuth } : { code, expiresAt })
        )
        return
      } catch (e) {
        const msg = (e as Error).message
        if (msg === 'trust-store-unavailable') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: msg }))
          return
        }
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: msg.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/request') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        sweepExpiredPairing(db)
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const deviceId: unknown = body.deviceId
        const deviceName: unknown = body.deviceName
        const rawCode: unknown = body.code
        if (!isValidRelayDeviceId(deviceId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device id invalid' }))
          return
        }
        if (deviceName !== undefined && deviceName !== null && deviceName !== '') {
          if (typeof deviceName !== 'string' || deviceName.length > 64) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device name invalid' }))
            return
          }
        }
        if (typeof rawCode !== 'string' || validatePairingCodeShared(rawCode)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'pairing code invalid' }))
          return
        }
        const code = normalizePairingCodeShared(rawCode)
        const invite = db.prepare('SELECT code, expires_at FROM sync_pairing_invites WHERE code = ?').get(code) as
          | { code: string; expires_at: string }
          | undefined
        if (!invite) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invite not found' }))
          return
        }
        if (new Date(invite.expires_at).getTime() < Date.now()) {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invite expired' }))
          return
        }
        let alreadyTrusted = false
        try {
          alreadyTrusted = isTrustedDeviceOrThrow(db, deviceId)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        if (alreadyTrusted) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device already trusted' }))
          return
        }
        // Idempotent replay: same device + same code while pending re-issues
        // a fresh credential for that request (the requester holds the
        // latest plaintext; only the latest hash verifies after accept).
        // Duplicate replay without a stored hash fails closed.
        const existing = db
          .prepare("SELECT id, status FROM sync_pairing_requests WHERE device_id = ? AND code = ? AND status='pending'")
          .get(deviceId, code) as { id: string; status: string } | undefined
        if (existing) {
          const replaySecret = generateDeviceAuth()
          const replayHash = hashDeviceAuth(replaySecret)
          try {
            ensureDeviceAuthColumns(db)
            db.prepare('UPDATE sync_pairing_requests SET device_secret_hash = ? WHERE id = ?').run(
              replayHash,
              existing.id
            )
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ requestId: existing.id, status: existing.status, deviceAuth: replaySecret }))
          return
        }
        const now = new Date()
        const expiresAt = new Date(now.getTime() + SYNC_PAIRING_REQUEST_TTL_MS).toISOString()
        const id = randomUUID()
        const pendingSecret = generateDeviceAuth()
        const pendingHash = hashDeviceAuth(pendingSecret)
        try {
          ensureDeviceAuthColumns(db)
          db.prepare(
            'INSERT INTO sync_pairing_requests (id, device_id, device_name, code, created_at, expires_at, status, device_secret_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(
            id,
            deviceId,
            typeof deviceName === 'string' ? deviceName.slice(0, 64) : null,
            code,
            now.toISOString(),
            expiresAt,
            'pending',
            pendingHash
          )
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ requestId: id, status: 'pending', deviceAuth: pendingSecret }))
        return
      } catch (e) {
        const msg = (e as Error).message
        if (msg === 'trust-store-unavailable') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: msg }))
          return
        }
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: msg.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/sync/pair/pending') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      sweepExpiredPairing(db)
      const caller = url.searchParams.get('deviceId') ?? ''
      const pendingHeaderId = readDeviceHeader(req, RELAY_DEVICE_ID_HEADER)
      const pendingHeaderAuth = readDeviceHeader(req, RELAY_DEVICE_AUTH_HEADER)
      if (!isValidRelayDeviceId(caller) || pendingHeaderId !== caller || !isValidDeviceAuth(pendingHeaderAuth)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      let pendingOk = false
      try {
        pendingOk = verifyAndMarkProvenOrThrow(db, caller, pendingHeaderAuth)
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      if (!pendingOk) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      const rows = db
        .prepare(
          "SELECT id, device_id, device_name, code, created_at, expires_at, status FROM sync_pairing_requests WHERE status='pending' ORDER BY created_at ASC"
        )
        .all() as any[]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          requests: rows.map((r) => ({
            id: r.id,
            deviceId: r.device_id,
            deviceName: r.device_name ?? undefined,
            code: r.code,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
            status: r.status
          }))
        })
      )
      return
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/accept') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        sweepExpiredPairing(db)
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const approver: unknown = body.approverDeviceId
        const requestId: unknown = body.requestId
        if (!isValidRelayDeviceId(approver)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        const acceptHeaderId = readDeviceHeader(req, RELAY_DEVICE_ID_HEADER)
        const acceptHeaderAuth = readDeviceHeader(req, RELAY_DEVICE_AUTH_HEADER)
        if (acceptHeaderId !== approver || !isValidDeviceAuth(acceptHeaderAuth)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        let approverOk = false
        try {
          approverOk = verifyAndMarkProvenOrThrow(db, acceptHeaderId, acceptHeaderAuth)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        if (!approverOk) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        if (typeof requestId !== 'string' || requestId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request id invalid' }))
          return
        }
        const row = db
          .prepare(
            'SELECT id, device_id, device_name, status, expires_at, device_secret_hash FROM sync_pairing_requests WHERE id = ?'
          )
          .get(requestId) as
          | {
              id: string
              device_id: string
              device_name: string | null
              status: string
              expires_at: string
              device_secret_hash: string | null
            }
          | undefined
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request not found' }))
          return
        }
        if (row.status !== 'pending' || new Date(row.expires_at).getTime() < Date.now()) {
          if (row.status === 'pending') {
            try {
              db.prepare("UPDATE sync_pairing_requests SET status='expired' WHERE id = ?").run(requestId)
            } catch {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
              return
            }
          }
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `request ${row.status}` }))
          return
        }
        if (!row.device_secret_hash) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        const nowIso = new Date().toISOString()
        try {
          ensureDeviceAuthColumns(db)
          db.prepare(
            'INSERT OR IGNORE INTO sync_trusted_devices (device_id, device_name, trusted_at, source, device_secret_hash) VALUES (?, ?, ?, ?, ?)'
          ).run(row.device_id, row.device_name, nowIso, 'pairing-accept', row.device_secret_hash)
          // Promote-or-verify: if the device was already trusted (race), its
          // stored hash must already match; a mismatch fails closed.
          const storedAfter = getTrustedSecretHashOrThrow(db, row.device_id)
          if (!storedAfter || !secretEquals(storedAfter, row.device_secret_hash)) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
            return
          }
          db.prepare("UPDATE sync_pairing_requests SET status='accepted' WHERE id = ?").run(requestId)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            trusted: {
              deviceId: row.device_id,
              deviceName: row.device_name ?? undefined,
              trustedAt: nowIso,
              source: 'pairing-accept'
            }
          })
        )
        return
      } catch (e) {
        const msg = (e as Error).message
        if (msg === 'trust-store-unavailable') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: msg }))
          return
        }
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: msg.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/reject') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        sweepExpiredPairing(db)
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const approver: unknown = body.approverDeviceId
        const requestId: unknown = body.requestId
        if (!isValidRelayDeviceId(approver)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        const rejectHeaderId = readDeviceHeader(req, RELAY_DEVICE_ID_HEADER)
        const rejectHeaderAuth = readDeviceHeader(req, RELAY_DEVICE_AUTH_HEADER)
        if (rejectHeaderId !== approver || !isValidDeviceAuth(rejectHeaderAuth)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        let rejectOk = false
        try {
          rejectOk = verifyAndMarkProvenOrThrow(db, rejectHeaderId, rejectHeaderAuth)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        if (!rejectOk) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        if (typeof requestId !== 'string' || requestId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request id invalid' }))
          return
        }
        const row = db.prepare('SELECT id, status FROM sync_pairing_requests WHERE id = ?').get(requestId) as
          | { id: string; status: string }
          | undefined
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
        try {
          db.prepare("UPDATE sync_pairing_requests SET status='rejected' WHERE id = ?").run(requestId)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      } catch (e) {
        const msg = (e as Error).message
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: msg.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/sync/pair/trusted') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const caller = url.searchParams.get('deviceId') ?? ''
      const trustedHeaderId = readDeviceHeader(req, RELAY_DEVICE_ID_HEADER)
      const trustedHeaderAuth = readDeviceHeader(req, RELAY_DEVICE_AUTH_HEADER)
      if (!isValidRelayDeviceId(caller) || trustedHeaderId !== caller || !isValidDeviceAuth(trustedHeaderAuth)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      let trustedOk = false
      try {
        trustedOk = verifyAndMarkProvenOrThrow(db, caller, trustedHeaderAuth)
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      if (!trustedOk) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device-not-trusted' }))
        return
      }
      const rows = (() => {
        try {
          return db
            .prepare(
              'SELECT device_id, device_name, trusted_at, source FROM sync_trusted_devices ORDER BY trusted_at ASC'
            )
            .all() as any[]
        } catch {
          return null
        }
      })()
      if (!rows) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          devices: rows.map((r) => ({
            deviceId: r.device_id,
            deviceName: r.device_name ?? undefined,
            trustedAt: r.trusted_at,
            source: r.source ?? 'relay'
          }))
        })
      )
      return
    }

    if (req.method === 'GET' && url.pathname === '/sync/pair/status') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      sweepExpiredPairing(db)
      const caller = url.searchParams.get('deviceId') ?? ''
      if (!isValidRelayDeviceId(caller)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'device id invalid' }))
        return
      }
      // Pairing status stays token-only (joiner poll before trust): it
      // reveals only booleans, never operations or credentials. Trust-store
      // read failures fail closed with 500, never a forged false.
      let trusted = false
      let pendingRow: { id: string } | undefined
      try {
        trusted = isTrustedDeviceOrThrow(db, caller)
        pendingRow = db
          .prepare("SELECT id FROM sync_pairing_requests WHERE device_id = ? AND status='pending' LIMIT 1")
          .get(caller) as { id: string } | undefined
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ trusted, pending: !!pendingRow }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/revoke') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const approver: unknown = body.approverDeviceId
        const target: unknown = body.targetDeviceId
        if (!isValidRelayDeviceId(approver)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        const revokeHeaderId = readDeviceHeader(req, RELAY_DEVICE_ID_HEADER)
        const revokeHeaderAuth = readDeviceHeader(req, RELAY_DEVICE_AUTH_HEADER)
        if (revokeHeaderId !== approver || !isValidDeviceAuth(revokeHeaderAuth)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        let revokeOk = false
        try {
          revokeOk = verifyAndMarkProvenOrThrow(db, revokeHeaderId, revokeHeaderAuth)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        if (!revokeOk) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-not-trusted' }))
          return
        }
        if (!isValidRelayDeviceId(target)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device id invalid' }))
          return
        }
        if (approver === target) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'cannot revoke own device' }))
          return
        }
        let row: unknown
        try {
          row = db.prepare('SELECT device_id FROM sync_trusted_devices WHERE device_id = ?').get(target)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device not trusted' }))
          return
        }
        try {
          db.prepare('DELETE FROM sync_trusted_devices WHERE device_id = ?').run(target)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'trust-store-unavailable' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      } catch (e) {
        const msg = (e as Error).message
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: msg.slice(0, 500) }))
        return
      }
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
  }
  // Native TLS termination lives in the relay itself (no reverse proxy):
  // with cert/key the same handler serves HTTPS, otherwise plain HTTP.
  const server = opts?.tls
    ? createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }, requestHandler)
    : createHttpServer(requestHandler)
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
  ;(server as unknown as { __relaySseClients?: Set<ServerResponse> }).__relaySseClients = sseClients
  return server
}

const isMain = typeof require !== 'undefined' && (require as any).main === module
if (isMain) {
  let cli: RelayCliArgs | undefined
  try {
    cli = parseArgs()
  } catch (e) {
    console.error(`[sync-relay] ${(e as Error).message}`)
    console.error(RELAY_HELP_TEXT)
    process.exit(2)
  }
  const parsed = cli
  if (parsed.help) {
    console.log(RELAY_HELP_TEXT)
    process.exit(0)
  }
  const { port, dbPath, host, token, certPath, keyPath } = parsed
  if (typeof token !== 'string' || token.length === 0) {
    console.error('[sync-relay] missing --token (or SYNC_RELAY_TOKEN env); refusing unauthenticated startup')
    console.error(RELAY_HELP_TEXT)
    process.exit(2)
  }
  // TLS/cert material loads before the DB is opened: any missing, empty, or
  // mismatched configuration aborts startup without creating the DB.
  // Non-loopback hosts require --cert/--key (native HTTPS); loopback serves
  // plain HTTP unless both are given. Never log secret or key material.
  let tls: RelayTlsConfig
  try {
    tls = resolveRelayTls(host, certPath, keyPath)
  } catch (e) {
    console.error(`[sync-relay] ${(e as Error).message.slice(0, 300)}`)
    console.error(RELAY_HELP_TEXT)
    process.exit(2)
  }
  const relayTls: RelayTlsConfig = tls
  let db: Database.Database
  try {
    db = initDb(dbPath)
  } catch (e) {
    console.error(`[sync-relay] failed to open database: ${(e as Error).message.slice(0, 300)}`)
    process.exit(1)
  }
  const relayDb: Database.Database = db
  const server = createRelayServer(
    relayDb,
    relayTls.scheme === 'https' && relayTls.cert && relayTls.key
      ? { token, tls: { cert: relayTls.cert, key: relayTls.key } }
      : { token }
  )
  let shuttingDown = false
  let dbClosed = false
  const closeDbOnce = (): boolean => {
    if (dbClosed) return true
    dbClosed = true
    try {
      relayDb.close()
      return true
    } catch (e) {
      console.error(`[sync-relay] database close failed: ${(e as Error).message.slice(0, 300)}`)
      return false
    }
  }
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[sync-relay] received ${signal}, shutting down`)
    const finish = (code: number): void => {
      const ok = closeDbOnce()
      if (!ok) {
        process.exit(1)
        return
      }
      console.log('[sync-relay] shutdown complete')
      process.exit(code)
    }
    try {
      // Active SSE streams hold their sockets open and would block
      // server.close() forever; end them first so close can complete.
      try {
        const peer = server as unknown as {
          closeIdleConnections?: () => void
          closeAllConnections?: () => void
        }
        const clients = (server as unknown as { __relaySseClients?: Iterable<ServerResponse> }).__relaySseClients
        if (clients) {
          for (const client of [...clients]) {
            try {
              client.end()
            } catch {}
          }
        }
        peer.closeIdleConnections?.()
        peer.closeAllConnections?.()
      } catch {}
      server.close((err?: Error) => {
        if (err) {
          console.error(`[sync-relay] server close failed: ${String(err.message).slice(0, 300)}`)
          finish(1)
          return
        }
        finish(0)
      })
    } catch (e) {
      console.error(`[sync-relay] shutdown failed: ${(e as Error).message.slice(0, 300)}`)
      finish(1)
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  server.on('error', (err: Error) => {
    console.error(`[sync-relay] server error: ${err.message.slice(0, 300)}`)
    if (shuttingDown) {
      closeDbOnce()
      process.exit(1)
      return
    }
    shuttingDown = true
    const ok = closeDbOnce()
    void ok
    process.exit(1)
  })
  // Bind the configured host: loopback HTTP stays the local default;
  // non-loopback hosts serve native HTTPS only (enforced above).
  server.listen(port, host, () => {
    // Report the actual bound port so `--port 0` (ephemeral) is observable.
    // Loopback keeps the stable 127.0.0.1 readiness form so bundled/test
    // harnesses match one contract; non-loopback advertises the actual
    // scheme and bound host/port.
    const addr = server.address()
    const boundPort = typeof addr === 'object' && addr ? addr.port : port
    // Bounded readiness output — no sensitive path, token, or key material.
    // IPv6 literals serialize bracketed so the line stays a valid URL; the
    // raw unbracketed host is used only for server.listen above.
    if (relayTls.scheme === 'https') {
      console.log(`[sync-relay] listening on https://${formatRelayHostForUrl(host)}:${boundPort}`)
    } else {
      console.log(`[sync-relay] listening on http://127.0.0.1:${boundPort}`)
    }
  })
}
