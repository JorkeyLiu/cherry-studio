/**
 * Reference HTTP relay for sync MVP — isolated non-production path.
 * Minimal persistent operation log with endpoint handlers.
 * Must NOT be imported by production app code.
 * Runnable via:  npx tsx scripts/sync-relay/server.ts [--port 3000] [--db /tmp/sync-relay.db] [--token secret]
 * LAN via: npx tsx scripts/sync-relay/server.ts --host <LAN-IP> [--cert <cert.pem> --key <key.pem>] [--port ...] [--db ...] [--token ...]
 *   (plain HTTP by default; native HTTPS when user-supplied --cert/--key are given; the relay never generates certificates)
 * Container bridge via: --host 0.0.0.0 --allow-unspecified-bind (Docker bridge internal bind only)
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
  SYNC_DEVICE_CODE_HEADER as SHARED_DEVICE_CODE_HEADER,
  SYNC_DEVICE_SECRET_HEADER as SHARED_DEVICE_SECRET_HEADER,
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
 * Container-internal unspecified bind forms. `0.0.0.0` (and `::`) are never
 * a user-facing advertised endpoint — they are only the Docker bridge
 * container-internal bind (Docker controls host exposure via `ports:`).
 * They are accepted only with the deployment-scoped
 * `--allow-unspecified-bind` flag so direct host runs keep the strict
 * explicit-IP policy.
 */
export const RELAY_UNSPECIFIED_BIND_HOSTS = ['0.0.0.0', '::', '[::]'] as const

export function isUnspecifiedBindHost(host: string): boolean {
  const n = host.trim().toLowerCase()
  return n === '0.0.0.0' || n === '::' || n === '[::]'
}

/**
 * Internal Docker-bridge attestation for the container-internal
 * unspecified bind. The value is set only by `deploy/sync-relay/
 * docker-entrypoint.sh` after it validates its own controlled path
 * (init, token file); it is never a user-facing CLI option. Direct host
 * runs must not set it: `parseRelayArgs`/`resolveRelayTls` additionally
 * require a container-runtime indicator (`/.dockerenv` or
 * `/run/.containerenv`) so merely exporting the variable on a host does
 * not weaken wildcard protection.
 */
export const RELAY_BRIDGE_ATTEST_ENV = 'CHERRY_RELAY_BRIDGE_BIND'
export const RELAY_BRIDGE_ATTEST_VALUE = 'docker-bridge-v1'

export function isBridgeBindAttested(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync
): boolean {
  if (env?.[RELAY_BRIDGE_ATTEST_ENV] !== RELAY_BRIDGE_ATTEST_VALUE) return false
  try {
    if (exists('/.dockerenv') || exists('/run/.containerenv')) return true
  } catch {
    return false
  }
  return false
}

function requireBridgeBindAttested(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): void {
  if (!isBridgeBindAttested(env, exists)) {
    throw new Error(
      'invalid --allow-unspecified-bind (deployment-scoped Docker bridge bind only; direct host runs must use an explicit LAN IP address)'
    )
  }
}

/**
 * Readiness line formatter (single shared helper so tests lock the
 * contract). Explicit hosts stay URL-shaped (`http(s)://host:port`);
 * the internal unspecified bind never emits a URL-shaped wildcard and
 * instead reports a non-URL status (`http (internal bind) port N`).
 */
export function formatRelayReadiness(host: string, scheme: 'http' | 'https', port: number): string {
  if (isUnspecifiedBindHost(host)) {
    return `[sync-relay] listening on ${scheme} (internal bind) port ${port}`
  }
  if (scheme === 'https') {
    return `[sync-relay] listening on https://${formatRelayHostForUrl(host)}:${port}`
  }
  if (isLoopbackHost(host)) {
    return `[sync-relay] listening on http://127.0.0.1:${port}`
  }
  return `[sync-relay] listening on http://${formatRelayHostForUrl(host)}:${port}`
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
  '  pnpm sync:relay -- --host <LAN-IP> --port <port> --db <path> --token <token> [--cert <cert.pem> --key <key.pem>]',
  '  pnpm sync:relay -- --help',
  '',
  'Options:',
  '  --port <port>    TCP port to bind (0 = ephemeral, otherwise 1-65535; default 3030)',
  '  --db <path>      SQLite file for relay state (persistent; never deleted on stop)',
  '  --token <token>  Bearer token (fallback: SYNC_RELAY_TOKEN env; required for the supported path)',
  '  --host <host>    Bind host: 127.0.0.1 or localhost for loopback HTTP (default 127.0.0.1);',
  '                     an explicit non-loopback LAN IP serves plain HTTP by default,',
  '                     or native HTTPS when both --cert and --key are given.',
  '                     Non-loopback hosts must be an explicit numeric LAN IP;',
  '                     wildcard/all-interface binds (0.0.0.0, ::, equivalents, *) are forbidden,',
  '                     except 0.0.0.0/:: with --allow-unspecified-bind (container-internal',
  '                     Docker bridge bind only; never a user-facing advertised endpoint).',
  '  --cert <path>    PEM certificate file for HTTPS (required with --key)',
  '  --key <path>     PEM private-key file for HTTPS (required with --cert)',
  '  --allow-unspecified-bind  Permit the container-internal 0.0.0.0/:: bind.',
  '                     Deployment-scoped (Docker bridge entrypoint only; direct host runs are rejected).',
  '  --help, -h       Show this help and exit 0',
  '',
  'Notes:',
  '  - Loopback binds serve plain HTTP without cert/key.',
  '  - Non-loopback binds serve plain HTTP unless both --cert and --key are',
  '    given, in which case they serve native HTTPS. Plain HTTP is',
  '    unencrypted: only use it on networks you trust, or expose HTTPS',
  '    outside the relay (the relay never manages certificates itself).',
  '  - Non-loopback hosts must be an explicit numeric LAN IP address;',
  '    wildcard/all-interface binds (0.0.0.0, ::, equivalents, *) and',
  '    non-numeric hostnames are rejected before the DB is opened, unless',
  '    --allow-unspecified-bind permits the container-internal 0.0.0.0/:: bind.',
  '  - Cert/key files are read before the DB is opened; missing, empty, or',
  '    mismatched cert/key aborts startup without creating the DB.',
  '  - SIGTERM/SIGINT shut down gracefully exactly once without deleting the DB.',
  '  - Same --db/--token (--cert/--key for HTTPS) on restart retains relay state.'
].join('\n')

export interface RelayCliArgs {
  port: number
  dbPath: string
  host: string
  token?: string
  certPath?: string
  keyPath?: string
  allowUnspecifiedBind: boolean
  help: boolean
}

export function parseRelayArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  bridgeExists: (p: string) => boolean = existsSync
): RelayCliArgs {
  let port = 3030
  let dbPath = resolve(process.cwd(), 'tmp-sync-relay.db')
  let host = '127.0.0.1'
  let token: string | undefined
  const envToken = env.SYNC_RELAY_TOKEN
  if (typeof envToken === 'string' && envToken.length > 0) token = envToken
  let certPath: string | undefined
  let keyPath: string | undefined
  // Deployment-scoped container-internal bind opt-in (Docker bridge only).
  // Pre-scanned so flag position relative to --host does not matter.
  let allowUnspecifiedBind = argv.includes('--allow-unspecified-bind')
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--allow-unspecified-bind') {
      allowUnspecifiedBind = true
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
      // are not unspecified/wildcard; they serve plain HTTP unless --cert
      // and --key select native HTTPS. The container-internal 0.0.0.0/:: bind
      // is accepted only with --allow-unspecified-bind (Docker bridge) and
      // is never a user-facing advertised endpoint. Bracketed IPv6 literals
      // (`[::1]`) normalize to raw form (`::1`) for `server.listen()`; URL/
      // readiness serialization keeps brackets via formatRelayHostForUrl().
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > 253) {
        throw new Error('invalid --host (expected a hostname or IP address)')
      }
      if (isLoopbackHost(raw)) {
        host = raw === 'localhost' ? '127.0.0.1' : raw
      } else {
        if (isWildcardHost(raw)) {
          if (allowUnspecifiedBind && isUnspecifiedBindHost(raw)) {
            host = raw.trim().toLowerCase() === '[::]' ? '::' : raw.trim().toLowerCase()
          } else {
            throw new Error(
              `invalid --host '${String(raw).slice(0, 64)}' (wildcard/all-interface binds are forbidden; use an explicit LAN IP address)`
            )
          }
        } else if (hasZoneSuffix(raw)) {
          throw new Error(
            `invalid --host '${String(raw).slice(0, 64)}' (zone-scoped IPv6 addresses are unsupported; use an unscoped explicit LAN IP address)`
          )
        } else {
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
              if (allowUnspecifiedBind && isUnspecifiedBindHost(normalized)) {
                host = normalized.trim().toLowerCase()
              } else {
                throw new Error(
                  `invalid --host '${String(raw).slice(0, 64)}' (wildcard/all-interface binds are forbidden; use an explicit LAN IP address)`
                )
              }
            } else {
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
  if (allowUnspecifiedBind) {
    requireBridgeBindAttested(env, bridgeExists)
  }
  return { port, dbPath, host, token, certPath, keyPath, allowUnspecifiedBind, help }
}

export interface RelayTlsConfig {
  scheme: 'http' | 'https'
  cert?: Buffer
  key?: Buffer
}

/**
 * Resolve the transport for a parsed CLI host/cert/key triple. Fail-closed:
 * cert/key files are read here (before the DB is opened by the caller) and
 * missing/empty/mismatched material throws. Loopback and explicit
 * non-loopback hosts serve plain HTTP unless both --cert/--key are given
 * (HTTPS opt-in); one without the other throws. Plain HTTP is unencrypted —
 * the relay never manages certificates itself. The container-internal
 * 0.0.0.0/:: bind requires `options.allowUnspecifiedBind` plus Docker-bridge
 * attestation (internal entrypoint marker + container indicator); all other
 * wildcard forms stay forbidden.
 */
export function resolveRelayTls(
  host: string,
  certPath?: string,
  keyPath?: string,
  options?: { allowUnspecifiedBind?: boolean; env?: NodeJS.ProcessEnv; bridgeExists?: (p: string) => boolean }
): RelayTlsConfig {
  const allowUnspecified = options?.allowUnspecifiedBind === true
  if (allowUnspecified) {
    requireBridgeBindAttested(options?.env ?? process.env, options?.bridgeExists ?? existsSync)
  }
  const unspecified = isUnspecifiedBindHost(host)
  if (unspecified && !allowUnspecified) {
    throw new Error(
      `wildcard --host '${String(host).slice(0, 64)}' forbidden (bind an explicit LAN IP address; wildcard/all-interface binds are rejected)`
    )
  }
  const loopback = isLoopbackHost(host)
  if (!loopback && !unspecified) {
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
  if (!certPath && !keyPath) return { scheme: 'http' }
  if (!certPath || !keyPath) {
    if (loopback || unspecified) {
      throw new Error(`--host with partial TLS config requires both --cert and --key`)
    }
    throw new Error(
      `non-loopback --host '${String(host).slice(0, 64)}' with partial TLS config requires both --cert and --key (supply both for HTTPS, or neither for plain HTTP)`
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

const SYNC_PAIRING_CODE_LENGTH = 8
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * Stable relay-scoped public device code (SYNC-CC-007): human-transcribable,
 * routable by transcription, carrying no authorization power.
 */
export function generatePairingCode(): string {
  const bytes = randomBytes(SYNC_PAIRING_CODE_LENGTH)
  let out = ''
  for (const b of bytes) out += PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length]
  return out
}

export function generateDeviceCode(): string {
  return generatePairingCode()
}

function isValidRelayDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim().length > 0
}

const RELAY_DEVICE_CODE_HEADER = SHARED_DEVICE_CODE_HEADER
const RELAY_DEVICE_SECRET_HEADER = SHARED_DEVICE_SECRET_HEADER
const DEVICE_SECRET_PATTERN = /^[0-9a-fA-F]{64}$/

function isValidDeviceSecret(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_SECRET_PATTERN.test(value)
}

function isValidDeviceCode(value: unknown): value is string {
  return typeof value === 'string' && validatePairingCodeShared(value) === null
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

/**
 * Relay schema for the registration/channel/pairing model (SYNC-CC-*).
 * Exported for unit tests so the file-backed CLI path (`initDb`) and the
 * in-memory/HTTP test harnesses share one schema. Current pairing state
 * (`sync_pair_requests`) is never dropped: only the superseded global
 * `operations` table and explicit legacy tables from the superseded
 * invite/founder/global-trust stages are removed once, and only when an
 * explicit legacy schema is present without the versioned meta marker
 * (SYNC-CC-013). Fresh installs (no legacy, no marker) only record the
 * marker; a second startup against the same DB is a no-op for existing
 * rows, so pending requests survive relay restarts.
 */
export const RELAY_SCHEMA_VERSION = 'cc-1'
const RELAY_SCHEMA_META_KEY = 'schema_version'

/**
 * Legacy tables replaced by the channel-scoped model. Allowlisted: only
 * these names are ever dropped by the one-time reset. Current tables
 * (`sync_devices`, `sync_channels`, `sync_memberships`,
 * `sync_pair_requests`, `sync_channel_operations`, `relay_schema_meta`)
 * are never in this set.
 */
const RELAY_LEGACY_TABLES = [
  'operations',
  'sync_trusted_devices',
  'sync_pairing_invites',
  'sync_pairing_requests'
] as const

function listPresentLegacyRelayTables(db: Database.Database): string[] {
  let rows: Array<{ name: string }> = []
  try {
    rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('operations','sync_trusted_devices','sync_pairing_invites','sync_pairing_requests')"
      )
      .all() as Array<{ name: string }>
  } catch {
    return []
  }
  const present = new Set(rows.map((r) => r.name))
  return (RELAY_LEGACY_TABLES as readonly string[]).filter((t) => present.has(t))
}

export function ensureRelaySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_devices (
      device_code TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      client_device_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_channels (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      dissolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sync_memberships (
      device_code TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      joined_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_memberships_channel_idx ON sync_memberships(channel_id);
    CREATE TABLE IF NOT EXISTS sync_pair_requests (
      id TEXT PRIMARY KEY,
      requester_code TEXT NOT NULL,
      target_code TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_pair_requests_requester_idx ON sync_pair_requests(requester_code, status);
    CREATE INDEX IF NOT EXISTS sync_pair_requests_target_idx ON sync_pair_requests(target_code, status);
    CREATE UNIQUE INDEX IF NOT EXISTS sync_pair_requests_single_pending ON sync_pair_requests(requester_code) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS sync_channel_operations (
      channel_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      op TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT,
      PRIMARY KEY (channel_id, seq)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS sync_channel_operations_id_idx ON sync_channel_operations(channel_id, id);
    CREATE INDEX IF NOT EXISTS sync_channel_operations_entity_idx ON sync_channel_operations(channel_id, entity_id);
    CREATE TABLE IF NOT EXISTS relay_schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  let applied: string | null = null
  try {
    const row = db.prepare('SELECT value FROM relay_schema_meta WHERE key = ?').get(RELAY_SCHEMA_META_KEY) as
      | { value: string }
      | undefined
    applied = row?.value ?? null
  } catch {
    applied = null
  }
  if (applied === RELAY_SCHEMA_VERSION) return
  // One-time deterministic reset of explicit legacy tables only, gated on an
  // explicit legacy schema without the marker. Current tables above (notably
  // `sync_pair_requests` and `sync_channel_operations`) are never dropped;
  // the version marker makes later restarts a no-op so pending rows survive.
  const legacyTables = listPresentLegacyRelayTables(db)
  if (legacyTables.length > 0) {
    for (const table of legacyTables) {
      db.exec(`DROP TABLE IF EXISTS "${table}"`)
    }
  }
  db.prepare(
    'INSERT INTO relay_schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(RELAY_SCHEMA_META_KEY, RELAY_SCHEMA_VERSION)
}

function initDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  ensureRelaySchema(db)
  return db
}

/**
 * Registration/channel/pairing store accessors (SYNC-CC-* target model).
 * Every read/write failure throws so callers fail closed with 500 instead
 * of treating the failure as absent state.
 */

function getDeviceSecretHashOrThrow(db: Database.Database, deviceCode: string): string | null {
  const row = db.prepare('SELECT secret_hash FROM sync_devices WHERE device_code = ?').get(deviceCode) as
    | { secret_hash: string | null }
    | undefined
  if (!row) return null
  return row.secret_hash ?? null
}

/**
 * Verify (deviceCode, secret) against the stored hash. Returns true only
 * when the device row exists and the secret matches. Unknown credentials
 * fail closed — never silently re-registered.
 */
function verifyDeviceSecretOrThrow(db: Database.Database, deviceCode: string, secret: string): boolean {
  const stored = getDeviceSecretHashOrThrow(db, deviceCode)
  if (!stored) return false
  return secretEquals(hashDeviceAuth(secret), stored)
}

/**
 * Authenticate a device-authenticated call. Returns the verified device
 * code. Throws `{status, error}` for HTTP mapping: 403 unknown-credential
 * (unregistered) or invalid-credential (wrong secret).
 */
function requireDeviceAuthOrThrow(db: Database.Database, req: IncomingMessage): { deviceCode: string } {
  const code = readDeviceHeader(req, RELAY_DEVICE_CODE_HEADER)
  const secret = readDeviceHeader(req, RELAY_DEVICE_SECRET_HEADER)
  if (!isValidDeviceCode(code) || !isValidDeviceSecret(secret)) {
    throw { status: 403, error: 'invalid-credential' }
  }
  let ok = false
  try {
    ok = verifyDeviceSecretOrThrow(db, normalizePairingCodeShared(code), secret)
  } catch {
    throw { status: 500, error: 'store-unavailable' }
  }
  if (!ok) {
    let known = false
    try {
      known = getDeviceSecretHashOrThrow(db, normalizePairingCodeShared(code)) !== null
    } catch {
      throw { status: 500, error: 'store-unavailable' }
    }
    throw { status: 403, error: known ? 'invalid-credential' : 'unknown-credential' }
  }
  return { deviceCode: normalizePairingCodeShared(code) }
}

function getMembershipChannelOrThrow(db: Database.Database, deviceCode: string): string | null {
  const row = db.prepare('SELECT channel_id FROM sync_memberships WHERE device_code = ?').get(deviceCode) as
    | { channel_id: string }
    | undefined
  return row?.channel_id ?? null
}

/**
 * Operation identity binding (fail-closed): the authenticated device code
 * resolves to its registration row; when the registration carries a client
 * device id, every push identity must equal it. Null (pre-binding
 * registrations) skips the check. Errors are fixed strings — the code and
 * secret are never echoed.
 */
function getRegistrationClientIdOrThrow(db: Database.Database, deviceCode: string): string | null {
  const row = db.prepare('SELECT client_device_id FROM sync_devices WHERE device_code = ?').get(deviceCode) as
    | { client_device_id: string | null }
    | undefined
  if (!row) return null
  const v = row.client_device_id
  return typeof v === 'string' && v.length > 0 ? v : null
}

function getOutgoingPendingOrThrow(
  db: Database.Database,
  requesterCode: string
): { id: string; target_code: string; created_at: string } | null {
  const row = db
    .prepare(
      "SELECT id, target_code, created_at FROM sync_pair_requests WHERE requester_code = ? AND status='pending' LIMIT 1"
    )
    .get(requesterCode) as { id: string; target_code: string; created_at: string } | undefined
  return row ?? null
}

function getIncomingPendingOrThrow(
  db: Database.Database,
  targetCode: string
): Array<{ id: string; requester_code: string; created_at: string }> {
  return db
    .prepare(
      "SELECT id, requester_code, created_at FROM sync_pair_requests WHERE target_code = ? AND status='pending' ORDER BY created_at ASC"
    )
    .all(targetCode) as Array<{ id: string; requester_code: string; created_at: string }>
}

/** Unique device-code issuance: retry on collision (fail closed after bounded attempts). */
function issueUniqueDeviceCodeOrThrow(db: Database.Database): string {
  for (let i = 0; i < 16; i++) {
    const code = generateDeviceCode()
    const row = db.prepare('SELECT device_code FROM sync_devices WHERE device_code = ?').get(code) as
      | { device_code: string }
      | undefined
    if (!row) return code
  }
  throw new Error('store-unavailable')
}

function channelMaxSeqOrThrow(db: Database.Database, channelId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq),0) as maxSeq FROM sync_channel_operations WHERE channel_id = ?')
    .get(channelId) as { maxSeq: number }
  return row?.maxSeq ?? 0
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

/** Test/diagnostic handle to the live channel-bound SSE subscriber index. */
type RelaySseIndex = {
  __relaySseClients?: Map<ServerResponse, { channelId: string; deviceCode: string }>
}

export function createRelayServer(db: Database.Database, opts?: RelayOptions) {
  const expectedToken = opts?.token ?? process.env.SYNC_RELAY_TOKEN ?? undefined
  const tokenRequired = typeof expectedToken === 'string' && expectedToken.length > 0
  // Notification-only SSE subscribers, scoped per channel (SYNC-CC-016).
  // Each entry is an open event-stream response bound to the subscriber's
  // device and channel at subscribe time; hints carry only a
  // non-authoritative cursor ({cursor}), never operations or payloads. Data
  // moves only via push/pull. One channel's hints are never visible to
  // another channel's subscribers, and a device that leaves a channel never
  // keeps receiving that channel's hints: membership mutations close the
  // affected subscribers (below) so they must resubscribe on the new channel.
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
   * Close every open subscriber currently bound to the given channel whose
   * device is no longer a member of it (membership left or dissolved).
   * Survivors of a non-dissolved channel keep their streams.
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
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Content-Type,Authorization,${SHARED_DEVICE_CODE_HEADER},${SHARED_DEVICE_SECRET_HEADER}`
    )
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // ---- Channel-scoped sync data plane (SYNC-CC-016) ----
    // push requires paired channel membership; operations are sequenced
    // contiguously per channel and never visible to other channels.
    if (req.method === 'POST' && url.pathname === '/sync/push') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
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
        let caller: string
        try {
          caller = requireDeviceAuthOrThrow(db, req).deviceCode
        } catch (authErr) {
          const ae = authErr as { status?: number; error?: string }
          res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
          return
        }
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
          res.end(JSON.stringify({ error: 'too many operations max ' + SYNC_MAX_OPERATIONS_PER_PUSH }))
          return
        }
        // Validate all ops before inserting — reject invalid instead of silently skipping.
        for (const op of ops) {
          const err = validateOp(op)
          if (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid operation ' + String(op?.id ?? '') + ': ' + err }))
            return
          }
          // Body/operation identity binding: every operation must be
          // authored by the calling device identity in the body.
          if (op?.deviceId !== pushDeviceId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'operation device mismatch for ' + String(op?.id ?? '') }))
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
        let channel: string | null
        try {
          channel = getMembershipChannelOrThrow(db, caller)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (!channel) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'pairing-required' }))
          return
        }
        const channelId: string = channel
        // Operation identity binding: the push body device id (which every
        // operation already equals, checked above) must equal the
        // authenticated registration's client device id. A forged device id
        // fails closed with 403; the code/secret are never echoed.
        try {
          const registeredClientId = getRegistrationClientIdOrThrow(db, caller)
          if (registeredClientId !== null && pushDeviceId !== registeredClientId) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device identity mismatch' }))
            return
          }
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        const acceptedIds: string[] = []
        const insert = db.prepare(
          'INSERT OR IGNORE INTO sync_channel_operations (channel_id, seq, id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        const findById = db.prepare(
          'SELECT id, entity_type, op, entity_id, timestamp, device_id, payload_json FROM sync_channel_operations WHERE channel_id = ? AND id = ?'
        )
        const txn = db.transaction((opsList: SyncOperation[]) => {
          let nextSeq = channelMaxSeqOrThrow(db, channelId)
          for (const op of opsList) {
            const incomingPayloadJson = op.payload ? JSON.stringify(op.payload) : null
            nextSeq += 1
            insert.run(
              channelId,
              nextSeq,
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
            // Uniqueness guard skipped the insert: the (channel,id) row
            // already exists. Identical content counts as accepted so a lost
            // push response can be replayed without stranding the outbox.
            nextSeq -= 1
            const existing = findById.get(channelId, op.id) as
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
            throw new Error('id collision for operation ' + String(op.id).slice(0, 80))
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
        const cursor = channelMaxSeqOrThrow(db, channelId)
        // Notify only after successful push commit; hint carries cursor only
        // and is scoped to this channel's subscribers.
        if (acceptedIds.length > 0) broadcastSyncHint(channelId, cursor)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ acceptedIds, cursor, channelId }))
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
      let caller: string
      try {
        caller = requireDeviceAuthOrThrow(db, req).deviceCode
      } catch (authErr) {
        const ae = authErr as { status?: number; error?: string }
        res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
        return
      }
      const pullDeviceId = url.searchParams.get('deviceId') ?? ''
      if (!isValidRelayDeviceId(pullDeviceId)) {
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
      let channel: string | null
      try {
        channel = getMembershipChannelOrThrow(db, caller)
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'store-unavailable' }))
        return
      }
      if (!channel) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'pairing-required' }))
        return
      }
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
      try {
        const rows = db
          .prepare(
            'SELECT seq, id, entity_type, op, entity_id, timestamp, device_id, payload_json FROM sync_channel_operations WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
          )
          .all(channel, cursor, limit) as any[]
        ops = rows.map((r) => ({
          seq: r.seq,
          id: r.id,
          entityType: r.entity_type,
          op: r.op,
          entityId: r.entity_id,
          timestamp: r.timestamp,
          deviceId: r.device_id,
          payload: r.payload_json ? JSON.parse(r.payload_json) : undefined
        }))
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'store-unavailable' }))
        return
      }
      // Cursor is last sequence actually returned, not global max — prevents skip on push or paging
      const returnedCursor = ops.length > 0 ? ops[ops.length - 1].seq : cursor
      // Enforce serialized payload limit for pull response
      let respStr: string
      try {
        respStr = JSON.stringify({ operations: ops, cursor: returnedCursor, channelId: channel })
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

    // ---- Device registration + channel pairing protocol (SYNC-CC-*) ----
    // First explicit Connect registers the device (stable public device
    // code + durable secret). Later attachment presents the secret; unknown
    // credentials fail closed and are never silently re-registered.
    if (req.method === 'POST' && url.pathname === '/sync/register') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawCode: unknown = (body as { deviceCode?: unknown })?.deviceCode
        const rawSecret: unknown = (body as { deviceSecret?: unknown })?.deviceSecret
        if (rawCode === undefined && rawSecret === undefined) {
          const rawClientId: unknown = (body as { deviceId?: unknown })?.deviceId
          if (rawClientId !== undefined && !isValidRelayDeviceId(rawClientId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'device id invalid' }))
            return
          }
          let code: string
          try {
            code = issueUniqueDeviceCodeOrThrow(db)
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'store-unavailable' }))
            return
          }
          const secret = generateDeviceAuth()
          try {
            db.prepare(
              'INSERT INTO sync_devices (device_code, secret_hash, client_device_id, created_at) VALUES (?, ?, ?, ?)'
            ).run(
              code,
              hashDeviceAuth(secret),
              typeof rawClientId === 'string' ? rawClientId : null,
              new Date().toISOString()
            )
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'store-unavailable' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ deviceCode: code, deviceSecret: secret }))
          return
        }
        if (!isValidDeviceCode(rawCode) || !isValidDeviceSecret(rawSecret)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid-credential' }))
          return
        }
        const code = normalizePairingCodeShared(rawCode)
        let ok = false
        let known = false
        try {
          ok = verifyDeviceSecretOrThrow(db, code, rawSecret)
          if (!ok) known = getDeviceSecretHashOrThrow(db, code) !== null
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (!ok) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: known ? 'invalid-credential' : 'unknown-credential' }))
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
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let caller: string
      try {
        caller = requireDeviceAuthOrThrow(db, req).deviceCode
      } catch (authErr) {
        const ae = authErr as { status?: number; error?: string }
        res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
        return
      }
      try {
        const channel = getMembershipChannelOrThrow(db, caller)
        const outgoingRow = getOutgoingPendingOrThrow(db, caller)
        const incomingRows = getIncomingPendingOrThrow(db, caller)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            deviceCode: caller,
            paired: channel !== null,
            channelId: channel,
            outgoing: outgoingRow
              ? { id: outgoingRow.id, targetCode: outgoingRow.target_code, createdAt: outgoingRow.created_at }
              : null,
            incoming: incomingRows.map((r) => ({
              id: r.id,
              requesterCode: r.requester_code,
              createdAt: r.created_at
            }))
          })
        )
        return
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'store-unavailable' }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/request') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let caller: string
      try {
        caller = requireDeviceAuthOrThrow(db, req).deviceCode
      } catch (authErr) {
        const ae = authErr as { status?: number; error?: string }
        res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawTarget: unknown = (body as { targetCode?: unknown })?.targetCode
        if (typeof rawTarget !== 'string' || validatePairingCodeShared(rawTarget)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'device-code-invalid' }))
          return
        }
        const target = normalizePairingCodeShared(rawTarget)
        if (target === caller) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'cannot-pair-with-self' }))
          return
        }
        let targetKnown = false
        let requesterChannel: string | null = null
        try {
          targetKnown = getDeviceSecretHashOrThrow(db, target) !== null
          requesterChannel = getMembershipChannelOrThrow(db, caller)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (!targetKnown) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown-device' }))
          return
        }
        if (requesterChannel !== null) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'pairing-already-paired' }))
          return
        }
        let existing: { id: string; target_code: string; created_at: string } | null
        try {
          existing = getOutgoingPendingOrThrow(db, caller)
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (existing && existing.target_code === target) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ requestId: existing.id, status: 'pending' }))
          return
        }
        try {
          const nowIso = new Date().toISOString()
          const id = randomUUID()
          // Single-outgoing-pending safety: the read/replace/insert runs in
          // one IMMEDIATE transaction and the partial unique index
          // `sync_pair_requests_single_pending` is the DB-level backstop, so
          // concurrent same-requester/different-target requests cannot leave
          // two pending rows. The replace of the observed row is CAS-guarded
          // (status='pending'); a concurrently settled row is left terminal
          // and the new pending insert still proceeds. A unique-constraint
          // loss (concurrent winner) surfaces as 409, never two pendings.
          const txn = db.transaction(() => {
            const current = db
              .prepare(
                "SELECT id, target_code, created_at FROM sync_pair_requests WHERE requester_code = ? AND status='pending' LIMIT 1"
              )
              .get(caller) as { id: string; target_code: string; created_at: string } | undefined
            if (current && current.target_code === target) return { idempotentId: current.id }
            if (current) {
              db.prepare("UPDATE sync_pair_requests SET status='replaced' WHERE id = ? AND status='pending'").run(
                current.id
              )
            }
            db.prepare(
              "INSERT INTO sync_pair_requests (id, requester_code, target_code, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
            ).run(id, caller, target, nowIso)
            return { idempotentId: null as string | null }
          })
          const out = txn() as { idempotentId: string | null }
          if (out.idempotentId) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ requestId: out.idempotentId, status: 'pending' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ requestId: id, status: 'pending' }))
          return
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (
            /UNIQUE constraint failed.*sync_pair_requests_single_pending|UNIQUE constraint failed.*sync_pair_requests/i.test(
              msg
            )
          ) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'concurrent-request' }))
            return
          }
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/cancel') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let caller: string
      try {
        caller = requireDeviceAuthOrThrow(db, req).deviceCode
      } catch (authErr) {
        const ae = authErr as { status?: number; error?: string }
        res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawId: unknown = (body as { requestId?: unknown })?.requestId
        let targetId: string | null = null
        try {
          if (typeof rawId === 'string' && rawId.length > 0) {
            targetId = rawId
          } else {
            const pending = getOutgoingPendingOrThrow(db, caller)
            targetId = pending?.id ?? null
          }
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (!targetId) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no-pending-request' }))
          return
        }
        // Atomic CAS terminal transition: only a pending row owned by the
        // caller moves to cancelled. An already accepted/cancelled/rejected/
        // replaced row affects 0 rows and surfaces as no-pending (410-style
        // terminal), never resurrecting or overwriting the terminal state.
        try {
          const info = db
            .prepare(
              "UPDATE sync_pair_requests SET status='cancelled' WHERE id = ? AND requester_code = ? AND status='pending'"
            )
            .run(targetId, caller)
          const changed = (info as unknown as { changes: number }).changes ?? 0
          if (changed === 0) {
            const term = db.prepare('SELECT status FROM sync_pair_requests WHERE id = ?').get(targetId) as
              | { status: string }
              | undefined
            if (term && term.status !== 'pending') {
              res.writeHead(410, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'request-' + term.status }))
              return
            }
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'no-pending-request' }))
            return
          }
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, requestId: targetId }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/accept') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let caller: string
      try {
        caller = requireDeviceAuthOrThrow(db, req).deviceCode
      } catch (authErr) {
        const ae = authErr as { status?: number; error?: string }
        res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawId: unknown = (body as { requestId?: unknown })?.requestId
        if (typeof rawId !== 'string' || rawId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request id invalid' }))
          return
        }
        let row: { id: string; requester_code: string; target_code: string; status: string } | undefined
        try {
          row = db
            .prepare('SELECT id, requester_code, target_code, status FROM sync_pair_requests WHERE id = ?')
            .get(rawId) as { id: string; requester_code: string; target_code: string; status: string } | undefined
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-not-found' }))
          return
        }
        if (row.target_code !== caller) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not-request-target' }))
          return
        }
        if (row.status !== 'pending') {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-' + row.status }))
          return
        }
        const requester = row.requester_code
        // Atomic membership rules (SYNC-CC-009) with CAS terminal guard: the
        // status flip (pending->accepted) and the membership writes commit in
        // one transaction. An already cancelled/rejected/replaced row affects
        // 0 rows and never creates membership; an accepted row is never
        // overwritten by a later terminal transition (cancel/reject/replace
        // all require status='pending').
        let resultChannel: string | null = null
        let latePaired = false
        let terminalStatus: string | null = null
        try {
          const txn = db.transaction(() => {
            const fresh = db
              .prepare('SELECT requester_code, target_code, status FROM sync_pair_requests WHERE id = ?')
              .get(rawId) as { requester_code: string; target_code: string; status: string } | undefined
            if (!fresh || fresh.target_code !== caller) {
              terminalStatus = fresh ? 'forbidden' : 'missing'
              return
            }
            if (fresh.status !== 'pending') {
              terminalStatus = fresh.status
              return
            }
            const requesterChannel = getMembershipChannelOrThrow(db, requester)
            if (requesterChannel !== null) {
              latePaired = true
              // Requester paired since the request: settle the pending row as
              // rejected-equivalent terminal without membership (no merge).
              // CAS keeps an already-settled row untouched.
              db.prepare("UPDATE sync_pair_requests SET status='rejected' WHERE id = ? AND status='pending'").run(rawId)
              return
            }
            const targetChannel = getMembershipChannelOrThrow(db, caller)
            if (targetChannel !== null) {
              db.prepare('INSERT INTO sync_memberships (device_code, channel_id, joined_at) VALUES (?, ?, ?)').run(
                requester,
                targetChannel,
                new Date().toISOString()
              )
              resultChannel = targetChannel
            } else {
              const channelId = randomUUID()
              db.prepare('INSERT INTO sync_channels (id, created_at, dissolved) VALUES (?, ?, 0)').run(
                channelId,
                new Date().toISOString()
              )
              const nowIso = new Date().toISOString()
              db.prepare('INSERT INTO sync_memberships (device_code, channel_id, joined_at) VALUES (?, ?, ?)').run(
                requester,
                channelId,
                nowIso
              )
              db.prepare('INSERT INTO sync_memberships (device_code, channel_id, joined_at) VALUES (?, ?, ?)').run(
                caller,
                channelId,
                nowIso
              )
              resultChannel = channelId
            }
            const info = db
              .prepare("UPDATE sync_pair_requests SET status='accepted' WHERE id = ? AND status='pending'")
              .run(rawId)
            const changed = (info as unknown as { changes: number }).changes ?? 0
            if (changed === 0) {
              throw new Error('terminal-race')
            }
            // Stale-intent cleanup in the same atomic transaction: both
            // devices are paired as of this commit, so any other pending
            // outgoing of either device (observed before this accept) must
            // never revive after a later unpair. The CAS guard keeps an
            // already-settled row untouched; the accepted row itself is
            // excluded. Terminal state is 'replaced' (pairing superseded the
            // intent), consistent with the request-replacement path.
            db.prepare(
              "UPDATE sync_pair_requests SET status='replaced' WHERE requester_code IN (?, ?) AND status='pending' AND id <> ?"
            ).run(requester, caller, rawId)
          })
          txn()
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg === 'terminal-race') {
            res.writeHead(410, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'request-terminal-race' }))
            return
          }
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (terminalStatus === 'missing') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-not-found' }))
          return
        }
        if (terminalStatus === 'forbidden') {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not-request-target' }))
          return
        }
        if (terminalStatus !== null) {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-' + terminalStatus }))
          return
        }
        if (latePaired || !resultChannel) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'requester-already-paired' }))
          return
        }
        // Membership changed atomically above: close stale subscribers of
        // both newly-paired devices that are still bound to a previous
        // channel so the old stream never receives that channel's hints
        // again. Streams already bound to the new channel are kept.
        try {
          const settledChannel: string = resultChannel
          for (const [client, bound] of [...sseClients]) {
            if (bound.channelId === settledChannel) continue
            if (bound.deviceCode !== requester && bound.deviceCode !== caller) continue
            sseClients.delete(client)
            try {
              client.end()
            } catch {}
          }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, channelId: resultChannel }))
        return
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (e as Error).message.slice(0, 500) }))
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/sync/pair/reject') {
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let caller: string
      try {
        caller = requireDeviceAuthOrThrow(db, req).deviceCode
      } catch (authErr) {
        const ae = authErr as { status?: number; error?: string }
        res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
        return
      }
      try {
        const body = await jsonBodyWithLimit(req, 64 * 1024)
        const rawId: unknown = (body as { requestId?: unknown })?.requestId
        if (typeof rawId !== 'string' || rawId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request id invalid' }))
          return
        }
        let row: { target_code: string; status: string } | undefined
        try {
          row = db.prepare('SELECT target_code, status FROM sync_pair_requests WHERE id = ?').get(rawId) as
            | { target_code: string; status: string }
            | undefined
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-not-found' }))
          return
        }
        if (row.target_code !== caller) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not-request-target' }))
          return
        }
        if (row.status !== 'pending') {
          res.writeHead(410, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'request-' + row.status }))
          return
        }
        // Atomic CAS: only pending moves to rejected; a concurrently
        // accepted/cancelled row affects 0 rows and keeps its terminal state.
        try {
          const info = db
            .prepare("UPDATE sync_pair_requests SET status='rejected' WHERE id = ? AND status='pending'")
            .run(rawId)
          const changed = (info as unknown as { changes: number }).changes ?? 0
          if (changed === 0) {
            const term = db.prepare('SELECT status FROM sync_pair_requests WHERE id = ?').get(rawId) as
              | { status: string }
              | undefined
            res.writeHead(410, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'request-' + (term?.status ?? 'unknown') }))
            return
          }
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
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
      if (tokenRequired && !checkAuth(req, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let caller: string
      try {
        caller = requireDeviceAuthOrThrow(db, req).deviceCode
      } catch (authErr) {
        const ae = authErr as { status?: number; error?: string }
        res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
        return
      }
      // Unpair removes only self membership (SYNC-CC-011). Service
      // registration and local chats are untouched (client-side contract).
      // Membership below two dissolves the channel; the survivor resolves
      // to unpaired on next observation. Zombie rows never block.
      try {
        let notPaired = false
        let unpairedChannel: string | null = null
        let dissolvedCodes: string[] = []
        try {
          const txn = db.transaction(() => {
            const channel = getMembershipChannelOrThrow(db, caller)
            if (!channel) {
              notPaired = true
              return
            }
            unpairedChannel = channel
            // Capture the full member set before mutation so the dissolve
            // path below can close every affected subscriber precisely.
            let members: string[] = []
            try {
              const memberRows = db
                .prepare('SELECT device_code as code FROM sync_memberships WHERE channel_id = ?')
                .all(channel) as Array<{ code: string }>
              members = memberRows.map((r) => r.code)
            } catch {
              members = []
            }
            db.prepare('DELETE FROM sync_memberships WHERE device_code = ?').run(caller)
            const remaining = db
              .prepare('SELECT COUNT(*) as n FROM sync_memberships WHERE channel_id = ?')
              .get(channel) as { n: number }
            if ((remaining?.n ?? 0) < 2) {
              db.prepare('DELETE FROM sync_memberships WHERE channel_id = ?').run(channel)
              db.prepare('UPDATE sync_channels SET dissolved = 1 WHERE id = ?').run(channel)
              dissolvedCodes = members
            }
          })
          txn()
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'store-unavailable' }))
          return
        }
        if (notPaired) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not-paired' }))
          return
        }
        // Membership changed atomically above: the caller always left its
        // channel, and on dissolve every former member left it. Close exactly
        // those stale subscribers so a departed stream never receives that
        // channel's hints again; survivors of a non-dissolved channel keep
        // their streams.
        try {
          const leftChannel: string | null = unpairedChannel
          if (leftChannel !== null) {
            const dissolved = new Set(dissolvedCodes)
            const departed = dissolved.size > 0 ? dissolved : new Set([caller])
            closeDissolvedChannelSubscribers(leftChannel, departed)
          }
        } catch {}
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
      // SSE requires paired membership (SYNC-CC-011/016): the subscription
      // binds to the caller's channel and receives only that channel's
      // cursor hints. Unpaired devices are refused with pairing-required.
      let caller: string
      try {
        caller = requireDeviceAuthOrThrow(db, req).deviceCode
      } catch (authErr) {
        const ae = authErr as { status?: number; error?: string }
        res.writeHead(ae.status === 500 ? 500 : 403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: ae.error ?? 'invalid-credential' }))
        return
      }
      let channel: string | null
      try {
        channel = getMembershipChannelOrThrow(db, caller)
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'store-unavailable' }))
        return
      }
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
      // Flush headers immediately so clients observe the stream pre-event.
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
    for (const client of [...sseClients.keys()]) {
      try {
        client.end()
      } catch {}
    }
    sseClients.clear()
  })
  ;(server as unknown as RelaySseIndex).__relaySseClients = sseClients
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
  const { port, dbPath, host, token, certPath, keyPath, allowUnspecifiedBind } = parsed
  if (typeof token !== 'string' || token.length === 0) {
    console.error('[sync-relay] missing --token (or SYNC_RELAY_TOKEN env); refusing unauthenticated startup')
    console.error(RELAY_HELP_TEXT)
    process.exit(2)
  }
  // TLS/cert material loads before the DB is opened: any missing, empty, or
  // mismatched configuration aborts startup without creating the DB.
  // Non-loopback hosts serve plain HTTP unless both --cert/--key are given
  // (native HTTPS). Never log secret or key material.
  let tls: RelayTlsConfig
  try {
    tls = resolveRelayTls(host, certPath, keyPath, { allowUnspecifiedBind })
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
        const clients = (server as unknown as RelaySseIndex).__relaySseClients
        if (clients) {
          for (const client of [...clients.keys()]) {
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
  // non-loopback hosts serve plain HTTP unless --cert/--key select HTTPS.
  // The container-internal 0.0.0.0/:: bind (Docker bridge) is never a
  // user-facing advertised endpoint: Docker controls host exposure via ports.
  server.listen(port, host, () => {
    // Report the actual bound port so `--port 0` (ephemeral) is observable.
    // Loopback keeps the stable 127.0.0.1 readiness form so bundled/test
    // harnesses match one contract; other explicit binds advertise the
    // actual scheme and bound host/port. The internal unspecified bind never
    // emits a URL-shaped wildcard; Docker controls host exposure via ports.
    const addr = server.address()
    const boundPort = typeof addr === 'object' && addr ? addr.port : port
    // Bounded readiness output — no sensitive path, token, or key material.
    // IPv6 literals serialize bracketed so explicit-host lines stay valid
    // URLs; the raw unbracketed host is used only for server.listen above.
    console.log(formatRelayReadiness(host, relayTls.scheme, boundPort))
  })
}
