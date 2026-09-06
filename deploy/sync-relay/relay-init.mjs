/**
 * Cherry Chat personal sync relay — Docker first-start initialization.
 *
 * Minimal deployment initializer for the Linux Docker Compose relay
 * deployment (see deploy/sync-relay/ and docs/multi-device-sync.md). It
 * prepares the persistent relay state, then the entrypoint `exec`s the
 * unchanged relay CLI (`scripts/sync-relay/server.ts`), which keeps its own
 * startup order (token/TLS validation before DB open/listen) and graceful
 * shutdown.
 *
 * The relay does NOT generate, manage, install, or rotate any CA, server
 * certificate, trust anchor, fingerprint, or TLS lifecycle artifact
 * (LOCK-001). The default Docker deployment serves plain HTTP on the
 * container-internal bind; HTTPS is only served when the operator supplies
 * their own certificate/key files (forwarded as paths, never generated).
 *
 * What this script does, in order:
 *   1. Set a restrictive umask (077) and validate platform (Linux unless
 *      RELAY_ALLOW_NON_LINUX=1), RELAY_NAME (1-128 chars), port, the data
 *      directory, the token-file location, the optional RELAY_PUBLIC_URL,
 *      and the optional user-supplied TLS passthrough files — all BEFORE any
 *      mutation (fail-closed). A legacy RELAY_LAN_IP variable is rejected
 *      explicitly so stale Compose files fail fast instead of being ignored.
 *   2. Create a cryptographically strong bearer token once (mode 0600,
 *      atomic temp + rename); reuse byte-identical on restart, fail closed
 *      on empty/corrupt file.
 *   3. Optionally write a small versioned public config artifact (mode 0644,
 *      atomic) when RELAY_PUBLIC_URL is supplied. It carries only endpoint
 *      metadata supplied by the operator (public URL, relay name, versions)
 *      — never any token, certificate, or private key. Without
 *      RELAY_PUBLIC_URL no config artifact is written and users enter the
 *      server endpoint manually. An existing config is strictly validated
 *      first (exact keys, types, issuedAt, public-URL consistency, no
 *      secrets); invalid artifacts fail closed without a rewrite. An
 *      existing valid config with identical semantic content is left
 *      byte-identical (issuedAt preserved).
 *   4. Ensure the relay DB path exists (empty placeholder when absent,
 *      mode 0600 atomic; existing DB/WAL/SHM/journal constrained to 0600;
 *      the relay CLI owns schema creation). Never delete existing state.
 *      Host bind-mount ownership/permissions still matter.
 *   5. Log only safe values: token-file path, DB path, config path (when
 *      written), public URL (when supplied), TLS passthrough paths (when
 *      supplied), and first-start/reuse status with instructions to fetch
 *      the token. Never log the token.
 *
 * No network access, no `eval`, no shell interpolation, no OpenSSL
 * dependency: all filesystem work uses stdlib calls. Importing this module
 * has no side effects; `main()` runs only when executed directly, so Vitest
 * can import the pure helpers.
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELAY_CONFIG_SCHEMA_VERSION = 2
export const RELAY_INIT_VERSION = 2
export const TOKEN_BYTES = 32
export const MIN_TOKEN_LENGTH = 20

export const FILE_TOKEN = 'relay-token'
export const FILE_CONFIG = 'relay-config.cherry'
export const FILE_DB = 'relay.db'

export const RELAY_NAME_MAX_LENGTH = 128
export const ALLOWED_CONFIG_KEYS = ['schemaVersion', 'relayInitVersion', 'relayName', 'publicUrl', 'issuedAt']
// RFC3339 date-time shape compatible with `format: date-time` in the
// versioned public-config schema; `Date.parse` alone accepts date-only
// values and normalizes impossible calendar dates (for example Feb 30
// becomes Mar 02), so validity is decided by deterministic component
// ranges below — never by `Date` normalization.
const ISSUED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/

/**
 * True for valid RFC3339 date-times with real calendar validity.
 *
 * Accepts a timezone (`Z` or `±HH:MM`) and optional fractional seconds.
 * Month/day/hour/minute/second/offset ranges plus month length (including
 * leap-year February) are checked from the captured components without any
 * `Date` normalization, so impossible dates such as Feb 30 fail.
 */
export function isValidIssuedAt(value) {
  if (typeof value !== 'string') return false
  const m = ISSUED_AT_RE.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6])
  if (month < 1 || month > 12) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (day < 1 || day > daysInMonth) return false
  if (m[8] !== 'Z') {
    const offsetHour = Number(m[9])
    const offsetMinute = Number(m[10])
    if (offsetHour > 23 || offsetMinute > 59) return false
  }
  return true
}

/** Validate the relay TCP port (1-65535). */
export function validatePort(raw) {
  const n = Number(String(raw ?? '').trim())
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid RELAY_PORT '${String(raw ?? '').slice(0, 32)}' (expected 1-65535)`)
  }
  return n
}

/** Validate the relay display name (1..128 chars, enforced before write). */
export function validateRelayName(raw) {
  const v = String(raw ?? '').trim()
  if (v.length === 0 || v.length > RELAY_NAME_MAX_LENGTH) {
    throw new Error(`invalid RELAY_NAME (expected 1-${RELAY_NAME_MAX_LENGTH} characters)`)
  }
  return v
}

/**
 * Resolve the token-file location. Blank/whitespace (the default Compose
 * `${RELAY_TOKEN_FILE:-}` expansion) is treated as unset and resolves to
 * `<dataDir>/relay-token`; otherwise the trimmed explicit path is resolved.
 */
export function resolveTokenFilePath(raw, dataDir) {
  const v = String(raw ?? '').trim()
  if (v.length === 0) return join(dataDir, FILE_TOKEN)
  return resolve(v)
}

/**
 * True for wildcard/all-interface hosts that must never be advertised as a
 * public URL. Covers `0.0.0.0`, `::` (bracketed or not), `*`, all-zero IPv6
 * expansions, and IPv4-mapped/compatible unspecified forms.
 */
export function isWildcardPublicHostname(hostname) {
  let n = String(hostname ?? '')
    .trim()
    .toLowerCase()
  if (n.startsWith('[') && n.endsWith(']')) n = n.slice(1, -1)
  const pct = n.indexOf('%')
  if (pct !== -1) n = n.slice(0, pct)
  if (n === '*' || n === '0.0.0.0' || n === '::') return true
  if (n.includes(':')) {
    // All-zero IPv6 literal (any compressed/expanded form).
    const stripped = n.replace(/[:0.]/g, '')
    if (stripped === '') return true
    // IPv4-mapped unspecified ::ffff:0.0.0.0 in common textual forms.
    if (n.includes('ffff')) {
      const tailZero = n.endsWith(':0.0.0.0') || n.endsWith(':0:0') || n.endsWith(':0000:0000') || n.endsWith(':0:0000')
      const headZero =
        n.startsWith('::ffff:') ||
        n.startsWith('0:0:0:0:0:ffff:') ||
        n.startsWith('0::ffff:') ||
        n.startsWith('[::ffff:')
      if (tailZero && headZero) return true
      if ((n === '::ffff:0.0.0.0' || n === '::ffff:0:0') && isIP(n.replace(/^\[/, '').replace(/\]$/, '')) !== 0)
        return true
    }
    if (n === '::0.0.0.0') return true
  }
  return false
}

/**
 * Validate the optional operator-supplied public URL. Returns the trimmed
 * value with a canonical lowercase scheme, or null when unset/blank (no
 * config artifact is written then).
 * Only valid `http://`/`https://` URLs up to 2048 chars are accepted;
 * anything else fails closed before any mutation. The URL must carry an
 * explicit `http://`/`https://` authority prefix with a non-empty hostname,
 * must not embed username/password credentials (the public artifact is mode
 * 0644), and must not be a wildcard/unspecified host. Scheme comparison is
 * case-insensitive per RFC 3986; only the scheme is lowercased before
 * return so the persisted artifact carries one canonical representation
 * while host/path/query semantics are preserved.
 */
export function validatePublicUrl(raw) {
  const v = String(raw ?? '').trim()
  if (v.length === 0) return null
  if (v.length > 2048) {
    throw new Error('invalid RELAY_PUBLIC_URL (endpoint too long)')
  }
  const prefix = /^https?:\/\//i.exec(v)
  if (!prefix) {
    throw new Error('invalid RELAY_PUBLIC_URL (expected an http:// or https:// URL)')
  }
  const after = v.slice(prefix[0].length)
  if (!after || after.startsWith('/') || after.startsWith('?') || after.startsWith('#')) {
    throw new Error('invalid RELAY_PUBLIC_URL (expected an http:// or https:// URL)')
  }
  let parsed
  try {
    parsed = new URL(v)
  } catch {
    throw new Error('invalid RELAY_PUBLIC_URL (expected a valid URL)')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('invalid RELAY_PUBLIC_URL (expected an http:// or https:// URL)')
  }
  if (!parsed.hostname) {
    throw new Error('invalid RELAY_PUBLIC_URL (expected a valid URL)')
  }
  if (parsed.username || parsed.password) {
    throw new Error('invalid RELAY_PUBLIC_URL (credentials must not be embedded in the public URL)')
  }
  if (isWildcardPublicHostname(parsed.hostname)) {
    throw new Error('invalid RELAY_PUBLIC_URL (wildcard hosts are not advertised; use an explicit address)')
  }
  return v.replace(/^https?:\/\//i, (m) => m.toLowerCase())
}

/**
 * Validate the optional user-supplied TLS passthrough pair. Both files must
 * be provided together or not at all; when provided they must exist and be
 * non-empty. The relay only forwards these mounted paths to the relay CLI —
 * it never generates, validates trust for, or manages them.
 */
export function validateTlsPassthrough(certRaw, keyRaw) {
  const cert = String(certRaw ?? '').trim()
  const key = String(keyRaw ?? '').trim()
  if (cert.length === 0 && key.length === 0) return null
  if (cert.length === 0 || key.length === 0) {
    throw new Error(
      'invalid TLS passthrough (RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE must be set together or not at all)'
    )
  }
  for (const [label, path] of [
    ['RELAY_TLS_CERT_FILE', cert],
    ['RELAY_TLS_KEY_FILE', key]
  ]) {
    let content
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      throw new Error(`invalid ${label} (cannot read file at ${String(path).slice(0, 200)})`)
    }
    if (content.trim().length === 0) {
      throw new Error(`invalid ${label} (file is empty at ${String(path).slice(0, 200)})`)
    }
  }
  return { certFile: cert, keyFile: key }
}

function readTextFile(path, label) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error(`${label} is unreadable (expected file at ${path})`)
  }
}

function fsyncFile(path) {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Best effort: filesystems that reject fsync must not fail init.
  } finally {
    try {
      if (fd !== -1) closeSync(fd)
    } catch {}
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path)
  } catch {}
}

/**
 * Atomically write `content` to `path` (temp file in the same directory +
 * rename) with `mode`. Same-directory temp keeps the rename atomic on one
 * filesystem; the temp name is unique per process to avoid collisions. The
 * temp is created with the target mode up front (no world-readable window),
 * fsynced before rename, and removed on failure.
 */
export function writeFileAtomic(path, content, mode) {
  const dir = resolve(path, '..')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, content, { mode })
    chmodSync(tmp, mode)
    fsyncFile(tmp)
    renameSync(tmp, path)
    fsyncFile(path)
  } catch (e) {
    removeQuietly(tmp)
    throw e
  }
}

/** Fail-closed token handling: reuse a valid stored token, else create once. */
export function ensureToken(tokenPath) {
  if (existsSync(tokenPath)) {
    const current = readTextFile(tokenPath, 'token file').trim()
    if (current.length < MIN_TOKEN_LENGTH) {
      throw new Error('token file is corrupt (empty or too short); refusing to overwrite it automatically')
    }
    return { token: current, created: false }
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  writeFileAtomic(tokenPath, `${token}\n`, 0o600)
  return { token, created: true }
}

/**
 * Build the public relay config artifact (JSON-serializable). Contains only
 * operator-supplied endpoint metadata — relay name, public URL, and
 * schema/init version metadata — never any token, certificate, or key.
 */
export function buildPublicConfig({ relayName, publicUrl, issuedAt }) {
  return {
    schemaVersion: RELAY_CONFIG_SCHEMA_VERSION,
    relayInitVersion: RELAY_INIT_VERSION,
    relayName,
    publicUrl,
    issuedAt
  }
}

/**
 * Strict validation of the public config shape shared by the schema and the
 * init reuse path. Throws fail-closed on any deviation: unknown/secret keys,
 * missing fields, inexact primitive types (no coercion), bad issuedAt
 * (RFC3339 date-time with real calendar validity), or a public URL that is
 * not a valid http/https URL. Never writes.
 */
export function validatePublicConfigShape(existing, expectedPublicUrl) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('public config is corrupt (expected a JSON object); refusing to overwrite it automatically')
  }
  const record = existing
  const keys = Object.keys(record)
  for (const key of keys) {
    if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      const lower = key.toLowerCase()
      if (
        lower.includes('token') ||
        lower.includes('privatekey') ||
        lower.includes('private_key') ||
        lower.includes('secret') ||
        lower.includes('cert') ||
        lower.includes('fingerprint') ||
        lower.includes('ca')
      ) {
        throw new Error(
          `public config is invalid (forbidden secret property '${key.slice(0, 64)}'); refusing to overwrite it automatically`
        )
      }
      throw new Error(
        `public config is invalid (unknown property '${key.slice(0, 64)}'); refusing to overwrite it automatically`
      )
    }
  }
  for (const key of ALLOWED_CONFIG_KEYS) {
    if (!(key in record)) {
      throw new Error(
        `public config is invalid (missing required field '${key}'); refusing to overwrite it automatically`
      )
    }
  }
  if (record.schemaVersion !== RELAY_CONFIG_SCHEMA_VERSION) {
    throw new Error('public config is invalid (unsupported schemaVersion); refusing to overwrite it automatically')
  }
  if (record.relayInitVersion !== RELAY_INIT_VERSION) {
    throw new Error('public config is invalid (unsupported relayInitVersion); refusing to overwrite it automatically')
  }
  // Exact primitive types: JSON fields must already carry the schema
  // types — no numeric/boolean/object coercion via String()/Number().
  for (const stringField of ['relayName', 'publicUrl', 'issuedAt']) {
    if (typeof record[stringField] !== 'string') {
      throw new Error(
        `public config is invalid (${stringField} must be a string); refusing to overwrite it automatically`
      )
    }
  }
  if (typeof record.schemaVersion !== 'number' || typeof record.relayInitVersion !== 'number') {
    throw new Error('public config is invalid (version fields must be numbers); refusing to overwrite it automatically')
  }
  validateRelayName(record.relayName)
  const publicUrl = validatePublicUrl(record.publicUrl)
  if (publicUrl === null) {
    throw new Error(
      'public config is invalid (publicUrl must be a valid http(s) URL); refusing to overwrite it automatically'
    )
  }
  if (typeof expectedPublicUrl === 'string' && publicUrl !== validatePublicUrl(expectedPublicUrl)) {
    throw new Error(
      'public config mismatch (publicUrl does not match RELAY_PUBLIC_URL); refusing to overwrite it automatically'
    )
  }
  const issuedAt = record.issuedAt
  if (!isValidIssuedAt(issuedAt)) {
    throw new Error(
      'public config is invalid (issuedAt is not a valid date-time); refusing to overwrite it automatically'
    )
  }
  return record
}

/**
 * Write `relay-config.cherry` atomically. Only called when RELAY_PUBLIC_URL
 * is supplied; without it no config artifact exists. An existing config is
 * fully validated before reuse: unknown/secret keys, bad types, invalid
 * issuedAt, or public-URL mismatch all fail closed without rewriting the
 * invalid artifact. When an existing valid config carries identical semantic
 * content (public URL, relay name, versions), it is left byte-identical
 * (existing issuedAt preserved).
 */
export function ensurePublicConfig(configPath, fields) {
  const relayName = validateRelayName(fields.relayName)
  const publicUrl = validatePublicUrl(fields.publicUrl)
  if (publicUrl === null) {
    throw new Error('public config requires RELAY_PUBLIC_URL (omit the config artifact when no public URL is set)')
  }
  const normalizedFields = { relayName, publicUrl }
  const issuedNow = new Date().toISOString()
  if (existsSync(configPath)) {
    let existing
    try {
      existing = JSON.parse(readTextFile(configPath, 'public config'))
    } catch {
      throw new Error('public config is corrupt (not valid JSON); refusing to overwrite it automatically')
    }
    validatePublicConfigShape(existing, normalizedFields.publicUrl)
    const next = buildPublicConfig({ ...normalizedFields, issuedAt: existing.issuedAt ?? issuedNow })
    const comparable = (c) => ({
      schemaVersion: c.schemaVersion,
      relayInitVersion: c.relayInitVersion,
      relayName: c.relayName,
      publicUrl: c.publicUrl
    })
    if (JSON.stringify(comparable(existing)) === JSON.stringify(comparable(next))) {
      return { created: false, reused: true }
    }
    const rewritten = buildPublicConfig({ ...normalizedFields, issuedAt: issuedNow })
    validatePublicConfigShape(rewritten, normalizedFields.publicUrl)
    writeFileAtomic(configPath, `${JSON.stringify(rewritten, null, 2)}\n`, 0o644)
    return { created: false, reused: false }
  }
  const created = buildPublicConfig({ ...normalizedFields, issuedAt: issuedNow })
  validatePublicConfigShape(created, normalizedFields.publicUrl)
  writeFileAtomic(configPath, `${JSON.stringify(created, null, 2)}\n`, 0o644)
  return { created: true, reused: false }
}

function modeOf(path) {
  return statSync(path).mode & 0o777
}

/**
 * Run first-start initialization (or reuse validation) from environment.
 * Returns safe summary lines for logging. Throws fail-closed on any problem.
 * Reads: RELAY_PORT (default 3030), RELAY_DATA_DIR (default /data),
 * RELAY_NAME (default cherry-relay), RELAY_TOKEN_FILE (default
 * <dataDir>/relay-token), RELAY_PUBLIC_URL (optional; when unset no public
 * config artifact is written), RELAY_TLS_CERT_FILE/RELAY_TLS_KEY_FILE
 * (optional user-supplied passthrough pair, forwarded only),
 * RELAY_ALLOW_NON_LINUX. A legacy RELAY_LAN_IP variable is rejected so
 * stale Compose files fail fast.
 */
export function initFromEnv(env = process.env) {
  // Restrictive creation mask first: DB WAL/SHM sidecars and any new files
  // default to owner-only. The public config (when written) is explicitly
  // chmodded to 0644 afterwards; secrets stay 0600. Host bind-mount
  // ownership/permissions still matter and are not overridden here.
  try {
    process.umask(0o077)
  } catch {}
  if (process.platform !== 'linux' && env.RELAY_ALLOW_NON_LINUX !== '1') {
    throw new Error(
      `unsupported platform '${process.platform}' (this deployment targets Linux; set RELAY_ALLOW_NON_LINUX=1 only for local contract tests)`
    )
  }
  if (env.RELAY_LAN_IP !== undefined && String(env.RELAY_LAN_IP).trim().length > 0) {
    throw new Error(
      'RELAY_LAN_IP is no longer supported (the relay uses standard Docker bridge networking with ports:; remove RELAY_LAN_IP from your Compose file)'
    )
  }
  const port = validatePort(env.RELAY_PORT ?? '3030')
  const dataDir = resolve(String(env.RELAY_DATA_DIR ?? '/data'))
  const relayName = validateRelayName(env.RELAY_NAME ?? 'cherry-relay')
  const publicUrl = validatePublicUrl(env.RELAY_PUBLIC_URL ?? '')
  const tls = validateTlsPassthrough(env.RELAY_TLS_CERT_FILE, env.RELAY_TLS_KEY_FILE)
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    throw new Error(`data directory is not creatable (expected a writable directory at ${dataDir})`)
  }
  let dirStat
  try {
    dirStat = statSync(dataDir)
  } catch {
    throw new Error(`data directory is unreadable (expected a directory at ${dataDir})`)
  }
  if (!dirStat.isDirectory()) throw new Error(`data path is not a directory (${dataDir})`)

  const tokenPath = resolveTokenFilePath(env.RELAY_TOKEN_FILE, dataDir)
  const configPath = join(dataDir, FILE_CONFIG)
  const dbPath = join(dataDir, FILE_DB)

  const token = ensureToken(tokenPath)
  chmodSync(tokenPath, 0o600)

  let config = null
  if (publicUrl !== null) {
    config = ensurePublicConfig(configPath, { relayName, publicUrl })
    chmodSync(configPath, 0o644)
  }

  let dbCreated = false
  if (!existsSync(dbPath)) {
    writeFileAtomic(dbPath, '', 0o600)
    dbCreated = true
  } else {
    try {
      chmodSync(dbPath, 0o600)
    } catch {}
  }
  // Constrain SQLite sidecars when present; the relay CLI creates WAL/SHM
  // after init, and the entrypoint umask (077) keeps new sidecars
  // owner-only.
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    if (existsSync(sidecar)) {
      try {
        chmodSync(sidecar, 0o600)
      } catch {}
    }
  }

  const firstStart = token.created || (config?.created ?? false) || dbCreated
  const fileModes = { token: modeOf(tokenPath).toString(8), db: modeOf(dbPath).toString(8) }
  if (config !== null) fileModes.config = modeOf(configPath).toString(8)
  return {
    port,
    dataDir,
    tokenPath,
    configPath: config !== null ? configPath : null,
    dbPath,
    publicUrl,
    tls,
    firstStart,
    status: {
      token: token.created ? 'created' : 'reused',
      config:
        config === null ? 'skipped' : config.created ? 'created' : config.reused ? 'reused-identical' : 'rewritten',
      db: dbCreated ? 'created' : 'reused',
      tls: tls === null ? 'none' : 'passthrough'
    },
    fileModes
  }
}

function printSafeSummary(result) {
  const lines = [
    `[relay-init] port: ${result.port} (container-internal bind 0.0.0.0; host exposure via Docker ports:)`,
    `[relay-init] token file: ${result.tokenPath} (mode 600; retrieve with: cat ${result.tokenPath})`,
    `[relay-init] db file: ${result.dbPath}`,
    result.configPath !== null
      ? `[relay-init] config file: ${result.configPath}`
      : '[relay-init] config file: none (no RELAY_PUBLIC_URL; enter the server endpoint manually)',
    result.publicUrl !== null ? `[relay-init] public URL: ${result.publicUrl}` : '[relay-init] public URL: none',
    result.tls !== null
      ? `[relay-init] TLS: user-supplied passthrough cert=${result.tls.certFile} key=${result.tls.keyFile} (no relay-owned certificates)`
      : '[relay-init] TLS: none (plain HTTP; the relay generates no certificates)',
    `[relay-init] status: ${result.firstStart ? 'first-start' : 'reuse'} ` +
      `(token=${result.status.token} config=${result.status.config} db=${result.status.db} tls=${result.status.tls})`
  ]
  for (const line of lines) console.log(line)
}

const executedDirectly =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (executedDirectly) {
  try {
    const result = initFromEnv(process.env)
    printSafeSummary(result)
  } catch (e) {
    console.error(`[relay-init] ${e instanceof Error ? e.message : String(e)}`.slice(0, 500))
    process.exit(1)
  }
}
